// the `.elf` (tens of MB on a real project) is read once per ROM; the index keeps only what the inspectors look up,
// so the image can be dropped after

import { readClassHierarchy } from './emulator-classes';
import { readDwarfStructs, VesStruct } from './emulator-dwarf';
import { ElfImage, ElfSection, ElfSymbol } from './emulator-elf';
import { romOffsetOf } from './emulator-line-table';
import { isWram } from '../../common/vb-constants';

export interface SymbolExtent {
    address: number;
    size: number;
}

// finer than the linker's two kinds, as "how much is code" and "how much is artwork" are different questions
export enum MemoryAreaKind {
    CODE = 'code',
    READ_ONLY = 'readOnly',
    DATA = 'data',
    ZEROED = 'zeroed', // costs RAM but no ROM
    POOL = 'pool', // VUEngine's heap, carved out of whichever section holds it
}

export interface MemoryArea {
    name: string; // section name, or `MemoryPool` for the engine's heap
    kind: MemoryAreaKind;
    bytes: number;
}

// in linker order
export interface MemoryFootprint {
    rom: MemoryArea[]; // `.data`'s initializers included
    wram: MemoryArea[];
}

export interface SymbolIndex {
    footprint: MemoryFootprint;
    // MemoryPool's singleton, the whole engine heap: the pools and their bookkeeping in one struct
    memoryPool?: SymbolExtent;
    vTables: Map<number, string>; // by address, turns an allocated block back into its class
    rumbleSpecPointer?: number; // address of Rumble.c's `_rumbleEffectSpec`
    rumbleSpecNames: Map<number, string>;
    classes: Map<string, string>; // class to base, `Object` is its own base
    // by the struct name the class macro gives (`Actor_str` for `Actor`), empty for a build without debug sections
    structs: Map<string, VesStruct>;
    dataSymbols: ElfSymbol[]; // ordered by address
    codeSymbols: ElfSymbol[]; // ordered by address
}

