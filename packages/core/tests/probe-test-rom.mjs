// small ROMs whose every instruction is known, for the probe-*.mjs tests. The main one writes 'A' to the debug port
// once, then counts in r11, storing it at 0x05000010 and reading it back. Its display stays off, so every frame is the
// machine's own twentieth of a second

import { readFileSync } from 'fs';

export const ROM_SIZE = 0x10000;
export const COUNTER = 0x05000010;
const BLOCK = 0x60;
const BASE = (0x100000000 - BLOCK) >>> 0;

// addresses of the labelled instructions, in the mirror the CPU runs them from
export const at = {};

export function buildRom() {
    const rom = new Uint8Array(ROM_SIZE);
    const view = new DataView(rom.buffer);
    let cursor = ROM_SIZE - BLOCK;
    const mark = name => { at[name] = (BASE + cursor - (ROM_SIZE - BLOCK)) >>> 0; };
    const half = value => { view.setUint16(cursor, value & 0xffff, true); cursor += 2; };
    const format6 = (opcode, reg2, disp, reg1) => { half((opcode << 10) | (reg2 << 5) | reg1); half(disp); };

    mark('start');
    format6(0x2f, 10, 0x0500, 0);           // movhi 0x0500, r0, r10
    format6(0x2f, 13, 0x0200, 0);           // movhi 0x0200, r0, r13
    format6(0x28, 14, 0x41, 0);             // movea 0x41, r0, r14
    mark('terminal');
    format6(0x34, 14, 0x30, 13);            // st.b r14, 0x30[r13]
    half((0x00 << 10) | (11 << 5) | 0);     // mov r0, r11
    mark('loop');
    half((0x11 << 10) | (11 << 5) | 1);     // add 1, r11
    mark('store');
    format6(0x37, 11, 0x10, 10);            // st.w r11, 0x10[r10]
    mark('load');
    format6(0x33, 12, 0x10, 10);            // ld.w 0x10[r10], r12
    mark('branch');
    half(0x8a00 | ((at.loop - at.branch) & 0x1ff));   // br loop

    cursor = ROM_SIZE - 0x10;
    const toStart = (at.start - (BASE + BLOCK - 0x10)) | 0;
    half((0x2a << 10) | ((toStart >> 16) & 0x3ff));  // jr start
    half(toStart & 0xffff);
    return rom;
}

// calls, a nested call and a TRAP, for following the call stack: func calls leaf, saving lp in r20 around it, and the
// TRAP 0 handler (vector 0xFFFFFFA0) stores and returns with reti
export const calls = {};

export function buildCallsRom() {
    const rom = new Uint8Array(ROM_SIZE);
    const view = new DataView(rom.buffer);
    const top = (0x100000000 - ROM_SIZE) >>> 0;
    let cursor = ROM_SIZE - 0x1000;
    const mark = name => { calls[name] = (top + cursor) >>> 0; };
    const half = value => { view.setUint16(cursor, value & 0xffff, true); cursor += 2; };
    const format6 = (opcode, reg2, disp, reg1) => { half((opcode << 10) | (reg2 << 5) | reg1); half(disp); };
    const jump = (opcode, target) => {
        const displacement = (target - (top + cursor)) | 0;
        half((opcode << 10) | ((displacement >> 16) & 0x3ff));
        half(displacement & 0xffff);
    };
    const pending = [];
    const later = (opcode, label) => { pending.push({ at: cursor, opcode, label }); cursor += 4; };

    mark('start');
    half((0x1c << 10) | (0 << 5) | 5);      // ldsr r0, psw
    format6(0x2f, 10, 0x0500, 0);           // movhi 0x0500, r0, r10
    half((0x00 << 10) | (11 << 5) | 0);     // mov r0, r11
    mark('loop');
    later(0x2b, 'func');                    // jal func
    mark('trap');
    half(0x18 << 10);                       // trap 0
    mark('branch');
    half(0x8a00 | ((calls.loop - calls.branch) & 0x1ff));   // br loop
    mark('func');
    half((0x11 << 10) | (11 << 5) | 1);     // add 1, r11
    mark('fstore');
    format6(0x37, 11, 0x10, 10);            // st.w r11, 0x10[r10]
    half((0x00 << 10) | (20 << 5) | 31);    // mov lp, r20
    mark('fcall');
    later(0x2b, 'leaf');                    // jal leaf
    half((0x00 << 10) | (31 << 5) | 20);    // mov r20, lp
    half((0x06 << 10) | 31);                // jmp [lp]
    mark('leaf');
    mark('lstore');
    format6(0x37, 11, 0x14, 10);            // st.w r11, 0x14[r10]
    half((0x06 << 10) | 31);                // jmp [lp]
    mark('handler');
    mark('hstore');
    format6(0x37, 11, 0x18, 10);            // st.w r11, 0x18[r10]
    half(0x19 << 10);                       // reti

    const end = cursor;
    for (const { at: site, opcode, label } of pending) {
        cursor = site;
        jump(opcode, calls[label]);
    }
    cursor = ROM_SIZE - 0x60;               // TRAP 0-15 vector, 0xFFFFFFA0
    jump(0x2a, calls.handler);
    cursor = ROM_SIZE - 0x10;               // reset vector
    jump(0x2a, calls.start);
    cursor = end;
    return rom;
}

// where the ESSound program's interrupt handler leaves its mark
export const ES_SOUND_MARK = 0x05000020;

