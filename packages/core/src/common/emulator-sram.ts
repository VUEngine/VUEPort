// in common/ because the host-free save state format depends on it
export enum EmulatorSramInit {
    RANDOM = 'random',
    ZEROES = 'zeroes',
}

// AUTO answers on all of Game Pak RAM, since a VB ROM cannot declare its save RAM size. The smaller windows mirror, so
// a real-hardware build probing its save RAM size gets what the cartridge would answer. These are window sizes: only
// the low byte of each halfword is wired, so an 8 KiB chip is the 16 KiB window
export enum EmulatorSramWindow {
    AUTO = 'auto',
    W16K = '16k', // standard game pak: an 8 KiB chip across 16 KiB of bus
    W32K = '32k',
    W64K = '64k',
    W128K = '128k',
    W256K = '256k',
    W512K = '512k',
    W1M = '1m',
    W2M = '2m',
    W4M = '4m',
    W8M = '8m',
}

// where a ROM's save, save states and cheats live. Beside the ROM travels with the game, the application's own
// storage is what a browser must use and what a host wants for a build output, read-only volume or project
export enum EmulatorCompanionLocation {
    ROM = 'rom',
    STORAGE = 'storage',
}

// a slot is a save file (a second cartridge), not a save state. "A" keeps the plain name `<rom>.p1.sram`, which
// other emulators read; the others carry the letter: `<rom>.p1.B.sram`
export const EMULATOR_SAVE_SLOTS: readonly string[] =
    Array.from({ length: 26 }, (unused, index) => String.fromCharCode('A'.charCodeAt(0) + index));

export const DEFAULT_SAVE_SLOT = 'A';

// settings may be hand-edited, so this alone decides what counts as a slot: lower case is accepted,
// anything else is slot A
export function emulatorSaveSlot(value: unknown): string {
    const slot = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return EMULATOR_SAVE_SLOTS.includes(slot) ? slot : DEFAULT_SAVE_SLOT;
}
