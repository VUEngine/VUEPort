import { Emitter, Event } from '../common/emulator-events';
import { Movie } from '../common/emulator-movie';
import { VbKey } from '../common/vb-constants';
import { Sim } from './core/vb-core';

// plays a recorded input movie back. Each frame's mask is booked against its frame number with `queueKeys` under
// lockstep (the link-session machinery, with one window replaced by a file), so the machine waits for the movie and
// cannot drift. Does not reset the machine: what power-on means (save, hardware model, color patch) is the owner's
export class MoviePlayer {

    // inside the worker's own limit on how far a booking may reach, and far enough that a slow frame here
    // never stalls the machine
    protected static readonly HORIZON = 240;

    protected movie: Movie | undefined;
    protected sim: Sim | undefined;
    protected nextFrame = 0;
    protected machineFrame = 0;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    get playing(): boolean {
        return this.movie !== undefined;
    }

    get current(): Movie | undefined {
        return this.movie;
    }

    // in frames
    get frame(): number {
        return this.machineFrame;
    }

    get length(): number {
        return this.movie?.frames.length ?? 0;
    }

    // plays from the frame the machine is at; the caller resets first for a run meant to be reproduced
    async start(sim: Sim, movie: Movie): Promise<void> {
        await this.stop();
        if (movie.frames.length === 0) {
            return;
        }
        this.movie = movie;
        this.sim = sim;
        this.nextFrame = 0;
        this.machineFrame = 0;
        await sim.setLockstep(true);
        this.fill();
        this.onDidChangeEmitter.fire();
    }

    // driven by the core's progress reports, which only a machine under lockstep sends
    advance(frame: number): void {
        if (!this.movie) {
            return;
        }
        this.machineFrame = frame;
        if (frame >= this.movie.frames.length) {
            this.stop().catch(() => undefined);
            return;
        }
        this.fill();
        this.onDidChangeEmitter.fire();
    }

    async stop(): Promise<void> {
        const sim = this.sim;
        this.movie = undefined;
        this.sim = undefined;
        this.nextFrame = 0;
        if (sim) {
            await sim.setLockstep(false).catch(() => undefined);
        }
        this.onDidChangeEmitter.fire();
    }

    protected fill(): void {
        const movie = this.movie;
        const sim = this.sim;
        if (!movie || !sim) {
            return;
        }
        const horizon = Math.min(
            this.machineFrame + MoviePlayer.HORIZON, movie.frames.length - 1);
        for (let frame = Math.max(this.nextFrame, this.machineFrame); frame <= horizon; frame++) {
            // SGN tells the machine a controller is plugged in. No movie format records it, and a mask without it
            // would unplug the pad for that frame
            sim.queueKeys(frame, movie.frames[frame] | VbKey.SGN).catch(() => undefined);
        }
        this.nextFrame = Math.max(this.nextFrame, horizon + 1);
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}
