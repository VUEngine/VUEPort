/**
 * Which object group an OBJECT world draws, asked of the core itself. The VIP's group pointer starts at 3 and walks down
 * as it meets OBJECT worlds from world 31 to 0, with SPT0..SPT3 saying where each group ends in OAM. The documentation
 * does not settle what happens at an OBJECT world the VIP does not draw (both eye bits clear, or only the other eye's),
 * which the Worlds panel needs to attribute objects in its preview. So this puts one object per group in a column of its
 * own, lets the core draw a frame and reads back which column lit up.
 * Usage: node tests/object-group-probe.mjs
 */
import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vip = require('../lib/browser/panels/emulator-vip-memory.js');

const CORE = new URL('../wasm/shrooms/core.wasm', import.meta.url);
const { instance } = await WebAssembly.instantiate(fs.readFileSync(CORE), {
    env: { emscripten_notify_memory_growth: () => { } }
});
const E = instance.exports;
E._initialize();

const U8 = 1, U16 = 3;
const W = 384;
const CLOCKS_PER_FRAME = 400000;

// VIP registers are halfword-indexed from 0x0005F800 (libgccvb vip.h)
const REG = index => 0x0005F800 + index * 2;
const DPCTRL = REG(0x11);
const BRTA = REG(0x12), BRTB = REG(0x13), BRTC = REG(0x14), REST = REG(0x15);
const FRMCYC = REG(0x17), CTA = REG(0x18), XPCTRL = REG(0x21);
const SPT = [REG(0x24), REG(0x25), REG(0x26), REG(0x27)];
const JPLT0 = REG(0x34);
const DISP = 0x0002, RE = 0x0100, SYNCE = 0x0200, XPEN = 0x0002;

const COLUMN_TABLES = [0x0003DC00, 0x0003DE00];
const CHAR_SEGMENT_0 = 0x00006000;
const WORLDS = 0x0003D800;
const OAM = 0x0003E000;

// world.h and object.h, the bits this probe writes
const WRLD_LON = 0x8000, WRLD_RON = 0x4000, WRLD_OBJ = 0x3000, WRLD_END = 0x0040;
const JLON = 0x8000, JRON = 0x4000;

const romLength = 1 << 20;
const romPointer = E.Realloc(0, romLength);
new Uint8Array(E.memory.buffer, romPointer, romLength).fill(0);
const sim = E.CreateSim();
E.vbSetCartROM(sim, romPointer, romLength);
E.SetAnaglyph(sim, 0xFF0000, 0x00FF00);   // eye-packed, as the worker configures it
E.vbReset(sim);

const clocksPointer = E.Realloc(0, 4);
const simsPointer = E.Realloc(0, 4);
new Uint32Array(E.memory.buffer, simsPointer, 1)[0] = sim;
const clocks = () => new Uint32Array(E.memory.buffer, clocksPointer, 1);

function run(count) {
    clocks()[0] = count;
    let guard = 0;
    while (clocks()[0] !== 0 && guard++ < 100000) {
        E.Emulate(simsPointer, 1, clocksPointer);
        E.GetBreaks(sim);
    }
}

const columnOf = index => 16 + index * 32;
const ROW = 64;

function setUp() {
    E.vbWrite(sim, DPCTRL, U16, SYNCE | RE | DISP);
    E.vbWrite(sim, XPCTRL, U16, XPEN);
    E.vbWrite(sim, FRMCYC, U16, 0);
    E.vbWrite(sim, REST, U16, 0);
    E.vbWrite(sim, CTA, U16, 0);
    for (const base of COLUMN_TABLES) {
        for (let entry = 0; entry < 256; entry++) {
            E.vbWrite(sim, base + entry * 2, U16, 0);
        }
    }
    // VUEngine's default brightness, and a palette that maps pixel value 3 to the brightest level
    E.vbWrite(sim, BRTA, U16, 32);
    E.vbWrite(sim, BRTB, U16, 64);
    E.vbWrite(sim, BRTC, U16, 32);
    E.vbWrite(sim, JPLT0, U16, 0xE4);

    // character 1, every pixel at value 3; character 0 stays blank, so an object never written draws nothing
    for (let byte = 0; byte < 16; byte++) {
        E.vbWrite(sim, CHAR_SEGMENT_0 + 16 + byte, U8, 0xFF);
    }

    // one object per group, each in a column of its own. SPT0..SPT3 = 0..3 makes group N exactly object N
    for (let index = 0; index < 4; index++) {
        E.vbWrite(sim, OAM + index * 8 + 0, U16, columnOf(index));          // JX
        E.vbWrite(sim, OAM + index * 8 + 2, U16, JLON | JRON);              // JP, both eyes
        E.vbWrite(sim, OAM + index * 8 + 4, U16, ROW);                      // JY
        E.vbWrite(sim, OAM + index * 8 + 6, U16, 1);                        // character 1, palette 0
        E.vbWrite(sim, SPT[index], U16, index);
    }
}

// points the given worlds at OBJECT mode, ends the frame under them, draws, and says which objects came out in the
// given eye (red carries the left eye and green the right in the eye-packed framebuffer)
function draw(heads, eye = 'left') {
    for (let index = 0; index < 32; index++) {
        E.vbWrite(sim, WORLDS + index * 32, U16, heads[index] ?? WRLD_END);
    }
    for (let frame = 0; frame < 4; frame++) {
        run(CLOCKS_PER_FRAME);
    }
    E.GetPixels(sim);
    const pixels = new Uint8Array(E.memory.buffer, E.GetExtPixels(sim), W * 224 * 4);
    const channel = eye === 'left' ? 0 : 1;
    return [0, 1, 2, 3].filter(index =>
        pixels[((ROW + 2) * W + columnOf(index) + 2) * 4 + channel] > 0);
}

