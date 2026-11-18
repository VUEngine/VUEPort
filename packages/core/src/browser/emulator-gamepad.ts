// reads pads through the Gamepad API and folds them into one VB key mask via each pad's profile (see
// emulator-gamepad-profiles.ts for why mapping is per device). Solo, every pad drives the same machine; in a link
// session each player gets the pads assigned in the Game Pads settings, or else by connection order

import {
    GamepadDatabase,
    GamepadProfile,
    GamepadReading,
    GamepadUiAction,
    gamepadDeviceKey,
    gamepadName,
    pressedGamepadSources,
    readGamepadContribution,
    resolveGamepadProfile,
} from '../common/emulator-gamepad-profiles';
import { EmulatorAction } from './emulator-types';

export { gamepadName };

// set when a host reads pads itself, like the desktop shell through SDL, as its webview's Gamepad API misses pads
// a browser sees
let gamepadSource: (() => (Gamepad | null)[]) | undefined;

// a source also has to fire `gamepadconnected`/`gamepaddisconnected` on `window`, like the browser does (see
// onGamepadsChanged)
export function setGamepadSource(source: (() => (Gamepad | null)[]) | undefined): void {
    gamepadSource = source;
}

function rawGamepads(): (Gamepad | null)[] {
    if (gamepadSource) {
        return gamepadSource();
    }
    // not every environment exposes the API, and Electron returns a sparse array with holes for disconnected slots
    return typeof navigator.getGamepads === 'function' ? [...navigator.getGamepads()] : [];
}

export function connectedGamepadList(): Gamepad[] {
    const pads = rawGamepads().filter((pad): pad is Gamepad => pad !== null);
    if (heldAtConnect.size > pads.length) {
        // a pad that went away and comes back is new again
        const present = new Set(pads.map(padKey));
        for (const key of heldAtConnect.keys()) {
            if (!present.has(key)) {
                heldAtConnect.delete(key);
            }
        }
    }
    return pads.map(withoutHeldAtConnect);
}

// button and axis indices each pad had held when it turned up, until released; keyed by padKey
const heldAtConnect = new Map<string, { buttons: Set<number>, axes: Set<number> }>();

function padKey(pad: Gamepad): string {
    return `${pad.index}:${pad.id}`;
}

// how close to the middle an axis has to come back before it counts again
const AXIS_SETTLED = 0.25;

// beyond a stick's range, which is a hat at rest, as emulator-gamepad-profiles.ts reads one
const AXIS_HAT_REST = 1.05;

function isButtonHeld(button: GamepadButton | undefined): boolean {
    return button !== undefined && (button.pressed || button.value > 0.5);
}

function isAxisSettled(value: number): boolean {
    return Math.abs(value) < AXIS_SETTLED || Math.abs(value) > AXIS_HAT_REST;
}

/**
 * A pad's first reading can't be trusted. Before its first report an axis reads whatever the system had, and on macOS
 * that is the bottom of its range: SDL took that as the value, so the 8BitDo 64's C-Up (an axis SDL turns into a
 * button) read held on connect and the game got R-Up. Firefox does the same with raw pads' axes, and a browser only
 * shows a pad once a button was pressed. So whatever reads held on first sight counts as released until it has been
 * (a button once up, an axis once near the middle or at a hat's rest). Done here, where every reader passes.
 */
function withoutHeldAtConnect(pad: Gamepad): Gamepad {
    const key = padKey(pad);
    let held = heldAtConnect.get(key);
    if (!held) {
        held = { buttons: new Set(), axes: new Set() };
        pad.buttons.forEach((button, index) => {
            if (isButtonHeld(button)) {
                held!.buttons.add(index);
            }
        });
        pad.axes.forEach((value, index) => {
            if (!isAxisSettled(value)) {
                held!.axes.add(index);
            }
        });
        heldAtConnect.set(key, held);
    }
    for (const index of held.buttons) {
        if (!isButtonHeld(pad.buttons[index])) {
            held.buttons.delete(index);
        }
    }
    for (const index of held.axes) {
        if (isAxisSettled(pad.axes[index] ?? 0)) {
            held.axes.delete(index);
        }
    }
    if (held.buttons.size === 0 && held.axes.size === 0) {
        return pad;
    }

    // a copy, as the pad's fields are read-only and a wrapper's getters fail on anything but a real Gamepad
    const released = { pressed: false, touched: false, value: 0 };
    const source = pad as unknown as Record<string, unknown>;
    return {
        id: pad.id,
        index: pad.index,
        mapping: pad.mapping,
        connected: pad.connected,
        timestamp: pad.timestamp,
        axes: pad.axes.map((value, index) => held!.axes.has(index) ? 0 : value),
        buttons: pad.buttons.map((button, index) => held!.buttons.has(index) ? released : button),
        vibrationActuator: source.vibrationActuator ?? null,
        hapticActuators: source.hapticActuators ?? [],
        // not part of the Gamepad API, only the desktop's pads have it (see GamepadDescriptor.engine)
        engine: source.engine,
    } as unknown as Gamepad;
}

