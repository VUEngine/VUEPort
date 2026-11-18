// the save-state library: saving always makes a new state, automatic states rotate while manual ones stay, the
// suspended game is one overwritten file, names round-trip, and another ROM's state is refused. The list is a directory
// listing, hence a real storage. Usage: node tests/save-state-store-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SaveStateStore, withOtherRomOffer } = require('../lib/browser/emulator-save-state-store.js');
const { EmulatorCompanionFiles } = require('../lib/browser/emulator-companion-files.js');
const { EmulatorCompanionLocation } = require('../lib/common/emulator-sram.js');
const stateFile = require('../lib/common/emulator-save-state.js');

let failures = 0;

function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

async function rejects(label, promise, pattern) {
    try {
        await promise;
        failures++;
        console.log(`  FAIL ${label}: did not throw`);
    } catch (error) {
        if (!pattern.test(error.message)) {
            failures++;
            console.log(`  FAIL ${label}: unexpected message ${JSON.stringify(error.message)}`);
        }
    }
}

function section(name) {
    console.log(`\n${name}`);
}

function memoryStorage() {
    const files = new Map();
    return {
        files,
        exported: [],
        async read(path) {
            const found = files.get(path);
            if (!found) {
                throw new Error(`No such file: ${path}`);
            }
            return found;
        },
        async readText(path) { return new TextDecoder().decode(await this.read(path)); },
        async write(path, data) { files.set(path, data.slice()); },
        async writeText(path, text) { files.set(path, new TextEncoder().encode(text)); },
        async exists(path) { return files.has(path); },
        async delete(path) { files.delete(path); },
        async list(directory) {
            return [...files].filter(([path]) => path.startsWith(`${directory}/`)
                && !path.slice(directory.length + 1).includes('/'))
                .map(([path, data]) => ({ path, name: path.slice(directory.length + 1), size: data.length }));
        },
        parent: path => path.slice(0, Math.max(0, path.lastIndexOf('/'))),
        name: path => path.slice(path.lastIndexOf('/') + 1),
        stem(path) {
            const name = this.name(path);
            const dot = name.lastIndexOf('.');
            return dot <= 0 ? name : name.slice(0, dot);
        },
        join: (directory, name) => (directory ? `${directory}/${name}` : name),
        async export(name, data) { this.exported.push([name, data]); },
    };
}

// a state is a block of a byte that says what moment it is
function fakeMachine() {
    const machine = {
        machineCount: 1,
        moment: 1,
        restored: undefined,
        esSound: { playing: [], volumes: [], balances: [] },
        restoredSound: undefined,
        async snapshot() { return [new Uint8Array(64).fill(this.moment).buffer]; },
        clearedCaches: false,
        async restore(states, options) {
            this.restored = new Uint8Array(states[0])[0];
            this.clearedCaches = options?.clearCaches === true;
        },
        // nothing decodes it; under test is that the picture is kept and handed back
        async thumbnail() { return new Uint8Array([1, 2, 3, 4]); },
        identity: () => ({ romIdentity: new Uint8Array(32).fill(7), romSize: 16 }),
        esSoundSnapshot() { return this.esSound; },
        esSoundRestore(snapshot) { this.restoredSound = snapshot; },
    };
    return machine;
}

const rom = { name: 'Red Alarm (USA).vb' };
const storage = memoryStorage();
const companions = new EmulatorCompanionFiles(storage, () => EmulatorCompanionLocation.STORAGE);
const machine = fakeMachine();
const store = new SaveStateStore(storage, companions);

await store.attach(rom, machine);

section('Saving always makes a new state');
{
    const first = await store.create('manual');
    machine.moment = 2;
    const second = await store.create('manual');
    check('two saves, two states', store.list.length, 2);
    check('and two files', storage.files.size, 2);
    check('neither is the other', first.id === second.id, false);
    check('the newest is first', store.list[0].id, second.id);
    check('which is what Load State loads', store.latestManual.id, second.id);
    check('a state carries its picture', store.list[0].thumbnail?.startsWith('data:image/png;base64,'), true);
    check('and when it was taken', store.list[0].created > 0, true);
}

section('Putting one back');
{
    machine.moment = 9;
    await store.restore(store.list[store.list.length - 1]);
    check('the machine is back at the first moment', machine.restored, 1);
    check('and what was playing is put back too',
        JSON.stringify(machine.restoredSound), JSON.stringify(machine.esSound));
}

section('Automatic states rotate');
{
    for (let i = 0; i < 4; i++) {
        machine.moment = 10 + i;
        await store.create('auto');
    }
    check('four of them', store.autoStates.length, 4);
    await store.pruneAuto(2);
    check('the newest two are kept', store.autoStates.length, 2);
    check('the oldest went', store.autoStates.every(entry => entry.created > 0), true);
    // the whole point of the rotation: it must never reach what the user made
    check('and the states somebody made are untouched',
        store.list.filter(entry => entry.kind === 'manual').length, 2);
}

section('The suspended game is one file');
{
    machine.moment = 20;
    await store.create('suspend');
    const suspended = store.suspended;
    check('there is one', suspended !== undefined, true);
    check('and it sits at the top of the list', store.list[0].id, suspended.id);
    machine.moment = 21;
    await store.create('suspend');
    check('saving again overwrites it rather than adding one',
        store.list.filter(entry => entry.kind === 'suspend').length, 1);
    await store.restore(store.suspended);
    check('and it holds the later moment', machine.restored, 21);

    await store.clearSuspended();
    check('declining to resume throws it away', store.suspended, undefined);
}

