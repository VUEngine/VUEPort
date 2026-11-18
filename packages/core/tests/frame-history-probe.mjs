// the frames shown before the current one, kept for screenshots that blend, following the renderer's rules for
// which frame counts as the one before
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FrameHistory, SkippedFrames } = require('../lib/worker/vb-frame-history.js');

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        failures++;
        console.log(`       got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

const SIZE = 384 * 224 * 4;
const frame = value => new Uint8Array(SIZE).fill(value);
const before = history => {
    const previous = history.previous()[0];
    return previous && { first: new Uint8Array(previous.pixels)[0], colorMode: previous.colorMode };
};
const firsts = history => history.previous().map(previous => new Uint8Array(previous.pixels)[0]);

console.log('\nFrame history');
const history = new FrameHistory();
check('nothing before the first frame', before(history), undefined);
history.record(frame(1), false, 'next');
check('still nothing before the first frame once it is shown', before(history), undefined);
history.record(frame(2), true, 'next');
check('the next frame has the first before it', before(history), { first: 1, colorMode: false });
history.record(frame(3), false, 'replace');
check('redrawing the current frame keeps the one before', before(history), { first: 1, colorMode: false });
history.record(frame(4), false, 'next');
check('the redrawn frame is the one before the next', before(history), { first: 3, colorMode: false });
history.record(frame(5), false, 'jump');
check('a jump forgets the frame before', before(history), undefined);
history.record(frame(6), false, 'next');
check('and the frame after a jump has the jump before it', before(history), { first: 5, colorMode: false });

const copy = history.previous()[0];
history.record(frame(7), false, 'next');
check('a copy handed out is not overwritten by later frames', new Uint8Array(copy.pixels)[0], 5);
check('the peek is the frames before without a copy', history.peekPrevious().map(f => f.pixels[0]), [6, 5]);

console.log('\nThe frame before that');
const two = new FrameHistory();
two.record(frame(1), false, 'next');
two.record(frame(2), false, 'next');
check('two frames in, only one before', firsts(two), [1]);
two.record(frame(3), true, 'next');
check('three frames in, two before, the most recent first', firsts(two), [2, 1]);
check('each with its own transport',
    two.previous().map(previous => previous.colorMode), [false, false]);
two.record(frame(4), false, 'next');
check('four frames in, three before', firsts(two), [3, 2, 1]);
check('the transport moves with them',
    two.previous().map(previous => previous.colorMode), [true, false, false]);
two.record(frame(5), false, 'next');
check('and they move along', firsts(two), [4, 3, 2]);
two.record(frame(6), false, 'replace');
check('a redraw keeps them', firsts(two), [4, 3, 2]);
two.record(frame(7), false, 'jump');
check('a jump forgets them', firsts(two), []);
two.record(frame(8), false, 'next');
check('after a jump, one before again', firsts(two), [7]);

console.log('\nBlended for the halo');
const W = 384;
// a legacy frame: black, with the left eye's brightness at one pixel
const lit = (x, y, value) => {
    const pixels = new Uint8Array(SIZE);
    pixels[(y * W + x) * 4] = value;
    return pixels;
};
const leftAt = (frame, x, y) => frame.pixels[(y * W + x) * 4];
const halo = new FrameHistory();
check('nothing shown, nothing to blend', halo.blendedCurrent('full'), undefined);
halo.record(lit(100, 100, 255), false, 'next');
check('one frame alone is shown as it is', leftAt(halo.blendedCurrent('full'), 100, 100), 255);
halo.record(lit(200, 100, 255), false, 'next');
check('off leaves the frame alone', leftAt(halo.blendedCurrent('off'), 200, 100), 255);
check('full mixes with the frame before, in linear light',
    [leftAt(halo.blendedCurrent('full'), 200, 100), leftAt(halo.blendedCurrent('full'), 100, 100)], [188, 188]);
check('smart needs the frame before that', leftAt(halo.blendedCurrent('smart'), 200, 100), 255);
halo.record(lit(100, 100, 255), false, 'next');
const smart = halo.blendedCurrent('smart');
check('smart mixes what goes A, B, A', [leftAt(smart, 100, 100), leftAt(smart, 200, 100)], [188, 188]);
const reach = new FrameHistory();
reach.record(lit(100, 100, 255), false, 'next');
reach.record(new Uint8Array(SIZE), false, 'next');
const grown = lit(100, 100, 255);
grown[(100 * W + 102) * 4] = 255;
grown[(100 * W + 103) * 4] = 255;
reach.record(grown, false, 'next');
check('and the pixels within reach of it, like a flickering sprite\'s leading edge',
    leftAt(reach.blendedCurrent('smart'), 102, 100), 188);
check('but not beyond', leftAt(reach.blendedCurrent('smart'), 103, 100), 255);
const moving = new FrameHistory();
moving.record(lit(10, 10, 255), false, 'next');
moving.record(lit(20, 10, 255), false, 'next');
moving.record(lit(30, 10, 255), false, 'next');
check('smart leaves what moves sharp', leftAt(moving.blendedCurrent('smart'), 30, 10), 255);
check('blending never touches the frame held', leftAt({ pixels: halo.peekPrevious()[0].pixels }, 200, 100), 255);
// a layer drawn on alternate frames over a changing picture: 255 is the layer, the other values what shows between
const layered = values => {
    const history = new FrameHistory();
    for (const value of values) {
        history.record(lit(50, 50, value), false, 'next');
    }
    return leftAt(history.blendedCurrent('smart'), 50, 50);
};
check('smart mixes a pixel that went A, B, A the frame before', layered([255, 10, 255, 20]), 188);
check('and the frame before needs the one before it', layered([10, 255, 20]), 20);
check('not a pixel that only changes', layered([10, 20, 30, 40]), 40);
// most of an 8 x 8 cell flickering: the cell and the cells around it blend
const cell = (value, extra) => {
    const pixels = new Uint8Array(SIZE);
    for (let y = 80; y < 88; y++) {
        for (let x = 80; x < 88; x++) {
            pixels[(y * W + x) * 4] = value;
        }
    }
    for (const [x, y, v] of extra) {
        pixels[(y * W + x) * 4] = v;
    }
    return pixels;
};
const cells = new FrameHistory();
cells.record(cell(255, [[93, 84, 100], [104, 84, 100]]), false, 'next');
cells.record(cell(0, [[93, 84, 200], [104, 84, 200]]), false, 'next');
cells.record(cell(255, [[93, 84, 0], [104, 84, 0]]), false, 'next');
const celled = cells.blendedCurrent('smart');
check('a mostly flickering cell blends its neighbors beyond reach', leftAt(celled, 93, 84), 146);
check('but not the cells beyond those', leftAt(celled, 104, 84), 0);

console.log('\nSkipped by fast forward');
const skipped = new SkippedFrames();
check('nothing held, nothing to show before', skipped.take().map(f => f.pixels[0]), []);
skipped.hold(frame(1), false);
check('the one held is the one shown, not one before it', skipped.take().map(f => f.pixels[0]), []);
for (const value of [1, 2, 3, 4]) {
    skipped.hold(frame(value), value === 3);
}
for (const value of [5, 6]) {
    skipped.hold(frame(value), value === 3);
}
const taken = skipped.take();
check('the three before the newest, oldest first', taken.map(f => f.pixels[0]), [3, 4, 5]);
check('with their transport', taken.map(f => f.colorMode), [true, false, false]);
check('taking forgets them', skipped.take().length, 0);
skipped.hold(frame(7), false);
skipped.hold(frame(8), false);
skipped.clear();
skipped.hold(frame(9), false);
check('a gap forgets what came before it', skipped.take().map(f => f.pixels[0]), []);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
