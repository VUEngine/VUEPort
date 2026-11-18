// pad commands go to the command palette first, then to a window that steers itself (the settings), then to the screen
// (the library). Home toggles the palette, and an open list owns the pad
import { GamepadProfileResolver } from 'vueport-core/lib/browser/emulator-gamepad';
import { gamepadScreenTarget, gamepadWindowTarget, listenToGamepadUi } from './web-gamepad-ui';
import type { WebUi } from './web-ui';

export interface GamepadPaletteOptions {
    resolver(): GamepadProfileResolver;
    ui: WebUi;
    openPalette(): void;
    // a self-steering window is up, so the screen must not be steered
    blocked(): boolean;
}

export function steerPaletteWithGamepad(options: GamepadPaletteOptions): () => void {
    const { ui } = options;
    return listenToGamepadUi(options.resolver, command => {
        const owner = gamepadWindowTarget();
        if (command === 'palette') {
            if (ui.isPicking) {
                ui.steerPick('cancel');
            } else if (owner) {
                if (!ui.isPrompting && !ui.isCapturingKey && !ui.isConfirming) {
                    owner(command);
                }
            } else if (!options.blocked() && !ui.isPrompting && !ui.isCapturingKey) {
                options.openPalette();
            }
            return;
        }
        if (ui.isPicking) {
            switch (command) {
                case 'confirm': ui.steerPick('accept'); break;
                case 'cancel': ui.steerPick('cancel'); break;
                case 'up': case 'down': ui.steerPick(command); break;
            }
            return;
        }
        if (ui.isPrompting || ui.isCapturingKey || ui.isConfirming) {
            return;
        }
        if (owner) {
            owner(command);
        } else if (!options.blocked()) {
            gamepadScreenTarget()?.(command);
        }
    });
}
