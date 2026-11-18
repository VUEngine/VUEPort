// tells the page when fullscreen changes outside its control (macOS' green button). Tauri has no fullscreen
// event, so this reads the state on every resize, which entering and leaving both cause, and emits only changes

use std::sync::Mutex;

use tauri::{Emitter, Manager, Window, WindowEvent};

#[derive(Default)]
pub struct FullscreenState {
    last: Mutex<Option<bool>>, // what the page was last told, so a plain resize stays quiet
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Resized(_)) {
        return;
    }
    let Ok(fullscreen) = window.is_fullscreen() else {
        return;
    };

    let state = window.app_handle().state::<FullscreenState>();
    let mut last = state.last.lock().unwrap();
    if *last == Some(fullscreen) {
        return;
    }
    *last = Some(fullscreen);
    let _ = window.emit("window://fullscreen", fullscreen);
}
