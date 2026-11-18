// the status bar in the library with no cartridge: it says what the library is doing while it does it, and nothing
// about readings it has no answer for
// Usage: node tests/status-bar-probe.mjs (after `yarn build`)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
    '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon',
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
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

// every checksum is answered with a clean miss, slowly, so the catalog pass the strip reports lasts long enough to
// read: eight checksums four at a time, two questions each, several seconds, so a slow machine does not make it a race
const ANSWER_MS = 900;
await page.setRequestInterception(true);
page.on('request', async request => {
    const url = request.url();
    if (url.includes('virtual-boy.com') || url.includes('api.vueport.net')) {
        await new Promise(resolve => setTimeout(resolve, ANSWER_MS));
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ error: 'No ROM found.' }),
        });
        return;
    }
    request.continue();
});

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-status');

const shown = () => page.$$eval('.vp-status-item',
    els => els.map(el => el.getAttribute('data-status') ?? 'palette'));
const value = name => page.$eval(`[data-status="${name}"] .vp-status-value`,
    el => el.textContent.trim()).catch(() => undefined);

console.log('\nWith no cartridge in the machine');
const idle = await shown();
check('the speed is not shown at all, rather than shown as a dash',
    !idle.includes('speed'));
check('nor the rumble pack, nor ESSound, which have nothing to say either',
    !idle.includes('rumblePack') && !idle.includes('esSound'));
check('nor the controller, with none connected', !idle.includes('controller'));
check('what is left is the readings that do have an answer',
    JSON.stringify(idle) === JSON.stringify(['saveGameSlot', 'palette', 'hardware']));
check('and the slot still says which one', await value('saveGameSlot') === 'Slot A');

// the kit's hover rather than the browser's, so there is no title to read; its wait is SHOW_DELAY in dom-hover.ts,
// with room to spare here
await page.hover('[data-status="saveGameSlot"]');
await new Promise(resolve => setTimeout(resolve, 900));
const popup = await page.$eval('.vp-hover',
    el => getComputedStyle(el).visibility === 'visible' ? el.textContent : undefined)
    .catch(() => undefined);
check('and resting on it says what the diskette stands for', popup === 'Save Slot: A');

// read but never looked up, so the catalog pass runs on the next start, as after adding a folder and walking away
console.log('\nWhile the library is being brought up to date');
await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('library', { create: true });
    const file = await directory.getFileHandle('index.json', { create: true });
    const writable = await file.createWritable();
    const entry = (id, name) => ({
        id,
        files: [{ folderId: 'f1', path: `${name}.vb`, name: `${name}.vb`, bytes: 1048576, modifiedAt: 1 }],
        header: { name: name.toUpperCase(), maker: '01', code: 'VPRB', version: 0 },
        bytes: 1048576,
        addedAt: 1,
        // no lookedUpAt: never asked about, which is what starts the pass
        unmatched: false,
    });
    await writable.write(JSON.stringify({
        version: 1,
        folders: [{ id: 'f1', name: 'Virtual Boy', addedAt: 1, readAt: 2, count: 8 }],
        entries: [entry('c1', 'red-alarm'), entry('c2', 'teleroboxer'),
            entry('c3', 'golf'), entry('c4', 'jack-bros'),
            entry('c5', 'mario-clash'), entry('c6', 'wario-land'),
            entry('c7', 'panic-bomber'), entry('c8', 'vertical-force')],
    }));
    await writable.close();
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-status="library"]', { timeout: 15000 });

// read in one go, as the pass ends on its own and four questions would be four different moments
const entry = await page.evaluate(() => {
    const item = document.querySelector('[data-status="library"]');
    const strip = document.querySelector('.vp-status-left');
    return {
        first: strip?.firstElementChild?.getAttribute('data-status'),
        label: item?.querySelector('.vp-status-label')?.textContent,
        icon: item?.querySelector('.vp-status-icon svg') !== null,
        spinner: item?.querySelector('.vp-spinner') !== null,
        value: item?.querySelector('.vp-status-value')?.textContent,
        rest: [...document.querySelectorAll('.vp-status-item')]
            .map(el => el.getAttribute('data-status') ?? 'palette').slice(1).join('|'),
    };
});
check('an entry appears, at the far left of the strip', entry.first === 'library');
// the glyph is painted, the word is off screen for a screen reader and the hover (see the save slot below)
check('under the library\'s own name', entry.label === 'Library');
check('shown as a glyph rather than as that word', entry.icon);
check('with a spinner, because it is work rather than a reading', entry.spinner);
// the count left, which counts down to nothing; the surrounding sentence is the strip's to word and not spelt out here
check('and it says what is being done and how much of it is left',
    /\d/.test(entry.value ?? '') && (entry.value ?? '').length > 'Library'.length);
check('it does not push the rest of the strip about',
    entry.rest === 'saveGameSlot|palette|hardware');

console.log('\nWhen it is done');
await page.waitForSelector('[data-status="library"]', { hidden: true, timeout: 20000 });
check('the entry goes rather than sitting there saying nothing',
    !(await shown()).includes('library'));
check('and the strip is as it was',
    JSON.stringify(await shown()) === JSON.stringify(['saveGameSlot', 'palette', 'hardware']));

check('nothing errored', errors.length === 0);
if (errors.length > 0) {
    console.log(errors.slice(0, 5).join('\n'));
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
