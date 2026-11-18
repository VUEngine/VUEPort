/**
 * The game pad as a way round the interface: d-pad and stick move, one face button chooses, the other backs out, Start
 * starts, the shoulders turn pages, Home opens the command palette. It runs its own loop, as the library and palette
 * exist without a game, and the emulator stops taking input while the palette is open.
 *
 * A button counts on the frame it goes down, so one already held when a list opens (Home, or the A that chose the
 * command) does nothing until pressed again; directions repeat while held, as keys do. Everything goes through the
 * pad's profile, so a raw pad steers with what it plays with (left cross moves, VB triggers turn pages, Start starts,
 * `commandPalette` is Home), except choosing and backing out, see intentOf.
 *
 * In core rather than a host, as the rewind filmstrip is steered with it in every host (EmulatorRewindBrowser#steer);
 * the web app routes it on to its library, palette and windows (web-gamepad-ui.ts).
 */
import {
    GamepadProfileResolver,
    connectedGamepadList,
    onGamepadsChanged,
} from './emulator-gamepad';
import { GamepadProfile, readGamepadContribution } from '../common/emulator-gamepad-profiles';
import { VbKey } from '../common/vb-constants';

export type PadDirection = 'up' | 'down' | 'left' | 'right';

export type PadCommand =
    | 'palette' | 'confirm' | 'cancel' | 'start' | 'previous' | 'next'
    | PadDirection;

const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 70;

const BUTTONS = ['palette', 'confirm', 'cancel', 'start', 'previous', 'next'] as const;
const DIRECTIONS: readonly PadDirection[] = ['up', 'down', 'left', 'right'];

type PadIntent = Record<(typeof BUTTONS)[number] | PadDirection, boolean>;

const NOTHING: PadIntent = {
    palette: false, confirm: false, cancel: false, start: false, previous: false, next: false,
    up: false, down: false, left: false, right: false,
};

function intentOf(pad: Gamepad, profile: GamepadProfile): PadIntent {
    const { keys, uiActions } = readGamepadContribution(pad, profile);
    const pressed = (index: number): boolean => {
        const button = pad.buttons[index];
        return button !== undefined && (button.pressed || button.value > 0.5);
    };
    let confirm = (keys & VbKey.A) !== 0;
    let cancel = (keys & VbKey.B) !== 0;
    // a standard-mapped pad follows the console's habit: the bottom button confirms on Xbox and PlayStation, the
    // right one on Nintendo (VB A would be the button printed "B" on an Xbox pad)
    if (pad.mapping === 'standard') {
        const nintendo = profile.family === 'nintendo';
        confirm = pressed(nintendo ? 1 : 0);
        cancel = pressed(nintendo ? 0 : 1);
    }
    return {
        palette: uiActions.has('commandPalette'),
        confirm,
        cancel,
        start: (keys & VbKey.STA) !== 0,
        previous: (keys & VbKey.LT) !== 0,
        next: (keys & VbKey.RT) !== 0,
        up: (keys & VbKey.LU) !== 0,
        down: (keys & VbKey.LD) !== 0,
        left: (keys & VbKey.LL) !== 0,
        right: (keys & VbKey.LR) !== 0,
    };
}

// merges the presses of all pads and returns a stop function. Only polls while a pad is connected, so pages without
// a controller spend no callback per frame
export function listenToGamepadUi(
    resolver: () => GamepadProfileResolver,
    onCommand: (command: PadCommand) => void,
): () => void {
    let handle: number | undefined;
    let previous = NOTHING;
    let repeating: { direction: PadDirection, at: number } | undefined;

    const frame = (now: number): void => {
        handle = requestAnimationFrame(frame);
        const profiles = resolver();
        const intent = { ...NOTHING };
        for (const pad of connectedGamepadList()) {
            const one = intentOf(pad, profiles.profileFor(pad));
            for (const key of Object.keys(intent) as (keyof PadIntent)[]) {
                intent[key] ||= one[key];
            }
        }
        const was = previous;
        previous = intent;

        for (const button of BUTTONS) {
            if (intent[button] && !was[button]) {
                onCommand(button);
            }
        }
        // one direction at a time; two at once is a stick diagonal, which no list here can handle
        const held = DIRECTIONS.filter(candidate => intent[candidate]);
        const direction = held.length === 1 ? held[0] : undefined;
        if (!direction) {
            repeating = undefined;
        } else if (repeating?.direction !== direction) {
            repeating = { direction, at: now + REPEAT_DELAY_MS };
            onCommand(direction);
        } else if (now >= repeating.at) {
            repeating.at = now + REPEAT_EVERY_MS;
            onCommand(direction);
        }
    };

    const update = (): void => {
        const any = connectedGamepadList().length > 0;
        if (any && handle === undefined) {
            handle = requestAnimationFrame(frame);
        } else if (!any && handle !== undefined) {
            cancelAnimationFrame(handle);
            handle = undefined;
        }
    };
    const unsubscribe = onGamepadsChanged(update);
    update();
    return () => {
        unsubscribe();
        if (handle !== undefined) {
            cancelAnimationFrame(handle);
            handle = undefined;
        }
    };
}
