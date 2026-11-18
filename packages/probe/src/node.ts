import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { VbMachine, VbMachineOptions } from 'vueport-core/lib/probe/vb-machine';

// Node's way in: the core read from vueport-core's own copy, and files by path. Kept apart so the library runs
// anywhere a WebAssembly module does (the app's webview, VUEngine Studio)

export function readCoreWasm(): Uint8Array {
    const core = dirname(require.resolve('vueport-core/package.json'));
    return readFileSync(join(core, 'wasm', 'shrooms', 'core.wasm'));
}

export interface VbMachineFiles extends Omit<VbMachineOptions, 'core' | 'rom' | 'sram' | 'elf'> {
    rom: string | Uint8Array;
    sram?: string | Uint8Array;
    elf?: string | Uint8Array;
}

export function openMachine(files: VbMachineFiles): Promise<VbMachine> {
    const { rom, sram, elf, ...rest } = files;
    const bytes = (file: string | Uint8Array): Uint8Array => (typeof file === 'string' ? readFileSync(file) : file);
    return VbMachine.create({
        ...rest,
        core: readCoreWasm(),
        rom: bytes(rom),
        sram: sram !== undefined ? bytes(sram) : undefined,
        elf: elf !== undefined ? bytes(elf) : undefined,
    });
}
