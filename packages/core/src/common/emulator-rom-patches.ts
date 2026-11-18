import Bunzip = require('seek-bzip');
import { crc32 } from './emulator-cheat-database';

export type RomPatchFormat = 'ips' | 'ups' | 'bps' | 'bsdiff';

// vb-color patches are different: a game's colorizations are alternatives with at most one on, applied against the
// original ROM after every other patch and laid over their result (see overlayRomPatch). Shipped ones are switched by
// the colorization settings
export const ROM_PATCH_TYPES = ['hack', 'enhancement', 'compatibility', 'debug', 'trainer', 'translation', 'vb-color'] as const;
export type RomPatchType = typeof ROM_PATCH_TYPES[number];

export function isColorPatch(patch: { type: RomPatchType }): boolean {
    return patch.type === 'vb-color';
}

export type RomPatchStatus =
    // finished and verified against the game from start to end
    | 'complete'
    // playable and correct in most places, with known gaps
    | 'partial'
    // listed so it can be tried, not relied on
    | 'wip';

export interface RomPatch {
    name: string;
    fileName: string;
    format: RomPatchFormat;
    data: Uint8Array;
    enabled: boolean;
    description?: string;
    author?: string;
    type: RomPatchType;
    builtIn?: boolean;
    id?: string;
    version?: string;
    status?: RomPatchStatus;
    enabledByDefault?: boolean; // a shipped patch that is on until the player switches it off (see BuiltInRomPatch)
}

// a malformed patch, or one made for a different source ROM
export class RomPatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RomPatchError';
    }
}

const text = (bytes: Uint8Array, offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));

const requireBytes = (bytes: Uint8Array, offset: number, length: number, what: string): void => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) {
        throw new RomPatchError(`Unexpected end of ${what}.`);
    }
};

// detect by signature; extensions are deliberately not trusted
export function detectRomPatchFormat(data: Uint8Array): RomPatchFormat {
    if (text(data, 0, 5) === 'PATCH') {
        return 'ips';
    }
    if (text(data, 0, 4) === 'UPS1') {
        return 'ups';
    }
    if (text(data, 0, 4) === 'BPS1') {
        return 'bps';
    }
    if (text(data, 0, 8) === 'BSDIFF40') {
        return 'bsdiff';
    }
    throw new RomPatchError('Unsupported or unrecognized ROM patch format.');
}

function readU24BE(data: Uint8Array, offset: number): number {
    requireBytes(data, offset, 3, 'IPS patch');
    return data[offset] * 0x10000 + data[offset + 1] * 0x100 + data[offset + 2];
}

function readU16BE(data: Uint8Array, offset: number): number {
    requireBytes(data, offset, 2, 'IPS patch');
    return data[offset] * 0x100 + data[offset + 1];
}

function resizedCopy(source: Uint8Array, size: number): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new RomPatchError('Invalid patched ROM size.');
    }
    const result = new Uint8Array(size);
    result.set(source.subarray(0, Math.min(source.length, size)));
    return result;
}

function grow(source: Uint8Array, size: number): Uint8Array {
    return size <= source.length ? source : resizedCopy(source, size);
}

function applyIps(source: Uint8Array, patch: Uint8Array): Uint8Array {
    let output: Uint8Array = source.slice();
    let cursor = 5;
    while (true) {
        requireBytes(patch, cursor, 3, 'IPS patch');
        if (text(patch, cursor, 3) === 'EOF') {
            cursor += 3;
            break;
        }
        const offset = readU24BE(patch, cursor);
        const length = readU16BE(patch, cursor + 3);
        cursor += 5;
        if (length === 0) {
            const runLength = readU16BE(patch, cursor);
            requireBytes(patch, cursor + 2, 1, 'IPS patch');
            cursor += 3;
            output = grow(output, offset + runLength);
            output.fill(patch[cursor - 1], offset, offset + runLength);
        } else {
            requireBytes(patch, cursor, length, 'IPS patch');
            output = grow(output, offset + length);
            output.set(patch.subarray(cursor, cursor + length), offset);
            cursor += length;
        }
    }
    // the optional three bytes after EOF truncate or extend the target
    if (patch.length - cursor === 3) {
        output = resizedCopy(output, readU24BE(patch, cursor));
    } else if (patch.length !== cursor) {
        throw new RomPatchError('Invalid data after IPS EOF marker.');
    }
    return output;
}

class PatchReader {
    offset: number;

