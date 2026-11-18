/**
 * Checks the save-state library end to end in a real browser: saving makes a new state rather than filling a slot, the
 * browser beside the screen shows it with its picture, it can be named, loaded and deleted, automatic states take
 * themselves and rotate, and a closed game is offered back on the next launch. All through the chrome (keys, strip
 * buttons, confirm dialog); the files and the store have their own probes in core.
 *
 * Usage: node tests/save-states-probe.mjs (after `yarn build`)
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
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` \u2014 ${detail}` : ''}`);
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
    const rom = Buffer.alloc(16 * 131072);
    const header = rom.length - 544;
    rom.write('SAVE STATE PROBE'.padEnd(20, ' '), header, 'ascii');
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
// the labels below are the English ones, whatever language this machine speaks
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] });
});
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

// the title bar looks the ROM's title up on Planet VB; answer with a hit, as even a handled 404 is logged to the
// console by Chrome and would trip the checks below
await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('/pvb/?featured')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    if (/api\.vueport\.net\/pvb\/[0-9a-f]{8}\//.test(url)) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({
                id: 1, title: 'Probe Game', hash: { crc32: '00000000' },
                item: [{ id: 1, title: 'Probe Game', type: 'homebrew' }],
            }),
        });
        return;
    }
    request.continue();
});

await page.goto(origin, { waitUntil: 'networkidle0' });
const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await new Promise(resolve => setTimeout(resolve, 1500));


const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

const openRom = async () => {
    const [picker] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await picker.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await settle(1500);
};

const rows = () => page.evaluate(() => [...document.querySelectorAll('.vp-states-row')].map(row => ({
    name: row.querySelector('.vp-panel-row-name')?.textContent ?? '',
    date: row.querySelector('.vp-states-date')?.textContent ?? '',
    meta: row.querySelector('.vp-states-meta')?.textContent ?? '',
    thumbnail: row.querySelector('.vp-states-thumb img')?.getAttribute('src')?.slice(0, 14) ?? '',
})));

const openStrip = async () => {
    const open = await page.$('.vp-panel-aside .vp-states-row, .vp-panel-aside .vp-panel-empty-fill');
    if (!open) {
        await page.click('.vp-titlebar-button[data-control="save-states"]');
        await settle();
    }
};

// through the DOM rather than the mouse: row actions are faded out until hovered (see .vp-panel-row-action), and
// what they do is under test, not the hover behaviour
const rowAction = (label, index = 0) => page.evaluate((name, at) => {
    const row = document.querySelectorAll('.vp-states-row')[at];
    row?.querySelector(`button[aria-label="${name}"]`)?.click();
}, label, index);

const answerDialog = async (yes) => {
    await page.waitForSelector('.vp-modal', { timeout: 5000 });
    const title = await page.$eval('.vp-modal h2', el => el.textContent ?? '');
    await page.evaluate(agreed => {
        const buttons = [...document.querySelectorAll('.vp-modal-buttons .vp-button')];
        (agreed ? buttons[1] : buttons[0])?.click();
    }, yes);
    await settle();
    return title;
};

const running = () => page.evaluate(() =>
    !document.querySelector('.vp-strip-button[data-control="pause"]')?.classList.contains('vp-strip-button-on'));

console.log('\nAn empty library');
await openStrip();
check('the panel says the game has no states yet',
    await page.$eval('.vp-panel-aside', el => /no save states/i.test(el.textContent ?? '')));
check('and Load State has nothing to load',
    await page.$eval('.vp-strip-button[data-control="load-state"]', el => el.hasAttribute('disabled')));

console.log('\nSaving makes a new state every time');
await page.focus('.vp-screen');
await page.keyboard.press('Digit1');
await settle(1200);
await page.keyboard.press('Digit1');
await settle(1200);
const saved = await rows();
check('two saves, two rows', saved.length === 2, `${saved.length} row(s)`);
check('each carries the picture of its moment',
    saved.every(row => row.thumbnail === 'data:image/png'), JSON.stringify(saved.map(r => r.thumbnail)));
check('each says when it was taken', saved.every(row => /\d/.test(row.name)), JSON.stringify(saved.map(r => r.name)));
check('and both are states somebody made',
    saved.every(row => /manual/i.test(row.meta)), JSON.stringify(saved.map(r => r.meta)));
check('and how long ago that was',
    saved.every(row => row.date.length > 0), JSON.stringify(saved.map(r => r.date)));
check('Load State has something to load now',
    await page.$eval('.vp-strip-button[data-control="load-state"]', el => !el.hasAttribute('disabled')));

console.log('\nNaming one');
await rowAction('Rename');
await page.waitForSelector('.vp-states-rename');
await page.type('.vp-states-rename', 'Before the boss');
await page.keyboard.press('Enter');
await settle(600);
check('the name shows on the row', (await rows())[0].name === 'Before the boss');
// closed and reopened, so what is shown was read back from the file rather than remembered by the panel
await page.click('.vp-titlebar-button[data-control="save-states"]');
await settle();
await openStrip();
check('and survives the panel being closed and reopened',
    (await rows())[0].name === 'Before the boss');
check('with the time it was taken on its own line now that it has a name',
    /\d.+\u00b7./.test((await rows())[0].date), (await rows())[0].date);

console.log('\nLoading one');
await page.click('.vp-states-row .vp-states-thumb');
await settle(1500);
check('the game is still running afterwards', await running());
// any of them: the toasts for the two saved states last six seconds and are very likely still up
const toasts = await page.evaluate(() =>
    [...document.querySelectorAll('.vp-toast-text')].map(el => el.textContent ?? ''));
check('and a toast says a state was loaded',
    toasts.some(text => /loaded/i.test(text)), JSON.stringify(toasts));

console.log('\nThrowing one away');
await rowAction('Delete');
const deleteTitle = await answerDialog(true);
check('deleting asks first', /delete save state/i.test(deleteTitle), deleteTitle);
await settle(500);
check('and the row goes', (await rows()).length === 1);

console.log('\nA state of another build');
const otherBuild = path.join(scratch, 'other-build.state');
{
    // a state of this ROM restamped with another header: what a state from before the last build looks like
    const { VbMachine } = require('vueport-core/lib/probe/vb-machine');
    const core = await readFile(path.join(path.dirname(require.resolve('vueport-core/package.json')), 'wasm', 'shrooms', 'core.wasm'));
    const machine = await VbMachine.create({ core, rom: await readFile(romPath) });
    machine.runFrames(5);
    const file = await machine.saveState('other build');
    file[16] ^= 0xff;
    await writeFile(otherBuild, file);
}
const before = (await rows()).length;
const picker = await page.$('.vp-panel-aside input[type=file]');
await picker.uploadFile(otherBuild);
let warning = await answerDialog(false);
check('importing it warns rather than refuses', /another ROM/i.test(warning), warning);
await settle(500);
check('declined, nothing is imported', (await rows()).length === before, `${(await rows()).length} rows`);
await picker.uploadFile(otherBuild);
await answerDialog(true);
await settle(800);
check('agreed, it is', (await rows()).length === before + 1, `${(await rows()).length} rows`);
await page.evaluate(() => [...document.querySelectorAll('.vp-states-row')]
    .find(row => row.textContent?.includes('other build'))?.querySelector('.vp-states-thumb')?.click());
warning = await answerDialog(true);
check('loading it warns too', /another ROM/i.test(warning), warning);
await settle(1500);
const loadedToasts = await page.evaluate(() =>
    [...document.querySelectorAll('.vp-toast-text')].map(el => el.textContent ?? ''));
check('and then loads it', loadedToasts.some(text => /loaded/i.test(text)), JSON.stringify(loadedToasts));

console.log('\nThe automatic states');
// ten seconds apart and two kept, the shortest the settings allow, so the probe does not sit through a minute
await page.evaluate(() => {
    const settings = JSON.parse(window.localStorage.getItem('vueport.settings') ?? '{}');
    window.localStorage.setItem('vueport.settings', JSON.stringify({
        ...settings,
        autoSaveStatesEnabled: true,
        autoSaveStateInterval: 10,
        autoSaveStateCount: 2,
        suspendResumeEnabled: true,
    }));
});
await page.reload({ waitUntil: 'networkidle0' });
await openRom();
// a reload under a running game wrote no suspend state, but one may be left from an earlier check; start fresh so
// the rotation is measured cleanly
if (await page.$('.vp-modal')) {
    await answerDialog(false);
}
await openStrip();
const beforeAuto = (await rows()).length;
await settle(26000);
const withAuto = await rows();
const automatic = withAuto.filter(row => /automatic/i.test(row.meta));
check('states take themselves while the game runs', automatic.length > 0, `${automatic.length}`);
check('and no more of them are kept than asked for', automatic.length <= 2, `${automatic.length}`);
check('while the states somebody made are left alone',
    withAuto.length - automatic.length === beforeAuto);

console.log('\nSuspend and resume');
await page.click('.vp-titlebar-button[data-control="save-states"]');
await settle();
await page.click('.vp-strip-button[data-control="closeRom"]');
await settle(2500);
await openRom();
const resumeTitle = await answerDialog(true).catch(() => '');
check('closing the game and opening it again offers it back',
    /resume/i.test(resumeTitle), resumeTitle);
await settle(2500);
check('and resuming leaves it running', await running());
await openStrip();
check('the suspended game is at the top of the browser',
    /suspended/i.test((await rows())[0]?.meta ?? ''), JSON.stringify((await rows())[0] ?? {}));

check('nothing errored throughout', errors.length === 0, errors.join(' | '));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
