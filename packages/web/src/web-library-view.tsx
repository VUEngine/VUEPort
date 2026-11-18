import { setLibraryDrawer, useLibraryDrawer } from './web-library-drawer';
import { pushBackHandler } from 'vueport-core/lib/browser/back-navigation';
import { useCompactLayout } from 'vueport-core/lib/browser/compact-layout';
import {
    Archive,
    ArrowsClockwise,
    Books,
    Cards,
    ClockCounterClockwise,
    DownloadSimple,
    FileArrowUp,
    FloppyDisk,
    House,
    Info,
    LinkSimple,
    ListBullets,
    MagnifyingGlass,
    Medal,
    Plus,
    Question,
    SlidersHorizontal,
    SortAscending,
    SortDescending,
    Square,
    Trash,
    SquaresFour,
    Star,
    Warning,
    X
} from '@phosphor-icons/react';
import * as React from 'react';
import EmptyContainer from 'vueport-core/lib/browser/components/kit/EmptyContainer';
import RadioSelect from 'vueport-core/lib/browser/components/kit/RadioSelect';
import { useXrLayout } from 'vueport-core/lib/browser/components/xr-layout';
import ResetButton from 'vueport-core/lib/browser/components/kit/ResetButton';
import Select from 'vueport-core/lib/browser/components/kit/Select';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { openExternal } from './desktop-external';
import { continueVisible, onDidChangeContinueVisible } from './web-continue-visibility';
import { HomebrewGame, HomebrewRom, VUEPORT_URL } from './web-homebrew';
import { Library, LibraryFolderState, LibraryGame, LibraryRelease, LibraryReleaseResult, LibraryRom } from './web-library';
import { Card, CardActions, kindKey, kindName, unreleased } from './web-library-card';
import { CardPlayButtons } from './web-library-card-actions';
import { LibraryCover, usePictureArrival } from './web-library-cover';
import { BoxBackPrint, PrintedFace } from './web-library-box';
import { Coverflow, CoverflowSteer, CoverflowSteerContext } from './web-library-coverflow';
import { PadCommand, PadDirection, steerScreenWithGamepad } from './web-gamepad-ui';
import { LibraryEdit } from './web-library-edit';
import { homebrewRelease, homebrewReleases, releasesOf } from './web-library-download';
import { GamePage, GamePageRom, ImportState, megabits } from './web-library-page';
import { useCatalog } from './web-library-planetvb';
import { LibraryRomEdit } from './web-library-rom-edit';
import { scanSubfolders, setScanSubfolders } from './web-library-settings';
import { StartPage, onDidChangeStartPage, setStartPage, startPage } from './web-start-page';
import { LibraryEntry, LibraryFile } from './web-library-types';
import { playCountLabel, playTimeLabel } from './web-play-time';
import { ScoreBadge } from './web-score';
import { RecentRom, recentDetail, recentName, relativeTime, romStem } from './web-recent-roms';
import { WebUi } from './web-ui';

/**
 * The library, which fills the window when no ROM is open. It shows games rather than files: a US cartridge and its
 * Japanese release are one game with two ROMs, and the game's page picks which one runs. Planet VB's catalog adds two
 * shelves (the homebrew archive and its picks), drawn the same and opening the same page; only Play differs, as the
 * file is downloaded first. Opening a file or a link sits at the foot of the left column; Recently Played is its own
 * shelf, as a ROM from a file or link belongs to no folder. The whole window takes a dropped ROM (see App).
 */
export interface LibraryScreenProps {
    library: Library;
    ui: WebUi;
    onPlay: (entry: LibraryEntry, file?: LibraryFile, resume?: boolean) => void;
    onPlayHomebrew: (game: HomebrewGame, rom?: HomebrewRom) => void;
    onPick: () => void;
    onManage: () => void;
    onOpenUrl: (raw: string) => Promise<void>;
    // newest first
    recents: RecentRom[];
    onOpenRecent: (rom: RecentRom) => void;
    onForgetRecent: (id: string) => void;
    // forgets all recents, including the ROM copies kept for them
    onClearRecents: () => void;
    // true while a ?rom= in the address is still downloading
    busy?: boolean;
    // undefined where this computer can't share (only VUEPort Desktop can)
    onShare?: (entry: LibraryEntry, title: string) => void;
}

type Section =
    | { kind: 'recent' }
    | { kind: 'all' }
    | { kind: 'favorites' }
    | { kind: 'unmatched' }
    | { kind: 'planetvb', filter: CatalogFilter };

type CatalogFilter = 'archive' | 'featured';

function catalogName(filter: CatalogFilter): string {
    return filter === 'featured'
        ? nls.localize('vueport/library/featuredPicks', 'Featured Picks')
        : nls.localize('vueport/library/homebrewArchive', 'Homebrew Archive');
}

function catalogIcon(filter: CatalogFilter): React.JSX.Element {
    return filter === 'featured' ? <Medal size={16} /> : <Archive size={16} />;
}

type SortOrder = 'title' | 'released' | 'score' | 'added' | 'played' | 'playTime';
type SortDirection = 'asc' | 'desc';

// each field offers only the values on the shelf itself (its genres, the years it spans), so a shelf without regions
// offers none; an absent field means no filter
interface ShelfFilters {
    genre?: string;
    year?: string;
    players?: string;
    region?: string;
    // the catalog's raw value, folded by kindKey
    kind?: string;
    saved?: boolean;
}

const FILTERS_KEY = 'vueport.library.filters';

// each shelf keeps its own filters, as a genre picked on the archive and carried onto Favorites would hide games the
// user just asked to see
function shelfKey(section: Section): string {
    return section.kind === 'planetvb' ? section.filter : section.kind;
}

// read field by field, dropping values of the wrong type; empty when storage can't be read at all, so a private window
// starts every shelf unfiltered
function storedFilters(): Record<string, ShelfFilters> {
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(FILTERS_KEY) ?? '{}');
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        const result: Record<string, ShelfFilters> = {};
        for (const [shelf, raw] of Object.entries(parsed as Record<string, Record<string, unknown>>)) {
            if (!raw || typeof raw !== 'object') {
                continue;
            }
            const filters: ShelfFilters = {};
            for (const field of ['genre', 'year', 'players', 'region', 'kind'] as const) {
                if (typeof raw[field] === 'string') {
                    filters[field] = raw[field] as string;
                }
            }
            if (raw.saved === true) {
                filters.saved = true;
            }
            result[shelf] = filters;
        }
        return result;
    } catch {
        return {};
    }
}

// see NothingHere
function anyFilter(filters: ShelfFilters): boolean {
    return Object.values(filters).some(value => value !== undefined);
}

