/**
 * Profiling a game while it is played: "where is this frame going", every frame, unlike VesProfileCollector's
 * exhaustive report from a replayed recording. Measured against the vendored core:
 *
 * - An execute callback costs 1.03x empty and 1.17x with a set lookup per instruction (tests/breakpoint-probe.mjs).
 *   The core runs about five times faster than the machine, so there is room.
 * - The clock budget Emulate is given is decremented as it runs and is readable in the callback (398, 391, 386, 381
 *   over the first four instructions of a boot), so time here is real clocks, not instruction counts.
 * - Halt parks the processor while the clock runs on, so idle is measurable (VesInstructionKind.HALT). For the many
 *   games that do not halt, harvestWait finds loops still going round when the interrupt arrived.
 *
 * The worker feeds program counters and clocks; the panel names addresses with the build's symbols.
 */

import { VesInstructionKind } from './emulator-profile';
import { VB_INTERRUPT_VECTOR_BASE, VbCounter, VbInterrupt } from './vb-constants';

// charged with a frame's own time when nothing called it, as profiling starts several calls deep (the game's main loop
// is one of these). Zero, as addresses travel unsigned and the VB executes nothing at zero (the VIP register window)
export const VES_LIVE_PROFILE_ROOT = 0;

// hardware enters an interrupt handler by jumping to its vector without a call, so arriving at one opens a frame closed
// by reti; otherwise the VIP handler's work is charged to whatever was interrupted. Only a vector's start counts, or
// every stub instruction pushed a frame that only one reti closed
const VECTOR_BASE = VB_INTERRUPT_VECTOR_BASE;
const VECTOR_STRIDE = 0x10;
const VECTOR_END = VECTOR_BASE + (VbInterrupt.VPU + 1) * VECTOR_STRIDE;
const VECTOR_STRIDE_MASK = VECTOR_STRIDE - 1;

const RESET_VECTOR = 0xfffffff0;

const MAX_DEPTH = 256;

// how far a stretch of instructions may range and still be one loop; generous on purpose, so a little unrolling still
// counts, while code getting on with something moves further quickly
const QUIET_SPAN = 256;

// 100 µs, half a percent of a frame. A real wait is tens of thousands of clocks, so a short loop an interrupt happened
// to land in stays charged as work
const MIN_WAIT_CLOCKS = 2000;

// the store density a waiting loop may have: VUEngine's frame loop stores a byte every pass and controller polling
// writes to the hardware, while a memcpy stores on one instruction in three
const QUIET_STORE_RATIO = 6;

interface LiveRow {
    address: number;
    self: number;
    total: number;
    calls: number;
    touched: boolean;
}

export interface LiveProfileFunction {
    address: number;
    self: number;
    selfAvg: number;
    selfPeak: number;
    total: number;
    totalAvg: number;
    totalPeak: number;
    totalMin: number; // the cheapest frame it appeared in at all, which is not the same as zero
    calls: number;
    callsAvg: number;
    frames: number;
}

export interface LiveProfileFrameFunction {
    address: number;
    self: number;
    total: number;
    calls: number;
}

// only readable while still in the window (a couple of seconds), so a caller keeps the answer, not the number
export interface LiveProfileFrame {
    number: number; // 1-based, counted from when profiling began
    clocks: number; // `halted` and `waited` (looping until an interrupt) are part of these
    halted: number;
    waited: number;
    waitAt: number; // 0 if it had none
    instructions: number;
    functions: LiveProfileFrameFunction[];
}

export interface LiveProfileSnapshot {
    frames: number; // zero means nothing has run yet
    framesSeen: number;
    frameClocks: number; // clocks in a frame at the machine's own rate, what a share is a share of
    clocks: number;
    clocksAvg: number;
    clocksPeak: number;
    halted: number;
    haltedAvg: number;
    haltedPeak: number;
    // clocks going round a loop until an interrupt arrived, how most games wait (see harvestWait); busy is the frame
    // less this and halted
    waiting: number;
    waitingAvg: number;
    waitingPeak: number;
    waitingAt: number; // 0 if it had none
    instructions: number;
    instructionsAvg: number;
    // busy clocks per frame of the window, oldest first, so an overrun shows as one bar above budget; the newest is
    // frame number framesSeen
    frameBusy: number[];
    pinned?: LiveProfileFrame;
    functions: LiveProfileFunction[];
    resets: number;
    overflows: number; // calls dropped for depth, which should be zero on anything sane
    // from the core's counters (see VbCounter), per picture rather than per game frame, as the worker samples them so;
    // absent on a core without counters
    machine?: LiveMachineCounters;
}

