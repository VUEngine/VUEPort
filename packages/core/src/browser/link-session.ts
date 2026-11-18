import { Disposable, DisposableCollection, Emitter, Event } from '../common/emulator-events';
import {
    LINK_PROTOCOL_VERSION,
    LinkChannel,
    LinkMachine,
    LinkMessage,
    LinkSeat,
} from '../common/link-channel';
import { LinkJournalEntry, ScheduledEdit } from '../common/vb-protocol';
import { DEFAULT_TURBO_RATE, withTurbo } from '../common/emulator-turbo';
import { Sim } from './core/vb-core';
import { EmulatorSession } from './emulator-core-service';

export enum LinkState {
    // announcing ourselves, nobody answering yet
    Waiting = 'waiting',
    Connected = 'connected',
    // connected, but stopped because the other window's input has not arrived
    Stalled = 'stalled',
    // over for good: the other window closed, or the two could never have played together. Not where an unlink leads:
    // then this window goes back to Waiting with its end of the cable plugged in, and the next hello resumes
    Closed = 'closed',
}

export interface LinkRefusal {
    // `left` is no failure: the other player unlinked, so this window goes back to Waiting (see LinkSession.peerGone).
    // Only `closed` (the other window went away) means nobody is left to link to; `timeout` (the other window went
    // quiet) and `failed` (this window cannot carry on) leave the other window where it was
    reason: 'protocol' | 'rom' | 'core' | 'seat' | 'left' | 'closed' | 'timeout' | 'failed' | 'ended'
        | 'desync' | 'edit';
    message: string;
}

// what one window knew when a session went wrong (machines stopped matching or advancing). Both windows write one;
// together they say whether both copies of each machine got the same run: the start and every mask and write
export interface LinkReport {
    reason: 'desync' | 'stalled';
    seat: LinkSeat;
    rom: string;
    delay: number;
    epoch: number;
    frame: number;
    mismatch?: { frame: number; mirror: number; theirs: number };
    // the save this run began from: the part that travelled (base64) and the window size it was expanded to
    cartRam?: string;
    cartRamWindow?: number;
    journals: { p1: LinkJournalEntry[]; p2: LinkJournalEntry[] };
}

export interface LinkSessionOptions {
    session: EmulatorSession;
    channel: LinkChannel;
    seat: LinkSeat;
    // CRC32 string of the cartridge both windows must be running
    rom: string;
    // the cartridge itself, for the mirror. Read when the mirror is built rather than held, as it is up to 16 MiB
    romData(): ArrayBuffer | undefined;
    // the core's state struct size, as a build check
    core: number;
    // frames between pressing a button and the machines acting on it. Only the answering window decides; the joining
    // one takes what it is told, so both always agree
    delay?: number;
    // changes this window's machine already runs under (in practice the enabled cheats), sent once at the start of
    // every run so the other window's mirror matches; otherwise the two come apart on the first frame a cheat touches.
    // Called rather than held, as they can change between a session being built and beginning
    standingEdits?(): ScheduledEdit[];
    onReport?(report: LinkReport): void;
    // the cartridge as this window's own machine runs it. Only the authority's answer shapes a session (it travels in
    // `begin`); the joiner's only matters for what its machine goes back to afterwards. Undefined means the file as
    // opened, on an original Virtual Boy, with no ESSound chip
    cartridge?(): LinkCartridge | undefined;
    // the other player paused or carried on, and this window should follow; see LinkSession.setPaused
    onPeerPaused?(paused: boolean): void;
    // started by the player pressing link rather than by the window taking up a seat on its own. Such a session asks
    // the other window to take part (see LinkCall) until it does
    calling?: boolean;
    // two windows that played together linking again; when both run the same code, their games are picked up where
    // they are instead of restarting (see LinkBegin.hot)
    rejoin?: boolean;
}

export interface LinkCartridge {
    // the patched image when any patch is on; undefined for the file as opened
    image?: ArrayBuffer;
    vbc: boolean;
    esSound: boolean;
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

// the authority's save as a whole save window: only the written part travels, but a machine needs the whole window or
// it disagrees on the first read past it. Zero-filled, not freshSaveRam, as both machines must hold identical bytes;
// what arrives always covers the baseline
function expandCartRam(cartRam: ArrayBuffer, window: number): ArrayBuffer {
    const ram = new Uint8Array(window);
    ram.set(new Uint8Array(cartRam, 0, Math.min(cartRam.byteLength, ram.length)));
    return ram.buffer;
}

/**
 * Two windows playing one linked game. Each window runs both machines in its own worker, its own and a mirror of the
 * other player's, and only a controller mask per frame per seat crosses between them. The core is deterministic
 * (tests/determinism-probe.mjs), and `setLockstep` in vb-protocol.ts stops a machine running past input that has not
 * arrived. So a window whose partner stopped stops too, a few frames later, like two VBs when one is unplugged.
 */
export class LinkSession implements Disposable {

