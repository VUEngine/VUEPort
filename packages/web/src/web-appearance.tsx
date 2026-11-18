import * as React from 'react';
import RadioSelect from 'vueport-core/lib/browser/components/kit/RadioSelect';
import Range from 'vueport-core/lib/browser/components/kit/Range';
import ResetButton from 'vueport-core/lib/browser/components/kit/ResetButton';
import Select from 'vueport-core/lib/browser/components/kit/Select';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import {
    LANGUAGES,
    detectedLanguage,
    languageName,
    rememberLanguage,
    storedLanguage,
} from './web-language';
import {
    DEFAULT_MAX_RECENT_COMMANDS,
    MAX_MAX_RECENT_COMMANDS,
    MIN_MAX_RECENT_COMMANDS,
    maxRecentCommands,
    onDidChangeMaxRecentCommands,
    setMaxRecentCommands,
} from './web-recent-commands';
import {
    THEME_CHOICES,
    ThemeChoice,
    onDidChangeTheme,
    setTheme,
    themeChoice,
    themeChoiceName,
} from './web-theme';

// the Appearance pane, web only: light/dark mode, language and how many recent commands the palette offers. The studio
// takes these from the application around it
export default function WebAppearance(): React.JSX.Element {
    const [, bump] = React.useReducer((n: number) => n + 1, 0);

    // the mode can also change from the command palette, and follows the system while nothing is chosen, so this tracks
    // the module rather than a copy
    React.useEffect(() => {
        const theme = onDidChangeTheme(() => bump());
        const recent = onDidChangeMaxRecentCommands(() => bump());
        return () => {
            theme.dispose();
            recent.dispose();
        };
    }, []);

    const languageValue = storedLanguage() ?? 'system';
    const applyLanguage = (value: string): void => {
        const wanted = value === 'system' ? undefined : value;
        if ((wanted ?? '') === (storedLanguage() ?? '')) {
            return;
        }
        rememberLanguage(wanted);
        // vueport-core's label tables are built once and cached for the life of the page, so a new language only
        // reaches strings rendered later; a reload is the honest way to switch
        window.location.reload();
    };

    return <div className='vp-appearance'>
        <label className='vp-appearance-row'>
            <span className='vp-appearance-label'>
                {nls.localize('vueport/theme/mode', 'Color Mode')}
            </span>
            <RadioSelect
                options={THEME_CHOICES.map(choice => ({
                    value: choice,
                    label: themeChoiceName(choice),
                }))}
                defaultValue={themeChoice()}
                onChange={chosen => setTheme(chosen[0].value as ThemeChoice)}
            />
        </label>

        <label className='vp-appearance-row'>
            <span className='vp-appearance-label'>
                {nls.localize('vueport/status/language', 'Language')}
            </span>
            <Select
                value={languageValue}
                onChange={applyLanguage}
                label={nls.localize('vueport/status/language', 'Language')}
                options={[
                    {
                        value: 'system',
                        label: `${nls.localize('vueport/language/system', 'System Language')}\
 — ${languageName(detectedLanguage())}`,
                    },
                    ...LANGUAGES.map(tag => ({ value: tag, label: languageName(tag) })),
                ]}
            />
        </label>

        {/* outside a fieldset, so it gets a boolean setting's stack rather than the bare one of the Library pane's
            slider */}
        <div className='vp-bool-setting vp-range-setting'>
            <div className='vp-bool-title'>
                <span>{nls.localize('vueport/settings/recentCommands', 'Recently used commands')}</span>
                <ResetButton
                    disabled={maxRecentCommands() === DEFAULT_MAX_RECENT_COMMANDS}
                    onReset={() => setMaxRecentCommands(DEFAULT_MAX_RECENT_COMMANDS)}
                />
            </div>
            <div className='vp-hint'>
                {nls.localize('vueport/settings/recentCommandsHint',
                    'The command palette lists this many of the commands last run from it first.')}
            </div>
            <Range
                value={maxRecentCommands()}
                setValue={value => setMaxRecentCommands(value)}
                min={MIN_MAX_RECENT_COMMANDS}
                max={MAX_MAX_RECENT_COMMANDS}
                step={1}
            />
        </div>
    </div>;
}
