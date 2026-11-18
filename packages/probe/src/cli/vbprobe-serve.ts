import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { VbMachine } from 'vueport-core/lib/probe/vb-machine';
import { CliHost, CliOptions, last, parseArguments, runCommand } from 'vueport-core/lib/probe/cli/commands';
import { splitCommandLine } from 'vueport-core/lib/probe/probe-command-line';

// vbprobe serve: one long-lived process for scripts asking many small questions. Each stdin line is JSON
// ({"id": 1, "args": [...]}) or a command line, answered in order by a JSON line with code and text ("json" for
// --json, or "error"). Forks are the machines that stay; without --fork a command gets a fresh one

export const SERVE_HELP = `serve
  vbprobe serve <rom.vb> [--elf …] [--sram …] [--hardware …] [--essound]
                            stay running and answer requests from standard
                            input, a line each: JSON {"id": 1, "args": [...]}
                            or a command line as typed after vbprobe, without
                            the ROM. Each is answered on standard output with
                            a line of JSON: {"id", "code", "text"}, "json"
                            for the report of a command given --json, or
                            {"id", "error"}. Besides the commands:
    fork <name>             a machine that stays, powered on; --from <fork>
                            copies one as it stands, --state-in loads a moment
    forks                   the forks there are
    drop <name>             let one go
    quit                    stop (as does the end of the input)
  Commands carry on with a fork given --fork <name>; without, each gets a
  machine of its own, just powered on.
`;

export interface ServeMachine {
    open(): Promise<VbMachine>;
}

interface ServeRequest {
    id: unknown;
    args: string[];
}

export class VbProbeServer {

    protected readonly forks = new Map<string, VbMachine>();

    constructor(protected readonly machine: ServeMachine, protected readonly help: string) { }

    // undefined for a blank line, quit when it is time to stop
    async answer(line: string): Promise<Record<string, unknown> | 'quit' | undefined> {
        if (line.trim() === '') {
            return undefined;
        }
        let request: ServeRequest;
        try {
            request = parseRequest(line);
        } catch (error) {
            return { id: null, error: messageOf(error) };
        }
        if (request.args[0] === 'quit') {
            return 'quit';
        }
        try {
            const own = await this.ownCommand(request.args);
            if (own !== undefined) {
                return { id: request.id, code: 0, text: own };
            }
            const result = await runCommand(request.args, this.host());
            // asked for as data, it goes as data, not as a string of it
            return request.args.includes('--json')
                ? { id: request.id, code: result.code, json: JSON.parse(result.text) }
                : { id: request.id, code: result.code, text: result.text };
        } catch (error) {
            return { id: request.id, error: messageOf(error) };
        }
    }

    // the commands about forks, which only the server has; undefined for any other
    protected async ownCommand(args: string[]): Promise<string | undefined> {
        const command = args[0];
        if (command !== 'fork' && command !== 'forks' && command !== 'drop') {
            return undefined;
        }
        const options = parseArguments(args);
        const name = options.positional[1];
        switch (command) {
            case 'forks':
                return this.forks.size === 0
                    ? 'no forks'
                    : [...this.forks].map(([fork, machine]) => `${fork}  frame ${machine.frame}  pc ${machine.describe(machine.pc)}`).join('\n');
            case 'drop':
                if (name === undefined || !this.forks.delete(name)) {
                    throw new Error(name === undefined ? 'drop needs the name of a fork.' : `There is no fork called ${name}.`);
                }
                return `dropped ${name}`;
        }
        if (name === undefined || !/^[\w.-]{1,32}$/.test(name)) {
            throw new Error(name === undefined ? 'fork needs a name.' : `"${name}" is not a fork name; use letters, digits, dots and dashes.`);
        }
        if (this.forks.has(name)) {
            throw new Error(`There is already a fork called ${name}.`);
        }
        const from = last(options, 'from');
        let vb: VbMachine;
        if (from !== undefined) {
            const source = this.forks.get(from);
            if (!source) {
                throw new Error(`There is no fork called ${from}.`);
            }
            vb = await source.clone();
        } else {
            vb = await this.machine.open();
        }
        const stateIn = last(options, 'state-in');
        if (stateIn !== undefined) {
            await vb.loadState(readFileSync(stateIn), { otherRom: options.flags.has('other-rom') });
        }
        this.forks.set(name, vb);
        const what = from !== undefined ? `a copy of ${from}` : stateIn !== undefined ? `the moment in ${stateIn}` : 'powered on';
        return `${name}: ${what}, standing at ${vb.describe(vb.pc)} in frame ${vb.frame}`;
    }

    protected host(): CliHost {
        return {
            help: this.help,
            open: async (options: CliOptions, positional: string[]) => {
                for (const option of ['elf', 'sram', 'hardware']) {
                    if (last(options, option) !== undefined) {
                        throw new Error(`--${option} is given once, when the server starts.`);
                    }
                }
                const name = last(options, 'fork');
                if (name !== undefined) {
                    const vb = this.forks.get(name);
                    if (!vb) {
                        throw new Error(`There is no fork called ${name}. "fork ${name}" makes one.`);
                    }
                    return { vb, rest: positional };
                }
                return { vb: await this.machine.open(), rest: positional };
            },
            read: path => readFileSync(path),
            write: (path, bytes) => writeFileSync(path, bytes),
        };
    }
}

function parseRequest(line: string): ServeRequest {
    const text = line.trim();
    if (!text.startsWith('{')) {
        return { id: null, args: splitCommandLine(text) };
    }
    const request = JSON.parse(text) as { id?: unknown, args?: unknown };
    if (!Array.isArray(request.args) || !request.args.every(arg => typeof arg === 'string')) {
        throw new Error('A request is {"id": …, "args": ["command", …]}.');
    }
    return { id: request.id ?? null, args: request.args };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function serve(server: VbProbeServer): Promise<number> {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
        const answer = await server.answer(line);
        if (answer === 'quit') {
            break;
        }
        if (answer !== undefined) {
            process.stdout.write(`${JSON.stringify(answer)}\n`);
        }
    }
    lines.close();
    return 0;
}
