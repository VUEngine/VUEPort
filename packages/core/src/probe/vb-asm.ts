/**
 * A V810 assembler for patching a running machine and writing hooks. Reads `dis` output as it came out (addresses
 * and all) and the usual spellings:
 *
 *     loop:  movhi hi(counter), r0, r10
 *            movea lo(counter), r10, r10
 *            ld.w  0[r10], r11
 *            add   1, r11
 *            st.w  r11, [r10]
 *            br    loop
 *
 * Statements end at a newline or `;` (for one-line patches on a command line), comments start with `#` or `//`,
 * labels end in `:`. Numbers are decimal or `0x` hex, except in branch, `jr` and `jal` targets, where bare hex digits
 * are an address as the disassembler writes them. `hi(x)`/`lo(x)` split an address for a `movhi`/`movea` pair with
 * the sign-extension carry. Directives: `.org`, `.byte`, `.half`, `.word`, `.align`. Tested against the core's
 * disassembler and by running the output, see `tests/probe-asm-probe.mjs`.
 */

export interface VbAsmLine {
    address: number;
    bytes: number[];
    source: string;
}

export interface VbAsmResult {
    origin: number;
    bytes: Uint8Array;
    lines: VbAsmLine[];
    labels: Map<string, number>;
}

export interface VbAsmOptions {
    resolve?: (name: string) => number | undefined; // names from outside the source, a build's symbols
    // so a branch to another ROM mirror (`FFFC2326` from the disassembler while assembling at `0x070C0000`) goes to
    // the same code through the mirror it starts in
    romSize?: number;
}

const PROGRAM_REGISTERS: Record<string, number> = { hp: 2, fp: 2, sp: 3, gp: 4, tp: 5, lp: 31 };
const SYSTEM_REGISTERS: Record<string, number> = {
    eipc: 0, eipsw: 1, fepc: 2, fepsw: 3, ecr: 4, psw: 5, pir: 6, tkcw: 7, chcw: 24, adtre: 25,
};
// branch conditions by name, the disassembler's spellings first
const CONDITIONS: Record<string, number> = {
    v: 0, l: 1, c: 1, e: 2, z: 2, nh: 3, n: 4, t: 5, r: 5, lt: 6, le: 7,
    nv: 8, nl: 9, nc: 9, ne: 10, nz: 10, h: 11, p: 12, f: 13, ge: 14, gt: 15,
};

type Format =
    | { kind: 'reg', opcode: number }               // I: reg1, reg2
    | { kind: 'jmp' }                               // I: [reg1]
    | { kind: 'not' }                               // I: reg1[, reg2]
    | { kind: 'imm5s', opcode: number }             // II: signed imm, reg2
    | { kind: 'imm5u', opcode: number }             // II: unsigned imm, reg2
    | { kind: 'setf' }                              // II: cond, reg2
    | { kind: 'none', opcode: number, imm?: number } // II: no operands
    | { kind: 'trap' }                              // II: vector
    | { kind: 'ldsr' }                              // II: reg2, sysreg
    | { kind: 'stsr' }                              // II: sysreg, reg2
    | { kind: 'bcond', condition: number }          // III
    | { kind: 'jump', opcode: number }              // IV: target
    | { kind: 'imm16', opcode: number, signed: boolean } // V: imm, reg1, reg2
    | { kind: 'load', opcode: number }              // VI: disp[reg1], reg2
    | { kind: 'store', opcode: number }             // VI: reg2, disp[reg1]
    | { kind: 'float', sub: number }                // VII: reg1, reg2
    | { kind: 'float1', sub: number };              // VII: reg2

