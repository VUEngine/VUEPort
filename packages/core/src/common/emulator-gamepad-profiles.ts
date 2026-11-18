/**
 * What a physical controller's buttons do, per device. The Gamepad API gives raw indices, and they are not portable:
 * Chrome and Firefox enumerate the same pad differently (Firefox reports an extra axis, shifting every index after it),
 * and an unrecognized pad comes in its HID descriptor's order. Portable is `mapping === 'standard'`: both browsers
 * normalize pads they recognize (Chromium's gamepad_standard_mappings.cc, Firefox since bug 1542893), so the built-in
 * presets are semantic, on the standard layout, differing only in face buttons and names. An unrecognized pad gets no
 * guess but the guided walk-through in the Game Pads settings, remembered per device. Free of DOM, so the whole
 * resolution path can be exercised from tests/gamepad-profile-probe.mjs.
 */

import type { EmulatorGamePadButton } from '../browser/emulator-commands';
import { EmulatorAction, EmulatorGamePadKeyCode } from '../browser/emulator-types';
import { VbKey } from './vb-constants';
import vbUsbAdapter from '../data/gamepad-profiles/vb-usb-adapter.json';
import EightBitDo64BtGecko from '../data/gamepad-profiles/8bitdo-64-bt-gecko.json';
import EightBitDo64BtChromium from '../data/gamepad-profiles/8bitdo-64-bt-chromium.json';
import EightBitDo64BtSdl from '../data/gamepad-profiles/8bitdo-64-bt-sdl.json';
import NintendoN64ControllerSdl from '../data/gamepad-profiles/nintendo-n64-controller-sdl.json';

// spelled out rather than read from EMULATOR_GAMEPAD_INPUTS, which would pull in the command table and its
// localization; the Record type makes a new button fail to compile until it gets a code
const GAMEPAD_BUTTON_KEY_CODES: Record<EmulatorGamePadButton, EmulatorGamePadKeyCode> = {
    a: EmulatorGamePadKeyCode.A,
    b: EmulatorGamePadKeyCode.B,
    start: EmulatorGamePadKeyCode.Start,
    select: EmulatorGamePadKeyCode.Select,
    lUp: EmulatorGamePadKeyCode.LUp,
    lRight: EmulatorGamePadKeyCode.LRight,
    lDown: EmulatorGamePadKeyCode.LDown,
    lLeft: EmulatorGamePadKeyCode.LLeft,
    rUp: EmulatorGamePadKeyCode.RUp,
    rRight: EmulatorGamePadKeyCode.RRight,
    rDown: EmulatorGamePadKeyCode.RDown,
    rLeft: EmulatorGamePadKeyCode.RLeft,
    lTrigger: EmulatorGamePadKeyCode.LT,
    rTrigger: EmulatorGamePadKeyCode.RT,
};

const GAMEPAD_BUTTONS = Object.keys(GAMEPAD_BUTTON_KEY_CODES) as EmulatorGamePadButton[];

export function vbKeyForButton(button: EmulatorGamePadButton): VbKey {
    return GAMEPAD_KEY_TO_VB_KEY[GAMEPAD_BUTTON_KEY_CODES[button]];
}

// here because keyboard and pad must end up as the same mask and this module is reachable from both; re-exported from
// emulator-input.ts
export const GAMEPAD_KEY_TO_VB_KEY: Record<EmulatorGamePadKeyCode, VbKey> = {
    [EmulatorGamePadKeyCode.A]: VbKey.A,
    [EmulatorGamePadKeyCode.B]: VbKey.B,
    [EmulatorGamePadKeyCode.Start]: VbKey.STA,
    [EmulatorGamePadKeyCode.Select]: VbKey.SEL,
    [EmulatorGamePadKeyCode.LUp]: VbKey.LU,
    [EmulatorGamePadKeyCode.LRight]: VbKey.LR,
    [EmulatorGamePadKeyCode.LDown]: VbKey.LD,
    [EmulatorGamePadKeyCode.LLeft]: VbKey.LL,
    [EmulatorGamePadKeyCode.RUp]: VbKey.RU,
    [EmulatorGamePadKeyCode.RRight]: VbKey.RR,
    [EmulatorGamePadKeyCode.RDown]: VbKey.RD,
    [EmulatorGamePadKeyCode.RLeft]: VbKey.RL,
    [EmulatorGamePadKeyCode.LT]: VbKey.LT,
    [EmulatorGamePadKeyCode.RT]: VbKey.RT,
};

export type GamepadSource =
    | { kind: 'button', index: number }
    | { kind: 'axis', index: number, direction: -1 | 1 } // direction: the deflection that counts as pressed
    // a d-pad as one axis (unmapped pads in Chrome and Firefox, e.g. the 8BitDo 64): eight positions from -1 (up)
    // clockwise to 1 (up-left), resting outside -1..1 (23/7 on the 8BitDo 64, in both). Read as a stick it's nonsense:
    // resting looks like full deflection, left and right sit at 5/7 and -3/7
    | { kind: 'hat', index: number, direction: GamepadHatDirection };

export type GamepadHatDirection = 'up' | 'right' | 'down' | 'left';

const HAT_DIRECTIONS: readonly GamepadHatDirection[] = ['up', 'right', 'down', 'left'];

export function gamepadSourceId(source: GamepadSource): string {
    switch (source.kind) {
        case 'button':
            return `b${source.index}`;
        case 'axis':
            return `a${source.index}${source.direction < 0 ? '-' : '+'}`;
        case 'hat':
            return `h${source.index}${source.direction[0]}`;
    }
}

