// the VIP's memory map and decoders for the structures in it, all pure. Addresses and bit layouts are from
// libgccvb's video.h, vip.h, bgmap.h, world.h and object.h (applications/electron/vb/libgccvb/source/)

import { VCU_CHAR_EXT_BASE } from './emulator-vcu-memory';

// two ping-ponged frame buffers per eye, each 384x224 at two bits per pixel. The values are already resolved
// brightness levels (see vipBrightnessLevels), not palette indices. Per vuengine-core's Config.h and FrameBuffers.c
// drawColorPixel, a column is 64 bytes (room for 256 rows) whatever the 224 rows used
export const VIP_FRAME_BUFFER_WIDTH = 384;
export const VIP_FRAME_BUFFER_HEIGHT = 224;
export const VIP_FRAME_BUFFER_BYTES_PER_COLUMN = 64;
export const VIP_FRAME_BUFFER_BYTES = VIP_FRAME_BUFFER_WIDTH * VIP_FRAME_BUFFER_BYTES_PER_COLUMN;
export const VIP_LEFT_FRAME_BUFFER_0 = 0x00000000;
export const VIP_LEFT_FRAME_BUFFER_1 = 0x00008000;
export const VIP_RIGHT_FRAME_BUFFER_0 = 0x00010000;
export const VIP_RIGHT_FRAME_BUFFER_1 = 0x00018000;

export type VipEye = 'left' | 'right';

export function vipFrameBufferAddress(eye: VipEye, index: number): number {
    return (eye === 'left' ? VIP_LEFT_FRAME_BUFFER_0 : VIP_RIGHT_FRAME_BUFFER_0) + index * 0x00008000;
}

export class VipFrameBuffer {

    constructor(protected readonly bytes: Uint8Array | undefined) { }

    // 0 when the buffer is missing
    pixel(x: number, y: number): number {
        if (!this.bytes) {
            return 0;
        }
        const offset = x * VIP_FRAME_BUFFER_BYTES_PER_COLUMN + (y >> 2);
        if (offset >= this.bytes.length) {
            return 0;
        }
        // four rows per byte, two bits each, lowest row low, like VipCharacters reads
        return (this.bytes[offset] >> ((y & 3) * 2)) & 3;
    }
}

// 512 characters each, not contiguous
export const VIP_CHAR_SEGMENTS = [0x00006000, 0x0000e000, 0x00016000, 0x0001e000];
export const VIP_CHARS_PER_SEGMENT = 512;
export const VIP_CHAR_COUNT = VIP_CHAR_SEGMENTS.length * VIP_CHARS_PER_SEGMENT;
export const VIP_CHAR_BYTES = 16;
export const VIP_CHAR_SIZE = 8;
export const VIP_CHAR_SEGMENT_BYTES = VIP_CHARS_PER_SEGMENT * VIP_CHAR_BYTES;
// VB Color's CHRCTRL.CHREXT adds segments 4-7 in the VCU's Character RAM Extension: characters 2048-4095
export const VIP_CHAR_SEGMENT_COUNT_EXTENDED = 8;
export const VIP_CHAR_COUNT_EXTENDED = VIP_CHAR_SEGMENT_COUNT_EXTENDED * VIP_CHARS_PER_SEGMENT;

export function vipCharSegmentCount(extended: boolean): number {
    return extended ? VIP_CHAR_SEGMENT_COUNT_EXTENDED : VIP_CHAR_SEGMENTS.length;
}

// 14 segments of 64x64 cells, two bytes per cell
export const VIP_BGMAP_BASE = 0x00020000;
export const VIP_BGMAP_BYTES = 0x2000;
export const VIP_BGMAP_COUNT = 14;
export const VIP_BGMAP_CELLS = 64;
// in pixels, which is what a world's source coordinates are in
export const VIP_BGMAP_SEGMENT_PIXELS = VIP_BGMAP_CELLS * VIP_CHAR_SIZE;

export const VIP_WORLD_BASE = 0x0003d800;
export const VIP_WORLD_BYTES = 0x20;
export const VIP_WORLD_COUNT = 32;
export const VIP_WORLD_BLOCK_BYTES = VIP_WORLD_COUNT * VIP_WORLD_BYTES;

export const VIP_OAM_BASE = 0x0003e000;
export const VIP_OBJECT_BYTES = 8;
export const VIP_OBJECT_COUNT = 1024;
export const VIP_OAM_BLOCK_BYTES = VIP_OBJECT_COUNT * VIP_OBJECT_BYTES;

export const VIP_REGISTER_BASE = 0x0005f800;
export const VIP_REGISTER_BLOCK_BYTES = 0x80;

// byte offsets from VIP_REGISTER_BASE; vip.h indexes a u16*, so its mnemonics are halfword indices
export enum VipRegister {
    INTPND = 0x00,
    INTENB = 0x02,
    INTCLR = 0x04,
    DPSTTS = 0x20,
    DPCTRL = 0x22,
    BRTA = 0x24,
    BRTB = 0x26,
    BRTC = 0x28,
    REST = 0x2a,
    FRMCYC = 0x2e,
    CTA = 0x30,
    XPSTTS = 0x40,
    XPCTRL = 0x42,
    VER = 0x44,
    SPT0 = 0x48,
    SPT1 = 0x4a,
    SPT2 = 0x4c,
    SPT3 = 0x4e,
    GPLT0 = 0x60,
    GPLT1 = 0x62,
    GPLT2 = 0x64,
    GPLT3 = 0x66,
    JPLT0 = 0x68,
    JPLT1 = 0x6a,
    JPLT2 = 0x6c,
    JPLT3 = 0x6e,
    BKCOL = 0x70,
}

