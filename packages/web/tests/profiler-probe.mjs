/**
 * Does the CPU Profiler panel profile the machine it is docked next to, and stop when put away? Core's
 * live-profile-probe.mjs proves the arithmetic; this checks that the panel switches profiling on when it appears, that
 * figures keep coming, and that closing it switches profiling off, which the feature's cost rests on. The ROM loops
 * calling a subroutine a few thousand times a frame, so there is a real call to find.
 *
 * Usage: node tests/profiler-probe.mjs (after `yarn build`)
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

/**
 * A ROM with a call in it, the core probe's program with a header so the app will load it:
 *   main:  jal work
 *          movea 1, r0, r14
 *          br main
 *   work:  movea 1, r0, r10
 *          movea 2, r0, r11
 *          movea 3, r0, r12
 *          jmp [r31]
 */
const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'profiler.vb');
const PROGRAM = 0xffffffc0;
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT PROFILE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRF', header + 27, 'ascii');
    rom[header + 31] = 3;

    let cursor = rom.length - 0x40;
    const addressOf = () => (PROGRAM + (cursor - (rom.length - 0x40))) >>> 0;
    const half = value => {
        rom.writeUInt16LE(value & 0xffff, cursor);
        cursor += 2;
    };
    const movea = (imm, source, destination) => {
        half((0x28 << 10) | (destination << 5) | source);
        half(imm);
    };
    // format IV: a 26-bit displacement across both halfwords
    const jump = (opcode, from, to) => {
        const displacement = (to - from) | 0;
        half((opcode << 10) | ((displacement >> 16) & 0x3ff));
        half(displacement & 0xffff);
    };

    const main = addressOf();
    const jalAt = cursor;
    cursor += 4;
    movea(0x0001, 0, 14);
    const branchAt = addressOf();
    half(0x8a00 | ((main - branchAt) & 0x1ff));
    cursor += 2;

    const work = addressOf();
    movea(0x0001, 0, 10);
    movea(0x0002, 0, 11);
    movea(0x0003, 0, 12);
    half((0x06 << 10) | 31); // jmp [r31]

    cursor = jalAt;
    jump(0x2b, main, work);
    cursor = rom.length - 0x10;
    jump(0x2a, PROGRAM + 0x30, main); // jr main, from the reset vector
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
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
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

const survey = () => page.evaluate(() => {
    const text = selector => document.querySelector(selector)?.textContent?.trim() ?? '';
    const cells = row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim());
    const window = text('.vp-profiler-window');
    return {
        headline: text('.vp-profiler-headline strong'),
        detail: text('.vp-profiler-headline .hint, .vp-profiler-overran'),
        window,
        frames: Number.parseInt((/([\d,]+) frames/.exec(window)?.[1] ?? '').replace(/,/g, ''), 10),
        axis: text('.vp-profiler-axis'),
        title: text('.vp-profiler-tree-title'),
        // one bar per frame of the window, and one of them pinned at most
        bars: document.querySelectorAll('.vp-profiler-frame').length,
        pinned: document.querySelectorAll('.vp-profiler-frame.pinned').length,
        // sections carry the sum of what is folded under them, the other rows are the functions themselves
        sections: [...document.querySelectorAll('.vp-profiler-table tbody tr.vp-profiler-section')]
            .map(row => [row.querySelector('.vp-profiler-toggle span')?.textContent?.trim() ?? '',
                ...cells(row).slice(1)]),
        rows: [...document.querySelectorAll(
            '.vp-profiler-table tbody tr:not(.vp-profiler-section)'
        )].map(cells),
        movers: text('.vp-profiler-movers'),
    };
});

async function openProfiler() {
    await page.click('.lm-TabBar-addButton');
    await page.waitForSelector('.vp-pick-filter', { timeout: 5000 });
    await page.type('.vp-pick-filter', 'CPU Profiler');
    await wait(300);
    await page.keyboard.press('Enter');
    return page.waitForSelector('.vp-profiler', { timeout: 10000 })
        .then(() => true).catch(() => false);
}

