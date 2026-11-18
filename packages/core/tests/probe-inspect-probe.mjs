// hardware state as data: known values written through the bus have to come back decoded as the app's panels do.
// Usage: node tests/probe-inspect-probe.mjs
import { createRequire } from 'module';
import { buildRom, check, finish, readCoreWasm } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { VbMachine, readVip, readObjects, readBgMap, readCharacter, readVbcState } = require('../lib/probe/index.js');

const core = readCoreWasm();
const vb = await VbMachine.create({ core, rom: buildRom(), sramWindow: 0x4000, hardware: 'vb' });
vb.runFrames(1);

const halfwords = (address, values) => values.forEach((value, index) => vb.write16(address + index * 2, value));

console.log('Worlds');
// world 31: BGMap, both eyes, segment 3, 2x1 segments; world 30: objects; world 29: END
halfwords(0x0003d800 + 31 * 32, [0xc000 | (1 << 10) | 3, 8, 2, 16, 24, 0, 32, 191, 95, 0, 0]);
halfwords(0x0003d800 + 30 * 32, [0xc000 | (3 << 12)]);
halfwords(0x0003d800 + 29 * 32, [0x0040]);
let vip = readVip(vb);
check('two worlds drawn', vip.worlds.map(world => world.index).join(','), '31,30');
check('the first is a BGMap', vip.worlds[0].modeName, 'BGMap');
check('... on segment 3', vip.worlds[0].bgMap, 3);
check('... two segments across', vip.worlds[0].scx, 2);
check('... at its screen position', `${vip.worlds[0].gx},${vip.worlds[0].gp},${vip.worlds[0].gy}`, '8,2,16');
check('... and size, as registers', `${vip.worlds[0].w},${vip.worlds[0].h}`, '191,95');
check('the object world draws group 3', vip.worlds[1].objectGroup, 3);

console.log('\nRegisters and palettes');
vb.write16(0x0005f800 + 0x24, 32);   // BRTA
vb.write16(0x0005f800 + 0x26, 64);   // BRTB
vb.write16(0x0005f800 + 0x28, 32);   // BRTC
vb.write16(0x0005f800 + 0x60, 0xe4); // GPLT0: 0, 1, 2, 3
vip = readVip(vb);
check('brightness as the core lights it', vip.brightness.join(','), '0,105,162,250');
check('GPLT0 shades', vip.palettes.bgmap[0].join(','), '0,105,162,250');
check('registers by name', vip.registers.GPLT0, 0xe4);

console.log('\nObjects');
halfwords(0x0003e000 + 7 * 8, [(-5) & 0x3ff, 0xc000 | 3, 40, (2 << 14) | 0x2000 | 0x123]);
const objects = readObjects(vb);
const seven = objects.find(object => object.index === 7);
check('a shown object is listed', seven !== undefined, true);
check('... signed x', seven?.x, -5);
check('... parallax, y, char, palette, flip', `${seven?.parallax},${seven?.y},${seven?.char},${seven?.palette},${seven?.hFlip}`, '3,40,291,2,true');
check('hidden objects are left out', objects.every(object => object.left || object.right), true);
check('--all lists every one', readObjects(vb, { all: true }).length, 1024);

console.log('\nBGMaps and characters');
vb.write16(0x00020000 + 3 * 0x2000 + (2 * 64 + 5) * 2, (1 << 14) | 0x1000 | 0x042);
const [cell] = readBgMap(vb, 3, { x: 5, y: 2, width: 1, height: 1 });
check('a cell', `${cell.x},${cell.y},${cell.char},${cell.palette},${cell.vFlip}`, '5,2,66,1,true');
vb.write16(0x00006000 + 66 * 16 + 2, 0b1110_0100);   // character 66, row 1: 0 1 2 3
check('a character row, leftmost pixel low', readCharacter(vb, 66)[1].slice(0, 4).join(''), '0123');

console.log('\nSound');
vb.write8(0x01000400 + 0x04, 0xff);  // S1LRV: full both sides
vb.write8(0x01000400 + 0x08, 0x00);  // S1FQL
vb.write8(0x01000400 + 0x0c, 0x07);  // S1FQH: F = 0x700
vb.write8(0x01000400 + 0x10, 0xf0);  // S1EV0: level 15
vb.write8(0x01000400 + 0x00, 0x80);  // S1INT: on
const channel = vb.vsu().channels[0];
check('a channel switched on', channel.enabled, true);
check('... at its frequency', channel.frequencyRaw, 0x700);
check('... and level', `${channel.left},${channel.right},${channel.envelope.initialValue}`, '15,15,15');

console.log('\nVB Color');
check('a plain Virtual Boy has none', readVbcState(vb), undefined);
const color = await VbMachine.create({ core, rom: buildRom(), sramWindow: 0x4000, hardware: 'vbc' });
check('VB Color hardware before the game unlocks it has none either', readVbcState(color), undefined);
color.write16(0x0307f806, 0xc001);
color.write32(0x03079000 + (5 * 4 + 2) * 4, 0x00336699);   // palette 5, shade 2
const vbc = readVbcState(color);
check('unlocked, it reads', vbc !== undefined, true);
check('CRAM as colors', vbc?.cram[5][2], '#996633');

finish();
