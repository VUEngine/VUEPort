import { VbKey } from '../common/vb-constants';
import { Disposable } from '../common/emulator-events';
import { VueportInputBindings } from '../common/emulator-settings';
import { VesVbSim } from './core/vb-core';
import {
    EMULATOR_ACTION_COMMANDS,
    EMULATOR_ACTIONS,
    EMULATOR_GAMEPAD_BUTTONS,
    EMULATOR_GAMEPAD_INPUTS,
    emulatorGamePadCommand,
} from './emulator-commands';
import { EmulatorAction, EmulatorGamePadKeyCode } from './emulator-types';
import { readGamepadKeys } from './emulator-gamepad';

/**
 * One mapping: the keys currently bound to it, and what pressing them does.
 *
 * A game pad button is held, so it carries the pad code the core wants; an
 * action is run once, so it carries the action. Which of the two it is decides
 * how the key handler treats press and release.
 */
export interface EmulatorInputBinding {
    /** The key codes that trigger it, as `KeyboardEvent.code` spells them. */
    keys: string[];
    command: EmulatorAction | EmulatorGamePadKeyCode;
}

/** The game pad codes the mappings speak, as the mask bits the core wants. */
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

/**
 * What the input controller needs from the emulator it drives.
 *
 * The controller decides *that* a button was pressed; the host decides what
 * that means. Keeping the split here is what lets the key handling move to
 * vueport without the emulator's action dispatch coming with it.
 */
export interface EmulatorInputHost {
    /** The simulation to push key masks into, once there is one. */
    readonly sim?: VesVbSim;
    /** Whether the emulator is on screen at all. */
    readonly isVisible: boolean;
    /** The low battery signal, which is folded into every mask. */
    readonly lowPower: boolean;
    /**
     * False before the ROM has booted, and while a window is taking typing —
     * the palette or settings window — so that typing in one does not also
     * play the game behind it.
     */
    isAcceptingInput(): boolean;
    /** True from the moment rewind is pressed until it is released. */
    readonly rewinding: boolean;
    stopRewinding(): void;
    /** Perform a held input: a game pad button, or rewind. */
    sendCommand(command: string, data?: unknown): void;
    canRunAction(action: EmulatorAction): boolean;
    runAction(action: EmulatorAction): void;
    /** Whether to read player 2's mappings rather than player 1's. */
    usesPlayer2Controls(): boolean;
}

/**
 * Keyboard and game pad input for one emulator.
 *
 * Owns the key masks, because they have exactly one correct value at a time and
 * two sources — the keyboard and a physical pad — that have to be combined
 * before the core sees either. The host asks for presses through `setKey` and
 * `tapKey` rather than touching the masks, so there is one place that knows
 * what the core is currently being told.
 */
export class EmulatorInputController implements Disposable {

    /** Currently held keyboard buttons, as a VbKey mask. */
    protected pressedKeys = 0;
    /** Currently held physical controller buttons, as a VbKey mask. */
    protected gamepadKeys = 0;
    /** Last mask handed to the core, so unchanged frames cost nothing. */
    protected appliedKeys = -1;
    protected gamepadPollHandle?: number;

    /** Every mapping, keyed by the button or action it drives. */
    protected _bindings: Record<string, EmulatorInputBinding> = {};

    protected node?: HTMLElement;
    protected screenNode?: HTMLElement;

    constructor(
        protected readonly host: EmulatorInputHost,
        protected readonly keymap: VueportInputBindings,
    ) { }

    get bindings(): Record<string, EmulatorInputBinding> {
        return this._bindings;
    }

    /**
     * Re-read every mapping out of the keybinding registry.
     *
     * Built from the two tables that already say what exists — the game pad's
     * buttons and the emulator's actions — rather than listed again here, so a
     * new action needs adding in one place and gets its mapping for free.
     */
    refreshBindings(): void {
        const player = this.host.usesPlayer2Controls() ? 2 : 1;
        const input: Record<string, EmulatorInputBinding> = {};

        for (const button of EMULATOR_GAMEPAD_BUTTONS) {
            input[button] = {
                keys: this.keymap.keyCodes(
                    emulatorGamePadCommand(button, player).id
                ),
                command: EMULATOR_GAMEPAD_INPUTS[button].key,
            };
        }

        for (const action of EMULATOR_ACTIONS) {
            input[action] = {
                keys: this.keymap.keyCodes(
                    EMULATOR_ACTION_COMMANDS[action].id
                ),
                command: action,
            };
        }

        this._bindings = input;
    }

    /** Listen on the emulator's node, and on its screen for focus. */
    attach(node: HTMLElement, screenNode: HTMLElement): void {
        this.node = node;
        this.screenNode = screenNode;
        node.tabIndex = 0;
        node.addEventListener('keydown', this.keyEventListener);
        node.addEventListener('keyup', this.keyEventListener);
        node.addEventListener('focusout', this.focusOutListener);
        screenNode.addEventListener('mousedown', this.focusListener);
        this.startGamepadPolling();
    }