// genres and regions arrive comma- and slash-joined, so a pill lists the parts: "Action, Puzzle" is two things
function facet(cards: Card[], of: (card: Card) => string[]): string[] {
    const seen = new Set<string>();
    for (const card of cards) {
        for (const value of of(card)) {
            if (value) {
                seen.add(value);
            }
        }
    }
    return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// "Action, Puzzle", "Japan / North America"
function parts(value: string | undefined): string[] {
    return (value ?? '').split(/\s*[,/]\s*/).map(part => part.trim()).filter(Boolean);
}

// title sorts A to Z, year and date added newest first, as that's what the user wants from either. Picking a field
// restores its own direction (see chooseSort), so the direction button is a deviation from this
const SORT_DEFAULTS: Record<SortOrder, SortDirection> = {
    title: 'asc',
    released: 'desc',
    score: 'desc',
    added: 'desc',
    played: 'desc',
    playTime: 'desc',
};

// one remembered choice for every shelf, as it is a way of reading the library rather than a property of a shelf
export type LibraryView = 'grid' | 'list' | 'coverflow';

const VIEW_KEY = 'vueport.library.view';

function storedView(): LibraryView {
    try {
        const stored = window.localStorage.getItem(VIEW_KEY);
        return stored === 'list' || stored === 'coverflow' ? stored : 'grid';
    } catch {
        return 'grid';
    }
}

// one setting for both views, as it is the same question of how much screen a game gets: the grid's column width and
// the list's thumbnail size, both derived by the stylesheet
export type CoverSize = 'small' | 'medium' | 'large';

const SIZE_KEY = 'vueport.library.size';

function storedSize(): CoverSize {
    try {
        const stored = window.localStorage.getItem(SIZE_KEY);
        return stored === 'small' || stored === 'large' ? stored : 'medium';
    } catch {
        return 'medium';
    }
}

// from the Library pane's Start Page setting. Recently Played falls back to All Games while it is switched off, so the
// library never opens on a hidden shelf
function startSection(): Section {
    const page: StartPage = startPage();
    switch (page) {
        case 'recent':
            return continueVisible() ? { kind: 'recent' } : { kind: 'all' };
        case 'favorites':
            return { kind: 'favorites' };
        case 'featured':
            return { kind: 'planetvb', filter: 'featured' };
        case 'archive':
            return { kind: 'planetvb', filter: 'archive' };
        default:
            return { kind: 'all' };
    }
}

function sectionPage(section: Section): StartPage | undefined {
    switch (section.kind) {
        case 'recent':
        case 'all':
        case 'favorites':
            return section.kind;
        case 'planetvb':
            return section.filter;
        default:
            return undefined;
    }
}

// button that makes the current shelf the one the library opens on (the Start Page setting). Last in the row, as it
// doesn't change what the shelf shows; on the start page itself it stays, filled in, so nothing beside it shifts.
// Unmatched has no button
function StartPageButton(props: { section: Section }): React.JSX.Element | null {
    const [current, setCurrent] = React.useState(startPage);
    React.useEffect(() => {
        const subscription = onDidChangeStartPage(() => setCurrent(startPage()));
        return () => subscription.dispose();
    }, []);

    const page = sectionPage(props.section);
    if (!page) {
        return null;
    }
    const chosen = page === current;
    const label = chosen
        ? nls.localize('vueport/library/startPage/is', 'This is the start page')
        : nls.localize('vueport/library/startPage/make', 'Make this the start page');
    return <button
        type='button'
        className={`vp-library-start-page${chosen ? ' on' : ''}`}
        onClick={() => setStartPage(page)}
        aria-pressed={chosen}
        title={label}
        aria-label={label}
    >
        <House size={16} weight={chosen ? 'fill' : 'regular'} />
    </button>;
}

export function LibraryScreen(props: LibraryScreenProps): React.JSX.Element {
    const drawerOpen = useLibraryDrawer();
    // a game's page has the column only on a phone, as a drawer; on a larger screen the page takes the whole width
    const phone = useCompactLayout() !== undefined;
    // the drawer belongs to the library, so leaving it (a game starting) closes the drawer
    React.useEffect(() => () => setLibraryDrawer(false), []);
    // the device's Back button closes it, see back-navigation.ts
    React.useEffect(() => drawerOpen ? pushBackHandler(() => setLibraryDrawer(false)) : undefined, [drawerOpen]);
    const { library, ui } = props;

    const [, setNonce] = React.useState(0);
    React.useEffect(() => {
        const subscription = library.onDidChange(() => setNonce(n => n + 1));
        return () => subscription.dispose();
    }, [library]);

    const [section, setSection] = React.useState<Section>(startSection);
    const [search, setSearch] = React.useState('');
    const [sort, setSort] = React.useState<SortOrder>('title');
    const [direction, setDirection] = React.useState<SortDirection>(SORT_DEFAULTS.title);
    // a new shelf or sort order lets every card arrive again
    const arrangement = `${section.kind}:${section.kind === 'planetvb' ? section.filter : ''}:${sort}:${direction}`;
    const [shelfFilters, setShelfFilters] = React.useState(storedFilters);
    const filters = shelfFilters[shelfKey(section)] ?? {};
    const setFilters = React.useCallback((next: ShelfFilters) => {
        setShelfFilters(current => {
            const kept = Object.fromEntries(Object.entries(next)
                .filter(([, value]) => value !== undefined)) as ShelfFilters;
            const all = { ...current, [shelfKey(section)]: kept };
            if (Object.keys(kept).length === 0) {
                delete all[shelfKey(section)];
            }
            try {
                window.localStorage.setItem(FILTERS_KEY, JSON.stringify(all));
            } catch {
                // lost with the session; the shelf still filters
            }
            return all;
        });
    }, [section]);
    const [chosenView, setView] = React.useState<LibraryView>(storedView);
    // the coverflow is driven by animation frames, which a headset session never gives the page, so it falls back to
    // the grid there
    const inHeadset = useXrLayout();
    const view: LibraryView = inHeadset && chosenView === 'coverflow' ? 'grid' : chosenView;
    const [size, setSize] = React.useState<CoverSize>(storedSize);
    const [open, setOpen] = React.useState<{ kind: 'local' | 'catalog', id: string } | undefined>();
    const [editId, setEditId] = React.useState<string | undefined>();
    // which dump's own editor is open, by checksum
    const [editRomId, setEditRomId] = React.useState<string | undefined>();

    // switched off in the Library pane, hiding the shelf and its column entry; a user on that shelf is moved to All
    // Games
    const [showContinue, setShowContinue] = React.useState(continueVisible);
    React.useEffect(() => {
        const subscription = onDidChangeContinueVisible(() => {
            setShowContinue(continueVisible());
            if (!continueVisible()) {
                setSection(current => (current.kind === 'recent' ? { kind: 'all' } : current));
            }
        });
        return () => subscription.dispose();
    }, []);

    // picking a field resets to its own direction (Year newest first, Title from A); a reversal lasts until the field
    // changes again
    const chooseSort = React.useCallback((next: SortOrder) => {
        setSort(next);
        setDirection(SORT_DEFAULTS[next]);
    }, []);

    const chooseView = React.useCallback((next: LibraryView) => {
        setView(next);
        try {
            window.localStorage.setItem(VIEW_KEY, next);
        } catch {
            // lost with the session, which is a small enough loss
        }
    }, []);

    const chooseSize = React.useCallback((next: CoverSize) => {
        setSize(next);
        try {
            window.localStorage.setItem(SIZE_KEY, next);
        } catch {
            // as above, the shelf still draws, it just forgets the size
        }
    }, []);

    // saves are read from this origin's storage rather than tracked as they're written, so the shelf reads them again
    // every time it opens, as a session with a game is exactly when a save appears
    React.useEffect(() => {
        library.readSaves(true).catch(() => undefined);
    }, [library]);

    const folders = library.folderStates();
    const games = library.games();
    const progress = library.readProgress();
    const catalog = useCatalog(section.kind === 'planetvb' || open?.kind === 'catalog');

    // covers the user assigned are files; load the ones about to be shown
    const coverKeys = games.map(game => game.id).join(',');
    React.useEffect(() => {
        library.loadCovers(coverKeys.split(',').filter(Boolean)).catch(() => undefined);
    }, [library, coverKeys]);

    const query = search.trim().toLowerCase();
    const localCards = React.useMemo(() => {
        const inSection = games.filter(game => {
            switch (section.kind) {
                case 'unmatched':
                    return game.unmatched;
                case 'favorites':
                    return game.favorite;
                default:
                    return section.kind === 'all';
            }
        });
        return inSection.map(localCard);
    }, [games, section]);

    // the picks are the same listing with a flag read off it, so one fetch feeds both shelves
    const catalogCards = React.useMemo(() => {
        if (section.kind !== 'planetvb') {
            return [];
        }
        const listed = catalog.games ?? [];
        return (section.filter === 'featured' ? listed.filter(game => game.featured) : listed)
            .map(catalogCard);
    }, [section, catalog.games]);

    // the shelf after the search but before the filter bar. The bar's lists are built from it, so narrowing one field
    // doesn't empty the other menus, and Planet VB's shelf keeps fetching details a filter might need
    const matching = React.useMemo(() => {
        const cards = section.kind === 'planetvb' ? catalogCards : localCards;
        return query.length === 0
            ? cards
            : cards.filter(card => card.searchable.includes(query));
    }, [localCards, catalogCards, section, query]);

    const shown = React.useMemo(
        () => matching.filter(card => passes(card, filters)).sort(comparator(sort, direction)),
        [matching, filters, sort, direction]);

    const shownCatalogGames = React.useMemo(() => {
        if (section.kind !== 'planetvb' || !catalog.games) {
            return [];
        }
        const byId = new Map(catalog.games.map(game => [`hb:${game.id}`, game]));
        return shown
            .map(card => byId.get(card.id))
            .filter((game): game is HomebrewGame => game !== undefined);
    }, [section, shown, catalog.games]);

    /**
     * Whether this shelf holds nothing at all, so it gets no head and no filter bar. Asked of the shelf, not of what's
     * on screen, as a shelf filtered to nothing needs both to get back out. For nothing starred, nothing unmatched or
     * no folder yet, the panel saying what to do is what should show. A shelf still being filled (a folder read, a
     * catalog request) isn't bare, or its head would vanish and come back.
     */
    const bare = section.kind === 'recent'
        ? props.recents.length === 0
        : (section.kind === 'planetvb' ? catalogCards : localCards).length === 0
        && progress === undefined
        && !(section.kind === 'planetvb' && catalog.games === undefined && !catalog.failed);

    // a first visit, which both possible start shelves have to handle, as the library opens on Recently Played unless
    // the Library pane says otherwise
    const firstVisit = folders.length === 0
        && games.length === 0
        && props.recents.length === 0;

    // details are fetched for what's on screen first, then for the rest of the archive a few at a time, first in first
    // out, as a filter bar built from only the visible entries would silently hide the rest. Answers are cached for the
    // session, so this is one pass however often the effect runs
    React.useEffect(() => {
        if (section.kind === 'planetvb' && catalog.games) {
            const byId = new Map(catalog.games.map(game => [`hb:${game.id}`, game]));
            catalog.hydrate([
                ...shown.map(card => byId.get(card.id))
                    .filter((game): game is HomebrewGame => game !== undefined),
                ...catalog.games,
            ]);
        }
    }, [section, shown, catalog]);

    const shownRecents = React.useMemo(() => (query.length === 0
        ? props.recents
        : props.recents.filter(rom => recentName(rom).toLowerCase().includes(query))),
        [props.recents, query]);

    // undefined until the listing is in, as Planet VB isn't asked until the user looks, and a zero would read as an
    // empty catalog
    const catalogCounts = React.useMemo(() => (catalog.games
        ? {
            archive: catalog.games.length,
            featured: catalog.games.filter(game => game.featured).length,
        }
        : undefined), [catalog.games]);

    // Chrome and Edge can be granted a folder and read it in place; Firefox and Safari object to that API, so there the
    // ROMs are copied in instead. Either way the button opens the picker directly, as a file picker needs the user
    // gesture that opened it
    const addFolder = React.useCallback(async () => {
        if (library.canAddFolders()) {
            await library.addFolder('linked');
            return;
        }
        if (library.canImportFolders()) {
            await library.addFolder('imported');
            return;
        }
        // neither works, which takes a browser older than anything this bundle runs in. Said in a dialog rather than
        // greyed out, as a dead button doesn't say why
        const wanted = await ui.confirm({
            title: nls.localize('vueport/library/noPicker/title',
                'This browser cannot open a folder'),
            message: [
                nls.localize('vueport/library/noPicker/why',
                    'Reading a folder needs either the File System Access API or a directory upload, \
and this browser has neither.'),
                nls.localize('vueport/library/noPicker/fix',
                    'The desktop application has no such limit, and it reads the folder where it \
is rather than copying anything. Everything else here works in this browser: open a single ROM, or \
play something from Planet VB.'),
            ],
            okLabel: nls.localize('vueport/library/getDesktop', 'Get the desktop app'),
        });
        if (wanted) {
            openExternal(VUEPORT_URL).catch(() => undefined);
        }
    }, [library, ui]);

    // not awaited: a batch can run for minutes, the buttons follow the library's state and the strip under the shelf
    // shows progress
    const importReleases = React.useCallback((releases: LibraryRelease[]) => {
        library.importReleases(releases)
            .then(result => reportImport(ui, result))
            .catch(error => ui.toast('error', String((error as Error)?.message ?? error)));
    }, [library, ui]);

    const importShown = React.useCallback(async (shownGames: HomebrewGame[]) => {
        const waiting = shownGames
            .map(game => ({
                game,
                roms: releasesOf(game).filter(rom =>
                    !library.hasRelease(rom.id) && !library.isImportingRelease(rom.id)),
            }))
            .filter(entry => entry.roms.length > 0);
        const count = waiting.reduce((sum, entry) => sum + entry.roms.length, 0);
        if (count === 0) {
            return;
        }
        const sure = await ui.confirm({
            title: nls.localize('vueport/library/import/shownTitle',
                'Import {0} ROMs from {1} games?', count, waiting.length),
            message: [
                nls.localize('vueport/library/import/shownWhat',
                    'Every release of every game on this shelf, as the search and the filters leave it, \
is downloaded from Planet VB and kept in the library\'s "Planet VB" folder. ROMs that are already in it \
are not downloaded again.'),
            ],
            okLabel: nls.localize('vueport/library/import/shownOk', 'Import'),
        });
        if (sure) {
            importReleases(homebrewReleases(waiting.map(entry => ({ ...entry.game, roms: entry.roms }))));
        }
    }, [library, ui, importReleases]);

    // confirmed first, as a ROM opened from a file or link is kept here so it can be started again (see RecentRoms),
    // and for a link this copy may be the only one. The question gives the count, as clearing ignores the search box
    const clearRecents = React.useCallback(async () => {
        const sure = await ui.confirm({
            title: nls.localize('vueport/library/clearRecent/title',
                'Forget the {0} ROMs in Recently Played?', props.recents.length),
            message: [
                nls.localize('vueport/library/clearRecent/what',
                    'This will delete the list as well as the copies VUEPort keeps of the ROMs, \
e.g. for ones opened from links.'),
            ],
            okLabel: nls.localize('vueport/library/clearRecent/ok', 'Clear'),
        });
        if (sure) {
            props.onClearRecents();
        }
    }, [ui, props]);

    // a prompt behind a line of text rather than an always-open field, which leaves the column to the shelves and has
    // room to explain that this plays a ROM without filing it, and that ?rom= in VUEPort's address does the same
    const askForLink = React.useCallback(async () => {
        const raw = await ui.prompt({
            title: nls.localize('vueport/library/fromLink/title', 'Open a ROM from a link'),
            message: [
                nls.localize('vueport/library/fromLink/what',
                    'The address of a .vb, .bin or .vbc file, or of a .zip or .vbz holding \
one. VUEPort downloads it and plays it; it is not filed in your library.'),
                nls.localize('vueport/library/fromLink/param',
                    'The same ROM can be opened by a link: put ?rom= followed by its \
address on the end of this page\'s own, and VUEPort loads it on arrival.'),
            ],
            placeholder: nls.localize('vueport/welcome/linkPlaceholder', 'https://…/game.vb'),
            type: 'url',
            okLabel: nls.localize('vueport/welcome/load', 'Load'),
        });
        if (raw) {
            // any error has already been shown in a toast
            await props.onOpenUrl(raw).catch(() => undefined);
        }
    }, [ui, props]);

    // for ROMs the catalog doesn't know (an own build, a hack, a compilation). Created empty and filled from the ROMs'
    // own editors, the one place where a dump's game is decided
    const newGame = React.useCallback(async () => {
        const title = await ui.prompt({
            title: nls.localize('vueport/library/newGame/title', 'Name the new game'),
            placeholder: nls.localize('vueport/library/newGame/placeholder', 'Its title'),
            okLabel: nls.localize('vueport/library/create', 'Create'),
        });
        if (title?.trim()) {
            setOpen({ kind: 'local', id: await library.createGame({ title: title.trim() }) });
        }
    }, [library, ui]);

    // Play starts the dump the game's page would (see LibraryGame.preferred), Resume the file that was put away
    const { onPlay, onPlayHomebrew, onShare } = props;
    const localActions = React.useMemo<CardActions>(() => ({
        onPlay: id => {
            const rom = library.game(id)?.preferred;
            if (rom) {
                onPlay(rom.entry);
            }
        },
        onResume: id => {
            const resumable = library.game(id)?.resumable;
            if (resumable) {
                onPlay(resumable.rom.entry, resumable.file, true);
            }
        },
        onShare: onShare && (id => {
            const game = library.game(id);
            if (game?.preferred) {
                onShare(game.preferred.entry, game.title);
            }
        }),
    }), [library, onPlay, onShare]);

    const catalogGames = catalog.games;
    const catalogActions = React.useMemo<CardActions>(() => ({
        onPlay: id => {
            const game = catalogGames?.find(entry => `hb:${entry.id}` === id);
            if (game) {
                onPlayHomebrew(game);
            }
        },
        onResume: () => undefined,
    }), [catalogGames, onPlayHomebrew]);

    const editing = editId ? library.game(editId) : undefined;
    const openLocal = open?.kind === 'local' ? library.game(open.id) : undefined;
    const editingRom = editRomId
        ? openLocal?.roms.find(rom => rom.entry.id === editRomId)
        : undefined;
    const openCatalog = open?.kind === 'catalog'
        ? catalog.games?.find(game => game.id === open.id)
        : undefined;

    // game pad position in two steps: which card (on a game's page, which ROM), then after A which of its buttons. The
    // card stays undefined until a pad is used, so mouse users see no highlight, and is reset when the shelf or order
    // changes; the coverflow reports its front cover through CoverflowSteerContext
    const [padCard, setPadCard] = React.useState<string | undefined>(undefined);
    const [pageCard, setPageCard] = React.useState<string | undefined>(undefined);
    const [padAction, setPadAction] = React.useState<number | undefined>(undefined);
    // the coverflow always has a front cover, and marking it before the pad is touched would show its buttons to a
    // mouse user
    const [padTouched, setPadTouched] = React.useState(false);
    React.useEffect(() => {
        setPadCard(undefined);
        setPadAction(undefined);
        setPadTouched(false);
    }, [arrangement]);
    React.useEffect(() => { setPageCard(undefined); setPadAction(undefined); }, [open]);
    const flowSteer = React.useRef<CoverflowSteer | undefined>(undefined);
    // the coverflow keeps its front cover as its own state, so stepping it re-renders only the coverflow; this is
    // bumped on every step so the highlight here follows
    const [, redrawPad] = React.useReducer((n: number) => n + 1, 0);
    const main = React.useRef<HTMLDivElement>(null);
    const flowing = view === 'coverflow' && section.kind !== 'recent' && !open;

    const padRoot = (): HTMLElement | null => open
        ? document.querySelector<HTMLElement>('.vp-library-page')
        : main.current;
    const padItem = (): string | undefined => open
        ? pageCard
        : flowing ? flowSteer.current?.current() : padCard;
    const itemNode = (root: HTMLElement | null, id: string | undefined): HTMLElement | null =>
        root && id !== undefined ? root.querySelector<HTMLElement>(`[data-pad-card="${CSS.escape(id)}"]`) : null;
    const itemActions = (node: HTMLElement | null): HTMLButtonElement[] => node
        ? [...node.querySelectorAll<HTMLButtonElement>('button[data-pad-action]')].filter(button => !button.disabled)
        : [];

    // the highlight is drawn as classes on the marked elements rather than props through every shelf and view;
    // reapplied after every render, as a redrawn shelf (a search, a closed page) has fresh nodes
    React.useEffect(() => {
        const root = padRoot();
        if (!root) {
            return;
        }
        const item = flowing && !padTouched ? null : itemNode(root, padItem());
        const action = padAction === undefined ? undefined : itemActions(item)[padAction];
        for (const stale of root.querySelectorAll('.is-pad-selected, .is-pad-action')) {
            if (stale !== item) {
                stale.classList.remove('is-pad-selected');
            }
            if (stale !== action) {
                stale.classList.remove('is-pad-action');
            }
        }
        item?.classList.add('is-pad-selected');
        action?.classList.add('is-pad-action');
    });
    React.useEffect(() => {
        itemNode(padRoot(), padItem())?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [padCard, pageCard, open]);

    // the shelves in the column's order, which L and R step through
    const shelves: Section[] = [
        ...(showContinue ? [{ kind: 'recent' } as const] : []),
        { kind: 'all' },
        { kind: 'favorites' },
        ...(games.some(game => game.unmatched) ? [{ kind: 'unmatched' } as const] : []),
        { kind: 'planetvb', filter: 'featured' },
        { kind: 'planetvb', filter: 'archive' },
    ];

    const startCard = (id: string): void => {
        if (section.kind === 'recent') {
            const rom = shownRecents.find(candidate => candidate.id === id);
            if (rom) {
                props.onOpenRecent(rom);
            }
        } else {
            (section.kind === 'planetvb' ? catalogActions : localActions).onPlay(id);
        }
    };

    /**
     * Handles one game pad command (buttons in web-gamepad-ui.ts). Rebuilt every render and reached through a ref, so
     * the listener is registered once and still sees the current shelf. The d-pad moves between cards; A on a card goes
     * into its buttons (Play, Resume, Details; a ROM's row on a page), where left and right move, A presses and B comes
     * back out. Start always starts.
     */
    const onPad = React.useRef<(command: PadCommand) => void>(() => undefined);
    onPad.current = command => {
        // the edit windows are forms, and other windows over the library have their own controls
        if (editId !== undefined || editRomId !== undefined || document.querySelector('[aria-modal="true"]')) {
            return;
        }
        if (!padTouched) {
            setPadTouched(true);
        }
        const root = padRoot();
        const item = padItem();
        const actions = itemActions(itemNode(root, item));

        if (padAction !== undefined) {
            if (command === 'left' || command === 'right') {
                const by = command === 'left' ? -1 : 1;
                setPadAction(Math.max(0, Math.min(actions.length - 1, padAction + by)));
                return;
            }
            if (command === 'confirm') {
                const pressed = actions[padAction];
                pressed?.click();
                // a button that changes something in place rather than navigating (the coverflow's flip) keeps the pad
                // on it
                if (!pressed?.hasAttribute('data-pad-stay')) {
                    setPadAction(undefined);
                }
                return;
            }
            if (command === 'cancel') {
                setPadAction(undefined);
                return;
            }
            setPadAction(undefined);
        }

        if (command === 'start') {
            if (open) {
                if (openLocal?.preferred) {
                    props.onPlay(openLocal.preferred.entry);
                } else if (openCatalog) {
                    props.onPlayHomebrew(openCatalog);
                }
            } else if (item !== undefined) {
                startCard(item);
            }
            return;
        }
        if (command === 'cancel') {
            if (open) {
                setOpen(undefined);
            }
            return;
        }
        if (command === 'previous' || command === 'next') {
            if (open) {
                return;
            }
            const at = shelves.findIndex(shelf => sameSection(shelf, section));
            const by = command === 'next' ? 1 : -1;
            setSection(shelves[(at + by + shelves.length) % shelves.length]);
            setSearch('');
            return;
        }
        if (command === 'up' || command === 'down' || command === 'left' || command === 'right') {
            if (flowing) {
                // left and right move along the shelf, up and down flip the box, as its back is the other half of what
                // a cover shows
                if (command === 'left' || command === 'right') {
                    flowSteer.current?.step(command === 'left' ? -1 : 1);
                } else {
                    flowSteer.current?.flip();
                }
                redrawPad();
            } else if (root) {
                const next = neighbourCard(root, item, command) ?? item;
                (open ? setPageCard : setPadCard)(next);
            }
            return;
        }
        if (command === 'confirm') {
            if (item === undefined) {
                if (!flowing && root) {
                    (open ? setPageCard : setPadCard)(neighbourCard(root, undefined, 'down'));
                }
                return;
            }
            if (actions.length > 0) {
                setPadAction(0);
            } else if (section.kind === 'recent' && !open) {
                // a recent ROM is a file without a page or buttons, so A starts it
                startCard(item);
            }
        }
    };
    React.useEffect(() => steerScreenWithGamepad(command => onPad.current(command)), []);

    // the keyboard steers the same way: arrows are the d-pad, Enter is A, Escape and Backspace are B, Tab and Shift+Tab
    // step through the shelves like R and L. Only while nothing else claims the key: not in a text field, under a
    // dialog or the command palette, with a modifier held, or with an edit window open
    const editingNow = editId !== undefined || editRomId !== undefined;
    const keyBlocked = React.useRef(editingNow);
    keyBlocked.current = editingNow;
    React.useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented
                || keyBlocked.current || isTypingField(event.target)
                || ui.isPicking || ui.isPrompting || ui.isConfirming || ui.isCapturingKey
                || document.querySelector('.vp-modal-backdrop, [aria-modal="true"]')) {
                return;
            }
            const command: PadCommand | undefined = KEY_COMMANDS[event.key]
                ?? (event.key === 'Tab' ? (event.shiftKey ? 'previous' : 'next') : undefined);
            if (!command || (event.shiftKey && event.key !== 'Tab')) {
                return;
            }
            // stopped here in the capture phase, so the coverflow's own arrow and Enter handling and a focused button's
            // Enter don't handle the key again
            event.preventDefault();
            event.stopPropagation();
            onPad.current(command);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [ui]);

    const [refreshing, setRefreshing] = React.useState<ReadonlySet<string>>(new Set());
    const refreshGame = React.useCallback((id: string) => {
        setRefreshing(current => new Set(current).add(id));
        library.refreshCatalog(id)
            .then(answered => {
                if (!answered) {
                    ui.toast('warn', nls.localize('vueport/library/refresh/offline',
                        'Planet VB could not be reached. Try again later.'));
                }
            })
            .catch(() => undefined)
            .finally(() => setRefreshing(current => {
                const next = new Set(current);
                next.delete(id);
                return next;
            }));
    }, [library, ui]);

    // confirmed first, as only the ROMs can come back from the settings; the edits, pictures and play time are gone
    const removeGame = React.useCallback(async (game: LibraryGame) => {
        const sure = await ui.confirm({
            title: nls.localize('vueport/library/removeGame/title', 'Remove {0} from the library?', game.title),
            message: [
                game.roms.length === 1
                    ? nls.localize('vueport/library/removeGame/one',
                        'Its ROM is taken out of the library and not added again when its folder is read. \
A copy in an imported folder is deleted; a file in a linked folder stays where it is.')
                    : nls.localize('vueport/library/removeGame/many',
                        'Its {0} ROMs are taken out of the library and not added again when their folders \
are read. Copies in imported folders are deleted; files in linked folders stay where they are.',
                        game.roms.length),
                nls.localize('vueport/library/removeGame/what',
                    'Edits, custom pictures, favorite and play time are deleted too. Saves are kept. \
Removed ROMs can be brought back under Settings → Library.'),
            ],
            okLabel: nls.localize('vueport/library/removeGame/ok', 'Remove'),
        });
        if (sure) {
            setOpen(undefined);
            await library.removeGame(game.id);
        }
    }, [library, ui]);

    // the backdrop is a full-size picture, so it's only loaded for the open page. Stored locally once the catalog was
    // asked, hence a read rather than a download; an assigned backdrop replaces the catalog's entirely
    const ownBackdrop = openLocal?.ownBackground ? openLocal.id : undefined;
    const backdrop = ownBackdrop ? undefined : openLocal?.catalogBackgroundUrl;
    React.useEffect(() => {
        library.loadBackdrop(backdrop).catch(() => undefined);
    }, [library, backdrop]);
    React.useEffect(() => {
        library.loadOwnBackdrop(ownBackdrop).catch(() => undefined);
    }, [library, ownBackdrop]);

    // the library's column; on a phone it is a drawer over the shelf, opened from the title bar
    // (web-library-drawer.ts), also on a game's page. The backdrop closes it, as does picking a shelf, which also
    // leaves the page
    const drawer = <>
        <div
            className={'vp-library-drawer-backdrop' + (drawerOpen ? ' open' : '')}
            aria-hidden='true'
            onClick={() => setLibraryDrawer(false)}
        />
        <LibrarySidebar
            open={drawerOpen}
            section={section}
            counts={{
                all: games.length,
                favorites: games.filter(game => game.favorite).length,
                unmatched: games.filter(game => game.unmatched).length,
            }}
            catalogCounts={catalogCounts}
            recents={showContinue ? props.recents.length : undefined}
            // a shelf starts fresh: the search isn't carried over, and each shelf keeps its own filters (see shelfKey)
            onSection={next => { setSection(next); setSearch(''); setLibraryDrawer(false); setOpen(undefined); }}
            onManage={() => { setLibraryDrawer(false); props.onManage(); }}
            onPick={() => { setLibraryDrawer(false); props.onPick(); }}
            onOpenUrl={() => { setLibraryDrawer(false); askForLink().catch(() => undefined); }}
            busy={props.busy}
        />
    </>;

    if (openLocal) {
        return <div className='vp-library'>
            {phone && drawer}
            <LocalGamePage
                game={openLocal}
                onBack={() => setOpen(undefined)}
                onPlay={props.onPlay}
                onEdit={() => setEditId(openLocal.id)}
                onEditRom={rom => setEditRomId(rom.entry.id)}
                onPrefer={rom => {
                    library.setPreferredRom(openLocal.id, rom.entry.id).catch(() => undefined);
                }}
                onFavorite={() => {
                    library.setFavorite(openLocal.id, !openLocal.favorite).catch(() => undefined);
                }}
                onRefresh={() => { refreshGame(openLocal.id); }}
                refreshing={refreshing.has(openLocal.id)}
                onRemove={() => { removeGame(openLocal).catch(() => undefined); }}
                onShare={props.onShare && openLocal.preferred
                    ? () => props.onShare?.(openLocal.preferred!.entry, openLocal.title)
                    : undefined}
                onShareRom={props.onShare
                    ? rom => props.onShare?.(rom.entry, rom.title ?? openLocal.title)
                    : undefined}
            />
            {editing && <LibraryEdit
                library={library}
                ui={ui}
                game={editing}
                onClose={() => setEditId(undefined)}
                onDeleted={() => { setEditId(undefined); setOpen(undefined); }}
            />}
            {editingRom && <LibraryRomEdit
                library={library}
                game={openLocal}
                rom={editingRom}
                folders={folders}
                onClose={() => setEditRomId(undefined)}
                // follow the dump to wherever it was filed, as the page that showed it may no longer hold it
                onFiled={id => setOpen({ kind: 'local', id })}
            />}
        </div>;
    }
    if (open?.kind === 'catalog') {
        return <div className='vp-library'>
            {phone && drawer}
            <CatalogPage
                game={openCatalog}
                onBack={() => setOpen(undefined)}
                onPlay={props.onPlayHomebrew}
                onDetail={catalog.detail}
                importState={rom => releaseState(library, rom.id)}
                onImport={(game, roms) => importReleases(roms.map(rom => homebrewRelease(game, rom)))}
            />
        </div>;
    }

    return <CoverflowSteerContext.Provider value={flowSteer}><div className='vp-library'>
        {drawer}

        <div className='vp-library-main' ref={main}>
            {!bare && <header className='vp-library-head'>
                <div className='vp-library-title'>
                    <h2>{sectionName(section)}</h2>
                    <span className='vp-hint'>
                        {shelfLine(section, {
                            shown: shown.length,
                            recents: shownRecents.length,
                            folders,
                            reading: progress !== undefined,
                        })}
                    </span>
                </div>
                <div className='vp-library-tools'>
                    {/* beside the search, as it imports what the search and the filter bar leave */}
                    {section.kind === 'planetvb' && <ImportShownButton
                        className='vp-library-import-shown'
                        library={library}
                        games={shownCatalogGames}
                        onImport={() => { importShown(shownCatalogGames).catch(() => undefined); }}
                    />}
                    <div className='vp-settings-search vp-library-search'>
                        <MagnifyingGlass size={15} />
                        <input
                            type='text'
                            value={search}
                            spellCheck={false}
                            placeholder={nls.localize('vueport/library/search', 'Search the library')}
                            aria-label={nls.localize('vueport/library/search', 'Search the library')}
                            onChange={event => setSearch(event.target.value)}
                        />
                        {search &&
                            <button
                                type='button'
                                className='vp-settings-search-clear'
                                onClick={() => setSearch('')}
                                aria-label={nls.localize('vueport/library/clearSearch', 'Clear the search')}
                            >
                                <X size={13} />
                            </button>
                        }
                    </div>
                    {/* Recently Played has one order, newest first, and shows last frames rather than covers, so
                        neither the sort nor the view switch applies */}
                    {section.kind !== 'recent' && <div className='vp-library-sorting'>
                        {/* sort direction, a click reverses it. Beside the field rather than in its menu, as the two
                            are separate choices and one menu would multiply them */}
                        <button
                            type='button'
                            className='vp-library-sort-direction'
                            onClick={() => setDirection(current => (current === 'asc' ? 'desc' : 'asc'))}
                            title={directionName(direction)}
                            aria-label={directionName(direction)}
                        >
                            {direction === 'asc'
                                ? <SortAscending size={16} />
                                : <SortDescending size={16} />}
                        </button>
                        <Select
                            className='vp-library-sort'
                            value={sort}
                            label={nls.localize('vueport/library/sort/by', 'Sort by')}
                            onChange={next => chooseSort(next as SortOrder)}
                            options={[
                                { value: 'title', label: nls.localize('vueport/library/sort/title', 'Title') },
                                { value: 'released', label: nls.localize('vueport/library/sort/year', 'Year') },
                                { value: 'score', label: nls.localize('vueport/library/sort/score', 'Score') },
                                {
                                    value: 'added',
                                    label: nls.localize('vueport/library/sort/added', 'Recently added'),
                                },
                                {
                                    value: 'played',
                                    label: nls.localize('vueport/library/sort/played', 'Recently played'),
                                },
                                {
                                    value: 'playTime',
                                    label: nls.localize('vueport/library/sort/playTime', 'Play time'),
                                },
                            ]}
                        />
                    </div>}
                    {/* Recently Played has no sort or view, so the clear button sits where those would be */}
                    {section.kind === 'recent'
                        ? <button
                            type='button'
                            className='vp-button secondary vp-library-clear-recent'
                            onClick={() => { clearRecents().catch(() => undefined); }}
                        >
                            <Trash size={15} />
                            {nls.localize('vueport/library/clearRecent/button', 'Clear list')}
                        </button>
                        : undefined}
                    {section.kind !== 'recent' && <div className='vp-library-views'>
                        <RadioSelect
                            options={[
                                {
                                    value: 'small',
                                    label: <span className='vp-library-size-option' data-size='small'>
                                        <Square size={10} weight='fill' />
                                    </span>,
                                    tooltip: nls.localize('vueport/library/covers/small', 'Small covers'),
                                },
                                {
                                    value: 'medium',
                                    label: <span className='vp-library-size-option' data-size='medium'>
                                        <Square size={14} weight='fill' />
                                    </span>,
                                    tooltip: nls.localize('vueport/library/covers/medium', 'Medium covers'),
                                },
                                {
                                    value: 'large',
                                    label: <span className='vp-library-size-option' data-size='large'>
                                        <Square size={18} weight='fill' />
                                    </span>,
                                    tooltip: nls.localize('vueport/library/covers/large', 'Large covers'),
                                },
                            ]}
                            defaultValue={size}
                            onChange={chosen => chooseSize(chosen[0].value as CoverSize)}
                        />
                        <RadioSelect
                            options={[
                                {
                                    value: 'grid',
                                    label: <span className='vp-library-view-option' data-view='grid'>
                                        <SquaresFour size={16} />
                                    </span>,
                                    tooltip: nls.localize('vueport/library/layout/grid', 'Covers'),
                                },
                                {
                                    value: 'list',
                                    label: <span className='vp-library-view-option' data-view='list'>
                                        <ListBullets size={16} />
                                    </span>,
                                    tooltip: nls.localize('vueport/library/layout/list', 'List'),
                                },
                                ...inHeadset ? [] : [{
                                    value: 'coverflow',
                                    label: <span className='vp-library-view-option' data-view='coverflow'>
                                        <Cards size={16} />
                                    </span>,
                                    tooltip: nls.localize('vueport/library/layout/coverflow', 'Coverflow'),
                                }],
                            ]}
                            defaultValue={view}
                            onChange={chosen => chooseView(chosen[0].value as LibraryView)}
                        />
                    </div>}
                    <StartPageButton section={section} />
                </div>
            </header>}

            {/* filter bar for the catalog's fields and saves, on every shelf that holds games; the archive needs it
                most, so every archive entry is fetched (see the effect above). Not on Recently Played, whose ROM
                files have none of these fields */}
            {!bare && section.kind !== 'recent' && <FilterBar
                cards={matching}
                filters={filters}
                onChange={setFilters}
                filling={section.kind === 'planetvb' && catalog.hydrating}
            />}

            {progress && <ReadProgress
                folder={folders.find(folder => folder.id === progress.folderId)}
                files={progress.files}
                roms={progress.roms}
                copying={progress.copying ? { total: progress.known ?? progress.files } : undefined}
                onStop={() => library.cancelRead(progress.folderId)}
            />}

            {section.kind === 'recent'
                // nothing played and nothing in the library: a first visit, which wants the panel offering ways in
                // rather than the one saying the shelf fills from playing. Reachable since the library opens on
                // Recently Played by default
                ? (firstVisit && query.length === 0
                    ? <FirstRun
                        onAddFolder={() => { addFolder().catch(() => undefined); }}
                        canLink={library.canAddFolders()}
                        onPick={props.onPick}
                        onCatalog={() => setSection({ kind: 'planetvb', filter: 'archive' })}
                    />
                    : <RecentShelf
                        recents={shownRecents}
                        searching={query.length > 0}
                        onOpen={props.onOpenRecent}
                        onForget={props.onForgetRecent}
                    />)
                : section.kind === 'planetvb'
                    ? <CatalogShelfView
                        cards={shown}
                        arrangement={arrangement}
                        view={view}
                        size={size}
                        loading={catalog.games === undefined && !catalog.failed}
                        failed={catalog.failed}
                        searching={query.length > 0 || anyFilter(filters)}
                        onRetry={catalog.retry}
                        onOpen={id => setOpen({ kind: 'catalog', id: id.replace(/^hb:/, '') })}
                        actions={catalogActions}
                    />
                    // "Your library is empty" is about games, not folders, as a game made here outlives its dumps'
                    // folder
                    : folders.length === 0 && games.length === 0
                        ? <FirstRun
                            onAddFolder={() => { addFolder().catch(() => undefined); }}
                            canLink={library.canAddFolders()}
                            onPick={props.onPick}
                            onCatalog={() => setSection({ kind: 'planetvb', filter: 'archive' })}
                        />
                        : shown.length === 0
                            ? <NothingHere
                                section={section}
                                narrowed={query.length > 0 || anyFilter(filters)}
                                reading={progress !== undefined}
                                onReadAgain={() => { library.readAll().catch(() => undefined); }}
                                onSubfolders={() => {
                                    setScanSubfolders(true);
                                    library.readAll().catch(() => undefined);
                                }}
                                onManage={props.onManage}
                            />
                            : <Shelf view={view} size={size}>
                                {view === 'grid'
                                    ? <Grid
                                        cards={shown}
                                        arrangement={arrangement}
                                        onOpen={id => setOpen({ kind: 'local', id })}
                                        actions={localActions}
                                    />
                                    : view === 'list'
                                        ? <List
                                            cards={shown}
                                            onOpen={id => setOpen({ kind: 'local', id })}
                                            actions={localActions}
                                        />
                                        : <Coverflow
                                            cards={shown}
                                            onOpen={id => setOpen({ kind: 'local', id })}
                                            actions={localActions}
                                        />}
                            </Shelf>}
        </div>
    </div></CoverflowSteerContext.Provider>;
}

