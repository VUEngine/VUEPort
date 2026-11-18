// the assembler against the core's disassembler and the CPU: every instruction form with edge operands is disassembled
// and assembled back to the same bytes, so `dis` output can be pasted back in; then a small program has to run. Usage:
// node tests/probe-asm-probe.mjs
import { createRequire } from 'module';
import { check, finish, readCoreWasm } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { VbMachine, assemble } = require('../lib/probe/index.js');

const core = readCoreWasm();
const ROM_SIZE = 0x10000;
const TOP = (0x100000000 - ROM_SIZE) >>> 0;

// every form and its edges, each a list of halfwords
const encodings = [];
const regs = [[0, 1], [31, 3], [10, 20], [2, 4]];
for (let opcode = 0; opcode < 16; opcode++) {
    for (const [reg1, reg2] of regs) {
        if (opcode === 0x06) {
            encodings.push([(opcode << 10) | reg1]);                 // jmp [reg1]
        } else {
            encodings.push([(opcode << 10) | (reg2 << 5) | reg1]);
        }
    }
}
for (const opcode of [0x10, 0x11, 0x13]) {
    for (const imm of [-16, -1, 0, 1, 15]) {
        encodings.push([(opcode << 10) | (7 << 5) | (imm & 0x1f)]);
    }
}
for (const opcode of [0x14, 0x15, 0x17]) {
    for (const imm of [0, 1, 31]) {
        encodings.push([(opcode << 10) | (9 << 5) | imm]);
    }
}
for (let condition = 0; condition < 16; condition++) {
    encodings.push([(0x12 << 10) | (6 << 5) | condition]);       // setf, the condition joined on
}
for (const vector of [0, 5, 31]) {
    encodings.push([(0x18 << 10) | vector]);
}
for (const opcode of [0x16, 0x19, 0x1a, 0x1e]) {
    encodings.push([opcode << 10]);
}
for (const sys of [0, 1, 2, 3, 4, 5, 6, 7, 24, 25]) {
    encodings.push([(0x1c << 10) | (12 << 5) | sys]);
    encodings.push([(0x1d << 10) | (12 << 5) | sys]);
}
for (const sub of [0, 1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15]) {
    encodings.push([(0x1f << 10) | sub]);
}
// NOP (condition 13) is a branch never taken; the disassembler hides its displacement, so only the plain one
// goes round
encodings.push([0x8000 | (13 << 9)]);
for (let condition = 0; condition < 16; condition++) {
    if (condition === 13) {
        continue;
    }
    for (const displacement of [-256, -2, 0, 2, 254]) {
        encodings.push([0x8000 | (condition << 9) | (displacement & 0x1ff)]);
    }
}
for (const opcode of [0x2a, 0x2b]) {
    for (const displacement of [-0x2000000, -0x10, 0x10, 0x1fffffe]) {
        encodings.push([(opcode << 10) | ((displacement >> 16) & 0x3ff), displacement & 0xffff]);
    }
}
for (const opcode of [0x28, 0x29, 0x2c, 0x2d, 0x2e, 0x2f]) {
    for (const imm of [0, 1, 0x7fff, 0x8000, 0xffff]) {
        encodings.push([(opcode << 10) | (11 << 5) | 4, imm]);
    }
}
for (const opcode of [0x30, 0x31, 0x33, 0x34, 0x35, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3f]) {
    for (const displacement of [0, 16, -16, 255, 256, 0x1234, -0x8000, 0x7fff]) {
        encodings.push([(opcode << 10) | (11 << 5) | 3, displacement & 0xffff]);
    }
}
for (const sub of [0, 2, 3, 4, 5, 6, 7, 10, 11, 12]) {
    encodings.push([(0x3e << 10) | (11 << 5) | 4, sub << 10]);
}
for (const sub of [8, 9]) {
    encodings.push([(0x3e << 10) | (11 << 5), sub << 10]);
}

const rom = new Uint8Array(ROM_SIZE);
const view = new DataView(rom.buffer);
const placed = [];
let cursor = 0x1000;
for (const halfwords of encodings) {
    placed.push({ address: (TOP + cursor) >>> 0, halfwords });
    for (const half of halfwords) {
        view.setUint16(cursor, half, true);
        cursor += 2;
    }
}

