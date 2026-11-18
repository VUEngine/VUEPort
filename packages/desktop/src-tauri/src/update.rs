/**
 * Replaces the app with a newer one, or, in a build that may not, only says that there is one. The page asks the shell
 * rather than the updater plugin, as desktop-bridge.ts stays free of @tauri-apps packages so the same bundle runs in a
 * browser. plugins.updater.endpoints in tauri.conf.json points at latest.json on the GitHub release marked latest, and
 * plugins.updater.pubkey decides what is accepted: every update is signed, and a build without a key installs nothing
 * (key pair in README.md). Windows updates through its NSIS installer and macOS swaps the .app; on Linux only an
 * AppImage can update (a .deb or .rpm belongs to the package manager).
 *
 * Installing also needs a build that was code signed, which bundle.mjs says through VUEPORT_SELF_UPDATE at compile
 * time. Every other copy still checks, reading latest.json itself, and hands back the release page to download from
 * by hand (Release::page). A copy that installs falls back to that as well when the release has no archive for its
 * platform.
 */

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

// an update fetched and waiting: a download may happen during play, replacing the app may not. Held in memory (tens of
// megabytes) so pressing the button later needn't download it again
#[derive(Default)]
pub struct Downloaded(Mutex<Option<(Update, Vec<u8>)>>);

// set by bundle.mjs only when this platform's build was code signed and an update key signed its archives. Read at
// compile time, so a build cannot be talked into installing later
const SELF_UPDATE: bool = option_env!("VUEPORT_SELF_UPDATE").is_some();

// where a copy that does not install sends people when the manifest names no page of its own
const RELEASES_PAGE: &str = "https://github.com/VUEngine/VUEPort/releases/latest";

fn updater_config(app: &AppHandle) -> Option<&serde_json::Value> {
    app.config().plugins.0.get("updater")
}

// worth its own answer instead of a signature error from deep in the verifier: no key only happens while
// developing, a mismatched key means a release worth stopping
fn has_public_key(app: &AppHandle) -> bool {
    updater_config(app)
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

// an AppImage is told its own path by its runtime; a .deb or .rpm copy has no file the updater could replace
fn replaceable() -> bool {
    !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()
}

fn installs(app: &AppHandle) -> bool {
    SELF_UPDATE && has_public_key(app) && replaceable()
}

const NO_INSTALL: &str = "This build cannot install updates itself.";

#[derive(Clone, Serialize)]
pub struct Release {
    version: String,
    date: Option<String>,
    notes: Option<String>,
    // set when this copy does not install: the page to download the release from by hand
    page: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>, // the server need not say, so the progress bar must cope with an unknown end
}

// the parts of latest.json a copy that does not install needs; `page` is VUEPort's own (scripts/latest-json.mjs), the
// plugin ignores it
#[derive(Deserialize)]
struct Manifest {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    page: Option<String>,
}

// the plugin's check without its platform and signature: the manifest's version against this build's
async fn announced(app: &AppHandle) -> Result<Option<Release>, String> {
    let endpoint = updater_config(app)
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.get(0))
        .and_then(|endpoint| endpoint.as_str())
        .ok_or("This build has no update endpoint.")?
        .to_string();

    // the plugin's TLS backend comes without a crypto provider, and installs one only on its own first check
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    let manifest: Manifest = reqwest::Client::builder()
        .user_agent(concat!("VUEPort/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .get(&endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;

    let offered = semver::Version::parse(manifest.version.trim_start_matches('v'))
        .map_err(|error| format!("The release calls itself {}: {error}", manifest.version))?;
    if offered <= app.package_info().version {
        return Ok(None);
    }

    Ok(Some(Release {
        version: offered.to_string(),
        date: manifest.pub_date,
        notes: manifest.notes.filter(|notes| !notes.trim().is_empty()),
        page: Some(manifest.page.unwrap_or_else(|| RELEASES_PAGE.to_string())),
    }))
}

// whether a found update can be installed from here, asked before any check so the page can leave out what only
// installing copies have (downloading automatically)
#[tauri::command]
pub fn update_installs(app: AppHandle) -> bool {
    installs(&app)
}

// None is the ordinary answer (this build is the newest). Err is an unreachable endpoint or an unreadable manifest:
// worth showing when the user asked by hand, swallowed otherwise
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<Release>, String> {
    if !installs(&app) {
        return announced(&app).await;
    }

    let found = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await;

    match found {
        Ok(found) => Ok(found.map(|update| Release {
            version: update.version.clone(),
            date: update.date.map(|date| date.to_string()),
            notes: update.body.clone(),
            page: None,
        })),
        // a release built without an archive for this platform still exists and can be downloaded by hand
        Err(tauri_plugin_updater::Error::TargetNotFound(_)) => announced(&app).await,
        Err(error) => Err(error.to_string()),
    }
}

async fn newest(app: &AppHandle) -> Result<Update, String> {
    if !installs(app) {
        return Err(NO_INSTALL.into());
    }
    app.updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "There is no newer release to install.".to_string())
}

// for the automatic download and for the button before installing. Progress goes out as update://progress; the
// reply is the release actually fetched, which need not be the one a check an hour ago reported.
#[tauri::command]
pub async fn update_download(app: AppHandle) -> Result<Release, String> {
    let update = newest(&app).await?;

    let downloading = app.clone();
    let mut downloaded: u64 = 0;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = downloading.emit("update://progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;

    let release = Release {
        version: update.version.clone(),
        date: update.date.map(|date| date.to_string()),
        notes: update.body.clone(),
        page: None,
    };
    *app.state::<Downloaded>().0.lock().unwrap() = Some((update, bytes));
    Ok(release)
}

// fetches, installs and starts the newest release, checked again rather than reusing update_check's answer as a window
// can sit open for days. Restarting goes through the quit handshake (shutdown.rs), so the page writes cart RAM first
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    if !installs(&app) {
        return Err(NO_INSTALL.into());
    }

    // whatever the automatic download fetched, taken out rather than borrowed: a failed install should fetch the
    // bytes again next time, not retry the same ones
    let held = app.state::<Downloaded>().0.lock().unwrap().take();
    let (update, bytes) = match held {
        Some(held) => held,
        None => {
            let update = newest(&app).await?;
            let downloading = app.clone();
            let mut downloaded: u64 = 0;
            let bytes = update
                .download(
                    move |chunk, total| {
                        downloaded += chunk as u64;
                        let _ = downloading.emit("update://progress", Progress { downloaded, total });
                    },
                    || {},
                )
                .await
                .map_err(|error| error.to_string())?;
            (update, bytes)
        }
    };

    // the installer follows, which on some platforms takes a noticeable while and cannot report itself
    let _ = app.emit("update://installing", ());
    update.install(bytes).map_err(|error| error.to_string())?;

    crate::shutdown::restart_when_saved(&app);
    Ok(())
}
