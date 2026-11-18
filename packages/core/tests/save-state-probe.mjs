// checks the save state container: round trip, metadata, linked-pair vs. single-machine files, refusing another ROM's
// state or a damaged body, and that only the current layout is read. Usage: node tests/save-state-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = '../lib/common/';
const state = require(base + 'emulator-save-state.js');
const { EmulatorSramInit } = require(base + 'emulator-sram.js');

let failures = 0;

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
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

const identity = { romIdentity: new Uint8Array(32).fill(7), romSize: 16 };
const block = value => new Uint8Array(64).fill(value).buffer;

// where the header says each section is: metadata, thumbnail, ESSound, body
function sections(file) {
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    let at = state.STATE_HEADER_BYTES;
    return [52, 56, 60, 64].map(word => {
        const length = view.getUint32(word);
        const range = [at, at + length];
        at += length;
        return range;
    });
}

section('Round trip');
{
    const file = await state.wrapSaveState([block(1)], identity, { playing: 'x' });
    const read = await state.unwrapSaveState(file, 1, identity);
    check('one machine, one block', read.states.length, 1);
    check('the block survives', new Uint8Array(read.states[0]).every(v => v === 1), true);
    check('the ESSound section survives', JSON.parse(read.esSound), { playing: 'x' });

    const pair = await state.wrapSaveState([block(1), block(2)], identity, {});
    const readPair = await state.unwrapSaveState(pair, 2, identity);
    check('a linked pair keeps both blocks', readPair.states.length, 2);
    check('and keeps them in order', new Uint8Array(readPair.states[1])[0], 2);
    check('each in a buffer of its own', readPair.states[0] !== readPair.states[1]
        && readPair.states[0].byteLength === 64, true);
    check('a file written without metadata has none', read.meta, undefined);
}

section('The machine is stored compressed');
{
    // like a core's state: a megabyte or two, mostly repeating tables and pictures
    const machine = new Uint8Array(1 << 20);
    for (let i = 0; i < machine.length; i += 4096) {
        machine[i] = i >> 12;
    }
    const file = await state.wrapSaveState([machine.buffer], identity, {});
    check('the file is a fraction of the machine', file.length < machine.length / 50, true);
    const read = await state.unwrapSaveState(file, 1, identity);
    check('and inflates back to it exactly',
        new Uint8Array(read.states[0]).every((v, i) => v === machine[i]), true);

    const [, , , body] = sections(file);
    const damaged = file.slice();
    damaged[body[0] + Math.floor((body[1] - body[0]) / 2)] ^= 0xff;
    await rejects('a body damaged since it was written is refused',
        state.unwrapSaveState(damaged, 1, identity), /damaged/);
    check('though it is still described, so the browser can show it',
        state.describeSaveState(damaged)?.machines, 1);
}

section('What a state says about itself');
{
    // the save-state browser is drawn from this section; without it an exported state has nothing to recognize it
    // by. See `VesEmulatorSaveStateMeta`
    const thumbnail = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const meta = {
        kind: 'auto',
        created: 1789000000000,
        label: 'Before the boss',
        thumbnail,
        romName: 'Red Alarm (USA).vb',
    };
    const file = await state.wrapSaveState([block(1)], identity, { playing: 'x' }, meta);
    const read = await state.unwrapSaveState(file, 1, identity);
    check('the metadata survives', { ...read.meta, thumbnail: [...read.meta.thumbnail] },
        { ...meta, thumbnail: [...thumbnail] });
    check('and so does everything beside it', JSON.parse(read.esSound), { playing: 'x' });
    check('and the block itself', new Uint8Array(read.states[0])[0], 1);

    const [text, picture] = sections(file);
    check('the picture is stored as it is', [...file.subarray(...picture)], [...thumbnail]);
    check('and not in the text beside it',
        'thumbnail' in JSON.parse(new TextDecoder().decode(file.subarray(...text))), false);

    // what the browser reads a folder with: everything but the machine, with no identity to check against
    const described = state.describeSaveState(file);
    check('a state describes itself without being loaded', described.meta.label, meta.label);
    check('picture and all', [...described.meta.thumbnail], [...thumbnail]);
    check('and says how many machines it holds', described.machines, 1);
    check('a pair says two',
        state.describeSaveState(
            await state.wrapSaveState([block(1), block(2)], identity, {}, meta)).machines, 2);
    check('something that is not a state describes as nothing',
        state.describeSaveState(new Uint8Array(200)), undefined);

    // the one part the user can put anything in, so every field is checked on the way out
    const nonsense = await state.wrapSaveState([block(1)], identity, {}, {
        kind: 'something else',
        created: 'yesterday',
    });
    const readNonsense = (await state.unwrapSaveState(nonsense, 1, identity)).meta;
    check('an unknown kind reads as a state somebody made', readNonsense.kind, 'manual');
    check('a date that is not one reads as no date', readNonsense.created, 0);
    check('and no picture is no picture', readNonsense.thumbnail, undefined);
}

