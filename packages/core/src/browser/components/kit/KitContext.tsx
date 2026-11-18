import * as React from 'react';
import { DOM_HOVER } from './dom-hover';

// VES has a hover service with its own placement and styling, a standalone host may only have a title attribute
export interface VueportHover {
    show(target: HTMLElement, content: string | HTMLElement): void;
    hide(): void;
}

// in VES these come from the editors' React context
export interface VueportKitServices {
    hover: VueportHover;
    // false while a field has focus, so the host stops treating key presses as its own shortcuts
    setCommandsEnabled(enabled: boolean): void;
}

// keeps a control working when nothing is provided, e.g. in a test or a bare page
export const DEFAULT_KIT_SERVICES: VueportKitServices = {
    hover: DOM_HOVER,
    setCommandsEnabled: () => { },
};

export const KitContext = React.createContext<VueportKitServices>(DEFAULT_KIT_SERVICES);

export function useKit(): VueportKitServices {
    return React.useContext(KitContext);
}
