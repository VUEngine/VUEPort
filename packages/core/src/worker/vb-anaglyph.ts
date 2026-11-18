import { VB_DUBOIS_MATRICES, VbAnaglyphMatrices, VbAnaglyphPalette } from '../common/vb-constants';

// calibration is explicit, never guessed from RGB swatches: custom filters stay channel masks even when their colors
// match a calibrated preset, so editing a tint never silently switches algorithms. For Dubois profiles the swatches
// are only labels, not additional matrix gains
export function duboisMatrices(filters: VbAnaglyphPalette): VbAnaglyphMatrices | undefined {
    if (filters.duboisMatrices) {
        return filters.duboisMatrices;
    }
    switch (filters.duboisProfile) {
        case 'red-cyan':
        case 'green-magenta':
        case 'amber-blue':
            return VB_DUBOIS_MATRICES[filters.duboisProfile];
        default:
            return undefined;
    }
}

const unpack = (color: number): number[] => [
    (color >> 16 & 0xff) / 255,
    (color >> 8 & 0xff) / 255,
    (color & 0xff) / 255,
];
const linear = (value: number): number => value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
const srgb = (value: number): number => value <= 0.0031308
    ? value * 12.92
    : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;

// CPU equivalent of the renderer's anaglyph composition, for UI previews and halos
export function composeAnaglyph(
    leftColor: number, rightColor: number, filters: VbAnaglyphPalette
): number {
    const left = unpack(leftColor);
    const right = unpack(rightColor);
    const matrices = duboisMatrices(filters);
    let result: number[];
    if (matrices) {
        const ll = left.map(linear);
        const rl = right.map(linear);
        result = [0, 1, 2].map(row => srgb(Math.max(0, Math.min(1,
            ll.reduce((sum, value, column) =>
                sum + matrices.left[row + column * 3] * value, 0)
            + rl.reduce((sum, value, column) =>
                sum + matrices.right[row + column * 3] * value, 0)
        ))));
    } else {
        const leftFilter = unpack(filters.left);
        const rightFilter = unpack(filters.right);
        result = left.map((value, channel) => Math.min(1,
            value * leftFilter[channel] + right[channel] * rightFilter[channel]));
    }
    const bytes = result.map(value => Math.round(value * 255));
    return (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
}
