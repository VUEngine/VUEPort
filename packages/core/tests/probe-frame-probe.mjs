/**
 * Frame buffers as data, what drew each pixel, and watches that change the machine as it runs. A scene is written
 * straight into VRAM (a character with one odd pixel, in a BGMap world, flipped, as an object, through an affine world
 * and as an overplane) and the VIP draws it while the CPU spins. Each placement has to come back from the pixel origins
 * as what drew it, with the odd pixel found where it was put.
 * Usage: node tests/probe-frame-probe.mjs
 */
import { createRequire } from 'module';
import { at, buildDisplayRom, buildRom, check, COUNTER, finish, readCoreWasm } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { VbMachine, readFrameBuffer, frameBufferPlace, decodeOrigin, assemble } = require('../lib/probe/index.js');

const core = readCoreWasm();
const open = rom => VbMachine.create({ core, rom, sramWindow: 0x4000, hardware: 'vb' });

// character 5 is all value 1 except pixel 3,2, which is 2
function buildScene(vb) {
    const halfwords = (address, values) => values.forEach((value, index) => vb.write16(address + index * 2, value & 0xffff));
    vb.write16(0x0005f860, 0xe4);   // GPLT0: value n is shade n
    vb.write16(0x0005f86a, 0xe4);   // JPLT1
    vb.write16(0x0005f870, 2);      // BKCOL
    for (let row = 0; row < 8; row++) {
        let bits = 0;
        for (let x = 0; x < 8; x++) {
            bits |= (row === 2 && x === 3 ? 2 : 1) << (x * 2);
        }
        vb.write16(0x00006000 + 5 * 16 + row * 2, bits);
    }
    vb.write16(0x00020000 + (1 * 64 + 2) * 2, 5);            // segment 0, cell 2,1
    vb.write16(0x00020000 + (1 * 64 + 3) * 2, 0x2000 | 5);   // cell 3,1, flipped across
    vb.write16(0x00020000 + 0x2000, 5);                      // segment 1, cell 0,0
    // world 31: BGMap, segment 0, the whole screen
    halfwords(0x0003d800 + 31 * 32, [0xc000, 0, 0, 0, 0, 0, 0, 383, 223, 0, 0]);
    // world 30: objects, group 3 being object 10 alone
    halfwords(0x0003d800 + 30 * 32, [0xc000 | 3 << 12]);
    vb.write16(0x0005f84c, 9);
    vb.write16(0x0005f84e, 10);
    halfwords(0x0003e000 + 10 * 8, [100, 0xc000, 50, 1 << 14 | 5]);
    // world 29: affine, segment 1, at 200,100, 32x16, one-to-one; parameters at 0x00034000
    halfwords(0x0003d800 + 29 * 32, [0xc000 | 2 << 12 | 1, 200, 0, 100, 0, 0, 0, 31, 15, 0xa000, 0]);
    for (let row = 0; row < 16; row++) {
        halfwords(0x00034000 + row * 16, [0, 0, row << 3, 0x200, 0]);
    }
    // world 28: BGMap on empty segment 2 at 300,150, 32x8, starting 8 pixels left of its map: those are the overplane,
    // cell 66 (segment 0, cell 2,1)
    halfwords(0x0003d800 + 28 * 32, [0xc000 | 0x80 | 2, 300, 0, 150, -8, 0, 0, 31, 7, 0, 66]);
    halfwords(0x0003d800 + 27 * 32, [0x0040]);   // END
}

const originAt = (vb, x, y, buffer = vb.displayedBuffer()) => {
    const words = vb.pixelOrigins('left', buffer);
    return decodeOrigin(words[(y * 384 + x) * 2], words[(y * 384 + x) * 2 + 1]);
};

console.log('Frame buffers');
let vb = await open(buildDisplayRom());
buildScene(vb);
vb.keepOrigins();
const shownSeen = new Set();
for (let i = 0; i < 4; i++) {
    vb.runFrames(1);
    shownSeen.add(vb.displayedBuffer());
}
check('the display takes turns with the two buffers', [...shownSeen].sort().join(','), '0,1');
let shades = readFrameBuffer(vb, 'left', vb.displayedBuffer(), false);
check('the odd pixel, as its shade', shades[10 * 384 + 19], 2);
check('... beside it the rest of the character', shades[10 * 384 + 20], 1);
check('... and the backdrop', shades[0], 2);
check('the other eye has it too', readFrameBuffer(vb, 'right', vb.displayedBuffer(), false)[10 * 384 + 19], 2);
check('a byte of the right eye\'s buffer 1', JSON.stringify(frameBufferPlace(0x00018000 + 5 * 64 + 3)),
    JSON.stringify({ color: false, eye: 'right', buffer: 1, x: 5, y: 12, rows: 4 }));
