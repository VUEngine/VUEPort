/**
 * A stand-in for Theia's nls with the same nls.localize(key, default, ...args). VES installs Theia's implementation at
 * startup (setLocalization in the frontend module); standalone, the default returns the English default. There is no
 * localizeByDefault, as a standalone host has no VS Code translation table; such strings are keyed under
 * vueport/general/... instead.
 *
 * The name is load-bearing: `yarn nls-extract` matches the callee text `nls.localize` exactly, so renaming it would
 * empty i18n/nls.json on the next extraction.
 *
 * setLocalization runs after every imported module was evaluated, so strings in module-level constants stay English.
 * Translate a string when it is shown, not when its module loads (see EMULATOR_PANEL_LABELS).
 */

export type FormatType = string | number | boolean | undefined;

// substitutes {0}, {1} ... like Theia's Localization.format
function format(message: string, args: FormatType[]): string {
    return message.replace(/{([^}]+)}/g, (match, group) => args[group as unknown as number]?.toString() ?? match);
}

export type LocalizeFn = (key: string, defaultValue: string, ...args: FormatType[]) => string;

let localizeImpl: LocalizeFn = (_key, defaultValue, ...args) => format(defaultValue, args);

export namespace nls {
    export function localize(key: string, defaultValue: string, ...args: FormatType[]): string {
        return localizeImpl(key, defaultValue, ...args);
    }
}

// nested by key path, as `theia nls-extract` writes and `yarn nls-localize` translates
export interface Translations {
    [segment: string]: string | Translations;
}

export function flattenTranslations(
    translations: Translations,
    prefix = '',
): Record<string, string> {
    const flat: Record<string, string> = {};
    for (const [segment, value] of Object.entries(translations)) {
        const key = prefix ? `${prefix}/${segment}` : segment;
        if (typeof value === 'string') {
            flat[key] = value;
        } else {
            Object.assign(flat, flattenTranslations(value, key));
        }
    }
    return flat;
}

// for hosts without a localization of their own (vueport.net, the native wrapper), from i18n/nls.<locale>.json; a
// missing key falls back to the English default
export function useTranslations(translations: Translations): void {
    const flat = flattenTranslations(translations);
    setLocalization((key, defaultValue, ...args) => format(flat[key] ?? defaultValue, args));
}

// call once during startup, before anything renders
export function setLocalization(localize: LocalizeFn): void {
    localizeImpl = localize;
}
