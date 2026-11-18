import { readFileSync, writeFileSync } from 'fs';
import { openMachine, readCoreWasm } from '../node';
import { VbMachine } from 'vueport-core/lib/probe/vb-machine';
import { VbSymbols } from 'vueport-core/lib/probe/vb-symbols';
import { CliHost, CliOptions, COMMANDS_HELP, last, parseArguments, runCommand } from 'vueport-core/lib/probe/cli/commands';
import { serve, SERVE_HELP, VbProbeServer } from './vbprobe-serve';

const HELP = `vbprobe — a Virtual Boy without a UI, for scripts and AI agents

usage: vbprobe <command> <rom.vb> [arguments] [options]

${COMMANDS_HELP}
machine
  --elf <file>              the build's .elf, for names and source lines
  --sram <file>             Game Pak RAM to start with
  --hardware <vb|vbc|auto>  console model (default auto, from the ROM header)
  --essound                 the cartridge has ESSound: its init is answered
                            with a Game Pak interrupt, as the app does

${SERVE_HELP}
the running app
  The same commands run on the game being played, by the VUEPort desktop app
  itself: VUEPort --probe-cli <command>. See packages/probe/PROBE.md.
`;

// the terminal's host: the ROM named on the command line, and real files
const NODE_HOST: CliHost = {
    help: HELP,
    async open(options, positional): Promise<{ vb: VbMachine, rest: string[] }> {
        const [rom, ...rest] = positional;
        if (rom === undefined) {
            throw new Error('This needs a ROM: vbprobe <command> <rom.vb> ….');
        }
        if (last(options, 'fork') !== undefined) {
            throw new Error('--fork is for a fork that stays: in vbprobe serve, or in the running app (VUEPort --probe-cli … --fork <name>).');
        }
        const vb = await openMachine({
            rom,
            elf: last(options, 'elf'),
            sram: last(options, 'sram'),
            hardware: hardwareOf(options),
            esSound: options.flags.has('essound'),
        });
        return { vb, rest };
    },
    read: path => readFileSync(path),
    write: (path, bytes) => writeFileSync(path, bytes),
};

function hardwareOf(options: CliOptions): 'vb' | 'vbc' | 'auto' {
    const hardware = last(options, 'hardware') ?? 'auto';
    if (!['vb', 'vbc', 'auto'].includes(hardware)) {
        throw new Error('--hardware is vb, vbc or auto.');
    }
    return hardware as 'vb' | 'vbc' | 'auto';
}

// vbprobe serve <rom.vb>: files are read once, and a machine is made from them for each request that wants one
function startServer(args: string[]): Promise<number> {
    const options = parseArguments(args);
    const [, rom, ...rest] = options.positional;
    if (rom === undefined || rest.length > 0) {
        throw new Error('usage: vbprobe serve <rom.vb> [--elf …] [--sram …] [--hardware …] [--essound]');
    }
    const core = readCoreWasm();
    const romBytes = readFileSync(rom);
    const elf = last(options, 'elf');
    const symbols = elf !== undefined ? VbSymbols.fromElf(readFileSync(elf), romBytes.length) : undefined;
    const sram = last(options, 'sram');
    const sramBytes = sram !== undefined ? readFileSync(sram) : undefined;
    const hardware = hardwareOf(options);
    const esSound = options.flags.has('essound');
    return serve(new VbProbeServer({
        open: () => VbMachine.create({ core, rom: romBytes, symbols, sram: sramBytes, hardware, esSound }),
    }, HELP));
}

export async function main(args: string[]): Promise<number> {
    if (args[0] === 'serve') {
        return startServer(args);
    }
    const result = await runCommand(args, NODE_HOST);
    process.stdout.write(`${result.text}\n`);
    return result.code;
}
