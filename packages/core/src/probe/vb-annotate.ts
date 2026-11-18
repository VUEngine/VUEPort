import { VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH } from '../common/vb-constants';
import { readObjects, readVip } from './vb-inspect';
import { VbMachine } from './vb-machine';
import { framePicture, VbPicture } from './vb-picture';

export type VbAnnotation = 'worlds' | 'objects';

// a screenshot with a frame and number over every world drawn or object shown, to hold beside a `vip worlds` or
// `vip objects` listing. Enlarged nearest-neighbour so the numbers can be read; drawing is one output pixel wide
export function annotatedPicture(vb: VbMachine, what: VbAnnotation, eye: 'left' | 'right' = 'left', scale = 3): VbPicture {
    const base = framePicture(vb.frameBuffer(), eye);
    const factor = Math.max(1, Math.floor(scale));
    const width = base.width * factor;
    const height = base.height * factor;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = (Math.floor(y / factor) * base.width + Math.floor(x / factor)) * 4;
            const to = (y * width + x) * 4;
            // dimmed, so the frames stand out of the game's own red
            rgba[to] = base.rgba[from] * 0.55;
            rgba[to + 1] = base.rgba[from + 1] * 0.55;
            rgba[to + 2] = base.rgba[from + 2] * 0.55;
            rgba[to + 3] = 255;
        }
    }
    const canvas = new Canvas(rgba, width, height);

    if (what === 'worlds') {
        for (const world of readVip(vb).worlds) {
            if (world.modeName === 'Object' || !(eye === 'left' ? world.lon : world.ron)) {
                continue;
            }
            const color = COLORS[world.index % COLORS.length];
            const x = world.gx + (eye === 'left' ? -world.gp : world.gp);
            canvas.frame(x * factor, world.gy * factor, (world.w + 1) * factor, (world.h + 1) * factor, color);
            canvas.label(`W${world.index}`, x * factor + 2, world.gy * factor + 2, color);
        }
    } else {
        for (const object of readObjects(vb)) {
            if (!(eye === 'left' ? object.left : object.right)) {
                continue;
            }
            const color = object.group === undefined ? WHITE : COLORS[object.group];
            const x = object.x + (eye === 'left' ? -object.parallax : object.parallax);
            if (x <= -8 || x >= VB_SCREEN_WIDTH || object.y >= VB_SCREEN_HEIGHT) {
                continue;
            }
            canvas.frame(x * factor, object.y * factor, 8 * factor, 8 * factor, color);
            canvas.label(String(object.index), x * factor + 1, object.y * factor + 1, color);
        }
    }
    return { rgba, width, height };
}

type Rgb = [number, number, number];

const WHITE: Rgb = [255, 255, 255];
// bright and far apart; objects take theirs by group, worlds by number
const COLORS: Rgb[] = [[0, 230, 255], [255, 220, 0], [255, 80, 255], [80, 255, 80], [255, 140, 40], [120, 160, 255]];

// three by five pixel figures, a row of three bits each, top first
const GLYPHS: Record<string, number[]> = {
    0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 7, 1, 7], 4: [5, 5, 7, 1, 1],
    5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7],
    W: [5, 5, 5, 7, 5],
};
const GLYPH_SCALE = 2; // each figure pixel drawn this many output pixels square

class Canvas {

    constructor(protected readonly rgba: Uint8ClampedArray, protected readonly width: number, protected readonly height: number) { }

    frame(x: number, y: number, width: number, height: number, color: Rgb): void {
        for (let i = 0; i < width; i++) {
            this.put(x + i, y, color);
            this.put(x + i, y + height - 1, color);
        }
        for (let i = 0; i < height; i++) {
            this.put(x, y + i, color);
            this.put(x + width - 1, y + i, color);
        }
    }

    // text on a dark patch, so it reads over anything
    label(text: string, x: number, y: number, color: Rgb): void {
        const advance = 4 * GLYPH_SCALE;
        const patchWidth = text.length * advance + GLYPH_SCALE;
        const patchHeight = 7 * GLYPH_SCALE;
        for (let py = 0; py < patchHeight; py++) {
            for (let px = 0; px < patchWidth; px++) {
                this.put(x + px, y + py, [0, 0, 0]);
            }
        }
        [...text].forEach((character, index) => {
            const rows = GLYPHS[character];
            if (!rows) {
                return;
            }
            rows.forEach((bits, row) => {
                for (let column = 0; column < 3; column++) {
                    if (bits & (4 >> column)) {
                        for (let dy = 0; dy < GLYPH_SCALE; dy++) {
                            for (let dx = 0; dx < GLYPH_SCALE; dx++) {
                                this.put(x + GLYPH_SCALE + index * advance + column * GLYPH_SCALE + dx, y + GLYPH_SCALE + row * GLYPH_SCALE + dy, color);
                            }
                        }
                    }
                }
            });
        });
    }

    protected put(x: number, y: number, color: Rgb): void {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
            return;
        }
        const at = (y * this.width + x) * 4;
        this.rgba[at] = color[0];
        this.rgba[at + 1] = color[1];
        this.rgba[at + 2] = color[2];
    }
}
