/**
 * Planet VB's homebrew catalog: the bare endpoint returns all of it, `?featured` the handful Planet VB puts forward
 * (see homebrewApi for the base, homebrewCatalog for the two lists). Entries name a downloads group but not the file:
 * a second request per game, `<api base>/<group>/`, gives the ROM URL plus developer, genre, players and year. It is
 * made only when a game is wanted, through withHomebrewDetail, which every caller goes through before opening one. The
 * ROM download itself is always direct, as it sends `Access-Control-Allow-Origin: *` and isn't what the relay is for.
 */
import { homebrewApi } from './web-pvb-api';
import { ApiBackground, ApiCover, backgroundsOf, coversOf } from './web-planet-vb';
import { apiUrl, onDidChangeHomebrewApiBase } from './web-api-bases';

export const PLANET_VB_URL = 'https://www.virtual-boy.com';
export const VUEPORT_URL = 'https://www.vueport.net';
export const VUENGINE_URL = 'https://www.vuengine.dev';
export const HOMEBREW_INDEX_URL = `${PLANET_VB_URL}/homebrew/`;

// one per version, variant or language; all are kept and the choice is offered where a game is opened
export interface HomebrewRom {
    id: string; // Planet VB downloads-group number, which the detail request takes
    title: string;
    date?: string;
    latest: boolean;
}

export interface HomebrewGame {
    id: string;
    title: string;
    developer?: string;
    players?: string; // "1", "1–2", …
    year?: string;
    genre?: string;
    // raw catalog value ("homebrew", "tech-demo", …), the same field a cartridge carries so the shelf can filter both;
    // only known after the detail request
    kind?: string;
    score?: number; // out of 100, only from the detail request; most homebrew was never scored
    status?: string; // only from the detail request
    featured: boolean;
    blurb: string; // HTML flattened to text; may be empty
    // the group's page until withHomebrewDetail has resolved the actual file, so every open must go through it
    romUrl: string;
    coverUrl?: string; // undefined means a procedural cover is drawn
    backgroundUrl?: string; // for most homebrew this is Planet VB's default header, which the site shows too
    planetVbUrl?: string;
    // newest first; empty only when the listing named nothing resolvable to a downloads group, then `romUrl` is all
    // there is
    roms: HomebrewRom[];
}

interface ApiFeaturedRom {
    title?: string;
    url?: string;
    date?: string;
    latest?: boolean;
}

interface ApiFeaturedEntry {
    id: number;
    title?: string;
    description?: string;
    url?: string;
    roms?: ApiFeaturedRom[];
    covers?: ApiCover[];
    backgrounds?: ApiBackground[];
}

interface ApiNamed {
    id: number;
    name: string;
    role?: string;
}

interface ApiDetail {
    id: number;
    download?: string;
    item?: {
        type?: string;
        people?: ApiNamed[];
        company?: ApiNamed[];
        players?: ApiNamed[];
        year?: ApiNamed[];
        genre?: ApiNamed[];
        status?: ApiNamed[];
        score?: number;
        backgrounds?: ApiBackground[];
    }[];
}

const FEATURED_QUERY = 'featured'; // the whole catalog is the same endpoint without it

// cached per query for the life of the page; a failed fetch is dropped so the next call (shuffle, retry) tries again
const listCache = new Map<string, Promise<ApiFeaturedEntry[]>>();

function loadList(query: string): Promise<ApiFeaturedEntry[]> {
    let pending = listCache.get(query);
    if (!pending) {
        pending = fetchJson<ApiFeaturedEntry[]>(apiUrl(homebrewApi(), '', query))
            .then(body => (Array.isArray(body) ? body : []))
            .catch(error => {
                listCache.delete(query);
                throw error;
            });
        listCache.set(query, pending);
    }
    return pending;
}

// a group that cannot be fetched resolves undefined rather than rejecting, so the game is still shown from the list
const detailCache = new Map<string, Promise<ApiDetail | undefined>>();

function loadDetail(groupId: string): Promise<ApiDetail | undefined> {
    let pending = detailCache.get(groupId);
    if (!pending) {
        pending = fetchJson<ApiDetail>(apiUrl(homebrewApi(), `${encodeURIComponent(groupId)}/`))
            .catch(() => undefined);
        detailCache.set(groupId, pending);
    }
    return pending;
}

// both caches are keyed by query, not by base URL, so they must be dropped when the setting changes. A request in
// flight then resolves into a map nothing reads
onDidChangeHomebrewApiBase(() => {
    listCache.clear();
    detailCache.clear();
});

async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
        throw new Error(`Planet VB answered ${response.status}.`);
    }
    return await response.json() as T;
}

function groupIdIn(url: string | undefined): string | undefined {
    return url?.match(/\/downloads\/(\d+)\/?$/)?.[1];
}

function groupIdOf(entry: ApiFeaturedEntry): string | undefined {
    const rom = entry.roms?.find(candidate => candidate.latest) ?? entry.roms?.[0];
    return groupIdIn(rom?.url);
}

