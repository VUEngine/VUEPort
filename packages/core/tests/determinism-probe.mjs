/**
 * Determinism across WebAssembly instances, which mirror-lockstep link play depends on: two core instances with the same
 * ROM and frame-indexed input must stay identical forever. This names the frame they part.
 *
 * Instance B allocates a scratch buffer first, so its buffers sit at other addresses, which catches any address that
 * reaches the emulated machine. B also builds its sims in dirty memory, like a link window's mirror machine. The core
 * leaves undefined hardware state (instruction cache, registers, VRAM) as it finds it, so CreateSim has to zero its own:
 * without that, Hyper Fighting with the color patch desyncs within two seconds or crashes on a callback pointer from the
 * previous ROM.
 *
 * Two comparisons. Machine state (registers, VRAM, WRAM, cartridge RAM via the core's bus) is the verdict and must agree
 * from frame one. The raw state struct (what save states and a desync hash cover) embeds absolute pointers, so only
 * words that do not differ by the base offset count. It is reported, not judged, as an address-hashed cache in it
 * differs harmlessly for a few hundred frames, which is why a desync hash must use machine state.
 *
 * Usage: node tests/determinism-probe.mjs [path/to/rom.vb] [frames]
 */

import fs from 'fs';

const CLOCKS = 400000;        // VB_CLOCK_RATE / VB_FRAME_RATE -- one chunk is one frame
const F32 = 5;                // VbDataType.F32
const U32 = 4;                // VbDataType.S32, read as a word
const SAMPLES = 834;          // VB_SAMPLE_RATE / VB_FRAME_RATE
// size of the cartridge RAM window, not the chip: only the low byte of each halfword is wired, so 8 KiB
// spans 16 KiB of bus and a smaller buffer mirrors the upper half. See DEFAULT_SAVE_RAM_SIZE, sram-init-probe.mjs
const RAM_LEN = 16384;
const SGN = 0x0002;           // VbKey.SGN, always held down
// consecutive Emulate calls consuming nothing before the core counts as stuck; a chunk drains in a handful
const STALL_CALLS = 1000;

const REGIONS = [
    { name: 'VRAM', base: 0x00000000, length: 0x20000 },
    { name: 'WRAM', base: 0x05000000, length: 0x10000 },
    { name: 'cart RAM', base: 0x06000000, length: RAM_LEN },
];

// how far instance B's allocations are pushed; not a round number of pages, so a word differing by exactly
// this is implausible
const PADDING = 0x100004;

const CORE = new URL('../wasm/shrooms/core.wasm', import.meta.url);

const romPath = process.argv[2];
const FRAMES = Number(process.argv[3] ?? process.env.FRAMES ?? 1800);
const CHECKPOINT = Number(process.env.CHECKPOINT ?? 60);
const SEED = Number(process.env.SEED ?? 0x5eed1e);

let rom;
if (romPath) {
    rom = new Uint8Array(fs.readFileSync(romPath));
} else {
    rom = new Uint8Array(1 << 20);
    for (let i = 0; i < rom.length; i++) rom[i] = (i * 7) & 0xff;
}
console.log(`ROM:    ${romPath ?? 'synthetic'} (${(rom.length / 1048576).toFixed(0)} MiB)`);
console.log(`Frames: ${FRAMES} (${(FRAMES / 50).toFixed(1)} s emulated), compared every ${CHECKPOINT}\n`);

