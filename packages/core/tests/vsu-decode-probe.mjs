/**
 * Which register bit means "this channel is sounding", settled against the shipped core. SxINT bit 7 switches a channel
 * on, SxEV1 bit 0 only its envelope; decoding the second as the first is wrong in both directions. Rather than trust the
 * two tables emulator-vsu-memory.ts cites, this programs one channel four ways in a real cartridge, listens to the
 * core's sample buffer, then checks decodeVsuChannel against it. Also covers SSTOP, which silences every channel
 * without touching a register the shadow mirrors (see the write watch in vb-worker.ts).
 * Usage: node tests/vsu-decode-probe.mjs
 */
import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patchTableLimit } = require('../lib/worker/vb-wasm.js');
const {
    decodeVsuChannel,
    VSU_CHANNEL_STRIDE,
    VsuChannelRegister,
    vsuChannelLevel,
} = require('../lib/browser/panels/emulator-vsu-memory.js');

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

function section(name) {
    console.log(`\n${name}`);
}

const corePath = new URL('../wasm/shrooms/core.wasm', import.meta.url);

// fills waveform bank 0 at full scale, programs channel 0 with the given SxINT and SxEV1, optionally writes
// SSTOP, then spins. SxINT goes last, as writing it reloads the interval and envelope counters (the order a
// sound driver uses and the core's vsuWriteINT assumes).
function buildRom({ sxint, sxev1, sstop = false }) {
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
    // every sample at full scale, so a sounding channel is loud and a silent one unmistakable. Written before any
    // channel is switched on, the only time the VSU accepts it.
    movea(63, 0, 11);
    for (let sample = 0; sample < 32; sample += 1) {
        stb(11, sample * 4, 10);
    }
    const write = (offset, value) => { movea(value, 0, 11); stb(11, 0x400 + offset, 10); };
    write(VsuChannelRegister.SxLRV, 0xff); // full left and right
    write(VsuChannelRegister.SxFQL, 0x00);
    write(VsuChannelRegister.SxFQH, 0x00);
    write(VsuChannelRegister.SxRAM, 0x00); // waveform bank 0
    write(VsuChannelRegister.SxEV0, 0xf0); // envelope level 15
    write(VsuChannelRegister.SxEV1, sxev1);
    write(VsuChannelRegister.SxINT, sxint);
    if (sstop) {
        movea(1, 0, 11);
        stb(11, 0x580, 10);
    }
    half(0x9400); // br 0

    at = size - 0x10;
    movhi(0xfff0, 0, 10);
    movea(0x1000, 10, 10);
    jmp(10);
    return rom;
}

async function peakOf(config) {
    const bytes = patchTableLimit(new Uint8Array(fs.readFileSync(corePath)));
    const { instance } = await WebAssembly.instantiate(bytes, {
        env: { emscripten_notify_memory_growth: () => { } },
    });
    const E = instance.exports;
    E._initialize();
    const rom = buildRom(config);
    const romPtr = E.Realloc(0, rom.length);
    new Uint8Array(E.memory.buffer, romPtr, rom.length).set(rom);
    const sim = E.CreateSim();
    E.vbSetCartROM(sim, romPtr, rom.length);
    const ramPtr = E.Realloc(0, 8192);
    new Uint8Array(E.memory.buffer, ramPtr, 8192).fill(0);
    E.vbSetCartRAM(sim, ramPtr, 8192);
    E.vbReset(sim);

    // the core's own sample buffer, driven as vsu-state-probe.mjs drives it
    const capacity = 834;
    E.vbSetSamples(sim, E.GetExtSamples(sim), 5, capacity);
    const simsPtr = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, simsPtr, 1)[0] = sim;
    const clocksPtr = E.Realloc(0, 4);
    for (let frame = 0; frame < 8; frame += 1) {
        new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] = 400000;
        let guard = 0;
        while (new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] !== 0 && guard++ < 100000) {
            E.Emulate(simsPtr, 1, clocksPtr);
        }
    }
    const out = new Int16Array(E.memory.buffer, E.GetExtSamples(sim), capacity * 2);
    let peak = 0;
    for (const value of out) {
        peak = Math.max(peak, Math.abs(value));
    }
    return peak;
}

