/**
 * Macros: recorded button sequences. A macro is a list of states, not presses and releases, so it cannot express a
 * stuck button: every entry says what is held until the next one. Invariants, set by `finishMacro` and relied on
 * everywhere: the first entry is at 0, and the last holds nothing with `duration` as its moment, so a macro always ends
 * released and looping is `elapsed % duration`. Times are milliseconds of emulated running time, so a pause while
 * recording does not lengthen it.
 */

export interface MacroStep {
    at: number;
    // player buttons only: the controller-present and low battery bits are folded in by whatever pushes a mask into the
    // core
    keys: number;
}

export interface Macro {
    name: string;
    steps: MacroStep[];
    duration: number;
    loop?: boolean;
    // not written into the files, as the file a macro is in is what makes it global (see `serializeMacroFile`)
    global?: boolean;
    // 1-8, written into the file unlike `loop`. One macro per slot within a file (see `setSlot` in the macro store),
    // but a game's and a global macro can share a number; the game's wins
    slot?: number;
}

export const MACRO_SLOT_COUNT = 8;

export function readMacroSlot(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MACRO_SLOT_COUNT
        ? value
        : undefined;
}

export const MACRO_FILE_VERSION = 1;

export function emptyMacro(name: string): Macro {
    return { name, steps: [], duration: 0 };
}

export function macroIsEmpty(macro: Macro): boolean {
    return macro.duration <= 0 || !macro.steps.some(step => step.keys !== 0);
}

// `stoppedAt` is on the same clock as `steps`; leading dead time is cut, and a release is appended if something was
// still held
export function finishMacro(name: string, steps: MacroStep[], stoppedAt: number): Macro {
    const first = steps.findIndex(step => step.keys !== 0);
    if (first === -1) {
        return emptyMacro(name);
    }

    const offset = steps[first].at;
    const shifted: MacroStep[] = [];
    for (const step of steps.slice(first)) {
        const at = Math.max(0, Math.round(step.at - offset));
        const previous = shifted[shifted.length - 1];
        if (previous && previous.keys === step.keys) {
            // nothing changed, e.g. a gamepad reporting the same mask twice or a key repeating
            continue;
        }
        if (previous && previous.at === at) {
            // two changes inside the same millisecond: only the later one was ever held
            previous.keys = step.keys;
            continue;
        }
        shifted.push({ at, keys: step.keys });
    }

    const last = shifted[shifted.length - 1];
    const end = Math.max(Math.round(stoppedAt - offset), last.at);
    if (last.keys !== 0) {
        shifted.push({ at: end, keys: 0 });
    }
    return { name, steps: shifted, duration: shifted[shifted.length - 1].at };
}

// a linear scan is fine, as playback steps forward a frame at a time
export function macroKeysAt(macro: Macro, elapsed: number): number {
    let keys = 0;
    for (const step of macro.steps) {
        if (step.at > elapsed) {
            break;
        }
        keys = step.keys;
    }
    return keys;
}

export function macroKeysUsed(macro: Macro): number {
    return macro.steps.reduce((keys, step) => keys | step.keys, 0);
}

// mask per press, as the list shows under a macro's name; releases aren't presses, and buttons going down together are
// one chord
export function macroPresses(macro: Macro): number[] {
    const presses: number[] = [];
    let held = 0;
    for (const step of macro.steps) {
        const pressed = step.keys & ~held;
        if (pressed !== 0) {
            presses.push(pressed);
        }
        held = step.keys;
    }
    return presses;
}

export function macroPressCount(macro: Macro): number {
    return macroPresses(macro).length;
}

// `0.4 s`, `12.5 s`, `1:03.2`
export function formatMacroDuration(milliseconds: number): string {
    const seconds = Math.max(0, milliseconds) / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(1)} s`;
    }
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

// lenient, as a file can be hand-edited, truncated by a browser out of quota or left by a future version: anything that
// doesn't parse as a macro is dropped
export function parseMacroFile(text: string): Macro[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    const macros = (parsed as { macros?: unknown })?.macros;
    if (!Array.isArray(macros)) {
        return [];
    }
    return macros
        .map(readMacro)
        .filter((macro): macro is Macro => macro !== undefined);
}

function readMacro(value: unknown): Macro | undefined {
    const raw = value as Partial<Macro> | undefined;
    if (!raw || typeof raw.name !== 'string' || !Array.isArray(raw.steps)) {
        return undefined;
    }
    const steps: MacroStep[] = [];
    for (const entry of raw.steps) {
        const step = entry as Partial<MacroStep>;
        if (typeof step?.at !== 'number' || typeof step?.keys !== 'number'
            || !Number.isFinite(step.at) || !Number.isFinite(step.keys)) {
            continue;
        }
        steps.push({ at: Math.max(0, Math.round(step.at)), keys: step.keys >>> 0 });
    }
    // sorted rather than trusted, as playback reads them in order
    steps.sort((a, b) => a.at - b.at);
    const slot = readMacroSlot(raw.slot);
    if (steps.length === 0) {
        return { name: raw.name, steps: [], duration: 0, ...(slot ? { slot } : {}) };
    }
    // restore the closing release, or a file that lost it would play a macro that never lets go
    if (steps[steps.length - 1].keys !== 0) {
        steps.push({ at: steps[steps.length - 1].at, keys: 0 });
    }
    const declared = typeof raw.duration === 'number' && Number.isFinite(raw.duration)
        ? Math.round(raw.duration) : 0;
    return {
        name: raw.name,
        steps,
        duration: Math.max(declared, steps[steps.length - 1].at),
        ...(slot ? { slot } : {}),
    };
}

export function serializeMacroFile(macros: ReadonlyArray<Macro>): string {
    // built field by field rather than deleting `loop` (a browser preference) and `global`, so a field added later is
    // never written by accident
    const definitions = macros.map(macro => ({
        name: macro.name,
        ...(readMacroSlot(macro.slot) ? { slot: macro.slot } : {}),
        steps: macro.steps,
        duration: macro.duration,
    }));
    return JSON.stringify({ version: MACRO_FILE_VERSION, macros: definitions }, undefined, 2) + '\n';
}
