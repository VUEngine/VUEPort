import * as React from 'react';
import { ArrowUUpLeft, MagnifyingGlass, Plus, Rows, X } from '@phosphor-icons/react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { Window } from 'vueport-core/lib/browser/components/kit/Window';
import { Library, LibraryFolderState, LibraryGame, LibraryRom, romLabel } from './web-library';
import { LibraryCover } from './web-library-cover';
import { megabits } from './web-library-page';

/**
 * Editing one dump rather than its game. The library groups by what Planet VB answers for a CRC32, which is wrong
 * exactly when it matters (own builds, translations, releases newer than the catalog, misfiled dumps), so this window
 * overrules it: name, origin, current version, whether it plays, and which game it belongs to. "Current" is a fact
 * about a version, "plays" a per-game choice between dumps, hence two switches. Nothing is written into the ROM or sent
 * anywhere: it is kept on this machine against the checksum, so a re-read folder, a renamed file or a second copy keep
 * it.
 */

type Target =
    | { kind: 'keep' } // may already be somewhere it was put
    | { kind: 'game', id: string }
    | { kind: 'new', title: string } // made on Save
    | { kind: 'checksum' };

export function LibraryRomEdit(props: {
    library: Library,
    game: LibraryGame,
    rom: LibraryRom,
    folders: LibraryFolderState[],
    onClose: () => void,
    onFiled?: (gameId: string) => void,
}): React.JSX.Element {
    const { library, game, rom } = props;
    const entry = rom.entry;
    const catalog = entry.catalog;

    const [title, setTitle] = React.useState(rom.title ?? '');
    const [region, setRegion] = React.useState(rom.region ?? '');
    const [latest, setLatest] = React.useState(rom.latest);
    const [plays, setPlays] = React.useState(rom.preferred);
    const [target, setTarget] = React.useState<Target>({ kind: 'keep' });
    const [picking, setPicking] = React.useState(false);
    const [saving, setSaving] = React.useState(false);

    const catalogTitle = catalog?.romTitle ?? '';
    const catalogRegion = catalog?.region ?? '';
    const catalogLatest = catalog?.latest ?? false;

    // not memoized, as a folder finishing its read while this is open changes what there is to file under
    const games = library.games();
    const targetGame = target.kind === 'game'
        ? games.find(known => known.id === target.id)
        : undefined;

    const save = React.useCallback(async () => {
        setSaving(true);
        try {
            // filed first, then named: marking a dump the one to play demotes the others of the game it is going to,
            // not the one it is leaving
            let filed: string | undefined;
            if (target.kind === 'checksum') {
                await library.fileRom(entry.id, undefined);
            } else if (target.kind === 'game') {
                filed = target.id;
            } else if (target.kind === 'new') {
                filed = await library.createGame({ title: target.title });
            }
            if (filed) {
                await library.fileRom(entry.id, filed);
            }
            // a value matching the catalog is kept as none, so a later catalog correction still reaches this dump
            await library.editRom(entry.id, {
                title: title.trim() === catalogTitle.trim() ? '' : title,
                region: region.trim() === catalogRegion.trim() ? '' : region,
                latest: latest === catalogLatest ? undefined : latest,
            });
            // written only when changed here, against the game the dump has just ended up in, not the one this window
            // opened on. A dump that played under the game it is leaving must not take the next game's Play button, and
            // unchecking hands the choice back rather than pointing it elsewhere
            const home = plays === rom.preferred ? undefined : library.gameOfRom(entry.id);
            if (home && plays) {
                await library.setPreferredRom(home.id, entry.id);
            } else if (home && library.preferredRom(home.id) === entry.id) {
                await library.clearPreferredRom(home.id);
            }
            if (filed) {
                props.onFiled?.(filed);
            }
            props.onClose();
        } finally {
            setSaving(false);
        }
    }, [library, entry.id, title, region, latest, plays, rom.preferred,
        catalogTitle, catalogRegion, catalogLatest, target, props]);

    const folderName = (id: string): string =>
        props.folders.find(folder => folder.id === id)?.name
        ?? nls.localize('vueport/library/folderGone', 'a folder that is no longer there');

    const titleChanged = title.trim() !== catalogTitle.trim();
    const regionChanged = region.trim() !== catalogRegion.trim();
    const latestChanged = latest !== catalogLatest;

    return <Window
        title={nls.localize('vueport/library/editRomTitle', 'Edit ROM')}
        icon={<Rows size={18} />}
        onClose={props.onClose}
        compact
    >
        <div className='vp-library-rom-edit'>
            <div className='vp-library-rom-identity'>
                <p className='vp-hint'>
                    {[
                        entry.header.name.trim() || nls.localize('vueport/library/noHeader', 'No header name'),
                        megabits(entry.bytes),
                        `CRC32 ${entry.id.toUpperCase()}`,
                    ].join(' · ')}
                </p>
                <ul className='vp-library-rom-files'>
                    {entry.files.map(file => <li key={`${file.folderId}/${file.path}/${file.archiveEntry ?? ''}`}>
                        <span>{file.archiveEntry ?? file.name}</span>
                        <span className='vp-hint'>{`${folderName(file.folderId)} · ${file.path}`}</span>
                    </li>)}
                </ul>
            </div>

            <div className='vp-library-edit-fields'>
                <label className='wide'>
                    <span className='vp-library-edit-label'>
                        {nls.localize('vueport/library/romTitle', 'ROM title')}
                        {titleChanged && <>
                            <span className='vp-library-edited'>
                                {nls.localize('vueport/library/edited', 'Edited')}
                            </span>
                            <button
                                type='button'
                                className='vp-library-revert'
                                onClick={() => setTitle(catalogTitle)}
                            >{nls.localize('vueport/library/revert', 'Revert')}</button>
                        </>}
                    </span>
                    <input
                        type='text'
                        className='vp-input'
                        value={title}
                        spellCheck={false}
                        placeholder={romLabel(rom)}
                        onChange={event => setTitle(event.target.value)}
                    />
                </label>

                <label className='wide'>
                    <span className='vp-library-edit-label'>
                        {nls.localize('vueport/library/region', 'Region')}
                        {regionChanged && <>
                            <span className='vp-library-edited'>
                                {nls.localize('vueport/library/edited', 'Edited')}
                            </span>
                            <button
                                type='button'
                                className='vp-library-revert'
                                onClick={() => setRegion(catalogRegion)}
                            >{nls.localize('vueport/library/revert', 'Revert')}</button>
                        </>}
                    </span>
                    <input
                        type='text'
                        className='vp-input'
                        value={region}
                        spellCheck={false}
                        onChange={event => setRegion(event.target.value)}
                    />
                </label>

                <label className='vp-library-rom-flag wide'>
                    <span className='vp-library-edit-label'>
                        {nls.localize('vueport/library/latest', 'Latest')}
                        {latestChanged && <>
                            <span className='vp-library-edited'>
                                {nls.localize('vueport/library/edited', 'Edited')}
                            </span>
                            <button
                                type='button'
                                className='vp-library-revert'
                                onClick={() => setLatest(catalogLatest)}
                            >{nls.localize('vueport/library/revert', 'Revert')}</button>
                        </>}
                    </span>
                    <span className='vp-library-rom-check'>
                        <input
                            type='checkbox'
                            checked={latest}
                            onChange={event => setLatest(event.target.checked)}
                        />
                        <span>{nls.localize('vueport/library/latestOf',
                            'This is the latest version of the game')}</span>
                    </span>
                </label>

                <label className='vp-library-rom-flag wide'>
                    <span className='vp-library-edit-label'>
                        {nls.localize('vueport/library/playsLabel', 'Plays')}
                    </span>
                    <span className='vp-library-rom-check'>
                        <input
                            type='checkbox'
                            checked={plays}
                            onChange={event => setPlays(event.target.checked)}
                        />
                        <span>{nls.localize('vueport/library/playsThisOne',
                            'Play this ROM when I press Play')}</span>
                    </span>
                </label>
            </div>

            <section className='vp-library-rom-game'>
                <span className='vp-library-edit-label'>
                    {nls.localize('vueport/library/game', 'Game')}
                </span>

                {target.kind === 'checksum'
                    ? <p className='vp-hint'>
                        {nls.localize('vueport/library/backToChecksum',
                            'Will be determined by checksum.')}
                    </p>
                    : <div className='vp-library-rom-target'>
                        <LibraryCover
                            className='thumb'
                            cover={target.kind === 'new'
                                ? {}
                                : {
                                    ownCoverUrl: (targetGame ?? game).ownCoverUrl,
                                    catalogCoverUrl: (targetGame ?? game).catalogCoverUrl,
                                }}
                        />
                        <span className='vp-library-rom-target-text'>
                            <span>{target.kind === 'new' ? target.title : (targetGame ?? game).title}</span>
                            <span className='vp-hint'>{
                                target.kind === 'new'
                                    ? undefined
                                    : target.kind === 'game'
                                        ? undefined
                                        : rom.filed
                                            ? nls.localize('vueport/library/filedByHand',
                                                'Filed here by hand')
                                            : undefined
                            }</span>
                        </span>
                        {target.kind !== 'keep' && <button
                            type='button'
                            className='vp-library-revert'
                            onClick={() => setTarget({ kind: 'keep' })}
                        >{nls.localize('vueport/library/undo', 'Undo')}</button>}
                    </div>}

                <div className='vp-library-rom-game-actions'>
                    <button
                        className='vp-button secondary'
                        onClick={() => setPicking(current => !current)}
                    >
                        {picking
                            ? nls.localize('vueport/library/hidePicker', 'Abort')
                            : nls.localize('vueport/library/fileUnder', 'File under another game…')}
                    </button>
                    {rom.filed && target.kind !== 'checksum' && <button
                        className='vp-button secondary'
                        onClick={() => { setTarget({ kind: 'checksum' }); setPicking(false); }}
                    >
                        <ArrowUUpLeft size={14} />
                        {nls.localize('vueport/library/unfile', 'Put it back')}
                    </button>}
                </div>

                {picking && <GamePicker
                    games={games}
                    exclude={target.kind === 'game' ? target.id : game.id}
                    onPick={id => { setTarget({ kind: 'game', id }); setPicking(false); }}
                    onCreate={name => { setTarget({ kind: 'new', title: name }); setPicking(false); }}
                />}
            </section>
        </div>

        <div className='vp-library-edit-foot'>
            <p className='vp-hint vp-library-edit-spacer' />
            <button className='vp-button secondary' onClick={props.onClose}>
                {nls.localize('vueport/state/cancel', 'Cancel')}
            </button>
            <button className='vp-button' disabled={saving} onClick={() => { save().catch(() => undefined); }}>
                {nls.localize('vueport/state/save', 'Save')}
            </button>
        </div>
    </Window>;
}