// the VIP draws objects in four groups. SPTn holds the index (low ten bits) of group n's last object; a group
// starts one past where the group below ended, group 0 at object 0. Which group a world gets comes from the
// drawing order, see vipObjectGroupForWorld and the Worlds panel
export const VIP_OBJECT_GROUP_COUNT = 4;
export const VIP_OBJECT_GROUP_ENDS = [VipRegister.SPT0, VipRegister.SPT1, VipRegister.SPT2, VipRegister.SPT3];

// first and last object of a group, undefined when the registers leave it empty. Objects are drawn from the
// last index down, so a lower index lands on top
export function vipObjectGroupRange(
    registers: DataView, group: number
): { first: number, last: number } | undefined {
    const end = (index: number): number => registers.getUint16(VIP_OBJECT_GROUP_ENDS[index], true) & 0x03ff;
    const last = end(group);
    const first = group === 0 ? 0 : end(group - 1) + 1;
    return first <= last ? { first, last } : undefined;
}

// undefined for an object past the end of the last group, which the VIP never draws
export function vipObjectGroupOf(registers: DataView, index: number): number | undefined {
    for (let group = 0; group < VIP_OBJECT_GROUP_COUNT; group++) {
        const range = vipObjectGroupRange(registers, group);
        if (range && index >= range.first && index <= range.last) {
            return group;
        }
    }
    return undefined;
}

/**
 * A world's object group is not in its entry: the group pointer starts at 3 and steps down at every OBJECT world drawn,
 * so a world's group depends on what is above it. `worlds` is in drawing order, 31 first. Undefined for a world the VIP
 * never reaches, and past the fourth OBJECT world (no group left; not guessed).
 *
 * Measured against the core in tests/object-group-probe.mjs: an OBJECT world with both eye bits clear consumes no
 * group, one eye is enough. End stops the VIP at its world, which draws nothing and takes no group. Eye bits only
 * decide whether a world is drawn; which eye its objects land in is each object's JLON/JRON (see
 * forEachVipObjectPixel).
 */
export function vipObjectGroupForWorld(worlds: readonly VipWorld[], index: number): number | undefined {
    let group = VIP_OBJECT_GROUP_COUNT - 1;
    for (const world of worlds) {
        if (world.end) {
            return undefined;
        }
        if (world.index === index) {
            return group >= 0 ? group : undefined;
        }
        if (world.mode === VipWorldMode.OBJECT && (world.lon || world.ron)) {
            group--;
        }
    }
    return undefined;
}

export const VIP_BGMAP_PALETTES = [VipRegister.GPLT0, VipRegister.GPLT1, VipRegister.GPLT2, VipRegister.GPLT3];
export const VIP_OBJECT_PALETTES = [VipRegister.JPLT0, VipRegister.JPLT1, VipRegister.JPLT2, VipRegister.JPLT3];

// segments 4-7 are in the VCU's extension
export function vipCharSegmentAddress(segment: number): number {
    return segment < VIP_CHAR_SEGMENTS.length
        ? VIP_CHAR_SEGMENTS[segment]
        : VCU_CHAR_EXT_BASE + (segment - VIP_CHAR_SEGMENTS.length) * VIP_CHAR_SEGMENT_BYTES;
}

// VIP addresses are not fully decoded, so the four 0x2000-byte character tables also repeat contiguously from
// here (0x78000, 0x7A000, 0x7C000, 0x7E000), unlike their primary addresses 0x8000 apart
export const VIP_CHAR_MIRROR_BASE = 0x00078000;

export function vipCharMirrorAddress(segment: number): number {
    return VIP_CHAR_MIRROR_BASE + segment * VIP_CHAR_SEGMENT_BYTES;
}

export function vipBgMapAddress(segment: number): number {
    return VIP_BGMAP_BASE + segment * VIP_BGMAP_BYTES;
}

export function vipWorldAddress(index: number): number {
    return VIP_WORLD_BASE + index * VIP_WORLD_BYTES;
}

export function vipObjectAddress(index: number): number {
    return VIP_OAM_BASE + index * VIP_OBJECT_BYTES;
}

// for the H-bias and Affine tables: the param register is the offset into BGMap memory in halfwords
// (WORLD_PARAM in world.h stores (address - 0x20000) >> 1)
export function vipParamTableAddress(param: number): number {
    return VIP_BGMAP_BASE + param * 2;
}

// the four levels as intensities, as the display is monochrome. Level 3 is the sum of all three registers, which is why
// the engine config warns when bright red is not larger than medium plus dark
export function vipBrightnessLevels(brta: number, brtb: number, brtc: number): number[] {
    return [0, brta, brtb, brta + brtb + brtc].map(vipBrightnessLevel);
}

// a register is a repeat count (how long the LEDs stay lit) that the core maps onto a gamma-like curve, so previews
// must follow it or come out too dark. Fitted to tests/brightness-probe.mjs: 128 repeats = 250, gamma 1.6, exact at
// VB_LEVEL_STOPS, else within one step
export function vipBrightnessLevel(repeat: number): number {
    if (repeat <= 0) {
        return 0;
    }
    return Math.min(255, Math.round(VIP_BRIGHTNESS_FULL * (repeat / VIP_BRIGHTNESS_REPEATS) ** (1 / VIP_BRIGHTNESS_GAMMA)));
}

// repeats at which the display is fully lit, and what the core renders that as
const VIP_BRIGHTNESS_REPEATS = 128;
const VIP_BRIGHTNESS_FULL = 250;
const VIP_BRIGHTNESS_GAMMA = 1.6;

