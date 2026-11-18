# VUEPort for tools and AI agents

VUEPort can be driven from a shell: by a script, or by an AI agent working on a
Virtual Boy game — developing one, or taking one apart. Nothing is needed but
VUEPort itself.

## Starting

```sh
VUEPort --probe game.vb          # play game.vb, and let tools connect
VUEPort --probe-cli help         # every command, from a second shell
```

`--probe` turns tools on until VUEPort quits. They can also be let in for good
in **Settings → Tools → Let tools connect**, which also has instructions with
this installation's path, ready to paste into an agent's conversation.

Where the binary is:

| | |
|---|---|
| macOS | `/Applications/VUEPort.app/Contents/MacOS/VUEPort` |
| Windows | `VUEPort.exe` where it was installed |
| Linux | `vueport` on the path, or the AppImage |

## The two kinds of command

**The game being played** is only looked at, paused, and has moments taken away
or put back, so that a tool never gets in the way of the person playing:

```sh
VUEPort --probe-cli status
VUEPort --probe-cli capture now.png       # the screen as the player sees it
VUEPort --probe-cli pause
VUEPort --probe-cli save here.vess
VUEPort --probe-cli load here.vess
VUEPort --probe-cli quit                  # VUEPort's own way out, saves written first
```

**Everything else runs on a fork**: a copy of the moment, inside VUEPort, that
can be run, stopped and watched without the game noticing. Without `--fork`, a
command gets a fresh copy of this moment, thrown away after; `fork <name>` keeps
one, and `--fork <name>` carries on with it, so a session can work step by step.

```sh
VUEPort --probe-cli regs                  # registers, now
VUEPort --probe-cli vip objects           # what the VIP draws, now
VUEPort --probe-cli fork one
VUEPort --probe-cli watch --fork one --frames 300 --write 0x05000010:4
VUEPort --probe-cli dis --fork one
```

With the build's `.elf` beside the ROM, addresses can be names
(`g_stats.lives`, `Actor::update`) and every report names the functions,
struct fields and source lines it touches.

Files named on a command line (`--state-in`, `--state-out`, `--shot`,
`capture`, `save`, `load`, `export`) are read from and written to the folder
the command was typed in.

## Recipes

**Who writes this byte, and from where?**

```sh
VUEPort --probe-cli watch --frames 600 --write 0x05010004 --capture stack
```

Many hits are folded by instruction; `--list` shows them one by one.

**Stop the moment it happens, and keep that moment:**

```sh
VUEPort --probe-cli fork bug
VUEPort --probe-cli regs --fork bug --frames 3000 --write g_player.health --when-value 0 --stop --state-out dead.vess
VUEPort --probe-cli dis --fork bug
```

A watch stops *before* a write lands: memory still holds the old value, and the
PC is on the storing instruction.

**Play forward with buttons:**

```sh
VUEPort --probe-cli run --fork one --frames 200 --keys 0-10:STA --keys 100-140:A+RIGHT --shot 200:after.png
```

**Which code does pressing a button run?** Pause, so that both runs copy the
same moment; keep what runs without the button, then compare:

```sh
VUEPort --probe-cli pause
VUEPort --probe-cli coverage --frames 60 --coverage-out idle.cov
VUEPort --probe-cli coverage --frames 60 --keys 0-5:STA --against idle.cov
```

**Where does the game keep a number?** Search, change it in the game, keep
what changed the same way, repeat:

```sh
VUEPort --probe-cli fork s
VUEPort --probe-cli search --fork s --candidates lives.search            # snapshot of WRAM
VUEPort --probe-cli search --fork s --frames 200 --keys 0-200:RIGHT --op decreased --candidates lives.search
VUEPort --probe-cli search --fork s --frames 50 --op unchanged --candidates lives.search
```

**How did it get there, and where does it fall over?**

```sh
VUEPort --probe-cli run --fork bug --frames 3000 --stop-on-fault --branches 32
```

`--branches` keeps the last branches the program took (a loop is one line
with a count); `--stop-on-fault` stops before a zero division, an invalid
opcode, an FPU fault or an address trap is taken.

**The VIP's beat:** `--until-vip drawing` / `drawn` stop as the drawing
processor starts and finishes a framebuffer, `--until-vip frame` as a frame is
shown, and `framestart`, `gamestart`, `xpend`… as their interrupt request comes
on.

**Which world or object is which:**
`shot objects.png --annotate objects` and `--annotate worlds` draw their
frames and numbers over the screen, to go with `vip objects` and `vip worlds`.

