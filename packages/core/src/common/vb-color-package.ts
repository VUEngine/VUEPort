import { nls } from './emulator-nls';
import * as vbcpkg from './vbcpkg';
import { restoreColorPackageRuntime, unpackColorPackage } from './vb-color-package-file';

/**
 * A game's VB Color package (format vbcpkg/1, see VB Patches/_tools/vbcpkg/README.md) holds the colorization as data:
 * its runtime (code, hooks), the places the game loads its characters from, and per character and way of drawing the
 * colors each pixel should show. The compiler (vbcpkg.ts) builds it into the patched ROM. The editor changes those
 * colors through a paint layer and compiles again.
 *
 * There are two kinds of package:
 * - Load-source packages (Mario Clash, Teleroboxer) color characters by where the game loads them from; a paint layer
 *   names those load positions.
 * - Context packages (Dragon Hopper, Wario Land) hold a set of characters by index per screen of the game (a
 *   "context"), plus characters colored by their content (the watch).
 */

export interface ColorPackage {
    format: string;
    game: string;
    id: string;
    version: string;
    tables?: ColorPackageTable[];
    contexts?: ColorPackageContext[];
    // figures a context package shows alike in several contexts (Bound High: Chalvo in every stage); key '<id>:k:<n>'
    // paints character n's [context, character] members in their contexts, underneath their own paint
    shared?: ColorPackageShared[];
    // screens shown over a context (pause, menus, dialogs, see README "Overlays"); records with the same id are alike.
    // Paint keys are '<key>:k:<character>' for drawn characters and '<key>:c:<map>:<cell>:<character>' for colored cells,
    // with key = params.overlay_key0 (0x7000) + id
    overlays?: ColorPackageOverlay[];
    sheets?: ColorSheet[];
    // load-source runtime screens as [set source, target]: the target's backdrop applies when that set loads
    backdrops?: [number, string][];
    [field: string]: unknown;
}

// parts are listed front first, so where they overlap a pixel belongs to the first part that shows something there.
// A BG layer's part may name the BG map cell it was seen at (segment * 4096 + cell); if the sheet's `lists` color that
// cell, the part shows the cell's colors instead of its character's
export type ColorSheetPart = [dx: number, dy: number, key: string, h: 0 | 1, v: 0 | 1, way: string, cell?: number];

// a cell list in force on a sheet: a plain name if the list numbers cells like the parts' seventh field does,
// [name, base, count] if it numbers a BG map's cells from `base` on (list cell = part cell - base),
// or [name, {cell: number}] with an explicit number per part cell
export type ColorSheetList = string | [list: string, base: number, count: number] | [list: string, numbers: { [cell: string]: number }];

export interface ColorSheetItem {
    x: number;
    y: number;
    parts: ColorSheetPart[];
    anim?: string;
    frame?: number;
    // for a figure seen where cell lists color objects: the lists in force there, for parts whose seventh field names
    // their object (0xE000 + OAM index)
    lists?: ColorSheetList[];
    // for a whole screen's layer: its world (0 front .. 31 back), eye and the layer's own sheet
    world?: number;
    eye?: 'l' | 'r';
    layer?: string;
}

// pictures of one figure (its frames) or of a background, as the game draws them from its characters; this is what the
// editor paints on. The package ships sheets made from a patch's paint sheets, the user adds more from the screen
export interface ColorSheet {
    id: string;
    name: string;
    folder: string;
    // 'screen' is the whole screen with its layers in place, 384 x 224 from `origin`, with the backdrop behind it
    kind?: 'figures' | 'layer' | 'screen';
    w: number;
    h: number;
    items: ColorSheetItem[];
    // top left of the screen within the sheet, moved by layers reaching left of or above the screen
    origin?: [number, number];
    // 'set:<source>', the load set that brings up the screen (see the package's `backdrops`)
    backdrop?: string;
    scene?: string;
    // the package's cell lists (the list names of its `cells` requests) in force on the sheet's screen, in the order the
    // runtime applies them. They color the cells the parts name, and a later list wins
    lists?: ColorSheetList[];
    // a figure sheet's depth names, front first (e.g. Head, Body, Feet). Parts that cover one another lie at depths of
    // their own, which the editor shows as layers to hide; without names it names depths by position
    depths?: string[];
    // the parts' ways are the game's steady look, so they are shown as drawn instead of lit (see readColorPackage)
    drawn?: boolean;
}

export interface ColorPackageTable {
    name: string;
    decode: string;
    key: string;
    [field: string]: unknown;
}

export interface ColorPackageContext {
    id: number;
    name: string;
    tiles: { [character: string]: string };
    units: { id: string, ctx: [string, number, string][] }[];
    watch?: {
        ranges?: [number, number][];
        lo?: number;
        count?: number;
        units: { id: string, ctx: [string, number, string][] }[];
        tiles: { [id: string]: string };
    };
    [field: string]: unknown;
}