// pixel value 0 is always black (transparent): the hardware hardwires the register's low two bits to zero.
// Forced here so junk in those bits cannot show a shade the VIP never draws
export function vipPaletteIntensities(palette: number, levels: number[]): number[] {
    return [0, 1, 2, 3].map(value => (value === 0 ? levels[0] : levels[(palette >> (value * 2)) & 3]));
}

export function vipBrightnessLevelsFromRegisters(registers: DataView): number[] {
    return vipBrightnessLevels(
        registers.getUint16(VipRegister.BRTA, true) & 0xff,
        registers.getUint16(VipRegister.BRTB, true) & 0xff,
        registers.getUint16(VipRegister.BRTC, true) & 0xff
    );
}

export function vipIntensitiesForRegister(registers: DataView, register: VipRegister): number[] {
    const palette = registers.getUint16(register, true) & 0xff;
    return vipPaletteIntensities(palette, vipBrightnessLevelsFromRegisters(registers));
}

// shared by the Characters and BGMaps panels, which redraw their cached bitmap only when tiles or shading changed
export class VipIntensityWatcher {
    protected static readonly WATCHED = [
        VipRegister.BRTA, VipRegister.BRTB, VipRegister.BRTC,
        ...VIP_BGMAP_PALETTES, ...VIP_OBJECT_PALETTES,
    ];

    protected signature?: string;

    // true the first time, and whenever a watched register changes
    changed(registers: DataView): boolean {
        const signature = VipIntensityWatcher.WATCHED.map(offset => registers.getUint16(offset, true)).join(',');
        const changed = signature !== this.signature;
        this.signature = signature;
        return changed;
    }
}

// for the panels that rasterize VRAM, which read up to 40 KB a time
export const VIP_GRAPHICS_POLL_HZ = 4;

// not a hardware register: an even black/dark/medium/bright ramp, to look at tile data independent of the
// program's palette registers. Shared by the Characters and BGMaps panels
export const VIP_GENERIC_PALETTE_INTENSITIES = [0, 85, 170, 255];

// four segments, or eight with VB Color's extension. An unread segment counts as blank, so a view can render
// what it has while the rest is still in flight
export class VipCharacters {

    constructor(protected readonly segments: ReadonlyArray<Uint8Array | undefined>) { }

    // twelve bits when handed the extension's segments too
    get charMask(): number {
        return this.segments.length > VIP_CHAR_SEGMENTS.length ? 0x0fff : 0x07ff;
    }

    // 0 when its segment is missing
    pixel(char: number, x: number, y: number): number {
        const segment = this.segments[(char >> 9) & 7];
        if (!segment) {
            return 0;
        }
        const offset = (char & (VIP_CHARS_PER_SEGMENT - 1)) * VIP_CHAR_BYTES + y * 2;
        if (offset + 1 >= segment.length) {
            return 0;
        }
        // rows are little-endian halfwords, two bits per pixel, leftmost low
        const row = segment[offset] | (segment[offset + 1] << 8);
        return (row >> (x * 2)) & 3;
    }
}

export interface VipBgMapCell {
    char: number;
    palette: number;
    hFlip: boolean;
    vFlip: boolean;
}

// per bgmap.h: BGM_HFLIP 0x2000, BGM_VFLIP 0x1000, character mask 0x7FF (0xFFF on a VB Color with CHREXT,
// see vbcCharMask)
export function decodeVipBgMapCell(cell: number, charMask = 0x07ff): VipBgMapCell {
    return {
        char: cell & charMask,
        palette: (cell >> 14) & 3,
        hFlip: (cell & 0x2000) !== 0,
        vFlip: (cell & 0x1000) !== 0,
    };
}

// for writing an edited cell back. Bit 11 is neither the 11-bit character index nor a flip/palette bit, so it is
// written as zero rather than preserved; with CHREXT's twelve-bit mask it is the character's top bit
export function encodeVipBgMapCell(cell: VipBgMapCell, charMask = 0x07ff): number {
    return (cell.char & charMask)
        | ((cell.palette & 3) << 14)
        | (cell.hFlip ? 0x2000 : 0)
        | (cell.vFlip ? 0x1000 : 0);
}

export enum VipWorldMode {
    BGMAP = 0,
    HBIAS = 1,
    AFFINE = 2,
    OBJECT = 3,
}

export const VIP_WORLD_MODE_NAMES: Record<VipWorldMode, string> = {
    [VipWorldMode.BGMAP]: 'BGMap',
    [VipWorldMode.HBIAS]: 'HBias',
    [VipWorldMode.AFFINE]: 'Affine',
    [VipWorldMode.OBJECT]: 'Object',
};

export interface VipWorld {
    index: number;
    head: number;
    lon: boolean;
    ron: boolean;
    mode: VipWorldMode;
    // segments across and down, as a count rather than the exponent
    scx: number;
    scy: number;
    // draw the overplane outside the map instead of repeating it
    overplane: boolean;
    end: boolean;
    bgMap: number;
    gx: number;
    gp: number;
    gy: number;
    mx: number;
    mp: number;
    my: number;
    // register values, which the hardware reads as size minus one
    w: number;
    h: number;
    param: number;
    // OVR: index into BGMap memory of the cell drawn outside the map (segment in bits 15-12, cell in 11-0), not the
    // cell itself; the core takes it the same way (&sim->vip.cells[value])
    overplaneIndex: number;
}

function signed16(value: number): number {
    return (value << 16) >> 16;
}

