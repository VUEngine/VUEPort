/**
 * Every setting the dialog has, reachable from the command palette by name. Emulator settings are built from the
 * dialog's schema, so a new setting arrives here with its title and choices; the web build's own settings have no
 * schema and are listed by hand. Each command writes through the dialog control's setter, so the two never disagree.
 */
import { vueportSettingsSchema } from 'vueport-core/lib/browser/emulator-settings-schema';
import { EmulatorDecoration } from 'vueport-core/lib/browser/emulator-types';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { Command } from 'vueport-core/lib/common/emulator-command';
import { VueportConfig, VueportSettings } from 'vueport-core/lib/common/emulator-settings';
import { VbRenderingMode } from 'vueport-core/lib/common/vb-constants';
import type { WebCommand } from './web-commands';
import {
    gameInfoApiBase, homebrewApiBase, isApiBase, setGameInfoApiBase, setHomebrewApiBase,
    DEFAULT_GAME_INFO_API, DEFAULT_HOMEBREW_API,
} from './web-api-bases';
import { autoStartRecent, setAutoStartRecent } from './web-auto-start';
import { continueVisible, setContinueVisible } from './web-continue-visibility';
import {
    NumberSetting, StringSetting,
    pickAnaglyphPalette, pickEnumSetting, pickNumberSetting, pickPalette, promptColorSetting,
} from './web-display-settings';
import { WebEmulator } from './web-emulator';
import {
    lookUpDetails, readFoldersAtStart, scanArchives, scanSubfolders,
    setLookUpDetails, setReadFoldersAtStart, setScanArchives, setScanSubfolders,
} from './web-library-settings';
import { DEFAULT_MAX_RECENT, MAX_MAX_RECENT, MIN_MAX_RECENT, maxRecent, setMaxRecent } from './web-recent-limit';
import {
    DEFAULT_MAX_RECENT_COMMANDS, MAX_MAX_RECENT_COMMANDS, MIN_MAX_RECENT_COMMANDS,
    maxRecentCommands, setMaxRecentCommands,
} from './web-recent-commands';
import { StartPage, setStartPage, startPage } from './web-start-page';
import { canUpdate, installsUpdates } from './desktop-update';
import {
    checkUpdatesAtStart, downloadUpdatesAutomatically,
    setCheckUpdatesAtStart, setDownloadUpdatesAutomatically,
} from './web-update-settings';
import { WebUi } from './web-ui';

// picture settings have pickers in webCommands; save slot, VB Color, hardware and hardcore mode have commands that also
// restart the game or ask first; palettes and per-game color state are lists edited in their own panes
const COVERED_ELSEWHERE: ReadonlySet<keyof VueportConfig> = new Set<keyof VueportConfig>([
    'renderingMode', 'scale', 'decoration', 'palette', 'anaglyphPalette',
    'saveGameSlot', 'vbcSupportEnabled', 'hardwareMode', 'retroAchievementsHardcore',
]);

