import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { EmulatorCoreService } from 'vueport-core/lib/browser/emulator-core-service';
import { RetroAchievementsService } from 'vueport-core/lib/browser/emulator-retroachievements';
import { VueportScrollbars } from 'vueport-core/lib/browser/emulator-scrollbars';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { EmulatorCompanionLocation } from 'vueport-core/lib/common/emulator-sram';
import { App } from './app';
import { allowCompactLayout } from 'vueport-core/lib/browser/compact-layout';
import { allowBackNavigation } from 'vueport-core/lib/browser/back-navigation';
import type { LaunchOptions } from './desktop-open';
// statically imported, though these used to be dynamic: now that the build splits, each would be a file and a request
// of its own, needed on every start anyway, which measured slower on a slow link. Only the genuinely conditional (the
// desktop shell's modules, unopened windows) stays dynamic
import {
    invoke as askShell,
    isDesktop,
    listen as onShellEvent,
    requestQuit,
    setWindowTheme,
    setWindowTitle,
} from './desktop-bridge';
import { DecodingRumblePack, SerialRumblePack } from 'vueport-core/lib/common/emulator-rumble';
import { WebBindings } from './web-bindings';
import { WebSerialRumblePack } from './web-serial-rumble';
import { WebEmulator } from './web-emulator';
import { LinkStatus, readInvitation, WebLink } from './web-link';
import { installLocale } from './web-nls';
import { WebNotifications } from './web-notifications';
import { PlayTimes } from './web-play-time';
import { RecentRoms } from './web-recent-roms';
import { DesktopRomOrigin, LibraryRomOrigin } from './web-recent-origins';
import { Library } from './web-library';
import { BrowserLibrarySource } from './web-library-browser-source';
import { ImportedLibrarySource } from './web-library-imported-source';
import { lookUpDetails, readFoldersAtStart } from './web-library-settings';
import { WebRetroAchievementsCredentials, WebRetroAchievementsTransport } from './web-retroachievements';
import { WebSettings } from './web-settings';
import { WebStorage } from './web-storage';
import { onDidChangeTheme, startTheme, storedTheme } from './web-theme';
import { WebUi } from './web-ui';

// Lumino's base stylesheet, which Theia imports for the studio: `.lm-Widget { position: relative }` keeps the dock's
// absolutely positioned children inside the dock host instead of over the toolbar, and the tab bar rules lay out tabs
import '@lumino/widgets/style/index.css';
import { Sim } from 'vueport-core';
import 'vueport-core/src/browser/style/emulator-widget.css';
import './host-overrides.css';
import './host-theme.css';
import './style.css';

