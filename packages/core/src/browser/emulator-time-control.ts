import { VB_FRAME_RATE } from '../common/vb-constants';
import { VesVbCore } from './core/vb-core';

/**
 * Everything the time controls read out of the emulator's settings, gathered
 * once so this has no opinion about where settings come from.
 */
export interface EmulatorTimeSettings {
    /** How many times real time fast forward runs at. */
    fastForwardRatio: number;
    /** The divisor slow motion runs at. */
    slowMotionRatio: number;
    rewindEnabled: boolean;
    /** Frames of emulation covered by one entry of rewind history. */
    rewindGranularity: number;
    rewindBufferBytes: number;
}

/** The part of ESSound playback that has to follow the machine's clock. */
export interface EmulatorTimeAudio {
    setSpeed(speed: number): void;
    setRewinding(rewinding: boolean): void;
    /** Wind the tracks back by however much emulated time was given up. */
    rewind(seconds: number): void;
}

/** What the time controls need from the emulator they pace. */
export interface EmulatorTimeControlHost {
    readonly core?: VesVbCore;
    readonly esSound: EmulatorTimeAudio;
    /** False before the ROM has booted. */
    readonly loaded: boolean;
    readonly paused: boolean;
    readonly fastForward: boolean;
    readonly slowMotion: boolean;
    /** True once the emulator is being torn down, so nothing should redraw. */
    readonly isDisposed: boolean;
    timeSettings(): EmulatorTimeSettings;
    /** Something changed that the chrome should show. */
    onDidChange(): void;
    onError(message: string): void;
}

/**
 * Speed, rewind, and the ordering of the transitions between running and
 * suspended.
 *
 * Kept together because they are the same concern seen three ways: all three
 * decide how fast emulated time passes, and all three do it by talking to the
 * core rather than to any simulation. Reading settings through
 * `EmulatorTimeSettings` rather than a preference service is what lets this
 * move to a host that has no such thing.
 */
export class EmulatorTimeControl {

    /** Fallbacks for settings that are unset or meaningless. */
    static readonly DEFAULT_FAST_FORWARD_RATIO = 4;
    static readonly DEFAULT_SLOW_MOTION_RATIO = 3;
    /** How much history a single rewind tick may make up for after a stall. */
    static readonly REWIND_MAX_CATCHUP_MS = 100;

    /** True from the moment rewind input is pressed until it is released. */
    rewinding = false;
    protected rewindHandle?: number;
    /** Timestamp of the last rewind tick, for pacing playback by the wall clock. */
    protected rewindLastTick = 0;
    /** History entries owed from earlier ticks, kept fractional so pacing does not drift. */
    protected rewindOwed = 0;
    /** Serializes run/suspend, so a release can never overtake its own press. */
    protected coreTransition: Promise<void> = Promise.resolve();

    constructor(protected readonly host: EmulatorTimeControlHost) { }

    isRewindEnabled(): boolean {
        return this.host.timeSettings().rewindEnabled;
    }

    async applySpeed(): Promise<void> {
        const settings = this.host.timeSettings();
        let speed = 1;
        if (this.host.fastForward) {
            const ratio = settings.fastForwardRatio;
            speed = ratio > 1 ? ratio : EmulatorTimeControl.DEFAULT_FAST_FORWARD_RATIO;
        } else if (this.host.slowMotion) {
            const ratio = settings.slowMotionRatio;
            speed = 1 / (ratio > 1 ? ratio : EmulatorTimeControl.DEFAULT_SLOW_MOTION_RATIO);
        }
        await this.host.core?.setSpeed(speed);
        // ESSound runs at the machine's speed, so fast forward and slow motion
        // carry its audio with them.
        this.host.esSound.setSpeed(speed);
    }

    async applyRewindSettings(): Promise<void> {
        const settings = this.host.timeSettings();
        await this.host.core?.setRewind(
            settings.rewindEnabled,
            settings.rewindGranularity,
            settings.rewindBufferBytes,
        );
    }

