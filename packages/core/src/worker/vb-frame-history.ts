/**
 * The frames before the current one, for a screenshot that blends. The live renderer keeps them as textures nothing
 * else can read, so a screenshot drawn by a second renderer gets them from here: the one before for full blending, the
 * two before that as well for smart. Follows the renderer's rules for what counts as the frame before (see FrameKind).
 * Four buffers take turns; a present costs one copy of a 344 KB frame.
 */

import { Frame, FrameKind } from '../common/vb-protocol';
import {
    FrameBlending,
    VB_SCREEN_HEIGHT,
    VB_SCREEN_WIDTH,
    VBC_FRAME_BYTES,
    vbFrameBytes,
} from '../common/vb-constants';

const FRAME_BYTES = VBC_FRAME_BYTES; // room for the larger of the two transports, a legacy frame uses the first part

const MASK_REACH = 2; // how far flicker reaches into the pixels around it, the renderer's MASK_REACH

const MASK_BLOCK = 8; // the cells flicker is also counted in, and how much of one must flicker, as in the renderer
const MASK_BLOCK_SHARE = (MASK_BLOCK * MASK_BLOCK) / 2;
const MASK_BLOCKS_X = VB_SCREEN_WIDTH / MASK_BLOCK;
const MASK_BLOCKS_Y = VB_SCREEN_HEIGHT / MASK_BLOCK;

const PIXELS = VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT;

// two 8-bit sRGB values mixed half and half in linear light, indexed by a << 8 | b. The renderer's blend,
// done once per pair rather than per pixel; built on first use
let halfMix: Uint8Array | undefined;

