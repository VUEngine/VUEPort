/**
 * What Recently Played keeps: the bytes only when there is nothing else to read them from. Three cases: a ROM opened
 * from the file picker is copied; once the library holds it, the copy is given up; and player two's window, which has
 * no gesture of its own to ask for a folder with, gets the game put where it can find it. See web-recent-roms.ts and
 * web-recent-origins.ts.
 *
 * Usage: node tests/recent-roms-probe.mjs (after `yarn build`)
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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
const errors = [];
const watch = page => {
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
};
const page = await browser.newPage();
watch(page);
await page.setViewport({ width: 1280, height: 800 });

// every catalog lookup is answered empty, so nothing reaches the live service or logs a failed request
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

// the game picture, as in the link probe: the one canvas meaning a game runs, not the glow, overlay or placeholder
const PICTURE = '.vp-screen-picture > canvas'
    + ':not(.vp-screen-overlay):not(.vp-screen-glow):not(.vp-screen-placeholder)';

const ROM_NAME = 'recent-probe.vb';
const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, ROM_NAME);
const romBytes = 8 * 131072;
{
    const rom = Buffer.alloc(romBytes);
    const header = rom.length - 544;
    rom.write('RECENT PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 1;
    await writeFile(romPath, rom);
}

const recentStore = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let directory;
    try {
        directory = await root.getDirectoryHandle('recent');
    } catch {
        return { entries: [], files: [] };
    }
    const files = [];
    for await (const name of directory.keys()) {
        files.push(name);
    }
    let entries = [];
    try {
        const handle = await directory.getFileHandle('index.json');
        entries = JSON.parse(await (await handle.getFile()).text());
    } catch {
        // no index yet, which the empty list says
    }
    return { entries, files };
});

// the writes are background work
const untilStore = async (predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
        const state = await recentStore();
        if (predicate(state)) {
            return state;
        }
        if (Date.now() >= deadline) {
            return state;
        }
        await wait(250);
    }
};

const copies = state => state.files.filter(name => name.endsWith('.rom'));

console.log('\nA ROM opened from a file, which there is no way back to');

await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(600);
const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector(PICTURE, { timeout: 20000 }).catch(() => undefined);
await wait(1500);

const opened = await untilStore(state => state.entries.length === 1);
check('the ROM is running', (await page.$$(PICTURE)).length === 1);
check('and is remembered', opened.entries.length === 1, JSON.stringify(opened.entries));
const romId = opened.entries[0]?.id ?? '';
check('with its bytes kept, since a browser cannot go back to the file',
    copies(opened).includes(`${romId}.rom`), JSON.stringify(opened.files));
check('and the entry says as much', opened.entries[0]?.linked !== true);

console.log('\nOnce the library holds the same ROM');

// an imported folder (a copy in this origin's storage), the one library kind a probe can seed without a directory
// picker. The ROM is Recently Played's copy, so both are the same cartridge to the byte
await page.evaluate(async (id, name, bytes) => {
    const root = await navigator.storage.getDirectory();
    const recent = await root.getDirectoryHandle('recent');
    const rom = await (await (await recent.getFileHandle(`${id}.rom`)).getFile()).arrayBuffer();
    const library = await root.getDirectoryHandle('library', { create: true });
    const folder = await (await library.getDirectoryHandle('imported', { create: true }))
        .getDirectoryHandle('f1', { create: true });
    const put = async (directory, file, contents) => {
        const writable = await (await directory.getFileHandle(file, { create: true })).createWritable();
        await writable.write(contents);
        await writable.close();
    };
    await put(folder, name, rom);
    await put(folder, 'index.json', JSON.stringify({
        version: 1,
        files: [{ path: name, name, bytes, modifiedAt: 1, store: name }],
    }));
    await put(library, 'index.json', JSON.stringify({
        version: 1,
        folders: [{ id: 'f1', name: 'Probe ROMs', kind: 'imported', addedAt: 1, readAt: 2, count: 1 }],
        entries: [{
            id,
            files: [{ folderId: 'f1', path: name, name, bytes, modifiedAt: 1 }],
            header: { name: 'RECENT PROBE', maker: 'VU', code: 'VPRB', version: 1 },
            bytes,
            addedAt: 1,
            lookedUpAt: 2,
            unmatched: true,
        }],
    }));
}, romId, ROM_NAME, romBytes);

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-recent-card', { timeout: 20000 });

const reclaimed = await untilStore(state => copies(state).length === 0);
check('the copy is handed back, now that the file itself can be read',
    copies(reclaimed).length === 0, JSON.stringify(reclaimed.files));
check('and the entry says it is read from where it lives',
    reclaimed.entries[0]?.linked === true, JSON.stringify(reclaimed.entries));

console.log('\nPlaying it again from Recently Played');

await page.click('.vp-library-recent-card button');
await page.waitForSelector(PICTURE, { timeout: 20000 }).catch(() => undefined);
await wait(1500);
check('the game starts from the library\'s own file',
    (await page.$$(PICTURE)).length === 1);
const played = await untilStore(state => state.entries.length === 1);
check('and playing it does not make a copy of it either',
    copies(played).length === 0 && played.entries[0]?.linked === true,
    JSON.stringify(played.files));

console.log('\nInviting a second player');

// the second window has no click of its own to ask the browser with, so the game has to be somewhere it can read;
// see RecentRoms.keep
const appeared = new Promise(resolve => browser.once('targetcreated', resolve));
await page.click('.vp-titlebar-button[data-control="link"]');
const target = await Promise.race([appeared, wait(10000).then(() => undefined)]);
const second = target && await target.page();
check('inviting opened a second window', !!second);

if (second) {
    watch(second);
    // its own requests too: otherwise an unknown checksum goes to the live service and comes back a 404 Chrome logs
    await second.setRequestInterception(true).catch(() => undefined);
    second.on('request', request => {
        if (request.url().includes('api.vueport.net/')) {
            request.respond({
                status: 200, contentType: 'application/json',
                headers: { 'access-control-allow-origin': '*' }, body: '[]',
            });
            return;
        }
        request.continue();
    });
    await second.setViewport({ width: 1280, height: 800 });
    const shared = await untilStore(state => copies(state).length === 1);
    check('the game is put back in the store for it to find',
        copies(shared).includes(`${romId}.rom`), JSON.stringify(shared.files));

    let started = false;
    for (let attempt = 0; attempt < 100 && !started; attempt++) {
        started = await second.evaluate(sel => document.querySelectorAll(sel).length === 1, PICTURE)
            .catch(() => false);
        if (!started) {
            await wait(250);
        }
    }
    check('and the second window opens it by itself', started);
    // paired over a BroadcastChannel once both machines are up, so waited for rather than read when the picture appears
    const linked = async (which, timeout = 15000) => {
        const deadline = Date.now() + timeout;
        for (;;) {
            if (await which.$('.vp-titlebar-pill.linked') !== null) {
                return true;
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await wait(250);
        }
    };
    check('both windows say they are linked',
        await linked(second) && await linked(page));
    await second.close();
    await wait(500);
}

console.log('\nAnd the copy it needed is not kept for good');

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-recent-card', { timeout: 20000 });
const tidied = await untilStore(state => copies(state).length === 0);
check('the next start hands it back again',
    copies(tidied).length === 0, JSON.stringify(tidied.files));
check('with the list itself none the worse',
    tidied.entries.length === 1 && tidied.entries[0]?.linked === true,
    JSON.stringify(tidied.entries));

console.log('\nStarting the last game by itself');

// the tightest timing: "Auto start last recent game" opens the newest entry as soon as the list is read back, before
// the library has read its own index, and that entry's bytes only the library has. See Library.ready
await page.evaluate(() => window.localStorage.setItem('vueport.autoStartRecent', 'true'));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector(PICTURE, { timeout: 25000 }).catch(() => undefined);
await wait(1500);
check('the game opens without anybody asking for it',
    (await page.$$(PICTURE)).length === 1);
const started = await untilStore(state => state.entries.length === 1);
check('and still from the library\'s file rather than a copy',
    copies(started).length === 0 && started.entries[0]?.linked === true,
    JSON.stringify(started.files));

check('nothing errored throughout', errors.length === 0
    || (console.log('  ' + errors.join('\n  ')), false));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
