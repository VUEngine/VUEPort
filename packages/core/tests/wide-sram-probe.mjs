// with 16 MiB of cart RAM, a store to 0x06200000 must land at offset 0x200000, not fold back onto the save's start as
// with a 16 KiB buffer. No game does that, so a V810 program writes a scattered save, run with the old window and the
// full one. Usage: node tests/wide-sram-probe.mjs
import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = require('../lib/common/emulator-save-state.js');

const corePath = new URL('../wasm/shrooms/core.wasm', import.meta.url);
const TABLE_SLOTS = 16;
const MARKER = 0x5a;

const TARGETS = [
    0x000000,  // the header every save starts with
    0x000100,
    0x003f00,  // the last of what a real 16 KiB cartridge could hold
    0x004000,  // one byte past it — the access this design exists for
    0x010000,  // 64 KiB in
    0x080000,  // 512 KiB
    0x200000,  // 2 MiB
    0x7f0000,  // just under 8 MiB
];

let failures = 0;
const check = (label, ok, detail) => {
    if (!ok) { failures++; }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
};
const report = (label, value) => console.log(`  --   ${label}: ${value}`);

// table patching, lifted from write-callback-probe.mjs
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
function makeTrampoline(arity, onCall) {
    const I32 = 0x7f;
    const type = [0x60, ...vec(Array.from({ length: arity }, () => [I32])), ...vec([[I32]])];
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
    return new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { f: onCall } }).exports.t;
}

// a 1 MB cartridge that writes MARKER to every address in TARGETS. The 16-byte reset vector jumps to the body, one
// unrolled movhi/movea/st.b group per target, so the addresses can be read straight off the listing
function buildRom() {
    const size = 0x100000;
    const rom = new Uint8Array(size);
    const view = new DataView(rom.buffer);
    const half = (at, value) => view.setUint16(at, value & 0xffff, true);

    const BODY = 0x200;
    let at = BODY;
    const emit = value => { half(at, value); at += 2; };
    const movhi = (imm, reg1, reg2) => { emit((0x2f << 10) | (reg2 << 5) | reg1); emit(imm); };
    const movea = (imm, reg1, reg2) => { emit((0x28 << 10) | (reg2 << 5) | reg1); emit(imm); };
    const stb = (reg2, disp, reg1) => { emit((0x34 << 10) | (reg2 << 5) | reg1); emit(disp); };

    movea(MARKER, 0, 12);
    for (const target of TARGETS) {
        // the store's displacement is signed, so the high half is rounded up when the low half would be negative
        const low = target & 0xffff;
        const high = ((target >>> 16) + (low & 0x8000 ? 1 : 0)) & 0xffff;
        movhi(0x0600 + high, 0, 10);
        stb(12, low, 10);
    }
    emit(0x8a00); // br . — park here rather than run off into the zeroes

    // the reset vector: r1 = cartridge ROM + BODY, then jump to it
    at = size - 0x10;
    emit((0x2f << 10) | (1 << 5) | 0); emit(0x0700);
    emit((0x28 << 10) | (1 << 5) | 1); emit(BODY);
    emit((0x06 << 10) | (0 << 5) | 1);
    return rom;
}
const ROM = buildRom();

async function run(windowBytes) {
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

    const ramPtr = E.Realloc(0, windowBytes);
    new Uint8Array(E.memory.buffer, ramPtr, windowBytes).fill(0);
    if (E.vbSetCartRAM(sim, ramPtr, windowBytes) !== 0) {
        throw new Error(`Core rejected a ${windowBytes} byte save window`);
    }

    // every address the core reports a write to, before any masking
    const seen = [];
    const trampoline = makeTrampoline(6, (simPtr, address) => {
        const at = address >>> 0;
        if (((at >>> 24) & 7) === 6) { seen.push(at); }
        return 0;
    });
    const table = E.__indirect_function_table;
    let slot = -1;
    for (let index = 1; index < table.length; index++) {
        if (table.get(index) === null) { slot = index; break; }
    }
    if (slot < 0) { throw new Error('No free slot in the function table'); }
    table.set(slot, trampoline);
    E.vbSetWriteCallback(sim, slot);
    E.vbReset(sim);

    const simsPtr = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, simsPtr, 1)[0] = sim;
    const clocksPtr = E.Realloc(0, 4);
    E.vbSetSamples(sim, E.GetExtSamples(sim), 5, 834);
    new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] = 400000;
    let guard = 0;
    while (new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] !== 0 && guard++ < 100000) {
        E.Emulate(simsPtr, 1, clocksPtr);
    }

    // copied out, as the buffer is a view on memory that may have grown
    const ram = new Uint8Array(E.memory.buffer, ramPtr, windowBytes).slice();
    return { seen, ram };
}

console.log('\nA game writing high into Game Pak RAM\n');

console.log('What the bus saw');
const full = await run(0x1000000);
{
    const wanted = TARGETS.map(t => 0x06000000 + t);
    check('every store reaches the cartridge unmasked',
        wanted.every(address => full.seen.includes(address)),
        full.seen.map(a => '0x' + a.toString(16)).join(' '));
    report('stores seen', full.seen.length);
}

console.log('\nWith the whole region backed');
{
    const found = TARGETS.filter(t => full.ram[t] === MARKER);
    check('every byte is at the address it was written to',
        found.length === TARGETS.length,
        `${found.length}/${TARGETS.length}`);
    let stray = 0;
    for (let i = 0; i < full.ram.length; i++) {
        if (full.ram[i] !== 0 && !TARGETS.includes(i)) { stray++; }
    }
    check('and nothing landed anywhere else', stray === 0, String(stray));

    const used = state.saveRamHighWater(full.ram);
    check('the high-water mark is the last byte written',
        used === TARGETS[TARGETS.length - 1] + 1, '0x' + used.toString(16));
    const file = state.saveRamFileSize(used);
    report('save file would be', `${file / 1024 / 1024} MB (window is 16 MB)`);
}

console.log('\nWith the 16 KiB window this replaced');
const narrow = await run(0x4000);
{
    const folded = TARGETS.map(t => t & 0x3fff);
    const distinct = new Set(folded);
    check('the same stores fold onto fewer addresses',
        distinct.size < TARGETS.length, `${TARGETS.length} → ${distinct.size}`);
    report('0x004000 lands at', '0x' + (0x4000 & 0x3fff).toString(16).padStart(6, '0')
        + '  (on top of the save\'s first byte)');
    check('which is what corrupts the save: the header is overwritten',
        narrow.ram[0] === MARKER && folded.filter(f => f === 0).length > 1,
        `${folded.filter(f => f === 0).length} stores share offset 0`);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
