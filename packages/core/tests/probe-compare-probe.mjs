// PNGs written in every form a screenshot tool might choose (grey, RGB, palette, alpha, every bit depth and row filter)
// must decode to the pixels that went in; then the comparison finds changed pixels where they changed, within a
// tolerance. Usage: node tests/probe-compare-probe.mjs
import { createRequire } from 'module';
import { deflateSync } from 'zlib';
import { check, finish } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { decodePng, comparePictures, encodePng } = require('../lib/probe/index.js');

const WIDTH = 13;
const HEIGHT = 7;

// by position, so every pixel differs from its neighbours
const level = (x, y, levels) => (x * 3 + y * 5) % levels;

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) {
            crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

// rows of samples, packed at `depth` bits and filtered with each filter in turn
function png(type, depth, samples, channels, extra = []) {
    const bits = channels * depth;
    const rowBytes = Math.ceil(WIDTH * bits / 8);
    const step = Math.max(1, bits >> 3);
    const rows = [];
    for (let y = 0; y < HEIGHT; y++) {
        const row = Buffer.alloc(rowBytes);
        for (let x = 0; x < WIDTH; x++) {
            for (let c = 0; c < channels; c++) {
                const value = samples(x, y, c);
                const index = x * channels + c;
                if (depth === 16) {
                    row.writeUInt16BE(value, index * 2);
                } else if (depth === 8) {
                    row[index] = value;
                } else {
                    const bit = index * depth;
                    row[bit >> 3] |= value << (8 - depth - (bit & 7));
                }
            }
        }
        rows.push(row);
    }
    const filtered = [];
    rows.forEach((row, y) => {
        const filter = y % 5;
        const previous = y > 0 ? rows[y - 1] : Buffer.alloc(rowBytes);
        const out = Buffer.alloc(rowBytes + 1);
        out[0] = filter;
        for (let i = 0; i < rowBytes; i++) {
            const left = i >= step ? row[i - step] : 0;
            const up = previous[i];
            const corner = i >= step ? previous[i - step] : 0;
            const paeth = () => {
                const estimate = left + up - corner;
                const a = Math.abs(estimate - left);
                const b = Math.abs(estimate - up);
                const c = Math.abs(estimate - corner);
                return a <= b && a <= c ? left : b <= c ? up : corner;
            };
            const predicted = [0, left, up, (left + up) >> 1, paeth()][filter];
            out[1 + i] = (row[i] - predicted) & 0xff;
        }
        filtered.push(out);
    });
    const header = Buffer.alloc(13);
    header.writeUInt32BE(WIDTH, 0);
    header.writeUInt32BE(HEIGHT, 4);
    header[8] = depth;
    header[9] = type;
    return new Uint8Array(Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        ...extra,
        chunk('IDAT', deflateSync(Buffer.concat(filtered))),
        chunk('IEND', Buffer.alloc(0)),
    ]));
}

async function reads(label, file, expected) {
    const picture = await decodePng(file);
    let wrong = 0;
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const want = expected(x, y);
            for (let c = 0; c < 4; c++) {
                if (picture.rgba[(y * WIDTH + x) * 4 + c] !== want[c]) {
                    wrong++;
                }
            }
        }
    }
    check(label, `${picture.width}x${picture.height} ${wrong} wrong`, `${WIDTH}x${HEIGHT} 0 wrong`);
}

console.log('Reading every kind of PNG');
for (const depth of [1, 2, 4, 8, 16]) {
    const levels = 2 ** Math.min(depth, 8);
    const max = 2 ** depth - 1;
    const scaled = v => Math.round(v * 255 / (levels - 1));
    await reads(`grey, ${depth} bits`, png(0, depth, (x, y) => (depth === 16 ? level(x, y, 256) * 257 : level(x, y, levels) & max), 1),
        (x, y) => { const g = depth === 16 ? level(x, y, 256) : scaled(level(x, y, levels)); return [g, g, g, 255]; });
}
for (const depth of [8, 16]) {
    const value = (x, y, c) => level(x + c * 4, y, 256);
    await reads(`RGB, ${depth} bits`, png(2, depth, (x, y, c) => (depth === 16 ? value(x, y, c) * 257 : value(x, y, c)), 3),
        (x, y) => [value(x, y, 0), value(x, y, 1), value(x, y, 2), 255]);
    await reads(`RGBA, ${depth} bits`, png(6, depth, (x, y, c) => (depth === 16 ? value(x, y, c) * 257 : value(x, y, c)), 4),
        (x, y) => [value(x, y, 0), value(x, y, 1), value(x, y, 2), value(x, y, 3)]);
    await reads(`grey and alpha, ${depth} bits`, png(4, depth, (x, y, c) => (depth === 16 ? value(x, y, c) * 257 : value(x, y, c)), 2),
        (x, y) => [value(x, y, 0), value(x, y, 0), value(x, y, 0), value(x, y, 1)]);
}
for (const depth of [1, 2, 4, 8]) {
    const entries = 2 ** depth;
    const colors = Array.from({ length: entries }, (_, i) => [i * 7 % 256, 255 - i, i * 31 % 256]);
    const plte = chunk('PLTE', Buffer.from(colors.flat()));
    const trns = chunk('tRNS', Buffer.from(colors.map((_, i) => (i === 1 ? 0 : 255))));
    await reads(`palette, ${depth} bits, one entry transparent`, png(3, depth, (x, y) => level(x, y, entries), 1, [plte, trns]),
        (x, y) => { const i = level(x, y, entries); return [...colors[i], i === 1 ? 0 : 255]; });
}
let refused = '';
try {
    await decodePng(new Uint8Array([1, 2, 3]));
} catch (error) {
    refused = error.message;
}
check('what is not a PNG is said to be not one', refused, 'This is not a PNG file.');

console.log('\nOur own, through our own');
const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgba.set([i * 3 % 256, 0, 0, 255], i * 4);
}
const picture = { rgba, width: WIDTH, height: HEIGHT };
const again = await decodePng(await encodePng(picture));
check('a shot comes back as it was taken', comparePictures(picture, again).differing, 0);

console.log('\nComparing');
const changed = { ...picture, rgba: rgba.slice() };
changed.rgba[(3 * WIDTH + 5) * 4] += 2;
let difference = comparePictures(changed, picture);
check('one pixel off is found', difference.differing, 1);
check('... where it is', JSON.stringify(difference.box), JSON.stringify({ x: 5, y: 3, width: 1, height: 1 }));
check('... by how much', difference.largest, 2);
check('... and marked in magenta', [...difference.picture.rgba.subarray((3 * WIDTH + 5) * 4, (3 * WIDTH + 5) * 4 + 3)].join(), '255,0,255');
check('within a tolerance it is the same', comparePictures(changed, picture, { tolerance: 2 }).differing, 0);
difference = comparePictures(changed, picture, { region: { x: 0, y: 0, width: 4, height: 7 } });
check('outside a region it is not looked at', `${difference.differing} of ${difference.pixels}`, '0 of 28');
let mismatch = '';
try {
    comparePictures(picture, { rgba: new Uint8ClampedArray(4), width: 1, height: 1 });
} catch (error) {
    mismatch = error.message;
}
check('pictures of two sizes are not compared', mismatch.includes('not the same size'), true);

finish();