export function parseGamepadSource(id: string): GamepadSource | undefined {
    const asButton = /^b(\d+)$/.exec(id);
    if (asButton) {
        return { kind: 'button', index: Number(asButton[1]) };
    }
    const asAxis = /^a(\d+)([-+])$/.exec(id);
    if (asAxis) {
        return { kind: 'axis', index: Number(asAxis[1]), direction: asAxis[2] === '-' ? -1 : 1 };
    }
    const asHat = /^h(\d+)([urdl])$/.exec(id);
    if (asHat) {
        const direction = HAT_DIRECTIONS.find(candidate => candidate[0] === asHat[2])!;
        return { kind: 'hat', index: Number(asHat[1]), direction };
    }
    return undefined;
}

export function sameGamepadSource(a: GamepadSource, b: GamepadSource): boolean {
    return gamepadSourceId(a) === gamepadSourceId(b);
}

// not cosmetic: a Nintendo pad's A sits where an Xbox pad's B does, so VB A (the rightmost face button) gets a
// differently named button per family
export type GamepadFamily = 'xbox' | 'playstation' | 'nintendo' | 'generic';

const GAMEPAD_FAMILIES: readonly GamepadFamily[] = ['xbox', 'playstation', 'nintendo', 'generic'];

// raw recordings must be kept apart per engine: the 8BitDo 64 shows its d-pad as axis 0 of 7 in Firefox and as a later
// axis in Chrome. `sdl` is the desktop shell reading pads through SDL; those say so via GamepadDescriptor.engine, as
// the shell's webview is WebKit
export type GamepadEngine = 'chromium' | 'gecko' | 'webkit' | 'sdl';

const GAMEPAD_ENGINES: readonly GamepadEngine[] = ['chromium', 'gecko', 'webkit', 'sdl'];

// asked of the user agent, not the pad id, as Safari writes `vendor-product-name` like Firefox
export function hostGamepadEngine(): GamepadEngine | undefined {
    if (typeof navigator === 'undefined' || !navigator.userAgent) {
        return undefined;
    }
    const agent = navigator.userAgent;
    if (/firefox\//i.test(agent)) {
        return 'gecko';
    }
    // every Chromium says AppleWebKit too, so Chrome is asked first; every browser on iOS is WebKit whatever it says
    if (/chrome\/|chromium\/|crios\//i.test(agent) && !/iphone|ipad|ipod/i.test(agent)) {
        return 'chromium';
    }
    return /applewebkit\//i.test(agent) ? 'webkit' : undefined;
}

// part of a raw layout like the engine: each system has its own backend (IOKit, Raw Input, joydev) with its own
// numbering
export type GamepadPlatform = 'macos' | 'windows' | 'linux' | 'chromeos' | 'android' | 'ios';

const GAMEPAD_PLATFORMS: readonly GamepadPlatform[] = ['macos', 'windows', 'linux', 'chromeos', 'android', 'ios'];

export function hostGamepadPlatform(): GamepadPlatform | undefined {
    if (typeof navigator === 'undefined') {
        return undefined;
    }
    const hinted = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
    const text = `${hinted ?? ''} ${navigator.userAgent ?? ''}`;
    // iPadOS asks for desktop pages as a Mac; the touch screen gives it away
    if (/iphone|ipad|ipod/i.test(text) || (/mac/i.test(text) && (navigator.maxTouchPoints ?? 0) > 1)) {
        return 'ios';
    }
    if (/android/i.test(text)) {
        return 'android';
    }
    if (/cros|chrome os/i.test(text)) {
        return 'chromeos';
    }
    if (/mac/i.test(text)) {
        return 'macos';
    }
    if (/win/i.test(text)) {
        return 'windows';
    }
    if (/linux/i.test(text)) {
        return 'linux';
    }
    return undefined;
}

// read by the host on its own loop, as it must work with no game running and while the palette takes the input
export type GamepadUiAction = 'commandPalette';

export const GAMEPAD_UI_ACTIONS: readonly GamepadUiAction[] = ['commandPalette'];

// eight slots, as the Macros panel numbers them (see setSlot in the macro store)
export type GamepadMacroAction =
    'macro1' | 'macro2' | 'macro3' | 'macro4' | 'macro5' | 'macro6' | 'macro7' | 'macro8';

export const GAMEPAD_MACRO_ACTIONS: readonly GamepadMacroAction[] =
    ['macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8'];

export function gamepadMacroSlot(action: string): number | undefined {
    const index = (GAMEPAD_MACRO_ACTIONS as readonly string[]).indexOf(action);
    return index === -1 ? undefined : index + 1;
}

export function gamepadMacroAction(slot: number): GamepadMacroAction {
    return GAMEPAD_MACRO_ACTIONS[slot - 1];
}

export type GamepadPadAction = EmulatorAction | GamepadUiAction | GamepadMacroAction;

const GAMEPAD_PAD_ACTIONS: readonly GamepadPadAction[] = [
    ...GAMEPAD_UI_ACTIONS,
    ...Object.values(EmulatorAction),
    ...GAMEPAD_MACRO_ACTIONS,
];

const isUiAction = (action: string): action is GamepadUiAction =>
    (GAMEPAD_UI_ACTIONS as readonly string[]).includes(action);

export type GamepadButtonMap = Partial<Record<EmulatorGamePadButton, GamepadSource[]>>;

