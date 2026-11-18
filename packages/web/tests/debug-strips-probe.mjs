/**
 * Cheats, macros, patches and achievements are strips beside the screen, opened by the same title bar buttons in both
 * modes and not offered in the Add Panel picker. In Debug mode the dock keeps the width the strip does not take.
 * Profiling's switch is in the CPU Profiler panel.
 *
 * Usage: node tests/debug-strips-probe.mjs (after `yarn build`)
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
const romPath = path.join(scratch, 'strips.vb');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT STRIPS'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VSTR', header + 27, 'ascii');
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

const STRIPS = ['cheats', 'macros', 'patches', 'achievements'];
const button = control => `.vp-titlebar-button[data-control="${control}"]`;

const titleBar = () => page.evaluate(names => Object.fromEntries(names.map(name => {
    const node = document.querySelector(`.vp-titlebar-button[data-control="${name}"]`);
    return [name, node ? {
        dimmed: node.classList.contains('dimmed'),
        ariaDisabled: node.getAttribute('aria-disabled'),
        active: node.classList.contains('active'),
        disabled: node.disabled,
    } : null];
})), [...STRIPS, 'mode', 'profiling']);

// the open dialog's title, or null once none has appeared
async function dialogTitle(timeout = 3000) {
    try {
        await page.waitForSelector('.vp-modal h2', { timeout });
    } catch {
        return null;
    }
    return page.evaluate(() => document.querySelector('.vp-modal h2')?.textContent?.trim() ?? '');
}
const answer = async yes => {
    await page.click(yes
        ? '.vp-modal-buttons .vp-button:not(.secondary)'
        : '.vp-modal-buttons .vp-button.secondary');
    await wait(600);
};
const debugging = async () => (await titleBar()).mode?.active === true;

async function enterDebug() {
    if (!await debugging()) {
        await page.click(button('mode'));
        await page.waitForSelector('.vp-dock .vp-panel', { timeout: 10000 });
        await wait(800);
    }
}

async function openProfiler() {
    await page.click('.lm-TabBar-addButton');
    await page.waitForSelector('.vp-pick-filter', { timeout: 5000 });
    await page.type('.vp-pick-filter', 'CPU Profiler');
    await wait(300);
    await page.keyboard.press('Enter');
    return page.waitForSelector('.vp-profiler', { timeout: 10000 })
        .then(() => true).catch(() => false);
}
const recordingButton = () => page.evaluate(() =>
    document.querySelector('.vp-profiler-recording button')?.textContent?.trim() ?? null);

async function finish() {
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

console.log('\nPlay mode');
{
    const bar = await titleBar();
    check('there is no profiling button in the title bar', bar.profiling === null);
    check('the strip buttons are all there', STRIPS.every(name => bar[name] !== null), JSON.stringify(bar));
    check('and the cheats are not dimmed', bar.cheats?.dimmed === false);
}

console.log('\nDebug mode');
await enterDebug();
{
    const bar = await titleBar();
    check('Debug mode is on', bar.mode?.active === true);
    check('there is still no profiling button', bar.profiling === null);
    check('all five strip buttons are there',
        STRIPS.every(name => bar[name] !== null), JSON.stringify(bar));
    check('and none of them is dimmed any more',
        STRIPS.every(name => bar[name]?.dimmed === false), JSON.stringify(bar));
    check('nor disabled', STRIPS.every(name => bar[name]?.disabled === false));
}

console.log('\nA strip opens where it is asked for');
{
    await page.click(button('macros'));
    await wait(600);
    check('nothing asks about leaving Debug mode', await page.$('.vp-modal') === null);
    check('the macros open beside the dock', await page.$('.vp-panel-aside') !== null);
    check('and are the only strip', (await page.$$('.vp-panel-aside')).length === 1);
    check('the dock is still showing its panels',
        await page.$('.vp-dock .vp-panel') !== null);
    let bar = await titleBar();
    check('Debug mode is untouched', bar.mode?.active === true);
    check('with the macros button lit', bar.macros?.active === true);

    await page.click(button('cheats'));
    await wait(500);
    check('opening the cheats closes the macros — still one strip',
        (await page.$$('.vp-panel-aside')).length === 1);
    bar = await titleBar();
    check('and only the cheats are lit',
        bar.cheats?.active === true && bar.macros?.active === false, JSON.stringify(bar));

    await page.click(button('cheats'));
    await wait(500);
    check('pressing the lit button puts the strip away',
        await page.$('.vp-panel-aside') === null);
    check('and Debug mode survived all of it', await debugging());
}

console.log('\nNone of the five is a panel');
{
    await page.click('.lm-TabBar-addButton');
    await page.waitForSelector('.vp-pick-filter', { timeout: 5000 });
    const offered = await page.evaluate(() =>
        [...document.querySelectorAll('.vp-pick-item')].map(item => item.textContent.trim()));
    check('the picker still offers panels', offered.length > 0);
    for (const name of ['Cheats', 'Macros', 'Patches', 'Colors', 'Achievements']) {
        check(`and never offers ${name}`,
            !offered.some(label => label.startsWith(name)), offered.join(' | '));
    }
    await page.keyboard.press('Escape');
    await wait(400);
    check('the picker closes', await page.$('.vp-pick') === null);
}

console.log('\nProfiling lives in the CPU Profiler panel');
await enterDebug();
{
    const opened = await openProfiler();
    check('the panel opens', opened);
    if (!opened) {
        await finish();
    }
    await wait(600);
    check('it offers to start a recording', await recordingButton() === 'Start Profiling', await recordingButton());

    await page.click('.vp-profiler-recording button');
    const title = await dialogTitle();
    check('starting asks first, as it always has', title === 'Start Profiling?', title);
    await answer(true);
    await wait(800);
    check('and then offers to stop it', await recordingButton() === 'Stop Profiling and Export',
        await recordingButton());
    check('still with no profiling button in the title bar', (await titleBar()).profiling === null);

    await page.click('.vp-profiler-recording button');
    let back = null;
    for (let tries = 0; tries < 40 && back !== 'Start Profiling'; tries += 1) {
        await wait(250);
        back = await recordingButton();
    }
    check('stopping ends the recording', back === 'Start Profiling', back);
}

check('nothing errored throughout', errors.length === 0, errors.join(' | '));
await finish();
