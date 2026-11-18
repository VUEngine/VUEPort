/**
 * Makes the device's Back (Android's button or gesture, a browser's back button) navigate inside VUEPort instead of
 * leaving the page: from a settings pane to the list of panes, out of a sheet or a window, out of a game to the
 * library.
 *
 * Whatever can be gone back from registers a handler, and Back runs the most recent one. While any handler is
 * registered, one extra guard entry sits on the page's history, so Back pops that instead of leaving and the handler
 * runs on popstate. Once no handler is left, the guard is taken off again, so the next Back leaves the page as usual.
 * Opt-in (allowBackNavigation), as only the standalone build owns its page's history; the studio's belongs to Theia.
 */

interface BackHandler {
    run: () => void;
}

const handlers: BackHandler[] = [];
let allowed = false;
let guarded = false;
// set while we take the guard off ourselves, so that popstate doesn't run a handler
let unguarding = false;
let scheduled = false;

const GUARD_STATE = { vueportBack: true };

function sync(): void {
    scheduled = false;
    if (!allowed) {
        return;
    }
    if (handlers.length > 0 && !guarded && !unguarding) {
        history.pushState(GUARD_STATE, '');
        guarded = true;
    } else if (handlers.length === 0 && guarded && !unguarding) {
        unguarding = true;
        history.back();
    }
}

// deferred to after the current task, so a window replaced by another in one render neither takes the guard off
// nor pushes a second one
function schedule(): void {
    if (!scheduled) {
        scheduled = true;
        setTimeout(sync, 0);
    }
}

function onPopState(): void {
    if (unguarding) {
        unguarding = false;
        guarded = false;
        schedule();
        return;
    }
    if (!guarded) {
        return;
    }
    guarded = false;
    const top = handlers[handlers.length - 1];
    top?.run();
    // the handler usually takes itself away once React has rendered; whatever is left gets a fresh guard
    schedule();
}

// called once at start-up by a host that owns the page's history
export function allowBackNavigation(): void {
    if (allowed || typeof window === 'undefined') {
        return;
    }
    allowed = true;
    window.addEventListener('popstate', onPopState);
    schedule();
}

// registers what Back does while this is the newest thing open; the returned function removes it again by identity,
// as React unmounts in its own order and a handler above may go first
export function pushBackHandler(run: () => void): () => void {
    const handler: BackHandler = { run };
    handlers.push(handler);
    schedule();
    return () => {
        const at = handlers.lastIndexOf(handler);
        if (at !== -1) {
            handlers.splice(at, 1);
            schedule();
        }
    };
}
