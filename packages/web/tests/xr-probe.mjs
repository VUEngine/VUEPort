/**
 * Checks that headset play puts the game in front of the player: the title bar offers it where the browser has a
 * headset, and presented frames end up in the headset's layer (the quad layer with WebXR Layers, else the eye
 * buffers). No headset needed: a stand-in WebXR keeps its layers as textures in the page's own context, so the drawing
 * can be read back.
 *
 * Usage: node tests/xr-probe.mjs <rom.vb> (after `yarn build`). Needs a ROM that draws something at once, as a blank
 * picture is what failing looks like. `XR_ONLY=<text>` runs the scenarios whose name contains it,
 * `XR_SNAPSHOT=<folder>` keeps the interface's layers as drawn.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
const romPath = process.argv[2];
if (!romPath) {
    console.log('Usage: node tests/xr-probe.mjs <rom.vb>');
    process.exit(1);
}

let failures = 0;

function check(label, ok, detail = '') {
    if (!ok) {
        failures++;
        console.log(`  FAIL ${label}${detail ? `: ${detail}` : ''}`);
    } else {
        console.log(`  ok   ${label}`);
    }
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
};

const server = createServer(async (request, response) => {
    const pathname = request.url.split('?')[0];
    const url = pathname === '/' ? '/index.html' : pathname;
    try {
        const body = await readFile(path.join(dist, url));
        response.writeHead(200, { 'content-type': TYPES[path.extname(url)] ?? 'application/octet-stream' });
        response.end(body);
    } catch {
        response.writeHead(404).end();
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// stand-in WebXR, installed before the page's scripts. `layers` says whether it offers WebXR Layers; either
// way every layer is a texture in the page's context, and `window.__xr.read()` counts the lit pixels
function installFakeXr(layers, staleClick, brokenControllers, questSubImages, stallAudio, refuseAr, wide) {
    // the opening click may count as expired by the time the game runs, as after a slow load; then the title
    // bar is the way in
    if (staleClick) {
        Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: false } });
    }
    const state = { frames: 0, subImages: 0, gl: undefined, texture: undefined, size: [0, 0], ended: false, pads: [] };
    window.__xr = state;
    // each hand points from (x, y) on the player's plane, straight ahead
    state.rays = {};
    state.aim = (handedness, ray) => {
        state.rays[handedness] = ray;
        if (!state.pads.some(source => source.handedness === handedness)) {
            state.hold(handedness);
        }
    };
    state.hold = (handedness, {
        grip = false, stickX = 0, stickY = 0, click = false, a = false, b = false, menu = false, trigger = false,
    } = {}) => {
        const pad = {
            mapping: 'xr-standard',
            axes: [0, 0, stickX, stickY], // the stick is axes 2 and 3
            // trigger 0, grip 1, stick click 3, A and B 4 and 5, thumb rest 6, then a menu button if passed on
            buttons: [0, 1, 2, 3, 4, 5, 6, 7].map(index => ({
                pressed: (index === 0 && trigger) || (index === 1 && grip) || (index === 3 && click)
                    || (index === 4 && a) || (index === 5 && b) || (index === 7 && menu),
            })),
        };
        state.pads = state.pads.filter(source => source.handedness !== handedness);
        state.pads.push({ handedness, gamepad: pad, targetRaySpace: { hand: handedness } });
        if (state.session) {
            state.session.inputSources = state.pads;
        }
    };

    // every audio context the page makes, so the session can stop the page's sound as a Quest seems to; the
    // machine is clocked by its audio
    const contexts = [];
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
        constructor(...args) {
            super(...args);
            contexts.push(this);
        }
        // a Quest taking over the output device: the clock stops, `state` still says running and resume() does
        // nothing, until the page suspends the context itself
        stall() {
            this.stalled = true;
            return super.suspend();
        }
        get state() {
            return this.stalled ? 'running' : super.state;
        }
        suspend() {
            this.stalled = false;
            return super.suspend();
        }
        resume() {
            return this.stalled ? Promise.resolve() : super.resume();
        }
    };
    state.audioStates = () => contexts.map(context => context.state);
    // whether every context's clock moves, which `state` alone may not say
    state.audioClocks = async () => {
        const before = contexts.map(context => context.currentTime);
        await new Promise(resolve => setTimeout(resolve, 300));
        return contexts.map((context, index) => context.currentTime > before[index]);
    };

    function texture(gl, width, height, main = true) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        if (main) {
            state.gl = gl;
            state.texture = tex;
            state.size = [width, height];
        }
        return tex;
    }

    // alpha at a texture's corner, the game layer's by default: clear with passthrough, where nothing is drawn
    state.cornerAlpha = (tex = state.texture) => {
        const gl = state.gl;
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        return pixel[3];
    };

    // pixels that are black and opaque: a screen's own black, unless it is a hologram
    state.opaqueBlack = (tex = state.texture, width = state.size[0], height = state.size[1]) => {
        const gl = state.gl;
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] < 8 && pixels[i + 1] < 8 && pixels[i + 2] < 8 && pixels[i + 3] > 200) {
                count++;
            }
        }
        return count;
    };

    state.readTexture = (tex, width, height) => {
        const gl = state.gl;
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        let bright = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] > 60 || pixels[i + 1] > 60 || pixels[i + 2] > 60) {
                bright++;
            }
        }
        return bright;
    };
    state.overlays = [];

    state.snapshot = (tex, width, height) => {
        const gl = state.gl;
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const image = canvas.getContext('2d').createImageData(width, height);
        // rows bottom up in GL, top down in a picture
        for (let row = 0; row < height; row++) {
            image.data.set(pixels.subarray((height - 1 - row) * width * 4, (height - row) * width * 4), row * width * 4);
        }
        canvas.getContext('2d').putImageData(image, 0, 0);
        return canvas.toDataURL('image/png');
    };

    state.read = () => {
        const { gl, size: [width, height] } = state;
        if (!gl) {
            return { lit: -1 };
        }
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.texture, 0);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        let lit = 0;
        let leftLit = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            // red only: the game is red, the room around it is not
            if (pixels[i] > 8) {
                lit++;
                if ((i / 4) % width < width / 2) {
                    leftLit++;
                }
            }
        }
        return { lit, leftLit, width, height, error: gl.getError() };
    };

    class FakeSession extends EventTarget {
        constructor(init) {
            super();
            this.enabledFeatures = layers && init?.optionalFeatures?.includes('layers') ? ['layers'] : [];
            this.supportedFrameRates = new Float32Array([72, 80, 90, 120]);
            this.visibilityState = 'visible';
            // controllers that cannot even be counted, showing the picture does not depend on reading them
            this.inputSources = brokenControllers
                ? { get length() { throw new Error('controllers unavailable'); } }
                : state.pads;
            this.targetFrameRate = undefined;
            this.renderState = {};
            state.session = this;
        }
        squeeze(type, handedness) {
            const event = new Event(type);
            event.inputSource = { handedness };
            this.dispatchEvent(event);
        }
        // as the spec has it and a Quest does: the new rate takes effect within the frame loop and the promise settles
        // only then, never for a session whose loop has not started
        updateTargetFrameRate(rate) {
            return new Promise(resolve => {
                this.pendingRate = () => {
                    this.targetFrameRate = rate;
                    state.rate = rate;
                    resolve();
                };
            });
        }
        updateRenderState(next) {
            // as the Quest Browser does: a session with layers takes no base layer
            if (next.baseLayer && this.enabledFeatures.includes('layers')) {
                throw new DOMException("Failed to execute 'updateRenderState' on 'XRSession': can't use base layer with layers feature enabled", 'NotSupportedError');
            }
            Object.assign(this.renderState, next);
            state.renderState = Object.keys(next);
            // layers up, by height in pixels: game 672; page parts at 1.5 per CSS pixel (title bar 66, toolbar 66,
            // status bar 44, badges 36, side panel and library 1080, large window 1140), keyboard 540, news line 112,
            // question 960, pointer 64. The room backdrop is kept apart
            if (next.layers) {
                state.layerHeights = next.layers.filter(layer => !layer.backdrop).map(layer => layer.pixelHeight);
                state.backdropShown = next.layers.some(layer => layer.backdrop);
            }
        }
        async requestReferenceSpace() { state.space = true; return new EventTarget(); }
        requestAnimationFrame(callback) {
            return setTimeout(() => {
                if (this.ended) {
                    return;
                }
                state.frames++;
                this.frames = (this.frames ?? 0) + 1;
                this.pendingRate?.();
                this.pendingRate = undefined;
                // once the session is under way, so after anything its starting click could have resumed
                if (this.frames === 30) {
                    for (const context of contexts) {
                        if (stallAudio) {
                            context.stall();
                        } else {
                            context.suspend();
                        }
                    }
                }
                callback(performance.now(), frame);
            }, 11);
        }
        cancelAnimationFrame(handle) { clearTimeout(handle); }
        async end() {
            this.ended = true;
            state.ended = true;
            this.dispatchEvent(new Event('end'));
        }
    }

    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // a 90° perspective, near 0.1, far 100
    // (wider with XR_WIDE, for a snapshot of the whole interface)
    const focal = wide ? 0.8 : 1;
    const projection = new Float32Array([focal, 0, 0, 0, 0, focal, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2002, 0]);
    const transform = { matrix: identity, inverse: { matrix: identity } };
    const frame = {
        getPose: space => {
            const ray = space?.hand && state.rays[space.hand];
            return ray
                ? { transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ray.x, ray.y, 0, 1]) } }
                : null;
        },
        getViewerPose: () => ({
            views: [
                { eye: 'left', projectionMatrix: projection, transform },
                { eye: 'right', projectionMatrix: projection, transform },
            ],
        }),
    };

    // defined rather than assigned: Chromium has a real `xr` on the prototype
    Object.defineProperty(navigator, 'xr', {
        configurable: true,
        value: {
            isSessionSupported: async mode => mode === 'immersive-vr' || mode === 'immersive-ar',
            requestSession: async (mode, init) => {
                state.requested = (state.requested ?? 0) + 1;
                // as Chromium over Quest Link does: says yes to AR when asked, then turns the session down
                if (refuseAr && mode === 'immersive-ar') {
                    state.refused = (state.refused ?? 0) + 1;
                    throw new DOMException('The specified session configuration is not supported.', 'NotSupportedError');
                }
                state.mode = mode;
                state.ended = false;
                return new FakeSession(init);
            },
        },
    });
    // headless Chromium has no device to make a context compatible with, and waits for one forever
    WebGL2RenderingContext.prototype.makeXRCompatible = async () => undefined;
    window.XRRigidTransform = class { constructor(position, orientation) { this.position = position; this.orientation = orientation; } };
    window.XRWebGLLayer = class {
        constructor(session, gl) {
            const width = 1600;
            const height = 800;
            const tex = texture(gl, width, height);
            this.framebuffer = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            this.width = width;
            this.height = height;
        }
        getViewport(view) {
            return { x: view.eye === 'right' ? this.width / 2 : 0, y: 0, width: this.width / 2, height: this.height };
        }
    };
    if (layers) {
        window.XRWebGLBinding = class {
            constructor(session, gl) { this.gl = gl; }
            createQuadLayer(init) {
                state.quad = { width: init.width, height: init.height, layout: init.layout };
                const mono = init.layout === 'mono';
                const width = mono ? init.viewPixelWidth : init.viewPixelWidth * 2;
                const height = init.viewPixelHeight;
                const layer = {
                    tex: texture(this.gl, width, height, !mono),
                    mono,
                    pixelWidth: init.viewPixelWidth,
                    pixelHeight: height,
                    width: init.width,
                    height: init.height,
                    transform: init.transform,
                };
                if (mono) {
                    state.overlays.push(layer);
                } else {
                    state.quadLayer = layer;
                }
                return layer;
            }
            createProjectionLayer() {
                const layer = { backdrop: true, tex: texture(this.gl, 64, 32, false), pixelWidth: 32, pixelHeight: 32 };
                state.backdrop = layer;
                return layer;
            }
            getViewSubImage(layer, view) {
                return {
                    colorTexture: layer.tex,
                    viewport: { x: view.eye === 'right' ? 32 : 0, y: 0, width: 32, height: 32 },
                };
            }
            getSubImage(layer, _frame, eye) {
                state.subImages++;
                if (layer.mono) {
                    return {
                        colorTexture: layer.tex,
                        viewport: { x: 0, y: 0, width: layer.pixelWidth, height: layer.pixelHeight },
                        colorTextureWidth: layer.pixelWidth,
                        colorTextureHeight: layer.pixelHeight,
                    };
                }
                // a Quest tells both eyes the left half; the Layers module gives each its own
                const right = eye === 'right' && !questSubImages;
                return {
                    colorTexture: layer.tex,
                    viewport: { x: right ? layer.pixelWidth : 0, y: 0, width: layer.pixelWidth, height: layer.pixelHeight },
                    colorTextureWidth: layer.pixelWidth * 2,
                    colorTextureHeight: layer.pixelHeight,
                };
            }
        };
    }
}

const puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader',
        // a sound card whose clock runs regardless of the machine's audio, as the emulation is clocked by its audio
        // and a stalled output device stalls the game
        '--disable-audio-output'],
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// `XR_SNAPSHOT=<folder>` keeps every layer in the headset as drawn, to look at
async function snapshotLayers(page, name) {
    const { writeFile: write } = await import('node:fs/promises');
    const shots = await page.evaluate(() => {
        const current = new Set(window.__xr.session?.renderState?.layers ?? []);
        return window.__xr.overlays.filter(layer => current.has(layer))
            .map(layer => window.__xr.snapshot(layer.tex, layer.pixelWidth, layer.pixelHeight));
    });
    for (const [index, shot] of shots.entries()) {
        await write(path.join(process.env.XR_SNAPSHOT, `xr-${name}-${index}.png`), Buffer.from(shot.split(',')[1], 'base64'));
    }
}

async function browseLibrary(page) {
    await page.click('.vp-titlebar-button[data-control="vr"]');
    await wait(3000);
    const dump = await page.evaluate(() => {
        const library = document.querySelector('.vp-library');
        const rect = node => { const r = node.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
        const scrollers = [...library.querySelectorAll('*')].filter(node => node.scrollHeight > node.clientHeight + 1
            && getComputedStyle(node).overflowY !== 'visible').map(node => `${node.className} ${rect(node)} ${node.scrollHeight}`);
        return {
            library: rect(library),
            parents: (() => { const out = []; for (let at = library.parentElement; at && at !== document.body; at = at.parentElement) { out.push(`${at.className} ${rect(at)} sh${at.scrollHeight}`); } return out; })(),
            scrollers,
            nav: [...document.querySelectorAll('.vp-library-side button, .vp-library-side a')].map(node => node.textContent.trim()).slice(0, 30),
        };
    });
    console.log(JSON.stringify(dump, null, 1));
    const out = process.env.XR_SNAPSHOT;
    const { writeFile: write } = await import('node:fs/promises');
    const shoot = async name => {
        if (!out) {
            return;
        }
        const shot = await page.evaluate(() => {
            const part = window.__vueportXrUi.parts.find(candidate => candidate.slot === 'middle');
            const overlay = part.overlay;
            if (!overlay?.visible) {
                return 'not shown';
            }
            return window.__xr.snapshot(overlay.layer ? window.__xr.overlays.find(layer => layer === overlay.layer)?.tex : undefined,
                overlay.pixels.width, overlay.pixels.height);
        }).catch(error => String(error));
        if (shot.startsWith('data:')) {
            await write(path.join(out, `browse-${name}-xr.png`), Buffer.from(shot.split(',')[1], 'base64'));
        }
        const box = await (await page.$('.vp-library, .vp-library-page')).boundingBox();
        await page.screenshot({ path: path.join(out, `browse-${name}-page.png`), clip: box });
    };
    const stats = async label => {
        const list = await page.evaluate(() => window.__vueportXrUi.stats.splice(0));
        const library = list.filter(entry => entry.slot === 'middle');
        const mean = key => (library.reduce((sum, entry) => sum + entry[key], 0) / Math.max(1, library.length)).toFixed(1);
        console.log(`   ${label}: library drawn ×${library.length}, copy ${mean('copy')} serialize ${mean('serialize')} decode ${mean('decode')} raster ${mean('raster')} upload ${mean('upload')} ms, svg ${mean('svg')} chars, pictures ${mean('pictures')}, drawn ${mean('drawn')}, css ${mean('css')}`);
    };
    await page.evaluate(() => [...document.querySelectorAll('.vp-library-side button, .vp-library-side a')]
        .find(node => node.textContent.trim().startsWith('Homebrew'))?.click());
    await wait(8000);
    await stats('opening the homebrew archive');
    if (process.env.XR_STATS) {
        console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.vp-library img')].slice(0, 8).map(node => {
            const r = node.getBoundingClientRect();
            return [node.currentSrc.slice(0, 50), node.complete, node.naturalWidth, node.naturalHeight, Math.round(r.width), Math.round(r.height), node.className];
        }))));
    }
    await shoot('homebrew');
    const hover = await page.evaluate(async () => {
        const ui = window.__vueportXrUi;
        const part = ui.parts.find(candidate => candidate.slot === 'middle');
        const cards = [...part.element.querySelectorAll('.vp-library-card')];
        const box = part.element.getBoundingClientRect();
        const results = [];
        for (const card of cards.slice(0, 12)) {
            const at = card.getBoundingClientRect();
            if (at.bottom > box.bottom || at.top < box.top) {
                continue;
            }
            const u = (at.left + at.width / 2 - box.left) / box.width;
            const v = (at.top + at.height / 2 - box.top) / box.height;
            const quad = part.overlay;
            window.__xr.aim('right', { x: quad.position.x + (u - 0.5) * quad.width, y: quad.position.y + (0.5 - v) * quad.height });
            await new Promise(resolve => setTimeout(resolve, 150));
            results.push(card.contains(ui.pointer.hovered) ? 'ok' : `off: ${ui.pointer.hovered?.className} in ${ui.pointer.hovered?.closest('.vp-library-card')?.textContent?.slice(0, 20)} for ${card.textContent.slice(0, 20)}`);
        }
        return results;
    });
    console.log('   hover', JSON.stringify(hover));
    await stats('pointing along cards');
    await shoot('hover');
    // a second of the stick down, then still; on a CPU slowed to about a headset's, the page's long tasks meanwhile
    const throttle = Number(process.env.XR_THROTTLE ?? 0);
    if (throttle) {
        await page.emulateCPUThrottling(throttle);
    }
    await page.evaluate(() => {
        window.__longTasks = [];
        new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(entry => Math.round(entry.duration))))
            .observe({ type: 'longtask', buffered: false });
        window.__frameGaps = [];
        let last = performance.now();
        const session = window.__xr.session;
        const tick = () => {
            const now = performance.now();
            window.__frameGaps.push(now - last);
            last = now;
            if (!session.ended) {
                session.requestAnimationFrame(tick);
            }
        };
        session.requestAnimationFrame(tick);
    });
    await page.evaluate(() => window.__xr.hold('right', { stickY: 1 }));
    await wait(2000);
    await page.evaluate(() => window.__xr.hold('right'));
    await wait(1500);
    const frames = await page.evaluate(() => {
        const gaps = window.__frameGaps.slice(1);
        const sorted = [...gaps].sort((a, b) => a - b);
        return { frames: gaps.length, over50: gaps.filter(gap => gap > 50).length, worst: Math.round(sorted.at(-1) ?? 0),
            median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), longTasks: window.__longTasks };
    });
    console.log('   frames while scrolling', JSON.stringify(frames));
    await stats('scrolling two seconds, and after');
    if (throttle) {
        await page.emulateCPUThrottling(1);
    }
    await shoot('scrolled');
    await page.evaluate(() => document.querySelector('.vp-library-card')?.click());
    await wait(4000);
    await stats('a game\'s page');
    await shoot('detail');
}

const ALL_SCENARIOS = [
    { name: 'A browser with WebXR Layers: a quad layer, by default', layers: true, query: '', quad: true },
    { name: 'A quad layer whose eyes are both told the left half, as on a Quest', layers: true, query: '?xr-layers=on', quad: true, questSubImages: true },
    { name: 'The same browser asked to draw into the eye buffers', layers: true, query: '?xr-layers=off', quad: false },
    { name: 'A browser without them, the game opened without a fresh click', layers: false, query: '', quad: false, staleClick: true },
    { name: 'A game taken into the headset once running, whose audio the headset stalls', layers: true, query: '', quad: true, staleClick: true, stallAudio: true },
    { name: 'Controllers that fail to read', layers: true, query: '?xr-layers=off', quad: false, brokenControllers: true, leave: 'grips' },
    { name: 'On a Quest, adjusting the screen from inside', layers: true, query: '?xr-layers=on', quad: true, questSubImages: true, quest: true, adjust: true },
    { name: 'The interface around the screen, pointed at', layers: true, query: '?xr-debug', quad: true, ui: true },
    { name: 'The interface, drawn into the eye buffers', layers: true, query: '?xr-layers=off&xr-debug', quad: false, uiProjection: true },
    { name: 'In without a game: the library where the screen would be', layers: true, query: '?xr-debug', quad: true, library: true },
    { name: 'Backdrop, chosen in the settings in the headset', layers: true, query: '?xr-layers=off&xr-debug', quad: false, passthrough: true },
    { name: 'Backdrop with quad layers', layers: true, query: '?xr-debug', quad: true, passthroughQuad: true },
    { name: 'A PC runtime that offers the room and refuses it', layers: true, query: '', quad: true, refuseAr: true },
    // XR_LIVE=1 only, as it reaches Planet VB: the catalog's shelves browsed in the headset
    ...process.env.XR_LIVE ? [{ name: 'The library browsed in the headset, live catalog', layers: true, query: '?xr-debug', quad: true, browse: true }] : [],
];
const SCENARIOS = ALL_SCENARIOS.filter(scenario => !process.env.XR_ONLY || scenario.name.includes(process.env.XR_ONLY));

for (const { name, layers, query, quad, staleClick, stallAudio, brokenControllers, questSubImages, quest, adjust, ui, uiProjection, library, leave, passthrough, passthroughQuad, refuseAr, browse } of SCENARIOS) {
    console.log(`\n${name}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setRequestInterception(true);
    page.on('request', request => !browse && (request.url().includes('api.vueport.net') || request.url().includes('virtual-boy.com'))
        ? request.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' })
        : request.continue());
    page.on('pageerror', error => console.log('  pageerror', String(error)));
    page.on('console', message => {
        if (message.type() === 'error') {
            console.log('  console', message.text());
        }
    });
    if (quest) {
        await page.setUserAgent(`${await browser.userAgent()} OculusBrowser/40.0`);
    }
    await page.evaluateOnNewDocument(installFakeXr, layers, !!staleClick, !!brokenControllers, !!questSubImages, !!stallAudio, !!refuseAr, !!process.env.XR_WIDE);
    await page.goto(`${origin}/${query}`, { waitUntil: 'networkidle0' });
    const heights = () => page.evaluate(() => window.__xr.layerHeights);

    if (browse) {
        await browseLibrary(page);
        await page.close();
        continue;
    }
    if (library) {
        await page.click('.vp-titlebar-button[data-control="vr"]');
        await wait(2500);
        check('the headset is there to go into without a game', await page.evaluate(() => window.__xr.requested === 1));
        const shown = await heights();
        // the strip without a game as large as one with a game: in the screen's column, where flex would size it
        // by its height
        const strip = await page.evaluate(() => {
            const box = document.querySelector('.vp-panel-aside').getBoundingClientRect();
            return { width: Math.round(box.width), height: Math.round(box.height),
                wanted: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vp-xr-aside-height')) };
        });
        check('the strip says there is no game, as large as it is with one', strip.width === 440
            && Math.abs(strip.height - strip.wanted) <= 1, JSON.stringify(strip));
        const visible = slot => page.evaluate(slot => window.__vueportXrUi.parts.find(part => part.slot === slot)
            ?.overlay?.visible === true, slot);
        check('the whole window, library and all, is where the screen would be, the settings beside it',
            !shown?.includes(672) && await visible('middle') && await visible('window'),
            JSON.stringify(shown));
        await page.evaluate(() => window.__xr.hold('right', { b: true }));
        await wait(150);
        await page.evaluate(() => window.__xr.hold('right'));
        await wait(800);
        check('B leaves the settings standing beside it', await page.$('.vp-settings-window') !== null,
            JSON.stringify(await heights()));
        if (process.env.XR_SNAPSHOT) {
            await snapshotLayers(page, 'library');
        }
    }

    // in a headset already, the settings stand over the page; clicked past them
    const past = library
        ? await page.addStyleTag({ content: '.vp-window-backdrop, .vp-xr-page-cover, .vp-screen > .vp-panel-aside { pointer-events: none !important; } .vp-library-side-foot { display: flex !important; }' })
        : undefined;
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.vp-library-side-foot .vp-button')]);
    await chooser.accept([romPath]);
    await past?.evaluate(node => node.remove());
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await wait(1500);

    const offered = await page.waitForSelector(
        '.vp-titlebar-button[data-control="vr"], .vp-titlebar-button[data-control="leave-vr"]', { timeout: 5000 })
        .then(() => true, () => false);
    check('the title bar offers a way into VR or out of it', offered);
    if (!offered) {
        await page.close();
        continue;
    }
    if (refuseAr) {
        check('an AR session refused is asked for again as VR, from the same click', await page.evaluate(() =>
            window.__xr.refused === 1 && window.__xr.requested === 2 && window.__xr.mode === 'immersive-vr'));
    } else if (library) {
        check('a game opened in the headset puts the interface away for it', JSON.stringify(await heights()) === '[672]',
            JSON.stringify(await heights()));
    } else if (!staleClick) {
        check('starting a game goes straight into the headset', await page.evaluate(() => window.__xr.requested === 1));
    } else {
        check('a game started without a fresh click does not enter VR by itself',
            await page.evaluate(() => !window.__xr.requested));
        check('and puts nothing over the picture about it', await page.$eval('.vp-screen-prompt', node => node.hidden));
        await page.click('.vp-titlebar-button[data-control="vr"]');
        await wait(300);
        check('the VR button goes straight in', await page.evaluate(() => window.__xr.requested === 1));
        await wait(500);
        check('and inside it the title bar has no VR button, only the X out',
            await page.$('.vp-titlebar-button[data-control="vr"]') === null
            && await page.$('.vp-titlebar-button[data-control="leave-vr"]') !== null);
    }
    // long enough for a ROM's logo to be on screen
    await wait(4000);

    const toasts = await page.evaluate(() => [...document.querySelectorAll('[class*="notification"], [class*="toast"]')]
        .map(node => node.textContent.trim()).filter(Boolean));
    if (toasts.length) {
        console.log('   notifications:', JSON.stringify(toasts));
    }
    const result = await page.evaluate(() => ({
        frames: window.__xr.frames,
        requested: window.__xr.requested,
        space: window.__xr.space,
        compatible: typeof WebGL2RenderingContext.prototype.makeXRCompatible,
        subImages: window.__xr.subImages,
        rate: window.__xr.rate,
        renderState: window.__xr.renderState,
        quad: window.__xr.quad,
        picture: window.__xr.read(),
        audio: window.__xr.audioStates(),
    }));
    console.log('  ', JSON.stringify(result));
    check('the session runs', result.frames > 20, `${result.frames} frames`);
    check('it asks for 120 Hz', result.rate === 120, String(result.rate));
    check(quad ? 'it draws into a quad layer' : 'it draws into the base layer',
        quad ? result.renderState?.includes('layers') : result.renderState?.includes('baseLayer'));
    check('the layer shows the game', result.picture.lit > 1000, `${result.picture.lit} lit pixels`);
    check('both eyes are drawn', result.picture.leftLit > 0 && result.picture.lit - result.picture.leftLit > 0);
    check('without GL errors', result.picture.error === 0, String(result.picture.error));
    check('the audio the headset stopped is running again', result.audio.length > 0
        && result.audio.every(state => state === 'running'), JSON.stringify(result.audio));
    const clocks = await page.evaluate(() => window.__xr.audioClocks());
    check('its clock moving', clocks.length > 0 && clocks.every(Boolean), JSON.stringify(clocks));
    const speed = await page.$eval('[data-status="speed"] .vp-status-value', node => node.textContent.trim())
        .catch(() => undefined);
    if (speed !== undefined) {
        check('and the machine with it', parseInt(speed, 10) > 50, speed);
    }

    if (adjust) {
        const width = await page.evaluate(() => window.__xr.quadLayer.width);
        check('a Quest is given the quad layer at half the size, which it shows doubled', Math.abs(width - 0.6) < 1e-6, String(width));
        const screen = () => page.evaluate(() => JSON.parse(localStorage.getItem('vueport.xrView') ?? 'null'));
        await page.evaluate(() => window.__xr.hold('right', { grip: true, stickY: -1 }));
        await wait(1000);
        await page.evaluate(() => window.__xr.hold('right'));
        await page.evaluate(() => window.__xr.hold('left', { grip: true, stickX: 1 }));
        await wait(1000);
        await page.evaluate(() => window.__xr.hold('left'));
        await wait(200);
        const kept = await screen();
        check('a grip and the right stick make it deeper, and that is kept', kept && kept.depth > 140 && kept.depth < 180, JSON.stringify(kept));
        check('a grip and the left stick make it bigger, and that is kept', kept && kept.width > 1.65 && kept.width < 2.2, JSON.stringify(kept));
        const grown = await page.evaluate(() => window.__xr.quadLayer.width);
        check('the quad layer itself grows with it', Math.abs(grown - kept.width * 0.5) < 1e-6, String(grown));
        await page.evaluate(() => window.__xr.hold('right', { grip: true, stickX: -1 }));
        await wait(500);
        await page.evaluate(() => window.__xr.hold('right'));
        await wait(200);
        const flattened = await screen();
        check('left on a stick is less', flattened?.depth < kept.depth, JSON.stringify(flattened));
        await page.evaluate(() => window.__xr.hold('left', { grip: true, click: true }));
        await wait(200);
        await page.evaluate(() => window.__xr.hold('left'));
        await wait(200);
        const resized = await screen();
        check('a grip and a click of the left stick put the size back', resized?.width === 1.2 && resized?.depth === flattened.depth, JSON.stringify(resized));
        await page.evaluate(() => window.__xr.hold('right', { grip: true, click: true }));
        await wait(200);
        await page.evaluate(() => window.__xr.hold('right'));
        await wait(200);
        check('and of the right stick the depth', (await screen())?.depth === 100, JSON.stringify(await screen()));
    }
    const tap = async (hand, buttons) => {
        await page.evaluate((h, b) => window.__xr.hold(h, b), hand, buttons);
        await wait(150);
        await page.evaluate(h => window.__xr.hold(h), hand);
        await wait(150);
    };
    // aims the right hand at the middle of an element in a part of the interface shown in the headset (see
    // emulator-xr-ui.ts: the parts by slot, each with its quad, reachable with ?xr-debug). A ray from (x, y) straight
    // ahead meets a turned quad where its own x is
    const aimAt = (slot, selector, index = 0, along = 0.5) => page.evaluate((slot, selector, index, along) => {
        const ui = window.__vueportXrUi;
        const part = ui?.parts.find(candidate => candidate.slot === slot);
        if (!part?.element || !part.overlay?.visible) {
            return `${slot} not shown`;
        }
        const element = part.element.matches(selector) ? part.element : part.element.querySelectorAll(selector)[index];
        if (!element) {
            return `no ${selector} in ${slot}`;
        }
        const box = part.element.getBoundingClientRect();
        const at = element.getBoundingClientRect();
        const u = (at.left + at.width * along - box.left) / box.width;
        const v = (at.top + at.height / 2 - box.top) / box.height;
        const quad = part.overlay;
        const across = (u - 0.5) * quad.width;
        window.__xr.aim('right', {
            x: quad.position.x + Math.cos(quad.turn) * across,
            y: quad.position.y + (0.5 - v) * quad.height,
        });
        return 'ok';
    }, slot, selector, index, along);
    const click = async (slot, selector, index = 0) => {
        const aimed = await aimAt(slot, selector, index);
        check(`pointing at ${selector} in the ${slot}`, aimed === 'ok', aimed);
        await wait(200);
        await tap('right', { trigger: true });
        await wait(1200);
    };
    // `XR_STATS=1`: what the interface's drawings took since the last call, by part
    const drawStats = async label => {
        if (!process.env.XR_STATS) {
            return;
        }
        const stats = await page.evaluate(() => window.__vueportXrUi?.stats.splice(0) ?? []);
        const bySlot = {};
        for (const entry of stats) {
            (bySlot[entry.slot] ??= []).push(entry);
        }
        console.log(`   drawings ${label}:`);
        for (const [slot, list] of Object.entries(bySlot)) {
            const mean = key => (list.reduce((sum, entry) => sum + entry[key], 0) / list.length).toFixed(1);
            console.log(`     ${slot} ×${list.length}: copy ${mean('copy')} serialize ${mean('serialize')} decode ${mean('decode')}`
                + ` raster ${mean('raster')} upload ${mean('upload')} ms, css ${mean('css')} svg ${mean('svg')} chars`);
        }
    };
    const speedNow = () => page.$eval('[data-status="speed"] .vp-status-value', node => parseInt(node.textContent, 10))
        .catch(() => undefined);
    const paused = () => page.$eval('[data-control="pause"]', node => node.classList.contains('vp-strip-button-on'));
    if (ui) {
        check('nothing around the screen while the game runs', JSON.stringify(await heights()) === '[672]',
            JSON.stringify(await heights()));
        const wasRunning = !(await paused());
        await tap('left', { click: true });
        await wait(2000);
        check('the interface coming up pauses the game', wasRunning && await paused());
        const shown = await heights();
        const visible = slot => page.evaluate(slot => window.__vueportXrUi.parts.find(part => part.slot === slot)
            ?.overlay?.visible === true, slot);
        check('a stick click puts the interface around it: the page\'s own window behind the screen, '
            + 'the settings to the left, the cheats and their tabs to the right',
            shown?.includes(672) && await visible('middle')
            && await visible('window') && await visible('aside') && await visible('tabs')
            && (await page.evaluate(() => window.__vueportXrUi.underlays.length)) === 1,
            JSON.stringify(shown));
        const tall = await page.evaluate(() => {
            const ui = window.__vueportXrUi;
            const overlay = slot => ui.parts.find(part => part.slot === slot).overlay;
            const tabs = overlay('tabs');
            const aside = overlay('aside');
            const top = tabs.position.y + tabs.height / 2;
            return {
                middle: ui.underlays[0].height,
                left: overlay('window').height,
                right: top - (aside.position.y - aside.height / 2),
            };
        });
        check('the middle, left and right as tall as each other', Math.abs(tall.left - tall.middle) < 0.01
            && Math.abs(tall.right - tall.middle) < 0.01, JSON.stringify(tall));
        check('no way to open a ROM by file or link in a headset: the library is where games come from',
            await page.evaluate(() => getComputedStyle(document.querySelector('.vp-strip-button[data-control="openRom"]')).display === 'none'));
        const toolbar = await page.evaluate(() => {
            const strip = document.querySelector('.vp-strip-layer .vp-strip');
            strip.parentElement.style.width = '300px';
            strip.style.setProperty('--vp-strip-squeeze', '6px');
            const width = strip.getBoundingClientRect().width;
            const fits = strip.scrollWidth <= Math.ceil(width) + 1;
            strip.parentElement.style.width = '';
            strip.style.removeProperty('--vp-strip-squeeze');
            return { width: Math.round(width), fits };
        });
        check('the toolbar keeps its width in a headset, a narrow screen panel or not', toolbar.fits && toolbar.width > 500,
            JSON.stringify(toolbar));
        if (process.env.XR_DUMP) {
            const { readFileSync } = await import('node:fs');
            console.log('   DUMP', JSON.stringify(await page.evaluate(readFileSync(process.env.XR_DUMP, 'utf8')), null, 1));
        }
        const turned = await page.evaluate(() => window.__vueportXrUi.parts.find(part => part.slot === 'window').overlay?.turn);
        check('the settings turned toward the player', turned > 0.5, String(turned));
        check('the strips not in the title bar, the settings not either', await page.evaluate(() =>
            ['cheats', 'settings'].every(control => getComputedStyle(
                document.querySelector(`.vp-titlebar-button[data-control="${control}"]`)).display === 'none')));
        check('the badge says so over the screen', await page.$('.vp-state-badge-list') !== null);
        if (process.env.XR_SNAPSHOT) {
            await snapshotLayers(page, 'interface');
        }
        await click('middle', '.vp-strip-group:nth-child(2) .vp-strip-button', 1);
        await wait(300);
        const resumed = await speedNow();
        check('the toolbar carries on, and the game goes on', !(await paused())
            && await page.$('.vp-state-badge-list') === null && (resumed === undefined || resumed > 50), String(resumed));
        check('the page takes the pointer\'s hover, its own :hover rules with it', await page.evaluate(() =>
            document.querySelectorAll('.vp-xr-hover').length > 0
            && document.adoptedStyleSheets.some(sheet => [...sheet.cssRules].some(rule =>
                rule.cssText?.includes('.vp-panel-row.vp-xr-hover .vp-panel-row-action')))));
        await click('middle', '.vp-strip-group:nth-child(2) .vp-strip-button', 1);
        await drawStats('opening the interface');
        if (process.env.XR_SNAPSHOT) {
            await aimAt('window', '.vp-window-body', 0);
            await wait(200);
            await page.evaluate(() => window.__xr.hold('right', { stickY: 1 }));
            await wait(500);
            await page.evaluate(() => window.__xr.hold('right'));
            await wait(1500);
            const { writeFile: write } = await import('node:fs/promises');
            const shot = await page.evaluate(() => {
                const overlay = window.__vueportXrUi.parts.find(part => part.slot === 'window').overlay;
                return window.__xr.snapshot(window.__xr.overlays.find(layer => layer === overlay.layer)?.tex,
                    overlay.pixels.width, overlay.pixels.height);
            });
            await write(path.join(process.env.XR_SNAPSHOT, 'settings-scrolled-xr.png'), Buffer.from(shot.split(',')[1], 'base64'));
            const hide = await page.addStyleTag({ content: '.vp-xr-page-cover { display: none !important; }' });
            const box = await (await page.$('.vp-settings-window')).boundingBox();
            await page.screenshot({ path: path.join(process.env.XR_SNAPSHOT, 'settings-scrolled-page.png'), clip: box });
            await hide.evaluate(node => node.remove());
        }
        if (process.env.XR_STATS) {
            const changes = await page.evaluate(() => new Promise(resolve => {
                const seen = {};
                const describe = node => node.nodeType === 1
                    ? `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}`
                    : `#text in ${node.parentElement?.tagName.toLowerCase()}.${[...node.parentElement?.classList ?? []].join('.')}`;
                const observer = new MutationObserver(records => {
                    for (const record of records) {
                        const value = record.type === 'attributes' ? record.target.getAttribute(record.attributeName) : '';
                        const key = `${record.type} ${record.attributeName ?? ''} ${describe(record.target)}`
                            + (record.type === 'attributes' && value === record.oldValue ? ' (unchanged)' : '');
                        seen[key] = (seen[key] ?? 0) + 1;
                    }
                });
                observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
                setTimeout(() => { observer.disconnect(); resolve(seen); }, 2000);
            }));
            console.log('   changes in 2 s:', JSON.stringify(changes, null, 1));
        }
        await wait(1000);
        await drawStats('with the settings open, 3 s untouched');
        for (let index = 0; index < 8; index++) {
            await aimAt('window', '.vp-settings-tab', index);
            await wait(250);
        }
        await drawStats('pointing along the tabs, 2 s');
        const vrTab = await page.evaluate(() => [...document.querySelectorAll('.vp-settings-tab')]
            .findIndex(tab => tab.textContent.trim() === 'VR'));
        await click('window', '.vp-settings-tab', vrTab);
        const depth = () => page.evaluate(() => JSON.parse(localStorage.getItem('vueport.xrView') ?? 'null')?.depth);
        await aimAt('window', 'input[type="range"]', 1, 0.1);
        await wait(200);
        await page.evaluate(() => window.__xr.hold('right', { trigger: true }));
        await wait(200);
        const pressedAt = await page.$eval('.vp-window input[type="range"]:nth-of-type(1)', () =>
            document.querySelectorAll('.vp-window input[type="range"]')[1].value);
        for (const along of [0.3, 0.5, 0.7, 0.9]) {
            await aimAt('window', 'input[type="range"]', 1, along);
            await wait(150);
        }
        const dragged = await page.evaluate(() => document.querySelectorAll('.vp-window input[type="range"]')[1].value);
        await page.evaluate(() => window.__xr.hold('right'));
        await wait(300);
        check('a slider follows the pointer while the trigger is held', Number(dragged) > Number(pressedAt) + 50,
            `${pressedAt} → ${dragged}, kept ${await depth()}`);
        await tap('right', { b: true });
        await wait(800);
        check('B leaves the settings be: they stay in the headset', await page.$('.vp-settings-window') !== null
            && await visible('window'), JSON.stringify(await heights()));
        await click('middle', '.vp-status-palette');
        check('the status bar opens the command palette', await page.$('.vp-pick') !== null);
        await tap('right', { b: true });
        await wait(800);
        check('and B closes it, the settings back in its place', await page.$('.vp-pick') === null
            && await page.$('.vp-settings-window') !== null);
        await click('tabs', '[data-control="macros"]');
        const activeTab = () => page.evaluate(() => document.querySelector('.vp-xr-panel-tab.active')?.dataset.control);
        check('a tab over the strip switches it', await activeTab() === 'macros', await activeTab());
        await click('tabs', '[data-control="macros"]');
        check('and the lit one keeps it', await activeTab() === 'macros', await activeTab());
        await click('tabs', '[data-control="cheats"]');
        check('the settings stay with any strip', await page.$('.vp-settings-window') !== null);
        await drawStats('opening the cheats');
        await wait(3000);
        await drawStats('with the cheats open, 3 s untouched');
        await click('aside', 'button.vp-button.secondary');
        await click('aside', '.vp-detail-hero-name');
        check('a text field pointed at brings up the keyboard', (await heights()).includes(540),
            JSON.stringify(await heights()));
        const before = await page.evaluate(() => document.activeElement?.value);
        const key = await page.evaluate(() => {
            const ui = window.__vueportXrUi;
            const placed = ui.keyboard.placed.find(candidate => candidate.label === 'x');
            const quad = ui.keyboardOverlay;
            window.__xr.aim('right', {
                x: quad.position.x + ((placed.x + placed.w / 2) / quad.pixels.width - 0.5) * quad.width,
                y: quad.position.y + (0.5 - (placed.y + placed.h / 2) / quad.pixels.height) * quad.height,
            });
            return placed.label;
        });
        await wait(200);
        await tap('right', { trigger: true });
        await wait(300);
        const typed = await page.evaluate(() => document.activeElement?.value);
        check('and a key typed goes into the field', typed === `${before}${key}`, `${before} → ${typed}`);
        await tap('right', { b: true });
        await wait(800);
        check('B leaves the field, and the keyboard goes', !(await heights()).includes(540), JSON.stringify(await heights()));
        await tap('left', { click: true });
        await wait(500);
        check('another stick click puts the interface away', JSON.stringify(await heights()) === '[672]',
            JSON.stringify(await heights()));
        check('a game paused by hand while it showed stays paused once it is away', await paused());
        await tap('left', { click: true });
        await wait(1500);
        await click('middle', '[data-control="pause"]');
        await wait(300);
        await tap('left', { click: true });
        await wait(500);
        const carried = !(await paused());
        await tap('left', { click: true });
        await wait(1500);
        const pausedAgain = await paused();
        await tap('left', { click: true });
        await wait(500);
        check('put away, the interface carries on with the game it paused', carried && pausedAgain && !(await paused()));
        await tap('left', { click: true });
        await wait(1500);
        await click('middle', '[data-control="network-shares"]');
        check('Network Shares pops up over the middle', await visible('popup'));
        await tap('right', { b: true });
        await wait(800);
        await click('middle', '[data-control="leave-vr"]');
        check('the X beside the controls, pointed at, leaves', await page.evaluate(() => window.__xr.ended));
    }
    if (uiProjection) {
        const before = await page.evaluate(() => window.__xr.read().lit);
        await tap('left', { menu: true });
        await wait(2000);
        const open = await page.evaluate(() => window.__xr.read().lit);
        if (process.env.XR_SNAPSHOT) {
            const { writeFile: write } = await import('node:fs/promises');
            const shot = await page.evaluate(() => window.__xr.snapshot(window.__xr.texture, ...window.__xr.size));
            await write(path.join(process.env.XR_SNAPSHOT, 'xr-eyes.png'), Buffer.from(shot.split(',')[1], 'base64'));
        }
        check('the menu button draws the interface into the eye buffers', open > before + 5000, `${before} → ${open}`);
        await tap('left', { menu: true });
        await wait(300);
        const closed = await page.evaluate(() => window.__xr.read().lit);
        check('and again takes it away', Math.abs(closed - before) < 2000, `${before} → ${closed}`);
    }
    const openVrSettings = async () => {
        await tap('left', { click: true });
        await wait(1500);
        const vrTab = await page.evaluate(() => [...document.querySelectorAll('.vp-settings-tab')]
            .findIndex(tab => tab.textContent.trim() === 'VR'));
        await click('window', '.vp-settings-tab', vrTab);
    };
    const closeVrSettings = async () => {
        await tap('left', { click: true });
        await wait(500);
    };
    const chooseBackdrop = index => click('window', '.vp-radio-option', index);
    if (passthrough) {
        check('a headset that can show the room is asked for a session that can',
            await page.evaluate(() => window.__xr.mode) === 'immersive-ar');
        check('which starts out covering it in black', await page.evaluate(() => window.__xr.cornerAlpha()) === 255);
        await openVrSettings();
        await chooseBackdrop(1);
        const now = await page.evaluate(() => ({ requested: window.__xr.requested, ended: window.__xr.ended }));
        check('Backdrop in the settings shows the room at once, in the same session',
            now.requested === 1 && !now.ended, JSON.stringify(now));
        check('the room showing wherever nothing is drawn', await page.evaluate(() => window.__xr.cornerAlpha()) === 0);
        check('around a screen of its own, black and all',
            await page.evaluate(() => window.__xr.opaqueBlack()) > 10000);
        check('the settings staying up, to say so', await page.evaluate(() => window.__xr.read().lit) > 0);
        check('kept for next time', await page.evaluate(() => localStorage.getItem('vueport.xrBackdrop')) === 'passthrough');
        await chooseBackdrop(2);
        check('a hologram makes the screen\'s black see-through',
            await page.evaluate(() => window.__xr.opaqueBlack()) < 100,
            String(await page.evaluate(() => window.__xr.opaqueBlack())));
        check('and leaves what the game lights up', (await page.evaluate(() => window.__xr.read())).lit > 1000);
        await chooseBackdrop(0);
        check('and black covers the room again', await page.evaluate(() => window.__xr.cornerAlpha()) === 255);
        check('kept as black', await page.evaluate(() => localStorage.getItem('vueport.xrBackdrop')) === 'black');
        await closeVrSettings();
    }
    if (passthroughQuad) {
        check('with quad layers, the room is covered by a backdrop under everything',
            await page.evaluate(() => window.__xr.backdropShown) === true);
        check('drawn opaque black',
            await page.evaluate(() => window.__xr.cornerAlpha(window.__xr.backdrop.tex)) === 255);
        await openVrSettings();
        await chooseBackdrop(1);
        check('passthrough takes the backdrop away', await page.evaluate(() => window.__xr.backdropShown) === false);
        check('in the same session', await page.evaluate(() => window.__xr.requested) === 1);
        check('the screen still opaque', await page.evaluate(() => window.__xr.quadLayer.blendTextureSourceAlpha) === false);
        await chooseBackdrop(2);
        check('a hologram has the compositor blend the screen by its alpha',
            await page.evaluate(() => window.__xr.quadLayer.blendTextureSourceAlpha) === true);
        check('which is clear where the game is black',
            await page.evaluate(() => window.__xr.opaqueBlack()) < 100,
            String(await page.evaluate(() => window.__xr.opaqueBlack())));
        await chooseBackdrop(0);
        await closeVrSettings();
    }
    if (ui) {
    } else if (leave === 'grips') {
        // both grips for a little over a second, with the controllers' own reading broken: the way out must not
        // depend on it
        await page.evaluate(() => {
            window.__xr.session.squeeze('squeezestart', 'left');
            window.__xr.session.squeeze('squeezestart', 'right');
        });
        await wait(600);
        check('both grips held only briefly stay in', await page.evaluate(() => !window.__xr.ended));
        await wait(700);
        check('held for a second, they leave', await page.evaluate(() => window.__xr.ended));
    } else {
        // the page isn't drawn while the headset shows the game (holdPage) and shows it again once the headset is left;
        // measured on the upper part of the page's screen, below which its toolbar fades
        const pageScreen = async () => {
            const box = await (await page.$('.vp-screen-picture > canvas:not([class])')).boundingBox();
            // the settings stay up over the page in a headset: out of the way for the look
            await page.addStyleTag({ content: '.vp-window-backdrop:has(> .vp-settings-window), .vp-xr-page-cover, .vp-body > .vp-panel-aside, .vp-xr-panel-tabs { visibility: hidden !important; } .vp-xr-layout .vp-screen-frame > * { visibility: visible !important; }' });
            const shot = await page.screenshot({
                encoding: 'base64', clip: { x: box.x, y: box.y, width: box.width, height: box.height * 0.7 },
            });
            return page.evaluate(async url => {
                const image = new Image();
                image.src = url;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0);
                const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
                let lit = 0;
                let hash = 0;
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) {
                        lit++;
                    }
                    hash = (hash * 31 + data[i] + data[i + 1] * 7 + data[i + 2] * 13) | 0;
                }
                return { lit, hash };
            }, `data:image/png;base64,${shot}`);
        };
        const held = await pageScreen();
        await wait(1500);
        const stillHeld = await pageScreen();
        // a game taken in once running leaves the page its last frame; one started in the headset, none
        check('the page is not drawn while the headset shows the game', held.hash === stillHeld.hash
            && (staleClick || held.lit < 1000), JSON.stringify([held, stillHeld]));
        // the page says it is in the headset, with the way back in and out (left for another of the headset's
        // windows, it is what shows); Resume starts a new session from the click, Leave ends it
        await page.evaluate(() => document.querySelectorAll('style').forEach(node => {
            if (node.textContent.includes('.vp-xr-page-cover')) {
                node.textContent = node.textContent.replace(', .vp-xr-page-cover,', ',');
            }
        }));
        check('the page is covered with a way back into the headset and out of it',
            await page.$('.vp-xr-page-cover .vp-button.secondary') !== null);
        const sessions = await page.evaluate(() => window.__xr.requested);
        await page.click('.vp-xr-page-cover .vp-button:not(.secondary)');
        // as long as the first session had, for a headset that stalls the audio to have it restarted
        await wait(4000);
        check('Resume VR goes in again from the click', await page.evaluate(requested =>
            window.__xr.requested === requested + 1 && !window.__xr.session?.ended, sessions));
        await page.click('.vp-xr-page-cover .vp-button.secondary');
        await wait(300);
        check('and Leave VR leaves', await page.evaluate(() => window.__xr.ended)
            && await page.$('.vp-xr-page-cover') === null);
        // a stalled clock is looked at again a little after leaving (EmulatorXrController.watchAudioClock)
        await wait(1500);
        await wait(1500);
        const shown = await pageScreen();
        check('and the page shows the game again', shown.lit > 1000 && shown.hash !== stillHeld.hash,
            JSON.stringify(shown));
    }
    await page.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
