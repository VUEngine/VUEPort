/**
 * Macros through the real interface: recording hears the keyboard and writes down what was pressed, the file is read
 * back when the ROM is opened again, and playback shows where it can be seen. The pure half is vueport-core's
 * macro-file-probe; this is the wiring through the input controller, an animation frame loop and a clock that stops
 * with the machine. Driven through the toolbar's buttons and real key presses; nothing is exposed on window.
 *
 * Usage: node tests/macro-probe.mjs (after `yarn build`)
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

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
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
    rom[header + 31] = 3;
    await writeFile(romPath, rom);
}

const otherRomPath = path.join(scratch, 'other.vb');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT OTHER'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VOTH', header + 27, 'ascii');
    rom[header + 31] = 1;
    await writeFile(otherRomPath, rom);
}

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer:\n'
        + '  yarn add --dev -W puppeteer\n');
    server.close();
    process.exit(1);
}
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

// the start page's featured homebrew request is answered with nothing, or the strip renders under the pointer as the
// ROM is opened
await page.setRequestInterception(true);
page.on('request', request => {
    if (request.url().includes('api.vueport.net/pvb/')) {
        request.respond({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: '[]',
        });
        return;
    }
    request.continue();
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// a real click rather than a dispatched one, as only a real click moves focus into the emulator, and a recording that
// hears nothing is exactly the bug this probe catches, so the probe must not cause it
async function press(selector, read, pattern) {
    const test = new RegExp(pattern, 'i');
    for (const handle of await page.$$(selector)) {
        if (test.test(await handle.evaluate(read) ?? '')) {
            // a row's own actions are display: none until the pointer is over the row (.vp-panel-row-action), so the
            // pointer goes there first
            const row = await handle.evaluateHandle(
                node => node.closest('.vp-panel-row') ?? node);
            await row.asElement()?.hover();
            await handle.click();
            return true;
        }
    }
    return false;
}

const pressLabeled = pattern =>
    press('button', element => element.getAttribute('aria-label'), pattern);

const backToList = () =>
    press('.vp-panel-back', element => element.getAttribute('title'), 'back to list');

const openMacros = () => pressLabeled('^macros$');

const pressText = (selector, pattern) =>
    press(selector, element => element.textContent, pattern);

const listed = () => page.evaluate(() =>
    [...document.querySelectorAll('.vp-macros-row')].map(row => {
        const sequence = row.querySelector('.vp-macros-sequence');
        return {
            name: (row.querySelector('.vp-panel-row-name')?.firstChild?.textContent ?? '').trim(),
            playing: row.classList.contains('playing'),
            recording: row.classList.contains('recording'),
            global: row.querySelector('.vp-macros-global') !== null,
            sequence: sequence?.textContent,
            fullSequence: sequence?.getAttribute('title'),
            // cut off rather than wrapped, so the card stays the height of its two lines
            cutOff: sequence !== null && sequence.scrollWidth > sequence.clientWidth + 1,
            height: Math.round(row.getBoundingClientRect().height),
            // a flex item refusing to shrink pushes the controls off the end instead of ellipsing; a recording's row
            // has no controls, hence the guard
            controlsInside: row.querySelector('.vp-macros-play') === null
                || row.querySelector('.vp-macros-play').getBoundingClientRect().right
                <= row.getBoundingClientRect().right,
        };
    }));

const steps = () => page.evaluate(() =>
    [...document.querySelectorAll('.vp-macros-step')].map(step => ({
        time: step.querySelector('.time')?.textContent ?? '',
        keys: [...step.querySelectorAll('.vp-macros-button')].map(key => key.textContent),
    })));

async function openRom(which = romPath) {
    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await chooser.accept([which]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await wait(2000);
    // focused directly, as with a single-eye palette the picture reports no clickable point to the driver
    await page.$eval('.vp-screen', el => el.focus());
}

await page.goto(origin, { waitUntil: 'networkidle0' });
// the featured homebrew strip lays itself out a beat after first paint
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(500);
await openRom();

section('Opening the macros');
{
    check('the toolbar offers them', await openMacros(), true);
    check('and they appear beside the screen',
        await page.$('.vp-panel-aside .vp-panel-heading-title') !== null, true);
    check('with nothing recorded yet', await listed(), []);
}

section('Recording a sequence');
{
    check('the panel offers to record', await pressText('.vp-panel-aside button', 'record'), true);
    await wait(100);
    const while_recording = await listed();
    check('a row says so while it runs', while_recording.length, 1);
    check('and it is marked as the recording', while_recording[0].recording, true);

    // "m" is A and "e" the left D-pad's up, in the default mappings
    await page.keyboard.down('m');
    await wait(150);
    await page.keyboard.up('m');
    await wait(200);
    await page.keyboard.down('e');
    // a moment apart, as two presses in the same millisecond are one state
    await wait(120);
    await page.keyboard.down('m');
    await wait(150);
    await page.keyboard.up('m');
    await wait(120);
    await page.keyboard.up('e');
    await wait(150);

    const badge = await page.evaluate(() => {
        const element = document.querySelector('.vp-macro-badge');
        if (!element) { return undefined; }
        return {
            text: element.textContent,
            alerting: element.classList.contains('recording'),
            // red whatever the theme calls it, or the badge means nothing over the picture
            differsFromBody: getComputedStyle(element).color
                !== getComputedStyle(document.body).color,
        };
    });
    check('the picture says it is recording', badge?.text, 'REC');
    check('in the color that means it', badge?.differsFromBody, true);

    // the dot swaps between filled and hollow rather than fading, sampled across more than one half-period so two
    // samples cannot land on the same half by accident
    const dot = () => page.evaluate(() =>
        document.querySelector('.vp-macro-badge svg')?.innerHTML ?? 'no-svg');
    const dotWidth = () => page.evaluate(() => {
        const element = document.querySelector('.vp-macro-badge svg');
        return element ? Math.round(element.getBoundingClientRect().width) : 0;
    });
    const first = await dot();
    const firstWidth = await dotWidth();
    await wait(800);
    const second = await dot();
    check('the record light is drawn at all',
        first !== 'no-svg' && first !== '', true);
    check('and blinks by swapping the dot, not by fading it', first !== second, true);
    check('the dot is still drawn on the other half of the blink',
        second !== 'no-svg' && second !== '', true);
    check('and the badge does not change width as it blinks', await dotWidth(), firstWidth);

    check('stopping it takes', await pressText('.vp-panel-aside button', 'stop'), true);
    await wait(200);
    check('and the badge goes out with it', await page.$('.vp-macro-badge'), null);
}

section('What was recorded')
{
    const recorded = await steps();
    check('the presses and releases are all there', recorded.length, 6);
    check('it starts on the button that was pressed first', recorded[0].keys, ['A']);
    check('and starts at zero', recorded[0].time, '0.0 s');
    check('the release follows', recorded[1].keys, []);
    check('then the direction on its own', recorded[2].keys, ['L↑']);
    check('then both at once, in the order the controller reads',
        recorded[3].keys, ['L↑', 'A']);
    check('then the direction alone again as the button is let go',
        recorded[4].keys, ['L↑']);
    check('and it ends with everything released',
        recorded[recorded.length - 1].keys, []);

    check('it is named for the panel to show',
        await page.$eval('.vp-panel-aside .vp-detail-hero-name',
            input => input.value), 'Macro 1');

    await page.click('.vp-panel-aside .vp-detail-hero-name');
    await page.keyboard.press('End');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.keyboard.type('Jump attack');
    await wait(100);
    // "Jump" has a p, the key that opens the controller reference; the emulator listens on the node every panel sits
    // in, so a field not holding on to its keys would play the game as well
    check('typing a name does not reach the game',
        await page.$('.vp-window'), null);

    check('back to the list', await backToList(), true);
    await wait(100);
    const listedNow = await listed();
    check('and the name is what it is now called',
        listedNow.map(macro => macro.name), ['Jump attack']);

    // the card's second line: what the macro presses, without releases, and the direction held across the second press
    // is not pressed twice
    check('the card shows what it presses', listedNow[0].sequence, 'A·L↑·A');
    check('and the hover carries the whole of it', listedNow[0].fullSequence, 'A · L↑ · A');
    check('a short one is not cut off', listedNow[0].cutOff, false);
    check('and the controls are on the card', listedNow[0].controlsInside, true);
}

section('A macro too long for its card');
{
    check('recording again', await pressText('.vp-panel-aside button', 'record'), true);
    await wait(120);
    for (const key of ['e', 'f', 'd', 's', 'i', 'l', 'k', 'j', 'm', 'n', 'b', 'v']) {
        await page.keyboard.down(key);
        await wait(60);
        await page.keyboard.up(key);
        await wait(60);
    }
    check('and stopping', await pressText('.vp-panel-aside button', 'stop'), true);
    await wait(200);
    check('back to the list', await backToList(), true);
    await wait(150);

    const long = (await listed())[1];
    check('the whole sequence is on the hover',
        long?.fullSequence, 'L↑ · L→ · L↓ · L← · R↑ · R→ · R↓ · R← · A · B · Sta · Sel');
    check('the line itself is cut off', long?.cutOff, true);
    check('the controls are still on the card', long?.controlsInside, true);
    const heights = (await listed()).map(macro => macro.height);
    check('and the card is no taller than the short one', heights[1], heights[0]);

    check('removing it', await pressLabeled('remove macro 2'), true);
    await wait(150);
    // the confirm dialog's OK: the plain .vp-button beside the secondary Cancel (ConfirmDialog in web-ui.tsx)
    check('confirming',
        await pressText('.vp-modal-buttons .vp-button:not(.secondary)', '.'), true);
    await wait(300);
    check('leaves the first', (await listed()).map(macro => macro.name), ['Jump attack']);
}

section('The steps, in the editor');
{
    check('opening the macro', await pressLabeled('edit jump attack'), true);
    await wait(200);
    // a lane per button in the controller reference's order, a bar per stretch held: A tapped twice, the direction held
    // once across the second tap
    const lanes = await page.evaluate(() =>
        [...document.querySelectorAll('.vp-panel-aside .vp-macros-timeline .vp-macros-lane')]
            .filter(lane => !lane.classList.contains('vp-macros-ticks'))
            .map(lane => ({
                button: lane.querySelector('.vp-macros-button')?.textContent,
                bars: lane.querySelectorAll('.vp-macros-bar').length,
            })));
    check('the timeline has a lane per button', lanes.map(lane => lane.button), ['L↑', 'A']);
    check('and a bar per stretch held', lanes.map(lane => lane.bars), [1, 2]);
    check('the steps are listed under it', (await steps()).length, 6);
    check('back to the list', await backToList(), true);
    await wait(150);
}

section('Playing it back');
{
    check('the row offers to play it', await pressLabeled('play jump attack'), true);
    await wait(150);
    check('the row says it is playing', (await listed())[0].playing, true);
    check('and the picture says so too',
        await page.$('.vp-macro-badge') !== null, true);

    // under a second long, so it ends on its own
    await wait(1200);
    check('it stops when it reaches the end', (await listed())[0].playing, false);
    check('and the badge goes with it', await page.$('.vp-macro-badge'), null);
}

section('Surviving the ROM being reopened');
{
    // reloading throws away everything in memory; only the file beside the ROM's saves survives it
    await page.reload({ waitUntil: 'networkidle0' });
    await openRom();
    check('the macros are offered again', await openMacros(), true);
    await wait(300);
    check('and the one recorded before is in the list',
        (await listed()).map(macro => macro.name), ['Jump attack']);

    check('its steps came back too', await pressLabeled('edit jump attack'), true);
    await wait(100);
    const back = await steps();
    check('all of them', back.length, 6);
    check('starting where it started', back[0]?.keys, ['A']);
}

section('Importing a macros file');
{
    await backToList();
    await wait(100);
    const before = (await listed()).map(macro => macro.name);

    const importPath = path.join(scratch, 'shared.vueport-macros.json');
    await writeFile(importPath, JSON.stringify({
        version: 1,
        macros: [
            // A is 0x0004: held from the start, let go near the end, long enough that playback is still going when read
            // back
            { name: 'Imported combo', steps: [{ at: 0, keys: 4 }, { at: 1500, keys: 0 }], duration: 1500 },
        ],
    }));

    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        pressText('.vp-panel-actions button', 'import'),
    ]);
    await chooser.accept([importPath]);
    await wait(300);

    const after = (await listed()).map(macro => macro.name);
    check('the imported macro joined the list', after, [...before, 'Imported combo']);
    check('and it can be played', await pressLabeled('play imported combo'), true);
    await wait(150);
    check('it is playing', (await listed()).find(macro => macro.name === 'Imported combo')?.playing, true);
    await wait(1800);
    check('and it stops on its own', (await listed()).find(macro => macro.name === 'Imported combo')?.playing, false);
}

section('Canceling a recording from the badge');
{
    await backToList();
    // the "imported 1 macro" toast above sits over Record at the foot of the panel and would swallow the click
    await page.waitForFunction(
        () => document.querySelector('.vp-toast') === null, { timeout: 15000 });
    const before = (await listed()).map(macro => macro.name);

    check('recording starts', await pressText('.vp-panel-aside button', 'record'), true);
    await wait(150);
    await page.keyboard.down('m');
    await wait(150);
    await page.keyboard.up('m');
    await wait(150);
    check('and the badge is over the picture',
        await page.$('.vp-macro-badge.recording') !== null, true);

    await page.click('.vp-macro-badge');
    await wait(300);
    check('pressing it ends the recording', await page.$('.vp-macro-badge'), null);
    check('and nothing was kept from it', (await listed()).map(macro => macro.name), before);
}

section('A macro marked as belonging to every game');
{
    // moved into the shared file, then looked for from a different ROM: the flag has to survive the ROM changing, and
    // the list has to say which rows are shared
    await page.waitForFunction(
        () => document.querySelector('.vp-toast') === null, { timeout: 15000 });
    const before = await listed();
    check('nothing is marked global to begin with',
        before.map(macro => macro.global), before.map(() => false));

    check('a macro opens in the editor', await pressLabeled('edit jump attack'), true);
    await wait(200);
    const options = await page.evaluate(() =>
        [...document.querySelectorAll('.vp-detail-option .vp-switch')]
            .map(toggle => toggle.getAttribute('aria-label')));
    check('the editor offers All Games', options.includes('All Games'), true);

    await page.evaluate(() => {
        [...document.querySelectorAll('.vp-detail-option .vp-switch')]
            .find(toggle => /all games/i.test(toggle.getAttribute('aria-label') || ''))
            .click();
    });
    await wait(400);
    check('and stays open on it', await page.$eval('.vp-panel-aside .vp-detail-hero-name',
        input => input.value).catch(() => undefined), 'Jump attack');
    await backToList();
    await wait(150);

    const marked = await listed();
    check('the list marks it as shared',
        marked.find(macro => macro.name === 'Jump attack')?.global, true);
    check('and marks nothing else',
        marked.filter(macro => macro.global).length, 1);

    await page.mouse.move(650, 500);
    await wait(200);
    const [otherChooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-strip-button[data-control="openRom"]'),
    ]);
    await otherChooser.accept([otherRomPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await wait(1500);
    // the strip is a toggle that loading a ROM may have left open or closed, so ask, then act
    if (await page.$('.vp-panel-aside') === null) {
        check('the macros open on the other ROM', await openMacros(), true);
        await wait(400);
    }
    check('the macros are on screen', await page.$('.vp-panel-aside') !== null, true);

    const elsewhere = await listed();
    check('the shared macro came with it',
        elsewhere.map(macro => macro.name), ['Jump attack']);
    check('still marked as shared', elsewhere[0]?.global, true);
    check('and it still plays there', await pressLabeled('play jump attack'), true);
    await wait(200);
    check('it is playing', (await listed())[0]?.playing, true);

    // and it reached the shared file, the only thing that can carry it across a thrown-away page and a different ROM
    await page.reload({ waitUntil: 'networkidle0' });
    await openRom(otherRomPath);
    check('the macros are offered on the other ROM again', await openMacros(), true);
    await wait(400);
    const persisted = await listed();
    check('the shared macro was written to a file of its own',
        persisted.map(macro => macro.name), ['Jump attack']);
    check('and comes back marked as shared', persisted[0]?.global, true);
}

check('nothing errored throughout', errors, []);

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