// bit layout per world.h
export function decodeVipWorld(view: DataView, index: number, byteOffset = 0): VipWorld {
    const at = (halfword: number): number => view.getUint16(byteOffset + halfword * 2, true);
    const head = at(0);
    return {
        index,
        head,
        lon: (head & 0x8000) !== 0,
        ron: (head & 0x4000) !== 0,
        mode: ((head >> 12) & 3) as VipWorldMode,
        scx: 1 << ((head >> 10) & 3),
        scy: 1 << ((head >> 8) & 3),
        overplane: (head & 0x0080) !== 0,
        end: (head & 0x0040) !== 0,
        bgMap: head & 0x000f,
        gx: signed16(at(1)),
        gp: signed16(at(2)),
        gy: signed16(at(3)),
        mx: signed16(at(4)),
        mp: signed16(at(5)),
        my: signed16(at(6)),
        w: at(7),
        h: at(8),
        param: at(9),
        overplaneIndex: at(10),
    };
}

// halfword of each field in a world entry, in world.h's WORLD order; all head bits share index 0
// and go through encodeVipWorldHead
export enum VipWorldField {
    HEAD = 0,
    GX = 1,
    GP = 2,
    GY = 3,
    MX = 4,
    MP = 5,
    MY = 6,
    W = 7,
    H = 8,
    PARAM = 9,
    OVERPLANE_INDEX = 10,
}

// for writing an edited world back. Bits 5 and 4 are none of the fields world.h documents, so they are written
// as zero rather than preserved
export function encodeVipWorldHead(world: VipWorld): number {
    return (world.lon ? 0x8000 : 0)
        | (world.ron ? 0x4000 : 0)
        | ((world.mode & 3) << 12)
        | (Math.log2(world.scx) << 10)
        | (Math.log2(world.scy) << 8)
        | (world.overplane ? 0x0080 : 0)
        | (world.end ? 0x0040 : 0)
        | (world.bgMap & 0x000f);
}

// one entry per screen row of the world, starting at vipParamTableAddress. Sizes as the engine allocates them in
// ParamTableManager::calculateSpriteParamTableSize
export const VIP_HBIAS_ENTRY_BYTES = 4;
export const VIP_AFFINE_ENTRY_BYTES = 16;

export interface VipHBiasEntry {
    // horizontal shift of this row's source, per eye
    left: number;
    right: number;
}

export function decodeVipHBias(view: DataView, row: number): VipHBiasEntry {
    const offset = row * VIP_HBIAS_ENTRY_BYTES;
    return {
        left: view.getInt16(offset, true),
        right: view.getInt16(offset + 2, true),
    };
}

// undefined when the table was not read that far
export function vipHBiasRow(params: DataView | undefined, row: number): VipHBiasEntry | undefined {
    return params && (row + 1) * VIP_HBIAS_ENTRY_BYTES <= params.byteLength ? decodeVipHBias(params, row) : undefined;
}

// formats and the 16-byte stride per affine.c
export interface VipAffineEntry {
    mx: number; // 13.3 fixed point, replaces the world's MX for this row
    mp: number;
    my: number; // 13.3 fixed point, replaces the world's MY for this row
    dx: number; // 7.9 fixed point step of the source along the row, which is what rotates and scales
    dy: number; // 7.9 fixed point, like dx
}

export function decodeVipAffine(view: DataView, row: number): VipAffineEntry {
    const offset = row * VIP_AFFINE_ENTRY_BYTES;
    return {
        mx: view.getInt16(offset, true),
        mp: view.getInt16(offset + 2, true),
        my: view.getInt16(offset + 4, true),
        dx: view.getInt16(offset + 6, true),
        dy: view.getInt16(offset + 8, true),
    };
}

export function vipAffineRow(params: DataView | undefined, row: number): VipAffineEntry | undefined {
    return params && (row + 1) * VIP_AFFINE_ENTRY_BYTES <= params.byteLength ? decodeVipAffine(params, row) : undefined;
}

// one per row of the world, capped at what a screen shows; zero for modes without a param table
export function vipParamRows(world: VipWorld): number {
    return world.mode === VipWorldMode.HBIAS || world.mode === VipWorldMode.AFFINE
        ? Math.min(world.h + 1, VIP_FRAME_BUFFER_HEIGHT)
        : 0;
}

// in bytes, clamped to the end of BGMap memory
export function vipParamTableBytes(world: VipWorld): number {
    const entryBytes = world.mode === VipWorldMode.AFFINE ? VIP_AFFINE_ENTRY_BYTES : VIP_HBIAS_ENTRY_BYTES;
    const available = VIP_BGMAP_BASE + VIP_BGMAP_COUNT * VIP_BGMAP_BYTES - vipParamTableAddress(world.param);
    return Math.max(0, Math.min(vipParamRows(world) * entryBytes, available));
}

// in drawing order: from world 31 down to the first with END, which is not drawn either (that dummy terminator
// marks where a program's sprites end). Worlds shown to neither eye are dropped too
export function vipDrawnWorlds(worlds: ReadonlyArray<VipWorld>): VipWorld[] {
    const drawn: VipWorld[] = [];
    for (let index = VIP_WORLD_COUNT - 1; index >= 0; index--) {
        const world = worlds.find(candidate => candidate.index === index);
        if (!world || world.end) {
            break;
        }
        if (world.lon || world.ron) {
            drawn.push(world);
        }
    }
    return drawn;
}

