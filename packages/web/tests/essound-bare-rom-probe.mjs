/**
 * A browser cannot see the folder a ROM came from, so a .vbz's ESSound tracks are unpacked into the store under a
 * folder named for the ROM inside. A bare ROM of the same name, opened afterwards, must not take them for its own
 * (Super Metroid (Debug).vb would play the tracks of the Super Metroid (Debug).vbz beside it), while the archive
 * reopened from Recently Played, which keeps only the ROM, still finds them.
 *
 * Usage: node tests/essound-bare-rom-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` (${detail})`}`);
    if (!ok) {
        failures++;
    }
};
const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

// the page's own ZIP code, bundled for Node, to make a .vbz as the app does
const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const entry = path.join(scratch, 'zip-entry.ts');
await writeFile(entry, `export { storeZip } from ${JSON.stringify(
    fileURLToPath(new URL('../src/web-zip.ts', import.meta.url)))};`);
await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(scratch, 'zip.mjs'), logLevel: 'warning' });
const { storeZip } = await import(pathToFileURL(path.join(scratch, 'zip.mjs')).href);

const rom = Buffer.alloc(8 * 131072);
{
    const header = rom.length - 544;
    rom.write('ESSOUND BARE PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VESB', header + 27, 'ascii');
    rom[header + 31] = 3;
}
const NAME = 'Probe Game.vb';
const ARCHIVE = 'Probe Game.vbz';
const archive = Buffer.from(storeZip([
    { name: NAME, data: rom },
    { name: '1.mp3', data: new Uint8Array(64) },
    { name: '2.mp3', data: new Uint8Array(64) },
]));

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
page.on('pageerror', error => console.log('  pageerror', String(error)));
await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('api.vueport.net') || url.includes('virtual-boy.com')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

// as a file dropped on the window, the way a browser hands one over: a name and bytes, no folder
async function drop(name, bytes) {
    await page.evaluate((fileName, data) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(data)], fileName));
        document.getElementById('vp-root')
            .dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, name, [...bytes]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await settle(1500);
}

const tracks = () => page.$eval('[data-status="esSound"] .vp-status-value', el => el.textContent?.trim())
    .catch(() => undefined);

async function close() {
    await page.evaluate(() => document.querySelector('.vp-titlebar-rom-close')?.click());
    await page.waitForSelector('.vp-library-recent-card', { timeout: 10000 }).catch(() => undefined);
    await settle(500);
}

await page.goto(origin, { waitUntil: 'networkidle0' });

console.log('\nThe .vbz, dropped');
await drop(ARCHIVE, archive);
check('brings its ESSound tracks', await tracks() === '2 tracks', await tracks());
await close();

console.log('\nReopened from Recently Played');
{
    const recent = await page.$eval('.vp-library-recent-card button', el => el.getAttribute('title')).catch(() => undefined);
    check('which knows it by the archive', recent === ARCHIVE, recent);
    await page.click('.vp-library-recent-card button');
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await settle(1500);
    check('still finds the tracks the archive unpacked', await tracks() === '2 tracks', await tracks());
    await close();
}

console.log('\nThe bare ROM of the same name, dropped');
await drop(NAME, rom);
{
    const shown = await tracks();
    check('plays without them', !/track/.test(shown ?? ''), shown);
}

console.log('\nThe .vbz, dropped again');
await drop(ARCHIVE, archive);
check('has them back', await tracks() === '2 tracks', await tracks());

await browser.close();
server.close();
await rm(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
