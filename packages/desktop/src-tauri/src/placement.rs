// the page's position on the display to the physical pixel. Interleaved modes give each eye every other display line or
// column, and at 125 or 150 % scaling whole CSS pixels aren't whole display pixels, so the eyes would swap as the
// window moves. Sent on request and on every move, resize and scale change

use serde::Serialize;
use tauri::{Emitter, Webview, Window, WindowEvent};

// top-left corner of the page, in physical display pixels
#[derive(Serialize, Clone, Copy)]
pub struct ContentOrigin {
    x: i32,
    y: i32,
}

// content area plus the webview's offset inside it, which is not assumed to be zero
fn origin_of(window: &Window) -> Option<ContentOrigin> {
    let inner = window.inner_position().ok()?;
    let offset = window
        .webviews()
        .first()
        .and_then(|webview| webview.position().ok())
        .map(|position| (position.x, position.y))
        .unwrap_or((0, 0));
    Some(ContentOrigin {
        x: inner.x + offset.0,
        y: inner.y + offset.1,
    })
}

#[tauri::command]
pub fn window_content_origin(webview: Webview) -> Option<ContentOrigin> {
    origin_of(&webview.window())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(
        event,
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
    ) {
        return;
    }
    if let Some(origin) = origin_of(window) {
        let _ = window.emit("window://content-origin", origin);
    }
}
