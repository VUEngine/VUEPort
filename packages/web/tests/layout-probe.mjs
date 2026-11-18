/**
 * Checks that the built web app lays out: title bar and dock stacked, the dock's tab bars visible when there is more
 * than the screen, a ROM starting without picking a mode. Measures painted boxes, as the dock is a Lumino tree of
 * absolutely positioned children, so `.vp-dock-host` proves nothing. Drives the real interface; nothing is exposed on
 * `window`.
 *
 * Usage: node tests/layout-probe.mjs (after `yarn build`)
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
    }
}

function section(name) {
    console.log(`\n${name}`);
}

async function appears(page, label, selector, timeout = 5000) {
    try {
        await page.waitForSelector(selector, { timeout });
        return true;
    } catch {
        failures++;
        console.log(`  FAIL ${label}: \`${selector}\` never appeared`);
        return false;
    }
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

// a ROM with a real header for the ROM Info panel: it sits 544 bytes from the end, 20 bytes of name, maker at +25,
// four-character code at +27, version in the last byte. One MB is 8 MBit, as the panel quotes
const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'probe.vb');
const ROM_NAME = 'VUEPORT PROBE';
const ROM_MAKER = 'VU';
const ROM_CODE = 'VPRB';
const ROM_VERSION = 3;
const ROM_SIZE_MBIT = 8;
{
    const rom = Buffer.alloc(ROM_SIZE_MBIT * 131072);
    const header = rom.length - 544;
    rom.write(ROM_NAME.padEnd(20, ' '), header, 'ascii');
    rom.write(ROM_MAKER, header + 25, 'ascii');
    rom.write(ROM_CODE, header + 27, 'ascii');
    rom[header + 31] = ROM_VERSION;
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

// the title bar looks the ROM up on Planet VB; answered with a hit, as even a handled 404 is logged to the
// console by Chrome and would trip the checks below
await page.setRequestInterception(true);
// chunks failed on purpose, see 'A chunk that will not load'; mutated, never reassigned, as the handler closes over it
const blockedChunks = [];
page.on('request', request => {
    const url = request.url();
    if (blockedChunks.some(pattern => pattern.test(url))) {
        // what a stale deploy answers: a `text/plain` 404, which the browser refuses as a module on its MIME type
        request.respond({ status: 404, contentType: 'text/plain', body: 'not found' });
        return;
    }
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
            body: JSON.stringify({
                id: 1, title: 'Probe Game', hash: { crc32: '00000000' },
                item: [{ id: 1, title: 'Probe Game', type: 'homebrew' }],
            }),
        });
        return;
    }
    request.continue();
});

const boxes = () => page.evaluate(() => {
    const box = selector => {
        const element = document.querySelector(selector);
        if (!element) { return undefined; }
        const rect = element.getBoundingClientRect();
        return { y: Math.round(rect.y), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
    };
    // each visible tab bar's height beside its tallest tab: Lumino gives a bar its CSS minimum, so it can be a pixel
    // tall with full-size tabs inside ("the tab headers are missing")
    const tabBars = [...document.querySelectorAll('.vp-dock .lm-TabBar')]
        .filter(element => getComputedStyle(element).display !== 'none')
        .map(element => ({
            bar: Math.round(element.getBoundingClientRect().height),
            tab: Math.max(0, ...[...element.querySelectorAll('.lm-TabBar-tab')]
                .map(tab => Math.round(tab.getBoundingClientRect().height))),
        }));
    return {
        titlebar: box('.vp-titlebar'),
        status: box('.vp-status'),
        // the panels, which Lumino positions absolutely and which escaped over the toolbar; dock and host are flow
        // children that sit correctly even when the layout is broken
        panel: box('.vp-dock .lm-DockPanel-widget'),
        canvas: !!document.querySelector('.vp-dock canvas'),
        visibleTabBarHeights: tabBars,
    };
});

await page.goto(origin, { waitUntil: 'networkidle0' });

section('Before a ROM');
{
    check('the library is shown', await page.$('.vp-library') !== null, true);
    check("the emulator's tokens reach the page",
        await page.evaluate(() => getComputedStyle(document.documentElement)
            .getPropertyValue('--vp-space').trim()), '6px');
    check('the page is named after the application', await page.title(), 'VUEPort');
    check('loading the page reports no errors', errors, []);
}

section('Opening a ROM through the interface');
{
    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await chooser.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const seen = await boxes();
    check('the emulator starts without a mode being picked', seen.canvas, true);
    check('the page is renamed after the ROM', await page.title(), 'Probe Game');
    check('the title bar is at the top', seen.titlebar?.y, 0);
    check('the panels begin below the title bar, not over it',
        seen.panel !== undefined && seen.titlebar !== undefined
        && seen.panel.y >= seen.titlebar.bottom, true);
    check('the status bar is below the panels',
        seen.status !== undefined && seen.panel !== undefined
        && seen.status.y >= seen.panel.bottom - 1, true);
    // within a pixel, as Lumino can place panels on a subpixel boundary
    check('the panels reach the status bar',
        seen.panel !== undefined && seen.status !== undefined
        && Math.abs(seen.panel.bottom - seen.status.y) <= 1, true);
    check('the status bar reaches the bottom of the window', seen.status?.bottom, 800);
    check('play mode hides the tab bars', seen.visibleTabBarHeights, []);
}

section('Keyboard shortcuts for the emulator\'s own actions');
{
    // pad buttons and emulator actions share the keymap, and a forgotten action binding only silences the keyboard.
    // Read off the pause button: filled while paused, secondary while running
    const pauseButton = () => page.evaluate(() => {
        // by name, as the strip's first control is the host's and the order moves
        const button = document.querySelector('.vp-strip-button[data-control="pause"]');
        return { className: button.className, title: button.getAttribute('aria-label') };
    });

    const before = await pauseButton();
    check('the emulator starts running',
        before.className.includes('vp-strip-button-on'), false);
    check('and its pause control names its key', /\(/.test(before.title), true);

    // focus the pane directly, as with a single-eye palette the canvas reports no clickable point to the driver
    await page.$eval('.vp-screen', el => el.focus());
    await page.keyboard.press('Space');
    await new Promise(resolve => setTimeout(resolve, 500));
    const after = await pauseButton();
    check('pressing Space pauses it',
        after.className.includes('vp-strip-button-on'), true);

    await page.keyboard.press('Space');
    await new Promise(resolve => setTimeout(resolve, 500));
    check('and pressing it again resumes',
        (await pauseButton()).className.includes('vp-strip-button-on'), false);
    check('nothing errored', errors, []);
}

section('The settings window');
{
    // the core leaves its form controls' looks to the host, so an unstyled host gets browser defaults everywhere
    await page.evaluate(() =>
        document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
    await new Promise(resolve => setTimeout(resolve, 700));

    const fields = await page.evaluate(() => {
        const window_ = document.querySelector('.vp-window');
        if (!window_) { return undefined; }
        return [...window_.querySelectorAll('input')].map(input => {
            const style = getComputedStyle(input);
            return {
                filled: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
                outlined: style.borderTopStyle !== 'none' && parseFloat(style.borderTopWidth) > 0,
                sized: parseFloat(style.fontSize) > 0,
            };
        });
    });
    check('the settings window opens', fields !== undefined, true);
    check('and has fields in it', (fields?.length ?? 0) > 0, true);
    // checkboxes and ranges are painted from `color-scheme`, so only text fields carry these
    const text = fields?.filter(field => field.outlined) ?? [];
    check('its text fields are filled by the host', text.filter(f => !f.filled).length, 0);
    check('and sized by the host', text.filter(f => !f.sized).length, 0);

    // rewind lives in the Emulation pane, and the title bar's button opens the head of the rail (see
    // `togglePreferencesWindow`), so getting there is a step of its own
    const emulationPane = await page.evaluate(() => {
        for (const tab of document.querySelectorAll('.vp-settings-tab')) {
            if ((tab.textContent ?? '').trim() === 'Emulation') {
                tab.click();
                return true;
            }
        }
        return false;
    });
    await new Promise(resolve => setTimeout(resolve, 700));
    check('the Emulation pane is reachable', emulationPane, true);

    const paneHas = async wanted => page.evaluate(text =>
        (document.querySelector('.vp-window-body')?.textContent ?? '').includes(text), wanted);
    const toggleRewind = () => page.evaluate(() => {
        for (const box of document.querySelectorAll('.vp-window-body button.vp-switch')) {
            if (/Rewind/i.test(box.getAttribute('aria-label') ?? '')) { box.click(); return true; }
        }
        return false;
    });
    check('rewind is off, so its detail is not offered',
        [await paneHas('Rewind Granularity'), await paneHas('Rewind Buffer Size')], [false, false]);
    check('the switch is there to find', await toggleRewind(), true);
    await new Promise(resolve => setTimeout(resolve, 400));
    check('turning it on brings the detail out',
        [await paneHas('Rewind Granularity'), await paneHas('Rewind Buffer Size')], [true, true]);
    await toggleRewind();
    await new Promise(resolve => setTimeout(resolve, 400));
    check('and turning it off puts it away again',
        [await paneHas('Rewind Granularity'), await paneHas('Rewind Buffer Size')], [false, false]);

    const tabNames = () => page.evaluate(() =>
        [...document.querySelectorAll('.vp-settings-tab')]
            .map(tab => (tab.textContent || '').trim()));
    check('Save Data has a tab of its own', (await tabNames()).includes('Save Data'), true);
    // a browser always gets the current version, so there is no Updates pane; see `availableTabs` in
    // `web-settings-dialog.tsx`
    check('and Updates is not offered to a browser', (await tabNames()).includes('Updates'), false);
    const onSaveData = await page.evaluate(() => {
        for (const tab of document.querySelectorAll('.vp-settings-tab')) {
            if ((tab.textContent || '').trim() === 'Save Data') {
                tab.click();
                return true;
            }
        }
        return false;
    });
    await new Promise(resolve => setTimeout(resolve, 700));
    check('and it opens', onSaveData, true);
    const saveDataPane = await page.evaluate(() =>
        document.querySelector('.vp-window-body')?.textContent ?? '');
    check('with the slot and what a new save holds',
        [/Save Game Slot/, /New Save File Contents/]
            .filter(pattern => !pattern.test(saveDataPane)), []);
    check('and not where the files go', /Storage Location/.test(saveDataPane), false);
    const onFiles = await page.evaluate(() => {
        for (const tab of document.querySelectorAll('.vp-settings-tab')) {
            if ((tab.textContent || '').trim() === 'Files') {
                tab.click();
                return true;
            }
        }
        return false;
    });
    await new Promise(resolve => setTimeout(resolve, 700));
    check('Files has a tab of its own, and it opens', onFiles, true);
    check('carrying where the files go',
        /Storage Location/.test(await page.evaluate(() =>
            document.querySelector('.vp-window-body')?.textContent ?? '')), true);
    const emulationPaneAgain = await page.evaluate(() => {
        for (const tab of document.querySelectorAll('.vp-settings-tab')) {
            if ((tab.textContent || '').trim() === 'Emulation') {
                tab.click();
                return true;
            }
        }
        return false;
    });
    await new Promise(resolve => setTimeout(resolve, 700));
    check('Emulation is still there', emulationPaneAgain, true);
    check('and no longer carries the save settings',
        /Save Game Slot/.test(await page.evaluate(() =>
            document.querySelector('.vp-window-body')?.textContent ?? '')), false);

    await page.evaluate(() =>
        document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
    await new Promise(resolve => setTimeout(resolve, 400));
    check('nothing errored', errors, []);
}

section('The floating transport');
{
    const stripOpacity = () => page.evaluate(() => {
        const strip = document.querySelector('.vp-strip');
        return strip ? getComputedStyle(strip).opacity : undefined;
    });
    await page.mouse.move(640, 500);
    await new Promise(resolve => setTimeout(resolve, 400));
    check('moving the pointer brings the transport up', await stripOpacity(), '1');

    // longer than the strip's idle delay (`STRIP_IDLE_DELAY` in `Emulator.tsx`), with room to spare
    await new Promise(resolve => setTimeout(resolve, 6400));
    check('and it goes once the pointer is still', await stripOpacity(), '0');

    await page.$eval('.vp-screen', el => el.focus());
    await page.keyboard.press('KeyQ');
    await new Promise(resolve => setTimeout(resolve, 400));
    check('what is switched on is still said',
        await page.evaluate(() => [...document.querySelectorAll('.vp-state-badge')]
            .map(badge => (badge.textContent || '').trim())), ['Muted']);

    const shape = await page.evaluate(() => {
        const badge = document.querySelector('.vp-state-badge');
        const reference = document.createElement('button');
        reference.className = 'vp-screen-badge';
        badge.parentElement.appendChild(reference);
        const read = element => {
            const style = getComputedStyle(element);
            return [
                style.backgroundColor, style.borderRadius, style.color,
                style.fontSize, style.fontFamily, style.height, style.padding,
            ].join(' | ');
        };
        const seen = { badge: read(badge), reference: read(reference) };
        reference.remove();
        return { ...seen, tag: badge.tagName, clickable: getComputedStyle(badge).pointerEvents };
    });
    check('the state badges wear the same pill as the badges opposite',
        shape.badge, shape.reference);
    check('and each is a button', shape.tag, 'BUTTON');
    check('that the pointer can actually reach', shape.clickable, 'auto');

    await page.click('.vp-state-badge[data-state="muted"]');
    await new Promise(resolve => setTimeout(resolve, 400));
    check('and pressing one switches off what it announces',
        await page.evaluate(() => document.querySelectorAll('.vp-state-badge').length), 0);
    check('nothing errored', errors, []);
}

section('Debug mode');
{
    // the mode control is a custom widget, so the probe seeds the persisted mode and reloads, the path a returning
    // visitor takes
    await page.evaluate(() => window.localStorage.setItem(
        'vueport.state', JSON.stringify({ muted: false, saveSlot: 1, mode: 'debug' })));
    errors.length = 0;
    await page.goto(origin, { waitUntil: 'networkidle0' });

    const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('.vp-library-side-foot .vp-button'),
    ]);
    await chooser.accept([romPath]);
    await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const seen = await boxes();
    check('the debug layout opens tab bars', seen.visibleTabBarHeights.length > 0, true);
    const unstyledTabScrollbars = await page.evaluate(() =>
        [...document.querySelectorAll('.vp-dock .lm-TabBar-content-container')]
            .filter(container => !container.classList.contains('ps')
                || getComputedStyle(container).overflowX !== 'hidden'
                || !container.querySelector(':scope > .ps__rail-x'))
            .length);
    check('the tab rows use overlay scrollbars', unstyledTabScrollbars, 0);
    check('every tab bar is as tall as the tabs inside it',
        seen.visibleTabBarHeights.filter(({ bar, tab }) => bar < tab), []);
    check('and tall enough to read',
        seen.visibleTabBarHeights.filter(({ bar }) => bar < 20), []);
    check('the panels still begin below the title bar',
        seen.panel !== undefined && seen.titlebar !== undefined
        && seen.panel.y >= seen.titlebar.bottom, true);
    check('nothing errored', errors, []);
}

section('Adding a panel');
{
    const openPanels = () => page.evaluate(() =>
        [...document.querySelectorAll('.vp-dock .lm-TabBar-tab')]
            .map(tab => (tab.textContent || '').trim()).filter(Boolean));

    const before = await openPanels();
    check('a tab group offers an add button',
        await page.$('.vp-dock .lm-TabBar-addButton') !== null, true);

    await page.click('.vp-dock .lm-TabBar-addButton');
    if (!await appears(page, 'pressing "+" opens the panel picker', '.vp-pick')) {
        await browser.close();
        server.close();
        console.log(`\n${failures} check(s) failed.`);
        process.exit(1);
    }

    const offered = await page.evaluate(() =>
        [...document.querySelectorAll('.vp-pick-item')]
            .map(item => item.textContent.trim()));
    check('the picker offers panels', offered.length > 0, true);
    check('the picker offers the Registers panel', offered.some(label => /^Registers/.test(label)), true);
    check('and none of the five game strips',
        offered.filter(label => /^(Cheats|Macros|Patches|Colors|Achievements)/.test(label)), []);
    check('and never offers the screen', offered.some(label => /^Screen/.test(label)), false);
    check('panels already open are marked',
        offered.some(label => label.includes('Move here')), true);

    const wanted = await page.evaluate(() => {
        const item = [...document.querySelectorAll('.vp-pick-item')]
            .find(element => !element.querySelector('.vp-pick-description'));
        return item ? item.querySelector('span').textContent.trim() : undefined;
    });
    check('the picker offers a panel that is not open yet', typeof wanted, 'string');
    check('and it really is not open', before.some(label => label.startsWith(wanted)), false);

    await page.type('.vp-pick-filter', wanted);
    await new Promise(resolve => setTimeout(resolve, 200));
    const filtered = await page.evaluate(() =>
        [...document.querySelectorAll('.vp-pick-item')].map(i => i.textContent.trim()));
    check('typing filters the list down', filtered.length, 1);

    await page.keyboard.press('Enter');
    await new Promise(resolve => setTimeout(resolve, 600));

    check('the picker closes', await page.$('.vp-pick'), null);
    const after = await openPanels();
    check('the chosen panel is now open', after.some(label => label.startsWith(wanted)), true);
    check('nothing errored', errors, []);
}

section('Dismissing the picker');
{
    await page.click('.vp-dock .lm-TabBar-addButton');
    await appears(page, 'the picker opens again', '.vp-pick');
    const openCount = (await page.$$('.vp-dock .lm-TabBar-tab')).length;
    await page.keyboard.press('Escape');
    await new Promise(resolve => setTimeout(resolve, 400));
    check('Escape closes the picker', await page.$('.vp-pick'), null);
    check('and opens nothing', (await page.$$('.vp-dock .lm-TabBar-tab')).length, openCount);
}

section('The ROM Info panel');
{
    await page.click('.vp-dock .lm-TabBar-addButton');
    await appears(page, 'the picker opens for ROM Info', '.vp-pick');
    await page.type('.vp-pick-filter', 'ROM Info');
    await new Promise(resolve => setTimeout(resolve, 200));
    await page.keyboard.press('Enter');
    await new Promise(resolve => setTimeout(resolve, 800));

    const rows = await page.evaluate(() => {
        const panel = [...document.querySelectorAll('.vp-dock .lm-DockPanel-widget')]
            .find(element => /MBit/.test(element.textContent || ''));
        if (!panel) { return undefined; }
        return [...panel.querySelectorAll('tr')].map(row =>
            [...row.querySelectorAll('td, th')].map(cell => cell.textContent.trim()));
    });

    check('the panel is showing something', rows !== undefined && rows.length > 0, true);
    const flat = (rows ?? []).map(row => row.join(' | ')).join('\n');
    check('it reads the name out of the header', /VUEPORT PROBE/.test(flat), true);
    check('and the maker', new RegExp(ROM_MAKER).test(flat), true);
    check('and the code', new RegExp(ROM_CODE).test(flat), true);
    check('and the version', new RegExp(`1\\.${ROM_VERSION}`).test(flat), true);
    check('and the size in MBit', new RegExp(`${ROM_SIZE_MBIT}\\s*(\\||$|MBit)`, 'm').test(flat), true);
    // the whole file's CRC32, which the cheat database keys on
    check('and the ROM\'s CRC32', /CRC32 \| [0-9a-f]{8}$/m.test(flat), true);
    // a browser cannot reach the build's .map file, so the row is absent rather than "Unknown"
    check('with no Build Mode row, this ROM having no build', /Build Mode/.test(flat), false);
    const gap = await page.evaluate(() => {
        const row = document.querySelector('.vp-rom-info-group');
        return row ? parseFloat(getComputedStyle(row.querySelector('th')).paddingTop) : 0;
    });
    check('and a gap above Size', gap > 0, true);
    check('nothing errored', errors, []);
}

section('Closing a tab');
{
    const tabNames = () => page.evaluate(() =>
        [...document.querySelectorAll('.vp-dock .lm-TabBar-tab')]
            .map(tab => (tab.textContent || '').trim()).filter(Boolean));

    const icon = await page.evaluate(() => {
        const tab = [...document.querySelectorAll('.vp-dock .lm-TabBar-tab.lm-mod-closable')]
            .find(candidate => candidate.classList.contains('lm-mod-current'));
        if (!tab) { return undefined; }
        const element = tab.querySelector('.lm-TabBar-tabCloseIcon');
        const style = getComputedStyle(element);
        const before = getComputedStyle(element, '::before');
        const rect = element.getBoundingClientRect();
        return {
            label: (tab.textContent || '').trim(),
            // a codicon glyph without the codicon font is an invisible box that still closes the tab
            drawn: before.content !== 'none' && before.content !== '""'
                && !/codicon/i.test(style.fontFamily),
            // the core gives the box 2px padding inside 16px and a 16px line, which spills unless the host overrides it
            spills: element.scrollHeight > element.clientHeight,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
        };
    });

    check('the current tab has a close button', icon !== undefined, true);
    check('the close button is actually drawn', icon?.drawn, true);
    check('and its glyph fits its box', icon?.spills, false);

    const before = await tabNames();
    await page.mouse.click(icon.x, icon.y);
    await new Promise(resolve => setTimeout(resolve, 600));
    const after = await tabNames();
    check('clicking it closes that tab', after.includes(icon.label), false);
    check('and closes only that one', after.length, before.length - 1);
    check('nothing errored', errors, []);
}

section('Resetting the layout');
{
    const panelNames = () => page.evaluate(() =>
        [...document.querySelectorAll('.vp-dock .lm-TabBar-tab')]
            .map(tab => (tab.textContent || '').trim()).filter(Boolean));

    const reset = await page.$('.vp-dock .lm-TabBar-resetButton');
    check('a tab group offers a reset button', reset !== null, true);
    check('and it sits beside the add button', await page.evaluate(() => {
        const bar = document.querySelector('.vp-dock .lm-TabBar');
        const add = bar.querySelector('.lm-TabBar-addButton');
        const rst = bar.querySelector('.lm-TabBar-resetButton');
        return !!add && !!rst && add.nextElementSibling === rst;
    }), true);
    check('both dock buttons are actually drawn', await page.evaluate(() => {
        const drawn = selector => {
            const element = document.querySelector(`.vp-dock ${selector}`);
            const before = getComputedStyle(element, '::before');
            // a codicon glyph without the codicon font paints nothing, so require a real character in a font we have
            return before.content !== 'none' && before.content !== '""'
                && !/codicon/i.test(getComputedStyle(element).fontFamily);
        };
        return drawn('.lm-TabBar-addButton') && drawn('.lm-TabBar-resetButton');
    }), true);

    const started = await panelNames();

    await page.click('.vp-dock .lm-TabBar-resetButton');
    if (!await appears(page, 'pressing reset asks first', '.vp-modal')) {
        await browser.close();
        server.close();
        console.log(`\n${failures} check(s) failed.`);
        process.exit(1);
    }
    check('the question names the action', await page.evaluate(() =>
        document.querySelector('.vp-modal h2').textContent.trim()), 'Reset Layout?');

    await page.evaluate(() => [...document.querySelectorAll('.vp-modal button')]
        .find(button => button.textContent.trim() === 'Cancel').click());
    await new Promise(resolve => setTimeout(resolve, 400));
    check('canceling closes the question', await page.$('.vp-modal'), null);
    check('and leaves the layout alone', await panelNames(), started);

    await page.click('.vp-dock .lm-TabBar-addButton');
    await appears(page, 'the picker opens', '.vp-pick');
    const extra = await page.evaluate(() => {
        const item = [...document.querySelectorAll('.vp-pick-item')]
            .find(element => !element.querySelector('.vp-pick-description'));
        return item.querySelector('span').textContent.trim();
    });
    await page.type('.vp-pick-filter', extra);
    await new Promise(resolve => setTimeout(resolve, 200));
    await page.keyboard.press('Enter');
    await new Promise(resolve => setTimeout(resolve, 600));
    check('the extra panel is open', (await panelNames()).includes(extra), true);

    await page.click('.vp-dock .lm-TabBar-resetButton');
    await appears(page, 'reset asks again', '.vp-modal');
    await page.evaluate(() => [...document.querySelectorAll('.vp-modal button')]
        .find(button => button.textContent.trim() === 'Reset').click());
    await new Promise(resolve => setTimeout(resolve, 800));
    check('confirming closes the question', await page.$('.vp-modal'), null);
    check('and the extra panel is gone', (await panelNames()).includes(extra), false);
    check('nothing errored', errors, []);
}

section('Dragging a split handle');
{
    // a sash used to be draggable until the far panel had no box left. Lumino clamps sashes to the minimums on the
    // panel nodes, so this checks they exist and a drag stops at them
    const minimums = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return {
            width: parseFloat(root.getPropertyValue('--vp-panel-min-width')),
            height: parseFloat(root.getPropertyValue('--vp-panel-min-height')),
        };
    });
    check('a panel has a minimum width worth having', minimums.width >= 100, true);
    check('and a minimum height worth having', minimums.height >= 40, true);

    // every placed panel's real box; `.lm-DockPanel-widget` is the panel itself, which carries the minimums
    const panelBoxes = () => page.evaluate(() =>
        [...document.querySelectorAll('.vp-dock .lm-DockPanel-widget')]
            .filter(element => getComputedStyle(element).display !== 'none')
            .map(element => {
                const rect = element.getBoundingClientRect();
                return { width: Math.round(rect.width), height: Math.round(rect.height) };
            }));

    // drags a sash far past the dock's edge, so only the clamp stops it. `orientation` is Lumino's, naming the split:
    // `horizontal` is the vertical line between two columns
    const shove = async (orientation, corner) => {
        const handle = await page.$(`.vp-dock .lm-DockPanel-handle[data-orientation=${orientation}]:not(.lm-mod-hidden)`);
        if (!handle) { return false; }
        const box = await handle.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(corner.x, corner.y, { steps: 10 });
        await page.mouse.up();
        await new Promise(resolve => setTimeout(resolve, 400));
        return true;
    };

    const before = await panelBoxes();
    check('the default layout has panels side by side and stacked', before.length >= 3, true);

    check('the columns are separated by a sash', await shove('horizontal', { x: -200, y: 400 }), true);
    let seen = await panelBoxes();
    check('the same panels are still placed', seen.length, before.length);
    check('no panel is squeezed below its minimum width',
        seen.filter(({ width }) => width < minimums.width - 1), []);
    check('and the sash did move, up against that minimum',
        seen.some(({ width }) => width <= minimums.width + 2), true);

    check('the stacked panels are separated by a sash', await shove('vertical', { x: 200, y: -200 }), true);
    seen = await panelBoxes();
    check('the same panels are still placed after both drags', seen.length, before.length);
    check('no panel is squeezed below its minimum height',
        seen.filter(({ height }) => height < minimums.height - 1), []);
    check('and that sash moved too',
        seen.some(({ height }) => height <= minimums.height + 2), true);

    // Lumino writes the minimums' sum onto the dock as an inline `min-width`, which must not push the emulator out
    // of the window
    check('the panel minimums do not make the page scroll', await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth
        || document.documentElement.scrollHeight > document.documentElement.clientHeight), false);

    await page.click('.vp-dock .lm-TabBar-resetButton');
    await appears(page, 'reset asks before restoring the layout', '.vp-modal');
    await page.evaluate(() => [...document.querySelectorAll('.vp-modal button')]
        .find(button => button.textContent.trim() === 'Reset').click());
    await new Promise(resolve => setTimeout(resolve, 800));
    check('nothing errored while resizing', errors, []);
}

section('Dragging a tab');
{
    // Lumino leaves the drag image and drop overlay unstyled, so both are invisible unless the host styles them;
    // only looking catches that. The target is well inside the dock, as empty space between panels is none
    const target = await page.evaluate(() => {
        const rect = document.querySelector('.vp-dock').getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width * 0.8), y: Math.round(rect.y + rect.height * 0.8) };
    });
    const tab = await page.$('.vp-dock .lm-TabBar-tab');
    const box = await tab.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 150, { steps: 8 });
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await new Promise(resolve => setTimeout(resolve, 400));

    const drag = await page.evaluate(() => {
        const transparent = value => value === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(value);
        const image = document.querySelector('.lm-TabBar-tab.lm-mod-drag-image');
        const overlay = document.querySelector('.lm-DockPanel-overlay:not(.lm-mod-hidden)');
        const handle = document.querySelector('.lm-DockPanel-handle');
        const overlayStyle = overlay && getComputedStyle(overlay);
        return {
            dragImageShown: !!image,
            dragImageHasShadow: !!image && getComputedStyle(image).boxShadow !== 'none',
            overlayShown: !!overlay,
            overlayIsVisible: !!overlayStyle
                && !transparent(overlayStyle.backgroundColor)
                && overlayStyle.borderTopStyle !== 'none',
            handleIsVisible: !!handle && !transparent(getComputedStyle(handle).backgroundColor),
            pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth
                || document.documentElement.scrollHeight > document.documentElement.clientHeight,
        };
    });

    check('a drag image is shown', drag.dragImageShown, true);
    check('the drag image is lifted by a shadow', drag.dragImageHasShadow, true);
    check('the drop target is marked', drag.overlayShown, true);
    check('and the mark is actually visible', drag.overlayIsVisible, true);
    check('the lines between tab groups are visible', drag.handleIsVisible, true);
    check('dragging does not make the page scroll', drag.pageScrolls, false);

    await page.mouse.up();
    await new Promise(resolve => setTimeout(resolve, 300));
    check('the page still does not scroll afterwards', await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth
        || document.documentElement.scrollHeight > document.documentElement.clientHeight), false);
    check('nothing errored while dragging', errors, []);
}

section('A chunk that will not load');
{
    // windows and settings panes are lazy chunks; a missing one (a tab open across a deploy) used to throw during
    // render with no error boundary and take down the whole application
    blockedChunks.push(/chunks\/web-about-/);
    errors.length = 0;

    const clickTab = label => page.evaluate(wanted => {
        for (const tab of document.querySelectorAll('.vp-settings-tab')) {
            if ((tab.textContent || '').trim() === wanted) { tab.click(); return true; }
        }
        return false;
    }, label);

    await page.evaluate(() =>
        document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
    await new Promise(resolve => setTimeout(resolve, 700));
    check('the settings window opens on a pane that loads', await page.$('.vp-window') !== null, true);

    check('About is on the rail', await clickTab('About VUEPort'), true);
    await new Promise(resolve => setTimeout(resolve, 2000));

    check('the pane says it could not be loaded',
        await page.$('.vp-chunk-error') !== null, true);
    check('and offers a way out of it', await page.evaluate(() =>
        (document.querySelector('.vp-chunk-error button')?.textContent || '').trim().length > 0), true);
    check('the window around it is still standing', await page.$('.vp-window') !== null, true);
    check('and the emulator is still running', await page.$('.vp-dock canvas') !== null, true);

    check('another pane is still reachable', await clickTab('Emulation'), true);
    await new Promise(resolve => setTimeout(resolve, 700));
    check('and the message is gone with it', await page.$('.vp-chunk-error'), null);
    check('leaving the pane it asked for', await page.evaluate(() =>
        (document.querySelector('.vp-window-body')?.textContent || '').includes('Rewind')), true);
}

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
