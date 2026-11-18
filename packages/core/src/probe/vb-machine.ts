import { annotateDisassembly, attachSourceLines } from '../browser/core/emulator-disassembly';
import {
    decodeVsuChannel, VSU_CHANNEL_COUNT, VSU_MODULATION_BASE, VSU_MODULATION_BYTES, VSU_REGISTER_BASE, VSU_REGISTER_BLOCK_BYTES,
    VSU_WAVEFORM_BASES, VSU_WAVEFORM_BYTES, VsuChannel, vsuModulationSamples, vsuWaveformSamples,
} from '../browser/panels/emulator-vsu-memory';
import {
    parseRomHeader, resolveVbHardwareMode, ROM_HEADER_OFFSET_FROM_END, RomHeader, romSizeInMBit, VbHardwareMode,
} from '../browser/emulator-types';
import {
    SAVE_RAM_WINDOW, saveRamHighWater, unwrapSaveState, VesEmulatorSaveStateIdentity, wrapSaveState,
} from '../common/emulator-save-state';
import {
    VB_CLOCKS_PER_BUFFER, VB_EYE_PACKED_LEFT, VB_EYE_PACKED_RIGHT, VB_MAX_IDLE_EMULATE_CALLS, VB_SAMPLES_PER_BUFFER,
    VB_ES_SOUND_PORT, VB_INTERRUPT_VECTOR_BASE, VB_PSW_INTERRUPT_LEVEL_MASK, VB_PSW_INTERRUPT_LEVEL_SHIFT, VB_TERMINAL_PORT,
    VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH, VB_VSU_BASE, VbBreak, VbDataType, VbInterrupt, vbInterruptExceptionCode, VbPsw, VbSystemRegister, vbFrameBytes,
} from '../common/vb-constants';
import { ES_SOUND_INIT } from '../common/emulator-essound';
import { Registers } from '../common/vb-protocol';
import {
    disassemble, installVbCallback, instantiateWasmBytes, VB_EXCEPTION_CALLBACK_ARITY, VB_EXECUTE_CALLBACK_ARITY,
    VB_READ_CALLBACK_ARITY, VB_WRITE_CALLBACK_ARITY, WasmExports,
} from '../worker/vb-wasm';
import { calibrateVsuLayout, composeVsuMap, VsuLayout } from '../worker/vb-vsu-layout';
import { VbInput } from './vb-input';
import { NO_KEYS } from './vb-keys';
import { encodePng, framePicture, VbEye, VbFrame, VbPicture } from './vb-picture';
import { VbSymbols } from './vb-symbols';
import { VbWatch, VbWatchHit, VbWatchSpec, VbWatchTarget } from './vb-watch';
import { LiveProfileFrame, LiveProfileSnapshot, VesLiveProfileCollector } from '../common/emulator-live-profile';
import { decodeRomKinds, VesInstructionKind } from '../common/emulator-profile';

const VIP_FRMCYC = 0x0005f82e; // FRMCYC: how many pictures a game frame is drawn over

export interface VbMachineOptions {
    core: Uint8Array; // copied, never patched in place
    rom: Uint8Array;
    sram?: Uint8Array; // Game Pak RAM to start with, from the bottom of the window up
    sramWindow?: number; // how much Game Pak RAM the cartridge answers on; the app's default is all 16 MiB
    elf?: Uint8Array;
    symbols?: VbSymbols; // names already read from one, wins over `elf`; for a host making many machines of one build
    hardware?: 'vb' | 'vbc' | 'auto'; // `auto`, the default, asks the ROM header, as the app does
    // answer ESSound's init command with a Game Pak interrupt, as the app does for games with ESSound tracks;
    // a game waiting for it waits forever otherwise
    esSound?: boolean;
}

export type VbStopReason = 'breakpoint' | 'step' | 'until' | 'watch' | 'fault';

// `frame` is a frame shown, both eyes out, as the app counts VIP frames. `drawing`/`drawn` are the drawing
// processor starting and finishing a framebuffer (XPSTTS). The rest are interrupt requests, seen as their
// INTPND bit coming on, so one a game never clears shows only once
export type VbVipEvent =
    | 'frame' | 'drawing' | 'drawn'
    | 'framestart' | 'gamestart' | 'xpend' | 'sbhit' | 'lfbend' | 'rfbend' | 'timeerr' | 'scanerr';

// INTPND bit per interrupt request, per the VIP's own documentation
const VIP_INTERRUPT_BITS: Partial<Record<VbVipEvent, number>> = {
    scanerr: 0x0001, lfbend: 0x0002, rfbend: 0x0004, gamestart: 0x0008, framestart: 0x0010,
    sbhit: 0x2000, xpend: 0x4000, timeerr: 0x8000,
};
export const VB_VIP_EVENTS = ['frame', 'drawing', 'drawn', ...Object.keys(VIP_INTERRUPT_BITS)] as VbVipEvent[];

const VIP_INTPND = 0x0005f800;
const VIP_XPSTTS = 0x0005f840;
const XPSTTS_BUSY = 0x000c; // XPSTTS F0BSY and F1BSY: drawing into one framebuffer or the other

export interface VbBranch {
    from: number;
    to: number;
    exception?: number; // for one an exception caused
    times?: number; // times taken in a row where more than once, so a loop is one entry, not the whole ring
}

// exception codes of a program going wrong rather than an interrupt or TRAP: the FPU's four, zero division,
// invalid opcode, address trap and a fault while handling a fault
export function isFault(cause: number): boolean {
    return (cause >= 0xff60 && cause < 0xffa0) || cause === 0xffc0 || cause === 0xffd0;
}

export function exceptionName(cause: number): string {
    const interrupts = ['key interrupt', 'timer interrupt', 'Game Pak interrupt', 'link interrupt', 'VIP interrupt'];
    if (cause >= 0xfe00 && cause < 0xfe50 && (cause & 0xf) === 0) {
        return interrupts[(cause - 0xfe00) >> 4];
    }
    if (cause >= 0xffa0 && cause < 0xffc0) {
        return `TRAP ${cause - 0xffa0}`;
    }
    const names: Record<number, string> = {
        0xff60: 'FPU reserved operand', 0xff64: 'FPU overflow', 0xff68: 'FPU zero division', 0xff70: 'FPU invalid operation',
        0xff80: 'zero division', 0xff90: 'invalid opcode', 0xffc0: 'address trap', 0xffd0: 'fault while handling a fault',
        0xfff0: 'reset',
    };
    return names[cause] ?? `exception 0x${cause.toString(16)}`;
}

export interface VbStop {
    reason: VbStopReason;
    pc: number;
    frame: number;
    watch?: VbWatch;
    hit?: VbWatchHit;
    exception?: number;
}

export interface VbRunResult {
    frames: number; // frames completed by this call
    frame: number; // the machine's frame count afterwards
    stop?: VbStop;
    // the machine stopped advancing at all, a crash into a state the core cannot leave, as the app's stall
    // guard reports it
    stalled?: boolean;
}

export type VbRunTarget =
    | { pc: number | string }
    | { frame: number }
    | { vip: VbVipEvent }
    | { predicate: (machine: VbMachine) => boolean };

export interface VbInstruction {
    address: number;
    code: number[];
    mnemonic: string;
    operands: string[];
    text: string; // `mnemonic operands`, as the app's Disassembly panel writes it
    symbol?: string; // as `name+0x1c`, where the build says
    comment?: string; // names for the addresses its operands lead to
    source?: { file: string, line: number };
}

// only valid in the machine that took it, as the state struct holds absolute pointers into its memory.
// Game Pak RAM is not in it, like the app's save states
export interface VbSnapshot {
    readonly state: Uint8Array;
    readonly frame: number;
    readonly vipFrames: number;
    readonly chunkLeft: number; // internal: where in a frame's clocks the machine stood
    readonly refire?: Refire; // internal: what the core will report again on resuming, see VbMachine.refire
    readonly calls?: StackFrame[];
    readonly gamePakInterrupt?: boolean;
}

// a call, or an exception taken (interrupt, TRAP), which returns by RETI rather than `jmp [lp]`
interface StackFrame {
    site: number;
    exception?: number;
}

