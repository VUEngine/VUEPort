import { Translations, useTranslations } from 'vueport-core/lib/common/emulator-nls';
import { activeLanguage, DEFAULT_LANGUAGE } from './web-language';

// the translation fetch index.html already started in the document head, a round trip before the bundle could. Only a
// guess: activeLanguage decides, and a mismatching fetch is dropped
interface StartedLocale {
    tag: string;
    response: Promise<Response | undefined>;
}

declare global {
    interface Window {
        __vueportLocale?: StartedLocale;
    }
}

// failing is not fatal, as every call site carries its English default. Must run before anything renders, see
// setLocalization
export async function installLocale(): Promise<string | undefined> {
    const locale = activeLanguage();
    // English is what the call sites already say, so there is no file for it
    if (locale === DEFAULT_LANGUAGE) {
        return undefined;
    }
    try {
        const started = window.__vueportLocale;
        const response = started?.tag === locale
            ? await started.response
            : await fetch(`./i18n/nls.${locale}.json`);
        if (!response?.ok) {
            return undefined;
        }
        useTranslations(await response.json() as Translations);
        return locale;
    } catch {
        return undefined;
    }
}
