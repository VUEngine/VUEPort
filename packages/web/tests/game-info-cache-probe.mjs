// the Game Information window caches its Planet VB lookup for the session: opening it hits the catalog once, reopening
// shows the same entry without asking again or the "Looking this game up…" flash
// Usage: node tests/game-info-cache-probe.mjs   (after `yarn build`)
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
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
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

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'probe.vb');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('GAME INFO PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 3;
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
const errors = [];
page.on('pageerror', error => errors.push(String(error)));

let apiHits = 0;
await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    // the start page's featured list is a different call; answering with nothing keeps the homebrew strip hidden
    if (url.includes('/pvb/?featured')) {
        request.respond({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: '[]',
        });
        return;
    }
    // the window's CRC32 lookup (eight hex digits), addressed to the relay (vueport-server) rather than Planet VB; see
    // web-pvb-api.ts
    if (/api\.vueport\.net\/pvb\/[0-9a-f]{8}\//.test(url)) {
        apiHits++;
        request.respond({
            status: 200,
            contentType: 'application/json',
            // a real relay carries this header on its own reply; the probe adds it so the browser hands the reply back
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({
                id: 1,
                title: 'Probe Game',
                hash: { crc32: '00000000' },
                item: [{
                    id: 1, title: 'Probe Game', type: 'homebrew',
                    description: '<p>A game that exists only for this test.</p>',
                    company: [{ id: 1, name: 'Test Co', role: 'developer' }],
                    year: [{ id: 1, name: '1995' }],
                }],
            }),
        });
        return;
    }
    if (url.startsWith('https://files.virtual-boy.com')) {
        request.respond({ status: 404, body: '' });
        return;
    }
    request.continue();
});

await page.goto(origin, { waitUntil: 'networkidle0' });
const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await new Promise(resolve => setTimeout(resolve, 1500));

const toggleInfo = () => page.click('.vp-titlebar-rom');
const infoText = () => page.evaluate(() =>
    document.querySelector('.vp-rom-info')?.textContent ?? null);
const infoOpen = () => page.evaluate(() => !!document.querySelector('.vp-rom-info'));
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

console.log('\nFirst open');
await toggleInfo();
await settle();
check('the window shows the catalog entry', /Probe Game/.test(await infoText() ?? ''));
check('Planet VB was asked exactly once', apiHits === 1);

console.log('\nReopen');
await toggleInfo();
await settle();
check('the window closed', !(await infoOpen()));
await toggleInfo();
const immediate = await infoText();
await settle();
check('it shows the entry again', /Probe Game/.test(await infoText() ?? ''));
check('with no "looking up" flash', !/Looking this game up/i.test(immediate ?? ''));
check('and did not ask Planet VB a second time', apiHits === 1);

console.log('\nOver the settings');
await toggleInfo();
await settle();
await page.click('.vp-titlebar-button[data-control="settings"]');
await new Promise(resolve => setTimeout(resolve, 800));
const settingsUp = () => page.evaluate(() => !!document.querySelector('.vp-settings-tabs'));
check('the settings are open', await settingsUp());
const titleLabel = () => page.evaluate(() => document.querySelector('.vp-titlebar-rom')?.getAttribute('aria-label') ?? '');
check('the title offers the way back to the game', /^Back to /.test(await titleLabel()));
await page.hover('.vp-titlebar-rom');
await new Promise(resolve => setTimeout(resolve, 1500));
check('and its hover says so', await page.evaluate(() =>
    [...document.querySelectorAll('.vp-hover')].some(hover => hover.textContent.includes('Back to game'))));
await toggleInfo();
await settle();
check('the title closes them', !(await settingsUp()));
check('and opens no game information', !(await infoOpen()));
check('after which the title offers the game information again', /^Game information for /.test(await titleLabel()));
await toggleInfo();
await settle();
check('with none open it opens the game information again', await infoOpen());

check('nothing errored', errors.length === 0 || (console.log('  ' + errors.join('\n  ')), false));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
