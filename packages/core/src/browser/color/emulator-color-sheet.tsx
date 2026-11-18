import {
    ArrowClockwise,
    ArrowCounterClockwise,
    ArrowDown,
    ArrowUp,
    ArrowUUpLeft,
    Circle,
    Eraser,
    Eyedropper,
    GridFour,
    Hand,
    MagnifyingGlassMinus,
    MagnifyingGlassPlus,
    PaintBucket,
    Pencil,
    Eye,
    EyeSlash,
    LineSegment,
    LockSimple,
    Plus,
    Polygon,
    Rectangle,
    Selection,
    Square,
    Stack,
    Trash,
} from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { ColorSheet, ColorSheetItem, ColorSheetList, makeColorCellKey } from '../../common/vb-color-package';
import ColorField from '../components/kit/ColorField';
import RadioSelect from '../components/kit/RadioSelect';
import {
    BACKDROP_ROWS, ColorEditor, ColorPixelChange, ColorSheetEntry, RED_PALETTE, SHEET_TOOL_SIZES, SheetToolOptions, formatHexColor, penTip,
} from './emulator-color-editor';
import { BackdropEditor } from './emulator-color-backdrop';

/**
 * The sheet editor shows a sheet's pictures (a figure's frames, a background) large, as the build shows them with the
 * paint, to color pixel by pixel. How the colors go into Color RAM (palettes, colors per character or per pixel) is the
 * compiler's business; the editor only says which characters cost colors per pixel.
 *
 * The picture is made of the package's characters: a pixel painted here is painted on its character, so it changes
 * wherever the character is drawn (elsewhere on the sheet, on other sheets, in the game). Pixels the game leaves
 * transparent (value 0) can be painted where the package's runtime can draw them opaque (VB Color's opaque pixel slots,
 * see ColorPackageIndex.paintsTransparent). Painted, such a pixel covers what lies behind it, which suits a background
 * (letters in a pattern) more than a figure; the eraser makes it transparent again. Elsewhere they cannot be painted,
 * and there, as wherever the brush does nothing, the checkerboard is greyed.
 *
 * Only the part of the picture in view is drawn, on a canvas the size of the view, since sheets get large at high zoom.
 */

export type SheetTool = 'area' | 'pencil' | 'eraser' | 'fill' | 'rectangle' | 'ellipse' | 'line' | 'pipette' | 'hand';

interface PlacedPart {
    x: number;
    y: number;
    key: string;
    h: boolean;
    v: boolean;
    way: string;
    locked?: boolean;
    fixed?: boolean; // painting can't reach it, no color unit of the package covers it
    // BG map cell it was seen at (segment * 4096 + cell), or 0xE000 + OAM index for an object, where the sheet knows it
    cell?: number;
    // the cell lists in force where its figure was seen (the item's), taking precedence over the sheet's
    lists?: readonly ColorSheetList[];
    // a cell the package colors with one palette per cell, which painting can't reach, so it shows as in the game.
    // A cell that can be painted gets the cell's paint key in `key` instead
    byCell?: boolean;
    charKey?: string; // the character's own paint key, when `key` was replaced by the cell's
    // a figure sheet's depth (layer) of the part in its picture (0 front, see figureDepths); a whole screen's: its layer
    depth?: number;
}

interface ScreenLayers {
    hidden: ReadonlySet<number>;
    active: ReadonlySet<number>; // empty: all are painted on, the front one wins
}

interface SheetPicture {
    width: number;
    height: number;
    rgba: Uint8ClampedArray;
    red: Uint8ClampedArray;
    part: Int32Array; // -1 for none
    pixel: Uint8Array; // the character's pixel index (y * 8 + x as stored)
    value: Uint8Array;
    shade: Uint8Array;
    // 1 for a value-0 pixel the game leaves transparent but painting can make opaque, painted or not; 2 for such a pixel
    // that is not painted, so the eraser has nothing to do there
    clear: Uint8Array;
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

const ZOOMS = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32];
const PAD = 24; // margin around the picture, in CSS pixels

interface SheetLayout {
    parts: PlacedPart[];
    width: number;
    height: number;
    labels: { text: string, x: number, y: number }[]; // each at the top left of its row, in sheet pixels
}

const LABEL = 10; // room above an animation's row for its name, in sheet pixels

const GAP = 8; // gap between pictures, in sheet pixels

// lays the pictures out in rows no wider than `width` (a wider one gets its own row), in sheet order, so a figure's
// frames fill the view instead of the strip the sheet happens to be stored as
function layOut(sheet: ColorSheet, width: number, layers?: ScreenLayers, depths?: FigureDepths): SheetLayout {
    if (sheet.kind === 'screen') {
        const shown = sheet.items.map((item, n) => ({ item, n })).filter(({ n }) => !layers?.hidden.has(n));
        const painted = layers?.active.size ? shown.filter(({ n }) => layers.active.has(n)) : shown;
        const rest = layers?.active.size ? shown.filter(({ n }) => !layers.active.has(n)) : [];
        return {
            parts: [...painted.map(({ item }) => ({ item, locked: false })), ...rest.map(({ item }) => ({ item, locked: true }))]
                .flatMap(({ item, locked }) => item.parts.map(([dx, dy, key, h, v, way, cell]) =>
                    ({ x: item.x + dx, y: item.y + dy, key, h: !!h, v: !!v, way, locked, cell, lists: item.lists }))),
            width: sheet.w,
            height: sheet.h,
            labels: [],
        };
    }
    const parts: PlacedPart[] = [];
    const labels: SheetLayout['labels'] = [];
    let x = 0;
    let y = 0;
    let row = 0;
    let wide = 0;
    const animated = sheet.items.some(item => item.anim);
    const order = new Map<string, number>();
    sheet.items.forEach(item => order.has(item.anim ?? '') || order.set(item.anim ?? '', order.size));
    const items = animated
        ? [...sheet.items].sort((a, b) => (a.anim ? order.get(a.anim)! : order.size) - (b.anim ? order.get(b.anim)! : order.size)
            || (a.frame ?? 0) - (b.frame ?? 0))
        : sheet.items;
    let group: string | undefined;
    for (const item of items) {
        if (!item.parts.length) {
            continue;
        }
        if (animated && (item.anim ?? '') !== group) {
            group = item.anim ?? '';
            if (x > 0 || y > 0) {
                y += row + GAP;
            }
            x = 0;
            row = 0;
            labels.push({ text: group, x: 0, y });
            y += LABEL;
        }
        const left = Math.min(...item.parts.map(part => part[0]));
        const top = Math.min(...item.parts.map(part => part[1]));
        const w = Math.max(...item.parts.map(part => part[0])) + 8 - left;
        const h = Math.max(...item.parts.map(part => part[1])) + 8 - top;
        if (x > 0 && x + w > width) {
            x = 0;
            y += row + GAP;
            row = 0;
        }
        const depth = depths?.get(item);
        // the picture keeps its place and size whatever is hidden
        const placed = item.parts.map(([dx, dy, key, fh, fv, way, cell], i): [PlacedPart, number] =>
            [{ x: x + dx - left, y: y + dy - top, key, h: !!fh, v: !!fv, way, cell, lists: item.lists, depth: depth?.[i] ?? 0 }, depth?.[i] ?? 0]);
        const kept = placed.filter(([, d]) => !layers?.hidden.has(d));
        if (layers?.active.size) {
            kept.forEach(([part, d]) => part.locked = !layers.active.has(d));
            kept.sort(([a], [b]) => Number(!!a.locked) - Number(!!b.locked));
        }
        kept.forEach(([part]) => parts.push(part));
        wide = Math.max(wide, x + w);
        row = Math.max(row, h);
        x += w + GAP;
    }
    return { parts, width: Math.max(1, wide), height: Math.max(1, y + row), labels };
}

// per figure picture (item), the depth of each part: 0 in front, 1 behind what is at 0, and so on
type FigureDepths = Map<ColorSheetItem, number[]>;

// splits a figure's parts into depths by their drawn pixels (value 1-3). Parts in sheet order (front first) form one
// piece while they don't overlap, as the game draws a head, body and feet as runs of objects; a piece lies one depth
// behind the deepest earlier piece it covers. Hiding the front depths reveals everything behind them for painting.
// A figure the game draws as layers of object grids (Jack Bros' Jacks: head, body and feet, each a grid of objects of
// its own on its own 8-pixel phase) has its parts in runs of one grid phase each; there a piece also ends where the
// run does, so a layer's parts that cover nothing of the piece before stay in their own layer (Skelton's body was
// half in the head's depth)
function gridRuns(item: ColorSheetItem): boolean {
    let runs = 0;
    let length = 0;
    let previous = -1;
    for (const [x, y] of item.parts) {
        const phase = (x & 7) * 8 + (y & 7);
        if (phase !== previous) {
            if (runs && length < 2) {
                return false;
            }
            runs++;
            length = 0;
            previous = phase;
        }
        length++;
    }
    return runs >= 2 && length >= 2;
}

function figureDepths(sheet: ColorSheet, opaque: (key: string, way: string) => Uint8Array | undefined): FigureLayers {
    const depths: FigureDepths = new Map();
    let count = 1;
    // vertical position of each depth within its pictures (0 top, 1 bottom, by its parts' middles), used to name it
    const heights: number[][] = [];
    for (const item of sheet.items) {
        const cover = item.parts.map(([x, y, key, h, v, way]) => {
            const mask = opaque(key, way);
            const at = new Set<number>();
            for (let i = 0; i < 64; i++) {
                if (mask?.[i]) {
                    at.add((y + (v ? 7 - (i >> 3) : i >> 3)) * 4096 + x + (h ? 7 - (i & 7) : i & 7) + 2048);
                }
            }
            return at;
        });
        const overlaps = (a: Set<number>, b: Set<number>): boolean => {
            for (const p of a) {
                if (b.has(p)) {
                    return true;
                }
            }
            return false;
        };
        const pieces: { parts: number[], depth: number }[] = [];
        const out = new Array<number>(item.parts.length).fill(0);
        const layered = gridRuns(item);
        const phase = (n: number): number => (item.parts[n][0] & 7) * 8 + (item.parts[n][1] & 7);
        item.parts.forEach((_, i) => {
            const current = pieces[pieces.length - 1];
            if (current && (!layered || phase(current.parts[0]) === phase(i)) && !current.parts.some(j => overlaps(cover[i], cover[j]))) {
                current.parts.push(i);
            } else {
                pieces.push({ parts: [i], depth: 0 });
            }
        });
        pieces.forEach((piece, n) => {
            for (let m = 0; m < n; m++) {
                if (piece.parts.some(i => pieces[m].parts.some(j => overlaps(cover[i], cover[j])))) {
                    piece.depth = Math.max(piece.depth, pieces[m].depth + 1);
                }
            }
            piece.parts.forEach(i => out[i] = piece.depth);
            count = Math.max(count, piece.depth + 1);
        });
        if (item.parts.length) {
            const top = Math.min(...item.parts.map(part => part[1]));
            const tall = Math.max(...item.parts.map(part => part[1])) + 8 - top;
            item.parts.forEach((part, i) => (heights[out[i]] ??= []).push((part[1] + 4 - top) / tall));
        }
        depths.set(item, out);
    }
    const where = heights.map(list => list.reduce((sum, at) => sum + at, 0) / list.length);
    return { depths, count, names: depthNames(where, count) };
}

interface FigureLayers {
    depths: FigureDepths;
    count: number;
    names: string[];
}

// Top, Middle, Bottom when the depths lie one above the other from front to back (a head before a body before feet),
// otherwise Front, Behind 1, Behind 2, ...
function depthNames(where: number[], count: number): string[] {
    const front = (): string[] => Array.from({ length: count }, (_, n) => n === 0
        ? nls.localize('vueport/color/sheet/depthFront', 'Front')
        : nls.localize('vueport/color/sheet/depthBehind', 'Behind {0}', n));
    if (count > 3 || where.length !== count || where.some((at, n) => n && at - where[n - 1] < 0.08)) {
        return front();
    }
    const top = nls.localize('vueport/color/sheet/depthTop', 'Top');
    const middle = nls.localize('vueport/color/sheet/depthMiddle', 'Middle');
    const bottom = nls.localize('vueport/color/sheet/depthBottom', 'Bottom');
    return count === 2 ? [top, bottom] : [top, middle, bottom];
}

// the zoom the sheet fits the view at, and the width its pictures are laid out to: the largest zoom at which the whole
// laid-out sheet fits, else the largest at which its widest picture fits across (the sheet then scrolls down)
function fitSheet(sheet: ColorSheet, viewWidth: number, viewHeight: number): { zoom: number, width: number } {
    const across = (scale: number): number => Math.max(8, Math.floor((viewWidth - 2 * PAD) / scale));
    for (const scale of [...ZOOMS].reverse().filter(z => z <= 16)) {
        const laid = layOut(sheet, across(scale));
        if (laid.width * scale + 2 * PAD <= viewWidth && laid.height * scale + 2 * PAD <= viewHeight) {
            return { zoom: scale, width: across(scale) };
        }
    }
    const widest = Math.max(8, ...sheet.items.map(item => item.parts.length
        ? Math.max(...item.parts.map(part => part[0])) + 8 - Math.min(...item.parts.map(part => part[0])) : 8));
    // a tall sheet (e.g. many animation rows) scrolls; at most 4x so several rows stay visible
    const zoom = [...ZOOMS].reverse().find(z => z <= 4 && widest * z + 2 * PAD <= viewWidth) ?? 1;
    return { zoom, width: across(zoom) };
}