export interface ColorPackageOverlay {
    id: number;
    name: string;
    tiles: { [character: string]: string };
    units: { id: string, ctx: [string, number, string][], noslot?: number }[];
    cells?: [map: number, cell: number, want: unknown][];
    cell_tiles?: { [character: string]: string };
    // characters whose content changes while it shows (dialog text, a card's picture), they get no paint key
    changing?: number[];
    [field: string]: unknown;
}

// a figure's characters in every context that shows them alike (the compiler's paintShared)
export interface ColorPackageShared extends ColorPackageContext {
    // a member character is an index or a watched content 't<tile id>' (context key '<context>:t<tile id>')
    members: { [character: string]: [context: number, character: number | string][] };
}

// where the context runtime (ctxrt) keeps the active context's id, in VB Color memory the game never shows
export const COLOR_CONTEXT_STATE = 0x0309f800;
// id of the active overlay (pause, menu, dialog box), 0 for none
export const COLOR_OVERLAY_STATE = COLOR_CONTEXT_STATE + 24;
// tile a context gives a character whose content changes within it, it matches any content
const ANY_CONTENT_TILE = '799e'.repeat(8);

export interface ColorPaintLayer {
    // per load position (`key`) and way of drawing (`side/selector/palette register`, e.g. `1/0/e0`) the color for each
    // of the character's 64 pixels, null keeps what the package wants
    tiles: { [key: string]: { [way: string]: (string | null)[] } };
    backdrops?: { [context: string]: string[] };
    // model package paint (vb-color-models.ts): a color or ramp per model (edge list) and edge
    models?: { [list: string]: { edges: { [edge: string]: string | string[] } } };
    classes?: { [name: string]: string | string[] };
}

// Backdrop Row Table in VB Color memory: 256 rows of four RGB888 words, one per shade
const BACKDROP_ROWS = 0x030a1000;

export type ColorShownPixel = [value: number, shade: number, color: string | null]; // color null where nothing is drawn

export const COLOR_PACKAGE_FORMAT = 'vbcpkg/1';

export const COLOR_EDIT_EXTENSION = '.vueport-color-edit.json';
export const COLOR_EDIT_BUILD_EXTENSION = '.vueport-color-edit.bps';
export const COLOR_EDIT_PATCH_ID = 'color/edit';

// accepts brotli, gzip or plain JSON (vb-color-package-file.ts); `runtimeBps` is the shipped BPS for a published
// package that only carries its hash (runtime.bpsSha256)
export async function readColorPackage(bytes: Uint8Array, runtimeBps?: Uint8Array): Promise<ColorPackage> {
    const pkg = JSON.parse(new TextDecoder().decode(await unpackColorPackage(bytes))) as ColorPackage;
    if (pkg.format !== COLOR_PACKAGE_FORMAT) {
        throw new Error(`not a VB Color package (${String(pkg.format)})`);
    }
    await restoreColorPackageRuntime(pkg, runtimeBps);
    // sheets show and paint every character lit, otherwise a part seen in a fade or on a hidden layer would show shade 0
    // and paint at shade 0 would reach everything drawn at that shade. `drawn` sheets keep their ways because that is the
    // game's steady look (Dragon Hopper's text boxes draw value 1 at shade 0, black in the game)
    for (const sheet of (pkg as { sheets?: { drawn?: boolean; items?: { parts?: unknown[][] }[] }[] }).sheets ?? []) {
        if (sheet.drawn) {
            continue;
        }
        for (const item of sheet.items ?? []) {
            for (const part of item.parts ?? []) {
                if (typeof part[5] === 'string') {
                    part[5] = colorLitWay(part[5]);
                }
            }
        }
    }
    return pkg;
}

// moves pixel values the register puts at shade 0 (fade, dimmed or hidden layer) to their own shade and keeps the
// others, e.g. '0/0/00' -> '0/0/e4', '1/2/e0' -> '1/2/e4'
export function colorLitWay(way: string): string {
    const [side, selector, register] = way.split('/');
    const value = parseInt(register, 16);
    if (register === undefined || Number.isNaN(value)) {
        return way;
    }
    let lit = value & 3;
    for (let v = 1; v < 4; v++) {
        lit |= (((value >> (2 * v)) & 3) || v) << (2 * v);
    }
    return lit === value ? way : `${side}/${selector}/${lit.toString(16).padStart(2, '0')}`;
}

// way offered for a load position no survey saw drawn: as a BG cell, every value at its own shade
export const UNSEEN_WAY = '0/0/e4';

