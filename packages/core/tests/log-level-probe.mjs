// what a line of terminal output announces itself as, which the Terminal panel colors and filters by. A colon
// is required, so a line merely starting with the word ("errors: 3") is ordinary output
import { LOG_LEVELS, parseLogLevel, splitLogLevel } from '../lib/common/emulator-log.js';

let failures = 0;
function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${actual}, expected ${expected}`);
        return;
    }
    console.log(`  ok   ${label}`);
}

console.log('Prefixes');
check('info', parseLogLevel('Info: stage loaded'), 'info');
check('warning', parseLogLevel('Warning: sprite queue at 92%'), 'warning');
check('error', parseLogLevel('Error: MemoryPool overflow'), 'error');

console.log('\nHow they may be written');
check('lower case', parseLogLevel('error: MemoryPool overflow'), 'error');
check('upper case', parseLogLevel('WARNING: late frame'), 'warning');
check('space before the colon', parseLogLevel('Info : ready'), 'info');
check('no space after it', parseLogLevel('Error:ready'), 'error');
check('indented', parseLogLevel('   Warning: indented'), 'warning');

// a line that announced nothing is information, as a printf in a debug build is
console.log('\nWhat is not a prefix, and so is information');
check('a word that only starts the same', parseLogLevel('errors: 3'), 'info');
check('the word without a colon', parseLogLevel('Error MemoryPool overflow'), 'info');
check('the word further in', parseLogLevel('Stage: Error: not the start'), 'info');
check('ordinary output', parseLogLevel('VIPManager frame 1420'), 'info');
check('an empty line', parseLogLevel(''), 'info');

console.log('\nThe prefix comes off, because it is shown as a badge');
const body = text => splitLogLevel(text).text;
check('the word and its colon go',
    body('Warning: sprite queue at 92%'), 'sprite queue at 92%');
check('with the space after it', body('Error:MemoryPool'), 'MemoryPool');
// trimmed after the cut, not before: the space after the prefix belongs to the prefix, or every announced line
// would be indented against ordinary ones
check('however much of it there was', body('Info:   aligned'), 'aligned');
check('an indent before the prefix goes with it',
    body('   Warning: indented'), 'indented');

// the ends are trimmed too: output formatted for a fixed-width debug screen arrives padded to the row's width
check('the padding around an ordinary line goes too',
    body('  VIPManager frame 1420   '), 'VIPManager frame 1420');
check('including a carriage return before the newline',
    body('Stage::loadActors\r'), 'Stage::loadActors');
check('and an empty line stays empty', body(''), '');

console.log('\nThe levels themselves');
check('every level is listed', LOG_LEVELS.length, 3);
check('they run up in severity', LOG_LEVELS.join(), 'info,warning,error');
check('and the first of them is what an unannounced line is',
    LOG_LEVELS[0], parseLogLevel('VIPManager frame 1420'));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
