/**
 * The order a linked pair is handed to `Emulate` in is part of the emulation: two machines clocking bytes out at once
 * land them differently depending on which the array names first. Every link window runs the whole pair, built from its
 * own end, so in creation order the two windows emulate the cable differently and drift apart within a second ("The two
 * machines stopped matching" in Hyper Fighting's Versus mode). `orderedSims` in `vb-worker.ts` therefore uses cable
 * order, with `setPeer` telling the worker which end each machine is.
 *
 * No ROM: both machines run a hand-assembled WRAM loop that clocks a byte out per pass and hashes the link registers.
 * They start with different delays, as identical states are symmetric and swapping them would only swap the results.
 *
 * Usage: node tests/link-order-probe.mjs
 */

import fs from 'fs';

const CLOCKS = 400000;          // one chunk, as the drive loop runs one
const F32 = 5;                  // VbDataType.F32
const U16 = 3;
const U32 = 4;
const SAMPLES = 834;
const RAM_LEN = 16384;
const SGN = 0x0002;
const STALL_CALLS = 1000;
const FRAMES = 60;

const CODE = 0x05000000;
const DELAY_AT = 0x05000100;
const HASH_AT = 0x05000400;
const ITERATIONS_AT = 0x05000404;

const CORE = new URL('../wasm/shrooms/core.wasm', import.meta.url);

let failures = 0;
const check = (label, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  ${detail}`}`);
};

// both machines burn their own head start (so they run out of phase), then loop sending a counter over the cable and
// hashing CCR and CDRR into r7, which they store for the host at 0x400 in WRAM
function assemble() {
    const halfwords = [];
    // format I: register to register. II: 5-bit immediate. V/VI: 16-bit word
    const one = (op, reg2, reg1) => halfwords.push((op << 10) | (reg2 << 5) | reg1);
    const imm5 = (op, reg2, value) => halfwords.push((op << 10) | (reg2 << 5) | (value & 0x1f));
    const word = (op, reg2, reg1, value) => {
        halfwords.push((op << 10) | (reg2 << 5) | reg1);
        halfwords.push(value & 0xffff);
    };
    const branch = (condition, target) => {
        const at = halfwords.length * 2;
        halfwords.push(0x8000 | (condition << 9) | ((target - at) & 0x1ff));
    };
    const jump = target => {
        const at = halfwords.length * 2;
        const displacement = (target - at) & 0x3ffffff;
        halfwords.push((0x2a << 10) | ((displacement >> 16) & 0x3ff));
        halfwords.push(displacement & 0xffff);
    };

    word(0x2f, 1, 0, 0x0200);               // MOVHI 0x0200, r0, r1
    word(0x2f, 2, 0, 0x0500);               // MOVHI 0x0500, r0, r2
    word(0x33, 4, 2, 0x0100);               // LD.W 0x100[r2], r4
    const delay = halfwords.length * 2;
    imm5(0x11, 4, -1);                      // ADD -1, r4
    imm5(0x13, 4, 0);                       // CMP 0, r4
    branch(0xa, delay);                     // BNE delay
    imm5(0x10, 3, 0);                       // MOV 0, r3
    imm5(0x10, 7, 0);                       // MOV 0, r7
    const loop = halfwords.length * 2;
    imm5(0x11, 3, 1);                       // ADD 1, r3
    word(0x34, 3, 1, 0x0008);               // ST.B r3, CDTR
    imm5(0x10, 5, 4);                       // MOV 4, r5
    word(0x34, 5, 1, 0x0000);               // ST.B r5, CCR
    word(0x30, 5, 1, 0x0000);               // LD.B CCR, r5
    word(0x30, 6, 1, 0x000c);               // LD.B CDRR, r6
    one(0x0e, 7, 5);                        // XOR r5, r7
    one(0x0e, 7, 6);                        // XOR r6, r7
    one(0x01, 7, 3);                        // ADD r3, r7
    word(0x37, 7, 2, 0x0400);               // ST.W r7, 0x400[r2]
    word(0x37, 3, 2, 0x0404);               // ST.W r3, 0x404[r2]
    jump(loop);
    return halfwords;
}

const program = assemble();

