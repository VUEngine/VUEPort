/**
 * A game answers the keyboard without being clicked first. Keys are heard on the emulator's outermost node, and the
 * gestures that start a game lose focus (the start page's button is removed, leaving focus on the body), so without
 * EmulatorInputController.keepFocus every session would begin with a dead key press. Both halves are checked, as a loop
 * taking focus back could take it from the user: a game started from the start page or after closing the settings
 * window hears the keyboard, and a control focused on purpose keeps it. Driven like a user (button, file chooser, real
 * keys), with pause read off the transport strip; nothing is exposed on window for the probe.
 *
 * Usage: node tests/keyboard-focus-probe.mjs (after `yarn build`)
 */
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

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    } else {
        console.log(`  ok   ${label}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

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

// the title bar looks the title up on Planet VB; answered here so the live service isn't reached and no 404 is logged
// that the checks below would read as an error
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

const paused = () => page.evaluate(() => {
    const button = document.querySelector('.vp-strip-button[data-control="pause"]');
    return button?.className.includes('vp-strip-button-on') ?? 'no pause control';
});

const focused = () => page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
        return 'nowhere';
    }
    const screen = document.querySelector('.vp-screen');
    if (screen === active) {
        return 'the emulator';
    }
    return screen?.contains(active)
        ? 'inside the emulator'
        : `${active.tagName.toLowerCase()}.${active.className || '(no class)'}`;
});

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(600);

section('A ROM opened from the start page');
{
    // exactly what the user does: press the button, pick the file, play; no click on the picture, no focus() from the
    // probe
    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await chooser.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await wait(2000);

    check('the game is running', await paused(), false);
    check('the keyboard is with the emulator', await focused(), 'the emulator');

    // Space is Pause out of the box; the strip says whether it landed
    await page.keyboard.press('Space');
    await wait(500);
    check('pressing Space pauses it, with nothing clicked first', await paused(), true);

    await page.keyboard.press('Space');
    await wait(500);
    check('and pressing it again resumes', await paused(), false);
}

section('A button in the chrome, pressed with the mouse');
{
    // a click on the title bar, outside the emulator, used to leave the game deaf until the picture was clicked. Cheats
    // opens a strip inside the emulator, the plain case where nothing else takes the keyboard afterwards
    await page.click('.vp-titlebar-button[data-control="cheats"]');
    await wait(600);
    check('the keyboard goes back to the game', await focused(), 'the emulator');
    await page.keyboard.press('Space');
    await wait(500);
    check('so Space still pauses', await paused(), true);
    await page.keyboard.press('Space');
    await wait(500);
    check('and still resumes', await paused(), false);
    await page.click('.vp-titlebar-button[data-control="cheats"]');
    await wait(400);
}

section('A control focused from the keyboard keeps it');
{
    // the other half: a game snatching focus back from a tabbed-to control would make the interface keyboard-unusable,
    // so only a pointer press hands it over
    await page.evaluate(() =>
        document.querySelector('.vp-titlebar-button[data-control="settings"]')?.focus());
    await wait(500);
    check('the title bar button still has it', await focused(),
        'button.vp-titlebar-button');
    check('and the game is still running', await paused(), false);
}

section('Typing into a field, with the game running behind it');
{
    // a click must never take the keyboard from a text field, as the game takes input the whole time; any settings
    // field will do, what matters is that the characters arrive
    await page.click('.vp-titlebar-button[data-control="settings"]');
    await page.waitForSelector('.vp-window', { timeout: 5000 });
    await wait(600);
    const field = await page.$('.vp-window-body input[type="text"], .vp-window-body input:not([type])');
    if (field === null) {
        console.log('  ..   no text field in the settings window to type into');
    } else {
        await field.click();
        await page.keyboard.type('probe');
        await wait(400);
        check('the field keeps the keyboard', await field.evaluate(el => el.value).then(v => v.includes('probe')), true);
        check('and the game did not read the keystrokes', await paused(), false);
    }
    await page.keyboard.press('Escape');
    await wait(800);
    check('the window closes', await page.$('.vp-window'), null);
}

section('A window that takes typing, and what happens when it closes');
{
    await page.click('.vp-titlebar-button[data-control="settings"]');
    await page.waitForSelector('.vp-window', { timeout: 5000 });
    await wait(600);

    // modal: keys are the window's, not the game's, so Space must not pause
    await page.keyboard.press('Space');
    await wait(500);
    check('Space in the settings window does not reach the game', await paused(), false);

    // closed the way the user closes it; the window's own controls go with it, which used to leave the keyboard dead
    await page.keyboard.press('Escape');
    await wait(800);
    check('the window closes', await page.$('.vp-window'), null);
    check('the keyboard is back with the emulator', await focused(), 'the emulator');

    await page.keyboard.press('Space');
    await wait(500);
    check('and Space pauses the game again', await paused(), true);
    await page.keyboard.press('Space');
    await wait(500);
}

check('nothing errored', errors, []);

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