function mixTable(): Uint8Array {
    if (!halfMix) {
        const linear = new Float64Array(256);
        for (let i = 0; i < 256; i++) {
            const c = i / 255;
            linear[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }
        halfMix = new Uint8Array(256 * 256);
        for (let a = 0; a < 256; a++) {
            for (let b = 0; b < 256; b++) {
                const l = (linear[a] + linear[b]) / 2;
                const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
                halfMix[(a << 8) | b] = Math.round(Math.min(1, Math.max(0, c)) * 255);
            }
        }
    }
    return halfMix;
}

// valid until the next record
export interface HeldFrame {
    pixels: Uint8Array;
    colorMode: boolean;
}

export class FrameHistory {
    protected current = new Uint8Array(FRAME_BYTES);
    protected before = new Uint8Array(FRAME_BYTES);
    protected earlier = new Uint8Array(FRAME_BYTES);
    protected earliest = new Uint8Array(FRAME_BYTES);
    protected currentColorMode = false;
    protected beforeColorMode = false;
    protected earlierColorMode = false;
    protected earliestColorMode = false;
    protected hasCurrent = false;
    protected hasBefore = false;
    protected hasEarlier = false;
    protected hasEarliest = false;
    protected blended = new Uint8Array(FRAME_BYTES); // the current frame as blending shows it, see blendedCurrent
    // per pixel, bit 0 where the left eye's picture flickers, bit 1 the right's
    protected flicker = new Uint8Array(PIXELS);
    protected flickerSpread = new Uint8Array(PIXELS);
    // per cell, the same bits where most of it flickers
    protected flickerBlocks = new Uint8Array(MASK_BLOCKS_X * MASK_BLOCKS_Y);
    // the same with the cells around each folded in
    protected flickerNear = new Uint8Array(MASK_BLOCKS_X * MASK_BLOCKS_Y);

    record(pixels: Uint8Array, colorMode: boolean, kind: FrameKind): void {
        if (kind === 'next' && this.hasCurrent) {
            [this.current, this.before, this.earlier, this.earliest] =
                [this.earliest, this.current, this.before, this.earlier];
            this.earliestColorMode = this.earlierColorMode;
            this.hasEarliest = this.hasEarlier;
            this.earlierColorMode = this.beforeColorMode;
            this.hasEarlier = this.hasBefore;
            this.beforeColorMode = this.currentColorMode;
            this.hasBefore = true;
        } else if (kind === 'jump') {
            this.hasBefore = false;
            this.hasEarlier = false;
            this.hasEarliest = false;
        }
        this.current.set(pixels);
        this.currentColorMode = colorMode;
        this.hasCurrent = true;
    }

    // copies, the most recent first
    previous(): Frame[] {
        return this.peekPrevious().map(frame => ({ pixels: frame.pixels.slice().buffer, colorMode: frame.colorMode }));
    }

    // the most recent first, without copying
    peekPrevious(): HeldFrame[] {
        const frames: HeldFrame[] = [];
        if (this.hasBefore) {
            frames.push({ pixels: this.before, colorMode: this.beforeColorMode });
            if (this.hasEarlier) {
                frames.push({ pixels: this.earlier, colorMode: this.earlierColorMode });
                if (this.hasEarliest) {
                    frames.push({ pixels: this.earliest, colorMode: this.earliestColorMode });
                }
            }
        }
        return frames;
    }

    /**
     * The current frame blended as the renderer shows it, for the immersion halo, which reads the picture here; from
     * the raw frame, alternate-frame sprites would come and go in it. Same rules as the renderer (full everywhere,
     * smart where a pixel goes A, B, A, widened by MASK_REACH, and mostly-flickering cells), except that legacy frames
     * mix each eye's brightness rather than its palette color and frames in different transports are not mixed at all.
     */
    blendedCurrent(blending: FrameBlending): HeldFrame | undefined {
        if (!this.hasCurrent) {
            return undefined;
        }
        const colorMode = this.currentColorMode;
        const current: HeldFrame = { pixels: this.current, colorMode };
        if (blending === FrameBlending.OFF || !this.hasBefore || this.beforeColorMode !== colorMode) {
            return current;
        }
        const smart = blending === FrameBlending.SMART;
        if (smart && (!this.hasEarlier || this.earlierColorMode !== colorMode)) {
            return current;
        }

        const now = this.current;
        const before = this.before;
        const out = this.blended;
        const bytes = vbFrameBytes(colorMode);
        out.set(now.subarray(0, bytes));
        const mix = mixTable();
        // legacy frames carry the left eye in the red byte and the right in the green; VBC frames the left eye's RGB
        // in the left half of each row and the right eye's in the right
        const rowStride = (colorMode ? VB_SCREEN_WIDTH * 2 : VB_SCREEN_WIDTH) * 4;
        const rightOffset = colorMode ? VB_SCREEN_WIDTH * 4 : 1;
        const channels = colorMode ? 3 : 1;

        const mask = smart ? this.flickerMask(rowStride, rightOffset, channels) : undefined;
        for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
            for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
                const bits = mask ? mask[y * VB_SCREEN_WIDTH + x] : 3;
                if (bits === 0) {
                    continue;
                }
                const at = y * rowStride + x * 4;
                for (let eye = 0; eye < 2; eye++) {
                    if ((bits & (1 << eye)) === 0) {
                        continue;
                    }
                    const from = at + (eye === 0 ? 0 : rightOffset);
                    for (let c = 0; c < channels; c++) {
                        out[from + c] = mix[(now[from + c] << 8) | before[from + c]];
                    }
                }
            }
        }
        return { pixels: out, colorMode };
    }

    // the renderer's RAW_SHADER, BLOCK_SHADER and MASK_SHADER, over the frames held here. Runs on every halo sample,
    // so written for speed: no closures, a loop per transport, and the cell neighbourhood gathered once per cell
    protected flickerMask(rowStride: number, rightOffset: number, channels: number): Uint8Array {
        const now = this.current;
        const before = this.before;
        const earlier = this.earlier;
        const earliest = this.hasEarliest && this.earliestColorMode === this.currentColorMode
            ? this.earliest
            : undefined;
        const flicker = this.flicker;

        // A, B, A over three frames, the latest first, in either of the last two triples
        if (channels === 1) {
            for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
                let at = y * rowStride;
                let p = y * VB_SCREEN_WIDTH;
                for (let x = 0; x < VB_SCREEN_WIDTH; x++, at += 4, p++) {
                    let bits = 0;
                    for (let eye = 0; eye < 2; eye++) {
                        const i = at + (eye === 0 ? 0 : rightOffset);
                        const a = now[i];
                        const b = before[i];
                        const c = earlier[i];
                        if ((a === c && a !== b) ||
                            (earliest !== undefined && b === earliest[i] && b !== c)) {
                            bits |= 1 << eye;
                        }
                    }
                    flicker[p] = bits;
                }
            }
        } else {
            for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
                let at = y * rowStride;
                let p = y * VB_SCREEN_WIDTH;
                for (let x = 0; x < VB_SCREEN_WIDTH; x++, at += 4, p++) {
                    let bits = 0;
                    for (let eye = 0; eye < 2; eye++) {
                        const i = at + (eye === 0 ? 0 : rightOffset);
                        const a0 = now[i], a1 = now[i + 1], a2 = now[i + 2];
                        const b0 = before[i], b1 = before[i + 1], b2 = before[i + 2];
                        const c0 = earlier[i], c1 = earlier[i + 1], c2 = earlier[i + 2];
                        if ((a0 === c0 && a1 === c1 && a2 === c2 && (a0 !== b0 || a1 !== b1 || a2 !== b2)) ||
                            (earliest !== undefined &&
                                b0 === earliest[i] && b1 === earliest[i + 1] && b2 === earliest[i + 2] &&
                                (b0 !== c0 || b1 !== c1 || b2 !== c2))) {
                            bits |= 1 << eye;
                        }
                    }
                    flicker[p] = bits;
                }
            }
        }

        // the cells where most pixels flicker, before the pixels are widened
        const blocks = this.flickerBlocks;
        for (let by = 0; by < MASK_BLOCKS_Y; by++) {
            for (let bx = 0; bx < MASK_BLOCKS_X; bx++) {
                let left = 0;
                let right = 0;
                for (let y = by * MASK_BLOCK; y < (by + 1) * MASK_BLOCK; y++) {
                    const row = y * VB_SCREEN_WIDTH;
                    for (let x = bx * MASK_BLOCK; x < (bx + 1) * MASK_BLOCK; x++) {
                        const bits = flicker[row + x];
                        left += bits & 1;
                        right += bits >> 1;
                    }
                }
                blocks[by * MASK_BLOCKS_X + bx] =
                    (left >= MASK_BLOCK_SHARE ? 1 : 0) | (right >= MASK_BLOCK_SHARE ? 2 : 0);
            }
        }
        const near = this.flickerNear;
        for (let by = 0; by < MASK_BLOCKS_Y; by++) {
            for (let bx = 0; bx < MASK_BLOCKS_X; bx++) {
                let bits = 0;
                for (let j = Math.max(0, by - 1); j <= Math.min(MASK_BLOCKS_Y - 1, by + 1); j++) {
                    for (let i = Math.max(0, bx - 1); i <= Math.min(MASK_BLOCKS_X - 1, bx + 1); i++) {
                        bits |= blocks[j * MASK_BLOCKS_X + i];
                    }
                }
                near[by * MASK_BLOCKS_X + bx] = bits;
            }
        }

        // widened by MASK_REACH on both axes, one axis at a time
        const spread = this.flickerSpread;
        for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
            const row = y * VB_SCREEN_WIDTH;
            for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
                let bits = 0;
                const last = row + (x + MASK_REACH < VB_SCREEN_WIDTH ? x + MASK_REACH : VB_SCREEN_WIDTH - 1);
                for (let i = row + (x > MASK_REACH ? x - MASK_REACH : 0); i <= last; i++) {
                    bits |= flicker[i];
                }
                spread[row + x] = bits;
            }
        }
        // and the cells that mostly flicker, with the cells around them
        for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
            const first = (y > MASK_REACH ? y - MASK_REACH : 0) * VB_SCREEN_WIDTH;
            const last = (y + MASK_REACH < VB_SCREEN_HEIGHT ? y + MASK_REACH : VB_SCREEN_HEIGHT - 1) * VB_SCREEN_WIDTH;
            const nearRow = ((y / MASK_BLOCK) | 0) * MASK_BLOCKS_X;
            const row = y * VB_SCREEN_WIDTH;
            for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
                let bits = near[nearRow + ((x / MASK_BLOCK) | 0)];
                for (let i = first + x; i <= last + x; i += VB_SCREEN_WIDTH) {
                    bits |= spread[i];
                }
                flicker[row + x] = bits;
            }
        }
        return flicker;
    }
}

