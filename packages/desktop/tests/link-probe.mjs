/**
 * A linked two-player session in the packaged desktop shell. A webview cannot open a window itself, so the shell
 * builds one (src-tauri/src/link.rs), and whether two system-webview windows hear each other over a BroadcastChannel
 * is up to the webview, not Tauri; this checks both. It drives the development build started with a cartridge and
 * `--linked`, reporting through the `SMOKE {json}` line (see the README).
 *
 * Not part of `yarn test`, as it opens windows and needs Rust and a built front end:
 *   yarn --cwd packages/web build
 *   cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml
 *   node packages/desktop/tests/link-probe.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..', '..');
const binary = path.join(__dirname, '..', 'src-tauri', 'target', 'debug', 'vueport-desktop');
const frontend = path.join(root, 'packages', 'web', 'dist', 'index.html');

const DEADLINE_MS = 30000;

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
    if (!ok) {
        failures++;
    }
};

if (!existsSync(binary)) {
    console.log('\nskipped: no development build '
        + '(cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml)\n');
    process.exit(0);
}
if (!existsSync(frontend)) {
    console.log('\nskipped: the front end is not built (yarn --cwd packages/web build)\n');
    process.exit(0);
}

// a cartridge with a header, so it is opened rather than refused; this measures the shell around it
const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const romPath = path.join(scratch, 'probe.vb');
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 1;
    await writeFile(romPath, rom);
}

console.log('\nA linked session in the desktop shell\n');

// a home of its own, so the probe doesn't touch the user's recent list and saves in ~/.vueport
const home = path.join(scratch, 'home');
await mkdir(home, { recursive: true });

const app = spawn(binary, ['--linked', romPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, HOME: home },
});

// both windows print on the same stream unnamed, so they are told apart by the link check, which reports the label
// of the window it heard, the other one
const latest = new Map();
const rowsOf = report => new Map(report.results.map(row => [row.id, row]));

const done = new Promise(resolve => {
    const timer = setTimeout(() => resolve('timed out'), DEADLINE_MS);
    readline.createInterface({ input: app.stdout }).on('line', line => {
        if (!line.startsWith('SMOKE ')) {
            return;
        }
        let report;
        try {
            report = JSON.parse(line.slice(6));
        } catch {
            return;
        }
        const rows = rowsOf(report);
        const heard = rows.get('link')?.note ?? '';
        // "heard main" comes from the second player's window and vice versa; anything else is a window still alone
        const from = heard.startsWith('heard main') ? 'player2'
            : heard.startsWith('heard player2') ? 'main'
                : undefined;
        if (!from) {
            return;
        }
        latest.set(from, rows);
        // settled, not merely started: starting resets both machines in both windows, and the speed reading (a
        // one-second average) dips meanwhile. Wait for a steady state, the deadline as backstop
        const settled = rows => rows.get('session')?.state === 'pass'
            && rows.get('speed')?.state === 'pass'
            && rows.get('title')?.state === 'pass';
        if (latest.size === 2 && [...latest.values()].every(settled)) {
            clearTimeout(timer);
            resolve('linked');
        }
    });
});

const outcome = await done;
app.kill('SIGTERM');

check('both windows came up and heard each other', latest.size === 2,
    `${latest.size} window(s) reported: ${[...latest.keys()].join(', ') || 'none'}`);

const main = latest.get('main');
const second = latest.get('player2');

if (main && second) {
    check('the shell opened a second window with the page in it',
        second.get('app')?.state !== 'fail', second.get('app')?.note);
    check('the second window has the permissions the page needs',
        second.get('title')?.state === 'pass', second.get('title')?.note);
    check('a BroadcastChannel reaches between two windows of this webview',
        main.get('link')?.state === 'pass' && second.get('link')?.state === 'pass',
        `${main.get('link')?.note} / ${second.get('link')?.note}`);
    check('both windows are in one linked session', outcome === 'linked',
        `${main.get('session')?.note} / ${second.get('session')?.note}`);
    check('each window knows which player it is',
        (main.get('session')?.note ?? '').includes('P1')
        && (second.get('session')?.note ?? '').includes('P2'),
        `${main.get('session')?.note} / ${second.get('session')?.note}`);
    check('and both are still emulating at full speed',
        [main, second].every(rows => /^\d+%$/.test(rows.get('speed')?.note ?? '')
            && rows.get('speed')?.state === 'pass'),
        `${main.get('speed')?.note} / ${second.get('speed')?.note}`);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
