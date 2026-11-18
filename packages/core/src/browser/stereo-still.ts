// changes the 3D depth of a still stereo pair. Live, the core scales parallax per world (`setStereoDepth`); a still
// only has the two eye images, so the parallax is measured back out by horizontal block matching (VB layers are flat
// and shift by whole pixels) and every lit pixel is moved to its place at the new depth

// widest parallax looked for, in pixels between the two eyes
const MAX_DISPARITY = 24;
// half size of the block compared around each pixel
const BLOCK_X = 4;
const BLOCK_Y = 2;
// cost of comparing against a pixel beyond the edge, as a brightness difference
const OUTSIDE = 255;
// half size of the neighborhood that votes on each lit pixel's parallax
const VOTE_X = 8;
const VOTE_Y = 1;

// per pixel of `from`, the horizontal offset to its match in `to`. Ties go to the smaller offset, so a featureless
// area stays where it is.
export function measureDisparity(
    from: Uint8ClampedArray, to: Uint8ClampedArray, width: number, height: number,
): Int8Array {
    const size = width * height;
    const best = new Int8Array(size);
    const bestCost = new Float64Array(size).fill(Infinity);
    const cost = new Float64Array(size);
    // summed-area table, one column and row wider, so every block's total is four lookups
    const stride = width + 1;
    const sums = new Float64Array(stride * (height + 1));

    // smallest offsets first, which is what makes ties go to them
    const offsets = [0];
    for (let d = 1; d <= MAX_DISPARITY; d++) {
        offsets.push(-d, d);
    }
    for (const d of offsets) {
        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                const tx = x + d;
                cost[row + x] = tx < 0 || tx >= width
                    ? OUTSIDE
                    : Math.abs(from[row + x] - to[row + tx]);
            }
        }
        for (let y = 0; y < height; y++) {
            let line = 0;
            for (let x = 0; x < width; x++) {
                line += cost[y * width + x];
                sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + line;
            }
        }
        for (let y = 0; y < height; y++) {
            const y0 = Math.max(0, y - BLOCK_Y);
            const y1 = Math.min(height, y + BLOCK_Y + 1);
            for (let x = 0; x < width; x++) {
                const x0 = Math.max(0, x - BLOCK_X);
                const x1 = Math.min(width, x + BLOCK_X + 1);
                const total = sums[y1 * stride + x1] - sums[y0 * stride + x1]
                    - sums[y1 * stride + x0] + sums[y0 * stride + x0];
                const i = y * width + x;
                if (total < bestCost[i]) {
                    bestCost[i] = total;
                    best[i] = d;
                }
            }
        }
    }
    return best;
}

// a layer moves as one; strays from blocks straddling two layers or repeating patterns become specks at other
// depths. Wider than tall, since a floor with per-line parallax changes from line to line but not along it.
function settleDisparity(
    plane: Uint8ClampedArray, disparity: Int8Array, width: number, height: number,
): Int8Array {
    const settled = new Int8Array(disparity);
    const votes = new Uint16Array(2 * MAX_DISPARITY + 1);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (plane[y * width + x] === 0) {
                continue;
            }
            votes.fill(0);
            for (let ny = Math.max(0, y - VOTE_Y); ny <= Math.min(height - 1, y + VOTE_Y); ny++) {
                for (let nx = Math.max(0, x - VOTE_X); nx <= Math.min(width - 1, x + VOTE_X); nx++) {
                    if (plane[ny * width + nx] !== 0) {
                        votes[disparity[ny * width + nx] + MAX_DISPARITY]++;
                    }
                }
            }
            // the pixel's own measure wins a tie
            let winner = disparity[y * width + x] + MAX_DISPARITY;
            for (let i = 0; i < votes.length; i++) {
                if (votes[i] > votes[winner]) {
                    winner = i;
                }
            }
            settled[y * width + x] = winner - MAX_DISPARITY;
        }
    }
    return settled;
}

export interface StereoStill {
    width: number;
    height: number;
    left: Uint8ClampedArray;
    right: Uint8ClampedArray;
    // per left-eye pixel, how far right the same point is in the right eye
    leftDisparity: Int8Array;
    // per right-eye pixel, how far left the same point is in the left eye
    rightDisparity: Int8Array;
}

export function measureStereoStill(
    left: Uint8ClampedArray, right: Uint8ClampedArray, width: number, height: number,
): StereoStill {
    const toLeft = settleDisparity(right, measureDisparity(right, left, width, height), width, height);
    // stored as distances in the same direction for both eyes
    const rightDisparity = new Int8Array(toLeft.length);
    for (let i = 0; i < toLeft.length; i++) {
        rightDisparity[i] = -toLeft[i];
    }
    return {
        width,
        height,
        left,
        right,
        leftDisparity: settleDisparity(left, measureDisparity(left, right, width, height), width, height),
        rightDisparity,
    };
}

// the console draws a layer at `gx - gp` (left) and `gx + gp` (right), so at depth `d` the disparity `2 * gp` becomes
// `2 * gp * d`, each eye moving by half of the difference. Nearer layers win on overlap; unlit pixels and whatever a
// moved layer uncovers stay backdrop
export function refocusStereoStill(
    still: StereoStill, depth: number,
): { left: Uint8ClampedArray, right: Uint8ClampedArray } {
    const scale = Math.max(0, depth) / 100;
    if (scale === 1) {
        return { left: still.left, right: still.right };
    }
    const shift = (1 - scale) / 2;
    return {
        left: moveLayers(still.left, still.leftDisparity, shift, still.width, still.height),
        right: moveLayers(still.right, still.rightDisparity, -shift, still.width, still.height),
    };
}

function moveLayers(
    plane: Uint8ClampedArray, disparity: Int8Array, shift: number, width: number, height: number,
): Uint8ClampedArray {
    const out = new Uint8ClampedArray(plane.length);
    // disparity of what was put at each pixel; smaller is nearer
    const placed = new Int16Array(plane.length).fill(0x7fff);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            const value = plane[row + x];
            if (value === 0) {
                continue;
            }
            const d = disparity[row + x];
            const tx = Math.round(x + shift * d);
            if (tx < 0 || tx >= width || d >= placed[row + tx]) {
                continue;
            }
            placed[row + tx] = d;
            out[row + tx] = value;
        }
    }
    return out;
}
