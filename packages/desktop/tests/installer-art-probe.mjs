/**
 * Checks the bitmaps and the icon the Windows installer draws. NSIS silently drops or mangles artwork it cannot read,
 * typically a PNG renamed .bmp, 32-bit with alpha (NSIS wants 24-bit BI_RGB) or the wrong size (NSIS does not scale:
 * larger is clipped, smaller leaves the dialog showing around it). So the BMP header and dimensions are read from the
 * file, not trusted from the extension or the generator, as artwork gets replaced by hand. The configuration is read
 * as Windows reads it: tauri.windows.conf.json is a JSON merge patch over the base (see associations-probe.mjs).
 *
 * Usage: node tests/installer-art-probe.mjs
 */
import { readFile } from 'node:fs/promises';

const read = async name =>
    JSON.parse(await readFile(new URL(`../src-tauri/${name}`, import.meta.url), 'utf8'));

const merge = (base, patch) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return patch;
    }
    const out = base !== null && typeof base === 'object' && !Array.isArray(base)
        ? { ...base }
        : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete out[key];
        } else {
            out[key] = merge(out[key], value);
        }
    }
    return out;
};

const onWindows = merge(await read('tauri.conf.json'), await read('tauri.windows.conf.json'));
const nsis = onWindows.bundle?.windows?.nsis ?? {};

let failures = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
    if (!ok) {
        failures++;
    }
};

// only the fields NSIS cares about, from the file header and the BITMAPINFOHEADER. Height is signed: negative means
// top-down rows, legal BMP that NSIS draws upside down
async function describe(url) {
    let bytes;
    try {
        bytes = await readFile(url);
    } catch {
        return { missing: true };
    }
    if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4D) {
        return { notABitmap: true };
    }
    return {
        headerSize: bytes.readUInt32LE(14),
        width: bytes.readInt32LE(18),
        height: bytes.readInt32LE(22),
        bitsPerPixel: bytes.readUInt16LE(28),
        compression: bytes.readUInt32LE(30),
    };
}

const ART = [
    { key: 'headerImage', where: 'the strip along the top of every inner page', size: [150, 57] },
    { key: 'sidebarImage', where: 'the panel on the welcome and finish pages', size: [164, 314] },
];

console.log('\nWhat the Windows installer draws');
for (const { key, where, size: [width, height] } of ART) {
    const named = nsis[key];
    check(`${key} is set — ${where}`, typeof named === 'string', true);
    if (typeof named !== 'string') {
        continue;
    }

    const bitmap = await describe(new URL(`../src-tauri/${named}`, import.meta.url));
    check(`  and ${named} is there`, bitmap.missing !== true, true);
    if (bitmap.missing) {
        continue;
    }

    // first: a PNG with .bmp on the end fails every check below for the wrong reason
    check('  and is a BMP rather than something renamed', bitmap.notABitmap !== true, true);
    if (bitmap.notABitmap) {
        continue;
    }

    check('  24-bit, which is what NSIS reads', bitmap.bitsPerPixel, 24);
    // BI_RGB; an editor might write RLE or, at 32 bits, BI_BITFIELDS
    check('  uncompressed', bitmap.compression, 0);
    // anything larger is a BITMAPV4/V5 header, with a colour profile NSIS has no use for and some builds refuse
    check('  a plain BITMAPINFOHEADER', bitmap.headerSize, 40);
    check(`  and exactly ${width}x${height}, because nothing scales it`,
        [bitmap.width, bitmap.height], [width, height]);
}

// the icon of the setup executable itself: the application's own, rather than a second one to keep in step
console.log('\nAnd what it wears');
{
    check('installerIcon is the application icon', nsis.installerIcon, 'icons/icon.ico');
    const icon = await readFile(new URL(`../src-tauri/${nsis.installerIcon}`, import.meta.url))
        .catch(() => undefined);
    check('  which is there', icon !== undefined, true);
    // `00 00 01 00`, the ICONDIR of a real .ico rather than a PNG or cursor file
    check('  and is an icon file',
        icon !== undefined && icon.readUInt32LE(0) === 0x00010000, true);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