check('character memory is not a frame buffer', frameBufferPlace(0x00006000), undefined);
check('a byte of the VB Color framebuffer', JSON.stringify(frameBufferPlace(0x03000000 + 3 * 0x18000 + 7 * 256 + 100)),
    JSON.stringify({ color: true, eye: 'right', buffer: 1, x: 7, y: 100, rows: 1 }));
check('... not its padding rows', frameBufferPlace(0x03000000 + 7 * 256 + 230), undefined);

console.log('\nWhat drew each pixel');
let origin = originAt(vb, 19, 10);
check('a BGMap cell', origin.kind, 'cell');
check('... in world 31', origin.world, 31);
check('... segment 0, cell 2,1', `${origin.bgmap.segment} ${origin.bgmap.x},${origin.bgmap.y}`, '0 2,1');
check('... at its address', origin.bgmap.address, 0x00020000 + 66 * 2);
check('... character 5, its pixel 3,2', `${origin.character} ${origin.pixel.x},${origin.pixel.y}`, '5 3,2');
check('... value 2, GPLT0', `${origin.value} ${origin.palette}`, '2 GPLT0');
origin = originAt(vb, 28, 10);
check('a flipped cell gives the pixel as the character stores it', `${origin.pixel.x},${origin.pixel.y} ${origin.flip.h} ${origin.flip.v}`, '3,2 true false');
origin = originAt(vb, 103, 52);
check('an object', `${origin.kind} ${origin.world} ${origin.object.index} ${origin.palette}`, 'object 30 10 JPLT1');
check('... its pixel', `${origin.pixel.x},${origin.pixel.y} ${origin.value}`, '3,2 2');
origin = originAt(vb, 203, 102);
check('an affine world', `${origin.kind} ${origin.world} ${origin.bgmap.segment} ${origin.bgmap.x},${origin.bgmap.y}`, 'cell 29 1 0,0');
check('... its pixel', `${origin.pixel.x},${origin.pixel.y}`, '3,2');
origin = originAt(vb, 303, 152);
check('the overplane', `${origin.kind} ${origin.world} ${origin.bgmap.segment} ${origin.bgmap.x},${origin.bgmap.y}`, 'overplane 28 0 2,1');
check('... its pixel', `${origin.pixel.x},${origin.pixel.y}`, '3,2');
origin = originAt(vb, 0, 0);
check('the backdrop, with its shade', `${origin.kind} ${origin.value}`, 'backdrop 2');
vb.write8(0x00000000 + (vb.displayedBuffer() << 15) + 4 * 64 + 4, 0xff);
origin = originAt(vb, 4, 17);
check('a debugger\'s write', `${origin.kind} ${origin.value}`, 'debugger 3');
const shownNow = vb.displayedBuffer();
const drawnBefore = vb.drawnCharacter(shownNow, 5);
check('the character as it was drawn', drawnBefore[4] | drawnBefore[5] << 8, 0b0101_0101_1001_0101);
vb.write16(0x00006000 + 5 * 16 + 4, 0);      // the game loads something else into it, mid-frame
check('... after the game has changed it', [...vb.drawnCharacter(shownNow, 5)].join(), [...drawnBefore].join());
check('... which character memory now holds', vb.read16(0x00006000 + 5 * 16 + 4), 0);
check('the palettes as they were drawn', JSON.stringify(vb.drawnPalettes(shownNow).slice(0, 1).concat(vb.drawnPalettes(shownNow).slice(5, 6))),
    JSON.stringify([[0, 1, 2, 3], [0, 1, 2, 3]]));
vb.write16(0x00006000 + 5 * 16 + 4, drawnBefore[4] | drawnBefore[5] << 8);
const kept = vb.snapshot();
vb.restore(kept);
check('a restored moment forgets them', originAt(vb, 19, 10).kind, 'unknown');

