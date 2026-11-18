/**
 * Where the core keeps the VSU's state, read back as the register map the VSU panel expects. Real hardware cannot read
 * VSU registers back and neither can this core (vbRead returns zero, see tests/vsu-state-probe.mjs). A shadow of CPU
 * writes would know nothing when opened mid-game and never see a channel switch itself off when its interval elapses.
 * But the simulation is one flat struct (what a save state copies, see the worker's snapshot) into which the core
 * decodes each register as written, so this locates those bytes once and reads them on every poll.
 *
 * The offsets are found, not hard-coded, as wasm/shrooms/build-vbc.mjs replaces wasm/shrooms/core.wasm wholesale: on a
 * throwaway simulation, write a register and see which byte moves. The loaded and current envelope level, and the
 * given and playing frequency, are told apart by running the machine, where only the live one moves. Calibration
 * throws rather than guesses, as a wrong offset would show unrelated bytes with confidence.
 */
import {
    VB_VSU_BASE,
    VB_VSU_CHANNELS,
    VB_VSU_CHANNEL_STRIDE,
    VB_VSU_MAP_BYTES,
    VB_VSU_REGISTERS,
    VbDataType,
} from '../common/vb-constants';
import { WasmExports } from './vb-wasm';

// the VSU-side map this composes into, as offsets from VB_VSU_BASE. Documented and sourced in
// browser/panels/emulator-vsu-memory.ts; these are the few numbers the worker needs to write it
const WAVEFORM_BANKS = 5;
const WAVEFORM_SAMPLES = 32;
const WAVEFORM_SAMPLE_STRIDE = 4; // the VSU's bus is wider than the samples it stores: only every fourth byte is one
const WAVEFORM_BANK_STRIDE = 0x80;
const MODULATION_OFFSET = 0x280;

// register offsets from a channel's own base, VSU-side
const SxINT = 0x00;
const SxLRV = 0x04;
const SxFQL = 0x08;
const SxFQH = 0x0c;
const SxEV0 = 0x10;
const SxEV1 = 0x14;
const SxRAM = 0x18;
const S5SWP = 0x1c;

const SWEEP_CHANNEL = 4; // the only channel with sweep and modulation, and the only one without a waveform
const NOISE_CHANNEL = 5;

// how much of the struct to compare around the first hit. Generous, as channel records, sweep and noise blocks,
// modulation table and waveform banks all sit within a few hundred bytes of each other
const WINDOW_BEFORE = 0x1000;
const WINDOW_AFTER = 0x2000;

const SETTLE_CLOCKS = 1_000_000; // clocks to run while telling a live byte from the value it was loaded from
const SETTLE_SAMPLES = 834; // the core wants the sample buffer pointed at something before it will run

// the core's own decoded copy of each register field, as offsets from the start of the simulation struct
export interface VsuChannelOffsets {
    on: number; // SxINT bit 7 as the hardware holds it: it clears this itself when an interval elapses
    autoDeactivate: number; // SxINT bit 5
    interval: number; // SxINT bits 0-4
    left: number;
    right: number;
    frequency: number; // eleven bits over two bytes, as being played: sweep and modulation move it
    level: number; // the level now, which the envelope walks up or down
    envelopeGrows: number; // SxEV0 bit 3
    envelopeStep: number; // SxEV0 bits 0-2
    envelopeOn: number; // SxEV1 bit 0
    envelopeRepeats: number; // SxEV1 bit 1
    waveform?: number; // SxRAM. Absent on Noise, which plays no waveform
}

// sweep/modulation, which only the fifth channel has
export interface VsuSweepOffsets {
    clock: number; // S5SWP bit 7
    up: number; // S5SWP bit 3
    interval: number; // S5SWP bits 4-6
    shift: number; // S5SWP bits 0-2
    on: number; // SxEV1 bit 6
    repeats: number; // SxEV1 bit 5
    modulates: number; // SxEV1 bit 4
}

export interface VsuLayout {
    channels: VsuChannelOffsets[];
    sweep: VsuSweepOffsets;
    noiseTap: number; // SxEV1 bits 4-6 on the Noise channel
    waveforms: number; // the first of five banks of WAVEFORM_SAMPLES bytes, one byte per sample
    modulation: number; // WAVEFORM_SAMPLES bytes, one per modulation step
}

