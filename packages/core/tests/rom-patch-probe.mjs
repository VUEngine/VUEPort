// every supported patch format against the same tiny source/target pair. UPS and BPS are built here so their
// checksums are tested; BSDiff is a fixed patch from bsdiff-compatible control/diff/extra streams in bzip2
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    applyRomPatch,
    applyRomPatches,
    createBpsPatch,
    detectRomPatchFormat,
} = require('../lib/common/emulator-rom-patches.js');
const { crc32 } = require('../lib/common/emulator-cheat-database.js');
const { PatchStore } = require('../lib/browser/emulator-patch-store.js');
const { browserStateKey } = require('../lib/browser/emulator-browser-state.js');
const { builtInPatchesFor, PATCH_DATABASE } = require('../lib/common/emulator-patch-database.js');
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let failures = 0;
function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function variable(value) {
    const bytes = [];
    while (true) {
        const next = value & 0x7f;
        value = Math.floor(value / 0x80);
        if (value === 0) {
            bytes.push(next | 0x80);
            return bytes;
        }
        bytes.push(next);
        value--;
    }
}

function u32(value) {
    return [value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
}

function withChecksums(body, source, target) {
    const beforePatchCrc = Uint8Array.from([
        ...body,
        ...u32(crc32(source)),
        ...u32(crc32(target)),
    ]);
    return Uint8Array.from([...beforePatchCrc, ...u32(crc32(beforePatchCrc))]);
}

const source = Uint8Array.from([1, 2, 3, 4]);
const target = [1, 9, 3, 4, 5];

console.log('\nROM patch formats');

const ips = Uint8Array.from([
    ...Buffer.from('PATCH'),
    0, 0, 1, 0, 1, 9,
    0, 0, 4, 0, 1, 5,
    ...Buffer.from('EOF'),
]);
check('IPS signature', detectRomPatchFormat(ips), 'ips');
check('IPS patch', [...applyRomPatch(source, ips)], target);

const upsBody = [
    ...Buffer.from('UPS1'),
    ...variable(source.length),
    ...variable(target.length),
    ...variable(1), 2 ^ 9, 0,
    ...variable(1), 5, 0,
];
const ups = withChecksums(upsBody, source, Uint8Array.from(target));
check('UPS signature', detectRomPatchFormat(ups), 'ups');
check('UPS patch', [...applyRomPatch(source, ups)], target);

const bpsBody = [
    ...Buffer.from('BPS1'),
    ...variable(source.length),
    ...variable(target.length),
    ...variable(0),
    ...variable(((target.length - 1) << 2) | 1),
    ...target,
];
const bps = withChecksums(bpsBody, source, Uint8Array.from(target));
check('BPS signature', detectRomPatchFormat(bps), 'bps');
check('BPS patch', [...applyRomPatch(source, bps)], target);

const bsdiff = Buffer.from(
    'QlNESUZGNDApAAAAAAAAACUAAAAAAAAABQAAAAAAAABCWmg5MUFZJlNZdZtXgAAABUAAbAggACGGgZoC1MmnF3JFOFCQdZtXgEJaaDkxQVkmU1k98GURAAABQABAgCAAIQCCnF3JFOFCQPfBlERCWmg5MUFZJlNZpjIrIAAAAEAAAgAgACEYRoLuSKcKEhTGRWQA',
    'base64',
);
check('BSDiff signature', detectRomPatchFormat(bsdiff), 'bsdiff');
check('BSDiff patch', [...applyRomPatch(source, bsdiff)], target);

const wrongSource = Uint8Array.from([1, 2, 3, 5]);
let rejected = false;
try {
    applyRomPatch(wrongSource, bps);
} catch {
    rejected = true;
}
check('source checksum rejects another ROM', rejected, true);

console.log('\nShipped patch database');
const shipped = builtInPatchesFor('44c2b723');
check('Space Pinball patches are registered', shipped.map(patch => patch.file),
    ['patches/space-pinball/vb-color.bps', 'patches/space-pinball/score-reset.ips']);
const scoreReset = shipped.find(patch => patch.id === 'space-pinball/score-reset');
check('Space Pinball metadata', {
    author: scoreReset?.author,
    type: scoreReset?.type,
}, {
    author: 'HorvatM',
    type: 'hack',
});

// every shipped patch file exists, is the format it says, and no ROM is offered the same patch twice. The bytes
// were checked against the ROMs when added, as a test cannot ship ROMs
{
    const dataDir = fileURLToPath(new URL('../../../data/', import.meta.url));
    const ids = new Set();
    const problems = [];
    for (const entry of PATCH_DATABASE) {
        if (!Array.isArray(entry.crc32) || entry.crc32.length === 0) {
            problems.push(`${entry.game}: no CRC32 listed`);
        }
        for (const crc of entry.crc32 ?? []) {
            if (!/^[0-9a-f]{8}$/.test(crc)) {
                problems.push(`${entry.game}: CRC32 ${crc}`);
            }
        }
        if (new Set(entry.crc32).size !== entry.crc32.length) {
            problems.push(`${entry.game}: a CRC32 listed twice`);
        }
        for (const patch of entry.patches) {
            if (ids.has(patch.id)) {
                problems.push(`${patch.id}: id used twice`);
            }
            ids.add(patch.id);
            if ('data' in patch || typeof patch.file !== 'string') {
                problems.push(`${patch.id}: needs a file, and no inline data`);
                continue;
            }
            const path = dataDir + patch.file;
            if (!existsSync(path)) {
                problems.push(`${patch.id}: ${patch.file} is missing`);
                continue;
            }
            const format = detectRomPatchFormat(new Uint8Array(readFileSync(path)));
            if (format !== patch.format) {
                problems.push(`${patch.id}: ${patch.file} is ${format}, listed as ${patch.format}`);
            }
        }
    }
    check('every shipped patch file is present, well-formed and listed once', problems, []);
}

// a patch for several ROMs is listed once and offered to each; a ROM in several entries gets all their patches
{
    const patch = id => ({ id, name: id, fileName: `${id}.ips`, format: 'ips', type: 'hack',
        author: 'A', description: 'D', file: `patches/${id}.ips` });
    const database = [
        { game: 'Both', crc32: ['0000000a', '0000000b'], patches: [patch('shared')] },
        { game: 'Only A', crc32: ['0000000a'], patches: [patch('only-a')] },
    ];
    check('a ROM gets the shared patch and its own, in database order',
        builtInPatchesFor('0000000A', database).map(entry => entry.id), ['shared', 'only-a']);
    check('the other ROM gets only the shared one',
        builtInPatchesFor('0000000b', database).map(entry => entry.id), ['shared']);
    check('a ROM listed nowhere gets none', builtInPatchesFor('0000000c', database), []);
    check('Red Alarm\'s save patch reaches both regions',
        ['aa10a7b4', '7e85c45d'].map(crc =>
            builtInPatchesFor(crc).some(entry => entry.id === 'red-alarm/save-support')),
        [true, true]);
}

console.log('\nPatch store');
class MemoryStorage {
    files = new Map();
    parent(path) { return path.slice(0, path.lastIndexOf('/')) || '/'; }
    stem(path) { return this.name(path).replace(/\.[^.]*$/, ''); }
    name(path) { return path.slice(path.lastIndexOf('/') + 1); }
    join(parent, child) { return `${parent.replace(/\/$/, '')}/${child}`; }
    async exists(path) { return this.files.has(path); }
    async readText(path) { return this.files.get(path); }
    async writeText(path, data) { this.files.set(path, data); }
    async delete(path) { this.files.delete(path); }
}
class MemoryBrowserStorage {
    values = new Map();
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, value); }
    removeItem(key) { this.values.delete(key); }
}

