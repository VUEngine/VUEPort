// whether the start page's Continue column shows. Its close button turns it off (confirmed, as it's otherwise one-way),
// the Appearance pane brings it back; off also hides "From a link", which shares the aside. Nothing is stored until
// changed, as in web-theme.ts
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';

const STORAGE_KEY = 'vueport.continueVisible';

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeContinueVisible: Event<void> = onDidChangeEmitter.event;

export function continueVisible(): boolean {
    try {
        return window.localStorage.getItem(STORAGE_KEY) !== 'false';
    } catch {
        // private browsing: nothing was remembered, so the default holds
        return true;
    }
}

export function setContinueVisible(visible: boolean): void {
    if (visible === continueVisible()) {
        return;
    }
    try {
        window.localStorage.setItem(STORAGE_KEY, visible ? 'true' : 'false');
    } catch {
        // the choice still applies to this session, it just is not remembered
    }
    onDidChangeEmitter.fire();
}
