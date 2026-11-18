import { VB_MAX_MEMORY_READ } from '../../common/vb-constants';
import { Sim } from '../core/vb-core';

// resolves a pixel's VB Color palette from the current VCU memory (placement attribute, character under CHRSEL,
// pixel slot) instead of from the frame's pixel origins. A paused machine draws nothing, so attribute or slot edits
// made while paused only show up in the color editor's recomposed views this way

const VCU = 0x03000000;
const CELL_ATTRIBUTES = 0x00060000;
const OBJ_ATTRIBUTES = 0x00070000;
const CELL_PIXEL_ATTRIBUTES = 0x00080000;
const OBJ_PIXEL_ATTRIBUTES = 0x000a0000;
const CHRCOL = 0x000a2000;
const CHRPIX = 0x000a4000;
const SLOTS = 0x000b0000;
const CXCTRL = 0x0007f81a;
const CXCTRL_CCEN = 8;

export interface ColorState {
    control: number;
    cellAttributes: Uint8Array;
    objectAttributes: Uint8Array;
    cellPixelAttributes: Uint8Array;
    objectPixelAttributes: Uint8Array;
    characterColors: Uint8Array;
    characterPixels: Uint8Array;
    slots: Uint8Array;
}

export async function readColorState(sim: Sim): Promise<ColorState> {
    // read in chunks of the worker's maximum, the cells' pixel attributes are twice that size
    const read = async (address: number, length: number): Promise<Uint8Array> => {
        const out = new Uint8Array(length);
        for (let at = 0; at < length; at += VB_MAX_MEMORY_READ) {
            out.set(new Uint8Array(await sim.readMemory(VCU + address + at, Math.min(VB_MAX_MEMORY_READ, length - at))), at);
        }
        return out;
    };
    return {
        control: (await read(CXCTRL, 1))[0],
        cellAttributes: await read(CELL_ATTRIBUTES, 0x10000),
        objectAttributes: await read(OBJ_ATTRIBUTES, 1024),
        cellPixelAttributes: await read(CELL_PIXEL_ATTRIBUTES, 0x20000),
        objectPixelAttributes: await read(OBJ_PIXEL_ATTRIBUTES, 2048),
        characterColors: await read(CHRCOL, 8192),
        characterPixels: await read(CHRPIX, 8192),
        slots: await read(SLOTS, 1024 * 64),
    };
}

// the attribute's palette group, or the character's under CHRSEL, combined with the 2-bit selector
export function namedPalette(state: ColorState, object: boolean, placement: number, character: number, selector: number): number {
    const attribute = object ? state.objectAttributes[placement] : state.cellAttributes[placement];
    const byte = attribute & 0x80 && state.control & CXCTRL_CCEN
        ? state.characterColors[character * 2 + (object ? 1 : 0)]
        : attribute;
    return ((byte & 0x3f) << 2 | selector) & 0xff;
}

// palette of a drawn pixel from the two words of its origin, undefined if its slot cuts it out (0xff).
// `offset` is the world's WCEN addition, which the attributes don't include
export function pixelPalette(state: ColorState, what: number, where: number, offset = 0): number | undefined {
    const object = (what & 7) === 4;
    const placement = object ? where & 0x3ff : where & 0xffff;
    const character = what >>> 8 & 0xfff;
    const attribute = object ? state.objectAttributes[placement] : state.cellAttributes[placement];
    const byCharacter = (attribute & 0x80) !== 0 && (state.control & CXCTRL_CCEN) !== 0;
    const pixels = byCharacter ? state.characterPixels : object ? state.objectPixelAttributes : state.cellPixelAttributes;
    const at = (byCharacter ? character : placement) * 2;
    const pixelAttribute = pixels[at] | pixels[at + 1] << 8;
    let palette = namedPalette(state, object, placement, character, what >>> 30);
    if (pixelAttribute & 0x8000) {
        const byte = state.slots[(pixelAttribute & 0x3ff) * 64 + (what >>> 20 & 63)];
        if (byte === 0xff) {
            return undefined;
        }
        if (byte !== 0) {
            palette = byte;
        }
    }
    return (palette + offset) & 0xff;
}
