// the library's coverflow view: offered and remembered by the shelf switch, windowed, moved by drag/wheel/arrows/keys
// onto a whole cover, the middle box turns over, six faces with spine and reflection. Looks aren't checked
// Usage: node tests/library-coverflow-probe.mjs (after `yarn build`)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        failures++;
    }
};

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
    '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
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
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

// nothing reaches the network: every entry has been looked up already, as on a second visit
await page.setRequestInterception(true);
page.on('request', request => {
    const url = request.url();
    if (url.includes('virtual-boy.com') || url.includes('api.vueport.net')) {
        request.respond({
            status: 200, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '[]',
        });
        return;
    }
    request.continue();
});

// more games than the window holds, so the windowing shows
const GAMES = 20;
await page.goto(origin, { waitUntil: 'networkidle0' });
await page.evaluate(async count => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('library', { create: true });
    const file = await directory.getFileHandle('index.json', { create: true });
    const writable = await file.createWritable();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const entries = [];
    for (let index = 0; index < count; index++) {
        const name = `${letters[index]} Game`;
        entries.push({
            id: `${index}`.padStart(8, '0'),
            files: [{
                folderId: 'f1', path: `${index}.vb`, name: `${index}.vb`,
                bytes: 1048576, modifiedAt: 1,
            }],
            header: { name: name.toUpperCase(), maker: '01', code: 'VPRB', version: 0 },
            bytes: 1048576,
            addedAt: 1,
            catalog: {
                itemId: index + 1, title: name, developer: 'Somebody', publisher: 'Somebody',
                released: '1995-12-01', genre: 'Action', players: '1 Player', region: 'NTSC-U',
                status: 'Released', kind: 'homebrew', description: '', latest: true, score: 80,
            },
            lookedUpAt: 2,
            unmatched: false,
        });
    }
    await writable.write(JSON.stringify({
        version: 1,
        folders: [{ id: 'f1', name: 'Virtual Boy', addedAt: 1, readAt: 2, count }],
        entries,
    }));
    await writable.close();
}, GAMES);
// what the emulator writes per checksum once a game has run; only the first has been played, so both cases are shown
await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('library', { create: true });
    const file = await directory.getFileHandle('play.json', { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify({
        '00000000': { count: 3, ms: 4 * 60_000, lastPlayedAt: Date.now() - 6 * 3_600_000 },
    }));
    await writable.close();
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.vp-library-card');

console.log('\nThe switch above the shelf');
check('offers a third view beside the covers and the table',
    await page.$('.vp-library-views [data-view="coverflow"]') !== null);
await page.click('.vp-library-views [data-view="coverflow"]');
await page.waitForSelector('.vp-library-flow-stage');
check('and choosing it puts the shelf on the stage rather than in a scroller',
    await page.$('.vp-library-shelf.flowing') !== null
    && await page.$('.vp-library-grid') === null
    && await page.$('.vp-library-list') === null);
check('which is remembered, like the other two', await (async () => {
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.vp-library-flow-stage', { timeout: 5000 })
        .catch(() => undefined);
    return await page.$('.vp-library-flow-stage') !== null;
})());

console.log('\nWhat is on the stage');
const covers = () => page.$$('.vp-library-flow-cover');
check('a window of the shelf rather than the whole of it',
    (await covers()).length > 1 && (await covers()).length < GAMES);
const faces = where => page.$$eval(`${where} > .vp-library-flow-face`,
    els => els.map(el => [...el.classList].filter(name => name !== 'vp-library-flow-face')[0])
        .sort());
const STANDING = '.vp-library-flow-cover.middle > .vp-library-flow-box';
const SIX = JSON.stringify(['back', 'bottom', 'fore', 'front', 'spine', 'top']);
check('the boxes have six faces, not one',
    JSON.stringify(await faces(STANDING)) === SIX);
check('the spine carries the title, as a spine does',
    await page.$eval(`${STANDING} > .spine span`, el => el.textContent) === 'A Game');
// both printed sides carry it, as which one a game shows depends only on which side of the middle it is on
check('and so does the other printed side, for the half of the shelf that shows it',
    await page.$eval(`${STANDING} > .fore span`, el => el.textContent) === 'A Game');

// turn, size and depth of each cover, read off the one transform the component writes, keyed by shelf position
const placed = () => page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.vp-library-flow-cover')].map(el => [
        Number(el.getAttribute('data-flow-index')),
        {
            turn: Number(/rotateY\((-?[\d.]+)deg\)/.exec(el.style.transform)?.[1]),
            scale: Number(/scale3d\(([\d.]+)/.exec(el.style.transform)?.[1]),
            shade: Number(el.style.getPropertyValue('--vp-flow-shade')),
            seeThrough: el.style.opacity !== '' && Number(el.style.opacity) < 1,
        },
    ])));
const at = await placed();
check('the middle one is square on and the rest are turned',
    at[0].turn === 0 && at[1].turn !== 0);
