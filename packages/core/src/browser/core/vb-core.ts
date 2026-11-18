import { Disposable, Emitter, Event } from '../../common/emulator-events';
import { LiveProfileSnapshot } from '../../common/emulator-live-profile';
import { endLoadTrace, markLoadTrace } from '../../common/load-trace';
import {
    DisplayMode,
    DisplayOutput,
    FrameBlending,
    VB_AUDIO_PROCESSOR,
    VB_DEFAULT_DISPLAY_MODE,
    VB_SAMPLE_RATE,
    VBC_FRAME_BYTES,
    VB_SCREEN_HEIGHT,
    VB_SCREEN_WIDTH,
    thumbnailDisplayMode,
} from '../../common/vb-constants';
import {
    isVbEvent,
    VbCheatWrite,
    ScheduledEdit,
    LinkJournalEntry,
    CommandName,
    Backdrop,
    DisassemblyLine,
    Frame,
    ProfileResult,
    Recording,
    Registers,
    Outbound,
    Params,
    Request,
    Response,
    Result,
    RewindHistory,
    SimHandle,
    Speed,
    SramRun,
    StopReason,
    StopWrite,
    VesRaEvent,
    VesRaLeaderboardEntries,
    VesRaUser,
    VsuReading,
} from '../../common/vb-protocol';
import { decodeOriginRuns } from '../../common/vb-pixel-origin';
import { VbRenderer } from '../../worker/vb-renderer';

export interface CoreOptions {
    workerUrl: string;
    audioWorkletUrl: string;
    wasmUrl: string;
    rcheevosModuleUrl?: string; // only if this build carries rcheevos
    mainThreadVideo?: boolean; // WebGL on the page (WebKitGTK), frames transferred out of the worker
}

const delay = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));

const VIDEO_FRAME_BYTES = VBC_FRAME_BYTES; // VBC RGB888, twice the legacy frame
const VIDEO_TRANSFER_BUFFERS = 3;

// one worker holding one or more simulations. run() and suspend() apply to all of them at once, so unrelated
// emulators get their own core and a linked pair must share one
export class Core implements Disposable {

    protected readonly worker: Worker;
    protected readonly audioContext: AudioContext;
    protected readonly audioNode: AudioWorkletNode;
    readonly mainThreadVideo: boolean;
    protected readonly mainThreadRenderers = new Map<SimHandle, {
        presentation: number;
        renderer: VbRenderer;
    }>();
    protected nextPresentation = 1;

    protected screenshotRenderer: VbRenderer | undefined; // main-thread video only

    // frame takers (video recording, headset) by sim, then by owner. The worker keeps one tap per machine, so each
    // frame is handed to every owner before its buffer goes back (setVideoTap in vb-protocol.ts)
    protected readonly videoTapHandlers = new Map<SimHandle, Map<string, (frame: Frame) => void>>();
    protected readonly videoTaps = new Map<SimHandle, number>(); // presentation of the tap open in the worker
    // serialises tap changes: two owners arriving together must open one tap, not two that race
    protected videoTapSync: Promise<void> = Promise.resolve();
    // tap owners that show every frame in the page's place
    protected readonly pageHolders = new Map<SimHandle, Set<string>>();
    protected readonly pagesHeld = new Set<SimHandle>(); // see holdPage in vb-protocol.ts

    protected audioUnlock: (() => void) | undefined; // cancels an armed wait for the gesture that starts the audio

    protected audioResume: Promise<void> | undefined; // for audioStillBlocked to wait on

    protected static readonly AUDIO_TRANSITION_TIMEOUT_MS = 500;

    protected audioWanted = false; // what run and suspend want

    protected audioApplied = false; // what the context was last asked for, see settleAudio

    protected audioSettling: Promise<void> | undefined;

    protected readonly onDidUnblockAudioEmitter = new Emitter<void>();
    readonly onDidUnblockAudio: Event<void> = this.onDidUnblockAudioEmitter.event;

    protected readonly pending = new Map<number, {
        resolve: (result: unknown) => void,
        reject: (error: Error) => void,
    }>();
    protected nextRequestId = 1;

    protected readonly onErrorEmitter = new Emitter<string>();
    readonly onError: Event<string> = this.onErrorEmitter.event;

    protected readonly onTerminalEmitter = new Emitter<{ sim: SimHandle, text: string }>();
    readonly onTerminal: Event<{ sim: SimHandle, text: string }> = this.onTerminalEmitter.event;

    protected readonly onLinkEmitter = new Emitter<{ sim: SimHandle, bytes: number[] }>();
    readonly onLink: Event<{ sim: SimHandle, bytes: number[] }> = this.onLinkEmitter.event;

    protected readonly onEsSoundEmitter = new Emitter<{ sim: SimHandle, commands: number[] }>();
    readonly onEsSound: Event<{ sim: SimHandle, commands: number[] }> = this.onEsSoundEmitter.event;

    protected readonly onSramEmitter =
        new Emitter<{ sim: SimHandle, runs: SramRun[] }>();
    readonly onSram: Event<{ sim: SimHandle, runs: SramRun[] }> =
        this.onSramEmitter.event;

    protected readonly onSpeedEmitter = new Emitter<Speed>();
    // about once a second and once more on suspend. An unaffordable fast forward is clamped, so this is the only
    // reliable account of the actual speed
    readonly onSpeed: Event<Speed> = this.onSpeedEmitter.event;

    protected readonly onPointerWriteEmitter = new Emitter<{ sim: SimHandle, address: number, values: number[] }>();
    readonly onPointerWrite: Event<{ sim: SimHandle, address: number, values: number[] }> =
        this.onPointerWriteEmitter.event;

    protected readonly onDigestEmitter =
        new Emitter<{ sim: SimHandle, frame: number, digest: number }>();
    // requested by Sim.setDigestPeriod; on the core as a link session wants both machines' digests in one place
    readonly onDigest: Event<{ sim: SimHandle, frame: number, digest: number }> =
        this.onDigestEmitter.event;

