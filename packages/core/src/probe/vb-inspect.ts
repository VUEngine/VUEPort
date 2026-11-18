import { ancestryOf, isSubclassOf } from '../browser/core/emulator-classes';
import { readStructFields, VesStruct } from '../browser/core/emulator-dwarf';
import {
    BLOCK_HEADER_BYTES, parseMemoryPoolLayout, readMemoryPoolBlocks, readMemoryPoolUsage, VesMemoryPool, VesMemoryPoolUsage,
} from '../browser/core/emulator-memory-pool';
import { structNameOf } from '../browser/core/emulator-symbols';
import { VcuColorParts, VcuColors } from '../browser/panels/emulator-vcu-colors';
import {
    VBC_ID0_VALUE, VBC_ID1_VALUE, VbcState, VCU_CRAM_BASE, VCU_CRAM_BYTES, VCU_CXCTRL_BKREN, VCU_CXCTRL_CCEN, VCU_CXCTRL_PCEN,
    VCU_CXCTRL_WCEN, VCU_REGISTER_BASE, VCU_REGISTER_BLOCK_BYTES, VcuRegister,
} from '../browser/panels/emulator-vcu-memory';
import {
    decodeVipBgMapCell, decodeVipObject, decodeVipWorld, isVipObjectVisible, VIP_BGMAP_CELLS, VIP_CHAR_BYTES,
    VIP_CHAR_SIZE, VIP_CHARS_PER_SEGMENT, VIP_OAM_BASE, VIP_OAM_BLOCK_BYTES, VIP_OBJECT_COUNT, VIP_OBJECT_GROUP_COUNT,
    VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES, VIP_WORLD_BASE, VIP_WORLD_BLOCK_BYTES, VIP_WORLD_COUNT, VIP_WORLD_MODE_NAMES,
    vipBgMapAddress, vipBrightnessLevelsFromRegisters, vipCharSegmentAddress, vipObjectGroupForWorld, vipObjectGroupOf,
    vipObjectGroupRange, VipRegister, VipWorld, VipWorldMode,
} from '../browser/panels/emulator-vip-memory';
import { VbMachine } from './vb-machine';

// the machine's hardware state as data, decoded by the same code as the app's debug panels; read through the
// debug bus, so nothing here disturbs the machine

export interface VbVipState {
    registers: Record<string, number>; // every VIP register by its name in vip.h
    brightness: number[]; // the four brightness levels, 0-255, as the core lights them
    // GPLT0-3 and JPLT0-3, each as the shades its pixel values 0-3 select
    palettes: { bgmap: number[][], object: number[][] };
    // object groups as first and last index, or null for an empty one
    objectGroups: ({ first: number, last: number } | null)[];
    worlds: VbWorld[]; // the worlds the VIP draws this frame, from 31 down
    vbc?: VbVbcState; // VB Color, while a game has switched it on
}

export interface VbWorld extends VipWorld {
    modeName: string;
    objectGroup?: number; // for an object world, which group it draws
    paletteOffset?: number; // VB Color: what the world adds to the palettes of what it draws, under WCEN
}

export interface VbObject {
    index: number;
    group?: number;
    x: number;
    y: number;
    parallax: number;
    char: number;
    palette: number;
    hFlip: boolean;
    vFlip: boolean;
    left: boolean;
    right: boolean;
    // VB Color: the CRAM palette it draws with, and the Pixel Color Slot if one applies
    color?: { palette: number, slot: boolean };
}

export interface VbBgMapCell {
    x: number;
    y: number;
    char: number;
    palette: number;
    hFlip: boolean;
    vFlip: boolean;
    color?: { palette: number, slot: boolean };
}

export interface VbVbcState {
    chrext: boolean;
    colen: boolean;
    pcen: boolean;
    wcen: boolean;
    bkren: boolean;
    ccen: boolean;
    wramext: boolean;
    cbkpal: number;
    cram: string[][]; // all 256 palettes, four #rrggbb colors each
}

export interface VbPoolState {
    address: number;
    pools: (VesMemoryPool & VesMemoryPoolUsage)[];
}

