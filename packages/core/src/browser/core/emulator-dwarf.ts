// just enough DWARF for member offsets and types, which the debug sections have in every build mode. VUEngine's class
// macro flattens inheritance (`Actor_str` carries `Container`'s and `Entity`'s fields inline, in that order), so a
// subclass' own struct describes the whole object

import { ElfImage } from './emulator-elf';

export enum VesTypeKind {
    SIGNED = 'signed',
    UNSIGNED = 'unsigned',
    BOOL = 'bool',
    FLOAT = 'float',
    POINTER = 'pointer',
    STRUCT = 'struct', // its members are spliced in by the reader
    ARRAY = 'array',
    OPAQUE = 'opaque', // shown as raw bytes
}

export interface VesType {
    kind: VesTypeKind;
    name: string; // as the source wrote it: `int16`, `Vector3D`
    byteSize: number;
    struct?: VesStruct;
    element?: VesType;
    count?: number; // for ARRAY, where the build says
}

export interface VesStructMember {
    name: string;
    offset: number;
    type: VesType;
    bitSize?: number; // bitfields only
    // in bits from the start of the struct, little-endian already applied, so the value is `(bits >> bitOffset) & mask`
    // over the whole struct. Both DWARF bitfield forms are normalized to this
    bitOffset?: number;
}

export interface VesStruct {
    name: string;
    byteSize: number;
    members: VesStructMember[];
}

const TAG_ARRAY = 0x01;
const TAG_ENUM = 0x04;
const TAG_MEMBER = 0x0d;
const TAG_POINTER = 0x0f;
const TAG_STRUCT = 0x13;
const TAG_TYPEDEF = 0x16;
const TAG_BASE = 0x24;
const TAG_CONST = 0x26;
const TAG_VOLATILE = 0x35;
const TAG_UNION = 0x17;
const TAG_COMPILE_UNIT = 0x11;
const TAG_SUBRANGE = 0x21;
const TAG_VARIABLE = 0x34;

const AT_NAME = 0x03;
const AT_BYTE_SIZE = 0x0b;
const AT_BIT_SIZE = 0x0d;
const AT_BIT_OFFSET = 0x0c;
const AT_MEMBER_LOCATION = 0x38;
const AT_DECLARATION = 0x3c;
const AT_ENCODING = 0x3e;
const AT_TYPE = 0x49;
const AT_DATA_BIT_OFFSET = 0x6b;
const AT_UPPER_BOUND = 0x2f;
const AT_COUNT = 0x37;
const AT_SPECIFICATION = 0x47;

const ATE_BOOLEAN = 0x02;
const ATE_FLOAT = 0x04;
const ATE_SIGNED = 0x05;
const ATE_SIGNED_CHAR = 0x06;
const ATE_UNSIGNED = 0x07;
const ATE_UNSIGNED_CHAR = 0x08;

const MAX_TYPE_DEPTH = 16; // typedefs and qualifiers followed before giving up

interface Die {
    tag: number;
    attributes: Map<number, number | string>;
    children: Die[];
}

// empty for an image without debug sections, which only turns off field-level inspection
export function readDwarfStructs(image: ElfImage): Map<string, VesStruct> {
    const parsed = parseDwarf(image);
    if (!parsed) {
        return new Map();
    }
    const structs = new Map<string, VesStruct>();
    for (const [name, die] of parsed.definitions) {
        structs.set(name, resolveStruct(name, die, parsed.dies, parsed.resolved));
    }
    return structs;
}

