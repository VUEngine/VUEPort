/**
 * Checks the receiving side of a LAN share in a real browser: the title bar's share button opens Network Shares, which
 * lists the shares api.vueport.net names for this network, asks each sharing computer whether it answers (one address
 * dead, one alive), shows its picture, and plays it from the moment it was shared (the state filed with the game's
 * states and loaded) or from the start (no state fetched). Also checks `?rom=…&state=…`, the address a desktop's
 * share redirects a typed-in visit to, and a share none of whose addresses answers. The sharing computer is a stand-in
 * speaking lan_share.rs's routes; the shell's own server has its own Rust tests.
 *
 * Usage: node tests/lan-share-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
    if (!ok) {
        failures++;
    }
};
const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

// the page's own ZIP code, bundled for Node, to make and read a .vbz as the app does
async function zipTools(scratch) {
    const entry = path.join(scratch, 'zip-entry.ts');
    await writeFile(entry, `export { storeZip, listZipEntries, readZipEntry } from ${JSON.stringify(
        fileURLToPath(new URL('../src/web-zip.ts', import.meta.url)))};`);
    const outfile = path.join(scratch, 'zip.mjs');
    await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'warning' });
    return import(pathToFileURL(outfile).href);
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

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const rom = Buffer.alloc(8 * 131072);
{
    const header = rom.length - 544;
    rom.write('LAN SHARE PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 3;
    await writeFile(path.join(scratch, 'probe.vb'), rom);
}
const { VbMachine } = require('vueport-core/lib/probe/vb-machine');
const { describeSaveState } = require('vueport-core/lib/common/emulator-save-state');
const core = await readFile(path.join(path.dirname(require.resolve('vueport-core/package.json')), 'wasm', 'shrooms', 'core.wasm'));
const machine = await VbMachine.create({ core, rom });
machine.runFrames(20);
const state = Buffer.from(await machine.saveState('Shared by Probe Mac'));
const thumbnail = Buffer.from(describeSaveState(state).meta.thumbnail);

// the sharing computer: lan_share.rs's routes, and a log of what was asked
const TOKEN = '0123456789abcdef01234567';
const NAME = 'Probe Game (J).vb';
let served = { name: NAME, bytes: rom };
const asked = [];
const share = createServer((request, response) => {
    asked.push(request.url);
    const cors = { 'access-control-allow-origin': request.headers.origin ?? '*', 'cache-control': 'no-store' };
    const [, token, what] = request.url.split('?')[0].split('/');
    if (token !== TOKEN) {
        response.writeHead(404, cors).end();
        return;
    }
    if (what === '') {
        response.writeHead(200, { ...cors, 'content-type': 'application/json' });
        response.end(JSON.stringify({ name: served.name, size: served.bytes.length, state: true, thumbnail: true }));
    } else if (what === 'rom') {
        response.writeHead(200, cors).end(served.bytes);
    } else if (what === 'state') {
        response.writeHead(200, cors).end(state);
    } else if (what === 'thumbnail.png') {
        response.writeHead(200, { ...cors, 'content-type': 'image/png' }).end(thumbnail);
    } else {
        response.writeHead(404, cors).end();
    }
});
await new Promise(resolve => share.listen(0, '127.0.0.1', resolve));
const shareAddress = `127.0.0.1:${share.address().port}`;

// a port nothing listens on, the way a VPN's address of the same computer fails
const dead = await new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => resolve(`127.0.0.1:${port}`));
    });
});

let shares = [];
const listed = (entries) => { shares = entries; };
const entry = (overrides = {}) => ({
    id: 'aaaaaaaaaaaaaaaa', device: 'Probe Mac', title: 'Probe Game', name: NAME, token: TOKEN,
    addresses: [dead, shareAddress], state: true, since: Math.floor(Date.now() / 1000) - 60, ...overrides,
});

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer.\n');
    server.close();
    share.close();
    process.exit(1);
}

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });

async function newPage() {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] });
    });
    page.on('pageerror', error => console.log('  pageerror', String(error)));
    await page.setRequestInterception(true);
    page.on('request', request => {
        const url = request.url();
        if (url.startsWith('https://api.vueport.net/lan-shares')) {
            request.respond({
                status: 200, contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ shares }),
            });
            return;
        }
        if (url.includes('api.vueport.net') || url.includes('virtual-boy.com')) {
            request.respond({
                status: 200, contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' }, body: '[]',
            });
            return;
        }
        request.continue();
    });
    return page;
}

const openSharesWindow = async (page) => {
    await page.click('.vp-titlebar-button[data-control="network-shares"]');
    await page.waitForSelector('.vp-vr', { timeout: 5000 });
};

const buttonsOf = (page) => page.evaluate(() => [...document.querySelectorAll('.vp-vr-share .vp-button')]
    .map(button => ({ text: button.textContent?.trim(), disabled: button.disabled })));

const stateRows = async (page) => {
    const open = await page.$('.vp-panel-aside .vp-states-row, .vp-panel-aside .vp-panel-empty-fill');
    if (!open) {
        await page.click('.vp-titlebar-button[data-control="save-states"]');
        await settle(500);
    }
    return page.evaluate(() => [...document.querySelectorAll('.vp-states-row')]
        .map(row => row.querySelector('.vp-panel-row-name')?.textContent ?? ''));
};

console.log('\nNetwork Shares without a game');
{
    listed([entry()]);
    const page = await newPage();
    await page.goto(origin, { waitUntil: 'networkidle0' });
    check('the title bar has a share button with no game open',
        await page.$('.vp-titlebar-button[data-control="network-shares"]') !== null);
    await openSharesWindow(page);
    check('it opens Network Shares', await page.$eval('.vp-window h2', el => el.textContent) === 'Network Shares');
    check('a browser is told sharing is VUEPort Desktop\'s',
        await page.$eval('.vp-vr', el => /share it in VUEPort Desktop/.test(el.textContent ?? '')));
    await page.waitForSelector('.vp-vr-share', { timeout: 5000 });
    check('the share is listed by title',
        await page.$eval('.vp-vr-share-title', el => el.textContent) === 'Probe Game');
    check('with the computer sharing it',
        await page.$eval('.vp-vr-share-meta', el => /^Probe Mac · since /.test(el.textContent ?? '')));
    await page.waitForFunction(() => [...document.querySelectorAll('.vp-vr-share .vp-button')]
        .every(button => !button.disabled), { timeout: 8000 }).catch(() => undefined);
    const buttons = await buttonsOf(page);
    check('it offers Continue and Start from the Beginning',
        JSON.stringify(buttons.map(button => button.text)) === '["Continue","Start from the Beginning"]',
        JSON.stringify(buttons));
    check('once the computer answers at one of its addresses', buttons.every(button => !button.disabled),
        JSON.stringify(buttons));
    await page.waitForSelector('.vp-vr-share-picture img', { timeout: 5000 }).catch(() => undefined);
    check('and the moment shared is pictured', await page.$('.vp-vr-share-picture img') !== null);
    check('nothing was downloaded just by looking', !asked.some(url => /\/(rom|state)/.test(url)), JSON.stringify(asked));

    console.log('\nContinue');
    asked.length = 0;
    await page.evaluate(() => [...document.querySelectorAll('.vp-vr-share .vp-button')]
        .find(button => button.textContent?.trim() === 'Continue')?.click());
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await settle(1500);
    check('the window closes', await page.$('.vp-vr') === null);
    check('the ROM and the state were fetched',
        asked.some(url => url.startsWith(`/${TOKEN}/rom/`)) && asked.includes(`/${TOKEN}/state`), JSON.stringify(asked));
    check('the ROM is fetched under its own name',
        asked.some(url => url === `/${TOKEN}/rom/${encodeURIComponent(NAME)}`), JSON.stringify(asked));
    check('nothing asks to resume', await page.$('.vp-modal') === null);
    const toasts = await page.evaluate(() => [...document.querySelectorAll('.vp-toast-text')].map(el => el.textContent));
    check('no error is shown', !toasts.some(text => /could not/i.test(text ?? '')), JSON.stringify(toasts));
    const rows = await stateRows(page);
    check('the moment is filed with the game\'s states, under its name', rows.includes('Shared by Probe Mac'),
        JSON.stringify(rows));
    await page.close();
}

console.log('\nStart from the Beginning');
{
    listed([entry({ id: 'bbbbbbbbbbbbbbbb' })]);
    asked.length = 0;
    const page = await newPage();
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await openSharesWindow(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.vp-vr-share .vp-button')]
        .some(button => button.textContent?.trim() === 'Start from the Beginning' && !button.disabled), { timeout: 8000 })
        .catch(() => undefined);
    await page.evaluate(() => [...document.querySelectorAll('.vp-vr-share .vp-button')]
        .find(button => button.textContent?.trim() === 'Start from the Beginning')?.click());
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await settle(1500);
    check('the ROM is fetched', asked.some(url => url.startsWith(`/${TOKEN}/rom/`)), JSON.stringify(asked));
    check('the state is not', !asked.includes(`/${TOKEN}/state`), JSON.stringify(asked));
    // the first page's continue left a state of this game in this browser; starting fresh must not offer it
    check('and nothing asks to resume', await page.$('.vp-modal') === null);
    await page.close();
}

console.log('\nThe address a share redirects to');
{
    asked.length = 0;
    const page = await newPage();
    const base = `http://${shareAddress}/${TOKEN}`;
    const query = `?rom=${encodeURIComponent(`${base}/rom/${encodeURIComponent(NAME)}`)}`
        + `&state=${encodeURIComponent(`${base}/state`)}`;
    await page.goto(`${origin}/${query}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await settle(1500);
    check('?rom= and &state= fetch both', asked.some(url => url.startsWith(`/${TOKEN}/rom/`))
        && asked.includes(`/${TOKEN}/state`), JSON.stringify(asked));
    const rows = await stateRows(page);
    check('and the state is filed and there', rows.filter(name => name === 'Shared by Probe Mac').length >= 1,
        JSON.stringify(rows));
    await page.close();
}

console.log('\nA share that does not answer');
{
    listed([entry({ id: 'cccccccccccccccc', addresses: [dead] })]);
    const page = await newPage();
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await openSharesWindow(page);
    await page.waitForSelector('.vp-vr-share-problem', { timeout: 10000 }).catch(() => undefined);
    check('it says it cannot be reached', await page.$('.vp-vr-share-problem') !== null);
    const buttons = await buttonsOf(page);
    check('and offers nothing to press', buttons.every(button => button.disabled), JSON.stringify(buttons));
    await page.close();
}

console.log('\nA game with ESSound tracks');
{
    const { storeZip } = await zipTools(scratch);
    served = {
        name: 'Probe Game (J).vbz',
        bytes: Buffer.from(storeZip([
            { name: NAME, data: rom },
            { name: '1.mp3', data: new Uint8Array(64) },
            { name: '2.mp3', data: new Uint8Array(64) },
            { name: 'essound.json', data: new TextEncoder().encode('{"tracks":{"1":{"title":"Intro"}}}') },
        ])),
    };
    listed([entry({ id: 'dddddddddddddddd' })]);
    const page = await newPage();
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await openSharesWindow(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.vp-vr-share .vp-button')]
        .some(button => button.textContent?.trim() === 'Start from the Beginning' && !button.disabled), { timeout: 8000 })
        .catch(() => undefined);
    await page.evaluate(() => [...document.querySelectorAll('.vp-vr-share .vp-button')]
        .find(button => button.textContent?.trim() === 'Start from the Beginning')?.click());
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await settle(1500);
    check('the .vbz is unpacked and the game runs', await page.$('.vp-dock canvas') !== null);
    const tracks = await page.$eval('[data-status="esSound"] .vp-status-value', el => el.textContent?.trim())
        .catch(() => undefined);
    check('with its ESSound tracks', tracks === '2 tracks', tracks);
    const shownName = await page.$eval('.vp-titlebar-rom-name', el => el.textContent?.trim());
    check('the title bar names the archive, not the ROM inside', shownName === 'Probe Game (J).vbz', shownName);
    await page.click('.vp-titlebar-rom');
    await page.waitForSelector('.vp-rom-info-cartridge-item', { timeout: 5000 });
    const file = await page.evaluate(() => [...document.querySelectorAll('.vp-rom-info-cartridge-item')]
        .find(row => row.querySelector('.vp-rom-info-cartridge-label')?.textContent === 'File')
        ?.querySelector('.vp-rom-info-cartridge-value')?.textContent);
    check('and Game Information says which ROM is inside', file === 'Probe Game (J).vb in Probe Game (J).vbz', file);
    await page.keyboard.press('Escape');
    await settle(300);
    // through the DOM: the control only shows on hover
    await page.evaluate(() => document.querySelector('.vp-titlebar-rom-close')?.click());
    await page.waitForSelector('.vp-library-recent-card', { timeout: 10000 }).catch(() => undefined);
    const recent = await page.$eval('.vp-library-recent-card button', el => el.getAttribute('title')).catch(() => undefined);
    check('Recently Played knows it by the archive too', recent === 'Probe Game (J).vbz', recent);
    await page.close();
    served = { name: NAME, bytes: rom };
}

console.log('\nNothing shared');
{
    listed([]);
    const page = await newPage();
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await openSharesWindow(page);
    await page.waitForFunction(() => /No game is shared/.test(document.querySelector('.vp-vr-shared')?.textContent ?? ''),
        { timeout: 5000 }).catch(() => undefined);
    check('it says so', await page.$eval('.vp-vr-shared', el => /No game is shared/.test(el.textContent ?? '')));
    await page.close();
}

await browser.close();
server.close();
share.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
