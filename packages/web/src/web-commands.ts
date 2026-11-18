/**
 * Everything the app can be asked to do, by name (web only; the studio uses Theia's registry and palette). The
 * emulator's commands come from vueport-core, so they read the same in both apps; the rest is this app's own chrome.
 * Built on call rather than kept: labels are read through accessors so translations installed during start-up reach
 * them (see Command.toLocalizedCommand), and what is enabled depends on the moment the palette opens.
 */
import {
    EMULATOR_ACTION_COMMANDS, EMULATOR_ACTIONS,
} from 'vueport-core/lib/browser/emulator-commands';
import { EmulatorCommands } from 'vueport-core/lib/browser/emulator-commands';
import { Command } from 'vueport-core/lib/common/emulator-command';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { APP_SHORTCUTS } from './web-bindings';
import { WebEmulator } from './web-emulator';
import { settingsTabsInOrder } from './web-settings-dialog';
import { PickItem, WebUi } from './web-ui';
import { pickLanguage } from './web-language';
import { pickTheme } from './web-theme';
import {
    PictureSetting,
    pickAnaglyphPalette, pickDecoration, pickPalette, pickRenderingMode, pickScale,
} from './web-display-settings';
import { RecentRom, RecentRoms, recentDetail, recentName, romStem } from './web-recent-roms';
import { canUpdate, checkForUpdate } from './desktop-update';
import { settingCommands } from './web-setting-commands';
import { recentCommands, rememberCommand } from './web-recent-commands';

// opening a ROM is the page's business (unpacking an archive, choosing a ROM in it, a cancellable download), so the
// two commands that start one get the page's own way of doing it
export interface WebCommandContext {
    emulator: WebEmulator;
    ui: WebUi;
    recents: RecentRoms;
    openUrl(raw: string): Promise<void>; // downloads and starts the ROM at an address; reports its own failures
    openRecent(rom: RecentRom): Promise<void>; // reports its own failures
    refreshRecents(): void;
}

export interface WebCommand {
    command: Command;
    // a command that cannot run is still listed, grayed: the palette is where the user finds out what exists
    enabled: boolean;
    run(): void | Promise<void>;
    // for the few commands the page keeps on keys of its own instead of the keymap; the rest have their keys read off
    // the bindings when the palette is built
    keys?: string;
}

function appCategory(): string {
    return nls.localize('vueport/commands/category', 'VUEPort');
}

// a plain object rather than Command.toLocalizedCommand, which exists for commands declared at import time; these are
// built when the palette opens, long after translations are installed
function appCommand(id: string, label: string): Command {
    return { id: `vueport.${id}`, label, category: appCategory() };
}

