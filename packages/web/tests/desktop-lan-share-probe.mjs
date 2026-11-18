/**
 * Checks the desktop's side of a LAN share in a real browser, the whole app running against a stand-in for the shell
 * (as external-links-probe.mjs does). Network Shares' Share hands the shell the ROM and a save state of the moment with
 * its picture, tells api.vueport.net where the share is and shows the address to type; Update Save State takes the
 * moment again; Stop Sharing (or closing the game) stops the shell and takes the share off the list. What the shell
 * then serves is lan_share.rs's, which has its own Rust tests.
 *
 * Usage: node tests/desktop-lan-share-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
    if (!ok) {
        failures++;
    }
};
const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

// the page's own ZIP code, bundled for Node, to make and read a .vbz as the app does
async function zipTools(scratch) {
    const entry = path.join(scratch, 'zip-entry.ts');
    await writeFile(entry, `export { storeZip, listZipEntries, readZipEntry } from ${JSON.stringify(
        fileURLToPath(new URL('../src/web-zip.ts', import.meta.url)))};`);
    const outfile = path.join(scratch, 'zip.mjs');
    await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'warning' });
    return import(pathToFileURL(outfile).href);
}

const rom = Buffer.alloc(8 * 131072);
{
    const header = rom.length - 544;
    rom.write('LAN SHARE PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 3;
}

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const zip = await zipTools(scratch);
const titles = new TextEncoder().encode('{"tracks":{"1":{"title":"Intro"}}}');
const archive = Buffer.from(zip.storeZip([
    { name: 'probe.vb', data: rom },
    { name: '1.mp3', data: new Uint8Array(64).fill(1) },
    { name: '2.mp3', data: new Uint8Array(64).fill(2) },
    { name: 'essound.json', data: titles },
]));

const plain = Buffer.from(zip.storeZip([{ name: 'probe.vb', data: rom }]));

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
};
const server = createServer(async (request, response) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/probe.vb') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(rom);
        return;
    }
    if (pathname === '/plain.vbz') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(plain);
        return;
    }
    if (pathname === '/probe.vbz') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(archive);
        return;
    }
    const url = pathname === '/' ? '/index.html' : pathname;
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
await page.setViewport({ width: 1280, height: 800 });
page.on('pageerror', error => console.log('  pageerror', String(error)));

await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] });
    const files = new Map();
    const shell = { calls: [], sharing: false, state: undefined };
    window.__shell = shell;
    const header = (options, name) => decodeURIComponent(options?.headers?.[name] ?? '');
    const info = { token: 'abcdef0123456789abcdef01', port: 47913, addresses: ['192.168.1.17:47913'], device: 'Probe Mac' };
    window.__TAURI__ = {
        core: {
            invoke: async (command, args, options) => {
                switch (command) {
                    case 'storage_read': {
                        const found = files.get(args.path);
                        if (!found) {
                            throw new Error(`no ${args.path}`);
                        }
                        return found.slice().buffer;
                    }
                    case 'storage_write':
                        files.set(header(options, 'x-vueport-path'), new Uint8Array(args));
                        return undefined;
                    case 'storage_exists':
                        return files.has(args.path);
                    case 'storage_delete':
                        files.delete(args.path);
                        return undefined;
                    case 'storage_list':
                        return [...files.entries()]
                            .filter(([path]) => path.startsWith(`${args.directory}/`) && !path.slice(args.directory.length + 1).includes('/'))
                            .map(([path, bytes]) => ({ path, name: path.slice(path.lastIndexOf('/') + 1), size: bytes.length }));
                    case 'storage_measure':
                        return { bytes: 0, files: 0 };
                    case 'storage_root':
                        return '/probe';
                    case 'config_read':
                        return null;
                    case 'window_chrome':
                        return 'custom';
                    case 'lan_share_start':
                        shell.sharing = true;
                        shell.calls.push({
                            command, size: args.length, name: header(options, 'x-vueport-name'),
                            web: header(options, 'x-vueport-web'),
                        });
                        shell.shared = Array.from(args);
                        return info;
                    case 'lan_share_attach': {
                        const kind = header(options, 'x-vueport-kind');
                        shell.calls.push({ command, kind, size: args.length });
                        if (kind === 'state') {
                            shell.state = Array.from(args);
                        }
                        return undefined;
                    }
                    case 'lan_share_info':
                        return shell.sharing ? info : null;
                    case 'lan_share_stop':
                        shell.sharing = false;
                        shell.calls.push({ command });
                        return undefined;
                    default:
                        return [];
                }
            },
        },
        event: { listen: async () => () => undefined },
    };
});

const posts = [];
await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.startsWith('https://api.vueport.net/lan-shares')) {
        if (request.method() === 'POST') {
            posts.push({ url, type: request.headers()['content-type'], body: JSON.parse(request.postData() ?? '{}') });
        }
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(request.method() === 'POST' ? { status: 'shared', ttl: 90 } : { shares: [] }),
        });
        return;
    }
    if (url.includes('api.vueport.net') || url.includes('virtual-boy.com')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

const calls = () => page.evaluate(() => window.__shell.calls);
const vrText = () => page.$eval('.vp-vr', el => el.textContent ?? '');
const clickButton = (label) => page.evaluate(text => [...document.querySelectorAll('.vp-vr .vp-button')]
    .find(button => button.textContent?.trim() === text)?.click(), label);

await page.goto(`${origin}/?rom=${encodeURIComponent(`${origin}/probe.vb`)}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await settle(1500);

console.log('\nSharing');
await page.click('.vp-titlebar-button[data-control="network-shares"]');
await page.waitForSelector('.vp-vr', { timeout: 5000 });
check('the desktop offers to share', /Share with a device in this network/.test(await vrText()));
check('saying how the other device finds it', /scan the code with its camera/.test(await vrText()));
await clickButton('Share');
await page.waitForFunction(() => /Sharing /.test(document.querySelector('.vp-vr')?.textContent ?? ''), { timeout: 5000 })
    .catch(() => undefined);
let made = await calls();
check('a QR code leads to the share', await page.$('.vp-vr-card.sharing .vp-qr') !== null);
const start = made.find(call => call.command === 'lan_share_start');
check('the shell is handed the ROM', start?.size === rom.length, JSON.stringify(start));
check('under its file name', start?.name === 'probe.vb', JSON.stringify(start));
check('with VUEPort Web for a typed-in visit', start?.web === 'https://play.vueport.net/', JSON.stringify(start));
const state = made.find(call => call.command === 'lan_share_attach' && call.kind === 'state');
const picture = made.find(call => call.command === 'lan_share_attach' && call.kind === 'thumbnail');
check('and a save state of the moment', state?.size > 0, JSON.stringify(made));
check('and its picture', picture?.size > 0, JSON.stringify(made));
{
    const { describeSaveState } = require('vueport-core/lib/common/emulator-save-state');
    const described = describeSaveState(Uint8Array.from(await page.evaluate(() => window.__shell.state)));
    check('the state is one a headset can load: one machine', described?.machines === 1, JSON.stringify(described?.machines));
    check('named after the computer it came from', described?.meta?.label === 'Shared by Probe Mac',
        JSON.stringify(described?.meta?.label));
    check('with the moment\'s picture inside', (described?.meta?.thumbnail?.length ?? 0) > 0);
}

const registered = posts.find(post => post.url === 'https://api.vueport.net/lan-shares');
check('api.vueport.net is told about it', registered !== undefined, JSON.stringify(posts));
const body = registered?.body ?? {};
check('without a CORS preflight', registered?.type?.startsWith('text/plain'), registered?.type);
check('with an id and a secret of the right shape', /^[0-9a-f]{16}$/.test(body.id) && /^[0-9a-f]{32}$/.test(body.secret),
    JSON.stringify(body));
check('the shell\'s token and addresses', body.token === 'abcdef0123456789abcdef01'
    && JSON.stringify(body.addresses) === '["192.168.1.17:47913"]', JSON.stringify(body));
check('the computer, the title and the file', body.device === 'Probe Mac' && body.name === 'probe.vb'
    && typeof body.title === 'string' && body.title.length > 0, JSON.stringify(body));
check('that it can be continued', body.state === true, JSON.stringify(body));
check('and the CRC32 of what is shared', /^[0-9a-f]{8}$/.test(body.romId), JSON.stringify(body));

const text = await vrText();
check('the window says it is shared', /Sharing /.test(text), text);
check('and listed', /It is also listed under Network Shares in VUEPort/.test(text), text);
check('with the address to type in', /Or type this into a browser there: 192\.168\.1\.17:47913/.test(text), text);
check('and from when it continues', /It can continue from /.test(text), text);

console.log('\nUpdate Save State');
const statesBefore = made.filter(call => call.kind === 'state').length;
const postsBefore = posts.length;
await clickButton('Update Save State');
await settle(1000);
made = await calls();
check('takes the moment again', made.filter(call => call.kind === 'state').length === statesBefore + 1, JSON.stringify(made));
check('and tells api.vueport.net again', posts.length > postsBefore);
check('under the same id', posts[posts.length - 1]?.body?.id === body.id);

console.log('\nStop Sharing');
await clickButton('Stop Sharing');
await settle(800);
made = await calls();
check('stops the shell', made.some(call => call.command === 'lan_share_stop'), JSON.stringify(made));
const withdrawn = posts.find(post => post.url.endsWith('/lan-shares/withdraw'));
check('and takes it off the list', withdrawn?.body?.id === body.id && withdrawn?.body?.secret === body.secret,
    JSON.stringify(withdrawn));
check('the window offers to share again', /Share with a device in this network/.test(await vrText()));

console.log('\nClosing the game');
await clickButton('Share');
await settle(1000);
const stopsBefore = (await calls()).filter(call => call.command === 'lan_share_stop').length;
await page.click('.vp-window-close');
await settle(300);
// through the DOM: the control only shows on hover
await page.evaluate(() => document.querySelector('.vp-titlebar-rom-close')?.click());
await settle(1500);
const answered = await page.$('.vp-modal');
if (answered) {
    // "keep where you are?" on closing, which is not what is under test
    await page.evaluate(() => document.querySelectorAll('.vp-modal-buttons .vp-button')[1]?.click());
    await settle(1000);
}
check('ends the share', (await calls()).filter(call => call.command === 'lan_share_stop').length === stopsBefore + 1,
    JSON.stringify(await calls()));

console.log('\nA game with ESSound tracks');
await page.goto(`${origin}/?rom=${encodeURIComponent(`${origin}/probe.vbz`)}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await settle(1500);
await page.click('.vp-titlebar-button[data-control="network-shares"]');
await page.waitForSelector('.vp-vr', { timeout: 5000 });
await clickButton('Share');
await settle(1500);
{
    const started = (await calls()).filter(call => call.command === 'lan_share_start').pop();
    check('is shared as a .vbz', started?.name === 'probe.vbz', JSON.stringify(started));
    const shared = Uint8Array.from(await page.evaluate(() => window.__shell.shared));
    const entries = zip.listZipEntries(shared);
    check('holding the ROM, the tracks and their titles',
        JSON.stringify(entries.map(entry => entry.name).sort()) === '["1.mp3","2.mp3","essound.json","probe.vb"]',
        JSON.stringify(entries.map(entry => entry.name)));
    const read = async name => zip.readZipEntry(shared, entries.find(entry => entry.name === name));
    check('the ROM as it runs', Buffer.compare(Buffer.from(await read('probe.vb')), rom) === 0);
    check('the tracks byte for byte', (await read('2.mp3')).every(byte => byte === 2)
        && Buffer.compare(Buffer.from(await read('essound.json')), Buffer.from(titles)) === 0);
}

console.log('\nAn archive without tracks');
await page.goto(`${origin}/?rom=${encodeURIComponent(`${origin}/plain.vbz`)}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await settle(1500);
check('the title bar names the archive', await page.$eval('.vp-titlebar-rom-name', el => el.textContent?.trim()) === 'plain.vbz');
await page.click('.vp-titlebar-button[data-control="network-shares"]');
await page.waitForSelector('.vp-vr', { timeout: 5000 });
await clickButton('Share');
await settle(1500);
{
    const started = (await calls()).filter(call => call.command === 'lan_share_start').pop();
    check('is shared under the archive\'s name', started?.name === 'plain.vbz', JSON.stringify(started));
    const entries = zip.listZipEntries(Uint8Array.from(await page.evaluate(() => window.__shell.shared)));
    check('as an archive of just the ROM', JSON.stringify(entries.map(entry => entry.name)) === '["probe.vb"]',
        JSON.stringify(entries.map(entry => entry.name)));
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