// the Screenshots and Video panes both have a "Scale" and a "Rendering Mode", which would read as duplicates in a
// sorted palette, and "Enable Rewind" would become "Turn on Enable Rewind"
function commandTitle(key: keyof VueportConfig): string {
    switch (key) {
        case 'screenshotScale':
            return nls.localize('vueport/commands/screenshot/scale', 'Screenshot Scale');
        case 'screenshotRenderingMode':
            return nls.localize('vueport/commands/screenshot/renderingMode', 'Screenshot Rendering Mode');
        case 'screenshotUseDisplaySettings':
            return nls.localize('vueport/commands/screenshot/useDisplay',
                'Display Settings for Screenshots');
        case 'screenshotPalette':
            return nls.localize('vueport/commands/screenshot/palette', 'Screenshot Color Palette');
        case 'screenshotFrameBlending':
            return nls.localize('vueport/commands/screenshot/frameBlending', 'Screenshot Frame Blending');
        case 'screenshotAnaglyphPalette':
            return nls.localize('vueport/commands/screenshot/anaglyphPalette',
                'Screenshot Anaglyph Palette');
        case 'videoScale':
            return nls.localize('vueport/commands/video/scale', 'Video Scale');
        case 'videoRenderingMode':
            return nls.localize('vueport/commands/video/renderingMode', 'Video Rendering Mode');
        case 'videoUseDisplaySettings':
            return nls.localize('vueport/commands/video/useDisplay', 'Display Settings for Videos');
        case 'videoPalette':
            return nls.localize('vueport/commands/video/palette', 'Video Color Palette');
        case 'videoFrameBlending':
            return nls.localize('vueport/commands/video/frameBlending', 'Video Frame Blending');
        case 'videoAnaglyphPalette':
            return nls.localize('vueport/commands/video/anaglyphPalette', 'Video Anaglyph Palette');
        case 'videoQuality':
            return nls.localize('vueport/commands/video/quality', 'Video Quality');
        case 'videoFormat':
            return nls.localize('vueport/commands/video/format', 'Video File Format');
        case 'rewindEnabled':
            return nls.localize('vueport/commands/rewind', 'Rewind');
        case 'player2SameControls':
            return nls.localize('vueport/commands/player2SameControls', 'Shared Player 2 Controls');
        case 'retroAchievementsEnabled':
            return nls.localize('vueport/commands/trackAchievements', 'Achievement Tracking');
        default:
            return vueportSettingsSchema()[key].title;
    }
}

function command(id: string, label: string): Command {
    return {
        id: `vueport.setting.${id}`,
        label,
        category: nls.localize('vueport/commands/category', 'VUEPort'),
    };
}

type BooleanSetting = {
    [K in keyof VueportConfig]: VueportConfig[K] extends boolean ? K : never
}[keyof VueportConfig];

// the form the picture settings use
function setLabel(title: string): string {
    return nls.localize('vueport/commands/set/setting', 'Set {0}', title);
}

// by the current state, as the hardcore command does
function switchLabel(title: string, on: boolean): string {
    return on
        ? nls.localize('vueport/commands/turnOff', 'Turn off {0}', title)
        : nls.localize('vueport/commands/turnOn', 'Turn on {0}', title);
}

// by the dialog's rules for showing a control; one that does not apply is still offered, grayed
function applies(settings: VueportSettings, key: keyof VueportConfig): boolean {
    const mode = settings.get('renderingMode');
    const decoration = settings.get('decoration');
    switch (key) {
        case 'swapEyes':
        case 'stereoDepth':
            return mode !== VbRenderingMode.LEFT && mode !== VbRenderingMode.RIGHT;
        case 'decorationIntensity':
            return decoration === EmulatorDecoration.AMBIENT
                || decoration === EmulatorDecoration.IMMERSION;
        case 'decorationColor':
        case 'decorationColorFromPalette':
            return decoration === EmulatorDecoration.AMBIENT;
        case 'screenshotRenderingMode':
        case 'screenshotFrameBlending':
        case 'screenshotPalette':
        case 'screenshotAnaglyphPalette':
            return !settings.get('screenshotUseDisplaySettings');
        case 'videoRenderingMode':
        case 'videoFrameBlending':
        case 'videoPalette':
        case 'videoAnaglyphPalette':
            return !settings.get('videoUseDisplaySettings');
        case 'vbcAutoApplyColorPatches':
            return settings.get('vbcSupportEnabled');
        case 'rewindGranularity':
        case 'rewindBufferSize':
            return settings.get('rewindEnabled');
        case 'autoSaveStateInterval':
        case 'autoSaveStateCount':
            return settings.get('autoSaveStatesEnabled');
        case 'suspendResumeStart':
            return settings.get('suspendResumeEnabled');
        default:
            return true;
    }
}

