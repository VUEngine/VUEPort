/**
 * Probe mode: tools on this computer talking to the running emulator. Off unless turned on in the settings; then the
 * shell listens on 127.0.0.1 and writes the port and a random token to ~/.vueport/probe.json (readable by the user
 * only). A tool such as `VUEPort --probe-cli` connects and sends one JSON object per line, e.g.
 * {"id":1,"token":"…","method":"registers","params":{}}, and gets {"id":1,"result":…} or {"id":1,"error":"…"}.
 *
 * The shell understands none of the methods: it checks the token, hands the request to the page as a probe://request
 * event and writes back what desktop-probe.ts answers through probe_respond. The cli method carries a whole vbprobe
 * command line, run by the page on the game or a fork of it, and this binary is its client (--probe-cli, or
 * --probe-call '<json>' for a raw request), see client_main.
 *
 * Plain TCP on purpose: a web page can only speak HTTP or WebSocket, so no site can reach this. The token keeps out
 * other programs on the same computer.
 */

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

// a save state travels as base64 and is a few dozen kilobytes; room for any of them and none for abuse
const MAX_LINE: usize = 8 * 1024 * 1024;

// long enough for a slow screenshot or a large .elf, short enough that a page that went away does not hold a
// connection for ever
const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

// a command line can run a fork for thousands of frames with every instruction watched
const COMMAND_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Serialize, Default)]
pub struct ProbeInfo {
    listening: bool,
    port: u16,
    file: String,
    clients: usize,
}

#[derive(Default)]
struct Shared {
    pending: Mutex<HashMap<u64, mpsc::Sender<String>>>,
    next: AtomicU64,
    clients: Mutex<Vec<TcpStream>>, // every open connection, so turning the mode off can close them
}

struct Server {
    port: u16,
    file: PathBuf,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct ProbeState {
    server: Mutex<Option<Server>>,
    shared: Arc<Shared>,
}

impl ProbeState {
    fn info(&self) -> ProbeInfo {
        let server = self.server.lock().unwrap();
        match server.as_ref() {
            Some(server) => ProbeInfo {
                listening: true,
                port: server.port,
                file: server.file.to_string_lossy().into_owned(),
                clients: self.shared.clients.lock().unwrap().len(),
            },
            None => ProbeInfo::default(),
        }
    }
}

// beside VUEPort's other files, in the same place on every platform, so a tool needs no table of platforms
fn probe_file(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("no home directory: {error}"))?;
    Ok(home.join(".vueport").join("probe.json"))
}

#[tauri::command]
pub fn probe_start(app: AppHandle, state: State<'_, ProbeState>) -> Result<ProbeInfo, String> {
    {
        let server = state.server.lock().unwrap();
        if server.is_some() {
            drop(server);
            return Ok(state.info());
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let token = new_token()?;
    let file = probe_file(&app)?;
    write_private(
        &file,
        &serde_json::json!({
            "port": port,
            "token": token,
            "pid": std::process::id(),
        })
        .to_string(),
    )?;

    let stop = Arc::new(AtomicBool::new(false));
    let shared = state.shared.clone();
    let accepting = stop.clone();
    let handle = app.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            if accepting.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let shared = shared.clone();
            let handle = handle.clone();
            let token = token.clone();
            let stop = accepting.clone();
            thread::spawn(move || serve(handle, shared, stream, token, stop));
        }
    });

    *state.server.lock().unwrap() = Some(Server { port, file, stop });
    Ok(state.info())
}

#[tauri::command]
pub fn probe_stop(app: AppHandle, state: State<'_, ProbeState>) -> ProbeInfo {
    stop(&app, &state);
    state.info()
}

#[tauri::command]
pub fn probe_status(state: State<'_, ProbeState>) -> ProbeInfo {
    state.info()
}

// --probe turns the mode on until quit, whatever the setting says, so a script can start a game and a tool
// connect without visiting the settings
#[tauri::command]
pub fn probe_launch_flag() -> bool {
    std::env::args().skip(1).any(|argument| argument == "--probe")
}