// current release first; links that are not a downloads group are dropped, as there is no detail request to open them
function romsOf(entry: ApiFeaturedEntry): HomebrewRom[] {
    const roms = (entry.roms ?? []).flatMap(candidate => {
        const id = groupIdIn(candidate.url);
        return id
            ? [{
                id,
                title: (candidate.title ?? '').trim() || (entry.title ?? '').trim() || 'ROM',
                date: candidate.date,
                latest: candidate.latest === true,
            }]
            : [];
    });
    // stable, so the catalog's newest-first order holds otherwise
    return [...roms].sort((a, b) => Number(b.latest) - Number(a.latest));
}

function toGame(entry: ApiFeaturedEntry, groupId: string, featured: boolean): HomebrewGame {
    const groupRom = entry.roms?.find(candidate => candidate.latest) ?? entry.roms?.[0];
    return {
        id: groupId,
        title: (entry.title ?? '').trim() || 'Untitled',
        year: (groupRom?.date?.slice(0, 4) ?? '') || undefined,
        blurb: flattenHtml(entry.description ?? ''),
        romUrl: groupRom?.url ?? entry.url ?? HOMEBREW_INDEX_URL, // the group's page until the detail names the file
        coverUrl: coversOf(entry.covers)[0]?.faces.front, // a homebrew gets one card here, not a choice of boxes
        backgroundUrl: backgroundOf(entry.backgrounds),
        planetVbUrl: entry.url,
        featured,
        roms: romsOf(entry),
    };
}

// resolves `romUrl` to a real file, so every open goes through it. Cached per session; a group answering nothing
// returns the game unchanged
export async function withHomebrewDetail(game: HomebrewGame): Promise<HomebrewGame> {
    const detail = await loadDetail(game.id);
    const item = detail?.item?.[0];
    if (!detail) {
        return game;
    }
    // all credited people, as small teams credit composers and artists too; falls back to the company credit
    const developer = named(item?.people) || named(item?.company);
    return {
        ...game,
        developer: developer || game.developer,
        players: shortPlayers(item?.players) ?? game.players,
        year: item?.year?.[0]?.name ?? game.year,
        genre: named(item?.genre) || game.genre,
        kind: item?.type ?? game.kind,
        status: item?.status?.[0]?.name ?? game.status,
        // a zero would show as a badge saying the catalog scored it none
        score: typeof item?.score === 'number' ? item.score : game.score,
        backgroundUrl: backgroundOf(item?.backgrounds) ?? game.backgroundUrl,
        romUrl: detail.download ?? game.romUrl,
    };
}

// lets the user open a version other than the newest; undefined when the group names no file
export async function homebrewRomUrl(rom: HomebrewRom): Promise<string | undefined> {
    return (await loadDetail(rom.id))?.download;
}

// picked at the same size as a cartridge's, see backgroundsOf
function backgroundOf(backgrounds?: ApiBackground[]): string | undefined {
    return backgroundsOf(backgrounds)[0]?.url;
}

function named(list?: ApiNamed[]): string {
    return (list ?? []).map(entry => entry.name).filter(Boolean).join(', ');
}

// "1 Player" → "1"; "1-2 Players (Simultaneously)" → "1–2"
function shortPlayers(list?: ApiNamed[]): string | undefined {
    const counts = (list ?? []).flatMap(entry => (entry.name.match(/\d+/g) ?? []).map(Number));
    if (counts.length === 0) {
        return undefined;
    }
    const low = Math.min(...counts);
    const high = Math.max(...counts);
    return low === high ? String(low) : `${low}–${high}`;
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

// about a fifth of the full listing has no downloads group or title
function openable(
    list: readonly ApiFeaturedEntry[],
    isFeatured: (entry: ApiFeaturedEntry) => boolean,
): HomebrewGame[] {
    return list
        .map(entry => ({ entry, groupId: groupIdOf(entry) }))
        .filter((pair): pair is { entry: ApiFeaturedEntry; groupId: string } =>
            Boolean(pair.groupId) && Boolean(pair.entry.title))
        .map(({ entry, groupId }) => toGame(entry, groupId, isFeatured(entry)));
}

/**
 * The whole catalog in title order. Two requests, everything and the featured selection (the only way to know which
 * games are picks), both cached for the session; a failing featured list only leaves every game unmarked. Details are
 * not fetched here, as several hundred requests would come before the shelf showed anything; the shelf asks for what
 * it shows. Sorted with localeCompare, so "Ölfass" files where a reader of the running language expects it.
 */
export async function homebrewCatalog(): Promise<HomebrewGame[]> {
    const [all, featured] = await Promise.all([
        loadList(''),
        loadList(FEATURED_QUERY).catch(() => [] as ApiFeaturedEntry[]),
    ]);
    const picks = new Set(featured.map(entry => entry.id));
    return openable(all, entry => picks.has(entry.id))
        .sort((a, b) => a.title.localeCompare(b.title));
}
