import * as React from 'react';

// whether the library's side column is pulled out as a drawer on a phone. The button is the title bar's and the drawer
// the library's, so they share this module rather than threading a prop through the emulator

let open = false;
const listeners = new Set<() => void>();

export function setLibraryDrawer(next: boolean): void {
    if (next === open) {
        return;
    }
    open = next;
    listeners.forEach(listener => listener());
}

export function toggleLibraryDrawer(): void {
    setLibraryDrawer(!open);
}

export function useLibraryDrawer(): boolean {
    return React.useSyncExternalStore(
        React.useCallback((listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        }, []),
        () => open,
    );
}
