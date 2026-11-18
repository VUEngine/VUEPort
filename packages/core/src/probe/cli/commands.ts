import { parseVesMovie } from '../../common/emulator-movie';
import { VbInput } from '../vb-input';
import { formatKeys, parseKeys } from '../vb-keys';
import { ScanDataType, ScanOperator } from '../../common/emulator-cheat-scan';
import { annotatedPicture, VbAnnotation } from '../vb-annotate';
import { assemble } from '../vb-asm';
import { exceptionName, VB_VIP_EVENTS, VbInstruction, VbMachine, VbRunResult, VbVipEvent } from '../vb-machine';
import { frameBufferPicture, frameBufferPlace, readFrameBuffer, VbFrameBufferEye } from '../vb-framebuffer';
import { readVbcState } from '../vb-inspect';
import { decodeOrigin, describeOrigin, originSource, VbPixelOrigin } from '../vb-origin';
import { encodePng, VbEye, VbPicture } from '../vb-picture';
import { comparePictures, decodePng } from '../vb-compare';
import { VbSearch } from '../vb-search';
import { VbWatch, VbWatchHit, VbWatchKind, VbWatchSpec, VbWatchTarget } from '../vb-watch';
import { VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH } from '../../common/vb-constants';
import { VES_LIVE_PROFILE_ROOT } from '../../common/emulator-live-profile';
import { hex32, hexDump } from './format';
import { actorsCommand, poolCommand, vbcCommand, vipCommand, vsuCommand } from './inspect-commands';

// the commands, apart from where they run: no file system and no process, so a command line means the same to
// vbprobe in a terminal and to the desktop app, which runs it on a fork of the game being played

// the part of the help that is the same wherever the commands run
export const COMMANDS_HELP = `commands
  run                       run, then report where the machine is
  peek <addr[:len]>...      hex dump memory (len defaults to 64)
  regs                      program and system registers
  dis [addr] [count]        disassemble, from the PC by default (count 16);
  dis <from>..<to>          or all of a range (from-to with plain numbers);
                            --out <file> writes it instead of printing it
  shot <file.png>           screenshot
  fb [left|right] [shown|drawn|0|1] [x,y,w,h]
                            a frame buffer as the VIP keeps it, not as shown:
                            shades 0-3, or with --color the VB Color frame
                            buffer's palette ids (the colour is CRAM[id*4 +
                            shade]). Left and shown by default; a region
                            prints its values, --out <file> writes all of
                            them: .bin a byte a pixel row by row, .json, .png
  origin [left|right] [shown|drawn|0|1] [x,y | x,y,w,h]
                            what drew the pixels of a frame buffer: world, BG
                            map cell or object, character and which of its
                            pixels, palette — or the code that wrote them. A
                            pixel in full, a region by what drew it, the
                            screen by world; --out <file> writes every pixel
                            (.json, or .bin: two 32-bit words a pixel, row by
                            row, as packages/probe/PROBE.md says). Kept from
                            the first time a machine is asked (or --origins),
                            so without run options it runs on until that
                            buffer is drawn
  compare <ref.png> [x,y,w,h]
                            the screen held against a picture kept from before
                            (a shot, or any PNG of the same size — --scale is
                            worked out from it): how many pixels differ, where,
                            by how much; --tolerance <n> lets each channel be n
                            off, --out <diff.png> marks them. Exits 1 when
                            pixels differ
  watch                     run with the watches below and report what they saw

  vip [what]                the VIP: overview (default), registers, worlds,
                            objects (--all for every one), bgmap <segment>
                            [x,y,w,h], char <index>
  vsu                       the sound unit's six channels
  vbc                       VB Color switches and CRAM (--cram for all of it)
  pool                      VUEngine's memory pools, by class (needs --elf)
  actors [class]            VUEngine objects of a class, Actor by default,
                            with --fields for every field (needs --elf)

  profile                   where the run's time went, frame by frame, as the
                            app's CPU Profiler measures it: busy, waiting (a
                            loop going round until an interrupt) and halted
                            clocks against the frame's budget, the busiest
                            frames, and functions by their own time; --list
                            for every frame
  coverage                  which code ran, by function or by address range;
                            --coverage-out <file> keeps it, --against <file>
                            shows what ran now and not then, and the other way
  search [region]           where a value is kept: wram (default), sram or
                            start:length. --candidates <file> carries a search
                            from one call to the next; each call snapshots,
                            runs, and with --op keeps the addresses whose value
                            did that: eq ne gt lt (with --value), changed,
                            unchanged, increased, decreased. --type u8 (default)
                            s8 u16 s16 u32 s32
  asm <addr> [source]       assemble into the machine at addr before it runs
                            (ROM included); statements split by ; or from
                            --asm-file <file>. --out <file> keeps the bytes,
                            --dry only lists them. dis output reads back in

  Every command takes its machine, applies --state-in, runs as the run
  options say, then does its job. Addresses are numbers (0x05000000) or, with
  the build's .elf, symbols with an optional offset (main, Actor::update+0x10).

state
  --state-in <file>         load a VUEPort save state (.vess) first
  --state-out <file>        save one at the end, loadable in the app
  --other-rom               take a state made with another ROM too — another
                            build of the game, say — emptying the CPU's
                            instruction cache after; fine as long as the build
                            did not move code or memory around

running
  --frames <n>              run n frames (50 per second)
  --until <addr>            run until the PC reaches addr (gives up after
                            --frames, default 3000)
  --keys <from-to:keys>     hold buttons over frames, e.g. 120-180:A+RIGHT,
                            120:STA, 120+30:B (repeatable)
  --hold <keys>             hold buttons on every other frame
  --movie <file>            play a VUEPort/VBjin movie (.mc2) from frame 0
  --shot <frame:file.png>   screenshot at a frame on the way (repeatable)
  --until-vip <event>       run until the VIP gets there: frame (a frame shown),
                            drawing, drawn (the drawing processor starting and
                            finishing a framebuffer), or an interrupt request:
                            framestart gamestart xpend sbhit lfbend rfbend
                            timeerr scanerr (seen as its INTPND bit coming on)
  --stop-on-fault           stop before the CPU takes a fault: zero division,
                            invalid opcode, an FPU fault, an address trap
  --origins                 keep what draws each pixel from now on, for origin
  --branches <n>            keep the last n branches and print them: how the
                            program got where it is (or where it fell over)
  --until-read <addr:len>   run until every byte of a range has been read, as
                            a block of characters copied out of the ROM is
                            (by the CPU; the VB Color DMA is not seen)
  --until-written <addr:len>
                            run until every byte of a range has been written;
                            either one stops with that access done
  --set <what=value>        a register (r6=0x1234, sp=…) or memory (0x05000010=7,
                            0x05000010:4=…, g_stats.lives=3) set to a value:
                            at every hit of the watches, before a stop, or
                            before the run without any (repeatable)

watches (with any command; several of each are fine)
  --write <addr[:len]>      who writes here; a name is as big as the build says
                            (g_stats, g_stats.lives, actors[3]), a number one byte
  --read <addr[:len]>       who reads here
  --access <addr[:len]>     either
  --exec <addr[:len]>       when this code runs; a function's name is its
                            entry, so each hit is a call
  --when-value <v|min-max>  only hits writing or reading these values
  --when-changed            only writes that change the value
  --when-pc <addr[:len]>    only hits from this code (a function's name works)
  --when-frames <from-to>   only hits in these frames
  --capture <what,...>      take down regs, stack, or registers by name (r6,lp)
  --stop                    stop the machine at the first hit
  --limit <n>               hits to keep per watch (default 1000)
  --list | --group          hits one by one, or folded by instruction (the
                            default when there are more than 20)
  --fold <how>              hits folded by place as well: column (of a frame
                            buffer), fb (which frame buffer), or <n> (blocks
                            of n bytes)

output
  --eye <left|right|both>   which eye screenshots show (default left)
  --scale <n>               enlarge screenshots
  --annotate <what>         draw worlds or objects, with their numbers, over
                            screenshots
  --count <n>               lines for dis
  --json                    machine-readable output
  --terminal                print what the game wrote to the debug port
  --essound                 print the ESSound commands the game sent

buttons: A B L R STA SEL LU LD LL LR RU RD RL RR, and UP DOWN LEFT RIGHT for
the left pad; join with +.
`;

