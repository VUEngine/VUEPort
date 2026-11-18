import {
    ArrowsClockwise,
    Bandaids,
    Check,
    Eye,
    FileArrowUp,
    Lock,
    MagnifyingGlass,
    PencilSimple,
    Trash,
    X,
} from '@phosphor-icons/react';
import * as React from 'react';
import { VueportNotifications } from '../../common/emulator-host';
import { nls } from '../../common/emulator-nls';
import {
    isColorPatch,
    RomPatch,
    RomPatchStatus,
    RomPatchType,
    ROM_PATCH_TYPES,
} from '../../common/emulator-rom-patches';
import { COLOR_EDIT_PATCH_ID } from '../../common/vb-color-package';
import { PatchStore, RomPatchMetadata } from '../emulator-patch-store';
import { RESTART_CONFIRM, confirmPatchRestart } from './patch-restart';
import EmptyContainer from './kit/EmptyContainer';
import {
    PanelDetailBadge,
    PanelDetailFacts,
    PanelDetailFooter,
    PanelDetailHero,
    PanelDetailSection,
    PanelDetailToolbar,
} from './kit/PanelDetail';
import Switch from './kit/Switch';

function typeLabel(type: RomPatchType): string {
    switch (type) {
        case 'hack': return nls.localize('vueport/patches/types/hack', 'Hack');
        case 'enhancement': return nls.localize('vueport/patches/types/enhancement', 'Enhancement');
        case 'compatibility': return nls.localize('vueport/patches/types/compatibility', 'Compatibility');
        case 'debug': return nls.localize('vueport/patches/types/debug', 'Debug');
        case 'trainer': return nls.localize('vueport/patches/types/trainer', 'Trainer');
        case 'translation': return nls.localize('vueport/patches/types/translation', 'Translation');
        case 'vb-color': return nls.localize('vueport/patches/types/vbColor', 'Color Patch');
    }
}

const VB_COLOR = 'VB Color';

// "VB" in red, then each letter of "Color" in its own color, like the VB Color logo. The brand is never translated;
// a name without it is shown unchanged
function colorPatchTitle(name: string): React.ReactNode {
    const at = name.indexOf(VB_COLOR);
    if (at < 0) {
        return name;
    }
    return <>
        {name.slice(0, at)}
        <span className='vp-vb-color'>
            <span>VB</span> {[...'Color'].map((letter, index) => <span key={index}>{letter}</span>)}
        </span>
        {name.slice(at + VB_COLOR.length)}
    </>;
}

function patchStatusLabel(status: RomPatchStatus): string {
    switch (status) {
        case 'complete':
            return nls.localize('vueport/patches/status/complete', 'Complete');
        case 'partial':
            return nls.localize('vueport/patches/status/partial', 'Partial');
        case 'wip':
            return nls.localize('vueport/patches/status/wip', 'In progress');
    }
}