// turns an address inside a global back into its field (four bytes into `g_stats` is `lives`). Statics of the same
// name in two files get the first one's type, as the symbol table cannot tell them apart either
export function readDwarfVariables(image: ElfImage): Map<string, VesType> {
    const parsed = parseDwarf(image);
    const variables = new Map<string, VesType>();
    if (!parsed) {
        return variables;
    }
    // definitions first, as an `extern int16 table[];` in a header has no bounds
    const ordered = [
        ...parsed.variables.filter(die => !die.attributes.has(AT_DECLARATION)),
        ...parsed.variables.filter(die => die.attributes.has(AT_DECLARATION)),
    ];
    for (const die of ordered) {
        // a definition of something declared elsewhere only links to the declaration, which has the name and type
        const declaration = parsed.dies.get(numberAttribute(die, AT_SPECIFICATION) ?? -1);
        const name = die.attributes.get(AT_NAME) ?? declaration?.attributes.get(AT_NAME);
        const type = die.attributes.get(AT_TYPE) ?? declaration?.attributes.get(AT_TYPE);
        if (typeof name !== 'string' || type === undefined || variables.has(name)) {
            continue;
        }
        variables.set(name, resolveType(type, parsed.dies, parsed.resolved));
    }
    return variables;
}

interface ParsedDwarf {
    dies: Map<number, Die>;
    definitions: Map<string, Die>;
    variables: Die[]; // file-scope only, declarations and definitions alike
    resolved: Map<Die, VesStruct>;
}

// both readers want the same tree, and it is not small
const parsedImages = new WeakMap<ElfImage, ParsedDwarf | undefined>();

function parseDwarf(image: ElfImage): ParsedDwarf | undefined {
    if (parsedImages.has(image)) {
        return parsedImages.get(image);
    }
    const info = image.section('.debug_info');
    const abbreviations = image.section('.debug_abbrev');
    let parsed: ParsedDwarf | undefined;
    if (info && abbreviations) {
        parsed = { dies: new Map(), definitions: new Map(), variables: [], resolved: new Map() };
        const reader = new DwarfReader(info, abbreviations, image.section('.debug_str'), parsed.dies, parsed.definitions, parsed.variables);
        reader.readUnits();
    }
    parsedImages.set(image, parsed);
    return parsed;
}

// keeps only what struct layouts and global variables are made of
class DwarfReader {

    constructor(
        protected readonly info: Uint8Array,
        protected readonly abbreviations: Uint8Array,
        protected readonly strings: Uint8Array | undefined,
        protected readonly dies: Map<number, Die>,
        protected readonly definitions: Map<string, Die>,
        protected readonly variables: Die[]
    ) { }

    protected readonly view = new DataView(this.info.buffer, this.info.byteOffset, this.info.byteLength);

    readUnits(): void {
        let at = 0;
        while (at + 11 <= this.info.byteLength) {
            const unitLength = this.view.getUint32(at, true);
            const end = at + 4 + unitLength;
            // stopping at a broken length keeps whatever was read before it
            if (unitLength === 0 || end > this.info.byteLength) {
                return;
            }
            const version = this.view.getUint16(at + 4, true);
            const abbreviationOffset = this.view.getUint32(at + 6, true);
            const addressSize = this.info[at + 10];
            // 2 to 4 share this header layout; 5 changed it and is left alone rather than misread
            if (version >= 2 && version <= 4) {
                this.readUnit(at + 11, end, at, addressSize, this.readAbbreviations(abbreviationOffset));
            }
            at = end;
        }
    }

    protected readAbbreviations(offset: number): Map<number, { tag: number, hasChildren: boolean, attributes: [number, number][] }> {
        const table = new Map<number, { tag: number, hasChildren: boolean, attributes: [number, number][] }>();
        let at = offset;
        while (at < this.abbreviations.byteLength) {
            const [code, afterCode] = uleb(this.abbreviations, at);
            at = afterCode;
            if (code === 0) {
                break;
            }
            const [tag, afterTag] = uleb(this.abbreviations, at);
            at = afterTag;
            const hasChildren = this.abbreviations[at++] !== 0;
            const attributes: [number, number][] = [];
            for (;;) {
                const [attribute, afterAttribute] = uleb(this.abbreviations, at);
                const [form, afterForm] = uleb(this.abbreviations, afterAttribute);
                at = afterForm;
                if (attribute === 0 && form === 0) {
                    break;
                }
                attributes.push([attribute, form]);
            }
            table.set(code, { tag, hasChildren, attributes });
        }
        return table;
    }

