// the library (the start page): empty state with the two ways in, stored index as covers, shelves, search and views
// over one list, unknown checksums under Unmatched. Folders need a native picker and aren't exercised
// Usage: node tests/library-probe.mjs (after `yarn build`)
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

// nothing should reach the live catalog, as every entry in the index was looked up already. Planet VB's own shelf
// fills its filter bar from one detail request per release, so the catalog is stood in for: a listing of three
// and a detail apiece. ?featured marks one of them
const CATALOG = [
    { id: 1, title: 'Hyper Fighting', group: '11', type: 'homebrew', score: 100, genre: 'Action' },
    // the catalog's Canceled, with one l, the spelling the badge has to answer to
    { id: 2, title: 'Polygon Engine', group: '22', type: 'tech-demo', genre: 'Tech', status: 'Canceled' },
    { id: 3, title: 'Zpace Racers', group: '33', type: 'homebrew', score: 75, genre: 'Racing' },
];
const listing = only => CATALOG.filter(game => !only || game.id === 1).map(game => ({
    id: game.id,
    title: game.title,
    description: '',
    url: `https://www.virtual-boy.com/homebrew/${game.group}/`,
    roms: [{
        title: game.title,
        url: `https://www.virtual-boy.com/homebrew/x/downloads/${game.group}/`,
        date: '20200101',
        latest: true,
    }],
}));
await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('virtual-boy.com') || url.includes('api.vueport.net')) {
        // whatever base the build is pointed at, a detail request ends in a downloads-group number
        const group = url.match(/\/(\d+)\/$/)?.[1];
        const game = CATALOG.find(entry => entry.group === group);
        const body = game
            ? {
                id: Number(game.group),
                download: `https://www.virtual-boy.com/downloads/${game.group}/get/1/`,
                item: [{
                    type: game.type,
                    score: game.score,
                    people: [{ id: 1, name: 'Somebody' }],
                    genre: [{ id: 2, name: game.genre }],
                    status: [{ id: 5, name: game.status ?? 'Released' }],
                    players: [{ id: 3, name: '1 Player' }],
                    year: [{ id: 4, name: '2020' }],
                }],
            }
            : listing(url.includes('featured'));
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body),
        });
        return;
    }
    request.continue();
});

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');

console.log('\nAn empty library');
check('says so rather than showing an empty shelf',
    (await page.$$eval('.vp-library-blank div', els => els.map(el => el.textContent)))
        .includes('Your library is empty'));
check('offers a folder, a single ROM and the catalog',
    (await page.$$eval('.vp-library-blank button', els => els.map(el => el.textContent)))
        .join('|') === 'Add a folder…|Open a single ROM…|Browse Planet VB');
check('and keeps the single-ROM way in at the foot of the column',
    await page.$eval('.vp-library-side-foot .vp-button', el => el.textContent.trim())
    === 'Open ROM…');
// the second way in is a line of text under the button, not an open field, as pasting an address is rare. Found by
// its text rather than its class
const fromLink = () => page.evaluateHandle(() =>
    [...document.querySelectorAll('.vp-library-side-foot button')]
        .find(el => el.textContent.includes('From a link')));
check('with the quieter way in under it',
    await (await fromLink()).evaluate(el => el?.textContent.trim()) === 'From a link…');
await (await fromLink()).evaluate(el => el.click());
await page.waitForSelector('.vp-modal-input');
check('which asks for the address rather than keeping a field open for it',
    await page.$eval('.vp-modal-input', el => el.type) === 'url');
check('and says what it is for, and that a link can carry the ROM itself',
    (await page.$$eval('.vp-modal p', els => els.map(el => el.textContent)))
        .join(' ').includes('?rom='));
await page.keyboard.press('Escape');
await page.waitForSelector('.vp-modal-input', { hidden: true });
// Firefox and Safari have no folder picker, so the same button makes a copy instead and says so. Pressing it is not
// exercised, as it opens a native file dialog
const noPicker = await page.evaluateOnNewDocument(() => { delete window.showDirectoryPicker; });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-blank button');
const folderButton = () => page.evaluateHandle(() =>
    [...document.querySelectorAll('.vp-library-blank button')]
        .find(el => el.textContent.includes('folder')));
check('a way in is still offered where no folder can be read where it lies',
    await (await folderButton()).evaluate(el => el !== undefined && !el.disabled));
check('and it says it will copy rather than read',
    await (await folderButton()).evaluate(el => el.textContent.trim()) === 'Import a folder…');
await page.removeScriptToEvaluateOnNewDocument(noPicker.identifier);
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-blank button');

check('and no drop target drawn anywhere — the window is the drop target',
    await page.$('.vp-droparea') === null);

// a game made here outlives the folder its dumps came from, so a library with no folders may still have games; it
// used to show the "nothing here" panel under a heading that counted the game
console.log('\nA library with no folders but something in it');
await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('library', { create: true });
    const file = await directory.getFileHandle('index.json', { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify({
        version: 1, folders: [], entries: [], games: [{ id: 'own:probe', createdAt: 1 }],
    }));
    await writable.close();
});
await page.reload({ waitUntil: 'networkidle0' });
// tolerant: with the shelf deciding on folders rather than games there is no card to wait for, and this should
// report that rather than crash out of the probe
await page.waitForSelector('.vp-library-card', { timeout: 5000 })
    .catch(() => undefined);
check('the game is on the shelf rather than counted in the column and hidden',
    (await page.$$('.vp-library-card')).length === 1
    && await page.$('.vp-library-blank') === null);
check('and the column, the heading and the shelf agree about how many there are',
    await page.evaluate(() => [...document.querySelectorAll('.vp-library-nav')]
        .find(el => el.textContent.includes('All Games'))
        ?.querySelector('.vp-library-nav-count')?.textContent) === '1'
    && (await page.$eval('.vp-library-title .vp-hint', el => el.textContent))
        .startsWith('1 games'));

