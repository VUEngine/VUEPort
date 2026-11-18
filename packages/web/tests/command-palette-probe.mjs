// the command palette (F1) reaches what used to be mouse-only: opening a ROM from a link, the recent list and emptying
// it, each picture setting; renamed commands replace the old names
// Usage: node tests/command-palette-probe.mjs   (after `yarn build`)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) { failures++; }
};

if (!existsSync(path.join(dist, 'index.html'))) {
    console.log('\nskipped: dist is not built\n');
    process.exit(0);
}

const ROM = Buffer.alloc(8 * 131072);
{
    const header = ROM.length - 544;
    ROM.write('PALETTE PROBE'.padEnd(20, ' '), header, 'ascii');
    ROM.write('VU', header + 25, 'ascii');
    ROM.write('VPRB', header + 27, 'ascii');
    ROM[header + 31] = 1;
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
    '.png': 'image/png', '.webp': 'image/webp',
};
const server = createServer(async (request, response) => {
    const url = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    if (url === '/probe.vb') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(ROM);
        return;
    }
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

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer.\n');
    server.close();
    process.exit(1);
}

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
// the labels below are the English ones, whatever language this machine speaks
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] });
});
const errors = [];
const KNOWN_NOISE = /defaultProps will be removed from function components/;
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => {
    if (message.type() === 'error' && !KNOWN_NOISE.test(message.text())) {
        errors.push(message.text());
    }
});