    protected readUnit(
        start: number,
        end: number,
        unitOffset: number,
        addressSize: number,
        table: Map<number, { tag: number, hasChildren: boolean, attributes: [number, number][] }>
    ): void {
        let at = start;
        const stack: Die[] = [];

        while (at < end) {
            const dieOffset = at;
            const [code, afterCode] = uleb(this.info, at);
            at = afterCode;
            if (code === 0) {
                stack.pop(); // the null entry that closes a run of siblings
                continue;
            }
            const abbreviation = table.get(code);
            if (!abbreviation) {
                return; // without the abbreviation the entry's length is unknown, so the rest is unreadable
            }

            const attributes = new Map<number, number | string>();
            for (const [attribute, form] of abbreviation.attributes) {
                const [value, next] = this.readValue(at, form, addressSize, unitOffset);
                if (value !== undefined) {
                    attributes.set(attribute, value);
                }
                at = next;
            }

            const die: Die = { tag: abbreviation.tag, attributes, children: [] };
            this.dies.set(dieOffset, die);

            const parent = stack[stack.length - 1];
            // only members and an array's subranges are kept as children, nothing else contributes to a layout
            if (parent && (abbreviation.tag === TAG_MEMBER || (abbreviation.tag === TAG_SUBRANGE && parent.tag === TAG_ARRAY))) {
                parent.children.push(die);
            }
            // file-scope only, as a local's address is a frame offset
            if (abbreviation.tag === TAG_VARIABLE && stack.length === 1 && parent.tag === TAG_COMPILE_UNIT) {
                this.variables.push(die);
            }

            const name = attributes.get(AT_NAME);
            // only the definition says how big it is, a declaration is a header's forward reference
            if (abbreviation.tag === TAG_STRUCT && typeof name === 'string'
                && !attributes.has(AT_DECLARATION) && attributes.has(AT_BYTE_SIZE)) {
                this.definitions.set(name, die);
            }

            if (abbreviation.hasChildren) {
                stack.push(die);
            }
        }
    }

    // forms not decoded return undefined but still advance past their bytes
    protected readValue(at: number, form: number, addressSize: number, unitOffset: number): [number | string | undefined, number] {
        switch (form) {
            case 0x01: return [this.view.getUint32(at, true), at + addressSize]; // addr
            case 0x03: return [undefined, at + 2 + this.view.getUint16(at, true)]; // block2
            case 0x04: return [undefined, at + 4 + this.view.getUint32(at, true)]; // block4
            case 0x05: return [this.view.getUint16(at, true), at + 2]; // data2
            case 0x06: return [this.view.getUint32(at, true), at + 4]; // data4
            case 0x07: return [undefined, at + 8]; // data8
            case 0x08: { // string
                const [text, next] = readCString(this.info, at);
                return [text, next];
            }
            case 0x09: { // block
                const [length, next] = uleb(this.info, at);
                return [undefined, next + length];
            }
            case 0x0a: return [undefined, at + 1 + this.info[at]]; // block1
            case 0x0b: return [this.info[at], at + 1]; // data1
            case 0x0c: return [this.info[at], at + 1]; // flag
            case 0x0d: return sleb(this.info, at); // sdata
            case 0x0e: { // strp
                const offset = this.view.getUint32(at, true);
                return [this.strings ? readCString(this.strings, offset)[0] : undefined, at + 4];
            }
            case 0x0f: return uleb(this.info, at); // udata
            case 0x10: return [this.view.getUint32(at, true), at + 4]; // ref_addr
            case 0x11: return [unitOffset + this.info[at], at + 1]; // ref1
            case 0x12: return [unitOffset + this.view.getUint16(at, true), at + 2]; // ref2
            case 0x13: return [unitOffset + this.view.getUint32(at, true), at + 4]; // ref4
            case 0x14: return [undefined, at + 8]; // ref8
            case 0x15: { // ref_udata
                const [value, next] = uleb(this.info, at);
                return [unitOffset + value, next];
            }
            case 0x16: { // indirect: the real form is in the data
                const [actual, next] = uleb(this.info, at);
                return this.readValue(next, actual, addressSize, unitOffset);
            }
            case 0x17: return [this.view.getUint32(at, true), at + 4]; // sec_offset
            case 0x18: { // exprloc
                const [length, next] = uleb(this.info, at);
                return [undefined, next + length];
            }
            case 0x19: return [1, at]; // flag_present, which occupies nothing
            case 0x20: return [undefined, at + 8]; // ref_sig8
            default:
                // an unknown form has an unknown length, so this stops the unit cleanly
                return [undefined, this.info.byteLength];
        }
    }
}

