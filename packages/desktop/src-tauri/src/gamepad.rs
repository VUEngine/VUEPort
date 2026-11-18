/**
 * Game pads read natively through SDL, as WebKit's Gamepad API only sees pads Apple's frameworks accept (an 8BitDo 64
 * that Chrome reads fine does not exist to it). SDL brings its controller database (mapping pads no browser knows onto
 * the standard layout), its own drivers (Switch Pro rumble, the handshake a Switch 2 Pro Controller waits for) and
 * the raw numbering RetroArch's sdl2 profiles use.
 *
 * One thread owns SDL, as its joystick state must not be touched from two. It polls and emits a snapshot of all pads
 * (gamepads://state) whenever something changed, which desktop-gamepads.ts turns back into Gamepad objects; rumble
 * goes the other way, as a command queued for that thread. Pads SDL knows as gamepads are reported on the standard
 * layout, others raw in SDL's order with each hat as one more axis shaped like Chrome's, so the page's raw-pad
 * handling applies unchanged.
 */

use std::collections::HashMap;
use std::ffi::CStr;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sdl3_sys::everything::*;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

// faster than the page's frames, so a press is never a whole frame late on top of the trip to the page
const POLL: Duration = Duration::from_millis(4);

// outside -1…1 at rest, as in Chrome
const HAT_REST: f32 = 23.0 / 7.0;

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PadSnapshot {
    index: u32,
    id: String, // in Chrome's shape, so the page takes vendor and product ids out of it as in a browser
    mapping: &'static str, // "standard" for a pad SDL knows as a gamepad, "" for a raw one
    buttons: Vec<f32>,
    axes: Vec<f32>,
    // asked by trying a rumble of nothing for no time rather than SDL's capability flag: the 8BitDo 64 in Switch
    // mode has the flag off and rumbles all the same, a driver that cannot rumble refuses even that
    rumble: bool,
}

enum Request {
    Rumble { index: u32, strong: f32, weak: f32, duration: u32 },
}

#[derive(Default)]
pub struct GamepadState {
    requests: Mutex<Option<Sender<Request>>>,
    // for a page that asks rather than waits: the thread only reports changes, and pads plugged in before the page
    // loaded changed before it was listening
    latest: Arc<Mutex<Vec<PadSnapshot>>>,
}

#[tauri::command]
pub fn gamepad_snapshot(state: State<'_, GamepadState>) -> Vec<PadSnapshot> {
    state.latest.lock().unwrap().clone()
}

// both motors 0–1, for duration ms; zero stops it
#[tauri::command]
pub fn gamepad_rumble(state: State<'_, GamepadState>, index: u32, strong: f32, weak: f32, duration: u32) {
    if let Some(sender) = state.requests.lock().unwrap().as_ref() {
        let _ = sender.send(Request::Rumble { index, strong, weak, duration });
    }
}

pub fn start(app: AppHandle, state: &GamepadState) {
    let (sender, receiver) = channel();
    *state.requests.lock().unwrap() = Some(sender);
    let latest = state.latest.clone();
    std::thread::Builder::new()
        .name("gamepads".into())
        .spawn(move || run(app, receiver, latest))
        .expect("could not start the game pad thread");
}

enum Open {
    Gamepad(*mut SDL_Gamepad),
    Joystick(*mut SDL_Joystick),
}

struct Pad {
    slot: u32,
    open: Open,
    id: String,
    rumble: bool,
    unmapped: Unmapped,
}

// raw buttons, axes and hats of a gamepad that its SDL mapping does not use, by joystick index. Mappings leave
// things out (the 8BitDo 64's lacks C-Right and minus), so they are read off the joystick and put after the
// standard controls, where a browser puts extras too.
#[derive(Default)]
struct Unmapped {
    buttons: Vec<i32>,
    axes: Vec<i32>,
    hats: Vec<i32>,
}

fn run(app: AppHandle, requests: Receiver<Request>, latest: Arc<Mutex<Vec<PadSnapshot>>>) {
    unsafe {
        // read while the window is not in front too; the page decides what to do with those presses
        SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, c"1".as_ptr());
        if !SDL_Init(SDL_INIT_GAMEPAD) {
            eprintln!("game pads unavailable: {}", error());
            return;
        }
    }

    let mut pads: HashMap<u32, Pad> = HashMap::new();
    let mut last: Vec<PadSnapshot> = Vec::new();

    loop {
        unsafe { SDL_UpdateGamepads() };
        sync_pads(&mut pads);

        for request in requests.try_iter() {
            match request {
                Request::Rumble { index, strong, weak, duration } => {
                    if let Some(pad) = pads.values().find(|pad| pad.slot == index) {
                        rumble(pad, strong, weak, duration);
                    }
                }
            }
        }

        let mut snapshot: Vec<PadSnapshot> = pads.values().map(read).collect();
        snapshot.sort_by_key(|pad| pad.index);
        if snapshot != last {
            *latest.lock().unwrap() = snapshot.clone();
            if app.emit("gamepads://state", &snapshot).is_err() {
                break;
            }
            last = snapshot;
        }
        std::thread::sleep(POLL);
    }

    for pad in pads.into_values() {
        close(pad);
    }
    unsafe { SDL_Quit() };
}

