/**
 * What a restored state does to the watching callbacks. A snapshot copies the whole simulation struct (see
 * Worker#snapshot), including the callback slots, so the write callback is lost just like the execute callback (see
 * rearmLiveProfiler). Every capture depends on it: terminal, SRAM, link, ESSound, drawn palettes and the VSU panel's
 * shadow, and rewind restores on every step via Worker#restoreFrom. Checks against the shipped core:
 * 1. With the watch installed, stores to the VSU range call back.
 * 2. After restoring a snapshot from before, they do not.
 * 3. Re-arming as Worker#restoreFrom does brings them back.
 * Callback ABI as in write-callback-probe.mjs.
 * Usage: node tests/restore-callback-probe.mjs
 */
import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patchTableLimit, installVbCallback, VB_WRITE_CALLBACK_ARITY } =
    require('../lib/worker/vb-wasm.js');

const VB_VSU_BASE = 0x01000000;
const VB_VSU_WATCH_BYTES = 0x584;

let failures = 0;
function check(label, ok, detail) {
    if (!ok) {
        failures++;
        console.log(`  FAIL ${label}${detail ? `:\n    ${detail}` : ''}`);
        return;
    }
    console.log(`  ok   ${label}`);
}

// stores to the VSU in a loop (WAVEDATA1 sample 0 and channel 0's SxLRV), as nothing else writes there; reset jumps to
// the loop at 0x1000
function buildRom(value) {
    const size = 0x100000;
    const rom = new Uint8Array(size);
    const view = new DataView(rom.buffer);

    let at = 0;
    const half = v => { view.setUint16(at, v & 0xffff, true); at += 2; };
    const movhi = (imm, reg1, reg2) => { half((0x2f << 10) | (reg2 << 5) | reg1); half(imm); };
    const movea = (imm, reg1, reg2) => { half((0x28 << 10) | (reg2 << 5) | reg1); half(imm); };
    const stb = (reg2, disp, reg1) => { half((0x34 << 10) | (reg2 << 5) | reg1); half(disp); };
    const jmp = reg1 => half((0x06 << 10) | reg1);
    // condition 5 is "always"; the displacement is signed and in halfwords
    const br = disp => half(0x8000 | (0x5 << 9) | ((disp >> 1) & 0x1ff));

    at = 0x1000;
    movhi(0x0100, 0, 10);
    movea(value, 0, 11);
    stb(11, 0, 10);
    stb(11, 0x404, 10);
    br(-8);

    at = size - 0x10;
    movhi(0xfff0, 0, 10);
    movea(0x1000, 10, 10);
    jmp(10);

    return rom;
}

function runToCompletion(E, sim) {
    const simsPtr = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, simsPtr, 1)[0] = sim;
    const clocksPtr = E.Realloc(0, 4);
    E.vbSetSamples(sim, E.GetExtSamples(sim), 5, 834);
    new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] = 20000;
    let guard = 0;
    while (new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] !== 0 && guard++ < 100000) {
        E.Emulate(simsPtr, 1, clocksPtr);
    }
}

const corePath = new URL('../wasm/shrooms/core.wasm', import.meta.url);
const bytes = patchTableLimit(new Uint8Array(fs.readFileSync(corePath)));
const { instance } = await WebAssembly.instantiate(bytes, {
    env: { emscripten_notify_memory_growth: () => { } }
});
const E = instance.exports;
E._initialize();

const rom = buildRom(0x7a);
const romPtr = E.Realloc(0, rom.length);
new Uint8Array(E.memory.buffer, romPtr, rom.length).set(rom);
const sim = E.CreateSim();
if (E.vbSetCartROM(sim, romPtr, rom.length) !== 0) {
    throw new Error('Core rejected the synthetic ROM');
}
const ramPtr = E.Realloc(0, 8192);
new Uint8Array(E.memory.buffer, ramPtr, 8192).fill(0);
E.vbSetCartRAM(sim, ramPtr, 8192);
E.vbReset(sim);

// taken before anything is installed, the ordinary case: states are saved by players, not inspectors
const size = E.vbSizeOf();
const snapshot = new Uint8Array(E.memory.buffer, sim, size).slice();

let writes = 0;
const slot = installVbCallback(E, (unusedSim, address) => {
    const at = address >>> 0;
    if (at >= VB_VSU_BASE && at < VB_VSU_BASE + VB_VSU_WATCH_BYTES) {
        writes++;
    }
    return 0;
}, VB_WRITE_CALLBACK_ARITY);

console.log('The write watch across a restored state');

E.vbSetWriteCallback(sim, slot);
runToCompletion(E, sim);
const watched = writes;
check('the watch sees stores to the VSU range', watched > 0, `saw ${watched}`);

// as Worker#restoreFrom: memcpy the struct back, then re-apply this simulation's own pointers
new Uint8Array(E.memory.buffer, sim, size).set(snapshot);
E.vbSetCartROM(sim, romPtr, rom.length);
E.vbSetCartRAM(sim, ramPtr, 8192);

writes = 0;
runToCompletion(E, sim);
check('restoring a state taken before it silently switches it off',
    writes === 0, `saw ${writes}, expected none`);

E.vbSetWriteCallback(sim, slot);
writes = 0;
runToCompletion(E, sim);
check('re-arming it afterwards brings the stores back', writes > 0, `saw ${writes}`);

E.vbSetWriteCallback(sim, 0);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
