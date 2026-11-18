/**
 * The commands last chosen from the palette, newest first, like VS Code's "recently used". Only palette choices count,
 * as a command reached by its keys already has a faster way in. Ids only, so labels follow a language change and
 * unknown ids are skipped. As in web-theme.ts, the limit is only stored once changed, so a new default still reaches
 * anyone who never touched it.
 */
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';

const STORAGE_KEY = 'vueport.recentCommands';
const LIMIT_KEY = 'vueport.maxRecentCommands';

export const DEFAULT_MAX_RECENT_COMMANDS = 5;
// a group of one is as good as off; more than ten would push the alphabetical list off the first screen
export const MIN_MAX_RECENT_COMMANDS = 1;
export const MAX_MAX_RECENT_COMMANDS = 10;

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeMaxRecentCommands: Event<void> = onDidChangeEmitter.event;

function clamp(value: number): number {
    return Math.max(MIN_MAX_RECENT_COMMANDS, Math.min(MAX_MAX_RECENT_COMMANDS, Math.round(value)));
}

export function maxRecentCommands(): number {
    try {
        const raw = window.localStorage.getItem(LIMIT_KEY);
        if (raw === null) {
            return DEFAULT_MAX_RECENT_COMMANDS;
        }
        const parsed = parseInt(raw, 10);
        return Number.isNaN(parsed) ? DEFAULT_MAX_RECENT_COMMANDS : clamp(parsed);
    } catch {
        // private browsing: nothing was remembered, so the default holds
        return DEFAULT_MAX_RECENT_COMMANDS;
    }
}

// lowering it drops the oldest at once, so raising it again does not bring them back
export function setMaxRecentCommands(value: number): void {
    const clamped = clamp(value);
    if (clamped === maxRecentCommands()) {
        return;
    }
    try {
        window.localStorage.setItem(LIMIT_KEY, String(clamped));
    } catch {
        // still applies to this session, it just is not remembered
    }
    store(recentCommands());
    onDidChangeEmitter.fire();
}

export function recentCommands(): string[] {
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
        return Array.isArray(parsed)
            ? parsed.filter((id): id is string => typeof id === 'string').slice(0, maxRecentCommands())
            : [];
    } catch {
        // private browsing, or something else in the slot
        return [];
    }
}

export function rememberCommand(id: string): void {
    store([id, ...recentCommands().filter(entry => entry !== id)]);
}

function store(ids: string[]): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, maxRecentCommands())));
    } catch {
        // the command still runs, it just is not remembered
    }
}
