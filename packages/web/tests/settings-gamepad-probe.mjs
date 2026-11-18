/**
 * The settings window from a game pad: the first press shows where the pad is, shoulders turn tabs onto each pane's
 * first control while up/down in the rail stay there, the d-pad moves between controls, left/right move a slider or
 * segmented control to its end and then on, A opens a dropdown and B shuts it, B or Home close the window. The keyboard
 * does the same with arrows, Enter, Escape and Backspace. The pad is a fake standard Xbox pad, as in
 * gamepad-palette-probe.mjs.
 *
 * Usage: node tests/settings-gamepad-probe.mjs (after `yarn build`)
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

// normalized by the browser: Home is button 16, the d-pad 12–15, A (bottom) 0 and B (right) 1
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
const HOME = 16, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15, CONFIRM = 0, BACK = 1, LB = 4, RB = 5;

async function press(index, holdMs = 120) {
    await page.evaluate(i => { window.__pad.buttons[i] = { pressed: true, touched: true, value: 1 }; }, index);
    await wait(holdMs);
    await page.evaluate(i => { window.__pad.buttons[i] = { pressed: false, touched: false, value: 0 }; }, index);
    await wait(150);
}

const settingsOpen = () => page.evaluate(() => document.querySelector('.vp-settings-tabs') !== null);
const openTab = () => page.evaluate(() =>
    document.querySelector('.vp-settings-tab.active')?.textContent.trim());
const focused = () => page.evaluate(() => {
    const element = document.activeElement;
    const rail = element?.closest('.vp-settings-tabs') !== null && element?.closest('.vp-settings-tabs') !== undefined;
    return {
        zone: rail ? 'rail' : element?.closest('.vp-window-body') ? 'pane' : 'none',
        tab: element?.classList.contains('vp-settings-tab') ? element.textContent.trim() : undefined,
        type: element instanceof HTMLInputElement ? element.type : element?.getAttribute('role') ?? element?.tagName,
        value: element instanceof HTMLInputElement ? element.value : undefined,
        radio: element?.querySelector(':scope > .vp-radio-option') !== null
            ? [...element.querySelectorAll(':scope > .vp-radio-option')].findIndex(o => o.classList.contains('selected'))
            : undefined,
        expanded: element?.getAttribute('aria-expanded'),
    };
});
const onFirstStop = () => page.evaluate(() => {
    const body = document.querySelector('.vp-window-body');
    const first = [...body.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
        .find(element => element.tabIndex >= 0
            && !element.matches(':disabled, [aria-disabled="true"], .disabled, .vp-range-value, .ps__thumb-x, .ps__thumb-y')
            && element.getBoundingClientRect().width > 0);
    return first !== undefined && document.activeElement === first;
});
async function openSettings() {
    await page.evaluate(() =>
        document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
    await wait(800);
}
async function turnTo(label) {
    for (let i = 0; i < 20 && await openTab() !== label; i++) {
        await press(RB);
    }
    for (let i = 0; i < 20 && await openTab() !== label; i++) {
        await press(LB);
    }
    await wait(400);
}

try {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await wait(1500);
    await page.evaluate(() => window.dispatchEvent(new Event('gamepadconnected')));
    await wait(200);

    console.log('\nTurning tabs');
    await openSettings();
    check('the settings are open', await settingsOpen());
    const first = await openTab();
    await press(DOWN);
    let at = await focused();
    check('the first press puts focus on the open tab, and nothing else', at.zone === 'rail' && at.tab === first);
    check('and rings it', await page.evaluate(() =>
        document.querySelector('.vp-window')?.classList.contains('is-pad-steered')));
    await press(RB);
    const second = await openTab();
    await wait(400);
    check('the right shoulder turns to the next tab', second !== first);
    check('and puts focus on its first control', (await focused()).zone === 'pane' && await onFirstStop());
    await press(LB);
    await wait(400);
    check('the left shoulder turns back, onto the first control again',
        await openTab() === first && (await focused()).zone === 'pane' && await onFirstStop());

    console.log('\nA slider (VR)');
    await turnTo('VR');
    check('VR is reachable', await openTab() === 'VR');
    at = await focused();
    check('turning to it lands on its first control, the size slider', at.zone === 'pane' && at.type === 'range');
    const width = Number(at.value);
    await press(RIGHT);
    at = await focused();
    check('right moves the slider a step', Math.abs(Number(at.value) - (width + 0.1)) < 1e-9);
    check('and the setting with it', await page.evaluate(() =>
        JSON.parse(localStorage.getItem('vueport.xrView') ?? '{}').width) === Number(at.value));
    await press(LEFT);
    check('left moves it back', Number((await focused()).value) === width);
    await press(DOWN);
    at = await focused();
    check('down goes on to the next slider', at.type === 'range' && Number(at.value) !== width);

    console.log('\nA segmented control and a dropdown (Appearance)');
    await turnTo('Appearance');
    at = await focused();
    check('the pane starts at the color mode', at.zone === 'pane' && at.radio !== undefined);
    const mode = at.radio;
    await press(RIGHT);
    check('right picks the next mode', (await focused()).radio === mode + 1);
    await press(LEFT);
    check('left the one before', (await focused()).radio === mode);
    await press(DOWN);
    at = await focused();
    check('down reaches the language dropdown', at.type === 'combobox' && at.expanded === 'false');
    await press(CONFIRM);
    check('A opens it', (await focused()).expanded === 'true');
    await press(BACK);
    check('B shuts it', (await focused()).expanded === 'false');
    check('and leaves the settings open', await settingsOpen());
    await press(UP);
    for (let i = 0; i <= mode; i++) {
        await press(LEFT);
    }
    at = await focused();
    check('left past the first mode goes back to the rail', at.zone === 'rail' && at.tab === 'Appearance');
    await press(DOWN);
    const below = await openTab();
    await wait(400);
    check('down in the rail opens the tab below', below !== 'Appearance');
    at = await focused();
    check('and stays in the rail, on it', at.zone === 'rail' && at.tab === below);
    await press(UP);
    await wait(400);
    at = await focused();
    check('up opens the one above, still in the rail', await openTab() === 'Appearance' && at.tab === 'Appearance');

    console.log('\nClosing');
    await press(BACK);
    check('B closes the settings', !(await settingsOpen()));
    await openSettings();
    await press(HOME);
    check('Home closes them too', !(await settingsOpen()));
    check('and opens no palette', await page.evaluate(() => document.querySelectorAll('.vp-pick').length) === 0);

    console.log('\nA capture');
    await openSettings();
    await press(DOWN);
    const before = await openTab();
    await page.evaluate(() => {
        const strip = document.createElement('div');
        strip.className = 'vp-input-capture';
        document.querySelector('.vp-window-body')?.append(strip);
    });
    await press(DOWN);
    await press(BACK);
    check('while a button is being bound the pad steers nothing', await settingsOpen() && await openTab() === before);

    console.log('\nThe keyboard');
    await page.evaluate(() => document.querySelector('.vp-input-capture')?.remove());
    await page.evaluate(() => document.querySelector('.vp-window-close')?.click());
    await wait(300);
    await openSettings();
    const key = async name => { await page.keyboard.press(name); await wait(150); };
    const keyFirst = await openTab();
    await key('ArrowDown');
    at = await focused();
    check('the first arrow puts focus on the open tab', at.zone === 'rail' && at.tab === keyFirst);
    check('and rings it', await page.evaluate(() =>
        document.querySelector('.vp-window')?.classList.contains('is-pad-steered')));
    await key('ArrowDown');
    await wait(400);
    const keyBelow = await openTab();
    at = await focused();
    check('down in the rail opens the tab below, staying on it', keyBelow !== keyFirst && at.tab === keyBelow);
    await key('ArrowUp');
    await wait(400);
    for (let i = 0; i < 20 && await openTab() !== 'Appearance'; i++) {
        await key('ArrowDown');
        await wait(100);
    }
    for (let i = 0; i < 20 && await openTab() !== 'Appearance'; i++) {
        await key('ArrowUp');
        await wait(100);
    }
    await wait(400);
    check('the arrows reach Appearance', await openTab() === 'Appearance');
    await key('ArrowRight');
    at = await focused();
    check('right goes into the pane, onto the color mode', at.zone === 'pane' && at.radio !== undefined);
    const keyMode = at.radio;
    await key('ArrowRight');
    check('right picks the next mode', (await focused()).radio === keyMode + 1);
    await key('ArrowLeft');
    check('left the one before', (await focused()).radio === keyMode);
    await key('ArrowDown');
    at = await focused();
    check('down reaches the language dropdown', at.type === 'combobox' && at.expanded === 'false');
    await key('Enter');
    check('Enter opens it', (await focused()).expanded === 'true');
    await key('Escape');
    check('Escape shuts it', (await focused()).expanded === 'false');
    check('and leaves the settings open', await settingsOpen());
    await page.focus('.vp-settings-search input');
    await page.keyboard.type('xy');
    check('the search field takes typing', await page.evaluate(() =>
        document.querySelector('.vp-settings-search input')?.value === 'xy'));
    await key('Backspace');
    check('Backspace in it deletes, not closes', await settingsOpen() && await page.evaluate(() =>
        document.querySelector('.vp-settings-search input')?.value === 'x'));
    await key('Backspace');
    await key('ArrowDown');
    check('down leaves the search field', (await focused()).zone !== 'none');
    await key('Backspace');
    check('Backspace closes the settings', !(await settingsOpen()));
    await openSettings();
    await key('ArrowDown');
    await key('Escape');
    check('Escape closes them too', !(await settingsOpen()));

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
