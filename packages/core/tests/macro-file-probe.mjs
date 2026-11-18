// the macro recorder's pure half, against the shipped lib/common/emulator-macros.js: a recording becomes a macro that
// starts at zero and ends with everything released, and the file survives a round trip, a hand edit and a truncation.
// Usage: node tests/macro-file-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const macros = require('../lib/common/emulator-macros.js');
const { MacroStore } = require('../lib/browser/emulator-macro-store.js');
const { browserStateKey } = require('../lib/browser/emulator-browser-state.js');

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

// as the hardware latches them; not imported, so a change to the masks has to be made in two places on purpose
const A = 0x0004;
const B = 0x0008;
const LU = 0x0800;
const STA = 0x1000;

section('Finishing a recording');
{
    const macro = macros.finishMacro('Tap', [
        { at: 1000, keys: 0 },
        { at: 3000, keys: A },
        { at: 3100, keys: 0 },
    ], 4000);

    check('the wait before the first press is cut', macro.steps[0].at, 0);
    check('and the press is what starts it', macro.steps[0].keys, A);
    check('the release keeps its distance', macro.steps[1].at, 100);
    check('it ends released', macro.steps[macro.steps.length - 1].keys, 0);
    check('and the length is that moment', macro.duration, 100);
}
{
    // stopped with A still held: the recording has to close it, or playback would never let go
    const macro = macros.finishMacro('Held', [
        { at: 0, keys: A },
    ], 500);
    check('a release is appended', macro.steps.length, 2);
    check('at the moment recording stopped', macro.steps[1].at, 500);
    check('holding nothing', macro.steps[1].keys, 0);
    check('and that is the length', macro.duration, 500);
}
{
    // already holding a direction when Record was pressed: that is part of the sequence
    const macro = macros.finishMacro('Running jump', [
        { at: 200, keys: LU },
        { at: 700, keys: LU | A },
        { at: 800, keys: 0 },
    ], 900);
    check('the held direction starts it', macro.steps[0].keys, LU);
    check('at zero', macro.steps[0].at, 0);
    check('and the rest follows it', macro.steps[1], { at: 500, keys: LU | A });
}
{
    check('a recording with nothing in it has no steps',
        macros.finishMacro('Empty', [{ at: 0, keys: 0 }], 5000).steps, []);
    check('and no length',
        macros.finishMacro('Empty', [{ at: 0, keys: 0 }], 5000).duration, 0);
    check('which is what an empty macro is',
        macros.macroIsEmpty(macros.finishMacro('Empty', [], 5000)), true);
}
{
    // a pad reporting the same mask twice, and two changes inside one millisecond; neither should be a step
    const macro = macros.finishMacro('Noisy', [
        { at: 0, keys: A },
        { at: 100, keys: A },
        { at: 300, keys: A | B },
        { at: 300, keys: B },
        { at: 400, keys: 0 },
    ], 400);
    check('an unchanged mask is not a step', macro.steps.length, 3);
    check('and only the later of two at one moment is kept',
        macro.steps[1], { at: 300, keys: B });
}