console.log('\nA library that has been read');
const seedLibrary = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('library', { create: true });
    const file = await directory.getFileHandle('index.json', { create: true });
    const writable = await file.createWritable();
    const folder = { id: 'f1', name: 'Virtual Boy', addedAt: 1, readAt: 2, count: 3 };
    const entry = (id, name, catalog) => ({
        id,
        files: [{ folderId: 'f1', path: `${name}.vb`, name: `${name}.vb`, bytes: 1048576, modifiedAt: 1 }],
        header: { name: name.toUpperCase(), maker: '01', code: 'VPRB', version: 0 },
        bytes: 1048576,
        addedAt: 1,
        catalog,
        lookedUpAt: 2,
        unmatched: !catalog,
    });
    const game = (itemId, title, developer, extra = {}) => ({
        itemId, title, developer, publisher: developer, released: '1995-12-01', genre: 'Action',
        players: '1 Player', region: 'NTSC-U', status: 'Released', kind: 'game', description: '',
        latest: true, ...extra,
    });
    const blurb = ('Wario has found a treasure-filled cave in the Awazon river basin, and the '
        + 'Brutes have found Wario. What follows is a platformer built around the one thing '
        + 'the hardware could do that nothing else could, which is depth: pipes that run into '
        + 'the screen, hazards that come out of it, and a second plane of the level you drop '
        + 'into rather than walk to. ').repeat(3);
    // Planet VB's scores for the two, for the shelf's chips and score order. The third entry has no catalog, so no
    // score either
    await writable.write(JSON.stringify({
        version: 1,
        folders: [folder],
        entries: [
            // two dumps of one game, which is one game on the shelf
            entry('aaaaaaaa', 'wario-land-usa',
                game(1, 'Virtual Boy Wario Land', 'Nintendo R&D1',
                    { genre: 'Platformer', score: 95, description: blurb })),
            entry('a1a1a1a1', 'wario-land-japan',
                game(1, 'Virtual Boy Wario Land', 'Nintendo R&D1',
                    { genre: 'Platformer', region: 'NTSC-J', latest: false, score: 95 })),
            entry('bbbbbbbb', 'jack-bros', game(2, 'Jack Bros.', 'Atlus', { score: 84 })),
            entry('cccccccc', 'own-build', undefined),
        ],
    }));
    await writable.close();
});
await seedLibrary();
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');

const titles = () => page.$$eval('.vp-library-card-title', els => els.map(el => el.textContent));
check('shows a card per game, in title order',
    JSON.stringify(await titles()) === JSON.stringify(['Jack Bros.', 'own-build', 'Virtual Boy Wario Land']));
check('two dumps of one game are one card, not two',
    (await page.$$('.vp-library-card')).length === 3);
check('credits each one from the catalog',
    (await page.$$eval('.vp-library-card-meta', els => els.map(el => el.textContent)))
        .includes('Nintendo R&D1 · 1995'));
check('falls back to the cartridge header where the catalog knew nothing',
    (await page.$$eval('.vp-library-card-meta', els => els.map(el => el.textContent)))
        .includes('OWN-BUILD'));
check('falls back to the generic Virtual Boy box where no cover is known',
    (await page.$$('.vp-library-box')).length === 3);

// a line of marks of its own, for what used to be drawn over the art: score, kind and release status on the left,
// Planet VB's pick and the user's star on the right
console.log('\nWhat a card says about a game');
const marks = title => page.evaluate(wanted => {
    const card = [...document.querySelectorAll('.vp-library-card-title')]
        .find(el => el.textContent === wanted)?.closest('.vp-library-card');
    const line = card?.querySelector('.vp-library-card-marks');
    return line && {
        score: line.querySelector('.vp-score')?.textContent ?? '',
        kind: line.querySelector('.vp-library-card-kind')?.textContent ?? '',
        starred: line.querySelector('.vp-library-card-star') !== null,
        featured: line.querySelector('.vp-library-card-featured') !== null,
        unreleased: line.querySelector('.vp-library-card-unreleased')?.textContent ?? '',
    };
}, title);
check('the score and the kind are on it, on a line of its own rather than over the art',
    JSON.stringify(await marks('Virtual Boy Wario Land'))
    === JSON.stringify({
        score: '95', kind: 'Official', starred: false, featured: false, unreleased: '',
    }));
check('a cartridge is called Official, against the homebrew beside it on a shelf',
    (await marks('Jack Bros.')).kind === 'Official');
check('and nothing is drawn over the cover any more',
    await page.$('.vp-library-card .vp-library-cover .vp-score') === null);
// drawn even when empty, so a wall of covers keeps its rows level
check('a game the catalog knows nothing about still carries the line, empty',
    JSON.stringify(await marks('own-build'))
    === JSON.stringify({
        score: '', kind: '', starred: false, featured: false, unreleased: '',
    })
    && (await page.$$('.vp-library-card-marks')).length === 3);
// field and direction are two controls: the dropdown picks the field, the button beside it the direction, and
// picking a field restores that field's own direction
console.log('\nSorting');
const sortDirection = () => page.$eval('.vp-library-sort-direction', el => el.title);
const chooseSort = async value => {
    await page.click('.vp-library-sort .vp-dropdown-control');
    await page.click(`.vp-library-sort .vp-dropdown-option[data-value="${value}"]`);
};
check('a title shelf starts ascending', await sortDirection() === 'Ascending order');
await page.click('.vp-library-sort-direction');
check('the button turns the shelf round', await sortDirection() === 'Descending order'
    && JSON.stringify(await titles())
    === JSON.stringify(['Virtual Boy Wario Land', 'own-build', 'Jack Bros.']));
await chooseSort('released');
check('and a field brings its own direction with it — a year reads newest first',
    await sortDirection() === 'Descending order');
await chooseSort('title');
check('while a title reads A to Z again, whatever the button was left on',
    await sortDirection() === 'Ascending order'
    && JSON.stringify(await titles())
    === JSON.stringify(['Jack Bros.', 'own-build', 'Virtual Boy Wario Land']));

check('what was played recently is a shelf above the games, not a row on top of them',
    await page.$$eval('.vp-library-nav-name', names =>
        names.slice(0, 2).map(name => name.textContent).join('|')) === 'Recently Played|All Games'
    && await page.$('.vp-library-recent-row') === null);
check('and Planet VB is a heading of its own, below the shelves',
    await page.$$eval('.vp-library-nav-name', names =>
        names.slice(-2).map(name => name.textContent).join('|'))
    === 'Featured Picks|Homebrew Archive');
// the folders are a setting of this machine, so the column offers the pane that has them
check('the folders are not a list in the column',
    !(await page.$$eval('.vp-library-nav-name', names =>
        names.map(name => name.textContent))).includes('Virtual Boy'));
check('there is one row leading to where they are managed',
    (await page.$$eval('.vp-library-nav-name', names =>
        names.map(name => name.textContent))).includes('Manage'));

// starring: one button on a game's page, a shelf in the column, a count beside it and a mark on the cover. Kept by
// game key, so it survives a restart
console.log('\nFavorites');
const navRow = name => page.evaluateHandle(label =>
    [...document.querySelectorAll('.vp-library-nav')]
        .find(el => el.textContent.includes(label)), name);
const navCount = async name => (await navRow(name))
    .evaluate(el => el?.querySelector('.vp-library-nav-count')?.textContent ?? '');
const clickCard = title => page.evaluate(wanted => {
    [...document.querySelectorAll('.vp-library-card-title')]
        .find(el => el.textContent === wanted)
        ?.closest('.vp-library-card').click();
}, title);

check('the column carries a Favorites shelf, empty and dimmed',
    await navCount('Favorites') === '0'
    && await (await navRow('Favorites')).evaluate(el => el.classList.contains('dim')));
await clickCard('Jack Bros.');
await page.waitForSelector('.vp-library-page');
check('a game\'s page offers the star beside Play',
    await page.$eval('.vp-library-hero-actions button:nth-child(2)',
        el => el.classList.contains('vp-library-star')));
