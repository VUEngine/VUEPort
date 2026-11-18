/**
 * Probes what an execute callback (vbSetExecuteCallback) gives and costs for breakpoints, stepping and a call stack, as
 * neither it nor GetBreaks has a documented ABI or cost. It answers:
 * 1. Does it fire on every instruction?
 * 2. Can it stop the run, and does GetBreaks then report BREAK_POINT (2)? If not, the drive loop stops itself.
 * 3. What does it cost per instruction? If too much, breakpoints go to a sorted address set in the drive loop.
 * Also pins vbGetProgramCounter while stopped and vbSetProgramCounter to resume elsewhere.
 * Usage: node tests/breakpoint-probe.mjs
 */
import fs from 'fs';

const TERMINAL_PORT = 0x02000030;
const TERMINAL_BYTE = 0x41;
const TABLE_SLOTS = 16;

// GetBreaks bits, from the core's own Constants.js
const BREAK_FRAME = 1;
const BREAK_POINT = 2;

const corePath = new URL(
    '../wasm/shrooms/core.wasm',
    import.meta.url
);

let failures = 0;

function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${actual}, expected ${expected}`);
        return false;
    }
    console.log(`  ok   ${label}`);
    return true;
}

function report(label, value) {
    console.log(`  --   ${label}: ${value}`);
}

// patching the table (see write-callback-probe.mjs)

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

function patchTableLimit(bytes, slots) {
    let position = 8;
    while (position < bytes.length) {
        const id = bytes[position];
        const [size, sizeLength] = readUleb(bytes, position + 1);
        const start = position + 1 + sizeLength;
        if (id === 4) {
            let at = start;
            const [count, countLength] = readUleb(bytes, at);
            at += countLength;
            at++; // reftype
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

const coreBytes = patchTableLimit(fs.readFileSync(corePath), TABLE_SLOTS);

// the trampoline. The write callback is (i32 x6) -> i32 (installVbCallback in vb-wasm.ts), the execute
// callback (i32 x4) -> i32; the wrong one fails with "null function or function signature mismatch" as soon
// as the core calls it, so installVbCallback must take the arity rather than assume it

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

const EXECUTE_CALLBACK_ARITY = 4;

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
        new WebAssembly.Module(bytes),
        { e: { f: onCall } }
    ).exports.t;
}

// a four-instruction loop so the number of instructions run is known exactly: LOOP (0xFFFFFFC0) writes 0x41 to the
// terminal port, SPIN is a movea marker (the breakpoint target) plus `br SPIN`, and reset jumps to LOOP
const ROM_SIZE = 0x100000;
// where the ROM's last 0x40 bytes run from: the cartridge is mirrored across the top of the address space and
// reset is 0xFFFFFFF0, so the reported PC is always in this mirror. DWARF addresses (0x07000000 view) must be
// masked down to the ROM offset to compare
const PROGRAM = 0xFFFFFFC0;
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
    const movhi = (imm, source, destination) => { half((0x2f << 10) | (destination << 5) | source); half(imm); };
    const movea = (imm, source, destination) => { half((0x28 << 10) | (destination << 5) | source); half(imm); };
    const stb = (source, disp, base) => { half((0x34 << 10) | (source << 5) | base); half(disp); };

    mark('start');
    movhi(0x0200, 0, 10);
    mark('movea1');
    movea(TERMINAL_BYTE, 0, 13);
    mark('store');
    stb(13, TERMINAL_PORT & 0xffff, 10);
    mark('spin');
    movea(0x0001, 0, 14);
    mark('branch');
    // format III: 100 in the top three bits, condition 5 (unconditional BR), then a signed nine-bit byte
    // displacement back to `spin`, so the loop is exactly two instructions
    half(0x8a00 | ((at.spin - at.branch) & 0x1ff));

    cursor = ROM_SIZE - 0x10;
    const toStart = (at.start - (PROGRAM + 0x30)) | 0;
    half((0x2a << 10) | ((toStart >> 16) & 0x3ff));
    half(toStart & 0xffff);
    return rom;
}

const ROM = buildRom();

const { instance } = await WebAssembly.instantiate(coreBytes, {
    env: { emscripten_notify_memory_growth: () => { } }
});
const E = instance.exports;
E._initialize();

function newSim() {
    const romPtr = E.Realloc(0, ROM.length);
    new Uint8Array(E.memory.buffer, romPtr, ROM.length).set(ROM);
    const sim = E.Realloc(0, E.vbSizeOf());
    E.vbInit(sim);
    E.vbSetCartROM(sim, romPtr, ROM.length);
    E.vbReset(sim);
    return sim;
}

function emulate(sim, clocks) {
    const sims = E.Realloc(0, 4);
    const clockBox = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, sims, 1)[0] = sim;
    new Uint32Array(E.memory.buffer, clockBox, 1)[0] = clocks;
    E.Emulate(sims, 1, clockBox);
    const breaks = E.GetBreaks(sim);
    E.Realloc(sims, 0);
    E.Realloc(clockBox, 0);
    return breaks;
}

console.log('Program layout:');
for (const [name, address] of Object.entries(at)) {
    console.log(`  --   ${name}: 0x${(address >>> 0).toString(16).toUpperCase()}`);
}

// instructions per clock of the test loop, measured, as the core's timing changes with rebuilds. The checks
// are that the callback fires once per instruction and skips nothing: a proportion, not a number
let instructionsPerClock = 0;

console.log('\n1. Execute callback firing');
{
    const sim = newSim();
    const seen = [];
    let calls = 0;
    const slot = 1;
    const extras = [];
    instance.exports.__indirect_function_table.set(slot, makeTrampoline((s, address, third, fourth) => {
        calls++;
        if (seen.length < 12) {
            seen.push(address >>> 0);
            extras.push(fourth);
        }
        return 0;
    }));
    E.vbSetExecuteCallback(sim, slot);
    check('vbGetExecuteCallback reports the slot', E.vbGetExecuteCallback(sim), slot);

    emulate(sim, 200);
    report('calls in 200 clocks', calls);
    instructionsPerClock = calls / 200;
    report('first addresses', seen.map(a => '0x' + a.toString(16).toUpperCase()).join(' '));
    report('fourth argument at each', extras.join(' '));

    const hitStart = seen.includes(at.start);
    const hitSpin = seen.includes(at.spin);
    check('fires at the first instruction', hitStart, true);
    check('fires at the loop body', hitSpin, true);
    // every instruction or only some? The loop is two instructions, so a per-instruction callback sees both
    const branchSeen = seen.filter(a => a === at.branch).length;
    const spinSeen = seen.filter(a => a === at.spin).length;
    report('spin vs branch sightings', `${spinSeen} / ${branchSeen}`);
    check('sees both instructions of the loop', branchSeen > 0 && spinSeen > 0, true);
}

console.log('\n2. Stopping from the callback');
{
    const results = {};
    for (const returned of [0, 1, 2]) {
        const sim = newSim();
        let calls = 0;
        let hit = false;
        const slot = 2;
        instance.exports.__indirect_function_table.set(slot, makeTrampoline((s, address) => {
            calls++;
            if ((address >>> 0) === at.spin) {
                hit = true;
                return returned;
            }
            return 0;
        }));
        E.vbSetExecuteCallback(sim, slot);

        const breaks = emulate(sim, 2000);
        results[returned] = { calls, breaks, pc: E.vbGetProgramCounter(sim) >>> 0, hit };
        report(
            `return ${returned}`,
            `calls=${calls} breaks=${breaks} pc=0x${results[returned].pc.toString(16).toUpperCase()} hit=${hit}`
        );
    }

    check('returning 0 runs the clocks out',
        results[0].calls, Math.round(2000 * instructionsPerClock));
    // five calls: the reset jump, three setup instructions, then the target, which is reported and not executed
    check('returning non-zero stops the run', results[1].calls, 5);
    check('the stop is immediate, not deferred', results[2].calls, 5);
    check('stops before executing, pc left on the target', results[1].pc, at.spin);

    // unlike the plan assumed, a break raised this way sets neither BREAK_FRAME nor BREAK_POINT in GetBreaks:
    // the non-zero return is the only signal, so the adapter records the stop itself
    check('GetBreaks does not report the break', results[1].breaks & BREAK_POINT, 0);
}

console.log('\n3. Program counter');
{
    const sim = newSim();
    E.vbSetExecuteCallback(sim, 0);
    emulate(sim, 100);
    const before = E.vbGetProgramCounter(sim) >>> 0;
    report('pc after 100 clocks', '0x' + before.toString(16).toUpperCase());
    check('pc is inside the program', before >= at.start && before <= at.branch, true);

    E.vbSetProgramCounter(sim, at.start);
    check('pc reads back what was set', E.vbGetProgramCounter(sim) >>> 0, at.start);

    E.vbSetProgramRegister(sim, 5, 0x12345678);
    check('program register round-trips', E.vbGetProgramRegister(sim, 5) >>> 0, 0x12345678);
}

console.log('\n4. Cost per instruction');
{
    const CLOCKS = 20_000_000;
    const time = (label, install) => {
        const sim = newSim();
        install(sim);
        const started = process.hrtime.bigint();
        emulate(sim, CLOCKS);
        const ns = Number(process.hrtime.bigint() - started);
        report(label, `${(ns / 1e6).toFixed(1)} ms for ${CLOCKS.toLocaleString()} clocks`);
        return ns;
    };

    const bare = time('no callback', sim => E.vbSetExecuteCallback(sim, 0));

    let counted = 0;
    const slot = 3;
    instance.exports.__indirect_function_table.set(slot, makeTrampoline(() => {
        counted++;
        return 0;
    }));
    const withCallback = time('counting callback', sim => E.vbSetExecuteCallback(sim, slot));
    report('instructions counted', counted.toLocaleString());
    report('slowdown', `${(withCallback / bare).toFixed(2)}x`);
    report(
        'per-instruction cost',
        counted > 0 ? `${((withCallback - bare) / counted).toFixed(1)} ns` : 'n/a'
    );
    check('every instruction is reported once',
        counted, Math.round(CLOCKS * instructionsPerClock));

    const breakpoints = new Set([at.spin, at.store, 0xdeadbeef]);
    let hits = 0;
    const slot2 = 4;
    instance.exports.__indirect_function_table.set(slot2, makeTrampoline((s, address) => {
        if (breakpoints.has(address >>> 0)) {
            hits++;
        }
        return 0;
    }));
    const withSet = time('callback + Set lookup', sim => E.vbSetExecuteCallback(sim, slot2));
    report('breakpoint hits', hits.toLocaleString());
    report('slowdown vs bare', `${(withSet / bare).toFixed(2)}x`);

    // 20,000,000 clocks is a second of Virtual Boy time; a breakpoint check on every instruction must stay well
    // inside that, or the drive-loop fallback is needed. Generous bound, as this is timing on a shared machine
    check('breakpoint checking stays faster than real time', withSet < 1e9, true);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
