// branches, faults, coverage and VIP events: where the program went, stopping where it goes wrong and on the VIP's beat.
// Usage: node tests/probe-trace-probe.mjs
import { createRequire } from 'module';
import { at, buildCallsRom, buildDisplayRom, buildFaultRom, buildRom, calls, check, fault, finish, readCoreWasm } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { VbMachine } = require('../lib/probe/index.js');

const core = readCoreWasm();
const open = (rom, options = {}) => VbMachine.create({ core, rom, sramWindow: 0x4000, ...options });
const fold = address => (0x07000000 | (address & 0xffff)) >>> 0;

console.log('Branches');
let vb = await open(buildCallsRom());
vb.traceBranches(64);
vb.runFrames(1);
const branches = vb.branches();
check('the ring keeps as many as it was asked to', branches.length, 64);
const has = (from, to) => branches.some(branch => branch.from === fold(from) && branch.to === fold(to));
check('a call', has(calls.loop, calls.func), true);
check('a nested call', has(calls.fcall, calls.leaf), true);
check('the TRAP, marked with its exception code', branches.some(branch => branch.exception === 0xffa0 && branch.from === fold(calls.trap)), true);
check('a straight run of instructions is not a branch', has(calls.func, calls.fstore), false);
vb.traceBranches(0);
check('turned off, nothing is kept', vb.branches().length, 0);

console.log('\nFaults');
vb = await open(buildFaultRom());
vb.stopOnFault = true;
let result = vb.runFrames(1);
check('a zero division stops the run', result.stop?.reason, 'fault');
check('... on the instruction that divided', vb.pc, fault.div);
check('... before the exception is taken', (vb.registers().system.ECR & 0xffff) !== 0xff80, true);
vb.stopOnFault = false;
// a short ring and few instructions, as the program spins after the handler and every lap is a branch
vb.traceBranches(8);
vb.step(12);
check('going on takes the exception, and the handler skips the division', vb.pc, fault.spin);
check('... and the branch into the handler carries the fault', vb.branches().some(branch => branch.exception === 0xff80), true);
vb.stopOnFault = true;
result = vb.runFrames(1);
check('... and the machine does not stop on the same fault twice', result.stop, undefined);

console.log('\nCoverage');
vb = await open(buildRom());
vb.startCoverage();
vb.runFrames(1);
const counts = vb.coverage();
check('the start ran once', counts.get(fold(at.start)), 1);
check('the loop ran many times', counts.get(fold(at.loop)) > 1000, true);
check('... as often as its store', counts.get(fold(at.loop)) - counts.get(fold(at.store)) <= 1, true);
check('nothing that did not run is counted', counts.has(fold(at.start) - 2), false);
vb.stopCoverage();
check('stopped, there is nothing', vb.coverage().size, 0);

console.log('\nVIP events');
vb = await open(buildDisplayRom());
result = vb.runUntil({ vip: 'framestart' }, { maxFrames: 5 });
check('a FRAMESTART interrupt request', result.stop?.reason === 'until' && (vb.read16(0x0005f800) & 0x10) !== 0, true);
result = vb.runUntil({ vip: 'drawing' }, { maxFrames: 5 });
check('drawing starts', result.stop?.reason === 'until' && (vb.read16(0x0005f840) & 0x0c) !== 0, true);
result = vb.runUntil({ vip: 'drawn' }, { maxFrames: 5 });
check('drawing ends', result.stop?.reason === 'until' && (vb.read16(0x0005f840) & 0x0c) === 0, true);
const shown = vb.vipFrames;
result = vb.runUntil({ vip: 'frame' }, { maxFrames: 5 });
check('a frame shown', result.stop?.reason === 'until' && vb.vipFrames === shown + 1, true);
result = vb.runUntil({ vip: 'frame' }, { maxFrames: 5 });
check('... and the next one, with nothing repeated', result.stop?.reason === 'until' && vb.vipFrames === shown + 2, true);
let refused = false;
try {
    vb.runUntil({ vip: 'vblank' });
} catch {
    refused = true;
}
check('an event that does not exist is refused', refused, true);

finish();