export interface CliOptions {
    positional: string[];
    values: Map<string, string[]>;
    flags: Set<string>;
}

const VALUE_OPTIONS = new Set([
    'elf', 'sram', 'hardware', 'state-in', 'state-out', 'frames', 'until', 'keys', 'hold', 'movie', 'shot',
    'eye', 'scale', 'count',
    'write', 'read', 'access', 'exec', 'when-value', 'when-pc', 'when-frames', 'capture', 'limit',
    'fork',
    'until-vip', 'branches', 'annotate', 'coverage-out', 'against', 'candidates', 'type', 'op', 'value', 'asm-file', 'out',
    'set', 'fold', 'until-read', 'until-written', 'from', 'tolerance',
]);
const FLAG_OPTIONS = new Set([
    'json', 'terminal', 'essound', 'help', 'stop', 'when-changed', 'list', 'group', 'all', 'fields', 'cram', 'plain',
    'stop-on-fault', 'dry', 'color', 'origins', 'other-rom',
]);
const WATCH_KINDS: VbWatchKind[] = ['write', 'read', 'access', 'exec'];

export function parseArguments(args: string[]): CliOptions {
    const options: CliOptions = { positional: [], values: new Map(), flags: new Set() };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith('--')) {
            options.positional.push(arg);
            continue;
        }
        const [name, inline] = arg.slice(2).split(/=([\s\S]*)/, 2);
        if (FLAG_OPTIONS.has(name)) {
            options.flags.add(name);
        } else if (VALUE_OPTIONS.has(name)) {
            const value = inline ?? args[++i];
            if (value === undefined) {
                throw new Error(`--${name} needs a value.`);
            }
            options.values.set(name, [...options.values.get(name) ?? [], value]);
        } else {
            throw new Error(`Unknown option --${name}. See help.`);
        }
    }
    return options;
}

export function last(options: CliOptions, name: string): string | undefined {
    const values = options.values.get(name);
    return values?.[values.length - 1];
}

export function count(options: CliOptions, name: string, fallback: number): number {
    const text = last(options, name);
    if (text === undefined) {
        return fallback;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`--${name} needs a whole number, not "${text}".`);
    }
    return value;
}

// vbprobe opens the ROM named on its command line and uses the file system; the desktop app hands over a fork
// of the running game and the files the caller sent, and sends written ones back
export interface CliHost {
    readonly help: string;
    // the machine to work on, and the positional arguments left for the command after whatever this took
    open(options: CliOptions, positional: string[]): Promise<{ vb: VbMachine, rest: string[] }>;
    read(path: string): Uint8Array;
    write(path: string, bytes: Uint8Array): void;
}

export interface CliResult {
    text: string;
    code: number; // 0; 1 for a compare that found pixels differing; 2 for a machine that stopped advancing
}

export const MACHINE_COMMANDS = [
    'run', 'peek', 'regs', 'dis', 'shot', 'compare', 'fb', 'origin', 'profile', 'watch', 'vip', 'vsu', 'vbc', 'pool', 'actors', 'coverage', 'search', 'asm',
];

// throws for a mistake in the command line
export async function runCommand(args: string[], host: CliHost): Promise<CliResult> {
    const options = parseArguments(args);
    const [command, ...positional] = options.positional;
    if (command === undefined || command === 'help' || options.flags.has('help')) {
        return { text: host.help, code: 0 };
    }
    if (!MACHINE_COMMANDS.includes(command)) {
        throw new Error(`Unknown command "${command}". See help.`);
    }

    const { vb, rest } = await host.open(options, positional);
    const stateIn = last(options, 'state-in');
    if (stateIn) {
        await vb.loadState(host.read(stateIn), { otherRom: options.flags.has('other-rom') });
    }

    const report: Record<string, unknown> = {};
    const lines: string[] = [];

    const branchDepth = last(options, 'branches') !== undefined ? count(options, 'branches', 64) : 0;
    if (branchDepth > 0) {
        vb.traceBranches(branchDepth);
    }
    if (options.flags.has('stop-on-fault')) {
        vb.stopOnFault = true;
    }
    if (command === 'coverage') {
        vb.startCoverage();
    }
    if (command === 'profile') {
        // every frame of the run kept, however long it is
        vb.startProfile(Math.max(1, count(options, 'frames', 3000)) + 1);
    }
    if (command === 'origin' || options.flags.has('origins')) {
        vb.keepOrigins();
    }
    const search = command === 'search' ? openSearch(vb, rest, options, host, lines) : undefined;
    if (command === 'asm') {
        report.asm = asmCommand(vb, rest, options, host, lines);
    }

    const sets = parseSets(vb, options);
    const watches = createWatches(vb, options, sets);
    if (sets.entries.length > 0 && watches.length === 0) {
        applySets(vb, sets);
        lines.push(`set ${sets.entries.map(entry => entry.text).join(', ')} before the run`);
    }
    const run = await runPhase(vb, options, lines, host);
    report.run = { ...run, stop: run.stop && { ...run.stop, watch: run.stop.watch?.id } };
    if (sets.entries.length > 0) {
        report.set = { entries: sets.entries.map(entry => entry.text), applied: sets.applied };
        if (watches.length > 0) {
            lines.push(`set ${sets.entries.map(entry => entry.text).join(', ')} at ${sets.applied} hit${sets.applied === 1 ? '' : 's'}`);
        }
    }
    if (watches.length > 0) {
        report.watches = reportWatches(vb, watches, run.frames, options, lines);
    }

    switch (command) {
        case 'run':
        case 'watch':
            break;
        case 'peek':
            report.peek = peek(vb, rest, lines);
            break;
        case 'regs':
            report.registers = registers(vb, lines);
            break;
        case 'dis':
            report.instructions = dis(vb, rest, options, host, lines);
            break;
        case 'fb':
            report.fb = await fbCommand(vb, rest, options, host, lines);
            break;
        case 'compare':
            report.compare = await compareCommand(vb, rest, options, host, lines);
            break;
        case 'origin':
            report.origin = originCommand(vb, rest, options, host, lines);
            break;
        case 'profile':
            report.profile = profileCommand(vb, options, lines);
            vb.stopProfile();
            break;
        case 'vip':
            report.vip = vipCommand(vb, rest, options.flags.has('all'), lines);
            break;
        case 'vsu':
            report.vsu = vsuCommand(vb, lines);
            break;
        case 'vbc':
            report.vbc = vbcCommand(vb, options.flags.has('cram'), lines);
            break;
        case 'pool':
            report.pool = poolCommand(vb, lines);
            break;
        case 'actors':
            report.actors = actorsCommand(vb, rest, options.flags.has('fields'), lines);
            break;
        case 'coverage':
            report.coverage = coverageCommand(vb, options, host, lines);
            break;
        case 'search':
            report.search = searchStep(vb, search!, options, host, lines);
            break;
        case 'asm':
            break;
        case 'shot': {
            const file = rest[0];
            if (!file) {
                throw new Error('shot needs a file to write.');
            }
            host.write(file, await shot(vb, options));
            lines.push(`wrote ${file} (frame ${vb.frame})`);
            report.shot = file;
            break;
        }
    }

    if (branchDepth > 0) {
        const branches = vb.branches();
        report.branches = branches;
        lines.push(`last ${branches.length} branch${branches.length === 1 ? '' : 'es'}, oldest first:`);
        for (const branch of branches) {
            lines.push(`  ${vb.describe(branch.from)} → ${vb.describe(branch.to)}${branch.times ? `  ×${branch.times}` : ''}`
                + `${branch.exception ? `  (${exceptionName(branch.exception)})` : ''}`);
        }
    }
    if (options.flags.has('terminal')) {
        report.terminal = vb.terminal;
        lines.push('terminal:', ...vb.terminal.split('\n').map(line => `  ${line}`));
    }
    if (options.flags.has('essound')) {
        const commands = vb.takeEsSound();
        report.esSound = commands;
        lines.push(`essound: ${commands.length === 0 ? 'nothing' : commands.map(value => value.toString(16).padStart(4, '0')).join(' ')}`);
    }
    const stateOut = last(options, 'state-out');
    if (stateOut) {
        host.write(stateOut, await vb.saveState('vbprobe'));
        lines.push(`wrote ${stateOut} (frame ${vb.frame})`);
        report.stateOut = stateOut;
    }

    const differs = (report.compare as { differing?: number } | undefined)?.differing;
    return {
        text: options.flags.has('json') ? JSON.stringify(report, undefined, 2) : lines.join('\n'),
        code: run.stalled ? 2 : differs ? 1 : 0,
    };
}