console.log('\nPatch store: shipped patch files');
{
    const database = [{
        game: 'Probe',
        crc32: ['00000001'],
        patches: [
            { id: 'probe/file', name: 'File', fileName: 'file.ips', format: 'ips', type: 'hack',
                author: 'A', description: 'D', file: 'patches/probe/file.ips' },
            { id: 'probe/broken', name: 'Broken', fileName: 'broken.ips', format: 'ips', type: 'hack',
                author: 'A', description: 'D', file: 'patches/probe/broken.ips' },
        ],
    }];
    const fileBytes = Uint8Array.from([...Buffer.from('PATCH'), 0, 0, 2, 0, 1, 8, ...Buffer.from('EOF')]);
    const asked = [];
    const loadFile = async file => {
        asked.push(file);
        if (file.endsWith('broken.ips')) {
            throw new Error('404');
        }
        return fileBytes;
    };
    const warn = console.warn;
    console.warn = () => undefined;
    const withLoader = new PatchStore(new MemoryStorage(), database, new MemoryBrowserStorage(), loadFile);
    await withLoader.load('/roms/files.vb', '00000001', source);
    console.warn = warn;
    check('a file is read through the host, and one that fails is left out',
        withLoader.list.map(patch => patch.id), ['probe/file']);
    check('the host is asked by the path the database gives', asked,
        ['patches/probe/file.ips', 'patches/probe/broken.ips']);
    check('the file\'s bytes are what is applied', [...withLoader.list[0].data], [...fileBytes]);
    check('the file field is not carried onto the patch', 'file' in withLoader.list[0], false);
    const withoutLoader = new PatchStore(new MemoryStorage(), database, new MemoryBrowserStorage());
    await withoutLoader.load('/roms/files.vb', '00000001', source);
    check('without a loader no shipped patch is offered', withoutLoader.list.length, 0);
}

