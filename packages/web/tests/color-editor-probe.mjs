/**
 * Checks the VB Color editor on a game that ships a VB Color package: Mario Clash ("Mario Clash (JU).vb" in
 * VBC_ROM_DIR) with its colorization on; skipped without the ROM. Color mode lists the package's sheets; a pick on the
 * screen opens its sheet or offers a new one; the sheet editor paints (value-0 pixels too, where the runtime has opaque
 * slots), goes back to red and shows the original; the tree files sheets (boot screens first, single-folder levels left
 * out, Copy ID); the build goes into the game. Export / Import Package are covered by color-exchange-probe.mjs.
 *
 * Usage: VBC_ROM_DIR=~/Downloads/ROMS node tests/color-editor-probe.mjs [SHOT.png] (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile, copyFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { answerColorPackage } from './color-packages-host.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
const shot = process.argv[2];

let failures = 0;
function check(label, ok, detail) {
    if (!ok) {
        failures++;
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const romSource = process.env.VBC_ROM_DIR && path.join(process.env.VBC_ROM_DIR, 'Mario Clash (JU).vb');
if (!existsSync(path.join(dist, 'index.html')) || !romSource || !existsSync(romSource)) {
    console.log('\nskipped: dist is not built, or VBC_ROM_DIR has no "Mario Clash (JU).vb"\n');
    process.exit(0);
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
};
const server = createServer(async (request, response) => {
    const url = request.url === '/' ? '/index.html' : decodeURIComponent(request.url.split('?')[0]);
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
const romPath = path.join(scratch, 'Mario Clash (JU).vb');
await copyFile(romSource, romPath);

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer:\n  yarn add --dev -W puppeteer\n');
    server.close();
    process.exit(1);
}
const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output', '--lang=en-US'],
    env: { ...process.env, LANG: 'en_US.UTF-8' },
});
// the tree's Copy ID writes to the clipboard, which the checks read back
await browser.defaultBrowserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
const page = await browser.newPage();
// the checks read English texts
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
});
await page.setViewport({ width: 1500, height: 950 });

const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
await page.setRequestInterception(true);
page.on('request', async request => {
    if (await answerColorPackage(request)) {
        return;
    }
    if (request.url().includes('/pvb/')) {
        request.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' });
        return;
    }
    request.continue();
});

const button = control => `.vp-titlebar-button[data-control="${control}"]`;
const dockText = () => page.evaluate(() => document.querySelector('.vp-dock')?.textContent ?? '');
async function finish() {
    if (shot) {
        await page.screenshot({ path: shot });
    }
    if (errors.length) {
        console.log('  ' + errors.slice(0, 5).join('\n  '));
    }
    await browser.close();
    server.close();
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}
async function until(test, ms = 15000) {
    for (let t = 0; t < ms; t += 250) {
        if (await test()) {
            return true;
        }
        await wait(250);
    }
    return false;
}

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(600);
const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.vp-library-side-foot .vp-button')]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await wait(3000);

const undo = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await wait(500);
};

console.log('\nColor mode');
check('the editor is offered', !!await page.$(button('color')));
await page.click(button('color'));
await page.waitForSelector('.vp-color-panel', { timeout: 10000 });
await wait(800);
// the colorization may be off: the panels offer to switch it on (which restarts the game)
const switchOn = await page.$$eval('.vp-color-panel button', buttons =>
    buttons.findIndex(b => /Switch On/.test(b.textContent ?? '')));
if (switchOn >= 0) {
    await page.$$eval('.vp-color-panel button', (buttons, at) => buttons[at].click(), switchOn);
    await wait(3000);
}
check('the project tree lists the package\'s sheets', await until(async () => (await page.$('[data-folder="Figures"]')) !== null, 20000),
    (await dockText()).slice(0, 300));
check('no Color or Palettes panel any more', !/Palettes/.test(await page.evaluate(() =>
    [...document.querySelectorAll('.lm-TabBar-tabLabel')].map(t => t.textContent).join('|'))));

const tabs = () => page.evaluate(() => [...document.querySelectorAll('.lm-TabBar-tab')]
    .map(t => (t.classList.contains('lm-mod-current') ? '*' : '') + (t.textContent ?? '')).join('|'));
const screenBox = () => page.evaluate(() => {
    const canvas = [...document.querySelectorAll('.vp-dock canvas')]
        .map(c => ({ c, box: c.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 100 && Math.abs(box.width / box.height - 384 / 224) < 0.05)
        .sort((a, b) => b.box.width - a.box.width)[0];
    return canvas && { x: canvas.box.x, y: canvas.box.y, width: canvas.box.width, height: canvas.box.height };
});
async function pickSomething(from = 20) {
    const screen = await screenBox();
    const at = (vx, vy) => [screen.x + (vx + 0.5) / 384 * screen.width, screen.y + (vy + 0.5) / 224 * screen.height];
    for (let vy = from; vy < 220; vy += 3) {
        for (let vx = 10; vx < 380; vx += 2) {
            await page.mouse.move(...at(vx, vy));
            const hover = await page.evaluate(() => document.querySelector('.vp-color-hover')?.textContent ?? '');
            if (!/Character/.test(hover)) continue;
            await page.mouse.click(...at(vx, vy));
            await wait(800);
            return hover;
        }
    }
    return undefined;
}

const tabBars = await page.evaluate(() => [...document.querySelectorAll('.lm-TabBar')]
    .map(bar => [...bar.querySelectorAll('.lm-TabBar-tab')].map(tab => (tab.textContent ?? '').trim()).join('|')));
check('Screen and Sheet are tabs of one area, Screen first', tabBars.includes('Screen|Sheet'), JSON.stringify(tabBars));
const projectWidth = await page.evaluate(() => document.querySelector('.vp-color-project')?.closest('.lm-DockPanel-widget, .lm-Widget')?.getBoundingClientRect().width ?? 0);
check('the project is narrow', projectWidth > 300 && projectWidth < 420, String(projectWidth));
const showTab = async (label) => {
    for (const tab of await page.$$('.lm-TabBar-tab')) {
        if ((await tab.evaluate(t => (t.textContent ?? '').trim())) === label) {
            await tab.click();
        }
    }
    await wait(400);
};

console.log('\nA pick on the screen');
await wait(3000);
const pipetteDisabled = () => page.$eval('[data-screen-tool="pipette"]', node => node.disabled);
check('the screen\'s pipette waits for a sheet', await pipetteDisabled());
await page.click('[data-expand-all]');
await wait(300);
await page.click('[data-sheet="sprites/crabs"]');
await wait(800);
check('a sheet is open, its tab in front', await page.$('.vp-color-sheet') !== null && /\*Sheet/.test(await tabs()), await tabs());
await showTab('Screen');
check('then the pipette can be had', !await pipetteDisabled());
const brushOf = () => page.evaluate(() => {
    const fill = document.querySelector('[data-brushes] .on button > *');
    const rgb = fill && getComputedStyle(fill).backgroundColor.match(/\d+/g);
    return rgb ? '#' + rgb.slice(0, 3).map(v => Number(v).toString(16).padStart(2, '0')).join('') : '';
});
await page.click('[data-screen-tool="pipette"]');
await wait(200);
{
    const screen = await screenBox();
    const at = (vx, vy) => [screen.x + (vx + 0.5) / 384 * screen.width, screen.y + (vy + 0.5) / 224 * screen.height];
    let taken = false;
    for (let vy = 50; vy < 220 && !taken; vy += 3) {
        for (let vx = 10; vx < 380 && !taken; vx += 2) {
            await page.mouse.move(...at(vx, vy));
            if (!/Character/.test(await page.evaluate(() => document.querySelector('.vp-color-hover')?.textContent ?? ''))) continue;
            await page.mouse.click(...at(vx, vy));
            await wait(800);
            taken = true;
        }
    }
}
check('the pipette brings the sheet forward with the color in the brush', /\*Sheet/.test(await tabs()) && /^#[0-9a-f]{6}$/.test(await brushOf())
    && await brushOf() !== '#ffffff', `${await tabs()} ${await brushOf()}`);
await showTab('Screen');
check('the pipette is put down after use', await page.$eval('[data-screen-tool="pipette"]', node => node.getAttribute('aria-pressed') !== 'true'));
// the game runs through its boot screens to the title and intro by itself, so reset and pause on the warning screen
await page.$eval('[data-control="reset"]', node => node.click());
await wait(1500);
await page.$eval('[data-control="pause"]', node => node.click());
await wait(300);
await page.click('[data-screen-tool="select"]');
await wait(200);
const picked = await pickSomething(50);                                 // the warning's text
console.log(`  (picked: ${picked})`);
await page.$eval('[data-control="pause"]', node => node.click());                // (the game runs on)
check('a pick brings the sheet editor forward', /\*Sheet/.test(await tabs()), await tabs());
const pickedSheet = await page.$eval('.vp-color-sheet', node => node.dataset.sheetId ?? '').catch(() => '');
if (pickedSheet) {
    check('a pick opens the sheet that has it (the warning screen\'s)', /^screens\/warning\//.test(pickedSheet), pickedSheet);
    check('and its folder in the tree, the boot screen\'s', await page.evaluate(id => {
        const rows = [...document.querySelectorAll('.vp-color-tree-item')];
        const row = document.querySelector(`[data-sheet="${id}"]`);
        const folder = document.querySelector('[data-folder="Screens/Boot/Warning"]');
        const next = folder && rows.slice(rows.indexOf(folder) + 1).find(r => r.dataset.folder !== undefined);
        return !!row && !!folder && row.classList.contains('selected') && rows.indexOf(row) > rows.indexOf(folder)
            && (!next || rows.indexOf(row) < rows.indexOf(next));
    }, pickedSheet));
} else {
    const sheetPanelText = () => page.evaluate(() => document.querySelector('.vp-color-sheet-panel')?.textContent ?? '');
    check('a pick no sheet has closes the open sheet, and says so, offering a new sheet',
        /is on no sheet/.test(await sheetPanelText()) && /Create Sheet/.test(await sheetPanelText()), (await sheetPanelText()).slice(0, 200));
    for (const handle of await page.$$('.vp-color-sheet-panel button')) {
        if (/Create Sheet/.test(await handle.evaluate(node => node.textContent ?? ''))) {
            await handle.click();
            break;
        }
    }
    await wait(800);
    check('a new sheet of it goes into the tree', await page.$('[data-folder="My sheets"]') !== null);
    check('and opens', await page.$('.vp-color-sheet') !== null);
}

console.log('\nThe sheet editor');
await page.click('[data-collapse-all]');
await wait(300);
check('the tree starts with its folders closed', await page.$('[data-sheet="sprites/crabs"]') === null);
await page.click('[data-expand-all]');
await wait(300);
await page.click('[data-sheet="sprites/crabs"]');
await wait(800);
check('a sheet of the package opens', await page.$eval('.vp-color-sheet', node => node.dataset.sheetName ?? '').catch(() => '') === 'Crabs');
// the tool keys work at once, without a click into the sheet: a click elsewhere in the color editor (the tree, a panel's
// button) hands the keyboard to the sheet rather than to the game, whose keys they also are (B = Start, E, M, G …)
const toolOn = (id) => page.$eval(`[data-tool="${id}"]`, node => node.classList.contains('on'));
await page.keyboard.press('e');
await wait(150);
const eraserFromTree = await toolOn('eraser');
await page.click('[data-expand-all]');
await wait(200);
await page.keyboard.press('b');
await wait(150);
check('tool keys work right after picking a sheet in the tree and after a tree button, without a click into the sheet',
    eraserFromTree && await toolOn('pencil') && !await toolOn('eraser'), `eraser after the tree: ${eraserFromTree}`);
// and after a color is chosen in a brush color's picker (a double click opens it), and the picker is closed again
const brushSlot = await page.$eval('[data-brush].on', node => node.dataset.brush).catch(() => '0');
await page.click(`[data-brush="${brushSlot}"] button`, { count: 2, clickCount: 2 });
await wait(400);
const pickerOpen = await page.$('[data-color-picker]') !== null;
const saturation = await page.$('[data-color-picker] .saturation-white');
if (saturation) {
    const box = await saturation.boundingBox();
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
    await wait(200);
}
await page.keyboard.press('e');
await wait(150);
const eraserInPicker = await toolOn('eraser');
if (pickerOpen) {
    await page.mouse.click(5, 5);
    await wait(300);
}
await page.keyboard.press('b');
await wait(150);
check('and after choosing a color in the picker and closing it', pickerOpen && eraserInPicker && await toolOn('pencil'),
    `open ${pickerOpen}, eraser with the picker open ${eraserInPicker}`);
const gridOn = () => page.$eval('[data-grid]', node => node.classList.contains('on'));
check('the grid is off at first, its button in the status line',
    !await gridOn() && await page.$('.vp-color-sheet-status [data-grid]') !== null);
await page.click('[data-grid]');
await wait(200);
check('and goes on', await gridOn());
await page.click('[data-grid]');
await wait(200);
const sheetColors = () => page.$$eval('[data-sheet-colors] .vp-color-sheet-swatches button', bs => bs.map(b => b.title));
const reds = ['#000000', '#550000', '#aa0000', '#ff0000'];
const colors0 = await sheetColors();
check('it lists the sheet\'s colors', colors0.length > 3, String(colors0.length));
check('and what they cost', /characters/.test(await page.$eval('[data-cost]', node => node.textContent ?? '')));
const clickButton = async (selector) => {
    await page.click(selector);
    await wait(600);
};
await clickButton('[data-reset="red"]');
const colorsRed = await sheetColors();
check('Reset Sheet makes the whole sheet red', /Reset Sheet/.test(await page.$eval('[data-reset="red"]', node => node.textContent ?? ''))
    && colorsRed.length > 0 && colorsRed.every(c => reds.includes(c)), colorsRed.join(' '));
const status = () => page.evaluate(() => document.querySelector('.vp-color-sheet-status')?.textContent ?? '');
const canvasBox = await (await page.$('.vp-color-sheet-canvas')).boundingBox();
const statusText = () => page.evaluate(() => document.querySelector('.vp-color-sheet-status-text')?.textContent ?? '');
// the runtime has opaque slots for the crabs' table (vbcpkg.zeroPaintable), so the status line offers value-0 pixels too
let spot, zeroSpot;
for (let y = canvasBox.y + 20; y < canvasBox.y + canvasBox.height - 20 && !(spot && zeroSpot); y += 6) {
    for (let x = canvasBox.x + 20; x < canvasBox.x + canvasBox.width - 20 && !(spot && zeroSpot); x += 6) {
        await page.mouse.move(x, y);
        const text = await statusText();
        if (!spot && /value [123]\b/.test(text)) spot = [x, y];
        if (!zeroSpot && /value 0\b/.test(text) && /transparent in the game/.test(text)) zeroSpot = [x, y];
    }
}
check('the status names what is under the pointer', !!spot, await status());
// the view must not wobble under a moving pointer (status line height changing, a scroll bar coming and going)
const viewState = () => page.$eval('.vp-color-sheet-view', node =>
    `${node.clientWidth}x${node.clientHeight}@${node.dataset.offset}`);
const states = new Set();
for (let i = 0; i < 60; i++) {
    await page.mouse.move(canvasBox.x + 10 + (i * 37) % (canvasBox.width - 20), canvasBox.y + 10 + (i * 53) % (canvasBox.height - 20));
    states.add(await viewState());
}
await page.mouse.move(canvasBox.x - 40, canvasBox.y - 40);
states.add(await viewState());
check('the view stands still under the pointer', states.size === 1, [...states].join(' | '));
check('the view has no scroll bars', await page.$eval('.vp-color-sheet-view', node =>
    node.offsetWidth - node.clientWidth === 0 && node.offsetHeight - node.clientHeight === 0));
const clickTitled = async (pattern) => {
    for (const handle of await page.$$('.vp-color-sheet .vp-color-tool-button')) {
        if (pattern.test(await handle.evaluate(node => node.title))) {
            await handle.click();
            return;
        }
    }
};
const scrollOf = () => page.$eval('.vp-color-sheet-view', node => node.dataset.offset.split(',').map(Number));
const middle = [canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2];
const drag = async (dx, dy) => {
    await page.mouse.move(...middle);
    await page.mouse.down();
    await page.mouse.move(middle[0] + dx, middle[1] + dy, { steps: 5 });
    await page.mouse.up();
    await wait(300);
};
await page.click('[data-tool="hand"]');
const f0 = await scrollOf();
await drag(250, 150);
const f1 = await scrollOf();
check('the hand places the sheet freely', f1[0] === f0[0] + 250 && f1[1] === f0[1] + 150, `${f0} -> ${f1}`);
await page.click('[data-fit]');                              // the zoom in the status line: a click fits
await wait(300);
check('Fit places it again', JSON.stringify(await scrollOf()) === JSON.stringify(f0), `${await scrollOf()}`);
for (let i = 0; i < 3; i++) {
    await clickTitled(/^Zoom in/);
    await wait(200);
}
const s0 = await scrollOf();
await drag(-120, -80);
const s1 = await scrollOf();
check('the hand moves the view', s1[0] === s0[0] - 120 && s1[1] === s0[1] - 80, `${s0} -> ${s1}`);
await page.click('[data-tool="pencil"]');
const colorsBeforePan = await sheetColors();
await page.mouse.move(...middle);
await page.keyboard.down(' ');
await wait(200);
check('Space held shows the hand', await page.$eval('.vp-color-sheet-canvas', node => node.classList.contains('pan-ready'))
    && await page.$eval('[data-tool="hand"]', node => node.classList.contains('on'))
    && !await page.$eval('[data-tool="pencil"]', node => node.classList.contains('on')));
await drag(100, 60);
await page.keyboard.up(' ');
await wait(200);
const s2 = await scrollOf();
check('and moves the view, painting nothing', s2[0] === s1[0] + 100 && s2[1] === s1[1] + 60
    && JSON.stringify(await sheetColors()) === JSON.stringify(colorsBeforePan), `${s1} -> ${s2}`);
// a navigator click centers the view on that point, so offset = middle - point * k with k = view zoom / navigator scale
const navigator = await (await page.$('[data-navigator]')).boundingBox();
const viewSize = await page.$eval('.vp-color-sheet-view', node => [node.clientWidth, node.clientHeight]);
const navA = [navigator.width / 4, navigator.height / 4];
const navB = [navigator.width * 3 / 4, navigator.height * 3 / 4];
await page.mouse.click(navigator.x + navA[0], navigator.y + navA[1]);
await wait(300);
const s3 = await scrollOf();
await page.mouse.click(navigator.x + navB[0], navigator.y + navB[1]);
await wait(300);
const s4 = await scrollOf();
const navCentered = [0, 1].every(axis => {
    const k = (s3[axis] - s4[axis]) / (navB[axis] - navA[axis]);
    return k > 0 && Math.abs(s3[axis] - (viewSize[axis] / 2 - navA[axis] * k)) <= 2
        && Math.abs(s4[axis] - (viewSize[axis] / 2 - navB[axis] * k)) <= 2;
});
check('the navigator moves the view to where it is clicked', navCentered && JSON.stringify(s3) !== JSON.stringify(s2),
    `${s2} -> ${s3} -> ${s4} (view ${viewSize})`);
if (shot) {
    await page.screenshot({ path: shot.replace(/\.png$/, '-navigator.png') });
}
const zoomLabel = () => page.$eval('.vp-color-sheet-zoom', node => parseInt(node.textContent ?? '0'));
const zoomBefore = await zoomLabel();
await page.mouse.move(...middle);
await page.keyboard.down('Alt');
await page.mouse.wheel({ deltaY: -100 });
await page.keyboard.up('Alt');
await wait(300);
check('the wheel with Alt zooms in', await zoomLabel() > zoomBefore, `${zoomBefore} -> ${await zoomLabel()}`);
await page.click('[data-fit]');                              // the zoom in the status line: a click fits
await wait(300);
if (spot) {
    await page.mouse.move(...spot);
    await page.mouse.down();
    await page.mouse.move(spot[0] + 12, spot[1], { steps: 4 });
    await page.mouse.up();
    await wait(500);
    check('the pencil paints in the brush\'s color', !reds.includes(await brushOf()) && (await sheetColors()).includes(await brushOf()),
        `${await brushOf()}: ${(await sheetColors()).join(' ')}`);
    if (shot) {
        await page.screenshot({ path: shot.replace(/\.png$/, '-sheet.png') });
    }
    await page.click('[data-undo]');
    await wait(500);
    check('Undo takes the stroke back', (await sheetColors()).every(c => reds.includes(c)));
    check('and Redo is offered', await page.$eval('[data-redo]', node => !node.disabled));
    await page.click('[data-redo]');
    await wait(500);
    check('Redo puts it back', (await sheetColors()).includes(await brushOf()));
    await page.click('[data-undo]');
    await wait(500);
}
check('a pixel the game leaves transparent says what painting it does', !!zeroSpot);
if (zeroSpot) {
    await page.mouse.click(...zeroSpot);
    await wait(500);
    await page.mouse.move(...zeroSpot);
    await wait(200);
    check('and the pencil paints it opaque in the brush\'s color', (await sheetColors()).includes(await brushOf())
        && /value 0\b/.test(await statusText()), `${(await sheetColors()).join(' ')} / ${await statusText()}`);
    await page.click('[data-tool="eraser"]');
    await page.mouse.click(...zeroSpot);
    await wait(500);
    check('and the eraser makes it transparent again', (await sheetColors()).every(c => reds.includes(c)), (await sheetColors()).join(' '));
    await undo();
    await undo();
    await page.click('[data-tool="pencil"]');
}
await undo();
check('and the red', JSON.stringify(await sheetColors()) === JSON.stringify(colors0), (await sheetColors()).join(' '));
await page.click('[data-tool="area"]');
await page.mouse.move(canvasBox.x + canvasBox.width * 0.2, canvasBox.y + canvasBox.height * 0.2);
await page.mouse.down();
await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.8, { steps: 5 });
await page.mouse.up();
await wait(300);
check('an area can be chosen', /Reset Selection/.test(await page.$eval('[data-reset="red"]', node => node.textContent ?? '')),
    await page.$eval('[data-reset="red"]', node => node.textContent ?? ''));
await clickButton('[data-reset="red"]');
const colorsArea = await sheetColors();
check('Reset Selection leaves the rest colored', /Reset Selection/.test(await page.$eval('[data-reset="red"]', node => node.textContent ?? ''))
    && colorsArea.some(c => reds.includes(c)) && colorsArea.some(c => !reds.includes(c)), colorsArea.join(' '));
await undo();
await page.keyboard.press('Escape');
const showOriginal = async (on) => {
    for (const option of await page.$$('[data-original-select] .vp-radio-option')) {
        if ((await option.evaluate(node => (node.textContent ?? '').trim())) === (on ? 'Original' : 'Colored')) {
            await option.click();
        }
    }
    await wait(500);
};
await showOriginal(true);
const onlyRed = await page.evaluate(() => {
    const canvas = document.querySelector('.vp-color-sheet-canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0, red = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 255) continue;
        if (data[i + 1] > 70 || data[i + 2] > 70) colored++; else if (data[i] > 50) red++;
    }
    return { colored, red };
});
check('the original view shows red', onlyRed.red > 100, JSON.stringify(onlyRed));
if (shot) {
    await page.screenshot({ path: shot.replace(/\.png$/, '-original.png') });
}
await showOriginal(false);
await page.click('[data-tool="pencil"]');
if (spot) {
    await page.mouse.click(...spot);
    await wait(400);
}

console.log('\nA whole screen and its backdrop');
await page.click('[data-expand-all]');
await wait(300);
await page.click('[data-sheet="screens/title/whole"]');
await wait(900);
check('a screen\'s whole picture opens', await page.$eval('.vp-color-sheet', node => node.dataset.sheetId ?? '').catch(() => '') === 'screens/title/whole');
// row 215 shows the backdrop because the title's bottom rows are empty
const backdropShown = () => page.evaluate(() => {
    const view = document.querySelector('.vp-color-sheet-view');
    const canvas = document.querySelector('.vp-color-sheet-canvas');
    const [x, y] = view.dataset.offset.split(',').map(Number);
    const zoom = parseInt(document.querySelector('.vp-color-sheet-zoom')?.textContent ?? '1');
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const d = canvas.getContext('2d').getImageData(Math.round((x + 3) * ratio), Math.round((y + 215 * zoom + 1) * ratio), 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
});
check('behind it the backdrop, black as the game has it', await backdropShown() === '#000000', await backdropShown());
check('its backdrop can be edited (the title\'s set\'s, which the menu shares)', await page.$('[data-backdrop="set:fff7c73c"]') !== null);
check('and reaches the game (no preview-only note)', await page.$('[data-backdrop-preview-only]') === null);
const bar = await (await page.$('.vp-color-backdrop-bar')).boundingBox();
await page.mouse.click(bar.x + 10, bar.y + 4);
await wait(400);
check('a click on the bar gives the whole backdrop the brush\'s color', await backdropShown() === await brushOf(), `${await backdropShown()} / ${await brushOf()}`);
await page.mouse.click(bar.x + 10, bar.y + bar.height - 3);
await wait(400);
const rowText = () => page.$eval('[data-backdrop] .vp-color-hint', node => node.textContent ?? '').catch(() => '');
check('a second color makes a gradient', /Row 22[0-3]/.test(await rowText()), await rowText());
await page.mouse.move(bar.x + bar.width - 4, bar.y + bar.height - 3);
await page.mouse.down();
await page.mouse.move(bar.x + bar.width - 4, bar.y + 120, { steps: 5 });
await page.mouse.up();
await wait(400);
check('a color is dragged to another row', /Row 1[12]\d/.test(await rowText()), await rowText());
await page.click('[data-backdrop-steps]');
await wait(300);
check('bands between the colors', await page.$('.vp-color-backdrop-steps') !== null);
if (shot) {
    await page.screenshot({ path: shot.replace(/\.png$/, '-backdrop.png') });
}
await undo();
check('Undo takes the bands back', await page.$('.vp-color-backdrop-steps') === null);
await page.click('[data-backdrop-reset]');
await wait(400);
check('Package Backdrop: black again', await backdropShown() === '#000000', await backdropShown());

console.log('\nThe project tree');
await page.click('[data-collapse-all]');
await wait(300);
check('Collapse Folders', await page.$('[data-sheet="sprites/crabs"]') === null);
await page.click('[data-expand-all]');
await wait(300);
check('Expand Folders', await page.$('[data-sheet="sprites/crabs"]') !== null);
await page.type('.vp-color-tree-search input', 'ghost');
await wait(300);
check('the search finds a sheet', await page.$('[data-sheet="sprites/ghosts"]') !== null && await page.$('[data-sheet="sprites/crabs"]') === null);
await page.click('[data-clear-search]');
await wait(300);
check('and its X clears it', await page.$eval('.vp-color-tree-search input', node => node.value) === ''
    && await page.$('[data-sheet="sprites/crabs"]') !== null && await page.$('[data-clear-search]') === null);
// the tree shows the package's folders unchanged; the package is ordered per _tools/vbcpkg/NAMING.md
// (sheets.order_and_flatten)
const treeRows = () => page.evaluate(() => [...document.querySelectorAll('.vp-color-tree-item')]
    .map(row => row.dataset.folder !== undefined ? `folder:${row.dataset.folder}` : row.dataset.sheet ?? ''));
const rows = await treeRows();
const bootFolders = rows.filter(row => /^folder:Screens\/Boot\/[^/]+$/.test(row));
const screensFolders = rows.filter(row => /^folder:Screens\/[^/]+$/.test(row));
check('the boot screens\' folders come first, in the order the game shows them (the package\'s order)',
    JSON.stringify(bootFolders) === JSON.stringify(['Warning', 'Precaution', 'Automatic Pause Select'].map(name => `folder:Screens/Boot/${name}`))
    && screensFolders[0] === 'folder:Screens/Boot' && rows.find(row => /^folder:[^/]+$/.test(row)) === 'folder:Screens',
    [...screensFolders.slice(0, 2), ...bootFolders].join(', '));
// Figures/Platforms was Figures' only subfolder, so the package flattens it
const platformRow = rows.indexOf('sprites/platform_fff55a24');
const nextFolderAfterFigures = rows.findIndex((row, at) => at > rows.indexOf('folder:Figures') && /^folder:[^/]+$/.test(row));
check('a folder level that holds one folder only is left out (by the package)', !rows.includes('folder:Figures/Platforms')
    && platformRow > rows.indexOf('folder:Figures') && (nextFolderAfterFigures < 0 || platformRow < nextFolderAfterFigures),
    rows.filter(row => /Figures|platform/.test(row)).join(', '));
const openBefore = await page.$eval('.vp-color-sheet', node => node.dataset.sheetId ?? '').catch(() => '');
await page.hover('[data-sheet="sprites/ghosts"]');
await page.click('[data-copy-id="sheet:sprites/ghosts"]');
await wait(500);
const copiedId = await page.evaluate(() => navigator.clipboard.readText()).catch(error => String(error));
check('Copy ID puts the sheet\'s reference on the clipboard', copiedId === 'mario-clash/vb-color#sprites/ghosts', copiedId);
check('and does not open the sheet', await page.$eval('.vp-color-sheet', node => node.dataset.sheetId ?? '').catch(() => '') === openBefore);
await page.hover('[data-folder="Screens/Boot/Warning"]');
await page.click('[data-copy-id="folder:Screens/Boot/Warning"]');
await wait(500);
const copiedFolder = await page.evaluate(() => navigator.clipboard.readText()).catch(error => String(error));
check('and a folder\'s', copiedFolder === 'mario-clash/vb-color#folder:Screens/Boot/Warning', copiedFolder);
const groupRow = await page.$('[data-sheet^="group:"]');
check('every character by group', groupRow !== null);
if (groupRow) {
    await groupRow.click();
    await wait(800);
    check('a group opens as a sheet', /^r:|^w:/.test(await page.$eval('.vp-color-sheet', node => node.dataset.sheetName ?? '').catch(() => '')));
}
check('the tree shows no numbers', await page.$('.vp-color-tree-size') === null);
await page.click('[data-sheet="sprites/crabs"]', { count: 2 });
await page.waitForSelector('.vp-color-tree-name-input', { timeout: 3000 });
await page.$eval('.vp-color-tree-name-input', node => node.select());
await page.keyboard.type('Crabby');
await page.keyboard.press('Enter');
await wait(400);
check('a sheet can be named', /Crabby/.test(await page.$eval('[data-sheet="sprites/crabs"]', node => node.textContent ?? '')));
await page.evaluate(() => {
    const data = new DataTransfer();
    const from = document.querySelector('[data-sheet="sprites/crabs"]');
    const to = document.querySelector('[data-folder="Backgrounds"]');
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
});
await wait(400);
check('and dragged into another folder', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.vp-color-tree-item')];
    const row = document.querySelector('[data-sheet="sprites/crabs"]');
    const folder = document.querySelector('[data-folder="Backgrounds"]');
    const next = rows.slice(rows.indexOf(folder) + 1).find(r => parseInt(r.style.paddingLeft) <= parseInt(folder.style.paddingLeft));
    const end = next ? rows.indexOf(next) : rows.length;
    return !!row && rows.indexOf(row) > rows.indexOf(folder) && rows.indexOf(row) < end;
}));
await undo();
await undo();

console.log('\nApplying');
for (const tab of await page.$$('.lm-TabBar-tab')) {
    if ((await tab.evaluate(t => t.textContent ?? '')).trim() === 'Build') {
        await tab.click();
    }
}
await wait(400);
check('Build is a tab beside the project', /\*Build/.test(await tabs()) && !/\*Project/.test(await tabs()), await tabs());
const buildText = () => page.evaluate(() => [...document.querySelectorAll('.vp-color-panel')]
    .map(panel => panel.textContent ?? '').find(text => /Apply to the Game/.test(text)) ?? '');
for (const handle of await page.$$('.vp-color-panel button')) {
    if (/Apply to the Game/.test(await handle.evaluate(node => node.textContent ?? ''))) {
        await handle.click();
        break;
    }
}
// the compiler runs in a worker, so the page must answer at once while it builds
await wait(300);
const asked = Date.now();
await page.evaluate(() => 1);
const answered = Date.now() - asked;
check('the page stays responsive while building', answered < 300, `${answered} ms`);
check('the build is made and put into the game', await until(async () => /Built\./.test(await buildText()), 30000),
    (await buildText()).slice(0, 300));
check('the build counts the painted load positions', /Painted load positions[1-9]/.test(await buildText()),
    (await buildText()).slice(0, 300));
await wait(1500);
check('the game runs on', await page.$('.vp-dock canvas') !== null);
check('the editor keeps the package after the restart', await until(async () => (await page.$('[data-folder="Figures"]')) !== null, 15000));
check('and knows the build is current', /Built\./.test(await buildText()), (await buildText()).slice(0, 200));
await page.click(button('patches'));
await page.waitForSelector('.vp-panel-aside', { timeout: 5000 });
await wait(600);
const patchText = await page.evaluate(() => document.querySelector('.vp-panel-aside')?.textContent ?? '');
check('the build is listed among the patches', /my colors/.test(patchText), patchText.slice(0, 300));
check('ahead of the shipped colorization', patchText.indexOf('my colors') < patchText.indexOf('KR155E'),
    patchText.slice(0, 300));
check('nothing errored', errors.length === 0, errors.slice(0, 3).join(' | '));
await finish();
