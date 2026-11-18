// looked up by CRC32 at `<api base>/<crc32>/`: unreachable rejects with PlanetVbUnavailableError, unknown resolves
// undefined. `<api base>/title/<name>/` returns scored lookalike titles, the fallback for translations and hacks; a
// guess where a checksum is a fact, so the two are kept apart
import { gameInfoApi } from './web-pvb-api';
import { apiUrl, onDidChangeGameInfoApiBase } from './web-api-bases';

export interface PlanetVbGame {
    // the game, not the dump: the only thing saying a US cartridge and its Japanese release are one game in the library
    itemId: number;
    title: string;
    covers: PlanetVbCover[]; // one per scanned region or a single "Default" for homebrew; most have only the front
    // homebrew gets Planet VB's default header, as on the site; empty only where the catalog names none
    backgrounds: PlanetVbBackground[];
    description: string; // flattened from the API's HTML; may be empty
    developer: string;
    publisher: string;
    released: string; // a year, or a fuller date
    genre: string;
    players: string; // "1 Player", "1-2 Players (Simultaneously)", …
    region: string;
    status: string;
    kind: string; // raw catalog value
    score?: number; // 0–100, undefined where unrated (most homebrew and a fair few cartridges)
    planetVbUrl?: string;
    romTitle?: string; // this dump's record, unlike `title`, which may name a whole series of dumps
    md5?: string; // lower-case hex
    crc32?: string;
    version?: string;
    latest: boolean;
}

export type PlanetVbFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export const PLANET_VB_FACES: ReadonlyArray<PlanetVbFace> = ['front', 'back', 'left', 'right', 'top', 'bottom'];

export interface PlanetVbCover {
    name: string;
    faces: Partial<Record<PlanetVbFace, string>>;
}

export interface PlanetVbBackground {
    name: string;
    url: string;
}

// offline or a server error, unlike a clean "no entry", which resolves undefined
export class PlanetVbUnavailableError extends Error { }

interface ApiNamed {
    id: number;
    name: string;
    role?: string;
}

export interface ApiImage {
    large?: string;
    medium?: string;
}

export interface ApiCover {
    name?: string;
    faces?: Partial<Record<PlanetVbFace, ApiImage>>;
}

export interface ApiBackground extends ApiImage {
    name?: string;
}

interface ApiItem {
    id: number;
    title?: string;
    type?: string;
    description?: string;
    url?: string;
    company?: ApiNamed[];
    people?: ApiNamed[];
    genre?: ApiNamed[];
    players?: ApiNamed[];
    region?: ApiNamed[];
    status?: ApiNamed[];
    year?: ApiNamed[];
    score?: number;
    covers?: ApiCover[];
    backgrounds?: ApiBackground[];
}

// a game rather than a dump (the ApiItem a checksum lookup nests in its ROM record), with the catalog's score for how
// close its title was
interface ApiTitleMatch extends ApiItem {
    similarity?: number; // 0–100
}

interface ApiRom {
    id: number;
    title?: string;
    hash?: { md5?: string; crc32?: string };
    version?: string;
    latest?: boolean;
    item?: ApiItem[];
    error?: string;
}

// an entry does not change while VUEPort runs, so the first answer holds for the session; inFlight stops two quick
// opens from making two requests. Failed lookups are kept in neither, so the next open retries
const settled = new Map<string, PlanetVbLookup>();
const inFlight = new Map<string, Promise<PlanetVbGame | undefined>>();

// which catalog the cached answers came from: pointing the setting elsewhere starts a new cache. Counted rather than
// only cleared, as a request to the old base still in flight would otherwise write its answer into the new cache
let generation = 0;
onDidChangeGameInfoApiBase(() => {
    generation++;
    settled.clear();
    inFlight.clear();
    settledTitles.clear();
    inFlightTitles.clear();
});

const reloading = new Set<string>(); // bypass the browser's HTTP cache on their next lookup; see forgetLookups

// for an entry just corrected on Planet VB; requests in flight are left to land
export function forgetLookups(crc32s: Iterable<string>): void {
    for (const crc32 of crc32s) {
        const key = crc32.toLowerCase();
        settled.delete(key);
        reloading.add(key);
    }
    for (const key of settledTitles.keys()) {
        reloading.add(`title:${key}`);
    }
    settledTitles.clear();
}