// in CPU cycles
export interface LiveMachineCounters {
    frames: number;
    last: LiveMachineFrame;
    avg: LiveMachineFrame;
}

// see VbCounter for each
export interface LiveMachineFrame {
    cycles: number;
    halted: number;
    cacheHits: number;
    cacheMisses: number;
    fetchWait: number;
    busVip: number;
    busVsu: number;
    busMisc: number;
    busCart: number;
    busSram: number;
    busWram: number;
    vipContention: number;
    pipelineWait: number;
    xpBusy: number;
    xpHeld: number;
}

export function liveMachineFrame(values: ArrayLike<number>): LiveMachineFrame {
    return {
        cycles: values[VbCounter.Cycles],
        halted: values[VbCounter.Halted],
        cacheHits: values[VbCounter.CacheHits],
        cacheMisses: values[VbCounter.CacheMisses],
        fetchWait: values[VbCounter.FetchWait],
        busVip: values[VbCounter.BusVip],
        busVsu: values[VbCounter.BusVsu],
        busMisc: values[VbCounter.BusMisc],
        busCart: values[VbCounter.BusCart],
        busSram: values[VbCounter.BusSram],
        busWram: values[VbCounter.BusWram],
        vipContention: values[VbCounter.VipContention],
        pipelineWait: values[VbCounter.PipelineWait],
        xpBusy: values[VbCounter.XpBusy],
        xpHeld: values[VbCounter.XpHeld],
    };
}

// four numbers per function (address, self, total, calls) in one typed array rather than a map of objects, as a window
// holds a hundred of these, written once and read in bulk
type VesLiveFrameRows = Int32Array;

interface VesLiveFrame {
    rows: VesLiveFrameRows;
    clocks: number;
    halted: number;
    waited: number;
    waitAt: number; // 0 if there was none
    instructions: number;
}

// feed it every instruction in order with what the previous one cost (the callback fires before an instruction
// executes) and close each frame as the machine reaches it
export class VesLiveProfileCollector {

    protected readonly rows = new Map<number, LiveRow>();
    // rows written since the last frame was closed, which get zeroed; the map itself is kept, as the set of functions
    // settles within a second
    protected readonly touched: LiveRow[] = [];

    // parallel arrays, as one object per level would allocate on every call
    protected readonly stackRow: LiveRow[] = [];
    protected readonly stackReturn: number[] = [];
    protected readonly stackEnter: number[] = [];
    // inclusive time only counts for a function's outermost activation, or recursion would count the same clocks once
    // per level
    protected readonly stackOutermost: boolean[] = [];
    protected readonly active = new Map<number, number>();

    protected cycle = 0;
    // set by a call, resolved on the next instruction; see VesProfileCollector
    protected pendingReturn = -1;
    // a halt's clocks are the machine waiting, so they go to the frame's idle total, not to the function it sits in
    protected halting = false;

    // a quiet stretch writes nothing, calls nothing and stays within QUIET_SPAN bytes; it only counts as waiting once
    // something the program couldn't have caused ends it (see harvestWait)
    protected quietRow?: LiveRow;
    protected quietSince = 0;
    protected quietLow = 0;
    protected quietHigh = 0;
    protected quietSteps = 0;
    protected quietStores = 0;

    protected frameClocksSpent = 0;
    protected frameHalted = 0;
    protected frameWaited = 0;
    protected frameWaitTop = 0;
    protected frameWaitAt = 0;
    protected frameInstructions = 0;

    protected resets = 0;
    protected overflowed = 0;
    protected framesSeen = 0;

    protected readonly frames: VesLiveFrame[] = [];

    // two seconds of play make a peak a peak rather than a hiccup, while a change in the game still shows in the
    // averages within a moment
    constructor(protected readonly capacity: number) {
        this.push(VES_LIVE_PROFILE_ROOT, false);
    }