    // how far ahead input is booked by default. 3 frames is 60 ms, far more than a BroadcastChannel needs and enough to
    // ride out ordinary hiccups. Netplay over a wire will want to negotiate this
    static readonly DEFAULT_DELAY_FRAMES = 3;
    static readonly HELLO_INTERVAL_MS = 500;
    // how long a window waits for the other one: a crashed window says no goodbye, and its partner would sit frozen
    // under lockstep for ever. Long enough for a slow tab waking up
    static readonly PEER_TIMEOUT_MS = 10000;
    static readonly MAX_PENDING_REMOTE = 600;
    // how often the windows check they still agree (about every second). Determinism should hold, but an unnoticed
    // desync is two people playing different games and blaming each other
    static readonly DIGEST_PERIOD_FRAMES = 60;
    // mirror digests kept while their counterpart is in flight, a couple of seconds' worth
    static readonly MAX_KEPT_DIGESTS = 8;
    static readonly MAX_PENDING_EDITS = 64;

    protected readonly toDispose = new DisposableCollection();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    protected readonly channel: LinkChannel;
    protected readonly emulatorSession: EmulatorSession;
    readonly seat: LinkSeat;
    protected readonly rom: string;
    protected readonly romData: () => ArrayBuffer | undefined;
    protected readonly coreBuild: number;

    protected mirror: Sim | undefined;
    protected delay: number;

    state = LinkState.Waiting;
    refusal: LinkRefusal | undefined;

    // booked against frames as they come up, not when it changes: under lockstep every frame needs an entry
    protected heldKeys = 0;
    // worked into each frame's mask as it is booked (the worker does it for a solo machine), as the mask crossing to
    // the other window has to be the one this machine runs with
    protected turboKeys = 0;
    protected turboRate = DEFAULT_TURBO_RATE;
    protected nextFrame = 0;
    protected machineFrame = 0;
    protected helloTimer: ReturnType<typeof setInterval> | undefined;
    protected stallTimer: ReturnType<typeof setTimeout> | undefined;
    protected disposed = false;
    // set the moment this window commits to starting. The joiner repeats hello until answered, so a second hello can
    // arrive while the first is still being acted on; without this it restarts the session, resetting the machines
    // again and leaving the windows booking against different frames
    protected beginning = false;
    // remote input that arrived before there was a mirror to put it in. Dropping it is fatal: under lockstep nothing
    // re-sends it, so the mirror waits for frame zero for ever and both windows stop
    protected readonly pendingRemote: { epoch: number, frame: number, keys: number }[] = [];
    // booked writes that arrived before there was a machine. The standing cheats travel once, at frame 0 of every run,
    // so dropping them would play the whole session against a machine the other window is not running
    protected readonly pendingEdits:
        { epoch: number, seat: LinkSeat, frame: number, edits: ScheduledEdit[] }[] = [];
    protected readonly standingEdits: () => ScheduledEdit[];
    // our copy of the other player's machine, by frame, held until their own digest for that frame arrives
    protected readonly mirrorDigests = new Map<number, number>();
    // the other window's digests that arrived before ours of our copy was taken. Kept, not dropped: the window a frame
    // or two behind gets every digest early, and dropping them meant a desync in the window ahead was never noticed
    protected readonly remoteDigests = new Map<number, number>();
    // which run of the session this is (see `epoch` in link-channel.ts): 0 for the first, +1 per save state loaded
    protected epoch = 0;
    protected startCartRam: { data: Uint8Array, window: number } | undefined;
    protected reporting = false;
    protected readonly onReport: ((report: LinkReport) => void) | undefined;
    protected readonly cartridge: () => LinkCartridge | undefined;
    protected readonly onPeerPaused: ((paused: boolean) => void) | undefined;
    protected readonly calling: boolean;
    protected everConnected = false;
    // standing still for a paused peer is not a sign they have gone, so the give-up timer stays off
    protected peerPaused = false;
    protected ownPaused = false;
    protected readonly rejoin: boolean;
    // player 1's side of picking two running games up: its own machine as it was when it stopped, waiting for player
    // 2's to arrive. See LinkHandover
    protected awaitingHandover: { mine: LinkMachine, setup: LinkCartridge } | undefined;

    constructor(options: LinkSessionOptions) {
        this.emulatorSession = options.session;
        this.channel = options.channel;
        this.seat = options.seat;
        this.rom = options.rom;
        this.romData = options.romData;
        this.coreBuild = options.core;
        this.delay = options.delay ?? LinkSession.DEFAULT_DELAY_FRAMES;
        this.standingEdits = options.standingEdits ?? (() => []);
        this.onReport = options.onReport;
        this.cartridge = options.cartridge ?? (() => undefined);
        this.onPeerPaused = options.onPeerPaused;
        this.calling = options.calling ?? false;
        this.rejoin = options.rejoin ?? false;

        this.toDispose.push(this.channel.onMessage(
            message => this.receive(message).catch(error => this.receiveFailed(error))));
        this.toDispose.push(this.emulatorSession.core.onStalled(() => {
            if (this.connected) {
                this.report({ reason: 'stalled' }).catch(() => undefined);
            }
        }));
        this.toDispose.push(this.emulatorSession.core.onDigest(taken => {
            this.onLocalDigest(taken.sim, taken.frame, taken.digest);
        }));
        this.toDispose.push(this.emulatorSession.core.onProgress(({ frame }) => {
            this.machineFrame = frame;
            this.fillSchedule();
        }));
        this.toDispose.push(this.emulatorSession.core.onAwaitingInput(({ waiting }) => {
            // only once the run has begun: `begin` sets lockstep before resetting and the worker reports waiting at
            // once, so remote input got booked into machines about to be wiped (and cheats against the previous run).
            // Under load that left one window playing and the other waiting for ever
            if (!this.connected) {
                return;
            }
            this.setState(waiting ? LinkState.Stalled : LinkState.Connected);
        }));
    }

