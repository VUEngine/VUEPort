// headset drawing (see `emulator-xr.ts`): the game picture composed by the ordinary renderer into a texture,
// plus overlays, each copied into its own quad layer or drawn into the eye buffers

import { DisplayMode, VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH } from '../common/vb-constants';
import { FrameKind } from '../common/vb-protocol';
import { VbRenderer } from '../worker/vb-renderer';
import {
    XrFrame,
    xrGlobals,
    XrQuadLayer,
    XrSpace,
    XrSubImage,
    XrViewport,
    XrWebGlBinding,
} from './emulator-xr-webxr';

// the Quest Browser shows a quad layer at twice the width and height it was given (measured against the same
// screen drawn into the eye buffers), so it is given half
export function quadSizeFactor(): number {
    return typeof navigator !== 'undefined' && /OculusBrowser/.test(navigator.userAgent) ? 0.5 : 1;
}

// the ordinary renderer drawing into a given framebuffer; its canvas is never shown. The base class assumes
// its program stays bound and its frames and mask stay on units 0, 1, 4 and 5, so everything else drawn in
// this context binds its own program and texture unit and puts unit 0 back afterwards
export class XrFrameRenderer extends VbRenderer {

    protected program: WebGLProgram | undefined;
    // only draw when asked to, a frame arriving merely uploads
    protected drawing = false;

    constructor(canvas: HTMLCanvasElement, mode: DisplayMode) {
        super(canvas, mode);
        this.program = this.gl.getParameter(this.gl.CURRENT_PROGRAM) as WebGLProgram;
    }

    get context(): WebGL2RenderingContext {
        return this.gl;
    }

    setDisplayMode(mode: DisplayMode): void {
        // undefined during the base constructor, which binds its own program
        if (this.program) {
            this.gl.useProgram(this.program);
        }
        super.setDisplayMode(mode);
    }

    present(pixels: Uint8Array, colorMode = false, kind: FrameKind = 'next'): void {
        this.gl.useProgram(this.program!);
        // the base class uploads into whatever is bound on unit 0, and making a layer may bind browser textures there
        this.bindFrames();
        super.present(pixels, colorMode, kind);
    }

    renderTo(framebuffer: WebGLFramebuffer): void {
        const gl = this.gl;
        gl.useProgram(this.program!);
        this.bindFrames();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, this.mode.width, this.mode.height);
        this.drawing = true;
        try {
            this.draw();
        } finally {
            this.drawing = false;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
    }

    protected draw(): void {
        if (this.drawing) {
            super.draw();
        }
    }
}

export const SCREEN_VERTEX_SHADER = `#version 300 es
// The screen as a strip of four corners, generated from the vertex id.
uniform mat4 uViewProjection;
uniform vec3 uCenter;
uniform vec2 uSize;
// Turned about the vertical axis through its center, in radians; 0 faces
// the player square on.
uniform float uYaw;
out vec2 vUv;
void main() {
    vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    vUv = corner;
    vec2 offset = (corner - 0.5) * uSize;
    vec3 turned = vec3(offset.x * cos(uYaw), offset.y, -offset.x * sin(uYaw));
    gl_Position = uViewProjection * vec4(uCenter + turned, 1.0);
}
`;

