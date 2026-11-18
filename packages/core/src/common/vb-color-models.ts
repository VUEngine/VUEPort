import { modelRamp } from './vbcpkg-models';
import { ColorPackage } from './vb-color-package';

/**
 * Packages of kind 'models' (VB Patches/_tools/vbcpkg/README.md, "Model packages") color wireframe games like Red
 * Alarm by model and edge. The game draws every line of its 3D models with one routine; the runtime colors a line by
 * its model's edge color table, or by its draw site's default palette. The package names the models (their vertex and
 * edge lists in the ROM, decoded here from the user's ROM), their parts, a view captured from the game, and what an
 * emulator watches to name the model and edge of each line drawn (picking).
 */

export interface ColorModelPart {
    name: string;
    edges: number[];
}

export interface ColorModel {
    // CPU address of the edge list in the ROM ('0x0702...'), used as the model's key
    edges: string;
    verts: string | null;
    kind: 'object' | 'block' | 'cockpit';
    count: number;
    name?: string;
    group?: string;
    confidence?: string;
    parts?: ColorModelPart[];
    view?: { stage: number, z: number, verts: [number, number, number][] };
    seen_in?: number[];
    // palettes its draw sites use without paint, the first is the main one
    defaults?: number[];
    // the rest is Zero Racers only
    vcount?: number;
    palettes?: number[]; // each line's palette without paint
    members?: number[]; // model indices sharing this line topology, painting one paints them all
}

export interface ColorModelCopy {
    routine: string;
    entry: string;
    start: string;
    end: string;
    // return addresses of its calls to the color line routine, left eye then right eye
    calls: string[];
}

export interface ColorModelPackage extends ColorPackage {
    kind: 'models';
    // 'zr' for Zero Racers (line override spans per model, cell paint of its VIP screens)
    layout?: string;
    models: ColorModel[];
    classes: { fixed?: number, scenery?: number, debrisC?: number[], debrisD?: number[] };
    free_palettes: number[];
    palette_table: { at: string, count: number };
    // the data area the compiler writes; with `depth4` the runtime shades lines by their own depth in four steps
    // (Red Alarm v0.8) when a four-color ramp is painted
    data?: { at: string, end: string, depth4?: { tables: { [routine: string]: { thresholds: number[] } } } };
    decoders: {
        // 'zr' for Zero Racers' model records (counts in the package's model entries, s32 vertices with y up)
        kind?: 'zr';
        verts: { count: 'u16' | 'record', at: number, stride: number, xyz: 's16' | 's32' },
        edges: { count: 'u16' | 'record', at: number, stride: number, ab: 'u16', shift: number },
    };
    // for 'zr' the pick point in the drawer copy, whose registers hold the line's ends, eye, palette and tag
    probe: { kind?: 'zr', line_routine: string, frame_start: string, copies?: ColorModelCopy[], capture?: string[] };
}

// a single color (the near shade, the ramp is derived from it), a ramp [far, mid, near] shaded by the model's distance,
// or where supportsDepth4() says so, four steps [far, far mid, near mid, near] by each line's own depth
export type ColorModelPaint = string | string[];

// the models' part of a paint layer, as the compiler (models.mjs) takes it
export interface ColorModelLayer {
    models?: { [list: string]: { edges: { [edge: string]: ColorModelPaint } } };
    classes?: { [name: string]: ColorModelPaint };
}

export const MODEL_CLASSES = ['scenery', 'debris', 'fixed'] as const;
export type ColorModelClass = typeof MODEL_CLASSES[number];

export function isModelPackage(pkg: ColorPackage | undefined): pkg is ColorModelPackage {
    return pkg?.kind === 'models';
}

const num = (value: string | number): number => typeof value === 'number' ? value >>> 0 : parseInt(value, 16) >>> 0;

// far, mid, near (the runtime's shades 1..3), or four steps far to near
export function rampOf(paint: ColorModelPaint): string[] {
    return Array.isArray(paint) ? (paint.length === 4 ? [...paint] : paint.slice(-3)) : modelRamp(paint) as string[];
}

export function nearOf(ramp: readonly string[]): string {
    return ramp[ramp.length - 1];
}

// a four-step ramp as the three shades a runtime without per-line depth shows (far, near mid, near)
export function threeOf(ramp: readonly string[]): string[] {
    return ramp.length === 4 ? [ramp[0], ramp[2], ramp[3]] : [...ramp];
}

export function fourOf(ramp: readonly string[]): string[] {
    if (ramp.length === 4) {
        return [...ramp];
    }
    const mix = (a: string, b: string, k: number): string => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - k)
        + parseInt(b.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');
    return [ramp[0], mix(ramp[0], ramp[1], 0.5), mix(ramp[1], ramp[2], 0.5), ramp[2]];
}

export function paintOf(color: string, steps: 3 | 4): ColorModelPaint {
    return steps === 4 ? fourOf(rampOf(color)) : color;
}

// whether the runtime shades a routine's lines by their own depth in four steps ('A' objects, 'E' scenery)
export function supportsDepth4(pkg: ColorModelPackage | undefined, routine: 'A' | 'E' = 'A'): boolean {
    return !!pkg?.data?.depth4?.tables?.[routine];
}

