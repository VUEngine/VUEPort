#!/usr/bin/env node
/**
 * Downloads every RetroAchievements set for the Virtual Boy into one JSON file, the offline snapshot the Achievements
 * panel falls back to when the site is unreachable. It is not part of the build or CI; run it by hand:
 *
 *   RA_API_KEY=xxxxxxxx node packages/core/scripts/fetch-achievement-sets.mjs
 *
 * The key is a Web API key from https://retroachievements.org/settings ("Keys") and is never written to the output.
 * By default the output is the trimmed, minified form the emulator ships (RetroAchievementsService.setBackupLoader).
 * Prints a size report (on disk, minified, gzipped).
 *
 * Options:
 *   --out <path>     where to write (default: packages/core/src/data/retroachievements-vb.json)
 *   --full           keep everything the API returns: MemAddr (an opaque hash, useless offline), author,
 *                    timestamps, box art, rich-presence patch
 *   --pretty         indent the JSON (default: minified)
 *   --badges         also download every badge PNG into <out-dir>/badges/ and report their size (the bulk)
 *   --delay <ms>     pause between API calls (default: 300)
 *   --unofficial     include unofficial and demoted achievements too (f=5)
 */
import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const API = 'https://retroachievements.org/API';
const MEDIA = 'https://media.retroachievements.org';
const USER_AGENT = 'VUEPort achievement-set archiver (packages/core/scripts/fetch-achievement-sets.mjs)';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const API_KEY = process.env.RA_API_KEY;
if (!API_KEY) {
    console.error(
        'Set RA_API_KEY to a RetroAchievements Web API key '
        + '(https://retroachievements.org/settings, "Keys").');
    process.exit(1);
}

