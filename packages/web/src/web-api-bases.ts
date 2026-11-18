/**
 * Where the two catalog APIs are reached. Both default to vueport-server's relay (see web-proxy.ts) and are the same
 * endpoint, but do two jobs, and a mirror may need them apart: the homebrew base serves the start page strip and the
 * Homebrew Browser listings, the game info base answers a single ROM's CRC32. As in web-theme.ts, nothing is stored
 * until the user changes it, so a new shipped default still reaches everyone else.
 */
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { PVB_PROXY_BASE } from './web-proxy';

export const DEFAULT_HOMEBREW_API = PVB_PROXY_BASE;
export const DEFAULT_GAME_INFO_API = PVB_PROXY_BASE;

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\//i;

function splitBase(base: string): { path: string; query: string } {
    const end = base.search(/[?#]/);
    if (end < 0) {
        return { path: base, query: '' };
    }
    // a fragment never reaches the server, so it has no business in a request
    const rest = base.slice(end);
    const hash = rest.indexOf('#');
    return { path: base.slice(0, end), query: hash < 0 ? rest : rest.slice(0, hash) };
}

/**
 * Takes two liberties, as the alternative is a field with rules nobody is told about. A missing trailing slash is added
 * to the path: every call site appends (`<base><crc32>/`), so without one it would silently ask the parent path; a
 * query the base carries (an API key) stays after the slash, see apiUrl. A missing scheme becomes `https://`; a leading
 * `/` is kept, as a path on this origin, for whoever reverse-proxies the catalog under their own domain.
 */
export function normalizeApiBase(value: string, fallback: string): string {
    const trimmed = value.trim();
    if (trimmed === '') {
        return fallback;
    }
    const addressed = trimmed.startsWith('/') || ABSOLUTE.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
    const { path, query } = splitBase(addressed);
    return `${path.endsWith('/') ? path : `${path}/`}${query}`;
}

// `path` joins the base's path, `query` (without its `?`) joins whatever query the base carries; plain concatenation
// would put a path after the query, or a second `?` into it
export function apiUrl(base: string, path: string, query = ''): string {
    const split = splitBase(base);
    const queries = [split.query.replace(/^\?/, ''), query].filter(part => part !== '');
    return `${split.path}${path}${queries.length > 0 ? `?${queries.join('&')}` : ''}`;
}

// only the shape is checked, not that anything answers: finding out costs a request the settings pane should not make
export function isApiBase(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed === '') {
        // empty is not an error, it is how the field is left at its default
        return true;
    }
    if (trimmed.startsWith('/')) {
        return true;
    }
    try {
        const url = new URL(normalizeApiBase(trimmed, ''));
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

interface ApiBaseSetting {
    read(): string;
    stored(): string;
    write(value: string): void;
    readonly onDidChange: Event<void>;
}

function apiBaseSetting(storageKey: string, fallback: string): ApiBaseSetting {
    const emitter = new Emitter<void>();
    const stored = (): string => {
        try {
            const raw = window.localStorage.getItem(storageKey);
            return raw === null ? '' : normalizeApiBase(raw, '');
        } catch {
            // private browsing: nothing was remembered
            return '';
        }
    };
    const read = (): string => stored() || fallback;
    return {
        read,
        stored,
        write(value: string): void {
            const next = normalizeApiBase(value, fallback);
            if (next === read()) {
                return;
            }
            try {
                if (next === fallback) {
                    // cleared rather than stored, so a later change to the shipped default still reaches this page
                    window.localStorage.removeItem(storageKey);
                } else {
                    window.localStorage.setItem(storageKey, next);
                }
            } catch {
                // the choice still applies to this session, it just is not remembered
            }
            emitter.fire();
        },
        onDidChange: emitter.event,
    };
}

const homebrew = apiBaseSetting('vueport.homebrewApiBase', DEFAULT_HOMEBREW_API);
const gameInfo = apiBaseSetting('vueport.gameInfoApiBase', DEFAULT_GAME_INFO_API);

// ends in a slash
export const homebrewApiBase = (): string => homebrew.read();
// empty for "wherever the default is": the settings field shows an empty box under a placeholder naming the default,
// as the resolved address typed out would read as a choice that was made
export const storedHomebrewApiBase = (): string => homebrew.stored();
// empty puts the default back
export const setHomebrewApiBase = (value: string): void => homebrew.write(value);
export const onDidChangeHomebrewApiBase: Event<void> = homebrew.onDidChange;

// ends in a slash
export const gameInfoApiBase = (): string => gameInfo.read();
// see storedHomebrewApiBase
export const storedGameInfoApiBase = (): string => gameInfo.stored();
// empty puts the default back
export const setGameInfoApiBase = (value: string): void => gameInfo.write(value);
export const onDidChangeGameInfoApiBase: Event<void> = gameInfo.onDidChange;
