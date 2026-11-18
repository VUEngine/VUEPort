// formatted by hand for a fixed-width column in every locale; local time rather than elapsed, so entries line up with
// builds and hardware logs
export function formatLogTime(at: number): string {
    const when = new Date(at);
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
        + `.${pad(when.getMilliseconds(), 3)}`;
}

// by a line's first word, in rising severity; a line without a prefix is info, as that's what a printf is for
export const LOG_LEVELS = ['info', 'warning', 'error'] as const;

export type LogLevel = typeof LOG_LEVELS[number];

// matches `Warning:`, `warning :` and `WARNING: `; anchored and needs the colon, so `errors: 3` is a count, not an
// error
const LEVEL_PREFIX = /^\s*(info|warning|error)\s*:/i;

export interface LogLine {
    level: LogLevel;
    text: string;
}

// the prefix is cut as it shows as a badge; trimmed afterwards, which also strips the row padding and carriage return
// of output formatted for a fixed-width debug screen
export function splitLogLevel(text: string): LogLine {
    const match = LEVEL_PREFIX.exec(text);
    return {
        level: match ? match[1].toLowerCase() as LogLevel : 'info',
        text: (match ? text.slice(match[0].length) : text).trim(),
    };
}

export function parseLogLevel(text: string): LogLevel {
    return splitLogLevel(text).level;
}
