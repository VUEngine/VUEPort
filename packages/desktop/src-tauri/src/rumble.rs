// the Rumble Pack over a real serial port, as no system webview offers Web Serial. Device ids and line settings
// are the studio's (ves-rumble-pack-types.ts), so both recognize the same hardware.

use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const KNOWN: [(u16, u16, &str); 2] = [
    (9025, 32822, "Final"),
    (39321, 39321, "Prototype"),
];

// from the studio's ves-rumble-pack-service.ts
const BAUD_RATE: u32 = 115_200;

// how long a read waits before giving the thread a chance to stop
const READ_TIMEOUT: Duration = Duration::from_millis(50);

#[derive(Serialize, Clone)]
pub struct RumblePort {
    path: String,
    name: String,
    vendor: u16,
    product: u16,
}

#[derive(Default)]
pub struct RumbleState {
    port: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    open: Mutex<Option<RumblePort>>,
}

// filtered, as opening some other serial device at random would be worse than finding nothing
#[tauri::command]
pub fn rumble_ports() -> Result<Vec<RumblePort>, String> {
    let ports = serialport::available_ports().map_err(|error| error.to_string())?;
    let mut found = Vec::new();
    for port in ports {
        if let serialport::SerialPortType::UsbPort(info) = &port.port_type {
            for (vendor, product, name) in KNOWN {
                if info.vid == vendor && info.pid == product {
                    found.push(RumblePort {
                        path: port.port_name.clone(),
                        name: name.to_string(),
                        vendor,
                        product,
                    });
                }
            }
        }
    }
    Ok(found)
}

// reads on its own thread, as a serial read blocks, and forwards data as events: the pack talks when it has
// something to say, not when asked
#[tauri::command]
pub fn rumble_open(
    app: AppHandle,
    state: State<'_, RumbleState>,
    path: Option<String>,
) -> Result<RumblePort, String> {
    let ports = rumble_ports()?;
    let wanted = match path {
        Some(path) => ports.into_iter().find(|port| port.path == path),
        None => ports.into_iter().next(),
    }
    .ok_or_else(|| "No Rumble Pack is attached.".to_string())?;

    let port = serialport::new(&wanted.path, BAUD_RATE)
        .timeout(READ_TIMEOUT)
        .open()
        .map_err(|error| format!("could not open {}: {error}", wanted.path))?;

    let reader = port
        .try_clone()
        .map_err(|error| format!("could not read from {}: {error}", wanted.path))?;

    *state.port.lock().unwrap() = Some(port);
    *state.open.lock().unwrap() = Some(wanted.clone());

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 256];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => continue,
                Ok(count) => {
                    let bytes: Vec<u8> = buffer[..count].to_vec();
                    if handle.emit("rumble://data", bytes).is_err() {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(_) => {
                    // the pack was unplugged, or the port went away with it
                    let _ = handle.emit("rumble://closed", ());
                    return;
                }
            }
        }
    });

    Ok(wanted)
}

#[tauri::command]
pub fn rumble_close(state: State<'_, RumbleState>) {
    *state.port.lock().unwrap() = None;
    *state.open.lock().unwrap() = None;
}

// answers the page's connected and deviceName
#[tauri::command]
pub fn rumble_current(state: State<'_, RumbleState>) -> Option<RumblePort> {
    state.open.lock().unwrap().clone()
}

#[tauri::command]
pub fn rumble_write(state: State<'_, RumbleState>, data: Vec<u8>) -> Result<(), String> {
    let mut guard = state.port.lock().unwrap();
    let port = guard
        .as_mut()
        .ok_or_else(|| "No Rumble Pack is open.".to_string())?;
    port.write_all(&data)
        .map_err(|error| format!("could not write to the Rumble Pack: {error}"))?;
    port.flush().map_err(|error| error.to_string())
}
