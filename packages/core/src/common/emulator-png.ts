/**
 * Pixels as an indexed PNG, at a fraction of the canvas's truecolor size. A VB picture nearly always fits (four shades
 * per eye, a few more with blending or anaglyph). `scale` enlarges by whole multiples, nearest-neighbour, so a big shot
 * is indexed at its own size. Undefined with more colors than a palette holds, or without CompressionStream; the caller
 * then falls back to the canvas's own encoder.
 */
export async function encodeIndexedPng(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    scale = 1,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
    if (typeof CompressionStream === 'undefined') {
        return undefined;
    }
    const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
    const indexes = new Uint8Array(width * height);
    const colours = new Map<number, number>();
    const firstAt: number[] = [];
    for (let i = 0; i < pixels.length; i++) {
        let index = colours.get(pixels[i]);
        if (index === undefined) {
            if (colours.size === 256) {
                return undefined;
            }
            index = colours.size;
            colours.set(pixels[i], index);
            firstAt.push(i);
        }
        indexes[i] = index;
    }

    const palette = new Uint8Array(firstAt.length * 3);
    const alpha = new Uint8Array(firstAt.length);
    firstAt.forEach((at, index) => {
        palette.set(rgba.subarray(at * 4, at * 4 + 3), index * 3);
        alpha[index] = rgba[at * 4 + 3];
    });
    // only as many alpha entries as reach the last translucent one, none for an opaque picture (all the renderer draws
    // are opaque)
    let translucent = alpha.length;
    while (translucent > 0 && alpha[translucent - 1] === 255) {
        translucent--;
    }

    const depth = firstAt.length <= 2 ? 1 : firstAt.length <= 4 ? 2 : firstAt.length <= 16 ? 4 : 8;
    const perByte = 8 / depth;
    const outWidth = width * scale;
    const rowBytes = 1 + Math.ceil(outWidth / perByte);
    const raw = new Uint8Array(rowBytes * height * scale);
    for (let y = 0; y < height; y++) {
        // the first copy of the row packed, filter byte 0 (none) in front; the other copies are the same bytes
        const row = raw.subarray(y * scale * rowBytes, (y * scale + 1) * rowBytes);
        for (let x = 0; x < outWidth; x++) {
            const index = indexes[y * width + Math.floor(x / scale)];
            row[1 + Math.floor(x / perByte)] |= index << (8 - depth - (x % perByte) * depth);
        }
        for (let copy = 1; copy < scale; copy++) {
            raw.set(row, (y * scale + copy) * rowBytes);
        }
    }

    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, outWidth);
    view.setUint32(4, height * scale);
    header[8] = depth;
    header[9] = 3; // color type: indexed
    return assemble([
        PNG_SIGNATURE,
        chunk('IHDR', header),
        chunk('PLTE', palette),
        ...translucent > 0 ? [chunk('tRNS', alpha.subarray(0, translucent))] : [],
        // `deflate` is zlib's framing, which is what IDAT holds
        chunk('IDAT', await compress(raw)),
        chunk('IEND', new Uint8Array(0)),
    ]);
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);

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

function assemble(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

async function compress(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new CompressionStream('deflate');
    const writer = stream.writable.getWriter();
    // not awaited: the write only settles once the other end has been read
    writer.write(bytes as BufferSource).catch(() => undefined);
    writer.close().catch(() => undefined);
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

let CRC_TABLE: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let value = i;
            for (let bit = 0; bit < 8; bit++) {
                value = value & 1 ? (value >>> 1) ^ 0xEDB88320 : value >>> 1;
            }
            CRC_TABLE[i] = value >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
