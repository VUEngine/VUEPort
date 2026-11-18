import type { Sim } from '../core/vb-core';
import {
    VbcState,
    VCU_CELL_COLOR_BASE,
    VCU_CELL_PIXEL_ATTR_BASE,
    VCU_CHARACTER_COLOR_BASE,
    VCU_CHARACTER_COLOR_BYTES,
    VCU_CHARACTER_PIXEL_ATTR_BASE,
    VCU_CHARACTER_PIXEL_ATTR_BYTES,
    VCU_CRAM_BASE,
    VCU_CRAM_BYTES,
    VCU_OBJ_COLOR_BASE,
    VCU_OBJ_COLOR_BYTES,
    VCU_OBJ_PIXEL_ATTR_BASE,
    VCU_OBJ_PIXEL_ATTR_BYTES,
    VCU_PIXEL_SLOT_BASE,
    VCU_PIXEL_SLOT_BYTES,
    VCU_PIXEL_SLOT_COUNT,
    VCU_WORLD_ATTR_BASE,
    VCU_WORLD_ATTR_BYTES,
} from './emulator-vcu-memory';

const SEGMENT_CELLS = 64 * 64;

// how a BGMap cell, object or lone character is colored
export interface VcuPlacement {
    palette: number; // CRAM palette before any World offset
    // Pixel Color Slot overriding the palette per pixel: 64 bytes in the character's own coordinates, only with PCE+PCEN
    slot?: Uint8Array;
    opaque: boolean; // OPQ, pixel value 0 is drawn too, only while a slot applies
}

export interface VcuColorParts {
    segments?: Iterable<number>;
    objects?: boolean;
    worlds?: boolean;
}

// the shade a pixel value selects from a palette register. Unlike on the VIP, where 0 is hardwired black, value 0
// counts too, since a VB Color draws it with the register's low two bits under OPQ
export function vipShade(paletteRegister: number, value: number): number {
    return (paletteRegister >> (value * 2)) & 3;
}

/**
 * The VCU's color tables, for debugger previews in a VB Color game's colors instead of the VIP's red. Follows the
 * core's vipCellColor and vipDrawCell: a placement's palette is its Color Attribute's group above its two VIP palette
 * bits (or, with CHRSEL and CCEN, its Character's group), plus the World's offset under WCEN. A Pixel Color Slot then
 * picks a palette per pixel (0 keeps the placement's, 0xFF leaves the pixel out), and the color is that palette's CRAM
 * entry for the pixel's shade. Brightness is left out: a preview shows the colors set up, not how bright a fade has
 * them right now.
 */
export class VcuColors {

    protected constructor(
        readonly vbc: VbcState,
        protected readonly cram: Uint8Array,
        protected readonly slots: Uint8Array | undefined,
        protected readonly charColors: Uint8Array | undefined,
        protected readonly charPixels: DataView | undefined,
        protected readonly cellColors: ReadonlyMap<number, Uint8Array>,
        protected readonly cellPixels: ReadonlyMap<number, DataView>,
        protected readonly objectColors: Uint8Array | undefined,
        protected readonly objectPixels: DataView | undefined,
        protected readonly worldAttrs: Uint8Array | undefined,
    ) { }

    // reads only what drawing `parts` takes: slots only under PCEN, Character entries only under CCEN,
    // World offsets only under WCEN
    static async read(sim: Sim, vbc: VbcState, parts: VcuColorParts): Promise<VcuColors> {
        const ranges = VcuColors.ranges(vbc, parts);
        const fetched = await Promise.all(ranges.map(range => (range ? sim.readMemory(range[0], range[1]) : undefined)));
        return VcuColors.assemble(vbc, parts, fetched.map(buffer => (buffer ? new Uint8Array(buffer) : undefined)));
    }

    // for memory that can be read on the spot, as a machine driven from a script has (see vueport-probe)
    static readSync(read: (address: number, length: number) => Uint8Array, vbc: VbcState, parts: VcuColorParts): VcuColors {
        return VcuColors.assemble(vbc, parts, VcuColors.ranges(vbc, parts).map(range => (range ? read(range[0], range[1]) : undefined)));
    }

    // address ranges in the order assemble() takes them, undefined for a table not wanted
    protected static ranges(vbc: VbcState, parts: VcuColorParts): ([number, number] | undefined)[] {
        const segments = [...new Set(parts.segments ?? [])];
        return [
            [VCU_CRAM_BASE, VCU_CRAM_BYTES],
            vbc.pcen ? [VCU_PIXEL_SLOT_BASE, VCU_PIXEL_SLOT_BYTES * VCU_PIXEL_SLOT_COUNT] : undefined,
            vbc.ccen ? [VCU_CHARACTER_COLOR_BASE, VCU_CHARACTER_COLOR_BYTES] : undefined,
            vbc.ccen ? [VCU_CHARACTER_PIXEL_ATTR_BASE, VCU_CHARACTER_PIXEL_ATTR_BYTES] : undefined,
            parts.objects ? [VCU_OBJ_COLOR_BASE, VCU_OBJ_COLOR_BYTES] : undefined,
            parts.objects ? [VCU_OBJ_PIXEL_ATTR_BASE, VCU_OBJ_PIXEL_ATTR_BYTES] : undefined,
            parts.worlds && vbc.wcen ? [VCU_WORLD_ATTR_BASE, VCU_WORLD_ATTR_BYTES] : undefined,
            ...segments.flatMap((segment): [number, number][] => [
                [VCU_CELL_COLOR_BASE + segment * SEGMENT_CELLS, SEGMENT_CELLS],
                [VCU_CELL_PIXEL_ATTR_BASE + segment * SEGMENT_CELLS * 2, SEGMENT_CELLS * 2],
            ]),
        ];
    }