function emulatorSettingCommands(emulator: WebEmulator, ui: WebUi): WebCommand[] {
    const { settings } = emulator;
    const schema = vueportSettingsSchema();
    const usable = (key: keyof VueportConfig): boolean =>
        settings.fixed?.[key] === undefined && applies(settings, key);

    const commands: WebCommand[] = [];
    for (const key of Object.keys(schema) as (keyof VueportConfig)[]) {
        const entry = schema[key];
        if (COVERED_ELSEWHERE.has(key)) {
            continue;
        }
        const title = commandTitle(key);
        if (entry.type === 'boolean') {
            const on = settings.get(key) as boolean;
            commands.push({
                command: command(key, switchLabel(title, on)),
                enabled: usable(key),
                run: () => settings.set(key as BooleanSetting, !on),
            });
        } else if (entry.type === 'number' || entry.type === 'integer') {
            commands.push({
                command: command(key, setLabel(title)),
                enabled: usable(key),
                run: () => pickNumberSetting(ui, settings, key as NumberSetting, title),
            });
        } else if (entry.type === 'string' && entry.format === 'color') {
            commands.push({
                command: command(key, setLabel(title)),
                enabled: usable(key),
                run: () => promptColorSetting(ui, settings, key as StringSetting, title),
            });
        } else if (entry.type === 'string' && entry.enum) {
            commands.push({
                command: command(key, setLabel(title)),
                enabled: usable(key),
                run: () => pickEnumSetting(ui, settings, key as StringSetting, title),
            });
        }
        // anything else is a list edited in its own pane
    }

    // not in the schema, as the panes draw them with the palette editor
    for (const key of ['screenshotPalette', 'videoPalette'] as const) {
        commands.push({
            command: command(key, setLabel(commandTitle(key))),
            enabled: usable(key),
            run: () => pickPalette(ui, settings, key),
        });
    }
    for (const key of ['screenshotAnaglyphPalette', 'videoAnaglyphPalette'] as const) {
        commands.push({
            command: command(key, setLabel(commandTitle(key))),
            enabled: usable(key),
            run: () => pickAnaglyphPalette(ui, settings, key),
        });
    }
    return commands;
}

function webSwitch(
    id: string, title: string, value: boolean, set: (value: boolean) => void, enabled = true,
): WebCommand {
    return {
        command: command(id, switchLabel(title, value)),
        enabled,
        run: () => set(!value),
    };
}

// empty restores the default, as clearing the dialog's field does
async function promptApiBase(
    ui: WebUi, title: string, current: string, fallback: string, set: (value: string) => void,
): Promise<void> {
    const raw = await ui.prompt({
        title,
        message: nls.localize('vueport/commands/apiBaseMessage',
            'Leave empty to use the default ({0}).', fallback),
        placeholder: fallback,
        value: current === fallback ? '' : current,
        type: 'url',
    });
    if (raw === undefined) {
        return;
    }
    if (!isApiBase(raw)) {
        ui.toast('error', nls.localize('vueport/commands/notAnApiBase',
            '"{0}" is not an address VUEPort can use.', raw.trim()));
        return;
    }
    set(raw);
}

async function pickStartPage(ui: WebUi): Promise<void> {
    const current = startPage();
    const mark = nls.localize('vueport/settings/current', 'Current');
    const pages: { id: StartPage, label: string }[] = [
        { id: 'recent', label: nls.localize('vueport/library/recentlyPlayed', 'Recently Played') },
        { id: 'all', label: nls.localize('vueport/library/allGames', 'All Games') },
        { id: 'favorites', label: nls.localize('vueport/library/favorites', 'Favorites') },
        { id: 'featured', label: nls.localize('vueport/library/featuredPicks', 'Featured Picks') },
        { id: 'archive', label: nls.localize('vueport/library/homebrewArchive', 'Homebrew Archive') },
    ];
    const picked = await ui.pick(
        nls.localize('vueport/library/startPage/title', 'Start Page'),
        pages.map(page => ({ ...page, description: page.id === current ? mark : undefined })),
        nls.localize('vueport/settings/noMatchingOption', 'No matching option'),
    );
    if (picked) {
        setStartPage(picked.id as StartPage);
    }
}

// clamped by the setter, like the dialog's slider
async function promptCount(
    ui: WebUi, title: string, min: number, max: number, fallback: number,
    current: number, set: (value: number) => void,
): Promise<void> {
    const raw = await ui.prompt({
        title,
        message: nls.localize('vueport/settings/numberRange',
            'A number from {0} to {1}. Default: {2}.', min, max, fallback),
        value: String(current),
    });
    if (raw === undefined || raw.trim() === '') {
        return;
    }
    const typed = Number(raw.trim());
    if (!Number.isFinite(typed)) {
        ui.toast('error', nls.localize('vueport/settings/notANumber',
            '"{0}" is not a number.', raw.trim()));
        return;
    }
    set(typed);
}

