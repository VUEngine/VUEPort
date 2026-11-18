// checks the frame blending settings on synthetic frames in real WebGL: smart mixes what flickers (also while moving)
// but keeps what only moves sharp, full mixes everything, off nothing; Swap Eyes moves the mask
// Usage: node tests/frame-blending-probe.mjs (after building vueport-core)
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
    if (!ok) { failures++; }
};

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer.\n');
    process.exit(0);
}

const bundle = await build({
    stdin: {
        contents: `
            import { VbRenderer } from 'vueport-core/lib/worker/vb-renderer';
            import { buildDisplayMode, VB_ANAGLYPH_PALETTES, VB_DEFAULT_ANAGLYPH_PALETTE_ID }
                from 'vueport-core/lib/common/vb-constants';
            window.probe = { VbRenderer, buildDisplayMode,
                anaglyph: VB_ANAGLYPH_PALETTES[VB_DEFAULT_ANAGLYPH_PALETTE_ID] };
        `,
        resolveDir: __dirname,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
});

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', error => console.log('page error:', error.message));
await page.setContent('<!doctype html><body></body>');
await page.addScriptTag({ content: bundle.outputFiles[0].text });

// present frames and read the brightness (red channel) at the given pixels of the last one. A frame is a list
// of rectangles lit in the left and/or right eye; everything else is dark
async function run(options) {
    return page.evaluate(({ renderingMode, blending, swapEyes, frames, probes }) => {
        const { VbRenderer, buildDisplayMode, anaglyph } = window.probe;
        // gray, so the red channel is the brightness
        const gray = [0x000000, 0x555555, 0xaaaaaa, 0xffffff];
        const mode = buildDisplayMode(renderingMode, gray, anaglyph, swapEyes, blending);
        const canvas = document.createElement('canvas');
        const renderer = new VbRenderer(canvas, mode);
        for (const [index, rects] of frames.entries()) {
            const pixels = new Uint8Array(384 * 224 * 4);
            for (const { x, y, w, h, left = true, right = false } of rects) {
                for (let row = y; row < y + h; row++) {
                    for (let column = x; column < x + w; column++) {
                        const at = (row * 384 + column) * 4;
                        pixels[at] = left ? 255 : 0;
                        pixels[at + 1] = right ? 255 : 0;
                    }
                }
            }
            renderer.present(pixels, false, index === 0 ? 'jump' : 'next');
        }
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext('2d');
        context.drawImage(canvas, 0, 0);
        const result = probes.map(([x, y]) => context.getImageData(x, y, 1, 1).data[0]);
        renderer.dispose();
        return result;
    }, { renderingMode: 'left', blending: 'smart', swapEyes: false, ...options });
}

const SHARP = 255;
// half and half in linear light, encoded again: brighter than 128
const isHalf = value => value > 150 && value < 230;
const sprite = (x, extra = {}) => ({ x, y: 100, w: 16, h: 16, ...extra });

console.log('\nFlicker in place');
{
    // shown, gone, shown: the A, B, A pattern, ending on a shown frame
    const frames = [[sprite(100)], [], [sprite(100)]];
    const [smart] = await run({ frames, probes: [[108, 108]] });
    const [full] = await run({ frames, blending: 'full', probes: [[108, 108]] });
    const [off] = await run({ frames, blending: 'off', probes: [[108, 108]] });
    check('smart mixes it to half', isHalf(smart), smart);
    check('the same as full', smart === full, `${smart} vs ${full}`);
    check('off shows it as drawn', off === SHARP, off);
    const [gone] = await run({ frames: [[], [sprite(100)], []], probes: [[108, 108]] });
    check('and half on the frames it is not drawn', isHalf(gone), gone);
}

console.log('\nMotion');
{
    const frames = [[sprite(100)], [sprite(104)], [sprite(108)]];
    const probes = [[110, 108], [105, 108], [123, 108]];
    const smart = await run({ frames, probes });
    const full = await run({ frames, blending: 'full', probes });
    check('smart keeps a moving sprite sharp', smart[0] === SHARP, smart[0]);
    check('and leaves no trail behind it', smart[1] === 0, smart[1]);
    check('and draws its leading edge in full', smart[2] === SHARP, smart[2]);
    check('where full trails it', full[1] > 0 && isHalf(full[2]), full.join(', '));
    const [first] = await run({ frames: [[sprite(100)], [sprite(104)]], probes: [[110, 108]] });
    check('with only two frames so far, smart does not mix', first === SHARP, first);
}

console.log('\nFlicker while moving');
{
    for (const step of [1, 2]) {
        const frames = [[sprite(100)], [], [sprite(100 + step)]];
        const [leading, middle] = await run({ frames, probes: [[100 + step + 15, 108], [108, 108]] });
        check(`${step} px: its leading edge is mixed like the rest`, isHalf(leading), leading);
        check(`${step} px: and so is its middle`, isHalf(middle), middle);
    }
}

console.log('\nEach eye on its own');
{
    const frames = [
        [sprite(100, { left: true, right: true })],
        [sprite(100, { left: true, right: false })],
        [sprite(100, { left: true, right: true })],
    ];
    const [left] = await run({ frames, renderingMode: 'left', probes: [[108, 108]] });
    const [right] = await run({ frames, renderingMode: 'right', probes: [[108, 108]] });
    check('the steady eye stays sharp', left === SHARP, left);
    check('the flickering eye is mixed', isHalf(right), right);
    const [swapped, swappedRight] = await run({
        frames, renderingMode: 'side-by-side', swapEyes: true, probes: [[108, 108], [384 + 108, 108]],
    });
    check('swapped, the right eye\'s flicker is mixed where it is shown, on the left', isHalf(swapped), swapped);
    check('and the steady picture on the right stays sharp', swappedRight === SHARP, swappedRight);
}

await browser.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