export const SCREEN_FRAGMENT_SHADER = `#version 300 es
precision highp float;
// Both eyes, side by side, as the renderer composed them.
uniform sampler2D uImage;
// 0 for the left eye's half, 1 for the right's.
uniform float uEye;
// 1 to make dark see-through: each pixel as opaque as it is bright, the way
// the console's LEDs only ever added light. Premultiplied, as a compositor
// takes it — the colour is already no brighter than its own alpha.
uniform int uHologram;
in vec2 vUv;
out vec4 fragColor;
const vec2 SIZE = vec2(${VB_SCREEN_WIDTH}.0, ${VB_SCREEN_HEIGHT}.0);
void main() {
    // Sharp bilinear: nearest within a pixel, blended across the one display
    // pixel its edge falls in. Nearest alone shimmers as the head moves;
    // bilinear alone blurs every edge.
    vec2 texel = vUv * SIZE;
    vec2 nearest = floor(texel + 0.5);
    vec2 width = max(fwidth(texel), vec2(1e-5));
    texel = nearest + clamp((texel - nearest) / width, -0.5, 0.5);
    // Kept off the outer half texel, so the left eye never blends in the
    // right eye's first column at the seam between them.
    texel = clamp(texel, vec2(0.5), SIZE - 0.5);
    vec2 uv = texel / SIZE;
    fragColor = texture(uImage, vec2((uv.x + uEye) * 0.5, uv.y));
    if (uHologram != 0) {
        fragColor.a = max(fragColor.r, max(fragColor.g, fragColor.b));
    }
}
`;

export const COPY_VERTEX_SHADER = `#version 300 es
// Fullscreen triangle; the viewport cuts it down to one eye's region.
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const COPY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
// Both eyes, side by side, as the renderer composed them.
uniform highp sampler2D uImage;
// The eye's region of the layer: x, y, width, height.
uniform vec4 uViewport;
// 0 for the left eye's half, 1 for the right's.
uniform int uEye;
// See the screen's own shader: dark see-through, for the hologram backdrop.
uniform int uHologram;
out vec4 fragColor;
const vec2 SIZE = vec2(${VB_SCREEN_WIDTH}.0, ${VB_SCREEN_HEIGHT}.0);
void main() {
    // Each layer texel takes exactly one source pixel: an enlargement by a
    // whole multiple, so every pixel stays square and sharp.
    vec2 at = floor((gl_FragCoord.xy - uViewport.xy) / uViewport.zw * SIZE);
    ivec2 source = ivec2(clamp(at, vec2(0.0), SIZE - 1.0));
    fragColor = texelFetch(uImage, source + ivec2(uEye * ${VB_SCREEN_WIDTH}, 0), 0);
    if (uHologram != 0) {
        fragColor.a = max(fragColor.r, max(fragColor.g, fragColor.b));
    }
}
`;

export const OVERLAY_COPY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
// A menu or a line of news, the size of the layer it is copied into.
uniform sampler2D uImage;
// The layer's region: x, y, width, height.
uniform vec4 uViewport;
out vec4 fragColor;
void main() {
    fragColor = texture(uImage, (gl_FragCoord.xy - uViewport.xy) / uViewport.zw);
}
`;

export const OVERLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
// A menu or a line of news, drawn into the eye buffers.
uniform sampler2D uImage;
in vec2 vUv;
out vec4 fragColor;
void main() {
    fragColor = texture(uImage, vUv);
}
`;

// throws with the exact compile or link error
export function buildProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
    const program = gl.createProgram();
    if (!program) {
        throw new Error('Could not create a headset shader program.');
    }
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) {
            throw new Error('Could not create a headset shader.');
        }
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(`Could not compile a headset shader: ${gl.getShaderInfoLog(shader)}`);
        }
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Could not link a headset shader: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
}

// column-major 4×4 product, `a` applied after `b`
export function multiply(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + row] * b[column * 4 + k];
            }
            out[column * 4 + row] = sum;
        }
    }
    return out;
}

// clear of the renderer's units 0, 1, 4 and 5
export const SCREEN_UNIT = 2;
export const OVERLAY_UNIT = 3;

export interface Point3 {
    x: number;
    y: number;
    z: number;
}

// what turning a quad about the vertical axis does to its two in-plane directions: x along its width, normal out of
// its face. Yaw 0 faces the player square on (normal +Z); negative turns the right edge toward the player
export function yawAxes(yaw: number): { x: Point3; normal: Point3 } {
    return {
        x: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) },
        normal: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) },
    };
}

