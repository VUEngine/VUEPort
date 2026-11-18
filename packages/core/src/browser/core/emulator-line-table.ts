/**
 * A build's line table both ways: a line to break at, and an address to name in a stack frame (`v810-addr2line` only
 * goes one way and costs a process per lookup). parseDwarfLineTable reads `.debug_line` from the `.elf` without a
 * toolchain and is the only source that knows `is_stmt` and sequence ends; parseDecodedLineTable reads
 * `v810-objdump --dwarf=decodedline` output, for a host with the tool but not the image.
 */

export interface VesLineEntry {
    offset: number; // into the ROM, not an address (see romOffsetOf)
    file: string;
    line: number;
    // the first address past a sequence's code; without it an address in a gap between two functions would be blamed
    // on whatever line came last
    end?: boolean;
}

export interface VesLineTable {
    readonly files: string[];
    readonly entries: VesLineEntry[]; // ordered by address
    // falls through to the next line with code, so a breakpoint on a blank line, comment or declaration lands
    // somewhere sensible
    resolve(file: string, line: number): VesLineEntry | undefined;
    locate(offset: number): VesLineEntry | undefined;
}

export const EMPTY_LINE_TABLE: VesLineTable = {
    files: [],
    entries: [],
    resolve: () => undefined,
    locate: () => undefined,
};

// how far a breakpoint may slide to find code: past a comment block or declarations, but not into the next function
const MAX_LINE_SLIDE = 25;

// `CU: /path/to/file.c:` starts a unit and sets the current file
const UNIT_PATTERN = /^CU:\s*(.*?):?\s*$/;
// a bare `/path/to/file.h:` switches files inside a unit
const FILE_PATTERN = /^(\/.*?|[A-Za-z]:[\\/].*?|[^\s:]+\.[ch]):\s*$/;
// `Name.c   123   0x7000abc`
const ROW_PATTERN = /^(\S+)\s+(\d+)\s+0x([0-9a-fA-F]+)\s*$/;

// the cartridge is mirrored across the top of the address space and boots from 0xFFFFFFF0, so code DWARF calls
// 0x070FFFC0 runs at 0xFFFFFFC0. Hence everything is kept as ROM offsets
const CART_WINDOW_MASK = 0x00ffffff;

// whichever window the address came through
export function romOffsetOf(address: number, romSize: number): number {
    const withinWindow = (address >>> 0) & CART_WINDOW_MASK;
    return romSize > 0 ? withinWindow % romSize : withinWindow;
}

// mapPath turns the recorded path into the one the user edits
export function parseDecodedLineTable(
    text: string,
    romSize: number,
    mapPath: (recorded: string) => string = path => path
): VesLineTable {
    const entries: VesLineEntry[] = [];
    const files = new Set<string>();
    const mapped = new Map<string, string>();
    let current = '';

    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();
        if (line === '') {
            continue;
        }

        const unit = UNIT_PATTERN.exec(line);
        const file = unit ? undefined : FILE_PATTERN.exec(line);
        if (unit || file) {
            const recorded = (unit?.[1] ?? file?.[1]) as string;
            let resolved = mapped.get(recorded);
            if (resolved === undefined) {
                resolved = mapPath(recorded);
                mapped.set(recorded, resolved);
            }
            current = resolved;
            files.add(current);
            continue;
        }

        const row = ROW_PATTERN.exec(line);
        // skips the header, as the tool prints the unit before any row
        if (!row || current === '') {
            continue;
        }
        entries.push({
            offset: romOffsetOf(parseInt(row[3], 16), romSize),
            file: current,
            line: parseInt(row[2], 10),
        });
    }

    return buildLineTable(entries, files);
}

