// headset settings kept between sessions (screen size, depth, backdrop) and user activation check, see
// EmulatorXrController. Browser storage rather than settings: mostly set inside a headset, same for every host

import { nls } from '../common/emulator-nls';
import { clampXrScreen, XrBackdrop, XrScreen } from './emulator-xr';

// see EmulatorXrController.screen
const XR_SCREEN_KEY = 'vueport.xrView';

export function loadXrScreen(): XrScreen {
    try {
        const stored = localStorage.getItem(XR_SCREEN_KEY);
        if (stored) {
            return clampXrScreen(JSON.parse(stored) as Partial<XrScreen>);
        }
    } catch {
        // unreadable or refused: use defaults
    }
    return clampXrScreen({});
}

export function saveXrScreen(screen: XrScreen): void {
    try {
        localStorage.setItem(XR_SCREEN_KEY, JSON.stringify(screen));
    } catch {
        // kept for this session only
    }
}

// whether the user just clicked or pressed a key, which browsers require for a headset. Without the User
// Activation API, assume yes: a wrong guess only costs a refusal, which the VR button then makes up for
export function userActivationIsActive(): boolean {
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return activation?.isActive ?? true;
}

// see EmulatorXrController.backdrop
const XR_BACKDROP_KEY = 'vueport.xrBackdrop';
// old key from when it was only passthrough on/off; read once and removed
const XR_PASSTHROUGH_KEY = 'vueport.xrPassthrough';

// in the order a menu cycles through them
export const XR_BACKDROPS: readonly XrBackdrop[] = ['black', 'passthrough', 'hologram'];

export function xrBackdropLabel(backdrop: XrBackdrop): string {
    switch (backdrop) {
        case 'passthrough':
            return nls.localize('vueport/xr/menu/backdrop/passthrough', 'Passthrough');
        case 'hologram':
            return nls.localize('vueport/xr/menu/backdrop/hologram', 'Hologram');
        default:
            return nls.localize('vueport/xr/menu/backdrop/black', 'Black');
    }
}

export function loadXrBackdrop(): XrBackdrop {
    try {
        const stored = localStorage.getItem(XR_BACKDROP_KEY);
        if (XR_BACKDROPS.includes(stored as XrBackdrop)) {
            return stored as XrBackdrop;
        }
        const before = localStorage.getItem(XR_PASSTHROUGH_KEY);
        if (before !== null) {
            const backdrop: XrBackdrop = before === 'true' ? 'passthrough' : 'black';
            saveXrBackdrop(backdrop);
            localStorage.removeItem(XR_PASSTHROUGH_KEY);
            return backdrop;
        }
    } catch {
        // unreadable or refused: black
    }
    return 'black';
}

export function saveXrBackdrop(backdrop: XrBackdrop): void {
    try {
        localStorage.setItem(XR_BACKDROP_KEY, backdrop);
    } catch {
        // kept for this session only
    }
}

export function nextXrBackdrop(backdrop: XrBackdrop): XrBackdrop {
    return XR_BACKDROPS[(XR_BACKDROPS.indexOf(backdrop) + 1) % XR_BACKDROPS.length];
}