// the keys that steer the library like a game pad's buttons; Tab is handled beside these
const KEY_COMMANDS: Record<string, PadCommand | undefined> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Enter: 'confirm',
    Escape: 'cancel',
    Backspace: 'cancel',
};

function isTypingField(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return true;
    }
    return target instanceof HTMLInputElement
        && !['button', 'checkbox', 'radio', 'submit', 'reset', 'range'].includes(target.type);
}

function sameSection(a: Section, b: Section): boolean {
    return a.kind === b.kind
        && (a.kind !== 'planetvb' || (b.kind === 'planetvb' && a.filter === b.filter));
}

// measured on the page rather than from a column count, as a reflowing grid, a table and a row of recents are all
// steered with it. Nearest along the direction, then across it, weighted so a card straight below wins; with nothing
// chosen yet the pad starts at the first card
function neighbourCard(root: HTMLElement, from: string | undefined, direction: PadDirection): string | undefined {
    const nodes = [...root.querySelectorAll<HTMLElement>('[data-pad-card]')];
    const start = nodes.find(node => node.dataset.padCard === from);
    if (!start) {
        return nodes[0]?.dataset.padCard;
    }
    const centre = (node: HTMLElement) => {
        const box = node.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };
    const here = centre(start);
    let best: HTMLElement | undefined;
    let bestScore = Infinity;
    for (const node of nodes) {
        if (node === start) {
            continue;
        }
        const there = centre(node);
        const dx = there.x - here.x;
        const dy = there.y - here.y;
        const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
        if (along <= 1) {
            continue;
        }
        const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
        const score = along + across * 3;
        if (score < bestScore) {
            bestScore = score;
            best = node;
        }
    }
    return best?.dataset.padCard ?? from;
}

