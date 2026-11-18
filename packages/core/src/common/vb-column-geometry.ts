/**
 * Where the VB's columns land on screen, from the column table. Measured on hardware (`column-table-test` in the vb
 * projects folder): the display period follows the table exactly (Column Length + 1, in 200ns units), and the mirror
 * swings sinusoidally once per 20ms frame. Nintendo's table is that sinusoid's inverse speed to within a pixel; another
 * table spaces columns differently (a longer column leaves a gap, one past the end of the swing comes back the other
 * way). The mirror is fitted to Nintendo's table as x(t) = a + b·sin ωt + c·cos ωt, with the residual (under a pixel)
 * added back, so Nintendo's table, which every commercial game uses, maps exactly onto itself. The core reads the
 * entries from where a measured unit's servo settled, `VB_COLUMN_TABLE_START`; `vbGetColumnLengths` returns those of
 * the image shown.
 */

// Nintendo's recommended column table, Column Length only, as every commercial game loads it
export const VB_COLUMN_TABLE: readonly number[] = [
    0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE,
    0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE,
    0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE,
    0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xE0, 0xBC,
    0xA6, 0x96, 0x8A, 0x82, 0x7A, 0x74, 0x6E, 0x6A, 0x66, 0x62, 0x60, 0x5C, 0x5A, 0x58, 0x56, 0x54,
    0x52, 0x50, 0x50, 0x4E, 0x4C, 0x4C, 0x4A, 0x4A, 0x48, 0x48, 0x46, 0x46, 0x46, 0x44, 0x44, 0x44,
    0x42, 0x42, 0x42, 0x40, 0x40, 0x40, 0x40, 0x40, 0x3E, 0x3E, 0x3E, 0x3E, 0x3E, 0x3E, 0x3E, 0x3C,
    0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C,
    0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C, 0x3C,
    0x3C, 0x3E, 0x3E, 0x3E, 0x3E, 0x3E, 0x3E, 0x3E, 0x40, 0x40, 0x40, 0x40, 0x40, 0x42, 0x42, 0x42,
    0x44, 0x44, 0x44, 0x46, 0x46, 0x46, 0x48, 0x48, 0x4A, 0x4A, 0x4C, 0x4C, 0x4E, 0x50, 0x50, 0x52,
    0x54, 0x56, 0x58, 0x5A, 0x5C, 0x60, 0x62, 0x66, 0x6A, 0x6E, 0x74, 0x7A, 0x82, 0x8A, 0x96, 0xA6,
    0xBC, 0xE0, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE,
    0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE,
    0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE,
    0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE,
];

// where a measured unit's servo settled, left eye first. Must match the core's reset values of CTA
export const VB_COLUMN_TABLE_START: readonly [number, number] = [0xB1, 0xAE];

export const VB_COLUMN_GROUPS = 96; // one table entry per 4 columns
const COLUMNS = VB_COLUMN_GROUPS * 4;
const UNIT = 200e-9; // seconds per unit of Column Length
const OMEGA = 2 * Math.PI / 0.020;

interface Mirror {
    a: number;
    b: number;
    c: number;
    times: Float64Array;
    residuals: Float64Array;
}

// when each of the 385 column edges is reached, from the start of the eye's display
function edgeTimes(lengths: ArrayLike<number>): Float64Array {
    const times = new Float64Array(COLUMNS + 1);
    for (let column = 0; column < COLUMNS; column++) {
        times[column + 1] = times[column] + (lengths[column >> 2] + 1) * UNIT;
    }
    return times;
}

// from where the eye's display begins
function referenceLengths(eye: number): number[] {
    const start = VB_COLUMN_TABLE_START[eye];
    return Array.from({ length: VB_COLUMN_GROUPS }, (_, group) => VB_COLUMN_TABLE[(start - group) & 0xFF]);
}

