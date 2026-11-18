/**
 * Export PNG in the BGMaps, Worlds and Objects panels, in a browser. The cartridge draws character 5 at BGMap 0 cell
 * 2,1, shown by world 31, and as objects 10 and 11 (one figure, the second two rows lower) in world 30. Each button has
 * to hand over a PNG of the right name and size, drawn as the panel draws it:
 *
 *  - BGMaps: the segment, 512 square, with the character where the cell is
 *  - Worlds: the selected world alone, even In Context, cut to its own 64x32 rectangle though it sits at 10,5, and
 *    see-through where it draws nothing
 *  - Objects: the selected object's figure cut to its rectangle, see-through where neither object draws, and no button
 *    for an object that is not part of a figure
 *
 * Usage: node tests/vip-export-probe.mjs (after `yarn build`)
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
const { assemble } = require('vueport-core/lib/probe/vb-asm');

let failures = 0;
function check(label, ok, detail) {
    if (!ok) {
        failures++;
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
}
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

function sceneWrites() {
    const writes = [];
    const halfwords = (address, values) => values.forEach((value, i) => writes.push([address + i * 2, value & 0xffff]));
    halfwords(0x0005f824, [32, 64, 32]);     // BRTA, BRTB, BRTC
    halfwords(0x0005f860, [0xe4]);           // GPLT0
    halfwords(0x0005f86a, [0xe4]);           // JPLT1
    for (let row = 0; row < 8; row++) {
        let bits = 0;
        for (let x = 0; x < 8; x++) {
            bits |= (row === 2 && x === 3 ? 2 : 1) << (x * 2);
        }
        halfwords(0x00006000 + 5 * 16 + row * 2, [bits]);
    }
    halfwords(0x00020000 + (1 * 64 + 2) * 2, [5]);
    halfwords(0x0003d800 + 31 * 32, [0xc000, 10, 0, 5, 0, 0, 0, 63, 31, 0, 0]);
    halfwords(0x0003d800 + 30 * 32, [0xc000 | 3 << 12]);
    halfwords(0x0005f84c, [9, 11]);          // SPT2, SPT3: group 3 is objects 10 and 11
    halfwords(0x0003e000 + 10 * 8, [100, 0xc000, 50, 1 << 14 | 5]);
    halfwords(0x0003e000 + 11 * 8, [108, 0xc000, 52, 1 << 14 | 5]);
    halfwords(0x0003d800 + 29 * 32, [0x0040]);   // END
    halfwords(0x0005f822, [0x0302]);         // DPCTRL: DISP, RE, SYNCE
    halfwords(0x0005f842, [0x0002]);         // XPCTRL: XPEN
    return writes;
}

function buildRom() {
    const size = 0x10000;
    const rom = new Uint8Array(size);
    const writes = sceneWrites();
    const program = `
        start:  movhi hi(table), r0, r10
                movea lo(table), r10, r10
                movea ${writes.length}, r0, r11
        loop:   ld.w 0[r10], r12
                ld.w 4[r10], r13
                st.h r13, 0[r12]
                add 8, r10
                add -1, r11
                bne loop
        spin:   br spin
        table:  ${writes.map(([address, value]) => `.word 0x${address.toString(16)}, 0x${value.toString(16)}`).join('\n')}
    `;
    rom.set(assemble(program, 0xfffff000).bytes, size - 0x1000);
    rom.set(assemble('jr 0xfffff000', 0xfffffff0).bytes, size - 0x10);
    const header = size - 544;
    const ascii = (text, offset) => {
        for (let i = 0; i < text.length; i += 1) {
            rom[offset + i] = text.charCodeAt(i);
        }
    };
    ascii('VUEPORT EXPORT'.padEnd(20, ' '), header);
    ascii('VU', header + 25);
    ascii('VEXP', header + 27);
    rom[header + 31] = 1;
    return rom;
}

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'export.vb');
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
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] });
    // a download is an anchor clicked with download set: kept here, by name, instead of leaving the page
    window.__downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
            window.__downloads.push({ name: this.download, url: this.href });
            return;
        }
        click.call(this);
    };
});

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
    await page.evaluate(() => {
        const settings = JSON.parse(window.localStorage.getItem('vueport.settings') ?? '{}');
        window.localStorage.setItem('vueport.settings', JSON.stringify({ ...settings, columnTable: false, mirrorSpinUp: false, frameBlending: 'off' }));
    });
    await page.reload({ waitUntil: 'networkidle0' });
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
    await wait(1200);
    return page.evaluate(wanted => {
        const panel = document.querySelector(`.vp-columns[aria-label="${wanted}"]`);
        return !!panel && panel.offsetParent !== null;
    }, name);
}

// looked for in that panel alone, as the Characters panel beside it has an Export PNG of its own
const findButton = (panel, label) => page.evaluate((root, wanted) => {
    const button = [...document.querySelectorAll(`.vp-columns[aria-label="${root}"] button`)]
        .find(candidate => candidate.textContent.trim() === wanted);
    return button ? { enabled: !button.disabled, title: button.title } : undefined;
}, panel, label);

const pressButton = (panel, label) => page.evaluate((root, wanted) => {
    const button = [...document.querySelectorAll(`.vp-columns[aria-label="${root}"] button`)]
        .find(candidate => candidate.textContent.trim() === wanted);
    button?.click();
    return !!button;
}, panel, label);

async function exported(panel, label, points) {
    const before = await page.evaluate(() => window.__downloads.length);
    if (!await pressButton(panel, label)) {
        return undefined;
    }
    for (let i = 0; i < 20 && await page.evaluate(() => window.__downloads.length) === before; i++) {
        await wait(100);
    }
    return page.evaluate(async (index, wanted) => {
        const download = window.__downloads[index];
        if (!download) {
            return undefined;
        }
        const blob = await (await fetch(download.url)).blob();
        const magic = [...new Uint8Array(await blob.slice(0, 4).arrayBuffer())];
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return {
            name: download.name,
            png: magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47,
            width: bitmap.width,
            height: bitmap.height,
            at: wanted.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]),
        };
    }, before, points);
}

const lit = rgba => rgba[0] > 0 && rgba[3] === 255;
const black = rgba => rgba[0] === 0 && rgba[1] === 0 && rgba[2] === 0 && rgba[3] === 255;

await boot();

console.log('\nBGMaps');
check('the panel opens', await openPanel('BGMaps'));
let file = await exported('BGMaps', 'Export PNG', [[16, 8], [23, 15], [0, 0], [24, 8]]);
check('Export PNG hands over a file', file !== undefined);
check('... a PNG', file?.png, JSON.stringify(file));
check('... named for the segment', file?.name.endsWith('-bgmap-0.png'), file?.name);
check('... the whole segment, 512 square', file?.width === 512 && file?.height === 512, `${file?.width}x${file?.height}`);
check('... with the character at cell 2,1', lit(file?.at[0] ?? []) && lit(file?.at[1] ?? []), JSON.stringify(file?.at));
check('... and nothing around it', black(file?.at[2] ?? []) && black(file?.at[3] ?? []), JSON.stringify(file?.at));

console.log('\nWorlds');
check('the panel opens', await openPanel('Worlds'));
check('the preview is In Context', await page.evaluate(() =>
    [...document.querySelectorAll('.vp-columns[aria-label="Worlds"] .vp-radio-option')]
        .some(option => option.textContent.trim() === 'In Context' && option.matches('.selected, [aria-checked="true"]'))));
file = await exported('Worlds', 'Export PNG', [[16, 8], [23, 15], [0, 0], [63, 31]]);
check('Export PNG hands over a file', file !== undefined);
check('... a PNG', file?.png, JSON.stringify(file));
check('... named for the world and eye', file?.name.endsWith('-world-31-left.png'), file?.name);
check('... cut to the world, 64 by 32', file?.width === 64 && file?.height === 32, `${file?.width}x${file?.height}`);
check('... with the character at its map\'s cell 2,1', lit(file?.at[0] ?? []) && lit(file?.at[1] ?? []), JSON.stringify(file?.at));
check('... and see-through where it draws nothing', file?.at[2]?.[3] === 0 && file?.at[3]?.[3] === 0, JSON.stringify(file?.at));

console.log('\nObjects');
check('the panel opens', await openPanel('Objects'));
let button = await findButton('Objects', 'Export Figure');
check('Export Figure is there', button !== undefined);
check('... but not for an object outside any figure', button && !button.enabled, JSON.stringify(button));
const picked = await page.evaluate(() => {
    const tile = [...document.querySelectorAll('.vp-columns[aria-label="Objects"] .vp-tile')]
        .find(candidate => candidate.querySelector('.vp-tile-index')?.textContent.trim() === '10');
    tile?.click();
    return !!tile;
});
check('object 10 can be picked', picked);
await wait(800);
button = await findButton('Objects', 'Export Figure');
check('... and then the button can be pressed', button?.enabled, JSON.stringify(button));
file = await exported('Objects', 'Export Figure', [[0, 0], [15, 9], [0, 9], [15, 0]]);
check('Export Figure hands over a file', file !== undefined);
check('... a PNG', file?.png, JSON.stringify(file));
check('... named for its objects and eye', file?.name.endsWith('-figure-10-11-left.png'), file?.name);
check('... cut to the figure, 16 by 10', file?.width === 16 && file?.height === 10, `${file?.width}x${file?.height}`);
check('... drawn where the objects are', lit(file?.at[0] ?? []) && lit(file?.at[1] ?? []), JSON.stringify(file?.at));
check('... and see-through where neither is', file?.at[2]?.[3] === 0 && file?.at[3]?.[3] === 0, JSON.stringify(file?.at));

await page.screenshot({ path: path.join(scratch, 'objects.png') });
console.log(`  --   screenshot: ${path.join(scratch, 'objects.png')}`);

check('no errors on the page', errors.length === 0, errors.join(' | '));
await finish();