console.log('\nWhat chose a VB Color palette');
vb = await VbMachine.create({ core, rom: buildDisplayRom(), sramWindow: 0x4000, hardware: 'vbc' });
buildScene(vb);
vb.write16(0x0307f806, 0xc001);              // VBCCTRL: VB Color on
vb.write16(0x0307f81a, 0x0a);                // CXCTRL: world offsets (WCEN) and character colors (CCEN)
vb.write8(0x03060000 + 66, 0x10);            // cell 2,1: color attribute palette 0x40
vb.write8(0x03060000 + 67, 0x80);            // cell 3,1: colored by its character
vb.write8(0x030a2000 + 5 * 2, 0x15);         // character 5 as a cell: palette 0x54
vb.write8(0x030a0800 + 31 * 2, 4);           // world 31: palette offset 4
vb.keepOrigins();
vb.runFrames(3);
origin = originAt(vb, 19, 10);
check('a cell\'s own color attribute', `${origin.vbc} ${origin.vbcSource}`, `${0x44} attribute`);
check('... with the world\'s offset added', origin.vbcOffset, true);
origin = originAt(vb, 28, 10);
check('its character\'s color attribute', `${origin.vbc} ${origin.vbcSource}`, `${0x58} character`);
origin = originAt(vb, 0, 0);
check('the backdrop\'s CBKPAL', origin.vbcSource, 'register');

console.log('\nWhat a program writes');
vb = await open(buildDisplayRom());
buildScene(vb);
// instead of spinning: write 0x55 to left buffer 0, column 4, rows 0-3, for ever
vb.patch(0xfffff018, assemble('loop: movea 0x55, r0, r13\nst.b r13, 0x0100[r0]\nbr loop', 0xfffff018).bytes);
vb.keepOrigins();
vb.runFrames(3);
origin = originAt(vb, 4, 1, 0);
check('a CPU write', origin.kind, 'cpu');
check('... from the store', origin.pc, 0xfffff01c);
check('... with the value written', origin.value, 1);
check('the rest of the column is drawn', originAt(vb, 4, 8, 0).kind, 'backdrop');
vb.keepOrigins(false);
const before = originAt(vb, 19, 10, 0);
vb.write16(0x00020000 + (1 * 64 + 2) * 2, 0);
vb.runFrames(3);
check('stopping keeps what was kept, and no more', originAt(vb, 19, 10, 0).kind, before.kind);

console.log('\nWatches that change the machine');
vb = await open(buildRom());
let applied = 0;
const setting = vb.watch({ kind: 'exec', at: at.store, then: () => { vb.setRegister('r11', 1000); applied++; } });
vb.runFrames(1);
check('done at every hit', applied, setting.count);
check('... before the instruction runs', vb.read32(COUNTER), 1000);
check('... and the machine goes on', vb.frame, 1);
vb.unwatch(setting);
const stopping = vb.watch({ kind: 'exec', at: at.store, action: 'stop', then: () => vb.setRegister('r11', 7) });
let result = vb.runFrames(1);
check('a stopping watch does it first', `${result.stop?.reason} ${vb.register('r11')}`, 'watch 7');
vb.unwatch(stopping);
const atUntil = vb.watch({ kind: 'exec', at: at.store, then: () => vb.setRegister('r11', 9) });
result = vb.runUntil({ pc: at.store });
check('... and so does one at the instruction run to', `${result.stop?.reason} ${vb.register('r11')}`, 'until 9');
vb.unwatch(atUntil);
vb.step(1);
check('which then stores it', vb.read32(COUNTER), 9);
const written = vb.watch({ kind: 'write', at: [COUNTER, 4], then: () => vb.write32(0x05000100, vb.read32(0x05000100) + 1) });
vb.runFrames(1);
check('at an access too', vb.read32(0x05000100), written.count);
check('... with the write still landing', vb.read32(COUNTER) > 9, true);
vb.unwatch(written);

console.log('\nWatches folded by place');
vb = await open(buildRom());
const folded = vb.watch({ kind: 'write', at: [COUNTER, 8], fold: address => address >> 1 });
vb.runFrames(1);
const places = folded.places();
check('a word written is in the place of its first byte', places.length, 1);
check('... with every hit', places[0].count, folded.count);
check('... and the instruction that made them', places[0].pcs[0].count, folded.count);
check('... covering the word', `${places[0].addresses[0].toString(16)}-${places[0].addresses[1].toString(16)}`, '5000010-5000013');

finish();
