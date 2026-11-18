/**
 * Checks the cheat finder in the Cheats panel: a scan narrows and reports what is left, a scan that rules out
 * everything can be undone, and ticked results become one cheat. The search logic itself is covered by vueport-core's
 * cheat-scan-probe. The probe ROM leaves work RAM all zeroes, which drives every transition: "is equal to 0" keeps
 * everything, "is not equal to 0" keeps nothing.
 *
 * Usage: node tests/cheat-finder-probe.mjs (after `yarn build`)
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
await page.setViewport({ width: 1400, height: 800 });
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

const press = (selector, pattern) => page.evaluate((sel, source) => {
    const test = new RegExp(source, 'i');
    for (const button of document.querySelectorAll(sel)) {
        if (test.test(button.textContent || '') && !button.disabled) {
            button.click();
            return true;
        }
    }
    return false;
}, selector, pattern);

// undefined when no scan has been made
const countLine = () => page.evaluate(() =>
    document.querySelector('.vp-cheat-finder-count')?.textContent ?? undefined);

const rows = () => page.$$eval('.vp-cheat-finder-table tbody tr', list => list.length)
    .catch(() => 0);

async function typeValue(text) {
    const box = await page.$('.vp-cheat-finder-search input');
    await box.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    if (text) {
        await page.keyboard.type(text);
    }
    await wait(150);
}

// they are `kit/Select` rather than native selects, so click the control, then the row (value in `data-value`)
async function choose(label, value) {
    const opened = await page.evaluate(text => {
        for (const row of document.querySelectorAll('.vp-cheat-finder-search label')) {
            if ((row.querySelector('span')?.textContent || '').trim() === text) {
                row.querySelector('.vp-dropdown-control').click();
                return true;
            }
        }
        return false;
    }, label);
    if (!opened) {
        throw new Error(`no dropdown beside ${label}`);
    }
    await wait(100);
    await page.evaluate(wanted => {
        document.querySelector(`.vp-dropdown-option[data-value="${wanted}"]`)?.click();
    }, value);
    await wait(150);
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
await wait(2500);

console.log('\nThe Cheats panel offers it');
await page.click('.vp-titlebar-button[data-control="cheats"]');
await wait(500);
check('the cheats are open', await page.$('.vp-panel-aside') !== null);
check('and there is a way to go looking for one', await press('.vp-panel-actions button', 'find'));
await wait(400);

console.log('\nThe search opens');
check('the search controls are there', await page.$('.vp-cheat-finder-search') !== null);
check('with a way back to the list', await page.$('.vp-panel-back') !== null);
check('and nothing scanned yet', await countLine() === undefined);

console.log('\nA first scan');
await typeValue('0');
check('First Scan is offered', await press('.vp-panel-actions button', 'first scan'));
await wait(1500);
const first = await countLine();
// work RAM is 64 KB and the default width is 16-bit, so all 32768 aligned halfwords hold zero
check('every aligned halfword in work RAM matched', /32.?768/.test(first ?? ''));
check('but only a page of them is drawn', await rows() === 200);
check('and it says so', /keep narrowing/i.test(first ?? ''));

console.log('\nA scan that rules everything out');
await choose('The value', 'ne');
await typeValue('0');
check('Next Scan is offered now', await press('.vp-panel-actions button', 'next scan'));
await wait(1200);
check('nothing survived', /^0\D/.test((await countLine() ?? '').trim()));
check('and it says the search is empty', await page.evaluate(() =>
    /nothing is left/i.test(document.querySelector('.vp-panel-empty-fill')?.textContent ?? '')));

console.log('\nTaking it back');
check('Undo is offered', await press('.vp-panel-actions button', 'undo'));
await wait(500);
check('the candidates are back', /32.?768/.test(await countLine() ?? ''));

console.log('\nMaking a cheat from the addresses that were ticked');
const picked = await page.$$eval('.vp-cheat-finder-table tbody tr',
    list => list.slice(0, 2).map(row => row.querySelector('.vp-cheat-finder-address').textContent.trim()));
check('the rows name addresses in work RAM', picked.every(address => /^50000/.test(address)));
check('nothing is ticked to begin with', await page.$$eval(
    '.vp-cheat-finder-pick input', boxes => boxes.every(box => !box.checked)));
check('so Add Cheat is not offered yet', await page.evaluate(() =>
    [...document.querySelectorAll('.vp-panel-actions button')]
        .some(button => /add cheat/i.test(button.textContent || '') && button.disabled)));

await page.click('.vp-cheat-finder-table tbody tr:nth-child(1) .vp-cheat-finder-pick input');
await page.click('.vp-cheat-finder-table tbody tr:nth-child(2) .vp-cheat-finder-pick input');
await wait(200);
check('ticking two rows offers it', await press('.vp-panel-actions button', 'add cheat'));
await wait(500);
check('the panel left the search', await page.$('.vp-cheat-finder-search') === null);
check('and opened the new cheat', await page.$('.vp-panel-detail') !== null);
check('which is named after the first address and says how many more', await page.evaluate(addr =>
    (document.querySelector('.vp-panel-detail .vp-detail-hero-name')?.value ?? '').includes(addr), picked[0]));
check('and carries every ticked address as a code', await page.evaluate(addresses => {
    const codes = [...document.querySelectorAll('.vp-cheats-address input')].map(input => input.value);
    return addresses.every(address => codes.includes(address)) && codes.length === addresses.length;
}, picked));

console.log('\nBack in the list');
check('back to the list', await press('.vp-panel-back', '^cheats$'));
await wait(300);
check('the cheat is in it', await page.$$eval('.vp-panel-row', list => list.length) === 1);
check('switched on', await page.$('.vp-panel-row.enabled') !== null);

console.log('\nThe search is remembered');
check('opening it again', await press('.vp-panel-actions button', 'find'));
await wait(400);
check('picks up where it was left', /32.?768/.test(await countLine() ?? ''));
check('Reset starts over', await press('.vp-panel-actions button', 'reset'));
await wait(300);
check('and there is nothing scanned again', await countLine() === undefined);

check('nothing errored throughout', errors.length === 0
    || (console.log('  ' + errors.slice(0, 5).join('\n  ')), false));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
