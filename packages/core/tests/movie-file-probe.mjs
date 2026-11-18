// does a VBjin .mc2 come back as the buttons it records? A wrong column order still parses and plays, just a different
// game, so the checks tie each column's bit to the character VBjin writes.
// Usage: node tests/movie-file-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseVesMovie, looksLikeVesMovie, formatVesMovieLength, MOVIE_BUTTON_COLUMNS } =
    require('../lib/common/emulator-movie.js');

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) { failures++; }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const section = name => console.log(`\n${name}`);

const HEADER = [
    'version 1', 'emulator VBjin', 'emuVersion 9', 'rerecordCount 17197',
    'ports 1', 'comment author adelikat', 'comment category All Treasures (100%)',
].join('\r\n');
const movieOf = (...lines) => parseVesMovie([HEADER, ...lines, ''].join('\r\n'));

section('The header');
{
    const movie = movieOf('|0|..............|');
    check('names the emulator', movie.emulator, 'VBjin');
    check('and its version', movie.emulatorVersion, '9');
    check('and the rerecord count', movie.rerecordCount, 17197);
    check('and keeps the comments in order', movie.comments,
        ['author adelikat', 'category All Treasures (100%)']);
    check('a frame of nothing holds nothing', movie.frames, [0]);
    check('fourteen buttons to a line', MOVIE_BUTTON_COLUMNS, 14);
}

section('The buttons');
{
    const columns = [
        ['R-down', 13, 0x8000], ['R-left', 12, 0x4000], ['Select', 11, 0x2000],
        ['Start', 10, 0x1000], ['L-up', 9, 0x0800], ['L-down', 8, 0x0400],
        ['L-left', 7, 0x0200], ['L-right', 6, 0x0100], ['R-right', 5, 0x0080],
        ['R-up', 4, 0x0040], ['L-trigger', 3, 0x0020], ['R-trigger', 2, 0x0010],
        ['B', 1, 0x0008], ['A', 0, 0x0004],
    ];
    for (const [name, fromEnd, bit] of columns) {
        const at = 13 - fromEnd;
        const line = `|0|${'.'.repeat(at)}X${'.'.repeat(13 - at)}|`;
        check(`column ${at} is ${name}`, movieOf(line).frames, [bit]);
    }
    check('two at once are both held',
        movieOf('|0|...........R.A|').frames, [0x0010 | 0x0004]);
    check('a whole line held is every button',
        movieOf(`|0|${'X'.repeat(14)}|`).frames, [0xfffc]);
}

section('What it tolerates');
{
    check('a blank line is not a frame',
        movieOf('|0|..............|', '', '|0|.............A|').frames, [0, 4]);
    check('a line with no buttons column is skipped',
        movieOf('|0|', '|0|.............A|').frames, [4]);
    check('spaces count as unpressed',
        movieOf('|0|              |').frames, [0]);
    // the command column carries resets, which nothing here acts on, but the line is still a frame with buttons
    check('a frame with a command still carries its buttons',
        movieOf('|1|.............A|').frames, [4]);
}

section('Recognizing one');
{
    check('a VBjin movie is recognized', looksLikeVesMovie(HEADER), true);
    check('a macros file is not', looksLikeVesMovie('{"version":1,"macros":[]}'), false);
    check('nor is an empty file', looksLikeVesMovie(''), false);
}

section('Saying how long it runs');
{
    check('a second is a second', formatVesMovieLength(50), '0:01');
    check('and sixty-six thousand frames is twenty-two minutes',
        formatVesMovieLength(66023), '22:00');
    check('under a second rounds to none', formatVesMovieLength(10), '0:00');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