// the last function starting at or before the address, bounded by its size only when the linker recorded one. Unlike
// findSymbolAt, as profiler addresses land mid-function. Compared as ROM offsets, as a PC may come through the
// cartridge window or the mirror at the top of memory
export function findFunctionAt(
    index: SymbolIndex, address: number, romSize: number
): ElfSymbol | undefined {
    const symbols = index.codeSymbols;
    const target = romOffsetOf(address, romSize);

    let low = 0;
    let high = symbols.length - 1;
    let found: ElfSymbol | undefined;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (romOffsetOf(symbols[middle].address, romSize) <= target) {
            found = symbols[middle];
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    if (!found) {
        return undefined;
    }
    const start = romOffsetOf(found.address, romSize);
    return found.size === 0 || target < start + found.size ? found : undefined;
}

// the preprocessor turns `Class::method` into `Class_method` and the linker adds the ABI's underscore; undo both.
// Only a prefix that really is a class becomes `::`, so other functions with underscores are left alone
export function functionDisplayName(index: SymbolIndex, symbol: string): string {
    const name = symbol.replace(/^_/, '');
    const split = name.indexOf('_');
    if (split <= 0) {
        return name;
    }
    const owner = name.slice(0, split);
    return index.classes.has(owner) ? `${owner}::${name.slice(split + 1)}` : name;
}

// with the offset into the symbol, as a spec embedded in a larger structure (an array, a subclass' spec) is pointed
// at from within. A symbol without a size can only be matched exactly
export function findSymbolAt(
    index: SymbolIndex, address: number
): { symbol: ElfSymbol, offset: number } | undefined {
    const symbols = index.dataSymbols;
    const target = address >>> 0;

    let low = 0;
    let high = symbols.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (symbols[middle].address <= target) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    // several symbols can share an address and a smaller one can be nested in a larger, so walk back for the best fit
    for (let at = found; at >= 0; at--) {
        const symbol = symbols[at];
        const end = symbol.address + Math.max(symbol.size, 1);
        if (target >= symbol.address && target < end) {
            return { symbol, offset: target - symbol.address };
        }
        // once candidates start before the widest one seen could reach, nothing further back can cover the address
        if (symbol.address + symbol.size < target && symbol.address !== symbols[found]?.address) {
            break;
        }
    }
    return undefined;
}

export function structNameOf(className: string): string {
    return `${className}_str`;
}

// `__SINGLETON` declares a file-scope static wrapping the instance in a struct with an object footprint, so the
// name has the macro's underscore plus the ABI's, and the symbol is local (not in the `.map`, which lists globals)
const MEMORY_POOL_SYMBOL = '__singletonWrapperMemoryPool';

export const MEMORY_POOL_AREA = 'MemoryPool';
const VTABLE_SUFFIX = '_vTable';
const RUMBLE_SPEC_POINTER_SYMBOL = '__rumbleEffectSpec';
const RUMBLE_SPEC_SUFFIX = 'RumbleEffectSpec';

export function indexElfSymbols(image: ElfImage): SymbolIndex {
    const index: SymbolIndex = {
        footprint: { rom: [], wram: [] },
        vTables: new Map(),
        rumbleSpecNames: new Map(),
        classes: readClassHierarchy(image),
        structs: readDwarfStructs(image),
        dataSymbols: image.symbols
            .filter(symbol => !symbol.isFunction)
            .sort((a, b) => a.address - b.address),
        codeSymbols: image.symbols
            .filter(symbol => symbol.isFunction)
            .sort((a, b) => a.address - b.address),
    };

    for (const symbol of image.symbols) {
        if (symbol.isFunction) {
            continue;
        }
        if (symbol.name === MEMORY_POOL_SYMBOL) {
            index.memoryPool = { address: symbol.address, size: symbol.size };
        } else if (symbol.name === RUMBLE_SPEC_POINTER_SYMBOL) {
            index.rumbleSpecPointer = symbol.address;
        } else if (symbol.name.endsWith(VTABLE_SUFFIX)) {
            index.vTables.set(symbol.address, trim(symbol.name, VTABLE_SUFFIX));
        } else if (symbol.name.endsWith(RUMBLE_SPEC_SUFFIX)) {
            index.rumbleSpecNames.set(symbol.address, trim(symbol.name, RUMBLE_SPEC_SUFFIX));
        }
    }

    // needs the pool found by the loop
    index.footprint = readMemoryFootprint(image, index.memoryPool);

    return index;
}

function sectionKind(section: ElfSection): MemoryAreaKind {
    if (section.executable) {
        return MemoryAreaKind.CODE;
    }
    if (!section.hasContents) {
        return MemoryAreaKind.ZEROED;
    }
    return section.writable ? MemoryAreaKind.DATA : MemoryAreaKind.READ_ONLY;
}

// a section with contents costs ROM wherever it runs, as the cartridge is the only source of its bytes (so `.sdata`
// is in both lists), and a section running in WRAM costs WRAM whether its bytes are in the file or zeroed.
// `MemoryPool` is split out of its section, as in a VUEngine game it is most of both figures
function readMemoryFootprint(image: ElfImage, pool: SymbolExtent | undefined): MemoryFootprint {
    const footprint: MemoryFootprint = { rom: [], wram: [] };
    for (const section of image.sections) {
        if (!section.allocated || section.size === 0) {
            continue;
        }
        const kind = sectionKind(section);
        for (const area of splitAroundPool(section, kind, pool)) {
            if (section.hasContents) {
                footprint.rom.push(area);
            }
            if (isWram(section.address)) {
                footprint.wram.push(area);
            }
        }
    }
    return footprint;
}

// the remainders on either side of the heap are kept even though they are tiny in a VUEngine build
function splitAroundPool(
    section: ElfSection, kind: MemoryAreaKind, pool: SymbolExtent | undefined
): MemoryArea[] {
    const end = section.address + section.size;
    const from = pool ? Math.max(section.address, pool.address) : end;
    const to = pool ? Math.min(end, pool.address + pool.size) : end;
    if (to <= from) {
        return [{ name: section.name, kind, bytes: section.size }];
    }
    return [
        { name: section.name, kind, bytes: from - section.address },
        { name: MEMORY_POOL_AREA, kind: MemoryAreaKind.POOL, bytes: to - from },
        { name: section.name, kind, bytes: end - to },
    ].filter(area => area.bytes > 0);
}

function trim(name: string, suffix: string): string {
    return name.replace(/^_/, '').slice(0, -suffix.length);
}