const OPCODE_JMP = 0x06;
const OPCODE_RETI = 0x19;
const OPCODE_JAL = 0x2b;
const LINK_REGISTER = 31;
const MAX_CALL_DEPTH = 256; // deeper than any real program goes; past it the oldest calls are forgotten

// a callback report the core repeats when a refused instruction is resumed
interface Refire {
    kind: 'exec' | 'read' | 'write' | 'exception';
    address: number;
}

const REGISTER_ALIASES: Record<string, number> = {
    hp: 2, fp: 2, sp: 3, gp: 4, tp: 5, lp: 31,
};

const VCU_MEMCTRL = 0x0307f812; // the VB Color unit's memory control register; bit 0 is `WRAMEXT`

const TYPE_BYTES = [1, 1, 2, 2, 4, 4];

// a VB to drive from code, with the app's core and frame: a frame is a twentieth of a second of clocks,
// buttons change at frame boundaries, so VUEPort movies and input scripts play out exactly. Synchronous but
// for creation; a run stopped mid-frame resumes from the same clock, so stops never shift frames
export class VbMachine {

    readonly header: RomHeader;
    readonly vbc: boolean;
    readonly symbols?: VbSymbols;
    readonly romBytes: number; // after padding

    frame = 0; // since the cartridge went in or the machine was reset
    vipFrames = 0; // pictures the VIP finished in that time, not always the same
    keys = NO_KEYS; // held on any frame the input script leaves alone
    input?: VbInput;

    protected readonly sim: number;
    protected readonly rom: Uint8Array;
    protected readonly romPointer: number;
    protected readonly ramPointer: number;
    protected readonly ramBytes: number;
    protected readonly samples: number;
    protected readonly clocksPointer: number;
    protected readonly simsPointer: number;

    protected chunkLeft = 0; // zero between frames
    protected stopping?: VbStop;
    // hits whose watches act once the core has returned, see VbWatchSpec.then
    protected pausing: { watch: VbWatch, hit: VbWatchHit }[] = [];
    // the report the core repeats when the refused instruction is resumed, so it is not counted twice. A refused
    // execute leaves the CPU asking again for the same instruction, a refused read or write leaves it half done,
    // and resuming repeats the access and the callback. Measured against the core's `cpu.c`
    protected refire?: Refire;

    protected readonly breakpointSet = new Set<number>(); // with mirrors folded, see `canonical`
    protected untilPc?: number;
    protected watchList: VbWatch[] = [];
    protected writeWatches: VbWatch[] = [];
    protected readWatches: VbWatch[] = [];
    protected execWatches: VbWatch[] = [];
    protected nextWatchId = 1;
    // a ring of `from`, `to` and exception code, while kept
    protected ring?: { from: Uint32Array, to: Uint32Array, cause: Uint16Array, times: Uint32Array, next: number, count: number };
    protected lastExec?: number;
    protected lastNext?: number;
    protected pendingCause = 0; // an exception taken, to be put on the branch it causes
    protected coverageRom?: Uint32Array; // by halfword of the cartridge, and elsewhere by address
    protected coverageOther?: Map<number, number>;
    protected vipUntil?: { event: VbVipEvent, last: number };
    protected faultStop = false;
    protected foldedMask = 0xffff; // the WRAM size the watch ranges were last folded for
    protected calls?: StackFrame[]; // while anything wants it followed
    protected stepping?: { seen: number, target: number };
    protected terminalBytes: number[] = [];
    protected readonly esSound: boolean;
    protected esSoundCommands: number[] = [];
    protected gamePakInterrupt = false; // the ESSound init has been seen and its interrupt not yet taken

    protected executeSlot = 0;
    protected writeSlot = 0;
    protected readSlot = 0;
    protected exceptionSlot = 0;
    protected exceptionInstalled = false;
    protected executeInstalled = false;
    protected readInstalled = false;

    protected constructor(protected readonly wasm: WasmExports, protected readonly options: VbMachineOptions) {
        this.rom = options.rom;
        this.esSound = options.esSound ?? false;
        this.header = parseRomHeader(options.rom);
        this.romBytes = options.rom.length;
        if (this.romBytes === 0 || (this.romBytes & (this.romBytes - 1)) !== 0) {
            throw new Error(`A ROM has to be a power of two in size; this one is ${this.romBytes} bytes.`);
        }

        this.sim = wasm.CreateSim();
        if (this.sim === 0) {
            throw new Error('The emulator core could not allocate a simulation.');
        }
        wasm.SetAnaglyph(this.sim, VB_EYE_PACKED_LEFT, VB_EYE_PACKED_RIGHT);

        const hardware = options.hardware ?? 'auto';
        this.vbc = wasm.SetHardwareMode === undefined
            || resolveVbHardwareMode(hardware, this.header.vbcSupport) === VbHardwareMode.VB_COLOR;

        this.romPointer = this.copyIn(options.rom);
        if (wasm.vbSetCartROM(this.sim, this.romPointer, this.romBytes) !== 0) {
            throw new Error('The emulator core refused the ROM.');
        }
        this.ramBytes = options.sramWindow ?? SAVE_RAM_WINDOW;
        const ram = new Uint8Array(this.ramBytes);
        if (options.sram) {
            ram.set(options.sram.subarray(0, Math.min(options.sram.length, ram.length)));
        }
        this.ramPointer = this.copyIn(ram);
        if (wasm.vbSetCartRAM(this.sim, this.ramPointer, this.ramBytes) !== 0) {
            throw new Error('The emulator core refused the Game Pak RAM; its size has to be a power of two.');
        }

        this.samples = wasm.GetExtSamples(this.sim);
        this.clocksPointer = wasm.Realloc(0, 4);
        this.simsPointer = wasm.Realloc(0, 4);
        this.u32(this.simsPointer)[0] = this.sim;

        if (options.symbols) {
            this.symbols = options.symbols;
        } else if (options.elf) {
            this.symbols = VbSymbols.fromElf(options.elf, this.romBytes);
        }
        this.reset();
    }

    static async create(options: VbMachineOptions): Promise<VbMachine> {
        const wasm = await instantiateWasmBytes(options.core.slice());
        return new VbMachine(wasm, options);
    }

    // same core, the cartridge as it is now (patches included), RAM and frame count, to try something on.
    // Watches, breakpoints, buttons and pixel origins stay behind
    async clone(): Promise<VbMachine> {
        const heap = this.heap();
        const copy = await VbMachine.create({
            ...this.options,
            rom: heap.slice(this.romPointer, this.romPointer + this.romBytes),
            sram: heap.slice(this.ramPointer, this.ramPointer + this.ramBytes),
            sramWindow: this.ramBytes,
            symbols: this.symbols,
        });
        copy.restore(this.snapshot());
        return copy;
    }

    // also starts the frame count over
    reset(): void {
        this.wasm.vbReset(this.sim);
        this.clearOrigins();
        this.wasm.SetHardwareMode?.(this.sim, this.vbc ? 1 : 0);
        this.frame = 0;
        this.vipFrames = 0;
        this.chunkLeft = 0;
        this.refire = undefined;
        this.pausing = [];
        this.terminalBytes = [];
        this.esSoundCommands = [];
        this.gamePakInterrupt = false;
        this.calls = undefined;
        this.lastExec = undefined;
        this.lastNext = undefined;
        this.updateCallbacks();
    }

    // fewer if something stops the machine
    runFrames(count: number): VbRunResult {
        const start = this.frame;
        for (let i = 0; i < count; i++) {
            const outcome = this.runChunk();
            if (outcome !== 'done') {
                return this.result(start, outcome);
            }
        }
        return this.result(start, 'done');
    }

