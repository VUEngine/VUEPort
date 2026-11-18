import {
    isVbcColorFramebuffer, VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH, VBC_COLOR_FRAMEBUFFER_BASE, VBC_COLOR_FRAMEBUFFER_PAGE_BYTES,
    VBC_VCU_APERTURE_BYTES,
} from '../common/vb-constants';
import { VbMachine } from './vb-machine';
import { VbPicture } from './vb-picture';

/**
 * The frame buffers as the VIP keeps them, before brightness, palettes and the display get to them. The VIP's own
 * four (left/right eye, buffer 0/1) hold a shade of 0-3 per pixel, four pixels to a byte, a column of 224 pixels in
 * 64 bytes (56 used). A VB Color game's Color Framebuffer has a byte per pixel beside each, a palette id: the color
 * shown is `CRAM[id * 4 + shade]`.
 */

export type VbFrameBufferEye = 'left' | 'right';

export interface VbFrameBufferPlace {
    color: boolean;
    eye: VbFrameBufferEye;
    buffer: 0 | 1;
    x: number;
    y: number; // first row the byte holds: four rows from here for the VIP's, one for VB Color's
    rows: number;
}

const LEGACY_BUFFER_BYTES = 0x6000; // bytes of a VIP frame buffer that hold pixels; character memory follows
const LEGACY_COLUMN_BYTES = 64; // bytes of a column, in either kind
const COLOR_COLUMN_BYTES = 256;

// buffers in order left 0, left 1, right 0, right 1, 32 KiB apart
export function legacyFrameBufferBase(eye: VbFrameBufferEye, buffer: 0 | 1): number {
    return (eye === 'right' ? 0x10000 : 0) | buffer << 15;
}

// pages in the same order as the VIP's buffers
export function colorFrameBufferBase(eye: VbFrameBufferEye, buffer: 0 | 1): number {
    return VBC_COLOR_FRAMEBUFFER_BASE + ((eye === 'right' ? 2 : 0) + buffer) * VBC_COLOR_FRAMEBUFFER_PAGE_BYTES;
}

// pixels a byte of either kind of frame buffer holds, undefined for any other address
export function frameBufferPlace(address: number): VbFrameBufferPlace | undefined {
    const at = (address & 0x07ffffff) >>> 0;
    if (at >>> 24 === 0) {
        const vip = at & 0x7ffff; // the VIP decodes 512 KiB and repeats it across the region
        const local = vip & 0x7fff;
        if (vip >= 0x20000 || local >= LEGACY_BUFFER_BYTES) {
            return undefined;
        }
        return {
            color: false,
            eye: vip & 0x10000 ? 'right' : 'left',
            buffer: (vip >>> 15 & 1) as 0 | 1,
            x: local >>> 6,
            y: (local & (LEGACY_COLUMN_BYTES - 1)) * 4,
            rows: 4,
        };
    }
    if (isVbcColorFramebuffer(at)) {
        const offset = at & (VBC_VCU_APERTURE_BYTES - 1);
        const page = Math.floor(offset / VBC_COLOR_FRAMEBUFFER_PAGE_BYTES);
        const within = offset % VBC_COLOR_FRAMEBUFFER_PAGE_BYTES;
        const y = within & (COLOR_COLUMN_BYTES - 1);
        // rows 224 to 255 of a column are padding the screen never shows
        if (y >= VB_SCREEN_HEIGHT) {
            return undefined;
        }
        return { color: true, eye: page & 2 ? 'right' : 'left', buffer: (page & 1) as 0 | 1, x: within >>> 8, y, rows: 1 };
    }
    return undefined;
}

// row by row, a byte per pixel: the shade for the VIP's, the palette id for VB Color's
export function readFrameBuffer(vb: VbMachine, eye: VbFrameBufferEye, buffer: 0 | 1, color: boolean): Uint8Array {
    const values = new Uint8Array(VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT);
    if (color) {
        const ids = vb.read(colorFrameBufferBase(eye, buffer), VBC_COLOR_FRAMEBUFFER_PAGE_BYTES);
        for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
            for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
                values[y * VB_SCREEN_WIDTH + x] = ids[x * COLOR_COLUMN_BYTES + y];
            }
        }
        return values;
    }
    const bytes = vb.read(legacyFrameBufferBase(eye, buffer), LEGACY_BUFFER_BYTES);
    for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
        for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
            // the topmost of a byte's four pixels is in its lowest two bits
            values[y * VB_SCREEN_WIDTH + x] = bytes[x * LEGACY_COLUMN_BYTES + (y >>> 2)] >>> ((y & 3) * 2) & 3;
        }
    }
    return values;
}

// shades as four greys, palette ids as their own value in grey. Not a picture of the screen, `shot` is that
export function frameBufferPicture(values: Uint8Array, color: boolean): VbPicture {
    const rgba = new Uint8ClampedArray(values.length * 4);
    for (let i = 0; i < values.length; i++) {
        const grey = color ? values[i] : values[i] * 85;
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = grey;
        rgba[i * 4 + 3] = 255;
    }
    return { rgba, width: VB_SCREEN_WIDTH, height: VB_SCREEN_HEIGHT };
}
