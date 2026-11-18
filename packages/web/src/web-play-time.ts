/**
 * Kept by CRC32 in library/play.json, so a renamed or moved ROM keeps its hours, and for every ROM that runs, not only
 * library ones. Duration is running time, not wall time: the host reports when the machine runs through setRunning, one
 * idempotent setter, as for the macro store. The count is written when a game starts, the duration is banked on every
 * pause and once a minute, so a hard-closed tab loses at most a minute.
 */
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { VueportStorage } from 'vueport-core/lib/common/emulator-host';
import { nls } from 'vueport-core/lib/common/emulator-nls';

export interface PlayStats {
    count: number;
    ms: number; // total, ms
    firstPlayedAt: number; // epoch ms
    lastPlayedAt: number; // epoch ms
}

const PLAY_PATH = 'library/play.json';

const BANK_INTERVAL_MS = 60_000; // an hour of play is a handful of writes, and a crash costs a minute

export class PlayTimes {

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    protected stats = new Map<string, PlayStats>();
    protected loaded = false;

    protected current: string | undefined;
    protected running = false;
    protected clockReadAt: number | undefined; // monotonic clock
    protected unsaved = false;
    protected ticker: ReturnType<typeof setInterval> | undefined;
    protected writing: Promise<void> = Promise.resolve();

    constructor(protected readonly storage: VueportStorage) {
        // a tab can be closed, hidden or left without a pause first, so bank on the way out. There is no document when
        // constructed outside a page (the probes)
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    this.flush();
                }
            });
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('pagehide', () => this.flush());
        }
    }

    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        try {
            const parsed = JSON.parse(await this.storage.readText(PLAY_PATH)) as unknown;
            if (parsed && typeof parsed === 'object') {
                for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
                    const stats = readStats(value);
                    if (stats) {
                        this.stats.set(id, stats);
                    }
                }
            }
        } catch {
            // missing, or half written; nothing played yet is right for both
        }
        this.changed();
    }

    of(id: string): PlayStats | undefined {
        const stats = this.stats.get(id);
        // the running session counts without waiting to be banked, so a game closed a second ago does not read a minute
        // short
        return stats && this.current === id
            ? { ...stats, ms: stats.ms + this.pending() }
            : stats;
    }

    total(ids: readonly string[]): PlayStats | undefined {
        const each = ids.map(id => this.of(id)).filter((stats): stats is PlayStats => stats !== undefined);
        if (each.length === 0) {
            return undefined;
        }
        return {
            count: each.reduce((sum, stats) => sum + stats.count, 0),
            ms: each.reduce((sum, stats) => sum + stats.ms, 0),
            firstPlayedAt: Math.min(...each.map(stats => stats.firstPlayedAt)),
            lastPlayedAt: Math.max(...each.map(stats => stats.lastPlayedAt)),
        };
    }

    // counts at once, not after a qualifying time. Not when the ROM is already in the machine: that is the app
    // rebuilding it (a patch, a save slot change, a save import), not a second play
    began(id: string): void {
        this.bank();
        const again = this.current === id;
        this.stop();
        this.current = id;
        const now = Date.now();
        const held = this.stats.get(id);
        this.stats.set(id, {
            count: (held?.count ?? 0) + (again ? 0 : 1),
            ms: held?.ms ?? 0,
            firstPlayedAt: held?.firstPlayedAt ?? now,
            lastPlayedAt: now,
        });
        this.unsaved = true;
        this.save();
        this.changed();
    }

    // called on every load, pause, resume and stop, so it is idempotent
    setRunning(running: boolean): void {
        if (running === this.running) {
            return;
        }
        this.bank();
        this.running = running;
        this.clockReadAt = running ? performance.now() : undefined;
        if (running) {
            this.ticker ??= setInterval(() => this.flush(), BANK_INTERVAL_MS);
        } else {
            this.stopTicker();
            this.flush();
        }
    }

    ended(): void {
        this.setRunning(false);
        this.bank();
        this.current = undefined;
        this.flush();
    }

    // a game running right now is kept, as in clear
    forget(ids: Iterable<string>): void {
        this.bank();
        let dropped = false;
        for (const id of ids) {
            if (id !== this.current && this.stats.delete(id)) {
                dropped = true;
            }
        }
        if (dropped) {
            this.save();
            this.changed();
        }
    }

    // a running game starts again as one play beginning now
    clear(): void {
        this.bank();
        const playing = this.current !== undefined && this.stats.has(this.current);
        this.stats.clear();
        if (playing && this.current) {
            const now = Date.now();
            this.stats.set(this.current, { count: 1, ms: 0, firstPlayedAt: now, lastPlayedAt: now });
        }
        this.save();
        this.changed();
    }

    protected pending(): number {
        return this.running && this.clockReadAt !== undefined
            ? performance.now() - this.clockReadAt
            : 0;
    }

    protected bank(): void {
        const elapsed = this.pending();
        this.clockReadAt = this.running ? performance.now() : undefined;
        const stats = this.current ? this.stats.get(this.current) : undefined;
        if (!stats || elapsed <= 0) {
            return;
        }
        stats.ms += elapsed;
        stats.lastPlayedAt = Date.now();
        this.unsaved = true;
    }

    protected flush(): void {
        this.bank();
        if (this.unsaved) {
            this.save();
            this.changed();
        }
    }

    protected stopTicker(): void {
        if (this.ticker !== undefined) {
            clearInterval(this.ticker);
            this.ticker = undefined;
        }
    }

    protected stop(): void {
        this.running = false;
        this.clockReadAt = undefined;
        this.stopTicker();
    }

    protected save(): void {
        this.unsaved = false;
        this.write();
    }

    // serialized through one promise like the library's stores, as a minute tick landing on a game start would
    // otherwise give one file two writers
    protected write(): Promise<void> {
        const record: Record<string, PlayStats> = {};
        for (const [id, stats] of this.stats) {
            // a monotonic clock's fractions only make the file harder to read
            record[id] = { ...stats, ms: Math.round(stats.ms) };
        }
        return this.writing = this.writing
            .catch(() => undefined)
            .then(() => this.storage.writeText(PLAY_PATH, JSON.stringify(record)))
            .catch(() => undefined);
    }

    protected changed(): void {
        this.onDidChangeEmitter.fire();
    }
}

function readStats(value: unknown): PlayStats | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const held = value as Partial<PlayStats>;
    const count = Math.max(0, Math.round(Number(held.count) || 0));
    const ms = Math.max(0, Math.round(Number(held.ms) || 0));
    if (count === 0 && ms === 0) {
        return undefined;
    }
    const lastPlayedAt = Number(held.lastPlayedAt) || 0;
    return {
        count,
        ms,
        firstPlayedAt: Number(held.firstPlayedAt) || lastPlayedAt,
        lastPlayedAt,
    };
}

// never seconds past the first minute, and never "0 min" for a game that was started
export function playTimeLabel(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) {
        return nls.localize('vueport/library/duration/underAMinute', 'under a minute');
    }
    if (minutes < 60) {
        return nls.localize('vueport/library/duration/minutes', '{0} min', minutes);
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0
        ? nls.localize('vueport/library/duration/hours', '{0} h', hours)
        : nls.localize('vueport/library/duration/hoursMinutes', '{0} h {1} min', hours, rest);
}

export function playCountLabel(count: number): string {
    return count === 1
        ? nls.localize('vueport/library/onceOnly', 'once')
        : nls.localize('vueport/library/timesPlayed', '{0} times', count);
}