// in layout order, left to right and top to bottom from the base segment. Only the low four bits reach the
// hardware, so the run wraps and a segment can appear twice; dedupe where a count per segment is wanted
export function vipWorldSegments(world: VipWorld): number[] {
    const segments: number[] = [];
    for (let y = 0; y < world.scy; y++) {
        for (let x = 0; x < world.scx; x++) {
            segments.push((world.bgMap + y * world.scx + x) & 0x0f);
        }
    }
    // the overplane cell can sit in a segment the map does not span, and is read from there all the same
    if (world.overplane && !segments.includes(vipOverplaneSegment(world))) {
        segments.push(vipOverplaneSegment(world));
    }
    return segments;
}

export function vipOverplaneSegment(world: VipWorld): number {
    return (world.overplaneIndex >> 12) & 0x0f;
}

export function vipWorldMapSegment(world: VipWorld, cellX: number, cellY: number): number {
    return (world.bgMap
        + (cellY / VIP_BGMAP_CELLS | 0) * world.scx
        + (cellX / VIP_BGMAP_CELLS | 0)) & 0x0f;
}

export interface VipBgMapSegmentUse {
    // worlds whose map spans this segment
    worlds: number[];
    // worlds whose param table overlaps it
    params: number[];
}

// only drawn worlds count: unused entries are all zeroes, which read as 1x1 BGMap worlds on segment 0. Param
// tables count too, as an H-bias or Affine table takes space out of the BGMap segments it lies in
export function vipBgMapSegmentUses(worlds: ReadonlyArray<VipWorld>): VipBgMapSegmentUse[] {
    const uses: VipBgMapSegmentUse[] = Array.from({ length: VIP_BGMAP_COUNT }, () => ({ worlds: [], params: [] }));

    for (const world of vipDrawnWorlds(worlds)) {
        if (world.mode !== VipWorldMode.OBJECT) {
            const count = Math.min(world.scx * world.scy, VIP_BGMAP_COUNT);
            for (let offset = 0; offset < count; offset++) {
                // only the low four bits of a segment number reach the hardware
                uses[(world.bgMap + offset) & 0x0f]?.worlds.push(world.index);
            }
            const overplane = uses[vipOverplaneSegment(world)];
            if (world.overplane && overplane && !overplane.worlds.includes(world.index)) {
                overplane.worlds.push(world.index);
            }
        }

        const bytes = vipParamTableBytes(world);
        if (bytes > 0) {
            const first = vipParamTableAddress(world.param);
            for (let address = first; address < first + bytes; address += VIP_BGMAP_BYTES) {
                uses[(address - VIP_BGMAP_BASE) / VIP_BGMAP_BYTES | 0]?.params.push(world.index);
            }
            // a table ending exactly on a boundary has already been counted; one ending inside a later segment has not
            const last = (first + bytes - 1 - VIP_BGMAP_BASE) / VIP_BGMAP_BYTES | 0;
            if (!uses[last]?.params.includes(world.index)) {
                uses[last]?.params.push(world.index);
            }
        }
    }
    return uses;
}

export interface VipObject {
    index: number;
    // signed 10-bit screen position
    jx: number;
    // signed 14-bit parallax
    jp: number;
    // eight-bit screen position
    jy: number;
    char: number;
    palette: number;
    hFlip: boolean;
    vFlip: boolean;
    lon: boolean;
    ron: boolean;
}

export function isVipObjectVisible(object: VipObject): boolean {
    return object.lon || object.ron;
}

// bit layout per object.h
export function decodeVipObject(view: DataView, index: number, byteOffset = 0, charMask = 0x07ff): VipObject {
    const at = (halfword: number): number => view.getUint16(byteOffset + halfword * 2, true);
    const parallax = at(1);
    const character = at(3);
    return {
        index,
        // sign-extend from bit 9 and bit 13 respectively
        jx: (at(0) << 22) >> 22,
        jp: ((parallax & 0x3fff) << 18) >> 18,
        jy: at(2) & 0xff,
        char: character & charMask,
        palette: (character >> 14) & 3,
        hFlip: (character & 0x2000) !== 0,
        vFlip: (character & 0x1000) !== 0,
        lon: (parallax & 0x8000) !== 0,
        ron: (parallax & 0x4000) !== 0,
    };
}

// the entry's four halfwords, for writing an edited object back. Spare bits (top six of JX, top eight of JY,
// bit 11 of the character halfword) are written as zero rather than preserved, like encodeVipBgMapCell
export function encodeVipObject(object: VipObject, charMask = 0x07ff): number[] {
    return [
        object.jx & 0x03ff,
        (object.jp & 0x3fff) | (object.lon ? 0x8000 : 0) | (object.ron ? 0x4000 : 0),
        object.jy & 0x00ff,
        (object.char & charMask)
            | ((object.palette & 3) << 14)
            | (object.hFlip ? 0x2000 : 0)
            | (object.vFlip ? 0x1000 : 0),
    ];
}

// how often BGMap cells and objects the VIP draws reference each character: which part of the atlas is in use,
// and where one character is used. Only what is drawn counts: OAM's parked entries point at character 0 and would
// make it the busiest, and a segment no world reads holds whatever the last scene left there
export class VipCharacterUsage {

    // indexed segment * VIP_CHAR_COUNT_EXTENDED + char
    protected readonly cells = new Uint16Array(VIP_BGMAP_COUNT * VIP_CHAR_COUNT_EXTENDED);
    protected readonly objects = new Uint16Array(VIP_CHAR_COUNT_EXTENDED);
    protected readonly totals = new Uint32Array(VIP_CHAR_COUNT_EXTENDED);

    // how many bits of a cell name its character, see vbcCharMask
    constructor(protected readonly charMask = 0x07ff) { }