function reloads(key: string): RequestCache {
    return reloading.delete(key) ? 'no-cache' : 'default';
}

export interface PlanetVbLookup {
    game: PlanetVbGame | undefined;
}

// undefined means not looked up yet or the last try failed (call lookupRom); a returned lookup is final for the
// session, with `game` undefined for a catalogued miss
export function cachedRom(crc32: string | undefined): PlanetVbLookup | undefined {
    return crc32 ? settled.get(crc32.toLowerCase()) : undefined;
}

// undefined when Planet VB has no entry, rejects with PlanetVbUnavailableError when it could not be asked. Failures are
// not cached
export function lookupRom(crc32: string | undefined): Promise<PlanetVbGame | undefined> {
    if (!crc32) {
        return Promise.resolve(undefined);
    }

    const key = crc32.toLowerCase();
    const known = settled.get(key);
    if (known) {
        return Promise.resolve(known.game);
    }

    let pending = inFlight.get(key);
    if (!pending) {
        const asked = generation;
        pending = fetchRom(key)
            .then(game => {
                if (asked === generation) {
                    settled.set(key, { game });
                    inFlight.delete(key);
                }
                return game;
            })
            .catch(error => {
                // not cached, so reopening tries again
                inFlight.delete(key);
                throw error;
            });
        inFlight.set(key, pending);
    }
    return pending;
}

async function fetchRom(crc32: string): Promise<PlanetVbGame | undefined> {
    let response: Response;
    try {
        response = await fetch(apiUrl(gameInfoApi(), `${encodeURIComponent(crc32)}/`), {
            headers: { accept: 'application/json' },
            cache: reloads(crc32),
        });
    } catch (error) {
        // offline, DNS, a refused connection: all indistinguishable here
        throw new PlanetVbUnavailableError(
            error instanceof Error ? error.message : String(error));
    }

    // `{"error":"No ROM found."}` with 404 is a clean miss, not a failure
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new PlanetVbUnavailableError(`Planet VB answered ${response.status}.`);
    }

    let body: ApiRom;
    try {
        body = await response.json() as ApiRom;
    } catch {
        throw new PlanetVbUnavailableError('Planet VB sent something that was not JSON.');
    }
    if (body.error || !body.item || body.item.length === 0) {
        return undefined;
    }

    return toGame(body.item![0], body);
}

// the title search always answers with its five best: for `wario land` it ranks Mario Clash at 67 above Virtual Boy
// Wario Land at 63, and offers something at 13 for unknown names. From 90 up it is the same title spelled differently
export const TITLE_MATCH_SIMILARITY = 90;

export interface PlanetVbTitleMatch {
    game: PlanetVbGame;
    similarity: number; // 0–100
}

// needed more than for checksums, as dumps of one game mostly differ in the part of the file name this never sends
const settledTitles = new Map<string, PlanetVbTitleMatch | undefined>();
const inFlightTitles = new Map<string, Promise<PlanetVbTitleMatch | undefined>>();

// rejects with PlanetVbUnavailableError when the catalog could not be asked. The name goes as given, only the caller
// knows what it is (file name, header, input)
export function lookupTitle(title: string): Promise<PlanetVbTitleMatch | undefined> {
    const query = title.trim();
    if (!query) {
        return Promise.resolve(undefined);
    }

    const key = query.toLowerCase();
    if (settledTitles.has(key)) {
        return Promise.resolve(settledTitles.get(key));
    }

    let pending = inFlightTitles.get(key);
    if (!pending) {
        const asked = generation;
        pending = fetchTitle(query)
            .then(match => {
                if (asked === generation) {
                    settledTitles.set(key, match);
                    inFlightTitles.delete(key);
                }
                return match;
            })
            .catch(error => {
                inFlightTitles.delete(key);
                throw error;
            });
        inFlightTitles.set(key, pending);
    }
    return pending;
}

