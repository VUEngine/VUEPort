// exercises the built rcheevos.js as vb-rcheevos.ts does, without a browser or network: login and game load through
// canned server responses, checking the JSON it emits. Not part of `yarn test`, as it needs a fresh build.mjs run
// Usage: node packages/core/wasm/rcheevos/smoke.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasmBytes = readFileSync(path.join(__dirname, 'rcheevos.wasm'));

// the glue is built for a Web Worker and reads `self.location.href` at load; a stub is enough, as instantiateWasm below
// skips the fetch paths
globalThis.self ??= globalThis;
globalThis.location ??= { href: `file://${__dirname}/` };

// a MODULARIZE (non-ES6) build is a UMD script, so `require` reaches the same factory the worker gets via importScripts
const createVueportRc = require(path.join(__dirname, 'rcheevos.js'));

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        failures++;
    }
};

const emitted = [];
const serverCalls = [];

const module = await createVueportRc({
    instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasmBytes, imports).then(result => done(result.instance));
        return {};
    },
});

module.vrcEmit = json => {
    try {
        emitted.push(JSON.parse(json));
    } catch {
        emitted.push({ t: 'UNPARSEABLE', raw: json });
    }
};
module.vrcServerCall = (id, method, url, body) => serverCalls.push({ id, method, url, body });
// the emulated machine as rcheevos sees it: zero until a check pokes a byte to make a leaderboard's start and submit
// conditions happen
const memory = new Uint8Array(0x20000);
module.vrcReadMemory = (address, buffer, length) => {
    for (let i = 0; i < length; i++) {
        module.HEAPU8[buffer + i] = memory[address + i] ?? 0;
    }
    return length;
};

const runFrames = (frames = 3) => {
    for (let i = 0; i < frames; i++) {
        module._vrc_do_frame(client);
    }
};

function withString(text, use) {
    const size = module.lengthBytesUTF8(text) + 1;
    const pointer = module._malloc(size);
    module.stringToUTF8(text, pointer, size);
    try {
        return use(pointer);
    } finally {
        module._free(pointer);
    }
}

function provideResponse(id, status, bodyText) {
    withString(bodyText, body => module._vrc_provide_response(id, status, body));
}

console.log('\nCreate');
const client = module._vrc_create();
check('vrc_create returns a client', client !== 0);
check('vrc_set_hardcore is exported', typeof module._vrc_set_hardcore === 'function');
check('and is safe to call before a game is loaded', (() => {
    try {
        module._vrc_set_hardcore(client, 1);
        module._vrc_set_hardcore(client, 0);
        return true;
    } catch {
        return false;
    }
})());

console.log('\nLogin');
withString('TestUser', u => withString('hunter2', p =>
    module._vrc_begin_login_password(client, u, p)));
check('a server call was issued', serverCalls.length === 1);
check('it POSTs to dorequest.php', serverCalls[0]?.method === 'POST'
    && /dorequest\.php$/.test(serverCalls[0]?.url ?? ''));
check('it is the login2 request', /(^|&)r=login2(&|$)/.test(serverCalls[0]?.body ?? ''));

provideResponse(serverCalls[0].id, 200, JSON.stringify({
    Success: true, User: 'TestUser', Token: 'tok-abc-123', Score: 1234, SoftcoreScore: 56,
}));
const login = emitted.find(e => e.t === 'login');
check('a login message was emitted', !!login);
check('it reports success', login?.ok === true);
check('with the username', login?.user?.username === 'TestUser');
check('the token to keep', login?.user?.token === 'tok-abc-123');
check('the softcore score', login?.user?.softcore === 56);

console.log('\nLoad game');
serverCalls.length = 0;
emitted.length = 0;
withString('0'.repeat(32), h => module._vrc_begin_load_game(client, h));
check('loading a game issues a server call', serverCalls.length >= 1);
provideResponse(serverCalls[0].id, 404, JSON.stringify({ Success: false, Error: 'Unknown game' }));
// frame processing must be safe to call with no set loaded
module._vrc_do_frame(client);
module._vrc_idle(client);
const load = emitted.find(e => e.t === 'load');
check('an unrecognized ROM is reported', load ? load.ok === false : true);

