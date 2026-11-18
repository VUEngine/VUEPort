import { DisassemblyLine } from '../common/vb-protocol';

// typed view of the Shrooms-VB core's WebAssembly exports: the vb* functions are the core's public C API, the
// capitalized ones the web build's helpers (allocation, anaglyph mixer, multi-simulation emulation). The module
// has exactly one import, emscripten_notify_memory_growth
export interface WasmExports {
    memory: WebAssembly.Memory;
    __indirect_function_table: WebAssembly.Table; // indirect call targets; callback "pointers" are indices into this

    _initialize(): void; // reactor-style entry point, must be called before anything else

    // allocation

    // malloc/realloc/free in one: a size of 0 frees, a pointer of 0 allocates
    Realloc(pointer: number, size: number): number;
    PointerSize(): number; // width of a pointer in bytes, for indexing pointer arrays
    vbSizeOf(): number;

    // simulation lifecycle

    CreateSim(): number;
    vbReset(sim: number): void;
    SetHardwareMode?(sim: number, vbc: number): void; // optional for old binaries
    GetHardwareMode?(sim: number): number;

    // cartridge

    vbGetCartROM(sim: number): number;
    // returns 0 on success; size must be a power of two
    vbSetCartROM(sim: number, pointer: number, size: number): number;
    vbGetCartRAM(sim: number): number;
    // returns 0 on success; size must be a power of two
    vbSetCartRAM(sim: number, pointer: number, size: number): number;

    // emulation

    // emulate an array of simulations. clocks points at a uint32 of clocks left to run, decremented in place;
    // returns early on a break condition, so callers loop until it reaches 0
    Emulate(sims: number, count: number, clocks: number): void;
    GetBreaks(sim: number): number; // break conditions raised since the last call, see VbBreak

    // video

    GetPixels(sim: number): void;
    GetExtPixels(sim: number): number; // pointer to the legacy eye-packed framebuffer (384 * 224 * 4 bytes)
    // VBC-capable builds: one RGBA8 image twice the screen's width (768 x 224 x 4 bytes), left eye in the left
    // half, right eye in the right, each pixel R, G, B, 0xFF
    GetColorPixels?(sim: number): void;
    GetExtColorPixels?(sim: number): number;
    GetVideoFormat?(sim: number): number; // 0 = legacy eye-packed brightness, 1 = VBC RGB888
    // the frame buffer the display shows (0 or 1); drawing goes to the other. Optional for old binaries, as are
    // the pixel origins (what drew each frame buffer pixel, see vb-origin.ts): kept in caller-provided memory, one
    // simulation at a time, 0 to stop
    vbGetDisplayedBuffer?(sim: number): number;
    vbSetPixelOrigins?(sim: number, origins: number): void;
    vbSizeOfPixelOrigins?(): number;
    // the Column Length each group of 4 columns of the last frame was shown with, 96 bytes per eye; cores before
    // the measured display timing lack it, and their frames pass through as they are
    vbGetColumnLengths?(sim: number, left: number, right: number): void;
    // the machine's counters, see VbCounter; cores before them lack both
    vbGetCounter?(sim: number, id: number): number;
    vbResetCounters?(sim: number): void;
    SetAnaglyph(sim: number, left: number, right: number): void;

    // audio

    GetExtSamples(sim: number): number;
    // point a simulation at a sample buffer and reset its write position
    vbSetSamples(sim: number, pointer: number, type: number, count: number): void;
    // mix every simulation's samples into one interleaved stereo buffer
    Mix(destination: number, sims: number, count: number): void;
    SetVolume(sim: number, volume: number): void;
    SetPanning(sim: number, panning: number): void;

    // input

    vbSetKeys(sim: number, keys: number): void;
    vbGetKeys(sim: number): number;

    // linking (phase 3)

    vbGetPeer(sim: number): number;
    vbSetPeer(sim: number, peer: number): void;

    // memory and debug access (phase 4)

    vbRead(sim: number, address: number, type: number): number;
    vbWrite(sim: number, address: number, type: number, value: number): void;
    vbGetProgramCounter(sim: number): number;
    vbSetProgramCounter(sim: number, address: number): void;
    vbGetProgramRegister(sim: number, index: number): number;
    vbSetProgramRegister(sim: number, index: number, value: number): void;
    vbGetSystemRegister(sim: number, index: number): number;
    vbSetSystemRegister(sim: number, index: number, value: number): void;
    vbGetOption(sim: number, key: number): number;
    vbSetOption(sim: number, key: number, value: number): void;

