import { COLOR_PACKAGE_FILES, ColorPackageFile } from './vb-color-package-files';

/**
 * VB Color packages do not ship with the app: together they would be close to 100 MB, and only the color editor reads
 * them. They are published on a host of their own (`yarn deploy:packages`), each under a name made of its content
 * (listed in vb-color-package-files.ts, which packages/core/scripts/color-packages.mjs writes), and fetched when the
 * editor opens one. The HTTP cache keeps them, as the host marks them immutable. They are brotli-compressed because
 * gzip's small window misses most of what repeats in a package.
 */
export const COLOR_PACKAGES_URL = 'https://packages.vueport.net/';

export function colorPackageFile(path: string): ColorPackageFile | undefined {
    return Object.prototype.hasOwnProperty.call(COLOR_PACKAGE_FILES, path) ? COLOR_PACKAGE_FILES[path] : undefined;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// passes when the hash cannot be checked: crypto.subtle only exists in a secure context, which a page served over plain
// http from another machine (a headset on the desktop's LAN share) is not
async function hashMatches(bytes: Uint8Array, sha256: string): Promise<boolean> {
    return typeof crypto === 'undefined' || !crypto.subtle || await sha256Hex(bytes) === sha256;
}

export async function fetchColorPackage(file: ColorPackageFile, base: string = COLOR_PACKAGES_URL): Promise<Uint8Array> {
    const url = new URL(file.file, base).href;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== file.size || !await hashMatches(bytes, file.sha256)) {
        throw new Error(`${url} is not the package this build of VUEPort was made with`);
    }
    return bytes;
}

async function streamThrough(bytes: Uint8Array, format: string): Promise<Uint8Array> {
    const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream(format as CompressionFormat));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// whether DecompressionStream does brotli (Node, some browsers; not Chromium as of 149)
let nativeBrotli: boolean | undefined;
function hasNativeBrotli(): boolean {
    if (nativeBrotli === undefined) {
        try {
            new DecompressionStream('brotli' as CompressionFormat);
            nativeBrotli = true;
        } catch {
            nativeBrotli = false;
        }
    }
    return nativeBrotli;
}

// accepts plain JSON, gzip (exported by the editor and the VB Patches tools) or brotli (published packages); brotli has
// no magic number, so it is assumed for anything that is neither
export async function unpackColorPackage(bytes: Uint8Array): Promise<Uint8Array> {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        return streamThrough(bytes, 'gzip');
    }
    let at = 0;
    while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x0a || bytes[at] === 0x0d || bytes[at] === 0x09)) {
        at++;
    }
    if (bytes[at] === 0x7b) {
        return bytes;
    }
    if (hasNativeBrotli()) {
        return streamThrough(bytes, 'brotli');
    }
    const { decompress } = await import('brotli/decompress');
    return decompress(bytes);
}

function base64(bytes: Uint8Array): string {
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(binary);
}

// a published package whose runtime is a shipped BPS only carries its SHA-256 (runtime.bpsSha256, see
// color-packages.mjs); this puts the BPS back so the package can be compiled and exported as one file
export async function restoreColorPackageRuntime(pkg: object, runtimeBps: Uint8Array | undefined): Promise<void> {
    const runtime = (pkg as { runtime?: { bps?: string, bpsSha256?: string } }).runtime;
    if (!runtime || typeof runtime.bps === 'string' || typeof runtime.bpsSha256 !== 'string') {
        return;
    }
    if (!runtimeBps) {
        throw new Error('the package needs the colorization\'s BPS as its runtime');
    }
    if (!await hashMatches(runtimeBps, runtime.bpsSha256)) {
        throw new Error('the colorization\'s BPS is not the runtime the package was made with');
    }
    runtime.bps = base64(runtimeBps);
    delete runtime.bpsSha256;
}
