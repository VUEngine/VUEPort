/**
 * The filmstrip's way through the rewind history, on a real game with the shipped codec. Plays forward capturing reverse
 * deltas, then walks back to the middle, forward to the end, to the start and back to the middle as
 * Worker#moveRewindCursor does (the same entries applied in either direction), asserting that every state landed on
 * matches the one captured. Then plays on from the middle after dropping the future (Worker#dropRewindFuture) and checks
 * that the fresh deltas walk back to it. Also checks the thumbnail halving (shrinkFrame/growFrame) on a made-up frame.
 * Usage: node tests/rewind-browse-probe.mjs <path/to/rom.vb>
 */
import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { encodeDelta, applyDelta, createRunScratch, shrinkFrame, growFrame } =
    require('../lib/worker/vb-rewind.js');

const romPath = process.argv[2];
if (!romPath) {
    console.error('Usage: node tests/rewind-browse-probe.mjs <path/to/rom.vb>');
    process.exit(1);
}

const CLOCKS = 400000, F32 = 5, SAMPLES = 834;
const BOOT_FRAMES = 250;
const CAPTURES = 120;

let failures = 0;
function check(label, ok, detail) {
    if (!ok) {
        failures++;
        console.log(`  FAIL ${label}${detail ? `:\n    ${detail}` : ''}`);
        return;
    }
    console.log(`  ok   ${label}`);
}

// thumbnails first, as they need no core
{
    const width = 8, height = 4;
    const frame = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            frame[at] = x * 10 + y;
            frame[at + 1] = 255 - x;
            frame[at + 2] = 7;
            frame[at + 3] = 99;
        }
    }
    const shrunk = shrinkFrame(frame, width, height, 2);
    check('shrinkFrame keeps two channels at half size', shrunk.length === (width / 2) * (height / 2) * 2);
    // the block at (2..3, 0..1): red 20,30,21,31 averages to 25.5, rounded up
    check('shrinkFrame averages a 2x2 block', shrunk[2] === 26 && shrunk[3] === 253,
        `got ${shrunk[2]}, ${shrunk[3]}`);
    const grown = new Uint8Array(frame.length);
    growFrame(shrunk, width, height, 2, grown);
    const at = (1 * width + 3) * 4;
    check('growFrame spreads a pixel over its block, opaque, unused channels zero',
        grown[at] === 26 && grown[at + 1] === 253 && grown[at + 2] === 0 && grown[at + 3] === 255,
        `got ${Array.from(grown.subarray(at, at + 4))}`);
    const vbc = shrinkFrame(frame, width, height, 3);
    check('shrinkFrame keeps three channels for VBC', vbc.length === (width / 2) * (height / 2) * 3 && vbc[2] === 7);
}

const corePath = new URL('../wasm/shrooms/core.wasm', import.meta.url);
const { instance } = await WebAssembly.instantiate(fs.readFileSync(corePath), {
    env: { emscripten_notify_memory_growth: () => { } }
});
const E = instance.exports;
E._initialize();

const SIZE = E.vbSizeOf();
const rom = fs.readFileSync(romPath);
const romPtr = E.Realloc(0, rom.length);
new Uint8Array(E.memory.buffer, romPtr, rom.length).set(rom);

const sim = E.CreateSim();
if (E.vbSetCartROM(sim, romPtr, rom.length) !== 0) throw new Error('Core rejected the ROM');
const ramPtr = E.Realloc(0, 8192);
new Uint8Array(E.memory.buffer, ramPtr, 8192).fill(0);
E.vbSetCartRAM(sim, ramPtr, 8192);
E.vbSetKeys(sim, 0x0002);
E.vbReset(sim);

const samplesPtr = E.GetExtSamples(sim);
const simsPtr = E.Realloc(0, 4);
const clocksPtr = E.Realloc(0, 4);
new Uint32Array(E.memory.buffer, simsPtr, 1)[0] = sim;

function runFrame() {
    E.vbSetSamples(sim, samplesPtr, F32, SAMPLES);
    new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] = CLOCKS;
    let guard = 0;
    while (new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] !== 0 && guard++ < 200000) {
        E.Emulate(simsPtr, 1, clocksPtr);
    }
}

const live = () => new Uint8Array(E.memory.buffer, sim, SIZE);
const same = (a, b) => {
    for (let i = 0; i < SIZE; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
};

for (let i = 0; i < BOOT_FRAMES; i++) runFrame();

const scratch = createRunScratch();
const mirror = live().slice();
const entries = [];
const truth = [mirror.slice()];
for (let i = 0; i < CAPTURES; i++) {
    runFrame();
    const current = live();
    entries.push(encodeDelta(mirror, current, scratch));
    mirror.set(current);
    truth.push(mirror.slice());
}

// Worker#moveRewindCursor
let cursor = CAPTURES;
function moveTo(target) {
    while (cursor > target) {
        cursor--;
        applyDelta(mirror, entries[cursor]);
    }
    while (cursor < target) {
        applyDelta(mirror, entries[cursor]);
        cursor++;
    }
}

for (const [label, target] of [
    ['back to the middle', CAPTURES / 2],
    ['forward to the end', CAPTURES],
    ['back to the start', 0],
    ['forward to the middle', CAPTURES / 2],
]) {
    moveTo(target);
    check(`${label} lands on capture ${target} byte for byte`, same(mirror, truth[target]));
}

// Worker#dropRewindFuture, then play on from the middle as the drive loop would
entries.splice(cursor);
live().set(mirror);
E.vbSetCartROM(sim, romPtr, rom.length);
E.vbSetCartRAM(sim, ramPtr, 8192);
const middle = live().slice();
const pcBefore = E.vbGetProgramCounter(sim);
for (let i = 0; i < 10; i++) {
    runFrame();
    const current = live();
    entries.push(encodeDelta(mirror, current, scratch));
    mirror.set(current);
}
cursor = entries.length;
check('playing on from the middle runs', E.vbGetProgramCounter(sim) !== pcBefore || !same(live(), middle));
moveTo(CAPTURES / 2);
check('the new history walks back to the middle', same(mirror, middle));

console.log(failures ? `\n${failures} FAILED` : '\nRewind browsing is byte-exact both ways.');
process.exit(failures ? 1 : 0);
