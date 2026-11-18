/**
 * Checks the VB Color editor's Export Package / Import Package on Mario Clash from VBC_ROM_DIR; skipped without the
 * ROM. A painted sheet is exported as one .vbcpkg (the shipped package, the paint in its `paint` section, the edit
 * document in `edit`) that compiles to the painted ROM by itself. After Undo, Import Package brings the paint back (into
 * an empty document at once); imported once more over the work, it asks Merge or Replace, and Merge keeps the paint.
 *
 * Usage: VBC_ROM_DIR=~/Downloads/ROMS node tests/color-exchange-probe.mjs [SHOT.png] (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile, copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { answerColorPackage, localColorPackage } from './color-packages-host.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
const shot = process.argv[2];

let failures = 0;
function check(label, ok, detail) {
    if (!ok) {
        failures++;
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const romSource = process.env.VBC_ROM_DIR && path.join(process.env.VBC_ROM_DIR, 'Mario Clash (JU).vb');
if (!existsSync(path.join(dist, 'index.html')) || !romSource || !existsSync(romSource)) {
    console.log('\nskipped: dist is not built, or VBC_ROM_DIR has no "Mario Clash (JU).vb"\n');
    process.exit(0);
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
};
const server = createServer(async (request, response) => {
    const url = request.url === '/' ? '/index.html' : decodeURIComponent(request.url.split('?')[0]);
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
const romPath = path.join(scratch, 'Mario Clash (JU).vb');
await copyFile(romSource, romPath);

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer:\n  yarn add --dev -W puppeteer\n');
    server.close();
    process.exit(1);
}
const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output', '--lang=en-US'],
    env: { ...process.env, LANG: 'en_US.UTF-8' },
});
const page = await browser.newPage();
// the checks read English texts
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
});
await page.setViewport({ width: 1500, height: 950 });

const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
await page.setRequestInterception(true);
page.on('request', async request => {
    if (await answerColorPackage(request)) {
        return;
    }
    if (request.url().includes('/pvb/')) {
        request.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' });
        return;
    }
    request.continue();
});

const button = control => `.vp-titlebar-button[data-control="${control}"]`;
const dockText = () => page.evaluate(() => document.querySelector('.vp-dock')?.textContent ?? '');
async function finish() {
    if (shot) {
        await page.screenshot({ path: shot });
    }
    if (errors.length) {
        console.log('  ' + errors.slice(0, 5).join('\n  '));
    }
    await browser.close();
    server.close();
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}
async function until(test, ms = 15000) {
    for (let t = 0; t < ms; t += 250) {
        if (await test()) {
            return true;
        }
        await wait(250);
    }
    return false;
}

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(600);
const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.vp-library-side-foot .vp-button')]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await wait(3000);

const undo = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await wait(500);
};

const downloads = await mkdtemp(path.join(tmpdir(), 'vueport-downloads-'));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }).catch(() =>
    cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }));

console.log('\nColor mode');
await page.click(button('color'));
await page.waitForSelector('.vp-color-panel', { timeout: 10000 });
await wait(800);
const switchOn = await page.$$eval('.vp-color-panel button', buttons => buttons.findIndex(b => /Switch On/.test(b.textContent ?? '')));
if (switchOn >= 0) {
    await page.$$eval('.vp-color-panel button', (buttons, at) => buttons[at].click(), switchOn);
    await wait(3000);
}
check('the project tree lists the package\'s sheets', await until(async () => (await page.$('[data-folder="Figures"]')) !== null, 20000));
const showTab = async (label) => {
    for (const tab of await page.$$('.lm-TabBar-tab')) {
        if ((await tab.evaluate(t => (t.textContent ?? '').trim())) === label) {
            await tab.click();
        }
    }
    await wait(400);
};
const clickText = async (pattern, scope = '.vp-color-panel button') => {
    for (const handle of await page.$$(scope)) {
        if (pattern.test((await handle.evaluate(node => node.textContent ?? '')).trim())) {
            await handle.click();
            return true;
        }
    }
    return false;
};
const sheetColors = () => page.$$eval('[data-sheet-colors] .vp-color-sheet-swatches button', bs => bs.map(b => b.title));
const reds = ['#000000', '#550000', '#aa0000', '#ff0000'];
const isRed = colors => colors.length > 0 && colors.every(c => reds.includes(c));
const openCrabs = async () => {
    await showTab('Project');
    await page.click('[data-expand-all]');
    await wait(300);
    await page.click('[data-sheet="sprites/crabs"]');
    await wait(1000);
};
const buildText = () => page.evaluate(() => [...document.querySelectorAll('.vp-color-panel')]
    .map(panel => panel.textContent ?? '').find(text => /Apply to the Game/.test(text)) ?? '');

console.log('\nPaint, and export');
await openCrabs();
const colors0 = await sheetColors();
check('the sheet shows the package\'s colors', colors0.length > 3 && !isRed(colors0), colors0.join(' '));
await page.click('[data-reset="red"]');
await wait(800);
check('painted (the whole sheet red)', isRed(await sheetColors()), (await sheetColors()).join(' '));
await showTab('Build');
check('Build offers Export Package and Import Package, no BPS export', /Export Package…/.test(await buildText())
    && /Import Package…/.test(await buildText()) && !/BPS/.test(await buildText()), (await buildText()).slice(0, 300));
await clickText(/^Export Package/);
const fileName = 'Mario Clash.vbcpkg';
check('the package is handed over as a file', await until(async () => (await readdir(downloads)).includes(fileName), 30000),
    (await readdir(downloads)).join(', '));
const exported = path.join(downloads, fileName);
{
    const { brotliDecompressSync } = await import('node:zlib');
    const file = await readFile(exported);
    check('it is brotli-compressed, as VUEPort publishes its packages (not gzip)', !(file[0] === 0x1f && file[1] === 0x8b) && file[0] !== 0x7b,
        file.subarray(0, 4).toString('hex'));
    const pkg = JSON.parse(brotliDecompressSync(file).toString('utf8'));
    const shippedRaw = JSON.parse(brotliDecompressSync(await localColorPackage('color-packages/mario-clash.vbcpkg')).toString('utf8'));
    const layers = Array.isArray(pkg.paint) ? pkg.paint : [pkg.paint];
    check('it holds the paint and the edit document', layers.length === 1 && Object.keys(layers[0].tiles).length > 0 && !!pkg.edit?.base?.sha256,
        JSON.stringify(Object.keys(pkg)));
    const { paint, edit, ...base } = pkg;
    check('the rest is the shipped package as it is', JSON.stringify(base) === JSON.stringify(shippedRaw));
    const pkgs = require('../../core/lib/common/vb-color-package.js');
    const original = new Uint8Array(await readFile(romSource));
    const alone = pkgs.compileColorPackage(pkg, original);
    const withPaint = pkgs.compileColorPackage(shippedRaw, original, layers[0]);
    check('it compiles to the painted ROM by itself', Buffer.compare(Buffer.from(alone.rom), Buffer.from(withPaint.rom)) === 0);
    if (process.env.EXPORT_COPY) {
        await copyFile(exported, process.env.EXPORT_COPY);
    }
}

console.log('\nImport');
await undo();
await openCrabs();
check('Undo takes the paint off', !isRed(await sheetColors()), (await sheetColors()).join(' '));
const importPackage = async () => {
    await showTab('Build');
    const [chooser] = await Promise.all([page.waitForFileChooser(), clickText(/^Import Package/)]);
    await chooser.accept([exported]);
    await wait(2500);
};
await importPackage();
check('into an empty document it goes in at once', !/Merge/.test(await buildText()), (await buildText()).slice(0, 300));
await openCrabs();
check('the sheet shows the imported paint', isRed(await sheetColors()), (await sheetColors()).join(' '));
await importPackage();
check('over work it asks: Merge or Replace', /Merge/.test(await buildText()) && /Replace/.test(await buildText())
    && /holds \d+ painted characters/.test(await buildText()), (await buildText()).slice(0, 400));
if (shot) {
    await page.screenshot({ path: shot.replace(/\.png$/, '-ask.png') });
}
await clickText(/^Merge$/);
await wait(800);
check('the question goes', !/Replace/.test(await buildText()));
await openCrabs();
check('merged, the paint is there', isRed(await sheetColors()), (await sheetColors()).join(' '));
await showTab('Build');
check('nothing errored', errors.length === 0, errors.slice(0, 3).join(' | '));
await finish();