export interface GamepadProfile {
    // `vendor:product` in lower-case hex ("054c:05c4") when the id carries them, otherwise the whole id (see
    // gamepadDeviceKey)
    device: string;
    label?: string;
    preset?: string; // absent for a profile built by hand
    family: GamepadFamily;
    // several sources per button on purpose: the standard presets put both d-pad and left stick on the VB's left cross
    buttons: GamepadButtonMap;
    turbo?: GamepadButtonMap; // a source drives either this or `buttons`, never both
    actions?: Partial<Record<GamepadPadAction, GamepadSource[]>>;
    deadZone: number; // 0-1, generous by default, as the control it stands in for is digital
}

export const DEFAULT_GAMEPAD_DEAD_ZONE = 0.5;

export const GAMEPAD_DEAD_ZONE_RANGE = { min: 0.1, max: 0.9 };

const BUTTON_THRESHOLD = 0.5;

const padButton = (index: number): GamepadSource => ({ kind: 'button', index });
const padAxis = (index: number, direction: -1 | 1): GamepadSource =>
    ({ kind: 'axis', index, direction });

const STANDARD_BUTTONS: Record<EmulatorGamePadButton, GamepadSource[]> = {
    a: [padButton(1)], // the rightmost face button, with 0 below it as B
    b: [padButton(0)],
    select: [padButton(8)],
    start: [padButton(9)],
    lTrigger: [padButton(4), padButton(6)], // shoulder and trigger
    rTrigger: [padButton(5), padButton(7)],
    lUp: [padButton(12), padAxis(1, -1)], // d-pad and left stick
    lDown: [padButton(13), padAxis(1, 1)],
    lLeft: [padButton(14), padAxis(0, -1)],
    lRight: [padButton(15), padAxis(0, 1)],
    rUp: [padAxis(3, -1)],
    rDown: [padAxis(3, 1)],
    rLeft: [padAxis(2, -1)],
    rRight: [padAxis(2, 1)],
};

// save and load states are left off on purpose: a stray press overwrites a save, and stick clicks happen by accident
const STANDARD_ACTIONS: Partial<Record<GamepadPadAction, GamepadSource[]>> = {
    commandPalette: [padButton(16)], // Home, which no game uses
    [EmulatorAction.Rewind]: [padButton(2)],
    [EmulatorAction.ToggleFastForward]: [padButton(3)],
    [EmulatorAction.PauseToggle]: [padButton(10)],
    [EmulatorAction.Screenshot]: [padButton(11)],
};

export interface GamepadPreset {
    id: string;
    name: string; // English; localized through gamepadPresetLabel
    family: GamepadFamily;
    manualOnly?: boolean; // offered by hand only, never the automatic answer for a detected pad
    // only on a bundled preset for one device (see GamepadProfileFile): offered only for that pad, and only while the
    // browser reports it as it did when recorded
    match?: GamepadDeviceMatch;
    deadZone?: number;
    buttons: GamepadButtonMap;
    turbo?: GamepadButtonMap;
    actions?: Partial<Record<GamepadPadAction, GamepadSource[]>>;
    // per source id ("b8": "C↑"), for pads that fit no family, e.g. an N64 pad with its C buttons on Back and the face
    // buttons
    labels?: Record<string, string>;
}

// a raw pad's table stops being right once a browser normalizes it, and browsers disagree on raw pads (extra axes, hats
// as an axis or four buttons). A pad showing different button or axis counts than when recorded gets no guess rather
// than a wrong one
export interface GamepadDeviceMatch {
    device?: string;
    name?: string; // any case
    mapping: string; // `'standard'`, or `''` for raw
    // absent means any engine, right only for a pad laid out the same everywhere (like the VB USB Adapter's buttons),
    // as two engines can show a raw pad with the same counts in a different order
    engine?: GamepadEngine;
    platform?: GamepadPlatform;
    buttons?: number;
    axes?: number;
}

// what the Game Pads settings export and what ships in src/data/gamepad-profiles/; bundling one is dropping an export
// into that folder and listing it in BUNDLED_GAMEPAD_PROFILES
export interface GamepadProfileFile {
    format: typeof GAMEPAD_PROFILE_FORMAT;
    version: 1;
    id: string;
    name: string;
    family: GamepadFamily;
    match: GamepadDeviceMatch;
    deadZone: number;
    buttons: GamepadButtonMap;
    turbo?: GamepadButtonMap;
    actions?: Partial<Record<GamepadPadAction, GamepadSource[]>>;
    labels?: Record<string, string>;
}

export const GAMEPAD_PROFILE_FORMAT = 'vueport-gamepad-profile';

const BUNDLED_GAMEPAD_PROFILES: unknown[] = [
    vbUsbAdapter,
    EightBitDo64BtGecko,
    EightBitDo64BtChromium,
    EightBitDo64BtSdl,
    // Switch Online N64 controller, and the 8BitDo 64 in Switch mode. Read by SDL's Switch driver, the same on every
    // system, so no platform: C buttons on Back, West, North and Misc 2. Measured off the 8BitDo with the shell's raw
    // log, 2026-10-08
    NintendoN64ControllerSdl,
];

/**
 * The standard presets share one button table and differ only in family, which picks the glyphs. `standard-nofaceswap`
 * is for pads (mostly Nintendo layouts mapped positionally by the browser) that end up with A and B swapped against the
 * print; offered by hand only, as the id cannot tell. The bundled ones are one device's recorded mapping each, matched
 * by `match`.
 */
