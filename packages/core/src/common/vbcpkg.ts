// @ts-nocheck
/* eslint-disable */
// Generated from VB Patches/_tools/vbcpkg/vbcpkg.mjs by sync-vueport.mjs: change it there, not here.
// compiles VB Color packages into a patched ROM (format: README.md in this folder); no Node imports, so it runs in Node
// and in the browser editor. compile.mjs is the command line around it, model packages (Red Alarm) compile in models.mjs

import { compileModels, zrCellShown, zrShownPixels } from './vbcpkg-models';
import { compileHf, hfCellShown, hfShownPixels } from './vbcpkg-hf';
import { compileMt, mtCellShown, mtShownPixels } from './vbcpkg-mt';

export const FORMAT = 'vbcpkg/1';
export const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/';
const AIDX = Object.fromEntries([...ALPHA].map((c, i) => [c, i]));
const TOC_MAGIC = [0x56, 0x42, 0x43, 0x50];          // 'VBCP'

// VUEPort words it in vb-color-package.ts colorBuildError
export class DataAreaFull extends Error {
    constructor(blob, area) {                    // area: the data area's size in bytes, extra areas included
        super(`data area full (${blob})`);
        this.name = 'DataAreaFull'; this.code = 'data-area-full'; this.blob = blob; this.area = area;
    }
}

// the palette groups and the cell patch groups need more than the 64 (or params.top) there are: paint that asks for
// colour ramps of its own (characters without a pixel slot) or that keeps cell requests from finding their colours.
// VUEPort's editor tells the person in words (colorBuildErrorText, code 'palette-groups-full')
export class PaletteGroupsFull extends Error {
    constructor(message, groups, patchGroups, room) {
        super(message);
        this.name = 'PaletteGroupsFull'; this.code = 'palette-groups-full'; this.groups = groups; this.patchGroups = patchGroups; this.room = room;
    }
}

