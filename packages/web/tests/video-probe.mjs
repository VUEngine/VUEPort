/**
 * Checks a video recording through the real interface: the strip's button starts one, the picture says so while it
 * runs, and stopping hands over a real video of the size the settings asked for, with a sound track. A browser probe,
 * as AudioContext mixing, canvas capture, MediaRecorder and the worker's mirrored frames exist only in a page. ESSound
 * (needs a ROM with audio files) is not checked; its tap joins the same mix.
 *
 * Usage: node tests/video-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile, readdir, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
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
const downloads = await mkdtemp(path.join(tmpdir(), 'vueport-downloads-'));
const romPath = path.join(scratch, 'probe.vb');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 3;
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

// --enable-unsafe-swiftshader as in every probe (no GPU, WebGL picture); the recording composes in a second
// WebGL context, so this leans on the software renderer harder than the rest
const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

// the saved file leaves the page as a download (what export does in a browser); point it somewhere readable
const client = await page.createCDPSession();
await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

await page.setRequestInterception(true);
page.on('request', request => {
    if (request.url().includes('api.vueport.net/pvb/')) {
        request.respond({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: '[]',
        });
        return;
    }
    request.continue();
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// the floating strip is only up while the pointer moves
async function wakeStrip() {
    await page.mouse.move(640, 500);
    await page.mouse.move(640, 480);
    await wait(300);
}

const videoButton = () => page.evaluate(() => {
    const button = document.querySelector('.vp-strip-button[data-control="video"]');
    return button ? {
        label: button.getAttribute('aria-label'),
        on: button.classList.contains('vp-strip-button-on'),
    } : undefined;
});

const badge = () => page.evaluate(() => {
    const element = document.querySelector('.vp-video-badge');
    return element ? {
        text: element.textContent,
        // its own color, or it means nothing over a mostly red picture
        differsFromBody: getComputedStyle(element).color
            !== getComputedStyle(document.body).color,
    } : undefined;
});

async function openRom() {
    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await chooser.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await wait(2000);
    await page.$eval('.vp-screen', el => el.focus());
}

async function recordedFile(extension = '') {
    for (let attempt = 0; attempt < 60; attempt++) {
        const names = (await readdir(downloads))
            .filter(name => name.endsWith(extension))
            .filter(name => name.endsWith('.webm') || name.endsWith('.mp4'))
            .sort();
        if (names.length > 0) {
            // the last by name is the newest: the stem carries the save time, down to the second
            const file = path.join(downloads, names[names.length - 1]);
            // Chrome writes the file as it goes; wait for the size to settle rather than read a half-written container
            const first = (await stat(file)).size;
            await wait(250);
            if (first > 0 && (await stat(file)).size === first) {
                return { name: names[names.length - 1], bytes: await readFile(file) };
            }
        }
        await wait(250);
    }
    return undefined;
}

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(500);
await openRom();

section('The control');
{
    await wakeStrip();
    const button = await videoButton();
    check('the strip offers a recording button', button !== undefined, true);
    check('which names its key', /\(/.test(button?.label ?? ''), true);
    check('and is not lit before anything is recorded', button?.on, false);
    check('nothing says a recording is running yet', await badge(), undefined);
}

section('While it runs');
{
    await wakeStrip();
    await page.click('.vp-strip-button[data-control="video"]');
    await wait(1200);

    check('the button lights up', (await videoButton())?.on, true);
    const first = await badge();
    check('the picture says a recording is running', first !== undefined, true);
    check('in the color that means it', first?.differsFromBody, true);
    check('and it shows a clock', /^\d+:\d\d$/.test(first?.text ?? ''), true);

    await wait(2600);
    const later = await badge();
    check('which counts up as it records', later?.text !== first?.text, true);
}

section('The file it leaves behind');
{
    await wakeStrip();
    await page.click('.vp-strip-button[data-control="video"]');

    const file = await recordedFile();
    check('a video is saved', file !== undefined, true);
    check('named after the ROM', /^probe-\d{6}-\d{6}\.(webm|mp4)$/.test(file?.name ?? ''), true);
    // a low bar: the ROM never boots, so this records a black screen and silence, which both codecs compress best.
    // An empty container is smaller still, which is the failure watched for; the frames are decoded below
    check('with something in it', (file?.bytes.length ?? 0) > 2000, true);

    // the codec ids are ASCII near the front of either container, so the tracks can be told apart without parsing
    const front = file?.bytes.subarray(0, 8192).toString('latin1') ?? '';
    if (file?.name.endsWith('.mp4')) {
        // ftyp at byte four is what makes an MP4 an MP4
        check('an MP4 file, by its own header',
            file.bytes.subarray(4, 8).toString('latin1'), 'ftyp');
        // H.264 and AAC, the pair that plays everywhere. Before the mix was resampled this came out as AV1 and Opus:
        // AAC only supports fixed sample rates, not the machine's 41700 Hz, so Chrome failed the container on the first
        // frame and the recording fell through to the next candidate
        check('carrying an H.264 track and not the AV1 fallback',
            [front.includes('avc1'), front.includes('av01')], [true, false]);
        // a recorder handed two audio tracks silently drops one, so this says the mixing happened, and that AAC took a
        // mix it would have refused at the machine's own rate
        check('and an AAC track beside it', front.includes('mp4a'), true);
    } else {
        check('a WebM file, by its own header',
            [...file.bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
        check('carrying a video track', /V_VP9|V_VP8/.test(front), true);
        check('and exactly one audio track',
            (front.match(/A_OPUS/g) ?? []).length, 1);
    }

    check('the button unlatches', (await videoButton())?.on, false);
    check('and the picture stops saying it is recording', await badge(), undefined);
}

section('What was recorded');
{
    const file = await recordedFile();
    const played = file ? await page.evaluate(async (bytes, type) => {
        const blob = new Blob([new Uint8Array(bytes)], { type });
        const element = document.createElement('video');
        element.src = URL.createObjectURL(blob);
        element.muted = true;
        await new Promise((resolve, reject) => {
            element.onloadedmetadata = resolve;
            element.onerror = () => reject(new Error('the file would not load'));
            setTimeout(() => reject(new Error('the file never loaded')), 10000);
        });
        return { width: element.videoWidth, height: element.videoHeight };
    }, [...file.bytes], file.name.endsWith('.mp4') ? 'video/mp4' : 'video/webm')
        .catch(error => String(error)) : undefined;

    // Left Eye at the default scale of two, 384x224 doubled: the recording composes its frames at the size the
    // settings asked for, not the panel's
    check('the picture is the mode and scale that were set', played, { width: 768, height: 448 });
}

// the Firefox situation, which cannot be reproduced otherwise: no MP4 encoder, so the automatic choice falls
// through to the other candidates (as Safari does the other way round)
section('A browser that cannot encode MP4');
{
    await page.evaluateOnNewDocument(() => {
        const real = MediaRecorder.isTypeSupported.bind(MediaRecorder);
        MediaRecorder.isTypeSupported = type => /mp4/i.test(type) ? false : real(type);
    });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.vp-library-side-foot .vp-button');
    await wait(500);
    await openRom();

    await wakeStrip();
    await page.click('.vp-strip-button[data-control="video"]');
    await wait(3000);
    check('it still records', (await badge()) !== undefined, true);
    await wakeStrip();
    await page.click('.vp-strip-button[data-control="video"]');

    const file = await recordedFile('.webm');
    check('and saves a WebM instead', file !== undefined, true);
    check('with something in it', (file?.bytes.length ?? 0) > 2000, true);
    check('a WebM by its own header',
        [...(file?.bytes.subarray(0, 4) ?? [])], [0x1a, 0x45, 0xdf, 0xa3]);
    const front = file?.bytes.subarray(0, 8192).toString('latin1') ?? '';
    check('carrying a video track', /V_VP9|V_VP8/.test(front), true);
    check('and exactly one audio track', (front.match(/A_OPUS/g) ?? []).length, 1);

    const played = file ? await page.evaluate(async bytes => {
        const element = document.createElement('video');
        element.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
        await new Promise((resolve, reject) => {
            element.onloadedmetadata = resolve;
            element.onerror = () => reject(new Error('the file would not load'));
            setTimeout(() => reject(new Error('the file never loaded')), 10000);
        });
        return { width: element.videoWidth, height: element.videoHeight };
    }, [...file.bytes]).catch(error => String(error)) : undefined;
    check('that plays, at the size that was set', played, { width: 768, height: 448 });
}

section('Its settings have a home');
{
    await page.evaluate(() => {
        [...document.querySelectorAll('button')]
            .find(button => /^settings$/i.test(button.getAttribute('aria-label') ?? ''))
            ?.click();
    });
    await wait(600);
    const named = await page.evaluate(() =>
        [...document.querySelectorAll('.vp-settings-tab, .vp-window-rail button')]
            .map(tab => (tab.textContent ?? '').trim()));
    check('the rail carries a Video pane', named.includes('Video'), true);
}

check('nothing errored', errors, []);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
