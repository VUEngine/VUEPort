import {
    ArrowCircleUp,
    Books,
    Camera,
    CircleHalf,
    ClockCountdown,
    Cpu,
    FolderOpen,
    GameController,
    Info,
    Monitor,
    SpeakerHigh,
    TerminalWindow,
    Trophy,
    VideoCamera,
    VirtualReality
} from '@phosphor-icons/react';
import * as React from 'react';
import { SettingsTabSpec, SettingsWindow } from 'vueport-core/lib/browser/components/SettingsWindow';
import {
    DISPLAY_SETTINGS,
    EMULATION_SETTINGS,
    FILE_SETTINGS,
    SAVE_DATA_SETTINGS,
    SAVE_STATE_SETTINGS,
    SCREENSHOT_SETTINGS,
    SOUND_SETTINGS,
    TOUCH_SETTINGS,
    VB_COLOR_SETTINGS,
    VIDEO_SETTINGS,
} from 'vueport-core/lib/browser/components/settings/settings-index';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { VueportConfig, VueportSettings } from 'vueport-core/lib/common/emulator-settings';
import { canUpdate } from './desktop-update';
import { ChunkBoundary } from './web-chunk';
import { steerSettingsWithGamepad, steerSettingsWithKeyboard } from './web-settings-gamepad';
import { MemoryIcon } from './web-memory-icon';
import { VbColorIcon } from './web-vbc-icon';

export type SettingsTab =
    | 'display' // how the picture is drawn, palettes included
    | 'input'
    | 'vbcolor'
    | 'sound' // interface cues
    | 'emulation'
    | 'saveData' // which slot a game plays on and what a fresh save holds
    | 'saveStates' // the states the emulator takes by itself
    | 'files' // the folder all of the save data goes to
    | 'screenshots'
    | 'video'
    | 'achievements'
    | 'library'
    | 'vr'
    | 'appearance' // language and light/dark
    | 'updates' // desktop only
    | 'probe'
    | 'about';

/**
 * Every tab this build carries, rebuilt per call as labels and search keywords are localized. Not the display order:
 * the rail sorts by label (see settingsTabsInOrder). Schema-backed panes feed the search index with their settings,
 * hand-written ones carry keywords. `updates` is left out in a browser, which runs what is served, just as its command
 * is left out of the palette.
 */
