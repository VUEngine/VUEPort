/**
 * Whether the live profiler charges every clock to the right place, and what it costs to leave running.
 * profile-probe.mjs covers the replay collector (instructions into a call tree afterwards); this one charges clocks
 * per frame while the game plays, so:
 * 1. Every clock is accounted for exactly once: a frame's rows plus its idle time (halted, or spinning) add up to the
 *    frame.
 * 2. It is cheap enough to leave on. breakpoint-probe.mjs put a bare execute callback at 1.03x and a set lookup at
 *    1.17x; this does more, and what matters is whether the core still outruns the machine.
 * The first half feeds the collector a known instruction stream. The second runs the real core over a real ROM through
 * the worker's wiring, as only the core can say whether reading its countdown word that way works.
 *
 * Usage: node tests/live-profile-probe.mjs (after `yarn build`)
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const vueport = new URL('../', import.meta.url).pathname;
const { VesLiveProfileCollector, VES_LIVE_PROFILE_ROOT } = await import(pathToFileURL(path.join(
    vueport,
    'lib/common/emulator-live-profile.js'
)).href);
const { decodeRomKinds } = await import(pathToFileURL(path.join(
    vueport,
    'lib/common/emulator-profile.js'
)).href);

// VesInstructionKind, which a const enum does not export a runtime copy of
const OTHER = 0;
const CALL = 1;
const RETURN = 2;
const HALT = 3;
const RETI = 4;
const STORE = 5;

let failures = 0;
const check = (label, actual, expected) => {
    const ok = Object.is(actual, expected);
    if (!ok) {
        failures++;
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${actual}, expected ${expected}`}`);
};
const report = (label, value) => console.log(`  --   ${label}: ${value}`);
const rowFor = (snapshot, address) =>
    snapshot.functions.find(row => row.address === address);

console.log('\n1. Charging a known stream');
{
    // main at 0x100 calls a at 0x200, which calls b at 0x300; each instruction costs 10, 20 or 30 by function. Its cost
    // arrives with the next one, as the callback sees it, so a `jal` is charged to the caller and a return to the
    // callee
    const stream = [
        [0x100, OTHER, 0], [0x104, CALL, 10],
        [0x200, OTHER, 10], [0x204, CALL, 20],
        [0x300, OTHER, 20], [0x304, RETURN, 30],
        [0x208, OTHER, 30], [0x20c, RETURN, 20],
        [0x108, OTHER, 20],
    ];
    const collector = new VesLiveProfileCollector(10);
    for (const [address, kind, clocks] of stream) {
        collector.step(address, kind, clocks);
    }
    collector.endFrame(10);
    const snapshot = collector.snapshot(400000);

    const root = rowFor(snapshot, VES_LIVE_PROFILE_ROOT);
    const a = rowFor(snapshot, 0x200);
    const b = rowFor(snapshot, 0x300);

    // main was never called (the collector started inside it), so its three instructions land in the root row: 10+10+10
    check('the frame the collector started in keeps its own time', root.self, 30);
    check('a is charged its own four instructions', a.self, 80);
    check('and b is charged its own two', b.self, 60);
    check('a\'s total covers b as well', a.total, 140);
    check('b\'s total is its own', b.total, 60);
    check('a was entered once', a.calls, 1);
    check('the clocks add up to what was fed in',
        snapshot.functions.reduce((sum, row) => sum + row.self, 0) + snapshot.halted,
        170);
    check('and the frame says the same', snapshot.clocks, 170);
}

console.log('\n2. A function inside itself');
{
    // f at 0x200 calls itself once. Its inclusive time is the outer activation's span only; adding both would report 30
    // clocks of a 20-clock frame
    const collector = new VesLiveProfileCollector(10);
    const stream = [
        [0x100, OTHER, 0], [0x104, CALL, 0],
        [0x200, OTHER, 5], [0x204, CALL, 5],
        [0x200, OTHER, 5], [0x204, OTHER, 5],
        [0x208, RETURN, 5],
        [0x108, OTHER, 5],
    ];
    for (const [address, kind, clocks] of stream) {
        collector.step(address, kind, clocks);
    }
    collector.endFrame(0);
    const snapshot = collector.snapshot(400000);
    const f = rowFor(snapshot, 0x200);
    check('both activations are counted as calls', f.calls, 2);
    check('self time covers every instruction of both', f.self, 25);
    check('inclusive time is the outer span only', f.total, 25);
    check('nothing is counted twice', snapshot.clocks, 30);
}

console.log('\n3. Interrupts, and a processor that is waiting');
{
    // the VIP vector, entered by hardware while the game halts waiting for it: the shape of a VUEngine frame
    const VECTOR = 0xfffffe40;
    const collector = new VesLiveProfileCollector(10);
    const stream = [
        [0x100, OTHER, 0],
        [0x104, HALT, 10],
        // nothing runs for 1000 clocks; the interrupt is what ends the wait
        [VECTOR, OTHER, 1000],
        [VECTOR + 4, CALL, 20],
        [0x500, OTHER, 20], [0x504, RETURN, 40],
        [VECTOR + 8, RETI, 20],
        [0x108, OTHER, 10],
    ];
    for (const [address, kind, clocks] of stream) {
        collector.step(address, kind, clocks);
    }
    collector.endFrame(0);
    const snapshot = collector.snapshot(400000);
    const vector = rowFor(snapshot, VECTOR);
    const handler = rowFor(snapshot, 0x500);
    const root = rowFor(snapshot, VES_LIVE_PROFILE_ROOT);

    check('waiting is charged to the idle total', snapshot.halted, 1000);
    check('and not to the function the halt is in', root.self, 20);
    check('the interrupt gets one frame, not one per instruction of the stub',
        snapshot.functions.filter(row => row.address >= 0xfffffe00
            && row.address < 0xfffffe50).length, 1);
    check('it was entered once', vector.calls, 1);
    check('the stub\'s own instructions are its own', vector.self, 40);
    check('and what it called is inside it', vector.total, 100);
    check('the handler keeps its own time', handler.self, 60);
    check('reti closes the frame, so what follows is outside it', root.self, 20);
    check('every clock is charged exactly once',
        snapshot.functions.reduce((sum, row) => sum + row.self, 0)
            + snapshot.halted + snapshot.waiting,
        snapshot.clocks);
}

console.log('\n4. Minimum, average and peak over a window');
{
    const collector = new VesLiveProfileCollector(3);
    for (const cost of [100, 300, 200, 600]) {
        collector.step(0x100, OTHER, 0);
        collector.step(0x104, CALL, 0);
        collector.step(0x200, OTHER, cost);
        collector.step(0x204, RETURN, 0);
        collector.endFrame(0);
    }
    const snapshot = collector.snapshot(400000);
    const f = rowFor(snapshot, 0x200);
    check('the window holds what it was sized for', snapshot.frames, 3);
    check('and counts every frame it has seen', snapshot.framesSeen, 4);
    check('the latest frame is the latest frame', f.self, 600);
    check('the peak is the peak of the window, not of the run', f.selfPeak, 600);
    check('the average is over the window', Math.round(f.selfAvg), Math.round(1100 / 3));
    check('and the oldest frame has fallen out', f.totalMin, 200);
}

// an average over a hundred frames cannot say one was bad, so frames are also read one
// by one and can be asked about by number. A frame keeps its own figures, and its number still means the same frame
// once the window has moved on

console.log('\n5. The window, frame by frame');
{
    const BUDGET = 400000;
    const IDLE = 50000;
    const collector = new VesLiveProfileCollector(3);
    // four frames into a window of three, each working then halting: the halt is idle time, so busy is the work alone.
    // The last one is over budget, as a bad frame is
    const work = [100000, 300000, 200000, 600000];
    for (const clocks of work) {
        collector.step(0x100, OTHER, 0);
        collector.step(0x104, HALT, clocks);
        collector.step(0x108, OTHER, IDLE);
        collector.endFrame(0);
    }

    const snapshot = collector.snapshot(BUDGET);
    check('there is a bar for each frame of the window', snapshot.frameBusy.length, 3);
    check('oldest first', snapshot.frameBusy[0], work[1]);
    check('newest last', snapshot.frameBusy[2], work[3]);
    check('and a bar is the frame less what it spent waiting',
        snapshot.frameBusy[2], snapshot.clocks - snapshot.halted);
    check('the frame that ran long is over the budget', snapshot.frameBusy[2] > BUDGET, true);

    // numbered from the start of profiling, not of the window, so a pin keeps meaning the same frame
    const pinned = collector.snapshot(BUDGET, 3).pinned;
    check('a frame can be found again by its number', pinned.number, 3);
    check('it keeps its own clocks', pinned.clocks, work[2] + IDLE);
    check('and its own idle time', pinned.halted, IDLE);
    const self = pinned.functions.reduce((sum, row) => sum + row.self, 0);
    check('what its functions were charged is what it was busy for', self, work[2]);
    check('which is the bar the window drew for it', self, snapshot.frameBusy[1]);

    check('a frame that has left the window cannot be pinned',
        collector.snapshot(BUDGET, 1).pinned, undefined);
    check('nor can one that has not happened yet',
        collector.snapshot(BUDGET, 5).pinned, undefined);
}

/**
 * Waiting without halting: most VB games spin rather than halt (VUEngine's frame loop is
 * `while(!VUEngine::hasGameFrameStarted());`), which a processor counts as busy, so the panel would read 100 %. A loop
 * still going round when the interrupt arrives was waiting for it. The two streams below are the same loop; a copy
 * stores on nearly every instruction, a wait does not.
 */

