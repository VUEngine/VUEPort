import { Emitter, Event } from '../../common/emulator-events';
import { PATCH_DATABASE } from '../../common/emulator-patch-database';
import {
    COLOR_CONTEXT_STATE, COLOR_OVERLAY_STATE, COLOR_EDIT_BUILD_EXTENSION, COLOR_EDIT_EXTENSION, COLOR_EDIT_PATCH_ID, ColorBuild, ColorEntityGroup, ColorPackageIndex,
    ColorCellShown, ColorPaintLayer, ColorSheet, ColorSheetItem, ColorSheetPart, ColorShownPixel, colorBuildErrorText, colorBuildPatch, colorLitWay, colorWay, makeColorCellKey,
    readColorPackage,
} from '../../common/vb-color-package';
import { ColorCompiler } from './vb-color-compiler';
import { RESTART_CONFIRM } from '../components/patch-restart';
import { colorPackageFile, fetchColorPackage } from '../../common/vb-color-package-file';
import {
    ColorImportedWork, ColorPackageEdit, applyImportedWork, documentEdit, documentHasWork, editedColorPackage, importedColorWork,
    packColorPackage, readRawColorPackage, sha256Hex,
} from './emulator-color-exchange';
import { VueportNotifications, VueportStorage } from '../../common/emulator-host';
import { nls } from '../../common/emulator-nls';
import { VB_PALETTE_GROUPS, VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH } from '../../common/vb-constants';
import { VbPixelOrigin, decodeOrigin } from '../../common/vb-pixel-origin';
import { namedPalette, readColorState } from './emulator-color-compose';
import { Sim } from '../core/vb-core';
import {
    ColorModel, ColorModelClass, ColorModelPackage, ColorModelPaint, MODEL_CLASSES, ModelCandidate, ModelEdgeIndex, ModelLineHit,
    isModelPackage, modelLines, paletteColors, pickLines, rampOf, rampsUsed, supportsDepth4,
} from '../../common/vb-color-models';
import { ProbeForkWorker } from '../../probe/probe-session';
import { ProbeCliAnswer } from '../../probe/probe-forks';

// Color mode's editor. What gets edited is the running colorization's VB Color package (vb-color-package.ts): a picked
// pixel resolves to the load positions of its character and the way it is drawn, and the paint laid over the package
// lives in a document beside the ROM, read when the mode comes on and written when it goes off

export interface ColorEditorColorization {
    id: string;
    name: string;
    // patch against the original ROM
    data: Uint8Array;
    enabled: boolean;
}

export interface ColorEditorHost {
    readonly storage: VueportStorage;
    readonly notifications: VueportNotifications;
    sim(): Sim | undefined;
    // path the companion files beside the ROM are named after; undefined with no ROM running
    romPath(): string | undefined;
    // CRC32 of the original ROM, eight lowercase hex digits
    romId(): string | undefined;
    originalRom(): Uint8Array | undefined;
    runningRom(): Uint8Array | undefined;
    colorizations(): ColorEditorColorization[];
    // true on a VB Color with color switched on, which a game made for it is even without a colorization
    vbcActive(): boolean;
    capture(): Promise<Uint8Array | undefined>;
    restoreState(state: ArrayBuffer): Promise<void>;
    // switching a colorization on restarts the game with it
    useColorization(id: string): void;
    // switches the game's colorization (the editor's build included) off for this title, which restarts the game
    // without colors
    switchOffColorization(): void;
    // the editor wrote its build beside the ROM: list it among the colorizations and switch it on, which restarts the
    // game; with keepMoment it resumes at the moment it was at
    useBuild(keepMoment: boolean): Promise<void>;
    // a file shipped with VUEPort, by its path relative to where the host serves its assets
    loadShipped?(file: string): Promise<Uint8Array>;
    // where the VB Color packages are published (vb-color-package-file.ts), packages.vueport.net if unset. A
    // development build serves its own copies
    readonly colorPackagesUrl?: string;
    // where the compile worker (vb-color-compile-worker) is served; without it builds run on the page's thread
    readonly colorWorkerUrl?: string;
    // the probe's fork worker and the core it loads: a pick in a model package logs one frame's lines in a fork
    readonly probeWorkerUrl?: string;
    readonly wasmUrl?: string;
    exportFile(name: string, data: Uint8Array): Promise<void>;
}

// what the editor keeps beside the ROM: the paint over a colorization's package, and which package (and version) it
// was made on
export interface ColorEditDocument {
    format: 'vueport-color-edit';
    version: 1;
    // catalog patch id of the colorization the paint was made on, and its package's version
    base?: { patch: string, version: string };
    // what the build gets: the visible layers merged, or with no layers the one paint there is
    paint: ColorPaintLayer;
    // top layer first; each pixel shows the topmost visible layer that paints it
    layers?: ColorPaintLayerEntry[];
    activeLayer?: string;
    names?: { [group: string]: string };
    sheets?: ColorSheet[];
    // renamed or refiled package sheets
    places?: { [sheet: string]: { name?: string, folder?: string } };
    // folders the user made; folders with sheets in them exist anyway
    folders?: string[];
    // the user's names for a figure sheet's depths (layers of parts covering one another), by sheet id, front first
    depths?: { [sheet: string]: (string | null)[] };
    // by target (see backdropTarget): 'context:<id>', or a screen's folder of sheets
    backdrops?: { [target: string]: ColorBackdrop };
    // the user's names for a model package's parts, per model (edge list) and part number
    modelParts?: { [model: string]: { [part: string]: string } };
}

export interface ColorViewStep {
    undo: () => void;
    redo: () => void;
}

export interface ColorPaintLayerEntry {
    id: string;
    name: string;
    visible: boolean;
    tiles: ColorPaintLayer['tiles']; // by paint key and way, null where this layer does not paint
    models?: ColorPaintLayer['models'];
    classes?: ColorPaintLayer['classes'];
}

function mergeModels(layers: readonly ColorPaintLayerEntry[]): Pick<ColorPaintLayer, 'models' | 'classes'> {
    const models: NonNullable<ColorPaintLayer['models']> = {};
    const classes: NonNullable<ColorPaintLayer['classes']> = {};
    for (const layer of [...layers].reverse()) {
        for (const [list, model] of Object.entries(layer.models ?? {})) {
            Object.assign((models[list] ??= { edges: {} }).edges, model.edges);
        }
        Object.assign(classes, layer.classes ?? {});
    }
    return { models: Object.keys(models).length ? models : undefined, classes: Object.keys(classes).length ? classes : undefined };
}

// layers are listed top first, so the merge goes bottom-up and upper layers win
function mergeTiles(layers: readonly ColorPaintLayerEntry[]): ColorPaintLayer['tiles'] {
    const out: ColorPaintLayer['tiles'] = {};
    for (const layer of [...layers].reverse()) {
        for (const [key, ways] of Object.entries(layer.tiles)) {
            for (const [way, pixels] of Object.entries(ways)) {
                const into = (out[key] ??= {})[way] ??= new Array<string | null>(64).fill(null);
                pixels.forEach((color, i) => {
                    if (color !== null) {
                        into[i] = color;
                    }
                });
            }
        }
    }
    return out;
}

export interface ColorBackdrop {
    stops: { row: number, color: string }[]; // rows 0-223; a single stop colors the whole screen
    steps?: number; // bands between two stops, smooth without
}

export const BACKDROP_ROWS = 224;

export function backdropRowColors(backdrop: ColorBackdrop): string[] {
    const stops = [...backdrop.stops].sort((a, b) => a.row - b.row);
    const rgb = (c: string): number[] => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    return Array.from({ length: BACKDROP_ROWS }, (_, y) => {
        if (!stops.length) {
            return '#000000';
        }
        const next = stops.findIndex(stop => stop.row >= y);
        if (next <= 0 || stops.length === 1) {
            return stops[next < 0 ? stops.length - 1 : 0].color;
        }
        const a = stops[next - 1];
        const b = stops[next];
        let t = b.row === a.row ? 1 : (y - a.row) / (b.row - a.row);
        if (backdrop.steps && backdrop.steps > 1) {
            t = Math.min(1, Math.floor(t * backdrop.steps) / (backdrop.steps - 1));
        }
        const ca = rgb(a.color);
        const cb = rgb(b.color);
        return formatHexColor(ca.map((v, i) => v + (cb[i] - v) * t));
    });
}

export interface ColorSheetEntry {
    sheet: ColorSheet;
    own: boolean;
    name: string;
    folder: string;
    group?: boolean;
}

export const GROUP_SHEET_PREFIX = 'group:';
export const MODEL_SHEET_PREFIX = 'model:'; // a model by its edge list, e.g. 'model:0x07021D3C'
export const MODEL_CLASS_PREFIX = 'model-class:'; // what a model package draws that is no model

export function modelClassName(name: ColorModelClass): string {
    switch (name) {
        case 'scenery': return nls.localize('vueport/color/model/scenery', 'Scenery');
        case 'debris': return nls.localize('vueport/color/model/debris', 'Debris and explosions');
        default: return nls.localize('vueport/color/model/fixed', 'Homing missiles');
    }
}

export interface SheetToolOptions {
    penSize: number;
    penShape: 'square' | 'circle';
    areaMode: 'replace' | 'add' | 'remove';
    areaShape: 'rectangle' | 'ellipse' | 'polygon';
    fillMode: 'all' | 'contiguous';
    modelFillMode: 'all' | 'contiguous' | 'part';
    rectFill: boolean;
    rectStroke: number;
    lineWidth: number;
}

export const SHEET_TOOL_SIZES = [1, 2, 3, 4, 6, 8];

// the pixels a pen tip of that size and shape covers, from its top left (the painted point sits at size - 1 >> 1). A
// circle keeps the pixels whose middle lies a little inside its edge, so size 3 is a plus
export function penTip(size: number, shape: 'square' | 'circle'): [number, number][] {
    const out: [number, number][] = [];
    const middle = (size - 1) / 2;
    const radius = size / 2 - 0.1;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (shape === 'square' || size < 3 || (x - middle) ** 2 + (y - middle) ** 2 <= radius * radius) {
                out.push([x, y]);
            }
        }
    }
    return out;
}

// "back to red" and the sheet's original view use the even red palette of the display settings
export const RED_PALETTE = VB_PALETTE_GROUPS[0].red.map(c => `#${c.toString(16).padStart(6, '0')}`);

export interface ColorUnplaced {
    kind: 'figures' | 'layer';
    parts: ColorSheetPart[];
}

export interface ColorPixelChange {
    key: string;
    way: string;
    i: number;
    color: string | null; // null unpaints the pixel
}

export function parentFolder(path: string): string {
    const at = path.lastIndexOf('/');
    return at < 0 ? '' : path.slice(0, at);
}

const OWN_FOLDER = 'My sheets';

function newColorEditDocument(): ColorEditDocument {
    return { format: 'vueport-color-edit', version: 1, paint: { tiles: {} } };
}

function parseColorEditDocument(text: string): ColorEditDocument {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.format !== 'vueport-color-edit') {
        throw new Error('Not a VUEPort color edit document.');
    }
    if (parsed.version !== 1) {
        throw new Error(`Unknown color edit document version ${parsed.version}.`);
    }
    const document = parsed as ColorEditDocument;
    document.paint ??= { tiles: {} };
    document.paint.tiles ??= {};
    return document;
}

