import * as React from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, FolderOpen, Trash, Warning } from '@phosphor-icons/react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { pushEscapeLayer } from 'vueport-core/lib/browser/components/kit/escape-layers';
import { Library, LibraryClearOptions, LibraryStats, LibraryStoragePart, LibraryStorageUse } from './web-library';
import { playTimeLabel } from './web-play-time';
import { isDesktop } from './desktop-bridge';

// the weighing waits for a read to finish rather than chasing it

export function sizeLabel(bytes: number): string {
    const kb = bytes / 1024;
    if (kb < 1024) {
        return nls.localize('vueport/library/stats/kb', '{0} KB', Math.max(kb > 0 ? 1 : 0, Math.round(kb)));
    }
    const mb = kb / 1024;
    if (mb < 1024) {
        return nls.localize('vueport/library/stats/mb', '{0} MB', mb.toFixed(1));
    }
    return nls.localize('vueport/library/stats/gb', '{0} GB', (mb / 1024).toFixed(2));
}

// both strings come translated, as the nls keys must be written out at each call for the extractor to find
function counted(n: number, one: string, many: string): string {
    return n === 1 ? one : many;
}

// undefined until the first measurement; the caller decides when one is worth taking (see LibraryOverview's key)
function useStorageUse(library: Library, key: string | undefined): LibraryStorageUse | undefined {
    const [use, setUse] = React.useState<LibraryStorageUse | undefined>(undefined);
    React.useEffect(() => {
        if (key === undefined) {
            return;
        }
        let live = true;
        library.storageUse()
            .then(value => { if (live) { setUse(value); } })
            .catch(() => undefined);
        return () => { live = false; };
    }, [library, key]);
    return use;
}

// named for what the system calls the place it opens
function revealLabel(): string {
    // navigator.platform as web-bindings.ts reads it: deprecated, but still the one answer every webview gives
    // eslint-disable-next-line deprecation/deprecation
    const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
    if (/Mac/.test(platform)) {
        return nls.localize('vueport/library/stats/revealFinder', 'Show in Finder');
    }
    if (/Win/.test(platform)) {
        return nls.localize('vueport/library/stats/revealExplorer', 'Show in Explorer');
    }
    return nls.localize('vueport/library/stats/revealFolder', 'Open folder');
}

function Tile(props: { value: React.ReactNode, label: React.ReactNode, wide?: boolean }): React.JSX.Element {
    return <div className={props.wide ? 'vp-library-stat-tile wide' : 'vp-library-stat-tile'}>
        <span className='vp-library-stat-value'>{props.value}</span>
        <span className='vp-hint'>{props.label}</span>
    </div>;
}

// empty parts are left out of both
function Breakdown(props: {
    parts: Array<{
        key: string, value: number, color: string, label: React.ReactNode, detail?: React.ReactNode,
        amount?: React.ReactNode, action?: React.ReactNode
    }>,
    footer?: React.ReactNode,
}): React.JSX.Element {
    const parts = props.parts.filter(part => part.value > 0);
    return <>
        <div className='vp-library-stat-bar' aria-hidden='true'>
            {parts.map(part => <span key={part.key} style={{ flexGrow: part.value, background: part.color }} />)}
        </div>
        <div className='vp-library-stat-rows'>
            {parts.map(part => <React.Fragment key={part.key}>
                <span className='vp-library-stat-swatch' style={{ background: part.color }} />
                <span className='vp-library-stat-name'>
                    <span>{part.label}</span>
                    {part.detail && <span className='vp-hint'>{part.detail}</span>}
                </span>
                <span className='vp-library-stat-amount'>{part.amount}</span>
                <span className='vp-library-stat-action'>{part.action}</span>
            </React.Fragment>)}
            {props.footer && <div className='vp-library-stat-footer'>{props.footer}</div>}
        </div>
    </>;
}