export interface VbInstance {
    address: number;
    className: string;
    ancestry: string[]; // the class and its bases, nearest first
    blockSize: number;
    name?: string;
    fields?: { path: string, value: string }[]; // every field, where the build describes the class
}

export function readVip(vb: VbMachine): VbVipState {
    const registers = view(vb, VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES);
    const worlds = readWorlds(vb);
    const vbc = readVbc(vb);
    const colors = vbc ? vcuColors(vb, vbc, { worlds: true }) : undefined;
    const levels = vipBrightnessLevelsFromRegisters(registers);
    const shades = (register: VipRegister): number[] =>
        [0, 1, 2, 3].map(value => (value === 0 ? 0 : levels[(registers.getUint16(register, true) >> (value * 2)) & 3]));
    const all = Array.from({ length: VIP_WORLD_COUNT }, (unused, index) => worlds[index]).reverse();

    const drawn: VbWorld[] = [];
    for (const world of all) {
        if (world.end) {
            break;
        }
        if (!world.lon && !world.ron) {
            continue;
        }
        const entry: VbWorld = { ...world, modeName: VIP_WORLD_MODE_NAMES[world.mode] };
        if (world.mode === VipWorldMode.OBJECT) {
            entry.objectGroup = vipObjectGroupForWorld(all, world.index);
        }
        if (colors && vbc?.wcen) {
            entry.paletteOffset = colors.worldOffset(world.index);
        }
        drawn.push(entry);
    }

    return {
        registers: Object.fromEntries(Object.entries(VipRegister)
            .filter(([, offset]) => typeof offset === 'number')
            .map(([name, offset]) => [name, registers.getUint16(offset as number, true)])),
        brightness: levels,
        palettes: {
            bgmap: [VipRegister.GPLT0, VipRegister.GPLT1, VipRegister.GPLT2, VipRegister.GPLT3].map(shades),
            object: [VipRegister.JPLT0, VipRegister.JPLT1, VipRegister.JPLT2, VipRegister.JPLT3].map(shades),
        },
        objectGroups: Array.from({ length: VIP_OBJECT_GROUP_COUNT }, (unused, group) => vipObjectGroupRange(registers, group) ?? null),
        worlds: drawn,
        ...(vbc ? { vbc: publicVbc(vb, vbc) } : {}),
    };
}

export function readWorlds(vb: VbMachine): VipWorld[] {
    const block = view(vb, VIP_WORLD_BASE, VIP_WORLD_BLOCK_BYTES);
    return Array.from({ length: VIP_WORLD_COUNT }, (unused, index) => decodeVipWorld(block, index, index * 32));
}

// objects shown to an eye by default, or all 1024 with all. Not filtered by group: many games (Wario Land)
// rewrite SPT0-3 while the VIP draws, so at the end of a frame the registers describe nothing in particular
export function readObjects(vb: VbMachine, options: { all?: boolean } = {}): VbObject[] {
    const registers = view(vb, VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES);
    const oam = view(vb, VIP_OAM_BASE, VIP_OAM_BLOCK_BYTES);
    const vbc = readVbc(vb);
    const colors = vbc ? vcuColors(vb, vbc, { objects: true }) : undefined;
    const charMask = vbc?.chrext ? 0x0fff : 0x07ff;
    const objects: VbObject[] = [];
    for (let index = 0; index < VIP_OBJECT_COUNT; index++) {
        const object = decodeVipObject(oam, index, index * 8, charMask);
        const group = vipObjectGroupOf(registers, index);
        if (!options.all && !isVipObjectVisible(object)) {
            continue;
        }
        const entry: VbObject = {
            index,
            ...(group !== undefined ? { group } : {}),
            x: object.jx,
            y: object.jy,
            parallax: object.jp,
            char: object.char,
            palette: object.palette,
            hFlip: object.hFlip,
            vFlip: object.vFlip,
            left: object.lon,
            right: object.ron,
        };
        if (colors) {
            const placement = colors.object(index, object.char, object.palette);
            entry.color = { palette: placement.palette, slot: placement.slot !== undefined };
        }
        objects.push(entry);
    }
    return objects;
}

