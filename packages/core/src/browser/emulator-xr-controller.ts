/**
 * Playing in a headset as a host offers it: availability, the start button, the page's interface around the screen,
 * and what is kept between sessions. EmulatorXrSession is the session itself and knows nothing of the host.
 * Only the standalone build uses this: Electron has WebXR's API but nothing behind it that reaches a headset
 * (isSessionSupported says no with a Quest connected, even with the switches that make WebView2 work).
 */

import { nls } from '../common/emulator-nls';
import { DisplayMode } from '../common/vb-constants';
import { Core, Sim } from './core/vb-core';
import { EmulatorInputController } from './emulator-input';
import {
    clampXrScreen,
    EmulatorXrSession,
    XrAvailability,
    XrBackdrop,
    XrDiagnostics,
    XrScreen,
} from './emulator-xr';
import {
    loadXrBackdrop,
    loadXrScreen,
    saveXrBackdrop,
    saveXrScreen,
} from './emulator-xr-storage';

export interface XrHeadsetUi {
    toast(text: string, error: boolean): void;
    // what is being waited for while no game runs yet (a download), on the screen; undefined when nothing is
    wait(text: string | undefined): void;
    ask(title: string, message: string[], yes: string, no: string): Promise<boolean>;
    // the page's own interface is in the headset (see emulator-xr-ui.ts): its questions are asked there as they are
    showsPage?: boolean;
}

export interface XrControllerHost {
    sim(): Sim | undefined;
    core(): Core | undefined;
    input(): EmulatorInputController;
    displayMode(): DisplayMode;
    // the 3D depth changed (on the way in or out, or adjusted in the headset); apply it through
    // EmulatorXrController.stereoDepth
    applyStereoDepth(): Promise<void>;
    update(): void;
    notifyError(message: string): void;
    setHeadset?(headset: XrHeadsetUi | undefined): void;
    // false to draw into the eye buffers even where a quad layer is on offer; see EmulatorXrHost.quadLayers
    quadLayers?: boolean;
    debug?: boolean;
    // into the headset as soon as the page is there, where the browser lets it (see enterAtStart)
    enterAtStart?: boolean;
    onXrUiShown?(shown: boolean): void;
}

// an installed web app, started from its icon: the Quest Browser counts that tap as the gesture a headset needs
function installedApp(): boolean {
    return typeof matchMedia === 'function'
        && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches);
}

export class EmulatorXrController {

    protected session: EmulatorXrSession | undefined;
    protected starting = false;
    protected disposed = false;
    protected startTried = false;
    // an installed app that could not go straight into the headset: the host shows a way in that takes one press,
    // until it is taken or put aside (dismissStart)
    startOffered = false;
    protected readonly deviceChange: { dispose(): void };

    availability: XrAvailability | undefined;
    passthroughSupported = false;
    screen: XrScreen = loadXrScreen();
    backdrop: XrBackdrop = loadXrBackdrop();

    constructor(protected readonly host: XrControllerHost) {
        // the button is drawn only where there is a headset. Asked again whenever one comes or goes, as a PC's arrives when
        // Link or Virtual Desktop connects, often after this
        this.check();
        this.deviceChange = EmulatorXrSession.onDeviceChange(() => this.check());
    }

    dispose(): void {
        this.disposed = true;
        this.deviceChange.dispose();
        this.session?.end().catch(() => undefined);
    }

    get supported(): boolean {
        return this.availability === 'headset';
    }

    get active(): boolean {
        return this.session !== undefined;
    }

    stereoDepth(page: number): number {
        return this.session ? this.screen.depth : page;
    }

    protected check(): void {
        Promise.all([
            EmulatorXrSession.availability(),
            EmulatorXrSession.isSupported('ar').catch(() => false),
        ]).then(([availability, passthrough]) => {
            this.availability = availability;
            this.passthroughSupported = passthrough;
            if (!this.disposed) {
                this.host.update();
                this.enterAtStart();
            }
        }).catch(() => undefined);
    }

    // straight into the headset at start, with the library to pick a game from. A browser grants a headset only to a
    // gesture: on the Quest an installed app's start from its icon counts, in a tab the session is offered in the
    // browser's UI (an Enter VR button by the address). Tried once and quietly, as either may be refused
    protected enterAtStart(): void {
        if (this.startTried || !this.host.enterAtStart || !this.supported || this.session || this.starting) {
            return;
        }
        this.startTried = true;
        const offer = (): void => {
            if (!this.session && EmulatorXrSession.canOffer()) {
                this.enter({ offer: true, quiet: true }).catch(() => undefined);
            }
        };
        if (installedApp()) {
            // where the browser does not count the start as a gesture, it takes one press: the host offers it big
            const refused = (): void => {
                if (!this.session) {
                    this.startOffered = true;
                    this.host.update();
                    offer();
                }
            };
            this.enter({ background: true, quiet: true }).then(refused, refused);
        } else {
            offer();
        }
    }

    // called straight from a click, as a browser grants a headset only to a gesture and EmulatorXrSession.start asks
    // for it before anything else
    async toggle(): Promise<void> {
        if (this.session) {
            await this.session.end();
        } else {
            await this.enter();
        }
    }

    async end(): Promise<void> {
        await this.session?.end();
    }

    dismissStart(): void {
        this.startOffered = false;
        this.host.update();
    }

