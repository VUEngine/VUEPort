// checks the hand-written MD5 against RFC 1321's test suite, plus a length crossing a block boundary, which
// the suite does not exercise and where streaming implementations most often get the padding wrong
// Usage: node tests/md5-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { md5Hex } = require('../lib/common/emulator-md5.js');

let failures = 0;
const check = (label, actual, expected) => {
    if (actual !== expected) {
        failures++;
        console.log(`  FAIL ${label}: got ${actual}, expected ${expected}`);
    }
};
const section = name => console.log(`\n${name}`);

section('RFC 1321, Appendix A.5');
const utf8 = text => new TextEncoder().encode(text);
check('the empty string', md5Hex(utf8('')), 'd41d8cd98f00b204e9800998ecf8427e');
check('a single character', md5Hex(utf8('a')), '0cc175b9c0f1b6a831c399e269772661');
check('a short word', md5Hex(utf8('abc')), '900150983cd24fb0d6963f7d28e17f72');
check('a phrase', md5Hex(utf8('message digest')), 'f96b697d7cb7938d525a2f31aaf161d0');
check('the lower-case alphabet', md5Hex(utf8('abcdefghijklmnopqrstuvwxyz')), 'c3fcd3d76192e4007dfb496cca67e13b');
check('alphanumerics',
    md5Hex(utf8('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')),
    'd174ab98d277d9f5a5611c2c9f419d9f');
check('eighty digits',
    md5Hex(utf8('12345678901234567890123456789012345678901234567890123456789012345678901234567890')),
    '57edf4a22be3c955ac49da2e2107b67a');

section('Block boundaries');
// padding adds at least one byte (0x80) and an 8-byte length, so 64 - 9 = 55 is the longest message that
// fits one block
check('55 bytes, the last that fits one block', md5Hex(new Uint8Array(55)),
    'c9ea3314b91c9fd4e38f9432064fd1f2');
check('56 bytes, the first that needs a second block', md5Hex(new Uint8Array(56)),
    'e3c4dd21a9171fd39d208efa09bf7883');
check('exactly one block, 64 bytes', md5Hex(new Uint8Array(64)),
    '3b5d3c7d207e37dceeedd301e35e2e58');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
