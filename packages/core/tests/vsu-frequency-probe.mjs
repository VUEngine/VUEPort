/**
 * What note a channel actually plays, measured on the core. The VSU frequency register holds the rate at which the
 * hardware steps through a 32-sample waveform, so 5,000,000 / (2048 - F) is 32 times the note (A4 would read as
 * 14,080 Hz). A channel gets a square wave, the machine runs, and the fundamental of its sample buffer is counted: one
 * formula is right within a 20 ms buffer's resolution, the other is off by 32. Noise has no waveform, so for it the
 * formula is its LFSR clock, not a note.
 * Usage: node tests/vsu-frequency-probe.mjs
 */
import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patchTableLimit } = require('../lib/worker/vb-wasm.js');
const {
    decodeVsuChannel,
    VSU_CHANNEL_STRIDE,
    VsuChannelRegister,
    vsuNoteName,
    vsuNoteOf,
} = require('../lib/browser/panels/emulator-vsu-memory.js');

// what the core produces, and how long one buffer of it is
const SAMPLE_RATE = 41700;
const SAMPLES = 834;

let failures = 0;
function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
        return false;
    }
    console.log(`  ok   ${label}`);
    return true;
}

const corePath = new URL('../wasm/shrooms/core.wasm', import.meta.url);

// a square wave, as counting a fundamental needs zero crossings and the decode probe's full-scale bank has none
function buildRom(frequency) {
    const size = 0x100000;
    const rom = new Uint8Array(size);
    const view = new DataView(rom.buffer);
    let at = 0;
    const half = value => { view.setUint16(at, value & 0xffff, true); at += 2; };
    const movhi = (imm, r1, r2) => { half((0x2f << 10) | (r2 << 5) | r1); half(imm); };
    const movea = (imm, r1, r2) => { half((0x28 << 10) | (r2 << 5) | r1); half(imm); };
    const stb = (r2, disp, r1) => { half((0x34 << 10) | (r2 << 5) | r1); half(disp); };
    const jmp = r1 => half((0x06 << 10) | r1);

    at = 0x1000;
    movhi(0x0100, 0, 10); // r10 = 0x01000000, the base of the VSU
    // bank 0: sixteen samples at the top, sixteen at the bottom. Written before any channel is switched on, the only
    // time the VSU accepts it
    for (let sample = 0; sample < 32; sample += 1) {
        movea(sample < 16 ? 63 : 0, 0, 11);
        stb(11, sample * 4, 10);
    }
    const write = (offset, value) => { movea(value, 0, 11); stb(11, 0x400 + offset, 10); };
    write(VsuChannelRegister.SxLRV, 0xff); // full left and right
    write(VsuChannelRegister.SxFQL, frequency & 0xff);
    write(VsuChannelRegister.SxFQH, (frequency >> 8) & 0x07);
    write(VsuChannelRegister.SxRAM, 0x00); // waveform bank 0
    write(VsuChannelRegister.SxEV0, 0xf0); // level 15, envelope flat
    write(VsuChannelRegister.SxEV1, 0x00);
    write(VsuChannelRegister.SxINT, 0x80); // last: writing it reloads the counters
    half(0x9400); // br 0

    at = size - 0x10;
    movhi(0xfff0, 0, 10);
    movea(0x1000, 10, 10);
    jmp(10);
    return rom;
}