function hex(value: number): string {
    return `0x${value.toString(16)}`;
}

function channelRegister(channel: number, register: number): number {
    return VB_VSU_REGISTERS + channel * VB_VSU_CHANNEL_STRIDE + register;
}

// throws, with what it was looking for, if the core keeps its state anywhere this cannot recognize
export function calibrateVsuLayout(wasm: WasmExports): VsuLayout {
    const sim = wasm.CreateSim();
    if (sim === 0) {
        throw new Error('Could not create a simulation to find the VSU in.');
    }
    try {
        return calibrate(wasm, sim);
    } finally {
        // the vendored shim's delete is a stub; freeing the struct is ours to do, as in Worker#deleteSim
        wasm.Realloc(sim, 0);
    }
}

function calibrate(wasm: WasmExports, sim: number): VsuLayout {
    wasm.vbReset(sim);
    const size = wasm.vbSizeOf();
    const struct = (): Uint8Array => new Uint8Array(wasm.memory.buffer, sim, size);
    const write = (address: number, value: number): void =>
        wasm.vbWrite(sim, address, VbDataType.U8, value);

    // one register write and one whole comparison to find where to look; the struct is megabytes, the VSU a few hundred
    // bytes of it
    const before = struct().slice();
    write(channelRegister(0, SxINT), 0x80);
    const after = struct();
    let first = -1;
    let last = -1;
    for (let i = 0; i < size; i++) {
        if (before[i] !== after[i]) {
            if (first < 0) {
                first = i;
            }
            last = i;
        }
    }
    if (first < 0) {
        throw new Error('This core keeps no VSU state that writing to it changes.');
    }
    const start = Math.max(0, first - WINDOW_BEFORE);
    const end = Math.min(size, last + WINDOW_AFTER);

    // write each value in turn, keeping the window as it stood after each
    const observe = (address: number, values: number[]): Uint8Array[] =>
        values.map(value => {
            write(address, value);
            return struct().slice(start, end);
        });

    // the same for writes to several registers: writing a different register mid-sequence moves a byte that was only
    // coming along for the ride, separating two bytes a register's own values cannot
    const observeWrites = (writes: [number, number][]): Uint8Array[] =>
        writes.map(([address, value]) => {
            write(address, value);
            return struct().slice(start, end);
        });

    // every byte of the window that read `expected[i]` after the i-th write. `expected` needs at least two different
    // values, or every untouched byte would answer
    const candidates = (seen: Uint8Array[], expected: number[]): number[] => {
        const found: number[] = [];
        for (let offset = 0; offset < seen[0].length; offset++) {
            if (expected.every((value, index) => seen[index][offset] === value)) {
                found.push(start + offset);
            }
        }
        return found;
    };
    // the single byte that answers to a sequence, or a refusal to guess
    const resolve = (seen: Uint8Array[], expected: number[], what: string): number => {
        const found = candidates(seen, expected);
        if (found.length !== 1) {
            // list the candidates, as the only way to see where a changed core keeps things is to look at the bytes
            // it offered
            throw new Error(
                `Could not tell which byte of this core holds ${what} `
                + `(${found.length} candidates`
                + `${found.length === 0 ? '' : ': ' + found.map(hex).join(', ')}).`,
            );
        }
        return found[0];
    };

    // six channel records; every sequence toggles rather than only rising, so a latching byte cannot answer
    const channels: VsuChannelOffsets[] = [];
    const frequencies: number[][] = []; // both copies of the frequency, in struct order
    const levels: number[][] = []; // both copies of the envelope level, likewise

    for (let channel = 0; channel < VB_VSU_CHANNELS; channel++) {
        const where = (register: number): number => channelRegister(channel, register);
        const name = `channel ${channel}`;

        const int = observe(where(SxINT), [0x00, 0xa7, 0x00, 0x93]);
        const on = resolve(int, [0, 1, 0, 1], `${name}'s enable bit`);
        const autoDeactivate = resolve(int, [0, 1, 0, 0], `${name}'s auto-deactivate bit`);
        const interval = resolve(int, [0, 0x07, 0, 0x13], `${name}'s interval`);

        const lrv = observe(where(SxLRV), [0x00, 0x9c, 0xc9]);
        const left = resolve(lrv, [0, 0x9, 0xc], `${name}'s left level`);
        const right = resolve(lrv, [0, 0xc, 0x9], `${name}'s right level`);

        // the low byte of both frequency copies; each high byte sits beside its own low byte, checked below
        const low = candidates(
            observe(where(SxFQL), [0x00, 0x34, 0x00, 0x5a]), [0, 0x34, 0, 0x5a]);
        const high = candidates(
            observe(where(SxFQH), [0x00, 0x05, 0x00, 0x03]), [0, 0x05, 0, 0x03]);
        const pairs = low.filter(offset => high.includes(offset + 1));
        if (pairs.length !== 2) {
            throw new Error(
                `Expected this core to keep two copies of ${name}'s frequency, found ${pairs.length}.`,
            );
        }
        frequencies.push(pairs);

        const ev0 = observe(where(SxEV0), [0x00, 0xd3, 0x08, 0x64]);
        const envelopeStep = resolve(ev0, [0, 0x3, 0, 0x4], `${name}'s envelope step`);
        const envelopeGrows = resolve(ev0, [0, 0, 1, 0], `${name}'s envelope direction`);
        const level = candidates(ev0, [0, 0xd, 0, 0x6]);
        if (level.length !== 2) {
            throw new Error(
                `Expected this core to keep two copies of ${name}'s envelope level, found ${level.length}.`,
            );
        }
        levels.push(level);

        const ev1 = observe(where(SxEV1), [0x00, 0x01, 0x02, 0x03]);
        const envelopeOn = resolve(ev1, [0, 1, 0, 1], `${name}'s envelope switch`);
        const envelopeRepeats = resolve(ev1, [0, 0, 1, 1], `${name}'s envelope repeat`);

        const offsets: VsuChannelOffsets = {
            on,
            autoDeactivate,
            interval,
            left,
            right,
            frequency: pairs[0], // replaced below, once running the machine has said which copy is being played
            level: level[0],
            envelopeGrows,
            envelopeStep,
            envelopeOn,
            envelopeRepeats,
        };
        if (channel !== NOISE_CHANNEL) {
            offsets.waveform = resolve(
                observe(where(SxRAM), [0x00, 0x03, 0x00, 0x05]), [0, 3, 0, 5],
                `${name}'s waveform bank`);
        }
        channels.push(offsets);
    }

    const swp = observe(channelRegister(SWEEP_CHANNEL, S5SWP), [0x00, 0xb5, 0x08, 0x42]);
    /**
     * The other three sweep fields are in SxEV1's top bits, where the other channels keep nothing. Two of the writes are
     * not about those bits but keep two other bytes from answering the same sequence: the interval goes back to zero
     * first, as the core also keeps a flag set only while the switch and an interval are both there, and an envelope is
     * loaded in the middle, as a byte of the envelope state otherwise rises and falls with these writes.
     */
    const swpEv1Register = channelRegister(SWEEP_CHANNEL, SxEV1);
    const swpEv1 = observeWrites([
        [channelRegister(SWEEP_CHANNEL, S5SWP), 0x00],
        [swpEv1Register, 0x00],
        [swpEv1Register, 0x40],
        [channelRegister(SWEEP_CHANNEL, SxEV0), 0xd3],
        [swpEv1Register, 0x10],
        [swpEv1Register, 0x20],
        [swpEv1Register, 0x40],
    ]);
    const sweep: VsuSweepOffsets = {
        clock: resolve(swp, [0, 1, 0, 0], 'the sweep clock'),
        up: resolve(swp, [0, 0, 1, 0], 'the sweep direction'),
        interval: resolve(swp, [0, 0x3, 0, 0x4], 'the sweep interval'),
        shift: resolve(swp, [0, 0x5, 0, 0x2], 'the sweep shift'),
        modulates: resolve(swpEv1, [0, 0, 0, 0, 1, 0, 0], 'the modulation function'),
        repeats: resolve(swpEv1, [0, 0, 0, 0, 0, 1, 0], 'the sweep repeat'),
        on: resolve(swpEv1, [0, 0, 1, 1, 0, 0, 1], 'the sweep switch'),
    };
    const noiseTap = resolve(
        observe(channelRegister(NOISE_CHANNEL, SxEV1), [0x00, 0x30, 0x50, 0x70]),
        [0, 3, 5, 7], 'the noise tap');

    // waveform banks and modulation table: found by their first sample, then checked whole, so a bank not laid out one
    // byte per sample is caught here rather than drawn as a sparkline of somebody else's memory
    const waveforms = resolve(
        observe(VB_VSU_BASE, [0x00, 0x2a, 0x00, 0x15]), [0, 0x2a, 0, 0x15],
        'the first waveform sample');
    const modulation = resolve(
        observe(VB_VSU_BASE + MODULATION_OFFSET, [0x00, 0x39, 0x00, 0x1e]), [0, 0x39, 0, 0x1e],
        'the first modulation step');
    verifyTable(wasm, sim, struct, VB_VSU_BASE, waveforms, WAVEFORM_BANKS, 'waveform banks');
    verifyTable(wasm, sim, struct, VB_VSU_BASE + MODULATION_OFFSET, modulation, 1, 'the modulation table');

    // which copy is the one being played
    settle(wasm, sim, channels, frequencies, levels);

    return { channels, sweep, noiseTap, waveforms, modulation };
}