async function makeInstance(padding) {
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(CORE), {
        env: { emscripten_notify_memory_growth: () => { } },
    });
    const E = instance.exports;
    E._initialize();

    // shift this instance's allocations, so the two cannot agree on every address and hide an address-dependent core
    if (padding > 0) {
        E.Realloc(0, padding);
    }

    // then free a junk-filled block big enough for everything below, so it all gets made in dirty memory
    let dirty;
    if (padding > 0) {
        const length = 2 * (E.vbSizeOf() + rom.length + RAM_LEN) + 0x400000;
        const start = E.Realloc(0, length);
        new Uint8Array(E.memory.buffer, start, length).fill(0xa5);
        E.Realloc(start, 0);
        dirty = { start, end: start + length };
    }

    const makeSim = () => {
        const romPtr = E.Realloc(0, rom.length);
        new Uint8Array(E.memory.buffer, romPtr, rom.length).set(rom);
        const ramPtr = E.Realloc(0, RAM_LEN);
        new Uint8Array(E.memory.buffer, ramPtr, RAM_LEN).fill(0);
        const sim = E.CreateSim();
        if (E.vbSetCartROM(sim, romPtr, rom.length) !== 0) throw new Error('ROM rejected');
        if (E.vbSetCartRAM(sim, ramPtr, RAM_LEN) !== 0) throw new Error('RAM rejected');
        E.vbSetKeys(sim, SGN);
        E.vbReset(sim);
        return { sim, romPtr, ramPtr, samples: E.GetExtSamples(sim) };
    };

    const a = makeSim();
    const b = makeSim();

    const simsPtr = E.Realloc(0, 8);
    const clocksPtr = E.Realloc(0, 4);
    new Uint32Array(E.memory.buffer, simsPtr, 2).set([a.sim, b.sim]);

    return {
        E, a, b, dirty, size: E.vbSizeOf(),
        // how far this instance's whole world sits from an unpadded one's
        base: a.sim,

        peer(on) {
            E.vbSetPeer(a.sim, on ? b.sim : 0);
            E.vbSetPeer(b.sim, on ? a.sim : 0);
        },

        // one chunk as emulateChunk runs it: rewind samples, drain the clock. False when Emulate keeps returning with
        // the budget untouched; the worker's drive loop has no guard against that, so report rather than hang
        frame(keysA, keysB) {
            E.vbSetKeys(a.sim, keysA);
            E.vbSetKeys(b.sim, keysB);
            E.vbSetSamples(a.sim, a.samples, F32, SAMPLES);
            E.vbSetSamples(b.sim, b.samples, F32, SAMPLES);
            const clocks = new Uint32Array(E.memory.buffer, clocksPtr, 1);
            clocks[0] = CLOCKS;
            let idle = 0;
            while (clocks[0] !== 0) {
                const before = clocks[0];
                E.Emulate(simsPtr, 2, clocksPtr);
                idle = clocks[0] === before ? idle + 1 : 0;
                if (idle > STALL_CALLS) {
                    return false;
                }
            }
            return true;
        },

        machineState(which) {
            const sim = which === 'a' ? a.sim : b.sim;
            const words = [];
            words.push(E.vbGetProgramCounter(sim));
            for (let i = 0; i < 32; i++) words.push(E.vbGetProgramRegister(sim, i));
            for (let i = 0; i < 32; i++) words.push(E.vbGetSystemRegister(sim, i));
            for (const region of REGIONS) {
                for (let at = 0; at < region.length; at += 4) {
                    words.push(E.vbRead(sim, region.base + at, U32));
                }
            }
            return Int32Array.from(words);
        },

        struct(which) {
            return new Uint8Array(E.memory.buffer, which === 'a' ? a.sim : b.sim, this.size);
        },
    };
}

function locate(index) {
    if (index === 0) return 'program counter';
    if (index < 33) return `program register r${index - 1}`;
    if (index < 65) return `system register ${index - 33}`;
    let at = (index - 65) * 4;
    for (const region of REGIONS) {
        if (at < region.length) {
            return `${region.name} + 0x${at.toString(16)}`;
        }
        at -= region.length;
    }
    return `word ${index}`;
}