console.log('\n6. A loop that was waiting, and one that was working');
{
    const VECTOR = 0xfffffe40;
    // a function at 0x200 going round its own loop `laps` times, then the interrupt that ends it
    const spin = (kinds, laps) => {
        const collector = new VesLiveProfileCollector(10);
        collector.step(0x100, OTHER, 0);
        collector.step(0x104, CALL, 10);
        for (let lap = 0; lap < laps; lap++) {
            for (let at = 0; at < kinds.length; at++) {
                collector.step(0x200 + at * 2, kinds[at], 10);
            }
        }
        collector.step(VECTOR, OTHER, 10);
        collector.step(VECTOR + 4, RETI, 10);
        collector.step(0x108, OTHER, 10);
        collector.endFrame(0);
        return collector.snapshot(400000);
    };
    const totalSelf = snapshot =>
        snapshot.functions.reduce((sum, row) => sum + row.self, 0);

    const waited = spin([OTHER, OTHER, OTHER], 100);
    check('a loop the interrupt found still running was waiting',
        waited.waiting > 0, true);
    check('and the function it was waiting in is named',
        waited.waitingAt, 0x200);
    check('the clocks are taken out of that function rather than lost',
        totalSelf(waited) + waited.waiting + waited.halted, waited.clocks);
    check('so the waiting is not also charged as work',
        rowFor(waited, 0x200).self < waited.waiting, true);

    const worked = spin([STORE, OTHER, OTHER], 100);
    check('a loop that writes like a copy is work, not waiting', worked.waiting, 0);
    check('so its clocks stay where they were charged',
        rowFor(worked, 0x200).self > worked.clocks * 0.9, true);

    const brief = spin([OTHER, OTHER, OTHER], 4);
    check('and a brief one is not called waiting at all', brief.waiting, 0);

    // a loop the program leaves by itself was never waiting, however quiet: nothing outside it ended it
    const collector = new VesLiveProfileCollector(10);
    collector.step(0x100, OTHER, 0);
    for (let lap = 0; lap < 100; lap++) {
        collector.step(0x200, OTHER, 10);
        collector.step(0x202, OTHER, 10);
        collector.step(0x204, OTHER, 10);
    }
    collector.step(0x900, CALL, 10);
    collector.step(0xa00, OTHER, 10);
    collector.endFrame(0);
    check('a loop that ended by itself is not waiting either',
        collector.snapshot(400000).waiting, 0);
}

