# VUEPort Desktop

The desktop app for Windows, macOS and Linux, built with [Tauri](https://tauri.app). It renders `packages/web/dist`, the same build that runs on [play.vueport.net](https://play.vueport.net), in the operating system's own webview.

## Building

You need [Rust](https://rustup.rs), the platform's [webview development packages](https://v2.tauri.app/start/prerequisites/) and [CMake](https://cmake.org) on the `PATH`. CMake builds SDL 3, which reads game pads and is linked in statically. On a Mac without Homebrew, `pip install --user cmake` works too.

```sh
yarn install                              # from the repository root
yarn build                                # build core, then web packages
yarn workspace vueport-desktop dev        # run it
yarn workspace vueport-desktop bundle     # installers, in src-tauri/target/release/bundle
```

`VUEPORT_TARGET` builds for another Rust target, for example the Intel build on an Apple Silicon Mac (after `rustup target add x86_64-apple-darwin`). That build lands in `src-tauri/target/<triple>/release/bundle`:

```sh
VUEPORT_TARGET=x86_64-apple-darwin yarn workspace vueport-desktop bundle
```

`dev` and `bundle` rebuild the web app themselves, but not the core library. Run the root `yarn build` after changing the core.

> **Note**: This package's `build` script does nothing on purpose. The root `yarn workspaces run build` needs one in every package, and bundling takes minutes and a Rust toolchain.

> **Note**: After moving the repository, run `yarn workspace vueport-desktop clean` first. `target/` caches absolute paths, and a stale one fails with a confusing missing-permissions error.

`.github/workflows/desktop.yml` builds Windows, Linux and both Macs on GitHub's runners. Tauri cannot cross-compile between operating systems, since each platform links against its own webview. Between the two Mac architectures it can, so the Intel build runs on the same Apple Silicon runner.

## What the Desktop App Adds

The app is the same bundle as the web build. Desktop differences are made in `packages/web/src/main.tsx` and kept in the `desktop-*` modules beside it. There are no `@tauri-apps/*` packages: the page calls the shell's commands through the global Tauri injects.

### Files on Disk

Companion files like saves live in `~/.vueport`, preferences in `~/.vueport/config.json` (readable by your user only on Unix). Paths are resolved under that one root, and anything with `..` or an absolute segment is refused.

Files belonging to an opened ROM are read and written beside it: its save, save states, cheats, ESSound tracks, and the `.elf` that a VUEngine build's `.map` names. The shell only allows folders the system itself opened a file from, and remembers the last 64 of them in `opened.json` so the start page can reopen them after a restart (`storage.rs`, `opened.rs`).

### Game Pads

Game pads are read through SDL 3 in the shell and handed to the page as `Gamepad` objects, independent of what the webview supports (`src-tauri/src/gamepad.rs`). No rumble through SDL yet.

### Rumble Pack

The Rumble Pack's serial port is opened in Rust (`src-tauri/src/rumble.rs`), since no system webview has Web Serial.

### Second Player's Window

Linked play runs two windows, each a whole emulator running both machines, exchanging only controller input over a `BroadcastChannel`. The shell opens the second window (`src-tauri/src/link.rs`).

> **Note**: `open_link_window` must stay `async`. WebView2 refuses to create a webview from inside another webview's message handler, which is where a synchronous command runs. The second player got a white window on Windows. `test:link` does not catch this.

### VR on Windows

WebView2 reaches PC headsets through the system's OpenXR runtime (Quest Link, Virtual Desktop, SteamVR), once WebXR is switched on in `WEBVIEW2_ARGUMENTS` (`src-tauri/src/main.rs`). Tested with a Quest 3. Not possible on macOS and Linux: their webviews have no WebXR.

### Command Line

```sh
VUEPort /path/to/rom.vb                      # start with a ROM
VUEPort --fullscreen --quit-on-close rom.vb  # as a frontend would
VUEPort --continue                           # the last game, where it was left
```

| Option | |
| --- | --- |
| `--fullscreen` | start fullscreen |
| `--continue` | start the newest Recently Played game, ignored when a ROM is named |
| `--quit-on-close` | closing the game quits instead of showing the library |
| `--hardcore`, `--softcore` | RetroAchievements hardcore on or off, the last one counts |
| `--linked` | invite a second player as soon as a game runs |
| `--probe` | let tools connect, see the [probe README](../probe/README.md) |
| `--help`, `--version` | print and exit |

Options apply to that run only and change no setting. Arguments that are neither a flag nor an existing file are ignored. On macOS, options only reach a freshly started app (`open -a VUEPort --args --fullscreen`). Parsed in `src-tauri/src/launch.rs`.

### File Associations

The installers register `.vb`, `.vbc` and `.vbz` with their own document icons, and offer VUEPort as a secondary handler for `.zip`. All ways in (double click, Apple Event, drop on the window) go through the same route as a picked file.

- `.vb` is shared with Visual Basic, so VUEPort asks for the default rank rather than taking it over.
- `.zip` never replaces the default handler. On macOS it is an `Alternate` association; on Windows it is left out of `tauri.windows.conf.json` and registered as an `OpenWithProgids` entry by `windows/associations.nsh`. Changing an association means editing both files.

Window drops are handled by the shell (`WindowEvent::DragDrop`), since the page's `drop` event never fires while Tauri's drag and drop handler is installed. The shell emits `files://dragging` to light up the drop area.

## Installers

### Windows

NSIS only (`tauri.windows.conf.json`). Every installer customization is NSIS-only: the MSI registered `.vb` and nothing else. NSIS also installs per user, without a UAC prompt. Tauri 2 needs Windows 10 1803 or newer either way.

> **ATTENTION**: There is exactly one NSIS hook file, `windows/associations.nsh`. Platform configs are merged as a JSON merge patch, so an `installerHooks` in `tauri.conf.json` would be silently replaced, not added.

The hook also points the three file types at their own `.ico` files, since Tauri's template gives all of them the app icon.

The installer art in `src-tauri/windows/` are placeholders. Replacement images must be uncompressed 24-bit BMPs (`BI_RGB`, no alpha) in exactly these sizes, or NSIS silently drops them:

- `header.bmp`: 150×57
- `sidebar.bmp`: 164×314

`tests/installer-art-probe.mjs` checks both. `scripts/installer-art.mjs` drew the placeholders (needs ffmpeg).

### macOS

A `.dmg` and a `.pkg` for each architecture, built separately rather than universal so neither download carries the other's half. `bundle.mjs` renames the update archive after the architecture (`VUEPort_1.0.0_x64.app.tar.gz`), since the bundler names it `VUEPort.app.tar.gz` on both and the release holds both. Tauri has no `pkg` target, so `scripts/pkg.mjs` builds one from the `.app` after bundling (`yarn workspace vueport-desktop pkg` alone). The package installs into `/Applications` only, refuses the wrong architecture or macOS version up front, and asks for an administrator.

An aborted run can leave the bundler's working image (`rw.<pid>.VUEPort_….dmg`) mounted, and while it is, every later `bundle_dmg.sh` fails. `bundle.mjs` therefore detaches and deletes such leftovers before it builds.

The installer background is `src-tauri/macos/background.png` (620×418). Dark Mode reads only `<background-darkAqua>`, so `pkg.mjs` always writes both, using `background-dark.png` if it exists.

### Linux

`tauri.linux.conf.json` sets the product name to `VUEPORT`. Not a typo: the deb and rpm bundlers kebab-case the name, and `VUEPort` became `vue-port`. The menu entry still says VUEPort.

WebKitGTK has no WebGL in workers, so the Linux build draws on the page instead (`mainThreadVideo` in `packages/web/src/main.tsx`). Emulation stays in the worker; only the packed frame crosses over. On this path `VbRenderer.dispose` releases its WebGL context explicitly, since browsers only keep a few alive.

## Debugging the App

Development builds inject `src-tauri/diagnostics.js`, which checks what the webview supports (audio clock at 41700 Hz, WebGL2 in a worker, OPFS, `BroadcastChannel` between windows, emulated speed) and prints a `SMOKE {json}` line every second:

```sh
cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml
./packages/desktop/src-tauri/target/debug/vueport-desktop | grep --line-buffered '^SMOKE '
```

For faults that only show up once packaged, build a bundle with the inspector opening on start. Never release it.

```sh
yarn workspace vueport-desktop bundle --devtools      # or VUEPORT_DEVTOOLS=1
```

> **Note**: Tauri stamps nonces into the bundle's CSP, which makes `'unsafe-inline'` inert. styled-components needs inline styles, so `dangerousDisableAssetCspModification: ["style-src"]` keeps that one directive as written. Without it, the bundled app renders an empty window while `tauri dev` works fine. `packages/web`'s `csp-probe` guards this.

| Platform | Webview | Result |
| --- | --- | --- |
| macOS, Apple silicon | WKWebView | All checks pass |
| Windows | WebView2 | Works, VR tested with a Quest 3 |
| Ubuntu 22.04 and 24.04 | WebKitGTK | Works, no WebGL in workers |
