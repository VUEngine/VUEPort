// entries are keyed by the ROM's CRC32, as the cheat database, Planet VB's /api/rom/ and WebEmulator.romChecksum are.
// Two copies of one dump are one entry with two files. Nothing here holds ROM bytes, only where a file is (see
// LibraryFile), so two hundred cartridges cost a few hundred kilobytes of index
import { PlanetVbBackground, PlanetVbCover, PlanetVbGame } from './web-planet-vb';

export interface LibraryFile {
    folderId: string;
    // `/`-separated and relative to the folder's root, as a browser reaches the folder through a granted handle that
    // may sit elsewhere after a restart
    path: string;
    name: string;
    bytes: number; // of the entry inside, for an archive
    // an archive holding a demo beside the finished game is two library entries pointing at one file
    archiveEntry?: string;
    modifiedAt: number; // epoch ms, lets a second read skip unchanged files
}

export interface LibraryHeader {
    name: string;
    maker: string;
    code: string;
    version: number;
}

// narrowed, as this is written to disk on every read and a field nothing displays cannot be kept up when the catalog
// changes shape
export interface LibraryCatalog {
    itemId: number; // groups the game's dumps
    title: string;
    developer: string;
    publisher: string;
    released: string; // a year, or a fuller date when the catalog has one
    genre: string;
    players: string;
    region: string;
    status: string;
    kind: string; // raw catalog value
    score?: number; // out of 100
    description: string;
    covers: PlanetVbCover[]; // read-only presets, see CatalogPreset
    backgrounds: PlanetVbBackground[];
    planetVbUrl?: string;
    romTitle?: string;
    md5?: string;
    latest: boolean;
    // set when the catalog didn't know the checksum and the entry was found by file name via /api/rom/title/ (a
    // translation, hack or uncatalogued build): how close the name was. A guess, so the shelf says so; such a match has
    // no romTitle, md5 or latest, as the catalog has no record of the dump
    titleMatch?: number;
}

export function catalogOf(game: PlanetVbGame, titleMatch?: number): LibraryCatalog {
    return {
        itemId: game.itemId,
        title: game.title,
        developer: game.developer,
        publisher: game.publisher,
        released: game.released,
        genre: game.genre,
        players: game.players,
        region: game.region,
        status: game.status,
        kind: game.kind,
        score: game.score,
        description: game.description,
        covers: game.covers,
        backgrounds: game.backgrounds,
        planetVbUrl: game.planetVbUrl,
        romTitle: game.romTitle,
        md5: game.md5,
        latest: game.latest,
        titleMatch,
    };
}

export interface LibraryEntry {
    id: string; // CRC32, lower-case hex
    files: LibraryFile[];
    header: LibraryHeader;
    bytes: number;
    addedAt: number; // epoch ms
    catalog?: LibraryCatalog;
    // epoch ms; absent means never asked, which differs from asked and told no (see unmatched), so an unknown dump is
    // not asked about on every start
    lookedUpAt?: number;
    unmatched: boolean; // both the checksum and the file name were asked, neither answered
}

// kept apart from the entry, which is rebuilt on every read of its folder, and keyed by checksum, so moving or renaming
// the file changes neither. An absent field means no opinion, so reverting a field deletes it
export interface LibraryOverride {
    title?: string;
    developer?: string;
    publisher?: string;
    released?: string;
    genre?: string;
    players?: string;
    region?: string;
    kind?: string;
    notes?: string;
    coverSets?: LibraryPictureSet[];
    coverSet?: string; // a coverSets id or a catalog preset; absent is the catalog's default
    backgroundSets?: LibraryPictureSet[];
    backgroundSet?: string;
    updatedAt: number; // epoch ms
}

/**
 * What the user typed over one dump, as opposed to its game (see LibraryOverride): its name, region and whether it is
 * the one to play. Keyed by CRC32, so it survives a re-read, a rename and a move. gameId refiles the dump when the
 * checksum's answer is wrong or missing: an uncatalogued build, a misfiled ROM, a hack.
 */
export interface LibraryRomOverride {
    // own:... for a game made here, pvb:... for a catalog entry, absent lets the checksum decide. A key nothing answers
    // to any more is ignored, so a dump filed under a deleted game goes back
    gameId?: string;
    title?: string;
    region?: string;
    latest?: boolean; // false demotes the catalog's current dump in favor of a newer build
    updatedAt: number; // epoch ms
}

/**
 * A game the library knows of beyond what a checksum told it. own:... is a game made here for uncatalogued dumps,
 * shown from the LibraryOverride under the same key; this record lets it exist while empty. pvb:... is a catalog entry
 * a dump was filed under by hand; the snapshot keeps the game whole when the dump carrying the catalog answer leaves.
 */
export interface LibraryGameRecord {
    id: string;
    createdAt: number;
    catalog?: LibraryCatalog;
}

export const OWN_GAME_PREFIX = 'own:';

export type BoxFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export const BOX_FACES: ReadonlyArray<BoxFace> = ['front', 'back', 'left', 'right', 'top', 'bottom'];

export type PictureKind = 'cover' | 'background';

export type PictureKey = BoxFace | 'background';

// the preset of a game without catalog pictures of a kind: the empty box, or no backdrop. A game with catalog pictures
// has one preset per box or backdrop instead (see catalogPresetId) and shows the first until chosen
export const DEFAULT_PRESET = 'pvb:default';

// keyed by name, so a choice of "Japan" stays when the catalog adds a box in front of it; the position is the fallback
// for a missing or taken name
export function catalogPresetId(name: string, index: number, taken: ReadonlySet<string>): string {
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `pvb:${slug || index + 1}`;
    return taken.has(id) ? `pvb:${slug || 'preset'}-${index + 1}` : id;
}

export function isCatalogPreset(id: string): boolean {
    return id.startsWith('pvb:');
}

export interface LibraryPictureSet {
    id: string;
    name: string;
    // missing pictures come from that preset, then from the empty box, so a box made from the catalog's keeps the
    // catalog's front until the user replaces it
    base?: string;
    // null is taken out on purpose, so the empty box's shows even where the base preset has a picture
    pictures: Partial<Record<PictureKey, LibraryPicture | null>>;
}

export interface CatalogPreset {
    id: string;
    name: string;
    pictures: Partial<Record<PictureKey, string>>;
}

// copied under library/covers/, as a browser cannot go back to a file from the user's disk
export interface LibraryPicture {
    file: string;
    type: string;
    name?: string;
}

export interface LibraryFolder {
    id: string;
    name: string;
    // linked: the desktop's path or a granted browser handle, re-reads find what was added since. imported: a copy in
    // this origin's storage, all Firefox and Safari can do; it survives an unplugged disk, but new ROMs need another
    // import
    kind: 'linked' | 'imported';
    // only on the folder the library makes itself for releases imported from Planet VB, which grows one download at a
    // time (see Library.importReleases)
    origin?: 'planetvb';
    location?: string; // a browser handle only knows its name, so this is omitted rather than faked
    addedAt: number;
    readAt?: number; // epoch ms
    count?: number;
}

export interface LibraryScanProgress {
    folderId: string;
    files: number; // looked at so far; the total is not known until the end
    known?: number; // what the last read of this folder saw, absent the first time round
    roms: number; // identified so far
    current?: string;
    copying?: boolean; // an import, which knows its total from the start, so known is exact
}
