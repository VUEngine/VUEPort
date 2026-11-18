# vueport-probe

`vbprobe` is a Virtual Boy without a UI, for scripts and AI agents. It runs the same core as VUEPort, counts frames the same way, and reads and writes the app's save states and movies. Run a game to a point, look at memory and registers, disassemble with the build's names, and find out which code reads or writes what.

```sh
yarn workspace vueport-probe build
packages/probe/bin/vbprobe.js help
```

The machine and the commands live in `vueport-core` (`src/probe`), where the desktop app and VUEngine Studio use them too. This package adds file handling for Node.

## Command Line

Every command loads the ROM, applies `--state-in`, runs as told, then does its job. Calls chain through save state files, so no daemon is needed.

```sh
# run, press START at frame 300, take a screenshot, keep the state
vbprobe run game.vb --frames 600 --keys 300-305:STA --shot 600:title.png --state-out title.vess

# carry on from there
vbprobe peek game.vb --state-in title.vess 0x05000000:64
vbprobe regs game.vb --state-in title.vess
vbprobe dis  game.vb --state-in title.vess

# who writes this byte
vbprobe watch game.vb --frames 2000 --movie intro.mc2 --write 0x05010004

# which code a button runs, where a value lives, how it crashed
vbprobe coverage game.vb --state-in title.vess --frames 60 --coverage-out idle.cov
vbprobe coverage game.vb --state-in title.vess --frames 60 --keys 0-5:STA --against idle.cov
vbprobe search game.vb --state-in a.vess --frames 100 --keys 0-100:RIGHT --op increased --candidates x.search
vbprobe run game.vb --state-in a.vess --frames 3000 --stop-on-fault --branches 32

# patch and run
vbprobe asm game.vb 0x0701A2B0 "movea 99, r0, r10; jmp [lp]" --frames 300 --state-out patched.vess

# with the build's .elf: names, fields, source lines, call stacks
vbprobe watch game.vb --elf game.elf --frames 300 --write g_stats.lives --capture stack
vbprobe watch game.vb --elf game.elf --frames 300 --exec Stage::spawn --capture r6,r7 --list
vbprobe run   game.vb --elf game.elf --until Stage::load --state-out stage.vess

# stop at the moment it happens and keep it
vbprobe regs game.vb --frames 5000 --write 0x05000010:4 --when-value 100 --stop --state-out hit.vess

# change the machine as it runs
vbprobe run game.vb --elf game.elf --exec Stage::load --set r6=3 --frames 600 --state-out stage3.vess
vbprobe run game.vb --until-read 0x07012000:0x800 --frames 6000 --state-out loaded.vess

# states from an older build, picture tests, profiling
vbprobe run     game.vb --state-in before.vess --other-rom --frames 60 --shot 60:now.png
vbprobe compare game.vb --state-in title.vess title.png --tolerance 2 --out diff.png   # exits 1 on a difference
vbprobe profile game.vb --state-in stage.vess --frames 300 --list

# frame buffers, and what drew each pixel
vbprobe fb     game.vb --state-in title.vess --out title.bin
vbprobe origin game.vb --state-in title.vess 192,112
vbprobe shot   game.vb --state-in a.vess objects.png --annotate objects
```

The hardware as the debug panels show it:

```sh
vbprobe vip    game.vb --state-in title.vess              # registers, palettes, worlds
vbprobe vip    game.vb --state-in title.vess objects
vbprobe vip    game.vb --state-in title.vess bgmap 3 0,0,16,8
vbprobe vip    game.vb --state-in title.vess char 1101
vbprobe vsu    game.vb --state-in title.vess
vbprobe vbc    game.vb --state-in title.vess              # VB Color switches and CRAM
vbprobe pool   game.vb --elf game.elf --frames 300        # VUEngine memory pools
vbprobe actors game.vb --elf game.elf --frames 300 --fields
```

Output is short text, `--json` gives the same as data. Hit lists are folded by instruction past 20 hits (`--list` and `--group` choose).

## Persistent Session

```sh
vbprobe serve game.vb --elf game.elf
```

Reads one request per line from standard input, either JSON (`{"id": 1, "args": ["regs", "--fork", "a"]}`) or a command line without the ROM, and answers each with a line of JSON (`{"id", "code", "text"}`, `"json"` with `--json`, or `{"id", "error"}`). Machines that persist are forks:

```
fork a                          powered on
run --fork a --frames 600 --keys 300-305:STA
fork b --from a                 a copy of a
run --fork b --exec Stage::load --set r6=3 --frames 300
forks
drop b
quit
```

A command without `--fork` gets a fresh machine.

## Running App

