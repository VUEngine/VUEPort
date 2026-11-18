/**
 * Presentation for one simulation. Legacy VB frames use one eye-packed texture (red the left eye's brightness, green
 * the right's); a VBC-capable core supplies RGB888 at twice the screen's width, left eye in the left half, right eye in
 * the right. The frame textures are that double width, and a legacy frame fills their left half. Every display mode is
 * derived from the transport in the fragment shader, so switching layouts never touches emulation.
 *
 * Frame blending mixes a frame half and half with the one before, as the eye integrates the flickering display, so
 * things drawn on alternate frames (transparency, sprite multiplexing) come out steady. `full` mixes every pixel and
 * trails what moves; `smart` mixes only where a pixel goes A, B, A in this frame or the one before, so movement stays
 * sharp. That test runs once per frame at console resolution into a mask (RAW_SHADER, BLOCK_SHADER, MASK_SHADER). The
 * frames are four textures taking turns on every present, so none is ever copied.
 *
 * Normally runs on the worker's OffscreenCanvas; Linux Tauri uses an HTMLCanvasElement, as WebKitGTK exposes WebGL2 on
 * the page but not inside a worker.
 */

import {
    DisplayMode,
    DisplayOutput,
    eyesSwapped,
    FrameBlending,
    isInterleavedLayout,
    VbEyes,
    VbStereoLayout,
    VB_LEVEL_STOPS,
    VB_LEVELS,
    VB_SCREEN_HEIGHT,
    VB_SCREEN_WIDTH,
    VBC_FRAME_WIDTH,
} from '../common/vb-constants';
import { encodeIndexedPng } from '../common/emulator-png';
import { FrameKind } from '../common/vb-protocol';
import { duboisMatrices } from './vb-anaglyph';

// the values of the picture shader's uBlend
const BLEND_FULL = 1;
const BLEND_MASKED = 2;

// how far, in console pixels, flicker reaches into the pixels around it (see MASK_SHADER). Two covers a flickering
// sprite that moves up to two pixels between the frames it is drawn on
const MASK_REACH = 2;

// the cells flicker is also counted in, in console pixels a side, and how many of a cell's pixels must flicker for it
// and its neighbours to blend (see BLOCK_SHADER)
const MASK_BLOCK = 8;
const MASK_BLOCK_SHARE = (MASK_BLOCK * MASK_BLOCK) / 2;
const MASK_BLOCKS_X = VB_SCREEN_WIDTH / MASK_BLOCK;
const MASK_BLOCKS_Y = VB_SCREEN_HEIGHT / MASK_BLOCK;

// texture units, away from 2 and 3, which the headset's renderer keeps for its own (see emulator-xr-render.ts)
const UNIT_FRAME = 0;
const UNIT_PREVIOUS = 1;
const UNIT_EARLIER = 4;
const UNIT_MASK = 5;
const UNIT_EARLIEST = 6;
const UNIT_RAW_MASK = 7;
const UNIT_BLOCK_MASK = 8;

