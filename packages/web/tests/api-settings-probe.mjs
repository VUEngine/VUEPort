// checks the two catalog addresses in the Library pane: settable, remembered and actually used. The homebrew base is
// driven end to end through its shelf; the game info base shares the mechanism, so only storing is checked
// usage: node tests/api-settings-probe.mjs (after `yarn build`)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
    '.png': 'image/png',
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

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer.\n');
    server.close();
    process.exit(1);
}

const DEFAULT_BASE = 'https://api.vueport.net/pvb/';
const MIRROR_HOST = 'https://mirror.example';
const MIRROR_TYPED = `${MIRROR_HOST}/pvb`; // without its trailing slash on purpose, the field adds one
const MIRROR_BARE = 'mirror.example/pvb'; // without a scheme, the field assumes https

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));

const asked = { default: 0, mirror: 0 }; // every catalog call is answered here, counted by host
await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('/pvb/')) {
        if (url.startsWith(MIRROR_HOST)) {
            asked.mirror++;
        } else if (url.startsWith('https://api.vueport.net')) {
            asked.default++;
        }
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function openApis() {
    if (await page.$('.vp-window') === null) {
        await page.evaluate(() =>
            document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
        await wait(500);
    }
    await page.evaluate(() => {
        for (const tab of document.querySelectorAll('.vp-settings-tab')) {
            if ((tab.textContent || '').trim() === 'Library') { tab.click(); return; }
        }
    });
    await wait(600);
}

async function closeWindow() {
    await page.evaluate(() => document.querySelector('.vp-window-close')?.click());
    await wait(400);
}

// the shelf asks the homebrew base only when opened
async function openCatalog() {
    await page.evaluate(() => {
        for (const item of document.querySelectorAll('.vp-library-nav')) {
            if ((item.textContent || '').includes('Homebrew Archive')) { item.click(); return; }
        }
    });
    await wait(800);
}

// in the pane's order
const fields = () => page.$$eval('.vp-window-body input.vp-input[type="url"]', boxes =>
    boxes.map(box => box.value));

const placeholders = () => page.$$eval('.vp-window-body input.vp-input[type="url"]', boxes =>
    boxes.map(box => box.placeholder));

const stored = key => page.evaluate(k => window.localStorage.getItem(k), key);

async function typeInto(index, text) {
    const boxes = await page.$$('.vp-window-body input.vp-input[type="url"]');
    // selected through the DOM, as a type='url' box takes no click-drag selection and Backspace would eat one character
    // instead
    await boxes[index].evaluate(box => {
        box.focus();
        box.setSelectionRange(0, box.value.length);
    });
    await page.keyboard.press('Backspace');
    if (text) {
        await page.keyboard.type(text);
    }
    await page.keyboard.press('Enter');
    await wait(300);
}

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(800);

console.log('\nThe catalog addresses');
await openCatalog();
check('Planet VB\'s shelf asked the default catalog', asked.default > 0 && asked.mirror === 0);
await closeWindow();
await openApis();
check('they are in the Library pane, which has no APIs tab beside it',
    await page.$$eval('.vp-settings-tab', tabs =>
        tabs.some(tab => tab.textContent.trim() === 'Library')
        && !tabs.some(tab => tab.textContent.trim() === 'APIs')));
{
    const shown = await fields();
    check('it offers two addresses', shown.length === 2);
    check('both start empty rather than spelling out the default',
        shown[0] === '' && shown[1] === '');
    const offered = await placeholders();
    check('with the default named as the placeholder',
        offered[0] === DEFAULT_BASE && offered[1] === DEFAULT_BASE);
}
check('nothing is stored until something is changed',
    await stored('vueport.homebrewApiBase') === null
    && await stored('vueport.gameInfoApiBase') === null);

console.log('\nPointing homebrew somewhere else');
await typeInto(0, MIRROR_TYPED);
check('the address is remembered, with the trailing slash it needs',
    await stored('vueport.homebrewApiBase') === `${MIRROR_TYPED}/`);
check('game info was left where it was', await stored('vueport.gameInfoApiBase') === null);

asked.default = 0;
asked.mirror = 0;
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await openCatalog();
check('the shelf now asks the mirror', asked.mirror > 0);
check('and no longer asks the default', asked.default === 0);
await closeWindow();

console.log('\nPutting it back');
await openApis();
check('the field shows what is in force', (await fields())[0] === `${MIRROR_TYPED}/`);
await page.evaluate(() => {
    const field = document.querySelector('.vp-window-body input.vp-input[type="url"]')
        ?.closest('label');
    field?.querySelector('button')?.click();
});
await wait(300);
check('reset empties the field again', (await fields())[0] === '');
check('and stops remembering anything', await stored('vueport.homebrewApiBase') === null);

console.log('\nA half-typed address is completed, not rejected');
await typeInto(0, MIRROR_BARE);
check('the missing scheme and slash are both filled in',
    await stored('vueport.homebrewApiBase') === `${MIRROR_HOST}/pvb/`);
check('and the box shows what it settled on', (await fields())[0] === `${MIRROR_HOST}/pvb/`);
await typeInto(0, '');
check('emptying it forgets the address', await stored('vueport.homebrewApiBase') === null);

console.log('\nGame info keeps its own address');
await typeInto(1, 'https://elsewhere.example/rom/');
check('it is stored on its own key',
    await stored('vueport.gameInfoApiBase') === 'https://elsewhere.example/rom/');
check('homebrew stayed on the default', await stored('vueport.homebrewApiBase') === null);
await typeInto(1, '');
check('emptying it puts the default back', (await fields())[1] === '');
check('with nothing left stored', await stored('vueport.gameInfoApiBase') === null);

check('nothing errored throughout', errors.length === 0);
if (errors.length > 0) {
    console.log(errors.join('\n'));
}

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
