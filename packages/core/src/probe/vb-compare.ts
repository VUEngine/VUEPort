import { VbPicture } from './vb-picture';

// reads pictures back in and compares them, e.g. a test's reference image against the screen. Decodes what
// tools write: greyscale, RGB, palette and their alpha forms at 1 to 8 bits a channel (16 by its high byte),
// not interlaced

export async function decodePng(file: Uint8Array): Promise<VbPicture> {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (file.length < 8 || signature.some((byte, index) => file[index] !== byte)) {
        throw new Error('This is not a PNG file.');
    }
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    let width = 0;
    let height = 0;
    let depth = 0;
    let type = 0;
    let palette: Uint8Array | undefined;
    let transparency: Uint8Array | undefined;
    const data: Uint8Array[] = [];
    for (let at = 8; at + 8 <= file.length;) {
        const length = view.getUint32(at);
        const name = String.fromCharCode(...file.subarray(at + 4, at + 8));
        const body = file.subarray(at + 8, at + 8 + length);
        if (name === 'IHDR') {
            width = view.getUint32(at + 8);
            height = view.getUint32(at + 12);
            depth = body[8];
            type = body[9];
            if (body[12] !== 0) {
                throw new Error('Interlaced PNG files are not read; save it without interlacing.');
            }
        } else if (name === 'PLTE') {
            palette = body;
        } else if (name === 'tRNS') {
            transparency = body;
        } else if (name === 'IDAT') {
            data.push(body);
        } else if (name === 'IEND') {
            break;
        }
        at += 12 + length;
    }
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    if (!width || !height || channels === undefined || ![1, 2, 4, 8, 16].includes(depth)) {
        throw new Error('This PNG file has a kind of image in it that is not read.');
    }

    const raw = await inflate(data);
    const bitsPerPixel = channels * depth;
    const rowBytes = Math.ceil(width * bitsPerPixel / 8);
    const step = Math.max(1, bitsPerPixel >> 3);
    const rows = unfilter(raw, rowBytes, height, step);
    const rgba = new Uint8ClampedArray(width * height * 4);
    // one sample of a row at a time, as 8 bits whatever its depth
    const sample = (row: Uint8Array, index: number, scaled: boolean): number => {
        if (depth === 16) {
            return row[index * 2];
        }
        if (depth === 8) {
            return row[index];
        }
        const bit = index * depth;
        const value = row[bit >> 3] >> (8 - depth - (bit & 7)) & ((1 << depth) - 1);
        return scaled ? Math.round(value * 255 / ((1 << depth) - 1)) : value;
    };
    for (let y = 0; y < height; y++) {
        const row = rows[y];
        for (let x = 0; x < width; x++) {
            const to = (y * width + x) * 4;
            const first = x * channels;
            let alpha = 255;
            switch (type) {
                case 0:
                case 4: {
                    const grey = sample(row, first, true);
                    rgba[to] = rgba[to + 1] = rgba[to + 2] = grey;
                    alpha = type === 4 ? sample(row, first + 1, true) : 255;
                    break;
                }
                case 2:
                case 6:
                    rgba[to] = sample(row, first, true);
                    rgba[to + 1] = sample(row, first + 1, true);
                    rgba[to + 2] = sample(row, first + 2, true);
                    alpha = type === 6 ? sample(row, first + 3, true) : 255;
                    break;
                case 3: {
                    const index = sample(row, first, false);
                    rgba[to] = palette?.[index * 3] ?? 0;
                    rgba[to + 1] = palette?.[index * 3 + 1] ?? 0;
                    rgba[to + 2] = palette?.[index * 3 + 2] ?? 0;
                    alpha = transparency?.[index] ?? 255;
                    break;
                }
            }
            rgba[to + 3] = alpha;
        }
    }
    return { rgba, width, height };
}

async function inflate(parts: Uint8Array[]): Promise<Uint8Array> {
    const stream = new Blob(parts as Uint8Array<ArrayBuffer>[]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function unfilter(raw: Uint8Array, rowBytes: number, height: number, step: number): Uint8Array[] {
    const rows: Uint8Array[] = [];
    let previous = new Uint8Array(rowBytes);
    for (let y = 0; y < height; y++) {
        const at = y * (rowBytes + 1);
        if (at + 1 + rowBytes > raw.length) {
            throw new Error('This PNG file ends early.');
        }
        const filter = raw[at];
        const row = raw.slice(at + 1, at + 1 + rowBytes);
        for (let i = 0; i < rowBytes; i++) {
            const left = i >= step ? row[i - step] : 0;
            const up = previous[i];
            const corner = i >= step ? previous[i - step] : 0;
            switch (filter) {
                case 1: row[i] = row[i] + left; break;
                case 2: row[i] = row[i] + up; break;
                case 3: row[i] = row[i] + ((left + up) >> 1); break;
                case 4: {
                    const estimate = left + up - corner;
                    const toLeft = Math.abs(estimate - left);
                    const toUp = Math.abs(estimate - up);
                    const toCorner = Math.abs(estimate - corner);
                    row[i] = row[i] + (toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner);
                    break;
                }
            }
        }
        rows.push(row);
        previous = row;
    }
    return rows;
}

export interface VbPictureDifference {
    pixels: number;
    differing: number; // of those, pixels further apart than the tolerance in some channel
    box?: { x: number, y: number, width: number, height: number };
    largest: number;
    picture: VbPicture; // greyed, with the differing pixels in magenta
}

// against a reference of the same size, channel by channel; `tolerance` is how far a channel may be off, for a
// reference that went through a lossy step or a blend
export function comparePictures(
    actual: VbPicture,
    expected: VbPicture,
    options: { tolerance?: number, region?: { x: number, y: number, width: number, height: number } } = {},
): VbPictureDifference {
    if (actual.width !== expected.width || actual.height !== expected.height) {
        throw new Error(`The pictures are not the same size: ${actual.width}x${actual.height} and ${expected.width}x${expected.height}.`);
    }
    const tolerance = options.tolerance ?? 0;
    const area = options.region ?? { x: 0, y: 0, width: actual.width, height: actual.height };
    const rgba = new Uint8ClampedArray(actual.rgba.length);
    let differing = 0;
    let largest = 0;
    let box: [number, number, number, number] | undefined;
    for (let y = 0; y < actual.height; y++) {
        for (let x = 0; x < actual.width; x++) {
            const at = (y * actual.width + x) * 4;
            const inside = x >= area.x && y >= area.y && x < area.x + area.width && y < area.y + area.height;
            let worst = 0;
            if (inside) {
                for (let channel = 0; channel < 4; channel++) {
                    worst = Math.max(worst, Math.abs(actual.rgba[at + channel] - expected.rgba[at + channel]));
                }
            }
            largest = Math.max(largest, worst);
            if (worst > tolerance) {
                differing++;
                box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
                rgba[at] = 255;
                rgba[at + 1] = 0;
                rgba[at + 2] = 255;
            } else {
                // dimmed and grey, so the magenta is what the eye finds
                const grey = (actual.rgba[at] + actual.rgba[at + 1] + actual.rgba[at + 2]) / 3 * (inside ? 0.5 : 0.25);
                rgba[at] = rgba[at + 1] = rgba[at + 2] = grey;
            }
            rgba[at + 3] = 255;
        }
    }
    return {
        pixels: area.width * area.height,
        differing,
        box: box && { x: box[0], y: box[1], width: box[2] - box[0] + 1, height: box[3] - box[1] + 1 },
        largest,
        picture: { rgba, width: actual.width, height: actual.height },
    };
}