    detach(): void {
        this.node?.removeEventListener('keydown', this.keyEventListener);
        this.node?.removeEventListener('keyup', this.keyEventListener);
        this.node?.removeEventListener('focusout', this.focusOutListener);
        this.screenNode?.removeEventListener('mousedown', this.focusListener);
        this.stopGamepadPolling();
    }

    /** Hold or release one game pad button. */
    async setKey(vbKey: VbKey, down: boolean): Promise<void> {
        if (down) {
            this.pressedKeys |= vbKey;
        } else {
            this.pressedKeys &= ~vbKey;
        }
        await this.applyKeys();
    }

    /**
     * Press and release one button.
     *
     * The on-screen controls send a press rather than a hold, so it is released
     * again after long enough for the ROM to notice.
     */
    async tapKey(vbKey: VbKey): Promise<void> {
        this.pressedKeys |= vbKey;
        await this.applyKeys();
        setTimeout(() => {
            this.pressedKeys &= ~vbKey;
            this.applyKeys();
        }, 50);
    }

    /** Push the combined mask into the core, if it has changed. */
    async applyKeys(): Promise<void> {
        const keys = VbKey.SGN                            // marks a controller as present
            | (this.host.lowPower ? VbKey.PWR : 0)        // low battery signal
            | this.pressedKeys
            | this.gamepadKeys;

        // The gamepad is polled every frame, and most frames change nothing.
        if (keys === this.appliedKeys) {
            return;
        }
        this.appliedKeys = keys;
        await this.host.sim?.setKeys(keys);
    }

    /** Forget what the core was last told, so the next apply re-sends it. */
    invalidate(): void {
        this.appliedKeys = -1;
    }

    protected keyEventListener = (e: KeyboardEvent) => this.processKeyEvent(e);

    /**
     * Reclaim keyboard focus for the widget that owns the keydown listener.
     *
     * The screen used to be an iframe, which is its own focus scope, so
     * clicking into it and then pressing a key just worked. It is a plain
     * canvas now, nested inside the debug dock's own Lumino DockPanel — clicking
     * around inside that dock (switching tabs, focusing another panel's input)
     * moves DOM focus without ever involving the emulator, so the keydown
     * listener on its node stops receiving anything. Scoped to the screen
     * rather than the whole widget, so it does not fight over focus with, say,
     * typing an address into the Memory panel.
     */
    protected focusListener = () => this.node?.focus();

    /**
     * Focus leaving the emulator swallows the release, which would leave rewind
     * stuck on. Moves within it are fine and must not end it, since the toolbar
     * button lives there too.
     */
    protected focusOutListener = (e: FocusEvent) => {
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !this.node?.contains(next)) {
            this.host.stopRewinding();
        }
    };

    protected processKeyEvent(e: KeyboardEvent): void {
        // Releasing rewind always ends it, before any of the guards below, since a
        // release that got filtered out would leave the emulator suspended with no
        // way back: pausing, or opening the controls overlay, while the key is held
        // is enough to change what those guards allow through.
        if (
            e.type === 'keyup' &&
            this.host.rewinding &&
            this.matchKey(this._bindings[EmulatorAction.Rewind]?.keys ?? [], e.code)
        ) {
            this.host.stopRewinding();
        }

        // do not process key input...
        if (
            e.repeat || // ... on repeated event firing
            !this.host.isVisible || // ... if emulator is not visible
            !this.host.isAcceptingInput() // ... or it is not ready to take it
        ) {
            return;
        }

        for (const key in this._bindings) {
            if (!this._bindings.hasOwnProperty(key)) {
                continue;
            }
            const input = this._bindings[key];
            if (!this.matchKey(input.keys, e.code)) {
                continue;
            }
            // A game pad button is held, so it needs the press and the release;
            // rewind is held too, and its release is what ends it. Everything else
            // is an action, and acts once, through its command.
            if (GAMEPAD_KEY_TO_VB_KEY[input.command as EmulatorGamePadKeyCode] !== undefined
                || input.command === EmulatorAction.Rewind) {
                this.host.sendCommand(e.type, input.command);
            } else if (e.type === 'keydown' && this.host.canRunAction(input.command as EmulatorAction)) {
                this.host.runAction(input.command as EmulatorAction);
            }
        }
    }

    protected matchKey(keyCodes: string[], keyCode: string): boolean {
        return keyCodes.includes(keyCode);
    }

    protected startGamepadPolling(): void {
        if (this.gamepadPollHandle !== undefined) {
            return;
        }
        const poll = () => {
            this.gamepadPollHandle = requestAnimationFrame(poll);
            const keys = readGamepadKeys();
            if (keys !== this.gamepadKeys) {
                this.gamepadKeys = keys;
                this.applyKeys();
            }
        };
        this.gamepadPollHandle = requestAnimationFrame(poll);
    }

    protected stopGamepadPolling(): void {
        if (this.gamepadPollHandle !== undefined) {
            cancelAnimationFrame(this.gamepadPollHandle);
            this.gamepadPollHandle = undefined;
        }
    }

    dispose(): void {
        this.detach();
    }
}
