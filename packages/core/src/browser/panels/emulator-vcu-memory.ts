import type { Sim } from '../core/vb-core';
import type { DebugSource } from './emulator-panel';

// VB Color VCU aperture and its memory-mapped control block
export const VCU_MEMORY_BASE = 0x03000000;
// the VCU decodes 1 MiB, mirrored across the rest of region 3
export const VCU_APERTURE_BYTES = 0x100000;
// 256 palettes of four RGB888 colors (32-bit entries, red in the low byte), shared by BG cells and OBJs
export const VCU_CRAM_BASE = 0x03079000;
export const VCU_CRAM_COLORS = 1024;
export const VCU_CRAM_ENTRY_BYTES = 4;
export const VCU_CRAM_BYTES = VCU_CRAM_COLORS * VCU_CRAM_ENTRY_BYTES;
export const VCU_REGISTER_BASE = 0x0307f800;
// VBC 1.0 reserves 0x0307F800-0x0307F8FF (see VBC_STATUS.md) but documents only the first 44 bytes as registers;
// reading the whole block lets the panel show the unnamed rest too
export const VCU_REGISTER_BLOCK_BYTES = 0x100;
export const VCU_NAMED_REGISTER_BYTES = 0x2c;

// Cell Color Attribute RAM: one byte per BGMap cell, in BGMap order. Bits 5-0 pick the palette group (CRAM palette
// = group * 4 + GPLTS), bit 7 (CHRSEL) hands palette and pixel attribute to its Character's entries while
// CXCTRL.CCEN is set
export const VCU_CELL_COLOR_BASE = 0x03060000;
export const VCU_CELL_COLOR_BYTES = 0x10000;
// OBJ Color Attribute RAM: the same byte, one per object
export const VCU_OBJ_COLOR_BASE = 0x03070000;
export const VCU_OBJ_COLOR_BYTES = 0x400;
// Character RAM Extension: Characters 2048-4095, 16 bytes each, as four more segments of 512, reachable while
// CHRCTRL.CHREXT widens the character field to twelve bits
export const VCU_CHAR_EXT_BASE = 0x03071000;
export const VCU_CHAR_EXT_BYTES = 0x8000;

// Cell Pixel Color Attribute RAM: one halfword per BG-map cell (PCE, OPQ, SLOT)
export const VCU_CELL_PIXEL_ATTR_BASE = 0x03080000;
export const VCU_CELL_PIXEL_ATTR_BYTES = 0x20000;
// OBJ Pixel Color Attribute RAM: one halfword per object
export const VCU_OBJ_PIXEL_ATTR_BASE = 0x030a0000;
export const VCU_OBJ_PIXEL_ATTR_BYTES = 0x800;
// World Color Attribute RAM: one halfword per World, bits 7-0 the palette offset
export const VCU_WORLD_ATTR_BASE = 0x030a0800;
export const VCU_WORLD_ATTR_BYTES = 0x40;
// Backdrop Row Table: four RGB888 colors (one per shade, 32-bit entries) per frame-buffer row, shown where the
// Color Frame Buffer holds the Backdrop Marker 0xFF
export const VCU_BACKDROP_ROW_BASE = 0x030a1000;
export const VCU_BACKDROP_ROW_BYTES = 0x1000;
// Character Color Attribute RAM: per Character a Cell palette byte and an OBJ palette byte, used by placements
// whose Color Attribute carries CHRSEL (bit 7) while CXCTRL.CCEN is set
export const VCU_CHARACTER_COLOR_BASE = 0x030a2000;
export const VCU_CHARACTER_COLOR_BYTES = 0x2000;
// Character Pixel Color Attribute RAM: one Pixel Color Attribute halfword per Character, for the same placements
export const VCU_CHARACTER_PIXEL_ATTR_BASE = 0x030a4000;
export const VCU_CHARACTER_PIXEL_ATTR_BYTES = 0x2000;
// Pixel Color Slot RAM: 64-byte palette maps shared by cells and objects
export const VCU_PIXEL_SLOT_BASE = 0x030b0000;
export const VCU_PIXEL_SLOT_BYTES = 64;
export const VCU_PIXEL_SLOT_COUNT = 1024;

export enum VcuRegister {
    VBCID0 = 0x00,
    VBCID1 = 0x02,
    VBCVER = 0x04,
    VBCCTRL = 0x06,
    CPUSPD = 0x08,
    COLCTRL = 0x0a,
    CBKPAL = 0x0c,
    LNKCTRL = 0x0e,
    CHRCTRL = 0x10,
    MEMCTRL = 0x12,
    CBRTRA = 0x14,
    CBRTRB = 0x16,
    CBRTRC = 0x18,
    CXCTRL = 0x1a,
    PCCAP = 0x1c,
    DMASRCL = 0x20,
    DMASRCH = 0x22,
    DMADSTL = 0x24,
    DMADSTH = 0x26,
    DMALEN = 0x28,
    DMACTRL = 0x2a,
}

