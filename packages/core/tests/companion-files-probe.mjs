/**
 * Checks where a ROM's companion files go (its save on each of the 26 slots, save states, ESSound folder) in both
 * `companionFiles` layouts. The names are an interface: other emulators read the save beside the ROM, so slot A keeps
 * the plain save name, and slot files must be recognizable on sight.
 * Usage: node tests/companion-files-probe.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EmulatorCompanionFiles } = require('../lib/browser/emulator-companion-files.js');
const { EmulatorCompanionLocation, EMULATOR_SAVE_SLOTS, emulatorSaveSlot } =
    require('../lib/common/emulator-sram.js');

let failures = 0;

function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

// only the path arithmetic of a `VueportStorage`, POSIX style; nothing touches a disk
const storage = {
    join: (directory, name) => (directory ? `${directory.replace(/\/+$/, '')}/${name}` : name),
    parent: path => {
        const index = path.lastIndexOf('/');
        return index <= 0 ? '' : path.slice(0, index);
    },
    name: path => path.slice(path.lastIndexOf('/') + 1),
    stem: path => {
        const name = path.slice(path.lastIndexOf('/') + 1);
        const dot = name.lastIndexOf('.');
        return dot <= 0 ? name : name.slice(0, dot);
    },
};

const beside = new EmulatorCompanionFiles(storage, () => EmulatorCompanionLocation.ROM);
const store = new EmulatorCompanionFiles(storage, () => EmulatorCompanionLocation.STORAGE);

const placed = { name: 'Red Alarm (USA).vb', location: '/Games/Red Alarm (USA).vb' };
const unplaced = { name: 'Red Alarm (USA).vb' };

section('The save file beside the ROM');
{
    check('slot A is the name it has always had',
        beside.saveRam(placed, 1), '/Games/Red Alarm (USA).p1.sram');
    check('and so is a slot nobody asked for',
        beside.saveRam(placed, 1, undefined), '/Games/Red Alarm (USA).p1.sram');
    check('slot B carries the letter',
        beside.saveRam(placed, 1, 'B'), '/Games/Red Alarm (USA).p1.B.sram');
    check('the last slot too',
        beside.saveRam(placed, 1, 'Z'), '/Games/Red Alarm (USA).p1.Z.sram');
    check('player two has a cartridge of its own on every slot',
        beside.saveRam(placed, 2, 'B'), '/Games/Red Alarm (USA).p2.B.sram');
    check('a lower-case letter names the same slot',
        beside.saveRam(placed, 1, 'b'), beside.saveRam(placed, 1, 'B'));
    check('and something that is not a slot is slot A',
        beside.saveRam(placed, 1, 'nonsense'), beside.saveRam(placed, 1, 'A'));

    // a ROM the host cannot place has no "beside", so it falls back to the store whatever the setting says
    check('a ROM with nowhere to sit beside falls back to the store',
        beside.saveRam(unplaced, 1, 'B'), 'roms/Red Alarm (USA)/save.B.sram');
}

section("The save file in the application's storage");
{
    check('slot A is the name it has always had',
        store.saveRam(placed, 1), 'roms/Red Alarm (USA)/save.sram');
    check('player two keeps its own', store.saveRam(placed, 2), 'roms/Red Alarm (USA)/save-2.sram');
    check('slot B carries the letter', store.saveRam(placed, 1, 'B'), 'roms/Red Alarm (USA)/save.B.sram');
    check('and player two on slot B has both',
        store.saveRam(placed, 2, 'B'), 'roms/Red Alarm (USA)/save-2.B.sram');
}

section('Every slot is a file of its own');
{
    const names = new Set();
    for (const slot of EMULATOR_SAVE_SLOTS) {
        for (const player of [1, 2]) {
            names.add(beside.saveRam(placed, player, slot));
            names.add(store.saveRam(placed, player, slot));
        }
    }
    check('twenty-six slots, two players, two layouts', names.size, EMULATOR_SAVE_SLOTS.length * 4);
    check('and there are twenty-six of them', EMULATOR_SAVE_SLOTS.length, 26);
    check('beginning at A', EMULATOR_SAVE_SLOTS[0], 'A');
    check('and ending at Z', EMULATOR_SAVE_SLOTS[25], 'Z');
}

section('What counts as a slot');
{
    check('a letter', emulatorSaveSlot('C'), 'C');
    check('a lower-case letter', emulatorSaveSlot('c'), 'C');
    check('one with space around it', emulatorSaveSlot('  c '), 'C');
    check('two letters are not a slot', emulatorSaveSlot('AB'), 'A');
    check('nor is a digit', emulatorSaveSlot('1'), 'A');
    check('nor nothing at all', emulatorSaveSlot(undefined), 'A');
}

section('What the slots leave alone');
{
    // save states are named for when they were taken, and the save game letters must not touch them
    check('a save state beside the ROM carries the ROM’s name',
        beside.saveState(placed, '20260917-134501-097'),
        '/Games/Red Alarm (USA).20260917-134501-097.state');
    check('and in the store is named for what it is',
        store.saveState(placed, '20260917-134501-097'),
        'roms/Red Alarm (USA)/state-20260917-134501-097.state');
    check('the ESSound folder is the ROM’s own', beside.sounds(placed), '/Games');
}

section('A ROM that came out of an archive');
{
    // files beside a cartridge's own archive carry the archive's name, which is how the user knows the game
    const zipped = { name: 'RED_ALARM.vb', location: '/Games/Red Alarm (USA).vbz' };
    check('its save goes beside the archive, named for it',
        beside.saveRam(zipped, 1), '/Games/Red Alarm (USA).p1.sram');
    check('and so do its save states',
        beside.saveState(zipped, 'suspend'), '/Games/Red Alarm (USA).suspend.state');
    check('which read back as its own',
        beside.saveStateId(zipped, 'Red Alarm (USA).suspend.state'), 'suspend');
    check('its cheats hang off the archive’s name',
        beside.romPath(zipped), '/Games/Red Alarm (USA).vb');
    check('the extension is matched whatever its case',
        beside.saveRam({ name: 'x.vb', location: '/Games/Red Alarm.VBZ' }, 1),
        '/Games/Red Alarm.p1.sram');
    check('.vb.zip is one extension, not two',
        beside.saveRam({ name: 'x.vb', location: '/Games/Red Alarm.vb.zip' }, 1),
        '/Games/Red Alarm.p1.sram');
    check('a ROM without an extension still has a stem to take off',
        beside.romPath({ name: 'GAME', location: '/Games/Mario Clash (v1.1).vbz' }),
        '/Games/Mario Clash (v1.1).vb');

    // a plain zip may be a whole collection, and every game in it sharing one save would be worse
    const collected = { name: 'Red Alarm (USA).vb', location: '/Games/Collection.zip' };
    check('a plain zip names its files for the ROM inside',
        beside.saveRam(collected, 1), '/Games/Red Alarm (USA).p1.sram');
    check('and its states', beside.saveState(collected, 'suspend'),
        '/Games/Red Alarm (USA).suspend.state');

    check('in the store nothing changes',
        store.saveRam(zipped, 1), 'roms/RED_ALARM/save.sram');
    // ESSound tracks are unpacked into the store whichever layout the saves use, never into the user's folder
    check('its ESSound folder is in the store, beside the ROM',
        beside.sounds(zipped), 'roms/RED_ALARM');
    check('and in the store', store.sounds(zipped), 'roms/RED_ALARM');
    check('a ROM nobody can place looks there as well',
        beside.sounds(unplaced), 'roms/Red Alarm (USA)');
    check('a plain ROM is still its own path',
        beside.romPath(placed), placed.location);
}

section('Reading a save state’s name back');
{
    // the names are the library's index (see `SaveStateStore`), so every written name must be recognized again
    // and another game's files in a shared folder passed over
    for (const id of ['20260917-134501-097', 'auto-20260917-134501-097', 'suspend']) {
        check(`beside the ROM: ${id}`,
            beside.saveStateId(placed, storage.name(beside.saveState(placed, id))), id);
        check(`in the store: ${id}`,
            store.saveStateId(placed, storage.name(store.saveState(placed, id))), id);
    }
    check('another game’s state, beside the ROM',
        beside.saveStateId(placed, 'Mario Clash (USA).suspend.state'), undefined);
    check('the save file is not a state',
        store.saveStateId(placed, 'save.sram'), undefined);
    check('nor is a folder full of nothing',
        store.saveStateId(placed, 'state-.state'), undefined);
    check('an older numbered slot still reads as a state',
        store.saveStateId(placed, 'state-1.state'), '1');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
