// the log timestamp, which four panels line up in a column: written by hand rather than via toLocaleTimeString, so
// it must be fixed width in every case (single-digit hour, ms under ten), and local time rather than UTC
import { formatLogTime } from '../lib/common/emulator-log.js';

let failures = 0;
function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${actual}, expected ${expected}`);
        return;
    }
    console.log(`  ok   ${label}`);
}

// built as local, so the expectation does not depend on the zone
const at = (h, m, s, ms) => new Date(2024, 0, 2, h, m, s, ms).getTime();

console.log('Log timestamps');
check('an ordinary time', formatLogTime(at(14, 23, 5, 123)), '14:23:05.123');
check('midnight', formatLogTime(at(0, 0, 0, 0)), '00:00:00.000');
check('a single-digit hour is padded', formatLogTime(at(9, 8, 7, 6)), '09:08:07.006');
check('the last millisecond of the day', formatLogTime(at(23, 59, 59, 999)), '23:59:59.999');

const widths = new Set([
    at(1, 1, 1, 1), at(14, 23, 5, 123), at(23, 59, 59, 999), at(0, 0, 0, 0),
].map(when => formatLogTime(when).length));
check('every time is the same width', widths.size, 1);
check('and that width is HH:MM:SS.mmm', [...widths][0], 12);

const noon = new Date(2024, 5, 15, 12, 0, 0, 0);
check('it reads the local clock', formatLogTime(noon.getTime()).slice(0, 2),
    String(noon.getHours()).padStart(2, '0'));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