function LibrarySidebar(props: {
    open?: boolean,
    section: Section,
    counts: { all: number, favorites: number, unmatched: number },
    // once Planet VB has answered
    catalogCounts?: Record<CatalogFilter, number>,
    // undefined when that shelf is off
    recents?: number,
    onSection: (section: Section) => void,
    onManage: () => void,
    onPick: () => void,
    onOpenUrl: () => void,
    busy?: boolean,
}): React.JSX.Element {
    const { section } = props;
    const current = (kind: Section['kind']): boolean => section.kind === kind;

    return <aside className={'vp-library-side vp-scroll' + (props.open ? ' open' : '')}>
        <h3 className='vp-library-group'>
            {nls.localize('vueport/library/library', 'Library')}
        </h3>
        {/* above the games, where a returning user looks first */}
        {props.recents !== undefined && <button
            className={`vp-library-nav${current('recent') ? ' selected' : ''}`}
            onClick={() => props.onSection({ kind: 'recent' })}
        >
            <ClockCounterClockwise size={16} />
            <span className='vp-library-nav-name'>
                {nls.localize('vueport/library/recentlyPlayed', 'Recently Played')}
            </span>
            <span className='vp-library-nav-count'>{props.recents}</span>
        </button>}
        <button
            className={`vp-library-nav${current('all') ? ' selected' : ''}`}
            onClick={() => props.onSection({ kind: 'all' })}
        >
            <SquaresFour size={16} />
            <span className='vp-library-nav-name'>
                {nls.localize('vueport/library/allGames', 'All Games')}
            </span>
            <span className='vp-library-nav-count'>{props.counts.all}</span>
        </button>
        {/* always here, dimmed while nothing is starred, as an entry that appears on first use is never found */}
        <button
            className={'vp-library-nav'
                + (props.counts.favorites === 0 ? ' dim' : '')
                + (current('favorites') ? ' selected' : '')}
            onClick={() => props.onSection({ kind: 'favorites' })}
        >
            <Star size={16} />
            <span className='vp-library-nav-name'>
                {nls.localize('vueport/library/favorites', 'Favorites')}
            </span>
            <span className='vp-library-nav-count'>{props.counts.favorites}</span>
        </button>
        {props.counts.unmatched > 0 && <button
            className={`vp-library-nav${current('unmatched') ? ' selected' : ''}`}
            onClick={() => props.onSection({ kind: 'unmatched' })}
        >
            <Question size={16} />
            <span className='vp-library-nav-name'>
                {nls.localize('vueport/library/unmatched', 'Unmatched')}
            </span>
            <span className='vp-library-nav-count'>{props.counts.unmatched}</span>
        </button>}

        {/* the folders are a setting of this machine, fully covered by the Library pane, so the column has one row
            leading there instead of a second, poorer list */}
        <button className='vp-library-nav dim' onClick={props.onManage}>
            <SlidersHorizontal size={16} />
            <span className='vp-library-nav-name'>
                {nls.localize('vueport/library/manage', 'Manage')}
            </span>
        </button>

        {/* both entries are the same listing seen two ways */}
        <h3 className='vp-library-group'>Planet Virtual Boy</h3>
        {(['featured', 'archive'] as const).map(filter => <button
            key={filter}
            className={'vp-library-nav'
                + (section.kind === 'planetvb' && section.filter === filter ? ' selected' : '')}
            onClick={() => props.onSection({ kind: 'planetvb', filter })}
        >
            {catalogIcon(filter)}
            <span className='vp-library-nav-name'>{catalogName(filter)}</span>
            {props.catalogCounts && <span className='vp-library-nav-count'>
                {props.catalogCounts[filter]}
            </span>}
        </button>)}

        <div className='vp-library-side-foot'>
            <button className='vp-button' onClick={props.onPick} disabled={props.busy}>
                <FileArrowUp size={16} />
                {props.busy
                    ? nls.localize('vueport/rom/downloading', 'Downloading ROM…')
                    : nls.localize('vueport/library/openRom', 'Open ROM…')}
            </button>
            {/* a quiet line of text under the button; the prompt explains itself, see askForLink */}
            <button
                type='button'
                className='vp-library-nav dim'
                onClick={props.onOpenUrl}
                disabled={props.busy}
            >
                <LinkSimple size={15} />
                {nls.localize('vueport/library/fromLink/label', 'From a link…')}
            </button>
        </div>
    </aside>;
}

