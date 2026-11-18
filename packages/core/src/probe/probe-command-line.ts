// command line handling a host has to do itself: splitting the line into arguments and finding which ones name
// files. The desktop client (probe.rs) and VUEngine Studio's `emulator` tool follow the same rules, so a command
// line means the same in both

export const MAX_PROBE_INPUT = 4 * 1024 * 1024;

// split as a shell does: spaces separate, quotes keep together, a backslash takes the next character as is
// (outside single quotes)
export function splitCommandLine(line: string): string[] {
    const args: string[] = [];
    let current = '';
    let started = false;
    let quote: '"' | '\'' | undefined;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) {
                quote = undefined;
            } else if (c === '\\' && quote === '"' && i + 1 < line.length) {
                current += line[++i];
            } else {
                current += c;
            }
        } else if (c === '"' || c === '\'') {
            quote = c;
            started = true;
        } else if (c === '\\' && i + 1 < line.length) {
            current += line[++i];
            started = true;
        } else if (/\s/.test(c)) {
            if (started) {
                args.push(current);
                current = '';
                started = false;
            }
        } else {
            current += c;
            started = true;
        }
    }
    if (quote) {
        throw new Error(`A ${quote} is not closed.`);
    }
    if (started) {
        args.push(current);
    }
    return args;
}

// the path an argument may name: the value of `--option=path`, the file of a frame's `300:shot.png`, or the
// argument itself. A host accepts files back only under the paths a command line named
export function namedPath(arg: string): string {
    if (arg.startsWith('--')) {
        const equals = arg.indexOf('=');
        if (equals >= 0) {
            return arg.slice(equals + 1);
        }
    }
    const colon = arg.indexOf(':');
    if (colon > 0 && /^\d+$/.test(arg.slice(0, colon))) {
        return arg.slice(colon + 1);
    }
    return arg;
}
