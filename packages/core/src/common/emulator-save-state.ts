/**
 * The save state file format, and the save RAM a fresh cartridge starts with.
 *
 * Pure functions over buffers: no core, no files, no host. That is deliberate —
 * the container is the one part of saving that has to stay readable across
 * versions of the emulator, so it is worth being able to test it directly and
 * worth keeping it somewhere that a reader can take in whole.
 */

import { EmulatorSramInit } from './emulator-sram';

/**
 * Save state container.
 *
 * The header guards against loading a state into the wrong game, or one
 * produced by a core whose state layout differs, either of which would
 * otherwise restore convincing nonsense.
 */
export const STATE_MAGIC = 0x56455353; // 'VESS'
/**
 * Version 2 added the ESSound section; version 1 files are still read, and
 * simply restore no audio.
 */
export const STATE_VERSION = 2;
export const STATE_HEADER_BYTES = 48;
/** Version 2's extra header word: how many bytes of ESSound state follow the machine's. */
export const STATE_EXTRA_BYTES = 4;

/**
 * Save RAM allocated for a cartridge that has no save file yet.
 *
 * This is a size in the cartridge's *address space*, not a count of storage
 * cells: only the low byte of each halfword is wired to the SRAM chip, so
 * the 8 KiB a game pak actually holds spans 16 KiB of bus. The core indexes
 * the buffer by masked address (`cart.ram[address & ramMask]`), so a buffer
 * that is only as large as the chip makes the upper half of the window
 * mirror onto the lower half and a game's own writes corrupt each other.
 * Lemur, which runs the same core, allocates the same 16 KiB.
 */
export const DEFAULT_SAVE_RAM_SIZE = 16384;

/** What `unwrapSaveState` recovers from a file. */
export interface VesEmulatorSaveState {
    states: ArrayBuffer[];
    /** The ESSound section, absent in files written before version 2. */
    esSound: string | undefined;
}

/** What the header binds a state to, so it cannot be loaded into another game. */
export interface VesEmulatorSaveStateIdentity {
    /** The ROM's 32-byte header. */
    romIdentity: Uint8Array;
    /** The ROM's size in MBit. */
    romSize: number;
}

/**
 * The file a save state is written as: a header, one block per simulation of
 * the session, and what ESSound was playing.
 *
 * A linked pair is snapshotted as a unit: restoring one machine but not the
 * other leaves them disagreeing about the conversation on the link port. The
 * blobs are all the same size, so their count is implied by the file length and
 * needs no field of its own.
 *
 * The audio is played on the DOM side rather than by the core, so its state is
 * nowhere in the blocks the core hands over — without this last section,
 * loading a state would leave whatever was playing before running on.
 */
export function wrapSaveState(
    states: ArrayBuffer[],
    identity: VesEmulatorSaveStateIdentity,
    esSoundSnapshot: unknown,
): Uint8Array {
    const size = states[0].byteLength;
    const esSound = new TextEncoder().encode(JSON.stringify(esSoundSnapshot));
    const start = STATE_HEADER_BYTES + STATE_EXTRA_BYTES;
    const out = new Uint8Array(start + size * states.length + esSound.length);
    const header = new DataView(out.buffer, 0, start);
    header.setUint32(0, STATE_MAGIC);
    header.setUint32(4, STATE_VERSION);
    header.setUint32(8, identity.romSize);
    header.setUint32(12, size);
    out.set(identity.romIdentity, 16);
    header.setUint32(STATE_HEADER_BYTES, esSound.length);
    states.forEach((state, index) => {
        out.set(new Uint8Array(state), start + size * index);
    });
    out.set(esSound, start + size * states.length);
    return out;
}

/**
 * Read a file back, or say why it cannot be.
 *
 * `expectedCount` is how many simulations are running now, which has to match
 * how many the file holds — see `wrapSaveState`.
 */
export function unwrapSaveState(
    stored: Uint8Array,
    expectedCount: number,
    identity: VesEmulatorSaveStateIdentity,
): VesEmulatorSaveState {
    if (stored.length <= STATE_HEADER_BYTES) {
        throw new Error('This save state file is truncated.');
    }
    // Over the whole file rather than the fixed header: version 2's length
    // word sits just past it.
    const header = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
    if (header.getUint32(0) !== STATE_MAGIC) {
        throw new Error('This is not a save state file.');
    }
    const version = header.getUint32(4);
    if (version > STATE_VERSION || version < 1) {
        throw new Error('This save state was written by a different emulator version.');
    }

    const stamp = stored.subarray(16, 16 + identity.romIdentity.length);
    if (!identity.romIdentity.every((byte, index) => byte === stamp[index])) {
        throw new Error('This save state belongs to a different ROM.');
    }

    const size = header.getUint32(12);
    // Version 1 had no ESSound section and no word to say how long it is.
    const start = STATE_HEADER_BYTES + (version >= 2 ? STATE_EXTRA_BYTES : 0);
    if (stored.length <= start) {
        throw new Error('This save state file is truncated.');
    }
    const esSoundBytes = version >= 2 ? header.getUint32(STATE_HEADER_BYTES) : 0;
    const body = stored.length - start - esSoundBytes;
    if (size === 0 || body <= 0 || body % size !== 0) {
        throw new Error('This save state file is malformed.');
    }

    const count = body / size;
    if (count !== expectedCount) {
        throw new Error(count > expectedCount
            ? 'This save state was made by a linked pair of emulators and needs both to be running.'
            : 'This save state was made by a single emulator and cannot be loaded into a linked pair.');
    }

    return {
        states: Array.from({ length: count }, (unused, index) => {
            const from = start + size * index;
            return stored.slice(from, from + size).buffer;
        }),
        esSound: esSoundBytes > 0
            ? new TextDecoder().decode(stored.subarray(start + body, start + body + esSoundBytes))
            : undefined,
    };
}

/**
 * The save RAM a cartridge with no save file yet comes up with.
 *
 * Random by default rather than zeroed, because a real cartridge's SRAM powers
 * up holding whatever it happens to hold, and a game that mistakes zeroes for
 * a valid save is a bug worth finding on the developer's machine rather than
 * the player's.
 */
export function freshSaveRam(fill: EmulatorSramInit): Uint8Array {
    const ram = new Uint8Array(DEFAULT_SAVE_RAM_SIZE);
    if (fill === EmulatorSramInit.ZEROES) {
        return ram;
    }
    for (let i = 0; i < ram.length; i += 2) {
        ram[i] = Math.floor(Math.random() * 256);
    }
    return ram;
}
