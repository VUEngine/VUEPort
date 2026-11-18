// lets code outside the Emulator component open the phone's quick menu (EmulatorQuickMenu), e.g. the standalone build's
// swipe up from the bottom edge (web-edge-swipes.ts); only heard while a game runs on a phone

const listeners = new Set<() => void>();

export function requestQuickMenu(): void {
    listeners.forEach(listener => listener());
}

export function onDidRequestQuickMenu(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