    // `bytes` is one segment. Cells are counted either way, as a segment nothing reads still says which characters
    // it was built from, but only a drawn one makes a character count as in use
    addBgMapSegment(segment: number, bytes: Uint8Array, drawn = true): void {
        const base = segment * VIP_CHAR_COUNT_EXTENDED;
        for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
            // the character is the low eleven bits (twelve with CHREXT); palette and flip do not change the reference
            const char = (bytes[offset] | (bytes[offset + 1] << 8)) & this.charMask;
            this.cells[base + char]++;
            if (drawn) {
                this.totals[char]++;
            }
        }
    }

    // skipping the ones drawn to neither eye
    addObjects(bytes: Uint8Array): void {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const count = Math.min(VIP_OBJECT_COUNT, Math.floor(bytes.length / VIP_OBJECT_BYTES));
        for (let index = 0; index < count; index++) {
            const object = decodeVipObject(view, index, index * VIP_OBJECT_BYTES, this.charMask);
            if (isVipObjectVisible(object)) {
                this.objects[object.char]++;
                this.totals[object.char]++;
            }
        }
    }

    used(char: number): boolean {
        return this.totals[char] > 0;
    }

    objectCount(char: number): number {
        return this.objects[char];
    }

    bgMapCounts(char: number): { segment: number, cells: number }[] {
        const found: { segment: number, cells: number }[] = [];
        for (let segment = 0; segment < VIP_BGMAP_COUNT; segment++) {
            const cells = this.cells[segment * VIP_CHAR_COUNT_EXTENDED + char];
            if (cells > 0) {
                found.push({ segment, cells });
            }
        }
        return found;
    }
}

// indices are within the segment. Assumes reads of equal length: a short one would report characters as
// changed because they were not read
export function vipChangedCharacters(bytes: Uint8Array, previous: Uint8Array): number[] {
    const changed: number[] = [];
    const count = Math.min(bytes.length, previous.length) / VIP_CHAR_BYTES | 0;
    for (let char = 0; char < count; char++) {
        const start = char * VIP_CHAR_BYTES;
        for (let offset = start; offset < start + VIP_CHAR_BYTES; offset++) {
            if (bytes[offset] !== previous[offset]) {
                changed.push(char);
                break;
            }
        }
    }
    return changed;
}

export function vipCharacterUsage(
    // indexed by segment and sparse on purpose: callers read only what drawn worlds map from (see
    // vipBgMapSegmentUses), as all fourteen each poll is ~100 KB of reads for nothing, and a segment nothing reads
    // is no evidence that a character is in use
    bgMapSegments: ReadonlyArray<Uint8Array | undefined>,
    oam: Uint8Array | undefined,
    drawnSegments?: ReadonlyArray<boolean>,
    charMask = 0x07ff
): VipCharacterUsage {
    const usage = new VipCharacterUsage(charMask);
    bgMapSegments.forEach((bytes, segment) => {
        if (bytes && segment < VIP_BGMAP_COUNT) {
            // every segment counts as drawn unless the caller says which are; a caller reading only the segments in use
            // has made that distinction by leaving the rest out
            usage.addBgMapSegment(segment, bytes, drawnSegments ? !!drawnSegments[segment] : true);
        }
    });
    if (oam) {
        usage.addObjects(oam);
    }
    return usage;
}

export function drawVipChar(
    target: Uint8ClampedArray,
    targetWidth: number,
    destX: number,
    destY: number,
    characters: VipCharacters,
    char: number,
    intensities: number[],
    hFlip = false,
    vFlip = false,
    transparentZero = false
): void {
    for (let y = 0; y < VIP_CHAR_SIZE; y++) {
        for (let x = 0; x < VIP_CHAR_SIZE; x++) {
            const value = characters.pixel(
                char,
                hFlip ? VIP_CHAR_SIZE - 1 - x : x,
                vFlip ? VIP_CHAR_SIZE - 1 - y : y
            );
            const offset = ((destY + y) * targetWidth + destX + x) * 4;
            if (value === 0 && transparentZero) {
                target[offset] = 0;
                target[offset + 1] = 0;
                target[offset + 2] = 0;
                target[offset + 3] = 0;
                continue;
            }
            const intensity = intensities[value];
            // red, because that is the color the hardware emits
            target[offset] = intensity;
            target[offset + 1] = 0;
            target[offset + 2] = 0;
            target[offset + 3] = 255;
        }
    }
}

// where one source pixel of a world comes from, for drawing it in VB Color: the cell (the overplane's included)
// and the pixel in the character's own unflipped coordinates, as a Pixel Color Slot is laid out. Reused between calls
export interface VipWorldSample {
    // for the overplane, the segment its cell is in
    segment: number;
    // within that segment, 0-4095
    cell: number;
    char: number;
    // the cell's GPLTS
    palette: number;
    value: number;
    charX: number;
    charY: number;
}

export function vipWorldSample(): VipWorldSample {
    return { segment: 0, cell: 0, char: 0, palette: 0, value: 0, charX: 0, charY: 0 };
}

/**
 * A world's source coordinates address a virtual map of scx by scy segments, left to right and top to bottom from its
 * base segment. Outside it they wrap (which makes a 1x1 world a tiling background), or with the overplane flag read the
 * cell OVR indexes, whose segment must be handed over too (see vipWorldSegments). Segments are indexed by absolute
 * BGMap segment number, so a caller only reads those the world spans; a missing one reads as blank, as in
 * VipCharacters.
 */
export class VipWorldMap {

    protected readonly width: number;
    protected readonly height: number;

    constructor(
        protected readonly world: VipWorld,
        protected readonly segments: ReadonlyArray<Uint8Array | undefined>,
        protected readonly characters: VipCharacters
    ) {
        this.width = world.scx * VIP_BGMAP_SEGMENT_PIXELS;
        this.height = world.scy * VIP_BGMAP_SEGMENT_PIXELS;
    }

