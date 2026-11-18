/**
 * The library: what was found in the folders the user pointed VUEPort at, read through Library.games. It keeps only
 * where each ROM is, its checksum, Planet VB's answer and what the user typed over it, never the ROM itself; in a
 * browser files are reached through the granted folder handle.
 *
 *   library/index.json       folders, entries, and games that are more than a checksum's answer (readable JSON)
 *   library/overrides.json   what the user typed over the catalog, keyed by game so it survives re-reads and moves
 *   library/play.json        starts and running time per dump, for every ROM that runs, written by the emulator
 *                            (web-play-time.ts)
 *   library/favorites.json   starred game keys, apart from the overrides so restoring the catalog doesn't unstar
 *   library/roms.json        per dump: own title, region, whether it is current, which game it was filed under
 *   library/preferred.json   which dump of each game Play starts, one checksum per game key
 *   library/covers/          covers and backdrops the user assigned, as the files they were
 *   library/art/             the catalog's box shots and backdrops, fetched once, listed in library/art.json
 *                            (web-library-art.ts)
 *
 * The folder handles themselves live in IndexedDB, the only place a browser keeps one (web-library-handles.ts).
 * Reading folders and asking the catalog are separate passes, so the library shows after the disk work and fills in
 * as the catalog, somebody else's server, answers.
 */
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { VueportStorage } from 'vueport-core/lib/common/emulator-host';
import { COMPANION_STORE_ROOT } from 'vueport-core/lib/browser/emulator-companion-files';
import { crc32, formatRomId } from 'vueport-core/lib/common/emulator-cheat-database';
import {
    PlanetVbTitleMatch,
    PlanetVbUnavailableError,
    forgetLookups,
    lookupRom,
    lookupTitle,
} from './web-planet-vb';
import {
    LibraryCatalog,
    LibraryPicture,
    LibraryEntry,
    LibraryFile,
    LibraryFolder,
    LibraryGameRecord,
    LibraryOverride,
    LibraryRomOverride,
    LibraryScanProgress,
    OWN_GAME_PREFIX,
    BoxFace,
    CatalogPreset,
    DEFAULT_PRESET,
    LibraryPictureSet,
    PictureKey,
    PictureKind,
    catalogOf,
    catalogPresetId,
    isCatalogPreset,
} from './web-library-types';
import { ART_DIR, LibraryArt } from './web-library-art';
import { ImportError, appendImport, importDirOf, readImportIndex, removeFromImport } from './web-library-import';
import { ImportedLibrarySource } from './web-library-imported-source';
import { PlayStats, PlayTimes } from './web-play-time';
import { ScannedRom, scanFiles } from './web-library-scan';
import { LibraryAccess, LibrarySource } from './web-library-source';
import { lookUpDetails, scanArchives, scanSubfolders } from './web-library-settings';
import { ROM_EXTENSIONS, RomSound, VB_ARCHIVE_EXTENSIONS, soundsInZip } from './web-rom-source';
import { listZipEntries, readZipEntry } from './web-zip';
import { romStem } from './web-recent-roms';
import { ensureDurableStorage } from './web-durable-storage';
import { LibrarySaves } from './web-library-saves';
import { CUSTOM_DIR as EMPTY_BOX_DIR, loadCustomEmptyBox } from './web-empty-box';

const INDEX_PATH = 'library/index.json';
const OVERRIDES_PATH = 'library/overrides.json';
const FAVORITES_PATH = 'library/favorites.json';
const ROMS_PATH = 'library/roms.json';
const PREFERRED_PATH = 'library/preferred.json';
const COVERS_DIR = 'library/covers';

// box faces a coverflow shows besides the front; top and bottom are only seen in the editor, which reads them itself
const SHELF_FACES: ReadonlyArray<BoxFace> = ['back', 'left', 'right'];

export interface PictureDraftSet {
    id: string;
    name: string;
    base?: string;
    pictures: Partial<Record<PictureKey, LibraryPicture | File | null>>;
}

export interface PictureDraft {
    shown: string;
    sets: PictureDraftSet[];
}
const LIBRARY_DIR = 'library';

const INDEX_VERSION = 1;

interface StoredIndex {
    version: number;
    folders: LibraryFolder[];
    entries: LibraryEntry[];
    // games made here, and catalog snapshots of games that dumps were filed under
    games: LibraryGameRecord[];
    removed: string[];
}

// parallel catalog lookups; four is what the Homebrew Explorer uses against the same server
const LOOKUP_CONCURRENCY = 4;

export interface LibraryActivity {
    // `catalog` is the lookup pass that follows a read or an import, and often takes longer
    kind: 'reading' | 'importing' | 'catalog';
    folder?: string;
    // files walked, or checksums looked up
    done: number;
    total?: number;
}

// for the settings overview; byChecksum, byName, unknown and notAsked add up to roms
export interface LibraryStats {
    games: number;
    roms: number;
    // more than roms when a dump is in two folders
    files: number;
    folders: number;
    byChecksum: number;
    byName: number;
    unknown: number;
    notAsked: number;
    favorites: number;
    editedGames: number;
    editedRoms: number;
    playMs: number;
    played: number;
    sessions: number;
    mostPlayed?: { title: string, ms: number };
}

export interface LibraryStoragePart {
    bytes: number;
    files: number;
}

// measured from the storage rather than the index, so half-failed pictures and orphaned copies count too
export interface LibraryStorageUse {
    imported: LibraryStoragePart;
    art: LibraryStoragePart;
    covers: LibraryStoragePart;
    index: LibraryStoragePart;
    // per-ROM saves, states and cheats in the companion store; on the desktop only what wasn't stored beside the ROM
    companions: LibraryStoragePart;
}

export interface LibraryClearOptions {
    // title and field edits, assigned covers, filings, preferred dumps and games made here
    edits: boolean;
    favorites: boolean;
    // play time of every ROM, including ROMs outside the library
    playTime: boolean;
    // the whole companion store: saves, states and cheats of every ROM, in the library or not
    companions: boolean;
}

export interface LibraryFolderState extends LibraryFolder {
    access: LibraryAccess;
    reading: boolean;
}

// a catalog entry with all dumps of it, e.g. a US and a Japanese cartridge, or a homebrew's demo, v1.0 and v1.1;
// Play starts `preferred`. A ROM the catalog doesn't know is a game of its own, keyed by its checksum
export interface LibraryGame {
    // `pvb:<catalog id>` for a catalog entry, `own:<something>` for a game made here, the checksum for a lone dump
    id: string;
    title: string;
    developer?: string;
    publisher?: string;
    released?: string;
    genre?: string;
    players?: string;
    region?: string;
    kind?: string;
    // the catalog's untranslated release status ("Released", "Canceled", ...), not editable; the shelf uses it to flag
    // games that never came out
    status?: string;
    // Planet VB's rating out of 100, not editable
    score?: number;
    description?: string;
    notes?: string;
    catalogCoverUrl?: string;
    ownCoverUrl?: string;
    // the other faces of the shown box (SHELF_FACES), the user's own or the catalog preset's; missing faces use the
    // empty box
    boxUrls: Partial<Record<BoxFace, string>>;
    catalogBackgroundUrl?: string;
    // object URL of the assigned backdrop, only while the game's page is open (Library.loadOwnBackdrop)
    ownBackgroundUrl?: string;
    planetVbUrl?: string;
    // no catalog entry and not filed by the user; filing it takes it off the Unmatched shelf
    unmatched: boolean;
    own: boolean;
    // similarity of the file name when the entry was found by name instead of checksum, so the page can flag it as a
    // guess
    titleMatch?: number;
    favorite: boolean;
    // a dump has save RAM in the companion store; false until checked, and for saves stored beside the ROM
    hasSave: boolean;
    // summed over every dump; undefined if never started
    play?: PlayStats;
    edited: ReadonlyArray<keyof LibraryOverride>;
    ownBackground: boolean;
    // the catalog's sets of each kind, or a single empty DEFAULT_PRESET when it has none
    presets: Record<PictureKind, CatalogPreset[]>;
    shownSets: Record<PictureKind, string>;
    customPictures: boolean;
    // every dump found, the current version first
    roms: LibraryRom[];
    // the dump Play starts, stored per game (set from the catalog's current version on arrival, changeable on the
    // game's page); undefined for a game made here without dumps
    preferred?: LibraryRom;
    // the suspended file Resume continues from, the preferred dump's first; undefined if nothing is suspended or saves
    // weren't read yet
    resumable?: { rom: LibraryRom, file: LibraryFile };
}

export interface LibraryRom {
    entry: LibraryEntry;
    // the dump's own title; undefined means its file name is shown
    title?: string;
    region?: string;
    latest: boolean;
    // exactly one dump per game is preferred; see LibraryGame.preferred
    preferred: boolean;
    filed: boolean;
    play?: PlayStats;
    suspended: LibraryFile[];
    edited: ReadonlyArray<keyof LibraryRomOverride>;
}

export const EDITABLE_FIELDS: ReadonlyArray<keyof LibraryOverride> =
    ['title', 'developer', 'publisher', 'released', 'genre', 'players', 'region', 'kind', 'notes'];

// LibraryRomOverride.gameId is set by filing, so it's not listed
export const EDITABLE_ROM_FIELDS: ReadonlyArray<keyof LibraryRomOverride> = ['title', 'region', 'latest'];

export const DOWNLOADS_FOLDER_ID = 'planetvb';

