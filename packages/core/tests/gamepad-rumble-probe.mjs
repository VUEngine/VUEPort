/**
 * Does a game's rumble reach the controller? Without a Rumble Pack, broadcast effects play on a pad's motors
 * (GamepadRumble). Pinned down:
 * - A Play buzzes every pad driving this machine, and only those, as long and hard as the effect's shape says: a click
 *   taps, an alert buzzes 750 ms, a ramp arrives in steps.
 * - The requested frequency is a crossfade between the heavy and the light motor, not an intensity.
 * - A Stop cuts the buzz short.
 * - It stands down while a real Rumble Pack is attached and fed, or when switched off.
 * - A pad without motors is not an error.
 * Usage: node tests/gamepad-rumble-probe.mjs (after `yarn build`)
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = '../lib/';
const { DecodingRumblePack, RUMBLE_CMD, RUMBLE_EFFECT_MAX_MS, rumbleEffectShape, rumbleEffectMs } =
    require(base + 'common/emulator-rumble.js');
const { GamepadRumble, GAMEPAD_PULSE_MS, GAMEPAD_RAMP_STEPS, magnitudes } =
    require(base + 'browser/emulator-gamepad-rumble.js');

let failures = 0;
function check(label, actual, expected) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    if (!same) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}
function section(name) {
    console.log(`\n${name}`);
}

function padWithMotors() {
    const played = [];
    let resets = 0;
    return {
        played,
        resets: () => resets,
        vibrationActuator: {
            playEffect: async (type, params) => {
                played.push({ type, ...params });
                return 'complete';
            },
            reset: async () => {
                resets++;
                return 'complete';
            },
        },
    };
}

const padWithout = { id: 'no motors' };

async function playOne(pack, effect = 14, frequency = 0x90) {
    await pack.sendByte(frequency);
    await pack.sendByte(effect);
    await pack.sendByte(RUMBLE_CMD.PLAY);
}

const after = ms => new Promise(resolve => setTimeout(resolve, ms));

// what an effect was measured to last; see RUMBLE_EFFECT_SHAPES
const lengthOf = effect => rumbleEffectMs(rumbleEffectShape(effect));

section('Splitting one frequency over two motors');
{
    // the pack shakes at one frequency, a pad has a heavy and a light motor: low leans heavy, high leans light, and a
    // game that never said sits in the middle
    check('50 Hz is all the heavy motor', magnitudes(50), { strong: 1, weak: 0.4 });
    check('400 Hz leans on the light one', magnitudes(400), { strong: 0.4, weak: 1 });
    check('160 Hz is between them', magnitudes(160), { strong: 0.811, weak: 0.589 });
    check('and an unsaid frequency is the middle', magnitudes(undefined), { strong: 0.7, weak: 0.7 });
    check('anything past the range is held to it', magnitudes(10_000), { strong: 0.4, weak: 1 });
}

section('A Play reaches the pads');
{
    const pack = new DecodingRumblePack();
    const pad = padWithMotors();
    const rumble = new GamepadRumble(pack, () => [pad, padWithout], () => 1).start();

    // 14 is Strong Buzz at 100 %, which the library calls a long effect
    await playOne(pack, 14);
    check('one pulse, for the one Play', pad.played.length, 1);
    check('as a dual-rumble effect', pad.played[0].type, 'dual-rumble');
    check('for as long as that buzz was measured to last',
        pad.played[0].duration, lengthOf(14));
    check('at the magnitudes 160 Hz asks for',
        [pad.played[0].strongMagnitude, pad.played[0].weakMagnitude], [0.811, 0.589]);
    check('and a pad with no motors is simply passed over', pad.played.length, 1);

    await pack.sendByte(RUMBLE_CMD.PLAY);
    check('a second Play buzzes again', pad.played.length, 2);

    // 1 is Strong Click at 100 %, 3 the same click at 30 %
    await playOne(pack, 1);
    check('a click taps rather than buzzes', pad.played.at(-1).duration, lengthOf(1));
    check('and a tap is a good deal shorter than a buzz', lengthOf(1) < lengthOf(14) / 2, true);
    const loud = pad.played.at(-1).strongMagnitude;
    await playOne(pack, 3);
    check('and the same click at 30 % is three tenths as strong',
        pad.played.at(-1).strongMagnitude, Number((loud * 0.3).toFixed(3)));

    // 15 is the one effect whose name gives its length, so the pad can be checked against something other than itself
    await playOne(pack, 15);
    check('an alert runs for about the 750 ms it is named after',
        Math.abs(pad.played.at(-1).duration - 750) < 60, true, `${pad.played.at(-1).duration} ms`);

    // 118 is the one effect with no length of its own: it runs until a Stop, so the ceiling ends it here
    await playOne(pack, 118);
    check('and the buzz built to be stopped runs to the ceiling',
        pad.played.at(-1).duration, RUMBLE_EFFECT_MAX_MS);

    await pack.sendByte(RUMBLE_CMD.STOP);
    check('and a Stop cuts it short', pad.resets(), 1);

    rumble.dispose();
}

section('A ramp arrives as a ramp');
{
    // playEffect holds one magnitude for its whole duration, so a rise is several of them. 110 is Transition Ramp Up
    // Short Smooth 1, from nothing to half strength over the shortest ramp there is
    const pack = new DecodingRumblePack();
    const pad = padWithMotors();
    const rumble = new GamepadRumble(pack, () => [pad], () => 1).start();

    await playOne(pack, 110);
    check('the first step is played at once', pad.played.length, 1);
    await after(lengthOf(110) + 120);
    check('and the rest follow it', pad.played.length, GAMEPAD_RAMP_STEPS);
    const share = Math.round(lengthOf(110) / GAMEPAD_RAMP_STEPS);
    check('each for its share of the ramp',
        pad.played.every(one => one.duration === share), true,
        JSON.stringify(pad.played.map(one => one.duration)));
    const rising = pad.played.map(one => one.strongMagnitude);
    check('climbing all the way', rising.every((value, at) => at === 0 || value > rising[at - 1]),
        true, JSON.stringify(rising));
    check('starting under half strength', rising[0] < rising.at(-1) / 2, true);

    // 74 is the same ramp the other way: 100 % down to nothing
    pad.played.length = 0;
    await playOne(pack, 74);
    await after(lengthOf(74) + 120);
    const falling = pad.played.map(one => one.strongMagnitude);
    check('and a ramp down falls', falling.every((value, at) => at === 0 || value < falling[at - 1]),
        true, JSON.stringify(falling));

    pad.played.length = 0;
    await playOne(pack, 70);
    await pack.sendByte(RUMBLE_CMD.STOP);
    await after(lengthOf(70) + 120);
    check('and a Stop drops the steps that had not happened yet',
        pad.played.length, 1);

    rumble.dispose();
}

section('What it does not do');
{
    const pack = new DecodingRumblePack();
    const pad = padWithMotors();
    let intensity = 0;
    const rumble = new GamepadRumble(pack, () => [pad], () => intensity).start();

    await playOne(pack);
    check('nothing at all while it is at 0', pad.played.length, 0);

    intensity = 1;
    await playOne(pack);
    check('and everything once it is up', pad.played.length, 1);

    const full = pad.played.at(-1).strongMagnitude;
    intensity = 0.4;
    await playOne(pack);
    check('at 40% the motors pull 40% as hard', pad.played.at(-1).strongMagnitude, Number((full * 0.4).toFixed(3)));
    intensity = 1;

    // the pack is the device the game was written for; with one plugged in, the pad stays quiet
    pack.forwarding = true;
    Object.defineProperty(pack, 'connected', { get: () => true });
    await playOne(pack);
    check('it stands down while a real pack is being fed', pad.played.length, 2);

    rumble.dispose();
    check('and disposing silences whatever was running', pad.resets() > 0, true);
}

section('Once it has let go');
{
    const pack = new DecodingRumblePack();
    const pad = padWithMotors();
    new GamepadRumble(pack, () => [pad], () => 1).start().dispose();
    await playOne(pack);
    check('a disposed one hears nothing more', pad.played.length, 0);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
