// VbMachine against a program whose every instruction is known. Mainly stopping: a breakpoint resumes
// without stopping there again, a step runs exactly what it says, and a run interrupted ten times reaches
// the same state at frame 20 as an uninterrupted one. Usage: node tests/probe-machine-probe.mjs
import { createRequire } from 'module';
import { at, buildEsSoundRom, buildRom, check, COUNTER, ES_SOUND_MARK, finish, readCoreWasm, ROM_SIZE } from './probe-test-rom.mjs';

const ROM_HEADER_AT = ROM_SIZE - 544;

const require = createRequire(import.meta.url);
const { VbMachine } = require('../lib/probe/index.js');

const core = readCoreWasm();
const rom = buildRom();
const open = () => VbMachine.create({ core, rom, sramWindow: 0x4000 });

console.log('Running');
const vb = await open();
let result = vb.runFrames(3);
check('three frames run', result.frames, 3);
check('the frame count follows', vb.frame, 3);
check('no stop', result.stop, undefined);
const counted = vb.read32(COUNTER);
check('the counter moved', counted > 1000, true);
// the frame can end between the add and the store, so r11 may be one ahead
check('the counter is what r11 holds', vb.registers().program[11] - counted, delta => delta === 0 || delta === 1);
check("the debug port said 'A'", vb.terminal, 'A');
check('taking the terminal empties it', vb.takeTerminal() + vb.terminal, 'A');

console.log('\nDeterminism');
const moment = vb.snapshot();
vb.runFrames(5);
const first = vb.read32(COUNTER);
vb.restore(moment);
check('restore puts the frame count back', vb.frame, 3);
vb.runFrames(5);
check('the same five frames again reach the same count', vb.read32(COUNTER), first);

console.log('\nBreakpoints');
vb.addBreakpoint(at.loop);
result = vb.runFrames(1);
check('a breakpoint stops the run', result.stop?.reason, 'breakpoint');
check('... before the instruction', vb.pc, at.loop);
check('... inside the frame', result.frames, 0);
const lap = vb.registers().program[11];
result = vb.runFrames(1);
check('resuming does not stop at the same place again', result.stop?.reason, 'breakpoint');
check('... but after one more lap', vb.registers().program[11], lap + 1);

console.log('\nStepping');
result = vb.step();
check('one step from a breakpoint runs that instruction', vb.pc, at.store);
check('... and says so', result.stop?.reason, 'step');
check('... and add ran', vb.registers().program[11], lap + 2);
vb.step(2);
check('two more run the store and the load', vb.pc, at.branch);
check('... the load has the counter', vb.registers().program[12], lap + 2);
vb.removeBreakpoint(at.loop);

console.log('\nFrames stay where they are');
const straight = await open();
straight.runFrames(20);
const interrupted = await open();
interrupted.addBreakpoint(at.store);
let stops = 0;
while (interrupted.frame < 20) {
    const run = interrupted.runFrames(20 - interrupted.frame);
    if (run.stop) {
        stops++;
        if (stops >= 25) {
            interrupted.removeBreakpoint(at.store);
        }
    }
}
check('the interrupted run stopped', stops >= 25, true);
check('... and still reaches frame 20 in the same state', interrupted.read32(COUNTER), straight.read32(COUNTER));

console.log('\nRun until');
const until = await open();
result = until.runUntil({ pc: at.terminal });
check('until a PC', result.stop?.reason, 'until');
check('... stands on it', until.pc, at.terminal);
check('... before it ran', until.terminal, '');
result = until.runUntil({ frame: 7 });
check('until a frame', until.frame, 7);
result = until.runUntil({ predicate: machine => machine.read32(COUNTER) > counted }, { maxFrames: 50 });
check('until a condition', result.stop?.reason, 'until');
result = until.runUntil({ predicate: () => false }, { maxFrames: 4 });
check('a condition never met gives up without a stop', result.stop === undefined && result.frames === 4, true);

console.log('\nMemory and registers');
vb.write(0x05000100, [1, 2, 3, 4]);
check('bytes written read back', Array.from(vb.read(0x05000100, 4)).join(','), '1,2,3,4');
check('read32 is little-endian', vb.read32(0x05000100), 0x04030201);
vb.write16(0x05000104, 0xbeef);
check('write16', vb.read16(0x05000104), 0xbeef);
vb.setRegister('r20', 1234);
vb.setRegister('sp', 0x0500fff0);
const registers = vb.registers();
check('setRegister r20', registers.program[20], 1234);
check('setRegister by alias', registers.program[3], 0x0500fff0);
check('system registers by name', typeof registers.system.PSW, 'number');
check('addresses resolve from text', vb.resolve('0x05000010'), COUNTER);

console.log('\nSave states');
// finish the frame the steps stopped in: a state does not record where in its frame the probe stood, so
// two states only compare at a frame boundary
vb.runFrames(1);
const file = await vb.saveState('probe');
check('a VESS file', new DataView(file.buffer, file.byteOffset).getUint32(0), 0x56455353);
const elsewhere = await open();
await elsewhere.loadState(file);
check('loads into another machine', elsewhere.registers().program[20], 1234);
check('... with its memory', elsewhere.read32(COUNTER), vb.read32(COUNTER));
elsewhere.runFrames(2);
vb.runFrames(2);
check('... and both go on alike', elsewhere.read32(COUNTER), vb.read32(COUNTER));
let refused = false;
try {
    const other = buildRom();
    other[ROM_HEADER_AT] = 0x5a;
    await (await VbMachine.create({ core, rom: other, sramWindow: 0x4000 })).loadState(file);
} catch {
    refused = true;
}
check("another ROM's state is refused", refused, true);

console.log('\nCode and pictures');
const code = vb.disassemble(at.start, 3);
check('disassembly', code.map(line => line.mnemonic).join(' '), 'movhi movhi movea');
check('... with operands', code[0].text, 'movhi 0x0500, r0, r10');
const png = await vb.screenshot();
check('a PNG', Array.from(png.subarray(1, 4)).map(byte => String.fromCharCode(byte)).join(''), 'PNG');
const both = vb.picture('both');
check('both eyes side by side', both.width, 768);

console.log('\nESSound');
const silent = await VbMachine.create({ core, rom: buildEsSoundRom(), sramWindow: 0x4000 });
silent.runFrames(3);
check('without ESSound the init goes unanswered', silent.read32(ES_SOUND_MARK), 0);
check('... and is not recorded', silent.takeEsSound().length, 0);
const answered = await VbMachine.create({ core, rom: buildEsSoundRom(), sramWindow: 0x4000, esSound: true });
answered.runFrames(3);
check('with ESSound the init is answered with a Game Pak interrupt', answered.read32(ES_SOUND_MARK), 1);
check('... and the command is recorded', answered.takeEsSound().join(','), String(0xffff));
check('... and the handler returned to the game', (answered.registers().system.PSW & 0x4000) === 0, true);

finish();
