/**
 * Checks imported folders (copied in rather than read in place): the copy takes the ROMs and leaves the box scans,
 * entries are keyed and filed like a folder read from disk, the bytes are in this origin's storage and go away when the
 * folder is dropped, re-importing catches up with a grown collection, and a copy running out of room keeps nothing. The
 * native picker is stood in for with files carrying `webkitRelativePath`, which is all Firefox and Safari give.
 *
 * Usage: node tests/library-import-probe.mjs
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-import-'));
const entry = path.join(scratch, 'entry.ts');
await writeFile(entry, `
export { Library } from ${JSON.stringify(new URL('../src/web-library.ts', import.meta.url).pathname)};
export { ImportedLibrarySource } from ${JSON.stringify(new URL('../src/web-library-imported-source.ts', import.meta.url).pathname)};
export { BrowserLibrarySource } from ${JSON.stringify(new URL('../src/web-library-browser-source.ts', import.meta.url).pathname)};
export { PlayTimes } from ${JSON.stringify(new URL('../src/web-play-time.ts', import.meta.url).pathname)};
`);
const bundle = path.join(scratch, 'import.mjs');
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

// the origin-private file system in memory. `list` matters here: clearImport sweeps a folder's copies by listing the
// directory rather than trusting the index
class MemoryFiles {
    files = new Map();
    async read(p) {
        const found = this.files.get(p);
        if (!found) { throw new Error(`no ${p}`); }
        return found;
    }
    async readText(p) { return new TextDecoder().decode(await this.read(p)); }
    async write(p, data) { this.files.set(p, data); }
    async writeText(p, text) { this.files.set(p, new TextEncoder().encode(text)); }
    async exists(p) { return this.files.has(p); }
    async delete(p) { this.files.delete(p); }
    async list(directory) {
        const prefix = `${directory}/`;
        return [...this.files.entries()]
            .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
            .map(([p, data]) => ({ path: p, name: p.slice(prefix.length), size: data.byteLength }));
    }
    parent(p) { return p.slice(0, p.lastIndexOf('/')); }
    stem(p) { return p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]*$/, ''); }
    name(p) { return p.slice(p.lastIndexOf('/') + 1); }
    join(directory, name) { return `${directory}/${name}`; }
    async export() { }
}

function chosenFile(relativePath, bytes, modifiedAt) {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return {
        name,
        size: bytes.byteLength,
        lastModified: modifiedAt,
        webkitRelativePath: relativePath,
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
}

const WARIO = rom('WARIO LAND', 0x11);
const DEMO = rom('OWN BUILD', 0x22);
const LATER = rom('LATE ARRIVAL', 0x33);

const picker = {
    files: [
        chosenFile('Virtual Boy/wario.vb', WARIO, 1000),
        chosenFile('Virtual Boy/demos/own-build.vb', DEMO, 2000),
        chosenFile('Virtual Boy/manual.pdf', new Uint8Array(9), 3000),
        chosenFile('Virtual Boy/box.jpg', new Uint8Array(4096), 3000),
        chosenFile('Virtual Boy/.DS_Store', new Uint8Array(64), 3000),
        chosenFile('Virtual Boy/.git/config', new Uint8Array(64), 3000),
    ],
    opened: 0,
};

const localStorage = new MemoryStorage();
// the catalog is a third-party server and this probe is about the copy
localStorage.setItem('vueport.library.lookup', 'false');

function fakeInput() {
    const handlers = {};
    return {
        type: '', multiple: false, files: [], style: {},
        setAttribute() { },
        addEventListener(name, handler) { handlers[name] = handler; },
        remove() { },
        click() {
            picker.opened += 1;
            this.files = picker.files;
            handlers.change?.();
        },
    };
}

const persistence = { asked: 0, granted: false };
globalThis.window = {
    localStorage,
    indexedDB: undefined,
};
globalThis.localStorage = localStorage;
globalThis.HTMLInputElement = { prototype: { webkitdirectory: '' } };
globalThis.document = {
    createElement: () => fakeInput(),
    body: { append() { } },
};
// Node's own `navigator` is a getter-only global, so the storage manager is defined on it rather than over it
Object.defineProperty(globalThis.navigator, 'storage', {
    configurable: true,
    value: {
        async persisted() { return persistence.granted; },
        async persist() { persistence.asked += 1; persistence.granted = true; return true; },
    },
});

const { Library, ImportedLibrarySource, BrowserLibrarySource, PlayTimes }
    = await import(pathToFileURL(bundle).href);

const files = new MemoryFiles();
const library = new Library(files, new BrowserLibrarySource(), new PlayTimes(files),
    new ImportedLibrarySource(files));
await library.load();

const copies = () => [...files.files.keys()].filter(p => p.startsWith('library/imported/'));

console.log('\nImporting a folder');
const folder = await library.addFolder('imported');
check('the picker was opened once', picker.opened === 1);
check('the folder is named after the directory that was chosen', folder?.name === 'Virtual Boy');
check('and is marked as a copy rather than a link', folder?.kind === 'imported');
check('two ROMs came in; the manual, the box scan and the dot-files did not',
    library.size === 2);
check('the ROMs are keyed by the CRC32 of their bytes',
    library.games().every(game => /^[0-9a-f]{8}$/.test(game.id)));
check('the cartridge header is read out of the copy, not guessed from the name',
    library.games().map(game => game.preferred.entry.header.name).sort().join(', ')
        === 'OWN BUILD, WARIO LAND');
check('a ROM in a subfolder keeps the path it had inside the folder',
    library.games().some(game => game.preferred.entry.files[0].path === 'demos/own-build.vb'));
check('the bytes really are in this origin\'s storage', copies()
    .filter(p => !p.endsWith('index.json')).length === 2);
check('and the browser was asked to keep them', persistence.asked === 1);

console.log('\nReading the copy again');
const before = copies().length;
await library.readFolder(folder.id);
check('finds the same two ROMs', library.size === 2);
check('and writes nothing new to storage', copies().length === before);

console.log('\nPlaying one from the copy');
const wario = library.games().find(game => game.preferred.entry.header.name.startsWith('WARIO'));
const played = await library.read(wario.id);
check('the bytes come back out of the copy', played.data.byteLength === 2048 && played.data[0] === 0x11);
check('under the name the file had on disk', played.name === 'wario.vb');

console.log('\nTurning subfolders off');
localStorage.setItem('vueport.library.subfolders', 'false');
await library.readFolder(folder.id);
check('the ROM in the subfolder leaves the library', library.size === 1);
check('but its bytes are still in the copy — the switch is about reading, not keeping',
    copies().filter(p => !p.endsWith('index.json')).length === 2);
localStorage.setItem('vueport.library.subfolders', 'true');
await library.readFolder(folder.id);
check('and comes back when it is turned on again', library.size === 2);

console.log('\nImporting the same folder again, grown by one');
const keptId = wario.preferred.entry.id;
picker.files = [
    chosenFile('Virtual Boy/wario.vb', WARIO, 1000),
    chosenFile('Virtual Boy/demos/own-build.vb', DEMO, 2000),
    chosenFile('Virtual Boy/late.vb', LATER, 4000),
];
const reimported = await library.reimportFolder(folder.id);
check('the picker was opened again', reimported === true && picker.opened === 2);
check('the ROM that was added is now in the library', library.size === 3);
check('the one that was already there kept its identity', library.games()
    .some(game => game.preferred.entry.id === keptId));
check('and nothing was copied twice', copies()
    .filter(p => !p.endsWith('index.json')).length === 3);

console.log('\nImporting the same folder again, shrunk by two');
picker.files = [chosenFile('Virtual Boy/late.vb', LATER, 4000)];
await library.reimportFolder(folder.id);
check('the ROMs that went are out of the library', library.size === 1);
check('and their bytes are out of storage too', copies()
    .filter(p => !p.endsWith('index.json')).length === 1);

console.log('\nRunning out of room');
picker.files = [chosenFile('Virtual Boy/wario.vb', WARIO, 1000)];
const write = files.write.bind(files);
files.write = async (p, data) => {
    if (p.startsWith('library/imported/')) {
        throw new DOMException('quota', 'QuotaExceededError');
    }
    return write(p, data);
};
const kept = library.size;
let reported;
try {
    await library.addFolder('imported');
} catch (error) {
    reported = error;
}
files.write = write;
check('the failure is reported rather than swallowed', reported?.name === 'ImportError');
check('and says what the person can do something about', reported?.outOfSpace === true);
check('the half-made folder is not left on the shelf', library.folderStates().length === 1);
check('and the library it could not join is untouched', library.size === kept);

console.log('\nA re-import that runs out of room');
picker.files = [chosenFile('Virtual Boy/late.vb', LATER, 4000)];
files.write = async (p, data) => {
    if (p.startsWith('library/imported/')) {
        throw new DOMException('quota', 'QuotaExceededError');
    }
    return write(p, data);
};
let reimportFailure;
try {
    await library.reimportFolder(folder.id);
} catch (error) {
    reimportFailure = error;
}
files.write = write;
check('the failure is reported', reimportFailure?.name === 'ImportError');
// a re-import sweeps before it writes, so a failed one leaves a folder with no bytes behind it; say so
check('the folder is emptied rather than left pointing at bytes that are gone',
    library.size === 0);
check('and it says the copy is gone',
    library.folderStates()[0].access === 'missing');

console.log('\nDropping the folder');
await library.removeFolder(folder.id);
check('the folder is off the shelf', library.folderStates().length === 0);
check('and every copied byte is gone with it', copies().length === 0);

process.exit(failures === 0 ? 0 : 1);