function resolveStruct(
    name: string, die: Die, dies: Map<number, Die>, resolved: Map<Die, VesStruct>
): VesStruct {
    const existing = resolved.get(die);
    if (existing) {
        return existing;
    }
    const struct: VesStruct = { name, byteSize: numberAttribute(die, AT_BYTE_SIZE) ?? 0, members: [] };
    resolved.set(die, struct); // before walking the members, so a self-referencing struct does not recurse forever

    for (const member of die.children) {
        const memberName = member.attributes.get(AT_NAME);
        if (typeof memberName !== 'string') {
            continue;
        }
        const bitSize = numberAttribute(member, AT_BIT_SIZE);
        const offset = numberAttribute(member, AT_MEMBER_LOCATION) ?? 0;
        struct.members.push({
            name: memberName,
            offset,
            type: resolveType(member.attributes.get(AT_TYPE), dies, resolved),
            ...(bitSize !== undefined ? { bitSize, bitOffset: bitPosition(member, offset, bitSize) } : {}),
        });
    }
    return struct;
}

// past typedefs and qualifiers
function resolveType(
    reference: number | string | undefined, dies: Map<string | number, Die> | Map<number, Die>, resolved: Map<Die, VesStruct>
): VesType {
    const unknown: VesType = { kind: VesTypeKind.OPAQUE, name: '?', byteSize: 0 };
    let current = typeof reference === 'number' ? (dies as Map<number, Die>).get(reference) : undefined;
    let label = '';

    for (let depth = 0; current && depth < MAX_TYPE_DEPTH; depth++) {
        const name = current.attributes.get(AT_NAME);
        const byteSize = numberAttribute(current, AT_BYTE_SIZE) ?? 0;

        switch (current.tag) {
            case TAG_TYPEDEF:
                // the first name seen: `int16` reads better than the `short int` it is a typedef for
                label = label || (typeof name === 'string' ? name : '');
                current = (dies as Map<number, Die>).get(numberAttribute(current, AT_TYPE) ?? -1);
                continue;
            case TAG_CONST:
            case TAG_VOLATILE:
                current = (dies as Map<number, Die>).get(numberAttribute(current, AT_TYPE) ?? -1);
                continue;
            case TAG_POINTER:
                return { kind: VesTypeKind.POINTER, name: label || 'pointer', byteSize: byteSize || 4 };
            case TAG_BASE: {
                const encoding = numberAttribute(current, AT_ENCODING);
                const display = label || (typeof name === 'string' ? name : 'base');
                return { kind: baseKind(encoding), name: display, byteSize };
            }
            case TAG_STRUCT: {
                const structName = typeof name === 'string' ? name : (label || 'struct');
                return {
                    kind: VesTypeKind.STRUCT,
                    name: structName,
                    byteSize,
                    struct: resolveStruct(structName, current, dies as Map<number, Die>, resolved),
                };
            }
            case TAG_ENUM:
                return { kind: VesTypeKind.UNSIGNED, name: label || (typeof name === 'string' ? name : 'enum'), byteSize };
            case TAG_ARRAY: {
                const element = resolveType(current.attributes.get(AT_TYPE), dies, resolved);
                const count = elementCount(current);
                return {
                    kind: VesTypeKind.ARRAY,
                    name: label || `${element.name}[${count ?? ''}]`,
                    // GCC gives an array no size of its own
                    byteSize: byteSize || (count !== undefined ? count * element.byteSize : 0),
                    element,
                    ...(count !== undefined ? { count } : {}),
                };
            }
            case TAG_UNION:
                return { kind: VesTypeKind.OPAQUE, name: label || 'union', byteSize };
            default:
                return { ...unknown, name: label || unknown.name, byteSize };
        }
    }
    return unknown;
}

