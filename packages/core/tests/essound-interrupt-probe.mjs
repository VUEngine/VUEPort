// checks that the expansion-port interrupt raised for ESSound's init command matches the V810's own. The
// core cannot raise interrupts, so the worker does the entry by hand (serviceGamePakInterrupts); letting the
// CPU carry on shows a wrong PSW or vector. Usage: node tests/essound-interrupt-probe.mjs
import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vb = require('../lib/common/vb-constants.js');

let failures = 0;
const check = (label, actual, expected) => {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${actual}, expected ${expected}`);
    }
};
const hex = value => `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

const corePath = new URL(
    '../wasm/shrooms/core.wasm',
    import.meta.url
);
const { instance } = await WebAssembly.instantiate(fs.readFileSync(corePath), {
    env: { emscripten_notify_memory_growth: () => { } }
});
const E = instance.exports;
E._initialize();

// a ROM of nothing but `jr 0`, so the CPU spins wherever it ends up. Format IV: opcode 0b101010 in the top
// six bits, a displacement of zero
const ROM_BYTES = 1024;
const rom = new Uint8Array(ROM_BYTES);
for (let at = 0; at < ROM_BYTES; at += 4) {
    rom[at] = 0x00; rom[at + 1] = 0xa8;   // jr, low halfword of the displacement
    rom[at + 2] = 0x00; rom[at + 3] = 0x00;
}

const sim = E.CreateSim();
const romPointer = E.Realloc(0, rom.length);
new Uint8Array(E.memory.buffer, romPointer, rom.length).set(rom);
if (E.vbSetCartROM(sim, romPointer, rom.length) !== 0) {
    throw new Error('Core rejected the ROM');
}
const ramPointer = E.Realloc(0, 8192);
new Uint8Array(E.memory.buffer, ramPointer, 8192).fill(0);
E.vbSetCartRAM(sim, ramPointer, 8192);
E.vbReset(sim);

const sims = E.Realloc(0, 4);
new Uint32Array(E.memory.buffer, sims, 1)[0] = sim;
const clocks = E.Realloc(0, 4);
const run = amount => {
    new Uint32Array(E.memory.buffer, clocks, 1)[0] = amount;
    while (new Uint32Array(E.memory.buffer, clocks, 1)[0] !== 0) {
        E.Emulate(sims, 1, clocks);
    }
};

const PSW = vb.VbSystemRegister.PSW;
const EIPC = vb.VbSystemRegister.EIPC;
const EIPSW = vb.VbSystemRegister.EIPSW;
const ECR = vb.VbSystemRegister.ECR;
const sr = index => E.vbGetSystemRegister(sim, index) >>> 0;

// the worker's serviceGamePakInterrupts, for one simulation
function raiseGamePakInterrupt() {
    const level = vb.VbInterrupt.CRO;
    const psw = sr(PSW);
    const blocked = (psw & (vb.VbPsw.NP | vb.VbPsw.EP | vb.VbPsw.ID)) !== 0;
    const masked = level < ((psw & vb.VB_PSW_INTERRUPT_LEVEL_MASK) >>> vb.VB_PSW_INTERRUPT_LEVEL_SHIFT);
    if (blocked || masked) {
        return false;
    }
    const ecr = sr(ECR);
    E.vbSetSystemRegister(sim, EIPC, E.vbGetProgramCounter(sim) >>> 0);
    E.vbSetSystemRegister(sim, EIPSW, psw);
    E.vbSetSystemRegister(sim, ECR, (ecr & 0xffff0000) | vb.vbInterruptExceptionCode(level));
    const entered = ((psw & ~(vb.VbPsw.AE | vb.VB_PSW_INTERRUPT_LEVEL_MASK))
        | vb.VbPsw.EP | vb.VbPsw.ID | ((level + 1) << vb.VB_PSW_INTERRUPT_LEVEL_SHIFT)) >>> 0;
    E.vbSetSystemRegister(sim, PSW, entered);
    E.vbSetProgramCounter(sim, (vb.VB_INTERRUPT_VECTOR_BASE + (level << 4)) >>> 0);
    return true;
}

console.log('\nThe CPU before the pulse');
run(2000);
const before = E.vbGetProgramCounter(sim) >>> 0;
console.log(`  spinning at ${hex(before)}`);
check('the ROM is running', before !== 0, true);

console.log('\nA pulse the CPU can take');
{
    // interrupts enabled, nothing being handled, no level masked
    E.vbSetSystemRegister(sim, PSW, 0);
    const psw = sr(PSW);
    const pc = E.vbGetProgramCounter(sim) >>> 0;

    check('taken', raiseGamePakInterrupt(), true);
    check('jumps to the expansion port vector', hex(E.vbGetProgramCounter(sim) >>> 0), hex(0xfffffe20));
    check('EIPC holds where it was', hex(sr(EIPC)), hex(pc));
    check('EIPSW holds the old PSW', hex(sr(EIPSW)), hex(psw));
    check('ECR carries the level 2 exception code', sr(ECR) & 0xffff, 0xfe20);
    check('PSW marks an exception in progress', (sr(PSW) & vb.VbPsw.EP) !== 0, true);
    check('PSW disables interrupts', (sr(PSW) & vb.VbPsw.ID) !== 0, true);
    check('PSW masks this level and below',
        (sr(PSW) & vb.VB_PSW_INTERRUPT_LEVEL_MASK) >>> vb.VB_PSW_INTERRUPT_LEVEL_SHIFT, 3);

    run(2000);
    const after = E.vbGetProgramCounter(sim) >>> 0;
    console.log(`  now spinning at ${hex(after)}`);
    check('and executes the handler', after >>> 8, 0xfffffe20 >>> 8);
}

console.log('\nA pulse the CPU cannot take yet');
{
    E.vbSetSystemRegister(sim, PSW, vb.VbPsw.ID);
    check('interrupts disabled: held', raiseGamePakInterrupt(), false);
    E.vbSetSystemRegister(sim, PSW, vb.VbPsw.EP);
    check('already in an exception: held', raiseGamePakInterrupt(), false);
    E.vbSetSystemRegister(sim, PSW, vb.VbPsw.NP);
    check('in an NMI: held', raiseGamePakInterrupt(), false);
    E.vbSetSystemRegister(sim, PSW, 4 << vb.VB_PSW_INTERRUPT_LEVEL_SHIFT);
    check('level masked out: held', raiseGamePakInterrupt(), false);
    // level 2 is exactly at the mask, which the hardware still accepts
    E.vbSetSystemRegister(sim, PSW, 2 << vb.VB_PSW_INTERRUPT_LEVEL_SHIFT);
    check('level equal to the mask: taken', raiseGamePakInterrupt(), true);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
