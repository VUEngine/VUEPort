// ROMs opened from the desktop: double-clicked (Windows passes the path to a fresh process, macOS sends an Apple Event,
// maybe to a running one) or dropped on the icon or window. The page only ever reads files the system handed over

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::Response;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, Window, WindowEvent};

#[derive(Default)]
pub struct OpenedFiles {
    pending: Mutex<Vec<PathBuf>>,
    allowed: Mutex<HashSet<PathBuf>>, // every path the system opened with us, and so may be read
    // folders those files came from, which may hold their saves, save states and cheats outside the store
    companions: Mutex<HashSet<PathBuf>>,
    dragging: Mutex<bool>,
}

impl OpenedFiles {
    fn remember(&self, path: PathBuf) {
        self.allow(path.clone());
        self.pending.lock().unwrap().push(path);
    }

    // for re-opening from the start page: the page may read the file and keep things beside it without starting it
    fn allow(&self, path: PathBuf) {
        if let Some(parent) = path.parent() {
            self.companions.lock().unwrap().insert(parent.to_path_buf());
        }
        self.allowed.lock().unwrap().insert(path);
    }

    pub fn may_keep_companions_in(&self, directory: &Path) -> bool {
        self.companions.lock().unwrap().contains(directory)
    }
}

// at least as many as the start page can show: Recently Played keeps no copy of a ROM whose own file it can read
// again (see web-recent-origins.ts), so a path dropped here can no longer be started. A little more than
// MAX_MAX_RECENT in web-recent-limit.ts.
const REMEMBERED: usize = 512;

// deliberately not in the emulator's store: the page can write anywhere inside it (storage_write), and only the
// system's own file-opening may write this list
fn remembered_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no application data directory: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("opened.json"))
}

fn remembered(app: &AppHandle) -> Vec<PathBuf> {
    remembered_path(app).map(|file| read_remembered(&file)).unwrap_or_default()
}

fn remember_across_runs(app: &AppHandle, path: &Path) {
    if let Ok(file) = remembered_path(app) {
        // best effort: a ROM that cannot be written down still plays, only re-opening it from the start page suffers
        write_remembered(&file, path);
    }
}

// absent or unreadable reads as empty: nothing here is worth refusing to open a ROM over
fn read_remembered(file: &Path) -> Vec<PathBuf> {
    let Ok(contents) = fs::read_to_string(file) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&contents)
        .map(|paths| paths.into_iter().map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn write_remembered(file: &Path, path: &Path) {
    let mut paths = read_remembered(file);
    paths.retain(|known| known != path);
    paths.insert(0, path.to_path_buf());
    paths.truncate(REMEMBERED);
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

// called for the command line at start-up and for later events; a page that has not loaded yet finds the file
// waiting in opened_files
pub fn receive(app: &AppHandle, path: PathBuf) {
    if !path.is_file() {
        return;
    }
    // canonical, so the store's guard compares the same spelling of a folder the page later hands back
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let state: State<'_, OpenedFiles> = app.state();
    state.remember(path.clone());
    // written down too, so starting it from the start page in a later run still finds its save, ESSound tracks and
    // build beside it
    remember_across_runs(app, &path);
    let _ = app.emit("files://opened", path.to_string_lossy().to_string());
}

// the shell handles drops because with a drag and drop handler installed (needed for a drop to reach the
// application at all) the webview never sees an HTML drop event. A drop then takes a double-clicked ROM's path,
// so archives work and non-ROMs are reported the same way.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::DragDrop(drag) = event else {
        return;
    };
    let app = window.app_handle();

    match drag {
        // Over arrives with every mouse movement, so the page is told only when the answer changes
        DragDropEvent::Enter { .. } | DragDropEvent::Over { .. } => dragging(app, true),
        DragDropEvent::Leave => dragging(app, false),
        DragDropEvent::Drop { paths, .. } => {
            dragging(app, false);
            // one ROM, not one per file, or several would start in turn. A directory is passed over rather than
            // refused, so dropping a folder with a ROM beside it still opens the ROM.
            if let Some(path) = paths.iter().find(|path| path.is_file()) {
                receive(app, path.clone());
            }
        }
        _ => {}
    }
}

fn dragging(app: &AppHandle, over: bool) {
    let state: State<'_, OpenedFiles> = app.state();
    let mut current = state.dragging.lock().unwrap();
    if *current == over {
        return;
    }
    *current = over;
    let _ = app.emit("files://dragging", over);
}

