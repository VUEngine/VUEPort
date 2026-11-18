// Planet VB's two library shelves against a stand-in relay: the shelf from `…/pvb/` plus a detail call per game shown,
// picks from `…/pvb/?featured`, game pages with releases, and Play downloading one
// Usage: node tests/planet-vb-probe.mjs (after `yarn build`)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';

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

// a real (tiny) ZIP holding one power-of-two .vb, built by hand

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}
function zipOf(name, data) {
    const nameBytes = Buffer.from(name);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    const localSize = local.length + nameBytes.length + compressed.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + nameBytes.length, 12);
    end.writeUInt32LE(localSize, 16);
    return Buffer.concat([
        local, nameBytes, compressed,
        central, nameBytes,
        end,
    ]);
}
const ROM_ZIP = zipOf('demo.vb', Buffer.alloc(131072, 7)); // 128 KiB, a power of two

const CATALOG = [
    {
        id: 1, title: 'Alpha Quest',
        description: '<p>A <b>test</b> adventure.</p>',
        url: 'https://www.virtual-boy.com/homebrew/alpha-quest/',
        roms: [
            { title: 'v1.1', date: '2019-04-02', url: 'https://www.virtual-boy.com/homebrew/alpha-quest/downloads/111/', latest: true },
            // dated to the month only, like many of the catalog's older entries
            { title: 'v1.0', date: '201811', url: 'https://www.virtual-boy.com/homebrew/alpha-quest/downloads/112/', latest: false },
        ],
        covers: [{ name: 'Default', faces: { front: { large: 'https://files.virtual-boy.com/homebrew/1/alpha.png' } } }],
        backgrounds: [{ name: 'Default', large: 'https://files.virtual-boy.com/homebrew/1/alpha-bg.jpg' }],
    },
    {
        id: 2, title: 'Beta Blast',
        description: '<p>Twin-stick.</p>',
        url: 'https://www.virtual-boy.com/homebrew/beta-blast/',
        roms: [{ title: 'Release', url: 'https://www.virtual-boy.com/homebrew/beta-blast/downloads/222/', latest: true }],
        covers: [],
    },
    {
        // no downloads group, so nothing to play: dropped before the shelf (see `web-homebrew`)
        id: 3, title: 'Ghost Entry', description: '', url: 'https://www.virtual-boy.com/homebrew/ghost/',
        roms: [],
    },
];
const DETAIL = {
    111: {
        id: 111,
        download: 'https://www.virtual-boy.com/downloads/111/get/1111/',
        item: [{
            type: 'homebrew',
            // two people, one not even tagged "developer"; both must show
            people: [
                { id: 1, name: 'Ada Coder', role: 'Developer' },
                { id: 4, name: 'Cy Composer', role: 'Composer' },
            ],
            players: [{ id: 1, name: '1 Player' }],
            year: [{ id: 1, name: '2019' }],
            genre: [{ id: 1, name: 'Adventure' }],
        }],
    },
    112: {
        id: 112,
        download: 'https://www.virtual-boy.com/downloads/112/get/1112/',
        item: [{ year: [{ id: 1, name: '2018' }] }],
    },
    222: {
        id: 222,
        download: 'https://www.virtual-boy.com/downloads/222/get/2222/',
        item: [{
            company: [{ id: 2, name: 'Studio Two' }],
            players: [{ id: 2, name: '1-2 Players (Simultaneously)' }],
            year: [{ id: 2, name: '2023' }],
            genre: [{ id: 2, name: 'Shooter' }],
        }],
    },
};

let listHits = 0;
let featuredHits = 0;
let detailHits = 0;
const downloaded = [];

if (!existsSync(path.join(dist, 'index.html'))) {
    console.log('\nskipped: dist is not built (yarn --cwd packages/web build)\n');
    process.exit(0);
}

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
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));