// nothing while the library is empty, the Folders group underneath already says so
export function LibraryOverview(props: {
    library: Library,
    durable: boolean | undefined, // undefined on the desktop or while asking
    busy: boolean,
    lookUp: boolean,
}): React.JSX.Element | null {
    const { library } = props;
    const stats = library.stats();
    // measured again when the contents change, never while a read runs (the count changes on every file). `revision` is
    // for the buttons here that change what is stored without changing what is counted
    const [revision, bump] = React.useReducer((n: number) => n + 1, 0);
    const key = props.busy
        ? undefined
        : `${stats.folders}:${stats.roms}:${stats.editedGames}:${stats.byChecksum + stats.byName}:${revision}`;
    const use = useStorageUse(library, key);
    const [clearing, setClearing] = React.useState(false);

    if (stats.folders === 0 && stats.games === 0) {
        return null;
    }

    const total = use
        ? use.imported.bytes + use.art.bytes + use.covers.bytes + use.index.bytes + use.companions.bytes
        : undefined;

    return <>
        <fieldset>
            <legend>{nls.localize('vueport/library/stats/overview', 'Overview')}</legend>
            <div className='vp-library-stat-tiles'>
                <Tile
                    value={stats.games}
                    label={nls.localize('vueport/library/stats/games', 'Games')}
                />
                <Tile
                    value={stats.roms}
                    label={stats.files === stats.roms
                        ? nls.localize('vueport/library/stats/roms', 'ROMs')
                        : nls.localize('vueport/library/stats/romsFiles', 'ROMs · {0} files', stats.files)}
                />
                <Tile
                    wide
                    value={stats.playMs > 0 ? playTimeLabel(stats.playMs) : '—'}
                    label={nls.localize('vueport/library/stats/playedOf', 'Played · {0} of {1}', stats.played, stats.games)}
                />
            </div>
            <dl className='vp-library-stat-facts'>
                <dt className='vp-hint'>Planet VB</dt>
                <dd>
                    {[
                        nls.localize('vueport/library/stats/byChecksum', '{0} by checksum', stats.byChecksum),
                        stats.byName > 0
                        && nls.localize('vueport/library/stats/byName', '{0} by file name', stats.byName),
                        stats.notAsked > 0
                        && nls.localize('vueport/library/stats/notAsked', '{0} not asked yet', stats.notAsked),
                    ].filter(Boolean).join(' · ')}
                    {stats.unknown > 0 && <>
                        {' · '}
                        <span className='warn'>
                            {nls.localize('vueport/library/stats/unknown', '{0} unknown', stats.unknown)}
                        </span>
                        {props.lookUp && <>
                            {' · '}
                            <button
                                className='vp-library-stat-link'
                                onClick={() => { library.lookUpUnknown().catch(() => undefined); }}
                            >{nls.localize('vueport/library/stats/askAgain', 'Ask again')}</button>
                        </>}
                    </>}
                </dd>
                <dt className='vp-hint'>{nls.localize('vueport/library/stats/yours', 'Yours')}</dt>
                <dd>
                    {[
                        counted(
                            stats.favorites,
                            nls.localize('vueport/library/stats/favorites/one', '{0} favorite', stats.favorites),
                            nls.localize('vueport/library/stats/favorites/many', '{0} favorites', stats.favorites),
                        ),
                        counted(
                            stats.editedGames,
                            nls.localize('vueport/library/stats/editedGames/one', '{0} game edited', stats.editedGames),
                            nls.localize('vueport/library/stats/editedGames/many', '{0} games edited', stats.editedGames),
                        ),
                        stats.editedRoms > 0 && counted(
                            stats.editedRoms,
                            nls.localize('vueport/library/stats/editedRoms/one', '{0} ROM edited', stats.editedRoms),
                            nls.localize('vueport/library/stats/editedRoms/many', '{0} ROMs edited', stats.editedRoms),
                        ),
                    ].filter(Boolean).join(' · ')}
                </dd>
                {library.removedCount > 0 && <>
                    <dt className='vp-hint'>{nls.localize('vueport/library/stats/removed/title', 'Removed')}</dt>
                    <dd>
                        {counted(
                            library.removedCount,
                            nls.localize('vueport/library/stats/removed/one', '{0} ROM', library.removedCount),
                            nls.localize('vueport/library/stats/removed/many', '{0} ROMs', library.removedCount),
                        )}
                        {' · '}
                        <button
                            className='vp-library-stat-link'
                            onClick={() => { library.restoreRemoved().catch(() => undefined); }}
                        >{nls.localize('vueport/library/stats/restore', 'Bring back')}</button>
                    </dd>
                </>}
                {stats.mostPlayed && <>
                    <dt className='vp-hint'>{nls.localize('vueport/library/stats/mostPlayed', 'Most played')}</dt>
                    <dd>{stats.mostPlayed.title} — {playTimeLabel(stats.mostPlayed.ms)}</dd>
                </>}
                {stats.sessions > 0 && <>
                    <dt className='vp-hint'>{nls.localize('vueport/library/stats/sessions', 'Sessions')}</dt>
                    <dd>{stats.sessions}</dd>
                </>}
            </dl>
        </fieldset>

        {use && total !== undefined && total > 0 && <fieldset>
            <legend>{nls.localize('vueport/library/stats/storage', 'Storage')}</legend>
            <div className='vp-library-stat-total'>
                <span className='vp-library-stat-value'>{sizeLabel(total)}</span>
                <span className='vp-hint'>
                    {library.canImportFolders()
                        ? nls.localize('vueport/library/stats/inBrowser', 'in this browser')
                        : nls.localize('vueport/library/stats/onDevice', 'on this device')}
                </span>
                <span className='vp-library-stat-grow' />
                {props.durable === true && <span className='vp-library-stat-durable'>
                    <CheckCircle size={15} />
                    {nls.localize('vueport/library/stats/durable', 'Kept permanently')}
                </span>}
                {props.durable === false && library.canImportFolders() && <span className='vp-library-stat-durable warn'>
                    <Warning size={15} />
                    {nls.localize('vueport/library/stats/notDurable', 'The browser may clear it')}
                </span>}
            </div>
            <Breakdown
                parts={[
                    {
                        key: 'imported',
                        value: use.imported.bytes,
                        color: 'var(--vp-series-1)',
                        label: nls.localize('vueport/library/stats/importedCopies', 'Imported copies'),
                        detail: counted(
                            use.imported.files,
                            nls.localize('vueport/library/stats/files/one', '{0} file', use.imported.files),
                            nls.localize('vueport/library/stats/files/many', '{0} files', use.imported.files)
                        ),
                        amount: sizeLabel(use.imported.bytes),
                    },
                    {
                        key: 'art',
                        value: use.art.bytes,
                        color: 'var(--vp-series-3)',
                        label: nls.localize('vueport/library/stats/catalogArt', 'Covers and backdrops'),
                        detail: counted(
                            use.art.files,
                            nls.localize('vueport/library/stats/artDetail/one', '{0} picture', use.art.files),
                            nls.localize('vueport/library/stats/artDetail/many', '{0} pictures', use.art.files)
                        ),
                        amount: sizeLabel(use.art.bytes),
                    },
                    {
                        key: 'covers',
                        value: use.covers.bytes,
                        color: 'var(--vp-series-4)',
                        label: nls.localize('vueport/library/stats/ownCovers', 'Custom art'),
                        detail: counted(
                            use.covers.files,
                            nls.localize('vueport/library/stats/artDetail/one', '{0} picture', use.covers.files),
                            nls.localize('vueport/library/stats/artDetail/many', '{0} pictures', use.covers.files)
                        ),
                        amount: sizeLabel(use.covers.bytes),
                    },
                    {
                        key: 'index',
                        value: use.index.bytes,
                        color: 'var(--vp-field-border)',
                        label: nls.localize('vueport/library/stats/index', 'Index, edits, play times'),
                        detail: counted(
                            use.index.files,
                            nls.localize('vueport/library/stats/files/one', '{0} file', use.index.files),
                            nls.localize('vueport/library/stats/files/many', '{0} files', use.index.files)
                        ),
                        amount: sizeLabel(use.index.bytes),
                    },
                    {
                        key: 'companions',
                        value: use.companions.bytes,
                        color: 'var(--vp-series-2)',
                        label: nls.localize('vueport/library/stats/companions', 'Saves, states, cheats'),
                        detail: counted(
                            use.companions.files,
                            nls.localize('vueport/library/stats/files/one', '{0} file', use.companions.files),
                            nls.localize('vueport/library/stats/files/many', '{0} files', use.companions.files)
                        ),
                        amount: sizeLabel(use.companions.bytes),
                    },
                ]} footer={<>
                    {isDesktop() && <button
                        className='vp-button secondary'
                        onClick={() => {
                            import('./desktop-storage')
                                .then(({ revealStorage }) => revealStorage())
                                .catch(() => undefined);
                        }}
                    >
                        <FolderOpen size={15} />
                        {revealLabel()}
                    </button>}
                    {use.art.bytes > 0 && <button
                        className='vp-button secondary'
                        onClick={() => { library.clearArt().then(bump).catch(() => undefined); }}
                    >{nls.localize('vueport/library/stats/clearCache', 'Clear cache')}</button>}
                    <button className='vp-button vp-danger-outline' onClick={() => setClearing(true)}>
                        <Trash size={15} />
                        {nls.localize('vueport/library/clear/open', 'Clear library…')}
                    </button>
                </>} />
        </fieldset>}
        {clearing && <ClearLibraryDialog
            library={library}
            stats={stats}
            companions={use?.companions}
            onClose={() => setClearing(false)}
        />}
    </>;
}

