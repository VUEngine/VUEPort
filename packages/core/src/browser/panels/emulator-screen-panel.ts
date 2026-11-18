import { nls } from '../../common/emulator-nls';
import { VueportWidget } from '../emulator-widget-base';
import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import { Emitter, Event } from '../../common/emulator-events';
import {
    DisplayMode,
    DisplayOutput,
    eyesSwapped,
    isInterleavedLayout,
    VbEyes,
    VbPalette,
    VbStereoLayout,
    VB_DEFAULT_DISPLAY_MODE,
    VB_LEVEL_STOPS,
    VB_SCREEN_HEIGHT,
    VB_SCREEN_WIDTH,
} from '../../common/vb-constants';
import { EmulatorPanelType } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { EmulatorScale } from '../emulator-types';
import { composeAnaglyph } from '../../worker/vb-anaglyph';
import { onDidChangeScreenOrigin, screenOrigin } from '../screen-origin';
import { StereoStill, measureStereoStill, refocusStereoStill } from '../stereo-still';

// what is drawn around the picture, `undefined` leaves the panel plain. `intensity` 0-1 is the halo's opacity (see
// AMBIENT_INTENSITY_SCALE)
export type EmulatorDecorationSpec =
    | { readonly kind: 'black' } // a real VB's backdrop
    | { readonly kind: 'ambient'; readonly color: string; readonly intensity: number } // blurred halo in one color
    | { readonly kind: 'immersion'; readonly intensity: number }; // halo from the picture via ScreenPanel.pushBackdrop

// in the VB's screen space
export interface VesScreenRect {
    x: number;
    y: number;
    width: number;
    height: number;
    parallax: number; // left eye that far left of `x`, right eye right, like the VIP reads a world's `gp`
}

// must match the Worlds panel's extents outline (`.emulator-vip-canvas-extents` in CSS). Green, as nothing on the red
// VB display can be that color
const HIGHLIGHT_COLOR = 'rgb(0, 255, 0)';
const HIGHLIGHT_FILL = 'rgba(0, 255, 0, 0.15)';
const HIGHLIGHT_LINE_WIDTH = 1; // in machine pixels, so it scales with the picture
const HIGHLIGHT_DASH = [3, 3];

// channel-wise blend of two packed 0xRRGGBB colors
function lerpColor(from: number, to: number, t: number): number {
    const r = Math.round(((from >> 16) & 0xff) + (((to >> 16) & 0xff) - ((from >> 16) & 0xff)) * t);
    const g = Math.round(((from >> 8) & 0xff) + (((to >> 8) & 0xff) - ((from >> 8) & 0xff)) * t);
    const b = Math.round((from & 0xff) + ((to & 0xff) - (from & 0xff)) * t);
    return (r << 16) | (g << 8) | b;
}

// same piecewise interpolation as the renderer's `shade()`, entries anchored at VB_LEVEL_STOPS and flat above
// the last one, so the halo agrees with the picture
function shade(palette: VbPalette, brightness: number): number {
    const [s0, s1, s2, s3] = VB_LEVEL_STOPS;
    if (brightness <= s1) {
        return lerpColor(palette[0], palette[1], s1 > s0 ? brightness / s1 : 0);
    }
    if (brightness <= s2) {
        return lerpColor(palette[1], palette[2], (brightness - s1) / (s2 - s1));
    }
    return lerpColor(palette[2], palette[3], Math.min((brightness - s2) / (s3 - s2), 1));
}

// the neutral gray Anaglyph filters, the renderer's stand-in for the palette in that mode
function gray(brightness: number): number {
    return brightness * 0x010101;
}

// the picture is averaged into `COLUMNS x ROWS` cells and only the border cells are used, one lamp each, like
// the lamps of an Ambilight. The light layout is `HALO_FIELD_*`
export const BACKDROP_COLUMNS = 48;
export const BACKDROP_ROWS = 30;

/**
 * The light field the halo is drawn from: every point sums every border lamp's light, falling off with distance, so the
 * halo dims, fans out and rounds the corners. Independent of the lamp grid, so a finer edge costs nothing; it only
 * needs to be fine enough for HALO_SIGMA.
 */
const HALO_FIELD_WIDTH = 48;
const HALO_FIELD_HEIGHT = 38;
const HALO_FIELD_PAD = 12; // makes the halo box 1.75x the picture across and 2.2x down
// the picture's own footprint inside the field: 32 x 20
const HALO_PICTURE_WIDTH = HALO_FIELD_WIDTH - HALO_FIELD_PAD * 2;
const HALO_PICTURE_HEIGHT = HALO_FIELD_HEIGHT - HALO_FIELD_PAD * 2;
// a lamp's pool of light in field units (an eighth of the picture width)
const HALO_SIGMA = 4;
const HALO_SIGMA2 = HALO_SIGMA * HALO_SIGMA;

// `ambient` is a flat full-strength fill, `immersion` falls off from the border, so ambient reads far
// stronger at the same setting. Halving it lets one slider serve both
const AMBIENT_INTENSITY_SCALE = 0.5;

// see `ScreenPanel.watchPlacement`
const PLACEMENT_WATCH_MS = 250;

/**
 * Reduces an eye-packed frame to one brightness per BACKDROP_COLUMNS x BACKDROP_ROWS cell, per eye. Not a mean, which
 * mostly-black VB frames drag down: each pixel is weighted by its light (`sum of b squared / sum of b`), so empty space
 * neither dims nor brightens a cell. A few samples per cell are enough, as a wide kernel smooths the result; frames the
 * worker already reduced come out as themselves.
 */
