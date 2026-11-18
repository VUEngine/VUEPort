// the emulator's own settings, named by what they are (`palette`, not `emulator.builtIn.palette`); the host maps
// them onto its storage (a Theia preference in VES, local storage on the web). Only what the emulator acts on;
// external emulators, run-after-build or 3DS addresses stay in VES

import { DEFAULT_TURBO_RATE, TURBO_RATE_RANGE } from './emulator-turbo';
import type { ReactNode } from 'react';
import { EmulatorDecoration, EmulatorScale, VbHardwareMode } from '../browser/emulator-types';
import { Event } from './emulator-events';
import { GamepadProfile } from './emulator-gamepad-profiles';
import { EmulatorResumeStart } from './emulator-save-state';
import {
    DEFAULT_SAVE_SLOT,
    EmulatorCompanionLocation,
    EmulatorSramInit,
    EmulatorSramWindow,
} from './emulator-sram';
import {
    FrameBlending,
    VB_DEFAULT_ANAGLYPH_PALETTE_ID,
    VB_DEFAULT_PALETTE_ID,
    VbAnaglyphMatrices,
    VbDuboisProfileSelection,
    VbRenderingMode,
} from './vb-constants';

export interface CustomPaletteSetting {
    name: string;
    colors: string[];
}

export interface CustomAnaglyphPaletteSetting {
    name: string;
    left: string;
    right: string;
    duboisProfile?: VbDuboisProfileSelection; // explicitly `none` for RGB filters, a preset id, or user-edited matrices
    duboisMatrices?: VbAnaglyphMatrices;
}

// where one on-screen control was dragged to and how large it was made, against where the layout puts it
export interface TouchControlPlacement {
    // offset in CSS pixels, so a moved button stays put however the screen is shaped
    dx: number;
    dy: number;
    scale: number; // factor on the controller's size
}

// one arrangement per way the device is held, as the controller sits under the picture upright and beside it on its
// side. Keyed by control (see TouchControlId); a control without an entry stays where the layout puts it
export interface TouchControlsLayout {
    portrait?: Record<string, TouchControlPlacement>;
    landscape?: Record<string, TouchControlPlacement>;
}

// when the on-screen controller shows: `auto` while the screen is what is being played on (see touch-presence.ts)
export type TouchControlsMode = 'auto' | 'always' | 'never';

