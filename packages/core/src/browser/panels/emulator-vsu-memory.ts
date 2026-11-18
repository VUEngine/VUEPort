/**
 * The VSU's memory map and register decoders, all pure. Base addresses and block layout come from libgccvb's audio.h.
 * Its bit tables are hedged ("for the most part untested"), so the per-bit layout follows the encoder the studio ships
 * for these registers (SoundEditor/Other/templating.ts, SxINT/SxLRV/SxEV0/SxEV1/S5SWP), with its LSB-up packing order
 * reproduced as unpacking.
 *
 * "Channel is sounding" is SxINT bit 7, settled against the core (tests/vsu-decode-probe.mjs). SxEV1 bit 0 only says
 * whether the envelope steps: a channel with a flat envelope and that bit clear plays at full volume.
 */

// five waveform banks of 32 samples each. Like VIP VRAM the bus is wider than the 8-bit values, so only every
// fourth byte holds a sample
export const VSU_WAVEFORM_BASES = [0x01000000, 0x01000080, 0x01000100, 0x01000180, 0x01000200];
export const VSU_WAVEFORM_COUNT = VSU_WAVEFORM_BASES.length;
export const VSU_WAVEFORM_SAMPLES = 32;
export const VSU_WAVEFORM_SAMPLE_STRIDE = 4;
export const VSU_WAVEFORM_BYTES = VSU_WAVEFORM_SAMPLES * VSU_WAVEFORM_SAMPLE_STRIDE;

// modulation data: the channel in Modulation mode reads its frequency deltas from here. Same layout as a waveform bank
export const VSU_MODULATION_BASE = 0x01000280;
export const VSU_MODULATION_SAMPLES = 32;
export const VSU_MODULATION_BYTES = VSU_MODULATION_SAMPLES * VSU_WAVEFORM_SAMPLE_STRIDE;

export const VSU_REGISTER_BASE = 0x01000400;
export const VSU_CHANNEL_STRIDE = 0x40;
export const VSU_CHANNEL_COUNT = 6;
export const VSU_REGISTER_BLOCK_BYTES = VSU_CHANNEL_COUNT * VSU_CHANNEL_STRIDE;

// write-only: a write with bit 0 set silences every channel at once, by clearing the enable bits inside the core
// (where `enabled` is read from anyway), so there is nothing to display here
export const VSU_SSTOP = 0x01000580;

export function vsuChannelAddress(index: number): number {
    return VSU_REGISTER_BASE + index * VSU_CHANNEL_STRIDE;
}

// in bytes, from a channel's own base
export enum VsuChannelRegister {
    // channel enable (bit 7), auto-deactivate (bit 5), interval (bits 0-4)
    SxINT = 0x00,
    SxLRV = 0x04,
    SxFQL = 0x08,
    SxFQH = 0x0c,
    SxEV0 = 0x10,
    SxEV1 = 0x14,
    // waveform bank select. Channels 0-4 (every channel but Noise) only
    SxRAM = 0x18,
    // Sweep/Modulation control. Channel 4 (Sweep/Modulation) only
    S5SWP = 0x1c,
}

export enum VsuChannelKind {
    WAVE1 = 0,
    WAVE2 = 1,
    WAVE3 = 2,
    WAVE4 = 3,
    SWEEP = 4,
    NOISE = 5,
}

export const VSU_CHANNEL_NAMES: Record<VsuChannelKind, string> = {
    [VsuChannelKind.WAVE1]: 'Wave 1',
    [VsuChannelKind.WAVE2]: 'Wave 2',
    [VsuChannelKind.WAVE3]: 'Wave 3',
    [VsuChannelKind.WAVE4]: 'Wave 4',
    [VsuChannelKind.SWEEP]: 'Sw./Mod.',
    [VsuChannelKind.NOISE]: 'Noise',
};

export const VSU_CHANNEL_SHORT_NAMES: Record<VsuChannelKind, string> = {
    [VsuChannelKind.WAVE1]: 'Wave',
    [VsuChannelKind.WAVE2]: 'Wave',
    [VsuChannelKind.WAVE3]: 'Wave',
    [VsuChannelKind.WAVE4]: 'Wave',
    [VsuChannelKind.SWEEP]: 'Sweep',
    [VsuChannelKind.NOISE]: 'Noise',
};

