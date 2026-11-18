// command line options for frontends (LaunchBox, Playnite, EmulationStation) and scripts, for this run only. Unknown
// arguments are ignored, as packaged apps get all sorts; a ROM path is handled in opened.rs, --probe in probe.rs. On
// macOS they only reach a fresh process (`open -a VUEPort --args --fullscreen`)

use std::path::Path;

use serde::Serialize;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOptions {
    pub linked: bool, // --linked: invite a second player as soon as a game runs
    pub fullscreen: bool,
    pub quit_on_close: bool, // --quit-on-close: closing the game quits instead of going back to the library
    // --continue: start the newest Recently Played game regardless of the setting, unless a ROM was named
    #[serde(rename = "continue")]
    pub continue_last: bool,
    // --hardcore / --softcore: RetroAchievements hardcore on or off for this run; the last one given counts
    pub hardcore: Option<bool>,
}

impl LaunchOptions {
    pub fn from_command_line() -> Self {
        Self::parse(std::env::args().skip(1))
    }

    fn parse(args: impl Iterator<Item = String>) -> Self {
        let mut options = Self::default();
        let mut rom = false;
        for argument in args {
            match argument.as_str() {
                "--linked" => options.linked = true,
                "--fullscreen" => options.fullscreen = true,
                "--quit-on-close" => options.quit_on_close = true,
                "--continue" => options.continue_last = true,
                "--hardcore" => options.hardcore = Some(true),
                "--softcore" => options.hardcore = Some(false),
                other => rom |= !other.starts_with('-') && Path::new(other).is_file(),
            }
        }
        options.continue_last &= !rom;
        options
    }
}

#[tauri::command]
pub fn launch_options(options: tauri::State<'_, LaunchOptions>) -> LaunchOptions {
    options.inner().clone()
}

const USAGE: &str = "\
Usage: VUEPort [options] [rom]

  rom                 a .vb, .vbc, .vbz or .zip file to start

Options:
  --fullscreen        start in fullscreen
  --continue          continue the game played last (ignored when a ROM is given)
  --quit-on-close     quit when the game is closed instead of returning to the library
  --hardcore          RetroAchievements hardcore mode on for this run
  --softcore          RetroAchievements hardcore mode off for this run
  --linked            invite a second player as soon as a game runs
  --probe             let tools connect for this run (Probe mode)
  --probe-cli <cmd>   send a command to the running VUEPort and print the answer
  --help, -h          show this help
  --version           show the version

The options apply to this run only; no setting is changed.";

// --help and --version, answered on the console instead of starting. Run first in main, after the probe client;
// None for every ordinary start.
pub fn client_main(version: &str) -> Option<i32> {
    let answer = std::env::args().skip(1).find_map(|argument| match argument.as_str() {
        "--help" | "-h" => Some(USAGE.to_string()),
        "--version" => Some(format!("VUEPort {version}")),
        _ => None,
    })?;
    #[cfg(windows)]
    crate::probe::attach_to_console();
    println!("{answer}");
    Some(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> LaunchOptions {
        LaunchOptions::parse(args.iter().map(|arg| arg.to_string()))
    }

    #[test]
    fn flags() {
        let options = parse(&["--fullscreen", "--quit-on-close", "--continue", "--linked", "-psn_0_1234"]);
        assert!(options.fullscreen && options.quit_on_close && options.continue_last && options.linked);
        assert_eq!(options.hardcore, None);
    }

    #[test]
    fn last_mode_counts() {
        assert_eq!(parse(&["--hardcore", "--softcore"]).hardcore, Some(false));
        assert_eq!(parse(&["--softcore", "--hardcore"]).hardcore, Some(true));
    }

    #[test]
    fn a_rom_wins_over_continue() {
        let rom = std::env::current_exe().unwrap();
        let options = parse(&["--continue", rom.to_str().unwrap()]);
        assert!(!options.continue_last);
        // a path that is not a file is not a ROM
        assert!(parse(&["--continue", "no-such-file.vb"]).continue_last);
    }
}