    constructor(readonly data: Uint8Array, offset = 0, readonly end = data.length) {
        this.offset = offset;
    }

    byte(what: string): number {
        if (this.offset >= this.end) {
            throw new RomPatchError(`Unexpected end of ${what}.`);
        }
        return this.data[this.offset++];
    }

    variable(what: string): number {
        let value = 0;
        let shift = 1;
        while (true) {
            const next = this.byte(what);
            value += (next & 0x7f) * shift;
            if (!Number.isSafeInteger(value)) {
                throw new RomPatchError(`${what} contains a value that is too large.`);
            }
            if ((next & 0x80) !== 0) {
                return value;
            }
            shift *= 0x80;
            value += shift;
            if (!Number.isSafeInteger(shift) || !Number.isSafeInteger(value)) {
                throw new RomPatchError(`${what} contains a value that is too large.`);
            }
        }
    }
}

function readU32LE(data: Uint8Array, offset: number): number {
    requireBytes(data, offset, 4, 'patch checksum');
    return (data[offset]
        | data[offset + 1] << 8
        | data[offset + 2] << 16
        | data[offset + 3] << 24) >>> 0;
}

function verifyChecksums(source: Uint8Array, patch: Uint8Array): { target: number, bodyEnd: number } {
    if (patch.length < 16) {
        throw new RomPatchError('Patch is too short.');
    }
    const footer = patch.length - 12;
    const sourceCrc = readU32LE(patch, footer);
    const targetCrc = readU32LE(patch, footer + 4);
    const patchCrc = readU32LE(patch, footer + 8);
    if (crc32(patch.subarray(0, patch.length - 4)) !== patchCrc) {
        throw new RomPatchError('Patch checksum does not match.');
    }
    if (crc32(source) !== sourceCrc) {
        throw new RomPatchError('Patch was made for a different ROM.');
    }
    return { target: targetCrc, bodyEnd: footer };
}

function verifyTarget(output: Uint8Array, expected: number): Uint8Array {
    if (crc32(output) !== expected) {
        throw new RomPatchError('Patched ROM checksum does not match.');
    }
    return output;
}

function applyUps(source: Uint8Array, patch: Uint8Array): Uint8Array {
    const checksums = verifyChecksums(source, patch);
    const reader = new PatchReader(patch, 4, checksums.bodyEnd);
    const sourceSize = reader.variable('UPS patch');
    const targetSize = reader.variable('UPS patch');
    if (sourceSize !== source.length) {
        throw new RomPatchError('UPS patch was made for a differently sized ROM.');
    }
    const output = resizedCopy(source, targetSize);
    let outputOffset = 0;
    while (reader.offset < reader.end) {
        outputOffset += reader.variable('UPS patch');
        if (outputOffset >= output.length) {
            throw new RomPatchError('UPS patch writes beyond the target ROM.');
        }
        while (true) {
            const value = reader.byte('UPS patch');
            if (value === 0) {
                outputOffset++;
                break;
            }
            if (outputOffset >= output.length) {
                throw new RomPatchError('UPS patch writes beyond the target ROM.');
            }
            output[outputOffset] = (source[outputOffset] ?? 0) ^ value;
            outputOffset++;
        }
    }
    return verifyTarget(output, checksums.target);
}

function signedVariable(reader: PatchReader, what: string): number {
    const encoded = reader.variable(what);
    const magnitude = Math.floor(encoded / 2);
    return (encoded & 1) === 0 ? magnitude : -magnitude;
}

