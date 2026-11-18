import { Disposable, Emitter, Event } from '../common/emulator-events';
import { VB_FRAME_RATE } from '../common/vb-constants';
import { RewindHistory } from '../common/vb-protocol';
import { Sim } from './core/vb-core';
import { PadCommand } from './emulator-gamepad-ui';
import { EmulatorTimeAudio, EmulatorTimeControl } from './emulator-time-control';

export interface EmulatorRewindBrowserHost {
    readonly sim?: Sim;
    readonly paused: boolean;
    readonly esSound: EmulatorTimeAudio;
    onNothingToRewind(): void;
    // tells the machine again which buttons are held now. A capture carries the key register of its moment, and the
    // input only sends changes, so without this a direction held back then stays held once play resumes
    restoreInput(): Promise<void>;
}

/**
 * The rewind history as a filmstrip, as in the console makers' classics collections: the machine stops, thumbnails
 * about a second apart lay out the last minutes, and the screen shows whichever moment is picked. Going back and forth
 * costs nothing (see RewindStore in vb-worker.ts); playing on from a moment gives up what came after it, backing out
 * returns to where the strip was opened. The Rewind key opens it like the button; held rewind (EmulatorTimeControl) is
 * left to hosts without the strip.
 *
 * The cursor runs ahead of the worker: it moves at once, and the worker follows to wherever it is by then, so a held
 * arrow key never queues up seeks.
 */
export class EmulatorRewindBrowser implements Disposable {

    protected _history?: RewindHistory;
    // the capture picked, which the worker is on or heading to
    protected _cursor = 0;
    protected landed = 0;
    protected opening = false;
    protected seeking = false;
    protected readonly thumbnailUrls = new Map<number, string>();
    // bumped whenever the history is let go, so thumbnails still loading for it are dropped
    protected generation = 0;
    protected changePending = false;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(
        protected readonly host: EmulatorRewindBrowserHost,
        protected readonly time: EmulatorTimeControl,
    ) { }

    get isOpen(): boolean {
        return this._history !== undefined;
    }

    // undefined while closed
    get history(): RewindHistory | undefined {
        return this._history;
    }

    get cursor(): number {
        return this._cursor;
    }

    thumbnailUrl(capture: number): string | undefined {
        return this.thumbnailUrls.get(capture);
    }

    // emulated seconds between the capture picked and the moment the strip was opened
    get secondsBack(): number {
        const history = this._history;
        return history
            ? (history.frames[history.cursor] - history.frames[this._cursor]) / VB_FRAME_RATE
            : 0;
    }

    open(): void {
        // not over a held rewind, which is walking the same history
        if (this.isOpen || this.opening || this.time.rewinding || !this.host.sim || !this.time.isRewindEnabled()) {
            return;
        }
        this.opening = true;
        this.time.queueCoreTransition(async core => {
            try {
                await core.suspend();
                const sim = this.host.sim;
                const history = sim && await sim.rewindHistory();
                if (!sim || !history || history.frames.length < 2) {
                    if (!this.host.paused) {
                        await core.run();
                    }
                    this.host.onNothingToRewind();
                    return;
                }
                // tracks hold while the strip is up and are wound back by the time given up when it closes
                this.host.esSound.setRewinding(true);
                this._history = history;
                this._cursor = history.cursor;
                this.landed = history.cursor;
                this.fireChange();
                this.loadThumbnails(sim, history, this.generation);
            } finally {
                this.opening = false;
            }
        });
    }

    seek(capture: number): void {
        const history = this._history;
        if (!history) {
            return;
        }
        const target = Math.max(0, Math.min(Math.round(capture), history.frames.length - 1));
        if (target === this._cursor) {
            return;
        }
        this._cursor = target;
        this.fireChange();
        if (this.seeking) {
            return;
        }
        this.seeking = true;
        this.time.queueCoreTransition(async core => {
            try {
                while (this.isOpen && this.landed !== this._cursor) {
                    this.landed = await core.rewindSeek(this._cursor);
                }
            } finally {
                this.seeking = false;
            }
        });
    }