// the last frames a fast-forwarded audio buffer emulated, for blending: fast forward shows one frame of several, so
// alternate-frame sprites would flicker at the speed's rhythm. The three before the shown one go to the renderer ahead
// of it; only frames run back to back count, clear marks a gap
export class SkippedFrames {
    protected readonly buffers = [
        new Uint8Array(FRAME_BYTES), new Uint8Array(FRAME_BYTES),
        new Uint8Array(FRAME_BYTES), new Uint8Array(FRAME_BYTES)];
    protected readonly colorModes = [false, false, false, false];
    protected count = 0; // at most four, the newest at (next + 3) % 4
    protected next = 0;

    hold(pixels: Uint8Array, colorMode: boolean): void {
        this.buffers[this.next].set(pixels);
        this.colorModes[this.next] = colorMode;
        this.next = (this.next + 1) % 4;
        this.count = Math.min(4, this.count + 1);
    }

    clear(): void {
        this.count = 0;
    }

    // oldest first, and forgets them all. The newest is left out, as it is about to be shown anyway. Valid until the
    // next hold
    take(): HeldFrame[] {
        const frames: HeldFrame[] = [];
        for (let i = this.count; i > 1; i--) {
            const at = (this.next + 4 - i) % 4;
            frames.push({ pixels: this.buffers[at], colorMode: this.colorModes[at] });
        }
        this.count = 0;
        return frames;
    }
}
