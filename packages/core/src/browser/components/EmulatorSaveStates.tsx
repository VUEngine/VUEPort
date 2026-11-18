import {
    ClockClockwise,
    ClockCountdown,
    Export,
    FileArrowUp,
    FloppyDisk,
    Image as ImageIcon,
    MoonStars,
    PencilSimple,
    Play,
    Trash,
    X,
} from '@phosphor-icons/react';
import * as React from 'react';
import { VueportNotifications } from '../../common/emulator-host';
import { nls } from '../../common/emulator-nls';
import { SaveStateKind } from '../../common/emulator-save-state';
import { SaveStateEntry, SaveStateStore, withOtherRomOffer } from '../emulator-save-state-store';
import EmptyContainer from './kit/EmptyContainer';

function kindLabel(kind: SaveStateKind): string {
    switch (kind) {
        case 'manual': return nls.localize('vueport/saveStates/kind/manual', 'Manual');
        case 'auto': return nls.localize('vueport/saveStates/kind/auto', 'Automatic');
        case 'suspend': return nls.localize('vueport/saveStates/kind/suspend', 'Suspended Game');
    }
}

function kindIcon(kind: SaveStateKind): React.ReactNode {
    switch (kind) {
        case 'manual': return <FloppyDisk size={13} />;
        case 'auto': return <ClockClockwise size={13} />;
        case 'suspend': return <MoonStars size={13} />;
    }
}

// the time alone for one taken today, as that tells this morning's states apart; the date too for older ones
function formatMoment(created: number): string {
    if (!created) {
        return nls.localize('vueport/saveStates/noDate', 'Date unknown');
    }
    const when = new Date(created);
    const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    const sameDay = when.getFullYear() === today.getFullYear()
        && when.getMonth() === today.getMonth()
        && when.getDate() === today.getDate();
    return sameDay
        ? nls.localize('vueport/saveStates/today', 'Today, {0}', time)
        : `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`;
}