    // hot path, runs twenty million times a second; `clocks` is what the previous instruction cost
    step(address: number, kind: VesInstructionKind, clocks: number): void {
        this.charge(clocks);
        this.halting = kind === VesInstructionKind.HALT;
        this.frameInstructions++;

        if (address === RESET_VECTOR) {
            // a reset is not a return and nothing below it comes back; the open frames are closed rather than dropped,
            // so their time isn't lost
            this.unwind(1);
            this.pendingReturn = -1;
            this.resets++;
        }

        if (this.pendingReturn >= 0) {
            this.push(address, false, this.pendingReturn);
            this.pendingReturn = -1;
        } else if (address >= VECTOR_BASE && address < VECTOR_END
            && (address & VECTOR_STRIDE_MASK) === 0) {
            // nothing called an interrupt, so reti closes it. It also proves a wait was one, as whatever was going
            // round was still going when the interrupt arrived
            this.harvestWait();
            this.push(address, true);
        } else {
            this.unwindTo(address);
        }

        if (kind === VesInstructionKind.CALL) {
            // JAL is two halfwords, so this is the instruction after it
            this.pendingReturn = (address + 4) >>> 0;
        } else if (kind === VesInstructionKind.RETI) {
            this.leaveInterrupt();
        }

        // calling something, halting, leaving the neighbourhood or writing hard enough to be copying ends a quiet
        // stretch
        const row = this.stackRow[this.stackRow.length - 1];
        const low = address < this.quietLow ? address : this.quietLow;
        const high = address > this.quietHigh ? address : this.quietHigh;
        const stores = kind === VesInstructionKind.STORE
            ? this.quietStores + 1
            : this.quietStores;
        if (row !== this.quietRow
            || kind === VesInstructionKind.CALL
            || kind === VesInstructionKind.HALT
            || high - low > QUIET_SPAN
            || stores * QUIET_STORE_RATIO > this.quietSteps) {
            this.quietRow = row;
            this.quietSince = this.cycle;
            this.quietLow = address;
            this.quietHigh = address;
            this.quietSteps = 1;
            this.quietStores = kind === VesInstructionKind.STORE ? 1 : 0;
        } else {
            this.quietLow = low;
            this.quietHigh = high;
            this.quietSteps++;
            this.quietStores = stores;
        }
    }

    /**
     * Charges a finished wait to the frame rather than the code it was in. Called only where something outside the
     * program ended a quiet stretch (an interrupt, the frame boundary): a loop still going then was waiting, the
     * spinning equivalent of halt (VUEngine's frame loop is a bare `while(!hasGameFrameStarted())`). The clocks are
     * taken back out of the function, so the engine's idle loop does not top the table.
     */
    protected harvestWait(): void {
        const row = this.quietRow;
        if (row === undefined) {
            return;
        }
        const waited = this.cycle - this.quietSince;
        this.quietSince = this.cycle;
        if (waited < MIN_WAIT_CLOCKS) {
            return;
        }
        // never more than the row was charged this frame, so rows, idling and waiting still add up to exactly the frame
        const taken = Math.min(waited, row.self);
        if (taken <= 0) {
            return;
        }
        row.self -= taken;
        this.frameWaited += taken;
        if (taken > this.frameWaitTop) {
            this.frameWaitTop = taken;
            this.frameWaitAt = row.address;
        }
        if (!row.touched) {
            row.touched = true;
            this.touched.push(row);
        }
    }

    // every clock passes through here exactly once (see the accounting check in tests/live-profile-probe.mjs)
    protected charge(clocks: number): void {
        if (clocks <= 0) {
            return;
        }
        this.cycle += clocks;
        this.frameClocksSpent += clocks;
        if (this.halting) {
            this.frameHalted += clocks;
            // already idle and never charged to a row, so not a quiet stretch's to claim a second time
            this.quietSince = this.cycle;
            return;
        }
        const row = this.stackRow[this.stackRow.length - 1];
        row.self += clocks;
        if (!row.touched) {
            row.touched = true;
            this.touched.push(row);
        }
    }