// for the instructions the settings pane hands to an AI agent, which runs this file with --probe-cli
#[tauri::command]
pub fn probe_binary_path() -> Option<String> {
    std::env::current_exe().ok().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn probe_respond(state: State<'_, ProbeState>, id: u64, response: String) {
    if let Some(waiting) = state.shared.pending.lock().unwrap().remove(&id) {
        let _ = waiting.send(response);
    }
}

pub fn on_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<ProbeState>() {
        stop(app, &state);
    }
}

fn stop(app: &AppHandle, state: &ProbeState) {
    let Some(server) = state.server.lock().unwrap().take() else { return };
    server.stop.store(true, Ordering::SeqCst);
    // the accepting thread is blocked in accept; one more connection wakes it to find the flag
    let _ = TcpStream::connect(("127.0.0.1", server.port));
    for client in state.shared.clients.lock().unwrap().drain(..) {
        let _ = client.shutdown(Shutdown::Both);
    }
    let _ = fs::remove_file(&server.file);
    let _ = app.emit("probe://clients", 0usize);
}

fn serve(app: AppHandle, shared: Arc<Shared>, stream: TcpStream, token: String, stop: Arc<AtomicBool>) {
    if stop.load(Ordering::SeqCst) {
        return;
    }
    let Ok(mut writer) = stream.try_clone() else { return };
    if let Ok(kept) = stream.try_clone() {
        shared.clients.lock().unwrap().push(kept);
    }
    announce(&app, &shared);

    let mut reader = BufReader::new(stream);
    while let Ok(Some(line)) = read_line(&mut reader) {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let (reply, keep) = answer(&app, &shared, &line, &token);
        if writer.write_all(reply.as_bytes()).is_err() || writer.write_all(b"\n").is_err() || !keep {
            break;
        }
    }

    let peer = writer.peer_addr().ok();
    shared
        .clients
        .lock()
        .unwrap()
        .retain(|client| client.peer_addr().ok() != peer);
    announce(&app, &shared);
}

// the reply to one request line, and whether the connection stays open; a wrong token closes it
fn answer(app: &AppHandle, shared: &Shared, line: &str, token: &str) -> (String, bool) {
    let request: Value = match serde_json::from_str(line) {
        Ok(value @ Value::Object(_)) => value,
        _ => return (error(Value::Null, "Each line has to be one JSON object."), false),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let offered = request.get("token").and_then(Value::as_str).unwrap_or("");
    if !same(offered.as_bytes(), token.as_bytes()) {
        return (error(id, "Wrong token. Read it from ~/.vueport/probe.json."), false);
    }
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return (error(id, "A request needs a method."), true);
    };

    let internal = shared.next.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = mpsc::channel();
    shared.pending.lock().unwrap().insert(internal, sender);
    let handed = app.emit_to(
        "main",
        "probe://request",
        serde_json::json!({
            "id": internal,
            "method": method,
            "params": request.get("params").cloned().unwrap_or(Value::Object(Default::default())),
        }),
    );
    if handed.is_err() {
        shared.pending.lock().unwrap().remove(&internal);
        return (error(id, "The emulator window is not there."), true);
    }

    let timeout = if method == "cli" { COMMAND_TIMEOUT } else { ANSWER_TIMEOUT };
    match receiver.recv_timeout(timeout) {
        Ok(response) => match serde_json::from_str::<Value>(&response) {
            Ok(Value::Object(mut fields)) => {
                fields.insert("id".into(), id);
                (Value::Object(fields).to_string(), true)
            }
            _ => (error(id, "The emulator answered with something that is not JSON."), true),
        },
        Err(_) => {
            shared.pending.lock().unwrap().remove(&internal);
            (error(id, "The emulator did not answer in time."), true)
        }
    }
}

fn error(id: Value, message: &str) -> String {
    serde_json::json!({ "id": id, "error": message }).to_string()
}

fn announce(app: &AppHandle, shared: &Shared) {
    let _ = app.emit("probe://clients", shared.clients.lock().unwrap().len());
}