export interface Wireframe {
    vertices: [number, number, number][];
    edges: [number, number][];
}

export function readWireframe(pkg: ColorModelPackage, rom: Uint8Array, model: ColorModel): Wireframe | undefined {
    const mask = rom.length - 1;
    const u16 = (a: number): number => rom[a & mask] | rom[(a + 1) & mask] << 8;
    const s16 = (a: number): number => (u16(a) << 16) >> 16;
    const { verts: vd, edges: ed } = pkg.decoders;
    const e = num(model.edges);
    if (pkg.decoders.kind === 'zr') {
        return readZrWireframe(rom, model);
    }
    const edges: [number, number][] = [];
    for (let i = 0, n = u16(e); i < n; i++) {
        const at = e + ed.at + ed.stride * i;
        edges.push([u16(at) >> ed.shift, u16(at + 2) >> ed.shift]);
    }
    const vertices: [number, number, number][] = [];
    if (model.verts) {
        const v = num(model.verts);
        for (let i = 0, n = u16(v); i < n; i++) {
            const at = v + vd.at + vd.stride * i;
            vertices.push([s16(at), s16(at + 2), s16(at + 4)]);
        }
    }
    // vertices the code adds at runtime (targeting lines) sit at the origin until a view captured from the game has them
    const most = Math.max(-1, ...edges.flat());
    while (vertices.length <= most) {
        vertices.push([0, 0, 0]);
    }
    return edges.length ? { vertices, edges } : undefined;
}

// Zero Racers lines are u16 a, b, shade, 0 (8 bytes), vertices s32 x, y, z (12 bytes, y up, flipped to y down here)
function readZrWireframe(rom: Uint8Array, model: ColorModel): Wireframe | undefined {
    const mask = rom.length - 1;
    const u16 = (a: number): number => rom[a & mask] | rom[(a + 1) & mask] << 8;
    const s32 = (a: number): number => (u16(a) | u16(a + 2) << 16) | 0;
    const e = num(model.edges);
    const edges: [number, number][] = [];
    for (let i = 0; i < model.count; i++) {
        edges.push([u16(e + 8 * i), u16(e + 8 * i + 2)]);
    }
    const vertices: [number, number, number][] = [];
    const v = model.verts ? num(model.verts) : 0;
    for (let i = 0; v && i < (model.vcount ?? 0); i++) {
        vertices.push([s32(v + 12 * i), -s32(v + 12 * i + 4), s32(v + 12 * i + 8)]);
    }
    const most = Math.max(-1, ...edges.flat());
    while (vertices.length <= most) {
        vertices.push([0, 0, 0]);
    }
    return edges.length ? { vertices, edges } : undefined;
}

// the ROM's Color RAM table holds RGB888 words (xxBBGGRR), four per palette
export function paletteColors(pkg: ColorModelPackage, rom: Uint8Array, palette: number): string[] {
    const at = (num(pkg.palette_table.at) & (rom.length - 1)) + palette * 16;
    return [0, 1, 2, 3].map(i => '#' + [0, 1, 2].map(k => rom[at + i * 4 + k].toString(16).padStart(2, '0')).join(''));
}

// maps a ROM address to the model and edge whose edge record it is, which is how picking names lines
export class ModelEdgeIndex {
    protected readonly ranges: [start: number, end: number, model: ColorModel][] = [];

    constructor(pkg: ColorModelPackage, rom: Uint8Array) {
        const mask = rom.length - 1;
        for (const model of pkg.decoders.kind === 'zr' ? [] : pkg.models) {
            const e = num(model.edges);
            const n = rom[e & mask] | rom[(e + 1) & mask] << 8;
            this.ranges.push([e, e + pkg.decoders.edges.at + pkg.decoders.edges.stride * n, model]);
        }
        this.ranges.sort((a, b) => a[0] - b[0]);
    }

    // `pointer` as the game's routines hold it, the record itself is at pointer + 2
    find(pointer: number, pkgStride = 4): { model: ColorModel, edge: number } | undefined {
        const record = (pointer >>> 0) + 2;
        let lo = 0;
        let hi = this.ranges.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const [start, end, model] = this.ranges[mid];
            if (record < start) {
                hi = mid - 1;
            } else if (record >= end) {
                lo = mid + 1;
            } else {
                return { model, edge: Math.floor((record - start - 2) / pkgStride) };
            }
        }
        return undefined;
    }
}

export interface ModelLine {
    routine: string;
    eye: 0 | 1;
    // the model's edge list (objects, the fixed model, scenery blocks), undefined for debris
    model?: string;
    edge?: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    palette: number;
}

export interface ModelLineHit {
    regs: { [name: string]: number };
}