**Try a change to the code without building:** `asm` assembles into a fork,
ROM included, before it runs; `dis` output can be pasted back in.

```sh
VUEPort --probe-cli asm --fork one 0x0701A2B0 "movea 99, r0, r10; jmp [lp]" --frames 300
```

**What is on screen, as data:** `vip`, `vip worlds`, `vip objects`,
`vip bgmap 3 0,0,16,8`, `vip char 1101`, `vsu`, `vbc`; for a VUEngine game,
`pool` and `actors --fields`.

**What drew this pixel?** `origin` names the world, the BG map cell or object,
the character and which of its pixels, and the palette — or the instruction
that wrote the pixel into the frame buffer itself:

```sh
VUEPort --probe-cli origin 192,112                 # one pixel, in full
VUEPort --probe-cli origin 120,80,140,40           # a region, by what drew it
VUEPort --probe-cli origin --out title.json        # every pixel, as data
```

The core keeps this only from the first time a machine is asked, so without
run options `origin` runs on until the VIP has drawn the buffer (and says how
far that was). On a fork kept for it, `--origins` turns it on early.

It also keeps what the frame was drawn *from*: the characters and the palettes
as they were when the VIP drew it. A game that loads new characters while the
frame is on show has not changed it, and `origin` shows the character as
drawn; `--out` JSON carries every character the pixels name, as drawn, and
the palettes (`vb.drawnCharacter`, `vb.drawnPalettes` in the library).

**Is the screen what it should be?** `compare` holds it against a picture kept
from before — a `shot`, or a PNG from anything else of the same size:

```sh
VUEPort --probe-cli compare title.png                       # same, or how many pixels differ and where
VUEPort --probe-cli compare title.png 0,0,384,24 --out diff.png   # only the HUD; the differences in magenta
VUEPort --probe-cli compare title.png --tolerance 2         # a channel may be 2 off
```

It exits 1 when pixels differ, for a script to go on. `decodePng` and
`comparePictures` are the same in the library.

**Where does a frame's time go?** `profile` measures the run the way the app's
CPU Profiler does — each instruction's cost to the clock, frame by frame:
what was work, what was waiting (a loop going round until the interrupt it
was waiting for came) and what was halted, the busiest frames, and the
functions by their own time:

```sh
VUEPort --probe-cli profile --fork one --frames 300          # summary
VUEPort --probe-cli profile --fork one --frames 300 --list   # and every frame
```

**The frame buffers themselves**, not the picture: `fb` gives the shades 0-3
the VIP drew, `fb --color` a VB Color game's palette ids (the colour shown is
`CRAM[id * 4 + shade]`). Either eye, `shown`, `drawn` or buffer `0`/`1`:

```sh
VUEPort --probe-cli fb right drawn 100,40,32,8     # a region, printed
VUEPort --probe-cli fb --color --out ids.bin       # 384x224 bytes, row by row
```

**Change the machine on the way:** `--set` sets a register or memory at every
hit of the watches given, or before the run without any:

```sh
VUEPort --probe-cli run --fork one --exec Course::load --set r6=12 --frames 600 --shot 600:course12.png
VUEPort --probe-cli run --fork one --set g_stats.lives=9
```