export enum VsuEnvelopeDirection {
    DECAY = 0,
    GROW = 1,
}

export enum VsuSweepModulationFunction {
    SWEEP = 0,
    MODULATION = 1,
}

export enum VsuSweepDirection {
    DOWN = 0,
    UP = 1,
}

// ms per envelope step, indexed by SxEV0's three-bit step time
export const VSU_ENVELOPE_STEP_TIME_MS = [15.4, 30.7, 46.1, 61.4, 76.8, 92.2, 107.5, 122.9];

// ms per interval, indexed by SxINT's five-bit interval value
export const VSU_INTERVAL_DURATION_MS = [
    3.8, 7.7, 11.5, 15.4, 19.2, 23.0, 26.9, 30.7,
    34.6, 38.4, 42.2, 46.1, 49.9, 53.8, 57.6, 61.4,
    65.3, 69.1, 73.0, 76.8, 80.6, 84.5, 88.3, 92.2,
    96.0, 99.8, 103.7, 107.5, 111.4, 115.2, 119.0, 122.9,
];

// sweep/modulation interval durations in ms: the first seven for the slow clock (S5SWP's "frequency" bit clear),
// the next seven for the fast one, indexed by the three-bit interval field minus one (zero disables it)
export const VSU_SWEEP_MODULATION_INTERVAL_MS = [
    0.96, 1.92, 2.88, 3.84, 4.8, 5.76, 6.72,
    7.68, 15.36, 23.04, 30.72, 38.4, 46.08, 53.76,
];
const VSU_SWEEP_MODULATION_INTERVAL_MS_PER_CLOCK = VSU_SWEEP_MODULATION_INTERVAL_MS.length / 2;

// noise channel taps, indexed by SxEV1's three-bit tap select: [tap bit, LFSR period]
export const VSU_NOISE_TAP: ReadonlyArray<readonly [number, number]> = [
    [14, 32767],
    [10, 1953],
    [13, 254],
    [4, 217],
    [8, 73],
    [6, 63],
    [9, 42],
    [11, 28],
];

export interface VsuChannelInterval {
    enabled: boolean;
    // five-bit register value
    value: number;
    durationMs: number;
}

// SxEV0 for its shape, SxEV1's low two bits for whether it runs
export interface VsuChannelEnvelope {
    // SxEV1 bit 0: the level steps towards its end, else it stays at initialValue (how most drivers play fixed
    // volume). Not whether the channel sounds, that is VsuChannel.enabled
    enabled: boolean;
    // SxEV1 bit 1: on reaching its end the level reloads instead of stopping there
    repeat: boolean;
    direction: VsuEnvelopeDirection;
    // the level the channel is playing at, 0-15. Named for the register field that holds the level a note is loaded
    // with; this is the level the envelope has walked it to since (see readVsu in vb-protocol.ts)
    initialValue: number;
    // three-bit register value
    stepTime: number;
    stepMs: number;
}

// channel 4 (Sweep/Modulation) only
export interface VsuChannelSweepModulation {
    enabled: boolean;
    repeat: boolean;
    function: VsuSweepModulationFunction;
    direction: VsuSweepDirection;
    // three-bit register value, 0-7
    shift: number;
    // zero disables sweep/modulation outright, regardless of `enabled`
    interval: number;
    intervalMs: number;
}

// channel 5 (Noise) only
export interface VsuChannelNoise {
    // three-bit register value, 0-7
    tap: number;
    tapBit: number;
    period: number;
}