// the translation goes in before anything renders, as the emulator's display tables are built on first use and
// would otherwise stay English for the life of the page
async function main(): Promise<void> {
    // this build is the one opened on phones: the layout follows the screen, see compact-layout.ts
    allowCompactLayout();
    // the device's Back goes back inside VUEPort before it leaves the page, see back-navigation.ts
    allowBackNavigation();
    // desktop preferences live in ~/.vueport/config.json; load them into the synchronous settings cache before locale,
    // theme or any other service first reads from it
    const desktop = isDesktop();
    let flushDesktopConfig: (() => Promise<void>) | undefined;
    // what the command line asked of this run (see launch.rs); nothing in a browser
    let launch: LaunchOptions | undefined;
    if (desktop) {
        const desktopConfig = await import('./desktop-config');
        const { installDesktopConfig } = desktopConfig;
        await installDesktopConfig();
        flushDesktopConfig = desktopConfig.flushDesktopConfig;

        launch = await (await import('./desktop-open')).launchOptions()
            .catch(() => undefined);

        // a webview has no second tab for a link and silently drops the attempt, so every link out is handed to the
        // system from one place, installed before the first page with links is drawn
        (await import('./desktop-external')).interceptExternalLinks();

        // game pads come from the shell via SDL, as the webview's own Gamepad API does not see every pad; before
        // anything that reads a pad starts (see desktop-gamepads.ts)
        await (await import('./desktop-gamepads')).installDesktopGamepads()
            .catch(error => console.warn('desktop game pads unavailable:', error));

        // the page's position on the display to the physical pixel, which the interleaved modes need and a page can
        // only estimate. Not waited for: the screen uses its own estimate until it answers
        import('./desktop-screen-origin')
            .then(({ installScreenOrigin }) => installScreenOrigin())
            .catch(() => undefined);
    }

    await installLocale();

    // before anything is drawn: the mode is custom properties on the document root, and correcting it later flashes the
    // wrong theme
    startTheme();

    const ui = new WebUi();

    // the same bundle runs in a browser and in the desktop application; where the desktop can do more (real files, a
    // serial port) the difference is made here and nowhere else
    const notifications = new WebNotifications(ui);
    const storage = desktop
        ? new (await import('./desktop-storage')).DesktopStorage()
        // refused in a Firefox private window or with site data blocked: the page runs on files that last until it is
        // closed, and says so once rather than a lost save being the first sign
        : new WebStorage(error => notifications.warn(nls.localize('vueport/storage/unavailable',
            'Files cannot be kept in this browser ({0}): saves, save states and imported games are lost when the page closes. Usually a private window or blocked site data.',
            error instanceof DOMException ? error.name : String(error))));
    // where a ROM's save, save states and cheats go, by default the application's storage. The desktop may switch to
    // beside the ROM; a browser is never told where a ROM came from, so there the setting is shown fixed, with the
    // reason
    const settings = desktop
        ? new WebSettings()
        : new WebSettings(
            { companionFiles: EmulatorCompanionLocation.STORAGE },
            {
                companionFiles: nls.localize(
                    'vueport/preferences/companionFiles/unavailable',
                    'Not available in the browser.'
                ),
            },
        );
    ui.setSoundEnabled({
        error: () => settings.get('errorSoundEnabled'),
        achievement: () => settings.get('achievementSoundEnabled'),
    });
    const bindings = new WebBindings(ui);
    // starts and play time per ROM, by checksum, so the library shows the hours, also for a ROM played from a file
    // before its folder was added
    const playTimes = new PlayTimes(storage);
    // the library's folders and what was found in them, read from storage rather than disk: nothing is asked of a
    // folder until the user asks, which in a browser is a rule, as permission to read a folder needs a click
    const library = new Library(storage, desktop
        ? new (await import('./desktop-library')).DesktopLibrarySource()
        : new BrowserLibrarySource(), playTimes,
        // folders copied in rather than read in place: all Firefox and Safari can do (no directory picker), and what
        // survives an unplugged disk elsewhere. The desktop has real paths and no reason to duplicate a collection
        desktop ? undefined : new ImportedLibrarySource(storage));

    // recently opened ROMs for the start page, kept in storage only where needed; after the library, as it is one of
    // the two ways back to a ROM's own file that make a copy unnecessary. See web-recent-origins.ts
    const recents = new RecentRoms(storage, [
        new LibraryRomOrigin(library),
        ...(desktop ? [new DesktopRomOrigin()] : []),
    ]);

    const coreService = new EmulatorCoreService({
        // named by the build: a production build stamps a content hash into these file names so they can be cached for
        // good (see esbuild.mjs and build-constants.d.ts)
        workerUrl: VUEPORT_WORKER_URL,
        audioWorkletUrl: VUEPORT_AUDIO_WORKLET_URL,
        wasmUrl: VUEPORT_WASM_URL,
        // WebKitGTK 2.52 has WebGL2 on the page but not in an OffscreenCanvas worker; on Linux desktop emulation stays
        // in the worker and only its packed video frames move across
        mainThreadVideo: desktop && navigator.userAgent.includes('Linux'),
        // absent unless the build carries the RetroAchievements engine (packages/core/wasm/README.md); the worker then
        // reports RetroAchievements unavailable, as a browser that cannot connect does
        rcheevosModuleUrl: './rcheevos.js',
    });

    // every host, the desktop webview included, goes through vueport-server's relay; see web-retroachievements.ts
    const retroAchievements = new RetroAchievementsService(
        new WebRetroAchievementsTransport(),
        new WebRetroAchievementsCredentials(),
        notifications,
        () => settings.get('retroAchievementsEnabled'),
    );
    // the offline achievement-set snapshot, a static asset beside the page (see esbuild.mjs), pulled in only when a
    // running ROM has no live set. The desktop shell serves the same dist
    retroAchievements.setBackupLoader(async () => {
        const response = await fetch('./retroachievements-vb.json');
        return response.ok ? response.json() : undefined;
    });
    await retroAchievements.restore();

    /**
     * How this build reaches a Rumble Pack, best first: the desktop shell opens the port in Rust, the only way on every
     * platform it ships to (WKWebView has no navigator.serial); Chromium opens it itself, as VUEngine Studio does;
     * elsewhere the link port is only decoded. The desktop one is imported dynamically, as it reaches for the shell's
     * globals.
     */
    const rumblePack = desktop
        ? new (await import('./desktop-rumble')).DesktopRumblePack()
        : WebSerialRumblePack.available()
            ? new WebSerialRumblePack()
            : new DecodingRumblePack();
    if (rumblePack instanceof SerialRumblePack) {
        await rumblePack.start();
    }

    // linking a second player (web-link.ts): a window opened as player two says so in its address and is otherwise a
    // whole emulator; it keeps its layout under its own namespace, as both windows share an origin
    const invitation = readInvitation();
    const player = invitation?.seat ?? 1;
    // the launch options are the first window's, as the second player's is started by it and not by the command line
    if (player !== 1) {
        launch = undefined;
    }

    // --hardcore / --softcore: for this run, before anything reads it; changing it by hand still sticks
    if (typeof launch?.hardcore === 'boolean') {
        settings.holdForSession('retroAchievementsHardcore', launch.hardcore);
    }

    const emulator = new WebEmulator(
        coreService, settings, bindings, storage, notifications, ui, recents, playTimes, retroAchievements,
        rumblePack,
        player === 2 ? { instanceId: 'web-p2', player: 2 } : undefined);

    const desktopLink = desktop ? await import('./desktop-link') : undefined;
    const link = new WebLink({
        context: () => emulator.linkContext(),
        romData: () => emulator.romData(),
        cartridge: () => emulator.linkCartridge(),
        // player two's window finds the game in the shared recent-games store, so a game only remembered as a file has
        // to be put there first. See RecentRoms.keep
        shareGame: (romId, data) =>
            recents.keep(romId, new Uint8Array(data)).catch(() => undefined),
        // the cheats this window's machine runs under, so the other window's mirror does not start without them
        standingEdits: () => (emulator.cheats.writes.length > 0
            ? [{ kind: 'cheats' as const, codes: emulator.cheats.writes }]
            : []),
        saveReport: report => emulator.saveLinkReport(report),
        peerPaused: paused => emulator.followPeerPause(paused),
        openWindow: desktopLink && (query => desktopLink.openLinkWindow(query)),
        notify: message => notifications.warn(message),
        changed: () => emulator.notifyChanged(),
    });
    emulator.setLink({
        request: () => link.invite(),
        release: () => link.leave(),
        get linked(): boolean { return link.connected; },
        get status(): LinkStatus { return link.status; },
        sendKeys: keys => link.setKeys(keys),
        sendTurbo: (keys, rate) => link.setTurbo(keys, rate),
        snapshot: () => link.snapshot(),
        resume: (p1, p2) => link.resume(p1, p2),
        restart: () => link.restart(),
        setPaused: paused => link.setPaused(paused),
        get peerSim(): Sim | undefined { return link.mirror; },
        scheduleEdits: (target, edits) => link.scheduleEdits(target, edits),
    });

    /**
     * An invited window joins once its cartridge runs and its machine isn't standing still. The other window opened it
     * and the user hasn't interacted with it, so the browser holds its audio back, and the audio worklet clocks
     * emulation (see audioStillBlocked in vb-core.ts). Joining then would freeze the other player's game too, so they
     * carry on alone until this window is clicked. A player 1 who invited from the library has no game yet: it starts
     * the session once it has one, and this window, opened without a game in its address, waits to be told which
     * (LobbyMessage).
     */
    emulator.onStateChanged(() => link.gameChanged());
    if (invitation && !invitation.game) {
        link.awaitGame(invitation);
    }
    if (invitation) {
        const joinOnRom = emulator.onStateChanged(() => {
            const context = emulator.linkContext();
            if (!context) {
                return;
            }
            joinOnRom.dispose();
            const core = context.session.core;
            const join = () => link.joinFromAddress(invitation);
            core.audioStillBlocked().then(blocked => {
                if (!blocked) {
                    join();
                    return;
                }
                const unblocked = core.onDidUnblockAudio(() => {
                    unblocked.dispose();
                    join();
                });
            }).catch(() => join());
        });
    }

    const host = document.getElementById('root');
    if (!host) {
        throw new Error('No #root to mount into.');
    }
    createRoot(host).render(
        <App emulator={emulator} link={link} ui={ui} recents={recents} library={library}
            continueLastGame={launch?.continue === true} />);

    // after the render: the library draws itself empty and fills in, faster to look at than a blank window
    library.load()
        .then(() => {
            if (readFoldersAtStart()) {
                return library.readAll();
            }
            // anything a previous session found but never got an answer about: the catalog was down, or the read was
            // canceled
            return lookUpDetails() ? library.lookUpMissing() : undefined;
        })
        // now the library knows what it holds, Recently Played's copies of ROMs reachable in a folder are redundant
        // (see RecentRoms.dropRedundantCopies)
        .then(() => recents.dropRedundantCopies())
        .catch(() => undefined);

    // Perfect Scrollbar on everything marked vp-scroll, emulator panels and this application's surfaces alike. One
    // installation over the whole document, as containers come and go with what React draws
    const scrollbars = new VueportScrollbars();
    scrollbars.install(document.body);

    // the bar index.html paints while the bundle loads, taken down here so whatever shows first replaces it and nothing
    // has to know it existed
    document.getElementById('boot')?.remove();

    if (desktop) {
        // after the render, so a ROM opened from the desktop arrives at an application already listening for it
        const { watchOpenedRoms } = await import('./desktop-open');
        await watchOpenedRoms(rom => emulator.receiveRom(rom.name, rom.data, rom.path));

        // the window's chrome follows the page; `null` gives the window back to the system
        const dressWindow = (): void => {
            setWindowTheme(storedTheme() ?? null).catch(() => undefined);
        };
        onDidChangeTheme(dressWindow);
        dressWindow();

        // the shell holds the window close until the game's saves are on disk: cart RAM lives in the worker, and
        // writing it out is a round trip to the shell that a page being torn down never completes
        await onShellEvent('app://close-requested', () => {
            Promise.all([
                emulator.flushSaves(),
                flushDesktopConfig?.() ?? Promise.resolve(),
            ])
                .catch(() => undefined)
                .finally(() => askShell('confirm_close').catch(() => undefined));
        });

        // named after what is playing, so a ROM can be picked out of the window list and Mission Control. Driven from
        // the emulator's change signal rather than openRom, so closing a ROM puts the plain name back too
        const nameWindow = (): void => {
            const rom = emulator.fileName;
            // player two's window says which it is even before a game runs, as the two otherwise look alike
            const app = player === 2 ? 'VUEPort \u00b7 P2' : 'VUEPort';
            setWindowTitle(rom ? `${rom} \u2013 ${app}` : app)
                .catch(() => undefined);
        };
        emulator.onStateChanged(nameWindow);
        nameWindow();

        // tools on this computer talking to the running game while the setting allows (desktop-probe.ts). The first
        // window only: the shell hands its requests to the window called `main`
        if (player === 1) {
            const { installProbe } = await import('./desktop-probe');
            await installProbe(() => emulator.probeTarget())
                .catch(error => console.warn('[probe] could not start:', error));
        }

        if (player === 1) {
            const { onDidChangeUpdateState, updateOnStart } = await import('./desktop-update');
            const announced = onDidChangeUpdateState(state => {
                if (state.kind === 'available') {
                    announced.dispose();
                    /*
                    ui.toast(
                        'info',
                        nls.localize('vueport/update/available',
                            'VUEPort {0} is available.',
                            state.release.version),
                        () => emulator.toggleUpdatesWindow(),
                    );
                    */
                }
            });
            updateOnStart().catch(() => undefined);
        }

        if (launch?.linked) {
            const linkOnRom = emulator.onStateChanged(() => {
                if (emulator.linkContext() && !link.connected) {
                    linkOnRom.dispose();
                    link.invite();
                }
            });
        }

        // --quit-on-close: a frontend that started a game gets its screen back when the game is closed, rather than
        // the library. Quitting goes the window close button's way, so the saves are written first
        if (launch?.quitOnClose) {
            let playing = emulator.hasRom;
            emulator.onStateChanged(() => {
                if (emulator.hasRom) {
                    playing = true;
                } else if (playing) {
                    playing = false;
                    requestQuit().catch(() => undefined);
                }
            });
        }
    }

    // saves live in the worker until written out, and pagehide is too late for an asynchronous write, so they are also
    // written whenever the page is hidden (switching tabs, minimizing, the first half of closing)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            emulator.flushSaves().catch(() => undefined);
        }
    });
    window.addEventListener('pagehide', () => {
        link.dispose();
        emulator.dispose();
        scrollbars.dispose();
    });
}

main().catch(error => {
    console.error('[vueport]', error);
    document.body.textContent = `VUEPort could not start: ${error}`;
});
