import { VbPixelOrigin } from '../common/vb-pixel-origin';

export * from '../common/vb-pixel-origin';

// one line in the terms of the app's debug panels; `describe` names code addresses
export function describeOrigin(origin: VbPixelOrigin, describe: (address: number) => string, withPixel = true): string {
    const hex = (value: number, digits: number): string => `0x${value.toString(16).padStart(digits, '0')}`;
    const chosen = origin.vbcSource && {
        attribute: 'by its color attribute', character: 'by its character\'s color attribute', slot: 'by a pixel color slot',
        register: 'by CBKPAL', rows: 'by the backdrop row table',
    }[origin.vbcSource];
    const vbc = origin.vbc !== undefined
        ? `, VB Color palette ${hex(origin.vbc, 2)}${chosen ? ` ${chosen}` : ''}${origin.vbcOffset ? ' plus the world\'s offset' : ''}` : '';
    switch (origin.kind) {
        case 'unknown':
            return 'unknown: not drawn since origins were kept';
        case 'backdrop':
            return `backdrop, shade ${origin.value}${vbc}`;
        case 'cpu':
            return `written by ${describe(origin.pc!)}, value ${origin.value}`;
        case 'debugger':
            return `written by a debugger, value ${origin.value}`;
    }
    const place = origin.object
        ? `object ${origin.object.index} (${hex(origin.object.address, 8)})`
        : `BG map ${origin.bgmap!.segment} cell ${origin.bgmap!.x},${origin.bgmap!.y}${origin.kind === 'overplane' ? ' as overplane' : ''}`
            + ` (${hex(origin.bgmap!.address, 8)})`;
    const flips = [origin.flip!.h ? 'h' : '', origin.flip!.v ? 'v' : ''].join('');
    const pixel = withPixel ? ` pixel ${origin.pixel!.x},${origin.pixel!.y} value ${origin.value}` : '';
    return `world ${origin.world}, ${place}, character ${origin.character}${pixel}${flips ? ` (flipped ${flips})` : ''}, ${origin.palette}${vbc}`;
}
