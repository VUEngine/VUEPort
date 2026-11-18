/**
 * Checks the desktop half of the library without launching Tauri: adding a folder goes through the shell's panel, a
 * read asks for the file list once and only opens what it has to, entries are keyed by CRC32, and playing reads back
 * through the shell by root and relative path, never a path the page made up. The Rust side (it accepts only folders
 * its own panel wrote down) is not covered here; see src-tauri/src/library.rs.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-library-'));
const entry = path.join(scratch, 'entry.ts');
await writeFile(entry, `
export { Library } from ${JSON.stringify(new URL('../src/web-library.ts', import.meta.url).pathname)};
export { DesktopLibrarySource } from ${JSON.stringify(new URL('../src/desktop-library.ts', import.meta.url).pathname)};
export { PlayTimes } from ${JSON.stringify(new URL('../src/web-play-time.ts', import.meta.url).pathname)};
`);
const bundle = path.join(scratch, 'library.mjs');
await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: bundle,
});

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        failures++;
    }
};

class MemoryStorage {
    values = new Map();
    get length() { return this.values.size; }
    key(index) { return [...this.values.keys()][index] ?? null; }
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
    clear() { this.values.clear(); }
}

// a power of two, with a name where the console looks for one
function rom(name, fill) {
    const bytes = new Uint8Array(2048).fill(fill);
    const header = bytes.length - 544;
    for (let i = 0; i < 20; i++) {
        bytes[header + i] = i < name.length ? name.charCodeAt(i) : 0x20;
    }
    return bytes;
}

class MemoryFiles {
    files = new Map();
    async read(path) {
        const found = this.files.get(path);
        if (!found) { throw new Error(`no ${path}`); }
        return found;
    }
    async readText(path) { return new TextDecoder().decode(await this.read(path)); }
    async write(path, data) { this.files.set(path, data); }
    async writeText(path, text) { this.files.set(path, new TextEncoder().encode(text)); }
    async exists(path) { return this.files.has(path); }
    async delete(path) { this.files.delete(path); }
    async list() { return []; }
    parent(path) { return path.slice(0, path.lastIndexOf('/')); }
    stem(path) { return path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, ''); }
    name(path) { return path.slice(path.lastIndexOf('/') + 1); }
    join(directory, name) { return `${directory}/${name}`; }
    async export() { }
}

const localStorage = new MemoryStorage();
// the catalog is a third-party server and this probe is about the shell, so the look-up is off
localStorage.setItem('vueport.library.lookup', 'false');

const shell = {
    folder: { path: '/Users/someone/ROMs/Virtual Boy', name: 'Virtual Boy' },
    files: [
        { path: 'wario.vb', name: 'wario.vb', size: 2048, modified: 1000 },
        { path: 'demos/own-build.vb', name: 'own-build.vb', size: 2048, modified: 2000 },
        { path: 'manual.pdf', name: 'manual.pdf', size: 9, modified: 3000 },
    ],
    bytes: {
        'wario.vb': rom('WARIO LAND', 0x11),
        'demos/own-build.vb': rom('OWN BUILD', 0x22),
    },
};
const calls = [];
globalThis.window = {
    localStorage,
    __TAURI__: {
        core: {
            invoke: async (command, args) => {
                calls.push({ command, args });
                switch (command) {
                    case 'pick_library_folder':
                        return shell.folder;
                    case 'library_folder_ready':
                        return args.root === shell.folder.path;
                    case 'scan_library_folder':
                        // the shell filters by extension, so the page never hears about the manual beside the ROMs
                        return shell.files.filter(file => args.extensions
                            .some(extension => file.name.toLowerCase().endsWith(extension)));
                    case 'read_library_file': {
                        const found = shell.bytes[args.path];
                        if (!found) { throw new Error(`no ${args.path}`); }
                        return found.buffer.slice(found.byteOffset, found.byteOffset + found.byteLength);
                    }
                    case 'forget_library_folder':
                        return undefined;
                    default:
                        return undefined;
                }
            },
        },
    },
};
globalThis.localStorage = localStorage;

const { Library, DesktopLibrarySource, PlayTimes } = await import(pathToFileURL(bundle).href);
// the hours are written by whatever plays a ROM, not covered here; the library only needs somewhere to read them
const files = new MemoryFiles();
const library = new Library(files, new DesktopLibrarySource(), new PlayTimes(files));
await library.load();

console.log('\nAdding a folder');
const folder = await library.addFolder();
check('goes through the shell\'s own panel, not a path the page chose',
    calls.some(call => call.command === 'pick_library_folder'));
check('and the folder keeps the path the panel gave it',
    folder?.location === shell.folder.path && folder?.name === 'Virtual Boy');

console.log('\nReading it');
const listing = calls.find(call => call.command === 'scan_library_folder');
check('asks the shell for the listing once', calls
    .filter(call => call.command === 'scan_library_folder').length === 1);
// archives named in their own right: `.vbz` does not end in `.zip`, and both are read whatever the archive switch
// says. See VB_ARCHIVE_EXTENSIONS
check('and says which extensions are worth hearing about — archives included',
    JSON.stringify(listing?.args.extensions)
        === JSON.stringify(['.vb', '.vbc', '.bin', '.vbz', '.vb.zip', '.zip']));
check('two ROMs came back, the manual did not', library.size === 2);
const games = library.games();
check('each one is named by its file', games.map(game => game.title).join(', ')
    === 'own-build, wario');
check('and identified by the CRC32 of its bytes',
    games.every(game => /^[0-9a-f]{8}$/.test(game.id)) && games[0].id !== games[1].id);
check('the cartridge header is read out of the ROM',
    games.map(game => game.preferred.entry.header.name).sort().join(', ') === 'OWN BUILD, WARIO LAND');
check('and the file is remembered where the shell said it was',
    games.some(game => game.preferred.entry.files[0].path === 'demos/own-build.vb'));

console.log('\nReading it again');
const before = calls.filter(call => call.command === 'read_library_file').length;
await library.readFolder(folder.id);
const after = calls.filter(call => call.command === 'read_library_file').length;
check('opens nothing that has not changed since', after === before);
shell.files[0] = { ...shell.files[0], modified: 4000 };
await library.readFolder(folder.id);
check('and opens the one that has',
    calls.filter(call => call.command === 'read_library_file').length === after + 1);

console.log('\nPlaying one');
const wario = library.games().find(game => game.title === 'wario');
const played = await library.read(wario.id);
const request = calls.filter(call => call.command === 'read_library_file').pop();
check('reads it back through the shell by root and relative path',
    request.args.root === shell.folder.path && request.args.path === 'wario.vb');
check('and hands over the bytes that are on disk', played.data.byteLength === 2048);

console.log('\nDropping the folder');
await library.removeFolder(folder.id);
check('tells the shell to forget it', calls.some(call => call.command === 'forget_library_folder'));
check('and the library is empty again', library.size === 0);

process.exit(failures === 0 ? 0 : 1);
