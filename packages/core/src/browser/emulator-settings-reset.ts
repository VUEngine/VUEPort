import { nls } from '../common/emulator-nls';
import { VUEPORT_DEFAULTS, VueportConfig, VueportSettings } from '../common/emulator-settings';

// what a setting is reset to: the host's own default where it has one, as the pane's reset button does
function standard<K extends keyof VueportConfig>(settings: VueportSettings, key: K): VueportConfig[K] {
    return settings.defaults?.[key] ?? VUEPORT_DEFAULTS[key];
}

// the settings among `keys` that differ from their default. Settings the host has settled are left out: they cannot
// be changed, so they are neither a customization nor something a reset could touch
export function modifiedSettings(
    settings: VueportSettings,
    keys: readonly (keyof VueportConfig)[],
): (keyof VueportConfig)[] {
    return keys.filter(key =>
        settings.fixed?.[key] === undefined
        && JSON.stringify(settings.get(key)) !== JSON.stringify(standard(settings, key)));
}

export async function resetSettings(
    settings: VueportSettings,
    keys: readonly (keyof VueportConfig)[],
): Promise<void> {
    for (const key of modifiedSettings(settings, keys)) {
        await settings.set(key, standard(settings, key));
    }
}

// here, so both hosts ask in the same translated words. Built on call, as localization is installed during start-up
export function resetAllSettingsConfirmation(): { title: string, message: string, okLabel: string } {
    return {
        title: nls.localize('vueport/settings/resetAll/title', 'Reset All Settings?'),
        message: nls.localize(
            'vueport/settings/resetAll/message',
            'Every setting in this window goes back to its default. Key and controller mappings are not affected.'),
        okLabel: nls.localize('vueport/settings/resetAll/confirm', 'Reset All'),
    };
}
