/**
 * Collects a profile by replaying a recorded session. VB emulation is bit-deterministic, so a replay with an execute
 * callback gives an exhaustive profile, and the call stack is rebuilt from calls and returns, so it works on optimized
 * builds without frame pointers. This turns the replay's program counters into a call tree; driving the core is the
 * worker's job, and `toFirefoxProfile` converts the result.
 */

export const enum VesInstructionKind {
    OTHER = 0,
    CALL = 1, // JAL, pushes a frame
    // JMP [r31], the ordinary return. Decoded but not acted on, as it missed about one return in thirty on real
    // code (see `returnTo`); frames close on arriving at their return address instead
    RETURN = 2,
    // HALT stops the processor until an interrupt while the clock runs on, so the live profiler charges it to an idle
    // total, a CPU load figure without knowing the engine. A ROM looping on `halt` executes five instructions, then
    // sits on it for a hundred thousand clocks
    HALT = 3,
    // RETI: hardware enters a handler without a call, so this is the only sign one finished. See
    // VesLiveProfileCollector, which opens a frame on the vector and closes it here
    RETI = 4,
    // anything that writes (store, I/O write, bit string). A stretch without writes is likely waiting
    // (`while(!flag);` is a load and a branch), which VesLiveProfileCollector uses for games that spin rather than `halt`
    STORE = 5,
}

// V810 opcodes, in the top six bits of the first halfword
const OP_JMP = 0b000110;
const OP_JAL = 0b101011;
const OP_RETI = 0b011001;
const OP_HALT = 0b011010;
const LINK_REGISTER = 31; // JAL writes the return address into it, JMP returns through it
// `0b11ccww` holds loads, stores, ins and outs; bit 2 marks the writing ones (ST.B/H/W, OUT.B/H/W, not LD or IN)
const OP_WRITE_MASK = 0b110100;
const OP_WRITE = 0b110100;
// bit string instructions, one opcode with the operation in its low bits. Several write (`MOVBSU` is how a VB
// game copies anything large), so the whole group counts as writing; counting a rare read loop as work is the
// error worth making
const OP_BITSTRING = 0b011111;

// what each ROM instruction does to the call stack, decoded once per halfword since the ROM cannot change. 2.6 ms for a
// 1 MB ROM, cuts the call stack's per-instruction cost from 1.34x to 1.13x (see §6.3)
export function decodeRomKinds(rom: Uint8Array): Uint8Array {
    const kinds = new Uint8Array(rom.byteLength >> 1);
    const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
    for (let at = 0; at + 1 < rom.byteLength; at += 2) {
        const word = view.getUint16(at, true);
        const opcode = word >>> 10;
        kinds[at >> 1] = opcode === OP_JAL
            ? VesInstructionKind.CALL
            : opcode === OP_JMP && (word & 0x1f) === LINK_REGISTER
                ? VesInstructionKind.RETURN
                : opcode === OP_HALT
                    ? VesInstructionKind.HALT
                    : opcode === OP_RETI
                        ? VesInstructionKind.RETI
                        : (opcode & OP_WRITE_MASK) === OP_WRITE || opcode === OP_BITSTRING
                            ? VesInstructionKind.STORE
                            : VesInstructionKind.OTHER;
    }
    return kinds;
}

export interface VesProfileNode {
    id: number;
    parent: number; // -1 at the root
    address: number; // the callee's entry point, which names the function; -1 for the root
    selfSamples: number;
    totalSamples: number;
    children: Map<number, number>;
}

// arriving here means a restart, which abandons every open frame. Without this, a game that reboots
// (watchdog, crash, title timeout) records each life nested inside the last
const RESET_VECTOR = 0xfffffff0;

// a runaway stack means the replay lost sync, so stop growing rather than consume memory describing it
const MAX_DEPTH = 256;

// keeps a shadow stack and charges each instruction to the top frame, so `selfSamples` is time in a function
// proper and `totalSamples` includes everything it called. Feed it every instruction in order
export class VesProfileCollector {

    readonly nodes: VesProfileNode[] = [{
        id: 0, parent: -1, address: -1, selfSamples: 0, totalSamples: 0, children: new Map(),
    }];

