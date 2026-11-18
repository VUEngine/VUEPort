/**
 * The command palette from a game pad: Home opens and closes it, the d-pad moves the highlight (once per press,
 * repeating while held), the bottom face button chooses and the right one backs out (standard Xbox layout), and a list
 * a command opens in the palette's place answers the same way. The pad is a fake navigator.getGamepads installed before
 * the page loads, pressed by flipping its buttons in place.
 *
 * Usage: node tests/gamepad-palette-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
    '.png': 'image/png', '.webp': 'image/webp',
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
const KNOWN_NOISE = /defaultProps will be removed from function components/;
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => {
    if (message.type() === 'error' && !KNOWN_NOISE.test(message.text())) {
        errors.push(message.text());
    }
});
await page.setRequestInterception(true);
page.on('request', request => {
    if (request.url().includes('api.vueport.net/')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

// an Xbox pad on the standard layout: Home is button 16, the d-pad 12–15, A (bottom) 0 and B (right) 1
await page.evaluateOnNewDocument(() => {
    const pad = {
        index: 0,
        id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
        mapping: 'standard',
        connected: true,
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOME = 16, DOWN = 13, UP = 12, CONFIRM = 0, BACK = 1;

async function press(index, holdMs = 120) {
    await page.evaluate(i => { window.__pad.buttons[i] = { pressed: true, touched: true, value: 1 }; }, index);
    await wait(holdMs);
    await page.evaluate(i => { window.__pad.buttons[i] = { pressed: false, touched: false, value: 0 }; }, index);
    await wait(150);
}

const pickOpen = () => page.evaluate(() => document.querySelectorAll('.vp-pick').length);
const activeIndex = () => page.evaluate(() => {
    const items = [...document.querySelectorAll('.vp-pick-item:not(.vp-pick-disabled)')];
    return items.findIndex(item => item.classList.contains('vp-pick-active'));
});

try {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await wait(1500);
    await page.evaluate(() => window.dispatchEvent(new Event('gamepadconnected')));
    await wait(200);

    console.log('\nHome');
    await press(HOME);
    check('Home opens the palette', await pickOpen() === 1);
    await press(HOME);
    check('and closes it again', await pickOpen() === 0);

    console.log('\nMoving');
    await press(HOME);
    const start = await activeIndex();
    await press(DOWN);
    await press(DOWN);
    check('two presses down move two entries', await activeIndex() === start + 2);
    await press(UP);
    check('one up moves back one', await activeIndex() === start + 1);
    const before = await activeIndex();
    await press(DOWN, 900);
    check('holding down repeats', await activeIndex() > before + 3);

    console.log('\nChoosing and backing out');
    await press(BACK);
    check('B backs out of the palette', await pickOpen() === 0);

    await press(HOME);
    await page.keyboard.type('Set Color Palette');
    await wait(200);
    await press(CONFIRM);
    const second = await page.evaluate(() =>
        document.querySelector('.vp-pick-filter')?.getAttribute('placeholder') ?? '');
    check('A chooses the highlighted command', await pickOpen() === 1 && !/command/i.test(second));
    await press(DOWN);
    check('the list it opened moves with the d-pad too', await activeIndex() === 1);
    await press(BACK);
    check('and B backs out of that one as well', await pickOpen() === 0);

    console.log('\nThe settings');
    const openInputSettings = async () => {
        await page.evaluate(() =>
            document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
        await wait(400);
        await page.evaluate(() => {
            for (const tab of document.querySelectorAll('.vp-settings-tab')) {
                if (/input/i.test(tab.textContent || '')) { tab.click(); return; }
            }
        });
        await wait(400);
    };
    await openInputSettings();
    await press(HOME);
    check('Home closes the settings rather than opening the palette over them',
        await pickOpen() === 0 && await page.$('.vp-settings-tabs') === null);
    await openInputSettings();
    await page.evaluate(() => {
        // the page tabs are a RadioSelect of plain styled elements: the one whose own text is the tab's name
        for (const option of document.querySelectorAll('div')) {
            if (option.children.length === 0 && (option.textContent || '').trim() === 'Game Pads') {
                option.click();
                return;
            }
        }
    });
    await wait(500);
    const paletteRow = await page.$$eval('.vp-input-row', list => list
        .map(row => ({
            name: row.querySelector('.vp-input-row-name')?.textContent ?? '',
            key: row.querySelector('.vp-input-key')?.textContent?.trim() ?? '',
        }))
        .find(row => row.name === 'Command Palette'));
    check('the Game Pads page lists the palette among the actions', paletteRow !== undefined);
    check('on the Xbox button', paletteRow?.key === 'Xbox');

    const sliders = () => page.$$eval('.vp-gamepad-deadzone', labels => labels.map(label => ({
        value: label.querySelector('input')?.value,
        reset: !label.querySelector('button')?.disabled,
    })));
    const atDefault = await sliders();
    check('neither slider offers a reset while it is at its default',
        atDefault.length === 2 && atDefault.every(slider => !slider.reset));
    await page.$$eval('.vp-gamepad-deadzone input', inputs => inputs.forEach(input => {
        // React's onChange hears the native setter plus an input event
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(input, '80');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    await wait(300);
    check('moved, both offer one', (await sliders()).every(slider => slider.reset));
    await page.$$eval('.vp-gamepad-deadzone button', buttons => buttons.forEach(button => button.click()));
    await wait(300);
    const after = await sliders();
    check('and it puts each back', JSON.stringify(after) === JSON.stringify(atDefault));

    check('no page errors', errors.length === 0);
    if (errors.length) {
        console.log(errors.join('\n'));
    }
} finally {
    await browser.close();
    server.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
