// the save state file format, and the save RAM a fresh cartridge starts with. Pure functions over buffers, so
// the one part of saving that has to stay readable across versions can be tested directly

import { EmulatorSramInit, EmulatorSramWindow } from './emulator-sram';
import { VB_REGION_BYTES } from './vb-constants';

/**
 * Save state container. The header guards against loading a state into the wrong game, or one from a core with a
 * different state layout, which would restore convincing nonsense.
 *
 *  0  'VESS'
 *  4  version
 *  8  the ROM's size in MBit
 * 12  bytes per machine, as the core hands them over
 * 16  the ROM's 32-byte header
 * 48  how many machines
 * 52  metadata length   ┐
 * 56  thumbnail length  │  the sections, in this order,
 * 60  ESSound length    │  straight after the header
 * 64  body length       ┘
 *
 * Everything the save-state browser draws a row from comes before the body, so it is read without inflating. Every
 * length is spelt out, as the compressed body's size says nothing about the machine count. A file is only taken for a
 * state when its sections add up to exactly its length.
 */
export const STATE_MAGIC = 0x56455353; // 'VESS'
export const STATE_VERSION = 1; // written into every file, and the only version read back
export const STATE_HEADER_BYTES = 68;

const AT_MACHINES = 48;
const AT_META = 52;
const AT_THUMBNAIL = 56;
const AT_ES_SOUND = 60;
const AT_BODY = 64;
const AT_SECTIONS = [AT_META, AT_THUMBNAIL, AT_ES_SOUND, AT_BODY];

// gzip rather than raw deflate for its trailing checksum and length, which turn a damaged file into a refusal.
// Built into every browser and Node; the core's state (mostly derived tables and screen pictures) shrinks 15-60x
const STATE_COMPRESSION: CompressionFormat = 'gzip';

// how much of the save window powers up like a real cartridge's SRAM, in address space: only the low byte of each
// halfword is wired to the chip on every game pak, so the 8 KiB chip spans 16 KiB of bus (as in Lemur). Above it there
// is no chip at all, see freshSaveRam and saveRamHighWater
export const DEFAULT_SAVE_RAM_SIZE = 16384;

/**
 * The largest save window: all of Game Pak RAM (region 6 is 16 MiB, the VB decodes addresses on three bits). It is what
 * the AUTO setting and any unrecognized one get, so no game runs out of a size a ROM cannot declare; without mirroring,
 * a game probing its save RAM size is told all of it. The smaller settings (EmulatorSramWindow, saveRamWindowBytes)
 * mirror like a real cartridge. saveRamHighWater trims the file either way.
 */
export const SAVE_RAM_WINDOW = VB_REGION_BYTES;

// manual: one the user asked for. auto: rotating snapshots taken on a timer, a coarse rewind kept until the next few
// push it out. suspend: the single state a ROM is put away with, offered on the next launch
export type SaveStateKind = 'manual' | 'auto' | 'suspend';

// what opening a game does with its suspend state. Asking is the default, as opening is as often "start
// again" as "carry on". Ignore still writes the state (loadable by hand), it only stops asking
export enum EmulatorResumeStart {
    ASK = 'ask', // offer the moment back, and discard it when the offer is declined
    RESUME = 'resume',
    IGNORE = 'ignore',
}

// inside the file rather than beside it, so an exported state still has its picture and date in the browser.
// See STATE_MAGIC for where in the file it is
export interface VesEmulatorSaveStateMeta {
    kind: SaveStateKind;
    created: number; // milliseconds since the epoch
    label?: string;
    // a PNG of the picture at that moment; its own file section, as text in the JSON it was a third larger
    thumbnail?: Uint8Array;
    romName?: string;
}

// a state stamped with another ROM's header (another game or build), thrown by unwrapSaveState unless told to
// take it anyway. Taken anyway, the CPU's instruction cache must be emptied after the restore, as it holds the
// other ROM's code
export class SaveStateOtherRomError extends Error {
    constructor() {
        super('This save state belongs to a different ROM.');
        this.name = 'SaveStateOtherRomError';
    }
}

export interface VesEmulatorSaveState {
    states: ArrayBuffer[];
    otherRom: boolean;
    esSound: string | undefined;
    meta: VesEmulatorSaveStateMeta | undefined;
}

