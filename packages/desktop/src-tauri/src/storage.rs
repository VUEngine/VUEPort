// files on disk for the emulator's VueportStorage: real files in one visible application folder instead of the web
// build's OPFS. Every path the emulator uses is relative (roms/Red Alarm/save.sram), resolved under one root here,
// and may not escape it.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
pub struct StoredFile {
    name: String,
    path: String,
    size: u64,
}

pub(crate) fn root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    let directory = app
        .path()
        .home_dir()
        .map_err(|error| format!("no home directory: {error}"))?
        .join(".vueport");

    #[cfg(not(target_os = "macos"))]
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no application data directory: {error}"))?;

    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

// checking /Games as a file checked /, which no ROM was opened from, and left the ESSound tracks beside a ROM
// unfindable
enum Absolute {
    File, // allowed by the folder it sits in
    Directory, // allowed by being that folder
}

/**
 * Resolves a path from the emulator to where it may write. A relative path stays inside the store: it is built from a
 * ROM's file name, so `..` must not reach the parent. An absolute path is a ROM's companion file kept beside it
 * (companionFiles setting), allowed only in a folder the system itself opened a file from, see
 * OpenedFiles::may_keep_companions_in.
 */
fn resolve_as(app: &AppHandle, path: &str, kind: Absolute) -> Result<PathBuf, String> {
    let candidate = Path::new(path);

    if candidate.is_absolute() {
        let directory = guarding_folder(candidate, kind)?;
        let opened: State<'_, crate::opened::OpenedFiles> = app.state();
        if !opened.may_keep_companions_in(directory) {
            return Err(format!(
                "`{path}` is not beside a ROM this application opened"
            ));
        }
        return Ok(candidate.to_path_buf());
    }

    Ok(root(app)?.join(inside_store(candidate)?))
}

// a path containing .. is refused outright rather than normalized, as one that lands in an allowed folder was
// still trying to leave
fn guarding_folder(candidate: &Path, kind: Absolute) -> Result<&Path, String> {
    if candidate.components().any(|c| !matches!(c,
        Component::Normal(_) | Component::RootDir | Component::Prefix(_)))
    {
        return Err(format!("`{}` is not a plain path", candidate.display()));
    }
    match kind {
        Absolute::File => candidate
            .parent()
            .ok_or_else(|| format!("`{}` has no folder to check", candidate.display())),
        Absolute::Directory => Ok(candidate),
    }
}

fn inside_store(candidate: &Path) -> Result<&Path, String> {
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(format!(
                    "`{}` is not a path inside the store",
                    candidate.display()
                ))
            }
        }
    }
    Ok(candidate)
}

// roms/Red Alarm/save.sram, or a file beside a ROM
fn resolve(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    resolve_as(app, path, Absolute::File)
}

// the store's own, or the one a ROM was opened from
fn resolve_directory(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    resolve_as(app, path, Absolute::Directory)
}

// raw bytes: Tauri's default JSON array of numbers turns five megabytes of ESSound track into some twenty-five of
// JSON in the middle of a game. A Response arrives as an ArrayBuffer.
#[tauri::command]
pub fn storage_read(app: AppHandle, path: String) -> Result<Response, String> {
    fs::read(resolve(&app, &path)?)
        .map(Response::new)
        .map_err(|error| format!("could not read {path}: {error}"))
}

// raw request body, as for storage_read: a Uint8Array argument becomes a JSON array of numbers, which made a
// 16 MB cartridge some fifty megabytes of text and most of the pause before a large ROM played. The path goes in a
// header, ASCII only, so it arrives percent-encoded.
#[tauri::command]
pub fn storage_write(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("storage_write expects the file's bytes as the request body".to_string());
    };
    let path = header(&request, PATH_HEADER)?;
    let target = resolve(&app, &path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, data).map_err(|error| format!("could not write {path}: {error}"))
}

pub(crate) const PATH_HEADER: &str = "x-vueport-path";

pub(crate) fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("`{name}` is missing"))?
        .to_str()
        .map_err(|_| format!("`{name}` is not text"))?;
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|error| format!("`{name}` is not a path: {error}"))
}

#[tauri::command]
pub fn storage_exists(app: AppHandle, path: String) -> Result<bool, String> {
    Ok(resolve(&app, &path)?.exists())
}

