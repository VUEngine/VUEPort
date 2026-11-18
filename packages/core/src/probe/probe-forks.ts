import { CliHost, COMMANDS_HELP, last, runCommand } from './cli/commands';
import { fromBase64, toBase64 } from './vb-bytes';
import { VbMachine } from './vb-machine';
import { VbSymbols } from './vb-symbols';

/**
 * Forks are copies of the game being played, where a tool can stop, step and watch a machine without the player
 * noticing. Each is a VbMachine running the same commands as vbprobe; the machine is a copy of a moment, and files
 * arrive with the request and leave with the answer. Kept apart from any worker: probe-fork-worker.ts is the worker
 * VUEPort and VUEngine Studio bundle, and probe-session.ts talks to it.
 */

export interface ProbeMoment {
    state: ArrayBuffer;
    sram: ArrayBuffer;
    sramWindow: number;
}

export type ProbeForkRequest =
    | { id: number, op: 'base', key: string, rom: ArrayBuffer, elf?: ArrayBuffer, vbc: boolean, esSound: boolean, wasmUrl: string }
    | { id: number, op: 'fork', name?: string, moment?: ProbeMoment, from?: string }
    | { id: number, op: 'cli', args: string[], inputs: Record<string, string>, moment?: ProbeMoment, help: string, app: string }
    | { id: number, op: 'drop', name: string }
    | { id: number, op: 'forks' };

export interface ProbeCliAnswer {
    text: string;
    code: number;
    outputs: Record<string, string>; // the files it wrote, as base64
}

export const FORK_HELP = `${COMMANDS_HELP}
forks
  --fork <name>             work on a fork that stays, so the next command
                            carries on where this one left off
`;

// the cartridge every fork is made of, kept between requests as it does not change while a game runs
interface Base {
    key: string;
    rom: Uint8Array;
    symbols?: VbSymbols;
    vbc: boolean;
    esSound: boolean;
}

export class ProbeForks {

    protected core?: Uint8Array;
    protected base?: Base;
    protected readonly forks = new Map<string, VbMachine>();

    async handle(request: ProbeForkRequest): Promise<unknown> {
        switch (request.op) {
            case 'base': {
                if (!this.core) {
                    const response = await fetch(request.wasmUrl);
                    this.core = new Uint8Array(await response.arrayBuffer());
                }
                const rom = new Uint8Array(request.rom);
                this.base = {
                    key: request.key,
                    rom,
                    symbols: request.elf ? VbSymbols.fromElf(new Uint8Array(request.elf), rom.length) : undefined,
                    vbc: request.vbc,
                    esSound: request.esSound,
                };
                // forks of another game are of no use to anybody now
                this.forks.clear();
                return { key: request.key };
            }
            case 'fork': {
                const name = request.name ?? this.nextName();
                if (!/^[\w.-]{1,32}$/.test(name)) {
                    throw new Error(`"${name}" is not a fork name; use letters, digits, dots and dashes.`);
                }
                if (this.forks.has(name)) {
                    throw new Error(`There is already a fork called ${name}.`);
                }
                if (request.from !== undefined) {
                    const from = this.forks.get(request.from);
                    if (!from) {
                        throw new Error(`There is no fork called ${request.from}.`);
                    }
                    const copy = await from.clone();
                    this.forks.set(name, copy);
                    return `${name}: a copy of ${request.from}, standing at ${copy.describe(copy.pc)} in frame ${copy.frame}`;
                }
                if (!request.moment) {
                    throw new Error('No moment to copy.');
                }
                const vb = await this.machineOf(request.moment);
                this.forks.set(name, vb);
                return `${name}: a copy of this moment, standing at ${vb.describe(vb.pc)}`;
            }
            case 'forks':
                return this.forks.size === 0
                    ? 'no forks'
                    : [...this.forks].map(([name, vb]) => `${name}  frame ${vb.frame}  pc ${vb.describe(vb.pc)}`).join('\n');
            case 'drop':
                if (!this.forks.delete(request.name)) {
                    throw new Error(`There is no fork called ${request.name}.`);
                }
                return `dropped ${request.name}`;
            case 'cli':
                return this.commandLine(request);
        }
    }

    protected async commandLine(request: Extract<ProbeForkRequest, { op: 'cli' }>): Promise<ProbeCliAnswer> {
        const outputs: Record<string, string> = {};
        const host: CliHost = {
            help: request.help + FORK_HELP,
            open: async (options, positional) => {
                for (const option of ['elf', 'sram', 'hardware']) {
                    if (last(options, option) !== undefined) {
                        throw new Error(`--${option} is ${request.app}'s business here: a fork is the game as it is running.`);
                    }
                }
                const name = last(options, 'fork');
                if (name !== undefined) {
                    const fork = this.forks.get(name);
                    if (!fork) {
                        throw new Error(`There is no fork called ${name}. "fork ${name}" makes one.`);
                    }
                    return { vb: fork, rest: positional };
                }
                if (!request.moment) {
                    throw new Error('No moment to copy.');
                }
                return { vb: await this.machineOf(request.moment), rest: positional };
            },
            read: path => {
                const bytes = request.inputs[path];
                if (bytes === undefined) {
                    throw new Error(`${request.app} cannot read ${path}; name a file that exists.`);
                }
                return fromBase64(bytes);
            },
            write: (path, bytes) => {
                outputs[path] = toBase64(bytes);
            },
        };
        const result = await runCommand(request.args, host);
        return { ...result, outputs };
    }

    protected async machineOf(moment: ProbeMoment): Promise<VbMachine> {
        if (!this.core || !this.base) {
            throw new Error('The game has not been handed over yet.');
        }
        const vb = await VbMachine.create({
            core: this.core,
            rom: this.base.rom,
            symbols: this.base.symbols,
            hardware: this.base.vbc ? 'vbc' : 'vb',
            // answered as the emulator answers it, so that a fork of a game with ESSound does not sit waiting for its
            // cartridge
            esSound: this.base.esSound,
            sram: new Uint8Array(moment.sram),
            sramWindow: moment.sramWindow,
        });
        vb.loadStruct(new Uint8Array(moment.state));
        return vb;
    }

    protected nextName(): string {
        for (let n = 1; ; n++) {
            if (!this.forks.has(`fork${n}`)) {
                return `fork${n}`;
            }
        }
    }
}
