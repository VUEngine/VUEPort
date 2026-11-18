/**
 * Checks the mapping a Theia host embeds the emulator with: host-theia.css belongs to the core but needs a built,
 * painted page. Proves every mapping still resolves: a var() naming a missing property makes the declaration invalid at
 * computed-value time, and an invalid custom property inherits (nothing at :root) rather than falling back, so the page
 * looks not quite painted with nothing in the console.
 *
 * Usage: node tests/host-theia-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
const adapterPath = path.join(
    __dirname, '..', '..', 'core', 'src', 'browser', 'style', 'host-theia.css');

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

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer:\n'
        + '  yarn add --dev -W puppeteer\n');
    server.close();
    process.exit(1);
}

const adapter = await readFile(adapterPath, 'utf8');
const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle0' });

const tokens = () => page.evaluate(names => {
    const root = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map(n => [n, root.getPropertyValue(n).trim()]));
}, [...adapter.matchAll(/^\s{4}(--vp-[a-z-]+):/gm)].map(m => m[1]));

const control = () => page.evaluate(() => {
    let host = document.querySelector('#theia-probe');
    if (!host) {
        host = document.createElement('div');
        host.id = 'theia-probe';
        host.className = 'vp-widget';
        host.innerHTML = '<button class="vp-button">a</button>';
        document.body.appendChild(host);
    }
    const style = getComputedStyle(host.querySelector('.vp-button'));
    return { background: style.backgroundColor, height: style.height, radius: style.borderTopLeftRadius };
});

section('The adapter with no Theia theme present');
{
    await page.addStyleTag({ content: adapter });
    const seen = await tokens();
    const empty = Object.entries(seen).filter(([, value]) => value === '').map(([name]) => name);
    check('every mapped token still resolves', empty, []);
    check('and they resolve to the emulator\'s own values',
        [seen['--vp-panel'], seen['--vp-space']], ['#232329', '6px']);
}

section('The adapter with a theme');
{
    await page.addStyleTag({
        content: ':root { --theia-activityBar-background: #1b2a3c;'
            + ' --theia-button-background: #2f7dd1;'
            + ' --theia-descriptionForeground: #90a4b8;'
            + ' --theia-ui-padding: 8px;'
            + ' --theia-border-radius: 7px; }',
    });
    const seen = await tokens();
    check('the surfaces follow it', seen['--vp-panel'], '#1b2a3c');
    check('so does dim text', seen['--vp-text-dim'], '#90a4b8');
    check('and so does the density', seen['--vp-space'], '8px');
    // unlayered beats layered whatever order the bundler emitted them in
    check('a control is painted with the host\'s accent',
        (await control()).background, 'rgb(47, 125, 209)');
    check('and cornered with the host\'s radius', (await control()).radius, '7px');
}

section('The theme changes under it');
{
    // Theia restates its properties on the root on a theme change; aliases re-resolve, nothing to listen for
    await page.addStyleTag({ content: ':root { --theia-button-background: #b1541f; }' });
    check('the emulator follows without being told',
        (await control()).background, 'rgb(177, 84, 31)');
}

section('What stays the emulator\'s');
{
    // the toolbar is a dense row of transport controls built on 26px; a host can set `--vp-control-height` itself
    check('the control height is the emulator\'s', (await control()).height, '26px');
    const seen = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return [root.getPropertyValue('--vp-radius-small').trim(),
            root.getPropertyValue('--vp-radius-large').trim()];
    });
    check('and so is the rest of the radius scale', seen, ['2px', '6px']);
}

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
