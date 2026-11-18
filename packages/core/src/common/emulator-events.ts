// Disposable and Emitter shaped like Theia's, so they work with Theia's DisposableCollection and VES code without
// conversion

export interface Disposable {
    dispose(): void;
}

export namespace Disposable {
    // calling twice runs it once
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

    export const NULL: Disposable = { dispose: () => { } };
}

export interface DisposableGroup {
    push(disposable: Disposable): unknown;
}

export interface Event<T> {
    (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: DisposableGroup): Disposable;
}

export namespace Event {
    export const None: Event<never> = () => Disposable.NULL;
}

// anything pushed after disposal is disposed immediately, so a late registration on a gone widget releases itself
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

    // resets afterwards so the collection is reusable, as toDisposeOnDetach is emptied at every detach and refilled on
    // attach
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

interface Registration<T> {
    listener: (e: T) => unknown;
    thisArgs?: unknown;
}

// a listener that throws is logged and skipped: these fire from the drive loop's error path and from message handlers,
// where one panel's bug would otherwise kill the emulator
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
        // iterates a copy, as a listener may add or remove listeners (a panel closing itself on an event)
        for (const { listener, thisArgs } of [...this.registrations]) {
            try {
                listener.call(thisArgs, value);
            } catch (error) {
                console.error(error);
            }
        }
    }

    // lets callers skip building expensive payloads
    get hasListeners(): boolean {
        return this.registrations.length > 0;
    }

    dispose(): void {
        this.registrations = [];
    }
}