    protected readonly onProgressEmitter = new Emitter<{ frame: number }>();
    // only while something is under lockstep (see progress in vb-protocol.ts); a link session schedules against it
    readonly onProgress: Event<{ frame: number }> = this.onProgressEmitter.event;

    protected readonly onAwaitingInputEmitter =
        new Emitter<{ waiting: boolean, frame: number, sims: SimHandle[] }>();
    // only under lockstep (see queueKeys in vb-protocol.ts) and only on change, so it can drive a "waiting for the
    // other player" state directly
    readonly onAwaitingInput: Event<{ waiting: boolean, frame: number, sims: SimHandle[] }> =
        this.onAwaitingInputEmitter.event;

    protected readonly onPixelOriginsEmitter = new Emitter<{ sim: SimHandle, runs: ArrayBuffer }>();
    // see Sim.streamPixelOrigins
    readonly onPixelOrigins: Event<{ sim: SimHandle, runs: ArrayBuffer }> = this.onPixelOriginsEmitter.event;

    protected readonly onStoppedEmitter =
        new Emitter<{ sim: SimHandle, address: number, reason: StopReason, write?: StopWrite }>();
    // a breakpoint suspends emulation from underneath whoever thought it was running
    readonly onStopped: Event<{ sim: SimHandle, address: number, reason: StopReason, write?: StopWrite }> =
        this.onStoppedEmitter.event;

    protected readonly onStalledEmitter = new Emitter<{ frames: number }>();
    // the core stopped advancing and the worker suspended emulation. Rare and not an error (see stalled in
    // vb-protocol.ts); a listener should offer a reset
    readonly onStalled: Event<{ frames: number }> = this.onStalledEmitter.event;

    protected readonly onRetroAchievementsEmitter = new Emitter<VesRaEvent>();
    // one message at a time, unpacked from the worker's batches; the only listener is emulator-retroachievements.ts
    readonly onRetroAchievements: Event<VesRaEvent> = this.onRetroAchievementsEmitter.event;

    protected disposed = false;

    protected constructor(
        worker: Worker,
        audioContext: AudioContext,
        audioNode: AudioWorkletNode,
        mainThreadVideo: boolean,
    ) {
        this.worker = worker;
        this.audioContext = audioContext;
        // a context the browser stops by itself while running freezes the machine (see settleAudio). A headset
        // taking the audio device over for an immersive session does that, with no click for armAudioUnlock
        this.audioContext.onstatechange = () => {
            if (this.audioWanted && this.audioContext.state !== 'running' && this.audioContext.state !== 'closed') {
                this.resumeAudio();
            }
        };
        this.audioNode = audioNode;
        this.mainThreadVideo = mainThreadVideo;
        this.worker.onmessage = event => this.onWorkerMessage(event.data);
    }