// turns the watch's hits at the color line routine into lines; r31 (return address) tells routine copy and eye
export function modelLines(pkg: ColorModelPackage, edges: ModelEdgeIndex, hits: readonly ModelLineHit[]): ModelLine[] {
    if (pkg.probe.kind === 'zr') {
        return zrLines(pkg, hits);
    }
    const calls = new Map<number, { routine: string, eye: 0 | 1 }>();
    for (const copy of pkg.probe.copies ?? []) {
        copy.calls.forEach((ret, eye) => calls.set(num(ret), { routine: copy.routine, eye: eye ? 1 : 0 }));
    }
    const lines: ModelLine[] = [];
    for (const { regs } of hits) {
        const call = calls.get(regs.r31 >>> 0);
        if (!call) {
            continue;
        }
        // the edge pointer is r17 in A and B, r16 in E; debris (C, D) only has a pool slot
        const pointer = call.routine === 'E' ? regs.r16 : call.routine === 'A' || call.routine === 'B' ? regs.r17 : undefined;
        const found = pointer === undefined ? undefined : edges.find(pointer);
        lines.push({
            routine: call.routine, eye: call.eye, model: found?.model.edges, edge: found?.edge,
            x0: regs.r6 | 0, y0: regs.r7 | 0, x1: regs.r8 | 0, y1: regs.r9 | 0, palette: regs.r30 & 0xff,
        });
    }
    return lines;
}

// Zero Racers: one hit per display-list record the drawer copy takes, the tag in r28 names model index and line
function zrLines(pkg: ColorModelPackage, hits: readonly ModelLineHit[]): ModelLine[] {
    const entryOf = new Map<number, string>();
    for (const model of pkg.models) {
        for (const index of model.members ?? []) {
            entryOf.set(index, model.edges);
        }
    }
    const lines: ModelLine[] = [];
    for (const { regs } of hits) {
        const tag = regs.r28 >>> 0;
        const model = tag ? entryOf.get((tag & 0xffff) - 1) : undefined;
        lines.push({
            routine: 'A', eye: regs.r10 & 1 ? 1 : 0, model, edge: model ? (tag >>> 24) - 1 : undefined,
            x0: regs.r16 | 0, y0: regs.r14 | 0, x1: regs.r21 | 0, y1: regs.r20 | 0, palette: regs.r29 & 0xff,
        });
    }
    return lines.filter(line => line.model !== undefined);
}

export interface ModelCandidate {
    model?: string;
    edge?: number;
    modelClass?: ColorModelClass;
    distance: number;
}

export function pickLines(lines: readonly ModelLine[], pkg: ColorModelPackage, eye: 0 | 1, x: number, y: number, within = 4): ModelCandidate[] {
    const kinds = new Map(pkg.models.map(model => [model.edges, model.kind]));
    const best = new Map<string, ModelCandidate>();
    for (const line of lines) {
        if (line.eye !== eye) {
            continue;
        }
        const dx = line.x1 - line.x0;
        const dy = line.y1 - line.y0;
        const n = dx * dx + dy * dy;
        const t = n ? Math.max(0, Math.min(1, ((x - line.x0) * dx + (y - line.y0) * dy) / n)) : 0;
        const distance = Math.hypot(line.x0 + t * dx - x, line.y0 + t * dy - y);
        if (distance > within) {
            continue;
        }
        const kind = line.model ? kinds.get(line.model) : undefined;
        const candidate: ModelCandidate = line.routine === 'C' || line.routine === 'D' ? { modelClass: 'debris', distance }
            : line.routine === 'B' || kind === 'cockpit' ? { modelClass: 'fixed', distance }
                : line.routine === 'E' || kind === 'block' ? { modelClass: 'scenery', distance }
                    : { model: line.model, edge: line.edge, distance };
        const key = candidate.modelClass ?? `${candidate.model}:${candidate.edge}`;
        const was = best.get(key);
        if (!was || was.distance > distance) {
            best.set(key, candidate);
        }
    }
    return [...best.values()].sort((a, b) => a.distance - b.distance);
}

// number of palettes the compiler needs for the distinct ramps of a paint; debris takes three per ramp, and a four-step
// ramp takes four where the runtime supports depth shading, else its three shades take one
export function rampsUsed(layer: ColorModelLayer, depth4 = false): number {
    const ramps = new Set<string>();
    const add = (ramp: string[]): void => {
        const key = (depth4 || ramp.length < 4 ? ramp : threeOf(ramp)).join(',').toLowerCase();
        ramps.add(key);
    };
    for (const model of Object.values(layer.models ?? {})) {
        for (const paint of Object.values(model.edges)) {
            add(rampOf(paint));
        }
    }
    for (const [name, paint] of Object.entries(layer.classes ?? {})) {
        if (name === 'debris') {
            const ramp = threeOf(rampOf(paint));
            for (const k of [0.5, 0.75, 1]) {
                ramps.add(ramp.map(c => '#' + [1, 3, 5].map(i => Math.round(parseInt(c.slice(i, i + 2), 16) * k)
                    .toString(16).padStart(2, '0')).join('')).join(','));
            }
        } else {
            const ramp = rampOf(paint);
            ramps.add((name === 'scenery' && depth4 ? ramp : threeOf(ramp)).join(',').toLowerCase());
        }
    }
    return [...ramps].reduce((n, key) => n + (key.split(',').length === 4 ? 4 : 1), 0);
}