console.log('\n7. A machine that restarts');
{
    const collector = new VesLiveProfileCollector(10);
    collector.step(0x100, OTHER, 0);
    collector.step(0x104, CALL, 10);
    collector.step(0x200, OTHER, 10);
    collector.step(0xfffffff0, OTHER, 10);
    collector.step(0x100, OTHER, 10);
    collector.endFrame(0);
    const snapshot = collector.snapshot(400000);
    check('the restart is reported', snapshot.resets, 1);
    // it ran from its entry to the reset, which is one instruction, not the whole frame
    check('the frame that was open was closed rather than dropped',
        rowFor(snapshot, 0x200).total, 10);
    check('and its clocks are still in the frame', snapshot.clocks, 40);
}

// the real core: the clock a live profile is measured on is the countdown word Emulate is given, read from inside
// the callback while the core runs, which cannot be reasoned about

console.log('\n8. Against the core itself');

const TABLE_SLOTS = 16;
const EXECUTE_CALLBACK_ARITY = 4;
const BREAK_FRAME = 1;

function readUleb(bytes, at) {
    let result = 0, shift = 0, length = 0, byte;
    do {
        byte = bytes[at + length];
        result |= (byte & 0x7f) << shift;
        shift += 7;
        length++;
    } while (byte & 0x80);
    return [result, length];
}