async function runPhase(vb: VbMachine, options: CliOptions, lines: string[], host: CliHost): Promise<VbRunResult & { pc: number, where: string }> {
    const input = new VbInput();
    for (const spec of options.values.get('keys') ?? []) {
        input.add(VbInput.parseSpan(spec));
    }
    const movie = last(options, 'movie');
    if (movie) {
        input.setMovie(parseVesMovie(new TextDecoder().decode(host.read(movie))).frames);
    }
    vb.input = input;
    const hold = last(options, 'hold');
    if (hold) {
        vb.keys = parseKeys(hold);
    }

    const shots = (options.values.get('shot') ?? []).map(spec => {
        const match = /^(\d+):(.+)$/.exec(spec);
        if (!match) {
            throw new Error(`--shot takes frame:file.png, not "${spec}".`);
        }
        return { frame: Number(match[1]), file: match[2] };
    }).sort((a, b) => a.frame - b.frame);

    const until = last(options, 'until');
    const untilVip = last(options, 'until-vip') as VbVipEvent | undefined;
    if (untilVip !== undefined && !VB_VIP_EVENTS.includes(untilVip)) {
        throw new Error(`--until-vip takes ${VB_VIP_EVENTS.join(', ')}, not "${untilVip}".`);
    }
    const untilRange = untilRangeWatch(vb, options);
    const frames = count(options, 'frames', until !== undefined || untilVip !== undefined || untilRange ? 3000 : 0);
    const end = vb.frame + frames;
    let result: VbRunResult = { frames: 0, frame: vb.frame };
    const add = (next: VbRunResult) => {
        result = { ...next, frames: result.frames + next.frames };
    };

    if (until !== undefined) {
        vb.addBreakpoint(until);
    }
    for (const shotAt of shots) {
        if (shotAt.frame > vb.frame && shotAt.frame <= end) {
            add(vb.runFrames(shotAt.frame - vb.frame));
            if (result.stop || result.stalled) {
                break;
            }
        }
        if (shotAt.frame === vb.frame) {
            host.write(shotAt.file, await shot(vb, options));
            lines.push(`wrote ${shotAt.file} (frame ${vb.frame})`);
        }
    }
    if (!result.stop && !result.stalled && vb.frame < end) {
        add(untilVip !== undefined ? vb.runUntil({ vip: untilVip }, { maxFrames: end - vb.frame }) : vb.runFrames(end - vb.frame));
    }
    if (until !== undefined) {
        vb.removeBreakpoint(until);
        if (result.stop?.reason === 'breakpoint') {
            result.stop.reason = 'until';
        }
    }
    let rangeDone: string | undefined;
    if (untilRange) {
        vb.unwatch(untilRange.watch);
        if (result.stop?.watch === untilRange.watch) {
            // stopped in the access that completes the range, before it is done: finish that instruction so the range
            // is all there
            const completing = result.stop.hit!;
            const finished = vb.step(1);
            result = { ...result, frames: result.frames + finished.frames, frame: vb.frame, stalled: finished.stalled };
            result.stop = { reason: 'until', pc: vb.pc, frame: vb.frame };
            rangeDone = `${untilRange.option}, the last of it by ${vb.describe(completing.pc)}`;
        }
    }

    const where = vb.describe(vb.pc);
    lines.unshift(`frame ${vb.frame}  pc ${where}  keys ${formatKeys(vb.input?.keysAt(vb.frame) ?? vb.keys)}`);
    if (result.stop) {
        const hit = result.stop.hit;
        const why = hit ? `, watch ${hit.watch}: ${hitText(vb, hit)}` : '';
        const reason = result.stop.exception !== undefined ? `fault: ${exceptionName(result.stop.exception)}`
            : rangeDone ?? (result.stop.reason === 'until' && untilVip !== undefined && until === undefined ? `until ${untilVip}` : result.stop.reason);
        lines.splice(1, 0, `stopped (${reason}) at ${vb.describe(result.stop.pc)} in frame ${result.stop.frame}${why}`);
    } else if (untilRange) {
        lines.splice(1, 0, `did not get to ${untilRange.option} in ${frames} frames: ${untilRange.done()} of ${untilRange.watch.length} bytes`);
    } else if (until !== undefined || untilVip !== undefined) {
        lines.splice(1, 0, `did not reach ${until ?? untilVip} in ${frames} frames`);
    }
    if (result.stalled) {
        lines.splice(1, 0, `the machine stopped advancing (stalled)${last(options, 'branches') === undefined ? '; --branches 64 shows how it got there' : ''}`);
    }
    return { ...result, pc: vb.pc, where };
}

// the watches the options ask for, all sharing the given conditions: one call is one question
function createWatches(vb: VbMachine, options: CliOptions, sets: CliSets): VbWatch[] {
    const when: VbWatchSpec['when'] = {};
    const value = last(options, 'when-value');
    if (value !== undefined) {
        const range = /^(0x[0-9a-f]+|\d+)-(0x[0-9a-f]+|\d+)$/i.exec(value);
        const single = Number(value);
        if (!range && Number.isNaN(single)) {
            throw new Error(`--when-value takes a number or min-max, not "${value}".`);
        }
        when.value = range ? [Number(range[1]), Number(range[2])] : single;
    }
    if (options.flags.has('when-changed')) {
        when.changed = true;
    }
    const pc = last(options, 'when-pc');
    if (pc !== undefined) {
        when.pc = targetOf(pc);
    }
    const frames = last(options, 'when-frames');
    if (frames !== undefined) {
        const match = /^(\d+)-(\d+)$/.exec(frames);
        if (!match) {
            throw new Error(`--when-frames takes from-to, not "${frames}".`);
        }
        when.frames = [Number(match[1]), Number(match[2])];
    }
    const capture = (options.values.get('capture') ?? []).flatMap(text => text.split(',')).map(text => text.trim()).filter(Boolean);
    const limit = last(options, 'limit');
    const fold = foldOf(last(options, 'fold'));
    const then = sets.entries.length > 0 ? () => applySets(vb, sets) : undefined;

    const watches: VbWatch[] = [];
    for (const kind of WATCH_KINDS) {
        for (const at of options.values.get(kind) ?? []) {
            watches.push(vb.watch({
                kind,
                at: targetOf(at),
                when: Object.keys(when).length > 0 ? when : undefined,
                action: options.flags.has('stop') ? 'stop' : 'log',
                capture: capture.length > 0 ? capture : undefined,
                limit: limit !== undefined ? count(options, 'limit', 1000) : undefined,
                fold: fold?.key,
                then,
            }));
        }
    }
    return watches;
}

// `0x05000010:4`, `0x05000010`, `g_stats.lives`, `Actor::update`
function targetOf(text: string): VbWatchTarget {
    const split = text.lastIndexOf(':');
    // `::` is a method name, not a length
    if (split > 0 && text[split - 1] !== ':' && /^(0x[0-9a-f]+|\d+)$/i.test(text.slice(split + 1))) {
        return [text.slice(0, split), Number(text.slice(split + 1))];
    }
    return text;
}

