/**
 * Checks what packages/core/wasm/rcheevos/smoke.mjs cannot: that the built rcheevos.js glue loads and runs in a real
 * classic Web Worker as the emulator worker loads it (importScripts, the -sENVIRONMENT=worker wasm fetch, the
 * --js-library hooks), and that a login through canned responses gives the JSON vb-rcheevos.ts parses. Not in
 * `yarn test:ui`, as it needs rcheevos.js/.wasm from packages/core/wasm/rcheevos/build.mjs.
 *
 * Usage: node packages/web/tests/retroachievements-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

if (!existsSync(path.join(dist, 'rcheevos.js'))) {
    console.log('\nskipped: dist/rcheevos.js is not built '
        + '(node packages/core/wasm/rcheevos/build.mjs, then yarn --cwd packages/web build)\n');
    process.exit(0);
}

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        failures++;
    }
};

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
};

// runs inside a classic Worker, driving the glue as vb-rcheevos.ts does: importScripts, factory, then a canned login
const WORKER_SOURCE = `
self.onmessage = async (event) => {
    const { origin } = event.data;
    const out = {};
    try {
        importScripts(origin + '/rcheevos.js');
        const factory = self.createVueportRc;
        const emitted = [];
        const calls = [];
        const module = await factory({
            locateFile: (p) => p.endsWith('.wasm') ? origin + '/rcheevos.wasm' : p,
        });
        module.vrcEmit = (json) => emitted.push(JSON.parse(json));
        module.vrcReadMemory = (_a, buf, len) => { module.HEAPU8.fill(0, buf, buf + len); return len; };
        module.vrcServerCall = (id, method, url, body) => calls.push({ id, method, url, body });
        const client = module._vrc_create();
        out.clientCreated = client !== 0;
        const mk = (t) => {
            const size = module.lengthBytesUTF8(t) + 1;
            const p = module._malloc(size);
            module.stringToUTF8(t, p, size);
            return p;
        };
        module._vrc_begin_login_password(client, mk('U'), mk('P'));
        out.loginCalled = calls.length >= 1;
        module._vrc_provide_response(calls[0].id, 200, mk(JSON.stringify({
            Success: true, User: 'U', Token: 'tok-xyz', Score: 1, SoftcoreScore: 2,
        })));
        out.login = emitted.find((x) => x.t === 'login');
        // The leaderboard entry point comes from the same build as everything
        // above, so this is really asking whether the rcheevos.js the web
        // bundle ships is current — a stale one loads and logs in perfectly
        // well and simply never produces a leaderboard.
        out.leaderboardsExported = typeof module._vrc_begin_fetch_leaderboard_entries === 'function';
    } catch (err) {
        out.error = String((err && err.stack) || err);
    }
    self.postMessage(out);
};
`;

const server = createServer(async (request, response) => {
    const url = request.url === '/' ? '/probe.html' : request.url.split('?')[0];
    if (url === '/probe.html') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><meta charset=utf8><title>ra probe</title>');
        return;
    }
    if (url === '/ra-worker.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(WORKER_SOURCE);
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
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));
await page.goto(origin, { waitUntil: 'load' });

const result = await page.evaluate(async origin => {
    const worker = new Worker(`${origin}/ra-worker.js`);
    return await new Promise((resolve, reject) => {
        worker.onerror = e => reject(new Error(`worker error: ${e.message}`));
        worker.onmessage = e => resolve(e.data);
        worker.postMessage({ origin });
        setTimeout(() => reject(new Error('timed out')), 15000);
    });
}, origin).catch(error => ({ error: String(error) }));

await browser.close();
server.close();

console.log('\nEngine in a real worker');
if (result.error) {
    check(`no error (${result.error})`, false);
} else {
    check('the glue loaded and created a client', result.clientCreated === true);
    check('a login server call was issued', result.loginCalled === true);
    check('a successful login was emitted', result.login?.ok === true);
    check('with the token to keep', result.login?.user?.token === 'tok-xyz');
    check('and the shipped glue carries the leaderboard entry point',
        result.leaderboardsExported === true);
}
check('nothing errored on the page', pageErrors.length === 0
    || (console.log('  ' + pageErrors.join('\n  ')), false));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
