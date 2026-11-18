// checks every shipped cheat, patch and snapshot achievement has its text in i18n/nls.json under the key
// emulator-catalog-nls.ts builds, translated in every language, reworded achievements falling back to English.
// Keys are built from ids, so nls-extract cannot see them. Usage: node tests/catalog-nls-probe.mjs
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ext = '../';
const { flattenTranslations, setLocalization, useTranslations } = require(ext + 'lib/common/emulator-nls.js');
const { CHEAT_DATABASE } = require(ext + 'lib/common/emulator-cheat-database.js');
const {
    PATCH_DATABASE,
    PATCH_DESCRIPTION_INTROS,
    PATCH_SHARED_NAMES,
} = require(ext + 'lib/common/emulator-patch-database.js');
const catalog = require(ext + 'lib/common/emulator-catalog-nls.js');
const snapshot = JSON.parse(readFileSync(new URL('../src/data/retroachievements-vb.json', import.meta.url), 'utf8'));

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

// every text as [label, English, translate, key?]: what the stores call to show it, and the key when that
// call asks for more than one
const texts = [
    ...CHEAT_DATABASE.flatMap(game => game.cheats.flatMap(cheat => [
        [`cheat ${cheat.id}: title`, cheat.description, () => catalog.cheatTitle(cheat)],
        ...(cheat.notes === undefined ? [] : [[`cheat ${cheat.id}: notes`, cheat.notes, () => catalog.cheatNotes(cheat)]]),
    ])),
    ...PATCH_DATABASE.flatMap(game => game.patches.flatMap(patch => [
        // own name and text only; shared ones are checked once, below
        ...(patch.name === undefined ? [] : [[`patch ${patch.id}: name`, patch.name, () => catalog.patchName(patch)]]),
        ...(patch.description === undefined ? [] : [[`patch ${patch.id}: description`, patch.description,
            () => catalog.patchDescription({ ...patch, descriptionIntro: undefined })]]),
    ])),
    ...Object.entries(PATCH_SHARED_NAMES).map(([key, text]) => [`shared patch name ${key}`, text,
        () => catalog.patchName({ id: 'shared', sharedName: key })]),
    ...Object.entries(PATCH_DESCRIPTION_INTROS).map(([key, text]) => [`patch description intro ${key}`, text,
        () => catalog.patchDescription({ id: 'intro', descriptionIntro: key })]),
    ...snapshot.games.flatMap(game => game.achievements.flatMap(achievement => [
        [`achievement ${achievement.id}: title`, achievement.title,
            () => catalog.localizeAchievement(achievement).title,
            catalog.achievementTextKey(achievement.id, 'title', achievement.title)],
        [`achievement ${achievement.id}: description`, achievement.description,
            () => catalog.localizeAchievement(achievement).description,
            catalog.achievementTextKey(achievement.id, 'description', achievement.description)],
    ])),
];

function keyOf(translate) {
    let asked;
    setLocalization((key, defaultValue) => {
        asked = key;
        return defaultValue;
    });
    translate();
    return asked;
}

const i18n = new URL('../i18n/', import.meta.url);
const read = name => flattenTranslations(JSON.parse(readFileSync(new URL(name, i18n), 'utf8')));

section('English: nls.json holds every catalog text, as the catalog has it');
const english = read('nls.json');
const keys = texts.map(([label, text, translate, key]) => [label, text, translate, key ?? keyOf(translate)]);
check('every text has a key of its own', new Set(keys.map(([, , , key]) => key)).size, keys.length);
for (const [label, text, , key] of keys) {
    check(`${label} (${key})`, english[key], text);
}

const languages = readdirSync(i18n).filter(name => /^nls\.[a-z-]+\.json$/.test(name)).sort();
check('there are translations to check', languages.length > 0, true);
for (const language of languages) {
    section(`${language}: every catalog text is translated`);
    const translated = read(language);
    const missing = keys.filter(([, , , key]) => typeof translated[key] !== 'string' || translated[key].trim() === '');
    check('nothing is missing', missing.map(([label]) => label), []);
    useTranslations(JSON.parse(readFileSync(new URL(language, i18n), 'utf8')));
    const shown = keys.filter(([, , translate, key]) => translate() !== translated[key]);
    check('what the stores show is the translation', shown.map(([label]) => label), []);
}

section('A description with an intro and a text of its own');
{
    useTranslations(JSON.parse(readFileSync(new URL('nls.de.json', i18n), 'utf8')));
    const patch = PATCH_DATABASE.flatMap(game => game.patches).find(found => found.id === 'virtual-lab/vb-color');
    const german = read('nls.de.json');
    check('is both, as two paragraphs, in the player\'s language', catalog.patchDescription(patch),
        `${german['vueport/patchDatabase/vbColorDescriptionIntro']}\n\n`
        + german['vueport/patchDatabase/virtual-lab/vb-color/description']);
    const introOnly = PATCH_DATABASE.flatMap(game => game.patches).find(found => found.id === 'zero-racers/vb-color');
    check('one with only the intro is the intro', catalog.patchDescription(introOnly),
        german['vueport/patchDatabase/vbColorDescriptionIntro']);
}

section('An achievement reworded since it was translated');
{
    useTranslations(JSON.parse(readFileSync(new URL('nls.de.json', i18n), 'utf8')));
    const achievement = snapshot.games[0].achievements[0];
    const translated = catalog.localizeAchievement(achievement);
    check('as shipped, it is translated', translated.title !== achievement.title, true);
    const reworded = { ...achievement, title: `${achievement.title}!` };
    check('reworded, it shows its new English', catalog.localizeAchievement(reworded).title, reworded.title);
    check('and the rest of it is left alone', catalog.localizeAchievement(reworded).points, achievement.points);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