// FNV-1a 64 of the character's 16 bytes, 't' + 16 hex digits
export function colorTileId(bytes: Uint8Array): string {
    return vbcpkg.tileId(bytes);
}

// value 0..3 at pixel 0..63, row-major
export function colorPixelValue(bytes: Uint8Array, i: number): number {
    return vbcpkg.value(bytes, i);
}

// way of drawing as the package names it: side (0 BG, 1 objects), palette selector, register value
export function colorWay(side: 0 | 1, selector: number, register: number): string {
    return `${side}/${selector}/${(register & 0xFF).toString(16).padStart(2, '0')}`;
}

export interface ColorContextUnit {
    // '<context>:k:<character>' by index or '<context>:t<tile id>' by content (the watch)
    key: string;
    ways: string[];
    byContent: boolean;
    // content changes within the context, so it is colored by group and its pixels cannot be painted
    anyContent: boolean;
}

export interface ColorLoadPosition {
    key: string;
    table: string;
    tile: Uint8Array;
}

// a group of the package's colorable characters as the project tree lists them: a table the game loads characters
// from (load-source packages) or a screen (context packages)
export interface ColorEntityGroup {
    // 'table:<name>', 'context:<id>' or 'overlay:<paint key id>'
    id: string;
    kind: 'table' | 'context' | 'overlay';
    name: string;
    context?: number;
    overlay?: number;
    size: number;
}

export interface ColorEntity {
    // a load position, '<context>:k:<character>' or '<context>:t<tile id>'
    key: string;
    label: string;
    content: Uint8Array;
    // most drawn first
    ways: string[];
    byContent: boolean;
    anyContent: boolean;
}

export interface ColorEntitySection {
    kind: 'positions' | 'characters' | 'content';
    entities: ColorEntity[];
}

function hexBytes(hex: string): Uint8Array {
    return Uint8Array.from(hex.match(/../g) ?? [], x => parseInt(x, 16));
}

// a package together with the original ROM: its load positions by tile, the ways each tile is drawn, and what a built
// ROM shows
export class ColorPackageIndex {
    readonly kind: 'load-source' | 'contexts' | 'models';
    private readonly positions = new Map<string, ColorLoadPosition>();
    private readonly byTile = new Map<string, string[]>();
    private readonly ways = new Map<string, string[]>();
    private readonly contexts = new Map<number, {
        context: ColorPackageContext,
        watched: (character: number) => boolean,
        byTile: Map<string, string[]>,
    }>();

    // by paint key id, keeping the first record of an id since the others are alike
    private readonly overlays = new Map<number, ColorPackageOverlay>();

    constructor(readonly pkg: ColorPackage, readonly original: Uint8Array) {
        this.kind = pkg.contexts ? 'contexts' : pkg.kind === 'models' ? 'models' : 'load-source';
        for (const overlay of pkg.overlays ?? []) {
            const key = vbcpkg.overlayKeyId(pkg, overlay.id) as number;
            if (!this.overlays.has(key)) {
                this.overlays.set(key, overlay);
            }
        }
        for (const context of [...pkg.contexts ?? [], ...pkg.shared ?? []]) {
            const watch = context.watch;
            const ranges = watch ? watch.ranges ?? [[watch.lo ?? 0, watch.count ?? 0]] : [];
            const byTile = new Map<string, string[]>();
            for (const unit of watch?.units ?? []) {
                const hex = watch!.tiles[unit.id];
                if (!hex) {
                    continue;
                }
                const id = colorTileId(Uint8Array.from(hex.match(/../g)!.map(x => parseInt(x, 16))));
                const list = byTile.get(id) ?? [];
                for (const [way] of unit.ctx) {
                    if (!list.includes(way)) {
                        list.push(way);
                    }
                }
                byTile.set(id, list);
            }
            this.contexts.set(context.id, {
                context,
                watched: character => ranges.some(([lo, count]) => character >= lo && character < lo + count),
                byTile,
            });
        }
        for (const shared of pkg.shared ?? []) {
            for (const [n, members] of Object.entries(shared.members)) {
                for (const [context, character] of members) {
                    const key = typeof character === 'string' ? `${context}:${character}` : `${context}:k:${character}`;
                    this.sharedKeys.set(key, [...this.sharedKeys.get(key) ?? [], `${shared.id}:k:${n}`]);
                }
            }
        }
        for (const table of pkg.tables ?? []) {
            for (const { key, t } of vbcpkg.slots(original, table) as { key: string, t: Uint8Array }[]) {
                const tile = new Uint8Array(t);
                this.positions.set(key, { key, table: table.name, tile });
                // a stand-in table (cell-patch masks) holds no game tiles, so it is never picked from the screen
                if ((table as { stand_in?: boolean }).stand_in) {
                    // swatch tables hold characters the game draws itself, colored by position: paintable, just not picked
                    if (!(table as { swatch?: boolean }).swatch) {
                        this.standIn.add(table.name);
                    }
                    continue;
                }
                const id = colorTileId(tile);
                const list = this.byTile.get(id);
                if (list) {
                    list.push(key);
                } else {
                    this.byTile.set(id, [key]);
                }
            }
        }
        for (const unit of (pkg.units as { id: string, ctx: [string, number, string][] }[] | undefined) ?? []) {
            this.ways.set(unit.id, unit.ctx.map(([way]) => way));
        }
    }

