// the picture settings as lists to choose from (command palette's "Set Rendering Mode", "Set Scale", ...), each
// writing the same setting as the dialog's field. Here rather than beside the commands, for the reason pickTheme
// gives: the pickers are what the choice is

import {
    CUSTOM_PALETTE_PREFIX,
    emulationAnaglyphPalettes,
    emulationPalettes,
    emulationRenderingModes,
    emulatorDecorationLabels,
    emulatorScaleOptions,
    getCustomPaletteId,
} from 'vueport-core/lib/browser/emulator-types';
import { vueportSettingsSchema } from 'vueport-core/lib/browser/emulator-settings-schema';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import {
    VUEPORT_DEFAULTS, VueportConfig, VueportSettings,
} from 'vueport-core/lib/common/emulator-settings';
import { PickItem, WebUi } from './web-ui';

// named rather than any keyof VueportConfig, so a picker handing back a string can only target a string setting
export type PictureSetting =
    | 'renderingMode'
    | 'scale'
    | 'decoration'
    | 'palette'
    | 'anaglyphPalette';

export type StringSetting = {
    [K in keyof VueportConfig]: VueportConfig[K] extends string ? K : never
}[keyof VueportConfig];

export type NumberSetting = {
    [K in keyof VueportConfig]: VueportConfig[K] extends number ? K : never
}[keyof VueportConfig];

export type PaletteSetting = 'palette' | 'screenshotPalette' | 'videoPalette';
export type AnaglyphPaletteSetting =
    'anaglyphPalette' | 'screenshotAnaglyphPalette' | 'videoAnaglyphPalette';

// what this build counts as standard: the host's own answer where it has one, the emulator's otherwise (what
// the dialog's reset buttons go back to)
export function standardValue<K extends keyof VueportConfig>(
    settings: VueportSettings, key: K,
): VueportConfig[K] {
    return (settings.defaults?.[key] ?? VUEPORT_DEFAULTS[key]) as VueportConfig[K];
}

// with the unit the dialog's slider leaves to its title; a value is never shown bare
export function formatSettingValue(key: NumberSetting, value: number): string {
    const shown = value.toLocaleString();
    switch (key) {
        case 'stereoDepth':
        case 'decorationIntensity':
            return `${shown}%`;
        case 'screenshotScale':
        case 'videoScale':
        case 'slowMotionRatio':
        case 'fastForwardRatio':
            return `${shown}×`;
        case 'autoSaveStateInterval':
            return `${shown} s`;
        case 'rewindBufferSize':
            return `${shown} MB`;
        default:
            return shown;
    }
}

interface Choice {
    id: string;
    label: string;
    description?: string; // shown grayed after the label, in front of the mark
    separator?: boolean; // a heading above the entries that follow; not selectable
}

// the current one is marked rather than moved to the top, so rows stay in the same order (as in pickTheme)
async function pickSetting(
    ui: WebUi,
    settings: VueportSettings,
    key: StringSetting,
    title: string,
    choices: Choice[],
): Promise<void> {
    const current = settings.get(key);
    const items: PickItem[] = choices.map(choice => ({
        ...choice,
        description: choice.separator
            ? undefined
            : [
                choice.description,
                choice.id === current
                    ? nls.localize('vueport/settings/current', 'Current')
                    : undefined,
            ].filter(part => part !== undefined).join(' · ') || undefined,
    }));

    const picked = await ui.pick(title, items,
        nls.localize('vueport/settings/noMatchingOption', 'No matching option'));
    if (!picked || picked.id === current) {
        return;
    }
    await settings.set(key, picked.id as VueportConfig[StringSetting]);
}

export async function pickRenderingMode(ui: WebUi, settings: VueportSettings): Promise<void> {
    await pickSetting(ui, settings, 'renderingMode',
        nls.localize('vueport/preferences/renderingMode/title', 'Rendering Mode'),
        Object.entries(emulationRenderingModes())
            .map(([id, label]) => ({ id, label })));
}

export async function pickScale(ui: WebUi, settings: VueportSettings): Promise<void> {
    await pickSetting(ui, settings, 'scale',
        nls.localize('vueport/preferences/scalingMode/title', 'Scale'),
        emulatorScaleOptions().map(option => ({ id: option.value, label: option.label })));
}

export async function pickDecoration(ui: WebUi, settings: VueportSettings): Promise<void> {
    await pickSetting(ui, settings, 'decoration',
        nls.localize('vueport/preferences/decoration/title', 'Screen Decoration'),
        Object.entries(emulatorDecorationLabels())
            .map(([id, label]) => ({ id, label })));
}

// custom palettes get a heading of their own rather than being mixed in, so a custom "Blue" cannot pass for a
// built-in
export async function pickPalette(
    ui: WebUi, settings: VueportSettings, key: PaletteSetting = 'palette',
): Promise<void> {
    await pickSetting(ui, settings, key,
        nls.localize('vueport/preferences/palette/title', 'Color Palette'),
        [
            ...Object.entries(emulationPalettes()).map(([id, label]) => ({ id, label })),
            ...customChoices(settings.get('customPalettes').map(palette => palette.name)),
        ]);
}

