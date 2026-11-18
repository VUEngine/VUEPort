#!/usr/bin/env node
/**
 * Builds the Shrooms core from a checkout and installs it here as core.wasm.
 *
 *   source /path/to/emsdk/emsdk_env.sh     # emcc on PATH
 *   node packages/core/wasm/shrooms/build-vbc.mjs /path/to/shrooms-vb-core
 *
 * The C is checked first with `make core` and `make util` (gcc and emcc under -Werror), then `make wasm` builds the
 * module. It is installed only if it has every export VUEPort uses and reports VB Color 1.0. The build is
 * reproducible: rebuilding unchanged sources matches the installed file's printed hash.
 */
import { createHash } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!source) {
    console.error('usage: node packages/core/wasm/shrooms/build-vbc.mjs /path/to/shrooms-vb-core');
    process.exit(2);
}
if (!existsSync(resolve(source, 'makefile')) || !existsSync(resolve(source, 'web/wasm.c'))) {
    console.error(`${source} is not a Shrooms core checkout (no makefile and web/wasm.c).`);
    process.exit(2);
}

for (const [tool, hint] of [
    ['emcc', 'Emscripten is not on PATH; source emsdk_env.sh from your emsdk first.'],
    ['gcc', 'gcc is not on PATH; `make core` and `make util` compile with it.'],
]) {
    if (spawnSync(tool, ['--version'], { stdio: 'ignore' }).status !== 0) {
        console.error(hint);
        process.exit(1);
    }
}

for (const target of ['core', 'util', 'wasm']) {
    console.log(`make ${target}`);
    const step = spawnSync('make', [target], { cwd: source, stdio: 'inherit' });
    if (step.status !== 0) {
        console.error(`make ${target} failed; nothing was installed.`);
        process.exit(step.status ?? 1);
    }
}

const built = resolve(source, 'web/core.wasm');
const bytes = await readFile(built);
const module = await WebAssembly.compile(bytes);
const exports = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
const required = [
    'GetColorPixels',
    'GetExtColorPixels',
    'GetVideoFormat',
    'SetHardwareMode',
    'GetHardwareMode',
    'vbGetColorEnabled',
    'vbGetColorPixels',
    // the measured display timing, see vbGetColumnLengths in vb-wasm.ts
    'vbGetColumnLengths',
    'vbGetCounter',
    'vbResetCounters',
    // debugging: breakpoints, watches and vueport-probe's call stack
    'vbSetExecuteCallback',
    'vbSetReadCallback',
    'vbSetWriteCallback',
    'vbSetExceptionCallback',
    'Disassemble',
    'vbGetDisplayedBuffer',
    'vbSetPixelOrigins',
    'vbSizeOfPixelOrigins',
    'CreateSim',
    'vbRead',
];
const missing = required.filter(name => !exports.has(name));
if (missing.length) {
    console.error(`built core is missing exports: ${missing.join(', ')}; nothing was installed.`);
    process.exit(1);
}

// reject a core from an earlier draft (VBCVER 0x0101 or older) even if it exposes the same transport helpers; VB_U16 is
// data type 3
const instance = await WebAssembly.instantiate(module, {
    env: { emscripten_notify_memory_growth() {} },
});
const runtime = instance.exports;
runtime._initialize?.();
const sim = runtime.CreateSim();
const id0 = runtime.vbRead(sim, 0x0307F800, 3) & 0xffff;
const id1 = runtime.vbRead(sim, 0x0307F802, 3) & 0xffff;
const version = runtime.vbRead(sim, 0x0307F804, 3) & 0xffff;
if (id0 !== 0x4256 || id1 !== 0x2143 || version !== 0x0100) {
    console.error(
        `built core is not VBC 1.0 (ID=${id0.toString(16)}/${id1.toString(16)}, `
        + `VBCVER=${version.toString(16)}); nothing was installed.`
    );
    process.exit(1);
}

const destination = resolve(here, 'core.wasm');
const sha1 = data => createHash('sha1').update(data).digest('hex');
const before = existsSync(destination) ? sha1(await readFile(destination)) : 'none';
await copyFile(built, destination);
const after = sha1(bytes);
console.log(`installed VBC Shrooms core: ${destination}`);
console.log(before === after
    ? `  unchanged (sha1 ${after})`
    : `  sha1 ${before} → ${after}`);
