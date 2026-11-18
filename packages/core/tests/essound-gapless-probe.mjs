// checks how ESSound finds the music in an MP3: encoder delay and padding from the LAME extension of the Info frame,
// and the audible window for each way a browser may decode it. A window off by the encoder's 1105 samples is the loop
// gap this removes. Usage: node tests/essound-gapless-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const es = require('../lib/common/emulator-essound.js');

let failures = 0;

function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function near(label, actual, expected) {
    if (Math.abs(actual - expected) > 1e-9) {
        failures++;
        console.log(`  FAIL ${label}: got ${actual}, expected ${expected}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

// the first MP3 frame as LAME and FFmpeg write it: MPEG-1 Layer III header (44.1 kHz, joint stereo), 32 bytes of
// side information, the Info tag (frame count, byte count, seek table, quality), then the LAME extension with
// delay and padding as two 12-bit numbers
function infoFrame({ frames, delay, padding, id3 = 0, tag = 'Info', mono = false }) {
    const head = id3 ? 10 + id3 : 0;
    const bytes = new Uint8Array(head + 417).fill(0);
    if (id3) {
        bytes.set([0x49, 0x44, 0x33, 4, 0, 0], 0);
        bytes.set([(id3 >> 21) & 0x7f, (id3 >> 14) & 0x7f, (id3 >> 7) & 0x7f, id3 & 0x7f], 6);
    }
    bytes.set([0xff, 0xfb, 0x90, mono ? 0xc4 : 0x64], head);
    let at = head + 4 + (mono ? 17 : 32);
    bytes.set([...tag].map(c => c.charCodeAt(0)), at);
    bytes.set([0, 0, 0, 0x0f], at + 4);
    bytes.set([frames >>> 24, (frames >> 16) & 0xff, (frames >> 8) & 0xff, frames & 0xff], at + 8);
    at += 8 + 4 + 4 + 100 + 4;
    bytes.set([...'Lavc61.19'].map(c => c.charCodeAt(0)), at);
    bytes.set([delay >> 4, ((delay & 0x0f) << 4) | (padding >> 8), padding & 0xff], at + 21);
    return bytes;
}

section('Reading the tag');
{
    const info = es.mp3GaplessInfo(infoFrame({ frames: 532, delay: 576, padding: 1674 }));
    check('frames', info.frames, 532);
    check('samples per frame', info.samplesPerFrame, 1152);
    check('sample rate', info.sampleRate, 44100);
    check('delay', info.delay, 576);
    check('padding', info.padding, 1674);

    const behind = es.mp3GaplessInfo(infoFrame({ frames: 10, delay: 576, padding: 100, id3: 300 }));
    check('found behind an ID3v2 tag', behind?.padding, 100);

    const vbr = es.mp3GaplessInfo(infoFrame({ frames: 10, delay: 576, padding: 7, tag: 'Xing' }));
    check('a Xing tag counts too', vbr?.padding, 7);

    const mono = es.mp3GaplessInfo(infoFrame({ frames: 10, delay: 576, padding: 9, mono: true }));
    check('mono side information is shorter', mono?.padding, 9);

    const plain = infoFrame({ frames: 10, delay: 576, padding: 9 });
    plain.set([0x41, 0x42, 0x43, 0x44], 36);
    check('no tag, no information', es.mp3GaplessInfo(plain), undefined);
    check('not an MP3 at all', es.mp3GaplessInfo(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])), undefined);
}

section('The audible window of a decoded track');
{
    const info = { frames: 532, samplesPerFrame: 1152, sampleRate: 44100, delay: 576, padding: 1674 };
    const raw = 532 * 1152;
    const music = raw - 576 - 1674;
    const lead = 576 + es.MP3_DECODER_DELAY;

    // a decoder that honours the tag hands back the music alone
    const trimmed = es.esSoundAudibleWindow(info, music, 44100);
    near('trimmed: from the start', trimmed.start, 0);
    near('trimmed: to the end', trimmed.end, music / 44100);

    // one that decodes every frame keeps the encoder's and its own delay
    const whole = es.esSoundAudibleWindow(info, raw, 44100);
    near('untrimmed: after the delays', whole.start, lead / 44100);
    near('untrimmed: before the padding', whole.end, (lead + music) / 44100);

    // one that also turns the Info frame into a frame of silence
    const withInfo = es.esSoundAudibleWindow(info, raw + 1152, 44100);
    near('Info frame as silence: one frame later', withInfo.start, (1152 + lead) / 44100);
    near('Info frame as silence: end', withInfo.end, (1152 + lead + music) / 44100);

    // decoded at the context's rate, not the file's: same window in seconds
    const resampled = es.esSoundAudibleWindow(info, Math.round(raw * 48000 / 44100), 48000);
    near('resampled: start in seconds', resampled.start, lead / 44100);
    near('resampled: end in seconds', resampled.end, (lead + music) / 44100);

    // a length that fits no known decoder: take it whole rather than guess
    const odd = es.esSoundAudibleWindow(info, raw + 5000, 44100);
    near('unknown: whole start', odd.start, 0);
    near('unknown: whole end', odd.end, (raw + 5000) / 44100);

    const none = es.esSoundAudibleWindow(undefined, 44100, 44100);
    near('no tag: whole', none.end, 1);
}

if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nessound-gapless-probe: all checks passed');
