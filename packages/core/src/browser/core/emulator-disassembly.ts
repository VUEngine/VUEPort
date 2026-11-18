import { DisassemblyLine } from '../../common/vb-protocol';
import { romOffsetOf, VesLineTable } from './emulator-line-table';
import { findFunctionAt, findSymbolAt, functionDisplayName, SymbolIndex } from './emulator-symbols';

// annotations for a disassembly listing from the build's symbols, kept apart from the panel so they can be checked
// against a real build without a browser

export interface DisassemblyOwner {
    name: string;
    address: number;
    size: number; // as the linker recorded it, 0 where it recorded none
}

export interface DisassemblyRow {
    line: DisassemblyLine;
    header?: DisassemblyOwner; // only on the first line of a routine
    owner?: DisassemblyOwner;
    targets: Map<number, { address: number; label: string }>; // keyed by operand index
    loaded?: { address: number; label: string }; // what a movhi/movea pair built, if it names something
    // the line begins inside the instruction before it, so it is no real instruction. Only a core whose vbuCodeSize
    // sizes a conditional branch at four bytes instead of two produces these (the second halfword after every branch);
    // checked so a non-instruction is never drawn as one, whichever core is loaded
    adrift?: boolean;
    // only where it differs from the line before, so a mixed listing reads as a line of C followed by its instructions
    source?: { file: string; line: number };
}

// the registers the disassembler writes by name; everything else is rN
const NAMED_REGISTERS: Record<string, number> = {
    hp: 2, fp: 2, sp: 3, gp: 4, tp: 5, lp: 31,
};

export function registerOf(operand: string): number | undefined {
    const named = NAMED_REGISTERS[operand];
    if (named !== undefined) {
        return named;
    }
    const numbered = /^r(\d{1,2})$/.exec(operand);
    if (!numbered) {
        return undefined;
    }
    const index = Number(numbered[1]);
    return index < 32 ? index : undefined;
}

// the worker writes immediates with 0x and addresses as eight bare hex digits, which tells them apart without
// knowing the instruction
export function targetOf(operand: string): number | undefined {
    return /^[0-9A-F]{8}$/.test(operand) ? Number.parseInt(operand, 16) >>> 0 : undefined;
}

// a 16-bit immediate is sign-extended the way the machine reads it
export function immediateOf(operand: string): number | undefined {
    const match = /^0x([0-9A-F]{1,8})$/.exec(operand);
    if (!match) {
        return undefined;
    }
    const value = Number.parseInt(match[1], 16);
    return match[1].length <= 4 && (value & 0x8000) !== 0 ? value - 0x10000 : value;
}

// by the top six bits: below 0x28 one halfword, from 0x28 up two, the same rule the CPU fetches by
function sizeOf(line: DisassemblyLine): number {
    if (line.code.length < 2) {
        return line.code.length;
    }
    const opcode = ((line.code[1] << 8) | line.code[0]) >>> 10;
    return opcode < 0x28 ? 2 : 4;
}

function offsetText(offset: number): string {
    return `+0x${offset.toString(16).toUpperCase()}`;
}