console.log('\nPatch store: shipped patches on by default');
{
    const fileBytes = Uint8Array.from([...Buffer.from('PATCH'), 0, 0, 2, 0, 1, 8, ...Buffer.from('EOF')]);
    const database = [{
        game: 'Probe',
        crc32: ['00000002'],
        patches: [
            { id: 'probe/fix', name: 'Fix', fileName: 'fix.ips', format: 'ips', type: 'compatibility',
                author: 'A', description: 'D', file: 'patches/probe/fix.ips', enabledByDefault: true },
            { id: 'probe/hack', name: 'Hack', fileName: 'hack.ips', format: 'ips', type: 'hack',
                author: 'A', description: 'D', file: 'patches/probe/hack.ips' },
        ],
    }];
    const browser = new MemoryBrowserStorage();
    const open = async () => {
        const store = new PatchStore(new MemoryStorage(), database, browser, async () => fileBytes);
        await store.load('/roms/fix.vb', '00000002', source);
        return store;
    };
    const fresh = await open();
    check('a default patch is on the first time, the other off',
        fresh.list.map(patch => patch.enabled), [true, false]);
    check('and the ROM is patched', [...fresh.apply(source)], [1, 2, 8, 4]);
    fresh.setEnabled(0, false);
    check('switched off, it stays off the next time', (await open()).list.map(patch => patch.enabled), [false, false]);
    const again = await open();
    again.setEnabled(0, true);
    check('switched on again, it is on the next time', (await open()).list.map(patch => patch.enabled), [true, false]);
    check('the compatibility fixes come on by default',
        ['a3022d2a', '42e17e38', 'f3f9e810'].map(crc =>
            builtInPatchesFor(crc).map(patch => [patch.type, patch.enabledByDefault])),
        [[['compatibility', true]], [['compatibility', true]], [['compatibility', true]]]);
}

console.log('\nPatch store: imported patches');
const storage = new MemoryStorage();
const browser = new MemoryBrowserStorage();
const first = new PatchStore(storage, [], browser);
await first.load('/roms/probe.vb', undefined, source);
const storeIps = Uint8Array.from([
    ...Buffer.from('PATCH'),
    0, 0, 1, 0, 1, 9,
    ...Buffer.from('EOF'),
]);
const imported = first.importPatch('change.ips', storeIps);
check('imports disabled', first.list[imported].enabled, false);
first.updateMetadata(imported, {
    name: 'Translated change',
    description: 'Fixture description',
    author: 'Test Author',
    type: 'translation',
});
let restarted = false;
first.onDidChange(change => { restarted ||= change.affectsRom; });
first.setEnabled(imported, true);
check('enabled result is patched', [...first.apply(source)], [1, 9, 3, 4]);
check('enabling requests a restart', restarted, true);
await first.whenSaved();

const definition = JSON.parse(storage.files.get('/roms/probe.vueport-patches.json'));
check('the companion file contains no top-level switch state', 'enabled' in definition, false);
check('the imported definition contains no switch state', 'enabled' in definition.patches[0], false);
check('the switch is kept in browser state',
    JSON.parse(browser.values.get(browserStateKey('patches', '/roms/probe.vb'))).enabled,
    [first.list[imported].id]);

