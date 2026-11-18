// two windows, one linked game (see web-link.ts): the second window opens with its own toolbar and screen, both agree
// they are linked, a keystroke in one reaches the other's mirror, and closing one leaves the other playing
// Usage: node tests/two-window-link-probe.mjs (after `yarn build`)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
    if (!ok) {
        failures++;
    }
};

if (!existsSync(path.join(dist, 'index.html'))) {
    console.log('\nskipped: dist is not built\n');
    process.exit(0);
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
    '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const server = createServer(async (request, response) => {
    const url = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    try {
        const body = await readFile(path.join(dist, url));
        response.writeHead(200, {
            'content-type': TYPES[path.extname(url)] ?? 'application/octet-stream',
        });
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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(page, probe, timeout = 15000, step = 200, ...args) {
    const deadline = Date.now() + timeout;
    for (;;) {
        if (await page.evaluate(probe, ...args)) {
            return true;
        }
        if (Date.now() > deadline) {
            return false;
        }
        await wait(step);
    }
}

// --disable-audio-output gives Chrome a fake audio sink that keeps ticking: the emulator is clocked by its audio
// worklet, and with the Mac's screen locked the real device stops. In every probe that runs a game, except
// blocked-audio-probe.mjs, whose subject is held-back audio
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const errors = [];
const watch = page => {
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
        // the start page looks the cartridge up on Planet VB; only the first window's requests can be stubbed, as the
        // second is opened by the page
        if (message.type() === 'error' && !message.location()?.url?.includes('api.vueport.net')) {
            errors.push(message.text());
        }
    });
};

const first = await browser.newPage();
watch(first);
await first.setViewport({ width: 1280, height: 800 });