function buildLineTable(entries: VesLineEntry[], files: Set<string>): VesLineTable {
    entries.sort((a, b) => a.offset - b.offset || (a.end ? 1 : 0) - (b.end ? 1 : 0));

    // lowest address per line, where a breakpoint goes: a line generates code in several places (loop header, inlined
    // body), and the first reads as "the line ran"
    const byLine = new Map<string, VesLineEntry>();
    for (const entry of entries) {
        if (entry.end) {
            continue;
        }
        const key = `${entry.file} ${entry.line}`;
        const existing = byLine.get(key);
        if (existing === undefined || entry.offset < existing.offset) {
            byLine.set(key, entry);
        }
    }

    return {
        files: [...files].sort(),
        entries,
        resolve(file: string, line: number): VesLineEntry | undefined {
            for (let at = line; at <= line + MAX_LINE_SLIDE; at++) {
                const found = byLine.get(`${file} ${at}`);
                if (found) {
                    return found;
                }
            }
            return undefined;
        },
        locate(offset: number): VesLineEntry | undefined {
            // the last row at or before the address, as rows mark where a line's code starts
            let low = 0;
            let high = entries.length - 1;
            let found: VesLineEntry | undefined;
            while (low <= high) {
                const middle = (low + high) >> 1;
                if (entries[middle].offset <= offset) {
                    found = entries[middle];
                    low = middle + 1;
                } else {
                    high = middle - 1;
                }
            }
            // past the end of a sequence is in no function
            return found?.end ? undefined : found;
        },
    };
}

// little-endian, as the only target is
class DwarfCursor {
    at: number;
    protected readonly view: DataView;

    constructor(protected readonly bytes: Uint8Array, at = 0) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.at = at;
    }

    get done(): boolean {
        return this.at >= this.bytes.byteLength;
    }

    u8(): number {
        return this.bytes[this.at++];
    }

    i8(): number {
        return (this.bytes[this.at++] << 24) >> 24;
    }

    u16(): number {
        const value = this.view.getUint16(this.at, true);
        this.at += 2;
        return value;
    }

    u32(): number {
        const value = this.view.getUint32(this.at, true);
        this.at += 4;
        return value;
    }

    uleb(): number {
        let result = 0;
        let shift = 0;
        for (;;) {
            const byte = this.bytes[this.at++];
            result += (byte & 0x7f) * Math.pow(2, shift);
            if ((byte & 0x80) === 0) {
                return result;
            }
            shift += 7;
        }
    }

    sleb(): number {
        let result = 0;
        let shift = 0;
        let byte = 0;
        do {
            byte = this.bytes[this.at++];
            result += (byte & 0x7f) * Math.pow(2, shift);
            shift += 7;
        } while ((byte & 0x80) !== 0);
        // sign-extend from the last byte's sixth bit
        const limit = Math.pow(2, shift);
        return (byte & 0x40) !== 0 ? result - limit : result;
    }

    string(): string {
        const start = this.at;
        while (this.at < this.bytes.byteLength && this.bytes[this.at] !== 0) {
            this.at++;
        }
        const text = LATIN1.decode(this.bytes.subarray(start, this.at));
        this.at++;
        return text;
    }
}

// paths in this section are bytes, not UTF-8, and only ever ASCII
const LATIN1 = new TextDecoder('latin1');

// only the opcodes that move state are named
const DW_LNS_COPY = 1;
const DW_LNS_ADVANCE_PC = 2;
const DW_LNS_ADVANCE_LINE = 3;
const DW_LNS_SET_FILE = 4;
const DW_LNS_CONST_ADD_PC = 8;
const DW_LNS_FIXED_ADVANCE_PC = 9;
const DW_LNE_END_SEQUENCE = 1;
const DW_LNE_SET_ADDRESS = 2;

// version 5 rearranges the file table
const MIN_DWARF_VERSION = 2;
const MAX_DWARF_VERSION = 4;

interface DwarfFiles {
    names: string[]; // one-based as the opcodes index it, 0 is the unit itself
}

