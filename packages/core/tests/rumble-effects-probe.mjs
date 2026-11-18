/**
 * The emulator's copy of the rumble pack's built-in effect names: all 123 there, translated when the host has a
 * translation and English otherwise, numbers substituted, and an unknown effect shown as its number. Also the status
 * strip, including a pack whose link port a second player's cable has taken (applyRumbleForwarding in web-emulator.tsx),
 * and that a host that can never reach a pack still decodes what the game sends (DecodingRumblePack). The table is a
 * deliberate copy of VES's, so nothing under emulator/ reaches into rumble-pack/; it is checked on its own terms, as the
 * two may drift.
 * Usage: node tests/rumble-effects-probe.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = '../lib/common/';
const {
    getRumbleEffectName, builtInRumbleEffects, NO_RUMBLE_PACK, DecodingRumblePack, RUMBLE_CMD,
    isRumblePlaying, RUMBLE_EFFECT_MAX_MS, SerialRumblePack, rumblePackName,
    RUMBLE_EFFECT_SHAPES, rumbleEffectShape, rumbleEffectMs,
} = require(base + 'emulator-rumble.js');
const { useTranslations } = require(base + 'emulator-nls.js');
const { formatRumblePack, STATUS_NONE } = require('../lib/browser/emulator-status.js');

let failures = 0;

function check(label, actual, expected) {
    if (actual !== expected) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

// the table is built on first use, so the translation has to be in place first, which is the start-up order
useTranslations({
    vueport: { debug: { panels: { rumblePack: { effects: { names: { strongClick: 'Starker Klick' } } } } } },
});

section('The table');
{
    check('holds every effect the pack has', builtInRumbleEffects().length, 123);
}

section('Naming an effect');
{
    check('a translated name is translated, and keeps its number',
        getRumbleEffectName(1), '1) Starker Klick - 100 %');
    check('an untranslated one falls back to English',
        getRumbleEffectName(4), '4) Sharp Click - 100 %');
    check('a name carrying a number substitutes it',
        getRumbleEffectName(123), '123) Smooth Hum 5 (No kick or brake pulse) – 10 %');
    check('an effect the pack does not have shows as its number',
        getRumbleEffectName(999), '999');
}

section('A host with no pack');
{
    check('reports nothing connected', NO_RUMBLE_PACK.connected, false);
    check('and no device name', NO_RUMBLE_PACK.deviceName, undefined);
    check('and no traffic', NO_RUMBLE_PACK.emulatedByteCount, 0);
    check('and is never the thing holding the link port', NO_RUMBLE_PACK.linkPortInUse, false);
}

section('A host that can never reach one');
{
    const pack = new DecodingRumblePack();
    check('says so, rather than reading as one not plugged in yet',
        pack.canConnect, false);
    check('and has nothing to offer a Detect button', pack.connected, false);

    let changes = 0;
    pack.onDidChangeConnected(() => changes++);

    await pack.sendByte(0x90);
    await pack.sendByte(14);
    await pack.sendByte(RUMBLE_CMD.PLAY);

    check('counts every byte the game sent', pack.emulatedByteCount, 3);
    check('decodes each of them into a command', pack.emulatedCommands.length, 3);
    check('and reads the effect off them', pack.emulatedRumbleState.effect, 14);
    check('and the frequency', pack.emulatedRumbleState.frequency, 160);
    check('and that the motor is running', pack.emulatedRumbleState.playing, true);
    // keeps the panel's motor box in step: polling once a second would show an effect after it had finished
    check('with one change event per byte, for the panel to redraw on', changes, 3);

    await pack.sendByte(RUMBLE_CMD.STOP);
    check('and that it has stopped', pack.emulatedRumbleState.playing, false);

    pack.clearEmulatedTraffic();
    check('clearing takes the traffic', pack.emulatedByteCount, 0);
    check('and the commands with it', pack.emulatedCommands.length, 0);
    check('and forgets the effect', pack.emulatedRumbleState.effect, undefined);
}

// a game is not obliged to end what it started: effects stop by themselves, a Stop only cuts one short. Without this,
// one Play without a Stop left the panel claiming a running motor for the rest of the session
section('When an effect is over');
{
    const pack = new DecodingRumblePack();
    const started = Date.now();
    await pack.sendByte(RUMBLE_CMD.PLAY);
    const state = pack.emulatedRumbleState;

    check('the game said play, and the state says so',
        state.playing, true);
    check('and remembers when', typeof state.playingSince, 'number');
    // against the ceiling rather than a number, as its value is a judgement call that has been revised before
    check('so it is playing now', isRumblePlaying(state, started), true);
    check('and still playing just short of its ceiling',
        isRumblePlaying(state, started + RUMBLE_EFFECT_MAX_MS - 100), true);
    check('but over once the ceiling has passed, with no Stop in sight',
        isRumblePlaying(state, started + RUMBLE_EFFECT_MAX_MS + 1), false);
    check('while the raw state still says what the game asked for',
        state.playing, true);

    // replaying the same effect starts it again, so the clock starts again with it
    await pack.sendByte(RUMBLE_CMD.PLAY);
    check('a second Play runs its own length from itself',
        isRumblePlaying(state, started + RUMBLE_EFFECT_MAX_MS - 100), true);
    check('and counts as its own effect, even in the same millisecond',
        state.plays, 2);

    await pack.sendByte(RUMBLE_CMD.STOP);
    check('and a Stop ends it there and then', isRumblePlaying(state), false);
    check('with nothing left to count from', state.playingSince, undefined);
}

// the ceiling is the cap, not the answer: an effect whose name says how long it runs is over then (see
// RUMBLE_EFFECT_SHAPES)
section('An effect is as long as its own name');
{
    const pack = new DecodingRumblePack();
    // 1 is Strong Click at 100 %: a tap, measured at a tenth of a second
    await pack.sendByte(1);
    await pack.sendByte(RUMBLE_CMD.PLAY);
    const state = pack.emulatedRumbleState;
    const click = rumbleEffectMs(rumbleEffectShape(1));
    const started = state.playingSince;
    check('a click is still going the moment it starts', isRumblePlaying(state, started), true);
    check('and over once its own length has passed',
        isRumblePlaying(state, started + click + 1), false);
    check('which is well before the ceiling would have ended it',
        click < RUMBLE_EFFECT_MAX_MS / 2, true, `${click} ms`);

    // 16 is the 1000 ms alert, which measured a little past the ceiling, the one effect it would cut short
    await pack.sendByte(16);
    await pack.sendByte(RUMBLE_CMD.PLAY);
    const alert = state.playingSince;
    check('the longest alert is not cut off at the ceiling',
        isRumblePlaying(state, alert + RUMBLE_EFFECT_MAX_MS + 10), true);
    check('but is over at its own length',
        isRumblePlaying(state, alert + rumbleEffectMs(rumbleEffectShape(16)) + 1), false);

    // 118 has no length of its own, so the ceiling ends it
    await pack.sendByte(118);
    await pack.sendByte(RUMBLE_CMD.PLAY);
    const buzz = state.playingSince;
    check('the buzz built to be stopped runs to the ceiling',
        isRumblePlaying(state, buzz + RUMBLE_EFFECT_MAX_MS - 50), true);
    check('but no further', isRumblePlaying(state, buzz + RUMBLE_EFFECT_MAX_MS + 1), false);
}

section('Driving the wire');
{
    class ProbePack extends SerialRumblePack {
        written = [];
        overlaps = 0;
        busy = false;
        gaps = [];
        last = 0;

        get canConnect() { return true; }
        async start() { this.attached({ name: 'Probe', vendor: 1, product: 2 }); }

        async write(text) {
            if (this.busy) {
                this.overlaps++;
            }
            this.busy = true;
            const now = Date.now();
            if (this.written.length > 0) {
                this.gaps.push(now - this.last);
            }
            this.last = now;
            this.written.push(text);
            await new Promise(resolve => setTimeout(resolve, 1));
            this.busy = false;
        }
    }
    const idle = () => new Promise(resolve => setTimeout(resolve, 60));

    const pack = new ProbePack();
    await pack.start();

    // as the emulator sends them: every byte of a burst at once, none awaited, as a link-port callback does
    const burst = [0x90, 0x0e, RUMBLE_CMD.PLAY, RUMBLE_CMD.STOP];
    burst.forEach(byte => { pack.sendByte(byte); });
    // the first command goes out at once and the rest wait their turn; the game's callback must not be held behind
    // four writes
    check('the caller is not held behind the wire', pack.written.length <= 1, true);

    for (let waited = 0; waited < 40 && pack.written.length < 4; waited++) {
        await idle();
    }
    check('every byte reaches the wire', pack.written.length, 4);
    check('in the order the game sent them, framed the way the board reads them',
        pack.written.join(' '), '<VB 144> <VB 014> <VB 124> <VB 000>');
    check('and never two at once, whatever the transport would have done',
        pack.overlaps, 0);
    check('with the board given room between them',
        pack.gaps.every(gap => gap >= SerialRumblePack.WRITE_GAP_MS - 1), true);

    // more than the board can take; the bound keeps a backlog from playing out minutes after its moment
    const flooded = new ProbePack();
    await flooded.start();
    for (let byte = 0; byte < 200; byte++) {
        flooded.sendByte(1);
    }
    check('a flood is bounded rather than queued forever',
        flooded.droppedCommands > 0, true);
    check('and what is dropped is counted',
        flooded.droppedCommands >= 200 - SerialRumblePack.MAX_QUEUED - 1, true);

    // an emergency stop is not owed the backlog first
    const stopping = new ProbePack();
    await stopping.start();
    for (let byte = 0; byte < 20; byte++) {
        stopping.sendByte(1);
    }
    await stopping.stop();
    await idle();
    check('a Stop goes out early rather than after the backlog',
        stopping.written.includes('<STP>'), true);
    check('and the backlog goes with it', stopping.written.length <= 3, true);
}

section('What the strip says about a pack');
{
    const reading = pack => formatRumblePack({ rumblePack: pack });
    check('nothing, with none plugged in',
        reading({ connected: false }), STATUS_NONE);
    check('its own name where it gives one',
        reading({ connected: true, deviceName: 'VUEngine Rumble Pack' }),
        'VUEngine Rumble Pack');
    check('that it is simply there where it does not',
        reading({ connected: true, deviceName: undefined }), 'connected');
    // the name would read as "working": the cable and the pack want the same socket, so the cable has it
    check('and that it is switched off while a cable has the port',
        reading({ connected: true, deviceName: 'VUEngine Rumble Pack', linkPortInUse: true }),
        'off (linked)');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
