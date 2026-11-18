import * as vbcpkg from '../../common/vbcpkg';
import { ColorPaintLayer } from '../../common/vb-color-package';
import { restoreColorPackageRuntime, sha256Hex, unpackColorPackage } from '../../common/vb-color-package-file';
import type { ColorBackdrop, ColorEditDocument, ColorPaintLayerEntry } from './emulator-color-editor';

// exports and imports the color editor's work as a VB Color package: the shipped package with the user's paint in
// `paint` and the rest of the edit document in `edit` (see VB Patches/_tools/vbcpkg/README.md, "Paint in the package").
// Such a package compiles to the painted ROM on its own, since the compiler puts a package's paint under the given one

export interface ColorPackageEdit {
    base?: { patch: string, version: string, sha256?: string };
    sheets?: ColorEditDocument['sheets'];
    places?: ColorEditDocument['places'];
    names?: ColorEditDocument['names'];
    folders?: ColorEditDocument['folders'];
    depths?: ColorEditDocument['depths'];
    backdrops?: ColorEditDocument['backdrops'];
    modelParts?: ColorEditDocument['modelParts'];
    layers?: ColorEditDocument['layers'];
    activeLayer?: string;
}

// package JSON exactly as in the file, unlike what readColorPackage prepares for the editor
export type RawColorPackage = { [field: string]: unknown } & { format?: string, game?: string, id?: string, version?: string };

