import { originDrawnBy, VbCellArea, VbCharacterSpan, VbPixelSource } from '../../common/vb-pixel-origin';
import { VesScreenRect } from '../panels/emulator-screen-panel';
import { ancestryOf, isSubclassOf } from './emulator-classes';
import { readStructFields, VesFieldValue, VesStruct } from './emulator-dwarf';
import {
    BLOCK_HEADER_BYTES,
    parseMemoryPoolLayout,
    readMemoryPoolBlocks,
    symbolsMatchRunningBuild,
    VesMemoryPoolBlock,
    VesMemoryPoolLayout,
} from './emulator-memory-pool';
import { findSymbolAt, structNameOf, SymbolIndex } from './emulator-symbols';
import { Sim } from './vb-core';

// the engine keeps no list of actors, so they are found as occupied pool blocks whose class (by vTable pointer)
// descends from `Actor` along the `getBaseClass` stub chain, which finds project classes like the engine's own. Shared
// by the Actors panel and the screen inspector

const ACTOR_CLASS = 'Actor';

// DWARF paths of the fields that get columns of their own
const NAME_FIELD = 'name';
const ID_FIELD = 'internalId';
const POSITION_FIELDS = ['transformation.position.x', 'transformation.position.y', 'transformation.position.z'];
const HIDDEN_FIELD = 'hidden';
const SPEC_FIELD = 'actorSpec';
const PARENT_FIELD = 'parent'; // the stage, or the actor this one was spawned as a child of

const COMPONENT_CLASS = 'Component';
const SPRITE_CLASS = 'Sprite';
const BGMAP_SPRITE_CLASS = 'BgmapSprite';
const OBJECT_SPRITE_CLASS = 'ObjectSprite';
const OWNER_FIELD = 'owner';
const TILE_SET_CLASSES = ['TileSet', 'CharSet']; // older engine versions call it CharSet
const CHARACTERS = 2048; // the end of the last set: the VIP's own, without VB Color's

// `BgmapSprite::doRender` builds its world from exactly these (`gx = position.x + displacement.x - halfWidth`,
// width `halfWidth << 1`), so reading them back gives the rectangle the engine drew, with no projection to redo
const SPRITE_RECT_FIELDS = {
    x: 'position.x',
    y: 'position.y',
    parallax: 'position.parallax',
    displacementX: 'displacement.x',
    displacementY: 'displacement.y',
    displacementParallax: 'displacement.parallax',
    halfWidth: 'halfWidth',
    halfHeight: 'halfHeight',
};

export enum VesActorsStatus {
    OK = 'ok',
    NO_SYMBOLS = 'noSymbols',
    NO_LAYOUTS = 'noLayouts',
    NOT_INITIALIZED = 'notInitialized',
    STALE_SYMBOLS = 'staleSymbols',
}

export interface VesActorComponent {
    address: number;
    className: string;
    // rect, shown and index are for sprites only
    rect?: VesScreenRect;
    shown?: boolean;
    index?: number; // the DRAM block it configures, -1 when unassigned
    worlds: number[];
    objects: number[];
    // pixels are matched by cells and characters, as unlike worlds or objects they stay the sprite's own from one
    // frame to the next
    cells?: VbCellArea;
    characters?: VbCharacterSpan;
}

export interface VesActor {
    objectAddress: number;
    blockAddress: number;
    blockSize: number;
    className: string;
    readAs: string; // a base class when the build has no layout for the exact one
    ancestry: string[];
    components: VesActorComponent[];
    fields: VesFieldValue[];
    namePointer?: number;
    spec?: string;
    specOffset?: number; // where in that spec the pointer landed, normally 0
    specAddress?: number;
    internalId?: number;
    hidden?: boolean;
    position: (number | undefined)[];
    parent: number; // 0 for none
}

export interface VesActorsRead {
    status: VesActorsStatus;
    actors: VesActor[];
    classes: Map<number, string>; // by address, also names a parent that is no actor (the stage)
}

