import { VbKey } from '../common/vb-constants';
import { Disposable } from '../common/emulator-events';
import { VueportInputBindings } from '../common/emulator-settings';
import { Sim } from './core/vb-core';
import {
    EMULATOR_ACTION_COMMANDS,
    EMULATOR_ACTIONS,
    EMULATOR_GAMEPAD_BUTTONS,
    EMULATOR_GAMEPAD_INPUTS,
    EMULATOR_MACRO_SLOT_COMMANDS,
    EMULATOR_TURBO_BUTTONS,
    EmulatorGamePadButton,
    emulatorGamePadCommand,
    emulatorTurboCommand,
} from './emulator-commands';
import { EmulatorAction, EmulatorGamePadKeyCode } from './emulator-types';
import { GamepadProfileResolver, readGamepadFrame } from './emulator-gamepad';
import { GAMEPAD_KEY_TO_VB_KEY, vbKeyForButton } from '../common/emulator-gamepad-profiles';
import { DEFAULT_TURBO_RATE } from '../common/emulator-turbo';
import { notePhysicalInput } from './touch-presence';

export interface EmulatorInputBinding {
    keys: string[]; // as KeyboardEvent.code spells them
    // a pad code is held until released, an action runs once on the press
    command: EmulatorAction | EmulatorGamePadKeyCode;
}

interface TurboKeyBinding {
    keys: string[];
    vbKey: VbKey;
}

interface MacroSlotKeyBinding {
    keys: string[];
    // 1-based, as the Macros panel numbers them
    slot: number;
}

// moved to emulator-gamepad-profiles.ts so keyboard and pad can both reach it; re-exported, as every caller imports
// it from here
export { GAMEPAD_KEY_TO_VB_KEY };

/**
 * Whether a key is being typed into a field rather than played: keys are heard on the emulator's outermost node, so
 * typing a cheat name or a memory address would otherwise also drive the game. Buttons are left out on purpose: focus
 * lands on one whenever it is pressed, and a game deaf to the keyboard after using the toolbar would be the worse bug.
 */
function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    // select and input cover controls that take arrow keys too (range, number, dropdown), which would otherwise rewind
    // or fast forward while being adjusted. Dock parts with keys of their own (the VB Color sheet editor's tools) keep
    // them
    return target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
        || !!target.closest('[data-own-keys]');
}

function isPadButton(input: EmulatorInputBinding): boolean {
    return GAMEPAD_KEY_TO_VB_KEY[input.command as EmulatorGamePadKeyCode] !== undefined;
}

// in the order the on-screen controller reference reads them: left half top to bottom, then the right
export function emulatorHeldButtons(keys: number): EmulatorGamePadButton[] {
    return EMULATOR_GAMEPAD_BUTTONS.filter(button =>
        (keys & GAMEPAD_KEY_TO_VB_KEY[EMULATOR_GAMEPAD_INPUTS[button].key]) !== 0);
}

export interface EmulatorInputHost {
    readonly sim?: Sim;
    // where a freshly built mask goes when it should not be applied at once: a linked session books the press against
    // a frame so it lands on the same frame in both windows (link-session.ts)
    sendKeys?(keys: number): void;
    // the same for turbo buttons: a linked session works them into every frame it books. Absent, they go to the
    // machine, whose drive loop does that itself
    sendTurbo?(keys: number, rate: number): void;
    // in frames per half period, see the turboRate setting. Absent is the default rate
    readonly turboRate?: number;
    readonly isVisible: boolean;
    readonly lowPower: boolean;
    // false before the ROM has booted, and while a window takes typing (palette, settings), so typing there does not
    // also play the game behind it
    isAcceptingInput(): boolean;
    // whether the emulator may take the keyboard on its own (see takeFocus); undefined is yes. A host sharing the
    // window with other editors says no while one of those is being worked in, or their keys would go to the game
    mayTakeFocus?(): boolean;
    readonly rewinding: boolean;
    stopRewinding(): void;
    sendCommand(command: string, data?: unknown): void;
    canRunAction(action: EmulatorAction): boolean;
    runAction(action: EmulatorAction): void;
    usesPlayer2Controls(): boolean;
    // which player (1-based) this machine is, or undefined when it is the only one (a second pad is then a second
    // pair of hands on one game). A linked pair returns 1 and 2, and the resolver decides which pads that means
    gamepadPlayer?(): number | undefined;
    // absent leaves the pads unread; see StoredGamepadProfiles for the one the emulator and settings page use
    gamepadProfiles?(): GamepadProfileResolver | undefined;
    playMacroSlot?(slot: number): void;
}