export interface VueportConfig {
    vbcSupportEnabled: boolean; // master switch for exposing any VB Color hardware/features to software
    // master switch over the shipped colorizations in PATCH_DATABASE: off, none applies by itself whatever the
    // individual entries say. See PatchStoreColorizations
    vbcAutoApplyColorPatches: boolean;
    // colorizations turned off one by one, by entry id; opt-out so a newly shipped colorization applies without a
    // new switch to find. Only read while vbcAutoApplyColorPatches is on
    vbcColorPatchesDisabled: string[];
    hardwareMode: string; // physical console model: Auto, original Virtual Boy, or VB Color
    renderingMode: string; // one of VbRenderingMode
    swapEyes: boolean; // in modes showing both eyes, show each where the other's would go; see DisplayMode.swapEyes
    // percent of stereo parallax, 0–200 in steps of 5: 100 is the real console, 0 flat, 200 twice as deep. Applied
    // in the core, see setStereoDepth
    stereoDepth: number;
    frameBlending: FrameBlending; // one of FrameBlending: where a frame is shown mixed with the one before it
    // columns as wide as the game's column table makes them on the real display unit, rather than even; see
    // setColumnGeometry
    columnTable: boolean;
    // a loaded or reset game comes up the way the display unit does when switched on; display only, see setMirrorSpinUp
    mirrorSpinUp: boolean;
    // with mirrorSpinUp, dark for the whole 4 seconds a real display unit takes rather than a moment
    mirrorSpinUpDelay: boolean;
    palette: string; // id of the palette in use, built-in or `custom:`-prefixed
    anaglyphPalette: string;
    customPalettes: CustomPaletteSetting[];
    customAnaglyphPalettes: CustomAnaglyphPaletteSetting[];
    scale: string; // one of EmulatorScale
    decoration: string; // one of EmulatorDecoration: what fills the view around the picture
    // halo color for the `ambient` decoration as #rrggbb; ignored with decorationColorFromPalette
    decorationColor: string;
    // take the `ambient` halo's color from the palette's fully-lit level instead of decorationColor; white in
    // Anaglyph, which has no single palette
    decorationColorFromPalette: boolean;
    decorationIntensity: number; // strength of the `ambient` and `immersion` halo, 0–100
    // on: screenshots use the screen's rendering mode and palettes at scale one, ignoring the four settings below;
    // off: composed to their own settings, as web pages and manuals rarely want the play mode
    screenshotUseDisplaySettings: boolean;
    screenshotRenderingMode: string; // one of VbRenderingMode, for screenshots; see screenshotUseDisplaySettings
    screenshotFrameBlending: FrameBlending; // one of FrameBlending, for screenshots; see screenshotUseDisplaySettings
    screenshotScale: number; // whole-number multiple of the mode's own size
    screenshotPalette: string; // id of the palette screenshots use, built-in or `custom:`-prefixed
    screenshotAnaglyphPalette: string;
    // as screenshotUseDisplaySettings, except the mode is settled when recording starts and held to the end, as most
    // players will not open a stream whose frame size changes
    videoUseDisplaySettings: boolean;
    videoRenderingMode: string; // one of VbRenderingMode, for recordings; see videoUseDisplaySettings
    videoFrameBlending: FrameBlending; // one of FrameBlending, for recordings; see videoUseDisplaySettings
    videoScale: number; // whole-number multiple of the mode's own size
    videoPalette: string; // id of the palette recordings use, built-in or `custom:`-prefixed
    videoAnaglyphPalette: string;
    videoQuality: string; // one of VideoQuality: the picture's bitrate
    // one of VideoFormat, the preferred container; a browser that cannot encode it records in the other (see
    // VideoRecorder.mimeTypes)
    videoFormat: string;
    sramInit: EmulatorSramInit;
    // how much of Game Pak RAM a cartridge answers on (see EmulatorSramWindow for why to narrow it). Global rather
    // than per ROM, as it is about what is being built for
    sramWindow: EmulatorSramWindow;
    // save file a game plays on, "A" to "Z" (see EMULATOR_SAVE_SLOTS). Global rather than per ROM, as it is about how
    // the user plays right now (a second run, an experiment)
    saveGameSlot: string;
    // off by default, as it writes a megabyte or so every interval unasked; buys a coarse rewind that survives a
    // crash (see autoSaveStateInterval, autoSaveStateCount)
    autoSaveStatesEnabled: boolean;
    autoSaveStateInterval: number; // seconds between automatic states
    autoSaveStateCount: number; // automatic states kept; the oldest falls out, manual states are never touched
    // whether closing a ROM (or VUEPort) writes a state to resume from. On by default: free until a game is closed
    // mid-level. One per ROM, overwritten; the next launch asks first, and never uses it in hardcore
    suspendResumeEnabled: boolean;
    // what opening a game does with the suspendResumeEnabled state: ask, or resume outright. Ignored while off and in
    // hardcore
    suspendResumeStart: EmulatorResumeStart;
    // where a ROM's save, save states and cheats are written. Defaults to app storage, which always works (a browser
    // never learns where a ROM came from); hosts that can write beside a ROM say so in their settings
    companionFiles: EmulatorCompanionLocation;
    player2SameControls: boolean;
    // per-device controller mappings, kept here as a host keymap knows no gamepads (VueportInputBindings is Theia's
    // keybinding registry in VES). See emulator-gamepad-profiles.ts, also for why normalized pads need no entry
    gamepadProfiles: GamepadProfile[];
    // player a controller drives in a linked pair, by device key; absent means connection order, right for one pad
    // per person plugged in in seating order
    gamepadPlayers: Record<string, number>;
    /**
     * Strength of game rumble on the controller when no Rumble Pack is there, in percent of the motors; 0 is off.
     * Full by default because such games were written to be felt, and many pads are on/off only: SDL's Switch driver
     * says so, and the 8BitDo 64's motor does not start below a threshold and runs flat out above it, so pulsing it only
     * rattles. On such pads a lower setting only drops weak effects. See GamepadRumble.
     */
    gamepadRumbleIntensity: number;
    // turbo rate in frames per half period (held this many, released as many); 2 is about 12.5 presses a second.
    // One rate for all turbo buttons, keyboard and pad
    turboRate: number;
    touchControls: TouchControlsMode; // the on-screen controller, see EmulatorTouchControls
    touchControlsOpacity: number; // in percent
    // in percent of the layout's size, for every control at once; one control's own factor is in the layout
    touchControlsSize: number;
    touchControlsDiagonals: boolean; // a thumb between two arms of a d-pad holds both directions
    // a thumb moved across a d-pad, or from one button onto the next, changes what it holds without lifting
    touchControlsSlide: boolean;
    touchControlsVibration: boolean; // a short buzz on every press, where the browser can (not Safari on iOS)
    touchControlsHighlight: boolean;
    // a game's rumble on the device's own motor while no pad with motors is there (Android; not Safari on iOS).
    // As strong as gamepadRumbleIntensity says
    touchControlsRumble: boolean;
    touchControlsLayout: TouchControlsLayout;
    rewindEnabled: boolean;
    rewindGranularity: number; // frames of emulation per rewind history entry
    rewindBufferSize: number; // rewind history budget, in MB
    slowMotionRatio: number;
    fastForwardRatio: number;
    // off by default: needs an account and network calls; hosts that cannot make them (a browser, see the
    // RetroAchievements service) show it fixed off with the reason
    retroAchievementsEnabled: boolean;
    /**
     * Hardcore disables cheats, macros, ROM patches, save-state loading, rewind and Debug mode, and runs the
     * achievement engine in hardcore; RetroAchievementsService and the host's controls enforce it. Hardcore unlocks stay
     * inert until RetroAchievements approves the VUEPort client (the memory editor, disassembler and rewind need
     * discussing with them first), but the client-side restrictions already apply.
     */
    retroAchievementsHardcore: boolean;
    // how each debug panel was left, by `"<panel>.<control>"` (atlas width, disassembly following the PC, ...). No
    // schema entry, as only the panels change it; sparse, and values of a mismatched type are ignored. See
    // VesEmulatorPanel.remembered
    debugPanelState: Record<string, string | number | boolean>;
    errorSoundEnabled: boolean;
    achievementSoundEnabled: boolean;
}