export function settingsTabs(): SettingsTabSpec<SettingsTab>[] {
    return [
        {
            id: 'display',
            label: nls.localize('vueport/settings/tabs/display', 'Display'),
            icon: <Monitor size={18} />,
            settings: DISPLAY_SETTINGS,
            alsoResets: ['palette', 'anaglyphPalette'],
        },
        {
            id: 'input',
            label: nls.localize('vueport/input/gamePads/input', 'Input'),
            icon: <GameController size={18} />,
            settings: TOUCH_SETTINGS, // the key and pad pages are hand-written and use the keywords
            alsoResets: ['touchControlsLayout'],
            keywords: nls.localize('vueport/settings/keywords/input',
                'input keybinding keyboard controller game pad button rebind d-pad reset preset \
wasd arrows player 2 power switch'),
        },
        {
            id: 'vbcolor',
            label: nls.localize('vueport/settings/tabs/vbColor', 'VB Color'),
            // smaller than the rail's icons, as the mark is heavier than their outlines, but in the same 18-pixel box
            // so the label lines up
            icon: <VbColorIcon size={16} box={18} />,
            settings: VB_COLOR_SETTINGS,
        },
        {
            id: 'sound',
            label: nls.localize('vueport/settings/tabs/sound', 'Sound'),
            icon: <SpeakerHigh size={18} />,
            settings: SOUND_SETTINGS,
        },
        {
            id: 'emulation',
            label: nls.localize('vueport/settings/tabs/emulation', 'Emulation'),
            icon: <Cpu size={18} />,
            settings: EMULATION_SETTINGS,
        },
        {
            id: 'saveData',
            label: nls.localize('vueport/preferences/sections/saveData', 'Save Data'),
            icon: <MemoryIcon size={18} />, // the cartridge's save chip
            settings: SAVE_DATA_SETTINGS,
        },
        {
            id: 'saveStates',
            label: nls.localize('vueport/saveStates/title', 'Save States'),
            // the same mark as the state browser and its title bar button
            icon: <ClockCountdown size={18} />,
            settings: SAVE_STATE_SETTINGS,
        },
        {
            id: 'files',
            label: nls.localize('vueport/preferences/sections/files', 'Files'),
            icon: <FolderOpen size={18} />,
            settings: FILE_SETTINGS,
        },
        {
            id: 'screenshots',
            label: nls.localize('vueport/settings/tabs/screenshots', 'Screenshots'),
            icon: <Camera size={18} />,
            settings: SCREENSHOT_SETTINGS,
            alsoResets: ['screenshotPalette', 'screenshotAnaglyphPalette'],
        },
        {
            id: 'video',
            label: nls.localize('vueport/settings/tabs/video', 'Video'),
            icon: <VideoCamera size={18} />,
            settings: VIDEO_SETTINGS,
            alsoResets: ['videoPalette', 'videoAnaglyphPalette'],
        },
        {
            id: 'achievements',
            label: nls.localize('vueport/achievements/title', 'Achievements'),
            icon: <Trophy size={18} />,
            keywords: nls.localize('vueport/settings/keywords/achievements',
                'retroachievements achievements leaderboards ranking score account sign in log in \
hardcore points track unlock sync out up username password mode aids casual'),
        },
        {
            id: 'library',
            label: nls.localize('vueport/settings/tabs/library', 'Library'),
            icon: <Books size={18} />,
            keywords: nls.localize('vueport/settings/keywords/library',
                'library folders scan read roms covers recently opened continue api apis endpoint url \
base address server proxy relay homebrew game info catalog planet vb mirror add \
import remove recursively subfolders zip archives enrich metadata empty box update \
on start startup page shelf all games favorites featured picks archive played auto \
last amount remember'),
        },
        {
            id: 'vr',
            label: nls.localize('vueport/settings/tabs/vr', 'VR'),
            icon: <VirtualReality size={18} />,
            keywords: nls.localize('vueport/settings/keywords/vr',
                'vr virtual reality xr webxr headset quest meta screen size width depth 3d \
backdrop passthrough hologram room ar'),
        },
        {
            id: 'appearance',
            label: nls.localize('vueport/theme/title', 'Appearance'),
            icon: <CircleHalf size={18} />,
            keywords: nls.localize('vueport/settings/keywords/appearance',
                'appearance language theme color color mode dark light command palette recently used \
commands history system'),
        },
        ...canUpdate() ? [{
            id: 'updates' as const,
            label: nls.localize('vueport/settings/tabs/updates', 'Updates'),
            icon: <ArrowCircleUp size={18} />,
            keywords: nls.localize('vueport/settings/keywords/updates',
                'update updates upgrade newer version release notes download install automatically \
check at start restart'),
        }] : [],
        // desktop only, like Updates: a browser cannot open a port for a tool to connect to
        ...canUpdate() ? [{
            id: 'probe' as const,
            label: nls.localize('vueport/settings/tabs/tools', 'Tools'),
            icon: <TerminalWindow size={18} />,
            keywords: nls.localize('vueport/settings/keywords/probe',
                'probe tools ai agent vbprobe connect port socket remote debugging memory registers \
automation script instructions pause save states'),
        }] : [],
        {
            id: 'about',
            label: nls.localize('vueport/about/title', 'About VUEPort'),
            icon: <Info size={18} />,
            keywords: nls.localize('vueport/settings/keywords/about',
                'about version license credits authors'),
            foot: true,
        },
    ];
}

// alphabetically by label, About aside
export const settingsTabsInOrder = (): SettingsTab[] =>
    settingsTabs()
        .filter(tab => !tab.foot)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(tab => tab.id);

// what Reset All covers
export const resettableSettings = (): (keyof VueportConfig)[] =>
    [...new Set(settingsTabs().flatMap(tab => [...tab.settings ?? [], ...tab.alsoResets ?? []]))];

// the window itself (rail, search, layout) is core's and shared with the studio; here are the panes, their lazy loading
// and pad/keyboard steering (web-settings-gamepad.ts)
export function WebSettingsDialog(props: {
    tab: SettingsTab,
    onTab: (tab: SettingsTab) => void,
    onClose: () => void,
    renderPane: (tab: SettingsTab, search: string) => React.ReactNode,
    resetAll?: { settings: VueportSettings, confirm: () => Promise<boolean> },
    closable?: boolean,
    startOnList?: boolean,
    leaving?: boolean, // sliding out, see WebEmulator.closeSettings
}): React.JSX.Element {
    const tabs = React.useMemo(settingsTabs, []);
    // through a ref, as the caller hands a fresh arrow every render and the pad is taken once while the window is up
    const close = React.useRef(props.onClose);
    close.current = props.onClose;
    React.useEffect(() => {
        const releasePad = steerSettingsWithGamepad(() => close.current());
        const releaseKeys = steerSettingsWithKeyboard(() => close.current());
        return () => {
            releasePad();
            releaseKeys();
        };
    }, []);
    return <SettingsWindow<SettingsTab>
        tabs={tabs}
        tab={props.tab}
        onTab={props.onTab}
        onClose={props.onClose}
        renderPane={props.renderPane}
        resetAll={props.resetAll}
        closable={props.closable}
        startOnList={props.startOnList}
        leaving={props.leaving}
        // a boundary per pane keeps the window, search and rail mounted while a chunk arrives or fails; one around the
        // whole overlay would make the window blink out
        paneBoundary={(tab, pane) =>
            <ChunkBoundary resetKey={tab}>
                <React.Suspense fallback={null}>{pane}</React.Suspense>
            </ChunkBoundary>}
    />;
}