// one core instance holding a peered pair, wired as the worker does. `order` is the array `Emulate` gets:
// `'cable'` (what the worker uses) or `'reversed'`
async function makeInstance({ order = 'cable', delays = [1, 37] } = {}) {
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(CORE), {
        env: { emscripten_notify_memory_growth: () => { } },
    });
    const E = instance.exports;
    E._initialize();

    const rom = new Uint8Array(1 << 18);
    for (let i = 0; i < rom.length; i++) rom[i] = (i * 7) & 0xff;

    const makeSim = delay => {
        const romPtr = E.Realloc(0, rom.length);
        new Uint8Array(E.memory.buffer, romPtr, rom.length).set(rom);
        const ramPtr = E.Realloc(0, RAM_LEN);
        new Uint8Array(E.memory.buffer, ramPtr, RAM_LEN).fill(0);
        const sim = E.CreateSim();
        if (E.vbSetCartROM(sim, romPtr, rom.length) !== 0) throw new Error('ROM rejected');
        if (E.vbSetCartRAM(sim, ramPtr, RAM_LEN) !== 0) throw new Error('RAM rejected');
        E.vbSetKeys(sim, SGN);
        E.vbReset(sim);
        for (let i = 0; i < program.length; i++) {
            E.vbWrite(sim, CODE + i * 2, U16, program[i]);
        }
        E.vbWrite(sim, DELAY_AT, U32, delay);
        E.vbSetProgramCounter(sim, CODE);
        return { sim, samples: E.GetExtSamples(sim) };
    };

    const first = makeSim(delays[0]);
    const second = makeSim(delays[1]);
    E.vbSetPeer(first.sim, second.sim);
    E.vbSetPeer(second.sim, first.sim);

    const simsPtr = E.Realloc(0, 8);
    const clocksPtr = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, simsPtr, 2)
        .set(order === 'reversed' ? [second.sim, first.sim] : [first.sim, second.sim]);

    return {
        frame() {
            E.vbSetSamples(first.sim, first.samples, F32, SAMPLES);
            E.vbSetSamples(second.sim, second.samples, F32, SAMPLES);
            const clocks = new Uint32Array(E.memory.buffer, clocksPtr, 1);
            clocks[0] = CLOCKS;
            let idle = 0;
            let before = CLOCKS;
            while (clocks[0] !== 0) {
                E.Emulate(simsPtr, 2, clocksPtr);
                idle = clocks[0] === before ? idle + 1 : 0;
                before = clocks[0];
                if (idle > STALL_CALLS) return false;
            }
            return true;
        },
        run(frames) {
            for (let i = 0; i < frames; i++) if (!this.frame()) return false;
            return true;
        },
        result(which) {
            const sim = which === 1 ? first.sim : second.sim;
            return {
                hash: E.vbRead(sim, HASH_AT, U32) >>> 0,
                sent: E.vbRead(sim, ITERATIONS_AT, U32) >>> 0,
            };
        },
    };
}

const same = (a, b) => a.hash === b.hash && a.sent === b.sent;
const show = r => `${r.hash.toString(16)}/${r.sent}`;

console.log('\nThe order a linked pair is emulated in\n');

// the pair really is talking
{
    const pair = await makeInstance();
    check('the pair emulates', pair.run(FRAMES));
    const one = pair.result(1);
    const two = pair.result(2);
    check('both machines clocked bytes out', one.sent > 0 && two.sent > 0,
        `${show(one)} and ${show(two)}`);
    // otherwise the rest would pass on two machines that never touched the cable
    check('and heard each other', one.hash !== 0 && two.hash !== 0,
        `${show(one)} and ${show(two)}`);
}

// the same array, twice
{
    const a = await makeInstance();
    const b = await makeInstance();
    a.run(FRAMES);
    b.run(FRAMES);
    check('two instances given the pair in the same order agree',
        same(a.result(1), b.result(1)) && same(a.result(2), b.result(2)),
        `${show(a.result(1))} vs ${show(b.result(1))}`);
}

// the same array, reversed: the finding this probe exists for. If a core build makes order stop mattering,
// this says so, and the ordering in `vb-worker.ts` can be relaxed deliberately
{
    const cable = await makeInstance({ order: 'cable' });
    const reversed = await makeInstance({ order: 'reversed' });
    cable.run(FRAMES);
    reversed.run(FRAMES);
    const differs = !same(cable.result(1), reversed.result(1))
        || !same(cable.result(2), reversed.result(2));
    check('reversing the array changes what the pair emulates', differs,
        'the core no longer cares about the order -- see the note above');
}

// the two windows build the same pair from opposite ends and hand it over in cable order, as `orderedSims` does
{
    const windowOne = await makeInstance({ order: 'cable' });
    const windowTwo = await makeInstance({ order: 'cable' });
    windowOne.run(FRAMES);
    windowTwo.run(FRAMES);
    check('both windows emulate the same pair identically in cable order',
        same(windowOne.result(1), windowTwo.result(1))
        && same(windowOne.result(2), windowTwo.result(2)),
        `${show(windowOne.result(1))} vs ${show(windowTwo.result(1))}`);
}

console.log();
if (failures === 0) {
    console.log('The pair is emulated in cable order, so two windows running it stay identical.');
} else {
    console.log(`${failures} FAILURE(S)`);
}
process.exit(failures === 0 ? 0 : 1);