// least squares of x = a + b·sin ωt + c·cos ωt through (time, column) pairs
function fitMirror(times: Float64Array): Mirror {
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const v = [0, 0, 0];
    times.forEach((time, column) => {
        const f = [1, Math.sin(OMEGA * time), Math.cos(OMEGA * time)];
        for (let i = 0; i < 3; i++) {
            v[i] += f[i] * column;
            for (let j = 0; j < 3; j++) {
                m[i][j] += f[i] * f[j];
            }
        }
    });
    // Gauss-Jordan with partial pivoting on the 3×3 normal equations
    const rows = m.map((row, i) => [...row, v[i]]);
    for (let i = 0; i < 3; i++) {
        let pivot = i;
        for (let r = i + 1; r < 3; r++) {
            if (Math.abs(rows[r][i]) > Math.abs(rows[pivot][i])) {
                pivot = r;
            }
        }
        [rows[i], rows[pivot]] = [rows[pivot], rows[i]];
        for (let r = 0; r < 3; r++) {
            if (r !== i) {
                const factor = rows[r][i] / rows[i][i];
                for (let col = i; col < 4; col++) {
                    rows[r][col] -= factor * rows[i][col];
                }
            }
        }
    }
    const [a, b, c] = [0, 1, 2].map(i => rows[i][3] / rows[i][i]);
    const residuals = new Float64Array(times.length);
    times.forEach((time, column) => {
        residuals[column] = column - (a + b * Math.sin(OMEGA * time) + c * Math.cos(OMEGA * time));
    });
    return { a, b, c, times, residuals };
}

const mirrors: Mirror[] = [];

function mirrorOf(eye: number): Mirror {
    return mirrors[eye] ??= fitMirror(edgeTimes(referenceLengths(eye)));
}

// before the mirror is in step, see `mirrorSpinUp`
export interface MirrorState {
    stretch: number; // the picture is this many times as wide as settled, about its fixed left edge
}

const SETTLED: MirrorState = { stretch: 1 };

// where light emitted this long after the eye's display began lands
function positionAt(mirror: Mirror, time: number): number {
    const { times, residuals } = mirror;
    let correction: number; // the fit's error, interpolated between Nintendo's edges and held beyond them
    if (time <= times[0]) {
        correction = residuals[0];
    } else if (time >= times[COLUMNS]) {
        correction = residuals[COLUMNS];
    } else {
        let lo = 0;
        let hi = COLUMNS;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (times[mid] <= time) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        const share = (time - times[lo]) / (times[hi] - times[lo]);
        correction = residuals[lo] + (residuals[hi] - residuals[lo]) * share;
    }
    return mirror.a + mirror.b * Math.sin(OMEGA * time) + mirror.c * Math.cos(OMEGA * time) + correction;
}

export function isReferenceColumns(lengths: ArrayLike<number>, eye: number): boolean {
    const start = VB_COLUMN_TABLE_START[eye];
    for (let group = 0; group < VB_COLUMN_GROUPS; group++) {
        if (lengths[group] !== VB_COLUMN_TABLE[(start - group) & 0xFF]) {
            return false;
        }
    }
    return true;
}

// screen position of each of an eye's 385 column edges, in pixels; Nintendo's table gives 0, 1, … 384
export function columnEdges(lengths: ArrayLike<number>, eye: number, state: MirrorState = SETTLED): Float64Array {
    const mirror = mirrorOf(eye);
    // the first column is at 0, which a stretch leaves where it is
    return edgeTimes(lengths).map(time => positionAt(mirror, time) * state.stretch);
}

export interface SpinUpFrame extends MirrorState {
    light: number;
}

/**
 * The display unit coming to life after power on; undefined once settled. Measured on hardware (`column-table-fx`, a
 * cold start filmed twice, in real time and at 240fps): nothing for about 4s whatever the program does, then the full
 * picture at full brightness. The left edge stays put; the right edge starts a little wide, goes 6% short, 3.5% wide
 * at 1.75s, a little short again, and has settled after some 5s. The first second differed between the two starts (the
 * other began 10% wide), the later breathing did not. The 4s wait is shortened unless `fullDelay` asks for it; the
 * settling is as measured.
 */