// `.debug_line` is a bytecode program for a state machine, run per compilation unit. Units of unknown versions are
// skipped rather than guessed at, costing only themselves. Rows are ROM offsets, hence `romSize`; `mapPath` rewrites
// recorded paths into openable ones
export function parseDwarfLineTable(
    section: Uint8Array,
    romSize: number,
    mapPath: (recorded: string) => string = path => path
): VesLineTable {
    const entries: VesLineEntry[] = [];
    const files = new Set<string>();
    const mapped = new Map<string, string>();
    const resolvePath = (recorded: string): string => {
        let resolved = mapped.get(recorded);
        if (resolved === undefined) {
            resolved = mapPath(recorded);
            mapped.set(recorded, resolved);
        }
        return resolved;
    };

    const cursor = new DwarfCursor(section);
    while (!cursor.done) {
        const unitStart = cursor.at;
        const unitLength = cursor.u32();
        // 0xfffffff0 and up are reserved; 0xffffffff introduces 64-bit DWARF, which a 32-bit target does not produce
        if (unitLength === 0 || unitLength >= 0xfffffff0) {
            break;
        }
        const unitEnd = cursor.at + unitLength;
        if (unitEnd > section.byteLength) {
            break;
        }

        readUnit(cursor, unitEnd, romSize, resolvePath, entries, files);
        cursor.at = unitEnd;
        if (cursor.at <= unitStart) {
            break;
        }
    }

    return buildLineTable(entries, files);
}

function readUnit(
    cursor: DwarfCursor,
    unitEnd: number,
    romSize: number,
    resolvePath: (recorded: string) => string,
    entries: VesLineEntry[],
    files: Set<string>
): void {
    const version = cursor.u16();
    if (version < MIN_DWARF_VERSION || version > MAX_DWARF_VERSION) {
        return;
    }

    const headerLength = cursor.u32();
    const programStart = cursor.at + headerLength;
    const minimumInstructionLength = cursor.u8();
    // maximum_operations_per_instruction, from version 4, always 1 on a machine without VLIW
    if (version >= 4) {
        cursor.u8();
    }
    cursor.u8(); // default_is_stmt, which nothing here distinguishes on
    const lineBase = cursor.i8();
    const lineRange = cursor.u8();
    const opcodeBase = cursor.u8();

    // operand counts per standard opcode, to step over the ones not handled
    const operands: number[] = [0];
    for (let opcode = 1; opcode < opcodeBase; opcode++) {
        operands.push(cursor.u8());
    }

    const directories: string[] = [''];
    for (;;) {
        const directory = cursor.string();
        if (directory === '') {
            break;
        }
        directories.push(directory);
    }

    const table: DwarfFiles = { names: [''] };
    for (;;) {
        const name = cursor.string();
        if (name === '') {
            break;
        }
        const directory = cursor.uleb();
        cursor.uleb(); // modification time
        cursor.uleb(); // length
        table.names.push(joinPath(directories[directory] ?? '', name));
    }

    cursor.at = programStart;
    runProgram(
        cursor, unitEnd, { lineBase, lineRange, opcodeBase, minimumInstructionLength },
        operands, table, romSize, resolvePath, entries, files);
}

function joinPath(directory: string, name: string): string {
    if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name) || directory === '') {
        return name;
    }
    return `${directory.replace(/[\\/]+$/, '')}/${name}`;
}

interface DwarfLineHeader {
    lineBase: number;
    lineRange: number;
    opcodeBase: number;
    minimumInstructionLength: number;
}