console.log('\nLoad game with an achievement set');
serverCalls.length = 0;
emitted.length = 0;
withString('1'.repeat(32), h => module._vrc_begin_load_game(client, h));
// rc_client 12.x resolves the hash and fetches the set in one "achievementsets" call, not the resolve-then-patch pair
// older docs describe
check('the achievement-set call is issued', serverCalls.length === 1);
provideResponse(serverCalls[0]?.id, 200, JSON.stringify({
    Success: true,
    GameId: 4242,
    Title: '~Homebrew~ Test Game',
    ConsoleId: 28,
    ImageIconUrl: 'https://media.retroachievements.org/Images/game.png',
    RichPresenceGameId: 4242,
    RichPresencePatch: '',
    Sets: [{
        AchievementSetId: 9001,
        GameId: 4242,
        Title: '~Homebrew~ Test Game',
        Type: 'core',
        ImageIconUrl: 'https://media.retroachievements.org/Images/game.png',
        Achievements: [
            {
                ID: 5001, Title: 'Ordinary Achievement', Description: 'Do the thing.',
                Flags: 3, Points: 5, MemAddr: '0xH000000=1', Author: 'someone',
                BadgeName: '11111', Created: 1600000000, Modified: 1600000000,
                Type: '', BadgeURL: '', BadgeLockedURL: '',
                // Rarity/RarityHardcore left out on purpose: the shim should relay rc_client's default (100, "common")
            },
            {
                ID: 5002, Title: 'Missable Achievement', Description: 'Do not miss it.',
                Flags: 3, Points: 10, MemAddr: '0xH000001=1', Author: 'someone',
                BadgeName: '22222', Created: 1600000000, Modified: 1600000000,
                Type: 'missable', Rarity: 12.5, RarityHardcore: 4.2,
                BadgeURL: '', BadgeLockedURL: '',
            },
        ],
        Leaderboards: [
            {
                ID: 7001, Title: 'High Score', Description: 'Score as much as possible.',
                Mem: 'STA:0xH000002=1::CAN:0xH000002=0::SUB:0xH000003=1::VAL:0xH000004',
                Format: 'SCORE', LowerIsBetter: false, Hidden: false,
            },
            {
                ID: 7002, Title: 'Any% Speedrun', Description: 'Finish as fast as possible.',
                Mem: 'STA:0xH000005=1::CAN:0xH000005=0::SUB:0xH000006=1::VAL:M:0xH000007',
                Format: 'TIME', LowerIsBetter: true, Hidden: false,
            },
        ],
    }],
}));

// kicked off synchronously once the set is accepted (rc_client_fetch_game_sets_callback), not on a later idle tick
check('the start-session call follows in the same turn', serverCalls.length === 2);
provideResponse(serverCalls[1]?.id, 200, JSON.stringify({
    Success: true,
    Unlocks: [{ ID: 5002, When: 1700000000 }],
    HardcoreUnlocks: [],
    ServerNow: 1700000100,
}));
module._vrc_idle(client);

const loaded = emitted.find(e => e.t === 'load');
check('the game loads', loaded?.ok === true);
check('and the ~Homebrew~ tag is still in the title as the API sent it — the panel splits it out itself',
    loaded?.game?.title === '~Homebrew~ Test Game');

const achlist = emitted.filter(e => e.t === 'achlist').at(-1);
const ordinary = achlist?.achievements?.find(a => a.id === 5001);
const missable = achlist?.achievements?.find(a => a.id === 5002);
check('an achievement with no Type in the response carries none', ordinary?.type === undefined);
check("rc_client's own default rarity comes through when the response left it out", ordinary?.rarity === 100);
check('a missable achievement says so', missable?.type === 1); // RC_CLIENT_ACHIEVEMENT_TYPE_MISSABLE
check('with its real rarity', missable?.rarity === 12.5 && missable?.rarityHardcore === 4.2);
check('and the unlock time start-session reported', missable?.unlockTime === 1700000000);
check('the still-locked achievement has no unlock time', ordinary?.unlockTime === undefined);