await page.click('.vp-library-star');
await new Promise(resolve => setTimeout(resolve, 150));
check('pressing it marks the game as starred',
    await page.$eval('.vp-library-star', el => el.getAttribute('aria-pressed')) === 'true');
await page.click('.vp-library-back');
await page.waitForSelector('.vp-library-card');
check('the shelf counts it, and is no longer dimmed',
    await navCount('Favorites') === '1'
    && !(await (await navRow('Favorites')).evaluate(el => el.classList.contains('dim'))));
check('and the card wears a star at the end of its second line, on that card and no other',
    (await page.$$('.vp-library-card-star')).length === 1
    && (await marks('Jack Bros.')).starred
    && await page.$eval('.vp-library-card-star',
        el => el.closest('.vp-library-card')
            .querySelector('.vp-library-card-title').textContent) === 'Jack Bros.');
await (await navRow('Favorites')).evaluate(el => el.click());
await new Promise(resolve => setTimeout(resolve, 150));
check('the shelf holds what was starred and nothing else',
    JSON.stringify(await titles()) === JSON.stringify(['Jack Bros.']));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');
check('and the star survives a restart', await navCount('Favorites') === '1');

await (await navRow('Favorites')).evaluate(el => el.click());
await new Promise(resolve => setTimeout(resolve, 150));
await clickCard('Jack Bros.');
await page.waitForSelector('.vp-library-star');
await page.click('.vp-library-star');
await new Promise(resolve => setTimeout(resolve, 150));
await page.click('.vp-library-back');
await new Promise(resolve => setTimeout(resolve, 200));
check('pressing it again takes the star off, and the shelf says what it is for',
    await navCount('Favorites') === '0'
    && (await page.$$eval('.vp-library-blank div', els => els.map(el => el.textContent)))
        .includes('Nothing starred yet'));
await (await navRow('All Games')).evaluate(el => el.click());
await page.waitForSelector('.vp-library-card');

console.log('\nNarrowing it');
await page.type('.vp-library-search input', 'jack');
await new Promise(resolve => setTimeout(resolve, 100));
check('the search matches on title', JSON.stringify(await titles()) === JSON.stringify(['Jack Bros.']));
await page.click('.vp-settings-search-clear');
await new Promise(resolve => setTimeout(resolve, 100));
check('and clearing it brings the rest back', (await titles()).length === 3);

const navs = () => page.$$eval('.vp-library-nav-name', els => els.map(el => el.textContent));
check('an unmatched shelf appears only because one is unmatched',
    (await navs()).some(name => name.startsWith('Unmatched')));
await page.evaluate(() => {
    const button = [...document.querySelectorAll('.vp-library-nav')]
        .find(el => el.textContent.startsWith('Unmatched'));
    button.click();
});
await new Promise(resolve => setTimeout(resolve, 100));
check('and holds the ROM the catalog had nothing for',
    JSON.stringify(await titles()) === JSON.stringify(['own-build']));

console.log('\nThe other view');
await page.evaluate(() => {
    const button = [...document.querySelectorAll('.vp-library-nav')]
        .find(el => el.textContent.startsWith('All Games'));
    button.click();
});
await page.click('.vp-library-views [data-view="list"]');
await page.waitForSelector('.vp-library-list table');
check('lists the same games as rows — one per game, not one per ROM',
    (await page.$$('.vp-library-list tbody tr')).length === 3);
check('so a game with two dumps is one row',
    (await page.$$eval('.vp-library-row-name', els => els.map(el => el.textContent)))
        .filter(name => name === 'Virtual Boy Wario Land').length === 1);
check('with the catalog\'s fields as columns, and this machine\'s own two beside them',
    JSON.stringify(await page.$$eval('.vp-library-list th', els => els.map(el => el.textContent)))
    === JSON.stringify(
        ['Title', 'Developer', 'Year', 'Genre', 'Players', 'Size', 'Plays', 'Play time', 'Score', '']));
check('and the size read off the ROM itself',
    (await page.$$eval('.vp-library-list td.number', els => els.map(el => el.textContent)))
        .includes('8 MBit'));
// every column ranged left, headings included, so a value sits under its heading. start rather than left for the
// cells that say nothing, as it is the initial value and the same edge in every shipped language
check('every column reads from the same edge as its heading',
    await page.$$eval('.vp-library-list th, .vp-library-list td',
        els => els.every(el => ['left', 'start'].includes(getComputedStyle(el).textAlign))));
// the header stays put while the games go past, which needs a background, or the rows scroll through it
check('the heading row stays put as the shelf scrolls, and is opaque while it does',
    await page.$eval('.vp-library-list th', el => {
        const style = getComputedStyle(el);
        const transparent = style.backgroundColor === 'transparent'
            || style.backgroundColor.startsWith('rgba(0, 0, 0, 0)');
        return style.position === 'sticky' && !transparent;
    }));
// a click three columns along means the game on that line; the title is still its own button for the keyboard
await page.evaluate(() => {
    const row = [...document.querySelectorAll('.vp-library-list tbody tr')]
        .find(tr => tr.textContent.includes('Jack Bros.'));
    row.querySelectorAll('td')[3].click();
});
await page.waitForSelector('.vp-library-page');
check('a click anywhere along a row opens the game on it',
    await page.$eval('.vp-library-page h1, .vp-library-page h2',
        el => el.textContent).then(text => text.includes('Jack Bros.')));
await page.click('.vp-library-back');
await page.waitForSelector('.vp-library-list table');

// how often a game was started and how long it ran, kept by checksum by whatever plays the ROM, and added up per
// game here, so two dumps of one cartridge are one game's hours
console.log('\nWhat has been played');
await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('library', { create: true });
    const file = await directory.getFileHandle('play.json', { create: true });
    const writable = await file.createWritable();
    const now = Date.now();
    await writable.write(JSON.stringify({
        aaaaaaaa: { count: 3, ms: 7200000, firstPlayedAt: now - 86400000, lastPlayedAt: now - 7200000 },
        a1a1a1a1: { count: 1, ms: 1800000, firstPlayedAt: now - 259200000, lastPlayedAt: now - 259200000 },
        bbbbbbbb: { count: 1, ms: 20000, firstPlayedAt: now - 60000, lastPlayedAt: now - 60000 },
    }));
    await writable.close();
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-list table');
const rowNames = () => page.$$eval('.vp-library-row-name', els => els.map(el => el.textContent));
const rowCells = name => page.evaluate(wanted => {
    const row = [...document.querySelectorAll('.vp-library-list tbody tr')]
        .find(el => el.textContent.includes(wanted));
    return [...row.querySelectorAll('td')].map(cell => cell.textContent);
}, name);
const wario = await rowCells('Virtual Boy Wario Land');
check('the list counts every start of every dump as the game\'s own',
    wario[6] === '4');
