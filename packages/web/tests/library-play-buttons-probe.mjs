/**
 * The Play and Resume buttons on the library's shelves and a game's page: Play always, Resume only for a game put away
 * by Suspend and Resume. In grid and coverflow they sit over the cover's corner, hidden until the pointer is on the
 * card; in the list they are a row's own icons. Pressing one starts the game rather than opening its page; Resume skips
 * the question opening the game otherwise asks, Play still asks it. The game is put away for real, and the library is
 * pointed at the ROM as an imported folder, the one kind a probe can make without a native picker.
 *
 * Usage: node tests/library-play-buttons-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
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
const rom = Buffer.alloc(16 * 131072);
{
    const header = rom.length - 544;
    rom.write('PLAY BUTTON PROBE'.padEnd(20, ' '), header, 'ascii');
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
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('virtual-boy.com') || url.includes('api.vueport.net')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));
const modalTitle = () => page.$eval('.vp-modal h2', el => el.textContent ?? '').catch(() => '');
const answerDialog = async (yes) => {
    await page.waitForSelector('.vp-modal', { timeout: 5000 });
    const title = await modalTitle();
    await page.evaluate(agreed => {
        const buttons = [...document.querySelectorAll('.vp-modal-buttons .vp-button')];
        (agreed ? buttons[1] : buttons[0])?.click();
    }, yes);
    await settle();
    return title;
};
const closeRom = async () => {
    await page.click('.vp-titlebar-button[data-control="save-states"]');
    await settle();
    await page.click('.vp-strip-button[data-control="closeRom"]');
    await settle(2500);
};
const suspendExists = () => page.evaluate(async () => {
    try {
        const root = await navigator.storage.getDirectory();
        const dir = await (await root.getDirectoryHandle('roms')).getDirectoryHandle('probe');
        const file = await (await dir.getFileHandle('state-suspend.state')).getFile();
        return file.size > 0;
    } catch {
        return false;
    }
});

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.evaluate(() => {
    const settings = JSON.parse(window.localStorage.getItem('vueport.settings') ?? '{}');
    window.localStorage.setItem('vueport.settings', JSON.stringify({ ...settings, suspendResumeEnabled: true }));
    window.localStorage.setItem('vueport.library.startPage', 'all');
    window.localStorage.setItem('vueport.library.view', 'grid');
});
await page.reload({ waitUntil: 'networkidle0' });

const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await settle(1500);
await closeRom();
check('closing the game wrote its suspend state', await suspendExists());

// the same ROM as an imported folder, the one kind a probe can make without a native picker
await page.evaluate(async bytes => {
    const root = await navigator.storage.getDirectory();
    const library = await root.getDirectoryHandle('library', { create: true });
    const imported = await (await library.getDirectoryHandle('imported', { create: true }))
        .getDirectoryHandle('f1', { create: true });
    const write = async (dir, name, data) => {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(data);
        await writable.close();
    };
    const data = Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
    await write(imported, '0', data);
    await write(imported, '1', data);
    const files = ['probe.vb', 'other.vb'].map((name, at) => ({
        path: name, name, bytes: data.length, modifiedAt: 1, store: String(at),
    }));
    await write(imported, 'index.json', JSON.stringify({ version: 1, name: 'Probe', importedAt: 1, files }));
    const entries = ['Played Game', 'Unplayed Game'].map((title, at) => ({
        id: `0000000${at + 1}`,
        files: [{ folderId: 'f1', path: files[at].path, name: files[at].name, bytes: data.length, modifiedAt: 1 }],
        header: { name: title.toUpperCase(), maker: '01', code: 'VPRB', version: 0 },
        bytes: data.length,
        addedAt: 1,
        catalog: {
            itemId: at + 1, title, developer: 'Somebody', publisher: 'Somebody',
            released: '1995-12-01', genre: 'Action', players: '1 Player', region: 'NTSC-U',
            status: 'Released', kind: 'homebrew', description: '', latest: true, score: 80,
        },
        lookedUpAt: 2,
        unmatched: false,
    }));
    await write(library, 'index.json', JSON.stringify({
        version: 1,
        folders: [{ id: 'f1', name: 'Probe', kind: 'imported', addedAt: 1, readAt: 2, count: 2 }],
        entries,
    }));
}, rom.toString('base64'));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');
await settle(800);

const cardButtons = () => page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.vp-library-card')].map(card => [
        card.querySelector('.vp-library-card-title')?.textContent,
        [...card.querySelectorAll('.vp-library-card-actions button')].map(b => b.getAttribute('aria-label')),
    ])));

console.log('\nThe grid');
const buttons = await cardButtons();
check('the played game offers Play and Resume, and Details',
    JSON.stringify(buttons['Played Game']) === '["Play","Resume","Details"]', JSON.stringify(buttons));
check('the unplayed one only Play and Details',
    JSON.stringify(buttons['Unplayed Game']) === '["Play","Details"]', JSON.stringify(buttons));

const layer = () => page.evaluate(() => {
    const card = [...document.querySelectorAll('.vp-library-card')]
        .find(el => el.querySelector('.vp-library-card-title')?.textContent === 'Played Game');
    const actions = card.querySelector('.vp-library-card-actions');
    const cover = card.querySelector('.vp-library-cover').getBoundingClientRect();
    const play = actions.querySelector('button').getBoundingClientRect();
    return {
        opacity: getComputedStyle(actions).opacity,
        inside: play.left >= cover.left && play.bottom <= cover.bottom
            && play.left - cover.left < cover.width / 2 && cover.bottom - play.bottom < cover.height / 2,
    };
});
await page.mouse.move(5, 5);
await settle(300);
check('the buttons are hidden while the pointer is elsewhere', (await layer()).opacity === '0');
const card = await page.evaluateHandle(() => [...document.querySelectorAll('.vp-library-card')]
    .find(el => el.querySelector('.vp-library-card-title')?.textContent === 'Played Game'));
await card.hover();
await settle(300);
const shown = await layer();
check('and shown while it is on the card', shown.opacity === '1', shown.opacity);
check('in the lower left corner of the cover', shown.inside);

console.log('\nResume');
await page.evaluate(el => el.querySelector('.vp-library-card-actions button[aria-label="Resume"]').click(), card);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await settle(2500);
check('starts the game rather than opening its page', !(await page.$('.vp-library-page')));
check('without asking whether to resume', !(await page.$('.vp-modal')), await modalTitle());
check('and the suspend state is still there to come back to', await suspendExists());
await closeRom();

console.log('\nPlay');
await page.waitForSelector('.vp-library-card');
await settle(800);
await page.evaluate(() => [...document.querySelectorAll('.vp-library-card')]
    .find(el => el.querySelector('.vp-library-card-title')?.textContent === 'Played Game')
    .querySelector('.vp-library-card-actions button[aria-label="Play"]').click());
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
const asked = await answerDialog(true).catch(() => '');
check('still asks the question opening the game asks', /resume/i.test(asked), asked);
await settle(1500);
await closeRom();

console.log('\nThe list');
await page.waitForSelector('.vp-library-card');
await page.evaluate(() => document.querySelector('[data-view="list"]').closest('button, label, [role="radio"]')?.click()
    ?? document.querySelector('[data-view="list"]').click());
await page.waitForSelector('.vp-library-list tr td');
const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.vp-library-list tbody tr')]
    .map(row => [
        row.querySelector('.vp-library-row-name')?.textContent,
        [...row.querySelectorAll('.vp-library-row-actions button')].map(b => b.getAttribute('aria-label')),
    ])));
check('a row has Play and Resume beside Details',
    JSON.stringify(rows['Played Game']) === '["Play","Resume","Details"]', JSON.stringify(rows));
check('and only Play where there is nothing to resume',
    JSON.stringify(rows['Unplayed Game']) === '["Play","Details"]', JSON.stringify(rows));

console.log('\nThe coverflow');
await page.evaluate(() => document.querySelector('[data-view="coverflow"]').closest('button, label, [role="radio"]')?.click()
    ?? document.querySelector('[data-view="coverflow"]').click());
await page.waitForSelector('.vp-library-flow-cover.middle');
await settle(500);
const flow = await page.evaluate(() => [...document.querySelectorAll('.vp-library-flow-cover')]
    .map(cover => ({
        middle: cover.classList.contains('middle'),
        buttons: [...cover.querySelectorAll('.vp-library-flow-launch button')].map(b => b.getAttribute('aria-label')),
    })));
check('the middle box carries Play and Resume, and Details',
    JSON.stringify(flow.find(cover => cover.middle)?.buttons) === '["Play","Resume","Details"]', JSON.stringify(flow));
check('and none of the others do', flow.filter(cover => !cover.middle).every(cover => cover.buttons.length === 0));
await page.mouse.move(5, 5);
await settle(300);
const flowHidden = await page.$eval('.vp-library-flow-cover.middle .vp-library-flow-launch', el => getComputedStyle(el).opacity);
await page.hover('.vp-library-flow-cover.middle .vp-library-flow-face.front');
await settle(300);
const flowShown = await page.$eval('.vp-library-flow-cover.middle .vp-library-flow-launch', el => getComputedStyle(el).opacity);
check('hidden until the pointer is on it', flowHidden === '0' && flowShown === '1', `${flowHidden} → ${flowShown}`);

console.log('\nA game\'s page');
await page.evaluate(() => document.querySelector('[data-view="grid"]').closest('button, label, [role="radio"]')?.click()
    ?? document.querySelector('[data-view="grid"]').click());
await page.waitForSelector('.vp-library-card');
await page.evaluate(() => [...document.querySelectorAll('.vp-library-card')]
    .find(el => el.querySelector('.vp-library-card-title')?.textContent === 'Played Game')
    .querySelector('.vp-library-card-open').click());
await page.waitForSelector('.vp-library-page');
await settle(300);
const hero = await page.$$eval('.vp-library-hero-actions .vp-button', els => els.map(el => el.textContent.trim()).filter(Boolean));
check('the head has Resume beside Play', hero[0] === 'Play' && hero[1] === 'Resume', JSON.stringify(hero));
const rowButtons = await page.$$eval('.vp-library-files li .vp-library-file-head .vp-button', els => els.map(el => el.textContent.trim()));
check('and so does the ROM that was put away', JSON.stringify(rowButtons) === '["Play","Resume"]', JSON.stringify(rowButtons));
await page.evaluate(() => [...document.querySelectorAll('.vp-library-hero-actions .vp-button')]
    .find(el => el.textContent.trim() === 'Resume').click());
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await settle(2500);
check('Resume there starts without asking either', !(await page.$('.vp-modal')), await modalTitle());
await closeRom();

await page.waitForSelector('.vp-library-page, .vp-library-card');
await page.goBack().catch(() => undefined);

check('nothing errored throughout', errors.length === 0, errors.join(' | '));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
