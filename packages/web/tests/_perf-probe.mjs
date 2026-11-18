import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
const romPath = process.argv[2];
const seconds = +(process.argv[3] ?? 20);
const throttle = +(process.argv[4] ?? 1);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try { const body = await readFile(path.join(dist, url)); res.writeHead(200, { 'content-type': TYPES[path.extname(url)] ?? 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
const browser = await puppeteer.launch({ headless: process.env.HEADFUL ? false : 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', ...(process.env.SWIFT ? ['--enable-unsafe-swiftshader'] : [])] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setRequestInterception(true);
page.on('request', r => (r.url().includes('api.vueport.net') || r.url().includes('virtual-boy.com')) ? r.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' }) : r.continue());
page.on('pageerror', e => console.log('pageerror', String(e)));
await page.goto(origin, { waitUntil: 'networkidle0' });
let wclient; page.on('workercreated', w => { if (w.url().includes('vb-worker')) wclient = w.client; });
if (throttle > 1) { page.on('workercreated', async t => { { try { const c = t.client; await c.send('Emulation.setCPUThrottlingRate', { rate: throttle }); console.log('throttled worker', t.url().slice(-40)); } catch (e) { console.log('throttle failed', String(e)); } } }); }
const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.vp-library-side-foot .vp-button')]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 20000 });
await page.$eval('.vp-screen', el => el.focus());
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(3000); await wclient.send('Profiler.enable'); await wclient.send('Profiler.setSamplingInterval', { interval: 100 }); await wclient.send('Profiler.start');
const samples = [];
for (let i = 0; i < seconds; i++) {
  if (i % 3 === 0) { await page.keyboard.down('Enter'); await wait(100); await page.keyboard.up('Enter'); await wait(900); } else await wait(1000);
  const v = await page.$eval('[data-status="speed"] .vp-status-value', el => el.textContent.trim()).catch(() => '?');
  samples.push(v);
}
console.log(samples.join(' | '));
const { profile } = await wclient.send('Profiler.stop'); (await import('node:fs')).writeFileSync(process.env.OUT, JSON.stringify(profile));
await browser.close(); server.close();