check('and adds their hours up rather than showing the longest',
    wario[7] === '2 h 30 min');
check('a game started once and put down says so rather than reading as 0 min',
    (await rowCells('Jack Bros.'))[7] === 'under a minute');
check('and one nothing has ever started says nothing at all',
    (await rowCells('own-build'))[6] === '—' && (await rowCells('own-build'))[7] === '—');

await chooseSort('playTime');
await new Promise(resolve => setTimeout(resolve, 100));
check('the shelf can be read by how long each game has had',
    JSON.stringify(await rowNames())
    === JSON.stringify(['Virtual Boy Wario Land', 'Jack Bros.', 'own-build']));
await chooseSort('played');
await new Promise(resolve => setTimeout(resolve, 100));
check('and by how recently, which is a different order',
    JSON.stringify(await rowNames())
    === JSON.stringify(['Jack Bros.', 'Virtual Boy Wario Land', 'own-build']));
check('a game nobody has played is last rather than missing',
    (await rowNames()).length === 3);
await chooseSort('title');
await new Promise(resolve => setTimeout(resolve, 100));

// Planet VB rates its entries out of a hundred, and the shelf wears the score as the catalog's coloured chip
console.log('\nThe catalog\'s score');
const chip = name => page.evaluate(wanted => {
    const row = [...document.querySelectorAll('.vp-library-list tbody tr')]
        .find(el => el.textContent.includes(wanted));
    const badge = row.querySelector('.vp-score');
    return badge && { text: badge.textContent, color: getComputedStyle(badge).backgroundColor };
}, name);
check('each rated game wears its score',
    (await chip('Virtual Boy Wario Land'))?.text === '95'
    && (await chip('Jack Bros.'))?.text === '84');
check('and a game the catalog has not rated wears nothing rather than a dash',
    await chip('own-build') === null
    && (await rowCells('own-build'))[8] === '');
// red at the bottom of the ramp, olive green at the top: two scores twelve apart are two colours
check('the chip is coloured by the score rather than by the theme',
    (await chip('Virtual Boy Wario Land')).color !== (await chip('Jack Bros.')).color
    && (await chip('Jack Bros.')).color.startsWith('rgb('));
await chooseSort('score');
await new Promise(resolve => setTimeout(resolve, 100));
check('the shelf can be read by it, best first without being asked',
    await sortDirection() === 'Descending order'
    && JSON.stringify(await rowNames())
    === JSON.stringify(['Virtual Boy Wario Land', 'Jack Bros.', 'own-build']));
check('and an unrated game is at the foot of it rather than off it',
    (await rowNames()).length === 3);
await chooseSort('title');
await new Promise(resolve => setTimeout(resolve, 100));

// the bar under the shelf's name: the catalog's fields as pills offering what this shelf holds, and one switch
// for this machine. A row of its own, as what is on a shelf is a different question from how it is drawn
console.log('\nThe filter bar');
const pill = field => `.vp-library-pill.pill-${field}`;
const pillMenu = async field => {
    await page.click(`${pill(field)} .vp-dropdown-control`);
    const rows = await page.$$eval(`${pill(field)} .vp-dropdown-option`,
        els => els.map(el => el.textContent));
    await page.keyboard.press('Escape');
    return rows;
};
const pills = () => page.$$eval('.vp-library-filters .vp-dropdown-placeholder',
    els => els.map(el => el.textContent));
const choosePill = async (field, value) => {
    await page.click(`${pill(field)} .vp-dropdown-control`);
    await page.click(`${pill(field)} .vp-dropdown-option[data-value="${value}"]`);
    await new Promise(resolve => setTimeout(resolve, 100));
};
check('the shelf carries one, under its name rather than among the tools',
    await page.$eval('.vp-library-filters',
        el => el.previousElementSibling.classList.contains('vp-library-head')));
check('with a pill per field the catalog fills in, and the save switch at the end',
    JSON.stringify(await page.$$eval('.vp-library-filters .vp-dropdown-placeholder',
        els => els.map(el => el.textContent)))
    === JSON.stringify(['Genre', 'Year', 'Players', 'Region', 'Type'])
    && await page.$eval('.vp-library-toggle', el => el.textContent) === 'Has save data');
check('each pill offers what this shelf holds, not a list written in advance',
    JSON.stringify(await pillMenu('genre')) === JSON.stringify(['Any genre', 'Action', 'Platformer']));
check('and a game filed under several is offered under each of them',
    (await pillMenu('region')).join('|') === 'Any region|NTSC-U');
check('the type pill is in the bar now, named as the cards name it',
    JSON.stringify(await pillMenu('kind')) === JSON.stringify(['All types', 'Official']));
check('and is no longer among the tools above it',
    await page.$('.vp-library-head .vp-library-pill') === null);
await choosePill('genre', 'Platformer');
check('choosing one narrows the shelf',
    JSON.stringify(await rowNames()) === JSON.stringify(['Virtual Boy Wario Land']));
check('and the pill says it is doing something',
    await page.$eval(pill('genre'), el => el.classList.contains('on')));
check('the line under the shelf\'s name counts what is left',
    (await page.$eval('.vp-library-title .vp-hint', el => el.textContent))
        .startsWith('1 games'));
// two pills are an "and": the platformers of 1995, not the platformers and everything from 1995
await choosePill('year', '1995');
check('two of them narrow together rather than adding up',
    JSON.stringify(await rowNames()) === JSON.stringify(['Virtual Boy Wario Land']));
await choosePill('genre', '*');
// the year is still set, so this is the shelf of 1995 and own-build stays out: a pill is put back on its own,
// not with the rest of the bar
check('and the first row of a menu puts that one pill back to asking nothing',
    JSON.stringify(await rowNames()) === JSON.stringify(['Jack Bros.', 'Virtual Boy Wario Land'])
    && !(await page.$eval(pill('genre'), el => el.classList.contains('on')))
    && await page.$eval(pill('year'), el => el.classList.contains('on')));
await choosePill('year', '*');
await choosePill('kind', 'game');
check('asking for games leaves the cartridges and drops what has no type at all',
    JSON.stringify(await rowNames()) === JSON.stringify(['Jack Bros.', 'Virtual Boy Wario Land']));
await choosePill('kind', '*');
await choosePill('genre', 'Action');
await choosePill('region', 'NTSC-U');
// narrowed to nothing is not empty: the bar and the search are the only way back out, so both stay
check('a shelf narrowed to nothing keeps its heading and its bar all the same',
    await page.$('.vp-library-head') !== null
    && (await pills()).length === 5);
check('a combination nothing answers says so, rather than offering to read the folders again',
    (await page.$$eval('.vp-library-empty p', els => els.map(el => el.textContent)))
        .includes('Nothing in the library matches that.')
    // Jack Bros. is the Action one and NTSC-U, so this is a shelf of one; the check above is that the empty case is
    // reachable at all
    || (await rowNames()).length === 1);
