// a value read once and kept, unless the read could not tell. Failures are retried after a delay instead of being
// cached (a symbol .elf read while the build is still writing it would stick as "no symbols")

export interface CachedAnswerRead<T> {
    value?: T;
    settled: boolean;
}

export class CachedAnswer<T> {

    protected pending: Promise<T | undefined> | undefined;
    protected retryAfter = 0;

    constructor(
        protected readonly read: () => Promise<CachedAnswerRead<T>>,
        protected readonly retryDelay: number,
        // injectable, so a test does not have to wait out the delay
        protected readonly now: () => number = () => Date.now(),
    ) { }

    // concurrent askers share one read, as the promise is kept rather than the result
    get(): Promise<T | undefined> {
        if (this.pending) {
            return this.pending;
        }
        if (this.now() < this.retryAfter) {
            return Promise.resolve(undefined);
        }

        const attempt: Promise<T | undefined> = this.read().then(
            outcome => {
                if (!outcome.settled) {
                    this.forget(attempt);
                }
                return outcome.value;
            },
            error => {
                this.forget(attempt);
                throw error;
            },
        );
        this.pending = attempt;
        return attempt;
    }

    get isAnswered(): boolean {
        return this.pending !== undefined;
    }

    clear(): void {
        this.pending = undefined;
        this.retryAfter = 0;
    }

    // only if it is still the current read, so a clear in the meantime is not undone
    protected forget(attempt: Promise<T | undefined>): void {
        if (this.pending !== attempt) {
            return;
        }
        this.pending = undefined;
        this.retryAfter = this.now() + this.retryDelay;
    }
}
