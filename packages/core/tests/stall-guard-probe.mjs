/**
 * The drive loop's stall guard fires when it should, and never when it should not. The core can return having spent
 * nothing, forever, so the worker gives up after VB_MAX_IDLE_EMULATE_CALLS fruitless calls in a row (drainClocks in
 * vb-worker.ts). That is safe only if healthy emulation never comes near the limit, measured here against the worker's
 * own constant. The stuck state needs a ROM this repository does not carry, so firing is checked with a stand-in core
 * that spends nothing.
 * Usage: node tests/stall-guard-probe.mjs [path/to/rom.vb ...]
 */

import fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VB_MAX_IDLE_EMULATE_CALLS, VB_CLOCKS_PER_BUFFER, VB_SAMPLES_PER_BUFFER } =
    require('../lib/common/vb-constants.js');

const F32 = 5;                // VbDataType.F32
// the cartridge RAM window, not the chip: only the low byte of each halfword is wired, so the 8 KiB of a game pak span
// 16 KiB of bus and a smaller buffer mirrors. See DEFAULT_SAVE_RAM_SIZE and sram-init-probe.mjs
const RAM_LEN = 16384;
const SGN = 0x0002;           // VbKey.SGN, always held down
const FRAMES = Number(process.env.FRAMES ?? 600);

const CORE = new URL('../wasm/shrooms/core.wasm', import.meta.url);

let failures = 0;
const check = (label, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  ${detail}`}`);
};

// the loop from drainClocks, in the worker's shape (re-read the budget each time, count only consecutive fruitless
// calls), over an injectable core. Returns the longest run of fruitless calls, or -1 when the guard stopped it
function drain(core, clocks) {
    core.setBudget(clocks);
    let idle = 0;
    let worst = 0;
    let before = clocks;
    while (core.budget() !== 0) {
        core.emulate();
        const left = core.budget();
        idle = left === before ? idle + 1 : 0;
        before = left;
        worst = Math.max(worst, idle);
        if (idle > VB_MAX_IDLE_EMULATE_CALLS) {
            return -1;
        }
    }
    return worst;
}

console.log(`Threshold: ${VB_MAX_IDLE_EMULATE_CALLS} fruitless calls in a row\n`);

console.log('=== a core that never advances is given up on ===');
{
    let calls = 0;
    const stuck = {
        left: VB_CLOCKS_PER_BUFFER,
        setBudget(clocks) { this.left = clocks; },
        budget() { return this.left; },
        emulate() { calls++; },
    };
    const result = drain(stuck, VB_CLOCKS_PER_BUFFER);
    check('the loop ends', result === -1, 'it drained a budget nothing was spent from');
    check('it ends promptly', calls <= VB_MAX_IDLE_EMULATE_CALLS + 2,
        `took ${calls} calls`);
}

console.log('\n=== a core that advances is left alone ===');
{
    const walking = {
        left: 0,
        setBudget(clocks) { this.left = clocks; },
        budget() { return this.left; },
        // spends a slice at a time, with the occasional break that costs nothing: a real chunk, exaggerated
        step: 0,
        emulate() {
            this.step++;
            if (this.step % 4 !== 0) {
                this.left = Math.max(0, this.left - VB_CLOCKS_PER_BUFFER / 8);
            }
        },
    };
    const worst = drain(walking, VB_CLOCKS_PER_BUFFER);
    check('the loop finishes on its own', worst !== -1);
    check('and never approaches the threshold', worst < VB_MAX_IDLE_EMULATE_CALLS / 10,
        `longest fruitless run was ${worst}`);
}

console.log('\n=== real ROMs, a linked pair, plausible input ===');

const roms = process.argv.slice(2);
if (roms.length === 0) {
    const synthetic = new Uint8Array(1 << 20);
    for (let i = 0; i < synthetic.length; i++) synthetic[i] = (i * 7) & 0xff;
    roms.push(synthetic);
}