const lblist = emitted.filter(e => e.t === 'lblist').at(-1);
const highScore = lblist?.leaderboards?.find(l => l.id === 7001);
const speedrun = lblist?.leaderboards?.find(l => l.id === 7002);
check('a leaderboard list is emitted with the set', !!lblist);
check('both leaderboards are in it', lblist?.leaderboards?.length === 2);
check('a score board says so', highScore?.format === 'score' && highScore?.lower === false);
check('a timed board says so, and that less is more',
    speedrun?.format === 'time' && speedrun?.lower === true);
// softcore, which vrc_create leaves every client in: RetroAchievements only runs leaderboards in hardcore
check('and neither is active while the client is softcore',
    highScore?.state === 'inactive' && speedrun?.state === 'inactive');
check('an idle board carries no tracker value', highScore?.value === undefined);

console.log('\nHardcore is what arms them');
emitted.length = 0;
module._vrc_set_hardcore(client, 1);
const armed = emitted.filter(e => e.t === 'lblist').at(-1);
check('turning hardcore on re-emits the list', !!armed);
check('and every board is armed', armed?.leaderboards?.every(l => l.state === 'active') === true);

console.log('\nAn attempt, start to submission');
// rc_client parks a game that entered hardcore mid-session until a reset, processing no frame before it. VUEPort's
// hardcore switch restarts the ROM and never gets here, but toggling the flag in place, as above, does
module._vrc_reset(client);
// 7001 starts on 0xH000002=1, cancels when it goes back to 0, submits on 0xH000003=1 and reads its value from 0xH000004
emitted.length = 0;
serverCalls.length = 0;
runFrames();
check('nothing starts while the start condition is false',
    emitted.every(e => e.t !== 'lbattempt'));

memory[2] = 1;
memory[4] = 7;
runFrames();
const started = emitted.find(e => e.t === 'lbattempt');
check('setting the start condition starts the attempt', started?.state === 'started');
check('naming the board it belongs to', started?.id === 7001 && started?.title === 'High Score');
const tracker = emitted.filter(e => e.t === 'lbtrack').at(-1);
check('and a tracker appears with the value', tracker?.show === true && tracker?.display === '000007');
// the tracker id is the tracker's, not the leaderboard's: boards reading the same value share one, which the overlay
// keys on
check('the tracker carries its own id', typeof tracker?.id === 'number');
const runningList = emitted.filter(e => e.t === 'lblist').at(-1);
check('and the board now reads as tracking',
    runningList?.leaderboards?.find(l => l.id === 7001)?.state === 'tracking');
check('carrying the running value', runningList?.leaderboards?.find(l => l.id === 7001)?.value === '000007');

emitted.length = 0;
memory[4] = 9;
runFrames();
check('the value moving moves the tracker',
    emitted.filter(e => e.t === 'lbtrack').at(-1)?.display === '000009');

emitted.length = 0;
memory[3] = 1;
runFrames();
const submitted = emitted.find(e => e.t === 'lbattempt');
check('meeting the submit condition ends the attempt', submitted?.state === 'submitted');
check('the tracker is taken away with it',
    emitted.filter(e => e.t === 'lbtrack').at(-1)?.show === false);
const submitCall = serverCalls.find(c => /(^|&)r=submitlbentry(&|$)/.test(c.body ?? ''));
check('and the score goes to the server', !!submitCall);

emitted.length = 0;
provideResponse(submitCall.id, 200, JSON.stringify({
    Success: true,
    Response: {
        Score: 9, BestScore: 9, ScoreFormatted: '000009',
        LBData: { Format: 'SCORE', LeaderboardID: 7001, GameID: 4242, Title: 'High Score', LowerIsBetter: 0 },
        RankInfo: { Rank: 2, NumEntries: '3' },
        TopEntries: [
            { User: 'Speedy', Score: 99000, Rank: 1 },
            { User: 'TestUser', Score: 9, Rank: 2 },
        ],
    },
}));
const scoreboard = emitted.find(e => e.t === 'lbboard');
check("the server's answer comes back as a scoreboard", scoreboard?.id === 7001);
check('with the new standing', scoreboard?.rank === 2 && scoreboard?.total === 3);
check('the score as the board formats it', scoreboard?.submitted === '000009');
check('and the top of the board', scoreboard?.top?.[0]?.user === 'Speedy');

