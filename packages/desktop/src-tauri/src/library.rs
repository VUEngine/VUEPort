// the folders the library may read. The shell keeps its own record, written only by pick_library_folder (the native
// dialog), so the page can't make it read the disk at large. Everything below a chosen folder is readable, checked
// after canonicalizing so a symlink can't lead out

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

const FOLDERS: usize = 32;

// a guard, the same as the page's, so pointing this at a home directory is slow rather than unbounded
const MAX_DEPTH: usize = 8;

// so a mistaken folder can't hang the app; a full VB collection with scans and manuals is a few thousand files
const MAX_FILES: usize = 100_000;

#[derive(Serialize)]
pub struct LibraryFile {
    path: String, // relative to the folder's root, /-separated
    name: String,
    size: u64,
    modified: u64, // last modified, epoch ms, which lets a second read skip it
}

#[derive(Serialize)]
pub struct LibraryFolder {
    path: String,
    name: String,
}

// in the application's data directory, not the emulator's store: the page can write anywhere in the store, and
// only the native dialog may write this list (as in opened.rs)
fn record_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no application data directory: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("library.json"))
}

// newest first; absent or unreadable reads as none
fn chosen(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(file) = record_path(app) else {
        return Vec::new();
    };
    let Ok(contents) = fs::read_to_string(file) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&contents)
        .map(|paths| paths.into_iter().map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn write_chosen(app: &AppHandle, paths: &[PathBuf]) {
    if let Ok(file) = record_path(app) {
        let encoded = serde_json::to_string_pretty(
            &paths
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
        );
        if let Ok(encoded) = encoded {
            let _ = fs::write(file, encoded);
        }
    }
}

fn allowed(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    let candidate = fs::canonicalize(root).map_err(|error| format!("`{root}`: {error}"))?;
    if !chosen(app).iter().any(|known| known == &candidate) {
        return Err(format!("`{root}` is not a folder chosen for the library"));
    }
    Ok(candidate)
}

// a path containing .. is refused outright rather than normalized, as one that lands back inside was still
// trying to leave
fn inside(relative: &str) -> Result<&Path, String> {
    let path = Path::new(relative);
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(format!("`{relative}` is not a path inside the folder"));
        }
    }
    Ok(path)
}

// the only thing that adds to the record; None when the dialog was cancelled
#[tauri::command]
pub async fn pick_library_folder(app: AppHandle, title: String) -> Option<LibraryFolder> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title(title)
        .pick_folder()
        .await?;
    let path = fs::canonicalize(picked.path()).unwrap_or_else(|_| picked.path().to_path_buf());
    if !path.is_dir() {
        return None;
    }

    let mut paths = chosen(&app);
    paths.retain(|known| known != &path);
    paths.insert(0, path.clone());
    paths.truncate(FOLDERS);
    write_chosen(&app, &paths);

    Some(LibraryFolder {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn forget_library_folder(app: AppHandle, root: String) {
    let candidate = fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    let mut paths = chosen(&app);
    paths.retain(|known| known != &candidate);
    write_chosen(&app, &paths);
}

// the desktop equivalent of a browser asking whether its handle may still be used. An unmounted removable disk
// answers no, which the library shows rather than quietly emptying itself.
#[tauri::command]
pub fn library_folder_ready(app: AppHandle, root: String) -> bool {
    match allowed(&app, &root) {
        Ok(path) => fs::read_dir(path).is_ok(),
        Err(_) => false,
    }
}

// filtered here, not in the page, so not every file name on a collector's drive crosses the bridge
#[tauri::command]
pub fn scan_library_folder(
    app: AppHandle,
    root: String,
    subfolders: bool,
    extensions: Vec<String>,
) -> Result<Vec<LibraryFile>, String> {
    let base = allowed(&app, &root)?;
    let wanted: Vec<String> = extensions
        .iter()
        .map(|extension| extension.trim_start_matches('.').to_lowercase())
        .collect();
    let mut found = Vec::new();
    walk(&base, &base, subfolders, &wanted, 0, &mut found)?;
    Ok(found)
}

fn walk(
    base: &Path,
    directory: &Path,
    subfolders: bool,
    wanted: &[String],
    depth: usize,
    found: &mut Vec<LibraryFile>,
) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        if found.len() >= MAX_FILES {
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // dot-directories belong to version control, dot-files are editor swap files
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if subfolders && depth < MAX_DEPTH {
                walk(base, &path, subfolders, wanted, depth + 1, found)?;
            }
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let lowered = name.to_lowercase();
        if !wanted.iter().any(|extension| lowered.ends_with(&format!(".{extension}"))) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let relative = path
            .strip_prefix(base)
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        found.push(LibraryFile {
            path: relative,
            name,
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    Ok(())
}

// raw bytes rather than a JSON array of numbers (see storage_read): a 16 Mbit cartridge would be some fifty
// megabytes of text, once per ROM in a folder read
#[tauri::command]
pub fn read_library_file(app: AppHandle, root: String, path: String) -> Result<Response, String> {
    let file = library_file(&app, &root, &path)?;
    fs::read(&file)
        .map(Response::new)
        .map_err(|error| format!("could not read {path}: {error}"))
}

// takes up a file as though the system had opened it, so "beside the ROM" works for a game started from the
// library: saves, save states and cheats next to it, its build read for symbols, Recently Played. The path must
// still resolve inside a folder from the dialog's record.
#[tauri::command]
pub fn open_library_file(app: AppHandle, root: String, path: String) -> Result<String, String> {
    let file = library_file(&app, &root, &path)?;
    crate::opened::adopt(&app, file.clone());
    Ok(file.to_string_lossy().to_string())
}

fn library_file(app: &AppHandle, root: &str, path: &str) -> Result<PathBuf, String> {
    let base = allowed(app, root)?;
    let file = base.join(inside(path)?);
    let file = fs::canonicalize(&file).map_err(|error| format!("could not read {path}: {error}"))?;
    if !file.starts_with(&base) || !file.is_file() {
        return Err(format!("`{path}` is not a file inside that folder"));
    }
    Ok(file)
}
