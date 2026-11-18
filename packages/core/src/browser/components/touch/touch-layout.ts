import { TouchControlPlacement, TouchControlsLayout } from '../../../common/emulator-settings';
import { VbKey } from '../../../common/vb-constants';

// on-screen controller laid out like the real pad: L and R on top, a d-pad under each, Select and Start mirroring B
// and A (Select outside and higher, as A is). All eight are round or a cross, as on the hardware
export type TouchControlId = 'l' | 'r' | 'ldpad' | 'rdpad' | 'select' | 'start' | 'b' | 'a';

export const TOUCH_CONTROL_IDS: readonly TouchControlId[] = ['l', 'r', 'ldpad', 'rdpad', 'select', 'start', 'b', 'a'];

// upright, the controller has the screen's width below the picture; on its side, the strips beside it
export type TouchOrientation = 'portrait' | 'landscape';

// a centre measured from an edge of the area in CSS pixels at 100 %, so the controls stay at the edges where the
// thumbs are and only the space between grows on larger phones
export interface TouchControlSpot {
    from: 'left' | 'right';
    x: number;
    // which edge `y` is measured from, or the middle of the height (negative `y` is above it)
    fromY: 'top' | 'bottom' | 'middle';
    y: number;
    size: number; // a button's diameter or a d-pad's width
}

export interface TouchLayoutSpec {
    // the area the spots were drawn for; the controller is scaled down where a phone has less, see layoutScale
    width: number;
    height: number;
    side: number; // how far in from each side the controller reaches, so a picture beside it can be kept clear of it
    spots: Record<TouchControlId, TouchControlSpot>;
}

export const TOUCH_LAYOUTS: Record<TouchOrientation, TouchLayoutSpec> = {
    // under the picture, anchored to the bottom edge where the thumbs rest
    portrait: {
        width: 390,
        height: 460,
        side: 390,
        spots: {
            l: { from: 'left', x: 60, fromY: 'bottom', y: 416, size: 64 },
            r: { from: 'right', x: 60, fromY: 'bottom', y: 416, size: 64 },
            ldpad: { from: 'left', x: 98, fromY: 'bottom', y: 278, size: 148 },
            rdpad: { from: 'right', x: 98, fromY: 'bottom', y: 278, size: 148 },
            select: { from: 'left', x: 60, fromY: 'bottom', y: 154, size: 64 },
            start: { from: 'left', x: 136, fromY: 'bottom', y: 126, size: 64 },
            a: { from: 'right', x: 60, fromY: 'bottom', y: 154, size: 64 },
            b: { from: 'right', x: 136, fromY: 'bottom', y: 126, size: 64 },
        },
    },
    // beside the picture, centred vertically; B and Start sit only a little below A and Select so the buttons don't
    // run off the bottom
    landscape: {
        width: 844,
        height: 390,
        side: 184,
        spots: {
            l: { from: 'left', x: 60, fromY: 'middle', y: -140, size: 70 },
            r: { from: 'right', x: 60, fromY: 'middle', y: -140, size: 70 },
            ldpad: { from: 'left', x: 96, fromY: 'middle', y: -13, size: 168 },
            rdpad: { from: 'right', x: 96, fromY: 'middle', y: -13, size: 168 },
            select: { from: 'left', x: 54, fromY: 'middle', y: 119, size: 72 },
            start: { from: 'left', x: 140, fromY: 'middle', y: 139, size: 72 },
            a: { from: 'right', x: 54, fromY: 'middle', y: 119, size: 72 },
            b: { from: 'right', x: 140, fromY: 'middle', y: 139, size: 72 },
        },
    },
};

export const BUTTON_KEYS: Record<Exclude<TouchControlId, 'ldpad' | 'rdpad'>, VbKey> = {
    l: VbKey.LT,
    r: VbKey.RT,
    select: VbKey.SEL,
    start: VbKey.STA,
    b: VbKey.B,
    a: VbKey.A,
};

export const DPAD_KEYS: Record<'ldpad' | 'rdpad', { up: VbKey, right: VbKey, down: VbKey, left: VbKey }> = {
    ldpad: { up: VbKey.LU, right: VbKey.LR, down: VbKey.LD, left: VbKey.LL },
    rdpad: { up: VbKey.RU, right: VbKey.RR, down: VbKey.RD, left: VbKey.RL },
};

export function isDpad(id: TouchControlId): id is 'ldpad' | 'rdpad' {
    return id === 'ldpad' || id === 'rdpad';
}

// shrinks the controller for an area smaller than the layout (an iPhone SE upright) rather than letting L and R run
// into the picture, and never enlarges it. Not below two thirds, where the buttons would be too small to hit; the area
// does not scroll, so whatever still does not fit is clipped
export function layoutScale(spec: TouchLayoutSpec, width: number, height: number): number {
    const fit = Math.min(width / spec.width, height / spec.height, 1);
    return Math.max(fit, 2 / 3);
}

export interface PlacedControl {
    id: TouchControlId;
    // centre, in the area's own pixels
    cx: number;
    cy: number;
    size: number;
}

// includes the user's own moves and sizes
export function placeControls(
    orientation: TouchOrientation,
    width: number,
    height: number,
    size: number,
    custom: TouchControlsLayout | undefined,
): PlacedControl[] {
    const spec = TOUCH_LAYOUTS[orientation];
    const scale = layoutScale(spec, width, height) * size;
    const moved = custom?.[orientation] ?? {};
    return TOUCH_CONTROL_IDS.map(id => {
        const spot = spec.spots[id];
        const own: TouchControlPlacement = moved[id] ?? { dx: 0, dy: 0, scale: 1 };
        const cx = (spot.from === 'left' ? spot.x * scale : width - spot.x * scale) + own.dx;
        const cy = (spot.fromY === 'top' ? spot.y * scale
            : spot.fromY === 'middle' ? height / 2 + spot.y * scale
                : height - spot.y * scale) + own.dy;
        return { id, cx, cy, size: spot.size * scale * own.scale };
    });
}

export function sideClearance(orientation: TouchOrientation, width: number, height: number, size: number): number {
    const spec = TOUCH_LAYOUTS[orientation];
    return spec.side * layoutScale(spec, width, height) * size;
}

export const PLACEMENT_SCALE_STEP = 0.05;
export const PLACEMENT_SCALE_RANGE = { min: 0.6, max: 1.6 };