#[tauri::command]
pub fn storage_delete(app: AppHandle, path: String) -> Result<(), String> {
    let target = resolve(&app, &path)?;
    if !target.exists() {
        // deleting what is not there is what the caller wanted anyway
        return Ok(());
    }
    let result = if target.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    result.map_err(|error| format!("could not delete {path}: {error}"))
}

// nothing at all when there is no such directory
#[tauri::command]
pub fn storage_list(app: AppHandle, directory: String) -> Result<Vec<StoredFile>, String> {
    let target = resolve_directory(&app, &directory)?;
    let entries = match fs::read_dir(&target) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        files.push(StoredFile {
            path: if directory.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", directory.trim_end_matches('/'), name)
            },
            name,
            size: metadata.len(),
        });
    }
    Ok(files)
}

#[derive(Serialize, Default)]
pub struct StoredUsage {
    bytes: u64,
    files: u64,
}

// nothing at all when there is no such directory
#[tauri::command]
pub fn storage_measure(app: AppHandle, directory: String) -> Result<StoredUsage, String> {
    fn walk(directory: &Path, usage: &mut StoredUsage) {
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            // DirEntry::metadata does not follow links, so a link to a directory elsewhere is not walked or counted
            match entry.metadata() {
                Ok(metadata) if metadata.is_dir() => walk(&entry.path(), usage),
                Ok(metadata) if metadata.is_file() => {
                    usage.bytes += metadata.len();
                    usage.files += 1;
                }
                _ => {}
            }
        }
    }
    let mut usage = StoredUsage::default();
    walk(&resolve_directory(&app, &directory)?, &mut usage);
    Ok(usage)
}

pub(crate) const NAME_HEADER: &str = "x-vueport-name";

// hands a finished file (screenshot, profile, video) to the user in the downloads folder, reduced to its last segment
// so a caller can't pick the directory. Raw body like storage_write, as a video is tens of megabytes
#[tauri::command]
pub fn storage_export(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("storage_export expects the file's bytes as the request body".to_string());
    };
    let name = header(&request, NAME_HEADER)?;
    let file_name = Path::new(&name)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| format!("`{name}` is not a file name"))?;

    let directory = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|error| format!("nowhere to export to: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let target = directory.join(&file_name);
    fs::write(&target, data).map_err(|error| format!("could not export {file_name}: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn storage_root(app: AppHandle) -> Result<String, String> {
    Ok(root(&app)?.to_string_lossy().to_string())
}

// takes no path on purpose, so the page cannot have some other folder or a file opened instead
#[tauri::command]
pub fn storage_reveal(app: AppHandle) -> Result<(), String> {
    let directory = root(&app)?;
    tauri_plugin_opener::open_path(&directory, None::<&str>)
        .map_err(|error| format!("{} could not be opened: {error}", directory.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // a folder was checked as though it were a file, so the one above the ROM's had to have been opened, and listing
    // the ROM's own folder (for its ESSound tracks) was refused for every ROM
    #[test]
    fn a_folder_is_guarded_by_itself_and_a_file_by_its_folder() {
        let rom = Path::new("/Games/Red Alarm.vb");
        assert_eq!(
            guarding_folder(rom, Absolute::File).unwrap(),
            Path::new("/Games")
        );
        assert_eq!(
            guarding_folder(Path::new("/Games"), Absolute::Directory).unwrap(),
            Path::new("/Games")
        );
    }

    #[test]
    fn a_path_that_tries_to_leave_is_refused_rather_than_normalized() {
        // even though this normalizes to /Games/rom.vb, which is allowed
        assert!(guarding_folder(Path::new("/Games/../Games/rom.vb"), Absolute::File).is_err());
        assert!(guarding_folder(Path::new("/Games/.."), Absolute::Directory).is_err());
    }

    #[test]
    fn a_store_path_may_not_climb_out_of_the_store() {
        assert_eq!(
            inside_store(Path::new("roms/Red Alarm/save.sram")).unwrap(),
            Path::new("roms/Red Alarm/save.sram")
        );
        assert!(inside_store(Path::new("../elsewhere")).is_err());
        assert!(inside_store(Path::new("roms/../../elsewhere")).is_err());
    }
}
