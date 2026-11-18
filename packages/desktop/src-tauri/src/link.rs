// the second player's window: a webview cannot open one for itself, so the shell does (same page and origin, the
// query says which player and session). Whether a BroadcastChannel reaches across is up to the system webview,
// tests/link-probe.mjs checks it.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const SECOND_PLAYER: &str = "player2";

// separate from the command so the start-up probe can reach it without an async runtime, and so the command
// can be async (see there for why it must be)
fn open(app: &AppHandle, query: &str) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(SECOND_PLAYER) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    // the one string that crosses from the page into a window builder, so make sure it cannot become a path
    if query.contains('/') || query.contains('#') || query.len() > 512 {
        return Err("That is not a link session address.".into());
    }

    let url = WebviewUrl::App(format!("index.html?{query}").into());
    let window = WebviewWindowBuilder::new(app, SECOND_PLAYER, url)
        .title("VUEPort — Player 2")
        .inner_size(1280.0, 860.0)
        .min_inner_size(640.0, 480.0);

    #[cfg(target_os = "macos")]
    let window = window
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 24.0));

    #[cfg(not(target_os = "macos"))]
    let window = window.decorations(false);

    // the main window's command line, or this one would not open at all
    #[cfg(windows)]
    let window = window.additional_browser_args(crate::WEBVIEW2_ARGUMENTS);

    // the diagnostics check whether two windows can hear each other, which needs them in both
    #[cfg(debug_assertions)]
    let window = window.initialization_script(crate::DIAGNOSTICS);

    let window = window.build().map_err(|error| error.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/**
 * The query holds session id, seat and game, as the browser build puts them in a URL. Must stay async: a synchronous
 * command runs on the IPC thread, which on Windows is WebView2's one thread, and WebView2 deadlocks creating a webview
 * inside another webview's message handler (a window with a white rectangle). An async command sends the build to the
 * event loop between callbacks. See https://github.com/tauri-apps/wry/issues/583 and the warning on
 * WebviewWindowBuilder::new; macOS and Linux do not care.
 */
#[tauri::command]
pub async fn open_link_window(app: AppHandle, query: String) -> Result<(), String> {
    open(&app, &query)
}

#[tauri::command]
pub fn link_window_open(app: AppHandle) -> bool {
    app.get_webview_window(SECOND_PLAYER).is_some()
}

// opens the second window at start-up for the diagnostics' BroadcastChannel check, when VUEPORT_LINK_PROBE is
// set. Directly rather than through the command: in setup there is no webview callback yet to deadlock in.
#[cfg(debug_assertions)]
pub fn probe_second_window(app: &AppHandle) {
    if std::env::var("VUEPORT_LINK_PROBE").is_err() {
        return;
    }
    let _ = open(app, "link=probe&player=2");
}

// synchronous, unlike opening: closing goes to the event loop as a message from any thread
#[tauri::command]
pub fn close_link_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window(SECOND_PLAYER) {
        let _ = window.close();
    }
}
