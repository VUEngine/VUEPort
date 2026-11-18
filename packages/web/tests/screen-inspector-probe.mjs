/**
 * The screen inspector in a browser. The cartridge draws a known scene (as core's probe-frame-probe.mjs, written by its
 * own code here) and the inspector has to say what drew each pixel:
 *  - only in Debug mode: no tools over the picture in Play mode;
 *  - picking: the card under the pointer names the cell, the character and its pixel, and an object as an object;
 *  - pinned, a link opens the panel that shows it, with it selected;
 *  - a view washes over the picture; a panel's tile lights its pixels;
 *  - leaving Debug mode takes all of it away.
 *
 * Usage: node tests/screen-inspector-probe.mjs (after `yarn build`)
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

// character 5 all value 1 but pixel 3,2, which is 2; placed at BGMap 0 cell 2,1 in world 31, and as object 10 at
// 100,50 in world 30. Display and drawing on, brightness up
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
    halfwords(0x0003d800 + 31 * 32, [0xc000, 0, 0, 0, 0, 0, 0, 383, 223, 0, 0]);
    halfwords(0x0003d800 + 30 * 32, [0xc000 | 3 << 12]);
    halfwords(0x0005f84c, [9, 11]);          // SPT2, SPT3: group 3 is objects 10 and 11
    halfwords(0x0003e000 + 10 * 8, [100, 0xc000, 50, 1 << 14 | 5]);
    halfwords(0x0003e000 + 11 * 8, [0, 0xc000, 150, 1 << 14 | 5]);   // moved along by the program
    halfwords(0x0003d800 + 29 * 32, [0x0040]);   // END
    halfwords(0x0005f822, [0x0302]);         // DPCTRL: DISP, RE, SYNCE
    halfwords(0x0005f842, [0x0002]);         // XPCTRL: XPEN
    return writes;
}

// the spin loop's store, which keeps writing cell 2,1 of BGMap 0
let store;

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
                movhi hi(0x20084), r0, r15
                movea lo(0x20084), r15, r15
                movea 5, r0, r14
                movhi hi(0x3e058), r0, r16
                movea lo(0x3e058), r16, r16
                mov r0, r17
        spin:   st.h r14, 0[r15]
                add 1, r17
                andi 0xff, r17, r18
                st.h r18, 0[r16]
                movea 3000, r0, r19
        delay:  add -1, r19
                bne delay
                br spin
        table:  ${writes.map(([address, value]) => `.word 0x${address.toString(16)}, 0x${value.toString(16)}`).join('\n')}
    `;
    const assembled = assemble(program, 0xfffff000);
    store = assembled.lines.find(line => line.source.includes('st.h r14'))?.address;
    rom.set(assembled.bytes, size - 0x1000);
    rom.set(assemble('jr 0xfffff000', 0xfffffff0).bytes, size - 0x10);
    const header = size - 544;
    const ascii = (text, offset) => {
        for (let i = 0; i < text.length; i += 1) {
            rom[offset + i] = text.charCodeAt(i);
        }
    };
    ascii('VUEPORT INSPECTOR'.padEnd(20, ' '), header);
    ascii('VU', header + 25);
    ascii('VINS', header + 27);
    rom[header + 31] = 1;
    return rom;
}

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'inspector.vb');
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
// the labels below are the English ones, whatever language this machine speaks
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] });
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

const debugging = () => page.$('.vp-dock .vp-panel').then(panel => panel !== null);

async function boot() {
    await page.goto(origin, { waitUntil: 'networkidle0' });
    // even columns (columnTable, mirrorSpinUp off), as this cartridge writes no column table and the display unit's
    // geometry would squeeze the picture out of line with the frame buffers; no frame blending, which shows a moving
    // object twice
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
}

async function setDebugging(on) {
    if (await debugging() !== on) {
        await page.click('[data-control="mode"]');
        await wait(800);
    }
}

// a left-eye pixel's position on the page, in the default one-eye mode
async function pagePoint(x, y) {
    return page.$eval('.vp-screen-overlay', (canvas, point) => {
        const box = canvas.getBoundingClientRect();
        return {
            x: box.left + (point.x + 0.5) * box.width / canvas.width,
            y: box.top + (point.y + 0.5) * box.height / canvas.height,
        };
    }, { x, y });
}

async function hover(x, y) {
    const point = await pagePoint(x, y);
    await page.mouse.move(point.x, point.y);
    await wait(400);
}

const cardText = () => page.$eval('.vp-screen-inspector-card', card => card.textContent).catch(() => '');

// as RGBA
const overlayAt = (x, y) => page.$eval('.vp-screen-overlay', (canvas, point) =>
    [...canvas.getContext('2d').getImageData(point.x, point.y, 1, 1).data], { x, y });

async function wakeTools() {
    const box = await page.$eval('.vp-screen-panel', panel => {
        const rect = panel.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.move(box.x + 3, box.y + 3);
    await wait(300);
}

const button = async label => {
    await wakeTools();
    return page.$(`.vp-screen-inspector-bar button[aria-label="${label}"]`);
};
const toolsIdle = () => page.$('.vp-screen-inspector.idle').then(node => node !== null);
const leavePanel = async () => {
    await page.mouse.move(2, 2);
    await wait(400);
};

await boot();

console.log('\nOnly in Debug mode');
await setDebugging(false);
check('no inspector over the picture in Play mode', await page.$('.vp-screen-inspector-bar') === null);
await setDebugging(true);
check('there is one in Debug mode', await page.$('.vp-screen-inspector-bar') !== null);

console.log('\nComing and going');
await leavePanel();
check('the tools are out of sight with the pointer elsewhere', await toolsIdle());
await wakeTools();
check('moving over the screen brings them up', !await toolsIdle());
await leavePanel();
check('leaving takes them away again', await toolsIdle());
await (await button('Keep the controls on screen')).click();
await leavePanel();
check('pinned, they stay', !await toolsIdle());
await (await button('Let the controls hide again')).click();
await leavePanel();
check('unpinned, they go', await toolsIdle());
await (await button('Color by World')).click();
await leavePanel();
check('a view that is on keeps them up', !await toolsIdle());
const worldLegend = await page.$eval('.vp-screen-inspector-legend', legend => legend.textContent).catch(() => '');
check('its legend names the worlds on the picture', worldLegend.includes('World 31') && worldLegend.includes('World 30'), worldLegend);
await (await button('Color by World')).click();
await leavePanel();

console.log('\nPicking');
await (await button('Inspect Pixels')).click();
await wait(300);
await hover(19, 10);
let text = await cardText();
check('a cell, by its map and place', text.includes('BGMap 0 · Cell 2, 1'), text);
check('... its character and which pixel of it', text.includes('5 · pixel 3, 2 · value 2'), text);
check('... in its world', text.includes('World31'), text);
check('the cell\'s pixels are lit', (await overlayAt(20, 12))[1] === 255, String(await overlayAt(20, 12)));
await hover(103, 52);
text = await cardText();
check('an object as an object', text.includes('Object 10') && text.includes('JPLT1'), text);
await hover(300, 200);
text = await cardText();
check('the backdrop', text.includes('Backdrop'), text);

console.log('\nPinned');
await hover(103, 52);
const objectPoint = await pagePoint(103, 52);
await page.mouse.click(objectPoint.x, objectPoint.y);
await wait(300);
check('a click pins the card', await page.$('.vp-screen-inspector-card.pinned') !== null);
const opened = await page.evaluate(() => {
    for (const link of document.querySelectorAll('.vp-screen-inspector-link')) {
        if (link.textContent.trim() === 'Object') {
            link.click();
            return true;
        }
    }
    return false;
});
check('it offers the object', opened);
await wait(1000);
const selected = await page.$eval('.vp-tile.selected .vp-tile-index', tile => tile.textContent).catch(() => undefined);
check('which opens the Objects panel on object 10', selected === '10', selected);
await page.keyboard.press('Escape');
await wait(200);
check('Escape lets go of the card', await page.$('.vp-screen-inspector-card.pinned') === null);
await (await button('Inspect Pixels')).click();
await wait(300);

console.log('\nA panel lights what it points at');
const tile = await page.$('.vp-tile.selected');
await tile?.hover();
await wait(500);
check('the object\'s pixels, lit', (await overlayAt(104, 53))[1] === 255, String(await overlayAt(104, 53)));
check('the rest of the picture pushed back', (await overlayAt(19, 10))[3] > 0 && (await overlayAt(19, 10))[1] !== 255);
await page.mouse.move(5, 5);
await wait(400);

console.log('\nViews');
await (await button('Color by Kind')).click();
await wait(500);
check('Color by Kind washes the picture over', (await overlayAt(19, 10))[3] > 0);
check('... with a legend', await page.$('.vp-screen-inspector-legend') !== null);
const cell = await overlayAt(19, 10);
const object = await overlayAt(103, 52);
check('... a cell another color than an object', cell.join() !== object.join(), `${cell} / ${object}`);
await page.screenshot({ path: path.join(scratch, 'kinds.png') });
console.log(`  --   screenshot: ${path.join(scratch, 'kinds.png')}`);
await (await button('Color by Kind')).click();
await wait(300);
check('pressed again, the picture is plain', (await overlayAt(19, 10))[3] === 0);

console.log('\nIn step with the picture');
// object 11 crosses the screen on row 150 while the game runs; stopped, the mark has to be where the picture has it
await (await button('Color by Kind')).click();
await wait(1500);
await wakeTools();
await page.click('.vp-strip-layer [data-control="pause"]');
await wait(800);
const row = 152;
const lit = await page.$eval('.vp-screen-overlay', (canvas, y) => {
    const data = canvas.getContext('2d').getImageData(0, y, canvas.width, 1).data;
    return [...Array(canvas.width).keys()].filter(x => data[x * 4 + 3] > 0 && data[x * 4] === 255 && data[x * 4 + 1] === 170);
}, row);
const hideOver = hidden => page.evaluate(value => {
    for (const node of document.querySelectorAll('.vp-screen-overlay, .vp-screen-tools, .vp-strip-layer, .vp-screen-badges, .vp-screen-state-badges')) {
        node.style.visibility = value ? 'hidden' : '';
    }
}, hidden);
await hideOver(true);
const clip = await page.$eval('.vp-screen-overlay', canvas => {
    const box = canvas.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
});
const picture = await page.screenshot({ clip, encoding: 'base64' });
await hideOver(false);
await writeFile(path.join(scratch, 'picture.png'), Buffer.from(picture, 'base64'));
const drawn = await page.evaluate(async (data, y) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 224;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, 384, 224);
    const pixels = context.getImageData(0, y, 384, 1).data;
    return [...Array(384).keys()].filter(x => pixels[x * 4] > 20);
}, picture, row);
check('the moving object is there to compare', lit.length > 0 && drawn.length > 0, `${lit} / ${drawn}`);
check('marked exactly where the picture shows it', lit.join() === drawn.join(), `marked ${lit} / drawn ${drawn}`);
await page.click('.vp-strip-layer [data-control="pause"]');
await (await button('Color by Kind')).click();
await wait(300);

console.log('\nWho wrote this');
await (await button('Inspect Pixels')).click();
await wait(300);
await hover(19, 10);
const cellPoint = await pagePoint(19, 10);
await page.mouse.click(cellPoint.x, cellPoint.y);
await wait(300);
const armed = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.vp-screen-inspector-card.pinned .vp-screen-inspector-links')];
    for (const link of links[1]?.querySelectorAll('.vp-screen-inspector-link') ?? []) {
        if (link.textContent.trim() === 'Cell') {
            link.click();
            return true;
        }
    }
    return false;
});
check('a pinned card offers to stop at the next write to the cell', armed);
await wait(1500);
const note = await page.$eval('.vp-screen-inspector-note', node => node.textContent).catch(() => '');
check('the write is caught', note.includes('BGMap 0 cell 2, 1 was written'), note);
check('... by the store that made it', note.includes(`0x${store.toString(16).toUpperCase().padStart(8, '0')}`), `${note} / ${store?.toString(16)}`);
check('... with what it wrote', note.includes('0x0005'), note);
const shown = await page.$eval('.vp-disassembly .selected, .vp-disassembly [aria-selected="true"]', row => row.textContent)
    .catch(() => undefined);
check('the Disassembly shows it', shown?.toUpperCase().includes(store.toString(16).toUpperCase()), shown);
await page.screenshot({ path: path.join(scratch, 'caught.png') });
console.log(`  --   screenshot: ${path.join(scratch, 'caught.png')}`);
await (await button('Inspect Pixels')).click();
await wait(300);

console.log('\nLeaving Debug mode');
await (await button('Color by World')).click();
await wait(300);
await setDebugging(false);
check('the inspector goes', await page.$('.vp-screen-inspector-bar') === null);
check('and its wash with it', (await overlayAt(19, 10))[3] === 0);

check('no errors on the page', errors.length === 0, errors.join(' | '));
await finish();
