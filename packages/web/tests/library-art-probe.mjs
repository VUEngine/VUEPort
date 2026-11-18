// box shots and backdrops are fetched once into library/art/ (with a note on their sources), the shelf and game page
// draw from those files even offline, and pictures no game names any more are swept away
// Usage: node tests/library-art-probe.mjs (after `yarn build`)
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

const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

// Planet VB stands in for itself: the catalog answers nothing, as every entry below was looked up already, and its
// file host answers pictures. How often it is asked is what is measured
let pictureRequests = 0;
// the file host down is what a start with no network is
let picturesDown = false;
await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('files.virtual-boy.com')) {
        pictureRequests++;
        if (picturesDown) {
            request.abort('failed');
            return;
        }
        request.respond({
            status: 200, contentType: 'image/png',
            headers: { 'access-control-allow-origin': '*' }, body: PIXEL,
        });
        return;
    }
    if (url.includes('virtual-boy.com') || url.includes('api.vueport.net')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

const seedLibrary = (games) => page.evaluate(async (entries) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('library', { create: true });
    const file = await directory.getFileHandle('index.json', { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify({
        version: 1,
        folders: [{ id: 'f1', name: 'Virtual Boy', addedAt: 1, readAt: 2, count: entries.length }],
        entries: entries.map(game => ({
            id: game.id,
            files: [{
                folderId: 'f1', path: `${game.id}.vb`, name: `${game.id}.vb`,
                bytes: 1048576, modifiedAt: 1,
            }],
            header: { name: game.title.toUpperCase(), maker: '01', code: 'VPRB', version: 0 },
            bytes: 1048576,
            addedAt: 1,
            catalog: {
                itemId: game.itemId, title: game.title, developer: 'Nintendo R&D1',
                publisher: 'Nintendo', released: '1995', genre: 'Platformer',
                players: '1 Player', region: 'NTSC-U', status: 'Released', kind: 'game',
                description: '', latest: true,
                covers: game.covers ?? [],
                backgrounds: game.backgroundUrl ? [{ name: 'Default', url: game.backgroundUrl }] : [],
            },
            lookedUpAt: 2,
            unmatched: false,
        })),
    }));
    await writable.close();
}, games);

const artFiles = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
        const library = await root.getDirectoryHandle('library');
        const art = await library.getDirectoryHandle('art');
        const names = [];
        for await (const name of art.keys()) {
            names.push(name);
        }
        return names.sort();
    } catch {
        return [];
    }
});

const artIndex = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
        const library = await root.getDirectoryHandle('library');
        const handle = await library.getFileHandle('art.json');
        return JSON.parse(await (await handle.getFile()).text());
    } catch {
        return undefined;
    }
});

const WARIO = {
    id: 'aaaaaaaa', itemId: 1, title: 'Virtual Boy Wario Land',
    covers: [
        // with a back: the faces a shelf turns to are kept too
        {
            name: 'North America',
            faces: {
                front: 'https://files.virtual-boy.com/games/1/wario-us-1024x1024.png',
                back: 'https://files.virtual-boy.com/games/1/wario-us-back.png',
                // seen only in the editor, which asks for it itself
                top: 'https://files.virtual-boy.com/games/1/wario-us-top.png',
            },
        },
        // kept in case the user picks this region's box
        { name: 'Japan', faces: { front: 'https://files.virtual-boy.com/games/1/wario-jp-1024x1024.png' } },
    ],
    backgroundUrl: 'https://files.virtual-boy.com/games/1/wario-backdrop.png',
};
const JACK = {
    id: 'bbbbbbbb', itemId: 2, title: 'Jack Bros.',
    covers: [{ name: 'Default', faces: { front: 'https://files.virtual-boy.com/games/2/jack-1024x1024.png' } }],
};
const keptOf = game => [
    ...game.covers.flatMap(cover => ['front', 'back', 'left', 'right'].map(face => cover.faces[face])),
    game.backgroundUrl,
].filter(Boolean);

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');
await seedLibrary([WARIO, JACK]);
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');

console.log('\nWhat the catalog named, once');
await page.waitForFunction(
    () => document.querySelectorAll('img.vp-library-cover[src^="blob:"]').length === 2,
    { timeout: 10000 });
await page.waitForFunction(async () => {
    const root = await navigator.storage.getDirectory();
    const library = await root.getDirectoryHandle('library');
    const art = await library.getDirectoryHandle('art');
    let count = 0;
    for await (const _ of art.keys()) {
        count++;
    }
    return count === 5;
}, { timeout: 10000 }).catch(() => undefined);
const files = await artFiles();
check('every picture lands in library/art/, beside the library\'s own files',
    files.length === 5);
check('under a name of its own, with the extension it came with',
    files.every(name => /^[0-9a-f]{8}[0-9a-z]+\.png$/.test(name)));
const index = await artIndex();
check('and library/art.json says which address each one came from',
    index?.version === 1 && Object.keys(index.images).sort().join('|')
        === [...keptOf(WARIO), ...keptOf(JACK)].sort().join('|'));
check('the shelf draws its covers from those files, not from the catalog',
    (await page.$$eval('img.vp-library-cover', els => els.map(el => el.src)))
        .every(src => src.startsWith('blob:')));

console.log('\nA game\'s page');
await page.evaluate(() => {
    const card = [...document.querySelectorAll('.vp-library-card')]
        .find(el => el.textContent.includes('Wario'));
    card.click();
});
await page.waitForSelector('.vp-library-hero');
await page.waitForFunction(() => {
    const hero = document.querySelector('.vp-library-hero');
    return hero instanceof HTMLElement && hero.style.backgroundImage.includes('blob:');
}, { timeout: 10000 });
check('takes its backdrop from the same store', true);
await page.click('.vp-library-back');
await page.waitForSelector('.vp-library-card');

console.log('\nA second start');
const before = pictureRequests;
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(
    () => document.querySelectorAll('img.vp-library-cover[src^="blob:"]').length === 2,
    { timeout: 10000 });
check('asks the catalog\'s file host for nothing at all', pictureRequests === before);

console.log('\nA start with no network');
picturesDown = true;
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(
    () => document.querySelectorAll('img.vp-library-cover[src^="blob:"]').length === 2,
    { timeout: 10000 });
check('still shows the covers, because they are on this machine', true);
picturesDown = false;

console.log('\nA game that leaves the library');
await seedLibrary([WARIO]);
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(
    () => document.querySelectorAll('.vp-library-card').length === 1,
    { timeout: 10000 });
await page.waitForFunction(async () => {
    const root = await navigator.storage.getDirectory();
    const library = await root.getDirectoryHandle('library');
    const art = await library.getDirectoryHandle('art');
    const names = [];
    for await (const name of art.keys()) {
        names.push(name);
    }
    return names.length === 4;
}, { timeout: 10000 }).catch(() => undefined);
check('takes its pictures with it', (await artFiles()).length === 4);
check('and the note no longer names them',
    Object.keys((await artIndex())?.images ?? {}).sort().join('|')
        === keptOf(WARIO).sort().join('|'));

check('nothing errored', errors.length === 0);
if (errors.length > 0) {
    console.log(errors.join('\n'));
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
