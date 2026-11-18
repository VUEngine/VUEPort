/**
 * Checks the emulator's own translations without a host: a shipped file is flattened into the call sites' keys,
 * translated strings come back translated, untranslated ones fall back to the call site's English default, and format
 * arguments substitute either way. vueport.net and the native wrapper rely on this; in VES, Theia supplies the
 * implementation (see setLocalization in the emulator's frontend module).
 * Usage: node tests/nls-probe.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ext = '../';
const { nls, useTranslations, flattenTranslations } =
    require(ext + 'lib/common/emulator-nls.js');

let failures = 0;

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

section('Flattening a shipped file');
{
    // `/` rather than Theia's `.`, as the keys in the source are written with it
    check('nested objects become slash-separated keys',
        flattenTranslations({ vueport: { a: 'A', b: { c: 'C' } } }),
        { 'vueport/a': 'A', 'vueport/b/c': 'C' });
}

section('With no translation installed');
{
    check('the English default is what shows',
        nls.localize('vueport/state/pause', 'Pause'), 'Pause');
}

section('With the shipped German file');
{
    useTranslations(require(ext + 'i18n/nls.de.json'));
    check('a translated string is translated',
        nls.localize('vueport/state/mute', 'Mute'), 'Stummschalten');
    check('and another', nls.localize('vueport/state/resume', 'Resume'), 'Fortsetzen');
    // a partial translation has to read as English where it stops rather than as a blank
    check('an untranslated key falls back to its English default',
        nls.localize('vueport/debug/panels/worlds/title', 'Worlds'), 'Worlds');
}

section('Format arguments');
{
    useTranslations({ vueport: { objectCount: '{0} Objekte', both: '{0} von {1}' } });
    check('substitute into a translation',
        nls.localize('vueport/objectCount', '{0} objects', 7), '7 Objekte');
    check('substitute more than one',
        nls.localize('vueport/both', '{0} of {1}', 'a', 'b'), 'a von b');
    check('and substitute into the English fallback too',
        nls.localize('vueport/absent', '{0} left', 3), '3 left');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