function applyBps(source: Uint8Array, patch: Uint8Array): Uint8Array {
    const checksums = verifyChecksums(source, patch);
    const reader = new PatchReader(patch, 4, checksums.bodyEnd);
    const sourceSize = reader.variable('BPS patch');
    const targetSize = reader.variable('BPS patch');
    const metadataSize = reader.variable('BPS patch');
    if (sourceSize !== source.length) {
        throw new RomPatchError('BPS patch was made for a differently sized ROM.');
    }
    if (reader.offset + metadataSize > reader.end) {
        throw new RomPatchError('Invalid BPS metadata size.');
    }
    reader.offset += metadataSize;
    const output = new Uint8Array(targetSize);
    let outputOffset = 0;
    let sourceRelativeOffset = 0;
    let targetRelativeOffset = 0;
    while (outputOffset < output.length) {
        const action = reader.variable('BPS patch');
        const length = Math.floor(action / 4) + 1;
        const mode = action & 3;
        if (outputOffset + length > output.length) {
            throw new RomPatchError('BPS action writes beyond the target ROM.');
        }
        if (mode === 0) {
            if (outputOffset + length > source.length) {
                throw new RomPatchError('BPS action reads beyond the source ROM.');
            }
            output.set(source.subarray(outputOffset, outputOffset + length), outputOffset);
        } else if (mode === 1) {
            if (reader.offset + length > reader.end) {
                throw new RomPatchError('Unexpected end of BPS target data.');
            }
            output.set(patch.subarray(reader.offset, reader.offset + length), outputOffset);
            reader.offset += length;
        } else if (mode === 2) {
            sourceRelativeOffset += signedVariable(reader, 'BPS source copy');
            if (sourceRelativeOffset < 0 || sourceRelativeOffset + length > source.length) {
                throw new RomPatchError('BPS action reads beyond the source ROM.');
            }
            output.set(source.subarray(sourceRelativeOffset, sourceRelativeOffset + length), outputOffset);
            sourceRelativeOffset += length;
        } else {
            targetRelativeOffset += signedVariable(reader, 'BPS target copy');
            if (targetRelativeOffset < 0 || targetRelativeOffset >= outputOffset) {
                throw new RomPatchError('BPS action reads beyond produced target data.');
            }
            for (let i = 0; i < length; i++) {
                if (targetRelativeOffset >= outputOffset + i) {
                    throw new RomPatchError('BPS target copy references unavailable data.');
                }
                output[outputOffset + i] = output[targetRelativeOffset++];
            }
        }
        outputOffset += length;
    }
    if (reader.offset !== reader.end) {
        throw new RomPatchError('Unused data remains in BPS patch.');
    }
    return verifyTarget(output, checksums.target);
}

// BSDiff's signed-magnitude, little-endian 64-bit integer
function readBsdiffInt(data: Uint8Array, offset: number): number {
    requireBytes(data, offset, 8, 'BSDiff patch');
    let value = data[offset + 7] & 0x7f;
    for (let i = 6; i >= 0; i--) {
        value = value * 0x100 + data[offset + i];
        if (!Number.isSafeInteger(value)) {
            throw new RomPatchError('BSDiff patch contains a value that is too large.');
        }
    }
    return (data[offset + 7] & 0x80) !== 0 ? -value : value;
}

// the part of Buffer that seek-bzip uses (new Buffer(length), indexing, length, copy, hex of six bytes) on top of
// Uint8Array; the buffer package would be 25 KB for a path only BSDiff patches take
class BunzipBuffer extends Uint8Array {
    copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
        const slice = this.subarray(sourceStart, sourceEnd);
        target.set(slice, targetStart);
        return slice.length;
    }

    // Uint8Array's own toString gives a comma-separated list, which never matches a block magic and fails as
    // "not bzip data" on good input
    toString(encoding?: string): string {
        if (encoding !== 'hex') {
            return super.toString();
        }
        let hex = '';
        for (let i = 0; i < this.length; i++) {
            hex += this[i].toString(16).padStart(2, '0');
        }
        return hex;
    }
}

function bunzip(data: Uint8Array): Uint8Array {
    // supplied as the global the decoder expects only when the host has none, so Node's real Buffer is left alone
    const scope = globalThis as unknown as { Buffer?: unknown };
    if (!scope.Buffer) {
        scope.Buffer = BunzipBuffer;
    }
    try {
        // decode only indexes its input and reads its length, so the ROM's own bytes go in as they are
        return new Uint8Array(Bunzip.decode(data));
    } catch (error) {
        throw new RomPatchError(`BSDiff data could not be decompressed: ${String(error)}`);
    }
}

