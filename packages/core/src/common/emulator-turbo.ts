// turbo is counted in emulated frames, not wall time, so it is the same at any speed and in both windows of
// a linked pair: pressed for `rate` frames, released for `rate` frames, depending only on the frame number

export const DEFAULT_TURBO_RATE = 2; // frames per half period, about 12.5 presses a second

export const TURBO_RATE_RANGE = { min: 1, max: 8 }; // rates the settings offer, in frames per half period

export function clampTurboRate(rate: number): number {
    if (!Number.isFinite(rate)) {
        return DEFAULT_TURBO_RATE;
    }
    return Math.min(TURBO_RATE_RANGE.max, Math.max(TURBO_RATE_RANGE.min, Math.round(rate)));
}

// down for the first half of every period, so a turbo press starting on a period boundary reaches the game at once
export function turboPressedOn(frame: number, rate: number): boolean {
    return Math.floor(frame / clampTurboRate(rate)) % 2 === 0;
}

export function withTurbo(keys: number, turboKeys: number, frame: number, rate: number): number {
    return turboKeys !== 0 && turboPressedOn(frame, rate) ? (keys | turboKeys) >>> 0 : keys;
}
