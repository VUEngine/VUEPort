/**
 * Checks what a ROM brings with it in the packaged desktop shell: ESSound tracks beside it, and the .elf the .map
 * beside it names. Both are outside the store, so they depend on the shell's guard, and too tight a guard looks like a
 * ROM with nothing beside it (checking the folder as if it were a file, for instance, makes the tracks unfindable).
 * Drives the real development build with a cartridge laid out like a VUEngine build, reporting through the webview
 * diagnostics' `SMOKE {json}` line.
 *
 * Not part of `yarn test` (opens a window, needs Rust and a built front end). Run in this order, as
 * generate_context! bakes the front end into the binary:
 *   yarn --cwd packages/web build
 *   cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml
 *   node packages/desktop/tests/companions-probe.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

// laid out like a VUEngine build: ROM and map in `build`, the image a folder further in. Audio files are named like the
// ESSound hardware names them (id, then kind), so they're tracks 1 and 101
const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-'));
const build = path.join(scratch, 'project', 'build');
const romPath = path.join(build, 'probe.vb');
await mkdir(path.join(build, 'working'), { recursive: true });
{
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write('VUEPORT PROBE'.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write('VPRB', header + 27, 'ascii');
    rom[header + 31] = 1;
    await writeFile(romPath, rom);
}
await writeFile(path.join(build, 'probe.map'),
    'OUTPUT(build/working/output-beta.elf elf32-v810)\n');
await writeFile(path.join(build, 'working', 'output-beta.elf'), Buffer.from('\x7fELF'));
await writeFile(path.join(build, '1.mp3'), Buffer.alloc(64));
await writeFile(path.join(build, '101.wav'), Buffer.alloc(64));

// a home of its own, so the user's ~/.vueport is left alone. companionFiles is seeded to the value that hid the bug:
// emulator files in the store, ESSound tracks beside the ROM unnoticed
const home = path.join(scratch, 'home');
await mkdir(path.join(home, '.vueport'), { recursive: true });
await writeFile(path.join(home, '.vueport', 'config.json'), JSON.stringify({
    state: { muted: true, saveSlot: 1, mode: 'play' },
    settings: { companionFiles: 'storage' },
}, undefined, 2));

// canonical, which on macOS means /private/var/… where the temporary directory is /var/…
const realRomPath = async () => (await import('node:fs/promises')).realpath(romPath);

console.log('\nA ROM and what is beside it, in the desktop shell\n');

const app = spawn(binary, [romPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, HOME: home },
});

const settled = new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), DEADLINE_MS);
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
        const rows = new Map(report.results.map(row => [row.id, row]));
        // `run` is every row's initial state; the first row takes three shell calls, the second the emulator starting the ROM
        // and looking beside it
        const settledRow = id => (rows.get(id)?.state ?? 'run') !== 'run';
        if (settledRow('beside') && settledRow('essound')) {
            clearTimeout(timer);
            resolve(rows);
        }
    });
});

const rows = await settled;
app.kill('SIGTERM');

check('the window came up and answered', rows !== undefined, 'nothing was reported in time');

if (rows) {
    const beside = rows.get('beside');
    const note = beside?.note ?? '';
    check('the ROM was handed to the page and stayed nameable',
        beside?.state !== 'warn', note);
    // the listing is what ESSound's scan does, and what used to be refused; the emulator may add its own save beside the
    // four files written, so at least those
    const files = Number(/files=(\d+)/.exec(note)?.[1] ?? -1);
    check("the ROM's own folder can be listed", files >= 4, note);
    check('which is what finds the ESSound tracks beside it', beside?.state === 'pass', note);
    check('the `.map` beside the ROM can be read', /map=yes/.test(note), note);
    // neither beside the ROM nor in the store: the image the map declares, relative to the project root
    check('and so can the `.elf` that map declares', /elf=yes/.test(note), note);
    check('while a path the shell was never given is still refused',
        rows.get('guard')?.state === 'pass', rows.get('guard')?.note);

    // the check for the feature rather than the shell: the guard can allow everything and the tracks still go unnoticed
    // if the emulator looks in the store instead of beside the ROM
    const essound = rows.get('essound');
    check('the emulator found the ESSound tracks beside the ROM',
        /^2 tracks/.test(essound?.note ?? ''), essound?.note);
    check('while its own files stayed out of the real store',
        (rows.get('storage')?.note ?? '').startsWith(home), rows.get('storage')?.note);
}

// so playing again from the start page plays the file, not the start page's copy: the page's recent list has to carry
// where the ROM was, and the shell has to have written the same path itself, as it takes the page's word for nothing
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const real = await realRomPath();
try {
    const recent = await readJson(path.join(home, '.vueport', 'recent', 'index.json'));
    check('the recent list remembers where the ROM was',
        recent.some(entry => entry.location === real), JSON.stringify(recent[0]));
} catch (error) {
    check('the recent list remembers where the ROM was', false, String(error));
}
try {
    const opened = await readJson(path.join(
        home, 'Library', 'Application Support', 'net.vueport.desktop', 'opened.json'));
    check('and the shell wrote the same path down for the next run',
        opened.includes(real), JSON.stringify(opened));
} catch (error) {
    check('and the shell wrote the same path down for the next run', false, String(error));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