function reportWatches(vb: VbMachine, watches: VbWatch[], frames: number, options: CliOptions, lines: string[]): unknown[] {
    return watches.map(watch => {
        const size = watch.end - watch.start;
        // as asked for, and what that is where it differs: a mirror folded, or a number the build has a name for
        const given = Array.isArray(watch.spec.at) ? watch.spec.at[0] : watch.spec.at;
        const number = typeof given === 'number' ? given : /^(0x[0-9a-f]+|\d+)$/i.test(given.trim()) ? Number(given) : undefined;
        const asGiven = number !== undefined ? hex(number, 4) : given;
        const folded = vb.describe(watch.start);
        const where = `${asGiven}${folded === asGiven || number === undefined ? '' : ` = ${folded}`}${size > 1 ? ` (${size} bytes)` : ''}`;
        const summary = watch.summary();
        const grouped = options.flags.has('group') || (!options.flags.has('list') && watch.count > 20);
        lines.push(`watch ${watch.id}  ${watch.spec.kind} ${where}  ${watch.count} hit${watch.count === 1 ? '' : 's'}`
            + ` in ${frames} frame${frames === 1 ? '' : 's'}${grouped ? `, ${summary.length} place${summary.length === 1 ? '' : 's'}` : ''}`);
        if (grouped) {
            for (const group of summary.slice(0, 50)) {
                const values = !group.values ? ''
                    : group.values[0] === group.values[1] ? `  value ${hex(group.values[0])}` : `  values ${hex(group.values[0])}–${hex(group.values[1])}`;
                const span = group.firstFrame === group.lastFrame ? `frame ${group.firstFrame}` : `frames ${group.firstFrame}–${group.lastFrame}`;
                // which part of a bigger watch this instruction touched
                const target = watch.spec.kind === 'exec' || size === 1 ? ''
                    : `  at ${group.addresses[0] === group.addresses[1] ? vb.describe(group.addresses[0])
                        : `${vb.describe(group.addresses[0])} … ${hex(group.addresses[1], 4)}`}`;
                lines.push(`  pc ${vb.describe(group.pc).padEnd(36)} ${String(group.count).padStart(7)}×  ${span}${target}${values}`);
            }
            if (summary.length > 50) {
                lines.push(`  … ${summary.length - 50} more`);
            }
        } else {
            for (const hit of watch.hits) {
                lines.push(`  ${hitText(vb, hit)}`);
            }
            if (watch.count > watch.hits.length) {
                lines.push(`  … ${watch.count - watch.hits.length} more not kept (--limit)`);
            }
        }
        const places = watch.spec.fold ? watch.places() : undefined;
        if (places) {
            const fold = foldOf(last(options, 'fold'))!;
            lines.push(`  by ${fold.title}, ${places.length} place${places.length === 1 ? '' : 's'}:`);
            for (const place of places.slice(0, 100)) {
                const span = place.firstFrame === place.lastFrame ? `frame ${place.firstFrame}` : `frames ${place.firstFrame}–${place.lastFrame}`;
                const pcs = place.pcs.slice(0, 3).map(entry => `${vb.describe(entry.pc)} ${entry.count}×`).join(', ');
                lines.push(`  ${fold.label(place.key, place.addresses).padEnd(36)} ${String(place.count).padStart(7)}×  ${span}  ${pcs}`
                    + `${place.pcs.length > 3 ? `, … ${place.pcs.length - 3} more` : ''}`);
            }
            if (places.length > 100) {
                lines.push(`  … ${places.length - 100} more`);
            }
        }
        return {
            id: watch.id,
            kind: watch.spec.kind,
            start: watch.start,
            end: watch.end,
            count: watch.count,
            hits: watch.hits,
            groups: summary,
            ...(places ? { places } : {}),
        };
    });
}

function hitText(vb: VbMachine, hit: VbWatchHit): string {
    const parts = [`f ${String(hit.frame).padStart(5)}`, `pc ${vb.describe(hit.pc)}`];
    if (hit.kind !== 'exec') {
        const value = hit.value !== undefined ? hex(hit.value, hit.size) : '?';
        parts.push(hit.kind === 'write' && hit.old !== undefined
            ? `${hit.kind} ${vb.describe(hit.address)}  ${hex(hit.old, hit.size)} → ${value}`
            : `${hit.kind} ${vb.describe(hit.address)}  ${value}`);
    }
    if (hit.regs) {
        parts.push(Object.entries(hit.regs).map(([name, value]) => `${name}=${hex(value, 4)}`).join(' '));
    }
    if (hit.stack) {
        parts.push(`stack ${hit.stack.map(address => vb.describe(address)).join(' ← ')}`);
    }
    return parts.join('  ');
}

function hex(value: number, size = 0): string {
    return `0x${(value >>> 0).toString(16).padStart(size * 2, '0')}`;
}

function shot(vb: VbMachine, options: CliOptions): Promise<Uint8Array> {
    const eye = last(options, 'eye') ?? 'left';
    if (!['left', 'right', 'both'].includes(eye)) {
        throw new Error('--eye is left, right or both.');
    }
    const annotate = last(options, 'annotate');
    if (annotate !== undefined) {
        if (annotate !== 'worlds' && annotate !== 'objects') {
            throw new Error('--annotate draws worlds or objects.');
        }
        if (eye === 'both') {
            throw new Error('--annotate draws over one eye at a time.');
        }
        // big enough for three-digit numbers on an eight-pixel object
        const scale = count(options, 'scale', annotate === 'objects' ? 4 : 2);
        return encodePng(annotatedPicture(vb, annotate as VbAnnotation, eye as 'left' | 'right', scale));
    }
    return vb.screenshot({ eye: eye as VbEye, scale: count(options, 'scale', 1) });
}

// a span of code that ran: a function, or a run of addresses with no gap wider than an instruction
interface CoverageSpan {
    start: number;
    end: number;
    instructions: number;
    hits: number; // how often its busiest instruction ran, which is about how often the span did
}

function coverageSpans(vb: VbMachine, counts: Map<number, number>): CoverageSpan[] {
    const spans: CoverageSpan[] = [];
    let current: (CoverageSpan & { owner?: number }) | undefined;
    for (const address of [...counts.keys()].sort((a, b) => a - b)) {
        const owner = vb.symbols?.functionAt(address)?.address;
        if (current && address - current.end <= 4 && owner === current.owner) {
            current.end = address;
            current.instructions++;
            current.hits = Math.max(current.hits, counts.get(address)!);
            continue;
        }
        current = { start: address, end: address, instructions: 1, hits: counts.get(address)!, owner };
        spans.push(current);
    }
    return spans.map(({ start, end, instructions, hits }) => ({ start, end, instructions, hits }));
}

function spanLines(vb: VbMachine, spans: CoverageSpan[], limit = 60): string[] {
    const lines = spans.slice(0, limit).map(span =>
        `  ${vb.describe(span.start).padEnd(40)} ${String(span.instructions).padStart(5)} instr  ${String(span.hits).padStart(8)}×`);
    if (spans.length > limit) {
        lines.push(`  … ${spans.length - limit} more`);
    }
    return lines;
}

function coverageCommand(vb: VbMachine, options: CliOptions, host: CliHost, lines: string[]): unknown {
    const counts = vb.coverage();
    vb.stopCoverage();
    const out = last(options, 'coverage-out');
    if (out) {
        host.write(out, new TextEncoder().encode(JSON.stringify({ version: 1, romSize: vb.romBytes, counts: [...counts] })));
        lines.push(`wrote ${out}`);
    }
    const against = last(options, 'against');
    if (against === undefined) {
        const spans = coverageSpans(vb, counts);
        lines.push(`coverage: ${counts.size} instructions ran, in ${spans.length} span${spans.length === 1 ? '' : 's'}:`);
        lines.push(...spanLines(vb, spans));
        return { instructions: counts.size, spans };
    }
    const other = JSON.parse(new TextDecoder().decode(host.read(against))) as { version: number, counts: [number, number][] };
    if (other.version !== 1 || !Array.isArray(other.counts)) {
        throw new Error(`${against} is not a coverage file.`);
    }
    const then = new Map(other.counts);
    const onlyNow = new Map([...counts].filter(([address]) => !then.has(address)));
    const onlyThen = new Map([...then].filter(([address]) => !counts.has(address)));
    const nowSpans = coverageSpans(vb, onlyNow);
    const thenSpans = coverageSpans(vb, onlyThen);
    lines.push(`ran now but not in ${against}: ${onlyNow.size} instructions in ${nowSpans.length} spans`);
    lines.push(...spanLines(vb, nowSpans));
    lines.push(`ran in ${against} but not now: ${onlyThen.size} instructions in ${thenSpans.length} spans`);
    lines.push(...spanLines(vb, thenSpans));
    return { onlyNow: nowSpans, onlyThen: thenSpans };
}