**Until something has been loaded**, rather than after a number of frames that
moves whenever the timing does: `--until-read` runs until every byte of a range
has been read — a block of characters copied out of the ROM — and
`--until-written` until every byte has been written. Either stops with that
access done. (VB Color's DMA reads the ROM without the CPU; it is not seen.)

```sh
VUEPort --probe-cli run --fork one --until-read 0x07012000:0x800 --frames 6000
```

**Who writes the frame buffers?** A watch on them, folded by column:

```sh
VUEPort --probe-cli watch --frames 50 --write 0x00000000:0x6000 --fold column
```

`--fold fb` folds by buffer, `--fold 256` by blocks of 256 bytes, for any
watch.

**All the code at once:** `dis 0x07000000..0x07040000 --out code.txt`
(`from-to` works for plain numbers too).

## Many questions from a script

Every `--probe-cli` call is a process of its own. A script asking thousands of
questions talks to VUEPort's port directly instead and keeps the connection:
each line it sends is a request, each line back its answer. Forks stay
between them, and `fork <name> --from <fork>` copies one as it stands, so a
branch costs nothing to try:

```python
import json, pathlib, socket

info = json.loads((pathlib.Path.home() / '.vueport' / 'probe.json').read_text())
stream = socket.create_connection(('127.0.0.1', info['port'])).makefile('rw')

def cli(*args):
    stream.write(json.dumps({'id': 1, 'token': info['token'], 'method': 'cli',
                             'params': {'args': list(args), 'inputs': {}}}) + '\n')
    stream.flush()
    answer = json.loads(stream.readline())
    if 'error' in answer:
        raise RuntimeError(answer['error'])
    return answer['result']['text']

cli('fork', 'start')
for course in range(16):
    cli('fork', f'c{course}', '--from', 'start')
    print(cli('regs', '--fork', f'c{course}', '--exec', '0x0701A2B0', '--set', f'r6={course}',
              '--frames', '300', '--json'))
    cli('drop', f'c{course}')
```

Files do not go by name here: a file a command reads travels in `inputs`
(path → base64), and the files it writes come back in the answer's `outputs`.

Without the app, `vbprobe serve game.vb` is the same for a ROM file: one
process, requests on standard input — `{"id": 1, "args": [...]}` or a command
line as typed — and a line of JSON back for each, with forks that stay.

**A survey over a whole game** is bound by the emulation itself: a frame of a
busy game costs the core several milliseconds, and keeping pixel origins adds
under one. So run several `vbprobe serve` processes side by side — one per
course, one per core of the machine — and keep origins on only around the
frames that are read: they have to be on while a frame is drawn, and only
then (`origins` on two frames before). `vb.pixelOrigins(eye, buffer, region)`
copies only the region asked about.

**A state of an earlier build:** a save state is bound to the ROM it was made
with. `--other-rom` (with `--state-in`, `fork --state-in` in `vbprobe serve`,
and `load` in the app) takes one of another ROM anyway and empties the CPU's
instruction cache after, which still held the old build's code. That is all a
new build of the same game needs as long as it did not move code or RAM
around; the app asks the same question before loading such a state.

## Things to know

- A frame is a fiftieth of a second, as in the app. A fork's frame count starts
  at 0.
- A fork does not get the player's later input; give it buttons with `--keys`.
- Call stacks are followed from when a fork starts, not unwound, so they hold
  the calls made since.
- Addresses are folded: a program running from `0xFFFxxxxx` shows up at
  `0x07xxxxxx`, and WRAM repeats every 64 KiB (256 KiB once a VB Color game
  turns on `WRAMEXT`).
- Nothing works while a game is in RetroAchievements hardcore mode or two
  players are linked.
- On Windows, run it with its output going somewhere (a pipe, as agents do):
  VUEPort is a windowed program, and a console it is typed into does not wait
  for it or show what it prints.

## Underneath

VUEPort listens on a port on 127.0.0.1 and writes the port and a token to
`~/.vueport/probe.json`, readable by the user alone. The protocol is one JSON
object per line:

```json
{"id": 1, "token": "…", "method": "cli", "params": {"args": ["regs"], "inputs": {}}}
```

`VUEPort --probe-call '{"method":"registers"}'` sends one request with the
token filled in. A connection takes any number of requests, one after the
other.

`origin --out file.bin` writes two little-endian 32-bit words a pixel, row by
row, 384 by 224:

| word | bits | |
|---|---|---|
| what | 0-2 | kind: 0 unknown, 1 backdrop, 2 BG map cell, 3 overplane cell, 4 object, 5 CPU write, 6 debugger write |
| | 3-7 | world |
| | 8-19 | character |
| | 20-25 | pixel within the character as stored (flip undone), y × 8 + x |
| | 26-27 | flip, h × 2 + v |
| | 28-29 | the character's pixel value; the backdrop's shade; the value written |
| | 30-31 | palette: GPLT for cells, JPLT for objects |
| where | 0-15 | cell index in BG map memory (segment × 4096 + y × 64 + x), or the object's index |
| | 16-23 | the VB Color palette id drawn, when bit 24 is set |
| | 25-26 | what chose that palette: 1 the cell's or object's color attribute, 2 the character's (CCEN), 3 a pixel color slot (PCE); for the backdrop 1 CBKPAL, 2 the backdrop row table |
| | 27 | a world palette offset was added to it |
| | 0-31 | for a write: the PC of the instruction |
 `vbprobe` (`packages/probe`) is the same set of commands as a
Node program for ROM files, without the app; VUEngine Studio offers them to
its agents as the tool `emulator`.