fn sync_pads(pads: &mut HashMap<u32, Pad>) {
    let present = joystick_ids();
    let gone: Vec<u32> = pads.keys().filter(|instance| !present.contains(instance)).copied().collect();
    for instance in gone {
        if let Some(pad) = pads.remove(&instance) {
            close(pad);
        }
    }
    for instance in present {
        if pads.contains_key(&instance) {
            continue;
        }
        // the lowest free slot, as a browser numbers them: a pad plugged back in gets its old place if still free
        let mut slot = 0;
        while pads.values().any(|pad| pad.slot == slot) {
            slot += 1;
        }
        if let Some(pad) = open(instance, slot) {
            pads.insert(instance, pad);
        }
    }
}

fn joystick_ids() -> Vec<u32> {
    unsafe {
        let mut count = 0;
        let ids = SDL_GetJoysticks(&mut count);
        if ids.is_null() {
            return Vec::new();
        }
        let found = (0..count.max(0) as usize).map(|i| (*ids.add(i)).0).collect();
        SDL_free(ids as *mut _);
        found
    }
}

fn open(instance: u32, slot: u32) -> Option<Pad> {
    let id = SDL_JoystickID(instance);
    unsafe {
        let vendor = SDL_GetJoystickVendorForID(id);
        let product = SDL_GetJoystickProductForID(id);
        if SDL_IsGamepad(id) {
            let gamepad = SDL_OpenGamepad(id);
            if !gamepad.is_null() {
                let name = text(SDL_GetGamepadName(gamepad));
                let rumble = SDL_GetBooleanProperty(
                    SDL_GetGamepadProperties(gamepad), SDL_PROP_GAMEPAD_CAP_RUMBLE_BOOLEAN, false)
                    || SDL_RumbleGamepad(gamepad, 0, 0, 0);
                let mapping = SDL_GetGamepadMapping(gamepad);
                eprintln!("game pad {slot}: {name} {vendor:04x}:{product:04x}, rumble {rumble}, mapping {}",
                    if mapping.is_null() { "none".into() } else { text(mapping) });
                if !mapping.is_null() {
                    SDL_free(mapping as *mut _);
                }
                return Some(Pad {
                    slot,
                    open: Open::Gamepad(gamepad),
                    id: format!("{name} (STANDARD GAMEPAD Vendor: {vendor:04x} Product: {product:04x})"),
                    rumble,
                    unmapped: unmapped(gamepad),
                });
            }
        }
        let joystick = SDL_OpenJoystick(id);
        if joystick.is_null() {
            return None;
        }
        let name = text(SDL_GetJoystickName(joystick));
        let rumble = SDL_GetBooleanProperty(
            SDL_GetJoystickProperties(joystick), SDL_PROP_JOYSTICK_CAP_RUMBLE_BOOLEAN, false)
            || SDL_RumbleJoystick(joystick, 0, 0, 0);
        eprintln!("game pad {slot}: {name} {vendor:04x}:{product:04x}, rumble {rumble}, raw");
        Some(Pad {
            slot,
            open: Open::Joystick(joystick),
            id: format!("{name} (Vendor: {vendor:04x} Product: {product:04x})"),
            rumble,
            unmapped: Unmapped::default(),
        })
    }
}