export interface VsuChannel {
    index: number;
    kind: VsuChannelKind;
    name: string;
    // SxINT bit 7, decoded from the core's own copy rather than the last value written (worker/vb-vsu-layout.ts), as
    // the hardware clears it when a channel with an interval runs out. Drivers write SxINT last, since it reloads the
    // interval and envelope counters
    enabled: boolean;
    // eleven-bit register value
    frequencyRaw: number;
    // what the channel is heard at: the note, for everything but Noise, which has none. See vsuFrequencyHz
    frequencyHz: number;
    // the rate the register sets: 32 samples of a waveform, or one noise generator step. Noise's frequencyHz is this
    stepRateHz: number;
    // four-bit register values, 0-15 each
    left: number;
    right: number;
    interval: VsuChannelInterval;
    envelope: VsuChannelEnvelope;
    // three-bit register value, 0-7; only banks 0-4 exist. Channels 0-4 only
    waveform?: number;
    sweepModulation?: VsuChannelSweepModulation;
    noise?: VsuChannelNoise;
    raw: {
        SxINT: number;
        SxLRV: number;
        SxFQL: number;
        SxFQH: number;
        SxEV0: number;
        SxEV1: number;
        SxRAM: number;
        S5SWP: number;
    };
}

// the rate the hardware steps a channel along at, 5,000,000 / (2048 - F) Hz. Not a pitch: a waveform channel's
// note is a thirty-second of it, for Noise it is the LFSR clock. F is eleven bits, so this saturates at F=2048
function vsuStepRateHz(raw: number): number {
    return raw >= 2048 ? 0 : 5000000 / (2048 - raw);
}