section('Naming a state rewrites only what it says about itself');
{
    const thumbnail = new Uint8Array([9, 8, 7]);
    const file = await state.wrapSaveState([block(4)], identity, { playing: 'y' }, {
        kind: 'auto', created: 5, thumbnail,
    });
    const renamed = state.rewriteSaveStateMeta(file, {
        ...state.describeSaveState(file).meta, kind: 'manual', label: 'A much longer name than before',
    });
    const [, , sound, body] = sections(file);
    const [, , soundAfter, bodyAfter] = sections(renamed);
    check('the body is carried across untouched',
        [...renamed.subarray(...bodyAfter)], [...file.subarray(...body)]);
    check('and the sound', [...renamed.subarray(...soundAfter)], [...file.subarray(...sound)]);
    const read = await state.unwrapSaveState(renamed, 1, identity);
    check('the new name is there', read.meta.label, 'A much longer name than before');
    check('and the new kind', read.meta.kind, 'manual');
    check('the picture is kept', [...read.meta.thumbnail], [...thumbnail]);
    check('and the machine still loads', new Uint8Array(read.states[0])[0], 4);
}

section('What the header refuses');
{
    const single = await state.wrapSaveState([block(1)], identity, {});
    const pair = await state.wrapSaveState([block(1), block(2)], identity, {});

    await rejects('a one-machine file while a pair is running',
        state.unwrapSaveState(single, 2, identity), /single emulator/);
    await rejects('a pair\'s file while one machine is running',
        state.unwrapSaveState(pair, 1, identity), /linked pair of emulators/);
    await rejects('a state belonging to another ROM',
        state.unwrapSaveState(single, 1,
            { romIdentity: new Uint8Array(32).fill(9), romSize: 16 }), /different ROM/);
    await rejects('a truncated file',
        state.unwrapSaveState(new Uint8Array(10), 1, identity), /truncated/);
    await rejects('a file cut short',
        state.unwrapSaveState(single.subarray(0, single.length - 1), 1, identity), /truncated/);
    const padded = new Uint8Array(single.length + 1);
    padded.set(single);
    await rejects('a file with something after it',
        state.unwrapSaveState(padded, 1, identity), /malformed/);

    const wrongMagic = single.slice();
    new DataView(wrongMagic.buffer).setUint32(0, 0xdeadbeef);
    await rejects('something that is not a save state at all',
        state.unwrapSaveState(wrongMagic, 1, identity), /not a save state/);

    const fromTheFuture = single.slice();
    new DataView(fromTheFuture.buffer).setUint32(4, 99);
    await rejects('a version this build does not know',
        state.unwrapSaveState(fromTheFuture, 1, identity), /different emulator version/);
}

section('Only the current layout is read');
{
    // pre-release builds wrote versions 1 to 3 of an earlier layout (blocks after a 48-byte header, from version 2
    // with two length words, uncompressed). Version 3 is refused by number, version 1 shares this layout's number
    // and is refused as its sections cannot add up to the file
    for (const version of [1, 2, 3]) {
        const older = new Uint8Array(48 + (version >= 2 ? 8 : 0) + 64 * 1024);
        const view = new DataView(older.buffer);
        view.setUint32(0, state.STATE_MAGIC);
        view.setUint32(4, version);
        view.setUint32(8, identity.romSize);
        view.setUint32(12, 64 * 1024);
        older.set(identity.romIdentity, 16);
        for (let i = 48; i < older.length; i++) {
            older[i] = (i * 31) & 0xff;
        }
        await rejects(`an earlier version ${version} file`,
            state.unwrapSaveState(older, 1, identity), /different emulator version|truncated|malformed/);
        check(`and an earlier version ${version} file is not described as a state`,
            state.describeSaveState(older), undefined);
    }
}

const BASELINE = state.DEFAULT_SAVE_RAM_SIZE;
const WINDOW = state.SAVE_RAM_WINDOW;

