// checks the built-in cheat database and its layering: ROMs are found by the preservation catalogs' CRC32, shipped
// cheats can be switched on but not edited or removed, only their on/off state is written, and the `.cht` beside the
// ROM holds only the user's own cheats. Usage: node tests/cheat-database-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = '../lib/';
const { formatRomId, builtInCheatsFor, anchorCheatCodeToRomTop, CHEAT_DATABASE } =
    require(base + 'common/emulator-cheat-database.js');
const { parseVesCheatCodes } = require(base + 'common/emulator-cheats.js');
const { CheatStore } = require(base + 'browser/emulator-cheat-store.js');
const { browserStateKey } = require(base + 'browser/emulator-browser-state.js');
const { parseVesCheatFile } = require(base + 'common/emulator-cheats.js');

let failures = 0;
const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
};
const section = name => console.log(`\n${name}`);

function memoryStorage(files = {}) {
    return {
        files,
        read: async p => new TextEncoder().encode(files[p] ?? ''),
        readText: async p => files[p],
        write: async (p, d) => { files[p] = new TextDecoder().decode(d); },
        writeText: async (p, t) => { files[p] = t; },
        exists: async p => p in files,
        delete: async p => { delete files[p]; },
        list: async () => [],
        parent: p => p.slice(0, p.lastIndexOf('/')),
        stem: p => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]*$/, ''),
        name: p => p.slice(p.lastIndexOf('/') + 1),
        join: (d, n) => `${d}/${n}`,
        export: async () => { },
    };
}

function memoryBrowserStorage(values = {}) {
    return {
        values,
        getItem: key => key in values ? values[key] : null,
        setItem: (key, value) => { values[key] = value; },
        removeItem: key => { delete values[key]; },
    };
}

const ROM = '/games/Test.vb';
const CHT = '/games/Test.cht';
const BROWSER_STATE = browserStateKey('cheats', ROM);

// a database of our own, so the probe does not depend on what ships
const DB = [{
    game: 'Test',
    crc32: ['a1b2c3d4', 'deadbeef'],   // the same game, padded two ways
    cheats: [
        { id: 'test/lives', description: 'Infinite Lives', codes: '5000d0e:03' },
        { id: 'test/energy', description: 'Infinite Energy', codes: '5000d10:63+5000d12:63' },
    ],
}];

section('Identifying a ROM');
{
    check('a CRC32 is eight lower-case hex digits', formatRomId(0xa1b2c3d4), 'a1b2c3d4');
    check('and is padded when it is short', formatRomId(0x1234), '00001234');
    // crc32 hands back a signed 32-bit number in some implementations
    check('a negative checksum still formats unsigned', formatRomId(-1), 'ffffffff');

    check('both paddings of a game find its cheats',
        builtInCheatsFor('deadbeef', DB).length, 2);
    check('matching ignores case', builtInCheatsFor('A1B2C3D4', DB).length, 2);
    check('an unknown ROM gets none', builtInCheatsFor('00000000', DB).length, 0);
    check('and so does one with no id at all', builtInCheatsFor(undefined, DB).length, 0);
}

section('A shipped cheat');
{
    const storage = memoryStorage();
    const store = new CheatStore(storage, DB, memoryBrowserStorage());
    await store.load(ROM, 'a1b2c3d4');

    check('shows up without any file beside the ROM', store.list.length, 2);
    check('and is marked as shipped', store.list[0].builtIn, true);
    check('with its codes parsed from the published form', store.list[1].codes.length, 2);
    check('starting switched off', store.list[0].enabled, false);

    store.remove(0);
    check('cannot be removed', store.list.length, 2);

    store.update(0, { description: 'Renamed', codes: [] });
    check('cannot be renamed', store.list[0].description, 'Infinite Lives');
    check('and its codes cannot be changed', store.list[0].codes.length, 1);
}

section('A shipped ROM write, with the ROM grown by a patch');
{
    const code = address => ({ address, value: 0x8a06, digits: 4 });
    const at = (address, size) => anchorCheatCodeToRomTop(code(address), size).address;
    // Dragon Hopper's Skip Intro: a 2 MiB ROM, grown to 8 MiB by its German translation and to 4 MiB by its colour
    // patch, the original at the top
    check('goes to the topmost mirror of its ROM', at(0x07069f2e, 0x200000), 0x07e69f2e);
    check('which is still the same byte on that ROM', at(0x07069f2e, 0x200000) & 0x1fffff, 0x069f2e);
    check('and the original\'s byte in a 4 MiB patch', at(0x07069f2e, 0x200000) & 0x3fffff, 0x269f2e);
    check('and in an 8 MiB one', at(0x07069f2e, 0x200000) & 0x7fffff, 0x669f2e);
    check('a 1 MiB ROM goes higher still', at(0x0700d326, 0x100000), 0x07f0d326);
    check('a code already in a high mirror ends up the same', at(0x07e69f2e, 0x200000), 0x07e69f2e);
    check('a RAM write is left alone', at(0x0500cc5f, 0x200000), 0x0500cc5f);
    check('as is everything given a size that is not a ROM\'s', at(0x07069f2e, 0x180000), 0x07069f2e);

    const store = new CheatStore(memoryStorage(), [{
        game: 'Grown', crc32: ['0badf00d'],
        cheats: [{ id: 'grown/skip', description: 'Skip', codes: '7069F2E:8A06+5000D0E:03' }],
    }], memoryBrowserStorage());
    await store.load(ROM, '0badf00d', 0x200000);
    check('the store anchors a shipped cheat to the unpatched ROM\'s size',
        store.list[0].codes.map(c => c.address), [0x07e69f2e, 0x05000d0e]);
    await store.load(ROM, '0badf00d');
    check('and leaves it as published when not told the size',
        store.list[0].codes.map(c => c.address), [0x07069f2e, 0x05000d0e]);
}