// what a channel is heard at, in Hz, measured against the core (tests/vsu-frequency-probe.mjs). The step rate reads
// as a note 32 times too high: a channel playing A4 said 14,080 Hz
function vsuFrequencyHz(raw: number, kind: VsuChannelKind): number {
    const rate = vsuStepRateHz(raw);
    return kind === VsuChannelKind.NOISE ? rate : rate / VSU_WAVEFORM_SAMPLES;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const CONCERT_A_HZ = 440;
const CONCERT_A_MIDI = 69;
const SEMITONES_PER_OCTAVE = 12;
const CENTS_PER_SEMITONE = 100;

export interface VsuNote {
    // the note and its octave, written the way a tracker writes it: `A#4`
    name: string;
    // -50 to 50 cents from that note
    cents: number;
    midi: number;
}

// the note a frequency is, or undefined. Equal temperament against concert A; the cents are kept as they are the
// interesting half while a channel sweeps: the note holds still and the error walks
export function vsuNoteOf(hz: number): VsuNote | undefined {
    if (!Number.isFinite(hz) || hz <= 0) {
        return undefined;
    }
    const exact = CONCERT_A_MIDI
        + SEMITONES_PER_OCTAVE * Math.log2(hz / CONCERT_A_HZ);
    const midi = Math.round(exact);
    if (midi < 0) {
        return undefined;
    }
    // floor rather than a remainder: the note index has to stay 0-11 below C0, where `exact` goes negative
    const note = ((midi % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;
    const octave = Math.floor(midi / SEMITONES_PER_OCTAVE) - 1;
    return {
        name: `${NOTE_NAMES[note]}${octave}`,
        cents: Math.round((exact - midi) * CENTS_PER_SEMITONE),
        midi,
    };
}

export function vsuNoteName(hz: number): string | undefined {
    return vsuNoteOf(hz)?.name;
}

// one channel's registers out of the full register block (VSU_REGISTER_BASE, VSU_REGISTER_BLOCK_BYTES)
export function decodeVsuChannel(view: DataView, index: number): VsuChannel {
    const base = index * VSU_CHANNEL_STRIDE;
    const at = (offset: number): number => view.getUint8(base + offset);
    const kind = index as VsuChannelKind;

    const sxint = at(VsuChannelRegister.SxINT);
    const sxlrv = at(VsuChannelRegister.SxLRV);
    const sxfql = at(VsuChannelRegister.SxFQL);
    const sxfqh = at(VsuChannelRegister.SxFQH);
    const sxev0 = at(VsuChannelRegister.SxEV0);
    const sxev1 = at(VsuChannelRegister.SxEV1);
    const sxram = at(VsuChannelRegister.SxRAM);
    const s5swp = at(VsuChannelRegister.S5SWP);

    const frequencyRaw = ((sxfqh & 0x07) << 8) | sxfql;
    const intervalValue = sxint & 0x1f;
    const stepTime = sxev0 & 0x07;

    const channel: VsuChannel = {
        index,
        kind,
        name: VSU_CHANNEL_NAMES[kind],
        enabled: (sxint & 0x80) !== 0,
        frequencyRaw,
        frequencyHz: vsuFrequencyHz(frequencyRaw, kind),
        stepRateHz: vsuStepRateHz(frequencyRaw),
        left: (sxlrv >> 4) & 0x0f,
        right: sxlrv & 0x0f,
        interval: {
            enabled: (sxint & 0x20) !== 0,
            value: intervalValue,
            durationMs: VSU_INTERVAL_DURATION_MS[intervalValue],
        },
        envelope: {
            enabled: (sxev1 & 0x01) !== 0,
            repeat: (sxev1 & 0x02) !== 0,
            direction: ((sxev0 >> 3) & 0x01) as VsuEnvelopeDirection,
            initialValue: (sxev0 >> 4) & 0x0f,
            stepTime,
            stepMs: VSU_ENVELOPE_STEP_TIME_MS[stepTime],
        },
        raw: { SxINT: sxint, SxLRV: sxlrv, SxFQL: sxfql, SxFQH: sxfqh, SxEV0: sxev0, SxEV1: sxev1, SxRAM: sxram, S5SWP: s5swp },
    };

    if (kind === VsuChannelKind.NOISE) {
        const tap = (sxev1 >> 4) & 0x07;
        const [tapBit, period] = VSU_NOISE_TAP[tap];
        channel.noise = { tap, tapBit, period };
    } else {
        channel.waveform = sxram & 0x07;
        if (kind === VsuChannelKind.SWEEP) {
            const clock = (s5swp >> 7) & 0x01;
            const interval = (s5swp >> 4) & 0x07;
            channel.sweepModulation = {
                enabled: ((sxev1 >> 6) & 0x01) !== 0,
                repeat: ((sxev1 >> 5) & 0x01) !== 0,
                function: ((sxev1 >> 4) & 0x01) as VsuSweepModulationFunction,
                direction: ((s5swp >> 3) & 0x01) as VsuSweepDirection,
                shift: s5swp & 0x07,
                interval,
                intervalMs: interval === 0
                    ? 0
                    : VSU_SWEEP_MODULATION_INTERVAL_MS[clock * VSU_SWEEP_MODULATION_INTERVAL_MS_PER_CLOCK + interval - 1],
            };
        }
    }

    return channel;
}

// one side of a channel, 0 to 1, from the core's own level `(volume * envelope >> 3) + (volume && envelope)`
// normalized: what is being played, not what the note started at. Zero volume or envelope on a side is silent
export function vsuChannelLevel(channel: VsuChannel, side: 'left' | 'right'): number {
    if (!channel.enabled) {
        return 0;
    }
    const volume = channel[side];
    const envelope = channel.envelope.initialValue;
    const level = ((volume * envelope) >> 3) + (volume !== 0 && envelope !== 0 ? 1 : 0);
    return level / (((15 * 15) >> 3) + 1);
}

// every fourth byte holds a sample; six-bit unsigned (0-63)
export function vsuWaveformSamples(bytes: Uint8Array): number[] {
    const samples: number[] = [];
    for (let i = 0; i < VSU_WAVEFORM_SAMPLES && i * VSU_WAVEFORM_SAMPLE_STRIDE < bytes.length; i++) {
        samples.push(bytes[i * VSU_WAVEFORM_SAMPLE_STRIDE] & 0x3f);
    }
    return samples;
}

// same layout as a waveform bank, but eight-bit two's complement: the channel in Modulation mode adds one to its
// frequency at every modulation interval, so half of them pull the pitch down
export function vsuModulationSamples(bytes: Uint8Array): number[] {
    const samples: number[] = [];
    for (let i = 0; i < VSU_MODULATION_SAMPLES && i * VSU_WAVEFORM_SAMPLE_STRIDE < bytes.length; i++) {
        samples.push((bytes[i * VSU_WAVEFORM_SAMPLE_STRIDE] << 24) >> 24);
    }
    return samples;
}

export function vsuSamplesEqual(a: number[] | undefined, b: number[] | undefined): boolean {
    if (a === undefined || b === undefined) {
        return a === b;
    }
    return a.length === b.length && a.every((sample, index) => sample === b[index]);
}
