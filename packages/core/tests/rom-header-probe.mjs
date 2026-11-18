// checks the ROM header the ROM Info panel shows and the CRC-32 the cheat database is keyed on; a wrong checksum
// silently matches no game, so it is checked against the standard check value. Usage: node tests/rom-header-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    parseRomHeader, romSizeInMBit, EMPTY_ROM_HEADER, VbHardwareMode, VbColorSupport, resolveVbHardwareMode,
} = require('../lib/browser/emulator-types.js');
const { crc32, formatRomId } = require('../lib/common/emulator-cheat-database.js');

let failures = 0;

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

function rom({ mbit = 8, name = '', maker = '  ', code = '    ', version = 0, vbcSupport = 0 } = {}) {
    const bytes = new Uint8Array(mbit * 131072);
    const header = bytes.length - 544;
    const write = (text, at) => {
        for (let i = 0; i < text.length; i++) {
            bytes[at + i] = text.charCodeAt(i);
        }
    };
    write(name.padEnd(20, ' '), header);
    bytes[header + 20] = vbcSupport;
    write(maker, header + 25);
    write(code, header + 27);
    bytes[header + 31] = version;
    return bytes;
}

section('Reading a header');
{
    const header = parseRomHeader(rom({
        name: 'VUEPORT PROBE', maker: 'VU', code: 'VPRB', version: 3, vbcSupport: 0x80,
    }));
    // padded rather than trimmed, as the field is fixed width and the panel trims it for display
    check('the name, padded to the width of the field', header.name, 'VUEPORT PROBE       ');
    check('the maker', header.maker, 'VU');
    check('the code', header.code, 'VPRB');
    check('the version', header.version, 3);
    check('the VB Color support byte', header.vbcSupport, 0x80);
}

section('Resolving the hardware model');
{
    check('Auto keeps an ordinary ROM on original hardware',
        resolveVbHardwareMode(VbHardwareMode.AUTO, VbColorSupport.LEGACY), VbHardwareMode.VIRTUAL_BOY);
    check('Auto selects VBC for an enhanced ROM',
        resolveVbHardwareMode(VbHardwareMode.AUTO, VbColorSupport.ENHANCED), VbHardwareMode.VB_COLOR);
    check('Auto selects VBC for a VBC-only ROM',
        resolveVbHardwareMode(VbHardwareMode.AUTO, VbColorSupport.ONLY), VbHardwareMode.VB_COLOR);
    check('an unknown reserved value stays conservative',
        resolveVbHardwareMode(VbHardwareMode.AUTO, 0x40), VbHardwareMode.VIRTUAL_BOY);
    check('a forced original VB overrides a VBC header',
        resolveVbHardwareMode(VbHardwareMode.VIRTUAL_BOY, VbColorSupport.ONLY), VbHardwareMode.VIRTUAL_BOY);
    check('forced VBC exposes VBC hardware to a legacy ROM',
        resolveVbHardwareMode(VbHardwareMode.VB_COLOR, VbColorSupport.LEGACY), VbHardwareMode.VB_COLOR);
}

section('Where the header sits');
{
    // counted from the end, so a dump padded out to the next power of two still parses
    const padded = new Uint8Array(16 * 131072);
    padded.set(rom({ mbit: 8, name: 'PADDED' }), 0);
    check('a header at the end of a shorter dump is not found where the ROM ends',
        parseRomHeader(padded).name.trim(), '');

    const tail = new Uint8Array(16 * 131072);
    tail.set(rom({ mbit: 8, name: 'PADDED' }).subarray(8 * 131072 - 544), tail.length - 544);
    check('but is found when it is at the end of the file',
        parseRomHeader(tail).name.trim(), 'PADDED');
}

section('Refusing what is not a ROM');
{
    check('something too short to hold a header', parseRomHeader(new Uint8Array(16)), EMPTY_ROM_HEADER);
}

section('Size');
{
    check('one megabyte is eight MBit', romSizeInMBit(new Uint8Array(1024 * 1024)), 8);
    check('two megabytes is sixteen', romSizeInMBit(new Uint8Array(2 * 1024 * 1024)), 16);
}

section('The checksum a cheat entry is found by');
{
    const bytes = text => new Uint8Array([...text].map(c => c.charCodeAt(0)));
    // "123456789" is 0xcbf43926 in every conforming CRC-32 implementation
    check('the standard check value', crc32(bytes('123456789')), 0xcbf43926);
    check('nothing at all', crc32(new Uint8Array(0)), 0);
    check('a single byte', crc32(bytes('a')), 0xe8b7be43);
    check('the result is unsigned', crc32(bytes('abcdefgh')) >= 0, true);
    check('formatted as eight hex digits, zero padded',
        formatRomId(crc32(bytes('123456789'))), 'cbf43926');
    check('a small checksum keeps its leading zeros', formatRomId(0x0000abcd), '0000abcd');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