await page.setRequestInterception(true);
page.on('request', request => {
    if (request.url().includes('api.vueport.net/pvb/')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const activatePanel = async label => {
    const tabs = await page.$$('.lm-TabBar-tab');
    for (const tab of tabs) {
        if (await tab.evaluate(candidate => candidate.textContent?.trim()) === label) {
            await tab.click();
            await wait(500);
            return true;
        }
    }
    return false;
};

const pickEntries = () => page.evaluate(() =>
    [...document.querySelectorAll('.vp-pick-item')].map(item => ({
        label: item.querySelector('span')?.textContent ?? '',
        disabled: item.classList.contains('vp-pick-disabled'),
    })));

async function openPalette() {
    await page.keyboard.press('F1');
    await page.waitForSelector('.vp-pick', { timeout: 3000 });
    await wait(200);
}

async function choose(label) {
    const clicked = await page.evaluate(wanted => {
        for (const item of document.querySelectorAll('.vp-pick-item')) {
            if ((item.querySelector('span')?.textContent ?? '').trim() === wanted) {
                item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                return true;
            }
        }
        return false;
    }, label);
    await wait(400);
    return clicked;
}

async function run(label) {
    await openPalette();
    const found = await choose(label);
    if (!found) {
        await page.keyboard.press('Escape');
        await wait(200);
    }
    return found;
}

const toasts = () => page.evaluate(() =>
    [...document.querySelectorAll('.vp-toast')].map(t => t.textContent ?? ''));

const stored = key => page.evaluate(k =>
    JSON.parse(window.localStorage.getItem('vueport.settings') ?? '{}')[k], key);

await page.goto(origin, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-side-foot .vp-button');
await wait(500);

console.log('\nOpening the palette');
check('F1 opens it', await (async () => {
    await page.keyboard.press('F1');
    const found = await page.waitForSelector('.vp-pick', { timeout: 3000 }).then(() => true, () => false);
    await page.keyboard.press('Escape');
    await wait(200);
    return found;
})());
check('Ctrl+Shift+P opens it too — Cmd+Shift+P on macOS', await (async () => {
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyP');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    const found = await page.waitForSelector('.vp-pick', { timeout: 3000 }).then(() => true, () => false);
    await page.keyboard.press('Escape');
    await wait(200);
    return found;
})());

// in a browser build it reaches the hidden file input pickInPage clicks, the only thing opening a chooser. Control,
// as that is what Chrome sees on every platform; the handler takes either modifier
check('Ctrl+O asks for a ROM — Cmd+O on macOS', await (async () => {
    const chooser = page.waitForFileChooser({ timeout: 3000 }).then(() => true, () => false);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyO');
    await page.keyboard.up('Control');
    const asked = await chooser;
    await page.keyboard.press('Escape');
    await wait(200);
    return asked;
})());

console.log('\nWhat the palette offers');
await openPalette();
const entries = await pickEntries();
const labels = entries.map(entry => entry.label);

const expected = [
    'Load ROM…',
    'Load ROM from Link…',
    'Continue Recently Opened…',
    'Clear Recently Opened Files',
    'Set Hardware Mode',
    'Toggle VB Color Support',
    'Show Patches',
    'Set Rendering Mode',
    'Set Scale',
    'Set Screen Decoration',
    'Set Color Palette',
    'Set Anaglyph Palette',
    'Open Settings',
    'Configure Screenshots',
    'Configure Achievements',
    'Configure Appearance',
    'Configure Display',
    'Configure Emulation',
    'Configure Input',
    'Configure Save Data',
    'Select Save Game Slot',
    'Change Color Mode',
    'Toggle Featured Homebrew',
];
for (const wanted of expected) {
    check(`"${wanted}" is there`, labels.includes(wanted));
}

// its keys are the page's own rather than the keymap's, so the entry carries them itself (Chrome's platform here)
check('"Load ROM…" names its keys', await page.evaluate(() => {
    for (const item of document.querySelectorAll('.vp-pick-item')) {
        if (item.querySelector('.vp-pick-label')?.textContent === 'Load ROM…') {
            const keys = item.querySelector('.vp-pick-description')?.textContent ?? '';
            return keys === '⌘O' || keys === 'Ctrl+O';
        }
    }
    return false;
}));

const gone = [
    'Change Palette', 'Change Settings', 'Change Appearance',
    'Change Display', 'Toggle Controls Overlay',
];
for (const label of gone) {
    check(`"${label}" is gone`, !labels.includes(label));
}

check('the list is sorted by what is shown',
    labels.join(' ') === [...labels].sort((a, b) => a.localeCompare(b)).join(' '));
check('nothing is listed twice', new Set(labels).size === labels.length);
await page.keyboard.press('Escape');
await wait(300);

console.log('\nSelecting emulated hardware from the palette');
check('Set Hardware Mode opens a list', await run('Set Hardware Mode'));
const hardwareEntries = (await pickEntries()).map(entry => entry.label);
check('Auto is offered', hardwareEntries.includes('Auto'));
check('original Virtual Boy is offered', hardwareEntries.includes('Virtual Boy'));
check('VB Color is offered', hardwareEntries.includes('VB Color'));
await choose('VB Color');
check('choosing VB Color writes the hardware setting', await stored('hardwareMode') === 'vbc');

console.log('\nToggling global VB Color support from the palette');
check('Toggle VB Color Support runs', await run('Toggle VB Color Support'));
await wait(400);
check('the global VBC gate is disabled', await stored('vbcSupportEnabled') === false);
check('the hardware status remains visible', await page.$('.vp-status-hardware') !== null);
check('the disabled hardware status says Virtual Boy', await page.evaluate(() =>
    document.querySelector('.vp-status-hardware .vp-status-value')
        ?.textContent?.trim() === 'Virtual Boy'));
await openPalette();
const vbcOffCommands = (await pickEntries()).map(entry => entry.label);
check('Set Hardware Mode is hidden while VBC support is off',
    !vbcOffCommands.includes('Set Hardware Mode'));
check('the command to turn VBC support back on remains',
    vbcOffCommands.includes('Toggle VB Color Support'));
await page.keyboard.press('Escape');
await wait(200);
check('Configure Emulation still opens', await run('Configure Emulation'));
const clickSettingsTab = async label => page.evaluate(wanted => {
    const tab = [...document.querySelectorAll('.vp-settings-tab')]
        .find(candidate => candidate.textContent?.trim() === wanted);
    if (tab instanceof HTMLElement) {
        tab.click();
        return true;
    }
    return false;
}, label);
const settingsTitles = () => page.evaluate(() =>
    [...document.querySelectorAll('.vp-window-body .vp-setting-title')]
        .map(title => title.textContent?.trim() ?? ''));
await wait(200);
const emulationTitles = await settingsTitles();
check('VB Color Support moved out of Emulation', !emulationTitles.includes('VB Color Support'));
check('Hardware Mode moved out of Emulation', !emulationTitles.includes('Hardware Mode'));
check('the VB Color settings pane is available', await clickSettingsTab('VB Color'));
await wait(200);
const vbColorTitles = await settingsTitles();
check('VB Color Support is in the VB Color pane', vbColorTitles.includes('VB Color Support'));
check('Hardware Mode is hidden while VB Color support is off', !vbColorTitles.includes('Hardware Mode'));
await page.keyboard.press('Escape');
await wait(200);
await page.click('.vp-status-hardware');
await page.waitForSelector('.vp-modal', { timeout: 3000 });
check('clicking Hardware offers to enable VB Color Support', /Enable VB Color Support/.test(
    await page.evaluate(() => document.querySelector('.vp-modal')?.textContent ?? '')));
await page.keyboard.press('Enter');
await page.waitForSelector('.vp-pick', { timeout: 3000 });
check('confirming re-enables the global VBC gate', await stored('vbcSupportEnabled') === true);
check('and opens the hardware mode picker', (await pickEntries()).some(entry => entry.label === 'VB Color'));
await page.keyboard.press('Escape');
await wait(200);

console.log('\nSetting the picture from the palette');
check('Set Color Palette opens a list', await run('Set Color Palette'));
const paletteEntries = (await pickEntries()).map(entry => entry.label);
check('the built-in ramps are offered', paletteEntries.includes('Green'));
check('the one in force is marked Current', await page.evaluate(() =>
    [...document.querySelectorAll('.vp-pick-item')]
        .some(item => /Current/.test(item.textContent ?? ''))));
await choose('Green');
check('choosing one writes the setting', await stored('palette') === 'green');

check('Set Scale opens a list', await run('Set Scale'));
await choose('×2');
check('the scale is written', await stored('scale') === 'x2');

check('Set Screen Decoration opens a list', await run('Set Screen Decoration'));
await choose('None');
check('the decoration is written', await stored('decoration') === 'none');

check('Set Rendering Mode opens a list', await run('Set Rendering Mode'));
await choose('Anaglyph');
check('the rendering mode is written', await stored('renderingMode') === 'anaglyph');

check('Set Anaglyph Palette opens a list', await run('Set Anaglyph Palette'));
await choose('Red / Green');
check('the anaglyph pair is written', await stored('anaglyphPalette') === 'red-green');

console.log('\nEvery other setting, from the palette');
await openPalette();
const settingEntries = await pickEntries();
const settingLabels = settingEntries.map(entry => entry.label);
const isOffered = label => settingEntries.find(entry => entry.label === label);
for (const wanted of [
    'Set 3D Depth', 'Turn on Rewind', 'Set Fast Forward Ratio', 'Set Screenshot Scale',
    'Set Video Quality', 'Set Video Rendering Mode', 'Turn on Automatic Save States',
    'Set Cartridge Save Size', 'Turn off Error Sound', 'Set Library Start Page',
    'Set Homebrew API', 'Turn off Scan Recursively',
]) {
    check(`"${wanted}" is there`, settingLabels.includes(wanted));
}
check('Swap Eyes is not grayed in Anaglyph', isOffered('Turn on Swap Eyes')?.disabled === false);
check('3D Depth is not grayed in Anaglyph', isOffered('Set 3D Depth')?.disabled === false);
check('Decoration Color is grayed with no decoration',
    isOffered('Set Decoration Color')?.disabled === true);
check('the picture settings are not listed twice',
    !settingLabels.includes('Set Rendering Mode (Display)')
    && settingLabels.filter(label => label === 'Set Rendering Mode').length === 1);
check('still nothing is listed twice', new Set(settingLabels).size === settingLabels.length);
await page.keyboard.press('Escape');
await wait(200);

const depthEntry = () => page.$('.vp-status [data-status="stereoDepth"]');
check('the strip says nothing about 3D depth at the standard depth', await depthEntry() === null);
check('Set 3D Depth opens a list', await run('Set 3D Depth'));
check('the standard depth is marked Default', await page.evaluate(() =>
    [...document.querySelectorAll('.vp-pick-item')]
        .some(item => /^100%/.test(item.textContent ?? '') && /Default/.test(item.textContent ?? ''))));
await choose('150%');
check('choosing a depth writes it', await stored('stereoDepth') === 150);
check('the strip now shows the depth', await page.evaluate(() =>
    document.querySelector('.vp-status [data-status="stereoDepth"] .vp-status-value')
        ?.textContent?.trim() === '150%'));
await page.click('.vp-status [data-status="stereoDepth"]');
await page.waitForSelector('.vp-pick', { timeout: 3000 });
check('clicking the entry offers the depths', (await pickEntries()).some(entry => entry.label === '200%'));
await choose('100%');
check('back at the standard depth', await stored('stereoDepth') === 100);
check('and the entry goes again', await depthEntry() === null);

check('Turn on Rewind runs', await run('Turn on Rewind'));
check('and turns it on', await stored('rewindEnabled') === true);
check('Turn off Rewind is offered after', await run('Turn off Rewind'));
check('and turns it back off', await stored('rewindEnabled') === false);

check('Set Fast Forward Ratio opens a list', await run('Set Fast Forward Ratio'));
await choose('6×');
check('the ratio is written', await stored('fastForwardRatio') === 6);

console.log('\nThe settings dialog, by pane');
const paneOnScreen = () => page.evaluate(() =>
    document.querySelector('.vp-settings-tab.active')?.textContent ?? '');

await run('Configure Screenshots');
check('Configure Screenshots opens the dialog', await page.$('.vp-window') !== null);
check('and lands on the Screenshots pane', /screenshot/i.test(await paneOnScreen()));

check('the VB Color pane remains available when support is on', await clickSettingsTab('VB Color'));
await wait(200);
const enabledVbColorTitles = await settingsTitles();
check('VB Color Support remains in its pane', enabledVbColorTitles.includes('VB Color Support'));
check('Hardware Mode is in the VB Color pane', enabledVbColorTitles.includes('Hardware Mode'));

await run('Configure Achievements');
check('Configure Achievements switches pane', /achievement/i.test(await paneOnScreen()));
check('Achievement Sound moved out of Achievements',
    !(await settingsTitles()).includes('Achievement Sound'));

await run('Configure Appearance');
check('Configure Appearance switches pane', /appearance/i.test(await paneOnScreen()));
check('Error Sound moved out of Appearance', !(await settingsTitles()).includes('Error Sound'));

check('the Sound settings pane is available', await clickSettingsTab('Sound'));
await wait(200);
const soundTitles = await settingsTitles();
check('Error Sound is in the Sound pane', soundTitles.includes('Error Sound'));
check('Achievement Sound is in the Sound pane', soundTitles.includes('Achievement Sound'));

await run('Configure Input');
check('Configure Input switches pane', /input/i.test(await paneOnScreen()));

await page.keyboard.press('Escape');
await wait(400);
check('Escape closes the dialog', await page.$('.vp-window') === null);

await run('Open Settings');
check('Open Settings opens the first tab of the rail, not the pane it was left on',
    /achievement/i.test(await paneOnScreen()));
await page.keyboard.press('Escape');
await wait(400);

console.log('\nToggling Featured Homebrew');
const homebrewVisible = () => page.evaluate(() =>
    window.localStorage.getItem('vueport.homebrewVisible'));
check('starts on (nothing stored yet)', await homebrewVisible() === null);
check('Toggle Featured Homebrew runs', await run('Toggle Featured Homebrew'));
check('and turns it off', await homebrewVisible() === 'false');
check('running it again', await run('Toggle Featured Homebrew'));
check('turns it back on', await homebrewVisible() === 'true');

console.log('\nOpening a ROM from a link');
check('the command asks for an address', await run('Load ROM from Link…'));
await page.waitForSelector('.vp-modal-input', { timeout: 3000 });
await page.type('.vp-modal-input', `${origin}/probe.vb`);
await page.keyboard.press('Enter');
await page.waitForSelector('.vp-library', { hidden: true, timeout: 20000 });
check('the ROM at the address is running', await page.evaluate(() =>
    document.querySelector('.vp-library') === null
    && document.querySelector('.vp-dock canvas') !== null));

console.log('\nBacking out with Escape, a game running');
// a real click rather than choose's bare mousedown, as the browser moves focus after the click, off the list that
// just opened in the palette's place
const clickEntry = async label => {
    const entry = await page.evaluateHandle(wanted =>
        [...document.querySelectorAll('.vp-pick-item')]
            .find(item => item.querySelector('.vp-pick-label')?.textContent === wanted), label);
    await entry.asElement()?.click();
    await wait(400);
};
const somethingOpen = () => page.evaluate(() =>
    document.querySelector('.vp-pick, .vp-modal') !== null);
for (const label of ['Set 3D Depth', 'Set Library Start Page', 'Set Homebrew API']) {
    await openPalette();
    await clickEntry(label);
    const opened = await somethingOpen();
    await page.keyboard.press('Escape');
    await wait(300);
    check(`${label}, chosen by click, backs out on Escape`, opened && !await somethingOpen());
}

console.log('\nSave game slots');
{
    const savedFiles = () => page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const found = [];
        const roms = await root.getDirectoryHandle('roms').catch(() => undefined);
        if (!roms) { return found; }
        for await (const [name, handle] of roms.entries()) {
            if (handle.kind !== 'directory') { continue; }
            for await (const [file, entry] of handle.entries()) {
                if (entry.kind === 'file' && file.endsWith('.sram')) { found.push(`${name}/${file}`); }
            }
        }
        return found.sort();
    });
    const slotReading = () => page.evaluate(() =>
        document.querySelector('[data-status="saveGameSlot"] .vp-status-value')?.textContent?.trim());

    check('the strip shows which slot the game is on, on the left',
        await page.evaluate(() => {
            const item = document.querySelector('.vp-status-left [data-status="saveGameSlot"]');
            return item !== null;
        }));
    check('and hardware leads the right-hand group',
        await page.evaluate(() =>
            document.querySelector('.vp-status-right')?.firstElementChild
                ?.getAttribute('data-status') === 'hardware'));
    check('the game starts on slot A', await slotReading() === 'Slot A');

    check('Select Save Game Slot opens a list', await run('Select Save Game Slot'));
    const slots = (await pickEntries()).map(entry => entry.label);
    check('with a slot for every letter', slots.length === 26);
    check('from A', slots[0] === 'Slot A');
    check('to Z', slots[25] === 'Slot Z');
    check('and it says which one is being played', await page.evaluate(() =>
        [...document.querySelectorAll('.vp-pick-item')]
            .some(item => /Slot A/.test(item.textContent ?? '') && /In play/.test(item.textContent ?? ''))));

    check('choosing another one switches to it', await choose('Slot B'));
    await wait(1200);
    check('the setting remembers it', await stored('saveGameSlot') === 'B');
    check('the strip reads it back', await slotReading() === 'Slot B');
    check('and the game says it changed cartridges',
        (await toasts()).some(text => /slot B/i.test(text)));

    const afterB = await savedFiles();
    check('slot A was written under its plain name', afterB.some(file => file.endsWith('/save.sram')));

    check('and back again', await run('Select Save Game Slot') && await choose('Slot A'));
    await wait(1200);
    check('the setting follows', await stored('saveGameSlot') === 'A');
    const afterA = await savedFiles();
    check('slot B has a file of its own', afterA.some(file => file.endsWith('/save.B.sram')));
    check('beside the one slot A keeps', afterA.some(file => file.endsWith('/save.sram')));

    check('the list opens again', await run('Select Save Game Slot'));
    const buttoned = await page.evaluate(() =>
        [...document.querySelectorAll('.vp-pick-item')]
            .filter(item => item.querySelector('.vp-pick-button'))
            .map(item => item.querySelector('span')?.textContent?.trim()));
    check('only the slot in play has a button', JSON.stringify(buttoned) === JSON.stringify(['Slot A']));
    check('which says what it does', await page.evaluate(() =>
        document.querySelector('.vp-pick-button')?.getAttribute('title')) === 'Delete Current Save Game Slot');
    await page.click('.vp-pick-button');
    await wait(400);
    check('pressing it closes the list', await page.$('.vp-pick') === null);
    check('and asks first', await page.evaluate(() =>
        document.querySelector('.vp-modal h2')?.textContent) === 'Delete Current Save Game Slot');
    check('without having switched slots', await stored('saveGameSlot') === 'A');
    await page.keyboard.press('Enter');
    await wait(1500);
    const afterDelete = await savedFiles();
    check('slot A\'s save is gone', !afterDelete.some(file => file.endsWith('/save.sram')));
    check('slot B\'s is left alone', afterDelete.some(file => file.endsWith('/save.B.sram')));
    check('and the game is still on slot A', await slotReading() === 'Slot A');
}

console.log('\nThe recent list, from the palette');
check('Continue Recently Opened lists it', await run('Continue Recently Opened…'));
const recents = (await pickEntries()).map(entry => entry.label);
check('by its name, without the extension', recents.includes('probe'));
await page.keyboard.press('Escape');
await wait(300);

check('Clear Recently Opened Files asks first', await run('Clear Recently Opened Files'));
await page.waitForSelector('.vp-modal', { timeout: 3000 });
check('and says how many it would forget',
    /1 remembered ROM/.test(await page.evaluate(() =>
        document.querySelector('.vp-modal')?.textContent ?? '')));
await page.keyboard.press('Enter');
await wait(800);

await run('Continue Recently Opened…');
check('nothing is remembered afterwards', await page.$('.vp-pick') === null);
check('and it says so rather than opening an empty list',
    (await toasts()).some(text => /No ROM has been opened yet/.test(text)));

console.log('\nThe consolidated VCU debug panel');
const panelTabs = () => page.$$eval('.lm-TabBar-tab',
    tabs => tabs.map(tab => tab.textContent?.trim() ?? ''));
// .vp-memory-regions is the wrapper the panel puts around its RadioSelect for this, as the options' class names are
// generated; the options are the leaves inside carrying text
const memoryRegions = async () => {
    await activatePanel('Memory');
    return page.$$eval('.vp-memory-regions div',
        nodes => nodes
            .filter(node => node.children.length === 0 && node.textContent?.trim())
            .map(node => node.textContent.trim()));
};

check('Debug mode opens', await run('Toggle Debug Mode'));
await wait(500);
check('the VCU panel is available', await activatePanel('VCU'));
// 1024 in VBC 1.0: 128 BG plus 128 OBJ palettes of four. See VBC_STATUS.md
check('VCU shows all 1024 current CRAM colors', await page.evaluate(() =>
    document.querySelectorAll('.vp-vcu-cram-color').length === 1024));
check('VCU contains the cartridge classification', /Cartridge/.test(await page.evaluate(() =>
    document.querySelector('.vp-vcu-panel')?.textContent ?? '')));
check('the registers are shown bit by bit', await page.evaluate(() =>
    document.querySelectorAll('.vp-vcu-bit').length === 5 * 16));
check('and the reserved half of the block is reported',
    /Reserved/.test(await page.evaluate(() =>
        document.querySelector('.vp-vcu-panel')?.textContent ?? '')));
check('the memory panel offers the VCU aperture', (await memoryRegions()).includes('VCU'));

// what VB Color adds to other panels goes away with it; the VCU panel stays open and says which machine runs, as a
// panel openable in only one hardware mode was one nobody found
check('Set Hardware Mode opens again', await run('Set Hardware Mode'));
await choose('Virtual Boy');
await wait(700);
check('the VCU panel stays open on an original Virtual Boy',
    (await panelTabs()).includes('VCU'));
check('and says there is no VCU to read',
    /original Virtual Boy/.test(await page.evaluate(() =>
        document.querySelector('[id$=":vcu"]')?.textContent ?? '')));
check('while the memory panel stops offering the aperture',
    !(await memoryRegions()).includes('VCU'));
check('Set Hardware Mode opens once more', await run('Set Hardware Mode'));
await choose('VB Color');
await wait(1200);
// the aperture stands in for the set, read from the same fact as the VCU panel but not closable by hand. The VCU tab
// isn't reopened behind the user's back, as the saved layout remembers a close; Reset Layout brings it back
check('the memory panel offers the aperture again',
    (await memoryRegions()).includes('VCU'));

check('Play mode opens again', await run('Toggle Debug Mode'));
await wait(300);

console.log('\nVBC information while support is disabled');
check('VB Color Support can be disabled with a ROM running',
    await run('Toggle VB Color Support'));
await wait(800);
await page.click('.vp-titlebar-rom');
await page.waitForSelector('.vp-rom-info', { timeout: 3000 });
check('Game Information hides VB Color details', !/VB Color/.test(await page.evaluate(() =>
    document.querySelector('.vp-rom-info')?.textContent ?? '')));
await page.keyboard.press('Escape');
await wait(200);

check('Debug mode opens', await run('Toggle Debug Mode'));
await wait(500);
check('the VCU panel still opens', await activatePanel('VCU'));
check('and says VB Color support is switched off',
    /support is switched off/.test(await page.evaluate(() =>
        document.querySelector('[id$=":vcu"]')?.textContent ?? '')));
check('ROM Info hides VB Color details', !/VB Color/.test(await page.evaluate(() =>
    document.querySelector('.vp-rom-info-panel')?.textContent ?? '')));

check('the Memory panel is available', await activatePanel('Memory'));
check('Memory hides the VCU shortcut', !await page.evaluate(() =>
    [...document.querySelectorAll('.vp-memory-toolbar button')]
        .some(button => button.textContent?.trim() === 'VCU')));
check('the Registers panel is available', await activatePanel('Registers'));
check('Registers hide the VCU group', !await page.evaluate(() =>
    [...document.querySelectorAll('.vp-registers-panel legend')]
        .some(legend => legend.textContent?.trim() === 'VCU')));

check('nothing errored throughout', errors.length === 0);
if (errors.length) { console.log(errors.slice(0, 5)); }

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
