// read once when the library opens; opening a ROM is web-auto-start.ts. As in web-theme.ts, nothing is stored until the
// user changes it, so a new default still reaches everyone else
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';

const STORAGE_KEY = 'vueport.library.startPage';

// the shelves' own names (Section in web-library-view.tsx)
export type StartPage = 'recent' | 'all' | 'favorites' | 'featured' | 'archive';

const PAGES: readonly StartPage[] = ['recent', 'all', 'favorites', 'featured', 'archive'];

// coming back to carry on is the usual start; with that shelf switched off it falls back to All Games
export const DEFAULT_START_PAGE: StartPage = 'recent';

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeStartPage: Event<void> = onDidChangeEmitter.event;

export function startPage(): StartPage {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return PAGES.includes(stored as StartPage) ? stored as StartPage : DEFAULT_START_PAGE;
    } catch {
        // private browsing: nothing was remembered, so the default holds
        return DEFAULT_START_PAGE;
    }
}

export function setStartPage(page: StartPage): void {
    if (page === startPage()) {
        return;
    }
    try {
        window.localStorage.setItem(STORAGE_KEY, page);
    } catch {
        // still applies to this session, it just is not remembered
    }
    onDidChangeEmitter.fire();
}
