/**
 * A ROM must still open when the browser refuses OPFS: Firefox private windows and blocked site data reject
 * `navigator.storage.getDirectory()` with a DOMException, and keeping that refusal as the storage root makes `start`
 * throw. Chromium stands in, with Firefox's exception injected before the page's scripts run. See `web-storage.ts` and
 * `web-storage-memory.ts`.
 *
 * Usage: node tests/no-opfs-probe.mjs (after `yarn build`)
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
const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
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
    rom.write('NO OPFS PROBE'.padEnd(20, ' '), header, 'ascii');
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
// `start` reports failures through `onError`, which logs before it toasts
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

await page.evaluateOnNewDocument(() => {
    window.__opfsAsked = 0;
    StorageManager.prototype.getDirectory = function () {
        window.__opfsAsked++;
        return Promise.reject(new DOMException('Security error when calling GetDirectory', 'SecurityError'));
    };
});

await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('api.vueport.net')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

await page.goto(origin, { waitUntil: 'networkidle0' });

console.log('\nWith the origin-private file system refused');
const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
const started = await page.waitForSelector('.vp-dock canvas', { timeout: 20000 }).then(() => true, () => false);
await new Promise(resolve => setTimeout(resolve, 1500));

check('the page asked for it', await page.evaluate(() => window.__opfsAsked) > 0);
check('the ROM gets a screen', started);
// the screen goes up before the save RAM lookup, so it is not enough: the refusal showed as an error toast and
// the machine never ran
const failed = await page.$$eval('.vp-toast-error', nodes => nodes.map(node => node.textContent ?? ''));
check('and starts without an error', failed.length === 0, JSON.stringify(failed));
const toasts = await page.$$eval('.vp-toast-warn', nodes => nodes.map(node => node.textContent ?? ''));
check('the person is told files will not last',
    toasts.some(text => text.includes('SecurityError')), JSON.stringify(toasts));
check('and told once', toasts.filter(text => text.includes('SecurityError')).length === 1, JSON.stringify(toasts));
check('nothing threw', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
