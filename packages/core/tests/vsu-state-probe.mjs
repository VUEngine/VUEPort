/**
 * The VSU panel's data path against the shipped core. The panel polls readVsu, and the worker composes the map from the
 * core's decoded VSU copy in the simulation struct, which `src/worker/vb-vsu-layout.ts` locates by writing a register on
 * a throwaway simulation and seeing which byte moves. Checks:
 * 1. vbRead never reflects VSU stores (if it ever does, this mechanism can go).
 * 2. Calibration finds every field, catching a rebuilt `wasm/shrooms/core.wasm` that moved things.
 * 3. Every register, the five waveform banks and the modulation table come back through the map.
 * 4. A channel with an interval switches off on its own and the map says so, which write-watching could never show.
 * Usage: node tests/vsu-state-probe.mjs
 */
import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calibrateVsuLayout, composeVsuMap } = require('../lib/worker/vb-vsu-layout.js');

const VB_VSU_BASE = 0x01000000;
const REGISTERS = 0x01000400;
const CHANNEL_STRIDE = 0x40;
const CHANNELS = 6;
const U8 = 1;
const WAVEFORM_BASES = [0x000, 0x080, 0x100, 0x180, 0x200];
const MODULATION = 0x280;

let failures = 0;
function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}:\n    got      ${actual}\n    expected ${expected}`);
        return false;
    }
    console.log(`  ok   ${label}`);
    return true;
}

const corePath = new URL('../wasm/shrooms/core.wasm', import.meta.url);
const { instance } = await WebAssembly.instantiate(fs.readFileSync(corePath), {
    env: { emscripten_notify_memory_growth: () => { } }
});
const E = instance.exports;
E._initialize();

const sim = E.CreateSim();
E.vbReset(sim);
const at = (channel, register) => REGISTERS + channel * CHANNEL_STRIDE + register;

console.log('Why the map is composed rather than read');
E.vbWrite(sim, at(0, 0x04), U8, 0x7a);
check('a write to SxLRV does not come back through vbRead', E.vbRead(sim, at(0, 0x04), U8) & 0xff, 0);
E.vbWrite(sim, VB_VSU_BASE, U8, 0x2a);
check('a write to waveform RAM does not come back through vbRead', E.vbRead(sim, VB_VSU_BASE, U8) & 0xff, 0);

console.log('\nFinding this core\'s VSU state');
let layout;
try {
    layout = calibrateVsuLayout(E);
    console.log('  ok   calibration found every field');
} catch (error) {
    failures++;
    console.log(`  FAIL calibration: ${error.message}`);
    process.exit(1);
}
check('one record per channel', layout.channels.length, CHANNELS);
check('Noise has no waveform bank', layout.channels[5].waveform, undefined);
check('every other channel has one',
    layout.channels.slice(0, 5).every(c => typeof c.waveform === 'number'), true);

console.log('\nEverything written comes back through the map');
// distinct per channel, so a record read from the wrong one cannot pass
const written = [];
for (let channel = 0; channel < CHANNELS; channel++) {
    const value = {
        SxINT: 0x80 | (channel + 1),              // on, no auto-deactivate, interval 1..6
        SxLRV: ((channel + 9) & 0x0f) << 4 | ((14 - channel) & 0x0f),
        SxFQL: 0x20 + channel,
        SxFQH: (channel + 1) & 0x07,
        SxEV0: ((15 - channel) << 4) | 0x08 | (channel & 0x07),
        SxEV1: 0x03,
        SxRAM: channel & 0x07,
        S5SWP: 0xb5,
    };
    // SxINT last, as in a sound driver, as writing it loads the envelope and interval from the rest
    E.vbWrite(sim, at(channel, 0x04), U8, value.SxLRV);
    E.vbWrite(sim, at(channel, 0x08), U8, value.SxFQL);
    E.vbWrite(sim, at(channel, 0x0c), U8, value.SxFQH);
    E.vbWrite(sim, at(channel, 0x10), U8, value.SxEV0);
    E.vbWrite(sim, at(channel, 0x14), U8, value.SxEV1);
    if (channel < 5) {
        E.vbWrite(sim, at(channel, 0x18), U8, value.SxRAM);
    }
    if (channel === 4) {
        E.vbWrite(sim, at(channel, 0x1c), U8, value.S5SWP);
    }
    E.vbWrite(sim, at(channel, 0x00), U8, value.SxINT);
    written.push(value);
}
for (let bank = 0; bank < WAVEFORM_BASES.length; bank++) {
    for (let sample = 0; sample < 32; sample++) {
        E.vbWrite(sim, VB_VSU_BASE + WAVEFORM_BASES[bank] + sample * 4, U8, (bank * 32 + sample) & 0x3f);
    }
}
for (let step = 0; step < 32; step++) {
    E.vbWrite(sim, VB_VSU_BASE + MODULATION + step * 4, U8, (0x40 + step) & 0xff);
}

const map = composeVsuMap(E, layout, sim);
let wrong = [];
for (let channel = 0; channel < CHANNELS; channel++) {
    const block = REGISTERS - VB_VSU_BASE + channel * CHANNEL_STRIDE;
    const value = written[channel];
    const same = (register, offset) => {
        if (map[block + offset] !== value[register]) {
            wrong.push(`ch${channel} ${register}: 0x${map[block + offset].toString(16)}`
                + ` != 0x${value[register].toString(16)}`);
        }
    };
    same('SxINT', 0x00);
    same('SxLRV', 0x04);
    same('SxFQL', 0x08);
    same('SxFQH', 0x0c);
    same('SxEV0', 0x10);
    // SxEV1's top bits are the sweep on the fifth channel and the noise tap on the sixth, so only the envelope's
    // two bits are the same for all
    if ((map[block + 0x14] & 0x03) !== (value.SxEV1 & 0x03)) {
        wrong.push(`ch${channel} SxEV1: 0x${map[block + 0x14].toString(16)}`);
    }
    if (channel < 5) {
        same('SxRAM', 0x18);
    }
    if (channel === 4) {
        same('S5SWP', 0x1c);
    }
}
check('every channel register reads back', wrong.join(' | ') || 'none', 'none');

wrong = [];
for (let bank = 0; bank < WAVEFORM_BASES.length; bank++) {
    for (let sample = 0; sample < 32; sample++) {
        const got = map[WAVEFORM_BASES[bank] + sample * 4];
        const expected = (bank * 32 + sample) & 0x3f;
        if (got !== expected) {
            wrong.push(`bank ${bank} sample ${sample}: ${got} != ${expected}`);
        }
    }
}
check('every waveform sample reads back', wrong.slice(0, 3).join(' | ') || 'none', 'none');
wrong = [];
for (let step = 0; step < 32; step++) {
    const got = map[MODULATION + step * 4];
    if (got !== ((0x40 + step) & 0xff)) {
        wrong.push(`step ${step}: ${got}`);
    }
}
check('every modulation step reads back', wrong.slice(0, 3).join(' | ') || 'none', 'none');

console.log('\nThe enable bit is the hardware\'s, not the last thing written');
// auto-deactivate with the shortest interval: the hardware switches it off, nothing writes the VSU from here on
E.vbWrite(sim, at(0, 0x00), U8, 0x80 | 0x20 | 0x00);
const enabled = () => (composeVsuMap(E, layout, sim)[REGISTERS - VB_VSU_BASE] & 0x80) !== 0;
check('switched on, it reads as playing', enabled(), true);

const sims = E.Realloc(0, 4);
new Uint32Array(E.memory.buffer, sims, 1)[0] = sim;
const clocks = E.Realloc(0, 4);
E.vbSetSamples(sim, E.GetExtSamples(sim), 5, 834);
new Uint32Array(E.memory.buffer, clocks, 1)[0] = 1_000_000;   // 50 ms, an interval is 3.8
let guard = 0;
while (new Uint32Array(E.memory.buffer, clocks, 1)[0] !== 0 && guard++ < 1000) {
    E.Emulate(sims, 1, clocks);
}
check('once its interval has elapsed, it reads as off', enabled(), false);

// SSTOP silences every channel at once without touching a register
E.vbWrite(sim, at(0, 0x00), U8, 0x80);
E.vbWrite(sim, at(3, 0x00), U8, 0x80);
const playing = () => {
    const now = composeVsuMap(E, layout, sim);
    return [0, 3].filter(channel =>
        (now[REGISTERS - VB_VSU_BASE + channel * CHANNEL_STRIDE] & 0x80) !== 0).length;
};
check('two channels switched on read as playing', playing(), 2);
E.vbWrite(sim, 0x01000580, U8, 0x01);
check('SSTOP takes them both out', playing(), 0);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