await choosePill('genre', '*');
await choosePill('region', '*');
await page.waitForSelector('.vp-library-list table');
check('and clearing the bar brings the rest back', (await rowNames()).length === 3);

// the one filter that is not the catalog's: save RAM in this origin's storage for one of the game's dumps. Read
// rather than recorded (see LibrarySaves), so a save from an older VUEPort or by hand counts the same
console.log('\nWhat has been saved');
check('the switch is dead while nothing in the library has been saved',
    await page.$eval('.vp-library-toggle', el => el.disabled));
await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const roms = await root.getDirectoryHandle('roms', { create: true });
    // named for the ROM's own file, the folder the emulator writes a save into; wario-land-usa.vb is one of Wario
    // Land's two dumps
    const directory = await roms.getDirectoryHandle('wario-land-usa', { create: true });
    const file = await directory.getFileHandle('save.sram', { create: true });
    const writable = await file.createWritable();
    await writable.write(new Uint8Array(8192).fill(1));
    await writable.close();
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-list table');
await new Promise(resolve => setTimeout(resolve, 300));
check('a save found in the store brings it to life',
    !(await page.$eval('.vp-library-toggle', el => el.disabled)));
await page.click('.vp-library-toggle');
await new Promise(resolve => setTimeout(resolve, 100));
check('and it narrows the shelf to the games that are under way',
    JSON.stringify(await rowNames()) === JSON.stringify(['Virtual Boy Wario Land'])
    && await page.$eval('.vp-library-toggle', el => el.getAttribute('aria-pressed')) === 'true');
check('a save under one dump counts for the game, which is what has been played',
    (await page.$$('.vp-library-list tbody tr')).length === 1);
await page.click('.vp-library-toggle');
await new Promise(resolve => setTimeout(resolve, 100));
check('pressing it again asks nothing again', (await rowNames()).length === 3);

// the bar belongs to the shelf being looked at, so it is not carried onto the next, but each shelf keeps its own
await choosePill('genre', 'Action');
await (await navRow('Favorites')).evaluate(el => el.click());
await new Promise(resolve => setTimeout(resolve, 150));
check('changing shelf does not carry the bar along',
    !(await page.$eval(pill('genre'), el => el.classList.contains('on'))));
await (await navRow('All Games')).evaluate(el => el.click());
await page.waitForSelector('.vp-library-list table');
check('and coming back finds the shelf as it was left',
    await page.$eval(pill('genre'), el => el.classList.contains('on')));
await choosePill('genre', '*');
check('until the pill is put back',
    (await rowNames()).length === 3
    && !(await page.$eval(pill('genre'), el => el.classList.contains('on'))));
// every shelf that holds games carries the bar, so the heading does not move between shelves. A pill with nothing
// behind it on this shelf is drawn dim rather than dropped, for the same reason
const onShelf = async name => {
    await (await navRow(name)).evaluate(el => el.click());
    await new Promise(resolve => setTimeout(resolve, 200));
};
await onShelf('Favorites');
check('a shelf with nothing on it drops its heading and its bar',
    await page.$('.vp-library-head') === null
    && await page.$('.vp-library-filters') === null);
check('and says what that shelf is for instead',
    (await page.$$eval('.vp-library-blank div', els => els.map(el => el.textContent)))
        .includes('Nothing starred yet'));
await onShelf('Unmatched');
check('a shelf with something on it keeps both',
    await page.$('.vp-library-head') !== null
    && (await pills()).length === 5);
check('even where the pills have nothing to offer yet',
    await page.$eval(`${pill('genre')} .vp-dropdown-control`, el => el.disabled));
// Planet VB's shelf too, three hundred homebrew releases nobody reads end to end. The cost is asking the catalog
// about all of them, see the hydrate effect
await onShelf('Homebrew Archive');
check('the catalog\'s shelf carries the bar, and no second Featured switch',
    (await pills()).length === 5
    && await page.$('.vp-library-filter') === null);
// the whole archive, as details arrive one request at a time and a bar built from the first page would hide
// the rest of the catalog
await new Promise(resolve => setTimeout(resolve, 600));
check('and its pills fill in from the whole archive rather than from what is on screen',
    JSON.stringify(await pillMenu('kind'))
    === JSON.stringify(['All types', 'Homebrew', 'Technical Demo'])
    && JSON.stringify(await pillMenu('genre'))
    === JSON.stringify(['Any genre', 'Action', 'Racing', 'Tech']));
await choosePill('kind', 'tech-demo');
check('and narrowing by one of them works the same as on a shelf of your own',
    JSON.stringify(await page.$$eval('.vp-library-row-name',
        els => els.map(el => el.textContent))) === JSON.stringify(['Polygon Engine']));
await choosePill('kind', '*');
// Planet VB's pick is a flag on the featured listing, so it is on the catalog's own cards and no others
await page.click('.vp-library-views [data-view="grid"]');
await page.waitForSelector('.vp-library-card');
check('a featured pick wears the medal, and the releases beside it do not',
    (await marks('Hyper Fighting')).featured
    && !(await marks('Zpace Racers')).featured
    && (await page.$$('.vp-library-card-featured')).length === 1);
check('and a release is called what the catalog files it under',
    (await marks('Polygon Engine')).kind === 'Technical Demo');
check('a game that was cancelled says so beside its kind',
    (await marks('Polygon Engine')).unreleased === 'Unreleased');
check('and one that came out says nothing at all',
    (await marks('Hyper Fighting')).unreleased === '');
await page.click('.vp-library-views [data-view="list"]');
await page.waitForSelector('.vp-library-list table');
check('and the score the catalog gives a release is worn on that shelf as well',
    JSON.stringify(await page.$$eval('.vp-library-list .vp-score',
        els => els.map(el => el.textContent))) === JSON.stringify(['100', '75']));
await onShelf('All Games');
await page.waitForSelector('.vp-library-list table');

await page.evaluate(() => {
    const row = [...document.querySelectorAll('.vp-library-list tbody tr')]
        .find(el => el.textContent.includes('Virtual Boy Wario Land'));
    row.querySelector('.vp-library-row').click();
});
await page.waitForSelector('.vp-library-page');
check('the game\'s own page says it in words, under the credit line',
    await page.$eval('.vp-library-hero-play', el => el.textContent)
    === 'Played 4 times · 2 h 30 min · last played 2 h ago');
check('and each dump says which of them the hours went into',
    (await page.$$eval('.vp-library-files li .vp-library-file-line',
        els => els.map(el => el.textContent))).some(text => text.endsWith('2 h played')));
await page.keyboard.press('Escape');
await page.waitForSelector('.vp-library-list table');
check('and Escape goes back to the shelf', await page.$('.vp-library-page') === null);