With **Settings → Tools → Let tools connect** on, or the app started with `--probe`, VUEPort itself is the client. No Node needed.

```sh
VUEPort --probe game.vb &
VUEPort --probe-cli status
VUEPort --probe-cli capture now.png      # the screen as the player sees it
VUEPort --probe-cli pause
VUEPort --probe-cli vip objects          # any vbprobe command, on a copy of this moment
VUEPort --probe-cli fork one             # a copy that persists
VUEPort --probe-cli watch --fork one --frames 300 --write g_stats.lives --capture stack
VUEPort --probe-cli save now.vess
VUEPort --probe-cli quit                 # saves written first
```

On a Mac the binary is `VUEPort.app/Contents/MacOS/VUEPort`.

The running game can only be looked at, paused, saved and loaded, so the player never notices a tool. Everything else runs on a fork in a worker of the app, with the `.elf` beside the ROM for names. `export <dir>` writes cartridge, moment and `.elf` for `vbprobe` to continue without the app. Nothing works in hardcore mode or while two players are linked.

Underneath, it's one JSON object per line over a port on 127.0.0.1, with port and token in `~/.vueport/probe.json`. `VUEPort --probe-call '{"method":"registers"}'` sends a raw request. See [PROBE.md](PROBE.md) for scripting thousands of them.

## Library

```js
const { openMachine } = require('vueport-probe');
const { VbInput } = require('vueport-core/lib/probe');

const vb = await openMachine({ rom: 'game.vb', elf: 'game.elf' });
vb.input = new VbInput([VbInput.parseSpan('300-305:STA')]);
vb.runFrames(600);

const lives = vb.watch({ kind: 'write', at: 'g_stats.lives', capture: ['stack'] });
const moment = vb.snapshot();
vb.runUntil({ predicate: m => m.read8('g_stats.lives') === 0 }, { maxFrames: 5000 });
console.log(lives.summary());
vb.restore(moment);
```

Also available:

- Execution: `traceBranches`, `stopOnFault`, `startCoverage`, `runUntil({ vip: 'drawing' })`, `assemble` with `vb.patch`, `vb.clone()`
- Watches: `then` runs on each hit and may change registers and memory, `fold` counts hits by place
- Memory search: `VbSearch`
- Pictures: `readFrameBuffer`, `vb.keepOrigins()` and `vb.pixelOrigins()`, `annotatedPicture`, `decodePng`, `comparePictures`
- Hardware: `readVip`, `readObjects`, `readBgMap`, `readCharacter`, `readVbcState`, `readPool`, `readInstances`, `vb.vsu()`
- Profiling: `vb.startProfile()`, `vb.profile()`, `vb.profileFrames()`
- States: `vb.saveState()`, `vb.loadState(file, { otherRom: true })`

`openMachine` takes `rom`, `sram` and `elf` as paths or bytes. `VbMachine` itself touches no file system and runs wherever WebAssembly does.

A host with its own running game answers tools with `ProbeSession` (`vueport-core/lib/probe/probe-session`), given the game as a `ProbeTarget` and a channel to `probe-fork-worker.js`. The desktop app's transport is its local port, VUEngine Studio's an agent tool called `emulator`.

## Good to Know

- **Frames** are a twentieth of a second of clocks, as in the app. Buttons change at frame boundaries.
- **Stopping** mid-frame never shifts the frame timing. A write watch stops before the value lands; continuing performs the write once.
- **Addresses** are folded: 27 bits, WRAM every 64 KiB (256 KiB with VB Color's `WRAMEXT`), ROM at its size. Code running from `0xFFFxxxxx` shows up at `0x07xxxxxx`.
- **Names** cover what they name: `g_stats` all of it, `g_stats.lives` one field, `actors[3]` one element. On `--exec`, a function name is its entry; on `--when-pc`, the whole function. Fields need DWARF.
- **Call stacks** are followed, not unwound, so they only know calls made since following started.
- **Cost** is about 1.3 ms per frame on an M-series Mac. Read and write watches add a few percent, `exec` watches about 40 %, call stacks about 80 %.
- **Object groups** in `vip objects` come from SPT0-3 as they stand. Games that rewrite them mid-frame (Wario Land) make them meaningless at frame end.
- **Pixel origins** cost about as much as drawing again, and are forgotten by a loaded state.
- **Snapshots** are fast but only valid in their own machine. Save states (`.vess`) are the app's files. Neither includes Game Pak RAM.

## Tests

```sh
yarn workspace vueport-core test                                     # includes the machine
yarn workspace vueport-probe test
node packages/core/tests/probe-symbols-probe.mjs game.vb game.elf    # needs DWARF
node packages/desktop/tests/probe-mode-probe.mjs                     # the desktop app, end to end
```