export interface VesEmulatorSaveStateIdentity {
    romIdentity: Uint8Array;
    romSize: number; // the ROM's size in MBit
}

/**
 * A header, the metadata, what ESSound was playing, and one block per simulation, compressed together. A linked pair is
 * snapshotted as a unit, or the machines disagree about the link port conversation; the blocks are the same size, so
 * the header holds it once with the count. ESSound plays on the DOM side, so without its section loading a state would
 * leave whatever was playing running on.
 */
export async function wrapSaveState(
    states: ArrayBuffer[],
    identity: VesEmulatorSaveStateIdentity,
    esSoundSnapshot: unknown,
    meta?: VesEmulatorSaveStateMeta,
): Promise<Uint8Array> {
    const size = states[0].byteLength;
    const machine = new Uint8Array(size * states.length);
    states.forEach((state, index) => {
        machine.set(new Uint8Array(state), size * index);
    });
    const header = new Uint8Array(STATE_HEADER_BYTES);
    const view = new DataView(header.buffer);
    view.setUint32(0, STATE_MAGIC);
    view.setUint32(4, STATE_VERSION);
    view.setUint32(8, identity.romSize);
    view.setUint32(12, size);
    header.set(identity.romIdentity, 16);
    view.setUint32(AT_MACHINES, states.length);
    return assemble(
        header,
        meta,
        new TextEncoder().encode(JSON.stringify(esSoundSnapshot)),
        await pipe(machine, new CompressionStream(STATE_COMPRESSION)),
    );
}

// what naming and importing a state do: the sections after the picture are copied across still compressed.
// Throws for any file describeSaveState would not describe
export function rewriteSaveStateMeta(stored: Uint8Array, next: VesEmulatorSaveStateMeta): Uint8Array {
    const layout = readLayout(stored);
    if (typeof layout === 'string') {
        throw new Error(layout);
    }
    return assemble(stored, next, layout.esSound, layout.body);
}

// expectedCount is how many simulations are running now, which has to match the file (see wrapSaveState)
export async function unwrapSaveState(
    stored: Uint8Array,
    expectedCount: number,
    identity: VesEmulatorSaveStateIdentity,
    options: { otherRom?: boolean } = {},
): Promise<VesEmulatorSaveState> {
    const layout = readLayout(stored);
    if (typeof layout === 'string') {
        throw new Error(layout);
    }

    const stamp = stored.subarray(16, 16 + identity.romIdentity.length);
    const otherRom = !identity.romIdentity.every((byte, index) => byte === stamp[index]);
    if (otherRom && !options.otherRom) {
        throw new SaveStateOtherRomError();
    }

    const count = layout.machines;
    if (count !== expectedCount) {
        throw new Error(count > expectedCount
            ? 'This save state was made by a linked pair of emulators and needs both to be running.'
            : 'This save state was made by a single emulator and cannot be loaded into a linked pair.');
    }

    // a stream gzip refuses (checksum, stated length) or one that inflates to the wrong size is a damaged file
    const machine = await pipe(layout.body, new DecompressionStream(STATE_COMPRESSION))
        .catch(() => undefined);
    if (!machine || machine.length !== layout.size * count) {
        throw new Error('This save state file is damaged.');
    }

    return {
        // copies out of a buffer inflated for this alone, so each is an ArrayBuffer of its own that can be transferred
        // into the worker without taking another machine's block with it
        states: Array.from({ length: count }, (unused, index) =>
            machine.buffer.slice(layout.size * index, layout.size * (index + 1))),
        otherRom,
        esSound: layout.esSound.length > 0
            ? new TextDecoder().decode(layout.esSound)
            : undefined,
        meta: readMeta(layout),
    };
}

// machine count and metadata without inflating the body, for the save-state browser. Undefined for anything that is not
// a state file, as a folder beside a ROM is full of other files. No identity check: a state of another ROM is exactly
// what the browser wants to show; unwrapSaveState is the only way in
export function describeSaveState(stored: Uint8Array): {
    machines: number,
    meta: VesEmulatorSaveStateMeta | undefined,
} | undefined {
    const layout = readLayout(stored);
    return typeof layout === 'string'
        ? undefined
        : { machines: layout.machines, meta: readMeta(layout) };
}

