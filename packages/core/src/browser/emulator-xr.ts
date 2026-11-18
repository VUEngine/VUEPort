/**
 * Playing in a headset: an immersive WebXR session showing each eye its own picture. The game runs as on the page; this
 * takes a second copy of every frame through the video tap a recording uses (see setVideoTap), as WebXR exists on the
 * page's thread only and the worker's canvas cannot be shared with it. Each frame is composed once, side by side, by
 * the ordinary renderer (palette, VB Color, frame blending) into a texture of the page's own. It reaches the headset as
 * a quad layer where offered (the compositor places it, sharper and steadier, each eye given its half, enlarged by a
 * whole multiple so its filtering does not blur pixels), or else as a projection layer drawn per eye with a
 * sharp-but-stable filter. Both eyes see the screen at one place; the depth is the game's own parallax, scaled by 3D
 * Depth.
 *
 * Controllers are read here too, as a headset browser stops the page's animation frames during a session and never
 * lists its controllers to the Gamepad API; their two sticks are the two D-pads (see readControllers). Around the
 * screen is the page's own interface (emulator-xr-ui.ts), shown and hidden with a stick click or the menu button; while
 * it shows, the controllers point at it instead of playing.
 *
 * In parts: emulator-xr-webxr.ts (declarations), emulator-xr-input.ts (controllers), emulator-xr-render.ts (drawing),
 * emulator-xr-panel.ts (questions, news), emulator-xr-ui.ts with -dom and -keyboard (the page's interface).
 */

import {
    buildDisplayMode,
    DisplayMode,
    VbRenderingMode,
    VB_FRAME_RATE,
    VB_SCREEN_HEIGHT,
    VB_SCREEN_WIDTH,
} from '../common/vb-constants';
import { Sim } from './core/vb-core';
import { EmulatorInputController } from './emulator-input';
import {
    noXrButtons,
    readControllers,
    XrButtons,
    XrControllerReading,
    XR_STICK_THRESHOLD,
} from './emulator-xr-input';
import {
    drawXrPanel,
    drawXrPointer,
    drawXrToast,
    firstXrItem,
    moveXrCursor,
    XrPanel,
    XrPanelRow,
    XR_PANEL_PIXELS,
    XR_POINTER_PIXELS,
    XR_TOAST_PIXELS,
} from './emulator-xr-panel';
import {
    buildProgram,
    COPY_FRAGMENT_SHADER,
    COPY_VERTEX_SHADER,
    multiply,
    OVERLAY_COPY_FRAGMENT_SHADER,
    OVERLAY_FRAGMENT_SHADER,
    OVERLAY_UNIT,
    Point3,
    quadEyeRegions,
    quadSizeFactor,
    SCREEN_FRAGMENT_SHADER,
    SCREEN_UNIT,
    SCREEN_VERTEX_SHADER,
    XrFrameRenderer,
    XrOverlay,
    yawAxes,
} from './emulator-xr-render';
import { XrRay, XrUi } from './emulator-xr-ui';
import {
    XrFrame,
    xrGlobals,
    XrInputSource,
    XrProjectionLayer,
    XrQuadLayer,
    XrSession,
    XrSpace,
    xrSystem,
    XrWebGlBinding,
    XrWebGlLayer,
} from './emulator-xr-webxr';

// in meters
const XR_SCREEN_DISTANCE = 2;
export interface XrScreen {
    // in meters, at the distance it stands at
    width: number;
    // in percent like stereoDepth, 100 the real console's. Its own setting, as how deep a picture looks depends on its
    // size, and in a headset it can be made much bigger
    depth: number;
}

// about 33 degrees across at the distance above, small enough for the console's own depth to sit through on a Quest 3
export const XR_DEFAULT_SCREEN: XrScreen = { width: 1.2, depth: 100 };
// in meters
export const XR_MIN_WIDTH = 0.6;
export const XR_MAX_WIDTH = 4;
// in percent, see XrScreen.depth
export const XR_MAX_DEPTH = 200;

export function clampXrScreen(view: Partial<XrScreen>): XrScreen {
    const width = Number.isFinite(view.width) ? view.width! : XR_DEFAULT_SCREEN.width;
    const depth = Number.isFinite(view.depth) ? view.depth! : XR_DEFAULT_SCREEN.depth;
    return {
        width: Math.min(XR_MAX_WIDTH, Math.max(XR_MIN_WIDTH, width)),
        depth: Math.round(Math.min(XR_MAX_DEPTH, Math.max(0, depth))),
    };
}

function screenHeight(width: number): number {
    return width * VB_SCREEN_HEIGHT / VB_SCREEN_WIDTH;
}

// with a stick all the way over: by this factor a second
const XR_WIDTH_RATE = 1.6;
// with a stick all the way over, in percent a second
const XR_DEPTH_RATE = 60;
const XR_ADJUST_DEAD_ZONE = 0.3;
// how often an adjustment in progress is passed on, in milliseconds
const XR_ADJUST_REPORT_MS = 100;
// texels per VB pixel in a quad layer: at about three display pixels per VB pixel on current headsets, three texels
// keep the compositor's filtering to the pixels' edges instead of smearing them
const XR_LAYER_SCALE = 3;

// how long a start waits on a step that should be immediate, in milliseconds
const XR_STEP_TIMEOUT_MS = 2000;

// how long both grips are held to leave the headset, in milliseconds
const XR_EXIT_HOLD_MS = 1000;

// the highest whole multiple of the machine's 50 Hz, so every frame shows for the same number of refreshes; without
// one the highest rate, as faster refresh shows frames less early or late
export function pickXrFrameRate(rates: readonly number[]): number | undefined {
    if (rates.length === 0) {
        return undefined;
    }
    const multiples = rates.filter(rate => {
        const times = Math.round(rate / VB_FRAME_RATE);
        return times >= 2 && Math.abs(rate - times * VB_FRAME_RATE) < 0.5;
    });
    return Math.max(...(multiples.length > 0 ? multiples : rates));
}

// in meters; questions stand in front of the screen
const XR_PANEL_WIDTH = 0.9;
const XR_PANEL_DISTANCE = 1.7;
// a line of news, and how far beneath the screen (or the interface under it) it sits
const XR_TOAST_WIDTH = 0.9;
const XR_TOAST_GAP = 0.06;
const XR_SCROLL_DEAD_ZONE = 0.2;
// a trigger pulled on the interface counts as held until eased off below this, 0 to 1
const XR_TRIGGER_LET_GO = 0.2;
// in milliseconds
const XR_TOAST_MS = 3000;
// in meters, and how far in front of what it points at
const XR_POINTER_WIDTH = 0.022;
const XR_POINTER_LIFT = 0.005;
// how long a stick is held before the cursor repeats, then how often it does
const XR_REPEAT_DELAY_MS = 400;
const XR_REPEAT_MS = 150;

export interface XrDiagnostics {
    // the last step begun; a session that showed nothing is most often one whose start never finished
    stage: XrStage;
    // when each step was begun, in milliseconds from asking for the session
    timeline?: Partial<Record<XrStage, number>>;
    path: 'quad' | 'projection' | 'none';
    frameRate?: number;
    xrFrames: number;
    gameFrames: number;
    error?: string;
    glError?: number;
    glErrorAt?: string;
    // what the browser said each eye's part of the quad layer was, on the first frame
    quadLayout?: string;
    contextLost?: boolean;
    posesMissing: number;
    inputError?: string;
}

