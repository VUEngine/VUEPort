import * as React from 'react';
import { PencilSimple } from '@phosphor-icons/react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { Window } from 'vueport-core/lib/browser/components/kit/Window';
import RadioSelect from 'vueport-core/lib/browser/components/kit/RadioSelect';
import { Library, LibraryGame, PictureDraft } from './web-library';
import { LibraryOverride } from './web-library-types';
import { PicturesPage, draftOf } from './web-library-edit-pictures';
import { WebUi } from './web-ui';

// overrides are kept against the ROM's checksum, so a reread folder, a renamed file or a second copy keep them. A field
// left at the catalog's value is stored as empty, so reverting equals clearing and later catalog corrections still
// apply
type Field = 'title' | 'developer' | 'publisher' | 'released' | 'genre' | 'players' | 'region';

const FIELDS: { field: Field, label: () => string, wide?: boolean }[] = [
    { field: 'title', label: () => nls.localize('vueport/status/title', 'Title'), wide: true },
    { field: 'developer', label: () => nls.localize('vueport/library/developer', 'Developer') },
    { field: 'publisher', label: () => nls.localize('vueport/library/publisher', 'Publisher') },
    { field: 'genre', label: () => nls.localize('vueport/library/genre', 'Genre') },
    { field: 'players', label: () => nls.localize('vueport/library/players', 'Players') },
    { field: 'released', label: () => nls.localize('vueport/library/released', 'Released') },
    { field: 'region', label: () => nls.localize('vueport/library/region', 'Region') },
];

type Tab = 'details' | 'cover' | 'background';