// folders, index and pictures always go. Edits, favorites, play time and saves are offered unticked, as adding the
// folder back cannot restore them
function ClearLibraryDialog(props: {
    library: Library,
    stats: LibraryStats,
    companions: LibraryStoragePart | undefined, // undefined until weighed
    onClose: () => void,
}): React.JSX.Element {
    const { library, stats, companions, onClose } = props;
    const [options, setOptions] = React.useState<LibraryClearOptions>({
        edits: false, favorites: false, playTime: false, companions: false,
    });
    const [clearing, setClearing] = React.useState(false);

    const confirm = React.useCallback(() => {
        setClearing(true);
        library.clear(options).catch(() => undefined).finally(onClose);
    }, [library, options, onClose]);

    React.useEffect(() => {
        const layer = pushEscapeLayer();
        const onKeyDown = (e: KeyboardEvent): void => {
            if (layer.isTop() && e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };
        // capture phase, as the settings window closes on Escape too and must not see this one
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            layer.dispose();
        };
    }, [onClose]);

    const always: Array<{ label: string, detail: string }> = [{
        label: nls.localize('vueport/library/clear/folders', 'Folders and index'),
        detail: [
            counted(
                stats.folders,
                nls.localize('vueport/library/clear/folderCount/one', '{0} folder', stats.folders),
                nls.localize('vueport/library/clear/folderCount/many', '{0} folders', stats.folders),
            ),
            counted(
                stats.roms,
                nls.localize('vueport/library/clear/romCount/one', '{0} ROM', stats.roms),
                nls.localize('vueport/library/clear/romCount/many', '{0} ROMs', stats.roms),
            ),
            counted(
                stats.games,
                nls.localize('vueport/library/clear/gameCount/one', '{0} game', stats.games),
                nls.localize('vueport/library/clear/gameCount/many', '{0} games', stats.games),
            ),
        ].join(' · '),
    }, {
        label: nls.localize('vueport/library/clear/copiesArt', 'Imported copies and catalog art'),
        detail: nls.localize('vueport/library/clear/copiesArtDetail',
            'Import the folder again to get a copy back; pictures are fetched again.'),
    }];
    const choices: Array<{ key: keyof LibraryClearOptions, label: string, detail: string, disabled: boolean }> = [{
        key: 'edits',
        label: nls.localize('vueport/library/clear/edits', 'Your edits and covers'),
        detail: [
            stats.editedGames > 0 && counted(
                stats.editedGames,
                nls.localize('vueport/library/stats/editedGames/one', '{0} game edited', stats.editedGames),
                nls.localize('vueport/library/stats/editedGames/many', '{0} games edited', stats.editedGames),
            ),
            stats.editedRoms > 0 && counted(
                stats.editedRoms,
                nls.localize('vueport/library/stats/editedRoms/one', '{0} ROM edited', stats.editedRoms),
                nls.localize('vueport/library/stats/editedRoms/many', '{0} ROMs edited', stats.editedRoms),
            ),
            nls.localize('vueport/library/clear/editsRest', 'covers, filings and games you made'),
        ].filter(Boolean).join(' · '),
        disabled: false,
    }, {
        key: 'favorites',
        label: nls.localize('vueport/library/clear/favorites', 'Favorites'),
        detail: counted(
            stats.favorites,
            nls.localize('vueport/library/clear/favoritesDetail/one', '{0} starred game', stats.favorites),
            nls.localize('vueport/library/clear/favoritesDetail/many', '{0} starred games', stats.favorites),
        ),
        disabled: false,
    }, {
        key: 'playTime',
        label: nls.localize('vueport/library/clear/playTime', 'Play time'),
        detail: stats.playMs > 0
            ? nls.localize('vueport/library/clear/playTimeDetail',
                '{0} in the library — and the hours of ROMs opened outside it', playTimeLabel(stats.playMs))
            : nls.localize('vueport/library/clear/playTimeNone', 'Also for ROMs opened outside the library'),
        disabled: false,
    }];
    // on the desktop the files usually go beside the ROM
    if (companions && companions.files > 0) {
        choices.push({
            key: 'companions',
            label: nls.localize('vueport/library/clear/companions', 'Saves, states and cheats'),
            detail: [
                counted(
                    companions.files,
                    nls.localize('vueport/library/stats/files/one', '{0} file', companions.files),
                    nls.localize('vueport/library/stats/files/many', '{0} files', companions.files),
                ),
                sizeLabel(companions.bytes),
                library.canImportFolders()
                    ? nls.localize('vueport/library/clear/companionsDetail',
                        'also for ROMs opened outside the library')
                    : nls.localize('vueport/library/clear/companionsDetailDesktop',
                        'those kept by VUEPort, not those beside your ROMs'),
            ].join(' · '),
            disabled: false,
        });
    }

    // portal to the body, as a backdrop inside the scrolling pane would not cover the window
    return createPortal(<div className='vp-modal-backdrop vp-library-clear-backdrop' onMouseDown={onClose}>
        <div
            className='vp-modal vp-library-clear-dialog'
            role='dialog'
            aria-modal='true'
            aria-labelledby='vp-library-clear-title'
            onMouseDown={event => event.stopPropagation()}
        >
            <h2 id='vp-library-clear-title'>{nls.localize('vueport/library/clear/question', 'Clear library?')}</h2>
            <p className='vp-hint'>
                {nls.localize('vueport/library/clear/intro',
                    'The library is emptied and starts over. Choose what goes with it.')}
            </p>
            <div className='vp-library-clear-options'>
                {always.map(item => <label key={item.label} className='vp-library-clear-option locked'>
                    <input type='checkbox' checked disabled />
                    <span>
                        <span>{item.label}</span>
                        <span className='vp-hint'>{item.detail}</span>
                    </span>
                </label>)}
                {choices.map(item => <label key={item.key} className='vp-library-clear-option'>
                    <input
                        type='checkbox'
                        checked={options[item.key]}
                        disabled={item.disabled || clearing}
                        onChange={event => {
                            const checked = event.currentTarget.checked;
                            setOptions(current => ({ ...current, [item.key]: checked }));
                        }}
                    />
                    <span>
                        <span>{item.label}</span>
                        <span className='vp-hint'>{item.detail}</span>
                    </span>
                </label>)}
            </div>
            <div className='vp-modal-buttons'>
                <button className='vp-button secondary' onClick={onClose} disabled={clearing}>
                    {nls.localize('vueport/state/cancel', 'Cancel')}
                </button>
                <button className='vp-button vp-danger' onClick={confirm} disabled={clearing}>
                    <Trash size={15} />
                    {nls.localize('vueport/library/clear/confirm', 'Clear library')}
                </button>
            </div>
        </div>
    </div>, document.body);
}