async function toneOf(frequency) {
    const bytes = patchTableLimit(new Uint8Array(fs.readFileSync(corePath)));
    const { instance } = await WebAssembly.instantiate(bytes, {
        env: { emscripten_notify_memory_growth: () => { } },
    });
    const E = instance.exports;
    E._initialize();
    const rom = buildRom(frequency);
    const romPtr = E.Realloc(0, rom.length);
    new Uint8Array(E.memory.buffer, romPtr, rom.length).set(rom);
    const sim = E.CreateSim();
    E.vbSetCartROM(sim, romPtr, rom.length);
    const ramPtr = E.Realloc(0, 8192);
    new Uint8Array(E.memory.buffer, ramPtr, 8192).fill(0);
    E.vbSetCartRAM(sim, ramPtr, 8192);
    E.vbReset(sim);

    const samplesPtr = E.GetExtSamples(sim);
    const simsPtr = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, simsPtr, 1)[0] = sim;
    const clocksPtr = E.Realloc(0, 4);
    for (let frame = 0; frame < 8; frame += 1) {
        // rewound every frame like the worker's drive loop, so the buffer holds one whole frame of sound and nothing
        // from before the channel was switched on
        E.vbSetSamples(sim, samplesPtr, 5, SAMPLES); // 5 = VbDataType.F32
        new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] = 400000;
        let guard = 0;
        while (new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] !== 0 && guard++ < 100000) {
            E.Emulate(simsPtr, 1, clocksPtr);
        }
    }

    const out = new Float32Array(E.memory.buffer, samplesPtr, SAMPLES * 2);
    const left = [];
    for (let i = 0; i < SAMPLES; i += 1) {
        left.push(out[i * 2]);
    }
    const mean = left.reduce((sum, value) => sum + value, 0) / left.length;
    // rising crossings of the mean, one per cycle however asymmetric the wave. The partial first and last cycles
    // bound the accuracy, hence a few percent of tolerance below
    let crossings = 0;
    let first = -1;
    let last = -1;
    for (let i = 1; i < left.length; i += 1) {
        if (left[i - 1] <= mean && left[i] > mean) {
            if (first < 0) {
                first = i;
            } else {
                last = i;
                crossings += 1;
            }
        }
    }
    return crossings === 0 ? 0 : (crossings * SAMPLE_RATE) / (last - first);
}

console.log('\nWhat the core plays a programmed frequency at');
for (const raw of [1892, 1693, 1024]) {
    const step = 5000000 / (2048 - raw);
    const tone = step / 32;
    const measured = await toneOf(raw);
    const off = Math.abs(measured - tone) / tone;
    console.log(`  F=${raw}: step rate ${step.toFixed(0)} Hz, tone ${tone.toFixed(1)} Hz, `
        + `measured ${measured.toFixed(1)} Hz`);
    check(`F=${raw} plays the step rate divided by 32`, off < 0.03, true);
    check(`F=${raw} does not play the step rate itself`,
        Math.abs(measured - step) / step < 0.03, false);

    const registers = new DataView(new ArrayBuffer(VSU_CHANNEL_STRIDE * 6));
    registers.setUint8(VsuChannelRegister.SxINT, 0x80);
    registers.setUint8(VsuChannelRegister.SxFQL, raw & 0xff);
    registers.setUint8(VsuChannelRegister.SxFQH, (raw >> 8) & 0x07);
    const channel = decodeVsuChannel(registers, 0);
    check(`F=${raw}: the decoder agrees with the core`,
        Math.abs(channel.frequencyHz - measured) / measured < 0.03, true);

    // and the Noise channel, which steps no waveform, keeps the rate itself. Its own register block, five blocks
    // along, or the decoder reads zeros
    const noiseRegisters = new DataView(new ArrayBuffer(VSU_CHANNEL_STRIDE * 6));
    const noiseBase = VSU_CHANNEL_STRIDE * 5;
    noiseRegisters.setUint8(noiseBase + VsuChannelRegister.SxINT, 0x80);
    noiseRegisters.setUint8(noiseBase + VsuChannelRegister.SxFQL, raw & 0xff);
    noiseRegisters.setUint8(noiseBase + VsuChannelRegister.SxFQH, (raw >> 8) & 0x07);
    const noise = decodeVsuChannel(noiseRegisters, 5);
    check(`F=${raw}: Noise is clocked at the undivided rate`,
        Math.abs(noise.frequencyHz - step) < 1, true);
}

console.log('\nNaming the note a frequency is');
{
    check('concert A', vsuNoteName(440), 'A4');
    check('an octave below', vsuNoteName(220), 'A3');
    check('an octave above', vsuNoteName(880), 'A5');
    check('middle C', vsuNoteName(261.63), 'C4');
    check('the black key above it', vsuNoteName(277.18), 'C#4');
    check('B below middle C', vsuNoteName(246.94), 'B3');
    check('nothing at all has no name', vsuNoteName(0), undefined);

    // rounded to the nearest semitone, with the error kept so a channel between two notes can say so
    const sharp = vsuNoteOf(452);
    check('a note 47 cents sharp still names the note', sharp?.name, 'A4');
    check('and says how far off it is', sharp !== undefined && sharp.cents >= 44 && sharp.cents <= 48,
        true);
    // 20 Hz is not a piano key, but still gets the nearest name, which is what a sweep running off the bottom wants
    check('a note below the piano is still named', vsuNoteName(20), 'D#0');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