// pills combine with "and" (Action and 1995 is the action games of 1995), values within a pill with "or", as "Action,
// Puzzle" matches either
function passes(card: Card, filters: ShelfFilters): boolean {
    if (filters.genre !== undefined && !parts(card.genre).includes(filters.genre)) {
        return false;
    }
    if (filters.year !== undefined && card.year !== filters.year) {
        return false;
    }
    if (filters.players !== undefined && card.players !== filters.players) {
        return false;
    }
    if (filters.region !== undefined && !parts(card.region).includes(filters.region)) {
        return false;
    }
    if (filters.kind !== undefined && kindKey(card.kind) !== filters.kind) {
        return false;
    }
    if (filters.saved && !card.hasSave) {
        return false;
    }
    return true;
}

/**
 * The filter bar under the shelf's name. Its lists are the whole shelf's values, not what the other pills left, as a
 * menu that empties as it's used has to be undone. A pill with nothing to offer is dimmed rather than dropped, as a
 * control that appears only when it would work is never found, and the heading would move about.
 */
function FilterBar(props: {
    cards: Card[],
    filters: ShelfFilters,
    onChange: (filters: ShelfFilters) => void,
    // Planet VB's shelf only: its cards are filled in a few at a time, so for a while the pills know only part of the
    // archive and say so
    filling?: boolean,
}): React.JSX.Element {
    const { cards, filters } = props;
    const set = (field: keyof ShelfFilters, value: string | boolean | undefined): void =>
        props.onChange({ ...filters, [field]: value });

    const genres = React.useMemo(() => facet(cards, card => parts(card.genre)), [cards]);
    const players = React.useMemo(() => facet(cards, card => [card.players ?? '']), [cards]);
    const regions = React.useMemo(() => facet(cards, card => parts(card.region)), [cards]);
    const kinds = React.useMemo(() => facet(cards, card => [kindKey(card.kind)]), [cards]);
    // newest first, the one list nobody reads alphabetically; four digits, so they sort as text
    const years = React.useMemo(
        () => facet(cards, card => [card.year ?? '']).reverse(), [cards]);
    // only offered where there are saves, or the switch would empty the shelf and look broken
    const saves = React.useMemo(() => cards.some(card => card.hasSave), [cards]);

    return <div className='vp-library-filters'>
        <FilterPill
            field='genre'
            name={nls.localize('vueport/library/genre', 'Genre')}
            all={nls.localize('vueport/library/filter/anyGenre', 'Any genre')}
            options={genres}
            value={filters.genre}
            onChange={value => set('genre', value)}
        />
        <FilterPill
            field='year'
            name={nls.localize('vueport/library/year', 'Year')}
            all={nls.localize('vueport/library/filter/anyYear', 'Any year')}
            options={years}
            value={filters.year}
            onChange={value => set('year', value)}
        />
        <FilterPill
            field='players'
            name={nls.localize('vueport/library/players', 'Players')}
            all={nls.localize('vueport/library/filter/anyPlayers', 'Any number of players')}
            options={players}
            value={filters.players}
            onChange={value => set('players', value)}
        />
        <FilterPill
            field='region'
            name={nls.localize('vueport/library/region', 'Region')}
            all={nls.localize('vueport/library/filter/anyRegion', 'Any region')}
            options={regions}
            value={filters.region}
            onChange={value => set('region', value)}
        />
        <FilterPill
            field='kind'
            name={nls.localize('vueport/library/type', 'Type')}
            all={nls.localize('vueport/library/filter/anyType', 'All types')}
            options={kinds}
            display={kindName}
            value={filters.kind}
            onChange={value => set('kind', value)}
        />
        <span className='vp-library-filters-reset'>
            <ResetButton disabled={!anyFilter(filters)} onReset={() => props.onChange({})} />
        </span>
        {props.filling && <span
            className='vp-hint vp-library-filling'
            title={nls.localize('vueport/library/fillingWhy',
                'Planet VB is still being asked about the rest of the archive. These lists \
grow as it answers.')}
        >{nls.localize('vueport/library/filling', 'filling in…')}</span>}
        {/* games with save data: a switch at the end of the bar rather than a sixth menu, as only one answer is
            worth asking for */}
        <button
            type='button'
            className={`vp-library-toggle${filters.saved ? ' on' : ''}`}
            // never while it's on: a remembered switch over a shelf that lost its saves must still be switchable off
            disabled={!saves && !filters.saved}
            aria-pressed={filters.saved === true}
            onClick={() => set('saved', filters.saved ? undefined : true)}
            title={saves
                ? undefined
                : nls.localize('vueport/library/noSavesYet',
                    'Nothing in the library has been saved yet.')}
        >
            <FloppyDisk size={15} />
            {nls.localize('vueport/library/hasSave', 'Has save data')}
        </button>
    </div>;
}

// "nothing chosen" has to be a value the menu doesn't hold, so the control falls back to its own name (Genre rather
// than the longer Any genre row); no genre, year, region or type is spelled with an asterisk
const ANY = '*';

function FilterPill(props: {
    // the field it narrows, also what tests find it by
    field: string,
    name: string,
    all: string,
    options: string[],
    display?: (value: string) => string,
    value?: string,
    onChange: (value: string | undefined) => void,
}): React.JSX.Element {
    const show = props.display ?? ((value: string) => value);
    // a set value the shelf doesn't offer is still listed, as remembered filters can arrive before the shelf knows the
    // value (Planet VB fills genres gradually) or outlive the last game with it; hiding it would leave no way back
    const options = props.value !== undefined && !props.options.includes(props.value)
        ? [props.value, ...props.options]
        : props.options;
    return <Select
        className={`vp-library-pill pill-${props.field}${props.value !== undefined ? ' on' : ''}`}
        size='small'
        menuWidth='content'
        value={props.value ?? ''}
        placeholder={props.name}
        label={props.name}
        disabled={options.length === 0}
        onChange={next => props.onChange(next === ANY ? undefined : next)}
        options={[
            { value: ANY, label: props.all },
            ...options.map(value => ({ value, label: show(value) })),
        ]}
    />;
}

