// the parts of WebXR and its Layers module used for headset play (see emulator-xr.ts). Declared here rather
// than taken from @types/webxr, so dependents need no such types; kept out of the package index likewise

export interface XrViewport {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface XrRigidTransform {
    readonly matrix: Float32Array;
    readonly inverse: XrRigidTransform;
}

export type XrEye = 'left' | 'right' | 'none';

export interface XrView {
    readonly eye: XrEye;
    readonly projectionMatrix: Float32Array;
    readonly transform: XrRigidTransform;
}

export interface XrSpace extends EventTarget { }

export interface XrFrame {
    getViewerPose(space: XrSpace): { readonly views: readonly XrView[] } | null;
    getPose?(space: XrSpace, baseSpace: XrSpace): { readonly transform: XrRigidTransform } | null;
}

export interface XrInputSource {
    readonly handedness: 'none' | 'left' | 'right';
    readonly gamepad?: Gamepad | null;
    // where the controller points from, along its -Z axis
    readonly targetRaySpace?: XrSpace;
}

export interface XrSession extends EventTarget {
    readonly enabledFeatures?: readonly string[];
    readonly supportedFrameRates?: Float32Array | null;
    readonly visibilityState: 'visible' | 'visible-blurred' | 'hidden';
    readonly inputSources: ArrayLike<XrInputSource>;
    updateTargetFrameRate?(rate: number): Promise<void>;
    updateRenderState(state: { baseLayer?: XrWebGlLayer; layers?: unknown[] }): void;
    requestReferenceSpace(type: string): Promise<XrSpace>;
    requestAnimationFrame(callback: (time: number, frame: XrFrame) => void): number;
    cancelAnimationFrame(handle: number): void;
    end(): Promise<void>;
}

export interface XrSystem {
    isSessionSupported(mode: string): Promise<boolean>;
    requestSession(mode: string, init?: { optionalFeatures?: string[] }): Promise<XrSession>;
    // the browser offers the session in its own interface (the Quest Browser: a button by the address), and it starts
    // when that is taken, no click on the page needed
    offerSession?(mode: string, init?: { optionalFeatures?: string[] }): Promise<XrSession>;
    // a PC headset (through Link or a streamer) can connect and disconnect
    addEventListener?(type: 'devicechange', listener: () => void): void;
    removeEventListener?(type: 'devicechange', listener: () => void): void;
}

export interface XrWebGlLayer {
    readonly framebuffer: WebGLFramebuffer | null;
    getViewport(view: XrView): XrViewport | null;
}

export interface XrSubImage {
    readonly colorTexture: WebGLTexture;
    readonly viewport: XrViewport;
    // size of the whole texture the viewport is part of
    readonly colorTextureWidth?: number;
    readonly colorTextureHeight?: number;
}

export interface XrQuadLayer {
    // writable: a quad layer can be resized and moved while shown
    width: number;
    height: number;
    transform: XrRigidTransform;
    // blend the layer by its texture's (premultiplied) alpha
    blendTextureSourceAlpha?: boolean;
}

export interface XrWebGlBinding {
    createQuadLayer(init: {
        space: XrSpace;
        viewPixelWidth: number;
        viewPixelHeight: number;
        layout: 'stereo-left-right' | 'mono';
        textureType: 'texture';
        isStatic: boolean;
        width: number;
        height: number;
        transform: XrRigidTransform;
    }): XrQuadLayer;
    getSubImage(layer: XrQuadLayer, frame: XrFrame, eye?: XrEye): XrSubImage;
    // layer over the whole view, drawn per eye; where the browser has them
    createProjectionLayer?(init: { textureType: 'texture'; scaleFactor?: number }): XrProjectionLayer;
    // a sphere around the player, which the compositor keeps in place itself, however late a frame is
    createEquirectLayer?(init: {
        space: XrSpace;
        viewPixelWidth: number;
        viewPixelHeight: number;
        layout: 'mono';
        textureType: 'texture';
        isStatic: boolean;
        radius: number;
        centralHorizontalAngle: number;
        upperVerticalAngle: number;
        lowerVerticalAngle: number;
    }): XrQuadLayer;
    getViewSubImage?(layer: XrProjectionLayer, view: XrView): XrSubImage;
}

// only its existence is used here
export interface XrProjectionLayer { }

export interface XrGlobals {
    XRWebGLLayer?: new (session: XrSession, gl: WebGL2RenderingContext) => XrWebGlLayer;
    XRWebGLBinding?: new (session: XrSession, gl: WebGL2RenderingContext) => XrWebGlBinding;
    XRRigidTransform?: new (position?: DOMPointInit, orientation?: DOMPointInit) => XrRigidTransform;
}

export function xrSystem(): XrSystem | undefined {
    return typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & { xr?: XrSystem }).xr;
}

export const xrGlobals = globalThis as unknown as XrGlobals;
