// just enough ELF32 for what only the `.elf` has: the `.map` lists globals only, not file-scope statics (Rumble.c's
// `_rumbleEffectSpec`, MemoryPool's singleton), getBaseClass stubs or DWARF. Parsed here to stay on the frontend

export interface ElfSymbol {
    name: string; // with the ABI's leading underscore
    address: number;
    size: number;
    isFunction: boolean;
}

export interface ElfSection {
    name: string;
    address: number; // 0 for a section never loaded
    size: number;
    allocated: boolean;
    executable: boolean;
    writable: boolean;
    // false for `.bss`, which is zeroed at startup and costs no ROM; `.data` costs RAM and ROM (copied out of it)
    hasContents: boolean;
}

export interface ElfImage {
    symbols: ElfSymbol[];
    sections: ElfSection[];
    section(name: string): Uint8Array | undefined;
    // undefined for an address in no section or in one without contents (`.bss`)
    read(address: number, length: number): Uint8Array | undefined;
}

const ELF_MAGIC = 0x464c457f; // "\x7fELF", little-endian
const ELFCLASS32 = 1;
const ELFDATA2LSB = 1;
const SHT_SYMTAB = 2;
const SHT_NOBITS = 8;
const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const STT_OBJECT = 1;
const STT_FUNC = 2;
const SYMBOL_ENTRY_SIZE = 16;

interface Section {
    name: string;
    type: number;
    flags: number;
    address: number;
    offset: number;
    size: number;
    link: number;
}

// undefined if this is not an image it can read, which only keeps the features built on it off
export function readElf(bytes: Uint8Array): ElfImage | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 52
        || view.getUint32(0, true) !== ELF_MAGIC
        || bytes[4] !== ELFCLASS32
        || bytes[5] !== ELFDATA2LSB) {
        return undefined;
    }

    const sectionHeaderOffset = view.getUint32(32, true);
    const sectionHeaderSize = view.getUint16(46, true);
    const sectionCount = view.getUint16(48, true);
    const sectionNameIndex = view.getUint16(50, true);
    if (sectionHeaderOffset === 0 || sectionCount === 0) {
        return undefined;
    }

    const at = (index: number): number => sectionHeaderOffset + index * sectionHeaderSize;
    if (at(sectionCount) > bytes.byteLength || sectionNameIndex >= sectionCount) {
        return undefined;
    }
    const sectionNames = view.getUint32(at(sectionNameIndex) + 16, true);

    const sections: Section[] = [];
    for (let index = 0; index < sectionCount; index++) {
        const header = at(index);
        const offset = view.getUint32(header + 16, true);
        const size = view.getUint32(header + 20, true);
        const type = view.getUint32(header + 4, true);
        if (type !== SHT_NOBITS && offset + size > bytes.byteLength) {
            continue;
        }
        sections.push({
            name: readString(bytes, sectionNames, bytes.byteLength - sectionNames, view.getUint32(header, true)),
            type,
            flags: view.getUint32(header + 8, true),
            address: view.getUint32(header + 12, true) >>> 0,
            offset,
            size,
            link: view.getUint32(header + 24, true),
        });
    }

    return {
        symbols: readSymbols(bytes, view, sections, at, sectionHeaderSize),
        sections: sections.map(section => ({
            name: section.name,
            address: section.address,
            size: section.size,
            allocated: (section.flags & SHF_ALLOC) !== 0,
            executable: (section.flags & SHF_EXECINSTR) !== 0,
            writable: (section.flags & SHF_WRITE) !== 0,
            hasContents: section.type !== SHT_NOBITS,
        })),
        section: name => {
            const section = sections.find(candidate => candidate.name === name);
            return section && section.type !== SHT_NOBITS
                ? bytes.subarray(section.offset, section.offset + section.size)
                : undefined;
        },
        read: (address, length) => {
            const target = address >>> 0;
            for (const section of sections) {
                // a section at address zero was not loaded anywhere (all debug sections), and would otherwise swallow
                // every low address asked for
                if (section.type === SHT_NOBITS || section.address === 0
                    || target < section.address || target + length > section.address + section.size) {
                    continue;
                }
                const from = section.offset + (target - section.address);
                return bytes.subarray(from, from + length);
            }
            return undefined;
        },
    };
}

function readSymbols(
    bytes: Uint8Array,
    view: DataView,
    sections: Section[],
    at: (index: number) => number,
    sectionHeaderSize: number
): ElfSymbol[] {
    const symbols: ElfSymbol[] = [];
    for (const section of sections) {
        if (section.type !== SHT_SYMTAB) {
            continue;
        }
        // sh_link on a symbol table is the string table its names live in
        const stringHeader = at(section.link);
        if (stringHeader + sectionHeaderSize > bytes.byteLength) {
            continue;
        }
        const stringOffset = view.getUint32(stringHeader + 16, true);
        const stringSize = view.getUint32(stringHeader + 20, true);
        if (stringOffset + stringSize > bytes.byteLength) {
            continue;
        }

        const end = section.offset + section.size;
        for (let entry = section.offset; entry + SYMBOL_ENTRY_SIZE <= end; entry += SYMBOL_ENTRY_SIZE) {
            // st_info's low nibble is the symbol type; only variables and functions are of interest
            const type = view.getUint8(entry + 12) & 0xf;
            if (type !== STT_OBJECT && type !== STT_FUNC) {
                continue;
            }
            const name = readString(bytes, stringOffset, stringSize, view.getUint32(entry, true));
            if (name !== '') {
                symbols.push({
                    name,
                    address: view.getUint32(entry + 4, true) >>> 0,
                    size: view.getUint32(entry + 8, true),
                    isFunction: type === STT_FUNC,
                });
            }
        }
    }
    return symbols;
}

function readString(bytes: Uint8Array, tableOffset: number, tableSize: number, at: number): string {
    if (at >= tableSize) {
        return '';
    }
    let end = tableOffset + at;
    const limit = Math.min(tableOffset + tableSize, bytes.byteLength);
    while (end < limit && bytes[end] !== 0) {
        end++;
    }
    // symbol names are C identifiers, so nothing wider than a byte
    return String.fromCharCode(...bytes.subarray(tableOffset + at, end));
}

// the map names its image like `OUTPUT(build/working/output-beta.elf elf32-v810)`, relative to the project root.
// `build/output.vb` itself says nothing about the build mode
export function readElfPathFromMap(map: string): string | undefined {
    return /^OUTPUT\(([^\s)]+)/m.exec(map)?.[1];
}

// a copy of VES's BuildMode, so reading one out of a ROM does not reach into the build machinery
export enum BuildMode {
    Shipping = 'Shipping',
    Release = 'Release',
    Beta = 'Beta',
    Tools = 'Tools',
    Debug = 'Debug',
}

// a mode is only a set of `-D` flags and not recorded in the output (DWARF's producer string has no defines), but
// each mode gets its own image (`output-beta.elf`). Returns the lower-case name
export function readBuildModeFromMap(map: string): string | undefined {
    const output = readElfPathFromMap(map);
    return output === undefined
        ? undefined
        : /(?:^|\/)output-([A-Za-z]+)\.elf$/.exec(output)?.[1].toLowerCase();
}
