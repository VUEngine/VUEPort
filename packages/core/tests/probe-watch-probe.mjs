// watches: who writes, reads and runs. The core reports a refused access again when the instruction resumes (cpu.c
// leaves the store half done), so a stopping watch must see each access and the write land exactly once. The call stack
// follows JAL, `jmp [lp]`, exceptions and RETI. Usage: node tests/probe-watch-probe.mjs
import { createRequire } from 'module';
import { at, buildCallsRom, buildRom, calls, check, COUNTER, finish, readCoreWasm } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { VbMachine } = require('../lib/probe/index.js');

const core = readCoreWasm();
const open = rom => VbMachine.create({ core, rom, sramWindow: 0x4000 });
const fold = address => (0x07000000 | (address & 0xffff)) >>> 0;   // the 64 KiB test ROM, folded

console.log('Writes, logged');
let vb = await open(buildRom());
let writes = vb.watch({ kind: 'write', at: [COUNTER, 4] });
vb.runFrames(2);
check('every lap is a hit', writes.count > 1000, true);
check('the hit list stops at its limit', writes.hits.length, 1000);
check('a hit has the store as its PC', writes.hits[0].pc, fold(at.store));
check('... the value written', writes.hits[1].value, writes.hits[0].value + 1);
check('... and what was there before', writes.hits[1].old, writes.hits[0].value);
check('... and its size', writes.hits[0].size, 4);
let summary = writes.summary();
check('one instruction writes it', summary.length, 1);
check('... the store, counted in full', summary[0].count, writes.count);
vb.unwatch(writes);

console.log('\nConditions');
const firstValue = vb.read32(COUNTER) + 1;
const exact = vb.watch({ kind: 'write', at: [COUNTER, 4], when: { value: firstValue + 10 } });
const ranged = vb.watch({ kind: 'write', at: [COUNTER, 4], when: { value: [firstValue, firstValue + 4] } });
const mirrored = vb.watch({ kind: 'write', at: [0x05010010, 4] });
const elsewhere = vb.watch({ kind: 'write', at: [COUNTER, 4], when: { pc: [0x07000000, 0x10] } });
const later = vb.watch({ kind: 'write', at: [COUNTER, 4], when: { frames: [100, 200] } });
const byte = vb.watch({ kind: 'write', at: COUNTER + 3 });
vb.runFrames(1);
check('an exact value', exact.count, 1);
check('a range of values', ranged.count, 5);
check('a mirror of WRAM is the same memory', mirrored.count > 1000, true);
check('a PC range excludes other code', elsewhere.count, 0);
check('a frame range excludes other frames', later.count, 0);
check('a one-byte watch sees a word written over it', byte.count > 1000, true);
[exact, ranged, mirrored, elsewhere, later, byte].forEach(watch => vb.unwatch(watch));

console.log('\nWRAMEXT');
// a VB Color game switching on 256 KiB of WRAM makes 0x05010010 memory of its own rather than a mirror of 0x05000010;
// the watch has to follow
const wide = await VbMachine.create({ core, rom: buildRom(), sramWindow: 0x4000, hardware: 'vbc' });
const above = wide.watch({ kind: 'write', at: [0x05010010, 4] });
wide.runFrames(1);
check('a mirror while WRAM is 64 KiB', above.count > 0, true);
wide.write16(0x0307f806, 0xc001);   // VBCCTRL: the keyed write that turns VB Color mode on
wide.write16(0x0307f812, 1);   // MEMCTRL: WRAMEXT
above.clear();
wide.runFrames(1);
check('memory of its own once it is 256 KiB', above.count, 0);

console.log('\nReads');
const reads = vb.watch({ kind: 'read', at: [COUNTER, 4], capture: ['r11', 'r12'] });
vb.runFrames(1);
check('the load is a read', reads.hits[0].pc, fold(at.load));
check('... with the value it read', reads.hits[0].value, reads.hits[0].regs.r11);
check('... and the registers asked for', typeof reads.hits[0].regs.r12, 'number');
const both = vb.watch({ kind: 'access', at: [COUNTER, 4] });
vb.unwatch(reads);
vb.runFrames(1);
check('access sees writes and reads', new Set(both.hits.map(hit => hit.kind)).size, 2);
vb.unwatch(both);

console.log('\nStopping on a write');
vb = await open(buildRom());
vb.runFrames(1);
const stopper = vb.watch({ kind: 'write', at: [COUNTER, 4], action: 'stop' });
let result = vb.runFrames(1);
check('the run stops', result.stop?.reason, 'watch');
check('... naming the watch', result.stop?.watch, stopper);
check('... on the store', vb.pc, at.store);
const pending = result.stop.hit;
check('... before the value lands', vb.read32(COUNTER), pending.old);
result = vb.runFrames(1);
check('going on lands it', vb.read32(COUNTER) >= pending.value, true);
check('... and stops at the next lap, not the same write', result.stop?.hit.value, pending.value + 1);
check('... with one hit per write', stopper.count, 2);
vb.unwatch(stopper);
result = vb.step();
check('a step from a stopped store finishes it', vb.pc, at.load);
check('... and the store landed once', vb.read32(COUNTER), pending.value + 1);

console.log('\nCode');
vb = await open(buildRom());
const laps = vb.watch({ kind: 'exec', at: at.loop });
const writesToo = vb.watch({ kind: 'write', at: [COUNTER, 4] });
vb.runFrames(1);
check('an exec watch counts runs of the instruction', laps.count, writesToo.count);
const stopAt = vb.watch({ kind: 'exec', at: at.load, action: 'stop' });
result = vb.runFrames(1);
check('an exec watch can stop', result.stop?.reason === 'watch' && vb.pc === at.load, true);
const lapsBefore = laps.count;
vb.runFrames(1);
check('... and resuming does not count the instruction twice', laps.count, lapsBefore + 1);
vb.unwatch(stopAt);

console.log('\nThe call stack');
vb = await open(buildCallsRom());
const leaf = vb.watch({ kind: 'write', at: [0x05000014, 4], capture: ['stack'], limit: 5 });
const handler = vb.watch({ kind: 'write', at: [0x05000018, 4], capture: ['stack'], limit: 5 });
vb.runFrames(1);
const leafStack = leaf.hits[1].stack;
check('in the leaf: where, then who called it, then who called that',
    leafStack.join(' '), [calls.lstore, calls.fcall, calls.loop].map(fold).join(' '));
const handlerStack = handler.hits[1].stack;
check('in the TRAP handler: two levels', handlerStack.length, 2);
check('... the handler itself', handlerStack[0], fold(calls.hstore));
check('... and the TRAP it came from', [fold(calls.trap), fold(calls.trap + 2)].includes(handlerStack[1]), true);
vb.unwatch(leaf);
vb.unwatch(handler);
vb.followCalls();
vb.runFrames(3);
check('calls and returns balance over many laps', vb.callStack().length <= 3, true);

finish();