export async function pickAnaglyphPalette(
    ui: WebUi, settings: VueportSettings, key: AnaglyphPaletteSetting = 'anaglyphPalette',
): Promise<void> {
    await pickSetting(ui, settings, key,
        nls.localize('vueport/preferences/anaglyphPalette/title', 'Anaglyph Colors'),
        [
            ...Object.entries(emulationAnaglyphPalettes()).map(([id, label]) => ({ id, label })),
            ...customChoices(settings.get('customAnaglyphPalettes').map(palette => palette.name)),
        ]);
}

// any other setting the schema lists choices for; its labels are the dialog's own
export async function pickEnumSetting(
    ui: WebUi, settings: VueportSettings, key: StringSetting, title?: string,
): Promise<void> {
    const schema = vueportSettingsSchema()[key];
    const ids = (schema.enum ?? []).map(String);
    await pickSetting(ui, settings, key, title ?? schema.title,
        ids.map((id, index) => ({ id, label: schema.enumItemLabels?.[index] ?? id })));
}

// past this the list is too long to scroll, so the number is asked for instead
const MAX_LISTED_STEPS = 64;

// offered as the steps the dialog's slider stops at when few enough (typing "150" filters as fast as a field);
// with hundreds of steps it is asked for as a number, held to the bounds and the step rather than refused
export async function pickNumberSetting(
    ui: WebUi, settings: VueportSettings, key: NumberSetting, title?: string,
): Promise<void> {
    const schema = vueportSettingsSchema()[key];
    const label = title ?? schema.title;
    const min = schema.minimum ?? 0;
    const max = schema.maximum ?? 100;
    const step = schema.multipleOf ?? 1;
    const current = settings.get(key);
    const standard = standardValue(settings, key);
    // a number offered at a few values only lists those; the rest list their steps, built from the index rather than
    // by adding up, so 0.5 steps do not drift into 7.499999
    const values = schema.enum?.map(Number)
        ?? Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, index) => min + index * step);

    let next: number | undefined;
    if (values.length <= MAX_LISTED_STEPS) {
        const items: PickItem[] = [];
        for (const value of values) {
            items.push({
                id: String(value),
                label: formatSettingValue(key, value),
                description: [
                    value === standard
                        ? nls.localize('vueport/settings/default', 'Default')
                        : undefined,
                    value === current
                        ? nls.localize('vueport/settings/current', 'Current')
                        : undefined,
                ].filter(part => part !== undefined).join(' · ') || undefined,
            });
        }
        const picked = await ui.pick(label, items,
            nls.localize('vueport/settings/noMatchingOption', 'No matching option'));
        next = picked ? Number(picked.id) : undefined;
    } else {
        const raw = await ui.prompt({
            title: label,
            message: nls.localize('vueport/settings/numberRange',
                'A number from {0} to {1}. Default: {2}.',
                formatSettingValue(key, min), formatSettingValue(key, max),
                formatSettingValue(key, standard)),
            value: String(current),
        });
        if (raw === undefined || raw.trim() === '') {
            return;
        }
        const typed = Number(raw.trim().replace(',', '.'));
        if (!Number.isFinite(typed)) {
            ui.toast('error', nls.localize('vueport/settings/notANumber',
                '"{0}" is not a number.', raw.trim()));
            return;
        }
        next = Math.min(max, Math.max(min, min + Math.round((typed - min) / step) * step));
    }
    if (next !== undefined && next !== current) {
        await settings.set(key, next);
    }
}

const HEX_COLOR = /^#?([0-9a-f]{6})$/i;

// typed rather than picked: a color well needs the dialog around it, and a user reaching for this by name already has
// the value in mind
export async function promptColorSetting(
    ui: WebUi, settings: VueportSettings, key: StringSetting, title?: string,
): Promise<void> {
    const label = title ?? vueportSettingsSchema()[key].title;
    const raw = await ui.prompt({
        title: label,
        placeholder: '#rrggbb',
        value: settings.get(key),
    });
    if (raw === undefined || raw.trim() === '') {
        return;
    }
    const match = HEX_COLOR.exec(raw.trim());
    if (!match) {
        ui.toast('error', nls.localize('vueport/settings/notAColor',
            '"{0}" is not a color. Use the form #rrggbb.', raw.trim()));
        return;
    }
    const next = `#${match[1].toLowerCase()}`;
    if (next !== settings.get(key)) {
        await settings.set(key, next as VueportConfig[StringSetting]);
    }
}

// the player's own palettes under a heading, or nothing when there are none. An unnamed one is dropped:
// `custom:` with an empty name resolves to nothing and would silently set the built-in default
function customChoices(names: string[]): Choice[] {
    const named = names.filter(name => name.trim() !== '');
    if (named.length === 0) {
        return [];
    }
    return [
        {
            id: CUSTOM_PALETTE_PREFIX,
            label: nls.localize('vueport/settings/customPalettes', 'Custom'),
            separator: true,
        },
        ...named.map(name => ({ id: getCustomPaletteId(name), label: name })),
    ];
}