// declared here rather than imported from the macro store, so neither module depends on the other
export interface EmulatorMacroHook {
    recordKeys(keys: number): void;
    tick(): void;
}

// every attached controller's node, and which of them last had the keyboard. Without this, takeFocus would steal the
// keyboard from a second emulator in the same document (the studio's linked pair): every click runs both controllers'
// document listeners, the one attached last wins, and the tab being played goes deaf
const attachedNodes = new Set<HTMLElement>();
let keyboardOwner: HTMLElement | undefined;

// owns the key masks, as keyboard and physical pad have to be combined before the core sees either
export class EmulatorInputController implements Disposable {

    protected pressedKeys = 0;
    protected gamepadKeys = 0;
    // pad buttons held while something else had the input, kept from the game until let go (see pollFrame)
    protected heldBackPadKeys = 0;
    protected macroKeys = 0;
    protected turboKeyboardKeys = 0;
    protected turboGamepadKeys = 0;
    // what the machine was last told about turbo, so unchanged frames cost nothing. -1 until something was sent
    protected appliedTurbo = { keys: -1, rate: -1 };
    protected heldGamepadMacroSlots = new Set<number>();
    protected xrKeys = 0;
    protected touchKeys = 0;
    // whether something else runs the input loop: during an immersive session the headset browser stops calling the
    // page's animation frames (see setExternalFrames)
    protected externalFrames = false;
    // actions whose pad control was held on the previous frame. A pad is polled, so actions have to be edged by hand;
    // held rather than counted, as rewind needs its release as well as its press
    protected heldGamepadActions = new Set<EmulatorAction>();
    // -1 to begin with, as 0 is a valid mask and the first report has to go out
    protected reportedPlayerKeys = -1;
    protected appliedKeys = -1;
    protected frameHandle?: number;
    protected wasAcceptingInput = false;

    protected _bindings: Record<string, EmulatorInputBinding> = {};
    protected turboBindings: TurboKeyBinding[] = [];
    protected macroSlotBindings: MacroSlotKeyBinding[] = [];

    protected macros: EmulatorMacroHook | undefined;

    protected node?: HTMLElement;
    protected screenNode?: HTMLElement;

    constructor(
        protected readonly host: EmulatorInputHost,
        protected readonly keymap: VueportInputBindings,
    ) { }

    get bindings(): Record<string, EmulatorInputBinding> {
        return this._bindings;
    }

    // keyboard and pad together; what a macro records, not what the core is given, which also carries a macro's own
    // buttons and the two signals that are not buttons
    get playerKeys(): number {
        return this.pressedKeys | this.gamepadKeys | this.xrKeys | this.touchKeys;
    }

    // its own mask like the headset's, as a finger lifting off one button must not let go of a key held on the
    // keyboard. Whatever the controller holds as a whole, so a press is never reported twice
    setTouchKeys(keys: number): void {
        if (keys === this.touchKeys) {
            return;
        }
        this.touchKeys = keys;
        this.applyKeys();
    }

    // its own mask, as the Gamepad API never lists a headset's controllers and the pad poll would clear them every
    // frame
    setXrKeys(keys: number): void {
        if (keys === this.xrKeys) {
            return;
        }
        this.xrKeys = keys;
        this.applyKeys();
    }

