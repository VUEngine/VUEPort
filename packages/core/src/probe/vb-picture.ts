import { encodeIndexedPng } from '../common/emulator-png';
import { VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH } from '../common/vb-constants';

// which eye a picture shows, or both side by side
export type VbEye = 'left' | 'right' | 'both';

// as in the app: a plain VB frame is eye-packed (left eye's brightness in red, right's in green, 384 pixels wide),
// a VB Color frame is RGB, 768 wide, left eye in the left half. See VB_EYE_PACKED_LEFT and GetExtColorPixels
export interface VbFrame {
    pixels: Uint8Array;
    colorMode: boolean;
}

export interface VbPicture {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
}

// a plain VB frame comes out in the console's red, the brightness in the red channel, as the LED would show it;
// palettes and display modes are the app's business
export function framePicture(frame: VbFrame, eye: VbEye = 'left'): VbPicture {
    const eyes: ('left' | 'right')[] = eye === 'both' ? ['left', 'right'] : [eye];
    const width = VB_SCREEN_WIDTH * eyes.length;
    const height = VB_SCREEN_HEIGHT;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const source = frame.pixels;
    const sourceWidth = frame.colorMode ? VB_SCREEN_WIDTH * 2 : VB_SCREEN_WIDTH;

    eyes.forEach((which, panel) => {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
                const to = (y * width + panel * VB_SCREEN_WIDTH + x) * 4;
                if (frame.colorMode) {
                    const from = (y * sourceWidth + (which === 'right' ? VB_SCREEN_WIDTH : 0) + x) * 4;
                    rgba[to] = source[from];
                    rgba[to + 1] = source[from + 1];
                    rgba[to + 2] = source[from + 2];
                } else {
                    const from = (y * sourceWidth + x) * 4;
                    rgba[to] = source[from + (which === 'right' ? 1 : 0)];
                }
                rgba[to + 3] = 255;
            }
        }
    });
    return { rgba, width, height };
}

// indexed where it can be, which is nearly always for a VB frame; truecolour for a VB Color frame with over 256 colours
export async function encodePng(picture: VbPicture, scale = 1): Promise<Uint8Array> {
    const factor = Math.max(1, Math.floor(scale));
    const indexed = await encodeIndexedPng(picture.rgba, picture.width, picture.height, factor);
    if (indexed) {
        return indexed;
    }
    return encodeTruecolorPng(picture, factor);
}

async function encodeTruecolorPng(picture: VbPicture, scale: number): Promise<Uint8Array> {
    const width = picture.width * scale;
    const height = picture.height * scale;
    const rowBytes = 1 + width * 3;
    const raw = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
        const sourceY = Math.floor(y / scale);
        for (let x = 0; x < width; x++) {
            const from = (sourceY * picture.width + Math.floor(x / scale)) * 4;
            const to = y * rowBytes + 1 + x * 3;
            raw[to] = picture.rgba[from];
            raw[to + 1] = picture.rgba[from + 1];
            raw[to + 2] = picture.rgba[from + 2];
        }
    }

    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;  // bits per channel
    header[9] = 2;  // truecolour
    const data = await deflate(raw);
    return concat([
        Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
        chunk('IHDR', header),
        chunk('IDAT', data),
        chunk('IEND', new Uint8Array(0)),
    ]);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) {
        out[4 + i] = type.charCodeAt(i);
    }
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
