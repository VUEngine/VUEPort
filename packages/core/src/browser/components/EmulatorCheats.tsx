import { ArrowRight, Eye, Lock, MagnifyingGlass, PencilSimple, Plus, Star, StarHalf, Trash, X } from '@phosphor-icons/react';
import * as React from 'react';
import {
    CHEAT_DEFAULT_DIGITS,
    CHEAT_DIGITS,
    parseVesCheatCode,
    parseVesCheatFile,
    Cheat,
    CheatCode,
    vesCheatMaxValue
} from '../../common/emulator-cheats';
import { VueportNotifications } from '../../common/emulator-host';
import { nls } from '../../common/emulator-nls';
import { CheatFinder } from '../emulator-cheat-finder';
import { CheatStore } from '../emulator-cheat-store';
import EmulatorCheatFinder from './EmulatorCheatFinder';
import EmptyContainer from './kit/EmptyContainer';
import {
    PanelDetailBadge,
    PanelDetailFooter,
    PanelDetailHero,
    PanelDetailSection,
    PanelDetailToolbar,
} from './kit/PanelDetail';
import RadioSelect from './kit/RadioSelect';
import Switch from './kit/Switch';
import styled from 'styled-components';

const StyledCloseButton = styled.button`
    position: relative;
    z-index: 10;
`;

// what a new cheat, and a new code, start out as
const NEW_CHEAT_ADDRESS = 0x05000000;