export function readBgMap(
    vb: VbMachine, segment: number, rect: { x: number, y: number, width: number, height: number } = { x: 0, y: 0, width: 64, height: 64 },
): VbBgMapCell[] {
    if (!Number.isInteger(segment) || segment < 0 || segment > 13) {
        throw new Error(`BGMap segments are 0 to 13, not ${segment}.`);
    }
    const map = view(vb, vipBgMapAddress(segment), VIP_BGMAP_CELLS * VIP_BGMAP_CELLS * 2);
    const vbc = readVbc(vb);
    const colors = vbc ? vcuColors(vb, vbc, { segments: [segment] }) : undefined;
    const charMask = vbc?.chrext ? 0x0fff : 0x07ff;
    const cells: VbBgMapCell[] = [];
    for (let y = rect.y; y < Math.min(VIP_BGMAP_CELLS, rect.y + rect.height); y++) {
        for (let x = rect.x; x < Math.min(VIP_BGMAP_CELLS, rect.x + rect.width); x++) {
            const index = y * VIP_BGMAP_CELLS + x;
            const cell = decodeVipBgMapCell(map.getUint16(index * 2, true), charMask);
            const entry: VbBgMapCell = { x, y, ...cell };
            if (colors) {
                const placement = colors.cell(segment, index, cell.char, cell.palette);
                entry.color = { palette: placement.palette, slot: placement.slot !== undefined };
            }
            cells.push(entry);
        }
    }
    return cells;
}

// a character's 8x8 pixel values, 0-3, row by row
export function readCharacter(vb: VbMachine, index: number): number[][] {
    const segment = Math.floor(index / VIP_CHARS_PER_SEGMENT);
    if (!Number.isInteger(index) || index < 0 || segment > 7) {
        throw new Error(`Characters are 0 to 2047 (4095 with VB Color's CHREXT), not ${index}.`);
    }
    const bytes = vb.read(vipCharSegmentAddress(segment) + (index % VIP_CHARS_PER_SEGMENT) * VIP_CHAR_BYTES, VIP_CHAR_BYTES);
    return Array.from({ length: VIP_CHAR_SIZE }, (unused, y) => {
        const row = bytes[y * 2] | (bytes[y * 2 + 1] << 8);
        return Array.from({ length: VIP_CHAR_SIZE }, (unusedToo, x) => (row >> (x * 2)) & 3);
    });
}

// the VB Color unit's switches and CRAM, while a game has unlocked it (the same test as the app's readVbcState)
export function readVbcState(vb: VbMachine): VbVbcState | undefined {
    const vbc = readVbc(vb);
    return vbc ? publicVbc(vb, vbc) : undefined;
}

// how full each of the engine's memory pools is, for a VUEngine build with symbols
export function readPool(vb: VbMachine): VbPoolState | undefined {
    const pool = poolRegion(vb);
    if (!pool) {
        return undefined;
    }
    const usage = readMemoryPoolUsage(pool.layout, pool.region, vb.symbols!.index.vTables);
    return {
        address: pool.layout.base,
        pools: pool.layout.pools.map((entry, index) => ({ ...entry, ...usage[index] })),
    };
}

// the objects in the engine's memory pools: every one, or those of a class and its subclasses (Actor), with
// their fields where the build describes them
export function readInstances(vb: VbMachine, options: { className?: string, fields?: boolean } = {}): VbInstance[] {
    const pool = poolRegion(vb);
    if (!pool) {
        return [];
    }
    const index = vb.symbols!.index;
    const instances: VbInstance[] = [];
    for (const block of readMemoryPoolBlocks(pool.layout, pool.region)) {
        const className = index.vTables.get(block.vTable);
        if (className === undefined || (options.className && !isSubclassOf(index.classes, className, options.className))) {
            continue;
        }
        const ancestry = ancestryOf(index.classes, className);
        const instance: VbInstance = { address: block.objectAddress, className, ancestry, blockSize: block.blockSize };
        const struct = layoutFor(index.structs, ancestry, block.blockSize - BLOCK_HEADER_BYTES);
        if (struct) {
            const fields = readStructFields(struct, pool.region, block.objectOffset);
            const namePointer = fields.find(field => field.path === 'name')?.value;
            if (namePointer) {
                instance.name = readCString(vb, namePointer);
            }
            if (options.fields) {
                instance.fields = fields.map(field => ({ path: field.path, value: field.text }));
            }
        }
        instances.push(instance);
    }
    return instances;
}

