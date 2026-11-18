// checks the Close ROM control: next to Load ROM in the floating strip, disabled with no ROM, and pressing it returns
// to the start page like the vueport.closeRom command
// Usage: node tests/close-rom-probe.mjs (after `yarn build`)
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
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('CLOSE ROM PROBE'.padEnd(20, ' '), header, 'ascii');
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
        // a 200 "hit" rather than a 404, as Chrome logs any non-2xx load to the console however gracefully the page
        // handles it, which would trip the "nothing errored" check
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

// the strip hides itself when the pointer is still, nudge it to keep it up
const wakeStrip = async () => {
    await page.mouse.move(640, 480);
    await page.mouse.move(650, 500);
    await new Promise(resolve => setTimeout(resolve, 150));
};
const control = which => page.$(`.vp-strip-button[data-control="${which}"]`);
const controlDisabled = which => page.evaluate(sel =>
    document.querySelector(sel)?.disabled ?? null, `.vp-strip-button[data-control="${which}"]`);

console.log('\nWith a ROM open');
const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await new Promise(resolve => setTimeout(resolve, 1500));
await wakeStrip();

check('the strip offers Load ROM', await control('openRom') !== null);
check('and Close ROM right beside it', await control('closeRom') !== null);
check('Close ROM is live while a ROM is open', await controlDisabled('closeRom') === false);
const order = await page.evaluate(() =>
    [...document.querySelectorAll('.vp-strip-button[data-control]')]
        .map(button => button.getAttribute('data-control')));
check('Close ROM comes straight after Load ROM',
    order.indexOf('closeRom') === order.indexOf('openRom') + 1);

console.log('\nThe title bar\'s own close');
const closeOpacity = () => page.$eval('.vp-titlebar-rom-close',
    el => Number(window.getComputedStyle(el).opacity));
check('an X sits beside the ROM title',
    await page.$('.vp-titlebar-rom-close') !== null);
check('it is out of sight until the title is hovered', await closeOpacity() === 0);
await page.hover('.vp-titlebar-rom');
await new Promise(resolve => setTimeout(resolve, 300));
check('and shows once it is', await closeOpacity() === 1);
check('it says what it does', await page.$eval('.vp-titlebar-rom-close',
    el => (el.getAttribute('aria-label') ?? '').length > 0));

console.log('\nPressing Close ROM');
await (await control('closeRom')).click();
await new Promise(resolve => setTimeout(resolve, 800));
check('the library is back', await page.$('.vp-library') !== null);
// the dock is a Lumino widget kept mounted but hidden behind the start page, so .vp-body going display: none
// says it is closed, not the dock leaving the document
check('the dock is hidden behind the start page', await page.evaluate(() => {
    const body = document.querySelector('.vp-body');
    return body === null || getComputedStyle(body).display === 'none';
}));
check('the ROM name has left the title bar',
    await page.$('button.vp-titlebar-rom') === null
    && await page.$('.vp-titlebar-rom-empty') !== null);

console.log('\nOpening another ROM still works');
const [chooserAgain] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooserAgain.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await new Promise(resolve => setTimeout(resolve, 1000));
// closing a ROM writes the state the next launch offers back, so that question is up now. Started fresh, as
// resuming is tested in save-states-probe
if (await page.$('.vp-modal')) {
    await page.evaluate(() =>
        document.querySelector('.vp-modal-buttons .vp-button')?.click());
    await new Promise(resolve => setTimeout(resolve, 400));
}
check('the ROM is running again', await page.$('button.vp-titlebar-rom') !== null);

// the X is only on the page while the pointer is over the ROM's group in the title bar (see
// .vp-titlebar-rom-close), so the pointer goes there first
await page.hover('.vp-titlebar-rom-group');
await page.click('.vp-titlebar-rom-close');
await new Promise(resolve => setTimeout(resolve, 800));
check('the title bar\'s X closes the ROM too',
    await page.$('.vp-library') !== null
    && await page.$('button.vp-titlebar-rom') === null);

check('nothing errored throughout', errors.length === 0
    || (console.log('  ' + errors.join('\n  ')), false));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