export interface ColorImportedWork {
    paint: ColorPaintLayer;
    edit: ColorPackageEdit;
    sameBase: boolean; // whether everything besides `paint` and `edit` matches the shipped package
    differences: string[];
    counts:{ keys: number, sheets: number, backdrops: number, edges: number };
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

let brotliEncoder: Promise<typeof import('brotli-wasm-web')> | undefined;

/**
 * Compresses a package file for Export Package with brotli, as VUEPort publishes its packages: about a fifth of gzip's
 * size, since gzip's 32 KB window misses the repeats in a package's tables. unpackColorPackage and the VB Patches tools
 * (pkgdiff, pkgmerge) read it back. Quality 9 takes a few seconds for the biggest package, where 11 takes a minute for
 * a tenth less. The encoder (brotli-wasm, about 1 MB) loads on the first export; if it fails to load, the file is gzip.
 */
export async function packColorPackage(bytes: Uint8Array): Promise<Uint8Array> {
    let brotli: typeof import('brotli-wasm-web');
    try {
        brotliEncoder ??= Promise.all([import('brotli-wasm-web'), import('brotli-wasm-web-bytes')])
            .then(async ([encoder, wasm]) => {
                await encoder.default(wasm.default);
                return encoder;
            });
        brotli = await brotliEncoder;
    } catch (error) {
        brotliEncoder = undefined;
        console.warn('brotli encoder unavailable, exporting gzip', error);
        return gzipBytes(bytes);
    }
    return brotli.compress(bytes, { quality: 9 });
}

export { sha256Hex };

// a package file's JSON as it is (brotli, gzip or plain), but whole: a published package carries only its runtime BPS's
// hash, so the runtime is put back from `runtimeBps` (the shipped BPS)
export async function readRawColorPackage(bytes: Uint8Array, runtimeBps?: Uint8Array): Promise<RawColorPackage> {
    const parsed = JSON.parse(new TextDecoder().decode(await unpackColorPackage(bytes)));
    if (!parsed || typeof parsed !== 'object' || parsed.format !== 'vbcpkg/1') {
        throw new Error(`not a VB Color package (${String(parsed?.format)})`);
    }
    await restoreColorPackageRuntime(parsed, runtimeBps);
    return parsed as RawColorPackage;
}

export function packagePaintLayers(pkg: RawColorPackage): ColorPaintLayer[] {
    return vbcpkg.packagePaint(pkg) as ColorPaintLayer[];
}

export function documentEdit(document: ColorEditDocument, base: ColorPackageEdit['base']): ColorPackageEdit {
    const edit: ColorPackageEdit = {
        base,
        sheets: document.sheets?.length ? document.sheets : undefined,
        places: nonEmpty(document.places),
        names: nonEmpty(document.names),
        folders: document.folders?.length ? document.folders : undefined,
        depths: nonEmpty(document.depths),
        backdrops: nonEmpty(document.backdrops),
        modelParts: nonEmpty(document.modelParts),
        layers: document.layers?.length ? document.layers : undefined,
        activeLayer: document.layers?.length ? document.activeLayer : undefined,
    };
    return JSON.parse(JSON.stringify(edit));
}

function nonEmpty<T extends object>(value: T | undefined): T | undefined {
    return value && Object.keys(value).length ? value : undefined;
}

// the shipped package with the user's work: its own paint layers (if any), then theirs (`paint`), and their document
// (`edit`); everything else stays as the shipped package has it
export function editedColorPackage(shipped: RawColorPackage, paint: ColorPaintLayer, edit: ColorPackageEdit): RawColorPackage {
    const own = JSON.parse(JSON.stringify(paint)) as ColorPaintLayer;
    for (const name of ['backdrops', 'models', 'classes'] as const) {
        if (own[name] && !Object.keys(own[name]!).length) {
            delete own[name];
        }
    }
    const out: RawColorPackage = { ...shipped, paint: [...packagePaintLayers(shipped), own], edit };
    return out;
}

function baseJson(pkg: RawColorPackage, field: string): string {
    return JSON.stringify(pkg[field]);
}

// extracts the user's work by comparing against the running colorization's shipped package: the paint layers after
// the shipped ones (all of them if those differ) merged into one, and the edit document. Throws if it was made for
// another original ROM
export function importedColorWork(shipped: RawColorPackage, imported: RawColorPackage, sameFile: boolean): ColorImportedWork {
    const original = (pkg: RawColorPackage) => (pkg.original as { sha256?: string } | undefined)?.sha256;
    if (original(shipped) !== original(imported)) {
        throw new Error(`made for another game (${String(imported.game)})`);
    }
    let differences: string[] = [];
    if (!sameFile) {
        const fields = new Set([...Object.keys(shipped), ...Object.keys(imported)]);
        fields.delete('paint');
        fields.delete('edit');
        differences = [...fields].filter(field => baseJson(shipped, field) !== baseJson(imported, field));
    }
    const shippedLayers = packagePaintLayers(shipped);
    const layers = packagePaintLayers(imported);
    const prefix = shippedLayers.length <= layers.length
        && shippedLayers.every((layer, n) => JSON.stringify(layer) === JSON.stringify(layers[n]));
    const paint = mergePaintLayers(prefix ? layers.slice(shippedLayers.length) : layers);
    const edit = (imported.edit ?? {}) as ColorPackageEdit;
    const backdrops = { ...backdropsOfRows(paint.backdrops), ...edit.backdrops };
    return {
        paint,
        edit: { ...edit, backdrops: Object.keys(backdrops).length ? backdrops : undefined },
        sameBase: differences.length === 0,
        differences,
        counts: {
            keys: Object.keys(paint.tiles).length,
            sheets: edit.sheets?.length ?? 0,
            backdrops: Object.keys(backdrops).length,
            edges: Object.values(paint.models ?? {}).reduce((n, model) => n + Object.keys(model.edges).length, 0) + Object.keys(paint.classes ?? {}).length,
        },
    };
}

export function mergePaintLayers(layers: readonly ColorPaintLayer[]): ColorPaintLayer {
    const out: ColorPaintLayer = { tiles: {} };
    for (const layer of layers) {
        for (const [key, ways] of Object.entries(layer.tiles ?? {})) {
            for (const [way, pixels] of Object.entries(ways)) {
                const into = (out.tiles[key] ??= {})[way] ??= new Array<string | null>(64).fill(null);
                pixels.forEach((color, i) => {
                    if (color !== null && color !== undefined) {
                        into[i] = color;
                    }
                });
            }
        }
        if (layer.backdrops) {
            out.backdrops = { ...out.backdrops, ...layer.backdrops };
        }
        for (const [list, model] of Object.entries(layer.models ?? {})) {
            Object.assign(((out.models ??= {})[list] ??= { edges: {} }).edges, model.edges);
        }
        if (layer.classes) {
            out.classes = { ...out.classes, ...layer.classes };
        }
    }
    return out;
}

// package paint stores a backdrop as one color per row, the editor wants stops. A stop at the start and end of each
// run of one color reproduces the rows exactly. Numeric keys become 'context:<id>' targets, others are kept
export function backdropsOfRows(rows: ColorPaintLayer['backdrops']): { [target: string]: ColorBackdrop } {
    const out: { [target: string]: ColorBackdrop } = {};
    for (const [key, colors] of Object.entries(rows ?? {})) {
        const stops: ColorBackdrop['stops'] = [];
        colors.forEach((color, row) => {
            if (row === 0 || colors[row - 1] !== color || row === colors.length - 1 || colors[row + 1] !== color) {
                stops.push({ row, color });
            }
        });
        out[/^\d+$/.test(key) ? `context:${key}` : key] = { stops };
    }
    return out;
}

export function documentHasWork(document: ColorEditDocument): boolean {
    const paint = document.paint;
    return Object.keys(paint.tiles).length > 0 || Object.keys(paint.models ?? {}).length > 0 || Object.keys(paint.classes ?? {}).length > 0
        || !!document.layers?.some(layer => Object.keys(layer.tiles).length || Object.keys(layer.models ?? {}).length)
        || !!document.sheets?.length || !!Object.keys(document.backdrops ?? {}).length
        || !!Object.keys(document.places ?? {}).length || !!Object.keys(document.names ?? {}).length;
}

/**
 * 'replace' makes the document the imported one (its paint, layers, own sheets, names, places, backdrops). 'merge' lets
 * the imported paint win per paint key, model edge, class and backdrop; with layers it goes on a new top layer
 * `layerName`, and the keys it paints are taken off the others. Own sheets merge by id (the imported one wins), names
 * and places per sheet, and folders are combined. The caller then flattens the layers into the paint (mergeLayers).
 */
export function applyImportedWork(document: ColorEditDocument, work: ColorImportedWork, mode: 'replace' | 'merge', layerName: string): void {
    const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
    const { tiles, models, classes } = copy(work.paint);
    const edit = work.edit;
    if (mode === 'replace') {
        document.paint = { tiles, ...(models ? { models } : {}), ...(classes ? { classes } : {}) };
        if (edit.layers?.length) {
            document.layers = copy(edit.layers);
            document.activeLayer = edit.activeLayer;
        } else {
            delete document.layers;
            delete document.activeLayer;
        }
        const set = <K extends 'backdrops' | 'sheets' | 'places' | 'names' | 'folders' | 'depths' | 'modelParts'>(name: K): void => {
            if (edit[name] !== undefined) {
                document[name] = copy(edit[name]) as ColorEditDocument[K];
            } else {
                delete document[name];
            }
        };
        (['backdrops', 'sheets', 'places', 'names', 'folders', 'depths', 'modelParts'] as const).forEach(set);
        return;
    }
    const takeOff = (layer: { tiles: ColorPaintLayer['tiles'], models?: ColorPaintLayer['models'], classes?: ColorPaintLayer['classes'] }): void => {
        for (const key of Object.keys(tiles)) {
            delete layer.tiles[key];
        }
        for (const [list, model] of Object.entries(models ?? {})) {
            for (const edge of Object.keys(model.edges)) {
                delete layer.models?.[list]?.edges[edge];
            }
        }
        for (const name of Object.keys(classes ?? {})) {
            delete layer.classes?.[name];
        }
    };
    if (document.layers?.length) {
        document.layers.forEach(takeOff);
        const id = String(Date.now());
        const entry: ColorPaintLayerEntry = { id, name: layerName, visible: true, tiles, ...(models ? { models } : {}), ...(classes ? { classes } : {}) };
        document.layers.unshift(entry);
        document.activeLayer = id;
    } else {
        const paint = document.paint;
        takeOff(paint);
        Object.assign(paint.tiles, tiles);
        for (const [list, model] of Object.entries(models ?? {})) {
            Object.assign(((paint.models ??= {})[list] ??= { edges: {} }).edges, model.edges);
        }
        if (classes) {
            paint.classes = { ...paint.classes, ...classes };
        }
    }
    if (edit.backdrops) {
        document.backdrops = { ...document.backdrops, ...copy(edit.backdrops) };
    }
    if (edit.sheets?.length) {
        const ids = new Set(edit.sheets.map(sheet => sheet.id));
        document.sheets = [...(document.sheets ?? []).filter(sheet => !ids.has(sheet.id)), ...copy(edit.sheets)];
    }
    for (const name of ['places', 'names', 'depths', 'modelParts'] as const) {
        if (edit[name]) {
            document[name] = { ...document[name], ...copy(edit[name]) } as never;
        }
    }
    if (edit.folders?.length) {
        document.folders = [...new Set([...document.folders ?? [], ...edit.folders])];
    }
}