export interface LibraryRelease {
    // id of the downloads group, which later marks it as imported
    id: string;
    title: string;
    // the caller fetches and unpacks; the library only stores the files
    fetch(signal: AbortSignal): Promise<{ name: string, data: Uint8Array }[]>;
}

export interface LibraryReleaseResult {
    added: number;
    skipped: number;
    failed: string[];
    stopped: boolean;
    // whether browser storage ran out, the one failure worth reporting on its own
    outOfSpace: boolean;
}

export class Library {

    protected readonly onDidChangeEmitter = new Emitter<void>();
    protected readonly onDidChangeActivityEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
    // separate from onDidChange, so status bar updates don't redraw a shelf of hundreds of covers on every catalog
    // answer
    readonly onDidChangeActivity: Event<void> = this.onDidChangeActivityEmitter.event;

    // progress summed over overlapping catalog passes (after a read, from the Unmatched shelf); reset when the last
    // finishes
    protected lookups = { done: 0, total: 0 };
    protected lookupPasses = 0;

    protected folders: LibraryFolder[] = [];
    protected entries = new Map<string, LibraryEntry>();
    protected overrides = new Map<string, LibraryOverride>();
    // by game key
    protected favorites = new Set<string>();
    // per-dump edits and filings, by checksum
    protected romOverrides = new Map<string, LibraryRomOverride>();
    // the dump Play starts, game key to CRC32, stored rather than derived (see adoptPreferred); a missing pick, or one
    // in an unplugged folder, falls back to the catalog's current version
    protected picks = new Map<string, string>();
    // games made here and filing snapshots, by game key
    protected records = new Map<string, LibraryGameRecord>();

    protected access = new Map<string, LibraryAccess>();
    protected reading = new Set<string>();
    protected progress: LibraryScanProgress | undefined;
    protected aborts = new Map<string, AbortController>();

    // object URLs of the user's own box pictures by stored file (fronts and SHELF_FACES), kept for the session
    protected pictureUrls = new Map<string, string>();
    protected readonly art: LibraryArt;
    protected readonly saves: LibrarySaves;
    // the running art fetch, so a second caller joins it instead of starting another
    protected caching: Promise<void> | undefined;
    protected backdrop: string | undefined;
    protected ownBackdrop: { id: string, file: string, url: string } | undefined;
    // game whose own backdrop was requested last, so a late read can be discarded
    protected ownBackdropWanted: string | undefined;

    protected loaded = false;
    protected writing: Promise<void> = Promise.resolve();

    // where copies live: imported folders in a browser, and the Planet VB downloads on both hosts
    protected readonly copies: LibrarySource;
    protected releases = new Set<string>();
    // checksums the user removed, which no read brings back; see removeGame
    protected removed = new Set<string>();
    protected queuedReleases = new Set<string>();
    protected importing: Promise<unknown> = Promise.resolve();

    /**
     * Resolves once load has finished or failed. Recently Played keeps a ROM's bytes only when the library can't read
     * them, so it awaits this to tell "not in a folder" from "index not read yet" (web-recent-origins.ts). Made in the
     * constructor rather than in load, so something running first can await it.
     */
    readonly ready: Promise<void>;
    protected markReady = (): void => undefined;

    constructor(
        protected readonly storage: VueportStorage,
        // linked folders, the one thing browser and desktop differ on
        protected readonly source: LibrarySource,
        // written by the emulator, the library only shows it
        protected readonly playTimes: PlayTimes,
        // imported (copied) folders in a browser; absent on the desktop, which has real paths
        protected readonly imported?: LibrarySource,
    ) {
        this.art = new LibraryArt(storage);
        this.saves = new LibrarySaves(storage);
        this.copies = imported ?? new ImportedLibrarySource(storage);
        this.ready = new Promise<void>(resolve => { this.markReady = resolve; });
    }

    // a folder's kind never changes after adding; both hosts can read copies, on the desktop only the Planet VB
    // downloads
    protected sourceOf(folder: LibraryFolder): LibrarySource {
        return folder.kind === 'imported' ? this.copies : this.source;
    }

    // false in browsers without a directory picker
    canAddFolders(): boolean {
        return this.source.canAdd();
    }

    // true in every browser, false on the desktop
    canImportFolders(): boolean {
        return this.imported?.canAdd() ?? false;
    }