// all dimensions multiplied out, undefined for open bounds (`extern int table[];`)
function elementCount(array: Die): number | undefined {
    let count = 1;
    let any = false;
    for (const subrange of array.children) {
        if (subrange.tag !== TAG_SUBRANGE) {
            continue;
        }
        const upper = numberAttribute(subrange, AT_UPPER_BOUND);
        const length = numberAttribute(subrange, AT_COUNT) ?? (upper !== undefined ? upper + 1 : undefined);
        if (length === undefined) {
            return undefined;
        }
        count *= length;
        any = true;
    }
    return any ? count : undefined;
}

// where a bitfield's low bit is, in bits from the start of the struct. GCC picks the DWARF form by version, not by
// target: version 4's `DW_AT_data_bit_offset` is already that; the older `DW_AT_bit_offset` counts from the most
// significant bit of the field's storage unit, so on a little-endian target it is turned around within that unit
function bitPosition(member: Die, offset: number, bitSize: number): number | undefined {
    const dataBitOffset = numberAttribute(member, AT_DATA_BIT_OFFSET);
    if (dataBitOffset !== undefined) {
        return dataBitOffset;
    }
    const fromTop = numberAttribute(member, AT_BIT_OFFSET);
    const storageBytes = numberAttribute(member, AT_BYTE_SIZE);
    if (fromTop === undefined || storageBytes === undefined) {
        return undefined;
    }
    return offset * 8 + (storageBytes * 8 - fromTop - bitSize);
}

function baseKind(encoding: number | undefined): VesTypeKind {
    switch (encoding) {
        case ATE_BOOLEAN: return VesTypeKind.BOOL;
        case ATE_FLOAT: return VesTypeKind.FLOAT;
        case ATE_SIGNED:
        case ATE_SIGNED_CHAR: return VesTypeKind.SIGNED;
        case ATE_UNSIGNED:
        case ATE_UNSIGNED_CHAR: return VesTypeKind.UNSIGNED;
        default: return VesTypeKind.OPAQUE;
    }
}

function numberAttribute(die: Die, attribute: number): number | undefined {
    const value = die.attributes.get(attribute);
    return typeof value === 'number' ? value : undefined;
}

function uleb(bytes: Uint8Array, at: number): [number, number] {
    let result = 0;
    let shift = 0;
    for (let offset = at; offset < bytes.byteLength; offset++) {
        const byte = bytes[offset];
        result += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if ((byte & 0x80) === 0) {
            return [result, offset + 1];
        }
    }
    return [result, bytes.byteLength];
}

function sleb(bytes: Uint8Array, at: number): [number, number] {
    let result = 0;
    let shift = 0;
    for (let offset = at; offset < bytes.byteLength; offset++) {
        const byte = bytes[offset];
        result += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if ((byte & 0x80) === 0) {
            if ((byte & 0x40) !== 0) {
                result -= Math.pow(2, shift);
            }
            return [result, offset + 1];
        }
    }
    return [result, bytes.byteLength];
}

function readCString(bytes: Uint8Array, at: number): [string, number] {
    let end = at;
    while (end < bytes.byteLength && bytes[end] !== 0) {
        end++;
    }
    return [String.fromCharCode(...bytes.subarray(at, end)), end + 1];
}

export interface VesFieldValue {
    name: string;
    path: string; // qualified by its parents: `transformation.position.x`
    depth: number;
    offset: number; // relative to the immediate parent
    type: VesType;
    value?: number; // where the type decodes to a number
    text: string;
}

const MAX_NESTING = 4;

// nested structs are spliced in rather than summarized, as the leaves are what anyone reading an actor is after.
// `bytes` is a window containing the object, `at` where the object starts within it
export function readStructFields(
    struct: VesStruct, bytes: Uint8Array, at: number, depth = 0, prefix = ''
): VesFieldValue[] {
    const fields: VesFieldValue[] = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (const member of struct.members) {
        const offset = at + member.offset;
        const path = prefix === '' ? member.name : `${prefix}.${member.name}`;

        if (member.type.kind === VesTypeKind.STRUCT && member.type.struct && depth < MAX_NESTING) {
            fields.push(...readStructFields(member.type.struct, bytes, offset, depth + 1, path));
            continue;
        }

        const value = readMemberValue(member, view, at, offset);
        fields.push({
            name: member.name,
            path,
            depth,
            offset: member.offset,
            type: member.type,
            value,
            text: formatValue(member, value),
        });
    }
    return fields;
}