// searches the library's own games, as Planet VB's catalog cannot be searched by title. The last row is for none of
// them fitting, the commonest outcome
function GamePicker(props: {
    games: LibraryGame[],
    exclude: string,
    onPick: (id: string) => void,
    onCreate: (title: string) => void,
}): React.JSX.Element {
    const [search, setSearch] = React.useState('');
    const [name, setName] = React.useState('');

    const query = search.trim().toLowerCase();
    const shown = React.useMemo(() => props.games
        .filter(game => game.id !== props.exclude)
        .filter(game => query.length === 0
            || `${game.title} ${game.developer ?? ''}`.toLowerCase().includes(query))
        .slice(0, 200), [props.games, props.exclude, query]);

    return <div className='vp-library-picker'>
        <div className='vp-settings-search'>
            <MagnifyingGlass size={15} />
            <input
                type='text'
                value={search}
                spellCheck={false}
                autoFocus
                placeholder={nls.localize('vueport/library/searchGames', 'Search your games')}
                aria-label={nls.localize('vueport/library/searchGames', 'Search your games')}
                onChange={event => setSearch(event.target.value)}
            />
            {search && <button
                type='button'
                className='vp-settings-search-clear'
                onClick={() => setSearch('')}
                aria-label={nls.localize('vueport/library/clearSearch', 'Clear the search')}
            ><X size={13} /></button>}
        </div>

        <ul className='vp-library-picker-list vp-scroll'>
            {shown.length === 0
                ? <li className='vp-hint'>
                    {nls.localize('vueport/library/noGamesMatch', 'No game here matches that.')}
                </li>
                : shown.map(game => <li key={game.id}>
                    <LibraryCover
                        className='thumb'
                        cover={{
                            ownCoverUrl: game.ownCoverUrl,
                            catalogCoverUrl: game.catalogCoverUrl,
                        }}
                    />
                    <span className='vp-library-picker-text'>
                        <span>{game.title}</span>
                        <span className='vp-hint'>
                            {[
                                game.developer,
                                game.roms.length === 1
                                    ? nls.localize('vueport/library/oneRom', '1 ROM')
                                    : nls.localize('vueport/library/someRoms',
                                        '{0} ROMs', game.roms.length),
                            ].filter(Boolean).join(' · ')}
                        </span>
                    </span>
                    <button className='vp-button secondary' onClick={() => props.onPick(game.id)}>
                        {nls.localize('vueport/library/fileHere', 'File here')}
                    </button>
                </li>)}
        </ul>

        <form
            className='vp-library-picker-new'
            onSubmit={event => {
                event.preventDefault();
                if (name.trim()) {
                    props.onCreate(name.trim());
                }
            }}
        >
            <input
                type='text'
                className='vp-input'
                value={name}
                spellCheck={false}
                placeholder={nls.localize('vueport/library/newGame/name', 'Or name a new game…')}
                aria-label={nls.localize('vueport/library/newGame/name', 'Or name a new game…')}
                onChange={event => setName(event.target.value)}
            />
            <button className='vp-button secondary' type='submit' disabled={name.trim().length === 0}>
                <Plus size={14} />
                {nls.localize('vueport/library/createGame', 'Create')}
            </button>
        </form>
    </div>;
}