// `_PlayerRacerActorSpec` becomes `PlayerRacer`. A name that is nothing but the suffix keeps it, as an empty column
// says less than an ugly one
export function specDisplayName(symbol: string): string {
    const trimmed = symbol.replace(/^_/, '');
    const shortened = trimmed.replace(/ActorSpec$/, '').replace(/Spec$/, '');
    return shortened === '' ? trimmed : shortened;
}

export async function readActors(sim: Sim, symbols: SymbolIndex | undefined): Promise<VesActorsRead> {
    const none = (status: VesActorsStatus): VesActorsRead => ({ status, actors: [], classes: new Map() });
    if (!symbols?.memoryPool) {
        return none(VesActorsStatus.NO_SYMBOLS);
    }
    if (symbols.structs.size === 0) {
        // without debug sections there are no field offsets, and an actor is only an address
        return none(VesActorsStatus.NO_LAYOUTS);
    }

    const region = new Uint8Array(await sim.readMemory(symbols.memoryPool.address, symbols.memoryPool.size));
    const layout = parseMemoryPoolLayout(symbols.memoryPool.address, region);
    if (!layout) {
        return none(VesActorsStatus.NOT_INITIALIZED);
    }
    if (!symbolsMatchRunningBuild(layout, symbols.vTables)) {
        // everything here rests on the symbols describing the ROM in the machine; from another build all would be wrong
        return none(VesActorsStatus.STALE_SYMBOLS);
    }

    const blocks = readMemoryPoolBlocks(layout, region);
    const classes = new Map<number, string>();
    for (const block of blocks) {
        const className = symbols.vTables.get(block.vTable);
        if (className !== undefined) {
            classes.set(block.objectAddress, className);
        }
    }
    const context: ReadContext = { symbols, region, layout, classes, tileSets: [] };
    context.tileSets = tileSetOffsets(context, blocks);
    const actors = collect(context, blocks);
    markShared(actors);
    return { status: VesActorsStatus.OK, actors, classes };
}

interface ReadContext {
    symbols: SymbolIndex;
    region: Uint8Array;
    layout: VesMemoryPoolLayout;
    classes: Map<number, string>;
    tileSets: number[]; // see tileSetOffsets
}

function readObject(context: ReadContext, address: number | undefined): VesFieldValue[] | undefined {
    if (address === undefined || address === 0) {
        return undefined;
    }
    const className = context.classes.get(address >>> 0);
    const block = blockSizeAt(context.layout, address >>> 0);
    if (className === undefined || block === undefined) {
        return undefined;
    }
    const struct = layoutFor(context.symbols, className, block - BLOCK_HEADER_BYTES);
    return struct && readStructFields(struct, context.region, (address >>> 0) - context.layout.base);
}

function fieldOf(fields: VesFieldValue[] | undefined, path: string): number | undefined {
    return fields?.find(field => field.path === path)?.value;
}

// where every character set starts, in order. The engine packs character memory in one run as sets come and go, so a
// set ends where the next begins, whatever its ROM spec says
function tileSetOffsets(context: ReadContext, blocks: VesMemoryPoolBlock[]): number[] {
    const offsets = new Set<number>();
    for (const block of blocks) {
        const className = context.classes.get(block.objectAddress);
        if (className === undefined
            || !TILE_SET_CLASSES.some(base => isSubclassOf(context.symbols.classes, className, base))) {
            continue;
        }
        const offset = fieldOf(readObject(context, block.objectAddress), 'offset');
        if (offset !== undefined) {
            offsets.add(offset);
        }
    }
    return [...offsets].sort((a, b) => a - b);
}

