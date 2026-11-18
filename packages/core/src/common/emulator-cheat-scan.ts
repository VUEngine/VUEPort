/**
 * Searching memory for the address behind a number on screen, the Action Replay loop: snapshot memory, keep every
 * address that matches a value the player typed or a change since the last pass ("it went down" works for a health bar
 * with no number), and repeat until the survivors converge. A relative first pass keeps every address, as nothing has
 * been ruled out yet. Pure, snapshots in and candidate offsets out, so it is testable without an emulator.
 */

// the VB is little-endian, so a halfword at n is bytes[n] | bytes[n+1] << 8. Signed types are offered as well,
// as searching for -1 in a u16 finds nothing
export enum ScanDataType {
    U8 = 'u8',
    S8 = 's8',
    U16 = 'u16',
    S16 = 's16',
    U32 = 'u32',
    S32 = 's32',
}

export const SCAN_DATA_TYPES: ScanDataType[] = [
    ScanDataType.U8,
    ScanDataType.S8,
    ScanDataType.U16,
    ScanDataType.S16,
    ScanDataType.U32,
    ScanDataType.S32,
];

// the first four compare against a number the player gave, the last four against the previous pass
export type ScanOperator =
    | 'eq'
    | 'ne'
    | 'gt'
    | 'lt'
    | 'changed'
    | 'unchanged'
    | 'increased'
    | 'decreased';

export const SCAN_OPERATORS: ScanOperator[] = [
    'eq', 'ne', 'gt', 'lt', 'changed', 'unchanged', 'increased', 'decreased',
];

export function scanOperatorNeedsValue(op: ScanOperator): boolean {
    return op === 'eq' || op === 'ne' || op === 'gt' || op === 'lt';
}

export function scanValueBytes(type: ScanDataType): 1 | 2 | 4 {
    switch (type) {
        case ScanDataType.U8:
        case ScanDataType.S8:
            return 1;
        case ScanDataType.U16:
        case ScanDataType.S16:
            return 2;
        case ScanDataType.U32:
        case ScanDataType.S32:
            return 4;
    }
}

export function scanTypeIsSigned(type: ScanDataType): boolean {
    return type === ScanDataType.S8 || type === ScanDataType.S16 || type === ScanDataType.S32;
}

// little-endian and sign-extended, as the program would see it. Too few bytes read as 0 rather than throwing,
// so a truncated snapshot does not take the panel down
export function readScanValue(bytes: Uint8Array, offset: number, type: ScanDataType): number {
    const width = scanValueBytes(type);
    if (offset < 0 || offset + width > bytes.length) {
        return 0;
    }
    let value = 0;
    for (let i = 0; i < width; i++) {
        value |= bytes[offset + i] << (i * 8);
    }
    if (scanTypeIsSigned(type)) {
        // the shifts above already sign-extend 32 bits, narrower values need to be told where their sign bit is
        const bits = width * 8;
        return bits === 32 ? value | 0 : (value << (32 - bits)) >> (32 - bits);
    }
    return value >>> 0;
}

function matches(
    current: number,
    previous: number, // only read by the relative operators
    op: ScanOperator,
    value: number | undefined, // only read by the absolute ones
): boolean {
    switch (op) {
        case 'eq':
            return value !== undefined && current === value;
        case 'ne':
            return value !== undefined && current !== value;
        case 'gt':
            return value !== undefined && current > value;
        case 'lt':
            return value !== undefined && current < value;
        case 'changed':
            return current !== previous;
        case 'unchanged':
            return current === previous;
        case 'increased':
            return current > previous;
        case 'decreased':
            return current < previous;
    }
}

// aligned, as the V810 wants aligned loads, so offsets in between would only invent candidates straddling two
// variables. Also halves or quarters the work and the list
function alignedOffsets(length: number, width: number): number[] {
    const offsets: number[] = [];
    for (let offset = 0; offset + width <= length; offset += width) {
        offsets.push(offset);
    }
    return offsets;
}

// a relative operator has nothing to compare to yet, so it keeps everything; scanNext does the narrowing
export function scanFirst(
    current: Uint8Array,
    type: ScanDataType,
    op: ScanOperator,
    value?: number,
): Uint32Array {
    const width = scanValueBytes(type);
    const offsets = alignedOffsets(current.length, width);
    if (!scanOperatorNeedsValue(op)) {
        return Uint32Array.from(offsets);
    }
    const kept: number[] = [];
    for (const offset of offsets) {
        const reading = readScanValue(current, offset, type);
        if (matches(reading, reading, op, value)) {
            kept.push(offset);
        }
    }
    return Uint32Array.from(kept);
}

// candidates are only ever removed, which is why the panel keeps the earlier sets, so a pass that narrowed too far can
// be taken back
export function scanNext(
    candidates: Uint32Array,
    previous: Uint8Array, // the snapshot of the last pass, so "decreased" means since then
    current: Uint8Array,
    type: ScanDataType,
    op: ScanOperator,
    value?: number,
): Uint32Array {
    const kept: number[] = [];
    for (const offset of candidates) {
        const before = readScanValue(previous, offset, type);
        const after = readScanValue(current, offset, type);
        if (matches(after, before, op, value)) {
            kept.push(offset);
        }
    }
    return Uint32Array.from(kept);
}
