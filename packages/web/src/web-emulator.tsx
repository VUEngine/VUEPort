import { TabBar, Widget } from '@lumino/widgets';
import * as React from 'react';
import { EmulatorHost } from 'vueport-core/lib/browser/components/Emulator';
import type { ProbeTarget } from 'vueport-core/lib/probe/probe-session';
import EmulatorAchievements from 'vueport-core/lib/browser/components/EmulatorAchievements';
import EmulatorCheats from 'vueport-core/lib/browser/components/EmulatorCheats';
import EmulatorMacros from 'vueport-core/lib/browser/components/EmulatorMacros';
import EmulatorPatches from 'vueport-core/lib/browser/components/EmulatorPatches';
import EmulatorSaveStates from 'vueport-core/lib/browser/components/EmulatorSaveStates';
import type { Library } from './web-library';
import { settingsTabsInOrder, type SettingsTab } from './web-settings-dialog';
import type { InputSettingsPage } from 'vueport-core/lib/browser/components/settings/InputSettings';
import type { TouchControlsLayout } from 'vueport-core/lib/common/emulator-settings';
import { SettingsSearchFilter } from 'vueport-core/lib/browser/components/settings/SettingsSearchFilter';
import EmulatorScreenPreview from 'vueport-core/lib/browser/components/EmulatorScreenPreview';
import { EmulatorToolbarState } from 'vueport-core/lib/browser/components/EmulatorToolbar';
import { DEFAULT_KIT_SERVICES } from 'vueport-core/lib/browser/components/kit/KitContext';
import { Core, Sim } from 'vueport-core/lib/browser/core/vb-core';
import { CheatFinder } from 'vueport-core/lib/browser/emulator-cheat-finder';
import { CheatStore } from 'vueport-core/lib/browser/emulator-cheat-store';
import { MacroStore, MacroActivity } from 'vueport-core/lib/browser/emulator-macro-store';
import { MoviePlayer } from 'vueport-core/lib/browser/emulator-movie-player';
import { looksLikeVesMovie, parseVesMovie } from 'vueport-core/lib/common/emulator-movie';
import { PatchStore } from 'vueport-core/lib/browser/emulator-patch-store';
import {
    SaveStateEntry,
    SaveStateMachine,
    SaveStateStore,
    withOtherRomOffer,
} from 'vueport-core/lib/browser/emulator-save-state-store';
import {
    EmulatorResumeStart,
    SaveStateKind,
    VesEmulatorSaveStateIdentity,
} from 'vueport-core/lib/common/emulator-save-state';
import { modifiedSettings, resetAllSettingsConfirmation, resetSettings } from 'vueport-core/lib/browser/emulator-settings-reset';
import { EmulatorCommands, resetLayoutConfirmation } from 'vueport-core/lib/browser/emulator-commands';
import { EmulatorCoreService, EmulatorSession } from 'vueport-core/lib/browser/emulator-core-service';
import { LinkCartridge, LinkReport } from 'vueport-core/lib/browser/link-session';
import { EsSoundPlayer, EsSoundSnapshot } from 'vueport-core/lib/browser/emulator-essound-player';
import { VideoRecorder } from 'vueport-core/lib/browser/emulator-video-recorder';
import { EmulatorXrController } from 'vueport-core/lib/browser/emulator-xr-controller';
import type { XrAvailability } from 'vueport-core/lib/browser/emulator-xr';
import { EmulatorInputController, EmulatorInputHost, GAMEPAD_KEY_TO_VB_KEY } from 'vueport-core/lib/browser/emulator-input';
import {
    connectedGamepadList,
    GamepadProfileResolver,
    StoredGamepadProfiles,
} from 'vueport-core/lib/browser/emulator-gamepad';
import { GamepadRumble } from 'vueport-core/lib/browser/emulator-gamepad-rumble';
import { GamepadDatabase } from 'vueport-core/lib/common/emulator-gamepad-profiles';
import { clampTurboRate } from 'vueport-core/lib/common/emulator-turbo';
import { shareGamepadProfile } from './web-gamepad-share';
import { steerWindowWithGamepad } from './web-gamepad-ui';
import { EmulatorTimeControl, EmulatorTimeControlHost, EmulatorTimeSettings } from 'vueport-core/lib/browser/emulator-time-control';
import { EmulatorRewindBrowser, EmulatorRewindBrowserHost } from 'vueport-core/lib/browser/emulator-rewind-browser';
import {
    CUSTOM_PALETTE_PREFIX,
    EMPTY_ROM_HEADER,
    EmulatorAction,
    EmulatorDecoration,
    EmulatorMode,
    EmulatorRomStatus,
    ROM_HEADER_OFFSET_FROM_END,
    RomHeader,
    VbColorSupport,
    VbHardwareMode,
    emulationAnaglyphPalettes,
    emulatorHardwareModeLabels,
    emulationPalettes,
    formatColor,
    paletteDecorationColor,
    parseRomHeader,
    resolveAnaglyphPalette,
    resolveVbHardwareMode,
    resolvePalette,
    BYTES_PER_MBIT,
    romSizeInMBit,
} from 'vueport-core/lib/browser/emulator-types';
import { VueportDock } from 'vueport-core/lib/browser/panels/emulator-dock';
import { ColorEditor } from 'vueport-core/lib/browser/color/emulator-color-editor';
import {
    BACKDROP_COLUMNS,
    BACKDROP_ROWS,
    EmulatorDecorationSpec,
} from 'vueport-core/lib/browser/panels/emulator-screen-panel';
import {
    EMULATOR_COLOR_PANEL_TYPES,
    EMULATOR_PANEL_TYPES,
    EmulatorPanelType,
    emulatorPanelLabel,
} from 'vueport-core/lib/browser/panels/emulator-panel';
import {
    EMULATOR_PANEL_CATEGORIES,
    EmulatorPanelCategory,
    emulatorPanelCategory,
    emulatorPanelIcon,
} from 'vueport-core/lib/browser/panels/emulator-panel-icons';
import { Disposable, DisposableCollection, Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { VueportNotifications, VueportStorage } from 'vueport-core/lib/common/emulator-host';
import { beginLoadTrace, markLoadTrace } from 'vueport-core/lib/common/load-trace';
import { crc32, formatRomId } from 'vueport-core/lib/common/emulator-cheat-database';
import { md5Hex } from 'vueport-core/lib/common/emulator-md5';
import { isColorPatch } from 'vueport-core/lib/common/emulator-rom-patches';
import { RetroAchievementsService } from 'vueport-core/lib/browser/emulator-retroachievements';
import { NO_RUMBLE_PACK, VueportRumblePack } from 'vueport-core/lib/common/emulator-rumble';
import { ScheduledEdit, Speed } from 'vueport-core/lib/common/vb-protocol';
import { isEsSoundFile } from 'vueport-core/lib/common/emulator-essound';
import {
    freshSaveRam,
    saveRamFileSize,
    saveRamWindowBytes,
} from 'vueport-core/lib/common/emulator-save-state';
import {
    DEFAULT_SAVE_SLOT,
    EMULATOR_SAVE_SLOTS,
    emulatorSaveSlot,
} from 'vueport-core/lib/common/emulator-sram';
import { CompanionRom, EmulatorCompanionFiles } from 'vueport-core/lib/browser/emulator-companion-files';
import { cachedRom, lookupRom } from './web-planet-vb';
import { userActivationIsActive } from 'vueport-core/lib/browser/emulator-xr-storage';
import { compactLayout } from 'vueport-core/lib/browser/compact-layout';
import { firefoxProfileFrom } from './web-profile';
import { RomSound, romFrom, shownFileName } from './web-rom-source';
import { looksLikeZip, storeZip } from './web-zip';
import { PlayTimes } from './web-play-time';
import { RecentRoms } from './web-recent-roms';
import { FolderMinus, FolderOpen, Trash } from '@phosphor-icons/react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { EmulatorToolbarControl } from 'vueport-core/lib/browser/components/EmulatorToolbar';
import { VueportConfig, VueportInputBindings, VueportSettings } from 'vueport-core/lib/common/emulator-settings';
import {
    VB_DEFAULT_DISPLAY_MODE,
    VbAnaglyphPalette,
    DisplayMode,
    VbPalette,
    VbRenderingMode,
    buildDisplayMode,
} from 'vueport-core/lib/common/vb-constants';
import { WebBindings } from './web-bindings';
import { ChunkBoundary, chunkErrorMessage, importChunk } from './web-chunk';
import { PickItem, WebUi } from './web-ui';
import { pickNumberSetting } from './web-display-settings';
import { isDesktop, isWindowFullscreen, setWindowFullscreen } from './desktop-bridge';
import { VesLineTable } from 'vueport-core/lib/browser/core/emulator-line-table';
import { readRomBuildFile } from './desktop-open';
// the readers are imported where used, so the 50 KB of ELF and DWARF parsing, only needed on a desktop with a
// build beside the ROM, is a chunk of its own
import type { SymbolIndex } from 'vueport-core/lib/browser/core/emulator-symbols';
import { onDidChangeTheme } from './web-theme';
import {
    downloadLanShare,
    LanShareMoment,
    LanSharing,
    lanShareRomUrl,
    ReachedLanShare,
    takeLanShareMoment,
} from 'vueport-core/lib/browser/emulator-lan-share';
import { desktopLanShareShell } from './desktop-lan-share';

/**
 * The windows over the emulator (settings dialog and panes, ROM information), loaded when one is opened, as each is a
 * sizeable chunk (palette editor, controller diagram, RetroAchievements, color picker). renderOverlay catches their
 * lazy imports; the settings dialog has a narrower boundary around its pane so the dialog never hides. The rail reads
 * plain data from settings-index, so opening the dialog fetches no pane.
 */
const InputSettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/InputSettings')));
const DisplaySettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/DisplaySettings')));
const EmulationSettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/EmulationSettings')));
const FileSettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/FileSettings')));
const SaveDataSettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/SaveDataSettings')));
const SaveStateSettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/SaveStateSettings')));
const ScreenshotSettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/ScreenshotSettings')));
const SoundSettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/SoundSettings')));
const VbColorSettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/VbColorSettings')));
const VideoSettings = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/settings/VideoSettings')));
const WebAbout = React.lazy(() => importChunk(() => import('./web-about')));
const WebAppearance = React.lazy(() => importChunk(() => import('./web-appearance')));
const WebLibrarySettings = React.lazy(() => importChunk(() => import('./web-library-settings-pane')));
const WebRetroAchievementsPane = React.lazy(() => importChunk(() => import('./web-retroachievements-pane')));
const WebRomInfo = React.lazy(() => importChunk(() => import('./web-rom-info')));
// as long as the settings window's slide out on a phone takes, see closeSettings and .vp-window-leaving
const SETTINGS_LEAVE_MS = 220;

const NetworkSharesWindow = React.lazy(() => importChunk(() =>
    import('vueport-core/lib/browser/components/NetworkSharesWindow')));
const WebUpdates = React.lazy(() => importChunk(() => import('./web-update')));
const WebProbe = React.lazy(() => importChunk(() => import('./web-probe')));
const XrSettings = React.lazy(() => importChunk(() => import('vueport-core/lib/browser/components/settings/XrSettings')));
const WebSettingsDialog = React.lazy(() => importChunk(async () => ({
    default: (await import('./web-settings-dialog')).WebSettingsDialog,
})));

const DEFAULT_VOLUME = 1;
const STATE_KEY = 'vueport.state';
const DOCK_LAYOUT_KEY = 'vueport.dock-layout';

// the still the Display pane's preview shows when no game is running, served from packages/web/public and
// recolored through the current palette
const PLACEHOLDER_SCREENSHOT = '/placeholder-screenshot.png';

// patches shipped as static files beside the page, read when their game opens: a translation is up to a megabyte,
// a colorization a few hundred KB. Cached per path for the session; a failed read is forgotten so the next one retries
const shippedPatches = new Map<string, Promise<Uint8Array>>();
const loadShippedPatch = (file: string): Promise<Uint8Array> => {
    let pending = shippedPatches.get(file);
    if (!pending) {
        pending = fetch(`./${file}`).then(async response => {
            if (!response.ok) {
                throw new Error(`${file}: ${response.status} ${response.statusText}`);
            }
            return new Uint8Array(await response.arrayBuffer());
        });
        pending.catch(() => shippedPatches.delete(file));
        shippedPatches.set(file, pending);
    }
    return pending;
};

// the controller name database, fetched when the Game Pads settings first open and kept for the session. Module
// level, as the page's effect is keyed on the function; a promise, so quick reopenings share one request; undefined
// on failure (no file, offline first run), as the page then just shows rawer names
let controllerNames: Promise<GamepadDatabase | undefined> | undefined;
const loadControllerNames = (): Promise<GamepadDatabase | undefined> =>
    controllerNames ??= fetch('./controller-names.json')
        .then(response => response.ok ? response.json() : undefined)
        .catch(() => undefined);

// a linked session is two windows, each a whole emulator, differing only in the player and (sharing one origin's
// storage) the namespace for layout and toolbar state; see web-link.ts
export interface WebEmulatorOptions {
    instanceId?: string;
    player?: 1 | 2;
    persist?: boolean;
}

// the seam between "there is a second player" and how they are connected (two tabs today); see web-link.ts
export interface LinkFacade {
    request(): void;
    release(): void; // this window's game carries on alone
    readonly linked: boolean;
    readonly status: 'idle' | 'relinkable' | 'waiting' | 'linked'; // see EmulatorToolbarHost#linkStatus
    sendKeys(keys: number): void;
    sendTurbo(keys: number, rate: number): void;
    // a save state of a linked game has to cover the pair; one snapshot says nothing about the partner
    snapshot(): Promise<{ p1: ArrayBuffer, p2: ArrayBuffer } | undefined>;
    resume(p1: ArrayBuffer, p2: ArrayBuffer): Promise<void>;
    restart(): Promise<void>; // resets both consoles at once
    setPaused(paused: boolean): void; // for the other window to follow
    // the other player's machine, run in this window alongside our own, frame for frame, for the debugger to point at
    readonly peerSim: Sim | undefined;
    // where a cheat switch and a debugger poke go during a session; false when nothing could take them, and the
    // caller writes into its own machine as when playing alone
    scheduleEdits(target: 'own' | 'peer', edits: ScheduledEdit[]): boolean;
}

// in chunks so a large frame is safe
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `data:${mime};base64,${btoa(binary)}`;
}