    get mirrorSim(): Sim | undefined {
        return this.mirror;
    }

    get connected(): boolean {
        return this.state === LinkState.Connected || this.state === LinkState.Stalled;
    }

    // only player 2 says hello and player 1 only answers, or which one is the authority (see `begin` in
    // link-channel.ts) would be a race. The hello repeats, as one sent before anyone listened is lost
    start(): void {
        if (this.seat !== 2 && !this.calling) {
            return;
        }
        const greet = (): void => {
            // only until the first run begins: a session waiting again was left, and calling would pull back a player
            // who unlinked on purpose
            if (this.calling && !this.everConnected) {
                this.channel.send({ kind: 'call', seat: this.seat });
            }
            if (this.seat === 2) {
                this.sayHello();
            }
        };
        greet();
        this.helloTimer = setInterval(
            () => {
                if (this.state === LinkState.Waiting) {
                    greet();
                }
            },
            LinkSession.HELLO_INTERVAL_MS,
        );
    }

    // the window that decides where the session starts from
    protected get authority(): boolean {
        return this.seat === 1;
    }

    // not applied here: booked against the frames still to come, so the same press lands on the same frame in both
    // windows however long the message took
    setKeys(keys: number): void {
        this.heldKeys = keys;
        this.fillSchedule();
    }

    // booked like the rest from the next unbooked frame; see turboKeys
    setTurbo(keys: number, rate: number): void {
        this.turboKeys = keys >>> 0;
        this.turboRate = rate;
        this.fillSchedule();
    }

    protected sayHello(): void {
        this.channel.send({
            kind: 'hello',
            seat: this.seat,
            protocol: LINK_PROTOCOL_VERSION,
            rom: this.rom,
            core: this.coreBuild,
            running: this.emulatorSession.sim.runningCartridge,
            rejoin: this.rejoining,
        });
    }

    // a relink: asked for, or a session that has had a run and waits because the other player unlinked
    protected get rejoining(): boolean {
        return this.rejoin || this.everConnected;
    }

    // stop this window's machine and take it for the other window's mirror. Lockstep with nothing booked holds it until
    // the run begins, or the session ends, which lets go
    protected async freezeOwn(): Promise<LinkMachine> {
        const own = this.emulatorSession.sim;
        await own.setLockstep(true);
        const info = await own.cartRamInfo();
        return {
            state: await own.saveState(),
            cartRam: await own.getCartRam(info.used),
            cartRamWindow: info.size,
        };
    }

    // whether both games can be picked up as they are (see LinkBegin.hot): only for a relink, only when both machines
    // run the very same code, and only when the image player 1 would hand the mirrors is that code too
    protected canPickUp(hello: { running?: string, rejoin?: boolean }, setup: LinkCartridge): boolean {
        const own = this.emulatorSession.sim;
        const running = own.runningCartridge;
        if (!hello.rejoin || !this.rejoining || !running || hello.running !== running) {
            return false;
        }
        const image = setup.image ?? this.romData();
        return image !== undefined && own.isRunning(image);
    }

    // a message that could not be acted on, as a machine went away during the awaited calls (`begin` alone makes a
    // dozen); arriving in a listener, nobody else holds the promise. Ends the session rather than ignoring it, as a
    // missed change is exactly the silent disagreement the digests exist to catch
    protected receiveFailed(error: unknown): void {
        if (this.disposed || this.state === LinkState.Closed) {
            return;
        }
        console.warn('[vueport] the link session could not act on a message:', error);
        this.close({
            reason: 'failed',
            message: 'The link session ended: one of the machines is no longer there.',
        });
    }

    protected async receive(message: LinkMessage): Promise<void> {
        if (this.disposed) {
            return;
        }
        switch (message.kind) {
            case 'hello':
                await this.onHello(message.seat, message);
                break;
            case 'welcome':
                await this.onWelcome(message);
                break;
            case 'begin': {
                const setup: LinkCartridge = {
                    image: message.image, vbc: message.vbc ?? false, esSound: message.esSound ?? false,
                };
                if (message.hot) {
                    await this.pickUp(message.hot, setup);
                } else {
                    await this.begin(message.cartRam, message.cartRamWindow, setup);
                }
                break;
            }
            case 'handover': {
                const waiting = this.awaitingHandover;
                if (this.authority && waiting) {
                    this.awaitingHandover = undefined;
                    await this.begin(waiting.mine.cartRam, waiting.mine.cartRamWindow, waiting.setup,
                        { mine: waiting.mine, theirs: message.machine });
                }
                break;
            }
            case 'resume':
                await this.applyResume(message.epoch, message.p1, message.p2);
                break;
            case 'restart':
                await this.applyRestart(message.epoch);
                break;
            case 'pause':
                this.onPeerPause(message.paused);
                break;
            case 'call':
                // for a window without a session; one with a session is already taking part or on its way
                break;
            case 'input':
                this.onRemoteInput(message.epoch, message.frame, message.keys);
                break;
            case 'edit':
                this.onRemoteEdits(message.epoch, message.seat, message.frame, message.edits);
                break;
            case 'digest':
                // frame numbers restart at zero after a save state is loaded, so a digest from the previous run would
                // report a desync that never happened
                if (message.epoch === this.epoch) {
                    this.onRemoteDigest(message.frame, message.digest);
                }
                break;
            case 'bye':
                // a window that is going away is gone; one that merely unlinked can be linked to again in a moment
                if (message.leaving === 'ended') {
                    // not an unlink: nobody chose this, so neither window waits for the other; either can link again
                    this.close({
                        reason: 'ended',
                        message: 'The link session ended in the other player\'s window.',
                    });
                    break;
                }
                this.peerGone(message.leaving === 'window'
                    ? { reason: 'closed', message: 'The other player closed their window.' }
                    : { reason: 'left', message: 'The other player unlinked.' });
                break;
        }
    }