    static async create(options: CoreOptions): Promise<Core> {
        // the core produces samples at a fixed rate, so the graph runs at that rate and needs no resampling
        const audioContext = new AudioContext({
            latencyHint: 'interactive',
            sampleRate: VB_SAMPLE_RATE,
        });
        markLoadTrace('core: new AudioContext');
        await audioContext.suspend();
        markLoadTrace('core: audio suspend');
        await audioContext.audioWorklet.addModule(options.audioWorkletUrl);
        markLoadTrace('core: worklet addModule');

        const audioNode = new AudioWorkletNode(audioContext, VB_AUDIO_PROCESSOR, {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
        audioNode.connect(audioContext.destination);

        // sample buffers cycle directly between worker and worklet, never passing through the DOM thread
        const channel = new MessageChannel();
        await new Promise<void>(resolve => {
            audioNode.port.onmessage = () => resolve();
            audioNode.port.postMessage({ core: channel.port1 }, [channel.port1]);
        });
        audioNode.port.onmessage = null;
        markLoadTrace('core: worklet handshake');

        const worker = new Worker(options.workerUrl);
        const core = new Core(
            worker, audioContext, audioNode, options.mainThreadVideo ?? false);

        await new Promise<void>((resolve, reject) => {
            core.pending.set(0, { resolve: () => resolve(), reject });
            worker.postMessage({ audioPort: channel.port2 }, [channel.port2]);
        });
        markLoadTrace('core: worker started');

        await core.request('init', {
            wasmUrl: options.wasmUrl,
            rcheevosModuleUrl: options.rcheevosModuleUrl,
        });
        markLoadTrace('core: wasm init');
        return core;
    }

    // the state struct's size as a build fingerprint, which a link session compares before agreeing to play
    async stateSize(): Promise<number> {
        return this.request('stateSize', {});
    }

    async createSim(): Promise<Sim> {
        const handle = await this.request('createSim', {});
        return new Sim(this, handle);
    }

    async attachCanvas(
        sim: SimHandle,
        canvas: HTMLCanvasElement,
        mode: DisplayMode,
        output?: DisplayOutput,
    ): Promise<void> {
        this.detachCanvas(sim);
        if (!this.mainThreadVideo) {
            const offscreen = canvas.transferControlToOffscreen();
            await this.request('attachCanvas', { sim, canvas: offscreen }, [offscreen]);
            return;
        }

        const presentation = this.nextPresentation++;
        const renderer = new VbRenderer(canvas, mode);
        renderer.setDisplayOutput(output);
        this.mainThreadRenderers.set(sim, { presentation, renderer });
        const buffers = Array.from(
            { length: VIDEO_TRANSFER_BUFFERS }, () => new ArrayBuffer(VIDEO_FRAME_BYTES));
        try {
            await this.request(
                'attachCanvas',
                { sim, mainThread: { presentation, buffers } },
                buffers,
            );
        } catch (error) {
            const attached = this.mainThreadRenderers.get(sim);
            if (attached?.presentation === presentation) {
                this.detachCanvas(sim);
            }
            throw error;
        }
    }

    setMainThreadDisplayMode(sim: SimHandle, mode: DisplayMode): void {
        this.mainThreadRenderers.get(sim)?.renderer.setDisplayMode(mode);
    }

    setMainThreadDisplayOutput(sim: SimHandle, output: DisplayOutput | undefined): void {
        this.mainThreadRenderers.get(sim)?.renderer.setDisplayOutput(output);
    }

    async captureMainThread(
        sim: SimHandle,
        mode?: DisplayMode,
        scale = 1,
    ): Promise<ArrayBuffer> {
        if (!mode) {
            const liveRenderer = this.mainThreadRenderers.get(sim)?.renderer;
            if (!liveRenderer) {
                throw new Error('The emulator has nothing to capture yet.');
            }
            // as in the worker's capture: the live buffer only fits while it is the mode's own size and not held (then
            // it shows an older frame)
            if (liveRenderer.atModeSize && !this.pagesHeld.has(sim)) {
                return liveRenderer.capture(scale);
            }
            mode = liveRenderer.displayMode;
        }

        const frame = await this.request('readFrame', { sim });
        // one renderer, kept and retuned like the worker's. Every save state and Continue entry is a screenshot, so a
        // fresh WebGL context per capture would run the browser out of them
        if (!this.screenshotRenderer) {
            this.screenshotRenderer = new VbRenderer(document.createElement('canvas'), mode);
        } else {
            this.screenshotRenderer.setDisplayMode(mode);
        }
        // with blending, the frames before go in first, as in the worker's capture
        const previous = mode.frameBlending !== FrameBlending.OFF ? frame.previous : [];
        const renderer = this.screenshotRenderer;
        [...previous].reverse().forEach((before, index) =>
            renderer.present(new Uint8Array(before.pixels), before.colorMode, index === 0 ? 'jump' : 'next'));
        renderer.present(
            new Uint8Array(frame.pixels), frame.colorMode, previous.length > 0 ? 'next' : 'jump');
        return this.screenshotRenderer.capture(scale);
    }

    detachCanvas(sim: SimHandle): void {
        const attached = this.mainThreadRenderers.get(sim);
        attached?.renderer.dispose();
        this.mainThreadRenderers.delete(sim);
        this.videoTaps.delete(sim);
        this.videoTapHandlers.delete(sim);
    }

    /**
     * Copies every frame a machine presents to `handle` (video recording, headset); no handler stops the tap. The
     * handler gets the uncomposited buffer and must be done with it on return, as it goes straight back to the worker
     * to be refilled. `owner` names the taker, so one stopping leaves the others theirs. `replacesPage` is for a taker
     * that shows every frame where nobody sees the page (the headset), so the page is not drawn meanwhile.
     */
    async setVideoTap(
        sim: SimHandle,
        handle?: (frame: Frame) => void,
        owner = 'recording',
        replacesPage = false,
    ): Promise<void> {
        const holders = this.pageHolders.get(sim) ?? new Set<string>();
        if (handle && replacesPage) {
            holders.add(owner);
        } else {
            holders.delete(owner);
        }
        if (holders.size > 0) {
            this.pageHolders.set(sim, holders);
        } else {
            this.pageHolders.delete(sim);
        }
        // let go before the tap closes, so the page is shown again while the last tapped frame is still current
        if (!handle) {
            await this.syncPageHold(sim);
        }
        let handlers = this.videoTapHandlers.get(sim);
        if (handle) {
            if (!handlers) {
                handlers = new Map();
                this.videoTapHandlers.set(sim, handlers);
            }
            handlers.set(owner, handle);
        } else if (handlers) {
            handlers.delete(owner);
            if (handlers.size === 0) {
                this.videoTapHandlers.delete(sim);
            }
        }
        try {
            await this.syncVideoTap(sim);
        } catch (error) {
            // a tap that could not be opened leaves nobody waiting on it, and the page shown
            if (handle && this.videoTapHandlers.get(sim)?.get(owner) === handle) {
                this.videoTapHandlers.get(sim)?.delete(owner);
            }
            this.pageHolders.get(sim)?.delete(owner);
            await this.syncPageHold(sim).catch(() => undefined);
            throw error;
        }
        if (handle) {
            await this.syncPageHold(sim);
        }
    }

    // for a sim being deleted, whose hold goes with it in the worker
    forgetPageHold(sim: SimHandle): void {
        this.pageHolders.delete(sim);
        this.pagesHeld.delete(sim);
    }

    protected async syncPageHold(sim: SimHandle): Promise<void> {
        const held = (this.pageHolders.get(sim)?.size ?? 0) > 0;
        if (held === this.pagesHeld.has(sim)) {
            return;
        }
        if (held) {
            this.pagesHeld.add(sim);
        } else {
            this.pagesHeld.delete(sim);
        }
        try {
            await this.request('holdPage', { sim, held });
        } catch (error) {
            if (held) {
                this.pagesHeld.delete(sim);
            }
            throw error;
        }
    }

    protected syncVideoTap(sim: SimHandle): Promise<void> {
        const run = this.videoTapSync.catch(() => undefined).then(async () => {
            const wanted = (this.videoTapHandlers.get(sim)?.size ?? 0) > 0;
            if (wanted === this.videoTaps.has(sim)) {
                return;
            }
            if (!wanted) {
                this.videoTaps.delete(sim);
                await this.request('setVideoTap', { sim });
                return;
            }
            const presentation = this.nextPresentation++;
            this.videoTaps.set(sim, presentation);
            const buffers = Array.from(
                { length: VIDEO_TRANSFER_BUFFERS }, () => new ArrayBuffer(VIDEO_FRAME_BYTES));
            try {
                await this.request(
                    'setVideoTap', { sim, tap: { presentation, buffers } }, buffers);
            } catch (error) {
                if (this.videoTaps.get(sim) === presentation) {
                    this.videoTaps.delete(sim);
                }
                throw error;
            }
        });
        this.videoTapSync = run;
        return run;
    }

    // exposed so a recording can mix other sources into the same context (the only way two sources reach one
    // recorded track). Never retune it: it runs at the core's sample rate on purpose, and its state follows emulation
    get audio(): AudioContext {
        return this.audioContext;
    }

    // free, as the worklet is asked for its quantum once however many listen
    connectAudio(node: AudioNode): void {
        this.audioNode.connect(node);
    }

    disconnectAudio(node: AudioNode): void {
        try {
            this.audioNode.disconnect(node);
        } catch {
            // throws for something not connected, e.g. a recording already torn down
        }
    }

    // the audio is asked to start but never waited for: Firefox leaves `resume()` pending until an untouched page is
    // touched, which left the second player's window black. armAudioUnlock lets the gesture bring the sound later
    async run(): Promise<void> {
        this.audioWanted = true;
        // a context nobody here suspended may still need starting (autoplay policy, a host that took the audio
        // device). Once per call, so it cannot spin. `state` is only trusted in this direction, see audioStillBlocked
        if (this.audioContext.state !== 'running') {
            this.audioApplied = false;
        }
        this.armAudioUnlock();
        // not awaited, and before the worker, so the graph is already producing when the first chunk arrives
        this.settleAudio();
        await this.request('run', {});
        this.traceAudioClock().catch(() => undefined);
    }

    // TEMPORARY, see load-trace.ts: when the audio clock first moves, which is when the machine really starts
    protected async traceAudioClock(): Promise<void> {
        const before = this.audioContext.currentTime;
        const until = performance.now() + 15000;
        while (performance.now() < until && !this.disposed) {
            if (this.audioContext.currentTime !== before) {
                endLoadTrace(`audio clock moving (${this.audioContext.state}, ${this.audioContext.sampleRate} Hz)`);
                return;
            }
            await delay(10);
        }
        endLoadTrace(`audio clock still (${this.audioContext.state})`);
    }

    async suspend(): Promise<void> {
        this.audioWanted = false;
        this.disarmAudioUnlock();
        // the worker first, so audio it already handed over plays out rather than being cut off mid-buffer
        await this.request('suspend', {});
        await this.settleAudio();
    }

    // one transition at a time, re-reading the wish so the last word wins: a pause and quick resume can reach the
    // context in either order, and a context left suspended while the worker emulates freezes the machine, as the
    // drive loop is clocked by the worklet asking for samples (see vb-worker.ts)
    protected settleAudio(): Promise<void> {
        this.audioSettling ??= this.driveAudio()
            .finally(() => { this.audioSettling = undefined; });
        return this.audioSettling;
    }

    protected async driveAudio(): Promise<void> {
        while (this.audioWanted !== this.audioApplied) {
            this.audioApplied = this.audioWanted;
            if (this.audioApplied) {
                this.audioResume = this.audioContext.resume().catch(() => undefined);
            } else {
                await Promise.race([
                    this.audioContext.suspend().catch(() => undefined),
                    // a suspend() that never settles would wedge this loop and every resume after it; the worker has
                    // already stopped anyway
                    delay(Core.AUDIO_TRANSITION_TIMEOUT_MS),
                ]);
            }
        }
    }

    // blocked audio blocks the machine too, as the worklet clocks the drive loop. Asked of the clock, as Firefox reports
    // `running` for a context the autoplay policy still holds back. Waits for the resume to settle (or `within`), then
    // for the clock to have had a chance to move
    async audioStillBlocked(within = 750): Promise<boolean> {
        await Promise.race([this.audioResume ?? Promise.resolve(), delay(within)]);
        const before = this.audioContext.currentTime;
        await delay(250);
        return this.audioContext.currentTime === before;
    }

    // for a host that knows of a gesture the page's listeners cannot hear (a headset trigger), which counts like a
    // click for the autoplay policy
    resumeAudio(): void {
        if (!this.audioWanted || this.disposed) {
            return;
        }
        this.audioResume = this.audioContext.resume()
            .then(() => this.onDidUnblockAudioEmitter.fire())
            .catch(() => undefined);
    }

    // for a host that just moved the audio into or out of a headset: a Quest switches the output device, and the
    // context can keep reporting `running` with a frozen clock. resume() does nothing then, but a suspend first makes
    // the browser open the output afresh. Says whether it had to
    async restartStalledAudio(): Promise<boolean> {
        if (!this.audioWanted || this.disposed || !await this.audioStillBlocked()) {
            return false;
        }
        if (!this.audioWanted || this.disposed) {
            return false;
        }
        await this.settleAudio();
        await Promise.race([
            this.audioContext.suspend().catch(() => undefined),
            delay(Core.AUDIO_TRANSITION_TIMEOUT_MS),
        ]);
        this.audioApplied = false; // applies the last wish again, from a suspended graph
        await this.settleAudio();
        return true;
    }

    // armed whenever the machine starts, as `state` cannot be trusted (see audioStillBlocked) and resuming a
    // producing context costs nothing
    protected armAudioUnlock(): void {
        if (this.audioUnlock) {
            return;
        }
        const unlock = (): void => {
            this.audioContext.resume()
                .then(() => this.onDidUnblockAudioEmitter.fire())
                .catch(() => undefined);
            this.disarmAudioUnlock();
        };
        // captured, so a handler that stops propagation (the emulator's own key handling) cannot swallow it
        const types = ['pointerdown', 'keydown', 'touchstart'] as const;
        for (const type of types) {
            window.addEventListener(type, unlock, true);
        }
        this.audioUnlock = () => {
            for (const type of types) {
                window.removeEventListener(type, unlock, true);
            }
            this.audioUnlock = undefined;
        };
    }

    protected disarmAudioUnlock(): void {
        this.audioUnlock?.();
    }

    // 1 is real time
    async setSpeed(speed: number): Promise<void> {
        await this.request('setSpeed', { speed });
    }

    // percent of the stereo parallax: 0 flat, 100 the real console, 200 twice as deep
    async setStereoDepth(depth: number): Promise<void> {
        await this.request('setStereoDepth', { depth });
    }

    // columns where the column table puts them, or evenly spaced
    async setColumnGeometry(enabled: boolean): Promise<void> {
        await this.request('setColumnGeometry', { enabled });
    }

    async setMirrorSpinUp(enabled: boolean, fullDelay: boolean): Promise<void> {
        await this.request('setMirrorSpinUp', { enabled, fullDelay });
    }

    // only useful while suspended
    async stepFrame(): Promise<void> {
        await this.request('stepFrame', {});
    }

    // snapshots are stored uncompressed, so budget / state size is how many are kept
    async setRewind(enabled: boolean, granularity: number, budgetBytes: number): Promise<void> {
        await this.request('setRewind', { enabled, granularity, budgetBytes });
    }

    // returns how many entries were applied, so playback can tell the history is exhausted. Several per call keep
    // intermediate states off the screen
    async rewindStep(count = 1): Promise<number> {
        return this.request('rewindStep', { count });
    }

    // `index` into what rewindHistory described; resolves to the one landed on
    async rewindSeek(index: number): Promise<number> {
        return this.request('rewindSeek', { index });
    }

    // see Sim.rewindThumbnail; composed here when the DOM thread presents, like captureMainThread
    async rewindThumbnailMainThread(sim: SimHandle, index: number): Promise<ArrayBuffer | undefined> {
        const live = this.mainThreadRenderers.get(sim)?.renderer;
        const frame = live && await this.request('readRewindThumbnail', { index });
        if (!live || !frame) {
            return undefined;
        }
        const mode = thumbnailDisplayMode(live.displayMode);
        if (!this.screenshotRenderer) {
            this.screenshotRenderer = new VbRenderer(document.createElement('canvas'), mode);
        } else {
            this.screenshotRenderer.setDisplayMode(mode);
        }
        this.screenshotRenderer.present(new Uint8Array(frame.pixels), frame.colorMode, 'jump');
        return this.screenshotRenderer.capture();
    }

    // RetroAchievements

    async raLoginPassword(username: string, password: string): Promise<VesRaUser> {
        return this.request('raLoginPassword', { username, password });
    }

    async raLoginToken(username: string, token: string): Promise<VesRaUser> {
        return this.request('raLoginToken', { username, token });
    }

    async raLogout(): Promise<void> {
        await this.request('raLogout', {});
    }

    // the answer to a server call the engine asked for
    async raProvideResponse(requestId: number, status: number, body: string): Promise<void> {
        await this.request('raProvideResponse', { requestId, status, body });
    }

    async raUnloadGame(): Promise<void> { // keeps the account
        await this.request('raUnloadGame', {});
    }

    async raReset(): Promise<void> {
        await this.request('raReset', {});
    }

    // set before Sim.raLoadGame so a set loads in the right mode
    async raSetHardcore(enabled: boolean): Promise<void> {
        await this.request('raSetHardcore', { enabled });
    }

    // `firstEntry` is 1-based and ignored when `aroundUser` asks for the page the user is in
    async raFetchLeaderboardEntries(
        leaderboardId: number, firstEntry: number, count: number, aroundUser: boolean,
    ): Promise<VesRaLeaderboardEntries> {
        return this.request('raFetchLeaderboardEntries', { leaderboardId, firstEntry, count, aroundUser });
    }

    async request<K extends CommandName>(
        command: K,
        params: Params<K>,
        transfer: Transferable[] = []
    ): Promise<Result<K>> {
        if (this.disposed) {
            throw new Error('The emulator core has been disposed.');
        }
        const id = this.nextRequestId++;
        return new Promise<Result<K>>((resolve, reject) => {
            this.pending.set(id, { resolve: result => resolve(result as Result<K>), reject });
            const request: Request<K> = { id, command, params };
            this.worker.postMessage(request, transfer);
        });
    }

    protected onWorkerMessage(message: Outbound): void {
        if (isVbEvent(message)) {
            if (message.event === 'error') {
                this.onErrorEmitter.fire(message.payload.message);
            } else if (message.event === 'frame') {
                const frame = message.payload;
                const attached = this.mainThreadRenderers.get(frame.sim);
                try {
                    if (attached?.presentation === frame.presentation) {
                        attached.renderer.present(new Uint8Array(frame.pixels), frame.colorMode, frame.kind);
                    } else if (this.videoTaps.get(frame.sim) === frame.presentation) {
                        // one by one, so one failing does not cost the others their frame
                        for (const handle of this.videoTapHandlers.get(frame.sim)?.values() ?? []) {
                            try {
                                handle(frame);
                            } catch (error) {
                                this.onErrorEmitter.fire(error instanceof Error ? error.message : String(error));
                            }
                        }
                    }
                } catch (error) {
                    this.onErrorEmitter.fire(error instanceof Error ? error.message : String(error));
                } finally {
                    this.worker.postMessage({
                        videoFrame: {
                            sim: frame.sim,
                            presentation: frame.presentation,
                            pixels: frame.pixels,
                        },
                    }, [frame.pixels]);
                }
            } else if (message.event === 'terminal') {
                this.onTerminalEmitter.fire(message.payload);
            } else if (message.event === 'link') {
                this.onLinkEmitter.fire(message.payload);
            } else if (message.event === 'esSound') {
                this.onEsSoundEmitter.fire(message.payload);
            } else if (message.event === 'sram') {
                this.onSramEmitter.fire(message.payload);
            } else if (message.event === 'pointerWrite') {
                this.onPointerWriteEmitter.fire(message.payload);
            } else if (message.event === 'speed') {
                this.onSpeedEmitter.fire(message.payload);
            } else if (message.event === 'digest') {
                this.onDigestEmitter.fire(message.payload);
            } else if (message.event === 'progress') {
                this.onProgressEmitter.fire(message.payload);
            } else if (message.event === 'awaitingInput') {
                this.onAwaitingInputEmitter.fire(message.payload);
            } else if (message.event === 'stopped') {
                this.onStoppedEmitter.fire(message.payload);
            } else if (message.event === 'pixelOrigins') {
                this.onPixelOriginsEmitter.fire(message.payload);
            } else if (message.event === 'stalled') {
                this.onStalledEmitter.fire(message.payload);
            } else if (message.event === 'retroAchievements') {
                for (const raEvent of message.payload.events) {
                    this.onRetroAchievementsEmitter.fire(raEvent);
                }
            }
            return;
        }

        const response = message as Response;
        const pending = this.pending.get(response.id);
        if (!pending) {
            return;
        }
        this.pending.delete(response.id);
        if (response.error !== undefined) {
            pending.reject(new Error(response.error));
        } else {
            pending.resolve(response.result);
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const pending of this.pending.values()) {
            pending.reject(new Error('The emulator core has been disposed.'));
        }
        this.pending.clear();
        this.disarmAudioUnlock();
        for (const sim of [...this.mainThreadRenderers.keys()]) {
            this.detachCanvas(sim);
        }
        this.screenshotRenderer?.dispose();
        this.screenshotRenderer = undefined;
        this.audioNode.disconnect();
        this.worker.terminate();
        this.audioContext.close();
        this.onDidUnblockAudioEmitter.dispose();
        this.onErrorEmitter.dispose();
        this.onTerminalEmitter.dispose();
        this.onLinkEmitter.dispose();
        this.onPointerWriteEmitter.dispose();
        this.onSpeedEmitter.dispose();
        this.onDigestEmitter.dispose();
        this.onProgressEmitter.dispose();
        this.onAwaitingInputEmitter.dispose();
        this.onStoppedEmitter.dispose();
        this.onPixelOriginsEmitter.dispose();
        this.onStalledEmitter.dispose();
        this.onRetroAchievementsEmitter.dispose();
    }
}

// FNV-1a a word at a time; a cartridge is a power of two of at least a few KB, so there is never a tail
function digestBytes(buffer: ArrayBuffer): number {
    const words = new Uint32Array(buffer, 0, buffer.byteLength >>> 2);
    let hash = 0x811c9dc5;
    for (let i = 0; i < words.length; i++) {
        hash = Math.imul(hash ^ words[i], 0x01000193);
    }
    return (hash ^ buffer.byteLength) >>> 0;
}

export class Sim implements Disposable {

    protected disposed = false;
    protected vbcHardware = true;
    // mirrored so a page-side renderer can be configured before attachment
    protected displayMode = VB_DEFAULT_DISPLAY_MODE;
    protected displayOutput: DisplayOutput | undefined;
    // what the machine is actually running, not what the settings would give it next start; see runningCartridge
    protected cartRomDigest: number | undefined;
    protected esSoundCapture = false;

    protected readonly onRestartEmitter = new Emitter<void>();
    // reset or a different cartridge, which a sim outlives, so anything holding on to what this machine has done
    // needs to hear it
    readonly onRestart: Event<void> = this.onRestartEmitter.event;

    constructor(
        protected readonly core: Core,
        readonly handle: SimHandle
    ) { }

    // control is normally transferred to the worker. On the Linux desktop the element stays on this thread, as
    // WebKitGTK cannot create the worker's WebGL context
    async attachCanvas(canvas: HTMLCanvasElement): Promise<void> {
        await this.core.attachCanvas(this.handle, canvas, this.displayMode, this.displayOutput);
    }

    async setCartRom(rom: ArrayBuffer): Promise<void> {
        this.cartRomDigest = digestBytes(rom); // before the transfer, which detaches it
        await this.core.request('setCartRom', { sim: this.handle, rom }, [rom]);
        this.onRestartEmitter.fire();
    }

    async setCartRam(ram: ArrayBuffer): Promise<void> {
        await this.core.request('setCartRam', { sim: this.handle, ram }, [ram]);
    }

    // pass a length wherever one is known, as the window is the whole 16 MiB of Game Pak RAM. cartRamInfo says what to
    // ask for
    async getCartRam(length?: number): Promise<ArrayBuffer> {
        return this.core.request('getCartRam', { sim: this.handle, length });
    }

    // `used` is how far into the save window the game has written
    async cartRamInfo(): Promise<{ size: number, used: number }> {
        return this.core.request('cartRamInfo', { sim: this.handle });
    }

    async reset(): Promise<void> {
        await this.core.request('reset', { sim: this.handle });
        this.onRestartEmitter.fire();
    }

    // VB Color hardware only makes color available, the game still has to switch it on
    async setHardwareMode(vbc: boolean): Promise<void> {
        this.vbcHardware = await this.core.request('setHardwareMode', { sim: this.handle, vbc });
    }

    get isVbcHardware(): boolean {
        return this.vbcHardware;
    }

    // frame-numbered setKeys, so two machines see the same press on the same frame; see queueKeys in vb-protocol.ts
    async queueKeys(frame: number, keys: number): Promise<void> {
        await this.core.request('queueKeys', { sim: this.handle, frame, keys });
    }

    // frame-numbered setCheats and writeMemory, so two machines see the same change on the same frame
    async queueEdits(frame: number, edits: ScheduledEdit[]): Promise<void> {
        await this.core.request('queueEdits', { sim: this.handle, frame, edits });
    }

    // won't run past the input booked with queueKeys
    async setLockstep(enabled: boolean): Promise<void> {
        await this.core.request('setLockstep', { sim: this.handle, enabled });
    }

    // of everything the emulated program can see, for telling two machines apart
    async stateDigest(): Promise<{ frame: number, digest: number }> {
        return this.core.request('stateDigest', { sim: this.handle });
    }

    // 0 stops. Taken on frame numbers, so two machines can be compared at the same point; arrives as Core.onDigest
    async setDigestPeriod(frames: number): Promise<void> {
        await this.core.request('setDigestPeriod', { sim: this.handle, frames });
    }

    // see linkJournal in vb-protocol.ts
    async linkJournal(): Promise<LinkJournalEntry[]> {
        return this.core.request('linkJournal', { sim: this.handle });
    }

    get id(): SimHandle {
        return this.handle;
    }

    async setKeys(keys: number): Promise<void> { // VbKey mask
        await this.core.request('setKeys', { sim: this.handle, keys });
    }

    // `rate` frames pressed and `rate` released
    async setTurbo(keys: number, rate: number): Promise<void> {
        await this.core.request('setTurbo', { sim: this.handle, keys, rate });
    }

    // also resizes the presentation surface, as the stereo layouts differ in geometry
    async setDisplayMode(mode: DisplayMode): Promise<void> {
        this.displayMode = mode;
        this.core.setMainThreadDisplayMode(this.handle, mode);
        await this.core.request('setDisplayMode', { sim: this.handle, mode });
    }

    // where an interleaved picture is really shown (see DisplayOutput)
    async setDisplayOutput(output: DisplayOutput | undefined): Promise<void> {
        const same = output === this.displayOutput || (output && this.displayOutput
            && output.width === this.displayOutput.width
            && output.height === this.displayOutput.height
            && output.parity === this.displayOutput.parity);
        if (same) {
            return;
        }
        this.displayOutput = output;
        this.core.setMainThreadDisplayOutput(this.handle, output);
        await this.core.request('setDisplayOutput', { sim: this.handle, output });
    }

    // without `mode` as on screen at its own size, with one composed again to it
    async capture(mode?: DisplayMode, scale?: number): Promise<ArrayBuffer> {
        if (this.core.mainThreadVideo) {
            return this.core.captureMainThread(
                this.handle, mode, scale);
        }
        return this.core.request('capture', { sim: this.handle, mode, scale });
    }

    // only while suspended. Captures the current moment first, see CoreCommands.rewindHistory
    async rewindHistory(): Promise<RewindHistory> {
        return this.core.request('rewindHistory', { sim: this.handle });
    }

    // in the palette on screen, one eye where the screen shows two side by side
    async rewindThumbnail(index: number): Promise<ArrayBuffer | undefined> {
        if (this.core.mainThreadVideo) {
            return this.core.rewindThumbnailMainThread(this.handle, index);
        }
        return this.core.request('rewindThumbnail', { sim: this.handle, index });
    }

    // uncomposited, with the ones before it: what a new presentation starts from
    async readFrame(): Promise<Frame & { previous: Frame[] }> {
        return this.core.request('readFrame', { sim: this.handle });
    }

    // see Core.setVideoTap
    async setVideoTap(handle?: (frame: Frame) => void, owner?: string, replacesPage?: boolean): Promise<void> {
        await this.core.setVideoTap(this.handle, handle, owner, replacesPage);
    }

    async saveState(): Promise<ArrayBuffer> {
        return this.core.request('saveState', { sim: this.handle });
    }

    // `clearCaches` for a state made with another ROM, see the protocol
    async loadState(state: ArrayBuffer, options: { clearCaches?: boolean } = {}): Promise<void> {
        await this.core.request('loadState', { sim: this.handle, state, clearCaches: options.clearCaches }, [state]);
    }

    // costs a snapshot now and the input per frame after. Emulation is deterministic, so replaying the input from
    // the same state reproduces the run and the profile is collected exhaustively afterwards
    async startProfileRecording(): Promise<void> {
        await this.core.request('startProfileRecording', { sim: this.handle });
    }

    async stopProfileRecording(): Promise<Recording> {
        return this.core.request('stopProfileRecording', { sim: this.handle });
    }

    // runs on a sim of its own, but occupies the worker until done, roughly a sixth of the recorded time
    async replayProfile(recording: Recording): Promise<ProfileResult> {
        return this.core.request('replayProfile', { sim: this.handle, recording });
    }

    // costs a callback on every instruction, so whoever switches it on owns switching it off
    async setLiveProfiler(enabled: boolean, window?: number): Promise<void> {
        await this.core.request('setLiveProfiler', { sim: this.handle, enabled, window });
    }

    // undefined if no window is kept. `pin` unpacks that frame alongside the aggregate while it is still in the window
    async readLiveProfile(pin?: number): Promise<LiveProfileSnapshot | undefined> {
        return this.core.request('readLiveProfile', { sim: this.handle, pin });
    }

    // undefined disconnects. `order` is this sim's end of the cable; both windows of a link session name the same end
    // for the same player's machine, so they emulate the pair identically (see setPeer in vb-protocol.ts)
    async setPeer(peer: Sim | undefined, order?: 1 | 2): Promise<void> {
        await this.core.request('setPeer', { sim: this.handle, peer: peer?.handle ?? 0, order });
    }

    // eye-packed: red is the left eye's brightness, green the right eye's
    async readPixels(x: number, y: number, width: number, height: number): Promise<ArrayBuffer> {
        return this.core.request('readPixels', { sim: this.handle, x, y, width, height });
    }

    // framebuffer averaged into a stereo grid, legacy brightness or VBC RGB555 as the result says
    async readBackdrop(columns: number, rows: number): Promise<Backdrop> {
        return this.core.request('readBackdrop', { sim: this.handle, columns, rows });
    }

    // only worth it while paused
    async refreshFrame(): Promise<void> {
        await this.core.request('refreshFrame', { sim: this.handle });
    }

    // as the CPU sees it
    async readMemory(address: number, length: number): Promise<ArrayBuffer> {
        return this.core.request('readMemory', { sim: this.handle, address, length });
    }

    async writeMemory(address: number, data: ArrayBuffer): Promise<void> {
        await this.core.request('writeMemory', { sim: this.handle, address, data }, [data]);
    }

    async readRegisters(): Promise<Registers> {
        return this.core.request('readRegisters', { sim: this.handle });
    }

    // `before` is the core's job: instructions are two or four bytes and nothing says which, so only decoding
    // forwards from a known point finds where the previous one began
    async disassemble(
        address: number, count: number, before = 0,
    ): Promise<DisassemblyLine[]> {
        return this.core.request('disassemble', { sim: this.handle, address, count, before });
    }

    // the whole set; an empty list also takes the costly per-instruction callback off the core
    async setBreakpoints(addresses: number[]): Promise<void> {
        await this.core.request('setBreakpoints', { sim: this.handle, addresses });
    }

    // only while suspended
    async stepInstruction(): Promise<void> {
        await this.core.request('stepInstruction', { sim: this.handle });
    }

    // one-shot stop; starting the machine is up to whoever owns the pause (see runTo in vb-protocol.ts)
    async runTo(address: number): Promise<void> {
        await this.core.request('runTo', { sim: this.handle, address });
    }

    onStopped(listener: (stop: { address: number, reason: StopReason, write?: StopWrite }) => void): Disposable {
        return this.core.onStopped(event => {
            if (event.sim === this.handle) {
                listener({ address: event.address, reason: event.reason, write: event.write });
            }
        });
    }

    // costs a callback on every CPU write, so only on while something displays the output
    async setTerminalCapture(enabled: boolean): Promise<void> {
        await this.core.request('setTerminalCapture', { sim: this.handle, enabled });
    }

    onTerminal(listener: (text: string) => void): Disposable {
        return this.core.onTerminal(event => {
            if (event.sim === this.handle) {
                listener(event.text);
            }
        });
    }

    // costs a callback on every CPU write, so only on while something is on the other end of the cable
    async setLinkCapture(enabled: boolean): Promise<void> {
        await this.core.request('setLinkCapture', { sim: this.handle, enabled });
    }

    onLink(listener: (bytes: number[]) => void): Disposable {
        return this.core.onLink(event => {
            if (event.sim === this.handle) {
                listener(event.bytes);
            }
        });
    }

    // costs the same per-write callback, so off unless the ROM has audio files for it to play
    async setEsSoundCapture(enabled: boolean): Promise<void> {
        await this.core.request('setEsSoundCapture', { sim: this.handle, enabled });
        this.esSoundCapture = enabled;
    }

    isRunning(image: ArrayBuffer): boolean {
        return this.cartRomDigest !== undefined && digestBytes(image) === this.cartRomDigest;
    }

    // undefined before a cartridge. The machine's own answer, not the settings: a former player 2 window keeps running
    // player 1's image after the link ends, and a link picking up two running games must know they match
    get runningCartridge(): string | undefined {
        return this.cartRomDigest === undefined
            ? undefined
            : `${this.cartRomDigest.toString(16)}:${this.vbcHardware ? 'vbc' : 'vb'}:${this.esSoundCapture ? 'es' : '-'}`;
    }

    onEsSound(listener: (commands: number[]) => void): Disposable {
        return this.core.onEsSound(event => {
            if (event.sim === this.handle) {
                listener(event.commands);
            }
        });
    }

    // costs a call out of the core on every access. Directions are separate, as a game reads its save far more often
    // than it writes
    async setSramCapture(writes: boolean, reads: boolean): Promise<void> {
        await this.core.request('setSramCapture', { sim: this.handle, writes, reads });
    }

    onSram(listener: (runs: SramRun[]) => void): Disposable {
        return this.core.onSram(event => {
            if (event.sim === this.handle) {
                listener(event.runs);
            }
        });
    }

    // repeated at every frame break by the core itself; none stops
    async setCheats(codes: VbCheatWrite[]): Promise<void> {
        await this.core.request('setCheats', { sim: this.handle, codes });
    }

    // for readPixelOrigins; one sim per worker at a time
    async setPixelOrigins(enabled: boolean): Promise<void> {
        await this.core.request('setPixelOrigins', { sim: this.handle, enabled });
    }

    // two words a pixel per eye, left eye first; undefined while origins are not kept. See vb-pixel-origin.ts
    async readPixelOrigins(): Promise<Uint32Array | undefined> {
        const buffer = await this.core.request('readPixelOrigins', { sim: this.handle });
        return buffer.byteLength > 0
            ? decodeOriginRuns(new Uint32Array(buffer), VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT * 2)
            : undefined;
    }

    async streamPixelOrigins(enabled: boolean): Promise<void> {
        await this.core.request('streamPixelOrigins', { sim: this.handle, enabled });
    }

    onPixelOrigins(listener: (origins: Uint32Array) => void): Disposable {
        return this.core.onPixelOrigins(event => {
            if (event.sim === this.handle) {
                listener(decodeOriginRuns(new Uint32Array(event.runs), VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT * 2));
            }
        });
    }

    // stops once after the next write into any of these ranges, an empty list is off
    async setWriteStop(ranges: { address: number, length: number }[]): Promise<void> {
        await this.core.request('setWriteStop', { sim: this.handle, ranges });
    }

    // reports each 32-bit value stored there, 0 stops. One address at a time, at the per-write callback cost
    async setPointerWatch(address: number): Promise<void> {
        await this.core.request('setPointerWatch', { sim: this.handle, address });
    }

    onPointerWrite(listener: (values: number[]) => void): Disposable {
        return this.core.onPointerWrite(event => {
            if (event.sim === this.handle) {
                listener(event.values);
            }
        });
    }

    // the VSU map (waveform banks, modulation table, six channel blocks) and how loud its last frame was, composed by
    // the worker from core state, as hardware and core refuse reads of the VSU range
    async readVsu(): Promise<VsuReading> {
        return this.core.request('readVsu', { sim: this.handle });
    }

    // in the emulator's own mixer, so the game's state is untouched and the panel still shows what a muted channel
    // plays. 0 unmutes all
    async setVsuMutes(channels: number): Promise<void> {
        await this.core.request('setVsuMutes', { sim: this.handle, channels });
    }

    // the outcome arrives on Core.onRetroAchievements
    async raLoadGame(hash: string): Promise<void> {
        await this.core.request('raLoadGame', { sim: this.handle, hash });
    }

    async setVolume(volume: number): Promise<void> { // 0 to 10
        await this.core.request('setVolume', { sim: this.handle, volume });
    }

    async setPanning(panning: number): Promise<void> { // -1 to +1
        await this.core.request('setPanning', { sim: this.handle, panning });
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.onRestartEmitter.dispose();
        this.core.detachCanvas(this.handle);
        this.core.forgetPageHold(this.handle);
        this.core.request('deleteSim', { sim: this.handle }).catch(() => {
            // the core may already be gone
        });
    }
}