function hexRgb(color: string): [number, number, number] {
    const n = parseInt(color.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
}

const VEIL = [24, 24, 24, 180]; // dark enough to flatten the checkerboard where the brush does nothing

// draws each part's pixels both as edited and as the original shows them (red by shade); where parts overlap the first
// one showing a pixel wins. A part at a cell colored by the cell lists shows the cell's colors, as the game does
function drawSheet(editor: ColorEditor, layout: SheetLayout, scene?: string, lists?: readonly ColorSheetList[]): SheetPicture {
    const { parts, width, height } = layout;
    const picture: SheetPicture = {
        width, height,
        rgba: new Uint8ClampedArray(width * height * 4),
        red: new Uint8ClampedArray(width * height * 4),
        part: new Int32Array(width * height).fill(-1),
        pixel: new Uint8Array(width * height),
        value: new Uint8Array(width * height),
        shade: new Uint8Array(width * height),
        clear: new Uint8Array(width * height),
    };
    const reds = RED_PALETTE.map(hexRgb);
    const cache = new Map<string, ReturnType<ColorEditor['wantedPixels']>>();
    const index = editor.packageIndex;
    const transparent: [part: number, pixel: number, value: number, shade: number, clear: number][] = [];
    parts.forEach((part, n) => {
        const charKey = part.charKey ??= part.key;
        const ref = index?.cellRef(part.lists ?? lists, part.cell);
        // for a context package: cells of maps the context colors per cell rather than by character
        let byCell = ref ? editor.cellPixels([ref.list], ref.cell, charKey, part.way, scene) : editor.contextCellPixels(charKey, part.cell, part.way);
        // a context's cell is painted under its cell key, covering its map's cells of that character or just itself
        const contextKey = byCell && !ref ? index?.contextCellKey(charKey, part.cell) : undefined;
        // a cell colored by the cell lists is painted under its own key where its list has slots, else shown as it is
        if (byCell && ref && index!.paintable(makeColorCellKey(ref.list, ref.cell, charKey))) {
            part.key = makeColorCellKey(ref.list, ref.cell, charKey);
            byCell = undefined;
        } else if (contextKey) {
            part.key = contextKey;
            byCell = undefined;
        } else {
            part.key = charKey;
        }
        part.byCell = !!byCell;
        part.fixed = !byCell && !!index && !index.paintable(part.key);
        const id = byCell ? `${part.key}|${part.way}|${part.cell}` : `${part.key}|${part.way}`;
        if (!cache.has(id)) {
            cache.set(id, byCell ?? editor.wantedPixels(part.key, part.way, scene));
        }
        const pixels = cache.get(id);
        if (!pixels) {
            return;
        }
        // value-0 pixels the game leaves transparent belong to the part where painting can make them opaque; the
        // package's unpainted look tells which ones are transparent
        const zero = !byCell && !part.locked && !part.fixed && !!index?.paintsTransparent(part.key);
        const base = zero ? editor.shownPixels(part.key, part.way, scene) : undefined;
        for (let i = 0; i < 64; i++) {
            const [value, shade, color] = pixels[i];
            const clear = zero && !value && !!base && !base[i][2] ? 1 : 0;
            // painted transparent (''): the pixel still belongs to the part and can be painted again, but shows what
            // is behind it
            if (color === '' || (!color && clear)) {
                transparent.push([n, i, value, shade, color === '' ? clear : 2]);
                continue;
            }
            if (!color) {
                continue;
            }
            const x = part.x + (part.h ? 7 - (i & 7) : i & 7);
            const y = part.y + (part.v ? 7 - (i >> 3) : i >> 3);
            if (x < 0 || y < 0 || x >= width || y >= height) {
                continue;
            }
            const at = y * width + x;
            if (picture.part[at] >= 0) {
                continue;
            }
            const [r, g, b] = hexRgb(color);
            const alpha = part.locked || part.fixed ? 90 : 255;
            const grey = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
            picture.rgba.set(part.fixed ? [grey, grey, grey, alpha] : [r, g, b, alpha], at * 4);
            picture.red.set([...reds[shade & 3], alpha], at * 4);
            picture.part[at] = n;
            picture.pixel[at] = i;
            picture.value[at] = value;
            picture.shade[at] = shade & 3;
            picture.clear[at] = clear;
        }
    });
    for (const [n, i, value, shade, clear] of transparent) {
        const part = parts[n];
        const x = part.x + (part.h ? 7 - (i & 7) : i & 7);
        const y = part.y + (part.v ? 7 - (i >> 3) : i >> 3);
        const at = y * width + x;
        // a layer painted on takes the transparent pixel over from a locked layer behind it; what shows stays the same
        const held = x < 0 || y < 0 || x >= width || y >= height ? -2 : picture.part[at];
        if (held === -2 || (held >= 0 && !(parts[held].locked && !part.locked))) {
            continue;
        }
        picture.part[at] = n;
        picture.pixel[at] = i;
        picture.value[at] = value;
        picture.shade[at] = shade & 3;
        picture.clear[at] = clear;
        if (held >= 0) {
            continue;
        }
        // the original game draws it, so the red view shows it as always; the colored picture leaves it clear
        // because the paint made it transparent
        if (value) {
            picture.red.set([...reds[shade & 3], part.locked || part.fixed ? 90 : 255], at * 4);
        }
    }
    return picture;
}

// the outline of the area the parts' 8x8 boxes cover, as line segments in sheet pixels (x0, y0, x1, y1) where a
// covered pixel meets an uncovered one, with runs joined
function outlineEdges(chosen: readonly PlacedPart[], width: number, height: number): [number, number, number, number][] {
    if (!chosen.length) {
        return [];
    }
    const mask = new Uint8Array((width + 2) * (height + 2));
    const at = (x: number, y: number): number => mask[(y + 1) * (width + 2) + x + 1];
    for (const part of chosen) {
        for (let y = Math.max(0, part.y); y < Math.min(height, part.y + 8); y++) {
            mask.fill(1, (y + 1) * (width + 2) + Math.max(0, part.x) + 1, (y + 1) * (width + 2) + Math.min(width, part.x + 8) + 1);
        }
    }
    const edges: [number, number, number, number][] = [];
    // horizontal edges: between rows y-1 and y
    for (let y = 0; y <= height; y++) {
        let start = -1;
        for (let x = 0; x <= width; x++) {
            const edge = x < width && at(x, y - 1) !== at(x, y);
            if (edge && start < 0) {
                start = x;
            } else if (!edge && start >= 0) {
                edges.push([start, y, x, y]);
                start = -1;
            }
        }
    }
    // vertical edges: between columns x-1 and x
    for (let x = 0; x <= width; x++) {
        let start = -1;
        for (let y = 0; y <= height; y++) {
            const edge = y < height && at(x - 1, y) !== at(x, y);
            if (edge && start < 0) {
                start = y;
            } else if (!edge && start >= 0) {
                edges.push([x, start, x, y]);
                start = -1;
            }
        }
    }
    return edges;
}

// Bresenham line from a to b, to fill gaps in strokes faster than the pointer reports
function line(ax: number, ay: number, bx: number, by: number): [number, number][] {
    const out: [number, number][] = [];
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let error = dx + dy;
    for (let x = ax, y = ay; ; ) {
        out.push([x, y]);
        if (x === bx && y === by) {
            break;
        }
        const e2 = 2 * error;
        if (e2 >= dy) {
            error += dy;
            x += sx;
        }
        if (e2 <= dx) {
            error += dx;
            y += sy;
        }
    }
    return out;
}

type Gesture =
    | { kind: 'stroke', changes: Map<string, ColorPixelChange>, last: [number, number] }
    | { kind: 'rectangle', shape: 'rectangle' | 'ellipse' | 'line', from: [number, number], to: [number, number], square: boolean }
    | { kind: 'area', from: [number, number], to: [number, number], mode: SheetToolOptions['areaMode'] }
    | { kind: 'pan', x: number, y: number, left: number, top: number }
    | { kind: 'float', from: [number, number], at: [number, number], drop: boolean };

// pixels lifted off the sheet (the area moved) or pasted, floating over it until they are put down
interface Floating {
    width: number;
    height: number;
    pixels: (string | null)[]; // null: no pixel
    x: number;
    y: number;
    lifted: ColorPixelChange[]; // back to the package's colors when put down
}

// a box of sheet pixels, both corners inclusive
interface Area {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

function areaOf(from: [number, number], to: [number, number]): Area {
    return {
        x0: Math.min(from[0], to[0]), y0: Math.min(from[1], to[1]),
        x1: Math.max(from[0], to[0]), y1: Math.max(from[1], to[1]),
    };
}

function constrained(from: [number, number], to: [number, number], shape: 'rectangle' | 'ellipse' | 'line', square: boolean): [number, number] {
    if (!square) {
        return to;
    }
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    if (shape === 'line' && Math.abs(dx) > 2 * Math.abs(dy)) {
        return [to[0], from[1]];
    }
    if (shape === 'line' && Math.abs(dy) > 2 * Math.abs(dx)) {
        return [from[0], to[1]];
    }
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [from[0] + (dx < 0 ? -side : side), from[1] + (dy < 0 ? -side : side)];
}

function inEllipse(box: Area, x: number, y: number, inset = 0): boolean {
    const rx = (box.x1 - box.x0 + 1) / 2 - inset;
    const ry = (box.y1 - box.y0 + 1) / 2 - inset;
    if (rx <= 0 || ry <= 0) {
        return false;
    }
    const cx = (box.x0 + box.x1 + 1) / 2;
    const cy = (box.y0 + box.y1 + 1) / 2;
    return ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
}

interface Chosen {
    width: number;
    height: number;
    mask: Uint8Array;
    edges: Path2D;
}

function chosenOf(width: number, height: number, mask: Uint8Array): Chosen | undefined {
    if (!mask.includes(1)) {
        return undefined;
    }
    const edges = new Path2D();
    const at = (x: number, y: number): number => x >= 0 && y >= 0 && x < width && y < height ? mask[y * width + x] : 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) {
                continue;
            }
            if (!at(x, y - 1)) {
                edges.moveTo(x, y);
                edges.lineTo(x + 1, y);
            }
            if (!at(x, y + 1)) {
                edges.moveTo(x, y + 1);
                edges.lineTo(x + 1, y + 1);
            }
            if (!at(x - 1, y)) {
                edges.moveTo(x, y);
                edges.lineTo(x, y + 1);
            }
            if (!at(x + 1, y)) {
                edges.moveTo(x + 1, y);
                edges.lineTo(x + 1, y + 1);
            }
        }
    }
    return { width, height, mask, edges };
}

interface AreaShape {
    box: Area;
    holds: (x: number, y: number) => boolean;
}

function boxShape(box: Area): AreaShape {
    return { box, holds: () => true };
}

function ellipseShape(box: Area): AreaShape {
    const cx = (box.x0 + box.x1 + 1) / 2;
    const cy = (box.y0 + box.y1 + 1) / 2;
    const rx = (box.x1 - box.x0 + 1) / 2;
    const ry = (box.y1 - box.y0 + 1) / 2;
    return { box, holds: (x, y) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1 };
}

function polygonShape(points: [number, number][]): AreaShape {
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const holds = (x: number, y: number): boolean => {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const [xi, yi] = points[i];
            const [xj, yj] = points[j];
            // pixels the outline passes through count as inside
            const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi);
            if (Math.abs(cross) <= Math.max(Math.abs(xj - xi), Math.abs(yj - yi)) / 2
                && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) {
                return true;
            }
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    };
    return { box, holds };
}

function choose(previous: Chosen | undefined, shape: AreaShape, mode: SheetToolOptions['areaMode'], width: number, height: number): Chosen | undefined {
    const mask = mode !== 'replace' && previous?.width === width && previous.height === height
        ? previous.mask.slice() : new Uint8Array(width * height);
    const { box, holds } = shape;
    for (let y = Math.max(0, box.y0); y <= Math.min(height - 1, box.y1); y++) {
        for (let x = Math.max(0, box.x0); x <= Math.min(width - 1, box.x1); x++) {
            if (holds(x, y)) {
                mask[y * width + x] = mode === 'remove' ? 0 : 1;
            }
        }
    }
    return chosenOf(width, height, mask);
}