export function formatHexColor(rgb: readonly number[]): string {
    return '#' + rgb.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

export interface ColorPick {
    eye: 0 | 1;
    x: number;
    y: number;
    origin: VbPixelOrigin;
    palette?: number;
    entry?: number;
    colors: string[];
}

export type ColorPackageStatus =
    | 'none'
    | 'loading'
    | 'ready'
    // the colorization ships no package, so its colors cannot be edited
    | 'unavailable'
    | 'failed';

// the world a picked pixel belongs to, read from the picture's pixel origins, so it covers only what the world shows on
// the screen
export interface ColorElement {
    eye: 0 | 1;
    world: number;
    kind: 'cells' | 'objects';
    segments: number[];
    box: { x: number, y: number, width: number, height: number };
    // per box pixel: its tile's index, -1 where the world drew nothing
    tileAt: Int32Array;
    what: Uint32Array;
    where: Uint32Array;
    tiles: ColorTile[];
}

export interface ColorTile {
    index: number;
    // index runs across segments (segment << 12 | cell)
    cell?: { segment: number, x: number, y: number, index: number };
    object?: number;
    character: number;
    // GPLT or JPLT 0-3: which palette of its group the placement takes
    selector: number;
    // position of one of its pixels in the element's box
    pixel: number;
    // what the world adds to the palette the attribute names (WCEN)
    offset: number;
}

export type ColorTool = 'select' | 'pipette' | 'none'; // 'none' shows the game as it is and leaves its clicks to it

export type ColorEditorBlock =
    | 'noGame'
    | 'noColorization';

const VCU = 0x03000000;
const CRAM = 0x00079000;
// GPLT0-3, then JPLT0-3
const VIP_PALETTES = 0x0005f860;
const SAVE_DELAY_MS = 400;
const MAX_UNDO = 100;
const COALESCE_MS = 1000;

const COLOR_FOLDER_EXTENSION = '.vueport-color';

export class ColorEditor {

    protected active = false;
    protected documentState?: ColorEditDocument;
    protected documentPath?: string;
    protected saveTimer?: ReturnType<typeof setTimeout>;
    // the document as it was (JSON), or a step owned by a view (the sheet editor's selected area)
    protected undoStack: (string | ColorViewStep)[] = [];
    protected redoStack: (string | ColorViewStep)[] = [];
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    selection?: string;
    pick?: ColorPick;
    focus?: { sheet: string, keys: ReadonlySet<string> };
    unplaced?: ColorUnplaced;
    // the last pick hit nothing the package knows (a screen it does not color)
    pickedNothing = false;
    packageIndex?: ColorPackageIndex;
    packageStatus: ColorPackageStatus = 'none';
    packageError?: string;
    protected readonly packages = new Map<string, Promise<{ index: ColorPackageIndex, bytes: Uint8Array, runtime?: Uint8Array }>>();
    // the loaded package's file under a cache key, plus the shipped BPS that is its runtime when the package carries
    // only the BPS's hash
    protected packageBytes?: { key: string, bytes: Uint8Array, runtime?: Uint8Array };
    protected readonly compiler: ColorCompiler;
    // no tool at first: the game undimmed and its clicks its own until a tool is taken
    tool: ColorTool = 'none';
    // palette the brush paints with: 0 for the character's own, 0xFF to cut out
    brush = 0;
    brushColors: string[] = ['#ffffff', '#000000', '#e53935', '#1e88e5'];
    brushSlot = 0;
    // null where no character covers a pixel; kept across sheets
    clipboard?: { width: number, height: number, pixels: (string | null)[], x: number, y: number, sheet: string };

    readonly toolOptions: SheetToolOptions = {
        penSize: 1, penShape: 'square', areaMode: 'replace', areaShape: 'rectangle', fillMode: 'all', modelFillMode: 'all', rectFill: true, rectStroke: 1, lineWidth: 1,
    };

    setToolOption<K extends keyof SheetToolOptions>(name: K, value: SheetToolOptions[K]): void {
        this.toolOptions[name] = value;
        this.changed();
    }

    get brushColor(): string {
        return this.brushColors[this.brushSlot];
    }
    build?: ColorBuild & { revision: number, index: ColorPackageIndex };
    building = false;
    buildError?: string;

    constructor(protected readonly host: ColorEditorHost) {
        this.compiler = new ColorCompiler(host.colorWorkerUrl);
    }

    get document(): ColorEditDocument | undefined {
        return this.documentState;
    }

    get isActive(): boolean {
        return this.active;
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    protected changed(): void {
        this.onDidChangeEmitter.fire();
    }

    // --- Coming and going ---------------------------------------------------

    async activate(): Promise<void> {
        if (this.active) {
            return;
        }
        this.active = true;
        window.addEventListener('keydown', this.onKey);
        await this.load();
        this.changed();
        await this.loadPackage();
    }

    async deactivate(): Promise<void> {
        if (!this.active) {
            return;
        }
        this.active = false;
        window.removeEventListener('keydown', this.onKey);
        this.flushSave();
        this.pick = undefined;
        this.changed();
    }

    // a new session started underneath the editor (a restart, another ROM): what was picked in the old machine is gone,
    // and the document may not even be this game's
    async sessionChanged(): Promise<void> {
        this.pick = undefined;
        this.focus = undefined;
        this.unplaced = undefined;
        this.pickedNothing = false;
        this.element = undefined;
        this.tile = undefined;
        if (!this.active) {
            this.documentState = undefined;
            this.documentPath = undefined;
            this.changed();
            return;
        }
        await this.load();
        this.changed();
        await this.loadPackage();
    }

    get block(): ColorEditorBlock | undefined {
        if (!this.host.sim() || !this.host.originalRom()) {
            return 'noGame';
        }
        const on = this.host.colorizations().some(colorization => colorization.enabled)
            // a game made for VB Color is its own colorization
            || this.host.vbcActive();
        return on ? undefined : 'noColorization';
    }

    // --- The package --------------------------------------------------------

    // short reference to a sheet or folder of the project tree to hand on, e.g. to the package's maintainer:
    // `<catalog patch id>#<sheet id>` or `<catalog patch id>#folder:<path>`
    treeReference(kind: 'sheet' | 'folder', id: string): string {
        return `${this.packageEntry()?.id ?? 'package'}#${kind === 'folder' ? 'folder:' : ''}${id}`;
    }

    // catalog entry of the switched-on colorization if it ships a package; with the editor's own build on, that of the
    // colorization the build was made on
    protected packageEntry(): { id: string, file: string } | undefined {
        const colorization = this.host.colorizations().find(c => c.enabled);
        const id = colorization?.id === COLOR_EDIT_PATCH_ID ? this.documentState?.base?.patch : colorization?.id;
        if (!id) {
            return undefined;
        }
        for (const game of PATCH_DATABASE) {
            const patch = game.patches.find(p => p.id === id);
            if (patch?.package) {
                return { id: patch.id, file: patch.package };
            }
        }
        return undefined;
    }

    protected async loadPackage(): Promise<void> {
        const entry = this.packageEntry();
        const original = this.host.originalRom();
        const published = entry && colorPackageFile(entry.file);
        const loadShipped = this.host.loadShipped;
        this.packageIndex = undefined;
        this.focus = undefined;
        this.unplaced = undefined;
        this.pickedNothing = false;
        this.groupSheets.clear();
        this.packageError = undefined;
        this.pendingImport = undefined;
        if (!entry || !published || !original || (published.runtime && !loadShipped)) {
            this.packageStatus = this.host.sim() ? 'unavailable' : 'none';
            this.changed();
            return;
        }
        this.packageStatus = 'loading';
        this.changed();
        let loading = this.packages.get(entry.id);
        if (!loading) {
            loading = Promise.all([
                fetchColorPackage(published, this.host.colorPackagesUrl),
                published.runtime ? loadShipped!(published.runtime) : undefined,
            ]).then(async ([bytes, runtime]) => ({ index: new ColorPackageIndex(await readColorPackage(bytes, runtime), original), bytes, runtime }));
            this.packages.set(entry.id, loading);
        }
        try {
            const { index, bytes, runtime } = await loading;
            if (this.packageEntry()?.id !== entry.id) {
                return;     // switched to another colorization meanwhile; that load reports itself
            }
            this.packageIndex = index;
            this.packageBytes = { key: `${entry.id}@${index.pkg.version}`, bytes, runtime };
            this.packageStatus = 'ready';
            void this.buildBase(index);
            if (this.documentState && !this.documentState.base) {
                this.documentState.base = { patch: entry.id, version: index.pkg.version };
            }
        } catch (error) {
            this.packages.delete(entry.id);
            this.packageStatus = 'failed';
            this.packageError = error instanceof Error ? error.message : String(error);
        }
        this.changed();
    }

    // the package built without paint, which the sheets show under the paint. Not the last build or the running game:
    // those hold the paint as it was then, which would still show after being taken off
    protected base?: { index: ColorPackageIndex, rom: Uint8Array };

    protected async buildBase(index: ColorPackageIndex): Promise<void> {
        const bytes = this.packageBytes;
        if (!bytes || this.base?.index === index) {
            return;
        }
        try {
            const build = await this.compiler.compile(bytes.key, bytes, index, { tiles: {} });
            if (this.packageIndex === index) {
                this.base = { index, rom: build.rom };
                this.changed();
            }
        } catch {
            // the sheets show the running ROM's colors instead
        }
    }

    protected shownCache?: {
        rom: Uint8Array,
        index: ColorPackageIndex,
        looks: Map<string | undefined, (key: string, way: string) => ColorShownPixel[] | undefined>,
    };

    // what the package shows of a load position drawn a way, without paint: its 64 pixels (value, shade, color) read
    // from the unpainted build's own tables (shownRom); undefined where that ROM is no build of the package
    shownPixels(key: string, way: string, scene?: string): ColorShownPixel[] | undefined {
        const index = this.packageIndex;
        const shownRom = this.shownRom();
        if (!index || !shownRom) {
            return undefined;
        }
        if (this.shownCache?.rom !== shownRom || this.shownCache.index !== index) {
            this.shownCache = { rom: shownRom, index, looks: new Map() };
        }
        // cached per scene, since a package with palette banks shows a sheet in the scene it appears in
        let look = this.shownCache.looks.get(scene);
        if (!look) {
            try {
                look = index.shown(shownRom, scene);
            } catch {
                return undefined;
            }
            this.shownCache.looks.set(scene, look);
        }
        return look(key, way);
    }

    protected cellCache?: { rom: Uint8Array, index: ColorPackageIndex, looks: Map<string | undefined, ColorCellShown> };

    /**
     * Returns the 64 pixels the running ROM shows of a BG map cell that the package colors per cell, holding the
     * character of paint key `key`, drawn a way. `lists` are the cell's lists in force on a sheet's screen. Returns
     * null where the lists give the cell back to its character, and undefined where they don't name it (then the
     * character's colors apply, see shownPixels). Painting does not reach such a cell: its colors are the package's
     * cell request.
     */
    cellPixels(lists: readonly string[] | undefined, cell: number | undefined, key: string, way: string, scene?: string): ColorShownPixel[] | null | undefined {
        const index = this.packageIndex;
        const rom = this.shownRom();
        const tile = index?.contentOf(key);
        if (!index || !rom || !lists?.length || cell === undefined || !tile) {
            return undefined;
        }
        if (this.cellCache?.rom !== rom || this.cellCache.index !== index) {
            this.cellCache = { rom, index, looks: new Map() };
        }
        let look = this.cellCache.looks.get(scene);
        if (!look) {
            try {
                look = index.cellShown(rom, scene);
            } catch {
                return undefined;
            }
            this.cellCache.looks.set(scene, look);
        }
        return look(lists, cell, way, tile);
    }

    protected contextCellCache?: { rom: Uint8Array, index: ColorPackageIndex, look: (key: string, cell: number, way: string) => ColorShownPixel[] | undefined };

    /**
     * Returns the 64 pixels a context package's build shows of BG map cell `cell` (segment * 4096 + cell, where a sheet
     * part was seen) holding the character of paint key `key`, drawn a way, where the context colors that cell per
     * cell. Painting the character does not reach such a cell (see cellPixels). Undefined where the cell shows the
     * character's colors (shownPixels), and for packages other than context packages.
     */
    contextCellPixels(key: string, cell: number | undefined, way: string): ColorShownPixel[] | undefined {
        const index = this.packageIndex;
        const rom = this.shownRom();
        if (!index || index.kind !== 'contexts' || !rom || cell === undefined) {
            return undefined;
        }
        if (this.contextCellCache?.rom !== rom || this.contextCellCache.index !== index) {
            try {
                this.contextCellCache = { rom, index, look: index.contextCellShown(rom) };
            } catch {
                return undefined;
            }
        }
        return this.contextCellCache.look(key, cell, way);
    }

    // paint goes over the unpainted build, so it is preferred over the running ROM
    shownRom(): Uint8Array | undefined {
        return this.base && this.base.index === this.packageIndex ? this.base.rom : this.host.runningRom();
    }

    // --- The project tree ---------------------------------------------------

    groupName(group: ColorEntityGroup): string {
        return this.documentState?.names?.[group.id] || group.name;
    }

    renameGroup(group: ColorEntityGroup, name: string): void {
        const trimmed = name.trim();
        const wanted = trimmed === group.name ? '' : trimmed;
        if ((this.documentState?.names?.[group.id] ?? '') === wanted) {
            return;
        }
        this.mutate(document => {
            const names = document.names ??= {};
            if (wanted) {
                names[group.id] = wanted;
            } else {
                delete names[group.id];
            }
            if (!Object.keys(names).length) {
                delete document.names;
            }
        });
    }

    paintedByGroup(): Map<string, number> {
        const counts = new Map<string, number>();
        const index = this.packageIndex;
        for (const key of Object.keys(this.documentState?.paint.tiles ?? {})) {
            const group = index?.groupOf(key);
            if (group) {
                counts.set(group, (counts.get(group) ?? 0) + 1);
            }
        }
        return counts;
    }

    isPainted(key: string): boolean {
        return !!this.documentState?.paint.tiles[key];
    }

    // the screen (context) the runtime has active; undefined unless a context package is running
    async activeContext(): Promise<number | undefined> {
        const sim = this.host.sim();
        if (!sim || this.packageIndex?.kind !== 'contexts') {
            return undefined;
        }
        return new Uint16Array(await sim.readMemory(COLOR_CONTEXT_STATE, 2))[0];
    }

    // id of the active overlay (pause, menu, dialog box) for a context package, 0 for none
    async activeOverlay(): Promise<number | undefined> {
        const sim = this.host.sim();
        if (!sim || this.packageIndex?.kind !== 'contexts' || !this.packageIndex.pkg.overlays?.length) {
            return undefined;
        }
        return new Uint16Array(await sim.readMemory(COLOR_OVERLAY_STATE, 2))[0];
    }

    // --- Paint ----------------------------------------------------------------

    setBrushColor(color: string): void {
        this.brushColors[this.brushSlot] = color;
        this.changed();
    }

    chooseBrush(slot: number): void {
        this.brushSlot = ((slot % this.brushColors.length) + this.brushColors.length) % this.brushColors.length;
        this.changed();
    }

    nextBrush(step = 1): void {
        this.chooseBrush(this.brushSlot + step);
    }

    paintOf(key: string, way: string): (string | null)[] | undefined {
        return this.documentState?.paint.tiles[key]?.[way];
    }

    // --- What is changed, and taking it back ----------------------------------------

    protected paintedCache?: { revision: number, document?: ColorEditDocument, keys: Set<string> };

    // hidden layers included
    paintedKeys(): Set<string> {
        const document = this.documentState;
        if (this.paintedCache?.revision !== this.revision || this.paintedCache.document !== document) {
            const keys = new Set<string>();
            for (const tiles of document?.layers?.map(layer => layer.tiles) ?? [document?.paint.tiles ?? {}]) {
                Object.keys(tiles).forEach(key => keys.add(key));
            }
            this.paintedCache = { revision: this.revision, document, keys };
        }
        return this.paintedCache.keys;
    }

    sheetChanged(sheet: ColorSheet): boolean {
        if (sheet.id.startsWith(MODEL_SHEET_PREFIX) || sheet.id.startsWith(MODEL_CLASS_PREFIX)) {
            return this.modelChanged(sheet.id);
        }
        const painted = this.paintedKeys();
        return painted.size > 0 && sheet.items.some(item => item.parts.some(part => this.partKeys(sheet, part, item).some(key => painted.has(key))));
    }

    // its character's key, plus its cell's key where the cell lists (the item's, else the sheet's) color that cell
    partKeys(sheet: ColorSheet, part: ColorSheetPart, item?: ColorSheetItem): string[] {
        const lists = item?.lists ?? sheet.lists;
        const ref = lists && part[6] !== undefined ? this.packageIndex?.cellRef(lists, part[6]) : undefined;
        // for a context package, the key of its BG map cell where the context colors the cell rather than the character
        const cell = !ref ? this.packageIndex?.contextCellKey(part[2], part[6]) : undefined;
        return ref ? [part[2], makeColorCellKey(ref.list, ref.cell, part[2])] : cell ? [part[2], cell] : [part[2]];
    }

    changes(): { characters: number, sheets: number, backdrops: number, edges: number } {
        const painted = this.paintedKeys();
        const paint = this.documentState?.paint;
        const edges = Object.values(paint?.models ?? {}).reduce((sum, model) => sum + Object.keys(model.edges).length, 0)
            + Object.keys(paint?.classes ?? {}).length;
        const sheets = painted.size || edges ? this.sheetEntries().filter(entry => this.sheetChanged(entry.sheet)).length : 0;
        return { characters: painted.size, sheets, backdrops: Object.keys(this.documentState?.backdrops ?? {}).length, edges };
    }

    async resetSheetPaint(sheet: ColorSheet, name: string): Promise<void> {
        const agreed = await this.host.notifications.confirm({
            title: nls.localize('vueport/color/reset/sheetTitle', 'Reset "{0}"?', name),
            message: nls.localize('vueport/color/reset/sheetMessage',
                'The paint on this sheet\'s characters is taken off, on every layer: they show the package\'s colors again. Undo brings it back.'),
            okLabel: nls.localize('vueport/color/reset/sheetOk', 'Reset to Package Colors'),
        });
        if (!agreed) {
            return;
        }
        if (sheet.id.startsWith(MODEL_SHEET_PREFIX) || sheet.id.startsWith(MODEL_CLASS_PREFIX)) {
            this.resetModel(sheet.id);
            return;
        }
        // also wherever else the game loads the same characters, since painting changed them together
        const index = this.packageIndex;
        const keys = new Set(sheet.items.flatMap(item => item.parts.flatMap(part => this.partKeys(sheet, part, item)
            .flatMap(key => index ? index.samePositions(key) : [key]))));
        this.mutate(document => {
            for (const tiles of document.layers?.map(layer => layer.tiles) ?? [document.paint.tiles]) {
                keys.forEach(key => delete tiles[key]);
            }
            keys.forEach(key => delete document.paint.tiles[key]);
            this.mergeLayers(document);
        });
    }

    async resetAllPaint(): Promise<void> {
        const agreed = await this.host.notifications.confirm({
            title: nls.localize('vueport/color/reset/allTitle', 'Reset All Changes?'),
            message: nls.localize('vueport/color/reset/allMessage',
                'All paint, on every layer, and all backdrops are taken off: the colorization shows the package\'s colors again. Undo brings it back.'),
            okLabel: nls.localize('vueport/color/reset/allOk', 'Reset All'),
        });
        if (!agreed) {
            return;
        }
        this.mutate(document => {
            document.layers?.forEach(layer => {
                layer.tiles = {};
                delete layer.models;
                delete layer.classes;
            });
            document.paint = { ...document.paint, tiles: {}, models: undefined, classes: undefined };
            delete document.backdrops;
        });
    }

    // --- Paint layers -----------------------------------------------------------

    selectedPaintLayers: ReadonlySet<string> = new Set();

    // top layer first; with no layers made yet, the one paint there is shows as "Layer 1"
    paintLayers(): ColorPaintLayerEntry[] {
        const document = this.documentState;
        if (!document) {
            return [];
        }
        return document.layers ?? [{ id: '1', name: nls.localize('vueport/color/layer/name', 'Layer {0}', 1), visible: true, tiles: document.paint.tiles }];
    }

    canPaint(): boolean {
        return this.paintLayers().find(layer => layer.id === this.activePaintLayer())?.visible ?? true;
    }

    activePaintLayer(): string {
        const layers = this.paintLayers();
        const id = this.documentState?.activeLayer;
        return layers.some(layer => layer.id === id) ? id! : layers[0]?.id ?? '1';
    }

    protected mergeLayers(document: ColorEditDocument): void {
        if (document.layers) {
            const visible = document.layers.filter(layer => layer.visible);
            document.paint = { ...document.paint, tiles: mergeTiles(visible), ...mergeModels(visible) };
        }
    }

    protected layersOf(document: ColorEditDocument): ColorPaintLayerEntry[] {
        return document.layers ??= [{
            id: '1', name: nls.localize('vueport/color/layer/name', 'Layer {0}', 1), visible: true,
            tiles: JSON.parse(JSON.stringify(document.paint.tiles)),
            ...JSON.parse(JSON.stringify({ models: document.paint.models, classes: document.paint.classes })),
        }];
    }

    choosePaintLayer(id: string, mark: 'only' | 'toggle' = 'only'): void {
        if (this.documentState) {
            this.documentState.activeLayer = id;
            this.scheduleSave();
        }
        const marked = new Set(mark === 'toggle' ? this.selectedPaintLayers : []);
        if (mark === 'toggle' && marked.has(id) && marked.size > 1) {
            marked.delete(id);
        } else {
            marked.add(id);
        }
        this.selectedPaintLayers = marked;
        this.changed();
    }

    addPaintLayer(): void {
        const id = String(Date.now());
        this.mutate(document => {
            const layers = this.layersOf(document);
            const at = Math.max(0, layers.findIndex(layer => layer.id === this.activePaintLayer()));
            const used = new Set(layers.map(layer => layer.name));
            let n = layers.length + 1;
            while (used.has(nls.localize('vueport/color/layer/name', 'Layer {0}', n))) {
                n++;
            }
            layers.splice(at, 0, { id, name: nls.localize('vueport/color/layer/name', 'Layer {0}', n), visible: true, tiles: {} });
            document.activeLayer = id;
        });
        this.selectedPaintLayers = new Set([id]);
        this.changed();
    }

    renamePaintLayer(id: string, name: string): void {
        this.mutate(document => {
            const layer = this.layersOf(document).find(l => l.id === id);
            if (layer && name.trim()) {
                layer.name = name.trim();
            }
        });
    }

    // a hidden layer is left out of the build too
    setPaintLayerVisible(id: string, visible: boolean): void {
        this.mutate(document => {
            const layer = this.layersOf(document).find(l => l.id === id);
            if (layer) {
                layer.visible = visible;
                this.mergeLayers(document);
            }
        });
    }

    movePaintLayer(id: string, by: -1 | 1): void {
        this.mutate(document => {
            const layers = this.layersOf(document);
            const at = layers.findIndex(layer => layer.id === id);
            const to = at + by;
            if (at >= 0 && to >= 0 && to < layers.length) {
                [layers[at], layers[to]] = [layers[to], layers[at]];
                this.mergeLayers(document);
            }
        });
    }

    // one layer is always left
    deletePaintLayers(ids: ReadonlySet<string>): void {
        this.mutate(document => {
            const layers = this.layersOf(document);
            const left = layers.filter(layer => !ids.has(layer.id));
            document.layers = left.length ? left : [{ ...layers[layers.length - 1], tiles: {}, models: undefined, classes: undefined }];
            if (!document.layers.some(layer => layer.id === document.activeLayer)) {
                document.activeLayer = document.layers[0].id;
            }
            this.mergeLayers(document);
        });
        this.selectedPaintLayers = new Set([this.activePaintLayer()]);
        this.changed();
    }

    mergePaintLayers(ids: ReadonlySet<string>): void {
        if (ids.size < 2) {
            return;
        }
        this.mutate(document => {
            const layers = this.layersOf(document);
            const marked = layers.filter(layer => ids.has(layer.id));
            const top = marked[0];
            const merged: ColorPaintLayerEntry = { ...top, visible: marked.some(layer => layer.visible), tiles: mergeTiles(marked), ...mergeModels(marked) };
            document.layers = layers.filter(layer => !ids.has(layer.id) || layer === top).map(layer => layer === top ? merged : layer);
            document.activeLayer = merged.id;
            this.mergeLayers(document);
        });
        this.selectedPaintLayers = new Set([this.activePaintLayer()]);
        this.changed();
    }

    // changes pixels as one Undo step, only on the given paint keys (load positions), not on others holding the same
    // character: the user paints what they point at, and the same picture loaded elsewhere keeps its colors
    paintPixels(changes: readonly ColorPixelChange[]): void {
        const index = this.packageIndex;
        if (!index || !changes.length || !this.canPaint()) {
            return;
        }
        const all = [...changes];
        const target = (document: ColorEditDocument): ColorPaintLayer['tiles'] =>
            document.layers?.find(layer => layer.id === this.activePaintLayer())?.tiles ?? document.paint.tiles;
        const now = this.documentState && target(this.documentState);
        if (all.every(change => (now?.[change.key]?.[change.way]?.[change.i] ?? null) === change.color)) {
            return;
        }
        this.mutate(document => {
            const tiles = target(document);
            for (const { key, way, i, color } of all) {
                const tile = tiles[key] ??= {};
                (tile[way] ??= new Array<string | null>(64).fill(null))[i] = color;
            }
            for (const key of new Set(all.map(change => change.key))) {
                const tile = tiles[key];
                for (const way of Object.keys(tile ?? {})) {
                    if (tile[way].every(color => color === null)) {
                        delete tile[way];
                    }
                }
                if (tile && !Object.keys(tile).length) {
                    delete tiles[key];
                }
            }
            this.mergeLayers(document);
        });
    }

    wantedPixels(key: string, way: string, scene?: string): ColorShownPixel[] | undefined {
        const shown = this.shownPixels(key, way, scene);
        if (!shown) {
            return undefined;
        }
        // a context package's shared keys (a figure in every stage) lie under the key's own paint, as the compiler
        // lays them
        const paints = [...this.packageIndex?.sharedOf(key) ?? [], key].map(other => this.paintOf(other, way)).filter(paint => !!paint);
        return paints.length
            ? shown.map(([value, shade, color], i) => [value, shade, paints.reduce<string | null>((wanted, paint) => paint![i] ?? wanted, color)])
            : shown;
    }

    // --- Sheets ---------------------------------------------------------------

    sheetId?: string;
    protected readonly onDidOpenSheetEmitter = new Emitter<string>();
    // the dock brings the sheet editor forward
    readonly onDidOpenSheet: Event<string> = this.onDidOpenSheetEmitter.event;

    sheetEntries(): ColorSheetEntry[] {
        const places = this.documentState?.places ?? {};
        const sheets = this.packageIndex?.pkg.sheets ?? [];
        const models = this.modelPackage ? this.modelEntries(this.modelPackage) : [];
        const entries: ColorSheetEntry[] = sheets.map(sheet => ({
            sheet,
            own: false,
            name: places[sheet.id]?.name || sheet.name,
            folder: places[sheet.id]?.folder ?? sheet.folder,
        }));
        for (const sheet of this.documentState?.sheets ?? []) {
            entries.push({ sheet, own: true, name: sheet.name, folder: sheet.folder });
        }
        entries.push(...models.map(entry => ({
            ...entry, name: places[entry.sheet.id]?.name || entry.name, folder: places[entry.sheet.id]?.folder ?? entry.folder,
        })));
        return entries;
    }

    sheetEntry(id: string | undefined): ColorSheetEntry | undefined {
        if (id?.startsWith(GROUP_SHEET_PREFIX)) {
            return this.groupSheet(id.slice(GROUP_SHEET_PREFIX.length));
        }
        return id === undefined ? undefined : this.sheetEntries().find(entry => entry.sheet.id === id);
    }

    protected readonly groupSheets = new Map<string, ColorSheet>();
    protected packageSheetKeys?: { index: ColorPackageIndex, keys: Set<string> };
    protected ownSheetKeys?: { signature: string, keys: Set<string> };

    onSomeSheet(key: string): boolean {
        const index = this.packageIndex;
        if (index && this.packageSheetKeys?.index !== index) {
            const keys = new Set<string>();
            for (const sheet of index.pkg.sheets ?? []) {
                sheet.items.forEach(item => item.parts.forEach(part => keys.add(part[2])));
            }
            this.packageSheetKeys = { index, keys };
        }
        const own = this.documentState?.sheets ?? [];
        const signature = own.map(sheet => `${sheet.id}:${sheet.items.map(item => item.parts.length).join(',')}`).join(';');
        if (this.ownSheetKeys?.signature !== signature) {
            const keys = new Set<string>();
            own.forEach(sheet => sheet.items.forEach(item => item.parts.forEach(part => keys.add(part[2]))));
            this.ownSheetKeys = { signature, keys };
            // the user's sheets changed, and with them which characters are on no sheet
            this.groupSheets.clear();
        }
        return !!this.packageSheetKeys?.keys.has(key) || this.ownSheetKeys.keys.has(key);
    }

    /**
     * Shows the characters of a package group (a table, a screen) that no sheet shows as a sheet of their own, in their
     * order, 16 to a row, with those by number and those by content each a picture of their own. Characters the package
     * colors by group (their content changes) are left out, as they cannot be painted.
     */
    protected groupSheet(groupId: string): ColorSheetEntry | undefined {
        const index = this.packageIndex;
        const group = index?.groups().find(g => g.id === groupId);
        if (!index || !group) {
            return undefined;
        }
        this.onSomeSheet('');      // refreshes the caches; a change of the user's sheets clears the group sheets
        let sheet = this.groupSheets.get(groupId);
        if (!sheet) {
            const items = index.sections(groupId).map((section, n) => ({
                x: 0,
                y: n,
                parts: section.entities.filter(entity => entity.ways.length && !entity.anyContent && !this.onSomeSheet(entity.key))
                    .map((entity, i): ColorSheetPart => [(i % 16) * 8, Math.floor(i / 16) * 8, entity.key, 0, 0, colorLitWay(entity.ways[0])]),
            })).filter(item => item.parts.length);
            sheet = { id: GROUP_SHEET_PREFIX + groupId, name: group.name, folder: '', kind: 'layer', w: 128, h: 8, items };
            this.groupSheets.set(groupId, sheet);
        }
        return { sheet, own: false, name: this.groupName(group), folder: '', group: true };
    }

    // the tree lists only groups with a character no sheet shows
    hasUnsheeted(groupId: string): boolean {
        return !!this.groupSheet(groupId)?.sheet.items.length;
    }

    sheetFolders(): string[] {
        const folders = new Set<string>();
        const add = (path: string): void => {
            for (let at = path; at; at = parentFolder(at)) {
                folders.add(at);
            }
        };
        this.sheetEntries().forEach(entry => add(entry.folder));
        (this.documentState?.folders ?? []).forEach(add);
        return [...folders];
    }

    // --- Backdrops ------------------------------------------------------------

    // what a sheet's backdrop belongs to: for a context package the context of a group sheet ('context:<id>'), for a
    // load-source package the screen a whole-screen sheet shows (its folder of sheets, e.g. 'screens/title')
    backdropTarget(entry: ColorSheetEntry | undefined): string | undefined {
        const index = this.packageIndex;
        const id = entry?.sheet.id;
        if (!index || !id) {
            return undefined;
        }
        if (index.kind === 'contexts') {
            const match = /^group:context:(\d+)$/.exec(id);
            return match ? `context:${match[1]}` : undefined;
        }
        // a whole screen the runtime knows by the set that brings it, e.g. Hyper Fighting's layer sheets of a screen
        // ('scr:<k>')
        const kind = entry!.sheet.kind;
        return (kind === 'screen' || kind === 'layer') && !entry!.own ? entry!.sheet.backdrop : undefined;
    }

    // whether a backdrop painted for the target reaches the game (a context of a runtime with BKREN)
    backdropReachesGame(target: string): boolean {
        const id = /^context:(\d+)$/.exec(target)?.[1];
        if (id !== undefined) {
            return this.packageIndex?.backdropRows(Number(id)) !== undefined;
        }
        return !!this.packageIndex?.pkg.backdrops?.some(([, t]) => t === target);
    }

    backdrop(target: string): ColorBackdrop | undefined {
        return this.documentState?.backdrops?.[target];
    }

    // as painted, else as the package has it (a context), else undefined for black
    backdropRows(target: string | undefined): string[] | undefined {
        if (!target) {
            return undefined;
        }
        const painted = this.backdrop(target);
        if (painted) {
            return backdropRowColors(painted);
        }
        const id = /^context:(\d+)$/.exec(target)?.[1];
        if (id !== undefined) {
            return this.packageIndex?.backdropRows(Number(id));
        }
        // a package's own rows per screen (Hyper Fighting's skies), as its build shows them
        return (this.packageIndex?.pkg.backdropRows as { [target: string]: string[] } | undefined)?.[target];
    }

    // undefined goes back to the package's backdrop; with coalesce a run of changes (a stop dragged) is one Undo step
    setBackdrop(target: string, backdrop: ColorBackdrop | undefined, coalesce = false): void {
        this.mutate(document => {
            if (backdrop) {
                (document.backdrops ??= {})[target] = JSON.parse(JSON.stringify(backdrop));
            } else if (document.backdrops) {
                delete document.backdrops[target];
            }
            cleanDocument(document);
        }, coalesce ? `backdrop:${target}` : undefined);
    }

    protected compiledPaint(document: ColorEditDocument): ColorPaintLayer {
        const layer: ColorPaintLayer = JSON.parse(JSON.stringify(document.paint));
        for (const [target, backdrop] of Object.entries(document.backdrops ?? {})) {
            // a context by its id; a load-source package's screen by its target ('set:<source>')
            const key = /^context:(\d+)$/.exec(target)?.[1] ?? target;
            (layer.backdrops ??= {})[key] = backdropRowColors(backdrop);
        }
        return layer;
    }

    revealSheet(): void {
        if (this.sheetId !== undefined) {
            this.onDidOpenSheetEmitter.fire(this.sheetId);
        }
    }

    // opens the sheet of the screen the game shows now (for a context package, the active context): a whole-screen
    // sheet first, then the one with most of the context's characters; the context's character grid where none has any
    openActiveScreen(context: number, overlay?: number): void {
        const over = overlay ? this.packageIndex?.overlayKey(overlay) : undefined;
        if (over !== undefined) {
            context = over;
        }
        const prefix = `${context}:`;
        let best: { id: string, screen: boolean, count: number } | undefined;
        for (const entry of this.sheetEntries()) {
            const sheet = entry.sheet;
            let inside = 0, all = 0;
            for (const item of sheet.items ?? []) {
                for (const part of item.parts) {
                    all++;
                    if (part[2].startsWith(prefix)) {
                        inside++;
                    }
                }
            }
            // a sheet of this screen has most of its characters from the context, unlike a shared sheet of every stage
            if (!inside || inside * 2 < all) {
                continue;
            }
            const screen = sheet.kind === 'screen';
            if (!best || (screen && !best.screen) || (screen === best.screen && inside > best.count)) {
                best = { id: sheet.id, screen, count: inside };
            }
        }
        this.openSheet(best?.id ?? `${GROUP_SHEET_PREFIX}${over !== undefined ? 'overlay' : 'context'}:${context}`);
    }

    openSheet(id: string, focus?: ReadonlySet<string>): void {
        this.sheetId = id;
        this.focus = focus && { sheet: id, keys: focus };
        this.unplaced = undefined;
        this.pickedNothing = false;
        this.changed();
        this.onDidOpenSheetEmitter.fire(id);
    }

    // after a pick on the screen, opens the sheet with most of the picked figure's (or background's) characters, with
    // them marked; where none has any, offers a new sheet of it
    protected async showPicked(): Promise<void> {
        const element = this.element;
        const index = this.packageIndex;
        if (!element || !index || this.packageStatus !== 'ready') {
            return;
        }
        const parts = await this.elementParts(element);
        if (!parts.length) {
            // characters the package knows by their place on a screen, not their content (Zero Racers' VIP screens)
            const byCell = await this.cellSheet(element);
            if (byCell) {
                this.openSheet(byCell.id, byCell.keys);
                return;
            }
            // nothing of it in the package: the sheet tab says so, rather than nothing happening
            this.unplaced = undefined;
            this.pickedNothing = true;
            this.sheetId = undefined;
            this.focus = undefined;
            this.changed();
            this.onDidOpenSheetEmitter.fire('');
            return;
        }
        // needs at least half of its characters: the same content (blank, solid, stars) stands in many tables, so a few
        // shared ones say nothing
        const keys = new Set(parts.map(part => part[2]));
        let best: ColorSheetEntry | undefined;
        let most = 0;
        for (const entry of this.sheetEntries()) {
            const has = new Set(entry.sheet.items.flatMap(item => item.parts.map(part => part[2])).filter(key => keys.has(key)));
            if (has.size > most) {
                best = entry;
                most = has.size;
            }
        }
        if (best && most * 2 >= keys.size) {
            this.openSheet(best.sheet.id, new Set([...keys].flatMap(key => index.samePositions(key))));
        } else {
            this.unplaced = { kind: element.kind === 'objects' ? 'figures' : 'layer', parts };
            this.pickedNothing = false;
            this.sheetId = undefined;
            this.focus = undefined;
            this.changed();
            this.onDidOpenSheetEmitter.fire('');
        }
    }

    // the sheet whose parts name the most of a picked background's BG map cells, each holding the character the part
    // shows (the content tells apart screens that use the same cells), and those parts' keys
    protected async cellSheet(element: ColorElement): Promise<{ id: string, keys: Set<string> } | undefined> {
        const sim = this.host.sim();
        const index = this.packageIndex;
        if (!sim || !index) {
            return undefined;
        }
        const drawn = new Map<number, number>();
        element.tiles.forEach(tile => tile.cell && drawn.set(tile.cell.index, tile.character));
        if (!drawn.size) {
            return undefined;
        }
        const contents = new Map<number, Uint8Array>();
        for (const character of new Set(drawn.values())) {
            contents.set(character, new Uint8Array(await sim.readMemory(0x00078000 + character * 16, 16)));
        }
        const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);
        let best: { id: string, keys: Set<string> } | undefined;
        let most = 0;
        for (const entry of this.sheetEntries()) {
            const keys = new Set<string>();
            let count = 0;
            for (const item of entry.sheet.items) {
                for (const part of item.parts) {
                    const character = part[6] !== undefined ? drawn.get(part[6]) : undefined;
                    const tile = character !== undefined ? index.position(part[2])?.tile : undefined;
                    if (tile && same(tile, contents.get(character!)!)) {
                        count++;
                        keys.add(part[2]);
                    }
                }
            }
            if (count > most) {
                best = { id: entry.sheet.id, keys };
                most = count;
            }
        }
        // needs at least half of the picked cells, a few blank or solid ones say nothing
        return best && most * 2 >= drawn.size ? best : undefined;
    }

    depthName(sheet: string, depth: number): string | undefined {
        return this.documentState?.depths?.[sheet]?.[depth] ?? undefined;
    }

    renameDepth(sheet: string, depth: number, name: string): void {
        const wanted = name.trim();
        if (wanted === (this.depthName(sheet, depth) ?? '')) {
            return;
        }
        this.mutate(document => {
            const names = [...(document.depths ??= {})[sheet] ?? []];
            while (names.length <= depth) {
                names.push(null);
            }
            names[depth] = wanted || null;
            while (names.length && names[names.length - 1] === null) {
                names.pop();
            }
            if (names.length) {
                document.depths![sheet] = names;
            } else {
                delete document.depths![sheet];
            }
            cleanDocument(document);
        });
    }

    renameSheet(id: string, name: string): void {
        const wanted = name.trim();
        const entry = this.sheetEntry(id);
        if (!entry || !wanted || wanted === entry.name) {
            return;
        }
        this.mutate(document => {
            if (entry.own) {
                const sheet = document.sheets?.find(s => s.id === id);
                if (sheet) {
                    sheet.name = wanted;
                }
            } else {
                const place = (document.places ??= {})[id] ??= {};
                place.name = wanted === entry.sheet.name ? undefined : wanted;
            }
            cleanDocument(document);
        });
    }

    moveSheet(id: string, folder: string): void {
        const entry = this.sheetEntry(id);
        if (!entry || entry.folder === folder) {
            return;
        }
        this.mutate(document => {
            fileSheet(document, entry, folder);
            cleanDocument(document);
        });
    }

    // the folders above it come with it (see sheetFolders)
    createFolder(path: string): void {
        const wanted = path.split('/').map(part => part.trim()).filter(Boolean).join('/');
        if (!wanted || this.sheetFolders().includes(wanted)) {
            return;
        }
        this.mutate(document => {
            (document.folders ??= []).push(wanted);
        });
    }

    moveFolder(path: string, to: string): void {
        const target = to.split('/').map(part => part.trim()).filter(Boolean).join('/');
        if (!target || target === path || target.startsWith(`${path}/`)) {
            return;
        }
        const inside = (folder: string): boolean => folder === path || folder.startsWith(`${path}/`);
        const moved = (folder: string): string => target + folder.slice(path.length);
        const entries = this.sheetEntries().filter(entry => inside(entry.folder));
        this.mutate(document => {
            entries.forEach(entry => fileSheet(document, entry, moved(entry.folder)));
            document.folders = (document.folders ?? []).map(folder => inside(folder) ? moved(folder) : folder);
            if (!document.folders.includes(target)) {
                document.folders.push(target);
            }
            cleanDocument(document);
        });
    }

    deleteFolder(path: string): void {
        const inside = (folder: string): boolean => folder === path || folder.startsWith(`${path}/`);
        const up = (folder: string): string => {
            const rest = folder.slice(path.length + 1);
            const parent = parentFolder(path);
            return [parent, rest].filter(Boolean).join('/');
        };
        const entries = this.sheetEntries().filter(entry => inside(entry.folder));
        this.mutate(document => {
            entries.forEach(entry => fileSheet(document, entry, up(entry.folder)));
            document.folders = (document.folders ?? []).filter(folder => folder !== path).map(folder => inside(folder) ? up(folder) : folder);
            cleanDocument(document);
        });
    }

    deleteSheet(id: string): void {
        if (!this.documentState?.sheets?.some(sheet => sheet.id === id)) {
            return;
        }
        this.mutate(document => {
            document.sheets = document.sheets?.filter(sheet => sheet.id !== id);
            cleanDocument(document);
        });
        if (this.sheetId === id) {
            this.sheetId = undefined;
            this.changed();
        }
    }

    // a picked element (a group of objects, a world's cells) as a picture of the package's characters: its parts, front
    // first, placed from its top left; empty where the package knows none of its characters
    protected async elementParts(element: ColorElement): Promise<ColorSheetPart[]> {
        const sim = this.host.sim();
        const index = this.packageIndex;
        if (!sim || !index) {
            return [];
        }
        const context = index.kind === 'contexts' ? await this.activeContext() : undefined;
        // with an overlay over the context, what the overlay draws or colors belongs to it, the rest to the context
        const overlay = context !== undefined ? await this.activeOverlay() : undefined;
        const contents = new Map<number, Uint8Array>();
        for (const tile of element.tiles) {
            if (!contents.has(tile.character)) {
                contents.set(tile.character, new Uint8Array(await sim.readMemory(0x00078000 + tile.character * 16, 16)));
            }
        }
        // for a load-source package, each character comes from the table most of the element's characters are in: the
        // same content is in many tables, but the element was loaded from one or a few
        const tables = new Map<string, number>();
        for (const content of contents.values()) {
            for (const table of new Set(index.positionsOf(content).map(position => position.table))) {
                tables.set(table, (tables.get(table) ?? 0) + 1);
            }
        }
        // positions the package knows the game draws from this very character come first
        const keyOf = (content: Uint8Array, character: number): string | undefined => index.positionsOf(content)
            .sort((a, b) => Number(index.drawnAt(b.key) === character) - Number(index.drawnAt(a.key) === character)
                || (tables.get(b.table) ?? 0) - (tables.get(a.table) ?? 0))[0]?.key;
        const found: { left: number, top: number, key: string, h: 0 | 1, v: 0 | 1, way: string, order: number, cell?: number }[] = [];
        for (const tile of element.tiles) {
            const at = tile.pixel;
            const origin = decodeOrigin(element.what[at], element.where[at]);
            if (!origin.pixel || origin.character === undefined) {
                continue;
            }
            const h = origin.flip?.h ? 1 : 0;
            const v = origin.flip?.v ? 1 : 0;
            const x = element.box.x + at % element.box.width;
            const y = element.box.y + Math.floor(at / element.box.width);
            const content = contents.get(origin.character) ?? new Uint8Array(await sim.readMemory(0x00078000 + origin.character * 16, 16));
            const own = overlay ? index.overlayUnit(overlay, origin.character, tile.cell?.index) : undefined;
            const key = own ? own.key : context !== undefined ? index.contextUnit(context, origin.character, content)?.key : keyOf(content, origin.character);
            if (!key) {
                continue;
            }
            const register = await this.paletteRegister(sim, origin);
            found.push({
                left: x - (h ? 7 - origin.pixel.x : origin.pixel.x),
                top: y - (v ? 7 - origin.pixel.y : origin.pixel.y),
                key, h, v,
                way: colorLitWay(colorWay(origin.kind === 'object' ? 1 : 0, tile.selector, register ?? 0xe4)),
                // the VIP draws lower-index objects over higher ones, so the lowest index is the front
                order: tile.object ?? 0,
                // an overlay's cell is painted under the cell's own key, so the part carries its cell
                ...(own && tile.cell ? { cell: tile.cell.index } : {}),
            });
        }
        if (!found.length) {
            return [];
        }
        found.sort((a, b) => a.order - b.order);
        const left = Math.min(...found.map(part => part.left));
        const top = Math.min(...found.map(part => part.top));
        return found.map((part): ColorSheetPart => part.cell !== undefined
            ? [part.left - left, part.top - top, part.key, part.h, part.v, part.way, part.cell]
            : [part.left - left, part.top - top, part.key, part.h, part.v, part.way]);
    }

    // into: one of the user's sheets to add the pick to as one more frame
    addUnplaced(into?: string): string | undefined {
        const unplaced = this.unplaced;
        if (!unplaced || !this.documentState) {
            return undefined;
        }
        const parts = unplaced.parts;
        const width = Math.max(...parts.map(part => part[0])) + 8;
        const height = Math.max(...parts.map(part => part[1])) + 8;
        const own = into !== undefined && this.documentState.sheets?.some(sheet => sheet.id === into) ? into : undefined;
        const id = own ?? `own-${Date.now().toString(36)}`;
        const figures = unplaced.kind === 'figures';
        const count = (this.documentState.sheets ?? []).length + 1;
        this.mutate(document => {
            const sheet = document.sheets?.find(s => s.id === own);
            if (sheet) {
                const x = sheet.items.length ? sheet.w + 8 : 0;
                sheet.items.push({ x, y: 0, parts });
                sheet.w = x + width;
                sheet.h = Math.max(sheet.h, height);
            } else {
                (document.sheets ??= []).push({
                    id,
                    name: figures
                        ? nls.localize('vueport/color/sheet/newFigure', 'Figure {0}', count)
                        : nls.localize('vueport/color/sheet/newBackground', 'Background {0}', count),
                    folder: OWN_FOLDER,
                    kind: figures ? 'figures' : 'layer',
                    w: width,
                    h: height,
                    items: [{ x: 0, y: 0, parts }],
                });
            }
        });
        this.openSheet(id, new Set(parts.map(part => part[2])));
        return id;
    }

    get buildStale(): boolean {
        return !this.build || this.build.revision !== this.revision || this.build.index !== this.packageIndex;
    }

    async compile(): Promise<ColorBuild | undefined> {
        const index = this.packageIndex;
        const document = this.documentState;
        if (!index || !document || this.building) {
            return undefined;
        }
        this.building = true;
        this.buildError = undefined;
        this.changed();
        // lets the panels show the build running in case the compiler blocks the thread (no worker)
        await new Promise(resolve => setTimeout(resolve, 30));
        const revision = this.revision;
        const bytes = this.packageBytes;
        try {
            if (!bytes) {
                throw new Error('the package is not loaded');
            }
            // compiledPaint makes a copy, as the paint may change while the build runs
            const build = await this.compiler.compile(bytes.key, bytes, index, this.compiledPaint(document));
            this.build = { ...build, revision, index };
            return build;
        } catch (error) {
            this.buildError = colorBuildErrorText(error);
            return undefined;
        } finally {
            this.building = false;
            this.changed();
        }
    }

    /**
     * Builds, writes the build beside the ROM and switches it on among the game's colorizations. The game restarts at
     * the moment it was at and shows the new colors wherever it loads its characters again, as a colorization by load
     * source colors characters as they are loaded. The build stays on, like a colorization the player chose.
     */
    async applyBuild(): Promise<void> {
        const build = this.buildStale ? await this.compile() : this.build;
        const index = this.packageIndex;
        const path = this.pathFor(COLOR_EDIT_BUILD_EXTENSION);
        if (!build || !index || !path) {
            return;
        }
        this.flushSave();
        try {
            await this.host.storage.write(path, colorBuildPatch(index.pkg, index.original, build.rom));
            await this.host.useBuild(true);
            const models = this.modelPackage;
            if (models) {
                // a model package's runtime fills Color RAM once at boot and the kept moment has the old colors, so the
                // build's palette table goes in now
                const at = parseInt(models.palette_table.at, 16) & (build.rom.length - 1);
                if (models.layout === 'zr') {
                    // Zero Racers: its screens install their own palettes, so only the paint's free palettes go in.
                    // Pixel Color Slots (CXCTRL.PCEN) are switched on here, since the runtime sets that only at boot
                    // and a write while the display runs does not take
                    const first = models.free_palettes[0] ?? 256;
                    const table = build.rom.slice(at + first * 16, at + models.palette_table.count * 16);
                    await this.host.sim()?.writeMemory(VCU + CRAM + first * 16, table.buffer);
                    await this.host.sim()?.writeMemory(VCU + 0x7F81A, new Uint16Array([1]).buffer);
                } else {
                    const table = build.rom.slice(at, at + models.palette_table.count * 16);
                    await this.host.sim()?.writeMemory(VCU + CRAM, table.buffer);
                }
            } else if ((index.pkg as { apply_palettes?: unknown }).apply_palettes) {
                // a runtime that fills Color RAM at boot (Mario's Tennis): the palettes the build may recolor go in
                // now, as the kept moment has the old ones (only palettes the game never rewrites are listed)
                const ap = (index.pkg as unknown as { apply_palettes: { at: number, list?: number[], remap?: string, field?: string } }).apply_palettes;
                const mask = build.rom.length - 1;
                if (ap.field) {
                    // a runtime that sends the compiled Color RAM image (the blob directory field `field` names) only
                    // at boot (Golf, where paint on a value-0 pixel or a new color takes a palette of its own):
                    // palettes `list`, or all 256, from the build now
                    const data = (index.pkg as unknown as { data: { at: number, directory: (string | number)[] } }).data;
                    const view = new DataView(build.rom.buffer, build.rom.byteOffset, build.rom.byteLength);
                    const image = view.getUint32((data.at + 4 * data.directory.indexOf(ap.field)) & mask, true) & mask;
                    const list = ap.list ?? Array.from({ length: 256 }, (_, p) => p);
                    for (const p of list) {
                        await this.host.sim()?.writeMemory(VCU + CRAM + p * 16, build.rom.slice(image + p * 16, image + p * 16 + 16).buffer);
                    }
                } else if (ap.remap) {
                    // a runtime that writes Color RAM palette n at boot from the compiled image at group(entry n of
                    // table `remap`) * 4 + (n & 3) (Test Chamber's palette package): the same now, from the build
                    const data = (index.pkg as unknown as { data: { at: number, directory: (string | number)[] } }).data;
                    const view = new DataView(build.rom.buffer, build.rom.byteOffset, build.rom.byteLength);
                    const field = (name: string) => view.getUint32((data.at + 4 * data.directory.indexOf(name)) & mask, true) & mask;
                    const image = field('@cram'), table = field('@table:' + ap.remap);
                    const cram = new Uint8Array(256 * 16);
                    for (let p = 0; p < 256; p++) {
                        const from = image + (build.rom[table + 4 * p] * 4 + (p & 3)) * 16;
                        cram.set(build.rom.subarray(from, from + 16), p * 16);
                    }
                    await this.host.sim()?.writeMemory(VCU + CRAM, cram.buffer);
                } else {
                    const at = ap.at & mask;
                    for (const p of ap.list ?? []) {
                        await this.host.sim()?.writeMemory(VCU + CRAM + p * 16, build.rom.slice(at + p * 16, at + p * 16 + 16).buffer);
                    }
                }
                // words the runtime reads, as [address, value]. Mario's Tennis: clears what it has applied of the
                // title's and stage's cells and the boot images so it applies the build's again, and requests a fresh
                // lookup of every character
                for (const [address, value] of (ap as { words?: [number, number][] }).words ?? []) {
                    await this.host.sim()?.writeMemory(address, new Uint32Array([value]).buffer);
                }
            } else if (index.kind === 'contexts') {
                /**
                 * A context package's runtime writes a context's colors when it enters it, and the kept moment holds
                 * the old ones. With no context (and no overlay) active, it enters the shown one again, with the
                 * build's colors. The whole state header is cleared (ids, and the addresses of the active record,
                 * sweeps, scenes, overlay and watch): they point into the old build's data, which paint moves, and a
                 * stale record's exit operations would run as a DMA list of whatever lies there now (the game froze).
                 */
                await this.host.sim()?.writeMemory(COLOR_CONTEXT_STATE, new Uint8Array(0x40).buffer);
            }
        } catch (error) {
            this.buildError = error instanceof Error ? error.message : String(error);
        }
        this.changed();
    }

    // --- Exchanging the work as a package ---------------------------------------------

    exchanging = false;
    pendingImport?: { name: string, work: ColorImportedWork };
    // what Export / Import Package does now and how far it is (0..1), for the Build panel's progress bar
    exchangeProgress?: { step: string, at: number };

    // shows a step of the exchange and lets the panel draw it before the next (blocking) part runs
    protected async exchangeStep(step: string, at: number): Promise<void> {
        this.exchangeProgress = { step, at };
        this.changed();
        await new Promise<void>(resolve => {
            const done = (): void => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(done, 100);
            requestAnimationFrame(() => setTimeout(done, 0));
        });
    }

    // exports the shipped package with the user's work in it (paint, own sheets, names, backdrops: README "Paint in the
    // package") as one .vbcpkg, to swap with others or send back to the VUEPort project; it compiles to the painted ROM
    // by itself
    async exportPackage(): Promise<void> {
        const index = this.packageIndex;
        const document = this.documentState;
        const bytes = this.packageBytes;
        if (!index || !document || !bytes || this.exchanging) {
            return;
        }
        this.exchanging = true;
        try {
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepShipped', 'Reading the colorization\'s package…'), 0.05);
            const shipped = await readRawColorPackage(bytes.bytes, bytes.runtime);
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepCollect', 'Collecting your work…'), 0.25);
            const base = { patch: document.base?.patch ?? this.packageEntry()?.id ?? '', version: index.pkg.version, sha256: await sha256Hex(bytes.bytes) };
            const edited = editedColorPackage(shipped, this.compiledPaint(document), documentEdit(document, base));
            const json = new TextEncoder().encode(JSON.stringify(edited));
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepCompress', 'Compressing…'), 0.45);
            const data = await packColorPackage(json);
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepSave', 'Saving the file…'), 0.9);
            const game = String(index.pkg.game || 'Game').replace(/[\\/:*?"<>|]+/g, '-').trim();
            await this.host.exportFile(`${game}.vbcpkg`, data);
        } catch (error) {
            this.host.notifications.error(nls.localize('vueport/color/exchange/exportFailed',
                'The package could not be exported: {0}', error instanceof Error ? error.message : String(error)));
        } finally {
            this.exchanging = false;
            this.exchangeProgress = undefined;
            this.changed();
        }
    }

    // reads a package (this editor's Export Package or someone else's) for the running game: its paint and own sheets
    // go into the document, merged or replacing what is there, as the user chooses (pendingImport, resolveImport)
    async importPackage(source: Uint8Array | Blob, name: string): Promise<void> {
        const document = this.documentState;
        const shippedBytes = this.packageBytes?.bytes;
        const shippedRuntime = this.packageBytes?.runtime;
        if (!document || !shippedBytes || !this.packageIndex || this.exchanging) {
            return;
        }
        this.exchanging = true;
        this.pendingImport = undefined;
        let applying = false;
        try {
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepFile', 'Reading "{0}"…', name), 0.02);
            const bytes = source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer());
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepShipped', 'Reading the colorization\'s package…'), 0.1);
            const shipped = await readRawColorPackage(shippedBytes, shippedRuntime);
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepUnpack', 'Unpacking "{0}"…', name), 0.35);
            const imported = await readRawColorPackage(bytes);
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepCompare', 'Comparing it with the colorization\'s package…'), 0.6);
            const baseSha = (imported.edit as ColorPackageEdit | undefined)?.base?.sha256;
            const sameFile = !!baseSha && baseSha === await sha256Hex(shippedBytes);
            const work = importedColorWork(shipped, imported, sameFile);
            const { keys, sheets, backdrops, edges } = work.counts;
            if (!keys && !sheets && !backdrops && !edges) {
                this.host.notifications.info(nls.localize('vueport/color/exchange/empty', '"{0}" holds no paint and no sheets of its own.', name));
                return;
            }
            this.exchangeProgress = undefined;   // no bar while it asks
            this.changed();
            if (!work.sameBase && !await this.host.notifications.confirm({
                title: nls.localize('vueport/color/exchange/otherBaseTitle', 'Import from Another Version?'),
                message: [
                    nls.localize('vueport/color/exchange/otherBaseMessage', '"{0}" was made from another version of this colorization\'s package.', name),
                    nls.localize('vueport/color/exchange/otherBaseHint',
                        'Its paint may not fit everywhere, and paint on characters this version does not know makes the build fail.'),
                ],
                okLabel: nls.localize('vueport/color/exchange/otherBaseOk', 'Import Anyway'),
            })) {
                return;
            }
            if (documentHasWork(document)) {
                this.pendingImport = { name, work };
            } else {
                applying = true;
                await this.applyImport(work, 'replace', name);
            }
        } catch (error) {
            this.host.notifications.error(nls.localize('vueport/color/exchange/importFailed',
                'The package could not be imported: {0}', error instanceof Error ? error.message : String(error)));
        } finally {
            if (!applying) {
                this.exchanging = false;
                this.exchangeProgress = undefined;
                this.changed();
            }
        }
    }

    // merge (its paint wins per character), replace the work, or undefined to drop the import
    async resolveImport(mode: 'merge' | 'replace' | undefined): Promise<void> {
        const pending = this.pendingImport;
        this.pendingImport = undefined;
        if (pending && mode && !this.exchanging) {
            this.exchanging = true;
            try {
                await this.applyImport(pending.work, mode, pending.name);
            } catch (error) {
                this.host.notifications.error(nls.localize('vueport/color/exchange/importFailed',
                    'The package could not be imported: {0}', error instanceof Error ? error.message : String(error)));
            }
        } else {
            this.changed();
        }
    }

    // takes the imported work into the document; ends the exchange
    protected async applyImport(work: ColorImportedWork, mode: 'merge' | 'replace', name: string): Promise<void> {
        try {
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepApply', 'Taking the paint into your work…'), 0.75);
            this.mutate(document => {
                applyImportedWork(document, work, mode, nls.localize('vueport/color/exchange/layerName', 'Imported: {0}', name));
                this.mergeLayers(document);
            });
            // the panels draw the new work (project tree, sheets) before the bar goes
            await this.exchangeStep(nls.localize('vueport/color/exchange/stepShow', 'Showing the new work…'), 0.95);
        } finally {
            this.exchanging = false;
            this.exchangeProgress = undefined;
            this.changed();
        }
        this.host.notifications.info(nls.localize('vueport/color/exchange/imported',
            'Imported "{0}": {1} painted characters, {2} own sheets. Apply to the Game shows it.', name, work.counts.keys, work.counts.sheets));
    }

    // --- The file -----------------------------------------------------------

    protected pathFor(extension: string): string | undefined {
        const romPath = this.host.romPath();
        if (!romPath) {
            return undefined;
        }
        const storage = this.host.storage;
        return storage.join(storage.parent(romPath), `${storage.stem(romPath)}${extension}`);
    }

    protected folder(): string | undefined {
        return this.pathFor(COLOR_FOLDER_EXTENSION);
    }

    protected async load(): Promise<void> {
        this.flushSave();
        this.documentPath = this.pathFor(COLOR_EDIT_EXTENSION);
        this.documentState = undefined;
        this.undoStack = [];
        this.redoStack = [];
        const path = this.documentPath;
        if (!path) {
            return;
        }
        try {
            this.documentState = await this.host.storage.exists(path)
                ? parseColorEditDocument(await this.host.storage.readText(path))
                : newColorEditDocument();
        } catch (error) {
            this.host.notifications.error(nls.localize('vueport/color/documentUnreadable',
                'The color edit file could not be read: {0}', error instanceof Error ? error.message : String(error)));
        }
    }

    protected scheduleSave(): void {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DELAY_MS);
    }

    protected flushSave(): void {
        if (this.saveTimer === undefined) {
            return;
        }
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        const document = this.documentState;
        const path = this.documentPath;
        if (document && path) {
            this.host.storage.writeText(path, `${JSON.stringify(document, undefined, 2)}\n`).catch(error =>
                this.host.notifications.error(nls.localize('vueport/color/documentUnwritable',
                    'The color edit file could not be saved: {0}', error instanceof Error ? error.message : String(error))));
        }
    }

    // --- Changing the document ----------------------------------------------

    protected mutate(change: (document: ColorEditDocument) => void, coalesce?: string): void {
        const document = this.documentState;
        if (!document) {
            return;
        }
        // a run of the same change (a color dragged through a picker) is one Undo step
        const now = Date.now();
        if (!coalesce || coalesce !== this.lastChange?.kind || now - this.lastChange.at > COALESCE_MS) {
            this.undoStack.push(JSON.stringify(document));
            if (this.undoStack.length > MAX_UNDO) {
                this.undoStack.shift();
            }
        }
        this.lastChange = coalesce ? { kind: coalesce, at: now } : undefined;
        this.redoStack = [];
        change(document);
        this.afterChange();
    }

    protected afterChange(): void {
        this.scheduleSave();
        this.revision++;
        this.changed();
    }

    protected lastChange?: { kind: string, at: number };

    // bumped on every document change, for whatever has to read the machine again after one
    revision = 0;

    // Undo and Redo (Ctrl or Cmd) wherever the focus is while the editor is open
    protected readonly onKey = (event: KeyboardEvent): void => {
        const target = event.target as HTMLElement | null;
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented
            // text fields keep their own undo; checkboxes and buttons have none
            || target?.closest?.('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, [contenteditable="true"]')) {
            return;
        }
        const key = event.key.toLowerCase();
        if (key === 'z' && !event.shiftKey) {
            event.preventDefault();
            this.undo();
        } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
            event.preventDefault();
            this.redo();
        }
    };

    // a step of the view's own in Undo's history, not the document's: the sheet editor's selected area changed, so Undo
    // and Redo go through those changes in turn with the paint's
    pushViewStep(step: ColorViewStep): void {
        this.undoStack.push(step);
        if (this.undoStack.length > MAX_UNDO) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.lastChange = undefined;
        this.changed();
    }

    undo(): void {
        this.lastChange = undefined;
        const document = this.documentState;
        const previous = this.undoStack.pop();
        if (!document || previous === undefined) {
            return;
        }
        if (typeof previous !== 'string') {
            previous.undo();
            this.redoStack.push(previous);
            this.changed();
            return;
        }
        this.redoStack.push(JSON.stringify(document));
        this.documentState = JSON.parse(previous);
        this.afterChange();
    }

    redo(): void {
        this.lastChange = undefined;
        const document = this.documentState;
        const next = this.redoStack.pop();
        if (!document || next === undefined) {
            return;
        }
        if (typeof next !== 'string') {
            next.redo();
            this.undoStack.push(next);
            this.changed();
            return;
        }
        this.undoStack.push(JSON.stringify(document));
        this.documentState = JSON.parse(next);
        this.afterChange();
    }

    setTool(tool: ColorTool): void {
        this.tool = tool;
        this.changed();
    }

    // --- Picking ------------------------------------------------------------

    // everything about the color of one pixel of the picture: its palette and which entry of it, the four colors, and
    // the slot that chose the palette, where one did
    async pickAt(eye: 0 | 1, x: number, y: number, origin: VbPixelOrigin): Promise<ColorPick | undefined> {
        const sim = this.host.sim();
        if (!sim) {
            return undefined;
        }
        const pick: ColorPick = { eye, x, y, origin, colors: [] };
        if (origin.vbc !== undefined && origin.vbcSource !== 'rows') {
            await this.readPickPalette(pick, origin.vbc);
            pick.entry = await this.levelOf(sim, origin);
        }
        return pick;
    }

    protected async readPickPalette(pick: ColorPick, palette: number): Promise<void> {
        pick.palette = palette;
        pick.colors = await this.paletteColors(palette);
    }

    async selectPixel(eye: 0 | 1, x: number, y: number, origin: VbPixelOrigin): Promise<void> {
        this.pickedNothing = false;
        if (this.modelPackage && origin.kind !== 'cell' && origin.kind !== 'object' && origin.kind !== 'overplane') {
            // a model package's lines are drawn by the CPU, so the model and edge come from a logged frame's lines
            this.pick = await this.pickAt(eye, x, y, origin);
            await this.pickModelAt(eye, x, y);
            return;
        }
        this.pick = await this.pickAt(eye, x, y, origin);
        await this.readElementOf(eye, x, y, origin).catch(() => undefined);
        this.changed();
        await this.showPicked().catch(() => undefined);
    }

    // --- Models (packages of kind 'models': Red Alarm) ------------------------------------------------------------

    get modelPackage(): ColorModelPackage | undefined {
        const pkg = this.packageIndex?.pkg;
        return isModelPackage(pkg) ? pkg : undefined;
    }

    // the last pick's candidates, nearest first, and the open one (-1 when none was near)
    modelPick?: { candidates: ModelCandidate[], chosen: number };
    modelFocus?: { model: string, edges: ReadonlySet<number> };
    modelPicking = false;
    modelPickError?: string;
    protected modelEdges?: { pkg: ColorModelPackage, index: ModelEdgeIndex };
    protected probeWorker?: ProbeForkWorker;
    protected probeBase?: string;

    protected modelEntries(pkg: ColorModelPackage): ColorSheetEntry[] {
        const sheet = (id: string, name: string, folder: string): ColorSheetEntry => ({
            sheet: { id, name, folder, kind: 'figures', w: 1, h: 1, items: [] }, own: false, name, folder,
        });
        const models = nls.localize('vueport/color/model/folder', 'Models');
        const out = pkg.models.filter(model => model.kind === 'object').map(model => {
            const group = model.group ? model.group[0].toUpperCase() + model.group.slice(1) : nls.localize('vueport/color/model/otherGroup', 'Other');
            return sheet(MODEL_SHEET_PREFIX + model.edges, model.name ?? nls.localize('vueport/color/model/unnamed', 'Model {0}', model.edges), `${models}/${group}`);
        });
        const other = `${models}/${nls.localize('vueport/color/model/notModels', 'Not models')}`;
        // the classes the package has (Red Alarm's three; Zero Racers draws nothing but models)
        for (const name of MODEL_CLASSES.filter(n => (n === 'debris' ? pkg.classes?.debrisC : pkg.classes?.[n]) !== undefined)) {
            out.push(sheet(MODEL_CLASS_PREFIX + name, modelClassName(name), other));
        }
        return out;
    }

    modelOf(sheetId: string | undefined): ColorModel | undefined {
        return sheetId?.startsWith(MODEL_SHEET_PREFIX)
            ? this.modelPackage?.models.find(model => model.edges === sheetId.slice(MODEL_SHEET_PREFIX.length)) : undefined;
    }

    modelPaint(list: string): { [edge: string]: ColorModelPaint } {
        return this.documentState?.paint.models?.[list]?.edges ?? {};
    }

    classPaint(name: ColorModelClass): ColorModelPaint | undefined {
        return this.documentState?.paint.classes?.[name];
    }

    protected modelTarget(document: ColorEditDocument): ColorPaintLayer | ColorPaintLayerEntry {
        return document.layers?.find(layer => layer.id === this.activePaintLayer()) ?? document.paint;
    }

    // null goes back to the package's paint
    paintModelEdges(list: string, edges: readonly number[], paint: ColorModelPaint | null): void {
        if (!edges.length || !this.canPaint()) {
            return;
        }
        const now = this.documentState && this.modelTarget(this.documentState).models?.[list]?.edges;
        if (edges.every(edge => JSON.stringify(now?.[edge] ?? null) === JSON.stringify(paint))) {
            return;
        }
        this.mutate(document => {
            const target = this.modelTarget(document);
            const model = (target.models ??= {})[list] ??= { edges: {} };
            for (const edge of edges) {
                if (paint === null) {
                    delete model.edges[edge];
                } else {
                    model.edges[edge] = paint;
                }
            }
            if (!Object.keys(model.edges).length) {
                delete target.models![list];
            }
            if (!Object.keys(target.models!).length) {
                delete target.models;
            }
            this.mergeLayers(document);
        });
    }

    // null goes back to the package's paint; a run of changes is one Undo step
    paintModelClass(name: ColorModelClass, paint: ColorModelPaint | null): void {
        if (!this.canPaint()) {
            return;
        }
        this.mutate(document => {
            const target = this.modelTarget(document);
            if (paint === null) {
                delete target.classes?.[name];
            } else {
                (target.classes ??= {})[name] = paint;
            }
            if (target.classes && !Object.keys(target.classes).length) {
                delete target.classes;
            }
            this.mergeLayers(document);
        }, `class:${name}`);
    }

    protected modelChanged(sheetId: string): boolean {
        if (sheetId.startsWith(MODEL_CLASS_PREFIX)) {
            return this.classPaint(sheetId.slice(MODEL_CLASS_PREFIX.length) as ColorModelClass) !== undefined;
        }
        return Object.keys(this.modelPaint(sheetId.slice(MODEL_SHEET_PREFIX.length))).length > 0;
    }

    protected resetModel(sheetId: string): void {
        const list = sheetId.startsWith(MODEL_SHEET_PREFIX) ? sheetId.slice(MODEL_SHEET_PREFIX.length) : undefined;
        const name = sheetId.startsWith(MODEL_CLASS_PREFIX) ? sheetId.slice(MODEL_CLASS_PREFIX.length) : undefined;
        this.mutate(document => {
            for (const target of [...document.layers ?? [], document.paint] as (ColorPaintLayer | ColorPaintLayerEntry)[]) {
                if (list) {
                    delete target.models?.[list];
                }
                if (name) {
                    delete target.classes?.[name];
                }
            }
            this.mergeLayers(document);
        });
    }

    modelPartName(list: string, part: number, suggested: string): string {
        return this.documentState?.modelParts?.[list]?.[part] ?? suggested;
    }

    renameModelPart(list: string, part: number, name: string, suggested: string): void {
        const wanted = name.trim();
        if (wanted === this.modelPartName(list, part, suggested)) {
            return;
        }
        this.mutate(document => {
            const names = (document.modelParts ??= {})[list] ??= {};
            if (wanted && wanted !== suggested) {
                names[part] = wanted;
            } else {
                delete names[part];
            }
            if (!Object.keys(names).length) {
                delete document.modelParts![list];
            }
            if (!Object.keys(document.modelParts!).length) {
                delete document.modelParts;
            }
        });
    }

    // the ramp (far, mid, near) a palette shows, from the unpainted build, else the running ROM
    modelPaletteRamp(palette: number): string[] | undefined {
        const pkg = this.modelPackage;
        const rom = this.base?.rom ?? this.host.runningRom();
        return pkg && rom ? paletteColors(pkg, rom, palette).slice(1) : undefined;
    }

    edgeRamp(model: ColorModel, edge: number): string[] {
        const paint = this.modelPaint(model.edges)[edge];
        return paint !== undefined ? rampOf(paint) : this.modelPaletteRamp(model.palettes?.[edge] ?? model.defaults?.[0] ?? 0) ?? ['#404040', '#808080', '#c0c0c0'];
    }

    classRamp(name: ColorModelClass): string[] {
        const paint = this.classPaint(name);
        if (paint !== undefined) {
            return rampOf(paint);
        }
        const classes = this.modelPackage?.classes;
        const palette = name === 'fixed' ? classes?.fixed : name === 'scenery' ? classes?.scenery : classes?.debrisC?.[2];
        return this.modelPaletteRamp(palette ?? 0) ?? ['#404040', '#808080', '#c0c0c0'];
    }

    // palettes the paint takes out of those the package leaves free (Color RAM is shared by the whole game)
    modelPalettes(): { used: number, free: number } {
        const paint = this.documentState?.paint;
        return { used: paint ? rampsUsed({ models: paint.models, classes: paint.classes }, supportsDepth4(this.modelPackage)) : 0, free: this.modelPackage?.free_palettes.length ?? 0 };
    }

    // a pick on a model package's screen: the next frame's lines, logged in a fork of this moment (the probe's worker),
    // give the models and edges near the point; the nearest opens, the others are offered
    async pickModelAt(eye: 0 | 1, x: number, y: number): Promise<void> {
        const pkg = this.modelPackage;
        const sim = this.host.sim();
        const rom = this.host.runningRom();
        if (!pkg || !sim || !rom || !this.host.probeWorkerUrl || !this.host.wasmUrl || this.modelPicking) {
            return;
        }
        this.modelPicking = true;
        this.modelPickError = undefined;
        this.changed();
        try {
            const worker = this.probeWorker ??= new ProbeForkWorker(new Worker(this.host.probeWorkerUrl));
            const key = `${this.host.romId()}:${rom.length}:${this.packageBytes?.key}:${this.host.colorizations().find(c => c.enabled)?.id}`;
            if (this.probeBase !== key) {
                await worker.request({ op: 'base', key, rom: rom.slice().buffer, vbc: true, esSound: false, wasmUrl: this.host.wasmUrl });
                this.probeBase = key;
            }
            const info = await sim.cartRamInfo();
            const moment = {
                state: await sim.saveState(),
                sram: info.size > 0 ? await sim.getCartRam(info.used) : new ArrayBuffer(0),
                sramWindow: info.size > 0 ? info.size : 0x4000,
            };
            await worker.request({ op: 'drop', name: 'colorpick' }).catch(() => undefined);
            await worker.request({ op: 'fork', name: 'colorpick', moment });
            const cli = (args: string[]): Promise<ProbeCliAnswer> =>
                worker.request<ProbeCliAnswer>({ op: 'cli', args: [args[0], '--fork', 'colorpick', ...args.slice(1)], inputs: {}, help: '', app: 'VUEPort' });
            // from the start of the game's next frame to the start of the one after: every line of one frame
            const start = parseInt(pkg.probe.frame_start, 16);
            const watch = ['watch', '--exec', pkg.probe.line_routine, '--capture', pkg.probe.capture?.join(',') ?? 'r6,r7,r8,r9,r16,r17,r30,r31', '--limit', '10000', '--list', '--json'];
            const ran = await cli(['run', '--until', `0x${(start + 4).toString(16)}`, '--frames', '30', '--json']);
            const framed = (JSON.parse(ran.text) as { run?: { stop?: { reason?: string } } }).run?.stop?.reason === 'until';
            const answer = await cli(framed ? [...watch, '--until', pkg.probe.frame_start, '--frames', '30'] : [...watch, '--frames', '8']);
            await worker.request({ op: 'drop', name: 'colorpick' }).catch(() => undefined);
            const hits = (JSON.parse(answer.text) as { watches: { hits: ModelLineHit[] }[] }).watches[0]?.hits ?? [];
            const edges = this.modelEdges?.pkg === pkg ? this.modelEdges.index : new ModelEdgeIndex(pkg, this.packageIndex!.original);
            this.modelEdges = { pkg, index: edges };
            const candidates = pickLines(modelLines(pkg, edges, hits), pkg, eye, x, y);
            this.modelPick = { candidates, chosen: candidates.length ? 0 : -1 };
            if (candidates.length) {
                this.openModelCandidate(0);
            } else {
                this.modelFocus = undefined;
                this.changed();
            }
        } catch (error) {
            this.modelPickError = error instanceof Error ? error.message : String(error);
        } finally {
            this.modelPicking = false;
            this.changed();
        }
    }

    openModelCandidate(chosen: number): void {
        const candidate = this.modelPick?.candidates[chosen];
        if (!candidate) {
            return;
        }
        this.modelPick = { ...this.modelPick!, chosen };
        if (candidate.modelClass) {
            this.modelFocus = undefined;
            this.openSheet(MODEL_CLASS_PREFIX + candidate.modelClass);
        } else if (candidate.model) {
            this.modelFocus = { model: candidate.model, edges: new Set(candidate.edge === undefined ? [] : [candidate.edge]) };
            this.openSheet(MODEL_SHEET_PREFIX + candidate.model);
        }
    }

    // --- The element in view ----------------------------------------------------

    element?: ColorElement;
    tile?: ColorTile;

    protected async readElementOf(eye: 0 | 1, x: number, y: number, origin: VbPixelOrigin): Promise<void> {
        const sim = this.host.sim();
        if (!sim || origin.world === undefined || (origin.kind !== 'cell' && origin.kind !== 'overplane' && origin.kind !== 'object')) {
            this.element = undefined;
            this.tile = undefined;
            return;
        }
        const element = await this.readElement(sim, eye, origin.world);
        this.element = element;
        const at = element ? (y - element.box.y) * element.box.width + (x - element.box.x) : -1;
        this.tile = element && at >= 0 && at < element.tileAt.length ? element.tiles[element.tileAt[at]] : undefined;
    }

    protected async readElement(sim: Sim, eye: 0 | 1, world: number): Promise<ColorElement | undefined> {
        const origins = await sim.readPixelOrigins();
        if (!origins) {
            return undefined;
        }
        const pixels = VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT;
        const base = eye * pixels;
        const ours = (i: number): boolean => {
            const what = origins[(base + i) * 2];
            const kind = what & 7;
            return kind >= 2 && kind <= 4 && (what >>> 3 & 31) === world;
        };
        let left = VB_SCREEN_WIDTH;
        let top = VB_SCREEN_HEIGHT;
        let right = -1;
        let bottom = -1;
        for (let i = 0; i < pixels; i++) {
            if (ours(i)) {
                const x = i % VB_SCREEN_WIDTH;
                const y = Math.floor(i / VB_SCREEN_WIDTH);
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
        if (right < 0) {
            return undefined;
        }
        const box = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
        const size = box.width * box.height;
        const element: ColorElement = {
            eye, world, kind: 'cells', segments: [], box,
            tileAt: new Int32Array(size).fill(-1), what: new Uint32Array(size), where: new Uint32Array(size), tiles: [],
        };
        const byKey = new Map<number, number>();
        const segments = new Set<number>();
        for (let row = 0; row < box.height; row++) {
            for (let column = 0; column < box.width; column++) {
                const i = (box.y + row) * VB_SCREEN_WIDTH + box.x + column;
                if (!ours(i)) {
                    continue;
                }
                const at = row * box.width + column;
                const what = origins[(base + i) * 2];
                const where = origins[(base + i) * 2 + 1];
                element.what[at] = what;
                element.where[at] = where;
                const object = (what & 7) === 4;
                element.kind = object ? 'objects' : 'cells';
                const key = object ? 0x10000 | (where & 0x3ff) : where & 0xffff;
                let tile = byKey.get(key);
                if (tile === undefined) {
                    tile = element.tiles.length;
                    byKey.set(key, tile);
                    const cell = where & 0xffff;
                    if (!object) {
                        segments.add(cell >>> 12);
                    }
                    element.tiles.push({
                        index: tile,
                        ...(object
                            ? { object: where & 0x3ff }
                            : { cell: { segment: cell >>> 12, x: cell & 63, y: cell >>> 6 & 63, index: cell } }),
                        character: what >>> 8 & 0xfff,
                        selector: what >>> 30,
                        pixel: at,
                        offset: 0,
                    });
                }
                element.tileAt[at] = tile;
            }
        }
        element.segments = [...segments].sort((a, b) => a - b);
        // what the world adds to the palettes (WCEN): for a pixel the placement's own palette drew, the palette drawn
        // minus the one named
        const state = await readColorState(sim);
        for (let at = 0; at < size; at++) {
            const tile = element.tiles[element.tileAt[at]];
            const where = element.where[at];
            if (tile && where & 0x8000000 && where & 0x1000000 && (where >>> 25 & 3) !== 3) {
                const named = namedPalette(state, tile.object !== undefined, tile.object ?? tile.cell!.index, tile.character, tile.selector);
                tile.offset = ((where >>> 16 & 0xff) - named) & 0xff;
            }
        }
        return element;
    }

    // Color RAM entry a pixel's value reaches through GPLT or JPLT
    protected async levelOf(sim: Sim, origin: VbPixelOrigin): Promise<number | undefined> {
        if (origin.kind === 'backdrop') {
            return origin.value;
        }
        const register = await this.paletteRegister(sim, origin);
        return register === undefined ? undefined : register >> (origin.value * 2) & 3;
    }

    protected async paletteRegister(sim: Sim, origin: VbPixelOrigin): Promise<number | undefined> {
        const palette = origin.palette;
        if (!palette) {
            return undefined;
        }
        const index = (palette.startsWith('JPLT') ? 4 : 0) + Number(palette.slice(4));
        return new Uint8Array(await sim.readMemory(VIP_PALETTES + index * 2, 1))[0];
    }

    async paletteColors(palette: number): Promise<string[]> {
        const sim = this.host.sim();
        if (!sim) {
            return [];
        }
        const cram = new Uint8Array(await sim.readMemory(VCU + CRAM + palette * 16, 16));
        return [0, 1, 2, 3].map(entry => formatHexColor([...cram.subarray(entry * 4, entry * 4 + 3)]));
    }

    // --- Colorizations and files ----------------------------------------------

    get colorizations(): ColorEditorColorization[] {
        return this.host.colorizations();
    }

    useColorization(id: string): void {
        this.host.useColorization(id);
    }

    get colorizationOn(): boolean {
        return this.host.colorizations().some(colorization => colorization.enabled);
    }

    // the paint stays beside the ROM, so switching back on (the block's buttons, or the Patches panel) finds it again
    async switchOffColorization(): Promise<void> {
        const agreed = await this.host.notifications.confirm({
            title: nls.localize('vueport/color/switchOff/title', 'Disable VB Color?'),
            message: [
                nls.localize('vueport/color/switchOff/message',
                    'This game runs without colors from now on. Your paint stays, and comes back when you switch the colorization on again.'),
                RESTART_CONFIRM(),
            ],
            okLabel: nls.localize('vueport/patches/disableAndRestart', 'Disable and Restart'),
        });
        if (!agreed) {
            return;
        }
        this.flushSave();
        this.host.switchOffColorization();
    }

    async exportFile(suffix: string, data: Uint8Array): Promise<void> {
        const romPath = this.host.romPath();
        if (!romPath) {
            return;
        }
        await this.host.exportFile(`${this.host.storage.stem(romPath)}${suffix}`, data);
    }

    dispose(): void {
        this.flushSave();
        this.compiler.dispose();
        this.onDidChangeEmitter.dispose();
    }
}

function fileSheet(document: ColorEditDocument, entry: ColorSheetEntry, folder: string): void {
    if (entry.own) {
        const sheet = document.sheets?.find(s => s.id === entry.sheet.id);
        if (sheet) {
            sheet.folder = folder;
        }
    } else {
        const place = (document.places ??= {})[entry.sheet.id] ??= {};
        place.folder = folder === entry.sheet.folder ? undefined : folder;
    }
}

// drops what holds nothing, so an untouched project writes as little as a new one
function cleanDocument(document: ColorEditDocument): void {
    for (const [id, place] of Object.entries(document.places ?? {})) {
        if (!place.name) {
            delete place.name;
        }
        if (place.folder === undefined) {
            delete place.folder;
        }
        if (!Object.keys(place).length) {
            delete document.places![id];
        }
    }
    const empty = (value: unknown): boolean => value === undefined
        || (Array.isArray(value) ? !value.length : typeof value === 'object' && value !== null && !Object.keys(value).length);
    for (const field of ['places', 'sheets', 'folders', 'backdrops', 'depths'] as const) {
        if (empty(document[field])) {
            delete document[field];
        }
    }
}
