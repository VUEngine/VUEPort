// each entry can be a whole ROM in origin-private storage (web-recent-roms.ts), so this is a storage knob too. As in
// web-theme.ts, nothing is stored until the user changes it
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';

const STORAGE_KEY = 'vueport.maxRecent';

export const DEFAULT_MAX_RECENT = 128;
export const MIN_MAX_RECENT = 0; // zero means no shelf, RecentRoms.remember then keeps nothing
// the index is rewritten whole on every ROM opened (see RecentRoms.remember), which stays a small write at this size
export const MAX_MAX_RECENT = 500;

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeMaxRecent: Event<void> = onDidChangeEmitter.event;

function clamp(value: number): number {
    return Math.max(MIN_MAX_RECENT, Math.min(MAX_MAX_RECENT, Math.round(value)));
}

export function maxRecent(): number {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) {
            return DEFAULT_MAX_RECENT;
        }
        const parsed = parseInt(raw, 10);
        return Number.isNaN(parsed) ? DEFAULT_MAX_RECENT : clamp(parsed);
    } catch {
        // private browsing: nothing was remembered, so the default holds
        return DEFAULT_MAX_RECENT;
    }
}

export function setMaxRecent(value: number): void {
    const clamped = clamp(value);
    if (clamped === maxRecent()) {
        return;
    }
    try {
        window.localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
        // still applies to this session, it just is not remembered
    }
    onDidChangeEmitter.fire();
}
