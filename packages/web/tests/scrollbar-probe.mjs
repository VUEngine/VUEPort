/**
 * Checks that Perfect Scrollbar is on the interface's scrolling containers and its two known faults stay gone: a native
 * scrollbar beside a rail, and a rail that only scrolls vertically over a table wider than its box. Measures the live
 * page, as both are computed styles or runtime classes. VueportScrollbars finds `vp-scroll` by watching the tree, so
 * this also covers containers React creates later.
 *
 * Usage: node tests/scrollbar-probe.mjs (after `yarn build`)
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

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    } else {
        console.log(`  ok   ${label}`);
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
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('/pvb/?featured')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    if (/api\.vueport\.net\/pvb\/[0-9a-f]{8}\//.test(url)) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ id: 1, title: 'Probe Game', hash: { crc32: '00000000' }, item: [] }),
        });
        return;
    }
    request.continue();
});

// overflow: hidden from the ps class is what removes the native scrollbar; a container with the class still
// computing to auto or scroll is the two-scrollbars fault, which never shows up in the markup
const survey = () => page.evaluate(() => {
    const attached = [...document.querySelectorAll('.ps')];
    const native = attached.filter(element => {
        const style = getComputedStyle(element);
        return [style.overflowX, style.overflowY].some(value => value === 'auto' || value === 'scroll');
    });
    const unpositioned = attached.filter(element => getComputedStyle(element).position === 'static');
    return {
        count: attached.length,
        // a container marked as scrolling that the installer never reached
        unattached: [...document.querySelectorAll('.vp-scroll')]
            .filter(element => !element.classList.contains('ps'))
            .map(element => element.className),
        // the class alone is not proof the library ran, it adds the rails
        railed: attached.filter(element => element.querySelector(':scope > .ps__rail-y')).length,
        native: native.map(element => element.className),
        unpositioned: unpositioned.map(element => element.className),
        classes: attached.map(element => element.className),
    };
});

await page.goto(origin, { waitUntil: 'networkidle0' });

section('The start page');
{
    const seen = await survey();
    // the start page's own scrolling surface. There are no recents on a first run, so this proves the app's
    // surfaces were included alongside the emulator's
    check('the start page\'s placeholder has a scrollbar of the library\'s',
        seen.classes.some(name => name.includes('vp-placeholder')), true);
    check('no container is left showing a native one too', seen.native, []);
    check('every marked container was reached', seen.unattached, []);
    check('every container is one the rails can be laid against', seen.unpositioned, []);
    check('loading the page reports no errors', errors, []);
}

section('With a ROM running');
{
    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await chooser.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const seen = await survey();
    // in Play mode the control strip is the one thing that scrolls, and it was created long after the page started,
    // the case the tree observer exists for
    check('the control strip was taken over as it appeared',
        seen.classes.some(name => name.includes('vp-strip')), true);
    check('and the library really attached, rails and all', seen.railed > 0, true);
    check('none of them kept a native scrollbar', seen.native, []);
    check('every marked container was reached', seen.unattached, []);
    check('none of them are unpositioned', seen.unpositioned, []);
    check('nothing errored while the panels appeared', errors, []);
}

section('Debug mode, where the panels are');
{
    await page.click('[data-control="mode"]');
    await page.waitForSelector('.vp-dock .vp-panel', { timeout: 10000 });
    await new Promise(resolve => setTimeout(resolve, 1500));

    const seen = await survey();
    check('every dock panel has a scrollbar of the library\'s',
        await page.evaluate(() => [...document.querySelectorAll('.vp-dock .vp-panel')]
            .every(element => element.classList.contains('ps'))), true);
    check('more than one panel is open', seen.classes.filter(name =>
        /(^|\s)vp-panel(\s|$)/.test(name)).length > 1, true);
    check('none of them kept a native scrollbar', seen.native, []);
    check('every marked container was reached', seen.unattached, []);
    check('none of them are unpositioned', seen.unpositioned, []);
    check('nothing errored in Debug mode', errors, []);
}

section('A table wider than its panel');
{
    // horizontal scrolling is what the last attempt took away; the VSU panel's table is the widest in the interface
    const wide = await page.evaluate(() => {
        const container = [...document.querySelectorAll('.ps')]
            .find(element => element.scrollWidth > element.clientWidth + 1);
        if (!container) {
            return { found: false };
        }
        const before = container.scrollLeft;
        container.scrollLeft = 40;
        return {
            found: true,
            // ps--active-x says the library will draw an x rail, which suppressScrollX would have prevented
            activeX: container.classList.contains('ps--active-x'),
            moved: container.scrollLeft > before,
        };
    });
    if (wide.found) {
        check('the library knows it scrolls sideways', wide.activeX, true);
        check('and it actually moves', wide.moved, true);
    } else {
        console.log('  --   nothing was wider than its box in this layout; skipped');
    }
}

section('A bordered container stops at the end of its content');
{
    // the rails sit in the container's padding box but are sized from its border box, so with a border the y rail hangs
    // past the content and grows scrollHeight on every measure: the panel scrolls two more pixels at each bottom.
    // Measured, as the rail's resolved length is what counts
    const trial = await page.evaluate(async () => {
        const settle = () => new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const run = async border => {
            const host = document.createElement('div');
            host.className = 'vp-scroll';
            host.style.cssText = 'position:absolute;left:0;top:0;height:200px;width:300px;'
                + `overflow:auto;border:${border}px solid red`;
            host.innerHTML = '<div style="height:900px;width:900px"></div>';
            document.body.appendChild(host);
            await settle();
            await settle();
            const heights = [];
            const widths = [];
            for (let i = 0; i < 5; i++) {
                host.scrollTop = host.scrollHeight;
                host.scrollLeft = host.scrollWidth;
                await settle();
                heights.push(host.scrollHeight);
                widths.push(host.scrollWidth);
            }
            host.remove();
            await settle();
            return { heights, widths };
        };
        return { plain: await run(0), bordered: await run(8) };
    });
    const steady = ({ heights, widths }) =>
        new Set([...heights, ...widths]).size === 1;
    check('a borderless container measures the same every time',
        steady(trial.plain), true);
    check('and so does one with a border', steady(trial.bordered), true);
    check('the border is not counted as content',
        trial.bordered.heights[0], trial.plain.heights[0]);
}

section('Nothing on the live page scrolls past its content');
{
    const growing = await page.evaluate(async () => {
        const settle = () => new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const grew = [];
        for (const element of document.querySelectorAll('.ps')) {
            const scrolls = element.scrollHeight > element.clientHeight + 1
                || element.scrollWidth > element.clientWidth + 1;
            if (!scrolls) {
                continue;
            }
            const before = [element.scrollHeight, element.scrollWidth];
            for (let i = 0; i < 4; i++) {
                element.scrollTop = element.scrollHeight;
                element.scrollLeft = element.scrollWidth;
                await settle();
            }
            if (element.scrollHeight !== before[0] || element.scrollWidth !== before[1]) {
                grew.push(element.className);
            }
        }
        return grew;
    });
    check('no container grew as it was scrolled to its end', growing, []);
}

section('Closing a panel takes its scrollbar with it');
{
    const leaked = await page.evaluate(() => {
        const before = document.querySelectorAll('.ps').length;
        const host = document.createElement('div');
        host.className = 'vp-panel vp-scroll';
        host.style.cssText = 'height:40px;width:200px';
        host.innerHTML = '<div style="height:400px"></div>';
        document.body.appendChild(host);
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
            const attached = host.classList.contains('ps');
            host.remove();
            requestAnimationFrame(() => requestAnimationFrame(() =>
                resolve({ attached, before, after: document.querySelectorAll('.ps').length })));
        })));
    });
    check('a container added later is taken over', leaked.attached, true);
    check('and removing it leaves nothing behind', leaked.after, leaked.before);
    check('nothing errored throughout', errors, []);
}

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
