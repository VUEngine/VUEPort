// can saved progress get out of the browser and back in? Cartridge RAM and save states live in OPFS, which has
// no typeable path and goes with a cleared site, so the app has to hand files over and take them back.
// Usage: node tests/save-transfer-probe.mjs (after `yarn build`)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok, detail) => {
    if (!ok) { failures++; }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
};
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
    } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const downloads = await mkdtemp(path.join(tmpdir(), 'vueport-dl-'));
const romPath = path.join(scratch, 'saver.vb');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT SAVER'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VSAV', header + 27, 'ascii');
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
await page.setViewport({ width: 1100, height: 760 });
const client = await page.createCDPSession();
await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloads, eventsEnabled: true,
});
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
await page.setRequestInterception(true);
page.on('request', request => {
    if (request.url().includes('/pvb/')) {
        request.respond({ status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]' });
        return;
    }
    request.continue();
});

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.vp-library-side-foot .vp-button')]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await wait(2500);

async function runCommand(label) {
    await page.keyboard.press('F1');
    await page.waitForSelector('.vp-pick', { timeout: 3000 });
    await wait(200);
    const clicked = await page.evaluate(wanted => {
        for (const item of document.querySelectorAll('.vp-pick-item')) {
            if ((item.querySelector('span')?.textContent ?? '').trim() === wanted) {
                item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                return true;
            }
        }
        return false;
    }, label);
    if (!clicked) { await page.keyboard.press('Escape'); await wait(200); }
    return clicked;
}

console.log('\nStraight after a game starts');
{
    // a cartridge exists as soon as a machine runs, so this hands one over rather than refusing; cartridge RAM
    // comes up random, so there is no "empty" to recognize
    check('the palette offers to export save data', await runCommand('Export Save Data…'));
    await wait(1500);
    const files = await readdir(downloads);
    // named after ROM, player and slot like the file on disk, so a linked pair's two cartridges can be told apart
    // in one downloads folder
    check('a cartridge comes out, named for its player',
        files.some(name => /^saver\.p1\.sram$/.test(name)), files.join(', '));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nA save put in from outside');
{
    const save = Buffer.alloc(16384);
    for (let i = 0; i < save.length; i++) { save[i] = (i * 7 + 3) & 0xff; }
    const savePath = path.join(scratch, 'donor.sram');
    await writeFile(savePath, save);

    const [saveChooser, offered] = await Promise.all([
        page.waitForFileChooser({ timeout: 8000 }).catch(() => undefined),
        runCommand('Import Save Data…'),
    ]);
    check('the palette offers to import save data', offered);
    check('and asks for a file', saveChooser !== undefined);
    if (saveChooser) { await saveChooser.accept([savePath]); }
    await wait(800);
    const confirmed = await page.evaluate(() => {
        const button = document.querySelector('.vp-modal-buttons .vp-button:not(.secondary)');
        button?.click();
        return button !== null;
    });
    check('it confirms before replacing what is saved', confirmed);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await wait(2500);
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nAnd taken back out');
{
    check('exporting is offered again', await runCommand('Export Save Data…'));
    await wait(1500);
    const files = await readdir(downloads);
    const saved = files.find(name => /^saver\.p1(\.\w+)?\.sram$/.test(name));
    check('a .sram lands in the downloads', saved !== undefined, files.join(', '));
    if (saved) {
        const round = await readFile(path.join(downloads, saved));
        // the running machine owns its cartridge, so what comes back is what the game made of it; its size is the
        // part that has to survive
        check('it is a cartridge\'s worth of bytes', round.length === 16384, String(round.length));
        check('and is not empty', round.some(b => b !== 0), true);
    }
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nA save bigger than a standard cartridge');
{
    // a VB ROM cannot declare its save RAM size, so the machine gets all of Game Pak RAM and the file is trimmed
    // to what was used. A file larger than the 16 KiB standard window must load, keep running, and never be
    // written back smaller, as that would throw progress away
    const big = Buffer.alloc(65536);
    for (let i = 0; i < big.length; i++) { big[i] = (i * 11 + 5) & 0xff; }
    const bigPath = path.join(scratch, 'donor-big.sram');
    await writeFile(bigPath, big);

    const [chooser, offered] = await Promise.all([
        page.waitForFileChooser({ timeout: 8000 }).catch(() => undefined),
        runCommand('Import Save Data…'),
    ]);
    check('a larger cartridge is offered too', offered && chooser !== undefined);
    if (chooser) { await chooser.accept([bigPath]); }
    await wait(800);
    await page.evaluate(() => {
        document.querySelector('.vp-modal-buttons .vp-button:not(.secondary)')?.click();
    });
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await wait(2500);
    check('the game runs on with it', errors.length === 0, errors.join(' | '));

    check('exporting is still offered', await runCommand('Export Save Data…'));
    await wait(1500);
    // by size rather than name: the browser may overwrite the earlier download or save beside it under its own name
    const written = await readdir(downloads);
    const sizes = await Promise.all(written
        .filter(name => name.endsWith('.sram'))
        .map(async name => (await readFile(path.join(downloads, name))).length));
    check('and it keeps the size it came in at',
        sizes.includes(65536), `${written.join(', ')} → ${sizes.join(', ')}`);
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nAnd with the cartridge narrowed to a real one');
{
    // narrowing the save window brings back mirroring for real-hardware builds, but a save written while it was wide
    // can be larger, and the part above must survive anyway. Seeded into storage and reloaded, as the case is a
    // game opened with the setting already narrow
    await page.evaluate(() => {
        const stored = JSON.parse(window.localStorage.getItem('vueport.settings') ?? '{}');
        stored.sramWindow = '16k';
        window.localStorage.setItem('vueport.settings', JSON.stringify(stored));
    });
    await page.reload({ waitUntil: 'networkidle0' });
    // a reload may land in the library or back in the game; only the first needs the game opened by hand
    await page.waitForSelector('.vp-library-card, .vp-dock canvas', { timeout: 20000 });
    if (await page.$('.vp-dock canvas') === null) {
        await page.evaluate(() => document.querySelector('.vp-library-card')
            ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
        await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    }
    await wait(3000);
    check('the game starts on a narrowed cartridge', errors.length === 0, errors.join(' | '));

    check('exporting is offered', await runCommand('Export Save Data…'));
    await wait(1500);
    const written = await readdir(downloads);
    const sizes = await Promise.all(written
        .filter(name => name.endsWith('.sram'))
        .map(async name => (await readFile(path.join(downloads, name))).length));
    check('and the save it could no longer reach is still all there',
        sizes.includes(65536), `${written.join(', ')} → ${sizes.join(', ')}`);
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
