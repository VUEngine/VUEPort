/**
 * Shares the running game with a headset in the same network, for when this computer cannot drive one itself (macOS,
 * a PC without an XR runtime). The page hands over the ROM as it runs (patches applied), optionally a save state and
 * its picture; this serves them over plain http on every private IPv4 address, under a random token, until the share
 * is stopped. VUEPort Web in the headset's browser fetches them: an https page may fetch from a private IP literal
 * over http behind Chrome's Local Network Access prompt (checked on a Quest 3). The page tells api.vueport.net where
 * the share is (core's emulator-lan-share.ts); this module knows nothing of that.
 *
 *   GET /<token>/                the share's contents, as JSON
 *   GET /<token>/rom/<name>      the ROM; the name only makes the address end in it, as ?rom= takes the name from there
 *   GET /<token>/state           the save state, 404 without one
 *   GET /<token>/thumbnail.png   its picture, 404 without one
 *   GET /                        a redirect to VUEPort Web with ?rom= (and &state=) for this share, so typing
 *                                "<address>:<port>" into a headset's browser is enough without the list
 *
 * Anything else is 404; without the token there is nothing to find but the redirect, which only ever names this
 * share. lan_share_fetch is the other end, for a desktop playing another desktop's share.
 */

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

// the same port every time where it is free, so an address typed into a headset once keeps working
const PREFERRED_PORT: u16 = 47913;

// where the redirect sends a headset; the page can say otherwise (a development build), see lan_share_start
const DEFAULT_WEB: &str = "https://play.vueport.net/";

const MAX_HEAD: usize = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
// a 16 MB ROM over a slow Wi-Fi
const WRITE_TIMEOUT: Duration = Duration::from_secs(120);

const NAME_HEADER: &str = "x-vueport-name";
const KIND_HEADER: &str = "x-vueport-kind";
const WEB_HEADER: &str = "x-vueport-web";

struct Shared {
    token: String,
    name: String,
    web: String,
    rom: Arc<Vec<u8>>,
    state: Option<Arc<Vec<u8>>>,
    thumbnail: Option<Arc<Vec<u8>>>,
}

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct LanShareState {
    shared: Arc<Mutex<Option<Shared>>>,
    server: Mutex<Option<Server>>,
}

#[derive(Serialize)]
pub struct LanShareInfo {
    token: String,
    port: u16,
    addresses: Vec<String>,
    device: String,
}

// this computer's private IPv4 addresses, those a headset in the same network may reach. A VPN's are among them
// and simply do not answer; the page tries them all at once
fn private_addresses() -> Vec<Ipv4Addr> {
    let mut found: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|interface| !interface.is_loopback())
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(address) if address.is_private() => Some(address),
            _ => None,
        })
        .collect();
    // home networks first, then the rest; the order is only what the list shows
    found.sort_by_key(|address| (address.octets()[0] != 192, *address));
    found.dedup();
    found
}

