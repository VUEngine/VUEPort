import type { Sim } from '../browser/core/vb-core';
import { ROM_HEADER_OFFSET_FROM_END, romSizeInMBit } from '../browser/emulator-types';
import { unwrapSaveState, VesEmulatorSaveStateIdentity, wrapSaveState } from '../common/emulator-save-state';
import { VB_DEFAULT_DISPLAY_MODE, VB_MAX_MEMORY_READ } from '../common/vb-constants';
import { last, parseArguments } from './cli/commands';
import { ProbeCliAnswer, ProbeForkRequest, ProbeMoment } from './probe-forks';
import { fromBase64, toBase64, toHex } from './vb-bytes';

/**
 * A tool's way into a running emulator. The live game can only be looked at, paused, saved or loaded, so the player
 * does not feel a tool at work; stopping, stepping and watching happen on forks, copies driven by the same commands as
 * `vbprobe` in their own worker (`probe-forks.ts`). Host-agnostic: VUEPort desktop serves it on a local socket
 * (`desktop-probe.ts`), VUEngine Studio as an agent tool. Disabled in hardcore mode, like the debugger, and while two
 * players are linked.
 */

export interface ProbeTarget {
    name: string;
    sim: Sim;
    romAsRun(): Uint8Array; // with patches and colorizations applied
    elf(): Promise<Uint8Array | undefined>;
    esSoundSnapshot(): unknown;
    esSound: boolean; // whether the game has ESSound tracks, which is when the emulator answers its init
    hardcore: boolean;
    linked: boolean;
    paused: boolean;
    setPaused(paused: boolean): Promise<void>;
}

// `ProbeForkWorker` for forks in a worker
export interface ProbeForkChannel {
    request<T>(request: DistributiveOmit<ProbeForkRequest, 'id'>): Promise<T>;
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

// a command the host answers itself, e.g. VUEngine Studio's `restart`. Answered before checking for a running
// game, so it can start one
export interface ProbeHostCommand {
    usage: string; // as the help shows it, name first: `restart`
    summary: string;
    run(args: string[]): Promise<string>;
}

export interface ProbeSessionOptions {
    app: string; // for answers and errors: `VUEPort`, `VUEngine Studio`
    version: string;
    usage: string; // for the help: `VUEPort --probe-cli`
    wasmUrl(): string; // absolute URL the fork worker fetches the core from
    forks(): ProbeForkChannel;
    quit?(): void; // the host's own way out, if a tool may take it
    commands?: ProbeHostCommand[];
}

export const PROBE_PROTOCOL = 1; // for a tool to check before it relies on a method

const MAX_READ = 0x100000;

export class ProbeSession {

    protected handed?: string; // so the cartridge is handed to the fork worker once per game

    constructor(protected readonly target: () => ProbeTarget | undefined, protected readonly options: ProbeSessionOptions) { }