async function finish() {
    await browser.close();
    server.close();
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await wait(2000);

console.log('\nOpening the panel');
await page.click('[data-control="mode"]');
await page.waitForSelector('.vp-dock .vp-panel', { timeout: 10000 });
await wait(800);

const appeared = await openProfiler();
check('the picker offers it and it opens', appeared);
if (!appeared) {
    await finish();
}

// two seconds is a hundred frames, the whole window
await wait(2200);

console.log('\nWhat it found');
{
    const seen = await survey();
    report('headline', `${seen.headline} ${seen.detail}`);
    report('window', seen.window);
    report('axis', seen.axis);
    report('sections', JSON.stringify(seen.sections));
    report('functions', JSON.stringify(seen.rows.slice(0, 4)));

    const busy = Number.parseFloat(seen.headline);
    check('a share of the frame is reported', Number.isFinite(busy), seen.headline);
    // this ROM never halts, so every clock of every frame is work; far below a full frame would mean missing clocks
    check('a machine that never halts reads as busy', busy > 95 && busy <= 101, seen.headline);
    check('the headline says which frame it is about', /frame [\d,]+/.test(seen.detail), seen.detail);
    check('the window filled up', seen.frames === 100, seen.window);
    check('there is a bar for every frame of the window', seen.bars === 100, `${seen.bars} bar(s)`);
    check('and the axis says what the line across them is',
        /20\.0 ms/.test(seen.axis), seen.axis);
    check('there is a section to open', seen.sections.length >= 1,
        JSON.stringify(seen.sections));
    check('there is more than one row to see', seen.rows.length >= 2, `${seen.rows.length} row(s)`);

    // the row for work, the one that was called. The other is the frame the profiler started inside, with no calls
    const called = seen.rows.filter(row => row[5] !== '' && row[5] !== '0');
    check('the called subroutine was entered thousands of times a frame',
        called.some(row => Number.parseInt(row[5].replace(/,/g, ''), 10) > 1000),
        JSON.stringify(called.map(row => row[5])));
    check('and it says what one call costs',
        called.some(row => /µs/.test(row[6])), JSON.stringify(called.map(row => row[6])));
    check('the rows come to about a whole frame between them',
        Math.abs(seen.rows.reduce((sum, row) => sum + Number.parseFloat(row[1]), 0) - 100) < 1.5,
        JSON.stringify(seen.rows.map(row => row[1])));
}

console.log('\nA steady machine reads steady');
{
    const before = await survey();
    await wait(1200);
    const after = await survey();
    // the same work every frame, so a figure that moved would be measurement noise, which an exact profile does not
    // have
    check('the same work reports the same figures',
        before.headline === after.headline
        && before.rows[0]?.[1] === after.rows[0]?.[1],
        `${before.headline} ${before.rows[0]?.[1]} then ${after.headline} ${after.rows[0]?.[1]}`);
    check('nothing errored while it ran', errors.length === 0, errors.join(' | '));
}

console.log('\nThe function filter');
{
    const before = await survey();
    // no symbols, so the names are addresses, still a name to filter on and one guaranteed not to match every row
    const wanted = before.rows.find(row => row[0] && row[0] !== '')?.[0] ?? '';
    report('filtering on', wanted);

    await page.type('.vp-profiler-tree-head .vp-panel-filter input', wanted);
    await wait(400);
    const narrowed = await survey();
    check('the filter box is there and narrows the list',
        narrowed.rows.length > 0 && narrowed.rows.length < before.rows.length,
        `${before.rows.length} row(s) then ${narrowed.rows.length}`);
    check('and every row left is one that matches',
        narrowed.rows.every(row => row[0].includes(wanted)),
        JSON.stringify(narrowed.rows.map(row => row[0])));

    await page.click('.vp-profiler-tree-head .vp-panel-filter input', { clickCount: 3 });
    await page.keyboard.type('nosuchfunction');
    await wait(400);
    const empty = await survey();
    check('a filter that matches nothing empties the table',
        empty.rows.length === 0, `${empty.rows.length} row(s)`);
    check('and says so', await page.evaluate(() =>
        /No function matches/.test(
            document.querySelector('.vp-profiler-rows')?.textContent ?? '')));

    await page.click('.vp-profiler-tree-head .vp-panel-filter-clear');
    await wait(400);
    const restored = await survey();
    check('clearing it brings the rows back',
        restored.rows.length === before.rows.length,
        `${restored.rows.length} of ${before.rows.length}`);
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

// a bad frame is one bar, and clicking it is the only way to ask what was in a frame that has gone. The panel keeps
// what it was given, so the answer has to outlive the window the frame came from

console.log('\nPinning a frame');
{
    const live = await survey();
    check('the table is about the last frame until one is pinned',
        /last frame/i.test(live.title) && live.pinned === 0, live.title);

    const bars = await page.$$('.vp-profiler-frame');
    await bars[bars.length - 1].click();
    await wait(700);
    const pinned = await survey();
    report('pinned', pinned.title);
    check('clicking a frame pins it',
        /Frame [\d,]+/.test(pinned.title) && pinned.pinned === 1, pinned.title);
    check('and the column of figures says which frame it is', await page.evaluate(() =>
        /Frame/.test(document.querySelectorAll('.vp-profiler-table th')[1]?.textContent ?? '')));
    check('there are still rows under it', pinned.rows.length >= 2, `${pinned.rows.length} row(s)`);

    // two seconds is the whole window, so the pinned frame has left it by now
    await wait(2500);
    const kept = await survey();
    check('the pinned frame outlives the window it came from',
        kept.title === pinned.title && kept.rows.length >= 2,
        `${kept.title}, ${kept.rows.length} row(s)`);
    check('its bar has scrolled off the end', kept.pinned === 0, `${kept.pinned} pinned bar(s)`);
    check('and the window behind it went on filling', kept.frames === 100, kept.window);

    await page.click('.vp-profiler-unpin');
    await wait(600);
    const back = await survey();
    check('unpinning goes back to the live figures', /last frame/i.test(back.title), back.title);
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nSections fold');
{
    const open = await survey();
    await page.click('.vp-profiler-section .vp-profiler-toggle');
    await wait(400);
    const shut = await survey();
    check('closing a section takes its functions out of the table',
        shut.rows.length < open.rows.length,
        `${open.rows.length} row(s) then ${shut.rows.length}`);
    // the section is an aggregate of its own, so folding the functions away leaves a row with the section's cost
    check('and leaves the section itself, figures and all',
        shut.sections.length === open.sections.length && /%/.test(shut.sections[0]?.[1] ?? ''),
        JSON.stringify(shut.sections));

    await page.click('.vp-profiler-section .vp-profiler-toggle');
    await wait(400);
    const again = await survey();
    check('opening it brings them back', again.rows.length === open.rows.length,
        `${again.rows.length} of ${open.rows.length}`);
}

console.log('\nA baseline to compare against');
{
    check('there is nothing to compare against yet', (await survey()).movers === '');
    await page.click('.vp-profiler-baseline .vp-button');
    await wait(700);
    const saved = await survey();
    report('vs baseline', saved.movers);
    check('saving one gives the figures something to be measured against',
        /vs baseline/.test(saved.movers), saved.movers);
    // the same work every frame: a baseline that claimed a change would be measuring its own noise
    check('and a machine doing the same work reads as unchanged',
        /busy [+−]?0\.0pp/.test(saved.movers), saved.movers);

    await page.click('.vp-profiler-baseline-clear');
    await wait(400);
    check('and it can be forgotten again', (await survey()).movers === '');
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

console.log('\nClosing it switches profiling off');
{
    // the profiler is stopped and thrown away with the panel, so a panel opened again starts from an empty window,
    // the observable half of "nothing is profiled in between"
    let closed = false;
    for (const tab of await page.$$('.lm-TabBar-tab')) {
        const label = await tab.evaluate(node => node.textContent ?? '');
        if (!/profiler/i.test(label)) {
            continue;
        }
        const close = await tab.$('.lm-TabBar-tabCloseIcon');
        if (close) {
            await close.click();
            closed = true;
        }
        break;
    }
    await wait(1200);
    check('the tab closes', closed && await page.$('.vp-profiler') === null);

    await openProfiler();
    await wait(500);
    const fresh = await survey();
    report('window on reopening', fresh.window);
    check('it starts from an empty window rather than the old one',
        fresh.frames < 100, fresh.window);
    check('and the timeline is as short as the window is',
        fresh.bars === fresh.frames, `${fresh.bars} bar(s) for ${fresh.frames} frame(s)`);

    // and it fills again, the liveness check the steady figures above cannot be
    await wait(1500);
    const filling = await survey();
    report('window a moment later', filling.window);
    check('and fills as the machine runs on', filling.frames > fresh.frames,
        `${fresh.frames} then ${filling.frames}`);
    check('nothing errored throughout', errors.length === 0, errors.join(' | '));
}

await finish();