export interface GamepadProfileResolver {
    profileFor(pad: Gamepad): GamepadProfile;
    // `player` is 1 or 2 for a linked session, undefined for a solo one, where every pad counts
    drivesPlayer(pad: Gamepad, player: number | undefined): boolean;
}

export interface GamepadFrame {
    keys: number;
    actions: Set<EmulatorAction>;
    uiActions: Set<GamepadUiAction>;
    turboKeys: number;
    macroSlots: Set<number>; // 1-based
}

const EMPTY_FRAME: GamepadFrame = {
    keys: 0, actions: new Set(), uiActions: new Set(), turboKeys: 0, macroSlots: new Set(),
};

// one pass for mask and actions, as this runs every animation frame
export function readGamepadFrame(
    resolver: GamepadProfileResolver,
    player?: number,
): GamepadFrame {
    const pads = connectedGamepadList().filter(pad => resolver.drivesPlayer(pad, player));
    if (pads.length === 0) {
        return EMPTY_FRAME;
    }

    let keys = 0;
    let turboKeys = 0;
    let actions: Set<EmulatorAction> | undefined;
    let uiActions: Set<GamepadUiAction> | undefined;
    let macroSlots: Set<number> | undefined;
    for (const pad of pads) {
        const contribution = readGamepadContribution(pad, resolver.profileFor(pad));
        keys |= contribution.keys;
        turboKeys |= contribution.turboKeys;
        if (contribution.macroSlots.size > 0) {
            macroSlots ??= new Set();
            for (const slot of contribution.macroSlots) {
                macroSlots.add(slot);
            }
        }
        if (contribution.actions.size > 0) {
            actions ??= new Set();
            for (const action of contribution.actions) {
                actions.add(action);
            }
        }
        if (contribution.uiActions.size > 0) {
            uiActions ??= new Set();
            for (const action of contribution.uiActions) {
                uiActions.add(action);
            }
        }
    }
    return {
        keys,
        actions: actions ?? EMPTY_FRAME.actions,
        uiActions: uiActions ?? EMPTY_FRAME.uiActions,
        turboKeys,
        macroSlots: macroSlots ?? EMPTY_FRAME.macroSlots,
    };
}

// source ids for the Game Pads settings, to record a mapping and light up mapped controls while held. `hats` (the
// axes that are hat switches) should be kept across calls, this fills it in (see pressedGamepadSources)
export function readPressedSources(pad: Gamepad, deadZone: number, hats?: Set<number>): Set<string> {
    return pressedGamepadSources(pad as GamepadReading, deadZone, hats);
}

// the Gamepad API hides a pad until a button is pressed (the device list is a fingerprint), so "nothing connected"
// really means "nothing has been used"
export function connectedGamepads(): string[] {
    return connectedGamepadList().map(pad => gamepadName(pad.id));
}

// events rather than polling, as profiles only need resolving again when the set of pads changes
export function onGamepadsChanged(listener: () => void): () => void {
    if (typeof window === 'undefined') {
        return () => undefined;
    }
    window.addEventListener('gamepadconnected', listener);
    window.addEventListener('gamepaddisconnected', listener);
    return () => {
        window.removeEventListener('gamepadconnected', listener);
        window.removeEventListener('gamepaddisconnected', listener);
    };
}

// shared by the emulator and the settings, so the settings show what the game will do. Profiles are per device key,
// so two pads of the same model share one
export class StoredGamepadProfiles implements GamepadProfileResolver {

    protected cache = new Map<string, GamepadProfile>();

    constructor(
        protected stored: () => GamepadProfile[],
        // which player a device drives, by device key; absent means either
        protected players: () => Record<string, number>,
        protected database?: () => GamepadDatabase | undefined,
    ) { }

    invalidate(): void {
        this.cache.clear();
    }

    profileFor(pad: Gamepad): GamepadProfile {
        const key = gamepadDeviceKey(pad.id);
        let profile = this.cache.get(key);
        if (!profile) {
            profile = resolveGamepadProfile(pad, this.stored(), this.database?.()).profile;
            this.cache.set(key, profile);
        }
        return profile;
    }

    drivesPlayer(pad: Gamepad, player: number | undefined): boolean {
        if (player === undefined) {
            return true;
        }
        const assigned = this.players()[gamepadDeviceKey(pad.id)];
        if (assigned !== undefined) {
            return assigned === player;
        }
        // unassigned pads go by Gamepad API order, compared by slot (`index`) rather than identity, as getGamepads
        // returns a fresh snapshot on every call
        const unassigned = connectedGamepadList()
            .filter(other => this.players()[gamepadDeviceKey(other.id)] === undefined);
        return unassigned.findIndex(other => other.index === pad.index) === player - 1;
    }
}
