// Checks the built-in cheat database and the layering that keeps its cheats
// out of the player's own file: that a ROM is identified by the CRC32 the
// preservation catalogues use, that a shipped cheat can be switched on but not
// removed or edited, that only its on/off state is written down, and that the
// `.cht` file beside the ROM keeps holding the player's cheats and nothing else.
//
// Usage: node tests/cheat-database-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = '../lib/';
const { formatRomId, builtInCheatsFor, CHEAT_DATABASE } =
    require(base + 'common/emulator-cheat-database.js');
const { parseVesCheatCodes } = require(base + 'common/emulator-cheats.js');
const { VesEmulatorCheatStore } = require(base + 'browser/emulator-cheat-store.js');
const { parseVesCheatFile } = require(base + 'common/emulator-cheats.js');

let failures = 0;
const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
};
const section = name => console.log(`\n${name}`);

/** Storage in memory, standing in for files beside a ROM. */
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

const ROM = '/games/Test.vb';
const CHT = '/games/Test.cht';
const STATE = '/games/Test.vueport-cheats.json';

// A database of our own, so the probe does not depend on what ships.
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
    const store = new VesEmulatorCheatStore(storage, DB);
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

section('Switching one on');
{
    const storage = memoryStorage();
    const store = new VesEmulatorCheatStore(storage, DB);
    await store.load(ROM, 'a1b2c3d4');
    store.update(0, { enabled: true });
    await new Promise(resolve => setTimeout(resolve, 0));

    check('is remembered beside the ROM', JSON.parse(storage.files[STATE] ?? '{}').enabled, ['test/lives']);
    check('and does not write a cheat file', CHT in storage.files, false);

    const reopened = new VesEmulatorCheatStore(storage, DB);
    await reopened.load(ROM, 'a1b2c3d4');
    check('and comes back on', reopened.list[0].enabled, true);
    check('while the other stays off', reopened.list[1].enabled, false);
}

section("The player's own cheats");
{
    const storage = memoryStorage();
    const store = new VesEmulatorCheatStore(storage, DB);
    await store.load(ROM, 'a1b2c3d4');

    const index = store.add('Mine');
    check('are added after the shipped ones', index, 2);
    store.update(index, { enabled: true });
    await new Promise(resolve => setTimeout(resolve, 0));

    const written = parseVesCheatFile(storage.files[CHT] ?? '');
    check('the cheat file holds only theirs', written.map(c => c.description), ['Mine']);

    store.remove(index);
    await new Promise(resolve => setTimeout(resolve, 0));
    check('and they can be removed', store.list.length, 2);
    check('taking the file with the last one', CHT in storage.files, false);
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
            // Every published code has to survive the emulator's own parser,
            // or the cheat would load with some of its writes missing.
            const written = cheat.codes.split('+').length;
            check(`${cheat.id}: all ${written} code(s) parse`,
                parseVesCheatCodes(cheat.codes).length, written);
        }
    }
    console.log(`  (${CHEAT_DATABASE.length} games, ${cheats} cheats, ${crcs.size} ROMs)`);
    // Every game is reachable by the id the emulator computes from a ROM.
    for (const entry of CHEAT_DATABASE) {
        check(`${entry.game} is found by its CRC`,
            builtInCheatsFor(entry.crc32[0]).length, entry.cheats.length);
    }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