// cheats are named sets of writes the core repeats every frame. Everything here edits the store, which owns the list,
// writes the file and pushes enabled writes into the core, so a cheat stays on with this closed. A component rather
// than a panel, as it is docked in Debug mode but sits beside the screen while playing
export default function EmulatorCheats(props: {
    cheats: CheatStore,
    // see EmulatorCheatFinder
    finder: CheatFinder,
    notifications: VueportNotifications,
    // given for the strip beside the screen, which has no chrome to close it by; the docked panel has its tab
    onClose?: () => void,
    // whose machine the debugger points at during a link session, only for peerNote: the switches always belong to
    // this window's own player
    inspecting?: 'own' | 'peer',
}): React.JSX.Element {
    const { cheats, finder, notifications, onClose, inspecting } = props;

    // Find searches whichever machine the debugger points at, but the switches do not: a cheat belongs to the player
    // who switched it on and reaches the other window as a change to their mirror of this machine. Said out loud, as
    // the two halves of the panel behave differently
    const peerNote = inspecting === 'peer' && <div className='vp-panel-note'>
        {nls.localize(
            'vueport/cheats/ownMachineOnly',
            'These switches apply to your own machine. The search below follows the'
            + " debugger, which is on the other player's.",
        )}
    </div>;

    const closeButton = onClose && <StyledCloseButton
        type='button'
        className='vp-panel-close'
        aria-label={nls.localize('vueport/cheats/closeCheats', 'Close Cheats')}
        onClick={onClose}
    >
        <X size={20} />
    </StyledCloseButton>;
    // the editor takes the whole panel, as a form squeezed under the list would have no room
    const [editing, setEditing] = React.useState<number | undefined>(undefined);
    // a third full-panel view, as a search is a form with a table. It is for adding to this list, so it lives here,
    // which also makes it reachable while playing, not only in Debug mode
    const [finding, setFinding] = React.useState(false);
    const [filter, setFilter] = React.useState('');
    const importInput = React.useRef<HTMLInputElement>(null);
    const fieldId = React.useId();
    const [, setVersion] = React.useState(0);
    const redraw = React.useCallback(() => setVersion(version => version + 1), []);

    // the store says when the list changed: a cheat turned on from the other copy of this, or a new ROM's file loaded
    React.useEffect(() => {
        const subscription = cheats.onDidChange(redraw);
        return () => subscription.dispose();
    }, [cheats, redraw]);

    const list = cheats.list;
    // index rather than identity, as that is how the store is addressed, and why removing one closes the editor
    const selected = editing ?? 0;
    const cheat = list[selected];

    const addCheat = (): void =>
        setEditing(cheats.add(nls.localize('vueport/cheats/newCheat', 'New cheat')));

    // cheats from a picked .cht file arrive off, whatever the file said, and the picker is reset so choosing the same
    // file twice fires again
    const importFrom = async (files: FileList | null): Promise<void> => {
        const file = files?.[0];
        if (importInput.current) {
            importInput.current.value = '';
        }
        if (!file) {
            return;
        }
        let added: number;
        try {
            added = cheats.importCheats(parseVesCheatFile(await file.text()));
        } catch {
            notifications.error(nls.localize('vueport/cheats/importFailed',
                '{0} could not be read as a cheat file.', file.name));
            return;
        }
        if (added === 0) {
            notifications.warn(nls.localize('vueport/cheats/importedNone',
                'No cheats were found in {0}.', file.name));
            return;
        }
        notifications.info(added === 1
            ? nls.localize('vueport/cheats/importedOne', 'Imported 1 cheat from {0}.', file.name)
            : nls.localize('vueport/cheats/importedMany',
                'Imported {0} cheats from {1}.', String(added), file.name));
    };

    const actions = <div className='vp-panel-actions'>
        <button className='vp-button secondary' onClick={addCheat}>
            <Plus size={16} />
            {nls.localize('vueport/cheats/addCheat', 'Add Cheat')}
        </button>
        {/* for a user with no address to type; beside Add, as it is how a cheat is arrived at */}
        <button className='vp-button secondary' onClick={() => setFinding(true)}>
            <MagnifyingGlass size={16} />
            {nls.localize('vueport/cheats/find', 'Find…')}
        </button>
        <button className='vp-button secondary' onClick={() => importInput.current?.click()}>
            {nls.localize('vueport/cheats/import', 'Import…')}
        </button>
        <input
            ref={importInput}
            type='file'
            accept='.cht,text/plain'
            hidden
            onChange={event => importFrom(event.target.files)}
        />
    </div>;

    // the title is for the strip beside the screen, which has no tab naming it; docked, it is just the count
    const header = <div className='vp-panel-heading'>
        {onClose &&
            <span className='vp-panel-heading-title'>
                <Star size={22} />
                {nls.localize('vueport/cheats/title', 'Cheats')}
            </span>}
        {closeButton}
    </div>;

    // confirmed first, as the delete button sits beside an often-clicked checkbox, a cheat is typed by hand, nothing
    // can be undone, and removing the last one takes the file with it
    const removeCheat = async (index: number): Promise<void> => {
        const doomed = cheats.list[index];
        // a shipped cheat is not the player's to delete. The button is not offered for one either; this is the guard
        if (!doomed || doomed.builtIn) {
            return;
        }
        // hoisted out of the message's arguments, as the extractor stops descending at a matched localize call, so a
        // nested one never reaches nls.json
        const unnamed = nls.localize('vueport/cheats/thisCheat', 'this cheat');
        const confirmed = await notifications.confirm({
            title: nls.localize('vueport/cheats/deleteCheatQuestion', 'Delete Cheat?'),
            message: nls.localize(
                'vueport/cheats/areYouSureYouWantToDelete',
                'Are you sure you want to delete {0}?',
                doomed.description || unnamed,
            ),
        });
        if (confirmed) {
            cheats.remove(index);
            // back to the list: the edited cheat is gone, and every index after it now means a different one
            setEditing(undefined);
        }
    };

    // drops it when code is undefined
    const setCode = (owner: Cheat, index: number, code: CheatCode | undefined): void => {
        const codes = [...owner.codes];
        if (code) {
            codes[index] = code;
        } else {
            codes.splice(index, 1);
        }
        cheats.update(selected, { codes });
    };

    const addCode = (owner: Cheat): void => {
        cheats.update(selected, {
            codes: [
                ...owner.codes,
                { address: NEW_CHEAT_ADDRESS, value: 0, digits: CHEAT_DEFAULT_DIGITS },
            ],
        });
    };

    // space, comma and the file format's own + all separate codes, so a published line or block pastes in one go
    const parsePastedCodes = (text: string): CheatCode[] =>
        text.split(/[\s,+]+/)
            .map(parseVesCheatCode)
            .filter((parsed): parsed is CheatCode => parsed !== undefined);

    // what's in the paste box, so Add Code can pick it up without pressing Enter first
    const pasteRef = React.useRef<HTMLInputElement>(null);

    const addCodeOrPasted = (owner: Cheat): void => {
        const box = pasteRef.current;
        const pastedCodes = box ? parsePastedCodes(box.value) : [];
        if (pastedCodes.length > 0) {
            cheats.update(selected, { codes: [...owner.codes, ...pastedCodes] });
            box!.value = '';
            return;
        }
        addCode(owner);
    };

    const hexPlaceholder = (code: CheatCode): string =>
        (code.value >>> 0).toString(16).toUpperCase().padStart(code.digits, '0');

    // the hex field re-pads on every commit, which would jump the cursor to the end on every keystroke, so while
    // focused it shows exactly what was typed and only pads and commits on blur (Enter just blurs)
    const [hexDraft, setHexDraft] = React.useState<{ index: number, text: string } | undefined>(undefined);

    const commitHexDraft = (owner: Cheat, index: number, code: CheatCode): void => {
        if (hexDraft?.index !== index) {
            return;
        }
        const value = parseInt(hexDraft.text, 16);
        if (!Number.isNaN(value)) {
            setCode(owner, index, { ...code, value: Math.min(vesCheatMaxValue(code.digits), value >>> 0) });
        }
        setHexDraft(undefined);
    };

    const addressPlaceholder = (code: CheatCode): string =>
        (code.address >>> 0).toString(16).toUpperCase();

    // the same trouble and fix as the hex field: >>> 0 drops leading zeroes as the address changes
    const [addressDraft, setAddressDraft] = React.useState<{ index: number, text: string } | undefined>(undefined);

    const commitAddressDraft = (owner: Cheat, index: number, code: CheatCode): void => {
        if (addressDraft?.index !== index) {
            return;
        }
        const address = parseInt(addressDraft.text, 16);
        if (!Number.isNaN(address)) {
            setCode(owner, index, { ...code, address: address >>> 0 });
        }
        setAddressDraft(undefined);
    };

    // one entry per write: address and value on one line, width under it. Hex and decimal side by side, both the same
    // code.value, so editing either writes through. The width is its own row of three buttons, as there is no room
    // for them beside four fields in the strip beside the screen
    const renderCodes = (owner: Cheat): React.ReactNode =>
        <div className='vp-detail-card vp-cheats-codes'>
            {owner.codes.length > 0 &&
                <div className='vp-cheats-code vp-cheats-code-header' aria-hidden='true'>
                    <span>{nls.localize('vueport/cheats/address', 'Address')}</span>
                    <span />
                    <span>{nls.localize('vueport/cheats/hex', 'Hex')}</span>
                    <span>{nls.localize('vueport/cheats/decimal', 'Decimal')}</span>
                    <span />
                </div>}
            {owner.codes.map((code, index) => (
                <div className='vp-cheats-code-entry' key={index}>
                    <div className='vp-cheats-code'>
                        {/* the 0x is drawn over the field, so the field holds only the digits that parse */}
                        <span className='vp-cheats-address'>
                            <span className='prefix' aria-hidden='true'>0x</span>
                            <input
                                className='vp-input address'
                                value={addressDraft?.index === index ? addressDraft.text : addressPlaceholder(code)}
                                spellCheck={false}
                                aria-label={nls.localize('vueport/cheats/addressHint', 'Address to write to, in hexadecimal')}
                                readOnly={owner.builtIn}
                                onFocus={() => setAddressDraft({ index, text: addressPlaceholder(code) })}
                                onChange={e => setAddressDraft({ index, text: e.target.value })}
                                onBlur={() => commitAddressDraft(owner, index, code)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        e.currentTarget.blur();
                                    }
                                }}
                            />
                        </span>
                        <ArrowRight size={14} className='vp-cheats-arrow' aria-hidden='true' />
                        <input
                            className='vp-input hex'
                            value={hexDraft?.index === index ? hexDraft.text : hexPlaceholder(code)}
                            spellCheck={false}
                            aria-label={nls.localize('vueport/cheats/valueHint', 'Value to write, in hexadecimal')}
                            readOnly={owner.builtIn}
                            onFocus={() => setHexDraft({ index, text: hexPlaceholder(code) })}
                            onChange={e => setHexDraft({ index, text: e.target.value })}
                            onBlur={() => commitHexDraft(owner, index, code)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    e.currentTarget.blur();
                                }
                            }}
                        />
                        <input
                            className='vp-input decimal'
                            value={(code.value >>> 0).toString(10)}
                            spellCheck={false}
                            aria-label={nls.localize('vueport/cheats/valueDecimalHint', 'Value to write, in decimal')}
                            readOnly={owner.builtIn}
                            onChange={e => {
                                const value = parseInt(e.target.value, 10);
                                if (!Number.isNaN(value) && value >= 0) {
                                    setCode(owner, index, {
                                        ...code,
                                        value: Math.min(vesCheatMaxValue(code.digits), value >>> 0),
                                    });
                                }
                            }}
                        />
                        {owner.builtIn
                            ? <span />
                            : <button
                                type='button'
                                className='vp-cheats-remove'
                                aria-label={nls.localize('vueport/cheats/removeCode', 'Remove code')}
                                title={nls.localize('vueport/cheats/removeCode', 'Remove code')}
                                onClick={() => setCode(owner, index, undefined)}
                            >
                                <Trash size={14} />
                            </button>}
                    </div>
                    <div className='vp-cheats-width' title={nls.localize('vueport/cheats/widthHint', 'How wide the write is')}>
                        <span>{nls.localize('vueport/cheats/width', 'Width')}</span>
                        <RadioSelect
                            options={CHEAT_DIGITS.map(digits => ({ value: digits, label: `${digits * 4}` }))}
                            defaultValue={code.digits}
                            disabled={owner.builtIn}
                            onChange={([option]) => {
                                const digits = Number(option.value);
                                setCode(owner, index, {
                                    ...code,
                                    digits,
                                    value: Math.min(vesCheatMaxValue(digits), code.value),
                                });
                            }}
                        />
                        <span>bit</span>
                    </div>
                </div>
            ))}
            {!owner.builtIn && <div className='vp-cheats-code-add'>
                <input
                    ref={pasteRef}
                    className='vp-input paste'
                    placeholder={nls.localize('vueport/cheats/paste',
                        'Paste one or more codes, e.g. 50091A4:0001, 50091A6:0002')}
                    aria-label={nls.localize('vueport/cheats/paste',
                        'Paste one or more codes, e.g. 50091A4:0001, 50091A6:0002')}
                    spellCheck={false}
                    onKeyDown={e => {
                        if (e.key !== 'Enter') {
                            return;
                        }
                        const pastedCodes = parsePastedCodes(e.currentTarget.value);
                        if (pastedCodes.length > 0) {
                            cheats.update(selected, { codes: [...owner.codes, ...pastedCodes] });
                            e.currentTarget.value = '';
                        }
                    }}
                />
                <button className='vp-button secondary' onClick={() => addCodeOrPasted(owner)}>
                    <Plus size={16} />
                    {nls.localize('vueport/cheats/addCode', 'Add Code')}
                </button>
            </div>}
        </div>;

    const renderDetail = (owner: Cheat): React.ReactNode =>
        <div className='vp-detail-page'>
            <PanelDetailHero
                icon={<Star size={22} weight='fill' />}
                name={owner.description}
                // a shipped cheat's name and writes are the database's to say, so they are shown but not editable
                onRename={owner.builtIn ? undefined : description => cheats.update(selected, { description })}
                meta={owner.codes.length === 1
                    ? nls.localize('vueport/cheats/codeCountOne', '1 code')
                    : nls.localize('vueport/cheats/codeCountMany', '{0} codes', owner.codes.length)}
                badges={owner.builtIn && <PanelDetailBadge icon={<Lock size={12} />}>
                    {nls.localize('vueport/cheats/builtIn', 'Ships with the emulator')}
                </PanelDetailBadge>}
                control={<Switch
                    label={nls.localize('vueport/cheats/enabled', 'Enabled')}
                    value={owner.enabled}
                    onChange={enabled => cheats.update(selected, { enabled })}
                />}
            />
            {/* a shipped cheat with nothing to say gets no empty, unusable box; the player's own always gets one */}
            {(owner.notes || !owner.builtIn) &&
                <PanelDetailSection
                    title={nls.localize('vueport/cheats/description', 'Description')}
                    htmlFor={owner.builtIn ? undefined : `${fieldId}-notes`}
                >
                    {owner.builtIn
                        ? <p className='vp-detail-text'>{owner.notes}</p>
                        : <textarea
                            id={`${fieldId}-notes`}
                            className='vp-input vp-detail-textarea'
                            rows={4}
                            value={owner.notes ?? ''}
                            placeholder={nls.localize(
                                'vueport/cheats/notesPlaceholder',
                                'What this cheat does, or when it does not work')}
                            onChange={e => cheats.update(selected, { notes: e.target.value || undefined })}
                        />}
                </PanelDetailSection>}
            <PanelDetailSection title={nls.localize('vueport/cheats/codes', 'Codes')}>
                {renderCodes(owner)}
            </PanelDetailSection>
            {!owner.builtIn && <PanelDetailFooter>
                <button className='vp-button secondary danger' onClick={() => removeCheat(selected)}>
                    <Trash size={14} />
                    {nls.localize('vueport/cheats/removeCheat', 'Remove Cheat')}
                </button>
            </PanelDetailFooter>}
        </div>;

    // searching takes the whole panel ahead of everything else, as it is offered from the empty state too
    if (finding) {
        return <EmulatorCheatFinder
            finder={finder}
            cheats={cheats}
            notifications={notifications}
            onBack={() => setFinding(false)}
            onCreated={index => {
                setFinding(false);
                setEditing(index);
            }}
        />;
    }

    if (list.length === 0) {
        return <>
            {header}
            {peerNote}
            <div className='vp-panel-empty-fill'>
                <EmptyContainer
                    title={nls.localize('vueport/cheats/noCheat', 'No cheats have been configured')}
                    description={nls.localize('vueport/cheats/noCheatDescription', 'Add cheats to pin certain memory addresses to a given value.')}
                    icon={<StarHalf size={32} />}
                />
            </div>
            {actions}
        </>;
    }

    if (cheat !== undefined && editing !== undefined) {
        return <>
            <PanelDetailToolbar
                list={nls.localize('vueport/cheats/title', 'Cheats')}
                index={editing}
                count={list.length}
                onBack={() => setEditing(undefined)}
                onStep={setEditing}
            />
            <div className='vp-panel-detail vp-scroll'>
                {renderDetail(cheat)}
            </div>
        </>;
    }

    const needle = filter.trim().toLowerCase();
    const visible = list
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => !needle || entry.description.toLowerCase().includes(needle));

    return <>
        {header}
        {peerNote}
        <div className='vp-panel-filter'>
            <MagnifyingGlass size={15} />
            <input
                type='text'
                spellCheck={false}
                value={filter}
                placeholder={nls.localize('vueport/cheats/filter', 'Filter')}
                aria-label={nls.localize('vueport/cheats/filter', 'Filter')}
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
                    {nls.localize('vueport/cheats/noMatch', 'No cheats match “{0}”.', filter.trim())}
                </p>
                : <ul className='vp-panel-list'>
                    {visible.map(({ entry, index }) => (
                        <li
                            key={index}
                            className={'vp-panel-row' + (entry.enabled ? ' enabled' : '')}
                            // the whole row switches the cheat, as a switch is a small target. The pencil and the
                            // switch stop the click, or the switch would toggle twice
                            onClick={() => cheats.update(index, { enabled: !entry.enabled })}
                        >
                            <button
                                type='button'
                                role='switch'
                                aria-checked={entry.enabled}
                                aria-label={entry.description
                                    || nls.localize('vueport/cheats/thisCheat', 'this cheat')}
                                className='vp-switch'
                                onClick={e => {
                                    e.stopPropagation();
                                    cheats.update(index, { enabled: !entry.enabled });
                                }}
                            >
                                <span className='vp-switch-knob' />
                            </button>
                            <span className='vp-panel-row-summary'>
                                <span className='vp-panel-row-name'>{entry.description}</span>
                                {entry.notes &&
                                    <span className='vp-panel-row-notes'>{entry.notes}</span>}
                            </span>
                            {/* a shipped cheat opens the same way, but its name and writes are the database's, so it is
                                an eye, not a pencil */}
                            <button
                                type='button'
                                className='vp-panel-row-action'
                                aria-label={(entry.builtIn
                                    ? nls.localize('vueport/cheats/viewCheat', 'View {0}',
                                        entry.description
                                        || nls.localize('vueport/cheats/thisCheat', 'this cheat'))
                                    : nls.localize('vueport/cheats/editCheat', 'Edit {0}',
                                        entry.description
                                        || nls.localize('vueport/cheats/thisCheat', 'this cheat')))}
                                onClick={e => {
                                    e.stopPropagation();
                                    setEditing(index);
                                }}
                            >
                                {entry.builtIn ? <Eye size={18} /> : <PencilSimple size={18} />}
                            </button>
                            {!entry.builtIn &&
                                <button
                                    type='button'
                                    className='vp-panel-row-action danger'
                                    aria-label={nls.localize('vueport/cheats/removeNamedCheat', 'Remove {0}',
                                        entry.description
                                        || nls.localize('vueport/cheats/thisCheat', 'this cheat'))}
                                    onClick={e => {
                                        e.stopPropagation();
                                        removeCheat(index);
                                    }}
                                >
                                    <X size={16} />
                                </button>
                            }
                        </li>
                    ))}
                </ul>}
        </div>
        {actions}
    </>;
}