// cells and characters several actors draw from (a level's coins sharing one set) get the sprite's rect, which then
// tells their pixels apart
function markShared(actors: VesActor[]): void {
    const owners = (key: string, actor: VesActor, counts: Map<string, Set<VesActor>>): void => {
        counts.set(key, (counts.get(key) ?? new Set()).add(actor));
    };
    const cells = new Map<string, Set<VesActor>>();
    const characters = new Map<string, Set<VesActor>>();
    const cellKey = (area: VbCellArea): string => `${area.segment}:${area.x}:${area.y}`;
    const characterKey = (span: VbCharacterSpan): string => `${span.from}`;
    for (const actor of actors) {
        for (const component of actor.components) {
            if (component.cells) {
                owners(cellKey(component.cells), actor, cells);
            }
            if (component.characters) {
                owners(characterKey(component.characters), actor, characters);
            }
        }
    }
    for (const actor of actors) {
        for (const component of actor.components) {
            if (component.cells && (cells.get(cellKey(component.cells))?.size ?? 0) > 1) {
                component.cells.near = component.rect;
            }
            if (component.characters && (characters.get(characterKey(component.characters))?.size ?? 0) > 1) {
                component.characters.near = component.rect;
            }
        }
    }
}

function collect(context: ReadContext, blocks: VesMemoryPoolBlock[]): VesActor[] {
    const { symbols, region } = context;
    const components = groupComponents(context, blocks);
    const actors: VesActor[] = [];
    for (const block of blocks) {
        const className = symbols.vTables.get(block.vTable);
        if (className === undefined || !isSubclassOf(symbols.classes, className, ACTOR_CLASS)) {
            continue;
        }

        // the engine allocated a block big enough for the real class, so a layout that does not fit cannot be right
        const struct = layoutFor(symbols, className, block.blockSize - BLOCK_HEADER_BYTES, ACTOR_CLASS);
        if (!struct) {
            continue;
        }
        const fields = readStructFields(struct, region, block.objectOffset);
        const valueOf = (path: string): number | undefined =>
            fields.find(entry => entry.path === path)?.value;

        actors.push({
            objectAddress: block.objectAddress,
            blockAddress: block.address,
            blockSize: block.blockSize,
            className,
            readAs: struct.name.replace(/_str$/, ''),
            ancestry: ancestryOf(symbols.classes, className),
            components: components.get(block.objectAddress) ?? [],
            fields,
            namePointer: valueOf(NAME_FIELD),
            ...specOf(symbols, valueOf(SPEC_FIELD)),
            internalId: valueOf(ID_FIELD),
            hidden: valueOf(HIDDEN_FIELD) !== 0,
            position: POSITION_FIELDS.map(valueOf),
            parent: (valueOf(PARENT_FIELD) ?? 0) >>> 0,
        });
    }
    return actors;
}

function memberOffset(struct: VesStruct, name: string): number | undefined {
    return struct.members.find(member => member.name === name)?.offset;
}

function blockSizeAt(layout: VesMemoryPoolLayout, address: number): number | undefined {
    for (const pool of layout.pools) {
        if (address >= pool.address && address < pool.address + pool.poolSize) {
            return pool.blockSize;
        }
    }
    return undefined;
}

// grouped by each component's `owner`, not via `Entity::components`: that array is a cache filled when the game first
// asks for a type, so mostly NULL
function groupComponents(context: ReadContext, blocks: VesMemoryPoolBlock[]): Map<number, VesActorComponent[]> {
    const { symbols, region } = context;
    const grouped = new Map<number, VesActorComponent[]>();
    const component = symbols.structs.get(structNameOf(COMPONENT_CLASS));
    const ownerAt = component && memberOffset(component, OWNER_FIELD);
    if (ownerAt === undefined) {
        return grouped;
    }
    const view = new DataView(region.buffer, region.byteOffset, region.byteLength);

    for (const block of blocks) {
        const className = symbols.vTables.get(block.vTable);
        if (className === undefined || !isSubclassOf(symbols.classes, className, COMPONENT_CLASS)) {
            continue;
        }
        const at = block.objectOffset + ownerAt;
        if (at < 0 || at + 4 > region.byteLength) {
            continue;
        }
        // inherited fields sit at the same offset in every subclass, so one lookup on Component reads any owner
        const owner = view.getUint32(at, true) >>> 0;
        if (owner === 0) {
            continue;
        }
        const entries = grouped.get(owner) ?? [];
        entries.push(readComponent(context, block.objectAddress, className));
        grouped.set(owner, entries);
    }
    return grouped;
}