    /**
     * Called on the core's frame break, so figures are per displayed frame rather than per audio buffer (same length,
     * different moment). `spent` is what the executing instruction has run up so far: its cost would only arrive with
     * the next one, and that is often a halt waiting for the very interrupt ending the frame, which would charge a
     * frame of idling to the next frame.
     */
    endFrame(spent = 0): void {
        this.charge(spent);
        // the frame boundary is the other thing a program can't end a loop with itself
        this.harvestWait();
        // frames still open (main and the game loop never return) are settled here, so a function spanning the boundary
        // reports its share of this frame
        for (let depth = 1; depth < this.stackRow.length; depth++) {
            if (this.stackOutermost[depth]) {
                const row = this.stackRow[depth];
                row.total += this.cycle - this.stackEnter[depth];
                this.stackEnter[depth] = this.cycle;
                if (!row.touched) {
                    row.touched = true;
                    this.touched.push(row);
                }
            }
        }

        const rows = new Int32Array(this.touched.length * 4);
        for (let at = 0; at < this.touched.length; at++) {
            const row = this.touched[at];
            const base = at * 4;
            rows[base] = row.address;
            rows[base + 1] = row.self;
            rows[base + 2] = row.total;
            rows[base + 3] = row.calls;
            row.self = 0;
            row.total = 0;
            row.calls = 0;
            row.touched = false;
        }
        this.touched.length = 0;

        if (this.frames.length >= this.capacity) {
            this.frames.shift();
        }
        this.frames.push({
            rows,
            clocks: this.frameClocksSpent,
            halted: this.frameHalted,
            waited: this.frameWaited,
            waitAt: this.frameWaitAt,
            instructions: this.frameInstructions,
        });
        this.framesSeen++;
        this.frameClocksSpent = 0;
        this.frameHalted = 0;
        this.frameWaited = 0;
        this.frameWaitTop = 0;
        this.frameWaitAt = 0;
        this.frameInstructions = 0;
    }

    // aggregated on the way out, as the window is read a handful of times a second and written fifty
    snapshot(frameClocks: number, pin?: number): LiveProfileSnapshot {
        const functions = new Map<number, LiveProfileFunction>();
        const last = this.frames.length - 1;
        const frameBusy: number[] = [];
        let clocksTotal = 0;
        let clocksPeak = 0;
        let haltedTotal = 0;
        let haltedPeak = 0;
        let waitedTotal = 0;
        let waitedPeak = 0;
        let instructionsTotal = 0;

        for (let index = 0; index < this.frames.length; index++) {
            const frame = this.frames[index];
            frameBusy.push(frame.clocks - frame.halted - frame.waited);
            clocksTotal += frame.clocks;
            clocksPeak = Math.max(clocksPeak, frame.clocks);
            haltedTotal += frame.halted;
            haltedPeak = Math.max(haltedPeak, frame.halted);
            waitedTotal += frame.waited;
            waitedPeak = Math.max(waitedPeak, frame.waited);
            instructionsTotal += frame.instructions;

            const { rows } = frame;
            for (let at = 0; at < rows.length; at += 4) {
                // written through an Int32Array, so anything in the ROM's mirror at the top of memory comes back
                // negative
                const address = rows[at] >>> 0;
                const self = rows[at + 1];
                const total = rows[at + 2];
                const calls = rows[at + 3];
                let entry = functions.get(address);
                if (!entry) {
                    entry = {
                        address,
                        self: 0, selfAvg: 0, selfPeak: 0,
                        total: 0, totalAvg: 0, totalPeak: 0, totalMin: Number.MAX_SAFE_INTEGER,
                        calls: 0, callsAvg: 0, frames: 0,
                    };
                    functions.set(address, entry);
                }
                entry.selfAvg += self;
                entry.callsAvg += calls;
                entry.totalAvg += total;
                entry.selfPeak = Math.max(entry.selfPeak, self);
                entry.totalPeak = Math.max(entry.totalPeak, total);
                entry.totalMin = Math.min(entry.totalMin, total);
                entry.frames++;
                if (index === last) {
                    entry.self = self;
                    entry.total = total;
                    entry.calls = calls;
                }
            }
        }

        const count = this.frames.length;
        for (const entry of functions.values()) {
            // divided by the window's frames, not the frames the function appeared in, or rare expensive work would top
            // the list
            entry.selfAvg /= count;
            entry.totalAvg /= count;
            entry.callsAvg /= count;
            if (entry.totalMin === Number.MAX_SAFE_INTEGER) {
                entry.totalMin = 0;
            }
        }

        return {
            frames: count,
            framesSeen: this.framesSeen,
            frameClocks,
            clocks: count > 0 ? this.frames[last].clocks : 0,
            clocksAvg: count > 0 ? clocksTotal / count : 0,
            clocksPeak,
            halted: count > 0 ? this.frames[last].halted : 0,
            haltedAvg: count > 0 ? haltedTotal / count : 0,
            haltedPeak,
            waiting: count > 0 ? this.frames[last].waited : 0,
            waitingAvg: count > 0 ? waitedTotal / count : 0,
            waitingPeak: waitedPeak,
            waitingAt: count > 0 ? this.frames[last].waitAt : 0,
            instructions: count > 0 ? this.frames[last].instructions : 0,
            instructionsAvg: count > 0 ? instructionsTotal / count : 0,
            frameBusy,
            pinned: pin === undefined ? undefined : this.frameDetail(pin),
            functions: [...functions.values()],
            resets: this.resets,
            overflows: this.overflowed,
        };
    }

