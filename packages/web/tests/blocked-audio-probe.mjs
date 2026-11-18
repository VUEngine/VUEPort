/**
 * A page whose audio the browser will not start still has to play. Autoplay policy blocks an untouched page's audio
 * context, and Firefox leaves AudioContext.resume() pending until a gesture (Chrome resolves it and keeps the context
 * suspended). If Core.run awaited it, the machine would never start: a black picture, and no link pairing, as the
 * second player's window (opened by the first and never clicked, see web-link.ts) waits for a running game. Here Chrome
 * gets the Firefox behavior: resume() never settles and is counted, checking that the emulator does not wait for it
 * and that a later gesture still takes the audio along.
 *
 * Usage: node tests/blocked-audio-probe.mjs (after `yarn build`)
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
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
    if (!ok) {
        failures++;
    }
};

if (!existsSync(path.join(dist, 'index.html'))) {
    console.log('\nskipped: dist is not built\n');
    process.exit(0);
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
    '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const ROM = Buffer.alloc(8 * 131072);
{
    const header = ROM.length - 544;
    ROM.write('VUEPORT PROBE'.padEnd(20, ' '), header, 'ascii');
    ROM.write('VU', header + 25, 'ascii');
    ROM.write('VPRB', header + 27, 'ascii');
    ROM[header + 31] = 1;
}

const server = createServer(async (request, response) => {
    const url = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    if (url === '/probe.vb') {
        response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'access-control-allow-origin': '*',
        });
        response.end(ROM);
        return;
    }
    try {
        const body = await readFile(path.join(dist, url));
        response.writeHead(200, {
            'content-type': TYPES[path.extname(url)] ?? 'application/octet-stream',
        });
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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));

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

// resume() never settles here, as in Firefox until a gesture; calls are counted so the second attempt can be seen
await page.evaluateOnNewDocument(() => {
    window.__resumeCalls = 0;
    const real = AudioContext.prototype.resume;
    const waiting = [];
    let allowed = false;
    const release = () => {
        allowed = true;
        for (const resume of waiting.splice(0)) {
            resume();
        }
    };
    // capturing and registered before the page's own listeners, so the browser has decided before the emulator sees the
    // event
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
        window.addEventListener(type, release, true);
    }
    AudioContext.prototype.resume = function resume() {
        window.__resumeCalls++;
        if (allowed) {
            return real.call(this);
        }
        return new Promise(resolve => waiting.push(() => resolve(real.call(this))));
    };
});

const PICTURE = '.vp-screen-picture > canvas'
    + ':not(.vp-screen-overlay):not(.vp-screen-glow):not(.vp-screen-placeholder)';

const resumeCalls = () => page.evaluate(() => window.__resumeCalls);
const speed = () => page.$eval('.vp-status-value', el => el.textContent ?? '');
const running = text => /\d/.test(text) && !text.startsWith('0%');

console.log('\nA game whose audio the browser will not start');

// this page is never touched: ?rom= opens the cartridge on its own, as the second player's window does
await page.goto(`${origin}/index.html?rom=${encodeURIComponent(`${origin}/probe.vb`)}`,
    { waitUntil: 'networkidle0' });
await page.waitForSelector(PICTURE, { timeout: 20000 }).catch(() => undefined);
await wait(3000);

check('the picture appears', (await page.$$(PICTURE)).length === 1);
check('the audio was asked to start', await resumeCalls() > 0);

// the regression this guards: run used to wait on the resume that never settles, so the flag the link session
// waits for was never set, and the window sat on the welcome screen's ROM forever
check('the game counts as loaded, so a link session could start',
    await page.$('.vp-titlebar-button[data-control="link"]') !== null);
check('the machine is not emulating yet — the audio clocks it',
    !running(await speed().catch(() => '')));
check('and says so over the picture rather than leaving it blank',
    await page.$eval('.vp-screen-prompt', prompt =>
        !prompt.hidden && (prompt.textContent ?? '').trim() === 'Click to play').catch(() => false));

console.log('\nThe gesture the browser was holding out for');
const before = await resumeCalls();
await page.mouse.click(640, 400);
await wait(300);
check('a click asks the audio to start again', await resumeCalls() > before);

let reading = await speed().catch(() => '');
for (let attempt = 0; attempt < 12 && !running(reading); attempt++) {
    await wait(500);
    reading = await speed().catch(() => '');
}
check('and the machine starts emulating', running(reading), `speed reads "${reading}"`);
check('and the prompt is taken away again',
    await page.$eval('.vp-screen-prompt', prompt => prompt.hidden).catch(() => false));

const afterClick = await resumeCalls();
await page.mouse.click(640, 400);
await wait(300);
check('having asked once, it stops listening',
    await resumeCalls() === afterClick, 'the unlock listener was not taken down');

check('nothing errored throughout', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
