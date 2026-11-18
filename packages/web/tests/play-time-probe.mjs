/**
 * Checks play time: starting a ROM counts as a play, run time is written against its checksum, and a paused machine
 * adds nothing. Reads `library/play.json` directly, as a ROM opened from a file belongs to no folder; what the shelf
 * makes of it is covered by library-probe.mjs.
 *
 * Usage: node tests/play-time-probe.mjs (after `yarn build`)
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
    rom.write('PLAY TIME PROBE'.padEnd(20, ' '), header, 'ascii');
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

// nothing here should reach the live catalog; a 404 is a clean miss in the page but a console error in Chrome
await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('virtual-boy.com') || url.includes('api.vueport.net')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');

const played = () => page.evaluate(async () => {
    try {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('library');
        const handle = await directory.getFileHandle('play.json');
        return JSON.parse(await (await handle.getFile()).text());
    } catch {
        return undefined;
    }
});

const openRom = async () => {
    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await chooser.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
};

// the strip hides itself when the pointer is still; nudge it to keep it up
const closeRom = async () => {
    await page.mouse.move(640, 480);
    await page.mouse.move(650, 500);
    await new Promise(resolve => setTimeout(resolve, 150));
    await page.click('.vp-strip-button[data-control="closeRom"]');
    await page.waitForSelector('.vp-library');
    // the write is banked on the way down and lands a moment later
    await new Promise(resolve => setTimeout(resolve, 400));
};

console.log('\nA ROM that was played');
check('nothing is written before anything has been played', await played() === undefined);
await openRom();
await new Promise(resolve => setTimeout(resolve, 3000));
await closeRom();
const first = await played();
const id = first && Object.keys(first)[0];
check('the session is filed under the ROM\'s own checksum',
    typeof id === 'string' && /^[0-9a-f]{8}$/.test(id));
check('starting it once counts as one play', first?.[id]?.count === 1);
check('and the time it ran is roughly the time it ran',
    first?.[id]?.ms >= 2000 && first?.[id]?.ms <= 8000);

console.log('\nThe same ROM again');
await openRom();
await new Promise(resolve => setTimeout(resolve, 1000));
// paused for longer than it ran, which tells a play clock from a wall clock
await page.keyboard.press('Space');
await new Promise(resolve => setTimeout(resolve, 3000));
await closeRom();
const second = await played();
check('a second sitting is a second play, not a second entry',
    Object.keys(second).length === 1 && second[id].count === 2);
check('the hours add up rather than starting again',
    second[id].ms > first[id].ms);
check('and the pause is not counted — a game left paused is not being played',
    second[id].ms - first[id].ms < 2800);
check('when it was last played is kept with it',
    second[id].lastPlayedAt > 0 && second[id].firstPlayedAt <= second[id].lastPlayedAt);

console.log('\nAfter a restart');
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library');
const kept = await played();
check('the count and the hours are still there',
    kept[id].count === 2 && kept[id].ms === second[id].ms);

check('nothing errored throughout', errors.length === 0
    || (console.log('  ' + errors.join('\n  ')), false));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