console.log('\nOne game');
await page.click('.vp-library-views [data-view="grid"]');
await page.waitForSelector('.vp-library-card');
// the third card is the one with two dumps behind it
await page.evaluate(() => {
    const title = [...document.querySelectorAll('.vp-library-card-title')]
        .find(el => el.textContent === 'Virtual Boy Wario Land');
    title.closest('.vp-library-card').click();
});
await page.waitForSelector('.vp-library-page');
check('a cover opens the game rather than starting it',
    await page.$eval('.vp-library-hero-text h2', el => el.textContent)
    === 'Virtual Boy Wario Land');
check('which lists every ROM of it',
    (await page.$$('.vp-library-files li')).length === 2);
check('the current version first, and it is what plays until somebody says otherwise',
    await page.$$eval('.vp-library-files li:first-child .vp-library-tag',
        els => els.map(el => el.textContent).join(',')) === 'Plays,Latest');
check('under a heading that says what they are',
    await page.$eval('.vp-library-page-body .vp-library-group',
        el => el.textContent) === 'ROMs');
check('it credits the catalog',
    (await page.$$eval('.vp-library-detail-facts dd', els => els.map(el => el.textContent)))
        .includes('Nintendo R&D1'));
const facts = () => page.$$eval('.vp-library-detail-facts',
    el => [...el[0].children].flatMap(pair => [...pair.children].map(node => node.textContent)));
check('a year rather than a date, under a heading that says year',
    (await facts()).join('|').includes('Year|1995'));
check('and no count of the ROMs the list beside it is already showing',
    !(await facts()).includes('ROMs'));
const blurbHeight = () => page.$eval('.vp-library-detail-blurb > p',
    el => [el.clientHeight, el.scrollHeight]);
const [clamped, whole] = await blurbHeight();
check('a long description is clamped rather than let through whole',
    whole > clamped + 1);
check('and held to a measure that can be read across',
    await page.$eval('.vp-library-detail-blurb > p',
        el => el.getBoundingClientRect().width) < 800);
check('with a way to open it',
    await page.$eval('.vp-library-read-all', el => el.textContent) === 'Read all');
await page.click('.vp-library-read-all');
check('which shows the whole of it',
    await page.$eval('.vp-library-detail-blurb > p',
        el => el.clientHeight >= el.scrollHeight - 1));
check('and offers to put it back',
    await page.$eval('.vp-library-read-all', el => el.textContent) === 'Show less');
await page.click('.vp-library-read-all');
check('and carries the card\'s own marks as values among the facts',
    await page.$$eval('.vp-library-detail-facts > div',
        els => els.map(el => [...el.children].map(node => node.textContent).join('|')))
        .then(pairs => pairs.includes('Score|95') && pairs.includes('Type|Official')
            && !pairs.some(pair => pair.startsWith('Status|'))));
// the head of a page rather than a row of controls: a Play button at dropdown height reads as one more form field
check('Play and the buttons beside it are drawn larger than a panel\'s are',
    await page.$$eval('.vp-library-hero-actions .vp-button',
        els => els.every(el => el.getBoundingClientRect().height > 34)));
check('and the star stays square at that size',
    await page.$eval('.vp-library-star', el => {
        const box = el.getBoundingClientRect();
        return Math.abs(box.width - box.height) < 1;
    }));
await page.click('.vp-library-back');
await page.waitForSelector('.vp-library-card');

await page.evaluate(() => {
    const title = [...document.querySelectorAll('.vp-library-card-title')]
        .find(el => el.textContent === 'Jack Bros.');
    title.closest('.vp-library-card').click();
});
await page.waitForSelector('.vp-library-page');

console.log('\nTyping over the catalog');
await page.click('.vp-library-hero-actions .vp-button[aria-label="Edit"]');
await page.waitForSelector('.vp-library-edit');
const titleField = '.vp-library-edit-fields label.wide input';
check('the editor opens on what is shown now',
    await page.$eval(titleField, el => el.value) === 'Jack Bros.');
await page.focus(titleField);
await page.$eval(titleField, el => el.setSelectionRange(0, el.value.length));
await page.type(titleField, 'Jack Bros. (my copy)');
check('a changed field says the catalog disagrees',
    await page.$eval('.vp-library-edit-fields .vp-hint', el => el.textContent)
    === 'Planet VB says: Jack Bros.');
await page.evaluate(() => {
    const button = [...document.querySelectorAll('.vp-library-edit-foot .vp-button')]
        .find(el => el.textContent === 'Save');
    button.click();
});
await page.waitForSelector('.vp-library-edit', { hidden: true });
check('saving hands the window back to the game it was opened from',
    await page.$('.vp-library-page') !== null);
await page.click('.vp-library-back');
await new Promise(resolve => setTimeout(resolve, 150));
check('the shelf takes the new title',
    (await titles()).includes('Jack Bros. (my copy)'));

// kept against the checksum, so a reload is the honest test of it
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');
check('and keeps it across a restart', (await titles()).includes('Jack Bros. (my copy)'));

await page.evaluate(() => {
    const title = [...document.querySelectorAll('.vp-library-card-title')]
        .find(el => el.textContent === 'Jack Bros. (my copy)');
    title.closest('.vp-library-card').click();
});
await page.waitForSelector('.vp-library-page');
check('the game\'s page marks what was typed over',
    await page.$('.vp-library-edited') !== null);
await page.click('.vp-library-hero-cover');
await page.waitForSelector('.vp-library-edit');
await page.evaluate(() => {
    const button = [...document.querySelectorAll('.vp-library-edit-foot .vp-button')]
        .find(el => el.textContent.startsWith('Revert everything'));
    button.click();
});
await page.waitForSelector('.vp-library-edit', { hidden: true });
await page.click('.vp-library-back');
await new Promise(resolve => setTimeout(resolve, 150));
check('and reverting puts the catalog back', (await titles()).includes('Jack Bros.'));

await page.click('.vp-library-views [data-view="list"]');
await page.waitForSelector('.vp-library-list table');
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-list table');
check('the chosen view survives a reload', true);

console.log('\nThe size of the covers');
{
    const shelfSize = () => page.$eval('.vp-library-shelf', el => el.dataset.size);
    const thumb = () => page.$eval('.vp-library-cover.thumb',
        el => el.getBoundingClientRect().width);
    const cover = () => page.$eval('.vp-library-card .vp-library-cover',
        el => el.getBoundingClientRect().width);
    const choose = async size => {
        await page.click(`.vp-library-views [data-size="${size}"]`);
        await new Promise(resolve => setTimeout(resolve, 150));
    };

    check('medium to begin with', await shelfSize() === 'medium');

    const middling = await thumb();
    await choose('small');
    const small = await thumb();
    await choose('large');
    const large = await thumb();
    check('which sizes the thumbnails in the table', small < middling && middling < large);

    // in the grid it is the column width, a different number from the same choice
    await page.click('.vp-library-views [data-view="grid"]');
    await page.waitForSelector('.vp-library-grid');
    const largeCover = await cover();
    await choose('small');
    const smallCover = await cover();
    check('and the covers in the grid', smallCover < largeCover);

    await choose('large');
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.vp-library-grid');
    check('the chosen size survives a reload', await shelfSize() === 'large');

    await choose('medium');
}

