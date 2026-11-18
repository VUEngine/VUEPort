import * as React from 'react';

/**
 * Whether the user is playing by touch, for the on-screen controller's Automatic mode: it comes up when the screen is
 * touched, goes once a key or a pad button plays the game, and comes back on the next touch. Starts from what the
 * device is, a touch screen without a mouse, so a phone has its controller before the first tap. One answer per page,
 * as the hands are the same whichever emulator they reach.
 */

let touching: boolean | undefined;
const listeners = new Set<() => void>();
let watching = false;

function initial(): boolean {
    return typeof window !== 'undefined' && !!window.matchMedia
        && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function set(next: boolean): void {
    if (next === touching) {
        return;
    }
    touching = next;
    listeners.forEach(listener => listener());
}

function watch(): void {
    if (watching || typeof document === 'undefined') {
        return;
    }
    watching = true;
    document.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch') {
            set(true);
        }
    }, { capture: true, passive: true });
}

// a key or pad button reached the game; called by the input controller, which can tell a played key from a typed one
export function notePhysicalInput(): void {
    if (touching !== false) {
        set(false);
    }
}

export function isTouching(): boolean {
    touching ??= initial();
    return touching;
}

export function useTouchPresence(): boolean {
    React.useEffect(watch, []);
    return React.useSyncExternalStore(
        React.useCallback((listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        }, []),
        isTouching,
        () => false,
    );
}