// in palette order. Not everything the emulator declares: game pad buttons are held rather than run (the studio hides
// them too), and linking and profiling have no implementation here; an entry that does nothing is worse than none
export function webCommands(context: WebCommandContext): WebCommand[] {
    const { emulator, ui } = context;

    // the dock only exists behind a ROM; without one a panel would be built at no size and never seen. Offered grayed
    // rather than hidden, like the transport controls
    const loaded = emulator.hasRom;

    const actions: WebCommand[] = EMULATOR_ACTIONS.map(action => ({
        command: EMULATOR_ACTION_COMMANDS[action],
        enabled: emulator.canRunAction(action),
        run: () => emulator.runAction(action),
    }));

    // a picture setting this build has not settled for everyone
    const settable = (key: PictureSetting): boolean =>
        emulator.settings.fixed?.[key] === undefined;

    return [
        ...actions,
        {
            command: EmulatorCommands.ADD_PANEL,
            enabled: loaded,
            run: () => emulator.pickPanel(),
        },
        {
            command: EmulatorCommands.PLAY_MOVIE,
            enabled: loaded && !emulator.moviePlayer.playing,
            run: () => emulator.pickMovie(),
        },
        {
            command: EmulatorCommands.STOP_MOVIE,
            enabled: emulator.moviePlayer.playing,
            run: () => { emulator.stopMovie().catch(() => undefined); },
        },
        {
            command: EmulatorCommands.RESET_LAYOUT,
            enabled: loaded,
            run: () => emulator.confirmResetLayout(),
        },
        {
            command: EmulatorCommands.SET_SAVE_SLOT,
            // settable with no game running: the slot chosen now is the one the next ROM plays on
            enabled: emulator.settings.fixed?.saveGameSlot === undefined,
            run: () => emulator.pickSaveGameSlot(),
        },
        {
            command: EmulatorCommands.EXPORT_SAVE,
            enabled: loaded,
            run: () => { emulator.exportSaveData().catch(() => undefined); },
        },
        {
            command: EmulatorCommands.IMPORT_SAVE,
            enabled: loaded,
            run: () => emulator.pickSaveData(),
        },
        {
            command: EmulatorCommands.EXPORT_SAVE_STATE,
            enabled: loaded,
            run: () => { emulator.exportSaveState().catch(() => undefined); },
        },
        {
            command: EmulatorCommands.IMPORT_SAVE_STATE,
            enabled: loaded,
            run: () => emulator.pickSaveState(),
        },
        {
            command: EmulatorCommands.DELETE_SRAM,
            enabled: loaded,
            run: () => emulator.deleteSaveSlotAndRestart(),
        },
        // the strips beside the picture and the Play/Debug switch, reachable by name. In hardcore mode cheats, macros,
        // patches and Debug show the "Hardcore Mode is on" notice instead; save states and achievements stay reachable
        {
            command: EmulatorCommands.TOGGLE_SAVE_STATES,
            enabled: loaded,
            run: () => emulator.toggleSaveStates(),
        },
        {
            command: EmulatorCommands.TOGGLE_CHEATS,
            enabled: loaded,
            run: () => emulator.toggleCheats(),
        },
        {
            command: EmulatorCommands.TOGGLE_MACROS,
            enabled: loaded,
            run: () => emulator.toggleMacros(),
        },
        {
            command: EmulatorCommands.TOGGLE_PATCHES,
            enabled: loaded,
            run: () => emulator.togglePatches(),
        },
        {
            command: EmulatorCommands.TOGGLE_ACHIEVEMENTS,
            enabled: loaded,
            run: () => emulator.toggleAchievements(),
        },
        {
            command: EmulatorCommands.TOGGLE_VBC_SUPPORT,
            enabled: emulator.settings.fixed?.vbcSupportEnabled === undefined,
            run: () => emulator.toggleVbcSupport(),
        },
        ...(emulator.vbcSupportEnabled ? [{
            command: EmulatorCommands.SET_HARDWARE_MODE,
            enabled: emulator.settings.fixed?.hardwareMode === undefined,
            run: () => emulator.pickHardwareMode(),
        }] : []),
        {
            command: EmulatorCommands.TOGGLE_DEBUG_MODE,
            enabled: loaded,
            run: () => emulator.toggleDebugMode(),
        },
        {
            command: EmulatorCommands.TOGGLE_COLOR_MODE,
            enabled: loaded,
            run: () => emulator.toggleColorMode(),
        },
        {
            command: appCommand('openRom', nls.localize('vueport/rom/load', 'Load ROM…')),
            enabled: true,
            run: () => emulator.requestOpenRom(),
            // its keys are app.tsx's own rather than the keymap's, so the palette cannot read them off the bindings;
            // see APP_SHORTCUTS
            keys: APP_SHORTCUTS.openRom,
        },
        {
            command: appCommand('openRomFromLink',
                nls.localize('vueport/commands/loadRomFromLink', 'Load ROM from Link…')),
            enabled: true,
            run: () => loadRomFromLink(context),
        },
        {
            command: appCommand('openRecentRom',
                nls.localize('vueport/commands/recent/continue', 'Continue Recently Opened…')),
            enabled: true,
            run: () => continueRecent(context),
        },
        {
            command: appCommand('clearRecentRoms',
                nls.localize('vueport/commands/recent/clear', 'Clear Recently Opened Files')),
            enabled: true,
            run: () => clearRecent(context),
        },
        {
            command: appCommand('closeRom', nls.localize('vueport/rom/close', 'Close ROM')),
            enabled: loaded,
            run: () => emulator.closeRom(),
        },
        {
            command: appCommand('renderingMode',
                nls.localize('vueport/commands/set/renderingMode', 'Set Rendering Mode')),
            enabled: settable('renderingMode'),
            run: () => pickRenderingMode(ui, emulator.settings),
        },
        {
            command: appCommand('scale',
                nls.localize('vueport/commands/set/scale', 'Set Scale')),
            enabled: settable('scale'),
            run: () => pickScale(ui, emulator.settings),
        },
        {
            command: appCommand('decoration',
                nls.localize('vueport/commands/set/decoration', 'Set Screen Decoration')),
            enabled: settable('decoration'),
            run: () => pickDecoration(ui, emulator.settings),
        },
        {
            command: appCommand('colorPalette',
                nls.localize('vueport/commands/set/palette', 'Set Color Palette')),
            enabled: settable('palette'),
            run: () => pickPalette(ui, emulator.settings),
        },
        {
            command: appCommand('anaglyphPalette',
                nls.localize('vueport/commands/set/anaglyphPalette', 'Set Anaglyph Palette')),
            enabled: settable('anaglyphPalette'),
            run: () => pickAnaglyphPalette(ui, emulator.settings),
        },
        {
            command: appCommand('resetAllSettings',
                nls.localize('vueport/commands/resetAllSettings', 'Reset All Settings')),
            enabled: true,
            run: () => emulator.confirmResetAllSettings(),
        },
        // every other setting the dialog has, each by its own name; see web-setting-commands.ts
        ...settingCommands(emulator, ui),
        // the head of the rail every time, not the pane it was left on, so it can be aimed at. The title bar's gear
        // resumes
        {
            command: appCommand('openSettings',
                nls.localize('vueport/commands/openSettings', 'Open Settings')),
            enabled: true,
            run: () => emulator.openSettingsTab(settingsTabsInOrder()[0]),
        },
        // the dialog's panes by name. "Configure", not "Open … Settings", as that is what the user is there to do, and
        // it keeps them together in a list sorted by label
        {
            command: appCommand('display',
                nls.localize('vueport/commands/configure/display', 'Configure Display')),
            enabled: true,
            run: () => emulator.toggleDisplayWindow(),
        },
        {
            command: appCommand('settings',
                nls.localize('vueport/commands/configure/emulation', 'Configure Emulation')),
            enabled: true,
            run: () => emulator.togglePreferencesWindow(),
        },
        {
            command: appCommand('saveData',
                nls.localize('vueport/commands/configure/saveData', 'Configure Save Data')),
            enabled: true,
            run: () => emulator.toggleSaveDataSettings(),
        },
        {
            command: appCommand('saveStates',
                nls.localize('vueport/commands/configure/saveStates', 'Configure Save States')),
            enabled: true,
            run: () => emulator.toggleSaveStateSettings(),
        },
        {
            command: appCommand('screenshots',
                nls.localize('vueport/commands/configure/screenshots', 'Configure Screenshots')),
            enabled: true,
            run: () => emulator.toggleScreenshotSettings(),
        },
        {
            command: appCommand('achievements',
                nls.localize('vueport/commands/configure/achievements', 'Configure Achievements')),
            enabled: true,
            run: () => emulator.toggleAchievementSettings(),
        },
        {
            command: appCommand('hardcoreMode', emulator.retroAchievements.hardcore
                ? nls.localize('vueport/commands/hardcore/off', 'Turn off Hardcore Mode')
                : nls.localize('vueport/commands/hardcore/on', 'Turn on Hardcore Mode')),
            enabled: emulator.retroAchievements.hardcoreControlsAvailable,
            // turning it on prompts and restarts the ROM; turning it off is immediate. Both live in the service
            run: () => emulator.retroAchievements.setHardcore(!emulator.retroAchievements.hardcore),
        },
        {
            command: appCommand('apis',
                nls.localize('vueport/commands/configure/apis', 'Configure APIs')),
            enabled: true,
            run: () => emulator.toggleApiSettings(),
        },
        {
            command: appCommand('appearance',
                nls.localize('vueport/commands/configure/appearance', 'Configure Appearance')),
            enabled: true,
            run: () => emulator.toggleAppearanceSettings(),
        },
        {
            command: appCommand('library',
                nls.localize('vueport/commands/configure/library', 'Configure Library')),
            enabled: true,
            run: () => emulator.toggleLibrarySettings(),
        },
        {
            command: appCommand('theme',
                nls.localize('vueport/commands/changeColorMode', 'Change Color Mode')),
            enabled: true,
            run: () => pickTheme(ui),
        },
        {
            command: appCommand('language',
                nls.localize('vueport/commands/changeLanguage', 'Change Display Language')),
            enabled: true,
            run: () => pickLanguage(ui),
        },
        {
            command: appCommand('about', nls.localize('vueport/about/title', 'About VUEPort')),
            enabled: true,
            run: () => emulator.toggleAboutWindow(),
        },
        // desktop only: a browser runs whatever was served to it, so there is nothing for this to find
        {
            command: appCommand('checkForUpdates',
                nls.localize('vueport/update/check', 'Check for updates')),
            enabled: canUpdate(),
            run: () => {
                // opens the Updates pane and lets the check report itself there; both read the one state in
                // desktop-update.ts
                emulator.toggleUpdatesWindow();
                checkForUpdate().catch(() => undefined);
            },
        },
    ];
}

