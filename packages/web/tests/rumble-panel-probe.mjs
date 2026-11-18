/**
 * Does the Rumble Pack panel show a game's rumble in a browser, with and without a pack to send it to? Without serial
 * (Firefox, Safari, a phone) the page still reads and decodes the link port bytes. There the panel must say the port is
 * being read, offer no Detect button, and show the decoded commands, a motor box that shakes while an effect plays, and
 * an effect that ends with no Stop (see RUMBLE_EFFECT_MAX_MS). With Web Serial, checked against a fake navigator.serial
 * port with the final board's USB ids, the granted pack is picked up without a prompt, and the game's bytes must arrive
 * as the firmware's own `<VB nnn>`: bracketed and unterminated, or a real pack stays silent through a rumbling game.
 *
 * Usage: node tests/rumble-panel-probe.mjs (after `yarn build`)
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

// the link port registers as the hardware lays them out, see vb-constants.ts
const LINK_BASE = 0x02000000;
const CCR = 0x00; // control: writing it with the start bit sends what is staged
const CDTR = 0x08; // transmit: the byte the next transfer will carry
const LINK_START = 0x04;

// the rumble protocol's own bytes, see RUMBLE_CMD
const RUMBLE_STOP = 0x00;
const RUMBLE_PLAY = 0x7c;
const RUMBLE_EFFECT = 14; // Strong Buzz, 100 % — long enough to be caught
const RUMBLE_HUM = 123; // Smooth Hum 5, 10 % — the quietest thing the pack has
const RUMBLE_FREQ_160 = 0x90;

// one effect, started and stopped with a pause either side, in an endless loop, so the probe finds something to
// show at any moment and sees the motor both running and stopped if it waits
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

    // r10 is the link port's base, r11 carries every value written through it
    const write = (offset, value) => { movea(value, 0, 11); stb(11, offset, 10); };

    // stage the byte in the transmit register, then set the start bit in the control register. Only the start is a
    // byte leaving the machine, so the emulator counts starts, not stages
    const send = byte => {
        write(CDTR, byte);
        write(CCR, LINK_START);
    };

    // counted in turns of a four-instruction loop; turns is the top half, so 0x0008 is 0x80000 turns, a little
    // under a third of a second
    const delay = turns => {
        movhi(turns, 0, 13);
        movea(0, 0, 12);
        const loop = at;
        addImm(1, 12);
        cmp(13, 12);
        bne(loop - at); // the displacement is from the branch's own address
    };
    const SHORT = 0x0008; // ~0.3 s
    const LONG = 0x0074; // ~4 s, comfortably past the ceiling whatever it is set to

    at = 0x1000;
    movhi(0x0200, 0, 10); // r10 = 0x02000000

    const rumbling = at;
    // an effect the way a game that bothers plays one: frequency, effect, go, and a Stop when it wants it over
    send(RUMBLE_FREQ_160);
    send(RUMBLE_EFFECT);
    send(RUMBLE_PLAY);
    delay(SHORT);
    send(RUMBLE_STOP);
    delay(SHORT);

    // and one nothing ever ends, just as ordinary, as the pack stops it by itself. The quietest effect, so the motor
    // box can be caught trembling rather than knocking
    send(RUMBLE_HUM);
    send(RUMBLE_PLAY);
    delay(LONG);
    // out of a branch's reach, so the way back is an address in a register. The ROM is mirrored into the top of the
    // bus, where the reset vector below points too
    movhi(0xfff0, 0, 14);
    movea(rumbling, 14, 14);
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
    ascii('VUEPORT RUMBLE'.padEnd(20, ' '), header);
    ascii('VU', header + 25);
    ascii('VRMB', header + 27);
    rom[header + 31] = 1;
    return rom;
}

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'rumble.vb');
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

// take the Web Serial API away, as in every browser but Chromium, which Puppeteer drives
const WITHOUT_SERIAL = () => {
    delete Navigator.prototype.serial;

    // a controller with two motors, which a page with no port can still make a game felt on. The Gamepad API withholds
    // a pad until a button is pressed, so it is stood up rather than waited for; requests end up in window.__buzz
    window.__buzz = [];
    const pad = {
        index: 0,
        id: 'VUEPort Probe Pad (Vendor: 0000 Product: 0000)',
        mapping: 'standard',
        connected: true,
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
        vibrationActuator: {
            playEffect: async (type, params) => {
                window.__buzz.push({ type, ...params });
                return 'complete';
            },
            reset: async () => 'complete',
        },
    };
    navigator.getGamepads = () => [pad];
};

// a navigator.serial with one granted port reporting the final board's USB ids, so the page picks it up at
// start-up without a click. What the emulator writes ends up in window.__written as whole lines
const WITH_FAKE_PACK = () => {
    window.__written = [];
    const port = {
        getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x8036 }),
        // never enqueues: the firmware only answers when it has something to say, and this one never does
        readable: new ReadableStream({ start() { } }),
        writable: new WritableStream({
            write(chunk) {
                window.__written.push(new TextDecoder().decode(chunk).trim());
            },
        }),
        open: async () => undefined,
        close: async () => undefined,
    };
    Object.defineProperty(Navigator.prototype, 'serial', {
        configurable: true,
        value: {
            getPorts: async () => [port],
            requestPort: async () => port,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => true,
        },
    });
};

async function session(prepare) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument(prepare);

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

    const panel = () => page.evaluate(() => {
        const all = selector => [...document.querySelectorAll(selector)]
            .map(node => (node.textContent ?? '').trim());
        const text = selector => all(selector)[0] ?? '';
        return {
            headline: text('.vp-rumble-pack-status-headline'),
            // joined, as which line each part lands on is the panel's business, not this probe's
            detail: all('.vp-rumble-pack-status-detail').filter(Boolean).join(' · '),
            count: text('.vp-rumble-pack-status-count'),
            running: document.querySelector('.vp-rumble-pack-motor')
                ?.classList.contains('running') ?? false,
            strength: document.querySelector('.vp-rumble-pack-motor')
                ?.style.getPropertyValue('--vp-rumble-amount') ?? '',
            badge: text('.vp-rumble-pack-playing'),
            detect: (document.querySelector('.vp-rumble-pack-status button')
                ?.textContent ?? '').trim(),
            commands: all('.vp-rumble-pack-commands > div'),
            effect: all('.vp-rumble-pack-info tr'),
            written: window.__written ? [...window.__written] : undefined,
            buzz: window.__buzz ? [...window.__buzz] : undefined,
        };
    });

    async function waitFor(what, timeoutMs = 20000) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (what(await panel())) {
                return Date.now() - started;
            }
            await wait(120);
        }
        return undefined;
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

    return { page, errors, panel, waitFor, boot, openPanel };
}

async function finish() {
    await browser.close();
    server.close();
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

// a browser with no port to open

const plain = await session(WITHOUT_SERIAL);
await plain.boot();

console.log('\nThe panel opens');
{
    check('Rumble Pack is offered', await plain.openPanel('Rumble'));
    await plain.page.waitForSelector('.vp-rumble-pack-status', { timeout: 10000 });
}

console.log('\nWhat the connection box says with no way to reach a pack');
{
    const state = await plain.panel();
    report('headline', JSON.stringify(state.headline));
    report('detail', JSON.stringify(state.detail));
    check('it does not claim the emulator is stopped while a game runs',
        !state.detail.includes('not running'), JSON.stringify(state.detail));
    check('it says so rather than reading as a pack not plugged in yet',
        state.detail.toLowerCase().includes('not supported'), JSON.stringify(state.detail));
    check('and offers no Detect button, having nowhere to look',
        state.detect === '', JSON.stringify(state.detect));
    // bytes sent belongs to a pack that is there to send them to
    check('and counts no bytes sent', state.count === '', JSON.stringify(state.count));
}

console.log('\nWhat the game is asking for');
{
    // waited for rather than read: capture starts when the game finishes loading, often mid-cycle, and the next effect
    // is a whole long pause away
    const took = await plain.waitFor(state => state.commands.length > 0);
    check('commands arrive off the link port', took !== undefined, 'nothing in 20s');
    report('first command after', `${took} ms`);
    check('the frequency is among them',
        await plain.waitFor(s2 => s2.commands.some(row => row.includes('160 Hz'))) !== undefined,
        JSON.stringify((await plain.panel()).commands));
    check('and the effect, by name',
        await plain.waitFor(s2 => s2.commands.some(row => row.includes('Strong Buzz'))) !== undefined,
        JSON.stringify((await plain.panel()).commands));
    check('and the Last Effect group reads the effect off them',
        await plain.waitFor(s2 => s2.effect.some(row => row.includes('Strong Buzz'))) !== undefined,
        JSON.stringify((await plain.panel()).effect));
    report('commands', JSON.stringify((await plain.panel()).commands.slice(-4)));
}

console.log('\nThe motor box');
{
    const started = await plain.waitFor(state => state.running);
    check('shakes while an effect is playing', started !== undefined, 'never ran in 20s');
    const stopped = await plain.waitFor(state => !state.running);
    check('and stops when the game stops it', stopped !== undefined, 'never stopped in 20s');
}

console.log('\nThe box shakes as hard as the effect pulls');
{
    // 14 is Strong Buzz at 100 %, 123 a Smooth Hum at 10 %; this checks the amplitudes reach the stylesheet
    const loud = await plain.waitFor(
        state => state.running && state.commands.at(-1)?.includes('Strong Buzz') === false
            && state.strength === '1', 25000);
    check('a Strong Buzz shakes it at full strength', loud !== undefined,
        JSON.stringify((await plain.panel()).strength));
    const quiet = await plain.waitFor(state => state.running && state.strength === '0.1', 25000);
    check('and a Smooth Hum at a tenth of that', quiet !== undefined,
        JSON.stringify((await plain.panel()).strength));
}

console.log('\nAn effect nothing ever ends');
{
    // the newest command still being the Play makes this the ceiling and not a Stop. The motor is part of the
    // condition, as the game loops and a second read may see the next effect; one snapshot has to hold all three
    const ended = await plain.waitFor(
        state => state.badge === 'Stopped'
            && !state.running
            && state.commands.at(-1)?.endsWith('Play') === true,
        25000,
    );
    check('is over anyway — motor still, with no Stop behind it', ended !== undefined,
        JSON.stringify(await plain.panel()));
    check('nothing errored', plain.errors.length === 0, plain.errors.join(' | '));
}

console.log('\nThe controller in somebody\'s hands');
{
    // most users have no pack, but a pad has two motors to feel a game's effects on; see GamepadRumble and its probe
    const felt = await plain.waitFor(state => (state.buzz ?? []).length > 0, 25000);
    check('a Play reaches the pad', felt !== undefined, 'nothing in 25s');
    const buzz = (await plain.panel()).buzz;
    report('effects played', JSON.stringify(buzz.slice(-2)));
    check('as a dual-rumble effect', buzz.every(one => one.type === 'dual-rumble'), JSON.stringify(buzz[0]));
    check('with both motors asked for something',
        buzz.every(one => one.strongMagnitude > 0 && one.weakMagnitude > 0),
        JSON.stringify(buzz[0]));
    check('and a duration it could not have got from the protocol',
        buzz.every(one => one.duration > 0), JSON.stringify(buzz[0]));
    check('nothing errored', plain.errors.length === 0, plain.errors.join(' | '));
}

await plain.page.close();

// a browser that can open the port

const serial = await session(WITH_FAKE_PACK);
await serial.boot();

console.log('\nA pack the browser can reach');
{
    check('Rumble Pack is offered', await serial.openPanel('Rumble'));
    await serial.page.waitForSelector('.vp-rumble-pack-status', { timeout: 10000 });

    const found = await serial.waitFor(state => state.headline.includes('Connected'), 10000);
    check('is picked up without a prompt', found !== undefined,
        JSON.stringify(await serial.panel()));
    const state = await serial.panel();
    report('headline', JSON.stringify(state.headline));
    report('detail', JSON.stringify(state.detail));
    check('with the ids the port reports',
        state.detail.includes('0x2341') && state.detail.includes('0x8036'),
        JSON.stringify(state.detail));
    check('and forwarding, because a game is running',
        state.detail.includes('forwarding'), JSON.stringify(state.detail));
    check('the button now offers to reconnect rather than to look',
        state.detect, 'Reconnect');
}

console.log('\nWhat reaches the wire');
{
    // one at a time, as the port opens part-way through a cycle. 0x90 is the frequency, 0x0e the effect, 0x7c the
    // Play, each in angle brackets and as three digits, the only shape the firmware reads
    const wrote = line => serial.waitFor(
        state => (state.written ?? []).includes(line), 25000) !== undefined;
    check('the Play arrives in the firmware\'s own framing', await wrote('<VB 124>'),
        JSON.stringify((await serial.panel()).written?.slice(-6)));
    check('and the frequency', await wrote('<VB 144>'),
        JSON.stringify((await serial.panel()).written?.slice(-6)));
    check('and the effect', await wrote('<VB 014>'),
        JSON.stringify((await serial.panel()).written?.slice(-6)));
    const state = await serial.panel();
    report('written', JSON.stringify(state.written.slice(-6)));
    check('and the counter counts what went out',
        /[1-9]\d* bytes sent/.test(state.count), JSON.stringify(state.count));
    check('nothing errored', serial.errors.length === 0, serial.errors.join(' | '));
}

await finish();