fn device_name() -> String {
    #[cfg(target_os = "macos")]
    let name = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok());
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let name = std::fs::read_to_string("/etc/hostname").ok();

    let name: String = name
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect();
    if name.is_empty() {
        "VUEPort".into()
    } else {
        name
    }
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 12];
    getrandom::getrandom(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn info(state: &LanShareState) -> Option<LanShareInfo> {
    let port = state.server.lock().unwrap().as_ref()?.port;
    let token = state.shared.lock().unwrap().as_ref()?.token.clone();
    Some(LanShareInfo {
        token,
        port,
        addresses: private_addresses().iter().map(|address| format!("{address}:{port}")).collect(),
        device: device_name(),
    })
}

// the ROM comes as the body, its file name percent-encoded in a header (see storage_write). A new token each time, so a
// headset still holding the last share's address doesn't get this game; starts listening on first use
#[tauri::command]
pub fn lan_share_start(state: State<'_, LanShareState>, request: Request<'_>) -> Result<LanShareInfo, String> {
    let InvokeBody::Raw(rom) = request.body() else {
        return Err("lan_share_start expects the ROM as the request body".into());
    };
    if rom.is_empty() {
        return Err("There is no ROM to share.".into());
    }
    let name = crate::storage::header(&request, NAME_HEADER)?;
    let web = crate::storage::header(&request, WEB_HEADER).unwrap_or_else(|_| DEFAULT_WEB.into());
    if !web.starts_with("https://") && !web.starts_with("http://") {
        return Err("The web address has to be an http or https one.".into());
    }
    let shared = Shared {
        token: new_token()?,
        name,
        web,
        rom: Arc::new(rom.clone()),
        state: None,
        thumbnail: None,
    };
    *state.shared.lock().unwrap() = Some(shared);

    let mut server = state.server.lock().unwrap();
    if server.is_none() {
        *server = Some(listen(state.shared.clone(), Ipv4Addr::UNSPECIFIED)?);
    }
    drop(server);
    info(&state).ok_or_else(|| "The share could not be started.".into())
}

// a save state (`state`) or its picture (`thumbnail`) for the running share; an empty body takes it away
#[tauri::command]
pub fn lan_share_attach(state: State<'_, LanShareState>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("lan_share_attach expects the file as the request body".into());
    };
    let kind = crate::storage::header(&request, KIND_HEADER)?;
    let mut shared = state.shared.lock().unwrap();
    let Some(shared) = shared.as_mut() else {
        return Err("Nothing is being shared.".into());
    };
    let value = if bytes.is_empty() { None } else { Some(Arc::new(bytes.clone())) };
    match kind.as_str() {
        "state" => shared.state = value,
        "thumbnail" => shared.thumbnail = value,
        _ => return Err(format!("`{kind}` is nothing a share can hold")),
    }
    Ok(())
}

// the addresses are read again, as the computer may have changed networks since
#[tauri::command]
pub fn lan_share_info(state: State<'_, LanShareState>) -> Option<LanShareInfo> {
    info(&state)
}

#[tauri::command]
pub fn lan_share_stop(state: State<'_, LanShareState>) {
    stop(&state);
}

pub fn on_exit(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<LanShareState>() {
        stop(&state);
    }
}

fn stop(state: &LanShareState) {
    *state.shared.lock().unwrap() = None;
    let Some(server) = state.server.lock().unwrap().take() else { return };
    server.stop.store(true, Ordering::SeqCst);
    // the accepting thread is blocked in accept; one more connection wakes it to find the flag
    let _ = TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, server.port)),
        Duration::from_secs(1),
    );
}

// on every interface, as the headset is elsewhere in the network (the tests stay on loopback)
fn listen(shared: Arc<Mutex<Option<Shared>>>, on: Ipv4Addr) -> Result<Server, String> {
    let listener = TcpListener::bind((on, PREFERRED_PORT))
        .or_else(|_| TcpListener::bind((on, 0)))
        .map_err(|error| format!("could not listen in the local network: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let accepting = stop.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            if accepting.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let shared = shared.clone();
            thread::spawn(move || {
                let _ = serve(stream, &shared);
            });
        }
    });
    Ok(Server { port, stop })
}

struct Head {
    method: String,
    path: String,
    host: Option<String>,
    origin: Option<String>,
}

fn read_head(stream: &TcpStream) -> Option<Head> {
    let mut reader = BufReader::new(stream.take(MAX_HEAD as u64));
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut host = None;
    let mut origin = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            return None;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "host" => host = Some(value.trim().to_string()),
                "origin" => origin = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    Some(Head { method, path, host, origin })
}

// any page may read a share, as only who has the token can name one; the private-network header answers the
// preflight of Chrome's older Private Network Access
fn cors(origin: &Option<String>) -> String {
    format!(
        "Access-Control-Allow-Origin: {}\r\nVary: Origin\r\nAccess-Control-Allow-Private-Network: true\r\n",
        origin.as_deref().filter(|origin| !origin.contains(&['\r', '\n'][..])).unwrap_or("*")
    )
}

fn respond(stream: &mut TcpStream, status: &str, headers: &str, body: &[u8], head_only: bool) -> std::io::Result<()> {
    let mut reply = format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    if !head_only {
        reply.extend_from_slice(body);
    }
    stream.write_all(&reply)?;
    stream.flush()
}

