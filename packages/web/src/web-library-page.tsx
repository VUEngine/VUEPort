import * as React from 'react';
import {
    ArrowClockwise,
    ArrowSquareOut,
    CaretLeft,
    CheckCircle,
    CircleNotch,
    ClockCounterClockwise,
    DownloadSimple,
    PencilSimple,
    Play,
    PushPin,
    ShareNetwork,
    Star,
    Trash,
} from '@phosphor-icons/react';
import { pushEscapeLayer } from 'vueport-core/lib/browser/components/kit/escape-layers';
import { pushBackHandler } from 'vueport-core/lib/browser/back-navigation';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { LibraryCover } from './web-library-cover';
import { getScoreColor } from './web-score';

// one game's page, for local library games and catalog games alike. Which ROM runs is chosen here, as a game routinely
// has several (US beside JP, demo beside final, v1.1 beside v1.0)

export interface GamePageRom {
    id: string;
    title: string;
    // the ROM's own file name (the entry's inside an archive), to tell same-titled dumps apart. Absent where `title`
    // already is that name, and on a release not downloaded yet
    file?: string;
    detail: string;
    tag?: string;
    // only for the catalog's release list; on a game's own page the green belongs to the ROM that plays
    latest?: boolean;
    preferred?: boolean;
    onPlay: () => void;
    onResume?: () => void;
    onPrefer?: () => void;
    onEdit?: () => void; // absent for a catalog release, there is nothing to edit until it is downloaded
    onShare?: () => void; // as the page's own, but for this dump
    onImport?: () => void;
    importState?: ImportState;
}

export type ImportState = 'none' | 'busy' | 'done';

// one component for row and head, so a release already here is not offered again and one on its way says so
function ImportButton(props: {
    state: ImportState,
    label: string,
    onImport: () => void,
}): React.JSX.Element {
    switch (props.state) {
        case 'done':
            return <button type='button' className='vp-button secondary vp-library-import' data-pad-action disabled>
                <CheckCircle size={16} />
                {nls.localize('vueport/library/inLibrary', 'In library')}
            </button>;
        case 'busy':
            return <button type='button' className='vp-button secondary vp-library-import busy' data-pad-action disabled>
                <CircleNotch size={16} />
                {nls.localize('vueport/library/import/running', 'Importing…')}
            </button>;
        default:
            return <button type='button' className='vp-button secondary vp-library-import' data-pad-action onClick={props.onImport}>
                <DownloadSimple size={16} />
                {props.label}
            </button>;
    }
}

export interface GamePageProps {
    title: string;
    credit: string;
    playLine?: string; // absent for a game never started, and on the catalog's pages
    tags: { label: string, tone?: 'live' | 'warn' }[];
    // `kind` arrives translated, as this page knows neither the library nor the catalog
    marks?: { score?: number, kind?: string, unreleased?: boolean };
    description?: string;
    notes?: string;
    coverUrl?: string;
    ownCoverUrl?: string;
    backdropUrl?: string;
    facts: { label: string, value: string, edited?: boolean }[];
    planetVbUrl?: string;
    roms: GamePageRom[];
    romsTitle: string;
    emptyNote?: string;
    loading?: boolean;
    onBack: () => void;
    onResume?: () => void;
    onEdit?: () => void;
    favorite?: boolean; // absent when starring does not apply
    onFavorite?: () => void;
    onRefresh?: () => void;
    refreshing?: boolean;
    onRemove?: () => void;
    onImportAll?: () => void;
    importAllState?: ImportState;
    onShare?: () => void; // see NetworkSharesWindow; only where this computer can share, local games only
}

export function megabits(bytes: number): string {
    return nls.localize('vueport/welcome/mbit', '{0} MBit', Math.round((bytes * 8) / 1024 / 1024));
}

