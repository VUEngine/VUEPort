/**
 * Checks the VSU mixer panel with a cartridge that plays four channels and rewrites a waveform bank half a second in:
 * strips name the note (A4, not the 14,080 Hz step rate), muting takes a channel out of the output while the strip
 * still shows the game's level (the mute is the mixer's, the game's state is untouched), and a bank rewritten at run
 * time shows up and is marked, as drivers swap banks between notes to change instrument.
 *
 * Usage: node tests/vsu-panel-probe.mjs (after `yarn build`)
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

const SxINT = 0x00;
const SxLRV = 0x04;
const SxFQL = 0x08;
const SxFQH = 0x0c;
const SxEV0 = 0x10;
const SxEV1 = 0x14;
const SxRAM = 0x18;
const S5SWP = 0x1c;

// the hardware steps a 32-sample waveform at 5,000,000 / (2048 - F) Hz, so the note is a 32nd of that
// (measured in core/tests/vsu-frequency-probe.mjs)
const forNote = hz => Math.round(2048 - 5000000 / (hz * 32));

const A4 = forNote(440);
const D4 = forNote(293.665);

// channels 3 and 4 stay off, so the panel has something silent to draw. The bank swap is behind SSTOP, as the VSU
// only accepts waveform RAM while every channel is off, which is how a real driver changes instrument mid-tune.
function buildRom() {
    const size = 0x100000;
    const rom = new Uint8Array(size);
    const view = new DataView(rom.buffer);
    let at = 0;
    const half = value => { view.setUint16(at, value & 0xffff, true); at += 2; };
    const movhi = (imm, r1, r2) => { half((0x2f << 10) | (r2 << 5) | r1); half(imm); };
    const movea = (imm, r1, r2) => { half((0x28 << 10) | (r2 << 5) | r1); half(imm); };
    const stb = (source, disp, base) => { half((0x34 << 10) | (source << 5) | base); half(disp); };
    const addImm = (imm, reg) => half((0x11 << 10) | (reg << 5) | (imm & 0x1f));
    const cmp = (r1, r2) => half((0x03 << 10) | (r2 << 5) | r1);
    const bne = disp => half(0x9400 | (disp & 0x1ff));
    const jmp = r1 => half((0x06 << 10) | r1);

    // r10 is the VSU's base, r11 carries every value written through it
    const write = (offset, value) => { movea(value, 0, 11); stb(11, offset, 10); };
    const channel = (index, offset, value) => write(0x400 + index * 0x40 + offset, value);
    // one bank of 32 samples, one sample every four bytes
    const bank = (index, sampleAt) => {
        for (let sample = 0; sample < 32; sample += 1) {
            write(index * 0x80 + sample * 4, sampleAt(sample) & 0x3f);
        }
    };

    at = 0x1000;
    movhi(0x0100, 0, 10); // r10 = 0x01000000

    bank(0, sample => Math.round(31.5 + 31.5 * Math.sin((sample / 32) * 2 * Math.PI))); // sine
    bank(1, sample => (sample < 16 ? 63 : 0)); // square
    bank(2, sample => sample * 2); // saw

    channel(0, SxLRV, 0xff);
    channel(0, SxFQL, A4 & 0xff);
    channel(0, SxFQH, (A4 >> 8) & 0x07);
    channel(0, SxRAM, 0);
    channel(0, SxEV0, 0xf0);
    channel(0, SxEV1, 0x00);
    channel(0, SxINT, 0x80);

    channel(1, SxLRV, 0x8c);
    channel(1, SxFQL, D4 & 0xff);
    channel(1, SxFQH, (D4 >> 8) & 0x07);
    channel(1, SxRAM, 1);
    channel(1, SxEV0, 0xa0);
    channel(1, SxEV1, 0x00);
    channel(1, SxINT, 0x80);

    channel(4, SxLRV, 0x66);
    channel(4, SxFQL, D4 & 0xff);
    channel(4, SxFQH, (D4 >> 8) & 0x07);
    channel(4, SxRAM, 2);
    channel(4, SxEV0, 0x80);
    channel(4, SxEV1, 0x41); // sweep, switched on
    channel(4, S5SWP, 0x91); // fast clock, every interval, up
    channel(4, SxINT, 0x80);

    channel(5, SxLRV, 0x44);
    channel(5, SxFQL, D4 & 0xff);
    channel(5, SxFQH, (D4 >> 8) & 0x07);
    channel(5, SxEV0, 0x60);
    channel(5, SxEV1, 0x40); // tap 4
    channel(5, SxINT, 0x80);

    // rewrites the stereo levels as it plays, as real drivers write `SxLRV` every tick, so a mute that zeroes the level
    // would be undone; a ROM setting the levels once would let a broken mute pass
    const delay = () => {
        movhi(0x0040, 0, 13);
        movea(0, 0, 12);
        const loop = at;
        channel(0, SxLRV, 0xff);
        channel(1, SxLRV, 0x8c);
        channel(4, SxLRV, 0x66);
        channel(5, SxLRV, 0x44);
        addImm(1, 12);
        cmp(13, 12);
        bne(loop - at); // the displacement is from the branch's own address
    };

    // change instrument the way a driver does: everything off (the VSU only accepts waveform RAM then), bank rewritten,
    // channels started again
    const swapTo = shape => {
        write(0x580, 1); // SSTOP
        bank(0, shape);
        channel(0, SxINT, 0x80);
        channel(1, SxINT, 0x80);
        channel(4, SxINT, 0x80);
        channel(5, SxINT, 0x80);
    };

    // back and forth between two shapes forever, so a probe arriving at any moment still sees one happen
    const swapping = at;
    delay();
    swapTo(sample => (sample < 16 ? sample * 4 : (31 - sample) * 4)); // triangle
    delay();
    swapTo(sample => Math.round(31.5 + 31.5 * Math.sin((sample / 32) * 2 * Math.PI)));
    // out of a branch's reach (one bank rewrite is 256 bytes of stores), so the way back is via a register; the ROM is
    // mirrored into the top of the bus, where the reset vector points too
    movhi(0xfff0, 0, 14);
    movea(swapping, 14, 14);
    jmp(14);

    at = size - 0x10;
    movhi(0xfff0, 0, 10);
    movea(0x1000, 10, 10);
    jmp(10);

    // a header, or the application will not load the file at all
    const header = size - 544;
    const ascii = (text, offset) => {
        for (let i = 0; i < text.length; i += 1) {
            rom[offset + i] = text.charCodeAt(i);
        }
    };
    ascii('VUEPORT VSU'.padEnd(20, ' '), header);
    ascii('VU', header + 25);
    ascii('VVSU', header + 27);
    rom[header + 31] = 1;
    return rom;
}

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'vsu.vb');
await writeFile(romPath, Buffer.from(buildRom()));

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer:\n'
        + '  yarn add --dev -W puppeteer\n');
    server.close();
    process.exit(1);
}
const browser = await puppeteer.launch({
    // the machine has to actually run, and the drive loop is clocked by audio
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
});
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

const strips = () => page.evaluate(() => [...document.querySelectorAll('.vp-vsu-strip')]
    .map(strip => ({
        name: (strip.querySelector('.vp-vsu-strip-name')?.textContent ?? '').trim(),
        note: (strip.querySelector('.vp-vsu-strip-note')?.textContent ?? '').trim(),
        playing: strip.classList.contains('active'),
        silenced: strip.classList.contains('silenced'),
        levels: [...strip.querySelectorAll('.vp-vsu-level-fill')]
            .map(fill => fill.style.width),
    })));

// in dB, as the two readouts under it are written
const output = () => page.evaluate(() =>
    [...document.querySelectorAll('.vp-vsu-output-db')].map(node => node.textContent.trim()));

const audible = async () => (await output()).some(text => !text.startsWith('−∞'));

async function waitFor(what, timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await what()) {
            return Date.now() - started;
        }
        await wait(100);
    }
    return undefined;
}

await boot();
check('the VSU panel opens', await openPanel('VSU'));
await page.waitForSelector('.vp-vsu-strip', { timeout: 10000 });
await wait(600);

// what the machine is playing

console.log('\nThe strips say what the machine is playing');
{
    const rows = await strips();
    report('strips', JSON.stringify(rows.map(row => `${row.name}: ${row.note}`)));
    check('there is one per channel', rows.length === 6, String(rows.length));
    check('the four that were started are playing, the other two are not',
        rows.map(row => row.playing).join(','), 'true,true,false,false,true,true');
    check('a channel given A4 says so', /\bA4\b/.test(rows[0]?.note ?? ''), rows[0]?.note);
    check('and the one given D4 too', /\bD4\b/.test(rows[1]?.note ?? ''), rows[1]?.note);
    // the step rate is 32 times the note and must not be what is shown
    check('the step rate is not what is shown', !/14080|14,080/.test(rows[0]?.note ?? ''),
        rows[0]?.note);
    check('Noise is a rate and gets no note name', /^\d+ Hz$/.test(rows[5]?.note ?? ''),
        rows[5]?.note);

    const banks = await page.evaluate(() => document.querySelectorAll('.vp-vsu-bank').length);
    check('the waveform banks are drawn', banks >= 5, String(banks));
    check('the output meter reads something', (await output()).length === 2,
        JSON.stringify(await output()));
    check('and the machine is audible', await audible(), JSON.stringify(await output()));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

// muting

console.log('\nMuting takes a channel out of the mix, and nothing else');
{
    const before = (await strips())[0];
    await page.evaluate(() => {
        const all = [...document.querySelectorAll('.vp-vsu-strip')];
        for (const strip of all.slice(1)) {
            strip.querySelector('.vp-vsu-button')?.click();
        }
    });
    await wait(600);
    check('the machine is still audible with one channel left',
        await audible(), JSON.stringify(await output()));

    await page.evaluate(() =>
        document.querySelector('.vp-vsu-strip .vp-vsu-button')?.click());
    const silent = await waitFor(async () => !(await audible()), 5000);
    check('muting the last one silences the machine', silent !== undefined,
        JSON.stringify(await output()));

    const after = (await strips())[0];
    check('the muted strip says so', after.silenced, JSON.stringify(after));
    check('but the channel is still playing as far as the game is concerned',
        after.playing, JSON.stringify(after));
    check('and it still shows the levels the game gave it',
        JSON.stringify(after.levels) === JSON.stringify(before.levels),
        `${JSON.stringify(after.levels)} vs ${JSON.stringify(before.levels)}`);

    await page.evaluate(() => {
        const undo = [...document.querySelectorAll('.vp-vsu-output-bar button')].pop();
        undo?.click();
    });
    const back = await waitFor(audible, 5000);
    check('Unmute all brings the sound back', back !== undefined,
        JSON.stringify(await output()));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nSolo picks one channel out of the six');
{
    const soloed = () => page.evaluate(() => [...document.querySelectorAll('.vp-vsu-strip')]
        .map(strip => strip.querySelector('.vp-vsu-button.solo')?.getAttribute('aria-pressed') === 'true'));

    await page.evaluate(() => {
        const strip = document.querySelectorAll('.vp-vsu-strip')[1];
        strip.querySelector('.vp-vsu-button.solo')?.click();
    });
    await wait(700);
    const rows = await strips();
    check('the soloed channel is the only one left in the mix',
        rows.map(row => row.silenced).join(','), 'true,false,true,true,true,true');
    check('the machine is still making sound', await audible(), JSON.stringify(await output()));

    // strips saying "silenced" is not the machine being silent: soloing a switched-off channel must silence everything
    // else. Pressed straight from the first solo, which is also how the solo moves.
    await page.evaluate(() => {
        const strips = [...document.querySelectorAll('.vp-vsu-strip')];
        strips[2].querySelector('.vp-vsu-button.solo')?.click(); // a silent one
    });
    await wait(700);
    check('soloing another channel moves the solo rather than adding to it',
        (await soloed()).join(','), 'false,false,true,false,false,false');
    const quiet = await waitFor(async () => !(await audible()), 5000);
    check('soloing a channel that is not playing silences the machine',
        quiet !== undefined, JSON.stringify(await output()));

    await page.evaluate(() => {
        const strip = document.querySelectorAll('.vp-vsu-strip')[2];
        strip.querySelector('.vp-vsu-button.solo')?.click();
    });
    await wait(700);
    check('dropping the solo gives the others back',
        (await strips()).every(row => !row.silenced));
}

// a bank rewritten while the game runs

console.log('\nA waveform bank changing under a playing channel');
{
    // the cartridge swaps bank 0 half a second in; the polled drawing has to follow and the bank gets marked
    const shapeOf = () => page.evaluate(() =>
        document.querySelector('.vp-vsu-bank polyline')?.getAttribute('points') ?? '');
    // waited for by the shape rather than the mark, the drawing is the change itself
    const first = await shapeOf();
    const redrawn = await waitFor(async () => await shapeOf() !== first, 25000);
    report('the bank was redrawn after', `${redrawn ?? '>25000'} ms`);
    check('the panel redraws a bank the game rewrote under it', redrawn !== undefined,
        `${(await shapeOf()).slice(0, 40)} vs ${first.slice(0, 40)}`);
    check('and marks it as having just changed',
        await page.$('.vp-vsu-bank.changed') !== null);

    const cleared = await waitFor(async () =>
        await page.$('.vp-vsu-bank.changed') === null, 8000);
    check('the mark goes away again', cleared !== undefined);
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

// closing the panel

console.log('\nClosing the panel gives the machine its voice back');
{
    await page.evaluate(() => {
        const strip = document.querySelector('.vp-vsu-strip');
        strip.querySelector('.vp-vsu-button')?.click();
    });
    await wait(500);
    check('a channel is muted to close the panel on',
        (await strips())[0].silenced);

    // a real click on the tab's close icon. The dock keeps the closed panel for reuse, so a mute released only on
    // disposal would survive this.
    const closer = await page.evaluateHandle(() => {
        const tab = [...document.querySelectorAll('.vp-dock .lm-TabBar-tab')]
            .find(node => (node.textContent ?? '').includes('VSU'));
        return tab?.querySelector('.lm-TabBar-tabCloseIcon') ?? null;
    });
    const element = closer.asElement();
    check('the tab has a close button', element !== null);
    if (element) {
        await element.click();
    }
    await wait(1200);
    check('the panel is gone', await page.$('.vp-vsu-strip') === null);

    check('it opens again', await openPanel('VSU'));
    await page.waitForSelector('.vp-vsu-strip', { timeout: 10000 });
    await wait(700);
    check('nothing is muted any more', (await strips()).every(row => !row.silenced),
        JSON.stringify((await strips()).map(row => row.silenced)));
    check('and the machine is making sound again', await audible(),
        JSON.stringify(await output()));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

await finish();