// widens the core's function table so a callback has somewhere to live
function patchTableLimit(bytes, slots) {
    let position = 8;
    while (position < bytes.length) {
        const id = bytes[position];
        const [size, sizeLength] = readUleb(bytes, position + 1);
        const start = position + 1 + sizeLength;
        if (id === 4) {
            let at = start;
            const [, countLength] = readUleb(bytes, at);
            at += countLength;
            at++;
            const flag = bytes[at];
            at++;
            bytes[at] = slots;
            if (flag === 1) {
                bytes[at + 1] = slots;
            }
            return bytes;
        }
        position = start + size;
    }
    throw new Error('No table section found');
}

function uleb(value) {
    const out = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) {
            byte |= 0x80;
        }
        out.push(byte);
    } while (value !== 0);
    return out;
}

const section = (id, payload) => [id, ...uleb(payload.length), ...payload];
const vec = items => [...uleb(items.length), ...items.flat()];

function makeTrampoline(onCall, arity = EXECUTE_CALLBACK_ARITY) {
    const I32 = 0x7f;
    const type = [0x60, ...vec(Array.from({ length: arity }, () => [I32])), ...vec([[I32]])];
    const body = [];
    for (let i = 0; i < arity; i++) {
        body.push(0x20, ...uleb(i));
    }
    body.push(0x10, 0x00, 0x0b);
    const bytes = Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        ...section(1, vec([type])),
        ...section(2, vec([[0x01, 0x65, 0x01, 0x66, 0x00, 0x00]])),
        ...section(3, vec([[0x00]])),
        ...section(7, vec([[0x01, 0x74, 0x00, 0x01]])),
        ...section(10, vec([[...uleb(body.length + 1), 0x00, ...body]])),
    ]);
    return new WebAssembly.Instance(
        new WebAssembly.Module(bytes), { e: { f: onCall } }
    ).exports.t;
}

/**
 * main calls work once per lap; work is six movea and a return. It sits in the last 0x40 bytes of the ROM and runs
 * through the top mirror with the cache off; nothing touches hardware, so the rate is steady. work has six instructions
 * because an uncached jump costs a target refetch on the measured core and main has two jumps to work's one: with three,
 * main's own clocks outweighed work's.
 */