    // runs to an instruction, a frame, or a condition checked at the end of every frame, or until `maxFrames`.
    // A result with no `stop` ran out of frames
    runUntil(target: VbRunTarget, options: { maxFrames?: number } = {}): VbRunResult {
        const maxFrames = options.maxFrames ?? 3000;
        const start = this.frame;
        if ('frame' in target) {
            const result = this.runFrames(Math.max(0, Math.min(target.frame - this.frame, maxFrames)));
            if (!result.stop && !result.stalled && this.frame >= target.frame) {
                result.stop = { reason: 'until', pc: this.pc, frame: this.frame };
            }
            return result;
        }
        if ('pc' in target) {
            this.untilPc = this.canonical(this.resolve(target.pc));
            this.updateCallbacks();
        }
        if ('vip' in target) {
            if (!VB_VIP_EVENTS.includes(target.vip)) {
                throw new Error(`"${target.vip}" is not a VIP event; there are ${VB_VIP_EVENTS.join(', ')}.`);
            }
            this.vipUntil = { event: target.vip, last: this.vipSample(target.vip) };
            this.updateCallbacks();
        }
        try {
            while (this.frame - start < maxFrames) {
                const outcome = this.runChunk();
                if (outcome !== 'done') {
                    return this.result(start, outcome);
                }
                if ('predicate' in target && target.predicate(this)) {
                    return { ...this.result(start, 'done'), stop: { reason: 'until', pc: this.pc, frame: this.frame } };
                }
            }
            return this.result(start, 'done');
        } finally {
            this.untilPc = undefined;
            this.vipUntil = undefined;
            this.updateCallbacks();
        }
    }

    protected vipSample(event: VbVipEvent): number {
        if (event === 'frame') {
            return 0;
        }
        if (event === 'drawing' || event === 'drawn') {
            return this.wasm.vbRead(this.sim, VIP_XPSTTS, VbDataType.U16) & XPSTTS_BUSY;
        }
        return this.wasm.vbRead(this.sim, VIP_INTPND, VbDataType.U16) & VIP_INTERRUPT_BITS[event]!;
    }

    protected vipHappened(): boolean {
        const until = this.vipUntil!;
        const now = this.vipSample(until.event);
        const before = until.last;
        until.last = now;
        return until.event === 'drawn' ? before !== 0 && now === 0 : before === 0 && now !== 0;
    }

    // profiles like the app's live CPU Profiler: every instruction's clock cost per function, and per frame what
    // was work or idling (halted, or looping until an awaited interrupt, see `emulator-live-profile.ts`). A game
    // frame spans `FRMCYC` pictures, as in the app. `window` is how many frames are kept
    startProfile(window = 3000): void {
        const rom = this.heap().slice(this.romPointer, this.romPointer + this.romBytes);
        this.live = {
            collector: new VesLiveProfileCollector(Math.max(1, Math.floor(window))),
            kinds: decodeRomKinds(rom),
            left: this.chunkLeft || VB_CLOCKS_PER_BUFFER,
            cycle: 1,
            pictures: 0,
            framed: false,
        };
        this.updateCallbacks();
    }

    stopProfile(): void {
        this.live = undefined;
        this.updateCallbacks();
    }

    // as the app's panel reads it; undefined when not profiling
    profile(): LiveProfileSnapshot | undefined {
        const live = this.live;
        return live && live.collector.snapshot(VB_CLOCKS_PER_BUFFER * live.cycle);
    }

    // clocks, of them halted and waiting, and instructions
    profileFrames(): Omit<LiveProfileFrame, 'functions'>[] {
        return this.live?.collector.frameTotals() ?? [];
    }

    get frameBudget(): number {
        return VB_CLOCKS_PER_BUFFER * ((this.wasm.vbRead(this.sim, VIP_FRMCYC, VbDataType.U16) & 0x0f) + 1);
    }

    protected clocksView?: Uint32Array;

    protected live?: {
        collector: VesLiveProfileCollector;
        kinds: Uint8Array;
        left: number; // budget clocks left when the last instruction was reported
        cycle: number;
        pictures: number;
        framed: boolean;
    };

    // what the instruction before cost goes to whatever was running
    protected liveStep(pc: number): void {
        const live = this.live!;
        // once per instruction, so a view kept as long as the heap is the same
        if (this.clocksView?.buffer !== this.wasm.memory.buffer) {
            this.clocksView = this.u32(this.clocksPointer);
        }
        const remaining = this.clocksView[0];
        const spent = live.left - remaining;
        live.left = remaining;
        const offset = (pc & 0x07ffffff & (this.romBytes - 1)) >>> 0;
        live.collector.step(pc, live.kinds[offset >> 1] as VesInstructionKind, spent);
    }

    // the end of a game frame when FRMCYC says so, or with `force` whatever has gathered (a chunk without a
    // picture, from a machine whose display is off)
    protected endLiveFrame(force = false): void {
        const live = this.live!;
        live.framed = true;
        if (!force) {
            live.cycle = (this.wasm.vbRead(this.sim, VIP_FRMCYC, VbDataType.U16) & 0x0f) + 1;
            if (++live.pictures < live.cycle) {
                return;
            }
        }
        live.pictures = 0;
        const remaining = this.u32(this.clocksPointer)[0];
        live.collector.endFrame(live.left - remaining);
        live.left = remaining;
    }

    // keeps the last `depth` branches (every place the flow does not go on), 0 stops; what a crash report is made of
    traceBranches(depth = 256): void {
        this.ring = depth > 0
            ? { from: new Uint32Array(depth), to: new Uint32Array(depth), cause: new Uint16Array(depth), times: new Uint32Array(depth), next: 0, count: 0 }
            : undefined;
        this.lastExec = undefined;
        this.lastNext = undefined;
        this.updateCallbacks();
    }

    // oldest first, with mirrors folded
    branches(): VbBranch[] {
        const ring = this.ring;
        if (!ring) {
            return [];
        }
        const out: VbBranch[] = [];
        const size = ring.from.length;
        for (let i = 0; i < ring.count; i++) {
            const at = (ring.next - ring.count + i + size) % size;
            out.push({
                from: ring.from[at], to: ring.to[at],
                ...(ring.cause[at] ? { exception: ring.cause[at] } : {}),
                ...(ring.times[at] > 1 ? { times: ring.times[at] } : {}),
            });
        }
        return out;
    }

    // stops before the CPU takes a fault (see isFault), with the machine where it went wrong
    get stopOnFault(): boolean {
        return this.faultStop;
    }

    set stopOnFault(stop: boolean) {
        this.faultStop = stop;
        this.updateCallbacks();
    }

    // for `coverage`; any earlier count is forgotten
    startCoverage(): void {
        this.coverageRom = new Uint32Array(this.romBytes >>> 1);
        this.coverageOther = new Map();
        this.updateCallbacks();
    }

    stopCoverage(): void {
        this.coverageRom = undefined;
        this.coverageOther = undefined;
        this.updateCallbacks();
    }

    // since `startCoverage`, by address with mirrors folded
    coverage(): Map<number, number> {
        const counts = new Map<number, number>();
        const rom = this.coverageRom;
        if (rom) {
            for (let i = 0; i < rom.length; i++) {
                if (rom[i] !== 0) {
                    counts.set((0x07000000 + i * 2) >>> 0, rom[i]);
                }
            }
        }
        this.coverageOther?.forEach((count, address) => counts.set(address, count));
        return counts;
    }

    // counted from where the machine stands: after a stop at an instruction, it is the first one run; after a
    // stop inside one (a watched access), finishing it is
    step(count = 1): VbRunResult {
        const start = this.frame;
        const fromInstruction = this.refire?.kind === 'exec';
        this.stepping = { seen: 0, target: Math.max(1, count) + (fromInstruction ? 1 : 0) };
        this.updateCallbacks();
        try {
            // a frame of clocks is far more than any instruction takes, so two without one means the machine stopped
            for (let chunks = 0; chunks < 2 + Math.ceil(count / 1000); chunks++) {
                const outcome = this.runChunk();
                if (outcome !== 'done') {
                    return this.result(start, outcome);
                }
            }
            return { ...this.result(start, 'done'), stalled: true };
        } finally {
            this.stepping = undefined;
            this.updateCallbacks();
        }
    }

    get breakpoints(): ReadonlySet<number> {
        return this.breakpointSet;
    }

    addBreakpoint(at: number | string): number {
        const address = this.resolve(at);
        this.breakpointSet.add(this.canonical(address));
        this.updateCallbacks();
        return address;
    }

    removeBreakpoint(at: number | string): void {
        this.breakpointSet.delete(this.canonical(this.resolve(at)));
        this.updateCallbacks();
    }