const INSTRUCTIONS: Record<string, Format> = {
    mov: { kind: 'reg', opcode: 0x00 }, add: { kind: 'reg', opcode: 0x01 }, sub: { kind: 'reg', opcode: 0x02 },
    cmp: { kind: 'reg', opcode: 0x03 }, shl: { kind: 'reg', opcode: 0x04 }, shr: { kind: 'reg', opcode: 0x05 },
    jmp: { kind: 'jmp' }, sar: { kind: 'reg', opcode: 0x07 }, mul: { kind: 'reg', opcode: 0x08 },
    div: { kind: 'reg', opcode: 0x09 }, mulu: { kind: 'reg', opcode: 0x0a }, divu: { kind: 'reg', opcode: 0x0b },
    or: { kind: 'reg', opcode: 0x0c }, and: { kind: 'reg', opcode: 0x0d }, xor: { kind: 'reg', opcode: 0x0e },
    not: { kind: 'not' },
    setf: { kind: 'setf' }, cli: { kind: 'none', opcode: 0x16 }, trap: { kind: 'trap' },
    reti: { kind: 'none', opcode: 0x19 }, halt: { kind: 'none', opcode: 0x1a },
    ldsr: { kind: 'ldsr' }, stsr: { kind: 'stsr' }, sei: { kind: 'none', opcode: 0x1e },
    sch0bsu: { kind: 'none', opcode: 0x1f, imm: 0x00 }, sch0bsd: { kind: 'none', opcode: 0x1f, imm: 0x01 },
    sch1bsu: { kind: 'none', opcode: 0x1f, imm: 0x02 }, sch1bsd: { kind: 'none', opcode: 0x1f, imm: 0x03 },
    orbsu: { kind: 'none', opcode: 0x1f, imm: 0x08 }, andbsu: { kind: 'none', opcode: 0x1f, imm: 0x09 },
    xorbsu: { kind: 'none', opcode: 0x1f, imm: 0x0a }, movbsu: { kind: 'none', opcode: 0x1f, imm: 0x0b },
    ornbsu: { kind: 'none', opcode: 0x1f, imm: 0x0c }, andnbsu: { kind: 'none', opcode: 0x1f, imm: 0x0d },
    xornbsu: { kind: 'none', opcode: 0x1f, imm: 0x0e }, notbsu: { kind: 'none', opcode: 0x1f, imm: 0x0f },
    jr: { kind: 'jump', opcode: 0x2a }, jal: { kind: 'jump', opcode: 0x2b },
    movea: { kind: 'imm16', opcode: 0x28, signed: true }, addi: { kind: 'imm16', opcode: 0x29, signed: true },
    ori: { kind: 'imm16', opcode: 0x2c, signed: false }, andi: { kind: 'imm16', opcode: 0x2d, signed: false },
    xori: { kind: 'imm16', opcode: 0x2e, signed: false }, movhi: { kind: 'imm16', opcode: 0x2f, signed: false },
    'ld.b': { kind: 'load', opcode: 0x30 }, 'ld.h': { kind: 'load', opcode: 0x31 }, 'ld.w': { kind: 'load', opcode: 0x33 },
    'st.b': { kind: 'store', opcode: 0x34 }, 'st.h': { kind: 'store', opcode: 0x35 }, 'st.w': { kind: 'store', opcode: 0x37 },
    'in.b': { kind: 'load', opcode: 0x38 }, 'in.h': { kind: 'load', opcode: 0x39 }, caxi: { kind: 'load', opcode: 0x3a },
    'in.w': { kind: 'load', opcode: 0x3b },
    'out.b': { kind: 'store', opcode: 0x3c }, 'out.h': { kind: 'store', opcode: 0x3d }, 'out.w': { kind: 'store', opcode: 0x3f },
    'cmpf.s': { kind: 'float', sub: 0x00 }, 'cvt.ws': { kind: 'float', sub: 0x02 }, 'cvt.sw': { kind: 'float', sub: 0x03 },
    'addf.s': { kind: 'float', sub: 0x04 }, 'subf.s': { kind: 'float', sub: 0x05 }, 'mulf.s': { kind: 'float', sub: 0x06 },
    'divf.s': { kind: 'float', sub: 0x07 }, xb: { kind: 'float1', sub: 0x08 }, xh: { kind: 'float1', sub: 0x09 },
    rev: { kind: 'float', sub: 0x0a }, 'trnc.sw': { kind: 'float', sub: 0x0b }, mpyhw: { kind: 'float', sub: 0x0c },
};
// the immediate forms share a name with the register forms; the first operand says which is meant
const IMMEDIATE_FORMS: Record<string, Format> = {
    mov: { kind: 'imm5s', opcode: 0x10 }, add: { kind: 'imm5s', opcode: 0x11 }, cmp: { kind: 'imm5s', opcode: 0x13 },
    shl: { kind: 'imm5u', opcode: 0x14 }, shr: { kind: 'imm5u', opcode: 0x15 }, sar: { kind: 'imm5u', opcode: 0x17 },
};
// every branch: b + condition, `br` always and `nop` never, and `setf` with its condition joined on, as the
// disassembler spells it
for (const [name, condition] of Object.entries(CONDITIONS)) {
    if (name !== 't' && name !== 'f' && name !== 'r') {
        INSTRUCTIONS[`b${name}`] = { kind: 'bcond', condition };
    }
}
INSTRUCTIONS.br = { kind: 'bcond', condition: 5 };
INSTRUCTIONS.nop = { kind: 'bcond', condition: 13 };