console.log('\nThe settings pane');
await page.evaluate(() => {
    const row = [...document.querySelectorAll('.vp-library-nav')]
        .find(el => el.textContent.trim() === 'Manage');
    row.click();
});
await page.waitForSelector('.vp-settings-tab.active');
check('Manage opens the settings window on the Library tab',
    await page.$eval('.vp-settings-tab.active', el => el.textContent.includes('Library')));
await page.keyboard.press('Escape');
await page.waitForSelector('.vp-settings-tab.active', { hidden: true });
await page.keyboard.press('F1');
await page.waitForSelector('.vp-pick');
await new Promise(resolve => setTimeout(resolve, 200));
const opened = await page.evaluate(() => {
    for (const item of document.querySelectorAll('.vp-pick-item')) {
        if ((item.querySelector('span')?.textContent ?? '').trim() === 'Configure Library') {
            item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            return true;
        }
    }
    return false;
});
check('the palette offers Configure Library', opened);
await page.waitForSelector('.vp-settings-tab.active');
check('the rail carries a Library tab, not a Welcome Page one',
    await page.$eval('.vp-settings-tab.active', el => el.textContent.includes('Library'))
    && !(await page.$$eval('.vp-settings-tab', els => els.some(el => el.textContent.includes('Welcome')))));
check('it lists the folder the library was read from',
    await page.$eval('.vp-library-folders li .vp-library-file-name span',
        el => el.textContent) === 'Virtual Boy');
check('and says the browser can no longer reach it, rather than pretending it can',
    await page.$eval('.vp-library-folders li .vp-hint',
        el => el.textContent).then(text => text.includes('No longer known')));
const switches = await page.$$eval('.vp-window-body .vp-bool-title span:first-child',
    els => els.map(el => el.textContent));
check('and carries the switches that decide what a read looks at',
    ['Look inside subfolders', 'Read ROMs inside .zip archives', 'Ask Planet VB about each ROM',
        'Read folders again when VUEPort starts'].every(label => switches.includes(label)));

// a checksum the catalog does not know is a dump that has to be told where it belongs, which is the ROM editor's
// job, along with the dump's name and whether it is the one to play
console.log('\nFiling a ROM under another game');
await page.keyboard.press('Escape');
await seedLibrary();
await page.evaluate(() => window.localStorage.setItem('vueport.library.view', 'grid'));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');
const openCard = async name => {
    await page.evaluate(wanted => {
        const title = [...document.querySelectorAll('.vp-library-card-title')]
            .find(el => el.textContent === wanted);
        title.closest('.vp-library-card').click();
    }, name);
    await page.waitForSelector('.vp-library-page');
};
const clickButton = (scope, label) => page.evaluate((selector, wanted) => {
    const button = [...document.querySelectorAll(selector)]
        .find(el => el.textContent.trim().startsWith(wanted));
    button.click();
}, scope, label);

await openCard('own-build');
await page.click('.vp-library-files li .vp-library-file-edit');
await page.waitForSelector('.vp-library-rom-edit');
check('a ROM has an editor of its own, opened on the dump',
    await page.$eval('.vp-library-rom-identity p', el => el.textContent)
        .then(text => text.includes('CRC32 CCCCCCCC')));

const romTitleField = '.vp-library-rom-edit .vp-library-edit-fields label.wide input';
await page.type(romTitleField, 'Own build v3');
await clickButton('.vp-library-rom-game-actions .vp-button', 'File under');
await page.waitForSelector('.vp-library-picker');
const offered = await page.$$eval('.vp-library-picker-text > span:first-child',
    els => els.map(el => el.textContent));
check('it offers the games already in the library, and not the one it is in',
    offered.includes('Virtual Boy Wario Land') && offered.includes('Jack Bros.')
    && !offered.includes('own-build'));
await page.evaluate(() => {
    const row = [...document.querySelectorAll('.vp-library-picker-list li')]
        .find(el => el.textContent.includes('Virtual Boy Wario Land'));
    row.querySelector('.vp-button').click();
});
check('the game it is going to is shown before anything is written',
    await page.$eval('.vp-library-rom-target-text', el => el.textContent)
        .then(text => text.includes('Virtual Boy Wario Land') && text.includes('when you save')));

await clickButton('.vp-library-edit-foot .vp-button', 'Save');
await page.waitForSelector('.vp-library-rom-edit', { hidden: true });
// the dialog closes before the library has finished announcing the change, and the page it hands back arrives with it
await page.waitForSelector('.vp-library-page');
check('saving follows the dump to the game it was filed under',
    await page.$eval('.vp-library-hero-text h2', el => el.textContent)
    === 'Virtual Boy Wario Land');
check('which now lists three dumps rather than two',
    (await page.$$('.vp-library-files li')).length === 3);
check('and calls the filed one what it was named, not what its file is',
    (await page.$$eval('.vp-library-files li .vp-library-file-title',
        els => els.map(el => el.textContent))).includes('Own build v3'));

await page.click('.vp-library-back');
await new Promise(resolve => setTimeout(resolve, 150));
check('the shelf is one card shorter, because it is one game fewer',
    JSON.stringify(await titles())
    === JSON.stringify(['Jack Bros.', 'Virtual Boy Wario Land']));
check('and nothing is unmatched any more',
    !(await page.$$eval('.vp-library-nav-name', els =>
        els.map(el => el.textContent))).some(name => name.startsWith('Unmatched')));

// kept against the checksum, like everything else the user types here
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');
check('the filing survives a restart', (await titles()).length === 2);

// which ROM Play starts is a per-game choice, starting on the dump the catalog calls current and moved only by the
// user, not the latest flag re-read on every draw; "latest" and "played" are checked apart
console.log('\nWhich dump plays');
await openCard('Virtual Boy Wario Land');
const romTags = () => page.$$eval('.vp-library-files li',
    els => els.map(el => `${el.querySelector('.vp-library-file-title').textContent}`
        + `=${[...el.querySelectorAll('.vp-library-tag')]
            .map(tag => tag.textContent).join(',')}`));
const romNames = () => page.$$eval('.vp-library-files li .vp-library-file-title',
    els => els.map(el => el.textContent));
const chosen = async () => (await romTags()).filter(row => row.includes('=Plays'));
check('the catalog\'s current dump is what plays until somebody says otherwise',
    (await chosen()).length === 1
    && (await chosen())[0] === 'wario-land-usa.vb=Plays,Latest');
const order = await romNames();
await page.evaluate(() => {
    const row = [...document.querySelectorAll('.vp-library-files li')]
        .find(el => el.textContent.includes('Own build v3'));
    row.querySelector('.vp-library-file-prefer').click();
});
await page.waitForFunction(() => [...document.querySelectorAll('.vp-library-files li')]
    .some(el => el.textContent.includes('Own build v3') && el.textContent.includes('Plays')));