section('Naming one');
{
    const entry = store.latestManual;
    await store.rename(entry, '  Before the boss  ');
    check('the name is kept, trimmed', store.latestManual.label, 'Before the boss');
    check('and lives in the file, so an export carries it',
        stateFile.describeSaveState(storage.files.get(entry.path)).meta.label, 'Before the boss');
    check('the state still loads', (await store.restore(store.latestManual), machine.restored), 2);
    await store.rename(store.latestManual, '   ');
    check('and an empty name is no name', store.latestManual.label, undefined);

    // naming a state the emulator would drop or overwrite means the user wants to keep it
    machine.moment = 30;
    await store.create('auto');
    await store.rename(store.autoStates[0], 'Worth keeping');
    check('naming an automatic state makes it one of your own',
        store.list.find(e => e.label === 'Worth keeping')?.kind, 'manual');
    check('so the rotation no longer counts it', store.autoStates.length, 2);
    await store.pruneAuto(0);
    check('and cannot drop it',
        store.list.find(e => e.label === 'Worth keeping') !== undefined, true);

    machine.moment = 31;
    await store.create('suspend');
    await store.rename(store.suspended, 'Last night');
    check('naming the suspended game keeps that too', store.suspended, undefined);
    const kept = store.list.find(e => e.label === 'Last night');
    check('as a state somebody made', kept?.kind, 'manual');
    check('under a name the next close cannot write over', kept.id !== 'suspend', true);
}

section('Taking one in from elsewhere');
{
    const identity = machine.identity();
    const theirs = await stateFile.wrapSaveState([new Uint8Array(64).fill(5).buffer], identity, {}, {
        kind: 'auto', created: 1789000000000, thumbnail: undefined,
    });
    const imported = await store.importState('Somebody Else.state', theirs);
    check('an automatic state carried here becomes one of your own',
        store.list.find(entry => entry.id === imported.id).kind, 'manual');
    check('and is named after the file it arrived in',
        store.list.find(entry => entry.id === imported.id).label, 'Somebody Else');
    check('and it loads', (await store.restore(imported), machine.restored), 5);

    const otherGame = await stateFile.wrapSaveState(
        [new Uint8Array(64).fill(6).buffer],
        { romIdentity: new Uint8Array(32).fill(3), romSize: 16 },
        {},
    );
    await rejects('another ROM\'s state is not taken in unasked',
        store.importState('Mario Clash.state', otherGame), /different ROM/);

    const asked = [];
    const answering = answer => ({
        info() {}, warn() {}, error() {}, async progress() { return { done() {} }; },
        async confirm(options) { asked.push(options); return answer; },
    });
    check('declined, nothing is imported',
        await withOtherRomOffer(answering(false), 'import', options => store.importState('Mario Clash.state', otherGame, options)), false);
    check('after asking', asked.length, 1);
    check('with a warning to read', asked[0].message.length > 0 && /Import/.test(asked[0].okLabel), true);
    const before = store.list.length;
    check('agreed, it is',
        await withOtherRomOffer(answering(true), 'import', options => store.importState('Mario Clash.state', otherGame, options)), true);
    check('as a state of this game', store.list.length, before + 1);
    const taken = store.list.find(entry => entry.label === 'Mario Clash');
    await rejects('loading it unasked is refused too', store.restore(taken), /different ROM/);
    check('loaded anyway, it loads',
        await withOtherRomOffer(answering(true), 'load', options => store.restore(taken, options)), true);
    check('... the machine back at its moment', machine.restored, 6);
    check('... with the instruction cache emptied', machine.clearedCaches, true);
    await store.restore(imported);
    check('a state of this ROM leaves the cache alone', machine.clearedCaches, false);
}

section('Files that are not states');
{
    // named like a state, but only bytes: nothing to list and nothing to load
    await storage.write('roms/Red Alarm (USA)/state-3.state', new Uint8Array(64).fill(8));
    await store.refresh();
    check('it is not listed', store.list.some(entry => entry.id === '3'), false);
    await rejects('and it is refused on the way in',
        store.importState('Junk.state', new Uint8Array(64).fill(8)), /not a save state/);
}

section('A state whose metadata cannot be read');
{
    // no metadata section, as a hand-edited file can end up; the machine is still in it, so it is listed and loadable
    const bare = await stateFile.wrapSaveState([new Uint8Array(64).fill(9).buffer], machine.identity(), {});
    await storage.write('roms/Red Alarm (USA)/state-4.state', bare);
    await store.refresh();
    const entry = store.list.find(candidate => candidate.id === '4');
    check('it is listed', entry !== undefined, true);
    check('as something somebody made', entry.kind, 'manual');
    check('with no date', entry.created, 0);
    check('and it loads', (await store.restore(entry), machine.restored), 9);
    await rejects('but it cannot be named', store.rename(entry, 'Four'), /cannot be named/);
}

section('Throwing one away');
{
    const before = store.list.length;
    const entry = store.list[0];
    await store.remove(entry);
    check('the row goes', store.list.length, before - 1);
    check('and so does the file', storage.files.has(entry.path), false);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