// a line without its terminator, None at the end of the stream. Longer than MAX_LINE is an error, so a peer
// cannot make this hold its memory
fn read_line(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let read = reader.by_ref().take(MAX_LINE as u64 + 1).read_until(b'\n', &mut bytes)?;
    if read == 0 {
        return Ok(None);
    }
    if bytes.len() > MAX_LINE {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "line too long"));
    }
    while bytes.last() == Some(&b'\n') || bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "not UTF-8"))
}

// constant time, so how long an answer takes says nothing about how much of a guess was right
fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// a file only this user can read, replacing whatever was there
fn write_private(path: &PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
    file.write_all(contents.as_bytes()).map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

// the other end: this binary as a client

// a file named on the command line is read here and travels with the request; nothing a command reads is this big
const MAX_INPUT: u64 = 4 * 1024 * 1024;

// --probe-cli <command> … and --probe-call '<json>': this binary as a client of the one already running. Run
// first in main; None for every ordinary start.
pub fn client_main() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let at = args.iter().position(|arg| arg == "--probe-cli" || arg == "--probe-call")?;
    let rest = args[at + 1..].to_vec();
    #[cfg(windows)]
    attach_to_console();
    let outcome = if args[at] == "--probe-cli" { client_cli(rest) } else { client_call(rest) };
    Some(match outcome {
        Ok(code) => code,
        Err(message) => {
            eprintln!("VUEPort: {message}");
            1
        }
    })
}

// borrows the console the command was typed into: a release build is a GUI program (windows_subsystem in main.rs) with
// no console of its own, so output from cmd or PowerShell went nowhere. Only when stdout isn't piped; the shell doesn't
// wait for a GUI program, so `start /wait` or a pipe avoids a late answer
#[cfg(windows)]
pub(crate) fn attach_to_console() {
    use std::ffi::c_void;
    extern "system" {
        fn AttachConsole(process: u32) -> i32;
        fn GetStdHandle(which: u32) -> *mut c_void;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    unsafe {
        if GetStdHandle(STD_OUTPUT_HANDLE).is_null() {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

// sent with the files it names, and the files that come back written where it said
fn client_cli(args: Vec<String>) -> Result<i32, String> {
    let (args, file) = take_option(args, "--probe-file");
    let mut inputs = serde_json::Map::new();
    for arg in &args {
        let value = value_of(arg);
        let path = std::path::Path::new(&value);
        if let Ok(meta) = fs::metadata(path) {
            if meta.is_file() && meta.len() <= MAX_INPUT {
                let bytes = fs::read(path).map_err(|error| format!("{value}: {error}"))?;
                inputs.insert(value.clone(), Value::String(base64_encode(&bytes)));
            }
        }
    }
    let answer = client_request(file, "cli", serde_json::json!({ "args": args, "inputs": inputs }))?;
    if let Some(error) = answer.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    let result = answer.get("result").cloned().unwrap_or(Value::Null);
    if let Some(outputs) = result.get("outputs").and_then(Value::as_object) {
        let allowed: Vec<PathBuf> = args.iter().map(|arg| absolute(&value_of(arg))).collect();
        for (path, content) in outputs {
            let target = absolute(path);
            if !allowed.iter().any(|named| target.starts_with(named)) {
                return Err(format!("VUEPort sent back {path}, which the command line did not ask for."));
            }
            let bytes = base64_decode(content.as_str().unwrap_or_default())?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("{path}: {error}"))?;
            }
            fs::write(&target, bytes).map_err(|error| format!("{path}: {error}"))?;
        }
    }
    let text = result.get("text").and_then(Value::as_str).unwrap_or_default();
    if text.ends_with('\n') {
        print!("{text}");
    } else {
        println!("{text}");
    }
    Ok(result.get("code").and_then(Value::as_i64).unwrap_or(0) as i32)
}

// one JSON request from the argument or standard input, the answer printed as it came, for a tool that would rather
// speak the protocol
fn client_call(args: Vec<String>) -> Result<i32, String> {
    let (args, file) = take_option(args, "--probe-file");
    let text = match args.first() {
        Some(text) if text != "-" => text.clone(),
        _ => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).map_err(|error| error.to_string())?;
            text
        }
    };
    let request: Value = serde_json::from_str(&text).map_err(|error| format!("That is not JSON: {error}"))?;
    let method = request.get("method").and_then(Value::as_str).ok_or("A request needs a method.")?;
    let params = request.get("params").cloned().unwrap_or(Value::Object(Default::default()));
    let answer = client_request(file, method, params)?;
    println!("{answer}");
    Ok(if answer.get("error").is_some() { 1 } else { 0 })
}

