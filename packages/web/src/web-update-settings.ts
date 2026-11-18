/**
 * Two separate switches: checking is cheap and on by default, fetching is tens of megabytes on possibly metered data
 * and off by default. Neither installs anything; that stays a button press, as the app restarts. Only effective on
 * desktop, but free of a host check so the settings pane need not know where it runs. As in `web-library-settings.ts`,
 * nothing is stored until changed, so a new default still reaches everyone else.
 */
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeUpdateSettings: Event<void> = onDidChangeEmitter.event;

function read(key: string, fallback: boolean): boolean {
    try {
        const stored = window.localStorage.getItem(key);
        return stored === null ? fallback : stored === 'true';
    } catch {
        // private browsing: nothing was remembered, so the default holds
        return fallback;
    }
}

function write(key: string, value: boolean, fallback: boolean): void {
    if (value === read(key, fallback)) {
        return;
    }
    try {
        window.localStorage.setItem(key, value ? 'true' : 'false');
    } catch {
        // the setting holds for this session only
    }
    onDidChangeEmitter.fire();
}

const CHECK_AT_START = 'vueport.update.checkAtStart';
const DOWNLOAD_AUTOMATICALLY = 'vueport.update.download';

export function checkUpdatesAtStart(): boolean {
    return read(CHECK_AT_START, true);
}

export function setCheckUpdatesAtStart(value: boolean): void {
    write(CHECK_AT_START, value, true);
}

// only ever after a check has found one, so turning the check off turns this off too in practice
export function downloadUpdatesAutomatically(): boolean {
    return read(DOWNLOAD_AUTOMATICALLY, false);
}

export function setDownloadUpdatesAutomatically(value: boolean): void {
    write(DOWNLOAD_AUTOMATICALLY, value, false);
}
