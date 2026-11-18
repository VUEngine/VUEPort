// which part of the UI the pad steers: the screen (library) or a window over it (settings). Reading the pad lives in
// core, so the rewind filmstrip is steered the same way in every host
export { listenToGamepadUi } from 'vueport-core/lib/browser/emulator-gamepad-ui';
export type { PadCommand, PadDirection } from 'vueport-core/lib/browser/emulator-gamepad-ui';
import type { PadCommand } from 'vueport-core/lib/browser/emulator-gamepad-ui';

let screenTarget: ((command: PadCommand) => void) | undefined;

// the returned release only lets go if nothing has taken over since
export function steerScreenWithGamepad(target: (command: PadCommand) => void): () => void {
    screenTarget = target;
    return () => {
        if (screenTarget === target) {
            screenTarget = undefined;
        }
    };
}

export function gamepadScreenTarget(): ((command: PadCommand) => void) | undefined {
    return screenTarget;
}

// a window takes Home too, since its answer to Home is to close rather than open the palette over itself
let windowTarget: ((command: PadCommand) => void) | undefined;

export function steerWindowWithGamepad(target: (command: PadCommand) => void): () => void {
    windowTarget = target;
    return () => {
        if (windowTarget === target) {
            windowTarget = undefined;
        }
    };
}

export function gamepadWindowTarget(): ((command: PadCommand) => void) | undefined {
    return windowTarget;
}