fn client_request(file: Option<String>, method: &str, params: Value) -> Result<Value, String> {
    let file = file
        .or_else(|| std::env::var("VUEPORT_PROBE").ok())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".vueport").join("probe.json")))
        .ok_or("There is no home directory to find probe.json in.")?;
    let info: Value = fs::read_to_string(&file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| format!(
            "No {}: VUEPort is not running, or does not let tools connect. Start it with --probe, or turn on Settings → Tools → Let tools connect.",
            file.display()
        ))?;
    let port = info.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
    let token = info.get("token").and_then(Value::as_str).unwrap_or_default();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|_| format!(
        "Nothing answers on port {port}. {} is left over from a VUEPort that no longer lets tools connect.",
        file.display()
    ))?;
    let request = serde_json::json!({ "id": 1, "token": token, "method": method, "params": params });
    stream
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|error| error.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|error| error.to_string())?;
    serde_json::from_str(line.trim_end()).map_err(|_| "VUEPort answered with something that is not JSON.".to_string())
}

// --opt=value is its value, 600:shot.png its file
fn value_of(arg: &str) -> String {
    if arg.starts_with("--") {
        if let Some((_, value)) = arg.split_once('=') {
            return value.to_string();
        }
    }
    if let Some((frame, file)) = arg.split_once(':') {
        if !frame.is_empty() && frame.chars().all(|c| c.is_ascii_digit()) {
            return file.to_string();
        }
    }
    arg.to_string()
}

// takes --name value out of a command line, which is this end's own business
fn take_option(args: Vec<String>, name: &str) -> (Vec<String>, Option<String>) {
    let mut out = Vec::new();
    let mut value = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == name {
            value = iter.next();
        } else if let Some(inline) = arg.strip_prefix(&format!("{name}=")) {
            value = Some(inline.to_string());
        } else {
            out.push(arg);
        }
    }
    (out, value)
}

// . and .. worked out by hand, as what it names need not exist yet
fn absolute(path: &str) -> PathBuf {
    let joined = std::env::current_dir().unwrap_or_default().join(path);
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_are_found_in_options_and_frame_shots() {
        assert_eq!(value_of("--state-in=a.vess"), "a.vess");
        assert_eq!(value_of("600:shot.png"), "shot.png");
        assert_eq!(value_of("Actor::update"), "Actor::update");
        assert_eq!(value_of("0x05000010:4"), "0x05000010:4");
    }

    #[test]
    fn the_probe_file_option_is_taken_out() {
        let args = vec!["peek".to_string(), "--probe-file".to_string(), "x.json".to_string(), "0x0".to_string()];
        let (rest, file) = take_option(args, "--probe-file");
        assert_eq!(rest, vec!["peek".to_string(), "0x0".to_string()]);
        assert_eq!(file.as_deref(), Some("x.json"));
    }

    #[test]
    fn paths_are_worked_out_without_touching_the_disk() {
        let here = std::env::current_dir().unwrap();
        assert_eq!(absolute("a/./b/../c"), here.join("a").join("c"));
    }

    #[test]
    fn tokens_compare_by_content() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"abcd"));
    }

    #[test]
    fn a_token_is_64_hex_digits() {
        let token = new_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(token, new_token().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("probe.json");
        write_private(&path, "{}").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