// write every sample of a table and read them back where expected, so a core keeping them otherwise fails here
function verifyTable(
    wasm: WasmExports,
    sim: number,
    struct: () => Uint8Array,
    vsuBase: number,
    structBase: number,
    banks: number,
    what: string,
): void {
    for (let bank = 0; bank < banks; bank++) {
        for (let sample = 0; sample < WAVEFORM_SAMPLES; sample++) {
            wasm.vbWrite(
                sim,
                vsuBase + bank * WAVEFORM_BANK_STRIDE + sample * WAVEFORM_SAMPLE_STRIDE,
                VbDataType.U8,
                (bank * WAVEFORM_SAMPLES + sample) & 0x3f,
            );
        }
    }
    const bytes = struct();
    for (let bank = 0; bank < banks; bank++) {
        for (let sample = 0; sample < WAVEFORM_SAMPLES; sample++) {
            const expected = (bank * WAVEFORM_SAMPLES + sample) & 0x3f;
            if (bytes[structBase + bank * WAVEFORM_SAMPLES + sample] !== expected) {
                throw new Error(`This core does not keep ${what} one byte per sample.`);
            }
        }
    }
}

// give every channel a falling envelope and the fifth a sweep, and run: the current level falls, the loaded one does
// not; the playing frequency slides, the given one does not. Only the fifth channel can sweep, so the choice measured
// there holds for the other five
function settle(
    wasm: WasmExports,
    sim: number,
    channels: VsuChannelOffsets[],
    frequencies: number[][],
    levels: number[][],
): void {
    for (let channel = 0; channel < VB_VSU_CHANNELS; channel++) {
        const where = (register: number): number => channelRegister(channel, register);
        wasm.vbWrite(sim, where(SxLRV), VbDataType.U8, 0xff);
        wasm.vbWrite(sim, where(SxFQL), VbDataType.U8, 0x00);
        wasm.vbWrite(sim, where(SxFQH), VbDataType.U8, 0x04);
        // full level, walking down, as fast as the envelope goes
        wasm.vbWrite(sim, where(SxEV0), VbDataType.U8, 0xf0);
        wasm.vbWrite(sim, where(SxEV1), VbDataType.U8, 0x01);
        if (channel === SWEEP_CHANNEL) {
            // sweep down, fast clock, every interval, switched on
            wasm.vbWrite(sim, where(S5SWP), VbDataType.U8, 0x91);
            wasm.vbWrite(sim, where(SxEV1), VbDataType.U8, 0x41);
        }
        wasm.vbWrite(sim, where(SxINT), VbDataType.U8, 0x80);
    }

    const beforeRun = new Uint8Array(wasm.memory.buffer, sim, wasm.vbSizeOf()).slice();
    run(wasm, sim);
    const afterRun = new Uint8Array(wasm.memory.buffer, sim, wasm.vbSizeOf());
    const moved = (offset: number): boolean => beforeRun[offset] !== afterRun[offset];

    const sweeping = frequencies[SWEEP_CHANNEL];
    const live = sweeping.findIndex(offset => moved(offset));
    if (live < 0 || sweeping.filter(offset => moved(offset)).length !== 1) {
        throw new Error('Could not tell which frequency this core plays a swept channel at.');
    }
    for (let channel = 0; channel < VB_VSU_CHANNELS; channel++) {
        channels[channel].frequency = frequencies[channel][live];

        const falling = levels[channel].filter(offset => moved(offset));
        if (falling.length !== 1) {
            throw new Error(
                `Could not tell which byte holds channel ${channel}'s envelope while it runs.`,
            );
        }
        channels[channel].level = falling[0];
    }
}