    protected async onHello(
        seat: LinkSeat,
        message: { protocol: number, rom: string, core: number, running?: string, rejoin?: boolean },
    ): Promise<void> {
        const refusal = this.checkCompatible(seat, message);
        if (refusal) {
            this.close(refusal);
            return;
        }
        if (this.beginning) {
            // already answered, see `beginning`
            return;
        }
        this.beginning = true;
        // answering fixes the delay for both sides, so it is sent before the mirror exists; the joiner needs the number
        // more urgently than it needs us ready
        this.channel.send({
            kind: 'welcome',
            seat: this.seat,
            protocol: LINK_PROTOCOL_VERSION,
            rom: this.rom,
            core: this.coreBuild,
            delay: this.delay,
        });
        const cartridge: LinkCartridge = this.cartridge() ?? { vbc: false, esSound: false };
        // two windows that have played together, running the same code: both games are picked up where they are. This
        // machine is held and sent, and the run begins once player 2's arrives
        if (this.canPickUp(message, cartridge)) {
            const mine = await this.freezeOwn();
            if (this.disposed || this.state === LinkState.Closed) {
                return;
            }
            this.awaitingHandover = { mine, setup: cartridge };
            this.channel.send({
                kind: 'begin', seat: this.seat, epoch: 0,
                cartRam: new ArrayBuffer(0), cartRamWindow: mine.cartRamWindow,
                vbc: cartridge.vbc, esSound: cartridge.esSound,
                hot: { state: mine.state.slice(0), cartRam: mine.cartRam.slice(0), cartRamWindow: mine.cartRamWindow },
            });
            return;
        }
        // the authority decides where both windows start, and starts there itself. Only send the save window up to
        // what the game has written, not all 16 MiB of Game Pak RAM: everything above the baseline is zero on both
        // sides (see expandCartRam)
        const info = await this.emulatorSession.sim.cartRamInfo();
        const cartRam = await this.emulatorSession.sim.getCartRam(info.used);
        // our machine as it runs, which the joining window's machines are made into as well (see LinkBegin.image)
        this.channel.send({
            kind: 'begin', seat: this.seat, epoch: 0,
            cartRam: cartRam.slice(0), cartRamWindow: info.size,
            image: cartridge.image?.slice(0), vbc: cartridge.vbc, esSound: cartridge.esSound,
        });
        await this.begin(cartRam, info.size, cartridge);
    }

    // player 1 picks both games up as they are: hold ours, send it, and begin with theirs as our mirror. See
    // LinkBegin.hot
    protected async pickUp(theirs: LinkMachine, setup: LinkCartridge): Promise<void> {
        if (this.connected || this.disposed || this.beginning) {
            return;
        }
        this.beginning = true;
        const mine = await this.freezeOwn();
        if (this.disposed || this.state === LinkState.Closed) {
            return;
        }
        this.channel.send({
            kind: 'handover', seat: this.seat,
            machine: { state: mine.state.slice(0), cartRam: mine.cartRam.slice(0), cartRamWindow: mine.cartRamWindow },
        });
        // `beginning` is ours to hand on: `begin` refuses a joining window that has already started
        this.beginning = false;
        await this.begin(mine.cartRam, mine.cartRamWindow, setup, { mine, theirs });
    }

    protected async onWelcome(
        message: { seat: LinkSeat, protocol: number, rom: string, core: number, delay: number },
    ): Promise<void> {
        const refusal = this.checkCompatible(message.seat, message);
        if (refusal) {
            this.close(refusal);
            return;
        }
        this.delay = message.delay;
        // the `begin` that follows is what starts us
    }

    protected checkCompatible(
        seat: LinkSeat,
        message: { protocol: number, rom: string, core: number },
    ): LinkRefusal | undefined {
        if (seat === this.seat) {
            return {
                reason: 'seat',
                message: 'Both windows opened as the same player.',
            };
        }
        if (message.protocol !== LINK_PROTOCOL_VERSION) {
            return {
                reason: 'protocol',
                message: 'The other window is running a different version of VUEPort.',
            };
        }
        if (message.core !== this.coreBuild) {
            return {
                reason: 'core',
                message: 'The other window is running a different emulator core.',
            };
        }
        if (message.rom !== this.rom) {
            return {
                reason: 'rom',
                message: 'The other window has a different game open.',
            };
        }
        return undefined;
    }