    // starts a new frame if none is under way, as buttons are set at the start of a frame only
    protected runChunk(): 'done' | 'stopped' | 'stalled' {
        // a repeat only comes from a callback there to make it; with nobody listening the instruction simply runs
        if ((this.refire?.kind === 'exec' && !this.executeInstalled) || (this.refire?.kind === 'read' && !this.readInstalled)
            || (this.refire?.kind === 'exception' && !this.exceptionInstalled)) {
            this.refire = undefined;
        }
        if (this.chunkLeft === 0) {
            const keys = this.input?.keysAt(this.frame) ?? this.keys;
            this.wasm.vbSetKeys(this.sim, keys);
            this.wasm.vbSetSamples(this.sim, this.samples, VbDataType.F32, VB_SAMPLES_PER_BUFFER);
            this.chunkLeft = VB_CLOCKS_PER_BUFFER;
        }
        this.u32(this.clocksPointer)[0] = this.chunkLeft;
        if (this.live) {
            this.live.left = this.chunkLeft;
            if (this.chunkLeft === VB_CLOCKS_PER_BUFFER) {
                this.live.framed = false;
            }
        }
        let idle = 0;
        let before = this.chunkLeft;
        while (this.u32(this.clocksPointer)[0] !== 0) {
            this.wasm.Emulate(this.simsPointer, 1, this.clocksPointer);
            const left = this.u32(this.clocksPointer)[0];
            if (this.gamePakInterrupt) {
                this.takeGamePakInterrupt();
            }
            if (this.wasm.GetBreaks(this.sim) & VbBreak.FRAME) {
                this.vipFrames++;
                if (this.live) {
                    this.endLiveFrame();
                }
                // the frame hook stops the core between two CPU steps, so there is nothing to resume or repeat
                if (this.vipUntil?.event === 'frame' && !this.stopping) {
                    this.stopping = { reason: 'until', pc: this.pc, frame: this.frame };
                }
            }
            if (this.pausing.length > 0) {
                const pausing = this.pausing;
                this.pausing = [];
                pausing.forEach(({ watch, hit }) => watch.spec.then!(hit));
                idle = 0; // held up on purpose, not stuck
                before = left;
            }
            if (this.stopping) {
                this.chunkLeft = left;
                return 'stopped';
            }
            idle = left === before ? idle + 1 : 0;
            before = left;
            if (idle > VB_MAX_IDLE_EMULATE_CALLS) {
                this.chunkLeft = left;
                return 'stalled';
            }
        }
        this.chunkLeft = 0;
        this.frame++;
        // a machine drawing nothing still spends clocks, so a chunk stands in for a frame unless one is half gathered
        if (this.live && !this.live.framed && this.live.pictures === 0) {
            this.endLiveFrame(true);
        }
        return 'done';
    }

    // ESSound init's answer, a Game Pak interrupt, raised between two `Emulate` calls as interrupts are only taken
    // between instructions (like the worker's `serviceGamePakInterrupts`). Held over while the CPU will not take it
    protected takeGamePakInterrupt(): void {
        const level = VbInterrupt.CRO;
        const psw = this.wasm.vbGetSystemRegister(this.sim, VbSystemRegister.PSW) >>> 0;
        const blocked = (psw & (VbPsw.NP | VbPsw.EP | VbPsw.ID)) !== 0;
        const masked = level < ((psw & VB_PSW_INTERRUPT_LEVEL_MASK) >>> VB_PSW_INTERRUPT_LEVEL_SHIFT);
        if (blocked || masked) {
            return;
        }
        const ecr = this.wasm.vbGetSystemRegister(this.sim, VbSystemRegister.ECR) >>> 0;
        this.wasm.vbSetSystemRegister(this.sim, VbSystemRegister.EIPC, this.pc);
        this.wasm.vbSetSystemRegister(this.sim, VbSystemRegister.EIPSW, psw);
        this.wasm.vbSetSystemRegister(this.sim, VbSystemRegister.ECR, (ecr & 0xffff0000) | vbInterruptExceptionCode(level));
        const entered = ((psw & ~(VbPsw.AE | VB_PSW_INTERRUPT_LEVEL_MASK))
            | VbPsw.EP | VbPsw.ID | ((level + 1) << VB_PSW_INTERRUPT_LEVEL_SHIFT)) >>> 0;
        this.wasm.vbSetSystemRegister(this.sim, VbSystemRegister.PSW, entered);
        this.wasm.vbSetProgramCounter(this.sim, (VB_INTERRUPT_VECTOR_BASE + (level << 4)) >>> 0);
        this.gamePakInterrupt = false;
        // taken by hand, so the exception callback never hears of it; the call stack still has to
        if (this.calls) {
            this.calls.push({ site: this.canonical(this.wasm.vbGetSystemRegister(this.sim, VbSystemRegister.EIPC) >>> 0), exception: vbInterruptExceptionCode(level) });
        }
    }

    protected result(start: number, outcome: 'done' | 'stopped' | 'stalled'): VbRunResult {
        const result: VbRunResult = { frames: this.frame - start, frame: this.frame };
        if (outcome === 'stopped' && this.stopping) {
            result.stop = this.stopping;
            this.stopping = undefined;
        } else if (outcome === 'stalled') {
            result.stalled = true;
        }
        return result;
    }

    // only noted here; the drain loop acts on it once the core has returned, the only safe place
    protected requestStop(reason: VbStopReason, refire: Refire, watch?: VbWatch, hit?: VbWatchHit): number {
        if (!this.stopping) {
            this.stopping = { reason, pc: this.pc, frame: this.frame, ...(watch ? { watch, hit } : {}) };
            this.refire = refire;
        }
        return 1;
    }

    // holds the core up for the watches in `pausing`, which act once it has returned; it resumes like from a stop
    protected requestPause(refire: Refire): number {
        this.refire = refire;
        return 1;
    }

    // and keeps it for its watch's `then`
    protected recordHit(watch: VbWatch, hit: VbWatchHit): void {
        watch.record(hit);
        if (watch.spec.then) {
            this.pausing.push({ watch, hit });
        }
    }

    // see VbWatchSpec; collects hits as the machine runs, and stops it on one if told to
    watch(spec: VbWatchSpec): VbWatch {
        const [start, length] = this.extentOf(spec.at, spec.kind === 'exec' ? 'entry' : 'data');
        const pc = spec.when?.pc;
        const pcRange = pc !== undefined ? this.extentOf(pc, 'whole') : undefined;
        const watch = new VbWatch(
            this.nextWatchId++, spec, start, length,
            pcRange ? [this.canonical(pcRange[0]), this.canonical(pcRange[0]) + pcRange[1]] : undefined);
        watch.fold(address => this.canonical(address));
        this.watchList.push(watch);
        this.updateCallbacks();
        return watch;
    }

    unwatch(watch: VbWatch): void {
        watch.disposed = true;
        this.watchList = this.watchList.filter(candidate => candidate !== watch);
        this.updateCallbacks();
    }

    get watches(): readonly VbWatch[] {
        return this.watchList;
    }

    // the PC, then the call sites above it, innermost first, mirrors folded. Followed rather than unwound, so it
    // only knows calls made since something started following (a watch capturing `stack`, or `followCalls`)
    callStack(): number[] {
        const calls = this.calls ?? [];
        return [this.canonical(this.pc), ...calls.map(frame => frame.site).reverse()];
    }

    // for `callStack`, with or without a watch asking for it
    followCalls(follow = true): void {
        this.following = follow;
        this.updateCallbacks();
    }

    protected following = false;

    protected wantsCalls(): boolean {
        return this.following || this.watchList.some(watch => watch.spec.capture?.includes('stack'));
    }

    // a number is one byte, a name as big as the build says, a pair a start and a length. A function's name is
    // its entry where code is watched (one hit per call), all of it where it says which code an access comes from
    protected extentOf(target: VbWatchTarget, use: 'data' | 'entry' | 'whole'): [number, number] {
        if (Array.isArray(target)) {
            return [this.resolve(target[0]) & 0x07ffffff, Math.max(1, target[1])];
        }
        if (typeof target === 'string' && !/^(0x[0-9a-f]+|\d+)$/i.test(target.trim()) && this.symbols) {
            const symbol = use !== 'data' ? this.symbols.lookup(target.trim()) : undefined;
            if (symbol?.isFunction) {
                return [symbol.address & 0x07ffffff, use === 'whole' ? Math.max(1, symbol.size) : 1];
            }
            const extent = this.symbols.locate(target);
            if (!extent) {
                throw new Error(`No symbol "${target}" in the build.`);
            }
            return [extent.address & 0x07ffffff, extent.size];
        }
        return [this.resolve(target) & 0x07ffffff, 1];
    }

