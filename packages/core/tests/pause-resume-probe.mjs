// verifies pause and resume leave the audio graph as the later of the two asked. The audio worklet clocks
// the machine (see vb-worker.ts), so a wrongly suspended graph is a dead emulator. Both cross the worker
// before touching the context, and their round trips used to finish in the wrong order on slow hosts
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Core } = require('../lib/browser/core/vb-core.js');

let failures = 0;
function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`);
    if (!pass) {
        failures++;
        console.log(`     got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// just enough `window` for the gesture listener `run` arms
globalThis.window = { addEventListener() { }, removeEventListener() { } };

// a context whose state changes take time, as a real one's do. `wedged` is the WebKitGTK case: a
// suspend() that never settles
class FakeAudioContext {
    constructor(latency = 5) {
        this.latency = latency;
        this.state = 'suspended';
        this.wedged = false;
        this.calls = [];
        this.currentTime = 0;
    }
    resume() {
        this.calls.push('resume');
        return delay(this.latency).then(() => { this.state = 'running'; });
    }
    suspend() {
        this.calls.push('suspend');
        if (this.wedged) {
            return new Promise(() => { });
        }
        return delay(this.latency).then(() => { this.state = 'suspended'; });
    }
    close() { }
}

class FakeWorker {
    constructor(latency = 20) {
        this.latency = latency;
        this.commands = [];
    }
    postMessage(message) {
        if (!message || message.command === undefined) {
            return;
        }
        this.commands.push(message.command);
        delay(this.latency).then(() =>
            this.onmessage({ data: { id: message.id, result: undefined } }));
    }
    terminate() { }
}

function newCore(options = {}) {
    const worker = new FakeWorker(options.workerLatency);
    const audio = new FakeAudioContext(options.audioLatency);
    const node = { connect() { }, disconnect() { }, port: {} };
    return { core: new Core(worker, audio, node, false), worker, audio };
}

// a pause and the resume that overtakes it

{
    const { core, worker, audio } = newCore();
    // both edges of an impatient double press on the pause key, neither awaited
    const pause = core.suspend();
    const resume = core.run();
    await Promise.all([pause, resume]);
    await delay(50);

    check('the worker is told to stop and then to go, in that order',
        worker.commands, ['suspend', 'run']);
    check('and the graph is left running, with the worker', audio.state, 'running');
}

// a resume and the pause that follows it

{
    const { core, worker, audio } = newCore();
    const resume = core.run();
    const pause = core.suspend();
    await Promise.all([resume, pause]);
    await delay(50);

    check('the other way round reaches the worker the other way round',
        worker.commands, ['run', 'suspend']);
    check('and the graph is left suspended', audio.state, 'suspended');
}

// the ordinary, awaited pair

{
    const { core, audio } = newCore();
    await core.run();
    await delay(20);
    check('an awaited resume starts the graph', audio.state, 'running');
    await core.suspend();
    await delay(20);
    check('and an awaited pause stops it', audio.state, 'suspended');
}

// a context the browser stopped on its own

{
    const { core, audio } = newCore();
    await core.run();
    await delay(20);

    // stopped by an autoplay policy, a host taking the device, or a webview suspending the graph behind an
    // unfocused window; resuming has to reach it all the same
    audio.state = 'suspended';
    await core.run();
    await delay(20);
    check('a graph the browser stopped by itself is started again',
        audio.state, 'running');
}

// a context that never finishes suspending

{
    const { core, audio } = newCore();
    await core.run();
    await delay(20);

    audio.wedged = true;
    const started = Date.now();
    await core.suspend();
    check('a suspend that never settles still lets the pause finish',
        Date.now() - started < 2000, true);

    audio.wedged = false;
    await core.run();
    await delay(20);
    check('and the resume after it is still heard', audio.state, 'running');
}

console.log(failures === 0
    ? '\nPausing and resuming settle on the last thing asked for.'
    : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