function readComponent(context: ReadContext, address: number, className: string): VesActorComponent {
    const { symbols, region, layout } = context;
    const entry: VesActorComponent = { address, className, worlds: [], objects: [] };
    if (!isSubclassOf(symbols.classes, className, SPRITE_CLASS)) {
        return entry;
    }

    const block = blockSizeAt(layout, address);
    const struct = block === undefined
        ? undefined
        : layoutFor(symbols, className, block - BLOCK_HEADER_BYTES, SPRITE_CLASS);
    if (!struct) {
        return entry;
    }

    const fields = readStructFields(struct, region, address - layout.base);
    const valueOf = (path: string): number | undefined => fields.find(f => f.path === path)?.value;
    const halfWidth = valueOf(SPRITE_RECT_FIELDS.halfWidth) ?? 0;
    const halfHeight = valueOf(SPRITE_RECT_FIELDS.halfHeight) ?? 0;

    entry.shown = (valueOf('show') ?? 0) !== 0;
    entry.index = valueOf('index');
    if (halfWidth > 0 && halfHeight > 0) {
        entry.rect = {
            x: (valueOf(SPRITE_RECT_FIELDS.x) ?? 0) + (valueOf(SPRITE_RECT_FIELDS.displacementX) ?? 0) - halfWidth,
            y: (valueOf(SPRITE_RECT_FIELDS.y) ?? 0) + (valueOf(SPRITE_RECT_FIELDS.displacementY) ?? 0) - halfHeight,
            width: halfWidth * 2,
            height: halfHeight * 2,
            parallax: (valueOf(SPRITE_RECT_FIELDS.parallax) ?? 0)
                + (valueOf(SPRITE_RECT_FIELDS.displacementParallax) ?? 0),
        };
    }

    // where the picture is kept: a BG map texture's block of cells, sized as the sprite is drawn, or the character set
    // an object texture uses
    const isBgmap = isSubclassOf(symbols.classes, className, BGMAP_SPRITE_CLASS);
    const isObject = isSubclassOf(symbols.classes, className, OBJECT_SPRITE_CLASS);
    const texture = readObject(context, valueOf('texture'));
    if (isBgmap) {
        const segment = fieldOf(texture, 'segment');
        const x = fieldOf(texture, 'xOffset');
        const y = fieldOf(texture, 'yOffset');
        if (segment !== undefined && segment >= 0 && x !== undefined && y !== undefined && halfWidth > 0 && halfHeight > 0) {
            entry.cells = { segment, x, y, cols: Math.ceil(halfWidth / 4), rows: Math.ceil(halfHeight / 4) };
        }
    } else if (isObject) {
        const tileSet = readObject(context, fieldOf(texture, 'tileSet') ?? fieldOf(texture, 'charSet'));
        const from = fieldOf(tileSet, 'offset');
        if (from !== undefined) {
            const to = context.tileSets.find(offset => offset > from) ?? CHARACTERS;
            entry.characters = { from, to };
        }
    }

    // otherwise the world or objects it was last rendered into, in hardware numbering (the engine's caches are copied
    // one for one). Object sprites write downwards from `index`, one object per cell. Valid for this frame only, as
    // the engine may hand them out again on the next
    const index = entry.index;
    if (index !== undefined && index >= 0) {
        if (isBgmap && !entry.cells) {
            entry.worlds = [index];
        } else if (isObject && !entry.characters) {
            const count = Math.max(1, (valueOf('rows') ?? 1) * (valueOf('cols') ?? 1));
            for (let object = index; object > index - count && object >= 0; object--) {
                entry.objects.push(object);
            }
        }
    }
    return entry;
}

