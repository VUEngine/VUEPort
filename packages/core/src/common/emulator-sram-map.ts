// touch record behind the SRAM panel's save map and how it folds into cells. Kept apart from the panel (a Lumino widget
// that cannot load outside a browser) so tests/sram-map-probe.mjs can measure it

// written wins over read, which wins over neither
export const TOUCHED_READ = 1;
export const TOUCHED_WRITE = 2;

/**
 * Save bytes per record entry. Finer than a map cell and fixed, because the map's extent grows during a session;
 * a wider extent only folds the same record more coarsely. Over the full 16 MiB window it is 128 KiB of marks.
 */
export const TOUCH_BYTES = 128;

export function makeTouchRecord(window: number): Uint8Array {
    return new Uint8Array(Math.max(1, window / TOUCH_BYTES));
}

export function markTouchRecord(
    record: Uint8Array, first: number, last: number, mark: number
): void {
    const from = Math.max(0, Math.floor(first / TOUCH_BYTES));
    const to = Math.min(record.length - 1, Math.floor(last / TOUCH_BYTES));
    for (let entry = from; entry <= to; entry++) {
        record[entry] |= mark;
    }
}

export interface FoldedTouchRecord {
    marks: Uint8Array;
    covered: Float32Array; // per cell, the touched fraction from 0 to 1
}

/**
 * The record as the map draws it over `extent` bytes. Marks alone overstate large cells: sixteen 1 KB records spread
 * over 8 MB light sixteen cells of a 32x4 map, each standing for a megabyte, sixty times what was written. So the
 * touched fraction is folded alongside for shading. Where a cell is one entry, as in every commercial game, the
 * fraction is 0 or 1 and shading changes nothing.
 */
export function foldTouchRecord(
    record: Uint8Array, extent: number, cells: number
): FoldedTouchRecord {
    const perCell = Math.max(1, extent / TOUCH_BYTES / cells);
    const marks = new Uint8Array(cells);
    const covered = new Float32Array(cells);
    for (let cell = 0; cell < cells; cell++) {
        const from = cell * perCell;
        let seen = 0;
        let touched = 0;
        for (let entry = from; entry < from + perCell && entry < record.length; entry++) {
            seen |= record[entry];
            if (record[entry] !== 0) {
                touched++;
            }
        }
        marks[cell] = seen;
        covered[cell] = touched / perCell;
    }
    return { marks, covered };
}

// not the fraction itself, so a cell with 1 KB of a megabyte touched does not look untouched: starts well
// above nothing and rises by the square root, spending more range on the sparse end
export function touchFillPercent(covered: number): number {
    return covered <= 0 ? 0 : 30 + 70 * Math.sqrt(Math.min(1, covered));
}