function averageEyes(source: Uint8ClampedArray, width: number, height: number): {
    left: Float64Array, right: Float64Array,
} {
    const cells = BACKDROP_COLUMNS * BACKDROP_ROWS;
    const leftSum = new Float64Array(cells);
    const leftLight = new Float64Array(cells);
    const rightSum = new Float64Array(cells);
    const rightLight = new Float64Array(cells);
    // about four samples across a cell; rounded rather than floored so narrow cells still step
    const step = Math.max(1, Math.min(4, Math.round(
        Math.min(width / BACKDROP_COLUMNS, height / BACKDROP_ROWS) / 4)));

    for (let y = 0; y < height; y += step) {
        const row = Math.min(BACKDROP_ROWS - 1, Math.floor((y * BACKDROP_ROWS) / height));
        for (let x = 0; x < width; x += step) {
            const cell = row * BACKDROP_COLUMNS
                + Math.min(BACKDROP_COLUMNS - 1, Math.floor((x * BACKDROP_COLUMNS) / width));
            const at = (y * width + x) * 4;
            const l = source[at];
            const r = source[at + 1];
            leftSum[cell] += l;
            leftLight[cell] += l * l;
            rightSum[cell] += r;
            rightLight[cell] += r * r;
        }
    }

    const left = new Float64Array(cells);
    const right = new Float64Array(cells);
    for (let cell = 0; cell < cells; cell++) {
        left[cell] = leftSum[cell] > 0 ? leftLight[cell] / leftSum[cell] : 0;
        right[cell] = rightSum[cell] > 0 ? rightLight[cell] / rightSum[cell] : 0;
    }
    return { left, right };
}

// fixed by the constants above, so computed once
interface HaloLamps {
    // field coordinates, one entry per border cell of the grid
    x: Float64Array;
    y: Float64Array;
    cell: Int32Array;
    peak: number; // the field is divided by it, so an all-white border is full brightness at the most lit point
}
let haloLamps: HaloLamps | undefined;

// the picture's own edge counts as lit
function isHiddenByPicture(fx: number, fy: number): boolean {
    return fx > HALO_FIELD_PAD
        && fx < HALO_FIELD_PAD + HALO_PICTURE_WIDTH - 1
        && fy > HALO_FIELD_PAD
        && fy < HALO_FIELD_PAD + HALO_PICTURE_HEIGHT - 1;
}

function layoutHaloLamps(): HaloLamps {
    const x: number[] = [];
    const y: number[] = [];
    const cell: number[] = [];
    const add = (fx: number, fy: number, at: number) => {
        x.push(fx);
        y.push(fy);
        cell.push(at);
    };
    const spanX = HALO_PICTURE_WIDTH / BACKDROP_COLUMNS;
    const spanY = HALO_PICTURE_HEIGHT / BACKDROP_ROWS;
    for (let column = 0; column < BACKDROP_COLUMNS; column++) {
        const fx = HALO_FIELD_PAD + (column + 0.5) * spanX;
        add(fx, HALO_FIELD_PAD + 0.5, column);
        add(fx, HALO_FIELD_PAD + HALO_PICTURE_HEIGHT - 0.5, (BACKDROP_ROWS - 1) * BACKDROP_COLUMNS + column);
    }
    // the corners already went in with the top and bottom rows
    for (let row = 1; row < BACKDROP_ROWS - 1; row++) {
        const fy = HALO_FIELD_PAD + (row + 0.5) * spanY;
        add(HALO_FIELD_PAD + 0.5, fy, row * BACKDROP_COLUMNS);
        add(HALO_FIELD_PAD + HALO_PICTURE_WIDTH - 0.5, fy, row * BACKDROP_COLUMNS + BACKDROP_COLUMNS - 1);
    }

    const lamps: HaloLamps = {
        x: Float64Array.from(x),
        y: Float64Array.from(y),
        cell: Int32Array.from(cell),
        peak: 1,
    };
    // the most light a shown point can get, geometry only. Over the lit points alone: the walled-in middle takes
    // far more light, and normalizing by it would leave the halo too dim
    let peak = 0;
    for (let fy = 0; fy < HALO_FIELD_HEIGHT; fy++) {
        for (let fx = 0; fx < HALO_FIELD_WIDTH; fx++) {
            if (isHiddenByPicture(fx, fy)) {
                continue;
            }
            let weight = 0;
            for (let lamp = 0; lamp < lamps.x.length; lamp++) {
                const dx = fx + 0.5 - lamps.x[lamp];
                const dy = fy + 0.5 - lamps.y[lamp];
                weight += 1 / (1 + (dx * dx + dy * dy) / HALO_SIGMA2);
            }
            peak = Math.max(peak, weight);
        }
    }
    lamps.peak = peak;
    return lamps;
}

function packedRgb(source: Uint8ClampedArray, at: number): number {
    return (source[at] << 16) | (source[at + 1] << 8) | source[at + 2];
}

// an already-reduced VBC grid holds two RGBA quads per cell, left and right eye
function colorEyes(source: Uint8ClampedArray, width: number, height: number): {
    left: Uint32Array, right: Uint32Array,
} {
    const cells = width * height;
    const left = new Uint32Array(cells);
    const right = new Uint32Array(cells);
    for (let cell = 0; cell < cells; cell++) {
        const at = cell * 8;
        left[cell] = packedRgb(source, at);
        right[cell] = packedRgb(source, at + 4);
    }
    return { left, right };
}

// the emulator picture as a dockable panel. The canvas is built imperatively, as transferControlToOffscreen
// can only happen once per element and React might recreate it
export class ScreenPanel extends VueportWidget {

    readonly kind = EmulatorPanelType.SCREEN;

    protected readonly frame: HTMLDivElement;
    // clips the picture to rounded corners: `border-radius` on the canvas fails once it gets its own compositing
    // layer, `overflow: hidden` on a wrapper does not. The overlay canvas is inside too, the halo outside
    protected readonly picture: HTMLDivElement;

    protected readonly prompt: HTMLDivElement;
    protected canvasElement?: HTMLCanvasElement;
    // a still run through the current palette while no game is running, so a palette can be chosen
    protected placeholderCanvas?: HTMLCanvasElement;
    // one brightness byte per pixel at 384x224 per eye (the same plane twice for a one-eye screenshot), so stereo
    // layouts can arrange them like the live renderer
    protected placeholderLeft?: Uint8ClampedArray;
    protected placeholderRight?: Uint8ClampedArray;
    protected placeholderShown = false;
    // in percent, see `setStereoDepth`
    protected stereoDepth = 100;
    // parallax measured the first time a depth other than 100 needs it
    protected placeholderStill?: StereoStill;
    protected placeholderAtDepth?: { depth: number, left: Uint8ClampedArray, right: Uint8ClampedArray };
    // the last live `immersion` frame, to repaint the halo when the still stops standing in; live frames stop coming
    // while paused
    protected liveBackdrop?: {
        pixels: Uint8ClampedArray, width: number, height: number, colorMode: boolean,
    };
    // low resolution and blurred wide by CSS
    protected readonly glow: HTMLCanvasElement;
    protected decoration?: EmulatorDecorationSpec;
    // for marking things on the picture, as the worker owns the transferred frame canvas
    protected overlayCanvas?: HTMLCanvasElement;
    protected highlights: VesScreenRect[] = [];
    // for the screen inspector, see `setPixelLayer`
    protected pixelLayer?: { left?: ImageData, right?: ImageData };
    protected readonly layerCanvases: HTMLCanvasElement[] = [];
    protected pictureBox = { width: 0, height: 0 };
    // halo box size relative to the picture: `immersion` needs room for its extruded edge ring, `ambient` only a little
    // spill before the blur
    protected glowSpread = { x: 1, y: 1 };

