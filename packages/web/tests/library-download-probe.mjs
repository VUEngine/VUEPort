// checks importing from Planet VB into the library: an Import button beside every release on a game's page, one at its
// head for all, one over the Planet VB shelf; against a stand-in relay, as in planet-vb-probe.mjs
// Usage: node tests/library-download-probe.mjs (after `yarn build`)
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

// a different ROM behind every release, so each is a game of its own rather than one checksum filed three times
const ROMS = {
    111: zipOf('alpha-v11.vb', Buffer.alloc(131072, 1)),
    112: zipOf('alpha-v10.vb', Buffer.alloc(131072, 2)),
    // not zipped at all: a bare ROM behind an address that says nothing of it
    222: Buffer.alloc(131072, 3),
    // neither: a page that answered 200
    333: Buffer.from('<html>oops</html>'),
};

const CATALOG = [
    {
        id: 1, title: 'Alpha Quest', description: '', url: 'https://www.virtual-boy.com/homebrew/alpha-quest/',
        roms: [
            { title: 'v1.1', url: 'https://www.virtual-boy.com/homebrew/alpha-quest/downloads/111/', latest: true },
            { title: 'v1.0', url: 'https://www.virtual-boy.com/homebrew/alpha-quest/downloads/112/', latest: false },
        ],
        covers: [],
    },
    {
        id: 2, title: 'Beta Blast', description: '', url: 'https://www.virtual-boy.com/homebrew/beta-blast/',
        roms: [{ title: 'Release', url: 'https://www.virtual-boy.com/homebrew/beta-blast/downloads/222/', latest: true }],
        covers: [],
    },
    {
        id: 3, title: 'Gamma Gone', description: '', url: 'https://www.virtual-boy.com/homebrew/gamma/',
        roms: [{ title: 'Release', url: 'https://www.virtual-boy.com/homebrew/gamma/downloads/333/', latest: true }],
        covers: [],
    },
];
const detailOf = id => ({ id: Number(id), download: `https://www.virtual-boy.com/downloads/${id}/get/${id}0/`, item: [{}] });

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
    const cors = { 'access-control-allow-origin': '*' };
    const json = (status, body) => request.respond({ status, contentType: 'application/json', headers: cors, body });
    const group = url.match(/\/pvb\/(\d{3})\/$/);
    if (group && CATALOG.some(entry => entry.roms.some(rom => rom.url.includes(`/${group[1]}/`)))) {
        return json(200, JSON.stringify(detailOf(group[1])));
    }
    if (/\/pvb\/$/.test(url.split('?')[0])) {
        return json(200, JSON.stringify(url.includes('featured') ? [] : CATALOG));
    }
    if (url.includes('/pvb/')) {
        return json(404, '{"error":"nope"}');
    }
    const get = url.match(/\/downloads\/(\d+)\/get\/\d+\//);
    if (get) {
        downloaded.push(get[1]);
        return request.respond({ status: 200, contentType: 'application/octet-stream', headers: cors, body: ROMS[get[1]] });
    }
    if (url.startsWith('https://')) {
        return request.respond({ status: 404, headers: cors, body: '' });
    }
    request.continue();
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (label, test, timeout = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await test()) {
            return true;
        }
        await wait(100);
    }
    console.log(`  (timed out waiting for: ${label})`);
    return false;
};
const navRow = name => page.evaluateHandle(label =>
    [...document.querySelectorAll('.vp-library-nav')].find(el => el.textContent.includes(label)), name);
const navCount = async name => (await navRow(name))
    .evaluate(el => el?.querySelector('.vp-library-nav-count')?.textContent ?? '');
const rowImports = () => page.$$eval('.vp-library-files li .vp-library-import',
    els => els.map(el => `${el.textContent.trim()}${el.disabled ? '' : '*'}`));
const heroImport = () => page.$eval('.vp-library-hero-actions .vp-library-import',
    el => `${el.textContent.trim()}${el.disabled ? '' : '*'}`);
const shelfImport = () => page.$eval('.vp-library-import', el => el.textContent.trim()).catch(() => null);

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');
await (await navRow('Homebrew Archive')).evaluate(el => el.click());
await page.waitForSelector('.vp-library-card');
await wait(500);

console.log('\nThe Planet VB shelf');
check('offers to import every ROM of what it shows', await shelfImport() === 'Import all (4)');
await page.type('.vp-library-search input', 'alpha');
await wait(200);
check('and counts only what the search leaves', await shelfImport() === 'Import all (2)');
await page.click('.vp-settings-search-clear');
await wait(200);

console.log('\nOne game\'s page');
await page.evaluate(() => [...document.querySelectorAll('.vp-library-card-title')]
    .find(el => el.textContent === 'Alpha Quest').closest('.vp-library-card').click());
await page.waitForSelector('.vp-library-page');
await wait(300);
check('every release has an Import button beside its Play',
    JSON.stringify(await rowImports()) === JSON.stringify(['Import*', 'Import*']));
check('Play is still the first button on the row',
    await page.$eval('.vp-library-files li .vp-button', el => el.textContent.trim()) === 'Play');
check('and the head offers all of them', await heroImport() === 'Import all*');

await page.evaluate(() => document.querySelectorAll('.vp-library-files li .vp-library-import')[1].click());
check('importing one release downloads it and says it is in the library',
    await until('v1.0 in library', async () => JSON.stringify(await rowImports())
        === JSON.stringify(['Import*', 'In library'])));
check('only that release was downloaded', JSON.stringify(downloaded) === JSON.stringify(['112']));
check('the head still offers the rest', await heroImport() === 'Import all*');
await page.click('.vp-library-hero-actions .vp-library-import');
check('Import all takes the rest',
    await until('all in library', async () => await heroImport() === 'In library'));
check('without downloading the first again', JSON.stringify(downloaded) === JSON.stringify(['112', '111']));

console.log('\nThe library');
await page.click('.vp-library-back');
await page.waitForSelector('.vp-library-card');
check('the shelf counts only what is left', await shelfImport() === 'Import all (2)');
await page.click('.vp-library-import');
await page.waitForSelector('.vp-modal');
check('importing everything asks first, with the count',
    (await page.$eval('.vp-modal h2', el => el.textContent)).includes('2 ROMs from 2 games'));
await page.evaluate(() => [...document.querySelectorAll('.vp-modal-buttons .vp-button')]
    .find(el => !el.classList.contains('secondary')).click());
check('the batch runs to the end',
    await until('downloads done', async () => downloaded.length === 4 && await page.$('.vp-library-progress') === null));
check('a download that is not a ROM is said, not kept',
    await until('toast', () => page.evaluate(() => document.body.textContent.includes('could not be downloaded: Gamma Gone'))));
check('so the shelf still offers that one', await shelfImport() === 'Import all (1)');
check('and the three ROMs are games in the library',
    await until('All Games count', async () => await navCount('All Games') === '3'));

console.log('\nAfter a reload');
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');
check('the library still has them', await until('count after reload', async () => await navCount('All Games') === '3'));
await (await navRow('Homebrew Archive')).evaluate(el => el.click());
await page.waitForSelector('.vp-library-card');
await wait(300);
check('and the shelf still knows which are imported', await shelfImport() === 'Import all (1)');

check('nothing errored', errors.length === 0);
if (errors.length > 0) {
    console.log(errors.join('\n'));
}

await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
