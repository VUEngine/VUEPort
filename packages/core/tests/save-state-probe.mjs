// Checks the save state container: that a state round trips, that a file made
// by a linked pair and one made by a single machine are told apart, that the
// header refuses a state belonging to another ROM, and that version 1 files —
// written before the ESSound section existed — are still read.
//
// The format has to stay readable across versions of the emulator, which is
// what makes it worth testing directly rather than through the widget. The
// implementation under test is the shipped
// lib/emulator/common/emulator-save-state.js, so this exercises the real one.
//
// Usage: node tests/save-state-probe.mjs
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

function rejects(label, fn, pattern) {
    try {
        fn();
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

/** A ROM to stamp states with, and a block of machine state to put in them. */
const identity = { romIdentity: new Uint8Array(32).fill(7), romSize: 16 };
const block = value => new Uint8Array(64).fill(value).buffer;

section('Round trip');
{
    const file = state.wrapSaveState([block(1)], identity, { playing: 'x' });
    const read = state.unwrapSaveState(file, 1, identity);
    check('one machine, one block', read.states.length, 1);
    check('the block survives', new Uint8Array(read.states[0]).every(v => v === 1), true);
    check('the ESSound section survives', JSON.parse(read.esSound), { playing: 'x' });

    const pair = state.wrapSaveState([block(1), block(2)], identity, {});
    const readPair = state.unwrapSaveState(pair, 2, identity);
    check('a linked pair keeps both blocks', readPair.states.length, 2);
    check('and keeps them in order', new Uint8Array(readPair.states[1])[0], 2);
}

section('What the header refuses');
{
    const single = state.wrapSaveState([block(1)], identity, {});
    const pair = state.wrapSaveState([block(1), block(2)], identity, {});

    rejects('a one-machine file while a pair is running',
        () => state.unwrapSaveState(single, 2, identity), /single emulator/);
    rejects('a pair\'s file while one machine is running',
        () => state.unwrapSaveState(pair, 1, identity), /linked pair of emulators/);
    rejects('a state belonging to another ROM',
        () => state.unwrapSaveState(single, 1,
            { romIdentity: new Uint8Array(32).fill(9), romSize: 16 }), /different ROM/);
    rejects('a truncated file',
        () => state.unwrapSaveState(new Uint8Array(10), 1, identity), /truncated/);

    const wrongMagic = single.slice();
    new DataView(wrongMagic.buffer).setUint32(0, 0xdeadbeef);
    rejects('something that is not a save state at all',
        () => state.unwrapSaveState(wrongMagic, 1, identity), /not a save state/);

    const fromTheFuture = single.slice();
    new DataView(fromTheFuture.buffer).setUint32(4, 99);
    rejects('a version this build does not know',
        () => state.unwrapSaveState(fromTheFuture, 1, identity), /different version/);
}

section('Version 1 files still read');
{
    // Built by hand from the format rather than by the writer, which can only
    // produce the current version: no ESSound section, and no word saying how
    // long one is.
    const size = 64;
    const start = state.STATE_HEADER_BYTES;
    const file = new Uint8Array(start + size);
    const header = new DataView(file.buffer);
    header.setUint32(0, state.STATE_MAGIC);
    header.setUint32(4, 1);
    header.setUint32(8, identity.romSize);
    header.setUint32(12, size);
    file.set(identity.romIdentity, 16);
    file.fill(3, start);

    const read = state.unwrapSaveState(file, 1, identity);
    check('the machine state is recovered', read.states.length, 1);
    check('and it restores no audio', read.esSound, undefined);
}

section('Fresh save RAM');
{
    const zeroed = state.freshSaveRam(EmulatorSramInit.ZEROES);
    check('zeroes means zeroes', zeroed.every(v => v === 0), true);
    check('and spans the cartridge window', zeroed.length, state.DEFAULT_SAVE_RAM_SIZE);

    const random = state.freshSaveRam(EmulatorSramInit.RANDOM);
    // Only the low byte of each halfword is wired to the chip, so the odd
    // bytes are not storage and are left alone.
    check('random leaves the unwired bytes alone',
        random.filter((v, i) => i % 2 === 1).every(v => v === 0), true);
    check('random actually randomises the rest',
        random.filter((v, i) => i % 2 === 0).some(v => v !== 0), true);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