// the search a call carries on with, or a new one of the region as it is now, before the machine runs
function openSearch(vb: VbMachine, rest: string[], options: CliOptions, host: CliHost, lines: string[]): VbSearch {
    const file = last(options, 'candidates');
    if (file !== undefined) {
        let stored: Uint8Array | undefined;
        try {
            stored = host.read(file);
        } catch {
            lines.push(`${file} is not there yet: a new search`);
        }
        if (stored) {
            return VbSearch.fromState(JSON.parse(new TextDecoder().decode(stored)));
        }
    }
    return VbSearch.start(vb, rest[0] ?? 'wram', (last(options, 'type') ?? 'u8') as ScanDataType);
}

function searchStep(vb: VbMachine, search: VbSearch, options: CliOptions, host: CliHost, lines: string[]): unknown {
    const op = last(options, 'op') as ScanOperator | undefined;
    const valueText = last(options, 'value');
    const value = valueText !== undefined ? Number(valueText) : undefined;
    if (value !== undefined && Number.isNaN(value)) {
        throw new Error(`--value needs a number, not "${valueText}".`);
    }
    if (op !== undefined) {
        search.next(vb, op, value);
    }
    const file = last(options, 'candidates');
    if (file !== undefined) {
        host.write(file, new TextEncoder().encode(JSON.stringify(search.toState())));
    }
    const candidates = search.candidates(vb, 20);
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
    lines.push(`search (${search.type} from ${hex32(search.address)}): ${plural(search.count, 'candidate')} after ${plural(search.steps, 'step')}`
        + `${file !== undefined ? `, kept in ${file}` : ''}`);
    for (const candidate of candidates) {
        lines.push(`  ${vb.describe(candidate.address).padEnd(36)} now ${candidate.value}  before ${candidate.previous}`);
    }
    if (search.count > candidates.length) {
        lines.push(`  … ${search.count - candidates.length} more`);
    }
    return { count: search.count, steps: search.steps, candidates };
}

// assemble into the machine before it runs, so that a patch is what runs
function asmCommand(vb: VbMachine, rest: string[], options: CliOptions, host: CliHost, lines: string[]): unknown {
    const [where, ...source] = rest;
    if (where === undefined) {
        throw new Error('asm needs an address to assemble at.');
    }
    const file = last(options, 'asm-file');
    const text = file !== undefined ? new TextDecoder().decode(host.read(file)) : source.join(' ');
    if (!text.trim()) {
        throw new Error('asm needs something to assemble: give it after the address, or --asm-file.');
    }
    const origin = vb.resolve(where);
    const result = assemble(text, origin, {
        romSize: vb.romBytes,
        resolve: name => {
            try {
                return vb.resolve(name);
            } catch {
                return undefined;
            }
        },
    });
    for (const line of result.lines) {
        const bytes = line.bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ');
        lines.push(`  ${hex32(line.address)}  ${bytes.padEnd(11)}  ${line.source}`);
    }
    const out = last(options, 'out');
    if (out !== undefined) {
        host.write(out, result.bytes);
        lines.push(`wrote ${out} (${result.bytes.length} bytes)`);
    }
    if (!options.flags.has('dry')) {
        vb.patch(origin, result.bytes);
        lines.push(`patched ${result.bytes.length} bytes at ${vb.describe(origin)}`);
    }
    return { origin: result.origin, bytes: [...result.bytes], lines: result.lines };
}

