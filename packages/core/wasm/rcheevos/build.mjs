#!/usr/bin/env node
/**
 * Builds the RetroAchievements engine, `rcheevos.js` + `rcheevos.wasm`.
 *
 * Not run by `yarn build` and not run in CI (see the README one level up for why). Run it by hand, with the Emscripten
 * SDK on `PATH` (https://emscripten.org/docs/getting_started/downloads.html, then `source ./emsdk_env.sh`), whenever
 * `RCHEEVOS_TAG` below is bumped:
 *
 *   node packages/core/wasm/rcheevos/build.mjs
 *
 * It fetches upstream rcheevos at the pinned tag into `rcheevos/upstream/` as a plain shallow clone, not a submodule:
 * this repository has none, and one dependency fetched by a script is less machinery than one Git has to track. It
 * compiles that together with the shim in `rcheevos/shim/` and writes the two output files beside this script. Both are
 * committed like `shrooms/core.wasm`: a vendored build artifact, not something every checkout regenerates.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// bump this, delete `upstream/` and rerun to pick up a new rcheevos release
const RCHEEVOS_TAG = 'v12.4.0';
const RCHEEVOS_REPO = 'https://github.com/RetroAchievements/rcheevos.git';
const RCHEEVOS_DIR = path.join(__dirname, 'upstream');
const SHIM_DIR = path.join(__dirname, 'shim');
const OUT_JS = path.join(__dirname, 'rcheevos.js');
const OUT_WASM = path.join(__dirname, 'rcheevos.wasm');

function run(command, args, options = {}) {
    console.log(`$ ${command} ${args.join(' ')}`);
    execFileSync(command, args, { stdio: 'inherit', ...options });
}

function ensureSource() {
    if (existsSync(path.join(RCHEEVOS_DIR, 'include', 'rc_client.h'))) {
        return;
    }
    run('git', [
        'clone', '--depth', '1', '--branch', RCHEEVOS_TAG, RCHEEVOS_REPO, RCHEEVOS_DIR,
    ]);
}

function cFilesIn(...relativeDirs) {
    const dir = path.join(RCHEEVOS_DIR, ...relativeDirs);
    return readdirSync(dir)
        .filter(name => name.endsWith('.c'))
        .map(name => path.join(dir, name));
}

function build() {
    // everything rc_client needs except the rest of src/rhash (disc readers, file hashing): VUEPort hashes the game
    // itself in emulator-md5.ts. md5.c stays, as rapi and runtime hash their own payloads with it
    const sources = [
        ...cFilesIn('src', 'rapi'),
        ...cFilesIn('src', 'rcheevos'),
        path.join(RCHEEVOS_DIR, 'src', 'rhash', 'md5.c'),
        path.join(RCHEEVOS_DIR, 'src', 'rc_client.c'),
        path.join(RCHEEVOS_DIR, 'src', 'rc_compat.c'),
        path.join(RCHEEVOS_DIR, 'src', 'rc_util.c'),
        path.join(RCHEEVOS_DIR, 'src', 'rc_version.c'),
        path.join(SHIM_DIR, 'vueport-rc.c'),
    ];

    const exportedFunctions = [
        '_malloc', '_free',
        '_vrc_create', '_vrc_destroy',
        '_vrc_begin_login_password', '_vrc_begin_login_token', '_vrc_logout',
        '_vrc_begin_load_game', '_vrc_unload_game', '_vrc_reset', '_vrc_set_hardcore',
        '_vrc_do_frame', '_vrc_idle', '_vrc_provide_response',
        '_vrc_begin_fetch_leaderboard_entries',
    ];
    // HEAPU8 so vb-rcheevos.ts can write bytes into the module's heap from its read-memory hook; the rest marshal
    // strings
    const exportedRuntimeMethods = ['cwrap', 'UTF8ToString', 'stringToUTF8', 'lengthBytesUTF8', 'HEAPU8'];

    run('emcc', [
        '-O2',
        '-I', path.join(RCHEEVOS_DIR, 'include'),
        ...sources,
        '--js-library', path.join(SHIM_DIR, 'vueport-rc-lib.js'),
        // MODULARIZE without EXPORT_ES6: a plain script defining a global `createVueportRc`, as the classic emulator
        // worker loads it with importScripts; tsc's CommonJS output would turn an import() into a require() that throws
        // in the browser
        '-sMODULARIZE=1',
        '-sEXPORT_NAME=createVueportRc',
        '-sENVIRONMENT=worker',
        '-sALLOW_MEMORY_GROWTH=1',
        `-sEXPORTED_FUNCTIONS=${JSON.stringify(exportedFunctions)}`,
        `-sEXPORTED_RUNTIME_METHODS=${JSON.stringify(exportedRuntimeMethods)}`,
        '-o', OUT_JS,
    ]);
}

ensureSource();
build();
console.log(`\nWrote ${path.relative(__dirname, OUT_JS)} and ${path.relative(__dirname, OUT_WASM)}.`);
