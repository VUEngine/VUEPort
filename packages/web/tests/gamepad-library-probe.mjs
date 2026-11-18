/**
 * Checks the library from a game pad: L/R step through the shelves in column order, the d-pad moves a highlight by
 * where covers are drawn, A opens the game's page and B returns to the same cover, Start starts a game off a shelf, and
 * with the command palette open the pad is the palette's alone. Fake Xbox pad as in gamepad-palette-probe.mjs, library
 * written straight into OPFS as in library-coverflow-probe.mjs.
 *
 * Usage: node tests/gamepad-library-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) { failures++; }
};

if (!existsSync(path.join(dist, 'index.html'))) {
    console.log('\nskipped: dist is not built\n');
    process.exit(0);
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'vueport-pad-library-'));
const romPath = path.join(scratch, 'probe.vb');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('PAD LIBRARY PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 1;
    await writeFile(romPath, rom);
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
    '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
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
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
const KNOWN_NOISE = /defaultProps will be removed from function components/;
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => {
    if (message.type() === 'error' && !KNOWN_NOISE.test(message.text())) {
        errors.push(message.text());
    }
});
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

await page.evaluateOnNewDocument(() => {
    const pad = {
        index: 0,
        id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
        mapping: 'standard',
        connected: true,
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const A = 0, B = 1, L = 4, R = 5, START = 9, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15, HOME = 16;

async function press(index, holdMs = 100) {
    await page.evaluate(i => { window.__pad.buttons[i] = { pressed: true, touched: true, value: 1 }; }, index);
    await wait(holdMs);
    await page.evaluate(i => { window.__pad.buttons[i] = { pressed: false, touched: false, value: 0 }; }, index);
    await wait(250);
}

const heading = () => page.$eval('.vp-library-head h2', node => node.textContent ?? '').catch(() => '');
const gridCards = () => page.evaluate(() => document.querySelectorAll('.vp-library-grid .vp-library-card').length);
const selected = () => page.evaluate(() => {
    const node = document.querySelector('.is-pad-selected');
    if (!node) {
        return undefined;
    }
    const box = node.getBoundingClientRect();
    return { id: node.getAttribute('data-pad-card'), x: Math.round(box.left), y: Math.round(box.top) };
});

try {
    // twelve games, more than one row of covers at this width
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.evaluate(async count => {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('library', { create: true });
        const file = await directory.getFileHandle('index.json', { create: true });
        const writable = await file.createWritable();
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const entries = [];
        for (let index = 0; index < count; index++) {
            const name = `${letters[index]} Game`;
            entries.push({
                id: `${index}`.padStart(8, '0'),
                files: [{ folderId: 'f1', path: `${index}.vb`, name: `${index}.vb`, bytes: 1048576, modifiedAt: 1 }],
                header: { name: name.toUpperCase(), maker: '01', code: 'VPRB', version: 0 },
                bytes: 1048576,
                addedAt: 1,
                catalog: {
                    itemId: index + 1, title: name, developer: 'Somebody', publisher: 'Somebody',
                    released: '1995-12-01', genre: 'Action', players: '1 Player', region: 'NTSC-U',
                    status: 'Released', kind: 'homebrew', description: '', latest: true, score: 80,
                },
                lookedUpAt: 2,
                unmatched: false,
            });
        }
        await writable.write(JSON.stringify({
            version: 1,
            folders: [{ id: 'f1', name: 'Virtual Boy', addedAt: 1, readAt: 2, count }],
            entries,
        }));
        await writable.close();
    }, 12);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.vp-library');
    await wait(800);
    await page.evaluate(() => window.dispatchEvent(new Event('gamepadconnected')));
    await wait(200);

    console.log('\nShelves');
    const first = await heading();
    await press(R);
    const second = await heading();
    check('R steps to the next shelf', second !== '' && second !== first);
    await press(L);
    check('L steps back', await heading() === first);
    for (let n = 0; n < 8 && await gridCards() !== 12; n++) {
        await press(R);
    }
    check('the shelf of all twelve is among them', await gridCards() === 12);

    console.log('\nMoving');
    check('nothing is highlighted before the pad moves', await selected() === undefined);
    await press(DOWN);
    const start = await selected();
    const firstCover = await page.$eval('.vp-library-grid .vp-library-card', node => node.getAttribute('data-pad-card'));
    check('the first move lands on the first cover', start !== undefined && start.id === firstCover);
    await press(RIGHT);
    const beside = await selected();
    check('right is the cover beside it', beside !== undefined && beside.y === start.y && beside.x > start.x);
    await press(DOWN);
    const below = await selected();
    check('down is the cover below it', below !== undefined && below.y > beside.y && Math.abs(below.x - beside.x) < 5);
    await press(UP);
    await press(LEFT);
    check('and up and left come back', (await selected())?.id === start.id);
    await press(RIGHT);

    console.log('\nA card\'s buttons');
    const before = (await selected())?.id;
    const padAction = () => page.evaluate(() => {
        const node = document.querySelector('.is-pad-action');
        return node ? (node.getAttribute('aria-label') ?? node.textContent ?? '').trim() : undefined;
    });
    await press(A);
    check('A goes into the card\'s buttons rather than opening it',
        await page.$('.vp-library-page') === null && await padAction() === 'Play');
    check('which are showing', await page.$eval('.is-pad-selected .vp-library-card-actions',
        node => getComputedStyle(node).opacity === '1').catch(() => false));
    await press(RIGHT);
    check('right is the next button — Details', await padAction() === 'Details');
    await press(B);
    check('B comes back out to the card', await padAction() === undefined && (await selected())?.id === before);
    await press(A);
    await press(RIGHT);
    await press(A);
    check('A on Details opens the game\'s page', await page.$('.vp-library-page') !== null);

    console.log('\nThe page\'s ROMs');
    await press(DOWN);
    check('the d-pad picks a ROM', await page.$('.vp-library-files li.is-pad-selected') !== null);
    await press(A);
    check('A goes into its buttons', await padAction() === 'Play');
    await press(B);
    check('B comes out of them', await padAction() === undefined
        && await page.$('.vp-library-files li.is-pad-selected') !== null);
    await press(B);
    check('and B again goes back to the shelf', await page.$('.vp-library-page') === null && await gridCards() === 12);
    check('with the same cover highlighted', (await selected())?.id === before);

    console.log('\nThe coverflow');
    await page.click('.vp-library-views [data-view="coverflow"]');
    await page.waitForSelector('.vp-library-flow-stage');
    await wait(500);
    const front = () => page.$eval('.vp-library-flow-cover.middle', node => node.getAttribute('data-pad-card'));
    const flipped = () => page.$eval('.vp-library-flow-cover.middle', node => node.getAttribute('data-flipped') === 'true');
    const atStart = await front();
    await press(RIGHT);
    await wait(400);
    check('right steps the shelf', await front() !== atStart);
    await press(DOWN);
    await wait(700);
    check('down turns the box over', await flipped());
    await press(UP);
    await wait(700);
    check('and up turns it back', !(await flipped()));
    await press(A);
    check('A goes into the box\'s buttons', await padAction() === 'Play');
    check('which are showing', await page.$eval('.vp-library-flow-cover.middle .vp-library-flow-launch',
        node => getComputedStyle(node).opacity === '1'));
    await press(RIGHT);
    check('right goes on to Details', await padAction() === 'Details');
    await press(RIGHT);
    check('and on to turning the box, the last of them', await padAction() === 'Show Back');
    check('which is showing as well', await page.$eval('.vp-library-flow-cover.middle .vp-library-flow-flip',
        node => getComputedStyle(node).opacity === '1'));
    await press(A);
    await wait(700);
    check('A on it turns the box over', await flipped());
    check('and stays on it, now offering the front', await padAction() === 'Show Front');
    await press(A);
    await wait(700);
    check('so a second A turns it back', !(await flipped()));
    await press(LEFT);
    await press(A);
    check('and Details opens its page', await page.$('.vp-library-page') !== null);
    await press(B);
    await page.click('.vp-library-views [data-view="grid"]');
    await wait(500);

    console.log('\nThe keyboard');
    const keyFirst = await heading();
    await page.keyboard.press('Tab');
    await wait(250);
    check('Tab steps to the next shelf', await heading() !== keyFirst);
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    await wait(250);
    check('Shift+Tab steps back', await heading() === keyFirst);
    const keyStart = (await selected())?.id;
    await page.keyboard.press('ArrowRight');
    await wait(150);
    const keyRight = (await selected())?.id;
    check('the arrows move like the d-pad', keyRight !== undefined && keyRight !== keyStart);
    await page.keyboard.press('Enter');
    await wait(150);
    check('Enter goes into the card\'s buttons, like A', await padAction() === 'Play');
    await page.keyboard.press('Escape');
    await wait(150);
    check('Escape comes back out, like B', await padAction() === undefined);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await wait(300);
    check('Enter on Details opens the page', await page.$('.vp-library-page') !== null);
    await page.keyboard.press('Backspace');
    await wait(300);
    check('and Backspace goes back, like Escape', await page.$('.vp-library-page') === null);
    await page.keyboard.press('ArrowLeft');
    await wait(150);
    const beforeTyping = (await selected())?.id;
    await page.focus('.vp-library-search input').catch(() => undefined);
    const typing = await page.evaluate(() => document.activeElement?.tagName === 'INPUT');
    if (typing) {
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Backspace');
        await wait(150);
        check('a field being typed into keeps its arrows and Backspace',
            (await selected())?.id === beforeTyping && await page.$('.vp-library-page') === null);
        await page.evaluate(() => document.activeElement?.blur());
    } else {
        console.log('  (no search field found; skipped)');
    }

    console.log('\nThe palette over the library');
    await press(HOME);
    check('Home opens the palette', await page.$('.vp-pick') !== null);
    const shelfBefore = (await selected())?.id;
    await press(DOWN);
    check('and the d-pad moves through it, not the shelf', (await selected())?.id === shelfBefore);
    await press(HOME);
    check('Home closes it', await page.$('.vp-pick') === null);

    console.log('\nStart');
    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await chooser.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await wait(1500);
    await page.mouse.move(650, 500);
    await wait(200);
    await page.evaluate(() => document.querySelector('.vp-strip-button[data-control="closeRom"]')?.click());
    await wait(1000);
    for (let n = 0; n < 8 && await page.$('.vp-library-recent-card') === null; n++) {
        await press(R);
    }
    check('Recently Played has the ROM on it', await page.$('.vp-library-recent-card') !== null);
    await press(RIGHT);
    check('it can be highlighted', (await selected()) !== undefined);
    await press(START);
    await wait(1500);
    check('Start starts it', await page.$('.vp-library') === null);

    check('no page errors', errors.length === 0);
    if (errors.length) {
        console.log(errors.join('\n'));
    }
} finally {
    await browser.close();
    server.close();
    await rm(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