    // `cli` with a whole command line, or one of the methods underneath: `hello`, `status`, `read`, `registers`,
    // `screenshot`, `pause`, `resume`, `rom`, `elf`, `saveState`, `loadState`, `quit`
    async handle(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        const target = this.target();
        if (method === 'cli') {
            const args = Array.isArray(params.args) ? params.args.map(String) : [];
            const inputs = (params.inputs && typeof params.inputs === 'object' ? params.inputs : {}) as Record<string, string>;
            return this.commandLine(args, inputs);
        }
        if (method === 'hello') {
            return { app: this.options.app, version: this.options.version, protocol: PROBE_PROTOCOL };
        }
        if (method === 'quit') {
            if (!this.options.quit) {
                throw new Error(`${this.options.app} is not quit from here.`);
            }
            // after this answer has left, as the host is about to go
            const quit = this.options.quit;
            setTimeout(() => quit(), 100);
            return { quitting: true };
        }
        if (method === 'status') {
            return target
                ? { rom: target.name, paused: target.paused, hardcore: target.hardcore, linked: target.linked, vbc: target.sim.isVbcHardware }
                : { rom: null };
        }
        const game = this.admitted(target);

        switch (method) {
            case 'read': {
                const address = whole(params.address, 'address') >>> 0;
                const length = whole(params.length, 'length');
                if (length < 1 || length > MAX_READ) {
                    throw new Error(`length has to be 1 to ${MAX_READ}.`);
                }
                const bytes = new Uint8Array(length);
                for (let at = 0; at < length; at += VB_MAX_MEMORY_READ) {
                    const part = Math.min(VB_MAX_MEMORY_READ, length - at);
                    bytes.set(new Uint8Array(await game.sim.readMemory((address + at) >>> 0, part)), at);
                }
                return { address, bytes: toHex(bytes) };
            }
            case 'registers':
                return game.sim.readRegisters();
            case 'screenshot': {
                // as the player sees it, or the plain left eye a tool can compare with its own picture
                const plain = params.as === 'left';
                const png = await game.sim.capture(plain ? VB_DEFAULT_DISPLAY_MODE : undefined, 1);
                return { png: toBase64(new Uint8Array(png)) };
            }
            case 'pause':
                await game.setPaused(true);
                return { paused: true };
            case 'resume':
                await game.setPaused(false);
                return { paused: false };
            case 'rom':
                return { name: game.name, bytes: toBase64(game.romAsRun()), vbc: game.sim.isVbcHardware };
            case 'elf': {
                const elf = await game.elf();
                return { bytes: elf ? toBase64(elf) : null };
            }
            case 'saveState': {
                const state = await game.sim.saveState();
                const thumbnail = await game.sim.capture(VB_DEFAULT_DISPLAY_MODE, 1);
                const file = await wrapSaveState([state], identityOf(game.romAsRun()), game.esSoundSnapshot(), {
                    kind: 'manual', created: Date.now(), label: 'probe', thumbnail: new Uint8Array(thumbnail), romName: game.name,
                });
                return { vess: toBase64(file) };
            }
            case 'loadState': {
                if (typeof params.vess !== 'string') {
                    throw new Error('loadState needs vess, a save state file in base64.');
                }
                const { states, otherRom } = await unwrapSaveState(fromBase64(params.vess), 1, identityOf(game.romAsRun()),
                    { otherRom: params.otherRom === true });
                await game.sim.loadState(states[0], { clearCaches: otherRom });
                return { loaded: true };
            }
            default:
                throw new Error(`Unknown method "${method}".`);
        }
    }

