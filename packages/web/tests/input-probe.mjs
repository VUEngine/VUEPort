// checks the input settings: the front and back controller diagram, rows opening the inline capture strip, "set all
// buttons", the Default/WASD/Arrows presets, and Player 2's own keymap behind "same as Player 1"
// Usage: node tests/input-probe.mjs (after `yarn build`)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
    if (!ok) { failures++; }
};

if (!existsSync(path.join(dist, 'index.html'))) {
    console.log('\nskipped: dist is not built\n');
    process.exit(0);
}

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
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 1;
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
await page.setViewport({ width: 1400, height: 820 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

await page.setRequestInterception(true);
page.on('request', request => {
    if (request.url().includes('api.vueport.net/pvb/')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function openInput() {
    await page.evaluate(() =>
        document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
    await wait(400);
    await page.evaluate(() => {
        for (const tab of document.querySelectorAll('.vp-settings-tab')) {
            if (/input/i.test(tab.textContent || '')) { tab.click(); return; }
        }
    });
    await wait(400);
}

const rows = () => page.$$eval('.vp-input-row', list => list.map(row => ({
    name: row.querySelector('.vp-input-row-name')?.textContent ?? '',
    key: row.querySelector('.vp-input-key')?.textContent?.trim() ?? '',
})));

// the section headers, e.g. "GAME PAD". Only the lists' own legends, as the picture's card carries one too
const headers = () => page.$$eval('.vp-input-lists .vp-panel-list-header',
    list => list.map(h => h.textContent.trim()));

// click the nth game-pad row (0 = Left D-Pad ⇧)
const clickRow = index => page.evaluate(i => {
    document.querySelectorAll('.vp-input-row')[i]?.click();
}, index);

const pickSegment = text => page.evaluate(label => {
    for (const el of document.querySelectorAll('.vp-input-top *')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === label) {
            el.click();
            return true;
        }
    }
    return false;
}, text);

const startRun = () => page.evaluate(() => {
    for (const b of document.querySelectorAll('.vp-input-pad-card .vp-preset-row button')) {
        if (/set all/i.test(b.textContent || '')) { b.click(); return; }
    }
});

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(600);
const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await wait(2000);

console.log('\nThe pane is drawn');
await openInput();
check('the controller is drawn front and back', (await page.$$('.vp-input-diagram')).length === 2);
check('with a click target for every button',
    (await page.$$('.vp-input-control:not(.vp-input-power) .vp-input-control-hit')).length === 14);
check('and a caption on every one',
    (await page.$$('.vp-input-control:not(.vp-input-power) .vp-input-control-key')).length === 14);
// Reset is the 8th row of the Emulator column, which follows the 14 pad rows
const RESET_ROW = 14 + 7;
check('the power switch is a target too, showing the Reset key', await page.evaluate(row => {
    const power = document.querySelector('.vp-input-power');
    const resetKey = document.querySelectorAll('.vp-input-row')[row]
        ?.querySelector('.vp-input-key')?.textContent?.trim();
    const powerCaption = power?.querySelector('.vp-input-control-key')?.textContent?.trim();
    return !!power && powerCaption !== undefined && powerCaption === resetKey && resetKey === 'F10';
}, RESET_ROW));
check('the two columns are Game pad and Emulator',
    (await headers()).join(' / ').toLowerCase() === 'game pad / emulator');

const listed = await rows();
check('every game-pad button has a row', listed.filter(r => /D-Pad|Trigger|^A$|^B$|Select|Start/.test(r.name)).length === 14);
check('the list agrees with the picture', await page.evaluate(() => {
    const rowKey = document.querySelector('.vp-input-row .vp-input-key')?.textContent?.trim();
    const captions = [...document.querySelectorAll('.vp-input-control-key')].map(t => t.textContent.trim());
    return rowKey !== undefined && captions.includes(rowKey);
}));

console.log('\nRebinding by clicking a row');
const before = (await rows())[0];
await clickRow(0);
await page.waitForSelector('.vp-input-capture', { timeout: 5000 });
check('a capture strip opens under the picture', await page.$('.vp-input-capture') !== null);
check('the row shows it is waiting', await page.$('.vp-input-row .vp-input-key.is-waiting') !== null);
check('and its control lights on the picture', await page.$('.vp-input-control.is-waiting') !== null);
await page.keyboard.press('KeyZ');
await wait(300);
check('the strip closes', await page.$('.vp-input-capture') === null);
const after = (await rows())[0];
check('the new key replaced the binding, as on the Game Pads page', after.key === 'Z' && after.key !== before.key);
check('and the running emulator re-read it without error', errors.length === 0
    || (console.log('  ' + errors.slice(0, 3).join('\n  ')), false));

console.log('\nSeveral keys on one control');
{
    const pressButton = label => page.evaluate(text => {
        for (const b of document.querySelectorAll('.vp-input-capture button')) {
            if ((b.textContent || '').trim() === text) { b.click(); return true; }
        }
        return false;
    }, label);
    await clickRow(0);
    await page.waitForSelector('.vp-input-capture', { timeout: 5000 });
    check('the strip offers Add another', await pressButton('Add another'));
    await wait(150);
    check('and asks for another key', /another key/i.test(
        await page.$eval('.vp-input-capture-prompt', el => el.textContent)));
    await page.keyboard.press('KeyX');
    await wait(300);
    check('the key it is given joins the first', (await rows())[0].key === 'Z or X');
    await clickRow(0);
    await page.waitForSelector('.vp-input-capture', { timeout: 5000 });
    const chips = () => page.$$eval('.vp-input-capture .vp-input-source-chip', list => list.map(c => c.textContent.trim()));
    check('each key is listed on its own', JSON.stringify(await chips()) === '["Z","X"]');
    await page.evaluate(() => document.querySelector('.vp-input-capture .vp-input-source-chip')?.click());
    await wait(300);
    check('and can be taken off on its own', JSON.stringify(await chips()) === '["X"]');
    await page.keyboard.press('Escape');
    await wait(200);
    check('leaving the other in place', (await rows())[0].key === 'X');
}

console.log('\nRebinding Reset from the power switch');
{
    const resetBefore = (await rows())[RESET_ROW].key;
    const resetName = (await rows())[RESET_ROW].name;
    await page.evaluate(() => document.querySelector('.vp-input-power')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('.vp-input-capture', { timeout: 5000 });
    check('clicking it opens the capture strip for Reset', await page.$eval(
        '.vp-input-capture-title', el => el.textContent.trim()) === resetName);
    check('the power switch lights while it waits',
        await page.$('.vp-input-power.is-waiting') !== null);
    check('and so does the Reset row', await page.evaluate(row =>
        document.querySelectorAll('.vp-input-row')[row]?.classList.contains('is-waiting') ?? false,
        RESET_ROW));
    await page.keyboard.press('Digit0');
    await wait(300);
    check('the strip closes', await page.$('.vp-input-capture') === null);
    const resetAfter = (await rows())[RESET_ROW].key;
    check('Reset picked up the new key', resetAfter === '0' && resetAfter !== resetBefore);
    check('the power switch caption followed', await page.$eval(
        '.vp-input-power .vp-input-control-key', el => el.textContent.trim()) === resetAfter);
}

console.log('\nSetting every button in one run');
{
    const caps = () => page.$$eval(
        '.vp-input-control:not(.vp-input-power) .vp-input-control-key',
        list => list.map(t => t.textContent));
    const start = await caps();

    await startRun();
    await page.waitForSelector('.vp-input-capture', { timeout: 5000 });
    check('the strip counts the steps', /1 of 14/.test(
        await page.$eval('.vp-input-step-count', el => el.textContent)));
    check('and says Escape stops the run', await page.$('.vp-input-capture-note') !== null);
    check('the button it is asking for is lit on the picture',
        (await page.$$('.vp-input-control.is-waiting')).length === 1);
    await page.keyboard.press('Digit8');
    await wait(120);
    await page.keyboard.press('Digit9');
    await wait(120);
    check('it is still counting', /3 of 14/.test(
        await page.$eval('.vp-input-step-count', el => el.textContent)));
    await page.keyboard.press('Escape');
    await wait(300);
    check('Escape closes the run', await page.$('.vp-input-capture') === null);
    check('and nothing was saved', (await caps()).join(' ') === start.join(' '));

    await startRun();
    const keys = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY',
        'KeyU', 'KeyI', 'KeyO', 'KeyP', 'KeyA', 'KeyZ', 'KeyX', 'KeyC'];
    let prompts = 0;
    for (const key of keys) {
        await page.waitForSelector('.vp-input-capture', { timeout: 5000 });
        prompts++;
        await page.keyboard.press(key);
        await wait(110);
    }
    await wait(300);
    check('it prompted once per button', prompts === 14);
    check('the run ends on its own', await page.$('.vp-input-capture') === null);
    check('every control took the key pressed for it',
        (await caps()).join(' ') === 'Q W E R T Y U I O P A Z X C');
    check('and each button answers to exactly one key',
        (await rows()).slice(0, 14).every(r => !r.key.includes('or')));
    check('the emulator keys were left alone', (await rows()).slice(14).some(r => r.key === 'Space'));
}

console.log('\nPresets lay out a whole pad in one press');
const pickPreset = label => page.evaluate(wanted => {
    for (const pill of document.querySelectorAll('.vp-input-pad-card .vp-preset-pill')) {
        if ((pill.textContent || '').trim() === wanted) { pill.click(); return true; }
    }
    return false;
}, label);

check('Default, WASD and Arrows are each their own button below the picture',
    await page.$$eval('.vp-input-pad-card .vp-preset-pill',
        items => items.map(i => i.textContent.trim()).join(',')) === 'Default,WASD,Arrows');

check('WASD is offered', await pickPreset('WASD'));
await wait(200);
{
    const keys = (await rows()).slice(0, 14).map(r => r.key);
    check('the left D-pad takes WASD, the right one the arrows',
        keys.slice(0, 8).join(' ') === 'W S A D Up Down Left Right');
    check('the face buttons and triggers keep the shipped keys',
        keys.slice(8).join(' ') === 'V B N M G H');
    // rewind, fast forward, slow motion, frame advance; then low battery
    const emulatorKeys = (await rows()).slice(14).map(r => r.key);
    check('the time controls move off the arrows to the number row',
        emulatorKeys.slice(1, 5).join(' ') === '3 6 4 5');
    check('and low battery off W to T', emulatorKeys[9] === 'T');
}

check('Arrows is offered', await pickPreset('Arrows'));
await wait(200);
{
    const keys = (await rows()).slice(0, 14).map(r => r.key);
    check('the left D-pad takes the arrows, the right one IJKL',
        keys.slice(0, 8).join(' ') === 'Up Down Left Right I K J L');
    check('select, start, B and A take ASDF, the triggers E and R',
        keys.slice(8).join(' ') === 'A S D F E R');
    // rewind, fast forward, slow motion and frame advance ship on the arrows
    check('and the arrows left the emulator keys they shipped on',
        (await rows()).slice(15, 19).every(r => !/Up|Down|Left|Right/.test(r.key)));
}

check('Default puts the shipped layout back — doubling as restore defaults',
    await pickPreset('Default'));
await wait(200);
const restored = (await rows())[0];
check('every button reads as it did before any preset was tried',
    (await rows()).slice(0, 14).map(r => r.key).join(' ') === 'E D S F I K J L V B N M G H');
check('including the row rebound earlier by hand', restored.key === before.key);
check('and the emulator keys go back to the arrows they ship on',
    (await rows()).slice(15, 19).map(r => r.key).join(' ') === 'Left Right Down Up');

console.log('\nA key bound somewhere new leaves where it was');
{
    const PAUSE_ROW = 14;
    const pauseKey = (await rows())[PAUSE_ROW].key;
    await clickRow(1);
    await page.waitForSelector('.vp-input-capture', { timeout: 5000 });
    await page.keyboard.press('Space');
    await wait(300);
    check('a pad button takes Space', (await rows())[1].key === 'Space');
    check('and Pause no longer answers to it', pauseKey === 'Space' && (await rows())[PAUSE_ROW].key !== 'Space');

    const third = (await rows())[2].key;
    await clickRow(3);
    await page.waitForSelector('.vp-input-capture', { timeout: 5000 });
    await page.keyboard.press(`Key${third}`);
    await wait(300);
    check('one pad button takes another\'s key', (await rows())[3].key === third);
    check('and the other lets go of it', (await rows())[2].key !== third);

    await clickRow(PAUSE_ROW);
    await page.waitForSelector('.vp-input-capture', { timeout: 5000 });
    await page.keyboard.press('Space');
    await wait(300);
    check('Pause takes Space back', (await rows())[PAUSE_ROW].key === 'Space');
    check('from the pad button that had it', (await rows())[1].key !== 'Space');

    await pickPreset('Default');
    await wait(200);
}

console.log('\nPlayer 2 has a keymap of its own');
check('Player 2 is offered', await pickSegment('Player 2'));
await wait(300);
check('and it says it shares Player 1 by default', await page.evaluate(() =>
    /same keys as player 1/i.test(document.querySelector('.vp-input-hint')?.textContent ?? '')));
check('with no pad to configure yet', (await page.$$('.vp-input-diagram')).length === 0);
await page.evaluate(() =>
    document.querySelector('.vp-input-same .vp-switch')?.click());
await wait(300);
check('throwing the switch gives it its own pad', (await page.$$('.vp-input-diagram')).length === 2);
check('with the game pad but not the emulator column',
    (await headers()).join(' / ').toLowerCase() === 'game pad');
const p2 = (await rows())[0];
check('and player 2 answers to different keys', p2.key !== restored.key);
await page.evaluate(() =>
    document.querySelector('.vp-input-same .vp-switch')?.click());

check('nothing errored throughout', errors.length === 0
    || (console.log('  ' + errors.slice(0, 5).join('\n  ')), false));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