// the spec is a global the project wrote, so the pointer names it. The best way to tell actors apart, as the engine's
// own `name` field is optional and usually NULL
function specOf(
    index: SymbolIndex, pointer: number | undefined
): { spec?: string, specOffset?: number, specAddress?: number } {
    if (pointer === undefined || pointer === 0) {
        return {};
    }
    // a spec built at runtime, in a block of its own, would otherwise be named after the one symbol around the heap
    const pool = index.memoryPool;
    const inPool = pool !== undefined && pointer >= pool.address && pointer < pool.address + pool.size;
    const found = inPool ? undefined : findSymbolAt(index, pointer);
    if (!found) {
        return { specAddress: pointer }; // still tells two runtime specs apart
    }
    return { spec: specDisplayName(found.symbol.name), specOffset: found.offset, specAddress: pointer };
}

// its own class' layout, or the nearest ancestor's that fits in the block, up to `floor`. A class whose struct the
// debug sections lack still has its base's fields at the same offsets (the class macro puts inherited fields first),
// and a layout larger than the block cannot be right. So the fallback reads fewer fields, never wrong ones
function layoutFor(
    index: SymbolIndex, className: string, availableBytes: number, floor?: string
): VesStruct | undefined {
    for (const ancestor of ancestryOf(index.classes, className)) {
        const struct = index.structs.get(structNameOf(ancestor));
        if (struct && struct.byteSize <= availableBytes) {
            return struct;
        }
        if (ancestor === floor) {
            return undefined;
        }
    }
    return undefined;
}

// undefined for components that draw nothing
function spritesSource(components: VesActorComponent[]): VbPixelSource | undefined {
    const source: VbPixelSource = {
        kind: 'sprites',
        cells: components.flatMap(component => component.cells ? [component.cells] : []),
        characters: components.flatMap(component => component.characters ? [component.characters] : []),
        worlds: components.flatMap(component => component.worlds),
        objects: components.flatMap(component => component.objects),
    };
    return source.cells.length + source.characters.length + source.worlds.length + source.objects.length > 0
        ? source
        : undefined;
}

export function actorPixelSource(actor: VesActor): VbPixelSource | undefined {
    return spritesSource(actor.components);
}

export function componentPixelSource(component: VesActorComponent): VbPixelSource | undefined {
    return spritesSource([component]);
}

// `what` and `where` are the core's two words of pixel origin; see VbPixelSource for why not worlds or objects
export function actorDrawing(
    actors: VesActor[], what: number, where: number, x: number, y: number, eye: 0 | 1
): VesActor | undefined {
    return actors.find(actor => {
        const source = actorPixelSource(actor);
        return source !== undefined && originDrawnBy(what, where, source, x, y, eye);
    });
}

// the smallest sprite rect around the point, for when the core does not say (nothing drew it since Debug mode came on)
export function actorAtPoint(actors: VesActor[], x: number, y: number, eye: 0 | 1): VesActor | undefined {
    let best: { actor: VesActor, area: number } | undefined;
    for (const actor of actors) {
        for (const { rect } of actor.components) {
            if (!rect) {
                continue;
            }
            const left = rect.x + (eye === 0 ? -rect.parallax : rect.parallax);
            if (x >= left && x < left + rect.width && y >= rect.y && y < rect.y + rect.height) {
                const area = rect.width * rect.height;
                if (!best || area < best.area) {
                    best = { actor, area };
                }
            }
        }
    }
    return best?.actor;
}

// the spec, as nearly every actor has one and it is stable across runs
export function actorLabel(actor: VesActor): string {
    return actor.spec ?? actor.className;
}