// %-escapes everything outside the unreserved set, for a URL inside a query and a name inside a path
fn escape(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn serve(mut stream: TcpStream, shared: &Mutex<Option<Shared>>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let Some(head) = read_head(&stream) else {
        return Ok(());
    };
    let cors = cors(&head.origin);
    let head_only = head.method == "HEAD";

    if head.method == "OPTIONS" {
        let headers = format!(
            "{cors}Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n\
Access-Control-Max-Age: 600\r\n"
        );
        respond(&mut stream, "204 No Content", &headers, b"", true)?;
        return stream.shutdown(Shutdown::Both);
    }
    if head.method != "GET" && !head_only {
        respond(&mut stream, "405 Method Not Allowed", &cors, b"", false)?;
        return stream.shutdown(Shutdown::Both);
    }

    // what the request needs, copied out so the lock is not held while a slow network takes the ROM
    let path = head.path.split('?').next().unwrap_or("").to_string();
    let segments: Vec<&str> = path.trim_start_matches('/').splitn(3, '/').collect();
    let found = {
        let guard = shared.lock().unwrap();
        let Some(share) = guard.as_ref() else {
            drop(guard);
            respond(&mut stream, "404 Not Found", &cors, b"Nothing is being shared.", head_only)?;
            return stream.shutdown(Shutdown::Both);
        };
        if path == "/" {
            let host = head.host.clone().filter(|host| !host.contains(&['\r', '\n', '/', '@'][..]));
            match host {
                Some(host) => {
                    let base = format!("http://{host}/{}", share.token);
                    let mut target = format!(
                        "{}?rom={}",
                        share.web,
                        escape(&format!("{base}/rom/{}", escape(&share.name)))
                    );
                    if share.state.is_some() {
                        target.push_str(&format!("&state={}", escape(&format!("{base}/state"))));
                    }
                    Some(Err(target))
                }
                None => None,
            }
        } else if segments.first() != Some(&share.token.as_str()) {
            None
        } else {
            match segments.get(1).copied().unwrap_or("") {
                "" => Some(Ok((
                    "application/json",
                    Arc::new(
                        serde_json::json!({
                            "name": share.name,
                            "size": share.rom.len(),
                            "state": share.state.is_some(),
                            "thumbnail": share.thumbnail.is_some(),
                        })
                        .to_string()
                        .into_bytes(),
                    ),
                ))),
                "rom" => Some(Ok(("application/octet-stream", share.rom.clone()))),
                "state" => share.state.clone().map(|bytes| Ok(("application/octet-stream", bytes))),
                "thumbnail.png" => share.thumbnail.clone().map(|bytes| Ok(("image/png", bytes))),
                _ => None,
            }
        }
    };

    match found {
        Some(Ok((content_type, body))) => {
            let headers = format!("{cors}Content-Type: {content_type}\r\n");
            respond(&mut stream, "200 OK", &headers, &body, head_only)?;
        }
        Some(Err(location)) => {
            let headers = format!("{cors}Location: {location}\r\n");
            respond(&mut stream, "302 Found", &headers, b"", head_only)?;
        }
        None => respond(&mut stream, "404 Not Found", &cors, b"", head_only)?,
    }
    stream.shutdown(Shutdown::Both)
}

// the other end: fetches a file of another desktop's share for this one to play (macOS ATS keeps the webview off local
// ports). Only http to a private IPv4 address, and only what a share answers (Content-Length, then close)
#[tauri::command]
pub async fn lan_share_fetch(url: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || fetch(&url))
        .await
        .map_err(|error| error.to_string())?
        .map(Response::new)
}

fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| "Only http addresses in the local network can be fetched.".to_string())?;
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    let address: SocketAddr = authority
        .parse()
        .map_err(|_| format!("{authority} is not an address and port."))?;
    let SocketAddr::V4(v4) = address else {
        return Err("Only IPv4 addresses in the local network can be fetched.".into());
    };
    if !v4.ip().is_private() || path.contains(&['\r', '\n', ' '][..]) {
        return Err(format!("{authority} is not in the local network."));
    }
    fetch_from(address, authority, path)
}

