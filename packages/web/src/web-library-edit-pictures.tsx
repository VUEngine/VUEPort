import * as React from 'react';
import { Plus, X } from '@phosphor-icons/react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { Library, LibraryGame, PictureDraft, PictureDraftSet } from './web-library';
import { BoxNet, BoxPicture, boxFaceLabel } from './web-library-box';
import {
    CatalogPreset,
    DEFAULT_PRESET,
    LibraryPicture,
    PictureKey,
    PictureKind,
} from './web-library-types';
import { WebUi } from './web-ui';

/**
 * The editor's Cover and Background pages. A game is pictured by one of several sets: the catalog's read-only presets
 * and the user's own. The chosen set shows large, and the strip lists them all to choose, make or drop one. Clicking a
 * picture of an own set changes it; on a preset it first offers to make an own set from it, the only way to change it.
 * Nothing is kept until the editor is saved: the page works on a draft the editor hands to Library.savePictures.
 */
export function PicturesPage(props: {
    kind: PictureKind,
    shown: boolean,
    library: Library,
    ui: WebUi,
    game: LibraryGame,
    draft: PictureDraft,
    // always applied to the current draft, since a file can come back from its dialog before the page was redrawn with
    // its set
    onChange: React.Dispatch<React.SetStateAction<PictureDraft>>,
}): React.JSX.Element {
    const { kind, game, draft } = props;
    const urlOf = usePictureUrls(props.library);
    const file = React.useRef<HTMLInputElement>(null);
    const pending = React.useRef<{ set: string, key: PictureKey }>();
    const strip = React.useRef<HTMLDivElement>(null);

    // a set just made lands at the strip's far end, which may be past the edge
    React.useEffect(() => {
        strip.current?.querySelector('.vp-library-preset.selected')
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [draft.shown]);

    const presets = game.presets[kind];
    const set = draft.sets.find(candidate => candidate.id === draft.shown);
    const preset = presets.find(candidate => candidate.id === (set ? set.base : draft.shown))
        ?? (set ? undefined : presets[0]);

    // own picture, else the preset's, else undefined for the empty box
    const pictureOf = (key: PictureKey): string | undefined => {
        const own = set?.pictures[key];
        return own === null ? undefined : own ? urlOf(own) : preset?.pictures[key];
    };

    const makeSet = (): PictureDraftSet => {
        const made: PictureDraftSet = {
            id: `set-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            name: freeName(draft.sets),
            base: set ? set.base : preset?.id,
            pictures: { ...set?.pictures },
        };
        props.onChange(current => ({ shown: made.id, sets: [...current.sets, made] }));
        return made;
    };

    const choose = (setId: string, key: PictureKey): void => {
        pending.current = { set: setId, key };
        file.current?.click();
    };

    // on a preset, ask first, then pick the file for the same picture of the new set, so the click still does what it
    // was for
    const edit = async (key: PictureKey): Promise<void> => {
        if (set) {
            choose(set.id, key);
            return;
        }
        const agreed = await props.ui.confirm({
            title: kind === 'cover'
                ? nls.localize('vueport/library/preset/makeCover', 'Make a custom cover?')
                : nls.localize('vueport/library/preset/makeBackground', 'Make a custom background?'),
            message: nls.localize('vueport/library/preset/makeMessage',
                '"{0}" comes from Planet VB and cannot be changed. A custom one based on it can, and is kept \
beside it, so you can switch back at any time.', preset?.name ?? ''),
            okLabel: nls.localize('vueport/library/preset/create', 'Create'),
        });
        if (agreed) {
            choose(makeSet().id, key);
        }
    };

    const updateSet = (setId: string, change: (pictures: PictureDraftSet['pictures']) => PictureDraftSet['pictures']): void => {
        props.onChange(current => ({
            ...current,
            sets: current.sets.map(candidate => candidate.id === setId
                ? { ...candidate, pictures: change(candidate.pictures) }
                : candidate),
        }));
    };

    // an emptied field gets its number back
    const rename = (setId: string, name: string): void => {
        props.onChange(current => ({
            ...current,
            sets: current.sets.map(candidate => candidate.id === setId ? { ...candidate, name } : candidate),
        }));
    };

    // a picture inherited from the preset is marked as none, so the empty box shows rather than the preset's
    const remove = (key: PictureKey): void => {
        if (set) {
            const inherited = preset?.pictures[key] !== undefined;
            updateSet(set.id, pictures => {
                const next = { ...pictures };
                if (inherited) {
                    next[key] = null;
                } else {
                    delete next[key];
                }
                return next;
            });
        }
    };

    const dropSet = (id: string): void => {
        props.onChange(current => {
            const dropped = current.sets.find(candidate => candidate.id === id);
            return {
                shown: current.shown === id ? dropped?.base ?? presets[0]?.id ?? DEFAULT_PRESET : current.shown,
                sets: current.sets.filter(candidate => candidate.id !== id),
            };
        });
    };

    const removeButton = (key: PictureKey): React.ReactNode => set && pictureOf(key) !== undefined && <button
        type='button'
        className='vp-library-edit-remove'
        onClick={() => remove(key)}
        title={nls.localize('vueport/library/preset/removePicture', 'Remove this picture')}
        aria-label={nls.localize('vueport/library/preset/removePicture', 'Remove this picture')}
    ><X size={13} /></button>;

    const hint = (label: string): string => set
        ? nls.localize('vueport/library/preset/choose', '{0} — click to choose a picture', label)
        : nls.localize('vueport/library/preset/makeOwn', '{0} — click to make your own', label);

    const background = pictureOf('background');

    return <div className={`vp-library-edit-pictures ${kind}${props.shown ? '' : ' hidden'}`} aria-hidden={!props.shown}>
        <div className='vp-library-edit-label'>
            {nls.localize('vueport/library/preset/current', 'Currently Selected')}
        </div>
        <div className='vp-library-edit-stage'>
            {kind === 'cover'
                ? <BoxNet
                    onSelect={face => { edit(face).catch(() => undefined); }}
                    label={face => hint(boxFaceLabel(face))}
                    render={face => <BoxPicture face={face} src={pictureOf(face)} />}
                    extra={face => removeButton(face)}
                />
                : <div className='vp-library-edit-backdrop-cell'>
                    {/* cropped and washed as the head of the game's page is */}
                    <button
                        type='button'
                        className='vp-library-edit-backdrop'
                        style={background ? { backgroundImage: `url(${JSON.stringify(background)})` } : undefined}
                        onClick={() => { edit('background').catch(() => undefined); }}
                        title={hint(nls.localize('vueport/library/backgroundTab', 'Background'))}
                    >
                        <span className='vp-library-hero-wash' />
                    </button>
                    {removeButton('background')}
                </div>}
        </div>

        <div className='vp-library-presets-head'>
            <span className='vp-library-edit-label'>
                {nls.localize('vueport/library/preset/title', 'Presets')}
            </span>
            {/* only for an own set; the catalog's presets are named by the catalog */}
            {set && <label className='vp-library-preset-title'>
                <span className='vp-library-edit-label'>{nls.localize('vueport/status/title', 'Title')}</span>
                <input
                    className='vp-input'
                    type='text'
                    value={set.name}
                    spellCheck={false}
                    onChange={event => rename(set.id, event.target.value)}
                    onBlur={event => {
                        if (event.target.value.trim().length === 0) {
                            rename(set.id, freeName(draft.sets.filter(other => other.id !== set.id)));
                        }
                    }}
                />
            </label>}
        </div>
        <div className='vp-library-presets vp-scroll' role='radiogroup' ref={strip}>
            {presets.map(entry => <PresetTile
                key={entry.id}
                kind={kind}
                name={entry.name}
                picture={entry.pictures[thumbOf(kind)]}
                selected={draft.shown === entry.id}
                onSelect={() => props.onChange(current => ({ ...current, shown: entry.id }))}
            />)}
            {draft.sets.map(entry => <PresetTile
                key={entry.id}
                kind={kind}
                name={entry.name}
                picture={pictureIn(entry, presets, thumbOf(kind), urlOf)}
                selected={draft.shown === entry.id}
                onSelect={() => props.onChange(current => ({ ...current, shown: entry.id }))}
                onDelete={() => dropSet(entry.id)}
            />)}
            <button
                type='button'
                className='vp-library-preset add'
                onClick={() => makeSet()}
                title={kind === 'cover'
                    ? nls.localize('vueport/library/preset/newCover', 'A new custom cover, based on the one shown')
                    : nls.localize('vueport/library/preset/newBackground', 'A new custom background, based on the one shown')}
            >
                <span className={`vp-library-preset-thumb ${kind}`}><Plus size={20} /></span>
                <span className='vp-library-preset-name'>{nls.localize('vueport/library/preset/new', 'New')}</span>
            </button>
        </div>

        <input
            ref={file}
            type='file'
            accept='image/*'
            hidden
            onChange={event => {
                const chosen = event.target.files?.[0];
                event.target.value = '';
                const target = pending.current;
                if (chosen && target) {
                    updateSet(target.set, pictures => ({ ...pictures, [target.key]: chosen }));
                }
            }}
        />
    </div>;
}

function PresetTile(props: {
    kind: PictureKind,
    name: string,
    picture?: string,
    selected: boolean,
    onSelect: () => void,
    onDelete?: () => void,
}): React.JSX.Element {
    return <div className='vp-library-preset-cell'>
        <button
            type='button'
            role='radio'
            aria-checked={props.selected}
            className={`vp-library-preset${props.selected ? ' selected' : ''}`}
            onClick={props.onSelect}
            title={props.name}
        >
            {props.kind === 'cover'
                ? <BoxPicture face='front' src={props.picture} className='vp-library-preset-thumb cover' />
                : <span
                    className='vp-library-preset-thumb background'
                    style={props.picture ? { backgroundImage: `url(${JSON.stringify(props.picture)})` } : undefined}
                />}
            <span className='vp-library-preset-name'>{props.name}</span>
        </button>
        {props.onDelete && <button
            type='button'
            className='vp-library-edit-remove'
            onClick={props.onDelete}
            title={nls.localize('vueport/library/preset/delete', 'Delete this preset')}
            aria-label={nls.localize('vueport/library/preset/delete', 'Delete this preset')}
        ><X size={13} /></button>}
    </div>;
}

function thumbOf(kind: PictureKind): PictureKey {
    return kind === 'cover' ? 'front' : 'background';
}

function pictureIn(
    set: PictureDraftSet,
    presets: CatalogPreset[],
    key: PictureKey,
    urlOf: (picture: LibraryPicture | File | undefined) => string | undefined,
): string | undefined {
    const own = set.pictures[key];
    return own === null ? undefined : own ? urlOf(own) : presets.find(preset => preset.id === set.base)?.pictures[key];
}

function freeName(sets: PictureDraftSet[]): string {
    for (let n = 1; ; n++) {
        const name = nls.localize('vueport/library/preset/custom', 'Custom {0}', n);
        if (!sets.some(set => set.name === name)) {
            return name;
        }
    }
}

// object URLs for stored or just chosen pictures while the editor is open; a stored one is read on first request and
// the page redrawn once it is
function usePictureUrls(library: Library): (picture: LibraryPicture | File | undefined) => string | undefined {
    const urls = React.useRef(new Map<string | File, string>());
    const reading = React.useRef(new Set<string>());
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        const made = urls.current;
        return () => made.forEach(url => URL.revokeObjectURL(url));
    }, []);
    return picture => {
        if (!picture) {
            return undefined;
        }
        if (picture instanceof File) {
            let url = urls.current.get(picture);
            if (!url) {
                url = URL.createObjectURL(picture);
                urls.current.set(picture, url);
            }
            return url;
        }
        const stored = urls.current.get(picture.file);
        if (!stored && !reading.current.has(picture.file)) {
            reading.current.add(picture.file);
            library.readPicture(picture).then(blob => {
                if (blob) {
                    urls.current.set(picture.file, URL.createObjectURL(blob));
                    bump();
                }
            }).catch(() => undefined);
        }
        return stored;
    };
}

export function draftOf(library: Library, game: LibraryGame, kind: PictureKind): PictureDraft {
    const override = library.override(game.id);
    const sets = (kind === 'cover' ? override?.coverSets : override?.backgroundSets) ?? [];
    return {
        shown: game.shownSets[kind],
        sets: sets.map(set => ({ id: set.id, name: set.name, base: set.base, pictures: { ...set.pictures } })),
    };
}
