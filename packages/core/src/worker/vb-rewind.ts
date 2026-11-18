/**
 * Reverse delta codec for the rewind history. The 1.85 MiB state struct changes by about 0.2% per frame; encoding only
 * the changed runs is roughly 112x smaller on a real game (tests/rewind-cost-probe.mjs), turning a 128 MB budget from
 * barely a second of history into minutes. A delta turns the newer state into the older one, the direction rewind
 * walks, so stepping back is one XOR pass and needs no keyframes. The encoding is a series of runs:
 * [uint32 offset][uint32 length][length bytes].
 */

// changed words closer together than this stay in one run rather than paying another 8 byte header. Measured as the
// sweet spot on a real game
export const REWIND_RUN_GAP_WORDS = 4;

// scratch run boundaries, so encoding allocates only its result
export interface RunScratch {
    starts: Int32Array;
    ends: Int32Array;
}

export function createRunScratch(capacity = 1 << 16): RunScratch {
    return { starts: new Int32Array(capacity), ends: new Int32Array(capacity) };
}

// applying the result to `current` yields `previous`. Both must be the same length and a multiple of four bytes, as
// comparison runs a word at a time
export function encodeDelta(
    previous: Uint8Array,
    current: Uint8Array,
    scratch: RunScratch
): Uint8Array {
    const words = previous.length >> 2;
    const previousWords = new Uint32Array(previous.buffer, previous.byteOffset, words);
    const currentWords = new Uint32Array(current.buffer, current.byteOffset, words);
    const capacity = scratch.starts.length;

    let runs = 0;
    let start = -1;
    let last = -1;

    for (let i = 0; i < words; i++) {
        if (previousWords[i] === currentWords[i]) {
            continue;
        }
        if (start < 0) {
            start = i;
        } else if (i - last > REWIND_RUN_GAP_WORDS) {
            if (runs < capacity) {
                scratch.starts[runs] = start;
                scratch.ends[runs] = last;
                runs++;
                start = i;
            }
            // out of run slots: the open run keeps extending, storing some unchanged bytes; dropping the change would
            // corrupt the history
        }
        last = i;
    }

    if (start >= 0) {
        if (runs < capacity) {
            scratch.starts[runs] = start;
            scratch.ends[runs] = last;
            runs++;
        } else {
            scratch.ends[runs - 1] = last;
        }
    }

    let size = 0;
    for (let r = 0; r < runs; r++) {
        size += 8 + (scratch.ends[r] - scratch.starts[r] + 1) * 4;
    }

    const delta = new Uint8Array(size);
    const view = new DataView(delta.buffer);
    let offset = 0;
    for (let r = 0; r < runs; r++) {
        const from = scratch.starts[r] * 4;
        const length = (scratch.ends[r] - scratch.starts[r] + 1) * 4;
        view.setUint32(offset, from, true);
        view.setUint32(offset + 4, length, true);
        offset += 8;
        for (let i = 0; i < length; i++) {
            delta[offset + i] = previous[from + i] ^ current[from + i];
        }
        offset += length;
    }

    return delta;
}

// in place, walking the target back one capture
export function applyDelta(target: Uint8Array, delta: Uint8Array): void {
    const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength);
    let offset = 0;
    while (offset < delta.byteLength) {
        const from = view.getUint32(offset, true);
        const length = view.getUint32(offset + 4, true);
        offset += 8;
        for (let i = 0; i < length; i++) {
            target[from + i] ^= delta[offset + i];
        }
        offset += length;
    }
}

// emulated frames between two filmstrip thumbnails, one a second. A thumbnail costs about as much as two seconds of
// deltas, so taking one per capture would halve the history
export const REWIND_THUMBNAIL_FRAMES = 50;

// a presented frame at half size each way for the filmstrip, each pixel the average of a 2x2 block over the first
// `channels` (the eyes' brightness for legacy frames, RGB for VBC). `width` is the frame's own, so a VBC frame's two
// eyes stay apart, as the halves meet on an even column
export function shrinkFrame(pixels: Uint8Array, width: number, height: number, channels: number): Uint8Array {
    const halfWidth = width >> 1;
    const halfHeight = height >> 1;
    const shrunk = new Uint8Array(halfWidth * halfHeight * channels);
    const row = width * 4;
    let out = 0;
    for (let y = 0; y < halfHeight; y++) {
        let top = y * 2 * row;
        for (let x = 0; x < halfWidth; x++, top += 8) {
            const bottom = top + row;
            for (let c = 0; c < channels; c++) {
                shrunk[out++] = (pixels[top + c] + pixels[top + 4 + c]
                    + pixels[bottom + c] + pixels[bottom + 4 + c] + 2) >> 2;
            }
        }
    }
    return shrunk;
}

// shrinkFrame undone as far as it can be: each stored pixel back to a 2x2 block of opaque RGBA, unused channels zero
export function growFrame(
    shrunk: Uint8Array,
    width: number,
    height: number,
    channels: number,
    out: Uint8Array,
): void {
    const halfWidth = width >> 1;
    const halfHeight = height >> 1;
    const row = width * 4;
    out.fill(0);
    let source = 0;
    for (let y = 0; y < halfHeight; y++) {
        let top = y * 2 * row;
        for (let x = 0; x < halfWidth; x++, top += 8, source += channels) {
            const bottom = top + row;
            for (const at of [top, top + 4, bottom, bottom + 4]) {
                for (let c = 0; c < channels; c++) {
                    out[at + c] = shrunk[source + c];
                }
                out[at + 3] = 255;
            }
        }
    }
}
