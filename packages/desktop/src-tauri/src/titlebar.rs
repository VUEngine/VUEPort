// keeps macOS' window buttons where the page's title bar wants them: macOS lays the title bar out again after a rename
// and after leaving fullscreen, moving them about 7 points left and 6 up. tao applies the nudge from main.rs only while
// the content view draws, so a redraw puts them back

use tauri::{Window, WindowEvent};

// costs nothing when they have not moved; off macOS the page draws its own buttons
#[cfg(target_os = "macos")]
pub fn restore(window: &Window) {
    let window = window.clone();
    let _ = window.clone().run_on_main_thread(move || {
        let Ok(view) = window.ns_view() else {
            return;
        };
        // SAFETY: that pointer is the window's content view, and this runs on the main thread, the only one
        // AppKit may be asked from
        unsafe {
            let view: &objc2_app_kit::NSView = &*view.cast();
            view.setNeedsDisplay(true);
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn restore(_window: &Window) {}

// leaving fullscreen arrives only as a resize (no fullscreen event, as in fullscreen.rs); redrawing on every
// resize costs nothing, the view redraws while a corner is dragged anyway
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if matches!(event, WindowEvent::Resized(_)) {
        restore(window);
    }
}

// the page names the window after the ROM, which made the buttons jump as a game starts. Routed through here
// rather than Tauri's set_title so nothing has to remember to restore afterwards.
#[tauri::command]
pub fn window_title(window: Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|error| error.to_string())?;
    restore(&window);
    Ok(())
}