export const VUEPORT_DEFAULTS: VueportConfig = {
    vbcSupportEnabled: true,
    vbcAutoApplyColorPatches: false,
    vbcColorPatchesDisabled: [],
    hardwareMode: VbHardwareMode.AUTO,
    renderingMode: VbRenderingMode.LEFT,
    swapEyes: false,
    stereoDepth: 100,
    frameBlending: FrameBlending.SMART,
    columnTable: true,
    mirrorSpinUp: false,
    mirrorSpinUpDelay: true,
    palette: VB_DEFAULT_PALETTE_ID,
    anaglyphPalette: VB_DEFAULT_ANAGLYPH_PALETTE_ID,
    customPalettes: [],
    customAnaglyphPalettes: [],
    scale: EmulatorScale.AUTO,
    decoration: EmulatorDecoration.IMMERSION,
    decorationColor: '#ffffff',
    decorationColorFromPalette: false,
    decorationIntensity: 30,
    screenshotUseDisplaySettings: true,
    screenshotRenderingMode: VbRenderingMode.LEFT,
    screenshotFrameBlending: FrameBlending.SMART,
    screenshotScale: 1,
    screenshotPalette: VB_DEFAULT_PALETTE_ID,
    screenshotAnaglyphPalette: VB_DEFAULT_ANAGLYPH_PALETTE_ID,
    videoUseDisplaySettings: true,
    videoRenderingMode: VbRenderingMode.LEFT,
    videoFrameBlending: FrameBlending.SMART,
    // two, unlike a screenshot's one: 384x224 is smaller than any player shows it, and players do not scale
    // nearest-neighbor as the picture wants
    videoScale: 2,
    videoPalette: VB_DEFAULT_PALETTE_ID,
    videoAnaglyphPalette: VB_DEFAULT_ANAGLYPH_PALETTE_ID,
    videoQuality: 'medium',
    videoFormat: 'auto',
    sramInit: EmulatorSramInit.RANDOM,
    sramWindow: EmulatorSramWindow.AUTO,
    saveGameSlot: DEFAULT_SAVE_SLOT,
    autoSaveStatesEnabled: false,
    autoSaveStateInterval: 60,
    autoSaveStateCount: 5,
    suspendResumeEnabled: false,
    suspendResumeStart: EmulatorResumeStart.ASK,
    companionFiles: EmulatorCompanionLocation.STORAGE,
    player2SameControls: true,
    gamepadProfiles: [],
    gamepadPlayers: {},
    gamepadRumbleIntensity: 100,
    turboRate: DEFAULT_TURBO_RATE,
    touchControls: 'auto',
    touchControlsOpacity: 50,
    touchControlsSize: 100,
    touchControlsDiagonals: true,
    touchControlsSlide: true,
    touchControlsVibration: true,
    touchControlsHighlight: true,
    touchControlsRumble: true,
    touchControlsLayout: {},
    rewindEnabled: false,
    rewindGranularity: 1,
    rewindBufferSize: 256,
    slowMotionRatio: 8,
    fastForwardRatio: 4,
    retroAchievementsEnabled: false,
    retroAchievementsHardcore: false,
    debugPanelState: {},
    errorSoundEnabled: true,
    achievementSoundEnabled: true,
};