// a game that tells its ESSound cartridge to start (0xFFFF to 0x04000000) and spins; the Game Pak interrupt handler
// (level 2, 0xFFFFFE20) leaves its mark at ES_SOUND_MARK
export function buildEsSoundRom() {
    const rom = new Uint8Array(ROM_SIZE);
    const view = new DataView(rom.buffer);
    const top = (0x100000000 - ROM_SIZE) >>> 0;
    let cursor = ROM_SIZE - 0x1000;
    const half = value => { view.setUint16(cursor, value & 0xffff, true); cursor += 2; };
    const format6 = (opcode, reg2, disp, reg1) => { half((opcode << 10) | (reg2 << 5) | reg1); half(disp); };
    const jr = target => {
        const displacement = (target - (top + cursor)) | 0;
        half((0x2a << 10) | ((displacement >> 16) & 0x3ff));
        half(displacement & 0xffff);
    };

    const start = top + cursor;
    half((0x1c << 10) | (0 << 5) | 5);      // ldsr r0, psw
    format6(0x2f, 10, 0x0400, 0);           // movhi 0x0400, r0, r10
    format6(0x2f, 12, 0x0500, 0);           // movhi 0x0500, r0, r12
    format6(0x28, 11, 0xffff, 0);           // movea 0xFFFF, r0, r11
    format6(0x35, 11, 0x0000, 10);          // st.h r11, 0[r10]
    half(0x8a00);                           // br spin (to itself)
    const handler = top + cursor;
    format6(0x28, 13, 1, 0);                // movea 1, r0, r13
    format6(0x37, 13, 0x20, 12);            // st.w r13, 0x20[r12]
    half(0x19 << 10);                       // reti

    cursor = ROM_SIZE - 0x200 + 0x20;       // level 2 vector, 0xFFFFFE20
    jr(handler);
    cursor = ROM_SIZE - 0x10;               // reset vector
    jr(start);
    return rom;
}

// a small program at the top of a ROM: build(asm) gets the encoders and returns the start address
function program(build) {
    const rom = new Uint8Array(ROM_SIZE);
    const view = new DataView(rom.buffer);
    const top = (0x100000000 - ROM_SIZE) >>> 0;
    let cursor = ROM_SIZE - 0x1000;
    const asm = {
        here: () => (top + cursor) >>> 0,
        half: value => { view.setUint16(cursor, value & 0xffff, true); cursor += 2; },
        format6: (opcode, reg2, disp, reg1) => { asm.half((opcode << 10) | (reg2 << 5) | reg1); asm.half(disp); },
        at: address => { cursor = (address - top) >>> 0; },
        jr: target => {
            const displacement = (target - (top + cursor)) | 0;
            asm.half((0x2a << 10) | ((displacement >> 16) & 0x3ff));
            asm.half(displacement & 0xffff);
        },
    };
    const start = build(asm);
    asm.at(0xfffffff0);
    asm.jr(start);
    return rom;
}

export const fault = {};

// divides by zero; the handler at the zero-division vector (0xFFFFFF80) skips the division (eipc += 2) and returns
export function buildFaultRom() {
    return program(asm => {
        const start = asm.here();
        asm.half((0x1c << 10) | (0 << 5) | 5);     // ldsr r0, psw
        asm.format6(0x28, 10, 5, 0);               // movea 5, r0, r10
        fault.div = asm.here();
        asm.half((0x09 << 10) | (10 << 5) | 0);    // div r0, r10
        fault.spin = asm.here();
        asm.half(0x8a00);                          // br spin
        const handler = asm.here();
        asm.half((0x1d << 10) | (11 << 5) | 0);    // stsr eipc, r11
        asm.half((0x11 << 10) | (11 << 5) | 2);    // add 2, r11
        asm.half((0x1c << 10) | (11 << 5) | 0);    // ldsr r11, eipc
        asm.half(0x19 << 10);                      // reti
        asm.at(0xffffff80);
        asm.jr(handler);
        return start;
    });
}

// display and drawing switched on (DPCTRL DISP, RE, SYNCE and XPCTRL XPEN) and nothing else, so the VIP's frames go by
// while the CPU spins
export function buildDisplayRom() {
    return program(asm => {
        const start = asm.here();
        asm.format6(0x2f, 10, 0x0006, 0);          // movhi 0x0006, r0, r10
        asm.format6(0x28, 10, 0xf800, 10);         // movea -0x800, r10, r10
        asm.format6(0x28, 11, 0x0302, 0);          // movea 0x0302, r0, r11
        asm.format6(0x35, 11, 0x22, 10);           // st.h r11, 0x22[r10]
        asm.format6(0x28, 11, 0x0002, 0);          // movea 0x0002, r0, r11
        asm.format6(0x35, 11, 0x42, 10);           // st.h r11, 0x42[r10]
        asm.half(0x8a00);                          // br spin
        return start;
    });
}

export function readCoreWasm() {
    return readFileSync(new URL('../wasm/shrooms/core.wasm', import.meta.url));
}

let failures = 0;

export function check(label, actual, expected) {
    const ok = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected);
    if (!ok) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}${typeof expected === 'function' ? '' : `, expected ${JSON.stringify(expected)}`}`);
    } else {
        console.log(`  ok   ${label}`);
    }
    return ok;
}

export function finish() {
    if (failures > 0) {
        console.log(`\n${failures} check(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll checks passed.');
}
