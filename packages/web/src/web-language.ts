// web only, the studio follows its application. Nothing is stored until the user chooses, so a first visit follows the
// browser

import { nls } from 'vueport-core/lib/common/emulator-nls';
import { WebUi } from './web-ui';

const STORAGE_KEY = 'vueport.language';

export const DEFAULT_LANGUAGE = 'en'; // the untranslated build, which ships no file of its own

// in the picker's order, which is the file sort order
export const TRANSLATED_LANGUAGES = [
    'cs', 'de', 'es', 'fr', 'hu', 'it', 'ja', 'pl', 'pt-br', 'pt-pt', 'ru', 'zh-cn',
];

export const LANGUAGES = [DEFAULT_LANGUAGE, ...TRANSLATED_LANGUAGES];

// fallback for when `Intl.DisplayNames` has no data and answers with the tag
const ENDONYMS: Record<string, string> = {
    'en': 'English',
    'cs': 'Čeština',
    'de': 'Deutsch',
    'es': 'Español',
    'fr': 'Français',
    'hu': 'Magyar',
    'it': 'Italiano',
    'ja': '日本語',
    'pl': 'Polski',
    'pt-br': 'Português (Brasil)',
    'pt-pt': 'Português (Portugal)',
    'ru': 'Русский',
    'zh-cn': '中文（简体）',
};

// the language's name in that language
export function languageName(tag: string): string {
    try {
        const names = new Intl.DisplayNames([tag], { type: 'language' });
        const name = names.of(tag);
        // a browser with no data for the tag hands the tag straight back
        if (name && name.toLowerCase() !== tag.toLowerCase()) {
            return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
        }
    } catch {
        // Intl throws on a malformed tag rather than returning undefined
    }
    return ENDONYMS[tag] ?? tag;
}

// `navigator.languages` is in preference order, first match wins. A regional tag falls back to its base (`de-AT` takes
// `de`), except where regions ship separately, as with Portuguese
export function pickLocale(languages: readonly string[]): string | undefined {
    for (const language of languages) {
        const tag = language.toLowerCase();
        if (TRANSLATED_LANGUAGES.includes(tag)) {
            return tag;
        }
        const base = tag.split('-')[0];
        if (TRANSLATED_LANGUAGES.includes(base)) {
            return base;
        }
        if (base === DEFAULT_LANGUAGE) {
            return undefined;
        }
        // pt and zh ship only as regional variants; take the commoner one
        if (base === 'pt') {
            return 'pt-pt';
        }
        if (base === 'zh') {
            return 'zh-cn';
        }
    }
    return undefined;
}

// undefined while following the browser
export function storedLanguage(): string | undefined {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored && LANGUAGES.includes(stored) ? stored : undefined;
    } catch {
        return undefined;
    }
}

// only for an explicit choice, so a detected language is never stored and a reconfigured browser is followed
export function rememberLanguage(tag: string | undefined): void {
    try {
        if (tag === undefined) {
            window.localStorage.removeItem(STORAGE_KEY);
        } else {
            window.localStorage.setItem(STORAGE_KEY, tag);
        }
    } catch {
        // private browsing or a full quota: the choice still applies to this page, it is just not remembered
    }
}

export function detectedLanguage(): string {
    return pickLocale(navigator.languages ?? [navigator.language]) ?? DEFAULT_LANGUAGE;
}

export function activeLanguage(): string {
    return storedLanguage() ?? detectedLanguage();
}

// reloads rather than re-renders, as the label tables in `vueport-core` are built on first use and cached for the life
// of the process
export async function pickLanguage(ui: WebUi): Promise<void> {
    const auto = detectedLanguage();
    const chosen = storedLanguage();
    const picked = await ui.pick(nls.localize('vueport/status/language', 'Language'), [
        {
            id: 'system',
            label: nls.localize('vueport/language/system', 'System Language'),
            description: languageName(auto),
        },
        { id: 'separator', label: '', separator: true },
        ...LANGUAGES.map(tag => ({
            id: tag,
            label: languageName(tag),
            description: tag,
        })),
    ], nls.localize('vueport/language/noMatch', 'No matching language'));
    if (!picked) {
        return;
    }

    const wanted = picked.id === 'system' ? undefined : picked.id;
    if ((wanted ?? auto) === (chosen ?? auto) && (wanted === undefined) === (chosen === undefined)) {
        return;
    }
    rememberLanguage(wanted);
    window.location.reload();
}