export default function EmulatorPatches(props: {
    patches: PatchStore,
    notifications: VueportNotifications,
    // offers to turn the VB Color hardware on (restarting the game) before a colorization is switched on. Resolves to
    // whether it is on now
    ensureVbcSupport?: () => Promise<boolean>,
    onClose?: () => void,
}): React.JSX.Element {
    const { patches, notifications, ensureVbcSupport, onClose } = props;
    const importInput = React.useRef<HTMLInputElement>(null);
    const [editing, setEditing] = React.useState<number | undefined>(undefined);
    const [filter, setFilter] = React.useState('');
    const fieldId = React.useId();
    const [, setVersion] = React.useState(0);

    React.useEffect(() => {
        const subscription = patches.onDidChange(() => setVersion(version => version + 1));
        return () => subscription.dispose();
    }, [patches]);

    const reportError = (patch: RomPatch, error: unknown): void =>
        notifications.error(nls.localize(
            'vueport/patches/applyFailed',
            '{0} could not be applied: {1}',
            patch.name,
            error instanceof Error ? error.message : String(error),
        ));

    // asks for VB Color support, as a colorization has nothing to draw with otherwise, and returns notes for the
    // restart question, such as the game's other colorization going, as only one can be on. Undefined when support was
    // refused
    const colorNotes = async (patch: RomPatch): Promise<string[] | undefined> => {
        if (ensureVbcSupport && !await ensureVbcSupport()) {
            return undefined;
        }
        const replaced = patches.list.find(other => isColorPatch(other) && other.enabled && other.id !== patch.id);
        return replaced
            ? [nls.localize(
                'vueport/vbColor/applyReplaces',
                'Only one color patch can be applied at a time, so {0} is switched off.',
                replaced.name)]
            : [];
    };

    // see confirmPatchRestart and, for a colorization, colorNotes
    const toggle = async (index: number): Promise<void> => {
        const patch = patches.list[index];
        if (!patch) {
            return;
        }
        const enable = !patch.enabled;
        const notes = isColorPatch(patch) && enable ? await colorNotes(patch) : [];
        if (!notes || !await confirmPatchRestart(notifications, enable, notes)) {
            return;
        }
        // found again, as the list may have moved on while the questions were open, and turning VB Color on restarts
        // the game
        const now = patches.list.findIndex(candidate => candidate === patch
            || (patch.id !== undefined && candidate.id === patch.id));
        if (now < 0 || patches.list[now].enabled !== patch.enabled) {
            return;
        }
        try {
            patches.setEnabled(now, enable);
        } catch (error) {
            reportError(patch, error);
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
            const index = patches.importPatch(file.name, new Uint8Array(await file.arrayBuffer()));
            setEditing(index);
            notifications.info(nls.localize(
                'vueport/patches/imported',
                'Imported {0}. The patch is disabled until you enable it.',
                file.name,
            ));
        } catch (error) {
            notifications.error(nls.localize(
                'vueport/patches/importFailed',
                '{0} could not be imported: {1}',
                file.name,
                error instanceof Error ? error.message : String(error),
            ));
        }
    };

    const remove = async (index: number): Promise<void> => {
        const patch = patches.list[index];
        if (!patch || patch.builtIn) {
            return;
        }
        const confirmed = await notifications.confirm({
            title: nls.localize('vueport/patches/removeQuestion', 'Remove Patch?'),
            message: [
                nls.localize(
                    'vueport/patches/removeConfirm',
                    'Are you sure you want to remove {0}?',
                    patch.name,
                ),
                // the color editor's build is only the build: say so, or removing it reads as throwing the paint away
                ...(patch.id === COLOR_EDIT_PATCH_ID ? [nls.localize(
                    'vueport/vbColor/removeEditBuild',
                    'Your paint stays in the VB Color Editor, where it can be built again.',
                )] : []),
                // taking an applied patch away is switching it off as well
                ...(patch.enabled ? [RESTART_CONFIRM()] : []),
            ],
        });
        if (confirmed) {
            patches.remove(index);
            setEditing(undefined);
        }
    };

    const actions = <div className='vp-panel-actions'>
        <button className='vp-button secondary' onClick={() => importInput.current?.click()}>
            <FileArrowUp size={16} />
            {nls.localize('vueport/patches/import', 'Import Patch…')}
        </button>
        <input
            ref={importInput}
            type='file'
            accept='.ips,.ups,.bps,.bdf,.bspatch,application/octet-stream'
            hidden
            onChange={event => { importFrom(event.target.files); }}
        />
    </div>;

    const header = <div className='vp-panel-heading'>
        {onClose && <span className='vp-panel-heading-title'>
            <Bandaids size={22} />
            {nls.localize('vueport/patches/title', 'Patches')}
        </span>}
        {onClose && <button
            type='button'
            className='vp-panel-close'
            aria-label={nls.localize('vueport/patches/close', 'Close Patches')}
            onClick={onClose}
        >
            <X size={20} />
        </button>}
    </div>;

    const list = patches.list;
    const rows = list.map((patch, index) => ({ patch, index }));
    const selected = editing === undefined ? undefined : list[editing];

    if (selected && editing !== undefined) {
        // the color editor's build can be removed, but its name, description and type are the editor's
        const removable = !selected.builtIn;
        const editable = removable && selected.id !== COLOR_EDIT_PATCH_ID;
        const set = (metadata: Partial<RomPatchMetadata>): void =>
            patches.updateMetadata(editing, metadata);
        // a patch that is on and becomes, or stops being, a colorization is applied differently, which restarts the
        // game, so that is asked first, like a switch
        const setType = async (type: RomPatchType): Promise<void> => {
            const color = isColorPatch({ type });
            if (selected.enabled && color !== isColorPatch(selected)) {
                const notes = color ? await colorNotes(selected) : [];
                if (!notes || !await confirmPatchRestart(notifications, true, notes)) {
                    return;
                }
            }
            // found again, as in toggle: the questions may have taken a while
            const now = patches.list.findIndex(candidate => candidate.id === selected.id);
            try {
                patches.updateMetadata(now, { type });
            } catch (error) {
                reportError(selected, error);
            }
        };
        const format = selected.format === 'bsdiff' ? 'BSDiff' : selected.format.toUpperCase();
        return <>
            <PanelDetailToolbar
                list={nls.localize('vueport/patches/title', 'Patches')}
                index={editing}
                count={list.length}
                onBack={() => setEditing(undefined)}
                onStep={setEditing}
            />
            <div className='vp-panel-detail vp-scroll'>
                <div className='vp-detail-page'>
                    <PanelDetailHero
                        icon={<Bandaids size={22} />}
                        name={selected.name}
                        title={isColorPatch(selected) ? colorPatchTitle(selected.name) : undefined}
                        onRename={editable ? name => set({ name }) : undefined}
                        meta={typeLabel(selected.type)}
                        badges={(selected.builtIn || selected.status) && <>
                            {selected.builtIn && <PanelDetailBadge icon={<Lock size={12} />}>
                                {nls.localize('vueport/patches/builtIn', 'Ships with VUEPort')}
                            </PanelDetailBadge>}
                            {selected.status && <PanelDetailBadge
                                icon={<span className={`vp-detail-badge-dot ${selected.status}`} />}
                            >
                                {patchStatusLabel(selected.status)}
                            </PanelDetailBadge>}
                        </>}
                        control={<Switch
                            label={nls.localize('vueport/patches/enabled', 'Enabled')}
                            value={selected.enabled}
                            onChange={() => { toggle(editing); }}
                        />}
                    />
                    {/* said before the switch is thrown, not only in the dialog after, as the restart is the whole cost
                        of it */}
                    <p className='vp-detail-notice'>
                        <ArrowsClockwise size={15} aria-hidden='true' />
                        {nls.localize('vueport/patches/restartHint',
                            'Switching a patch on or off restarts the game.')}
                    </p>
                    {editable &&
                        <PanelDetailSection title={nls.localize('vueport/patches/type', 'Type')}>
                            <div
                                className='vp-detail-pills'
                                role='group'
                                aria-label={nls.localize('vueport/patches/type', 'Type')}
                            >
                                {ROM_PATCH_TYPES.map(type => {
                                    const chosen = selected.type === type;
                                    return <button
                                        key={type}
                                        type='button'
                                        aria-pressed={chosen}
                                        className={'vp-detail-pill' + (chosen ? ' selected' : '')}
                                        onClick={() => { setType(type); }}
                                    >
                                        {chosen && <Check size={13} />}
                                        {typeLabel(type)}
                                    </button>;
                                })}
                            </div>
                        </PanelDetailSection>}
                    {editable &&
                        <PanelDetailSection
                            title={nls.localize('vueport/patches/author', 'Author')}
                            htmlFor={`${fieldId}-author`}
                        >
                            <input
                                id={`${fieldId}-author`}
                                className='vp-input'
                                value={selected.author ?? ''}
                                placeholder={nls.localize('vueport/patches/unknownAuthor', 'Unknown')}
                                onChange={event => set({ author: event.target.value || undefined })}
                            />
                        </PanelDetailSection>}
                    {(editable || selected.description) &&
                        <PanelDetailSection
                            title={nls.localize('vueport/patches/description', 'Description')}
                            htmlFor={editable ? `${fieldId}-description` : undefined}
                        >
                            {editable
                                ? <textarea
                                    id={`${fieldId}-description`}
                                    className='vp-input vp-detail-textarea'
                                    rows={4}
                                    value={selected.description ?? ''}
                                    placeholder={nls.localize(
                                        'vueport/patches/descriptionPlaceholder',
                                        'What this patch changes',
                                    )}
                                    onChange={event => set({ description: event.target.value || undefined })}
                                />
                                : <p className='vp-detail-text'>{selected.description}</p>}
                        </PanelDetailSection>}
                    <PanelDetailSection title={nls.localize('vueport/patches/patch', 'Patch')}>
                        <PanelDetailFacts rows={[
                            [nls.localize('vueport/patches/author', 'Author'), editable ? undefined : selected.author],
                            [nls.localize('vueport/vbColor/version', 'Version'), selected.version, true],
                            [nls.localize('vueport/patches/file', 'File'), selected.fileName, true],
                            [nls.localize('vueport/patches/format', 'Format'), <span className='vp-detail-chip'>{format}</span>],
                        ]} />
                    </PanelDetailSection>
                    {(isColorPatch(selected) || removable) &&
                        <PanelDetailFooter
                            hint={isColorPatch(selected) && nls.localize('vueport/vbColor/onlyOne',
                                'Only one color patch can be on at a time.')}
                        >
                            {removable &&
                                <button className='vp-button secondary danger' onClick={() => remove(editing)}>
                                    <Trash size={14} />
                                    {nls.localize('vueport/patches/remove', 'Remove Patch')}
                                </button>}
                        </PanelDetailFooter>}
                </div>
            </div>
        </>;
    }

    const needle = filter.trim().toLowerCase();
    const visible = rows
        .filter(({ patch }) => !needle || [patch.name, patch.author, patch.description]
            .some(text => text?.toLowerCase().includes(needle)));

    return <>
        {header}
        {rows.length === 0
            ? <div className='vp-panel-empty-fill'>
                <EmptyContainer
                    title={nls.localize('vueport/patches/none', 'No patches are registered for this ROM')}
                    description={nls.localize(
                        'vueport/patches/noneDescription',
                        'Import an IPS, UPS, BPS or BSDiff patch to add one.',
                    )}
                    icon={<Bandaids size={32} />}
                />
            </div>
            : <>
                <div className='vp-panel-filter'>
                    <MagnifyingGlass size={15} />
                    <input
                        type='text'
                        spellCheck={false}
                        value={filter}
                        placeholder={nls.localize('vueport/patches/filter', 'Filter')}
                        aria-label={nls.localize('vueport/patches/filter', 'Filter')}
                        onChange={event => setFilter(event.target.value)}
                    />
                    {filter &&
                        <button
                            type='button'
                            className='vp-panel-filter-clear'
                            aria-label={nls.localize('vueport/general/clear', 'Clear')}
                            onClick={() => setFilter('')}
                        >
                            <X size={14} />
                        </button>}
                </div>
                <div className='vp-split-table vp-scroll'>
                    {visible.length === 0
                        ? <p className='vp-panel-empty'>
                            {nls.localize('vueport/patches/noMatch', 'No patches match “{0}”.', filter.trim())}
                        </p>
                        : <ul className='vp-panel-list'>
                            {visible.map(({ patch, index }) => <li
                                key={patch.id ?? `${patch.fileName}-${index}`}
                                className={'vp-panel-row vp-patches-row'
                                    + (isColorPatch(patch) ? ' vp-patches-color' : '')
                                    + (patch.enabled ? ' enabled' : '')}
                                onClick={() => { toggle(index); }}
                            >
                                <button
                                    type='button'
                                    role='switch'
                                    aria-checked={patch.enabled}
                                    aria-label={patch.name}
                                    className='vp-switch'
                                    onClick={event => {
                                        event.stopPropagation();
                                        toggle(index);
                                    }}
                                >
                                    <span className='vp-switch-knob' />
                                </button>
                                <span className='vp-panel-row-summary'>
                                    {/* a colorization reads as one at a glance: the VB Color logo in its name, and the
                                        kind first in the line under it */}
                                    <span className='vp-panel-row-name'>
                                        {isColorPatch(patch) ? colorPatchTitle(patch.name) : patch.name}
                                    </span>
                                    <span className='vp-patches-meta'>
                                        {typeLabel(patch.type)}
                                        {patch.status && ` · ${patchStatusLabel(patch.status)}`}
                                        {patch.author && ` · ${patch.author}`}
                                        {patch.version && ` · ${patch.version}`}
                                        {!patch.builtIn && ` · ${patch.fileName}`}
                                    </span>
                                    {patch.description &&
                                        <span className='vp-panel-row-notes'>{patch.description}</span>}
                                </span>
                                <button
                                    type='button'
                                    className='vp-panel-row-action'
                                    aria-label={patch.builtIn
                                        ? nls.localize('vueport/patches/viewNamed', 'View {0}', patch.name)
                                        : nls.localize('vueport/patches/editNamed', 'Edit {0}', patch.name)}
                                    onClick={event => {
                                        event.stopPropagation();
                                        setEditing(index);
                                    }}
                                >
                                    {patch.builtIn ? <Eye size={18} /> : <PencilSimple size={18} />}
                                </button>
                                {!patch.builtIn && <button
                                    type='button'
                                    className='vp-panel-row-action danger'
                                    aria-label={nls.localize('vueport/patches/removeNamed', 'Remove {0}', patch.name)}
                                    onClick={event => {
                                        event.stopPropagation();
                                        remove(index);
                                    }}
                                >
                                    <Trash size={16} />
                                </button>}
                            </li>)}
                        </ul>}
                </div>
            </>}
        {actions}
    </>;
}