    frameTotals(): Omit<LiveProfileFrame, 'functions'>[] {
        const first = this.framesSeen - this.frames.length + 1;
        return this.frames.map((frame, index) => ({
            number: first + index,
            clocks: frame.clocks,
            halted: frame.halted,
            waited: frame.waited,
            waitAt: frame.waitAt,
            instructions: frame.instructions,
        }));
    }

    // by number rather than index, as the window moves fifty times a second; one that fell off the back is not an error
    protected frameDetail(number: number): LiveProfileFrame | undefined {
        const index = number - (this.framesSeen - this.frames.length + 1);
        if (index < 0 || index >= this.frames.length) {
            return undefined;
        }
        const frame = this.frames[index];
        const functions: LiveProfileFrameFunction[] = [];
        const { rows } = frame;
        for (let at = 0; at < rows.length; at += 4) {
            functions.push({
                address: rows[at] >>> 0,
                self: rows[at + 1],
                total: rows[at + 2],
                calls: rows[at + 3],
            });
        }
        return {
            number,
            clocks: frame.clocks,
            halted: frame.halted,
            waited: frame.waited,
            waitAt: frame.waitAt,
            instructions: frame.instructions,
            functions,
        };
    }

    // keeps the shadow stack the machine is in
    clear(): void {
        this.frames.length = 0;
        this.framesSeen = 0;
        this.resets = 0;
        this.overflowed = 0;
    }

    protected rowFor(address: number): LiveRow {
        let row = this.rows.get(address);
        if (!row) {
            row = { address, self: 0, total: 0, calls: 0, touched: false };
            this.rows.set(address, row);
        }
        return row;
    }

    protected push(address: number, interrupt: boolean, returnTo = -1): void {
        if (this.stackRow.length >= MAX_DEPTH) {
            this.overflowed++;
            return;
        }
        const row = this.rowFor(address);
        const activations = this.active.get(address) ?? 0;
        this.active.set(address, activations + 1);
        row.calls++;
        if (!row.touched) {
            row.touched = true;
            this.touched.push(row);
        }
        this.stackRow.push(row);
        // an interrupt frame is closed by reti, so it gets a return address no instruction can have
        this.stackReturn.push(interrupt ? -1 : returnTo);
        this.stackEnter.push(this.cycle);
        this.stackOutermost.push(activations === 0);
    }

    // a return can skip levels; the clock-charging twin of VesProfileCollector.unwindTo
    protected unwindTo(address: number): void {
        for (let depth = this.stackRow.length - 1; depth > 0; depth--) {
            if (this.stackReturn[depth] === address) {
                this.unwind(depth);
                return;
            }
        }
    }

    protected leaveInterrupt(): void {
        for (let depth = this.stackRow.length - 1; depth > 0; depth--) {
            if (this.stackReturn[depth] === -1) {
                this.unwind(depth);
                return;
            }
        }
    }

    protected unwind(depth: number): void {
        for (let at = this.stackRow.length - 1; at >= depth; at--) {
            const row = this.stackRow[at];
            const activations = (this.active.get(row.address) ?? 1) - 1;
            if (activations > 0) {
                this.active.set(row.address, activations);
            } else {
                this.active.delete(row.address);
            }
            if (this.stackOutermost[at]) {
                row.total += this.cycle - this.stackEnter[at];
                if (!row.touched) {
                    row.touched = true;
                    this.touched.push(row);
                }
            }
        }
        this.stackRow.length = depth;
        this.stackReturn.length = depth;
        this.stackEnter.length = depth;
        this.stackOutermost.length = depth;
    }
}