// a quaternion for the same turn, as WebXR wants an orientation
function yawOrientation(yaw: number): DOMPointInit {
    return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

// where a ray meets a quad: the point in the session's space and in canvas pixels from the top left
export interface XrOverlayHit {
    point: Point3;
    x: number;
    y: number;
    distance: number;
}

// a menu, a line of news or a part of the page's interface in front of the game, drawn on a 2D canvas and uploaded
// when it changes. Shown in its own quad layer where the session has them, otherwise drawn into the eye buffers.
// Opaque unless made transparent, so neither path has to agree about blending
export class XrOverlay {

    readonly canvas = document.createElement('canvas');
    protected readonly texture: WebGLTexture;
    layer: XrQuadLayer | undefined;
    visible = false;
    protected center = { x: 0, y: 0, z: 0 };
    protected yaw = 0;

    constructor(
        protected readonly gl: WebGL2RenderingContext,
        readonly pixels: { width: number; height: number },
        // in meters
        public width: number,
        // see-through where nothing is drawn, for the badges standing over the room. Premultiplied, as a compositor
        // blends a layer
        readonly transparent = false,
    ) {
        const texture = gl.createTexture();
        if (!texture) {
            throw new Error('Could not allocate a headset overlay.');
        }
        this.texture = texture;
        gl.activeTexture(gl.TEXTURE0 + OVERLAY_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.activeTexture(gl.TEXTURE0);
    }

    get height(): number {
        return this.width * this.pixels.height / this.pixels.width;
    }

    get position(): Readonly<Point3> {
        return this.center;
    }

    get turn(): number {
        return this.yaw;
    }

    upload(): void {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + OVERLAY_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        // canvas top row first; the renderer's own uploads are not flipped, so the setting goes straight back
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, this.transparent);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.activeTexture(gl.TEXTURE0);
    }

    // in meters, its layer with it
    resize(width: number): void {
        this.width = width;
        if (this.layer) {
            this.layer.width = width * quadSizeFactor();
            this.layer.height = this.height * quadSizeFactor();
        }
    }

    place(x: number, y: number, z: number, yaw = 0): void {
        this.center = { x, y, z };
        this.yaw = yaw;
        const Transform = xrGlobals.XRRigidTransform;
        if (this.layer && Transform) {
            this.layer.transform = new Transform({ x, y, z }, yawOrientation(yaw));
        }
    }

    // see XrOverlayHit; only from the front, as nothing is ever behind the player
    hit(origin: Point3, direction: Point3): XrOverlayHit | undefined {
        const { x: across, normal } = yawAxes(this.yaw);
        const facing = direction.x * normal.x + direction.y * normal.y + direction.z * normal.z;
        if (facing > -1e-6) {
            return undefined;
        }
        const along = ((this.center.x - origin.x) * normal.x + (this.center.y - origin.y) * normal.y
            + (this.center.z - origin.z) * normal.z) / facing;
        if (along <= 0) {
            return undefined;
        }
        const point = {
            x: origin.x + along * direction.x,
            y: origin.y + along * direction.y,
            z: origin.z + along * direction.z,
        };
        const sideways = (point.x - this.center.x) * across.x + (point.z - this.center.z) * across.z;
        const u = sideways / this.width + 0.5;
        const v = 0.5 - (point.y - this.center.y) / this.height;
        if (u < 0 || u > 1 || v < 0 || v > 1) {
            return undefined;
        }
        return { point, x: u * this.pixels.width, y: v * this.pixels.height, distance: along };
    }

    ensureLayer(binding: XrWebGlBinding, space: XrSpace): XrQuadLayer {
        if (!this.layer) {
            const Transform = xrGlobals.XRRigidTransform!;
            this.layer = binding.createQuadLayer({
                space,
                viewPixelWidth: this.pixels.width,
                viewPixelHeight: this.pixels.height,
                layout: 'mono',
                textureType: 'texture',
                isStatic: false,
                width: this.width * quadSizeFactor(),
                height: this.height * quadSizeFactor(),
                transform: new Transform(this.center, yawOrientation(this.yaw)),
            });
            if (this.transparent) {
                this.layer.blendTextureSourceAlpha = true;
            }
        }
        return this.layer;
    }

    // with the copy program bound
    drawLayer(
        binding: XrWebGlBinding,
        frame: XrFrame,
        framebuffer: WebGLFramebuffer,
        viewport: WebGLUniformLocation | null,
    ): void {
        const gl = this.gl;
        const image = binding.getSubImage(this.layer!, frame);
        const { x, y, width, height } = image.viewport;
        gl.activeTexture(gl.TEXTURE0 + OVERLAY_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image.colorTexture, 0);
        gl.viewport(x, y, width, height);
        gl.uniform4f(viewport, x, y, width, height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
    }

    // into the bound eye buffer, with the overlay program bound and the view set
    drawProjection(
        center: WebGLUniformLocation | null,
        size: WebGLUniformLocation | null,
        yaw: WebGLUniformLocation | null,
    ): void {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + OVERLAY_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform3f(center, this.center.x, this.center.y, this.center.z);
        gl.uniform2f(size, this.width, this.height);
        gl.uniform1f(yaw, this.yaw);
        if (this.transparent) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0);
    }

    // its layer too, where the browser can let go of one before the session ends
    dispose(): void {
        this.gl.deleteTexture(this.texture);
        (this.layer as (XrQuadLayer & { destroy?(): void }) | undefined)?.destroy?.();
        this.layer = undefined;
    }
}

export interface QuadEyeRegion {
    texture: WebGLTexture;
    viewport: XrViewport;
}

function describeViewport(viewport: XrViewport): string {
    return `${viewport.x},${viewport.y} ${viewport.width}×${viewport.height}`;
}

// per the Layers module each eye gets its own half of one texture, but a Quest gives both eyes the left
// half, which would draw the right eye over the left and leave the right black. So when both eyes get the
// same part of a texture wide enough for two, the halves are worked out here; per-eye textures are taken as is
export function quadEyeRegions(
    left: XrSubImage,
    right: XrSubImage,
): { eyes: [QuadEyeRegion | undefined, QuadEyeRegion | undefined]; description: string } {
    const size = left.colorTextureWidth !== undefined
        ? `texture ${left.colorTextureWidth}×${left.colorTextureHeight}`
        : 'texture size unknown';
    const said = `left ${describeViewport(left.viewport)}, right ${describeViewport(right.viewport)}, ${size}`;
    if (left.colorTexture !== right.colorTexture) {
        return {
            eyes: [
                { texture: left.colorTexture, viewport: left.viewport },
                { texture: right.colorTexture, viewport: right.viewport },
            ],
            description: `${said}, one texture per eye`,
        };
    }
    const same = left.viewport.x === right.viewport.x && left.viewport.y === right.viewport.y
        && left.viewport.width === right.viewport.width && left.viewport.height === right.viewport.height;
    if (!same) {
        return {
            eyes: [
                { texture: left.colorTexture, viewport: left.viewport },
                { texture: right.colorTexture, viewport: right.viewport },
            ],
            description: `${said}, as given`,
        };
    }
    const width = left.colorTextureWidth;
    const height = left.colorTextureHeight ?? left.viewport.height;
    if (width !== undefined && width >= left.viewport.width * 2) {
        const half = Math.floor(width / 2);
        return {
            eyes: [
                { texture: left.colorTexture, viewport: { x: 0, y: 0, width: half, height } },
                { texture: left.colorTexture, viewport: { x: half, y: 0, width: half, height } },
            ],
            description: `${said}, halved here`,
        };
    }
    // nowhere to put the right eye, the left alone beats one over the other
    return {
        eyes: [{ texture: left.colorTexture, viewport: left.viewport }, undefined],
        description: `${said}, left eye only`,
    };
}
