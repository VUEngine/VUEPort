import * as React from 'react';

/**
 * Showing an explanation beside a control.
 *
 * VES has a hover service with its own placement and styling; a
 * standalone host may have nothing richer than a title attribute. Both satisfy
 * this, which is all these controls ask for.
 */
export interface VueportHover {
    show(target: HTMLElement, content: string | HTMLElement): void;
    hide(): void;
}

/**
 * What the copied controls need from around them.
 *
 * In VES these came from the editors' React context, which is where the
 * originals still get them. This window is not an editor, so the emulator
 * provides its own — and the defaults below mean a control still works when
 * nobody provides anything at all, which is what makes them usable in a test or
 * a bare page.
 */
export interface VueportKitServices {
    hover: VueportHover;
    /**
     * Called with false while a field has focus, so the host can stop treating
     * key presses as its own shortcuts, and true when it lets go.
     */
    setCommandsEnabled(enabled: boolean): void;
}

export const DEFAULT_KIT_SERVICES: VueportKitServices = {
    hover: { show: () => { }, hide: () => { } },
    setCommandsEnabled: () => { },
};

export const KitContext = React.createContext<VueportKitServices>(DEFAULT_KIT_SERVICES);

export function useKit(): VueportKitServices {
    return React.useContext(KitContext);
}