    /**
     * Puts all machines back to power-on and starts the session at frame zero. Both windows do this from the same save
     * RAM at the same moment, the only way two independent emulators can be in step; restarting the game is what a
     * cable between two VBs amounts to. Except `hot` (see LinkBegin.hot): a relink running the same code keeps its
     * games, each machine back where it was held, each mirror from the other window's. From here no machine runs a
     * frame without input.
     */
    protected async begin(
        cartRam: ArrayBuffer, cartRamWindow: number, setup: LinkCartridge,
        hot?: { mine: LinkMachine, theirs: LinkMachine },
    ): Promise<void> {
        if (this.connected || this.disposed || (this.beginning && !this.authority)) {
            return;
        }
        this.beginning = true;
        // whatever ended the last run is no longer happening. The run itself was put away when it ended (see
        // peerGone, the only way a session gets here twice)
        this.refusal = undefined;
        // the authority's image when it runs a patched one, otherwise the file both windows opened (the hello checked
        // it is the same file)
        const cartridge = setup.image ?? this.romData();
        if (!cartridge) {
            this.close({ reason: 'rom', message: 'The game is no longer open in this window.' });
            return;
        }
        const own = this.emulatorSession.sim;
        this.startCartRam = { data: new Uint8Array(cartRam.slice(0)), window: cartRamWindow };
        this.reporting = false;
        this.peerPaused = false;
        this.ownPaused = false;
        // behind the machines of the previous run, which may still be on their way back; that is a different session
        // object, so the queue cannot live here. See withMirror in emulator-core-service.ts
        const mirror = await this.emulatorSession.withMirror(async () => {
            // with the seat, so both windows hand the pair to the core in the same order: what a linked pair emulates
            // depends on it (see setPeer in vb-protocol.ts). When picked up hot, the machines already run the same
            // code, and changing the cartridge under a running game would crash it
            if (!this.authority && !hot) {
                // our own machine takes the authority's patches and console too. Before the mirror is built, which
                // copies the console model from it, and held first so it does not run on through code it is no longer
                // the cartridge of; the reset below starts it again cleanly
                await own.setLockstep(true);
                await own.setHardwareMode(setup.vbc);
                await own.setCartRom(cartridge.slice(0));
            }
            const built = await this.emulatorSession.attachMirror(cartridge.slice(0), this.seat);
            if (this.disposed) {
                // the session went away while the mirror was being built; whoever disposed of it hands it back
                // (queued behind this)
                return built;
            }
            this.mirror = built;

            // lockstep goes on first: with nothing booked the drive loop stops on the spot. In any other order a
            // machine can advance a few frames between reset and hold, every booking from frame zero is then refused
            // as too late, and the two windows wait for each other for ever (this happened)
            await own.setLockstep(true);
            await built.setLockstep(true);
            await own.setDigestPeriod(LinkSession.DIGEST_PERIOD_FRAMES);
            await built.setDigestPeriod(LinkSession.DIGEST_PERIOD_FRAMES);

            // both machines start from the authority's save, or they part company on the first read. Picked up hot,
            // each keeps its own and the mirror gets the other's
            if (hot) {
                await built.setCartRam(expandCartRam(hot.theirs.cartRam, hot.theirs.cartRamWindow));
            } else {
                await own.setCartRam(expandCartRam(cartRam, cartRamWindow));
                await built.setCartRam(expandCartRam(cartRam, cartRamWindow));
            }
            // the mirror is heard in the other player's window, not in this one
            await built.setVolume(0);
            // the ESSound chip answers the game with an interrupt, so it is part of the machine: all four copies have
            // one or none do. Only our own machine's tracks are played
            await own.setEsSoundCapture(setup.esSound);
            await built.setEsSoundCapture(setup.esSound);

            // resetting also puts the frame count, which both windows book against, back to zero
            await own.reset();
            await built.reset();
            if (hot) {
                // and straight back to where each game was. The states were taken unpeered, so the cable is plugged
                // in after them
                await own.loadState(hot.mine.state.slice(0));
                await built.loadState(hot.theirs.state.slice(0));
                await own.setPeer(built, this.seat);
            }
            return built;
        });
        if (this.disposed) {
            return;
        }
        this.nextFrame = 0;
        this.machineFrame = 0;

        this.everConnected = true;
        this.setState(LinkState.Connected);
        // before both below, as they book against frames, and what a machine runs under must be settled before its
        // first frame
        this.sendStandingEdits();
        this.drainPendingRemote(mirror);
        this.fillSchedule();
    }

    // book this window's input for every frame up to the horizon and tell the other window. The horizon moves with the
    // machines, not the wall clock, so this cannot drift
    protected fillSchedule(): void {
        if (!this.connected) {
            return;
        }
        const horizon = this.machineFrame + this.delay;
        if (this.nextFrame > horizon) {
            return;
        }
        // a window that has been away comes back to a horizon far ahead of it; skip the gap and let the machines take
        // the stall
        if (this.nextFrame < this.machineFrame) {
            this.nextFrame = this.machineFrame;
        }
        const sim = this.emulatorSession.sim;
        for (let frame = this.nextFrame; frame <= horizon; frame++) {
            const keys = withTurbo(this.heldKeys, this.turboKeys, frame, this.turboRate);
            sim.queueKeys(frame, keys).catch(() => undefined);
            this.channel.send({ kind: 'input', seat: this.seat, epoch: this.epoch, frame, keys });
        }
        this.nextFrame = horizon + 1;
    }