const ROM_SIZE = 0x100000;
const PROGRAM = 0xffffffc0;
const at = {};

function buildRom() {
    const rom = new Uint8Array(ROM_SIZE);
    const view = new DataView(rom.buffer);
    let cursor = ROM_SIZE - 0x40;
    const mark = name => { at[name] = (PROGRAM + (cursor - (ROM_SIZE - 0x40))) >>> 0; };
    const half = value => {
        view.setUint16(cursor, value & 0xffff, true);
        cursor += 2;
    };
    const movea = (imm, source, destination) => {
        half((0x28 << 10) | (destination << 5) | source);
        half(imm);
    };
    // format IV: a 26-bit displacement across both halfwords
    const jump = (opcode, from, to) => {
        const displacement = (to - from) | 0;
        half((opcode << 10) | ((displacement >> 16) & 0x3ff));
        half(displacement & 0xffff);
    };

    mark('main');
    // filled in once `work` has an address
    const jalAt = cursor;
    cursor += 4;
    mark('spin');
    movea(0x0001, 0, 14);
    mark('branch');
    half(0x8a00 | ((at.main - (PROGRAM + (cursor - (ROM_SIZE - 0x40)))) & 0x1ff));

    cursor += 2; // keep `work` four-byte aligned
    mark('work');
    movea(0x0001, 0, 10);
    movea(0x0002, 0, 11);
    movea(0x0003, 0, 12);
    movea(0x0004, 0, 13);
    movea(0x0005, 0, 15);
    movea(0x0006, 0, 16);
    mark('return');
    half((0x06 << 10) | 31); // jmp [r31]

    cursor = jalAt;
    jump(0x2b, at.main, at.work);

    cursor = ROM_SIZE - 0x10;
    jump(0x2a, PROGRAM + 0x30, at.main); // jr main, from the reset vector
    return rom;
}

const ROM = buildRom();
const KINDS = decodeRomKinds(ROM);

const corePath = new URL('../wasm/shrooms/core.wasm', import.meta.url);
const coreBytes = patchTableLimit(fs.readFileSync(corePath), TABLE_SLOTS);
const { instance } = await WebAssembly.instantiate(coreBytes, {
    env: { emscripten_notify_memory_growth: () => { } }
});
const E = instance.exports;
E._initialize();

function newSim() {
    const romPointer = E.Realloc(0, ROM.length);
    new Uint8Array(E.memory.buffer, romPointer, ROM.length).set(ROM);
    const sim = E.Realloc(0, E.vbSizeOf());
    E.vbInit(sim);
    E.vbSetCartROM(sim, romPointer, ROM.length);
    E.vbReset(sim);
    return sim;
}

