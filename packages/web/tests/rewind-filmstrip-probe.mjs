/**
 * Checks the rewind filmstrip in a real browser, through the chrome: the Rewind button offers to switch rewind on; a
 * click then stops the game and lays the history out as thumbnails in place of the control strip; the arrow keys walk
 * it with the screen following; Esc returns to where it was opened and Enter plays on from the moment picked; the
 * Rewind key opens it just as the button does. Without a ROM it runs a blank one, whose thumbnails are all black; give
 * it a game to see them.
 *
 * Usage: node tests/rewind-filmstrip-probe.mjs [rom.vb] [screenshot-dir] (after `yarn build`)
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
const shots = process.argv[3];

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` \u2014 ${detail}` : ''}`);
    if (!ok) {
        failures++;
    }
};

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
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

let romPath = process.argv[2];
if (!romPath) {
    const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
    romPath = path.join(scratch, 'probe.vb');
    const rom = Buffer.alloc(16 * 131072);
    const header = rom.length - 544;
    rom.write('REWIND PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRW', header + 27, 'ascii');
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
await page.setViewport({ width: 1280, height: 800 });
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] });
});
// what the page tells the worker, to see which key mask the machine is left with
await page.evaluateOnNewDocument(() => {
    window.__sent = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
        if (message && (message.command === 'setKeys' || message.command === 'rewindSeek'
            || message.command === 'loadState')) {
            window.__sent.push({ command: message.command, keys: message.params?.keys });
        }
        return post.call(this, message, ...rest);
    };
});
// an Xbox pad on the standard layout, nothing pressed: the d-pad is 12–15, A 0, B 1, the shoulders 4 and 5
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
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

// no Planet VB: the title lookup answers empty, as a logged 404 would count as an error
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

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));
const shoot = async (name) => {
    if (shots) {
        await page.screenshot({ path: path.join(shots, `${name}.png`) });
    }
};

await page.goto(origin, { waitUntil: 'networkidle0' });
const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await settle(1500);
await page.evaluate(() => window.dispatchEvent(new Event('gamepadconnected')));

// the strip hides itself while the pointer rests, so the button is clicked through the DOM
const clickControl = (control) => page.evaluate(name =>
    document.querySelector(`.vp-strip-button[data-control="${name}"]`)?.click(), control);
const strip = () => page.evaluate(() => {
    const film = document.querySelector('.vp-rewind-strip');
    return film && {
        frames: film.querySelectorAll('.vp-rewind-frame').length,
        loaded: film.querySelectorAll('.vp-rewind-frame img').length,
        selected: [...film.querySelectorAll('.vp-rewind-frame')]
            .findIndex(frame => frame.classList.contains('vp-rewind-frame-selected')),
        time: film.querySelector('.vp-rewind-time')?.textContent ?? '',
        controlStrip: document.querySelector('.vp-strip') !== null,
    };
});

console.log('\nSwitching rewind on');
await clickControl('rewind');
await page.waitForSelector('.vp-modal', { timeout: 5000 });
check('the button offers to enable rewind',
    /rewind/i.test(await page.$eval('.vp-modal h2', el => el.textContent ?? '')));
check('and explains the filmstrip',
    /filmstrip/i.test(await page.$eval('.vp-modal', el => el.textContent ?? '')));
await page.evaluate(() => [...document.querySelectorAll('.vp-modal-buttons .vp-button')][1]?.click());
// enough history for several thumbnails, one a second
await settle(6500);

console.log('\nOpening the filmstrip');
await clickControl('rewind');
await page.waitForSelector('.vp-rewind-strip', { timeout: 5000 });
await settle(2500);
let state = await strip();
check('a click opens it', state !== null);
check('in place of the control strip', state && !state.controlStrip);
check('with a thumbnail about every second', state && state.frames >= 5, JSON.stringify(state));
check('each with its picture', state && state.loaded === state.frames, JSON.stringify(state));
check('the newest picked, with no time shown', state && state.selected === state.frames - 1 && state.time === '',
    JSON.stringify(state));
check('Cancel rather than a way back to now', await page.evaluate(() =>
    [...document.querySelectorAll('.vp-rewind-button')].some(button => button.textContent === 'Cancel')));
check('the hint names only the keys that pick', await page.$eval('.vp-rewind-hint', el =>
    !/enter|esc/i.test(el.textContent ?? '')));
await shoot('filmstrip-open');

console.log('\nWalking it');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await settle(600);
state = await strip();
check('two thumbnails back', state.selected === state.frames - 3, JSON.stringify(state));
check('which reads as seconds ago', /^\u2212\d:\d\d\.\d\d$/.test(state.time), state.time);
const twoBack = state.time;
await page.keyboard.down('Shift');
await page.keyboard.press('ArrowLeft');
await page.keyboard.up('Shift');
await settle(300);
state = await strip();
check('Shift steps a single frame', state.time !== twoBack && state.selected === state.frames - 3,
    `${twoBack} -> ${state.time}`);
await page.keyboard.press('Home');
await settle(600);
state = await strip();
check('Home goes to the oldest', state.selected === 0, JSON.stringify(state));
await shoot('filmstrip-oldest');

console.log('\nBacking out');
await page.keyboard.press('Escape');
await settle(800);
check('Esc closes it', (await strip()) === null);
check('the control strip is back', await page.evaluate(() => document.querySelector('.vp-strip') !== null));
check('and the game runs', await page.evaluate(() =>
    !document.querySelector('.vp-strip-button[data-control="pause"]')?.classList.contains('vp-strip-button-on')));

console.log('\nPlaying on from a moment');
await clickControl('rewind');
await page.waitForSelector('.vp-rewind-strip', { timeout: 5000 });
await settle(800);
const before = (await strip()).frames;
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await settle(600);
await page.keyboard.press('Enter');
await settle(1200);
check('Enter closes it', (await strip()) === null);
await clickControl('rewind');
await page.waitForSelector('.vp-rewind-strip', { timeout: 5000 });
await settle(800);
const after = (await strip()).frames;
check('what came after the moment is gone', after < before, `${before} -> ${after} thumbnails`);
await page.keyboard.press('Escape');
await settle(600);

console.log('\nOpening it paused');
await clickControl('pause');
await settle(400);
await clickControl('rewind');
await settle(800);
check('opens while paused too', (await strip()) !== null);
await page.keyboard.press('Escape');
await settle(600);
check('and backing out leaves it paused', await page.evaluate(() =>
    document.querySelector('.vp-strip-button[data-control="pause"]')?.classList.contains('vp-strip-button-on')));
await clickControl('pause');
await settle(1500);

console.log('\nThe Rewind key');
await page.focus('.vp-screen');
await page.keyboard.press('ArrowLeft');
await page.waitForSelector('.vp-rewind-strip', { timeout: 5000 });
await settle(800);
state = await strip();
check('opens it like the button, at the newest', state && state.selected === state.frames - 1, JSON.stringify(state));
await page.keyboard.press('ArrowLeft');
await settle(500);
state = await strip();
check('and pressed again walks back', state && state.selected === state.frames - 2, JSON.stringify(state));
await page.keyboard.press('Escape');
await settle(600);
check('Esc closes it', (await strip()) === null);
check('and the game runs again', await page.evaluate(() =>
    !document.querySelector('.vp-strip-button[data-control="pause"]')?.classList.contains('vp-strip-button-on')));

console.log('\nSteering it with a game pad');
const PAD_LEFT = 14, PAD_LB = 4, PAD_B = 1;
const press = async (index) => {
    await page.evaluate(i => { window.__pad.buttons[i] = { pressed: true, touched: true, value: 1 }; }, index);
    await settle(120);
    await page.evaluate(i => { window.__pad.buttons[i] = { pressed: false, touched: false, value: 0 }; }, index);
    await settle(200);
};
await clickControl('rewind');
await page.waitForSelector('.vp-rewind-strip', { timeout: 5000 });
await settle(800);
const opened = await strip();
await press(PAD_LEFT);
await settle(300);
let padState = await strip();
check('left on the d-pad goes a thumbnail back', padState.selected === opened.frames - 2, JSON.stringify(padState));
const thumbnailTime = padState.time;
await press(PAD_LB);
await settle(300);
padState = await strip();
check('a shoulder steps a single frame', padState.time !== thumbnailTime && padState.selected === opened.frames - 2,
    `${thumbnailTime} -> ${padState.time}`);
await press(PAD_B);
await settle(800);
check('B cancels', (await strip()) === null);
await settle(1000);

// the left d-pad's right (VbKey.LR) on its default key
const RIGHT = 0x0100;
const sentSince = () => page.evaluate(() => window.__sent.splice(0));
// the mask the machine was last given after the last restore, or undefined if none was sent since
const keysAfterRestore = (sent) => {
    const restored = sent.map(entry => entry.command).lastIndexOf(sent.findLast(entry => entry.command !== 'setKeys')?.command);
    return sent.slice(restored + 1).findLast(entry => entry.command === 'setKeys')?.keys;
};

console.log('\nHeld buttons do not outlive the filmstrip');
await page.focus('.vp-screen');
await page.keyboard.down('KeyF');
await settle(1500);
await sentSince();
await clickControl('rewind');
await page.waitForSelector('.vp-rewind-strip', { timeout: 5000 });
await settle(500);
await page.keyboard.press('ArrowLeft');
await settle(400);
await page.keyboard.up('KeyF');
await page.keyboard.press('Escape');
await settle(800);
let sent = await sentSince();
let keys = keysAfterRestore(sent);
check('after cancelling, the machine is told Right is up', keys !== undefined && (keys & RIGHT) === 0,
    JSON.stringify(sent));

await page.keyboard.down('KeyF');
await settle(1500);
await clickControl('rewind');
await page.waitForSelector('.vp-rewind-strip', { timeout: 5000 });
await settle(500);
await page.keyboard.press('ArrowLeft');
await settle(400);
await page.keyboard.up('KeyF');
await page.keyboard.press('Enter');
await settle(800);
sent = await sentSince();
keys = keysAfterRestore(sent);
check('after playing on from a moment, too', keys !== undefined && (keys & RIGHT) === 0, JSON.stringify(sent));

console.log('\nHeld buttons do not come back with a save state');
await page.focus('.vp-screen');
await page.keyboard.down('KeyF');
await settle(600);
await page.keyboard.press('Digit1');
await settle(1200);
await page.keyboard.up('KeyF');
await settle(300);
await sentSince();
await page.keyboard.press('Digit2');
await settle(1500);
sent = await sentSince();
keys = keysAfterRestore(sent);
check('after loading a state saved with Right held, Right is up', keys !== undefined && (keys & RIGHT) === 0,
    JSON.stringify(sent));

check('no errors on the page', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nThe filmstrip works.');
process.exit(failures ? 1 : 0);