    private groupList?: ColorEntityGroup[];
    private readonly sectionCache = new Map<string, ColorEntitySection[]>();

    groups(): ColorEntityGroup[] {
        if (this.groupList) {
            return this.groupList;
        }
        const groups: ColorEntityGroup[] = [];
        if (this.kind === 'contexts') {
            for (const context of [...this.pkg.contexts ?? [], ...this.pkg.shared ?? []]) {
                groups.push({
                    id: `context:${context.id}`,
                    kind: 'context',
                    name: context.name,
                    context: context.id,
                    // the watch's characters count once per content, as the tree lists them
                    size: context.units.filter(unit => unit.ctx.length && unit.id.startsWith('k:')).length
                        + new Set((context.watch?.units ?? []).map(unit => context.watch!.tiles[unit.id]).filter(Boolean)).size,
                });
            }
            for (const [key, overlay] of this.overlays) {
                groups.push({
                    id: `overlay:${key}`,
                    kind: 'overlay',
                    name: overlay.name,
                    overlay: overlay.id,
                    size: this.sections(`overlay:${key}`)[0]?.entities.filter(entity => !entity.anyContent).length ?? 0,
                });
            }
        } else {
            const sizes = new Map<string, number>();
            for (const position of this.positions.values()) {
                if (position.tile.some(byte => byte !== 0)) {
                    sizes.set(position.table, (sizes.get(position.table) ?? 0) + 1);
                }
            }
            for (const table of this.pkg.tables ?? []) {
                const size = sizes.get(table.name) ?? 0;
                if (size && !this.standIn.has(table.name)) {
                    groups.push({ id: `table:${table.name}`, kind: 'table', name: table.name, size });
                }
            }
        }
        return this.groupList = groups;
    }

    // a group's characters: a table's load positions in their order (blank ones left out, as nothing of them shows), or
    // a context's characters by index and those it colors by content
    sections(groupId: string): ColorEntitySection[] {
        const cached = this.sectionCache.get(groupId);
        if (cached) {
            return cached;
        }
        const sections: ColorEntitySection[] = [];
        const at = groupId.indexOf(':');
        const kind = groupId.slice(0, at);
        const name = groupId.slice(at + 1);
        if (kind === 'table') {
            const entities: ColorEntity[] = [];
            for (const position of this.positions.values()) {
                if (position.table !== name || position.tile.every(byte => byte === 0)) {
                    continue;
                }
                const ways = this.waysOf(position.tile);
                entities.push({
                    key: position.key,
                    label: position.key.slice(position.key.lastIndexOf(':') + 1),
                    content: position.tile,
                    // a position no survey saw drawn is offered as a BG cell, the compiler applies that paint to objects too
                    ways: ways.length ? ways : [UNSEEN_WAY],
                    byContent: false,
                    anyContent: false,
                });
            }
            sections.push({ kind: 'positions', entities });
        } else if (kind === 'overlay') {
            const id = Number(name);
            const overlay = this.overlays.get(id);
            if (overlay) {
                const changing = new Set(overlay.changing ?? []);
                const characters = overlay.units
                    .filter(unit => unit.ctx.length && unit.id.startsWith('k:'))
                    .map(unit => {
                        const character = unit.id.slice(2);
                        const hex = overlay.tiles[character] ?? '';
                        const anyContent = hex === ANY_CONTENT_TILE || !!unit.noslot || changing.has(Number(character));
                        return {
                            key: `${id}:${unit.id}`,
                            label: character,
                            content: hex && hex !== ANY_CONTENT_TILE ? hexBytes(hex) : new Uint8Array(16),
                            ways: unit.ctx.map(([way]) => way),
                            byContent: false,
                            anyContent,
                        };
                    })
                    .sort((a, b) => Number(a.label) - Number(b.label));
                sections.push({ kind: 'characters', entities: characters });
            }
        } else if (kind === 'context') {
            const id = Number(name);
            const context = this.contexts.get(id)?.context;
            if (context) {
                const characters = context.units
                    .filter(unit => unit.ctx.length && unit.id.startsWith('k:'))
                    .map(unit => {
                        const character = unit.id.slice(2);
                        const hex = context.tiles[character] ?? '';
                        const anyContent = hex === ANY_CONTENT_TILE;
                        return {
                            key: `${id}:${unit.id}`,
                            label: character,
                            content: hex && !anyContent ? hexBytes(hex) : new Uint8Array(16),
                            ways: unit.ctx.map(([way]) => way),
                            byContent: false,
                            anyContent,
                        };
                    })
                    .sort((a, b) => Number(a.label) - Number(b.label));
                sections.push({ kind: 'characters', entities: characters });
                const watch = context.watch;
                if (watch?.units.length) {
                    const byContent = new Map<string, ColorEntity>();
                    for (const unit of watch.units) {
                        const hex = watch.tiles[unit.id];
                        if (!hex) {
                            continue;
                        }
                        const content = hexBytes(hex);
                        const tile = colorTileId(content);
                        const ways = unit.ctx.map(([way]) => way);
                        const entity = byContent.get(tile);
                        if (entity) {
                            ways.filter(way => !entity.ways.includes(way)).forEach(way => entity.ways.push(way));
                        } else {
                            byContent.set(tile, {
                                key: `${id}:${tile}`, label: tile.slice(1), content, ways, byContent: true, anyContent: false,
                            });
                        }
                    }
                    sections.push({ kind: 'content', entities: [...byContent.values()] });
                }
            }
        }
        this.sectionCache.set(groupId, sections);
        return sections;
    }