// both sides face the middle: right of it a negative rotation about the vertical, left of it mirrored. The other way
// the shelf reads inside out
check('and turned inwards — both sides facing the game in the middle', await (async () => {
    await page.focus('.vp-library-flow-stage');
    for (let step = 0; step < 4; step++) {
        await page.keyboard.press('ArrowRight');
    }
    await new Promise(resolve => setTimeout(resolve, 600));
    const fan = await placed();
    return fan[5].turn < 0 && fan[3].turn > 0;
})());
check('the one in the middle is drawn a third again as big as its neighbours',
    await (async () => {
        const fan = await placed();
        return fan[4].scale > fan[5].scale * 1.25;
    })());
check('and they get smaller towards the ends', await (async () => {
    const fan = await placed();
    return fan[6].scale < fan[5].scale && fan[7].scale < fan[6].scale;
})());
check('turned hardest beside the middle and less so behind it', await (async () => {
    const fan = await placed();
    return Math.abs(fan[5].turn) > Math.abs(fan[6].turn)
        && Math.abs(fan[6].turn) > Math.abs(fan[7].turn);
})());
check('and recede by being veiled rather than made see-through', await (async () => {
    const fan = await placed();
    return Object.values(fan).every(one => !one.seeThrough)
        && fan[4].shade === 0 && fan[Math.max(...Object.keys(fan).map(Number))].shade > 0;
})());
check('nothing stands on a reflection any more',
    await page.$('.vp-library-flow-mirror') === null);
// dragging the shelf must not select. Said in the stylesheet and refused by the stage, as the desktop build runs on
// WebKit, which needed a prefixed property for years; without it the boxes highlight blue while dragged
check('and none of it can be marked', await page.evaluate(() => {
    const refuses = [...document.querySelectorAll(
        '.vp-library-flow-stage, .vp-library-flow-cover.middle .front')]
        .every(el => getComputedStyle(el).userSelect === 'none');
    // the event a pointer raises on its way to a selection, refused at the stage whatever the cascade says
    const started = document.querySelector('.vp-library-flow-stage')
        ?.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }));
    return refuses && started === false;
}));
await page.keyboard.press('Home');
await new Promise(resolve => setTimeout(resolve, 600));

console.log('\nThe block underneath is about the one in the middle');
const shown = () => page.$eval('.vp-library-flow-details h2', el => el.textContent);
const position = () => page.$eval('.vp-library-flow-count', el => el.textContent);
check('it names the middle game', await shown() === 'A Game');
check('and says where along the shelf that is', await position() === `1 of ${GAMES}`);

check('what has been played says so, the way its own page says it',
    await page.$eval('.vp-library-flow-play', el => el.textContent)
        .then(said => /^Played 3 times · 4 min · last played .+$/.test(said)));

console.log('\nMoving along the shelf');
await page.click('.vp-library-flow-step.next');
await new Promise(resolve => setTimeout(resolve, 500));
check('the arrow moves it one', await shown() === 'B Game' && await position() === `2 of ${GAMES}`);
await page.click('.vp-library-flow-step.prev');
await new Promise(resolve => setTimeout(resolve, 500));
check('and back again', await shown() === 'A Game');
// the shelf is a circle, so neither arrow is ever dead: before the first game is the last
check('neither arrow is ever dead, because there is no end to be at',
    await page.$$eval('.vp-library-flow-step', els => els.every(el => !el.disabled)));
await page.click('.vp-library-flow-step.prev');
await new Promise(resolve => setTimeout(resolve, 500));
check('and what is before the first game is the last one',
    await shown() === 'T Game' && await position() === `${GAMES} of ${GAMES}`);
await page.click('.vp-library-flow-step.next');
await new Promise(resolve => setTimeout(resolve, 500));
check('and what is after the last one is the first again', await shown() === 'A Game');
// the build keeps only two of Phosphor's six weights (ICON_WEIGHTS in esbuild.mjs); another weight renders an empty
// <svg>, a button without an arrow and no error anywhere
check('and both arrows have an arrow on them',
    await page.$$eval('.vp-library-flow-step svg path', els => els.length) === 2);

await page.focus('.vp-library-flow-stage');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await new Promise(resolve => setTimeout(resolve, 500));
check('the arrow keys move it', await shown() === 'C Game');
await page.keyboard.press('End');
await new Promise(resolve => setTimeout(resolve, 500));
check('End goes to the far end', await position() === `${GAMES} of ${GAMES}`);
check('where the shelf carries on rather than stopping', await (async () => {
    await page.keyboard.press('ArrowRight');
    await new Promise(resolve => setTimeout(resolve, 500));
    return await position() === `1 of ${GAMES}`;
})());
await page.keyboard.press('Home');
await new Promise(resolve => setTimeout(resolve, 500));

await page.mouse.move(640, 380);
await page.mouse.wheel({ deltaY: 300 });
await new Promise(resolve => setTimeout(resolve, 500));
check('the wheel moves it too', await shown() !== 'A Game');
await page.keyboard.press('Home');
await new Promise(resolve => setTimeout(resolve, 500));