fn unmapped(gamepad: *mut SDL_Gamepad) -> Unmapped {
    unsafe {
        let joystick = SDL_GetGamepadJoystick(gamepad);
        if joystick.is_null() {
            return Unmapped::default();
        }
        let mut used_buttons = Vec::new();
        let mut used_axes = Vec::new();
        let mut used_hats = Vec::new();
        let mut count = 0;
        let bindings = SDL_GetGamepadBindings(gamepad, &mut count);
        if !bindings.is_null() {
            for i in 0..count.max(0) as usize {
                let binding = &**bindings.add(i);
                match binding.input_type {
                    SDL_GAMEPAD_BINDTYPE_BUTTON => used_buttons.push(binding.input.button),
                    SDL_GAMEPAD_BINDTYPE_AXIS => used_axes.push(binding.input.axis.axis),
                    SDL_GAMEPAD_BINDTYPE_HAT => used_hats.push(binding.input.hat.hat),
                    _ => {}
                }
            }
            SDL_free(bindings as *mut _);
        }
        let left_over = |count: i32, used: &[i32]| (0..count.max(0)).filter(|index| !used.contains(index)).collect();
        Unmapped {
            buttons: left_over(SDL_GetNumJoystickButtons(joystick), &used_buttons),
            axes: left_over(SDL_GetNumJoystickAxes(joystick), &used_axes),
            hats: left_over(SDL_GetNumJoystickHats(joystick), &used_hats),
        }
    }
}

fn close(pad: Pad) {
    unsafe {
        match pad.open {
            Open::Gamepad(gamepad) => SDL_CloseGamepad(gamepad),
            Open::Joystick(joystick) => SDL_CloseJoystick(joystick),
        }
    }
}

// the standard layout's buttons in order, as SDL names them. The triggers are SDL axes, read into 6 and 7 as
// analog buttons separately.
const STANDARD_BUTTONS: [Option<SDL_GamepadButton>; 17] = [
    Some(SDL_GAMEPAD_BUTTON_SOUTH),
    Some(SDL_GAMEPAD_BUTTON_EAST),
    Some(SDL_GAMEPAD_BUTTON_WEST),
    Some(SDL_GAMEPAD_BUTTON_NORTH),
    Some(SDL_GAMEPAD_BUTTON_LEFT_SHOULDER),
    Some(SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER),
    None,
    None,
    Some(SDL_GAMEPAD_BUTTON_BACK),
    Some(SDL_GAMEPAD_BUTTON_START),
    Some(SDL_GAMEPAD_BUTTON_LEFT_STICK),
    Some(SDL_GAMEPAD_BUTTON_RIGHT_STICK),
    Some(SDL_GAMEPAD_BUTTON_DPAD_UP),
    Some(SDL_GAMEPAD_BUTTON_DPAD_DOWN),
    Some(SDL_GAMEPAD_BUTTON_DPAD_LEFT),
    Some(SDL_GAMEPAD_BUTTON_DPAD_RIGHT),
    Some(SDL_GAMEPAD_BUTTON_GUIDE),
];

// extra buttons after the standard seventeen, as Chrome appends them. All six misc buttons first: a mapping puts
// whatever has no standard name there, the 8BitDo 64's minus on misc 3 and C-Right on misc 2.
const EXTRA_BUTTONS: [SDL_GamepadButton; 11] = [
    SDL_GAMEPAD_BUTTON_MISC1,
    SDL_GAMEPAD_BUTTON_MISC2,
    SDL_GAMEPAD_BUTTON_MISC3,
    SDL_GAMEPAD_BUTTON_MISC4,
    SDL_GAMEPAD_BUTTON_MISC5,
    SDL_GAMEPAD_BUTTON_MISC6,
    SDL_GAMEPAD_BUTTON_TOUCHPAD,
    SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1,
    SDL_GAMEPAD_BUTTON_LEFT_PADDLE1,
    SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2,
    SDL_GAMEPAD_BUTTON_LEFT_PADDLE2,
];