    // folds mirrors so watches, breakpoints and symbols match however the memory was reached: the CPU sees 27
    // address bits, WRAM repeats every 64 KiB (256 KiB once a VB Color game switches on `WRAMEXT`), and the
    // cartridge at its own size, so code running from the top of memory matches symbols at 0x07000000
    canonical(address: number): number {
        const at = (address & 0x07ffffff) >>> 0;
        switch (at >>> 24) {
            case 5: return (0x05000000 | (at & this.wramMask())) >>> 0;
            case 6: return (0x06000000 | (at & (this.ramBytes - 1) & 0xffffff)) >>> 0;
            case 7: return (0x07000000 | (at & (this.romBytes - 1))) >>> 0;
            default: return at;
        }
    }

    // `MEMCTRL` bit 0 (`WRAMEXT`) decodes 256 KiB, as the core's bus does
    protected wramMask(): number {
        return this.vbc && (this.wasm.vbRead(this.sim, VCU_MEMCTRL, VbDataType.U16) & 1) !== 0 ? 0x3ffff : 0xffff;
    }

    protected hitFor(watch: VbWatch, kind: VbWatchHit['kind'], pc: number, address: number, size: number,
        value?: number, old?: number): VbWatchHit {
        const hit: VbWatchHit = { watch: watch.id, kind, frame: this.frame, pc, address, size };
        if (value !== undefined) {
            hit.value = value;
        }
        if (old !== undefined) {
            hit.old = old;
        }
        const capture = watch.spec.capture;
        if (capture) {
            for (const what of capture) {
                if (what === 'stack') {
                    hit.stack = this.callStack();
                } else if (what === 'regs') {
                    hit.regs = { ...hit.regs, ...this.programRegisters() };
                } else {
                    hit.regs = { ...hit.regs, [what]: this.register(what) };
                }
            }
        }
        return hit;
    }

    // returns whether one of them stops the machine on it
    protected offer(watches: VbWatch[], kind: 'write' | 'read', address: number, type: number, valuePointer: number): number {
        const mask = this.wramMask(); // a VB Color game can widen WRAM at any moment, moving ranges folded for 64 KiB
        if (mask !== this.foldedMask) {
            this.foldedMask = mask;
            this.watchList.forEach(watch => watch.fold(origin => this.canonical(origin)));
        }
        const size = accessBytes(type);
        const at = this.canonical(address);
        const end = at + size;
        let pc = -1;
        for (const watch of watches) {
            if (at >= watch.end || end <= watch.start) {
                continue;
            }
            if (pc < 0) {
                pc = this.canonical(this.pc);
            }
            if (!watch.accepts(this.frame, pc)) {
                continue;
            }
            const value = maskTo(new DataView(this.wasm.memory.buffer).getInt32(valuePointer, true), size);
            const old = kind === 'write' ? maskTo(this.wasm.vbRead(this.sim, address, type), size) : undefined;
            if (!watch.acceptsValue(value, old)) {
                continue;
            }
            const hit = this.hitFor(watch, kind, pc, at, size, value, old);
            if (watch.spec.test && !watch.spec.test(hit)) {
                continue;
            }
            this.recordHit(watch, hit);
            if (watch.stops) {
                return this.requestStop('watch', { kind, address }, watch, hit);
            }
        }
        return this.pausing.length > 0 ? this.requestPause({ kind, address }) : 0;
    }

    // each costs a call out of the core per instruction or access, so an idle machine has only the terminal's.
    // The core keeps them in the state struct, so a restore has to come back through here
    protected updateCallbacks(): void {
        const wasm = this.wasm;
        this.writeWatches = this.watchList.filter(watch => watch.covers('write'));
        this.readWatches = this.watchList.filter(watch => watch.covers('read'));
        this.execWatches = this.watchList.filter(watch => watch.covers('exec'));
        const following = this.wantsCalls();
        if (following && !this.calls) {
            this.calls = [];
        } else if (!following) {
            this.calls = undefined;
        }
        this.exceptionInstalled = following || this.ring !== undefined || this.faultStop;
        if (this.exceptionInstalled) {
            this.exceptionSlot ||= installVbCallback(wasm, (sim, cause) => this.onException(cause), VB_EXCEPTION_CALLBACK_ARITY);
            wasm.vbSetExceptionCallback(this.sim, this.exceptionSlot);
        } else {
            wasm.vbSetExceptionCallback(this.sim, 0);
        }
        this.executeInstalled = this.wantsExecute();
        if (this.executeInstalled) {
            this.executeSlot ||= installVbCallback(
                wasm, (sim, address, code, length) => this.onExecute(address >>> 0, code, length), VB_EXECUTE_CALLBACK_ARITY);
            wasm.vbSetExecuteCallback(this.sim, this.executeSlot);
        } else {
            wasm.vbSetExecuteCallback(this.sim, 0);
        }
        this.writeSlot ||= installVbCallback(
            wasm, (sim, address, type, value) => this.onWrite(address >>> 0, type, value), VB_WRITE_CALLBACK_ARITY);
        wasm.vbSetWriteCallback(this.sim, this.writeSlot);
        this.readInstalled = this.wantsRead();
        if (this.readInstalled) {
            this.readSlot ||= installVbCallback(
                wasm, (sim, address, type, value) => this.onRead(address >>> 0, type, value), VB_READ_CALLBACK_ARITY);
            wasm.vbSetReadCallback(this.sim, this.readSlot);
        } else {
            wasm.vbSetReadCallback(this.sim, 0);
        }
    }

    protected wantsExecute(): boolean {
        return this.live !== undefined || this.breakpointSet.size > 0 || this.untilPc !== undefined || this.stepping !== undefined
            || this.execWatches.length > 0 || this.calls !== undefined || this.ring !== undefined
            || this.coverageRom !== undefined || (this.vipUntil !== undefined && this.vipUntil.event !== 'frame');
    }

    protected wantsRead(): boolean {
        return this.readWatches.length > 0;
    }

    protected onExecute(pc: number, codePointer: number, length: number): number {
        const refired = this.takeRefire('exec', pc);
        if (!refired && this.live) {
            this.liveStep(pc);
        }
        if (!refired && this.calls) {
            const heap = this.heap();
            this.followCall(pc, heap[codePointer] | heap[codePointer + 1] << 8);
        }
        if (!refired && this.ring) {
            if (this.lastNext !== undefined && pc !== this.lastNext) {
                this.recordBranch(this.lastExec!, pc);
            }
            this.lastExec = pc;
            this.lastNext = (pc + length * 2) >>> 0;
        }
        if (!refired && this.coverageRom) {
            const bus = (pc & 0x07ffffff) >>> 0;
            if (bus >>> 24 === 7) {
                this.coverageRom[(bus & (this.romBytes - 1)) >>> 1]++;
            } else {
                const folded = this.canonical(pc);
                this.coverageOther!.set(folded, (this.coverageOther!.get(folded) ?? 0) + 1);
            }
        }
        if (!refired && this.vipUntil && this.vipUntil.event !== 'frame' && this.vipHappened()) {
            return this.requestStop('until', { kind: 'exec', address: pc });
        }
        if (this.stepping) {
            this.stepping.seen++;
            if (this.stepping.seen >= this.stepping.target) {
                return this.requestStop('step', { kind: 'exec', address: pc });
            }
        }
        if (refired) {
            return 0;
        }
        const at = this.canonical(pc);
        for (const watch of this.execWatches) {
            if (at < watch.start || at >= watch.end || !watch.accepts(this.frame, at)) {
                continue;
            }
            const hit = this.hitFor(watch, 'exec', at, at, 0);
            if (watch.spec.test && !watch.spec.test(hit)) {
                continue;
            }
            this.recordHit(watch, hit);
            if (watch.stops) {
                return this.requestStop('watch', { kind: 'exec', address: pc }, watch, hit);
            }
        }
        if (this.untilPc === at) {
            return this.requestStop('until', { kind: 'exec', address: pc });
        }
        if (this.breakpointSet.has(at)) {
            return this.requestStop('breakpoint', { kind: 'exec', address: pc });
        }
        return this.pausing.length > 0 ? this.requestPause({ kind: 'exec', address: pc }) : 0;
    }

