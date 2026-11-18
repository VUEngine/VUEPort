// checks the cheat finder's pure half (lib/common/emulator-cheat-scan.js), where all its correctness lives:
// a first pass keeps exactly the matching offsets, later passes narrow against the previous values, and
// signed and unsigned readings are different searches. Usage: node tests/cheat-scan-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scan = require('../lib/common/emulator-cheat-scan.js');
const {
    ScanDataType,
    readScanValue,
    scanFirst,
    scanNext,
    scanOperatorNeedsValue,
    scanValueBytes,
} = scan;

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

// a Uint32Array reads back as an object through JSON; compare as a plain list
const list = offsets => Array.from(offsets);

section('Reading the bytes');
{
    const bytes = Uint8Array.from([0x00, 0x01, 0x80, 0xff, 0xfe, 0xff, 0xff, 0xff]);

    check('a byte is a byte', readScanValue(bytes, 1, ScanDataType.U8), 1);
    check('and signed it is the same when it fits', readScanValue(bytes, 1, ScanDataType.S8), 1);
    check('0x80 unsigned is 128', readScanValue(bytes, 2, ScanDataType.U8), 128);
    check('and signed is -128', readScanValue(bytes, 2, ScanDataType.S8), -128);

    check('a halfword is little-endian', readScanValue(bytes, 0, ScanDataType.U16), 0x0100);
    check('0xfffe unsigned is 65534', readScanValue(bytes, 4, ScanDataType.U16), 65534);
    check('and signed is -2', readScanValue(bytes, 4, ScanDataType.S16), -2);

    check('a word is little-endian too', readScanValue(bytes, 4, ScanDataType.U32), 0xfffffffe);
    check('and signed is -2', readScanValue(bytes, 4, ScanDataType.S32), -2);

    check('an offset with no room reads as 0', readScanValue(bytes, 7, ScanDataType.U32), 0);

    check('widths are what they say', [
        scanValueBytes(ScanDataType.U8),
        scanValueBytes(ScanDataType.S16),
        scanValueBytes(ScanDataType.U32),
    ], [1, 2, 4]);
}

section('Which questions need a number');
{
    check('the absolute ones do',
        ['eq', 'ne', 'gt', 'lt'].map(scanOperatorNeedsValue), [true, true, true, true]);
    check('the relative ones do not',
        ['changed', 'unchanged', 'increased', 'decreased'].map(scanOperatorNeedsValue),
        [false, false, false, false]);
}

section('The first pass, with a value to match');
{
    const snapshot = Uint8Array.from([7, 3, 7, 9, 7, 0, 1, 7]);

    check('every offset holding 7', list(scanFirst(snapshot, ScanDataType.U8, 'eq', 7)), [0, 2, 4, 7]);
    check('every offset not holding 7', list(scanFirst(snapshot, ScanDataType.U8, 'ne', 7)), [1, 3, 5, 6]);
    // the 9 at offset 3 is above 6 as well; "greater than" is not "equal to the biggest"
    check('everything above 6', list(scanFirst(snapshot, ScanDataType.U8, 'gt', 6)), [0, 2, 3, 4, 7]);
    check('everything below 3', list(scanFirst(snapshot, ScanDataType.U8, 'lt', 3)), [5, 6]);
    check('nothing matches a value that is not there',
        list(scanFirst(snapshot, ScanDataType.U8, 'eq', 200)), []);
}

section('The first pass with no value keeps everything');
{
    // "unknown" rules nothing out yet, so the pass seeds every aligned offset and narrowing starts on the next
    const snapshot = new Uint8Array(8);

    check('every byte', list(scanFirst(snapshot, ScanDataType.U8, 'changed')).length, 8);
    check('every aligned halfword', list(scanFirst(snapshot, ScanDataType.U16, 'decreased')), [0, 2, 4, 6]);
    check('every aligned word', list(scanFirst(snapshot, ScanDataType.U32, 'increased')), [0, 4]);
}