export function SheetEditor(props: { editor: ColorEditor, entry: ColorSheetEntry }): React.JSX.Element {
    const { editor, entry } = props;
    const sheet = entry.sheet;
    const [tool, setTool] = React.useState<SheetTool>('pencil');
    const [zoomChoice, setZoomChoice] = React.useState<number | undefined>(undefined);
    const [grid, setGrid] = React.useState(false);
    const [original, setOriginal] = React.useState(false);
    const [costly, setCostly] = React.useState(false);
    const [area, setArea] = React.useState<Chosen | undefined>(undefined);
    // latest area and sheet for Undo's steps, which may run after the user has left this sheet
    const areaNow = React.useRef<Chosen | undefined>(undefined);
    areaNow.current = area;
    const sheetNow = React.useRef(sheet.id);
    sheetNow.current = sheet.id;
    // changing the area is an Undo step, applied only while this sheet is open
    const chooseArea = (next: Chosen | undefined | ((previous: Chosen | undefined) => Chosen | undefined)): void => {
        const previous = areaNow.current;
        const value = typeof next === 'function' ? next(previous) : next;
        if (value === previous) {
            return;
        }
        areaNow.current = value;
        setArea(value);
        const on = sheet.id;
        const to = (chosen: Chosen | undefined) => (): void => {
            if (sheetNow.current === on) {
                areaNow.current = chosen;
                setArea(chosen);
            }
        };
        editor.pushViewStep({ undo: to(previous), redo: to(value) });
    };
    const options = editor.toolOptions;
    const [hover, setHover] = React.useState<{ x: number, y: number, part: number } | undefined>(undefined);
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    const view = React.useRef<HTMLDivElement>(null);
    const canvas = React.useRef<HTMLCanvasElement>(null);
    const gesture = React.useRef<Gesture | undefined>(undefined);
    const [polygon, setPolygon] = React.useState<{ points: [number, number][], mode: SheetToolOptions['areaMode'] } | undefined>(undefined);
    const lastClick = React.useRef<{ time: number, x: number, y: number } | undefined>(undefined);
    const [floating, setFloating] = React.useState<Floating | undefined>(undefined);
    // latest floating pixels for pointer-up, which can arrive before the next render
    const floatingNow = React.useRef<Floating | undefined>(undefined);
    floatingNow.current = floating;
    const floatingImage = React.useMemo(() => {
        if (!floating) {
            return undefined;
        }
        const node = document.createElement('canvas');
        node.width = floating.width;
        node.height = floating.height;
        const data = new ImageData(floating.width, floating.height);
        floating.pixels.forEach((color, i) => {
            if (color) {
                data.data.set([...hexRgb(color), 255], i * 4);
            }
        });
        node.getContext('2d')!.putImageData(data, 0, 0);
        return node;
    }, [floating?.pixels, floating?.width, floating?.height]);
    const spaceDown = React.useRef(false);
    const pointerInside = React.useRef(false);
    // 'ready' while Space is held, 'drag' while the pointer moves the view
    const [panning, setPanning] = React.useState<'ready' | 'drag' | undefined>(undefined);
    // the sheet's top left in the view, in CSS pixels; undefined places it automatically (centered, or at PAD)
    const [offset, setOffset] = React.useState<{ x: number, y: number } | undefined>(undefined);

    // the layout is made for the fitting zoom, other zooms just scale it
    const fitted = React.useMemo(() => fitSheet(sheet, size.width, size.height), [sheet, size.width, size.height]);
    const [hiddenLayers, setHiddenLayers] = React.useState<ReadonlySet<number>>(() => new Set());
    const [activeLayers, setActiveLayers] = React.useState<ReadonlySet<number>>(() => new Set());
    const figure = React.useMemo(() => sheet.kind === 'screen' ? undefined : figureDepths(sheet, (key, way) => {
        const shown = editor.shownPixels(key, way, sheet.scene);
        return shown && Uint8Array.from(shown, ([value]) => value ? 1 : 0);
    }), [sheet, editor.packageIndex]);
    const layout = React.useMemo(() => layOut(sheet, fitted.width, { hidden: hiddenLayers, active: activeLayers }, figure?.depths),
        [sheet, fitted.width, hiddenLayers, activeLayers, figure]);
    const parts = layout.parts;
    const rom = editor.shownRom();
    const backdropTarget = editor.backdropTarget(entry);
    const backdrop = editor.backdropRows(backdropTarget);
    const picture = React.useMemo(() => drawSheet(editor, layout, sheet.scene, sheet.lists), [layout, editor.revision, rom]);
    // the picture at 1:1 on its own canvas (colored or red); strokes preview on it until they are committed
    const image = React.useMemo(() => {
        const node = document.createElement('canvas');
        node.width = picture.width;
        node.height = picture.height;
        node.getContext('2d')!.putImageData(
            new ImageData(new Uint8ClampedArray(original ? picture.red : picture.rgba), picture.width, picture.height), 0, 0);
        return node;
    }, [picture, original]);
    // greys out the checkerboard where the brush does nothing (no paintable pixel, a character painting can't reach, a
    // layer not painted on); painted-transparent pixels stay clear since they can be painted again
    const veil = React.useMemo(() => {
        const node = document.createElement('canvas');
        node.width = picture.width;
        node.height = picture.height;
        const data = new ImageData(picture.width, picture.height);
        for (let at = 0; at < picture.part.length; at++) {
            const part = picture.part[at] >= 0 ? parts[picture.part[at]] : undefined;
            if (!part || part.locked || part.fixed || part.byCell) {
                data.data.set(VEIL, at * 4);
            }
        }
        node.getContext('2d')!.putImageData(data, 0, 0);
        return node;
    }, [picture]);
    // characters that need per-pixel colors because one value shows more than one color (for one drawing way)
    const cost = React.useMemo(() => {
        const expensive = new Set<string>();
        const all = new Set<string>();
        const colors = new Map<string, number>();
        // a cell colored per cell (drawSheet's byCell) shows its cell's colors; painting can't reach it, so it's free
        const cells = new Set<string>();
        const cellCharacters = new Set<string>();
        for (const part of parts) {
            if (part.byCell) {
                const id = `${part.key}|${part.way}|${part.cell}`;
                if (cells.has(id)) {
                    continue;
                }
                cells.add(id);
                cellCharacters.add(`${part.key}|${part.way}`);
                const ref = editor.packageIndex?.cellRef(part.lists ?? sheet.lists, part.cell);
                const shown = ref
                    ? editor.cellPixels([ref.list], ref.cell, part.key, part.way, sheet.scene)
                    : editor.contextCellPixels(part.key, part.cell, part.way);
                for (const [value, , color] of shown ?? []) {
                    if (value && color) {
                        colors.set(color, (colors.get(color) ?? 0) + 1);
                    }
                }
                continue;
            }
            const id = `${part.key}|${part.way}`;
            if (all.has(id)) {
                continue;
            }
            all.add(id);
            const byValue = new Map<number, string>();
            for (const [value, , color] of editor.wantedPixels(part.key, part.way, sheet.scene) ?? []) {
                if (!color) {
                    continue;
                }
                // a value-0 pixel drawn opaque counts toward the sheet's colors too
                colors.set(color, (colors.get(color) ?? 0) + 1);
                if (!value) {
                    continue;
                }
                if (byValue.has(value) && byValue.get(value) !== color) {
                    expensive.add(id);
                }
                byValue.set(value, color);
            }
        }
        const order = (color: string): [number, number, number] => {
            const [r, g, b] = hexRgb(color).map(v => v / 255);
            const max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 2, chroma = max - min;
            if (chroma < 0.06) {
                return [0, 0, light];
            }
            const hue = max === r ? ((g - b) / chroma + 6) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
            return [1, Math.round(hue * 4), light];
        };
        // the 48 most used colors (what the swatches have room for), sorted by hue
        const sorted = [...colors].sort((a, b) => b[1] - a[1]).slice(0, 48).map(([color]) => color).sort((a, b) => {
            const [ga, ha, la] = order(a), [gb, hb, lb] = order(b);
            return ga - gb || ha - hb || la - lb;
        });
        return { expensive, characters: new Set([...all, ...cellCharacters]).size, colors: sorted };
    }, [parts, picture, editor.revision, rom]);

    React.useEffect(() => {
        setArea(undefined);
        setPolygon(undefined);
        setFloating(undefined);
        setHiddenLayers(new Set());
        setActiveLayers(new Set());
        setZoomChoice(undefined);
        setOffset(undefined);
    }, [sheet.id]);
    React.useEffect(() => {
        if (tool !== 'area' || options.areaShape !== 'polygon') {
            setPolygon(undefined);
        }
    }, [tool, options.areaShape]);
    const previousTool = React.useRef(tool);
    React.useEffect(() => {
        if (previousTool.current !== tool && floating) {
            putDown();
        }
        previousTool.current = tool;
    }, [tool]);

    React.useEffect(() => {
        const node = view.current;
        if (!node) {
            return;
        }
        const observer = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }));
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    const zoom = zoomChoice ?? fitted.zoom;
    const placed = (room: number, extent: number): number => extent <= room - 2 * PAD ? Math.floor((room - extent) / 2) : PAD;
    const left = offset?.x ?? placed(size.width, layout.width * zoom);
    const top = offset?.y ?? placed(size.height, layout.height * zoom);
    const focus = editor.focus?.sheet === sheet.id ? editor.focus.keys : undefined;
    // one outline around all of the picked figure's characters rather than a box around each
    const focusEdges = React.useMemo(() => focus ? outlineEdges(parts.filter(part => focus.has(part.key)), layout.width, layout.height) : [], [focus, parts]);

    React.useEffect(() => {
        const first = focus && parts.find(part => focus.has(part.key));
        if (!first || !size.width) {
            return;
        }
        const x = left + first.x * zoom;
        const y = top + first.y * zoom;
        if (x < 0 || x > size.width - 32 || y < 0 || y > size.height - 32) {
            setOffset({ x: left + size.width / 3 - x, y: top + size.height / 3 - y });
        }
    }, [focus, parts, zoom]);

    // --- drawing ------------------------------------------------------------

    const draw = (): void => {
        const node = canvas.current;
        const scroller = view.current;
        const context = node?.getContext('2d');
        if (!node || !scroller || !context) {
            return;
        }
        const ratio = window.devicePixelRatio || 1;
        if (node.width !== Math.round(size.width * ratio) || node.height !== Math.round(size.height * ratio)) {
            node.width = Math.round(size.width * ratio);
            node.height = Math.round(size.height * ratio);
        }
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, size.width, size.height);
        const ox = left;
        const oy = top;
        const w = layout.width * zoom;
        const h = layout.height * zoom;
        // under the picture: black for a whole screen in the original view or without a backdrop, as the VB shows
        // it; the backdrop in the colored view (a screen uses its rows, other sheets stretch it); else a checkerboard
        if (sheet.kind === 'screen' && (original || !backdrop)) {
            context.fillStyle = '#000000';
            context.fillRect(ox, oy, w, h);
        } else if (backdrop && !original) {
            const originY = sheet.kind === 'screen' ? sheet.origin?.[1] ?? 0 : 0;
            const y0 = Math.max(0, Math.floor(-oy / zoom));
            const y1 = Math.min(layout.height, Math.ceil((size.height - oy) / zoom));
            for (let y = y0; y < y1; y++) {
                const row = sheet.kind === 'screen'
                    ? Math.min(BACKDROP_ROWS - 1, Math.max(0, y - originY))
                    : Math.min(BACKDROP_ROWS - 1, Math.floor(y * BACKDROP_ROWS / layout.height));
                context.fillStyle = backdrop[row];
                context.fillRect(ox, oy + y * zoom, w, zoom);
            }
        } else {
            context.fillStyle = '#4a4a4a';
            context.fillRect(ox, oy, w, h);
            context.fillStyle = '#3c3c3c';
            // one checker square per character, 8 by 8 sheet pixels
            const check = Math.max(8, zoom * 8);
            for (let y = 0; y < h; y += check) {
                for (let x = (y / check) % 2 ? check : 0; x < w; x += check * 2) {
                    const cx = ox + x;
                    const cy = oy + y;
                    if (cx > size.width || cy > size.height || cx + check < 0 || cy + check < 0) {
                        continue;
                    }
                    context.fillRect(cx, cy, Math.min(check, w - x), Math.min(check, h - y));
                }
            }
            context.imageSmoothingEnabled = false;
            context.drawImage(veil, ox, oy, w, h);
        }
        context.imageSmoothingEnabled = false;
        context.drawImage(image, ox, oy, w, h);
        if (layout.labels.length) {
            const font = Math.max(10, Math.min(14, LABEL * zoom - 3));
            context.font = `${font}px system-ui, sans-serif`;
            context.textBaseline = 'bottom';
            context.fillStyle = 'rgba(255, 255, 255, 0.75)';
            for (const label of layout.labels) {
                context.fillText(label.text || nls.localize('vueport/color/sheet/otherFrames', 'Other'), ox + label.x * zoom, oy + (label.y + LABEL) * zoom - 2);
            }
        }
        const accent = getComputedStyle(node).getPropertyValue('--vp-accent').trim() || '#e53935';
        const outline = (part: PlacedPart, inset = 0): void =>
            context.strokeRect(ox + part.x * zoom + inset, oy + part.y * zoom + inset, 8 * zoom - 2 * inset, 8 * zoom - 2 * inset);
        // a pixel grid whenever pixels are large, regardless of the grid switch; the switch adds character outlines
        if (zoom >= 8) {
            context.strokeStyle = 'rgba(255, 255, 255, 0.08)';
            context.lineWidth = 1;
            context.beginPath();
            const x0 = Math.max(0, Math.floor(-ox / zoom));
            const x1 = Math.min(layout.width, Math.ceil((size.width - ox) / zoom));
            const y0 = Math.max(0, Math.floor(-oy / zoom));
            const y1 = Math.min(layout.height, Math.ceil((size.height - oy) / zoom));
            for (let x = x0; x <= x1; x++) {
                context.moveTo(ox + x * zoom + 0.5, oy + y0 * zoom);
                context.lineTo(ox + x * zoom + 0.5, oy + y1 * zoom);
            }
            for (let y = y0; y <= y1; y++) {
                context.moveTo(ox + x0 * zoom, oy + y * zoom + 0.5);
                context.lineTo(ox + x1 * zoom, oy + y * zoom + 0.5);
            }
            context.stroke();
        }
        if (grid) {
            context.strokeStyle = 'rgba(255, 255, 255, 0.18)';
            context.lineWidth = 1;
            parts.forEach(part => outline(part, 0.5));
        }
        if (costly) {
            context.strokeStyle = '#ffa726';
            context.lineWidth = 2;
            parts.forEach(part => cost.expensive.has(`${part.key}|${part.way}`) && outline(part, 1));
        }
        if (focusEdges.length) {
            context.strokeStyle = accent;
            context.lineWidth = 2;
            context.beginPath();
            for (const [x0, y0, x1, y1] of focusEdges) {
                context.moveTo(ox + x0 * zoom, oy + y0 * zoom);
                context.lineTo(ox + x1 * zoom, oy + y1 * zoom);
            }
            context.stroke();
        }
        const under = grid && hover && hover.part >= 0 ? parts[hover.part] : undefined;
        if (under) {
            context.strokeStyle = accent;
            context.lineWidth = 1;
            context.setLineDash([3, 3]);
            parts.forEach(part => part !== under && part.key === under.key && outline(part, 0.5));
            context.setLineDash([]);
            context.lineWidth = 1.5;
            outline(under, 0.75);
        }
        if (floating && floatingImage) {
            const fx = ox + floating.x * zoom;
            const fy = oy + floating.y * zoom;
            context.imageSmoothingEnabled = false;
            context.drawImage(floatingImage, fx, fy, floating.width * zoom, floating.height * zoom);
            context.lineWidth = 1;
            context.setLineDash([4, 3]);
            context.strokeStyle = '#ffffff';
            context.strokeRect(fx - 0.5, fy - 0.5, floating.width * zoom + 1, floating.height * zoom + 1);
            context.strokeStyle = '#000000';
            context.lineDashOffset = 3.5;
            context.strokeRect(fx - 0.5, fy - 0.5, floating.width * zoom + 1, floating.height * zoom + 1);
            context.lineDashOffset = 0;
            context.setLineDash([]);
        }
        if (hover && !panning && !original && editor.canPaint() && (tool === 'pencil' || tool === 'eraser')) {
            const tip = penTip(options.penSize, options.penShape);
            const from = -Math.floor((options.penSize - 1) / 2);
            const tx = ox + (hover.x + from) * zoom;
            const ty = oy + (hover.y + from) * zoom;
            if (tool === 'pencil') {
                context.globalAlpha = 0.6;
                context.fillStyle = editor.brushColor;
                tip.forEach(([x, y]) => context.fillRect(tx + x * zoom, ty + y * zoom, zoom, zoom));
                context.globalAlpha = 1;
            }
            const inTip = new Set(tip.map(([x, y]) => `${x},${y}`));
            const edge = new Path2D();
            for (const [x, y] of tip) {
                const [x0, y0, x1, y1] = [tx + x * zoom, ty + y * zoom, tx + (x + 1) * zoom, ty + (y + 1) * zoom];
                if (!inTip.has(`${x},${y - 1}`)) {
                    edge.moveTo(x0, y0);
                    edge.lineTo(x1, y0);
                }
                if (!inTip.has(`${x},${y + 1}`)) {
                    edge.moveTo(x0, y1);
                    edge.lineTo(x1, y1);
                }
                if (!inTip.has(`${x - 1},${y}`)) {
                    edge.moveTo(x0, y0);
                    edge.lineTo(x0, y1);
                }
                if (!inTip.has(`${x + 1},${y}`)) {
                    edge.moveTo(x1, y0);
                    edge.lineTo(x1, y1);
                }
            }
            context.lineWidth = 3;
            context.strokeStyle = '#000000';
            context.stroke(edge);
            context.lineWidth = 1;
            context.strokeStyle = '#ffffff';
            context.stroke(edge);
        }
        if (area) {
            context.save();
            context.translate(ox, oy);
            context.scale(zoom, zoom);
            context.lineWidth = 1 / zoom;
            context.setLineDash([4 / zoom, 3 / zoom]);
            context.strokeStyle = '#ffffff';
            context.stroke(area.edges);
            context.strokeStyle = '#000000';
            context.lineDashOffset = 3.5 / zoom;
            context.stroke(area.edges);
            context.restore();
        }
        const current = gesture.current;
        if (current?.kind === 'rectangle') {
            context.fillStyle = editor.brushColor;
            context.globalAlpha = 0.75;
            for (const [px, py] of shapePixels(current)) {
                if (changeAt(px, py, null)) {
                    context.fillRect(ox + px * zoom, oy + py * zoom, zoom, zoom);
                }
            }
            context.globalAlpha = 1;
        }
        const box = current?.kind === 'rectangle' || current?.kind === 'area' ? areaOf(current.from, current.to) : undefined;
        const drawn = new Path2D();
        if (current?.kind === 'rectangle' && current.shape === 'line') {
            drawn.moveTo(ox + (current.from[0] + 0.5) * zoom, oy + (current.from[1] + 0.5) * zoom);
            drawn.lineTo(ox + (current.to[0] + 0.5) * zoom, oy + (current.to[1] + 0.5) * zoom);
        } else if (box && ((current?.kind === 'area' && options.areaShape === 'ellipse') || (current?.kind === 'rectangle' && current.shape === 'ellipse'))) {
            const rx = (box.x1 - box.x0 + 1) * zoom / 2;
            const ry = (box.y1 - box.y0 + 1) * zoom / 2;
            drawn.ellipse(ox + box.x0 * zoom + rx, oy + box.y0 * zoom + ry, Math.max(0.5, rx - 0.5), Math.max(0.5, ry - 0.5), 0, 0, 2 * Math.PI);
        } else if (box) {
            drawn.rect(ox + box.x0 * zoom + 0.5, oy + box.y0 * zoom + 0.5, (box.x1 - box.x0 + 1) * zoom - 1, (box.y1 - box.y0 + 1) * zoom - 1);
        } else if (polygon && tool === 'area') {
            const at = ([px, py]: [number, number]): [number, number] => [ox + (px + 0.5) * zoom, oy + (py + 0.5) * zoom];
            polygon.points.forEach((point, i) => (i ? drawn.lineTo : drawn.moveTo).call(drawn, ...at(point)));
            if (hover) {
                drawn.lineTo(...at([hover.x, hover.y]));
            }
        }
        if (box || (polygon && tool === 'area')) {
            context.lineWidth = 1;
            context.setLineDash([4, 3]);
            context.strokeStyle = '#ffffff';
            context.stroke(drawn);
            context.strokeStyle = '#000000';
            context.lineDashOffset = 3.5;
            context.stroke(drawn);
            context.lineDashOffset = 0;
            context.setLineDash([]);
            if (polygon && tool === 'area') {
                context.fillStyle = '#ffffff';
                for (const [px, py] of polygon.points) {
                    context.fillRect(ox + (px + 0.5) * zoom - 2, oy + (py + 0.5) * zoom - 2, 4, 4);
                }
            }
        }
    };
    React.useEffect(draw);

    // --- the pointer --------------------------------------------------------

    const sheetPoint = (event: { clientX: number, clientY: number }): [number, number] => {
        const box = canvas.current!.getBoundingClientRect();
        return [
            Math.floor((event.clientX - box.left - left) / zoom),
            Math.floor((event.clientY - box.top - top) / zoom),
        ];
    };
    const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < picture.width && y < picture.height;
    const inArea = (x: number, y: number): boolean => !area || area.width !== picture.width || area.height !== picture.height
        || !!area.mask[y * area.width + x];
    const partAt = (x: number, y: number): number => {
        if (inside(x, y) && picture.part[y * picture.width + x] >= 0) {
            return picture.part[y * picture.width + x];
        }
        return parts.findIndex(part => x >= part.x && x < part.x + 8 && y >= part.y && y < part.y + 8);
    };
    const changeAt = (x: number, y: number, color: string | null, anywhere = false): ColorPixelChange | undefined => {
        if (!inside(x, y) || (!anywhere && !inArea(x, y))) {
            return undefined;
        }
        const at = y * picture.width + x;
        const part = parts[picture.part[at]];
        // a transparent pixel nobody painted has nothing to erase
        if (color === '' && picture.clear[at] === 2) {
            return undefined;
        }
        return part && !part.locked && !part.fixed && !part.byCell ? { key: part.key, way: part.way, i: picture.pixel[at], color } : undefined;
    };
    const colorAt = (x: number, y: number): string | undefined => {
        if (!inside(x, y) || picture.part[y * picture.width + x] < 0) {
            return undefined;
        }
        const at = (y * picture.width + x) * 4;
        if (picture.rgba[at + 3] === 0) {
            return '';      // painted transparent
        }
        return formatHexColor([picture.rgba[at], picture.rgba[at + 1], picture.rgba[at + 2]]);
    };
    // shows a change on the picture during the gesture; the editor gets all of them at the end as one step
    const preview = (x: number, y: number, color: string | null): void => {
        const context = image.getContext('2d')!;
        if (color) {
            context.fillStyle = color;
            context.fillRect(x, y, 1, 1);
        } else {
            context.clearRect(x, y, 1, 1);
        }
    };
    // the eraser paints '' (transparent), stored as the pixel slot 0xFF, which VB Color never draws
    const brush = (): string | null => tool === 'eraser' ? '' : editor.brushColor;
    const stroke = (changes: Map<string, ColorPixelChange>, x: number, y: number): void => {
        const from = -Math.floor((options.penSize - 1) / 2);
        for (const [tx, ty] of penTip(options.penSize, options.penShape)) {
            const [px, py] = [x + from + tx, y + from + ty];
            const change = changeAt(px, py, brush());
            if (change) {
                changes.set(`${change.key}|${change.way}|${change.i}`, change);
                preview(px, py, change.color);
            }
        }
    };
    const commit = (changes: Iterable<ColorPixelChange>): void => {
        const list = [...changes];
        if (list.length) {
            editor.paintPixels(list);
        }
    };
    // every colored pixel of every paintable character (within the area, if any), covered ones included: where parts
    // overlap, the one behind gets the pixel as well
    const everyPixel = (each: (part: PlacedPart, i: number, value: number, shade: number, color: string) => ColorPixelChange | undefined): ColorPixelChange[] => {
        const out = new Map<string, ColorPixelChange>();
        for (const part of parts) {
            if (part.locked || part.fixed || part.byCell) {
                continue;
            }
            const pixels = editor.wantedPixels(part.key, part.way, sheet.scene);
            for (let i = 0; i < 64 && pixels; i++) {
                const [value, shade, color] = pixels[i];
                const x = part.x + (part.h ? 7 - (i & 7) : i & 7);
                const y = part.y + (part.v ? 7 - (i >> 3) : i >> 3);
                if (!color || !inArea(x, y)) {
                    continue;
                }
                const change = each(part, i, value, shade, color);
                if (change) {
                    out.set(`${change.key}|${change.way}|${change.i}`, change);
                }
            }
        }
        return [...out.values()];
    };
    // a value-0 pixel painted opaque goes back to transparent, as the original draws it
    const reset = (to: 'red' | 'package'): void => commit(everyPixel((part, i, value, shade) =>
        ({ key: part.key, way: part.way, i, color: to === 'red' && value ? RED_PALETTE[shade & 3] : null })));
    const flood = (x: number, y: number): ColorPixelChange[] => {
        const start = y * picture.width + x;
        if (!inside(x, y) || picture.part[start] < 0) {
            return [];
        }
        const same = (at: number): boolean => picture.part[at] >= 0
            && picture.rgba[at * 4] === picture.rgba[start * 4]
            && picture.rgba[at * 4 + 1] === picture.rgba[start * 4 + 1]
            && picture.rgba[at * 4 + 2] === picture.rgba[start * 4 + 2];
        const seen = new Uint8Array(picture.width * picture.height);
        const queue = [start];
        const out: ColorPixelChange[] = [];
        seen[start] = 1;
        while (queue.length) {
            const at = queue.pop()!;
            const change = changeAt(at % picture.width, Math.floor(at / picture.width), brush());
            if (change) {
                out.push(change);
            }
            const px = at % picture.width;
            for (const next of [px > 0 ? at - 1 : -1, px < picture.width - 1 ? at + 1 : -1, at - picture.width, at + picture.width]) {
                if (next >= 0 && next < seen.length && !seen[next] && same(next)) {
                    seen[next] = 1;
                    queue.push(next);
                }
            }
        }
        return out;
    };

    // --- the area's pixels: lifted, copied, cut, pasted ------------------------

    const grab = (): Floating | undefined => {
        if (!area || area.width !== picture.width || area.height !== picture.height) {
            return undefined;
        }
        let x0 = picture.width;
        let y0 = picture.height;
        let x1 = -1;
        let y1 = -1;
        for (let y = 0; y < picture.height; y++) {
            for (let x = 0; x < picture.width; x++) {
                if (area.mask[y * picture.width + x]) {
                    x0 = Math.min(x0, x);
                    y0 = Math.min(y0, y);
                    x1 = Math.max(x1, x);
                    y1 = Math.max(y1, y);
                }
            }
        }
        if (x1 < 0) {
            return undefined;
        }
        const width = x1 - x0 + 1;
        const height = y1 - y0 + 1;
        const pixels: (string | null)[] = new Array(width * height).fill(null);
        const lifted: ColorPixelChange[] = [];
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const change = area.mask[y * picture.width + x] ? changeAt(x, y, null) : undefined;
                if (change) {
                    pixels[(y - y0) * width + x - x0] = colorAt(x, y) ?? null;
                    lifted.push(change);
                }
            }
        }
        return { width, height, pixels, x: x0, y: y0, lifted };
    };
    const putDown = (done: Floating | undefined = floating): void => {
        setFloating(undefined);
        if (!done) {
            return;
        }
        const changes = new Map<string, ColorPixelChange>();
        for (const change of done.lifted) {
            changes.set(`${change.key}|${change.way}|${change.i}`, change);
        }
        const mask = new Uint8Array(picture.width * picture.height);
        done.pixels.forEach((color, i) => {
            const x = done.x + i % done.width;
            const y = done.y + Math.floor(i / done.width);
            if (color === null || !inside(x, y)) {
                return;
            }
            mask[y * picture.width + x] = 1;
            const change = changeAt(x, y, color, true);
            if (change) {
                changes.set(`${change.key}|${change.way}|${change.i}`, change);
            }
        });
        commit(changes.values());
        setArea(chosenOf(picture.width, picture.height, mask));
    };
    const copy = (): void => {
        const got = grab();
        if (got) {
            editor.clipboard = { width: got.width, height: got.height, pixels: got.pixels, x: got.x, y: got.y, sheet: sheet.id };
        }
    };
    const cut = (): void => {
        const got = grab();
        if (got) {
            editor.clipboard = { width: got.width, height: got.height, pixels: got.pixels, x: got.x, y: got.y, sheet: sheet.id };
            commit(got.lifted);
        }
    };
    const paste = (): void => {
        const clip = editor.clipboard;
        if (!clip) {
            return;
        }
        putDown();
        const there = clip.sheet === sheet.id ? [clip.x, clip.y] : hover && inside(hover.x, hover.y) ? [hover.x, hover.y] : [0, 0];
        setFloating({ width: clip.width, height: clip.height, pixels: clip.pixels, x: there[0], y: there[1], lifted: [] });
        setArea(undefined);
    };
    const inFloating = (x: number, y: number): boolean => !!floating
        && x >= floating.x && y >= floating.y && x < floating.x + floating.width && y < floating.y + floating.height;

    // the pixels a rectangle, ellipse or line being drawn covers: filled, or its outline rectStroke pixels wide
    // (inwards); a line is a square of lineWidth pixels at each of its pixels
    const shapePixels = (shape: Extract<Gesture, { kind: 'rectangle' }>): [number, number][] => {
        const out: [number, number][] = [];
        if (shape.shape === 'line') {
            const seen = new Set<number>();
            const size = options.lineWidth;
            const from = -Math.floor((size - 1) / 2);
            for (const [px, py] of line(shape.from[0], shape.from[1], shape.to[0], shape.to[1])) {
                for (let dy = from; dy < from + size; dy++) {
                    for (let dx = from; dx < from + size; dx++) {
                        const id = (py + dy) * 65536 + px + dx;
                        if (!seen.has(id)) {
                            seen.add(id);
                            out.push([px + dx, py + dy]);
                        }
                    }
                }
            }
            return out;
        }
        const box = areaOf(shape.from, shape.to);
        const width = options.rectFill ? Infinity : options.rectStroke;
        const ellipse = shape.shape === 'ellipse';
        for (let y = Math.max(0, box.y0); y <= Math.min(picture.height - 1, box.y1); y++) {
            for (let x = Math.max(0, box.x0); x <= Math.min(picture.width - 1, box.x1); x++) {
                if (ellipse
                    ? !inEllipse(box, x, y) || (width !== Infinity && inEllipse(box, x, y, width))
                    : x >= box.x0 + width && x <= box.x1 - width && y >= box.y0 + width && y <= box.y1 - width) {
                    continue;
                }
                out.push([x, y]);
            }
        }
        return out;
    };

    const closePolygon = (done: { points: [number, number][], mode: SheetToolOptions['areaMode'] }): void => {
        setPolygon(undefined);
        if (done.points.length >= 3) {
            chooseArea(previous => choose(previous, polygonShape(done.points), done.mode, picture.width, picture.height));
        }
    };

    const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        view.current?.focus();
        if (event.button === 1 || spaceDown.current || (event.button === 0 && tool === 'hand')) {
            gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY, left, top };
            event.currentTarget.setPointerCapture(event.pointerId);
            setPanning('drag');
            return;
        }
        if (event.button !== 0) {
            return;
        }
        const [x, y] = sheetPoint(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        if (floating) {
            if (inFloating(x, y)) {
                gesture.current = { kind: 'float', from: [x, y], at: [floating.x, floating.y], drop: false };
            } else {
                putDown();
            }
            return;
        }
        if (tool === 'area' && !original && !event.shiftKey && !event.altKey && options.areaShape !== 'polygon' && inArea(x, y) && area) {
            const lifted = grab();
            if (lifted) {
                setFloating(lifted);
                setArea(undefined);
                gesture.current = { kind: 'float', from: [x, y], at: [lifted.x, lifted.y], drop: true };
                return;
            }
        }
        if (tool === 'area') {
            const mode = event.shiftKey ? 'add' : event.altKey ? 'remove' : areaMode;
            if (options.areaShape === 'polygon') {
                const first = polygon?.points[0];
                const nearFirst = first && polygon!.points.length > 2
                    && Math.abs((first[0] - x) * zoom) <= Math.max(6, zoom) && Math.abs((first[1] - y) * zoom) <= Math.max(6, zoom);
                // a pointer event has no click count: a double click is a second click within 400 ms and 4 pixels
                const last = lastClick.current;
                const double = !!last && event.timeStamp - last.time < 400
                    && Math.abs(event.clientX - last.x) <= 4 && Math.abs(event.clientY - last.y) <= 4;
                lastClick.current = double ? undefined : { time: event.timeStamp, x: event.clientX, y: event.clientY };
                if (polygon && (double || nearFirst)) {
                    closePolygon(polygon);
                } else {
                    setPolygon(previous => ({ points: [...previous?.points ?? [], [x, y]], mode: previous?.mode ?? mode }));
                }
                return;
            }
            gesture.current = { kind: 'area', from: [x, y], to: [x, y], mode };
            return;
        }
        if (original) {
            return;     // the original view is read-only
        }
        if (!editor.canPaint() && tool !== 'pipette' && !event.altKey) {
            return;     // the active paint layer is hidden
        }
        if (tool === 'pipette' || event.altKey) {
            const color = colorAt(x, y);
            if (color) {
                editor.setBrushColor(color);        // the pipette stays selected, so more colors can be picked
            }
            return;
        }
        switch (tool) {
            case 'pencil':
            case 'eraser': {
                const changes = new Map<string, ColorPixelChange>();
                stroke(changes, x, y);
                gesture.current = { kind: 'stroke', changes, last: [x, y] };
                draw();
                break;
            }
            case 'fill': {
                const from = colorAt(x, y);
                if (options.fillMode === 'all') {
                    // on a figure sheet with no layer chosen, the layer clicked on (its depth in every picture): a color a
                    // figure's head and feet share (Jack Frost's yellow horn tips and feet) stays where it is on the
                    // layers not clicked, covered pixels of those included. Chosen layers: those (the others are locked)
                    const clicked = inside(x, y) ? parts[picture.part[y * picture.width + x]] : undefined;
                    const layer = sheet.kind !== 'screen' && !activeLayers.size ? clicked?.depth : undefined;
                    if (from) {
                        commit(everyPixel((part, i, value, shade, color) =>
                            color === from && (layer === undefined || part.depth === layer)
                                ? { key: part.key, way: part.way, i, color: brush() } : undefined));
                    }
                } else {
                    commit(flood(x, y));
                }
                break;
            }
            case 'rectangle':
            case 'ellipse':
            case 'line':
                gesture.current = { kind: 'rectangle', shape: tool, from: [x, y], to: [x, y], square: event.shiftKey };
                break;
        }
    };

    const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        const current = gesture.current;
        if (current?.kind === 'pan') {
            setOffset({ x: current.left + event.clientX - current.x, y: current.top + event.clientY - current.y });
            return;
        }
        const [x, y] = sheetPoint(event);
        if (current?.kind === 'stroke') {
            for (const [px, py] of line(current.last[0], current.last[1], x, y)) {
                stroke(current.changes, px, py);
            }
            current.last = [x, y];
        } else if (current?.kind === 'rectangle') {
            current.square = event.shiftKey;
            current.to = constrained(current.from, [x, y], current.shape, current.square);
        } else if (current?.kind === 'area') {
            current.to = [x, y];
        } else if (current?.kind === 'float') {
            const nx = current.at[0] + x - current.from[0];
            const ny = current.at[1] + y - current.from[1];
            const now = floatingNow.current;
            if (now && (now.x !== nx || now.y !== ny)) {
                floatingNow.current = { ...now, x: nx, y: ny };
                setFloating(floatingNow.current);
            }
        }
        const part = partAt(x, y);
        if (hover?.x !== x || hover?.y !== y || hover?.part !== part) {
            setHover({ x, y, part });
        } else {
            draw();
        }
    };

    const onPointerUp = (): void => {
        const current = gesture.current;
        gesture.current = undefined;
        if (current?.kind === 'pan') {
            setPanning(spaceDown.current ? 'ready' : undefined);
        }
        if (current?.kind === 'float' && current.drop) {
            putDown(floatingNow.current);
        }
        if (current?.kind === 'stroke') {
            commit(current.changes.values());
        } else if (current?.kind === 'rectangle') {
            const changes = new Map<string, ColorPixelChange>();
            for (const [px, py] of shapePixels(current)) {
                const change = changeAt(px, py, brush());
                if (change) {
                    changes.set(`${change.key}|${change.way}|${change.i}`, change);
                }
            }
            commit(changes.values());
        } else if (current?.kind === 'area') {
            const box = areaOf(current.from, current.to);
            if (current.mode === 'replace' && box.x0 === box.x1 && box.y0 === box.y1) {
                chooseArea(undefined);
            } else {
                const shape = options.areaShape === 'ellipse' ? ellipseShape(box) : boxShape(box);
                chooseArea(previous => choose(previous, shape, current.mode, picture.width, picture.height));
            }
        }
        draw();
    };

    const zoomTo = (next: number, at?: { clientX: number, clientY: number }): void => {
        const node = canvas.current;
        setZoomChoice(next);
        if (!node) {
            return;
        }
        // the sheet's point under the pointer (or the view's middle) stays where it is
        const box = node.getBoundingClientRect();
        const px = at ? at.clientX - box.left : size.width / 2;
        const py = at ? at.clientY - box.top : size.height / 2;
        setOffset({ x: Math.round(px - (px - left) / zoom * next), y: Math.round(py - (py - top) / zoom * next) });
    };
    const fit = (): void => {
        setZoomChoice(undefined);
        setOffset(undefined);
    };
    const panBy = (dx: number, dy: number): void => setOffset({ x: left - dx, y: top - dy });
    const panRef = React.useRef(panBy);
    panRef.current = panBy;
    const step = (direction: 1 | -1, at?: { clientX: number, clientY: number }): void => {
        const next = direction > 0 ? ZOOMS.find(z => z > zoom) : [...ZOOMS].reverse().find(z => z < zoom);
        if (next) {
            zoomTo(next, at);
        }
    };
    const stepRef = React.useRef(step);
    stepRef.current = step;
    React.useEffect(() => {
        const node = view.current;
        if (!node) {
            return;
        }
        const onWheel = (event: WheelEvent): void => {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey || event.altKey) { // a trackpad pinch arrives as Ctrl+wheel
                stepRef.current(event.deltaY < 0 ? 1 : -1, event);
            } else {
                panRef.current(event.deltaX, event.deltaY);
            }
        };
        node.addEventListener('wheel', onWheel, { passive: false });
        return () => node.removeEventListener('wheel', onWheel);
    }, []);

    // floating pixels not put down yet: Undo drops them first as a step of its own, and Redo brings them back
    React.useEffect(() => {
        const undo = (event: KeyboardEvent): void => {
            const now = floatingNow.current;
            if (!now || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'z') {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            floatingNow.current = undefined;
            setFloating(undefined);
            const on = sheet.id;
            editor.pushViewStep({
                undo: () => undefined,
                redo: () => {
                    if (sheetNow.current === on) {
                        floatingNow.current = now;
                        setFloating(now);
                    }
                },
            });
            // push the step and undo it right away, so it waits on the Redo side
            editor.undo();
        };
        window.addEventListener('keydown', undo, true);
        return () => window.removeEventListener('keydown', undo, true);
    }, [sheet.id]);

    const [heldMode, setHeldMode] = React.useState<'add' | 'remove' | undefined>(undefined);
    React.useEffect(() => {
        const update = (event: KeyboardEvent): void => setHeldMode(event.shiftKey ? 'add' : event.altKey ? 'remove' : undefined);
        const clear = (): void => setHeldMode(undefined);
        window.addEventListener('keydown', update, true);
        window.addEventListener('keyup', update, true);
        window.addEventListener('blur', clear);
        return () => {
            window.removeEventListener('keydown', update, true);
            window.removeEventListener('keyup', update, true);
            window.removeEventListener('blur', clear);
        };
    }, []);
    const areaMode = heldMode ?? options.areaMode;

    // holding Space over the view switches to the hand; listened for on the window, since the view need not have the
    // focus and the game must not get the key
    React.useEffect(() => {
        const typing = (event: KeyboardEvent): boolean => !!(event.target as HTMLElement | null)?.closest?.('input, textarea');
        const down = (event: KeyboardEvent): void => {
            if (event.key !== ' ' || typing(event) || (!pointerInside.current && !spaceDown.current)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (!spaceDown.current) {
                spaceDown.current = true;
                setPanning(previous => previous ?? 'ready');
            }
        };
        const up = (event: KeyboardEvent): void => {
            if (event.key === ' ' && spaceDown.current) {
                spaceDown.current = false;
                setPanning(previous => previous === 'ready' ? undefined : previous);
            }
        };
        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        return () => {
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
        };
    }, []);

    // holding O over the view (or with it focused) shows the original, Colored / Original switch included, until it is
    // released
    const originalHeld = React.useRef<{ before: boolean } | undefined>(undefined);
    const originalNow = React.useRef(original);
    originalNow.current = original;
    React.useEffect(() => {
        const typing = (event: KeyboardEvent): boolean => !!(event.target as HTMLElement | null)?.closest?.('input, textarea');
        const release = (): void => {
            const held = originalHeld.current;
            if (held) {
                originalHeld.current = undefined;
                setOriginal(held.before);
            }
        };
        const down = (event: KeyboardEvent): void => {
            if (event.key.toLowerCase() !== 'o' || event.ctrlKey || event.metaKey || event.altKey || typing(event)) {
                return;
            }
            const focused = !!view.current && view.current.contains(document.activeElement);
            if (!originalHeld.current && !pointerInside.current && !focused) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (!originalHeld.current) {
                originalHeld.current = { before: originalNow.current };
                setOriginal(true);
            }
        };
        const up = (event: KeyboardEvent): void => {
            if (event.key.toLowerCase() === 'o') {
                release();
            }
        };
        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        window.addEventListener('blur', release);
        return () => {
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
            window.removeEventListener('blur', release);
        };
    }, []);

    const onKeyDown = (event: React.KeyboardEvent | KeyboardEvent): void => {
        // both the view and the editor around it listen, so skip a key the view already handled
        if (event.defaultPrevented || (event.target as HTMLElement).closest('input, textarea')) {
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            const command = event.key.toLowerCase();
            if (command === 'a') {
                event.preventDefault();
                chooseArea(chosenOf(picture.width, picture.height, new Uint8Array(picture.width * picture.height).fill(1)));
            } else if (command === 'c' || command === 'x' || command === 'v') {
                event.preventDefault();
                if (command === 'v') {
                    paste();
                } else if (!original) {
                    (command === 'c' ? copy : cut)();
                }
            }
            return;
        }
        const tools: { [key: string]: SheetTool } = { m: 'area', b: 'pencil', e: 'eraser', g: 'fill', r: 'rectangle', u: 'ellipse', l: 'line', i: 'pipette', h: 'hand' };
        const chosen = tools[event.key.toLowerCase()];
        if (chosen) {
            setTool(chosen);
        } else if (event.key.toLowerCase() === 'x') {
            editor.nextBrush(event.shiftKey ? -1 : 1);
        } else if (event.key === '[' || event.key === ']') {
            sizeStep(event.key === ']' ? 1 : -1);
        } else if (event.key === '+' || event.key === '=') {
            step(1);
        } else if (event.key === '-') {
            step(-1);
        } else if (event.key === '0') {
            fit();
        } else if (floating && event.key.startsWith('Arrow')) {
            const by = event.shiftKey ? 8 : 1;
            const [dx, dy] = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] }[event.key] ?? [0, 0];
            setFloating({ ...floating, x: floating.x + dx, y: floating.y + dy });
        } else if (event.key === 'Enter' && floating) {
            putDown();
        } else if ((event.key === 'Delete' || event.key === 'Backspace') && !original) {
            if (floating) {
                setFloating(undefined);
            } else if (area) {
                reset('package');
            }
        } else if (event.key === 'Enter' && polygon) {
            closePolygon(polygon);
        } else if (event.key === 'Escape') {
            if (floating) {
                setFloating(undefined);
            } else if (polygon) {
                setPolygon(undefined);
            } else {
                chooseArea(undefined);
            }
        } else {
            return;
        }
        event.preventDefault();
    };

    // the tool keys also work while the focus is elsewhere in the color editor (the project tree after picking a sheet,
    // a color well after picking a color) or nowhere (a closed pop-up leaves it on the page), so that the person need
    // not click into the sheet first; not in text fields, not with modifiers, and only the keys that just choose a tool,
    // brush, size or zoom (Escape, Enter, arrows, Delete stay with what has the focus)
    const keyDownNow = React.useRef(onKeyDown);
    keyDownNow.current = onKeyDown;
    React.useEffect(() => {
        const away = (event: KeyboardEvent): void => {
            const target = event.target as HTMLElement | null;
            const root = view.current?.closest('.vp-color-sheet');
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !root || !view.current?.isConnected
                || view.current.offsetParent === null || (target && root.contains(target))
                || !/^[a-z\[\]+=\-0]$/i.test(event.key)) {
                return;
            }
            const nowhere = !target || target === document.body || target === document.documentElement;
            if (!nowhere && (!target.closest('.vp-color-panel')
                || target.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable="true"]'))) {
                return;
            }
            keyDownNow.current(event);
        };
        window.addEventListener('keydown', away);
        return () => window.removeEventListener('keydown', away);
    }, []);

    // a click elsewhere in the color editor (the project tree, a panel's button, a color picker) hands the keyboard to
    // the sheet, not to the game: the emulator gives it to the game on every click (emulator-input.ts, clickListener)
    // unless what has the focus keeps its own keys, and the tool keys are game keys too. Capture, so this comes first.
    // Text fields keep the focus, and so does what the sheet holds itself
    React.useEffect(() => {
        const click = (event: MouseEvent): void => {
            const target = event.target as HTMLElement | null;
            const shown = view.current;
            // a color picker counts when its well is one of the color editor's (the same picker serves the settings)
            const picker = !!target?.closest('[data-color-picker]')
                && !!document.querySelector('.vp-color-panel [aria-haspopup="dialog"][aria-expanded="true"]');
            if (event.detail === 0 || !target || !shown?.isConnected || shown.offsetParent === null
                || !(picker || target.closest('.vp-color-panel'))) {
                return;
            }
            const field = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable="true"]';
            const active = document.activeElement as HTMLElement | null;
            if (target.closest(field) || active?.closest?.(field) || (active && shown.closest('.vp-color-sheet')?.contains(active))) {
                return;
            }
            shown.focus({ preventScroll: true });
        };
        document.addEventListener('click', click, true);
        return () => document.removeEventListener('click', click, true);
    }, []);

    // --- what is under the pointer ------------------------------------------

    const hovered = hover && hover.part >= 0 ? parts[hover.part] : undefined;
    const hoverAt = hover && inside(hover.x, hover.y) ? hover.y * picture.width + hover.x : -1;
    const uses = hovered ? parts.filter(part => part.key === hovered.key).length : 0;
    const status = hovered
        ? [
            nls.localize('vueport/color/sheet/at', '{0}, {1}', hover!.x, hover!.y),
            editor.packageIndex?.kind === 'contexts'
                ? nls.localize('vueport/color/sheet/character', 'Character {0}', hovered.key)
                : hovered.charKey && hovered.key !== hovered.charKey && hovered.cell !== undefined
                    ? nls.localize('vueport/color/sheet/cell', 'Cell {0} (load position {1}): its own colors', hovered.cell, hovered.charKey)
                    : nls.localize('vueport/color/sheet/position', 'Load position {0}', hovered.key),
            ...(hoverAt >= 0 && picture.part[hoverAt] === hover!.part
                ? [nls.localize('vueport/color/value', 'value {0}', picture.value[hoverAt])] : []),
            ...(hoverAt >= 0 && picture.part[hoverAt] === hover!.part && picture.clear[hoverAt]
                ? [nls.localize('vueport/color/sheet/transparentHint',
                    'transparent in the game: painted, it covers what lies behind it (meant for backgrounds, rarely right on figures; the eraser makes it transparent again)')]
                : []),
            ...(uses > 1 ? [nls.localize('vueport/color/sheet/uses', '{0} times on this sheet', uses)] : []),
            ...(cost.expensive.has(`${hovered.key}|${hovered.way}`)
                ? [nls.localize('vueport/color/sheet/perPixel', 'colors per pixel')] : []),
            ...(hovered.byCell ? [nls.localize('vueport/color/sheet/byCell', 'colored per cell: painting does not reach it')] : []),
            ...(/^\d+:m:/.test(hovered.key) ? [nls.localize('vueport/color/sheet/mapCells', 'painted on every cell of this character in its BG map')] : []),
            ...(/^\d+:c:/.test(hovered.key) ? [nls.localize('vueport/color/sheet/oneCell', 'painted on this cell alone')] : []),
        ].join(' · ')
        : hover && inside(hover.x, hover.y) ? nls.localize('vueport/color/sheet/at', '{0}, {1}', hover.x, hover.y) : '';

    const shownTool: SheetTool = panning ? 'hand' : tool;
    const toolButton = (id: SheetTool, icon: React.ReactNode, label: string, key: string): React.ReactNode => <button
        key={id}
        type='button'
        className={`vp-color-tool-button${shownTool === id ? ' on' : ''}`}
        title={`${label} (${key})`}
        aria-pressed={shownTool === id}
        data-tool={id}
        disabled={original && id !== 'area' && id !== 'hand'}
        onClick={() => setTool(id)}
    >{icon}</button>;

    // --- the tool's options, beside Undo and Redo ----------------------------

    const sizeStep = (direction: 1 | -1): void => {
        const name = tool === 'rectangle' || tool === 'ellipse' ? 'rectStroke' : tool === 'line' ? 'lineWidth' : 'penSize';
        const at = SHEET_TOOL_SIZES.indexOf(options[name]);
        const next = SHEET_TOOL_SIZES[Math.max(0, Math.min(SHEET_TOOL_SIZES.length - 1, (at < 0 ? 0 : at) + direction))];
        editor.setToolOption(name, next);
    };
    const radio = <T extends string | number | boolean>(data: string, value: T, choices: { value: T, label: string | React.ReactElement, tooltip?: string }[],
        change: (value: T) => void, disabled = false): React.ReactNode => <span className='vp-color-tool-options' data-option={data} key={data}>
        <RadioSelect
            size='small'
            options={choices.map(choice => ({ value: choice.value, label: choice.label, tooltip: choice.tooltip }))}
            defaultValue={value}
            disabled={disabled}
            onChange={chosen => chosen.length && change(chosen[0].value as T)}
        />
    </span>;
    const sizes = (name: 'penSize' | 'rectStroke' | 'lineWidth', disabled = false): React.ReactNode => {
        const at = Math.max(0, SHEET_TOOL_SIZES.indexOf(options[name]));
        const last = SHEET_TOOL_SIZES.length - 1;
        return <span className='vp-color-tool-options' data-option={name} key={name}>
            <input
                type='range'
                className='vp-color-tool-size'
                min={0}
                max={last}
                step={1}
                value={at}
                disabled={disabled}
                title={nls.localize('vueport/color/sheet/option/size', '{0} pixels ([ and ] change it)', SHEET_TOOL_SIZES[at])}
                aria-valuetext={String(SHEET_TOOL_SIZES[at])}
                style={{ '--range-fill': `${Math.round(at / last * 100)}%` } as React.CSSProperties}
                onChange={event => editor.setToolOption(name, SHEET_TOOL_SIZES[Number(event.currentTarget.value)])}
            />
        </span>;
    };
    const toolOptions = (): React.ReactNode => {
        switch (tool) {
            case 'pencil':
            case 'eraser':
                return <>
                    <span className='vp-color-toolbar-divider' />
                    {/* tip shape (1 and 2 pixel tips look the same either way) */}
                    {radio('penShape', options.penShape, [
                        { value: 'square', label: <Square size={14} />, tooltip: nls.localize('vueport/color/sheet/option/squareTip', 'Square') },
                        { value: 'circle', label: <Circle size={14} />, tooltip: nls.localize('vueport/color/sheet/option/circleTip', 'Circle') },
                    ], shape => editor.setToolOption('penShape', shape))}
                    {sizes('penSize')}
                </>;
            case 'area':
                return <>
                    <span className='vp-color-toolbar-divider' />
                    {radio('areaShape', options.areaShape, [
                        { value: 'rectangle', label: <Square size={14} />,
                            tooltip: nls.localize('vueport/color/sheet/option/rectangleShape', 'Rectangle: drag a box') },
                        { value: 'ellipse', label: <Circle size={14} />,
                            tooltip: nls.localize('vueport/color/sheet/option/ellipseShape', 'Ellipse: drag the box around it') },
                        { value: 'polygon', label: <Polygon size={14} />,
                            tooltip: nls.localize('vueport/color/sheet/option/polygonShape', 'Polygon: click its points; a double click, the first point or Enter closes it, Esc lets it go') },
                    ], shape => editor.setToolOption('areaShape', shape))}
                    {radio('areaMode', areaMode, [
                        { value: 'replace', label: nls.localize('vueport/color/sheet/option/replace', 'Replace'),
                            tooltip: nls.localize('vueport/color/sheet/option/replaceHint', 'Dragging makes a new area') },
                        { value: 'add', label: nls.localize('vueport/color/sheet/option/add', 'Add'),
                            tooltip: nls.localize('vueport/color/sheet/option/addHint', 'Dragging adds to the area (or hold Shift)') },
                        { value: 'remove', label: nls.localize('vueport/color/sheet/option/remove', 'Remove'),
                            tooltip: nls.localize('vueport/color/sheet/option/removeHint', 'Dragging takes out of the area (or hold Alt)') },
                    ], mode => editor.setToolOption('areaMode', mode))}
                </>;
            case 'fill':
                return <>
                    <span className='vp-color-toolbar-divider' />
                    {radio('fillMode', options.fillMode, [
                        { value: 'all', label: nls.localize('vueport/color/sheet/option/all', 'All'),
                            tooltip: nls.localize('vueport/color/sheet/option/allHint', 'Fills every pixel of that color on the sheet (in the area)') },
                        { value: 'contiguous', label: nls.localize('vueport/color/sheet/option/contiguous', 'Contiguous'),
                            tooltip: nls.localize('vueport/color/sheet/option/contiguousHint', 'Fills the pixels of that color that touch') },
                    ], mode => editor.setToolOption('fillMode', mode))}
                </>;
            case 'line':
                return <>
                    <span className='vp-color-toolbar-divider' />
                    {sizes('lineWidth')}
                </>;
            case 'rectangle':
            case 'ellipse':
                return <>
                    <span className='vp-color-toolbar-divider' />
                    {radio('rectFill', options.rectFill, [
                        { value: true, label: nls.localize('vueport/color/sheet/option/filled', 'Filled'),
                            tooltip: nls.localize('vueport/color/sheet/option/filledHint', 'Fills the shape') },
                        { value: false, label: nls.localize('vueport/color/sheet/option/outline', 'Outline'),
                            tooltip: nls.localize('vueport/color/sheet/option/outlineHint', 'Draws the shape\'s outline') },
                    ], filled => editor.setToolOption('rectFill', filled))}
                    {sizes('rectStroke', options.rectFill)}
                </>;
            default:
                return undefined;
        }
    };

    const centerOn = (sx: number, sy: number): void =>
        setOffset({ x: Math.round(size.width / 2 - sx * zoom), y: Math.round(size.height / 2 - sy * zoom) });
    const blocked = !editor.canPaint() && ['pencil', 'eraser', 'fill', 'rectangle', 'ellipse', 'line'].includes(tool);
    const cursor = panning ? `pan-${panning}` : `tool-${original && tool !== 'area' && tool !== 'hand' ? 'none' : blocked ? 'blocked' : tool}`
        + (tool === 'area' && !panning ? ` area-${areaMode}` : '')
        // Alt held with a painting tool: a click picks a color
        + (heldMode === 'remove' && !panning && !original && ['pencil', 'eraser', 'fill', 'rectangle', 'ellipse', 'line'].includes(tool) ? ' picking' : '')
        + (!panning && hover && (inFloating(hover.x, hover.y)
            || (tool === 'area' && !heldMode && options.areaShape !== 'polygon' && area && inArea(hover.x, hover.y))) ? ' moving' : '');

    // the sheet's name is shown in the project tree, where it is chosen
    // data-own-keys: the emulator leaves keys pressed here to the sheet editor (see emulator-input.ts)
    return <div className='vp-color-sheet' tabIndex={-1} onKeyDown={onKeyDown} data-sheet-name={entry.name} data-sheet-id={sheet.id} data-own-keys>
        <div className='vp-color-toolbar'>
            <button type='button' className='vp-color-tool-button' data-undo disabled={!editor.canUndo}
                title={nls.localize('vueport/color/sheet/undo', 'Undo ({0})', `${MOD}+Z`)}
                onClick={() => editor.undo()}><ArrowCounterClockwise size={18} /></button>
            <button type='button' className='vp-color-tool-button' data-redo disabled={!editor.canRedo}
                title={nls.localize('vueport/color/sheet/redo', 'Redo ({0})', `${MOD}+Shift+Z`)}
                onClick={() => editor.redo()}><ArrowClockwise size={18} /></button>
            <span className='vp-color-toolbar-divider' />
            {toolButton('area', <Selection size={18} />, nls.localize('vueport/color/sheet/tool/area', 'Choose an area'), 'M')}
            {toolButton('pencil', <Pencil size={18} />, nls.localize('vueport/color/sheet/tool/pencil', 'Pencil'), 'B')}
            {toolButton('eraser', <Eraser size={18} />, nls.localize('vueport/color/sheet/tool/eraser2', 'Eraser: makes pixels transparent'), 'E')}
            {toolButton('fill', <PaintBucket size={18} />, nls.localize('vueport/color/sheet/tool/fill', 'Fill'), 'G')}
            {toolButton('rectangle', <Rectangle size={18} />, nls.localize('vueport/color/sheet/tool/rectangle2', 'Rectangle (Shift: square)'), 'R')}
            {toolButton('ellipse', <Circle size={18} />, nls.localize('vueport/color/sheet/tool/ellipse', 'Ellipse (Shift: circle)'), 'U')}
            {toolButton('line', <LineSegment size={18} />, nls.localize('vueport/color/sheet/tool/line', 'Line (Shift: 0, 45 or 90 degrees)'), 'L')}
            {toolButton('pipette', <Eyedropper size={18} />, nls.localize('vueport/color/sheet/tool/pipette', 'Pick a color (Alt-click with the others)'), 'I')}
            {toolButton('hand', <Hand size={18} />, nls.localize('vueport/color/sheet/tool/hand', 'Move the view (or hold Space)'), 'H')}
            {toolOptions()}
        </div>
        <div className='vp-color-sheet-body'>
            <div className='vp-color-sheet-view' ref={view} tabIndex={0} onKeyDown={onKeyDown} data-offset={`${left},${top}`}>
                <canvas
                    ref={canvas}
                    className={`vp-color-sheet-canvas ${cursor}`}
                    style={{ width: size.width, height: size.height }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onPointerEnter={() => {
                        pointerInside.current = true;
                    }}
                    onPointerLeave={() => {
                        pointerInside.current = false;
                        if (gesture.current === undefined) {
                            setHover(undefined);
                        }
                    }}
                    onContextMenu={event => event.preventDefault()}
                />
            </div>
            <div className='vp-color-sheet-side'>
                <fieldset className='vp-color-section'>
                    <legend>{nls.localize('vueport/color/sheet/navigatorTitle', 'Navigator')}</legend>
                    <SheetNavigator
                        image={image}
                        width={layout.width}
                        height={layout.height}
                        black={sheet.kind === 'screen' && original}
                        view={{ x: -left / zoom, y: -top / zoom, width: size.width / zoom, height: size.height / zoom }}
                        onCenter={centerOn}
                    />
                </fieldset>
                {(sheet.kind === 'screen' ? sheet.items.length > 1 : (figure?.count ?? 1) > 1) && <ScreenLayersPanel
                    editor={editor}
                    sheet={sheet}
                    depths={sheet.kind === 'screen' ? undefined : figure?.count}
                    depthNames={figure?.names}
                    hidden={hiddenLayers}
                    active={activeLayers}
                    onHidden={setHiddenLayers}
                    onActive={setActiveLayers}
                />}
                {backdropTarget && <BackdropEditor editor={editor} target={backdropTarget} />}
                <fieldset className='vp-color-section'>
                    <legend>{nls.localize('vueport/color/brush', 'Brush')}</legend>
                    <div className='vp-color-sheet-brushes' data-brushes>
                        {editor.brushColors.map((color, slot) => <span
                            key={slot}
                            className={slot === editor.brushSlot ? 'on' : undefined}
                            data-brush={slot}
                        >
                            <ColorField
                                value={color}
                                title={nls.localize('vueport/color/sheet/brushSlot2',
                                    'Brush color {0}: a click paints with it, a double click changes it; X switches to the next, Shift+X to the previous', slot + 1)}
                                onSelect={() => editor.chooseBrush(slot)}
                                onChange={next => {
                                    editor.chooseBrush(slot);
                                    editor.setBrushColor(next);
                                }}
                            />
                        </span>)}
                    </div>
                </fieldset>
                <PaintLayersPanel editor={editor} />
                <fieldset className='vp-color-section' data-sheet-colors>
                    <legend>{nls.localize('vueport/color/sheet/colors', 'Sheet colors')}</legend>
                    <Swatches editor={editor} colors={cost.colors} />
                </fieldset>
                <fieldset className='vp-color-section'>
                    <legend>{nls.localize('vueport/color/sheet/cost', 'Cost')}</legend>
                    <div className='vp-color-hint' data-cost>
                        {cost.expensive.size === 0
                            ? nls.localize('vueport/color/sheet/costNone', 'All {0} characters take one palette each: the cheapest coloring.', cost.characters)
                            : nls.localize('vueport/color/sheet/costSome',
                                '{0} of {1} characters show more than one color for one shade: they need colors per pixel, which VB Color has fewer of.',
                                cost.expensive.size, cost.characters)}
                    </div>
                    <label className='vp-color-tree-check'>
                        <input type='checkbox' checked={costly} onChange={event => setCostly(event.currentTarget.checked)} />
                        {nls.localize('vueport/color/sheet/showCost', 'Mark them')}
                    </label>
                </fieldset>
            </div>
        </div>
        <div className='vp-color-sheet-status'>
            <span className='vp-color-sheet-status-side'>
                <span data-original-select>
                    <RadioSelect
                        size='small'
                        options={[
                            { value: false, label: nls.localize('vueport/color/sheet/colored', 'Colored'),
                                tooltip: nls.localize('vueport/color/sheet/coloredHint', 'The colors') },
                            { value: true, label: nls.localize('vueport/color/sheet/original', 'Original'),
                                tooltip: nls.localize('vueport/color/sheet/originalHint2', 'The original red picture, to look at (or hold O)') },
                        ]}
                        defaultValue={original}
                        onChange={chosen => chosen.length && setOriginal(chosen[0].value === true)}
                    />
                </span>
                <button
                    type='button'
                    className='vp-color-sheet-reset'
                    data-reset='red'
                    disabled={original}
                    title={nls.localize('vueport/color/sheet/resetHint', 'Every pixel of the sheet (in the area) back to the original red')}
                    onClick={() => reset('red')}
                >
                    <ArrowUUpLeft size={14} />
                    <span>{area
                        ? nls.localize('vueport/color/sheet/resetSelectionButton', 'Reset Selection')
                        : nls.localize('vueport/color/sheet/resetSheetButton', 'Reset Sheet')}</span>
                </button>
            </span>
            <span className='vp-color-sheet-status-text'>{status}</span>
            <span className='vp-color-sheet-zoom-controls'>
                <button type='button' className={`vp-color-tool-button${grid ? ' on' : ''}`} aria-pressed={grid} data-grid
                    title={nls.localize('vueport/color/sheet/grid', 'Grid')} onClick={() => setGrid(!grid)}><GridFour size={14} /></button>
                <span className='vp-color-toolbar-divider' />
                <button type='button' className='vp-color-tool-button' title={nls.localize('vueport/color/sheet/zoomOut', 'Zoom out (-)')}
                    onClick={() => step(-1)}><MagnifyingGlassMinus size={14} /></button>
                {/* clicking the zoom level fits the sheet to the view, like 0 */}
                <button type='button' className='vp-color-sheet-zoom' data-fit title={nls.localize('vueport/color/sheet/fit', 'Fit (0)')}
                    onClick={fit}>{`${zoom}×`}</button>
                <button type='button' className='vp-color-tool-button' title={nls.localize('vueport/color/sheet/zoomIn', 'Zoom in (+)')}
                    onClick={() => step(1)}><MagnifyingGlassPlus size={14} /></button>
            </span>
        </div>
    </div>;
}