// one pass, as headers and pointers built by a movhi/movea pair depend on the lines before. `romBytes` is the
// cartridge size, to map a PC in the mirror at the top of memory back to a ROM offset
export function annotateDisassembly(
    lines: DisassemblyLine[], symbols: SymbolIndex | undefined, romBytes: number,
): DisassemblyRow[] {
    const owners = new Map<number, DisassemblyOwner | undefined>();

    const ownerOf = (address: number): DisassemblyOwner | undefined => {
        if (owners.has(address)) {
            return owners.get(address);
        }
        let owner: DisassemblyOwner | undefined;
        if (symbols && romBytes > 0) {
            const found = findFunctionAt(symbols, address, romBytes);
            if (found) {
                owner = {
                    name: functionDisplayName(symbols, found.name),
                    address: found.address,
                    size: found.size,
                };
            }
        }
        owners.set(address, owner);
        return owner;
    };

    // inside the current routine a target is shown as an offset only (a loop going back to its top)
    const labelFor = (address: number, within?: DisassemblyOwner): string | undefined => {
        const owner = ownerOf(address);
        if (!owner) {
            return undefined;
        }
        const offset = address - owner.address;
        if (within && owner.address === within.address) {
            return offset === 0 ? owner.name : offsetText(offset);
        }
        return offset === 0 ? owner.name : `${owner.name}${offsetText(offset)}`;
    };

    const dataLabelFor = (address: number): string | undefined => {
        if (!symbols) {
            return undefined;
        }
        const found = findSymbolAt(symbols, address);
        if (!found) {
            return undefined;
        }
        const name = found.symbol.name.replace(/^_/, '');
        return found.offset === 0 ? name : `${name}${offsetText(found.offset)}`;
    };

    const rows: DisassemblyRow[] = [];
    let held = new Map<number, number>(); // register values known from movhi/movea pairs, per routine
    let previous: DisassemblyOwner | undefined;
    let first = true;

    for (const line of lines) {
        const owner = ownerOf(line.address);
        const changed = first || owner?.address !== previous?.address;
        if (changed) {
            held = new Map();
        }

        const row: DisassemblyRow = {
            line,
            owner,
            header: changed && owner ? owner : undefined,
            targets: new Map(),
        };

        line.operands.forEach((operand, index) => {
            const target = targetOf(operand);
            if (target === undefined) {
                return;
            }
            const label = labelFor(target, owner);
            if (label !== undefined) {
                row.targets.set(index, { address: target, label });
            }
        });

        trackPointer(line, held, row, dataLabelFor);

        rows.push(row);
        previous = owner;
        first = false;
    }

    for (let index = 1; index < rows.length; index++) {
        const before = rows[index - 1].line;
        if (rows[index].line.address !== ((before.address + sizeOf(before)) >>> 0)) {
            rows[index].adrift = true;
        }
    }

    return rows;
}

// separate from annotateDisassembly as it needs .debug_line, which may turn up later. Modifies the rows in place,
// so a panel can add it without disassembling again. `romBytes` maps a PC in the top mirror back to a row's offset
export function attachSourceLines(
    rows: DisassemblyRow[], lines: VesLineTable | undefined, romBytes: number
): DisassemblyRow[] {
    if (!lines || romBytes <= 0) {
        return rows;
    }
    let previous: { file: string; line: number } | undefined;
    for (const row of rows) {
        const found = lines.locate(romOffsetOf(row.line.address, romBytes));
        if (!found) {
            row.source = undefined;
            // a gap between two functions belongs to neither, so the next row with a line always shows it
            previous = undefined;
            continue;
        }
        row.source = previous !== undefined
            && previous.file === found.file && previous.line === found.line
            ? undefined
            : { file: found.file, line: found.line };
        previous = { file: found.file, line: found.line };
    }
    return rows;
}

// the movhi and movea that build a pointer are often several instructions apart. Anything else writing the register
// makes it unknown, as a possibly false name is worse than none
function trackPointer(
    line: DisassemblyLine,
    held: Map<number, number>,
    row: DisassemblyRow,
    dataLabelFor: (address: number) => string | undefined,
): void {
    const mnemonic = line.mnemonic.toLowerCase();
    const isPair = mnemonic === 'movhi' || mnemonic === 'movea';
    const [imm, source, destination] = line.operands;
    const value = isPair && imm !== undefined ? immediateOf(imm) : undefined;
    const from = isPair && source !== undefined ? registerOf(source) : undefined;
    const to = isPair && destination !== undefined ? registerOf(destination) : undefined;

    if (to === undefined || value === undefined || from === undefined) {
        // the destination is always the last operand
        const written = registerOf(line.operands[line.operands.length - 1] ?? '');
        if (written !== undefined && written !== 0) {
            held.delete(written);
        }
        return;
    }

    const base = from === 0 ? 0 : held.get(from);
    if (base === undefined) {
        held.delete(to);
        return;
    }
    const built = (mnemonic === 'movhi' ? base + (value << 16) : base + value) >>> 0;
    held.set(to, built);
    if (mnemonic === 'movea') {
        const label = dataLabelFor(built);
        if (label !== undefined) {
            row.loaded = { address: built, label };
        }
    }
}