    protected static assemble(vbc: VbcState, parts: VcuColorParts, tables: (Uint8Array | undefined)[]): VcuColors {
        const view = (bytes: Uint8Array | undefined): DataView | undefined =>
            bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined;
        const [cram, slots, charColors, charPixels, objectColors, objectPixels, worldAttrs, ...cells] = tables;
        const segments = [...new Set(parts.segments ?? [])];
        return new VcuColors(
            vbc, cram!, slots, charColors, view(charPixels),
            new Map(segments.map((segment, index) => [segment, cells[index * 2]!])),
            new Map(segments.map((segment, index) => [segment, view(cells[index * 2 + 1])!])),
            objectColors, view(objectPixels), worldAttrs,
        );
    }

    // for a placement on `layer` (0 cells, 1 objects), or for the character on its own as the Characters panel draws it
    character(char: number, layer: 0 | 1, vipPalette: number, into = vcuPlacement()): VcuPlacement {
        const group = this.charColors ? this.charColors[(char * 2 + layer) & 0x1fff] & 0x3f : 0;
        const pixel = this.charPixels ? this.charPixels.getUint16((char * 2) & 0x1fff, true) : 0;
        return this.fill(into, group, vipPalette, pixel);
    }

    // `cell` 0-4095 within `segment`
    cell(segment: number, cell: number, char: number, vipPalette: number, into = vcuPlacement()): VcuPlacement {
        const attr = this.cellColors.get(segment)?.[cell] ?? 0;
        if (attr & 0x80 && this.vbc.ccen) {
            return this.character(char, 0, vipPalette, into);
        }
        return this.fill(into, attr & 0x3f, vipPalette, this.cellPixels.get(segment)?.getUint16(cell * 2, true) ?? 0);
    }

    object(index: number, char: number, vipPalette: number, into = vcuPlacement()): VcuPlacement {
        const attr = this.objectColors?.[index & 0x3ff] ?? 0;
        if (attr & 0x80 && this.vbc.ccen) {
            return this.character(char, 1, vipPalette, into);
        }
        return this.fill(into, attr & 0x3f, vipPalette, this.objectPixels?.getUint16((index & 0x3ff) * 2, true) ?? 0);
    }

    // the World's palette offset under WCEN, else 0
    worldOffset(world: number): number {
        return this.worldAttrs ? this.worldAttrs[(world & 0x1f) * 2] : 0;
    }

    // returns false for a pixel the hardware leaves out (value 0 without OPQ, or slot byte 0xFF), which the caller
    // fills however its view shows nothing
    put(
        target: Uint8ClampedArray, offset: number, placement: VcuPlacement,
        value: number, charX: number, charY: number, shade: number, worldOffset = 0 // charX/charY with flips undone
    ): boolean {
        let palette: number;
        if (placement.slot) {
            const slot = placement.slot[charY * 8 + charX];
            if ((value === 0 && !placement.opaque) || slot === 0xff) {
                return false;
            }
            palette = slot !== 0 ? slot : (placement.palette + worldOffset) & 0xff;
        } else {
            if (value === 0) {
                return false;
            }
            palette = (placement.palette + worldOffset) & 0xff;
        }
        // RGB888 words with red in the low byte, so the bytes are already R, G, B
        const at = ((palette << 2) | shade) * 4;
        target[offset] = this.cram[at];
        target[offset + 1] = this.cram[at + 1];
        target[offset + 2] = this.cram[at + 2];
        target[offset + 3] = 255;
        return true;
    }

    // the same switches and bytes in every table, checked by a view caching its picture before drawing it again
    same(other: VcuColors | undefined): boolean {
        if (!other) {
            return false;
        }
        const a = this.vbc;
        const b = other.vbc;
        if (a.pcen !== b.pcen || a.ccen !== b.ccen || a.wcen !== b.wcen || a.chrext !== b.chrext) {
            return false;
        }
        const segments = [...this.cellColors.keys()];
        return equalBytes(this.cram, other.cram)
            && equalBytes(this.slots, other.slots)
            && equalBytes(this.charColors, other.charColors)
            && equalBytes(this.charPixels, other.charPixels)
            && equalBytes(this.objectColors, other.objectColors)
            && equalBytes(this.objectPixels, other.objectPixels)
            && equalBytes(this.worldAttrs, other.worldAttrs)
            && segments.length === other.cellColors.size
            && segments.every(segment => equalBytes(this.cellColors.get(segment), other.cellColors.get(segment))
                && equalBytes(this.cellPixels.get(segment), other.cellPixels.get(segment)));
    }

    protected fill(into: VcuPlacement, group: number, vipPalette: number, pixel: number): VcuPlacement {
        into.palette = (group << 2) | (vipPalette & 3);
        if (this.slots && pixel & 0x8000) {
            const slot = pixel & (VCU_PIXEL_SLOT_COUNT - 1);
            into.slot = this.slots.subarray(slot * VCU_PIXEL_SLOT_BYTES, (slot + 1) * VCU_PIXEL_SLOT_BYTES);
            into.opaque = (pixel & 0x4000) !== 0;
        } else {
            into.slot = undefined;
            into.opaque = false;
        }
        return into;
    }
}

// reused between pixels, so drawing a world does not allocate per pixel
export function vcuPlacement(): VcuPlacement {
    return { palette: 0, slot: undefined, opaque: false };
}

function equalBytes(a: Uint8Array | DataView | undefined, b: Uint8Array | DataView | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }
    if (a.byteLength !== b.byteLength) {
        return false;
    }
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < x.length; i++) {
        if (x[i] !== y[i]) {
            return false;
        }
    }
    return true;
}
