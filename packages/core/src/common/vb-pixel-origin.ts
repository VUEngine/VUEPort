/**
 * What drew a pixel of a frame buffer, as the core keeps it while asked to (`VbMachine.keepOrigins` in the probe,
 * `Sim.setPixelOrigins` in the app). Two 32-bit words a pixel, laid out in the core's `vip.c` (`PixelOrigins`):
 *
 *     what   bits  0-2  kind: 0 unknown, 1 backdrop, 2 BG map cell,
 *                       3 overplane cell, 4 object, 5 CPU write, 6 debug write
 *            bits  3-7  world
 *            bits  8-19 character
 *            bits 20-25 pixel within the character as stored, y * 8 + x
 *            bits 26-27 flip (hflp << 1 | vflp)
 *            bits 28-29 the character's pixel value, the backdrop's shade,
 *                       or the value written
 *            bits 30-31 palette (GPLTn for cells, JPLTn for objects)
 *     where  cells: BG map cell index (segment << 12 | cell); objects: the
 *            object's index; writes: the PC.
 *            Where VB Color drew the pixel, bit 24 is set, bits 16-23 hold
 *            the VB Color source byte and bits 25-26 what chose it:
 *            1 the cell's or object's color attribute, 2 the character's
 *            color attribute (CCEN), 3 a pixel color slot (PCE); bit 27 is
 *            set where a world palette offset was added. For the backdrop,
 *            bits 25-26 are 1 for CBKPAL and 2 for the backdrop row table.
 */

// what chose a pixel's VB Color palette: the cell's or object's color attribute, the character's (CCEN), a pixel
// color slot (PCE), or for the backdrop the CBKPAL register or the backdrop row table (BKREN)
export type VbColorSource = 'attribute' | 'character' | 'slot' | 'register' | 'rows';

export type VbPixelOriginKind = 'unknown' | 'backdrop' | 'cell' | 'overplane' | 'object' | 'cpu' | 'debugger';

const KINDS: VbPixelOriginKind[] = ['unknown', 'backdrop', 'cell', 'overplane', 'object', 'cpu', 'debugger', 'unknown'];

export interface VbPixelOrigin {
    // `unknown`: nothing drew it since origins were first kept, `cpu`: a program wrote it into the frame buffer,
    // `debugger`: a tool did
    kind: VbPixelOriginKind;
    world?: number;
    bgmap?: { segment: number, x: number, y: number, address: number };
    object?: { index: number, address: number };
    character?: number;
    pixel?: { x: number, y: number }; // as the character stores it, with the flip undone
    flip?: { h: boolean, v: boolean };
    value: number; // character pixel value (0-3); for the backdrop its shade, for a write the value written
    palette?: string;
    vbc?: number;
    vbcSource?: VbColorSource;
    vbcOffset?: boolean;
    pc?: number;
}

const BGMAP_BASE = 0x00020000;
const OAM_BASE = 0x0003e000;

export function decodeOrigin(what: number, where: number): VbPixelOrigin {
    const kind = KINDS[what & 7];
    const value = what >>> 28 & 3;
    if (kind === 'unknown') {
        return { kind, value: 0 };
    }
    if (kind === 'cpu' || kind === 'debugger') {
        return { kind, value, pc: where >>> 0 };
    }
    const vbc = where & 0x1000000 ? where >>> 16 & 0xff : undefined;
    const chosen = where >>> 25 & 3;
    if (kind === 'backdrop') {
        return {
            kind, value,
            ...(vbc !== undefined ? { vbc, vbcSource: chosen === 2 ? 'rows' : 'register' } as const : {}),
        };
    }
    const index = what >>> 20 & 63;
    const flip = what >>> 26 & 3;
    const origin: VbPixelOrigin = {
        kind,
        world: what >>> 3 & 31,
        character: what >>> 8 & 0xfff,
        pixel: { x: index & 7, y: index >>> 3 },
        flip: { h: (flip & 2) !== 0, v: (flip & 1) !== 0 },
        value,
        palette: `${kind === 'object' ? 'JPLT' : 'GPLT'}${what >>> 30}`,
    };
    if (kind === 'object') {
        const object = where & 0x3ff;
        origin.object = { index: object, address: OAM_BASE + object * 8 };
    } else {
        const cell = where & 0xffff;
        origin.bgmap = { segment: cell >>> 12, x: cell & 63, y: cell >>> 6 & 63, address: BGMAP_BASE + cell * 2 };
    }
    if (vbc !== undefined) {
        origin.vbc = vbc;
        origin.vbcSource = chosen === 3 ? 'slot' : chosen === 2 ? 'character' : 'attribute';
        origin.vbcOffset = (where & 0x8000000) !== 0;
    }
    return origin;
}