    protected displayMode: DisplayMode = VB_DEFAULT_DISPLAY_MODE;
    protected scale = 'auto';

    protected output: DisplayOutput | undefined;
    // see `watchPlacement`
    protected placementWatch: ReturnType<typeof setInterval> | undefined;
    protected placementSeen = '';
    // see `screen-origin.ts`
    protected readonly originWatch = onDidChangeScreenOrigin(() => {
        if (isInterleavedLayout(this.displayMode.layout)) {
            this.relayout();
        }
    });
    protected readonly onDidChangeOutputEmitter = new Emitter<DisplayOutput | undefined>();
    // where an interleaved picture is really shown, so the machine draws it at that size; undefined in other modes
    readonly onDidChangeOutput: Event<DisplayOutput | undefined> = this.onDidChangeOutputEmitter.event;

    get displayOutput(): DisplayOutput | undefined {
        return this.output;
    }

    // see `lendPicture`
    protected borrower?: HTMLElement;
    // the borrower is not a Lumino widget, so this stands in for resize messages
    protected borrowerResize?: ResizeObserver;
    protected borrowerFit = false;
    // keeps decoration and scale instead of a plain fitted picture, as the Display preview wants
    protected borrowerDecorate = false;

    constructor(instanceId: string) {
        super();
        this.id = `vp-panel:${instanceId}:${EmulatorPanelType.SCREEN}`;
        this.title.label = nls.localize('vueport/debug/panels/screen/title', 'Screen');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.SCREEN);
        this.title.closable = false;
        this.addClass('vp-screen-panel');

        this.frame = document.createElement('div');
        this.frame.className = 'vp-screen-frame';
        this.node.appendChild(this.frame);

        // first child, behind the picture and the overlay, which also get an explicit z-index in CSS
        this.glow = document.createElement('canvas');
        this.glow.className = 'vp-screen-glow';
        this.frame.appendChild(this.glow);

        this.picture = document.createElement('div');
        this.picture.className = 'vp-screen-picture';
        this.frame.appendChild(this.picture);

        this.placeholderCanvas = document.createElement('canvas');
        this.placeholderCanvas.className = 'vp-screen-placeholder';
        this.placeholderCanvas.width = VB_SCREEN_WIDTH;
        this.placeholderCanvas.height = VB_SCREEN_HEIGHT;
        this.placeholderCanvas.hidden = true;
        this.picture.appendChild(this.placeholderCanvas);

        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.className = 'vp-screen-overlay';
        this.picture.appendChild(this.overlayCanvas);

        // last, so it covers both canvases
        this.prompt = document.createElement('div');
        this.prompt.className = 'vp-screen-prompt';
        this.prompt.hidden = true;
        this.picture.appendChild(this.prompt);

        this.badges = document.createElement('div');
        this.badges.className = 'vp-screen-badges';
        this.node.appendChild(this.badges);

        this.stateBadges = document.createElement('div');
        this.stateBadges.className = 'vp-screen-state-badges';
        this.node.appendChild(this.stateBadges);

        this.strip = document.createElement('div');
        this.strip.className = 'vp-strip-layer';
        this.node.appendChild(this.strip);

        this.tools = document.createElement('div');
        this.tools.className = 'vp-screen-tools';
        this.node.appendChild(this.tools);