class AsmError extends Error { }

// throws, naming the line, for anything it cannot assemble
export function assemble(source: string, origin: number, options: VbAsmOptions = {}): VbAsmResult {
    const statements = split(source);
    const labels = new Map<string, number>();

    // first pass: every instruction's size is in its name, so addresses are known before any operand is looked at
    let address = origin >>> 0;
    for (const statement of statements) {
        for (const label of statement.labels) {
            if (labels.has(label)) {
                throw failure(statement, `${label} is defined twice.`);
            }
            labels.set(label, address);
        }
        if (statement.mnemonic) {
            address = (address + sizeOf(statement, labels, options, address)) >>> 0;
        }
    }

    const out: number[] = [];
    const lines: VbAsmLine[] = [];
    address = origin >>> 0;
    const start = address;
    for (const statement of statements) {
        if (!statement.mnemonic) {
            continue;
        }
        if (statement.mnemonic === '.org') {
            const target = evaluate(statement.operands[0] ?? '', labels, options, false, statement) >>> 0;
            if (target < address) {
                throw failure(statement, '.org cannot go backwards.');
            }
            while (address < target) {
                out.push(0);
                address = (address + 1) >>> 0;
            }
            continue;
        }
        const bytes = encode(statement, address, labels, options);
        lines.push({ address, bytes, source: statement.text });
        out.push(...bytes);
        address = (address + bytes.length) >>> 0;
    }
    return { origin: start, bytes: Uint8Array.from(out), lines, labels };
}

interface Statement {
    text: string;
    line: number;
    labels: string[];
    mnemonic?: string;
    operands: string[];
}

