import * as React from 'react';
import { Emulator } from 'vueport-core/lib/browser/components/Emulator';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { EmulatorCommands } from 'vueport-core/lib/browser/emulator-commands';
import { Plugs } from '@phosphor-icons/react';
import { WebCommandContext, openCommandPalette } from './web-commands';
import { steerPaletteWithGamepad } from './web-gamepad-palette';
import { WebXrCover } from './web-xr-cover';
import { WebEmulator } from './web-emulator';
import {
    ChooseEntry,
    ROM_EXTENSIONS,
    RomChoiceCanceled, RomSound, RomSourceError,
    isRom, isVbArchive, isZip, romFrom,
} from './web-rom-source';
import { RomUrlError, fetchRom, parseRomUrl, romUrlFrom, stateUrlFrom } from './web-rom-url';
import { HomebrewGame, HomebrewRom, homebrewRomUrl, withHomebrewDetail } from './web-homebrew';
import { RecentRom, RecentRoms, recentName } from './web-recent-roms';
import { looksLikeZip } from './web-zip';
import { onDidChangeMaxRecent } from './web-recent-limit';
import { LinkController, readInvitation } from './web-link';
import WebStatusBar from './web-status-bar';
import WebTitleBar from './web-title-bar';
import { WebUi, WebUiOverlay } from './web-ui';
import { Library } from './web-library';
import { LibraryEntry, LibraryFile } from './web-library-types';
import { LibraryScreen } from './web-library-view';
import { startsWithLastGame } from './web-auto-start';
import { pushBackHandler } from 'vueport-core/lib/browser/back-navigation';
import { watchEdgeSwipes } from './web-edge-swipes';
import { setLibraryDrawer, useLibraryDrawer } from './web-library-drawer';

// .vb.zip is not listed, as .zip covers it and the desktop's native panel only takes single-segment extensions
const OPENABLE_EXTENSIONS = [...ROM_EXTENSIONS, '.vbz', '.zip'];

/**
 * The game the other player's window is playing. That window put it in the recent-games store before opening this
 * one, but a cartridge is up to 16 MB, so the store is polled for a few seconds, re-reading the whole entry each time
 * as the index line arrives together with the file. Resolves undefined when the window was torn down or the game never
 * turned up; the caller reports that and leaves the library on screen.
 */
