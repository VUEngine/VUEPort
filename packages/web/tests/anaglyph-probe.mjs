// exercises the real renderer and compiled GLSL, no ROM or dev server needed
// usage: node packages/web/tests/anaglyph-probe.mjs (requires Puppeteer)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const puppeteer = (await import(require.resolve('puppeteer'))).default;
const bundle = await build({
    stdin: {
        contents: `export { VbRenderer as Renderer } from './worker/vb-renderer';
            export { Core } from './browser/core/vb-core';
            export * from './common/vb-constants';
            export { resolveAnaglyphPalette } from './browser/emulator-types';`,
        resolveDir: fileURLToPath(new URL('../../core/src/', import.meta.url)),
        loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'probe',
});

// independent row-major reference coefficients; production uploads column-major
const matrices = {
    'red-cyan': [
        [[0.456100, 0.500484, 0.176381], [-0.0400822, -0.0378246, -0.0157589], [-0.0152161, -0.0205971, -0.00546856]],
        [[-0.0434706, -0.0879388, -0.00155529], [0.378476, 0.733640, -0.0184503], [-0.0721527, -0.112961, 1.226400]],
    ],
    'green-magenta': [
        [[-0.062, -0.158, -0.039], [0.284, 0.668, 0.143], [-0.015, -0.027, 0.021]],
        [[0.529, 0.705, 0.024], [-0.016, -0.015, -0.065], [0.009, 0.075, 0.937]],
    ],
    'amber-blue': [
        [[1.062, -0.205, 0.299], [-0.026, 0.908, 0.068], [-0.038, -0.173, 0.022]],
        [[-0.016, -0.123, -0.017], [0.006, 0.062, -0.017], [0.094, 0.185, 0.911]],
    ],
};
const linear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const srgb = x => x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
function reference(profile, left, right) {
    const [ml, mr] = matrices[profile];
    return ml.map((row, i) => {
        const value = row.reduce((sum, coefficient, j) =>
            sum + coefficient * linear(left[j]) + mr[i][j] * linear(right[j]), 0);
        return Math.round(255 * srgb(Math.max(0, Math.min(1, value))));
    });
}
let checks = 0;
function check(label, actual, expected) {
    assert.equal(actual.length, expected.length, label);
    assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= 1),
        `${label}: ${actual}, expected ${expected}`);
    checks++;
}
// for anything that is not a list of channel values
function same(label, actual, expected) {
    assert.deepEqual(actual, expected, label);
    checks++;
}

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
        const { Renderer, buildDisplayMode, VB_DEFAULT_PALETTE, VB_ANAGLYPH_PALETTES, resolveAnaglyphPalette } = probe;
        const canvas = new OffscreenCanvas(384, 224);
        const renderer = new Renderer(canvas,
            buildDisplayMode('anaglyph', VB_DEFAULT_PALETTE, VB_ANAGLYPH_PALETTES['red-cyan']));
        window.renderPixel = ({ profile = 'red-cyan', filters, custom, mode = 'anaglyph',
            palette = VB_DEFAULT_PALETTE, left = [0, 0, 0], right = [0, 0, 0],
            legacy, redraw = false, x = 0, y = 0 }) => {
            const resolved = custom
                ? resolveAnaglyphPalette('custom:probe', [{ name: 'probe', ...custom }])
                : resolveAnaglyphPalette(profile, []);
            renderer.setDisplayMode(buildDisplayMode(mode, palette, filters ?? resolved));
            if (!redraw) {
                const pack = rgb => rgb[0] | (rgb[1] << 5) | (rgb[2] << 10);
                const l = pack(left), r = pack(right);
                const pixel = legacy ? [legacy[0], legacy[1], 0, 255] : [l & 255, l >> 8, r & 255, r >> 8];
                const frame = new Uint8Array(384 * 224 * 4);
                for (let i = 0; i < frame.length; i += 4) { frame.set(pixel, i); }
                renderer.present(frame, !legacy);
            }
            const gl = renderer.gl;
            const result = new Uint8Array(4);
            gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, result);
            if (gl.getError() !== gl.NO_ERROR) { throw new Error('WebGL error'); }
            return Array.from(result.subarray(0, 3));
        };
        window.renderer = renderer;
    });
    const pixel = options => page.evaluate(options => window.renderPixel(options), options);
    const normalized = rgb => rgb.map(c => c / 31);
    const colors = [[0, 0, 0], [31, 31, 31], [31, 0, 0], [0, 31, 0], [0, 0, 31],
    [16, 16, 16], [1, 1, 1], [1, 0, 0], [2, 3, 1], [25, 10, 5]];
    for (const profile of Object.keys(matrices)) {
        for (const left of colors) {
            for (const right of colors) {
                check(`${profile}: ${left} / ${right}`, await pixel({ profile, left, right }),
                    reference(profile, normalized(left), normalized(right)));
            }
        }
    }

    // legacy eyes enter Anaglyph as neutral gray at their brightness; the color ramp only paints eyes shown on their
    // own
    const palette = [0x010203, 0x402010, 0x806040, 0xffe0c0];
    const rgb = color => [color >> 16 & 255, color >> 8 & 255, color & 255].map(c => c / 255);
    const gray = level => [level, level, level].map(c => c / 255);
    const stops = [0, 105, 162, 250];
    for (const profile of Object.keys(matrices)) {
        for (let l = 0; l < 4; l++) {
            for (let r = 0; r < 4; r++) {
                check(`${profile} legacy gray at stops ${l}/${r}`, await pixel({ profile, palette, legacy: [stops[l], stops[r]] }),
                    reference(profile, gray(stops[l]), gray(stops[r])));
            }
        }
    }
    check('legacy anaglyph ignores the color palette', await pixel({ palette, legacy: [209, 88] }),
        reference('red-cyan', gray(209), gray(88)));
    check('legacy red/blue filters are not starved by a red palette',
        await pixel({ profile: 'red-blue', legacy: [250, 250] }), [250, 0, 250]);
    for (const color of [0xff0000, 0x00ff00, 0x0000ff]) {
        check('legacy selected palette redraws a retained frame',
            await pixel({ mode: 'left', palette: [color, color, color, color], redraw: true }),
            rgb(color).map(c => Math.round(c * 255)));
    }

    const left = [25, 10, 5], right = [5, 20, 30];
    const expected = reference('red-cyan', normalized(left), normalized(right));
    check('VBC ignores legacy palette', await pixel({ left, right, palette: [0, 0, 0, 0] }), expected);
    check('reversed custom glasses remain channel filters',
        await pixel({ left, right, custom: { left: '#00ffff', right: '#ff0000' } }),
        [right[0], left[1], left[2]].map(c => Math.round(c / 31 * 255)));
    check('custom palette explicitly selects a built-in Dubois profile',
        await pixel({
            left,
            right,
            custom: {
                left: '#ff0000',
                right: '#00ffff',
                duboisProfile: 'green-magenta',
            },
        }),
        reference('green-magenta', normalized(left), normalized(right)));
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const zero = Array(9).fill(0);
    check('custom Dubois matrices reach the shader in column-major order',
        await pixel({
            left,
            right,
            custom: {
                left: '#ff0000',
                right: '#00ffff',
                duboisProfile: 'custom',
                duboisMatrices: { left: identity, right: zero },
            },
        }),
        left.map(c => Math.round(c / 31 * 255)));
    check('an explicit no-profile selection ignores retained custom matrices',
        await pixel({
            left,
            right,
            custom: {
                left: '#ff0000',
                right: '#00ffff',
                duboisProfile: 'none',
                duboisMatrices: { left: identity, right: zero },
            },
        }),
        [left[0], right[1], right[2]].map(c => Math.round(c / 31 * 255)));
    check('an incomplete custom matrix safely falls back to red/cyan Dubois',
        await pixel({
            left,
            right,
            custom: {
                left: '#ff0000',
                right: '#00ffff',
                duboisProfile: 'custom',
                duboisMatrices: { left: [1], right: [] },
            },
        }),
        // the first coefficient is valid and deliberately overrides the fallback, the missing ones come from Red / Cyan
        (() => {
            const custom = structuredClone(matrices['red-cyan']);
            custom[0][0][0] = 1;
            const previous = matrices['custom-fallback'];
            matrices['custom-fallback'] = custom;
            const result = reference('custom-fallback', normalized(left), normalized(right));
            if (previous === undefined) delete matrices['custom-fallback'];
            else matrices['custom-fallback'] = previous;
            return result;
        })());
    check('custom filters revert to channel masks after Dubois',
        await pixel({ left, right, filters: { left: 0x800000, right: 0x0080ff } }),
        [25 / 31 * 128, 20 / 31 * 128, 30 / 31 * 255].map(Math.round));
    for (const [profile, filters] of Object.entries({
        'red-blue': [[1, 0, 0], [0, 0, 1]],
        'red-green': [[1, 0, 0], [0, 180 / 255, 0]],
    })) {
        check(`uncalibrated ${profile} fallback`, await pixel({ profile, left, right }),
            left.map((v, i) => Math.round(255 / 31 * (v * filters[0][i] + right[i] * filters[1][i]))));
    }
    const customPairs = [
        ['#ff0000', '#00ffff'], // exact red/cyan preset: must NOT infer Dubois
        ['#fe0000', '#00ffff'], // near a preset must not change the algorithm
        ['#00b400', '#c800ff'], // exact green/magenta preset
        ['#ffff00', '#0000ff'], // exact yellow/blue preset
    ];
    for (const [l, r] of customPairs) {
        const lf = rgb(Number.parseInt(l.slice(1), 16));
        const rf = rgb(Number.parseInt(r.slice(1), 16));
        check(`custom ${l}/${r} uses only its RGB filters`,
            await pixel({ left, right, custom: { left: l, right: r } }),
            left.map((v, i) => Math.round(Math.min(255, 255 / 31 * (v * lf[i] + right[i] * rf[i])))));
    }
    check('right blue does not add green in the green/magenta calibration',
        await pixel({ profile: 'green-magenta', left: [0, 0, 0], right: [0, 0, 31] }),
        [43, 0, 248]);
    await pixel({ left, right, profile: 'amber-blue' });
    check('returning to Dubois redraws without a new frame', await pixel({ redraw: true }), expected);
    for (const [mode, x, y, eye] of [
        ['left', 0, 0, left], ['right', 0, 0, right],
        ['side-by-side', 0, 0, left], ['side-by-side', 384, 0, right],
        ['cyberscope', 0, 0, left], ['cyberscope', 256, 0, right],
        ['hli', 0, 0, left], ['hli', 0, 1, right],
        ['vli', 0, 0, left], ['vli', 1, 0, right],
    ]) {
        check(`non-anaglyph ${mode} (${x},${y}) stays unchanged`,
            await pixel({ mode, left, right, x, y }), eye.map(c => Math.round(c / 31 * 255)));
    }
    await pixel({ left, right });
    const captured = await page.evaluate(async () => {
        const png = await window.renderer.capture();
        const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return Array.from(context.getImageData(0, 0, 1, 1).data.subarray(0, 3));
    });
    check('PNG capture includes Dubois composition', captured, expected);

    const mainThread = await page.evaluate(async () => {
        const { Renderer, VB_DEFAULT_DISPLAY_MODE } = probe;
        const canvas = document.createElement('canvas');
        const mode = {
            ...VB_DEFAULT_DISPLAY_MODE,
            palette: [0x123456, 0x123456, 0x123456, 0x123456],
        };
        const renderer = new Renderer(canvas, mode);
        const frame = new Uint8Array(384 * 224 * 4);
        for (let at = 0; at < frame.length; at += 4) {
            frame.set([250, 0, 0, 255], at);
        }
        renderer.present(frame);
        const read = () => {
            const pixel = new Uint8Array(4);
            renderer.gl.readPixels(0, canvas.height - 1, 1, 1,
                renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, pixel);
            return Array.from(pixel.subarray(0, 3));
        };
        const first = read();

        // the Linux path returns the buffer to the worker right after upload, so a later mode change must redraw from
        // the texture, not from this detached array
        const channel = new MessageChannel();
        channel.port1.postMessage(frame.buffer, [frame.buffer]);
        const detachedBytes = frame.byteLength;
        channel.port1.close();
        channel.port2.close();
        renderer.setDisplayMode({ ...mode, palette: [0x00ff00, 0x00ff00, 0x00ff00, 0x00ff00] });
        const redrawn = read();

        const png = await renderer.capture(2);
        const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
        const capture = { width: bitmap.width, height: bitmap.height, bytes: png.byteLength };
        bitmap.close();
        renderer.dispose();
        return { first, detachedBytes, redrawn, capture };
    });
    check('HTML canvas renderer uploads the transferred frame', mainThread.first, [0x12, 0x34, 0x56]);
    assert.equal(mainThread.detachedBytes, 0, 'the uploaded frame buffer was transferred');
    check('HTML canvas redraw survives returning its detached buffer', mainThread.redrawn, [0, 255, 0]);
    assert.deepEqual(
        [mainThread.capture.width, mainThread.capture.height],
        [768, 448],
        'main-thread PNG capture keeps the requested scale',
    );
    assert.ok(mainThread.capture.bytes > 0, 'main-thread PNG capture is not empty');

    // interleaved mode at its shown size: eyes alternate line by line, parity and swapEyes each flip which comes first,
    // and going back restores 768x448. swapEyes trades the halves of split modes too
    const interleaved = await page.evaluate(() => {
        const { Renderer, buildDisplayMode, VB_DEFAULT_PALETTE, VB_ANAGLYPH_PALETTES } = probe;
        const canvas = document.createElement('canvas');
        const build = (mode, swap = false) =>
            buildDisplayMode(mode, VB_DEFAULT_PALETTE, VB_ANAGLYPH_PALETTES['red-cyan'], swap);
        const renderer = new Renderer(canvas, build('hli'));
        const frame = new Uint8Array(384 * 224 * 4); // VBC transport: left eye pure red, right eye pure blue
        for (let at = 0; at < frame.length; at += 4) {
            frame.set([0x1f, 0x00, 0x00, 0x7c], at);
        }
        renderer.present(frame, true);
        const gl = renderer.gl;
        // 'L' or 'R' for each of the first lines from the top (HLI) or the left (VLI)
        const lines = (vertical, count = 6) => {
            const out = [];
            for (let i = 0; i < count; i++) {
                const pixel = new Uint8Array(4);
                const x = vertical ? i : 0;
                const y = vertical ? canvas.height - 1 : canvas.height - 1 - i;
                gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                out.push(pixel[0] > 128 ? 'L' : pixel[2] > 128 ? 'R' : '?');
            }
            return out.join('');
        };
        const size = () => [canvas.width, canvas.height];
        const result = {};
        result.modeSize = size();
        result.modeLines = lines(false);
        renderer.setDisplayOutput({ width: 1000, height: 583, parity: 0 });
        result.outputSize = size();
        result.outputLines = lines(false);
        result.atModeSize = renderer.atModeSize;
        renderer.setDisplayOutput({ width: 1000, height: 583, parity: 1 });
        result.oddLines = lines(false);
        renderer.setDisplayMode(build('hli', true));
        result.swappedOddLines = lines(false);
        renderer.setDisplayMode(build('vli'));
        result.vliColumns = lines(true);
        // split and one-eye modes, read at the left edge and past the middle: swapping trades the halves, not a lone
        // eye
        const halves = () => lines(true, canvas.width).at(0) + lines(true, canvas.width).at(-1);
        renderer.setDisplayMode(build('side-by-side', true));
        result.swappedSideBySide = halves();
        renderer.setDisplayMode(build('cyberscope', true));
        result.swappedCyberscope = halves();
        renderer.setDisplayMode(build('right', true));
        result.swappedRight = lines(true, 1);
        renderer.setDisplayMode(build('left'));
        result.leftSize = size();
        renderer.setDisplayMode(build('hli'));
        renderer.setDisplayOutput(undefined);
        result.backSize = size();
        renderer.dispose();
        return result;
    });
    same('HLI at its own size is 768x448', interleaved.modeSize, [768, 448]);
    same('HLI at its own size alternates from the left eye', interleaved.modeLines, 'LRLRLR');
    same('HLI drawn at the size shown takes that size', interleaved.outputSize, [1000, 583]);
    same('and still alternates line by line', interleaved.outputLines, 'LRLRLR');
    same('and is not the mode\'s own size for a capture', interleaved.atModeSize, false);
    same('an odd parity starts on the right eye', interleaved.oddLines, 'RLRLRL');
    same('swapping the eyes flips it back', interleaved.swappedOddLines, 'LRLRLR');
    same('VLI alternates column by column at the size shown', interleaved.vliColumns, 'RLRLRL');
    same('swapped Side By Side shows the right eye on the left', interleaved.swappedSideBySide, 'RL');
    same('swapped CyberScope shows the right eye on the left', interleaved.swappedCyberscope, 'RL');
    same('a one-eye mode ignores swapping', interleaved.swappedRight, 'R');
    same('a mode that does not interleave ignores the size shown', interleaved.leftSize, [384, 224]);
    same('without a size shown, HLI is its own size again', interleaved.backSize, [768, 448]);

    const transport = await page.evaluate(async () => {
        const { Core, VB_DEFAULT_DISPLAY_MODE } = probe;
        const mode = {
            ...VB_DEFAULT_DISPLAY_MODE,
            palette: [0x654321, 0x654321, 0x654321, 0x654321],
        };
        class LoopbackWorker {
            onmessage;
            attached;
            returned = [];

            postMessage(message, transfer = []) {
                const received = structuredClone(message, { transfer });
                if (received.command === 'attachCanvas') {
                    this.attached = received.params.mainThread;
                    const pixels = this.attached.buffers.shift();
                    const frame = new Uint8Array(pixels);
                    for (let at = 0; at < frame.length; at += 4) {
                        frame.set([250, 0, 0, 255], at);
                    }
                    const event = structuredClone({
                        event: 'frame',
                        payload: {
                            sim: received.params.sim,
                            presentation: this.attached.presentation,
                            pixels,
                            colorMode: false,
                        },
                    }, { transfer: [pixels] });
                    queueMicrotask(() => {
                        this.onmessage({ data: event });
                        this.onmessage({ data: { id: received.id } });
                    });
                } else if (received.videoFrame) {
                    this.returned.push(received.videoFrame);
                }
            }
        }
        const worker = new LoopbackWorker();
        const core = new Core(worker, {}, {}, true);
        const canvas = document.createElement('canvas');
        await core.attachCanvas(23, canvas, mode);
        await new Promise(resolve => setTimeout(resolve));
        const pixel = new Uint8Array(4);
        const gl = core.mainThreadRenderers.get(23).renderer.gl;
        gl.readPixels(0, canvas.height - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const returned = worker.returned[0];
        core.detachCanvas(23);
        return {
            pixel: Array.from(pixel.subarray(0, 3)),
            poolAfterSend: worker.attached.buffers.length,
            returnedBytes: returned?.pixels.byteLength ?? 0,
            presentationMatches: returned?.presentation === worker.attached.presentation,
        };
    });
    check('core routes a worker frame into the HTML canvas', transport.pixel, [0x65, 0x43, 0x21]);
    assert.equal(transport.poolAfterSend, 2, 'one of three transfer buffers was in flight');
    assert.equal(transport.returnedBytes, 384 * 224 * 4, 'the frame buffer returned at full size');
    assert.ok(transport.presentationMatches, 'returned frame belongs to the attached canvas');
    console.log(`Passed ${checks} real WebGL anaglyph checks.`);
} finally {
    await browser.close();
}