    protected readonly stack: number[] = [0];
    // the address each frame is expected to return to, which decides a return. Over sixty frames of a real game 3,800
    // `jal` met 3,667 `jmp [r31]`, the rest returning via another register, `reti` or not at all
    protected readonly returnTo: number[] = [-1];
    protected pendingReturn = -1; // set by a call, resolved on the next instruction, see `push`
    protected overflowed = 0;
    protected instructions = 0;
    protected resets = 0;

    // the caller passes `kind` as it has the decoded table and the address already. Addresses are only compared to each
    // other, so any window the machine reports works
    push(address: number, kind: VesInstructionKind): void {
        if ((address >>> 0) === RESET_VECTOR) {
            // everything that was running is gone; the reset is charged to the root, where the next life starts
            this.stack.length = 1;
            this.returnTo.length = 1;
            this.pendingReturn = -1;
            this.resets++;
        }

        // a call's target is only known once the next instruction arrives
        if (this.pendingReturn >= 0) {
            this.enter(address, this.pendingReturn);
            this.pendingReturn = -1;
        } else {
            this.unwindTo(address);
        }

        this.instructions++;
        this.nodes[this.stack[this.stack.length - 1]].selfSamples++;

        if (kind === VesInstructionKind.CALL) {
            // JAL is two halfwords, so this is the instruction after it
            this.pendingReturn = (address + 4) >>> 0;
        }
    }

    // can be several, as a tail call or a non-local exit skips levels; scanned from the top for the innermost
    protected unwindTo(address: number): void {
        for (let depth = this.stack.length - 1; depth > 0; depth--) {
            if (this.returnTo[depth] === address) {
                this.stack.length = depth;
                this.returnTo.length = depth;
                return;
            }
        }
    }

    protected enter(address: number, returnTo: number): void {
        if (this.stack.length >= MAX_DEPTH) {
            this.overflowed++;
            return;
        }
        const parent = this.stack[this.stack.length - 1];
        let child = this.nodes[parent].children.get(address);
        if (child === undefined) {
            child = this.nodes.length;
            this.nodes.push({
                id: child, parent, address, selfSamples: 0, totalSamples: 0, children: new Map(),
            });
            this.nodes[parent].children.set(address, child);
        }
        this.stack.push(child);
        this.returnTo.push(returnTo);
    }

    // calls dropped for exceeding MAX_DEPTH, which nothing normal should
    get overflows(): number {
        return this.overflowed;
    }

    get sampleCount(): number {
        return this.instructions;
    }

    get resetCount(): number {
        return this.resets;
    }

    // rolls self time up into total time in one backwards pass, as children always come after their parent
    finish(): VesProfileNode[] {
        for (const node of this.nodes) {
            node.totalSamples = node.selfSamples;
        }
        for (let at = this.nodes.length - 1; at > 0; at--) {
            const node = this.nodes[at];
            this.nodes[node.parent].totalSamples += node.totalSamples;
        }
        return this.nodes;
    }
}

// Firefox Profiler

export interface VesProfileSymbol {
    name: string;
    file?: string;
    line?: number;
}

// the processed profile shape Firefox Profiler reads. Loose, as the parallel arrays shift between versions;
// the tests check the invariants (indices in range, table lengths)
export interface VesFirefoxProfile {
    meta: Record<string, unknown>;
    libs: unknown[];
    threads: Record<string, unknown>[];
}

const PREPROCESSED_PROFILE_VERSION = 48;
const PROFILE_VERSION = 27;