    // reported before it runs: a JAL is a call about to be made, `jmp [lp]` a return. Register calls, tail calls
    // and stack switches are not seen; this follows a compiler's ordinary discipline
    protected followCall(pc: number, code: number): void {
        const calls = this.calls!;
        const opcode = code >>> 10;
        if (opcode === OPCODE_JAL) {
            calls.push({ site: this.canonical(pc) });
            if (calls.length > MAX_CALL_DEPTH) {
                calls.shift();
            }
        } else if (opcode === OPCODE_JMP && (code & 0x1f) === LINK_REGISTER) {
            if (calls.length > 0 && calls[calls.length - 1].exception === undefined) {
                calls.pop();
            }
        } else if (opcode === OPCODE_RETI) {
            // whatever the handler called and never returned from goes with it
            const at = calls.map(frame => frame.exception !== undefined).lastIndexOf(true);
            if (at >= 0) {
                calls.length = at;
            }
        }
    }

    protected onException(causePointer: number): number {
        const heap = this.heap();
        const cause = heap[causePointer] | heap[causePointer + 1] << 8;
        // the repeat after a stop is the exception actually being taken, so it only must not stop again; everything
        // below still has to hear of it
        const refired = this.takeRefire('exception', this.pc);
        if (!refired && this.faultStop && isFault(cause)) {
            const stop = this.requestStop('fault', { kind: 'exception', address: this.pc });
            this.stopping!.exception = cause;
            return stop;
        }
        if (this.calls) {
            this.calls.push({ site: this.canonical(this.pc), exception: cause });
            if (this.calls.length > MAX_CALL_DEPTH) {
                this.calls.shift();
            }
        }
        if (this.ring) {
            // put on the branch into the handler, which the next instruction makes
            this.pendingCause = cause;
        }
        return 0;
    }

    protected recordBranch(from: number, to: number): void {
        const ring = this.ring!;
        const source = this.canonical(from);
        const target = this.canonical(to);
        const newest = (ring.next + ring.from.length - 1) % ring.from.length;
        // the same branch again is a loop going round: counted, not kept again
        if (ring.count > 0 && ring.from[newest] === source && ring.to[newest] === target && ring.cause[newest] === this.pendingCause) {
            ring.times[newest]++;
            this.pendingCause = 0;
            return;
        }
        ring.from[ring.next] = source;
        ring.to[ring.next] = target;
        ring.cause[ring.next] = this.pendingCause;
        ring.times[ring.next] = 1;
        this.pendingCause = 0;
        ring.next = (ring.next + 1) % ring.from.length;
        ring.count = Math.min(ring.count + 1, ring.from.length);
    }

    protected onWrite(address: number, type: number, valuePointer: number): number {
        if (this.takeRefire('write', address)) {
            return 0;
        }
        if (address === VB_TERMINAL_PORT && this.terminalBytes.length < 1 << 20) {
            this.terminalBytes.push(this.heap()[valuePointer]);
        } else if (this.esSound && address === VB_ES_SOUND_PORT && (type === VbDataType.S16 || type === VbDataType.U16)) {
            // the whole halfword is the command; a narrower store is not one
            const heap = this.heap();
            const command = heap[valuePointer] | heap[valuePointer + 1] << 8;
            if (this.esSoundCommands.length < 1 << 16) {
                this.esSoundCommands.push(command);
            }
            if (command === ES_SOUND_INIT) {
                this.gamePakInterrupt = true;
            }
        }
        return this.writeWatches.length > 0 ? this.offer(this.writeWatches, 'write', address, type, valuePointer) : 0;
    }

    protected onRead(address: number, type: number, valuePointer: number): number {
        if (this.takeRefire('read', address)) {
            return 0;
        }
        return this.offer(this.readWatches, 'read', address, type, valuePointer);
    }

    // whether this report repeats the one a stop was made at
    protected takeRefire(kind: Refire['kind'], address: number): boolean {
        const refire = this.refire;
        if (refire === undefined || refire.kind !== kind) {
            return false;
        }
        // whatever it is, the next report of this kind is past the stop
        this.refire = undefined;
        return refire.address === address;
    }

    // as the CPU would read them, without the CPU reading them
    read(address: number | string, length: number): Uint8Array {
        const at = this.resolve(address);
        const out = new Uint8Array(Math.max(0, length));
        for (let i = 0; i < out.length; i++) {
            out[i] = this.wasm.vbRead(this.sim, (at + i) >>> 0, VbDataType.U8) & 0xff;
        }
        return out;
    }

    read8(address: number | string): number {
        return this.wasm.vbRead(this.sim, this.resolve(address), VbDataType.U8) & 0xff;
    }

    read16(address: number | string): number {
        return this.wasm.vbRead(this.sim, this.resolve(address), VbDataType.U16) & 0xffff;
    }

    read32(address: number | string): number {
        return this.wasm.vbRead(this.sim, this.resolve(address), VbDataType.S32) >>> 0;
    }

    write(address: number | string, bytes: ArrayLike<number>): void {
        const at = this.resolve(address);
        for (let i = 0; i < bytes.length; i++) {
            this.wasm.vbWrite(this.sim, (at + i) >>> 0, VbDataType.U8, bytes[i]);
        }
    }

    write8(address: number | string, value: number): void {
        this.wasm.vbWrite(this.sim, this.resolve(address), VbDataType.U8, value);
    }

    write16(address: number | string, value: number): void {
        this.wasm.vbWrite(this.sim, this.resolve(address), VbDataType.U16, value);
    }

    write32(address: number | string, value: number): void {
        this.wasm.vbWrite(this.sim, this.resolve(address), VbDataType.S32, value | 0);
    }

    // writes into the cartridge for a ROM address and through the bus elsewhere, then clears the instruction cache
    // (keeping whether it is on) so patched code runs. ROM patches stay through `restore` and `loadState`
    patch(address: number | string, bytes: ArrayLike<number>): void {
        const at = this.resolve(address);
        for (let i = 0; i < bytes.length; i++) {
            const folded = this.canonical((at + i) >>> 0);
            if (folded >>> 24 === 7) {
                // the core's copy only, as the bytes the machine was made from are the caller's
                this.heap()[this.romPointer + (folded & (this.romBytes - 1))] = bytes[i];
            } else {
                this.wasm.vbWrite(this.sim, (at + i) >>> 0, VbDataType.U8, bytes[i]);
            }
        }
        this.clearInstructionCache();
    }

    // up to the highest byte the game has written, as the app saves it
    sram(): Uint8Array {
        const ram = new Uint8Array(this.wasm.memory.buffer, this.ramPointer, this.ramBytes);
        return ram.slice(0, saveRamHighWater(ram));
    }

    get pc(): number {
        return this.wasm.vbGetProgramCounter(this.sim) >>> 0;
    }

    registers(): Registers {
        const program: number[] = [];
        for (let i = 0; i < 32; i++) {
            program.push(this.wasm.vbGetProgramRegister(this.sim, i) >>> 0);
        }
        const system: Record<string, number> = {};
        for (const [name, index] of Object.entries(VbSystemRegister)) {
            if (typeof index === 'number') {
                system[name] = this.wasm.vbGetSystemRegister(this.sim, index) >>> 0;
            }
        }
        return { pc: this.pc, program, system };
    }

    // by name: `pc`, `r10`, `sp`, `psw` and so on
    register(name: string): number {
        const key = name.trim().toLowerCase();
        if (key === 'pc') {
            return this.pc;
        }
        const program = /^r(\d+)$/.exec(key);
        const index = program ? Number(program[1]) : REGISTER_ALIASES[key];
        if (index !== undefined && index >= 0 && index < 32) {
            return this.wasm.vbGetProgramRegister(this.sim, index) >>> 0;
        }
        const system = (VbSystemRegister as unknown as Record<string, number>)[key.toUpperCase()];
        if (typeof system === 'number') {
            return this.wasm.vbGetSystemRegister(this.sim, system) >>> 0;
        }
        throw new Error(`Unknown register "${name}".`);
    }