const VERTEX_SHADER = `#version 300 es
// Fullscreen triangle, generated from the vertex id so no buffers are needed.
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uFrame;
// The frame presented before uFrame, for blending.
uniform sampler2D uPrevious;
// Where the picture flickers, per source pixel: red for the left eye's
// picture, green for the right's. See MASK_SHADER.
uniform sampler2D uMask;
// 0 to show uFrame alone, ${BLEND_FULL} to blend it with uPrevious everywhere,
// ${BLEND_MASKED} only where uMask says. Only ever asked for when there is
// what it needs: a previous frame, and for the mask the one before that.
uniform int uBlend;
uniform int uPreviousColorMode;
// The palette's color for each brightness level. Legacy frames use it wherever
// a pixel shows one eye on its own; Anaglyph filters neutral gray instead.
uniform vec3 uPalette[${VB_LEVELS}];
// The anaglyph tints, used where both eyes share a pixel.
uniform vec3 uAnaglyphLeft;
uniform vec3 uAnaglyphRight;
uniform mat3 uAnaglyphMatrixLeft;
uniform mat3 uAnaglyphMatrixRight;
uniform int uDubois;
uniform vec2 uOutput;
uniform int uLayout;
uniform int uEyes;
uniform int uColorMode;
// Interleaved layouts only: 1 when the first line or column is the right eye's.
uniform int uParity;
// 1 to show each eye's picture where the other's would go, see DisplayMode.swapEyes.
uniform int uSwapEyes;

out vec4 fragColor;

const vec2 SOURCE = vec2(${VB_SCREEN_WIDTH}.0, ${VB_SCREEN_HEIGHT}.0);
const float CYBERSCOPE_HALF = 256.0;
// The eye value that stands for "both eyes at this pixel", i.e. VbEyes.BOTH.
const float ANAGLYPH = ${VbEyes.BOTH}.0;
// Brightnesses the four palette colors are anchored at, see VB_LEVEL_STOPS.
const float STOP1 = ${VB_LEVEL_STOPS[1].toFixed(6)};
const float STOP2 = ${VB_LEVEL_STOPS[2].toFixed(6)};
const float STOP3 = ${VB_LEVEL_STOPS[3].toFixed(6)};

/**
 * The palette color a brightness stands for. Exactly a palette entry at the
 * stops, interpolated in between, and held at the brightest entry above them.
 */
vec3 shade(float brightness) {
    if (brightness <= STOP1) {
        return mix(uPalette[0], uPalette[1], brightness / STOP1);
    }
    if (brightness <= STOP2) {
        return mix(uPalette[1], uPalette[2], (brightness - STOP1) / (STOP2 - STOP1));
    }
    return mix(uPalette[2], uPalette[3], min((brightness - STOP2) / (STOP3 - STOP2), 1.0));
}

vec3 toLinear(vec3 color) {
    return mix(pow((color + 0.055) / 1.055, vec3(2.4)), color / 12.92,
        lessThanEqual(color, vec3(0.04045)));
}

vec3 toSrgb(vec3 color) {
    return mix(1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055, color * 12.92,
        lessThanEqual(color, vec3(0.0031308)));
}

/**
 * The color at a pixel of the given eye, from the texel of the left half of
 * the frame (legacy: both eyes' brightness; VBC: the left eye's RGB888) and
 * the texel at the same place in the right half (VBC: the right eye's RGB888).
 */
vec3 resolve(vec4 texel, vec4 texelRight, float eye, int colorMode) {
    // First resolve each eye to its real display color. VBC pixels keep their
    // RGB888 values, so Anaglyph is a color-anaglyph of the same eye images
    // the other modes would show. Legacy pixels acquire their selected
    // four-color ramp, except in Anaglyph: there the filters are the colors,
    // and a tinted ramp would starve every channel it lacks (the default red
    // ramp leaves a blue filter almost nothing to pass), so each eye enters
    // as neutral gray at its brightness.
    vec3 leftColor;
    vec3 rightColor;
    if (colorMode != 0) {
        leftColor = texel.rgb;
        rightColor = texelRight.rgb;
    } else if (eye >= ANAGLYPH) {
        leftColor = vec3(texel.r);
        rightColor = vec3(texel.g);
    } else {
        leftColor = shade(texel.r);
        rightColor = shade(texel.g);
    }
    if (uSwapEyes != 0) {
        vec3 swapped = leftColor;
        leftColor = rightColor;
        rightColor = swapped;
    }

    vec3 color;
    if (eye >= ANAGLYPH) {
        if (uDubois != 0) {
            // Preserve negative cross-talk compensation until AFTER adding
            // both eyes, then clip to the display gamut and encode once.
            vec3 linear = uAnaglyphMatrixLeft * toLinear(leftColor)
                + uAnaglyphMatrixRight * toLinear(rightColor);
            color = toSrgb(clamp(linear, 0.0, 1.0));
        } else {
            // Uncalibrated/custom filters keep their existing channel masks.
            color = uAnaglyphLeft * leftColor + uAnaglyphRight * rightColor;
        }
    } else {
        color = eye < 0.5 ? leftColor : rightColor;
    }

    return min(color, vec3(1.0));
}

void main() {
    // Integer pixel coordinates with the origin at the top left, matching the
    // row order the core writes its framebuffer in.
    float px = floor(gl_FragCoord.x);
    float py = floor(uOutput.y - gl_FragCoord.y);

    vec2 src;
    // Which eye this pixel belongs to: 0 the left one, 1 the right one. The
    // split layouts derive it from the position, the overlay from the mode.
    float eye;

    if (uLayout == ${VbStereoLayout.OVERLAY}) {
        src = vec2(px, py);
        eye = float(uEyes);
    } else if (uLayout == ${VbStereoLayout.SIDE_BY_SIDE}) {
        eye = step(SOURCE.x, px);
        src = vec2(px - eye * SOURCE.x, py);
    } else if (uLayout == ${VbStereoLayout.CYBERSCOPE}) {
        eye = step(CYBERSCOPE_HALF, px);
        src = vec2((px - eye * CYBERSCOPE_HALF) * (SOURCE.x / CYBERSCOPE_HALF), py);
    } else {
        // Interleaved. Drawn at whatever size the picture is shown — see
        // DisplayOutput — so the source is found by proportion rather than by
        // halving, and the eye from the output line itself.
        float line = uLayout == ${VbStereoLayout.HLI} ? py : px;
        eye = mod(line + float(uParity), 2.0);
        src = floor(vec2(px, py) * SOURCE / uOutput);
    }

    // The frame textures are twice the screen's width: the picture (or the
    // left eye's) in the left half, the right eye's picture in the right.
    vec2 at = (floor(src) + 0.5) / SOURCE;
    vec2 atLeft = vec2(at.x * 0.5, at.y);
    vec2 atRight = vec2(at.x * 0.5 + 0.5, at.y);
    vec3 color = resolve(texture(uFrame, atLeft), texture(uFrame, atRight), eye, uColorMode);
    float blend = uBlend == ${BLEND_FULL} ? 1.0 : 0.0;
    if (uBlend == ${BLEND_MASKED}) {
        vec2 flicker = texelFetch(uMask, ivec2(src), 0).rg;
        // The mask is by the eye a picture came from; swapped, each eye's
        // pixels show the other's.
        if (uSwapEyes != 0) {
            flicker = flicker.gr;
        }
        blend = eye >= ANAGLYPH ? max(flicker.r, flicker.g) : eye < 0.5 ? flicker.r : flicker.g;
    }
    if (blend > 0.0) {
        // Half and half in linear light, which is how the eye averages two
        // flashes of light: mixing the encoded values instead would make
        // every blended edge darker than either frame.
        vec3 previous = resolve(texture(uPrevious, atLeft), texture(uPrevious, atRight), eye, uPreviousColorMode);
        color = toSrgb(mix(toLinear(color), toLinear(previous), 0.5 * blend));
    }

    fragColor = vec4(color, 1.0);
}
`;