// unknown arguments that aren't existing files are ignored, as packaged apps get all sorts
pub fn from_command_line(app: &AppHandle) {
    for argument in std::env::args().skip(1) {
        if argument.starts_with('-') {
            continue;
        }
        let path = PathBuf::from(&argument);
        if path.is_file() {
            receive(app, path);
        }
    }
}

// a native panel because the page's file input withholds where the file came from, and without that there is no
// "beside the ROM". The choice goes through receive like a double-clicked ROM; returns whether anything was
// chosen, the file arrives as an event.
#[tauri::command]
pub async fn pick_rom(app: AppHandle, title: String, filter: String) -> bool {
    let extensions: Vec<&str> = filter.split(',').map(|e| e.trim_start_matches('.')).collect();
    let chosen = rfd::AsyncFileDialog::new()
        .set_title(title)
        .add_filter("Virtual Boy", &extensions)
        .pick_file()
        .await;
    match chosen {
        Some(file) => {
            receive(&app, file.path().to_path_buf());
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn opened_files(state: State<'_, OpenedFiles>) -> Vec<String> {
    let mut pending = state.pending.lock().unwrap();
    pending
        .drain(..)
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

// opened_files empties as it answers, as a ROM must start once, not once per asker. This standing list lets the
// development diagnostics check later that a ROM's own folder is reachable (see diagnostics.js).
#[tauri::command]
pub fn opened_paths(state: State<'_, OpenedFiles>) -> Vec<String> {
    let allowed = state.allowed.lock().unwrap();
    allowed
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

// only a path the system itself handed over, so this cannot become a way to read the disk
#[tauri::command]
pub fn read_opened_file(
    state: State<'_, OpenedFiles>,
    path: String,
) -> Result<Response, String> {
    let candidate = Path::new(&path).to_path_buf();
    if !state.allowed.lock().unwrap().contains(&candidate) {
        return Err(format!("`{path}` was not opened with this application."));
    }
    // raw bytes: a 128 Mbit cartridge as Tauri's default JSON array of numbers would be some fifty megabytes of text
    // to parse before the game can start
    fs::read(&candidate)
        .map(Response::new)
        .map_err(|error| format!("could not read {path}: {error}"))
}

// takes up a ROM opened in an earlier run without opening it, so a game restarted from the start page finds its save,
// ESSound tracks and build again. Yes only if the shell's record has the path and it still exists; a no just means the
// start page plays its own copy
#[tauri::command]
pub fn reopen_file(app: AppHandle, state: State<'_, OpenedFiles>, path: String) -> bool {
    let candidate = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    if !candidate.is_file() || !remembered(&app).contains(&candidate) {
        return false;
    }
    state.allow(candidate);
    true
}

// takes up a file the library found the way reopen_file does, and writes it down for next time. Only for
// library::open_library_file, which has already checked the path lies inside a folder the dialog chose.
pub(crate) fn adopt(app: &AppHandle, path: PathBuf) {
    let state: State<'_, OpenedFiles> = app.state();
    state.allow(path.clone());
    remember_across_runs(app, &path);
}

// reads a file the ROM's build declared, like its .elf (symbols for profiler, memory pools, actor inspector).
// VUEngine's .map names it relative to the project root, a folder up from build/output.vb and out of storage_read's
// reach. Only for a ROM we were handed, inside its folder or parent after canonicalizing
#[tauri::command]
pub fn read_rom_build_file(
    state: State<'_, OpenedFiles>,
    rom: String,
    relative: String,
) -> Result<Response, String> {
    let rom_path = PathBuf::from(&rom);
    if !state.allowed.lock().unwrap().contains(&rom_path) {
        return Err(format!("`{rom}` was not opened with this application."));
    }
    let file = build_file_near(&rom_path, &relative)?;
    fs::read(&file)
        .map(Response::new)
        .map_err(|error| format!("could not read {relative}: {error}"))
}

// the ROM's own folder, then its parent, which is the project root for build/output.vb. Both canonicalized, so
// a symlink inside either cannot lead out.
fn build_file_near(rom: &Path, relative: &str) -> Result<PathBuf, String> {
    // no .., no root, no drive letter: the map declares a path below the build folder, anything else is refused
    // rather than normalized
    if Path::new(relative)
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("`{relative}` is not a plain relative path"));
    }
    let directory = rom
        .parent()
        .ok_or_else(|| format!("`{}` has no folder", rom.display()))?;

    for base in [directory.to_path_buf(), directory.join("..")] {
        let Ok(base) = fs::canonicalize(&base) else {
            continue;
        };
        let Ok(candidate) = fs::canonicalize(base.join(relative)) else {
            continue;
        };
        if candidate.starts_with(&base) && candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!("`{relative}` is not beside `{}`", rom.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // lets a ROM played before be played from where it lives again, rather than from the start page's copy
    #[test]
    fn what_the_system_opened_is_remembered_between_runs() {
        let directory = tempfile::TempDir::new().unwrap();
        let file = directory.path().join("opened.json");
        assert!(read_remembered(&file).is_empty(), "nothing has been opened yet");

        write_remembered(&file, Path::new("/Games/one.vb"));
        write_remembered(&file, Path::new("/Games/two.vb"));
        assert_eq!(
            read_remembered(&file),
            vec![PathBuf::from("/Games/two.vb"), PathBuf::from("/Games/one.vb")],
            "newest first"
        );

        write_remembered(&file, Path::new("/Games/one.vb"));
        assert_eq!(
            read_remembered(&file),
            vec![PathBuf::from("/Games/one.vb"), PathBuf::from("/Games/two.vb")]
        );
    }

    #[test]
    fn the_record_does_not_grow_without_end() {
        let directory = tempfile::TempDir::new().unwrap();
        let file = directory.path().join("opened.json");
        for index in 0..(REMEMBERED + 10) {
            write_remembered(&file, &PathBuf::from(format!("/Games/{index}.vb")));
        }
        let remembered = read_remembered(&file);
        assert_eq!(remembered.len(), REMEMBERED);
        assert_eq!(remembered[0], PathBuf::from(format!("/Games/{}.vb", REMEMBERED + 9)));
        // the oldest have fallen off, so re-opening one is refused and the start page plays its own copy
        assert!(!remembered.contains(&PathBuf::from("/Games/0.vb")));
    }

    // a project as a VUEngine build leaves one: ROM and map in build, the image a folder further in, and a file
    // outside the project to try to reach
    fn project() -> tempfile::TempDir {
        let root = tempfile::TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("project/build/working")).unwrap();
        fs::write(root.path().join("project/build/output.vb"), b"rom").unwrap();
        fs::write(root.path().join("project/build/output.map"), b"OUTPUT(x)").unwrap();
        fs::write(
            root.path().join("project/build/working/output-beta.elf"),
            b"elf",
        )
        .unwrap();
        fs::write(root.path().join("secret"), b"secret").unwrap();
        root
    }

    #[test]
    fn a_file_beside_the_rom_is_found() {
        let root = project();
        let rom = root.path().join("project/build/output.vb");
        let found = build_file_near(&rom, "output.map").unwrap();
        assert_eq!(fs::read(found).unwrap(), b"OUTPUT(x)");
    }

    // the .map declares a path relative to the project root, not the ROM's folder
    #[test]
    fn a_file_the_map_declares_from_the_project_root_is_found() {
        let root = project();
        let rom = root.path().join("project/build/output.vb");
        let found = build_file_near(&rom, "build/working/output-beta.elf").unwrap();
        assert_eq!(fs::read(found).unwrap(), b"elf");
    }

    #[test]
    fn nothing_outside_those_two_folders_is_reachable() {
        let root = project();
        let rom = root.path().join("project/build/output.vb");
        assert!(build_file_near(&rom, "../../secret").is_err());
        assert!(build_file_near(&rom, "/etc/hosts").is_err());
        assert!(build_file_near(&rom, "build/working/output-release.elf").is_err());
    }

    // canonicalizing is what makes the check hold, or a link inside an allowed folder would be read as its target
    #[cfg(unix)]
    #[test]
    fn a_symlink_may_not_lead_out_of_them() {
        let root = project();
        let rom = root.path().join("project/build/output.vb");
        std::os::unix::fs::symlink(
            root.path().join("secret"),
            root.path().join("project/build/escape.elf"),
        )
        .unwrap();
        assert!(build_file_near(&rom, "escape.elf").is_err());
    }
}
