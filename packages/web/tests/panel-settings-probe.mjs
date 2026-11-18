// debug panels come back the way they were left across a full page reload, and the VCU panel opens on a machine that is
// not a VB Color
// Usage: node tests/panel-settings-probe.mjs (after `yarn build`)
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
function check(label, ok, detail) {
    if (!ok) {
        failures++;
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
}
const report = (label, value) => console.log(`  --   ${label}: ${value}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
const romPath = path.join(scratch, 'panels.vb');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT PANELS'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPAN', header + 27, 'ascii');
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

async function finish() {
    await browser.close();
    server.close();
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

async function boot() {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.vp-library-side-foot .vp-button', { timeout: 10000 });
    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await chooser.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await wait(1500);
    // the mode is remembered too, so the second boot may already be in Debug, and clicking would leave it
    if (await page.$('.vp-dock .vp-panel') === null) {
        await page.click('[data-control="mode"]');
        await page.waitForSelector('.vp-dock .vp-panel', { timeout: 10000 });
    }
    await wait(800);
}

async function openPanel(name) {
    await page.click('.vp-dock .lm-TabBar-addButton');
    await page.waitForSelector('.vp-pick-filter', { timeout: 5000 });
    await page.type('.vp-pick-filter', name);
    await wait(300);
    const offered = await page.evaluate(() =>
        [...document.querySelectorAll('.vp-pick-item')].map(item => item.textContent.trim()));
    if (offered.length === 0) {
        await page.keyboard.press('Escape');
        return false;
    }
    await page.keyboard.press('Enter');
    await wait(700);
    return true;
}

// every range, checkbox and switch in a panel, by the name beside it. Switches too, as a panel may use the kit's
// switch for a former checkbox (the Characters panel's grid and segment toggles)
const controlsIn = selector => page.evaluate(root => {
    const panel = document.querySelector(root);
    if (!panel) { return undefined; }
    const inputs = [...panel.querySelectorAll('label')].map(label => {
        const input = label.querySelector('input');
        return input === null ? undefined : {
            name: (label.textContent || '').trim(),
            type: input.type,
            value: input.type === 'checkbox' ? input.checked : input.value,
        };
    }).filter(Boolean);
    const switches = [...panel.querySelectorAll('[role="switch"]')].map(control => ({
        name: control.getAttribute('aria-label') ?? '',
        type: 'switch',
        value: control.getAttribute('aria-checked') === 'true',
    }));
    return [...inputs, ...switches];
}, selector);

await boot();

console.log('\nThe VCU panel without a VB Color');
{
    // this ROM asks for no color, so Auto resolves to an original VB with no VCU behind the panel; it still has to open
    const opened = await openPanel('VCU');
    check('the picker offers it and it opens', opened);
    const panel = await page.$('.vp-vcu-panel, .vp-panel');
    check('a panel appeared', panel !== null);
    check('and it says why there is nothing to read', await page.evaluate(() =>
        /original Virtual Boy/.test(document.body.textContent ?? '')));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nThe Characters panel remembers how it was set up');
let charactersBefore;
{
    const opened = await openPanel('Characters');
    check('it opens', opened);
    if (!opened) {
        await finish();
    }

    const before = await controlsIn('.vp-inspector');
    check('its Display controls are there', (before?.length ?? 0) >= 3,
        JSON.stringify(before?.map(control => control.name)));

    // drag each control off its start. Ranges are set through the keyboard so the change events the panel listens for
    // fire
    await page.evaluate(() => {
        const panel = document.querySelector('.vp-inspector');
        const ranges = [...panel.querySelectorAll('input[type="range"]')];
        for (const range of ranges) {
            const next = range.value === range.min ? range.max : range.min;
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value').set;
            setter.call(range, next);
            range.dispatchEvent(new Event('change', { bubbles: true }));
            range.dispatchEvent(new Event('input', { bubbles: true }));
        }
        panel.querySelector('[role="switch"], input[type="checkbox"]')?.click();
    });
    await wait(800);

    charactersBefore = await controlsIn('.vp-inspector');
    report('left set to', JSON.stringify(charactersBefore));
    check('the controls moved',
        JSON.stringify(charactersBefore) !== JSON.stringify(before));
}

console.log('\nThe Terminal and Disassembly panels too');
let terminalBefore;
let disassemblyBefore;
{
    await openPanel('Terminal');
    await page.evaluate(() => {
        for (const box of document.querySelectorAll('.vp-terminal input[type="checkbox"]')) {
            box.click();
        }
    });
    await wait(600);
    terminalBefore = await controlsIn('.vp-terminal');
    report('terminal left set to', JSON.stringify(terminalBefore));
    check('both of its toggles moved',
        terminalBefore?.length === 2 && terminalBefore[0].value === false
        && terminalBefore[1].value === true,
        JSON.stringify(terminalBefore));

    await openPanel('Disassembly');
    await page.evaluate(() => {
        document.querySelector('.vp-disassembly input[type="checkbox"]').click();
    });
    await wait(600);
    disassemblyBefore = await controlsIn('.vp-disassembly');
    report('disassembly left set to', JSON.stringify(disassemblyBefore));
    check('Follow PC is off', disassemblyBefore?.[0]?.value === false,
        JSON.stringify(disassemblyBefore));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nAfter a reload');
{
    // a full reload, as the values have to reach storage, not merely survive in a live object
    await boot();
    await openPanel('Characters');
    const characters = await controlsIn('.vp-inspector');
    report('characters', JSON.stringify(characters));
    check('the Characters panel comes back as it was left',
        JSON.stringify(characters) === JSON.stringify(charactersBefore),
        `${JSON.stringify(characters)} vs ${JSON.stringify(charactersBefore)}`);

    await openPanel('Terminal');
    const terminal = await controlsIn('.vp-terminal');
    check('and the Terminal panel',
        JSON.stringify(terminal) === JSON.stringify(terminalBefore),
        `${JSON.stringify(terminal)} vs ${JSON.stringify(terminalBefore)}`);

    await openPanel('Disassembly');
    const disassembly = await controlsIn('.vp-disassembly');
    check('and the Disassembly panel',
        JSON.stringify(disassembly) === JSON.stringify(disassemblyBefore),
        `${JSON.stringify(disassembly)} vs ${JSON.stringify(disassemblyBefore)}`);
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

await finish();