/**
 * Where the picture flickers pixel by pixel; the first of the three mask passes (then BLOCK_SHADER, MASK_SHADER), all
 * at console resolution. A pixel flickers when it goes A, B, A, so moving things, fades and still pictures stay sharp.
 * The test is exact, as the core writes the same bytes for the same picture. It also runs for the frame before: a
 * layer drawn on alternate frames over a scrolling picture (fog in front of a moving room) passes only on the frames
 * with the layer, and testing those alone would blend every other frame, in patches wherever the room underneath
 * repeated.
 */
const RAW_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uFrame;
uniform sampler2D uPrevious;
uniform sampler2D uEarlier;
uniform sampler2D uEarliest;
// The frames' transport, which the renderer only asks for a mask when they
// share.
uniform int uColorMode;
// 1 when uEarliest holds a frame to test the frame before with.
uniform int uHasEarliest;

out vec4 fragColor;

// Less than one step of an 8-bit channel: equal, or not.
const float SAME = 0.5 / 255.0;

float peak(vec3 v) {
    return max(v.r, max(v.g, v.b));
}

/** Per eye, 1 where the texel goes A, B, A over the three frames, the latest first. */
vec2 alternates(sampler2D frame, sampler2D previous, sampler2D earlier, ivec2 at) {
    vec4 now = texelFetch(frame, at, 0);
    vec4 back = abs(now - texelFetch(earlier, at, 0));
    vec4 change = abs(now - texelFetch(previous, at, 0));
    // Legacy frames carry each eye's brightness in red and green of the left
    // half; VBC frames the left eye's RGB888 in the left half and the right
    // eye's in the right half.
    ivec2 atRight = at + ivec2(${VB_SCREEN_WIDTH}, 0);
    vec4 nowRight = texelFetch(frame, atRight, 0);
    vec3 backRight = abs(nowRight - texelFetch(earlier, atRight, 0)).rgb;
    vec3 changeRight = abs(nowRight - texelFetch(previous, atRight, 0)).rgb;
    vec2 backByEye = uColorMode != 0 ? vec2(peak(back.rgb), peak(backRight)) : back.rg;
    vec2 changeByEye = uColorMode != 0 ? vec2(peak(change.rgb), peak(changeRight)) : change.rg;
    return vec2(lessThan(backByEye, vec2(SAME))) * vec2(greaterThan(changeByEye, vec2(SAME)));
}

