// end-to-end terminal capture with the shipped table patch and callback installer: a hand-assembled program writes a
// string to the terminal port the way Terminal::print does, and the text must come back intact (ABI from
// tests/write-callback-probe.mjs). Usage: node tests/terminal-probe.mjs
import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patchTableLimit, installVbCallback, VB_TABLE_SLOTS, VB_WRITE_CALLBACK_ARITY } =
    require('../lib/worker/vb-wasm.js');

const TERMINAL_PORT = 0x02000030;
const MESSAGE = 'VUEngine Studio\n';

let failures = 0;
function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}:\n    got      ${JSON.stringify(actual)}\n    expected ${JSON.stringify(expected)}`);
        return false;
    }
    console.log(`  ok   ${label}`);
    return true;
}

// writes MESSAGE to the terminal port byte by byte and spins. Reset jumps to 0xFFF01000, which is ROM offset 0x1000, as
// cartridge ROM decodes from address bits 26-24 and masks the offset to the image size
function buildRom(text) {
    const size = 0x100000;
    const rom = new Uint8Array(size);
    const view = new DataView(rom.buffer);

    let at = 0;
    const half = value => {
        view.setUint16(at, value & 0xffff, true);
        at += 2;
    };
    const movhi = (imm, reg1, reg2) => { half((0x2f << 10) | (reg2 << 5) | reg1); half(imm); };
    const movea = (imm, reg1, reg2) => { half((0x28 << 10) | (reg2 << 5) | reg1); half(imm); };
    const stb = (reg2, disp, reg1) => { half((0x34 << 10) | (reg2 << 5) | reg1); half(disp); };
    const jmp = reg1 => half((0x06 << 10) | reg1);

    at = 0x1000;
    movhi(0x0200, 0, 10);
    for (const character of text) {
        movea(character.charCodeAt(0), 0, 11);
        stb(11, 0x30, 10);
    }
    half(0x9400);   // br 0

    at = size - 0x10;
    movhi(0xfff0, 0, 10);
    movea(0x1000, 10, 10);
    jmp(10);

    return rom;
}

const corePath = new URL(
    '../wasm/shrooms/core.wasm',
    import.meta.url
);
const bytes = patchTableLimit(new Uint8Array(fs.readFileSync(corePath)));

const { instance } = await WebAssembly.instantiate(bytes, {
    env: { emscripten_notify_memory_growth: () => { } }
});
const E = instance.exports;
E._initialize();

console.log('Table');
check('widened to the declared slot count', E.__indirect_function_table.length, VB_TABLE_SLOTS);

// which slots the core came with, noted rather than assumed, as that changes when the core is rebuilt; a callback
// just must not land on top of one of them
const stockSlots = [];
for (let index = 0; index < E.__indirect_function_table.length; index++) {
    if (E.__indirect_function_table.get(index) !== null) {
        stockSlots.push(index);
    }
}

const rom = buildRom(MESSAGE);
const romPtr = E.Realloc(0, rom.length);
new Uint8Array(E.memory.buffer, romPtr, rom.length).set(rom);

const sim = E.CreateSim();
if (E.vbSetCartROM(sim, romPtr, rom.length) !== 0) {
    throw new Error('Core rejected the synthetic ROM');
}
const ramPtr = E.Realloc(0, 8192);
new Uint8Array(E.memory.buffer, ramPtr, 8192).fill(0);
E.vbSetCartRAM(sim, ramPtr, 8192);

// exactly what Worker#setTerminalCapture does
const captured = [];
const slot = installVbCallback(E, (simPointer, address, type, valuePointer) => {
    if ((address >>> 0) === TERMINAL_PORT) {
        captured.push(new Uint8Array(E.memory.buffer, valuePointer, 1)[0]);
    }
    return 0;
}, VB_WRITE_CALLBACK_ARITY);

console.log('\nCapture');
check('callback went into a spare slot',
    slot > 0 && !stockSlots.includes(slot), true);

E.vbSetWriteCallback(sim, slot);
check('the core reports the callback', E.vbGetWriteCallback(sim), slot);

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

const text = String.fromCharCode(...captured);
check('captured text', text, MESSAGE);
check('one callback per byte written', captured.length, MESSAGE.length);

const parts = text.split('\n');
const partial = parts.pop();
check('one complete line', parts.length, 1);
check('line content', parts[0], MESSAGE.trimEnd());
check('nothing left over', partial, '');

console.log('\nDisabling');
E.vbSetWriteCallback(sim, 0);
check('callback removed', E.vbGetWriteCallback(sim), 0);
const before = captured.length;
new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] = 400000;
guard = 0;
while (new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] !== 0 && guard++ < 100000) {
    E.Emulate(simsPtr, 1, clocksPtr);
}
check('nothing captured once disabled', captured.length, before);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
