/**
 * Checks the proxy end to end through PHP's built-in dev server: routing, CORS, method and host rejection, and
 * requests that never reach the network. Real pass-through replies can't be stubbed, as PHP calls cURL directly;
 * those are covered by proxy-logic-test.php and a curl against the deployed instance (see README.md).
 *
 * Usage: node tests/server-probe.mjs (needs `php` on PATH).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');

let failures = 0;
function check(label, actual, expected) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    if (!same) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}
function section(name) {
    console.log(`\n${name}`);
}

function startServer(port, env) {
    const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', 'public', 'public/router.php'], {
        cwd: packageRoot,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'ignore', 'ignore'],
    });
    return child;
}

async function waitUntilUp(origin, attempts = 50) {
    for (let i = 0; i < attempts; i++) {
        try {
            await fetch(`${origin}/nothing-here`);
            return;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    throw new Error(`server never came up at ${origin}`);
}

const port = 8700 + Math.floor(Math.random() * 200);
const restrictedPort = port + 1;
const origin = `http://127.0.0.1:${port}`;
const restrictedOrigin = `http://127.0.0.1:${restrictedPort}`;

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vueport-server-'));
const REVIEW_TOKEN = 'a-review-token-long-enough-to-count';
const server = startServer(port, { VUEPORT_DATA_DIR: dataDir, VUEPORT_REVIEW_TOKEN: REVIEW_TOKEN });
const restricted = startServer(restrictedPort, { VUEPORT_ALLOWED_ORIGINS: 'https://vueport.app' });

try {
    await waitUntilUp(origin);
    await waitUntilUp(restrictedOrigin);

    section('Planet VB');
    {
        const posted = await fetch(`${origin}/pvb/82a95e51/`, { method: 'POST' });
        check('only GET is offered', posted.status, 405);
    }

    section('RetroAchievements');
    {
        const elsewhere = await fetch(`${origin}/ra`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method: 'GET', url: 'https://example.com/steal' }),
        });
        check('a host that is not RetroAchievements is refused', elsewhere.status, 400);

        const malformed = await fetch(`${origin}/ra`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'not json',
        });
        check('malformed JSON is rejected, not thrown past', malformed.status, 400);

        const missingFields = await fetch(`${origin}/ra`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method: 'GET' }),
        });
        check('a missing url is rejected', missingFields.status, 400);

        const wrongMethod = await fetch(`${origin}/ra`);
        check('only POST is offered', wrongMethod.status, 405);
    }

    section('Game pad profiles');
    {
        const profile = {
            format: 'vueport-gamepad-profile', version: 1, id: 'test-pad', name: 'Test Pad', family: 'generic',
            match: { device: '1234:5678', mapping: '' }, deadZone: 0.5,
            buttons: { a: [{ kind: 'button', index: 0 }] },
        };
        const send = (body, extra = {}) => fetch(`${origin}/gamepad-profiles`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            ...extra,
        });

        const sent = await send({ profile, note: 'first' });
        check('a profile is received', sent.status, 201);
        check('and says so', (await sent.json()).status, 'received');
        check('a second identical one is a duplicate', (await send({ profile, note: 'again' })).status, 200);
        check('a malformed one is refused', (await send({ profile: { ...profile, id: '../x' } })).status, 400);
        check('so is JSON that is not a submission', (await fetch(`${origin}/gamepad-profiles`, {
            method: 'POST', body: 'not json',
        })).status, 400);
        check('so is an oversized body', (await fetch(`${origin}/gamepad-profiles`, {
            method: 'POST', body: 'x'.repeat(40 * 1024),
        })).status, 413);

        // five an hour from one address; the first above counted as one
        const statuses = [];
        for (let n = 0; n < 5; n++) {
            statuses.push((await send({ profile: { ...profile, id: `test-pad-${n}` } })).status);
        }
        check('the sixth in an hour is turned away', statuses, [201, 201, 201, 201, 429]);

        const stored = (await readdir(path.join(dataDir, 'gamepad-profiles'))).filter(name => name.endsWith('.json'));
        check('each one received is a file', stored.length, 5);

        const anonymous = await fetch(`${origin}/gamepad-profiles`);
        check('listing without the token is not there at all', anonymous.status, 404);
        const listed = await fetch(`${origin}/gamepad-profiles`, { headers: { 'x-review-token': REVIEW_TOKEN } });
        check('listing with it works', listed.status, 200);
        const { submissions } = await listed.json();
        check('and lists them', submissions.length, 5);
        const first = submissions.find(item => item.note === 'first');
        check('with the note', first?.profile?.id, 'test-pad');
        check('and no address anywhere', JSON.stringify(submissions).includes('127.0.0.1'), false);

        const wrongToken = await fetch(`${origin}/gamepad-profiles/${first.name}`, {
            method: 'DELETE', headers: { 'x-review-token': 'wrong' },
        });
        check('deleting with a wrong token is refused', wrongToken.status, 404);
        const deleted = await fetch(`${origin}/gamepad-profiles/${first.name}`, {
            method: 'DELETE', headers: { 'x-review-token': REVIEW_TOKEN },
        });
        check('deleting with the token works', deleted.status, 204);
        const traversal = await fetch(`${origin}/gamepad-profiles/..%2Fsalt`, {
            method: 'DELETE', headers: { 'x-review-token': REVIEW_TOKEN },
        });
        check('a delete cannot reach outside the queue', traversal.status, 405);
    }

    section('LAN shares');
    {
        const share = {
            id: '0123456789abcdef', secret: 'f'.repeat(32), token: '1'.repeat(24),
            device: 'Mac mini', title: 'Wario Land', name: 'Wario Land.vb',
            addresses: ['192.168.1.17:47913'], state: true,
        };
        const post = (route, body) => fetch(`${origin}/lan-shares${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });

        const empty = await fetch(`${origin}/lan-shares`);
        check('nothing shared yet', (await empty.json()).shares, []);
        check('the list is never cached', empty.headers.get('cache-control'), 'no-store');

        const shared = await post('', share);
        check('a share is taken', shared.status, 200);
        check('and its lifetime said', (await shared.json()).ttl, 90);
        const listed = (await (await fetch(`${origin}/lan-shares`)).json()).shares;
        check('the network sees it', listed.map(item => item.title), ['Wario Land']);
        check('without the secret', JSON.stringify(listed).includes('f'.repeat(32)), false);
        check('or anything like it', listed[0].secretHash, undefined);

        check('renewing it works', (await post('', { ...share, title: 'Wario Land 2' })).status, 200);
        check('and replaces it rather than adding one',
            (await (await fetch(`${origin}/lan-shares`)).json()).shares.map(item => item.title), ['Wario Land 2']);
        check('somebody else cannot take it over', (await post('', { ...share, secret: 'e'.repeat(32) })).status, 403);
        check('a share pointing outside the LAN is refused',
            (await post('', { ...share, addresses: ['85.214.133.93:80'] })).status, 400);
        check('so is an oversized body', (await fetch(`${origin}/lan-shares`, {
            method: 'POST', body: 'x'.repeat(8 * 1024),
        })).status, 413);

        await post('/withdraw', { id: share.id, secret: 'e'.repeat(32) });
        check('a wrong secret does not withdraw it', (await (await fetch(`${origin}/lan-shares`)).json()).shares.length, 1);
        check('withdrawing works', (await post('/withdraw', { id: share.id, secret: share.secret })).status, 200);
        check('and it is gone', (await (await fetch(`${origin}/lan-shares`)).json()).shares, []);
        check('no addresses are written down',
            (await readdir(path.join(dataDir, 'lan-shares'))).some(name => name.includes('127.0.0.1')), false);
    }

    section('Routing and CORS');
    {
        const missing = await fetch(`${origin}/nothing-here`);
        check('an unknown path is 404', missing.status, 404);

        const preflight = await fetch(`${origin}/pvb/rom/x/`, { method: 'OPTIONS' });
        check('a preflight is answered without reaching the handler', preflight.status, 204);
        check('open by default', preflight.headers.get('access-control-allow-origin'), '*');

        const openReply = await fetch(`${origin}/nothing-here`);
        check('every reply carries the header, not just preflights',
            openReply.headers.get('access-control-allow-origin'), '*');

        const allowed = await fetch(`${restrictedOrigin}/nothing-here`, {
            headers: { origin: 'https://vueport.app' },
        });
        check('a listed origin is echoed back once restricted',
            allowed.headers.get('access-control-allow-origin'), 'https://vueport.app');

        const disallowed = await fetch(`${restrictedOrigin}/nothing-here`, {
            headers: { origin: 'https://not-vueport.example' },
        });
        check('an unlisted origin gets no header at all',
            disallowed.headers.get('access-control-allow-origin'), null);
    }
} finally {
    server.kill();
    restricted.kill();
    await rm(dataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