// `1:07`, for the notice that saves a recording
function formatVideoDuration(seconds: number): string {
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// the strips beside the screen, see showSideStrip
type SideStrip = 'saveStates' | 'cheats' | 'macros' | 'patches' | 'achievements';

/**
 * The toolbar's state, in sessionStorage: a page reloading itself mid-session (language or appearance change) keeps a
 * muted game quiet, but one muted yesterday doesn't start silent today. It goes with the process however that ends,
 * Command-Q included. On the desktop it stays out of config.json, which mirrors localStorage (see desktop-config.ts).
 */
interface PersistedState {
    muted: boolean;
    mode: EmulatorMode;
}

/**
 * The standalone web app's emulator, counterpart of VUEngine Studio's VesEmulatorWidget: owns the session, the dock and
 * the toolbar's state, and serves as the host for the chrome, keyboard and game pad input, and time control (pause,
 * speed, rewind). Not a widget but the whole page, a plain object firing an event when something changed.
 */
export class WebEmulator implements EmulatorHost, EmulatorInputHost, EmulatorTimeControlHost,
    EmulatorRewindBrowserHost {

    readonly dock: VueportDock;
    // only active while Color mode is on (see ColorEditor); the dock holds it for its panels and tools
    readonly colorEditor: ColorEditor;
    protected runningImage?: Uint8Array; // the image the machine was started with, every patch applied
    readonly cheats: CheatStore;
    readonly cheatFinder: CheatFinder;
    readonly macros: MacroStore;
    readonly moviePlayer: MoviePlayer;
    readonly patches: PatchStore;
    readonly esSound: EsSoundPlayer;
    readonly saveStates: SaveStateStore;
    readonly input: EmulatorInputController;
    readonly time: EmulatorTimeControl;
    readonly rewindBrowser: EmulatorRewindBrowser; // the Rewind button's filmstrip, see EmulatorRewindStrip

    protected readonly onDidChangeEmitter = new Emitter<void>();
    // not onDidChange, as EmulatorTimeControlHost claims that name for a redraw request
    readonly onStateChanged: Event<void> = this.onDidChangeEmitter.event;

    protected readonly toDispose = new DisposableCollection();

    protected readonly instanceId: string; // 'web' for player 1, 'web-p2' for player 2
    readonly player: 1 | 2; // player 2 reads its own controls and save file
    protected readonly persistState: boolean;
    protected link: LinkFacade | undefined; // set once the link controller exists, see setLink
    protected toolsLinked = false; // what applyLinkToTools last set up, so it only acts on a change
    protected searchedSim: Sim | undefined; // see followInspectedSim

    protected session: EmulatorSession | undefined;
    core: Core | undefined;
    sim: Sim | undefined;

    status: EmulatorRomStatus = EmulatorRomStatus.NOT_EXISTS;
    profiling = false;
    // held here rather than by the screen panel, as it depends on the core's audio graph, the machine's frames and
    // ESSound's playback
    protected videoRecorder: VideoRecorder | undefined;
    protected videoRecorderFailure: Disposable | undefined;
    readonly xr: EmulatorXrController = new EmulatorXrController({
        sim: () => this.sim,
        core: () => this.core,
        input: () => this.input,
        displayMode: () => this.getDisplayMode(),
        applyStereoDepth: () => this.applyStereoDepth(),
        update: () => this.update(),
        notifyError: message => this.notifications.error(message),
        setHeadset: headset => {
            this.ui.setHeadset(headset);
            this.setHeadsetPanels(headset !== undefined);
            // out of the headset a game paused for its interface stays paused, as whoever took it off is not playing
            this.pausedForXrUi = false;
        },
        onXrUiShown: shown => this.pauseForXrUi(shown).catch(error => this.onError(String(error))),
        // ?xr-layers=off draws into the eye buffers even where quad layers are offered, to tell a layer problem apart
        quadLayers: new URLSearchParams(location.search).get('xr-layers') !== 'off',
        debug: new URLSearchParams(location.search).has('xr-debug'),
        // a Quest's browser is a headset's: there the app starts in it, where the browser allows (enterAtStart)
        enterAtStart: /OculusBrowser/.test(navigator.userAgent),
    });
    isDisposed = false;
    isVisible = true;

    // `location` is only known when opened from a real filesystem (the desktop shell), `archive` is the file it was
    // unpacked from (`Super Metroid.vbz`, see archiveName)
    protected rom: { name: string, data: Uint8Array, location?: string, archive?: string } | undefined;
    protected romId: string | undefined;
    protected romMd5Value: string | undefined;
    // whole-file MD5. Computed on first use rather than on open: hashing 16 MB takes a few hundred ms on the thread
    // putting a picture on screen, and only the fire-and-forget RetroAchievements lookup wants it
    protected get romMd5(): string | undefined {
        if (this.romMd5Value === undefined && this.rom) {
            this.romMd5Value = md5Hex(this.rom.data);
        }
        return this.romMd5Value;
    }
    // which of the two layouts a ROM's save, states and cheats go into
    protected readonly companions: EmulatorCompanionFiles;

    // the pack the dock was built with, for the status bar; a page cannot reach a serial port, so in a browser it
    // is never plugged in, while the desktop app passes a real one
    readonly rumblePack: VueportRumblePack;

    // as the worker last reported it; undefined until the first report, a second in. Named as EmulatorStatusSource
    // asks, as the readouts are shared with the studio
    emulationSpeed: Speed | undefined;

    // the poll feeding the immersion decoration (see applyDecoration): only while it is on and a game plays, a few
    // times a second, as the blurred halo needs only the gist. sampling guards against overlapping reads
    protected decorationTimer?: ReturnType<typeof setInterval>;
    protected decorationSampling = false;

    // a thumbnail for the recent-ROMs list a few seconds after start, past the boot screen and title card;
    // canceled if the ROM is closed or swapped first
    protected recentThumbnailTimer?: ReturnType<typeof setTimeout>;

    // the cold restart caused by the latest hardware setting change
    protected hardwareConfigurationChange: Promise<void> = Promise.resolve();
    // cold restarts caused by patch switches, kept strictly in order
    protected patchConfigurationChange: Promise<void> = Promise.resolve();
    // hardcore performs its own restart after disabling every patch
    protected suppressPatchRestart = false;

    // undefined for none. The studio's four windows (input, palettes, settings, About) are one dialog here, plus
    // Display and Appearance; EmulatorToolbarState's showControls/showPalettes/showPreferences are the studio's
    activeSettingsTab: SettingsTab | undefined;

    // the pane openSettings comes back to, so the title bar's gear resumes; the "Open Settings" command
    // deliberately opens the head of the rail instead
    protected lastSettingsTab: SettingsTab = 'display';
    // the Input pane page a link asked for; cleared by every other way into the dialog
    protected inputPage: InputSettingsPage | undefined;
    // bumped by every such link, so one followed while the pane is open still lands
    protected inputPageSerial = 0;
    // the settings window sliding out on a phone, still drawn for the length of its animation; see closeSettings
    protected leavingSettingsTab: SettingsTab | undefined;
    protected leavingTimer: ReturnType<typeof setTimeout> | undefined;
    protected editingTouchLayout = false; // the on-screen controller's layout editor is up, see editTouchLayout
    // the next settings window opens on its list of panes rather than on one (on a phone, see SettingsWindow)
    protected settingsOnList = true;

    showRomInfo = false; // opened by the ROM name in the title bar, with what Planet VB knows about the game

    showNetworkShares = false; // opened by the title bar's share button: games sent between devices of this network

    // the desktop's share of the running game with a headset in the same network; nothing in a browser, which cannot
    // serve one. See emulator-lan-share.ts in core
    readonly lanSharing: LanSharing | undefined = isDesktop() ? new LanSharing(desktopLanShareShell) : undefined;
    // the CRC32 of the file the share was made of, so opening another game ends it but a restart of this one does not
    protected lanSharedRomId: string | undefined;
    // shared from the library rather than as it ran: it outlives the game that was running, and any that is opened
    protected lanSharedFromLibrary = false;

    protected readonly onDidRequestOpenRomEmitter = new Emitter<void>();
    // the toolbar's button or the status bar's ROM entry; the application owns the file picker, shared with the
    // start page along with the "does this look like a ROM" check
    readonly onDidRequestOpenRom: Event<void> = this.onDidRequestOpenRomEmitter.event;

    requestOpenRom(): void {
        this.onDidRequestOpenRomEmitter.fire();
    }

    protected readonly onDidReceiveRomEmitter =
        new Emitter<{ name: string, data: Uint8Array, location?: string }>();
    // a ROM opened from the desktop: the file is already in hand, the application opens it as it does a picked one
    readonly onDidReceiveRom: Event<{ name: string, data: Uint8Array, location?: string }> =
        this.onDidReceiveRomEmitter.event;

    // location is where the file is, when the host knows, which decides whether its save can go beside it
    receiveRom(name: string, data: Uint8Array, location?: string): void {
        this.onDidReceiveRomEmitter.fire({ name, data, location });
    }
    romHeader: RomHeader = EMPTY_ROM_HEADER;
    romSize = 0;
    // read once per ROM from the .map beside it, asynchronously, and held: the header is pushed to the dock again on
    // every patch change, and a push without it would drop the ROM Info row
    protected romBuildMode: string | undefined;

    state: EmulatorToolbarState;

    constructor(
        protected readonly coreService: EmulatorCoreService,
        readonly settings: VueportSettings,
        readonly bindings: VueportInputBindings,
        protected readonly storage: VueportStorage,
        protected readonly notifications: VueportNotifications,
        protected readonly ui: WebUi,
        protected readonly recents: RecentRoms,
        protected readonly playTimes: PlayTimes,
        readonly retroAchievements: RetroAchievementsService,
        rumblePack?: VueportRumblePack,
        options?: WebEmulatorOptions,
    ) {
        this.instanceId = options?.instanceId ?? 'web';
        this.player = options?.player ?? 1;
        this.persistState = options?.persist ?? true;
        this.rumblePack = rumblePack ?? NO_RUMBLE_PACK;
        const persisted = this.loadPersisted();
        this.state = {
            loaded: false,
            paused: false,
            muted: persisted.muted,
            lowPower: false,
            slowmotion: false,
            fastForward: false,
            frameAdvance: false,
            showControls: false,
            showPalettes: false,
            showPreferences: false,
            showCheats: false,
            showMacros: false,
            showPatches: false,
            showAchievements: false,
            showSaveStates: false,
            saveStateExists: false,
            mode: persisted.mode,
        };

        this.companions = new EmulatorCompanionFiles(
            this.storage, () => this.settings.get('companionFiles'));
        const itemStateStorage = this.persistState ? window.localStorage : undefined;
        this.cheats = new CheatStore(this.storage, undefined, itemStateStorage);
        this.cheatFinder = new CheatFinder();
        this.macros = new MacroStore(
            // the shared file, so a macro can belong to every game rather than the one it was recorded in
            this.storage, itemStateStorage, () => this.companions.globalMacros());
        this.moviePlayer = new MoviePlayer();
        this.patches = new PatchStore(this.storage, undefined, itemStateStorage, loadShippedPatch, {
            choice: () => ({
                // a colorization is a ROM patch, and nothing patches the ROM by itself in a hardcore session
                autoApply: this.settings.get('vbcAutoApplyColorPatches') && !this.isHardcore(),
                disabled: this.settings.get('vbcColorPatchesDisabled'),
            }),
            remember: (id, apply) => this.rememberColorChoice(id, apply),
        });
        this.esSound = new EsSoundPlayer(this.storage);
        this.saveStates = new SaveStateStore(this.storage, this.companions);
        // the one flag the chrome reads about the library: whether Load State has anything to load
        this.toDispose.push(this.saveStates.onDidChange(() => this.refreshSaveStateExists()));
        this.colorEditor = new ColorEditor({
            storage: this.storage,
            notifications: this.notifications,
            sim: () => this.sim,
            romPath: () => this.rom ? this.companions.romPath(this.rom) : undefined,
            romId: () => this.romId,
            originalRom: () => this.rom?.data,
            runningRom: () => this.runningImage,
            colorizations: () => this.patches.list
                .filter(isColorPatch)
                .map(patch => ({ id: patch.id!, name: patch.name, data: patch.data, enabled: patch.enabled })),
            vbcActive: () => this.vbcHardwareActive,
            capture: async () => {
                const png = this.sim ? await this.sim.capture(undefined, 1) : undefined;
                return png ? new Uint8Array(png) : undefined;
            },
            restoreState: async state => {
                await this.sim?.loadState(state, { clearCaches: true });
            },
            useColorization: id => {
                const index = this.patches.list.findIndex(patch => patch.id === id);
                if (index >= 0) {
                    this.patches.setEnabled(index, true);
                }
            },
            switchOffColorization: () => {
                const index = this.patches.list.findIndex(patch => isColorPatch(patch) && patch.enabled);
                if (index >= 0) {
                    this.patches.setEnabled(index, false);
                }
            },
            useBuild: keepMoment => this.useColorEditBuild(keepMoment),
            exportFile: async (name, data) => {
                await this.storage.export(name, data);
                this.notifications.info(nls.localize('vueport/general/savedAs', 'Saved as {0}.', name));
            },
            // the colorizations' BPS files (a package whose runtime is its BPS reads it from there)
            loadShipped: loadShippedPatch,
            colorPackagesUrl: VUEPORT_COLOR_PACKAGES_URL ? new URL(VUEPORT_COLOR_PACKAGES_URL, location.href).href : undefined,
            colorWorkerUrl: new URL(VUEPORT_COLOR_WORKER_URL, location.href).href,
            // a model package's pick logs a frame's lines in a fork (the probe's worker)
            probeWorkerUrl: new URL(VUEPORT_PROBE_WORKER_URL, location.href).href,
            wasmUrl: new URL(VUEPORT_WASM_URL, location.href).href,
        });
        this.toDispose.push(this.colorEditor.onDidChange(() => this.update()));
        this.dock = new VueportDock(
            this.instanceId,
            {
                // for the CPU Profiler panel's own button, the one place it is started from
                isProfiling: () => this.profiling,
                toggleProfiling: () => this.runCommand(EmulatorCommands.PROFILE_START.id),
                // the build's line table and source files for the Disassembly panel's source view; like the symbols
                // they come from the .elf beside the ROM, so a bare file has neither
                lineTable: () => this.romLineTable(),
                readSource: path => this.readSourceFile(path),
                // for the Disassembly panel's buttons, through the pause action, so title bar, status bar and
                // debugger share one idea of whether the game runs
                isPaused: () => this.state.paused,
                setPaused: (paused: boolean) => {
                    if (paused !== this.state.paused) {
                        this.runAction(EmulatorAction.PauseToggle);
                    }
                },
                // how the panels' own controls were left (atlas width, terminal following); kept beside the settings
                // rather than the layout, so they survive a panel reopen or a layout reset
                readPanelPreferences: () => this.settings.get('debugPanelState'),
                writePanelPreferences: state => {
                    this.settings.set('debugPanelState', state)
                        .catch(() => undefined);
                },
                // a file a panel produced (a PNG of the character sheet, a BGMap, a world or a figure), named like a
                // screenshot
                exportFile: async (name, data) => {
                    const filename = `${this.exportStem()}-${name}`;
                    await this.storage.export(filename, data);
                    this.notifications.info(nls.localize(
                        'vueport/general/savedAs', 'Saved as {0}.', filename));
                },
            },
            // a real pack where the host can open its serial port (the desktop shell, or Chromium), the decoding half
            // elsewhere; main.tsx picks
            this.rumblePack,
            this.esSound,
            () => this.romSymbols(),
            this.colorEditor,
        );
        this.dock.setVbcSupportEnabled(this.vbcSupportEnabled, this.vbcHardwareActive);
        this.input = new EmulatorInputController(this, this.bindings);
        // the store decides which buttons a macro holds and when, the controller holds them and sees the player's own
        // presses; introduced here, as neither depends on the other's module
        this.macros.setInput(this.input);
        this.input.setMacroHook(this.macros);
        this.time = new EmulatorTimeControl(this);
        this.rewindBrowser = new EmulatorRewindBrowser(this, this.time);
        this.toDispose.push(this.rewindBrowser);
        // it takes the control strip's place, and while it is up the pad steers it rather than the game
        let releaseRewindPad: (() => void) | undefined;
        this.toDispose.push(this.rewindBrowser.onDidChange(() => {
            const open = this.rewindBrowser.isOpen;
            if (open === (releaseRewindPad !== undefined)) {
                return;
            }
            releaseRewindPad?.();
            releaseRewindPad = open ? steerWindowWithGamepad(command => this.rewindBrowser.steer(command)) : undefined;
            this.update();
        }));
        // a game's rumble for a player without a Rumble Pack, on the pads driving this machine, so a linked game
        // doesn't buzz the other player's hands
        this.toDispose.push(new GamepadRumble(
            this.rumblePack,
            () => connectedGamepadList()
                .filter(pad => this.gamepadResolver.drivesPlayer(pad, this.gamepadPlayer())),
            () => this.settings.get('gamepadRumbleIntensity') / 100,
            // the phone's own motor while it is played by touch, see deviceMotor
            () => this.settings.get('touchControlsRumble'),
        ).start());

        this.toDispose.push(this.settings.onDidChange(key => {
            const change = this.onSettingChanged(key);
            if (key === 'hardwareMode' || key === 'vbcSupportEnabled') {
                this.hardwareConfigurationChange = change;
            }
        }));
        // a neutral Ambient halo comes from a theme token, and canvas colors are resolved when painted, so a theme
        // switch has to paint again
        this.toDispose.push(onDidChangeTheme(() => this.applyDecoration()));
        // the memory search follows the inspectors to the other player's machine, as its addresses were narrowed
        // against the machine it left
        this.toDispose.push(this.dock.onDidChange(() => this.followInspectedSim()));
        // switching a cheat on changes the badge over the picture, and only the store knows it happened
        this.toDispose.push(this.cheats.onDidChange(() => this.update()));
        this.toDispose.push(this.xr);
        // the VR window follows the share as it changes (listed or not, a new moment)
        if (this.lanSharing) {
            this.toDispose.push(this.lanSharing.onDidChange(() => this.update()));
            this.toDispose.push(this.lanSharing);
        }
        // likewise for a macro starting or stopping
        this.toDispose.push(this.macros.onDidChange(() => this.update()));
        this.toDispose.push(this.patches.onDidChange(change => {
            if (change.affectsRom) {
                // before the restart: it reads the header to pick the hardware model
                this.refreshRomHeader();
            }
            this.update();
            if (change.affectsRom && !this.suppressPatchRestart) {
                this.restartForPatchChange();
            }
        }));
        this.toDispose.push(this.retroAchievements.onUnlocked(unlock =>
            this.ui.achievement(
                unlock.title,
                unlock.description,
                unlock.points,
                unlock.badgeUrl,
                () => this.showAchievements(),
            )));
        // leaderboard attempts as plain toasts: a status, not a reward, and the readout over the picture is what the
        // player watches. submitted says nothing, the scoreboard reports the result
        this.toDispose.push(this.retroAchievements.onLeaderboardAttempt(attempt => {
            if (attempt.state === 'started') {
                this.ui.toast('info', nls.localize(
                    'vueport/achievements/leaderboards/attemptStarted', 'Leaderboard attempt started: {0}', attempt.title));
            } else if (attempt.state === 'failed') {
                this.ui.toast('info', nls.localize(
                    'vueport/achievements/leaderboards/attemptFailed', 'Leaderboard attempt failed: {0}', attempt.title));
            }
        }));
        this.toDispose.push(this.retroAchievements.onScoreboard(scoreboard => this.ui.toast(
            'info',
            nls.localize(
                'vueport/achievements/leaderboards/submitted',
                'Submitted {0} — rank {1} of {2}',
                scoreboard.submittedScore,
                String(scoreboard.rank),
                String(scoreboard.total),
            ))));
        // how the achievements panel and the command palette turn hardcore on and off; the service owns the prompt and
        // the engine flag, this is the discipline it imposes on the rest of the emulator
        this.retroAchievements.setHardcoreControls({
            isEnabled: () => this.settings.get('retroAchievementsHardcore'),
            persist: enabled => this.settings.set('retroAchievementsHardcore', enabled),
            enter: () => this.enterHardcoreDiscipline(),
        });
        this.toDispose.push(this.dock.onDidChangeLayout(() => {
            this.persistDockLayout();
            // which tab is in front decides whether the badge over the picture has anything to say
            this.update();
        }));
        // the "+" on a tab group, and a double-click on a tab bar's empty space
        this.toDispose.push(this.dock.onDidRequestAddPanel(tabBar => {
            this.pickPanel(tabBar).catch(error => this.onError(String(error)));
        }));
        this.toDispose.push(this.dock.onDidRequestResetLayout(() => {
            this.confirmResetLayout().catch(error => this.onError(String(error)));
        }));
        this.applyDockLayout();
        // a window left in Color mode comes back in it, editor and all
        if (this.state.mode === EmulatorMode.COLOR) {
            this.colorEditor.activate().catch(() => undefined);
        }
        this.applyDecoration();
        // give the panel the configured geometry, so the Display preview has the right shape (and split/interlaced
        // layout) before a ROM sets it
        this.dock.screen.setDisplayMode(this.getDisplayMode());
        // the Display pane's preview borrows this picture and, with no game, shows the still recolored through the
        // palette; handed over now so it is ready the first time the pane opens
        this.dock.screen.setPlaceholder(PLACEHOLDER_SCREENSHOT).catch(() => undefined);
        this.dock.screen.setStereoDepth(this.settings.get('stereoDepth'));
    }

    // state

    // kept apart per instance so player 2 never clobbers player 1: sessionStorage for the toolbar's state (see
    // PersistedState), localStorage for the debug layout, which outlives the session
    protected get stateKey(): string {
        return this.instanceId === 'web' ? STATE_KEY : `${STATE_KEY}.${this.instanceId}`;
    }
    protected get dockLayoutKey(): string {
        return this.instanceId === 'web' ? DOCK_LAYOUT_KEY : `${DOCK_LAYOUT_KEY}.${this.instanceId}`;
    }

    protected loadPersisted(): PersistedState {
        const fallback: PersistedState = { muted: false, mode: EmulatorMode.PLAY };
        if (!this.persistState) {
            return fallback;
        }
        try {
            const stored = JSON.parse(window.sessionStorage.getItem(this.stateKey) ?? '{}') as Partial<PersistedState>;
            return {
                muted: typeof stored.muted === 'boolean' ? stored.muted : fallback.muted,
                mode: stored.mode === EmulatorMode.DEBUG || stored.mode === EmulatorMode.COLOR ? stored.mode : fallback.mode,
            };
        } catch {
            return fallback;
        }
    }

    protected persist(): void {
        if (!this.persistState) {
            return;
        }
        try {
            window.sessionStorage.setItem(this.stateKey, JSON.stringify({
                muted: this.state.muted,
                mode: this.state.mode,
            }));
        } catch {
            // nothing worth interrupting the user over
        }
    }

    // useSyncExternalStore compares snapshots by identity, and the state is mutated in place (as in the studio's
    // widget), so a counter is the snapshot
    version = 0;

    get hasRom(): boolean {
        return this.rom !== undefined;
    }

    // global VBC gate; off means software sees an original Virtual Boy only
    get vbcSupportEnabled(): boolean {
        return this.settings.get('vbcSupportEnabled') !== false;
    }

    // the configured console model before Auto is resolved against the ROM
    get selectedHardwareMode(): VbHardwareMode {
        const value = this.settings.get('hardwareMode');
        if (value === VbHardwareMode.VIRTUAL_BOY || value === VbHardwareMode.VB_COLOR) {
            return value;
        }
        return VbHardwareMode.AUTO;
    }

    /**
     * Re-reads the header from the patched image the machine runs, as it decides what Auto emulates and what ROM Info
     * shows. A VB Color colorization sets the VBC support byte at header + 0x14 to Enhanced, which is how a colorized
     * game asks for VB Color hardware; read from the unpatched bytes, Auto would boot it as an original VB.
     * Deliberately not extended to romId or romMd5, which identify the cartridge for the cheat database and
     * RetroAchievements (see romMd5, and why hardcore refuses ROM patches).
     */
    protected refreshRomHeader(): void {
        const rom = this.rom;
        if (!rom) {
            this.romHeader = EMPTY_ROM_HEADER;
            return;
        }
        let image = rom.data;
        try {
            image = this.patches.apply(rom.data);
        } catch {
            // a chain that will not apply is the patch store's to report; the unpatched header beats none
        }
        this.romHeader = parseRomHeader(image);
        this.dock.setRomInfo(this.romHeader, this.romSize, this.romBuildMode, this.romId);
    }

    // what Auto asks the core to emulate for the loaded ROM
    get resolvedHardwareMode(): VbHardwareMode.VIRTUAL_BOY | VbHardwareMode.VB_COLOR {
        if (!this.vbcSupportEnabled) {
            return VbHardwareMode.VIRTUAL_BOY;
        }
        return resolveVbHardwareMode(this.selectedHardwareMode, this.romHeader.vbcSupport);
    }

    // what the running core actually exposes; before start, what it will be asked for
    get vbcHardwareActive(): boolean {
        return this.sim?.isVbcHardware
            ?? this.resolvedHardwareMode === VbHardwareMode.VB_COLOR;
    }

    // short status-bar value: both the physical model and whether Auto chose it
    get hardwareModeStatusLabel(): string {
        if (!this.vbcSupportEnabled) {
            return nls.localize('vueport/vbColor/hardware/virtualBoy', 'Virtual Boy');
        }
        const model = this.vbcHardwareActive
            ? nls.localize('vueport/vbColor/hardware/vbColor', 'VB Color')
            : nls.localize('vueport/vbColor/hardware/virtualBoy', 'Virtual Boy');
        return this.selectedHardwareMode === VbHardwareMode.AUTO
            ? nls.localize('vueport/vbColor/hardware/autoStatus', 'Auto ({0})', model)
            : model;
    }

    // describes the ROM when VBC hardware is active; a forced VBC mode on a legacy/unknown header gets the neutral
    // "VB Color" badge instead of pretending the ROM advertised enhanced/only support
    get vbcHeaderPillLabel(): string | undefined {
        if (!this.hasRom || !this.vbcHardwareActive) {
            return undefined;
        }
        if (this.romHeader.vbcSupport === VbColorSupport.ENHANCED) {
            return nls.localize('vueport/vbColor/support/enhanced', 'VB Color Enhanced');
        }
        if (this.romHeader.vbcSupport === VbColorSupport.ONLY) {
            return nls.localize('vueport/vbColor/support/only', 'VB Color Only');
        }
        return nls.localize('vueport/vbColor/hardware/vbColor', 'VB Color');
    }

    // toggle the global VB Color gate without forgetting the selected hardware mode
    async toggleVbcSupport(): Promise<void> {
        await this.settings.set('vbcSupportEnabled', !this.vbcSupportEnabled);
    }

    // the gate is a power-on choice, so yes restarts the game, hence the question; returns whether the gate is on
    // afterwards. reason is the caller's, as "why is this asking me?" differs each time
    protected async offerVbcSupport(reason: string): Promise<boolean> {
        if (this.vbcSupportEnabled) {
            return true;
        }
        const agreed = await this.ui.confirm({
            title: nls.localize(
                'vueport/vbColor/hardware/enableVbcTitle', 'Enable VB Color Support?'),
            message: reason,
            okLabel: nls.localize('vueport/vbColor/hardware/enableVbc', 'Enable'),
        });
        if (!agreed) {
            return false;
        }
        await this.settings.set('vbcSupportEnabled', true);
        // the setting's own listener rebuilds the machine around the new hardware; wait for it
        await this.hardwareConfigurationChange;
        return this.vbcSupportEnabled;
    }

    async pickHardwareMode(): Promise<void> {
        if (!await this.offerVbcSupport(nls.localize(
            'vueport/vbColor/hardware/enableVbcMessage',
            'VB Color Support must be enabled to select a hardware mode. Enable it now?',
        ))) {
            return;
        }
        const labels = emulatorHardwareModeLabels();
        const picked = await this.ui.pick(
            nls.localize('vueport/vbColor/hardware/pick', 'Select hardware mode…'),
            [
                {
                    id: VbHardwareMode.AUTO,
                    label: labels[VbHardwareMode.AUTO],
                },
                {
                    id: VbHardwareMode.VIRTUAL_BOY,
                    label: labels[VbHardwareMode.VIRTUAL_BOY],
                },
                {
                    id: VbHardwareMode.VB_COLOR,
                    label: labels[VbHardwareMode.VB_COLOR],
                },
            ] satisfies PickItem[],
            nls.localize('vueport/vbColor/hardware/noMatch', 'No matching hardware mode'),
        );
        if (picked && picked.id !== this.selectedHardwareMode) {
            await this.settings.set('hardwareMode', picked.id as VbHardwareMode);
        }
    }

    // see TitleBarHost.xrActive
    get xrActive(): boolean {
        return this.xr.active;
    }

    toggleXr(): Promise<void> {
        return this.xr.toggle();
    }

    // see TitleBarHost.leaveXr
    leaveXr(): void {
        this.xr.end().catch(() => undefined);
    }

    // the Planet VB title where known, else the file's name; names a LAN share
    protected romTitle(): string {
        return cachedRom(this.romId)?.game?.romTitle
            || this.fileName
            || nls.localize('vueport/titleBar/tagline', 'Virtual Boy on Stereoids');
    }

    // what the browser said about headsets, undefined until it has
    get xrAvailability(): XrAvailability | undefined {
        return this.xr.availability;
    }

    // see TitleBarHost.openNetworkShares
    get networkSharesOpen(): boolean {
        return this.showNetworkShares;
    }

    get lanShareActive(): boolean {
        return this.lanSharing?.status !== undefined;
    }

    // whether the share is of the game running now, which a new moment can be taken of; see NetworkSharesHost
    get lanShareRunning(): boolean {
        return this.lanSharedRomId !== undefined && this.lanSharedRomId === this.romId && this.state.loaded;
    }

    openNetworkShares(): void {
        this.toggleNetworkShares();
    }

    // force sets it outright. Exclusive with the settings dialog and the game-info window, all three being modal
    toggleNetworkShares(force?: boolean): void {
        this.showNetworkShares = force ?? !this.showNetworkShares;
        if (this.showNetworkShares) {
            this.closeOtherWindows('shares');
        }
        this.update();
    }

    // a game opened here, or one shared from another computer, enters the headset while the click still counts. Not on
    // a phone (compact-layout.ts), where VR means a phone holder and the game is meant for its screen
    protected get entersHeadsetOnPlay(): boolean {
        return this.player === 1 && !this.xr.active && this.xr.supported && compactLayout() === undefined
            && userActivationIsActive();
    }

    // a game from the library, sent as it is on disk without starting it: the ROM alone, so the other device plays
    // it from the start. It stays shared whatever runs here meanwhile, until stopped. The window comes up with the
    // code to scan
    async shareFromLibrary(name: string, data: Uint8Array, title: string): Promise<void> {
        if (!this.lanSharing) {
            return;
        }
        try {
            const romId = formatRomId(crc32(data));
            await this.lanSharing.start({ name, data, title, romId }, () => Promise.resolve(undefined));
            this.lanSharedRomId = romId;
            this.lanSharedFromLibrary = true;
            this.toggleNetworkShares(true);
        } catch (error) {
            this.notifications.error(nls.localize('vueport/vr/share/failed', 'The game could not be shared: {0}',
                error instanceof Error ? error.message : String(error)));
        }
    }

    // shares the game as it runs (patches applied, so a state of it fits) and, unless a linked pair is running, the
    // moment it is shared, to continue from in the headset
    async shareInLan(): Promise<void> {
        const rom = this.rom;
        if (!this.lanSharing || !rom || !this.state.loaded) {
            return;
        }
        try {
            const data = this.patches.active > 0 ? this.patches.apply(rom.data) : rom.data;
            const sounds = await this.lanShareSounds();
            // packed again as a .vbz where it came packed or has ESSound tracks, so the headset knows it by the
            // archive's name too; a ROM from a plain .zip goes bare, as it is named here (shownFileName)
            const vbz = rom.archive !== undefined && rom.archive.toLowerCase().endsWith('.vbz') ? rom.archive : undefined;
            const packed = vbz !== undefined || sounds.length > 0;
            await this.lanSharing.start({
                name: packed ? vbz ?? `${this.storage.stem(rom.name)}.vbz` : rom.name,
                data: packed ? storeZip([{ name: rom.name, data }, ...sounds]) : data,
                title: this.romTitle(),
                romId: formatRomId(crc32(data)),
            }, device => this.lanShareMoment(device));
            this.lanSharedRomId = this.romId;
            this.lanSharedFromLibrary = false;
        } catch (error) {
            this.notifications.error(nls.localize('vueport/vr/share/failed', 'The game could not be shared: {0}',
                error instanceof Error ? error.message : String(error)));
        }
    }

    // the tracks the player found for this game and their titles, from wherever they are (unpacked from a .vbz into
    // storage, or the ROM's own folder on the desktop)
    protected async lanShareSounds(): Promise<RomSound[]> {
        const directory = this.esSoundDirectory();
        if (!this.esSound.hasTracks || directory === undefined) {
            return [];
        }
        const sounds: RomSound[] = [];
        for (const file of await this.storage.list(directory)) {
            if (isEsSoundFile(file.name)) {
                sounds.push({ name: file.name, data: await this.storage.read(file.path) });
            }
        }
        return sounds;
    }

    // "Continue" in the headset then starts from now
    async retakeLanShare(): Promise<void> {
        if (!this.lanSharing?.status || !this.lanShareRunning) {
            return;
        }
        try {
            await this.lanSharing.retake(await this.lanShareMoment(this.lanSharing.status.info.device));
        } catch (error) {
            this.notifications.error(nls.localize('vueport/vr/share/failed', 'The game could not be shared: {0}',
                error instanceof Error ? error.message : String(error)));
        }
    }

    async stopLanShare(): Promise<void> {
        this.lanSharedRomId = undefined;
        this.lanSharedFromLibrary = false;
        await this.lanSharing?.stop();
    }

    // a save state file of right now and its picture, as a manual state would be made, labelled with the computer
    // it came from. Nothing for a linked pair, whose state needs two machines, which a headset does not have
    protected async lanShareMoment(device: string): Promise<LanShareMoment | undefined> {
        const identity = this.saveStateIdentity();
        if (!this.sim || !this.state.loaded || this.isLinked() || !identity) {
            return undefined;
        }
        return takeLanShareMoment(this.sim, identity, this.esSound.snapshot(), device, this.rom?.name);
    }

    // a game another computer shares in this network, from its start or from the moment it was shared. Into the
    // headset first, while the click still counts: the dialog has already reached the share, so no prompt for the
    // local network can come up inside the headset where nobody could answer it
    async playLanShare(reached: ReachedLanShare, resume: boolean): Promise<void> {
        this.toggleNetworkShares(false);
        if (this.entersHeadsetOnPlay) {
            this.xr.enter().catch(() => undefined);
        }
        // shown in the headset too, on the screen the game will take, as a large .vbz takes a while
        const { title, device } = reached.share;
        const progress = this.ui.progress(nls.localize('vueport/vr/shared/downloading', 'Fetching {0} from {1}…',
            title, device));
        let shown = -1;
        try {
            const files = await downloadLanShare(reached, resume, this.lanSharing?.shell, undefined, (received, total) => {
                const percent = Math.floor(received * 100 / total);
                if (percent !== shown) {
                    shown = percent;
                    progress.setText(nls.localize('vueport/vr/shared/downloadingPercent', 'Fetching {0} from {1}… {2} %',
                        title, device, percent));
                }
            });
            // unpacking and writing the tracks of a large .vbz is a wait of its own
            progress.setText(nls.localize('vueport/vr/shared/starting', 'Starting {0}…', title));
            // a game with ESSound tracks comes as a .vbz of exactly one ROM, so there is nothing to choose
            const rom = await romFrom(files.name, files.rom, names => Promise.resolve(names[0]));
            const archive = looksLikeZip(files.rom) ? files.name : undefined;
            await this.openRom(rom.name, rom.data, rom.sounds, undefined, { url: lanShareRomUrl(reached), archive },
                files.state ? { state: files.state } : { fresh: true });
            if (resume && !files.state) {
                this.notifications.warn(nls.localize('vueport/vr/shared/noState',
                    'The moment {0} was shared at could not be fetched, so it starts from the beginning.', title));
            }
        } catch (error) {
            this.notifications.error(nls.localize('vueport/vr/shared/fetchFailed', '{0} could not be fetched: {1}',
                reached.share.title, error instanceof Error ? error.message : String(error)));
        } finally {
            progress.cancel();
        }
    }

    get romName(): string | undefined {
        return this.rom?.name;
    }

    // the archive the ROM came out of (`Super Metroid.vbz`), or nothing for a bare ROM
    get archiveName(): string | undefined {
        return this.rom?.archive;
    }

    // what the game is called where a file name is shown (title bar, window, a LAN share): a .vbz by its own name, a
    // ROM from any other archive by its own, see shownFileName
    get fileName(): string | undefined {
        return this.rom && shownFileName(this.rom.archive, this.rom.name);
    }

    // the game as the title bar names it: Planet VB's title for this dump once it has been looked up, else the file
    // name without its extension. For the phone's menu, see EmulatorQuickMenu
    get gameTitle(): string | undefined {
        const name = this.fileName;
        return cachedRom(this.romChecksum)?.game?.romTitle || name?.replace(/\.(vb\.zip|vbz|vb|zip)$/i, '');
    }

    // see EmulatorHost.setTouchKeys
    setTouchKeys(keys: number): void {
        this.input.setTouchKeys(keys);
    }

    get touchLayoutEditing(): boolean {
        return this.editingTouchLayout;
    }

    // from the Input pane's Touch page: the editor needs the game's screen, so the settings go while it is up and come
    // back on that page once it closes. Without a game there is no screen to edit over, see EmulatorHost
    editTouchLayout(): void {
        if (!this.hasRom) {
            this.notifications.info(nls.localize('vueport/touch/editor/needsGame',
                'Start a game to edit the on-screen controller over it.'));
            return;
        }
        this.editingTouchLayout = true;
        this.closeSettings();
    }

    finishTouchLayoutEditing(layout?: TouchControlsLayout): void {
        this.editingTouchLayout = false;
        if (layout) {
            this.settings.set('touchControlsLayout', layout).catch(() => undefined);
        }
        this.settingsOnList = false;
        this.openSettingsTab('input', 'touch');
    }

    // a ROM read from a file on disk named otherwise was unpacked from it (the desktop knows the path, see
    // EmulatorCompanionFiles.unpacked)
    protected archiveAt(location: string | undefined, name: string): string | undefined {
        const file = location !== undefined ? this.storage.name(location) : undefined;
        return file !== undefined && file !== name ? file : undefined;
    }

    // size of the file on disk, in bytes
    get romBytes(): number {
        return this.rom?.data.byteLength ?? 0;
    }

    // CRC32 of the whole file, as the cheat database keys on it
    get romChecksum(): string | undefined {
        return this.romId;
    }

    get romStoragePath(): string | undefined {
        return this.rom ? this.romDirectory() : undefined;
    }

    // for the link controller to hand player 2
    currentRom(): { name: string, data: Uint8Array } | undefined {
        return this.rom ? { name: this.rom.name, data: this.rom.data } : undefined;
    }

    protected update(): void {
        if (!this.isDisposed) {
            // in a headset a side strip is always up, a game or not (without one it says it needs one)
            if (this.headsetPanels && this.sideStrip === undefined) {
                this.showSideStrip(this.headsetStrip());
                return;
            }
            // a macro measures time in running seconds, so its clock is told when the machine stops and starts; here,
            // as every pause, resume, load and stop ends up calling this
            this.macros.setRunning(this.state.loaded && !this.state.paused);
            // the library's play clock likewise; player 1 only, as the second window runs player 1's ROM for a link
            // session and would count the same afternoon twice
            if (this.player === 1) {
                this.playTimes.setRunning(this.state.loaded && !this.state.paused);
            }
            // a video recording likewise: a paused machine presents nothing with its audio suspended, so a running
            // recorder would write a silent still
            this.videoRecorder?.setPaused(!this.state.loaded || this.state.paused);
            this.version++;
            this.onDidChangeEmitter.fire();
        }
    }

    // EmulatorTimeControlHost

    // see EmulatorTimeControlHost.romLoaded for why it is not loaded
    get romLoaded(): boolean {
        return this.state.loaded;
    }

    get paused(): boolean {
        return this.state.paused;
    }

    get fastForward(): boolean {
        return this.state.fastForward;
    }

    get slowMotion(): boolean {
        return this.state.slowmotion;
    }

    get lowPower(): boolean {
        return this.state.lowPower;
    }

    get rewinding(): boolean {
        return this.time.rewinding;
    }

    timeSettings(): EmulatorTimeSettings {
        return {
            fastForwardRatio: this.settings.get('fastForwardRatio'),
            slowMotionRatio: this.settings.get('slowMotionRatio'),
            // hardcore forbids rewind, and so does a link session: going back in one window would leave the two
            // copies of each machine at different moments
            rewindEnabled: this.settings.get('rewindEnabled') && !this.isHardcore() && !this.isLinked(),
            rewindGranularity: this.settings.get('rewindGranularity'),
            rewindBufferBytes: this.settings.get('rewindBufferSize') * 1024 * 1024,
        };
    }

    onDidChange(): void {
        this.update();
    }

    onError(message: string): void {
        console.error('[vueport]', message);
        this.notifications.error(message);
        this.state.loaded = false;
        this.update();
    }

    // the machine sits there like a real one that jumped somewhere it cannot return from, but the ROM is loaded and
    // everything else works, so this shows as an announced pause rather than a failure; reset starts it again
    protected onStalled(): void {
        this.state.paused = true;
        this.esSound.setPaused(true);
        this.notifications.warn(nls.localize(
            'vueport/state/stalled',
            'The machine stopped responding and emulation was paused. Reset to start it again.'));
        this.update();
    }

    // EmulatorInputHost

    isAcceptingInput(): boolean {
        return this.state.loaded
            // the settings dialog and the game-info window are modal: while one is up, keys are for it
            && this.activeSettingsTab === undefined
            && !this.showRomInfo
            && !this.showNetworkShares
            // a user typing into a filter box isn't playing; the dialog stops the keystroke only through React, whose
            // listeners run after this one has read the key
            && !this.ui.isPicking
            // the filmstrip hears its keys itself, and the pad through steerRewindBrowser
            && !this.rewindBrowser.isOpen;
    }

    // player 2 reads its own key table, unless "Player 2 uses Player 1 controls" is on (the default): then both read
    // player 1's and focus decides which one a keystroke reaches
    usesPlayer2Controls(): boolean {
        return this.player === 2 && !this.settings.get('player2SameControls');
    }

    // solo undefined, as every pad is a pair of hands; linked, its own player number so one pad drives each side
    gamepadPlayer(): number | undefined {
        return this.isLinked() ? this.player : undefined;
    }

    // built once and told to re-resolve on settings changes rather than rebuilt: it caches a resolved profile per
    // device, and the input loop asks 60 times a second
    gamepadProfiles(): GamepadProfileResolver {
        return this.gamepadResolver;
    }

    protected readonly gamepadResolver = new StoredGamepadProfiles(
        () => this.settings.get('gamepadProfiles'),
        () => this.settings.get('gamepadPlayers'),
    );

    // EmulatorHost

    isLinked(): boolean {
        return this.link?.linked === true;
    }

    // the dock is asked rather than a flag kept, as the dock moves the inspectors back to this window's machine when
    // the session ends
    isInspectingPeer(): boolean {
        return this.dock.inspecting === 'peer';
    }

    canInspectPeer(): boolean {
        return this.dock.hasPeerSim;
    }

    // the link controller's own word: it depends on whether a session is running and whether a window remains at
    // the other end, neither of which this object knows (see EmulatorToolbarHost#linkStatus)
    linkStatus(): 'idle' | 'relinkable' | 'waiting' | 'linked' {
        return this.link?.status ?? 'idle';
    }

    // a second player can be invited from the library before there is a game; their window waits for this one to
    // start one (see invite in web-link.ts)
    readonly linksWithoutRom = true;

    // only while a link session runs: a press has to land on the same frame in both windows, so the session books
    // it; otherwise the mask goes straight into the machine
    get sendKeys(): ((keys: number) => void) | undefined {
        const link = this.link;
        return link?.linked ? keys => link.sendKeys(keys) : undefined;
    }

    // where the input controller's turbo buttons go, as with sendKeys
    get sendTurbo(): ((keys: number, rate: number) => void) | undefined {
        const link = this.link;
        return link?.linked ? (keys, rate) => link.sendTurbo(keys, rate) : undefined;
    }

    get turboRate(): number {
        return clampTurboRate(this.settings.get('turboRate'));
    }

    // refused in hardcore (RetroAchievements allows turbo but not scripted input) and with no game running
    playMacroSlot(slot: number): void {
        if (!this.state.loaded || this.refuseForHardcore()) {
            return;
        }
        this.macros.playSlot(slot);
    }

    setLink(link: LinkFacade): void {
        this.link = link;
    }

    // a copy, because the worker takes ownership of what it is handed
    romData(): ArrayBuffer | undefined {
        return this.rom?.data.slice().buffer;
    }

    // what the desktop's Probe mode works with, or nothing while no game runs (desktop-probe.ts decides what a tool
    // may do). Looked up when asked, as a patch switch or hardware change builds the session again
    probeTarget(): ProbeTarget | undefined {
        const sim = this.sim;
        const rom = this.rom;
        if (!sim || !rom || !this.state.loaded) {
            return undefined;
        }
        return {
            name: rom.name,
            sim,
            romAsRun: () => this.patches.apply(rom.data),
            elf: () => this.readElfBeside(),
            esSoundSnapshot: () => this.esSound.snapshot(),
            esSound: this.esSound.hasTracks,
            hardcore: this.isHardcore(),
            linked: this.isLinked(),
            paused: this.state.paused,
            setPaused: async paused => {
                if (this.state.paused !== paused) {
                    await this.performAction(EmulatorAction.PauseToggle);
                }
            },
        };
    }

    // what a link session sets every machine up from (see LinkCartridge); the image only when a patch is on, as
    // otherwise both windows have the same file and 16 MB need not cross
    linkCartridge(): LinkCartridge | undefined {
        if (!this.rom || !this.sim) {
            return undefined;
        }
        return {
            image: this.patches.active > 0
                ? this.patches.apply(this.rom.data).slice().buffer as ArrayBuffer
                : undefined,
            vbc: this.sim.isVbcHardware,
            esSound: this.esSound.hasTracks,
        };
    }

    // writes a link session's account of what went wrong beside the game's other companion files; see LinkReport
    async saveLinkReport(report: LinkReport): Promise<string | undefined> {
        if (!this.rom) {
            return undefined;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const name = `${this.storage.stem(this.rom.name)}.link-p${report.seat}-${report.reason}-${stamp}.json`;
        const path = this.storage.join(this.romDirectory(), name);
        await this.storage.write(path, new TextEncoder().encode(JSON.stringify(report)));
        return path;
    }

    // undefined until the game is running, not just until the pieces exist: a session started part-way through start()
    // has its booked input wiped by the reset at the end
    linkContext(): { session: EmulatorSession, romId: string } | undefined {
        return this.state.loaded && this.session && this.romId
            ? { session: this.session, romId: this.romId }
            : undefined;
    }

    notifyChanged(): void {
        this.applyLinkToTools();
        this.update();
    }

    /**
     * Points the cheats, the search and the debugger at the session, or back at this window alone. A cheat, a Cheat
     * Finder poke or a VIP panel edit is a change the program didn't make, so made in one window only, the two windows
     * diverge from that frame and the digest check ends the session without saying why. While linked, the tools hand
     * their writes to the session, which books them against a frame both windows can still reach; see scheduleEdits in
     * link-session.ts.
     */
    protected applyLinkToTools(): void {
        const link = this.link;
        const linked = this.isLinked();
        // always, not only on the change: the mirror is built a moment after the session says it is connected, and
        // taken away before it says it is not
        this.dock.setPeerSim(linked ? link?.peerSim : undefined);
        this.followInspectedSim();
        if (linked === this.toolsLinked) {
            return;
        }
        this.toolsLinked = linked;
        // every machine in both windows runs the image player 1 started the session with, so nothing may change it
        // until the session ends (see LinkCartridge); player 1 settles the patches before inviting
        this.patches.setLocked(linked ? this.linkedPatchesMessage() : undefined);
        if (linked && this.state.showPatches) {
            this.showSideStrip(this.headsetPanels ? 'cheats' : undefined, true);
        }
        // the held mask goes another way from here on, and only goes anywhere when it changes; sent again, so a button
        // held across the switch is not lost and both machines start knowing a controller is plugged in
        this.input.invalidate();
        this.input.applyKeys().catch(() => undefined);
        // turbo likewise: the worker drops its turbo keys under lockstep, and the session books them
        this.input.applyTurbo().catch(() => undefined);
        // rewind history is not recorded while linked, see timeSettings
        this.applyRewindSettings().catch(() => undefined);
        this.cheats.setScheduler(linked && link
            // always this window's own seat: a cheat belongs to the player who switched it on, and reaches the other
            // window as a change to their mirror of this machine
            ? codes => link.scheduleEdits('own', [{ kind: 'cheats', codes }])
            : undefined);
        // pokes, unlike cheats, go wherever the debugger is pointed, which is why the inspectors can point at the peer
        this.cheatFinder.setWriter(linked && link
            ? (address, bytes) => link.scheduleEdits(
                this.dock.inspecting, [{ kind: 'memory', address, bytes }])
            : undefined);
        this.dock.setWriteRoute(linked && link
            ? (seat, address, bytes) => link.scheduleEdits(
                seat, [{ kind: 'memory', address, bytes }])
            : undefined);
        this.applyRumbleForwarding();
    }

    // a search's narrowed addresses mean nothing in the other machine, so switching the inspected one starts it over
    protected followInspectedSim(): void {
        const sim = this.dock.sim;
        if (sim === this.searchedSim) {
            return;
        }
        this.searchedSim = sim;
        this.cheatFinder.setSim(sim);
    }

    /**
     * Forwards the link port to the pack, unless the port is a cable. A Rumble Pack plugs into the link port, so on
     * hardware there is no linking two consoles with a pack in the way; with both, the port carries the game's traffic
     * to the other VB, which the pack would read as commands. So while the cable is in, nothing is forwarded or read
     * off the port, the motor is stopped, and the panel and status strip say the cable has it. Called when a game
     * starts or ends and when a session is joined or left.
     */
    protected applyRumbleForwarding(): void {
        if (this.rumblePack === NO_RUMBLE_PACK) {
            return;
        }
        const linked = this.isLinked();
        const forwarding = this.state.loaded && !linked;
        const was = this.rumblePack.forwarding;
        this.rumblePack.forwarding = forwarding;
        this.rumblePack.linkPortInUse = linked;
        if (was && !forwarding) {
            // mid-effect as far as the pack knows: the Stop the game would have sent is what stopped being carried,
            // so a sustained effect would go on buzzing (see VueportRumblePack.stop)
            this.rumblePack.stop?.().catch(() => undefined);
            // once, when the cable takes the port; a player with a pack plugged in is owed the reason
            if (linked && this.rumblePack.connected) {
                this.notifications.info(nls.localize(
                    'vueport/link/rumblePortTaken',
                    'Rumble Pack switched off while linked: a second player needs the link port.'));
            }
        }
        // listening costs a callback on every CPU write, in the mode least able to afford it, as a linked pair runs in
        // lockstep; see setLinkCapture
        this.sim?.setLinkCapture(forwarding).catch(() => undefined);
    }

    isRewindEnabled(): boolean {
        return this.time.isRewindEnabled();
    }

    stopRewinding(): void {
        this.time.stopRewinding();
    }

    // EmulatorRewindBrowserHost

    onNothingToRewind(): void {
        this.notifications.info(nls.localize('vueport/rewind/nothing', 'Nothing has been recorded to rewind to yet.'));
    }

    // a restored moment (a rewind capture, a save state) brings back the buttons held when it was taken, and the input
    // only sends what changes
    async restoreInput(): Promise<void> {
        this.input.invalidate();
        await this.input.applyKeys();
        await this.input.applyTurbo();
    }

    // the worker drops the history whenever these are applied, so a filmstrip showing it closes first
    protected async applyRewindSettings(): Promise<void> {
        this.rewindBrowser.abandon();
        await this.time.applyRewindSettings();
    }

    getRenderingMode(): string {
        return this.settings.get('renderingMode');
    }

    protected getPalette(): VbPalette {
        return resolvePalette(this.settings.get('palette'), this.settings.get('customPalettes'));
    }

    protected getAnaglyphPalette(): VbAnaglyphPalette {
        return resolveAnaglyphPalette(
            this.settings.get('anaglyphPalette'),
            this.settings.get('customAnaglyphPalettes')
        );
    }

    protected getDisplayMode(): DisplayMode {
        return buildDisplayMode(
            this.getRenderingMode(), this.getPalette(), this.getAnaglyphPalette(),
            this.settings.get('swapEyes'), this.settings.get('frameBlending'));
    }

    // undefined means as shown, not "the display mode": the worker then hands back the live drawing buffer instead of
    // composing the frame again, cheaper and certain to match
    protected getScreenshotMode(): DisplayMode | undefined {
        if (this.settings.get('screenshotUseDisplaySettings')) {
            return undefined;
        }
        const mode = this.settings.get('screenshotRenderingMode');
        return buildDisplayMode(
            mode,
            resolvePalette(this.settings.get('screenshotPalette'), this.settings.get('customPalettes')),
            resolveAnaglyphPalette(
                this.settings.get('screenshotAnaglyphPalette'),
                this.settings.get('customAnaglyphPalettes'),
            ),
            false,
            this.settings.get('screenshotFrameBlending'),
        );
    }

    // always a mode, unlike getScreenshotMode: the picture is drawn in the worker, so there is no live buffer to
    // borrow and a recording composes its own frames
    protected getVideoMode(): DisplayMode {
        if (this.settings.get('videoUseDisplaySettings')) {
            return this.getDisplayMode();
        }
        return buildDisplayMode(
            this.settings.get('videoRenderingMode'),
            resolvePalette(this.settings.get('videoPalette'), this.settings.get('customPalettes')),
            resolveAnaglyphPalette(
                this.settings.get('videoAnaglyphPalette'),
                this.settings.get('customAnaglyphPalettes'),
            ),
            false,
            this.settings.get('videoFrameBlending'),
        );
    }

    getPaletteLabel(): string {
        const anaglyph = this.getRenderingMode() === VbRenderingMode.ANAGLYPH;
        const id = anaglyph ? this.settings.get('anaglyphPalette') : this.settings.get('palette');
        if (id.startsWith(CUSTOM_PALETTE_PREFIX)) {
            return id.slice(CUSTOM_PALETTE_PREFIX.length);
        }
        return (anaglyph ? emulationAnaglyphPalettes() : emulationPalettes())[id] ?? id;
    }

    renderPalettePreview(): React.ReactNode {
        const colors = this.getRenderingMode() === VbRenderingMode.ANAGLYPH
            ? [this.getAnaglyphPalette().left, this.getAnaglyphPalette().right]
            : this.getPalette();
        return <span className='vp-swatch'>
            {colors.map((color, i) =>
                <span key={i} style={{ background: formatColor(color) }} />
            )}
        </span>;
    }

    // the studio's four windows (input, palettes, settings, About) are panes of one plain modal here, plus Display, VB
    // Color, Sound and Appearance
    renderOverlay(): React.ReactNode {
        return <>
            {/* no visible fallback: the windows open on a click and their chunks are cached, and WebSettingsDialog catches
            its lazy panes further in. The boundary handles a chunk that never arrives, which would otherwise unmount the
            emulator (see web-chunk.tsx): it says so in a toast, and resetKey gives the next window its own attempt */}
            <ChunkBoundary
                quiet
                resetKey={`${this.showRomInfo}|${this.showNetworkShares}|${this.settingsTab}`}
                onError={(error, chunk) => this.notifications.error(
                    chunk
                        ? nls.localize(
                            'vueport/chunk/windowFailed',
                            'That window could not be loaded. Please reload the page.')
                        : chunkErrorMessage(error))}
            >
                {/* a boundary each, as a window whose chunk is still on its way would otherwise put away whatever
                    is already up, which in a headset is the settings (headsetPanels). Those first, under the rest */}
                <React.Suspense fallback={null}>
                    {this.settingsTab !== undefined
                        ? this.renderSettingsDialog(this.settingsTab)
                        : this.leavingSettingsTab !== undefined && this.renderSettingsDialog(this.leavingSettingsTab, true)}
                </React.Suspense>
                <React.Suspense fallback={null}>
                    {this.showRomInfo && this.hasRom &&
                        <WebRomInfo emulator={this} onClose={() => this.toggleRomInfo(false)} />}
                </React.Suspense>
                <React.Suspense fallback={null}>
                    {this.showNetworkShares &&
                        <NetworkSharesWindow emulator={this} onClose={() => this.toggleNetworkShares(false)} />}
                </React.Suspense>
            </ChunkBoundary>
        </>;
    }

    protected renderSettingsDialog(tab: SettingsTab, leaving?: boolean): React.ReactNode {
        return <WebSettingsDialog
            leaving={leaving}
            tab={tab}
            onTab={next => this.openSettingsTab(next)}
            onClose={() => this.closeSettings()}
            closable={!this.headsetPanels}
            startOnList={this.settingsOnList}
            renderPane={(pane, search) => this.renderSettingsPane(pane, search)}
            resetAll={{ settings: this.settings, confirm: () => this.notifications.confirm(resetAllSettingsConfirmation()) }}
        />;
    }

    protected renderSettingsPane(tab: SettingsTab, search: string): React.ReactNode {
        // what every schema-backed pane gets: the settings, a hover for the controls that want one, and the reasons
        // this build has for settling a setting on the player's behalf
        const pane = {
            settings: this.settings,
            hover: DEFAULT_KIT_SERVICES.hover,
            readOnly: (id: keyof VueportConfig) => this.settings.fixed?.[id],
            search,
        };
        switch (tab) {
            case 'display':
                return <DisplaySettings
                    {...pane}
                    notifications={this.notifications}
                    vbcHardwareActive={this.vbcHardwareActive}
                    preview={<EmulatorScreenPreview
                        screen={this.dock.screen}
                        placeholder={PLACEHOLDER_SCREENSHOT}
                        loaded={this.state.loaded}
                    />}
                />;
            case 'screenshots':
                return <ScreenshotSettings {...pane} notifications={this.notifications} />;
            case 'video':
                return <VideoSettings {...pane} notifications={this.notifications} />;
            case 'input':
                return <InputSettings
                    // remounted by a link to one of its pages, which it reads only on mount, so the link lands even
                    // when the pane is already open on another page
                    key={this.inputPageSerial}
                    initialPage={this.inputPage}
                    settings={this.settings}
                    bindings={this.bindings}
                    notifications={this.notifications}
                    loadGamepadDatabase={loadControllerNames}
                    exportFile={(name, data) => this.storage.export(name, data)}
                    shareProfile={shareGamepadProfile}
                    // Home opens the command palette, see web-gamepad-palette.ts
                    gamepadUiActions={['commandPalette']}
                    onChange={() => this.refreshBindings()}
                    onEditTouchLayout={() => this.editTouchLayout()}
                    search={search}
                />;
            case 'emulation':
                return <EmulationSettings {...pane} />;
            // a tab of its own rather than part of Emulation: a save is changed while playing rather than when
            // setting up
            case 'saveData':
                return <SaveDataSettings {...pane} />;
            // save states beside it rather than inside: a save is the cartridge's memory, a state a photograph of the
            // whole machine, and only the latter has anything to configure
            case 'saveStates':
                return <SaveStateSettings {...pane} />;
            // the folder holds saves, states and cheats alike, so where it is belongs to none of them
            case 'files':
                return <FileSettings {...pane} />;
            case 'vbcolor':
                return <VbColorSettings {...pane} />;
            case 'sound':
                return <SoundSettings {...pane} />;
            case 'about':
                return <WebAbout />;
        }
        return <SettingsSearchFilter search={search}>
            {this.renderHandWrittenSettingsPane(tab)}
        </SettingsSearchFilter>;
    }

    protected renderHandWrittenSettingsPane(
        tab: 'achievements' | 'appearance' | 'library' | 'updates' | 'probe' | 'vr',
    ): React.ReactNode {
        switch (tab) {
            case 'achievements':
                return <WebRetroAchievementsPane
                    settings={this.settings}
                    achievements={this.retroAchievements}
                />;
            case 'appearance':
                return <WebAppearance />;
            case 'library':
                return this.library
                    ? <WebLibrarySettings library={this.library} ui={this.ui} />
                    : null;
            // desktop only; the rail leaves it out in a browser
            case 'updates':
                return <WebUpdates />;
            // desktop only too: whether tools on this computer may connect
            case 'probe':
                return <WebProbe />;
            case 'vr':
                return <XrSettings
                    availability={this.xr.availability}
                    screen={this.xr.screen}
                    backdrop={this.xr.backdrop}
                    onScreen={screen => this.xr.setScreen(screen)}
                    onBackdrop={backdrop => this.xr.setBackdrop(backdrop)}
                />;
        }
    }

    get settingsTab(): SettingsTab | undefined {
        return this.activeSettingsTab;
    }

    // see TitleBarHost
    get settingsOpen(): boolean {
        return this.activeSettingsTab !== undefined;
    }

    // open the dialog on whichever pane it was last on
    openSettings(): void {
        this.openSettingsTab(this.lastSettingsTab);
    }

    // in a headset the settings and a side strip are both always up (settings left of the screen, strip right, see
    // emulator-xr-ui.ts), so nothing closes them there. On the page they share an edge again, so the settings go
    protected headsetPanels = false;
    protected lastSideStrip: SideStrip = 'cheats'; // the one a headset brings back up

    protected setHeadsetPanels(inHeadset: boolean): void {
        if (inHeadset === this.headsetPanels) {
            return;
        }
        this.headsetPanels = inHeadset;
        if (inHeadset) {
            this.showNetworkShares = false;
            this.showRomInfo = false;
            this.activeSettingsTab = this.lastSettingsTab;
            this.applyDecoration();
            this.update();
        } else {
            this.closeSettings();
        }
    }

    // a strip's own close button, which a headset has none of (see headsetPanels)
    protected stripClose(close: () => void): (() => void) | undefined {
        return this.headsetPanels ? undefined : close;
    }

    // the last one shown, unless it is off limits now (hardcore, a link), which would only say so every time
    protected headsetStrip(): SideStrip {
        const last = this.lastSideStrip;
        if (this.isHardcore() && (last === 'cheats' || last === 'macros' || last === 'patches')) {
            return 'achievements';
        }
        return last === 'patches' && this.isLinked() ? 'cheats' : last;
    }

    protected get sideStrip(): SideStrip | undefined {
        const state = this.state;
        return state.showSaveStates ? 'saveStates' : state.showCheats ? 'cheats' : state.showMacros ? 'macros'
            : state.showPatches ? 'patches' : state.showAchievements ? 'achievements' : undefined;
    }

    // exclusive with every strip (cheats, macros, patches, colors, achievements), as they share the same edge of the
    // screen; showSideStrip closes the dialog for the same reason. And with the VR and game-info windows, all being
    // modal. Not in a headset, see headsetPanels
    openSettingsTab(tab: SettingsTab, inputPage?: InputSettingsPage): void {
        // back before it had slid out: the same window again, not a second one beside the leaving one
        this.leavingSettingsTab = undefined;
        clearTimeout(this.leavingTimer);
        // opened on a pane, unless togglePreferencesWindow says otherwise right after; switching panes inside the window
        // keeps the window's own state
        if (this.activeSettingsTab === undefined) {
            this.settingsOnList = false;
        }
        this.showNetworkShares = false;
        this.showRomInfo = false;
        if (!this.headsetPanels) {
            this.state.showSaveStates = false;
            this.state.showCheats = false;
            this.state.showMacros = false;
            this.state.showPatches = false;
            this.state.showAchievements = false;
        }
        this.activeSettingsTab = tab;
        this.lastSettingsTab = tab;
        this.inputPage = inputPage;
        if (inputPage) {
            this.inputPageSerial++;
        }
        // the Display pane's preview shows the decoration at work, so with no game it goes on now and off on the way
        // out
        this.applyDecoration();
        this.update();
    }

    openGamePadSettings(): void {
        this.openSettingsTab('input', 'gamePads');
    }

    closeSettings(): void {
        if (this.headsetPanels || this.activeSettingsTab === undefined) {
            return;
        }
        // on a phone the window slides out to the right before it goes, as it slid in (see SettingsWindow `leaving`)
        if (compactLayout() !== undefined) {
            this.leavingSettingsTab = this.activeSettingsTab;
            clearTimeout(this.leavingTimer);
            this.leavingTimer = setTimeout(() => {
                this.leavingSettingsTab = undefined;
                this.update();
            }, SETTINGS_LEAVE_MS);
        }
        this.activeSettingsTab = undefined;
        this.applyDecoration();
        this.update();
    }

    // standalone only: in the studio a ROM comes from the project being built, and there is no start page
    get leadingControls(): EmulatorToolbarControl[] {
        return [
            {
                id: 'openRom',
                label: nls.localize('vueport/rom/load', 'Load ROM…'),
                icon: <FolderOpen size={18} />,
                run: () => this.requestOpenRom(),
            },
            {
                id: 'closeRom',
                label: nls.localize('vueport/rom/close', 'Close ROM'),
                icon: <FolderMinus size={18} />,
                disabled: !this.hasRom,
                run: () => this.closeRom(),
            },
        ];
    }

    // the counterpart of openRom: tears the session down the same way, then forgets the ROM so hasRom turns false
    // and the placeholder returns. The strips and the game-info window close with it
    async closeRom(): Promise<void> {
        if (!this.rom) {
            return;
        }
        // before the machine goes: the moment "Suspend and Resume" is named for; after stop there is nothing to save.
        // See writeSuspendState
        await this.writeSuspendState(true);
        // the share was of this game, which is going; one from the library is not tied to it
        if (!this.lanSharedFromLibrary) {
            await this.stopLanShare();
        }
        await this.stop();
        // the sitting is over: the next start of this ROM is another play. Not in stop itself, as a patch switch, a
        // save slot change or a hardware setting rebuild the machine without anybody getting up
        if (this.player === 1) {
            this.playTimes.ended();
        }
        this.rom = undefined;
        // whatever was read out of the closed ROM's build describes nothing now
        this.symbols = undefined;
        this.lines = undefined;
        this.status = EmulatorRomStatus.NOT_EXISTS;
        this.romHeader = EMPTY_ROM_HEADER;
        this.romSize = 0;
        this.romId = undefined;
        this.romMd5Value = undefined;
        this.romBuildMode = undefined;
        this.dock.setRomInfo(EMPTY_ROM_HEADER, 0, undefined, undefined);
        this.dock.setVbcSupportEnabled(this.vbcSupportEnabled, this.vbcHardwareActive);
        this.state.showSaveStates = false;
        this.state.showCheats = false;
        this.state.showMacros = false;
        this.state.showPatches = false;
        this.state.showAchievements = false;
        this.patches.unload();
        // the library belonged to the ROM that has just gone; the next one reads its own folder
        this.saveStates.attach(undefined, undefined).catch(() => undefined);
        this.showRomInfo = false;
        document.title = nls.localize('vueport/app/name', 'VUEPort');
        this.update();
    }

    toggleAboutWindow(): void {
        this.toggleSettingsTab('about');
    }

    // the command, the title bar pill and the toast at start all lead here; none exist in a browser (see canUpdate)
    toggleUpdatesWindow(): void {
        this.toggleSettingsTab('updates');
    }

    // force sets it outright; exclusive with the settings dialog and the share window, see toggleNetworkShares
    toggleRomInfo(force?: boolean): void {
        this.showRomInfo = force ?? !this.showRomInfo;
        if (this.showRomInfo) {
            this.closeOtherWindows('romInfo');
        }
        this.update();
    }

    // the modal windows besides the one just opened (openSettingsTab closes the other two itself)
    protected closeOtherWindows(keep: 'romInfo' | 'shares'): void {
        // in a headset the settings stay, under the window, see headsetPanels
        if (!this.headsetPanels) {
            this.activeSettingsTab = undefined;
            this.applyDecoration();
        }
        this.showRomInfo = keep === 'romInfo';
        this.showNetworkShares = keep === 'shares';
    }

    // set by the application that owns it; the studio never sets it, and has no Library tab
    library?: Library;

    get activeCheats(): number {
        return this.cheats.list.filter(cheat => cheat.enabled).length;
    }

    get activePatches(): number {
        return this.patches.activeOutsideColor;
    }

    // shows one of the five strips beside the screen, or none, in Play and Debug mode alike (in Debug mode it takes its
    // width from the dock). Only one at a time as they share the space, and the settings dialog on that edge is put
    // away too
    protected showSideStrip(which: SideStrip | undefined, force = false): void {
        // in a headset the strip stays, see headsetPanels; switching to another is the way to put one away
        if (which === undefined && this.headsetPanels && !force) {
            return;
        }
        // cheats, macros and patches (a colorization included) are off limits in hardcore; asking for one puts the
        // "Hardcore Mode is on" notice up. Achievements stay reachable
        if ((which === 'cheats' || which === 'macros' || which === 'patches')
            && this.refuseForHardcore()) {
            return;
        }
        if (which === 'patches' && this.isLinked()) {
            this.notifications.info(this.linkedPatchesMessage());
            return;
        }
        this.state.showSaveStates = which === 'saveStates';
        this.state.showCheats = which === 'cheats';
        this.state.showMacros = which === 'macros';
        this.state.showPatches = which === 'patches';
        this.state.showAchievements = which === 'achievements';
        if (which !== undefined) {
            this.lastSideStrip = which;
            if (!this.headsetPanels) {
                this.activeSettingsTab = undefined;
            }
        }
        this.applyDecoration();
        this.update();
    }

    // reachable in hardcore, unlike the cheats: making a state is allowed, loading one is not, and the panel says so
    toggleSaveStates(): void {
        this.showSideStrip(this.state.showSaveStates ? undefined : 'saveStates');
    }

    // the cheats' arrangement exactly, see renderCheats
    renderSaveStates(): React.ReactNode {
        return <EmulatorSaveStates
            states={this.saveStates}
            notifications={this.notifications}
            canSave={this.state.loaded}
            hardcore={this.isHardcore()}
            onSave={() => { this.saveState().catch(error => this.onError(String(error))); }}
            onLoad={entry => { this.loadSaveState(entry).catch(error => this.onError(String(error))); }}
            onClose={this.stripClose(() => this.toggleSaveStates())}
        />;
    }

    showCheats(): void {
        this.showSideStrip('cheats');
    }

    toggleCheats(): void {
        this.showSideStrip(this.state.showCheats ? undefined : 'cheats');
    }

    // the strip beside the screen, which has no tab bar of its own, hence the way to close it from inside
    renderCheats(): React.ReactNode {
        return <EmulatorCheats
            cheats={this.cheats}
            finder={this.cheatFinder}
            notifications={this.notifications}
            onClose={this.stripClose(() => this.toggleCheats())}
            // which machine a cheat would be written to while linked; this strip is the only cheat list now
            inspecting={this.isInspectingPeer() ? 'peer' : 'own'}
        />;
    }

    get macroActivity(): MacroActivity {
        return this.macros.activity;
    }

    get moviePlaying(): boolean {
        return this.moviePlayer.playing;
    }

    get movieFrame(): number {
        return this.moviePlayer.frame;
    }

    get movieLength(): number {
        return this.moviePlayer.length;
    }

    stopMoviePlayback(): void {
        this.stopMovie().catch(() => undefined);
    }

    showMacros(): void {
        this.showSideStrip('macros');
    }

    cancelMacroRecording(): void {
        this.macros.cancelRecording();
        this.update();
    }

    toggleMacros(): void {
        this.showSideStrip(this.state.showMacros ? undefined : 'macros');
    }

    // the cheats' arrangement exactly, see renderCheats
    renderMacros(): React.ReactNode {
        return <EmulatorMacros
            macros={this.macros}
            notifications={this.notifications}
            onClose={this.stripClose(() => this.toggleMacros())}
        />;
    }

    showPatches(): void {
        if (this.refuseForHardcore()) {
            return;
        }
        this.showSideStrip('patches');
    }

    togglePatches(): void {
        this.showSideStrip(this.state.showPatches ? undefined : 'patches');
    }

    renderPatches(): React.ReactNode {
        return <EmulatorPatches
            patches={this.patches}
            notifications={this.notifications}
            ensureVbcSupport={() => this.ensureVbcSupportForColors()}
            onClose={this.stripClose(() => this.togglePatches())}
        />;
    }

    // two settings for two switches: vbcColorPatchesDisabled is the per-colorization opt-out. With auto-apply off a
    // colorization switched on here would come back off next launch, so switching one on turns the master on too;
    // switching one off leaves the master alone, as it is about this game, not the feature
    protected rememberColorChoice(id: string, apply: boolean): void {
        const disabled = this.settings.get('vbcColorPatchesDisabled');
        const next = apply
            ? disabled.filter(entry => entry !== id)
            : [...disabled.filter(entry => entry !== id), id];
        this.settings.set('vbcColorPatchesDisabled', next).catch(() => undefined);
        if (apply && !this.settings.get('vbcAutoApplyColorPatches')) {
            this.settings.set('vbcAutoApplyColorPatches', true).catch(() => undefined);
        }
    }

    // offer the way in rather than refusing; yes restarts the game, so it is a question, and the caller carries on
    // once the new machine is up
    protected ensureVbcSupportForColors(): Promise<boolean> {
        return this.offerVbcSupport(nls.localize(
            'vueport/vbColor/hardware/enableVbcForColors',
            'Colors are drawn by the VB Color hardware, which is switched off. Turning it on'
            + ' restarts the game.',
        )).catch(error => {
            this.onError(String(error));
            return false;
        });
    }

    showAchievements(): void {
        this.showSideStrip('achievements');
    }

    // opening them closes whichever of the other four strips was up
    toggleAchievements(): void {
        this.showSideStrip(this.state.showAchievements ? undefined : 'achievements');
    }

    // called by RetroAchievementsService through the hardcore controls handed over in the constructor; the one-time
    // switch into hardcore (ongoing gates check isHardcore: setMode, showSideStrip, canRunAction, timeSettings). The
    // ROM restarts so no cheated or rewound progress carries over
    protected async enterHardcoreDiscipline(): Promise<void> {
        this.showSideStrip(undefined);
        this.setMode(EmulatorMode.PLAY);
        this.cheats.disableAll();
        this.suppressPatchRestart = true;
        // a VB Color colorization included: it is a ROM patch like the rest
        this.patches.disableAll();
        this.macros.stop();
        this.macros.cancelRecording();
        // rewind history stops now that timeSettings reports it off; a running session needs to be told
        await this.applyRewindSettings();
        try {
            await this.patches.whenSaved();
            if (this.rom && this.state.loaded) {
                const rom = this.rom;
                await this.stop();
                await this.reopenRom(rom);
            }
        } finally {
            this.suppressPatchRestart = false;
        }
    }

    // only the strip beside the screen, which has no chrome of its own, hence the way to close it from inside
    renderAchievements(): React.ReactNode {
        return <EmulatorAchievements
            achievements={this.retroAchievements}
            onClose={this.stripClose(() => this.toggleAchievements())}
            onOpenSettings={() => this.openSettingsTab('achievements')}
            onEnable={() => this.settings.set('retroAchievementsEnabled', true)}
        />;
    }

    protected toggleSettingsTab(tab: SettingsTab): void {
        if (this.settingsTab === tab) {
            this.closeSettings();
        } else {
            this.openSettingsTab(tab);
        }
    }

    toggleDisplayWindow(): void {
        this.toggleSettingsTab('display');
    }

    togglePaletteWindow(): void {
        // the palettes moved into Display
        this.toggleSettingsTab('display');
    }

    // close the dialog on any pane, else open it on the last one. Not toggleSettingsTab('display'), which from any
    // other pane jumped to Display instead of closing
    togglePreferencesWindow(): void {
        if (this.settingsTab !== undefined) {
            this.closeSettings();
        } else {
            // the head of the rail, which on a phone is the list of panes itself
            this.openSettingsTab(settingsTabsInOrder()[0]);
            this.settingsOnList = true;
            this.update();
        }
    }

    toggleControlsOverlay(): void {
        this.toggleSettingsTab('input');
    }

    toggleScreenshotSettings(): void {
        this.toggleSettingsTab('screenshots');
    }

    toggleAchievementSettings(): void {
        this.toggleSettingsTab('achievements');
    }

    toggleSaveDataSettings(): void {
        this.toggleSettingsTab('saveData');
    }

    toggleSaveStateSettings(): void {
        this.toggleSettingsTab('saveStates');
    }

    // the catalog addresses are a section of the Library pane now
    toggleApiSettings(): void {
        this.toggleSettingsTab('library');
    }

    toggleAppearanceSettings(): void {
        this.toggleSettingsTab('appearance');
    }

    toggleLibrarySettings(): void {
        this.toggleSettingsTab('library');
    }

    isHardcore(): boolean {
        return this.settings.get('retroAchievementsHardcore');
    }

    setMode(mode: EmulatorMode): void {
        if (this.state.mode === mode) {
            return;
        }
        // Debug and Color mode are unavailable in hardcore (see enterHardcoreDiscipline); asking explains why
        if ((mode === EmulatorMode.DEBUG || mode === EmulatorMode.COLOR) && this.refuseForHardcore()) {
            return;
        }
        const leftColor = this.state.mode === EmulatorMode.COLOR;
        this.state.mode = mode;
        this.persist();
        this.applyDockLayout();
        // Color mode's editing costs the machine something every frame (the picture's origins), so it starts and stops
        // with the mode rather than the editor
        if (mode === EmulatorMode.COLOR) {
            this.colorEditor.activate().catch(() => undefined);
        } else if (leftColor) {
            this.colorEditor.deactivate().catch(() => undefined);
        }
        // Play mode only; the layout just applied decides whether the halo shows
        this.applyDecoration();
        this.update();
    }

    toggleDebugMode(): void {
        this.setMode(this.state.mode === EmulatorMode.DEBUG ? EmulatorMode.PLAY : EmulatorMode.DEBUG);
    }

    // the color editor wrote its build beside the ROM: switch it on among the colorizations, which restarts the game,
    // and put the game back at the moment it was at
    protected async useColorEditBuild(keepMoment: boolean): Promise<void> {
        const moment = keepMoment && this.sim && this.state.loaded ? await this.sim.saveState() : undefined;
        this.suppressPatchRestart = true;
        try {
            await this.patches.useColorEditBuild();
        } finally {
            this.suppressPatchRestart = false;
        }
        this.refreshRomHeader();
        this.restartForPatchChange();
        if (moment) {
            await this.patchConfigurationChange;
            await this.sim?.loadState(moment, { clearCaches: true });
        }
    }

    toggleColorMode(): void {
        this.setMode(this.state.mode === EmulatorMode.COLOR ? EmulatorMode.PLAY : EmulatorMode.COLOR);
    }

    // called at construction as well as on every mode change: until it runs the dock holds no panels. The studio
    // does the same from its init
    protected applyDockLayout(): void {
        this.dock.setPlayMode(this.state.mode === EmulatorMode.PLAY);
        this.dock.setColorMode(this.state.mode === EmulatorMode.COLOR);
        if (this.state.mode === EmulatorMode.PLAY) {
            this.dock.showScreenOnly();
        } else {
            this.restoreDockLayout();
        }
    }

    // Debug's and Color's arrangements are kept apart
    protected get modeLayoutKey(): string {
        return this.state.mode === EmulatorMode.COLOR ? `${this.dockLayoutKey}.color` : this.dockLayoutKey;
    }

    protected restoreDockLayout(): void {
        let stored;
        try {
            const raw = this.persistState ? window.localStorage.getItem(this.modeLayoutKey) : null;
            stored = raw ? JSON.parse(raw) : undefined;
        } catch {
            stored = undefined;
        }
        // undefined is valid: the dock falls back to its default
        this.dock.applySerializedLayout(stored);
    }

    // Play mode is not saved: it is a temporary screen-only view (showScreenOnly), and storing it would lose the
    // panels open in Debug mode
    protected persistDockLayout(): void {
        if (this.state.mode === EmulatorMode.PLAY || !this.persistState) {
            return;
        }
        try {
            window.localStorage.setItem(this.modeLayoutKey, JSON.stringify(this.dock.serializeLayout()));
        } catch {
            // not worth interrupting the user over
        }
    }

    setRenderingMode = async (mode: string): Promise<void> => {
        await this.settings.set('renderingMode', mode);
    };

    setScale = async (scale: string): Promise<void> => {
        await this.settings.set('scale', scale);
    };

    onRewindButtonDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
        if (!this.time.isRewindEnabled()) {
            // left alone the press becomes an ordinary click, which offers to switch the feature on
            return;
        }
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        this.time.startRewinding();
    };

    onRewindButtonUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        this.time.stopRewinding();
    };

    promptEnableRewind = async (): Promise<void> => {
        // in hardcore (or a link session) rewind is off because of it, so the notice is about that, not an offer to
        // enable a feature that would be overridden at once
        if (this.refuseForHardcore() || this.refuseWhileLinked(this.linkedRewindMessage())) {
            return;
        }
        const bufferSize = this.settings.get('rewindBufferSize');
        const confirmed = await this.notifications.confirm({
            title: nls.localize('vueport/state/rewind/title', 'Enable Rewind?'),
            message: [
                nls.localize('vueport/state/rewind/what',
                    'Rewind pauses the game and lays out the last few minutes as a filmstrip: pick a moment and'
                    + ' play on from there. To make that possible, the emulator records what changes in the machine'
                    + ' on every frame while you play.'),
                nls.localize('vueport/state/rewind/cost',
                    'Recording makes emulation roughly a third more expensive and uses up to {0} MB'
                    + ' of memory. How far back that reaches depends on the game: from about half a minute'
                    + ' for games that change a lot every frame to more than half an hour. Both are adjustable'
                    + ' in the emulator preferences.', bufferSize),
            ],
            okLabel: nls.localize('vueport/state/rewind/enable', 'Enable'),
        });
        if (confirmed) {
            await this.settings.set('rewindEnabled', true);
        }
    };

    // the studio routes this through its command service; here the gate is canRunAction and the call is direct
    runAction = (action: EmulatorAction): void => {
        if (WebEmulator.HARDCORE_BLOCKED_ACTIONS.includes(action) && this.refuseForHardcore()) {
            return;
        }
        if (!this.canRunAction(action)) {
            return;
        }
        this.performAction(action).catch(error => this.onError(String(error)));
    };

    // the transport actions hardcore takes away; each is drawn disabled but still fires, opening the "Hardcore
    // Mode is on" notice
    static readonly HARDCORE_BLOCKED_ACTIONS: EmulatorAction[] = [
        EmulatorAction.LoadState,
        EmulatorAction.Rewind,
        EmulatorAction.ToggleSlowmotion,
        EmulatorAction.FrameAdvance,
    ];

    protected refuseWhileLinked(message: string): boolean {
        if (!this.isLinked()) {
            return false;
        }
        this.notifications.info(message);
        return true;
    }

    protected linkedRewindMessage(): string {
        return nls.localize('vueport/link/rewindLocked',
            'Rewind is not available while linked. Load a save state to go back for both players.');
    }

    protected linkedPatchesMessage(): string {
        return this.player === 1
            ? nls.localize('vueport/link/patchesLockedP1',
                'Patches and colorizations are fixed while linked. Unlink to change them.')
            : nls.localize('vueport/link/patchesLockedP2',
                'While linked, player 1\'s patches and colorization apply.');
    }

    // in hardcore, show the "Hardcore Mode is on" notice (with its one-click way out) and tell the caller to stop;
    // every control hardcore disables routes through this instead of failing silently
    protected refuseForHardcore(): boolean {
        if (!this.isHardcore()) {
            return false;
        }
        this.retroAchievements.offerToLeaveHardcore().catch(() => undefined);
        return true;
    }

    canRunAction(action: EmulatorAction): boolean {
        if (!this.state.loaded) {
            return WebEmulator.ACTIONS_WITHOUT_ROM.includes(action);
        }
        // the hardcore-blocked transport actions are not gated here: runAction catches them first and shows the
        // "Hardcore Mode is on" notice, like the grayed-but-live buttons
        // in a headset the settings are always up beside the game, see headsetPanels
        if (this.activeSettingsTab !== undefined && !this.headsetPanels) {
            // the dialog is up; only the shortcut that closes the input pane still does anything
            return action === EmulatorAction.ToggleControlsOverlay;
        }
        // the filmstrip holds the machine at a moment not yet chosen; only what leaves it alone runs
        if (this.rewindBrowser.isOpen) {
            return WebEmulator.ACTIONS_WHILE_BROWSING_REWIND.includes(action);
        }
        if (this.state.paused) {
            return WebEmulator.ACTIONS_WHILE_PAUSED.includes(action)
                || (this.state.frameAdvance && action === EmulatorAction.FrameAdvance);
        }
        return true;
    }

    // neither needs a running machine: one configures the keyboard, the other resizes the window
    static readonly ACTIONS_WITHOUT_ROM: EmulatorAction[] = [
        EmulatorAction.ToggleControlsOverlay,
        EmulatorAction.Fullscreen,
    ];

    static readonly ACTIONS_WHILE_BROWSING_REWIND: EmulatorAction[] = [
        EmulatorAction.Screenshot,
        EmulatorAction.Fullscreen,
        EmulatorAction.AudioMute,
    ];

    static readonly ACTIONS_WHILE_PAUSED: EmulatorAction[] = [
        EmulatorAction.PauseToggle,
        // the filmstrip, which works paused as well
        EmulatorAction.Rewind,
        EmulatorAction.Reset,
        EmulatorAction.ToggleSlowmotion,
        EmulatorAction.ToggleFastForward,
        EmulatorAction.SaveState,
        EmulatorAction.LoadState,
        EmulatorAction.Screenshot,
        EmulatorAction.VideoRecord,
        EmulatorAction.Fullscreen,
        EmulatorAction.ToggleControlsOverlay,
        EmulatorAction.AudioMute,
        EmulatorAction.ToggleLowPower,
        EmulatorAction.FrameAdvance,
    ];

    async performAction(action: EmulatorAction): Promise<void> {
        await this.sendCommand('keyPress', action);
    }

    // the web app has no command registry; only the input commands reach here
    runCommand(id: string): void {
        if (id === EmulatorCommands.INPUT_SAVE_STATE.id) {
            this.performAction(EmulatorAction.SaveState).catch(error => this.onError(String(error)));
        } else if (id === EmulatorCommands.INPUT_LOAD_STATE.id) {
            this.performAction(EmulatorAction.LoadState).catch(error => this.onError(String(error)));
        } else if (id === EmulatorCommands.PROFILE_START.id || id === EmulatorCommands.PROFILE_STOP.id) {
            // the two commands are one toggle here; the screen badge's Stop and the CPU Profiler's button come
            // through it
            this.toggleProfiling().catch(error => this.onError(String(error)));
        } else if (id === EmulatorCommands.LINK_SECOND_PLAYER.id
            || id === EmulatorCommands.RELINK_PLAYERS.id) {
            // a second window cannot be seen, let alone played in, from a headset
            if (!this.headsetPanels) {
                this.link?.request();
            }
        } else if (id === EmulatorCommands.UNLINK_PLAYERS.id) {
            this.link?.release();
        } else if (id === EmulatorCommands.INSPECT_OTHER_PLAYER.id
            || id === EmulatorCommands.INSPECT_OWN_PLAYER.id) {
            this.dock.setInspecting(
                id === EmulatorCommands.INSPECT_OTHER_PLAYER.id ? 'peer' : 'own');
            this.update();
        }
    }

    // commands

    async sendCommand(command: string, data?: unknown): Promise<void> {
        const vbKey = GAMEPAD_KEY_TO_VB_KEY[data as keyof typeof GAMEPAD_KEY_TO_VB_KEY];
        if (vbKey !== undefined) {
            if (command === 'keyPress') {
                await this.input.tapKey(vbKey);
            } else {
                await this.input.setKey(vbKey, command === 'keydown');
            }
            return;
        }

        // the key and pad button send their press as keydown, the strip's button and the command palette as keyPress; all
        // open the filmstrip, and a release means nothing. promptEnableRewind answers hardcore and link sessions too
        if (data === EmulatorAction.Rewind) {
            if (command === 'keydown' || command === 'keyPress') {
                if (!this.time.isRewindEnabled()) {
                    await this.promptEnableRewind();
                } else {
                    this.rewindBrowser.open();
                }
            }
            return;
        }

        if (command !== 'keyPress' && command !== 'keyup') {
            return;
        }

        switch (data) {
            case EmulatorAction.AudioMute:
                this.state.muted = !this.state.muted;
                await this.sim?.setVolume(this.state.muted ? 0 : DEFAULT_VOLUME);
                this.esSound.setMuted(this.state.muted);
                this.persist();
                this.update();
                break;
            case EmulatorAction.PauseToggle:
                this.pausedForXrUi = false;
                this.state.paused = !this.state.paused;
                this.state.frameAdvance = false;
                if (this.state.paused) {
                    await this.core?.suspend();
                } else {
                    await this.core?.run();
                }
                this.esSound.setPaused(this.state.paused);
                // the other player's window pauses and carries on with ours
                this.link?.setPaused(this.state.paused);
                this.update();
                break;
            case EmulatorAction.ToggleLowPower:
                this.state.lowPower = !this.state.lowPower;
                await this.input.applyKeys();
                this.update();
                break;
            case EmulatorAction.ToggleSlowmotion:
                this.state.slowmotion = !this.state.slowmotion;
                this.state.fastForward = false;
                await this.time.applySpeed();
                if (this.state.slowmotion) {
                    await this.resume();
                }
                this.update();
                break;
            case EmulatorAction.ToggleFastForward:
                this.state.fastForward = !this.state.fastForward;
                this.state.slowmotion = false;
                await this.time.applySpeed();
                if (this.state.fastForward) {
                    await this.resume();
                }
                this.update();
                break;
            case EmulatorAction.FrameAdvance:
                if (!this.state.paused) {
                    this.state.paused = true;
                    await this.core?.suspend();
                    this.esSound.setPaused(true);
                    this.link?.setPaused(true);
                }
                this.state.frameAdvance = true;
                await this.core?.stepFrame();
                this.update();
                break;
            case EmulatorAction.Fullscreen:
                await this.enterFullscreen();
                break;
            case EmulatorAction.ToggleControlsOverlay:
                this.toggleControlsOverlay();
                break;
            case EmulatorAction.Reset:
                // linked, a reset is both consoles' reset button at once, or the two copies of its machine diverge;
                // see LinkRestart
                if (this.isLinked()) {
                    await this.link?.restart();
                } else {
                    await this.resetSim();
                }
                await this.resume();
                this.update();
                break;
            case EmulatorAction.SaveState:
                await this.saveState();
                break;
            case EmulatorAction.LoadState:
                await this.loadState();
                break;
            case EmulatorAction.Screenshot:
                await this.takeScreenshot();
                break;
            case EmulatorAction.VideoRecord:
                await this.toggleVideoRecording();
                break;
        }
    }

    // the headset's interface pauses the game behind it and carries on with it once put away; a game the player had
    // paused already, or paused or carried on with themselves while it showed, is theirs and stays as they left it
    protected pausedForXrUi = false;

    protected async pauseForXrUi(shown: boolean): Promise<void> {
        if (!shown) {
            const paused = this.pausedForXrUi;
            this.pausedForXrUi = false;
            if (paused && this.state.loaded) {
                await this.resume();
                this.update();
            }
            return;
        }
        if (!this.core || !this.state.loaded || this.state.paused) {
            return;
        }
        this.pausedForXrUi = true;
        this.state.paused = true;
        this.state.frameAdvance = false;
        await this.core.suspend();
        this.esSound.setPaused(true);
        this.update();
    }

    // leave pause, for actions that only make sense on a running machine: reset, fast forward, slow motion
    protected async resume(): Promise<void> {
        if (!this.state.paused) {
            return;
        }
        this.state.paused = false;
        this.state.frameAdvance = false;
        await this.core?.run();
        this.esSound.setPaused(false);
        this.link?.setPaused(false);
    }

    // not through PauseToggle, which tells the other window in turn, so the two would answer each other forever
    followPeerPause(paused: boolean): void {
        if (!this.core || !this.state.loaded || this.state.paused === paused) {
            return;
        }
        this.state.paused = paused;
        this.state.frameAdvance = false;
        (paused ? this.core.suspend() : this.core.run()).catch(() => undefined);
        this.esSound.setPaused(paused);
        this.update();
    }

    // on the desktop this fullscreens the window itself (see setWindowFullscreen); in a browser the page's element
    protected async enterFullscreen(): Promise<void> {
        if (isDesktop()) {
            await setWindowFullscreen(!await isWindowFullscreen());
            return;
        }
        const node = document.getElementById('vp-root');
        if (node && !document.fullscreenElement) {
            // a phone's navigation bar goes too, so a game on its side has the whole screen
            await node.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
        } else if (document.fullscreenElement) {
            await document.exitFullscreen().catch(() => undefined);
        }
    }

    // ROM

    // a stand-in when nothing is loaded, so the paths are still answerable: the store's own roms/unknown
    protected companionRom(): CompanionRom {
        return this.rom ?? { name: 'unknown' };
    }

    // per the companionFiles setting
    protected romDirectory(): string {
        return this.companions.directory(this.companionRom());
    }

    /**
     * Where ESSound looks for this game's tracks (see EmulatorCompanionFiles.sounds), or nowhere. A bare ROM whose
     * folder is unknown (a browser's picker or drop, ?rom=) brought none, and the store's folder for its name holds
     * what an archive of the same name unpacked there, which belongs to that archive: Super Metroid.vb picked in a
     * browser must not play the tracks of a Super Metroid.vbz opened before. An archive reopened from the start page
     * brings its tracks no more than the bare ROM does, but is still that archive, so it finds them there.
     */
    protected esSoundDirectory(): string | undefined {
        const rom = this.companionRom();
        return rom.location === undefined && this.rom?.archive === undefined
            ? undefined
            : this.companions.sounds(rom);
    }

    // what openRom needs to start the same file again: from the same place and archive, so saves and ESSound tracks
    // are looked for where they were
    protected reopenRom(rom: { name: string, data: Uint8Array, location?: string, archive?: string }): Promise<void> {
        return this.openRom(rom.name, rom.data, [], rom.location,
            rom.archive !== undefined ? { archive: rom.archive } : undefined);
    }

    // the promise is the cache: profiler rows, memory pools and the actor inspector ask on every refresh, and an .elf
    // is tens of megabytes, read once per ROM or not at all
    protected symbols: Promise<SymbolIndex | undefined> | undefined;
    protected lines: Promise<VesLineTable | undefined> | undefined;

    // out of the same .elf, where .debug_line is: no toolchain, no second file, and the same absence for a ROM not
    // built here
    protected romLineTable(): Promise<VesLineTable | undefined> {
        if (!this.lines) {
            this.lines = this.readLineTable().catch(error => {
                console.warn('[emulator] ROM line table could not be read:', error);
                return undefined;
            });
        }
        return this.lines;
    }

    protected async readLineTable(): Promise<VesLineTable | undefined> {
        const bytes = await this.readElfBeside();
        if (!bytes) {
            return undefined;
        }
        const [{ readElf }, { parseDwarfLineTable }] = await Promise.all([
            import('vueport-core/lib/browser/core/emulator-elf'),
            import('vueport-core/lib/browser/core/emulator-line-table'),
        ]);
        const image = readElf(bytes);
        const section = image?.section('.debug_line');
        if (!section) {
            return undefined;
        }
        // the ROM's own size: a row is kept as an offset into it, and the cartridge mirrors at whatever size it is
        return parseDwarfLineTable(section, Math.max(0, this.romSize) * BYTES_PER_MBIT);
    }

    // one source file the line table named, read through the same door as the .elf
    protected async readSourceFile(path: string): Promise<string | undefined> {
        const location = this.rom?.location;
        if (location === undefined || !isDesktop()) {
            return undefined;
        }
        const { sourcePathCandidates } = await import(
            'vueport-core/lib/browser/core/emulator-line-table');
        const directory = this.storage.parent(location).replace(/\\/g, '/').replace(/\/+$/, '');

        for (const candidate of sourcePathCandidates(path, directory)) {
            // only under the ROM's own build tree, so a path elsewhere is refused rather than a way to read the disk;
            // for a VUEngine build DWARF names the generated files beside the ROM anyway
            if (!candidate.startsWith(`${directory}/`)) {
                continue;
            }
            const bytes = await this.readBesideRom(candidate.slice(directory.length + 1));
            if (bytes) {
                return new TextDecoder().decode(bytes);
            }
        }
        return undefined;
    }

    // a failure is not one: a ROM built elsewhere has no .elf beside it, the ordinary case, and every panel says so
    protected romSymbols(): Promise<SymbolIndex | undefined> {
        if (!this.symbols) {
            this.symbols = this.readSymbols().catch(error => {
                console.warn('[emulator] ROM symbols could not be read:', error);
                return undefined;
            });
        }
        return this.symbols;
    }

    protected async readSymbols(): Promise<SymbolIndex | undefined> {
        const bytes = await this.readElfBeside();
        if (!bytes) {
            return undefined;
        }
        const [{ readElf }, { indexElfSymbols }] = await Promise.all([
            import('vueport-core/lib/browser/core/emulator-elf'),
            import('vueport-core/lib/browser/core/emulator-symbols'),
        ]);
        const image = readElf(bytes);
        return image ? indexElfSymbols(image) : undefined;
    }

    // build/output.vb's name says nothing of its build mode, and its .elf stays in the working directory; the .map
    // copied alongside names it (OUTPUT(build/working/output-beta.elf elf32-v810)), so the sibling is tried first
    protected async readElfBeside(): Promise<Uint8Array | undefined> {
        const stem = this.romFileStem();
        if (stem === undefined) {
            return undefined;
        }
        const sibling = await this.readBesideRom(`${stem}.elf`);
        if (sibling) {
            return sibling;
        }
        const map = await this.readMapBeside();
        if (map === undefined) {
            return undefined;
        }
        const { readElfPathFromMap } = await import('vueport-core/lib/browser/core/emulator-elf');
        const declared = readElfPathFromMap(map);
        return declared === undefined ? undefined : this.readBesideRom(declared);
    }

    // separate from the symbols on purpose: every VUEngine ROM has a map, while the .elf is tens of megabytes most
    // sessions never need
    protected async buildModeBeside(): Promise<string | undefined> {
        const map = await this.readMapBeside();
        if (map === undefined) {
            return undefined;
        }
        const { readBuildModeFromMap } = await import('vueport-core/lib/browser/core/emulator-elf');
        return readBuildModeFromMap(map);
    }

    protected async readMapBeside(): Promise<string | undefined> {
        const stem = this.romFileStem();
        const bytes = stem === undefined ? undefined : await this.readBesideRom(`${stem}.map`);
        return bytes && new TextDecoder().decode(bytes);
    }

    // what its build named everything else after; undefined when there is nothing to be beside (a browser is never
    // told where a ROM came from)
    protected romFileStem(): string | undefined {
        const location = this.rom?.location;
        return location === undefined || !isDesktop()
            ? undefined
            : this.storage.stem(this.storage.name(location));
    }

    // through the shell rather than storage: the .elf a .map names is a folder away, which the store's guard
    // refuses, and Tauri's default JSON number arrays are worth avoiding (see readRomBuildFile). Absent is ordinary
    protected async readBesideRom(relative: string): Promise<Uint8Array | undefined> {
        const location = this.rom?.location;
        if (location === undefined || !isDesktop()) {
            return undefined;
        }
        return readRomBuildFile(location, relative).catch(() => undefined);
    }

    // not simply the setting: when a slot switch is heard the setting already names the new slot, and writing the
    // RAM in hand there would copy the old save over the new one. The RAM belongs to the slot it was loaded from
    protected loadedSaveSlot: string = DEFAULT_SAVE_SLOT;

    // kept so writing the save back never makes it smaller, as the file may hold what earlier sessions wrote higher
    // up; zero when there was no file. Set beside loadedSaveSlot, as a slot switch replaces both
    protected loadedSaveRamBytes = 0;

    get saveGameSlot(): string {
        return emulatorSaveSlot(this.settings.get('saveGameSlot'));
    }

    async pickStereoDepth(): Promise<void> {
        await pickNumberSetting(this.ui, this.settings, 'stereoDepth');
    }

    async pickSaveGameSlot(): Promise<void> {
        const current = this.saveGameSlot;
        const picked = await this.ui.pick(
            nls.localize('vueport/saveSlot/pick', 'Select save game slot…'),
            EMULATOR_SAVE_SLOTS.map(slot => ({
                id: slot,
                label: nls.localize('vueport/preferences/saveGameSlot/item', 'Slot {0}', slot),
                // which one is in play, and which others hold a game: a run to go back to, or one to start
                description: slot === current
                    ? nls.localize('vueport/saveSlot/current', 'In play')
                    : this.filledSaveSlots.has(slot)
                        ? nls.localize('vueport/saveSlot/used', 'Has a save')
                        : undefined,
                // only on the slot in play with a game running: runs Delete Current Save Game Slot, which restarts
                // the game on the emptied slot. Shown even without a file, as the game may hold unwritten progress
                buttons: slot === current && this.rom && this.state.loaded
                    ? [{
                        icon: Trash,
                        label: nls.localize('vueport/saveSlot/delete', 'Delete Current Save Game Slot'),
                        run: () => { this.deleteSaveSlotAndRestart().catch(() => undefined); },
                    }]
                    : undefined,
            })) satisfies PickItem[],
            nls.localize('vueport/saveSlot/noMatch', 'No matching slot'),
        );
        if (picked && picked.id !== current) {
            await this.settings.set('saveGameSlot', picked.id);
        }
    }

    // read when a ROM starts and after a write rather than while the list is built, so the picker opened mid-game does
    // not wait on twenty-six lookups
    protected filledSaveSlots = new Set<string>();

    protected async refreshFilledSaveSlots(): Promise<void> {
        if (!this.rom) {
            this.filledSaveSlots = new Set();
            return;
        }
        const found = await Promise.all(EMULATOR_SAVE_SLOTS.map(async slot =>
            await this.storage.exists(this.saveRamPath(slot)) ? slot : undefined));
        this.filledSaveSlots = new Set(found.filter((slot): slot is string => slot !== undefined));
        this.update();
    }

    // numbered, so a linked pair never share one
    protected saveRamPath(slot: string = this.saveGameSlot): string {
        return this.companions.saveRam(this.companionRom(), this.player, slot);
    }

    // tears down whatever was running first: a fresh session is easier to reason about than reusing one
    async openRom(
        name: string,
        data: Uint8Array,
        sounds: RomSound[] = [],
        location?: string,
        // url: where it was downloaded from; archive: the file it was unpacked from, when the caller knows
        origin?: { url?: string, archive?: string },
        // resume: the library's Resume button; fresh: neither offer nor load the suspended game; state: a save state
        // file to continue from instead (a LAN share's moment)
        start?: { resume?: boolean, fresh?: boolean, state?: Uint8Array },
    ): Promise<void> {
        beginLoadTrace();
        // into the headset from the click that opened the game, while that click still counts, before anything waits
        if (this.entersHeadsetOnPlay) {
            this.xr.enter().catch(() => undefined);
        }
        // in a headset already, its interface steps aside for the game. The one it paused is about to stop, not carry on
        this.pausedForXrUi = false;
        this.xr.gameStarting();
        await this.stop();
        markLoadTrace('stop previous');
        this.rom = { name, data, location, archive: origin?.archive ?? this.archiveAt(location, name) };
        this.status = EmulatorRomStatus.EXISTS;

        this.romHeader = parseRomHeader(data);
        this.romSize = romSizeInMBit(data);
        // over the whole file, which the preservation catalogs behind the cheat database key on
        this.romId = formatRomId(crc32(data));
        // RetroAchievements identifies a VB dump by whole-file MD5; not computed here, see romMd5
        this.romMd5Value = undefined;
        // a share is of one game; a restart of that one (a patch, a save slot) keeps it
        if (this.lanSharedRomId !== undefined && this.lanSharedRomId !== this.romId && !this.lanSharedFromLibrary) {
            await this.stopLanShare();
        }
        markLoadTrace(`header + crc32 (${data.byteLength} B)`);

        // the start page offers recent ROMs back, which in a browser means keeping the bytes (it cannot reopen by
        // path). Fire and forget. Player 2's ROM is not "recent", just handed over for one session
        if (this.player === 1) {
            // counted the moment the cartridge goes in and written at once, so a session ending in a crash still happened;
            // the hours are the clock in update
            this.playTimes.began(this.romId);
            this.recents.remember({
                id: this.romId,
                name,
                bytes: data.byteLength,
                source: origin?.url ? 'url' : 'file',
                url: origin?.url,
                // what makes starting it again from the start page the same as from the file, see RecentRom.location
                location,
                archive: this.rom.archive,
            }, data).catch(() => undefined);
        }
        // pushed to the dock, as the ROM Info panel only sees VesEmulatorDebugSource. The build mode comes from the
        // .map beside the ROM (desktop only), read after the ROM is showing, as starting the game need not wait on it
        this.symbols = undefined;
        this.lines = undefined;
        this.romBuildMode = undefined;
        this.dock.setRomInfo(this.romHeader, this.romSize, this.romBuildMode, this.romId);
        this.buildModeBeside()
            .then(mode => {
                // the ROM may have been closed or replaced while this read was in flight
                if (mode !== undefined && this.rom?.location === location) {
                    this.romBuildMode = mode;
                    this.dock.setRomInfo(this.romHeader, this.romSize, mode, this.romId);
                }
            })
            .catch(() => undefined);
        // the header is half of what Auto resolves against, so the color-only debugger surfaces follow it
        this.dock.setVbcSupportEnabled(this.vbcSupportEnabled, this.vbcHardwareActive);
        await this.patches.load(this.companions.romPath(this.rom), this.romId, data);
        markLoadTrace('patches.load');
        // a persisted switch must not smuggle a patched run into a hardcore session restored at start; a colorization
        // does not switch itself on in hardcore either (see the patch store's choice)
        if (this.isHardcore()) {
            this.patches.disableAll();
        }
        // after both stores and before start: the hardware model is chosen from this header and handed to the core
        // first
        this.refreshRomHeader();
        document.title = this.storage.stem(shownFileName(this.rom.archive, name));
        this.applyRomTitle(shownFileName(this.rom.archive, name));
        await this.unpackSounds(sounds);
        markLoadTrace('title + unpackSounds');
        await this.start();
        // here rather than in start, which also runs for every patch or hardware restart: resuming is about opening a
        // game
        if (start?.state) {
            await this.continueFromState(start.state);
        } else if (!start?.fresh) {
            await this.offerToResume(start?.resume);
        }
        markLoadTrace('offerToResume');
    }

    // the Planet VB title for the page title, the same lookup and cache as the title bar and the Game Information
    // window (keyed on romId), starting from the file's stem; guards against an answer for a ROM that has since gone
    protected applyRomTitle(name: string): void {
        const hash = this.romId;
        const fallback = this.storage.stem(name);
        const cached = cachedRom(hash);
        if (cached) {
            document.title = cached.game?.romTitle || fallback;
            return;
        }
        lookupRom(hash)
            .then(result => {
                if (this.romId === hash) {
                    document.title = result?.romTitle || fallback;
                }
            })
            .catch(() => undefined);
    }

    /**
     * ESSound plays files next to the cartridge, which in a browser only an archive brings. Written into the ROM's
     * folder in the store even on the desktop, as that is what scan reads (see EmulatorCompanionFiles.sounds). Only
     * when the archive brought some, so the archive reopened from the start page, which is the ROM alone, keeps what
     * was unpacked earlier. A bare ROM of the same name doesn't look there, see esSoundDirectory.
     */
    protected async unpackSounds(sounds: RomSound[]): Promise<void> {
        if (sounds.length === 0) {
            return;
        }
        const directory = this.companions.sounds(this.companionRom());
        try {
            // out with the old first, so a second archive with fewer tracks does not leave dropped ones playable
            for (const file of await this.storage.list(directory)) {
                if (isEsSoundFile(file.name)) {
                    await this.storage.delete(file.path);
                }
            }
            for (const sound of sounds) {
                await this.storage.write(this.storage.join(directory, sound.name), sound.data);
            }
        } catch (error) {
            // worth saying, but not worth refusing to start the game over
            this.notifications.warn(
                nls.localize('vueport/rom/soundsFailed',
                    "The ROM's sound files could not be unpacked: {0}", String(error))
            );
        }
    }

    protected async stop(): Promise<void> {
        // nothing to run once the session has gone
        this.rewindBrowser.abandon(false);
        this.runningImage = undefined;
        // the headset stays: a rebuilt or replaced game shows again once it runs; only closeRom takes the player out
        await this.xr.setSim(undefined);
        // before anything is torn down: a recording is only a file once stopped, and its frame source is about to go.
        // Saved rather than dropped
        await this.finishVideoRecording();
        // nothing to take a state of once the session is gone, and the next one starts its own clock
        this.stopAutoSaveStates();
        if (this.sim && this.state.loaded) {
            await this.saveSaveRam().catch(() => undefined);
        }
        // the worker the engine ran in is about to go; nothing for RetroAchievements to track until the next session
        if (this.player === 1) {
            await this.retroAchievements.setSession(undefined, undefined);
        }
        if (this.session) {
            this.coreService.disposeSession(this.session);
            this.session = undefined;
        }
        // whatever a macro was recording or holding belonged to the machine that has just gone
        this.macros.stop();
        this.macros.cancelRecording();
        // so does a search in progress: its addresses were narrowed against a machine that no longer exists
        this.searchedSim = undefined;
        this.cheatFinder.setSim(undefined);
        // ESSound plays through the page, so a looping track would carry on over the start page; telling the player the
        // simulation has gone stops every slot, and start re-attaches for whatever runs next
        await this.esSound.setSim(undefined);
        this.core = undefined;
        this.sim = undefined;
        this.state.loaded = false;
        // the pack's own machine has gone with the session
        this.applyRumbleForwarding();
        // belonged to the session that has just gone; the next reports its own within the second
        this.emulationSpeed = undefined;
        // no sim to sample, so the immersion halo stops feeding
        this.applyDecoration();
        this.clearRecentThumbnail();
        this.update();
    }

    protected async start(): Promise<void> {
        const rom = this.rom;
        if (!rom) {
            return;
        }
        const displayMode = this.getDisplayMode();
        this.dock.screen.setDisplayMode(displayMode);
        const canvas = this.dock.screen.takeCanvas();

        try {
            const session = await this.coreService.createSession();
            markLoadTrace('createSession');
            this.session = session;
            this.core = session.core;
            this.sim = session.sim;
            await this.sim.setHardwareMode(
                this.resolvedHardwareMode === VbHardwareMode.VB_COLOR
            );
            markLoadTrace('setHardwareMode');
            this.toDispose.push(session.core.onError(message => this.onError(message)));
            this.toDispose.push(session.core.onStalled(() => this.onStalled()));
            // a breakpoint suspends the machine underneath everything, so the pause state has to follow rather than
            // be told
            this.toDispose.push(session.core.onStopped(() => {
                this.state.paused = true;
                this.state.frameAdvance = false;
                this.esSound.setPaused(true);
                this.update();
            }));
            this.toDispose.push(session.core.onSpeed(speed => {
                this.emulationSpeed = speed;
                this.update();
            }));
            // only a machine under lockstep reports its frame, which here is only a playing movie; see MoviePlayer
            this.toDispose.push(session.core.onProgress(({ frame }) => {
                if (this.moviePlayer.playing) {
                    this.moviePlayer.advance(frame);
                    this.update();
                }
            }));

            this.dock.setSim(this.sim);
            // a patch can change the model as well as the setting can (the header's VB Color byte), so the color-only
            // surfaces follow every restart
            this.dock.setVbcSupportEnabled(this.vbcSupportEnabled, this.vbcHardwareActive);
            this.cheats.setSim(this.sim);
            this.searchedSim = this.sim;
            this.cheatFinder.setSim(this.sim);
            this.applyScale();
            await this.sim.setDisplayMode(displayMode);
            await this.sim.attachCanvas(canvas);
            markLoadTrace('attachCanvas');
            await this.xr.setSim(this.sim);
            await this.sim.setVolume(this.state.muted ? 0 : DEFAULT_VOLUME);
            markLoadTrace('xr + setVolume');

            await this.time.applySpeed();
            await this.applyRewindSettings();
            await this.applyStereoDepth();
            await this.core?.setColumnGeometry(this.settings.get('columnTable'));
            await this.core?.setMirrorSpinUp(this.settings.get('mirrorSpinUp'), this.settings.get('mirrorSpinUpDelay'));
            markLoadTrace('speed/rewind/stereo');

            this.runningImage = this.patches.apply(rom.data);
            await this.sim.setCartRom(this.runningImage.slice().buffer as ArrayBuffer);
            markLoadTrace('patch + setCartRom');

            /**
             * The engine lives in this session's worker (see vb-rcheevos.ts), while the account survives across ROMs.
             * Fire and forget: no set, no account or an unreachable server leave the panel saying why without holding
             * up the game. Player 1's window only: the second exists to be the other end of a cable, and crediting a
             * shared game is RetroAchievements' question; the core guards do_frame too, so the peer's mirror never
             * counts.
             */
            if (this.player === 1) {
                this.retroAchievements.setSession(session.core, this.sim)
                    .then(() => this.retroAchievements.loadGame(this.romMd5))
                    .catch(() => undefined);
            }

            const romPath = this.companions.romPath(rom);
            await this.cheats.load(romPath, this.romId, rom.data.length);
            markLoadTrace('cheats.load');
            await this.macros.load(romPath);
            markLoadTrace('macros.load');
            // not romPath: where the tracks are does not follow the companionFiles setting (see
            // EmulatorCompanionFiles.sounds)
            await this.esSound.scanDirectory(this.esSoundDirectory());
            markLoadTrace('esSound.scanDirectory');
            await this.esSound.setSim(this.sim);
            this.esSound.setMuted(this.state.muted);
            this.toDispose.push(
                this.sim.onEsSound(commands => commands.forEach(raw => this.esSound.handle(raw)))
            );
            /**
             * What the game clocks out of the link port is what a Rumble Pack listens to, watched whenever a pack could
             * act on it, so the panel shows traffic before one is plugged in. Only this window's own machine: onLink is
             * filtered to its simulation and capture is never on for the mirror, so the pack answers to the player at
             * this desk, as on hardware with one pack in one player's link port.
             */
            if (this.rumblePack !== NO_RUMBLE_PACK) {
                await this.sim.setLinkCapture(true);
                this.toDispose.push(this.sim.onLink(bytes => {
                    if (!this.rumblePack.forwarding) {
                        return;
                    }
                    for (const byte of bytes) {
                        this.rumblePack.sendByte(byte).catch(() => undefined);
                    }
                }));
            }

            await this.loadSaveRam();
            markLoadTrace('loadSaveRam');
            // the library belongs to the ROM, so it is read again on every restart (a patch, a save slot) from the
            // folder's own listing; see SaveStateStore
            await this.saveStates.attach(this.companionRom(), this.createSaveStateMachine());
            markLoadTrace('saveStates.attach');
            // not awaited: twenty-six lookups for a list nobody is looking at yet
            this.refreshFilledSaveSlots().catch(() => undefined);
            await this.resetSim();
            markLoadTrace('resetSim');
            // a new machine has been told nothing yet; turbo especially is only ever sent on a change
            this.input.invalidate();
            await this.input.applyKeys();
            await this.input.applyTurbo();
            markLoadTrace('applyKeys');
            await session.core.run();
            markLoadTrace('core.run');

            this.state.loaded = true;
            // a new machine, perhaps a new game: what the color editor picked in the old one is gone
            this.colorEditor.sessionChanged().catch(() => undefined);
            // here because forwarding waits for loaded: a solo game starts forwarding at this line, and a second
            // player's window is switched off again once its session connects
            this.applyRumbleForwarding();
            this.state.paused = false;
            this.esSound.setPaused(false);
            this.applyDecoration();
            this.scheduleRecentThumbnail();
            this.startAutoSaveStates();
            this.update();
            this.sayIfAudioBlocked(session.core).catch(() => undefined);
        } catch (error) {
            this.onError(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Emulation is clocked by the audio worklet, so a window whose audio the autoplay policy holds back shows only a
     * black picture. That only happens in a window opened without a touch, i.e. the second player's (window.open
     * carries no user activation). Shown over the picture rather than as a toast, as the condition doesn't go away by
     * itself; any click or key lets the audio through, so the prompt names the gesture instead of offering a button.
     */
    protected async sayIfAudioBlocked(core: Core): Promise<void> {
        if (!await core.audioStillBlocked()) {
            return;
        }
        this.dock.screen.setPrompt(nls.localize('vueport/state/clickToPlay', 'Click to play'));
        const unblocked = core.onDidUnblockAudio(() => {
            unblocked.dispose();
            this.dock.screen.setPrompt(undefined);
            this.update();
        });
    }

    protected async resetSim(): Promise<void> {
        await this.sim?.reset();
    }

    protected static readonly RECENT_THUMBNAIL_DELAY_MS = 4000;

    protected scheduleRecentThumbnail(): void {
        this.clearRecentThumbnail();
        const romId = this.romId;
        if (!romId || this.player !== 1) {
            return;
        }
        this.recentThumbnailTimer = setTimeout(() => {
            this.recentThumbnailTimer = undefined;
            this.captureRecentThumbnail(romId).catch(() => undefined);
        }, WebEmulator.RECENT_THUMBNAIL_DELAY_MS);
    }

    protected clearRecentThumbnail(): void {
        if (this.recentThumbnailTimer !== undefined) {
            clearTimeout(this.recentThumbnailTimer);
            this.recentThumbnailTimer = undefined;
        }
    }

    // always VB_DEFAULT_DISPLAY_MODE (Left Eye, default palette, scale 1), so it matches every other ROM's in the
    // Continue list; at 384x224 it is small enough as a data URL. Best-effort: a swapped ROM, a paused machine or a
    // failed read leave the entry's old picture
    protected async captureRecentThumbnail(romId: string): Promise<void> {
        if (!this.sim || !this.state.loaded || this.state.paused || this.romId !== romId) {
            return;
        }
        const png = await this.sim.capture(VB_DEFAULT_DISPLAY_MODE, 1);
        if (!png || png.byteLength === 0 || this.romId !== romId) {
            return;
        }
        await this.recents.setThumbnail(romId, bytesToDataUrl(new Uint8Array(png), 'image/png'));
    }

    // storage

    // a cartridge always gets RAM, even one never saved to: the core drops every access to the save region until a
    // simulation has some (see VB_CART_RAM_BASE), which looks exactly like saving being broken
    protected async loadSaveRam(): Promise<void> {
        if (!this.sim) {
            return;
        }
        // the whole of Game Pak RAM, as a VB ROM cannot say how much its cartridge answers on; the file size is decided
        // on the way out (saveSaveRam). Narrower only if asked for, which makes the cartridge mirror like real hardware
        const window = saveRamWindowBytes(this.settings.get('sramWindow'));
        const ram = freshSaveRam(this.settings.get('sramInit'), window);

        // remembered before the read, so a slot without a file yet is still where this RAM is written back
        this.loadedSaveSlot = this.saveGameSlot;
        this.loadedSaveRamBytes = 0;
        const path = this.saveRamPath();
        if (await this.storage.exists(path)) {
            const stored = await this.storage.read(path);
            // a truncated or hand-edited file starts the game fresh: the sizes written here are always powers of two
            if (stored.length === 0 || (stored.length & (stored.length - 1)) !== 0) {
                console.warn(`[vueport] ignoring save RAM of unusable size ${stored.length}: ${path}`);
            } else {
                /**
                 * At the bottom of the window, where the game wrote it: with the whole region backed nothing aliases,
                 * so a shorter file is a window whose top the game never reached. The rest keeps its fill, zero above
                 * the baseline, which the write-back size depends on. A file longer than the window predates narrowing
                 * it: only what fits is given to the machine, and the rest is put back around it on write, so narrowing
                 * costs no progress.
                 */
                ram.set(stored.subarray(0, Math.min(stored.length, ram.length)));
                this.loadedSaveRamBytes = stored.length;
            }
        }

        // not sliced: nothing else holds the buffer, and at 16 MiB the copy would be the costliest thing in opening a
        // game
        await this.sim.setCartRam(ram.buffer as ArrayBuffer);
    }

    // a game's saves live in the worker until flushed, and stopping on the way out is a race the page usually loses;
    // a host that is told it is closing calls this and waits
    async flushSaves(): Promise<void> {
        if (this.sim && this.state.loaded) {
            await this.saveSaveRam();
            // the other half of putting a game away: the desktop shell holds the window open until this resolves, so
            // the state is on disk before the app goes
            await this.writeSuspendState();
        }
    }

    /**
     * Writes cartridge RAM back at the size the game has earned rather than all 16 MiB. The worker says how far up the
     * game wrote, and the file is the next power of two holding it, never below the 16 KiB other VB emulators expect,
     * nor below the file this session started from. Lossless, as the window above the baseline is zeroed again on the
     * way back in.
     */
    protected async saveSaveRam(): Promise<void> {
        if (!this.sim) {
            return;
        }
        const info = await this.sim.cartRamInfo();
        if (info.size === 0) {
            return;
        }
        const bytes = Math.min(
            info.size,
            saveRamFileSize(info.used, this.loadedSaveRamBytes),
        );
        const ram = await this.sim.getCartRam(bytes);
        if (!ram || ram.byteLength === 0) {
            return;
        }
        const path = this.saveRamPath(this.loadedSaveSlot);
        let out = new Uint8Array(ram);
        if (this.loadedSaveRamBytes > out.length && await this.storage.exists(path)) {
            // the window is narrower than the file, only when the setting was narrowed: the rest is taken from the
            // file as it stands rather than dropped
            const existing = await this.storage.read(path);
            if (existing.length > out.length) {
                const merged = existing.slice();
                merged.set(out);
                out = merged;
            }
        }
        await this.storage.write(path, out);
        this.loadedSaveRamBytes = out.length;
        this.filledSaveSlots.add(this.loadedSaveSlot);
    }

    // the newest manual state: "put me back where I saved" never means an automatic one; see
    // SaveStateStore.latestManual
    protected refreshSaveStateExists(): void {
        this.state.saveStateExists = this.saveStates.latestManual !== undefined;
        this.update();
    }

    // from the ROM as it came off disk rather than the running image: a state taken with a patch on has to be
    // recognized as this game's with it off
    protected saveStateIdentity(): VesEmulatorSaveStateIdentity | undefined {
        const data = this.rom?.data;
        if (!data || data.length < ROM_HEADER_OFFSET_FROM_END) {
            return undefined;
        }
        const at = data.length - ROM_HEADER_OFFSET_FROM_END;
        const romIdentity = new Uint8Array(32);
        romIdentity.set(data.subarray(at, at + 32));
        return { romIdentity, romSize: this.romSize };
    }

    // looked up when asked rather than held, as the session is rebuilt by a patch switch, a hardware change or a save
    // slot. A linked pair is one state of two machines (see wrapSaveState); either window can take or restore it, and
    // the session carries the restart across
    protected createSaveStateMachine(): SaveStateMachine {
        const host = this;
        return {
            get machineCount(): number {
                return host.isLinked() ? 2 : 1;
            },
            snapshot: async () => {
                if (!this.sim) {
                    return undefined;
                }
                if (this.isLinked()) {
                    const linked = await this.link?.snapshot();
                    return linked ? [linked.p1, linked.p2] : undefined;
                }
                return [await this.sim.saveState()];
            },
            restore: async (states, options) => {
                if (this.isLinked()) {
                    await this.link?.resume(states[0], states[1]);
                } else {
                    await this.sim?.loadState(states[0], options);
                    await this.restoreInput();
                }
            },
            // the same picture as the Continue list (see captureRecentThumbnail), so a row of thumbnails matches
            // whatever mode each state was taken in
            thumbnail: async () => {
                if (!this.sim || !this.state.loaded) {
                    return undefined;
                }
                const png = await this.sim.capture(VB_DEFAULT_DISPLAY_MODE, 1);
                return png ? new Uint8Array(png) : undefined;
            },
            identity: () => this.saveStateIdentity(),
            esSoundSnapshot: () => this.esSound.snapshot(),
            esSoundRestore: snapshot => this.esSound.restore(snapshot as EsSoundSnapshot),
        };
    }

    // always a new one: a state is known by its picture in the browser beside the screen, and its name is whatever the
    // user renames it to
    protected async saveState(kind: SaveStateKind = 'manual'): Promise<void> {
        if (!this.sim || !this.state.loaded) {
            return;
        }
        try {
            const entry = await this.saveStates.create(kind);
            if (entry && kind === 'manual') {
                this.notifications.info(nls.localize(
                    'vueport/state/saved', 'Save state created.'));
            }
        } catch (error) {
            // an automatic state that could not be written is not worth a toast; one the user asked for is
            if (kind === 'manual') {
                this.notifications.error(nls.localize(
                    'vueport/state/saveFailed',
                    'The save state could not be written: {0}',
                    error instanceof Error ? error.message : String(error),
                ));
            }
        }
    }

    // public because the panel calls it: it has the picture pressed, this has the machine, the hardcore rule and the
    // notice
    async loadSaveState(entry: SaveStateEntry): Promise<void> {
        if (!this.sim || !this.state.loaded || this.refuseForHardcore()) {
            return;
        }
        // from the save states beside the screen, which stay usable under the filmstrip
        this.rewindBrowser.abandon();
        try {
            // another ROM's state is warned about rather than refused
            const loaded = await withOtherRomOffer(this.notifications, 'load',
                options => this.saveStates.restore(entry, options));
            if (loaded) {
                this.notifications.info(nls.localize(
                    'vueport/state/loaded', 'Save state loaded.'));
            }
        } catch (error) {
            this.notifications.error(nls.localize(
                'vueport/state/loadFailed',
                'The save state could not be loaded: {0}',
                error instanceof Error ? error.message : String(error),
            ));
        }
    }

    // automatic and suspended

    // a short counting tick rather than a timer set to the interval, as the interval can change mid-game and paused
    // time must not count (a state of a game paused for an hour would push out five useful ones)
    protected autoStateTimer?: ReturnType<typeof setInterval>;
    protected autoStateElapsed = 0; // seconds of running time since the last automatic state
    protected autoStateWriting = false; // held while one is written, so a slow write can't overlap the next tick
    static readonly AUTO_STATE_TICK_SECONDS = 5;

    protected startAutoSaveStates(): void {
        this.stopAutoSaveStates();
        // player two's window is the other end of a cable: the pair is snapshotted as a unit and player one's window
        // keeps the library; see SaveStateMachine
        if (this.player !== 1) {
            return;
        }
        this.autoStateElapsed = 0;
        this.autoStateTimer = setInterval(
            () => { this.tickAutoSaveStates().catch(() => undefined); },
            WebEmulator.AUTO_STATE_TICK_SECONDS * 1000);
    }

    protected stopAutoSaveStates(): void {
        if (this.autoStateTimer !== undefined) {
            clearInterval(this.autoStateTimer);
            this.autoStateTimer = undefined;
        }
    }

    protected async tickAutoSaveStates(): Promise<void> {
        // not in hardcore: a state that cannot be loaded is a file written every minute for nothing
        if (!this.settings.get('autoSaveStatesEnabled') || this.isHardcore()) {
            this.autoStateElapsed = 0;
            return;
        }
        if (!this.state.loaded || this.state.paused || this.autoStateWriting) {
            return;
        }
        this.autoStateElapsed += WebEmulator.AUTO_STATE_TICK_SECONDS;
        if (this.autoStateElapsed < Math.max(10, this.settings.get('autoSaveStateInterval'))) {
            return;
        }
        this.autoStateElapsed = 0;
        this.autoStateWriting = true;
        try {
            await this.saveState('auto');
            await this.saveStates.pruneAuto(Math.max(1, this.settings.get('autoSaveStateCount')));
        } finally {
            this.autoStateWriting = false;
        }
    }

    protected suspendWrittenAt = 0;
    static readonly SUSPEND_MIN_INTERVAL_MS = 5000;

    // written when a ROM is closed and whenever the host says it is going, which in a browser is every page hide (the
    // last moment a write reliably finishes); hence the interval. Closing a ROM passes force
    protected async writeSuspendState(force = false): Promise<void> {
        if (this.player !== 1 || !this.sim || !this.state.loaded) {
            return;
        }
        if (!this.settings.get('suspendResumeEnabled') || this.isHardcore()) {
            return;
        }
        const now = Date.now();
        if (!force && now - this.suspendWrittenAt < WebEmulator.SUSPEND_MIN_INTERVAL_MS) {
            return;
        }
        this.suspendWrittenAt = now;
        await this.saveStates.create('suspend').catch(() => undefined);
    }

    /**
     * Offers the game back where it was left, once, as it opens, as opening is as often "start again" as "carry on".
     * Declining throws the state away; accepting keeps it, so a crash right after still has the moment. With
     * suspendResumeStart `resume` it resumes without asking and keeps the state; `ignore` loads nothing but keeps the
     * state. The resume argument is the library's Resume button, which has already asked: it loads without the prompt
     * whatever the start setting, even with Suspend and Resume switched off since.
     */
    protected async offerToResume(resume = false): Promise<void> {
        const rom = this.rom;
        if (!rom || this.player !== 1 || !(resume || this.settings.get('suspendResumeEnabled'))) {
            return;
        }
        const suspended = this.saveStates.suspended;
        if (!suspended) {
            return;
        }
        // hardcore forbids loading a state, so nothing is offered and the state stays for a non-hardcore session; asked
        // for outright, that is said rather than ignored
        if (resume ? this.refuseForHardcore() : this.isHardcore()) {
            return;
        }
        if (resume) {
            await this.loadSaveState(suspended);
            return;
        }
        const onStart = this.settings.get('suspendResumeStart');
        if (onStart === EmulatorResumeStart.IGNORE) {
            return;
        }
        if (onStart === EmulatorResumeStart.RESUME) {
            await this.loadSaveState(suspended);
            return;
        }
        const agreed = await this.notifications.confirm({
            title: nls.localize('vueport/state/resumeTitle', 'Resume Where You Left Off?'),
            message: nls.localize(
                'vueport/state/resumeMessage',
                'VUEPort saved this game when you last closed it. Resume from there, or start '
                + 'the game from the beginning? Starting fresh discards the saved moment; your '
                + 'cartridge save and your own save states are untouched either way.',
            ),
            okLabel: nls.localize('vueport/state/resumeConfirm', 'Resume'),
        });
        // the ROM may have been closed or swapped while the question was up
        if (this.rom !== rom || !this.state.loaded) {
            return;
        }
        if (!agreed) {
            await this.saveStates.clearSuspended();
            return;
        }
        await this.loadSaveState(suspended);
    }

    // filed with the game's other states, so it can be loaded again later, then loaded. Taken as this game's even if
    // the header differs, as it came with the ROM it was made with
    protected async continueFromState(bytes: Uint8Array): Promise<void> {
        if (this.refuseForHardcore()) {
            return;
        }
        try {
            const entry = await this.saveStates.importState('shared.state', bytes, { otherRom: true });
            if (entry) {
                this.rewindBrowser.abandon();
                await this.saveStates.restore(entry, { otherRom: true });
                this.notifications.info(nls.localize('vueport/state/loaded', 'Save state loaded.'));
            }
        } catch (error) {
            this.notifications.error(nls.localize(
                'vueport/state/loadFailed',
                'The save state could not be loaded: {0}',
                error instanceof Error ? error.message : String(error),
            ));
        }
    }

    // what the Load State key does: the newest manual state
    protected async loadState(): Promise<void> {
        if (!this.sim || this.refuseForHardcore()) {
            return;
        }
        const entry = this.saveStates.latestManual;
        if (!entry) {
            this.notifications.warn(nls.localize(
                'vueport/state/none', 'This game has no save state to load.'));
            return;
        }
        await this.loadSaveState(entry);
    }

    // `<rom>-YYMMDD-HHMMSS`, the stem the screenshot and the profile share
    protected exportStem(): string {
        const now = new Date();
        const pad = (value: number): string => `${value}`.padStart(2, '0');
        const timestamp = `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
            + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        return `${this.rom ? this.storage.stem(this.rom.name) : 'vueport'}-${timestamp}`;
    }

    protected async takeScreenshot(): Promise<void> {
        // the scale applies either way, as in the Video pane: the live drawing buffer a shot borrows is the mode's own
        // size, not the displayed size
        const mode = this.getScreenshotMode();
        const png = await this.sim?.capture(mode, this.settings.get('screenshotScale'));
        if (!png) {
            return;
        }
        const filename = `${this.exportStem()}.png`;
        // export rather than write: a screenshot is for the player, so on the web it becomes a download
        await this.storage.export(filename, new Uint8Array(png));
        this.notifications.info(nls.localize(
            'vueport/screenshot/saved', 'Screenshot saved as {0}.', filename));
    }

    // video recording

    get recordingVideo(): boolean {
        return this.videoRecorder !== undefined;
    }

    // a bound function rather than a getter, as the badge keeps its own clock (see EmulatorToolbarHost.recordedSeconds)
    recordedSeconds = (): number => this.videoRecorder?.seconds ?? 0;

    // one command for both, reached for by the same key twice while playing. Records the machine's picture and sound
    // plus ESSound (see VideoRecorder), never what the interface draws over the picture
    async toggleVideoRecording(): Promise<void> {
        if (this.videoRecorder) {
            await this.finishVideoRecording();
            return;
        }
        if (!this.core || !this.sim || !this.state.loaded) {
            return;
        }
        if (!VideoRecorder.isSupported()) {
            this.notifications.warn(nls.localize('vueport/video/unsupported',
                'This browser cannot record video.'));
            return;
        }
        try {
            this.videoRecorder = await VideoRecorder.start({
                core: this.core,
                sim: this.sim,
                // always handed over; the recorder decides whether there is anything to mix in
                esSound: this.esSound,
                mode: this.getVideoMode(),
                scale: this.settings.get('videoScale'),
                quality: this.settings.get('videoQuality'),
                format: this.settings.get('videoFormat'),
            });
            // an encoder that gives up stops on the spot, so without this the record light would keep burning; what was
            // encoded before is still saved
            this.videoRecorderFailure = this.videoRecorder.onDidFail(reason => {
                this.notifications.error(nls.localize('vueport/video/failed',
                    'The video recording stopped: this browser could not encode it ({0}).',
                    reason));
                this.finishVideoRecording().catch(() => undefined);
            });
            // a recording started while paused holds from the first moment
            this.videoRecorder.setPaused(this.state.paused);
            this.notifications.info(nls.localize('vueport/video/started',
                'Recording video. Press again to stop and save it.'));
        } catch (error) {
            this.videoRecorder = undefined;
            this.onError(error instanceof Error ? error.message : String(error));
        }
        this.update();
    }

    // the recorder is let go before the file is assembled, so the badge stops while a long recording is still being
    // put together, and a failure on the way out cannot leave the emulator believing it still records
    protected async finishVideoRecording(): Promise<void> {
        const recorder = this.videoRecorder;
        if (!recorder) {
            return;
        }
        this.videoRecorder = undefined;
        this.videoRecorderFailure?.dispose();
        this.videoRecorderFailure = undefined;
        this.update();
        try {
            const recording = await recorder.stop();
            if (recording.blob.size === 0) {
                this.notifications.warn(nls.localize('vueport/video/empty',
                    'Nothing was recorded.'));
                return;
            }
            const filename = `${this.exportStem()}.${recording.extension}`;
            // export rather than write: a download in the browser, a real file in the downloads folder on the desktop
            if (this.storage.exportBlob) {
                await this.storage.exportBlob(filename, recording.blob);
            } else {
                await this.storage.export(
                    filename, new Uint8Array(await recording.blob.arrayBuffer()));
            }
            this.notifications.info(nls.localize('vueport/video/saved',
                'Video saved as {0} — {1} at {2} MB.',
                filename,
                formatVideoDuration(recording.seconds),
                (recording.blob.size / 1_000_000).toFixed(1)));
            // said only when it happened: the file is in the other container from the one asked for
            if (recording.failure) {
                this.notifications.warn(nls.localize('vueport/video/partial',
                    'It ends where the encoder gave up ({0}).', recording.failure));
            }
        } catch (error) {
            this.onError(error instanceof Error ? error.message : String(error));
        }
    }

    // the recording is the same as Rewind's and costs the same while it runs, which a confirm says. Stopping replays
    // it through the core into a call tree, downloaded as a Firefox Profiler file; with no ELF, frames are addresses
    toggleProfiling = async (): Promise<void> => {
        if (!this.sim) {
            return;
        }
        if (this.profiling) {
            this.profiling = false;
            this.onDidChangeEmitter.fire();
            this.notifications.info(nls.localize(
                'vueport/debug/panels/profiler/profile/replaying', 'Replaying the recording…'));
            try {
                const recording = await this.sim.stopProfileRecording();
                const result = await this.sim.replayProfile(recording);
                const stem = this.exportStem();
                const json = JSON.stringify(firefoxProfileFrom(result,
                    this.rom ? this.storage.stem(this.rom.name) : 'vueport'));
                await this.storage.export(`${stem}.json`, new TextEncoder().encode(json));
                this.notifications.info(nls.localize('vueport/debug/panels/profiler/profile/saved',
                    'Profile saved as {0}.json — {1} instructions. Open it at profiler.firefox.com.',
                    stem, result.instructions.toLocaleString()));
            } catch (error) {
                this.onError(error instanceof Error ? error.message : String(error));
            }
            return;
        }
        const confirmed = await this.notifications.confirm({
            title: nls.localize('vueport/debug/panels/profiler/profile/title', 'Start Profiling?'),
            message: nls.localize('vueport/debug/panels/profiler/profile/cost',
                'The emulator records what runs on every frame, the same as Rewind — '
                + 'roughly a third more expensive while it lasts. Stop it to save the profile.'),
            okLabel: nls.localize('vueport/debug/panels/profiler/profile/start', 'Start'),
        });
        if (!confirmed) {
            return;
        }
        try {
            await this.sim.startProfileRecording();
            this.profiling = true;
            this.onDidChangeEmitter.fire();
        } catch (error) {
            this.onError(error instanceof Error ? error.message : String(error));
        }
    };

    // settings

    protected applyScale(): void {
        this.dock.screen.setScale(this.settings.get('scale'));
    }

    // low: the halo is blurred past reading any frame, so reading the framebuffer more often buys nothing
    protected static readonly DECORATION_POLL_MS = 160;

    // only in Play mode, for the picture filling the screen, not one tile among the debug panels, and only with a ROM.
    // The exception is the Display pane, whose preview borrows the picture with the decoration while open
    protected applyDecoration(): void {
        const previewing = this.settingsTab === 'display';
        const playing = (this.state.mode === EmulatorMode.PLAY && this.hasRom) || previewing;
        const choice = playing ? this.settings.get('decoration') : EmulatorDecoration.NONE;

        const intensity = Math.max(0, Math.min(this.settings.get('decorationIntensity'), 100)) / 100;
        let spec: EmulatorDecorationSpec | undefined;
        if (choice === EmulatorDecoration.BLACK) {
            spec = { kind: 'black' };
        } else if (choice === EmulatorDecoration.AMBIENT) {
            // the same call the Display pane's color well shows while From Palette is on, so the two cannot drift apart
            const color = this.settings.get('decorationColorFromPalette')
                ? paletteDecorationColor(
                    this.getRenderingMode(), this.getPalette(), this.vbcHardwareActive)
                : this.settings.get('decorationColor');
            spec = { kind: 'ambient', color, intensity };
        } else if (choice === EmulatorDecoration.IMMERSION) {
            spec = { kind: 'immersion', intensity };
        }
        this.dock.screen.setDecoration(spec);

        const sampling = spec?.kind === 'immersion' && this.state.loaded;
        if (sampling && this.decorationTimer === undefined) {
            this.decorationTimer = setInterval(
                () => this.sampleDecoration(), WebEmulator.DECORATION_POLL_MS);
        } else if (!sampling && this.decorationTimer !== undefined) {
            clearInterval(this.decorationTimer);
            this.decorationTimer = undefined;
        }
    }

    // the 16x10 grid rather than the frame: 640 bytes a tick instead of the 344 kB framebuffer
    protected async sampleDecoration(): Promise<void> {
        // nobody sees the halo while the game is in a headset, and the worker blends a whole frame for every sample:
        // on the Quest that is time the emulation runs short of once the headset throttles
        if (this.decorationSampling || !this.sim || this.state.paused || this.xrActive) {
            return;
        }
        this.decorationSampling = true;
        try {
            const grid = await this.sim.readBackdrop(BACKDROP_COLUMNS, BACKDROP_ROWS);
            this.dock.screen.pushBackdrop(
                grid.pixels, BACKDROP_COLUMNS, BACKDROP_ROWS, grid.colorMode);
        } catch {
            // a read that failed is a frame the halo does not get; the next tick tries again
        } finally {
            this.decorationSampling = false;
        }
    }

    protected async onSettingChanged(key: string): Promise<void> {
        if (key === 'hardwareMode' || key === 'vbcSupportEnabled') {
            // the hardware model and the global VBC gate are power-on choices, not live VBCEN bits. A running link
            // owns a mirror inside the current worker, so it is torn down first, or the LinkSession schedules against
            // a disposed sim
            const wasLinked = this.isLinked();
            this.link?.release();
            if (wasLinked) {
                this.notifications.info(nls.localize(
                    'vueport/vbColor/hardware/linkEnded',
                    'The link session ended because the hardware configuration changed.'
                ));
            }

            // recreate the session so every subsystem starts from the selected machine's cold reset state; a new link
            // session clones that model onto its mirror
            if (this.hasRom) {
                await this.restartMachine();
            }
            // after the restart: the color-only debugger surfaces key off the running machine, still the old one
            // until then
            this.dock.setVbcSupportEnabled(this.vbcSupportEnabled, this.vbcHardwareActive);
        } else if (key === 'scale') {
            this.applyScale();
        } else if (key === 'renderingMode' || key === 'swapEyes' || key === 'palette' || key === 'anaglyphPalette'
            || key === 'customPalettes' || key === 'customAnaglyphPalettes' || key === 'frameBlending') {
            const mode = this.getDisplayMode();
            this.dock.screen.setDisplayMode(mode);
            this.xr.setDisplayMode(mode);
            await this.sim?.setDisplayMode(mode);
            // an Ambient halo set to From Palette takes its color from these too; see paletteDecorationColor
            this.applyDecoration();
        } else if (key === 'stereoDepth') {
            await this.applyStereoDepth();
        } else if (key === 'columnTable') {
            await this.core?.setColumnGeometry(this.settings.get('columnTable'));
        } else if (key === 'mirrorSpinUp' || key === 'mirrorSpinUpDelay') {
            await this.core?.setMirrorSpinUp(this.settings.get('mirrorSpinUp'), this.settings.get('mirrorSpinUpDelay'));
        } else if (key === 'rewindEnabled' || key === 'rewindGranularity' || key === 'rewindBufferSize') {
            await this.applyRewindSettings();
        } else if (key === 'retroAchievementsHardcore') {
            // leaving hardcore lets rewind come back (entering already stopped it); the engine flag is the service's
            // to push
            await this.applyRewindSettings();
        } else if (key === 'retroAchievementsEnabled') {
            await this.retroAchievements.enabledChanged();
        } else if (key === 'fastForwardRatio' || key === 'slowMotionRatio') {
            await this.time.applySpeed();
        } else if (key === 'saveGameSlot') {
            await this.applySaveGameSlot();
        } else if (key === 'player2SameControls') {
            this.input.refreshBindings();
        } else if (key === 'turboRate') {
            await this.input.applyTurbo();
        } else if (key === 'gamepadProfiles' || key === 'gamepadPlayers') {
            // the resolver caches a profile per device; dropped here as well as in refreshBindings, as a setting can
            // change without the input settings (the desktop shell reloading its config)
            this.gamepadResolver.invalidate();
        } else if (key === 'decoration' || key === 'decorationColor'
            || key === 'decorationColorFromPalette' || key === 'decorationIntensity') {
            this.applyDecoration();
        }
        this.update();
    }

    // worker-wide, so a link session's mirror is drawn at the same depth as the machine beside it
    protected async applyStereoDepth(): Promise<void> {
        // the still in the Display preview too, which no core draws
        this.dock.screen.setStereoDepth(this.settings.get('stereoDepth'));
        // in a headset, the headset's own: perceived depth depends on the picture's size, and there it is big
        await this.core?.setStereoDepth(this.xr.stereoDepth(this.settings.get('stereoDepth')));
    }

    // a save slot is a cartridge, read at boot, so the machine is stopped (writing the RAM back to its old slot) and
    // started again on the new one, like a hardware change. Without a game the setting just applies to the next ROM
    protected async applySaveGameSlot(): Promise<void> {
        if (!this.hasRom || !this.state.loaded) {
            return;
        }
        // a link session owns a mirror inside the worker about to be replaced, so it ends first, and the other player
        // is told rather than their machine simply stopping
        const wasLinked = this.isLinked();
        this.link?.release();
        if (wasLinked) {
            this.notifications.info(nls.localize(
                'vueport/saveSlot/linkEnded',
                'The link session ended because the save game slot changed.'));
        }
        await this.restartMachine();
        this.notifications.info(nls.localize(
            'vueport/saveSlot/switched', 'Now playing on save game slot {0}.', this.saveGameSlot));
    }

    // for a change that cannot be made to a running machine (a patch, the hardware model, the save slot). Like the
    // reset button the game then runs, paused or not: pausing again left the first frame standing with the audio clock,
    // under a "Click to play" prompt
    protected async restartMachine(): Promise<void> {
        await this.stop();
        await this.start();
        this.update();
    }

    protected restartForPatchChange(): void {
        this.patchConfigurationChange = this.patchConfigurationChange
            .then(async () => {
                if (!this.rom || !this.state.loaded || this.isDisposed) {
                    return;
                }
                await this.restartMachine();
            })
            .catch(error => this.notifications.error(nls.localize(
                'vueport/patches/restartFailed',
                'The emulator could not restart with the selected patches: {0}',
                error instanceof Error ? error.message : String(error),
            )));
    }

    // target is the tab group whose "+" was pressed: an open panel moves into it, otherwise it is focused where it is.
    // The screen is left out, as it is always there
    async pickPanel(target?: TabBar<Widget>): Promise<void> {
        const openDescription = target
            ? nls.localize('vueport/debug/panels/moveHere', 'Move here')
            : nls.localize('vueport/debug/panels/alreadyOpen', 'Already open');
        const available: PickItem[] = [];
        const open: PickItem[] = [];

        // grouped by the family a panel's tab names, as twenty names in a row read as a wall of text
        for (const category of EMULATOR_PANEL_CATEGORIES) {
            // Color mode's own panels are only offered there
            const types = category.id === EmulatorPanelCategory.COLOR
                ? this.state.mode === EmulatorMode.COLOR ? EMULATOR_COLOR_PANEL_TYPES : []
                : EMULATOR_PANEL_TYPES;
            const inCategory = types
                .filter(type => type !== EmulatorPanelType.SCREEN
                    && emulatorPanelCategory(type).id === category.id)
                // by translated label rather than key, so alphabetical follows the shown language
                .sort((a, b) => emulatorPanelLabel(a).localeCompare(emulatorPanelLabel(b)));
            const openHere: PickItem[] = [];
            const availableHere: PickItem[] = [];
            inCategory.forEach(type => {
                const item: PickItem = { id: type, label: emulatorPanelLabel(type), icon: emulatorPanelIcon(type) };
                if (this.dock.isPanelOpen(type)) {
                    openHere.push({ ...item, description: openDescription });
                } else {
                    availableHere.push(item);
                }
            });
            if (availableHere.length > 0) {
                available.push(
                    { id: `category-${category.id}`, label: category.label(), separator: true },
                    ...availableHere,
                );
            }
            open.push(...openHere);
        }

        if (open.length > 0) {
            available.push({
                id: 'already-open',
                label: nls.localize('vueport/debug/panels/alreadyOpen', 'Already open'),
                separator: true,
            }, ...open);
        }

        const picked = await this.ui.pick(
            nls.localize('vueport/debug/panels/select', 'Select a panel to open…'), available);
        if (!picked) {
            return;
        }

        /**
         * Panels belong to Debug and Color mode: Play mode hides tab bars and doesn't remember its arrangement, so a
         * panel added there would have no tab to close it and be lost at the next mode change. Switched after the
         * choice, so backing out leaves the mode alone. Cheats, macros, patches and achievements aren't panels in
         * either mode; each has its own title bar button and shows beside the screen.
         */
        if (this.state.mode === EmulatorMode.PLAY) {
            if (this.isHardcore()) {
                // let the ordinary mode transition explain itself, but open no panel if it refuses
                this.setMode(EmulatorMode.DEBUG);
                return;
            }
            this.setMode(EmulatorMode.DEBUG);
        }

        const kind = picked.id as EmulatorPanelType;
        if (target) {
            this.dock.addPanelTo(kind, target);
        } else {
            this.dock.togglePanel(kind);
        }
        this.update();
    }

    // the picker is made and dropped here, like the ROM chooser; see pickInPage in app.tsx for why it is attached to
    // the document before it is clicked
    async pickMovie(): Promise<void> {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.mc2';
        input.style.display = 'none';
        document.body.appendChild(input);
        const finish = (): void => input.remove();
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            finish();
            if (file) {
                this.playMovie(file).catch(error => this.onError(String(error)));
            }
        });
        input.addEventListener('cancel', finish);
        input.click();
    }

    // reset first: a published run is only a list of buttons and reproduces anything only from the author's start
    // state; mid-game it looks like a broken movie
    async playMovie(file: File): Promise<void> {
        const text = await file.text();
        if (!looksLikeVesMovie(text)) {
            this.notifications.error(nls.localize(
                'vueport/movie/notAMovie',
                '{0} is not a VBjin input movie.', file.name));
            return;
        }
        const movie = parseVesMovie(text);
        if (movie.frames.length === 0) {
            this.notifications.error(nls.localize(
                'vueport/movie/empty', '{0} has no frames in it.', file.name));
            return;
        }
        const sim = this.sim;
        if (!sim) {
            return;
        }
        // a movie feeds its own input past the session feeding the players', and starts by resetting one machine alone
        if (this.refuseWhileLinked(nls.localize('vueport/link/movieLocked',
            'Movies cannot be played while linked. Unlink first.'))) {
            return;
        }
        await this.resetSim();
        await this.moviePlayer.start(sim, movie);
        this.notifications.info(nls.localize(
            'vueport/movie/playing',
            'Playing {0}: {1} frames recorded with {2}. Note that a run only reproduces exactly on the \
emulator core it was made on.',
            file.name, String(movie.frames.length), movie.emulator || 'an unknown emulator'));
        this.update();
    }

    async stopMovie(): Promise<void> {
        await this.moviePlayer.stop();
        this.update();
    }

    // named after the ROM and the slot, as the kept file's OPFS path means nothing outside; .sram is what every other
    // VB emulator calls it
    async exportSaveData(): Promise<void> {
        const rom = this.rom;
        if (!rom) {
            return;
        }
        // written out first: cartridge RAM only reaches the file when the machine stops
        if (this.sim && this.state.loaded) {
            await this.saveSaveRam().catch(() => undefined);
        }
        const path = this.saveRamPath();
        if (!await this.storage.exists(path)) {
            // only before a machine has ever run on this slot; whether the game wrote anything worth keeping cannot
            // be told, as cartridge RAM comes up random by default
            this.notifications.warn(nls.localize(
                'vueport/saveRam/none',
                'Nothing has run on save game slot {0} yet.', this.saveGameSlot));
            return;
        }
        const data = await this.storage.read(path);
        const slot = this.saveGameSlot;
        const suffix = slot === DEFAULT_SAVE_SLOT ? '' : `.${slot}`;
        // named as EmulatorCompanionFiles.saveRam names it, player and all, as a linked pair's two cartridges land in
        // the same downloads folder
        await this.storage.export(
            `${this.storage.stem(rom.name)}.p${this.player}${suffix}.sram`, data);
    }

    // restarted rather than applied live: cartridge RAM is read when a machine starts and written when it stops, so a
    // file swapped under a running game would be overwritten
    async importSaveData(file: File): Promise<void> {
        const rom = this.rom;
        if (!rom || !this.state.loaded) {
            return;
        }
        const data = new Uint8Array(await file.arrayBuffer());
        const agreed = await this.notifications.confirm({
            title: nls.localize('vueport/saveRam/importTitle', 'Import Save Data'),
            message: nls.localize(
                'vueport/saveRam/importConfirm',
                'Put {0} on save game slot {1} and restart? Whatever is saved on that slot now will be replaced; the other slots are untouched.', file.name, this.saveGameSlot),
        });
        if (!agreed) {
            return;
        }
        await this.stop();
        await this.storage.write(this.saveRamPath(), data);
        this.filledSaveSlots.add(this.saveGameSlot);
        await this.reopenRom(rom);
        this.notifications.info(nls.localize(
            'vueport/saveRam/imported', 'Imported {0}.', file.name));
    }

    // the command-palette shortcut for "the one I just made"; every state in the browser has an Export of its own
    async exportSaveState(): Promise<void> {
        const entry = this.saveStates.latestManual;
        if (!entry) {
            this.notifications.warn(nls.localize(
                'vueport/state/none', 'This game has no save state to load.'));
            return;
        }
        await this.saveStates.exportState(entry);
    }

    // take one back in, as a state of this game, without disturbing the machine
    async importSaveState(file: File): Promise<void> {
        if (!this.rom) {
            return;
        }
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const imported = await withOtherRomOffer(this.notifications, 'import',
                options => this.saveStates.importState(file.name, bytes, options));
            if (imported) {
                this.notifications.info(nls.localize(
                    'vueport/state/imported',
                    'Imported {0}. Load it from the Save States panel.',
                    file.name,
                ));
            }
        } catch (error) {
            this.notifications.error(nls.localize(
                'vueport/state/importFailed',
                '{0} could not be imported: {1}',
                file.name,
                error instanceof Error ? error.message : String(error),
            ));
        }
    }

    pickSaveData(): void {
        this.pickFile('.sram,.srm,.sav', file => this.importSaveData(file));
    }

    pickSaveState(): void {
        this.pickFile('.state', file => this.importSaveState(file));
    }

    protected pickFile(accept: string, then: (file: File) => Promise<void>): void {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.style.display = 'none';
        document.body.appendChild(input);
        const finish = (): void => input.remove();
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            finish();
            if (file) {
                then(file).catch(error => this.onError(String(error)));
            }
        });
        input.addEventListener('cancel', finish);
        input.click();
    }

    // only the file of saveGameSlot is deleted (a slot is a cartridge, see saveRamPath). Ordered: stopping writes cart
    // RAM out, so the file goes after the machine has ended, or it would be written straight back
    async deleteSaveSlotAndRestart(): Promise<void> {
        const rom = this.rom;
        if (!rom || !this.state.loaded) {
            return;
        }
        const slot = this.saveGameSlot;
        const agreed = await this.notifications.confirm({
            title: nls.localize('vueport/saveSlot/delete', 'Delete Current Save Game Slot'),
            // which save is about to go, when it is not simply "the" save
            message: slot === DEFAULT_SAVE_SLOT
                ? nls.localize('vueport/saveSlot/deleteConfirm',
                    'Are you sure you want to delete the current save game slot and restart? \
Any progress saved on it will be lost.')
                : nls.localize('vueport/saveSlot/deleteNamedConfirm',
                    'Are you sure you want to delete save game slot {0} and restart? \
Any progress saved on that slot will be lost; the other slots are untouched.', slot),
        });
        if (!agreed) {
            return;
        }

        await this.stop();
        const path = this.saveRamPath();
        if (await this.storage.exists(path)) {
            await this.storage.delete(path);
        }
        this.filledSaveSlots.delete(slot);
        await this.reopenRom(rom);
    }

    // the command palette's route to the dialog's Reset All button; says so when there is nothing to reset
    async confirmResetAllSettings(): Promise<void> {
        const { resettableSettings } = await import('./web-settings-dialog');
        const keys = resettableSettings();
        if (modifiedSettings(this.settings, keys).length === 0) {
            this.notifications.info(nls.localize('vueport/settings/resetAll/none', 'All settings already have their defaults.'));
            return;
        }
        if (await this.notifications.confirm(resetAllSettingsConfirmation())) {
            await resetSettings(this.settings, keys);
        }
    }

    async confirmResetLayout(): Promise<void> {
        // the wording is the emulator's own, so both hosts ask in the same translated words
        const agreed = await this.notifications.confirm(resetLayoutConfirmation());
        if (!agreed) {
            return;
        }
        this.dock.resetLayout();
        this.persistDockLayout();
        this.update();
    }

    // both halves, as one page changes both: the keymap and the resolved game pad profiles, whose per-device cache
    // hides an edit from the input loop until dropped
    refreshBindings(): void {
        this.input.refreshBindings();
        this.gamepadResolver.invalidate();
        this.update();
    }

    resetBindings(): void {
        if (this.bindings instanceof WebBindings) {
            this.bindings.resetToDefaults();
        }
        this.refreshBindings();
    }

    // the screen's own node is passed separately from the root, which tells a click on the picture from one on a panel
    attachInput(node: HTMLElement): void {
        this.input.refreshBindings();
        this.input.attach(node, this.dock.screen.node);
    }

    dispose(): void {
        this.isDisposed = true;
        if (this.decorationTimer !== undefined) {
            clearInterval(this.decorationTimer);
            this.decorationTimer = undefined;
        }
        this.clearRecentThumbnail();
        if (this.player === 1) {
            this.playTimes.ended();
        }
        this.stop().catch(() => undefined);
        this.input.setMacroHook(undefined);
        this.macros.dispose();
        this.patches.dispose();
        this.colorEditor.dispose();
        this.input.dispose();
        this.toDispose.dispose();
        this.onDidChangeEmitter.dispose();
    }
}