{
    const sim = newSim();
    const box = { instance: new VesLiveProfileCollector(100), left: 0 };
    const mask = ROM_SIZE - 1;
    let clocksView;
    const slot = 1;
    E.__indirect_function_table.set(slot, makeTrampoline((unused, address) => {
        const remaining = clocksView[0];
        const spent = box.left - remaining;
        box.left = remaining;
        const pc = address >>> 0;
        box.instance.step(pc, KINDS[(pc & mask) >> 1], spent);
        return 0;
    }));

    // the view the callback reads; `run` writes the budget through its own, over the same word
    const sims = E.Realloc(0, 4);
    const clocksBox = E.Realloc(0, 4);
    clocksView = new Uint32Array(E.memory.buffer, clocksBox, 1);
    new Uint32Array(E.memory.buffer, sims, 1)[0] = sim;
    E.vbSetExecuteCallback(sim, slot);

    // four chunks driven as emulateChunk drives them: a frame's clocks each, drained by repeated Emulate calls, a frame
    // closed wherever the core reports one. This program never switches the display on, so the core never reports a VIP
    // frame, which exercises the worker's end-of-chunk fallback
    const CLOCKS_PER_FRAME = 400000;
    let frames = 0;
    let reported = 0;
    const closeFrame = () => {
        const remaining = clocksView[0];
        box.instance.endFrame(box.left - remaining);
        box.left = remaining;
        frames++;
    };
    for (let chunk = 0; chunk < 4; chunk++) {
        clocksView[0] = CLOCKS_PER_FRAME;
        box.left = CLOCKS_PER_FRAME;
        let framed = false;
        while (clocksView[0] !== 0) {
            E.Emulate(sims, 1, clocksBox);
            if (E.GetBreaks(sim) & BREAK_FRAME) {
                closeFrame();
                framed = true;
                reported++;
            }
        }
        if (!framed) {
            closeFrame();
        }
    }
    E.vbSetExecuteCallback(sim, 0);

    const snapshot = box.instance.snapshot(CLOCKS_PER_FRAME);
    const work = rowFor(snapshot, at.work);
    const root = rowFor(snapshot, VES_LIVE_PROFILE_ROOT);
    report('frames closed', frames);
    report('of those, reported by the core', reported);
    report('clocks in the last frame', snapshot.clocks);
    report('instructions in the last frame', snapshot.instructions);
    report('work() calls in the last frame', work?.calls ?? 0);
    report('work() clocks in the last frame', work?.self ?? 0);
    report('main\'s own clocks (the root frame)', root?.self ?? 0);

    check('a frame was closed', frames > 0, true);
    check('the called function was found', work !== undefined, true);
    check('it was entered once per lap of the loop',
        work.calls > 1000, true);
    check('its inclusive time is its own, since it calls nothing',
        work.total, work.self);
    // nothing charged twice, nothing dropped. A frame is bounded by the interrupt rather than the budget, so the count
    // is compared against the frame the core reported
    const accounted = snapshot.functions.reduce((sum, row) => sum + row.self, 0)
        + snapshot.halted + snapshot.waiting;
    check('every clock of the frame is charged exactly once',
        accounted, snapshot.clocks);
    check('and a frame is about a frame long',
        Math.abs(snapshot.clocks - CLOCKS_PER_FRAME) < CLOCKS_PER_FRAME * 0.02, true);
    check('the loop spends more time in work() than outside it',
        work.self > root.self, true);
}

console.log('\n9. Cost');
{
    const CLOCKS = 20000000; // one second of Virtual Boy
    const bare = newSim();
    const sims = E.Realloc(0, 4);
    const box = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, sims, 1)[0] = bare;

    const spin = () => {
        const clocks = new Uint32Array(E.memory.buffer, box, 1);
        clocks[0] = CLOCKS;
        while (clocks[0] !== 0) {
            E.Emulate(sims, 1, box);
        }
    };

    let started = Date.now();
    spin();
    const withoutMs = Date.now() - started;

    const collector = new VesLiveProfileCollector(100);
    const mask = ROM_SIZE - 1;
    let left = 0;
    const clocksView = new Uint32Array(E.memory.buffer, box, 1);
    E.__indirect_function_table.set(2, makeTrampoline((unused, address) => {
        const remaining = clocksView[0];
        const spent = left - remaining;
        left = remaining;
        const pc = address >>> 0;
        collector.step(pc, KINDS[(pc & mask) >> 1], spent);
        return 0;
    }));
    E.vbSetExecuteCallback(bare, 2);
    started = Date.now();
    clocksView[0] = CLOCKS;
    left = CLOCKS;
    while (clocksView[0] !== 0) {
        E.Emulate(sims, 1, box);
    }
    const withMs = Date.now() - started;
    E.vbSetExecuteCallback(bare, 0);

    report('one emulated second, no profiler', `${withoutMs} ms`);
    report('one emulated second, profiled   ', `${withMs} ms`);
    report('slowdown', `${(withMs / withoutMs).toFixed(2)}x`);
    report('speed against the real machine', `${(1000 / withMs).toFixed(2)}x real time`);
    check('the core still outruns the machine it emulates', withMs < 1000, true);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
