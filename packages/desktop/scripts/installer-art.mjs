/**
 * Builds the two placeholder bitmaps the Windows installer draws (Tauri passes them on from bundle.windows.nsis):
 *
 *   headerImage   150x57, the strip along the top of every page after the first. White, as MUI draws the header
 *                 white, so the logo reads as part of the page.
 *   sidebarImage  164x314, the tall panel left of the welcome and finish pages; carries the brand.
 *
 * Real artwork just replaces the two files. NSIS is strict and silent about the format: uncompressed 24-bit BMP
 * (Windows 3.x BITMAPINFOHEADER, BI_RGB; no PNG, RLE or alpha) at exactly those sizes, as it does not scale.
 * tests/installer-art-probe.mjs checks both, whatever made them. Drawn with ffmpeg, as `tauri icon` only makes icons;
 * a machine without one of the bold sans fonts says so.
 *
 * Usage: yarn workspace vueport-desktop installer-art
 */
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tauri = path.join(here, '..', 'src-tauri');
const logo = path.join(tauri, 'icons', 'icon.png');
const out = name => path.join(tauri, 'windows', name);

// the brand, as host-theme.css and the application's own gradients have it
const ACCENT = '0xC81F26';
const DEEP = '0x7A0F16';
const DARK = '0x4A0A0F';
const SHADOW = '0x120306';

// a bold sans for the wordmark, whichever the machine has. Named by path, as ffmpeg is not always built with
// fontconfig
const FONTS = [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
];

async function firstPresent(candidates) {
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {
            // try the next one
        }
    }
    return undefined;
}

const font = await firstPresent(FONTS);
if (!font) {
    throw new Error('No bold sans font found to set the wordmark in. Looked for:\n  '
        + FONTS.join('\n  ')
        + '\nAdd one this machine has to FONTS in this script.');
}

function ffmpeg(args) {
    const result = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
    });
    if (result.error?.code === 'ENOENT') {
        throw new Error('ffmpeg is not on PATH. It is only needed to regenerate these two'
            + ' placeholders, which are checked in — `brew install ffmpeg`, or replace the'
            + ' bitmaps by hand.');
    }
    if (result.status !== 0) {
        throw new Error(`ffmpeg failed:\n${result.stderr ?? ''}`);
    }
}

// `drawtext`, with the colons and quotes it reads as syntax escaped
const text = (string, options) =>
    `drawtext=fontfile='${font}':text='${string}':` + options;

ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=white:s=150x57',
    '-i', logo,
    '-filter_complex', [
        '[1:v]scale=38:38[logo]',
        '[0:v][logo]overlay=10:10[a]',
        `[a]${text('VUEPORT', `fontcolor=${ACCENT}:fontsize=15:x=56:y=17`)}[b]`,
        `[b]${text('placeholder', 'fontcolor=0x999999:fontsize=7:x=57:y=34')}[out]`,
    ].join(';'),
    '-map', '[out]', '-frames:v', '1', '-pix_fmt', 'bgr24', out('header.bmp'),
]);

// the sidebar: the app's gradient, darkened until the logo's red half reads against it (at full brightness
// the V disappears)
ffmpeg([
    '-f', 'lavfi', '-i', `gradients=s=164x314:c0=${DARK}:c1=${DEEP}:c2=${SHADOW}`
        + ':nb_colors=3:x0=0:y0=0:x1=164:y1=314',
    '-i', logo,
    '-filter_complex', [
        '[1:v]scale=84:84[logo]',
        '[0:v][logo]overlay=(W-w)/2:48[a]',
        `[a]${text('VUEPORT', 'fontcolor=white:fontsize=19:x=(w-text_w)/2:y=150')}[b]`,
        `[b]${text('PLACEHOLDER', 'fontcolor=0xFFFFFF@0.4:fontsize=9:x=(w-text_w)/2:y=292')}[out]`,
    ].join(';'),
    '-map', '[out]', '-frames:v', '1', '-pix_fmt', 'bgr24', out('sidebar.bmp'),
]);

console.log('windows/header.bmp   150x57  placeholder');
console.log('windows/sidebar.bmp  164x314 placeholder');
console.log(`Set in ${font.split('/').pop()}. Replace both with real artwork when there is any;`);
console.log('tests/installer-art-probe.mjs checks whatever is there is still a 24-bit BMP.');
