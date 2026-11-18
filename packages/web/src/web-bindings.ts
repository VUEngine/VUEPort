import {
    emulatorGamePadCommand,
    EMULATOR_ACTION_COMMANDS,
    EMULATOR_GAMEPAD_INPUTS,
    EmulatorGamePadButton,
} from 'vueport-core/lib/browser/emulator-commands';
import type * as React from 'react';
import { EmulatorAction } from 'vueport-core/lib/browser/emulator-types';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { VueportBindableCommand, VueportInputBindings } from 'vueport-core/lib/common/emulator-settings';
import { WebUi } from './web-ui';

const STORAGE_KEY = 'vueport.bindings';

// the layout VUEngine Studio ships: left d-pad on ESDF, right one on IJKL, face buttons under the right hand. Codes,
// not characters, so it is the same physical key on every layout. Typed against the button table, so a new button
// will not compile until it is given a key
const BUTTON_KEYS: Record<EmulatorGamePadButton, string> = {
    lUp: 'KeyE',
    lLeft: 'KeyS',
    lDown: 'KeyD',
    lRight: 'KeyF',
    lTrigger: 'KeyG',
    rUp: 'KeyI',
    rLeft: 'KeyJ',
    rDown: 'KeyK',
    rRight: 'KeyL',
    rTrigger: 'KeyH',
    select: 'KeyV',
    start: 'KeyB',
    b: 'KeyN',
    a: 'KeyM',
};

// player 2, for a linked pair sharing one keyboard: arrows for the left d-pad, numpad for the right one and shoulders,
// `,` `.` `/` `'` for the face buttons. Off by default ("Player 2 uses Player 1 controls" is on), remappable in Input
const BUTTON_KEYS_P2: Record<EmulatorGamePadButton, string> = {
    lUp: 'ArrowUp',
    lLeft: 'ArrowLeft',
    lDown: 'ArrowDown',
    lRight: 'ArrowRight',
    lTrigger: 'Numpad7',
    rUp: 'Numpad8',
    rLeft: 'Numpad4',
    rDown: 'Numpad5',
    rRight: 'Numpad6',
    rTrigger: 'Numpad9',
    select: 'Slash',
    start: 'Quote',
    b: 'Comma',
    a: 'Period',
};

// the emulator's own actions. Typed against the action table, as a missing one fails silently (only the keyboard goes
// quiet). The studio's modifiers (alt+1 for a save state) are not repeated: the input controller compares
// KeyboardEvent.code alone, see keyCodes
const ACTION_KEYS: Record<EmulatorAction, string> = {
    [EmulatorAction.PauseToggle]: 'Space',
    [EmulatorAction.Reset]: 'F10',
    [EmulatorAction.AudioMute]: 'KeyQ',
    [EmulatorAction.ToggleLowPower]: 'KeyW',
    [EmulatorAction.ToggleFastForward]: 'ArrowRight',
    [EmulatorAction.ToggleSlowmotion]: 'ArrowDown',
    [EmulatorAction.FrameAdvance]: 'ArrowUp',
    [EmulatorAction.Rewind]: 'ArrowLeft',
    [EmulatorAction.SaveState]: 'Digit1',
    [EmulatorAction.LoadState]: 'Digit2',
    [EmulatorAction.Fullscreen]: 'KeyO',
    [EmulatorAction.ToggleControlsOverlay]: 'KeyP',
    [EmulatorAction.Screenshot]: 'F9',
    [EmulatorAction.VideoRecord]: 'F8',
};

function defaultBindings(): Record<string, string[]> {
    const bindings: Record<string, string[]> = {};
    for (const [button, code] of Object.entries(BUTTON_KEYS)) {
        bindings[EMULATOR_GAMEPAD_INPUTS[button as EmulatorGamePadButton].command.id] = [code];
    }
    for (const [button, code] of Object.entries(BUTTON_KEYS_P2)) {
        bindings[emulatorGamePadCommand(button as EmulatorGamePadButton, 2).id] = [code];
    }
    for (const [action, code] of Object.entries(ACTION_KEYS)) {
        bindings[EMULATOR_ACTION_COMMANDS[action as EmulatorAction].id] = [code];
    }
    return bindings;
}

// Mac key symbols (⇧⌘P rather than Ctrl+Shift+P), as `metaKey` is the key app.tsx's handler accepts there.
// navigator.platform is deprecated with nothing standard as widely supported to replace it
// eslint-disable-next-line deprecation/deprecation
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

// the two shortcuts app.tsx reads itself, spelled per platform. Here rather than beside that handler, as several
// places show them. Not in ACTION_KEYS, as the input controller ignores modifiers and `KeyO` is already Fullscreen's
export const APP_SHORTCUTS = {
    palette: IS_MAC ? 'F1 · ⇧⌘P' : 'F1 · Ctrl+Shift+P',
    openRom: IS_MAC ? '⌘O' : 'Ctrl+O',
};

