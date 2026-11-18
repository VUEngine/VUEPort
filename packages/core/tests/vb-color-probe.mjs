/**
 * Checks the VB Color colorization path: every bundled BPS matches its patch database entry, the BPS encoder reproduces
 * its ROMs, and the patch store lists colorizations with the other shipped patches, switches them as alternatives and
 * takes whether one is on from the colorization settings. No game ROM is needed; point VBC_ROM_DIR at a directory of
 * ROMs to also apply every bundled patch to its real game.
 * Usage: node tests/vb-color-probe.mjs
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ext = '../';

const { PATCH_DATABASE, builtInPatchesFor } = require(ext + 'lib/common/emulator-patch-database.js');
const {
    applyRomPatch,
    createBpsPatch,
    detectRomPatchFormat,
} = require(ext + 'lib/common/emulator-rom-patches.js');
const {
    VBC_COLOR_FRAMEBUFFER_BASE,
    VBC_COLOR_FRAMEBUFFER_BYTES,
    VBC_CRAM_BASE,
    isVbcColorFramebuffer,
} = require(ext + 'lib/common/vb-constants.js');
const { crc32 } = require(ext + 'lib/common/emulator-cheat-database.js');
const { PatchStore } = require(ext + 'lib/browser/emulator-patch-store.js');

let failures = 0;

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const hex8 = value => value.toString(16).padStart(8, '0');

function syntheticRom(size) {
    const rom = new Uint8Array(size);
    for (let at = 0; at < size; at += 1) {
        rom[at] = (at * 31 + (at >> 8)) & 0xff;
    }
    return rom;
}

// the whole target as one TargetRead, written independently of createBpsPatch so neither is only checked against itself
function plainBps(source, target) {
    const out = [0x42, 0x50, 0x53, 0x31];
    const number = value => {
        for (; ;) {
            const low = value % 128;
            value = Math.floor(value / 128);
            if (value === 0) {
                out.push(low | 0x80);
                return;
            }
            out.push(low);
            value -= 1;
        }
    };
    const u32 = value => out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    number(source.length);
    number(target.length);
    number(0);
    number((target.length - 1) * 4 + 1);
    for (const byte of target) out.push(byte);
    u32(crc32(source));
    u32(crc32(target));
    u32(crc32(Uint8Array.from(out)));
    return Uint8Array.from(out);
}

function bpsFooter(patch) {
    const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
    return {
        source: hex8(view.getUint32(patch.length - 12, true)),
        target: hex8(view.getUint32(patch.length - 8, true)),
        patch: hex8(view.getUint32(patch.length - 4, true)),
    };
}

section('Where a palette id can be read at all');
{
    check('the framebuffer is four pages of one byte per pixel', VBC_COLOR_FRAMEBUFFER_BYTES, 4 * 384 * 256);
    check('its first byte is in range', isVbcColorFramebuffer(VBC_COLOR_FRAMEBUFFER_BASE), true);
    check('its last byte is in range',
        isVbcColorFramebuffer(VBC_COLOR_FRAMEBUFFER_BASE + VBC_COLOR_FRAMEBUFFER_BYTES - 1), true);
    check('the byte after it is not',
        isVbcColorFramebuffer(VBC_COLOR_FRAMEBUFFER_BASE + VBC_COLOR_FRAMEBUFFER_BYTES), false);
    check('Color RAM is outside it', isVbcColorFramebuffer(VBC_CRAM_BASE), false);
    check('a mirror of region 3 counts', isVbcColorFramebuffer(0x0b000010), true);
    check('the 1 MiB aperture mirrors within region 3', isVbcColorFramebuffer(0x03100010), true);
    check('the upper half of the aperture is not the framebuffer', isVbcColorFramebuffer(0x03080000), false);
    check('another region does not', isVbcColorFramebuffer(0x05000010), false);
}

section('The bundled patches and their database entries');
const bundled = [];
{
    const colors = PATCH_DATABASE.flatMap(entry => entry.patches
        .filter(patch => patch.type === 'vb-color')
        .map(patch => ({ entry, patch })));
    // the hand-made Galactic Pinball v0.25 entry was retired: it predates the VB Color 1.0 register map
    check('36 colorizations are offered',
        colors.map(({ patch }) => patch.id).sort(),
        ['3d-tetris/vb-color', 'bound-high/vb-color', 'dragon-hopper/vb-color', 'faceball-remastered/vb-color',
            'galactic-pinball/vb-color', 'golf-japan/vb-color', 'golf/vb-color', 'hyper-fighting/vb-color',
            'insmouse-no-yakata/vb-color', 'jack-bros-japan/vb-color', 'jack-bros/vb-color', 'mario-clash/vb-color',
            'marios-tennis/vb-color', 'nesters-funky-bowling/vb-color', 'nikochan-battle/vb-color',
            'panic-bomber-japan/vb-color', 'panic-bomber/vb-color', 'red-alarm/vb-color', 'sd-gundam-dimension-war/vb-color',
            'space-invaders-virtual-collection/vb-color', 'space-pinball/vb-color', 'space-squash/vb-color',
            'teleroboxer/vb-color', 'test-chamber/vb-color', 'v-tetris/vb-color',
            'vertical-force-japan/vb-color', 'vertical-force/vb-color', 'virtual-bowling/vb-color',
            'virtual-boy-wario-land/vb-color', 'virtual-fishing/vb-color', 'virtual-lab/vb-color',
            'virtual-league-baseball-2/vb-color', 'virtual-league-baseball/vb-color',
            'virtual-pro-yakyuu-95/vb-color', 'waterworld/vb-color', 'zero-racers/vb-color'].sort());
    // the web build copies the whole directory, so a stray file would ship for nothing
    const directory = new URL('../../../data/', import.meta.url);
    check('the patches directory holds exactly the cataloged colorizations',
        readdirSync(new URL('patches/', directory), { recursive: true })
            .filter(name => /(^|\/)vb-color[^/]*\.bps$/.test(name))
            .map(name => `patches/${name}`).sort(),
        colors.map(({ patch }) => patch.file).sort());
    // every colorization says the same about itself; one may add to it
    check('every colorization has the shared name and description intro',
        colors.filter(({ patch }) => patch.sharedName !== 'vbColorName'
            || patch.descriptionIntro !== 'vbColorDescriptionIntro').map(({ patch }) => patch.id), []);
    for (const { entry, patch: shipped } of colors) {
        const name = shipped.id;
        const patch = new Uint8Array(readFileSync(new URL(shipped.file, directory)));
        bundled.push({ entry, shipped, patch });
        check(`${name}: is a BPS`, detectRomPatchFormat(patch), 'bps');
        const footer = bpsFooter(patch);
        check(`${name}: its own checksum holds`, hex8(crc32(patch.subarray(0, patch.length - 4))), footer.patch);
        // a colorization must never be offered for a merely similar dump
        check(`${name}: its entry names exactly the ROM the BPS was made for`, entry.crc32, [footer.source]);
        check(`${name}: and the lookup finds it by that ROM`,
            builtInPatchesFor(footer.source).map(found => found.id).includes(name), true);
    }
}

section('The BPS encoder');
{
    const source = syntheticRom(0x10000);
    const edited = source.slice();
    edited.set([1, 2, 3, 4], 0x100);
    edited.set(new Uint8Array(300).fill(0xaa), 0x8000);
    edited[0xffff] ^= 0xff;

    const roundTrip = (label, target) => {
        const patch = createBpsPatch(source, target);
        check(`${label}: recognized as a BPS`, detectRomPatchFormat(patch), 'bps');
        check(`${label}: reproduces the target`, same(applyRomPatch(source, patch), target), true);
        return patch;
    };
    const unchanged = roundTrip('an unchanged ROM', source.slice());
    check('an unchanged ROM costs next to nothing', unchanged.length < 32, true);
    const patch = roundTrip('a ROM with regions rewritten', edited);
    check('only what changed is carried', patch.length < 400, true);
    const grown = new Uint8Array(0x20000);
    grown.set(edited);
    grown.fill(0x55, 0x10000);
    roundTrip('a ROM that grew', grown);
    roundTrip('a ROM that shrank', edited.slice(0, 0x8000));

    const tampered = patch.slice();
    tampered[20] ^= 1;
    let threw = false;
    try {
        applyRomPatch(source, tampered);
    } catch {
        threw = true;
    }
    check('a damaged patch is refused by its checksum', threw, true);
}

// just enough of VueportStorage for a patch store that persists nothing
const storage = {
    parent: () => '/roms',
    stem: () => 'game',
    join: (...parts) => parts.join('/'),
    exists: async () => false,
    readText: async () => '',
    writeText: async () => undefined,
    delete: async () => undefined,
};

class MemoryBrowserStorage {
    values = new Map();
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, value); }
    removeItem(key) { this.values.delete(key); }
}

// no game ships two colorizations, so the store gets its own database: Zero Racers' colorization, a second one beside
// it, and an ordinary patch listed before both
const ROM_ID = '71553796';
const NEWER = 'zero-racers/vb-color';
const OLDER = 'zero-racers/vb-color-sibling';
const HACK = 'zero-racers/probe-hack';
const shippedNewer = builtInPatchesFor(ROM_ID).find(patch => patch.id === NEWER);
const DATABASE = [{
    game: 'Zero Racers (Japan, USA)',
    crc32: [ROM_ID],
    patches: [
        { id: HACK, name: 'Probe Hack', fileName: 'probe-hack.bps', format: 'bps',
            file: 'patches/zero-racers/probe-hack.bps', type: 'hack', author: 'A', description: 'D' },
        shippedNewer,
        { ...shippedNewer, id: OLDER, version: undefined, status: 'partial',
            file: 'patches/zero-racers/vb-color-sibling.bps' },
    ],
}];

const SOURCE = syntheticRom(0x10000);
const TARGET = (() => {
    const target = new Uint8Array(SOURCE.length * 2);
    target.set(SOURCE);
    target.set(SOURCE, SOURCE.length);
    target.set([0xde, 0xad, 0xbe, 0xef], 0x1000);
    return target;
})();
const PATCH = plainBps(SOURCE, TARGET);

async function makeStore({
    autoApply = false,
    disabled = [],
    loadFile = async () => PATCH,
    colorizations = true,
    files = storage,
    browser = new MemoryBrowserStorage(),
} = {}) {
    const restarts = [];
    const remembered = [];
    const fetched = [];
    const patches = new PatchStore(files, DATABASE, browser, async file => {
        fetched.push(file);
        return loadFile(file);
    }, colorizations
        ? {
            choice: () => ({ autoApply, disabled }),
            remember: (id, apply) => remembered.push([id, apply]),
        }
        : undefined);
    await patches.load('/roms/game.vb', ROM_ID, SOURCE);
    patches.onDidChange(change => {
        if (change.affectsRom) restarts.push(true);
    });
    const indexOf = id => patches.list.findIndex(patch => patch.id === id);
    const enabled = id => patches.list[indexOf(id)]?.enabled;
    return { patches, browser, restarts, remembered, fetched, indexOf, enabled };
}

const switchedOn = browser => [...browser.values.values()].flatMap(text => JSON.parse(text).enabled ?? []);

section('Colorizations in the patch store: listed like shipped patches');
{
    const { patches, browser, restarts, remembered, fetched, indexOf, enabled } = await makeStore();
    check('both of the game\'s colorizations are listed first, in catalog order, then the other patches',
        patches.list.map(patch => patch.id), [NEWER, OLDER, HACK]);
    check('each BPS is fetched by the path the database names', fetched,
        ['patches/zero-racers/probe-hack.bps', 'patches/zero-racers/vb-color.bps',
            'patches/zero-racers/vb-color-sibling.bps']);
    const newer = patches.list[0];
    check('with the database\'s details',
        [newer.name, newer.author, newer.version, newer.status, newer.fileName, newer.format],
        ['VB Color Enhanced', 'KR155E', 'v0.1', 'wip', 'vb-color.bps', 'bps']);
    check('and the shared description', newer.description.startsWith('Adds a "VB Color Enhanced" mode'), true);
    check('marked as a shipped colorization', [newer.builtIn, newer.type], [true, 'vb-color']);
    check('its bytes as they ship', same(newer.data, PATCH), true);
    check('neither is on with auto-apply off', [enabled(NEWER), enabled(OLDER)], [false, false]);

    patches.setEnabled(indexOf(OLDER), true);
    check('switched on', enabled(OLDER), true);
    check('which restarts the game once', restarts.length, 1);
    check('and the chain makes the colored ROM', same(patches.apply(SOURCE), TARGET), true);
    check('the badge does not count it', patches.activeOutsideColor, 0);
    check('remembered in the settings, with its sibling off', remembered, [[NEWER, false], [OLDER, true]]);
    check('and not among the patch switches', switchedOn(browser), []);

    remembered.length = 0;
    patches.setEnabled(indexOf(NEWER), true);
    check('switching the other on switches the first off', [enabled(NEWER), enabled(OLDER)], [true, false]);
    check('in one restart', restarts.length, 2);
    check('remembered as a choice between them', remembered, [[OLDER, false], [NEWER, true]]);

    remembered.length = 0;
    patches.setEnabled(indexOf(NEWER), false);
    check('and off again', [enabled(NEWER), enabled(OLDER)], [false, false]);
    check('remembered as off', remembered, [[NEWER, false]]);
    check('the chain is the source again', same(patches.apply(SOURCE), SOURCE), true);

    patches.setEnabled(indexOf(NEWER), true);
    patches.setLocked('Patches are fixed while linked.');
    let refusal = '';
    try {
        patches.setEnabled(indexOf(NEWER), false);
    } catch (error) {
        refusal = error.message;
    }
    check('a locked store refuses to switch one off, saying why', [refusal, enabled(NEWER)],
        ['Patches are fixed while linked.', true]);
    patches.setLocked(undefined);
    patches.disableAll();
    check('switching every patch off includes them', [enabled(NEWER), enabled(OLDER)], [false, false]);
}

section('Colorizations in the patch store: auto-apply');
{
    const on = await makeStore({ autoApply: true });
    check('auto-apply switches on the first as the game loads', [on.enabled(NEWER), on.enabled(OLDER)], [true, false]);
    check('so the first run is colored', same(on.patches.apply(SOURCE), TARGET), true);
    check('an ordinary patch stays off', on.enabled(HACK), false);

    const skipped = await makeStore({ autoApply: true, disabled: [NEWER] });
    check('one switched off is passed over for the next', [skipped.enabled(NEWER), skipped.enabled(OLDER)],
        [false, true]);

    const none = await makeStore({ autoApply: true, colorizations: false });
    check('a host that offers none lists none', none.patches.list.map(patch => patch.id), [HACK]);
}

section('Colorizations in the patch store: one of the player\'s own');
{
    const saved = new Map();
    const files = {
        ...storage,
        exists: async at => saved.has(at),
        readText: async at => saved.get(at),
        writeText: async (at, text) => { saved.set(at, text); },
        delete: async at => { saved.delete(at); },
    };
    const browser = new MemoryBrowserStorage();
    const first = await makeStore({ autoApply: true, files, browser });
    check('the shipped one comes on by itself', first.enabled(NEWER), true);
    const at = first.patches.importPatch('my-colors.bps', PATCH);
    const OWN = first.patches.list[at].id;
    first.patches.updateMetadata(at, { type: 'vb-color' });
    check('an imported patch can be marked as a colorization', first.patches.list[at].type, 'vb-color');
    check('marking one that is off restarts nothing', first.restarts.length, 0);
    first.patches.setEnabled(at, true);
    check('switching it on switches the shipped one off', [first.enabled(NEWER), first.enabled(OWN)], [false, true]);
    check('which the settings remember for the shipped ones', first.remembered, [[NEWER, false], [OLDER, false]]);
    check('its own switch is among the patch switches', switchedOn(browser), [OWN]);
    check('it is laid over the original like a shipped one', same(first.patches.apply(SOURCE), TARGET), true);
    check('and the badge does not count it', first.patches.activeOutsideColor, 0);
    await first.patches.whenSaved();

    const again = await makeStore({ autoApply: true, files, browser });
    check('the next time, the player\'s own wins over auto-apply', [again.enabled(NEWER), again.enabled(OWN)],
        [false, true]);
    again.patches.updateMetadata(again.indexOf(OWN), { type: 'hack' });
    check('unmarking it while it is on restarts the game', again.restarts.length, 1);
    check('it stays on, as an ordinary patch', [again.enabled(OWN), again.patches.activeOutsideColor], [true, 1]);
    // as an ordinary patch it doubles the ROM, which no colorization can be laid over
    let refused = false;
    try {
        again.patches.setEnabled(again.indexOf(NEWER), true);
    } catch {
        refused = true;
    }
    check('a shipped one then cannot come on beside it', [refused, again.enabled(NEWER)], [true, false]);
    again.patches.updateMetadata(again.indexOf(OWN), { type: 'vb-color' });
    check('marking it again while it is on restarts the game again',
        [again.patches.list[again.indexOf(OWN)].type, again.enabled(OWN), again.restarts.length],
        ['vb-color', true, 2]);
}

section('Colorizations in the patch store: a patch that cannot be fetched');
{
    const { patches, enabled } = await makeStore({
        autoApply: true,
        loadFile: async file => {
            if (file.endsWith('zero-racers/vb-color.bps')) {
                throw new Error(`${file}: 404 Not Found`);
            }
            return PATCH;
        },
    });
    check('it is left out, like a shipped patch', patches.list.map(patch => patch.id), [OLDER, HACK]);
    check('and the next one the settings leave on comes on in its place', enabled(OLDER), true);
}

section('The color editor\'s build: a colorization of the player\'s own beside the ROM');
{
    const files = new Map([
        ['/roms/game.vueport-color-edit.bps', PATCH],
        ['/roms/game.vueport-color-edit.json', JSON.stringify({
            format: 'vueport-color-edit', version: 1, base: { patch: NEWER, version: 'v0' }, paint: { tiles: {} },
        })],
    ]);
    const deleted = [];
    const disk = {
        ...storage,
        name: p => p.split('/').pop(),
        exists: async p => files.has(p),
        read: async p => files.get(p),
        readText: async p => String(files.get(p) ?? ''),
        delete: async p => {
            deleted.push(p);
            files.delete(p);
        },
    };
    const { patches, remembered, enabled, indexOf } = await makeStore({ autoApply: true, files: disk });
    check('the build is listed first, ahead of the shipped colorizations',
        patches.list.map(patch => patch.id), ['color/edit', NEWER, OLDER, HACK]);
    check('and comes on by itself, as the first colorization the settings leave on', enabled('color/edit'), true);
    check('the shipped one stays off beside it', enabled(NEWER), false);

    patches.setEnabled(indexOf(NEWER), true);
    check('switching the shipped one on turns the build off', enabled('color/edit'), false);
    await patches.useColorEditBuild();
    check('useColorEditBuild switches the build on again', [enabled('color/edit'), enabled(NEWER)], [true, false]);
    check('and remembers it', remembered.at(-1), ['color/edit', true]);

    patches.remove(indexOf('color/edit'));
    await patches.whenSaved();
    check('removing the build takes it out of the list', patches.list.map(patch => patch.id), [NEWER, OLDER, HACK]);
    check('and deletes its file beside the ROM', deleted, ['/roms/game.vueport-color-edit.bps']);
    check('the colorization it was made on is on again', enabled(NEWER), true);
}

const romDirectory = process.env.VBC_ROM_DIR;
if (romDirectory) {
    section(`Applying the bundled patches to the ROMs in ${romDirectory}`);
    const roms = new Map();
    for (const name of readdirSync(romDirectory)) {
        if (/\.(vb|vbc|bin)$/i.test(name)) {
            const data = new Uint8Array(readFileSync(path.join(romDirectory, name)));
            roms.set(hex8(crc32(data)), { name, data });
        }
    }
    for (const { entry, shipped, patch } of bundled) {
        const rom = entry.crc32.map(crc => roms.get(crc)).find(Boolean);
        if (!rom) {
            console.log(`  (no ROM for ${shipped.id})`);
            continue;
        }
        const started = Date.now();
        const built = applyRomPatch(rom.data, patch);
        check(`${shipped.id}: the result is the target the BPS names`, hex8(crc32(built)), bpsFooter(patch).target);
        console.log(`  ${shipped.id}: ${rom.name}, target ${sha256(built).slice(0, 16)}…, `
            + `${built.length} bytes, ${Date.now() - started} ms`);
    }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
