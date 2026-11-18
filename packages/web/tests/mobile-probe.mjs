/**
 * Checks the phone layout (vueport-core's compact-layout.ts) on a phone-sized touch screen, upright and on its side.
 * The library's column is a drawer, with Open ROM in it. A game puts the picture at the top, under a band for the
 * badges, with the on-screen controller under it and no strip. Fingers hold buttons and d-pad directions, several at
 * once, and a key press puts the controller away until the next touch. A tap on the picture opens the game menu, a side
 * panel comes up as a sheet, the settings open on their list of panes, and swipes open and close them. A desktop-sized
 * window keeps the ordinary layout. Drives the real interface, nothing is exposed on `window`; controls are found by
 * `data-control`, as the labels are translated.
 *
 * Usage: node tests/mobile-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
    '.webp': 'image/webp', '.png': 'image/png',
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
    const rom = Buffer.alloc(1024 * 1024);
    rom.write('VUEPORT PROBE'.padEnd(20, ' '), rom.length - 544, 'ascii');
    await writeFile(romPath, rom);
}

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer:\n'
        + '  yarn add --dev -W puppeteer\n');
    server.close();
    process.exit(1);
}
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_ON_ITS_SIDE = { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true };

async function openPage(viewport) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.emulate({ viewport, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
    // Planet VB is not asked, the shelves stay empty: the probe is about the layout
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (request.url().includes('api.vueport.net')) {
            request.respond({
                status: 200, contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' }, body: '[]',
            });
            return;
        }
        request.continue();
    });
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await sleep(800);
    return { page, errors };
}

const rootClasses = page => page.evaluate(() => [...document.documentElement.classList]
    .filter(name => name.startsWith('vp-compact')).sort());
const shown = (page, selector) => page.evaluate(selector => {
    const element = document.querySelector(selector);
    if (!element) {
        return false;
    }
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
        && box.right > 0 && box.left < window.innerWidth;
}, selector);
const centreOf = (page, selector) => page.evaluate(selector => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height }
        : undefined;
}, selector);
const click = (page, selector) => page.evaluate(selector => {
    const element = document.querySelector(selector);
    element?.click();
    return element !== null;
}, selector);

async function swipe(page, from, to) {
    const finger = await page.touchscreen.touchStart(from.x, from.y);
    for (let step = 1; step <= 4; step++) {
        await finger.move(from.x + (to.x - from.x) * step / 4, from.y + (to.y - from.y) * step / 4);
    }
    await finger.end();
    await sleep(500);
}

async function startGame(page) {
    await click(page, '[data-control="library-drawer"]');
    await sleep(400);
    const [chooser] = await Promise.all([page.waitForFileChooser(), click(page, '.vp-library-side-foot .vp-button')]);
    await chooser.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await sleep(1500);
    // a finger beside the picture (one on it opens the menu): the controller is there for whoever plays by touch
    await page.touchscreen.tap(3, Math.round(page.viewport().height / 2));
    await sleep(300);
}

section('A phone held upright, before a game');
const { page, errors } = await openPage(PHONE);
{
    check('the page knows it is a phone held upright', await rootClasses(page), ['vp-compact', 'vp-compact-portrait']);
    check('the status bar, which names keys, is gone', await shown(page, '.vp-status'), false);
    check('the library\'s column is put away', await shown(page, '.vp-library-side'), false);
    check('Open ROM is in the drawer, not floating over the shelf', await page.$('.vp-library-fab'), null);

    check('the title bar ends in shares, settings and fullscreen', await page.$$eval(
        '.vp-titlebar-compact > .vp-titlebar-button', nodes => nodes.slice(-3).map(node => node.dataset.control)),
        ['network-shares', 'settings', 'fullscreen']);
    check('the title bar has the way into the column', await click(page, '[data-control="library-drawer"]'), true);
    await sleep(400);
    check('which pulls it out as a drawer', await shown(page, '.vp-library-side.open'), true);
    await click(page, '.vp-library-drawer-backdrop');
    await sleep(400);
    check('and the backdrop puts it away again', await shown(page, '.vp-library-side'), false);

    await swipe(page, { x: 6, y: 420 }, { x: 140, y: 425 });
    check('a swipe in from the left edge pulls it out too', await shown(page, '.vp-library-side.open'), true);
    await swipe(page, { x: 200, y: 420 }, { x: 40, y: 425 });
    check('and a swipe to the left puts it away', await shown(page, '.vp-library-side'), false);
    await swipe(page, { x: 6, y: 420 }, { x: 140, y: 425 });
    await page.evaluate(() => history.back());
    await sleep(500);
    check('as does the device\'s Back', await shown(page, '.vp-library-side'), false);

    await swipe(page, { x: 6, y: 420 }, { x: 140, y: 425 });
    await click(page, '.vp-titlebar-compact [data-control="settings"]');
    await sleep(600);
    check('the settings coming out put the column away', [await shown(page, '.vp-library-side'),
        await shown(page, '.vp-settings-listing')], [false, true]);
    await click(page, '[data-control="library-drawer"]');
    await sleep(600);
    check('and the column coming out puts the settings away', [await page.$('.vp-settings-window'),
        await shown(page, '.vp-library-side.open')], [null, true]);
    await click(page, '.vp-library-drawer-backdrop');
    await sleep(400);

    await swipe(page, { x: 386, y: 420 }, { x: 250, y: 425 });
    check('a swipe in from the right edge opens the settings', await shown(page, '.vp-settings-listing'), true);
    await page.evaluate(() => history.back());
    await sleep(500);
    check('which Back closes', await page.$('.vp-settings-window'), null);
}

section('Playing upright');
{
    await startGame(page);
    check('the picture, then the controller, and no strip', await page.evaluate(() => {
        const box = selector => document.querySelector(selector)?.getBoundingClientRect();
        const host = box('.vp-dock-host');
        const canvas = box('.vp-dock canvas:not([hidden]):not(.vp-screen-glow)');
        const touch = box('.vp-touch');
        return host !== undefined && canvas !== undefined && touch !== undefined
            && canvas.bottom <= touch.top + 1 && document.querySelector('.vp-strip') === null;
    }), true);
    check('with a band above the picture for the badges', await page.evaluate(() => {
        const host = document.querySelector('.vp-dock-host').getBoundingClientRect();
        const canvas = document.querySelector('.vp-dock canvas:not([hidden]):not(.vp-screen-glow)').getBoundingClientRect();
        return canvas.top - host.top >= 36;
    }), true);
    check('drawn half see-through by default', await page.$eval('.vp-touch', node => node.style.opacity), '0.5');
    check('the controller has all eight controls', await page.$$eval('.vp-touch-control', nodes => nodes
        .map(node => node.dataset.control).sort()), ['a', 'b', 'l', 'ldpad', 'r', 'rdpad', 'select', 'start']);

    // Select and Start mirror B and A: the outer one higher
    const select = await centreOf(page, '.vp-touch-control[data-control="select"]');
    const start = await centreOf(page, '.vp-touch-control[data-control="start"]');
    const b = await centreOf(page, '.vp-touch-control[data-control="b"]');
    const a = await centreOf(page, '.vp-touch-control[data-control="a"]');
    check('Select sits outside and above Start, as A does beside B',
        select.x < start.x && select.y < start.y && a.x > b.x && a.y < b.y, true);
    check('all four are round buttons of one size',
        [select, start, b].every(button => Math.round(button.width) === Math.round(a.width)), true);

    const thumb = await page.touchscreen.touchStart(a.x, a.y);
    await sleep(100);
    check('a finger on A holds it', await page.$('.vp-touch-control[data-control="a"] .vp-touch-round.held') !== null, true);

    const pad = await centreOf(page, '.vp-touch-control[data-control="ldpad"]');
    const other = await page.touchscreen.touchStart(pad.x + pad.width * 0.35, pad.y);
    await sleep(100);
    check('a second finger holds a d-pad direction beside it',
        await page.$$eval('.vp-touch-control[data-control="ldpad"] .vp-touch-held', nodes => nodes.length), 1);
    check('and A stays held', await page.$('.vp-touch-control[data-control="a"] .vp-touch-round.held') !== null, true);

    await other.move(pad.x + pad.width * 0.3, pad.y + pad.width * 0.3);
    await sleep(100);
    check('rolled between two arms it holds both',
        await page.$$eval('.vp-touch-control[data-control="ldpad"] .vp-touch-held', nodes => nodes.length), 2);

    await other.end();
    await thumb.end();
    await sleep(100);
    check('lifting both lets go of everything', await page.$$eval('.vp-touch .held, .vp-touch-held',
        nodes => nodes.length), 0);

    await page.$eval('.vp-screen', element => element.focus());
    await page.keyboard.down('KeyB');
    await page.keyboard.up('KeyB');
    await sleep(300);
    check('a key that plays the game puts the controller away', await page.$('.vp-touch'), null);
    await page.touchscreen.tap(3, 600);
    await sleep(300);
    check('and the next touch brings it back', await page.$('.vp-touch') !== null, true);
}

section('The menu, a panel and the settings');
{
    const picture = await centreOf(page, '.vp-dock canvas:not([hidden]):not(.vp-screen-glow)');
    await page.touchscreen.tap(picture.x, picture.y);
    await sleep(500);
    check('a tap on the picture opens the game menu', await shown(page, '.vp-quick-menu'), true);
    const sheet = await centreOf(page, '.vp-quick-menu-head');
    await swipe(page, { x: sheet.x - 60, y: sheet.y }, { x: sheet.x - 55, y: sheet.y + 140 });
    check('a swipe down closes it', await page.$('.vp-quick-menu'), null);
    await page.touchscreen.tap(picture.x, picture.y);
    await sleep(500);
    // the backdrop over the picture: the tap that closes the menu must not reach the picture and open it again
    await page.touchscreen.tap(picture.x, picture.y);
    await sleep(700);
    check('a tap beside it closes it, and only that', await page.$('.vp-quick-menu'), null);
    await page.touchscreen.tap(picture.x, picture.y);
    await sleep(500);
    check('which holds the whole strip and the title bar\'s buttons', await page.$$eval(
        '.vp-quick-menu-tile', nodes => ['reset', 'pause', 'rewind', 'save-state', 'screenshot', 'cheats',
            'achievements', 'network-shares'].every(id => nodes.some(node => node.dataset.control === id))), true);

    await click(page, '.vp-quick-menu-tile[data-control="cheats"]');
    await sleep(400);
    check('a panel picked there comes up as a sheet, not beside the picture',
        [await shown(page, '.vp-panel-sheet'), await shown(page, '.vp-panel-aside')], [true, false]);
    check('with the panel\'s tab lit', await page.$eval('.vp-panel-sheet-tab.active', node => node.dataset.control),
        'cheats');
    check('and the menu gone', await page.$('.vp-quick-menu'), null);
    await click(page, '.vp-panel-sheet-close');
    await sleep(400);
    check('the sheet closes', await page.$('.vp-panel-sheet'), null);

    await swipe(page, { x: 195, y: 838 }, { x: 198, y: 700 });
    check('a swipe up from the bottom edge opens the game menu', await shown(page, '.vp-quick-menu'), true);
    await page.evaluate(() => history.back());
    await sleep(500);
    check('which Back closes, the game staying', [await page.$('.vp-quick-menu'), await page.$('.vp-touch') !== null],
        [null, true]);

    await click(page, '.vp-titlebar-compact [data-control="settings"]');
    await sleep(800);
    check('the settings open on their list of panes', await shown(page, '.vp-settings-listing'), true);
    await page.evaluate(() => document.querySelector('.vp-settings-listing .vp-settings-tab')?.click());
    await sleep(600);
    check('a pane opens in its place, with the way back', await shown(page, '.vp-settings-back'), true);
    await click(page, '.vp-settings-back');
    await sleep(300);
    check('which leads to the list again', await shown(page, '.vp-settings-listing'), true);

    await page.evaluate(() => document.querySelector('.vp-settings-listing .vp-settings-tab')?.click());
    await sleep(600);
    await page.evaluate(() => history.back());
    await sleep(600);
    check('the device\'s Back leads from a pane to the list', await shown(page, '.vp-settings-listing'), true);
    await page.evaluate(() => history.back());
    await sleep(600);
    check('and from the list out of the settings', await page.$('.vp-settings-window'), null);
    await swipe(page, { x: 386, y: 300 }, { x: 250, y: 305 });
    check('swiped in from the right they open again', await shown(page, '.vp-settings-listing'), true);
    await swipe(page, { x: 120, y: 400 }, { x: 290, y: 405 });
    check('and swiped to the right they close', await page.$('.vp-settings-window'), null);
    check('the share button sits left of the settings', await page.evaluate(() => {
        const share = document.querySelector('.vp-titlebar-compact [data-control="network-shares"]');
        return share?.nextElementSibling?.getAttribute('data-control');
    }), 'settings');

    await page.evaluate(() => history.back());
    await sleep(1500);
    const asked = await page.$('.vp-modal');
    if (asked) {
        // "keep where you are?" on closing, which is not what is under test
        await page.evaluate(() => document.querySelectorAll('.vp-modal-buttons .vp-button')[1]?.click());
        await sleep(1000);
    }
    check('in the game Back leads to the library', await shown(page, '.vp-library'), true);
    check('and the page is still VUEPort', new URL(page.url()).origin, origin);
}
check('nothing errored upright', errors, []);
await page.close();

section('A phone on its side');
{
    const { page: side, errors: sideErrors } = await openPage(PHONE_ON_ITS_SIDE);
    check('the page knows it is a phone on its side', await rootClasses(side), ['vp-compact', 'vp-compact-landscape']);
    await startGame(side);
    check('the title bar makes room for the picture', await shown(side, '.vp-titlebar'), false);
    const shown_ = await side.evaluate(() => {
        const canvas = document.querySelector('.vp-dock canvas:not([hidden]):not(.vp-screen-glow)').getBoundingClientRect();
        const host = document.querySelector('.vp-dock-host').getBoundingClientRect();
        return { left: canvas.left, right: window.innerWidth - canvas.right, hostLeft: host.left, hostRight: window.innerWidth - host.right };
    });
    const dpad = await centreOf(side, '.vp-touch-control[data-control="ldpad"]');
    check('the picture keeps clear of the controller on both sides',
        Math.abs(shown_.left - shown_.right) <= 1 && shown_.left >= dpad.x + dpad.width / 2 - 2, true, );
    check('while the panel behind it, halo and all, reaches both edges',
        [shown_.hostLeft, shown_.hostRight], [0, 0]);
    check('without a strip', await side.$('.vp-strip'), null);
    const picture = await centreOf(side, '.vp-dock canvas:not([hidden]):not(.vp-screen-glow)');
    await side.touchscreen.tap(picture.x, picture.y);
    await sleep(500);
    const sheet = await side.evaluate(() => {
        const box = document.querySelector('.vp-sheet').getBoundingClientRect();
        return { left: box.left, right: window.innerWidth - box.right, bottom: window.innerHeight - box.bottom };
    });
    check('the game menu comes up from the middle of the bottom edge',
        Math.abs(sheet.left - sheet.right) <= 1 && sheet.left > 0 && sheet.bottom <= 1, true);

    await side.keyboard.press('Escape');
    await sleep(400);
    // the title bar's button, which on its side is out of the way while a game runs: the library has it too, and
    // fullscreen stays when the game starts. Pressed here the way the probe can reach it
    await side.evaluate(() => document.querySelector('.vp-titlebar-compact [data-control="fullscreen"]')?.click());
    await sleep(800);
    check('the title bar\'s fullscreen button puts the page in fullscreen',
        await side.evaluate(() => document.fullscreenElement !== null), true);
    check('where the picture takes the whole height, the controller over its edges', await side.evaluate(() => {
        const host = document.querySelector('.vp-body-fullscreen > .vp-dock-host')?.getBoundingClientRect();
        const canvas = document.querySelector('.vp-dock canvas:not([hidden]):not(.vp-screen-glow)')?.getBoundingClientRect();
        return host !== undefined && host.left === 0 && canvas !== undefined
            && canvas.height >= window.innerHeight * 0.9;
    }), true);
    if (process.env.MOBILE_SNAPSHOT) {
        await side.screenshot({ path: process.env.MOBILE_SNAPSHOT });
    }
    check('nothing errored on its side', sideErrors, []);
    await side.close();
}

section('A desktop window');
{
    const { page: desk, errors: deskErrors } = await openPage({ width: 1280, height: 800 });
    check('keeps the ordinary layout', await rootClasses(desk), []);
    check('with the library\'s column beside the shelf', await shown(desk, '.vp-library-side'), true);
    check('and no floating Open ROM', await shown(desk, '.vp-library-fab'), false);
    check('nothing errored on the desktop', deskErrors, []);
    await desk.close();
}

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
