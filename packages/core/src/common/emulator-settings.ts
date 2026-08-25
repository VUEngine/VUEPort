/**
 * The emulator's own settings.
 *
 * Named by what they are rather than by where a host keeps them: `palette`, not
 * `emulator.builtIn.palette`. The host owns the mapping onto its own storage —
 * in VES a Theia preference id, on the web a key in local storage — so
 * the emulator's code never spells out a host's namespace.
 *
 * Only what the emulator itself acts on is here. Which external emulator to
 * launch, whether to queue a run after a build, where a 3DS is on the network:
 * those are VES's, and stay there.
 */

import { Event } from './emulator-events';
import { EmulatorSramInit } from './emulator-sram';

/** A custom palette, as the settings store it. */
export interface CustomPaletteSetting {
    name: string;
    colors: string[];
}

export interface CustomAnaglyphPaletteSetting {
    name: string;
    left: string;
    right: string;
}

export interface VueportConfig {
    /** Which of the VbRenderingMode values the picture is drawn in. */
    renderingMode: string;
    /** Id of the palette in use, built-in or `custom:`-prefixed. */
    palette: string;
    anaglyphPalette: string;
    customPalettes: CustomPaletteSetting[];
    customAnaglyphPalettes: CustomAnaglyphPaletteSetting[];
    /** One of EmulatorScale. */
    scale: string;
    sramInit: EmulatorSramInit;
    /** Whether player two uses player one's key mappings. */
    player2SameControls: boolean;
    rewindEnabled: boolean;
    /** Frames of emulation covered by one entry of rewind history. */
    rewindGranularity: number;
    /** Rewind history budget, in MB. */
    rewindBufferSize: number;
    slowMotionRatio: number;
    fastForwardRatio: number;
}

/** What every setting is when nothing has been configured. */
export const VUEPORT_DEFAULTS: VueportConfig = {
    renderingMode: 'anaglyph',
    palette: 'default',
    anaglyphPalette: 'red-cyan',
    customPalettes: [],
    customAnaglyphPalettes: [],
    scale: 'auto',
    sramInit: EmulatorSramInit.RANDOM,
    player2SameControls: true,
    rewindEnabled: false,
    rewindGranularity: 1,
    rewindBufferSize: 64,
    slowMotionRatio: 3,
    fastForwardRatio: 4,
};

/** The bounds a host should hold a numeric setting to. */
export const VUEPORT_SETTING_RANGES: Partial<Record<keyof VueportConfig, { min: number, max: number }>> = {
    rewindGranularity: { min: 1, max: 32 },
    rewindBufferSize: { min: 8, max: 1024 },
    slowMotionRatio: { min: 1, max: 32 },
    fastForwardRatio: { min: 1, max: 32 },
};

/**
 * Reading and writing the emulator's settings.
 *
 * `ready` exists because a host may resolve its settings asynchronously — VES's 
 * folder-scoped providers are not answering yet when a restored
 * widget is built, and until they are, every read gives back a default. The
 * emulator waits for this once, before it reads anything that decides how it
 * starts up.
 */
export interface VueportSettings {
    get<K extends keyof VueportConfig>(key: K): VueportConfig[K];
    set<K extends keyof VueportConfig>(key: K, value: VueportConfig[K]): Promise<void>;
    /** Fires with the setting that changed. */
    readonly onDidChange: Event<keyof VueportConfig>;
    readonly ready: Promise<void>;
}

/**
 * What the emulator needs to know about the keys bound to its commands.
 *
 * Two questions only: what is bound to this, and let the person change it. The
 * emulator does not own a keymap — VES has one already, and a standalone
 * host will have its own — so it asks rather than keeps.
 */
export interface VueportBindableCommand {
    id: string;
    /** Shown as the title of whatever the host asks for a key with. */
    label?: string;
    category?: string;
}

export interface VueportInputBindings {
    /**
     * The keys bound to a command, ready to show. `compact` asks for the form
     * that goes in a tooltip beside a label rather than on its own.
     */
    label(commandId: string, compact: boolean): string;
    /**
     * The key codes bound to a command, as `KeyboardEvent.code` spells them.
     *
     * Codes rather than the host's own binding objects, because that is all the
     * key handler compares against — and a code is the same everywhere, while a
     * binding object is whatever its keymap happens to be made of.
     */
    keyCodes(commandId: string): string[];
    /**
     * Ask the person for a key and bind it. Resolves true if the binding
     * changed. `when` is the context a new mapping should apply in, which
     * matters for a command that has none to copy from yet.
     *
     * Takes the whole command rather than its id: the host names what it is
     * asking about, and only the command carries that name.
     */
    capture(command: VueportBindableCommand, when?: string): Promise<boolean>;
}