section('Reading a macro back');
{
    const macro = macros.finishMacro('Combo', [
        { at: 0, keys: LU },
        { at: 100, keys: LU | A },
        { at: 200, keys: 0 },
    ], 200);

    check('nothing is held before it starts', macros.macroKeysAt(macro, -1), 0);
    check('the first step holds from zero', macros.macroKeysAt(macro, 0), LU);
    check('and goes on holding between steps', macros.macroKeysAt(macro, 99), LU);
    check('the next takes over on its moment', macros.macroKeysAt(macro, 100), LU | A);
    check('past the end nothing is held', macros.macroKeysAt(macro, 5000), 0);

    check('every button it ever holds', macros.macroKeysUsed(macro), LU | A);
    // letting go of one of two is not a press; adding one to what is held is
    check('presses are the steps that add a button', macros.macroPressCount(macro), 2);
    check('and each press is what that step added', macros.macroPresses(macro), [LU, A]);
}
{
    const chord = macros.finishMacro('Chord', [
        { at: 0, keys: A | B },
        { at: 100, keys: 0 },
        { at: 200, keys: STA },
        { at: 300, keys: 0 },
    ], 300);
    check('a chord is one press', macros.macroPressCount(chord), 2);
    check('holding both buttons', macros.macroPresses(chord), [A | B, STA]);
}
{
    // a direction held while tapping another is pressed once, not again each time the other lets go
    const held = macros.finishMacro('Held', [
        { at: 0, keys: LU },
        { at: 100, keys: LU | A },
        { at: 200, keys: LU },
        { at: 300, keys: LU | A },
        { at: 400, keys: 0 },
    ], 400);
    check('a held button is pressed once', macros.macroPresses(held), [LU, A, A]);
}
{
    check('a macro with nothing in it presses nothing',
        macros.macroPresses(macros.emptyMacro('Empty')), []);
}

section('Durations');
{
    check('under a minute, to a tenth', macros.formatMacroDuration(1460), '1.5 s');
    check('and rounded rather than cut', macros.formatMacroDuration(1234), '1.2 s');
    check('a moment', macros.formatMacroDuration(0), '0.0 s');
    check('a long one is minutes and seconds', macros.formatMacroDuration(63200), '1:03.2');
    check('with the seconds padded', macros.formatMacroDuration(61000), '1:01.0');
}

section('The file');
{
    const written = [
        macros.finishMacro('Konami', [{ at: 0, keys: LU }, { at: 80, keys: 0 }], 80),
        { ...macros.finishMacro('Turbo', [{ at: 0, keys: A }, { at: 50, keys: 0 }], 50), loop: true },
    ];
    const text = macros.serializeMacroFile(written);
    const read = macros.parseMacroFile(text);

    check('a round trip keeps both', read.length, 2);
    check('and their names', read.map(macro => macro.name), ['Konami', 'Turbo']);
    check('and their steps', read[0].steps, written[0].steps);
    check('and their lengths', read[1].duration, 50);
    check('and excludes current repeat state', read[1].loop, undefined);
    check('a macro that does not repeat says nothing about it', read[0].loop, undefined);
    check('the file names its version', JSON.parse(text).version, macros.MACRO_FILE_VERSION);
}
{
    check('a file that is not JSON reads as no macros',
        macros.parseMacroFile('{ this was truncated'), []);
    check('and neither is an empty one', macros.parseMacroFile(''), []);
    check('nor one holding something else entirely',
        macros.parseMacroFile('{"cheats": 3}'), []);
}
{
    // hand-edited: steps out of order, a step that is not one, no closing release, and a length that disagrees
    const read = macros.parseMacroFile(JSON.stringify({
        version: 1,
        macros: [{
            name: 'Edited',
            duration: 10,
            steps: [
                { at: 300, keys: STA },
                { keys: A },
                { at: 0, keys: B },
            ],
        }],
    }));
    check('one macro survives', read.length, 1);
    check('a step without a moment is dropped', read[0].steps.length, 3);
    check('the rest are put in order', read[0].steps[0], { at: 0, keys: B });
    check('a missing release is restored', read[0].steps[2], { at: 300, keys: 0 });
    check('and the length cannot be shorter than the steps', read[0].duration, 300);
}
{
    check('a macro without a name is not one',
        macros.parseMacroFile('{"macros":[{"steps":[]}]}'), []);
    check('and neither is one without steps',
        macros.parseMacroFile('{"macros":[{"name":"X"}]}'), []);
    check('but the macros around it are kept',
        macros.parseMacroFile(
            '{"macros":[{"name":"X"},{"name":"Y","steps":[]}]}').map(macro => macro.name),
        ['Y']);
}