section('Switching one on');
{
    const storage = memoryStorage();
    const browser = memoryBrowserStorage();
    const store = new CheatStore(storage, DB, browser);
    await store.load(ROM, 'a1b2c3d4');
    store.update(0, { enabled: true });
    await new Promise(resolve => setTimeout(resolve, 0));

    check('is remembered in the browser',
        JSON.parse(browser.values[BROWSER_STATE] ?? '{}').enabled, ['built-in:test/lives']);
    check('and does not write a cheat file', CHT in storage.files, false);

    const reopened = new CheatStore(storage, DB, browser);
    await reopened.load(ROM, 'a1b2c3d4');
    check('and comes back on', reopened.list[0].enabled, true);
    check('while the other stays off', reopened.list[1].enabled, false);
}

section("The player's own cheats");
{
    const storage = memoryStorage();
    const browser = memoryBrowserStorage();
    const store = new CheatStore(storage, DB, browser);
    await store.load(ROM, 'a1b2c3d4');

    const index = store.add('Mine');
    check('are added after the shipped ones', index, 2);
    store.update(index, { enabled: true });
    await new Promise(resolve => setTimeout(resolve, 0));

    const written = parseVesCheatFile(storage.files[CHT] ?? '');
    check('the cheat file holds only theirs', written.map(c => c.description), ['Mine']);
    check('and carries no current switch state', written[0].enabled, false);

    const reopened = new CheatStore(storage, DB, browser);
    await reopened.load(ROM, 'a1b2c3d4');
    check('the browser restores their switch', reopened.list[index].enabled, true);

    reopened.remove(index);
    await new Promise(resolve => setTimeout(resolve, 0));
    check('and they can be removed', reopened.list.length, 2);
    check('taking the file with the last one', CHT in storage.files, false);
}

section('A switch written into the cheat file');
{
    const storage = memoryStorage({
        [CHT]: [
            'cheats = 1',
            'cheat0_desc = "Mine"',
            'cheat0_code = "5000000:01"',
            'cheat0_enable = true',
        ].join('\n'),
    });
    const browser = memoryBrowserStorage();
    const store = new CheatStore(storage, DB, browser);
    await store.load(ROM, 'a1b2c3d4');

    check('does not switch the cheat on', store.list.map(cheat => cheat.enabled), [false, false, false]);
    check('and the file is left as it was',
        parseVesCheatFile(storage.files[CHT])[0].enabled, true);
}

section('The database that ships');
{
    const ids = new Set();
    const crcs = new Map();
    let cheats = 0;
    for (const entry of CHEAT_DATABASE) {
        check(`${entry.game} names at least one ROM`, entry.crc32.length > 0, true);
        for (const crc of entry.crc32) {
            check(`${entry.game}: ${crc} is eight lower-case hex digits`,
                /^[0-9a-f]{8}$/.test(crc), true);
            check(`${crc} belongs to one game only`, crcs.has(crc) ? crcs.get(crc) : entry.game, entry.game);
            crcs.set(crc, entry.game);
        }
        for (const cheat of entry.cheats) {
            cheats++;
            check(`${cheat.id} is unique`, ids.has(cheat.id), false);
            ids.add(cheat.id);
            check(`${cheat.id} has a description`, cheat.description.length > 0, true);
            // every published code has to survive the emulator's own parser, or the cheat would lose some of its writes
            const written = cheat.codes.split('+').length;
            check(`${cheat.id}: all ${written} code(s) parse`,
                parseVesCheatCodes(cheat.codes).length, written);
        }
    }
    console.log(`  (${CHEAT_DATABASE.length} games, ${cheats} cheats, ${crcs.size} ROMs)`);
    for (const entry of CHEAT_DATABASE) {
        check(`${entry.game} is found by its CRC`,
            builtInCheatsFor(entry.crc32[0]).length, entry.cheats.length);
    }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
