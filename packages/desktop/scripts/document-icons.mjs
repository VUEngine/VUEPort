/**
 * Builds the icons the system shows for a Virtual Boy file, from one 1024x1024 source per file type beside the
 * output. The derived files are checked in and never edited by hand (as with the app icon, yarn icons).
 *
 *   macOS    an .icns with 16, 32, 128, 256 and 512 points at 1x and 2x, named per document type in Info.plist
 *            (CFBundleTypeIconFile)
 *   Windows  an .ico, the type's DefaultIcon in windows/associations.nsh
 *   Linux    loose PNGs in the icon theme, a folder per size, named after the MIME type; placed by the deb
 *            (bundle.linux.deb.files)
 *
 * tauri icon runs twice per source, once for the two container formats and once for the theme sizes, and only what
 * is installed is kept.
 *
 * Usage: yarn workspace vueport-desktop icons:documents
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const documents = path.join(here, '..', 'src-tauri', 'icons', 'documents');

// an icon theme files a document icon under its MIME type with the slash as a dash; named so here, so the
// packages can install a whole folder at a time
const TYPES = [
    { name: 'vb', themeName: 'application-x-virtual-boy-rom' },
    { name: 'vbc', themeName: 'application-x-virtual-boy-color-rom' },
    { name: 'vbz', themeName: 'application-x-virtual-boy-rom-archive' },
];

// the small ones matter most: a file list shows 16 or 24 pixels
const THEME_SIZES = [16, 22, 24, 32, 48, 64, 128, 256];

function run(args) {
    // quiet unless it goes wrong: the command narrates every file it writes, and most are thrown away
    const result = spawnSync('npx', ['tauri', 'icon', ...args], {
        cwd: path.join(here, '..'),
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        throw new Error(`\`tauri icon ${args.join(' ')}\` failed:\n${result.stderr ?? ''}`);
    }
}

for (const { name: type, themeName } of TYPES) {
    const source = path.join(documents, `${type}.png`);
    const scratch = await mkdtemp(path.join(tmpdir(), `vueport-icon-${type}-`));
    try {
        run([source, '-o', scratch]);
        await cp(path.join(scratch, 'icon.icns'), path.join(documents, `${type}.icns`));
        await cp(path.join(scratch, 'icon.ico'), path.join(documents, `${type}.ico`));

        // the loose sizes have to be asked for separately: naming any size turns the default set off
        const themed = await mkdtemp(path.join(tmpdir(), `vueport-theme-${type}-`));
        try {
            run([source, '-o', themed, ...THEME_SIZES.flatMap(size => ['-p', String(size)])]);
            for (const size of THEME_SIZES) {
                const folder = path.join(documents, 'linux', `${size}x${size}`);
                await mkdir(folder, { recursive: true });
                await cp(
                    path.join(themed, `${size}x${size}.png`),
                    path.join(folder, `${themeName}.png`));
            }
        } finally {
            await rm(themed, { recursive: true, force: true });
        }
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
    console.log(`${type}: icns, ico and ${THEME_SIZES.length} theme sizes`);
}