interface StateLayout {
    size: number; // bytes per machine, uncompressed
    machines: number;
    meta: Uint8Array;
    thumbnail: Uint8Array;
    esSound: Uint8Array;
    body: Uint8Array;
}

// checked to the byte: the sections must add up to exactly the file, which refuses a truncated file, one with
// something appended, and an earlier layout with the same version number
function readLayout(stored: Uint8Array): StateLayout | string {
    if (stored.length < STATE_HEADER_BYTES) {
        return 'This save state file is truncated.';
    }
    const header = new DataView(stored.buffer, stored.byteOffset, STATE_HEADER_BYTES);
    if (header.getUint32(0) !== STATE_MAGIC) {
        return 'This is not a save state file.';
    }
    if (header.getUint32(4) !== STATE_VERSION) {
        return 'This save state was written by a different emulator version.';
    }
    const lengths = AT_SECTIONS.map(word => header.getUint32(word));
    const total = lengths.reduce((sum, length) => sum + length, STATE_HEADER_BYTES);
    if (total > stored.length) {
        return 'This save state file is truncated.';
    }
    const size = header.getUint32(12);
    const machines = header.getUint32(AT_MACHINES);
    if (total < stored.length || size === 0 || machines === 0 || lengths[3] === 0) {
        return 'This save state file is malformed.';
    }
    let at = STATE_HEADER_BYTES;
    const [meta, thumbnail, esSound, body] = lengths.map(length => stored.subarray(at, at += length));
    return { size, machines, meta, thumbnail, esSound, body };
}

// the header given with its section lengths filled in, then the sections in the order STATE_MAGIC lists them.
// Only the first STATE_HEADER_BYTES of header are used, so a whole stored file is a header too (renaming)
function assemble(
    header: Uint8Array,
    meta: VesEmulatorSaveStateMeta | undefined,
    esSound: Uint8Array,
    body: Uint8Array,
): Uint8Array {
    const empty = new Uint8Array(0);
    let described = empty;
    if (meta) {
        const { thumbnail, ...text } = meta;
        described = new TextEncoder().encode(JSON.stringify(text));
    }
    const picture = meta?.thumbnail ?? empty;
    const sections = [described, picture, esSound, body];
    const out = new Uint8Array(sections.reduce((sum, section) => sum + section.length, STATE_HEADER_BYTES));
    out.set(header.subarray(0, STATE_HEADER_BYTES), 0);
    const view = new DataView(out.buffer);
    AT_SECTIONS.forEach((word, index) => {
        view.setUint32(word, sections[index].length);
    });
    let at = STATE_HEADER_BYTES;
    for (const section of sections) {
        out.set(section, at);
        at += section.length;
    }
    return out;
}

// the write is not awaited: it only settles once the other end has been read, which the last line does. A
// failing stream says so there as well, so the write's own rejection is only kept from being unhandled
async function pipe(
    bytes: Uint8Array,
    through: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
    const writer = through.writable.getWriter();
    writer.write(bytes as BufferSource).catch(() => undefined);
    writer.close().catch(() => undefined);
    return new Uint8Array(await new Response(through.readable).arrayBuffer());
}

// every field is checked: this is the one part a user can put anything into, and a hand-edited state must give the
// browser a row it can draw rather than a crash
function readMeta(layout: StateLayout): VesEmulatorSaveStateMeta | undefined {
    if (layout.meta.length === 0) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(new TextDecoder().decode(layout.meta)) as Partial<VesEmulatorSaveStateMeta>;
        const kind = parsed.kind === 'auto' || parsed.kind === 'suspend' ? parsed.kind : 'manual';
        return {
            kind,
            created: typeof parsed.created === 'number' && Number.isFinite(parsed.created)
                ? parsed.created : 0,
            label: typeof parsed.label === 'string' ? parsed.label : undefined,
            // a copy, so a description kept for the browser does not keep the whole file alive; by construction rather
            // than slice, which is a view for the Buffer some hosts polyfill
            thumbnail: layout.thumbnail.length > 0 ? new Uint8Array(layout.thumbnail) : undefined,
            romName: typeof parsed.romName === 'string' ? parsed.romName : undefined,
        };
    } catch {
        return undefined;
    }
}

