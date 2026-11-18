/**
 * Checks that the Column Table panel shows the table and its edits land in VIP memory. Boots the VSU probe's cartridge,
 * which never writes a column table, and checks: the panel opens with the chart, position strip and 256-cell grid;
 * Nintendo's table written from the panel lands in both eyes and the window read from CTA is marked; a typed value is
 * written and Escape leaves one unwritten; a stroke across the chart writes the entries it crossed; the display time
 * follows the table.
 *
 * Usage: node tests/column-table-panel-probe.mjs (after `yarn build`)
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

// the hardware steps a 32-sample waveform at 5,000,000 / (2048 - F) Hz, so the note is a thirty-second of that
// (measured in core/tests/vsu-frequency-probe.mjs)
const forNote = hz => Math.round(2048 - 5000000 / (hz * 32));

const A4 = forNote(440);
const D4 = forNote(293.665);

// plays four of the six channels, leaving 3 and 4 off so something is silent, then swaps a waveform after a counted
// delay behind SSTOP, as the VSU only accepts waveform RAM while every channel is off (as a real driver does)
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

    // r10 is the VSU's base; r11 carries every value written through it
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

    // rewrites the stereo levels while playing, as real drivers write SxLRV every tick, so a mute that zeroes the level
    // has to survive the game putting it back; writing them once would let a broken mute pass
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

    // waveform RAM is only accepted with every channel off, so a swap stops all, rewrites the bank and restarts
    const swapTo = shape => {
        write(0x580, 1); // SSTOP
        bank(0, shape);
        channel(0, SxINT, 0x80);
        channel(1, SxINT, 0x80);
        channel(4, SxINT, 0x80);
        channel(5, SxINT, 0x80);
    };

    // back and forth for as long as the machine runs, so a probe arriving at any moment still sees a swap
    const swapping = at;
    delay();
    swapTo(sample => (sample < 16 ? sample * 4 : (31 - sample) * 4)); // triangle
    delay();
    swapTo(sample => Math.round(31.5 + 31.5 * Math.sin((sample / 32) * 2 * Math.PI)));
    // a bank rewrite is 256 bytes of stores, out of a branch's reach, so the way back is a register jump; the ROM is
    // mirrored into the top of the bus, where the reset vector below points too
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
const romPath = path.join(scratch, 'column-table.vb');
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


const cells = () => page.$$eval('.vp-column-grid .vp-column-word', inputs => inputs.map(input => input.value));
const marked = selector => page.$$eval(`.vp-column-grid td${selector}`, tds => tds.length);
const markedIndex = () => page.$$eval('.vp-column-grid td', tds => tds.findIndex(td => td.classList.contains('start')));
const hints = () => page.$$eval('.vp-column-table .vp-inspector-group .hint', nodes => nodes.map(node => node.textContent.trim()));
const clickButton = label => page.evaluate(wanted => {
    for (const button of document.querySelectorAll('.vp-column-table button')) {
        if (button.textContent.trim() === wanted) { button.click(); return true; }
    }
    return false;
}, label);
const pickEye = label => page.evaluate(wanted => {
    for (const option of document.querySelectorAll('.vp-column-table .vp-radio-option')) {
        if (option.textContent.trim() === wanted) { option.click(); return true; }
    }
    return false;
}, label);

await boot();
console.log('\nThe panel');
check('the Column Table panel opens', await openPanel('Column Table'));
await page.waitForSelector('.vp-column-chart', { timeout: 10000 }).catch(() => undefined);
check('with a chart to draw on', await page.$('.vp-column-chart') !== null);
check('the columns\' positions', await page.$('.vp-column-positions') !== null);
check('and all 256 entries to type into', (await cells()).length === 256);

console.log('\nNintendo\'s table');
check('the button is there', await clickButton('Nintendo\'s Table'));
await wait(600);
let values = await cells();
check('it lands in the left eye\'s table', values[0xB1] === '0056' && values[0x6F] === '003C' && values[0] === '00FE');
check('the window the display reads is marked: 96 entries', await marked('.used') === 96);
check('starting at CTA, B1 for the left eye', await markedIndex() === 0xB1);
check('the display takes 5.12ms', (await hints()).some(hint => hint.startsWith('5.12 ms')));
check('the right eye can be picked', await pickEye('Right'));
await wait(400);
values = await cells();
check('and got the same table, both eyes being edited at once', values[0xB1] === '0056' && values[0x6F] === '003C');
check('its window starts at AE', await markedIndex() === 0xAE);
await pickEye('Left');
await wait(400);

console.log('\nTyping');
const cell = index => page.$$('.vp-column-grid .vp-column-word').then(inputs => inputs[index]);
await (await cell(0x10)).click();
await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta');
await page.keyboard.type('1234');
await page.keyboard.press('Enter');
await wait(600);
check('a typed halfword is written', (await cells())[0x10] === '1234');
await (await cell(0x11)).click();
await page.keyboard.type('FFFF');
await page.keyboard.press('Escape');
await wait(600);
check('Escape leaves it unwritten', (await cells())[0x11] === '00FE');

console.log('\nDrawing');
const box = await (await page.$('.vp-column-chart')).boundingBox();
const at = (index, value) => ({ x: box.x + (index + 0.5) / 256 * box.width, y: box.y + (1 - value / 255) * box.height });
const from = at(0x20, 0x80);
const to = at(0x30, 0x80);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let step = 1; step <= 8; step++) {
    await page.mouse.move(from.x + (to.x - from.x) * step / 8, from.y);
    await wait(30);
}
await page.mouse.up();
await wait(700);
values = await cells();
const drawn = values.slice(0x20, 0x31).map(word => parseInt(word, 16));
check('a stroke writes every entry it crosses', drawn.every(word => Math.abs((word & 0xFF) - 0x80) <= 2),
    drawn.map(word => word.toString(16)).join(' '));
check('and leaves their repeat alone', drawn.every(word => (word >> 8) === 0));

console.log('\nWhere the columns land');
const lines = await page.$$eval('.vp-column-positions line', nodes => nodes.length);
check('the strip draws where each group begins', lines >= 90, `${lines} lines`);
await clickButton('Nintendo\'s Table');
await wait(600);
check('Nintendo\'s table again: 5.12ms', (await hints()).some(hint => hint.startsWith('5.12 ms')));

check('no page errors', errors.length === 0, errors.join('\n'));
await finish();
