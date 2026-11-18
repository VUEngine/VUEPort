/**
 * Whether starting VUEPort starts the game played last: the newest Recently Played entry, where it was left with
 * Suspend and Resume. Off by default, so the library isn't taken away before the user has seen it. Switched with the
 * Recently Played shelf (see continueVisible), as a setting that isn't on screen shouldn't do anything. As in
 * web-theme.ts, nothing is stored until the user changes it, so a new default still reaches everyone else.
 */
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { continueVisible } from './web-continue-visibility';

const STORAGE_KEY = 'vueport.autoStartRecent';

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeAutoStartRecent: Event<void> = onDidChangeEmitter.event;

export function autoStartRecent(): boolean {
    try {
        return window.localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        // private browsing: nothing was remembered, so the default holds
        return false;
    }
}

export function setAutoStartRecent(value: boolean): void {
    if (value === autoStartRecent()) {
        return;
    }
    try {
        window.localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
    } catch {
        // the choice still applies to this session, it just is not remembered
    }
    onDidChangeEmitter.fire();
}

// asks the switch and its shelf together, so hiding the shelf cannot leave a game starting with nothing on screen
// to say why
export function startsWithLastGame(): boolean {
    return autoStartRecent() && continueVisible();
}