// the start page's "from a link" field, reachable while a game runs. openUrl has already reported failures in the
// words that fit, so the rejection is swallowed rather than reported twice
async function loadRomFromLink(context: WebCommandContext): Promise<void> {
    const raw = await context.ui.prompt({
        title: nls.localize('vueport/commands/loadRomFromLink', 'Load ROM from Link…'),
        placeholder: nls.localize('vueport/welcome/linkPlaceholder', 'https://…/game.vb'),
        okLabel: nls.localize('vueport/welcome/load', 'Load'),
        type: 'url',
    });
    if (raw) {
        await context.openUrl(raw).catch(() => undefined);
    }
}

// the whole recent list without closing the running game, read when the command runs (a file system trip) rather than
// when the palette is built. Also the start page's "Show all" beside Continue
export async function continueRecent(context: WebCommandContext): Promise<void> {
    const { recents, ui } = context;
    const list = await recents.list();
    if (list.length === 0) {
        ui.toast('info', nls.localize('vueport/commands/recent/none',
            'No ROM has been opened yet.'));
        return;
    }

    const picked = await ui.pick(
        nls.localize('vueport/commands/recent/pick', 'Type the name of a ROM…'),
        list.map(rom => ({
            id: rom.id,
            label: romStem(recentName(rom)),
            description: recentDetail(rom),
        })),
        nls.localize('vueport/commands/recent/noMatch', 'No matching ROM'),
    );
    const chosen = list.find(entry => entry.id === picked?.id);
    if (chosen) {
        await context.openRecent(chosen).catch(() => undefined);
    }
}