export function LibraryEdit(props: {
    library: Library,
    ui: WebUi,
    game: LibraryGame,
    onClose: () => void,
    onDeleted?: () => void,
}): React.JSX.Element {
    const { library, ui, game } = props;
    const catalog = game.roms.find(rom => rom.entry.catalog)?.entry.catalog;

    const fromCatalog = React.useCallback((field: Field): string => {
        if (!catalog) {
            return '';
        }
        return (field === 'title' ? catalog.title || catalog.romTitle : catalog[field]) ?? '';
    }, [catalog]);

    const [values, setValues] = React.useState<Record<Field, string>>(() => ({
        title: game.title,
        developer: game.developer ?? '',
        publisher: game.publisher ?? '',
        released: game.released ?? '',
        genre: game.genre ?? '',
        players: game.players ?? '',
        region: game.region ?? '',
    }));
    const [notes, setNotes] = React.useState(game.notes ?? '');
    const [tab, setTab] = React.useState<Tab>('details');
    // drafts kept only on Save, so Cancel discards on every page
    const [covers, setCovers] = React.useState<PictureDraft>(() => draftOf(library, game, 'cover'));
    const [backgrounds, setBackgrounds] = React.useState<PictureDraft>(() => draftOf(library, game, 'background'));
    const [saving, setSaving] = React.useState(false);

    const save = React.useCallback(async () => {
        setSaving(true);
        try {
            await library.savePictures(game.id, 'cover', covers);
            await library.savePictures(game.id, 'background', backgrounds);
            const patch: Partial<Omit<LibraryOverride, 'updatedAt'>> = { notes };
            for (const { field } of FIELDS) {
                patch[field] = values[field].trim() === fromCatalog(field).trim() ? '' : values[field];
            }
            await library.edit(game.id, patch);
            props.onClose();
        } finally {
            setSaving(false);
        }
    }, [library, game.id, values, notes, covers, backgrounds, fromCatalog, props]);

    // asks first, as it drops the boxes and backdrops made with it, which Cancel cannot bring back
    const revertAll = React.useCallback(async () => {
        const agreed = await ui.confirm({
            title: nls.localize('vueport/library/revertAllConfirm/title', 'Revert everything for {0}?', game.title),
            message: nls.localize('vueport/library/revertAllConfirm/message',
                'Every field you typed over, your notes, and the covers and backgrounds you made for this game \
are removed, and Planet VB\'s entry shows again. The ROMs are not touched.'),
            okLabel: nls.localize('vueport/library/revertAllConfirm/ok', 'Revert'),
        });
        if (!agreed) {
            return;
        }
        await library.revert(game.id);
        props.onClose();
    }, [library, ui, game.id, game.title, props]);

    // only for games made here; the ROMs filed under it go back to where their checksums put them
    const deleteGame = React.useCallback(async () => {
        const agreed = await ui.confirm({
            title: nls.localize('vueport/library/deleteGame/title', 'Delete {0}?', game.title),
            message: game.roms.length === 0
                ? nls.localize('vueport/library/deleteGame/empty',
                    'Nothing is filed under it, so nothing else changes.')
                : nls.localize('vueport/library/deleteGame/message',
                    'The {0} ROMs filed under it are left alone — they go back to where their \
checksums put them. No file is touched.', game.roms.length),
            okLabel: nls.localize('vueport/library/delete', 'Delete'),
        });
        if (agreed) {
            await library.deleteGame(game.id);
            (props.onDeleted ?? props.onClose)();
        }
    }, [library, ui, game.id, game.title, game.roms.length, props]);

    return <Window
        title={nls.localize('vueport/library/editGame', 'Edit Game')}
        icon={<PencilSimple size={18} />}
        onClose={props.onClose}
        compact
    >
        <div className='vp-library-edit'>
            <div className='vp-library-edit-tabs'>
                <RadioSelect
                    options={[
                        { value: 'details', label: nls.localize('vueport/library/details', 'Details') },
                        { value: 'cover', label: nls.localize('vueport/library/coverTab', 'Cover') },
                        { value: 'background', label: nls.localize('vueport/library/backgroundTab', 'Background') },
                    ]}
                    defaultValue={tab}
                    onChange={chosen => setTab(chosen[0].value as Tab)}
                />
            </div>

            {/* every page is drawn, the hidden ones invisibly in the same cell, so the window does not jump on switching */}
            <div className='vp-library-edit-pages'>
                <div className={`vp-library-edit-fields${tab === 'details' ? '' : ' hidden'}`} aria-hidden={tab !== 'details'}>
                    {FIELDS.map(({ field, label, wide }) => {
                        const original = fromCatalog(field);
                        const changed = values[field].trim() !== original.trim();
                        return <label key={field} className={wide ? 'wide' : undefined}>
                            <span className='vp-library-edit-label'>
                                {label()}
                                {changed && <>
                                    <span className='vp-library-edited'>
                                        {nls.localize('vueport/library/edited', 'Edited')}
                                    </span>
                                    <button
                                        type='button'
                                        className='vp-library-revert'
                                        onClick={() => setValues(current => ({ ...current, [field]: original }))}
                                    >{nls.localize('vueport/library/revert', 'Revert')}</button>
                                </>}
                            </span>
                            <input
                                className='vp-input'
                                type='text'
                                value={values[field]}
                                spellCheck={false}
                                onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))}
                            />
                        </label>;
                    })}

                    <label className='wide'>
                        <span className='vp-library-edit-label'>
                            {nls.localize('vueport/library/notes', 'Notes')}
                        </span>
                        <textarea
                            className='vp-input'
                            rows={2}
                            value={notes}
                            onChange={event => setNotes(event.target.value)}
                        />
                    </label>
                </div>

                <PicturesPage
                    kind='cover'
                    shown={tab === 'cover'}
                    library={library}
                    ui={ui}
                    game={game}
                    draft={covers}
                    onChange={setCovers}
                />
                <PicturesPage
                    kind='background'
                    shown={tab === 'background'}
                    library={library}
                    ui={ui}
                    game={game}
                    draft={backgrounds}
                    onChange={setBackgrounds}
                />
            </div>
        </div>

        <div className='vp-library-edit-foot'>
            {game.own
                ? <button
                    className='vp-button secondary'
                    onClick={() => { deleteGame().catch(() => undefined); }}
                >
                    {nls.localize('vueport/library/deleteGame/button', 'Delete this game')}
                </button>
                : game.edited.length !== 0 || game.customPictures
                    ? <button
                        className='vp-button secondary'
                        onClick={() => { revertAll().catch(() => undefined); }}
                    >
                        {nls.localize('vueport/library/revertAll', 'Revert everything')}
                    </button>
                    : undefined
            }
            <span className='vp-library-edit-spacer' />
            <button className='vp-button secondary' onClick={props.onClose}>
                {nls.localize('vueport/state/cancel', 'Cancel')}
            </button>
            <button className='vp-button' disabled={saving} onClick={() => { save().catch(() => undefined); }}>
                {nls.localize('vueport/state/save', 'Save')}
            </button>
        </div>
    </Window>;
}
