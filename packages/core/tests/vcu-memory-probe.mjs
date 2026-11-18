import {
    VBC_VERSION_VALUE, VCU_APERTURE_BYTES, VCU_BACKDROP_ROW_BASE, VCU_CELL_PIXEL_ATTR_BASE,
    VCU_CHARACTER_COLOR_BASE, VCU_CHARACTER_PIXEL_ATTR_BASE,
    VCU_CRAM_BASE, VCU_CRAM_COLORS, VCU_NAMED_REGISTER_BYTES, VCU_OBJ_PIXEL_ATTR_BASE,
    VCU_PIXEL_SLOT_BASE, VCU_PIXEL_SLOT_COUNT, VCU_REGISTER_BASE, VCU_WORLD_ATTR_BASE,
    VcuRegister, vcuRgb888,
    VCU_CELL_COLOR_BASE, VCU_OBJ_COLOR_BASE, VCU_CHAR_EXT_BASE,
    decodeVcuColorAttr, encodeVcuColorAttr, decodeVcuPixelAttr, encodeVcuPixelAttr, vcuPlacementPalette,
} from '../lib/browser/panels/emulator-vcu-memory.js';
import {
    vipCharSegmentAddress, vipCharSegmentCount, decodeVipBgMapCell, encodeVipBgMapCell,
} from '../lib/browser/panels/emulator-vip-memory.js';

let failures = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        console.log(`       expected ${expected}, got ${actual}`);
        failures++;
    }
};

console.log('\nVBC 1.0 VCU map');
check('CRAM base', VCU_CRAM_BASE, 0x03079000);
check('CRAM entries', VCU_CRAM_COLORS, 1024);
check('register base', VCU_REGISTER_BASE, 0x0307f800);
check('architecture version', VBC_VERSION_VALUE, 0x0100);
check('aperture is 1 MiB', VCU_APERTURE_BYTES, 0x100000);
check('Cell Pixel Color Attribute RAM', VCU_CELL_PIXEL_ATTR_BASE, 0x03080000);
check('OBJ Pixel Color Attribute RAM', VCU_OBJ_PIXEL_ATTR_BASE, 0x030a0000);
check('World Color Attribute RAM', VCU_WORLD_ATTR_BASE, 0x030a0800);
check('Backdrop Row Table', VCU_BACKDROP_ROW_BASE, 0x030a1000);
check('Character Color Attribute RAM', VCU_CHARACTER_COLOR_BASE, 0x030a2000);
check('Character Pixel Color Attribute RAM', VCU_CHARACTER_PIXEL_ATTR_BASE, 0x030a4000);
check('Pixel Color Slot RAM', VCU_PIXEL_SLOT_BASE, 0x030b0000);
check('1024 pixel color slots', VCU_PIXEL_SLOT_COUNT, 1024);
check('CXCTRL offset', VcuRegister.CXCTRL, 0x1a);
check('PCCAP offset', VcuRegister.PCCAP, 0x1c);
check('DMACTRL offset', VcuRegister.DMACTRL, 0x2a);
check('named registers end after DMACTRL', VCU_NAMED_REGISTER_BYTES, 0x2c);

console.log('\nVCU RGB888 colors');
check('black', vcuRgb888(0x000000).css, '#000000');
check('red', vcuRgb888(0x0000ff).css, '#FF0000');
check('green', vcuRgb888(0x00ff00).css, '#00FF00');
check('blue', vcuRgb888(0xff0000).css, '#0000FF');
check('white', vcuRgb888(0xffffff).css, '#FFFFFF');
check('red is the low byte', vcuRgb888(0x000001).css, '#010000');
check('the unused high byte is ignored', vcuRgb888(0xffffffff).css, '#FFFFFF');

console.log('\nColor attributes');
check('Cell Color Attribute RAM', VCU_CELL_COLOR_BASE, 0x03060000);
check('OBJ Color Attribute RAM', VCU_OBJ_COLOR_BASE, 0x03070000);
check('Character RAM Extension', VCU_CHAR_EXT_BASE, 0x03071000);
check('palette group is bits 5-0', decodeVcuColorAttr(0xbf).group, 0x3f);
check('CHRSEL is bit 7', decodeVcuColorAttr(0x80).chrsel, true);
check('no CHRSEL without bit 7', decodeVcuColorAttr(0x7f).chrsel, false);
check('color attribute keeps bit 6', encodeVcuColorAttr({ group: 5, chrsel: true }, 0x40), 0xc5);
check('PCE is bit 15', decodeVcuPixelAttr(0x8000).enabled, true);
check('OPQ is bit 14', decodeVcuPixelAttr(0x4000).opaque, true);
check('slot is bits 9-0', decodeVcuPixelAttr(0xffff).slot, 0x3ff);
check('pixel attribute keeps bits 13-10',
    encodeVcuPixelAttr({ enabled: true, opaque: false, slot: 7 }, 0x3c00), 0xbc07);
check('placement palette: group above GPLTS', vcuPlacementPalette(3, 2), 14);
check('placement palette wraps with the world offset', vcuPlacementPalette(0x3f, 3, 2), 1);

console.log('\nExtended characters');
check('four segments without CHREXT', vipCharSegmentCount(false), 4);
check('eight with it', vipCharSegmentCount(true), 8);
check('segment 3 is still the VIP\'s', vipCharSegmentAddress(3), 0x0001e000);
check('segment 4 starts the extension', vipCharSegmentAddress(4), 0x03071000);
check('segment 7 is its last quarter', vipCharSegmentAddress(7), 0x03077000);
check('eleven-bit cells ignore bit 11', decodeVipBgMapCell(0x0fff).char, 0x07ff);
check('twelve-bit cells keep it', decodeVipBgMapCell(0x0fff, 0x0fff).char, 0x0fff);
check('twelve-bit cells write it', encodeVipBgMapCell({ char: 0x0800, palette: 0, hFlip: false, vFlip: false }, 0x0fff), 0x0800);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
