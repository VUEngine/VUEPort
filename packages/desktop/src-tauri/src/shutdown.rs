// holds quitting until the page has written its saves: cart RAM lives in the worker, and a write started on the way out
// loses the race against the webview teardown. Covers closing the window, Command-Q (see hold_terminate) and restarting
// into an update; FLUSH_TIMEOUT if the page never answers

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

// the window that is the application; every other one is a second player
const MAIN: &str = "main";

const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Shutdown {
    asked: AtomicBool,
    ready: AtomicBool, // safe to go, quitting is not held again
    restart: AtomicBool, // going means starting again: an update is on disk, waiting to be the one running
    released: Mutex<HashSet<String>>, // second players' windows that have written their saves and may close
}

// idempotent, as a quit can arrive through both entry points (closing the last window asks the application to
// exit)
fn begin(app: &AppHandle) {
    let state = app.state::<Shutdown>();
    if state.asked.swap(true, Ordering::SeqCst) {
        return;
    }

    if app.emit("app://close-requested", ()).is_err() {
        // the ask could not even be dispatched, so nothing will answer it
        finish(app);
        return;
    }

    // the page may be wedged or have failed to start, neither is a reason to leave the user unable to quit
    let waiting = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FLUSH_TIMEOUT);
        finish(&waiting);
    });
}

fn finish(app: &AppHandle) {
    let state = app.state::<Shutdown>();
    state.ready.store(true, Ordering::SeqCst);
    if state.restart.load(Ordering::SeqCst) {
        // diverges: this process is replaced by the build just installed
        app.restart();
    }
    app.exit(0);
}

// how an installed update ends (see update.rs): the same handshake as quitting, as the new build is already on
// disk but the cart RAM of the running game is still only in the worker
pub fn restart_when_saved(app: &AppHandle) {
    app.state::<Shutdown>().restart.store(true, Ordering::SeqCst);
    begin(app);
}

// whether another player's window is open beside this one, which closing this one must leave running
fn others_open(window: &Window) -> bool {
    window.app_handle().webview_windows().keys().any(|label| label != window.label())
}

/**
 * Closing one window of a linked game is one player leaving it, whichever window it is, but that window has a machine
 * and a cartridge save of its own in its worker, so it gets the same chance and time limit to write it out. The
 * application ends with its last window (see on_exit_requested).
 */
fn hold_one_window(window: &Window, api: &tauri::CloseRequestApi) {
    let label = window.label().to_string();
    let app = window.app_handle();
    let state = app.state::<Shutdown>();
    if state.released.lock().unwrap().remove(&label) {
        // it has told us it is done, this is the close it asked for
        return;
    }
    api.prevent_close();
    let _ = app.emit_to(label.as_str(), "app://close-requested", ());

    let waiting = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FLUSH_TIMEOUT);
        let app = waiting.app_handle();
        app.state::<Shutdown>()
            .released
            .lock()
            .unwrap()
            .insert(waiting.label().to_string());
        let _ = waiting.close();
    });
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let state = window.app_handle().state::<Shutdown>();
    if state.ready.load(Ordering::SeqCst) {
        return;
    }
    if window.label() != MAIN || (!state.asked.load(Ordering::SeqCst) && others_open(window)) {
        hold_one_window(window, api);
        return;
    }
    api.prevent_close();
    begin(window.app_handle());
}

// the last window closing, or an exit asked for from in here. Not Command-Q on macOS, see hold_terminate.
pub fn on_exit_requested(app: &AppHandle, api: &tauri::ExitRequestApi) {
    if app.state::<Shutdown>().ready.load(Ordering::SeqCst) {
        return;
    }
    // every window wrote its saves on the way out (hold_one_window), so there is nothing left to wait for
    if app.webview_windows().is_empty() && !app.state::<Shutdown>().restart.load(Ordering::SeqCst) {
        app.state::<Shutdown>().ready.store(true, Ordering::SeqCst);
        return;
    }
    api.prevent_exit();
    begin(app);
}

// the application hold_terminate asks about, set once at start-up
#[cfg(target_os = "macos")]
static TERMINATING: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

// holds macOS' own way out (Command-Q, Quit in menu or Dock, logout) until the saves are written. tao never answers
// applicationShouldTerminate:, which AppKit takes as yes, so this adds the answer to tao's delegate: cancel and start
// the handshake, yes once finish calls terminate: again
#[cfg(target_os = "macos")]
pub fn hold_terminate(app: &AppHandle) {
    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};

    // NSApplicationTerminateReply: NSTerminateCancel and NSTerminateNow
    const CANCEL: usize = 0;
    const NOW: usize = 1;

    extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        let Some(app) = TERMINATING.get() else {
            return NOW;
        };
        if app.state::<Shutdown>().ready.load(Ordering::SeqCst) {
            return NOW;
        }
        begin(app);
        CANCEL
    }

    if TERMINATING.set(app.clone()).is_err() {
        return;
    }
    // SAFETY: called from setup, on the main thread, once tao has installed its delegate. The function matches the
    // selector's signature, which the type string spells out: an NSUInteger back, self, _cmd, the sender.
    unsafe {
        let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![application, delegate];
        let Some(delegate) = delegate.as_ref() else {
            return;
        };
        let imp: Imp = std::mem::transmute(
            should_terminate as extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
        );
        class_addMethod(
            delegate.class() as *const AnyClass as *mut AnyClass,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        );
    }
}

#[tauri::command]
pub fn request_quit(app: AppHandle) {
    begin(&app);
}

// the page has finished writing. This closes that window only, unless the application is quitting and this is the
// main window, which lets the process exit
#[tauri::command]
pub fn confirm_close(window: Window, app: AppHandle) {
    if window.label() == MAIN && app.state::<Shutdown>().asked.load(Ordering::SeqCst) {
        finish(&app);
        return;
    }
    app.state::<Shutdown>()
        .released
        .lock()
        .unwrap()
        .insert(window.label().to_string());
    let _ = window.close();
}
