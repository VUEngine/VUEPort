/**
 * The library's name lookup for a checksum the catalog does not know (a translation, hack or re-release in a file named
 * after a known game): the indexing pass asks /api/rom/title/<name>/ and takes a close enough answer. Covers what is
 * sent (the name up to the first bracket or dash), that a close answer names the game and takes it off the Unmatched
 * shelf, that the page says the match came from a name, that a score under the line changes nothing, and that three
 * dumps of one game cost one request. Runs against a stand-in relay that knows no checksum and answers titles as the
 * real one does: five candidates, scored, best first.
 *
 * Usage: node tests/library-title-probe.mjs (after `yarn build`)
 */
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
page.on('console', message => {
    if (message.type() !== 'error') {
        return;
    }
    // the stand-in answers 404 to every checksum, which the browser logs as a failed load; anything else is a real
    // complaint
    if (message.text().startsWith('Failed to load resource')
        && (message.location()?.url ?? '').includes('api.vueport.net')) {
        return;
    }
    errors.push(message.text());
});

const candidate = (id, title, similarity) => ({
    id,
    title,
    type: 'game',
    description: `<p>About ${title}.</p>`,
    url: `https://www.virtual-boy.com/games/${id}/`,
    company: [{ id: 9, name: 'Atlus Co., Ltd.', role: 'Developer' }],
    genre: [{ id: 1, name: 'Action' }],
    players: [{ id: 2, name: '1 Player' }],
    region: [{ id: 3, name: 'Japan' }],
    status: [{ id: 4, name: 'Released' }],
    year: [{ id: 5, name: '1995' }],
    similarity,
});

// its five best, scored, best first, also for a name it knows nothing like, which the 90 per cent line exists for
const answerFor = name => (name.toLowerCase() === 'jack bros.'
    ? [candidate(30668, 'Jack Bros.', 100), candidate(959639, 'Mario Bros. VB', 58.33)]
    : [candidate(41240, 'Virtual Fishing', 55.17), candidate(30668, 'Jack Bros.', 41.67)]);

const asked = [];

await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (!url.includes('api.vueport.net') && !url.includes('virtual-boy.com')) {
        request.continue();
        return;
    }
    const json = (status, body) => request.respond({
        status, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body),
    });
    const { pathname } = new URL(url);
    if (pathname.startsWith('/pvb/title/')) {
        const sent = pathname.slice('/pvb/title/'.length).replace(/\/$/, '');
        asked.push(sent);
        json(200, answerFor(decodeURIComponent(sent)));
        return;
    }
    if (pathname === '/pvb/' || pathname === '/pvb') {
        json(200, []);
        return;
    }
    json(404, { error: 'No ROM found.' });
});

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');

// five dumps not looked up yet (no lookedUpAt)
await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('library', { create: true });
    const file = await directory.getFileHandle('index.json', { create: true });
    const writable = await file.createWritable();
    const entry = (id, name) => ({
        id,
        files: [{ folderId: 'f1', path: name, name, bytes: 1048576, modifiedAt: 1 }],
        header: { name: 'ROM', maker: '01', code: 'VPRB', version: 0 },
        bytes: 1048576,
        addedAt: 1,
        unmatched: false,
    });
    await writable.write(JSON.stringify({
        version: 1,
        folders: [{ id: 'f1', name: 'Virtual Boy', addedAt: 1, readAt: 2, count: 5 }],
        entries: [
            // one game under the three ways collections name it
            entry('aaaaaaaa', 'Jack Bros. (German Translation).vb'),
            entry('bbbbbbbb', 'Jack Bros. (Japan) (Rev 1).vb'),
            entry('dddddddd', 'Jack Bros. - German Translation.vb'),
            entry('cccccccc', 'Some Homebrew Thing.vb'),
            entry('eeeeeeee', 'Spider-Man.vb'), // a hyphen in a title, not a note after a dash
        ],
    }));
    await writable.close();
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');

const titles = () => page.$$eval('.vp-library-card-title', els => els.map(el => el.textContent));
// the pass runs after the first render: the shelf is drawn from file names and fills in as the catalog answers
await page.waitForFunction(() =>
    [...document.querySelectorAll('.vp-library-card-title')]
        .some(el => el.textContent === 'Jack Bros.'), { timeout: 10000 });

console.log('\nWhat is sent');
check('the name up to the first bracket, and nothing after it',
    asked.includes('Jack%20Bros.'));
check('percent-encoded rather than plussed — this is a path segment',
    !asked.some(name => name.includes('+')));
check('and never the bracketed part of the file name',
    !asked.some(name => decodeURIComponent(name).includes('(')));
check('a note after a dash goes the same way as one in brackets',
    !asked.some(name => decodeURIComponent(name).includes(' - ')));
check('while a hyphen inside a title is part of the title',
    asked.includes('Spider-Man'));
check('the three dumps of one game ask once, however they are named',
    asked.filter(name => decodeURIComponent(name).toLowerCase() === 'jack bros.').length === 1);
check('a name of its own is asked about on its own',
    asked.includes(encodeURIComponent('Some Homebrew Thing')));

console.log('\nWhat is done with the answer');
check('a name the catalog is sure of names the game',
    JSON.stringify(await titles())
        === JSON.stringify(['Jack Bros.', 'Some Homebrew Thing', 'Spider-Man']));
check('all three dumps of it are one card, as a checksum match would have made them',
    (await page.$$('.vp-library-card')).length === 3);
check('with the catalog\'s credits under it',
    (await page.$$eval('.vp-library-card-meta', els => els.map(el => el.textContent)))
        .includes('Atlus Co., Ltd. · 1995'));
check('and it is off the Unmatched shelf, which now holds the other two',
    await page.$$eval('.vp-library-nav', els => els
        .filter(el => el.textContent.includes('Unmatched'))
        .map(el => el.querySelector('.vp-library-nav-count')?.textContent)
        .join('')) === '2');
check('a best answer under the line is no answer — the file still names it',
    (await titles()).includes('Some Homebrew Thing'));

console.log('\nWhat the page says about it');
await page.evaluate(() => [...document.querySelectorAll('.vp-library-card-title')]
    .find(el => el.textContent === 'Jack Bros.').closest('.vp-library-card').click());
await page.waitForSelector('.vp-library-page');
const tags = await page.$$eval('.vp-library-tag', els => els.map(el => el.textContent));
check('that the name is what matched, and how close the catalog thought it was',
    tags.includes('Matched by name · 100%'));
check('and it does not claim to be unmatched as well',
    !tags.includes('Unmatched'));
check('all three files are listed under it',
    (await page.$$('.vp-library-files li')).length === 3);

// asked and answered: lookedUpAt keeps the pass from going round again on the next start, name matches included
const before = asked.length;
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');
await page.waitForFunction(() =>
    [...document.querySelectorAll('.vp-library-card-title')]
        .some(el => el.textContent === 'Jack Bros.'), { timeout: 10000 });
console.log('\nOn the next start');
check('nothing is asked again — the answers were written down',
    asked.length === before);
check('and the game is still named from what was kept',
    (await titles()).includes('Jack Bros.'));

check('nothing errored', errors.length === 0);
if (errors.length > 0) {
    console.log(errors.join('\n'));
}

await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
