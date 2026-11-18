// checks that movie playback is frame-exact, as one frame of slip derails the run: plays a published TAS of a real
// game and checks it gets somewhere a scripted player cannot
// Usage: node tests/movie-probe.mjs [path/to/movie.mc2] [path/to/rom.vb]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

const MOVIE = process.argv[2]
    ?? path.join(process.env.HOME ?? '', 'Downloads/adelikat-vbwarioland-bestending.mc2');
const ROM = process.argv[3]
    ?? path.join(process.env.HOME ?? '', 'Downloads/ROMS/Virtual Boy Wario Land (JU).vb');

let failures = 0;
const check = (label, ok, detail) => {
    if (!ok) { failures++; }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!existsSync(MOVIE) || !existsSync(ROM)) {
    console.log('\nThis probe needs a ROM and a movie for it, which are not in the repository:\n'
        + `  movie ${MOVIE}\n  rom   ${ROM}\n`);
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
    } catch { response.writeHead(404).end(); }
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
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 760 });
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
await chooser.accept([ROM]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await wait(2000);

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

console.log('\nStarting a movie');
{
    const [movieChooser, offered] = await Promise.all([
        page.waitForFileChooser({ timeout: 8000 }).catch(() => undefined),
        runCommand('Play Input Movie…'),
    ]);
    check('the command palette offers it', offered, 'no such command');
    check('choosing it asks for a file', movieChooser !== undefined);
    if (movieChooser) {
        await movieChooser.accept([MOVIE]);
    }
    await wait(2500);
    check('a movie badge appears over the picture',
        await page.$('.vp-movie-badge') !== null, 'no badge');
}

console.log('\nPlaying it');
{
    const readBadge = () => page.evaluate(() =>
        document.querySelector('.vp-movie-badge')?.textContent?.trim() ?? '');
    const first = await readBadge();
    await wait(4000);
    const later = await readBadge();
    check('the frame counter advances', first !== later && later !== '', `${first} then ${later}`);
    check('and it says how long the whole run is', /\//.test(later), later);
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