export interface VesMemberAt {
    path: string;
    type: VesType;
    offset: number; // from the start of the whole object, unlike VesFieldValue's
    within: number; // how far into the member the byte is
}

/**
 * Which field a byte of an object belongs to, for a caller holding an address (a hex dump). Offsets come back absolute,
 * unlike VesFieldValue's, which are relative to the immediate parent. Nested structs are descended into, so the answer
 * is a leaf (`position.x`). Arrays are not, as their element type is not kept, so the answer is the array itself and
 * how far into it the byte is.
 */
export function findStructMemberAt(
    struct: VesStruct, offset: number, base = 0, prefix = '', depth = 0
): VesMemberAt | undefined {
    for (const member of struct.members) {
        const start = base + member.offset;
        // a bitfield shares its bytes with its neighbours, so it is reported as covering the ones its type spans
        const end = start + Math.max(member.type.byteSize, 1);
        if (offset < start || offset >= end) {
            continue;
        }
        const path = prefix === '' ? member.name : `${prefix}.${member.name}`;
        if (member.type.kind === VesTypeKind.STRUCT && member.type.struct && depth < MAX_NESTING) {
            const nested = findStructMemberAt(member.type.struct, offset, start, path, depth + 1);
            // padding inside a nested struct falls through to the struct itself
            if (nested) {
                return nested;
            }
        }
        return { path, type: member.type, offset: start, within: offset - start };
    }
    return undefined;
}

function readMemberValue(
    member: VesStructMember, view: DataView, structAt: number, offset: number
): number | undefined {
    if (member.bitSize !== undefined && member.bitOffset !== undefined) {
        return readBits(view, structAt, member.bitOffset, member.bitSize);
    }
    if (offset < 0 || offset + member.type.byteSize > view.byteLength) {
        return undefined;
    }

    const signed = member.type.kind === VesTypeKind.SIGNED;
    switch (member.type.kind) {
        case VesTypeKind.SIGNED:
        case VesTypeKind.UNSIGNED:
        case VesTypeKind.BOOL:
        case VesTypeKind.POINTER:
            switch (member.type.byteSize) {
                case 1: return signed ? view.getInt8(offset) : view.getUint8(offset);
                case 2: return signed ? view.getInt16(offset, true) : view.getUint16(offset, true);
                case 4: return signed ? view.getInt32(offset, true) : view.getUint32(offset, true) >>> 0;
                default: return undefined;
            }
        case VesTypeKind.FLOAT:
            return member.type.byteSize === 4 ? view.getFloat32(offset, true) : undefined;
        default:
            return undefined;
    }
}

// bit by bit, so a field straddling a byte boundary never needs a number wider than the 32 bits a shift can hold
function readBits(view: DataView, structAt: number, bitOffset: number, bitSize: number): number | undefined {
    let result = 0;
    for (let bit = 0; bit < bitSize; bit++) {
        const absolute = bitOffset + bit;
        const at = structAt + (absolute >> 3);
        if (at < 0 || at >= view.byteLength) {
            return undefined;
        }
        if ((view.getUint8(at) >> (absolute & 7)) & 1) {
            result += Math.pow(2, bit);
        }
    }
    return result;
}

function formatValue(member: VesStructMember, value: number | undefined): string {
    if (value === undefined) {
        return '—';
    }
    if (member.bitSize === 1 || member.type.kind === VesTypeKind.BOOL) {
        return value !== 0 ? 'true' : 'false';
    }
    if (member.type.kind === VesTypeKind.POINTER) {
        return value === 0 ? 'NULL' : `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
    }
    if (member.type.kind === VesTypeKind.FLOAT) {
        return String(Math.round(value * 1000) / 1000);
    }
    return String(value);
}