// ---- bytes -----------------------------------------------------------------------------------------------------
let CRC_T = null;
export function crc32(b, start = 0, end = b.length) {
    if (!CRC_T) {
        CRC_T = new Uint32Array(256);
        for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

export function tileId(t) {
    let h = 0xCBF29CE484222325n;
    for (const x of t) h = ((h ^ BigInt(x)) * 0x100000001B3n) & 0xFFFFFFFFFFFFFFFFn;
    return 't' + h.toString(16).padStart(16, '0');
}

const hex8 = n => (n >>> 0).toString(16).padStart(8, '0');
const hexBytes = t => Array.from(t, x => x.toString(16).padStart(2, '0')).join('');
const cpuOff = (rom, a) => (a >>> 0) & (rom.length - 1);
export const value = (t, i) => (((t[(i >> 3) * 2] | t[(i >> 3) * 2 + 1] << 8) >> ((i & 7) * 2)) & 3);
export const shade = (plt, v) => (plt >> (2 * v)) & 3;
const anyNonZero = t => t.some(x => x);
// sums like Python's sum() of floats (3.12+ uses Neumaier's compensated summation), so ties break the same way
function nsum(xs) {
    let f = 0, c = 0;
    for (const x of xs) { const t = f + x; c += Math.abs(f) >= Math.abs(x) ? (f - t) + x : (x - t) + f; f = t; }
    return c && Number.isFinite(c) ? f + c : f;
}

// ---- BPS as ../bps_grow.py makes it (SourceCopy at fixed shifts, runs, literals) -----------------------------------
function bpsNum(out, n) {
    for (;;) { const x = n % 128; n = Math.floor(n / 128); if (n === 0) { out.push(0x80 | x); return; } out.push(x); n -= 1; }
}
export function bpsMake(src, dst, shifts = [0], minCopy = 8, minRle = 32) {
    const out = [0x42, 0x50, 0x53, 0x31];
    bpsNum(out, src.length); bpsNum(out, dst.length); bpsNum(out, 0);
    let lit = []; let srcRel = 0, dstRel = 0, i = 0;
    const flush = () => { if (lit.length) { bpsNum(out, ((lit.length - 1) * 4) + 1); for (const x of lit) out.push(x); lit = []; } };
    const rel = v => bpsNum(out, Math.abs(v) * 2 + (v < 0 ? 1 : 0));
    const LIM = 1 << 20;
    while (i < dst.length) {
        let bestN = 0, bestSh = null;
        for (const sh of shifts) {
            const j = i - sh;
            if (j >= 0 && j < src.length && src[j] === dst[i]) {
                let k = i;
                while (k < dst.length && k - sh >= 0 && k - sh < src.length && src[k - sh] === dst[k] && k - i < LIM) k++;
                if (k - i > bestN) { bestN = k - i; bestSh = sh; }
            }
        }
        let r = i;
        while (r < dst.length && dst[r] === dst[i] && r - i < LIM) r++;
        if (bestN >= minCopy && bestN >= r - i) {
            flush(); const j = i - bestSh;
            bpsNum(out, ((bestN - 1) * 4) + 2); rel(j - srcRel); srcRel = j + bestN; i += bestN;
        } else if (r - i >= minRle) {
            lit.push(dst[i]); flush(); const n = r - i - 1;
            bpsNum(out, ((n - 1) * 4) + 3); rel(i - dstRel); dstRel = i + n; i = r;
        } else { lit.push(dst[i]); i++; }
    }
    flush();
    const tail = c => { for (let k = 0; k < 4; k++) out.push((c >>> (8 * k)) & 0xFF); };
    tail(crc32(src)); tail(crc32(dst));
    const b = Uint8Array.from(out); tail(crc32(b));
    return Uint8Array.from(out);
}
export function bpsApply(src, p) {
    if (String.fromCharCode(...p.subarray(0, 4)) !== 'BPS1') throw new Error('not a BPS patch');
    let i = 4;
    const rd = () => { let d = 0, s = 1; for (;;) { const x = p[i++]; d += (x & 0x7F) * s; if (x & 0x80) return d; s *= 128; d += s; } };
    const ss = rd(), ts = rd(), ms = rd(); i += ms;
    if (ss !== src.length) throw new Error(`BPS source size ${ss}, ROM ${src.length}`);
    const out = new Uint8Array(ts); let o = 0, sr = 0, tr = 0;
    while (i < p.length - 12) {
        const d = rd(), cmd = d & 3, n = Math.floor(d / 4) + 1;
        if (cmd === 0) { out.set(src.subarray(o, o + n), o); o += n; }
        else if (cmd === 1) { out.set(p.subarray(i, i + n), o); i += n; o += n; }
        else {
            let x = rd(); x = x & 1 ? -Math.floor(x / 2) : Math.floor(x / 2);
            if (cmd === 2) { sr += x; out.set(src.subarray(sr, sr + n), o); sr += n; o += n; }
            else { tr += x; for (let k = 0; k < n; k++) out[o++] = out[tr++]; }
        }
    }
    const u32 = at => (p[at] | p[at + 1] << 8 | p[at + 2] << 16 | p[at + 3] << 24) >>> 0;
    if (o !== ts || crc32(out) !== u32(p.length - 8)) throw new Error('BPS target checksum mismatch');
    return out;
}

// ---- load sources ------------------------------------------------------------------------------------------------
function rle7(rom, at) {
    let o = cpuOff(rom, at); const out = [];
    for (;;) {
        const c = rom[o++], n = c & 0x7F;
        if (!n) break;
        if (c & 0x80) { for (let k = 0; k < n; k++) out.push(rom[o + k]); o += n; }
        else { for (let k = 0; k < n; k++) out.push(rom[o]); o += 1; }
    }
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Teleroboxer's decoder 0xFFF2C82C: u16 header (bits 0-9 tile count, bit 15 set = stored as is), then 256 symbol counts
// and an MSB-first Huffman bit stream; the tree repeatedly joins the two smallest non-zero nodes, ties to the lower index
function huffmanTr(rom, at) {
    let o = cpuOff(rom, at); const b0 = rom[o], b1 = rom[o + 1]; o += 2;
    const n = ((b1 << 8 | b0) << 4) & 0x3FFF;
    let out;
    if (b1 & 0x80) out = Array.from(rom.subarray(o, o + n));
    else {
        const freq = new Array(0x203).fill(0), left = new Array(0x203).fill(1000), right = new Array(0x203).fill(1000);
        for (let i = 0; i < 256; i++) freq[i] = rom[o + i];
        o += 256; freq[0x201] = 0xFFFF;
        let nxt = 0x101, root;
        for (;;) {
            let a = 0x201, b = 0x201;
            for (let i = 0; i < nxt; i++) {
                const f = freq[i]; if (!f) continue;
                if (f < freq[a]) { b = a; a = i; } else if (f < freq[b]) b = i;
            }
            if (b === 0x201) { root = nxt - 1; break; }
            freq[nxt] = freq[a] + freq[b]; freq[a] = 0; freq[b] = 0; left[nxt] = a; right[nxt] = b; nxt++;
        }
        out = []; let bit = 7;
        for (let k = 0; k < n; k++) {
            let cur = root;
            for (;;) {
                const v = (rom[o] >> bit) & 1; bit--;
                if (bit < 0) { bit = 7; o++; }
                cur = v ? right[cur] : left[cur];
                if (cur < 0x100) break;
            }
            out.push(cur);
        }
    }
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Space Invaders Virtual Collection's decompressor 0xFFF85866: u16 group count, then per group (two characters) 4 flag
// bytes and a fill byte; each flag bit (MSB first) takes the fill byte or the next literal. The 32 bytes alternate
// between bit plane 0 and 1 (MSB = leftmost pixel), each pair being one character row
function flagFillSi(rom, at) {
    let o = cpuOff(rom, at); const n = rom[o] | rom[o + 1] << 8; o += 2;
    const out = new Uint8Array(32 * n);
    for (let g = 0; g < n; g++) {
        const fill = rom[o + 4], planes = []; let q = o + 5;
        for (let f = 0; f < 4; f++) for (let bit = 7; bit >= 0; bit--) planes.push(rom[o + f] >> bit & 1 ? fill : rom[q++]);
        o = q;
        for (let k = 0; k < 32; k += 2) {
            let row = 0;
            for (let x = 0; x < 8; x++) row |= ((planes[k] >> (7 - x)) & 1 | ((planes[k + 1] >> (7 - x)) & 1) << 1) << (2 * x);
            out[32 * g + k] = row & 0xFF; out[32 * g + k + 1] = row >> 8;
        }
    }
    return out;
}
// Panic Bomber's LZ decompressor 0x070047C0 (`at` is the 6-byte header, byte 5 = unpacked length / 256). Flag bits MSB
// first: 1 = literal; 00 + 2 bits = 2-5 bytes from up to 256 back (one offset byte); 01 = two bytes with a 13-bit
// distance from 0x2000 and a 3-bit length + 2, where length 0 reads a length byte + 1 and a 0 there ends the stream
function lzPb(rom, at) {
    let o = cpuOff(rom, at) + 6, bits = 0x8000; const out = [];
    const bit = () => { if ((bits & 0xFFFF) === 0x8000) bits = rom[o++] << 8 | 0x80; const b = bits & 0x8000; bits = (bits << 1) >>> 0; return b !== 0; };
    for (;;) {
        if (bit()) { out.push(rom[o++]); continue; }
        let n, src;
        if (!bit()) {
            n = bit() ? 2 : 0; if (bit()) n += 1; n += 2;
            src = out.length - 256 + rom[o++];
        } else {
            const hi = rom[o], lo = rom[o + 1]; o += 2;
            src = out.length - 0x2000 + ((hi << 8 | lo) >> 3); n = lo & 7;
            if (n) n += 2; else { n = rom[o++]; if (!n) break; n += 1; }
        }
        for (let k = 0; k < n; k++, src++) out.push(src >= 0 ? out[src] : 0);
    }
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Galactic Pinball's decompressor 0xFFF417B8: control byte b (0xFF ends) = command b & 0xE0, length (b & 0x1F) + 1; 0xE0
// means command (b << 3) & 0xE0, length ((b & 3) << 8 | next) + 1. 0x00 literals, 0x20 byte run, 0x40 two bytes
// alternating, 0x60 counting byte, 0x80/0xA0 copy from output start + u16 (0xA0 inverted), 0xC0 copy from pos - byte
function lzGp(rom, at) {
    let o = cpuOff(rom, at); const out = [];
    for (;;) {
        const b = rom[o++]; if (b === 0xFF) break;
        let cmd = b & 0xE0, n;
        if (cmd === 0xE0) { cmd = (b << 3) & 0xE0; n = (((b & 3) << 8) | rom[o++]) + 1; } else n = (b & 0x1F) + 1;
        if (cmd === 0x20) { const v = rom[o++]; for (let k = 0; k < n; k++) out.push(v); }
        else if (cmd === 0x40) { const p = [rom[o], rom[o + 1]]; o += 2; for (let k = 0; k < n; k++) out.push(p[k & 1]); }
        else if (cmd === 0x60) { const v = rom[o++]; for (let k = 0; k < n; k++) out.push((v + k) & 0xFF); }
        else if (cmd === 0x80 || cmd === 0xA0) { const p = rom[o] | rom[o + 1] << 8; o += 2; for (let k = 0; k < n; k++) out.push(cmd === 0xA0 ? out[p + k] ^ 0xFF : out[p + k]); }
        else if (cmd === 0xC0) { const d = rom[o++]; for (let k = 0; k < n; k++) out.push(out[out.length - d]); }
        else { for (let k = 0; k < n; k++) out.push(rom[o + k]); o += n; }
    }
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Vertical Force's byte-pair decompressor 0x0701D3EC: 'BP', u16 output size, u16 packed size, then blocks of a pair
// table (a count byte > 127 skips count - 127 codes, else count + 1 codes follow with their left byte and, unless that
// is the code itself, their right byte), a big-endian u16 length and that many codes, expanded through a stack
function bpVf(rom, at) {
    let p = cpuOff(rom, at);
    const outlen = rom[p + 2] | rom[p + 3] << 8, end = p + 6 + (rom[p + 4] | rom[p + 5] << 8); p += 6;
    const out = [], left = new Uint8Array(256), right = new Uint8Array(256);
    while (p < end && out.length < outlen) {
        for (let i = 0; i < 256; i++) { left[i] = i; right[i] = 0; }
        let c = 0, count = rom[p++];
        for (;;) {
            if (count > 127) { c += count - 127; count = 0; }
            if (c === 256) break;
            for (let k = 0; k <= count; k++) { left[c] = rom[p++]; if (left[c] !== c) right[c] = rom[p++]; c++; }
            if (c === 256) break;
            count = rom[p++];
        }
        let size = rom[p] << 8 | rom[p + 1]; p += 2;
        const stack = [];
        for (;;) {
            let x;
            if (stack.length) x = stack.pop();
            else { if (!size) break; size--; x = rom[p++]; }
            if (left[x] === x) out.push(x); else { stack.push(right[x]); stack.push(left[x]); }
        }
    }
    out.length = Math.min(out.length, outlen);
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Space Squash's decompressor 0xFFF800E4: u16 output size, u16 packed size, then groups of a flag byte (MSB first) and
// eight items, each a literal byte (0) or a u16 back-reference (1: bits 3-0 length - 3, bits 15-4 distance - 1)
function lzSs(rom, at) {
    let o = cpuOff(rom, at); const n = rom[o] | rom[o + 1] << 8, out = []; o += 4;
    while (out.length < n) {
        const flags = rom[o++];
        for (let bit = 7; bit >= 0 && out.length < n; bit--) {
            if (flags >> bit & 1) {
                const w = rom[o] | rom[o + 1] << 8; o += 2;
                const ln = Math.min((w & 15) + 3, n - out.length), d = (w >> 4) + 1;
                for (let k = 0; k < ln; k++) out.push(out[out.length - d]);
            } else out.push(rom[o++]);
        }
    }
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Virtual Bowling's LZ decompressor 0xFFF054B6: 2 skipped bytes, the output length - 2 (big-endian u16), then groups of
// a flag byte (LSB first, 1 = literal) and eight items; a reference is two bytes, the first's low nibble the length - 3,
// its high nibble | the second byte << 4 the distance back (zeros before the output's start)
function lzVbw(rom, at) {
    let o = cpuOff(rom, at) + 2, left = (rom[o] << 8) + 1 + rom[o + 1]; o += 2;
    const out = [];
    for (;;) {
        let flags = rom[o++];
        for (let k = 0; k < 8; k++, flags >>= 1) {
            const b = rom[o++];
            if (flags & 1) { out.push(b); left--; }
            else {
                const dist = (b >> 4) | (rom[o++] << 4); let n = (b & 15) + 3;
                left -= n; if (left < 0) n += left;
                const s = out.length - dist;
                for (let q = 0; q < n; q++) out.push(s + q >= 0 ? out[s + q] : 0);
            }
            if (left < 0) { while (out.length % 16) out.push(0); return Uint8Array.from(out); }
        }
    }
}
// Nester's Funky Bowling's LZSS 0xFFE01176 (Okumura's): u32 packed length, u32 output length, a 4 KiB ring of spaces
// from 0xFEE; flag bits LSB first, 1 = literal, 0 = two bytes with a 12-bit ring position (low byte + high nibble of the
// second) and the length - 3 in the low nibble; it ends with the packed bytes
function lzNfb(rom, at) {
    const o = cpuOff(rom, at), clen = (rom[o] | rom[o + 1] << 8 | rom[o + 2] << 16 | rom[o + 3] << 24) >>> 0;
    let i = o + 8, r = 0xFEE, flags = 0; const end = i + clen, ring = new Uint8Array(4096).fill(0x20), out = [];
    while (i < end) {
        flags >>= 1;
        if (!(flags & 0x100)) { flags = rom[i++] | 0xFF00; if (i >= end) break; }
        if (flags & 1) { const c = rom[i++]; out.push(c); ring[r] = c; r = (r + 1) & 0xFFF; }
        else {
            if (i + 1 >= end) break;
            const a = rom[i], b = rom[i + 1]; i += 2;
            const p = a | (b & 0xF0) << 4, n = (b & 0xF) + 3;
            for (let k = 0; k < n; k++) { const c = ring[(p + k) & 0xFFF]; out.push(c); ring[r] = c; r = (r + 1) & 0xFFF; }
        }
    }
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Virtual League Baseball's decoder 0x07000A74: a first byte 0 means RLE, a u16 count of (value, length) pairs (length
// 0 = 256); else LZSS with a u16 token count, flag bits LSB first (1 = literal, 0 = 12-bit window position + 4-bit
// length - 3, packed as in lzNfb) and a 4 KiB window of zeros from 0xFEE
function lzVlb(rom, at) {
    let o = cpuOff(rom, at); const out = [];
    if (rom[o++] === 0) {
        const n = rom[o] | rom[o + 1] << 8; o += 2;
        for (let k = 0; k < n; k++, o += 2) { const v = rom[o], c = rom[o + 1] || 256; for (let q = 0; q < c; q++) out.push(v); }
    } else {
        let tokens = rom[o] | rom[o + 1] << 8; o += 2;
        const win = new Uint8Array(4096); let r = 0xFEE;
        outer: for (;;) {
            let flags = rom[o++];
            for (let b = 0; b < 8; b++, flags >>= 1) {
                if (flags & 1) { const c = rom[o++]; out.push(c); win[r] = c; r = (r + 1) & 0xFFF; }
                else {
                    const p = rom[o] | (rom[o + 1] & 0xF0) << 4, n = (rom[o + 1] & 15) + 3; o += 2;
                    for (let k = 0; k < n; k++) { const c = win[(p + k) & 0xFFF]; out.push(c); win[r] = c; r = (r + 1) & 0xFFF; }
                }
                if (--tokens === 0) break outer;
            }
        }
    }
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Virtual League Baseball 2's decoder 0x070012A8 / 0x070013EA: u16 words until 0xFFFF; with bit 15 set the next
// halfword repeats (w & 0x7FFF) times, else (w & 0x7FFF) literal halfwords follow
function rleVlb2(rom, at) {
    let o = cpuOff(rom, at); const out = [];
    for (;;) {
        const w = rom[o] | rom[o + 1] << 8; o += 2;
        if (w === 0xFFFF) break;
        const n = w & 0x7FFF;
        if (w & 0x8000) { for (let k = 0; k < n; k++) out.push(rom[o], rom[o + 1]); o += 2; }
        else { for (let k = 0; k < 2 * n; k++) out.push(rom[o + k]); o += 2 * n; }
    }
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Golf's software sprites, which the CPU blits into the frame buffer: u16 w, u8 h, u8 type, u16 size, then at +8 the
// image and the mask, 2 bits per pixel, column by column. A pixel is drawn where the mask is 0 or the image has bits
// (the blit ANDs the mask, then ORs the image); the tiles are ceil(w / 8) x ceil(h / 8) characters, row by row
function golfSprite(rom, at) {
    const o = cpuOff(rom, at), w = rom[o] | rom[o + 1] << 8, h = rom[o + 2], sz = (w * h * 2 + 7) >> 3;
    const bit = (base, n) => (rom[base + (n >> 2)] >> ((n & 3) * 2)) & 3;
    const px = new Uint8Array(w * h), drawn = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
        const n = x * h + y, v = bit(o + 8, n);
        px[y * w + x] = v; drawn[y * w + x] = v || !bit(o + 8 + sz, n) ? 1 : 0;
    }
    const tw = (w + 7) >> 3, th = (h + 7) >> 3, tiles = new Uint8Array(16 * tw * th);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const t = ((y >> 3) * tw + (x >> 3)) * 16 + (y & 7) * 2 + ((x & 7) >> 2);
        tiles[t] |= px[y * w + x] << ((x & 3) * 2);
    }
    return { w, h, tw, th, px, drawn, tiles };
}
// a Golf sprite's colours as the runtime paints them into the Color Frame Buffer (table option runs: "golf"): a u16
// offset per column (padded to 4), then per column a u8 count of (row, length, palette) runs. A pixel's palette is its
// slot image's, else its tile group's first; pixels not drawn or cut out (0xFF) get no run
function golfRuns(sp, entryOf) {
    const { w, h, tw, drawn } = sp, cols = [];
    for (let x = 0; x < w; x++) {
        const rs = []; let cur = null;
        for (let y = 0; y < h; y++) {
            let pal = -1;
            if (drawn[y * w + x]) {
                const e = entryOf((y >> 3) * tw + (x >> 3)), i = (y & 7) * 8 + (x & 7);
                const b = e && e.img ? e.img[i] : 0;
                pal = b === 0xFF ? -1 : b || ((e ? e.w : 0) & 0xFF) * 4;
            }
            if (pal >= 0 && cur && cur[2] === pal && cur[0] + cur[1] === y) cur[1]++;
            else if (pal >= 0) rs.push(cur = [y, 1, pal]);
            else cur = null;
        }
        cols.push([rs.length, ...rs.flat()]);
    }
    const head = 2 * w + (2 * w) % 4, body = cols.reduce((n, c) => n + c.length, 0), out = new Uint8Array(head + body);
    let at = head;
    cols.forEach((c, x) => { out[2 * x] = at & 0xFF; out[2 * x + 1] = at >> 8; out.set(c, at); at += c.length; });
    return out;
}
// a picture of characters drawn into the Color Frame Buffer at a fixed place (table option runs: "golf-strip", Golf's
// mountain strip; tab.w / tab.h in pixels): one palette byte per pixel, column by column, and 0xFF where nothing is
// drawn (value 0 without a slot palette of its own, so the sky shows through)
function golfStrip(tab, entryOf, tileOf) {
    const { w, h } = tab, tw = w >> 3, out = new Uint8Array(w * h).fill(0xFF);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
        const k = (y >> 3) * tw + (x >> 3), i = (y & 7) * 8 + (x & 7), e = entryOf(k), t = tileOf(k);
        const v = t ? value(t, i) : 0, b = e && e.img ? e.img[i] : 0;
        if (b === 0xFF || (!v && !(e && e.opq && b))) continue;
        out[x * h + y] = b || ((e ? e.w : 0) & 0xFF) * 4;
    }
    return out;
}
// Jack Bros' decompressor 0x07003AF4: b0 <= 0x7F plus b1 copies (b0 >> 2) + 2 bytes from ((b0 & 3) << 8 | b1) - 1024
// back (0x7F 0xFF ends); 0xFF writes next + 32 zeros; else n = (b0 & 0x1F) + 1 and b0 & 0x60 picks n literals (0x00),
// n bytes each after a zero (0x20), the next byte n + 1 times (0x40) or n zeros (0x60)
function lzJb(rom, at) {
    let p = cpuOff(rom, at); const out = [];
    for (;;) {
        const b0 = rom[p];
        if (b0 <= 0x7F) {
            const b1 = rom[p + 1];
            if ((b0 | b1 << 8) === 0xFF7F) break;
            const n = (b0 >> 2) + 2, s = out.length + ((((b0 & 3) << 8) | b1) - 1024);
            for (let i = 0; i < n; i++) out.push(s + i >= 0 ? out[s + i] : 0);
            p += 2;
        } else if (b0 === 0xFF) {
            for (let i = rom[p + 1] + 32; i > 0; i--) out.push(0);
            p += 2;
        } else {
            const n = (b0 & 0x1F) + 1, t = b0 & 0x60;
            if (t === 0x00) { for (let i = 0; i < n; i++) out.push(rom[p + 1 + i]); p += 1 + n; }
            else if (t === 0x60) { for (let i = 0; i < n; i++) out.push(0); p += 1; }
            else if (t === 0x20) { for (let i = 0; i < n; i++) out.push(0, rom[p + 1 + i]); p += 1 + n; }
            else { for (let i = 0; i <= n; i++) out.push(rom[p + 1]); p += 2; }
        }
    }
    while (out.length % 16) out.push(0);
    return Uint8Array.from(out);
}
// Faceball's LZ decompressor 0x07007E72 (NikoChan Battle): u16 halfword count, then groups of 16 items under a u16 of
// flags (MSB first); a set flag is a u16 back-reference (halfword offset << 4 | length - 2, zeros before the start),
// a clear one a literal halfword
function lzFb(rom, at) {
    let a = cpuOff(rom, at), n = rom[a] | rom[a + 1] << 8, i = 0, flags = 0; a += 2;
    const out = [];
    while (n > 0) {
        if (i % 16 === 0) { flags = rom[a] | rom[a + 1] << 8; a += 2; }
        i++;
        if (flags & 0x8000) {
            const w = rom[a] | rom[a + 1] << 8; a += 2;
            const off = (w >> 4) & 0xFFF, ln = (w & 15) + 2, p = out.length - off;
            for (let k = 0; k < ln; k++) out.push(p + k >= 0 ? out[p + k] : 0);
            n -= ln;
        } else { out.push(rom[a] | rom[a + 1] << 8); a += 2; n -= 1; }
        flags = (flags << 1) & 0xFFFF;
    }
    const b = new Uint8Array(Math.ceil(out.length * 2 / 16) * 16);
    out.forEach((v, k) => { b[2 * k] = v & 0xFF; b[2 * k + 1] = v >> 8; });
    return b;
}
// Mario's Tennis: the players' pose streams (upload routine 0xFFF838E4: per 16 halfwords an MSB-first control halfword,
// 1 = previous halfword again, 0 = next halfword; `n` bytes, default 1024) and LZSS streams (0xFFF8135C, laid out like
// lzVbw's)
function rle16Mt(rom, at, n = 1024) {
    const m = rom.length - 1, out = new Uint8Array(n); let p = cpuOff(rom, at), last = 0, k = 0;
    while (k < n) {
        let ctrl = rom[p & m] | rom[(p + 1) & m] << 8; p += 2;
        for (let j = 0; j < 16 && k < n; j++) {
            if (!(ctrl & 0x8000)) { last = rom[p & m] | rom[(p + 1) & m] << 8; p += 2; }
            out[k++] = last & 255; out[k++] = last >> 8; ctrl = (ctrl << 1) & 0xFFFF;
        }
    }
    return out;
}
function lzssMt(rom, at) {
    const m = rom.length - 1; let p = cpuOff(rom, at) + 2, left = (rom[p & m] << 8) + 1 + rom[(p + 1) & m]; p += 2;
    const out = [];
    for (;;) {
        let flags = rom[p++ & m];
        for (let j = 0; j < 8; j++) {
            const b = rom[p++ & m];
            if (flags & 1) { out.push(b); left--; }
            else {
                const dist = (rom[p++ & m] << 4) | (b >> 4); let n = (b & 15) + 3;
                left -= n; if (left < 0) n += left;
                let src = out.length - dist;
                if (src < 0) { const z = Math.min(-src, n); for (let q = 0; q < z; q++) out.push(0); n -= z; src = 0; }
                for (let q = 0; q < n; q++) out.push(out[src + q] ?? 0);   // distance 0 reads zeros
            }
            flags >>= 1;
            if (left < 0) { while (out.length & 15) out.push(0); return Uint8Array.from(out); }
        }
    }
}
// decode "pick": tiles picked out of other decoded sources (`sources`: [{decode, at, ...}], `picks`: flat [source,
// index, ...]), so a table can list one owner's tiles from many streams
const pickCache = new WeakMap();
function pickSlots(rom, tab) {
    let cache = pickCache.get(rom); if (!cache) pickCache.set(rom, cache = new Map());
    const src = tab.sources.map(S => {
        const id = JSON.stringify(S); let d = cache.get(id);
        if (!d) cache.set(id, d = slots(rom, { ...S, key: '{i}' }).map(x => x.t));
        return d;
    });
    const out = [];
    for (let k = 0; k < tab.picks.length; k += 2) out.push({ key: tab.key.replace('{i}', String(k >> 1)), t: src[tab.picks[k]][tab.picks[k + 1]] });
    return out;
}

export function slots(rom, tab) {
    if (tab.decode === 'pick') return pickSlots(rom, tab);
    if (tab.decode === 'rle16-mt' || tab.decode === 'lzss-mt') {
        const d = tab.decode === 'rle16-mt' ? rle16Mt(rom, tab.at, tab.n) : lzssMt(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'lz-fb') {
        const d = lzFb(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'lz-jb') {
        const d = lzJb(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'lz-vlb') {
        const d = lzVlb(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'sprite-golf') {
        const d = golfSprite(rom, tab.at).tiles, out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'rle-vlb2') {
        const d = rleVlb2(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'lz-nfb') {
        const d = lzNfb(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'lz-vbw') {
        const d = lzVbw(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'lz-ss') {
        const d = lzSs(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'bp-vf') {
        const d = bpVf(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'lz-gp') {
        const d = lzGp(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'lz-pb') {
        const d = lzPb(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'flagfill-si') {
        const d = flagFillSi(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'rle7') {
        const d = rle7(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'huffman-tr') {
        const d = huffmanTr(rom, tab.at), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'bytes') {
        const d = Uint8Array.from(tab.bytes.match(/../g).map(x => parseInt(x, 16))), out = [];
        for (let k = 0; k * 16 < d.length; k++) out.push({ key: tab.key.replace('{i}', String(k)), t: d.subarray(16 * k, 16 * k + 16) });
        return out;
    }
    if (tab.decode === 'raw') {
        const out = [];
        for (let a = tab.at; a < tab.end; a += tab.step) {
            const o = cpuOff(rom, a);
            out.push({ key: tab.key.replace('{a}', hex8(a)).replace('{i}', String(out.length)), t: rom.subarray(o, o + 16) });
        }
        return out;
    }
    throw new Error('unknown decode ' + tab.decode);
}

// ---- colours -----------------------------------------------------------------------------------------------------
const rgb888 = h => parseInt(h.slice(1, 3), 16) | parseInt(h.slice(3, 5), 16) << 8 | parseInt(h.slice(5, 7), 16) << 16;
const lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const gam = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
const roundEven = x => { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 ? f + 1 : f); };
function scaled(h, f) {
    if (f === 1) return h;
    let s = '#';
    for (const k of [1, 3, 5]) s += roundEven(255 * gam(Math.min(1, lin(parseInt(h.slice(k, k + 2), 16) / 255) * f))).toString(16).padStart(2, '0');
    return s;
}

function parseCtx(k) { const [side, sel, plt] = k.split('/'); return { side: +side, sel: +sel, plt: parseInt(plt, 16) }; }

function readUnits(list) {
    const units = [];
    // ways with the same pixels share one array (Virtual League Baseball 2 has 3.5 million ways, 0.27 million distinct);
    // paintUnit copies a unit's arrays before writing them
    const seenW = new Map();
    for (const rec of list) {
        const cols = rec.c || [];
        const dec = s => {
            const key = s + '|' + cols.join(',');
            let W = seenW.get(key);
            if (!W) seenW.set(key, W = Array.from(s, ch => ch === '.' ? null : cols[AIDX[ch]]));
            return W;
        };
        const ctx = rec.ctx.map(([k, w, s, painted]) => ({ k, w, ...parseCtx(k), W: dec(s), painted: !!painted }));
        let z = null;
        if (rec.z) { z = new Map(); dec(rec.z).forEach((h, i) => { if (h) z.set(i, h); }); }
        units.push({ id: rec.id, kind: rec.id.includes(':') ? 1 : 0, o: rec.o, seen: rec.seen !== 0, ctx, z, noslot: !!rec.noslot,
                     ...(rec.ramp ? { ramp: true } : {}), ...(rec.extras_only ? { extrasOnly: true } : {}),
                     ...(rec.d ? { d: rec.d } : {}) });
    }
    return units;
}

function applyPaint(layer, ctxOf, P, stats) {
    const { keySlot, keyUnits, tileUnits } = ctxOf;
    for (const [key, ctxs] of Object.entries(layer.tiles || {})) {
        if (key.startsWith('cell#')) continue;                      // cell paint is handled by paintCells
        const slot = keySlot.get(key);
        if (!slot) throw new Error(`painted load position ${key} is not in the package's tables`);
        const t = slot.t;
        let u = keyUnits.get(key);
        if (!u) {                                                   // a unit of its own, like the reference screens'
            const base = anyNonZero(t) ? tileUnits.get(tileId(t)) : null;
            u = { id: key, kind: 1, t, o: base ? base.o : 0, seen: true, z: base && base.z ? new Map(base.z) : null,
                  ctx: base && base.seen ? base.ctx.map(c => ({ ...c, W: c.W.slice() })) : [] };
            if (base?.d) u.d = base.d;                              // its group's ramp (allocate: u.keep)
            keyUnits.set(key, u);
        }
        stats['painted load positions'] = (stats['painted load positions'] || 0) + 1;
        // a load position no survey saw has no known way of drawing, so its paint counts for Cells and Objects alike
        // (the editor offers it drawn as a Cell)
        const known = u.ctx.length > 0;
        paintUnit(u, t, known ? ctxs : { ...ctxs, ...Object.fromEntries(Object.entries(ctxs)
            .map(([k, l]) => [`${1 - +k.split('/')[0]}/${k.split('/').slice(1).join('/')}`, l]).filter(([k]) => !(k in ctxs))) }, P);
    }
}

// paints a layer's shared keys over one context's units. pkg.shared lists figures that look the same wherever the
// package shows them (Bound High's Chalvo in every stage); '<shared id>:k:<n>' paints every member of character n like
// '<context>:k:<character>' would, before the context's own paint, which wins where both paint a pixel
function paintShared(layer, shared, C, keySlot, keyUnits, P, stats) {
    for (const S of shared || []) {
        const prefix = S.id + ':k:';
        for (const [key, ctxs] of Object.entries(layer.tiles || {})) {
            if (!key.startsWith(prefix)) continue;
            const n = key.slice(prefix.length);
            if (!S.members?.[n]) throw new Error(`painted shared character ${key} is not in the package`);
            for (const [cid, c] of S.members[n]) {
                if (cid !== C.id) continue;
                if (typeof c === 'string' && /^[mc]:/.test(c)) continue;      // cell keys are handled by contextCellPaint
                if (typeof c === 'string') {
                    // watched content ('t<tile id>', Wario Land's Wario), painted like the key '<context>:t<tile id>'
                    const targets = [...keyUnits.values()].filter(u => u.id.startsWith('w:') && tileId(u.t) === c);
                    if (!targets.length) throw new Error(`shared character ${key}: context ${C.id}'s watch has no tile ${c}`);
                    for (const u of targets) paintUnit(u, u.t, ctxs, P);
                    stats['painted load positions'] = (stats['painted load positions'] || 0) + 1;
                    continue;
                }
                const slot = keySlot.get('k:' + c);
                if (!slot) throw new Error(`shared character ${key}: context ${C.id} has no character ${c}`);
                let u = keyUnits.get('k:' + c);
                if (!u) {
                    let o = 0; for (let i = 0; i < 64; i++) if (value(slot.t, i)) o++;
                    u = { id: 'k:' + c, kind: 1, t: slot.t, o, seen: true, z: null, ctx: [] };
                    keyUnits.set(u.id, u);
                }
                paintUnit(u, u.t, ctxs, P);
                stats['painted load positions'] = (stats['painted load positions'] || 0) + 1;
            }
        }
    }
}

// paints a layer over one context's units; keys are '<context id>:k:<character>' (a character by index) and
// '<context id>:t<tile id>' (the watch's tiles with that content, see tileId)
function paintContext(layer, C, keySlot, keyUnits, P, stats) {
    const prefix = C.id + ':';
    for (const [key, ctxs] of Object.entries(layer.tiles || {})) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length), targets = [];
        if (rest.startsWith('m:') || rest.startsWith('c:')) continue;   // BG map cells are handled by contextCellPaint
        if (rest.startsWith('k:')) {
            const slot = keySlot.get(rest);
            if (!slot) throw new Error(`painted character ${key} is not in context ${C.id}`);
            let u = keyUnits.get(rest);
            if (!u) {
                let o = 0; for (let i = 0; i < 64; i++) if (value(slot.t, i)) o++;
                u = { id: rest, kind: 1, t: slot.t, o, seen: true, z: null, ctx: [] };
                keyUnits.set(rest, u);
            }
            targets.push(u);
        } else {
            for (const u of keyUnits.values()) if (u.id.startsWith('w:') && tileId(u.t) === rest) targets.push(u);
            if (!targets.length) throw new Error(`painted tile ${key} is not in context ${C.id}'s watch`);
        }
        for (const u of targets) paintUnit(u, u.t, ctxs, P);
        stats['painted load positions'] = (stats['painted load positions'] || 0) + 1;
    }
}

// lays the paint of a unit's ways of drawing ({way: 64 colours}) over it: painted ways take the paint, the others the
// painted colour at their shade
function paintUnit(u, t, ctxs, P) {
    const painted = [];
    for (const c of u.ctx) c.W = c.W.slice();                       // readUnits shares equal arrays between units
    for (const [k, lst] of Object.entries(ctxs)) {
        let c = u.ctx.find(x => x.k === k);
        if (!c) { c = { k, w: 0, ...parseCtx(k), W: new Array(64).fill(null), painted: false }; u.ctx.push(c); }
        if (!c.painted) { c.w0 = c.w; c.w += 1000; c.painted = true; }
        const before = c.W.slice();
        for (let i = 0; i < 64; i++) {
            const h = lst[i]; if (h == null) continue;
            const v = value(t, i);
            // a pixel this way puts at shade 0 (a fade, a hidden layer) keeps its colour, since a palette's shade 0 is
            // shared with everything drawn there (the backdrop too); the paint counts as the pixel's lit colour (below)
            if (v && shade(c.plt, v) === 0 && h !== '') continue;
            // on a value-0 pixel a colour makes it opaque (z) and '' (the eraser) transparent again; '' stays in z because
            // a table whose runtime draws value 0 itself (`opq`) cuts the pixel out, elsewhere it is just left out
            if (v) c.W[i] = h; else (u.z ??= new Map()).set(i, h);
        }
        painted.push({ c, lst, before });
    }
    painted.sort((a, b) => a.c.k < b.c.k ? -1 : a.c.k > b.c.k ? 1 : 0);
    const set = new Set(painted.map(p => p.c));
    for (let i = 0; i < 64; i++) {
        const v = value(t, i); if (!v) continue;
        if (!painted.some(p => p.lst[i] != null && p.lst[i] !== p.before[i])) continue;
        const atShade = new Map(); let nat = null, dark = null;
        for (const p of painted) {
            if (p.lst[i] == null) continue;
            const s = shade(p.c.plt, v);
            if (!s) { if (dark == null && p.lst[i] !== '') dark = p.lst[i]; continue; }   // painted where it shows shade 0
            if (!atShade.has(s)) atShade.set(s, p.lst[i]);
            if (s === v && nat == null) nat = p.lst[i];
        }
        if (nat == null && !atShade.size) nat = dark;
        for (const c of u.ctx) {
            if (c.painted || set.has(c)) continue;
            const s = shade(c.plt, v);
            if (!s) continue;                                        // shade 0 keeps the package's colour
            const h = atShade.get(s) ?? (nat ? scaled(nat, P.intens[s] / P.intens[v]) : undefined);
            if (h !== undefined) c.W[i] = h;
        }
    }
}

// paint key of a BG map cell that a cell list colours (the editor's sheets name it per part):
// 'cell#<list>#<cell>#<load position of its character>' -> {list, cell, tile}, null for any other key
export function cellKey(key) {
    if (!key.startsWith('cell#')) return null;
    const [, list, cell, ...tile] = key.split('#');
    return { list, cell: +cell, tile: tile.join('#') };
}
export const makeCellKey = (list, cell, tile) => `cell#${list}#${cell}#${tile}`;

// context paint keys for BG map cells coloured per cell (README "Contexts", cell paint) -> {ctx, kind, map, cell?, chr}:
// '<ctx>:m:<map>:<chr>' is every cell of the character in a 'const'/'table' map without cell requests (it turns CHRSEL);
// '<ctx>:c:<map>:<cell>:<chr>' one cell, whose ramps change so other animation frames in that cell keep their shades
export function contextCellKey(key) {
    const m = /^(\d+):(m|c):(\d+):(?:(\d+):)?(\d+)$/.exec(key);
    if (!m || (m[2] === 'c') !== (m[4] !== undefined)) return null;
    return { ctx: +m[1], kind: m[2], map: +m[3], ...(m[2] === 'c' ? { cell: +m[4] } : {}), chr: +m[5] };
}

// maps a sheet part's character key '<context>:k:<n>' and cell (map * 4096 + cell) to its cell paint key: 'c:' where the
// context has cell requests on the map, 'm:' where it rules the map 'const'/'table' without them, else null (CHRSEL or
// unruled maps). Overlay keys get 'c:' for cells the overlay colours that hold a character of fixed content
export function contextCellKeys(pkg) {
    const info = new Map();
    return (key, cell) => {
        const k = /^(\d+):k:(\d+)$/.exec(key);
        if (!k || cell === undefined || cell === null || cell < 0 || cell >= 14 * 4096) return null;
        const id = +k[1];
        let I = info.get(id);
        if (!I) {
            const C = (pkg.contexts || []).find(x => x.id === id), O = !C ? overlayKeys(pkg).get(id) : null;
            I = C ? { modes: new Map((C.maps || []).map(R => [R.map, R.mode])), req: new Set((C.cells || []).map(c => c[0]).filter(m => m !== 'obj')) }
                : O ? { ov: new Set((O.cells || []).filter(c => c[2] && c[2] !== 'chrsel').map(c => c[0] * 4096 + c[1])),
                        fixed: c => !!(O.cell_tiles?.[c] ?? O.tiles?.[c]) && !(O.changing || []).includes(+c) } : null;
            info.set(id, I);
        }
        if (!I) return null;
        if (I.ov) return I.ov.has(cell) && I.fixed(k[2]) ? `${id}:c:${cell >> 12}:${cell & 0xFFF}:${k[2]}` : null;
        const map = cell >> 12, mode = I.modes.get(map);
        if (I.req.has(map)) return `${id}:c:${map}:${cell & 0xFFF}:${k[2]}`;
        return mode === 'const' || mode === 'table' ? `${id}:m:${map}:${k[2]}` : null;
    };
}

// context or overlay paint that does not fit the runtime (README "Contexts", cell paint): `code` 'context-slots-full',
// 'context-palettes-full' or 'context-cell-paint', `context` its name; VUEPort words it in vb-color-package.ts
// colorBuildErrorText
export class ContextPaintError extends Error {
    constructor(code, context, detail) {
        super(`context ${context}: ${detail}`);
        this.name = 'ContextPaintError'; this.code = code; this.context = context; this.detail = detail;
    }
}

function contextCellPaint(layers, C, shared) {
    const maps = new Map(), cells = new Map();
    const merge = (to, ways) => { for (const [way, px] of Object.entries(ways)) { const o = to[way] ??= new Array(64).fill(null); px.forEach((h, i) => { if (h != null) o[i] = h; }); } };
    // shared keys whose members name a context cell key ('m:...' or 'c:...', e.g. Dragon Hopper's enemies on BG maps the
    // context colours per cell) paint it like that key would, before the context's own paint
    const viaShared = layer => {
        const out = [];
        for (const S of shared || []) {
            const prefix = S.id + ':k:';
            for (const [key, ways] of Object.entries(layer.tiles || {})) {
                if (!key.startsWith(prefix)) continue;
                for (const [cid, c] of S.members?.[key.slice(prefix.length)] || [])
                    if (cid === C.id && typeof c === 'string' && /^[mc]:/.test(c)) out.push([`${cid}:${c}`, ways]);
            }
        }
        return out;
    };
    for (const layer of layers || []) for (const [key, ways] of [...viaShared(layer), ...Object.entries(layer.tiles || {})]) {
        const k = contextCellKey(key); if (!k || k.ctx !== C.id) continue;
        if (k.kind === 'm') {
            const m = maps.get(k.map) || new Map(); maps.set(k.map, m);
            const w = m.get(k.chr) || {}; m.set(k.chr, w); merge(w, ways);
        } else {
            const id = k.map + ':' + k.cell, e = cells.get(id) || { map: k.map, cell: k.cell, chrs: new Map() }; cells.set(id, e);
            const w = e.chrs.get(k.chr) || {}; e.chrs.set(k.chr, w); merge(w, ways);
        }
    }
    return { maps, cells };
}

// an overlay's paint key id (README "Overlays"): params.overlay_key0 (default 0x7000) + the overlay id, so its keys look
// like a context's (VUEPort reads the number before the first colon); every record with that id takes the paint
export function overlayKeyId(pkg, id) {
    return (pkg?.params?.overlay_key0 ?? 0x7000) + id;
}

export function overlayKeys(pkg) {
    const out = new Map();
    for (const O of pkg?.overlays || []) { const k = overlayKeyId(pkg, O.id); if (!out.has(k)) out.set(k, O); }
    return out;
}

function overlayPaint(layers, O, okey, keyUnits, ovErr) {
    const units = new Map(), cells = new Map(), prefix = okey + ':';
    const merge = (to, ways) => { for (const [way, px] of Object.entries(ways)) { const o = to[way] ??= new Array(64).fill(null); px.forEach((h, i) => { if (h != null) o[i] = h; }); } };
    const wants = new Map((O.cells || []).map(([m, c, w]) => [m * 4096 + c, w]));
    const changing = new Set((O.changing || []).map(Number));
    const tile = c => { const h = O.cell_tiles?.[c] ?? O.tiles?.[c]; return h ? Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16))) : null; };
    for (const layer of layers || []) for (const [key, ways] of Object.entries(layer.tiles || {})) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.startsWith('k:')) {
            const u = keyUnits.get(rest), chr = rest.slice(2);
            if (!u) throw ovErr('context-cell-paint', `character ${chr} is not drawn by character here`);
            if (u.noslot || changing.has(+chr)) throw ovErr('context-cell-paint', `character ${chr} changes its content here`);
            const w = units.get(rest) || {}; units.set(rest, w); merge(w, ways);
            continue;
        }
        const k = contextCellKey(key);
        if (!k || k.kind !== 'c') throw ovErr('context-cell-paint', `no such key ${key}`);
        const cell = k.map * 4096 + k.cell, want = wants.get(cell);
        if (!want || want === 'chrsel') throw ovErr('context-cell-paint', `cell ${k.cell} of map ${k.map} is not coloured here`);
        if (changing.has(k.chr)) throw ovErr('context-cell-paint', `character ${k.chr} changes its content here`);
        if (!tile(k.chr)) throw ovErr('context-cell-paint', `no tile for character ${k.chr}`);
        const e = cells.get(cell) || { cell, chrs: new Map() }; cells.set(cell, e);
        const w = e.chrs.get(k.chr) || {}; e.chrs.set(k.chr, w); merge(w, ways);
    }
    // a unit with `paint_as` (Dragon Hopper's magic menu: the status line's icon, a copy of the selected card in characters
    // of their own) takes the paint of the character it copies, where that is painted
    for (const u of O.units || []) {
        if (!u.paint_as || !units.has(u.paint_as) || !keyUnits.has(u.id)) continue;
        const w = units.get(u.id) || {}; units.set(u.id, w); merge(w, units.get(u.paint_as));
    }
    // in the form of allocate's req.cellPaint
    const cp = [...cells.values()].sort((a, b) => a.cell - b.cell).map(e => {
        const paints = [];
        for (const [chr, ways] of e.chrs) for (const [way, px] of Object.entries(ways)) { const { side, sel, plt } = parseCtx(way); if (!side) paints.push({ t: tile(chr), sel, plt, px }); }
        return { name: 'cells', cell: e.cell, base: null, paints };
    });
    return { units, cells: cp };
}

// counts the painted character pixels that the overlay's compiled palettes do not show
function overlayPaintShort(A, keyUnits, OP) {
    const cram = A.crams[0][1];
    const at = (p, s) => { const q = 16 * p + 4 * s; return '#' + [cram[q], cram[q + 1], cram[q + 2]].map(x => x.toString(16).padStart(2, '0')).join(''); };
    let short = 0;
    for (const [id, ways] of OP.units) {
        const u = keyUnits.get(id), e = A.out.get(u.uk); if (!e) continue;
        for (const [way, px] of Object.entries(ways)) {
            const { side, sel, plt } = parseCtx(way);
            for (let i = 0; i < 64; i++) {
                const h = px[i], v = value(u.t, i), s = shade(plt, v);
                if (!v || !s || !h || h[0] !== '#') continue;
                const p = e.img && e.img[i] && e.img[i] !== 0xFF ? e.img[i] : ((side ? e.w >> 8 : e.w) & 0x3F) * 4 + sel;
                if (at(p, s) !== h.toLowerCase()) short++;
            }
        }
    }
    return short;
}

// applies the layers' cell keys to the cell requests: each painted cell's request (the last in its list, which the
// runtime ends with) gets a slot of its own, each pixel showing the painted colour ('' leaves it out) or what it showed
// before. Only 8-byte lists hold slots; 4-byte lists' cells move via pkg.cell_promote, else they count as not paintable
function paintCells(pkg, layers, keySlot, stats) {
    const painted = new Map();                                       // 'list#cell' -> {list, cell, tile, ways}
    for (const layer of layers) for (const [key, ways] of Object.entries(layer.tiles || {})) {
        const c = cellKey(key); if (!c) continue;
        if (!keySlot.has(c.tile)) throw new Error(`painted cell ${key}: no such load position`);
        const id = c.list + '#' + c.cell;
        const e = painted.get(id) || { ...c, ways: {} }; painted.set(id, e);
        if (e.tile !== c.tile) e.tile = c.tile;
        for (const [way, px] of Object.entries(ways)) {
            const to = e.ways[way] ??= new Array(64).fill(null);
            px.forEach((h, i) => { if (h != null) to[i] = h; });
        }
    }
    if (!painted.size) return { cells: pkg.cells };
    const cells = (pkg.cells || []).slice(), at = new Map();
    // for pkg.cell_promote: the moved cells and the resulting list options and fixed blobs
    const moved = [], lists = { ...(pkg.lists || {}) }, blobs = {}, usedSlots = new Map();
    const blobBytes = name => blobs[name] || (pkg.blobs?.[name] ? b64(pkg.blobs[name].data) : null);
    const blobAppend = (name, align, bytes) => {
        const old = blobBytes(name) || new Uint8Array(0), out = new Uint8Array(old.length + bytes.length);
        out.set(old); out.set(bytes, old.length); blobs[name] = out; blobs[name].align = pkg.blobs?.[name]?.align || align;
    };
    const u16le = v => Uint8Array.of(v & 0xFF, v >> 8);
    const stores = (name, list, first = false) => {                  // a stores blob: u32 n, n x (u32 address, u32 byte)
        const old = blobBytes(name) || new Uint8Array(4), n = (old[0] | old[1] << 8 | old[2] << 16 | old[3] << 24) >>> 0;
        const out = new Uint8Array(old.length + 8 * list.length), dv = new DataView(out.buffer);
        // first: before the blob's own stores (a clear of another screen's cell before this screen's own settings)
        const at = first ? 4 : old.length;
        out.set(old.subarray(0, at)); out.set(old.subarray(at), at + 8 * list.length); dv.setUint32(0, n + list.length, true);
        list.forEach(([a, v], j) => { dv.setUint32(at + 8 * j, a >>> 0, true); dv.setUint32(at + 8 * j + 4, v, true); });
        blobs[name] = out; blobs[name].align = pkg.blobs?.[name]?.align || 4;
    };
    // a screen's free slots (keyed by its stores blob) minus those any promote storing there already uses
    const takeSlot = pro => {
        const used = usedSlots.get(pro.stores) || new Set(); usedSlots.set(pro.stores, used);
        const names = Object.values(pkg.cell_promote || {}).filter(p => p.stores === pro.stores).flatMap(p => [p.slots, p.first?.slots]);
        for (const n of new Set([pro.slots, pro.first?.slots, ...names].filter(Boolean))) {
            const have = blobBytes(n); if (have) for (let j = 0; j + 1 < have.length; j += 2) used.add((have[j] | have[j + 1] << 8) & 0x3FF);
        }
        const s = (pro.free || []).find(x => !used.has(x)); if (s === undefined) return null;
        used.add(s); return s;
    };
    const inc = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
    const groupSlot = new Map();                                     // 'stores#cell' -> slot (a menu's states share it)
    // moves the cell's entries of a 4-byte list to the promote's 8-byte list and appends the slot number; the default
    // state's entry also goes to `first` (the screen's own list, before the menu hook runs)
    const move = (pro, list, cell, req, slot) => {
        for (let j = cells.length - 1; j >= 0; j--) if (cells[j] && cells[j][0] === list && cells[j][1] === cell) cells[j] = null;
        for (const to of [pro, ...(pro.first ? [pro.first] : [])]) {
            moved.push([to.list, cell, req]);
            blobAppend(to.slots, 2, u16le(slot));
            lists[to.list] = { ...(lists[to.list] || {}), entry: 8 };
        }
    };
    cells.forEach(([list, cell], k) => at.set(list + '#' + cell, k));
    for (const [id, e] of painted) {
        const k = at.get(id);
        if (k === undefined) { inc('painted cells no list names'); continue; }
        const pro = pkg.lists?.[e.list]?.entry !== 8 ? pkg.cell_promote?.[e.list] : null;
        if (pkg.lists?.[e.list]?.entry !== 8 && !pro) { inc('painted cells of 4-byte lists (not paintable)'); continue; }
        const old = cells[k][2];
        if (!old || old === 'chrsel') { inc('painted cells by character (not paintable)'); continue; }
        // a cell its character colours ({chr: load position}, no entry unpainted): painted, a slot of its own whose
        // unpainted pixels show what the character shows (its slot image, else its group), resolved after the tiles
        if (old.chr !== undefined) {
            if (!pro) { inc('painted cells by character without cell_promote (not paintable)'); continue; }
            const req = { slot: { tile: e.tile, ctx: '0/0/e4', px: new Array(64).fill(null), chr: 1, paint: e.ways } };
            const gk = pro.stores + '#' + e.cell;
            let slot = groupSlot.get(gk);
            if (slot === undefined) {
                slot = takeSlot(pro);
                if (slot === null) { inc('painted cells without a free slot (left as they were)'); continue; }
                groupSlot.set(gk, slot);
                const obj = e.cell >= (pro.objects ?? 0xE000), rel = obj ? e.cell - (pro.objects ?? 0xE000) : e.cell;
                const pix = (obj ? 0x030A0000 : 0x03080000) + 2 * rel, attr = (obj ? 0x03070000 : 0x03060000) + rel;
                stores(pro.stores, [[pix, slot & 0xFF], [pix + 1, 0x80 | slot >> 8]]);
                // the entry gives the cell its character's group: undone (CHRSEL) with the Pixel Attribute, by the
                // reset stores and, first thing, by those of the screens `clear` names (that draw over its cells)
                // (no `reset`: a screen during which the game decompresses blocks that reset, Jack Bros' staff roll,
                // whose cells only `clear` undoes)
                const undo = [[pix, 0], [pix + 1, 0], [attr, 0x80]];
                if (pro.reset) stores(pro.reset, undo);
                for (const c of pro.clear || []) stores(c, undo, true);
            }
            move(pro, e.list, e.cell, req, slot);
            inc('painted cells by character'); inc('painted cells moved to a list with slots'); inc('painted cells');
            continue;
        }
        const t = keySlot.get(e.tile).t, sp = old.slot || null, want = sp ? sp.want : old;
        const oldT = sp && sp.tile ? keySlot.get(sp.tile)?.t || new Uint8Array(16) : null;
        const oldWays = sp ? [[sp.ctx, sp.px], ...Object.entries(sp.ways || {})] : [];
        const before = (i, sel, sh) => {
            if (oldT) for (const [w, px] of oldWays) {
                const { sel: s2, plt } = parseCtx(w), v = value(oldT, i);
                if (s2 === sel && v && shade(plt, v) === sh && px[i] != null && px[i] !== '') return px[i];
            }
            const m = (want || []).find(([s2, h]) => s2 === sel && h === sh);
            return m ? m[2] : null;
        };
        const ways = [...new Set([...oldWays.map(([w]) => w), ...(pro?.ways || []), ...Object.keys(e.ways)])];
        const pxOf = way => {
            const { sel, plt } = parseCtx(way), out = new Array(64).fill(null);
            for (let i = 0; i < 64; i++) {
                const v = value(t, i); if (!v) continue;              // value 0 stays as the game draws it (left out)
                const sh = shade(plt, v);
                let h = e.ways[way]?.[i];
                if (h == null) for (const [w2, px] of Object.entries(e.ways)) {     // painted another way at the same shade
                    const c2 = parseCtx(w2); if (c2.sel === sel && px[i] != null && shade(c2.plt, v) === sh) { h = px[i]; break; }
                }
                out[i] = h != null ? h : before(i, sel, sh);
            }
            return out;
        };
        const [w0, ...rest] = ways;
        const req = { slot: { tile: e.tile, ctx: w0, px: pxOf(w0), ...(rest.length ? { ways: Object.fromEntries(rest.map(w => [w, pxOf(w)])) } : {}),
            ...(want ? { want } : {}), opq: 0, own: 1 } };
        if (!pro) {
            cells[k] = [cells[k][0], cells[k][1], req];
        } else {
            /**
             * A 4-byte list has one palette per cell, so the cell moves to its stream's 8-byte list with a slot of its
             * own from the screen's free ones, which no Character uses until it is loaded again. The slot's number is
             * appended to the list's slot numbers; the stream's fixed stores set the cell's Cell (or Object) Pixel
             * Attribute and the reset stores clear it. A menu state's list shares the slot with the other states the
             * same hook applies instead (`with`).
             */
            const gk = pro.stores + '#' + e.cell;
            let slot = groupSlot.get(gk);
            if (slot === undefined) {
                slot = takeSlot(pro);
                if (slot === null) { inc('painted cells without a free slot (left as they were)'); continue; }
                groupSlot.set(gk, slot);
                const pix = e.cell >= (pro.objects ?? 0xE000) ? 0x030A0000 + 2 * (e.cell - (pro.objects ?? 0xE000)) : 0x03080000 + 2 * e.cell;
                stores(pro.stores, [[pix, slot & 0xFF], [pix + 1, 0x80 | slot >> 8]]);
                stores(pro.reset, [[pix, 0], [pix + 1, 0]]);
            }
            move(pro, e.list, e.cell, req, slot);
            inc('painted cells moved to a list with slots');
        }
        inc('painted cells');
    }
    // unpainted menu states of a painted menu cell go into the shared slot as they are (slot cleared, every pixel its
    // group's colour like the 4-byte entry), so switching the state rewrites that slot
    for (const [gk, slot] of groupSlot) {
        const cell = +gk.slice(gk.lastIndexOf('#') + 1);
        for (const [list, pro] of Object.entries(pkg.cell_promote || {})) {
            if (!pro.with || pro.stores + '#' + cell !== gk || painted.has(list + '#' + cell)) continue;
            if (!pro.with.some(o => painted.has(o + '#' + cell))) continue;
            const k = at.get(list + '#' + cell); if (k === undefined || !cells[k]) continue;
            move(pro, list, cell, cells[k][2], slot);
            inc('menu states moved with a painted cell');
        }
    }
    if (!moved.length && !Object.keys(blobs).length) return { cells };
    return { cells: [...cells.filter(Boolean), ...moved], lists, blobs };
}

/**
 * pkg.lend (README "Paint layers"): a painted load position of `at` (indexes, their Character from pkg.slotless) that the
 * game loads at a Character without a Pixel Color Slot of its own, and whose unit now has a slot image, borrows a slot
 * from an owner Character that shows nothing of its own there. It takes the first of `free` not in use on that screen
 * (a slot number of the stores blob or of a cell slot list) whose donor keys have no slot image in this build.
 *
 * The `stores` blob holds the stream's fixed stores, which run when the stream is decompressed, before its Characters
 * are loaded: they point the Character's CHRPIX at the slot and turn the owner's off; `reset` gives both their boot
 * values back. The runtime's loader then puts the position's image into the slot. Works in place on `blobs`
 * (name -> {data, align}).
 */
function lendSlots(pkg, layers, keySlot, keyUnits, tileUnits, out, blobs, stats) {
    if (!pkg.lend) return;
    const inc = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
    const imgOf = key => {
        const s = keySlot.get(key); if (!s) return null;
        const u = keyUnits.get(key) || (anyNonZero(s.t) ? tileUnits.get(tileId(s.t)) : null);
        const e = u && out.get(u.uk);
        return e && e.img && e.img.some(x => x) ? e.img : null;
    };
    const painted = new Set(layers.flatMap(l => Object.keys(l.tiles || {})).filter(k => !k.startsWith('cell#')));
    const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
    const CHRPIX = 0x030A4000;
    const append = (name, list) => {
        const old = blobs.get(name)?.data || new Uint8Array(4), n = u32(old, 0);
        const b = new Uint8Array(old.length + 8 * list.length), dv = new DataView(b.buffer);
        b.set(old); dv.setUint32(0, n + list.length, true);
        list.forEach(([a, v], j) => { dv.setUint32(old.length + 8 * j, a >>> 0, true); dv.setUint32(old.length + 8 * j + 4, v, true); });
        blobs.set(name, { data: b, align: blobs.get(name)?.align || 4 });
    };
    for (const [table, L] of Object.entries(pkg.lend)) {
        // slots already in use on the screen: Pixel Attribute / CHRPIX stores with PCE set, plus the cell slot lists
        const used = new Set();
        const st = blobs.get(L.stores)?.data;
        if (st) {
            const byte = new Map();
            for (let k = 0, n = u32(st, 0); k < n; k++) byte.set(u32(st, 4 + 8 * k), u32(st, 8 + 8 * k));
            for (const [a, v] of byte) if ((a & 1) && (v & 0x80) && byte.has(a - 1)) used.add(((v & 3) << 8) | byte.get(a - 1));
        }
        for (const name of L.slot_lists || []) {
            const b = blobs.get(name)?.data; if (b) for (let j = 0; j + 1 < b.length; j += 2) used.add((b[j] | b[j + 1] << 8) & 0x3FF);
        }
        for (const i of L.at || []) {
            const key = `${table}:${i}`, chr = pkg.slotless?.[table]?.chr?.[i];
            if (chr == null) continue;
            if (!painted.has(key) || !imgOf(key)) continue;
            const pick = (L.free || []).find(([slot, donors]) => !used.has(slot) && donors.every(d => !imgOf(d)));
            if (!pick) { inc('painted positions without a slot to lend (slot pixels not shown)'); continue; }
            const [slot] = pick, owner = (L.owner ?? 0x300) + slot, on = 0x8000 | slot;
            used.add(slot);
            append(L.stores, [[CHRPIX + 2 * chr, on & 0xFF], [CHRPIX + 2 * chr + 1, on >> 8], [CHRPIX + 2 * owner, 0], [CHRPIX + 2 * owner + 1, 0]]);
            append(L.reset, [[CHRPIX + 2 * chr, 0], [CHRPIX + 2 * chr + 1, 0], [CHRPIX + 2 * owner, on & 0xFF], [CHRPIX + 2 * owner + 1, on >> 8]]);
            inc('painted positions with a lent slot');
        }
    }
}

// ---- allocation of groups, palettes, slot images, cell patches and Color RAM for the whole game or one context
function allocate(P, tileUnits, keyUnits, keySlot, req, stats) {
    const GROUPS = P.groups, LIMIT = P.limit ?? 255, GREY = P.grey;
    const inc = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
    const pkg = req;                                                 // cells, lists, appends, scenes, tokens
    const opqTabs = new Set((pkg.tables || []).filter(t => t.opq).map(t => t.name));
    for (const u of [...tileUnits.values(), ...keyUnits.values()]) { u.sk = u.kind ? u.id : hexBytes(u.t); u.uk = u.kind + ':' + u.sk; }
    const cmpU = (a, b) => a.kind - b.kind || (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0);
    const units = [...[...tileUnits.values()].sort(cmpU), ...[...keyUnits.values()].sort(cmpU)];
    // a package that names the load positions without a Pixel Color Slot (pkg.slotless: Jack Bros) has one for every
    // other position (and the lendable ones of pkg.lend): a painted unit with a group ramp (d) there keeps its group, its
    // paint goes into its slot image (u.keep), so painting adds no palette group and moves no other unit's
    const slotless = new Set(), lendable = new Set();
    for (const [t, T] of Object.entries(pkg.slotless || {})) for (const i of Object.keys(T.chr || {})) slotless.add(`${t}:${i}`);
    for (const [t, L] of Object.entries(pkg.lend || {})) for (const i of L.at || []) if (pkg.slotless?.[t]?.chr?.[i] != null) lendable.add(`${t}:${i}`);
    if (pkg.slotless) for (const u of units) {
        u.keep = !!(u.d && u.kind && u.ctx.some(c => c.painted && c.w0 !== undefined) && (!slotless.has(u.id) || lendable.has(u.id)));
        // a painted position the runtime draws without a slot gets no slot image (it would only take palettes)
        if (u.kind && slotless.has(u.id) && !lendable.has(u.id) && u.ctx.some(c => c.painted && c.w0 !== undefined)) u.noslot = true;
    }

    // ---- items: (unit, side) with their requests {(sel, shade): {colour: weight}}
    const items = [];
    for (const u of units) {
        for (const side of [0, 1]) {
            const req = new Map(); let total = 0, gw = 0;
            for (const c of u.ctx) {
                if (c.side !== side) continue;
                const w = (u.seen ? c.w : c.w * 0.02) / Math.max(1, u.o); total += w * u.o;
                if (u.keep) gw += ((u.seen ? c.w0 ?? c.w : (c.w0 ?? c.w) * 0.02) / Math.max(1, u.o)) * u.o;
                for (let i = 0; i < 64; i++) {
                    const h = c.W[i]; if (h == null) continue;
                    const key = c.sel * 4 + shade(c.plt, value(u.t, i));
                    let m = req.get(key); if (!m) req.set(key, m = new Map());
                    m.set(h, (m.get(h) || 0) + w);
                }
            }
            const own = u.d && (u.keep || !u.ctx.some(c => c.painted));
            if (!req.size && !own) continue;
            // P.group_demand 'pixel' (Virtual Bowling): the group asks for the colours of the unit's most common pixel
            // kind (a pixel's colours over all its ways) rather than each (selector, shade)'s most common colour, so
            // materials that share a colour at one shade don't merge into a group of their own
            let d = null;
            if (P.group_demand === 'pixel') {
                const kinds = new Map();
                for (let i = 0; i < 64; i++) {
                    const sig = []; let wt = 0;
                    for (const c of u.ctx) {
                        if (c.side !== side || c.W[i] == null) continue;
                        sig.push([c.sel * 4 + shade(c.plt, value(u.t, i)), c.W[i]]); wt += c.w;
                    }
                    if (!sig.length) continue;
                    sig.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
                    const k = JSON.stringify(sig), e = kinds.get(k);
                    if (e) e.w += wt; else kinds.set(k, { sig, w: wt });
                }
                let best = null; for (const e of kinds.values()) if (!best || e.w > best.w) best = e;
                d = best ? new Map(best.sig) : null;
            }
            // u.d (Jack Bros: [[selector * 4 + shade, colour], ...], its group's ramp) applies while none of the unit's
            // ways is painted and sends the item to the first group showing it; it also covers units with nothing drawn,
            // i.e. Characters the game writes itself after loading (text)
            if (own) d = new Map(u.d);
            // u.ramp marks a swatch coloured by group only (Virtual League Baseball's field view): per selector and shade s
            // the group shows the colour of the swatch's value-s pixels, wherever a way draws value s at shade s
            if (u.ramp) {
                d = new Map();
                for (const c of u.ctx) for (let v = 1; v < 4; v++) {
                    if (c.side !== side || shade(c.plt, v) !== v || d.has(c.sel * 4 + v)) continue;
                    for (let i = 0; i < 64; i++) if (value(u.t, i) === v && c.W[i]) { d.set(c.sel * 4 + v, c.W[i]); break; }
                }
                if (!d.size) d = null;
            }
            // u.extrasOnly (Dragon Hopper dev159's status-line magic icon: twelve cards' ramps in the same characters):
            // no group of its own; its pixels take made-to-measure palettes through its slot image
            if (u.extrasOnly) continue;
            // a kept unit takes its place in the group fit by its weight without the paint, as unpainted; in such a
            // package a painted unit that is not kept (no slot: its paint needs a group) comes after all others, so it
            // takes what groups are left and the unpainted ones stay as they are
            const late = !!pkg.slotless && !u.keep && u.ctx.some(c => c.painted && c.w0 !== undefined);
            items.push({ u, side, req, w: total, gw: u.keep ? gw : total, late, d });
        }
    }
    items.sort((a, b) => (a.late - b.late) || (b.gw - a.gw) || cmpU(a.u, b.u) || a.side - b.side);

    const mostCommon = m => { let best = null, bw = -Infinity; for (const [c, w] of m) if (w > bw) { best = c; bw = w; } return best; };
    // ---- groups: first fit by weight, group 0 starting as the grey ramp. P.seed_groups (Vertical Force J: the US
    // build's groups) are the groups to start from, so one variant's tiles share palettes the way the other's do
    const groups = P.seed_groups ? P.seed_groups.map(g => new Map(g)) : [new Map([[1, GREY[1]], [2, GREY[2]], [3, GREY[3]]])];   // key sel * 4 + shade
    for (const it of items) {
        const d = new Map(); for (const [c, m] of it.req) d.set(c, mostCommon(m));
        if (it.d) for (const [c, x] of it.d) d.set(c, x);
        let best = null, bk = null;
        groups.forEach((g, gi) => {
            for (const [c, x] of d) if (g.has(c) && g.get(c) !== x) return;
            let n = 0; for (const c of d.keys()) if (g.has(c)) n++;
            const k = [n, -g.size];
            if (best === null || k[0] > bk[0] || (k[0] === bk[0] && k[1] > bk[1])) { best = gi; bk = k; }
        });
        if (best !== null) { const g = groups[best]; for (const [c, x] of d) g.set(c, x); }
        else if (groups.length < GROUPS) groups.push(new Map(d));
        else if (it.u.ctx.some(c => c.painted)) inc('painted characters without a palette group of their own');
    }
    const matched = (g, req) => { const xs = []; for (const [c, m] of req) if (g.has(c)) xs.push(m.get(g.get(c)) || 0); return nsum(xs); };
    const assign = new Map();
    for (const it of items) {
        let best = -1, bm = 0;
        for (let gi = 0; gi < groups.length; gi++) { const m = matched(groups[gi], it.req); if (best < 0 || m > bm) { best = gi; bm = m; } }
        // the first group that shows the whole demand, so pixels the game changes after loading show the main pixel
        // kind's colours (Virtual Bowling v0.1's main material)
        if (it.d) { const gi = groups.findIndex(g => [...it.d].every(([c, x]) => g.get(c) === x)); if (gi >= 0) best = gi; }
        assign.set(it.u.uk + '/' + it.side, best);
    }
    const NP = groups.length * 4;
    // P.free_sels (Jack Bros): selectors the game never draws with, so those palettes of every group are free for
    // made-to-measure palettes
    const FREE = new Set(P.free_sels || []), isFree = p => p < NP && FREE.has(p & 3);
    const pal = [];                                                  // pal[p][shade]
    groups.forEach((g, gi) => {
        for (let sel = 0; sel < 4; sel++) {
            const row = [];
            for (let s = 0; s < 4; s++) {
                let c = g.get(sel * 4 + s) || g.get(s);
                if (!c) for (let q = 0; q < 4; q++) if (g.has(q * 4 + s)) { c = g.get(q * 4 + s); break; }
                row.push(c || GREY[s]);
            }
            pal[gi * 4 + sel] = row;
        }
    });
    // value-0 pixels painted opaque show shade 0 of their slot's palette, so group palettes whose shade 0 no value 1-3
    // pixel reaches take those colours
    const used0 = new Set();
    for (const it of items) { const g = assign.get(it.u.uk + '/' + it.side); for (const c of it.req.keys()) if (c % 4 === 0) used0.add(g * 4 + (c >> 2)); }
    const opqCols = [...new Set(units.flatMap(u => u.z ? [...u.z.values()].filter(Boolean) : []))].sort();
    const free0 = []; for (let p = 1; p < NP; p++) if (!used0.has(p) && !isFree(p)) free0.push(p);
    const opqPal = new Map();
    // P.opq 'shade0' (Golf's drawn value-0 sprite pixels): the first group palette whose shade 0 already is the colour,
    // else one of its own as with 'own'
    if (P.opq === 'shade0') for (const c of opqCols) { for (let p = 1; p < NP && !opqPal.has(c); p++) if (pal[p][0] === c) opqPal.set(c, p); }
    const ownCols = P.opq === 'shade0' ? opqCols.filter(c => !opqPal.has(c)) : opqCols;
    // P.opq 'own' (Vertical Force): each opaque colour gets its own palette from LIMIT - 1 down (shade 0 the colour, 1-3
    // black), so no group palette's shade 0 changes and made-to-measure palettes end below them; with more colours
    // than palettes left, the rest share the nearest colour's palette
    const OPQOWN = P.opq === 'own' || P.opq === 'shade0' ? Math.min(ownCols.length, Math.max(0, LIMIT - NP)) : 0, opqShort = new Set();
    if (OPQOWN) {
        ownCols.slice(0, OPQOWN).forEach((c, k) => opqPal.set(c, LIMIT - 1 - k));
        const rgbOf = c => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16));
        for (const c of ownCols.slice(OPQOWN)) {
            const [r, g, b] = rgbOf(c); let best = null, bd = Infinity;
            for (const d of ownCols.slice(0, OPQOWN)) { const [x, y, z] = rgbOf(d), e = (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2; if (e < bd) { bd = e; best = d; } }
            opqPal.set(c, opqPal.get(best)); opqShort.add(c); inc('opaque colours short of a palette');
        }
    }
    else if (P.opq !== 'shade0') opqCols.slice(0, free0.length).forEach((c, k) => { pal[free0[k]][0] = c; opqPal.set(c, free0[k]); });
    stats.shade0_free = free0.length;
    const byColour = new Map();
    for (let p = 1; p < NP; p++) if (!isFree(p)) for (let s = 0; s < 4; s++) { const k = s + pal[p][s]; let l = byColour.get(k); if (!l) byColour.set(k, l = []); l.push(p); }

    // ---- Cell Color Attribute patches: a group palette that shows the wanted colours, else first fit into the patch
    // groups (patch0..63); requests with a slot of their own come later
    const pgroups = [];
    // P.patch_layout 'palettes' (Galactic Pinball): a request no group palette shows gets a palette of its own selector
    // behind the groups instead of a patch group; unrequested shades show the nearest requested one (shade 0 black)
    const ppal = new Map();                                          // palette -> Map(shade -> colour)
    const ppalColour = (q, s) => {
        if (!s) return GREY[0];
        const d = ppal.get(q); if (d.has(s)) return d.get(s);
        let best = null; for (const k of d.keys()) if (best === null || Math.abs(k - s) < Math.abs(best - s)) best = k;
        return d.get(best);
    };
    function patchPalette(want) {
        const sel = want[0][0];
        if (want.some(x => x[0] !== sel)) throw new Error('patch_layout palettes: one selector per cell request');
        for (let gi = 0; gi < groups.length; gi++) if (want.every(([, s, h]) => pal[gi * 4 + sel][s] === h)) return gi;
        let q = [...ppal.keys()].sort((a, b) => a - b).find(p => p % 4 === sel && want.every(([, s, h]) => !ppal.get(p).has(s) || ppal.get(p).get(s) === h));
        if (q === undefined) {
            for (let p = NP + sel; p < LIMIT && q === undefined; p += 4) if (!ppal.has(p)) q = p;
            if (q === undefined) return null;
            ppal.set(q, new Map());
        }
        for (const [, s, h] of want) ppal.get(q).set(s, h);
        return q >> 2;
    }
    function patchAttr(want) {
        if (P.patch_layout === 'palettes') return patchPalette(want);
        const sels = new Set(want.map(x => x[0]));
        if (sels.size === 1) {
            const sel = want[0][0];
            for (let gi = 0; gi < groups.length; gi++) if (want.every(([, s, h]) => pal[gi * 4 + sel][s] === h)) return gi;
        }
        let gi = pgroups.findIndex(g => want.every(([q, s, h]) => !g.has(q * 4 + s) || g.get(q * 4 + s) === h));
        if (gi < 0) { pgroups.push(new Map()); gi = pgroups.length - 1; }
        for (const [q, s, h] of want) pgroups[gi].set(q * 4 + s, h);
        return -1 - gi;                                              // placed once their number is known
    }
    const lists = new Map();                                         // name -> [{cell, attr, img?, slot?}]
    const listOf = name => { let l = lists.get(name); if (!l) lists.set(name, l = []); return l; };
    const LOPT = pkg.lists || {};
    const addEntry = (name, e) => {
        const l = listOf(name);
        if (LOPT[name]?.unique) { const k = l.findIndex(x => x.cell === e.cell); if (k >= 0) { l[k] = e; return; } }
        l.push(e);
    };
    const slotted = [];
    for (const [name, cell, want] of pkg.cells || []) {
        if (!want) { inc('cell patches a palette cannot show'); continue; }
        if (want === 'chrsel') { addEntry(name, { cell, attr: 0x80 }); continue; }
        if (want.chr !== undefined) { inc('cells by character (paintable)'); continue; }    // unpainted: no entry at all
        if (want.slot) {
            if (LOPT[name]?.entry !== 8) throw new Error(`list ${name}: cells with a slot need 8-byte entries`);
            slotted.push([name, cell, want.slot, want.slot.want ? patchAttr(want.slot.want) : null]); continue;
        }
        const attr = patchAttr(want);
        if (attr === null) { inc('cell patches without room'); continue; }
        addEntry(name, { cell, attr }); inc('cell patches');
    }
    const TOP = P.top ?? 64;                                         // groups from TOP up belong to the overlays
    const PATCH0 = P.patch0 ?? TOP - pgroups.length;
    if (pgroups.length > TOP - PATCH0) throw new PaletteGroupsFull(`${pgroups.length} cell patch groups, room for ${TOP - PATCH0}`, groups.length, pgroups.length, TOP);
    if (PATCH0 * 4 < NP) throw new PaletteGroupsFull(`palette groups ${groups.length} and cell patch groups ${pgroups.length} overlap`, groups.length, pgroups.length, TOP);
    for (const l of lists.values()) for (const e of l) if (e.attr < 0) e.attr = PATCH0 - 1 - e.attr;
    const XEND = Math.min(PATCH0 * 4, LIMIT - OPQOWN);               // made-to-measure palettes NP..XEND-1
    const extras = new Map(), claimed = new Map();
    const xfree = []; for (let q = NP; q < XEND; q++) if (!ppal.has(q)) xfree.push(q);
    if (FREE.size) xfree.unshift(...[...Array(NP).keys()].filter(q => isFree(q) && q < XEND));
    // params.own_palettes: the last N made-to-measure palettes are reserved for painted cells' own ramps (ownExtra), so a
    // game whose tiles use up every made-to-measure palette (Mario Clash) still has room for painted cells
    const xown = P.own_palettes ? xfree.splice(Math.max(0, xfree.length - P.own_palettes)) : [];
    // params.own_above N: palettes LIMIT .. N - 1 are unused by tiles, so they hold painted cells' own ramps too
    // (Galactic Pinball: limit 252, own_above 255)
    if (P.own_above) for (let q = LIMIT; q < Math.min(P.own_above, 255); q++) xown.push(q);
    let nx = 0, no = 0;
    const nextExtra = () => nx < xfree.length ? xfree[nx++] : null;
    const nextOwn = () => no < xown.length ? xown[no++] : nextExtra();
    for (const q of [...ppal.keys()].sort((a, b) => a - b)) for (let s = 0; s < 4; s++) {   // patch_layout palettes serve slot pixels too
        const k = s + ppalColour(q, s); let l = byColour.get(k); if (!l) byColour.set(k, l = []); l.push(q);
    }
    if (ppal.size) stats['patch palettes'] = ppal.size;
    const patchColour = (p, s) => {
        const g = pgroups[(p >> 2) - PATCH0], sel = p & 3; let c = g.get(sel * 4 + s);
        if (!c) for (let q = 0; q < 4; q++) if (g.has(q * 4 + s)) { c = g.get(q * 4 + s); break; }
        return c || GREY[s];
    };
    const shows = (p, s) => p < NP && !isFree(p) ? pal[p][s] : ppal.has(p) ? ppalColour(p, s) : p >= PATCH0 * 4 ? patchColour(p, s) : extras.get(p)[s];
    function extraFor(wish) {
        let q = null;
        for (const e of [...extras.keys()].sort((a, b) => a - b)) {
            let ok = true; for (const [s, c] of wish) if (extras.get(e)[s] !== c && claimed.get(e).has(s)) { ok = false; break; }
            if (ok) { q = e; break; }
        }
        if (q === null) {
            q = nextExtra(); if (q === null) return null;
            extras.set(q, GREY.slice()); claimed.set(q, new Set());
        }
        for (const [s, c] of wish) { extras.get(q)[s] = c; claimed.get(q).add(s); }
        return q;
    }
    function paletteFor(s, c, own = false) {
        const q = paletteShowing(s, c); if (q !== null) return q;
        return own ? ownExtra(new Map([[s, c]])) : extraFor(new Map([[s, c]]));
    }
    function paletteShowing(s, c) {
        const l = byColour.get(s + c); if (l && l.length) return Math.min(...l);
        for (const [q, e] of [...extras].sort((a, b) => a[0] - b[0])) if (e[s] === c && claimed.get(q).has(s)) return q;
        return null;
    }
    const owned = new Map();
    // a painted cell's own palette claims every shade, so no other pixel's palette changes, not even at a shade it does
    // not ask for (a fade's)
    function ownExtra(wish) {
        const ramp = GREY.slice(); for (const [sh, c] of wish) ramp[sh] = c;
        const k = ramp.join(); if (owned.has(k)) return owned.get(k);
        const q = nextOwn(); if (q === null) return null;
        extras.set(q, ramp); claimed.set(q, new Set([0, 1, 2, 3])); owned.set(k, q);
        return q;
    }

    const paintExtras = [];
    // for an overlay's paint: never reuse an existing palette other than the paint's own, since a pixel may show it at a
    // shade it did not claim
    function paintExtra(wish) {
        let q = paintExtras.find(e => [...wish].every(([s, c]) => !claimed.get(e).has(s) || extras.get(e)[s] === c)) ?? null;
        if (q === null) { q = nextExtra(); if (q === null) return null; extras.set(q, GREY.slice()); claimed.set(q, new Set()); paintExtras.push(q); }
        for (const [s, c] of wish) { extras.get(q)[s] = c; claimed.get(q).add(s); }
        return q;
    }

    // ---- per unit: CHRCOL word and slot image
    const out = new Map(); const fid = {};
    const weight = new Map(); for (const it of items) weight.set(it.u.uk, (weight.get(it.u.uk) || 0) + it.w);
    // in a package with pkg.slotless, painted units last, so every other unit's slot pixels take the palettes they take
    // without paint
    const late = u => !!pkg.slotless && u.ctx.some(c => c.painted && c.w0 !== undefined);
    const order = units.slice().sort((a, b) => (late(a) - late(b)) || (b.kind - a.kind) || ((weight.get(b.uk) || 0) - (weight.get(a.uk) || 0)) || cmpU(a, b));
    // slot images: at most P.slot_budget different ones (the heaviest units first); unbounded when not given
    const BUDGET = P.slot_budget ?? Infinity, images = new Set();
    for (const u of order) {
        let g0 = assign.get(u.uk + '/0'), g1 = assign.get(u.uk + '/1');
        if (g0 === undefined) g0 = g1 !== undefined ? g1 : 0;
        if (g1 === undefined) g1 = g0;
        const fk = 'fidelity %, ' + (u.ctx.some(c => c.painted) ? 'reference' : u.seen ? 'surveyed' : 'unsurveyed');
        const f = fid[fk] ??= [0, 0];
        const ways = u.ctx.map(c => ({ w: c.w, g: c.side ? g1 : g0, c }));
        ways.sort((a, b) => b.w - a.w);
        const img = new Uint8Array(64); let gain = 0;
        for (let i = 0; i < 64; i++) {
            const v = value(u.t, i);
            // painted transparent ("" in a paint layer): the slot's 0xFF, which the hardware never draws
            if (v && ways.some(w => w.c.painted && w.c.W[i] === '')) { img[i] = 0xFF; inc('transparent pixels'); continue; }
            if (!v || !ways.length || (P.slot_pixels === 'any way' ? ways.every(w => w.c.W[i] == null) : ways[0].c.W[i] == null)) continue;
            if (u.noslot) { const want = []; for (const { w, g, c } of ways) if (c.W[i] != null) want.push([w, g * 4 + c.sel, shade(c.plt, v), c.W[i]]);
                const pl = nsum(want.filter(([, p, s, c]) => pal[p][s] === c).map(x => x[0])), tt = nsum(want.map(x => x[0]));
                f[1] += tt; f[0] += pl; continue; }
            const want = [];
            for (const { w, g, c } of ways) if (c.W[i] != null) want.push([w, g * 4 + c.sel, shade(c.plt, v), c.W[i]]);
            const plain = nsum(want.filter(([, p, s, c]) => pal[p][s] === c).map(x => x[0])), tot = nsum(want.map(x => x[0]));
            f[1] += tot; f[0] += plain;
            if (plain >= tot) continue;
            const wc = new Map();
            for (const [w, , s, c] of want) { let m = wc.get(s); if (!m) wc.set(s, m = new Map()); m.set(c, (m.get(c) || 0) + w); }
            const wish = new Map(); for (const [s, m] of wc) wish.set(s, mostCommon(m));
            const cands = new Set();
            for (const [s, c] of wish) for (const q of byColour.get(s + c) || []) cands.add(q);
            for (const [q, e] of extras) for (const [s, c] of wish) if (e[s] === c) { cands.add(q); break; }
            const score = q => nsum(want.filter(([, , s, c]) => shows(q, s) === c).map(x => x[0]));
            let best = null, bs = 0;
            for (const q of [...cands].sort((a, b) => a - b)) { const x = score(q); if (best === null || x > bs) { best = q; bs = x; } }
            const full = nsum(want.filter(([, , s, c]) => wish.get(s) === c).map(x => x[0]));
            if (u.keep && (best === null || score(best) < full)) {
                /**
                 * A kept painted unit (u.keep): the shades its painted ways draw the pixel at must show the paint; the
                 * others (the flash's, a fade's) only where a palette has room. A palette that shows the paint as it
                 * is, else a made-to-measure one whose painted shades are free or the same (packed: one colour per
                 * shade), else a new one, so the paint takes few palettes.
                 */
                const main = new Map(), more = new Map();
                for (const [s, c] of wish) (ways.some(w => w.c.painted && w.c.W[i] != null && shade(w.c.plt, v) === s) ? main : more).set(s, c);
                const fits = (x, m) => [...m].every(([s, c]) => extras.has(x) ? (!claimed.get(x).has(s) || extras.get(x)[s] === c) : shows(x, s) === c);
                const showsMain = x => [...main].every(([s, c]) => shows(x, s) === c && (!extras.has(x) || claimed.get(x).has(s)));
                let q = null, qs = -1;
                for (const x of [...cands].sort((a, b) => a - b)) if (showsMain(x)) { const sc = score(x); if (sc > qs) { q = x; qs = sc; } }
                if (q === null) {
                    const xs = [...extras.keys()].sort((a, b) => a - b).filter(x => fits(x, main));
                    q = xs.find(x => fits(x, more)) ?? xs[0] ?? null;
                    if (q === null) { q = nextExtra(); if (q !== null) { extras.set(q, GREY.slice()); claimed.set(q, new Set()); } }
                }
                if (q !== null && extras.has(q)) for (const m of [main, more]) for (const [s, c] of m) {
                    if (m === more && claimed.get(q).has(s)) continue;
                    extras.get(q)[s] = c; claimed.get(q).add(s);
                }
                if (q !== null) best = q;
                if (best === null || [...main].some(([s, c]) => shows(best, s) !== c)) inc('slot pixels short of a colour');
                else if (score(best) < full) inc('painted pixels short of an unpainted way\'s colour (flash, fade)');
            } else if (best === null || score(best) < full) {
                if (P.extras === 'fill') {                   // Space Invaders VC: a new palette per pixel, other shades the main way's colour
                    const q = nextExtra(); if (q !== null) { const first = wish.get(want[0][2]); extras.set(q, [GREY[0], ...[1, 2, 3].map(s => wish.get(s) ?? first)]); claimed.set(q, new Set([1, 2, 3])); best = q; }
                } else best = extraFor(wish) ?? best;
                if (best === null || score(best) < full) inc('slot pixels short of a colour');
            }
            if (best === null || score(best) <= plain) continue;
            if (extras.has(best)) for (const [, , s, c] of want) if (extras.get(best)[s] === c) claimed.get(best).add(s);
            img[i] = best; inc('exception pixels'); f[0] += score(best) - plain; gain += score(best) - plain;
        }
        // painted value-0 pixels turn the entry opaque (OPQ) and cut out its other value-0 pixels (0xFF); in a table whose
        // runtime draws every value-0 pixel itself (option `opq`: Golf's menu background, slot byte 0 = the group's shade
        // 0) they stay as they were and only erased ones are cut out
        const zOwn = u.kind && opqTabs.has(keySlot.get(u.id)?.tab);
        const opq = u.z && [...u.z.values()].some(h => h || zOwn) ? u.z : null;
        if (opq) for (let i = 0; i < 64; i++) {
            if (value(u.t, i)) continue;
            if (!opq.get(i)) { img[i] = zOwn && !opq.has(i) ? 0 : 0xFF; continue; }
            const q = opqPal.get(opq.get(i)) ?? paletteFor(0, opq.get(i));
            if (q === null) { img[i] = 0xFF; inc('opaque pixels without room'); continue; }
            img[i] = q; inc('opaque pixels');
        }
        let has = img.some(x => x);
        if (has && BUDGET !== Infinity) {
            const k = hexBytes(img);
            if (!images.has(k) && images.size >= BUDGET) { has = false; f[0] -= gain; inc('tiles without slot room'); }
            else images.add(k);
        }
        out.set(u.uk, { w: g0 | g1 << 8, img: has ? img : null, opq: has && !!opq });
        if (has) inc('tiles with exceptions');
    }
    for (const [k, [ok, tot]] of Object.entries(fid).sort()) stats[k] = Math.round(100000 * ok / Math.max(tot, 1e-9)) / 1000;

    // ---- cells with a slot of their own: the tile's group, a slot image for what its palette cannot show
    for (const [name, cell, sp, attr0] of slotted) {
        const u = sp.tile ? keyUnits.get(sp.tile) || (() => { const s = keySlot.get(sp.tile); return s && anyNonZero(s.t) ? tileUnits.get(tileId(s.t)) : null; })() : null;
        const t = sp.tile ? keySlot.get(sp.tile).t : new Uint8Array(16);
        if (sp.chr) {
            /**
             * A painted cell its character colours (README "Paint layers", {chr}): the cell takes the character's BG
             * group and a slot image that starts as the character's own (its slot image, else none), so unpainted
             * pixels show what the character shows; each painted pixel names a palette with the painted colour at
             * the shade its value has in each painted way and, at the other shades, its palette's colours there
             * (fades keep their ramp): an existing palette that shows exactly that, else a made-to-measure one
             * (paintExtra). '' leaves the pixel out (0xFF). Value 0 stays as the character draws it.
             */
            const o = u ? out.get(u.uk) : null, g = o ? o.w & 0xFF : 0, img = o?.img ? o.img.slice() : new Uint8Array(64);
            for (let i = 0; i < 64; i++) {
                const v = value(t, i); if (!v) continue;
                const wish = new Map(); let touched = false, cut = false, sel0 = 0;
                for (const [way, px] of Object.entries(sp.paint || {})) {
                    const h = px?.[i]; if (h == null) continue;
                    touched = true;
                    if (h === '') { cut = true; continue; }
                    const { sel, plt } = parseCtx(way); sel0 = sel;
                    wish.set(shade(plt, v) || v, h.toLowerCase());          // shade 0 never takes paint: its lit colour
                }
                if (!touched) continue;
                if (!wish.size) { if (cut) img[i] = 0xFF; continue; }
                const base = img[i] && img[i] !== 0xFF ? img[i] : g * 4 + sel0;
                for (let k = 1; k < 4; k++) if (!wish.has(k)) wish.set(k, shows(base, k));
                let q = null;
                for (let x = 1; x < Math.min(256, LIMIT) && q === null; x++) {
                    if (!(x < NP && !isFree(x)) && !ppal.has(x) && !(x >= PATCH0 * 4 && x < (PATCH0 + pgroups.length) * 4) && !extras.has(x)) continue;
                    if ([...wish].every(([k, c]) => shows(x, k) === c && (!extras.has(x) || claimed.get(x).has(k)))) q = x;
                }
                if (q === null) q = paintExtra(wish);
                if (q === null) { inc('cell slot pixels without room'); continue; }
                img[i] = q;
            }
            addEntry(name, { cell, attr: g, img, opq: !!o?.opq }); inc('cells with a slot');
            continue;
        }
        const g = attr0 !== null ? (attr0 < 0 ? PATCH0 - 1 - attr0 : attr0) : u ? out.get(u.uk).w & 0xFF : 0, { sel, plt } = parseCtx(sp.ctx);
        const img = new Uint8Array(64), own = !!sp.own && !sp.ways, need = [];
        for (let i = 0; i < 64; i++) {
            const c = sp.px[i]; if (c == null) continue;
            if (c === '') { img[i] = 0xFF; continue; }                  // left out: value 0 stays transparent, or an erased pixel
            const v = value(t, i);
            if (!v && own && c) { need.push([i, 0, c]); continue; }
            if (!v) { const q = c ? paletteFor(0, c, !!sp.own) : 0xFF; img[i] = q ?? 0xFF; continue; }
            const s = shade(plt, v);
            if (sp.ways) {          // Space Squash: the pixel's palette has to show all of the cell's ways
                const wish = new Map([[s, c]]);
                for (const [k, px] of Object.entries(sp.ways)) if (px[i] != null && px[i] !== '') wish.set(shade(parseCtx(k).plt, v), px[i]);
                if ([...wish].every(([s2, c2]) => shows(g * 4 + sel, s2) === c2)) continue;
                const cands = new Set(); for (const [s2, c2] of wish) for (const q of byColour.get(s2 + c2) || []) cands.add(q);
                for (const [q, e] of extras) for (const [s2, c2] of wish) if (e[s2] === c2) { cands.add(q); break; }
                const score = q => [...wish].filter(([s2, c2]) => shows(q, s2) === c2).length;
                let best = null; for (const q of [...cands].sort((a, b) => a - b)) if (best === null || score(q) > score(best)) best = q;
                if (best === null || score(best) < wish.size) best = (sp.own ? ownExtra(wish) : extraFor(wish)) ?? best;
                if (best === null) { inc('cell slot pixels without room'); continue; }
                if (score(best) < wish.size) inc('cell slot pixels short of a colour');
                img[i] = best; continue;
            }
            if (shows(g * 4 + sel, s) === c) continue;
            if (own) { need.push([i, s, c]); continue; }
            const q = paletteFor(s, c, !!sp.own);
            if (q === null) { inc('cell slot pixels without room'); continue; }
            img[i] = q;
        }
        // a painted cell's colours that no palette shows yet are packed into palettes of its own, one colour per shade, so
        // a cell painted one colour per shade needs a single palette
        const ramps = [];
        for (const [i, s, c] of need) {
            const q = paletteShowing(s, c); if (q !== null) { img[i] = q; continue; }
            let r = ramps.find(r => !r.m.has(s) || r.m.get(s) === c);
            if (!r) ramps.push(r = { m: new Map(), px: [] });
            r.m.set(s, c); r.px.push(i);
        }
        for (const r of ramps) {
            const q = ownExtra(r.m);
            if (q === null) { inc('cell slot pixels without room', r.px.length); for (const i of r.px) if (!value(t, i)) img[i] = 0xFF; continue; }
            for (const i of r.px) img[i] = q;
        }
        addEntry(name, { cell, attr: g, img, opq: !!sp.opq }); inc('cells with a slot');
    }
    /**
     * An overlay's painted characters (req.unitPaint: Map(unit key -> {t, ways: {way: 64 colours}})), last, so the
     * groups stay as without paint and no other pixel changes. Each painted pixel's position in the character's pixel
     * slot names a palette that shows the painted colours at their shades and, for the ways not painted, the colours
     * the character shows there now: a palette that does, else a made-to-measure one (paintExtra). A colour on a
     * value-0 pixel makes the character opaque (OPQ: that pixel shows shade 0 of its palette, the character's other
     * value-0 pixels are cut out); '' cuts a pixel out.
     */
    for (const [uk, { t, ways }] of req.unitPaint || []) {
        const o = out.get(uk), u = units.find(x => x.uk === uk);
        if (!o || !u) { inc('painted characters not drawn'); continue; }
        const img = o.img ? o.img.slice() : new Uint8Array(64);
        const zero = [...Object.values(ways)].some(px => px.some((h, i) => h && !value(t, i)));
        const opq = o.opq || zero;
        if (zero && !o.opq) for (let i = 0; i < 64; i++) if (!value(t, i)) img[i] = 0xFF;
        for (let i = 0; i < 64; i++) {
            const v = value(t, i), wish = new Map(); let touched = false, cut = false;
            for (const [way, px] of Object.entries(ways)) {
                const h = px[i]; if (h == null) continue;
                touched = true;
                if (h === '') { cut = true; continue; }
                wish.set(v ? shade(parseCtx(way).plt, v) || v : 0, h);
            }
            if (!touched) continue;
            if (!wish.size) { if (cut) img[i] = 0xFF; continue; }
            if (v) for (const c of u.ctx) {
                if (ways[c.k]) continue;
                const s = shade(c.plt, v); if (!s || wish.has(s)) continue;
                const base = img[i] && img[i] !== 0xFF ? img[i] : ((c.side ? o.w >> 8 : o.w) & 0x3F) * 4 + c.sel;
                wish.set(s, shows(base, s));
            }
            let q = null;
            for (let x = 1; x < Math.min(256, LIMIT) && q === null; x++) {
                if (!(x < NP && !isFree(x)) && !ppal.has(x) && !(x >= PATCH0 * 4 && x < (PATCH0 + pgroups.length) * 4) && !extras.has(x)) continue;
                if ([...wish].every(([k, c]) => shows(x, k) === c && (!extras.has(x) || claimed.get(x).has(k)))) q = x;
            }
            if (q === null) q = paintExtra(wish);
            if (q === null) { inc('painted pixels without a palette'); continue; }
            img[i] = q;
        }
        out.set(uk, { ...o, img: img.some(x => x) ? img : null, opq: opq && img.some(x => x) });
        inc('painted characters');
    }
    // req.cellPaintFit (an overlay with few palettes): when the requested ramps need more palettes than are left, each
    // painted pixel asks only for its painted colours (shared via paintExtra), so painting a box's letters takes one
    // palette rather than one per ramp; the pixel's other shades (a fade's) then show that palette's
    const fullRamp = r => {
        const cands = new Set(byColour.get(1 + r[1]) || []); for (const [x, ex] of extras) if (ex[1] === r[1]) cands.add(x);
        for (const x of [...cands].sort((a, b) => a - b)) if ([0, 1, 2, 3].every(k => shows(x, k) === r[k])) return x;
        return null;
    };
    const paintJobs = [];
    const assignCell = (job, relaxed) => {
        const { e, img, ramps, cut, wish } = job;
        for (const [i, r] of ramps) {
            if (cut.has(i)) { img[i] = 0xFF; continue; }
            let q = null;
            if (!relaxed) {
                q = fullRamp(r);
                if (q === null) q = ownExtra(new Map(r.map((c, k) => [k, c])));
            } else {
                const w = wish.get(i);
                for (let x = 1; x < Math.min(256, LIMIT) && q === null; x++) {
                    if (!(x < NP && !isFree(x)) && !ppal.has(x) && !(x >= PATCH0 * 4 && x < (PATCH0 + pgroups.length) * 4) && !extras.has(x)) continue;
                    if ([...w].every(([k, c]) => shows(x, k) === c && (!extras.has(x) || claimed.get(x).has(k)))) q = x;
                }
                if (q === null) q = paintExtra(w);
            }
            if (q === null) { inc('painted cell pixels without a palette'); continue; }
            img[i] = q;
        }
        e.img = img; inc('painted cells');
    };
    /**
     * A context's cells painted per cell (req.cellPaint: [{name, cell, base: {list, chr} | null, paints: [{t, sel, plt,
     * px}]}]), last, so everything else keeps its palettes. A cell's pixel slot names a palette per pixel position,
     * whatever character the game puts there (a picture's animation frames share their cells), so a painted pixel
     * changes the ramp of its position: the palette its slot (else the cell's group) shows there, with the painted
     * colour at the shade the character's value has. That ramp takes a palette that shows it, else one of its own
     * (ownExtra). `base` names where the cell's attribute comes from when no request of `name` names it (the map's rule).
     */
    for (const cp of req.cellPaint || []) {
        const l = listOf(cp.name);
        let e = null; for (let k = l.length - 1; k >= 0 && !e; k--) if (l[k].cell === cp.cell) e = l[k];
        if (!e) {
            let attr = null;
            const bl = cp.base ? lists.get(cp.base.list) || [] : [];
            if (cp.base?.chr === undefined) attr = bl[0]?.attr ?? null;               // 'const': the map's one request
            else {                                                                    // 'table': the character's, else the most common
                for (const x of bl) if (x.cell === cp.base.chr) attr = x.attr;
                if (attr === null) { const cnt = new Map(); for (const x of bl) cnt.set(x.attr, (cnt.get(x.attr) || 0) + 1); attr = [...cnt].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; }
            }
            if (attr === null || attr & 0x80) { inc('painted cells shown by their character (not paintable)'); continue; }
            e = { cell: cp.cell, attr, img: new Uint8Array(64), opq: false }; addEntry(cp.name, e);
        }
        if (e.attr & 0x80) { inc('painted cells shown by their character (not paintable)'); continue; }
        const img = e.img ? e.img.slice() : new Uint8Array(64), ramps = new Map(), cut = new Set(), wish = new Map();
        for (const { t, sel, plt, px } of cp.paints) for (let i = 0; i < 64; i++) {
            const h = px[i]; if (h == null) continue;
            const v = value(t, i); if (!v) continue;                    // value 0 stays as the game draws it
            const s = shade(plt, v) || v;                                // a way that puts it at shade 0 uses its lit shade
            if (!ramps.has(i)) { const p = img[i] && img[i] !== 0xFF ? img[i] : (e.attr & 0x3F) * 4 + sel; ramps.set(i, [0, 1, 2, 3].map(k => shows(p, k))); }
            if (h === '') cut.add(i); else { ramps.get(i)[s] = h; cut.delete(i); (wish.get(i) || wish.set(i, new Map()).get(i)).set(s, h); }
        }
        const job = { e, img, ramps, cut, wish };
        if (req.cellPaintFit) paintJobs.push(job); else assignCell(job, false);
    }
    if (paintJobs.length) {
        const need = new Set();
        for (const { ramps, cut } of paintJobs) for (const [i, r] of ramps) if (!cut.has(i) && fullRamp(r) === null) need.add(r.join());
        const relaxed = need.size > (xown.length - no) + (xfree.length - nx);
        if (relaxed) stats['painted cells: shared palettes'] = 1;
        for (const job of paintJobs) assignCell(job, relaxed);
    }
    for (const [dst, src] of pkg.appends || []) listOf(dst).push(...(lists.get(src) || []));
    for (const [name, o] of Object.entries(LOPT)) if (o.sort) lists.get(name)?.sort((a, b) => a.cell - b.cell);

    // ---- Color RAM: one image per scene (colour tokens '$…' resolve per scene), else one
    const scenes = pkg.scenes && pkg.scenes.length ? pkg.scenes : [null];
    const crams = scenes.map((sc, si) => {
        const res = c => { if (c[0] !== '$') return c; const r = pkg.tokens?.[c]; if (!r) throw new Error('unknown colour token ' + c); return r[si]; };
        const cram = new Uint8Array(256 * 16), cv = new DataView(cram.buffer);
        for (let p = 0; p < NP; p++) for (let s = 0; s < 4; s++) cv.setUint32(p * 16 + s * 4, rgb888(res(pal[p][s])), true);
        for (const [q, e] of extras) for (let s = 0; s < 4; s++) cv.setUint32(q * 16 + s * 4, rgb888(res(e[s])), true);
        if (OPQOWN) for (const [c, q] of opqPal) if (!opqShort.has(c)) cv.setUint32(q * 16, rgb888(res(c)), true);   // P.opq 'own'
        for (const q of ppal.keys()) for (let s = 0; s < 4; s++) cv.setUint32(q * 16 + s * 4, rgb888(res(ppalColour(q, s))), true);
        pgroups.forEach((g, k) => {
            for (let sel = 0; sel < 4; sel++) for (let s = 0; s < 4; s++) {
                let c = g.get(sel * 4 + s);
                if (!c) for (let q = 0; q < 4; q++) if (g.has(q * 4 + s)) { c = g.get(q * 4 + s); break; }
                cv.setUint32(((PATCH0 + k) * 4 + sel) * 16 + s * 4, rgb888(res(c || GREY[s])), true);
            }
        });
        return [sc === null ? 'cram' : 'cram:' + sc, cram];
    });

    return { out, lists, LOPT, crams, groups, extras, items, opqCols, pgroups, PATCH0, NP, units, xfree: xfree.concat(xown) };
}

// ---- the compiler ------------------------------------------------------------------------------------------------

// ---- contexts: games whose colours follow the screen or stage shown (Dragon Hopper, README "Contexts"). The first
// context whose gates all hold is active; each compiles on its own into Color RAM, attributes and pixel slots plus a DMA
// list the runtime runs on entry, and maps whose attribute follows a table of their own get a sweep
const WATCH_MAX = 496;                       // watched characters per context: the runtime's cache (ctxrt state + 0x40)
const VCU = { cram: 0x79000, chrcol: 0xA2000, chrpix: 0xA4000, slots: 0xB0000, cellattr: 0x60000, cellpix: 0x80000, objattr: 0x70000 };
const ZERO = 0x04000000;
// Backdrop Row Table: 256 rows of four RGB888 words, one per shade
const BKROW = 0x030A1000;

// a context's painted backdrop (the last layer's `backdrops[id]` wins) as a Backdrop Row Table: one colour per row from
// the top, rows below the last take the last, every shade the same; null without one
function backdropRows(paint, id) {
    let rows = null;
    for (const layer of paint || []) rows = layer.backdrops?.[id] ?? layer.backdrops?.[String(id)] ?? rows;
    return rows && rows.length ? rowTable(rows) : null;
}

function rowTable(rows) {
    const out = new Uint8Array(256 * 16), dv = new DataView(out.buffer);
    for (let y = 0; y < 256; y++) {
        const h = rows[Math.min(y, rows.length - 1)];
        for (let k = 0; k < 4; k++) dv.setUint32(16 * y + 4 * k, rgb888(h), true);
    }
    return out;
}

function compileContexts(pkg, original, rom, opts, stats) {
    const P0 = pkg.params, blobs = new Map(), records = [];
    const OVG = P0.overlay_groups ?? 0, OV0 = 64 - OVG;              // the top groups belong to the overlays
    // context.backdrop (the backdrop palette, CBKPAL without BKREN) takes the first palette of the group below the
    // overlays', and the context's registers point CBKPAL at it
    const BKG = pkg.contexts.some(C => C.backdrop) ? OV0 - 1 : null, BKP = BKG === null ? null : 4 * BKG;
    const P = { ...P0, top: BKG ?? OV0 };
    const byContent = new Map();                                     // identical blobs are stored once
    const blob = (name, data, align = 4) => {
        const h = hexBytes(data.length > 64 ? data.subarray(0, 64) : data) + ':' + data.length + ':' + crc32(data) + ':' + align;
        const same = byContent.get(h);
        if (same && blobs.get(same).data.every((x, i) => x === data[i])) return '@' + same;
        if (!blobs.has(name)) { blobs.set(name, { data, align }); byContent.set(h, name); }
        return '@' + name;
    };
    const fill = (v, n) => blob(`fill:${v.toString(16)}:${n}`, new Uint8Array(n).fill(v));
    const slotMaps = new Set();                                      // maps with cell slots in any context, always cleared
    for (const C of pkg.contexts) for (const [m, , w] of C.cells || []) if (w && w.slot) slotMaps.add(m);
    const sweepN = P.sweep ?? 256;
    const per = {};
    let watchIn = 0;                                                  // characters of the largest when_painted watch in
    // overlays set the Cell Pixel Attributes of cells painted per cell by byte writes, but on leaving an overlay the
    // runtime only reruns the context's operations, which rewrite just the maps with cell slots; so every other context
    // clears those cells (first to last painted cell per map) on entry and whenever an overlay closes
    const OVK = overlayKeys(pkg), ovPainted = new Map();             // map -> [first cell, last cell]
    for (const k of OVK.keys()) if (pkg.contexts.some(C => C.id === k) || (pkg.shared || []).some(S => S.id === k))
        throw new Error(`overlay key id ${k} is also a context's or shared group's id (params.overlay_key0)`);
    for (const layer of opts.paint || []) for (const key of Object.keys(layer.tiles || {})) {
        const k = contextCellKey(key);
        if (!k || k.kind !== 'c' || !OVK.has(k.ctx)) continue;
        const r = ovPainted.get(k.map); ovPainted.set(k.map, r ? [Math.min(r[0], k.cell), Math.max(r[1], k.cell)] : [k.cell, k.cell]);
    }
    for (const C of pkg.contexts) {
        const st = {}; per[C.id] = st;
        const keySlot = new Map(), keyUnits = new Map();
        for (const [c, h] of Object.entries(C.tiles)) keySlot.set('k:' + c, { t: Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16))) });
        for (const u of readUnits(C.units)) { const s = keySlot.get(u.id); if (!s) throw new Error(`context ${C.id}: no tile for ${u.id}`); u.t = s.t; keyUnits.set(u.id, u); }
        // the watch's units (characters coloured by content) are 'w:<n>'. W.paint_only contents (no recording coloured
        // them, the runtime draws them with the fallback attribute: Wario Land's transformations) only take part once
        // painted, so the unpainted package compiles to the same ROM
        let W = C.watch;
        const paintOnly = new Set(W?.paint_only || []);
        if (W) for (const u of readUnits(W.units)) {
            const t = Uint8Array.from(W.tiles[u.id].match(/../g).map(x => parseInt(x, 16)));
            keySlot.set(u.id, { t }); u.t = t; keyUnits.set(u.id, u);
        }
        // shared keys first, so the context's own paint wins over them
        for (const layer of opts.paint || []) paintShared(layer, pkg.shared, C, keySlot, keyUnits, P, st);
        for (const layer of opts.paint || []) paintContext(layer, C, keySlot, keyUnits, P, st);
        for (const id of paintOnly) if (keyUnits.get(id) && !keyUnits.get(id).ctx.some(c => c.painted)) keyUnits.delete(id);
        // W.when_painted (Dragon Hopper's Dorin, the story pictures' animated characters): the watch is only in once one of
        // its contents is painted, so the unpainted context compiles to the same ROM
        if (W?.when_painted && ![...keyUnits.values()].some(u => u.id.startsWith('w:') && u.ctx.some(c => c.painted))) {
            // W.always (2026-11-16, Dragon Hopper dev159's status-line magic icon): the ranges (by their first character)
            // that stay in unpainted, with their units marked `always`; the rest of the watch comes in with paint
            const keep = new Set(W.always || []), always = new Set((W.units || []).filter(u => u.always).map(u => u.id));
            for (const id of [...keyUnits.keys()]) if (id.startsWith('w:') && !always.has(id)) keyUnits.delete(id);
            // (the watch's cells / chrsel belong to the ranges that come in with paint: they stay as without the watch)
            W = keep.size ? { ...W, ranges: (W.ranges || [[W.lo, W.count]]).filter(r => keep.has(r[0])), cells: undefined, chrsel: undefined } : null;
        }
        // a character painted over a whole map becomes CHRSEL there, its unit taking the map's colours with the paint on
        // top; a single painted cell gets its pixel slot ramps changed later (allocate's req.cellPaint)
        const CPT = contextCellPaint(opts.paint, C, pkg.shared), swept = new Map(), cellPaint = [];
        const ruleOf = m => (C.maps || []).find(R => R.map === m);
        const reqMaps = new Set((C.cells || []).map(c => c[0]));
        const cellErr = d => new ContextPaintError('context-cell-paint', C.name ?? C.id, d);
        for (const [m, chrs] of CPT.maps) {
            const R = ruleOf(m);
            if (!R || (R.mode !== 'const' && R.mode !== 'table')) throw cellErr(`map ${m} shows its cells by character`);
            if (reqMaps.has(m)) throw cellErr(`map ${m} has cells of their own colours: paint them one by one`);
            // characters a 'table' map does not name get its most common entry from the sweep
            let common = null;
            if (R.mode === 'table') { const n = new Map(); for (const w of Object.values(R.wants)) { const k = JSON.stringify(w); n.set(k, (n.get(k) || 0) + 1); } common = R.want ?? JSON.parse([...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'null'); }
            for (const [chr, ways] of chrs) {
                const slot = keySlot.get('k:' + chr);
                if (!slot) throw cellErr(`no character ${chr}`);
                const want = (R.mode === 'const' ? R.want : R.wants[chr] ?? common) || [];
                const colourOf = (sel, s) => {
                    const at = q => want.find(([q2, s2]) => q2 === q && s2 === s)?.[2];
                    let c = at(sel); for (let q = 0; q < 4 && !c; q++) c = at(q);
                    return c || P.grey[s];
                };
                const full = {};
                for (const [way, px] of Object.entries(ways)) {
                    const { side, sel, plt } = parseCtx(way);
                    if (side) continue;
                    full[way] = px.map((h, i) => { const v = value(slot.t, i); return !v ? null : h != null ? h : colourOf(sel, shade(plt, v)); });
                }
                let u = keyUnits.get('k:' + chr);
                if (!u) {
                    let o = 0; for (let i = 0; i < 64; i++) if (value(slot.t, i)) o++;
                    u = { id: 'k:' + chr, kind: 1, t: slot.t, o, seen: true, z: null, ctx: [] };
                    keyUnits.set(u.id, u);
                }
                paintUnit(u, u.t, full, P);
                st['painted load positions'] = (st['painted load positions'] || 0) + 1;
                const s = swept.get(m) || new Set(); swept.set(m, s); s.add(chr);
            }
        }
        for (const e of CPT.cells.values()) {
            const R = ruleOf(e.map);
            if (!R && !reqMaps.has(e.map)) throw cellErr(`map ${e.map} is not the context's`);
            if (swept.get(e.map)?.size) throw cellErr(`map ${e.map} is painted by character`);
            const paints = [];
            for (const [chr, ways] of e.chrs) {
                const slot = keySlot.get('k:' + chr);
                if (!slot) throw cellErr(`no character ${chr}`);
                for (const [way, px] of Object.entries(ways)) { const { side, sel, plt } = parseCtx(way); if (!side) paints.push({ t: slot.t, sel, plt, px }); }
            }
            // where no request names the cell its attribute is the map's; for 'table' the first painted character's, as
            // a cell holds one at a time
            const base = R?.mode === 'const' ? { list: `const:${e.map}` } : R?.mode === 'table' ? { list: `table:${e.map}`, chr: [...e.chrs.keys()][0] } : null;
            cellPaint.push({ name: `map:${e.map}`, cell: e.cell, base, paints });
        }
        for (const u of keyUnits.values()) { u.sk = u.id; u.uk = '1:' + u.id; }
        // map rules and cells as cell requests: const map = one request, table map = one per character
        const cells = [], lists = {};
        for (const R of C.maps || []) {
            if (R.mode === 'const') cells.push([`const:${R.map}`, 0, R.want]);
            if (R.mode === 'table') for (const [c, w] of Object.entries(R.wants)) cells.push([`table:${R.map}`, +c, w]);
            // a 'table' rule's `want` colours the characters it does not name; without it the sweep would give them the
            // attribute most entries have (Dragon Hopper dev158's red hearts would have become that)
            if (R.mode === 'table' && R.want) cells.push([`tablerest:${R.map}`, 0, R.want]);
        }
        // W.chrsel (Dragon Hopper's enemies on BG map 8): while the watch is in, these characters are CHRSEL in the
        // 'table' map's sweep so their cells show the watch's colours; 'const' maps list their cells in W.cells instead
        const selMaps = new Map([...swept].map(([m, s]) => [m, new Set(s)]));
        if (W?.chrsel) for (const [m, chrs] of Object.entries(W.chrsel)) {
            if (ruleOf(+m)?.mode !== 'table') throw new Error(`context ${C.id}: watch chrsel on map ${m}, which is no 'table' map`);
            const s = selMaps.get(+m) || new Set(); selMaps.set(+m, s); for (const c of chrs) s.add(+c);
        }
        for (const [m, chrs] of selMaps) for (const chr of [...chrs].sort((a, b) => a - b)) cells.push([`table:${m}`, chr, 'chrsel']);
        for (const [m, cell, w] of C.cells || []) { cells.push([`map:${m}`, cell, w]); lists[`map:${m}`] = { entry: 8, unique: true }; }
        for (const e of cellPaint) lists[e.name] = { entry: 8, unique: true };
        // W.cells (a picture's animated cells) go by character while the watch is in, otherwise they're coloured per cell
        if (W?.cells) for (const [m, cell] of W.cells) { cells.push([`map:${m}`, cell, 'chrsel']); lists[`map:${m}`] = { entry: 8, unique: true }; }
        const sc = C.scenes && C.scenes.length ? C.scenes : null;
        // slots go from P.slot0 up to the watch's (the top 1024 minus its characters), some kept for cell slots
        const wTotal = W ? (W.ranges || [[W.lo, W.count]]).reduce((n, r) => n + r[1], 0) : 0;
        const Pc = { ...P, slot_budget: P.slot_budget ?? (W?.slot0 ?? P.watch_slot0 ?? 1024 - wTotal) - (P.slot0 ?? 1) - (P.cell_slot_reserve ?? 64) };
        const A = allocate(Pc, new Map(), keyUnits, keySlot, { cells, lists, appends: [], scenes: sc && sc.map(x => x.name), tokens: C.tokens, cellPaint }, st);
        const slotImgs = new Map(); const slotOf = img => { const k = hexBytes(img); if (!slotImgs.has(k)) slotImgs.set(k, { n: slotImgs.size + (P.slot0 ?? 1), img }); return slotImgs.get(k).n; };
        const chrcol = new Uint8Array(4096), chrpix = new Uint8Array(4096), cp = new DataView(chrpix.buffer);
        for (const u of keyUnits.values()) {
            if (!u.id.startsWith('k:')) continue;                    // watch units go through the watch table
            const e = A.out.get(u.uk); if (!e) continue; const c = +u.id.slice(2);
            chrcol[2 * c] = e.w & 0xFF; chrcol[2 * c + 1] = e.w >> 8;
            if (e.img) cp.setUint16(2 * c, 0x8000 | (e.opq ? 0x4000 : 0) | slotOf(e.img), true);
        }
        const ops = [], sweeps = [];
        const op = (dst, src, hw) => ops.push([dst, src, hw]);
        // a 'const' map painted by character gets a sweep, which only sees the map once the game has drawn it. The
        // runtime slows sweeps to an eighth after a pass without changes (256 cells a call took ~5 s for a stage), so
        // such a context sweeps params.sweep_painted (1024) cells a call, all its sweeps alike as they share a cursor
        // C.sweep (Dragon Hopper dev161, the overworld screens): the context's own count, e.g. a screen whose 'table' maps
        // the game rewrites while it pans (the cells kept their last attribute until the slowed sweep came by)
        const sweepC = C.sweep ?? ([...swept.keys()].some(m => ruleOf(m)?.mode === 'const') ? Math.max(sweepN, P.sweep_painted ?? 1024) : sweepN);
        if (C.backdrop) for (const [, cram] of A.crams) C.backdrop.forEach((h, k) => new DataView(cram.buffer, cram.byteOffset).setUint32(16 * BKP + 4 * k, rgb888(h), true));
        op(VCU.cram, blob(`cram:${C.id}`, A.crams[0][1], 16), 0x800);
        op(VCU.chrcol, blob(`chrcol:${C.id}`, chrcol), 0x800);
        op(VCU.chrpix, blob(`chrpix:${C.id}`, chrpix), 0x800);
        const attrOf = e => e.attr;
        const mapsDone = new Set(), mapAttr = new Map();     // for watch range fallbacks (below)
        for (const R of C.maps || []) {
            const img = new Uint8Array(0x1000);
            if (R.mode === 'chr') img.fill(0x80);
            else if (R.mode === 'const') {
                img.fill(attrOf(A.lists.get(`const:${R.map}`)[0]));
                { const a0 = img[0]; mapAttr.set(R.map, () => a0); }
                // characters painted over the whole map need a sweep that gives them CHRSEL
                if (swept.get(R.map)?.size) {
                    const tab = new Uint8Array(2048).fill(img[0]);
                    for (const e of A.lists.get(`table:${R.map}`) || []) tab[e.cell] = e.attr;
                    sweeps.push([R.map, sweepC, blob(`table:${C.id}:${R.map}`, tab)]);
                }
            } else {
                const tab = new Uint8Array(2048), cnt = new Map(), painted = selMaps.get(R.map) || new Set();
                for (const e of A.lists.get(`table:${R.map}`) || []) {
                    tab[e.cell] = e.attr;
                    if (!(painted.has(e.cell) && e.attr === 0x80)) cnt.set(e.attr, (cnt.get(e.attr) || 0) + 1);
                }
                const common = R.want ? attrOf(A.lists.get(`tablerest:${R.map}`)[0]) : [...cnt].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
                { const first = new Map(); for (const e of A.lists.get(`table:${R.map}`) || []) if (!first.has(e.cell) && e.attr !== 0x80) first.set(e.cell, e.attr);
                  mapAttr.set(R.map, c => first.get(c) ?? common); }
                for (let c = 0; c < 2048; c++) if (!(R.wants[c]) && !painted.has(c)) tab[c] = common;
                img.fill(common);
                sweeps.push([R.map, sweepC, blob(`table:${C.id}:${R.map}`, tab)]);
            }
            for (const e of A.lists.get(`map:${R.map}`) || []) img[e.cell] = e.attr;
            const same = img.every(x => x === img[0]);
            op(VCU.cellattr + R.map * 0x1000, same ? fill(img[0], 0x1000) : blob(`cellattr:${C.id}:${R.map}`, img), 0x800);
            mapsDone.add(R.map);
        }
        // Cell Pixel Attributes: the context writes the maps it has cell slots on and clears them when it is left
        const exit = [], pixMaps = new Set();
        for (const m of new Set([...slotMaps, ...cellPaint.map(e => +e.name.slice(4))])) {
            const pix = new Uint8Array(0x2000), dv = new DataView(pix.buffer); let any = false;
            for (const e of A.lists.get(`map:${m}`) || []) if (e.img && e.img.some(x => x)) { dv.setUint16(2 * e.cell, 0x8000 | (e.opq ? 0x4000 : 0) | slotOf(e.img), true); any = true; }
            if (!any) continue;
            op(VCU.cellpix + m * 0x2000, blob(`cellpix:${C.id}:${m}`, pix), 0x1000); exit.push([VCU.cellpix + m * 0x2000, ZERO, 0x1000]);
            pixMaps.add(m);
        }
        // clears the overlays' painted cells (see above) on maps this context does not write
        for (const [m, [lo, hi]] of [...ovPainted].sort((a, b) => a[0] - b[0])) if (!pixMaps.has(m)) op(VCU.cellpix + m * 0x2000 + 2 * lo, ZERO, hi - lo + 1);
        if (slotImgs.size) {
            const first = P.slot0 ?? 1, b = new Uint8Array(64 * slotImgs.size);
            for (const { n, img } of slotImgs.values()) b.set(img, 64 * (n - first));
            op(VCU.slots + 64 * first, blob(`slots:${C.id}`, b, 64), 32 * slotImgs.size);
        }
        // the runtime reruns the operations when an overlay (a dialog box) closes, rewriting the watched characters'
        // attributes; clearing the watch's cache (params.ctx_state + 0x40) makes it look them all up again in the same
        // frame instead of keeping those attributes until their content changes
        if (W?.when_painted) {
            const n = (W.ranges || [[W.lo, W.count]]).reduce((k, r) => k + r[1], 0);
            op(((P.ctx_state ?? 0x0309F800) + 0x40) - 0x03000000, ZERO, 2 * n);
            watchIn = Math.max(watchIn, n);
        }
        // objects go by character (CHRSEL), except OAM entries the context names as cells of map 'obj' (Bound High's
        // Pachin reference objects 27..36)
        const objCells = A.lists.get('map:obj') || [];
        if (objCells.length) {
            const img = new Uint8Array(0x400).fill(0x80);
            for (const e of objCells) img[e.cell] = e.attr;
            op(VCU.objattr, blob(`objattr:${C.id}`, img), 0x200);
        } else op(VCU.objattr, fill(0x80, 0x400), 0x200);
        // the backdrop's rows painted: the context's Backdrop Row Table (with BKREN) instead of the package's
        const rows = backdropRows(opts.paint, C.id);
        const blobsOf = rows ? [...(C.blobs || []).filter(([dst]) => dst !== BKROW), [BKROW, rows]] : C.blobs || [];
        for (const [dst, data] of blobsOf) {
            const bytes = typeof data === 'string' ? b64(data) : data;
            op(dst - 0x03000000, blob(`data:${C.id}:${hex8(dst)}`, bytes), bytes.length / 2);
        }
        const scenes = sc ? sc.map((x, k) => [x.gates, blob(`cram:${C.id}:${k}`, A.crams[k][1], 16)]) : [];
        // the watch: a sorted table hash -> (Character Color Attribute, slot image), the images, the descriptor
        let watch = null;
        if (W) {
            const rx = t => { let h = 0; for (let k = 0; k < 4; k++) { const w = (t[4 * k] | t[4 * k + 1] << 8 | t[4 * k + 2] << 16 | t[4 * k + 3] << 24) >>> 0; h = (((h << 7) | (h >>> 25)) ^ w) >>> 0; } return h; };
            // ranges of characters (W.ranges, or W.lo / W.count): each character has a cache word and a slot of its own
            let ranges = W.ranges || [[W.lo, W.count]]; const total = ranges.reduce((n, r) => n + r[1], 0);
            // a range's fallback with a source ([lo, count, fallback, 'chr' | 'm<map>']) is taken from this compile, since
            // the recorded one names a group of the unpainted build and paint can move the groups
            const fbNew = new Map();
            ranges = ranges.map(r => {
                if (!r[3]) return r;
                const lo = r[0], word = chrcol[2 * lo] | chrcol[2 * lo + 1] << 8;
                let fb = word;
                if (r[3] !== 'chr') { const at = mapAttr.get(+r[3].slice(1)); if (at) fb = (word & 0xFF00) | (at(lo) & 0xFF); }
                fbNew.set(r[2], fb); return [r[0], r[1], fb];
            });
            const fbNewOf = fb => fbNew.get(fb);
            const imgs = new Map(), pool = [], ents = new Map(), fbOf = new Map((W.units || []).filter(u => u.fb !== undefined).map(u => [u.id, u.fb]));
            for (const u of keyUnits.values()) {
                if (!u.id.startsWith('w:')) continue;
                const e = A.out.get(u.uk); if (!e) continue;
                let idx = 0;
                if (e.img) { const k = hexBytes(e.img); if (!imgs.has(k)) { imgs.set(k, pool.length + 1); pool.push(e.img); } idx = imgs.get(k) | (e.opq ? 0x8000 : 0); }
                // a unit with `fb` and no Cell way keeps the fallback's Cell byte, so BG cells showing the same character
                // keep their group (Dragon Hopper's status line over Dorin's characters)
                const fb0 = fbOf.get(u.id), fb = fb0 !== undefined && W.ranges?.some(r => r[3]) ? (fbNewOf(fb0) ?? fb0) : fb0, w = fb !== undefined && !u.ctx.some(c => !c.side) ? (e.w & 0xFF00) | (fb & 0xFF) : e.w;
                const h = rx(u.t); if (!ents.has(h)) ents.set(h, [w, idx]);
            }
            const keys = [...ents.keys()].sort((a, b) => a - b);
            const tb = new Uint8Array(8 * keys.length), tv = new DataView(tb.buffer);
            keys.forEach((h, k) => { const [w, i] = ents.get(h); tv.setUint32(8 * k, h, true); tv.setUint16(8 * k + 4, w, true); tv.setUint16(8 * k + 6, i, true); });
            const pb = new Uint8Array(64 * Math.max(1, pool.length)); pool.forEach((im, k) => pb.set(im, 64 * k));
            if (total > WATCH_MAX) throw new Error(`context ${C.id}: watch of ${total} characters (at most ${WATCH_MAX})`);
            const base = W.slot0 ?? P.watch_slot0 ?? 1024 - total, used = (P.slot0 ?? 1) + slotImgs.size;
            if (used > base) throw new Error(`context ${C.id}: slots ${used} reach the watch's ${base}`);
            watch = { ranges, base, table: blob(`wtab:${C.id}`, tb), n: keys.length, pool: blob(`wpool:${C.id}`, pb, 64), fallback: W.fallback ?? 0 };
            st.watch_entries = keys.length; st.watch_images = pool.length;
        }
        const regs = [...(C.regs || []), ...(C.backdrop ? [[0x0C, BKP]] : [])];
        records.push({ C, ops, sweeps, scenes, exit, watch, regs });
        // cell paint must fit the pixel slots below the watch's or the overlays' (overlay_slot0) and the palettes
        if (CPT.maps.size || CPT.cells.size) {
            const name = C.name ?? C.id;
            const top = W ? (W.slot0 ?? P.watch_slot0 ?? 1024 - wTotal) : pkg.overlays?.length ? (P0.overlay_slot0 ?? 896) : 1024;
            if ((P.slot0 ?? 1) + slotImgs.size > top || st['tiles without slot room'])
                throw new ContextPaintError('context-slots-full', name, `${slotImgs.size + (st['tiles without slot room'] || 0)} pixel slot images, room for ${Math.min(top - (P.slot0 ?? 1), Pc.slot_budget)}`);
            if (st['painted cell pixels without a palette'])
                throw new ContextPaintError('context-palettes-full', name, `${st['painted cell pixels without a palette']} painted pixels without a palette`);
            // every pixel of a character painted over a whole map must show its colour in the first Color RAM
            const cram = A.crams[0][1];
            let short = 0;
            for (const chrs of swept.values()) for (const chr of chrs) {
                const u = keyUnits.get('k:' + chr), e = u && A.out.get(u.uk); if (!e) continue;
                for (const c of u.ctx) {
                    if (!c.painted || c.side) continue;
                    for (let i = 0; i < 64; i++) {
                        const h = c.W[i], v = value(u.t, i), s = shade(c.plt, v);
                        if (!v || !s || !h || h[0] !== '#') continue;
                        const p = e.img && e.img[i] && e.img[i] !== 0xFF ? e.img[i] : (e.w & 0x3F) * 4 + c.sel, q = 16 * p + 4 * s;
                        if ('#' + [cram[q], cram[q + 1], cram[q + 2]].map(x => x.toString(16).padStart(2, '0')).join('') !== h.toLowerCase()) short++;
                    }
                }
            }
            if (short) throw new ContextPaintError('context-palettes-full', name, `${short} painted pixels without a palette`);
        }
        st.slots = slotImgs.size;
        stats[`context ${C.id}`] =Object.fromEntries(Object.entries(st).filter(([k]) => /fidelity|slots|groups|short|cannot|palettes/.test(k)));
        Object.assign(stats[`context ${C.id}`], { dma: ops.reduce((n, x) => n + x[2], 0), groups: A.groups.length, extras: A.extras.size, patch_groups: A.pgroups.length,
            palettes_free: A.PATCH0 * 4 - A.NP - A.extras.size });
    }
    const painted = Object.values(per).reduce((n, st) => n + (st['painted load positions'] || 0), 0);
    if (painted) stats['painted load positions'] = painted;
    // ---- overlays (README "Overlays"): screens over a context (pause, menus, dialogs), each compiled on its own into the
    // top groups (OV0..63) and the slots from P.overlay_slot0; Color RAM goes by DMA, attributes by byte writes, so the
    // context's other cells stay. When it is left, the runtime reruns the context's operations
    const ovRecords = [];
    // (several records of one id may differ: a variant gated on what a changing character shows, e.g. the magic menu's
    // selected card; their blobs are named per record, identical ones are still stored once)
    for (const [ovIx, O] of (pkg.overlays || []).entries()) {
        const st = {};
        const Pov = { ...P0, groups: Math.min(P0.groups, P0.overlay_main_groups ?? OVG), top: OVG, limit: OVG * 4, slot0: P0.overlay_slot0 ?? 896 };
        const keySlot = new Map(), keyUnits = new Map();
        for (const [c, h] of Object.entries(O.tiles)) keySlot.set('k:' + c, { t: Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16))) });
        for (const u of readUnits(O.units)) { u.t = keySlot.get(u.id).t; u.sk = u.id; u.uk = '1:' + u.id; keyUnits.set(u.id, u); }
        const cells = (O.cells || []).map(([m, cell, w]) => ['cells', m * 4096 + cell, w]);
        const okey = overlayKeyId(pkg, O.id), oname = O.name ?? `overlay ${O.id}`;
        const ovErr = (code, d) => new ContextPaintError(code, oname, d);
        const OP = overlayPaint(opts.paint, O, okey, keyUnits, ovErr);
        const unitPaint = new Map([...OP.units].map(([id, ways]) => ['1:' + id, { t: keyUnits.get(id).t, ways }]));
        const A = allocate(Pov, new Map(), keyUnits, keySlot, { cells, lists: {}, appends: [], cellPaint: OP.cells, cellPaintFit: true, unitPaint }, st);
        const rel = p => (p === 0 || p === 0xFF) ? p : p + OV0 * 4;
        const bytes = [];                                            // [VCU-relative address, value]
        const slotImgs = new Map(); const slotOf = img => { const k = hexBytes(img); if (!slotImgs.has(k)) slotImgs.set(k, { n: slotImgs.size + Pov.slot0, img: img.map(rel) }); return slotImgs.get(k).n; };
        for (const u of keyUnits.values()) {
            const e = A.out.get(u.uk); if (!e) continue; const c = +u.id.slice(2);
            const sides = new Set(u.ctx.map(x => x.side));
            if (sides.has(0)) bytes.push([VCU.chrcol + 2 * c, (e.w & 0xFF) + OV0]);
            if (sides.has(1)) bytes.push([VCU.chrcol + 2 * c + 1, (e.w >> 8) + OV0]);
            const px = e.img ? 0x8000 | (e.opq ? 0x4000 : 0) | slotOf(e.img) : 0;
            bytes.push([VCU.chrpix + 2 * c, px & 0xFF], [VCU.chrpix + 2 * c + 1, px >> 8]);
        }
        for (const e of A.lists.get('cells') || []) bytes.push([VCU.cellattr + e.cell, e.attr + OV0]);
        // cells painted per cell: their pixel slots (the runtime writes the bytes after the slot images' DMA)
        for (const e of A.lists.get('cells') || []) {
            if (!e.img || !e.img.some(x => x)) continue;
            const px = 0x8000 | (e.opq ? 0x4000 : 0) | slotOf(e.img);
            bytes.push([VCU.cellpix + 2 * e.cell, px & 0xFF], [VCU.cellpix + 2 * e.cell + 1, px >> 8]);
        }
        if (OP.units.size || OP.cells.length) {
            if (Pov.slot0 + slotImgs.size > 1024 || st['tiles without slot room'])
                throw ovErr('context-slots-full', `${slotImgs.size} pixel slot images, room for ${1024 - Pov.slot0}`);
            const short = (st['painted cell pixels without a palette'] || 0) + (st['painted pixels without a palette'] || 0) + overlayPaintShort(A, keyUnits, OP);
            if (short) throw ovErr('context-palettes-full', `${short} painted pixels without a palette`);
        }
        const ops = [[VCU.cram + OV0 * 64, blob(`ovcram:${O.id}:${ovIx}`, A.crams[0][1].subarray(0, OVG * 64), 16), OVG * 32]];
        // entering an overlay may overwrite watched characters' attributes (a dialog box over a story picture), so the
        // watch's cache is cleared as well
        if (watchIn) ops.push([((P0.ctx_state ?? 0x0309F800) + 0x40) - 0x03000000, ZERO, 2 * watchIn]);
        if (slotImgs.size) {
            const b = new Uint8Array(64 * slotImgs.size);
            for (const { n, img } of slotImgs.values()) b.set(img, 64 * (n - Pov.slot0));
            ops.push([VCU.slots + 64 * Pov.slot0, blob(`ovslots:${O.id}:${ovIx}`, b, 64), 32 * slotImgs.size]);
        }
        const bl = new Uint8Array(4 + 4 * bytes.length), bv = new DataView(bl.buffer); bv.setUint32(0, bytes.length, true);
        bytes.forEach(([a, v], k) => bv.setUint32(4 + 4 * k, (a & 0xFFFFF) | (v & 0xFF) << 24, true));
        ovRecords.push({ O, ovIx, ops, bytes: blob(`ovbytes:${O.id}:${ovIx}`, bl) });
        stats[`overlay ${O.id}`] = { fidelity: st['fidelity %, surveyed'], units: keyUnits.size, cells: (O.cells || []).length,
            groups: A.groups.length, extras: A.extras.size, patch_groups: A.pgroups.length, palettes_free: A.PATCH0 * 4 - A.NP - A.extras.size,
            ...(st['painted characters'] ? { painted_characters: st['painted characters'] } : {}), ...(st['painted cells'] ? { painted_cells: st['painted cells'] } : {}) };
    }

    // ---- layout: directory, contexts' operation and sweep lists, the context table, blobs
    const D = pkg.data, view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
    let at = D.at + 4 * D.directory.length; const addr = new Map();
    // params.mirror_free (Dragon Hopper): no 16-byte block of data may equal the original's mirror at its place (a blob
    // that would make one moves on by its alignment), because VUEPort's patch overlay takes such a block as a copy of the
    // original and would lay the other patch's bytes there (a translation's text would land in the colour data)
    const MF = 16, mirrorAt = o => original[o % original.length];
    const mirrors = (o, data) => {
        for (let b = Math.floor(o / MF) * MF; b < o + data.length; b += MF) {
            let eq = true;
            for (let k = b; k < b + MF && eq; k++) eq = (k >= o && k < o + data.length ? data[k - o] : rom[k]) === mirrorAt(k);
            if (eq) return true;
        }
        return false;
    };
    let mfMoved = 0;
    const put = (name, data, align) => {
        at = Math.ceil(at / align) * align;
        if (P0.mirror_free) {
            const start = at;
            while (mirrors(cpuOff(rom, at), data)) { at += align; if (at - start > 0x10000) throw new Error(`no mirror-free place (${name})`); }
            mfMoved += at - start;
        }
        if (at + data.length > D.end) throw new DataAreaFull(name, D.end - D.at);
        rom.set(data, cpuOff(rom, at)); addr.set(name, at); at += data.length;
    };
    for (const [name, { data, align }] of blobs) put(name, data, align);
    const ref = f => typeof f === 'number' ? f : f.startsWith('@') ? addr.get(f.slice(1)) : (() => { throw new Error(f); })();
    for (const { C, ops, sweeps, scenes, exit, watch, regs } of records) {
        // registers: u32 n, n x (u16 offset from 0x0307F800, u16 value, u32 source); those with a source are rewritten
        // every frame as max(value, ld.h [source] & 0xFF)
        if (regs.length) {
            const g = new Uint8Array(4 + 8 * regs.length), gv = new DataView(g.buffer); gv.setUint32(0, regs.length, true);
            regs.forEach(([off, v, src], k) => { gv.setUint16(4 + 8 * k, off, true); gv.setUint16(6 + 8 * k, v, true); gv.setUint32(8 + 8 * k, (src ?? 0) >>> 0, true); });
            put(`regs:${C.id}`, g, 4);
        }
        if (watch) {                                                 // u32 n, n x 24-byte range descriptors (ctxrt._emit_watch)
            const d = new Uint8Array(4 + 24 * watch.ranges.length), dv = new DataView(d.buffer); let k0 = 0;
            dv.setUint32(0, watch.ranges.length, true);
            watch.ranges.forEach(([lo, count], i) => {
                const o = 4 + 24 * i;
                dv.setUint16(o, lo, true); dv.setUint16(o + 2, count, true); dv.setUint32(o + 4, ref(watch.table) >>> 0, true);
                dv.setUint32(o + 8, watch.n, true); dv.setUint32(o + 12, ref(watch.pool) >>> 0, true); dv.setUint16(o + 16, watch.ranges[i][2] ?? watch.fallback, true);   // a range's own fallback: [lo, count, attribute]
                dv.setUint16(o + 18, k0, true); dv.setUint16(o + 20, watch.base + k0, true); k0 += count;
            });
            put(`watch:${C.id}`, d, 4);
        }
        if (exit.length) {
            const o = new Uint8Array(4 + 12 * exit.length), ov = new DataView(o.buffer); ov.setUint32(0, exit.length, true);
            exit.forEach(([d, s, n], k) => { ov.setUint32(4 + 12 * k, d, true); ov.setUint32(8 + 12 * k, ref(s) >>> 0, true); ov.setUint32(12 + 12 * k, n, true); });
            put(`exit:${C.id}`, o, 4);
        }
        if (scenes.length) {                                         // u32 n, n x (u16 gates, u16 0, u32 Color RAM, gates)
            const parts = [new Uint8Array(4)]; new DataView(parts[0].buffer).setUint32(0, scenes.length, true);
            for (const [gates, cram] of scenes) {
                const r = new Uint8Array(8 + 8 * gates.length), rv = new DataView(r.buffer);
                rv.setUint16(0, gates.length, true); rv.setUint32(4, ref(cram) >>> 0, true);
                gates.forEach(([a, m, v], k) => { rv.setUint32(8 + 8 * k, a >>> 0, true); rv.setUint16(12 + 8 * k, m, true); rv.setUint16(14 + 8 * k, v, true); });
                parts.push(r);
            }
            const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { b.set(p, o); o += p.length; }
            put(`scenes:${C.id}`, b, 4);
        }
        // operations: u32 n, n x (u32 VCU-relative destination, u32 source, u32 halfwords)
        const o = new Uint8Array(4 + 12 * ops.length), ov = new DataView(o.buffer); ov.setUint32(0, ops.length, true);
        ops.forEach(([d, s, n], k) => { ov.setUint32(4 + 12 * k, d, true); ov.setUint32(8 + 12 * k, ref(s) >>> 0, true); ov.setUint32(12 + 12 * k, n, true); });
        put(`ops:${C.id}`, o, 4);
        if (sweeps.length) {                                         // u32 n, n x (u16 map, u16 cells per frame, u32 table)
            const w = new Uint8Array(4 + 8 * sweeps.length), wv = new DataView(w.buffer); wv.setUint32(0, sweeps.length, true);
            sweeps.forEach(([m, n, t], k) => { wv.setUint16(4 + 8 * k, m, true); wv.setUint16(6 + 8 * k, n, true); wv.setUint32(8 + 8 * k, ref(t) >>> 0, true); });
            put(`sweeps:${C.id}`, w, 4);
        }
    }
    // context table ('@ctxtab'): u16 id, u16 gates, u32 operations, u32 sweeps, u32 scenes, u16 keep gates, u16 0,
    // u32 exit operations, u32 watch, u32 registers, then (gates + keep gates) x (u32 address, u16 mask, u16 value);
    // id 0 ends
    const parts = [];
    for (const { C, sweeps, scenes, exit, watch, regs } of records) {
        const keep = C.keep || [], G = [...C.gates, ...keep];
        const r = new Uint8Array(32 + 8 * G.length), rv = new DataView(r.buffer);
        rv.setUint16(0, C.id, true); rv.setUint16(2, C.gates.length, true);
        rv.setUint32(4, addr.get(`ops:${C.id}`) >>> 0, true); rv.setUint32(8, sweeps.length ? addr.get(`sweeps:${C.id}`) >>> 0 : 0, true);
        rv.setUint32(12, scenes.length ? addr.get(`scenes:${C.id}`) >>> 0 : 0, true);
        rv.setUint16(16, keep.length, true); rv.setUint32(20, exit.length ? addr.get(`exit:${C.id}`) >>> 0 : 0, true);
        rv.setUint32(24, watch ? addr.get(`watch:${C.id}`) >>> 0 : 0, true);
        rv.setUint32(28, regs.length ? addr.get(`regs:${C.id}`) >>> 0 : 0, true);
        G.forEach(([a, m, v], k) => { rv.setUint32(32 + 8 * k, a >>> 0, true); rv.setUint16(36 + 8 * k, m, true); rv.setUint16(38 + 8 * k, v, true); });
        parts.push(r);
    }
    parts.push(new Uint8Array(32));
    const tab = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { tab.set(p, o); o += p.length; }
    put('ctxtab', tab, 4);
    // overlay table: records u16 id, u16 gates, u32 operations, u32 byte writes (u32 n, n x (VCU-relative address |
    // value << 24)), gates; id 0 ends
    const oparts = [];
    for (const { O, ovIx, ops, bytes } of ovRecords) {
        const o = new Uint8Array(4 + 12 * ops.length), ov = new DataView(o.buffer); ov.setUint32(0, ops.length, true);
        ops.forEach(([d, s2, n], k) => { ov.setUint32(4 + 12 * k, d, true); ov.setUint32(8 + 12 * k, ref(s2) >>> 0, true); ov.setUint32(12 + 12 * k, n, true); });
        put(`ovops:${O.id}:${ovIx}`, o, 4);
        const r = new Uint8Array(12 + 8 * O.gates.length), rv = new DataView(r.buffer);
        rv.setUint16(0, O.id, true); rv.setUint16(2, O.gates.length, true);
        rv.setUint32(4, addr.get(`ovops:${O.id}:${ovIx}`) >>> 0, true); rv.setUint32(8, ref(bytes) >>> 0, true);
        O.gates.forEach(([a2, m, v], k) => { rv.setUint32(12 + 8 * k, a2 >>> 0, true); rv.setUint16(16 + 8 * k, m, true); rv.setUint16(18 + 8 * k, v, true); });
        oparts.push(r);
    }
    oparts.push(new Uint8Array(12));
    const otab = new Uint8Array(oparts.reduce((n, p) => n + p.length, 0)); o = 0; for (const p of oparts) { otab.set(p, o); o += p.length; }
    put('ovtab', otab, 4);
    D.directory.forEach((f, k) => view.setUint32(cpuOff(rom, D.at + 4 * k), (f === '@ctxtab' ? addr.get('ctxtab') : f === '@ovtab' ? addr.get('ovtab') : ref(f)) >>> 0, true));
    stats.overlays = ovRecords.length;
    stats.contexts = records.length; stats.data_end = hex8(at); stats.data_free = D.end - at;
    if (P0.mirror_free) stats.mirror_free_moved = mfMoved;
    stats.dma_halfwords_max = Math.max(...records.map(r => r.ops.reduce((n, x) => n + x[2], 0)));
    return { rom, stats, blobs: {} };
}

// a package's own paint (`paint`: one layer or a list), which compile lays under opts.paint; its `edit` (the editor's
// document) is ignored here
export function packagePaint(pkg) {
    const p = pkg?.paint;
    return !p ? [] : Array.isArray(p) ? p.filter(Boolean) : [p];
}

// opts.paint: layers { tiles: { key: { way: [64 x '#rrggbb' | null] } }, backdrops?: { target: ['#rrggbb' per row] } };
// null keeps the package's colour, '' erases, a colour on a value-0 pixel makes it opaque
export function compile(pkg, original, opts = {}) {
    if (pkg.format !== FORMAT) throw new Error('not a ' + FORMAT + ' package');
    // the package's own paint (README "Paint in the package") goes under opts.paint, so a package with paint compiles to
    // its painted ROM by itself
    if (pkg.paint) opts = { ...opts, paint: [...packagePaint(pkg), ...(opts.paint || [])] };
    if (pkg.kind === 'models') return compileModels(pkg, original, opts, { bpsApply, b64, crc32, hex8 });
    if (pkg.layout === 'hf') return compileHf(pkg, original, opts, { bpsApply, b64, crc32, hex8 });   // Hyper Fighting (hf.mjs)
    if (pkg.layout === 'mt') return compileMt(pkg, original, opts, { bpsApply, b64, crc32, hex8, slots });   // Mario's Tennis (mt.mjs)
    if (original.length !== pkg.original.size || hex8(crc32(original)) !== pkg.original.crc32)
        throw new Error(`this ROM is not the package's original (${pkg.game})`);
    const P = pkg.params, GROUPS = P.groups, LIMIT = P.limit ?? 255, GREY = P.grey;
    const rom = bpsApply(original, b64(pkg.runtime.bps));
    const stats = {};
    if (pkg.contexts) return compileContexts(pkg, original, rom, opts, stats);
    const inc = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };

    const keySlot = new Map(), bytesById = new Map(), tabSlots = [];
    for (const tab of pkg.tables) {
        const sl = slots(original, tab); tabSlots.push(sl);
        sl.forEach((s, k) => {
            keySlot.set(s.key, { tab: tab.name, k, t: s.t });
            if (anyNonZero(s.t)) {
                const id = tileId(s.t), prev = bytesById.get(id);
                if (prev && hexBytes(prev) !== hexBytes(s.t)) throw new Error('tile id collision ' + id);
                bytesById.set(id, s.t);
            }
        });
    }
    // tables of Backdrop Row Table rows (option `rows`, Faceball's 3-D view) have no table or units of their own; their
    // paint goes into that blob (below), so it is taken out of the layers here
    const rowTabs = new Set(pkg.tables.filter(t => t.rows).map(t => t.name)), rowPaint = [];
    if (rowTabs.size) opts = { ...opts, paint: (opts.paint || []).map(l => {
        if (!l.tiles) return l;
        const keep = {}, rows = {};
        for (const [k, v] of Object.entries(l.tiles)) (rowTabs.has(keySlot.get(k)?.tab) ? rows : keep)[k] = v;
        rowPaint.push(rows); return { ...l, tiles: keep };
    }) };
    const tileUnits = new Map(), keyUnits = new Map();
    for (const u of readUnits(pkg.units)) {
        if (u.kind) {
            const s = keySlot.get(u.id); if (!s) throw new Error('unit for an unknown load position ' + u.id);
            u.t = s.t; keyUnits.set(u.id, u);
        } else {
            const t = bytesById.get(u.id); if (!t) throw new Error(`unit ${u.id}: no such tile in this ROM`);
            u.t = t; tileUnits.set(u.id, u);
        }
    }
    const cp = paintCells(pkg, opts.paint || [], keySlot, stats);
    if (cp.cells !== pkg.cells) {
        pkg = { ...pkg, cells: cp.cells, ...(cp.lists ? { lists: cp.lists } : {}) };
        if (cp.blobs && Object.keys(cp.blobs).length)
            pkg.blobs = { ...(pkg.blobs || {}), ...Object.fromEntries(Object.entries(cp.blobs).map(([n, d]) => [n, { data: d, align: d.align, raw: true }])) };
    }
    for (const layer of opts.paint || []) applyPaint(layer, { keySlot, keyUnits, tileUnits }, P, stats);
    const { out, lists, LOPT, crams, groups, extras, items, opqCols, pgroups, PATCH0, NP, xfree } =
        allocate(P, tileUnits, keyUnits, keySlot, pkg, stats);

    // ---- blobs
    const blobs = new Map();                                         // name -> {data, align}
    const images = new Map(); const pool = [];
    const imageIndex = img => {
        const ik = hexBytes(img);
        if (!images.has(ik)) { images.set(ik, images.size + 1); pool.push(img); }
        const idx = images.get(ik); if (idx >= 0x8000) throw new Error('too many slot images');
        return idx;
    };
    pkg.tables.forEach((tab, ti) => {
        const sl = tabSlots[ti], tb = new Uint8Array(4 * sl.length), dv = new DataView(tb.buffer);
        if (tab.rows) return;                                        // a row table's rows: its blob (below)
        if (tab.runs === 'golf-strip') {                             // a picture in the Color Frame Buffer (Golf's strip)
            const unitOf = k => { const s = sl[k]; return s && (keyUnits.get(s.key) || (anyNonZero(s.t) ? tileUnits.get(tileId(s.t)) : null)); };
            blobs.set('runs:' + tab.name, { data: golfStrip(tab, k => { const u = unitOf(k); return u ? out.get(u.uk) : null; }, k => sl[k]?.t), align: 4 });
            return;
        }
        if (tab.runs === 'golf') {                                   // a software sprite's colours (Golf): its runs only
            const sp = golfSprite(original, tab.at);
            blobs.set('runs:' + tab.name, { data: golfRuns(sp, k => {
                const s = sl[k], u = s && (keyUnits.get(s.key) || (anyNonZero(s.t) ? tileUnits.get(tileId(s.t)) : null));
                return u ? out.get(u.uk) : null;
            }), align: 4 });
            return;
        }
        sl.forEach((s, k) => {
            const u = keyUnits.get(s.key) || (anyNonZero(s.t) ? tileUnits.get(tileId(s.t)) : null);
            const e = u && out.get(u.uk); if (!e) return;
            dv.setUint16(4 * k, e.w, true); dv.setUint16(4 * k + 2, e.img ? imageIndex(e.img) | (e.opq ? 0x8000 : 0) : 0, true);
        });
        blobs.set('table:' + tab.name, { data: tb, align: 4 });
    });
    for (const [name, cram] of crams) blobs.set(name, { data: cram, align: 16 });
    for (const [name, l] of lists) {
        if (!l.length) continue;
        const n = LOPT[name]?.entry === 8 ? 8 : 4;
        const b = new Uint8Array(4 + n * l.length), dv = new DataView(b.buffer);
        dv.setUint32(0, l.length, true);
        l.forEach((e, k) => {
            dv.setUint32(4 + n * k, (e.cell | e.attr << 16) >>> 0, true);
            if (n === 8) dv.setUint32(8 + n * k, e.img && e.img.some(x => x) ? imageIndex(e.img) | (e.opq ? 0x8000 : 0) : 0, true);
        });
        blobs.set('list:' + name, { data: b, align: 4 });
    }
    for (const [name, { data, align, raw }] of Object.entries(pkg.blobs || {})) blobs.set(name, { data: raw ? data : b64(data), align: align || 4 });
    // a row table's entry k covers screen rows 8k..8k+7 of its blob, its pixel (row r, value v) being the colour of row
    // 8k + r at shade v; '' (cut out) keeps the colour
    for (const tab of pkg.tables) {
        if (!tab.rows) continue;
        const base = blobs.get(tab.rows); if (!base) throw new Error(`table ${tab.name}: no blob ${tab.rows}`);
        let data = null;
        for (const layer of rowPaint) for (const [key, ways] of Object.entries(layer)) {
            const s = keySlot.get(key); if (s.tab !== tab.name) continue;
            for (const px of Object.values(ways)) for (let i = 0; i < 64; i++) {
                const h = px?.[i], row = 8 * s.k + (i >> 3); if (!h || 16 * row + 16 > base.data.length) continue;
                data ??= Uint8Array.from(base.data);
                new DataView(data.buffer).setUint32(16 * row + 4 * value(s.t, i), rgb888(h), true); inc('row colours painted');
            }
        }
        if (data) blobs.set(tab.rows, { data, align: base.align });
    }
    lendSlots(pkg, opts.paint || [], keySlot, keyUnits, tileUnits, out, blobs, stats);
    const poolB = new Uint8Array(64 * pool.length); pool.forEach((im, k) => poolB.set(im, 64 * k));
    blobs.set('pool', { data: poolB, align: 64 });

    // ---- screens' backdrops (pkg.backdrops: [[set source, target]]): an index the runtime looks loaded sets up in, each
    // with its Backdrop Row Table from the layers' backdrops[target], else black like the Virtual Boy's
    const index = { ...(pkg.index || {}) };
    if (pkg.backdrops) {
        blobs.set('bkrow:default', { data: new Uint8Array(256 * 16), align: 4 });
        index.backdrops = pkg.backdrops.map(([src, target]) => {
            const rows = backdropRows(opts.paint, target);
            if (rows) blobs.set('bkrow:' + target, { data: rows, align: 4 });
            return [src, rows ? '@bkrow:' + target : '@bkrow:default'];
        });
        stats['backdrops painted'] = index.backdrops.filter(([, r]) => r !== '@bkrow:default').length;
    }

    // ---- layout: directory, table of contents, blobs (indexes last, they point at blobs). Only if the blobs don't fit
    // in turn are equal blobs stored once and the rest spread over the extra areas (`data.more`), so a package without
    // paint compiles as before
    const D = pkg.data, view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
    const tocNames = [...blobs.keys(), ...Object.keys(index).map(n => 'index:' + n)];
    const tocLen = 8 + tocNames.reduce((n, s) => n + ((9 + s.length + 3) & ~3), 0);
    const count = n => n.startsWith('index:') ? index[n.slice(6)].length : n.startsWith('list:') ? (lists.get(n.slice(5)) || []).length : 0;
    const more = (D.more || []).map(([lo, hi]) => [lo, hi]);
    const areaSize = (D.end - D.at) + more.reduce((n, [lo, hi]) => n + hi - lo, 0);
    const plan = packed => {
        let at = D.at + 4 * D.directory.length + tocLen;
        const tails = more.map(([lo]) => lo), addr = new Map(), seen = new Map(), writes = [];
        const put = (name, data, align) => {
            if (packed) {
                const k = data.length >= 16 ? hexBytes(data) : null, same = k && seen.get(k);
                if (same && same.at % align === 0) { addr.set(name, { at: same.at, size: data.length }); return; }
            }
            let a = Math.ceil(at / align) * align;
            if (a + data.length <= D.end) at = a + data.length;
            else {
                const k = packed ? tails.findIndex((t, j) => Math.ceil(t / align) * align + data.length <= more[j][1]) : -1;
                if (k < 0) throw new DataAreaFull(name, areaSize);
                a = Math.ceil(tails[k] / align) * align; tails[k] = a + data.length;
            }
            addr.set(name, { at: a, size: data.length }); writes.push([a, data]);
            if (packed && data.length >= 16) seen.set(hexBytes(data), { at: a });
        };
        for (const [name, { data, align }] of blobs) if (name !== 'pool') put(name, data, align);
        const ref = f => typeof f === 'number' ? f : f.startsWith('@') ? (addr.get(f.slice(1))?.at ?? 0)
            : f.startsWith('#') ? count(f.slice(1)) : (() => { throw new Error('bad field ' + f); })();
        for (const [n, recs] of Object.entries(index)) {
            const b = new Uint8Array(4 * recs.reduce((x, r) => x + r.length, 0)), dv = new DataView(b.buffer); let o = 0;
            for (const r of recs) for (const f of r) { dv.setUint32(o, ref(f) >>> 0, true); o += 4; }
            put('index:' + n, b, 4);
        }
        put('pool', poolB, 64);
        const free = D.end - at + more.reduce((n, [, hi], j) => n + hi - tails[j], 0);
        return { addr, ref, writes, at, free };
    };
    let L;
    try { L = plan(false); } catch (e) {
        if (!(e instanceof DataAreaFull)) throw e;
        L = plan(true); stats['data packed'] = 1;
    }
    for (const [a, data] of L.writes) rom.set(data, cpuOff(rom, a));
    const { addr, ref, at } = L;
    D.directory.forEach((f, k) => view.setUint32(cpuOff(rom, D.at + 4 * k), ref(f) >>> 0, true));
    let o = cpuOff(rom, D.at + 4 * D.directory.length);
    rom.set(TOC_MAGIC, o); view.setUint32(o + 4, tocNames.length, true); o += 8;
    for (const n of tocNames) {
        const a = addr.get(n) || { at: 0, size: 0 };
        view.setUint32(o, a.at >>> 0, true); view.setUint32(o + 4, a.size, true); rom[o + 8] = n.length;
        for (let k = 0; k < n.length; k++) rom[o + 9 + k] = n.charCodeAt(k);
        o += (9 + n.length + 3) & ~3;
    }
    Object.assign(stats, {
        groups: groups.length, extra_palettes: extras.size, images: images.size, items: items.length,
        tiles: tileUnits.size, reference_units: keyUnits.size, opaque_colours: opqCols.length,
        patch_groups: pgroups.length, palettes_free: (P.free_sels ? xfree.length : PATCH0 * 4 - NP) - extras.size,
        'patched cells': [...lists.values()].reduce((n, l) => n + l.length, 0),
        data_end: hex8(at), data_free: L.free, data_area: areaSize,
    });
    return { rom, stats, blobs: Object.fromEntries([...addr].map(([n, a]) => [n, rom.subarray(cpuOff(rom, a.at), cpuOff(rom, a.at) + a.size)])) };
}

// (key, way) -> per Character pixel [value, shade, '#rrggbb' or null]
export function shownPixels(pkg, original, rom, scene = pkg.scenes?.[0]) {
    if (pkg.layout === 'zr') return zrShownPixels(pkg, original, rom);      // Zero Racers' VIP screens (models.mjs)
    if (pkg.layout === 'hf') return hfShownPixels(pkg, original, rom);      // Hyper Fighting's own tables (hf.mjs)
    if (pkg.layout === 'mt') return mtShownPixels(pkg, original, rom, { slots }, scene);   // Mario's Tennis' own tables (mt.mjs)
    const toc = readToc(pkg, rom), where = new Map();
    pkg.tables.forEach(tab => slots(original, tab).forEach((s, k) => where.set(s.key, { tab: tab.name, k, t: s.t })));
    const blob = n => { const a = toc.get(n); return a ? rom.subarray(cpuOff(rom, a.at), cpuOff(rom, a.at) + a.size) : new Uint8Array(0); };
    const cram = blob(scene ? 'cram:' + scene : 'cram'), pool = blob('pool');
    // load positions the game draws only from Characters without a slot of their own (pkg.slotless): no slot pixels,
    // unless the ROM lends one (a CHRPIX store with PCE for its Character in its table's lend stores)
    const noSlot = new Set();
    for (const [table, T] of Object.entries(pkg.slotless || {})) {
        const st = T.stores ? blob(T.stores) : new Uint8Array(0), lentChr = new Set();
        const u32 = o => (st[o] | st[o + 1] << 8 | st[o + 2] << 16 | st[o + 3] << 24) >>> 0;
        for (let k = 0, n = st.length >= 4 ? u32(0) : 0; k < n; k++) {
            const a = u32(4 + 8 * k), v = u32(8 + 8 * k);
            if (a >= 0x030A4000 && a < 0x030A5000 && (a & 1) && (v & 0x80)) lentChr.add((a - 0x030A4000) >> 1);
        }
        for (const [i, chr] of Object.entries(T.chr || {})) if (chr == null || !lentChr.has(chr)) noSlot.add(`${table}:${i}`);
    }
    // software sprites (table option runs "golf"): the palette per pixel from the sprite's runs
    const runsOf = new Map();
    for (const tab of pkg.tables) if (tab.runs === 'golf' || tab.runs === 'golf-strip') runsOf.set(tab.name, tab);
    const runPal = new Map();
    const palOf = name => {
        if (runPal.has(name)) return runPal.get(name);
        const tab = runsOf.get(name);
        if (tab.runs === 'golf-strip') {
            const r = blob('runs:' + name), sp = { w: tab.w, h: tab.h, tw: tab.w >> 3 }, m = new Int16Array(tab.w * tab.h).fill(-1);
            for (let x = 0; x < tab.w; x++) for (let y = 0; y < tab.h; y++) { const p = r[x * tab.h + y]; if (r.length && p !== 0xFF) m[y * tab.w + x] = p; }
            const v = { sp, m }; runPal.set(name, v); return v;
        }
        const sp = golfSprite(original, tab.at), r = blob('runs:' + name), m = new Int16Array(sp.w * sp.h).fill(-1);
        for (let x = 0; x < sp.w && r.length; x++) {
            let o = r[2 * x] | r[2 * x + 1] << 8; const n = r[o++];
            for (let k = 0; k < n; k++, o += 3) for (let y = r[o]; y < r[o] + r[o + 1]; y++) m[y * sp.w + x] = r[o + 2];
        }
        const v = { sp, m }; runPal.set(name, v); return v;
    };
    const rowsOf = new Map(pkg.tables.filter(t => t.rows).map(t => [t.name, t.rows]));
    const opqTabs = new Set(pkg.tables.filter(t => t.opq).map(t => t.name));
    return (key, ctx) => {
        const s = where.get(key); if (!s) return null;
        if (rowsOf.has(s.tab)) {                                     // a row table's rows: pixel (r, v) row 8k + r, shade v
            const b = blob(rowsOf.get(s.tab)), { plt } = parseCtx(ctx), px = [];
            for (let i = 0; i < 64; i++) {
                const v = value(s.t, i), o = 16 * (8 * s.k + (i >> 3)) + 4 * v;
                px.push([v, shade(plt, v), o + 3 <= b.length ? '#' + [b[o], b[o + 1], b[o + 2]].map(c => c.toString(16).padStart(2, '0')).join('') : null]);
            }
            return px;
        }
        if (runsOf.has(s.tab)) {
            const { sp, m } = palOf(s.tab), { plt } = parseCtx(ctx), tx = s.k % sp.tw, ty = (s.k / sp.tw) | 0, px = [];
            for (let i = 0; i < 64; i++) {
                const x = tx * 8 + (i & 7), y = ty * 8 + (i >> 3), p = x < sp.w && y < sp.h ? m[y * sp.w + x] : -1;
                const v = value(s.t, i), sh = shade(plt, v);
                if (p < 0) { px.push([0, 0, null]); continue; }
                const q = p * 16 + sh * 4;
                px.push([v, sh, '#' + [cram[q], cram[q + 1], cram[q + 2]].map(c => c.toString(16).padStart(2, '0')).join('')]);
            }
            return px;
        }
        const tb = toc.get('table:' + s.tab), o = cpuOff(rom, tb.at) + 4 * s.k;
        const w = rom[o] | rom[o + 1] << 8; let img = noSlot.has(key) ? 0 : rom[o + 2] | rom[o + 3] << 8;
        const { side, sel, plt } = parseCtx(ctx);
        const g = side ? w >> 8 : w & 0xFF, opq = !!(img & 0x8000); img &= 0x7FFF;
        // a table whose runtime draws every value-0 pixel (table option `opq`): slot byte 0 there is the group's shade
        const own0 = opqTabs.has(s.tab);
        const px = [];
        for (let i = 0; i < 64; i++) {
            const v = value(s.t, i), sh = shade(plt, v); let p = g * 4 + sel;
            const b = img ? pool[(img - 1) * 64 + i] : 0;
            if (!v && !(b !== 0xFF && (own0 || (opq && b !== 0)))) { px.push([0, 0, null]); continue; }
            if (v && b === 0xFF) { px.push([v, sh, '']); continue; }       // painted transparent: the slot's 0xFF
            if (b && b !== 0xFF) p = b;
            const q = p * 16 + sh * 4;
            px.push([v, sh, '#' + [cram[q], cram[q + 1], cram[q + 2]].map(x => x.toString(16).padStart(2, '0')).join('')]);
        }
        return px;
    };
}
/**
 * What a built ROM shows of a BG map cell (or object) its cell lists colour: (lists, cell, way, tile) -> 64 x [value,
 * shade, '#rrggbb' | null], the cell showing `tile` (its character's 16 bytes) drawn `way`. `lists` are the list names
 * (pkg.cells) in force, in the order the runtime applies them: a later list's entry wins, as does a later entry within
 * one. An entry's attribute is the cell's palette group; an 8-byte entry's slot image picks a palette per pixel (0 the
 * group's, 0xFF leaves the pixel out; with OPQ, value-0 pixels are drawn). Null where the list naming the cell gives it
 * back to its character (CHRSEL: shownPixels of the character's load position), undefined where no list names it.
 */
export function cellShown(pkg, original, rom, scene = pkg.scenes?.[0]) {
    if (pkg.layout === 'zr') return zrCellShown(pkg, original, rom);
    if (pkg.layout === 'hf') return hfCellShown(pkg, original, rom);
    if (pkg.layout === 'mt') return mtCellShown(pkg, original, rom, { slots }, scene);
    const toc = readToc(pkg, rom);
    const blob = n => { const a = toc.get(n); return a ? rom.subarray(cpuOff(rom, a.at), cpuOff(rom, a.at) + a.size) : null; };
    const cram = blob(scene ? 'cram:' + scene : 'cram') || new Uint8Array(4096), pool = blob('pool') || new Uint8Array(0);
    const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
    const read = new Map();                                          // list -> Map(cell -> {attr, img, opq})
    // {chr} requests (cells their character colours, paintable on their own): 'list#cell' -> load position, its tile
    let chrMap = null, tileMap = null, look = null;
    const chrCells = () => chrMap ??= new Map((pkg.cells || []).filter(c => c[2]?.chr !== undefined).map(c => [c[0] + '#' + c[1], c[2].chr]));
    const keyTile = () => {
        if (tileMap) return tileMap;
        tileMap = new Map(); const want = new Set(chrCells().values());
        for (const tab of pkg.tables || []) {
            const pre = (tab.key || '').split('{')[0];
            if (![...want].some(k => k.startsWith(pre))) continue;
            for (const s of slots(original, tab)) if (want.has(s.key)) tileMap.set(s.key, s.t);
        }
        return tileMap;
    };
    const entries = name => {
        let m = read.get(name); if (m) return m;
        read.set(name, m = new Map());
        const b = blob('list:' + name); if (!b || b.length < 4) return m;
        const promoted = Object.values(pkg.cell_promote || {}).some(p => p.list === name);
        const n = pkg.lists?.[name]?.entry === 8 || promoted ? 8 : 4;
        for (let k = 0, c = u32(b, 0); k < c && 4 + n * (k + 1) <= b.length; k++) {
            const e = u32(b, 4 + n * k), im = n === 8 ? u32(b, 8 + n * k) : 0;
            m.set(e & 0xFFFF, { attr: (e >>> 16) & 0xFF, img: im & 0x7FFF, opq: !!(im & 0x8000) });
        }
        return m;
    };
    return (lists, cell, way, tile) => {
        let e;
        // a 4-byte list's painted cells moved to their stream's 8-byte list (cell_promote), applied after it
        for (let k = lists.length - 1; k >= 0 && !e; k--) {
            const to = pkg.cell_promote?.[lists[k]]?.list;
            e = (to && to !== lists[k] && entries(to).get(cell)) || entries(lists[k]).get(cell);
        }
        if (!e) {
            // a cell its character colours ({chr} request, no entry while unpainted): what the character shows there
            for (let k = lists.length - 1; k >= 0; k--) {
                const key = chrCells().get(lists[k] + '#' + cell); if (key === undefined) continue;
                const s = keyTile().get(key);
                if (!s || s.length !== tile.length || s.some((b, i) => b !== tile[i])) return undefined;
                return (look ??= shownPixels(pkg, original, rom, scene))(key, way) ?? undefined;
            }
            return undefined;
        }
        if (e.attr & 0x80) return null;
        const { sel, plt } = parseCtx(way), g = e.attr & 0x3F, px = [];
        const img = e.img ? pool.subarray((e.img - 1) * 64, e.img * 64) : null;
        for (let i = 0; i < 64; i++) {
            const v = value(tile, i), sh = shade(plt, v), b = img ? img[i] : 0;
            if (b === 0xFF || (!v && !(img && e.opq))) { px.push([v, sh, null]); continue; }
            const q = (b || g * 4 + sel) * 16 + sh * 4;
            px.push([v, sh, '#' + [cram[q], cram[q + 1], cram[q + 2]].map(x => x.toString(16).padStart(2, '0')).join('')]);
        }
        return px;
    };
}
// decodes the ROM's context records (and overlays, by paint key id) the way the runtime runs them, for contextShown and
// contextCellShown
function contextViews(pkg, rom) {
    const u32 = a => { const o = cpuOff(rom, a); return (rom[o] | rom[o + 1] << 8 | rom[o + 2] << 16 | rom[o + 3] << 24) >>> 0; };
    const u16 = a => { const o = cpuOff(rom, a); return rom[o] | rom[o + 1] << 8; };
    const bytes = (a, n) => rom.subarray(cpuOff(rom, a), cpuOff(rom, a) + n);
    const views = new Map();
    for (let r = u32(pkg.data.at); u16(r); ) {
        const id = u16(r), gates = u16(r + 2), keep = u16(r + 16), ops = u32(r + 4), sweeps = u32(r + 8), watch = u32(r + 24);
        const v = { cram: null, chrcol: null, chrpix: null, slots: null, watch: null, cellattr: new Map(), cellpix: new Map(), sweeps: new Map() };
        for (let k = 0, n = u32(ops); k < n; k++) {
            const dst = u32(ops + 4 + 12 * k), src = u32(ops + 8 + 12 * k), hw = u32(ops + 12 + 12 * k);
            if (src === ZERO) continue;                                  // a clear (the watch's cache, overlays' cell slots)
            if (dst === VCU.cram) v.cram = bytes(src, 2 * hw);
            else if (dst === VCU.chrcol) v.chrcol = bytes(src, 2 * hw);
            else if (dst === VCU.chrpix) v.chrpix = bytes(src, 2 * hw);
            else if (dst >= VCU.slots && dst < VCU.slots + 0x10000) v.slots = { first: (dst - VCU.slots) / 64, data: bytes(src, 2 * hw) };
            // the maps it rules (BG maps 0..13): a byte per cell, plus a u16 pixel attribute per cell on maps with slots
            else if (dst >= VCU.cellattr && dst < VCU.cellattr + 14 * 0x1000 && !(dst & 0xFFF) && hw === 0x800) v.cellattr.set((dst - VCU.cellattr) >> 12, bytes(src, 0x1000));
            else if (dst >= VCU.cellpix && dst < VCU.cellpix + 14 * 0x2000 && !(dst & 0x1FFF) && hw === 0x1000) v.cellpix.set((dst - VCU.cellpix) >> 13, bytes(src, 0x2000));
        }
        // the runtime keeps a swept cell's attribute at table[character]
        if (sweeps) for (let k = 0, n = u32(sweeps); k < n; k++) v.sweeps.set(u16(sweeps + 4 + 8 * k), bytes(u32(sweeps + 8 + 8 * k), 2048));
        if (watch) { const d = watch + 4; v.watch = { table: u32(d + 4), n: u32(d + 8), pool: u32(d + 12) }; }
        // palette scenes (u32 n, n x (u16 gates, u16 0, u32 Color RAM, gates)): each scene's Color RAM
        const scenes = u32(r + 12);
        if (scenes) { v.scenes = []; for (let k = 0, n = u32(scenes), p = scenes + 4; k < n; k++) { v.scenes.push(bytes(u32(p + 4), 0x1000)); p += 8 + 8 * u16(p); } }
        views.set(id, v);
        r += 32 + 8 * (gates + keep);
    }
    // overlays ('@ovtab'): the first record per paint key id, its byte writes turned into full attribute images; ovChr /
    // ovCell hold the character sides (2 * chr + side) and cells (map * 4096 + cell) the overlay colours
    const contexts = new Map(pkg.contexts.map(C => [C.id, C]));
    const ovAt = pkg.data.directory.indexOf('@ovtab');
    if (ovAt >= 0 && pkg.overlays?.length) {
        const byId = new Map(pkg.overlays.map(O => [O.id, O]).reverse());     // (the first record of an id)
        for (let r = u32(pkg.data.at + 4 * ovAt); u16(r); r += 12 + 8 * u16(r + 2)) {
            const id = u16(r), O = byId.get(id), okey = overlayKeyId(pkg, id);
            if (!O || views.has(okey)) continue;
            const v = { cram: new Uint8Array(0x1000), chrcol: new Uint8Array(0x1000), chrpix: new Uint8Array(0x1000), slots: null, watch: null,
                        cellattr: new Map(), cellpix: new Map(), sweeps: new Map(), ovChr: new Set(), ovCell: new Set() };
            const ops = u32(r + 4), wr = u32(r + 8);
            for (let k = 0, n = u32(ops); k < n; k++) {
                const dst = u32(ops + 4 + 12 * k), src = u32(ops + 8 + 12 * k), hw = u32(ops + 12 + 12 * k);
                if (src === ZERO) continue;
                if (dst >= VCU.cram && dst < VCU.cram + 0x1000) v.cram.set(bytes(src, 2 * hw), dst - VCU.cram);
                else if (dst >= VCU.slots && dst < VCU.slots + 0x10000) v.slots = { first: (dst - VCU.slots) / 64, data: bytes(src, 2 * hw) };
            }
            for (let k = 0, n = u32(wr); k < n; k++) {
                const w = u32(wr + 4 + 4 * k), a = w & 0xFFFFF, b = w >>> 24;
                if (a >= VCU.chrcol && a < VCU.chrcol + 0x1000) { v.chrcol[a - VCU.chrcol] = b; v.ovChr.add(a - VCU.chrcol); }
                else if (a >= VCU.chrpix && a < VCU.chrpix + 0x1000) v.chrpix[a - VCU.chrpix] = b;
                else if (a >= VCU.cellattr && a < VCU.cellattr + 14 * 0x1000) {
                    const m = (a - VCU.cellattr) >> 12; if (!v.cellattr.has(m)) v.cellattr.set(m, new Uint8Array(0x1000));
                    v.cellattr.get(m)[a & 0xFFF] = b; v.ovCell.add(a - VCU.cellattr);
                } else if (a >= VCU.cellpix && a < VCU.cellpix + 14 * 0x2000) {
                    const m = (a - VCU.cellpix) >> 13; if (!v.cellpix.has(m)) v.cellpix.set(m, new Uint8Array(0x2000));
                    v.cellpix.get(m)[a & 0x1FFF] = b;
                }
            }
            views.set(okey, v);
            contexts.set(okey, { id: okey, overlay: O, tiles: { ...O.tiles, ...O.cell_tiles || {} } });
        }
    }
    const hexTile = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
    // a tile drawn a way (plt, sel) on attribute group g, with a slot image (img, opq) or none: [value, shade, colour] x 64
    const pixels = (v, t, g, sel, plt, img, opq) => {
        const px = [];
        for (let i = 0; i < 64; i++) {
            const val = value(t, i), sh = shade(plt, val); let p = g * 4 + sel;
            const b = img ? img[i] : 0;
            if (!val && !(opq && b !== 0 && b !== 0xFF)) { px.push([0, 0, null]); continue; }
            if (val && b === 0xFF) { px.push([val, sh, '']); continue; }   // painted transparent: the slot's 0xFF
            if (b && b !== 0xFF) p = b;
            const q = p * 16 + sh * 4;
            px.push([val, sh, '#' + [v.cram[q], v.cram[q + 1], v.cram[q + 2]].map(x => x.toString(16).padStart(2, '0')).join('')]);
        }
        return px;
    };
    // a pixel slot's image (attribute 0x8000 | 0x4000 OPQ | slot): [image, opq], or [null, false] without one
    const slotImage = (v, px) => px & 0x8000 && v.slots
        ? [v.slots.data.subarray(((px & 0x3FF) - v.slots.first) * 64, ((px & 0x3FF) - v.slots.first) * 64 + 64), !!(px & 0x4000)]
        : [null, false];
    return { views, contexts, u32, u16, bytes, hexTile, pixels, slotImage };
}

// look(context or overlay key id, key without the id, way) -> 64 x [value, shade, colour], null if not shown
export function contextShown(pkg, rom) {
    const { views, contexts: tiles, u32, u16, bytes, hexTile, pixels, slotImage } = contextViews(pkg, rom);
    const shared = new Map((pkg.shared || []).map(S => [S.id, S]));    // a shared key shows as its first member
    const watchIx = new Map();
    const rx = t => { let h = 0; for (let k = 0; k < 4; k++) { const w = (t[4 * k] | t[4 * k + 1] << 8 | t[4 * k + 2] << 16 | t[4 * k + 3] << 24) >>> 0; h = (((h << 7) | (h >>> 25)) ^ w) >>> 0; } return h; };
    // a shared group's `scene` picks that palette scene's Color RAM (Dragon Hopper's Dorin forms, each in its own palettes)
    const look = (ctxId, key, way, scene) => {
        const S = shared.get(ctxId);
        if (S) {
            for (const [cid, c] of (key.startsWith('k:') && S.members?.[key.slice(2)]) || []) {
                const px = look(cid, typeof c === 'string' ? c : 'k:' + c, way, S.scene); if (px) return px;   // 't<tile id>': watched
            }
            return null;
        }
        const v0 = views.get(ctxId), C = tiles.get(ctxId);
        const v = scene != null && v0?.scenes?.[scene] ? { ...v0, cram: v0.scenes[scene] } : v0;
        if (!v || !C || !v.cram) return null;
        const { side, sel, plt } = parseCtx(way);
        let t = null, w = 0, img = null, opq = false;
        // cell keys (contextCellKey) show as the cell does: the map's attribute for the character plus the cell's pixel
        // slot, or the character's own colours under CHRSEL
        const mc = /^(m|c):(\d+):(?:(\d+):)?(\d+)$/.exec(key);
        if (mc) {
            const map = +mc[2], c = +mc[4], h = C.tiles[String(c)], attrs = v.cellattr.get(map);
            if (!h || !attrs || side) return null;
            if (v.ovCell && (mc[1] !== 'c' || !v.ovCell.has(map * 4096 + +mc[3]))) return null;   // overlays: only their cells
            const sweep = v.sweeps.get(map);
            let a;
            if (sweep) a = sweep[c & 0x7FF];
            else if (mc[1] === 'c') a = attrs[+mc[3]];
            else { const n = new Map(); for (const x of attrs) n.set(x, (n.get(x) || 0) + 1); a = [...n].sort((x, y) => y[1] - x[1])[0][0]; }
            if (a & 0x80) return look(ctxId, 'k:' + c, way, scene);
            if (mc[1] === 'c') { const pix = v.cellpix.get(map), cell = +mc[3]; [img, opq] = slotImage(v, pix ? pix[2 * cell] | pix[2 * cell + 1] << 8 : 0); }
            return pixels(v, hexTile(h), a & 0x3F, sel, plt, img, opq);
        }
        if (key.startsWith('k:')) {
            const c = +key.slice(2), h = C.tiles[String(c)]; if (!h) return null;
            if (v.ovChr && !v.ovChr.has(2 * c + side)) return null;     // overlays: only the characters they colour
            t = hexTile(h);
            w = v.chrcol ? v.chrcol[2 * c] | v.chrcol[2 * c + 1] << 8 : 0;
            [img, opq] = slotImage(v, v.chrpix ? v.chrpix[2 * c] | v.chrpix[2 * c + 1] << 8 : 0);
        } else {
            const W = C.watch; if (!W || (!v.watch && !W.when_painted)) return null;
            let ix = watchIx.get(ctxId);
            if (!ix) {
                ix = { byTile: new Map(), paintOnly: new Set(W.paint_only || []), units: new Map((W.units || []).map(u => [u.id, u])) };
                for (const k of Object.keys(W.tiles)) { const tk = tileId(hexTile(W.tiles[k])); if (!ix.byTile.has(tk)) ix.byTile.set(tk, k); }
                watchIx.set(ctxId, ix);
            }
            const id = ix.byTile.get(key); if (!id) return null;
            t = hexTile(W.tiles[id]);
            const U = ix.units.get(id);
            let at = -1;
            if (v.watch) {
                const h = rx(t); let lo = 0, hi = v.watch.n;
                while (lo < hi) { const m = (lo + hi) >> 1, e = u32(v.watch.table + 8 * m); if (e === h) { at = m; break; } if (e < h) lo = m + 1; else hi = m; }
            } else if (!ix.paintOnly.has(id)) {
                // a when_painted watch that is not in this build: the game shows the content as the package recorded it
                // (a picture's cell colours), an unrecorded way as the unit's first
                const rec = U?.ctx.find(c => c[0] === way) ?? U?.ctx.find(c => parseCtx(c[0]).side === side);
                if (!rec) return null;
                const cols = U.c || [];
                return Array.from({ length: 64 }, (_, i) => {
                    const val = value(t, i), ch = rec[2][i];
                    return !val ? [0, 0, null] : [val, shade(plt, val), ch === '.' || ch === undefined ? null : cols[AIDX[ch]]];
                });
            }
            if (at < 0) {
                // an unpainted paint_only content: the runtime draws it with its range's fallback attribute
                if (!ix.paintOnly.has(id)) return null;
                w = U?.fb ?? W.fallback ?? 0;
            } else {
                w = u16(v.watch.table + 8 * at + 4); const i = u16(v.watch.table + 8 * at + 6);
                if (i & 0x7FFF) { img = bytes(v.watch.pool + 64 * ((i & 0x7FFF) - 1), 64); opq = !!(i & 0x8000); }
            }
        }
        return pixels(v, t, (side ? w >> 8 : w) & 0x3F, sel, plt, img, opq);
    };
    return look;
}

// (context id, map, cell, 'k:<chr>', way) -> what the cell shows holding that character; null for CHRSEL cells
// (contextShown covers those), maps the context does not rule, and cells an overlay does not colour
export function contextCellShown(pkg, rom) {
    const { views, contexts, hexTile, pixels, slotImage } = contextViews(pkg, rom);
    return (ctxId, map, cell, key, way) => {
        const v = views.get(ctxId), C = contexts.get(ctxId);
        if (!v || !C || !v.cram || !key.startsWith('k:')) return null;
        const { side, sel, plt } = parseCtx(way);
        const attrs = v.cellattr.get(map);
        if (side || !attrs || cell < 0 || cell > 0xFFF) return null;
        if (v.ovCell && !v.ovCell.has(map * 4096 + cell)) return null;  // overlays: only their cells
        const c = +key.slice(2), h = C.tiles[String(c)]; if (!h) return null;
        const sweep = v.sweeps.get(map);
        const a = sweep ? sweep[c & 0x7FF] : attrs[cell];
        if (a & 0x80) return null;                                       // CHRSEL: the character's colours
        const pix = v.cellpix.get(map);
        const [img, opq] = slotImage(v, pix ? pix[2 * cell] | pix[2 * cell + 1] << 8 : 0);
        return pixels(v, hexTile(h), a & 0x3F, sel, plt, img, opq);
    };
}

/**
 * (key) -> whether paint may make the key's value-0 pixels (transparent in the original) opaque. A colour on such a
 * pixel turns the character's entry (or cell) opaque (OPQ) with a slot image holding the colour, its other value-0
 * pixels cut out; the eraser makes the pixel transparent again.
 *
 * False where the runtime has no opaque slots for it: model packages and Zero Racers; Hyper Fighting's fighters,
 * effects, sparks and fireballs (its engine colours them without OPQ, only its screens take it); tables the runtime
 * paints into the Color Frame Buffer (`runs`: Golf's software sprites, drawn only where their mask is) or that stand in
 * for something (`stand_in`, `rows`); cell list keys (paintCells keeps value 0 transparent) and context cell keys;
 * load positions the game draws from Characters without a slot (`slotless`); packages whose runtime ignores the
 * entries' OPQ bit (`params.opq_paint: false`). `tableOf(key)` names the table a load position belongs to (load-source
 * packages).
 */
export function zeroPaintable(pkg, tableOf = () => undefined) {
    if (!pkg || pkg.kind === 'models' || pkg.layout === 'zr' || pkg.params?.opq_paint === false) return () => false;
    if (pkg.layout === 'mt') return () => true;
    if (pkg.layout === 'hf') return key => /^scr\d+(?:o\d+)?:/.test(key) || key.startsWith('cell#scr:');
    if (pkg.contexts) return key => !key.startsWith('cell#') && !contextCellKey(key);   // cell paint keeps value 0 as drawn
    const no = new Set((pkg.tables || []).filter(t => t.runs || t.rows || t.stand_in).map(t => t.name));
    const slotless = new Set();
    for (const [table, T] of Object.entries(pkg.slotless || {})) for (const i of Object.keys(T.chr || {})) slotless.add(`${table}:${i}`);
    return key => {
        if (key.startsWith('cell#') || slotless.has(key)) return false;
        const t = tableOf(key);
        return t !== undefined && !no.has(t);
    };
}

export function readToc(pkg, rom) {
    let o = cpuOff(rom, pkg.data.at + 4 * pkg.data.directory.length);
    if (TOC_MAGIC.some((x, k) => rom[o + k] !== x)) throw new Error('no VB Color package data in this ROM');
    const u32 = at => (rom[at] | rom[at + 1] << 8 | rom[at + 2] << 16 | rom[at + 3] << 24) >>> 0;
    const n = u32(o + 4); o += 8; const out = new Map();
    for (let k = 0; k < n; k++) {
        const ln = rom[o + 8]; const name = String.fromCharCode(...rom.subarray(o + 9, o + 9 + ln));
        out.set(name, { at: u32(o), size: u32(o + 4) }); o += (9 + ln + 3) & ~3;
    }
    return out;
}

function b64(s) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