    // gray level of one source pixel, given one intensity ramp per palette; an intensity rather than a palette
    // index, so rasterizing a whole world does not allocate per pixel
    intensity(x: number, y: number, palettes: number[][]): number {
        const outside = x < 0 || y < 0 || x >= this.width || y >= this.height;
        // both dimensions are powers of two, so masking is the hardware's wrap, and unlike % also correct for the
        // negative coordinates of a world scrolled past its origin
        const wx = x & (this.width - 1);
        const wy = y & (this.height - 1);
        const cell = decodeVipBgMapCell(
            this.world.overplane && outside ? this.overplaneCell() : this.cellAt(wx, wy),
            this.characters.charMask
        );
        const value = this.characters.pixel(
            cell.char,
            cell.hFlip ? VIP_CHAR_SIZE - 1 - (x & 7) : x & 7,
            cell.vFlip ? VIP_CHAR_SIZE - 1 - (y & 7) : y & 7
        );
        return palettes[cell.palette][value];
    }

    // the same lookup as intensity, stopping before the palette and writing where everything came from into `into`
    sample(x: number, y: number, into: VipWorldSample): VipWorldSample {
        const outside = x < 0 || y < 0 || x >= this.width || y >= this.height;
        const wx = x & (this.width - 1);
        const wy = y & (this.height - 1);
        let raw: number;
        if (this.world.overplane && outside) {
            raw = this.overplaneCell();
            into.segment = vipOverplaneSegment(this.world);
            into.cell = this.world.overplaneIndex & (VIP_BGMAP_CELLS * VIP_BGMAP_CELLS - 1);
        } else {
            raw = this.cellAt(wx, wy);
            into.segment = this.segmentAt(wx, wy);
            into.cell = ((wy >> 3) & (VIP_BGMAP_CELLS - 1)) * VIP_BGMAP_CELLS + ((wx >> 3) & (VIP_BGMAP_CELLS - 1));
        }
        const cell = decodeVipBgMapCell(raw, this.characters.charMask);
        into.char = cell.char;
        into.palette = cell.palette;
        into.charX = cell.hFlip ? VIP_CHAR_SIZE - 1 - (x & 7) : x & 7;
        into.charY = cell.vFlip ? VIP_CHAR_SIZE - 1 - (y & 7) : y & 7;
        into.value = this.characters.pixel(cell.char, into.charX, into.charY);
        return into;
    }

    // the same lookup as intensity, stopping one step earlier: a view marking every pixel drawn from a character
    // needs the cell's character, not its shade
    char(x: number, y: number): number {
        const outside = x < 0 || y < 0 || x >= this.width || y >= this.height;
        return decodeVipBgMapCell(
            this.world.overplane && outside
                ? this.overplaneCell()
                : this.cellAt(x & (this.width - 1), y & (this.height - 1)),
            this.characters.charMask
        ).char;
    }

    // the same lookup as intensity, stopping before the cell: a view marking what comes from one segment needs
    // where the pixel was read, not what was there
    segmentAt(x: number, y: number): number {
        const wx = x & (this.width - 1);
        const wy = y & (this.height - 1);
        return (this.world.bgMap
            + (wy / VIP_BGMAP_SEGMENT_PIXELS | 0) * this.world.scx
            + (wx / VIP_BGMAP_SEGMENT_PIXELS | 0)) & 0x0f;
    }

    // raw halfword of the cell OVR indexes, 0 if its segment is unread
    protected overplaneCell(): number {
        const bytes = this.segments[vipOverplaneSegment(this.world)];
        const offset = (this.world.overplaneIndex & (VIP_BGMAP_CELLS * VIP_BGMAP_CELLS - 1)) * 2;
        return bytes && offset + 1 < bytes.length ? bytes[offset] | (bytes[offset + 1] << 8) : 0;
    }

    // raw cell halfword covering a wrapped source pixel, 0 if unread
    protected cellAt(wx: number, wy: number): number {
        // only the low four bits of a segment number reach the hardware, so a world running off the end of BGMap
        // memory wraps around rather than reading somewhere else
        const segment = (this.world.bgMap
            + (wy / VIP_BGMAP_SEGMENT_PIXELS | 0) * this.world.scx
            + (wx / VIP_BGMAP_SEGMENT_PIXELS | 0)) & 0x0f;
        const bytes = this.segments[segment];
        if (!bytes) {
            return 0;
        }
        const offset = (((wy >> 3) & (VIP_BGMAP_CELLS - 1)) * VIP_BGMAP_CELLS
            + ((wx >> 3) & (VIP_BGMAP_CELLS - 1))) * 2;
        return offset + 1 < bytes.length ? bytes[offset] | (bytes[offset + 1] << 8) : 0;
    }
}

// W and H are size minus one; the left eye is shifted by the parallax to the left of GX, the right eye to the right
export function vipWorldExtents(world: VipWorld, eye: VipEye): { x: number, y: number, width: number, height: number } {
    return {
        x: world.gx + (eye === 'left' ? -world.gp : world.gp),
        y: world.gy,
        width: world.w + 1,
        height: world.h + 1,
    };
}

// its one character, shifted by the parallax the same way a world's position is
export function vipObjectExtents(object: VipObject, eye: VipEye): { x: number, y: number, width: number, height: number } {
    return {
        x: object.jx + (eye === 'left' ? -object.jp : object.jp),
        y: object.jy,
        width: VIP_CHAR_SIZE,
        height: VIP_CHAR_SIZE,
    };
}