// run the machine briefly, as Worker#drive does
function run(wasm: WasmExports, sim: number): void {
    const sims = wasm.Realloc(0, 4);
    const clocks = wasm.Realloc(0, 4);
    try {
        new Uint32Array(wasm.memory.buffer, sims, 1)[0] = sim;
        wasm.vbSetSamples(sim, wasm.GetExtSamples(sim), VbDataType.F32, SETTLE_SAMPLES);
        new Uint32Array(wasm.memory.buffer, clocks, 1)[0] = SETTLE_CLOCKS;
        // Emulate returns early on a break condition, and a simulation without a cartridge raises plenty; the guard
        // stops a spin if one never clears
        let guard = 0;
        while (new Uint32Array(wasm.memory.buffer, clocks, 1)[0] !== 0 && guard++ < 1000) {
            wasm.Emulate(sims, 1, clocks);
        }
    } finally {
        wasm.Realloc(sims, 0);
        wasm.Realloc(clocks, 0);
    }
}

// which channels the emulator holds silent, and what the game last asked them to play at
export interface VsuMuteState {
    channels: number; // bit `n` for channel `n`
    levels: Uint8Array; // two bytes per channel, left then right, meaningful only for a muted channel
}

export function createVsuMuteState(): VsuMuteState {
    return { channels: 0, levels: new Uint8Array(VB_VSU_CHANNELS * 2) };
}