const restored = new PatchStore(storage, [], browser);
await restored.load('/roms/probe.vb', undefined, source);
check('import and enabled state persist', {
    count: restored.list.length,
    enabled: restored.list[0]?.enabled,
    fileName: restored.list[0]?.fileName,
    name: restored.list[0]?.name,
    description: restored.list[0]?.description,
    author: restored.list[0]?.author,
    type: restored.list[0]?.type,
}, {
    count: 1,
    enabled: true,
    fileName: 'change.ips',
    name: 'Translated change',
    description: 'Fixture description',
    author: 'Test Author',
    type: 'translation',
});

// locked while a link session runs, as the running ROM must not change under it
{
    const locked = new PatchStore(new MemoryStorage(), [], new MemoryBrowserStorage());
    await locked.load('/roms/locked.vb', undefined, source);
    const at = locked.importPatch('change.ips', storeIps);
    locked.setLocked('Patches are fixed while linked.');
    let refusal = '';
    try {
        locked.setEnabled(at, true);
    } catch (error) {
        refusal = error.message;
    }
    check('a locked store refuses to switch a patch on, saying why',
        [refusal, locked.list[at].enabled], ['Patches are fixed while linked.', false]);
    locked.setLocked(undefined);
    locked.setEnabled(at, true);
    check('unlocked, it switches again', locked.list[at].enabled, true);
}

// a colorization (BPS against the original, doubling the cartridge) with an ordinary IPS against the original;
// neither may refuse the other's source
{
    const original = Uint8Array.from({ length: 16 }, (_, at) => at);
    const colored = new Uint8Array(32);
    colored.set(original, 0);
    colored.set(original, 16);
    colored[2] = 0xc0; // a hook in the lower half
    colored[20] = 0xc1; // and in the mirror
    const color = createBpsPatch(original, colored);
    const translation = Uint8Array.from([
        ...Buffer.from('PATCH'),
        0, 0, 8, 0, 2, 0xaa, 0xbb, // bytes 8-9
        0, 0, 2, 0, 1, 0xee, // byte 2, which the colorization also changes
        ...Buffer.from('EOF'),
    ]);
    const chain = [
        { name: 'color', fileName: 'c.bps', format: 'bps', data: color, enabled: true, type: 'vb-color' },
        { name: 'tr', fileName: 't.ips', format: 'ips', data: translation, enabled: true, type: 'translation' },
    ];
    const result = applyRomPatches(original, chain);
    check('a colorization and an ordinary patch combine', result.length, 32);
    check('the ordinary patch\'s bytes land in the original at the top', [result[24], result[25]], [0xaa, 0xbb]);
    check('below, the block with the colorization\'s hook stays its own', [result[8], result[9]], [8, 9]);
    check('the colorization\'s own changes stay', [result[2], result[20]], [0xc0, 0xc1]);
    check('untouched bytes are the original\'s', [result[5], result[21]], [5, 5]);
    check('alone, the colorization is exactly its target',
        [...applyRomPatches(original, [chain[0]])], [...colored]);
    const shrinks = createBpsPatch(original, original.slice(0, 8));
    let refused = false;
    try {
        applyRomPatches(original, [chain[0], { ...chain[1], format: 'bps', data: shrinks }]);
    } catch (error) {
        refused = /shrinks the ROM/.test(error.message);
    }
    check('a patch that shrinks the ROM is refused with a reason', refused, true);
}