export const GAMEPAD_PRESETS: GamepadPreset[] = [
    {
        id: 'standard-xbox',
        name: 'Xbox',
        family: 'xbox',
        buttons: STANDARD_BUTTONS,
        actions: STANDARD_ACTIONS,
    },
    {
        id: 'standard-playstation',
        name: 'PlayStation',
        family: 'playstation',
        buttons: STANDARD_BUTTONS,
        actions: STANDARD_ACTIONS,
    },
    {
        id: 'standard-nintendo',
        name: 'Nintendo',
        family: 'nintendo',
        buttons: STANDARD_BUTTONS,
        actions: STANDARD_ACTIONS,
    },
    { id: 'standard-generic', name: 'Standard', family: 'generic', buttons: STANDARD_BUTTONS, actions: STANDARD_ACTIONS },
    {
        id: 'standard-nofaceswap',
        name: 'Standard (A/B swapped)',
        family: 'generic',
        manualOnly: true,
        buttons: { ...STANDARD_BUTTONS, a: [padButton(0)], b: [padButton(1)] },
        actions: STANDARD_ACTIONS,
    },
    ...BUNDLED_GAMEPAD_PROFILES.map(file => {
        const preset = gamepadPresetFromFile(file);
        if (!preset) {
            // a bundled file that doesn't read is a build mistake, not something to skip quietly; the probe reads every
            // one
            throw new Error(`Bundled game pad profile does not read: ${JSON.stringify(file).slice(0, 80)}`);
        }
        return preset;
    }),
];

export function gamepadPreset(id: string | undefined): GamepadPreset | undefined {
    return id === undefined ? undefined : GAMEPAD_PRESETS.find(preset => preset.id === id);
}

export interface GamepadIdentity {
    vendor?: string;
    product?: string;
    name: string;
    key: string;
}

// Chrome: `Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)`, Firefox: `054c-05c4-Wireless
// Controller`. An id in neither shape has no ids, and the whole id becomes the key
export function gamepadIdentity(id: string): GamepadIdentity {
    let vendor: string | undefined;
    let product: string | undefined;

    const chrome = /vendor:\s*([0-9a-f]{4}).*?product:\s*([0-9a-f]{4})/i.exec(id);
    if (chrome) {
        vendor = chrome[1].toLowerCase();
        product = chrome[2].toLowerCase();
    }
    const firefox = /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id);
    if (firefox) {
        vendor = firefox[1].toLowerCase();
        product = firefox[2].toLowerCase();
    }

    return {
        vendor,
        product,
        name: gamepadName(id),
        key: vendor && product ? `${vendor}:${product}` : id,
    };
}

// returns the id untouched if its shape is unknown
export function gamepadName(id: string): string {
    // the trailing parenthetical when it's the API talking: vendor and product ids, or the layout it maps to
    let name = id.replace(
        /\s*\([^()]*\b(?:vendor:|product:|standard gamepad)[^()]*\)\s*$/i, '');
    // Firefox leads with the same pair again, as `054c-05c4-`
    name = name.replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim();
    return name || id;
}

export function gamepadDeviceKey(id: string): string {
    return gamepadIdentity(id).key;
}

// only vendors where the id alone settles it. 8BitDo (2dc8) ships Nintendo, Xbox and PlayStation pads under one id, so
// its models are told apart by name or by the harvested database
const FAMILY_BY_VENDOR: Record<string, GamepadFamily> = {
    '045e': 'xbox',        // Microsoft
    '054c': 'playstation', // Sony
    '057e': 'nintendo',    // Nintendo
    '0f0d': 'nintendo',    // Hori, near enough always a Nintendo layout
    '0e6f': 'xbox',        // PDP
    '24c6': 'xbox',        // PowerA / ThrustMaster Xbox line
};

const FAMILY_BY_NAME: { pattern: RegExp, family: GamepadFamily }[] = [
    { pattern: /xbox|xinput|x-?input/i, family: 'xbox' },
    { pattern: /dual\s*sense|dual\s*shock|playstation|\bps[345]\b/i, family: 'playstation' },
    { pattern: /switch|joy-?con|nintendo|\bsnes\b|\bnes\b|wii/i, family: 'nintendo' },
    // 8BitDo names its Nintendo-layout pads after the consoles they copy
    { pattern: /\bsn30\b|\bsf30\b|\bn30\b/i, family: 'nintendo' },
];

// harvested by scripts/fetch-controller-db.mjs, keyed by `vendor:product`
export interface GamepadDatabaseEntry {
    name: string;
    family?: GamepadFamily;
}

export type GamepadDatabase = Record<string, GamepadDatabaseEntry>;

// database first, then vendor id, then name; falls back to `generic`, which shows bare indices rather than a wrong
// glyph
export function detectGamepadFamily(
    identity: GamepadIdentity,
    database?: GamepadDatabase,
): GamepadFamily {
    const entry = database?.[identity.key];
    if (entry?.family) {
        return entry.family;
    }
    if (identity.vendor && FAMILY_BY_VENDOR[identity.vendor]) {
        return FAMILY_BY_VENDOR[identity.vendor];
    }
    const name = entry?.name ?? identity.name;
    for (const { pattern, family } of FAMILY_BY_NAME) {
        if (pattern.test(name)) {
            return family;
        }
    }
    return 'generic';
}

export interface GamepadDescriptor {
    id: string;
    mapping: string;
    buttons?: ArrayLike<unknown>; // only counted, to tell layouts apart (see GamepadDeviceMatch)
    axes?: ArrayLike<unknown>;
    engine?: GamepadEngine; // the host's own when not given
    platform?: GamepadPlatform;
}