let failures = 0;
const check = (label, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `  ${detail}`}`);
};

// raw struct words that differ by something other than the base offset
function structDivergence(x, y, delta) {
    const vx = new DataView(x.buffer, x.byteOffset, x.length);
    const vy = new DataView(y.buffer, y.byteOffset, y.length);
    const words = [];
    for (let at = 0; at + 4 <= x.length; at += 4) {
        const a = vx.getUint32(at, true);
        const b = vy.getUint32(at, true);
        if (a !== b && ((b - a) | 0) !== delta) {
            words.push(at);
        }
    }
    return words;
}

// seeded, reproducible input for two players. Plausible masks rather than random bits (one direction per axis,
// face buttons at a human rate, Start/Select rarely), as impossible input says nothing about determinism
function inputScript(seed) {
    let s = seed >>> 0;
    const next = () => (s = Math.imul(s, 1664525) + 1013904223 >>> 0);
    const HORIZONTAL = [0, 0x0200, 0x0100];   // --, LL, LR
    const VERTICAL = [0, 0x0800, 0x0400];     // --, LU, LD
    const press = () => {
        let mask = SGN | HORIZONTAL[next() % 3] | VERTICAL[next() % 3];
        if (next() % 3 === 0) mask |= 0x0004;    // A
        if (next() % 3 === 0) mask |= 0x0008;    // B
        if (next() % 8 === 0) mask |= 0x0010;    // RT
        if (next() % 8 === 0) mask |= 0x0020;    // LT
        if (next() % 64 === 0) mask |= 0x1000;   // Start
        if (next() % 128 === 0) mask |= 0x2000;  // Select
        return mask;
    };
    // held for a few frames at a time, as a controller is actually used
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

function race(A, B, label) {
    const script = inputScript(SEED);
    const delta = (B.base - A.base) | 0;
    let structSettled = -1;
    let structPeak = 0;
    let ran = 0;
    let stalled = -1;

    for (let frame = 0; frame < FRAMES; frame++) {
        const [ka, kb] = script(frame);
        const liveA = A.frame(ka, kb);
        const liveB = B.frame(ka, kb);

        if (!liveA || !liveB) {
            // both stopping at the same frame is agreement and the states still worth comparing; only one stopping is not
            check(`${label}: both instances stopped at the same frame`, liveA === liveB,
                `A ${liveA ? 'ran on' : 'stalled'}, B ${liveB ? 'ran on' : 'stalled'} at frame ${frame + 1}`);
            stalled = frame + 1;
            if (liveA !== liveB) return false;
        }

        ran = frame + 1;
        const last = frame + 1 === FRAMES || stalled !== -1;
        if ((frame + 1) % CHECKPOINT !== 0 && !last) continue;

        for (const which of ['a', 'b']) {
            const x = A.machineState(which);
            const y = B.machineState(which);
            for (let i = 0; i < x.length; i++) {
                if (x[i] !== y[i]) {
                    check(`${label}: sim ${which.toUpperCase()} machine state identical`, false,
                        `diverged by frame ${frame + 1} at ${locate(i)} (A=${x[i]}, B=${y[i]})`);
                    return false;
                }
            }

            const struct = structDivergence(A.struct(which), B.struct(which), delta);
            structPeak = Math.max(structPeak, struct.length);
            if (struct.length === 0 && structSettled === -1) {
                structSettled = frame + 1;
            } else if (struct.length > 0) {
                structSettled = -1;
            }
        }

        if (stalled !== -1) break;
    }

    check(`${label}: machine state identical through ${ran} frames`, true);
    if (stalled !== -1) {
        console.log(`      the core stopped making progress at frame ${stalled} -- identically in`);
        console.log('      both instances, so this is a stuck ROM, not a divergence. See the note below.');
    }
    console.log(`      raw struct: peak ${structPeak} word(s) differing beyond the base offset`
        + (structPeak === 0
            ? ''
            : structSettled === -1
                ? ' -- still differing at the end'
                : `, settled by frame ${structSettled}`));
    return true;
}

console.log('=== the two instances really are laid out differently ===');
const soloA = await makeInstance(0);
const soloB = await makeInstance(PADDING);
check('cartridge buffers land at different addresses', soloA.a.romPtr !== soloB.a.romPtr,
    `both at ${soloA.a.romPtr} -- the padding did not take`);
check('state structs are the same size', soloA.size === soloB.size,
    `${soloA.size} vs ${soloB.size}`);
check('the offset is uniform', (soloB.a.romPtr - soloA.a.romPtr) === (soloB.a.sim - soloA.a.sim),
    'cartridge and simulation moved by different amounts');
check('B\'s simulations were made in dirty memory',
    [soloB.a.sim, soloB.b.sim].every(sim => sim >= soloB.dirty.start && sim < soloB.dirty.end),
    'they landed outside the junk block, so this proves nothing about it');
// before a single frame, as what a ROM does decides whether a difference ever shows; the synthetic one never does
check('none of them has an exception callback it was not given',
    [soloB.a.sim, soloB.b.sim].every(sim => soloB.E.vbGetExceptionCallback(sim) === 0),
    'the core takes junk for a function pointer and traps on the first interrupt');
// the whole struct rather than machine state: what differed was mostly the instruction cache, invisible on the bus
{
    const delta = (soloB.base - soloA.base) | 0;
    const words = ['a', 'b'].map(which =>
        structDivergence(soloA.struct(which), soloB.struct(which), delta).length);
    check('and they start out exactly like simulations made in fresh memory',
        words.every(count => count === 0), `${words.join(' and ')} struct word(s) differ`);
}

console.log('\n=== solo: two unpeered simulations, two instances ===');
soloA.peer(false);
soloB.peer(false);
const soloOk = race(soloA, soloB, 'solo');

console.log('\n=== linked: the pair peered, as a link session runs it ===');
const pairA = await makeInstance(0);
const pairB = await makeInstance(PADDING);
pairA.peer(true);
pairB.peer(true);
check('A is peered', pairA.E.vbGetPeer(pairA.a.sim) === pairA.b.sim, 'peering did not take');
check('B is peered', pairB.E.vbGetPeer(pairB.a.sim) === pairB.b.sim, 'peering did not take');
const linkedOk = race(pairA, pairB, 'linked');

console.log();
if (failures === 0) {
    console.log('Deterministic across instances. Mirror-lockstep is viable: two windows can each\n'
        + 'run the whole pair and exchange nothing but inputs.\n'
        + '\n'
        + 'Note the raw-struct line above. Where it is non-zero the core is keeping something\n'
        + 'address-dependent in the state struct, which is harmless for emulation but means a\n'
        + 'desync hash has to be taken over machine state -- registers, VRAM, WRAM, cart RAM --\n'
        + 'and not over the struct a save state copies.');
} else if (soloOk && !linkedOk) {
    console.log('The link path is what diverges: solo is deterministic, the peered pair is not.\n'
        + 'Mirror-lockstep needs that understood before anything is built on it.');
} else {
    console.log(`${failures} FAILURE(S) -- mirror-lockstep is not viable as planned. See the\n`
        + 'fallback in the plan: the owning window keeps the worker and the second window\n'
        + 'streams packed framebuffers.');
}
process.exit(failures === 0 ? 0 : 1);