// the other patches write into a colorization's added space only into blocks it kept as a copy of the original,
// never where a byte merely equals the original's
{
    const original = Uint8Array.from({ length: 64 }, (_, at) => at < 32 ? at + 1 : 0); // ends in free zeros
    const colored = new Uint8Array(128);
    colored.set(original, 0); // a mirrored copy below ...
    colored.set(original, 64); // ... and the original at the top
    colored[2] = 0xc0; // a hook in the copy (block 0)
    colored.set([0x12, 0, 0, 0x34, 0, 0, 0, 0x56], 32); // its own data over free zeros (block 2)
    colored[64 + 4] = 0xc1; // a hook in the original
    const color = createBpsPatch(original, colored);
    const translation = Uint8Array.from([
        ...Buffer.from('PATCH'),
        0, 0, 5, 0, 1, 0xa5, // byte 5, next to the hook in the original
        0, 0, 20, 0, 2, 0xaa, 0xbb, // bytes 20-21, in a block the copy keeps whole
        0, 0, 34, 0, 1, 0xee, // byte 34, in the free zeros the colorization put its data over
        0, 0, 48, 0, 1, 0xdd, // byte 48, in free zeros the colorization left alone
        ...Buffer.from('EOF'),
    ]);
    const result = applyRomPatches(original, [
        { name: 'color', fileName: 'c.bps', format: 'bps', data: color, enabled: true, type: 'vb-color' },
        { name: 'tr', fileName: 't.ips', format: 'ips', data: translation, enabled: true, type: 'translation' },
    ]);
    check('at the top, the other patch lands byte by byte next to the colorization\'s hook',
        [result[64 + 4], result[64 + 5], result[64 + 20], result[64 + 34], result[64 + 48]], [0xc1, 0xa5, 0xaa, 0xee, 0xdd]);
    check('below, it lands in blocks the colorization kept as a copy', [result[20], result[21]], [0xaa, 0xbb]);
    // a short run of one byte value beside the colorization's data (zeros) is taken for its own data, not a copy
    check('below, a short run of zeros beside its data stays the colorization\'s', result[48], 0);
    check('below, a block the colorization changed is its own', [result[2], result[5], result[34]], [0xc0, 6, 0]);
}

// a translation needing more room grows the cartridge too, below the colorization's space; all are aligned at
// the top
{
    const original = Uint8Array.from({ length: 64 }, (_, at) => at + 1);
    const colored = new Uint8Array(128);
    colored.set(original, 64);
    colored[64 + 4] = 0xc1; // a hook in the original
    colored.set([0x12, 0x34], 16); // its own code below
    const color = createBpsPatch(original, colored);
    const translated = new Uint8Array(256); // four times: its own space below the colorization's
    translated.set(original, 192);
    translated[192 + 9] = 0xa9; // a hook in the original
    translated.set([0x77, 0x88], 8); // its own data, far below
    const grown = createBpsPatch(original, translated);
    const result = applyRomPatches(original, [
        { name: 'color', fileName: 'c.bps', format: 'bps', data: color, enabled: true, type: 'vb-color' },
        { name: 'tr', fileName: 't.bps', format: 'bps', data: grown, enabled: true, type: 'translation' },
    ]);
    check('a grown translation and a colorization combine to the larger size', result.length, 256);
    check('both hooks are in the original at the top', [result[192 + 4], result[192 + 9], result[192 + 10]], [0xc1, 0xa9, 11]);
    check('the colorization\'s space is its own', [result[128 + 16], result[128 + 17]], [0x12, 0x34]);
    check('the translation\'s space below it is its own', [result[8], result[9]], [0x77, 0x88]);
    const clash = translated.slice();
    clash.set([0x99], 128 + 16); // into the space the colorization adds
    let refused = false;
    try {
        applyRomPatches(original, [
            { name: 'color', fileName: 'c.bps', format: 'bps', data: color, enabled: true, type: 'vb-color' },
            { name: 'tr', fileName: 't.bps', format: 'bps', data: createBpsPatch(original, clash), enabled: true, type: 'translation' },
        ]);
    } catch (error) {
        refused = /space the color patch adds/.test(error.message);
    }
    check('a translation with bytes of its own in the colorization\'s space is refused', refused, true);
    // a translation that grows the ROM to the colorization's size and pads its lower half with 0xFF (SD Gundam's
    // English IPS): the padding is no own byte, the colorization keeps its space
    const padded = new Uint8Array(128).fill(0xff);
    padded.set(original, 64);
    padded[64 + 9] = 0xa9;
    const result2 = applyRomPatches(original, [
        { name: 'color', fileName: 'c.bps', format: 'bps', data: color, enabled: true, type: 'vb-color' },
        { name: 'tr', fileName: 't.bps', format: 'bps', data: createBpsPatch(original, padded), enabled: true, type: 'translation' },
    ]);
    check('a translation padded with 0xFF combines', [result2.length, result2[64 + 4], result2[64 + 9]], [128, 0xc1, 0xa9]);
    check('the colorization keeps its space over the padding', [result2[16], result2[17], result2[0]], [0x12, 0x34, 0]);
}

