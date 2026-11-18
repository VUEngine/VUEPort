/**
 * Light or dark, web and desktop only: the studio takes its theme from the application around it. As with the
 * language, nothing is stored until the user chooses, so a first visit follows the system as it changes through the
 * day; a chosen mode overrides that until set back. Takes effect at once, as the theme is custom properties on the
 * document root.
 */
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { WebUi } from './web-ui';

const STORAGE_KEY = 'vueport.theme';

export type ThemeChoice = 'system' | 'light' | 'dark';

export type ThemeMode = 'light' | 'dark';

export const THEME_CHOICES: ThemeChoice[] = ['system', 'light', 'dark'];

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeTheme: Event<void> = onDidChangeEmitter.event;

function lightQuery(): MediaQueryList | undefined {
    // matchMedia is missing in some embedded webviews, and a throwing theme module would take the page with it
    return typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: light)')
        : undefined;
}

// dark when the system does not say, as such a machine usually cannot express a preference, and the emulator's chrome
// was drawn dark first
export function detectedTheme(): ThemeMode {
    return lightQuery()?.matches ? 'light' : 'dark';
}

// following the system is stored as nothing, so a machine that changes its mind is followed
export function storedTheme(): ThemeMode | undefined {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored === 'light' || stored === 'dark' ? stored : undefined;
    } catch {
        // private browsing: nothing was remembered, so follow the system
        return undefined;
    }
}

export function rememberTheme(choice: ThemeChoice): void {
    try {
        if (choice === 'system') {
            window.localStorage.removeItem(STORAGE_KEY);
        } else {
            window.localStorage.setItem(STORAGE_KEY, choice);
        }
    } catch {
        // still applies to this session, it just is not remembered
    }
}

export function themeChoice(): ThemeChoice {
    return storedTheme() ?? 'system';
}

export function activeTheme(): ThemeMode {
    return storedTheme() ?? detectedTheme();
}

// an attribute rather than a class, so a stylesheet names the mode it describes (see :root[data-theme="light"] in
// style.css)
function apply(): void {
    document.documentElement.dataset.theme = activeTheme();
}

// called before the first render, so the page never flashes the other theme
export function startTheme(): void {
    apply();
    // subscribed unconditionally, as activeTheme already ignores the system while a choice is stored
    lightQuery()?.addEventListener('change', () => {
        if (storedTheme() === undefined) {
            apply();
            onDidChangeEmitter.fire();
        }
    });
}

export function setTheme(choice: ThemeChoice): void {
    if (choice === themeChoice()) {
        return;
    }
    rememberTheme(choice);
    apply();
    onDidChangeEmitter.fire();
}

export function themeChoiceName(choice: ThemeChoice): string {
    switch (choice) {
        case 'light':
            return nls.localize('vueport/theme/light', 'Light');
        case 'dark':
            return nls.localize('vueport/theme/dark', 'Dark');
        default:
            return nls.localize('vueport/theme/system', 'System');
    }
}

// here rather than beside the toolbar button, as the command palette opens the same picker
export async function pickTheme(ui: WebUi): Promise<void> {
    const chosen = themeChoice();
    const picked = await ui.pick(
        // not "Color Mode", as the toolbar already has the anaglyph color mode a few pixels away
        nls.localize('vueport/theme/title', 'Appearance'),
        THEME_CHOICES.map(choice => ({
            id: choice,
            label: themeChoiceName(choice),
            // the choice in force is marked rather than moved, so the rows keep their order; "System" also says which
            // way it currently falls
            description: [
                choice === chosen
                    ? nls.localize('vueport/theme/current', 'Current')
                    : undefined,
                choice === 'system' ? themeChoiceName(detectedTheme()) : undefined,
            ].filter(part => part !== undefined).join(' \u00b7 ') || undefined,
        })),
        nls.localize('vueport/theme/noMatch', 'No matching mode'),
    );
    if (picked) {
        setTheme(picked.id as ThemeChoice);
    }
}
