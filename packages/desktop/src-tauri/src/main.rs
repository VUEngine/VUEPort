// prevents a console window opening alongside the app on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod external;
mod fullscreen;
mod gamepad;
mod lan_share;
mod launch;
mod library;
mod link;
mod opened;
mod placement;
mod probe;
mod rumble;
mod shutdown;
mod storage;
mod titlebar;
mod update;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

// webview diagnostics, development builds only: catches a webview quietly running the audio clock at the
// wrong rate, but draws a panel over the application
#[cfg(debug_assertions)]
pub(crate) const DIAGNOSTICS: &str = include_str!("../diagnostics.js");

/**
 * WebView2 command line on Windows. The first switch is wry's own default, which passing anything here replaces (no
 * mini menu over selected text, no SmartScreen). The other two enable WebXR through the system's OpenXR runtime
 * (Quest Link, Virtual Desktop, SteamVR); which of them does it is unknown, but the pair works with a Quest 3. Every
 * window must get the same line: WebView2 windows share one browser process, and a window asking for a different
 * command line fails to open. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, where set, still overrides all of it.
 */
#[cfg(windows)]
pub(crate) const WEBVIEW2_ARGUMENTS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--enable-features=WebXR,OpenXR --force-webxr-runtime=openxr";

// prints the diagnostics' findings. Over Tauri IPC, as App Transport Security refuses a fetch to a local port.
// Registered in every build so the command list stays one list; release builds just never call it.
#[tauri::command]
fn smoke_report(payload: String) {
    println!("SMOKE {}", payload);
}

// `overlay` (macOS) keeps the system's buttons and the page keeps its controls clear of them, `custom` drops the frame
// and the page draws minimize, maximize and close. Asked for, as the window builder decides it; a browser gets no
// answer
#[tauri::command]
fn window_chrome() -> &'static str {
    if cfg!(target_os = "macos") {
        "overlay"
    } else {
        "custom"
    }
}

fn main() {
    // --probe-cli and --probe-call talk to the already running copy and never start one of their own
    if let Some(code) = probe::client_main() {
        std::process::exit(code);
    }

    let context = tauri::generate_context!();
    if let Some(code) = launch::client_main(&context.package_info().version.to_string()) {
        std::process::exit(code);
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(config::ConfigState::default())
        .manage(rumble::RumbleState::default())
        .manage(gamepad::GamepadState::default())
        .manage(opened::OpenedFiles::default())
        .manage(shutdown::Shutdown::default())
        .manage(fullscreen::FullscreenState::default())
        .manage(update::Downloaded::default())
        .manage(probe::ProbeState::default())
        .manage(lan_share::LanShareState::default())
        .manage(launch::LaunchOptions::from_command_line())
        .on_window_event(|window, event| {
            shutdown::on_window_event(window, event);
            opened::on_window_event(window, event);
            fullscreen::on_window_event(window, event);
            titlebar::on_window_event(window, event);
            placement::on_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            storage::storage_read,
            storage::storage_write,
            storage::storage_exists,
            storage::storage_delete,
            storage::storage_list,
            storage::storage_measure,
            storage::storage_export,
            storage::storage_root,
            storage::storage_reveal,
            placement::window_content_origin,
            config::config_read,
            config::config_write,
            config::config_set,
            config::config_remove,
            rumble::rumble_ports,
            rumble::rumble_open,
            rumble::rumble_close,
            rumble::rumble_current,
            rumble::rumble_write,
            gamepad::gamepad_rumble,
            gamepad::gamepad_snapshot,
            opened::opened_files,
            opened::read_opened_file,
            opened::opened_paths,
            opened::reopen_file,
            opened::read_rom_build_file,
            launch::launch_options,
            opened::pick_rom,
            library::pick_library_folder,
            library::forget_library_folder,
            library::library_folder_ready,
            library::scan_library_folder,
            library::read_library_file,
            library::open_library_file,
            external::open_external,
            link::open_link_window,
            link::link_window_open,
            link::close_link_window,
            lan_share::lan_share_start,
            lan_share::lan_share_attach,
            lan_share::lan_share_info,
            lan_share::lan_share_stop,
            lan_share::lan_share_fetch,
            probe::probe_start,
            probe::probe_stop,
            probe::probe_status,
            probe::probe_respond,
            probe::probe_launch_flag,
            probe::probe_binary_path,
            shutdown::request_quit,
            shutdown::confirm_close,
            update::update_installs,
            update::update_check,
            update::update_download,
            update::update_install,
            titlebar::window_title,
            window_chrome,
            smoke_report,
        ]);

    builder
        .setup(|app| {
            // built here rather than in tauri.conf.json, so the diagnostics script can be attached in development
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("VUEPort")
                .inner_size(1280.0, 860.0)
                .min_inner_size(640.0, 480.0);

            /*
             * The strip along the top of the page is the title bar. macOS keeps its real traffic lights (hover
             * symbols, option-click zoom, double-click fill) and Overlay just puts the webview under them; elsewhere
             * the frame comes off and the page draws the buttons. They are nudged down to sit centered in the page's
             * 44px .vp-titlebar strip, but macOS resets that on every title bar relayout (rename, leaving fullscreen);
             * titlebar.rs nudges them back.
             */
            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(16.0, 24.0));

            #[cfg(not(target_os = "macos"))]
            let window = window.decorations(false);

            #[cfg(windows)]
            let window = window.additional_browser_args(WEBVIEW2_ARGUMENTS);

            #[cfg(debug_assertions)]
            let window = window.initialization_script(DIAGNOSTICS);

            let window = window.fullscreen(app.state::<launch::LaunchOptions>().fullscreen);

            let window = window.build()?;

            // a --devtools build opens the inspector itself: WKWebView only keeps console history while an
            // inspector is attached, so early messages would be gone before one could be opened by hand
            #[cfg(all(not(debug_assertions), feature = "devtools"))]
            window.open_devtools();

            // macOS may leave the unbundled binary of `tauri dev` behind whatever launched it; both calls are
            // no-ops when the window is already shown and focused
            let _ = window.show();
            let _ = window.set_focus();

            // Windows opens a file by starting the application with its path
            opened::from_command_line(&app.handle().clone());

            gamepad::start(app.handle().clone(), &app.state::<gamepad::GamepadState>());

            // Command-Q never reaches ExitRequested, see hold_terminate
            #[cfg(target_os = "macos")]
            shutdown::hold_terminate(app.handle());

            #[cfg(debug_assertions)]
            link::probe_second_window(&app.handle().clone());
            Ok(())
        })
        .build(context)
        .expect("VUEPort could not start")
        .run(|app, event| {
            match event {
                // macOS opens a file by sending an event, also to an already running process
                #[cfg(target_os = "macos")]
                RunEvent::Opened { urls } => {
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            opened::receive(app, path);
                        }
                    }
                }
                // the last window closing, and app.exit from in here. Not Command-Q, which AppKit asks the
                // delegate about instead.
                RunEvent::ExitRequested { ref api, .. } => shutdown::on_exit_requested(app, api),
                // a tool must not find a probe file pointing at a port nobody listens on any more
                RunEvent::Exit => {
                    probe::on_exit(app);
                    lan_share::on_exit(app);
                }
                _ => {}
            }
        });
}
