// all on by default except rereading at start, which costs a disk pass on a rarely changing collection and cannot work
// without a click in the browser. As in web-theme.ts, nothing is stored until the user changes it
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeLibrarySettings: Event<void> = onDidChangeEmitter.event;

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

const SUBFOLDERS = 'vueport.library.subfolders';
const ARCHIVES = 'vueport.library.archives';
const LOOKUP = 'vueport.library.lookup';
const READ_AT_START = 'vueport.library.readAtStart';

export function scanSubfolders(): boolean {
    return read(SUBFOLDERS, true);
}

export function setScanSubfolders(value: boolean): void {
    write(SUBFOLDERS, value, true);
}

export function scanArchives(): boolean {
    return read(ARCHIVES, true);
}

export function setScanArchives(value: boolean): void {
    write(ARCHIVES, value, true);
}

// the only setting here that touches the network
export function lookUpDetails(): boolean {
    return read(LOOKUP, true);
}

export function setLookUpDetails(value: boolean): void {
    write(LOOKUP, value, true);
}

export function readFoldersAtStart(): boolean {
    return read(READ_AT_START, false);
}

export function setReadFoldersAtStart(value: boolean): void {
    write(READ_AT_START, value, false);
}