// maximum navigator size, in CSS pixels
const NAVIGATOR_WIDTH = 210;
const NAVIGATOR_HEIGHT = 150;

function SheetNavigator(props: {
    image: HTMLCanvasElement,
    width: number,
    height: number,
    black: boolean,
    view: { x: number, y: number, width: number, height: number },
    onCenter: (x: number, y: number) => void,
}): React.JSX.Element {
    const { image, width, height, black, view, onCenter } = props;
    const canvas = React.useRef<HTMLCanvasElement>(null);
    const scale = Math.min(NAVIGATOR_WIDTH / width, NAVIGATOR_HEIGHT / height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    React.useEffect(() => {
        const node = canvas.current;
        const context = node?.getContext('2d');
        if (!node || !context) {
            return;
        }
        const ratio = window.devicePixelRatio || 1;
        node.width = Math.round(w * ratio);
        node.height = Math.round(h * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.fillStyle = black ? '#000000' : '#444444';
        context.fillRect(0, 0, w, h);
        context.imageSmoothingEnabled = scale < 1;
        context.drawImage(image, 0, 0, w, h);
        if (view.x > 0 || view.y > 0 || view.x + view.width < width || view.y + view.height < height) {
            const accent = getComputedStyle(node).getPropertyValue('--vp-accent').trim() || '#e53935';
            context.strokeStyle = accent;
            context.lineWidth = 2;
            const x0 = Math.max(0, view.x * scale);
            const y0 = Math.max(0, view.y * scale);
            const x1 = Math.min(w, (view.x + view.width) * scale);
            const y1 = Math.min(h, (view.y + view.height) * scale);
            context.strokeRect(x0 + 1, y0 + 1, Math.max(2, x1 - x0 - 2), Math.max(2, y1 - y0 - 2));
        }
    });
    const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        const box = event.currentTarget.getBoundingClientRect();
        onCenter((event.clientX - box.left) / scale, (event.clientY - box.top) / scale);
    };
    return <div className='vp-color-sheet-navigator'>
        <canvas
            ref={canvas}
            style={{ width: w, height: h }}
            data-navigator
            title={nls.localize('vueport/color/sheet/navigator', 'The whole sheet: click or drag to move the view')}
            onPointerDown={event => {
                event.currentTarget.setPointerCapture(event.pointerId);
                move(event);
            }}
            onPointerMove={event => event.buttons & 1 && move(event)}
        />
    </div>;
}

export function Swatches(props: { editor: ColorEditor, colors: readonly string[] }): React.JSX.Element {
    const { editor, colors } = props;
    return <div className='vp-color-sheet-swatches'>
        {colors.map(color => <button
            key={color}
            type='button'
            className={color === editor.brushColor ? 'on' : undefined}
            style={{ background: color }}
            title={color}
            onClick={() => editor.setBrushColor(color)}
        />)}
    </div>;
}

// a whole screen's layers (its worlds, front first), or a figure sheet's depths. The eye hides one; a click paints on
// it alone (it comes to the front, the others are dimmed), Shift- or Ctrl/Cmd-click paints on several, and clicking the
// only chosen one again releases the choice
function ScreenLayersPanel(props: {
    editor: ColorEditor,
    sheet: ColorSheet,
    // for a figure sheet: how many depths its parts lie at, which are then the layers (front first)
    depths?: number,
    depthNames?: string[],
    hidden: ReadonlySet<number>,
    active: ReadonlySet<number>,
    onHidden: (hidden: ReadonlySet<number>) => void,
    onActive: (active: ReadonlySet<number>) => void,
}): React.JSX.Element {
    const { editor, sheet, depths, depthNames: automatic, hidden, active, onHidden, onActive } = props;
    const [renaming, setRenaming] = React.useState<number | undefined>(undefined);
    const named = sheet.depths;
    const rows = depths !== undefined
        ? Array.from({ length: depths }, (_, n) => ({
            name: editor.depthName(sheet.id, n) ?? named?.[n] ?? automatic?.[n] ?? String(n + 1),
            tag: '',
        }))
        : sheet.items.map((item, n) => ({
            name: (item.layer && editor.sheetEntry(item.layer)?.name) || nls.localize('vueport/color/sheet/world', 'World {0}', item.world ?? n),
            tag: item.world !== undefined ? `${item.world}${item.eye ?? ''}` : '',
        }));
    const toggle = (set: ReadonlySet<number>, n: number): Set<number> => {
        const next = new Set(set);
        if (!next.delete(n)) {
            next.add(n);
        }
        return next;
    };
    return <fieldset className='vp-color-section' data-screen-layers>
        <legend>{depths !== undefined
            ? nls.localize('vueport/color/sheet/figureLayers', 'Figure layers')
            : nls.localize('vueport/color/sheet/layers', 'Screen layers')}</legend>
        <div className='vp-color-layers'>
            {rows.map(({ name, tag }, n) => {
                return <div
                    key={n}
                    className={`vp-color-layer${active.has(n) ? ' on' : ''}${hidden.has(n) ? ' hidden' : ''}`}
                    data-layer={n}
                    title={depths !== undefined
                        ? nls.localize('vueport/color/sheet/depthHint', 'Click: paint on this layer alone. Shift- or Ctrl-click: on several. Double click: name it.')
                        : nls.localize('vueport/color/sheet/layerHint', 'Click: paint on this layer alone. Shift- or Ctrl-click: on several.')}
                    onClick={event => onActive(event.shiftKey || event.ctrlKey || event.metaKey
                        ? toggle(active, n)
                        : active.size === 1 && active.has(n) ? new Set() : new Set([n]))}
                    onDoubleClick={() => depths !== undefined && setRenaming(n)}
                >
                    <button
                        type='button'
                        className='vp-color-tool-button'
                        data-layer-eye={n}
                        title={hidden.has(n)
                            ? nls.localize('vueport/color/sheet/showLayer', 'Show the layer')
                            : nls.localize('vueport/color/sheet/hideLayer', 'Hide the layer')}
                        onClick={event => {
                            event.stopPropagation();
                            onHidden(toggle(hidden, n));
                        }}
                    >{hidden.has(n) ? <EyeSlash size={14} /> : <Eye size={14} />}</button>
                    {renaming === n
                        ? <input
                            className='vp-input vp-color-layer-input'
                            autoFocus
                            defaultValue={name}
                            onClick={event => event.stopPropagation()}
                            onBlur={event => {
                                editor.renameDepth(sheet.id, n, event.currentTarget.value === (named?.[n] ?? automatic?.[n]) ? '' : event.currentTarget.value);
                                setRenaming(undefined);
                            }}
                            onKeyDown={event => {
                                if (event.key === 'Enter') {
                                    event.currentTarget.blur();
                                } else if (event.key === 'Escape') {
                                    setRenaming(undefined);
                                }
                                event.stopPropagation();
                            }}
                        />
                        : <span className='vp-color-layer-name'>{name}</span>}
                    <span className='vp-color-layer-world'>{tag}</span>
                </div>;
            })}
        </div>
    </fieldset>;
}

/**
 * Lists the paint's layers, top one first. A click paints on one, Shift- or Ctrl-click marks several (to merge or
 * delete), the eye hides one (from the build too), and a double click names it. Each pixel shows the topmost visible
 * layer that paints it; the eraser takes paint off the layer painted on only, so the one below shows.
 */
export function PaintLayersPanel(props: { editor: ColorEditor }): React.JSX.Element {
    const { editor } = props;
    const layers = editor.paintLayers();
    const active = editor.activePaintLayer();
    const marked = new Set([...editor.selectedPaintLayers].filter(id => layers.some(layer => layer.id === id)));
    marked.add(active);
    const [renaming, setRenaming] = React.useState<string | undefined>(undefined);
    const button = (icon: React.ReactNode, title: string, onClick: () => void, disabled = false, data = ''): React.ReactNode =>
        <button type='button' className='vp-color-tool-button' title={title} disabled={disabled} onClick={onClick} data-paint-layer-action={data}>{icon}</button>;
    return <fieldset className='vp-color-section' data-paint-layers>
        <legend>{nls.localize('vueport/color/layer/title', 'Layers')}</legend>
        <div className='vp-color-layers'>
            {layers.map(layer => <div
                key={layer.id}
                className={`vp-color-layer${layer.id === active ? ' on' : marked.has(layer.id) ? ' marked' : ''}${layer.visible ? '' : ' hidden'}`}
                data-paint-layer={layer.name}
                onClick={event => editor.choosePaintLayer(layer.id, event.shiftKey || event.ctrlKey || event.metaKey ? 'toggle' : 'only')}
                onDoubleClick={() => setRenaming(layer.id)}
                title={nls.localize('vueport/color/layer/hint', 'Click: paint on this layer. Shift- or Ctrl-click: mark several. Double click: name it.')}
            >
                <button
                    type='button'
                    className='vp-color-tool-button'
                    title={layer.visible
                        ? nls.localize('vueport/color/layer/hide', 'Hide the layer (it is left out of the build too)')
                        : nls.localize('vueport/color/layer/show', 'Show the layer')}
                    onClick={event => {
                        event.stopPropagation();
                        editor.setPaintLayerVisible(layer.id, !layer.visible);
                    }}
                >{layer.visible ? <Eye size={14} /> : <EyeSlash size={14} />}</button>
                {renaming === layer.id
                    ? <input
                        className='vp-input vp-color-layer-input'
                        autoFocus
                        defaultValue={layer.name}
                        onClick={event => event.stopPropagation()}
                        onBlur={event => {
                            editor.renamePaintLayer(layer.id, event.currentTarget.value);
                            setRenaming(undefined);
                        }}
                        onKeyDown={event => {
                            if (event.key === 'Enter') {
                                event.currentTarget.blur();
                            } else if (event.key === 'Escape') {
                                setRenaming(undefined);
                            }
                            event.stopPropagation();
                        }}
                    />
                    : <span className='vp-color-layer-name'>{layer.name}</span>}
            </div>)}
            {/* the sheet itself with the package's colors, under all paint layers; it can't be moved, hidden or painted on */}
            <div className='vp-color-layer base' data-paint-layer-base
                title={nls.localize('vueport/color/layer/base', 'The sheet as the package colors it, under the paint layers: it cannot be moved or changed.')}>
                <span className='vp-color-layer-lock'><LockSimple size={14} /></span>
                <span className='vp-color-layer-name'>{editor.sheetEntry(editor.sheetId)?.name ?? nls.localize('vueport/color/layer/sheet', 'Sheet')}</span>
            </div>
        </div>
        <div className='vp-color-layer-actions'>
            {button(<Plus size={14} />, nls.localize('vueport/color/layer/add', 'New layer (above the one painted on)'), () => editor.addPaintLayer(), false, 'add')}
            {button(<Stack size={14} />, nls.localize('vueport/color/layer/merge', 'Merge the marked layers into one'),
                () => editor.mergePaintLayers(marked), marked.size < 2, 'merge')}
            {button(<ArrowUp size={14} />, nls.localize('vueport/color/layer/up', 'Move the layer up'),
                () => editor.movePaintLayer(active, -1), layers[0]?.id === active, 'up')}
            {button(<ArrowDown size={14} />, nls.localize('vueport/color/layer/down', 'Move the layer down'),
                () => editor.movePaintLayer(active, 1), layers[layers.length - 1]?.id === active, 'down')}
            {button(<Trash size={14} />, nls.localize('vueport/color/layer/delete', 'Delete the marked layers'),
                () => editor.deletePaintLayers(marked), layers.length < 2, 'delete')}
        </div>
    </fieldset>;
}
