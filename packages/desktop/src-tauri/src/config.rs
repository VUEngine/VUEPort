// persistent preferences: the web frontend expects synchronous localStorage, so the desktop host keeps that
// as a runtime cache, but this JSON file is its durable source, updated value by value through these commands

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct ConfigState(Mutex<()>);

type Config = BTreeMap<String, Value>;

fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::storage::root(app)?.join("config.json"))
}

fn read(app: &AppHandle) -> Result<Option<Config>, String> {
    let path = path(app)?;
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read config.json: {error}")),
    };
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("could not parse config.json: {error}"))
}

fn write(app: &AppHandle, config: &Config) -> Result<(), String> {
    let path = path(app)?;
    let contents = serde_json::to_string_pretty(config)
        .map_err(|error| format!("could not encode config.json: {error}"))?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("could not open config.json: {error}"))?;
    file.write_all(contents.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| format!("could not write config.json: {error}"))?;
    #[cfg(unix)]
    fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .map_err(|error| format!("could not protect config.json: {error}"))?;
    Ok(())
}

fn valid_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.contains(['\n', '\r']) {
        Err("invalid configuration key".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn config_read(
    app: AppHandle,
    state: State<'_, ConfigState>,
) -> Result<Option<Config>, String> {
    let _guard = state.0.lock().map_err(|_| "configuration lock failed")?;
    read(&app)
}

#[tauri::command]
pub fn config_write(
    app: AppHandle,
    state: State<'_, ConfigState>,
    config: Config,
) -> Result<(), String> {
    for key in config.keys() {
        valid_key(key)?;
    }
    let _guard = state.0.lock().map_err(|_| "configuration lock failed")?;
    write(&app, &config)
}

#[tauri::command]
pub fn config_set(
    app: AppHandle,
    state: State<'_, ConfigState>,
    key: String,
    value: Value,
) -> Result<(), String> {
    valid_key(&key)?;
    let _guard = state.0.lock().map_err(|_| "configuration lock failed")?;
    let mut config = read(&app)?.unwrap_or_default();
    config.insert(key, value);
    write(&app, &config)
}

#[tauri::command]
pub fn config_remove(
    app: AppHandle,
    state: State<'_, ConfigState>,
    key: String,
) -> Result<(), String> {
    valid_key(&key)?;
    let _guard = state.0.lock().map_err(|_| "configuration lock failed")?;
    let mut config = read(&app)?.unwrap_or_default();
    config.remove(&key);
    write(&app, &config)
}