    // hands the input loop to a caller that runs pollFrame itself, or takes it back: during an immersive session the
    // headset browser stops the page's animation frames and runs the session's instead
    setExternalFrames(external: boolean): void {
        if (external === this.externalFrames) {
            return;
        }
        this.externalFrames = external;
        if (external) {
            this.stopInputLoop();
        } else {
            this.setXrKeys(0);
            if (this.node) {
                this.startInputLoop();
            }
        }
    }

    setMacroHook(macros: EmulatorMacroHook | undefined): void {
        this.macros = macros;
        if (!macros) {
            this.setMacroKeys(0);
        }
    }

    // kept apart from the player's own keys, so a macro cannot leave a button stuck down, and pressing something while
    // one plays adds to it instead of fighting it
    setMacroKeys(keys: number): void {
        if (keys === this.macroKeys) {
            return;
        }
        this.macroKeys = keys;
        this.applyKeys();
    }

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

        this.turboBindings = EMULATOR_TURBO_BUTTONS.map(button => ({
            keys: this.keymap.keyCodes(emulatorTurboCommand(button, player).id),
            vbKey: vbKeyForButton(button),
        })).filter(binding => binding.keys.length > 0);

        // player one's only, like the emulator's own keys: a macro plays into the machine of whoever pressed it
        this.macroSlotBindings = player === 1
            ? EMULATOR_MACRO_SLOT_COMMANDS.map((command, index) => ({
                keys: this.keymap.keyCodes(command.id),
                slot: index + 1,
            })).filter(binding => binding.keys.length > 0)
            : [];
    }

    attach(node: HTMLElement, screenNode: HTMLElement): void {
        this.node = node;
        this.screenNode = screenNode;
        node.tabIndex = 0;
        node.addEventListener('keydown', this.keyEventListener);
        node.addEventListener('keyup', this.keyEventListener);
        node.addEventListener('focusin', this.focusInListener);
        node.addEventListener('focusout', this.focusOutListener);
        screenNode.addEventListener('mousedown', this.focusListener);
        // on the document, as the point is clicks outside the emulator. Bubbling, so whatever was clicked has had its
        // say before the keyboard changes hands
        node.ownerDocument.addEventListener('click', this.clickListener);
        attachedNodes.add(node);
        this.startInputLoop();
    }

    // takes the keyboard back outright. Focus can leave the node by accident, e.g. pressing a button that then
    // disappears drops it onto the document. Called by anything about to rely on the keyboard being heard (the macro
    // store's startRecording)
    focus(): void {
        this.node?.focus();
    }

    detach(): void {
        this.node?.removeEventListener('keydown', this.keyEventListener);
        this.node?.removeEventListener('keyup', this.keyEventListener);
        this.node?.removeEventListener('focusin', this.focusInListener);
        this.node?.removeEventListener('focusout', this.focusOutListener);
        this.screenNode?.removeEventListener('mousedown', this.focusListener);
        this.node?.ownerDocument.removeEventListener('click', this.clickListener);
        if (this.node) {
            attachedNodes.delete(this.node);
            if (keyboardOwner === this.node) {
                keyboardOwner = undefined;
            }
        }
        this.stopInputLoop();
    }

    async setKey(vbKey: VbKey, down: boolean): Promise<void> {
        if (down) {
            this.pressedKeys |= vbKey;
        } else {
            this.pressedKeys &= ~vbKey;
        }
        await this.applyKeys();
    }

    // the on-screen controls send a press rather than a hold, so it is released after long enough for the ROM to notice
    async tapKey(vbKey: VbKey): Promise<void> {
        this.pressedKeys |= vbKey;
        await this.applyKeys();
        setTimeout(() => {
            this.pressedKeys &= ~vbKey;
            this.applyKeys();
        }, 50);
    }

    async applyKeys(): Promise<void> {
        // before the mask is built, so a macro being recorded sees the press when it happened rather than a frame later
        const player = this.playerKeys;
        if (player !== this.reportedPlayerKeys) {
            this.reportedPlayerKeys = player;
            this.macros?.recordKeys(player);
        }

        const keys = VbKey.SGN                            // marks a controller as present
            | (this.host.lowPower ? VbKey.PWR : 0)        // low battery signal
            | player
            | this.macroKeys;

        if (keys === this.appliedKeys) {
            return;
        }
        this.appliedKeys = keys;
        if (this.host.sendKeys) {
            this.host.sendKeys(keys);
            return;
        }
        await this.host.sim?.setKeys(keys);
    }

    // kept out of applyKeys' mask, as what turbo does to a button changes frame by frame, which only the drive loop
    // (or, linked, the session booking each frame) knows. Macros do not record turbo for the same reason
    async applyTurbo(): Promise<void> {
        const keys = this.turboKeyboardKeys | this.turboGamepadKeys;
        const rate = this.host.turboRate ?? DEFAULT_TURBO_RATE;
        if (keys === this.appliedTurbo.keys && rate === this.appliedTurbo.rate) {
            return;
        }
        this.appliedTurbo = { keys, rate };
        if (this.host.sendTurbo) {
            this.host.sendTurbo(keys, rate);
            return;
        }
        await this.host.sim?.setTurbo(keys, rate);
    }

    async setTurboKey(vbKey: VbKey, down: boolean): Promise<void> {
        if (down) {
            this.turboKeyboardKeys |= vbKey;
        } else {
            this.turboKeyboardKeys &= ~vbKey;
        }
        await this.applyTurbo();
    }

    invalidate(): void {
        this.appliedKeys = -1;
        this.appliedTurbo = { keys: -1, rate: -1 };
    }

    protected keyEventListener = (e: KeyboardEvent) => this.processKeyEvent(e);

    // reclaims keyboard focus for the widget that owns the keydown listener. The screen is a plain canvas inside the
    // dock, so clicking around in the dock moves focus away; scoped to the screen so it does not fight typing into e.g.
    // the Memory panel
    protected focusListener = () => this.node?.focus();

    protected focusInListener = () => {
        if (this.node) {
            keyboardOwner = this.node;
        }
    };

    // focus leaving the emulator swallows the release, which would leave rewind stuck on. Moves within it must not end
    // it, since the toolbar button lives there too
    protected focusOutListener = (e: FocusEvent) => {
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !this.node?.contains(next)) {
            this.host.stopRewinding();
        }
    };

    protected processKeyEvent(e: KeyboardEvent): void {
        // releasing rewind always ends it, before the guards below: pausing or opening the controls overlay while it is
        // held changes what they let through, and a filtered release would leave the emulator suspended for good
        if (
            e.type === 'keyup' &&
            this.host.rewinding &&
            this.matchKey(this._bindings[EmulatorAction.Rewind]?.keys ?? [], e.code)
        ) {
            this.host.stopRewinding();
        }
        // a turbo key's release always lets go too, or a button keeps firing behind a pause, and so does a game pad
        // button's: released while something else had the keys (the rewind filmstrip, a dialog), it would stay held and
        // walk the character on by itself once play resumed
        if (e.type === 'keyup') {
            for (const binding of this.turboBindings) {
                if (this.matchKey(binding.keys, e.code) && (this.turboKeyboardKeys & binding.vbKey)) {
                    this.setTurboKey(binding.vbKey, false);
                }
            }
            for (const input of Object.values(this._bindings)) {
                const vbKey = GAMEPAD_KEY_TO_VB_KEY[input.command as EmulatorGamePadKeyCode];
                if (vbKey !== undefined && this.matchKey(input.keys, e.code) && (this.pressedKeys & vbKey)) {
                    this.pressedKeys &= ~vbKey;
                    this.applyKeys();
                }
            }
        }

        if (
            e.repeat || // ... on repeated event firing
            !this.host.isVisible || // ... if emulator is not visible
            !this.host.isAcceptingInput() || // ... if it is not ready to take it
            isTypingTarget(e.target) // ... or the key is being typed into something
        ) {
            return;
        }

        // a key that plays a game pad button plays only that. Shipped shortcuts sit on keys a layout may want for the
        // pad (arrows, WASD presets), and a direction that also paused or rewound would make the pad unplayable; the
        // shortcut has a toolbar button to fall back on
        const playsPad = Object.values(this._bindings).some(input =>
            isPadButton(input) && this.matchKey(input.keys, e.code))
            || this.turboBindings.some(binding => this.matchKey(binding.keys, e.code));

        for (const binding of this.turboBindings) {
            if (this.matchKey(binding.keys, e.code)) {
                this.setTurboKey(binding.vbKey, e.type === 'keydown');
            }
        }
        if (e.type === 'keydown' && !playsPad) {
            for (const binding of this.macroSlotBindings) {
                if (this.matchKey(binding.keys, e.code)) {
                    this.host.playMacroSlot?.(binding.slot);
                }
            }
        }

        // a key that plays the game puts the on-screen controller away, see touch-presence.ts
        if (e.type === 'keydown' && playsPad) {
            notePhysicalInput();
        }

        for (const key in this._bindings) {
            if (!this._bindings.hasOwnProperty(key)) {
                continue;
            }
            const input = this._bindings[key];
            if (!this.matchKey(input.keys, e.code) || (playsPad && !isPadButton(input))) {
                continue;
            }
            if (isPadButton(input) || input.command === EmulatorAction.Rewind) {
                this.host.sendCommand(e.type, input.command);
            } else if (e.type === 'keydown' && this.host.canRunAction(input.command as EmulatorAction)) {
                this.host.runAction(input.command as EmulatorAction);
            }
        }
    }

    protected matchKey(keyCodes: string[], keyCode: string): boolean {
        return keyCodes.includes(keyCode);
    }

    // runs the actions a pad has just started holding, and ends rewind, which is held rather than tapped. Same guards
    // as processKeyEvent: a release always ends rewind first, or a filtered release would leave the emulator suspended.
    // isTypingTarget does not apply, as nobody types with a pad
    protected dispatchGamepadActions(held: Set<EmulatorAction>): void {
        if (this.heldGamepadActions.has(EmulatorAction.Rewind)
            && !held.has(EmulatorAction.Rewind)
            && this.host.rewinding) {
            this.host.stopRewinding();
        }

        if (!this.host.isVisible || !this.host.isAcceptingInput()) {
            // nothing is dispatched, but the held set has to keep up: a button remembered as held across a pause would
            // swallow its next press, a forgotten one would fire the moment play resumed with it down
            this.heldGamepadActions = held;
            return;
        }

        for (const action of held) {
            if (this.heldGamepadActions.has(action)) {
                continue;
            }
            if (action === EmulatorAction.Rewind) {
                this.host.sendCommand('keydown', action);
            } else if (this.host.canRunAction(action)) {
                this.host.runAction(action);
            }
        }

        this.heldGamepadActions = held;
    }

    // edged by hand like the actions, so holding the button does not start and stop the macro sixty times a second
    protected dispatchGamepadMacroSlots(held: Set<number>): void {
        if (this.host.isVisible && this.host.isAcceptingInput()) {
            for (const slot of held) {
                if (!this.heldGamepadMacroSlots.has(slot)) {
                    this.host.playMacroSlot?.(slot);
                }
            }
        }
        this.heldGamepadMacroSlots = held;
    }

    // takes the keyboard back whenever nothing has a better claim on it. Called per frame for two cases: focus has
    // fallen to nowhere (e.g. the start page's button is gone once the game runs), or a window taking the keyboard just
    // closed. Clicks are handled in clickListener
    protected keepFocus(): void {
        const accepting = this.host.isVisible && this.host.isAcceptingInput();
        // true on the one frame a modal window (settings, game info, a picker) stops holding the keyboard. An edge, so
        // the game gets the keyboard once rather than holding onto it against everything else
        const released = accepting && !this.wasAcceptingInput;
        this.wasAcceptingInput = accepting;
        if (released || this.focusIsNowhere()) {
            this.takeFocus();
        }
    }

    protected focusIsNowhere(): boolean {
        const owner = this.node?.ownerDocument;
        if (!owner) {
            return false;
        }
        const active = owner.activeElement;
        // removing the element that had focus leaves it on one of these two, depending on the browser
        return !active || active === owner.body || active === owner.documentElement;
    }

    // gives the keyboard to the game unless something has a better claim on it: a window taking input, a field being
    // typed into, a window nobody looks at (so player two's window does not grab focus), or the host's mayTakeFocus
    protected takeFocus(): void {
        const node = this.node;
        if (!node || !this.host.isVisible || !this.host.isAcceptingInput()
            || this.host.mayTakeFocus?.() === false) {
            return;
        }
        const owner = node.ownerDocument;
        if (!owner.hasFocus()) {
            return;
        }
        const active = owner.activeElement;
        if (active && (node.contains(active) || isTypingTarget(active))) {
            return;
        }
        // not out of another emulator's hands: two in one document (the studio's linked pair) both hear every click,
        // and reclaiming would go to whichever attached last. The last owner keeps it until it goes away or the other
        // one is focused
        if (keyboardOwner && keyboardOwner !== node
            && attachedNodes.has(keyboardOwner) && keyboardOwner.isConnected) {
            return;
        }
        node.focus({ preventScroll: true });
    }

    // a click anywhere hands the keyboard back to the game, with the same guards as the screen's mousedown handler,
    // or a pressed chrome button (fullscreen, panel tab) would keep focus. `detail` tells a mouse click from Space or
    // Enter on a focused button, which also clicks; the interface has to stay usable from the keyboard
    protected clickListener = (e: MouseEvent) => {
        if (e.detail > 0) {
            this.takeFocus();
        }
    };

    protected startInputLoop(): void {
        if (this.frameHandle !== undefined || this.externalFrames) {
            return;
        }
        const frame = () => {
            this.frameHandle = requestAnimationFrame(frame);
            this.pollFrame();
        };
        this.frameHandle = requestAnimationFrame(frame);
    }

    pollFrame(): void {
        this.keepFocus();
        const resolver = this.host.gamepadProfiles?.();
        if (resolver) {
            // solo, every pad feeds this machine (a second one is a second pair of hands); linked, each side reads only
            // the pads the resolver assigns to the host's player number
            const pad = readGamepadFrame(resolver, this.host.gamepadPlayer?.());
            // a window taking the input takes the pad too (the command palette is steered with d-pad and A). Whatever
            // was held when it closes stays held back until let go, or the A that chose a command would reach the game
            // as a press
            let keys = pad.keys;
            let turboKeys = pad.turboKeys;
            if (!this.host.isAcceptingInput()) {
                this.heldBackPadKeys = keys;
                keys = 0;
                turboKeys = 0;
            } else {
                this.heldBackPadKeys &= keys;
                keys &= ~this.heldBackPadKeys;
            }
            if (keys !== this.gamepadKeys) {
                if (keys & ~this.gamepadKeys) {
                    notePhysicalInput();
                }
                this.gamepadKeys = keys;
                this.applyKeys();
            }
            if (turboKeys !== this.turboGamepadKeys) {
                this.turboGamepadKeys = turboKeys;
                this.applyTurbo();
            }
            this.dispatchGamepadActions(pad.actions);
            this.dispatchGamepadMacroSlots(pad.macroSlots);
        }
        this.macros?.tick();
    }

    protected stopInputLoop(): void {
        if (this.frameHandle !== undefined) {
            cancelAnimationFrame(this.frameHandle);
            this.frameHandle = undefined;
        }
    }

    dispose(): void {
        this.detach();
    }
}
