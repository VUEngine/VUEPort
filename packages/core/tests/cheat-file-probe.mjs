// checks the cheat file reader and writer (the shipped lib/emulator/common/emulator-cheats.js) against files
// in RetroArch's format and the code notation gamehacking.org publishes
// Usage: node tests/cheat-file-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cheats = require('../lib/common/emulator-cheats.js');

let failures = 0;

function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

section('Codes');
{
    // "50091A4:0001": constantly write 1 to the RAM address 0x050091A4
    const code = cheats.parseVesCheatCode('50091A4:0001');
    check('address', code.address, 0x050091a4);
    check('value', code.value, 1);
    check('a four digit value is a halfword', code.digits, 4);
    check('two bytes wide', cheats.vesCheatCodeBytes(code), 2);
    check('round trip', cheats.formatVesCheatCode(code), '50091A4:0001');

    check('a two digit value is a byte', cheats.parseVesCheatCode('5000000:7F').digits, 2);
    check('one byte wide', cheats.vesCheatCodeBytes(cheats.parseVesCheatCode('5000000:7F')), 1);
    check('an eight digit value is a word', cheats.parseVesCheatCode('5000000:DEADBEEF').digits, 8);
    check('four bytes wide', cheats.vesCheatCodeBytes(cheats.parseVesCheatCode('5000000:DEADBEEF')), 4);
    check('word value', cheats.parseVesCheatCode('5000000:DEADBEEF').value, 0xdeadbeef);
    // three, five and six digit values round up to the next width the hardware has
    check('three digits are a halfword', cheats.parseVesCheatCode('5000000:123').digits, 4);
    check('and keep their value', cheats.parseVesCheatCode('5000000:123').value, 0x123);
    check('six digits are a word', cheats.parseVesCheatCode('5000000:123456').digits, 8);

    check('lower case', cheats.parseVesCheatCode('50091a4:00ff').value, 0xff);
    check('and is written back upper case', cheats.formatVesCheatCode(cheats.parseVesCheatCode('50091a4:00ff')), '50091A4:00FF');
    check('surrounding space', cheats.parseVesCheatCode('  50091A4 : 0001  ').address, 0x050091a4);

    check('no colon', cheats.parseVesCheatCode('50091A4'), undefined);
    check('not hexadecimal', cheats.parseVesCheatCode('WARIO:0001'), undefined);
    check('empty', cheats.parseVesCheatCode(''), undefined);

    check('max value of a byte', cheats.vesCheatMaxValue(2), 0xff);
    check('of a halfword', cheats.vesCheatMaxValue(4), 0xffff);
    check('of a word', cheats.vesCheatMaxValue(8), 0xffffffff);
}

section('Reading a file');
{
    const text = [
        'cheats = 2',
        '',
        'cheat0_desc = "Infinite Hearts"',
        'cheat0_code = "50091A4:0001+50091A6:0002"',
        'cheat0_enable = true',
        '',
        'cheat1_desc = "Never Take Damage"',
        'cheat1_code = "5008F32:00FF"',
        'cheat1_enable = false',
        '',
    ].join('\n');

    const list = cheats.parseVesCheatFile(text);
    check('two cheats', list.length, 2);
    check('description', list[0].description, 'Infinite Hearts');
    check('enabled', list[0].enabled, true);
    check('two codes, joined by a plus', list[0].codes.length, 2);
    check('first code', cheats.formatVesCheatCode(list[0].codes[0]), '50091A4:0001');
    check('second code', cheats.formatVesCheatCode(list[0].codes[1]), '50091A6:0002');
    check('second cheat is off', list[1].enabled, false);
    check('its code', cheats.formatVesCheatCode(list[1].codes[0]), '5008F32:00FF');

    const enabled = cheats.enabledVesCheatCodes(list);
    check('enabled writes', enabled.length, 2);
    check('from the enabled cheat', enabled[0].address, 0x050091a4);
}