    // commands about the game itself are answered here, the rest go to the forks, with a copy of this moment
    // unless `--fork` names a kept fork. Files arrive in `inputs` (by their named path) and leave in `outputs`;
    // the host decides where they are read and written
    async commandLine(args: string[], inputs: Record<string, string> = {}): Promise<ProbeCliAnswer> {
        const app = this.options.app;
        const options = parseArguments(args);
        const [command, ...rest] = options.positional;
        const answer = (text: string, outputs: Record<string, string> = {}): ProbeCliAnswer => ({ text, code: 0, outputs });
        const input = (path: string | undefined, what: string): Uint8Array => {
            if (path === undefined) {
                throw new Error(`${command} needs ${what}.`);
            }
            if (inputs[path] === undefined) {
                throw new Error(`${app} cannot read ${path}; name a file that exists.`);
            }
            return fromBase64(inputs[path]);
        };
        const output = (path: string | undefined, what: string): string => {
            if (path === undefined) {
                throw new Error(`${command} needs ${what}.`);
            }
            return path;
        };

        switch (command) {
            case undefined:
            case 'help':
                return this.options.forks().request<ProbeCliAnswer>({ op: 'cli', args: ['help'], inputs: {}, help: this.liveHelp(), app });
            case 'status': {
                const status = await this.handle('status') as { rom: string | null, paused?: boolean, vbc?: boolean, hardcore?: boolean, linked?: boolean };
                if (status.rom === null) {
                    return answer(`${app} ${this.options.version}: no game running`);
                }
                return answer(`${app} ${this.options.version}: ${status.rom}${status.vbc ? ' on a VB Color' : ''}, ${status.paused ? 'paused' : 'running'}`
                    + `${status.hardcore ? ', in hardcore mode (the probe stays out)' : ''}${status.linked ? ', linked (the probe stays out)' : ''}`);
            }
            case 'quit':
                await this.handle('quit');
                return answer(`${app} is quitting`);
        }
        const own = this.options.commands?.find(entry => entry.usage.split(' ')[0] === command);
        if (own) {
            return answer(await own.run(rest));
        }

        const game = this.admitted(this.target());
        switch (command) {
            case 'pause':
            case 'resume':
                await game.setPaused(command === 'pause');
                return answer(command === 'pause' ? 'paused' : 'running');
            case 'capture': {
                const file = output(rest[0], 'a file to write the picture to');
                const { png } = await this.handle('screenshot') as { png: string };
                return answer(`wrote ${file}`, { [file]: png });
            }
            case 'save': {
                const file = output(rest[0], 'a file to write the save state to');
                const { vess } = await this.handle('saveState') as { vess: string };
                return answer(`wrote ${file}`, { [file]: vess });
            }
            case 'load': {
                const file = rest[0];
                await this.handle('loadState', {
                    vess: toBase64(input(file, 'a save state file')),
                    otherRom: options.flags.has('other-rom'),
                });
                return answer(`loaded ${file}`);
            }
            case 'export': {
                const dir = output(rest[0], 'a folder to write to').replace(/[\\/]+$/, '');
                const stem = game.name.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '_') || 'game';
                const outputs: Record<string, string> = {
                    [`${dir}/${stem}.vb`]: toBase64(game.romAsRun()),
                    [`${dir}/state.vess`]: (await this.handle('saveState') as { vess: string }).vess,
                };
                const elf = await game.elf();
                if (elf) {
                    outputs[`${dir}/${stem}.elf`] = toBase64(elf);
                }
                const hardware = game.sim.isVbcHardware ? 'vbc' : 'vb';
                return answer([
                    ...Object.keys(outputs).map(path => `wrote ${path}`),
                    '',
                    'for vbprobe, for example:',
                    `  vbprobe regs ${dir}/${stem}.vb --state-in ${dir}/state.vess --hardware ${hardware}${elf ? ` --elf ${dir}/${stem}.elf` : ''}`,
                ].join('\n'), outputs);
            }
            case 'fork': {
                const from = last(options, 'from');
                if (from !== undefined) {
                    return answer(await this.options.forks().request<string>({ op: 'fork', name: rest[0], from }));
                }
                await this.handBase(game);
                return answer(await this.options.forks().request<string>({ op: 'fork', name: rest[0], moment: await momentOf(game) }));
            }
            case 'forks':
                return answer(await this.options.forks().request<string>({ op: 'forks' }));
            case 'drop':
                return answer(await this.options.forks().request<string>({ op: 'drop', name: output(rest[0], 'the name of a fork') }));
        }

        await this.handBase(game);
        const moment = options.values.has('fork') ? undefined : await momentOf(game);
        return this.options.forks().request<ProbeCliAnswer>({ op: 'cli', args, inputs, moment, help: this.liveHelp(), app });
    }

    protected liveHelp(): string {
        const { app, usage } = this.options;
        const own = (this.options.commands ?? []).map(entry => `  ${entry.usage.padEnd(24)}  ${entry.summary}\n`).join('');
        return `${usage} — the game being played, for a tool or an AI agent

usage: ${usage} <command> [arguments] [options]

the game itself
  status                    what is running, and whether it is paused
  pause | resume
  capture <file.png>        the screen as the player sees it
  save <file.vess>          this moment, as a save state ${app} also loads
  load <file.vess>          put a moment back; --other-rom for one of
                            another build of the game
  export <dir>              the cartridge as it runs, this moment and the .elf,
                            for vbprobe
${own}${this.options.quit ? `  quit                      quit ${app}, saves written first\n` : ''}
forks — the game's machine copied, to stop and step without the player noticing
  fork [name]               copy this moment into a fork that stays;
                            --from <fork> copies that fork as it stands instead
  forks                     the forks there are
  drop <name>               let one go

  Every other command works on a fork: the one --fork <name> names, or a
  fresh copy of this moment, thrown away after. Names come from the build's
  .elf, when there is one.

`;
    }