void main() {
    // The masks are laid out row for row like the frames, so no flip here.
    ivec2 at = ivec2(gl_FragCoord.xy);
    vec2 flicker = alternates(uFrame, uPrevious, uEarlier, at);
    if (uHasEarliest != 0) {
        flicker = max(flicker, alternates(uPrevious, uEarlier, uEarliest, at));
    }
    fragColor = vec4(flicker, 0.0, 1.0);
}
`;

/**
 * Where most of a cell of MASK_BLOCK pixels a side flickers, per eye, one texel per cell. A layer drawn on alternate
 * frames that scrolls with the room travels further than MASK_REACH covers, or differs from one drawing to the next,
 * and fails RAW_SHADER's test; a mostly flickering cell is taken for such a layer and blended whole with its
 * neighbours. Chance hits in a moving picture are too sparse to fill a cell.
 */
const BLOCK_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uRaw;

out vec4 fragColor;

const int BLOCK = ${MASK_BLOCK};
const float SHARE = ${MASK_BLOCK_SHARE}.0;

void main() {
    ivec2 first = ivec2(gl_FragCoord.xy) * BLOCK;
    vec2 count = vec2(0.0);
    for (int y = 0; y < BLOCK; y++) {
        for (int x = 0; x < BLOCK; x++) {
            count += texelFetch(uRaw, first + ivec2(x, y), 0).rg;
        }
    }
    fragColor = vec4(step(vec2(SHARE), count), 0.0, 1.0);
}
`;

// RAW_SHADER's pixels widened by MASK_REACH, plus BLOCK_SHADER's cells with their neighbors. A moving flickering
// sprite is A, B, A only where it overlaps itself, its leading edge is new every frame. Blending a steady pixel
// changes nothing, so the margin costs nothing
const MASK_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uRaw;
uniform sampler2D uBlocks;

out vec4 fragColor;

const int REACH = ${MASK_REACH};
const int BLOCK = ${MASK_BLOCK};
const ivec2 LAST = ivec2(${VB_SCREEN_WIDTH - 1}, ${VB_SCREEN_HEIGHT - 1});
const ivec2 LAST_BLOCK = ivec2(${MASK_BLOCKS_X - 1}, ${MASK_BLOCKS_Y - 1});

