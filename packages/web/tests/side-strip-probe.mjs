// checks the Play-mode side strips (save states, cheats, macros, patches, achievements) through the real title
// bar: every button there while playing, one opens exactly one strip, and opening another closes the first.
// Usage: node tests/side-strip-probe.mjs (after `yarn build`)
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
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
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
    // 2 MB, large enough for the shipped Space Pinball patch's second record at 0x128000 at a power-of-two size.
    // The first four bytes give this fixture the CRC32 44c2b723 that PATCH_DATABASE maps to that patch
    const rom = Buffer.alloc(16 * 131072);
    rom.set([0x72, 0x97, 0x7d, 0x27]);
    const header = rom.length - 544;
    rom.write('SIDE STRIP PROBE'.padEnd(20, ' '), header, 'ascii');
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
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

// the title bar looks the ROM's title up on Planet VB like Game Information; answer with a hit, as even a clean
// 404 is logged by Chrome as a console error and would trip the checks below
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

const state = () => page.evaluate(() => ({
    buttons: [...document.querySelectorAll('.vp-titlebar-button')]
        .map(button => button.getAttribute('data-control')),
    active: [...document.querySelectorAll('.vp-titlebar-button.active')]
        .map(button => button.getAttribute('data-control')),
    strips: document.querySelectorAll('.vp-panel-aside').length,
    openLabel: document.querySelector('.vp-panel-aside .vp-panel-close')
        ?.getAttribute('aria-label') ?? null,
}));
const clickControl = control =>
    page.click(`.vp-titlebar-button[data-control="${control}"]`);
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

console.log('\nThe Play-mode strips');
const initial = await state();
check('the title bar offers save states, cheats, macros, patches and achievements',
    ['save-states', 'cheats', 'macros', 'patches', 'achievements']
        .every(control => initial.buttons.includes(control)));
check('and the save states sit left of the cheats',
    initial.buttons.indexOf('save-states') === initial.buttons.indexOf('cheats') - 1);
check('none is open to begin with', initial.active.length === 0 && initial.strips === 0);

await clickControl('achievements');
await settle();
const one = await state();
check('opening achievements shows exactly one strip', one.strips === 1);
check('and it is the achievements strip', /achievement/i.test(one.openLabel ?? ''));
check('only the achievements button is lit', JSON.stringify(one.active) === '["achievements"]');

console.log('\nSigning in from the not-signed-in achievements panel');
// off by default: the "not signed in" state (with Log In) only shows with the feature on. Settings and the strip
// are mutually exclusive, so the achievements strip is reopened after switching the feature on
await page.evaluate(() =>
    document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
await settle();
await page.evaluate(() => {
    for (const tab of document.querySelectorAll('.vp-settings-tab')) {
        if (/achievements/i.test(tab.textContent ?? '')) { tab.click(); return; }
    }
});
await settle();
check('opening Settings closed the strip behind it', (await state()).strips === 0);
await page.evaluate(() => document.querySelector('[role="switch"][aria-checked="false"]')?.click());
await settle();

await clickControl('achievements');
await settle();
check('reopening the strip closed Settings',
    (await page.$('.vp-settings-tabs')) === null && (await state()).strips === 1);

const clickedLogIn = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.vp-panel-aside button')]
        .find(candidate => /log in/i.test(candidate.textContent ?? ''));
    button?.click();
    return button !== undefined;
});
check('a Log In button shows when not signed in', clickedLogIn);
await settle();
const afterLogInClick = await page.evaluate(() => ({
    settingsOpen: !!document.querySelector('.vp-settings-tabs'),
    activeTab: document.querySelector('.vp-settings-tab.active span')?.textContent ?? null,
}));
check('clicking it opens Settings', afterLogInClick.settingsOpen);
check('on the Achievements tab', afterLogInClick.activeTab === 'Achievements');
check('and closed the strip behind it', (await state()).strips === 0);
await page.keyboard.press('Escape');
await settle();