// files, and the browser's small store for the switches that are not part of a recording
class MemoryStorage {
    files = new Map();
    parent(path) { return path.slice(0, path.lastIndexOf('/')) || '/'; }
    stem(path) { return path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, ''); }
    join(parent, child) { return `${parent.replace(/\/$/, '')}/${child}`; }
    async exists(path) { return this.files.has(path); }
    async readText(path) { return this.files.get(path); }
    async writeText(path, value) { this.files.set(path, value); }
    async delete(path) { this.files.delete(path); }
}
class MemoryBrowserStorage {
    values = new Map();
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, value); }
    removeItem(key) { this.values.delete(key); }
}

section('Macro store state');
{
    const rom = '/roms/probe.vb';
    const path = '/roms/probe.vueport-macros.json';
    const storage = new MemoryStorage();
    const browser = new MemoryBrowserStorage();
    const turbo = macros.finishMacro('Turbo', [{ at: 0, keys: A }, { at: 50, keys: 0 }], 50);
    // a `loop` in the file is not a switch: only the browser says what repeats
    storage.files.set(path, JSON.stringify({ version: 1, macros: [{ ...turbo, loop: true }] }));

    const first = new MacroStore(storage, browser);
    await first.load(rom);
    check('a loop flag in the file is not taken as the switch', first.list[0].loop, undefined);

    first.update(0, { loop: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    check('the switch is stored in the browser',
        JSON.parse(browser.values.get(browserStateKey('macros', rom))).looping.length, 1);

    const restored = new MacroStore(storage, browser);
    await restored.load(rom);
    check('the browser restores the repeat switch', restored.list[0].loop, true);

    restored.importMacros([{ ...turbo, name: 'Imported', loop: true }]);
    check('an imported macro comes in playing once', restored.list[1].loop, undefined);
}

section('Macros that belong to every game');
{
    const shared = '/shared/macros.vueport-macros.json';
    const storage = new MemoryStorage();
    const browser = new MemoryBrowserStorage();
    const store = new MacroStore(storage, browser, () => shared);

    await store.load('/roms/one.vb');
    check('a store with a shared file offers the choice', store.supportsGlobal, true);
    store.importMacros([
        macros.finishMacro('Own', [{ at: 0, keys: A }, { at: 40, keys: 0 }], 40),
        macros.finishMacro('Shared', [{ at: 0, keys: A }, { at: 60, keys: 0 }], 60),
    ]);
    check('both start out as this ROM\'s', store.list.map(macro => !!macro.global), [false, false]);

    store.setGlobal(1, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    // moved to the end, as the ROM's own come first (see list)
    check('the moved one is marked', store.list.map(macro => macro.global === true), [false, true]);
    check('and is the last of them', store.list.map(macro => macro.name), ['Own', 'Shared']);
    check('this ROM\'s file keeps only its own',
        JSON.parse(storage.files.get('/roms/one.vueport-macros.json')).macros.map(m => m.name),
        ['Own']);
    check('and the shared file has the other',
        JSON.parse(storage.files.get(shared)).macros.map(m => m.name), ['Shared']);
    check('neither file records the flag itself',
        'global' in JSON.parse(storage.files.get(shared)).macros[0], false);

    await store.load('/roms/two.vb');
    check('another ROM sees the shared macro', store.list.map(macro => macro.name), ['Shared']);
    check('still marked as shared', store.list[0].global, true);
    check('and playing it addresses the right one', (() => {
        store.play(0);
        return store.playingIndex;
    })(), 0);
    store.stop();

    const reopened = new MacroStore(storage, browser, () => shared);
    await reopened.load('/roms/one.vb');
    check('a fresh store reads both files',
        reopened.list.map(macro => macro.name), ['Own', 'Shared']);
    check('with the shared one still marked',
        reopened.list.map(macro => macro.global === true), [false, true]);

    reopened.setGlobal(1, false);
    await new Promise(resolve => setTimeout(resolve, 0));
    check('unmarking moves it back', reopened.list.map(macro => macro.global === true), [false, false]);
    check('and empties the shared file', storage.files.has(shared), false);

    const withoutShared = new MacroStore(storage, browser);
    await withoutShared.load('/roms/one.vb');
    check('a store with nowhere to put them does not offer the choice',
        withoutShared.supportsGlobal, false);
    withoutShared.setGlobal(0, true);
    check('and refuses to move one',
        withoutShared.list.map(macro => macro.global === true), [false, false]);
}

section('Macro slots');
{
    // in the file, unlike the repeat switch, as which button plays a macro is part of the setup
    const written = [
        { ...macros.finishMacro('Jump', [{ at: 0, keys: A }, { at: 40, keys: 0 }], 40), slot: 3 },
        macros.finishMacro('Run', [{ at: 0, keys: B }, { at: 40, keys: 0 }], 40),
    ];
    const read = macros.parseMacroFile(macros.serializeMacroFile(written));
    check('a slot survives the round trip', read[0].slot, 3);
    check('a macro without one has none', 'slot' in read[1], false);
    const odd = macros.parseMacroFile(JSON.stringify({
        version: 1,
        macros: [
            { name: 'Zero', slot: 0, steps: [] },
            { name: 'Nine', slot: 9, steps: [] },
            { name: 'Half', slot: 2.5, steps: [] },
            { name: 'Word', slot: 'two', steps: [] },
        ],
    }));
    check('a slot that is not one of the eight is dropped', odd.map(macro => macro.slot), [
        undefined, undefined, undefined, undefined]);
    check('without dropping the macro', odd.length, 4);
}
{
    const shared = '/shared/slots.vueport-macros.json';
    const storage = new MemoryStorage();
    const browser = new MemoryBrowserStorage();
    const store = new MacroStore(storage, browser, () => shared);
    await store.load('/roms/slots.vb');
    store.importMacros([
        macros.finishMacro('First', [{ at: 0, keys: A }, { at: 40, keys: 0 }], 40),
        macros.finishMacro('Second', [{ at: 0, keys: B }, { at: 40, keys: 0 }], 40),
        macros.finishMacro('Shared', [{ at: 0, keys: STA }, { at: 40, keys: 0 }], 40),
    ]);
    store.setGlobal(2, true);

    store.setSlot(0, 1);
    check('a macro takes a slot', store.list[0].slot, 1);
    store.setSlot(1, 1);
    check('another macro in the same file takes it away', store.list.map(macro => macro.slot), [
        undefined, 1, undefined]);
    store.setSlot(2, 1);
    check('a global one may share the number', store.list.map(macro => macro.slot), [undefined, 1, 1]);

    store.playSlot(1);
    check('the game\'s own plays before the global one', store.playingIndex, 1);
    store.playSlot(1);
    check('pressed again, it stops', store.playingIndex, undefined);

    store.setSlot(1, undefined);
    check('taken out of its slot', store.list[1].slot, undefined);
    store.playSlot(1);
    check('the global one plays when the game has none', store.playingIndex, 2);
    store.stop();
    store.playSlot(5);
    check('an empty slot plays nothing', store.playingIndex, undefined);

    await new Promise(resolve => setTimeout(resolve, 0));
    check('the slot is written to the file it belongs to',
        JSON.parse(storage.files.get(shared)).macros[0].slot, 1);

    // moved into the game's file, its slot goes with it and wins there
    store.setSlot(0, 1);
    store.setGlobal(2, false);
    check('a macro moving in takes its slot in the new file', store.list.map(macro => macro.slot), [
        undefined, undefined, 1]);

    store.importMacros([{ ...macros.finishMacro('New', [{ at: 0, keys: A }, { at: 40, keys: 0 }], 40), slot: 1 }]);
    check('an imported macro does not take a slot in use', store.list[3].slot, undefined);
    store.importMacros([{ ...macros.finishMacro('Newer', [{ at: 0, keys: A }, { at: 40, keys: 0 }], 40), slot: 6 }]);
    check('but keeps a free one', store.list[4].slot, 6);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