function matchesDevice(match: GamepadDeviceMatch, pad: GamepadDescriptor, identity: GamepadIdentity): boolean {
    if ((match.mapping === 'standard') !== (pad.mapping === 'standard')) {
        return false;
    }
    if (match.engine !== undefined && match.engine !== (pad.engine ?? hostGamepadEngine())) {
        return false;
    }
    if (match.platform !== undefined && match.platform !== (pad.platform ?? hostGamepadPlatform())) {
        return false;
    }
    const sameDevice = match.device !== undefined && match.device === identity.key;
    const sameName = match.name !== undefined && match.name.toLowerCase() === identity.name.toLowerCase();
    if (!sameDevice && !sameName) {
        return false;
    }
    if (match.buttons !== undefined && pad.buttons && pad.buttons.length !== match.buttons) {
        return false;
    }
    return match.axes === undefined || !pad.axes || pad.axes.length === match.axes;
}

function devicePresetsFor(pad: GamepadDescriptor, identity: GamepadIdentity): GamepadPreset[] {
    return GAMEPAD_PRESETS.filter(preset => preset.match && matchesDevice(preset.match, pad, identity));
}

export interface ResolvedGamepadProfile {
    profile: GamepadProfile;
    // `unmapped`: the browser doesn't recognize the pad and nothing was recorded yet, the one case with no working
    // mapping
    origin: 'stored' | 'preset' | 'unmapped';
    preset?: GamepadPreset;
    identity: GamepadIdentity;
}

// undefined for a pad the browser hasn't normalized, as no table here can know its HID order and a wrong guess looks
// configured. A bundled device mapping (see `match`) wins over the general presets, for a normalized pad too
export function detectGamepadPreset(
    pad: GamepadDescriptor,
    database?: GamepadDatabase,
): GamepadPreset | undefined {
    const identity = gamepadIdentity(pad.id);
    const own = devicePresetsFor(pad, identity)[0];
    if (own || pad.mapping !== 'standard') {
        return own;
    }
    const family = detectGamepadFamily(identity, database);
    return GAMEPAD_PRESETS.find(preset =>
        !preset.manualOnly && !preset.match && preset.family === family)
        ?? gamepadPreset('standard-generic');
}

// the A/B-swapped one only where the standard layout is in force, a device's own only for that device while shown as
// recorded (first, as it fits)
export function offeredGamepadPresets(pad: GamepadDescriptor): GamepadPreset[] {
    const standard = pad.mapping === 'standard';
    const own = devicePresetsFor(pad, gamepadIdentity(pad.id));
    const general = GAMEPAD_PRESETS.filter(preset =>
        !preset.match && (!preset.manualOnly || standard));
    return [...own, ...general];
}

export function profileFromPreset(
    preset: GamepadPreset,
    identity: GamepadIdentity,
    database?: GamepadDatabase,
): GamepadProfile {
    return {
        device: identity.key,
        label: database?.[identity.key]?.name ?? identity.name,
        preset: preset.id,
        family: preset.family,
        // copied rather than shared: every preset points at one STANDARD_BUTTONS, and a profile is about to be edited
        buttons: cloneButtons(preset.buttons),
        ...nonEmpty('turbo', cloneButtons(preset.turbo ?? {})),
        ...(preset.actions ? { actions: cloneActions(preset.actions) } : {}),
        deadZone: preset.deadZone ?? DEFAULT_GAMEPAD_DEAD_ZONE,
    };
}

export function gamepadProfileFile(profile: GamepadProfile, pad: GamepadDescriptor): GamepadProfileFile {
    const identity = gamepadIdentity(pad.id);
    const name = profile.label ?? identity.name;
    const actions = profile.actions ? cloneActions(profile.actions) : undefined;
    const engine = pad.engine ?? hostGamepadEngine();
    const platform = pad.platform ?? hostGamepadPlatform();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gamepad';
    return {
        format: GAMEPAD_PROFILE_FORMAT,
        version: 1,
        // engine and system in the id too, as the same pad recorded under two has to bundle as two presets
        id: [slug, engine, platform].filter(Boolean).join('-'),
        name,
        family: profile.family,
        match: {
            device: identity.vendor && identity.product ? identity.key : undefined,
            name: identity.name,
            mapping: pad.mapping === 'standard' ? 'standard' : '',
            engine,
            platform,
            buttons: pad.buttons?.length,
            axes: pad.axes?.length,
        },
        deadZone: profile.deadZone,
        buttons: cloneButtons(profile.buttons),
        ...nonEmpty('turbo', cloneButtons(profile.turbo ?? {})),
        ...(actions && Object.keys(actions).length > 0 ? { actions } : {}),
    };
}

