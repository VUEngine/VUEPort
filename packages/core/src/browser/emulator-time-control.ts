import { VB_FRAME_RATE } from '../common/vb-constants';
import { Core } from './core/vb-core';

export interface EmulatorTimeSettings {
    fastForwardRatio: number;
    slowMotionRatio: number;
    rewindEnabled: boolean;
    // frames of emulation covered by one entry of rewind history
    rewindGranularity: number;
    rewindBufferBytes: number;
}

// the part of ESSound playback that has to follow the machine's clock
export interface EmulatorTimeAudio {
    setSpeed(speed: number): void;
    setRewinding(rewinding: boolean): void;
    rewind(seconds: number): void;
}

export interface EmulatorTimeControlHost {
    readonly core?: Core;
    readonly esSound: EmulatorTimeAudio;
    // false before the ROM has booted. Not `loaded`: Theia takes every BaseWidget for a PreviewableWidget and sets
    // `loaded = true` when it becomes the active tab, which the studio's emulator is
    readonly romLoaded: boolean;
    readonly paused: boolean;
    readonly fastForward: boolean;
    readonly slowMotion: boolean;
    readonly isDisposed: boolean;
    timeSettings(): EmulatorTimeSettings;
    onDidChange(): void;
    onError(message: string): void;
}

// speed, rewind and the ordering of run/suspend transitions, which all decide how fast emulated time passes by
// talking to the core. Settings come through EmulatorTimeSettings, so this works in hosts without a preference service
export class EmulatorTimeControl {

    static readonly DEFAULT_FAST_FORWARD_RATIO = 4;
    static readonly DEFAULT_SLOW_MOTION_RATIO = 3;
    // how much history a single rewind tick may make up for after a stall
    static readonly REWIND_MAX_CATCHUP_MS = 100;

    rewinding = false;
    protected rewindHandle?: number;
    protected rewindLastTick = 0;
    // history entries owed from earlier ticks, kept fractional so pacing does not drift
    protected rewindOwed = 0;
    // serializes run/suspend, so a release can never overtake its own press
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
        // ESSound runs at the machine's speed, so fast forward and slow motion carry its audio with them
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

    // whether rewind is held is tracked in a flag rather than the animation frame handle, as suspend and every step are
    // worker round trips: a release landing during one would be lost and the loop would eat the entire history
    startRewinding(): void {
        if (
            this.rewinding ||
            !this.host.core ||
            !this.host.romLoaded ||
            // with no history recorded, suspending for the hold would just look like a freeze
            !this.isRewindEnabled()
        ) {
            return;
        }
        this.rewinding = true;
        this.host.esSound.setRewinding(true);
        this.rewindLastTick = 0;
        // owe one entry up front, so even a tap steps back immediately
        this.rewindOwed = 1;
        this.host.onDidChange();
        this.queueCoreTransition(async core => {
            await core.suspend();
            // the input may already have been released while suspending, then the queued resume takes it from here
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
        this.host.esSound.setRewinding(false);
        if (this.rewindHandle !== undefined) {
            cancelAnimationFrame(this.rewindHandle);
            this.rewindHandle = undefined;
        }
        // not on the way out: tearing the session down stops any rewind with it
        if (!this.host.isDisposed) {
            this.host.onDidChange();
        }
        this.queueCoreTransition(async core => {
            if (!this.host.paused) {
                await core.run();
            }
        });
    }

    // paced by elapsed time rather than one entry per animation frame, as an entry covers `granularity` frames at
    // VB_FRAME_RATE and a 120 Hz display would otherwise rewind at more than twice speed
    protected async rewindTick(now: number): Promise<void> {
        this.rewindHandle = undefined;
        if (!this.rewinding) {
            return;
        }

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
            this.host.esSound.rewind((applied * granularity) / VB_FRAME_RATE);
            if (!this.rewinding) {
                return;
            }
            if (applied === 0) {
                // nothing left to go back to: hold on the oldest state rather than resuming under the user's finger
                return;
            }
        }

        this.rewindHandle = requestAnimationFrame(next => { this.rewindTick(next); });
    }

    /**
     * Serializes run/suspend transitions. VbCore#run and #suspend touch the audio context as well as the worker, and
     * overlapping them (rewind pressed and released faster than a suspend completes) can leave the context suspended
     * while the worker emulates, which stalls it, as the audio graph clocks it. The action is skipped if the session
     * was torn down or rebuilt since queueing, so a release cannot resume a disposed or fresh core.
     */
    queueCoreTransition(action: (core: Core) => Promise<void>): void {
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
