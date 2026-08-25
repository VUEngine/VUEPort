import { Disposable } from '../common/emulator-events';
import { VesVbCore, VesVbSim } from './core/vb-core';

/**
 * One emulator's slice of a worker.
 *
 * A session owning the whole core is the ordinary case. When two emulators are
 * linked they share the core, because the link port is emulated by walking
 * from one simulation to its peer inside a single WebAssembly instance.
 */
export interface VesEmulatorSession extends Disposable {
    readonly core: VesVbCore;
    readonly sim: VesVbSim;
    /** Every simulation in this session, ours first. Longer than one when linked. */
    readonly siblings: VesVbSim[];
    /** True once a peer has joined the group and the pair has been wired up. */
    readonly linked: boolean;
}

interface VesEmulatorLinkGroup {
    core: VesVbCore;
    members: VesEmulatorSessionImpl[];
}

class VesEmulatorSessionImpl implements VesEmulatorSession {
    linked = false;

    constructor(
        readonly core: VesVbCore,
        readonly sim: VesVbSim,
        protected readonly service: VesEmulatorCoreService,
        readonly group?: VesEmulatorLinkGroup
    ) { }

    get siblings(): VesVbSim[] {
        if (!this.group) {
            return [this.sim];
        }
        // Ours first, so that a save state written by either emulator restores
        // in a consistent order.
        return [this.sim, ...this.group.members.filter(m => m !== this).map(m => m.sim)];
    }

    dispose(): void {
        this.service.disposeSession(this);
    }
}

/**
 * Where the core's three pieces are served from.
 *
 * All host-specific: the worker and the worklet are emitted next to whatever
 * bundle the host builds, and the wasm is fetched over HTTP because
 * `WebAssembly.instantiateStreaming` wants a URL. The emulator is told rather
 * than working them out, so a host is free to serve them from anywhere.
 */
export interface VueportCoreUrls {
    workerUrl: string;
    audioWorkletUrl: string;
    /** The core's WebAssembly binary. */
    wasmUrl: string;
}

/**
 * Creates and tracks emulator sessions.
 *
 * Emulation state is core-wide: run and suspend apply to every simulation in a
 * session at once. That is wrong for unrelated emulators, which therefore get
 * their own worker and run in parallel, and right for a linked pair, which has
 * to stay in lockstep.
 */
export class VesEmulatorCoreService implements Disposable {

    protected readonly sessions = new Set<VesEmulatorSessionImpl>();
    protected readonly linkGroups = new Map<string, VesEmulatorLinkGroup>();

    constructor(protected readonly urls: VueportCoreUrls) { }

    /**
     * Create a session. Passing a link group id joins the emulators sharing it
     * into one worker; the pair is wired together as soon as the second one
     * arrives.
     */
    async createSession(linkGroupId?: string): Promise<VesEmulatorSession> {
        if (!linkGroupId) {
            const core = await this.createCore();
            const solo = new VesEmulatorSessionImpl(core, await core.createSim(), this);
            this.sessions.add(solo);
            return solo;
        }

        let group = this.linkGroups.get(linkGroupId);
        if (!group) {
            group = { core: await this.createCore(), members: [] };
            this.linkGroups.set(linkGroupId, group);
        }

        const session = new VesEmulatorSessionImpl(group.core, await group.core.createSim(), this, group);
        group.members.push(session);
        this.sessions.add(session);

        await this.rewireLinkGroup(group);
        return session;
    }

    /** Shut a session down, releasing its worker once nothing else needs it. */
    disposeSession(session: VesEmulatorSession): void {
        const impl = session as VesEmulatorSessionImpl;
        if (!this.sessions.delete(impl)) {
            return;
        }

        const group = impl.group;
        if (!group) {
            impl.core.dispose();
            return;
        }

        group.members = group.members.filter(member => member !== impl);
        impl.sim.dispose();

        if (group.members.length === 0) {
            for (const [id, candidate] of this.linkGroups) {
                if (candidate === group) {
                    this.linkGroups.delete(id);
                }
            }
            group.core.dispose();
            return;
        }

        // The survivor keeps running, just no longer connected to anything.
        this.rewireLinkGroup(group);
    }

    /**
     * Peer the group's simulations, or unpeer them when it is down to one.
     *
     * The Virtual Boy's link port connects exactly two machines, so a third
     * emulator joining a group is left unconnected rather than silently
     * displacing one of the pair.
     */
    protected async rewireLinkGroup(group: VesEmulatorLinkGroup): Promise<void> {
        const [first, second] = group.members;
        if (!first) {
            return;
        }

        if (!second) {
            first.linked = false;
            await first.sim.setPeer(undefined);
            return;
        }

        await first.sim.setPeer(second.sim);
        first.linked = true;
        second.linked = true;

        for (const extra of group.members.slice(2)) {
            extra.linked = false;
            await extra.sim.setPeer(undefined);
        }
    }

    protected async createCore(): Promise<VesVbCore> {
        return VesVbCore.create(this.urls);
    }

    dispose(): void {
        for (const session of [...this.sessions]) {
            this.disposeSession(session);
        }
        this.sessions.clear();
        this.linkGroups.clear();
    }
}