/**
 * Holds muted channels at zero for levels that did not arrive as a CPU write (takeVsuLevelWrite handles those): the
 * moment a channel is muted, and a restored or rewound state. Muting the stereo level rather than the enable bit keeps
 * a muted channel playing, stepping its envelope and switching itself off as if audible; only nothing comes out. The
 * level it takes away is kept for the strip, but only when nonzero, as its own zero cannot be told from one the
 * machine holds.
 */
export function applyVsuMutes(
    wasm: WasmExports, layout: VsuLayout, sim: number, muted: VsuMuteState): void {
    if (muted.channels === 0) {
        return;
    }
    const struct = new Uint8Array(wasm.memory.buffer, sim, wasm.vbSizeOf());
    for (let channel = 0; channel < VB_VSU_CHANNELS; channel++) {
        if ((muted.channels & (1 << channel)) === 0) {
            continue;
        }
        const at = layout.channels[channel];
        const left = struct[at.left] & 0x0f;
        const right = struct[at.right] & 0x0f;
        if ((left | right) !== 0) {
            muted.levels[channel * 2] = left;
            muted.levels[channel * 2 + 1] = right;
        }
        struct[at.left] = 0;
        struct[at.right] = 0;
    }
}

// SxLRV only: the one register saying how loud a channel is on each side; holding it at zero is a mute.
// See takeVsuLevelWrite
export function vsuLevelWriteChannel(address: number): number {
    const offset = (address >>> 0) - VB_VSU_REGISTERS;
    if (offset < 0 || offset >= VB_VSU_CHANNELS * VB_VSU_CHANNEL_STRIDE) {
        return -1;
    }
    return offset % VB_VSU_CHANNEL_STRIDE === SxLRV
        ? Math.floor(offset / VB_VSU_CHANNEL_STRIDE)
        : -1;
}

// where muting actually happens: a sound driver rewrites SxLRV every tick (envelopes, fades, panning), so zeroing it
// between frames is not enough; catching the write silences it from the instruction on. The game's level, a zero
// included, is kept for the panel and for unmuting
export function takeVsuLevelWrite(muted: VsuMuteState, channel: number, value: number): boolean {
    if ((muted.channels & (1 << channel)) === 0) {
        return false;
    }
    muted.levels[channel * 2] = (value >> 4) & 0x0f;
    muted.levels[channel * 2 + 1] = value & 0x0f;
    return true;
}