    // by captures, which are `rewindGranularity` frames apart: frame by frame at the default
    step(captures: number): void {
        this.seek(this._cursor + captures);
    }

    stepThumbnail(direction: number): void {
        const history = this._history;
        if (!history || direction === 0) {
            return;
        }
        const { thumbnails } = history;
        let target: number | undefined;
        if (direction < 0) {
            for (let i = thumbnails.length - 1; i >= 0 && target === undefined; i--) {
                if (thumbnails[i] < this._cursor) {
                    target = thumbnails[Math.max(0, i + direction + 1)];
                }
            }
            target ??= 0;
        } else {
            for (let i = 0; i < thumbnails.length && target === undefined; i++) {
                if (thumbnails[i] > this._cursor) {
                    target = thumbnails[Math.min(thumbnails.length - 1, i + direction - 1)];
                }
            }
            target ??= history.frames.length - 1;
        }
        this.seek(target);
    }

    // a game pad's interface commands (listenToGamepadUi): left and right walk the thumbnails, repeating while held, the
    // shoulders step single frames, choosing plays on, backing out cancels
    steer(command: PadCommand): void {
        switch (command) {
            case 'left': this.stepThumbnail(-1); break;
            case 'right': this.stepThumbnail(1); break;
            case 'previous': this.step(-1); break;
            case 'next': this.step(1); break;
            case 'confirm': case 'start': this.resume(); break;
            case 'cancel': case 'palette': this.cancel(); break;
        }
    }

    resume(): void {
        this.close(false);
    }

    cancel(): void {
        this.close(true);
    }

    // closes the strip where the machine is, for something about to replace its state anyway (a loaded state, changed
    // rewind settings). `resume` false for a session being torn down
    abandon(resume = true): void {
        if (!this._history) {
            return;
        }
        this.letGo();
        this.host.esSound.setRewinding(false);
        if (resume) {
            this.time.queueCoreTransition(async core => {
                await this.host.restoreInput();
                if (!this.host.paused) {
                    await core.run();
                }
            });
        }
    }

    protected close(back: boolean): void {
        const history = this._history;
        if (!history) {
            return;
        }
        const target = back ? history.cursor : this._cursor;
        const seconds = (history.frames[history.cursor] - history.frames[target]) / VB_FRAME_RATE;
        this.letGo();
        this.time.queueCoreTransition(async core => {
            if (this.landed !== target) {
                this.landed = await core.rewindSeek(target);
            }
            await this.host.restoreInput();
            this.host.esSound.rewind(seconds);
            this.host.esSound.setRewinding(false);
            if (!this.host.paused) {
                await core.run();
            }
        });
    }

    protected letGo(): void {
        this._history = undefined;
        this.generation++;
        for (const url of this.thumbnailUrls.values()) {
            URL.revokeObjectURL(url);
        }
        this.thumbnailUrls.clear();
        this.fireChange();
    }

    // one at a time, newest first as the strip opens at the newest, so seeks are never stuck behind a pile of them
    protected async loadThumbnails(sim: Sim, history: RewindHistory, generation: number): Promise<void> {
        for (let i = history.thumbnails.length - 1; i >= 0; i--) {
            const capture = history.thumbnails[i];
            let png: ArrayBuffer | undefined;
            try {
                png = await sim.rewindThumbnail(capture);
            } catch {
                return;
            }
            if (generation !== this.generation) {
                return;
            }
            if (png) {
                this.thumbnailUrls.set(capture, URL.createObjectURL(new Blob([png], { type: 'image/png' })));
                this.fireChange();
            }
        }
    }

    // thumbnails arrive in quick succession, and each would otherwise redraw the whole strip
    protected fireChange(): void {
        if (this.changePending) {
            return;
        }
        this.changePending = true;
        requestAnimationFrame(() => {
            this.changePending = false;
            this.onDidChangeEmitter.fire();
        });
    }

    dispose(): void {
        this.abandon(false);
        this.onDidChangeEmitter.dispose();
    }
}
