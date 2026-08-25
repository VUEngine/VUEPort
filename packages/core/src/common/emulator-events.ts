/**
 * The two primitives the emulator needs from a host framework, provided here so
 * that it does not need one.
 *
 * Theia's `Disposable` and `Emitter` are what these replace, and the shapes are
 * deliberately identical to Theia's rather than merely similar: `Event<T>` takes
 * the same three parameters and `Disposable` is the same one-method interface,
 * so a listener registered here can still be pushed onto a Theia
 * `DisposableCollection`, and an event exposed here can still be consumed by
 * VES code that expects Theia's. Structural typing does the rest — nothing
 * has to be converted at the boundary.
 *
 * Keeping these in `common/` rather than beside the core is what lets the
 * worker, the core wrapper and the panels share one notion of an event without
 * any of them importing a framework.
 */

/** Something with a lifetime, released by calling `dispose`. */
export interface Disposable {
    dispose(): void;
}

export namespace Disposable {
    /** Wrap a function as a Disposable. Calling twice runs it once. */
    export function create(fn: () => void): Disposable {
        let done = false;
        return {
            dispose: () => {
                if (!done) {
                    done = true;
                    fn();
                }
            },
        };
    }

    /** A Disposable that does nothing, for a branch that has nothing to release. */
    export const NULL: Disposable = { dispose: () => { } };
}

/**
 * Anything a listener's Disposable can be collected into.
 *
 * An array satisfies this, and so does Theia's `DisposableCollection`, which is
 * why callers can keep passing whichever they already hold.
 */
export interface DisposableGroup {
    push(disposable: Disposable): unknown;
}

/**
 * A typed event.
 *
 * Callable rather than an object with `addListener`, matching Theia, so that
 * `readonly onFoo: Event<T>` reads as `onFoo(handler)` at the call site.
 */
export interface Event<T> {
    (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: DisposableGroup): Disposable;
}

export namespace Event {
    /** An event that never fires. */
    export const None: Event<never> = () => Disposable.NULL;
}

/**
 * A bag of things to release together.
 *
 * Disposing it disposes everything in it, and anything pushed afterwards is
 * disposed immediately — so a late registration on a widget that has already
 * gone away releases itself rather than leaking.
 */
export class DisposableCollection implements Disposable {

    protected disposables: Disposable[] = [];
    protected disposed = false;

    constructor(...disposables: Disposable[]) {
        disposables.forEach(disposable => this.push(disposable));
    }

    get isDisposed(): boolean {
        return this.disposed;
    }

    push(disposable: Disposable): Disposable {
        if (this.disposed) {
            disposable.dispose();
            return Disposable.NULL;
        }
        this.disposables.push(disposable);
        return Disposable.create(() => {
            const index = this.disposables.indexOf(disposable);
            if (index !== -1) {
                this.disposables.splice(index, 1);
            }
        });
    }

    pushAll(disposables: Disposable[]): Disposable[] {
        return disposables.map(disposable => this.push(disposable));
    }

    /**
     * Release everything, and go back to being reusable.
     *
     * Reusable because `toDisposeOnDetach` is emptied at every detach and
     * filled again at the next attach, which is the ordinary life of a docked
     * panel rather than an unusual one.
     */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const held = this.disposables;
        this.disposables = [];
        for (const disposable of held) {
            try {
                disposable.dispose();
            } catch (error) {
                console.error(error);
            }
        }
        this.disposed = false;
    }
}

/** One listener, with the `this` it asked to be called on. */
interface Registration<T> {
    listener: (e: T) => unknown;
    thisArgs?: unknown;
}

/**
 * Fires an {@link Event}.
 *
 * A listener that throws is logged and skipped rather than allowed to stop the
 * ones behind it — these events are fired from the drive loop's error path and
 * from message handlers, where losing the remaining listeners would turn one
 * panel's bug into a dead emulator.
 */
export class Emitter<T = void> implements Disposable {

    protected registrations: Registration<T>[] = [];
    protected _event?: Event<T>;

    get event(): Event<T> {
        if (!this._event) {
            this._event = (listener, thisArgs?, disposables?) => {
                const registration: Registration<T> = { listener, thisArgs };
                this.registrations.push(registration);

                const disposable = Disposable.create(() => {
                    const index = this.registrations.indexOf(registration);
                    if (index !== -1) {
                        this.registrations.splice(index, 1);
                    }
                });

                disposables?.push(disposable);
                return disposable;
            };
        }
        return this._event;
    }

    fire(value: T): void {
        // Fired against a copy, because a listener is allowed to add or remove
        // listeners — a panel that closes itself in response to an event is the
        // ordinary case, and it must not shift the list out from under the loop.
        for (const { listener, thisArgs } of [...this.registrations]) {
            try {
                listener.call(thisArgs, value);
            } catch (error) {
                console.error(error);
            }
        }
    }

    /** Whether firing would reach anyone, for skipping expensive payloads. */
    get hasListeners(): boolean {
        return this.registrations.length > 0;
    }

    dispose(): void {
        this.registrations = [];
    }
}
