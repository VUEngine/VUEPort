// how the debugger's previews color a placement on a VB Color: palette from the Color Attribute and VIP palette
// bits, CHRSEL handing it to the Character, a Pixel Color Slot overriding per pixel. Fake memory, no core needed
import { VcuColors, vcuPlacement, vipShade } from '../lib/browser/panels/emulator-vcu-colors.js';

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        failures++;
    }
};

const memory = new Map();
const poke = (address, value) => memory.set(address, value);
const sim = {
    readMemory: async (address, length) => {
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            bytes[i] = memory.get(address + i) ?? 0;
        }
        return bytes.buffer;
    },
};
const CRAM = 0x03079000;
const color = (palette, shade, r, g, b) => {
    const at = CRAM + ((palette << 2) | shade) * 4;
    poke(at, r);
    poke(at + 1, g);
    poke(at + 2, b);
};
color(14, 3, 10, 20, 30);
color(9, 3, 1, 2, 3);
color(13, 3, 7, 7, 7);

const CELL_COLOR = 0x03060000 + 4096; // segment 1
const CELL_PIXEL = 0x03080000 + 4096 * 2;
poke(CELL_COLOR + 5, 3);
poke(CELL_COLOR + 6, 0x80);
poke(0x030a2000 + 100 * 2, 2); // Character 100's Cell group
poke(CELL_COLOR + 7, 3);
poke(CELL_PIXEL + 7 * 2, 2); // slot 2...
poke(CELL_PIXEL + 7 * 2 + 1, 0xc0); // ...with PCE and OPQ
const SLOT = 0x030b0000 + 2 * 64;
poke(SLOT + 0, 9);
poke(SLOT + 1, 0xff);
poke(SLOT + 2, 0);

const vbc = { pcen: true, ccen: true, wcen: false, chrext: false };
const colors = await VcuColors.read(sim, vbc, { segments: [1] });
const out = new Uint8ClampedArray(4);
const placement = vcuPlacement();

console.log('\nPlacement palettes');
colors.cell(1, 5, 0, 2, placement);
check('group above the VIP palette bits', placement.palette === 14);
check('CRAM entry of palette and shade', colors.put(out, 0, placement, 1, 0, 0, 3) && out[0] === 10 && out[2] === 30);
check('value 0 is left out without a slot', !colors.put(out, 0, placement, 0, 0, 0, 3));
colors.cell(1, 6, 100, 1, placement);
check('CHRSEL with CCEN takes the Character\'s group', placement.palette === 9);
const withoutCcen = await VcuColors.read(sim, { ...vbc, ccen: false }, { segments: [1] });
withoutCcen.cell(1, 6, 100, 1, placement);
check('CHRSEL without CCEN keeps the cell\'s', placement.palette === 1);

console.log('\nPixel Color Slots');
colors.cell(1, 7, 0, 1, placement);
check('PCE with PCEN attaches the slot', placement.slot !== undefined && placement.opaque);
check('a slot byte names the palette', colors.put(out, 0, placement, 1, 0, 0, 3) && out[0] === 1);
check('0xFF leaves the pixel out', !colors.put(out, 0, placement, 2, 1, 0, 3));
check('0 keeps the placement\'s palette', colors.put(out, 0, placement, 2, 2, 0, 3) && out[0] === 7);
check('OPQ draws value 0', colors.put(out, 0, placement, 0, 2, 0, 3));
const withoutPcen = await VcuColors.read(sim, { ...vbc, pcen: false }, { segments: [1] });
withoutPcen.cell(1, 7, 0, 1, placement);
check('no slot without PCEN', placement.slot === undefined);

console.log('\nChanges');
check('two reads of the same memory are the same', colors.same(await VcuColors.read(sim, vbc, { segments: [1] })));
poke(CRAM, 1);
check('a CRAM write is a change', !colors.same(await VcuColors.read(sim, vbc, { segments: [1] })));

console.log('\nShades');
check('a value picks its two bits of the register', vipShade(0xe4, 3) === 3 && vipShade(0xe4, 1) === 1);
check('value 0 reads the low two bits', vipShade(0x1b, 0) === 3);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