await clickControl('cheats');
await settle();
const swapped = await state();
check('opening cheats closes achievements — still one strip', swapped.strips === 1);
check('now only cheats is lit', JSON.stringify(swapped.active) === '["cheats"]');

await clickControl('macros');
await settle();
const swappedAgain = await state();
check('opening macros closes cheats — still one strip',
    swappedAgain.strips === 1 && JSON.stringify(swappedAgain.active) === '["macros"]');

await clickControl('save-states');
await settle();
const saveStates = await state();
check('opening the save states closes the macros — still one strip',
    saveStates.strips === 1 && JSON.stringify(saveStates.active) === '["save-states"]');
check('and it is the save states strip', /save state/i.test(saveStates.openLabel ?? ''));

await clickControl('patches');
await settle();
const patches = await state();
check('opening patches closes the save states — still one strip',
    patches.strips === 1 && JSON.stringify(patches.active) === '["patches"]');
check('and it is the patches strip', /patch/i.test(patches.openLabel ?? ''));

console.log('\nEnabling the built-in IPS patch');
check('the database patch appears disabled', await page.evaluate(() => {
    const row = document.querySelector('.vp-panel-aside .vp-patches-row');
    const toggle = document.querySelector('.vp-panel-aside .vp-patches-row [role="switch"]');
    return /Score Reset/.test(row?.textContent ?? '')
        && /Ships with VUEPort/.test(row?.textContent ?? '')
        && toggle?.getAttribute('aria-checked') === 'false';
}));
await page.click('.vp-panel-aside .vp-patches-row [role="switch"]');
await new Promise(resolve => setTimeout(resolve, 1500));
check('enabling the database patch survives the emulator restart', await page.evaluate(() =>
    document.querySelector('.vp-panel-aside .vp-patches-row [role="switch"]')
        ?.getAttribute('aria-checked') === 'true'
        && !!document.querySelector('.vp-dock canvas')));

await clickControl('patches');
await settle();
const closed = await state();
check('clicking the open strip again closes it', closed.strips === 0 && closed.active.length === 0);

console.log('\nHardcore mode');
await page.click('.vp-titlebar-button[data-control="settings"]');
await settle();
await page.evaluate(() => {
    for (const tab of document.querySelectorAll('.vp-settings-tab')) {
        if (/achievements/i.test(tab.textContent ?? '')) { tab.click(); return; }
    }
});
await settle();
await page.click('[role="switch"][aria-label="Hardcore mode"]');
await page.waitForSelector('.vp-modal', { timeout: 3000 });
await page.click('.vp-modal-buttons .vp-button:not(.secondary)');
await new Promise(resolve => setTimeout(resolve, 1800));
check('the patches button is dimmed in hardcore mode', await page.evaluate(() =>
    document.querySelector('.vp-titlebar-button[data-control="patches"]')
        ?.classList.contains('dimmed') === true));
await clickControl('patches');
await page.waitForSelector('.vp-modal', { timeout: 3000 });
check('clicking it explains the hardcore restriction without opening the strip', await page.evaluate(() =>
    /patch/i.test(document.querySelector('.vp-modal')?.textContent ?? '')
        && document.querySelectorAll('.vp-panel-aside').length === 0));
// stay in hardcore for the assertion, then turn it off via its settings switch to inspect the built-in patch again
await page.click('.vp-modal-buttons .vp-button.secondary');
await settle();
await page.click('[role="switch"][aria-label="Hardcore mode"]');
await settle();
await page.click('.vp-titlebar-button[data-control="settings"]');
await settle();
await clickControl('patches');
await settle();
check('entering hardcore switched the active patch off', await page.evaluate(() =>
    document.querySelector('.vp-panel-aside .vp-patches-row [role="switch"]')
        ?.getAttribute('aria-checked') === 'false'));

check('nothing errored throughout', errors.length === 0
    || (console.log('  ' + errors.join('\n  ')), false));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