function Grid(props: {
    cards: Card[],
    // see useArrivals
    arrangement: string,
    onOpen: (id: string) => void,
    actions: CardActions,
}): React.JSX.Element {
    const grid = React.useRef<HTMLDivElement>(null);
    useArrivals(grid, props.cards, props.arrangement);
    // backs are only rendered once the user flips a cover, and then kept, so flipping back still has something to
    // animate
    const [flipped, setFlipped] = React.useState<ReadonlySet<string>>(() => new Set());
    const [turned, setTurned] = React.useState<ReadonlySet<string>>(() => new Set());
    const flip = (id: string): void => {
        setTurned(current => current.has(id) ? current : new Set(current).add(id));
        setFlipped(current => {
            const next = new Set(current);
            if (!next.delete(id)) {
                next.add(id);
            }
            return next;
        });
    };
    // a card is a box holding the button that opens the game and, beside it, the play buttons, as a button can't
    // contain another. The box takes the click too, so anywhere on the card opens the page; the play buttons stop
    // theirs
    return <div className='vp-library-grid' ref={grid}>
        {props.cards.map(card => <div
            key={card.id}
            className='vp-library-card'
            data-pad-card={card.id}
            onClick={() => props.onOpen(card.id)}
        ><button type='button' className='vp-library-card-open' title={card.title}>
                <CardCover card={card} flipped={flipped.has(card.id)} withBack={turned.has(card.id)} />
                <span className='vp-library-card-marks'>
                    <ScoreBadge score={card.score} />
                    {card.kind && <span className='vp-library-card-kind'>
                        {kindName(card.kind)}
                    </span>}
                    {/* a cancelled cartridge is the one thing on the shelf that can't be played like the rest */}
                    {unreleased(card.status) && <span className='vp-library-card-unreleased'>
                        {nls.localize('vueport/library/unreleased', 'Unreleased')}
                    </span>}
                    <span className='vp-library-card-flags'>
                        {card.featured && <span
                            className='vp-library-card-featured'
                            title={nls.localize('vueport/library/featuredPick',
                                'A Planet VB featured pick')}
                        ><Medal size={15} weight='fill' /></span>}
                        {card.favorite && <span
                            className='vp-library-card-star'
                            title={nls.localize('vueport/library/starred', 'Starred')}
                        ><Star size={15} weight='fill' /></span>}
                    </span>
                </span>
                <span className='vp-library-card-title'>{card.title}</span>
                <span className='vp-hint vp-library-card-meta'>{card.meta}</span>
            </button>
            {/* the stylesheet sizes this layer to the square cover, so nothing is measured here */}
            <CardPlayButtons
                card={card}
                actions={props.actions}
                className='vp-library-card-actions'
                onDetails={() => props.onOpen(card.id)}
                onFlip={() => flip(card.id)}
                flipped={flipped.has(card.id)}
            />
        </div>)}
    </div>;
}

function CardCover(props: { card: Card, flipped: boolean, withBack: boolean }): React.JSX.Element {
    const { card } = props;
    return <span className='vp-library-card-cover'>
        <span className={`vp-library-card-turn${props.flipped ? ' flipped' : ''}`}>
            <span className='vp-library-card-face front' aria-hidden={props.flipped}>
                <LibraryCover cover={card.cover} />
            </span>
            {props.withBack && <span className='vp-library-card-face back' aria-hidden={!props.flipped}>
                <PrintedFace face='back' src={card.box?.back} pictureClassName='vp-library-card-back'>
                    <BoxBackPrint card={card} />
                </PrintedFace>
            </span>}
        </span>
    </span>;
}

/**
 * Each card rises into place the first time it scrolls into view, staggered within the batch that just appeared, so
 * every wave stays short; counting from the top of the shelf would keep the last of hundreds waiting. Narrowing the
 * shelf keeps arrived cards arrived. Another shelf or another order is a new arrangement and arrives again from the
 * top, as a sort that moved only some cards would tell half the story, and moved cards would restart from their old
 * place in the wave.
 */
function useArrivals(
    grid: React.RefObject<HTMLDivElement | null>,
    cards: readonly unknown[],
    arrangement: string,
): void {
    const observer = React.useRef<IntersectionObserver>();

    // a layout effect, like the one below, so the observer is there by the time the first cards are handed to it
    React.useLayoutEffect(() => {
        const seen = new IntersectionObserver(entries => {
            const coming = entries
                .filter(entry => entry.isIntersecting)
                .map(entry => entry.target as HTMLElement)
                .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
            coming.forEach((card, index) => {
                seen.unobserve(card);
                card.style.setProperty('--vp-arrival', String(Math.min(index, ARRIVAL_WAVE)));
                card.classList.add('arrived');
            });
        });
        observer.current = seen;
        return () => seen.disconnect();
    }, []);

    // before paint, so the old arrangement's cards never show in their new places for a frame
    const shown = React.useRef(arrangement);
    React.useLayoutEffect(() => {
        const again = shown.current !== arrangement;
        shown.current = arrangement;
        for (const card of Array.from(grid.current?.children ?? [])) {
            if (again) {
                card.classList.remove('arrived');
            }
            if (!card.classList.contains('arrived')) {
                observer.current?.observe(card);
            }
        }
    }, [cards, arrangement]);
}

// the most cards one wave staggers; any further ones land with the last
const ARRIVAL_WAVE = 24;

function List(props: {
    cards: Card[],
    onOpen: (id: string) => void,
    actions: CardActions,
}): React.JSX.Element {
    return <div className='vp-library-list'>
        <table>
            <thead>
                <tr>
                    <th>{nls.localize('vueport/status/title', 'Title')}</th>
                    <th>{nls.localize('vueport/library/developer', 'Developer')}</th>
                    <th>{nls.localize('vueport/library/year', 'Year')}</th>
                    <th>{nls.localize('vueport/library/genre', 'Genre')}</th>
                    <th>{nls.localize('vueport/library/players', 'Players')}</th>
                    <th>{nls.localize('vueport/status/size', 'Size')}</th>
                    <th>{nls.localize('vueport/library/plays', 'Plays')}</th>
                    <th>{nls.localize('vueport/library/playTime', 'Play time')}</th>
                    <th className='score'>{nls.localize('vueport/library/score', 'Score')}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                {/* the whole row opens the game, as a click three columns along means that row's game. The title stays
                    a real button for the keyboard, which a <tr> with a handler never is; clicks on buttons stay
                    theirs */}
                {props.cards.map(card => <tr
                    key={card.id}
                    data-pad-card={card.id}
                    onClick={event => {
                        if (!(event.target as HTMLElement).closest('button')) {
                            props.onOpen(card.id);
                        }
                    }}
                >
                    <td>
                        <button className='vp-library-row' onClick={() => props.onOpen(card.id)}>
                            <LibraryCover cover={card.cover} className='thumb' />
                            <span className='vp-library-row-name'>{card.title}</span>
                        </button>
                    </td>
                    <td>{card.developer ?? '—'}</td>
                    <td className='number'>{card.year ?? '—'}</td>
                    <td>{card.genre ?? '—'}</td>
                    <td className='number'>{card.players ?? '—'}</td>
                    <td className='number'>{card.size ?? '—'}</td>
                    <td className='number'>{card.playCount ?? '—'}</td>
                    <td>{card.playMs !== undefined ? playTimeLabel(card.playMs) : '—'}</td>
                    {/* an empty cell rather than a dash where the catalog has no rating */}
                    <td className='score'><ScoreBadge score={card.score} /></td>
                    <td className='vp-library-row-actions'>
                        <CardPlayButtons card={card} actions={props.actions} className='vp-library-row-play' size={15} />
                        <button
                            className='vp-library-info inline'
                            data-pad-action
                            onClick={() => props.onOpen(card.id)}
                            title={nls.localize('vueport/library/details', 'Details')}
                            aria-label={nls.localize('vueport/library/details', 'Details')}
                        ><Info size={15} /></button>
                    </td>
                </tr>)}
            </tbody>
        </table>
    </div>;
}

function CatalogShelfView(props: {
    cards: Card[],
    arrangement: string,
    view: LibraryView,
    size: CoverSize,
    loading: boolean,
    failed: boolean,
    searching: boolean,
    onRetry: () => void,
    onOpen: (id: string) => void,
    actions: CardActions,
}): React.JSX.Element {
    if (props.failed) {
        return <div className='vp-library-empty small'>
            <p className='vp-hint'>
                {nls.localize('vueport/homebrew/unreachable',
                    'Planet VB could not be reached.')}
                {' '}
                <button className='vp-homebrew-retry' onClick={props.onRetry}>
                    {nls.localize('vueport/homebrew/retry', 'Try again')}
                </button>
            </p>
        </div>;
    }
    if (props.loading) {
        return <div className='vp-library-empty small'>
            <p className='vp-hint'>
                {nls.localize('vueport/library/loadingCatalog', 'Loading…')}
            </p>
        </div>;
    }
    if (props.cards.length === 0) {
        return <div className='vp-library-empty small'>
            <p className='vp-hint'>
                {props.searching
                    ? nls.localize('vueport/library/noMatches', 'Nothing in the library matches that.')
                    : nls.localize('vueport/homebrew/empty', 'The catalog came back empty.')}
            </p>
        </div>;
    }
    return <Shelf view={props.view} size={props.size}>
        {props.view === 'grid'
            ? <Grid
                cards={props.cards}
                arrangement={props.arrangement}
                onOpen={props.onOpen}
                actions={props.actions}
            />
            : props.view === 'list'
                ? <List cards={props.cards} onOpen={props.onOpen} actions={props.actions} />
                : <Coverflow cards={props.cards} onOpen={props.onOpen} actions={props.actions} />}
    </Shelf>;
}

// the flat views are a scrolling column; the coverflow is a stage dragged sideways, where a scrollbar would scroll
// nothing and the grid's edge padding is the room the turned covers need
function Shelf(props: {
    view: LibraryView,
    size: CoverSize,
    children: React.ReactNode,
}): React.JSX.Element {
    const flowing = props.view === 'coverflow';
    return <div
        className={`vp-library-shelf${flowing ? ' flowing' : ' vp-scroll'}`}
        data-size={props.size}
    >{props.children}</div>;
}