    // reads the stored state without touching any folder, so the library shows without prompting; a second call is a
    // no-op. Afterwards only the catalog picture fetch goes out, and only with lookups enabled (see cacheArt)
    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        // not awaited: the shelf draws the standard empty box until the user's own is read
        loadCustomEmptyBox(this.storage).catch(() => undefined);
        try {
            await this.readIndexes();
        } finally {
            this.markReady();
        }
    }

    // separate from load so `ready` resolves even when this throws
    protected async readIndexes(): Promise<void> {
        const index = await this.readJson<StoredIndex>(INDEX_PATH);
        if (index && index.version === INDEX_VERSION) {
            this.folders = Array.isArray(index.folders) ? index.folders : [];
            this.entries = new Map((Array.isArray(index.entries) ? index.entries : [])
                .filter(entry => typeof entry?.id === 'string')
                .map(entry => [entry.id, entry]));
            this.records = new Map((Array.isArray(index.games) ? index.games : [])
                .filter(game => typeof game?.id === 'string')
                .map(game => [game.id, game]));
            this.removed = new Set((Array.isArray(index.removed) ? index.removed : [])
                .filter(id => typeof id === 'string'));
        }
        const overrides = await this.readJson<Record<string, LibraryOverride>>(OVERRIDES_PATH);
        if (overrides && typeof overrides === 'object') {
            this.overrides = new Map(Object.entries(overrides));
        }
        const favorites = await this.readJson<string[]>(FAVORITES_PATH);
        if (Array.isArray(favorites)) {
            this.favorites = new Set(favorites.filter(id => typeof id === 'string'));
        }
        const roms = await this.readJson<Record<string, LibraryRomOverride>>(ROMS_PATH);
        if (roms && typeof roms === 'object') {
            this.romOverrides = new Map(Object.entries(roms));
        }
        const picks = await this.readJson<Record<string, string>>(PREFERRED_PATH);
        if (picks && typeof picks === 'object') {
            this.picks = new Map(Object.entries(picks).filter(([, id]) => typeof id === 'string'));
        }
        // play times are written by the emulator; following the store keeps the shelf up to date with play since
        await this.playTimes.load();
        this.playTimes.onDidChange(() => this.changed());
        await Promise.all(this.folders.map(folder => this.refreshAccess(folder.id)));
        await this.readReleases();
        // open stored covers before the first paint, or the shelf would ask the catalog server for every picture again
        await this.art.open(this.shownCoverUrls());
        this.changed();
        // prune unreferenced pictures and fetch what an offline session missed; not awaited, so the catalog server
        // can't hold up the library
        this.pruneArt();
        this.cacheArt().catch(() => undefined);
        // not awaited either, the shelf is worth drawing first
        this.readSaves().catch(() => undefined);
        // store the preferred dump for games a previous session held back while waiting on the catalog; see
        // adoptPreferred
        this.adoptPreferred().catch(() => undefined);
    }

    // called at load and whenever the shelf opens (`again`), as a game may have written its first save since
    async readSaves(again = false): Promise<void> {
        const names: string[] = [];
        for (const entry of this.entries.values()) {
            for (const file of entry.files) {
                names.push(playedAs(file));
            }
        }
        if (await this.saves.read(names, again)) {
            this.changed();
        }
    }

    // asks the host what it allows with a folder, without prompting
    protected async refreshAccess(folderId: string): Promise<void> {
        const folder = this.folders.find(entry => entry.id === folderId);
        this.access.set(folderId, folder ? await this.sourceOf(folder).access(folder) : 'missing');
    }

    folderStates(): LibraryFolderState[] {
        return this.folders.map(folder => ({
            ...folder,
            access: this.access.get(folder.id) ?? 'missing',
            reading: this.reading.has(folder.id),
        }));
    }

    readProgress(): LibraryScanProgress | undefined {
        return this.progress;
    }

    get isReading(): boolean {
        return this.reading.size > 0;
    }

    // a running read or copy comes first, as the job the user just started; the catalog pass outlasts it
    activity(): LibraryActivity | undefined {
        const progress = this.progress;
        if (progress) {
            return {
                kind: progress.copying ? 'importing' : 'reading',
                folder: this.folders.find(folder => folder.id === progress.folderId)?.name,
                done: progress.files,
                total: progress.known,
            };
        }
        if (this.lookupPasses > 0) {
            return { kind: 'catalog', done: this.lookups.done, total: this.lookups.total };
        }
        return undefined;
    }

    // with edits applied, sorted by title; dumps are grouped by their checksum's answer first, then hand-filed ones
    // move, except those filed under a key that no longer exists
    games(): LibraryGame[] {
        const natural = [...this.entries.values()]
            .map(entry => [entry, gameKey(entry)] as const);
        const known = new Set<string>([
            ...natural.map(([, key]) => key),
            ...this.records.keys(),
        ]);

        const grouped = new Map<string, LibraryEntry[]>();
        const put = (key: string, entry: LibraryEntry): void => {
            const held = grouped.get(key);
            if (held) {
                held.push(entry);
            } else {
                grouped.set(key, [entry]);
            }
        };
        for (const [entry, key] of natural) {
            const filed = this.romOverrides.get(entry.id)?.gameId;
            put(filed && known.has(filed) ? filed : key, entry);
        }
        // a game made here exists even before anything is filed under it
        for (const record of this.records.values()) {
            if (record.id.startsWith(OWN_GAME_PREFIX) && !grouped.has(record.id)) {
                grouped.set(record.id, []);
            }
        }
        return [...grouped]
            .map(([key, entries]) => this.resolve(key, entries))
            .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    }

    game(id: string): LibraryGame | undefined {
        return this.games().find(game => game.id === id);
    }

    // looked up fresh, as filing or a catalog answer can move a dump while a window about it is open
    gameOfRom(romId: string): LibraryGame | undefined {
        return this.games().find(game => game.roms.some(rom => rom.entry.id === romId));
    }

    get size(): number {
        return this.games().length;
    }

    get romCount(): number {
        return this.entries.size;
    }

    unmatched(): LibraryGame[] {
        return this.games().filter(game => game.unmatched);
    }

    stats(): LibraryStats {
        const games = this.games();
        const entries = [...this.entries.values()];
        let playMs = 0;
        let played = 0;
        let sessions = 0;
        let mostPlayed: LibraryStats['mostPlayed'];
        for (const game of games) {
            if (!game.play) {
                continue;
            }
            playMs += game.play.ms;
            played++;
            sessions += game.play.count;
            if (game.play.ms > 0 && (!mostPlayed || game.play.ms > mostPlayed.ms)) {
                mostPlayed = { title: game.title, ms: game.play.ms };
            }
        }
        return {
            games: games.length,
            roms: entries.length,
            files: entries.reduce((sum, entry) => sum + entry.files.length, 0),
            folders: this.folders.length,
            byChecksum: entries.filter(entry => entry.catalog && entry.catalog.titleMatch === undefined).length,
            byName: entries.filter(entry => entry.catalog?.titleMatch !== undefined).length,
            unknown: entries.filter(entry => !entry.catalog && entry.unmatched).length,
            notAsked: entries.filter(entry => !entry.catalog && !entry.unmatched).length,
            favorites: games.filter(game => game.favorite).length,
            editedGames: games.filter(game => this.overrides.has(game.id)).length,
            editedRoms: entries.filter(entry => this.romOverrides.has(entry.id)).length,
            playMs,
            played,
            sessions,
            mostPlayed,
        };
    }

    async storageUse(): Promise<LibraryStorageUse> {
        const measure = async (directories: string[]): Promise<LibraryStoragePart> => {
            const part = { bytes: 0, files: 0 };
            for (const directory of directories) {
                for (const file of await this.storage.list(directory).catch(() => [])) {
                    part.bytes += file.size;
                    part.files++;
                }
            }
            return part;
        };
        const imported = this.folders
            .filter(folder => folder.kind === 'imported')
            .map(folder => importDirOf(folder.id));
        const [copies, art, covers, index, companions] = await Promise.all([
            measure(imported),
            measure([ART_DIR]),
            // the user's own empty box counts as an assigned picture, like a cover
            measure([COVERS_DIR, EMPTY_BOX_DIR]),
            // only the files directly in library/; its subdirectories are counted above
            measure([LIBRARY_DIR]),
            // recursive (a folder per ROM); a host that can't measure recursively reports nothing rather than just the
            // top files
            this.storage.measure
                ? this.storage.measure(COMPANION_STORE_ROOT).catch(() => ({ bytes: 0, files: 0 }))
                : { bytes: 0, files: 0 },
        ]);
        return { imported: copies, art, covers, index, companions };
    }

    // retries every unmatched dump at once, for the Unmatched shelf; the catalog grows and may know them now
    async lookUpUnknown(): Promise<void> {
        await this.lookUpAgain([...this.entries.values()]
            .filter(entry => !entry.catalog && entry.unmatched)
            .map(entry => entry.id));
    }

    // the shelf falls back to the catalog's URLs meanwhile, and the next start fetches them again unless lookups are
    // off
    async clearArt(): Promise<void> {
        await this.art.prune([]);
        this.changed();
    }

    protected resolve(key: string, entries: LibraryEntry[]): LibraryGame {
        const record = this.records.get(key);
        const found = entries.map(entry => this.resolveRom(key, entry));
        // the chosen dump if it's on the shelf, else the catalog's current one (no choice stored yet, or the chosen
        // dump is in an unplugged folder)
        const picked = this.picks.get(key);
        const current = currentOf(found);
        const preferred = found.find(rom => rom.entry.id === picked) ?? current;
        if (preferred) {
            preferred.preferred = true;
        }
        // current version first, not the preferred one: reordering would move the row the user was about to click
        const roms = [...found].sort((a, b) => Number(b.latest) - Number(a.latest));
        const override = this.overrides.get(key);
        // the catalog data comes from the current dump, else any dump, else the game's record; never from the preferred
        // dump, as playing the Japanese cartridge doesn't make the game Japanese
        const catalog = current?.entry.catalog
            ?? found.find(rom => rom.entry.catalog)?.entry.catalog
            ?? record?.catalog;
        const edited = EDITABLE_FIELDS.filter(field => override?.[field] !== undefined);
        const presets = this.catalogPresets(catalog);
        const box = shownSetOf(override, 'cover', presets.cover);
        const backdrop = shownSetOf(override, 'background', presets.background);
        const ownBackdrop = backdrop.set?.pictures.background ?? undefined;
        const pick = (field: keyof LibraryOverride, fallback?: string): string | undefined => {
            const typed = override?.[field];
            return typeof typed === 'string' && typed.length > 0 ? typed : fallback;
        };
        return {
            id: key,
            // own title, then the catalog's, then romLabel (file name rather than the header's 20 uppercase characters)
            title: pick('title', catalog?.title || catalog?.romTitle
                || (current && romLabel(current))
                || undefined)
                ?? nls.localize('vueport/library/untitledGame', 'Untitled game'),
            developer: pick('developer', catalog?.developer),
            publisher: pick('publisher', catalog?.publisher),
            released: pick('released', catalog?.released),
            genre: pick('genre', catalog?.genre),
            players: pick('players', catalog?.players),
            region: pick('region', catalog?.region),
            kind: pick('kind', catalog?.kind),
            status: catalog?.status || undefined,
            score: catalog?.score,
            description: catalog?.description || undefined,
            notes: override?.notes,
            catalogCoverUrl: box.set?.pictures.front === null ? undefined : box.preset?.pictures.front,
            ownCoverUrl: this.pictureUrl(box.set?.pictures.front),
            boxUrls: Object.fromEntries(SHELF_FACES
                .map(face => {
                    const own = box.set?.pictures[face];
                    return [face, own === null ? undefined : this.pictureUrl(own) ?? box.preset?.pictures[face]];
                })
                .filter(([, url]) => url !== undefined)),
            catalogBackgroundUrl: backdrop.set?.pictures.background === null
                ? undefined
                : backdrop.preset?.pictures.background,
            ownBackgroundUrl: ownBackdrop && this.ownBackdrop?.file === ownBackdrop.file
                ? this.ownBackdrop.url
                : undefined,
            ownBackground: ownBackdrop !== undefined,
            presets,
            shownSets: { cover: box.id, background: backdrop.id },
            customPictures: Boolean(override?.coverSets?.length || override?.backgroundSets?.length),
            planetVbUrl: catalog?.planetVbUrl,
            // filed by hand or made here also counts as answered
            unmatched: !catalog && !record && !roms.some(rom => rom.filed),
            own: key.startsWith(OWN_GAME_PREFIX),
            titleMatch: catalog?.titleMatch,
            favorite: this.favorites.has(key),
            hasSave: roms.some(rom => rom.entry.files.some(file => this.saves.has(playedAs(file)))),
            play: this.playTimes.total(entries.map(entry => entry.id)),
            edited,
            roms,
            preferred,
            resumable: resumableOf(preferred, roms),
        };
    }

    protected resolveRom(key: string, entry: LibraryEntry): LibraryRom {
        const override = this.romOverrides.get(entry.id);
        const catalog = entry.catalog;
        return {
            entry,
            title: override?.title || catalog?.romTitle || undefined,
            region: override?.region || catalog?.region || undefined,
            latest: override?.latest ?? catalog?.latest ?? false,
            // set by resolve, as a single dump can't know it's the preferred one
            preferred: false,
            filed: override?.gameId === key,
            play: this.playTimes.of(entry.id),
            suspended: entry.files.filter(file => this.saves.suspended(playedAs(file))),
            edited: EDITABLE_ROM_FIELDS.filter(field => override?.[field] !== undefined),
        };
    }

    /**
     * Asks for a folder and adds it; undefined if cancelled. Must run from a click, as the directory picker and its
     * permission need a user gesture. The way back to the folder is stored before anything else: a half-failed read is
     * recoverable, but a folder whose way back was never kept vanishes on the next start. `kind` (linked or imported,
     * see LibraryFolder.kind) is written down now, as it can't be worked out later.
     */
    async addFolder(kind: 'linked' | 'imported' = 'linked'): Promise<LibraryFolder | undefined> {
        const source = kind === 'imported' ? this.imported : this.source;
        if (!source) {
            return undefined;
        }
        const picked = await source.pick();
        if (!picked) {
            return undefined;
        }
        const folder: LibraryFolder = {
            id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            name: picked.name || 'ROMs',
            kind,
            location: picked.location,
            addedAt: Date.now(),
        };
        // show the folder as busy before copying: hundreds of cartridges take half a minute, and a silent pane gets
        // clicked again
        this.folders = [...this.folders, folder];
        this.reading.add(folder.id);
        this.access.set(folder.id, 'granted');
        this.changed();
        try {
            await picked.adopt(folder.id, progress => {
                this.progress = {
                    folderId: folder.id,
                    files: progress.files,
                    known: progress.total,
                    roms: 0,
                    current: progress.current,
                    copying: true,
                };
                this.changed();
            });
        } catch (error) {
            // drop the partial copy; removeFolder deletes what was written, freeing the storage after a quota error
            this.reading.delete(folder.id);
            this.progress = undefined;
            await this.removeFolder(folder.id);
            throw error;
        }
        this.reading.delete(folder.id);
        this.progress = undefined;
        this.access.set(folder.id, await this.sourceOf(folder).access(folder));
        // the first data worth keeping in this origin; see web-durable-storage.ts for why durability is requested here
        ensureDurableStorage().catch(() => undefined);
        await this.save();
        this.changed();
        await this.readFolder(folder.id);
        return folder;
    }

    // copies an imported folder again over the old copy, as re-reading a copy can't see files added to its source;
    // keeps the folder id
    async reimportFolder(folderId: string): Promise<boolean> {
        const folder = this.folders.find(entry => entry.id === folderId);
        if (!folder || folder.kind !== 'imported' || !this.imported) {
            return false;
        }
        const picked = await this.imported.pick();
        if (!picked) {
            return false;
        }
        this.cancelRead(folderId);
        this.reading.add(folderId);
        this.changed();
        try {
            await picked.adopt(folderId, progress => {
                this.progress = {
                    folderId,
                    files: progress.files,
                    known: progress.total,
                    roms: 0,
                    current: progress.current,
                    copying: true,
                };
                this.changed();
            });
        } catch (error) {
            // the old copy is already gone (deleted before writing, as a full browser can't hold two), so empty the
            // folder rather than show games that won't start; edits and play times are keyed by checksum and survive
            this.absorb(folderId, []);
            this.reading.delete(folderId);
            this.progress = undefined;
            await this.refreshAccess(folderId);
            await this.save();
            this.changed();
            throw error;
        }
        this.reading.delete(folderId);
        this.progress = undefined;
        this.changed();
        // take the name of the newly chosen directory, which may have been renamed
        this.folders = this.folders.map(entry => entry.id === folderId
            ? { ...entry, name: picked.name || entry.name }
            : entry);
        await this.refreshAccess(folderId);
        await this.save();
        this.changed();
        await this.readFolder(folderId);
        return true;
    }

    // entries also in another folder stay; edits are kept on purpose, so re-adding the folder restores titles and
    // covers
    async removeFolder(folderId: string): Promise<void> {
        this.cancelRead(folderId);
        const dropped = this.folders.find(folder => folder.id === folderId);
        this.folders = this.folders.filter(folder => folder.id !== folderId);
        for (const [id, entry] of [...this.entries]) {
            const files = entry.files.filter(file => file.folderId !== folderId);
            if (files.length === 0) {
                this.entries.delete(id);
            } else if (files.length !== entry.files.length) {
                this.entries.set(id, { ...entry, files });
            }
        }
        this.access.delete(folderId);
        if (dropped) {
            await this.sourceOf(dropped).forget(dropped);
        }
        if (folderId === DOWNLOADS_FOLDER_ID) {
            this.releases.clear();
        }
        await this.save();
        this.changed();
        this.pruneArt();
    }

    // starts the library over: all folders, imported copies, entries and catalog pictures go, plus whatever `options`
    // names. Never touches ROM files, saves or save states, the library only knows where they are
    async clear(options: LibraryClearOptions): Promise<void> {
        this.cancelRead();
        const folders = this.folders;
        this.folders = [];
        this.entries.clear();
        this.removed.clear();
        this.access.clear();
        this.progress = undefined;
        for (const folder of folders) {
            await this.sourceOf(folder).forget(folder).catch(() => undefined);
        }
        this.releases.clear();
        if (options.edits) {
            this.overrides.clear();
            this.romOverrides.clear();
            this.picks.clear();
            // games made here and filing snapshots count as edits too
            this.records.clear();
            for (const url of this.pictureUrls.values()) {
                URL.revokeObjectURL(url);
            }
            this.pictureUrls.clear();
            this.releaseOwnBackdrop();
            for (const file of await this.storage.list(COVERS_DIR).catch(() => [])) {
                await this.storage.delete(file.path).catch(() => undefined);
            }
            await Promise.all([this.saveOverrides(), this.saveRoms(), this.savePreferred()]);
        }
        if (options.favorites) {
            this.favorites.clear();
            await this.saveFavorites();
        }
        if (options.playTime) {
            this.playTimes.clear();
        }
        if (options.companions) {
            await this.storage.delete(COMPANION_STORE_ROOT).catch(() => undefined);
            this.saves.forget();
        }
        await this.save();
        this.changed();
        // awaited here, unlike after removing a folder, as the user is looking at the storage use
        await this.art.prune([...this.catalogUrls('cover'), ...this.catalogUrls('background')]);
        this.changed();
    }

    // asks for a folder's permission again (needs a click) and reads the folder right away when granted
    async grantAccess(folderId: string): Promise<boolean> {
        const folder = this.folders.find(entry => entry.id === folderId);
        if (!folder) {
            return false;
        }
        const state = await this.sourceOf(folder).grant(folder);
        this.access.set(folderId, state);
        this.changed();
        if (state !== 'granted') {
            return false;
        }
        await this.readFolder(folderId);
        return true;
    }

    hasRelease(id: string): boolean {
        return this.releases.has(id);
    }

    isImportingRelease(id: string): boolean {
        return this.queuedReleases.has(id);
    }

    protected async readReleases(): Promise<void> {
        const index = this.folders.some(folder => folder.id === DOWNLOADS_FOLDER_ID)
            ? await readImportIndex(this.storage, DOWNLOADS_FOLDER_ID)
            : undefined;
        this.releases = new Set((index?.files ?? [])
            .map(file => file.release)
            .filter((id): id is string => typeof id === 'string'));
    }

    /**
     * Downloads Planet VB releases into one folder the library makes for them, an imported folder like any other
     * (removing it in the settings removes them), skipping those already there. One batch at a time: a second call
     * waits, its releases marked as waiting at once so their buttons say so. The folder is read once at the end of a
     * batch, as a read is a pass over all of it.
     */
    importReleases(releases: LibraryRelease[]): Promise<LibraryReleaseResult> {
        const wanted = releases.filter((release, at) => !this.releases.has(release.id)
            && !this.queuedReleases.has(release.id)
            && releases.findIndex(other => other.id === release.id) === at);
        const skipped = releases.length - wanted.length;
        for (const release of wanted) {
            this.queuedReleases.add(release.id);
        }
        this.changed();
        const run = this.importing.catch(() => undefined)
            .then(() => this.downloadReleases(wanted))
            .then(result => ({ ...result, skipped }));
        this.importing = run;
        return run;
    }

    protected async downloadReleases(
        releases: LibraryRelease[],
    ): Promise<Omit<LibraryReleaseResult, 'skipped'>> {
        const result = { added: 0, failed: [] as string[], stopped: false, outOfSpace: false };
        if (releases.length === 0) {
            return result;
        }
        const folderId = DOWNLOADS_FOLDER_ID;
        while (this.reading.has(folderId)) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!this.folders.some(folder => folder.id === folderId)) {
            this.folders = [...this.folders, {
                id: folderId,
                name: 'Planet VB',
                kind: 'imported',
                origin: 'planetvb',
                addedAt: Date.now(),
            }];
            await this.save();
        }
        const name = this.folders.find(folder => folder.id === folderId)?.name ?? 'Planet VB';

        const abort = new AbortController();
        this.aborts.set(folderId, abort);
        this.reading.add(folderId);
        const report = (done: number, current?: string): void => {
            this.progress = {
                folderId, files: done, known: releases.length, roms: 0, current, copying: true,
            };
            this.changed();
        };
        try {
            for (const [done, release] of releases.entries()) {
                if (abort.signal.aborted) {
                    result.stopped = true;
                    break;
                }
                report(done, release.title);
                try {
                    const files = await release.fetch(abort.signal);
                    // explicitly requested, so wanted back even if removed before
                    for (const file of files) {
                        this.removed.delete(formatRomId(crc32(file.data)));
                    }
                    await appendImport(this.storage, folderId, name,
                        files.map(file => ({ ...file, release: release.id })));
                    this.releases.add(release.id);
                    result.added += 1;
                } catch (error) {
                    if (abort.signal.aborted) {
                        result.stopped = true;
                        break;
                    }
                    result.failed.push(release.title);
                    if (error instanceof ImportError && error.outOfSpace) {
                        result.outOfSpace = true;
                        break;
                    }
                } finally {
                    this.queuedReleases.delete(release.id);
                }
            }
        } finally {
            for (const release of releases) {
                this.queuedReleases.delete(release.id);
            }
            this.reading.delete(folderId);
            this.aborts.delete(folderId);
            this.progress = undefined;
            this.changed();
        }
        if (result.added > 0) {
            // a copy of the user's ROMs is worth keeping, see addFolder
            ensureDurableStorage().catch(() => undefined);
            await this.refreshAccess(folderId);
            await this.readFolder(folderId);
        }
        return result;
    }

    async readFolder(folderId: string): Promise<void> {
        const folder = this.folders.find(entry => entry.id === folderId);
        if (!folder || this.reading.has(folderId)) {
            return;
        }
        const access = await this.sourceOf(folder).access(folder);
        this.access.set(folderId, access);
        if (access !== 'granted') {
            // asking needs a user gesture this call doesn't have; the sidebar shows the folder's grant button instead
            this.changed();
            return;
        }

        const abort = new AbortController();
        this.aborts.set(folderId, abort);
        this.reading.add(folderId);
        this.progress = { folderId, files: 0, roms: 0, known: folder.count };
        this.changed();

        let found: ScannedRom[];
        try {
            const subfolders = scanSubfolders();
            const archives = scanArchives();
            found = await scanFiles(
                this.sourceOf(folder).candidates(folder, {
                    subfolders,
                    // only these extensions reach the host. VB archives are always listed: the archive switch only
                    // decides whether plain .zip files are opened, and .vbz doesn't end in .zip
                    extensions: archives
                        ? [...ROM_EXTENSIONS, ...VB_ARCHIVE_EXTENSIONS, '.zip']
                        : [...ROM_EXTENSIONS, ...VB_ARCHIVE_EXTENSIONS],
                }),
                {
                    subfolders,
                    archives,
                    signal: abort.signal,
                    known: this.knownByPath(folderId),
                    onProgress: progress => {
                        this.progress = { folderId, known: folder.count, ...progress };
                        this.changed();
                    },
                });
        } catch {
            // cancelled, or the folder vanished mid-read: keep the last complete state, half a folder is worse
            this.reading.delete(folderId);
            this.aborts.delete(folderId);
            this.progress = undefined;
            this.changed();
            return;
        }

        this.absorb(folderId, found);
        this.folders = this.folders.map(entry => entry.id === folderId
            ? { ...entry, readAt: Date.now(), count: found.length }
            : entry);
        this.reading.delete(folderId);
        this.aborts.delete(folderId);
        this.progress = undefined;
        await this.save();
        this.changed();

        // a read can also remove games, leaving pictures nothing will ask for again
        this.pruneArt();

        // store the preferred dump for arrivals the catalog already answered; the lookup pass below handles the rest
        this.adoptPreferred().catch(() => undefined);

        if (lookUpDetails()) {
            // not awaited: the library is usable now and the catalog fills in behind it
            this.lookUpMissing().catch(() => undefined);
        }
    }

    async readAll(): Promise<void> {
        for (const folder of this.folders) {
            await this.readFolder(folder.id);
        }
    }

    cancelRead(folderId?: string): void {
        for (const [id, abort] of this.aborts) {
            if (!folderId || id === folderId) {
                abort.abort();
            }
        }
    }

    // what the last read of this folder found, by path, so unchanged files can be skipped
    protected knownByPath(folderId: string): Map<string, ScannedRom[]> {
        const known = new Map<string, ScannedRom[]>();
        for (const entry of this.entries.values()) {
            for (const file of entry.files) {
                if (file.folderId !== folderId) {
                    continue;
                }
                const rom: ScannedRom = {
                    id: entry.id,
                    header: entry.header,
                    bytes: entry.bytes,
                    file: { ...file },
                };
                const list = known.get(file.path);
                if (list) {
                    list.push(rom);
                } else {
                    known.set(file.path, [rom]);
                }
            }
        }
        return known;
    }

    // replaces this folder's files wholesale and leaves other folders' files alone, so a dump in two places stays one
    // entry
    protected absorb(folderId: string, found: ScannedRom[]): void {
        for (const [id, entry] of [...this.entries]) {
            const others = entry.files.filter(file => file.folderId !== folderId);
            if (others.length === entry.files.length) {
                continue;
            }
            if (others.length === 0 && !found.some(rom => rom.id === id)) {
                this.entries.delete(id);
            } else {
                this.entries.set(id, { ...entry, files: others });
            }
        }
        for (const rom of found) {
            if (this.removed.has(rom.id)) {
                continue;
            }
            const file: LibraryFile = { folderId, ...rom.file };
            const existing = this.entries.get(rom.id);
            if (existing) {
                this.entries.set(rom.id, { ...existing, files: [...existing.files, file] });
            } else {
                this.entries.set(rom.id, {
                    id: rom.id,
                    files: [file],
                    header: rom.header,
                    bytes: rom.bytes,
                    addedAt: Date.now(),
                    unmatched: false,
                });
            }
        }
    }

    // looks up every checksum not asked about yet, falling back to the file name (nameToAsk), as unknown dumps are
    // usually named after a known game. Entries asked once aren't asked again (lookUpAgain does that), and an
    // unreachable catalog stops the whole pass
    async lookUpMissing(): Promise<void> {
        const pending = [...this.entries.values()]
            .filter(entry => entry.lookedUpAt === undefined)
            .map(entry => entry.id);
        await this.lookUp(pending);
    }

    async lookUpAgain(ids: string[]): Promise<void> {
        await this.lookUp(ids, true);
    }

    protected async lookUp(ids: string[], force = false): Promise<void> {
        if (ids.length === 0) {
            return;
        }
        const queue = [...ids];
        let offline = false;
        let changed = false;
        this.lookupPasses++;
        this.lookups.total += queue.length;
        this.activityChanged();

        const worker = async (): Promise<void> => {
            while (queue.length > 0 && !offline) {
                const id = queue.shift();
                this.lookups.done++;
                this.activityChanged();
                const entry = id && this.entries.get(id);
                if (!id || !entry || (!force && entry.lookedUpAt !== undefined)) {
                    continue;
                }
                try {
                    let game = await lookupRom(id);
                    // similarity score when the answer came from a name lookup; undefined means a checksum match
                    let titleMatch: number | undefined;
                    if (!game) {
                        const match = await byName(entry);
                        game = match?.game;
                        titleMatch = match?.similarity;
                    }
                    const current = this.entries.get(id);
                    if (!current) {
                        continue;
                    }
                    this.entries.set(id, {
                        ...current,
                        catalog: game ? catalogOf(game, titleMatch) : undefined,
                        lookedUpAt: Date.now(),
                        unmatched: !game,
                    });
                    changed = true;
                } catch (error) {
                    if (error instanceof PlanetVbUnavailableError) {
                        offline = true;
                    }
                    // any other error only affects this checksum; nothing was written, so the next pass retries it
                }
            }
        };

        await Promise.all(Array.from(
            { length: Math.min(LOOKUP_CONCURRENCY, queue.length) },
            () => worker()));

        // the last pass to finish resets the counters; overlapping ones still count into them
        this.lookupPasses--;
        if (this.lookupPasses === 0) {
            this.lookups = { done: 0, total: 0 };
        }
        this.activityChanged();

        if (changed) {
            await this.save();
            this.changed();
            // new answers bring new URLs and may orphan old pictures
            this.pruneArt();
            this.cacheArt().catch(() => undefined);
        }
        // now that the catalog said which dumps are current, games waiting on that get their preferred dump
        await this.adoptPreferred();
    }

    isFavorite(id: string): boolean {
        return this.favorites.has(id);
    }

    // kept by game key like an edit, so it survives re-reads, renames, moves and the last dump leaving with an
    // unplugged folder
    async setFavorite(id: string, favorite: boolean): Promise<void> {
        if (this.favorites.has(id) === favorite) {
            return;
        }
        if (favorite) {
            this.favorites.add(id);
        } else {
            this.favorites.delete(id);
        }
        await this.saveFavorites();
        this.changed();
    }

    override(id: string): LibraryOverride | undefined {
        return this.overrides.get(id);
    }

    // an empty string means no opinion and is dropped, so revert and clear are the same; an empty override is deleted
    async edit(id: string, patch: Partial<Omit<LibraryOverride, 'updatedAt'>>): Promise<void> {
        const current = this.overrides.get(id);
        const next: LibraryOverride = { ...current, ...patch, updatedAt: Date.now() };
        for (const field of EDITABLE_FIELDS) {
            const value = next[field];
            if (typeof value !== 'string' || value.trim().length === 0) {
                delete next[field];
            } else {
                (next[field] as string) = value.trim();
            }
        }
        const empty = EDITABLE_FIELDS.every(field => next[field] === undefined)
            && !next.coverSets?.length && !next.backgroundSets?.length
            && next.coverSet === undefined && next.backgroundSet === undefined;
        if (empty) {
            this.overrides.delete(id);
        } else {
            this.overrides.set(id, next);
        }
        await this.saveOverrides();
        this.changed();
    }

    async revert(id: string): Promise<void> {
        const current = this.overrides.get(id);
        if (!current) {
            return;
        }
        for (const file of filesOf(current)) {
            await this.dropPicture(file);
        }
        if (this.ownBackdrop?.id === id) {
            this.releaseOwnBackdrop();
        }
        this.overrides.delete(id);
        await this.saveOverrides();
        this.changed();
    }

    romOverride(romId: string): LibraryRomOverride | undefined {
        return this.romOverrides.get(romId);
    }

    /**
     * The same rules as edit: an empty string is no opinion, and an empty override is removed. Except `latest`, a
     * boolean whose "no opinion" is undefined, so `false` can demote a dump the catalog calls current. A game has one
     * current version, so marking one dump current demotes the others, written as their own overrides so the catalog's
     * word stays recoverable per dump. None of this decides what Play starts (see setPreferredRom).
     */
    async editRom(romId: string, patch: Partial<Omit<LibraryRomOverride, 'updatedAt'>>): Promise<void> {
        const current = this.romOverrides.get(romId);
        const next: LibraryRomOverride = { ...current, ...patch, updatedAt: Date.now() };
        for (const field of EDITABLE_ROM_FIELDS) {
            const value = next[field];
            // an explicit undefined hands the field back to the catalog, so delete it rather than store nothing
            if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
                delete next[field];
            } else if (typeof value === 'string') {
                (next[field] as string) = value.trim();
            }
        }
        if (next.gameId === undefined) {
            delete next.gameId;
        }
        const empty = next.gameId === undefined
            && EDITABLE_ROM_FIELDS.every(field => next[field] === undefined);
        if (empty) {
            this.romOverrides.delete(romId);
        } else {
            this.romOverrides.set(romId, next);
        }
        if (patch.latest === true) {
            const game = this.games().find(held => held.roms.some(rom => rom.entry.id === romId));
            for (const other of game?.roms ?? []) {
                if (other.entry.id !== romId && other.latest) {
                    const previous = this.romOverrides.get(other.entry.id);
                    this.romOverrides.set(other.entry.id,
                        { ...previous, latest: false, updatedAt: Date.now() });
                }
            }
        }
        await this.saveRoms();
        this.changed();
    }

    // the stored choice, even if that dump isn't on the shelf right now; LibraryGame.preferred is what actually starts
    preferredRom(gameId: string): string | undefined {
        return this.picks.get(gameId);
    }

    // a single entry in preferred.json that demotes no dump and overrules nothing; kept by game key, so it survives
    // re-reads and moves
    async setPreferredRom(gameId: string, romId: string): Promise<void> {
        if (this.picks.get(gameId) === romId) {
            return;
        }
        this.picks.set(gameId, romId);
        await this.savePreferred();
        this.changed();
    }

    async clearPreferredRom(gameId: string): Promise<void> {
        if (!this.picks.delete(gameId)) {
            return;
        }
        await this.savePreferred();
        this.changed();
    }

    /**
     * Stores what currentOf would start for every game without a choice, once, so a version the catalog calls current a
     * year later doesn't take over the Play button of a game the user has been playing. A stored choice is never
     * rewritten here, even with its checksum off the shelf, as an unplugged folder is not a change of mind. A game
     * waits until the catalog has answered for all its dumps, or this would store a guess.
     */
    protected async adoptPreferred(): Promise<void> {
        const asked = !lookUpDetails();
        let changed = false;
        for (const game of this.games()) {
            if (this.picks.has(game.id) || !game.preferred) {
                continue;
            }
            if (!asked && game.roms.some(rom => rom.entry.lookedUpAt === undefined)) {
                continue;
            }
            this.picks.set(game.id, game.preferred.entry.id);
            changed = true;
        }
        if (changed) {
            await this.savePreferred();
            this.changed();
        }
    }

    // copies the target's catalog answer into the game's record, as the dump carrying it may leave; undefined unfiles
    // the dump
    async fileRom(romId: string, gameId: string | undefined): Promise<void> {
        if (gameId !== undefined && !this.records.has(gameId)) {
            const target = this.games().find(game => game.id === gameId);
            const catalog = target?.roms.find(rom => rom.entry.catalog)?.entry.catalog;
            if (catalog) {
                this.records.set(gameId, { id: gameId, createdAt: Date.now(), catalog });
                await this.save();
            }
        }
        // the game the dump leaves picks again from its remaining dumps, since this is a deliberate move, not an
        // unplugged folder
        let moved = false;
        for (const [game, pick] of [...this.picks]) {
            if (pick === romId && game !== gameId) {
                this.picks.delete(game);
                moved = true;
            }
        }
        if (moved) {
            await this.savePreferred();
        }
        await this.editRom(romId, { gameId });
        await this.adoptPreferred();
    }

    // a game of the user's own for dumps the catalog doesn't know; its key can't collide with a catalog key, and its
    // fields are an ordinary LibraryOverride
    async createGame(
        fields: Partial<Omit<LibraryOverride, 'updatedAt' | 'coverSets' | 'coverSet' | 'backgroundSets' | 'backgroundSet'>> = {},
    ): Promise<string> {
        const id = `${OWN_GAME_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        this.records.set(id, { id, createdAt: Date.now() });
        await this.save();
        await this.edit(id, fields);
        return id;
    }

    // dumps filed under it go back to where their checksums put them; no file is touched
    async deleteGame(id: string): Promise<void> {
        if (!id.startsWith(OWN_GAME_PREFIX)) {
            return;
        }
        for (const [romId, override] of [...this.romOverrides]) {
            if (override.gameId === id) {
                await this.editRom(romId, { gameId: undefined });
            }
        }
        this.records.delete(id);
        if (this.picks.delete(id)) {
            await this.savePreferred();
        }
        await this.revert(id);
        await this.save();
        this.changed();
        this.pruneArt();
    }

    // removes a game and its dumps, remembering their checksums so reads skip them; files on the user's disk stay,
    // copies in imported folders are deleted unless an archive also holds another game's ROM. Edits, pictures, filings,
    // star and play time go too; saves stay in the companion store (see restoreRemoved)
    async removeGame(id: string): Promise<void> {
        const game = this.game(id);
        if (!game) {
            return;
        }
        const romIds = new Set(game.roms.map(rom => rom.entry.id));

        const copies = new Map<string, Set<string>>();
        for (const romId of romIds) {
            for (const file of this.entries.get(romId)?.files ?? []) {
                const folder = this.folders.find(candidate => candidate.id === file.folderId);
                const shared = [...this.entries.values()].some(other => !romIds.has(other.id)
                    && other.files.some(held => held.folderId === file.folderId && held.path === file.path));
                if (folder?.kind !== 'imported' || shared) {
                    continue;
                }
                const paths = copies.get(folder.id) ?? new Set<string>();
                paths.add(file.path);
                copies.set(folder.id, paths);
            }
        }
        for (const [folderId, paths] of copies) {
            await removeFromImport(this.storage, folderId, paths);
        }
        if (copies.has(DOWNLOADS_FOLDER_ID)) {
            // so its Import button on the catalog pages shows again
            await this.readReleases();
        }

        for (const romId of romIds) {
            this.entries.delete(romId);
            this.removed.add(romId);
            this.romOverrides.delete(romId);
        }
        // a dump outside the library that was filed here goes back to its checksum's game, should it ever return
        for (const [romId, override] of [...this.romOverrides]) {
            if (override.gameId === id) {
                this.romOverrides.set(romId, { ...override, gameId: undefined });
            }
        }
        const pictures = filesOf(this.overrides.get(id));
        this.overrides.delete(id);
        for (const file of pictures) {
            await this.dropPicture(file);
        }
        if (this.ownBackdrop?.id === id) {
            this.releaseOwnBackdrop();
        }
        this.favorites.delete(id);
        this.picks.delete(id);
        this.records.delete(id);
        this.playTimes.forget(romIds);
        await Promise.all([
            this.save(),
            this.saveOverrides(),
            this.saveRoms(),
            this.savePreferred(),
            this.saveFavorites(),
        ]);
        this.changed();
        this.pruneArt();
    }

    get removedCount(): number {
        return this.removed.size;
    }

    async restoreRemoved(): Promise<void> {
        if (this.removed.size === 0) {
            return;
        }
        this.removed.clear();
        await this.save();
        this.changed();
        await this.readAll();
    }

    /**
     * Re-asks the catalog for a game it has corrected since. The session's answers and stored pictures are dropped
     * first, so nothing comes from memory or the browser cache; runs even with lookups off, as the user asked. False
     * when the catalog couldn't be reached: what was known stays, and the pictures come back from their addresses until
     * the next try.
     */
    async refreshCatalog(id: string): Promise<boolean> {
        const game = this.game(id);
        if (!game || game.roms.length === 0) {
            return false;
        }
        const romIds = game.roms.map(rom => rom.entry.id);
        const record = this.records.get(id);
        const urls = [...romIds.map(romId => this.entries.get(romId)?.catalog), record?.catalog]
            .flatMap(catalog => catalogUrlsOf(catalog, 'cover').concat(catalogUrlsOf(catalog, 'background')));

        forgetLookups(romIds);
        await this.art.drop(urls);
        this.changed();

        const asked = Date.now();
        await this.lookUp(romIds, true);
        const answered = romIds.every(romId => (this.entries.get(romId)?.lookedUpAt ?? 0) >= asked);

        const fresh = record?.catalog && romIds
            .map(romId => this.entries.get(romId)?.catalog)
            .find(catalog => catalog?.itemId === record.catalog?.itemId);
        if (record && fresh) {
            this.records.set(id, { ...record, catalog: fresh });
            await this.save();
        }

        // a pass of its own, as the lookup's may have joined one started before the pictures were dropped
        await this.caching;
        await this.cacheArt(true);
        await this.loadCovers([id]);
        // the page that asked shows the backdrop, which the fetch wrote but didn't open
        if (this.backdrop && await this.art.open([this.backdrop])) {
            this.changed();
        }
        return answered;
    }

    async readPicture(picture: LibraryPicture): Promise<Blob | undefined> {
        try {
            const data = await this.storage.read(`${COVERS_DIR}/${picture.file}`);
            return new Blob([data as BlobPart], { type: picture.type });
        } catch {
            return undefined;
        }
    }

    // takes the editor's whole state, not a change; chosen files are stored once even if used in several sets, and
    // stored pictures no set refers to any more are deleted
    async savePictures(id: string, kind: PictureKind, draft: PictureDraft): Promise<void> {
        const before = filesOf(this.overrides.get(id));
        const written = new Map<File, LibraryPicture>();
        const sets: LibraryPictureSet[] = [];
        for (const draftSet of draft.sets) {
            const pictures: Partial<Record<PictureKey, LibraryPicture | null>> = {};
            for (const [key, picture] of Object.entries(draftSet.pictures) as [PictureKey, LibraryPicture | File | null][]) {
                if (!(picture instanceof File)) {
                    pictures[key] = picture;
                    continue;
                }
                let stored = written.get(picture);
                if (!stored) {
                    stored = {
                        file: `${id}-${key}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                        type: picture.type || 'image/png',
                        name: picture.name,
                    };
                    await this.storage.write(`${COVERS_DIR}/${stored.file}`, new Uint8Array(await picture.arrayBuffer()));
                    // the shelf draws the box, so open it now; a backdrop waits for its page (see loadOwnBackdrop)
                    if (kind === 'cover') {
                        this.pictureUrls.set(stored.file, URL.createObjectURL(picture));
                    }
                    written.set(picture, stored);
                }
                pictures[key] = stored;
            }
            sets.push({ id: draftSet.id, name: draftSet.name.trim(), base: draftSet.base, pictures });
        }
        // the catalog's first preset is the default, so it's stored as no choice
        const first = this.game(id)?.presets[kind][0]?.id ?? DEFAULT_PRESET;
        const known = isCatalogPreset(draft.shown) || sets.some(set => set.id === draft.shown);
        const shown = known && draft.shown !== first ? draft.shown : undefined;
        await this.edit(id, kind === 'cover'
            ? { coverSets: sets.length > 0 ? sets : undefined, coverSet: shown }
            : { backgroundSets: sets.length > 0 ? sets : undefined, backgroundSet: shown });
        const after = new Set(filesOf(this.overrides.get(id)));
        for (const file of before) {
            if (!after.has(file)) {
                await this.dropPicture(file);
            }
        }
        // the page showing the old backdrop asks by game, not by file, so it wouldn't reload on its own
        if (kind === 'background' && this.ownBackdropWanted === id) {
            await this.loadOwnBackdrop(id);
        }
        // the shelf only asks for covers when the games change, so open catalog box faces that are only shown now
        if (kind === 'cover') {
            await this.loadCovers([id]);
        }
    }

    protected async dropPicture(file: string): Promise<void> {
        await this.storage.delete(`${COVERS_DIR}/${file}`).catch(() => undefined);
        const url = this.pictureUrls.get(file);
        if (url) {
            URL.revokeObjectURL(url);
            this.pictureUrls.delete(file);
        }
    }

    protected pictureUrl(picture: LibraryPicture | null | undefined): string | undefined {
        return picture ? this.pictureUrls.get(picture.file) : undefined;
    }

    protected catalogPresets(catalog: LibraryCatalog | undefined): Record<PictureKind, CatalogPreset[]> {
        const local = (presets: CatalogPreset[]): CatalogPreset[] => presets.map(preset => ({
            ...preset,
            pictures: Object.fromEntries(Object.entries(preset.pictures)
                .map(([key, url]) => [key, this.art.url(url) ?? url])),
        }));
        const remote = remotePresets(catalog);
        return { cover: local(remote.cover), background: local(remote.background) };
    }

    // catalog URLs of the front and SHELF_FACES of each game's shown box; only those are kept open, every face of every
    // box would cost a lot of memory
    protected shownCoverUrls(ids?: ReadonlySet<string>): string[] {
        return this.games()
            .filter(game => !ids || ids.has(game.id))
            .flatMap(game => {
                const set = shownSetOf(this.overrides.get(game.id), 'cover', game.presets.cover);
                return ['front', ...SHELF_FACES]
                    .map(face => set.preset?.pictures[face as BoxFace])
                    .filter((url): url is string => url !== undefined)
                    .map(url => this.art.remoteOf(url) ?? url);
            });
    }

    // opens object URLs for the covers a shelf is about to draw, own and fetched catalog ones, including SHELF_FACES;
    // on demand, so hundreds of games with a few own covers read only those few files
    async loadCovers(ids: string[]): Promise<void> {
        let changed = await this.art.open(this.shownCoverUrls(new Set(ids)));
        for (const id of ids) {
            const set = shownSetOf(this.overrides.get(id), 'cover', []).set;
            for (const face of ['front', ...SHELF_FACES] as BoxFace[]) {
                const picture = set?.pictures[face];
                if (!picture || this.pictureUrls.has(picture.file)) {
                    continue;
                }
                const blob = await this.readPicture(picture);
                if (blob) {
                    this.pictureUrls.set(picture.file, URL.createObjectURL(blob));
                    changed = true;
                }
                // a missing file leaves the catalog's picture or the empty box to stand in
            }
        }
        if (changed) {
            this.changed();
        }
    }

    // like loadBackdrop but for the game's own backdrop, also one at a time; undefined closes the open one, and a game
    // without its own backdrop opens nothing
    async loadOwnBackdrop(id: string | undefined): Promise<void> {
        this.ownBackdropWanted = id;
        const wanted = (): LibraryPicture | undefined => id === undefined
            ? undefined
            : shownSetOf(this.overrides.get(id), 'background', []).set?.pictures.background ?? undefined;
        const picture = wanted();
        const open = this.ownBackdrop;
        if (picture && open && open.id === id && open.file === picture.file) {
            return;
        }
        const had = open !== undefined;
        this.releaseOwnBackdrop();
        if (!id || !picture) {
            if (had) {
                this.changed();
            }
            return;
        }
        const blob = await this.readPicture(picture);
        // asked again while reading: the latest request wins
        if (!blob || this.ownBackdropWanted !== id || wanted()?.file !== picture.file) {
            return;
        }
        this.ownBackdrop = { id, file: picture.file, url: URL.createObjectURL(blob) };
        this.changed();
    }

    protected releaseOwnBackdrop(): void {
        if (this.ownBackdrop) {
            URL.revokeObjectURL(this.ownBackdrop.url);
            this.ownBackdrop = undefined;
        }
    }

    // one at a time, as a backdrop is a full-size picture behind one open page, while covers stay open for the shelf.
    // Takes the catalog URL or the blob: URL a previous call returned; undefined closes the open one
    async loadBackdrop(url: string | undefined): Promise<void> {
        const remote = url === undefined ? undefined : this.art.remoteOf(url) ?? url;
        if (remote === this.backdrop) {
            return;
        }
        if (this.backdrop) {
            this.art.release(this.backdrop);
        }
        this.backdrop = remote;
        const opened = remote !== undefined && await this.art.open([remote]);
        if (opened || url === undefined) {
            this.changed();
        }
    }

    // fetches the catalog's pictures for the shelf: shown covers first with a redraw each, so the shelf visibly fills
    // in, then backdrops without opening them. A second caller joins the running pass, and a failed pass is retried
    // next time
    protected cacheArt(force = false): Promise<void> {
        if (!force && !lookUpDetails()) {
            // the lookup switch also covers catalog pictures; those fetched before are still shown
            return Promise.resolve();
        }
        return this.caching ??= (async () => {
            // shown boxes first, opened as they arrive; other presets after, kept on disk in case the user picks one
            const shown = this.shownCoverUrls();
            const open = new Set(shown);
            await this.art.cache([...shown, ...this.catalogUrls('cover')], async url => {
                if (open.has(url) && await this.art.open([url])) {
                    this.changed();
                }
            });
            await this.art.cache(this.catalogUrls('background'));
        })().catch(() => undefined).finally(() => {
            this.caching = undefined;
        });
    }

    // includes filed games' snapshots, which keep their pictures after the dump carrying the answer left
    protected catalogUrls(kind: 'cover' | 'background'): string[] {
        const found: string[] = [];
        const add = (catalog: LibraryCatalog | undefined): void => {
            found.push(...catalogUrlsOf(catalog, kind));
        };
        for (const entry of this.entries.values()) {
            add(entry.catalog);
        }
        for (const record of this.records.values()) {
            add(record.catalog);
        }
        return found;
    }

    protected pruneArt(): void {
        this.art
            .prune([...this.catalogUrls('cover'), ...this.catalogUrls('background')])
            .catch(() => undefined);
    }

    // whether the ROM is readable without asking for permission; Recently Played keeps a copy only when not
    // (web-recent-origins.ts). Based on the last permission answer, so it can only err harmlessly: a vanished folder
    // says yes and the read fails
    canRead(id: string): boolean {
        return this.readableFile(id) !== undefined;
    }

    protected readableFile(id: string): LibraryFile | undefined {
        return this.entries.get(id)?.files
            .find(file => this.access.get(file.folderId) === 'granted');
    }

    /**
     * The bytes of one of an entry's files, for the emulator. An entry can have several files in different folders and
     * archives, the same ROM only by checksum; the default is the first readable one. Rejects when the folder can't be
     * read (ended permission, unmounted disk), and the caller says so, as a silent Play is the worst outcome.
     * `location` is the file on disk where the host can say (for an archive, the archive), which keeps the game's save
     * beside it. An archive also gives its name and the ESSound tracks packed with the ROM, as opening the archive
     * itself would.
     */
    async read(id: string, file?: LibraryFile): Promise<{
        name: string, data: Uint8Array, location?: string, archive?: string, sounds?: RomSound[],
    }> {
        const entry = this.entries.get(id);
        const target = file ?? this.readableFile(id) ?? entry?.files[0];
        if (!entry || !target) {
            throw new Error('That ROM is not in the library any more.');
        }
        const folder = this.folders.find(known => known.id === target.folderId);
        if (!folder) {
            throw new Error('The folder that ROM is in is no longer known.');
        }
        const source = this.sourceOf(folder);
        const data = await source.read(folder, target);
        // reading may have asked for the folder again (see BrowserLibrarySource.read); then the rest of it is readable
        // too, and is read as grantAccess would
        if (this.access.get(folder.id) !== 'granted') {
            this.access.set(folder.id, 'granted');
            this.changed();
            this.readFolder(folder.id).catch(() => undefined);
        }
        // not worth failing over: without it the save goes to the companion store
        const location = await source.locate?.(folder, target).catch(() => undefined);

        if (!target.archiveEntry) {
            return { name: target.name, data, location };
        }
        const member = listZipEntries(data).find(entry2 => entry2.name === target.archiveEntry);
        if (!member) {
            throw new Error('That archive no longer holds that ROM.');
        }
        return {
            name: target.archiveEntry.split('/').pop() ?? target.archiveEntry,
            data: await readZipEntry(data, member),
            location,
            archive: target.name,
            sounds: await soundsInZip(data),
        };
    }

    protected changed(): void {
        this.onDidChangeEmitter.fire();
        // reads report progress through this, so the status strip and the shelf update together
        this.activityChanged();
    }

    protected activityChanged(): void {
        this.onDidChangeActivityEmitter.fire();
    }

    protected async readJson<T>(path: string): Promise<T | undefined> {
        try {
            return JSON.parse(await this.storage.readText(path)) as T;
        } catch {
            // not written yet, or half written by a crash; an empty library is right for both
            return undefined;
        }
    }

    // writes are chained so a read finishing during a lookup can't race it and leave the older version on disk
    protected save(): Promise<void> {
        const index: StoredIndex = {
            version: INDEX_VERSION,
            folders: this.folders,
            entries: [...this.entries.values()],
            games: [...this.records.values()],
            removed: [...this.removed],
        };
        return this.writing = this.writing
            .catch(() => undefined)
            .then(() => this.storage.writeText(INDEX_PATH, JSON.stringify(index)))
            .catch(() => undefined);
    }

    protected saveOverrides(): Promise<void> {
        const overrides = Object.fromEntries(this.overrides);
        return this.writing = this.writing
            .catch(() => undefined)
            .then(() => this.storage.writeText(OVERRIDES_PATH, JSON.stringify(overrides)))
            .catch(() => undefined);
    }

    protected saveFavorites(): Promise<void> {
        const favorites = [...this.favorites];
        return this.writing = this.writing
            .catch(() => undefined)
            .then(() => this.storage.writeText(FAVORITES_PATH, JSON.stringify(favorites)))
            .catch(() => undefined);
    }

    protected saveRoms(): Promise<void> {
        const roms = Object.fromEntries(this.romOverrides);
        return this.writing = this.writing
            .catch(() => undefined)
            .then(() => this.storage.writeText(ROMS_PATH, JSON.stringify(roms)))
            .catch(() => undefined);
    }

    protected savePreferred(): Promise<void> {
        const picks = Object.fromEntries(this.picks);
        return this.writing = this.writing
            .catch(() => undefined)
            .then(() => this.storage.writeText(PREFERRED_PATH, JSON.stringify(picks)))
            .catch(() => undefined);
    }
}