const OUT = path.resolve(opt('out', path.join(REPO_ROOT, 'packages/core/src/data/retroachievements-vb.json')));
const SLIM = !flag('full');
const PRETTY = flag('pretty');
const BADGES = flag('badges');
const UNOFFICIAL = flag('unofficial');
const DELAY_MS = Number(opt('delay', '300'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// authenticated GET against the Web API, with a couple of retries on 429/5xx
async function api(endpoint, params = {}) {
    const url = new URL(`${API}/${endpoint}`);
    url.searchParams.set('y', API_KEY);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
    }

    for (let attempt = 1; ; attempt++) {
        let response;
        try {
            response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        } catch (error) {
            if (attempt > 4) {
                throw error;
            }
            await sleep(1000 * attempt);
            continue;
        }
        if (response.status === 429 || response.status >= 500) {
            if (attempt > 4) {
                throw new Error(`${endpoint} answered ${response.status} after ${attempt} tries`);
            }
            await sleep(1500 * attempt);
            continue;
        }
        if (response.status === 401) {
            throw new Error(
                'RetroAchievements rejected the key (401). RA_API_KEY must be a Web API key '
                + 'from https://retroachievements.org/settings ("Keys"), not your password.');
        }
        if (!response.ok) {
            throw new Error(`${endpoint} answered ${response.status}: ${await response.text()}`);
        }
        return response.json();
    }
}

const bytes = n => {
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

// RetroAchievements' epoch strings ("2016-04-27 19:04:04") as Unix seconds
const toEpoch = value => {
    if (value === null || value === undefined || value === '') {
        return undefined;
    }
    const ms = Date.parse(typeof value === 'string' ? value.replace(' ', 'T') + 'Z' : value);
    return Number.isNaN(ms) ? undefined : Math.round(ms / 1000);
};

const num = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

console.log('Resolving the Virtual Boy console id…');
const consoles = await api('API_GetConsoleIDs.php', { g: 1, a: 1 });
const vb = (Array.isArray(consoles) ? consoles : []).find(
    c => String(c.Name ?? c.name).toLowerCase() === 'virtual boy');
const consoleId = vb ? Number(vb.ID ?? vb.id) : 28;
console.log(`  Virtual Boy = ${consoleId}${vb ? '' : ' (fallback — not found in the console list)'}`);

console.log('Fetching the game list (achievement sets only)…');
const list = await api('API_GetGameList.php', { i: consoleId, f: 1, h: 1 });
const stubs = (Array.isArray(list) ? list : [])
    .filter(g => num(g.NumAchievements ?? g.numAchievements) > 0)
    .sort((a, b) => Number(a.ID ?? a.id) - Number(b.ID ?? b.id));
console.log(`  ${stubs.length} games with achievements`);

const games = [];
for (const [index, stub] of stubs.entries()) {
    const id = Number(stub.ID ?? stub.id);
    process.stdout.write(`  [${index + 1}/${stubs.length}] ${stub.Title ?? stub.title} (#${id})… `);
    const detail = await api('API_GetGameExtended.php', { i: id, f: UNOFFICIAL ? 5 : 3 });

    const achievements = Object.values(detail.Achievements ?? detail.achievements ?? {})
        .map(a => {
            const full = {
                id: num(a.ID ?? a.id),
                title: String(a.Title ?? a.title ?? ''),
                description: String(a.Description ?? a.description ?? ''),
                points: num(a.Points ?? a.points),
                trueRatio: num(a.TrueRatio ?? a.trueRatio),
                type: (a.type ?? a.Type ?? '') || undefined,
                displayOrder: num(a.DisplayOrder ?? a.displayOrder),
                badgeName: String(a.BadgeName ?? a.badgeName ?? ''),
                numAwarded: num(a.NumAwarded ?? a.numAwarded),
                numAwardedHardcore: num(a.NumAwardedHardcore ?? a.numAwardedHardcore),
                memAddr: String(a.MemAddr ?? a.memAddr ?? ''),
                author: String(a.Author ?? a.author ?? ''),
                created: toEpoch(a.DateCreated ?? a.dateCreated),
                modified: toEpoch(a.DateModified ?? a.dateModified),
            };
            if (SLIM) {
                delete full.memAddr;
                delete full.author;
                delete full.created;
                delete full.modified;
                delete full.trueRatio;
            }
            return full;
        })
        .sort((a, b) => a.displayOrder - b.displayOrder || a.id - b.id);

    const game = {
        id,
        title: String(detail.Title ?? detail.title ?? stub.Title ?? ''),
        imageIcon: String(detail.ImageIcon ?? detail.imageIcon ?? stub.ImageIcon ?? ''),
        developer: (detail.Developer ?? detail.developer ?? '') || undefined,
        publisher: (detail.Publisher ?? detail.publisher ?? '') || undefined,
        genre: (detail.Genre ?? detail.genre ?? '') || undefined,
        released: (detail.Released ?? detail.released ?? '') || undefined,
        points: achievements.reduce((sum, a) => sum + a.points, 0),
        numDistinctPlayers: num(detail.NumDistinctPlayers ?? detail.numDistinctPlayers),
        hashes: Array.isArray(stub.Hashes ?? stub.hashes)
            ? (stub.Hashes ?? stub.hashes).map(h => String(h).toLowerCase())
            : [],
        achievements,
    };
    if (!SLIM) {
        game.imageBoxArt = String(detail.ImageBoxArt ?? detail.imageBoxArt ?? '') || undefined;
        game.richPresencePatch =
            (detail.RichPresencePatch ?? detail.richPresencePatch ?? '') || undefined;
    }
    games.push(game);

    console.log(`${achievements.length} achievements`);
    if (DELAY_MS > 0 && index < stubs.length - 1) {
        await sleep(DELAY_MS);
    }
}

const dataset = {
    source: 'RetroAchievements Web API',
    console: { id: consoleId, name: vb?.Name ?? vb?.name ?? 'Virtual Boy' },
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    slim: SLIM,
    unofficial: UNOFFICIAL,
    gameCount: games.length,
    achievementCount: games.reduce((sum, g) => sum + g.achievements.length, 0),
    games,
};

const json = JSON.stringify(dataset, undefined, PRETTY ? 2 : undefined) + '\n';
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, json);

const gz = gzipSync(JSON.stringify(dataset)).length;

console.log('\n──────────────────────────────────────────────');
console.log(`games:        ${dataset.gameCount}`);
console.log(`achievements: ${dataset.achievementCount}`);
console.log(`mode:         ${SLIM ? 'trimmed (shipped)' : 'full (--full)'}`);
console.log(`written to:   ${path.relative(REPO_ROOT, OUT)}`);
console.log('');
console.log(`on disk (${PRETTY ? 'pretty' : 'minified'} + newline):  ${bytes(Buffer.byteLength(json))}`);
console.log(`minified + gzip:                ${bytes(gz)}   ← what it costs to serve`);

if (BADGES) {
    const badgeDir = path.join(path.dirname(OUT), 'badges');
    await mkdir(badgeDir, { recursive: true });
    const names = new Set();
    for (const g of games) {
        for (const a of g.achievements) {
            if (a.badgeName) {
                names.add(a.badgeName);
            }
        }
    }
    console.log(`\nDownloading ${names.size * 2} badge PNGs (locked + unlocked) into ${path.relative(REPO_ROOT, badgeDir)}…`);
    let total = 0;
    let done = 0;
    for (const name of names) {
        for (const suffix of ['', '_lock']) {
            const res = await fetch(`${MEDIA}/Badge/${name}${suffix}.png`, {
                headers: { 'User-Agent': USER_AGENT },
            });
            if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                total += buf.length;
                await writeFile(path.join(badgeDir, `${name}${suffix}.png`), buf);
            }
            done++;
            if (done % 50 === 0) {
                process.stdout.write(`  ${done}/${names.size * 2}\r`);
            }
        }
        await sleep(50);
    }
    console.log(`\nbadges on disk: ${bytes(total)} across ${names.size * 2} files`);
}

console.log('──────────────────────────────────────────────');