    private readonly sharedKeys = new Map<string, string[]>();

    // shared keys whose paint reaches a '<context>:k:<character>' key, in the order the compiler lays them under the
    // key's own paint; empty for other keys
    sharedOf(key: string): readonly string[] {
        return this.sharedKeys.get(key) ?? [];
    }

    groupOf(key: string): string | undefined {
        if (this.kind === 'contexts') {
            const at = key.indexOf(':');
            return at > 0 ? `${this.overlays.has(Number(key.slice(0, at))) ? 'overlay' : 'context'}:${key.slice(0, at)}` : undefined;
        }
        const position = this.positions.get(colorCellKey(key)?.tile ?? key);
        return position && `table:${position.table}`;
    }

    // undefined where the character has no fixed content; a cell key gives its character's content
    contentOf(key: string): Uint8Array | undefined {
        if (this.kind === 'load-source') {
            return this.positions.get(colorCellKey(key)?.tile ?? key)?.tile;
        }
        const entity = this.entity(key);
        return entity && !entity.anyContent ? entity.content : undefined;
    }

    // paint keys a change to this one applies to: in a load-source package every load position with the same content
    // (key first), in a context package just the key
    samePositions(key: string): string[] {
        const tile = this.kind === 'load-source' ? this.positions.get(key)?.tile : undefined;
        return tile ? [key, ...this.positionsOf(tile).map(position => position.key).filter(other => other !== key)] : [key];
    }

    // the character a load position is drawn from, if the package's `slotless` names it (positions drawn from one
    // character without a pixel color slot of their own, e.g. Jack Bros' opening clouds at 0x700+). A picked character
    // with that number and content then maps to this position, not another one with the same content
    drawnAt(key: string): number | undefined {
        const at = key.lastIndexOf(':');
        const table = (this.pkg.slotless as { [table: string]: { chr?: { [index: string]: number | null } } } | undefined)?.[key.slice(0, at)];
        return table?.chr?.[key.slice(at + 1)] ?? undefined;
    }