// muting zeroes the core's own stereo level, and games do not rewrite it (SxLRV is set when a voice is set up, a
// restart via SxINT keeps it), so unmuting puts it back. Only where the mute's zero is still there, as a game's own
// newer write wins
export function restoreVsuMutes(
    wasm: WasmExports, layout: VsuLayout, sim: number, muted: VsuMuteState, released: number): void {
    if (released === 0) {
        return;
    }
    const struct = new Uint8Array(wasm.memory.buffer, sim, wasm.vbSizeOf());
    for (let channel = 0; channel < VB_VSU_CHANNELS; channel++) {
        if ((released & (1 << channel)) === 0) {
            continue;
        }
        const at = layout.channels[channel];
        if (((struct[at.left] | struct[at.right]) & 0x0f) === 0) {
            struct[at.left] = muted.levels[channel * 2];
            struct[at.right] = muted.levels[channel * 2 + 1];
        }
    }
}

// composed rather than copied, as the core keeps decoded fields, not registers. Where it holds both what a channel was
// given and what it is doing, the present state goes in; the two only differ during an envelope or sweep
export function composeVsuMap(
    wasm: WasmExports, layout: VsuLayout, sim: number,
    muted: VsuMuteState | undefined = undefined): Uint8Array<ArrayBuffer> {
    // re-made on every call: a view over a heap that has since grown reads nothing
    const struct = new Uint8Array(wasm.memory.buffer, sim, wasm.vbSizeOf());
    const map = new Uint8Array(VB_VSU_MAP_BYTES);
    const bit = (offset: number, mask: number): number => (struct[offset] !== 0 ? mask : 0);

    for (let channel = 0; channel < VB_VSU_CHANNELS; channel++) {
        const at = layout.channels[channel];
        const block = VB_VSU_REGISTERS - VB_VSU_BASE + channel * VB_VSU_CHANNEL_STRIDE;

        map[block + SxINT] = bit(at.on, 0x80) | bit(at.autoDeactivate, 0x20)
            | (struct[at.interval] & 0x1f);
        // a muted channel plays at zero because the mixer put it there, so what it was given is shown; see
        // applyVsuMutes
        const held = muted && (muted.channels & (1 << channel)) !== 0;
        map[block + SxLRV] = held
            ? ((muted!.levels[channel * 2] & 0x0f) << 4) | (muted!.levels[channel * 2 + 1] & 0x0f)
            : ((struct[at.left] & 0x0f) << 4) | (struct[at.right] & 0x0f);
        map[block + SxFQL] = struct[at.frequency];
        map[block + SxFQH] = struct[at.frequency + 1] & 0x07;
        map[block + SxEV0] = ((struct[at.level] & 0x0f) << 4)
            | bit(at.envelopeGrows, 0x08) | (struct[at.envelopeStep] & 0x07);

        let ev1 = bit(at.envelopeOn, 0x01) | bit(at.envelopeRepeats, 0x02);
        if (channel === SWEEP_CHANNEL) {
            ev1 |= bit(layout.sweep.modulates, 0x10) | bit(layout.sweep.repeats, 0x20)
                | bit(layout.sweep.on, 0x40);
            map[block + S5SWP] = bit(layout.sweep.clock, 0x80)
                | ((struct[layout.sweep.interval] & 0x07) << 4)
                | bit(layout.sweep.up, 0x08)
                | (struct[layout.sweep.shift] & 0x07);
        }
        if (channel === NOISE_CHANNEL) {
            ev1 |= (struct[layout.noiseTap] & 0x07) << 4;
        }
        map[block + SxEV1] = ev1;

        if (at.waveform !== undefined) {
            map[block + SxRAM] = struct[at.waveform] & 0x07;
        }
    }

    for (let bank = 0; bank < WAVEFORM_BANKS; bank++) {
        for (let sample = 0; sample < WAVEFORM_SAMPLES; sample++) {
            map[bank * WAVEFORM_BANK_STRIDE + sample * WAVEFORM_SAMPLE_STRIDE] =
                struct[layout.waveforms + bank * WAVEFORM_SAMPLES + sample] & 0x3f;
        }
    }
    for (let sample = 0; sample < WAVEFORM_SAMPLES; sample++) {
        map[MODULATION_OFFSET + sample * WAVEFORM_SAMPLE_STRIDE] =
            struct[layout.modulation + sample];
    }

    return map;
}
