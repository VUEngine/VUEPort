// the figures the Objects panel guesses at, from hand-built OAM modelled on real games: Jack Bros layers its characters
// at neighbouring JP values, Wario Land draws its hero once per eye, and several games park unused objects on a blank
// character next to a figure. Usage: node tests/object-cluster-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vip = require('../lib/browser/panels/emulator-vip-memory.js');
const { vipObjectClusters } = require('../lib/browser/panels/emulator-vip-object-clusters.js');

let failures = 0;

// SPT0 ends at 99, SPT1 at 199, the other two groups are empty past that
const registers = new DataView(new ArrayBuffer(vip.VIP_REGISTER_BLOCK_BYTES));
[99, 199, 199, 199].forEach((end, group) =>
    registers.setUint16(vip.VIP_OBJECT_GROUP_ENDS[group], end, true));

// character 0 is blank, every other one is solid
const segment = new Uint8Array(vip.VIP_CHAR_SEGMENT_BYTES).fill(0x55);
segment.fill(0, 0, vip.VIP_CHAR_BYTES);
const characters = new vip.VipCharacters([segment, segment, segment, segment]);

function object(index, jx, jy, extra = {}) {
    return { index, jx, jy, jp: 0, char: 1, palette: 0, hFlip: false, vFlip: false, lon: true, ron: true, ...extra };
}

function oamOf(objects) {
    const oam = Array.from({ length: vip.VIP_OBJECT_COUNT }, (unused, index) =>
        object(index, 0, 0, { lon: false, ron: false }));
    objects.forEach(entry => { oam[entry.index] = entry; });
    return oam;
}

// a 2×2 figure in four slots from first
function block(first, jx, jy) {
    return [object(first, jx, jy), object(first + 1, jx + 8, jy),
        object(first + 2, jx, jy + 8), object(first + 3, jx + 8, jy + 8)];
}

function check(label, objects, expected, previous) {
    const actual = vipObjectClusters(oamOf(objects), registers, characters, 'left', previous && oamOf(previous))
        .map(cluster => cluster.objects)
        .sort((a, b) => a[0] - b[0]);
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
        failures++;
    }
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(actual)}`}`);
}

check('a 2×2 block is one figure',
    [object(0, 10, 10), object(1, 18, 10), object(2, 10, 18), object(3, 18, 18)],
    [[0, 1, 2, 3]]);
check('cells touching only at a corner are linked',
    [object(0, 10, 10), object(1, 18, 18)],
    [[0, 1]]);
check('a gap on screen splits',
    [object(0, 10, 10), object(1, 30, 10)],
    [[0], [1]]);
check('layers a step apart in depth are one figure',
    [object(0, 10, 10, { jp: 4 }), object(1, 10, 10, { jp: 5 })],
    [[0, 1]]);
check('figures far apart in depth split',
    [object(0, 10, 10, { jp: 0 }), object(1, 18, 10, { jp: 8 })],
    [[0], [1]]);
check('one set of objects per eye is two figures',
    [object(0, 10, 10, { ron: false }), object(1, 18, 10, { ron: false }),
        object(2, 10, 10, { lon: false }), object(3, 18, 10, { lon: false })],
    [[0, 1], [2, 3]]);
check('a few switched-off slots do not end a run',
    [object(0, 10, 10), object(4, 18, 10)],
    [[0, 4]]);
check('a long stretch of OAM between two objects does',
    [object(0, 10, 10), object(20, 18, 10)],
    [[0], [20]]);
check('a group boundary does',
    [object(99, 10, 10), object(100, 18, 10)],
    [[99], [100]]);
check('a blank character joins nothing',
    [object(0, 10, 10), object(1, 18, 10, { char: 0 }), object(2, 26, 10)],
    [[0], [2]]);
check('an object past the last group is left out',
    [object(0, 10, 10), object(300, 18, 10)],
    [[0]]);
check('a figure straddling the top edge stays whole',
    [object(0, 10, 252), object(1, 10, 4)],
    [[0, 1]]);

// motion: the objects as they were at the last look, then as they are now
check('two touching figures moving apart are split',
    [...block(0, 10, 10), ...block(4, 26, 10)],
    [[0, 1, 2, 3], [4, 5, 6, 7]],
    [...block(0, 22, 10), ...block(4, 14, 10)]);
check('without a previous look they are one',
    [...block(0, 10, 10), ...block(4, 26, 10)],
    [[0, 1, 2, 3, 4, 5, 6, 7]]);
check('a figure moving as one stays whole',
    [...block(0, 10, 10), ...block(4, 26, 10)],
    [[0, 1, 2, 3, 4, 5, 6, 7]],
    [...block(0, 20, 14), ...block(4, 36, 14)]);
check('cells shifting a little against each other stay whole',
    [...block(0, 10, 10), ...block(4, 26, 10)],
    [[0, 1, 2, 3, 4, 5, 6, 7]],
    [...block(0, 13, 10), ...block(4, 25, 11)]);
check('slots handed out afresh do not split',
    [...block(0, 10, 10), ...block(4, 26, 10)],
    [[0, 1, 2, 3, 4, 5, 6, 7]],
    [object(0, 10, 10), object(1, 34, 18), object(2, 18, 10), object(3, 26, 18),
        object(4, 10, 18), object(5, 26, 10), object(6, 18, 18), object(7, 34, 10)]);

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