async function waitForSharedGame(
    recents: RecentRoms, id: string, signal: AbortSignal,
): Promise<{ rom: RecentRom, data: Uint8Array } | undefined> {
    const deadline = Date.now() + 5000;
    for (;;) {
        const rom = (await recents.list()).find(entry => entry.id === id);
        const data = rom && await recents.data(rom);
        if (rom && data) {
            return { rom, data };
        }
        if (signal.aborted || Date.now() >= deadline) {
            return undefined;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

// the second player's window while the first player, who invited from their library, is still choosing a game.
// See LobbyMessage in web-link.ts
function LinkLobbyScreen(props: { onCancel(): void }): React.JSX.Element {
    return <div className='vp-link-lobby'>
        <Plugs size={48} />
        <div className='vp-link-lobby-title'>
            <span className='vp-spinner' />
            {nls.localize('vueport/link/waitingForGame', 'Waiting for Player 1 to start game')}
        </div>
        <button className='vp-button' onClick={props.onCancel}>
            {nls.localize('vueport/commands/link/cancel', 'Cancel Link')}
        </button>
    </div>;
}

// the emulator, plus a way to open a ROM, which the studio gets from its workspace
export function App(props: {
    emulator: WebEmulator,
    link: LinkController,
    ui: WebUi,
    recents: RecentRoms,
    library: Library,
    // --continue on the desktop: the "Auto start last recent game" behaviour for this run, whatever the setting says
    continueLastGame?: boolean,
}): React.JSX.Element {
    const { emulator, link, ui, recents, library, continueLastGame } = props;

    React.useSyncExternalStore(
        React.useCallback(listener => {
            const subscription = emulator.onStateChanged(listener);
            return () => subscription.dispose();
        }, [emulator]),
        React.useCallback(() => emulator.version, [emulator]),
    );

    React.useEffect(() => {
        const subscription = link.onDidChange(() => setLinkNonce(n => n + 1));
        return () => subscription.dispose();
    }, [link]);
    const [, setLinkNonce] = React.useState(0);

    const root = React.useRef<HTMLDivElement>(null);
    const screen = React.useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = React.useState(false);
    const [attached, setAttached] = React.useState(false);

    React.useEffect(() => setAttached(true), []);

    React.useEffect(() => {
        if (screen.current && attached) {
            emulator.attachInput(screen.current);
        }
    }, [emulator, attached]);

    // the application's own picker, as used for the debug panels, so an archive of a whole collection is usable
    const chooseEntry = React.useCallback<ChooseEntry>(async names => {
        const chosen = await ui.pick(
            nls.localize('vueport/rom/which', 'Which ROM?'),
            names.map(name => ({ id: name, label: name })),
        );
        return chosen?.id;
    }, [ui]);

    /**
     * `location` is where the file is, when the opener knows, which decides whether the save can be kept beside it.
     * This holds for an archive too, as its folder is where saves belong and a recent entry reads the archive again
     * (see CompanionRom.location). `state` is a save state file to continue from, see WebEmulator.openRom. `archive`
     * names the archive the bytes came out of where `name` no longer does, as a recent entry keeps the ROM, not the
     * archive. `sounds` are the ESSound tracks that came with them, as the library reads the ROM out of an archive
     * itself.
     */
    const openData = React.useCallback(async (
        name: string, data: Uint8Array, location?: string, url?: string, resume?: boolean, state?: Uint8Array,
        archive?: string, sounds?: RomSound[],
    ) => {
        const rom = await romFrom(name, data, chooseEntry);
        const from = archive ?? (looksLikeZip(data) && rom.name !== name ? name : undefined);
        await emulator.openRom(rom.name, rom.data, sounds ?? rom.sounds, location,
            url || from ? { url, archive: from } : undefined,
            { resume, state });
    }, [emulator, chooseEntry]);

    // re-read whenever the start page comes back into view, as the ROM just closed is the newest entry
    const [recentList, setRecentList] = React.useState<RecentRom[]>([]);
    const refreshRecents = React.useCallback(() => {
        recents.list().then(setRecentList).catch(() => setRecentList([]));
    }, [recents]);
    React.useEffect(() => {
        if (!emulator.hasRom) {
            refreshRecents();
        }
    }, [emulator.hasRom, refreshRecents]);

    // a lowered limit shrinks the list and its storage right away, see RecentRoms.enforceLimit
    React.useEffect(() => {
        const subscription = onDidChangeMaxRecent(() => {
            recents.enforceLimit().then(refreshRecents).catch(() => undefined);
        });
        return () => subscription.dispose();
    }, [recents, refreshRecents]);

    const openUrl = React.useCallback(async (raw: string) => {
        let progress: { cancel(): void } | undefined;
        try {
            const url = parseRomUrl(raw);
            if (!url) {
                return;
            }
            progress = ui.progress(nls.localize('vueport/rom/downloading', 'Downloading ROM…'));
            const downloaded = await fetchRom(url);
            await openData(downloaded.name, downloaded.data, undefined, url.href);
        } catch (error) {
            if (error instanceof RomChoiceCanceled) {
                return;
            }
            ui.toast('error',
                error instanceof RomUrlError || error instanceof RomSourceError
                    ? error.message
                    : nls.localize('vueport/url/romFailed',
                        'The ROM in the address could not be opened: {0}', String(error)));
            throw error;
        } finally {
            progress?.cancel();
        }
    }, [openData, ui]);

    const openRecent = React.useCallback(async (rom: RecentRom) => {
        try {
            const data = await recents.data(rom);
            if (!data) {
                // two different absences, two sentences: a copy VUEPort kept is gone, or the linked file (moved,
                // deleted, unplugged, in a forgotten folder). See web-recent-origins.ts
                ui.toast('warn', rom.linked
                    ? nls.localize('vueport/welcome/recentUnreachable',
                        '{0} could not be read where it was played from — open the file again.',
                        recentName(rom))
                    : nls.localize('vueport/welcome/recentGone',
                        '{0} is no longer stored — choose the file again.', recentName(rom)));
                refreshRecents();
                return;
            }
            // played from where it lives while the shell still recognizes the file, which puts the save beside the ROM
            // and finds ESSound tracks and the build in its folder. A moved ROM, or one from a browser, plays from the
            // kept copy
            const { reopenFile } = await import('./desktop-open');
            const location = rom.location && await reopenFile(rom.location)
                ? rom.location
                : undefined;
            await openData(rom.name, data, location, rom.url, undefined, undefined, rom.archive);
        } catch (error) {
            if (!(error instanceof RomChoiceCanceled)) {
                ui.toast('error', error instanceof RomSourceError
                    ? error.message
                    : nls.localize('vueport/rom/openFailed', '{0} could not be opened: {1}',
                        recentName(rom), String(error)));
            }
        }
    }, [recents, openData, refreshRecents, ui]);

    // the bytes come from the remembered file on the user's disk rather than a copy, so a save lands beside it. An
    // unreadable folder says so here; resume skips the question offerToResume would ask
    const playFromLibrary = React.useCallback((entry: LibraryEntry, file?: LibraryFile, resume?: boolean) => {
        (async () => {
            try {
                const rom = await library.read(entry.id, file);
                await openData(rom.name, rom.data, rom.location, undefined, resume, undefined, rom.archive, rom.sounds);
            } catch (error) {
                if (error instanceof RomChoiceCanceled) {
                    return;
                }
                ui.toast('error', error instanceof RomSourceError || error instanceof Error
                    ? nls.localize('vueport/library/playFailed', '{0} could not be opened: {1}',
                        file?.name ?? entry.header.name, error.message)
                    : String(error));
            }
        })().catch(() => undefined);
    }, [library, openData, ui]);

    // read from where it lives and handed over as it is on disk, without starting it; see WebEmulator.shareFromLibrary.
    // Only where this computer can serve a share (VUEPort Desktop)
    const shareFromLibrary = React.useCallback((entry: LibraryEntry, title: string) => {
        (async () => {
            try {
                const rom = await library.read(entry.id);
                await emulator.shareFromLibrary(rom.name, rom.data, title);
            } catch (error) {
                ui.toast('error', nls.localize('vueport/vr/share/failed', 'The game could not be shared: {0}',
                    error instanceof Error ? error.message : String(error)));
            }
        })().catch(() => undefined);
    }, [library, emulator, ui]);

    const forgetRecent = React.useCallback((id: string) => {
        recents.forget(id).then(refreshRecents).catch(refreshRecents);
    }, [recents, refreshRecents]);

    // asked about first, where the button is, as this deletes the only copy of a ROM opened from a link. See
    // RecentRoms.clear
    const clearRecents = React.useCallback(() => {
        recents.clear().then(refreshRecents).catch(refreshRecents);
    }, [recents, refreshRecents]);

    // the release was already chosen on the game's page (demo, v1.0, v1.1, ...), so this is only the download.
    // homebrewRomUrl turns the downloads group named by the detail request into the file's address
    const playHomebrew = React.useCallback((game: HomebrewGame, rom?: HomebrewRom) => {
        (async () => {
            const url = (rom && await homebrewRomUrl(rom))
                ?? (await withHomebrewDetail(game)).romUrl;
            await openUrl(url);
        })().catch(() => undefined);
    }, [openUrl]);

    // the settings window's Library pane renders inside the emulator
    emulator.library = library;

    const open = React.useCallback(async (file: File) => {
        if (!isRom(file.name) && !isZip(file.name) && !isVbArchive(file.name)) {
            ui.toast('warn', nls.localize(
                'vueport/rom/notARom', '{0} does not look like a Virtual Boy ROM.', file.name));
            return;
        }
        try {
            await openData(file.name, new Uint8Array(await file.arrayBuffer()));
        } catch (error) {
            if (error instanceof RomChoiceCanceled) {
                return;
            }
            ui.toast('error', error instanceof RomSourceError
                ? error.message
                : nls.localize('vueport/rom/openFailed', '{0} could not be opened: {1}',
                    file.name, String(error)));
        }
    }, [openData, ui]);

    const onDrop = React.useCallback(async (event: React.DragEvent) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) {
            await open(file);
        }
    }, [open]);

    const pickInPage = React.useCallback(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = OPENABLE_EXTENSIONS.join(',');
        input.style.display = 'none';

        // attached before it is clicked and removed afterwards, as WebKit (every macOS webview) only delivers change
        // for an input in the document; detached, the chosen file is silently dropped
        document.body.appendChild(input);
        const finish = (): void => input.remove();

        input.addEventListener('change', () => {
            const file = input.files?.[0];
            finish();
            if (file) {
                open(file).catch(error => ui.toast('error', String(error)));
            }
        });
        // nothing was chosen; the element would otherwise stay in the document
        input.addEventListener('cancel', finish);

        input.click();
    }, [open, ui]);

    // what the palette's commands need from the page. Kept in a ref and read when the palette opens, so the key handler
    // below is installed once rather than rebuilt with every callback
    const commandContext = React.useRef<WebCommandContext>(undefined!);
    React.useEffect(() => {
        commandContext.current = {
            emulator, ui, recents, openUrl, openRecent, refreshRecents,
        };
    });

    // shared by the key handler below and the status bar's "Command Palette" entry
    const openPalette = React.useCallback(() => {
        openCommandPalette(commandContext.current)
            .catch(error => ui.toast('error', String(error)));
    }, [ui]);

    // from a game pad: Home opens it, the d-pad and face buttons answer it. Not while the settings are open, where the
    // Game Pads page may be recording Home
    React.useEffect(() => steerPaletteWithGamepad({
        resolver: () => emulator.gamepadProfiles(),
        ui,
        openPalette,
        blocked: () => emulator.settingsOpen,
    }), [emulator, ui, openPalette]);

    const pick = React.useCallback(() => {
        // the desktop asks the system for its own panel, as a browser's file input never says where the file came from,
        // and without that a ROM's save has no folder. The choice comes back as a ROM the system opened with us
        import('./desktop-bridge').then(async ({ isDesktop }) => {
            if (!isDesktop()) {
                return pickInPage();
            }
            const { pickRomNatively } = await import('./desktop-open');
            await pickRomNatively(
                nls.localize('vueport/rom/open', 'Open ROM'), OPENABLE_EXTENSIONS);
        }).catch(error => ui.toast('error', String(error)));
    }, [pickInPage, ui]);

    // the app's two shortcuts, the command palette and Open ROM. On window in the capture phase, as the emulator
    // matches keys by code alone and would also take them as pad buttons (⌘O would trigger Fullscreen); stopping them
    // also keeps the browser's Open dialog away
    React.useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            const modified = event.ctrlKey || event.metaKey;
            const palette = event.key === 'F1'
                || (modified && event.shiftKey && event.code === 'KeyP');
            const openRom = modified && !event.shiftKey && !event.altKey
                && event.code === 'KeyO';
            // a "press a key" prompt owns every keystroke, as these are there to be bound
            if ((!palette && !openRom) || ui.isCapturingKey) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            // something is already being answered, so the key is swallowed rather than opening something over it
            if (ui.isPicking || ui.isPrompting) {
                return;
            }
            if (palette) {
                openPalette();
            } else {
                pick();
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [ui, openPalette, pick]);

    React.useEffect(() => watchEdgeSwipes(emulator), [emulator]);

    // the library's column (a drawer from the left on a phone) and the settings (from the right) are never out
    // together: whichever comes out puts the other away. One effect each, so only the one that just changed acts
    const drawerOpen = useLibraryDrawer();
    React.useEffect(() => {
        if (drawerOpen && emulator.settingsOpen) {
            emulator.closeSettings();
        }
    }, [drawerOpen]);
    React.useEffect(() => {
        if (emulator.settingsOpen) {
            setLibraryDrawer(false);
        }
    }, [emulator.settingsOpen]);

    // in a game the device's Back leads to the library, as the title bar's arrow does, rather than off the page. Under
    // everything opened over the game, which Back closes first (see back-navigation.ts)
    React.useEffect(() => {
        if (!emulator.hasRom || emulator.player !== 1) {
            return undefined;
        }
        return pushBackHandler(() => { emulator.closeRom().catch(() => undefined); });
    }, [emulator, emulator.hasRom]);

    // the toolbar's Load ROM button asks for the same picker the welcome screen opens
    React.useEffect(() => {
        const subscription = emulator.onDidRequestOpenRom(() => pick());
        return () => subscription.dispose();
    }, [emulator, pick]);

    // the desktop shell sees a drag rather than the page (see opened::on_window_event), so this lights the drop area in
    // place of the dragover that never comes. The drop arrives as a ROM the system opened with us, below
    React.useEffect(() => {
        let stop: (() => void) | undefined;
        let canceled = false;
        import('./desktop-bridge').then(async ({ isDesktop }) => {
            if (!isDesktop() || canceled) {
                return;
            }
            const { watchDragging } = await import('./desktop-open');
            const subscription = await watchDragging(setDragging);
            if (canceled) {
                subscription();
            } else {
                stop = subscription;
            }
        }).catch(() => undefined);
        return () => { canceled = true; stop?.(); };
    }, []);

    // a ROM opened from the desktop (double-clicked, or dropped) goes the picker's way, so archives work and bad files
    // are reported the same
    React.useEffect(() => {
        const subscription = emulator.onDidReceiveRom(({ name, data, location }) => {
            // a ROM arriving means nothing is dragged any more. Only the shell can say so, as the desktop has no
            // dragleave and a lit overlay would otherwise stay
            setDragging(false);
            openData(name, data, location).catch(error => {
                if (!(error instanceof RomChoiceCanceled)) {
                    ui.toast('error', error instanceof RomSourceError
                        ? error.message
                        : nls.localize('vueport/rom/openFailed', '{0} could not be opened: {1}',
                            name, String(error)));
                }
            });
        });
        return () => subscription.dispose();
    }, [emulator, openData, ui]);

    // ?rom=<address> opens that ROM instead of the welcome screen, a link session's second-player window the first
    // player's game. Once on first mount, as re-running would restart the game; an invitation from the library learns
    // the game later, see LinkController#lobbyGame
    const invitation = React.useMemo(() => readInvitation(), []);
    const invitedGame = invitation?.game ?? link.lobbyGame;
    const [autoLoading, setAutoLoading] = React.useState(() => {
        if (invitedGame) {
            return true;
        }
        try {
            return romUrlFrom(window.location.href) !== undefined;
        } catch {
            // reported by the effect below, which is where the toast lives
            return true;
        }
    });
    React.useEffect(() => {
        // abandoned if the page goes away mid-download, so a fetch cannot deliver a ROM into a torn-down emulator
        const aborter = new AbortController();
        (async () => {
            let progress: { cancel(): void } | undefined;
            try {
                // the first player's window put the game in the recent-games store, so the id is enough. Failing is not
                // fatal: the welcome screen can open it by hand, and the session waits until something runs
                if (invitedGame) {
                    const shared = await waitForSharedGame(
                        recents, invitedGame, aborter.signal);
                    if (shared) {
                        // from where it lives, as openRecent does, so this player's save sits beside the ROM and
                        // ESSound tracks are found
                        const { reopenFile } = await import('./desktop-open');
                        const location = shared.rom.location && await reopenFile(shared.rom.location)
                            ? shared.rom.location
                            : undefined;
                        await openData(shared.rom.name, shared.data, location, shared.rom.url, undefined, undefined,
                            shared.rom.archive);
                    } else {
                        ui.toast('warn', nls.localize('vueport/link/gameGone',
                            'Open the same game as the other player to link up.'));
                    }
                    return;
                }
                const url = romUrlFrom(window.location.href);
                if (!url) {
                    return;
                }
                const stateUrl = stateUrlFrom(window.location.href);
                progress = ui.progress(nls.localize('vueport/rom/downloading', 'Downloading ROM…'));
                const [downloaded, state] = await Promise.all([
                    fetchRom(url, aborter.signal),
                    stateUrl ? fetchRom(stateUrl, aborter.signal) : Promise.resolve(undefined),
                ]);
                await openData(downloaded.name, downloaded.data, undefined, url.href, undefined, state?.data);
            } catch (error) {
                if (!aborter.signal.aborted && !(error instanceof RomChoiceCanceled)) {
                    // a bad address leaves the welcome screen up, where the user can open a ROM themselves
                    ui.toast('error',
                        error instanceof RomUrlError || error instanceof RomSourceError
                            ? error.message
                            : nls.localize('vueport/url/romFailed',
                                'The ROM in the address could not be opened: {0}', String(error)));
                }
            } finally {
                progress?.cancel();
                setAutoLoading(false);
            }
        })();
        return () => aborter.abort();
    }, [emulator, openData, ui, recents, invitedGame]);

    /**
     * "Auto start last recent game" opens the newest Recently Played entry, which with Suspend and Resume continues the
     * last session. Once per run, and only when nothing else names a game for this launch (?rom=, a link invitation, a
     * game the desktop started us with). Decided at the first render and held, so a bad address still counts and its
     * error isn't buried. A ref rather than an empty dependency list, as the recent list is read after the first
     * render.
     */
    const directed = React.useRef(autoLoading || invitation !== undefined);
    const autoStarted = React.useRef(false);
    React.useEffect(() => {
        if (autoStarted.current || directed.current || emulator.hasRom
            || !(continueLastGame || startsWithLastGame())) {
            return;
        }
        const newest = recentList[0];
        if (!newest) {
            // nothing played yet, or the list not read back yet; this effect runs again when it arrives
            return;
        }
        autoStarted.current = true;
        // a ROM whose bytes have gone says so and leaves the library up, openRecent's behaviour
        openRecent(newest).catch(() => undefined);
    }, [emulator, openRecent, recentList, continueLastGame]);

    return <div
        id='vp-root'
        className='vp-root'
        ref={root}
        tabIndex={-1}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
    >
        {/* Emulator renders a bare fragment (toolbar, dock host, overlay) and leaves stacking them to its parent, as
            the studio's widget node does with this class; without it the dock lands on top of the toolbar */}
        <div className='vp-widget'>
            <WebTitleBar emulator={emulator} />
            {/* one screen, linked or not, as the other player has a window of their own. The wrapper stays because the
                keyboard is attached to it, see EmulatorInputController.attach */}
            <div className='vp-screen' ref={screen} tabIndex={-1}>
                <Emulator
                    emulator={emulator}
                    attached={attached}
                    chrome='immersive'
                    placeholder={emulator.hasRom
                        ? undefined
                        : link.awaitingGame
                        ? <LinkLobbyScreen onCancel={() => emulator.runCommand(EmulatorCommands.UNLINK_PLAYERS.id)} />
                        : <LibraryScreen
                            library={library}
                            ui={ui}
                            onPlay={playFromLibrary}
                            onPlayHomebrew={playHomebrew}
                            onPick={pick}
                            onManage={() => emulator.openSettingsTab('library')}
                            onOpenUrl={openUrl}
                            recents={recentList}
                            onOpenRecent={rom => { openRecent(rom).catch(() => undefined); }}
                            onForgetRecent={forgetRecent}
                            onClearRecents={clearRecents}
                            busy={autoLoading}
                            onShare={emulator.lanSharing ? shareFromLibrary : undefined}
                        />}
                />
            </div>
            <WebStatusBar emulator={emulator} library={library} onOpenCommandPalette={openPalette} />
        </div>
        {dragging && <div className='vp-dropzone'></div>}
        <WebUiOverlay ui={ui} />
        {(emulator.xr.active || emulator.xr.startOffered) && <WebXrCover emulator={emulator} />}
    </div>;
}