section('Wider types only start where they are allowed to');
{
    // a halfword counter sits on an even address; odd ones would invent candidates straddling two variables
    const snapshot = Uint8Array.from([0, 1, 0, 1, 0, 1]);

    check('halfwords land on even offsets',
        list(scanFirst(snapshot, ScanDataType.U16, 'eq', 0x0100)), [0, 2, 4]);
    check('and a short tail is not an offset',
        list(scanFirst(snapshot.subarray(0, 5), ScanDataType.U16, 'changed')), [0, 2]);
}

section('Narrowing against a value');
{
    const before = Uint8Array.from([5, 5, 5, 5]);
    const after = Uint8Array.from([5, 4, 5, 9]);
    const all = scanFirst(before, ScanDataType.U8, 'eq', 5);
    check('the first pass found all four', list(all), [0, 1, 2, 3]);

    check('only the ones still holding 5',
        list(scanNext(all, before, after, ScanDataType.U8, 'eq', 5)), [0, 2]);
}

section('Narrowing against what it held before');
{
    const before = Uint8Array.from([10, 10, 10, 10]);
    const after = Uint8Array.from([10, 9, 11, 10]);
    const all = scanFirst(before, ScanDataType.U8, 'changed');

    check('what moved at all', list(scanNext(all, before, after, ScanDataType.U8, 'changed')), [1, 2]);
    check('what stayed put', list(scanNext(all, before, after, ScanDataType.U8, 'unchanged')), [0, 3]);
    check('what went up', list(scanNext(all, before, after, ScanDataType.U8, 'increased')), [2]);
    check('what went down', list(scanNext(all, before, after, ScanDataType.U8, 'decreased')), [1]);
}

section('Signed and unsigned are different searches');
{
    // 0xff is 255 unsigned and -1 signed, so "it went down" depends on how the bytes are read
    const before = Uint8Array.from([0x01]);
    const after = Uint8Array.from([0xff]);
    const seed = Uint32Array.from([0]);

    check('unsigned, 1 to 255 went up',
        list(scanNext(seed, before, after, ScanDataType.U8, 'increased')), [0]);
    check('signed, 1 to -1 went down',
        list(scanNext(seed, before, after, ScanDataType.S8, 'decreased')), [0]);
    check('and signed did not go up',
        list(scanNext(seed, before, after, ScanDataType.S8, 'increased')), []);
}

section('Three passes converge on one address');
{
    // two addresses start at 3 but only one is the counter: the decoy at offset 5 stays while the real one drops
    const first = Uint8Array.from([0, 3, 0, 0, 0, 3, 0, 0]);
    const second = Uint8Array.from([0, 2, 0, 0, 0, 3, 0, 0]);
    const third = Uint8Array.from([0, 1, 0, 0, 0, 3, 0, 9]);

    let candidates = scanFirst(first, ScanDataType.U8, 'eq', 3);
    check('two addresses hold 3', list(candidates), [1, 5]);

    candidates = scanNext(candidates, first, second, ScanDataType.U8, 'eq', 2);
    check('one of them went to 2', list(candidates), [1]);

    candidates = scanNext(candidates, second, third, ScanDataType.U8, 'decreased');
    check('and it kept going down', list(candidates), [1]);

    let fuzzy = scanFirst(first, ScanDataType.U8, 'changed');
    check('the fuzzy pass starts with everything', list(fuzzy).length, 8);
    fuzzy = scanNext(fuzzy, first, second, ScanDataType.U8, 'decreased');
    check('only the counter went down', list(fuzzy), [1]);
    fuzzy = scanNext(fuzzy, second, third, ScanDataType.U8, 'decreased');
    check('and it is still the only one', list(fuzzy), [1]);
}

section('Narrowing never adds a candidate back');
{
    const before = Uint8Array.from([1, 1, 1, 1]);
    const after = Uint8Array.from([1, 1, 1, 1]);
    const two = Uint32Array.from([0, 2]);

    const kept = scanNext(two, before, after, ScanDataType.U8, 'unchanged');
    check('the ones already ruled out stay out', list(kept), [0, 2]);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
