/**
 * Keeps the desktop app up to date. In a browser everything here answers "nothing to do", as it already runs what is
 * served. The actual work, checking the signature and running the installer, is the shell's (src-tauri/src/update.rs).
 * The title bar badge, the About window, the command and the check at start all ask whether there is a newer VUEPort,
 * so there is one module-level state and emitter rather than four network round trips and four answers that could
 * disagree. A build that was not code signed still checks, but cannot install: its release carries the `page` to
 * download it from, and the button opens that in the browser.
 */
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { invoke, isDesktop, listen } from './desktop-bridge';
import { openExternal } from './desktop-external';
import { checkUpdatesAtStart, downloadUpdatesAutomatically } from './web-update-settings';

export interface Release {
    version: string;
    date?: string;
    notes?: string;
    page?: string; // set when this build does not install updates: where to download the release by hand
}

export interface UpdateProgress {
    downloaded: number;
    total?: number; // the server need not say, so a download with no known end must be drawable
}

export type UpdateState =
    | { kind: 'idle' } // nobody asked yet
    | { kind: 'checking' }
    | { kind: 'current' } // asked, and this build is the newest: an answer owed after pressing the button
    | { kind: 'available', release: Release }
    | { kind: 'downloading', release: Release, progress?: UpdateProgress }
    // fetched and waiting; installing it from here costs no download
    | { kind: 'ready', release: Release }
    | { kind: 'installing', release: Release }
    | { kind: 'failed', message: string };

let state: UpdateState = { kind: 'idle' };
const onDidChangeEmitter = new Emitter<UpdateState>();

export const onDidChangeUpdateState: Event<UpdateState> = onDidChangeEmitter.event;

export function updateState(): UpdateState {
    return state;
}

function moveTo(next: UpdateState): void {
    state = next;
    onDidChangeEmitter.fire(next);
}

// the release to show a mark for: found, fetching and fetched all mean "there is a newer VUEPort"
export function pendingRelease(): Release | undefined {
    switch (state.kind) {
        case 'available':
        case 'downloading':
        case 'ready':
        case 'installing':
            return state.release;
        default:
            return undefined;
    }
}

export function canUpdate(): boolean {
    return isDesktop();
}

let installs = false;
const onDidLearnInstallsEmitter = new Emitter<void>();
export const onDidLearnInstalls: Event<void> = onDidLearnInstallsEmitter.event;
if (isDesktop()) {
    invoke<boolean>('update_installs').then(answer => {
        installs = answer;
        onDidLearnInstallsEmitter.fire();
    }).catch(() => undefined);
}

export function installsUpdates(): boolean {
    return installs;
}

// subscribed per call rather than once: the shell emits progress only while downloading, and a listener left attached
// is one more thing to get wrong in a window that outlives several downloads
async function whileDownloading(release: Release, run: () => Promise<void>): Promise<void> {
    const stop = await listen('update://progress', payload => {
        // a late event after the state moved on (install begun, or a failure) must not drag it back to downloading
        if (state.kind === 'downloading') {
            moveTo({ kind: 'downloading', release, progress: payload as UpdateProgress });
        }
    });
    try {
        await run();
    } finally {
        stop();
    }
}

// `silent` is for the unrequested check: a failure leaves the state as it was rather than showing an error to a user
// who opened the app on a train. Resolves to the release when there is one
export async function checkForUpdate(options?: { silent?: boolean }): Promise<Release | undefined> {
    if (!isDesktop()) {
        return undefined;
    }
    // a check while something is already happening would throw away a download in progress, or the bytes waiting
    if (state.kind === 'checking' || state.kind === 'downloading'
        || state.kind === 'ready' || state.kind === 'installing') {
        return pendingRelease();
    }

    moveTo({ kind: 'checking' });
    try {
        const release = await invoke<Release | null>('update_check') ?? undefined;
        moveTo(release ? { kind: 'available', release } : { kind: 'current' });
        return release;
    } catch (error) {
        moveTo(options?.silent ? { kind: 'idle' } : { kind: 'failed', message: String(error) });
        return undefined;
    }
}

// what the automatic download runs. The release that comes back is the one the bytes are for, which need not be the
// one a check found earlier
export async function downloadUpdate(): Promise<void> {
    const release = pendingRelease();
    if (!isDesktop() || !release || release.page || state.kind !== 'available') {
        return;
    }
    moveTo({ kind: 'downloading', release });
    try {
        await whileDownloading(release, async () => {
            const fetched = await invoke<Release>('update_download');
            moveTo({ kind: 'ready', release: fetched });
        });
    } catch (error) {
        moveTo({ kind: 'failed', message: String(error) });
    }
}

// does not return when it works: the process is replaced by the new one. Saving is the shell's handshake (it asks the
// page to write its saves, as on quitting). Fetches first when nothing has been fetched, so it works without auto
// download. In a build that does not install, opens the release page instead and leaves the state as it is
export async function installUpdate(): Promise<void> {
    const release = pendingRelease();
    if (!isDesktop() || !release) {
        return;
    }
    if (release.page) {
        await openExternal(release.page);
        return;
    }
    const downloading = state.kind !== 'ready';
    moveTo(downloading ? { kind: 'downloading', release } : { kind: 'installing', release });
    try {
        await whileDownloading(release, async () => {
            const stop = await listen('update://installing',
                () => moveTo({ kind: 'installing', release }));
            try {
                await invoke<void>('update_install');
            } finally {
                stop();
            }
        });
    } catch (error) {
        moveTo({ kind: 'failed', message: String(error) });
    }
}

// checking and fetching at start are both settings (see web-update-settings.ts for why checking is on and fetching
// is not); installing always stays a button
export async function updateOnStart(): Promise<void> {
    if (!isDesktop() || !checkUpdatesAtStart()) {
        return;
    }
    const release = await checkForUpdate({ silent: true });
    if (release && downloadUpdatesAutomatically()) {
        await downloadUpdate();
    }
}