await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    const json = (status, body) => request.respond({
        status, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body,
    });
    const detail = url.match(/\/pvb\/(\d+)\//);
    if (detail) {
        detailHits++;
        const entry = DETAIL[detail[1]];
        return entry ? json(200, JSON.stringify(entry)) : json(404, '{"error":"nope"}');
    }
    if (/\/pvb\/$/.test(url.split('?')[0])) {
        // Planet VB's selection is a subset of the same entries, which is how the shelf knows the picks
        if (url.includes('featured')) {
            featuredHits++;
            return json(200, JSON.stringify(CATALOG.filter(entry => entry.id === 2)));
        }
        listHits++;
        return json(200, JSON.stringify(CATALOG));
    }
    // only the `/get/` path is a ROM, cover art on files.virtual-boy.com must not count
    if (/\/downloads\/\d+\/get\/\d+\//.test(url)) {
        downloaded.push(url);
        return request.respond({
            status: 200, contentType: 'application/zip',
            headers: { 'access-control-allow-origin': '*' }, body: ROM_ZIP,
        });
    }
    if (url.startsWith('https://files.virtual-boy.com')) {
        return request.respond({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    }
    request.continue();
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');

console.log('\nThe catalog is a shelf of the library');
check('nothing was asked of Planet VB before somebody went looking',
    listHits === 0 && featuredHits === 0);

// the count beside each shelf stays empty until the catalog has answered, as a zero would read as an empty catalog. By
// name rather than position, as the shelf order may change
const shelfCounts = () => page.$$eval('.vp-library-nav', els => Object.fromEntries(els
    .filter(el => /Homebrew Archive|Featured Picks/.test(el.textContent))
    .map(el => [
        el.textContent.includes('Featured Picks') ? 'featured' : 'archive',
        el.querySelector('.vp-library-nav-count')?.textContent ?? '—',
    ])));
const counts = await shelfCounts();
check('and neither shelf claims a count yet',
    counts.featured === '—' && counts.archive === '—');
await page.evaluate(() => {
    const item = [...document.querySelectorAll('.vp-library-nav')]
        .find(el => el.textContent.includes('Homebrew Archive'));
    item.click();
});
await page.waitForSelector('.vp-library-card');
await wait(600);

const titles = () => page.$$eval('.vp-library-card-title', els => els.map(el => el.textContent));
const metas = () => page.$$eval('.vp-library-card-meta', els => els.map(el => el.textContent));

check('both listings were fetched once', listHits === 1 && featuredHits === 1);
check('every playable game in it is on the shelf, in title order',
    JSON.stringify(await titles()) === JSON.stringify(['Alpha Quest', 'Beta Blast']));
check('the credits filled in behind it',
    (await metas()).includes('Ada Coder, Cy Composer · 2019')
    && (await metas()).includes('Studio Two · 2023'));
check('one detail call per game shown', detailHits === 2);
const held = await shelfCounts();
check('both shelves now say how many they hold', held.archive === '2' && held.featured === '1');
check('and no ROM was downloaded just to draw a shelf', downloaded.length === 0);

console.log('\nPlanet VB\'s own picks');
const onShelf = name => page.evaluate(label => [...document.querySelectorAll('.vp-library-nav')]
    .find(el => el.textContent.includes(label)).click(), name);
await onShelf('Featured Picks');
await wait(200);
check('the picks are the same listing, narrowed to what Planet VB puts forward',
    JSON.stringify(await titles()) === JSON.stringify(['Beta Blast']));
check('and narrowing it asked nothing more of Planet VB',
    listHits === 1 && featuredHits === 1 && detailHits === 2);
check('there is no second switch for it above the shelf',
    await page.$('.vp-library-filter') === null);
await onShelf('Homebrew Archive');
await wait(200);
check('and back again', JSON.stringify(await titles())
    === JSON.stringify(['Alpha Quest', 'Beta Blast']));

console.log('\nNarrowing it');
await page.type('.vp-library-search input', 'beta');
await wait(200);
check('the search matches the catalog too',
    JSON.stringify(await titles()) === JSON.stringify(['Beta Blast']));
await page.click('.vp-settings-search-clear');
await wait(200);

console.log('\nThe bar, between sessions');
await page.click('.vp-library-pill.pill-genre .vp-dropdown-control');
await page.click('.vp-library-pill.pill-genre .vp-dropdown-option[data-value="Shooter"]');
await wait(200);
check('a genre narrows the archive',
    JSON.stringify(await titles()) === JSON.stringify(['Beta Blast']));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');
await page.evaluate(() => [...document.querySelectorAll('.vp-library-nav')]
    .find(el => el.textContent.includes('Homebrew Archive')).click());
await page.waitForSelector('.vp-library-card');
await wait(600);
check('and still does after a reload',
    JSON.stringify(await titles()) === JSON.stringify(['Beta Blast'])
    && await page.$eval('.vp-library-pill.pill-genre', el => el.classList.contains('on')));
await page.evaluate(() => [...document.querySelectorAll('.vp-library-nav')]
    .find(el => el.textContent.includes('Featured Picks')).click());
await wait(200);
check('without following onto another shelf',
    !(await page.$eval('.vp-library-pill.pill-genre', el => el.classList.contains('on'))));
await page.evaluate(() => [...document.querySelectorAll('.vp-library-nav')]
    .find(el => el.textContent.includes('Homebrew Archive')).click());
await wait(200);
const resetShown = () => page.$eval('.vp-library-filters-reset button',
    el => !el.disabled && getComputedStyle(el).visibility !== 'hidden');
check('the reset beside the pills is there while something is set', await resetShown());
await page.click('.vp-library-filters-reset button');
await wait(200);
check('and pressing it shows the whole archive again',
    JSON.stringify(await titles()) === JSON.stringify(['Alpha Quest', 'Beta Blast'])
    && !(await page.$eval('.vp-library-pill.pill-genre', el => el.classList.contains('on'))));
check('after which it is hidden, with nothing left to undo — keeping its place',
    !(await resetShown()) && await page.$('.vp-library-filters-reset button') !== null);

console.log('\nOne game from the catalog');
await page.evaluate(() => {
    const title = [...document.querySelectorAll('.vp-library-card-title')]
        .find(el => el.textContent === 'Alpha Quest');
    title.closest('.vp-library-card').click();
});
await page.waitForSelector('.vp-library-page');
check('opens the same page a game in your folders opens',
    await page.$eval('.vp-library-hero-text h2', el => el.textContent) === 'Alpha Quest');
check('marked with what the catalog files it under, not with a constant',
    (await page.$$eval('.vp-library-detail-facts > div',
        els => els.map(el => [...el.children].map(node => node.textContent).join('|'))))
        .includes('Type|Homebrew'));
check('with the blurb the catalog gives, as text rather than markup',
    await page.$eval('.vp-library-detail-blurb', el => el.textContent) === 'A test adventure.');
check('and every release it lists, current one first',
    JSON.stringify(await page.$$eval('.vp-library-files li .vp-library-file-title',
        els => els.map(el => el.textContent))) === JSON.stringify(['v1.1', 'v1.0']));
check('the current one says so, in the word a game\'s own page uses',
    await page.$eval('.vp-library-files li .vp-library-tag',
        el => el.textContent) === 'Latest');
check('with the catalog\'s backdrop behind the head',
    (await page.$eval('.vp-library-hero', el => el.style.backgroundImage))
        .includes('alpha-bg.jpg'));
// the catalog stops its digit dates where the date stops being known, so a month-only date must not get a day.
// Formatted by the browser's locale, as only how much of each date is said is checked.
const dated = await page.evaluate(() => [
    new Date(Date.UTC(2019, 3, 2, 12)).toLocaleDateString(undefined,
        { year: 'numeric', month: 'long', day: 'numeric' }),
    new Date(Date.UTC(2018, 10, 1, 12)).toLocaleDateString(undefined, { year: 'numeric', month: 'long' }),
]);
check('with each release dated as far as the catalog dates it',
    JSON.stringify(await page.$$eval('.vp-library-files li .vp-library-file-line',
        els => els.map(el => el.textContent)))
    === JSON.stringify(dated.map(when => `${when} · downloaded when you play it`)));
check('and no line repeating the title in place of a file name nobody has yet',
    (await page.$$eval('.vp-library-files li .vp-library-file-line',
        els => els.map(el => el.textContent))).every(text => !text.startsWith('v1.')));
check('and the list of them is called what a game\'s own page calls it',
    (await page.$$eval('.vp-library-page-body h3', els => els.map(el => el.textContent)))
        .some(text => text.trim().startsWith('ROMs')));

console.log('\nPlaying one');
await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.vp-library-files li')];
    rows[1].querySelector('.vp-button').click();
});
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
check('downloads the release that was pressed, not the newest',
    downloaded.length === 1 && downloaded[0].includes('/downloads/112/get/'));
check('and the ROM inside the archive is running',
    await page.$('.vp-dock canvas') !== null);

check('nothing errored', errors.length === 0);
if (errors.length > 0) {
    console.log(errors.join('\n'));
}

await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
