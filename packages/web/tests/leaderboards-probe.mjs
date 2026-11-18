/**
 * Checks the Achievements panel's Leaderboards view through the real interface: signing in and loading a set lists the
 * game's boards, softcore says why nothing on it will move, opening one fetches its standings, and the signed-in
 * player's row is picked out. The engine's half (attempts, trackers, submissions) is covered by
 * packages/core/wasm/rcheevos/smoke.mjs, as this ROM's work RAM stays zero and no board can start. RetroAchievements is
 * answered from a canned relay, as the live service needs an approved client and credentials.
 *
 * Usage: node tests/leaderboards-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// a build without the engine shows a different, equally correct screen, but not the one this probe is about
if (!existsSync(path.join(dist, 'rcheevos.js'))) {
    console.log('\nskipped: dist/rcheevos.js is not built '
        + '(node packages/core/wasm/rcheevos/build.mjs, then yarn --cwd packages/web build)\n');
    process.exit(0);
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

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-lb-'));
const romPath = path.join(scratch, 'probe.vb');
{
    const rom = Buffer.alloc(16 * 131072);
    const header = rom.length - 544;
    rom.write('LEADERBOARD PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 3;
    await writeFile(romPath, rom);
}

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer.\n');
    server.close();
    process.exit(1);
}

const SET = {
    Success: true, GameId: 4242, Title: 'Leaderboard Probe', ConsoleId: 28,
    ImageIconUrl: '', RichPresenceGameId: 4242, RichPresencePatch: '',
    Sets: [{
        AchievementSetId: 9001, GameId: 4242, Title: 'Leaderboard Probe', Type: 'core',
        ImageIconUrl: '',
        // one achievement, so the panel has a real game
        Achievements: [{
            ID: 5001, Title: 'First Steps', Description: 'Do the thing.', Flags: 3, Points: 5,
            MemAddr: '0xH000000=1', Author: 'a', BadgeName: '1', Created: 1, Modified: 1,
            Type: '', BadgeURL: '', BadgeLockedURL: '',
        }],
        // one scored, one timed and won by the lowest value, as the row shows which is which
        Leaderboards: [
            {
                ID: 7001, Title: 'High Score', Description: 'Score as much as possible.',
                Mem: 'STA:0xH000002=1::CAN:0xH000002=0::SUB:0xH000003=1::VAL:0xH000004',
                Format: 'SCORE', LowerIsBetter: false, Hidden: false,
            },
            {
                ID: 7002, Title: 'Any% Speedrun', Description: 'Finish the game as fast as possible.',
                Mem: 'STA:0xH000005=1::CAN:0xH000005=0::SUB:0xH000006=1::VAL:M:0xH000007',
                Format: 'TIME', LowerIsBetter: true, Hidden: false,
            },
        ],
    }],
};

const LBINFO = {
    Success: true,
    LeaderboardData: {
        LBID: 7001, LBFormat: 'SCORE', LowerIsBetter: 0, LBTitle: 'High Score',
        LBDesc: 'Score as much as possible.', LBMem: 'STA:0xH000002=1::VAL:0xH000004',
        GameID: 4242, LBAuthor: 'a',
        LBCreated: '2020-09-13 12:26:40', LBUpdated: '2020-09-13 12:26:40',
        TotalEntries: 3,
        Entries: [
            { User: 'Speedy', Rank: 1, Index: 1, Score: 99000, DateSubmitted: 1700000000 },
            { User: 'ProbeUser', Rank: 2, Index: 2, Score: 42000, DateSubmitted: 1700086400 }, // the signed-in player
            { User: 'Slowpoke', Rank: 3, Index: 3, Score: 100, DateSubmitted: 1700172800 },
        ],
    },
};

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });

await page.setRequestInterception(true);
let lbinfoCalls = 0;
page.on('request', request => {
    const url = request.url();
    // the relay is on another origin, so the browser preflights it, and that must be answered
    const CORS = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (request.method() === 'OPTIONS' && /api\.vueport\.net/.test(url)) {
        return request.respond({ status: 204, headers: CORS, body: '' });
    }
    const json = body => request.respond({
        status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
    });
    if (url.includes('/pvb/?featured')) { return json([]); }
    if (/api\.vueport\.net\/pvb\//.test(url)) {
        return json({ id: 1, title: 'Probe Game', hash: { crc32: '00000000' }, item: [] });
    }
    if (url.endsWith('api.vueport.net/ra')) {
        // the relay's envelope: { method, url, body, contentType } in, { status, body } back, see
        // packages/server/src/ra_proxy.php
        const sent = JSON.parse(request.postData() ?? '{}');
        const query = `${sent.body ?? ''}&${sent.url ?? ''}`;
        const reply = body => json({ status: 200, body: JSON.stringify(body) });
        if (/r=login2/.test(query)) {
            return reply({ Success: true, User: 'ProbeUser', Token: 'tok', Score: 1234, SoftcoreScore: 56 });
        }
        if (/r=achievementsets/.test(query)) { return reply(SET); }
        if (/r=startsession/.test(query)) {
            return reply({ Success: true, Unlocks: [], HardcoreUnlocks: [], ServerNow: 1700000100 });
        }
        if (/r=lbinfo/.test(query)) {
            lbinfoCalls++;
            return reply(LBINFO);
        }
        return reply({ Success: true });
    }
    // badges and avatars: a 1x1 GIF, so the page never reaches the real CDN and Chrome logs no failed load
    if (/media\.retroachievements\.org/.test(url)) {
        return request.respond({
            status: 200, contentType: 'image/gif',
            body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
        });
    }
    request.continue();
});

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
await page.goto(origin, { waitUntil: 'networkidle0' });

// achievements are off by default, and the account must be in place before the ROM, as a set is only asked for once the
// user is signed in
await page.evaluate(() =>
    document.querySelector('.vp-titlebar-button[data-control="settings"]')?.click());
await settle();
await page.evaluate(() => {
    for (const tab of document.querySelectorAll('.vp-settings-tab')) {
        if (/achievements/i.test(tab.textContent ?? '')) { tab.click(); return; }
    }
});
await settle();
await page.evaluate(() => document.querySelector('[role="switch"][aria-checked="false"]')?.click());
await settle();

console.log('\nSigning in');
const fields = await page.$$('.vp-retroachievements-credentials input');
check('the settings pane offers a username and a password', fields.length === 2);
await fields[0].type('ProbeUser');
await fields[1].type('hunter2');
await page.evaluate(() => {
    const button = [...document.querySelectorAll('.vp-retroachievements-login button')]
        .find(candidate => /log in|sign in/i.test(candidate.textContent ?? ''));
    button?.click();
});
await settle(1200);
check('the account is signed in', await page.evaluate(() =>
    !!document.querySelector('.vp-retroachievements-username')));
await page.keyboard.press('Escape');
await settle();

const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('.vp-library-side-foot .vp-button'),
]);
await chooser.accept([romPath]);
await page.waitForSelector('.vp-dock canvas', { timeout: 30000 });
await settle(3000);

await page.click('.vp-titlebar-button[data-control="achievements"]');
await settle(1500);

const showLeaderboards = () => page.evaluate(() => {
    const group = document.querySelector('.vp-achievements-view-switch');
    const options = [...(group?.children[0]?.children ?? [])].filter(o => o.querySelector('svg'));
    options.at(-1)?.click();
});

console.log('\nThe game\'s leaderboards');
check('the achievements view is what opens', await page.evaluate(() =>
    !!document.querySelector('.vp-panel-aside .vp-achievements-badge')));
await showLeaderboards();
await settle(600);
const list = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.vp-panel-aside .vp-panel-row')]
        .map(row => row.querySelector('.vp-panel-row-name')?.textContent ?? ''),
    note: document.querySelector('.vp-panel-aside .vp-achievements-offline-note')
        ?.textContent ?? '',
    sort: !!document.querySelector('.vp-panel-aside .vp-achievements-sort'),
}));
check('both boards are listed', JSON.stringify(list.rows) === '["High Score","Any% Speedrun"]');
check('softcore says why none of them will move', /hardcore/i.test(list.note));
check("the achievement list's own sort is not left hanging over them", list.sort === false);

console.log('\nThe filter reaches them too');
await page.type('.vp-panel-aside .vp-panel-filter input', 'speed');
await settle(400);
check('filtering narrows the boards', await page.evaluate(() =>
    document.querySelectorAll('.vp-panel-aside .vp-panel-row').length === 1));
await page.evaluate(() =>
    document.querySelector('.vp-panel-aside .vp-panel-filter-clear')?.click());
await settle(400);

console.log('\nOne board\'s standings');
await page.evaluate(() =>
    document.querySelector('.vp-panel-aside .vp-panel-row')?.click());
await settle(1500);
const detail = await page.evaluate(() => ({
    title: document.querySelector('.vp-achievements-detail-title span')?.textContent ?? '',
    total: document.querySelector('.vp-leaderboards-total')?.textContent ?? '',
    ranks: [...document.querySelectorAll('.vp-leaderboards-rank')].map(r => r.textContent),
    names: [...document.querySelectorAll('.vp-leaderboards-entries .vp-panel-row-name')]
        .map(n => n.textContent),
    values: [...document.querySelectorAll('.vp-leaderboards-entries .vp-leaderboards-value')]
        .map(v => v.textContent),
    mine: [...document.querySelectorAll('.vp-leaderboards-entries .vp-panel-row')]
        .findIndex(row => row.classList.contains('enabled')),
}));
check('the board it opened is named', detail.title === 'High Score');
check('its entries were fetched', lbinfoCalls === 1);
check('the whole board\'s size is shown, not just the page', /3/.test(detail.total));
check('all three rows are ranked', JSON.stringify(detail.ranks) === '["1","2","3"]');
check('by name', JSON.stringify(detail.names) === '["Speedy","ProbeUser","Slowpoke"]');
// rcheevos formats a SCORE board's values itself, the panel prints them as-is
check('with the values as the board formats them',
    JSON.stringify(detail.values) === '["099000","042000","000100"]');
check("and the signed-in player's own row picked out", detail.mine === 1);

console.log('\nAround Me asks again');
await page.evaluate(() => {
    const scope = document.querySelector('.vp-leaderboards-scope');
    const options = [...(scope?.children[0]?.children ?? [])]
        .filter(o => /around/i.test(o.textContent ?? ''));
    options[0]?.click();
});
await settle(1200);
check('switching the scope re-asks the server', lbinfoCalls === 2);

console.log('\nBack to the list');
await page.evaluate(() => {
    const back = [...document.querySelectorAll('.vp-panel-aside button')]
        .find(candidate => /back to list/i.test(candidate.textContent ?? ''));
    back?.click();
});
await settle(600);
check('the boards are there again', await page.evaluate(() =>
    document.querySelectorAll('.vp-panel-aside .vp-panel-row').length === 2));

check('nothing errored throughout', errors.length === 0
    || (console.log(`      ${errors.join('\n      ')}`), false));

await browser.close();
server.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
