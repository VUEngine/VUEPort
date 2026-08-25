/**
 * Localization, as one injected implementation.
 *
 * This is a stand-in for Theia's `nls`, exposing the same `nls.localize(key,
 * default, ...args)` so that the emulator's several hundred call sites read
 * exactly as they did — only the import moves. VES installs Theia's
 * implementation during startup (see `setLocalization` in the frontend module),
 * so the keys in `src/emulator/i18n/` and every translation beside them keep
 * working unchanged. Standing
 * alone — on vueport.net, or in a test — the default implementation returns the
 * English default, which is what an untranslated build should show.
 *
 * There is deliberately no `localizeByDefault`. Theia's resolves a string
 * against *VS Code's* translation table, which a standalone host has none of —
 * every such call would silently be English forever. The emulator keys those
 * strings itself instead, under `vueport/general/…`, so they travel.
 *
 * **The name is load-bearing.** `yarn nls-extract` finds strings by matching the
 * callee text `nls.localize` exactly (see Theia's `localization-extractor`), so
 * calls have to keep spelling it that way. Renaming this to something shorter
 * would silently empty `i18n/nls.json` on the next extraction run and take
 * thirteen languages with it.
 *
 * **Timing.** `setLocalization` runs when the frontend module's body runs, which
 * is *after* every module it imports has been evaluated. So a string read while
 * building a module-level constant is read too early, and would be English for
 * the life of the process. Tables of labels are therefore built lazily — see
 * `EMULATOR_PANEL_LABELS` — and the rule for new code is that a string is
 * translated when it is shown, not when its module loads.
 */

/**
 * What may be substituted into a string. Matches Theia's `FormatType`, so that
 * the existing call sites passing counts and flags keep type-checking.
 */
export type FormatType = string | number | boolean | undefined;

/** Substitutes `{0}`, `{1}` … , matching Theia's `Localization.format`. */
function format(message: string, args: FormatType[]): string {
    return message.replace(/{([^}]+)}/g, (match, group) => args[group as unknown as number]?.toString() ?? match);
}

export type LocalizeFn = (key: string, defaultValue: string, ...args: FormatType[]) => string;

let localizeImpl: LocalizeFn = (_key, defaultValue, ...args) => format(defaultValue, args);

export namespace nls {
    /** Translate `key`, falling back to `defaultValue`. */
    export function localize(key: string, defaultValue: string, ...args: FormatType[]): string {
        return localizeImpl(key, defaultValue, ...args);
    }
}

/**
 * A translation file as it is shipped: nested objects mirroring the key path,
 * which is the shape `theia nls-extract` writes and `yarn nls-localize`
 * translates.
 */
export interface VesEmulatorTranslations {
    [segment: string]: string | VesEmulatorTranslations;
}

/**
 * Flatten a shipped file into the `a/b/c` keys the call sites use.
 *
 * The separator is `/` rather than Theia's `.` because that is what the keys in
 * the source are written with; the two agree because Theia splits on `/` when
 * it builds its own tree from the same files.
 */
export function flattenTranslations(
    translations: VesEmulatorTranslations,
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

/**
 * Install one of the shipped translation files as the implementation.
 *
 * This is what a host with no localization of its own — vueport.net, the native
 * wrapper — uses: fetch `i18n/nls.<locale>.json`, hand it here, and every call
 * site is translated. A key with no translation falls back to the English
 * default the call site carries, so a partial file is a partial translation
 * rather than a page of missing strings.
 */
export function useTranslations(translations: VesEmulatorTranslations): void {
    const flat = flattenTranslations(translations);
    setLocalization((key, defaultValue, ...args) => format(flat[key] ?? defaultValue, args));
}

/**
 * Install the host's localization. Call once, during startup, before anything
 * renders.
 */
export function setLocalization(localize: LocalizeFn): void {
    localizeImpl = localize;
}