function decode({ sxint, sxev1 }) {
    const registers = new DataView(new ArrayBuffer(VSU_CHANNEL_STRIDE * 6));
    registers.setUint8(VsuChannelRegister.SxINT, sxint);
    registers.setUint8(VsuChannelRegister.SxLRV, 0xff);
    registers.setUint8(VsuChannelRegister.SxEV0, 0xf0);
    registers.setUint8(VsuChannelRegister.SxEV1, sxev1);
    return decodeVsuChannel(registers, 0);
}

section('Which bit switches a channel on, asked of the core');
const cases = [
    ['channel on, envelope off', { sxint: 0x80, sxev1: 0x00 }, true],
    ['channel off, envelope on', { sxint: 0x00, sxev1: 0x01 }, false],
    ['both on', { sxint: 0x80, sxev1: 0x01 }, true],
    ['both off', { sxint: 0x00, sxev1: 0x00 }, false],
];
for (const [label, config, sounds] of cases) {
    const peak = await peakOf(config);
    check(`${label}: ${sounds ? 'sounds' : 'is silent'}`, peak > 0, sounds);
    check(`${label}: the decoder agrees`, decode(config).enabled, sounds);
}

section('SSTOP silences everything');
{
    // SSTOP silences the channel without touching SxINT, so no write watch could follow it. That the panel's map
    // still gets it is tests/vsu-state-probe.mjs, here only that the core does it.
    check('a channel switched on and then stopped is silent', await peakOf({
        sxint: 0x80, sxev1: 0x00, sstop: true,
    }) > 0, false);
}

section('The rest of the registers the panel reads');
{
    const channel = decode({ sxint: 0xa5, sxev1: 0x03 });
    // 0xA5 = enable, auto-deactivate, interval 5
    check('SxINT bit 7 is the channel', channel.enabled, true);
    check('SxINT bit 5 is auto-deactivate', channel.interval.enabled, true);
    check('SxINT bits 0-4 are the interval', channel.interval.value, 5);
    check('SxEV1 bit 0 is the envelope, not the channel', channel.envelope.enabled, true);
    check('SxEV1 bit 1 is the envelope repeat', channel.envelope.repeat, true);

    const flat = decode({ sxint: 0x80, sxev1: 0x00 });
    check('a channel with no envelope is still on', flat.enabled, true);
    check('and its envelope simply does not step', [flat.envelope.enabled, flat.envelope.initialValue],
        [false, 15]);

    // the level the panel meters, against the core's own formula:
    // (volume * envelope >> 3) + (volume && envelope), over its maximum
    check('full volume and a full envelope is full level', vsuChannelLevel(flat, 'left'), 1);
    check('and the same on the right', vsuChannelLevel(flat, 'right'), 1);
    const off = decode({ sxint: 0x00, sxev1: 0x00 });
    check('a channel that is off meters nothing', vsuChannelLevel(off, 'left'), 0);

    const registers = new DataView(new ArrayBuffer(VSU_CHANNEL_STRIDE * 6));
    registers.setUint8(VsuChannelRegister.SxINT, 0x80);
    registers.setUint8(VsuChannelRegister.SxLRV, 0xf0); // left only
    registers.setUint8(VsuChannelRegister.SxEV0, 0xf0);
    const panned = decodeVsuChannel(registers, 0);
    check('a channel panned hard left meters only there',
        [vsuChannelLevel(panned, 'left'), vsuChannelLevel(panned, 'right')], [1, 0]);

    registers.setUint8(VsuChannelRegister.SxEV0, 0x00); // envelope level 0
    const muted = decodeVsuChannel(registers, 0);
    check('a channel switched on with its envelope at zero is silent',
        vsuChannelLevel(muted, 'left'), 0);
    check('though it still reads as switched on', muted.enabled, true);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
