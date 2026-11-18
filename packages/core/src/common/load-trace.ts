// TEMPORARY: times the steps between opening a ROM and its first frame, for a Linux report of ROMs
// taking ~5 s to start (desktop and browser). Each mark logs its own duration and the running total.
// Remove once answered

let started: number | undefined;
let last = 0;

export function beginLoadTrace(): void {
    started = last = performance.now();
    console.info('[vueport] load trace: begin');
}

export function markLoadTrace(step: string): void {
    if (started === undefined) {
        return;
    }
    const now = performance.now();
    console.info(
        `[vueport] load trace: ${step.padEnd(28)} +${(now - last).toFixed(1).padStart(7)} ms`
        + `  (total ${(now - started).toFixed(1)} ms)`);
    last = now;
}

// last mark: logs and stops, so later restarts do not keep logging
export function endLoadTrace(step: string): void {
    markLoadTrace(step);
    started = undefined;
}