export const VUEPORT_SETTING_RANGES: Partial<Record<keyof VueportConfig, { min: number, max: number }>> = {
    stereoDepth: { min: 0, max: 200 },
    gamepadRumbleIntensity: { min: 0, max: 100 },
    turboRate: TURBO_RATE_RANGE,
    touchControlsOpacity: { min: 20, max: 100 },
    touchControlsSize: { min: 70, max: 140 },
    decorationIntensity: { min: 0, max: 100 },
    screenshotScale: { min: 1, max: 8 },
    videoScale: { min: 1, max: 8 },
    autoSaveStateInterval: { min: 10, max: 900 },
    autoSaveStateCount: { min: 1, max: 20 },
    rewindGranularity: { min: 1, max: 8 },
    rewindBufferSize: { min: 64, max: 512 },
    slowMotionRatio: { min: 1, max: 32 },
    fastForwardRatio: { min: 1, max: 32 },
};

// `ready` because a host may resolve settings asynchronously (VES's folder-scoped providers are not answering
// when a restored widget is built, and reads return defaults); the emulator waits once before startup reads
export interface VueportSettings {
    // settings this host has settled, with the reason for each; shown fixed with the reason rather than hidden, which
    // would look like a missing feature
    readonly fixed?: Partial<Record<keyof VueportConfig, string>>;
    // this host's own defaults where they differ from VUEPORT_DEFAULTS (the desktop keeps saves beside the ROM, which
    // a browser cannot), so "Reset to default" means this application's default
    readonly defaults?: Partial<VueportConfig>;
    get<K extends keyof VueportConfig>(key: K): VueportConfig[K];
    set<K extends keyof VueportConfig>(key: K, value: VueportConfig[K]): Promise<void>;
    readonly onDidChange: Event<keyof VueportConfig>;
    readonly ready: Promise<void>;
}

// what is bound to a command, and letting the user change it; the emulator owns no keymap (VES has one, a standalone
// host its own), so it asks rather than keeps
export interface VueportBindableCommand {
    id: string;
    label?: string; // title of whatever the host asks for a key with
    category?: string;
}

// nothing for hosts with in-memory mappings; a promise where the keymap is a file (the studio's Theia keymap,
// written through Monaco), not in force until it resolves, so callers that redraw must wait for it
export type VueportBindingWrite = void | Promise<void>;

export interface VueportInputBindings {
    // `compact` asks for the form that goes in a tooltip beside a label
    label(commandId: string, compact: boolean): string;
    // as KeyboardEvent.code spells them: all the key handler compares, and the same everywhere unlike binding objects
    keyCodes(commandId: string): string[];
    // asks for a key and binds it; true if the binding changed. `when` is the context for a new mapping, for commands
    // with none to copy. Takes the command, which carries its name; `title` overrides it in the prompt (the input
    // settings pass a node with the D-pad arrow as an icon)
    capture(command: VueportBindableCommand, when?: string, title?: ReactNode): Promise<boolean>;
    /**
     * Asks for a key for each command in turn and binds them all at once, or nothing if Escape comes first. Each
     * command gets exactly the pressed key, which replaces its other keys. `title` names the step ("Start · 6 of 14"),
     * `onStep` gets the index of the command about to be asked. Resolves true only if the set was saved.
     */
    captureAll(
        commands: VueportBindableCommand[],
        when: string | undefined,
        title: (command: VueportBindableCommand, step: number, total: number) => ReactNode,
        onStep?: (index: number) => void,
    ): Promise<boolean>;
    // offered as one button in the input settings; the per-command reset lives in the capture prompt
    resetToDefaults(): VueportBindingWrite;
    // adds a key the caller already has, as capture does once it has one; resolves whether it was new
    bind(commandId: string, code: string): boolean | Promise<boolean>;
    clear(commandId: string): VueportBindingWrite;
    // optional: without it there are no per-key remove buttons in the capture prompt (Clear All Mappings still works)
    unbind?(commandId: string, code: string): VueportBindingWrite;
    // what one key is called (`KeyA` as "A"), for a prompt listing keys one by one. Optional like unbind; without it
    // the prompt shows label whole
    keyLabel?(code: string): string;
    resetToDefault(commandId: string): VueportBindingWrite;
    // replaces what a set of commands answer to in one write (a fresh layout or a preset); what captureAll does with
    // what it collected
    replaceAll(codes: Record<string, string>): VueportBindingWrite;
}
