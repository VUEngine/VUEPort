/**
 * Checks the Display settings pane: all palettes on screen at once (anaglyph tints as chips, color ramps behind a group
 * filter); the preview is the real screen frame borrowed from the dock; with no game it shows the placeholder and a
 * Placeholder / Live image switch; scale and decoration reach the preview (Black frames it in black). Also checks the
 * Screenshots pane, the same component on its own settings: the follow-the-picture box, the controls it reveals, and
 * that a shot is written at the mode and scale they ask for.
 *
 * Usage: node tests/display-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile, readdir, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) { failures++; }
};

if (!existsSync(path.join(dist, 'index.html'))) {
    console.log('\nskipped: dist is not built\n');
    process.exit(0);
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
    '.png': 'image/png',
};
const server = createServer(async (request, response) => {
    const url = request.url === '/' ? '/index.html' : request.url.split('?')[0];
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

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'probe.vb');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 1;
    await writeFile(romPath, rom);
}

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer.\n');
    server.close();
    process.exit(1);
}

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
// react-color (the Chrome picker) still declares defaultProps on function components, which React 18.3 warns
// about. A known quirk of an unmaintained dependency, not a fault in this pane
const KNOWN_NOISE = /defaultProps will be removed from function components/;
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => {
    if (message.type() === 'error' && !KNOWN_NOISE.test(message.text())) {
        errors.push(message.text());
    }
});

await page.setRequestInterception(true);
page.on('request', request => {
    if (request.url().includes('api.vueport.net/pvb/')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function chooseDubois(value) {
    await page.click('.vp-window .vp-dropdown-control');
    await wait(100);
    await page.click(`.vp-window .vp-dropdown-option[data-value="${value}"]`);
    await wait(150);
}

async function openTab(name) {
    if (await page.$('.vp-window') === null) {
        await page.evaluate(() =>
            document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
        await wait(500);
    }
    await page.evaluate(wanted => {
        for (const tab of document.querySelectorAll('.vp-settings-tab')) {
            if (new RegExp(wanted, 'i').test(tab.textContent || '')) { tab.click(); return; }
        }
    }, name);
    await wait(700);
}

const openDisplay = () => openTab('display');

async function closeSettings() {
    // Escape, as the title bar's button routes to the Emulation pane and only closes when Emulation is showing
    await page.keyboard.press('Escape');
    await wait(300);
    if (await page.$('.vp-window') !== null) {
        await page.evaluate(() =>
            document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
        await wait(300);
    }
}

const paneText = () => page.evaluate(() =>
    document.querySelector('.vp-window-body')?.textContent ?? '');

const clickText = label => page.evaluate(text => {
    const window_ = document.querySelector('.vp-window');
    for (const el of window_?.querySelectorAll('*') ?? []) {
        if (el.children.length === 0 && (el.textContent || '').trim() === text) {
            el.click();
            return true;
        }
    }
    return false;
}, label);

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(500);

console.log('\nThe pane, with no game running');
await openDisplay();

check('the preview is on screen', await page.$('.vp-screen-preview') !== null);
check('and it is the real screen frame, borrowed',
    await page.$('.vp-screen-preview .vp-screen-frame') !== null);
check('the placeholder still fills it while no game runs', await page.evaluate(() => {
    const canvas = document.querySelector('.vp-screen-preview .vp-screen-placeholder');
    return canvas instanceof HTMLCanvasElement && !canvas.hidden
        && canvas.getBoundingClientRect().width > 1;
}));

const text = await paneText();
check('both palette groups are on screen at once',
    /Anaglyph Palette/i.test(text) && /Color Palette/i.test(text));
check('the color ramps sit behind a console filter', ['VB', 'GB', 'Super GB', 'Custom']
    .every(name => text.includes(name)));
check('the anaglyph tints are offered', /Red \/ Cyan/.test(text) && /Green \/ Magenta/.test(text));

check('a Placeholder / Live image switch sits under the preview',
    /Placeholder/.test(text) && /Live image/.test(text));

const liveOptionDisabled = () => page.evaluate(() => {
    for (const el of document.querySelectorAll('.vp-window div')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === 'Live image') {
            return el.classList.contains('disabled');
        }
    }
    return null;
});
check('Live image is disabled with no game running', (await liveOptionDisabled()) === true);
check('clicking it does nothing while disabled', (await clickText('Live image'))
    && (await wait(200), await page.evaluate(() => {
        const c = document.querySelector('.vp-screen-preview .vp-screen-placeholder');
        return c instanceof HTMLCanvasElement && !c.hidden;
    })));

console.log('\nThe group filter picks which ramps show');
check('VB shows a Virtual Boy palette', (await clickText('VB'))
    && (await wait(250), (await paneText()).includes('Coral')));
check('GB swaps in the GB set', (await clickText('GB'))
    && (await wait(250), (await paneText()).includes('GB Pocket')));
check('and it drops the Virtual Boy names', !(await paneText()).includes('Coral'));
check('Super GB swaps in the Super GB set', (await clickText('Super GB'))
    && (await wait(250), (await paneText()).includes('Super GB 1A')));

console.log('\nEach setting has a reset button by its title');
const enabledResets = () => page.$$eval('.vp-window-body button[title="Reset to Default"]',
    bs => bs.length);
await clickText('VB');
await wait(200);
// the reset sits in the section label's title row, and only once there is something to reset
const paletteTitleReset = () => page.evaluate(() => {
    for (const el of document.querySelectorAll('.vp-window div')) {
        const label = el.querySelector(':scope > label');
        if (label && /Color Palette/i.test(label.textContent || '')) {
            const button = el.querySelector(':scope > button');
            return button !== null && getComputedStyle(button).visibility !== 'hidden';
        }
    }
    return false;
});
check('the Color Palettes title carries no reset while it holds the default',
    !(await paletteTitleReset()));
const baseResets = await enabledResets();
check('picking a non-default color palette lights one up', await page.evaluate(() => {
    for (const b of document.querySelectorAll('.vp-window-body button')) {
        if ((b.textContent || '').trim() === 'White') { b.click(); return true; }
    }
    return false;
}) && (await wait(250), (await enabledResets()) === baseResets + 1)
    && await paletteTitleReset());
check('and its reset restores the default', await page.evaluate(() => {
    const bs = document.querySelectorAll('.vp-window-body button[title="Reset to Default"]');
    const b = bs[bs.length - 1];
    if (!b) { return false; }
    b.click();
    return true;
}) && (await wait(250), (await enabledResets()) === baseResets));

console.log('\nEditing a palette covers the whole left side');
check('the rendering mode, scale and decoration lead the left column',
    ['Rendering Mode', 'Scale', 'Screen Decoration'].every(t => text.includes(t)));
await clickText('Custom');
await wait(200);
check('a New Palette card adds one', await page.evaluate(() => {
    const w = document.querySelector('.vp-window');
    // the color grid's "New Palette" card is the last one, as the anaglyph row has a "New Palette" chip of its own
    const cards = [...(w?.querySelectorAll('button') ?? [])]
        .filter(b => /New Palette/.test(b.textContent || ''));
    const card = cards[cards.length - 1];
    if (!card) { return false; }
    card.click();
    return true;
}));
await wait(400);
check('its pencil opens an editor', await page.evaluate(() => {
    const w = document.querySelector('.vp-window');
    for (const b of w?.querySelectorAll('button') ?? []) {
        if (/^Edit /.test(b.getAttribute('aria-label') || '')) { b.click(); return true; }
    }
    return false;
}));
await wait(400);
check('the editor covers the rendering mode and the palettes', await page.evaluate(() => {
    const t = document.querySelector('.vp-window-body')?.textContent ?? '';
    return !/Rendering Mode/i.test(t) && !/Anaglyph colors/i.test(t) && /Back To List/i.test(t);
}));
check('the preview stays visible beside it',
    await page.$('.vp-screen-preview .vp-screen-frame') !== null);

console.log('\nThe color wells open the Chrome picker');
check('the levels are wells, not native color inputs',
    (await page.$$('.vp-window-body input[type="color"]')).length === 0
    && (await page.$$('.vp-window-body button[aria-haspopup="dialog"]')).length === 4);
check('clicking a well opens the picker', await page.evaluate(() => {
    document.querySelector('.vp-window-body button[aria-haspopup="dialog"]')?.click();
    return true;
}) && (await wait(300), (await page.$$('.chrome-picker')).length === 1));
check('the picker floats free of the scrolling pane',
    await page.$eval('.chrome-picker', el => {
        // rendered into <body>, not clipped inside the window's overflow
        return !el.closest('.vp-window-body');
    }));
await page.keyboard.press('Escape');
await wait(300);
check('Escape closes the picker but leaves the settings open',
    (await page.$$('.chrome-picker')).length === 0
    && await page.$('.vp-window') !== null);

await page.evaluate(() => document.querySelector('.vp-window .vp-panel-back')?.click());
await wait(300);
check('Back To List brings the settings back',
    /Rendering Mode/i.test(await paneText()));

console.log('\nAnaglyph profiles and custom filters are distinguished');
check('Amber / Blue identifies its Amber / Blue calibration', await page.evaluate(() =>
    [...document.querySelectorAll('.vp-window-body button')].some(button =>
        /Amber \/ Blue/.test(button.textContent ?? '') && /Amber \/ Blue/.test(button.title))));
check('a custom anaglyph palette can be added', await page.evaluate(() => {
    const button = [...document.querySelectorAll('.vp-window-body button')]
        .find(button => /New Palette/.test(button.textContent ?? ''));
    button?.click();
    return !!button;
}));
await wait(400);
check('the custom anaglyph editor opens', await page.evaluate(() => {
    const button = [...document.querySelectorAll('.vp-window-body button')]
        .find(button => /^Edit /.test(button.getAttribute('aria-label') ?? ''));
    button?.click();
    return !!button;
}));
await wait(300);
check('the editor offers an explicit channel-filter or Dubois profile',
    /Dubois Profile/.test(await paneText())
    && await page.evaluate(() => {
        document.querySelector('.vp-window .vp-dropdown-control')?.click();
        const values = [...document.querySelectorAll('.vp-window .vp-dropdown-option')]
            .map(option => option.getAttribute('data-value'));
        document.querySelector('.vp-window .vp-dropdown-control')?.click();
        return ['none', 'red-cyan', 'green-magenta', 'amber-blue', 'custom']
            .every(value => values.includes(value));
    })
    && (await page.$$('.vp-window-body button[aria-haspopup="dialog"]')).length === 2);
await chooseDubois('green-magenta');
await wait(300);
check('choosing a built-in Dubois profile is persisted on the custom palette',
    await page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem('vueport.settings') ?? '{}');
        return settings.customAnaglyphPalettes?.[0]?.duboisProfile === 'green-magenta';
    }));
await chooseDubois('custom');
await wait(300);
check('custom calibration reveals two editable 3x3 matrices',
    /Custom Dubois Matrices/.test(await paneText())
    && (await page.$$('.vp-window-body input[type="number"]')).length === 18);
const firstMatrixValue = await page.$('.vp-window-body input[type="number"]');
await firstMatrixValue.click();
await firstMatrixValue.evaluate(input => input.select());
await firstMatrixValue.type('0.75');
await page.keyboard.press('Tab');
await wait(300);
check('matrix coefficients are persisted in column-major arrays',
    await page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem('vueport.settings') ?? '{}');
        const palette = settings.customAnaglyphPalettes?.[0];
        return palette?.duboisProfile === 'custom'
            && palette.duboisMatrices?.left?.length === 9
            && palette.duboisMatrices?.right?.length === 9
            && palette.duboisMatrices.left[0] === 0.75;
    }));
await page.evaluate(() => document.querySelector('.vp-window .vp-panel-back')?.click());
await wait(300);

console.log('\nThe placeholder follows the rendering mode');
// the rendering-mode cards nest a diagram and a label, so match the button
const clickCard = label => page.evaluate(l => {
    for (const b of document.querySelectorAll('.vp-window-body button')) {
        if ((b.textContent || '').trim().toLowerCase() === l.toLowerCase()) { b.click(); return true; }
    }
    return false;
}, label);
const previewRatio = () => page.$eval('.vp-screen-preview', el => el.style.aspectRatio.replace(/\s/g, ''));
check('Left Eye previews at 384 / 224', (await clickCard('Left Eye'))
    && (await wait(300), (await previewRatio()) === '384/224'));
check('Side By Side widens the preview to two eyes', (await clickCard('Side By Side'))
    && (await wait(300), (await previewRatio()) === '768/224'));
check('HLI doubles both ways, keeping the screen\'s shape', (await clickCard('HLI'))
    && (await wait(300), (await previewRatio()) === '768/448'));
check('the still keeps drawing through the change', await page.evaluate(() => {
    const c = document.querySelector('.vp-screen-preview .vp-screen-placeholder');
    return c instanceof HTMLCanvasElement && !c.hidden
        && c.width === 768 && c.height === 448 && c.getBoundingClientRect().width > 1;
}));
check('Swap Eyes is offered with a mode that shows both eyes', await page.evaluate(() =>
    [...document.querySelectorAll('.vp-window-body *')]
        .some(el => el.children.length === 0 && (el.textContent || '').trim() === 'Swap Eyes')));
await clickCard('Left Eye');
await wait(300);
check('and not with a one-eye mode', await page.evaluate(() =>
    ![...document.querySelectorAll('.vp-window-body *')]
        .some(el => el.children.length === 0 && (el.textContent || '').trim() === 'Swap Eyes')));

console.log('\nThe decoration control reaches the preview');
check('the decoration control is in the settings column, not nested in the preview box',
    await page.evaluate(() => {
        const preview = document.querySelector('.vp-screen-preview');
        const controls = [...document.querySelectorAll(
            '.vp-window .vp-dropdown-control, .vp-window-body input')];
        return preview !== null && controls.every(el => !preview.contains(el))
            && /Screen Decoration/i.test(document.querySelector('.vp-window-body')?.textContent ?? '');
    }));

check('switching Decoration to Black is offered', await clickText('Black'));
await wait(400);
check('a black frame lands around the borrowed picture',
    await page.$('.vp-screen-preview .vp-screen-frame.vp-decoration-black') !== null);

console.log('\nThe immersion halo is light cast by the border, not a blurred copy');
check('switching Decoration to Immersion is offered', await clickText('Immersion'));
await wait(600);
const halo = await page.evaluate(() => {
    const glow = document.querySelector('.vp-screen-preview .vp-screen-glow');
    const picture = document.querySelector('.vp-screen-preview .vp-screen-placeholder');
    if (!(glow instanceof HTMLCanvasElement) || !picture) { return undefined; }
    const context = glow.getContext('2d');
    if (!context) { return undefined; }
    const w = glow.width, h = glow.height;
    const { data } = context.getImageData(0, 0, w, h);
    const lum = (x, y) => {
        const i = (y * w + x) * 4;
        return (data[i] + data[i + 1] + data[i + 2]) / 3;
    };
    // where the picture sits inside the field, read off the laid-out boxes rather than the panel's constants
    const box = glow.getBoundingClientRect();
    const shown = picture.getBoundingClientRect();
    const padX = Math.round((w * (1 - shown.width / box.width)) / 2);
    const padY = Math.round((h * (1 - shown.height / box.height)) / 2);
    const middle = Math.floor(w / 2);
    const bottom = h - 1 - padY;
    return {
        size: [w, h],
        padX,
        padY,
        below: Array.from({ length: padY + 1 }, (unused, step) => lum(middle, bottom + step)),
        aboveEdge: lum(middle, padY),
        belowEdge: lum(middle, bottom),
        corner: lum(0, h - 1),
        axis: lum(middle, h - 1),
        wider: box.width > shown.width,
        taller: box.height > shown.height,
    };
});
check('the halo is a small light field, not the frame',
    halo !== undefined && halo.size[0] > 2 && halo.size[0] < 384 && halo.size[1] < 224
    && halo.padX > 0 && halo.padY > 0);
// the one thing extruding an edge can never do: get dimmer with distance
check('the light falls off as it goes out', halo !== undefined
    && halo.below[0] > halo.below[halo.below.length - 1] * 2
    && halo.below.every((value, step) => step === 0 || value <= halo.below[step - 1] + 1));
check('and rounds off at the corners rather than filling them',
    halo !== undefined && halo.corner < halo.axis);
// this still is bright along the bottom and black across the top, so its light has to be too, the whole claim of
// an Ambilight
check('each edge throws its own light, not the frame\'s average',
    halo !== undefined && halo.belowEdge > halo.aboveEdge * 3);
check('the halo reaches past the picture on both axes',
    halo?.wider === true && halo?.taller === true);

// one slider drives both halos, so the same number must mean about the same strength. A flat ambient fill is full
// brightness everywhere, where the light field is nowhere near it, so ambient spends half the setting
const haloOpacity = () => page.$eval('.vp-screen-preview .vp-screen-glow',
    el => Number(getComputedStyle(el).opacity));
const immersionOpacity = await haloOpacity();
await clickText('Ambient');
await wait(400);
const ambientOpacity = await haloOpacity();
check('ambient spends half the intensity the light field does',
    immersionOpacity > 0 && Math.abs(ambientOpacity - immersionOpacity / 2) < 0.01);

check('switching it back to None clears it', (await clickText('None'))
    && (await wait(400), await page.$('.vp-screen-preview .vp-decoration-black') === null));

await closeSettings();
check('and the decoration does not stick once the pane is closed',
    await page.$('.vp-dock .vp-decoration-black') === null);

console.log('\nWith a ROM loaded');
await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(500);
const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await wait(2000);

await openDisplay();
check('the preview still borrows the frame', await page.$('.vp-screen-preview .vp-screen-frame') !== null);
check('Live image is enabled once a game is running', (await liveOptionDisabled()) === false);
check('a live picture is shown by default', await page.evaluate(() => {
    const preview = document.querySelector('.vp-screen-preview');
    const placeholder = preview?.querySelector('.vp-screen-placeholder');
    const live = [...(preview?.querySelectorAll('canvas') ?? [])].find(c =>
        !c.classList.contains('vp-screen-glow')
        && !c.classList.contains('vp-screen-overlay')
        && !c.classList.contains('vp-screen-placeholder'));
    return placeholder?.hidden === true && live !== undefined && !live.hidden
        && live.getBoundingClientRect().width > 1;
}));
// a running game's halo comes from the worker's own averaging, a different path that has to survive a round trip
check('a running game feeds the halo from the worker grid', (await clickText('Immersion'))
    && (await wait(900), await page.evaluate(() => {
        const glow = document.querySelector('.vp-screen-preview .vp-screen-glow');
        return glow instanceof HTMLCanvasElement && glow.width > 2 && glow.width < 384;
    })));
await clickText('None');
await wait(300);

await clickText('VB');
await wait(250);
check('choosing a different color ramp does not throw', await page.evaluate(() => {
    const window_ = document.querySelector('.vp-window');
    for (const el of window_?.querySelectorAll('button') ?? []) {
        if ((el.textContent || '').trim() === 'White') { el.click(); return true; }
    }
    return false;
}));
await wait(300);
check('switching the preview to Placeholder swaps the still back in',
    (await clickText('Placeholder')) && (await wait(300), await page.evaluate(() => {
        const canvas = document.querySelector('.vp-screen-preview .vp-screen-placeholder');
        return canvas instanceof HTMLCanvasElement && !canvas.hidden
            && canvas.getBoundingClientRect().width > 1;
    })));

await closeSettings();
check('the dock picture survived the pane', await page.$('.vp-dock canvas') !== null);

console.log('\nThe Screenshots pane');
await openTab('screenshots');
check('the rail is alphabetical, with About apart at its foot', await page.$$eval('.vp-settings-tab',
    tabs => {
        const names = tabs.map(tab => tab.textContent.trim());
        const foot = names.pop();
        return foot === 'About VUEPort'
            && names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|');
    }));
const shotsText = () => page.evaluate(() =>
    document.querySelector('.vp-window-body')?.textContent ?? '');
check('it follows the picture until told otherwise', await page.evaluate(() => {
    const box = document.querySelector('.vp-window-body button.vp-switch');
    return box instanceof HTMLButtonElement && box.getAttribute('aria-checked') === 'true';
}) && !/Rendering Mode/i.test(await shotsText()));

const untick = () => page.evaluate(() =>
    document.querySelector('.vp-window-body button.vp-switch')?.click());
await untick();
await wait(500);
const revealed = await shotsText();
check('unticking reveals the mode, the scale and a color palette',
    /Rendering Mode/i.test(revealed) && /Scale/i.test(revealed) && /Color Palette/i.test(revealed));
check('and not the anaglyph palette, which this mode does not use',
    !/Anaglyph Palette/i.test(revealed));
check('the scale is a number, not the display pane\'s stops',
    !/Stretch/i.test(revealed) && await page.$('.vp-window-body input[type=number]') !== null);

const clickShotCard = label => page.evaluate(wanted => {
    for (const button of document.querySelectorAll('.vp-window-body button')) {
        if ((button.textContent || '').trim() === wanted) { button.click(); return true; }
    }
    return false;
}, label);
check('choosing Anaglyph offers the glasses profile and not the color palette, which it filters gray',
    (await clickShotCard('Anaglyph')) && (await wait(500), await (async () => {
        const now = await shotsText();
        return /Anaglyph Palette/i.test(now) && !/Color Palette/i.test(now);
    })()));

await clickShotCard('Side By Side');
await wait(400);
check('a screenshot palette is not the display\'s', await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('vueport.settings') ?? '{}');
    return stored.screenshotRenderingMode === 'side-by-side'
        && stored.renderingMode !== 'side-by-side';
}));

// and the shot itself, the only thing that settles it: side by side is 768 x 224, twice that 1536 x 448
check('the scale takes a number', await page.evaluate(() => {
    const field = document.querySelector('.vp-window-body input[type=number]');
    if (!(field instanceof HTMLInputElement)) { return false; }
    // React owns the value, so go through the native setter it listens past
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, '2');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}));
await wait(400);
check('and it is remembered', await page.evaluate(() =>
    JSON.parse(localStorage.getItem('vueport.settings') ?? '{}').screenshotScale === 2));

await closeSettings();
const shotDir = await mkdtemp(path.join(tmpdir(), 'vueport-shot-'));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: shotDir })
    .catch(() => cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: shotDir }))
    .catch(() => undefined);
// the toolbar's own button rather than its key, as the key handler listens on the dock, which has no focus after
// the dialog closed
check('the toolbar offers a screenshot', await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
        const named = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`;
        if (/screenshot/i.test(named)) { button.click(); return true; }
    }
    return false;
}));
let shot;
for (let tries = 0; tries < 40 && shot === undefined; tries++) {
    await wait(250);
    const written = (await readdir(shotDir)).filter(name => name.endsWith('.png'));
    if (written.length > 0) {
        const bytes = await readFile(path.join(shotDir, written[0]));
        // a PNG's IHDR carries the size at bytes 16 and 20, big-endian
        if (bytes.length > 24) {
            shot = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
        }
    }
}
check('a screenshot is written at the mode and scale the pane asked for',
    shot !== undefined && shot.width === 1536 && shot.height === 448);
if (shot !== undefined && (shot.width !== 1536 || shot.height !== 448)) {
    console.log(`       got ${shot.width}x${shot.height}`);
}

check('nothing errored throughout', errors.length === 0
    || (console.log('  ' + errors.slice(0, 5).join('\n  ')), false));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