// in that segment's own pixels, undefined for a segment the world's map does not cover. The rectangle may reach
// past the segment's edges, so a view drawing it has to clip. Parallax is left out: MP moves the read area by an
// eye's worth of pixels, and a segment is looked at without an eye
export function vipWorldSourceExtents(
    world: VipWorld, segment: number
): { x: number, y: number, width: number, height: number } | undefined {
    if (world.mode === VipWorldMode.OBJECT) {
        return undefined;
    }
    for (let row = 0; row < world.scy; row++) {
        for (let column = 0; column < world.scx; column++) {
            // only the low four bits reach the hardware, as everywhere a segment number is worked out
            if (((world.bgMap + row * world.scx + column) & 0x0f) !== segment) {
                continue;
            }
            return {
                x: world.mx - column * VIP_BGMAP_SEGMENT_PIXELS,
                y: world.my - row * VIP_BGMAP_SEGMENT_PIXELS,
                width: world.w + 1,
                height: world.h + 1,
            };
        }
    }
    return undefined;
}

// applies everything that decides where a pixel comes from: size (W/H are size minus one, so bounds are
// inclusive), position, parallax and the H-bias/Affine per-row source origin. Pixels off the target are skipped,
// not wrapped. Object worlds draw nothing here, their sprites come from OAM
export function forEachVipWorldPixel(
    world: VipWorld,
    targetWidth: number,
    targetHeight: number,
    eye: VipEye,
    params: DataView | undefined,
    visit: (destX: number, destY: number, sourceX: number, sourceY: number) => void
): void {
    if (world.mode === VipWorldMode.OBJECT) {
        return;
    }

    // the left eye is drawn parallax to the left of the world's position, the right eye to the right, source and
    // destination alike
    const sign = eye === 'left' ? -1 : 1;
    const destX = vipWorldExtents(world, eye).x;

    // clipping up front keeps a garbage size from turning into 65536 iterations that draw nothing
    const firstRow = Math.max(0, -world.gy);
    const lastRow = Math.min(world.h, targetHeight - 1 - world.gy);
    const firstColumn = Math.max(0, -destX);
    const lastColumn = Math.min(world.w, targetWidth - 1 - destX);

    for (let row = firstRow; row <= lastRow; row++) {
        const affine = world.mode === VipWorldMode.AFFINE ? vipAffineRow(params, row) : undefined;
        const hbias = world.mode === VipWorldMode.HBIAS ? vipHBiasRow(params, row) : undefined;
        const shift = hbias ? (eye === 'left' ? hbias.left : hbias.right) : 0;
        const sourceX = world.mx + sign * world.mp + shift;
        const sourceY = world.my + row;

        for (let column = firstColumn; column <= lastColumn; column++) {
            let x = sourceX + column;
            let y = sourceY;
            if (affine) {
                // own source origin in 13.3 fixed point, steps in 7.9: the step is shifted down by six, then the sum
                // by three to whole pixels (as affine.c documents). Parallax is treated like a BGMap world's, which
                // only approximates what the hardware does with that field
                x = (affine.mx + sign * affine.mp + ((affine.dx * column) >> 6)) >> 3;
                y = (affine.my + ((affine.dy * column) >> 6)) >> 3;
            }
            visit(destX + column, world.gy + row, x, y);
        }
    }
}

// the world's own contribution, not a composited frame: value 0 is painted black, so what shows is exactly the
// area it covers
export function drawVipWorld(
    target: Uint8ClampedArray,
    targetWidth: number,
    targetHeight: number,
    world: VipWorld,
    map: VipWorldMap,
    palettes: number[][],
    eye: VipEye,
    params?: DataView
): void {
    forEachVipWorldPixel(world, targetWidth, targetHeight, eye, params, (destX, destY, x, y) => {
        const offset = (destY * targetWidth + destX) * 4;
        target[offset] = map.intensity(x, y, palettes);
        target[offset + 3] = 255;
    });
}

// counterpart of forEachVipWorldPixel: a view compositing objects decides itself what a value means (whether 0
// is a hole to leave alone, whether this is the object being looked at), which a shade-writing routine cannot
export function forEachVipObjectPixel(
    object: VipObject,
    targetWidth: number,
    targetHeight: number,
    characters: VipCharacters,
    eye: VipEye,
    visit: (destX: number, destY: number, value: number) => void
): void {
    // the left eye is drawn parallax to the left of the object's position, the right eye to the right;
    // see vipObjectExtents
    const destX = vipObjectExtents(object, eye).x;
    for (let row = 0; row < VIP_CHAR_SIZE; row++) {
        const y = object.jy + row;
        if (y < 0 || y >= targetHeight) {
            continue;
        }
        for (let column = 0; column < VIP_CHAR_SIZE; column++) {
            const x = destX + column;
            if (x < 0 || x >= targetWidth) {
                continue;
            }
            visit(x, y, characters.pixel(
                object.char,
                object.hFlip ? VIP_CHAR_SIZE - 1 - column : column,
                object.vFlip ? VIP_CHAR_SIZE - 1 - row : row
            ));
        }
    }
}

export function drawVipObject(
    target: Uint8ClampedArray,
    targetWidth: number,
    targetHeight: number,
    object: VipObject,
    characters: VipCharacters,
    intensities: number[],
    eye: VipEye
): void {
    forEachVipObjectPixel(object, targetWidth, targetHeight, characters, eye, (x, y, value) => {
        const offset = (y * targetWidth + x) * 4;
        target[offset] = intensities[value];
        target[offset + 3] = 255;
    });
}

// absent counts as different
export function sameVipBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
    if (!a || !b || a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