    /**
     * Changes one of the two machines, in both windows, on the same frame: a cheat or a Cheat Finder poke has no route
     * between windows like a button press, and made in one window only, the digest check ends the session a second
     * later without being able to say why. `seat` names the machine, not the window asking, so a debugger can aim at
     * either. The frame: neither window can be more than `delay` frames from the other, so `nextFrame` (a full delay
     * past our machine) is past theirs too; a second delay on top covers the message's travel. The booking is made and
     * the message sent at once, as the other window must hear about it before its machine reaches that frame.
     */
    scheduleEdits(seat: LinkSeat, edits: ScheduledEdit[]): boolean {
        if (!this.connected || edits.length === 0) {
            return false;
        }
        const frame = Math.max(this.nextFrame, this.machineFrame + this.delay + 1) + this.delay;
        // sent before it is booked here, so the window with further to travel gets the head start
        this.channel.send({ kind: 'edit', seat, epoch: this.epoch, frame, edits });
        this.bookEdits(seat, frame, edits);
        return true;
    }

    // a booking the core refuses is a frame already emulated: a desync that has already happened, and saying so beats
    // the digest reporting it a second later unexplained
    protected bookEdits(seat: LinkSeat, frame: number, edits: ScheduledEdit[]): void {
        const sim = seat === this.seat ? this.emulatorSession.sim : this.mirror;
        if (!sim) {
            return;
        }
        sim.queueEdits(frame, edits).catch(() => this.close({
            reason: 'edit',
            message: 'A change to one of the machines arrived too late to be made on the'
                + ' same frame in both windows, so the link session ended.',
        }));
    }

    // held when there is nowhere to put it yet; see pendingEdits, and onRemoteInput for input
    protected onRemoteEdits(
        epoch: number,
        seat: LinkSeat,
        frame: number,
        edits: ScheduledEdit[],
    ): void {
        if (epoch < this.epoch) {
            return;
        }
        if (epoch === this.epoch && this.connected && this.mirror) {
            this.bookEdits(seat, frame, edits);
            return;
        }
        if (this.pendingEdits.length < LinkSession.MAX_PENDING_EDITS) {
            this.pendingEdits.push({ epoch, seat, frame, edits });
        }
    }

    // tell the other window what our machine already runs under, so its mirror starts the run the same way. At frame
    // zero and before the first input is booked; the channel delivers in order
    protected sendStandingEdits(): void {
        const edits = this.standingEdits();
        if (edits.length === 0) {
            return;
        }
        // our own machine already has them (the store put them there, and a reset does not take them off), so this is
        // for their mirror only
        this.channel.send({ kind: 'edit', seat: this.seat, epoch: this.epoch, frame: 0, edits });
    }

    // ours goes to the other window to be checked against their copy; our copy of their machine is kept until their own
    // digest for that frame arrives
    protected onLocalDigest(sim: number, frame: number, digest: number): void {
        if (!this.connected) {
            return;
        }
        if (sim === this.emulatorSession.sim.id) {
            this.channel.send({ kind: 'digest', seat: this.seat, epoch: this.epoch, frame, digest });
            return;
        }
        if (sim !== this.mirror?.id) {
            return;
        }
        const theirs = this.remoteDigests.get(frame);
        if (theirs !== undefined) {
            this.remoteDigests.delete(frame);
            this.compareDigests(frame, digest, theirs);
            return;
        }
        LinkSession.keep(this.mirrorDigests, frame, digest);
    }

    protected static keep(digests: Map<number, number>, frame: number, digest: number): void {
        digests.set(frame, digest);
        while (digests.size > LinkSession.MAX_KEPT_DIGESTS) {
            const oldest = digests.keys().next();
            if (oldest.done) {
                break;
            }
            digests.delete(oldest.value);
        }
    }

    // the other window's digest of its own machine, compared against our copy. Theirs routinely arrives before ours is
    // taken, and is then held (see remoteDigests). Only two digests of the same frame that differ mean anything
    protected onRemoteDigest(frame: number, digest: number): void {
        const ours = this.mirrorDigests.get(frame);
        if (ours === undefined) {
            LinkSession.keep(this.remoteDigests, frame, digest);
            return;
        }
        this.mirrorDigests.delete(frame);
        this.compareDigests(frame, ours, digest);
    }

    protected compareDigests(frame: number, ours: number, theirs: number): void {
        const digest = theirs;
        if (ours === digest) {
            return;
        }
        const refusal: LinkRefusal = {
            reason: 'desync',
            message: 'The two machines stopped matching, so the link session ended.',
        };
        // before closing, which lets the mirror and its journal go
        this.report({ reason: 'desync', mismatch: { frame, mirror: ours, theirs: digest } })
            .finally(() => this.close(refusal));
    }