const vb = await VbMachine.create({ core, rom, sramWindow: 0x4000 });
let same = 0;
const different = [];
for (const { address, halfwords } of placed) {
    const [line] = vb.disassemble(address, 1);
    let bytes;
    try {
        bytes = assemble(line.text, address, { romSize: ROM_SIZE }).bytes;
    } catch (error) {
        different.push(`${line.text}: ${error.message}`);
        continue;
    }
    const expected = halfwords.flatMap(half => [half & 0xff, half >>> 8]);
    if (bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index])) {
        same++;
    } else {
        different.push(`${line.text}: ${[...bytes].map(b => b.toString(16)).join(' ')} vs ${expected.map(b => b.toString(16)).join(' ')}`);
    }
}
console.log(`Round trip through the core's disassembler: ${same} of ${placed.length}`);
check('every form comes back as the bytes it was', different.slice(0, 5), value => value.length === 0);

console.log('\nRunning what it assembles');
const program = `
start:   ldsr  r0, psw                # out of the reset state
         movhi hi(0x05008000), r0, r10   # an address whose low half reads negative
         movea lo(0x05008000), r10, r10
         mov   r0, r11
         movea 10, r0, r12
loop:    add   1, r11                 # count to ten, backwards branch
         cmp   r12, r11
         blt   loop
         st.w  r11, 0[r10]
         setf  e, r13                 # r11 == r12: e is set
         setf  ne, r14
         movea 0x00F0, r0, r15
         not   r15, r16               # ~0xF0
         st.w  r0, 4[r10]
         movea 7, r0, r17             # caxi: compare 0[r10+4] with r17, exchange
         movea 9, r0, r18
         mov   r18, r17
         caxi  4[r10], r17            # memory 0 != r17 (9): r17 = 0, memory stays
         jal   leaf                   # a forward call
         br    done
leaf:    movea 0x55, r0, r19
         jmp   [lp]
done:    br    done
`;
const assembled = assemble(program, 0xfffff000);
const run = new Uint8Array(ROM_SIZE);
run.set(assembled.bytes, 0xf000);
const reset = assemble(`jr ${(0xfffff000).toString(16)}`, 0xfffffff0);
run.set(reset.bytes, 0xfff0);
const machine = await VbMachine.create({ core, rom: run, sramWindow: 0x4000 });
machine.runFrames(1);
const r = machine.registers().program;
check('hi()/lo() build an address movea sign-extends', r[10], 0x05008000);
check('a loop with a backwards branch', machine.read32(0x05008000), 10);
check('setf e', r[13], 1);
check('setf ne', r[14], 0);
check('not with a destination', r[16], ~0xf0 >>> 0);
check('caxi', r[17], 0);
check('a forward call and its return', r[19], 0x55);
check('labels where they were put', machine.pc, assembled.labels.get('done'));
check('a listing line per statement', assembled.lines.length, 23);

console.log('\nMistakes and odds and ends');
const fails = (source, words) => {
    try {
        assemble(source, 0x07000000);
        return false;
    } catch (error) {
        return words.every(word => error.message.includes(word));
    }
};
check('an unknown instruction', fails('jump far', ['Unknown instruction', 'line 1']), true);
check('a branch out of reach', fails('br 0x07001000', ['out of a branch']), true);
check('an immediate that does not fit', fails('add 16, r1', ['does not fit']), true);
check('not a register', fails('mov r32, r1', ['not a register']), true);
check('an unknown name', fails('jal nowhere', ['Unknown name "nowhere"']), true);
check('names from outside', [...assemble('jal main', 0x07000000, { resolve: name => (name === 'main' ? 0x07000100 : undefined) }).bytes].length, 4);
check('a line pasted from dis, address and marker included',
    [...assemble('> 0x07008c96  cmp 0, r10', 0x07008c96).bytes].join(','), [...assemble('cmp 0, r10', 0).bytes].join(','));
const mirrored = assemble('jal 07000100', 0xfff00000, { romSize: 0x100000 });
check('a target in another mirror of the ROM goes to the same code', [...mirrored.bytes].join(','),
    [...assemble('jal 0xFFF00100', 0xfff00000).bytes].join(','));
const data = assemble('.byte 1, 2; .align 4; .half 0x1234; .word 0xDEADBEEF', 0x05000000);
check('directives', [...data.bytes].map(b => b.toString(16)).join(' '), '1 2 0 0 34 12 ef be ad de');
check('statements split by ;', assemble('mov 1, r1; mov 2, r2', 0).bytes.length, 4);

finish();