// the name a file is played and its saves filed under: its own, or the member's name for a ROM in an archive. Kept in
// one place, as drifting copies would file saves under one name and look under another
export function playedAs(file: LibraryFile): string {
    return file.archiveEntry
        ? file.archiveEntry.split('/').pop() ?? file.archiveEntry
        : file.name;
}

// see LibraryGame.resumable
function resumableOf(
    preferred: LibraryRom | undefined,
    roms: LibraryRom[],
): { rom: LibraryRom, file: LibraryFile } | undefined {
    for (const rom of preferred ? [preferred, ...roms] : roms) {
        const file = rom.suspended[0];
        if (file) {
            return { rom, file };
        }
    }
    return undefined;
}

// own title, else the file name (nearly always better than the header's 20 uppercase characters), else the header
export function romLabel(rom: LibraryRom): string {
    if (rom.title) {
        return rom.title;
    }
    const file = rom.entry.files[0];
    return (file && romStem(file.archiveEntry ?? file.name))
        || rom.entry.header.name.trim()
        || rom.entry.id.toUpperCase();
}

// the dump marked current by the catalog or the user, else the first; only used for games without a stored choice
function currentOf(roms: LibraryRom[]): LibraryRom | undefined {
    return roms.find(rom => rom.latest) ?? roms[0];
}