function split(source: string): Statement[] {
    const statements: Statement[] = [];
    source.split(/\r?\n/).forEach((raw, index) => {
        const withoutComment = raw.replace(/(#|\/\/).*$/, '');
        for (const part of withoutComment.split(';')) {
            let text = part.trim();
            // a line pasted from `dis` starts with its address and maybe the PC marker
            text = text.replace(/^>?\s*0x[0-9a-f]{8}\s+/i, '');
            const labels: string[] = [];
            let match: RegExpExecArray | null;
            while ((match = /^([A-Za-z_.$][\w.$]*)\s*:(?!:)\s*/.exec(text))) {
                labels.push(match[1]);
                text = text.slice(match[0].length);
            }
            if (!text && labels.length === 0) {
                continue;
            }
            const head = /^(\S+)\s*(.*)$/.exec(text);
            statements.push({
                text: part.trim(),
                line: index + 1,
                labels,
                mnemonic: head ? head[1].toLowerCase() : undefined,
                operands: head && head[2].trim() ? splitOperands(head[2]) : [],
            });
        }
    });
    return statements;
}

// a comma inside `hi(...)` is not a separator
function splitOperands(text: string): string[] {
    const operands: string[] = [];
    let depth = 0;
    let current = '';
    for (const character of text) {
        if (character === '(' || character === '[') {
            depth++;
        } else if (character === ')' || character === ']') {
            depth--;
        }
        if (character === ',' && depth === 0) {
            operands.push(current.trim());
            current = '';
        } else {
            current += character;
        }
    }
    operands.push(current.trim());
    return operands;
}

function sizeOf(statement: Statement, labels: Map<string, number>, options: VbAsmOptions, address: number): number {
    const mnemonic = statement.mnemonic!;
    switch (mnemonic) {
        case '.byte': return statement.operands.length;
        case '.half': case '.hword': return statement.operands.length * 2;
        case '.word': return statement.operands.length * 4;
        case '.align': {
            const to = evaluate(statement.operands[0] ?? '2', labels, options, false, statement);
            return (to - (address % to)) % to;
        }
        case '.org': {
            const target = evaluate(statement.operands[0] ?? '', labels, options, false, statement) >>> 0;
            return Math.max(0, target - address);
        }
    }
    const format = formatOf(statement);
    switch (format.kind) {
        case 'jump': case 'imm16': case 'load': case 'store': case 'float': case 'float1':
            return 4;
        default:
            return 2;
    }
}

function formatOf(statement: Statement): Format {
    const mnemonic = statement.mnemonic!;
    // `setfz r10` as the disassembler writes it, or `setf z, r10`
    if (mnemonic.startsWith('setf') && mnemonic !== 'setf') {
        if (CONDITIONS[mnemonic.slice(4)] === undefined) {
            throw failure(statement, `Unknown condition in ${mnemonic}.`);
        }
        return { kind: 'setf' };
    }
    const immediate = IMMEDIATE_FORMS[mnemonic];
    // anything spelt like a register is meant as one, so `r32` is reported as a bad register, not an unknown name
    if (immediate && statement.operands[0] !== undefined && !isRegister(statement.operands[0])
        && !/^r\d+$/i.test(statement.operands[0].trim())) {
        return immediate;
    }
    const format = INSTRUCTIONS[mnemonic];
    if (!format) {
        throw failure(statement, `Unknown instruction "${mnemonic}".`);
    }
    return format;
}

function encode(statement: Statement, address: number, labels: Map<string, number>, options: VbAsmOptions): number[] {
    const mnemonic = statement.mnemonic!;
    const ops = statement.operands;
    const value = (text: string | undefined, target = false): number => {
        if (text === undefined || text === '') {
            throw failure(statement, 'An operand is missing.');
        }
        return evaluate(text, labels, options, target, statement);
    };

    switch (mnemonic) {
        case '.byte': return ops.map(op => checked(value(op), -0x80, 0xff, statement, 'byte') & 0xff);
        case '.half': case '.hword': return ops.flatMap(op => halves(checked(value(op), -0x8000, 0xffff, statement, 'half')));
        case '.word': return ops.flatMap(op => { const word = value(op) >>> 0; return [...halves(word & 0xffff), ...halves(word >>> 16)]; });
        case '.align': return new Array(sizeOf(statement, labels, options, address)).fill(0);
    }

    const format = formatOf(statement);
    const reg = (text: string | undefined): number => register(text, statement);
    const count = (expected: number): void => {
        if (ops.length !== expected) {
            throw failure(statement, `${mnemonic} takes ${expected} operand${expected === 1 ? '' : 's'}.`);
        }
    };
    const one = (opcode: number, reg2: number, low: number): number[] => halves((opcode << 10) | (reg2 << 5) | (low & 0x1f));
    const two = (first: number, second: number): number[] => [...halves(first), ...halves(second)];

    switch (format.kind) {
        case 'reg':
            count(2);
            return one(format.opcode, reg(ops[1]), reg(ops[0]));
        case 'jmp': {
            count(1);
            const match = /^\[\s*(\w+)\s*\]$/.exec(ops[0]);
            if (!match) {
                throw failure(statement, 'jmp takes a register in brackets, [lp].');
            }
            return one(0x06, 0, reg(match[1]));
        }
        case 'not': {
            if (ops.length !== 1 && ops.length !== 2) {
                throw failure(statement, 'not takes a register, or a source and a destination.');
            }
            const source = reg(ops[0]);
            return one(0x0f, ops.length === 2 ? reg(ops[1]) : source, source);
        }
        case 'imm5s':
            count(2);
            return one(format.opcode, reg(ops[1]), checked(value(ops[0]), -16, 15, statement, 'a five-bit signed immediate'));
        case 'imm5u':
            count(2);
            return one(format.opcode, reg(ops[1]), checked(value(ops[0]), 0, 31, statement, 'a shift of 0 to 31'));
        case 'setf': {
            const joined = mnemonic !== 'setf' ? CONDITIONS[mnemonic.slice(4)] : undefined;
            count(joined !== undefined ? 1 : 2);
            const condition = joined ?? conditionOf(ops[0], labels, options, statement);
            return one(0x12, reg(ops[ops.length - 1]), condition);
        }
        case 'none':
            count(0);
            return one(format.opcode, 0, format.imm ?? 0);
        case 'trap':
            count(1);
            return one(0x18, 0, checked(value(ops[0]), 0, 31, statement, 'a TRAP vector of 0 to 31'));
        case 'ldsr':
            count(2);
            return one(0x1c, reg(ops[0]), systemRegister(ops[1], labels, options, statement));
        case 'stsr':
            count(2);
            return one(0x1d, reg(ops[1]), systemRegister(ops[0], labels, options, statement));
        case 'bcond': {
            if (mnemonic === 'nop') {
                count(0);
                return halves(0x8000 | (13 << 9));
            }
            count(1);
            const displacement = displacementTo(value(ops[0], true), address, options);
            if (displacement < -256 || displacement > 254 || displacement & 1) {
                throw failure(statement, `${ops[0]} is out of a branch's reach (±256 bytes); use jr.`);
            }
            return halves(0x8000 | (format.condition << 9) | (displacement & 0x1ff));
        }
        case 'jump': {
            count(1);
            const displacement = displacementTo(value(ops[0], true), address, options);
            if (displacement < -0x2000000 || displacement > 0x1fffffe || displacement & 1) {
                throw failure(statement, `${ops[0]} is out of reach of ${mnemonic} (±32 MiB).`);
            }
            return two((format.opcode << 10) | ((displacement >> 16) & 0x3ff), displacement & 0xffff);
        }
        case 'imm16': {
            count(3);
            const immediate = checked(value(ops[0]), -0x8000, 0xffff, statement, 'a 16-bit immediate');
            return two((format.opcode << 10) | (reg(ops[2]) << 5) | reg(ops[1]), immediate & 0xffff);
        }
        case 'load': {
            count(2);
            const memory = memoryOperand(ops[0], labels, options, statement);
            return two((format.opcode << 10) | (reg(ops[1]) << 5) | memory.base, memory.displacement & 0xffff);
        }
        case 'store': {
            count(2);
            const memory = memoryOperand(ops[1], labels, options, statement);
            return two((format.opcode << 10) | (reg(ops[0]) << 5) | memory.base, memory.displacement & 0xffff);
        }
        case 'float':
            count(2);
            return two((0x3e << 10) | (reg(ops[1]) << 5) | reg(ops[0]), format.sub << 10);
        case 'float1':
            count(1);
            return two((0x3e << 10) | (reg(ops[0]) << 5), format.sub << 10);
    }
}

// taken in the code's own mirror of the cartridge when the two are mirrors of each other
function displacementTo(target: number, address: number, options: VbAsmOptions): number {
    let to = target >>> 0;
    const rom = options.romSize;
    if (rom && (to >>> 24 & 7) === 7 && (address >>> 24 & 7) === 7) {
        to = ((address & ~(rom - 1)) | (to & (rom - 1))) >>> 0;
    }
    return (to - address) | 0;
}

function memoryOperand(text: string, labels: Map<string, number>, options: VbAsmOptions, statement: Statement): { base: number, displacement: number } {
    const match = /^(.*)\[\s*(\w+)\s*\]$/.exec(text.trim());
    if (!match) {
        throw failure(statement, `"${text}" is not a memory operand; write disp[reg], e.g. -8[sp].`);
    }
    const displacement = match[1].trim() === '' ? 0 : evaluate(match[1], labels, options, false, statement);
    return { base: register(match[2], statement), displacement: checked(displacement, -0x8000, 0xffff, statement, 'a 16-bit displacement') };
}

function isRegister(text: string): boolean {
    const name = text.trim().toLowerCase();
    return /^r([0-9]|[12][0-9]|3[01])$/.test(name) || PROGRAM_REGISTERS[name] !== undefined;
}

function register(text: string | undefined, statement: Statement): number {
    const name = (text ?? '').trim().toLowerCase();
    const numbered = /^r([0-9]|[12][0-9]|3[01])$/.exec(name);
    if (numbered) {
        return Number(numbered[1]);
    }
    const alias = PROGRAM_REGISTERS[name];
    if (alias === undefined) {
        throw failure(statement, `"${text ?? ''}" is not a register.`);
    }
    return alias;
}

function systemRegister(text: string, labels: Map<string, number>, options: VbAsmOptions, statement: Statement): number {
    const named = SYSTEM_REGISTERS[text.trim().toLowerCase()];
    return named ?? checked(evaluate(text, labels, options, false, statement), 0, 31, statement, 'a system register of 0 to 31');
}

function conditionOf(text: string, labels: Map<string, number>, options: VbAsmOptions, statement: Statement): number {
    const named = CONDITIONS[text.trim().toLowerCase()];
    return named ?? checked(evaluate(text, labels, options, false, statement), 0, 15, statement, 'a condition of 0 to 15');
}

function checked(value: number, min: number, max: number, statement: Statement, what: string): number {
    if (value < min || value > max) {
        throw failure(statement, `${value} does not fit ${what}.`);
    }
    return value;
}

function halves(value: number): number[] {
    return [value & 0xff, (value >>> 8) & 0xff];
}

function failure(statement: Statement, message: string): AsmError {
    return new AsmError(`line ${statement.line}, "${statement.text}": ${message}`);
}

// numbers, names, `+` and `-`, parentheses, and `hi(x)` / `lo(x)`; in a branch target bare hex digits are an address
function evaluate(text: string, labels: Map<string, number>, options: VbAsmOptions, target: boolean, statement: Statement): number {
    const tokens = text.match(/0x[0-9a-f]+|[\w.$:]+|[-+()]/gi) ?? [];
    if (tokens.join('') !== text.replace(/\s+/g, '')) {
        throw failure(statement, `Cannot read "${text}".`);
    }
    let at = 0;
    const peek = (): string | undefined => tokens[at];
    const take = (): string | undefined => tokens[at++];

    const primary = (): number => {
        const token = take();
        if (token === undefined) {
            throw failure(statement, `"${text}" ends too soon.`);
        }
        if (token === '-') {
            return -primary();
        }
        if (token === '+') {
            return primary();
        }
        if (token === '(') {
            const inner = sum();
            if (take() !== ')') {
                throw failure(statement, `A ")" is missing in "${text}".`);
            }
            return inner;
        }
        const lower = token.toLowerCase();
        if ((lower === 'hi' || lower === 'lo') && peek() === '(') {
            take();
            const inner = sum();
            if (take() !== ')') {
                throw failure(statement, `A ")" is missing in "${text}".`);
            }
            // movea sign-extends its half, so the high half carries one more when the low half reads as negative
            return lower === 'hi' ? ((inner + 0x8000) >>> 16) & 0xffff : inner & 0xffff;
        }
        if (/^0x[0-9a-f]+$/i.test(token)) {
            return parseInt(token, 16);
        }
        if (labels.has(token)) {
            return labels.get(token)!;
        }
        if (target && /^[0-9a-f]+$/i.test(token)) {
            return parseInt(token, 16);
        }
        if (/^\d+$/.test(token)) {
            return Number(token);
        }
        if (/^\d/.test(token)) {
            throw failure(statement, `"${token}" is not a number; hex is written 0x${token}.`);
        }
        const resolved = options.resolve?.(token);
        if (resolved !== undefined) {
            return resolved;
        }
        throw failure(statement, `Unknown name "${token}".`);
    };
    const sum = (): number => {
        let result = primary();
        while (peek() === '+' || peek() === '-') {
            const operator = take();
            const right = primary();
            result = operator === '+' ? result + right : result - right;
        }
        return result;
    };
    const total = sum();
    if (at !== tokens.length) {
        throw failure(statement, `Cannot read "${text}".`);
    }
    return total;
}