function peek(vb: VbMachine, specs: string[], lines: string[]): { address: number, bytes: string }[] {
    if (specs.length === 0) {
        throw new Error('peek needs an address, e.g. 0x05000000:64.');
    }
    return specs.map(spec => {
        const split = spec.lastIndexOf(':');
        const address = vb.resolve(split > 0 ? spec.slice(0, split) : spec);
        const length = split > 0 ? Number(spec.slice(split + 1)) : 64;
        if (!Number.isInteger(length) || length <= 0 || length > 0x100000) {
            throw new Error(`Cannot read ${spec.slice(split + 1)} bytes.`);
        }
        const bytes = vb.read(address, length);
        lines.push(vb.describe(address));
        lines.push(...hexDump(address, bytes));
        return { address, bytes: [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('') };
    });
}

function registers(vb: VbMachine, lines: string[]): ReturnType<VbMachine['registers']> {
    const registerSet = vb.registers();
    lines.push(`pc   ${vb.describe(registerSet.pc)}`);
    for (let row = 0; row < 32; row += 4) {
        lines.push(registerSet.program.slice(row, row + 4)
            .map((value, index) => `${`r${row + index}`.padEnd(4)} ${hex32(value)}`).join('   '));
    }
    const system = Object.entries(registerSet.system);
    for (let row = 0; row < system.length; row += 4) {
        lines.push(system.slice(row, row + 4).map(([name, value]) => `${name.toLowerCase().padEnd(5)} ${hex32(value)}`).join('  '));
    }
    return registerSet;
}

function dis(vb: VbMachine, args: string[], options: CliOptions, host: CliHost, lines: string[]): VbInstruction[] {
    const range = args[0] !== undefined ? disRange(vb, args[0]) : undefined;
    let instructions: VbInstruction[];
    if (range) {
        instructions = [];
        let at = range[0];
        while (at < range[1]) {
            const chunk = vb.disassemble(at, Math.min(DIS_CHUNK, Math.ceil((range[1] - at) / 2)));
            const inRange = chunk.filter(instruction => instruction.address < range[1]);
            instructions.push(...inRange);
            const final = chunk[chunk.length - 1];
            const next = final ? (final.address + final.code.length * 2) >>> 0 : at;
            if (inRange.length < chunk.length || next <= at) {
                break;
            }
            at = next;
        }
    } else {
        const at = args[0] !== undefined ? vb.resolve(args[0]) : vb.pc;
        const lineCount = args[1] !== undefined ? Number(args[1]) : count(options, 'count', 16);
        instructions = vb.disassemble(at, lineCount);
    }

    const listing: string[] = [];
    let owner: string | undefined;
    let source: string | undefined;
    for (const instruction of instructions) {
        const routine = instruction.symbol?.replace(/\+0x[0-9a-f]+$/, '');
        if (routine !== owner && routine !== undefined) {
            listing.push(`${routine}:`);
        }
        owner = routine;
        const where = instruction.source ? `${instruction.source.file}:${instruction.source.line}` : undefined;
        if (where !== undefined && where !== source) {
            listing.push(`  ; ${where}`);
        }
        source = where;
        const marker = instruction.address === vb.pc ? '>' : ' ';
        const comment = instruction.comment ? `  ; ${instruction.comment}` : '';
        listing.push(`${marker} ${hex32(instruction.address)}  ${instruction.text.padEnd(28)}${comment}`);
    }
    const out = last(options, 'out');
    if (out !== undefined) {
        host.write(out, new TextEncoder().encode(`${listing.join('\n')}\n`));
        const first = instructions[0];
        const final = instructions[instructions.length - 1];
        lines.push(`wrote ${out}: ${instructions.length} instructions${first ? `, ${hex32(first.address)} to ${hex32(final.address)}` : ''}`);
    } else {
        lines.push(...listing);
    }
    return instructions;
}

const DIS_CHUNK = 4096; // the core's own limit on one request; a range is taken in pieces this size
// more than any Virtual Boy program, and less than a listing that would not fit in memory
const DIS_MAX_RANGE = 0x400000;

// `from..to`, or `from-to` with plain numbers; the end is exclusive
function disRange(vb: VbMachine, text: string): [number, number] | undefined {
    const dots = text.indexOf('..');
    const numbers = /^(0x[0-9a-f]+|\d+)-(0x[0-9a-f]+|\d+)$/i.exec(text);
    if (dots < 0 && !numbers) {
        return undefined;
    }
    const from = vb.resolve(numbers ? numbers[1] : text.slice(0, dots));
    const to = vb.resolve(numbers ? numbers[2] : text.slice(dots + 2));
    if (to <= from) {
        throw new Error(`dis ${text}: the range ends before it starts.`);
    }
    if (to - from > DIS_MAX_RANGE) {
        throw new Error(`dis ${text}: at most ${DIS_MAX_RANGE / 0x100000} MiB at a time.`);
    }
    return [from, to];
}

// a frame buffer as values: printed for a region, summed up otherwise, written whole with --out
async function fbCommand(vb: VbMachine, args: string[], options: CliOptions, host: CliHost, lines: string[]): Promise<unknown> {
    const { eye, region, pick } = frameBufferArguments('fb', args, false);
    const color = options.flags.has('color');
    if (color && !readVbcState(vb)) {
        throw new Error('--color is the VB Color frame buffer, which only a VB Color game that has switched it on has.');
    }
    const { buffer, shown, state } = pick(vb);
    const values = readFrameBuffer(vb, eye, buffer, color);
    const what = color ? 'palette ids' : 'shades';
    lines.push(`${eye} frame buffer ${buffer}${color ? ' (VB Color)' : ''}${state}: ${what}`);

    const counts = new Map<number, number>();
    let box: [number, number, number, number] | undefined;
    for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
        for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
            const value = values[y * VB_SCREEN_WIDTH + x];
            counts.set(value, (counts.get(value) ?? 0) + 1);
            if (value !== 0) {
                box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
            }
        }
    }
    const tally = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const report: Record<string, unknown> = {
        eye, buffer, color, shown: shown === undefined ? undefined : buffer === shown,
        counts: Object.fromEntries(tally),
        box: box && { x: box[0], y: box[1], width: box[2] - box[0] + 1, height: box[3] - box[1] + 1 },
    };

    if (region) {
        const rows: number[][] = [];
        for (let y = region.y; y < region.y + region.height; y++) {
            const row = [...values.subarray(y * VB_SCREEN_WIDTH + region.x, y * VB_SCREEN_WIDTH + region.x + region.width)];
            rows.push(row);
            const text = color ? row.map(value => value.toString(16).padStart(2, '0')).join(' ') : row.join('');
            lines.push(`  ${String(y).padStart(3)}  ${text}`);
        }
        report.region = region;
        report.values = rows;
    } else {
        lines.push(`  ${tally.slice(0, 16).map(([value, n]) => `${color ? hex(value, 1) : value}: ${n}`).join('  ')}`
            + `${tally.length > 16 ? `  … ${tally.length - 16} more` : ''}`);
        lines.push(box ? `  not 0 within ${box[0]},${box[1]} to ${box[2]},${box[3]}` : '  all 0');
    }

    const out = last(options, 'out');
    if (out !== undefined) {
        const extension = out.slice(out.lastIndexOf('.') + 1).toLowerCase();
        if (extension === 'bin') {
            host.write(out, values);
        } else if (extension === 'json') {
            host.write(out, new TextEncoder().encode(JSON.stringify({
                eye, buffer, color, width: VB_SCREEN_WIDTH, height: VB_SCREEN_HEIGHT, values: [...values],
            })));
        } else if (extension === 'png') {
            host.write(out, await encodePng(frameBufferPicture(values, color), count(options, 'scale', 1)));
        } else {
            throw new Error('fb --out writes .bin, .json or .png.');
        }
        lines.push(`wrote ${out}`);
        report.out = out;
    }
    return report;
}

function profileCommand(vb: VbMachine, options: CliOptions, lines: string[]): unknown {
    const snapshot = vb.profile()!;
    const frames = vb.profileFrames();
    if (frames.length === 0) {
        lines.push('profile: no frame finished; give it --frames');
        return { snapshot, frames };
    }
    type Frame = typeof frames[number];
    // a wait that began in the previous frame is charged to the frame it ends in, which can then hold more
    // waiting than clocks: clamp to the frame
    const waited = (frame: Frame): number => Math.min(frame.waited, frame.clocks - frame.halted);
    const busy = (frame: Frame): number => Math.max(0, frame.clocks - frame.halted - waited(frame));
    // shares of each frame's own clocks: a frame is as many pictures as FRMCYC said at the time, which can change
    const share = (part: number, whole: number): string => `${(whole > 0 ? part * 100 / whole : 0).toFixed(1)}%`;
    const total = (pick: (frame: Frame) => number): number => frames.reduce((sum, frame) => sum + pick(frame), 0);
    const clocks = total(frame => frame.clocks);
    const byBusy = [...frames].sort((a, b) => busy(b) / b.clocks - busy(a) / a.clocks);
    lines.push(`profile: ${frames.length} frame${frames.length === 1 ? '' : 's'}, ${Math.round(clocks / frames.length)} clocks a frame`
        + ` (the budget now ${snapshot.frameClocks})`);
    lines.push(`  busy     ${share(total(busy), clocks)}  peak ${share(busy(byBusy[0]), byBusy[0].clocks)} in frame ${byBusy[0].number}`);
    lines.push(`  waiting  ${share(total(waited), clocks)}   halted ${share(total(frame => frame.halted), clocks)}`);
    lines.push(`  instructions ${Math.round(total(frame => frame.instructions) / frames.length)} a frame`);
    lines.push(`  busiest frames: ${byBusy.slice(0, 5).map(frame => `${frame.number} (${share(busy(frame), frame.clocks)})`).join(', ')}`);
    if (options.flags.has('list')) {
        lines.push('  frame     clocks     busy   waiting   halted   instructions');
        for (const frame of frames) {
            lines.push(`  ${String(frame.number).padStart(5)}  ${String(frame.clocks).padStart(9)}  ${share(busy(frame), frame.clocks).padStart(7)}`
                + `  ${share(waited(frame), frame.clocks).padStart(8)}  ${share(frame.halted, frame.clocks).padStart(7)}`
                + `  ${String(frame.instructions).padStart(13)}`);
        }
    }
    const perFrame = clocks / frames.length;
    const functions = [...snapshot.functions].sort((a, b) => b.selfAvg - a.selfAvg).slice(0, 20);
    lines.push('  functions by own time, a frame on average:      self    total    calls');
    for (const entry of functions) {
        const name = entry.address === VES_LIVE_PROFILE_ROOT ? '(outside any call seen)' : vb.describe(entry.address);
        lines.push(`    ${name.padEnd(44)} ${share(entry.selfAvg, perFrame).padStart(7)}  ${share(entry.totalAvg, perFrame).padStart(7)}`
            + `  ${entry.callsAvg.toFixed(1).padStart(7)}`);
    }
    return {
        budget: snapshot.frameClocks,
        frames: frames.map(frame => ({ ...frame, waited: waited(frame), busy: busy(frame) })),
        functions: snapshot.functions,
    };
}