    // backdrop color per screen row (224, first shade) from the Backdrop Row Table the context writes, undefined if none
    backdropRows(contextId: number): string[] | undefined {
        const blob = this.contexts.get(contextId)?.context.blobs as [number, string][] | undefined;
        const data = blob?.find(([dst]) => dst === BACKDROP_ROWS)?.[1];
        if (!data) {
            return undefined;
        }
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        return Array.from({ length: 224 }, (_, y) => {
            const at = Math.min(16 * y, bytes.length - 16);
            return '#' + [bytes[at], bytes[at + 1], bytes[at + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
        });
    }

    entity(key: string): ColorEntity | undefined {
        const group = this.groupOf(key);
        for (const section of group ? this.sections(group) : []) {
            const found = section.entities.find(entity => entity.key === key);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    positionsOf(bytes: Uint8Array): ColorLoadPosition[] {
        return (this.byTile.get(colorTileId(bytes)) ?? []).map(key => this.positions.get(key)!);
    }

    position(key: string): ColorLoadPosition | undefined {
        return this.positions.get(key);
    }

    allPositions(): IterableIterator<ColorLoadPosition> {
        return this.positions.values();
    }

    // whether painting the key changes what the game shows
    paintable(key: string): boolean {
        if (this.kind === 'contexts') {
            const at = key.indexOf(':');
            return !(this.overlays.has(Number(key.slice(0, at))) && key.slice(at + 1).startsWith('k:') && this.entity(key)?.anyContent !== false);
        }
        const cached = this.paintableCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const cell = colorCellKey(key);
        const position = this.positions.get(cell?.tile ?? key);
        const yes = cell
            ? !!position && this.cellRequest(cell.list, cell.cell)?.paintable === true
            : !!position && !this.standIn.has(position.table);
        this.paintableCache.set(key, yes);
        return yes;
    }

    private readonly paintableCache = new Map<string, boolean>();
    private zeroPaintable?: (key: string) => boolean;

    /**
     * Whether the pixels the game leaves transparent (value 0) can be painted on the key. A color makes such a pixel
     * opaque (VB Color draws it, covering what lies behind), the eraser makes it transparent again. Not possible where
     * the package's runtime has no opaque pixel slots for the key (vbcpkg.zeroPaintable): model packages, Hyper
     * Fighting's fighters, Golf's frame buffer sprites, cell list keys, and runtimes that ignore the OPQ bit.
     */
    paintsTransparent(key: string): boolean {
        const zeroPaintable = vbcpkg.zeroPaintable as (pkg: ColorPackage, tableOf: (key: string) => string | undefined) => (key: string) => boolean;
        this.zeroPaintable ??= zeroPaintable(this.pkg, other => this.positions.get(other)?.table);
        return this.paintable(key) && this.zeroPaintable(key);
    }
    // tables without game tiles (cell-patch masks, a strip a picture paints over), neither listed in the tree nor painted
    private readonly standIn = new Set<string>();

    // ways of the tile's own unit plus those of the load positions holding it (packages color by tile, by load position
    // or both), most drawn first per unit
    waysOf(bytes: Uint8Array): string[] {
        const out = new Set(this.ways.get(colorTileId(bytes)) ?? []);
        for (const { key } of this.positionsOf(bytes)) {
            for (const way of this.ways.get(key) ?? []) {
                out.add(way);
            }
        }
        return [...out];
    }

    contextUnit(contextId: number, character: number, bytes: Uint8Array): ColorContextUnit | undefined {
        const entry = this.contexts.get(contextId);
        if (!entry) {
            return undefined;
        }
        if (entry.watched(character)) {
            const id = colorTileId(bytes);
            return { key: `${contextId}:${id}`, ways: entry.byTile.get(id) ?? [], byContent: true, anyContent: false };
        }
        const unit = entry.context.units.find(u => u.id === `k:${character}`);
        return {
            key: `${contextId}:k:${character}`,
            ways: unit?.ctx.map(([way]) => way) ?? [],
            byContent: false,
            anyContent: entry.context.tiles[String(character)] === ANY_CONTENT_TILE,
        };
    }

    // the paint key id is the number the overlay's keys start with
    overlayKey(overlayId: number): number | undefined {
        const key = vbcpkg.overlayKeyId(this.pkg, overlayId) as number;
        return this.overlays.has(key) ? key : undefined;
    }

    /**
     * A character the overlay `overlayId` shows (the runtime keeps that id at COLOR_OVERLAY_STATE), drawn as an object
     * or in a BG map cell the overlay colors (`cell` = segment * 4096 + cell). Its paint key is '<key>:k:<character>';
     * a cell's own key comes from contextCellKey. Undefined where the context, not the overlay, colors it.
     */
    overlayUnit(overlayId: number, character: number, cell?: number): ColorContextUnit | undefined {
        const key = this.overlayKey(overlayId);
        const overlay = key !== undefined ? this.overlays.get(key) : undefined;
        if (!overlay) {
            return undefined;
        }
        if (cell !== undefined) {
            const colors = (overlay.cells ?? []).some(([map, at, want]) => map * 4096 + at === cell && !!want && want !== 'chrsel');
            return colors ? { key: `${key}:k:${character}`, ways: [], byContent: false, anyContent: (overlay.changing ?? []).includes(character) } : undefined;
        }
        const unit = overlay.units.find(u => u.id === `k:${character}`);
        return unit ? { key: `${key}:k:${character}`, ways: unit.ctx.map(([way]) => way), byContent: false, anyContent: !!unit.noslot } : undefined;
    }

    // the 64 pixels a ROM built from this package shows of a paint key drawn a way, or undefined. Keys are load
    // positions, or in a context package '<context>:k:<character>' and '<context>:t<tile id>'
    shown(rom: Uint8Array, scene?: string): (key: string, way: string) => ColorShownPixel[] | undefined {
        if (this.kind === 'contexts') {
            const inContext = vbcpkg.contextShown(this.pkg, rom) as (id: number, key: string, way: string) => ColorShownPixel[] | null;
            return (key, way) => {
                const at = key.indexOf(':');
                return inContext(Number(key.slice(0, at)), key.slice(at + 1), way) ?? undefined;
            };
        }
        const known = scene !== undefined && (this.pkg.scenes as string[] | undefined)?.includes(scene) ? scene : undefined;
        const look = (known !== undefined
            ? vbcpkg.shownPixels(this.pkg, this.original, rom, known)
            : vbcpkg.shownPixels(this.pkg, this.original, rom)) as (key: string, way: string) => ColorShownPixel[] | null;
        // a cell key shows the cell as its list colors it, which includes the paint after a build with it
        let cells: ColorCellShown | undefined;
        return (key, way) => {
            const cell = colorCellKey(key);
            if (!cell) {
                return look(key, way) ?? undefined;
            }
            const tile = this.positions.get(cell.tile)?.tile;
            cells ??= this.cellShown(rom, scene);
            return (tile && cells([cell.list], cell.cell, way, tile)) || look(cell.tile, way) || undefined;
        };
    }

    private cellRequests?: Map<string, { paintable: boolean }>;

    // the last cell request naming the cell wins, as in the runtime. Paintable if the list holds slots (8-byte entries)
    // and the request colors the cell rather than doing CHRSEL; undefined if there is no request
    cellRequest(list: string, cell: number): { paintable: boolean } | undefined {
        if (!this.cellRequests) {
            this.cellRequests = new Map();
            const lists = (this.pkg.lists ?? {}) as { [name: string]: { entry?: number } };
            for (const [name, at, want] of (this.pkg.cells ?? []) as [string, number, unknown][]) {
                // cells of a 4-byte list are paintable too if cell_promote has free slots for them
                const promote = (this.pkg.cell_promote as { [list: string]: { free?: number[] } } | undefined)?.[name];
                this.cellRequests.set(`${name}#${at}`, {
                    paintable: (lists[name]?.entry === 8 || !!promote?.free?.length) && !!want && want !== 'chrsel',
                });
            }
        }
        return this.cellRequests.get(`${list}#${cell}`);
    }

    cellList(lists: readonly ColorSheetList[] | undefined, cell: number | undefined): string | undefined {
        return this.cellRef(lists, cell)?.list;
    }

    // of the cell lists in force on a sheet (in the runtime's order), the last one with a request for the part's cell,
    // with the cell's number in that list
    cellRef(lists: readonly ColorSheetList[] | undefined, cell: number | undefined): { list: string, cell: number } | undefined {
        if (!lists || cell === undefined) {
            return undefined;
        }
        for (let k = lists.length - 1; k >= 0; k--) {
            const entry = lists[k];
            let list: string, at: number | undefined;
            if (typeof entry === 'string') {
                [list, at] = [entry, cell];
            } else if (entry.length === 2) {
                [list, at] = [entry[0], entry[1][String(cell)]];
            } else {
                [list, at] = [entry[0], cell - entry[1] >= 0 && cell - entry[1] < entry[2] ? cell - entry[1] : undefined];
            }
            if (at !== undefined && this.cellRequest(list, at)) {
                return { list, cell: at };
            }
        }
        return undefined;
    }

    // the 64 pixels a built context package shows for a BG map cell (`cell` = segment * 4096 + cell) that the context
    // colors per cell (via a palette group, a table or a cell request), which the character's paint does not reach.
    // Undefined where the cell shows its character's colors (CHRSEL, see `shown`) and for other packages
    contextCellShown(rom: Uint8Array): (key: string, cell: number, way: string) => ColorShownPixel[] | undefined {
        if (this.kind !== 'contexts') {
            return () => undefined;
        }
        const inContext = vbcpkg.contextCellShown(this.pkg, rom) as
            (id: number, map: number, cell: number, key: string, way: string) => ColorShownPixel[] | null;
        return (key, cell, way) => {
            const at = key.indexOf(':');
            return at > 0 ? inContext(Number(key.slice(0, at)), cell >> 12, cell & 0xfff, key.slice(at + 1), way) ?? undefined : undefined;
        };
    }

    private contextCellKeys?: (key: string, cell: number | undefined) => string | null;

    /**
     * The paint key of a BG map cell that the context colors per cell rather than by its character
     * (vbcpkg.contextCellKey). `key` is the '<context>:k:<character>' in the cell, `cell` is segment * 4096 + cell.
     * Returns '<context>:m:<map>:<character>' for every cell of the character in a map the context colors by rule
     * (stage terrain), or '<context>:c:<map>:<cell>:<character>' for this cell alone in a map whose cells have colors
     * of their own (a story picture or screen). Undefined where the cell shows its character's colors, and for other
     * packages.
     */
    contextCellKey(key: string, cell: number | undefined): string | undefined {
        if (this.kind !== 'contexts' || cell === undefined) {
            return undefined;
        }
        this.contextCellKeys ??= vbcpkg.contextCellKeys(this.pkg) as (key: string, cell: number | undefined) => string | null;
        return this.contextCellKeys(key, cell) ?? undefined;
    }

    cellShown(rom: Uint8Array, scene?: string): ColorCellShown {
        if (this.kind === 'contexts' || !Array.isArray(this.pkg.cells) || !this.pkg.cells.length) {
            return () => undefined;
        }
        const known = scene !== undefined && (this.pkg.scenes as string[] | undefined)?.includes(scene) ? scene : undefined;
        return (known !== undefined
            ? vbcpkg.cellShown(this.pkg, this.original, rom, known)
            : vbcpkg.cellShown(this.pkg, this.original, rom)) as ColorCellShown;
    }
}

// pixels a built ROM shows for a BG map cell its cell lists color (vbcpkg.cellShown); null where the lists give the
// cell back to its character, undefined where they do not name it
export type ColorCellShown = (lists: readonly string[], cell: number, way: string, tile: Uint8Array) => ColorShownPixel[] | null | undefined;

// parses 'cell#<list>#<cell>#<load position of its character>'; painting such a key changes only that list's entry
// for the cell (vbcpkg.mjs paintCells), not the character elsewhere
export function colorCellKey(key: string): { list: string, cell: number, tile: string } | undefined {
    return (vbcpkg.cellKey(key) as { list: string, cell: number, tile: string } | null) ?? undefined;
}

export function makeColorCellKey(list: string, cell: number, tile: string): string {
    return vbcpkg.makeCellKey(list, cell, tile) as string;
}

// a failed build in words for the user: the compiler's typed errors (vbcpkg.mjs DataAreaFull and others) get a sentence
// of their own, other errors their message
export function colorBuildErrorText(error: unknown): string {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === 'data-area-full') {
        const area = (error as { area?: number }).area;
        return nls.localize('vueport/color/build/dataAreaFull',
            'This package has no room left for more colors: its color data area ({0} KB) is full. Paint fewer pixels in colors of their own (a character whose value shows more than one color needs one), or use colors the package already has.',
            typeof area === 'number' && area > 0 ? Math.round(area / 1024) : '?');
    }
    if (code === 'palette-groups-full') {
        // (vbcpkg.mjs PaletteGroupsFull) the paint asks for more color ramps of its own than the palette groups hold
        const { groups, patchGroups, room } = error as { groups?: number, patchGroups?: number, room?: number };
        const count = (n?: number): string | number => typeof n === 'number' ? n : '?';
        return nls.localize('vueport/color/build/paletteGroupsFull',
            'This paint needs more palette groups than the package has: {0} for characters and {1} for cells, but there are only {2}. Paint characters that have no pixel slot of their own (backgrounds, floor tiles) in fewer different colors, or use colors the package already has.',
            count(groups), count(patchGroups), count(room));
    }
    if (code === 'context-slots-full' || code === 'context-palettes-full' || code === 'context-cell-paint') {
        const { context, detail } = error as { context?: string | number, detail?: string };
        return code === 'context-slots-full'
            ? nls.localize('vueport/color/build/contextSlotsFull',
                'The screen "{0}" has no pixel slots left for this paint ({1}). Paint fewer characters or cells of that screen with colors of their own, or give cells colors they share.',
                String(context ?? '?'), detail ?? '')
            : code === 'context-palettes-full'
                ? nls.localize('vueport/color/build/contextPalettesFull',
                    'The screen "{0}" has no palettes left for these colors ({1}). Use colors the screen already shows, or fewer different colors.',
                    String(context ?? '?'), detail ?? '')
                : nls.localize('vueport/color/build/contextCellPaint', 'The screen "{0}" cannot take this paint: {1}.', String(context ?? '?'), detail ?? '');
    }
    return error instanceof Error ? error.message : String(error);
}

export interface ColorBuild {
    rom: Uint8Array;
    stats: { [name: string]: unknown };
}

export function compileColorPackage(pkg: ColorPackage, original: Uint8Array, paint?: ColorPaintLayer): ColorBuild {
    const painted = paint && (Object.keys(paint.tiles).length || Object.keys(paint.models ?? {}).length || Object.keys(paint.classes ?? {}).length);
    const { rom, stats } = vbcpkg.compile(pkg, original, { paint: painted ? [paint] : [] });
    return { rom, stats };
}

export function colorBuildPatch(pkg: ColorPackage, original: Uint8Array, rom: Uint8Array): Uint8Array {
    const shifts = (pkg.runtime as { shifts?: number[] } | undefined)?.shifts ?? [0];
    return vbcpkg.bpsMake(original, rom, shifts);
}
