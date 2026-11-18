/**
 * Runs the built app under the CSP the packaged app actually applies, not the one in tauri.conf.json: at compile time
 * Tauri adds a nonce source to script-src and style-src for every embedded inline script and style, and a nonce or hash
 * source makes 'unsafe-inline' inert (per the CSP spec). styled-components writes a <style> tag at runtime with no
 * nonce; when that is refused, styled-components throws and React unmounts the tree from commitRoot, leaving an empty
 * window, only once bundled (`tauri dev` skips the rewriting). This rebuilds the effective policy as Tauri does,
 * honoring dangerousDisableAssetCspModification, and drives the styled-components surfaces.
 *
 * Usage: node tests/csp-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
const tauriConfig = path.join(__dirname, '..', '..', 'desktop', 'src-tauri', 'tauri.conf.json');

let failures = 0;
function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    } else {
        console.log(`  ok   ${label}`);
    }
}

const config = JSON.parse(await readFile(tauriConfig, 'utf8'));
const security = config.app?.security ?? {};
const disabled = security.dangerousDisableAssetCspModification ?? false;
const modifies = directive => disabled !== true
    && !(Array.isArray(disabled) && disabled.includes(directive));

const NONCE = '424242424242';

function extend(csp, directive, sources) {
    if (sources.length === 0) {
        return csp;
    }
    const parts = csp.split(';').map(part => part.trim()).filter(Boolean);
    const index = parts.findIndex(part => part.split(/\s+/)[0] === directive);
    if (index < 0) {
        return `${csp}; ${directive} ${sources.join(' ')}`;
    }
    parts[index] = `${parts[index]} ${sources.join(' ')}`;
    return parts.join('; ');
}

// the policy in a meta tag, plus the nonces and hashes Tauri stamps in. Inline scripts get a hash rather than a nonce,
// as Tauri does, which lets the boot script run under `script-src 'self'`
function asBundled(html) {
    let csp = security.csp ?? '';
    if (modifies('style-src') && /<style[\s>]/.test(html)) {
        html = html.replace(/<style(?=[\s>])/g, `<style nonce="${NONCE}"`);
        csp = extend(csp, 'style-src', [`'nonce-${NONCE}'`]);
    }
    const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map(match => `'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`);
    if (modifies('script-src')) {
        csp = extend(csp, 'script-src', hashes);
    }
    return html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
};

const server = createServer(async (request, response) => {
    const url = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    try {
        let body = await readFile(path.join(dist, url));
        if (url === '/index.html') {
            body = Buffer.from(asBundled(body.toString()));
        }
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
    if (/api\.vueport\.net/.test(request.url())) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

// whether anything is left standing, which an unmounted root is not
const painted = () => page.evaluate(() => [...document.querySelectorAll('#root *')]
    .filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
    }).length);

const refused = () => errors.filter(text => /Refused to (apply|execute|load)/i.test(text));

await page.goto(origin, { waitUntil: 'networkidle0' });
await new Promise(resolve => setTimeout(resolve, 1500));

console.log('\nThe start page, under the policy the bundle applies');
{
    check('the application paints', await painted() > 20, true);
    check('nothing was refused by the policy', refused(), []);
}

console.log('\nThe settings dialog, which is built from styled components');
{
    await page.evaluate(() => document.querySelector('[data-control="settings"]')?.click());
    await new Promise(resolve => setTimeout(resolve, 2000));
    check('the dialog is on screen', await page.$('.vp-window') !== null, true);
    check('and the application is still standing', await painted() > 100, true);
    check('nothing was refused by the policy', refused(), []);
    check('nothing errored', errors, []);
}

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