function applyBsdiff(source: Uint8Array, patch: Uint8Array): Uint8Array {
    requireBytes(patch, 0, 32, 'BSDiff patch');
    const controlLength = readBsdiffInt(patch, 8);
    const diffLength = readBsdiffInt(patch, 16);
    const targetSize = readBsdiffInt(patch, 24);
    if (controlLength < 0 || diffLength < 0 || targetSize < 0
        || 32 + controlLength + diffLength > patch.length) {
        throw new RomPatchError('Invalid BSDiff header.');
    }
    const control = bunzip(patch.subarray(32, 32 + controlLength));
    const diff = bunzip(patch.subarray(32 + controlLength, 32 + controlLength + diffLength));
    const extra = bunzip(patch.subarray(32 + controlLength + diffLength));
    const output = new Uint8Array(targetSize);
    let controlOffset = 0;
    let diffOffset = 0;
    let extraOffset = 0;
    let sourceOffset = 0;
    let targetOffset = 0;
    while (targetOffset < targetSize) {
        requireBytes(control, controlOffset, 24, 'BSDiff control stream');
        const diffCount = readBsdiffInt(control, controlOffset);
        const extraCount = readBsdiffInt(control, controlOffset + 8);
        const sourceAdvance = readBsdiffInt(control, controlOffset + 16);
        controlOffset += 24;
        if (diffCount < 0 || extraCount < 0
            || targetOffset + diffCount + extraCount > targetSize
            || diffOffset + diffCount > diff.length
            || extraOffset + extraCount > extra.length) {
            throw new RomPatchError('Invalid BSDiff control data.');
        }
        for (let i = 0; i < diffCount; i++) {
            const old = sourceOffset + i >= 0 && sourceOffset + i < source.length
                ? source[sourceOffset + i]
                : 0;
            output[targetOffset + i] = (old + diff[diffOffset + i]) & 0xff;
        }
        targetOffset += diffCount;
        sourceOffset += diffCount;
        diffOffset += diffCount;
        output.set(extra.subarray(extraOffset, extraOffset + extraCount), targetOffset);
        targetOffset += extraCount;
        extraOffset += extraCount;
        sourceOffset += sourceAdvance;
    }
    return output;
}

// the format algorithms follow RomPatcher.js (MIT, Marc Robledo) and their public specifications, adapted to
// typed arrays and strict bounds checking
export function applyRomPatch(source: Uint8Array, patch: Uint8Array): Uint8Array {
    switch (detectRomPatchFormat(patch)) {
        case 'ips': return applyIps(source, patch);
        case 'ups': return applyUps(source, patch);
        case 'bps': return applyBps(source, patch);
        case 'bsdiff': return applyBsdiff(source, patch);
    }
}

// applies enabled patches in list order, each one to the prior result
export function applyRomPatches(source: Uint8Array, patches: readonly RomPatch[]): Uint8Array {
    const enabled = patches.filter(patch => patch.enabled);
    const patched = enabled
        .filter(patch => !isColorPatch(patch))
        .reduce((rom, patch) => applyRomPatch(rom, patch.data), source.slice());
    return enabled
        .filter(isColorPatch)
        .reduce((rom, patch) => overlayRomPatch(source, rom, patch.data), patched);
}

/**
 * Lays a patch made against the original ROM over a ROM other patches have already changed, which is what a VB Color
 * colorization needs: its BPS is made against the original, so it would refuse a translated source, and applied first
 * it would make the next patch refuse its source. So it is applied to the original alone, and every byte where its
 * result differs comes from it, every other byte from the other patches' ROM.
 *
 * A patch that grows the cartridge keeps its image of the original either at the top (the original at its own
 * addresses, the new space below) or at the bottom (the game's code where it ran, at the start of ROM space, and the
 * new space above, up to the header and vectors at the end), whichever of the two matches the original more closely.
 * All are laid with their images on each other, so they must keep it at the same end.
 *
 * The space a colorization adds is its own. The other patches' bytes go there only into blocks the colorization kept as
 * a copy of the original (some keep mirrored stretches for code reading through a mirror). A block it changed at all is
 * its own, except the cartridge's header, which both may change byte by byte (a translation its title and game code, a
 * colorization its VB Color flag). Where both changed a byte the colorization wins: half a hook is a crash, half a
 * translated string a typo. A patch needing more room than the colorization adds goes beyond it.
 *
 * Own bytes of both in the same space, images at different ends, or a patch that shrinks the ROM are refused. Filler
 * (0x00 or 0xFF, as an IPS that grows the ROM pads it) does not count as an own byte.
 */