async function compareCommand(vb: VbMachine, args: string[], options: CliOptions, host: CliHost, lines: string[]): Promise<unknown> {
    const [file, regionText] = args;
    if (file === undefined) {
        throw new Error('compare needs a picture to compare with: compare <ref.png>.');
    }
    const expected = await decodePng(host.read(file));
    const eye = last(options, 'eye') ?? 'left';
    if (!['left', 'right', 'both'].includes(eye)) {
        throw new Error('--eye is left, right or both.');
    }
    const picture = vb.picture(eye as VbEye);
    // the scale the reference was taken at, if not given: a whole multiple of the screen, as `shot --scale` makes
    const given = last(options, 'scale');
    const scale = given !== undefined ? count(options, 'scale', 1) : Math.max(1, Math.round(expected.height / picture.height));
    const actual = scalePicture(picture, scale);
    let region: ScreenRegion | undefined;
    if (regionText !== undefined) {
        const match = /^(\d+),(\d+),(\d+),(\d+)$/.exec(regionText);
        if (!match) {
            throw new Error(`compare takes a region x,y,w,h in the picture's pixels, not "${regionText}".`);
        }
        region = { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
    }
    const tolerance = count(options, 'tolerance', 0);
    const difference = comparePictures(actual, expected, { tolerance, region });
    const where = difference.box
        ? `, within ${difference.box.x},${difference.box.y} to ${difference.box.x + difference.box.width - 1},${difference.box.y + difference.box.height - 1}`
        : '';
    lines.push(difference.differing === 0
        ? `the same as ${file}${tolerance ? ` within ${tolerance}` : ''} (${difference.pixels} pixels${region ? ' of the region' : ''})`
        : `${difference.differing} of ${difference.pixels} pixels differ from ${file}`
            + ` (${(difference.differing * 100 / difference.pixels).toFixed(2)}%)${where}; the largest difference is ${difference.largest}`);
    const out = last(options, 'out');
    if (out !== undefined) {
        host.write(out, await encodePng(difference.picture));
        lines.push(`wrote ${out}`);
    }
    const { picture: unused, ...report } = difference;
    return { file, scale, tolerance, ...report, ...(out !== undefined ? { out } : {}) };
}

function scalePicture(picture: VbPicture, factor: number): VbPicture {
    if (factor === 1) {
        return picture;
    }
    const width = picture.width * factor;
    const height = picture.height * factor;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = (Math.floor(y / factor) * picture.width + Math.floor(x / factor)) * 4;
            rgba.set(picture.rgba.subarray(from, from + 4), (y * width + x) * 4);
        }
    }
    return { rgba, width, height };
}

