/**
 * What the SRAM panel's save map (a 32x4 grid) does to saves far bigger than any game's, as a cartridge gets all 16 MiB
 * of Game Pak RAM. The shapes are modelled, as no Virtual Boy game writes more than a few kilobytes. What the map is
 * built on:
 * - A grid finer than the record buys nothing: at a 16 KiB extent 32x4 is already at TOUCH_BYTES per cell, so every
 *   commercial game's save is mapped exactly.
 * - Coarse cells only lie when the save is sparse: a 1 MB save in twenty large blocks is 99% honestly drawn, sixteen
 *   1 KB records spread over 8 MB only 2%.
 * - More cells is the wrong fix: at one cell per pixel that save is 34 lit cells in 16384, honest and unreadable.
 *   Shading by how much of a cell was touched says the same in a readable grid.
 * Usage: node tests/sram-map-probe.mjs (--draw to see the maps)
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const map = require('../lib/common/emulator-sram-map.js');
const { TOUCH_BYTES, TOUCHED_WRITE } = map;

const KB = 1024, MB = 1024 * 1024;
const draw = process.argv.includes('--draw');

let failures = 0;
const check = (label, ok, detail) => {
    if (!ok) { failures++; }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
};
const report = (label, value) => console.log(`  --   ${label}: ${value}`);
const size = b => b >= MB ? `${+(b / MB).toFixed(2)} MB`
    : b >= KB ? `${+(b / KB).toFixed(2)} KB` : `${b} B`;

const CELLS = 32 * 4;

const SHAPES = [
    {
        name: 'Classic cartridge',
        note: 'a header and two slots, which is every commercial game',
        extent: 16 * KB,
        runs: [[0, 0x1f], [0x100, 0x8ff], [0x1000, 0x17ff]],
    },
    {
        name: 'Multi-slot homebrew',
        note: 'a directory and eight slots of 4 KB, five of them used',
        extent: 64 * KB,
        runs: [[0, 0xff], ...[0, 1, 2, 4, 7].map(slot =>
            [0x1000 + slot * 0x2000, 0x1000 + slot * 0x2000 + 0x9ff])],
    },
    {
        name: 'Level editor',
        note: 'a 4 KB directory and twenty levels of 32 KB',
        extent: 1 * MB,
        runs: [[0, 0xfff], ...Array.from({ length: 20 }, (unused, i) =>
            [0x8000 + i * 0xC000, 0x8000 + i * 0xC000 + 0x7fff])],
    },
    {
        name: 'Sparse archive',
        note: 'a header and sixteen 1 KB records spread over 8 MB',
        extent: 8 * MB,
        runs: [[0, 0x3ff], ...Array.from({ length: 16 }, (unused, i) =>
            [i * 0x7C000 + 0x1000, i * 0x7C000 + 0x13ff])],
    },
];

function record(shape) {
    const bytes = map.makeTouchRecord(16 * MB);
    for (const [first, last] of shape.runs) {
        map.markTouchRecord(bytes, first, last, TOUCHED_WRITE);
    }
    return bytes;
}

// how much of what the lit cells claim was really written, measured at the record's granularity, the finest
// the map can ever be
function honesty(bytes, extent, cells) {
    const { marks } = map.foldTouchRecord(bytes, extent, cells);
    const lit = marks.reduce((n, value) => n + (value ? 1 : 0), 0);
    const entries = bytes.reduce((n, value) => n + (value ? 1 : 0), 0);
    return {
        lit,
        written: entries * TOUCH_BYTES,
        claimed: lit * Math.max(TOUCH_BYTES, extent / cells),
    };
}

console.log('\nThe save map\n');

for (const shape of SHAPES) {
    const bytes = record(shape);
    const { lit, written, claimed } = honesty(bytes, shape.extent, CELLS);
    const { covered } = map.foldTouchRecord(bytes, shape.extent, CELLS);
    console.log(`${shape.name} — ${shape.note}`);
    report('extent', `${size(shape.extent)}, ${size(written)} written`);
    report('32x4', `${size(shape.extent / CELLS)}/cell, ${lit} lit, `
        + `claiming ${size(claimed)} = ${(written / claimed * 100).toFixed(0)}% honest`);
    const lit_ = [...covered].filter(value => value > 0);
    report('fill', `${(Math.min(...lit_) * 100).toFixed(1)}%–${(Math.max(...lit_) * 100).toFixed(1)}%`
        + ` of a cell, drawn at ${map.touchFillPercent(Math.min(...lit_)).toFixed(0)}%`
        + `–${map.touchFillPercent(Math.max(...lit_)).toFixed(0)}%`);
    if (draw) {
        const shades = [' ', '░', '▒', '▓', '█'];
        for (let row = 0; row < 4; row++) {
            console.log('       ' + Array.from({ length: 32 }, (unused, column) => {
                const value = covered[row * 32 + column];
                return value === 0 ? shades[0] : shades[Math.min(4, 1 + Math.floor(value * 3.999))];
            }).join(''));
        }
    }
    console.log();
}

console.log('What the design rests on');
{
    // must never regress: an ordinary cartridge's save is mapped exactly
    const classic = record(SHAPES[0]);
    const { covered } = map.foldTouchRecord(classic, SHAPES[0].extent, CELLS);
    const lit = [...covered].filter(value => value > 0);
    check('a 16 KiB save fills every cell it lights',
        lit.every(value => value === 1), `${lit.filter(v => v < 1).length} partial`);
    check('so shading it is a no-op',
        lit.every(value => map.touchFillPercent(value) === 100), 'some cell is not solid');
    check('and the grid is already as fine as the record',
        SHAPES[0].extent / CELLS === TOUCH_BYTES, String(SHAPES[0].extent / CELLS));

    // the case shading exists for
    const sparse = record(SHAPES[3]);
    const honest = honesty(sparse, SHAPES[3].extent, CELLS);
    check('a sparse save would otherwise claim far more than it holds',
        honest.claimed > honest.written * 20,
        `${size(honest.claimed)} claimed for ${size(honest.written)}`);
    const faintest = Math.min(...[...map.foldTouchRecord(sparse, SHAPES[3].extent, CELLS).covered]
        .filter(value => value > 0));
    check('and its cells are drawn far from solid',
        map.touchFillPercent(faintest) < 50, `${map.touchFillPercent(faintest).toFixed(0)}%`);
    check('but still visibly above nothing',
        map.touchFillPercent(faintest) > 30, `${map.touchFillPercent(faintest).toFixed(0)}%`);

    // and the reason the map is not simply given more cells
    const fine = honesty(sparse, SHAPES[3].extent, 256 * 64);
    report('at one cell per pixel the same save is',
        `${fine.lit} lit of ${256 * 64} — honest, and unreadable`);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