function objectEyes(index, lon, ron) {
    E.vbWrite(sim, OAM + index * 8 + 2, U16, (lon ? JLON : 0) | (ron ? JRON : 0));
}

// which objects vipObjectGroupForWorld says these worlds draw; with SPT0..SPT3 at 0..3 directly what draw reads back
function predicted(heads) {
    const view = new DataView(new ArrayBuffer(32 * 32));
    for (let index = 0; index < 32; index++) {
        view.setUint16(index * 32, heads[index] ?? WRLD_END, true);
    }
    const list = [];
    for (let index = 31; index >= 0; index--) {
        list.push(vip.decodeVipWorld(view, index, index * 32));
    }
    return list
        // as the panel does: a world neither eye asks for is not drawn, and never asked what group it would have taken
        .filter(world => world.mode === vip.VipWorldMode.OBJECT && (world.lon || world.ron))
        .map(world => vip.vipObjectGroupForWorld(list, world.index))
        .filter(group => group !== undefined)
        .sort();
}

// a world list with the given heads at 31, 30, ... and End under them
function worlds(...heads) {
    const list = [];
    heads.forEach((head, offset) => { list[31 - offset] = head; });
    list[31 - heads.length] = WRLD_END;
    return list;
}

setUp();

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) { failures++; }
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}  ${JSON.stringify(actual)}${ok ? '' : ' expected ' + JSON.stringify(expected)}`);
}

console.log('=== The pointer starts at 3 and walks down ===');
check('one OBJECT world draws group 3', draw(worlds(WRLD_LON | WRLD_RON | WRLD_OBJ)), [3]);
check('two draw groups 3 and 2', draw(worlds(
    WRLD_LON | WRLD_RON | WRLD_OBJ,
    WRLD_LON | WRLD_RON | WRLD_OBJ
)), [2, 3]);

console.log('\n=== An OBJECT world with both eyes off is passed over ===');
// its group is not consumed: the world under it still draws group 3
check('both eyes off, then one drawn', draw(worlds(
    WRLD_OBJ,
    WRLD_LON | WRLD_RON | WRLD_OBJ
)), [3]);

console.log('\n=== One eye is enough to consume a group ===');
// the first world asks for the right eye only and this reads the left: its objects are there all the same, and the
// world under it has moved on to group 2. A world's eye bits decide whether it is drawn, the objects' own bits which
// eye they land in
check('right eye only, then one drawn', draw(worlds(
    WRLD_RON | WRLD_OBJ,
    WRLD_LON | WRLD_RON | WRLD_OBJ
)), [2, 3]);

console.log('\n=== The world that ends the frame is not drawn either ===');
// End stops the VIP at that world rather than after it, so an OBJECT world carrying it draws nothing and does not
// consume a group
check('an OBJECT world carrying End', draw(worlds(
    WRLD_LON | WRLD_RON | WRLD_OBJ | WRLD_END
)), []);

console.log('\n=== A BGMap world in between changes nothing ===');
check('BGMap, then one OBJECT world', draw(worlds(
    WRLD_LON | WRLD_RON,
    WRLD_LON | WRLD_RON | WRLD_OBJ
)), [3]);

console.log('\n=== Whose eye bits decide where an object lands ===');
// a world drawn to the right eye only, holding objects that ask for both
check('right-eye world, both-eye object, left eye',
    draw(worlds(WRLD_RON | WRLD_OBJ)), [3]);
check('right-eye world, both-eye object, right eye',
    draw(worlds(WRLD_RON | WRLD_OBJ), 'right'), [3]);
// ...and the object's own bits, in a world drawn to both
objectEyes(3, true, false);
check('both-eye world, left-eye object, left eye',
    draw(worlds(WRLD_LON | WRLD_RON | WRLD_OBJ)), [3]);
check('both-eye world, left-eye object, right eye',
    draw(worlds(WRLD_LON | WRLD_RON | WRLD_OBJ), 'right'), []);
objectEyes(3, true, true);

console.log('\n=== The rule the panels apply says the same ===');
for (const [label, heads] of [
    ['one OBJECT world', worlds(WRLD_LON | WRLD_RON | WRLD_OBJ)],
    ['two OBJECT worlds', worlds(WRLD_LON | WRLD_RON | WRLD_OBJ, WRLD_LON | WRLD_RON | WRLD_OBJ)],
    ['both eyes off above one drawn', worlds(WRLD_OBJ, WRLD_LON | WRLD_RON | WRLD_OBJ)],
    ['one eye above one drawn', worlds(WRLD_RON | WRLD_OBJ, WRLD_LON | WRLD_RON | WRLD_OBJ)],
    ['an OBJECT world carrying End', worlds(WRLD_LON | WRLD_RON | WRLD_OBJ | WRLD_END)],
    ['a BGMap world above one', worlds(WRLD_LON | WRLD_RON, WRLD_LON | WRLD_RON | WRLD_OBJ)],
    ['four OBJECT worlds', worlds(...Array(4).fill(WRLD_LON | WRLD_RON | WRLD_OBJ))],
    ['five OBJECT worlds', worlds(...Array(5).fill(WRLD_LON | WRLD_RON | WRLD_OBJ))],
]) {
    check(label, predicted(heads), draw(heads));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
