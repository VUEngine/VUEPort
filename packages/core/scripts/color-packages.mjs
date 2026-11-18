#!/usr/bin/env node
/**
 * VUEPort does not ship VB Color packages (.vbcpkg) inside the app. They live on a host of their own
 * (packages.vueport.net, deployed with `yarn deploy:packages`) and are fetched when the color editor opens one. This
 * script prepares the files in the repository's data/color-packages for that (<game>.vbcpkg, or <game>-<variant>.vbcpkg
 * for a variant, e.g. golf-japan.vbcpkg) and writes the list the app finds them by:
 *
 *   node packages/core/scripts/color-packages.mjs [--check]
 *
 * - A package still in gzip (as the VB Patches tools write it) or plain JSON is brotli-compressed at the highest
 *   standard setting (quality 11, 16 MiB window). That is about a fifth of gzip's size: Bound High goes from 12 MB to
 *   2.3 MB.
 * - A package whose runtime BPS is byte for byte a BPS the app ships in data/patches (Hyper Fighting, where the build
 *   is the runtime) carries only that BPS's SHA-256 (runtime.bpsSha256). The editor fills it in from the shipped BPS.
 * - src/common/vb-color-package-files.ts lists, per package (keyed by its path in the patch database), the file on the
 *   host, its SHA-256 and size, and the shipped BPS it needs, if any. Host files are named by their content
 *   (<name>-<sha256, 8 hex>.vbcpkg), so a published file never changes and every build of the app finds its own.
 *
 * --check changes nothing and exits with 1 when a package is not ready or the list is out of date.
 * VB Patches' sync-vueport.mjs runs this script after copying packages over and uses shippedColorPackage to compare.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const core = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(core, '..', '..', 'data');
export const PACKAGES = path.join(DATA, 'color-packages');
const PATCHES = path.join(DATA, 'patches');
const LIST = path.join(core, 'src', 'common', 'vb-color-package-files.ts');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// 'gzip', 'json' or 'brotli'; brotli has no magic number, so it is whatever is neither
export function packageEncoding(bytes) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        return 'gzip';
    }
    let at = 0;
    while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x0a || bytes[at] === 0x0d || bytes[at] === 0x09)) {
        at++;
    }
    return bytes[at] === 0x7b ? 'json' : 'brotli';
}

export function packageText(bytes) {
    const encoding = packageEncoding(bytes);
    const data = encoding === 'gzip' ? zlib.gunzipSync(bytes) : encoding === 'brotli' ? zlib.brotliDecompressSync(bytes) : bytes;
    return Buffer.from(data).toString('utf8');
}

// a runtime BPS that is byte for byte one the app ships in data/patches (Hyper Fighting: the build is the runtime) is
// replaced by its SHA-256 (runtime.bpsSha256), the editor fills it back in; VB Patches' sync-vueport.mjs uses this too
export function shippedColorPackage(text, shipped) {
    if (!text.includes('"bps"')) {
        return text;
    }
    const pkg = JSON.parse(text);
    const runtime = pkg.runtime;
    const bps = typeof runtime?.bps === 'string' ? Buffer.from(runtime.bps, 'base64') : undefined;
    if (!bps || !shipped.some(file => Buffer.compare(Buffer.from(file), bps) === 0)) {
        return text;
    }
    delete runtime.bps;
    runtime.bpsSha256 = sha256(bps);
    return JSON.stringify(pkg);
}

export async function shippedBpsFiles(directory = PATCHES) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...await shippedBpsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.bps')) {
            const data = await readFile(full);
            found.push({ path: `patches/${path.relative(PATCHES, full).split(path.sep).join('/')}`, data, sha256: sha256(data) });
        }
    }
    return found;
}

// highest standard brotli setting (quality 11, 16 MiB window): about a fifth of gzip, Bound High 12 MB -> 2.3 MB
export function compressColorPackage(text) {
    const data = Buffer.from(text, 'utf8');
    return zlib.brotliCompressSync(data, {
        params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
            [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_MAX_WINDOW_BITS,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
    });
}

async function packageFiles() {
    return (await readdir(PACKAGES, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.vbcpkg'))
        .map(entry => path.join(PACKAGES, entry.name))
        .sort();
}

function listEntry(file, bytes, text, shipped) {
    const name = path.basename(file);
    const hash = sha256(bytes);
    const entry = {
        file: name.replace(/\.vbcpkg$/, `-${hash.slice(0, 8)}.vbcpkg`),
        sha256: hash,
        size: bytes.length,
    };
    const runtime = text.includes('"bpsSha256"') ? JSON.parse(text).runtime?.bpsSha256 : undefined;
    if (typeof runtime === 'string') {
        const bps = shipped.find(file => file.sha256 === runtime);
        if (!bps) {
            throw new Error(`${name}: its runtime is a shipped BPS (${runtime.slice(0, 8)}…), which data/patches does not have`);
        }
        entry.runtime = bps.path;
    }
    return [`color-packages/${name}`, entry];
}

function listSource(entries) {
    const lines = entries.map(([key, entry]) => `    '${key}': {\n${Object.entries(entry)
        .map(([field, value]) => `        ${field}: ${JSON.stringify(value).replace(/"/g, '\'')},`).join('\n')}\n    },`);
    return `// Generated by packages/core/scripts/color-packages.mjs from data/color-packages: run it again rather than editing this.

// a VB Color package as published on the packages host (vb-color-package-file.ts)
export interface ColorPackageFile {
    // named by its content, so it never changes once published
    file: string;
    sha256: string;
    size: number;
    // shipped BPS used as runtime when the package only carries its SHA-256 (runtime.bpsSha256)
    runtime?: string;
}

// keyed by the package's path in the patch database (\`package\`)
export const COLOR_PACKAGE_FILES: { readonly [path: string]: ColorPackageFile } = {
${lines.join('\n')}
};
`;
}

export async function publishedColorPackages() {
    const found = [];
    for (const local of await packageFiles()) {
        const data = await readFile(local);
        const [, entry] = listEntry(local, data, '', []);
        found.push({ file: entry.file, local, data, sha256: entry.sha256 });
    }
    return found;
}

export async function prepareColorPackages({ check = false, log = console.log } = {}) {
    let changed = false;
    const entries = [];
    const shipped = await shippedBpsFiles();
    for (const file of await packageFiles()) {
        const name = path.basename(file);
        let bytes = await readFile(file);
        let text = packageText(bytes);
        if (packageEncoding(bytes) !== 'brotli') {
            changed = true;
            if (check) {
                log(`not ready  ${name} (${packageEncoding(bytes)})`);
            } else {
                const before = bytes.length;
                text = shippedColorPackage(text, shipped.map(bps => bps.data));
                bytes = compressColorPackage(text);
                await writeFile(file, bytes);
                log(`brotli     ${name}: ${(before / 1e6).toFixed(2)} MB -> ${(bytes.length / 1e6).toFixed(2)} MB`);
            }
        }
        entries.push(listEntry(file, bytes, text, shipped));
    }
    const source = listSource(entries);
    const current = existsSync(LIST) ? await readFile(LIST, 'utf8') : '';
    if (current !== source) {
        changed = true;
        log(check ? 'out of date src/common/vb-color-package-files.ts' : 'written    src/common/vb-color-package-files.ts');
        if (!check) {
            await writeFile(LIST, source);
        }
    }
    const total = entries.reduce((sum, [, entry]) => sum + entry.size, 0);
    log(`${entries.length} packages, ${(total / 1e6).toFixed(1)} MB${changed ? '' : ', all ready'}.`);
    return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    const changed = await prepareColorPackages({ check });
    if (check && changed) {
        process.exitCode = 1;
    }
}
