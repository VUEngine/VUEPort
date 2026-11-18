// a host keeping files in memory, like the desktop app's fork worker, has to get the same command line
// answers `vbprobe` gives in a terminal.
// Usage: node tests/probe-host-probe.mjs
import { createRequire } from 'module';
import { buildRom, check, COUNTER, finish, readCoreWasm } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { runCommand } = require('../lib/probe/cli/commands.js');
const { VbMachine } = require('../lib/probe/index.js');

const core = readCoreWasm();
const rom = buildRom();
const files = new Map();
const opened = [];
const kept = await VbMachine.create({ core, rom, sramWindow: 0x4000 });

const host = {
    help: 'help for this host',
    async open(options, positional) {
        opened.push(options.values.get('fork')?.[0] ?? 'fresh');
        const vb = options.values.has('fork') ? kept : await VbMachine.create({ core, rom, sramWindow: 0x4000 });
        return { vb, rest: positional };
    },
    read(path) {
        if (!files.has(path)) {
            throw new Error(`no ${path}`);
        }
        return files.get(path);
    },
    write(path, bytes) {
        files.set(path, bytes);
    },
};

console.log('A host of its own');
check('help is the host\'s', (await runCommand(['help'], host)).text, 'help for this host');
let result = await runCommand(['run', '--frames', '2', '--state-out', 'two.vess', '--shot', '1:one.png'], host);
check('the command runs on the machine the host gives', result.text.startsWith('frame 2  pc 0x'), true);
check('files written go to the host', files.has('two.vess') && files.has('one.png'), true);
check('... as the bytes a file would have had', String.fromCharCode(...files.get('one.png').subarray(1, 4)), 'PNG');

result = await runCommand(['peek', '--state-in', 'two.vess', `0x${COUNTER.toString(16)}:4`, '--json'], host);
const counted = JSON.parse(result.text).peek[0].bytes;
check('files read come from the host', counted.length === 8 && counted !== '00000000', true);

let refused = '';
try {
    await runCommand(['run', '--movie', 'missing.mc2'], host);
} catch (error) {
    refused = error.message;
}
check('a file the host does not have is the host\'s error', refused, 'no missing.mc2');

console.log('\nA kept machine');
await runCommand(['run', '--fork', 'one', '--frames', '3'], host);
await runCommand(['run', '--fork', 'one', '--frames', '2'], host);
check('--fork goes to the host, which keeps the machine', kept.frame, 5);
check('... and the host was asked each time', opened.filter(name => name === 'one').length, 2);

console.log('\nForks of forks, as the app keeps them');
const { ProbeForks } = require('../lib/probe/index.js');
const forks = new ProbeForks();
await forks.handle({
    id: 1, op: 'base', key: 'test', rom: rom.slice().buffer, vbc: false, esSound: false,
    wasmUrl: `data:application/wasm;base64,${Buffer.from(core).toString('base64')}`,
});
const playing = await VbMachine.create({ core, rom, sramWindow: 0x4000 });
playing.runFrames(3);
const moment = { state: playing.snapshot().state.slice().buffer, sram: new Uint8Array(0x4000).buffer, sramWindow: 0x4000 };
check('a fork of the moment', (await forks.handle({ id: 2, op: 'fork', name: 'a', moment })).startsWith('a: a copy of this moment'), true);
const cli = async args => JSON.parse((await forks.handle({ id: 3, op: 'cli', args, inputs: {}, help: '', app: 'test' })).text);
await cli(['run', '--fork', 'a', '--frames', '2', '--json']);
const copied = await forks.handle({ id: 4, op: 'fork', name: 'b', from: 'a' });
check('a fork of a fork, where that one stands', copied, `b: a copy of a, standing at ${playing.describe(copied.match(/at (0x[0-9a-f]+)/)[1] * 1)} in frame 2`);
const counterOf = report => report.peek[0].bytes;
const before = counterOf(await cli(['peek', '--fork', 'a', `0x${COUNTER.toString(16)}:4`, '--json']));
check('... the same moment', counterOf(await cli(['peek', '--fork', 'b', `0x${COUNTER.toString(16)}:4`, '--json'])), before);
await cli(['run', '--fork', 'b', '--frames', '1', '--json']);
check('... going on alone', counterOf(await cli(['peek', '--fork', 'a', `0x${COUNTER.toString(16)}:4`, '--json'])), before);
let missing = '';
try {
    await forks.handle({ id: 5, op: 'fork', name: 'c', from: 'nobody' });
} catch (error) {
    missing = error.message;
}
check('... and of none there is not', missing, 'There is no fork called nobody.');

finish();