    // once per session: a desync is noticed at every digest after the first that disagreed, the first is worth
    // reporting
    protected async report(
        what: { reason: LinkReport['reason'], mismatch?: LinkReport['mismatch'] },
    ): Promise<void> {
        const mirror = this.mirror;
        if (!this.onReport || this.reporting || !mirror) {
            return;
        }
        this.reporting = true;
        try {
            const own = await this.emulatorSession.sim.linkJournal();
            const theirs = await mirror.linkJournal();
            this.onReport({
                ...what,
                seat: this.seat,
                rom: this.rom,
                delay: this.delay,
                epoch: this.epoch,
                frame: this.machineFrame,
                cartRam: this.startCartRam && toBase64(this.startCartRam.data),
                cartRamWindow: this.startCartRam?.window,
                journals: this.seat === 1 ? { p1: own, p2: theirs } : { p1: theirs, p2: own },
            });
        } catch (error) {
            console.warn('[vueport] could not put the link report together:', error);
        }
    }

    // named by player, the only naming both windows agree on. Either window can take one, they run the same pair
    async snapshot(): Promise<{ p1: ArrayBuffer, p2: ArrayBuffer } | undefined> {
        const mirror = this.mirror;
        if (!this.connected || !mirror) {
            return undefined;
        }
        const own = await this.emulatorSession.sim.saveState();
        const theirs = await mirror.saveState();
        return this.seat === 1 ? { p1: own, p2: theirs } : { p1: theirs, p2: own };
    }

    // sent before it is applied here, so the other window restarts at about the same time, not a round trip later
    async resume(p1: ArrayBuffer, p2: ArrayBuffer): Promise<void> {
        if (!this.connected) {
            return;
        }
        const epoch = this.epoch + 1;
        this.channel.send({
            kind: 'resume', seat: this.seat, epoch, p1: p1.slice(0), p2: p2.slice(0),
        });
        await this.applyResume(epoch, p1, p2);
    }

    protected async applyResume(epoch: number, p1: ArrayBuffer, p2: ArrayBuffer): Promise<void> {
        await this.startRun(epoch, this.seat === 1 ? { mine: p1, theirs: p2 } : { mine: p2, theirs: p1 });
    }

    // reset both players' machines in both windows as one (see LinkRestart). Sent before it is applied here, like
    // resume
    async restart(): Promise<void> {
        if (!this.connected) {
            return;
        }
        const epoch = this.epoch + 1;
        this.channel.send({ kind: 'restart', seat: this.seat, epoch });
        await this.applyRestart(epoch);
    }

    protected async applyRestart(epoch: number): Promise<void> {
        await this.startRun(epoch, undefined);
    }

    // both machines reset, and put into the saved moment when there is one. Both windows pressing reset at once is two
    // restarts to the same epoch; the second is ignored on each side
    protected async startRun(
        epoch: number, states: { mine: ArrayBuffer, theirs: ArrayBuffer } | undefined,
    ): Promise<void> {
        const mirror = this.mirror;
        if (!this.connected || !mirror || epoch <= this.epoch) {
            return;
        }
        const own = this.emulatorSession.sim;

        // from here anything in flight from the previous run is ignored, so a stale mask cannot be taken for a
        // replayed frame
        this.epoch = epoch;
        this.mirrorDigests.clear();
        this.remoteDigests.clear();

        // resetting puts the frame count back to zero and drops the bookings; the state goes on top, into a machine
        // that cannot run a frame in between, as it has nothing booked
        await own.reset();
        await mirror.reset();
        if (states) {
            await own.loadState(states.mine.slice(0));
            await mirror.loadState(states.theirs.slice(0));
        }

        this.nextFrame = 0;
        this.machineFrame = 0;
        // said again, not assumed to have survived: a cheat switched on just before the state load may have been booked
        // against a frame only one window reached, and the reset dropped the bookings that would have settled it
        this.sendStandingEdits();
        // the other window restarts at about the same moment, so its first frames of the new run are likely here
        // already
        this.drainPendingRemote(mirror);
        this.fillSchedule();
    }

    // called by the chrome for a pause the player asked for, not for one from the other window, or the two would tell
    // each other back and forth. See LinkPause
    setPaused(paused: boolean): void {
        if (!this.connected) {
            return;
        }
        this.ownPaused = paused;
        this.armStallTimeout(this.state === LinkState.Stalled);
        this.channel.send({ kind: 'pause', seat: this.seat, paused });
    }

    protected onPeerPause(paused: boolean): void {
        if (!this.connected) {
            return;
        }
        this.peerPaused = paused;
        // waiting on a player who paused is not waiting on one who left; once they carry on, a long silence counts
        // again
        this.armStallTimeout(this.state === LinkState.Stalled);
        this.onPeerPaused?.(paused);
    }

    protected onRemoteInput(epoch: number, frame: number, keys: number): void {
        // from a run that is over; its frame numbers mean nothing now
        if (epoch < this.epoch) {
            return;
        }
        // not "is there a mirror": there is one early in `begin`, and anything booked before its final reset is
        // wiped. Only once the session has begun, on the same run, is the mirror worth booking against
        if (epoch === this.epoch && this.connected && this.mirror) {
            this.mirror.queueKeys(frame, keys).catch(() => undefined);
            return;
        }
        // not begun yet, or the other window has already restarted and we are about to. Under lockstep nothing
        // re-sends a frame, so anything dropped here the mirror waits for for ever. See pendingRemote
        if (this.pendingRemote.length < LinkSession.MAX_PENDING_REMOTE) {
            this.pendingRemote.push({ epoch, frame, keys });
        }
    }

