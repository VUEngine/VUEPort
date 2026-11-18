// buttons and input scripts: typed input becomes the mask the app would send, signature bit included.
// Usage: node tests/probe-keys-probe.mjs
import { createRequire } from 'module';
import { check, finish } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { parseKeys, formatKeys, VbInput, NO_KEYS } = require('../lib/probe/index.js');

console.log('Buttons');
check('nothing is the signature bit alone', parseKeys('-'), 0x0002);
check('A+RIGHT', parseKeys('A+RIGHT'), 0x0004 | 0x0100 | 0x0002);
check('case and separators do not matter', parseKeys('a, lr'), parseKeys('A+LR'));
check('hex keeps the signature bit', parseKeys('0x1000'), 0x1002);
check('formatted back canonically', formatKeys(parseKeys('right+a+start')), 'A+STA+LR');
check('nothing formats as -', formatKeys(NO_KEYS), '-');
let threw = false;
try { parseKeys('JUMP'); } catch { threw = true; }
check('an unknown button is refused', threw, true);

console.log('\nSpans');
check('from-to', JSON.stringify(VbInput.parseSpan('120-180:A')), JSON.stringify({ from: 120, to: 180, keys: 0x0006 }));
const span = VbInput.parseSpan('120+30:B');
check('from+length ends on the last frame held', span.to, 149);
check('a single frame', VbInput.parseSpan('7:STA').to, 7);

const input = new VbInput([VbInput.parseSpan('10-20:A'), VbInput.parseSpan('15-25:B')]);
check('outside every span is left to the machine', input.keysAt(9), undefined);
check('overlapping spans hold both', formatKeys(input.keysAt(17)), 'A+B');
check('end is the last frame covered', input.end, 25);
input.setMovie([0x0004, 0x0008], 100);
check('a movie frame', formatKeys(input.keysAt(101)), 'B');
check('spans win over the movie', formatKeys(input.keysAt(12)), 'A');
check('the movie gets the signature bit', input.keysAt(100) & 0x0002, 0x0002);

finish();