// clamped to a few lines, as Planet VB's descriptions run up to half a page. Whether anything is clipped is measured on
// the laid-out paragraph, again on every resize
function Blurb(props: { text: string }): React.JSX.Element {
    const [open, setOpen] = React.useState(false);
    const [clipped, setClipped] = React.useState(false);
    const text = React.useRef<HTMLParagraphElement>(null);

    React.useEffect(() => setOpen(false), [props.text]);

    React.useLayoutEffect(() => {
        const measure = (): void => {
            const element = text.current;
            if (element && !open) {
                setClipped(element.scrollHeight - element.clientHeight > 1);
            }
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [props.text, open]);

    return <div className='vp-library-detail-blurb'>
        <p ref={text} className={open ? 'open' : undefined}>{props.text}</p>
        {(clipped || open) && <button
            type='button'
            className='vp-library-read-all'
            onClick={() => setOpen(!open)}
        >{open
            ? nls.localize('vueport/library/readLess', 'Show less')
            : nls.localize('vueport/library/readAll', 'Read all')}</button>}
    </div>;
}

export function GamePage(props: GamePageProps): React.JSX.Element {
    // also when the preference names nothing that is here
    const first = props.roms.find(rom => rom.preferred) ?? props.roms[0];

    // on the escape stack, so a dialog over the page takes the key first. Capture phase, as the emulator reads keys off
    // the page and would take this one for a pad button too
    const { onBack } = props;
    React.useEffect(() => {
        const layer = pushEscapeLayer();
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && layer.isTop()) {
                event.preventDefault();
                event.stopPropagation();
                onBack();
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            layer.dispose();
        };
    }, [onBack]);
    // registered once through a ref, as the caller hands a fresh arrow each render and registering again would put the
    // page over a window opened on top of it
    const back = React.useRef(onBack);
    back.current = onBack;
    React.useEffect(() => pushBackHandler(() => back.current()), []);

    // the score only when the catalog has actually rated the game, same test as the card's badge
    const facts = [
        ...props.facts.filter(fact => fact.value),
        ...(getScoreColor(props.marks?.score) !== undefined
            ? [{ label: nls.localize('vueport/library/score', 'Score'), value: String(props.marks?.score) }]
            : []),
        ...(props.marks?.kind
            ? [{ label: nls.localize('vueport/library/kind/title', 'Type'), value: props.marks.kind }]
            : []),
        ...(props.marks?.unreleased
            ? [{
                label: nls.localize('vueport/library/status', 'Status'),
                value: nls.localize('vueport/library/unreleased', 'Unreleased'),
            }]
            : []),
    ];
    return <div className='vp-library-page vp-scroll'>
        <header
            className='vp-library-hero'
            style={props.backdropUrl
                ? { backgroundImage: `url(${JSON.stringify(props.backdropUrl)})` }
                : undefined}
        >
            <div className='vp-library-hero-wash' />
            <button className='vp-library-back' onClick={props.onBack}>
                <CaretLeft size={15} />
                {nls.localize('vueport/library/back', 'Library')}
            </button>
            <div className='vp-library-hero-body'>
                {/* the cover opens the same editor as the pencil, as the picture is what most users want to change */}
                {props.onEdit
                    ? <button
                        type='button'
                        className='vp-library-hero-cover'
                        onClick={props.onEdit}
                        title={nls.localize('vueport/library/edit', 'Edit')}
                        aria-label={nls.localize('vueport/library/edit', 'Edit')}
                    >
                        <LibraryCover
                            className='hero'
                            cover={{ ownCoverUrl: props.ownCoverUrl, catalogCoverUrl: props.coverUrl }}
                        />
                    </button>
                    : <LibraryCover
                        className='hero'
                        cover={{ ownCoverUrl: props.ownCoverUrl, catalogCoverUrl: props.coverUrl }}
                    />}
                <div className='vp-library-hero-text'>
                    <div className='vp-library-tags'>
                        {props.tags.map(tag => <span
                            key={tag.label}
                            className={`vp-library-tag${tag.tone ? ` ${tag.tone}` : ''}`}
                        >{tag.label}</span>)}
                    </div>
                    <h2>{props.title}</h2>
                    <p>{props.credit}</p>
                    {props.playLine && <p className='vp-library-hero-play'>
                        <ClockCounterClockwise size={14} />
                        {props.playLine}
                    </p>}
                    <div className='vp-library-hero-actions'>
                        {first && <button className='vp-button' onClick={first.onPlay}>
                            <Play size={18} weight='fill' />
                            {nls.localize('vueport/library/play', 'Play')}
                        </button>}
                        {props.onResume && <button className='vp-button secondary' onClick={props.onResume}>
                            <ClockCounterClockwise size={18} />
                            {nls.localize('vueport/library/resume', 'Resume')}
                        </button>}
                        {props.onFavorite && <button
                            type='button'
                            className={`vp-button secondary vp-library-star${props.favorite ? ' on' : ''}`}
                            onClick={props.onFavorite}
                            title={props.favorite
                                ? nls.localize('vueport/library/unstar', 'Remove from Favorites')
                                : nls.localize('vueport/library/star', 'Add to Favorites')}
                            aria-pressed={props.favorite}
                            aria-label={props.favorite
                                ? nls.localize('vueport/library/unstar', 'Remove from Favorites')
                                : nls.localize('vueport/library/star', 'Add to Favorites')}
                        >
                            <Star size={20} weight={props.favorite ? 'fill' : 'regular'} />
                        </button>}
                        {props.onShare && <button
                            type='button'
                            className='vp-button secondary vp-library-icon-action'
                            onClick={props.onShare}
                            title={nls.localize('vueport/library/share', 'Share')}
                            aria-label={nls.localize('vueport/library/share', 'Share')}
                        >
                            <ShareNetwork size={18} />
                        </button>}
                        {props.onImportAll && <ImportButton
                            state={props.importAllState ?? 'none'}
                            label={props.roms.length > 1
                                ? nls.localize('vueport/library/import/all', 'Import all')
                                : nls.localize('vueport/library/import/button', 'Import')}
                            onImport={props.onImportAll}
                        />}
                        {props.onEdit && <button
                            type='button'
                            className='vp-button secondary vp-library-icon-action'
                            onClick={props.onEdit}
                            title={nls.localize('vueport/library/edit', 'Edit')}
                            aria-label={nls.localize('vueport/library/edit', 'Edit')}
                        >
                            <PencilSimple size={18} />
                        </button>}
                        {props.onRefresh && <button
                            type='button'
                            className={`vp-button secondary vp-library-icon-action vp-library-refresh${props.refreshing ? ' busy' : ''}`}
                            onClick={props.onRefresh}
                            disabled={props.refreshing}
                            title={nls.localize('vueport/library/refresh/button', 'Reload from Planet VB')}
                            aria-label={nls.localize('vueport/library/refresh/button', 'Reload from Planet VB')}
                        >
                            <ArrowClockwise size={18} />
                        </button>}
                        {props.onRemove && <button
                            type='button'
                            className='vp-button secondary vp-library-icon-action'
                            onClick={props.onRemove}
                            title={nls.localize('vueport/library/removeGame/button', 'Remove from library')}
                            aria-label={nls.localize('vueport/library/removeGame/button', 'Remove from library')}
                        >
                            <Trash size={18} />
                        </button>}
                    </div>
                </div>
            </div>
        </header>

        <div className='vp-library-page-body'>
            {props.description && <Blurb text={props.description} />}
            {props.notes && <p className='vp-library-detail-notes'>{props.notes}</p>}

            {(facts.length > 0 || props.planetVbUrl) && <div className='vp-library-detail-about'>
                <dl className='vp-library-detail-facts'>
                    {facts.map(fact => <div key={fact.label}>
                        <dt>{fact.label}</dt>
                        <dd>
                            {fact.value}
                            {fact.edited && <span className='vp-library-edited'>
                                {nls.localize('vueport/library/editedHere', 'Edited here')}
                            </span>}
                        </dd>
                    </div>)}
                </dl>
                {props.planetVbUrl && <a href={props.planetVbUrl} target='_blank' rel='noreferrer'>
                    {nls.localize('vueport/library/onPlanetVb', 'View on Planet Virtual Boy')}
                    <ArrowSquareOut size={14} />
                </a>}
            </div>}

            <h3 className='vp-library-group'>{props.romsTitle}</h3>
            {props.loading
                ? <p className='vp-hint'>
                    {nls.localize('vueport/library/askingCatalog', 'Looking up…')}
                </p>
                : props.roms.length === 0
                    ? <p className='vp-hint'>
                        {props.emptyNote ?? nls.localize('vueport/library/nothingToPlay',
                            'Nothing here can be started.')}
                    </p>
                    : <ul className='vp-library-files'>
                        {/* `data-pad-card` and `data-pad-action` are what the pad steers by, see `onPad` in web-library-view.tsx */}
                        {props.roms.map(rom => <li
                            key={rom.id}
                            className={rom.preferred ? 'preferred' : undefined}
                            data-pad-card={rom.id}
                        >
                            <span className='vp-library-file-head'>
                                <span className='vp-library-file-title'>{rom.title}</span>
                                <button className='vp-button secondary' data-pad-action onClick={rom.onPlay}>
                                    <Play size={16} weight='fill' />
                                    {nls.localize('vueport/library/play', 'Play')}
                                </button>
                                {rom.onResume && <button className='vp-button secondary' data-pad-action onClick={rom.onResume}>
                                    <ClockCounterClockwise size={16} />
                                    {nls.localize('vueport/library/resume', 'Resume')}
                                </button>}
                                {rom.onImport && <ImportButton
                                    state={rom.importState ?? 'none'}
                                    label={nls.localize('vueport/library/import/button', 'Import')}
                                    onImport={rom.onImport}
                                />}
                            </span>
                            {rom.file && <span className='vp-library-file-line'>{rom.file}</span>}
                            <span className='vp-library-file-line'>{rom.detail}</span>
                            <span className='vp-library-file-actions'>
                                {rom.tag && <span
                                    className={`vp-library-tag${rom.latest ? ' live' : ''}`}
                                >{rom.tag}</span>}
                                {rom.preferred && <span className='vp-library-tag live'>
                                    {nls.localize('vueport/library/playsThis', 'Plays')}
                                </span>}
                                {rom.onPrefer && <button
                                    type='button'
                                    className='vp-library-file-prefer'
                                    data-pad-action
                                    onClick={rom.onPrefer}
                                    title={nls.localize('vueport/library/preferRom',
                                        'Play this ROM when I press Play')}
                                    aria-label={nls.localize('vueport/library/preferRom',
                                        'Play this ROM when I press Play')}
                                ><PushPin size={15} /></button>}
                                {rom.onShare && <button
                                    type='button'
                                    className='vp-library-file-share'
                                    data-pad-action
                                    onClick={rom.onShare}
                                    title={nls.localize('vueport/library/share', 'Share')}
                                    aria-label={nls.localize('vueport/library/share', 'Share')}
                                ><ShareNetwork size={15} /></button>}
                                {rom.onEdit && <button
                                    type='button'
                                    className='vp-library-file-edit'
                                    data-pad-action
                                    onClick={rom.onEdit}
                                    title={nls.localize('vueport/library/editRom', 'Edit this ROM')}
                                    aria-label={nls.localize('vueport/library/editRom', 'Edit this ROM')}
                                ><PencilSimple size={15} /></button>}
                            </span>
                        </li>)}
                    </ul>}
        </div>
    </div>;
}