    // only for the current run: anything older named frames already played, anything newer is for a restart to come
    protected drainPendingRemote(mirror: Sim): void {
        const held = this.pendingRemote.splice(0);
        for (const input of held) {
            if (input.epoch === this.epoch) {
                mirror.queueKeys(input.frame, input.keys).catch(() => undefined);
            } else if (input.epoch > this.epoch) {
                this.pendingRemote.push(input);
            }
        }
        // order relative to the input does not matter, as edits are applied in the order of the frames they name
        const edits = this.pendingEdits.splice(0);
        for (const edit of edits) {
            if (edit.epoch === this.epoch) {
                this.bookEdits(edit.seat, edit.frame, edit.edits);
            } else if (edit.epoch > this.epoch) {
                this.pendingEdits.push(edit);
            }
        }
    }

    protected setState(state: LinkState): void {
        // a closed session stays closed; a late message must not revive it
        if (this.state === state || this.state === LinkState.Closed) {
            return;
        }
        this.state = state;
        this.armStallTimeout(state === LinkState.Stalled);
        this.onDidChangeEmitter.fire();
    }

    // standing still is ordinary when the other window is a few frames behind, so only give up after PEER_TIMEOUT_MS
    protected armStallTimeout(armed: boolean): void {
        if (this.stallTimer !== undefined) {
            clearTimeout(this.stallTimer);
            this.stallTimer = undefined;
        }
        if (!armed || this.peerPaused || this.ownPaused) {
            return;
        }
        // closed rather than left waiting: a window that went quiet without a goodbye gives no reason to expect it back
        this.stallTimer = setTimeout(
            () => this.close({
                reason: 'timeout',
                message: 'The other player stopped responding.',
            }),
            LinkSession.PEER_TIMEOUT_MS,
        );
    }

    /**
     * The other player is gone. An unlink is not a failure: both windows still have the game, so this window lets the
     * machines go, forgets the run and waits again with the channel open. Seat 2's hello timer starts again by itself
     * (it only checks for `Waiting`) and seat 1 listens, so relinking is one press in one window. A window that closed
     * is gone for good: the session ends and the chrome offers a new invite.
     */
    protected peerGone(refusal: LinkRefusal): void {
        if (this.state === LinkState.Closed || this.disposed) {
            return;
        }
        if (refusal.reason === 'closed') {
            this.close(refusal);
            return;
        }
        this.refusal = refusal;
        this.state = LinkState.Waiting;
        this.armStallTimeout(false);
        // so the next hello is answered rather than taken for a repeat of the one that started the ended session
        this.beginning = false;
        this.awaitingHandover = undefined;
        // put the run away here: frame numbers restart at zero, so a carried-over epoch would refuse every input.
        // Not in `begin`, where the queues hold input from the coming run, and dropping it strands the mirror at
        // frame zero (see pendingRemote)
        this.epoch = 0;
        this.pendingRemote.length = 0;
        this.pendingEdits.length = 0;
        this.releaseMachines().catch(() => undefined);
        this.onDidChangeEmitter.fire();
    }

    protected close(refusal: LinkRefusal): void {
        if (this.state === LinkState.Closed) {
            return;
        }
        this.refusal = refusal;
        this.state = LinkState.Closed;
        this.armStallTimeout(false);
        this.releaseMachines().catch(() => undefined);
        this.onDidChangeEmitter.fire();
    }

    // lockstep comes off first, the mirror goes second: a machine left under lockstep with nothing booked never runs
    // again
    protected releaseMachines(): Promise<void> {
        this.mirrorDigests.clear();
        this.remoteDigests.clear();
        // the whole hand-back owns the mirror, so the next run (perhaps of a session that does not exist yet) waits
        // for all of it. See withMirror
        return this.emulatorSession.withMirror(async () => {
            await this.emulatorSession.sim.setDigestPeriod(0).catch(() => undefined);
            await this.emulatorSession.sim.setLockstep(false).catch(() => undefined);
            // back to whether this window has tracks to play. Image and console model stay: changing the code under a
            // running machine would crash it
            await this.emulatorSession.sim.setEsSoundCapture(this.cartridge()?.esSound ?? false)
                .catch(() => undefined);
            await this.emulatorSession.detachMirror().catch(() => undefined);
            this.mirror = undefined;
        });
    }

    // `leaving` decides what happens in the other window: `session` leaves it waiting, one press from playing again;
    // `window` ends it, as this window is going away. See LinkGoodbye
    dispose(leaving: 'session' | 'window' | 'ended' = 'window'): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.helloTimer !== undefined) {
            clearInterval(this.helloTimer);
            this.helloTimer = undefined;
        }
        this.armStallTimeout(false);
        // said before the channel goes, so the other window stops waiting for input that is never coming
        this.channel.send({ kind: 'bye', seat: this.seat, leaving });
        this.releaseMachines().catch(() => undefined);
        this.toDispose.dispose();
        this.channel.dispose();
        this.onDidChangeEmitter.dispose();
    }
}