export function gamepadPresetFromFile(file: unknown): GamepadPreset | undefined {
    if (typeof file !== 'object' || file === null) {
        return undefined;
    }
    const candidate = file as Partial<GamepadProfileFile>;
    const match = candidate.match;
    if (candidate.format !== GAMEPAD_PROFILE_FORMAT || candidate.version !== 1
        || typeof candidate.id !== 'string' || !candidate.id
        || typeof candidate.name !== 'string'
        || typeof match !== 'object' || match === null
        || (typeof match.device !== 'string' && typeof match.name !== 'string')) {
        return undefined;
    }
    const count = (value: unknown): number | undefined =>
        Number.isInteger(value) && (value as number) >= 0 ? value as number : undefined;
    const buttons = normalizeButtons(candidate.buttons);
    const turbo = normalizeButtons(candidate.turbo);
    const actions: Partial<Record<GamepadPadAction, GamepadSource[]>> = {};
    for (const action of GAMEPAD_PAD_ACTIONS) {
        const sources = normalizeSources(candidate.actions?.[action]);
        if (sources.length > 0) {
            actions[action] = sources;
        }
    }
    // short strings on real source ids only, as they are drawn on the picture
    const labels: Record<string, string> = {};
    for (const [id, label] of Object.entries(candidate.labels ?? {})) {
        if (parseGamepadSource(id) && typeof label === 'string' && label.length > 0 && label.length <= 8) {
            labels[id] = label;
        }
    }
    return {
        id: candidate.id,
        name: candidate.name,
        family: GAMEPAD_FAMILIES.includes(candidate.family as GamepadFamily)
            ? candidate.family as GamepadFamily
            : 'generic',
        match: {
            device: typeof match.device === 'string' ? match.device.toLowerCase() : undefined,
            name: typeof match.name === 'string' ? match.name : undefined,
            mapping: match.mapping === 'standard' ? 'standard' : '',
            engine: GAMEPAD_ENGINES.find(engine => engine === match.engine),
            platform: GAMEPAD_PLATFORMS.find(platform => platform === match.platform),
            buttons: count(match.buttons),
            axes: count(match.axes),
        },
        deadZone: typeof candidate.deadZone === 'number'
            ? Math.min(GAMEPAD_DEAD_ZONE_RANGE.max, Math.max(GAMEPAD_DEAD_ZONE_RANGE.min, candidate.deadZone))
            : undefined,
        buttons,
        ...nonEmpty('turbo', turbo),
        ...(Object.keys(actions).length > 0 ? { actions } : {}),
        ...(Object.keys(labels).length > 0 ? { labels } : {}),
    };
}

function nonEmpty<K extends string>(key: K, map: GamepadButtonMap): { [P in K]?: GamepadButtonMap } {
    return Object.keys(map).length > 0 ? { [key]: map } as { [P in K]?: GamepadButtonMap } : {};
}

function normalizeButtons(buttons: unknown): GamepadButtonMap {
    const result: GamepadButtonMap = {};
    if (typeof buttons !== 'object' || buttons === null) {
        return result;
    }
    for (const key of GAMEPAD_BUTTONS) {
        const sources = normalizeSources((buttons as GamepadButtonMap)[key]);
        if (sources.length > 0) {
            result[key] = sources;
        }
    }
    return result;
}

function cloneActions(
    actions: Partial<Record<GamepadPadAction, GamepadSource[]>>,
): Partial<Record<GamepadPadAction, GamepadSource[]>> {
    const copy: Partial<Record<GamepadPadAction, GamepadSource[]>> = {};
    for (const action of GAMEPAD_PAD_ACTIONS) {
        const sources = actions[action];
        if (sources && sources.length > 0) {
            copy[action] = sources.map(source => ({ ...source }));
        }
    }
    return copy;
}

function cloneButtons(buttons: GamepadButtonMap): GamepadButtonMap {
    const copy: GamepadButtonMap = {};
    for (const key of GAMEPAD_BUTTONS) {
        const sources = buttons[key];
        if (sources && sources.length > 0) {
            copy[key] = sources.map(source => ({ ...source }));
        }
    }
    return copy;
}

// in `stored` the first entry filed under the device wins
export function resolveGamepadProfile(
    pad: GamepadDescriptor,
    stored: GamepadProfile[] = [],
    database?: GamepadDatabase,
): ResolvedGamepadProfile {
    const identity = gamepadIdentity(pad.id);
    const preset = detectGamepadPreset(pad, database);
    const mine = stored.find(profile => profile.device === identity.key);
    if (mine) {
        return {
            profile: normalizeProfile(mine, identity, database),
            origin: 'stored',
            // the preset it was built from if that still exists, else what the pad detects as now
            preset: gamepadPreset(mine.preset) ?? preset,
            identity,
        };
    }
    if (preset) {
        return { profile: profileFromPreset(preset, identity, database), origin: 'preset', preset, identity };
    }
    return {
        profile: {
            device: identity.key,
            label: database?.[identity.key]?.name ?? identity.name,
            family: detectGamepadFamily(identity, database),
            buttons: {},
            deadZone: DEFAULT_GAMEPAD_DEAD_ZONE,
        },
        origin: 'unmapped',
        identity,
    };
}

// settings come from localStorage and an editable file; drop anything unusable here, as a malformed index in the input
// loop would silently stop a button working
export function normalizeProfile(
    profile: GamepadProfile,
    identity?: GamepadIdentity,
    database?: GamepadDatabase,
): GamepadProfile {
    const buttons = normalizeButtons(profile.buttons);
    const turbo = normalizeButtons(profile.turbo);

    const actions: Partial<Record<GamepadPadAction, GamepadSource[]>> = {};
    for (const [action, sources] of Object.entries(profile.actions ?? {})) {
        if (!(GAMEPAD_PAD_ACTIONS as readonly string[]).includes(action)) {
            continue;
        }
        const normalized = normalizeSources(sources);
        if (normalized.length > 0) {
            actions[action as GamepadPadAction] = normalized;
        }
    }

    const deadZone = typeof profile.deadZone === 'number' && Number.isFinite(profile.deadZone)
        ? Math.min(GAMEPAD_DEAD_ZONE_RANGE.max, Math.max(GAMEPAD_DEAD_ZONE_RANGE.min, profile.deadZone))
        : DEFAULT_GAMEPAD_DEAD_ZONE;

    const deviceKey = identity?.key ?? profile.device;
    return {
        device: deviceKey,
        label: profile.label ?? database?.[deviceKey]?.name ?? identity?.name,
        preset: gamepadPreset(profile.preset)?.id,
        family: profile.family ?? (identity ? detectGamepadFamily(identity, database) : 'generic'),
        buttons,
        ...nonEmpty('turbo', turbo),
        ...(Object.keys(actions).length > 0 ? { actions } : {}),
        deadZone,
    };
}

