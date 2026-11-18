// a command line given as one string (as VUEngine Studio's `emulator` tool gets it) splits as a shell
// would, and its paths are the ones the desktop client sends along and lets back in.
// Usage: node tests/probe-command-line-probe.mjs
import { createRequire } from 'module';
import { check, finish } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { namedPath, splitCommandLine } = require('../lib/probe/index.js');

const split = line => JSON.stringify(splitCommandLine(line));

console.log('\nsplitting');
check('words', split('  regs   --fork one '), '["regs","--fork","one"]');
check('double quotes keep spaces', split('asm 0x0701A2B0 "movea 99, r0, r10; jmp [lp]"'), '["asm","0x0701A2B0","movea 99, r0, r10; jmp [lp]"]');
check('single quotes take backslashes as they are', split("dis 'a\\b'"), '["dis","a\\\\b"]');
check('a backslash escapes a space', split('capture my\\ shot.png'), '["capture","my shot.png"]');
check('an empty quoted argument stays', split('watch ""'), '["watch",""]');
check('quotes inside a word join it', split('--write=g_"stats".lives'), '["--write=g_stats.lives"]');
check('an open quote is refused', (() => {
    try {
        splitCommandLine('asm "nop');
        return 'accepted';
    } catch (error) {
        return error.message;
    }
})(), 'A " is not closed.');

console.log('\npaths');
check('a plain argument', namedPath('now.png'), 'now.png');
check('an option with =', namedPath('--state-out=a/b.vess'), 'a/b.vess');
check('a frame\'s shot', namedPath('600:title.png'), 'title.png');
check('an address range is not a frame', namedPath('0x05000000:64'), '0x05000000:64');
check('a key span keeps its keys', namedPath('300-305:STA'), '300-305:STA');

finish();