// `KeyM` -> `M`, `Digit1` -> `1`, `ArrowUp` -> `Up`
function readable(code: string): string {
    if (code.startsWith('Key')) {
        return code.slice(3);
    }
    if (code.startsWith('Digit')) {
        return code.slice(5);
    }
    if (code.startsWith('Arrow')) {
        return code.slice(5);
    }
    if (code.startsWith('Numpad')) {
        return `Numpad ${code.slice(6)}`;
    }
    return code;
}

// the web app's own keymap, kept in localStorage in a browser and mirrored to config.json on the desktop. Unlike the
// studio's, which views an application-wide keymap, this one owns its bindings outright
export class WebBindings implements VueportInputBindings {

    protected bindings: Record<string, string[]>;

    constructor(protected readonly ui: WebUi) {
        this.bindings = { ...defaultBindings(), ...this.load() };
    }

    protected load(): Record<string, string[]> {
        try {
            const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
            if (typeof stored !== 'object' || stored === null) {
                return {};
            }
            const result: Record<string, string[]> = {};
            for (const [id, codes] of Object.entries(stored as Record<string, unknown>)) {
                if (Array.isArray(codes) && codes.every(c => typeof c === 'string')) {
                    result[id] = codes as string[];
                }
            }
            return result;
        } catch {
            return {};
        }
    }

    protected save(): void {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
        } catch {
            // private browsing or a full quota: the binding still applies to this session, it just is not remembered
        }
    }

    label(commandId: string, compact: boolean): string {
        const codes = this.keyCodes(commandId);
        if (codes.length === 0) {
            return '';
        }
        const label = codes.map(readable).join(' or ');
        return compact ? ` (${label})` : label;
    }

    keyCodes(commandId: string): string[] {
        return this.bindings[commandId] ?? [];
    }

    // adds to what the command already answers to rather than replacing it, as the studio does
    async capture(
        command: VueportBindableCommand,
        _when?: string,
        title?: React.ReactNode,
    ): Promise<boolean> {
        const name = command.category ? `${command.category}: ${command.label}` : (command.label ?? command.id);
        // either button changes the mapping without closing the prompt, so even a dismissed prompt may have changed
        // something
        let changed = false;
        const code = await this.ui.captureKey({
            title: title ?? name,
            currentMappings: () => this.label(command.id, false),
            clearAll: () => {
                this.clear(command.id);
                changed = true;
            },
            resetToDefault: () => {
                this.resetToDefault(command.id);
                changed = true;
            },
        });
        if (!code) {
            return changed;
        }
        const existing = this.keyCodes(command.id);
        if (existing.includes(code)) {
            return changed;
        }
        this.bindings = { ...this.bindings, [command.id]: [...existing, code] };
        this.save();
        return true;
    }

    // one key each, written in one go, or nothing if Escape is pressed before the end. Replaces rather than adds
    // (unlike capture), as a run through every button is a fresh layout
    async captureAll(
        commands: VueportBindableCommand[],
        _when: string | undefined,
        title: (command: VueportBindableCommand, step: number, total: number) => React.ReactNode,
        onStep?: (index: number) => void,
    ): Promise<boolean> {
        const collected: Record<string, string[]> = {};
        for (let i = 0; i < commands.length; i++) {
            const command = commands[i];
            onStep?.(i);
            const code = await this.ui.captureKey({
                title: title(command, i + 1, commands.length),
                currentMappings: () => this.label(command.id, false),
                note: nls.localize(
                    'vueport/input/captureAllNote',
                    'Nothing is saved until every button is set.'
                ),
            });
            if (!code) {
                return false;
            }
            collected[command.id] = [code];
        }
        this.bindings = { ...this.bindings, ...collected };
        this.save();
        return true;
    }

    // adds a key the caller already has, without a prompt; the input settings read their own key presses
    bind(commandId: string, code: string): boolean {
        const existing = this.keyCodes(commandId);
        if (existing.includes(code)) {
            return false;
        }
        this.bindings = { ...this.bindings, [commandId]: [...existing, code] };
        this.save();
        return true;
    }

    unbind(commandId: string, code: string): void {
        this.bindings = { ...this.bindings, [commandId]: this.keyCodes(commandId).filter(existing => existing !== code) };
        this.save();
    }

    keyLabel(code: string): string {
        return readable(code);
    }

    clear(commandId: string): void {
        this.bindings = { ...this.bindings, [commandId]: [] };
        this.save();
    }

    // a command with no shipped key (none today, but the tables are exhaustive by type, not by rule) comes back
    // unmapped
    resetToDefault(commandId: string): void {
        const shipped = defaultBindings()[commandId] ?? [];
        this.bindings = { ...this.bindings, [commandId]: [...shipped] };
        this.save();
    }

    resetToDefaults(): void {
        this.bindings = defaultBindings();
        this.save();
    }

    // each command set to exactly the key given, in one write: what a "set every button" run collects, and what a
    // preset applies
    replaceAll(codes: Record<string, string>): void {
        const next = { ...this.bindings };
        for (const [commandId, code] of Object.entries(codes)) {
            next[commandId] = [code];
        }
        this.bindings = next;
        this.save();
    }
}
