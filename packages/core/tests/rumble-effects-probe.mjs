// Checks the emulator's own copy of the rumble pack's built-in effect names:
// that all 123 are there, that a name is translated when the host has a
// translation and falls back to English when it does not, that the few names
// carrying a number substitute it, and that an effect the pack does not have
// shows as its own number rather than as nothing.
//
// The table is a deliberate copy of VES's, so that nothing under
// `emulator/` reaches into `rumble-pack/`. It is checked on its own terms
// rather than against the original, because the two are allowed to drift.
//
// Usage: node tests/rumble-effects-probe.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = '../lib/common/';
const { getRumbleEffectName, builtInRumbleEffects, NO_RUMBLE_PACK } =
    require(base + 'emulator-rumble.js');
const { useTranslations } = require(base + 'emulator-nls.js');

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

// The table is built on first use, so the host's translation has to be in place
// before anything asks for a name — which is the order start-up runs in.
useTranslations({
    vueport: { rumbleEffect: { effects: { strongClick: 'Starker Klick' } } },
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
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
