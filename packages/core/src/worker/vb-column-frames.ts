import {
    ColumnSpread,
    SpinUpFrame,
    VB_COLUMN_GROUPS,
    columnEdges,
    columnSpread,
    isReferenceColumns,
} from '../common/vb-column-geometry';
import { VBC_FRAME_WIDTH, VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH, vbFrameBytes } from '../common/vb-constants';

const CACHED_SHAPES = 8; // how many differently shaped tables are remembered, for a session of two linked units

// frames as the column table shapes them: each eye's columns moved to where the mirror put them, see
// vb-column-geometry.ts. Done in the frame rather than the renderer, so screen, blending, screenshots,
// recordings and the headset all agree. An eye with Nintendo's table (every commercial game) passes untouched
export class ColumnFrames {
    protected readonly shapes = new Map<string, ColumnSpread>();
    protected readonly output = { legacy: new Uint8Array(vbFrameBytes(false)), color: new Uint8Array(vbFrameBytes(true)) };

    // lengths: 96 per eye, left eye first, as vbGetColumnLengths hands them over, and the mirror as it is while the
    // display is still spinning up (see mirrorSpinUp). Returns pixels itself or a copy good until the next call
    shape(pixels: Uint8Array, colorMode: boolean, lengths: Uint8Array, spinUp?: SpinUpFrame): Uint8Array {
        const left = lengths.subarray(0, VB_COLUMN_GROUPS);
        const right = lengths.subarray(VB_COLUMN_GROUPS, VB_COLUMN_GROUPS * 2);
        // a mirror still finding its swing is new every frame, not worth remembering
        const spreads = spinUp
            ? [columnSpread(columnEdges(left, 0, spinUp)), columnSpread(columnEdges(right, 1, spinUp))]
            : [
                isReferenceColumns(left, 0) ? undefined : this.spreadOf(left, 0),
                isReferenceColumns(right, 1) ? undefined : this.spreadOf(right, 1),
            ];
        if (!spreads[0] && !spreads[1]) {
            return pixels;
        }
        const output = colorMode ? this.output.color : this.output.legacy;
        output.set(pixels);
        const light = spinUp?.light ?? 1;
        spreads.forEach((spread, eye) => {
            if (spread) {
                if (colorMode) {
                    spreadColor(pixels, output, spread, eye, light);
                } else {
                    spreadLegacy(pixels, output, spread, eye, light);
                }
            }
        });
        return output;
    }

    protected spreadOf(lengths: Uint8Array, eye: number): ColumnSpread {
        const key = `${eye}:${lengths.join(',')}`;
        let spread = this.shapes.get(key);
        if (!spread) {
            spread = columnSpread(columnEdges(lengths, eye));
            if (this.shapes.size >= CACHED_SHAPES) {
                this.shapes.delete(this.shapes.keys().next().value!);
            }
            this.shapes.set(key, spread);
        }
        return spread;
    }
}

// the eye-packed legacy frame: each eye's brightness in its own channel, R left and G right
function spreadLegacy(source: Uint8Array, output: Uint8Array, spread: ColumnSpread, eye: number, light: number): void {
    const { offsets, columns, weights } = spread;
    for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
        const row = y * VB_SCREEN_WIDTH * 4 + eye;
        for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
            let sum = 0;
            for (let i = offsets[x]; i < offsets[x + 1]; i++) {
                sum += source[row + columns[i] * 4] * weights[i];
            }
            sum *= light;
            output[row + x * 4] = sum > 255 ? 255 : sum;
        }
    }
}

// the VB Color frame: the left eye's RGB in the left half of each row, the right eye's in the right
function spreadColor(source: Uint8Array, output: Uint8Array, spread: ColumnSpread, eye: number, light: number): void {
    const { offsets, columns, weights } = spread;
    for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
        const row = (y * VBC_FRAME_WIDTH + eye * VB_SCREEN_WIDTH) * 4;
        for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            for (let i = offsets[x]; i < offsets[x + 1]; i++) {
                const at = row + columns[i] * 4;
                r += source[at] * weights[i];
                g += source[at + 1] * weights[i];
                b += source[at + 2] * weights[i];
            }
            const to = row + x * 4;
            r *= light;
            g *= light;
            b *= light;
            output[to] = r > 255 ? 255 : r;
            output[to + 1] = g > 255 ? 255 : g;
            output[to + 2] = b > 255 ? 255 : b;
        }
    }
}