void main() {
    ivec2 at = ivec2(gl_FragCoord.xy);
    vec2 flicker = vec2(0.0);
    for (int y = -REACH; y <= REACH; y++) {
        for (int x = -REACH; x <= REACH; x++) {
            flicker = max(flicker, texelFetch(uRaw, clamp(at + ivec2(x, y), ivec2(0), LAST), 0).rg);
        }
    }
    ivec2 block = at / BLOCK;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            flicker = max(flicker,
                texelFetch(uBlocks, clamp(block + ivec2(x, y), ivec2(0), LAST_BLOCK), 0).rg);
        }
    }
    fragColor = vec4(flicker, 0.0, 1.0);
}
`;

function toRgb(color: number): [number, number, number] {
    return [
        ((color >> 16) & 0xff) / 255,
        ((color >> 8) & 0xff) / 255,
        (color & 0xff) / 255,
    ];
}

export class VbRenderer {

    protected readonly gl: WebGL2RenderingContext;
    // the frame on show and the three before it, taking turns on every present: the next frame is uploaded over the
    // oldest, so none is copied
    protected current: WebGLTexture;
    protected previous: WebGLTexture;
    protected earlier: WebGLTexture;
    protected earliest: WebGLTexture;
    // the flicker mask and its framebuffer (see MASK_SHADER), drawn from the flickering pixels and the mostly
    // flickering cells, each with a framebuffer of its own (RAW_SHADER, BLOCK_SHADER)
    protected readonly mask: WebGLTexture;
    protected readonly maskFramebuffer: WebGLFramebuffer;
    protected readonly rawMask: WebGLTexture;
    protected readonly rawMaskFramebuffer: WebGLFramebuffer;
    protected readonly blockMask: WebGLTexture;
    protected readonly blockMaskFramebuffer: WebGLFramebuffer;
    protected readonly drawProgram: WebGLProgram;
    protected readonly rawMaskProgram: WebGLProgram;
    protected readonly blockMaskProgram: WebGLProgram;
    protected readonly maskProgram: WebGLProgram;
    protected readonly maskColorMode: WebGLUniformLocation | null;
    protected readonly maskHasEarliest: WebGLUniformLocation | null;
    protected maskStale = true;
    protected blend = 0;
    protected readonly uniforms: {
        palette: WebGLUniformLocation | null;
        anaglyphLeft: WebGLUniformLocation | null;
        anaglyphRight: WebGLUniformLocation | null;
        anaglyphMatrixLeft: WebGLUniformLocation | null;
        anaglyphMatrixRight: WebGLUniformLocation | null;
        dubois: WebGLUniformLocation | null;
        output: WebGLUniformLocation | null;
        layout: WebGLUniformLocation | null;
        eyes: WebGLUniformLocation | null;
        colorMode: WebGLUniformLocation | null;
        parity: WebGLUniformLocation | null;
        swapEyes: WebGLUniformLocation | null;
        blend: WebGLUniformLocation | null;
        previousColorMode: WebGLUniformLocation | null;
    };

    protected mode: DisplayMode; // kept for the size it implies
    protected output: DisplayOutput | undefined; // where an interleaved picture is really shown, when the page has said

    protected hasFrame = false; // whether the texture contains a frame that a mode change can redraw
    protected lastColorMode = false;
    protected hasPrevious = false;
    protected previousColorMode = false;
    protected hasEarlier = false;
    protected earlierColorMode = false;
    protected hasEarliest = false;
    protected earliestColorMode = false;

    constructor(
        protected readonly canvas: OffscreenCanvas | HTMLCanvasElement,
        mode: DisplayMode,
    ) {
        // screenshots read the drawing buffer back afterwards, which is only reliable when it is preserved. The cast is
        // because this DOM library types OffscreenCanvas#getContext as the whole OffscreenRenderingContext union
        const gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            preserveDrawingBuffer: true,
            stencil: false,
        }) as WebGL2RenderingContext | null;
        if (!gl) {
            throw new Error('Could not acquire a WebGL2 context for the emulator canvas.');
        }
        this.gl = gl;

        const program = this.buildProgram(FRAGMENT_SHADER);
        this.drawProgram = program;
        this.rawMaskProgram = this.buildProgram(RAW_SHADER);
        gl.useProgram(this.rawMaskProgram);
        gl.uniform1i(gl.getUniformLocation(this.rawMaskProgram, 'uFrame'), UNIT_FRAME);
        gl.uniform1i(gl.getUniformLocation(this.rawMaskProgram, 'uPrevious'), UNIT_PREVIOUS);
        gl.uniform1i(gl.getUniformLocation(this.rawMaskProgram, 'uEarlier'), UNIT_EARLIER);
        gl.uniform1i(gl.getUniformLocation(this.rawMaskProgram, 'uEarliest'), UNIT_EARLIEST);
        this.maskColorMode = gl.getUniformLocation(this.rawMaskProgram, 'uColorMode');
        this.maskHasEarliest = gl.getUniformLocation(this.rawMaskProgram, 'uHasEarliest');
        this.blockMaskProgram = this.buildProgram(BLOCK_SHADER);
        gl.useProgram(this.blockMaskProgram);
        gl.uniform1i(gl.getUniformLocation(this.blockMaskProgram, 'uRaw'), UNIT_RAW_MASK);
        this.maskProgram = this.buildProgram(MASK_SHADER);
        gl.useProgram(this.maskProgram);
        gl.uniform1i(gl.getUniformLocation(this.maskProgram, 'uRaw'), UNIT_RAW_MASK);
        gl.uniform1i(gl.getUniformLocation(this.maskProgram, 'uBlocks'), UNIT_BLOCK_MASK);
        gl.useProgram(program);

        this.uniforms = {
            // an array uniform is set through the location of its first element
            palette: gl.getUniformLocation(program, 'uPalette[0]'),
            anaglyphLeft: gl.getUniformLocation(program, 'uAnaglyphLeft'),
            anaglyphRight: gl.getUniformLocation(program, 'uAnaglyphRight'),
            anaglyphMatrixLeft: gl.getUniformLocation(program, 'uAnaglyphMatrixLeft'),
            anaglyphMatrixRight: gl.getUniformLocation(program, 'uAnaglyphMatrixRight'),
            dubois: gl.getUniformLocation(program, 'uDubois'),
            output: gl.getUniformLocation(program, 'uOutput'),
            layout: gl.getUniformLocation(program, 'uLayout'),
            eyes: gl.getUniformLocation(program, 'uEyes'),
            colorMode: gl.getUniformLocation(program, 'uColorMode'),
            parity: gl.getUniformLocation(program, 'uParity'),
            swapEyes: gl.getUniformLocation(program, 'uSwapEyes'),
            blend: gl.getUniformLocation(program, 'uBlend'),
            previousColorMode: gl.getUniformLocation(program, 'uPreviousColorMode'),
        };

        this.current = this.createFrameTexture();
        this.previous = this.createFrameTexture();
        this.earlier = this.createFrameTexture();
        this.earliest = this.createFrameTexture();
        this.mask = this.createFrameTexture();
        this.maskFramebuffer = this.createTarget(this.mask);
        this.rawMask = this.createFrameTexture();
        this.rawMaskFramebuffer = this.createTarget(this.rawMask);
        this.blockMask = this.createFrameTexture(MASK_BLOCKS_X, MASK_BLOCKS_Y);
        this.blockMaskFramebuffer = this.createTarget(this.blockMask);
        gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), UNIT_FRAME);
        gl.uniform1i(gl.getUniformLocation(program, 'uPrevious'), UNIT_PREVIOUS);
        gl.uniform1i(gl.getUniformLocation(program, 'uMask'), UNIT_MASK);
        this.bindFrames();

        this.mode = mode;
        this.setDisplayMode(mode);
    }

    // a frame texture, or with a size a smaller one: the flicker mask's cells
    protected createFrameTexture(width = VBC_FRAME_WIDTH, height = VB_SCREEN_HEIGHT): WebGLTexture {
        const gl = this.gl;
        const texture = gl.createTexture();
        if (!texture) {
            throw new Error('Could not allocate the emulator frame texture.');
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // presented at integer scales; anything but nearest filtering would blur a display with no in-between pixels
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // twice the screen's width: room for the VBC transport's two eye pictures; a legacy frame occupies the left
        // half
        gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null
        );
        return texture;
    }

    protected createTarget(texture: WebGLTexture): WebGLFramebuffer {
        const gl = this.gl;
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) {
            throw new Error('Could not allocate the emulator flicker mask.');
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return framebuffer;
    }

    // ends on the frame on show at unit 0, the one a present uploads into
    protected bindFrames(): void {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + UNIT_MASK);
        gl.bindTexture(gl.TEXTURE_2D, this.mask);
        gl.activeTexture(gl.TEXTURE0 + UNIT_RAW_MASK);
        gl.bindTexture(gl.TEXTURE_2D, this.rawMask);
        gl.activeTexture(gl.TEXTURE0 + UNIT_BLOCK_MASK);
        gl.bindTexture(gl.TEXTURE_2D, this.blockMask);
        gl.activeTexture(gl.TEXTURE0 + UNIT_EARLIEST);
        gl.bindTexture(gl.TEXTURE_2D, this.earliest);
        gl.activeTexture(gl.TEXTURE0 + UNIT_EARLIER);
        gl.bindTexture(gl.TEXTURE_2D, this.earlier);
        gl.activeTexture(gl.TEXTURE0 + UNIT_PREVIOUS);
        gl.bindTexture(gl.TEXTURE_2D, this.previous);
        gl.activeTexture(gl.TEXTURE0 + UNIT_FRAME);
        gl.bindTexture(gl.TEXTURE_2D, this.current);
    }

    // only when asked and there is a frame before (for `smart` one more) in the same transport, as a legacy frame and a
    // VBC one cannot be compared byte for byte
    protected applyBlend(): void {
        const gl = this.gl;
        const blending = this.mode.frameBlending;
        const comparable = this.hasEarlier
            && this.earlierColorMode === this.previousColorMode
            && this.previousColorMode === this.lastColorMode;
        this.blend = blending === FrameBlending.FULL && this.hasPrevious ? BLEND_FULL
            : blending === FrameBlending.SMART && comparable ? BLEND_MASKED
                : 0;
        gl.uniform1i(this.uniforms.blend, this.blend);
        gl.uniform1i(this.uniforms.previousColorMode, this.previousColorMode ? 1 : 0);
    }

    // the three mask passes, leaving program, framebuffer and viewport as found: the headset draws through its own
    // framebuffer
    protected updateMask(): void {
        const gl = this.gl;
        const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
        // the frame before is tested only when the one before that is there, in the same transport
        const earliest = this.hasEarliest && this.earliestColorMode === this.lastColorMode;
        gl.useProgram(this.rawMaskProgram);
        gl.uniform1i(this.maskColorMode, this.lastColorMode ? 1 : 0);
        gl.uniform1i(this.maskHasEarliest, earliest ? 1 : 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.rawMaskFramebuffer);
        gl.viewport(0, 0, VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.useProgram(this.blockMaskProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.blockMaskFramebuffer);
        gl.viewport(0, 0, MASK_BLOCKS_X, MASK_BLOCKS_Y);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.useProgram(this.maskProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFramebuffer);
        gl.viewport(0, 0, VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
        gl.useProgram(this.drawProgram);
        this.maskStale = false;
    }

    get displayMode(): DisplayMode {
        return this.mode;
    }

    // whether a capture of the drawing buffer is the picture as a file wants it; not for an interleaved mode drawn at
    // the size it is shown, which is captured by composing the frame again (see the callers of capture)
    get atModeSize(): boolean {
        return this.canvas.width === this.mode.width && this.canvas.height === this.mode.height;
    }

    // draws an interleaved picture at the size it is shown at, or at the mode's own size with undefined. Kept across
    // mode changes, ignored by modes that do not interleave
    setDisplayOutput(output: DisplayOutput | undefined): void {
        this.output = output;
        this.applySize();
        if (this.hasFrame) {
            this.draw();
        }
    }

    // sizes the drawing buffer, and tells the shader what it was sized to
    protected applySize(): void {
        const gl = this.gl;
        const interleaved = isInterleavedLayout(this.mode.layout);
        const output = interleaved && this.output && this.output.width > 0 && this.output.height > 0
            ? this.output
            : undefined;
        const width = output?.width ?? this.mode.width;
        const height = output?.height ?? this.mode.height;
        // only on change: assigning the size clears the drawing buffer even when it is the same, and the page resizes
        // often
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        gl.uniform2f(this.uniforms.output, width, height);
        gl.uniform1i(this.uniforms.parity, interleaved ? (output?.parity ?? 0) % 2 : 0);
    }

    setDisplayMode(mode: DisplayMode): void {
        const gl = this.gl;
        this.mode = mode;
        this.applySize();

        gl.uniform3fv(this.uniforms.palette, mode.palette.flatMap(toRgb));
        gl.uniform3fv(this.uniforms.anaglyphLeft, toRgb(mode.anaglyph.left));
        gl.uniform3fv(this.uniforms.anaglyphRight, toRgb(mode.anaglyph.right));
        const matrices = duboisMatrices(mode.anaglyph);
        gl.uniform1i(this.uniforms.dubois, matrices ? 1 : 0);
        if (matrices) {
            gl.uniformMatrix3fv(this.uniforms.anaglyphMatrixLeft, false, matrices.left);
            gl.uniformMatrix3fv(this.uniforms.anaglyphMatrixRight, false, matrices.right);
        }
        gl.uniform1i(this.uniforms.layout, mode.layout);
        gl.uniform1i(this.uniforms.eyes, mode.eyes);
        gl.uniform1i(this.uniforms.swapEyes, eyesSwapped(mode) ? 1 : 0);
        gl.uniform1i(this.uniforms.colorMode, this.lastColorMode ? 1 : 0);
        this.applyBlend();

        if (this.hasFrame) {
            this.draw();
        }
    }

    present(pixels: Uint8Array, colorMode = false, kind: FrameKind = 'next'): void {
        // do not retain `pixels`: the main-thread path transfers its buffer back to the worker after this upload, so
        // the texture is the retained copy. Kept with blending off too, so switching it on blends from the next frame;
        // a redraw of the current frame keeps the ones before, a jump forgets them
        if (this.hasFrame && kind === 'next') {
            [this.current, this.previous, this.earlier, this.earliest] =
                [this.earliest, this.current, this.previous, this.earlier];
            this.hasEarliest = this.hasEarlier;
            this.earliestColorMode = this.earlierColorMode;
            this.hasEarlier = this.hasPrevious;
            this.earlierColorMode = this.previousColorMode;
            this.hasPrevious = true;
            this.previousColorMode = this.lastColorMode;
            this.bindFrames();
        } else if (kind === 'jump') {
            this.hasPrevious = false;
            this.hasEarlier = false;
            this.hasEarliest = false;
        }
        this.maskStale = true;
        this.hasFrame = true;
        this.lastColorMode = colorMode;
        const gl = this.gl;
        gl.uniform1i(this.uniforms.colorMode, colorMode ? 1 : 0);
        this.applyBlend();
        gl.texSubImage2D(
            gl.TEXTURE_2D, 0, 0, 0, colorMode ? VBC_FRAME_WIDTH : VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT,
            gl.RGBA, gl.UNSIGNED_BYTE, pixels
        );
        this.draw();
    }

    /**
     * Encodes the presented frame as a PNG, optionally at a whole multiple of its size. It is enlarged by a
     * nearest-neighbour blit afterwards, as the shader maps each output pixel to a source one, so a bigger drawing
     * buffer would cut the picture differently. Indexed when the frame has 256 colors or fewer (nearly always), else
     * the canvas's own truecolor encoder.
     */
    async capture(scale = 1): Promise<ArrayBuffer> {
        const times = Math.max(1, Math.floor(scale));
        const indexed = await this.captureIndexed(times);
        if (indexed) {
            return indexed.buffer;
        }
        const enlarged = times > 1
            ? this.createCanvas(this.canvas.width * times, this.canvas.height * times)
            : undefined;
        const context = enlarged?.getContext('2d') as
            CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
        if (enlarged && context) {
            context.imageSmoothingEnabled = false;
            context.drawImage(this.canvas, 0, 0, enlarged.width, enlarged.height);
        }
        // without a 2D context to enlarge with, the picture at its own size is better than none
        const source = enlarged && context ? enlarged : this.canvas;
        let blob: Blob;
        if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) {
            blob = await source.convertToBlob({ type: 'image/png' });
        } else {
            blob = await new Promise<Blob>((resolve, reject) =>
                (source as HTMLCanvasElement).toBlob(
                    value => value
                        ? resolve(value)
                        : reject(new Error('Could not encode the frame.')),
                    'image/png',
                ));
        }
        return blob.arrayBuffer();
    }

    // undefined if it has too many colours or cannot be read back
    protected async captureIndexed(scale: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
        const { width, height } = this.canvas;
        const context = this.createCanvas(width, height).getContext('2d') as
            CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!context) {
            return undefined;
        }
        context.drawImage(this.canvas, 0, 0);
        return encodeIndexedPng(context.getImageData(0, 0, width, height).data, width, height, scale);
    }

    protected createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
        if (typeof OffscreenCanvas !== 'undefined' && this.canvas instanceof OffscreenCanvas) {
            return new OffscreenCanvas(width, height);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    protected draw(): void {
        // here rather than on present, so a frame that arrives without being drawn (the headset's) costs nothing, and
        // switching to `smart` without a new frame still has its mask
        if (this.blend === BLEND_MASKED && this.maskStale) {
            this.updateMask();
        }
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    }

    protected buildProgram(fragmentShader: string): WebGLProgram {
        const gl = this.gl;
        const program = gl.createProgram();
        if (!program) {
            throw new Error('Could not create the emulator shader program.');
        }
        gl.attachShader(program, this.compile(gl.VERTEX_SHADER, VERTEX_SHADER));
        gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, fragmentShader));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`Could not link the emulator shader: ${gl.getProgramInfoLog(program)}`);
        }
        return program;
    }

    protected compile(type: number, source: string): WebGLShader {
        const gl = this.gl;
        const shader = gl.createShader(type);
        if (!shader) {
            throw new Error('Could not create an emulator shader.');
        }
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(`Could not compile the emulator shader: ${gl.getShaderInfoLog(shader)}`);
        }
        return shader;
    }

    dispose(): void {
        this.gl.deleteTexture(this.current);
        this.gl.deleteTexture(this.previous);
        this.gl.deleteTexture(this.earlier);
        this.gl.deleteTexture(this.earliest);
        this.gl.deleteTexture(this.mask);
        this.gl.deleteFramebuffer(this.maskFramebuffer);
        this.gl.deleteTexture(this.rawMask);
        this.gl.deleteFramebuffer(this.rawMaskFramebuffer);
        this.gl.deleteTexture(this.blockMask);
        this.gl.deleteFramebuffer(this.blockMaskFramebuffer);
        this.hasFrame = false;
        this.hasPrevious = false;
        this.hasEarlier = false;
        this.hasEarliest = false;
        this.lastColorMode = false;
        // the context itself: a browser keeps only a few WebGL contexts and force-loses the oldest past that, and an
        // unreferenced one stands until the collector gets to its canvas. Matters most on the Linux desktop, where
        // every renderer is a context on the page
        this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
}
