/**
 * Does the Terminal panel show a program's output, and can it be read while the program keeps writing? A cartridge
 * writes endless lines to the terminal port, some prefixed as VUEngine's messages are. Checked: every line is stamped;
 * a line announcing itself ("Warning:", "Error:", "Info:") is marked as such and can be switched off by kind; search
 * narrows without losing a match's surroundings until Only matches; and following can be scrolled away from, so a
 * once-a-second render does not drag a reader back to the end.
 *
 * Usage: node tests/terminal-panel-probe.mjs (after `yarn build`)
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

// where Terminal::print stores its characters, one byte at a time
const TERMINAL_PORT = 0x02000030;

// two prefixes are there to be switched off and one to be searched for; unprefixed lines, most of a build's output,
// the panel has to leave alone
const LINES = [
    'Stage::loadActors 128 entities',
    // padded and ended with a carriage return, as output formatted for a fixed-width debug screen arrives; none of that
    // should reach the panel
    '   VIPManager frame 1420        \r',
    'Player collision with Wall id=14',
    // padded after the colon too: trimming has to happen after cutting the prefix, not before
    'Warning:    sprite queue at 92%   ',
    'Player collision with Enemy id=31',
    'Error: MemoryPool overflow, block 64',
    'Info: checkpoint reached',
    'SoundManager::play jingle_02',
];

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

    at = 0x1000;
    // r10 is the port, r11 carries each character. A byte at a time as the engine writes; the panel's own line assembly
    // turns them back into lines
    movhi(TERMINAL_PORT >>> 16, 0, 10);
    movea(TERMINAL_PORT & 0xffff, 10, 10);

    const print = text => {
        for (const character of `${text}\n`) {
            movea(character.charCodeAt(0), 0, 11);
            stb(11, 0, 10);
        }
    };

    // long enough that the lines arrive in readable bursts rather than a flood
    const delay = () => {
        movhi(0x0002, 0, 13);
        movea(0, 0, 12);
        const loop = at;
        addImm(1, 12);
        cmp(13, 12);
        bne(loop - at);
    };

    const printing = at;
    for (const line of LINES) {
        print(line);
        delay();
    }
    // out of a branch's reach, so the way back round is an address in a register. The ROM is mirrored into the top of
    // the bus, where the reset vector below points too
    movhi(0xfff0, 0, 14);
    movea(printing, 14, 14);
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
    ascii('VUEPORT TERMINAL'.padEnd(20, ' '), header);
    ascii('VU', header + 25);
    ascii('VTRM', header + 27);
    rom[header + 31] = 1;
    return rom;
}

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'terminal.vb');
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

const lines = () => page.evaluate(() => [...document.querySelectorAll('.vp-terminal-line')]
    .map(line => ({
        time: (line.querySelector('.vp-log-time')?.textContent ?? '').trim(),
        text: (line.querySelector('.vp-terminal-text')?.textContent ?? '').trim(),
        level: ['info', 'warning', 'error'].find(name => line.classList.contains(name)),
        match: line.classList.contains('match'),
        aside: line.classList.contains('aside'),
        marks: [...line.querySelectorAll('.vp-terminal-match')].map(mark => mark.textContent),
        badge: (line.querySelector('.vp-terminal-badge')?.textContent ?? '').trim(),
    })));

const view = () => page.evaluate(() => {
    const scroller = document.querySelector('.vp-terminal-lines');
    return {
        top: Math.round(scroller.scrollTop),
        height: scroller.scrollHeight,
        box: scroller.clientHeight,
    };
});

const following = () => page.evaluate(() =>
    document.querySelector('.vp-terminal-follow')?.getAttribute('aria-pressed') === 'true');

const pressFollow = () => page.evaluate(() =>
    document.querySelector('.vp-terminal-follow')?.click());

const readout = () => page.evaluate(() =>
    document.querySelector('.vp-terminal-count')?.textContent.trim() ?? '');

const levelSwitches = () => page.evaluate(() =>
    [...document.querySelectorAll('.vp-terminal-level')].map(button => ({
        level: ['info', 'warning', 'error'].find(name => button.classList.contains(name)),
        on: button.getAttribute('aria-pressed') === 'true',
        count: Number(button.querySelector('.vp-terminal-level-count')?.textContent ?? '0'),
    })));

const clickLevel = level => page.evaluate(name => {
    document.querySelector(`.vp-terminal-level.${name}`)?.click();
}, level);

async function type(text) {
    await page.click('.vp-terminal-toolbar .vp-panel-filter input');
    await page.type('.vp-terminal-toolbar .vp-panel-filter input', text);
    await wait(400);
}

await boot();
check('the Terminal panel opens', await openPanel('Terminal'));
await page.waitForSelector('.vp-terminal-line', { timeout: 15000 });
await wait(1200);

console.log('\nThe output, and what each line said it was');
{
    const rows = await lines();
    report('lines captured', String(rows.length));
    check('the program\'s output arrives', rows.length > 8, String(rows.length));
    check('every line is stamped, without being asked',
        rows.every(row => /^\d\d:\d\d:\d\d\.\d\d\d$/.test(row.time)),
        JSON.stringify(rows.slice(0, 3).map(row => row.time)));

    const byText = text => rows.find(row => row.text.startsWith(text));
    const level = text => byText(text)?.level;
    check('a line that announced itself as a warning is marked as one',
        level('sprite queue') === 'warning', level('sprite queue'));
    check('and one that announced an error',
        level('MemoryPool') === 'error', level('MemoryPool'));
    check('and one that announced information',
        level('checkpoint') === 'info', level('checkpoint'));
    // a line that announced nothing is information, as a printf in a debug build is, not a fourth kind of line
    check('ordinary output is taken as information too',
        level('VIPManager') === 'info', level('VIPManager'));
    check('the padding a fixed-width screen put around a line is trimmed off',
        byText('VIPManager')?.text === 'VIPManager frame 1420',
        JSON.stringify(byText('VIPManager')?.text));
    const warned = rows.find(row => row.level === 'warning');
    check('the prefix is taken off the line, with the space behind it',
        warned?.text === 'sprite queue at 92%', JSON.stringify(warned?.text));
    check('and shown beside it as a badge', warned?.badge === 'Warning', warned?.badge);
    check('and wears the badge that says so',
        byText('VIPManager')?.badge === 'Info',
        JSON.stringify(byText('VIPManager')?.badge));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nThe level switches');
{
    const before = await levelSwitches();
    report('switches', JSON.stringify(before));
    check('there is one per kind of line the output carried',
        before.map(one => one.level).join(',') === 'info,warning,error',
        before.map(one => one.level).join(','));
    check('each counts its own lines', before.every(one => one.count > 0),
        JSON.stringify(before.map(one => one.count)));
    check('and they start on', before.every(one => one.on));

    await clickLevel('warning');
    await wait(600);
    check('switching warnings off takes them off screen',
        (await lines()).every(row => row.level !== 'warning'));
    check('and leaves everything else alone',
        (await lines()).some(row => row.level === 'error'));
    check('the switch still says how many there are, so they can be found again',
        (await levelSwitches()).find(one => one.level === 'warning')?.count > 0);

    await clickLevel('warning');
    await wait(600);
    check('switching them back on brings them back',
        (await lines()).some(row => row.level === 'warning'));
}

console.log('\nSearching');
{
    await type('collision');
    const rows = await lines();
    const hits = rows.filter(row => row.match);
    check('what was found is marked', hits.length > 0, String(hits.length));
    check('and the word itself is picked out of the line',
        hits.every(row => row.marks.length > 0 && row.marks.every(mark => mark.toLowerCase() === 'collision')),
        JSON.stringify(hits[0]?.marks));
    check('the rest is still there, stood back from',
        rows.some(row => !row.match && row.aside));
    check('the readout counts the matches against what is on screen',
        /^\d+ of \d+$/.test(await readout()), await readout());
    {
        const [found, total] = (await readout()).split(' of ').map(Number);
        check('and both figures are the ones on screen',
            found === hits.length && total === rows.length,
            `${found}/${total} against ${hits.length}/${rows.length}`);
    }

    await page.click('.vp-terminal-only-matches');
    await wait(600);
    const only = await lines();
    check('Only matches takes the rest away',
        only.length > 0 && only.every(row => row.match), String(only.length));
    check('the machine is still writing while it does',
        (await lines()).length > 0);

    await page.click('.vp-terminal-only-matches');
    await wait(400);
    check('and pressing it again gives the surroundings back',
        (await lines()).some(row => !row.match));

    await type('zzz-not-in-the-output');
    check('a search that finds nothing is marked in the box it was typed into',
        await page.$('.vp-terminal-toolbar .vp-panel-filter.missed') !== null);
    await page.click('.vp-terminal-toolbar .vp-panel-filter-clear');
    await wait(400);
    check('clearing the search brings everything back',
        (await lines()).every(row => !row.aside && !row.match));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nFollowing the output, and scrolling away from it');
{
    check('it starts at the end of the output, following', await following());
    const end = await view();
    check('and the view is at the end',
        end.height - end.top - end.box <= 8, JSON.stringify(end));

    await page.evaluate(() => {
        document.querySelector('.vp-terminal-lines').scrollTop = 0;
    });
    await wait(400);
    check('scrolling up stops it following', !(await following()));

    const parked = await view();
    // the panel re-renders once a second regardless of output, and this second used to drag the view back down
    await wait(2500);
    const still = await view();
    check('and the view stays where it was put, with output still arriving',
        Math.abs(still.top - parked.top) <= 2,
        `${parked.top} -> ${still.top}`);
    check('while the output went on being captured',
        still.height > parked.height, `${parked.height} -> ${still.height}`);

    await page.evaluate(() => {
        const scroller = document.querySelector('.vp-terminal-lines');
        scroller.scrollTop = scroller.scrollHeight;
    });
    await wait(500);
    check('scrolling back to the end follows again', await following());
    await wait(1500);
    const after = await view();
    check('and the new output keeps the view at the end',
        after.height - after.top - after.box <= 8, JSON.stringify(after));

    await pressFollow();
    await wait(300);
    check('the button turns following off', !(await following()));
    await page.evaluate(() => {
        document.querySelector('.vp-terminal-lines').scrollTop = 0;
    });
    await wait(300);
    await pressFollow();
    await wait(600);
    const jumped = await view();
    check('and turning it on jumps to the end',
        jumped.height - jumped.top - jumped.box <= 8, JSON.stringify(jumped));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nResetting the machine');
{
    // what is on screen is a finished run, so it goes. Checked by the clock: every line left must have been written
    // after the reset, which a panel merely trimming its oldest lines could not manage
    const before = await lines();
    const last = before[before.length - 1]?.time ?? '';
    report('lines before the reset', String(before.length));
    check('there is a run on screen to lose', before.length > 20, String(before.length));

    // through the control strip's Reset button, clicked in the page: the strip fades out when the pointer is
    // elsewhere, and puppeteer will not aim at a fading element
    await page.evaluate(() => document.querySelector('[data-control="reset"]')?.click());
    await wait(1500);

    const after = await lines();
    report('lines after it', String(after.length));
    check('the machine is printing again', after.length > 0, String(after.length));
    check('and nothing from before the reset is left',
        after.every(row => row.time >= last),
        `${after[0]?.time} against ${last}`);
    check('the level switches count the new run and not the old',
        (await levelSwitches()).every(one => one.count <= after.length),
        JSON.stringify(await levelSwitches()));
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

const toolbar = () => page.$('.vp-terminal-toolbar');
const clear = () => page.evaluate(() =>
    document.querySelector('.vp-terminal-clear')?.click());
const pause = () => page.evaluate(() =>
    document.querySelector('[data-control="pause"]')?.click());

console.log('\nClearing');
{
    // cleared, not stopped: the machine goes on writing, so checked by the clock as for a reset
    const before = await lines();
    const last = before[before.length - 1]?.time ?? '';
    await clear();
    await wait(1200);
    const after = await lines();
    check('Clear empties the panel, and capture carries on',
        after.length > 0 && after.length < before.length,
        `${before.length} -> ${after.length}`);
    check('and nothing from before it is left',
        after.every(row => row.time >= last), `${after[0]?.time} against ${last}`);

    // with the machine stopped there is no race with the next burst, the only way to see the panel actually empty
    await pause();
    await wait(800);
    await clear();
    await wait(400);
    check('the panel is empty with the machine stopped',
        (await lines()).length === 0, String((await lines()).length));
    check('and a panel with nothing in it shows no toolbar',
        await toolbar() === null);
    // by what it says rather than by class: the empty state is a styled component with a hashed class name
    check('and says instead that it is waiting for output',
        await page.evaluate(() => {
            const view = document.querySelector('.vp-terminal-lines');
            return view?.querySelector('.vp-terminal-line') === null
                && /Waiting for output/.test(view?.textContent ?? '');
        }));

    await pause();
    await wait(1200);
    check('the toolbar comes back with the output', await toolbar() !== null);
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

await finish();