// asks first, as this throws away stored ROMs whose files the user may no longer have. Also the start page's small X
// beside "Show all"
export async function clearRecent(context: WebCommandContext): Promise<void> {
    const { recents, ui } = context;
    const list = await recents.list();
    if (list.length === 0) {
        ui.toast('info', nls.localize('vueport/commands/recent/none',
            'No ROM has been opened yet.'));
        return;
    }

    const agreed = await ui.confirm({
        title: nls.localize('vueport/commands/recent/clear', 'Clear Recently Opened Files'),
        message: nls.localize('vueport/commands/recent/clearMessage',
            'Forget all {0} remembered ROMs and delete any copies kept of them? '
            + 'Saves, save states and cheats are not touched.', list.length),
        okLabel: nls.localize('vueport/commands/clear', 'Clear'),
    });
    if (!agreed) {
        return;
    }
    await recents.clear();
    context.refreshRecents();
}

/**
 * Opens the palette and runs the choice. Entries show only the command's name: the category stays on the command for
 * keybinding prompts, but every command here belongs to the app, so a prefix would only cost width. The keys a command
 * answers to are shown beside it. Recently chosen commands come first under their own heading, in the order chosen,
 * like VS Code's "recently used"; the rest follow alphabetically, without them.
 */
export async function openCommandPalette(context: WebCommandContext): Promise<void> {
    const { emulator, ui } = context;
    const commands = webCommands(context);

    const toItem = (entry: WebCommand): PickItem => {
        const { command } = entry;
        return {
            id: command.id,
            label: command.label ?? command.id,
            // the plain form: `(O)` is for a tooltip beside a label, here the keys have a column of their own
            description: entry.keys
                ?? (emulator.bindings.label(command.id, false) || undefined),
            disabled: !entry.enabled,
        };
    };

    const recent = recentCommands()
        .map(id => commands.find(entry => entry.command.id === id))
        .filter((entry): entry is WebCommand => entry !== undefined);

    const others = commands
        .filter(entry => !recent.includes(entry))
        .map(toItem)
        // by translated label rather than id, so alphabetical depends on the language shown
        .sort((a, b) => a.label.localeCompare(b.label));

    // without anything recent there is one group, and a heading would only take a line from it
    const items: PickItem[] = recent.length === 0 ? others : [
        {
            id: 'recently-used',
            label: nls.localize('vueport/commands/recentlyUsed', 'Recently Used'),
            separator: true,
        },
        ...recent.map(toItem),
        {
            id: 'other-commands',
            label: nls.localize('vueport/commands/otherCommands', 'Other Commands'),
            separator: true,
        },
        ...others,
    ];

    const picked = await ui.pick(
        nls.localize('vueport/commands/placeholder', 'Type the name of a command…'),
        items,
        nls.localize('vueport/commands/noMatch', 'No matching command'),
        nls.localize('vueport/status/commandPalette', 'Command Palette'),
    );
    if (!picked) {
        return;
    }
    rememberCommand(picked.id);
    await commands.find(entry => entry.command.id === picked.id)?.run();
}