async function fetchTitle(title: string): Promise<PlanetVbTitleMatch | undefined> {
    let response: Response;
    try {
        // percent-encoded, not `+`: in a path segment a plus is a plus
        response = await fetch(apiUrl(gameInfoApi(), `title/${encodeURIComponent(title)}/`), {
            headers: { accept: 'application/json' },
            cache: reloads(`title:${title.toLowerCase()}`),
        });
    } catch (error) {
        throw new PlanetVbUnavailableError(
            error instanceof Error ? error.message : String(error));
    }

    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new PlanetVbUnavailableError(`Planet VB answered ${response.status}.`);
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new PlanetVbUnavailableError('Planet VB sent something that was not JSON.');
    }
    // anything but a list (an `{"error":…}`, an older catalog without the endpoint) reads as no match
    if (!Array.isArray(body)) {
        return undefined;
    }

    // picks the best rather than the first, as the order is not guaranteed
    let best: PlanetVbTitleMatch | undefined;
    for (const match of body as ApiTitleMatch[]) {
        const similarity = typeof match?.similarity === 'number' ? match.similarity : 0;
        if (typeof match?.id !== 'number' || similarity < TITLE_MATCH_SIMILARITY) {
            continue;
        }
        if (!best || similarity > best.similarity) {
            best = { game: toGame(match), similarity };
        }
    }
    return best;
}

// `rom` (one dump's record) only comes with a checksum lookup, so what it fills in is absent on a title match rather
// than guessed
function toGame(item: ApiItem, rom?: ApiRom): PlanetVbGame {
    const credits = [...(item.company ?? []), ...(item.people ?? [])];

    return {
        itemId: item.id,
        title: (item.title ?? rom?.title ?? '').trim() || 'Unknown',
        covers: coversOf(item.covers),
        backgrounds: backgroundsOf(item.backgrounds),
        description: flattenHtml(item.description ?? ''),
        // all credited people, as small teams credit composers and artists too; falls back to the company credit
        developer: named(item.people) || named(item.company),
        publisher: named(byRole(credits, 'publisher')),
        released: first(item.year),
        genre: named(item.genre),
        players: first(item.players),
        region: named(item.region, ' / '),
        status: first(item.status),
        kind: item.type ?? '', // the window translates the label
        // a zero would draw a badge saying it scored none
        score: typeof item.score === 'number' ? item.score : undefined,
        planetVbUrl: item.url,
        romTitle: rom?.title?.trim() || undefined,
        md5: rom?.hash?.md5,
        crc32: rom?.hash?.crc32,
        version: rom?.version,
        latest: rom?.latest ?? false,
    };
}

// large, as the coverflow draws a cover at about a third of the window's height where medium looks soft. Boxes without
// any face picture are left out
export function coversOf(covers: ApiCover[] | undefined): PlanetVbCover[] {
    return (Array.isArray(covers) ? covers : []).flatMap(cover => {
        const faces: PlanetVbCover['faces'] = {};
        for (const face of PLANET_VB_FACES) {
            const url = pictureOf(cover?.faces?.[face]);
            if (url) {
                faces[face] = url;
            }
        }
        return Object.keys(faces).length > 0
            ? [{ name: (cover.name ?? '').trim(), faces }]
            : [];
    });
}

// large, as they are drawn wide across a page
export function backgroundsOf(backgrounds: ApiBackground[] | undefined): PlanetVbBackground[] {
    return (Array.isArray(backgrounds) ? backgrounds : []).flatMap(background => {
        const url = pictureOf(background);
        return url ? [{ name: (background.name ?? '').trim(), url }] : [];
    });
}

function pictureOf(image: ApiImage | undefined): string | undefined {
    return image?.large || image?.medium || undefined;
}

function byRole(list: ApiNamed[], role: string): ApiNamed[] {
    return list.filter(entry => (entry.role ?? '').toLowerCase() === role);
}

function named(list: ApiNamed[] | undefined, separator = ', '): string {
    return (list ?? []).map(entry => entry.name).filter(Boolean).join(separator);
}

function first(list: ApiNamed[] | undefined): string {
    return list?.[0]?.name ?? '';
}

function flattenHtml(html: string): string {
    if (!html) {
        return '';
    }
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return (doc.body.textContent ?? '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    } catch {
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
}