function normalizeSources(sources: unknown): GamepadSource[] {
    if (!Array.isArray(sources)) {
        return [];
    }
    const seen = new Set<string>();
    const result: GamepadSource[] = [];
    for (const source of sources) {
        const valid = normalizeSource(source);
        if (!valid) {
            continue;
        }
        const id = gamepadSourceId(valid);
        if (!seen.has(id)) {
            seen.add(id);
            result.push(valid);
        }
    }
    return result;
}

function normalizeSource(source: unknown): GamepadSource | undefined {
    if (typeof source !== 'object' || source === null) {
        return undefined;
    }
    const candidate = source as Partial<GamepadSource> & { direction?: number };
    if (!Number.isInteger(candidate.index) || (candidate.index as number) < 0) {
        return undefined;
    }
    if (candidate.kind === 'button') {
        return { kind: 'button', index: candidate.index as number };
    }
    if (candidate.kind === 'axis') {
        return {
            kind: 'axis',
            index: candidate.index as number,
            direction: ((candidate.direction as number | undefined) ?? 0) < 0 ? -1 : 1,
        };
    }
    if (candidate.kind === 'hat') {
        const direction = HAT_DIRECTIONS.find(known => known === candidate.direction);
        return direction ? { kind: 'hat', index: candidate.index as number, direction } : undefined;
    }
    return undefined;
}

export interface GamepadReading {
    buttons: readonly { pressed: boolean, value: number }[];
    axes: readonly number[];
}

// a stick never leaves -1..1; a hat rests beyond it (23/7 on the 8BitDo 64)
const HAT_REST_MARGIN = 0.05;

function isHatAtRest(value: number): boolean {
    return Math.abs(value) > 1 + HAT_REST_MARGIN;
}

// the eight positions are 2/7 apart; this is well under half of that
const HAT_POSITION_TOLERANCE = 0.06;

// only a value actually near a position counts: Chrome reports every axis as 0 until the pad is first used, halfway
// between down-left and down, so an untouched 8BitDo 64 held its d-pad down
function hatDirections(value: number): GamepadHatDirection[] {
    if (isHatAtRest(value) || Number.isNaN(value)) {
        return [];
    }
    const steps = (value + 1) * 3.5;
    if (Math.abs(steps - Math.round(steps)) / 3.5 > HAT_POSITION_TOLERANCE) {
        return [];
    }
    const position = Math.round(steps) & 7;
    // each cardinal owns its own position and the diagonal on either side
    return HAT_DIRECTIONS.filter((_, cardinal) => {
        const offset = (position - cardinal * 2 + 8) & 7;
        return offset === 0 || offset === 1 || offset === 7;
    });
}

export function isSourcePressed(
    reading: GamepadReading,
    source: GamepadSource,
    deadZone: number,
): boolean {
    if (source.kind === 'button') {
        const held = reading.buttons[source.index];
        return held !== undefined && (held.pressed || held.value > BUTTON_THRESHOLD);
    }
    const value = reading.axes[source.index];
    if (value === undefined) {
        return false;
    }
    if (source.kind === 'hat') {
        return hatDirections(value).includes(source.direction);
    }
    // a hat at rest bound as a stick would otherwise hold its button while nothing is pressed
    if (isHatAtRest(value)) {
        return false;
    }
    return source.direction < 0 ? value <= -deadZone : value >= deadZone;
}

/**
 * Every source held, as ids, for the settings page to notice presses and light up held controls. Axes go through the
 * profile's dead zone, so the settings show what the game feels. `hats` is the caller's to keep across readings, and
 * this grows it: a hat can only be told from a stick at rest (out of a stick's range), and a d-pad rests long before
 * anyone presses it.
 */
export function pressedGamepadSources(
    reading: GamepadReading,
    deadZone: number,
    // kept by the caller and grown here: a hat can only be told from a stick at rest, and a d-pad rests long before
    // anyone presses it
    hats: Set<number> = new Set(),
): Set<string> {
    const pressed = new Set<string>();
    reading.buttons.forEach((held, index) => {
        if (held && (held.pressed || held.value > BUTTON_THRESHOLD)) {
            pressed.add(gamepadSourceId({ kind: 'button', index }));
        }
    });
    reading.axes.forEach((value, index) => {
        if (isHatAtRest(value)) {
            hats.add(index);
            return;
        }
        if (hats.has(index)) {
            for (const direction of hatDirections(value)) {
                pressed.add(gamepadSourceId({ kind: 'hat', index, direction }));
            }
            return;
        }
        if (value <= -deadZone) {
            pressed.add(gamepadSourceId({ kind: 'axis', index, direction: -1 }));
        } else if (value >= deadZone) {
            pressed.add(gamepadSourceId({ kind: 'axis', index, direction: 1 }));
        }
    });
    return pressed;
}

export interface GamepadContribution {
    keys: number;
    actions: Set<EmulatorAction>;
    uiActions: Set<GamepadUiAction>;
    turboKeys: number;
    macroSlots: Set<number>; // 1-based
}

export function readGamepadContribution(
    reading: GamepadReading,
    profile: GamepadProfile,
): GamepadContribution {
    const held = (sources: GamepadSource[] | undefined): boolean =>
        sources?.some(source => isSourcePressed(reading, source, profile.deadZone)) ?? false;
    let keys = 0;
    let turboKeys = 0;
    for (const key of GAMEPAD_BUTTONS) {
        if (held(profile.buttons[key])) {
            keys |= vbKeyForButton(key);
        }
        if (held(profile.turbo?.[key])) {
            turboKeys |= vbKeyForButton(key);
        }
    }

    const actions = new Set<EmulatorAction>();
    const uiActions = new Set<GamepadUiAction>();
    const macroSlots = new Set<number>();
    for (const [action, sources] of Object.entries(profile.actions ?? {})) {
        if (held(sources)) {
            const slot = gamepadMacroSlot(action);
            if (slot !== undefined) {
                macroSlots.add(slot);
            } else if (isUiAction(action)) {
                uiActions.add(action);
            } else {
                actions.add(action as EmulatorAction);
            }
        }
    }

    return { keys, actions, uiActions, turboKeys, macroSlots };
}

