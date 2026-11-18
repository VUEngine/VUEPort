/**
 * Turbo: a button held on turbo is pressed and released by the drive loop, frame by frame, at the rate asked for. Runs
 * the real worker in Node with a stand-in audio worklet; handing buffers back one at a time drives the loop. The mask
 * each chunk ran with is read off a profile recording, which logs what the core got before every chunk.
 * Usage: node tests/turbo-probe.mjs
 */
import { createRequire } from 'module';
import { buildRom, check, finish, readCoreWasm } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { turboPressedOn, withTurbo, clampTurboRate, DEFAULT_TURBO_RATE } =
    require('../lib/common/emulator-turbo.js');

const SGN = 0x0002;
const A = 0x0004;
const B = 0x0008;
const RIGHT = 0x0100;

console.log('The rhythm');
check('frame 0 is pressed', turboPressedOn(0, 2), true);
check('frame 1 is pressed', turboPressedOn(1, 2), true);
check('frame 2 is released', turboPressedOn(2, 2), false);
check('frame 4 is pressed again', turboPressedOn(4, 2), true);
check('rate 1 alternates every frame', [0, 1, 2, 3].map(f => turboPressedOn(f, 1)).join(), 'true,false,true,false');
check('a rate out of range is clamped', clampTurboRate(99), 8);
check('and so is one below it', clampTurboRate(0), 1);
check('a rate that is not a number is the default', clampTurboRate(NaN), DEFAULT_TURBO_RATE);
check('held buttons stay held on a released frame', withTurbo(SGN | RIGHT, A, 2, 2), SGN | RIGHT);
check('turbo buttons join them on a pressed frame', withTurbo(SGN | RIGHT, A, 0, 2), SGN | RIGHT | A);
check('no turbo leaves the mask alone', withTurbo(SGN, 0, 0, 2), SGN);

const events = [];
const pending = new Map();
let nextId = 1;
globalThis.postMessage = message => {
    if (message && message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? reject(new Error(message.error)) : resolve(message.result);
    } else if (message && message.event) {
        events.push(message);
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
    // handing one buffer back is what makes the worker emulate one chunk
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
await request('setCartRom', { sim, rom: buildRom().buffer });
await request('reset', { sim });

// the worker fills its initial buffers the moment it runs, so those are spent first; after that each buffer handed
// back is one more chunk
async function runChunks(chunks, setup) {
    await request('startProfileRecording', { sim });
    await setup?.();
    await request('run');
    while ((await recordedChunks()) < chunks) {
        audio.giveBack();
        await new Promise(resolve => setImmediate(resolve));
    }
    await request('suspend');
    const recording = await request('stopProfileRecording', { sim });
    const masks = [];
    let mask = 0;
    const changes = new Map(recording.keys);
    for (let chunk = 0; chunk < recording.chunks; chunk++) {
        mask = changes.get(chunk) ?? mask;
        masks.push(mask);
    }
    return masks.slice(0, chunks);
}

// chunks run since `startFrame`; the digest carries the worker's frame count, which goes up by one per chunk
async function recordedChunks() {
    const { frame } = await request('stateDigest', { sim });
    return frame - startFrame;
}

let startFrame = (await request('stateDigest', { sim })).frame;

console.log('\nIn the drive loop');
{
    await request('setKeys', { sim, keys: SGN | RIGHT });
    startFrame = (await request('stateDigest', { sim })).frame;
    const masks = await runChunks(12, () => request('setTurbo', { sim, keys: A, rate: 2 }));
    const expected = masks.map((_, i) => withTurbo(SGN | RIGHT, A, startFrame + i, 2));
    check('every chunk ran with the held buttons plus A in rhythm',
        masks.map(m => m.toString(16)).join(), expected.map(m => m.toString(16)).join());
    check('A was pressed on some chunks', masks.some(m => (m & A) !== 0), true);
    check('and released on others', masks.some(m => (m & A) === 0), true);
    check('the held button never let go', masks.every(m => (m & RIGHT) !== 0), true);
}
{
    startFrame = (await request('stateDigest', { sim })).frame;
    const masks = await runChunks(12, () => request('setTurbo', { sim, keys: A | B, rate: 3 }));
    const expected = masks.map((_, i) => withTurbo(SGN | RIGHT, A | B, startFrame + i, 3));
    check('a slower rate and two buttons',
        masks.map(m => m.toString(16)).join(), expected.map(m => m.toString(16)).join());
}
{
    startFrame = (await request('stateDigest', { sim })).frame;
    const masks = await runChunks(6, () => request('setTurbo', { sim, keys: 0, rate: 2 }));
    check('letting go of turbo leaves only what is held', masks.every(m => m === (SGN | RIGHT)), true);
}

console.log('\nUnder lockstep');
{
    await request('setTurbo', { sim, keys: A, rate: 1 });
    await request('setLockstep', { sim, enabled: true });
    startFrame = (await request('stateDigest', { sim })).frame;
    for (let frame = startFrame; frame < startFrame + 8; frame++) {
        await request('queueKeys', { sim, frame, keys: SGN | B });
    }
    const masks = await runChunks(6, () => request('setTurbo', { sim, keys: A, rate: 1 }));
    check('the worker adds no turbo of its own: only the booked mask runs',
        masks.every(m => m === (SGN | B)), true);
    await request('setLockstep', { sim, enabled: false });
}

finish();