const marked = await romTags();
check('one click on another ROM moves what plays to it',
    marked.filter(row => row.includes('=Plays')).length === 1
    && marked.some(row => row.startsWith('Own build v3=Plays')));
// the mark moves, the list does not, so a row jumping to the top does not take the next press with it
check('and the list stays in the order it was in',
    JSON.stringify(await romNames()) === JSON.stringify(order));
check('while the latest version is still the one the catalog calls latest',
    marked.some(row => row === 'wario-land-usa.vb=Latest'));
check('and the row that plays no longer offers to be picked again',
    await page.evaluate(() => [...document.querySelectorAll('.vp-library-files li')]
        .filter(el => el.querySelector('.vp-library-file-prefer')).length) === 2);
// kept per game and against the checksum, so it survives a restart
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');
await openCard('Virtual Boy Wario Land');
check('the choice survives a restart',
    (await chosen()).length === 1 && (await chosen())[0].startsWith('Own build v3='));
// saying a dump is the latest version says nothing about what plays
await page.evaluate(() => {
    const row = [...document.querySelectorAll('.vp-library-files li')]
        .find(el => el.textContent.includes('wario-land-japan'));
    row.querySelector('.vp-library-file-edit').click();
});
await page.waitForSelector('.vp-library-rom-edit');
await page.click('.vp-library-rom-check input');
await clickButton('.vp-library-edit-foot .vp-button', 'Save');
await page.waitForSelector('.vp-library-rom-edit', { hidden: true });
const relatest = await romTags();
check('calling another dump the latest version leaves what plays alone',
    relatest.some(row => row.startsWith('Own build v3=Plays'))
    && relatest.some(row => row === 'wario-land-japan.vb=Latest')
    && relatest.filter(row => row.includes('Latest')).length === 1);
await page.evaluate(() => {
    const row = [...document.querySelectorAll('.vp-library-files li')]
        .find(el => el.textContent.includes('wario-land-japan'));
    row.querySelector('.vp-library-file-edit').click();
});
await page.waitForSelector('.vp-library-rom-edit');
await page.evaluate(() => {
    const checks = document.querySelectorAll('.vp-library-rom-check input');
    checks[checks.length - 1].click();
});
await clickButton('.vp-library-edit-foot .vp-button', 'Save');
await page.waitForSelector('.vp-library-rom-edit', { hidden: true });
check('the ROM editor sets the same choice',
    (await chosen()).length === 1
    && (await chosen())[0].startsWith('wario-land-japan.vb='));

// Recently Played fills itself from playing rather than from a folder. It has no order to choose and no covers to
// size, so it carries the one control it has a use for instead
console.log('\nRecently Played');
await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('recent', { create: true });
    const file = await directory.getFileHandle('index.json', { create: true });
    const writable = await file.createWritable();
    const now = Date.now();
    await writable.write(JSON.stringify([
        { id: 'r1', name: 'Red Alarm (USA).vb', bytes: 1048576, source: 'file', openedAt: now - 60000 },
        // from a link, which the confirmation below is really about: this copy may be the only one there is
        { id: 'r2', name: 'Teleroboxer.vb', bytes: 1048576, source: 'url', url: 'https://example.invalid/t.vb', openedAt: now - 7200000 },
        { id: 'r3', name: 'jack-bros.vb', bytes: 1048576, source: 'file', openedAt: now - 86400000 },
    ]));
    await writable.close();
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');
await onShelf('Recently Played');
const recentNames = () => page.$$eval('.vp-library-recent-card .vp-library-card-title',
    els => els.map(el => el.textContent));
check('the shelf holds what was opened, newest first',
    JSON.stringify(await recentNames())
    === JSON.stringify(['Red Alarm (USA)', 'Teleroboxer', 'jack-bros']));
check('and carries a way to empty it where another shelf carries its sort',
    await page.$eval('.vp-library-clear-recent', el => el.textContent.trim()) === 'Clear list'
    && await page.$('.vp-library-sort') === null);
// asked about rather than done, as the copies behind the list go with it. The count is in the question, as the
// search box narrows what is on screen and this does not
await page.click('.vp-library-clear-recent');
await page.waitForSelector('.vp-modal');
check('pressing it asks first, and says how many it means',
    (await page.$eval('.vp-modal h2', el => el.textContent)).includes('3 ROMs'));
check('and says what goes with them',
    (await page.$$eval('.vp-modal p', els => els.map(el => el.textContent)))
        .join(' ').includes('copies'));
await page.click('.vp-modal-buttons .vp-button.secondary');
await new Promise(resolve => setTimeout(resolve, 150));
check('saying no leaves the list where it was', (await recentNames()).length === 3);
await page.click('.vp-library-clear-recent');
await page.waitForSelector('.vp-modal');
await page.evaluate(() => [...document.querySelectorAll('.vp-modal-buttons .vp-button')]
    .find(el => !el.classList.contains('secondary')).click());
await new Promise(resolve => setTimeout(resolve, 300));
check('saying yes empties it, and the column agrees',
    (await page.$$('.vp-library-recent-card')).length === 0
    && await navCount('Recently Played') === '0');
// a shelf with nothing on it has no head and no bar, so the button that emptied it goes too
check('and the button goes with the list it emptied',
    await page.$('.vp-library-clear-recent') === null);
await onShelf('All Games');
await page.waitForSelector('.vp-library-card, .vp-library-list table');

console.log('\nA game of your own');
await page.click('.vp-library-back');
await page.waitForSelector('.vp-library-card');
await page.click('.vp-library-new-game');
await page.waitForSelector('.vp-modal-input');
await page.type('.vp-modal-input', 'My Hacks');
await clickButton('.vp-modal-buttons .vp-button', 'Create');
await page.waitForSelector('.vp-library-page');
check('a game can be made without a catalog entry behind it',
    await page.$eval('.vp-library-hero-text h2', el => el.textContent) === 'My Hacks');
check('and says it holds nothing yet rather than looking broken',
    await page.$eval('.vp-library-page-body .vp-hint', el => el.textContent)
        .then(text => text.startsWith('Nothing is filed under this game yet')));
await page.click('.vp-library-back');
await new Promise(resolve => setTimeout(resolve, 150));
check('it takes its place on the shelf', (await titles()).includes('My Hacks'));

await openCard('My Hacks');
await page.click('.vp-library-hero-actions .vp-button[aria-label="Edit"]');
await page.waitForSelector('.vp-library-edit');
await clickButton('.vp-library-edit-foot .vp-button', 'Delete this game');
await page.waitForSelector('.vp-modal-buttons');
await clickButton('.vp-modal-buttons .vp-button', 'Delete');
await page.waitForSelector('.vp-library-card');
check('and deleting it leaves the library as it was',
    !(await titles()).includes('My Hacks'));

check('nothing errored', errors.length === 0);
if (errors.length > 0) {
    console.log(errors.join('\n'));
}

await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