await first.setRequestInterception(true);
first.on('request', request => {
    if (request.url().includes('api.vueport.net/')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

// a screen panel also carries a glow, an overlay and a hidden placeholder canvas, so this one means a game is running
const PICTURE = '.vp-screen-picture > canvas'
    + ':not(.vp-screen-overlay):not(.vp-screen-glow):not(.vp-screen-placeholder)';

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

console.log('\nTwo windows, one linked game\n');

await first.goto(`${origin}/index.html`, { waitUntil: 'networkidle0' });
await first.waitForSelector('.vp-library-side-foot .vp-button');
await wait(600);
const [chooser] = await Promise.all([
    first.waitForFileChooser(),
    first.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await first.waitForSelector(PICTURE, { timeout: 20000 }).catch(() => undefined);
await wait(2000);

check('player 1 has a game running', (await first.$$(PICTURE)).length === 1);

check('the link button is offered',
    await first.$('.vp-titlebar-button[data-control="link"]') !== null);

/**
 * A cheat switched on before anybody is invited: nothing carries it to the other window's mirror, so the digests would
 * end the session within a second unless the session sends the machine's standing edits at frame zero of every run
 * (standingEdits in link-session.ts). Left on for everything below, so later checks run with a cheat in force. Driven
 * through evaluate rather than page.click, which asks for a layout box first and can time out on a page running an
 * emulator flat out.
 */
const clickIn = (page, selector, label) => page.evaluate((sel, text) => {
    const nodes = [...document.querySelectorAll(sel)];
    const node = text
        ? nodes.find(n => (n.textContent || '').toLowerCase().includes(text) && !n.disabled)
        : nodes[0];
    node?.click();
    return !!node;
}, selector, label ?? '');

await clickIn(first, '.vp-titlebar-button[data-control="cheats"]');
await wait(600);
check('the cheats can be opened', await first.$('.vp-panel-aside') !== null);
check('and a cheat added',
    await clickIn(first, '.vp-panel-actions button', 'add cheat'));
await wait(500);
// typed rather than searched for: an address in work RAM can simply be named
await first.type('.vp-cheats-code-add .paste', '5000100:0063');
await first.keyboard.press('Enter');
await wait(300);
check('with a code in it', await first.$eval(
    '.vp-cheats-address input', el => el.value).catch(() => '') !== '');
await clickIn(first, '.vp-panel-back');
await wait(400);
check('and switched on', await first.evaluate(() => {
    const toggle = document.querySelector('.vp-panel-aside .vp-switch');
    const wasOff = toggle?.getAttribute('aria-checked') === 'false';
    toggle?.click();
    return wasOff;
}));
await wait(500);
await clickIn(first, '.vp-titlebar-button[data-control="cheats"]');
await wait(400);

const opened = new Promise(resolve => browser.once('targetcreated', resolve));
await first.click('.vp-titlebar-button[data-control="link"]');
const target = await Promise.race([opened, wait(10000).then(() => undefined)]);
const second = target && await target.page();

if (!second) {
    check('inviting opened a second window', false, 'no window appeared');
} else {
    check('inviting opened a second window', true);
    watch(second);
    await second.setViewport({ width: 1280, height: 800 });

    const address = new URL(second.url());
    check('the second window is addressed as player 2',
        address.searchParams.get('player') === '2', second.url());
    check('and carries the game to open', !!address.searchParams.get('game'));
    check('and a session to join', !!address.searchParams.get('link'));

    const secondStarted = await until(second, sel => document.querySelectorAll(sel).length === 1, 25000, 250, PICTURE);
    check('the second window opened the same game by itself', secondStarted);

    check('and shows exactly one screen, as does the first',
        (await second.$$(PICTURE)).length === 1 && (await first.$$(PICTURE)).length === 1);

    check('the second window is a whole emulator, not a borrowed pane',
        await second.evaluate(() => !!document.querySelector('.vp-titlebar')
            && !!document.querySelector('.vp-status')
            && !!document.querySelector('.vp-titlebar-button[data-control="link"]')));

    check('neither window shows a split screen',
        await first.evaluate(() => !document.querySelector('.vp-link-split'))
        && await second.evaluate(() => !document.querySelector('.vp-link-split')));

    const linked = async page => await page.$('.vp-titlebar-pill.linked') !== null;
    check('both windows say they are linked',
        await until(first, () => !!document.querySelector('.vp-titlebar-pill.linked'))
        && await until(second, () => !!document.querySelector('.vp-titlebar-pill.linked')));
    check('each naming its own player',
        (await first.$eval('.vp-titlebar-pill.linked', el => el.textContent)).includes('P1')
        && (await second.$eval('.vp-titlebar-pill.linked', el => el.textContent)).includes('P2'));

    // under lockstep neither machine runs a frame without input for it, so both still running proves inputs cross
    const speed = page => page.$eval('.vp-status-value', el => el.textContent ?? '');
    const running = text => /\d/.test(text) && !text.startsWith('0%');
    // polled, as an untouched page is throttled and sleeping then reading the speed would measure the throttling
    const bothRunning = async (timeout) => {
        const deadline = Date.now() + timeout;
        for (;;) {
            const readings = [await speed(first), await speed(second)];
            if (readings.every(running)) {
                return readings;
            }
            if (Date.now() > deadline) {
                return readings;
            }
            await wait(400);
        }
    };
    const [firstSpeed, secondSpeed] = await bothRunning(8000);
    check('both windows keep emulating, so input is crossing both ways',
        running(firstSpeed) && running(secondSpeed),
        `player 1 "${firstSpeed}", player 2 "${secondSpeed}"`);

    // several rounds of digests: windows that came apart or disagreed about when to take one would have ended the
    // session by now (see LinkSession.DIGEST_PERIOD_FRAMES)
    for (let round = 0; round < 10; round++) {
        await wait(400);
        await bothRunning(2000);
    }
    // with a cheat on, the machines only still agree because the cheat reached both
    check('the digests keep agreeing, so the session survives them',
        await linked(first) && await linked(second)
        && (await bothRunning(2000)).every(running));

    // a linked save state covers both machines and loading puts both windows back together, so both must still play one
    // game afterwards. Through the keyboard, as the strip is an overlay that comes and goes with the pointer
    await first.focus('.vp-screen');
    await first.keyboard.press('Digit1');       // save state
    await wait(2500);
    check('a linked game can be saved',
        await first.$eval('.vp-strip-button[data-control="load-state"]',
            el => !el.hasAttribute('disabled')).catch(() => false));

    await first.keyboard.press('Digit2');       // load state
    const backUpToSpeed = await bothRunning(6000);
    check('loading one leaves both windows in the session',
        await linked(first) && await linked(second));
    check('and both still playing', backUpToSpeed.every(running), backUpToSpeed.join(' / '));

    // a keystroke is taken by its own window only; the other gets it over the channel
    await first.focus('.vp-screen');
    await first.keyboard.down('Enter');
    check('a key held in one window does not stop the other',
        (await bothRunning(4000)).every(running));
    await first.keyboard.up('Enter');

    /**
     * Unlinking from player 2's window and linking again: player 1 waits with its end of the cable in, and one press
     * in player 2's window reconnects, rather than opening a third window as player 1 of a new session while player 1
     * holds a dead one. Pressed through the page, as page.click waits for the element to hold still across animation
     * frames, which never happens in a throttled background window that is emulating.
     */
    const clickLink = page => page.evaluate(() =>
        document.querySelector('.vp-titlebar-button[data-control="link"]').click());
    const before = (await browser.pages()).length;
    await clickLink(second);
    check('unlinking leaves both windows out of the session',
        await until(second, () => !document.querySelector('.vp-titlebar-pill.linked'))
        && await until(first, () => !document.querySelector('.vp-titlebar-pill.linked')));
    check('and both windows still playing',
        (await bothRunning(6000)).every(running));
    check('and neither window closed', (await browser.pages()).length === before);

    await clickLink(second);
    check('linking again, from player 2, puts them back together',
        await until(second, () => !!document.querySelector('.vp-titlebar-pill.linked'), 15000)
        && await until(first, () => !!document.querySelector('.vp-titlebar-pill.linked'), 15000));
    check('with no third window opened', (await browser.pages()).length === before);
    check('still as the same two players',
        (await first.$eval('.vp-titlebar-pill.linked', el => el.textContent)).includes('P1')
        && (await second.$eval('.vp-titlebar-pill.linked', el => el.textContent)).includes('P2'));
    check('and playing again', (await bothRunning(8000)).every(running),
        (await bothRunning(8000)).join(' / '));

    // the same from player 1's side: unlinking does not close the other player's window, both keep playing and one
    // press reconnects
    await clickLink(first);
    const p1Unlinked = await until(first, () => !document.querySelector('.vp-titlebar-pill.linked'));
    const p2Unlinked = await until(second, () => !document.querySelector('.vp-titlebar-pill.linked'));
    check('player 1 can unlink too', p1Unlinked && p2Unlinked,
        `p1 dropped the badge: ${p1Unlinked}, p2: ${p2Unlinked}`);
    check('without closing the other player\'s window',
        (await browser.pages()).length === before);
    check('and both windows carry on playing',
        (await bothRunning(6000)).every(running));

    await clickLink(first);
    check('and can link again',
        await until(first, () => !!document.querySelector('.vp-titlebar-pill.linked'), 15000)
        && await until(second, () => !!document.querySelector('.vp-titlebar-pill.linked'), 15000));
    check('still without a third window', (await browser.pages()).length === before);
    check('and playing once more', (await bothRunning(8000)).every(running));

    await second.close();
    let alone = '';
    for (let i = 0; i < 10 && !running(alone); i++) {
        await wait(400);
        alone = await speed(first);
    }
    check('player 1 keeps playing after player 2 leaves',
        running(alone), `speed reads "${alone}"`);
    check('and no longer says it is linked', !await linked(first));
}

check('nothing errored on either page', errors.length === 0, errors.slice(0, 3).join(' | '));

// a page tearing down flushes its saves, and puppeteer reports the round trip it no longer has a target for
await browser.close().catch(() => undefined);
server.close();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