function webSettingCommands(ui: WebUi): WebCommand[] {
    const shelf = continueVisible();
    return [
        webSwitch('scanSubfolders',
            nls.localize('vueport/library/scanRecursively', 'Scan Recursively'),
            scanSubfolders(), setScanSubfolders),
        webSwitch('scanArchives',
            nls.localize('vueport/commands/readArchives', 'Zip Archive Scanning'),
            scanArchives(), setScanArchives),
        webSwitch('lookUpDetails',
            nls.localize('vueport/commands/enrichLibrary', 'Library Enrichment'),
            lookUpDetails(), setLookUpDetails),
        webSwitch('readFoldersAtStart',
            nls.localize('vueport/commands/updateLibraryOnStart', 'Library Update on Start'),
            readFoldersAtStart(), setReadFoldersAtStart),
        {
            command: command('startPage', setLabel(nls.localize('vueport/commands/libraryStartPage', 'Library Start Page'))),
            enabled: true,
            run: () => pickStartPage(ui),
        },
        webSwitch('continueVisible',
            nls.localize('vueport/commands/recent/shelf', 'Recently Played Shelf'),
            shelf, setContinueVisible),
        // only while there is a shelf, as in the pane
        webSwitch('autoStartRecent',
            nls.localize('vueport/commands/recent/autoStart', 'Auto Start of Last Game'),
            autoStartRecent(), setAutoStartRecent, shelf),
        {
            command: command('maxRecent', setLabel(nls.localize('vueport/commands/recent/limit',
                    'Recently Played Amount to Remember'))),
            enabled: shelf,
            run: () => promptCount(ui,
                nls.localize('vueport/settings/recentLimit', 'Amount to remember'),
                MIN_MAX_RECENT, MAX_MAX_RECENT, DEFAULT_MAX_RECENT, maxRecent(), setMaxRecent),
        },
        {
            command: command('maxRecentCommands', setLabel(nls.localize('vueport/commands/recentCommandsLimit',
                    'Recently Used Commands Amount'))),
            enabled: true,
            run: () => promptCount(ui,
                nls.localize('vueport/settings/recentCommands', 'Recently used commands'),
                MIN_MAX_RECENT_COMMANDS, MAX_MAX_RECENT_COMMANDS, DEFAULT_MAX_RECENT_COMMANDS,
                maxRecentCommands(), setMaxRecentCommands),
        },
        {
            command: command('homebrewApi', setLabel(nls.localize('vueport/apis/homebrew', 'Homebrew API'))),
            enabled: true,
            run: () => promptApiBase(ui,
                nls.localize('vueport/apis/homebrew', 'Homebrew API'),
                homebrewApiBase(), DEFAULT_HOMEBREW_API, setHomebrewApiBase),
        },
        {
            command: command('gameInfoApi', setLabel(nls.localize('vueport/apis/gameInfo', 'Game Info API'))),
            enabled: true,
            run: () => promptApiBase(ui,
                nls.localize('vueport/apis/gameInfo', 'Game Info API'),
                gameInfoApiBase(), DEFAULT_GAME_INFO_API, setGameInfoApiBase),
        },
        // desktop only, like the Updates pane
        webSwitch('checkUpdatesAtStart',
            nls.localize('vueport/commands/checkUpdatesAtStart', 'Update Check at Start'),
            checkUpdatesAtStart(), setCheckUpdatesAtStart, canUpdate()),
        webSwitch('downloadUpdatesAutomatically',
            nls.localize('vueport/commands/downloadUpdates', 'Automatic Update Downloads'),
            downloadUpdatesAutomatically(), setDownloadUpdatesAutomatically, canUpdate() && installsUpdates()),
    ];
}

export function settingCommands(emulator: WebEmulator, ui: WebUi): WebCommand[] {
    return [...emulatorSettingCommands(emulator, ui), ...webSettingCommands(ui)];
}