fn read(pad: &Pad) -> PadSnapshot {
    unsafe {
        match pad.open {
            Open::Gamepad(gamepad) => {
                let trigger = |axis| (SDL_GetGamepadAxis(gamepad, axis) as f32 / 32767.0).clamp(0.0, 1.0);
                let mut buttons: Vec<f32> = STANDARD_BUTTONS.iter().enumerate().map(|(index, button)| match button {
                    Some(button) => pressed(SDL_GetGamepadButton(gamepad, *button)),
                    None if index == 6 => trigger(SDL_GAMEPAD_AXIS_LEFT_TRIGGER),
                    None => trigger(SDL_GAMEPAD_AXIS_RIGHT_TRIGGER),
                }).collect();
                // only as far as the last extra the pad carries, so the list ends where its buttons do, as in a browser
                let carried = EXTRA_BUTTONS.iter()
                    .rposition(|button| SDL_GamepadHasButton(gamepad, *button))
                    .map_or(0, |last| last + 1);
                buttons.extend(EXTRA_BUTTONS[..carried].iter()
                    .map(|button| pressed(SDL_GetGamepadButton(gamepad, *button))));
                let mut axes: Vec<f32> = [SDL_GAMEPAD_AXIS_LEFTX, SDL_GAMEPAD_AXIS_LEFTY, SDL_GAMEPAD_AXIS_RIGHTX, SDL_GAMEPAD_AXIS_RIGHTY]
                    .iter()
                    .map(|axis| stick(SDL_GetGamepadAxis(gamepad, *axis)))
                    .collect();
                let joystick = SDL_GetGamepadJoystick(gamepad);
                if !joystick.is_null() {
                    buttons.extend(pad.unmapped.buttons.iter().map(|button| pressed(SDL_GetJoystickButton(joystick, *button))));
                    axes.extend(pad.unmapped.axes.iter().map(|axis| stick(SDL_GetJoystickAxis(joystick, *axis))));
                    axes.extend(pad.unmapped.hats.iter().map(|hat| hat_axis(SDL_GetJoystickHat(joystick, *hat))));
                }
                PadSnapshot { index: pad.slot, id: pad.id.clone(), mapping: "standard", buttons, axes, rumble: pad.rumble }
            }
            Open::Joystick(joystick) => {
                let buttons = (0..SDL_GetNumJoystickButtons(joystick).max(0))
                    .map(|button| pressed(SDL_GetJoystickButton(joystick, button)))
                    .collect();
                let mut axes: Vec<f32> = (0..SDL_GetNumJoystickAxes(joystick).max(0))
                    .map(|axis| stick(SDL_GetJoystickAxis(joystick, axis)))
                    .collect();
                axes.extend((0..SDL_GetNumJoystickHats(joystick).max(0)).map(|hat| hat_axis(SDL_GetJoystickHat(joystick, hat))));
                PadSnapshot { index: pad.slot, id: pad.id.clone(), mapping: "", buttons, axes, rumble: pad.rumble }
            }
        }
    }
}

fn pressed(down: bool) -> f32 {
    if down { 1.0 } else { 0.0 }
}

// -1…1 to three places: finer than any dead zone, coarse enough that a resting pad does not send a snapshot
// every poll
fn stick(value: i16) -> f32 {
    let value = (value as f32 / 32767.0).clamp(-1.0, 1.0);
    (value * 1000.0).round() / 1000.0
}

// a hat as the one axis Chrome makes of it: eight positions clockwise from up at -1, 2/7 apart, outside the
// range at rest
fn hat_axis(hat: u8) -> f32 {
    let position = match hat {
        SDL_HAT_UP => 0,
        SDL_HAT_RIGHTUP => 1,
        SDL_HAT_RIGHT => 2,
        SDL_HAT_RIGHTDOWN => 3,
        SDL_HAT_DOWN => 4,
        SDL_HAT_LEFTDOWN => 5,
        SDL_HAT_LEFT => 6,
        SDL_HAT_LEFTUP => 7,
        _ => return HAT_REST,
    };
    -1.0 + position as f32 * 2.0 / 7.0
}

fn rumble(pad: &Pad, strong: f32, weak: f32, duration: u32) {
    let low = (strong.clamp(0.0, 1.0) * 65535.0) as u16;
    let high = (weak.clamp(0.0, 1.0) * 65535.0) as u16;
    let played = unsafe {
        match pad.open {
            Open::Gamepad(gamepad) => SDL_RumbleGamepad(gamepad, low, high, duration),
            Open::Joystick(joystick) => SDL_RumbleJoystick(joystick, low, high, duration),
        }
    };
    if !played {
        eprintln!("game pad {}: rumble refused: {}", pad.slot, error());
    }
}

fn text(pointer: *const std::ffi::c_char) -> String {
    if pointer.is_null() {
        return "Game Pad".into();
    }
    unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
}

fn error() -> String {
    text(SDL_GetError())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hat_reads_as_chromes_hat_axis() {
        assert_eq!(hat_axis(SDL_HAT_CENTERED), HAT_REST);
        assert_eq!(hat_axis(SDL_HAT_UP), -1.0);
        assert!((hat_axis(SDL_HAT_LEFT) - 5.0 / 7.0).abs() < 1e-6);
        assert!((hat_axis(SDL_HAT_RIGHT) + 3.0 / 7.0).abs() < 1e-6);
        assert!((hat_axis(SDL_HAT_LEFTUP) - 1.0).abs() < 1e-6);
        // at rest it is outside any stick's range, which is how the page tells a hat from a stick
        assert!(HAT_REST.abs() > 1.05);
    }

    #[test]
    fn a_stick_is_scaled_and_rounded() {
        assert_eq!(stick(0), 0.0);
        assert_eq!(stick(32767), 1.0);
        assert_eq!(stick(-32768), -1.0);
        assert_eq!(stick(10), 0.0);
    }
}
