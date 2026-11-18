import * as React from 'react';

/**
 * Whether the page is laid out for a phone, and which way round it is held. `portrait` is a narrow screen held upright:
 * the picture goes to the top, the transport below it and the on-screen controller under that, and panels and windows
 * come up from the bottom edge. `landscape` is a phone on its side: the picture fills the height and the controller
 * sits beside it. Undefined means every other screen (desktop, tablet and studio alike), which keeps the ordinary
 * layout.
 *
 * Opt-in (allowCompactLayout), as only the standalone build is ever opened on a phone; the studio's panels can be
 * narrow without being one. While allowed, <html> carries the classes below, so stylesheets follow the same answer as
 * the components instead of repeating the queries.
 */
export type CompactLayout = 'portrait' | 'landscape';

export const COMPACT_CLASS = 'vp-compact';
export const COMPACT_PORTRAIT_CLASS = 'vp-compact-portrait';
export const COMPACT_LANDSCAPE_CLASS = 'vp-compact-landscape';

// a phone held upright is at most this wide; a tablet upright is wider and keeps the ordinary layout
const PORTRAIT_QUERY = '(max-width: 640px) and (orientation: portrait)';
// a phone on its side is short and touch-driven; a short desktop window used with a mouse keeps the ordinary layout
const LANDSCAPE_QUERY = '(max-height: 500px) and (orientation: landscape) and (pointer: coarse)';

let allowed = false;
let current: CompactLayout | undefined;
const listeners = new Set<() => void>();

function measure(): CompactLayout | undefined {
    if (!allowed || typeof window === 'undefined' || !window.matchMedia) {
        return undefined;
    }
    if (window.matchMedia(PORTRAIT_QUERY).matches) {
        return 'portrait';
    }
    if (window.matchMedia(LANDSCAPE_QUERY).matches) {
        return 'landscape';
    }
    return undefined;
}

function refresh(): void {
    const next = measure();
    if (next === current) {
        return;
    }
    current = next;
    const root = document.documentElement.classList;
    root.toggle(COMPACT_CLASS, next !== undefined);
    root.toggle(COMPACT_PORTRAIT_CLASS, next === 'portrait');
    root.toggle(COMPACT_LANDSCAPE_CLASS, next === 'landscape');
    listeners.forEach(listener => listener());
}

// called once at start-up by a host that can be opened on a phone
export function allowCompactLayout(): void {
    if (allowed || typeof window === 'undefined' || !window.matchMedia) {
        return;
    }
    allowed = true;
    for (const query of [PORTRAIT_QUERY, LANDSCAPE_QUERY]) {
        window.matchMedia(query).addEventListener('change', refresh);
    }
    refresh();
}

export function compactLayout(): CompactLayout | undefined {
    return current;
}

export function onDidChangeCompactLayout(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useCompactLayout(): CompactLayout | undefined {
    return React.useSyncExternalStore(onDidChangeCompactLayout, compactLayout, () => undefined);
}

// iPhone Safari supports neither the standard nor the prefixed fullscreen API for anything but a video, so a
// fullscreen button would do nothing there
export function canGoFullscreen(): boolean {
    if (typeof document === 'undefined') {
        return true;
    }
    const prefixed = (document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled;
    return document.fullscreenEnabled === true || prefixed === true;
}

function fullscreenElement(): Element | null {
    return document.fullscreenElement
        ?? (document as unknown as { webkitFullscreenElement?: Element | null }).webkitFullscreenElement
        ?? null;
}

export function usePageFullscreen(): boolean {
    return React.useSyncExternalStore(
        React.useCallback((listener: () => void) => {
            document.addEventListener('fullscreenchange', listener);
            document.addEventListener('webkitfullscreenchange', listener);
            return () => {
                document.removeEventListener('fullscreenchange', listener);
                document.removeEventListener('webkitfullscreenchange', listener);
            };
        }, []),
        () => fullscreenElement() !== null,
        () => false,
    );
}
