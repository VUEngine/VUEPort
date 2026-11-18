// a headset's controllers, read once a frame (see emulator-xr.ts). Headset browsers never list them to the
// Gamepad API and stop animation frames during a session, so the session reads them itself

import { VbKey } from '../common/vb-constants';
import { XrInputSource } from './emulator-xr-webxr';

export const XR_STICK_THRESHOLD = 0.5;

// laid out like the console's pad: sticks are the D-pads, triggers L and R, right A/B are A and B, left X/Y Select and
// Start. Buttons by the `xr-standard` mapping, which every current headset reports. A held grip turns both sticks to
// adjusting the view (see adjustView), so their directions are left out of the keys and reported as leans and clicks
export function readControllers(sources: ArrayLike<XrInputSource>): XrControllerReading {
    let keys = 0;
    let adjusting = false;
    let leftLean = 0;
    let rightLean = 0;
    let vertical = 0;
    const triggers = { left: 0, right: 0 };
    const buttons = noXrButtons();
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const pad = source.gamepad;
        if (!pad || pad.mapping !== 'xr-standard' || source.handedness === 'none') {
            continue;
        }
        const left = source.handedness === 'left';
        const pressed = (index: number) => pad.buttons[index]?.pressed ?? false;
        triggers[left ? 'left' : 'right'] = pad.buttons[0]?.value ?? (pressed(0) ? 1 : 0);
        // the stick is axes 2 and 3; 0 and 1 are a touchpad no current controller has. Up is negative
        const x = pad.axes[2] ?? 0;
        const y = pad.axes[3] ?? 0;
        const lean = Math.abs(x) > Math.abs(y) ? x : -y;
        if (Math.abs(y) > Math.abs(vertical)) {
            vertical = y;
        }
        if (left) {
            leftLean = lean;
            buttons.leftClick = pressed(3);
            buttons.leftTrigger = pressed(0);
            buttons.x = pressed(4);
            buttons.y = pressed(5);
            // menu button, if the browser passes it on at all: past the thumb rest (6), where published layouts end
            buttons.menu = pad.buttons.slice(7).some(button => button?.pressed);
        } else {
            rightLean = lean;
            buttons.rightClick = pressed(3);
            buttons.rightTrigger = pressed(0);
            buttons.a = pressed(4);
            buttons.b = pressed(5);
        }
        if (pressed(1)) {
            adjusting = true;
        }
        if (x < -XR_STICK_THRESHOLD) {
            keys |= left ? VbKey.LL : VbKey.RL;
        } else if (x > XR_STICK_THRESHOLD) {
            keys |= left ? VbKey.LR : VbKey.RR;
        }
        if (y < -XR_STICK_THRESHOLD) {
            keys |= left ? VbKey.LU : VbKey.RU;
        } else if (y > XR_STICK_THRESHOLD) {
            keys |= left ? VbKey.LD : VbKey.RD;
        }
        if (pressed(0)) {
            keys |= left ? VbKey.LT : VbKey.RT;
        }
        if (pressed(4)) {
            keys |= left ? VbKey.SEL : VbKey.A;
        }
        if (pressed(5)) {
            keys |= left ? VbKey.STA : VbKey.B;
        }
    }
    if (adjusting) {
        keys &= ~(VbKey.LU | VbKey.LD | VbKey.LL | VbKey.LR | VbKey.RU | VbKey.RD | VbKey.RL | VbKey.RR);
    }
    return { keys, adjusting, leftLean, rightLean, vertical, buttons, triggers };
}

export interface XrButtons {
    leftClick: boolean;
    rightClick: boolean;
    leftTrigger: boolean;
    rightTrigger: boolean;
    a: boolean;
    b: boolean;
    x: boolean;
    y: boolean;
    menu: boolean;
}

export function noXrButtons(): XrButtons {
    return {
        leftClick: false, rightClick: false, leftTrigger: false, rightTrigger: false,
        a: false, b: false, x: false, y: false, menu: false,
    };
}

export interface XrControllerReading {
    keys: number;
    // a held grip turns the sticks to adjusting the view
    adjusting: boolean;
    // -1 to 1, right or up, whichever axis the stick leans further in
    leftLean: number;
    rightLean: number;
    // furthest either stick leans up (negative) or down, for menu navigation
    vertical: number;
    buttons: XrButtons;
    // how far each trigger is pulled, 0 to 1, for holding on to a press until it is let go of rather than eased off
    triggers: { left: number; right: number };
}
