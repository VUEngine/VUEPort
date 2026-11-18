/**
 * Establishes the ABI of the core's read callback (vbSetReadCallback), which the SRAM panel needs to show reads as well
 * as writes. Four things are checked:
 * 1. The signature: reads take five arguments where writes take six. A trampoline of the wrong shape is no type error
 *    anywhere; it traps the first time the core calls it, which makes the sweep conclusive.
 * 2. Whether the value is available. A callback firing before the read could not say what came back.
 * 3. Whether instruction fetches come through it (there is a separate vbSetFetchCallback). Firing on every fetch would
 *    be one JS call per instruction.
 * 4. That returning zero lets the access proceed, so a reader does not change what the game sees.
 * The accesses come from a hand-assembled V810 program storing to and loading from Game Pak RAM, the path a saving game
 * takes.
 * Usage: node tests/read-callback-probe.mjs
 */
import fs from 'fs';

const CART_RAM_BASE = 0x06000000;
const MARKER = 0x5a;
const TABLE_SLOTS = 16;

const corePath = new URL('../wasm/shrooms/core.wasm', import.meta.url);

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
            if (count !== 1) { throw new Error(`Expected one table, found ${count}`); }
            at++;
            const flag = bytes[at];
            at++;
            const [, minLength] = readUleb(bytes, at);
            if (slots > 0x7f || minLength !== 1) {
                throw new Error('Table limits are not single-byte, cannot patch in place');
            }
            bytes[at] = slots;
            if (flag === 1) { bytes[at + 1] = slots; }
            return bytes;
        }
        position = start + size;
    }
    throw new Error('No table section found');
}

const coreBytes = patchTableLimit(fs.readFileSync(corePath), TABLE_SLOTS);

function uleb(value) {
    const out = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) { byte |= 0x80; }
        out.push(byte);
    } while (value !== 0);
    return out;
}

const section = (id, payload) => [id, ...uleb(payload.length), ...payload];
const vec = items => [...uleb(items.length), ...items.flat()];

function makeTrampoline(arity, returnsValue, onCall) {
    const I32 = 0x7f;
    const type = [
        0x60,
        ...vec(Array.from({ length: arity }, () => [I32])),
        ...vec(returnsValue ? [[I32]] : []),
    ];
    const body = [];
    for (let i = 0; i < arity; i++) { body.push(0x20, ...uleb(i)); }
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
 * A 1 MB cartridge whose reset vector writes one byte of Game Pak RAM, reads back another and spins. The V810 resets to
 * 0xFFFFFFF0, sixteen bytes from the end of the cartridge, which is all the room there is.
 *
 *   movhi 0x0600, r0, r10    r10 = 0x06000000
 *   st.b  r0, 2[r10]         [0x06000002] = 0
 *   ld.b  0[r10], r12        r12 = [0x06000000], seeded with MARKER
 *   br    0                  spin
 *
 * Write and read are at different addresses on purpose, to tell a read callback that also fires for writes from one
 * that does not.
 */
function buildRom() {
    const size = 0x100000;
    const rom = new Uint8Array(size);
    const view = new DataView(rom.buffer);
    let at = size - 0x10;
    const half = value => { view.setUint16(at, value & 0xffff, true); at += 2; };

    half((0x2f << 10) | (10 << 5) | 0); half(0x0600);
    half((0x34 << 10) | (0 << 5) | 10); half(0x0002);
    half((0x30 << 10) | (12 << 5) | 10); half(0x0000);
    half(0x9400);
    return rom;
}

const ROM = buildRom();

async function run(arity, returnsValue, { returns = 0, clocks = 400000 } = {}) {
    const { instance } = await WebAssembly.instantiate(coreBytes, {
        env: { emscripten_notify_memory_growth: () => { } }
    });
    const E = instance.exports;
    E._initialize();

    const romPtr = E.Realloc(0, ROM.length);
    new Uint8Array(E.memory.buffer, romPtr, ROM.length).set(ROM);

    const sim = E.CreateSim();
    if (E.vbSetCartROM(sim, romPtr, ROM.length) !== 0) {
        throw new Error('Core rejected the synthetic ROM');
    }
    const ramPtr = E.Realloc(0, 8192);
    const ram = new Uint8Array(E.memory.buffer, ramPtr, 8192);
    ram.fill(0);
    // seeded rather than stored by the program, which has no room for the two extra instructions
    ram[0] = MARKER;
    E.vbSetCartRAM(sim, ramPtr, 8192);

    const calls = [];
    let total = 0;
    const trampoline = makeTrampoline(arity, returnsValue, (...args) => {
        total++;
        if (calls.length < 64) {
            const memory = new DataView(E.memory.buffer);
            calls.push({
                args,
                // read inside the callback, the only place to learn which code touched SRAM
                pc: E.vbGetProgramCounter(sim) >>> 0,
                deref: args.map(argument => {
                    const address = argument >>> 0;
                    return address > 0x1000 && address + 4 <= E.memory.buffer.byteLength
                        ? memory.getInt32(address, true) : undefined;
                }),
            });
        }
        return returns;
    });

    const table = E.__indirect_function_table;
    let slot = -1;
    for (let index = 1; index < table.length; index++) {
        if (table.get(index) === null) { slot = index; break; }
    }
    if (slot < 0) { throw new Error('No free slot in the function table'); }
    table.set(slot, trampoline);

    E.vbSetReadCallback(sim, slot);
    E.vbReset(sim);

    const simsPtr = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, simsPtr, 1)[0] = sim;
    const clocksPtr = E.Realloc(0, 4);

    try {
        E.vbSetSamples(sim, E.GetExtSamples(sim), 5, 834);
        new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] = clocks;
        let guard = 0;
        while (new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] !== 0 && guard++ < 100000) {
            E.Emulate(simsPtr, 1, clocksPtr);
        }
    } catch (error) {
        return { trapped: error.message.split('\n')[0], calls, total };
    }
    return {
        calls, total,
        callbackIndex: E.vbGetReadCallback(sim),
        loaded: E.vbGetProgramRegister(sim, 12) >>> 0,
        wrote: new Uint8Array(E.memory.buffer, ramPtr + 2, 1)[0],
    };
}

