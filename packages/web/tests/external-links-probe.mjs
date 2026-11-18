/**
 * The desktop webview drops target="_blank", so outward links go through the shell, caught once on the way out of the
 * document (src/desktop-external.ts). That also covers links in vueport-core, where nothing knows Tauri. Checked with
 * the shell faked: a real About pane link is clicked and the shell request is read back. Which addresses may be opened
 * is tested where it lives, in src-tauri/src/external.rs.
 *
 * Usage: node tests/external-links-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`
        + (ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
    if (!ok) {
        failures++;
    }
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
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

// the shell, as far as the page can tell. Every command answers with an empty list, which is what the start-up
// ones read anyway; the one under test is written down instead
await page.evaluateOnNewDocument(() => {
    window.__VUEPORT_OPENED__ = [];
    window.__TAURI__ = {
        core: {
            invoke: async (command, args) => {
                if (command === 'open_external') {
                    window.__VUEPORT_OPENED__.push(args?.url);
                }
                return [];
            },
        },
        event: { listen: async () => () => undefined },
    };
});

await page.goto(origin, { waitUntil: 'networkidle0' });
await wait(1500);
const landed = page.url();

const opened = () => page.evaluate(() => window.__VUEPORT_OPENED__);

console.log('\nA link in the About pane');
await page.evaluate(() =>
    document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
await wait(700);
const onAbout = await page.evaluate(() => {
    for (const tab of document.querySelectorAll('.vp-settings-tab')) {
        if ((tab.textContent ?? '').trim() === 'About VUEPort') { tab.click(); return true; }
    }
    return false;
});
await wait(900);
check('About is reachable', onAbout, true);

const links = await page.evaluate(() => [...document.querySelectorAll('.vp-about a[href]')]
    .map(anchor => anchor.getAttribute('href')));
check('and carries the links it always did',
    links.some(href => /planet-?virtual-?boy|virtual-boy\.com/i.test(href ?? '')), true);

// a real click, as the arrangement is a listener on the document and a click that never reached it proves nothing
const target = await page.evaluate(() => {
    const anchor = [...document.querySelectorAll('.vp-about a[href^="http"]')][0];
    anchor.click();
    return anchor.getAttribute('href');
});
await wait(400);
check('clicking one asks the shell to open it', await opened(), [target]);
check('and the application stays where it was', page.url(), landed);

console.log('\nWhat is left alone');
// an address the shell has no business with: an in-page anchor still jumps, a mailto still goes to the system
// the way the webview already hands those over
await page.evaluate(() => {
    for (const href of ['#somewhere', 'mailto:someone@example.com']) {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.textContent = href;
        anchor.id = `probe-${href.replace(/\W/g, '')}`;
        document.body.appendChild(anchor);
        anchor.click();
    }
});
await wait(400);
check('nothing else is handed over', await opened(), [target]);

check('nothing errored', errors, []);

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