console.log('\nDragging it');
const stage = await page.$('.vp-library-flow-stage');
const box = await stage.boundingBox();
const midY = box.y + box.height * 0.4;
await page.mouse.move(box.x + box.width * 0.5, midY);
await page.mouse.down();
// two covers' worth to the left, in steps as a finger moves; one jump would be a click to pointer capture
for (let step = 1; step <= 8; step++) {
    await page.mouse.move(box.x + box.width * 0.5 - step * 45, midY);
}
const during = await page.$eval('.vp-library-flow-cover.middle',
    el => el.style.transform);
check('the shelf follows the finger rather than stepping when it is let go',
    !during.includes('rotateY(0.00deg)'));
await page.mouse.up();
await new Promise(resolve => setTimeout(resolve, 600));
const landed = await position();
check(`and lands on a whole cover rather than between two (${landed})`,
    /^\d+ of \d+$/.test(landed) && landed !== `1 of ${GAMES}`);
// dragged backwards from the first game: with ends this was a rubber band springing back; here the last games follow
await page.keyboard.press('Home');
await new Promise(resolve => setTimeout(resolve, 600));
await page.mouse.move(box.x + box.width * 0.5, midY);
await page.mouse.down();
for (let step = 1; step <= 8; step++) {
    await page.mouse.move(box.x + box.width * 0.5 + step * 45, midY);
}
await page.mouse.up();
await new Promise(resolve => setTimeout(resolve, 600));
const behind = await position();
check(`dragging back off the first game comes round rather than springing back (${behind})`,
    /^\d+ of \d+$/.test(behind) && behind !== `1 of ${GAMES}`);
check('a drag that ended on a cover did not also select it',
    await page.$eval('.vp-library-page,body', el => !el.classList.contains('never'))
    && await page.$('.vp-library-page') === null);

console.log('\nTurning the box over');
await page.keyboard.press('Home');
await new Promise(resolve => setTimeout(resolve, 600));
const flipped = () => page.$('.vp-library-flow-box.flipped');
check('only the middle cover carries the turn button',
    (await page.$$('.vp-library-flow-flip')).length === 1
    && await page.$('.vp-library-flow-cover.middle'
        + ' > .vp-library-flow-flip') !== null);
// pointer parked off the shelf first, then on the cover, as the drag left it over the boxes and hover is the point
await page.mouse.move(10, 10);
await new Promise(resolve => setTimeout(resolve, 250));
const flipOpacity = () => page.$eval('.vp-library-flow-flip',
    el => getComputedStyle(el).opacity);
check('which is out of sight until a pointer is on the cover',
    await flipOpacity() === '0');
await page.hover('.vp-library-flow-cover.middle');
await new Promise(resolve => setTimeout(resolve, 250));
check('and shows itself when one is', await flipOpacity() === '1');
await page.click('.vp-library-flow-flip');
await new Promise(resolve => setTimeout(resolve, 200));
check('the button turns it', await flipped() !== null);
check('and the back says what the catalog knows',
    await page.$eval(`${STANDING} .vp-library-flow-back-head span`,
        el => el.textContent) === 'A Game'
    && (await page.$$eval(`${STANDING} .vp-library-flow-back-facts dt`,
        els => els.map(el => el.textContent)))
        .join('|') === 'Developer|Year|Genre|Players|Region|Size');
await page.click('.vp-library-flow-flip');
await new Promise(resolve => setTimeout(resolve, 200));
check('and turns it back, with the shelf still the thing on screen',
    await flipped() === null && await page.$('.vp-library-flow-stage') !== null
    && await page.$('.vp-library-page') === null);

check('the space bar does the same, for a shelf being read from the keyboard',
    await (async () => {
        await page.focus('.vp-library-flow-stage');
        await page.keyboard.press('Space');
        await new Promise(resolve => setTimeout(resolve, 200));
        return await flipped() !== null;
    })());
await page.keyboard.press('ArrowRight');
await new Promise(resolve => setTimeout(resolve, 600));
check('and moving on turns it back — no back left facing out',
    await flipped() === null && await shown() === 'B Game');

console.log('\nGetting off the shelf');
const side = await page.$$('.vp-library-flow-cover:not(.middle)');
await side[side.length - 1].click();
await new Promise(resolve => setTimeout(resolve, 600));
check('a click on a turned cover brings it to the middle instead of opening it',
    await page.$('.vp-library-page') === null
    && await page.$eval('.vp-library-flow-cover.middle', el => el.getAttribute('aria-label'))
    !== 'B Game');
await page.click('.vp-library-flow-cover.middle');
await page.waitForSelector('.vp-library-page', { timeout: 5000 }).catch(() => undefined);
check('while a click on the middle cover opens the game\'s own page',
    await page.$('.vp-library-page') !== null);

check('nothing errored', errors.length === 0);
if (errors.length > 0) {
    console.log(errors.join('\n'));
}

await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