function allZero(bytes, from, to) {
    for (let i = from; i < to; i++) {
        if (bytes[i] !== 0) {
            return false;
        }
    }
    return true;
}

section('Fresh save RAM');
{
    const zeroed = state.freshSaveRam(EmulatorSramInit.ZEROES);
    check('zeroes means zeroes', allZero(zeroed, 0, zeroed.length), true);
    check('and spans the whole of Game Pak RAM', zeroed.length, WINDOW);

    const random = state.freshSaveRam(EmulatorSramInit.RANDOM);
    // only the low byte of each halfword is wired to the chip, so the odd bytes are not storage
    let odd = false, even = false;
    for (let i = 0; i < BASELINE; i++) {
        if (i % 2 === 1 && random[i] !== 0) {
            odd = true;
        }
        if (i % 2 === 0 && random[i] !== 0) {
            even = true;
        }
    }
    check('random leaves the unwired bytes alone', odd, false);
    check('random actually randomises the rest', even, true);
    // the part of the window that is not a chip is not powered up either, which is what saveRamHighWater relies on
    check('random stops at the baseline', allZero(random, BASELINE, WINDOW), true);

    const narrow = state.freshSaveRam(EmulatorSramInit.RANDOM, 8192);
    check('a narrowed window is the size it was asked for', narrow.length, 8192);
}

section('Save file size');
{
    const ram = state.freshSaveRam(EmulatorSramInit.RANDOM);
    check('an untouched cartridge reads as the baseline',
        state.saveRamHighWater(ram), BASELINE);

    ram[BASELINE * 4 + 3] = 0x5a;
    check('a write above the baseline is found exactly',
        state.saveRamHighWater(ram), BASELINE * 4 + 4);
    check('and the file is the next power of two that holds it',
        state.saveRamFileSize(state.saveRamHighWater(ram)), BASELINE * 8);

    // trailing zeroes a game wrote look like ones it never wrote, so cutting at the last non-zero byte is safe
    ram[BASELINE * 4 + 4] = 0;
    check('a written zero does not extend the file',
        state.saveRamHighWater(ram), BASELINE * 4 + 4);

    check('nothing is ever written below the baseline',
        state.saveRamFileSize(1), BASELINE);
    check('and never below a file that is already there',
        state.saveRamFileSize(BASELINE, BASELINE * 16), BASELINE * 16);
    check('a hand-edited file is rounded up rather than handed on',
        state.saveRamFileSize(BASELINE, BASELINE * 3), BASELINE * 4);
    check('and the window is the ceiling',
        state.saveRamFileSize(WINDOW * 2), WINDOW);
}

section('The cartridge save window');
{
    check('by default a cartridge answers on the whole region',
        state.saveRamWindowBytes('auto'), WINDOW);
    check('and on nothing narrower for a value nobody recognises',
        state.saveRamWindowBytes('nonsense'), WINDOW);
    // narrowing brings mirroring back, so these have to be exact
    check('a standard cartridge is the 16 KiB window',
        state.saveRamWindowBytes('16k'), BASELINE);
    check('and the list runs up to 8 MB',
        state.saveRamWindowBytes('8m'), 8 * 1024 * 1024);
    // a narrowed window still comes up the way a chip does at the bottom
    const narrow = state.freshSaveRam(EmulatorSramInit.RANDOM, state.saveRamWindowBytes('16k'));
    check('a narrowed cartridge is the size it says', narrow.length, BASELINE);
    check('and reads as untouched until a game writes to it',
        state.saveRamHighWater(narrow), BASELINE);
}

section('Save file round trip');
{
    // as loading does: the file at the bottom of a fresh window; a trimmed save read back must give the same bytes
    const written = state.freshSaveRam(EmulatorSramInit.RANDOM);
    written[BASELINE] = 0x11;
    written[BASELINE * 2 - 1] = 0x22;
    const file = written.slice(0, state.saveRamFileSize(state.saveRamHighWater(written)));
    check('the file is as small as it can be', file.length, BASELINE * 2);

    const reloaded = state.freshSaveRam(EmulatorSramInit.ZEROES);
    reloaded.set(file);
    check('and gives every byte back',
        reloaded[BASELINE] === 0x11 && reloaded[BASELINE * 2 - 1] === 0x22, true);
    check('with nothing left above it',
        allZero(reloaded, BASELINE * 2, WINDOW), true);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