// plumbing

function view(vb: VbMachine, address: number, length: number): DataView {
    const bytes = vb.read(address, length);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// the VCU's registers as the app's panels read them, when a game has switched VB Color on
function readVbc(vb: VbMachine): VbcState | undefined {
    if (!vb.vbc) {
        return undefined;
    }
    const registers = view(vb, VCU_REGISTER_BASE, VCU_REGISTER_BLOCK_BYTES);
    if (registers.getUint16(VcuRegister.VBCID0, true) !== VBC_ID0_VALUE
        || registers.getUint16(VcuRegister.VBCID1, true) !== VBC_ID1_VALUE
        || (registers.getUint16(VcuRegister.VBCCTRL, true) & 1) === 0) {
        return undefined;
    }
    const cxctrl = registers.getUint16(VcuRegister.CXCTRL, true);
    return {
        registers,
        chrext: (registers.getUint16(VcuRegister.CHRCTRL, true) & 1) !== 0,
        colen: (registers.getUint16(VcuRegister.COLCTRL, true) & 1) !== 0,
        pcen: (cxctrl & VCU_CXCTRL_PCEN) !== 0,
        wcen: (cxctrl & VCU_CXCTRL_WCEN) !== 0,
        bkren: (cxctrl & VCU_CXCTRL_BKREN) !== 0,
        ccen: (cxctrl & VCU_CXCTRL_CCEN) !== 0,
        cbkpal: registers.getUint16(VcuRegister.CBKPAL, true) & 0xff,
    };
}

function publicVbc(vb: VbMachine, vbc: VbcState): VbVbcState {
    const cram = vb.read(VCU_CRAM_BASE, VCU_CRAM_BYTES);
    const color = (entry: number): string =>
        `#${[0, 1, 2].map(channel => cram[entry * 4 + channel].toString(16).padStart(2, '0')).join('')}`;
    return {
        chrext: vbc.chrext,
        colen: vbc.colen,
        pcen: vbc.pcen,
        wcen: vbc.wcen,
        bkren: vbc.bkren,
        ccen: vbc.ccen,
        wramext: (vbc.registers.getUint16(VcuRegister.MEMCTRL, true) & 1) !== 0,
        cbkpal: vbc.cbkpal,
        cram: Array.from({ length: 256 }, (unused, palette) => [0, 1, 2, 3].map(shade => color(palette * 4 + shade))),
    };
}

function vcuColors(vb: VbMachine, vbc: VbcState, parts: VcuColorParts): VcuColors {
    return VcuColors.readSync((address, length) => vb.read(address, length), vbc, parts);
}

function poolRegion(vb: VbMachine): { layout: NonNullable<ReturnType<typeof parseMemoryPoolLayout>>, region: Uint8Array } | undefined {
    const pool = vb.symbols?.index.memoryPool;
    if (!pool) {
        return undefined;
    }
    const region = vb.read(pool.address, pool.size);
    const layout = parseMemoryPoolLayout(pool.address, region);
    return layout ? { layout, region } : undefined;
}

// the struct an instance is laid out by: its class's, or the nearest base's that fits the block
function layoutFor(structs: Map<string, VesStruct>, ancestry: string[], available: number): VesStruct | undefined {
    for (const name of ancestry) {
        const struct = structs.get(structNameOf(name));
        if (struct && struct.byteSize <= available) {
            return struct;
        }
    }
    return undefined;
}

function readCString(vb: VbMachine, address: number): string | undefined {
    const bytes = vb.read(address, 64);
    const end = bytes.indexOf(0);
    if (end <= 0) {
        return undefined;
    }
    const text = String.fromCharCode(...bytes.subarray(0, end));
    return /^[\x20-\x7e]+$/.test(text) ? text : undefined;
}