function runProgram(
    cursor: DwarfCursor,
    unitEnd: number,
    header: DwarfLineHeader,
    operands: number[],
    table: DwarfFiles,
    romSize: number,
    resolvePath: (recorded: string) => string,
    entries: VesLineEntry[],
    files: Set<string>
): void {
    let address = 0;
    let file = 1;
    let line = 1;

    const emit = (end = false): void => {
        const name = table.names[file];
        if (name === undefined || name === '') {
            return;
        }
        const path = resolvePath(name);
        files.add(path);
        entries.push({
            offset: romOffsetOf(address, romSize),
            file: path,
            line,
            ...(end ? { end: true } : {}),
        });
    };

    while (cursor.at < unitEnd) {
        const opcode = cursor.u8();

        if (opcode >= header.opcodeBase) {
            const adjusted = opcode - header.opcodeBase;
            address += header.minimumInstructionLength * Math.floor(adjusted / header.lineRange);
            line += header.lineBase + (adjusted % header.lineRange);
            emit();
            continue;
        }

        if (opcode === 0) {
            const length = cursor.uleb(); // extended opcode
            const next = cursor.at + length;
            const sub = length === 0 ? 0 : cursor.u8();
            if (sub === DW_LNE_END_SEQUENCE) {
                emit(true);
                address = 0;
                file = 1;
                line = 1;
            } else if (sub === DW_LNE_SET_ADDRESS) {
                address = cursor.u32();
            }
            cursor.at = next;
            continue;
        }

        switch (opcode) {
            case DW_LNS_COPY:
                emit();
                break;
            case DW_LNS_ADVANCE_PC:
                address += header.minimumInstructionLength * cursor.uleb();
                break;
            case DW_LNS_ADVANCE_LINE:
                line += cursor.sleb();
                break;
            case DW_LNS_SET_FILE:
                file = cursor.uleb();
                break;
            case DW_LNS_CONST_ADD_PC:
                address += header.minimumInstructionLength
                    * Math.floor((255 - header.opcodeBase) / header.lineRange);
                break;
            case DW_LNS_FIXED_ADVANCE_PC:
                address += cursor.u16(); // the one advance that is not scaled, and not a LEB128
                break;
            default:
                // the rest only set flags this does not read
                for (let left = operands[opcode] ?? 0; left > 0; left--) {
                    cursor.uleb();
                }
        }
    }
}

/**
 * Best guess first. DWARF paths are relative to where the build ran (`build/working/objects/...`); rather than decode
 * `.debug_info` abbreviations for the compilation directory, candidates come from the ROM's path, as a VUEngine build
 * puts the ROM in `build/` and runs from the project above it. Hosts take the first that opens; an absolute path stands
 * alone. `romDirectory` has no trailing slash.
 */
export function sourcePathCandidates(recorded: string, romDirectory: string): string[] {
    const path = recorded.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
        return [path];
    }
    const directory = romDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
    const parent = directory.replace(/\/[^/]+$/, '');
    return [
        `${parent}/${path}`,
        `${directory}/${path}`,
    ];
}

// a part of a build (the game, the engine, or a plugin)
export interface VesSourceRoot {
    name: string; // as it appears in the generated path
    root: string; // absolute path the component's own `source/` sits under
}

/**
 * DWARF names the Virtual C preprocessor's output under `build/working`; this applies the same rewrite as the build
 * does to compiler diagnostics (processGCCOutput.sh), replacing everything up to
 * `build/working/objects/<mode>/<component>` or `build/working/headers/<component>` with that component's root. Paths
 * from `#line` directives match nothing and pass through.
 *
 * Line numbers need no fixing, as generated files number like their sources (see the preprocessor's readme.md,
 * "Deviations"). ROMs built with a preprocessor older than that may be slightly off.
 */
export function makeSourcePathMapper(roots: VesSourceRoot[]): (recorded: string) => string {
    // longest first, so a component whose name prefixes another's cannot claim its paths
    const ordered = [...roots].sort((a, b) => b.name.length - a.name.length);

    return recorded => {
        // the build leaves `//` behind (config.make lists plugins as `vuengine//actors/...`)
        const normalized = recorded.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
        for (const { name, root } of ordered) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(
                `^.*build/working/(?:objects/[a-z]+|headers)/${escaped}/(.*)$`
            );
            const match = pattern.exec(normalized);
            if (match) {
                return `${root.replace(/\/+$/, '')}/${match[1]}`.replace(/\/{2,}/g, '/');
            }
        }
        return recorded;
    };
}

// the reverse of makeSourcePathMapper, which is not invertible (components can share a root), so every known path is
// mapped and the one landing on the file is taken
export function recordedPathFor(
    table: VesLineTable,
    mapPath: (recorded: string) => string,
    source: string
): string | undefined {
    const wanted = source.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    return table.files.find(file => mapPath(file) === wanted);
}

export function needsSourcePathMapping(text: string): boolean {
    return /build\/working\/(?:objects|headers)\//.test(text);
}