export function overlayRomPatch(original: Uint8Array, patched: Uint8Array, patch: Uint8Array): Uint8Array {
    const target = applyRomPatch(original, patch);
    if (patched.length < original.length) {
        throw new RomPatchError('A color patch cannot be combined with a patch that shrinks the ROM.');
    }
    if (patched.length === original.length && (patched === original || patched.every((byte, at) => byte === original[at]))) {
        return target;
    }
    const length = original.length;
    const mirror = (at: number): number => original[at % length];
    const targetBottom = imageAtBottom(original, target);
    const patchedBottom = imageAtBottom(original, patched);
    if (targetBottom !== undefined && patchedBottom !== undefined && targetBottom !== patchedBottom) {
        throw new RomPatchError('A color patch cannot be combined with a patch that keeps the original at the other end of the ROM.');
    }
    const bottom = targetBottom ?? patchedBottom ?? false;
    const size = Math.max(target.length, patched.length);
    const result = new Uint8Array(size);
    // where each ROM's image of the original is, and where each ROM starts in the result
    const imageOf = (rom: Uint8Array): number => (bottom ? 0 : rom.length - length);
    const image = imageOf(result);
    const targetImage = imageOf(target), patchedImage = imageOf(patched);
    const targetAt = image - targetImage, patchedAt = image - patchedImage;
    result.set(patched, patchedAt);
    for (let from = 0; from < length; from += 1) {
        const byte = target[targetImage + from];
        result[image + from] = byte === original[from] ? patched[patchedImage + from] : byte;
    }
    const header = size - ROM_HEADER_FROM_END;
    const ownOfPatched = (there: number): boolean => there >= 0 && there < patched.length
        && (there < patchedImage || there >= patchedImage + length)
        && patched[there] !== 0 && patched[there] !== 0xff && patched[there] !== mirror(there);
    // the colorization's space: below its image, or above it
    const space = bottom ? [length, target.length] : [0, targetImage];
    const blocks = Math.ceil((space[1] - space[0]) / OVERLAY_COPY_BLOCK);
    const isCopy = (n: number): boolean => {
        const block = space[0] + n * OVERLAY_COPY_BLOCK;
        for (let at = block; at < Math.min(block + OVERLAY_COPY_BLOCK, space[1]); at += 1) {
            if (target[at] !== mirror(at)) {
                return false;
            }
        }
        return true;
    };
    // a run of copy blocks in which the other patch has bytes of its own is that patch's space: they go there exactly
    // as it has them alone, 0x00 and 0xFF included
    const copies = Array.from({ length: blocks }, (_, n) => isCopy(n));
    // a block of a single byte value (free space, zeros in a table) matching the original only counts as a copy within
    // a long run of copies; a short one is colorization data that happens to match
    const uniform = (n: number): boolean => {
        const block = space[0] + n * OVERLAY_COPY_BLOCK;
        const end = Math.min(block + OVERLAY_COPY_BLOCK, space[1]);
        for (let at = block + 1; at < end; at += 1) {
            if (target[at] !== target[block]) {
                return false;
            }
        }
        return true;
    };
    for (let first = 0; first < blocks;) {
        if (!copies[first]) {
            first += 1;
            continue;
        }
        let last = first;
        while (last < blocks && copies[last]) {
            last += 1;
        }
        if (last - first < OVERLAY_MIN_COPY_RUN) {
            for (let n = first; n < last; n += 1) {
                copies[n] = !uniform(n);
            }
        }
        first = last;
    }
    const theirs = new Uint8Array(blocks);
    for (let first = 0; first < blocks;) {
        if (!copies[first]) {
            first += 1;
            continue;
        }
        let last = first;
        let any = false;
        for (; last < blocks && copies[last]; last += 1) {
            const block = space[0] + last * OVERLAY_COPY_BLOCK;
            for (let at = block; !any && at < Math.min(block + OVERLAY_COPY_BLOCK, space[1]); at += 1) {
                any = ownOfPatched(targetAt + at - patchedAt);
            }
        }
        if (any) {
            theirs.fill(1, first, last);
        }
        first = last;
    }
    for (let block = space[0]; block < space[1]; block += OVERLAY_COPY_BLOCK) {
        const end = Math.min(block + OVERLAY_COPY_BLOCK, space[1]);
        const n = (block - space[0]) / OVERLAY_COPY_BLOCK;
        const copy = copies[n];
        for (let at = block; at < end; at += 1) {
            const into = targetAt + at, there = into - patchedAt;
            // the cartridge's end (header, vectors) lies in the space when the images are at the bottom: take the other
            // patch's byte at that address where its ROM reaches (it may have moved its vectors there), else its
            // image's
            const other = there >= 0 && there < patched.length ? patched[there] : patched[patchedImage + at % length];
            if (into >= header && into < header + ROM_HEADER_SIZE) {
                result[into] = target[at] !== mirror(at) ? target[at] : other;
                continue;
            }
            const own = ownOfPatched(there);
            if (own && !copy) {
                throw new RomPatchError('A color patch cannot be combined with a patch that puts its own bytes into the space the color patch adds.');
            }
            // a block the colorization kept as a copy gets the other patch's byte where that is its space, else its
            // image's mirrored byte (code may read the original through a mirror there)
            result[into] = !copy ? target[at] : own || into >= header || theirs[n] ? other : patched[patchedImage + at % length];
        }
    }
    return result;
}

