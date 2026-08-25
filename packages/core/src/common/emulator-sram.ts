/**
 * How a cartridge's save RAM comes up when there is no save file for it yet.
 *
 * In `common/` rather than beside the other emulator types because the save
 * state format depends on it, and that format is host-free.
 */
export enum EmulatorSramInit {
    RANDOM = 'random',
    ZEROES = 'zeroes',
}