    // back into the headset from a click on the page: a session left for another of the headset's windows runs on
    // unseen and the browser's Resume does not bring it back, so it is ended and a new one asked for while the click
    // still counts
    async resume(): Promise<void> {
        const running = this.session;
        if (!running) {
            await this.enter();
            return;
        }
        // a session left in the background can take seconds to end: given a moment, then a new one is asked for
        // while the click still counts, and once more when the old one has gone, if the browser wanted that first
        const clicked = performance.now();
        const ending = running.end().catch(() => undefined);
        await Promise.race([ending, new Promise(resolve => setTimeout(resolve, EmulatorXrController.RESUME_WAIT_MS))]);
        // its end event, coming after, is then let pass (see enter's onXrEnded)
        if (this.session === running) {
            this.ended(running.diagnostics);
        }
        await this.enter({ quiet: true });
        if (!this.session) {
            await ending;
            await this.enter();
        }
        const session = this.session;
        if (this.host.debug && session) {
            const steps = Object.entries(session.diagnostics.timeline ?? {}).map(([step, at]) => `${step} ${at}`);
            session.toast(`${Math.round(performance.now() - clicked)} ms: ${steps.join(' · ')}`);
        }
    }

    protected static readonly RESUME_WAIT_MS = 300;

    // without a game is how one is started straight into the headset; setSim later hands the session the machine.
    // offer: in the browser's interface (see enterAtStart). background: a click meanwhile still goes in, as an attempt
    // may hang rather than fail. quiet: refusals are not reported
    async enter(options: { offer?: boolean, background?: boolean, quiet?: boolean } = {}): Promise<void> {
        if (this.session || this.starting || !this.supported) {
            return;
        }
        const { offer, quiet } = options;
        const background = options.background || offer;
        if (!background) {
            this.starting = true;
        }
        // this attempt's session, so one ending that lost a race with another way in is not taken for the one running
        let started: EmulatorXrSession | undefined;
        try {
            const session = await EmulatorXrSession.start({
                offer,
                // AR wherever the headset can show the room, so passthrough can be toggled in the session rather than by asking
                // for another one, which only a gesture on the page can
                mode: this.passthroughSupported ? 'ar' : 'vr',
                backdrop: this.backdrop,
                sim: this.host.sim(),
                input: this.host.input(),
                displayMode: () => this.host.displayMode(),
                resumeAudio: () => this.host.core()?.resumeAudio(),
                quadLayers: this.host.quadLayers,
                view: this.screen,
                pageUi: true,
                debug: this.host.debug,
                onXrViewChanged: screen => {
                    this.screen = screen;
                    saveXrScreen(screen);
                    this.host.applyStereoDepth().catch(() => undefined);
                    this.host.update();
                },
                onXrUiShown: shown => this.host.onXrUiShown?.(shown),
                onXrEnded: diagnostics => {
                    if (this.session === undefined || this.session === started) {
                        this.ended(diagnostics);
                    }
                },
            });
            started = session;
            if (this.session) {
                await session.end().catch(() => undefined);
                return;
            }
            // asked for the room and given a session without it: this headset only says it can
            if (session.mode !== 'ar') {
                this.passthroughSupported = false;
            }
            // a headset taken off while starting has ended the session already
            this.session = session.running ? session : undefined;
            this.startOffered = false;
            if (this.session) {
                const headset = this.session;
                this.host.setHeadset?.({
                    toast: (text, error) => headset.toast(text, error),
                    wait: text => headset.setWaiting(text),
                    ask: (title, message, yes, no) => headset.ask(title, message, yes, no),
                    showsPage: true,
                });
            }
            await this.host.applyStereoDepth();
            // the game may have started while the session was being set up
            await this.session?.setSim(this.host.sim());
            if (this.session) {
                this.watchAudioClock();
            }
        } catch (error) {
            if (!quiet) {
                this.host.notifyError(nls.localize(
                    'vueport/xr/failed', 'Could not start the headset: {0}',
                    error instanceof Error ? error.message : String(error)));
            }
        } finally {
            if (!background) {
                this.starting = false;
            }
            this.host.update();
        }
    }

    protected ended(diagnostics: XrDiagnostics): void {
        this.session = undefined;
        this.host.setHeadset?.(undefined);
        this.watchAudioClock();
        this.host.applyStereoDepth().catch(() => undefined);
        if (this.host.debug) {
            console.info('[vueport] headset session', diagnostics);
        }
        this.host.update();
    }

    // none while the machine is rebuilt (patch, hardware change, new build); the headset stays through that
    async setSim(sim: Sim | undefined): Promise<void> {
        await this.session?.setSim(sim);
    }

    // a game is being opened (not a restart of the running one): the interface steps aside once it shows. It shows
    // regardless until then, as without a game there is nothing else to see
    gameStarting(): void {
        this.session?.setUiShown(false);
    }

    setDisplayMode(mode: DisplayMode): void {
        this.session?.setDisplayMode(mode);
    }

    setScreen(screen: XrScreen): void {
        this.screen = clampXrScreen(screen);
        saveXrScreen(this.screen);
        this.session?.setView(this.screen);
        this.host.applyStereoDepth().catch(() => undefined);
        this.host.update();
    }

    setBackdrop(backdrop: XrBackdrop): void {
        this.backdrop = backdrop;
        saveXrBackdrop(backdrop);
        this.session?.setBackdrop(backdrop);
        this.host.update();
    }

    // restarts the machine if the audio that clocks it stopped on the move into or out of the headset. Checked twice,
    // as the headset takes the audio device a moment after the session starts; without it a game patched before
    // entering stayed black
    protected watchAudioClock(): void {
        const core = this.host.core();
        const check = (): void => {
            if (this.host.core() === core && !this.disposed) {
                core?.restartStalledAudio().catch(() => undefined);
            }
        };
        check();
        setTimeout(check, EmulatorXrController.AUDIO_CLOCK_RECHECK_MS);
    }

    protected static readonly AUDIO_CLOCK_RECHECK_MS = 2500;
}