    // invoked on every CPU write, or 0 to remove it. The argument is an index into __indirect_function_table,
    // not an address; see VB_WRITE_CALLBACK_ARITY for the signature
    vbSetWriteCallback(sim: number, callback: number): void;
    vbGetWriteCallback(sim: number): number;

    // invoked after every CPU read (five arguments, VB_READ_CALLBACK_ARITY), so the value is there to look at.
    // Instruction fetches go through the core's own fetch callback, which makes this affordable to leave
    // installed. Measured: see tests/read-callback-probe.mjs
    vbSetReadCallback(sim: number, callback: number): void;
    vbGetReadCallback(sim: number): number;

    // invoked before every instruction (four arguments, VB_EXECUTE_CALLBACK_ARITY; the second is the PC).
    // Returning non-zero halts Emulate before the instruction runs, leaving the PC on it; GetBreaks does not
    // report that stop, the return value is the only signal
    vbSetExecuteCallback(sim: number, callback: number): void;
    vbGetExecuteCallback(sim: number): number;

    // invoked as the CPU takes an exception (interrupt, TRAP, fault): the simulation and a pointer to the 16-bit
    // cause code, which the callback may rewrite. Non-zero halts Emulate before it is processed
    vbSetExceptionCallback(sim: number, callback: number): void;

    // disassembler

    // disassemble count instructions from an address into a block (0 on a memory error) the caller frees with
    // Realloc. Leaves every string slot null, which is what Disassemble is for; kept as the upstream wrapper's call
    vbuDisassemble(sim: number, address: number, unused: number, count: number, line: number): number;
    // the same, with the sixteen options that decide how the text (mnemonics, operands, address) is written; the
    // only call that produces text. See DISASSEMBLY_STYLE in the worker
    Disassemble(
        bcondNotation: number, conditionCase: number, conditionCL: number,
        conditionEZ: number, conditionNotation: number, hexCase: number,
        hexNotation: number, immediateNotation: number, memoryNotation: number,
        mnemonicCase: number, operandOrder: number, programCase: number,
        programNotation: number, setfNotation: number, systemCase: number,
        systemNotation: number,
        sim: number, address: number, count: number, line: number,
    ): number;
    vbuCodeSize(sim: number, address: number): number;
    // fills destination with 17 words per line: address, code length, up to four code bytes, a PC flag, then offsets of
    // pointer slots in the block (address text, four per-byte texts, mnemonic, operand count, three operands). Those
    // are offsets to pointers, not to text, so they need one more dereference
    GetDasm(destination: number, dasm: number, count: number): void;
}

// the core ships with five table slots, all spoken for, so every callback needs one of the spares
export const VB_TABLE_SLOTS = 16;

// raises the declared limits of the core's function table, which was built without growth and is pinned at five
// entries. Both limits are single LEB128 bytes and element segments use fixed offsets, so this is an in-place byte
// patch; verified by tests/write-callback-probe.mjs
export function patchTableLimit(bytes: Uint8Array, slots = VB_TABLE_SLOTS): Uint8Array {
    const readUleb = (at: number): [number, number] => {
        let result = 0;
        let shift = 0;
        let length = 0;
        let byte = 0;
        do {
            byte = bytes[at + length];
            result |= (byte & 0x7f) << shift;
            shift += 7;
            length++;
        } while (byte & 0x80);
        return [result, length];
    };

    let position = 8;   // past the magic and version
    while (position < bytes.length) {
        const id = bytes[position];
        const [size, sizeLength] = readUleb(position + 1);
        const start = position + 1 + sizeLength;

        if (id === 4) {   // table section
            let at = start;
            const [count, countLength] = readUleb(at);
            at += countLength;
            if (count !== 1) {
                throw new Error(`Emulator core declares ${count} tables, expected exactly one.`);
            }
            at++;   // reftype
            const hasMaximum = bytes[at] === 1;
            at++;
            const [, minimumLength] = readUleb(at);
            if (slots > 0x7f || minimumLength !== 1) {
                throw new Error('Emulator core table limits cannot be widened in place.');
            }
            bytes[at] = slots;
            if (hasMaximum) {
                bytes[at + 1] = slots;
            }
            return bytes;
        }
        position = start + size;
    }
    throw new Error('Emulator core has no table section.');
}

