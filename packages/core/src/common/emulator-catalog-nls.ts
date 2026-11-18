/**
 * Translations of the shipped catalogs (cheats, ROM patches and colorizations) and of RetroAchievements achievements.
 * Entry texts are translated under keys built from the stable id (`vueport/cheatDatabase/<id>/title`,
 * `vueport/patchDatabase/<id>/name`...), with the English as the default. Shared patch names and description intros are
 * translated once (PATCH_SHARED_NAMES, PATCH_DESCRIPTION_INTROS).
 *
 * `yarn nls-extract` cannot follow built keys, so their i18n/nls.json entries are kept by hand, and
 * tests/catalog-nls-probe.mjs checks that every entry has them in every shipped language. Called when an entry is shown
 * or loaded, never at module load (see emulator-nls.ts).
 *
 * An achievement's key also carries the CRC32 of its English (`vueport/achievementDatabase/56777/title-<crc32>`), so
 * one reworded by its RetroAchievements authors shows the new English rather than a translation of the old.
 */

import { BuiltInCheat, crc32, formatRomId } from './emulator-cheat-database';
import { nls } from './emulator-nls';
import { BuiltInRomPatch, PATCH_DESCRIPTION_INTROS, PATCH_SHARED_NAMES } from './emulator-patch-database';

export function cheatTitle(cheat: BuiltInCheat): string {
    return nls.localize(`vueport/cheatDatabase/${cheat.id}/title`, cheat.description);
}

export function cheatNotes(cheat: BuiltInCheat): string | undefined {
    return cheat.notes === undefined
        ? undefined
        : nls.localize(`vueport/cheatDatabase/${cheat.id}/notes`, cheat.notes);
}

export function patchName(patch: BuiltInRomPatch): string {
    return patch.sharedName === undefined
        ? nls.localize(`vueport/patchDatabase/${patch.id}/name`, patch.name)
        : nls.localize(`vueport/patchDatabase/${patch.sharedName}`, PATCH_SHARED_NAMES[patch.sharedName]);
}

export function patchDescription(patch: BuiltInRomPatch): string | undefined {
    const intro = patch.descriptionIntro === undefined
        ? undefined
        : nls.localize(`vueport/patchDatabase/${patch.descriptionIntro}`,
            PATCH_DESCRIPTION_INTROS[patch.descriptionIntro]);
    const own = patch.description === undefined
        ? undefined
        : nls.localize(`vueport/patchDatabase/${patch.id}/description`, patch.description);
    return intro !== undefined && own !== undefined ? `${intro}\n\n${own}` : intro ?? own;
}

export function achievementTextKey(id: number, field: 'title' | 'description', english: string): string {
    return `vueport/achievementDatabase/${id}/${field}-${formatRomId(crc32(new TextEncoder().encode(english)))}`;
}

export function localizeAchievement<T extends { id: number, title: string, description: string }>(achievement: T): T {
    return {
        ...achievement,
        title: nls.localize(achievementTextKey(achievement.id, 'title', achievement.title), achievement.title),
        description: nls.localize(
            achievementTextKey(achievement.id, 'description', achievement.description), achievement.description),
    };
}
