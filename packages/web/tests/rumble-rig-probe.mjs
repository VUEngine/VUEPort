/**
 * Checks the arithmetic of tools/rumble-durations.html (where an effect starts and ends, how many knocks, whether it
 * stops) against signals of known length; the rig is to replace seven estimated numbers with 123 measured ones. A fake
 * navigator.serial records what the rig writes, and the microphone is a tone generator the fake pack drives, so a
 * <VB 124> plays a burst of the length this probe decided. Not checked: the real pack's ring-out, room noise, and
 * whether a Smooth Hum at 10 % is audible at all.
 *
 * Usage: node tests/rumble-rig-probe.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(__dirname, '..', 'tools', 'rumble-durations.html');

let failures = 0;
function check(label, ok, detail) {
    if (!ok) {
        failures++;
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
}
const report = (label, value) => console.log(`  --   ${label}: ${value}`);

const server = createServer(async (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(page));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// chosen for the four answers the rig has to get right
const TRUTH = {
    1: { bursts: [[0, 60]] }, // a tap
    10: { bursts: [[0, 40], [120, 40]] }, // two knocks with a gap
    14: { bursts: [[0, 1000]] }, // the long buzz the rig's calibration finds the pack with
    15: { bursts: [[0, 750]] }, // a length the library states outright
    123: { open: true }, // never stops
};

const FAKE = truth => {
    // a pack that is a tone generator: one oscillator behind a gain the serial writes drive (Play schedules the
    // effect's bursts, Stop takes the gain to nothing), and getUserMedia hands back that same signal
    window.__truth = truth;
    window.__written = [];
    let audio;
    let gain;
    let stream;

    const ensure = () => {
        if (audio) {
            return;
        }
        audio = new AudioContext();
        const tone = audio.createOscillator();
        tone.frequency.value = 200;
        gain = audio.createGain();
        gain.gain.value = 0;
        // a floor, so the rig's calibration has a room to measure rather than digital silence
        const hiss = audio.createGain();
        hiss.gain.value = 0.0004;
        const noise = audio.createOscillator();
        noise.frequency.value = 3000;
        const out = audio.createMediaStreamDestination();
        tone.connect(gain).connect(out);
        noise.connect(hiss).connect(out);
        tone.start();
        noise.start();
        stream = out.stream;
    };

    let pending;
    const play = effect => {
        const shape = window.__truth[effect];
        if (!shape || !gain) {
            return;
        }
        const now = audio.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0, now);
        if (shape.open) {
            gain.gain.setValueAtTime(0.25, now);
            return;
        }
        for (const [at, length] of shape.bursts) {
            gain.gain.setValueAtTime(0.25, now + at / 1000);
            gain.gain.setValueAtTime(0, now + (at + length) / 1000);
        }
    };

    const port = {
        getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x8036 }),
        readable: new ReadableStream({ start() { } }),
        writable: new WritableStream({
            write(chunk) {
                const text = new TextDecoder().decode(chunk).trim();
                window.__written.push(text);
                const byte = /^<VB (\d+)>$/.exec(text);
                if (!byte) {
                    return;
                }
                const value = Number(byte[1]);
                if (value === 124) {
                    play(pending);
                } else if (value === 0) {
                    if (gain) {
                        gain.gain.cancelScheduledValues(audio.currentTime);
                        gain.gain.setValueAtTime(0, audio.currentTime);
                    }
                } else if (window.__truth[value]) {
                    pending = value;
                }
            },
        }),
        open: async () => undefined,
        close: async () => undefined,
    };

    Object.defineProperty(Navigator.prototype, 'serial', {
        configurable: true,
        value: {
            getPorts: async () => [port],
            requestPort: async () => port,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => true,
        },
    });

    navigator.mediaDevices.getUserMedia = async () => {
        ensure();
        await audio.resume();
        return stream;
    };
};

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer.\n');
    server.close();
    process.exit(1);
}

const browser = await puppeteer.launch({
    args: [
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        // a fake capture device, so nothing asks for permission (the rig's getUserMedia is replaced anyway)
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-capture',
        // a fake audio sink that still ticks: see two-window-link-probe.mjs
        '--disable-audio-output',
    ],
});
const browserPage = await browser.newPage();
const errors = [];
browserPage.on('pageerror', error => errors.push(String(error)));
browserPage.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
await browserPage.evaluateOnNewDocument(FAKE, TRUTH);
await browserPage.goto(origin, { waitUntil: 'networkidle0' });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = id => browserPage.$eval(`#${id}`, node => node.textContent.trim());

async function finish() {
    await browser.close();
    server.close();
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

console.log('\nSetting up');
{
    await browserPage.click('#connect');
    await wait(500);
    check('the pack is found', (await state('packState')).includes('connected'),
        await state('packState'));

    await browserPage.click('#listen');
    await wait(800);
    check('the microphone is listening', (await state('audioState')).includes('listening'),
        await state('audioState'));
}

console.log('\nCalibration');
{
    await browserPage.click('#calibrate');
    await wait(4000);
    const said = await state('audioState');
    report('calibration', said);
    check('it is ready to measure', said.includes('ready'), said);
    // the fake pack buzzes at 200 Hz; a rig finding something else would filter out the sound it listens for
    const peak = Number(/peak (\d+) Hz/.exec(said)?.[1]);
    check('and found the pack where it actually is', Math.abs(peak - 200) <= 25, `${peak} Hz`);
}

console.log('\nMeasuring effects of known length');
{
    await browserPage.$eval('#repeats', node => { node.value = '2'; });
    await browserPage.$eval('#from', node => { node.value = '1'; });
    await browserPage.$eval('#to', node => { node.value = '15'; });
    await browserPage.click('#run');

    for (let waited = 0; waited < 120; waited++) {
        if ((await state('progress')) === 'done') {
            break;
        }
        await wait(500);
    }
    check('the sweep finishes', (await state('progress')) === 'done', await state('progress'));

    const out = JSON.parse(await browserPage.$eval('#json', node => node.value));
    const by = effect => out.results.find(row => row.effect === effect);
    report('measured', JSON.stringify(out.results.filter(row => TRUTH[row.effect])));

    // the rig's resolution is one envelope block, 2.7 ms, and the filter smears a burst's edges, so this checks
    // "a tap and not a buzz" rather than the millisecond
    check('a 60 ms tap measures as a tap', Math.abs(by(1).ms - 60) <= 40, `${by(1).ms} ms`);
    check('and as one knock', by(1).pulses, 1);

    // two knocks 120 ms apart: what the names never say, and why pulses are counted at all
    check('a double knock measures as two', by(10).pulses, 2);
    check('over the span of both', Math.abs(by(10).ms - 160) <= 50, `${by(10).ms} ms`);

    // the one length the library states outright, so the one measurement that can be right or wrong
    check('a 750 ms alert measures as 750', Math.abs(by(15).ms - 750) <= 80, `${by(15).ms} ms`);

    check('nothing measured is called open-ended',
        [1, 10, 15].every(effect => by(effect).open === false),
        JSON.stringify([1, 10, 15].map(effect => by(effect).open)));
    check('and every effect was heard well over the room',
        [1, 10, 15].every(effect => by(effect).snr > 4),
        JSON.stringify([1, 10, 15].map(effect => by(effect).snr)));
}

console.log('\nAn effect that never stops');
{
    await browserPage.$eval('#from', node => { node.value = '123'; });
    await browserPage.$eval('#to', node => { node.value = '123'; });
    await browserPage.$eval('#repeats', node => { node.value = '1'; });
    await browserPage.click('#run');
    for (let waited = 0; waited < 40; waited++) {
        if ((await state('progress')) === 'done') {
            break;
        }
        await wait(500);
    }
    const out = JSON.parse(await browserPage.$eval('#json', node => node.value));
    const hum = out.results.find(row => row.effect === 123);
    report('hum', JSON.stringify(hum));
    check('is stopped at the cap and said to be open-ended', hum.open, true);
    check('and is at least as long as the cap allowed',
        hum.ms >= out.capMs - 400, `${hum.ms} of ${out.capMs} ms`);
    check('nothing errored', errors.length === 0, errors.join(' | '));
}

await finish();