export const VBC_ID0_VALUE = 0x4256;
export const VBC_ID1_VALUE = 0x2143;
export const VBC_VERSION_VALUE = 0x0100;

export const VCU_CRAM_PALETTE_SIZE = 4;
// tool convention only (the hardware has one palette space): BG palettes at 0-127, OBJ palettes at 128-255
export const VCU_CRAM_BG_PALETTES = 128;

// RGB888 entry (red in the low byte, bits 31-24 ignored) to a CSS color
export function vcuRgb888(value: number): { css: string; dark: boolean } {
    const red = value & 0xff;
    const green = (value >> 8) & 0xff;
    const blue = (value >> 16) & 0xff;
    const byte = (component: number): string => component.toString(16).toUpperCase().padStart(2, '0');
    return {
        css: `#${byte(red)}${byte(green)}${byte(blue)}`,
        dark: red * 299 + green * 587 + blue * 114 < 128000,
    };
}

export const VCU_CXCTRL_PCEN = 0x1;
export const VCU_CXCTRL_WCEN = 0x2;
export const VCU_CXCTRL_BKREN = 0x4;
export const VCU_CXCTRL_CCEN = 0x8;

// only there once the game has unlocked the VCU (VBCCTRL reads VBCEN after the keyed write); until then every other
// register reads zero and every VCU memory read comes back empty
export interface VbcState {
    registers: DataView;
    // CHRCTRL.CHREXT, cells and objects use twelve-bit character numbers
    chrext: boolean;
    colen: boolean;
    pcen: boolean;
    wcen: boolean;
    bkren: boolean;
    ccen: boolean;
    cbkpal: number;
}

// undefined when not a VB Color or color is not switched on. Every inspector's color fields go by this, so they
// come and go together
export async function readVbcState(source: DebugSource, sim: Sim | undefined = source.sim): Promise<VbcState | undefined> {
    if (!sim || !source.vbcHardwareActive) {
        return undefined;
    }
    const registers = new DataView(await sim.readMemory(VCU_REGISTER_BASE, VCU_REGISTER_BLOCK_BYTES));
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

// twelve bits with CHREXT, eleven without
export function vbcCharMask(vbc: VbcState | undefined): number {
    return vbc?.chrext ? 0x0fff : 0x07ff;
}

export interface VcuColorAttr {
    // bits 5-0: palette group, a CRAM palette being group * 4 + GPLTS/JPLTS
    group: number;
    // bit 7: palette and pixel attribute come from the Character's entries (with CCEN)
    chrsel: boolean;
}

export function decodeVcuColorAttr(byte: number): VcuColorAttr {
    return { group: byte & 0x3f, chrsel: (byte & 0x80) !== 0 };
}

export function encodeVcuColorAttr(attr: VcuColorAttr, previous = 0): number {
    // bit 6 is undocumented and kept as it was
    return (previous & 0x40) | (attr.group & 0x3f) | (attr.chrsel ? 0x80 : 0);
}

export interface VcuPixelAttr {
    // bit 15 (PCE): the pixels take their palettes from a Pixel Color Slot (with PCEN)
    enabled: boolean;
    // bit 14 (OPQ): pixel value 0 is drawn rather than transparent
    opaque: boolean;
    // bits 9-0: which of the 1024 slots
    slot: number;
}

export function decodeVcuPixelAttr(halfword: number): VcuPixelAttr {
    return {
        enabled: (halfword & 0x8000) !== 0,
        opaque: (halfword & 0x4000) !== 0,
        slot: halfword & (VCU_PIXEL_SLOT_COUNT - 1),
    };
}

export function encodeVcuPixelAttr(attr: VcuPixelAttr, previous = 0): number {
    // bits 13-10 are undocumented and kept as they were
    return (previous & 0x3c00)
        | (attr.enabled ? 0x8000 : 0)
        | (attr.opaque ? 0x4000 : 0)
        | (attr.slot & (VCU_PIXEL_SLOT_COUNT - 1));
}

// the CRAM palette a placement draws with: its group above its two VIP palette bits, plus the World offset
export function vcuPlacementPalette(group: number, vipPalette: number, worldOffset = 0): number {
    return (((group & 0x3f) << 2 | (vipPalette & 3)) + worldOffset) & 0xff;
}
