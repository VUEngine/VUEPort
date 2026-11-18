/**
 * Probe mode in the packaged desktop shell with nothing but VUEPort: the app started with `--probe`, and the same
 * binary as client (`VUEPort --probe-cli`, `--probe-call`). The cartridge is packages/probe/tests/test-rom.mjs, whose
 * counter at 0x05000010 says how far a machine has run. Checks the game (status, pause, capture, save, load, export,
 * quit), forks (vbprobe's commands inside the app) and the door (a wrong token, a web page).
 *
 * Not part of `yarn test` (opens a window, needs Rust and a built front end); run deliberately:
 *   yarn --cwd packages/web build
 *   cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml
 *   node packages/desktop/tests/probe-mode-probe.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..', '..');
const binary = path.join(__dirname, '..', 'src-tauri', 'target', 'debug', 'VUEPort');
const frontend = path.join(root, 'packages', 'web', 'dist', 'index.html');

const DEADLINE_MS = 30000;

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
    if (!ok) {
        failures++;
    }
};

for (const [what, file, how] of [
    ['development build', binary, 'cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml'],
    ['front end', frontend, 'yarn --cwd packages/web build'],
]) {
    if (!existsSync(file)) {
        console.log(`\nskipped: no ${what} (${how})\n`);
        process.exit(0);
    }
}

const { buildRom, COUNTER } = await import(path.join(root, 'packages', 'core', 'tests', 'probe-test-rom.mjs'));
const counter = `0x${COUNTER.toString(16)}`;

// the probe's own test program, with a header so the app opens it
const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-probe-'));
const romPath = path.join(scratch, 'counter.vb');
{
    const rom = Buffer.from(buildRom());
    const header = rom.length - 544;
    rom.write('VUEPORT PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 1;
    await writeFile(romPath, rom);
}

// a home of its own as in link-probe.mjs, which also takes the probe file; the user's recent list and saves stay
// untouched
const home = path.join(scratch, 'home');
await mkdir(home, { recursive: true });
const probeFile = path.join(home, '.vueport', 'probe.json');
const env = { ...process.env, HOME: home };

const vueport = (...args) => {
    const run = spawnSync(binary, args, { cwd: scratch, env, encoding: 'utf8', timeout: 120000 });
    return { code: run.status, out: run.stdout, err: run.stderr };
};
const cli = (...args) => vueport('--probe-cli', ...args);
// the counter, as the hex dump of a command prints it
const counterIn = text => {
    const match = /0x05000010 {2}((?:[0-9a-f]{2} ){3}[0-9a-f]{2})/.exec(text);
    return match ? Buffer.from(match[1].replace(/ /g, ''), 'hex').readUInt32LE(0) : undefined;
};

console.log('\nThe Probe mode, with nothing but VUEPort\n');
const app = spawn(binary, ['--probe', romPath], { stdio: ['ignore', 'ignore', 'inherit'], env });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = Date.now() + DEADLINE_MS;
try {
    while (!existsSync(probeFile) && Date.now() < deadline) {
        await sleep(200);
    }
    check('--probe writes the probe file', existsSync(probeFile));
    if (!existsSync(probeFile)) {
        throw new Error('no probe file');
    }
    if (process.platform !== 'win32') {
        check('... readable by this user alone', (statSync(probeFile).mode & 0o777) === 0o600,
            (statSync(probeFile).mode & 0o777).toString(8));
    }

    console.log('\nthe protocol, raw');
    const hello = JSON.parse(vueport('--probe-call', '{"method":"hello"}').out);
    check('--probe-call speaks JSON', hello.result?.app === 'VUEPort' && hello.result?.protocol === 1, JSON.stringify(hello));

    console.log('\nthe game itself');
    let status = cli('status');
    while (!status.out.includes('counter.vb') && Date.now() < deadline) {
        await sleep(200);
        status = cli('status');
    }
    check('status names the game', status.code === 0 && status.out.includes('counter.vb'), status.out + status.err);
    const help = cli('help');
    check('help lists the commands for the game and for forks', help.out.includes('capture <file.png>') && help.out.includes('--fork <name>'));

    const first = counterIn(cli('peek', `${counter}:4`).out);
    await sleep(300);
    const second = counterIn(cli('peek', `${counter}:4`).out);
    check('peek reads the game, and the game is moving', first !== undefined && second > first, `${first} then ${second}`);

    cli('pause');
    const paused = counterIn(cli('peek', `${counter}:4`).out);
    await sleep(300);
    check('pause holds it', counterIn(cli('peek', `${counter}:4`).out) === paused);

    check('regs', /^pc {3}0x[0-9a-f]{8}/m.test(cli('regs').out));
    check('vip', cli('vip').out.includes('worlds drawn'));
    cli('capture', 'seen.png');
    check('capture writes the screen here', readFileSync(path.join(scratch, 'seen.png')).subarray(1, 4).toString('latin1') === 'PNG');

    console.log('\nforks');
    check('fork keeps a copy of this moment', cli('fork', 'one').out.startsWith('one: a copy of this moment'));
    const watched = cli('watch', '--fork', 'one', '--frames', '2', '--write', `${counter}:4`);
    check('a watch runs on the fork', /watch 1 {2}write 0x05000010 \(4 bytes\) {2}\d+ hits in 2 frames/.test(watched.out), watched.out + watched.err);
    const onFork = counterIn(cli('peek', '--fork', 'one', `${counter}:4`).out);
    check('... and the fork went on from there', onFork > paused, `${onFork} vs ${paused}`);
    check('... while the game stayed where it was', counterIn(cli('peek', `${counter}:4`).out) === paused);
    cli('run', '--fork', 'one', '--frames', '1', '--state-out', 'fork.vess');
    check('a file written on a fork lands here', existsSync(path.join(scratch, 'fork.vess')));
    check('forks lists it', /^one {2}frame 3 /m.test(cli('forks').out), cli('forks').out);
    const stopped = cli('regs', '--fork', 'one', '--frames', '5', '--write', `${counter}:4`, '--stop');
    check('a watch can stop a fork', stopped.out.includes('stopped (watch)'), stopped.out);
    check('drop lets it go', cli('drop', 'one').out === 'dropped one\n' && cli('forks').out === 'no forks\n');

    console.log('\nthe newer commands, through the app');
    check('coverage on a copy of the moment', /coverage: \d+ instructions ran/.test(cli('coverage', '--frames', '1').out));
    cli('search', '--type', 'u32', '--candidates', 'counter.search');
    cli('fork', 'two');
    const searched = cli('search', '--fork', 'two', '--frames', '1', '--op', 'increased', '--candidates', 'counter.search');
    check('a search carried across calls in a file', searched.out.includes('0x05000010'), searched.out + searched.err);
    const { at } = await import(path.join(root, 'packages', 'core', 'tests', 'probe-test-rom.mjs'));
    const patched = cli('asm', '--fork', 'two', `0x${at.loop.toString(16)}`, 'add 2, r11', '--frames', '1');
    check('asm patches a fork', patched.out.includes('patched 2 bytes'), patched.out + patched.err);
    const copied = cli('fork', 'three', '--from', 'two');
    check('a fork of a fork', copied.out.startsWith('three: a copy of two'), copied.out + copied.err);
    const set = cli('peek', '--fork', 'three', '--exec', `0x${at.store.toString(16)}`, '--set', 'r11=1000', '--frames', '1', `${counter}:4`);
    check('--set on a fork', counterIn(set.out) === 1000, set.out + set.err);
    const shades = cli('fb', '--fork', 'three', 'left', 'shown');
    check('fb through the app', /left frame buffer [01], shown: shades/.test(shades.out), shades.out + shades.err);
    const origin = cli('origin', '--fork', 'three', '--frames', '0', '0,0');
    check('origin through the app', origin.out.includes('unknown: not drawn since origins were kept'), origin.out + origin.err);
    cli('drop', 'three');
    cli('drop', 'two');

    console.log('\none connection, many requests');
    {
        const { port, token } = JSON.parse(readFileSync(probeFile, 'utf8'));
        const lines = await import('node:net').then(net => new Promise(resolve => {
            const socket = net.connect({ host: '127.0.0.1', port }, () => {
                for (let id = 1; id <= 3; id++) {
                    socket.write(`${JSON.stringify({ id, token, method: 'cli', params: { args: ['peek', `${counter}:4`], inputs: {} } })}\n`);
                }
            });
            let text = '';
            socket.on('data', chunk => {
                text += chunk;
                if (text.split('\n').length > 3) {
                    socket.end();
                    resolve(text.trim().split('\n').map(line => JSON.parse(line)));
                }
            });
        }));
        check('each answered in turn on the same connection', lines.map(line => line.id).join(',') === '1,2,3', JSON.stringify(lines));
        check('... with the answer', lines.every(line => line.result?.text.includes('0x05000010')), JSON.stringify(lines[0]));
    }

    console.log('\nmoments');
    cli('save', 'now.vess');
    check('save writes the moment here', existsSync(path.join(scratch, 'now.vess')));
    cli('resume');
    await sleep(300);
    cli('pause');
    const moved = counterIn(cli('peek', `${counter}:4`).out);
    cli('load', 'now.vess');
    const back = counterIn(cli('peek', `${counter}:4`).out);
    check('load puts the moment back', moved !== paused && back === paused, `${moved} → ${back}, expected ${paused}`);
    cli('export', 'out');
    check('export writes the cartridge and the moment, for vbprobe',
        existsSync(path.join(scratch, 'out', 'counter.vb')) && existsSync(path.join(scratch, 'out', 'state.vess')));

    console.log('\nmistakes');
    const unknown = cli('jump');
    check('an unknown command fails with a reason', unknown.code !== 0 && unknown.err.includes('Unknown command'), unknown.err);
    const missing = cli('load', 'nowhere.vess');
    check('a file that is not there is said to be not there', missing.code !== 0 && missing.err.includes('nowhere.vess'), missing.err);

    console.log('\nstrangers');
    const { port } = JSON.parse(readFileSync(probeFile, 'utf8'));
    const stranger = await import('node:net').then(net => new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write('{"id":1,"token":"nope","method":"registers"}\n'));
        let text = '';
        socket.on('data', chunk => { text += chunk; });
        socket.on('close', () => resolve(text));
    }));
    check('a wrong token is answered with an error and the door shut', stranger.includes('Wrong token'), stranger);
    const http = await fetch(`http://127.0.0.1:${port}/`).then(() => 'answered', error => String(error));
    check('a web page speaking HTTP gets nowhere', http !== 'answered', http);

    console.log('\nquit');
    cli('quit');
    const gone = Date.now() + 10000;
    while (app.exitCode === null && app.signalCode === null && Date.now() < gone) {
        await sleep(100);
    }
    check('quit ends the application', app.exitCode !== null || app.signalCode !== null);
    check('... and takes the probe file with it', !existsSync(probeFile));
    const after = cli('status');
    check('afterwards the client says VUEPort is not there', after.code !== 0 && after.err.includes('Settings → Tools'), after.err);
} catch (error) {
    check('the run', false, String(error));
} finally {
    // the shell holds a quit until the game's saves are written, which a signal does not wait for, so the window is
    // asked first and then told
    if (app.exitCode === null && app.signalCode === null) {
        app.kill('SIGTERM');
        await sleep(1000);
    }
    if (app.exitCode === null && app.signalCode === null) {
        app.kill('SIGKILL');
    }
}

console.log(failures > 0 ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
process.exit(failures > 0 ? 1 : 0);