// there is no single signature, and a trampoline of the wrong shape only fails when the core first calls it,
// with "null function or function signature mismatch". Measured: see tests/emulator/breakpoint-probe.mjs
export const VB_WRITE_CALLBACK_ARITY = 6;
export const VB_READ_CALLBACK_ARITY = 5;
export const VB_EXECUTE_CALLBACK_ARITY = 4;
export const VB_EXCEPTION_CALLBACK_ARITY = 2;

// for writes: simulation pointer, address, data type, pointer to the value being written, and two
// out-parameters the core leaves at zero. Returning 0 lets the access proceed normally
export type VbCallback = (
    sim: number,
    address: number,
    type: number,
    valuePointer: number,
    outA: number,
    outB: number
) => number;

function uleb(value: number): number[] {
    const out: number[] = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) {
            byte |= 0x80;
        }
        out.push(byte);
    } while (value !== 0);
    return out;
}

/**
 * Builds a wasm function of the core's callback signature that forwards to a JS function. The core is pure wasm
 * without Emscripten glue, and WebAssembly.Function is not available in the target browsers, so a one-function module
 * importing the JS callback and exporting it under the right type bridges the gap. The arity is required on purpose:
 * a default written as VB_WRITE_CALLBACK_ARITY compiled to exports.VB_WRITE_CALLBACK_ARITY, captured by the parameter
 * named `exports`, and gave a zero-argument trampoline.
 */
function makeCallbackTrampoline(callback: VbCallback, arity: number): Function {
    if (!Number.isInteger(arity) || arity < 1) {
        throw new Error(`A callback trampoline needs a real argument count, not ${arity}.`);
    }
    const I32 = 0x7f;
    const section = (id: number, payload: number[]): number[] => [id, ...uleb(payload.length), ...payload];
    const vector = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];

    const type = [
        0x60,
        ...vector(Array.from({ length: arity }, () => [I32])),
        ...vector([[I32]]),
    ];

    const body: number[] = [];
    for (let index = 0; index < arity; index++) {
        body.push(0x20, ...uleb(index));   // local.get
    }
    body.push(0x10, 0x00);                 // call the import
    body.push(0x0b);                       // end

    const bytes = Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        ...section(1, vector([type])),
        // import "e"."f", the JS callback
        ...section(2, vector([[0x01, 0x65, 0x01, 0x66, 0x00, 0x00]])),
        ...section(3, vector([[0x00]])),
        // export "t", the wasm function that forwards to it
        ...section(7, vector([[0x01, 0x74, 0x00, 0x01]])),
        ...section(10, vector([[...uleb(body.length + 1), 0x00, ...body]])),
    ]);

    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { f: callback } });
    return instance.exports.t as Function;
}

// returns the table index the core's vbSet*Callback functions take as a pointer; index 0 is the null
// function pointer ("no callback"), so it is never handed out
export function installVbCallback(
    exports: WasmExports,
    callback: VbCallback,
    arity: number
): number {
    const table = exports.__indirect_function_table;
    for (let index = 1; index < table.length; index++) {
        if (table.get(index) === null) {
            table.set(index, makeCallbackTrampoline(callback, arity));
            return index;
        }
    }
    throw new Error('Emulator core has no free callback slot.');
}

export function releaseVbCallback(exports: WasmExports, index: number): void {
    if (index > 0 && index < exports.__indirect_function_table.length) {
        exports.__indirect_function_table.set(index, null);
    }
}

// always fetched to an ArrayBuffer rather than streamed, as the function table has to be widened before
// compilation for any callback to be installable
export async function instantiateWasm(wasmUrl: string): Promise<WasmExports> {
    const response = await fetch(wasmUrl);
    if (!response.ok) {
        throw new Error(`Could not load emulator core from ${wasmUrl}: ${response.status} ${response.statusText}`);
    }
    return instantiateWasmBytes(new Uint8Array(await response.arrayBuffer()));
}

