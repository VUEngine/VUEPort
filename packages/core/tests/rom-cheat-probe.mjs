/**
 * A cheat that writes into the ROM changes the loaded cartridge itself, which a reset does not reload. Switching the
 * cheat off has to put the cartridge's own bytes back, so a restart afterwards runs the game without it. Runs the real
 * worker in Node like turbo-probe.mjs.
 * Usage: node tests/rom-cheat-probe.mjs (after `yarn build`)
 */
import { createRequire } from 'module';
import { buildRom, check, finish, readCoreWasm } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);

const pending = new Map();
let nextId = 1;
globalThis.postMessage = message => {
    if (message && message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? reject(new Error(message.error)) : resolve(message.result);
    }
};
require('../lib/worker/vb-worker.js');
const deliver = globalThis.onmessage;

const audio = {
    filled: [],
    onmessage: undefined,
    postMessage(data) {
        if (data instanceof ArrayBuffer) {
            this.filled.push(data);
        }
    },
    giveBack() {
        const buffer = this.filled.shift();
        if (buffer) {
            this.onmessage({ data: [buffer] });
        }
    },
};

const request = (command, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    deliver({ data: { id, command, params } });
});

await new Promise(resolve => {
    pending.set(0, { resolve, reject: resolve });
    deliver({ data: { audioPort: audio } });
});
const wasm = readCoreWasm();
await request('init', { wasmUrl: `data:application/wasm;base64,${Buffer.from(wasm).toString('base64')}` });
const sim = await request('createSim');
const rom = buildRom();
await request('setCartRom', { sim, rom: rom.buffer.slice(0) });
await request('reset', { sim });

// cheats are written at frame breaks, so a few frames make sure they have been
async function runFrames(frames) {
    const { frame: from } = await request('stateDigest', { sim });
    await request('run');
    while ((await request('stateDigest', { sim })).frame - from < frames) {
        audio.giveBack();
        await new Promise(resolve => setImmediate(resolve));
    }
    await request('suspend');
}
const read = async (address, length = 1) =>
    [...new Uint8Array(await request('readMemory', { sim, address, length }))];

const ROM_BYTE = 0x07000010;
const MIRROR = 0x07010010; // the same byte through the next mirror of the 64 KiB ROM
const [original] = await read(ROM_BYTE);
const cheated = original ^ 0x5a;

console.log('A ROM cheat switched on and off');
await request('setCheats', { sim, codes: [{ address: ROM_BYTE, value: cheated, bytes: 1 }] });
await runFrames(3);
check('switched on, the ROM byte reads the cheat\'s value', (await read(ROM_BYTE))[0], cheated);
await request('setCheats', { sim, codes: [] });
check('switched off, the cartridge\'s own byte is back', (await read(ROM_BYTE))[0], original);
await request('reset', { sim });
await runFrames(3);
check('and stays so across a reset', (await read(ROM_BYTE))[0], original);

console.log('\nOne of two cheats switched off');
const [next] = await read(ROM_BYTE + 1);
await request('setCheats', { sim, codes: [{ address: ROM_BYTE, value: 0x1234, bytes: 2 }] });
await runFrames(3);
check('a two-byte cheat writes both bytes', (await read(ROM_BYTE, 2)).join(), [0x34, 0x12].join());
await request('setCheats', { sim, codes: [{ address: ROM_BYTE + 1, value: 0x77, bytes: 1 }] });
await runFrames(3);
check('the byte no cheat writes any more is back', (await read(ROM_BYTE))[0], original);
check('the one still written keeps the cheat\'s value', (await read(ROM_BYTE + 1))[0], 0x77);
await request('setCheats', { sim, codes: [] });
check('and comes back too once that cheat is off', (await read(ROM_BYTE + 1))[0], next);

console.log('\nThrough a mirror');
await request('setCheats', { sim, codes: [{ address: MIRROR, value: cheated, bytes: 1 }] });
await runFrames(3);
check('a cheat on a mirror changes the same byte', (await read(ROM_BYTE))[0], cheated);
await request('setCheats', { sim, codes: [] });
check('and puts it back when switched off', (await read(ROM_BYTE))[0], original);

console.log('\nA new cartridge with a cheat on');
await request('setCheats', { sim, codes: [{ address: ROM_BYTE, value: cheated, bytes: 1 }] });
await runFrames(3);
await request('setCartRom', { sim, rom: rom.buffer.slice(0) });
await runFrames(3);
check('the cheat carries on in the new cartridge', (await read(ROM_BYTE))[0], cheated);
await request('setCheats', { sim, codes: [] });
check('and switched off, the new cartridge\'s own byte is back', (await read(ROM_BYTE))[0], original);

finish();