    /**
     * Rewinding suspends normal emulation and walks the history backwards for as
     * long as the input is held.
     *
     * Whether it is held is tracked in a flag rather than in the animation frame
     * handle, because both the suspend and every step are round trips to the
     * worker: a release landing while one is in flight would otherwise be lost,
     * and the loop would keep running until it had eaten the entire history.
     */
    startRewinding(): void {
        if (
            this.rewinding ||
            !this.host.core ||
            !this.host.loaded ||
            // With no history being recorded there is nothing to walk back through,
            // and suspending for the length of the hold would just look like a freeze.
            !this.isRewindEnabled()
        ) {
            return;
        }
        this.rewinding = true;
        this.host.esSound.setRewinding(true);
        this.rewindLastTick = 0;
        // Owe one entry up front, so even a tap steps back immediately.
        this.rewindOwed = 1;
        // Lights the toolbar button up for the length of the hold, whether it was
        // the button or the keyboard that started it.
        this.host.onDidChange();
        this.queueCoreTransition(async core => {
            await core.suspend();
            // The input may already have been released while the core was still
            // suspending, in which case the queued resume takes it from here.
            if (this.rewinding) {
                this.rewindHandle = requestAnimationFrame(now => { this.rewindTick(now); });
            }
        });
    }

    stopRewinding(): void {
        if (!this.rewinding) {
            return;
        }
        this.rewinding = false;
        // Winds the tracks back by everything the core gave up, and starts them
        // again if the machine is running.
        this.host.esSound.setRewinding(false);
        if (this.rewindHandle !== undefined) {
            cancelAnimationFrame(this.rewindHandle);
            this.rewindHandle = undefined;
        }
        // Not on the way out: tearing the session down stops any rewind with it.
        if (!this.host.isDisposed) {
            this.host.onDidChange();
        }
        this.queueCoreTransition(async core => {
            if (!this.host.paused) {
                await core.run();
            }
        });
    }

    /**
     * Play the history back at the speed it was recorded at.
     *
     * Pacing is by elapsed time rather than one entry per animation frame: the
     * machine runs at VB_FRAME_RATE and an entry covers `granularity` frames of
     * it, so a 120 Hz display would otherwise rewind at more than twice speed and
     * tear through a minute of history in seconds.
     */
    protected async rewindTick(now: number): Promise<void> {
        this.rewindHandle = undefined;
        if (!this.rewinding) {
            return;
        }

        // Cap the catch-up so a stalled frame cannot jump back by seconds at once.
        const elapsed = this.rewindLastTick
            ? Math.min(now - this.rewindLastTick, EmulatorTimeControl.REWIND_MAX_CATCHUP_MS)
            : 0;
        this.rewindLastTick = now;
        const granularity = Math.max(1, this.host.timeSettings().rewindGranularity);
        this.rewindOwed += (elapsed / 1000) * (VB_FRAME_RATE / granularity);

        const count = Math.floor(this.rewindOwed);
        if (count > 0) {
            this.rewindOwed -= count;
            const applied = await this.host.core?.rewindStep(count) ?? 0;
            // An entry covers `granularity` frames, so this is how much emulated
            // time the machine has just given up.
            this.host.esSound.rewind((applied * granularity) / VB_FRAME_RATE);
            if (!this.rewinding) {
                return;
            }
            if (applied === 0) {
                // Nothing left to go back to. Hold on the oldest state rather than
                // resuming under the user's finger; the release resumes as usual.
                return;
            }
        }

        this.rewindHandle = requestAnimationFrame(next => { this.rewindTick(next); });
    }

    /**
     * Serialize transitions between running and suspended.
     *
     * Both VesVbCore#run and #suspend touch the audio context as well as the
     * worker, so overlapping them can leave the context suspended while the
     * worker believes it is emulating — which stalls emulation outright, since it
     * is the audio graph that clocks it. Pressing and releasing rewind faster
     * than a suspend completes is exactly that case.
     *
     * The action is bound to the core that was current when it was queued and is
     * skipped if the session has been torn down or rebuilt since, so a release
     * queued on the way out cannot resume a disposed core or a fresh one.
     */
    queueCoreTransition(action: (core: VesVbCore) => Promise<void>): void {
        const core = this.host.core;
        if (!core) {
            return;
        }
        this.coreTransition = this.coreTransition
            .then(() => this.host.core === core ? action(core) : undefined)
            .catch(error => this.host.onError(
                error instanceof Error ? error.message : String(error)
            ));
    }
}
