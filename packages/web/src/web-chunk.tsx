import * as React from 'react';
import { nls } from 'vueport-core/lib/common/emulator-nls';

/**
 * Loads the lazily imported windows and settings panes (see web-emulator.tsx), which can fail: a deploy renames every
 * content-addressed chunk (the dev server too, when dist is rebuilt), or the request fails on its way (network change,
 * proxy, sleeping laptop). A rejected import() throws where React renders, and without a boundary that unmounts the
 * whole app, running game included. So there is one retry for the second case and a boundary for the rest.
 */

const RETRY_DELAY = 400;

/**
 * The retry is for a transient failure: same URL, a moment later. A chunk really gone fails again and the boundary
 * takes over; there is no cache to bust, as the URL is in the bundle. Pass a closure, not the promise, or the retry
 * gets the same rejected promise: `React.lazy(() => importChunk(() => import('./web-about')))`.
 */
export function importChunk<T>(load: () => Promise<T>): Promise<T> {
    return load().catch(async error => {
        console.warn('VUEPort: a chunk failed to load, retrying.', error);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return load();
    });
}

// no error type to check: every engine throws a plain TypeError, worded differently (Firefox "error loading
// dynamically imported module", Chrome "Failed to fetch dynamically imported module", Safari "Importing a module
// script failed"). A miss only costs the more general message
function isChunkError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /dynamically imported module|Importing a module script failed|error loading module/i.test(message);
}

interface ChunkBoundaryProps {
    children: React.ReactNode;
    // clears a caught error when it changes, so the next thing rendered gets its own attempt: the settings dialog
    // passes its pane, the overlay which of its windows are open
    resetKey?: unknown;
    // called once per error; the overlay uses it to say what its own fallback cannot, having nothing on screen
    onError?: (error: unknown, chunk: boolean) => void;
    quiet?: boolean;
}

interface ChunkBoundaryState {
    error?: unknown;
}

/**
 * Keeps a failed lazy component from taking the app down. Catches everything, not only chunk errors: a pane throwing
 * while rendering is a bug, but no reason to unmount the emulator. Reloading is the offered way out, as React.lazy
 * remembers a rejected import and a reload fetches the current index.html, which names the files that exist. Never
 * reloads on its own, as a game is likely running.
 */
export class ChunkBoundary extends React.Component<ChunkBoundaryProps, ChunkBoundaryState> {

    state: ChunkBoundaryState = {};

    static getDerivedStateFromError(error: unknown): ChunkBoundaryState {
        return { error };
    }

    componentDidCatch(error: unknown): void {
        this.props.onError?.(error, isChunkError(error));
    }

    componentDidUpdate(previous: ChunkBoundaryProps): void {
        if (this.state.error !== undefined && previous.resetKey !== this.props.resetKey) {
            this.setState({ error: undefined });
        }
    }

    render(): React.ReactNode {
        const { error } = this.state;
        if (error === undefined) {
            return this.props.children;
        }
        if (this.props.quiet) {
            return null;
        }
        return <div className='vp-chunk-error' role='alert'>
            <p>{chunkErrorMessage(error)}</p>
            <button className='vp-button' onClick={() => window.location.reload()}>
                {nls.localize('vueport/chunk/reload', 'Reload')}
            </button>
        </div>;
    }
}

export function chunkErrorMessage(error: unknown): string {
    return isChunkError(error)
        ? nls.localize(
            'vueport/chunk/failed',
            'This part of the interface could not be loaded. Reloading the page should bring it back.')
        : nls.localize(
            'vueport/chunk/broke',
            'Something went wrong showing this. Reloading the page may help.');
}