export function mirrorSpinUp(frame: number, fullDelay = false): SpinUpFrame | undefined {
    const since = frame / 50 - (fullDelay ? 4 : 0.4);
    if (since < 0) {
        return { stretch: 1, light: 0 };
    }
    if (since > 6.5) {
        return undefined;
    }
    // damped swing of the width about where it settles, period 2.74s, plus the first frames' extra width dying
    // away. Fitted to the real-time video
    const stretch = 1
        - 0.117 * Math.exp(-since / 1.45) * Math.cos(2 * Math.PI * since / 2.74 - 1.06)
        + 0.093 * Math.exp(-since / 0.4);
    return { stretch, light: 1 };
}

/**
 * How each screen pixel of one eye is lit: for pixel x, columns `columns[offsets[x]] … columns[offsets[x + 1] - 1]`,
 * each times its `weights` entry. A column is only lit for a pulse at its start (the brightness duration, a fraction
 * of a microsecond against ten or more), so its light is a thin line where the mirror stood, not a band; on hardware a
 * much longer column shows as a line with a gap after it. Each line lights the one pixel it is nearest to, so the
 * picture stays as sharp as the hardware's. Sharing it between the two nearest pixels would smear every column of a
 * table only slightly off Nintendo's (SD Gundam's and V-Tetris' right eye, a few pixels over) across two; Nintendo's
 * table puts every column exactly on its own. Where columns are crowded (closer than CROWDED) they add up; where they
 * are a little further apart than a pixel and rounding leaves one out, it takes the nearer column's light (a gap of at
 * most GAP), and only a wider gap stays dark. What falls off the 384 pixels is not seen.
 */
export interface ColumnSpread {
    offsets: Uint32Array;
    columns: Uint16Array;
    weights: Float32Array;
}

// columns meeting in one pixel at least this far apart only met there by rounding: the nearest is drawn, not their sum
const CROWDED = 0.75;
const GAP = 1.5; // an empty pixel between columns at most this far apart is a rounding hole, not a gap the table made

export function columnSpread(edges: Float64Array): ColumnSpread {
    const lists: number[][] = Array.from({ length: COLUMNS }, () => []);
    for (let column = 0; column < COLUMNS; column++) {
        const pixel = Math.round(edges[column]);
        if (pixel >= 0 && pixel < COLUMNS) {
            lists[pixel].push(column);
        }
    }
    const nearest = (pixel: number, candidates: number[]): number => candidates.reduce((best, column) =>
        Math.abs(edges[column] - pixel) < Math.abs(edges[best] - pixel) ? column : best);
    const drawn = lists.map((list, pixel) => {
        if (list.length > 1) {
            const span = Math.abs(edges[list[list.length - 1]] - edges[list[0]]) / (list.length - 1);
            return span >= CROWDED ? [nearest(pixel, list)] : list;
        }
        if (list.length === 1) {
            return list;
        }
        // the nearest column on either side, by position: a table past the end of the swing comes back the other
        // way, so the columns are not in screen order
        let below = -1;
        let above = -1;
        for (let column = 0; column < COLUMNS; column++) {
            const position = edges[column];
            if (position < pixel && (below < 0 || position > edges[below])) {
                below = column;
            } else if (position > pixel && (above < 0 || position < edges[above])) {
                above = column;
            }
        }
        return below >= 0 && above >= 0 && edges[above] - edges[below] <= GAP ? [nearest(pixel, [below, above])] : [];
    });
    const offsets = new Uint32Array(COLUMNS + 1);
    drawn.forEach((list, pixel) => {
        offsets[pixel + 1] = offsets[pixel] + list.length;
    });
    const columns = new Uint16Array(offsets[COLUMNS]);
    drawn.forEach((list, pixel) => {
        columns.set(list, offsets[pixel]);
    });
    return { offsets, columns, weights: new Float32Array(columns.length).fill(1) };
}