    protected programRegisters(): Record<string, number> {
        const out: Record<string, number> = {};
        for (let i = 0; i < 32; i++) {
            out[`r${i}`] = this.wasm.vbGetProgramRegister(this.sim, i) >>> 0;
        }
        return out;
    }

    setRegister(name: string, value: number): void {
        const key = name.trim().toLowerCase();
        if (key === 'pc') {
            this.wasm.vbSetProgramCounter(this.sim, value >>> 0);
            return;
        }
        const program = /^r(\d+)$/.exec(key);
        const index = program ? Number(program[1]) : REGISTER_ALIASES[key];
        if (index !== undefined && index >= 0 && index < 32) {
            this.wasm.vbSetProgramRegister(this.sim, index, value | 0);
            return;
        }
        const system = (VbSystemRegister as unknown as Record<string, number>)[key.toUpperCase()];
        if (typeof system === 'number') {
            this.wasm.vbSetSystemRegister(this.sim, system, value >>> 0);
            return;
        }
        throw new Error(`Unknown register "${name}".`);
    }

    // from a number, `0x0701A2B0`, `1234`, or a symbol with an optional offset (`main`, `Actor::update+0x10`) when
    // there is an `.elf`
    resolve(spec: number | string): number {
        if (typeof spec === 'number') {
            return spec >>> 0;
        }
        const text = spec.trim();
        if (/^(0x[0-9a-f]+|\d+)$/i.test(text)) {
            return Number(text) >>> 0;
        }
        const match = /^(.*?)\s*([+-])\s*(0x[0-9a-f]+|\d+)$/i.exec(text);
        const name = match ? match[1] : text;
        const offset = match ? (match[2] === '-' ? -1 : 1) * Number(match[3]) : 0;
        const symbol = this.symbols?.lookup(name);
        if (!symbol) {
            throw new Error(this.symbols
                ? `No symbol "${name}" in the build.`
                : `"${name}" is not an address, and there are no symbols to look it up in (give an .elf).`);
        }
        return (symbol.address + offset) >>> 0;
    }

    // `0x0701A2B0`, with the build's name for it where there is one
    describe(address: number): string {
        const hex = `0x${(address >>> 0).toString(16).padStart(8, '0')}`;
        const name = this.symbols?.describe(address);
        return name ? `${hex} ${name}` : hex;
    }

    snapshot(): VbSnapshot {
        const size = this.wasm.vbSizeOf();
        return {
            state: new Uint8Array(this.wasm.memory.buffer, this.sim, size).slice(),
            frame: this.frame,
            vipFrames: this.vipFrames,
            chunkLeft: this.chunkLeft,
            refire: this.refire,
            calls: this.calls?.map(frame => ({ ...frame })),
            gamePakInterrupt: this.gamePakInterrupt,
        };
    }

    restore(snapshot: VbSnapshot): void {
        this.restoreStruct(snapshot.state);
        this.frame = snapshot.frame;
        this.vipFrames = snapshot.vipFrames;
        this.chunkLeft = snapshot.chunkLeft;
        this.refire = snapshot.refire;
        // what was followed then is the stack then; nothing followed is an empty one
        this.calls = snapshot.calls?.map(frame => ({ ...frame }));
        this.gamePakInterrupt = snapshot.gamePakInterrupt ?? false;
        this.updateCallbacks();
    }

    // a VUEPort save state file the app loads like its own, for this ROM, as one machine
    async saveState(label?: string): Promise<Uint8Array> {
        const size = this.wasm.vbSizeOf();
        const state = new Uint8Array(this.wasm.memory.buffer, this.sim, size).slice();
        const thumbnail = await encodePng(this.picture('left'));
        return wrapSaveState(
            [state.buffer],
            this.identity(),
            // what the app's ESSound player writes when nothing is playing
            { playing: [], volumes: [], balances: [] },
            { kind: 'manual', created: Date.now(), label, thumbnail },
        );
    }

    // the frame count carries on, as a state says what the machine was, not how long it ran; the next frame starts
    // from the state's own clock
    async loadState(file: Uint8Array, options: { otherRom?: boolean } = {}): Promise<void> {
        const { states, otherRom } = await unwrapSaveState(file, 1, this.identity(), options);
        this.restoreStruct(new Uint8Array(states[0]));
        this.chunkLeft = 0;
        this.refire = undefined;
        this.calls = undefined;
        if (otherRom) {
            // it held the code of the ROM the state was made with
            this.clearInstructionCache();
        }
        this.updateCallbacks();
    }

    // keeps whether it is on, so what runs next is read from memory
    clearInstructionCache(): void {
        const enabled = this.wasm.vbGetSystemRegister(this.sim, VbSystemRegister.CHCW) & 0x2;
        // CHCW with ICC: clear all 128 entries, from the first
        this.wasm.vbSetSystemRegister(this.sim, VbSystemRegister.CHCW, enabled | (128 << 8) | 1);
    }

    // a bare state struct as the app's worker hands it over from `Sim.saveState`; forks of a running game start
    // here, at the start of a frame
    loadStruct(state: Uint8Array): void {
        this.restoreStruct(state);
        this.chunkLeft = 0;
        this.refire = undefined;
        this.calls = undefined;
        this.updateCallbacks();
    }

    protected identity(): VesEmulatorSaveStateIdentity {
        const at = this.rom.length - ROM_HEADER_OFFSET_FROM_END;
        return { romIdentity: this.rom.slice(at, at + 32), romSize: romSizeInMBit(this.rom) };
    }

    // the struct holds absolute pointers to the cartridge, its RAM and the sample buffer, plus hardware model and
    // callbacks, all from the machine that took it. The worker's `restoreFrom` repairs the same things
    protected restoreStruct(state: Uint8Array): void {
        const size = this.wasm.vbSizeOf();
        if (state.length !== size) {
            throw new Error(`This state is ${state.length} bytes but this core uses ${size}; it was made with a different core.`);
        }
        new Uint8Array(this.wasm.memory.buffer, this.sim, size).set(state);
        this.clearOrigins();
        this.wasm.vbSetCartROM(this.sim, this.romPointer, this.romBytes);
        this.wasm.vbSetCartRAM(this.sim, this.ramPointer, this.ramBytes);
        this.wasm.vbSetSamples(this.sim, this.samples, VbDataType.F32, VB_SAMPLES_PER_BUFFER);
        this.wasm.SetHardwareMode?.(this.sim, this.vbc ? 1 : 0);
    }

    // what the VIP is showing now, as the core composites it
    frameBuffer(): VbFrame {
        const colorMode = this.wasm.GetVideoFormat?.(this.sim) === 1
            && this.wasm.GetColorPixels !== undefined && this.wasm.GetExtColorPixels !== undefined;
        if (colorMode) {
            this.wasm.GetColorPixels!(this.sim);
        } else {
            this.wasm.GetPixels(this.sim);
        }
        const pointer = colorMode ? this.wasm.GetExtColorPixels!(this.sim) : this.wasm.GetExtPixels(this.sim);
        return {
            pixels: new Uint8Array(this.wasm.memory.buffer, pointer, vbFrameBytes(colorMode)).slice(),
            colorMode,
        };
    }

    picture(eye: VbEye = 'left'): VbPicture {
        return framePicture(this.frameBuffer(), eye);
    }

    screenshot(options: { eye?: VbEye, scale?: number } = {}): Promise<Uint8Array> {
        return encodePng(this.picture(options.eye ?? 'left'), options.scale ?? 1);
    }

    // 0 or 1; the drawing processor draws into the other. See `vb-framebuffer.ts`
    displayedBuffer(): 0 | 1 {
        if (!this.wasm.vbGetDisplayedBuffer) {
            throw new Error('This core does not say which frame buffer is shown; ask for buffer 0 or 1.');
        }
        return (this.wasm.vbGetDisplayedBuffer(this.sim) & 1) as 0 | 1;
    }