fn fetch_from(address: SocketAddr, authority: &str, path: &str) -> Result<Vec<u8>, String> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).map_err(|error| error.to_string())?;
    stream.set_read_timeout(Some(WRITE_TIMEOUT)).map_err(|error| error.to_string())?;
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n").as_bytes())
        .map_err(|error| error.to_string())?;
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).map_err(|error| error.to_string())?;

    let end = reply
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "The share answered with something that is not HTTP.".to_string())?;
    let head = String::from_utf8_lossy(&reply[..end]).into_owned();
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "The share answered with something that is not HTTP.".to_string())?;
    if status != 200 {
        return Err(format!("The share answered {status}."));
    }
    let mut body = reply.split_off(end + 4);
    let length = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim().eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok())?
    });
    if let Some(length) = length {
        if body.len() < length {
            return Err("The share broke off before the end.".into());
        }
        body.truncate(length);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_a_query_cannot_hold() {
        assert_eq!(escape("Wario Land (J).vb"), "Wario%20Land%20%28J%29.vb");
        assert_eq!(escape("http://a/b?c=d&e"), "http%3A%2F%2Fa%2Fb%3Fc%3Dd%26e");
    }

    #[test]
    fn serves_a_share_and_nothing_else() {
        let shared = Arc::new(Mutex::new(Some(Shared {
            token: "abc".into(),
            name: "Game (J).vb".into(),
            web: DEFAULT_WEB.into(),
            rom: Arc::new(vec![1, 2, 3, 4]),
            state: Some(Arc::new(vec![9, 9])),
            thumbnail: None,
        })));
        let server = listen(shared.clone(), Ipv4Addr::LOCALHOST).unwrap();
        let base = format!("http://127.0.0.1:{}", server.port);

        // fetch refuses loopback, so the checks below speak to the server by hand
        let get = |path: &str| -> String {
            let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
            stream
                .write_all(format!("GET {path} HTTP/1.1\r\nHost: 192.168.1.2:47913\r\nOrigin: https://x\r\n\r\n").as_bytes())
                .unwrap();
            let mut reply = Vec::new();
            stream.read_to_end(&mut reply).unwrap();
            String::from_utf8_lossy(&reply).into_owned()
        };

        let rom = get("/abc/rom/Game%20(J).vb");
        assert!(rom.starts_with("HTTP/1.1 200"), "{rom}");
        assert!(rom.contains("Access-Control-Allow-Origin: https://x"), "{rom}");
        assert!(rom.ends_with("\u{1}\u{2}\u{3}\u{4}"), "{rom}");
        assert!(get("/abc/").contains("\"state\":true"));
        assert!(get("/abc/thumbnail.png").starts_with("HTTP/1.1 404"));
        assert!(get("/wrong/rom").starts_with("HTTP/1.1 404"));

        let redirect = get("/");
        assert!(redirect.starts_with("HTTP/1.1 302"), "{redirect}");
        assert!(
            redirect.contains(
                "Location: https://play.vueport.net/?rom=http%3A%2F%2F192.168.1.2%3A47913%2Fabc%2From%2FGame%2520%2528J%2529.vb\
&state=http%3A%2F%2F192.168.1.2%3A47913%2Fabc%2Fstate"
            ),
            "{redirect}"
        );

        let address: SocketAddr = format!("127.0.0.1:{}", server.port).parse().unwrap();
        assert_eq!(fetch_from(address, "x", "/abc/rom/x.vb").unwrap(), vec![1, 2, 3, 4]);
        assert_eq!(fetch_from(address, "x", "/abc/state").unwrap(), vec![9, 9]);
        assert!(fetch_from(address, "x", "/abc/thumbnail.png").unwrap_err().contains("404"));

        assert!(fetch(&format!("{base}/abc/rom")).unwrap_err().contains("not in the local network"));
        assert!(fetch("http://85.214.133.93:80/").unwrap_err().contains("not in the local network"));
        assert!(fetch("https://192.168.1.2/").is_err());

        server.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", server.port));
    }
}