function LocalGamePage(props: {
    game: LibraryGame,
    onBack: () => void,
    onPlay: (entry: LibraryEntry, file?: LibraryFile, resume?: boolean) => void,
    onEdit: () => void,
    onEditRom: (rom: LibraryRom) => void,
    onPrefer: (rom: LibraryRom) => void,
    onFavorite: () => void,
    onRefresh: () => void,
    refreshing: boolean,
    onRemove: () => void,
    onShare?: () => void,
    onShareRom?: (rom: LibraryRom) => void,
}): React.JSX.Element {
    const { game } = props;
    const { resumable } = game;

    // one row per file, not per dump, as the same ROM in two folders is two things to start and which one runs decides
    // where its save goes. Named by the dump's given name, otherwise the file's, so two copies can be told apart
    const roms: GamePageRom[] = game.roms.flatMap(rom => rom.entry.files.map(file => ({
        id: `${rom.entry.id}/${file.folderId}/${file.path}/${file.archiveEntry ?? ''}`,
        title: rom.title ?? romFileName(file),
        // the file name on the tile's second line (the archive entry's, as that is what runs), only where the first
        // line isn't already that name; path, folder and checksum are in the dump's own editor
        file: rom.title ? romFileName(file) : undefined,
        detail: [
            rom.region || undefined,
            megabits(file.bytes),
            // which dump the play time went into, only with more than one dump, or it repeats the head's line
            game.roms.length > 1 && rom.play
                ? nls.localize('vueport/library/playedFor', '{0} played', playTimeLabel(rom.play.ms))
                : undefined,
        ].filter(Boolean).join(' · '),
        tag: rom.latest
            ? nls.localize('vueport/library/latest', 'Latest')
            : undefined,
        // the choice is between dumps, not copies of one, so both rows of the same ROM carry the mark
        preferred: rom.preferred,
        onPrefer: rom.preferred
            ? undefined
            : () => { props.onPrefer(rom); },
        onPlay: () => props.onPlay(rom.entry, file),
        onResume: rom.suspended.includes(file)
            ? () => props.onPlay(rom.entry, file, true)
            : undefined,
        onEdit: () => props.onEditRom(rom),
        onShare: props.onShareRom && (() => props.onShareRom?.(rom)),
    })));

    return <GamePage
        onShare={props.onShare}
        title={game.title}
        credit={[game.developer, year(game.released), game.genre, game.players]
            .filter(Boolean).join(' · ')}
        playLine={game.play && nls.localize(
            'vueport/library/playLine', 'Played {0} · {1} · last played {2}',
            playCountLabel(game.play.count),
            playTimeLabel(game.play.ms),
            relativeTime(game.play.lastPlayedAt))}
        tags={[
            {
                label: nls.localize('vueport/library/inYourLibrary', 'In your library'),
                tone: 'live' as const,
            },
            ...(game.own
                ? [{ label: nls.localize('vueport/library/ownGame', 'Made here') }]
                : []),
            ...(game.unmatched
                ? [{ label: nls.localize('vueport/library/unmatched', 'Unmatched'), tone: 'warn' as const }]
                : []),
            // a dump the catalog never saw, filed here by its file name. Shown openly with the catalog's name match
            // score, as the rest of the page is only right if the guess was
            ...(game.titleMatch !== undefined
                ? [{
                    label: nls.localize('vueport/library/nameMatch',
                        'Matched by name · {0}%', Math.round(game.titleMatch)),
                    tone: 'warn' as const,
                }]
                : []),
        ]}
        marks={{
            score: game.score,
            kind: game.kind ? kindName(game.kind) : undefined,
            unreleased: unreleased(game.status),
        }}
        description={game.description}
        notes={game.notes}
        coverUrl={game.catalogCoverUrl}
        ownCoverUrl={game.ownCoverUrl}
        backdropUrl={game.ownBackground ? game.ownBackgroundUrl : game.catalogBackgroundUrl}
        planetVbUrl={game.planetVbUrl}
        facts={[
            ...(game.edited.includes('title')
                ? [{
                    label: nls.localize('vueport/status/title', 'Title'),
                    value: game.title,
                    edited: true,
                }]
                : []),
            { label: nls.localize('vueport/library/developer', 'Developer'), value: game.developer ?? '', edited: game.edited.includes('developer') },
            { label: nls.localize('vueport/library/publisher', 'Publisher'), value: game.publisher ?? '', edited: game.edited.includes('publisher') },
            {
                label: nls.localize('vueport/library/year', 'Year'),
                value: year(game.released) ?? '',
                edited: game.edited.includes('released'),
            },
            { label: nls.localize('vueport/library/genre', 'Genre'), value: game.genre ?? '', edited: game.edited.includes('genre') },
            { label: nls.localize('vueport/library/players', 'Players'), value: game.players ?? '', edited: game.edited.includes('players') },
            { label: nls.localize('vueport/library/region', 'Region'), value: game.region ?? '', edited: game.edited.includes('region') },
        ]}
        roms={roms}
        romsTitle={nls.localize('vueport/library/romsTitle', 'ROMs')}
        emptyNote={game.own
            ? nls.localize('vueport/library/noRomsFiled',
                'Nothing is filed under this game yet. Open a ROM elsewhere in the library, \
edit it, and file it here.')
            : undefined}
        favorite={game.favorite}
        onFavorite={props.onFavorite}
        onBack={props.onBack}
        onResume={resumable
            ? () => props.onPlay(resumable.rom.entry, resumable.file, true)
            : undefined}
        onEdit={props.onEdit}
        onRefresh={game.own || game.roms.length === 0 ? undefined : props.onRefresh}
        refreshing={props.refreshing}
        onRemove={props.onRemove}
    />;
}

function CatalogPage(props: {
    game?: HomebrewGame,
    onBack: () => void,
    onPlay: (game: HomebrewGame, rom?: HomebrewRom) => void,
    onDetail: (game: HomebrewGame) => Promise<HomebrewGame>,
    importState: (rom: HomebrewRom) => ImportState,
    onImport: (game: HomebrewGame, roms: HomebrewRom[]) => void,
}): React.JSX.Element {
    const { game } = props;
    const [detailed, setDetailed] = React.useState<HomebrewGame | undefined>(game);

    // read through a ref, so the effect below runs when the game changes and not when the shelf re-renders around it
    const ask = React.useRef(props.onDetail);
    ask.current = props.onDetail;

    // the listing gives a title, a cover and a blurb; credits and the ROM's address take one request per game, made
    // when the user opens it
    const id = game?.id;
    React.useEffect(() => {
        if (!game) {
            return undefined;
        }
        let live = true;
        setDetailed(game);
        ask.current(game).then(full => { if (live) { setDetailed(full); } }).catch(() => undefined);
        return () => { live = false; };
    }, [id]);

    const shown = detailed ?? game;
    if (!shown) {
        return <div className='vp-library-empty small'>
            <p className='vp-hint'>
                {nls.localize('vueport/library/loadingCatalog', 'Loading…')}
            </p>
        </div>;
    }

    // when nothing the listing gave resolves to a downloads group, the group named in the game's own detail is offered
    // as its one release rather than withheld, see releasesOf
    const releases = releasesOf(shown);
    const states = releases.map(rom => props.importState(rom));
    const roms: GamePageRom[] = releases
        .map((rom, at) => ({
            id: rom.id,
            title: rom.title,
            detail: [releaseDate(rom.date)].filter(Boolean).join(' · '),
            tag: rom.latest
                ? nls.localize('vueport/library/latest', 'Latest')
                : undefined,
            latest: rom.latest,
            onPlay: () => props.onPlay(shown, rom),
            onImport: () => props.onImport(shown, [rom]),
            importState: states[at],
        }));

    return <GamePage
        title={shown.title}
        credit={[shown.developer, shown.year, shown.genre, shown.players && nls.localize(
            'vueport/library/playerCount', '{0} players', shown.players)]
            .filter(Boolean).join(' · ')}
        // no fixed "Homebrew" tag, which was wrong on every tech demo; the badge below the credit shows what the
        // catalog files it under
        tags={[]}
        marks={{
            score: shown.score,
            kind: shown.kind ? kindName(shown.kind) : undefined,
            unreleased: unreleased(shown.status),
        }}
        description={shown.blurb || undefined}
        coverUrl={shown.coverUrl}
        backdropUrl={shown.backgroundUrl}
        planetVbUrl={shown.planetVbUrl}
        facts={[
            { label: nls.localize('vueport/library/developer', 'Developer'), value: shown.developer ?? '' },
            { label: nls.localize('vueport/library/year', 'Year'), value: shown.year ?? '' },
            { label: nls.localize('vueport/library/genre', 'Genre'), value: shown.genre ?? '' },
            { label: nls.localize('vueport/library/players', 'Players'), value: shown.players ?? '' },
            { label: nls.localize('vueport/library/romsTitle', 'ROMs'), value: String(roms.length) },
        ]}
        roms={roms}
        romsTitle={nls.localize('vueport/library/romsTitle', 'ROMs')}
        loading={detailed === undefined}
        onBack={props.onBack}
        onImportAll={() => props.onImport(shown,
            releases.filter((_, at) => states[at] === 'none'))}
        importAllState={states.every(state => state === 'done')
            ? 'done'
            : states.some(state => state === 'none') ? 'none' : 'busy'}
    />;
}

function releaseState(library: Library, id: string): ImportState {
    return library.hasRelease(id) ? 'done' : library.isImportingRelease(id) ? 'busy' : 'none';
}

function ImportShownButton(props: {
    className?: string,
    library: Library,
    games: HomebrewGame[],
    onImport: () => void,
}): React.JSX.Element | null {
    const states = props.games.flatMap(game =>
        releasesOf(game).map(rom => releaseState(props.library, rom.id)));
    const waiting = states.filter(state => state === 'none').length;
    if (states.length === 0 || states.every(state => state === 'done')) {
        return null;
    }
    const busy = waiting === 0;
    const label = nls.localize('vueport/library/import/shownHint',
        'Download every ROM of the games on this shelf into the library');
    return <button
        type='button'
        className={`vp-button secondary vp-library-import${busy ? ' busy' : ''}${props.className ? ` ${props.className}` : ''}`}
        disabled={busy}
        onClick={props.onImport}
        title={label}
        aria-label={label}
    >
        <DownloadSimple size={15} />
        {busy
            ? nls.localize('vueport/library/import/running', 'Importing…')
            : nls.localize('vueport/library/import/shown', 'Import all ({0})', waiting)}
    </button>;
}

function reportImport(ui: WebUi, result: LibraryReleaseResult): void {
    if (result.outOfSpace) {
        ui.toast('error', nls.localize('vueport/library/import/noSpaceForRoms',
            'The browser has no room left for more ROMs. {0} were imported before it ran out.',
            result.added));
        return;
    }
    if (result.failed.length > 0) {
        const named = result.failed.slice(0, 3).join(', ')
            + (result.failed.length > 3 ? ` +${result.failed.length - 3}` : '');
        ui.toast('warn', nls.localize('vueport/library/import/partly',
            '{0} imported; {1} could not be downloaded: {2}', result.added, result.failed.length, named));
        return;
    }
    if (result.stopped) {
        ui.toast('info', nls.localize('vueport/library/import/stopped',
            'Import stopped — {0} imported.', result.added));
        return;
    }
    if (result.added > 0) {
        ui.toast('info', result.added === 1
            ? nls.localize('vueport/library/import/doneOne', 'Imported into the library.')
            : nls.localize('vueport/library/import/doneMany', '{0} ROMs imported into the library.', result.added));
    }
}

/**
 * What was open last, as a shelf of its own, newest first. Clearing the list stays a command in the palette, beside
 * "Continue Recently Opened...", as it is a rare, destructive action. Cards are wider than a cover and show the game's
 * last frame, as a ROM from a file or link has no box art and where the user stopped is the better handle.
 */
function RecentShelf(props: {
    recents: RecentRom[],
    searching: boolean,
    onOpen: (rom: RecentRom) => void,
    onForget: (id: string) => void,
}): React.JSX.Element {
    if (props.recents.length === 0) {
        // the kit's empty state, as everywhere else. No button under it, as this shelf fills from playing and both ways
        // to start something are at the foot of the column
        return <div className='vp-library-blank'>
            {props.searching
                ? <EmptyContainer
                    icon={<MagnifyingGlass size={32} />}
                    title={nls.localize('vueport/library/noMatches',
                        'Nothing in the library matches that.')}
                />
                : <EmptyContainer
                    icon={<ClockCounterClockwise size={32} />}
                    title={nls.localize('vueport/library/nothingPlayed',
                        'Nothing has been opened yet')}
                    description={nls.localize('vueport/library/nothingPlayedHint',
                        'Whatever you play turns up here.')}
                />}
        </div>;
    }
    return <RecentRow recents={props.recents} onOpen={props.onOpen} onForget={props.onForget} />;
}

function RecentRow(props: {
    recents: RecentRom[],
    onOpen: (rom: RecentRom) => void,
    onForget: (id: string) => void,
}): React.JSX.Element {
    // a single arrangement key, as the shelf has one order; a game played again moves to the front and arrives as one
    // new card
    const row = React.useRef<HTMLDivElement>(null);
    useArrivals(row, props.recents, 'recent');
    return <div className='vp-library-shelf vp-scroll'>
        <div className='vp-library-recent-row' ref={row}>
            {props.recents.map(rom => <div
                key={rom.id}
                className='vp-library-recent-card'
                data-pad-card={rom.id}
            >
                <button onClick={() => props.onOpen(rom)} title={recentName(rom)}>
                    <span className='vp-library-recent-art'>
                        {rom.thumbnail
                            ? <RecentFrame src={rom.thumbnail} />
                            : <span className='vp-library-recent-blank' aria-hidden='true' />}
                    </span>
                    <span className='vp-library-card-title'>{romStem(recentName(rom))}</span>
                    <span className='vp-hint vp-library-card-meta'>{recentDetail(rom)}</span>
                </button>
                <button
                    className='vp-library-recent-forget'
                    onClick={() => props.onForget(rom.id)}
                    title={nls.localize('vueport/welcome/forget', 'Remove from this list')}
                    aria-label={nls.localize('vueport/welcome/forget', 'Remove from this list')}
                ><X size={13} /></button>
            </div>)}
        </div>
    </div>;
}

function RecentFrame(props: { src: string }): React.JSX.Element {
    const { image, loaded, onLoad } = usePictureArrival(props.src);
    return <img ref={image} className={loaded ? undefined : 'arriving'} src={props.src} alt='' onLoad={onLoad} />;
}