console.log('Signature sweep');
const survivors = [];
for (let arity = 2; arity <= 8; arity++) {
    for (const returnsValue of [true, false]) {
        const label = `(${'i32,'.repeat(arity).slice(0, -1)}) -> ${returnsValue ? 'i32' : 'void'}`;
        const result = await run(arity, returnsValue);
        if (result.trapped) { continue; }
        if (result.calls.length > 0) {
            survivors.push({ label, arity, returnsValue, ...result });
            console.log(`  ${label} fired ${result.total} time(s)`);
        }
    }
}

check('exactly one signature fires', survivors.length, 1);

if (survivors.length === 1) {
    const [found] = survivors;
    check('arity', found.arity, 5);
    check('returns a value', found.returnsValue, true);
    check('the callback index round-trips', found.callbackIndex > 0, true);

    // one ld.b is one read, a callback that also saw instruction fetches would fire thousands of times
    report('calls for a program with one ld.b', found.total);
    check('instruction fetches do not come through it', found.total < 8, true);

    const read = found.calls[found.calls.length - 1];
    console.log(`\n  args  ${read.args.map(a => '0x' + (a >>> 0).toString(16).padStart(8, '0')).join(' ')}`);
    console.log(`  deref ${read.deref.map(v => v === undefined ? '         -' : '0x' + (v >>> 0).toString(16).padStart(8, '0')).join(' ')}\n`);

    check('argument 0 is a pointer, the simulation', read.deref[0] !== undefined, true);
    check('argument 1 is the address', read.args[1] >>> 0, CART_RAM_BASE);
    check('argument 2 is the 8-bit data type', read.args[2], 0);
    // whether a panel can show what was read, or only that something was
    check('argument 3 points at the value read', read.deref[3] & 0xff, MARKER);

    // writes must not come through here, or an entry could not be labeled
    check('one read produces one call', found.total, 1);
    check('and it is the read, not the write beside it', read.args[1] >>> 0, CART_RAM_BASE);

    check('returning zero lets the read proceed', found.loaded, MARKER);

    // the ld.b is the third of four instructions in a program that starts at 0xFFFFFFF0
    report('program counter inside the callback', '0x' + read.pc.toString(16));
    check('it is the instruction doing the read', read.pc, 0xfffffff8);
}

console.log('\nReturning non-zero');
{
    const result = await run(5, true, { returns: 1 });
    report('what the program loaded', '0x' + (result.loaded ?? 0).toString(16));
    report('callbacks fired', result.total);
    // recorded rather than asserted: the panel's reader always returns zero, this only documents the other branch
    check('a reader that returns zero is the one that observes', result.total > 0, true);
}

console.log(failures === 0
    ? '\nAll checks passed. Read callback ABI: (sim, address, type, valuePtr, outA) -> int'
    : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