    // throws the reason when a tool may not touch the game now
    protected admitted(target: ProbeTarget | undefined): ProbeTarget {
        if (!target) {
            throw new Error('No game is running.');
        }
        if (target.hardcore) {
            throw new Error('The game is in hardcore mode, which keeps the probe out the same as the debugger.');
        }
        if (target.linked) {
            throw new Error('Two players are linked; their machines have to stay in step, so the probe leaves them alone.');
        }
        return target;
    }

    // hands the forks the cartridge as run plus the build's names when they changed; keyed by the bytes, as a
    // patch changes the cartridge without changing its name
    protected async handBase(game: ProbeTarget): Promise<void> {
        const rom = game.romAsRun();
        const key = `${game.name}:${rom.length}:${digest(rom)}:${game.sim.isVbcHardware}:${game.esSound}`;
        if (key === this.handed) {
            return;
        }
        const elf = await game.elf();
        await this.options.forks().request({
            op: 'base', key, rom: rom.slice().buffer, elf: elf?.slice().buffer, vbc: game.sim.isVbcHardware, esSound: game.esSound,
            wasmUrl: this.options.wasmUrl(),
        });
        this.handed = key;
    }
}

// the forks behind a worker running `probe-fork-worker.ts`
export class ProbeForkWorker implements ProbeForkChannel {

    protected next = 1;
    protected readonly waiting = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>();

    constructor(protected readonly worker: Worker) {
        worker.onmessage = event => {
            const { id, result, error } = event.data as { id: number, result?: unknown, error?: string };
            const waiting = this.waiting.get(id);
            this.waiting.delete(id);
            if (error !== undefined) {
                waiting?.reject(new Error(error));
            } else {
                waiting?.resolve(result);
            }
        };
        worker.onerror = event => {
            for (const waiting of this.waiting.values()) {
                waiting.reject(new Error(`The fork worker failed: ${event.message}`));
            }
            this.waiting.clear();
        };
    }

    request<T>(request: DistributiveOmit<ProbeForkRequest, 'id'>): Promise<T> {
        const id = this.next++;
        return new Promise<T>((resolve, reject) => {
            this.waiting.set(id, { resolve: value => resolve(value as T), reject });
            this.worker.postMessage({ ...request, id });
        });
    }

    dispose(): void {
        this.worker.terminate();
    }
}

async function momentOf(game: ProbeTarget): Promise<ProbeMoment> {
    const info = await game.sim.cartRamInfo();
    return {
        state: await game.sim.saveState(),
        sram: info.size > 0 ? await game.sim.getCartRam(info.used) : new ArrayBuffer(0),
        sramWindow: info.size > 0 ? info.size : 0x4000,
    };
}

// bound to the cartridge as run, patches and all, so `export`ed states load into a machine given the same cartridge
function identityOf(rom: Uint8Array): VesEmulatorSaveStateIdentity {
    const at = rom.length - ROM_HEADER_OFFSET_FROM_END;
    return { romIdentity: rom.slice(at, at + 32), romSize: romSizeInMBit(rom) };
}

// FNV-1a over a sample of the bytes: enough to tell two cartridges apart, quick on sixteen megabytes
function digest(bytes: Uint8Array): string {
    let hash = 0x811c9dc5;
    const step = Math.max(1, Math.floor(bytes.length / 65536));
    for (let i = 0; i < bytes.length; i += step) {
        hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
    }
    return hash.toString(16);
}

function whole(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${name} has to be a whole number.`);
    }
    return value;
}