    // keeps what draws each pixel for `pixelOrigins`. Earlier pixels, and everything after a state load or
    // restore, are `unknown`. Costs about as much as the drawing (a little of a frame); only the frame a buffer is
    // drawn in needs it, so a survey can switch it on two frames before the one it reads
    keepOrigins(keep = true): void {
        const wasm = this.wasm;
        if (!wasm.vbSetPixelOrigins || !wasm.vbSizeOfPixelOrigins) {
            throw new Error('This core does not keep pixel origins.');
        }
        if (keep && this.originsPointer === 0) {
            const size = wasm.vbSizeOfPixelOrigins();
            this.originsPointer = wasm.Realloc(0, size);
            if (this.originsPointer === 0) {
                throw new Error('The emulator core ran out of memory.');
            }
            this.heap().fill(0, this.originsPointer, this.originsPointer + size);
        }
        this.keepingOrigins = keep;
        wasm.vbSetPixelOrigins(this.sim, keep ? this.originsPointer : 0);
    }

    get keepsOrigins(): boolean {
        return this.keepingOrigins;
    }

    // two words a pixel, row by row (see `vb-origin.ts`), of the screen or a region of it. All zero (`unknown`)
    // for a buffer not drawn since `keepOrigins`
    pixelOrigins(eye: 'left' | 'right', buffer: 0 | 1, region?: { x: number, y: number, width: number, height: number }): Uint32Array {
        const area = region ?? { x: 0, y: 0, width: VB_SCREEN_WIDTH, height: VB_SCREEN_HEIGHT };
        if (area.x < 0 || area.y < 0 || area.width < 1 || area.height < 1
            || area.x + area.width > VB_SCREEN_WIDTH || area.y + area.height > VB_SCREEN_HEIGHT) {
            throw new Error(`${area.x},${area.y},${area.width},${area.height} is not a region of the screen.`);
        }
        const out = new Uint32Array(area.width * area.height * 2);
        if (this.originsPointer === 0) {
            return out;
        }
        const pixels = VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT;
        // after the two eyes' shadow images, the buffers by buffer then eye; column-major
        const at = this.originsPointer + (2 + buffer * 2 + (eye === 'right' ? 1 : 0)) * pixels * 8;
        const source = this.u32(at, pixels * 2);
        for (let x = 0; x < area.width; x++) {
            for (let y = 0; y < area.height; y++) {
                const from = ((area.x + x) * VB_SCREEN_HEIGHT + area.y + y) * 2;
                const to = (y * area.width + x) * 2;
                out[to] = source[from];
                out[to + 1] = source[from + 1];
            }
        }
        return out;
    }

    // its 16 bytes as character memory holds them (8 rows, 2 bits a pixel, leftmost pixel lowest) when the buffer
    // was drawn, whatever was loaded since. Undefined while no origins are kept, zeros for a buffer not drawn since
    drawnCharacter(buffer: 0 | 1, index: number): Uint8Array | undefined {
        if (this.originsPointer === 0 || index < 0 || index >= 4096) {
            return undefined;
        }
        const at = this.originsPointer + 6 * VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT * 8 + buffer * 0x10000 + index * 16;
        return this.heap().slice(at, at + 16);
    }

    // as they were when a frame buffer was drawn: GPLT0-3 then JPLT0-3, each the shade its pixel values 0-3 select
    drawnPalettes(buffer: 0 | 1): number[][] | undefined {
        if (this.originsPointer === 0) {
            return undefined;
        }
        const at = this.originsPointer + 6 * VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT * 8 + 2 * 0x10000 + buffer * 32;
        const bytes = this.heap().slice(at, at + 32);
        return Array.from({ length: 8 }, (_, palette) => [...bytes.subarray(palette * 4, palette * 4 + 4)]);
    }

    protected originsPointer = 0;
    protected keepingOrigins = false;

    // they were of pictures this machine no longer has
    protected clearOrigins(): void {
        if (this.originsPointer !== 0) {
            this.heap().fill(0, this.originsPointer, this.originsPointer + this.wasm.vbSizeOfPixelOrigins!());
        }
    }

    // with the build's names where there are any; `before` of the `count` lines come from ahead of the address
    disassemble(at: number | string, count: number, before = 0): VbInstruction[] {
        const lines = disassemble(this.wasm, this.sim, this.resolve(at), Math.max(0, Math.min(count, 4096)), before);
        const rows = attachSourceLines(
            annotateDisassembly(lines, this.symbols?.index, this.romBytes), this.symbols?.lines, this.romBytes);
        return rows.map(row => {
            const { line } = row;
            const labels = [...row.targets.values()].map(target => target.label);
            if (row.loaded) {
                labels.push(row.loaded.label);
            }
            const instruction: VbInstruction = {
                address: line.address >>> 0,
                code: line.code,
                mnemonic: line.mnemonic,
                operands: line.operands,
                text: line.operands.length > 0 ? `${line.mnemonic} ${line.operands.join(', ')}` : line.mnemonic,
            };
            if (row.owner) {
                const offset = (line.address - row.owner.address) >>> 0;
                instruction.symbol = offset === 0 ? row.owner.name : `${row.owner.name}+0x${offset.toString(16)}`;
            }
            if (labels.length > 0) {
                instruction.comment = labels.join(', ');
            }
            const source = this.symbols?.sourceAt(line.address);
            if (source) {
                instruction.source = source;
            }
            return instruction;
        });
    }

    // each channel decoded plus the waveform and modulation tables. The VSU's addresses are write-only on hardware,
    // so this composes them from the core's decoded copy like the app's VSU panel (see `vb-vsu-layout.ts`)
    vsu(): { channels: VsuChannel[], waveforms: number[][], modulation: number[] } {
        this.vsuLayout ??= calibrateVsuLayout(this.wasm);
        const map = composeVsuMap(this.wasm, this.vsuLayout, this.sim);
        const registers = new DataView(map.buffer, VSU_REGISTER_BASE - VB_VSU_BASE, VSU_REGISTER_BLOCK_BYTES);
        const table = (base: number, length: number) => map.subarray(base - VB_VSU_BASE, base - VB_VSU_BASE + length);
        return {
            channels: Array.from({ length: VSU_CHANNEL_COUNT }, (unused, index) => decodeVsuChannel(registers, index)),
            waveforms: VSU_WAVEFORM_BASES.map(base => vsuWaveformSamples(table(base, VSU_WAVEFORM_BYTES))),
            modulation: vsuModulationSamples(table(VSU_MODULATION_BASE, VSU_MODULATION_BYTES)),
        };
    }

    protected vsuLayout?: VsuLayout;

    // everything written to the debug port since the start, or since `takeTerminal`
    get terminal(): string {
        return new TextDecoder().decode(Uint8Array.from(this.terminalBytes));
    }

    takeTerminal(): string {
        const text = this.terminal;
        this.terminalBytes = [];
        return text;
    }

    // for a machine made with `esSound`; forgets them
    takeEsSound(): number[] {
        const commands = this.esSoundCommands;
        this.esSoundCommands = [];
        return commands;
    }

    protected copyIn(bytes: Uint8Array): number {
        const pointer = this.wasm.Realloc(0, bytes.length);
        if (pointer === 0 && bytes.length !== 0) {
            throw new Error('The emulator core ran out of memory.');
        }
        new Uint8Array(this.wasm.memory.buffer, pointer, bytes.length).set(bytes);
        return pointer;
    }

    // kept between calls, as the execute callback reads through it per instruction and a new view costs more
    // than the instruction. Remade only when memory grows, which detaches the old one
    protected heap(): Uint8Array {
        if (this.heapView?.buffer !== this.wasm.memory.buffer) {
            this.heapView = new Uint8Array(this.wasm.memory.buffer);
        }
        return this.heapView;
    }

    protected heapView?: Uint8Array;

    protected u32(pointer: number, length = 1): Uint32Array {
        return new Uint32Array(this.wasm.memory.buffer, pointer, length);
    }
}

export function accessBytes(type: number): number {
    return TYPE_BYTES[type] ?? 4;
}

function maskTo(value: number, size: number): number {
    return size >= 4 ? value >>> 0 : value & (size === 2 ? 0xffff : 0xff);
}
