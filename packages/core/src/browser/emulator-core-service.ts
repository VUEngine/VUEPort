import { Disposable } from '../common/emulator-events';
import { Core, Sim } from './core/vb-core';

/**
 * One emulator's worker and its machines. A link session adds the mirror, the other player's machine run here from
 * their inputs, as the link port is emulated by walking from one simulation to its peer within one wasm instance. That
 * keeps each window a whole emulator (toolbar, debugger, audio), and is what netplay would do over a wire instead of a
 * BroadcastChannel. See link-session.ts.
 */
export interface EmulatorSession extends Disposable {
    readonly core: Core;
    readonly sim: Sim;
    readonly mirror: Sim | undefined;
    // needs the same ROM this window runs, or the mirror boots into empty memory and only looks like it works. `seat`
    // is this window's player; the core gets the pair in seat order, as the order changes what a linked pair emulates
    // and the two windows build theirs the opposite way round (setPeer in vb-protocol.ts). Idempotent
    attachMirror(rom: ArrayBuffer, seat?: 1 | 2): Promise<Sim>;
    detachMirror(): Promise<void>;
    // serializes work on the mirror: building and releasing it take several worker round trips, and on unlink-relink
    // the release could win the race and dispose of the machine the new session had just built
    withMirror<T>(work: () => Promise<T>): Promise<T>;
}

class EmulatorSessionImpl implements EmulatorSession {

    mirror: Sim | undefined;

    protected mirrorWork: Promise<unknown> = Promise.resolve();

    constructor(
        readonly core: Core,
        readonly sim: Sim,
        protected readonly service: EmulatorCoreService,
    ) { }

    async attachMirror(rom: ArrayBuffer, seat: 1 | 2 = 1): Promise<Sim> {
        if (this.mirror) {
            return this.mirror;
        }
        const mirror = await this.core.createSim();
        await mirror.setHardwareMode(this.sim.isVbcHardware);
        await mirror.setCartRom(rom);
        // peering is symmetric in the core, so one call does both ends
        await this.sim.setPeer(mirror, seat);
        this.mirror = mirror;
        return mirror;
    }

    withMirror<T>(work: () => Promise<T>): Promise<T> {
        // the queue continues after a failure instead of blocking everything behind it
        const next = this.mirrorWork.then(work, work);
        this.mirrorWork = next.catch(() => undefined);
        return next;
    }

    async detachMirror(): Promise<void> {
        const mirror = this.mirror;
        if (!mirror) {
            return;
        }
        this.mirror = undefined;
        await this.sim.setPeer(undefined);
        mirror.dispose();
    }

    dispose(): void {
        this.service.disposeSession(this);
    }
}

export interface VueportCoreUrls {
    workerUrl: string; // emitted next to the host's bundle, like the worklet
    audioWorkletUrl: string;
    wasmUrl: string; // fetched over HTTP, as WebAssembly.instantiateStreaming wants a URL
    rcheevosModuleUrl?: string;
    // render WebGL on the page instead of in the worker, for hosts like Linux WebKitGTK
    mainThreadVideo?: boolean;
}

// one worker per emulator session: run and suspend apply to every machine in a worker at once, which is right for a
// linked pair and wrong for unrelated emulators
export class EmulatorCoreService implements Disposable {

    protected readonly sessions = new Set<EmulatorSessionImpl>();

    constructor(protected readonly urls: VueportCoreUrls) { }

    async createSession(): Promise<EmulatorSession> {
        const core = await this.createCore();
        const session = new EmulatorSessionImpl(core, await core.createSim(), this);
        this.sessions.add(session);
        return session;
    }

    disposeSession(session: EmulatorSession): void {
        const impl = session as EmulatorSessionImpl;
        if (!this.sessions.delete(impl)) {
            return;
        }
        impl.core.dispose();
    }

    protected async createCore(): Promise<Core> {
        return Core.create(this.urls);
    }

    dispose(): void {
        for (const session of [...this.sessions]) {
            this.disposeSession(session);
        }
        this.sessions.clear();
    }
}