// for a host without fetch for local files (Node, where vueport-probe runs). The bytes are patched in place,
// so pass a copy to keep the original
export async function instantiateWasmBytes(bytes: Uint8Array): Promise<WasmExports> {
    const imports: WebAssembly.Imports = {
        env: {
            // the core grows its own memory; every typed array view is created on demand, so nothing to invalidate
            emscripten_notify_memory_growth: () => { /* no-op */ },
        },
    };

    patchTableLimit(bytes);
    // a view on a shared buffer is not a BufferSource to the typings, though compiling one is fine
    const { instance } = await WebAssembly.instantiate(bytes as Uint8Array<ArrayBuffer>, imports);

    const exports = instance.exports as unknown as WasmExports;
    exports._initialize();

    if (exports.PointerSize() !== 4) {
        throw new Error('Emulator core was built with a pointer size other than 32 bits.');
    }

    return exports;
}

// the sixteen options Disassemble takes, in order, from the core's Constants.js: lower-case mnemonics and
// registers, upper-case hex behind 0x, destination last as the assembler writes it, -8[fp] rather than [fp-8],
// and conditions and system registers by name
const DISASSEMBLY_STYLE = [
    0,  // bcondNotation: JOINED, so `be` rather than `b e`
    1,  // conditionCase: LOWER
    0,  // conditionCL: L, the unsigned spelling — `bl` rather than `bc`
    0,  // conditionEZ: E — `be` rather than `bz`
    1,  // conditionNotation: NAMES
    0,  // hexCase: UPPER, for digits that line up with the address column
    0,  // hexNotation: 0X
    0,  // immediateNotation: NONE, so an immediate is just a number
    0,  // memoryNotation: OUTSIDE — `-8[fp]`
    1,  // mnemonicCase: LOWER
    0,  // operandOrder: DEST_LAST
    1,  // programCase: LOWER
    1,  // programNotation: NAMES, so r2 reads as `fp`
    1,  // setfNotation: NAMES
    1,  // systemCase: LOWER
    1,  // systemNotation: NAMES
] as const;

// shared by the worker and vueport-probe, so both get the same text for the same bytes. before: how many of
// the count lines to take from ahead of address
export function disassemble(
    wasm: WasmExports, sim: number, address: number, count: number, before = 0,
): DisassemblyLine[] {
    if (count === 0) {
        return [];
    }
    const dasm = wasm.Disassemble(
        ...DISASSEMBLY_STYLE, sim, address >>> 0, count, before,
    );
    if (dasm === 0) {
        throw new Error(
            `Cannot disassemble at 0x${(address >>> 0).toString(16)}.`,
        );
    }

    const table = wasm.Realloc(0, count * 17 * 4);
    wasm.GetDasm(table, dasm, count);

    const lines: DisassemblyLine[] = [];
    try {
        const u32 = (pointer: number, length: number) =>
            new Uint32Array(wasm.memory.buffer, pointer, length);
        const words = u32(table, count * 17);
        // the text words are offsets to pointer slots inside the block, so each is read through, not from
        const text = (offset: number): string => {
            const pointer = u32(dasm + offset, 1)[0];
            return pointer === 0 ? '' : readCString(wasm, pointer);
        };

        let at = 0;
        for (let line = 0; line < count; line++) {
            const lineAddress = words[at++];
            const codeLength = words[at++];
            const code: number[] = [];
            for (let i = 0; i < codeLength; i++) {
                code.push(words[at++]);
            }
            at += 4 - codeLength;

            const isPC = words[at++] !== 0;
            at++; // the address as text, which we format ourselves
            at += 4; // per-byte text, likewise
            const mnemonic = text(words[at++]);
            const operandCount = words[at++];
            const operands: string[] = [];
            for (let i = 0; i < operandCount; i++) {
                operands.push(text(words[at++]));
            }
            at += 3 - operandCount;

            lines.push({ address: lineAddress, code, isPC, mnemonic, operands });
        }
    } finally {
        wasm.Realloc(table, 0);
        wasm.Realloc(dasm, 0);
    }

    return lines;
}

export function readCString(wasm: WasmExports, pointer: number): string {
    if (pointer === 0) {
        return '';
    }
    const bytes = new Uint8Array(wasm.memory.buffer);
    let end = pointer;
    while (bytes[end] !== 0) {
        end++;
    }
    return new TextDecoder().decode(bytes.subarray(pointer, end));
}