// a seeded input script, the same shape determinism-probe.mjs uses
function inputScript(seed) {
    let s = seed >>> 0;
    const next = () => (s = Math.imul(s, 1664525) + 1013904223 >>> 0);
    const HORIZONTAL = [0, 0x0200, 0x0100];
    const VERTICAL = [0, 0x0800, 0x0400];
    const press = () => {
        let mask = SGN | HORIZONTAL[next() % 3] | VERTICAL[next() % 3];
        if (next() % 3 === 0) mask |= 0x0004;
        if (next() % 3 === 0) mask |= 0x0008;
        if (next() % 8 === 0) mask |= 0x0010;
        if (next() % 8 === 0) mask |= 0x0020;
        if (next() % 64 === 0) mask |= 0x1000;
        if (next() % 128 === 0) mask |= 0x2000;
        return mask;
    };
    const held = [SGN, SGN];
    const until = [0, 0];
    return frame => {
        for (const seat of [0, 1]) {
            if (frame >= until[seat]) {
                held[seat] = press();
                until[seat] = frame + 3 + (next() % 12);
            }
        }
        return held;
    };
}

for (const entry of roms) {
    const name = typeof entry === 'string' ? entry.split('/').pop() : 'synthetic';
    const rom = typeof entry === 'string' ? new Uint8Array(fs.readFileSync(entry)) : entry;

    const { instance } = await WebAssembly.instantiate(fs.readFileSync(CORE), {
        env: { emscripten_notify_memory_growth: () => { } },
    });
    const E = instance.exports;
    E._initialize();

    const makeSim = () => {
        const romPtr = E.Realloc(0, rom.length);
        new Uint8Array(E.memory.buffer, romPtr, rom.length).set(rom);
        const ramPtr = E.Realloc(0, RAM_LEN);
        new Uint8Array(E.memory.buffer, ramPtr, RAM_LEN).fill(0);
        const sim = E.CreateSim();
        E.vbSetCartROM(sim, romPtr, rom.length);
        E.vbSetCartRAM(sim, ramPtr, RAM_LEN);
        E.vbSetKeys(sim, SGN);
        E.vbReset(sim);
        return { sim, samples: E.GetExtSamples(sim) };
    };

    const a = makeSim();
    const b = makeSim();
    // peered, as the stuck state was found that way
    E.vbSetPeer(a.sim, b.sim);
    E.vbSetPeer(b.sim, a.sim);

    const simsPtr = E.Realloc(0, 8);
    const clocksPtr = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, simsPtr, 2).set([a.sim, b.sim]);

    const core = {
        setBudget(clocks) { new Uint32Array(E.memory.buffer, clocksPtr, 1)[0] = clocks; },
        budget() { return new Uint32Array(E.memory.buffer, clocksPtr, 1)[0]; },
        emulate() { E.Emulate(simsPtr, 2, clocksPtr); },
    };

    const script = inputScript(0x5eed1e);
    let worst = 0;
    let stalledAt = -1;
    for (let frame = 0; frame < FRAMES; frame++) {
        const [ka, kb] = script(frame);
        E.vbSetKeys(a.sim, ka);
        E.vbSetKeys(b.sim, kb);
        E.vbSetSamples(a.sim, a.samples, F32, VB_SAMPLES_PER_BUFFER);
        E.vbSetSamples(b.sim, b.samples, F32, VB_SAMPLES_PER_BUFFER);
        const result = drain(core, VB_CLOCKS_PER_BUFFER);
        if (result === -1) {
            stalledAt = frame;
            break;
        }
        worst = Math.max(worst, result);
    }

    if (stalledAt !== -1) {
        // not a failure: this ROM really gets stuck and the guard did its job, but say so
        console.log(`      ${name}: the guard fired at frame ${stalledAt} -- this ROM gets stuck.`);
        continue;
    }
    check(`${name}: healthy emulation stays clear of the threshold`,
        worst < VB_MAX_IDLE_EMULATE_CALLS / 10,
        `longest fruitless run over ${FRAMES} frames was ${worst}`);
    console.log(`      longest fruitless run over ${FRAMES} frames: ${worst}`);
}

console.log();
console.log(failures === 0
    ? 'The guard ends a stuck drive loop and leaves a healthy one alone.'
    : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