// every assignment starts from this, as one button driving two things is never wanted and hard to notice
function withSourceFreed(profile: GamepadProfile, source: GamepadSource): {
    buttons: GamepadButtonMap,
    turbo: GamepadButtonMap,
    actions: Partial<Record<GamepadPadAction, GamepadSource[]>>,
} {
    const strip = (map: GamepadButtonMap | undefined): GamepadButtonMap => {
        const result: GamepadButtonMap = {};
        for (const key of GAMEPAD_BUTTONS) {
            const remaining = withoutSource(map?.[key], source);
            if (remaining.length > 0) {
                result[key] = remaining;
            }
        }
        return result;
    };
    const actions: Partial<Record<GamepadPadAction, GamepadSource[]>> = {};
    for (const [action, sources] of Object.entries(profile.actions ?? {})) {
        const remaining = withoutSource(sources, source);
        if (remaining.length > 0) {
            actions[action as GamepadPadAction] = remaining;
        }
    }
    return { buttons: strip(profile.buttons), turbo: strip(profile.turbo), actions };
}

function withMaps(
    profile: GamepadProfile,
    maps: ReturnType<typeof withSourceFreed>,
): GamepadProfile {
    const { turbo: unused, ...rest } = profile;
    // `preset` is kept even after hand edits, as that's where "reset to preset" goes back to
    return { ...rest, buttons: maps.buttons, ...nonEmpty('turbo', maps.turbo), actions: maps.actions };
}

// replaces by default, as pressing a button in the settings usually means only that one
export function assignGamepadButton(
    profile: GamepadProfile,
    target: EmulatorGamePadButton,
    source: GamepadSource,
    add = false, // the deliberate second step, for a d-pad and a stick on the same cross
): GamepadProfile {
    const maps = withSourceFreed(profile, source);
    maps.buttons[target] = add ? [...(maps.buttons[target] ?? []), source] : [source];
    return withMaps(profile, maps);
}

export function assignGamepadTurbo(
    profile: GamepadProfile,
    target: EmulatorGamePadButton,
    source: GamepadSource,
    add = false,
): GamepadProfile {
    const maps = withSourceFreed(profile, source);
    maps.turbo[target] = add ? [...(maps.turbo[target] ?? []), source] : [source];
    return withMaps(profile, maps);
}

export function assignGamepadAction(
    profile: GamepadProfile,
    target: GamepadPadAction,
    source: GamepadSource,
    add = false,
): GamepadProfile {
    const maps = withSourceFreed(profile, source);
    maps.actions[target] = add ? [...(maps.actions[target] ?? []), source] : [source];
    return withMaps(profile, maps);
}

function withoutSource(sources: GamepadSource[] | undefined, source: GamepadSource): GamepadSource[] {
    return (sources ?? []).filter(existing => !sameGamepadSource(existing, source));
}

export function removeGamepadSource(profile: GamepadProfile, source: GamepadSource): GamepadProfile {
    return withMaps(profile, withSourceFreed(profile, source));
}

export function clearGamepadButton(
    profile: GamepadProfile,
    target: EmulatorGamePadButton,
): GamepadProfile {
    const buttons = { ...profile.buttons };
    delete buttons[target];
    return { ...profile, buttons };
}

export function clearGamepadTurbo(
    profile: GamepadProfile,
    target: EmulatorGamePadButton,
): GamepadProfile {
    const { turbo, ...rest } = profile;
    const remaining = { ...(turbo ?? {}) };
    delete remaining[target];
    return { ...rest, ...nonEmpty('turbo', remaining) };
}

export function clearGamepadAction(
    profile: GamepadProfile,
    target: GamepadPadAction,
): GamepadProfile {
    const actions = { ...(profile.actions ?? {}) };
    delete actions[target];
    return { ...profile, actions };
}

// exactly one entry per device; every edit goes through this
export function storeGamepadProfile(
    stored: GamepadProfile[],
    profile: GamepadProfile,
): GamepadProfile[] {
    const others = stored.filter(existing => existing.device !== profile.device);
    return [...others, profile];
}

export function gamepadProfileMatchesPreset(profile: GamepadProfile, preset: GamepadPreset): boolean {
    const ids = (sources: GamepadSource[] | undefined): string =>
        (sources ?? []).map(gamepadSourceId).sort().join();
    return profile.deadZone === (preset.deadZone ?? DEFAULT_GAMEPAD_DEAD_ZONE)
        && GAMEPAD_BUTTONS.every(key => ids(profile.buttons[key]) === ids(preset.buttons[key]))
        && GAMEPAD_BUTTONS.every(key => ids(profile.turbo?.[key]) === ids(preset.turbo?.[key]))
        && GAMEPAD_PAD_ACTIONS.every(action => ids(profile.actions?.[action]) === ids(preset.actions?.[action]));
}

// so the pad goes back to whatever is detected
export function forgetGamepadProfile(
    stored: GamepadProfile[],
    device: string,
): GamepadProfile[] {
    return stored.filter(existing => existing.device !== device);
}
