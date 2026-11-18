// drives the real screen panel in Chromium: a VBC backdrop takes its colors from RGB555, not the legacy palette
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const puppeteer = (await import(require.resolve('puppeteer'))).default;
const bundle = await build({
    stdin: {
        contents: `export { ScreenPanel } from './browser/panels/emulator-screen-panel';
            export * from './common/vb-constants';`,
        resolveDir: fileURLToPath(new URL('../../core/src/', import.meta.url)),
        loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'probe',
});

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(() => {
        const { ScreenPanel, buildVbDisplayMode,
            VB_ANAGLYPH_PALETTES } = probe;
        const panel = new ScreenPanel('immersion-vbc-probe');
        panel.node.style.width = '900px';
        panel.node.style.height = '600px';
        document.body.appendChild(panel.node);
        panel.setDecoration({ kind: 'immersion', intensity: 1 });

        // display scale must never grow a canvas backing store; the Linux page renderer pays for every backing pixel on
        // the main thread
        const picture = panel.takeCanvas();
        panel.setScale('x2');
        const overlay = panel.node.querySelector('.vp-screen-overlay');
        panel.setHighlights([{ x: 10, y: 10, width: 20, height: 20, parallax: 0 }]);
        const scaled = {
            pictureBacking: [picture.width, picture.height],
            pictureCss: [picture.style.width, picture.style.height],
            overlayBacking: [overlay.width, overlay.height],
            overlayCss: [overlay.style.width, overlay.style.height],
            highlightPixel: Array.from(overlay.getContext('2d').getImageData(15, 15, 1, 1).data),
        };

        const rgb555 = ([r, g, b]) => r | g << 5 | b << 10;
        const grid = (left, right) => {
            const pixels = new Uint8Array(48 * 30 * 4);
            const l = rgb555(left), r = rgb555(right);
            for (let at = 0; at < pixels.length; at += 4) {
                pixels[at] = l;
                pixels[at + 1] = l >> 8;
                pixels[at + 2] = r;
                pixels[at + 3] = r >> 8;
            }
            return pixels.buffer;
        };
        const read = () => {
            const canvas = panel.node.querySelector('.vp-screen-glow');
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let strongest = [0, 0, 0];
            for (let at = 0; at < data.length; at += 4) {
                if (data[at] + data[at + 1] + data[at + 2]
                    > strongest[0] + strongest[1] + strongest[2]) {
                    strongest = [data[at], data[at + 1], data[at + 2]];
                }
            }
            return strongest;
        };

        panel.setDisplayMode(buildVbDisplayMode('left',
            [0xff0000, 0xff0000, 0xff0000, 0xff0000],
            VB_ANAGLYPH_PALETTES['red-cyan']));
        panel.pushBackdrop(grid([0, 31, 0], [0, 0, 31]), 48, 30, true);
        const left = read();

        panel.setDisplayMode(buildVbDisplayMode('right',
            [0xffff00, 0xffff00, 0xffff00, 0xffff00],
            VB_ANAGLYPH_PALETTES['red-cyan']));
        panel.pushBackdrop(grid([0, 31, 0], [0, 0, 31]), 48, 30, true);
        const right = read();

        panel.setDisplayMode(buildVbDisplayMode('anaglyph',
            [0, 0, 0, 0], VB_ANAGLYPH_PALETTES['red-cyan']));
        panel.pushBackdrop(grid([31, 0, 0], [0, 31, 0]), 48, 30, true);
        const anaglyph = read();
        panel.dispose();
        return { left, right, anaglyph, scaled };
    });
    assert.deepEqual(result.scaled, {
        pictureBacking: [384, 224],
        pictureCss: ['768px', '448px'],
        overlayBacking: [384, 224],
        overlayCss: ['768px', '448px'],
        highlightPixel: [0, 255, 0, 38],
    }, 'x2 is CSS-only and keeps both screen surfaces at logical resolution');
    assert.ok(result.left[1] > 240 && result.left[0] < 2 && result.left[2] < 2,
        `left VBC green became ${result.left}`);
    assert.ok(result.right[2] > 240 && result.right[0] < 2 && result.right[1] < 2,
        `right VBC blue became ${result.right}`);
    // Dubois red/cyan of red-left + green-right has red and green, no legacy tint
    assert.ok(result.anaglyph[0] > 100 && result.anaglyph[1] > 100 && result.anaglyph[2] < 20,
        `VBC Dubois halo became ${result.anaglyph}`);
    console.log('VBC immersion halo probe PASS');
} finally {
    await browser.close();
}
