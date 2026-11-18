import { readDwarfVariables, VesType, VesTypeKind } from '../browser/core/emulator-dwarf';
import { ElfSymbol, readElf } from '../browser/core/emulator-elf';
import { EMPTY_LINE_TABLE, parseDwarfLineTable, romOffsetOf, VesLineTable } from '../browser/core/emulator-line-table';
import { findFunctionAt, findSymbolAt, functionDisplayName, indexElfSymbols, SymbolIndex } from '../browser/core/emulator-symbols';

// a symbol, or a field or element of one
export interface VbExtent {
    address: number;
    size: number; // at least one byte, even for a symbol the linker gave no size
    type?: VesType;
}

const MAX_DEPTH = 8; // how deep a path is followed into nested structs and arrays

// a build's names for its addresses, both ways, on the same index as the debug panels (`Actor::update` for
// VUEngine methods, bare C names otherwise). With DWARF, fields have names too: `actors[3].position.x`
export class VbSymbols {

    protected readonly byName = new Map<string, ElfSymbol>(); // every name a symbol answers to

    protected constructor(
        readonly index: SymbolIndex,
        readonly lines: VesLineTable,
        // global variables' types, by their names in C
        readonly variables: Map<string, VesType>,
        protected readonly romSize: number,
        symbols: ElfSymbol[],
    ) {
        for (const symbol of symbols) {
            const bare = symbol.name.replace(/^_/, '');
            for (const name of [symbol.name, bare, functionDisplayName(index, symbol.name)]) {
                // the first wins, so a name both a function and a local label carry is the function's
                if (!this.byName.has(name)) {
                    this.byName.set(name, symbol);
                }
            }
        }
    }

    // undefined for bytes that are not an `.elf`
    static fromElf(bytes: Uint8Array, romSize: number): VbSymbols | undefined {
        const image = readElf(bytes);
        if (!image) {
            return undefined;
        }
        const section = image.section('.debug_line');
        const lines = section ? parseDwarfLineTable(section, romSize) : EMPTY_LINE_TABLE;
        return new VbSymbols(indexElfSymbols(image), lines, readDwarfVariables(image), romSize, image.symbols);
    }

    // by any of its names: `_main`, `main`, `Actor_update` or `Actor::update`
    lookup(name: string): ElfSymbol | undefined {
        return this.byName.get(name);
    }

    // a symbol, or a path into one: `g_stats.lives`, `actors[3]`, `actors[3].position.x`
    locate(path: string): VbExtent | undefined {
        const match = /^([^.[\]]+)(.*)$/.exec(path.trim());
        if (!match) {
            return undefined;
        }
        const symbol = this.lookup(match[1]);
        if (!symbol) {
            return undefined;
        }
        let type = this.typeOf(symbol);
        let address = symbol.address >>> 0;
        let size = Math.max(symbol.size, type?.byteSize ?? 0, 1);
        const steps = match[2].match(/\.[A-Za-z_]\w*|\[\d+\]/g) ?? [];
        if (steps.join('') !== match[2]) {
            throw new Error(`Cannot follow "${match[2]}" in "${path}".`);
        }
        for (const step of steps) {
            if (step.startsWith('.')) {
                const name = step.slice(1);
                const member = type?.kind === VesTypeKind.STRUCT ? type.struct?.members.find(candidate => candidate.name === name) : undefined;
                if (!member) {
                    throw new Error(`${path}: ${type ? `${type.name} has no member "${name}"` : 'the build has no type to look members up in'}.`);
                }
                address += member.offset;
                type = member.type;
            } else {
                const index = Number(step.slice(1, -1));
                const element = type?.kind === VesTypeKind.ARRAY ? type.element : undefined;
                if (!element || element.byteSize === 0) {
                    throw new Error(`${path}: ${type ? `${type.name} is not an array` : 'the build has no type to index'}.`);
                }
                if (type?.count !== undefined && index >= type.count) {
                    throw new Error(`${path}: index ${index} is past the end of ${type.name}.`);
                }
                address += index * element.byteSize;
                type = element;
            }
            size = Math.max(type.byteSize, 1);
        }
        return { address: address >>> 0, size, type };
    }

    // `function+0x1c` for code, `g_stats.lives` or `table[3]+0x2` for data, undefined where the build names nothing
    describe(address: number): string | undefined {
        const at = address >>> 0;
        if (isRomAddress(at)) {
            const code = findFunctionAt(this.index, at, this.romSize);
            if (code) {
                const offset = romOffsetOf(at, this.romSize) - romOffsetOf(code.address, this.romSize);
                return withOffset(functionDisplayName(this.index, code.name), offset);
            }
        }
        const data = findSymbolAt(this.index, at);
        if (!data) {
            return undefined;
        }
        const name = data.symbol.name.replace(/^_/, '');
        const type = this.typeOf(data.symbol);
        if (!type) {
            return withOffset(name, data.offset);
        }
        const inside = pathWithin(type, data.offset, 0);
        return withOffset(name + inside.path, inside.within);
    }

    functionAt(address: number): ElfSymbol | undefined {
        return findFunctionAt(this.index, address >>> 0, this.romSize);
    }

    sourceAt(address: number): { file: string, line: number } | undefined {
        const entry = this.lines.locate(romOffsetOf(address >>> 0, this.romSize));
        return entry && !entry.end ? { file: entry.file, line: entry.line } : undefined;
    }

    protected typeOf(symbol: ElfSymbol): VesType | undefined {
        if (symbol.isFunction) {
            return undefined;
        }
        return this.variables.get(symbol.name.replace(/^_/, '')) ?? this.variables.get(symbol.name);
    }
}

// the field and element path a byte belongs to, and its offset into that innermost thing
function pathWithin(type: VesType, offset: number, depth: number): { path: string, within: number } {
    if (depth < MAX_DEPTH && type.kind === VesTypeKind.STRUCT && type.struct) {
        for (const member of type.struct.members) {
            const end = member.offset + Math.max(member.type.byteSize, 1);
            if (offset >= member.offset && offset < end) {
                const inner = pathWithin(member.type, offset - member.offset, depth + 1);
                return { path: `.${member.name}${inner.path}`, within: inner.within };
            }
        }
    }
    if (depth < MAX_DEPTH && type.kind === VesTypeKind.ARRAY && type.element && type.element.byteSize > 0) {
        const index = Math.floor(offset / type.element.byteSize);
        if (type.count === undefined || index < type.count) {
            const inner = pathWithin(type.element, offset - index * type.element.byteSize, depth + 1);
            return { path: `[${index}]${inner.path}`, within: inner.within };
        }
    }
    return { path: '', within: offset };
}

// the cartridge ROM window or its mirror at the top of memory
function isRomAddress(address: number): boolean {
    return (address >>> 24 & 0x07) === 0x07;
}

function withOffset(name: string, offset: number): string {
    return offset === 0 ? name : `${name}+0x${offset.toString(16)}`;
}