// a colorization and a translation that both keep the original at the bottom (the game's code where it ran) and
// grow the cartridge upwards, to the header and vectors at its end (Insmouse, Virtual Fishing): the translation's
// bytes land in the original, the colorization's space above stays its own, the header takes both
{
    const original = Uint8Array.from({ length: 0x400 }, (_, at) => (at * 7 + 1) & 0xff);
    const header = 0x400 - 0x220;
    const colored = new Uint8Array(0x800);
    colored.set(original, 0);
    colored[4] = 0xc0; // a hook in the original
    colored.set(original.slice(0x400 - 0x240), 0x800 - 0x240); // the header and vectors copied to the end
    colored.set([0x12, 0x34, 0x56], 0x400 + 0x20); // its own data above
    colored[0x800 - 0x220 + 0x14] = 0x80; // the VB Color flag in the header
    colored[0x800 - 0x10] = 0xc2; // its own reset vector
    const color = createBpsPatch(original, colored);
    const translated = new Uint8Array(0x800).fill(0xff);
    translated.set(original, 0);
    translated.set([0xaa, 0xbb], 10); // its text in the original
    translated.set(original.slice(0x400 - 0x240), 0x800 - 0x240);
    translated[0x800 - 0x220 + 0x11] = 0x55; // its region in the title, a byte the colorization left alone
    const chain = [
        { name: 'color', fileName: 'c.bps', format: 'bps', data: color, enabled: true, type: 'vb-color' },
        { name: 'tr', fileName: 't.bps', format: 'bps', data: createBpsPatch(original, translated), enabled: true, type: 'translation' },
    ];
    const result = applyRomPatches(original, chain);
    check('both kept the original at the bottom: they combine', result.length, 0x800);
    check('the hook and the translation\'s bytes are in the original at the bottom', [result[4], result[10], result[11], result[12]],
        [0xc0, 0xaa, 0xbb, original[12]]);
    check('the colorization\'s data and vector above are its own', [result[0x420], result[0x421], result[0x422], result[0x800 - 0x10]],
        [0x12, 0x34, 0x56, 0xc2]);
    check('the header takes the translation\'s title and the colorization\'s flag',
        [result[0x800 - 0x220 + 0x11], result[0x800 - 0x220 + 0x14], result[0x800 - 0x220]], [0x55, 0x80, original[header]]);
    // a translation that keeps the original at the top cannot be laid over one at the bottom
    const top = new Uint8Array(0x800);
    top.set(original, 0x400);
    top[0x400 + 10] = 0xaa;
    let refused = false;
    try {
        applyRomPatches(original, [chain[0], { ...chain[1], data: createBpsPatch(original, top) }]);
    } catch (error) {
        refused = /other end of the ROM/.test(error.message);
    }
    check('images at different ends are refused with a reason', refused, true);
    // a translation with its own data (zeros among it) where the colorization kept a copy of the original (Space
    // Squash v0.4 keeps 16 KiB for the English patch): the run of copy blocks is the translation's, exactly
    const keep = colored.slice();
    const data = Uint8Array.from([0x41, 0, 0, 0x42, 0xff, 0, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x44]);
    const kept = new Uint8Array(0x800).fill(0xff);
    kept.set(original, 0);
    kept.set(original.slice(0x400 - 0x240), 0x800 - 0x240);
    kept.set(data, 0x400 + 0x100); // in the copy blocks the colorization keeps (its own data is at 0x420..0x422)
    keep.set(original.slice(0x100, 0x100 + 0x40), 0x400 + 0x100); // the colorization's copy there
    const combined = applyRomPatches(original, [
        { ...chain[0], data: createBpsPatch(original, keep) },
        { ...chain[1], data: createBpsPatch(original, kept) },
    ]);
    check('the translation\'s data in the colorization\'s copy blocks is exactly its own, zeros too',
        [...combined.slice(0x500, 0x500 + data.length)], [...data]);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