function FirstRun(props: {
    onAddFolder: () => void,
    // only changes the wording: calling it "Add" in a browser about to copy half a gigabyte would describe the wrong
    // operation (see addFolder)
    canLink: boolean,
    onPick: () => void,
    onCatalog: () => void,
}): React.JSX.Element {
    const invite = nls.localize('vueport/library/emptyMessage',
        'Point VUEPort at the folder your ROMs live in.');
    const privacy = nls.localize('vueport/library/privacy',
        'Everything stays on this machine, only ROM checksums or titles are sent to Planet VB for lookup.');

    return <div className='vp-library-blank'>
        <EmptyContainer
            icon={<Books size={32} />}
            title={nls.localize('vueport/library/emptyTitle', 'Your library is empty')}
            description={`${invite} ${privacy}`}
            actions={[
                {
                    label: props.canLink
                        ? nls.localize('vueport/library/addFolder', 'Add a folder…')
                        : nls.localize('vueport/library/import/folder', 'Import a folder…'),
                    icon: <Plus size={16} />,
                    primary: true,
                    onClick: props.onAddFolder,
                },
                {
                    label: nls.localize('vueport/library/openRom', 'Open ROM…'),
                    icon: <FileArrowUp size={16} />,
                    onClick: props.onPick,
                },
                {
                    label: nls.localize('vueport/library/browseCatalog', 'Browse Planet VB'),
                    icon: <Archive size={16} />,
                    onClick: props.onCatalog,
                },
            ]}
        />
    </div>;
}

function NothingHere(props: {
    section: Section,
    // narrowed by search or a filter: the shelf has games but none passed, so offering to re-read the folders would
    // send the user after a problem they don't have
    narrowed: boolean,
    reading: boolean,
    onReadAgain: () => void,
    onSubfolders: () => void,
    onManage: () => void,
}): React.JSX.Element {
    if (props.narrowed) {
        return <div className='vp-library-empty small'>
            <p className='vp-hint'>
                {nls.localize('vueport/library/noMatches', 'Nothing in the library matches that.')}
            </p>
        </div>;
    }
    if (props.reading) {
        return <div className='vp-library-empty small'>
            <p className='vp-hint'>{nls.localize('vueport/library/reading', 'Reading…')}</p>
        </div>;
    }
    if (props.section.kind === 'favorites') {
        return <div className='vp-library-blank'>
            <EmptyContainer
                icon={<Star size={32} />}
                title={nls.localize('vueport/library/noFavorites', 'Nothing starred yet')}
                description={nls.localize('vueport/library/noFavoritesHint',
                    'Open a game and press the star beside Play. What you star turns up here, \
and wears one on its cover.')}
            />
        </div>;
    }
    if (props.section.kind === 'unmatched') {
        return <div className='vp-library-empty small'>
            <p className='vp-hint'>
                {nls.localize('vueport/library/allMatched', 'Planet VB knew every ROM in your folders.')}
            </p>
        </div>;
    }
    const yourFolders = nls.localize('vueport/library/yourFolders', 'your folders');
    return <div className='vp-library-empty small'>
        <div className='vp-library-invite'>
            <h3>
                <Warning size={18} />
                {nls.localize('vueport/library/nothingFound', 'Nothing here looked like a ROM')}
            </h3>
            <p className='vp-hint'>
                {nls.localize('vueport/library/nothingFoundMessage',
                    'Nothing in {0} is a .vb, .bin or .vbc, or a .vbz, .vb.zip or .zip holding one.',
                    yourFolders)}
            </p>
            {!scanSubfolders() && <p className='vp-hint'>
                {nls.localize('vueport/library/subfoldersOff',
                    'Looking inside subfolders is off. If your ROMs sit one level down, that is why.')}
            </p>}
            <div className='vp-library-invite-actions'>
                {scanSubfolders()
                    ? <button className='vp-button' onClick={props.onReadAgain}>
                        {nls.localize('vueport/library/readAgain', 'Read again')}
                    </button>
                    : <button className='vp-button' onClick={props.onSubfolders}>
                        {nls.localize('vueport/library/subfoldersOn', 'Look in subfolders and read again')}
                    </button>}
                <button className='vp-button secondary' onClick={props.onManage}>
                    {nls.localize('vueport/library/manageFolders', 'Manage folders…')}
                </button>
            </div>
        </div>
    </div>;
}

function ReadProgress(props: {
    folder?: LibraryFolderState,
    files: number,
    roms: number,
    // set while files are being copied or downloaded in rather than read
    copying?: { total: number },
    onStop: () => void,
}): React.JSX.Element {
    return <div className='vp-library-progress'>
        {props.copying ? <DownloadSimple size={15} /> : <ArrowsClockwise size={15} />}
        <span>
            {props.copying
                ? nls.localize('vueport/library/import/runningFolder',
                    'Importing into {0} — {1} of {2}',
                    props.folder?.name ?? '…', props.files, props.copying.total)
                : nls.localize('vueport/library/readingFolder',
                    'Reading {0} — {1} files, {2} ROMs so far',
                    props.folder?.name ?? '…', props.files, props.roms)}
        </span>
        <button className='vp-button secondary' onClick={props.onStop}>
            {nls.localize('vueport/library/stop', 'Stop')}
        </button>
    </div>;
}

function localCard(game: LibraryGame): Card {
    const credited = [game.developer, year(game.released)].filter(Boolean).join(' · ');
    const preferred = game.preferred?.entry;
    return {
        id: game.id,
        title: game.title,
        meta: credited || preferred?.header.name
            || (game.own
                ? nls.localize('vueport/library/noRomsYet', 'No ROMs filed under it yet')
                : nls.localize('vueport/library/noDetails', 'No catalog entry')),
        cover: { ownCoverUrl: game.ownCoverUrl, catalogCoverUrl: game.catalogCoverUrl },
        box: game.boxUrls,
        favorite: game.favorite,
        developer: game.developer,
        year: year(game.released),
        genre: game.genre,
        players: game.players,
        score: game.score,
        kind: game.kind,
        status: game.status,
        region: game.region,
        hasSave: game.hasSave,
        resumable: game.resumable !== undefined,
        size: preferred && megabits(preferred.bytes),
        // a game made here and left empty has no known age, so it sorts as new, where the user just put it
        addedAt: game.roms.length > 0
            ? Math.min(...game.roms.map(rom => rom.entry.addedAt))
            : Date.now(),
        playCount: game.play?.count,
        playMs: game.play?.ms,
        lastPlayedAt: game.play?.lastPlayedAt,
        searchable: [game.title, game.developer, game.publisher, game.genre, preferred?.header.name]
            .filter(Boolean).join(' ').toLowerCase(),
    };
}

function catalogCard(game: HomebrewGame): Card {
    const credited = [game.developer, game.year].filter(Boolean).join(' · ');
    return {
        id: `hb:${game.id}`,
        title: game.title,
        meta: credited || game.blurb
            || nls.localize('vueport/romInfo/kindHomebrew', 'Homebrew'),
        cover: { catalogCoverUrl: game.coverUrl },
        developer: game.developer,
        year: game.year,
        genre: game.genre,
        players: game.players,
        score: game.score,
        kind: game.kind,
        status: game.status,
        featured: game.featured,
        searchable: [game.title, game.developer, game.genre, game.blurb]
            .filter(Boolean).join(' ').toLowerCase(),
    };
}

function directionName(direction: SortDirection): string {
    return direction === 'asc'
        ? nls.localize('vueport/library/sort/ascending', 'Ascending order')
        : nls.localize('vueport/library/sort/descending', 'Descending order');
}

// each field compares ascending and is flipped by sign. The title tie-break stays outside that, so games of one year
// are alphabetical either way; a reversed tie-break reads as a shuffle
function comparator(sort: SortOrder, direction: SortDirection): (a: Card, b: Card) => number {
    const sign = direction === 'asc' ? 1 : -1;
    const byTitle = (a: Card, b: Card): number =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    if (sort === 'added') {
        return (a, b) => sign * ((a.addedAt ?? 0) - (b.addedAt ?? 0)) || byTitle(a, b);
    }
    if (sort === 'played') {
        return (a, b) => sign * ((a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0)) || byTitle(a, b);
    }
    if (sort === 'playTime') {
        return (a, b) => sign * ((a.playMs ?? 0) - (b.playMs ?? 0)) || byTitle(a, b);
    }
    if (sort === 'score') {
        return (a, b) => sign * ((a.score ?? 0) - (b.score ?? 0)) || byTitle(a, b);
    }
    if (sort === 'released') {
        return (a, b) => sign * (a.year ?? '').localeCompare(b.year ?? '') || byTitle(a, b);
    }
    return (a, b) => sign * byTitle(a, b);
}

// the archive entry's own name when it came out of one, as that is what runs. Just the name, not its folder
function romFileName(file: LibraryFile): string {
    return (file.archiveEntry ?? file.name).split('/').pop() ?? file.name;
}

// Planet VB writes dates as digits as far as known ("20081111", "200811", "2008"). Padded with question marks rather
// than zeroes, as a missing day isn't the first, and only the known parts are shown; undefined without even a year
function releaseDate(date?: string): string | undefined {
    const digits = (date ?? '').replace(/\D/g, '').padEnd(8, '?');
    // a part counts when its digits are a real year, month or day: "00" is the catalog's unknown month or day, and
    // February the 30th is not a date
    const number = (part: string, last: number): number | undefined => {
        const value = /^\d{2,4}$/.test(part) ? Number(part) : NaN;
        return value >= 1 && value <= last ? value : undefined;
    };
    const givenYear = number(digits.slice(0, 4), 9999);
    if (givenYear === undefined) {
        return undefined;
    }
    const month = number(digits.slice(4, 6), 12);
    if (month === undefined) {
        return digits.slice(0, 4);
    }
    // midday UTC, so a timezone behind still gets the catalog's day. A day the month lacks rolls into the next month,
    // which marks it invalid, and then only the month is shown
    const day = number(digits.slice(6, 8), 31);
    const onDay = day === undefined ? undefined : new Date(Date.UTC(givenYear, month - 1, day, 12));
    const whole = onDay !== undefined && onDay.getUTCMonth() === month - 1;
    return (whole ? onDay : new Date(Date.UTC(givenYear, month - 1, 1, 12)))
        .toLocaleDateString(undefined, whole
            ? { year: 'numeric', month: 'long', day: 'numeric' }
            : { year: 'numeric', month: 'long' });
}

function year(released?: string): string | undefined {
    return released?.match(/\d{4}/)?.[0] ?? released ?? undefined;
}

function sectionName(section: Section): string {
    switch (section.kind) {
        case 'recent':
            return nls.localize('vueport/library/recentlyPlayed', 'Recently Played');
        case 'favorites':
            return nls.localize('vueport/library/favorites', 'Favorites');
        case 'unmatched':
            return nls.localize('vueport/library/unmatched', 'Unmatched');
        case 'planetvb':
            return catalogName(section.filter);
        default:
            return nls.localize('vueport/library/allGames', 'All Games');
    }
}

function shelfLine(section: Section, of: {
    shown: number,
    recents: number,
    folders: LibraryFolderState[],
    reading: boolean,
}): string {
    switch (section.kind) {
        case 'recent':
            return nls.localize('vueport/library/recentCount', '{0} ROMs, newest first', of.recents);
        case 'favorites':
            return nls.localize('vueport/library/favoriteCount', '{0} games you starred', of.shown);
        case 'planetvb':
            return nls.localize(
                'vueport/library/catalogCount',
                '{0} games',
                of.shown
            );
        default:
            return summary(of.shown, of.folders, of.reading);
    }
}

function summary(shown: number, folders: LibraryFolderState[], reading: boolean): string {
    const games = nls.localize('vueport/library/gameCount', '{0} games', shown);
    const where = nls.localize('vueport/library/folderCount', '{0} folders', folders.length);
    return reading
        ? `${games} · ${where} · ${nls.localize('vueport/library/readingNow', 'reading…')}`
        : `${games} · ${where}`;
}