// anything unrecognized is the whole region, which can never lose a game its save, as narrowing on a typo could
export function saveRamWindowBytes(window: string): number {
    switch (window) {
        case EmulatorSramWindow.W16K: return 16 * 1024;
        case EmulatorSramWindow.W32K: return 32 * 1024;
        case EmulatorSramWindow.W64K: return 64 * 1024;
        case EmulatorSramWindow.W128K: return 128 * 1024;
        case EmulatorSramWindow.W256K: return 256 * 1024;
        case EmulatorSramWindow.W512K: return 512 * 1024;
        case EmulatorSramWindow.W1M: return 1024 * 1024;
        case EmulatorSramWindow.W2M: return 2 * 1024 * 1024;
        case EmulatorSramWindow.W4M: return 4 * 1024 * 1024;
        case EmulatorSramWindow.W8M: return 8 * 1024 * 1024;
        default: return SAVE_RAM_WINDOW;
    }
}

/**
 * Random rather than zeroed by default, as real SRAM powers up holding whatever it holds, and a game mistaking zeroes
 * for a valid save is a bug worth finding on the developer's machine. Only up to DEFAULT_SAVE_RAM_SIZE: beyond the chip
 * there are no cells, so zero is more honest, and it lets saveRamHighWater tell how much a game used. Randomizing all
 * 16 MiB would pause every launch and make save files incompressible.
 */
export function freshSaveRam(
    fill: EmulatorSramInit,
    size: number = SAVE_RAM_WINDOW,
): Uint8Array {
    const ram = new Uint8Array(size);
    if (fill === EmulatorSramInit.ZEROES) {
        return ram;
    }
    // even bytes only: the odd ones are not wired to the chip on any existing cartridge. A custom cartridge wiring
    // all 16 bits can still use them (the core addresses the buffer by byte), they just power up as zero
    const chip = Math.min(size, DEFAULT_SAVE_RAM_SIZE);
    for (let i = 0; i < chip; i += 2) {
        ram[i] = Math.floor(Math.random() * 256);
    }
    return ram;
}

/**
 * Read out of the buffer rather than watching writes: everything above DEFAULT_SAVE_RAM_SIZE starts as zero (see
 * freshSaveRam), so a non-zero byte there is one a game wrote. Never less than the baseline, which holds noise.
 * Trimming on this is lossless: a zero written into zeroed space is indistinguishable from none, and the region is
 * zeroed again on the way back in.
 */
export function saveRamHighWater(ram: Uint8Array): number {
    const baseline = Math.min(ram.length, DEFAULT_SAVE_RAM_SIZE);
    // a word at a time, which is faster and matches the buffer's alignment; the tail is usually untouched, so this
    // walks a few million words, only when a save is written. A misaligned buffer is walked a byte at a time
    if ((ram.byteOffset & 3) !== 0 || (ram.length & 3) !== 0) {
        for (let at = ram.length - 1; at >= baseline; at--) {
            if (ram[at] !== 0) {
                return at + 1;
            }
        }
        return baseline;
    }
    const start = baseline >> 2;
    const words = new Uint32Array(ram.buffer, ram.byteOffset, ram.length >> 2);
    for (let i = words.length - 1; i >= start; i--) {
        if (words[i] === 0) {
            continue;
        }
        const at = i << 2;
        for (let byte = 3; byte >= 0; byte--) {
            if (ram[at + byte] !== 0) {
                return at + byte + 1;
            }
        }
    }
    return baseline;
}

// rounded up to a power of two, as the core accepts nothing else, and floored at the baseline so other VB
// emulators can read it. Never smaller than the existing file, which may hold what earlier sessions wrote higher up
export function saveRamFileSize(used: number, existing = 0): number {
    let size = DEFAULT_SAVE_RAM_SIZE;
    // existing is whatever is on disk: a hand-edited length is rounded up here instead of reaching the core, which
    // only accepts powers of two
    const wanted = Math.max(used, existing);
    while (size < wanted && size < SAVE_RAM_WINDOW) {
        size *= 2;
    }
    return size;
}