function bytesHex(bytes: Uint8Array | undefined): string {
    return bytes ? [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('') : '';
}

interface ScreenRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

// the arguments fb and origin share: an eye, a buffer (shown, drawn or a number) and a region, in any order;
// for origin a single pixel x,y is a region too
function frameBufferArguments(command: string, args: string[], pixel: boolean): {
    eye: VbFrameBufferEye,
    region?: ScreenRegion,
    single: boolean,
    pick(vb: VbMachine): { buffer: 0 | 1, shown?: 0 | 1, state: string },
} {
    let eye: VbFrameBufferEye = 'left';
    let which = 'shown';
    let region: ScreenRegion | undefined;
    let single = false;
    for (const arg of args) {
        if (arg === 'left' || arg === 'right') {
            eye = arg;
        } else if (['shown', 'drawn', '0', '1'].includes(arg)) {
            which = arg;
        } else if (/^\d+,\d+,\d+,\d+$/.test(arg) || (pixel && /^\d+,\d+$/.test(arg))) {
            const [x, y, width = 1, height = 1] = arg.split(',').map(Number);
            if (width === 0 || height === 0 || x + width > VB_SCREEN_WIDTH || y + height > VB_SCREEN_HEIGHT) {
                throw new Error(`${command}: ${arg} is not ${arg.split(',').length === 2 ? 'a pixel' : 'a region'} of the ${VB_SCREEN_WIDTH}x${VB_SCREEN_HEIGHT} screen.`);
            }
            region = { x, y, width, height };
            single = arg.split(',').length === 2;
        } else {
            throw new Error(`${command} takes left or right, shown, drawn, 0 or 1, and ${pixel ? 'a pixel x,y or ' : ''}a region x,y,w,h; not "${arg}".`);
        }
    }
    return {
        eye,
        region,
        single,
        pick: vb => {
            let shown: 0 | 1 | undefined;
            try {
                shown = vb.displayedBuffer();
            } catch (error) {
                if (which === 'shown' || which === 'drawn') {
                    throw error;
                }
            }
            const buffer = (which === 'shown' ? shown! : which === 'drawn' ? shown! ^ 1 : Number(which)) as 0 | 1;
            const state = shown === undefined ? '' : buffer === shown ? ', shown' : ', drawn into';
            return { buffer, shown, state };
        },
    };
}

// without any, origin runs on until the buffer it was asked for is drawn
const RUN_OPTIONS = ['frames', 'until', 'until-vip', 'until-read', 'until-written'];

function originCommand(vb: VbMachine, args: string[], options: CliOptions, host: CliHost, lines: string[]): unknown {
    const { eye, region, single, pick } = frameBufferArguments('origin', args, true);
    let picked = pick(vb);
    let origins = vb.pixelOrigins(eye, picked.buffer);
    if (!RUN_OPTIONS.some(option => options.values.has(option)) && origins.every(word => word === 0)) {
        // nothing drawn into it since origins were kept: let the VIP draw it, and show it if that is the one asked
        // for. Twice at most, for the other buffer of the two
        const start = vb.frame;
        for (let round = 0; round < 2 && origins.every(word => word === 0); round++) {
            const drawn = vb.runUntil({ vip: 'drawn' }, { maxFrames: 50 });
            if (drawn.stop?.reason === 'until' && args.every(arg => arg !== 'drawn' && arg !== '0' && arg !== '1')) {
                vb.runUntil({ vip: 'frame' }, { maxFrames: 50 });
            }
            if (!drawn.stop) {
                break;
            }
            picked = pick(vb);
            origins = vb.pixelOrigins(eye, picked.buffer);
        }
        lines.push(`ran on for the VIP to draw it, ${vb.frame - start} frame${vb.frame - start === 1 ? '' : 's'} on: now frame ${vb.frame}  pc ${vb.describe(vb.pc)}`);
    }
    const { buffer, state } = picked;
    const at = (x: number, y: number): VbPixelOrigin => decodeOrigin(origins[(y * VB_SCREEN_WIDTH + x) * 2], origins[(y * VB_SCREEN_WIDTH + x) * 2 + 1]);
    const report: Record<string, unknown> = { eye, buffer };

    const out = last(options, 'out');
    if (out !== undefined) {
        const extension = out.slice(out.lastIndexOf('.') + 1).toLowerCase();
        if (extension === 'bin') {
            host.write(out, new Uint8Array(origins.buffer, origins.byteOffset, origins.byteLength));
        } else if (extension === 'json') {
            const area = region ?? { x: 0, y: 0, width: VB_SCREEN_WIDTH, height: VB_SCREEN_HEIGHT };
            const rows: VbPixelOrigin[][] = [];
            // what each character was when this frame was drawn: character memory may have changed since
            const characters: Record<number, string> = {};
            for (let y = area.y; y < area.y + area.height; y++) {
                const row: VbPixelOrigin[] = [];
                for (let x = area.x; x < area.x + area.width; x++) {
                    const origin = at(x, y);
                    row.push(origin);
                    if (origin.character !== undefined && characters[origin.character] === undefined) {
                        characters[origin.character] = bytesHex(vb.drawnCharacter(buffer, origin.character));
                    }
                }
                rows.push(row);
            }
            host.write(out, new TextEncoder().encode(JSON.stringify({
                eye, buffer, ...area, pixels: rows, characters, palettes: vb.drawnPalettes(buffer),
            })));
        } else {
            throw new Error('origin --out writes .bin or .json.');
        }
        report.out = out;
    }

    if (region && single) {
        const origin = at(region.x, region.y);
        const shade = readFrameBuffer(vb, eye, buffer, false)[region.y * VB_SCREEN_WIDTH + region.x];
        lines.push(`${eye} frame buffer ${buffer}${state}, pixel ${region.x},${region.y}: shade ${shade}`);
        lines.push(`  ${describeOrigin(origin, address => vb.describe(address))}`);
        report.pixel = { x: region.x, y: region.y, shade, origin };
        const drawn = origin.character !== undefined ? vb.drawnCharacter(buffer, origin.character) : undefined;
        if (drawn && origin.pixel) {
            lines.push(`  character ${origin.character} as drawn:`);
            for (let row = 0; row < 8; row++) {
                const bits = drawn[row * 2] | drawn[row * 2 + 1] << 8;
                lines.push(`    ${Array.from({ length: 8 }, (_, column) => {
                    const value = String(bits >>> (column * 2) & 3);
                    return row === origin.pixel!.y && column === origin.pixel!.x ? `[${value}]` : ` ${value} `;
                }).join('')}`);
            }
            report.character = bytesHex(drawn);
        }
    } else {
        // by what drew them: every source in a region, the worlds for the screen
        const area = region ?? { x: 0, y: 0, width: VB_SCREEN_WIDTH, height: VB_SCREEN_HEIGHT };
        const sources = new Map<string, { origin: VbPixelOrigin, count: number, box: [number, number, number, number] }>();
        for (let y = area.y; y < area.y + area.height; y++) {
            for (let x = area.x; x < area.x + area.width; x++) {
                const origin = at(x, y);
                const key = region ? originSource(origin) : `${origin.kind} ${origin.world ?? ''}`;
                const source = sources.get(key);
                if (source) {
                    source.count++;
                    source.box = [Math.min(source.box[0], x), Math.min(source.box[1], y), Math.max(source.box[2], x), Math.max(source.box[3], y)];
                } else {
                    sources.set(key, { origin, count: 1, box: [x, y, x, y] });
                }
            }
        }
        const list = [...sources.values()].sort((a, b) => b.count - a.count || a.box[1] - b.box[1] || a.box[0] - b.box[0]);
        lines.push(`${eye} frame buffer ${buffer}${state}, ${area.width}x${area.height} at ${area.x},${area.y}:`
            + ` ${list.length} ${region ? 'source' : 'world'}${list.length === 1 ? '' : 's'}`);
        for (const { origin, count: pixels, box } of list.slice(0, 100)) {
            const what = region ? describeOrigin(origin, address => vb.describe(address), false)
                : origin.world !== undefined ? `world ${origin.world} (${origin.kind === 'object' ? 'objects' : 'BG map'})`
                    : origin.kind;
            lines.push(`  ${String(pixels).padStart(6)} px  ${box[0]},${box[1]} to ${box[2]},${box[3]}  ${what}`);
        }
        if (list.length > 100) {
            lines.push(`  … ${list.length - 100} more`);
        }
        report.region = area;
        report.sources = list.map(({ origin, count: pixels, box }) => {
            const { pixel: _pixel, value: _value, ...source } = origin;
            const extent = { x: box[0], y: box[1], width: box[2] - box[0] + 1, height: box[3] - box[1] + 1 };
            return { ...(region ? source : { kind: origin.kind, world: origin.world }), pixels, box: extent };
        });
    }
    if (out !== undefined) {
        lines.push(`wrote ${out}`);
    }
    return report;
}

interface CliSets {
    entries: { text: string, register?: string, address?: number, size?: number, value: number }[];
    applied: number;
}

function parseSets(vb: VbMachine, options: CliOptions): CliSets {
    const entries = (options.values.get('set') ?? []).map(text => {
        const split = text.lastIndexOf('=');
        const what = text.slice(0, split).trim();
        const valueText = text.slice(split + 1).trim();
        const value = Number(valueText);
        if (split <= 0 || valueText === '' || !Number.isFinite(value)) {
            throw new Error(`--set takes what=value, not "${text}".`);
        }
        try {
            vb.register(what);
            return { text, register: what, value };
        } catch {
            // memory, then
        }
        const target = targetOf(what);
        let address: number;
        let size: number;
        if (Array.isArray(target)) {
            address = vb.resolve(target[0]);
            size = target[1];
        } else if (/^(0x[0-9a-f]+|\d+)$/i.test(what) || !vb.symbols) {
            address = vb.resolve(what);
            size = 1;
        } else {
            const extent = vb.symbols.locate(what);
            if (!extent) {
                throw new Error(`--set: "${what}" is neither a register nor anything the build has a name for.`);
            }
            address = extent.address;
            size = extent.size;
        }
        if (![1, 2, 4].includes(size)) {
            throw new Error(`--set writes 1, 2 or 4 bytes; ${what} is ${size}.`);
        }
        return { text, address, size, value };
    });
    return { entries, applied: 0 };
}

function applySets(vb: VbMachine, sets: CliSets): void {
    for (const entry of sets.entries) {
        if (entry.register !== undefined) {
            vb.setRegister(entry.register, entry.value);
        } else {
            const bytes = Array.from({ length: entry.size! }, (_, i) => entry.value >>> (i * 8) & 0xff);
            vb.write(entry.address!, bytes);
        }
    }
    sets.applied++;
}

// the watch behind --until-read and --until-written: it stops on the access that leaves no byte of the range
// untouched
function untilRangeWatch(vb: VbMachine, options: CliOptions): { watch: VbWatch, option: string, done(): number } | undefined {
    const read = last(options, 'until-read');
    const written = last(options, 'until-written');
    if (read !== undefined && written !== undefined) {
        throw new Error('--until-read and --until-written do not go together.');
    }
    const spec = read ?? written;
    if (spec === undefined) {
        return undefined;
    }
    let seen = new Uint8Array(0);
    let left = 0;
    const watch: VbWatch = vb.watch({
        kind: read !== undefined ? 'read' : 'write',
        at: targetOf(spec),
        action: 'stop',
        limit: 1,
        test: hit => {
            const from = Math.max(hit.address, watch.start);
            const to = Math.min(hit.address + Math.max(1, hit.size), watch.end);
            for (let at = from; at < to; at++) {
                if (seen[at - watch.start] === 0) {
                    seen[at - watch.start] = 1;
                    left--;
                }
            }
            return left === 0;
        },
    });
    seen = new Uint8Array(watch.end - watch.start);
    left = seen.length;
    return {
        watch,
        option: `${read !== undefined ? 'until-read' : 'until-written'} ${spec}`,
        done: () => seen.length - left,
    };
}

// how --fold cuts memory up: the key of an address's place, and how to name one
function foldOf(how: string | undefined): { key(address: number): number, title: string, label(key: number, addresses: [number, number]): string } | undefined {
    if (how === undefined) {
        return undefined;
    }
    if (how === 'column' || how === 'fb') {
        // frame buffers numbered as the VIP's four, then VB Color's four
        const page = (address: number): number => {
            const place = frameBufferPlace(address);
            return place ? (place.color ? 4 : 0) + (place.eye === 'right' ? 2 : 0) + place.buffer : -1;
        };
        const name = (number: number): string =>
            `${number & 2 ? 'right' : 'left'} ${number & 1}${number & 4 ? ' VB Color' : ''}`;
        return {
            key: address => {
                const number = page(address);
                return number < 0 || how === 'fb' ? number : number * VB_SCREEN_WIDTH + frameBufferPlace(address)!.x;
            },
            title: how === 'fb' ? 'frame buffer' : 'frame buffer column',
            label: (key, addresses) => {
                if (key < 0) {
                    return 'not a frame buffer';
                }
                if (how === 'fb') {
                    return name(key);
                }
                const top = frameBufferPlace(addresses[0])!;
                const bottom = frameBufferPlace(addresses[1]) ?? top;
                return `${name(Math.floor(key / VB_SCREEN_WIDTH))} x ${key % VB_SCREEN_WIDTH}  rows ${top.y}–${Math.min(VB_SCREEN_HEIGHT - 1, bottom.y + bottom.rows - 1)}`;
            },
        };
    }
    const size = Number(how);
    if (!Number.isInteger(size) || size <= 0) {
        throw new Error(`--fold takes column, fb or a number of bytes, not "${how}".`);
    }
    return {
        key: address => Math.floor(address / size),
        title: `${size} bytes`,
        label: key => `${hex32(key * size)}–${hex32(key * size + size - 1)}`,
    };
}

