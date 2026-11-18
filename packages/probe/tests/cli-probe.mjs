// vbprobe from the outside: commands as a script or agent runs them, chained through a save state file as two separate
// calls are. Usage: node tests/cli-probe.mjs
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { at, buildDisplayRom, buildFaultRom, buildRom, check, COUNTER, fault, finish } from '../../core/tests/probe-test-rom.mjs';

const bin = fileURLToPath(new URL('../bin/vbprobe.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'vbprobe-'));
const rom = join(dir, 'test.vb');
writeFileSync(rom, buildRom());
const hex = value => `0x${value.toString(16)}`;
let failed;
const fold = address => (0x07000000 | (address & 0xffff)) >>> 0;

function vbprobe(...args) {
    try {
        return { code: 0, out: execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (error) {
        return { code: error.status, out: `${error.stdout}${error.stderr}` };
    }
}

try {
    console.log('run');
    let { out } = vbprobe('run', rom, '--frames', '4', '--terminal');
    check('reports the frame', out.split('\n')[0].startsWith('frame 4  pc 0x'), true);
    check('prints the terminal', out.includes('terminal:\n  A'), true);

    console.log('\n--until and --state-out');
    const state = join(dir, 'at-store.vess');
    ({ out } = vbprobe('run', rom, '--until', hex(at.store), '--state-out', state));
    check('stops at the address', out.includes(`stopped (until) at ${hex(at.store).replace('0x', '0x')}`), true);
    check('writes the state', readFileSync(state).length > 0, true);

    console.log('\n--state-in carries on from there');
    ({ out } = vbprobe('regs', rom, '--state-in', state, '--json'));
    const regs = JSON.parse(out).registers;
    check('the PC is where the state was taken', regs.pc, at.store);

    console.log('\npeek');
    ({ out } = vbprobe('peek', rom, '--frames', '2', `${hex(COUNTER)}:4`, '--json'));
    const bytes = JSON.parse(out).peek[0].bytes;
    check('four bytes of the counter', bytes.length, 8);
    check('... and it counted', parseInt(bytes.match(/../g).reverse().join(''), 16) > 0, true);
    ({ out } = vbprobe('peek', rom, `${hex(COUNTER)}:16`));
    check('text output is a hex dump', /\n {2}0x05000010 {2}[0-9a-f]{2} /.test(out), true);

    console.log('\ndis');
    ({ out } = vbprobe('dis', rom, hex(at.start), '3'));
    check('three instructions', out.includes('movhi 0x0500, r0, r10') && out.includes('movea 0x0041, r0, r14'), true);

    console.log('\n--keys and --movie are accepted');
    const movie = join(dir, 'test.mc2');
    writeFileSync(movie, 'version 1\nemulator VBjin\n|0|.............A|\n|0|..............|\n');
    ({ out } = vbprobe('run', rom, '--frames', '2', '--keys', '0-1:A+RIGHT', '--movie', movie));
    check('runs', out.startsWith('frame 2'), true);

    console.log('\nshot');
    const png = join(dir, 'shot.png');
    ({ out } = vbprobe('shot', rom, png, '--eye', 'both', '--scale', '2'));
    const file = readFileSync(png);
    check('a PNG', file.subarray(1, 4).toString('latin1'), 'PNG');
    check('both eyes, doubled', file.readUInt32BE(16), 768 * 2);
    const midway = join(dir, 'frame2.png');
    ({ out } = vbprobe('run', rom, '--frames', '4', '--shot', `2:${midway}`));
    check('a shot on the way', out.includes(`wrote ${midway} (frame 2)`), true);

    console.log('\nwatch');
    ({ out } = vbprobe('watch', rom, '--frames', '1', '--write', `${hex(COUNTER)}:4`));
    check('folds a busy watch by instruction', /watch 1 {2}write 0x05000010 \(4 bytes\) {2}\d+ hits in 1 frame, 1 place/.test(out), true);
    check('... naming the store', out.includes(`pc 0x${fold(at.store).toString(16).padStart(8, '0')}`), true);
    ({ out } = vbprobe('watch', rom, '--frames', '1', '--write', `${hex(COUNTER)}:4`, '--when-value', '5-7', '--list'));
    check('lists hits one by one', (out.match(/write 0x05000010 {2}0x0000000[4-6] → 0x0000000[5-7]/g) ?? []).length, 3);
    const stopped = join(dir, 'stopped.vess');
    ({ out } = vbprobe('regs', rom, '--frames', '5', '--write', `${hex(COUNTER)}:4`, '--when-value', '100', '--stop', '--state-out', stopped));
    check('--stop stops at the hit', out.includes('stopped (watch) at') && out.includes('0x00000063 → 0x00000064'), true);
    check('... with the machine on the store', out.includes(`pc   ${hex(at.store)}`), true);
    ({ out } = vbprobe('peek', rom, '--state-in', stopped, `${hex(COUNTER)}:4`, '--json'));
    check('... and the state saved before the write lands', JSON.parse(out).peek[0].bytes, '63000000');
    ({ out } = vbprobe('watch', rom, '--frames', '1', '--exec', hex(at.loop), '--json'));
    const watch = JSON.parse(out).watches[0];
    check('an exec watch in JSON', watch.kind === 'exec' && watch.count > 1000 && watch.groups.length === 1, true);

    console.log('\nvip, vsu, vbc');
    ({ out } = vbprobe('vip', rom));
    check('the overview says what is drawn', out.includes('display off') && out.includes('worlds drawn (0), 31 first:'), true);
    ({ out } = vbprobe('vip', rom, 'char', '0'));
    check('a character as eight rows', out.split('\n').filter(line => /^ {2}[0-3]{8}$/.test(line)).length, 8);
    ({ out } = vbprobe('vip', rom, 'objects', '--all', '--json'));
    check('objects as JSON', JSON.parse(out).vip.length, 1024);
    ({ out } = vbprobe('vsu', rom));
    check('six channels', out.split('\n').filter(line => / (on |off) /.test(line)).length, 6);
    ({ out } = vbprobe('vbc', rom, '--hardware', 'vb'));
    check('vbc on a plain Virtual Boy says so', out.includes('Not a VB Color machine'), true);
    failed = vbprobe('pool', rom);
    check('pool without an .elf is explained', failed.code !== 0 && failed.out.includes('needs the build'), true);

    console.log('\ncoverage');
    ({ out } = vbprobe('coverage', rom, '--frames', '1', '--coverage-out', join(dir, 'one.cov')));
    check('which code ran', /coverage: \d+ instructions ran, in \d+ spans?:/.test(out), true);
    ({ out } = vbprobe('coverage', rom, '--frames', '0', '--coverage-out', join(dir, 'none.cov')));
    ({ out } = vbprobe('coverage', rom, '--frames', '1', '--against', join(dir, 'none.cov')));
    check('against a run that ran nothing, all of it is new', /ran now but not in .*: [1-9]\d* instructions/.test(out), true);

    console.log('\nsearch');
    const candidates = join(dir, 'counter.search');
    ({ out } = vbprobe('search', rom, '--type', 'u32', '--candidates', candidates));
    check('a new search keeps everything', out.includes('a new search') && out.includes('16384 candidates after 1 step'), true);
    ({ out } = vbprobe('search', rom, '--frames', '1', '--op', 'increased', '--candidates', candidates));
    check('a step keeps what increased: the counter', out.includes('1 candidate after 2 steps') && out.includes('0x05000010'), true);

    console.log('\nasm');
    const counterOf = text => parseInt(JSON.parse(text).peek[0].bytes.match(/../g).reverse().join(''), 16);
    ({ out } = vbprobe('asm', rom, `0x${at.loop.toString(16)}`, 'add 2, r11', '--frames', '1', '--state-out', join(dir, 'patched.vess'), '--json'));
    check('a patch lists what it assembled', JSON.parse(out).asm.bytes.join(','), [0x62, 0x45].join(','));
    const patchedCount = counterOf(vbprobe('peek', rom, '--state-in', join(dir, 'patched.vess'), `${hex(COUNTER)}:4`, '--json').out);
    const plainCount = counterOf(vbprobe('peek', rom, '--frames', '1', `${hex(COUNTER)}:4`, '--json').out);
    check('the patched code is what runs: the counter goes up by two', patchedCount % 2 === 0 && patchedCount > plainCount * 1.9, true);
    ({ out } = vbprobe('asm', rom, `0x${at.loop.toString(16)}`, 'add 2, r11', '--dry'));
    check('--dry only lists it', out.includes('add 2, r11') && !out.includes('patched'), true);
    ({ out } = vbprobe('asm', rom, '0x07000000', 'mov 1, r1; jump nowhere', '--dry'));
    check('a mistake names its line', out.includes('jump nowhere') && out.includes('Unknown instruction'), true);

    console.log('\nfaults, branches, the VIP');
    const faultRom = join(dir, 'fault.vb');
    writeFileSync(faultRom, buildFaultRom());
    ({ out } = vbprobe('regs', faultRom, '--frames', '1', '--stop-on-fault', '--branches', '4'));
    check('a fault stops the run and says which', out.includes('stopped (fault: zero division)') && out.includes(`0x${fault.div.toString(16)}`), true);
    check('... with the branches before it', /last \d branch(es)?, oldest first:/.test(out), true);
    const displayRom = join(dir, 'display.vb');
    writeFileSync(displayRom, buildDisplayRom());
    ({ out } = vbprobe('run', displayRom, '--until-vip', 'drawing'));
    check('--until-vip', out.includes('stopped (until drawing)'), true);
    const annotated = join(dir, 'annotated.png');
    vbprobe('shot', displayRom, annotated, '--frames', '2', '--annotate', 'worlds');
    check('--annotate writes a picture, enlarged', readFileSync(annotated).readUInt32BE(16), 384 * 2);

    console.log('\n--set');
    ({ out } = vbprobe('peek', rom, '--frames', '1', '--exec', hex(at.store), '--set', 'r11=1000', `${hex(COUNTER)}:4`, '--json'));
    let report = JSON.parse(out);
    check('at every hit of a watch', report.peek[0].bytes, 'e8030000');
    check('... every one of them', report.set.applied, report.watches[0].count);
    ({ out } = vbprobe('peek', rom, '--set', `${hex(COUNTER)}:2=0xbeef`, '--set', 'r20=0x1234', `${hex(COUNTER)}:4`));
    check('without a watch, before the run', out.includes('set 0x5000010:2=0xbeef, r20=0x1234 before the run') && out.includes('ef be 00 00'), true);
    failed = vbprobe('run', rom, '--set', 'r11');
    check('a set without a value is refused', failed.code !== 0 && failed.out.includes('what=value'), true);

    console.log('\ndis over a range');
    const listed = text => text.split('\n').filter(line => /^[ >] 0x/.test(line)).length;
    ({ out } = vbprobe('dis', rom, `${hex(at.start)}..${hex(at.branch + 2)}`));
    check('from..to, the end not included', listed(out), 9);
    ({ out } = vbprobe('dis', rom, `${hex(at.start)}-${hex(at.branch)}`));
    check('from-to with numbers', listed(out), 8);
    const listing = join(dir, 'listing.txt');
    ({ out } = vbprobe('dis', rom, `${hex(at.start)}..${hex(at.branch + 2)}`, '--out', listing));
    check('--out writes it instead', out.includes(`wrote ${listing}: 9 instructions`) && listed(readFileSync(listing, 'utf8')), 9);

    console.log('\n--fold, --until-read, --until-written');
    ({ out } = vbprobe('watch', rom, '--frames', '1', '--write', `${hex(COUNTER)}:4`, '--fold', '2'));
    check('hits by place', /by 2 bytes, 1 place:\n {2}0x05000010–0x05000011 +\d+×/.test(out), true);
    ({ out } = vbprobe('peek', rom, '--until-written', `${hex(COUNTER)}:4`, `${hex(COUNTER)}:4`));
    check('until a range is written, with the write done',
        out.includes(`stopped (until-written ${hex(COUNTER)}:4, the last of it by 0x${fold(at.store).toString(16).padStart(8, '0')}`) && out.includes('01 00 00 00'), true);
    ({ out } = vbprobe('regs', rom, '--until-read', `${hex(COUNTER)}:4`, '--json'));
    check('until a range is read, with the read done', JSON.parse(out).registers.program[12], 1);
    ({ out } = vbprobe('run', rom, '--until-read', '0x05000020:4', '--frames', '1'));
    check('... and how far it got if not', out.includes('did not get to until-read 0x05000020:4 in 1 frames: 0 of 4 bytes'), true);

    console.log('\nfb, origin');
    const displayed = join(dir, 'display-fb.vb');
    writeFileSync(displayed, buildDisplayRom());
    ({ out } = vbprobe('fb', displayed, '--frames', '3'));
    check('a frame buffer, summed up', /left frame buffer [01], shown: shades\n {2}0: 86016\n {2}all 0/.test(out), true);
    ({ out } = vbprobe('fb', displayed, '--frames', '3', 'right', 'drawn', '0,0,4,2'));
    check('a region of it', /right frame buffer [01], drawn into: shades\n {4}0 {2}0000\n {4}1 {2}0000/.test(out), true);
    const raw = join(dir, 'fb.bin');
    vbprobe('fb', displayed, '--frames', '3', '--out', raw);
    check('--out .bin: a byte a pixel', readFileSync(raw).length, 384 * 224);
    ({ out } = vbprobe('origin', displayed, '10,10'));
    check('origin runs on until the buffer is drawn', /ran on for the VIP to draw it, \d+ frames? on: now frame \d+/.test(out) && out.includes('backdrop, shade 0'), true);
    ({ out } = vbprobe('origin', displayed, '--frames', '0', '10,10'));
    check('... unless told how far to run', out.includes('unknown: not drawn since origins were kept'), true);
    const origins = join(dir, 'origins.bin');
    ({ out } = vbprobe('origin', displayed, '--frames', '3', '--out', origins));
    check('the screen by world', out.includes('86016 px  0,0 to 383,223  backdrop'), true);
    check('--out .bin: two words a pixel', readFileSync(origins).length, 384 * 224 * 8);
    failed = vbprobe('fb', displayed, '--color');
    check('--color on a plain Virtual Boy is explained', failed.code !== 0 && failed.out.includes('VB Color frame buffer'), true);

    console.log('\na state of another build');
    const otherBuild = join(dir, 'other-build.vb');
    {
        const changed = buildRom();
        changed[changed.length - 544] = 0x42;   // another name in the header: another build, as far as a state can tell
        writeFileSync(otherBuild, changed);
    }
    failed = vbprobe('regs', otherBuild, '--state-in', state);
    check('is refused unasked', failed.code !== 0 && failed.out.includes('different ROM'), true);
    ({ out } = vbprobe('regs', otherBuild, '--state-in', state, '--other-rom', '--json'));
    check('... and taken with --other-rom', JSON.parse(out).registers.pc, at.store);

    console.log('\ncompare, profile');
    const reference = join(dir, 'reference.png');
    vbprobe('shot', displayed, reference, '--frames', '3');
    ({ out } = vbprobe('compare', displayed, reference, '--frames', '3'));
    check('the same screen is the same', out.includes(`the same as ${reference}`), true);
    {
        const { decodePng, encodePng } = createRequire(import.meta.url)('../../core/lib/probe/index.js');
        const picture = await decodePng(readFileSync(reference));
        picture.rgba[(10 * picture.width + 20) * 4] = 200;
        writeFileSync(join(dir, 'changed.png'), await encodePng(picture));
    }
    const differing = vbprobe('compare', displayed, join(dir, 'changed.png'), '--frames', '3', '--out', join(dir, 'diff.png'));
    check('a pixel changed is found, and the exit says so',
        differing.code === 1 && differing.out.includes('1 of 86016 pixels differ') && differing.out.includes('within 20,10 to 20,10'), true);
    check('... with a picture of where', readFileSync(join(dir, 'diff.png')).subarray(1, 4).toString('latin1'), 'PNG');
    ({ out } = vbprobe('compare', displayed, join(dir, 'changed.png'), '--frames', '3', '--tolerance', '200'));
    check('... and let through with a tolerance', out.includes('the same as'), true);
    ({ out } = vbprobe('profile', rom, '--frames', '5', '--list'));
    check('a profile of the run, frame by frame', /profile: \d+ frames/.test(out) && /busy +\d+\.\d%/.test(out) && out.includes('instructions'), true);

    console.log('\nserve');
    const session = execFileSync(process.execPath, [bin, 'serve', rom], {
        encoding: 'utf8',
        input: [
            'fork a',
            `run --fork a --until ${hex(at.store)}`,
            JSON.stringify({ id: 5, args: ['regs', '--fork', 'a', '--json'] }),
            'fork b --from a',
            'run --fork b --frames 1',
            '',
            `peek --fork a ${hex(COUNTER)}:4 --json`,
            `peek --fork b ${hex(COUNTER)}:4 --json`,
            'forks',
            'regs --fork nobody',
            'quit',
            'forks',
        ].join('\n'),
    });
    const answers = session.trim().split('\n').map(line => JSON.parse(line));
    check('an answer for each request up to quit', answers.length, 9);
    check('a fork, powered on', answers[0].text.startsWith('a: powered on'), true);
    check('... carries on from one request to the next', answers[1].text.includes('stopped (until)'), true);
    check('JSON in, JSON out, with its id', answers[2].id === 5 && answers[2].json.registers.pc === at.store, true);
    check('a fork of a fork', answers[3].text.startsWith('b: a copy of a, standing at'), true);
    check('... runs on its own', answers[4].text.startsWith('frame 1 '), true);
    check('... leaving the first where it was', answers[5].json.peek[0].bytes, '00000000');
    check('... and going on itself', answers[6].json.peek[0].bytes !== '00000000', true);
    check('forks lists them', answers[7].text.split('\n').length, 2);
    check('a mistake is an error, and the server goes on', answers[8].error?.includes('no fork called nobody'), true);

    console.log('\nmistakes');
    failed = vbprobe('peek', rom, 'main');
    check('a symbol without an .elf is explained', failed.code !== 0 && failed.out.includes('no symbols'), true);
    failed = vbprobe('run', rom, '--frams', '2');
    check('an unknown option is refused', failed.code !== 0 && failed.out.includes('Unknown option --frams'), true);
} finally {
    rmSync(dir, { recursive: true, force: true });
}

finish();