memory[2] = 0;
memory[3] = 0;
runFrames();

emitted.length = 0;
module._vrc_set_hardcore(client, 0);
const disarmed = emitted.filter(e => e.t === 'lblist').at(-1);
check('leaving hardcore stands them down again',
    disarmed?.leaderboards?.every(l => l.state === 'inactive') === true);

console.log('\nLeaderboard entries');
serverCalls.length = 0;
emitted.length = 0;
check('vrc_begin_fetch_leaderboard_entries is exported',
    typeof module._vrc_begin_fetch_leaderboard_entries === 'function');
module._vrc_begin_fetch_leaderboard_entries(client, 77, 7001, 1, 25, 0); // 77 is the fetch id
check('asking for entries issues a server call', serverCalls.length === 1);
check('it is the lbinfo request for that board',
    /(^|&)r=lbinfo(&|$)/.test(serverCalls[0]?.body ?? '') && /(^|&)i=7001(&|$)/.test(serverCalls[0]?.body ?? ''));
provideResponse(serverCalls[0]?.id, 200, JSON.stringify({
    Success: true,
    LeaderboardData: {
        LBID: 7001, LBFormat: 'SCORE', LowerIsBetter: 0,
        LBTitle: 'High Score', LBDesc: 'Score as much as possible.',
        LBMem: 'STA:0xH000002=1::CAN:0xH000002=0::SUB:0xH000003=1::VAL:0xH000004',
        GameID: 4242, LBAuthor: 'someone',
        LBCreated: '2020-09-13 12:26:40', LBUpdated: '2020-09-13 12:26:40',
        TotalEntries: 2,
        Entries: [
            { User: 'Someone', Rank: 1, Index: 1, Score: 9000, DateSubmitted: 1700000000 },
            { User: 'TestUser', Rank: 2, Index: 2, Score: 42, DateSubmitted: 1700000200 },
        ],
    },
}));
const entries = emitted.find(e => e.t === 'lbentries');
check('the entries come back', entries?.ok === true);
check('carrying the fetch id they were asked for', entries?.fetch === 77);
check('with the whole board\'s size, not just this page', entries?.total === 2);
check('and both rows', entries?.entries?.length === 2);
// rcheevos formats every value for its board before the shim sees it: a SCORE board is zero-padded to six digits, as
// the site shows it
check('formatted for the board rather than as a raw number', entries?.entries?.[0]?.display === '009000');
check('and a timestamp survives with its seconds intact',
    entries?.entries?.[1]?.submitted === 1700000200);
check('with an avatar rcheevos derived from the username',
    /TestUser/.test(entries?.entries?.[1]?.avatar ?? ''));
check('and the signed-in player found in the page', entries?.userIndex === 1);

console.log('\nA leaderboard nobody has an entry on');
serverCalls.length = 0;
emitted.length = 0;
module._vrc_begin_fetch_leaderboard_entries(client, 78, 7002, 1, 25, 0);
provideResponse(serverCalls[0]?.id, 404, JSON.stringify({ Success: false, Error: 'Unknown leaderboard' }));
const failedEntries = emitted.find(e => e.t === 'lbentries');
check('a failed fetch is answered rather than left hanging', failedEntries?.ok === false);
check('against the same fetch id', failedEntries?.fetch === 78);

console.log('\nLogin failure');
serverCalls.length = 0;
emitted.length = 0;
withString('Nobody', u => withString('wrong', p =>
    module._vrc_begin_login_password(client, u, p)));
provideResponse(serverCalls[0].id, 403, JSON.stringify({ Success: false, Error: 'Invalid credentials' }));
const failedLogin = emitted.find(e => e.t === 'login');
check('a failed login is reported', failedLogin?.ok === false);
check('with the error text', /credential/i.test(failedLogin?.err ?? ''));

console.log(failures === 0
    ? '\nAll checks passed.'
    : `\n${failures} check(s) failed — the JSON contract with vb-rcheevos.ts is off.`);
process.exit(failures === 0 ? 0 : 1);