// samples are instructions, not time: one per instruction executed, exact rather than statistical. `symbolize` names an
// address (the Phase 5 line table); `product` is the game, shown as the title so captures can be told apart
export function toFirefoxProfile(
    nodes: VesProfileNode[],
    symbolize: (address: number) => VesProfileSymbol,
    product: string
): VesFirefoxProfile {
    const strings: string[] = [];
    const stringIndex = new Map<string, number>();
    const intern = (text: string): number => {
        let index = stringIndex.get(text);
        if (index === undefined) {
            index = strings.length;
            strings.push(text);
            stringIndex.set(text, index);
        }
        return index;
    };

    const funcName: number[] = [];
    const funcFile: (number | null)[] = [];
    const funcLine: (number | null)[] = [];
    const funcByAddress = new Map<number, number>();
    const funcFor = (address: number): number => {
        let index = funcByAddress.get(address);
        if (index === undefined) {
            const symbol = address < 0
                ? { name: '(root)' }
                : symbolize(address);
            index = funcName.length;
            funcName.push(intern(symbol.name));
            funcFile.push(symbol.file === undefined ? null : intern(symbol.file));
            funcLine.push(symbol.line ?? null);
            funcByAddress.set(address, index);
        }
        return index;
    };

    // one frame and one stack node per tree node, as the tree already has the stack table's structure
    const frameFunc: number[] = [];
    const frameAddress: number[] = [];
    const frameLine: (number | null)[] = [];
    const stackFrame: number[] = [];
    const stackPrefix: (number | null)[] = [];

    for (const node of nodes) {
        const func = funcFor(node.address);
        frameFunc.push(func);
        frameAddress.push(node.address < 0 ? -1 : node.address);
        frameLine.push(funcLine[func]);
        stackFrame.push(node.id);
        stackPrefix.push(node.parent < 0 ? null : node.parent);
    }

    /**
     * One sample per node, weighted with its self time, instead of one per instruction (hundreds of millions for a
     * minute of play). The time column is the running total of the weights, so the axis is instructions executed: one
     * shared timestamp would leave the timeline empty, and this way the widths are each frame's true share. It is not a
     * chronology; samples come in tree order.
     */
    const sampleStack: number[] = [];
    const sampleTime: number[] = [];
    const sampleWeight: number[] = [];
    let elapsed = 0;
    for (const node of nodes) {
        if (node.selfSamples === 0) {
            continue;
        }
        sampleStack.push(node.id);
        sampleTime.push(elapsed);
        sampleWeight.push(node.selfSamples);
        elapsed += node.selfSamples;
    }

    const category = new Array(nodes.length).fill(0);
    return {
        meta: {
            interval: 1,
            startTime: 0,
            processType: 0,
            product,
            stackwalk: 1,
            version: PROFILE_VERSION,
            preprocessedProfileVersion: PREPROCESSED_PROFILE_VERSION,
            symbolicated: true,
            markerSchema: [],
            // no `sampleUnits`: it describes a `threadCPUDelta` column, and a null unit makes the importer throw from
            // `computeReferenceCPUDeltaPerMs`. These samples carry no CPU deltas
            categories: [
                { name: 'Other', color: 'gray', subcategories: ['Other'] },
            ],
        },
        libs: [],
        threads: [{
            processType: 'default',
            processStartupTime: 0,
            processShutdownTime: null,
            registerTime: 0,
            unregisterTime: null,
            pausedRanges: [],
            name: 'Virtual Boy',
            isMainThread: true,
            pid: '1',
            tid: 1,
            samples: {
                stack: sampleStack,
                time: sampleTime,
                weight: sampleWeight,
                weightType: 'samples',
                length: sampleStack.length,
            },
            markers: { data: [], name: [], startTime: [], endTime: [], phase: [], category: [], length: 0 },
            stackTable: {
                frame: stackFrame,
                prefix: stackPrefix,
                category,
                subcategory: new Array(nodes.length).fill(0),
                length: nodes.length,
            },
            frameTable: {
                address: frameAddress,
                inlineDepth: new Array(nodes.length).fill(0),
                category,
                subcategory: new Array(nodes.length).fill(0),
                func: frameFunc,
                nativeSymbol: new Array(nodes.length).fill(null),
                innerWindowID: new Array(nodes.length).fill(null),
                implementation: new Array(nodes.length).fill(null),
                line: frameLine,
                column: new Array(nodes.length).fill(null),
                length: nodes.length,
            },
            funcTable: {
                isJS: new Array(funcName.length).fill(false),
                relevantForJS: new Array(funcName.length).fill(false),
                name: funcName,
                resource: new Array(funcName.length).fill(-1),
                fileName: funcFile,
                lineNumber: funcLine,
                columnNumber: new Array(funcName.length).fill(null),
                length: funcName.length,
            },
            resourceTable: { lib: [], name: [], host: [], type: [], length: 0 },
            nativeSymbols: { address: [], functionSize: [], libIndex: [], name: [], length: 0 },
            stringArray: strings,
        }],
    };
}
