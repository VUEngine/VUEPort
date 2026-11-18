// VUEngine identifies a class by the address of its getBaseClass function (`typeofclass(X)` is `&X_getBaseClass`), and
// each of those stubs only returns `&Base_getBaseClass` (movhi, movea, return). Reading them back gives the inheritance
// chain, so a pool block of a project's own class can be recognized as an Actor

import { ElfImage } from './emulator-elf';

const BASE_CLASS_SUFFIX = '_getBaseClass';

const OPCODE_MOVHI = 0b101111;
const OPCODE_MOVEA = 0b101000;

const STUB_BYTES = 8;

export function readClassHierarchy(image: ElfImage): Map<string, string> {
    const names = new Map<number, string>();
    const stubs: { name: string, address: number }[] = [];
    for (const symbol of image.symbols) {
        if (!symbol.isFunction || !symbol.name.endsWith(BASE_CLASS_SUFFIX)) {
            continue;
        }
        const name = symbol.name.replace(/^_/, '').slice(0, -BASE_CLASS_SUFFIX.length);
        names.set(symbol.address, name);
        stubs.push({ name, address: symbol.address });
    }

    const hierarchy = new Map<string, string>();
    for (const stub of stubs) {
        const base = names.get(readReturnedAddress(image, stub.address) ?? -1);
        if (base !== undefined) {
            hierarchy.set(stub.name, base);
        }
    }
    return hierarchy;
}

// undefined if the stub is not shaped the way the compiler emits them, so only that class goes unplaced
function readReturnedAddress(image: ElfImage, address: number): number | undefined {
    const code = image.read(address, STUB_BYTES);
    if (!code || code.byteLength < STUB_BYTES) {
        return undefined;
    }
    const view = new DataView(code.buffer, code.byteOffset, code.byteLength);

    // both are format V: opcode in the top six bits of the first halfword, 16-bit immediate after it
    if (view.getUint16(0, true) >>> 10 !== OPCODE_MOVHI
        || view.getUint16(4, true) >>> 10 !== OPCODE_MOVEA) {
        return undefined;
    }
    const high = view.getUint16(2, true);
    // movea sign-extends, so a low half above 0x7fff borrows from the high one
    const low = view.getInt16(6, true);
    return ((high << 16) + low) >>> 0;
}

// bounded by the number of classes rather than reaching Object, so a cycle cannot hang the caller
export function isSubclassOf(hierarchy: Map<string, string>, name: string, ancestor: string): boolean {
    let current: string | undefined = name;
    for (let step = 0; current !== undefined && step <= hierarchy.size; step++) {
        if (current === ancestor) {
            return true;
        }
        const base: string | undefined = hierarchy.get(current);
        current = base === current ? undefined : base; // Object is its own base
    }
    return false;
}

export function ancestryOf(hierarchy: Map<string, string>, name: string): string[] {
    const chain: string[] = [];
    let current: string | undefined = name;
    for (let step = 0; current !== undefined && step <= hierarchy.size; step++) {
        chain.push(current);
        const base: string | undefined = hierarchy.get(current);
        current = base === current ? undefined : base;
    }
    return chain;
}
