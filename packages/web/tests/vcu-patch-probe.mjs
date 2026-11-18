// the VCU panel follows a patch that makes the machine a VB Color: the patch sets only the header's VB Color byte, Auto
// boots it as a VB Color after restart, and switching it off brings "no VCU" back
// Usage: node tests/vcu-patch-probe.mjs (after `yarn build`)
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
function check(label, ok, detail) {
    if (!ok) {
        failures++;
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
const romPath = path.join(scratch, 'vcu.vb');
const patchPath = path.join(scratch, 'colorize.ips');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT VCU'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VVCU', header + 27, 'ascii');
    rom[header + 31] = 1;
    await writeFile(romPath, rom);
    // what a colorization does to the header, and all this one does: VB Color support byte at header + 0x14 set
    // to Enhanced
    const at = header + 0x14;
    await writeFile(patchPath, Buffer.concat([
        Buffer.from('PATCH', 'ascii'),
        Buffer.from([at >> 16 & 0xff, at >> 8 & 0xff, at & 0xff, 0x00, 0x01, 0x80]),
        Buffer.from('EOF', 'ascii'),
    ]));
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
await page.setViewport({ width: 1400, height: 900 });

const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
await page.setRequestInterception(true);
page.on('request', request => {
    if (request.url().includes('/pvb/')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

const button = control => `.vp-titlebar-button[data-control="${control}"]`;
const vcuText = () => page.evaluate(() => document.querySelector('.vp-dock')?.textContent ?? '');
const noVcu = async () => /No VCU present/.test(await vcuText());

async function finish() {
    if (errors.length) {
        console.log('  ' + errors.join('\n  '));
    }
    await browser.close();
    server.close();
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

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

console.log('\nAn original Virtual Boy');
await page.click(button('mode'));
await page.waitForSelector('.vp-dock .vp-panel', { timeout: 10000 });
await wait(800);
await page.click('.lm-TabBar-addButton');
await page.waitForSelector('.vp-pick-filter', { timeout: 5000 });
await page.type('.vp-pick-filter', 'VCU');
await wait(300);
await page.keyboard.press('Enter');
await wait(1500);
check('the VCU panel says there is no VCU', await noVcu(), (await vcuText()).slice(0, 300));
check('nothing errored so far', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log('\nThe colorization switched on');
await page.click(button('patches'));
await page.waitForSelector('.vp-panel-aside', { timeout: 5000 });
await wait(400);
const [patchChooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-panel-aside .vp-panel-actions .vp-button.secondary'),
]);
await patchChooser.accept([patchPath]);
await wait(800);
await page.click('.vp-panel-aside .vp-panel-back').catch(() => undefined);
await wait(400);
const toggle = async () => {
    await page.click('.vp-panel-aside .vp-patches-row .vp-switch');
    await page.waitForSelector('.vp-modal-buttons', { timeout: 3000 });
    await page.click('.vp-modal-buttons .vp-button:not(.secondary)');
    await wait(3000);
};
await toggle();
check('the patch is on', await page.evaluate(() =>
    document.querySelector('.vp-panel-aside .vp-patches-row .vp-switch')?.getAttribute('aria-checked') === 'true'));
check('the VCU panel now shows the VCU', !(await noVcu())
    && await page.evaluate(() => document.querySelector('.vp-vcu-panel') !== null));

console.log('\nAnd off again');
await toggle();
check('the VCU panel says there is none again', await noVcu());

check('nothing errored', errors.length === 0, [...new Set(errors)].join(' | '));
await finish();