        this.colorTools = document.createElement('div');
        this.colorTools.className = 'vp-screen-tools';
        this.node.appendChild(this.colorTools);
    }

    // for the debugger's tools over the picture (screen inspector); hidden by the dock in Play mode
    readonly tools: HTMLDivElement;

    // the same for Color mode's tools, see `ColorScreenTools`
    readonly colorTools: HTMLDivElement;

    // for the chrome's badges, rendered by the emulator's owner through a React portal, as this panel is imperative DOM
    readonly badges: HTMLDivElement;

    // the machine's state (paused, muted, fast-forwarding) in the opposite corner, while `badges` shows the session;
    // only used when the chrome hides itself, otherwise its lit buttons say this already
    readonly stateBadges: HTMLDivElement;

    // the floating transport (see EmulatorControlStrip), placed here so it follows the picture and does not float over
    // another panel in Debug mode
    readonly strip: HTMLDivElement;

    // the previous canvas was handed to a worker that is going away, so it is replaced rather than reused
    takeCanvas(): HTMLCanvasElement {
        this.canvasElement?.remove();
        this.liveBackdrop = undefined;
        const canvas = document.createElement('canvas');
        canvas.width = this.displayMode.width;
        canvas.height = this.displayMode.height;
        canvas.hidden = this.placeholderShown;
        this.picture.insertBefore(canvas, this.overlayCanvas ?? null);
        this.canvasElement = canvas;
        this.relayout();
        return canvas;
    }

    /**
     * Shows the running picture elsewhere (the Display settings) until it is given back. The canvas cannot be copied,
     * as the worker owns its presentation, so the frame moves whole with its overlay and the panel is left empty. `fit`
     * (default true) fills the borrower instead of using the dock's whole-number scale; `decorate` (default false)
     * keeps decoration and halo. The Display preview passes `{ fit: false, decorate: true }`.
     */
    lendPicture(host: HTMLElement, opts: { fit?: boolean, decorate?: boolean } = {}): void {
        const fit = opts.fit ?? true;
        const decorate = opts.decorate ?? false;
        if (this.borrower === host && this.borrowerFit === fit && this.borrowerDecorate === decorate) {
            return;
        }
        this.returnPicture();
        this.borrower = host;
        this.borrowerFit = fit;
        this.borrowerDecorate = decorate;
        host.appendChild(this.frame);
        this.applyInsets();
        // the debug highlights mark the game in the panel, not the preview, so they stay behind
        if (this.overlayCanvas) {
            this.overlayCanvas.hidden = true;
        }
        this.borrowerResize = new ResizeObserver(() => this.relayout());
        this.borrowerResize.observe(host);
        this.applyDecoration();
        // `applyDecoration` leaves the immersion halo blank for the next frame, and a paused game sends none
        this.repaintBackdrop();
        this.relayout();
    }

    // in machine pixels, for a borrower that sizes its box itself (see EmulatorScreenPreview); stereo layouts are wider
    // or taller
    get pictureSize(): { width: number, height: number } {
        return { width: this.displayMode.width, height: this.displayMode.height };
    }

    returnPicture(): void {
        if (!this.borrower) {
            return;
        }
        this.borrowerResize?.disconnect();
        this.borrowerResize = undefined;
        this.borrower = undefined;
        this.borrowerFit = false;
        this.borrowerDecorate = false;
        // before the badges, which stayed behind and belong over the picture
        this.node.insertBefore(this.frame, this.badges);
        this.applyInsets();
        if (this.overlayCanvas) {
            this.overlayCanvas.hidden = false;
        }
        this.applyDecoration();
        this.repaintBackdrop();
        this.relayout();
    }

    setDisplayMode(mode: DisplayMode): void {
        this.displayMode = mode;
        this.renderPlaceholder();
        this.relayout();
    }

    // in VB screen space, as only this panel knows how the mode arranges the eyes
    setHighlights(rects: VesScreenRect[]): void {
        this.highlights = rects;
        this.drawHighlights();
    }

    // one picture per eye in machine pixels (384x224), under the highlights, transparent where it says nothing
    setPixelLayer(layer: { left?: ImageData, right?: ImageData } | undefined): void {
        this.pixelLayer = layer;
        this.drawHighlights();
    }

    get pictureElement(): HTMLElement {
        return this.picture;
    }

    // inverse of `eyeSlots`; where both eyes share pixels, the one the mode shows (left for both)
    pointAt(clientX: number, clientY: number): { eye: 0 | 1, x: number, y: number } | undefined {
        const overlay = this.overlayCanvas;
        if (!overlay || overlay.hidden || this.placeholderShown) {
            return undefined;
        }
        const box = overlay.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) {
            return undefined;
        }
        const cx = (clientX - box.left) * overlay.width / box.width;
        const cy = (clientY - box.top) * overlay.height / box.height;
        for (const slot of this.eyeSlots()) {
            if (cx >= slot.x && cx < slot.x + slot.width && cy >= slot.y && cy < slot.y + slot.height) {
                return {
                    eye: slot.eye,
                    x: Math.min(VB_SCREEN_WIDTH - 1, Math.floor((cx - slot.x) * VB_SCREEN_WIDTH / slot.width)),
                    y: Math.min(VB_SCREEN_HEIGHT - 1, Math.floor((cy - slot.y) * VB_SCREEN_HEIGHT / slot.height)),
                };
            }
        }
        return undefined;
    }

    // one box per eye side by side, or one for both where they share pixels (Overlay and the interleaved modes, whose
    // lines are not followed)
    protected eyeSlots(): { eye: 0 | 1, x: number, y: number, width: number, height: number }[] {
        const { layout, eyes, width, height } = this.displayMode;
        const swapped = eyesSwapped(this.displayMode);
        const eyeOf = (slot: 0 | 1): 0 | 1 => (swapped ? 1 - slot : slot) as 0 | 1;
        switch (layout) {
            case VbStereoLayout.SIDE_BY_SIDE:
            case VbStereoLayout.CYBERSCOPE: {
                const half = width / 2;
                return [0, 1].map(slot => ({ eye: eyeOf(slot as 0 | 1), x: slot * half, y: 0, width: half, height }));
            }
            case VbStereoLayout.OVERLAY:
                return [{ eye: eyes === VbEyes.RIGHT ? 1 : 0, x: 0, y: 0, width, height }];
            default:
                return [{ eye: 0, x: 0, y: 0, width, height }];
        }
    }

    protected drawPixelLayer(context: CanvasRenderingContext2D): void {
        const layer = this.pixelLayer;
        if (!layer) {
            return;
        }
        context.imageSmoothingEnabled = false;
        for (const slot of this.eyeSlots()) {
            const image = slot.eye === 0 ? layer.left : layer.right;
            if (!image) {
                continue;
            }
            let scratch = this.layerCanvases[slot.eye];
            if (!scratch) {
                scratch = this.layerCanvases[slot.eye] = document.createElement('canvas');
            }
            if (scratch.width !== image.width || scratch.height !== image.height) {
                scratch.width = image.width;
                scratch.height = image.height;
            }
            scratch.getContext('2d')?.putImageData(image, 0, 0);
            context.drawImage(scratch, slot.x, slot.y, slot.width, slot.height);
        }
    }

    // see setDevicePixelAuto
    protected devicePixelAuto = false;
    // see setPictureInsets
    protected insets = { top: 0, right: 0, bottom: 0, left: 0 };

    /**
     * Keeps the picture clear of what lies over the panel's edges (a phone's on-screen controller beside or under the
     * picture, the badges' band above it), while the panel itself, and so the halo and the backdrop, still reaches
     * them. The picture is fitted to and centred in what is left, and the halo follows it. Set only by the Emulator
     * component; not applied while the picture is lent to the Display preview.
     */
    setPictureInsets(insets: { top: number, right: number, bottom: number, left: number }): void {
        const was = this.insets;
        if (was.top === insets.top && was.right === insets.right && was.bottom === insets.bottom
            && was.left === insets.left) {
            return;
        }
        this.insets = { ...insets };
        this.applyInsets();
        this.relayout();
    }

    protected applyInsets(): void {
        const { top, right, bottom, left } = this.borrower ? { top: 0, right: 0, bottom: 0, left: 0 } : this.insets;
        const none = top === 0 && right === 0 && bottom === 0 && left === 0;
        this.frame.style.padding = none ? '' : `${top}px ${right}px ${bottom}px ${left}px`;
        // the halo is centred on the frame by the stylesheet; moved by half the difference, it is on the picture again
        this.glow.style.left = none ? '' : `calc(50% + ${(left - right) / 2}px)`;
        this.glow.style.top = none ? '' : `calc(50% + ${(top - bottom) / 2}px)`;
    }

    /**
     * On a phone's few CSS pixels a whole-number scale wastes half the screen (x1 where x1.7 would fit), while its
     * three device pixels per CSS pixel keep any multiple of a third square. So there Auto takes the largest scale that
     * lands on whole device pixels, or simply fills the panel where those steps are too coarse. Set by the Emulator
     * component while the layout is a phone's.
     */
    setDevicePixelAuto(on: boolean): void {
        if (on === this.devicePixelAuto) {
            return;
        }
        this.devicePixelAuto = on;
        this.relayout();
    }

    setScale(scale: string): void {
        this.scale = scale;
        this.relayout();
    }

    // `immersion` also needs the picture's pixels (see `pushBackdrop`) and shows no halo until the first frame
    setDecoration(spec: EmulatorDecorationSpec | undefined): void {
        this.decoration = spec;
        this.applyDecoration();
        this.renderPlaceholder();
        this.repaintBackdrop();
    }

    // read into a brightness plane so the palette can recolor it
    async setPlaceholder(src: string | undefined): Promise<void> {
        this.placeholderStill = undefined;
        this.placeholderAtDepth = undefined;
        if (src === undefined) {
            this.placeholderLeft = undefined;
            this.placeholderRight = undefined;
            this.renderPlaceholder();
            return;
        }
        try {
            const bitmap = await createImageBitmap(await (await fetch(src)).blob());
            // a VB screenshot much wider than 4:3 is both eyes side by side; anything else is one eye, used for both
            const stereo = bitmap.width >= bitmap.height * 3;
            this.placeholderLeft = this.readPlane(bitmap, 0, stereo ? bitmap.width / 2 : bitmap.width);
            this.placeholderRight = stereo
                ? this.readPlane(bitmap, bitmap.width / 2, bitmap.width / 2)
                : this.placeholderLeft;
            bitmap.close();
            this.renderPlaceholder();
        } catch {
        }
    }

    // the live picture gets the depth from the core, the still is redrawn here (see `stereo-still.ts`)
    setStereoDepth(depth: number): void {
        if (this.stereoDepth === depth) {
            return;
        }
        this.stereoDepth = depth;
        this.renderPlaceholder();
    }

    protected placeholderEyes(
        left: Uint8ClampedArray, right: Uint8ClampedArray,
    ): { left: Uint8ClampedArray, right: Uint8ClampedArray } {
        if (this.stereoDepth === 100 || left === right) {
            return { left, right };
        }
        if (this.placeholderAtDepth?.depth !== this.stereoDepth) {
            this.placeholderStill ??= measureStereoStill(left, right, VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT);
            this.placeholderAtDepth = {
                depth: this.stereoDepth,
                ...refocusStereoStill(this.placeholderStill, this.stereoDepth),
            };
        }
        return this.placeholderAtDepth;
    }

    protected readPlane(bitmap: ImageBitmap, sourceX: number, sourceWidth: number): Uint8ClampedArray | undefined {
        const scratch = document.createElement('canvas');
        scratch.width = VB_SCREEN_WIDTH;
        scratch.height = VB_SCREEN_HEIGHT;
        const context = scratch.getContext('2d');
        if (!context) {
            return undefined;
        }
        context.drawImage(
            bitmap, sourceX, 0, sourceWidth, bitmap.height, 0, 0, VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT);
        const { data } = context.getImageData(0, 0, VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT);
        const plane = new Uint8ClampedArray(VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT);
        for (let i = 0; i < plane.length; i++) {
            plane[i] = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        }
        return plane;
    }

    // for a window the browser will not start: emulation is clocked by the audio, so the second player's window shows
    // nothing until clicked (see `audioStillBlocked` in `vb-core.ts`)
    // not a button, as any pointer or key event is the gesture the browser waits for
    setPrompt(text: string | undefined): void {
        this.prompt.textContent = text ?? '';
        this.prompt.hidden = text === undefined;
    }

    // so tools over the picture leave a click on it to the prompt
    get promptShown(): boolean {
        return !this.prompt.hidden;
    }

    showPlaceholder(show: boolean): void {
        if (this.placeholderShown === show) {
            return;
        }
        this.placeholderShown = show;
        if (this.placeholderCanvas) {
            this.placeholderCanvas.hidden = !show;
        }
        if (this.canvasElement) {
            this.canvasElement.hidden = show;
        }
        this.renderPlaceholder();
        this.repaintBackdrop();
        this.relayout();
    }

    // paints the still through the palette in the current mode's layout, with the same brightness-to-color mapping
    // `paintBackdrop` uses for the halo
    protected renderPlaceholder(): void {
        const canvas = this.placeholderCanvas;
        if (!canvas || !this.placeholderLeft || !this.placeholderRight || !this.placeholderShown) {
            return;
        }
        const eyePlanes = this.placeholderEyes(this.placeholderLeft, this.placeholderRight);
        const swapped = eyesSwapped(this.displayMode);
        const left = swapped ? eyePlanes.right : eyePlanes.left;
        const right = swapped ? eyePlanes.left : eyePlanes.right;
        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }
        const { palette, anaglyph, layout, eyes, width, height } = this.displayMode;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const image = context.createImageData(width, height);
        const out = image.data;
        const src = (plane: Uint8ClampedArray, sx: number, sy: number): number =>
            plane[Math.min(VB_SCREEN_HEIGHT - 1, sy) * VB_SCREEN_WIDTH + Math.min(VB_SCREEN_WIDTH - 1, sx)];

        for (let cy = 0; cy < height; cy++) {
            for (let cx = 0; cx < width; cx++) {
                let rgb: number;
                if (layout === VbStereoLayout.OVERLAY) {
                    rgb = eyes === VbEyes.BOTH
                        ? composeAnaglyph(
                            gray(src(left, cx, cy)), gray(src(right, cx, cy)), anaglyph)
                        : shade(palette, src(eyes === VbEyes.RIGHT ? right : left, cx, cy) / 255);
                } else {
                    // the inverse of `strokeEye`'s placement
                    let eye: 0 | 1;
                    let sx: number;
                    let sy = cy;
                    if (layout === VbStereoLayout.SIDE_BY_SIDE) {
                        eye = cx < VB_SCREEN_WIDTH ? 0 : 1;
                        sx = cx % VB_SCREEN_WIDTH;
                    } else if (layout === VbStereoLayout.CYBERSCOPE) {
                        const half = width / 2;
                        eye = cx < half ? 0 : 1;
                        sx = Math.round((cx % half) * (VB_SCREEN_WIDTH / half));
                    } else {
                        // interleaved, as the renderer's shader does it
                        const line = layout === VbStereoLayout.HLI ? cy : cx;
                        eye = (line % 2) as 0 | 1;
                        sx = Math.floor(cx * VB_SCREEN_WIDTH / width);
                        sy = Math.floor(cy * VB_SCREEN_HEIGHT / height);
                    }
                    rgb = shade(palette, src(eye === 1 ? right : left, sx, sy) / 255);
                }
                const i = (cy * width + cx) * 4;
                out[i] = (rgb >> 16) & 0xff;
                out[i + 1] = (rgb >> 8) & 0xff;
                out[i + 2] = rgb & 0xff;
                out[i + 3] = 0xff;
            }
        }
        context.putImageData(image, 0, 0);

        // the still feeds its own immersion halo, as there is no worker frame
        if (this.decoration?.kind === 'immersion') {
            const packed = new Uint8ClampedArray(left.length * 4);
            for (let i = 0; i < left.length; i++) {
                packed[i * 4] = left[i];
                packed[i * 4 + 1] = right[i];
            }
            this.paintBackdrop(packed, VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT);
        }
    }

    /**
     * A reduced stereo frame from Sim.readBackdrop for the `immersion` halo: legacy cells carry two eye brightnesses
     * mapped through the palette, VBC cells two RGB888 colors (two RGBA quads). Ignored unless `immersion` is on and
     * the picture is here or with a decorating borrower. While the still stands in, frames are kept but not painted, as
     * the game runs on behind the Display preview and would overwrite the still's halo.
     */
    pushBackdrop(pixels: ArrayBuffer, width: number, height: number, colorMode = false): void {
        if (this.decoration?.kind !== 'immersion' || (this.borrower && !this.borrowerDecorate)) {
            return;
        }
        const source = new Uint8ClampedArray(pixels);
        this.liveBackdrop = { pixels: source, width, height, colorMode };
        if (this.placeholderShown) {
            return;
        }
        this.paintBackdrop(source, width, height, colorMode);
    }

    // for when the halo's source changes rather than the picture: switching the preview between still and live, or
    // turning `immersion` on while paused
    protected repaintBackdrop(): void {
        // the still's halo is drawn by `renderPlaceholder`
        if (this.decoration?.kind !== 'immersion' || this.placeholderShown) {
            return;
        }
        if (this.liveBackdrop) {
            const { pixels, width, height, colorMode } = this.liveBackdrop;
            this.paintBackdrop(pixels, width, height, colorMode);
        }
    }

    // a borrowed picture wears none of it unless the borrower asked to keep it (the Display preview)
    protected applyDecoration(): void {
        const spec = this.decoration;
        const borrowed = this.borrower !== undefined && !this.borrowerDecorate;
        const glowing = spec !== undefined && spec.kind !== 'black' && !borrowed;
        this.frame.classList.toggle(
            'vp-decoration-black', spec?.kind === 'black' && !borrowed);
        this.frame.classList.toggle('vp-decoration-glow', glowing);

        // kept in step even when not glowing, so a change while it is up needs no repaint
        this.glow.style.opacity = spec !== undefined && spec.kind !== 'black' && !borrowed
            ? String(spec.intensity * (spec.kind === 'ambient' ? AMBIENT_INTENSITY_SCALE : 1))
            : '0';

        const context = this.glow.getContext('2d');
        if (!context) {
            return;
        }
        if (glowing && spec.kind === 'ambient') {
            if (this.glow.width !== 1 || this.glow.height !== 1) {
                this.glow.width = 1;
                this.glow.height = 1;
            }
            context.fillStyle = spec.color;
            context.fillRect(0, 0, 1, 1);
            // a little larger than the picture, the blur does the rest
            this.glowSpread = { x: 1.15, y: 1.15 };
            this.sizeGlow();
        } else {
            // no stale color for nothing, black, a borrowed picture or immersion waiting for its first frame
            context.clearRect(0, 0, this.glow.width, this.glow.height);
        }
    }

    // the border cells become lamps mapped through the palette and every point outside sums their light; the hidden
    // area behind the picture takes the nearest lit point, so the blur has no edge
    protected paintBackdrop(
        source: Uint8ClampedArray, width: number, height: number, colorMode = false
    ): void {
        const context = this.glow.getContext('2d');
        if (!context || width < 1 || height < 1) {
            return;
        }
        const eyePlanes = colorMode
            ? colorEyes(source, width, height)
            : averageEyes(source, width, height);
        // in Anaglyph, each eye through the other filter once they are swapped
        const swapped = eyesSwapped(this.displayMode);
        const left = swapped ? eyePlanes.right : eyePlanes.left;
        const right = swapped ? eyePlanes.left : eyePlanes.right;
        const lamps = haloLamps ??= layoutHaloLamps();
        const wide = HALO_FIELD_WIDTH;
        const tall = HALO_FIELD_HEIGHT;
        if (this.glow.width !== wide || this.glow.height !== tall) {
            this.glow.width = wide;
            this.glow.height = tall;
        }
        const image = context.createImageData(wide, tall);
        const out = image.data;
        const { palette, anaglyph, layout, eyes } = this.displayMode;
        const isAnaglyph = layout === VbStereoLayout.OVERLAY && eyes === VbEyes.BOTH;

        const count = lamps.cell.length;
        const lampRed = new Float64Array(count);
        const lampGreen = new Float64Array(count);
        const lampBlue = new Float64Array(count);
        for (let lamp = 0; lamp < count; lamp++) {
            const cell = lamps.cell[lamp];
            const leftColor = colorMode ? left[cell]
                : isAnaglyph ? gray(left[cell]) : shade(palette, left[cell] / 255);
            const rightColor = colorMode ? right[cell]
                : isAnaglyph ? gray(right[cell]) : shade(palette, right[cell] / 255);
            const rgb = isAnaglyph
                ? composeAnaglyph(leftColor, rightColor, anaglyph)
                : eyes === VbEyes.RIGHT ? rightColor : leftColor;
            lampRed[lamp] = (rgb >> 16) & 0xff;
            lampGreen[lamp] = (rgb >> 8) & 0xff;
            lampBlue[lamp] = rgb & 0xff;
        }

        const insideLeft = HALO_FIELD_PAD;
        const insideTop = HALO_FIELD_PAD;
        const insideRight = HALO_FIELD_PAD + HALO_PICTURE_WIDTH - 1;
        const insideBottom = HALO_FIELD_PAD + HALO_PICTURE_HEIGHT - 1;
        const scale = 1 / lamps.peak;

        for (let y = 0; y < tall; y++) {
            for (let x = 0; x < wide; x++) {
                const hidden = isHiddenByPicture(x, y);
                const px = (hidden ? Math.min(insideRight, Math.max(insideLeft, x)) : x) + 0.5;
                const py = (hidden ? Math.min(insideBottom, Math.max(insideTop, y)) : y) + 0.5;
                let red = 0;
                let green = 0;
                let blue = 0;
                for (let lamp = 0; lamp < count; lamp++) {
                    const dx = px - lamps.x[lamp];
                    const dy = py - lamps.y[lamp];
                    const weight = 1 / (1 + (dx * dx + dy * dy) / HALO_SIGMA2);
                    red += lampRed[lamp] * weight;
                    green += lampGreen[lamp] * weight;
                    blue += lampBlue[lamp] * weight;
                }
                const at = (y * wide + x) * 4;
                out[at] = red * scale;
                out[at + 1] = green * scale;
                out[at + 2] = blue * scale;
                out[at + 3] = 0xff;
            }
        }
        context.putImageData(image, 0, 0);
        this.glowSpread = {
            x: HALO_FIELD_WIDTH / HALO_PICTURE_WIDTH,
            y: HALO_FIELD_HEIGHT / HALO_PICTURE_HEIGHT,
        };
        this.sizeGlow();
    }

    // the blur is sized from the cell, as the grid is stretched over a box of varying size; a fixed radius would smooth
    // it away when small and show the cells when large
    protected sizeGlow(): void {
        const width = Math.round(this.pictureBox.width * this.glowSpread.x);
        const height = Math.round(this.pictureBox.height * this.glowSpread.y);
        this.glow.style.width = `${width}px`;
        this.glow.style.height = `${height}px`;
        const blur = this.glow.width > 2
            ? (width / this.glow.width) * 1.2
            : width * 0.06;
        this.glow.style.filter = `blur(${Math.round(Math.min(96, Math.max(8, blur)))}px) saturate(1.4)`;
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        // Lumino's own size, see `relayout` for why not to measure the DOM again
        this.relayout(msg.width >= 0 && msg.height >= 0 ? { width: msg.width, height: msg.height } : undefined);
    }

    protected onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.relayout();
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.relayout();
    }

    /**
     * Only decides how large the picture appears; integer scales keep the pixels square. `known` comes from
     * `onResize`'s `ResizeMessage`, what Lumino just wrote to `style.width`/`style.height`; other callers measure the
     * DOM. This panel is sized by a bare `ResizeObserver` (see `Emulator.tsx`) and Lumino only re-sends a size that
     * differs from its cache, so a DOM read of a stale intermediate value could stick and leave a gap below the
     * picture.
     */
    protected relayout(known?: { width: number, height: number }): void {
        const canvas = this.placeholderShown ? this.placeholderCanvas : this.canvasElement;
        if (!canvas) {
            return;
        }

        // a lent picture is sized against the borrower, which sends no resize message; minus the insets
        // (setPictureInsets)
        const whole = known && !this.borrower ? known : (this.borrower ?? this.node).getBoundingClientRect();
        const insets = this.borrower ? { top: 0, right: 0, bottom: 0, left: 0 } : this.insets;
        const available = {
            width: whole.width - insets.left - insets.right,
            height: whole.height - insets.top - insets.bottom,
        };
        const { width, height } = this.displayMode;
        if (available.width < 1 || available.height < 1) {
            return;
        }

        const rule = this.borrower && this.borrowerFit ? EmulatorScale.FIT : this.scale;
        const fit = Math.min(available.width / width, available.height / height);
        let scale: number;
        if (rule === EmulatorScale.FIT) {
            scale = fit;
        } else if (rule === EmulatorScale.AUTO && this.devicePixelAuto) {
            // whole device pixels where that comes close to filling the room; at two device pixels per CSS pixel the
            // steps are coarse, and a third of the screen left empty is worse than slightly uneven pixels
            const ratio = window.devicePixelRatio || 1;
            const even = Math.floor(fit * ratio) / ratio;
            scale = even >= fit * 0.9 ? even : fit;
        } else if (rule === EmulatorScale.AUTO) {
            scale = Math.max(1, Math.floor(fit));
        } else {
            const requested = parseInt(rule.substring(1), 10);
            scale = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 1, Math.floor(fit) || 1));
        }

        scale = Math.min(scale, fit);

        const shown = this.placeOnDevicePixels(canvas, Math.floor(width * scale), Math.floor(height * scale));
        canvas.style.width = `${shown.width}px`;
        canvas.style.height = `${shown.height}px`;

        this.pictureBox = shown;
        this.sizeGlow();

        // the overlay stays at the mode's logical resolution (384x224 at x2, not more on HiDPI); CSS enlarges both
        // canvases together
        const overlay = this.overlayCanvas;
        if (overlay) {
            if (overlay.width !== width || overlay.height !== height) {
                overlay.width = width;
                overlay.height = height;
            }
            overlay.style.width = canvas.style.width;
            overlay.style.height = canvas.style.height;
            this.drawHighlights();
        }
    }

    /**
     * Lines an interleaved picture up with the display's pixels: the size is rounded to whole device pixels and the
     * position nudged onto one, as a line straddling two is seen by both eyes. The starting line is measured from the
     * screen top via the window's place, its chrome (assumed to be all at the top) and the picture's place in the page.
     * Exact in fullscreen, a good guess in a window (`swapEyes` covers the rest). Other modes use CSS.
     */
    protected placeOnDevicePixels(
        canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number,
    ): { width: number, height: number } {
        this.picture.style.transform = '';
        const interleaved = isInterleavedLayout(this.displayMode.layout);
        this.watchPlacement(interleaved);
        if (!interleaved || canvas !== this.canvasElement) {
            if (!interleaved) {
                this.announceOutput(undefined);
            }
            return { width: cssWidth, height: cssHeight };
        }
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(cssWidth * ratio));
        const height = Math.max(1, Math.round(cssHeight * ratio));
        // before measuring, as a centred picture's place depends on its size
        canvas.style.width = `${width / ratio}px`;
        canvas.style.height = `${height / ratio}px`;

        const box = this.picture.getBoundingClientRect();
        const left = box.left * ratio;
        const top = box.top * ratio;
        const shiftX = Math.round(left) - left;
        const shiftY = Math.round(top) - top;
        if (Math.abs(shiftX) > 0.01 || Math.abs(shiftY) > 0.01) {
            this.picture.style.transform = `translate(${shiftX / ratio}px, ${shiftY / ratio}px)`;
        }

        const horizontal = this.displayMode.layout === VbStereoLayout.HLI;
        const within = Math.round(horizontal ? top : left);
        this.announceOutput({ width, height, parity: ((Math.round(this.pageStart(horizontal, ratio) + within) % 2) + 2) % 2 });
        return { width: width / ratio, height: height / ratio };
    }

    /**
     * The page's top (HLI) or left edge (VLI) on the display, in physical pixels. Exact when the host says (see
     * `screen-origin.ts`). Otherwise it is worked out from the window: exact in fullscreen and at 100/200 % scaling,
     * possibly a line off at 125/150 %, as the browser rounds the window's place to CSS pixels. Firefox alone reports
     * the page's own place to a fraction, so it is asked first.
     */
    protected pageStart(horizontal: boolean, ratio: number): number {
        const origin = screenOrigin();
        if (origin) {
            return horizontal ? origin.y : origin.x;
        }
        const gecko = window as Window & { mozInnerScreenX?: number, mozInnerScreenY?: number };
        const inner = horizontal ? gecko.mozInnerScreenY : gecko.mozInnerScreenX;
        if (typeof inner === 'number') {
            return Math.round(inner * ratio);
        }
        // window chrome is assumed all at the top and split evenly left and right
        return Math.round(horizontal
            ? (window.screenY + window.outerHeight - window.innerHeight) * ratio
            : (window.screenX + (window.outerWidth - window.innerWidth) / 2) * ratio);
    }

    // moving a window sends no event, and one line down swaps every line between the eyes, so the place is polled a few
    // times a second; includes the pixel ratio, which may change on another screen before a resize
    protected watchPlacement(on: boolean): void {
        if (!on) {
            if (this.placementWatch !== undefined) {
                clearInterval(this.placementWatch);
                this.placementWatch = undefined;
            }
            return;
        }
        this.placementSeen = this.placement();
        if (screenOrigin()) {
            this.watchPlacement(false);
            return;
        }
        if (this.placementWatch === undefined) {
            this.placementWatch = setInterval(() => {
                if (this.placement() !== this.placementSeen) {
                    this.relayout();
                }
            }, PLACEMENT_WATCH_MS);
        }
    }

    protected placement(): string {
        return [
            window.screenX, window.screenY,
            window.outerWidth - window.innerWidth, window.outerHeight - window.innerHeight,
            window.devicePixelRatio,
        ].join(',');
    }

    dispose(): void {
        this.watchPlacement(false);
        this.originWatch.dispose();
        super.dispose();
    }

    protected announceOutput(output: DisplayOutput | undefined): void {
        const previous = this.output;
        if (output === previous || (output && previous && output.width === previous.width
            && output.height === previous.height && output.parity === previous.parity)) {
            return;
        }
        this.output = output;
        this.onDidChangeOutputEmitter.fire(output);
    }

    // must agree with the renderer's shader: side by side puts the right eye a screen width along, Cyberscope squeezes
    // each eye into 256 columns, interleaved is twice the screen both ways
    protected drawHighlights(): void {
        const overlay = this.overlayCanvas;
        const context = overlay?.getContext('2d');
        if (!overlay || !context) {
            return;
        }
        context.resetTransform();
        context.clearRect(0, 0, overlay.width, overlay.height);
        this.drawPixelLayer(context);
        if (this.highlights.length === 0) {
            return;
        }

        const { layout, eyes } = this.displayMode;
        const showLeft = layout !== VbStereoLayout.OVERLAY || eyes !== VbEyes.RIGHT;
        const showRight = layout !== VbStereoLayout.OVERLAY || eyes !== VbEyes.LEFT;

        context.strokeStyle = HIGHLIGHT_COLOR;
        context.fillStyle = HIGHLIGHT_FILL;
        context.lineWidth = HIGHLIGHT_LINE_WIDTH;
        context.setLineDash(HIGHLIGHT_DASH);

        for (const rect of this.highlights) {
            if (showLeft) {
                this.strokeEye(context, rect, 0);
            }
            if (showRight) {
                this.strokeEye(context, rect, 1);
            }
        }
    }

    protected strokeEye(context: CanvasRenderingContext2D, rect: VesScreenRect, eye: 0 | 1): void {
        // the VIP draws the left eye a parallax left of the world's x, the right eye as far right
        const sourceX = rect.x + (eye === 0 ? -rect.parallax : rect.parallax);
        let { x, y, width, height } = { x: sourceX, y: rect.y, width: rect.width, height: rect.height };

        switch (this.displayMode.layout) {
            case VbStereoLayout.SIDE_BY_SIDE:
                x += eye * VB_SCREEN_WIDTH;
                break;
            case VbStereoLayout.CYBERSCOPE: {
                const squeeze = (this.displayMode.width / 2) / VB_SCREEN_WIDTH;
                x = x * squeeze + eye * (this.displayMode.width / 2);
                width *= squeeze;
                break;
            }
            case VbStereoLayout.HLI:
            case VbStereoLayout.VLI:
                // twice the screen both ways; the lines are not followed, as CSS enlarges the overlay but not an
                // interleaved picture
                x *= 2;
                y *= 2;
                width *= 2;
                height *= 2;
                break;
            default:
                break;
        }

        // setLineDash only touches the stroke, so the wash under the broken outline is continuous
        context.fillRect(x, y, width, height);
        // half-pixel inset so a one-pixel stroke lands on a pixel instead of blurring across two
        context.strokeRect(
            x + 0.5, y + 0.5, Math.max(width - 1, 0), Math.max(height - 1, 0)
        );
    }
}