// vr for a headset with only a room of its own, ar for one that can also show the real room. An ar session shows the
// room only as its backdrop says (see setBackdrop), so it can switch without a new request, which needs a gesture
export type XrMode = 'vr' | 'ar';

// headset: can play in one; none: speaks WebXR with nothing to offer now; unavailable: a webview or browser that
// never will, however many headsets are plugged in
export type XrAvailability = 'headset' | 'none' | 'unavailable';

// black, a room of its own; passthrough, the player's room; hologram, the room through the screen too, its black
// made see-through. Anything but black wants an ar session
export type XrBackdrop = 'black' | 'passthrough' | 'hologram';

function sessionMode(mode: XrMode): string {
    return mode === 'ar' ? 'immersive-ar' : 'immersive-vr';
}

// says which kind was asked for, as the browser's own words leave it out
function requestError(error: unknown, mode: XrMode): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${message} (${sessionMode(mode)})`);
}

// in order, see XrDiagnostics.stage
export type XrStage = 'session' | 'context' | 'space' | 'layer' | 'loop' | 'machine' | 'running';

export interface EmulatorXrHost {
    // if one is running yet, see EmulatorXrSession.setSim
    readonly sim: Sim | undefined;
    readonly input: EmulatorInputController;
    displayMode(): DisplayMode;
    onXrEnded(diagnostics: XrDiagnostics): void;
    // the machine is clocked by its audio, so a headset stopping the page's sound would freeze it. Called on the way in
    // and on every trigger, which the browser counts as a gesture like a click
    resumeAudio?(): void;
    // false draws into the eye buffers even where a quad layer is offered, for telling a layer problem from others
    quadLayers?: boolean;
    // vr without one
    mode?: XrMode;
    // what an ar session starts out with around the screen; black without one
    backdrop?: XrBackdrop;
    // as last left; XR_DEFAULT_SCREEN without one
    view?: XrScreen;
    // adjusted from inside the headset. The depth is the host's to apply, as it is the machine's, not the picture's,
    // and both are the host's to keep for next time
    onXrViewChanged?(view: XrScreen): void;
    // the page's interface came up around a running game or stepped aside again, for the host to pause the game
    // behind it and carry on with it; not called without a game, when the interface shows regardless
    onXrUiShown?(shown: boolean): void;
    // the page's interface around the screen (see emulator-xr-ui.ts); without it the controllers only ever play
    pageUi?: boolean;
    // reports what goes wrong drawing that interface, and lets a probe reach it
    debug?: boolean;
    // offered through the browser's own interface rather than asked for (see XrSystem.offerSession): resolves once
    // the player takes it, which may be never
    offer?: boolean;
}

const XR_CONTEXT_ATTRIBUTES = {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: true,
    stencil: false,
    xrCompatible: true,
};

// for telling sessions' copies of the frames apart, see tapOwner
let sessionCount = 0;

// start one from a click or key press, as a browser grants a headset to nothing else, and only for a few seconds;
// so a game can start into a session already showing, a dim red screen until there is a machine, or what is being
// waited for (see setWaiting)
export class EmulatorXrSession {

    // for passthrough, one that can show the room
    static async isSupported(mode: XrMode = 'vr'): Promise<boolean> {
        try {
            return await xrSystem()?.isSessionSupported(sessionMode(mode)) ?? false;
        } catch {
            // a permissions policy withholding xr-spatial-tracking answers with a rejection rather than false
            return false;
        }
    }

    static canOffer(): boolean {
        return typeof xrSystem()?.offerSession === 'function';
    }

    static async availability(): Promise<XrAvailability> {
        if (!xrSystem()) {
            return 'unavailable';
        }
        return await EmulatorXrSession.isSupported() ? 'headset' : 'none';
    }

    // a standalone headset is there from the start, but a PC's arrives when Link or a streamer such as Virtual Desktop
    // connects, usually after the page has asked
    static onDeviceChange(listener: () => void): { dispose(): void } {
        const xr = xrSystem();
        xr?.addEventListener?.('devicechange', listener);
        return { dispose: () => xr?.removeEventListener?.('devicechange', listener) };
    }

    // sessions running their frame loop, which drives the input in place of the page's frames
    protected static looping = 0;
    protected looping = false;

    static async start(host: EmulatorXrHost): Promise<EmulatorXrSession> {
        const xr = xrSystem();
        if (!xr) {
            throw new Error('There is no headset to play in.');
        }
        const stats: XrDiagnostics = {
            stage: 'session', path: 'none', xrFrames: 0, gameFrames: 0, posesMissing: 0, timeline: {},
        };
        const asked = performance.now();
        const reach = (stage: XrStage): void => {
            stats.stage = stage;
            stats.timeline![stage] = Math.round(performance.now() - asked);
        };
        reach('session');
        // first, while the click still counts. Layers only when a quad layer is wanted, as a session that has them may
        // refuse a base layer outright, as the Quest Browser does
        const init = { optionalFeatures: host.quadLayers === false ? [] : ['layers'] };
        let mode = host.mode ?? 'vr';
        let session: XrSession;
        try {
            session = host.offer && xr.offerSession
                ? await xr.offerSession(sessionMode(mode), init)
                : await xr.requestSession(sessionMode(mode), init);
        } catch (error) {
            // an offer turned down is not asked again, the browser would not show a second one meanwhile
            if (host.offer) {
                throw requestError(error, mode);
            }
            // a PC runtime can claim to show the room and then refuse: Chromium over Quest Link answers yes to
            // immersive-ar and turns it down. Asked again at once, still inside the click, without the room
            if (mode !== 'ar') {
                throw requestError(error, mode);
            }
            mode = 'vr';
            session = await xr.requestSession(sessionMode(mode), init).catch(again => {
                throw requestError(again, mode);
            });
        }
        let renderer: XrFrameRenderer | undefined;
        let xrSession: EmulatorXrSession | undefined;
        try {
            reach('context');
            // compatible from the start, as making a context compatible afterwards may rebuild it and lose every
            // texture and program the renderer made
            const canvas = document.createElement('canvas');
            canvas.getContext('webgl2', XR_CONTEXT_ATTRIBUTES);
            renderer = new XrFrameRenderer(canvas, xrDisplayMode(host.displayMode()));
            const gl = renderer.context;
            // made compatible, so asking has nothing to do; asked only where the context does not say so, and a
            // start must not hang on it if it never answers (a Quest coming back to a session took seconds here)
            if (!(gl.getContextAttributes() as { xrCompatible?: boolean } | null)?.xrCompatible) {
                await Promise.race([
                    (gl as WebGL2RenderingContext & { makeXRCompatible(): Promise<void> }).makeXRCompatible(),
                    new Promise(resolve => setTimeout(resolve, XR_STEP_TIMEOUT_MS)),
                ]);
            }
            reach('space');
            const space = await session.requestReferenceSpace('local');
            xrSession = new EmulatorXrSession(host, mode, session, renderer, canvas, space, stats, reach);
            await xrSession.begin();
            return xrSession;
        } catch (error) {
            if (xrSession) {
                // releases everything, the renderer included
                await xrSession.end();
            } else {
                renderer?.dispose();
                await session.end().catch(() => undefined);
            }
            throw error;
        }
    }

    protected readonly gl: WebGL2RenderingContext;
    protected readonly image: WebGLTexture;
    protected readonly imageFramebuffer: WebGLFramebuffer;
    protected readonly layerFramebuffer: WebGLFramebuffer;

    protected quad: {
        binding: XrWebGlBinding;
        layer: XrQuadLayer;
        program: WebGLProgram;
        viewport: WebGLUniformLocation | null;
        eye: WebGLUniformLocation | null;
        overlayProgram: WebGLProgram;
        overlayViewport: WebGLUniformLocation | null;
        // dark see-through, for the hologram backdrop
        hologram: WebGLUniformLocation | null;
        // black around the screen in an ar session with a black backdrop: a sphere the compositor holds still where the
        // browser has one (one drawn each frame lags at the view's edges whenever a frame is late), else a projection
        // layer
        cover: XrProjectionLayer | XrQuadLayer | undefined;
        coverIsSphere?: boolean;
        coverDrawn?: boolean;
    } | undefined;
    protected projection: {
        layer: XrWebGlLayer;
        program: WebGLProgram;
        size: WebGLUniformLocation | null;
        viewProjection: WebGLUniformLocation | null;
        eye: WebGLUniformLocation | null;
        hologram: WebGLUniformLocation | null;
        overlayProgram: WebGLProgram;
        overlayViewProjection: WebGLUniformLocation | null;
        overlayCenter: WebGLUniformLocation | null;
        overlaySize: WebGLUniformLocation | null;
        overlayYaw: WebGLUniformLocation | null;
    } | undefined;

    protected sim: Sim | undefined;
    protected backdropShown: XrBackdrop;
    // per session rather than shared, so a session letting go of its copy never takes another's, whatever order one
    // ends and the next starts in
    protected readonly tapOwner = `xr-${++sessionCount}`;
    protected view: XrScreen;
    protected viewReportedAt = 0;
    protected lastFrameTime: number | undefined;
    protected adjusting = false;
    protected panel: { panel: XrPanel; cursor: number } | undefined;
    protected readonly panelOverlay: XrOverlay;
    protected readonly toastOverlay: XrOverlay;
    protected toastUntil = 0;
    // on the screen while there is no machine yet: what the page is waiting for (a download), see setWaiting
    protected readonly waitOverlay: XrOverlay;
    protected waiting: string | undefined;
    protected readonly ui: XrUi | undefined;
    // whether the player wants it showing; without a game it always does (see applyUi)
    protected uiWanted = false;
    // the trigger or A that went down on the interface, so its release goes there too
    protected uiPress: keyof XrButtons | undefined;
    protected panelRows: XrPanelRow[] = [];
    protected readonly pointerOverlay: XrOverlay;
    protected pointingHand: 'left' | 'right' = 'right';
    protected pointingAt: 'item' | 'panel' | 'nothing' = 'nothing';
    protected previousButtons: XrButtons = noXrButtons();
    protected repeat: { step: number; at: number } | undefined;
    // the game is kept from the controllers until they are let go, so the press that closed a menu does not reach it
    protected heldBack = false;
    protected dirty = false;
    protected frameHandle: number | undefined;
    // by the session's own events
    protected readonly squeezing = new Set<string>();
    protected exitTimer: ReturnType<typeof setTimeout> | undefined;
    protected ended = false;
    // whether begin got all the way, so the host is owed an onXrEnded
    protected started = false;

    protected constructor(
        protected readonly host: EmulatorXrHost,
        // may be less than the host asked for, see mode
        protected readonly granted: XrMode,
        protected readonly session: XrSession,
        protected readonly renderer: XrFrameRenderer,
        canvas: HTMLCanvasElement,
        protected readonly space: XrSpace,
        protected readonly stats: XrDiagnostics,
        protected readonly reach: (stage: XrStage) => void,
    ) {
        const gl = renderer.context;
        this.gl = gl;
        this.view = clampXrScreen(host.view ?? XR_DEFAULT_SCREEN);
        this.backdropShown = this.mode === 'ar' ? host.backdrop ?? 'black' : 'black';
        canvas.addEventListener('webglcontextlost', () => {
            this.stats.contextLost = true;
        });

        gl.activeTexture(gl.TEXTURE0 + SCREEN_UNIT);
        const image = gl.createTexture();
        const imageFramebuffer = gl.createFramebuffer();
        const layerFramebuffer = gl.createFramebuffer();
        if (!image || !imageFramebuffer || !layerFramebuffer) {
            throw new Error('Could not allocate the headset picture.');
        }
        gl.bindTexture(gl.TEXTURE_2D, image);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, VB_SCREEN_WIDTH * 2, VB_SCREEN_HEIGHT);
        // linear for the sharp-bilinear filter; the quad layer's copy reads texels directly
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, imageFramebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);

        this.image = image;
        this.imageFramebuffer = imageFramebuffer;
        this.layerFramebuffer = layerFramebuffer;
        this.panelOverlay = new XrOverlay(gl, XR_PANEL_PIXELS, XR_PANEL_WIDTH);
        this.panelOverlay.place(0, 0, -XR_PANEL_DISTANCE);
        this.toastOverlay = new XrOverlay(gl, XR_TOAST_PIXELS, XR_TOAST_WIDTH);
        this.waitOverlay = new XrOverlay(gl, XR_TOAST_PIXELS, XR_TOAST_WIDTH);
        this.ui = host.pageUi ? new XrUi(gl, host.debug) : undefined;
        if (this.ui) {
            this.ui.onQuestion = () => this.setUiShown(true);
        }
        this.pointerOverlay = new XrOverlay(gl, XR_POINTER_PIXELS, XR_POINTER_WIDTH, true);
        drawXrPointer(this.pointerOverlay.canvas);
        this.pointerOverlay.upload();
        this.placeAround();
        this.clearImage();
        // without a game it shows from the start
        this.applyUi();
    }

    // red until a frame is composed rather than transparent black, as an empty screen reads differently from none;
    // dark behind a message saying what is coming
    protected clearImage(): void {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.imageFramebuffer);
        if (this.waiting !== undefined) {
            gl.clearColor(0.06, 0.06, 0.06, 1);
        } else {
            gl.clearColor(0.45, 0, 0, 1);
        }
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    protected async begin(): Promise<void> {
        const session = this.session;
        // first, so a session the headset ends during setup is cleaned up like any other
        session.addEventListener('end', this.onEnd);
        session.addEventListener('select', this.onGesture);
        session.addEventListener('squeeze', this.onGesture);
        session.addEventListener('visibilitychange', this.onGesture);
        session.addEventListener('squeezestart', this.onSqueezeStart);
        session.addEventListener('squeezeend', this.onSqueezeEnd);
        this.checkGl('setting up');
        this.reach('layer');
        if (this.host.quadLayers === false || !this.createQuadLayer()) {
            this.createProjectionLayer();
        }
        this.applyScreenSize();
        this.checkGl('creating the layer');
        this.host.resumeAudio?.();

        this.reach('loop');
        EmulatorXrSession.looping++;
        this.looping = true;
        this.host.input.setExternalFrames(true);
        this.frameHandle = session.requestAnimationFrame(this.onFrame);

        const rate = pickXrFrameRate([...session.supportedFrameRates ?? []]);
        if (rate !== undefined && session.updateTargetFrameRate) {
            this.stats.frameRate = rate;
            // not waited for: the change takes effect within the frame loop and the promise only settles then, so
            // waiting before the loop runs waits forever (a black Quest). A refused rate leaves the headset at its own
            session.updateTargetFrameRate(rate).catch(() => undefined);
        }

        this.reach('machine');
        await this.setSim(this.host.sim);
        if (this.ended) {
            throw new Error('The headset session ended while it was starting.');
        }
        this.reach('running');
        this.started = true;
    }

    // a game being opened, closed or rebuilt underneath the session, which outlives all three
    async setSim(sim: Sim | undefined): Promise<void> {
        if (sim === this.sim) {
            return;
        }
        const previous = this.sim;
        this.sim = sim;
        this.applyUi();
        if (previous) {
            // a machine that has already gone took its tap with it
            await previous.setVideoTap(undefined, this.tapOwner).catch(() => undefined);
        }
        if (this.ended) {
            return;
        }
        if (!sim) {
            this.dirty = false;
            this.clearImage();
            this.showWaiting();
            return;
        }
        this.showWaiting();
        // the current picture, so the headset has it at once, as a paused machine never presents another
        const current = await sim.readFrame().catch(() => undefined);
        if (this.sim !== sim || this.ended) {
            return;
        }
        if (current) {
            [...current.previous].reverse().forEach((before, index) =>
                this.renderer.present(new Uint8Array(before.pixels), before.colorMode, index === 0 ? 'jump' : 'next'));
            this.renderer.present(
                new Uint8Array(current.pixels), current.colorMode, current.previous.length > 0 ? 'next' : 'jump');
            this.dirty = true;
            // a game that stays paused presents nothing more, and is shown all the same
            this.stats.gameFrames++;
            this.checkGl('taking the picture on show');
        }
        await sim.setVideoTap(frame => {
            if (this.sim === sim && !this.ended) {
                this.renderer.present(new Uint8Array(frame.pixels), frame.colorMode, frame.kind);
                this.dirty = true;
                this.stats.gameFrames++;
                if (this.stats.gameFrames <= 3) {
                    this.checkGl('taking a game frame');
                }
            }
        }, this.tapOwner, true);
        // replaced or ended while the tap was being opened
        if (this.sim !== sim || this.ended) {
            await sim.setVideoTap(undefined, this.tapOwner).catch(() => undefined);
        }
    }

    protected createQuadLayer(): boolean {
        const Binding = xrGlobals.XRWebGLBinding;
        const Transform = xrGlobals.XRRigidTransform;
        if (!Binding || !Transform || !this.session.enabledFeatures?.includes('layers')) {
            return false;
        }
        try {
            const binding = new Binding(this.session, this.gl);
            const layer = binding.createQuadLayer({
                space: this.space,
                viewPixelWidth: VB_SCREEN_WIDTH * XR_LAYER_SCALE,
                viewPixelHeight: VB_SCREEN_HEIGHT * XR_LAYER_SCALE,
                layout: 'stereo-left-right',
                textureType: 'texture',
                isStatic: false,
                width: this.view.width * quadSizeFactor(),
                height: screenHeight(this.view.width) * quadSizeFactor(),
                transform: new Transform({ x: 0, y: 0, z: -XR_SCREEN_DISTANCE }),
            });
            const gl = this.gl;
            const program = buildProgram(gl, COPY_VERTEX_SHADER, COPY_FRAGMENT_SHADER);
            gl.useProgram(program);
            gl.uniform1i(gl.getUniformLocation(program, 'uImage'), SCREEN_UNIT);
            const overlayProgram = buildProgram(gl, COPY_VERTEX_SHADER, OVERLAY_COPY_FRAGMENT_SHADER);
            gl.useProgram(overlayProgram);
            gl.uniform1i(gl.getUniformLocation(overlayProgram, 'uImage'), OVERLAY_UNIT);
            // low resolution is no loss: it is only ever one colour
            let sphere: XrQuadLayer | undefined;
            if (this.mode === 'ar') {
                try {
                    sphere = binding.createEquirectLayer?.({
                        space: this.space, viewPixelWidth: 4, viewPixelHeight: 4, layout: 'mono', textureType: 'texture',
                        isStatic: true, radius: 0, centralHorizontalAngle: 2 * Math.PI,
                        upperVerticalAngle: Math.PI / 2, lowerVerticalAngle: -Math.PI / 2,
                    });
                } catch {
                    sphere = undefined;
                }
            }
            const cover = this.mode === 'ar'
                ? sphere ?? binding.createProjectionLayer?.({ textureType: 'texture', scaleFactor: 0.25 })
                : undefined;
            layer.blendTextureSourceAlpha = this.backdropShown === 'hologram';
            this.quad = {
                binding,
                layer,
                program,
                viewport: gl.getUniformLocation(program, 'uViewport'),
                eye: gl.getUniformLocation(program, 'uEye'),
                hologram: gl.getUniformLocation(program, 'uHologram'),
                overlayProgram,
                overlayViewport: gl.getUniformLocation(overlayProgram, 'uViewport'),
                cover,
                coverIsSphere: sphere !== undefined,
            };
            this.updateLayers();
            this.stats.path = 'quad';
            return true;
        } catch (error) {
            this.stats.error ??= `quad layer: ${error instanceof Error ? error.message : String(error)}`;
            return false;
        }
    }

    protected createProjectionLayer(): void {
        const Layer = xrGlobals.XRWebGLLayer;
        if (!Layer) {
            throw new Error('This browser cannot draw into a headset.');
        }
        if (this.session.enabledFeatures?.includes('layers')) {
            // only reached when the quad layer itself failed, whose reason is the one worth reporting
            throw new Error(this.stats.error ?? 'The quad layer could not be created.');
        }
        const gl = this.gl;
        const layer = new Layer(this.session, gl);
        this.session.updateRenderState({ baseLayer: layer });

        const program = buildProgram(gl, SCREEN_VERTEX_SHADER, SCREEN_FRAGMENT_SHADER);
        gl.useProgram(program);
        gl.uniform1i(gl.getUniformLocation(program, 'uImage'), SCREEN_UNIT);
        gl.uniform3f(gl.getUniformLocation(program, 'uCenter'), 0, 0, -XR_SCREEN_DISTANCE);
        const overlayProgram = buildProgram(gl, SCREEN_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER);
        gl.useProgram(overlayProgram);
        gl.uniform1i(gl.getUniformLocation(overlayProgram, 'uImage'), OVERLAY_UNIT);
        this.projection = {
            layer,
            program,
            size: gl.getUniformLocation(program, 'uSize'),
            viewProjection: gl.getUniformLocation(program, 'uViewProjection'),
            eye: gl.getUniformLocation(program, 'uEye'),
            hologram: gl.getUniformLocation(program, 'uHologram'),
            overlayProgram,
            overlayViewProjection: gl.getUniformLocation(overlayProgram, 'uViewProjection'),
            overlayCenter: gl.getUniformLocation(overlayProgram, 'uCenter'),
            overlaySize: gl.getUniformLocation(overlayProgram, 'uSize'),
            overlayYaw: gl.getUniformLocation(overlayProgram, 'uYaw'),
        };
        this.stats.path = 'projection';
    }

    get mode(): XrMode {
        return this.granted;
    }

    get backdrop(): XrBackdrop {
        return this.backdropShown;
    }

    // at once, in the session as it is; only an ar session has a room to show
    setBackdrop(backdrop: XrBackdrop): void {
        if (this.mode !== 'ar' || backdrop === this.backdropShown) {
            return;
        }
        this.backdropShown = backdrop;
        if (this.quad) {
            this.quad.layer.blendTextureSourceAlpha = backdrop === 'hologram';
        }
        this.updateLayers();
    }

    get running(): boolean {
        return this.started && !this.ended;
    }

    get diagnostics(): XrDiagnostics {
        return { ...this.stats };
    }

    setDisplayMode(mode: DisplayMode): void {
        if (!this.ended) {
            this.renderer.setDisplayMode(xrDisplayMode(mode));
            this.dirty = true;
        }
    }

    // the host hears of it through onXrEnded
    async end(): Promise<void> {
        if (!this.ended) {
            await this.session.end().catch(() => this.onEnd());
        }
    }

    protected readonly onFrame = (time: number, frame: XrFrame): void => {
        if (this.ended) {
            return;
        }
        this.frameHandle = this.session.requestAnimationFrame(this.onFrame);
        this.stats.xrFrames++;
        // each caught on its own, so one going wrong is reported rather than drawing nothing silently, and failing
        // controllers never cost the picture. The first frames, then now and then, as asking stalls the pipeline
        const checking = this.stats.glError === undefined
            && (this.stats.xrFrames <= 5 || this.stats.xrFrames % 300 === 0);
        if (checking) {
            // whatever happened since the last frame: a game frame arriving, the session being set up
            this.checkGl('between frames');
        }
        try {
            // before the buttons are read, so a trigger takes what is under the pointer on the frame it is pulled
            this.point(frame);
            this.pollInput(time, frame);
        } catch (error) {
            this.stats.inputError ??= error instanceof Error ? error.message : String(error);
        }
        try {
            if (this.dirty) {
                this.dirty = false;
                this.renderer.renderTo(this.imageFramebuffer);
                if (checking) {
                    this.checkGl('composing');
                }
            }
            if (this.ui?.update(time)) {
                this.placeAround();
                this.updateLayers();
            }
            if (this.toastOverlay.visible && performance.now() >= this.toastUntil) {
                this.toastOverlay.visible = false;
                this.updateLayers();
            }
            if (this.quad) {
                this.drawQuad(frame);
            } else {
                this.drawProjection(frame);
            }
            if (checking) {
                this.checkGl(this.quad ? 'quad layer' : 'eye buffers');
            }
        } catch (error) {
            this.stats.error ??= error instanceof Error ? error.message : String(error);
        }
    };

    protected checkGl(where: string): void {
        const code = this.gl.getError();
        if (code !== this.gl.NO_ERROR && this.stats.glError === undefined) {
            this.stats.glError = code;
            this.stats.glErrorAt = where;
        }
    }

    protected pollInput(time: number, frame: XrFrame): void {
        const input = this.host.input;
        const elapsed = this.lastFrameTime === undefined ? 0 : Math.min(time - this.lastFrameTime, 100) / 1000;
        this.lastFrameTime = time;
        // the system menu is up, or the headset is off: nothing held
        if (this.session.visibilityState !== 'visible') {
            input.setXrKeys(0);
            input.pollFrame();
            return;
        }
        const reading = readControllers(this.session.inputSources);
        const buttons = reading.buttons;
        const before = this.previousButtons;
        this.previousButtons = buttons;
        const pressed = (name: keyof XrButtons) => buttons[name] && !before[name];
        let keys = reading.keys;
        if (this.panel) {
            keys = 0;
            this.drivePanel(reading, pressed, time);
        } else if (reading.adjusting) {
            this.adjustView(reading, elapsed, time);
        } else {
            if (this.adjusting) {
                this.adjusting = false;
                this.depthInProgress = undefined;
                this.host.onXrViewChanged?.({ ...this.view });
            }
            // a stick click or the menu button shows or hides the interface; with a grip held, a click puts the screen
            // back (see adjustView)
            if (this.ui && (pressed('leftClick') || pressed('rightClick') || pressed('menu'))) {
                this.toggleUi();
                keys = 0;
            } else if (this.ui?.shown) {
                this.driveUi(reading, pressed, elapsed, frame);
            }
        }
        if (this.panel || this.ui?.shown) {
            keys = 0;
            this.heldBack = true;
        } else if (this.heldBack) {
            // until everything that was down when they let go is up again
            if (keys === 0 && !Object.values(buttons).some(Boolean)) {
                this.heldBack = false;
            }
            keys = 0;
        }
        input.setXrKeys(keys);
        // pads paired with the headset itself are still the Gamepad API's
        input.pollFrame();
    }

    // the dot goes where the pointing hand's ray meets the question, and the cursor onto the item it is on; or where it
    // meets the interface, which then has a mouse there
    protected point(frame: XrFrame): void {
        const shown = this.panel;
        if (!shown) {
            const ui = this.ui;
            const rays = ui?.shown ? this.rays(frame) : [];
            const aim = ui && rays.length ? ui.aim(rays) : undefined;
            if (aim) {
                const { normal } = yawAxes(aim.overlay.turn);
                const { point } = aim.hit;
                this.pointerOverlay.place(point.x + normal.x * XR_POINTER_LIFT, point.y,
                    point.z + normal.z * XR_POINTER_LIFT, aim.overlay.turn);
            } else if (ui && rays.length) {
                // between the parts the dot goes on where they stand (as far off as the screen, all round), so the
                // hand is never lost on the way from one to the next
                const point = onSphere(rays[0], ui.distance);
                if (point) {
                    this.pointerOverlay.place(point.x, point.y, point.z, Math.atan2(-point.x, -point.z));
                }
            }
            this.pointingAt = 'nothing';
            this.showPointer(rays.length > 0);
            return;
        }
        const hit = this.rays(frame).map(ray => this.panelOverlay.hit(ray.origin, ray.direction))
            .find(found => found !== undefined);
        if (!hit) {
            this.pointingAt = 'nothing';
            this.showPointer(false);
            return;
        }
        this.pointerOverlay.place(hit.point.x, hit.point.y, hit.point.z + XR_POINTER_LIFT);
        this.showPointer(true);
        const row = this.panelRows.find(candidate => hit.y >= candidate.top && hit.y < candidate.bottom);
        const item = row && shown.panel.items()[row.index];
        if (!row || !item || item.disabled) {
            this.pointingAt = 'panel';
            return;
        }
        this.pointingAt = 'item';
        if (row.index !== shown.cursor) {
            shown.cursor = row.index;
            this.drawPanel();
        }
    }

    protected rays(frame: XrFrame): XrRay[] {
        const sources = this.session.inputSources;
        const hands = [this.pointingHand, this.pointingHand === 'left' ? 'right' : 'left'];
        const rays: XrRay[] = [];
        for (const hand of hands) {
            for (let i = 0; i < sources.length; i++) {
                const source = sources[i];
                if (source.handedness !== hand || !source.targetRaySpace) {
                    continue;
                }
                const pose = frame.getPose?.(source.targetRaySpace, this.space);
                if (!pose) {
                    continue;
                }
                const m = pose.transform.matrix;
                // from the ray's origin, along its -Z axis
                rays.push({ origin: { x: m[12], y: m[13], z: m[14] }, direction: { x: -m[8], y: -m[9], z: -m[10] } });
            }
        }
        return rays;
    }

    protected showPointer(visible: boolean): void {
        if (this.pointerOverlay.visible !== visible) {
            this.pointerOverlay.visible = visible;
            this.updateLayers();
        }
    }

    get uiShown(): boolean {
        return this.ui?.shown ?? false;
    }

    // what the player wants; without a game the interface shows regardless, as there is nothing else to see
    setUiShown(shown: boolean): void {
        this.uiWanted = shown;
        this.applyUi();
    }

    protected toggleUi(): void {
        if (this.sim) {
            this.setUiShown(!this.uiWanted);
        }
    }

    protected applyUi(): void {
        const ui = this.ui;
        if (!ui || this.ended) {
            return;
        }
        ui.setGame(this.sim !== undefined);
        const shown = this.uiWanted || this.sim === undefined;
        if (shown !== ui.shown) {
            ui.setShown(shown);
            if (!shown) {
                this.uiPress = undefined;
                this.showPointer(false);
            }
            if (this.sim) {
                this.host.onXrUiShown?.(shown);
            }
        }
    }

    // a trigger (the pointing hand's) or A is the mouse button, B is Escape, a stick scrolls what is pointed at
    protected driveUi(
        reading: XrControllerReading,
        pressed: (name: keyof XrButtons) => boolean,
        elapsed: number,
        frame: XrFrame,
    ): void {
        const ui = this.ui!;
        const buttons = reading.buttons;
        // a trigger points with its own hand from now on, and presses where that hand points, not where the other did
        const hand = pressed('leftTrigger') ? 'left' : pressed('rightTrigger') ? 'right' : this.pointingHand;
        if (hand !== this.pointingHand) {
            this.pointingHand = hand;
            this.point(frame);
        }
        const press = pressed('leftTrigger') ? 'leftTrigger' : pressed('rightTrigger') ? 'rightTrigger'
            : pressed('a') ? 'a' : undefined;
        // a trigger pressed holds until it is nearly let go: a hand eases off while dragging a slider
        const holding = (name: keyof XrButtons): boolean => name === 'leftTrigger'
            ? reading.triggers.left > XR_TRIGGER_LET_GO
            : name === 'rightTrigger' ? reading.triggers.right > XR_TRIGGER_LET_GO : buttons[name];
        if (this.uiPress && !holding(this.uiPress)) {
            this.uiPress = undefined;
            ui.release();
        }
        if (press && !this.uiPress) {
            this.uiPress = press;
            ui.press();
        }
        if (pressed('b')) {
            ui.escape();
        }
        if (Math.abs(reading.vertical) > XR_SCROLL_DEAD_ZONE) {
            ui.scroll(reading.vertical, elapsed);
        }
    }

    // the sticks move the cursor, repeating while held; A or a trigger takes the line, B or a stick click closes
    protected drivePanel(
        reading: XrControllerReading,
        pressed: (name: keyof XrButtons) => boolean,
        time: number,
    ): void {
        const shown = this.panel!;
        const items = shown.panel.items();
        const step = reading.vertical < -XR_STICK_THRESHOLD ? -1 : reading.vertical > XR_STICK_THRESHOLD ? 1 : 0;
        if (step === 0) {
            this.repeat = undefined;
        } else if (!this.repeat || this.repeat.step !== step || time >= this.repeat.at) {
            const first = !this.repeat || this.repeat.step !== step;
            this.repeat = { step, at: time + (first ? XR_REPEAT_DELAY_MS : XR_REPEAT_MS) };
            const cursor = moveXrCursor(items, shown.cursor, step);
            if (cursor !== shown.cursor) {
                shown.cursor = cursor;
                this.drawPanel();
            }
        }
        if (pressed('leftTrigger')) {
            this.pointingHand = 'left';
        } else if (pressed('rightTrigger')) {
            this.pointingHand = 'right';
        }
        // a trigger takes what it points at; pointed at the panel between items it takes nothing, pointed nowhere near
        // it, it does what A does
        const triggered = (pressed('leftTrigger') || pressed('rightTrigger')) && this.pointingAt !== 'panel';
        if (pressed('a') || triggered) {
            const item = items[shown.cursor];
            if (item && !item.disabled) {
                const outcome = item.run();
                // unless it was a switch, or it put up a panel of its own
                if (this.panel === shown) {
                    if (outcome === 'keep') {
                        this.drawPanel();
                    } else {
                        this.closePanel();
                    }
                }
            }
        } else if (pressed('b') || pressed('leftClick') || pressed('rightClick') || pressed('menu')) {
            this.closePanel();
        }
    }

    // in place of any that is up. The controllers drive it, and not the game, until it closes
    showPanel(panel: XrPanel): void {
        if (this.ended) {
            panel.onClose?.();
            return;
        }
        const previous = this.panel;
        this.panel = { panel, cursor: firstXrItem(panel.items()) };
        this.repeat = undefined;
        previous?.panel.onClose?.();
        this.drawPanel();
        this.panelOverlay.visible = true;
        this.updateLayers();
    }

    // from outside the headset (the settings pane, with a tethered headset). Not passed back through onXrViewChanged,
    // as whoever set it has it already
    setView(view: XrScreen): void {
        if (this.ended) {
            return;
        }
        this.view = clampXrScreen(view);
        this.depthInProgress = undefined;
        this.applyScreenSize();
    }

    resetScreen(): void {
        this.view = { ...XR_DEFAULT_SCREEN };
        this.depthInProgress = undefined;
        this.applyScreenSize();
        this.host.onXrViewChanged?.({ ...this.view });
    }

    closePanel(): void {
        const shown = this.panel;
        if (!shown) {
            return;
        }
        this.panel = undefined;
        this.panelOverlay.visible = false;
        this.pointerOverlay.visible = false;
        this.pointingAt = 'nothing';
        this.updateLayers();
        shown.panel.onClose?.();
    }

    // the two answers as a menu; backing out, or the session ending, is the second answer
    ask(title: string, message: string[], yes: string, no: string): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            let answer = false;
            this.showPanel({
                title,
                message,
                items: () => [
                    { label: yes, run: () => { answer = true; } },
                    { label: no, run: () => { answer = false; } },
                ],
                onClose: () => resolve(answer),
            });
        });
    }

    // what the page is waiting for (`Fetching Super Metroid from Mac mini… 40 %`), on the screen for as long as there
    // is no machine to show, in place of the empty red one; undefined when nothing is
    setWaiting(text: string | undefined): void {
        if (this.ended || text === this.waiting) {
            return;
        }
        const was = this.waiting;
        this.waiting = text;
        if (!this.sim && (was === undefined) !== (text === undefined)) {
            this.clearImage();
        }
        this.showWaiting();
    }

    protected showWaiting(): void {
        const shown = this.waiting !== undefined && !this.sim;
        if (shown) {
            drawXrToast(this.waitOverlay.canvas, this.waiting as string, false);
            this.waitOverlay.upload();
        }
        if (shown !== this.waitOverlay.visible) {
            this.waitOverlay.visible = shown;
            this.placeAround();
            this.updateLayers();
        }
    }

    toast(text: string, error = false): void {
        if (this.ended) {
            return;
        }
        drawXrToast(this.toastOverlay.canvas, text, error);
        this.toastOverlay.upload();
        this.toastUntil = performance.now() + XR_TOAST_MS;
        if (!this.toastOverlay.visible) {
            this.toastOverlay.visible = true;
            this.placeAround();
            this.updateLayers();
        }
    }

    protected placeAround(): void {
        const width = this.view.width;
        const half = screenHeight(width) / 2;
        const z = -XR_SCREEN_DISTANCE + 0.02;
        this.ui?.setScreen(width, screenHeight(width), -XR_SCREEN_DISTANCE);
        const bottom = this.ui?.shown ? Math.min(this.ui.bottom, -half) : -half;
        this.toastOverlay.place(0, bottom - XR_TOAST_GAP - this.toastOverlay.height / 2, z + 0.01);
        this.waitOverlay.place(0, 0, z + 0.01);
    }

    protected get overlays(): XrOverlay[] {
        return [
            ...this.ui?.overlays ?? [], this.waitOverlay, this.toastOverlay, this.panelOverlay, this.pointerOverlay,
        ];
    }

    protected get screenShown(): boolean {
        return !this.ui?.coversScreen;
    }

    protected drawPanel(): void {
        const shown = this.panel;
        if (shown) {
            this.panelRows = drawXrPanel(this.panelOverlay.canvas, shown.panel, shown.cursor);
            this.panelOverlay.upload();
        }
    }

    protected updateLayers(): void {
        const quad = this.quad;
        if (!quad || this.ended) {
            return;
        }
        // the interface's window behind the screen, the screen, the rest over it
        const underlays = (this.ui?.underlays ?? []).map(overlay => overlay.ensureLayer(quad.binding, this.space));
        const layers: (XrQuadLayer | XrProjectionLayer)[] = [...underlays, ...this.screenShown ? [quad.layer] : []];
        if (quad.cover && this.mode === 'ar' && this.backdropShown === 'black') {
            layers.unshift(quad.cover);
        }
        for (const overlay of this.overlays) {
            if (overlay.visible) {
                layers.push(overlay.ensureLayer(quad.binding, this.space));
            }
        }
        this.session.updateRenderState({ layers });
    }

    // a grip held and the sticks pushed: left resizes the screen, right changes the depth. Right or up is more, left or
    // down less; clicking a stick resets its own
    protected adjustView(
        reading: XrControllerReading,
        elapsed: number,
        time: number,
    ): void {
        const lean = (value: number) => Math.abs(value) < XR_ADJUST_DEAD_ZONE ? 0 : value;
        const before = this.view;
        // on the press, not for as long as it is held
        const resetWidth = reading.buttons.leftClick && !this.clicked.left;
        const resetDepth = reading.buttons.rightClick && !this.clicked.right;
        this.clicked = { left: reading.buttons.leftClick, right: reading.buttons.rightClick };
        // kept unrounded while it moves, or a slow push would never get past the rounding
        const depth = resetDepth
            ? XR_DEFAULT_SCREEN.depth
            : Math.min(200, Math.max(0,
                (this.depthInProgress ?? before.depth) + lean(reading.rightLean) * XR_DEPTH_RATE * elapsed));
        this.depthInProgress = depth;
        this.view = clampXrScreen({
            width: resetWidth
                ? XR_DEFAULT_SCREEN.width
                : before.width * Math.pow(XR_WIDTH_RATE, lean(reading.leftLean) * elapsed),
            depth,
        });
        if (this.view.width !== before.width) {
            this.applyScreenSize();
        }
        this.adjusting = true;
        if (this.view.depth !== before.depth
            && (resetDepth || time - this.viewReportedAt >= XR_ADJUST_REPORT_MS)) {
            this.viewReportedAt = time;
            this.host.onXrViewChanged?.({ ...this.view });
        }
    }

    protected clicked = { left: false, right: false };

    protected depthInProgress: number | undefined;

    protected applyScreenSize(): void {
        const width = this.view.width;
        this.placeAround();
        if (this.quad) {
            this.quad.layer.width = width * quadSizeFactor();
            this.quad.layer.height = screenHeight(width) * quadSizeFactor();
        } else if (this.projection) {
            this.gl.useProgram(this.projection.program);
            this.gl.uniform2f(this.projection.size, width, screenHeight(width));
        }
    }

    // both grips held for a second leave the headset. Kept by the session's own events rather than the controllers'
    // buttons, so a headset showing nothing still lets somebody out without the system menu
    protected readonly onSqueezeStart = (event: Event): void => {
        const hand = (event as Event & { inputSource?: XrInputSource }).inputSource?.handedness;
        if (hand !== 'left' && hand !== 'right') {
            return;
        }
        this.squeezing.add(hand);
        if (this.squeezing.size === 2 && this.exitTimer === undefined) {
            this.exitTimer = setTimeout(() => {
                this.exitTimer = undefined;
                this.end().catch(() => undefined);
            }, XR_EXIT_HOLD_MS);
        }
    };

    protected readonly onSqueezeEnd = (event: Event): void => {
        const hand = (event as Event & { inputSource?: XrInputSource }).inputSource?.handedness;
        if (hand) {
            this.squeezing.delete(hand);
        }
        if (this.exitTimer !== undefined) {
            clearTimeout(this.exitTimer);
            this.exitTimer = undefined;
        }
    };

    protected drawQuad(frame: XrFrame): void {
        const gl = this.gl;
        const quad = this.quad!;
        if (quad.cover && this.mode === 'ar' && this.backdropShown === 'black') {
            if (quad.coverIsSphere) {
                this.drawSphere(frame, quad);
            } else {
                this.drawCover(frame, quad.binding, quad.cover);
            }
        }
        if (this.screenShown) {
            this.drawScreenQuad(frame, quad);
        }
        const overlays = [...this.ui?.underlays ?? [], ...this.overlays].filter(overlay => overlay.visible && overlay.layer);
        if (overlays.length > 0) {
            gl.useProgram(quad.overlayProgram);
            for (const overlay of overlays) {
                overlay.drawLayer(quad.binding, frame, this.layerFramebuffer, quad.overlayViewport);
            }
        }
    }

    protected drawScreenQuad(frame: XrFrame, quad: NonNullable<EmulatorXrSession['quad']>): void {
        const gl = this.gl;
        const regions = quadEyeRegions(
            quad.binding.getSubImage(quad.layer, frame, 'left'),
            quad.binding.getSubImage(quad.layer, frame, 'right'),
        );
        if (this.stats.xrFrames === 1) {
            this.stats.quadLayout = regions.description;
        }
        gl.useProgram(quad.program);
        gl.activeTexture(gl.TEXTURE0 + SCREEN_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, this.image);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFramebuffer);
        for (const [index, region] of regions.eyes.entries()) {
            if (!region) {
                continue;
            }
            const { x, y, width, height } = region.viewport;
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, region.texture, 0);
            if (this.stats.xrFrames === 1) {
                const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
                if (status !== gl.FRAMEBUFFER_COMPLETE) {
                    this.stats.error ??= `quad layer framebuffer incomplete: 0x${status.toString(16)}`;
                }
            }
            gl.viewport(x, y, width, height);
            gl.uniform4f(quad.viewport, x, y, width, height);
            gl.uniform1i(quad.eye, index);
            gl.uniform1i(quad.hologram, this.backdropShown === 'hologram' ? 1 : 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
    }

    // the black sphere is drawn once: it is static, and the compositor shows it from then on (again only if it asks)
    protected drawSphere(frame: XrFrame, quad: NonNullable<EmulatorXrSession['quad']>): void {
        const sphere = quad.cover as XrQuadLayer & { needsRedraw?: boolean };
        if (quad.coverDrawn && !sphere.needsRedraw) {
            return;
        }
        const gl = this.gl;
        const image = quad.binding.getSubImage(sphere, frame);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFramebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image.colorTexture, 0);
        gl.viewport(image.viewport.x, image.viewport.y, image.viewport.width, image.viewport.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        quad.coverDrawn = true;
    }

    protected drawCover(frame: XrFrame, binding: XrWebGlBinding, cover: XrProjectionLayer): void {
        const pose = frame.getViewerPose(this.space);
        if (!pose || !binding.getViewSubImage) {
            return;
        }
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFramebuffer);
        gl.clearColor(0, 0, 0, 1);
        for (const view of pose.views) {
            const image = binding.getViewSubImage(cover, view);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image.colorTexture, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    protected drawProjection(frame: XrFrame): void {
        const projection = this.projection!;
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, projection.layer.framebuffer);
        // with passthrough the room shows wherever nothing is drawn; a quad layer gets that for nothing, the eye
        // buffers by being clear
        gl.clearColor(0, 0, 0, this.backdropShown === 'black' ? 1 : 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        // after the clear, so a frame without a pose still shows the room
        const pose = frame.getViewerPose(this.space);
        if (!pose) {
            this.stats.posesMissing++;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return;
        }
        // in the order the quad layers would be: the interface's window, the screen, news, a menu over everything
        const drawOverlays = (overlays: XrOverlay[]): void => {
            if (overlays.length === 0) {
                return;
            }
            gl.useProgram(projection.overlayProgram);
            for (const view of pose.views) {
                const viewport = projection.layer.getViewport(view);
                if (!viewport) {
                    continue;
                }
                gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
                gl.uniformMatrix4fv(projection.overlayViewProjection, false,
                    multiply(view.projectionMatrix, view.transform.inverse.matrix));
                for (const overlay of overlays) {
                    overlay.drawProjection(projection.overlayCenter, projection.overlaySize, projection.overlayYaw);
                }
            }
            gl.activeTexture(gl.TEXTURE0 + SCREEN_UNIT);
        };
        drawOverlays(this.ui?.underlays ?? []);
        gl.useProgram(projection.program);
        gl.activeTexture(gl.TEXTURE0 + SCREEN_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, this.image);
        for (const view of this.screenShown ? pose.views : []) {
            const viewport = projection.layer.getViewport(view);
            if (!viewport) {
                continue;
            }
            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
            gl.uniformMatrix4fv(projection.viewProjection, false,
                multiply(view.projectionMatrix, view.transform.inverse.matrix));
            gl.uniform1f(projection.eye, view.eye === 'right' ? 1 : 0);
            gl.uniform1i(projection.hologram, this.backdropShown === 'hologram' ? 1 : 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        drawOverlays(this.overlays.filter(overlay => overlay.visible));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // something done in the headset, which the audio may have been waiting for
    protected readonly onGesture = (): void => {
        if (this.session.visibilityState === 'visible') {
            this.host.resumeAudio?.();
        }
    };

    protected readonly onEnd = (): void => {
        if (this.ended) {
            return;
        }
        this.ended = true;
        this.session.removeEventListener('end', this.onEnd);
        this.session.removeEventListener('select', this.onGesture);
        this.session.removeEventListener('squeeze', this.onGesture);
        this.session.removeEventListener('visibilitychange', this.onGesture);
        this.session.removeEventListener('squeezestart', this.onSqueezeStart);
        this.session.removeEventListener('squeezeend', this.onSqueezeEnd);
        if (this.exitTimer !== undefined) {
            clearTimeout(this.exitTimer);
            this.exitTimer = undefined;
        }
        if (this.frameHandle !== undefined) {
            this.session.cancelAnimationFrame(this.frameHandle);
            this.frameHandle = undefined;
        }
        // the page's own frames again, unless another session has taken over meanwhile (one resumed while this one,
        // left behind in the background, took its time to end)
        if (this.looping) {
            this.looping = false;
            EmulatorXrSession.looping--;
        }
        if (EmulatorXrSession.looping === 0) {
            this.host.input.setExternalFrames(false);
        }
        this.sim?.setVideoTap(undefined, this.tapOwner).catch(() => undefined);
        // a question still up is answered no; a menu, closed
        const shown = this.panel;
        this.panel = undefined;
        shown?.panel.onClose?.();
        const gl = this.gl;
        this.ui?.dispose();
        for (const overlay of [this.waitOverlay, this.toastOverlay, this.panelOverlay, this.pointerOverlay]) {
            overlay.dispose();
        }
        gl.deleteFramebuffer(this.imageFramebuffer);
        gl.deleteFramebuffer(this.layerFramebuffer);
        gl.deleteTexture(this.image);
        if (this.quad) {
            gl.deleteProgram(this.quad.program);
            gl.deleteProgram(this.quad.overlayProgram);
        }
        if (this.projection) {
            gl.deleteProgram(this.projection.program);
            gl.deleteProgram(this.projection.overlayProgram);
        }
        this.renderer.dispose();
        if (this.started) {
            this.host.onXrEnded(this.diagnostics);
        }
    };
}

// where a ray from inside a sphere around the player leaves it, `radius` meters out; the ray's direction need not be
// of unit length
function onSphere(ray: XrRay, radius: number): Point3 | undefined {
    const { origin: o, direction: d } = ray;
    const length = Math.hypot(d.x, d.y, d.z);
    if (length === 0) {
        return undefined;
    }
    const x = d.x / length;
    const y = d.y / length;
    const z = d.z / length;
    const b = o.x * x + o.y * y + o.z * z;
    const c = o.x * o.x + o.y * o.y + o.z * o.z - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) {
        return undefined;
    }
    const t = -b + Math.sqrt(discriminant);
    return t > 0 ? { x: o.x + t * x, y: o.y + t * y, z: o.z + t * z } : undefined;
}

function xrDisplayMode(mode: DisplayMode): DisplayMode {
    return buildDisplayMode(
        VbRenderingMode.SIDE_BY_SIDE, mode.palette, mode.anaglyph, false, mode.frameBlending);
}