// whether a ROM grown from the original keeps its image of it at the bottom rather than the top, whichever matches more
// of the original's bytes; undefined for a ROM of the original's size
function imageAtBottom(original: Uint8Array, rom: Uint8Array): boolean | undefined {
    if (rom.length <= original.length) {
        return undefined;
    }
    const top = rom.length - original.length;
    let atBottom = 0, atTop = 0;
    for (let at = 0; at < original.length; at += 1) {
        atBottom += rom[at] === original[at] ? 1 : 0;
        atTop += rom[top + at] === original[at] ? 1 : 0;
    }
    return atBottom > atTop;
}

// the granularity at which overlayRomPatch tells a copy of the original from a colorization's own space
const OVERLAY_COPY_BLOCK = 16;
// a run of copy blocks shorter than this (1 KiB) is a copy only where a block holds more than one byte value
const OVERLAY_MIN_COPY_RUN = 64;
// the cartridge header (title, maker, game code, version, and the VB Color flag): 32 bytes from 0x220 before the end
const ROM_HEADER_FROM_END = 0x220;
const ROM_HEADER_SIZE = 0x20;

/**
 * A BPS for a patch made from a whole ROM, which has to reach the patch store as a delta. Linear: a run matching the
 * source at the same offset is a SourceRead, a run that repeats the source past its end (or the target's own first
 * half, for a target grown to twice its size) is a copy of that, anything else a TargetRead. As small as a BPS gets
 * without searching for a target that is the source with some regions rewritten, perhaps grown to make room.
 */
export function createBpsPatch(source: Uint8Array, target: Uint8Array): Uint8Array {
    const out: number[] = [0x42, 0x50, 0x53, 0x31]; // BPS1
    const variable = (value: number): void => {
        let data = value;
        for (;;) {
            const low = data % 128;
            data = Math.floor(data / 128);
            if (data === 0) {
                out.push(low | 0x80);
                return;
            }
            out.push(low);
            data -= 1;
        }
    };
    const u32 = (value: number): void => {
        out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    };
    // a target byte comes from the source at the same offset, from the source's mirror past its end (a ROM grown to
    // twice its size by repeating itself, to make room for a patch's code), from the target's own first half when the
    // target was grown like that from something else, or is spelled out
    const SAME = 0;
    const MIRROR = 1;
    const REPEAT = 2;
    const LITERAL = 3;
    const half = target.length / 2;
    const kindAt = (offset: number): number => {
        if (offset < source.length) {
            return source[offset] === target[offset] ? SAME : LITERAL;
        }
        if (source.length > 0 && source[offset % source.length] === target[offset]) {
            return MIRROR;
        }
        return offset >= half && target[offset - half] === target[offset] ? REPEAT : LITERAL;
    };

    variable(source.length);
    variable(target.length);
    variable(0); // no metadata
    // SourceCopy and TargetCopy offsets are relative; each one moves its own past what it copied
    let sourceRelative = 0;
    let targetRelative = 0;
    let at = 0;
    while (at < target.length) {
        const kind = kindAt(at);
        let end = at + 1;
        // a mirror run also ends where the source wraps round to its start
        while (end < target.length && kindAt(end) === kind
            && !(kind === MIRROR && end % source.length === 0)) {
            end += 1;
        }
        const length = end - at;
        if (kind === SAME) {
            variable((length - 1) * 4);
        } else if (kind === MIRROR) {
            const from = at % source.length;
            const delta = from - sourceRelative;
            variable((length - 1) * 4 + 2);
            variable(Math.abs(delta) * 2 + (delta < 0 ? 1 : 0));
            sourceRelative = from + length;
        } else if (kind === REPEAT) {
            const from = at - half;
            const delta = from - targetRelative;
            variable((length - 1) * 4 + 3);
            variable(Math.abs(delta) * 2 + (delta < 0 ? 1 : 0));
            targetRelative = from + length;
        } else {
            variable((length - 1) * 4 + 1);
            for (let i = at; i < end; i += 1) {
                out.push(target[i]);
            }
        }
        at = end;
    }
    u32(crc32(source));
    u32(crc32(target));
    u32(crc32(Uint8Array.from(out)));
    return Uint8Array.from(out);
}