// what a pixel came from without which of its pixels: the same for everything one cell, object or instruction drew
export function originSource(origin: VbPixelOrigin): string {
    switch (origin.kind) {
        case 'cell':
        case 'overplane':
            return `${origin.kind} ${origin.world} ${origin.bgmap!.address} ${origin.character}`;
        case 'object':
            return `object ${origin.world} ${origin.object!.index} ${origin.character}`;
        case 'cpu':
        case 'debugger':
            return `${origin.kind} ${origin.pc}`;
        default:
            return origin.kind;
    }
}

// origins as runs: `count, what, where` repeated, row by row through the left eye's 384x224, then the right's.
// A frame is a few kilobytes instead of 1.4 MB of words, small enough for the worker to send with every frame
export function decodeOriginRuns(runs: Uint32Array, pixels: number): Uint32Array {
    const out = new Uint32Array(pixels * 2);
    let at = 0;
    for (let i = 0; i + 2 < runs.length && at < out.length; i += 3) {
        const end = Math.min(out.length, at + runs[i] * 2);
        const what = runs[i + 1];
        const where = runs[i + 2];
        for (; at < end; at += 2) {
            out[at] = what;
            out[at + 1] = where;
        }
    }
    return out;
}

// one eye's screen rectangle, as an engine drew a sprite
export interface VbScreenBox {
    x: number;
    y: number;
    width: number;
    height: number;
    parallax: number; // moves the box apart for the two eyes
}

export interface VbCellArea {
    segment: number;
    x: number;
    y: number;
    cols: number;
    rows: number;
    near?: VbScreenBox; // set where other sprites draw from the same cells: only pixels near this box are its own
}

// characters a sprite's objects are drawn with
export interface VbCharacterSpan {
    from: number;
    to: number; // exclusive
    near?: VbScreenBox;
}

// sprites are told by what they draw (their cells, their objects' characters), not where: an engine re-assigns
// worlds and objects as often as every frame
export type VbPixelSource =
    | { kind: 'world', world: number }
    | { kind: 'object', object: number }
    | { kind: 'cell', address: number }
    | { kind: 'character', character: number }
    | { kind: 'vbcPalette', palette: number }
    | {
        kind: 'sprites',
        cells: VbCellArea[],
        characters: VbCharacterSpan[],
        // these two only for sprites whose picture could not be found
        worlds: number[],
        objects: number[],
    };

const NEAR_MARGIN = 8; // how far a sprite may have moved since its box was read: a frame or two of fast motion

function isNear(box: VbScreenBox | undefined, x: number | undefined, y: number | undefined, eye: 0 | 1): boolean {
    if (!box || x === undefined || y === undefined) {
        return true;
    }
    const left = box.x + (eye === 0 ? -box.parallax : box.parallax);
    return x >= left - NEAR_MARGIN && x < left + box.width + NEAR_MARGIN
        && y >= box.y - NEAR_MARGIN && y < box.y + box.height + NEAR_MARGIN;
}

// works on the raw words rather than through decodeOrigin, as it runs for every pixel of a picture. The position
// only matters for sprites sharing what they draw with others
export function originDrawnBy(
    what: number, where: number, source: VbPixelSource, x?: number, y?: number, eye: 0 | 1 = 0
): boolean {
    const kind = what & 7;
    if (source.kind === 'vbcPalette') {
        return kind >= 1 && kind <= 4 && (where & 0x1000000) !== 0 && (where >>> 16 & 0xff) === source.palette;
    }
    if (kind < 2 || kind > 4) {
        return false;
    }
    switch (source.kind) {
        case 'world':
            return (what >>> 3 & 31) === source.world;
        case 'object':
            return kind === 4 && (where & 0x3ff) === source.object;
        case 'cell':
            return kind !== 4 && BGMAP_BASE + (where & 0xffff) * 2 === source.address;
        case 'character':
            return (what >>> 8 & 0xfff) === source.character;
        case 'sprites': {
            if (kind === 4) {
                // by their characters or objects, never their world: every object sprite shares the OBJ worlds
                const character = what >>> 8 & 0xfff;
                return source.characters.some(span => character >= span.from && character < span.to
                        && isNear(span.near, x, y, eye))
                    || source.objects.includes(where & 0x3ff);
            }
            const cell = where & 0xffff;
            const segment = cell >>> 12;
            const cellX = cell & 63;
            const cellY = cell >>> 6 & 63;
            return source.cells.some(area => area.segment === segment
                    && cellX >= area.x && cellX < area.x + area.cols && cellY >= area.y && cellY < area.y + area.rows
                    && isNear(area.near, x, y, eye))
                || source.worlds.includes(what >>> 3 & 31);
        }
    }
}
