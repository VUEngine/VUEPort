import { compactLayout } from 'vueport-core/lib/browser/compact-layout';
import { requestQuickMenu } from 'vueport-core/lib/browser/quick-menu-request';
import { setLibraryDrawer } from './web-library-drawer';

/**
 * Swipes in from a phone's edges (compact-layout.ts): from the left the library's column, from the right the settings,
 * and while a game runs, up from the bottom the game menu. Swiping the other way closes them: the column to the left,
 * the settings to the right (the sheets close themselves when swiped down, see BottomSheet). Only a finger, only where
 * nothing is open over the page, and never one that starts on the on-screen controller, whose d-pads sit close to the
 * sides.
 *
 * The very edge belongs to the system on most phones (Android's back gesture, Safari's history swipe), so the band a
 * swipe may start in reaches a little further in than the system's, and a swipe the system took never arrives here.
 */

// how far in from an edge a swipe may start, in CSS pixels
const EDGE_BAND = 32;
// how far it has to travel inwards to count
const DISTANCE = 56;
// and how far it may stray sideways, as a share of that
const STRAY = 0.6;
// longer than this is a drag, not a swipe
const MAX_MS = 700;

type Edge = 'left' | 'right' | 'bottom';
// a swipe that closes what it starts on rather than opening something from an edge
type Closing = 'drawer' | 'settings';

export interface EdgeSwipeHost {
    readonly hasRom: boolean;
    readonly settingsOpen: boolean;
    togglePreferencesWindow(): void;
}

function edgeOf(x: number, y: number): Edge | undefined {
    if (x <= EDGE_BAND) {
        return 'left';
    }
    if (x >= window.innerWidth - EDGE_BAND) {
        return 'right';
    }
    if (y >= window.innerHeight - EDGE_BAND) {
        return 'bottom';
    }
    return undefined;
}

// something is open over the page, which takes the touch rather than the edges behind it
function somethingOpen(): boolean {
    return document.querySelector('.vp-window-backdrop, .vp-sheet-backdrop, .vp-modal, .vp-touch-editing') !== null;
}

// touch events rather than pointer events, as a pointer is cancelled once the browser starts to pan, e.g. across the
// library's shelf, while a touch still ends where the finger lifts. Returns the cleanup
export function watchEdgeSwipes(host: EdgeSwipeHost): () => void {
    let start: { touch: number, x: number, y: number, at: number, edge: Edge | Closing } | undefined;

    const down = (event: TouchEvent): void => {
        start = undefined;
        // one finger only: two are a pinch, or a d-pad and a button
        if (event.touches.length !== 1 || compactLayout() === undefined) {
            return;
        }
        const touch = event.touches[0];
        const target = event.target instanceof Element ? event.target : undefined;
        if (target?.closest('.vp-touch-control')) {
            return;
        }
        const begun = { touch: touch.identifier, x: touch.clientX, y: touch.clientY, at: event.timeStamp };
        // a swipe to the left anywhere on the pulled-out column, or on the dimmed shelf beside it, puts it away
        if (target?.closest('.vp-library-side.open, .vp-library-drawer-backdrop.open')) {
            start = { ...begun, edge: 'drawer' };
            return;
        }
        // and one to the right on the settings closes them, unless it starts on something that takes a drag itself
        if (target?.closest('.vp-settings-window') && host.settingsOpen) {
            if (!target.closest('input, textarea, select, [role="slider"], .vp-touch-preview')) {
                start = { ...begun, edge: 'settings' };
            }
            return;
        }
        const edge = edgeOf(touch.clientX, touch.clientY);
        if (!edge || somethingOpen() || document.querySelector('.vp-library-side.open')) {
            return;
        }
        start = { ...begun, edge };
    };

    const up = (event: TouchEvent): void => {
        const from = start;
        const touch = from && Array.from(event.changedTouches).find(each => each.identifier === from.touch);
        if (!from || !touch) {
            return;
        }
        start = undefined;
        if (event.timeStamp - from.at > MAX_MS) {
            return;
        }
        const dx = touch.clientX - from.x;
        const dy = touch.clientY - from.y;
        const across = (along: number, side: number): boolean => along >= DISTANCE && Math.abs(side) <= along * STRAY;
        switch (from.edge) {
            case 'drawer':
                if (across(-dx, dy)) {
                    setLibraryDrawer(false);
                }
                break;
            case 'settings':
                if (host.settingsOpen && across(dx, dy)) {
                    host.togglePreferencesWindow();
                }
                break;
            case 'left':
                // the column is the library's; while a game runs there is nothing on the left to pull out
                if (!host.hasRom && across(dx, dy)) {
                    setLibraryDrawer(true);
                }
                break;
            case 'right':
                if (!host.settingsOpen && across(-dx, dy)) {
                    host.togglePreferencesWindow();
                }
                break;
            case 'bottom':
                if (host.hasRom && across(-dy, dx)) {
                    requestQuickMenu();
                }
                break;
        }
    };

    const cancel = (): void => { start = undefined; };

    document.addEventListener('touchstart', down, { capture: true, passive: true });
    document.addEventListener('touchend', up, { capture: true, passive: true });
    document.addEventListener('touchcancel', cancel, { capture: true, passive: true });
    return () => {
        document.removeEventListener('touchstart', down, { capture: true });
        document.removeEventListener('touchend', up, { capture: true });
        document.removeEventListener('touchcancel', cancel, { capture: true });
    };
}