section('Reading an awkward file');
{
    const text = [
        '; hand written, no count, unquoted, odd spacing and an unknown key',
        'cheat0_desc=Infinite Lives',
        'cheat0_code =50091A4:0009',
        'cheat0_enable   =   TRUE',
        'cheat0_handler = 1',
        '',
        'cheat2_desc = "Gap in the numbering"',
        'cheat2_code = "5000000:0001"',
    ].join('\n');

    const list = cheats.parseVesCheatFile(text);
    check('both entries', list.length, 2);
    check('unquoted description', list[0].description, 'Infinite Lives');
    check('unquoted code', cheats.formatVesCheatCode(list[0].codes[0]), '50091A4:0009');
    check('enable is case insensitive', list[0].enabled, true);
    check('an entry past a gap', list[1].description, 'Gap in the numbering');
    check('an unknown key is ignored', list[0].codes.length, 1);

    check('an empty file', cheats.parseVesCheatFile('').length, 0);
    check('a count with no entries', cheats.parseVesCheatFile('cheats = 3').length, 0);
    const partial = cheats.parseVesCheatFile('cheat0_desc = "x"\ncheat0_code = "50091A4:0001+nonsense"');
    check('the good code survives', partial[0].codes.length, 1);
}

section('Writing a file');
{
    const list = [
        { description: 'Infinite Hearts', enabled: true, codes: [cheats.parseVesCheatCode('50091A4:0001')] },
        { description: 'Off', enabled: false, codes: [] },
    ];
    const text = cheats.serializeVesCheatFile(list);
    check('declares the count', text.startsWith('cheats = 2\n'), true);
    check('description', text.includes('cheat0_desc = "Infinite Hearts"'), true);
    check('code', text.includes('cheat0_code = "50091A4:0001"'), true);
    check('enable', text.includes('cheat0_enable = true'), true);
    check('second cheat', text.includes('cheat1_enable = false'), true);
    check('ends with a newline', text.endsWith('\n'), true);

    const again = cheats.parseVesCheatFile(text);
    check('same count', again.length, 2);
    check('same description', again[0].description, list[0].description);
    check('same enable', again[0].enabled, list[0].enabled);
    check('same code', cheats.formatVesCheatCode(again[0].codes[0]), '50091A4:0001');
    check('a cheat with no codes survives', again[1].codes.length, 0);

    const multi = cheats.serializeVesCheatFile([{
        description: 'Two writes', enabled: false,
        codes: [cheats.parseVesCheatCode('5000000:01'), cheats.parseVesCheatCode('5000002:DEADBEEF')],
    }]);
    check('joined with a plus', multi.includes('cheat0_code = "5000000:01+5000002:DEADBEEF"'), true);
    check('widths survive the round trip', cheats.parseVesCheatFile(multi)[0].codes[0].digits, 2);
}

section('Notes');
{
    // the notes extension is a key unknown to other readers, so a cheat without notes writes no empty line for it
    const withoutNotes = cheats.serializeVesCheatFile([
        { description: 'Plain', enabled: false, codes: [] },
    ]);
    check('no notes key when there are no notes', withoutNotes.includes('_notes'), false);
    check('reads back with no notes', cheats.parseVesCheatFile(withoutNotes)[0].notes, undefined);

    const withNotes = cheats.serializeVesCheatFile([{
        description: 'Debug Mode', enabled: true, codes: [],
        notes: 'Only takes if enabled before the ROM boots.',
    }]);
    check('carries the notes key', withNotes.includes('cheat0_notes = "Only takes if enabled before the ROM boots."'), true);
    check('round trip', cheats.parseVesCheatFile(withNotes)[0].notes, 'Only takes if enabled before the ROM boots.');

    // a multi-line note stays one physical line, as the format is read line by line
    const multiline = cheats.serializeVesCheatFile([{
        description: 'Wrapped', enabled: false, codes: [],
        notes: 'First line.\nSecond line.',
    }]);
    check('one physical line', multiline.split('\n').some(line => line.includes('\\n')), true);
    check('no raw newline inside the value', /notes = "[^"\n]*"/.test(multiline), true);
    check('unescapes back to real newlines', cheats.parseVesCheatFile(multiline)[0].notes, 'First line.\nSecond line.');

    // a tool that only knows the standard keys skips the unknown one, the cheat itself survives
    const foreign = cheats.parseVesCheatFile([
        'cheats = 1',
        'cheat0_desc = "From another tool"',
        'cheat0_code = "5000000:01"',
        'cheat0_enable = true',
        'cheat0_notes = "Added by hand"',
    ].join('\n'));
    check('the cheat survives an unrecognized key', foreign.length, 1);
    check('and the notes come along too', foreign[0].notes, 'Added by hand');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
