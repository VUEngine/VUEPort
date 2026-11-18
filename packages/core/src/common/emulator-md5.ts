// names a ROM the way RetroAchievements does: the whole file, no header skipping (rcheevos' plain-buffer `rc_hash`).
// Hand-written because `crypto.subtle` has no MD5 and is missing in insecure contexts

// per-round left rotations from RFC 1321
const SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const T = (() => {
    const table = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
        table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    }
    return table;
})();

function rotl(value: number, count: number): number {
    return ((value << count) | (value >>> (32 - count))) >>> 0;
}

export function md5Hex(bytes: Uint8Array): string {
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    const bitLength = bytes.length * 8;
    // one 0x80 byte, zeros to 56 mod 64, then the 64-bit little-endian bit length
    const padded = new Uint8Array((Math.floor((bytes.length + 8) / 64) + 1) * 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    // JavaScript bit ops are 32-bit; the low word covers any ROM, the high word is written for completeness
    new DataView(padded.buffer).setUint32(padded.length - 8, bitLength >>> 0, true);
    new DataView(padded.buffer).setUint32(
        padded.length - 4, Math.floor(bitLength / 0x100000000) >>> 0, true);

    const block = new Uint32Array(16);
    const view = new DataView(padded.buffer);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) {
            block[i] = view.getUint32(offset + i * 4, true);
        }

        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;

        for (let i = 0; i < 64; i++) {
            let f: number;
            let g: number;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            f = (f + a + T[i] + block[g]) >>> 0;
            a = d;
            d = c;
            c = b;
            b = (b + rotl(f, SHIFTS[i])) >>> 0;
        }

        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    return [a0, b0, c0, d0].map(word => {
        // each word is emitted little-endian
        let hex = '';
        for (let byte = 0; byte < 4; byte++) {
            hex += ((word >>> (byte * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return hex;
    }).join('');
}