// undefined when the name is close to nothing in the catalog; rejects like a checksum lookup when the catalog is
// unreachable, so the pass stops
function byName(entry: LibraryEntry): Promise<PlanetVbTitleMatch | undefined> {
    const name = nameToAsk(entry);
    return name ? lookupTitle(name) : Promise.resolve(undefined);
}

// the first `(` or ` - `, the two ways collections append notes to a name; the dash needs spaces, as `Spider-Man` is a
// title
const NAME_TAIL = /\s-\s|\(/;

/**
 * The name up to NAME_TAIL: `Jack Bros. (German Translation).vb` and `Jack Bros. - German Translation.vb` are asked
 * as `Jack Bros.`, as are `(Japan)`, `(USA)`, `(Prototype)` and `- Rev 1`. Sent whole they cost the match: the catalog
 * compares how much of the strings is the same and scores the full name against its `Jack Bros.` at 49 instead of
 * 100. Uses the first file's name when there are several, the one the entry is shown by (see romLabel).
 */
function nameToAsk(entry: LibraryEntry): string | undefined {
    const file = entry.files[0];
    const name = file && romStem(file.archiveEntry ?? file.name);
    if (!name) {
        return undefined;
    }
    const tail = name.search(NAME_TAIL);
    return (tail === -1 ? name : name.slice(0, tail)).trim() || undefined;
}

// the catalog's entry id if it answered, else the checksum; not the title, as dumps of one game differ in title and
// different games sometimes share one
function gameKey(entry: LibraryEntry): string {
    const catalog = entry.catalog;
    if (!catalog) {
        return entry.id;
    }
    return `pvb:${catalog.itemId}`;
}

export type { LibraryCatalog, LibraryRomOverride };

function shownSetOf(
    override: LibraryOverride | undefined,
    kind: PictureKind,
    presets: CatalogPreset[],
): { id: string, set?: LibraryPictureSet, preset?: CatalogPreset } {
    const sets = (kind === 'cover' ? override?.coverSets : override?.backgroundSets) ?? [];
    const chosen = kind === 'cover' ? override?.coverSet : override?.backgroundSet;
    const set = sets.find(candidate => candidate.id === chosen);
    if (set) {
        return { id: set.id, set, preset: presets.find(candidate => candidate.id === set.base) };
    }
    const preset = presets.find(candidate => candidate.id === chosen) ?? presets[0];
    return { id: preset?.id ?? DEFAULT_PRESET, preset };
}

// presets at the catalog's URLs, one per box and backdrop in catalog order; a kind without any gets an empty
// DEFAULT_PRESET, so there's always one to show and to base an own set on
function remotePresets(catalog: LibraryCatalog | undefined): Record<PictureKind, CatalogPreset[]> {
    const named = (name: string): string => name || nls.localize('vueport/library/preset/default', 'Default');
    const ids = new Set<string>();
    const idOf = (name: string, index: number): string => {
        const id = catalogPresetId(name, index, ids);
        ids.add(id);
        return id;
    };
    const covers: CatalogPreset[] = (catalog?.covers ?? []).map((cover, index) => ({
        id: idOf(cover.name, index),
        name: named(cover.name),
        pictures: { ...cover.faces },
    }));
    ids.clear();
    const backgrounds: CatalogPreset[] = (catalog?.backgrounds ?? []).map((background, index) => ({
        id: idOf(background.name, index),
        name: named(background.name),
        pictures: { background: background.url },
    }));
    const empty = (): CatalogPreset[] => [{ id: DEFAULT_PRESET, name: named(''), pictures: {} }];
    return {
        cover: covers.length > 0 ? covers : empty(),
        background: backgrounds.length > 0 ? backgrounds : empty(),
    };
}

function catalogUrlsOf(catalog: LibraryCatalog | undefined, kind: PictureKind): string[] {
    const keys: PictureKey[] = kind === 'cover' ? ['front', ...SHELF_FACES] : ['background'];
    return remotePresets(catalog)[kind].flatMap(preset => keys
        .map(key => preset.pictures[key])
        .filter((url): url is string => url !== undefined));
}

function filesOf(override: LibraryOverride | undefined): string[] {
    return [...override?.coverSets ?? [], ...override?.backgroundSets ?? []]
        .flatMap(set => Object.values(set.pictures))
        .filter((picture): picture is LibraryPicture => Boolean(picture))
        .map(picture => picture.file);
}