// how long ago in the largest useful unit (`5 minutes ago`, `yesterday`), via Intl as languages phrase it differently.
// Shown beside the clock time: the age tells a session's states apart at a glance, the time still means something
// tomorrow
function formatElapsed(created: number): string | undefined {
    if (!created || typeof Intl.RelativeTimeFormat !== 'function') {
        return undefined;
    }
    // never in the future: a state from a machine whose clock runs ahead is still from the past
    const seconds = Math.min(0, Math.round((created - Date.now()) / 1000));
    const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const units: [Intl.RelativeTimeFormatUnit, number][] =
        [['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 5], ['month', 12]];
    let value = seconds;
    for (const [unit, span] of units) {
        if (Math.abs(value) < span) {
            return relative.format(value, unit);
        }
        value = Math.round(value / span);
    }
    return relative.format(value, 'year');
}

// line between name and badge; an unnamed state already shows its time as its name, so it gets only the age
function dateLine(entry: SaveStateEntry): string {
    return [
        entry.label !== undefined ? formatMoment(entry.created) : undefined,
        formatElapsed(entry.created),
    ].filter(part => part !== undefined).join(' · ');
}

// saving always makes a new state, told apart by picture and time; the picture is the button that loads it
export default function EmulatorSaveStates(props: {
    states: SaveStateStore,
    notifications: VueportNotifications,
    canSave: boolean,
    // hardcore forbids loading; saving and keeping states is still fine
    hardcore?: boolean,
    // the host takes the state, as it owns the notice and the flags to set
    onSave(): void,
    onLoad(entry: SaveStateEntry): void,
    onClose?: () => void,
}): React.JSX.Element {
    const { states, notifications, canSave, hardcore, onSave, onLoad, onClose } = props;
    const importInput = React.useRef<HTMLInputElement>(null);
    const [renaming, setRenaming] = React.useState<{ id: string, text: string } | undefined>(undefined);
    const [, setVersion] = React.useState(0);

    React.useEffect(() => {
        const subscription = states.onDidChange(() => setVersion(version => version + 1));
        return () => subscription.dispose();
    }, [states]);

    // also redrawn on a slow clock, so "just now" becomes "3 minutes ago" while open; half a minute is the coarsest
    // tick that never leaves a visibly stale line
    React.useEffect(() => {
        const clock = setInterval(() => setVersion(version => version + 1), 30000);
        return () => clearInterval(clock);
    }, []);

    const report = (error: unknown): void => notifications.error(
        error instanceof Error ? error.message : String(error));

    const remove = async (entry: SaveStateEntry): Promise<void> => {
        const name = entry.label ?? formatMoment(entry.created);
        const confirmed = await notifications.confirm({
            title: nls.localize('vueport/saveStates/deleteQuestion', 'Delete Save State?'),
            message: nls.localize(
                'vueport/saveStates/deleteConfirm',
                'Are you sure you want to delete {0}? This cannot be undone.',
                name,
            ),
            okLabel: nls.localize('vueport/general/delete', 'Delete'),
        });
        if (confirmed) {
            await states.remove(entry).catch(report);
        }
    };

    const commitRename = async (entry: SaveStateEntry, text: string): Promise<void> => {
        setRenaming(undefined);
        if ((entry.label ?? '') !== text.trim()) {
            await states.rename(entry, text).catch(report);
        }
    };

    const importFrom = async (files: FileList | null): Promise<void> => {
        const file = files?.[0];
        if (importInput.current) {
            importInput.current.value = '';
        }
        if (!file) {
            return;
        }
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const imported = await withOtherRomOffer(notifications, 'import',
                options => states.importState(file.name, bytes, options));
            if (imported) {
                notifications.info(nls.localize(
                    'vueport/saveStates/imported', 'Imported {0}.', file.name));
            }
        } catch (error) {
            notifications.error(nls.localize(
                'vueport/saveStates/importFailed',
                '{0} could not be imported: {1}',
                file.name,
                error instanceof Error ? error.message : String(error),
            ));
        }
    };

    const header = <div className='vp-panel-heading'>
        {onClose && <span className='vp-panel-heading-title'>
            <ClockCountdown size={22} />
            {nls.localize('vueport/saveStates/title', 'Save States')}
        </span>}
        {onClose && <button
            type='button'
            className='vp-panel-close'
            aria-label={nls.localize('vueport/saveStates/close', 'Close Save States')}
            onClick={onClose}
        >
            <X size={20} />
        </button>}
    </div>;

    const actions = <div className='vp-panel-actions'>
        <button className='vp-button' disabled={!canSave} onClick={() => onSave()}>
            <FloppyDisk size={16} />
            {nls.localize('vueport/saveStates/save', 'Save State')}
        </button>
        <button
            className='vp-button secondary'
            disabled={!states.attached}
            onClick={() => importInput.current?.click()}
        >
            <FileArrowUp size={16} />
            {nls.localize('vueport/saveStates/import', 'Import…')}
        </button>
        <input
            ref={importInput}
            type='file'
            accept='.state,application/octet-stream'
            hidden
            onChange={event => { importFrom(event.target.files); }}
        />
    </div>;

    const list = states.list;

    return <>
        {header}
        {list.length === 0
            ? <div className='vp-panel-empty-fill'>
                <EmptyContainer
                    title={nls.localize('vueport/saveStates/none', 'This game has no save states')}
                    description={nls.localize(
                        'vueport/saveStates/noneDescription',
                        'Save one to come back to this moment. Every save makes a new state, '
                        + 'with a picture of what was on screen.',
                    )}
                    icon={<ClockCountdown size={32} />}
                />
            </div>
            : <div className='vp-split-table vp-scroll'>
                <ul className='vp-panel-list'>
                    {list.map(entry => <li
                        key={entry.id}
                        className={'vp-panel-row vp-states-row'
                            + (entry.kind === 'suspend' ? ' suspended' : '')
                            + (canSave ? ' loadable' : '')}
                        onClick={() => {
                            if (canSave && renaming?.id !== entry.id) {
                                onLoad(entry);
                            }
                        }}
                    >
                        {/* the whole row loads; the picture stays a button for the keyboard and lets its click bubble
                            rather than loading twice. Dimmed in hardcore and with nothing running; the notice says why */}
                        <button
                            type='button'
                            className='vp-states-thumb'
                            disabled={!canSave}
                            aria-label={nls.localize(
                                'vueport/saveStates/loadNamed',
                                'Load {0}',
                                entry.label ?? formatMoment(entry.created),
                            )}
                        >
                            {entry.thumbnail
                                ? <img src={entry.thumbnail} alt='' />
                                : <ImageIcon size={24} />}
                            <span className='vp-states-thumb-play'>
                                <Play size={20} weight='fill' />
                            </span>
                        </button>
                        <span className='vp-states-summary'>
                            {renaming?.id === entry.id
                                ? <input
                                    className='vp-input vp-states-rename'
                                    autoFocus
                                    value={renaming.text}
                                    placeholder={formatMoment(entry.created)}
                                    onClick={event => event.stopPropagation()}
                                    onChange={event => setRenaming({ id: entry.id, text: event.target.value })}
                                    onBlur={() => commitRename(entry, renaming.text)}
                                    onKeyDown={event => {
                                        if (event.key === 'Enter') {
                                            commitRename(entry, renaming.text);
                                        } else if (event.key === 'Escape') {
                                            event.stopPropagation();
                                            setRenaming(undefined);
                                        }
                                    }}
                                />
                                : <span className='vp-panel-row-name'>
                                    {entry.label ?? formatMoment(entry.created)}
                                </span>}
                            <span className='vp-states-date'>{dateLine(entry)}</span>
                            <span className='vp-states-meta'>
                                <span className={`vp-states-badge ${entry.kind}`}>
                                    {kindIcon(entry.kind)}
                                    {kindLabel(entry.kind)}
                                </span>
                                {entry.machines > 1 &&
                                    ` · ${nls.localize('vueport/saveStates/linkedPair', 'Linked pair')}`}
                            </span>
                        </span>
                        <button
                            type='button'
                            className='vp-panel-row-action'
                            aria-label={nls.localize('vueport/saveStates/rename', 'Rename')}
                            onClick={event => {
                                event.stopPropagation();
                                setRenaming({ id: entry.id, text: entry.label ?? '' });
                            }}
                        >
                            <PencilSimple size={16} />
                        </button>
                        <button
                            type='button'
                            className='vp-panel-row-action'
                            aria-label={nls.localize('vueport/saveStates/export', 'Export')}
                            onClick={event => {
                                event.stopPropagation();
                                states.exportState(entry).catch(report);
                            }}
                        >
                            <Export size={16} />
                        </button>
                        <button
                            type='button'
                            className='vp-panel-row-action danger'
                            aria-label={nls.localize('vueport/saveStates/delete', 'Delete')}
                            onClick={event => {
                                event.stopPropagation();
                                remove(entry);
                            }}
                        >
                            <Trash size={16} />
                        </button>
                    </li>)}
                </ul>
            </div>}
        {hardcore && <p className='vp-panel-note'>
            {nls.localize(
                'vueport/saveStates/hardcoreNote',
                'Hardcore mode is on, so a state can be saved but not loaded.',
            )}
        </p>}
        {actions}
    </>;
}
