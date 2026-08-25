import { BracketsSquare, Plus, Trash } from '@phosphor-icons/react';
import { nls } from '../../common/emulator-nls';
import { VueportNotifications } from '../../common/emulator-host';
import * as React from 'react';
import EmptyContainer from '../components/kit/EmptyContainer';
import {
    formatVesCheatCode,
    parseVesCheatCode,
    CHEAT_DEFAULT_DIGITS,
    CHEAT_DIGITS,
    VesCheat,
    VesCheatCode,
    vesCheatMaxValue,
} from '../../common/emulator-cheats';
import { VesEmulatorCheatStore } from '../emulator-cheat-store';
import { EmulatorPanelType, VesEmulatorDebugSource, VesEmulatorPanel } from './emulator-panel';
import { control, field } from './emulator-vip-detail';

/** What a new cheat, and a new code, start out as. */
const NEW_CHEAT_ADDRESS = 0x05000000;

/**
 * The cheats kept beside the ROM: named sets of writes the core repeats every
 * frame, which is what holds a value against a game that keeps changing it.
 *
 * The list on top is every cheat in the file, with the selected one's name,
 * switch and codes editable below it. Everything here edits the store, which
 * owns the list, writes the file and pushes the enabled writes into the core —
 * so a cheat stays on with this panel closed, and the panel is only a view of
 * it. That is also why nothing is polled: the store says when to redraw.
 */
export class VesEmulatorCheatsPanel extends VesEmulatorPanel {

    protected selected = 0;

    constructor(
        source: VesEmulatorDebugSource,
        instanceId: string,
        protected readonly cheats: VesEmulatorCheatStore,
        protected readonly notifications: VueportNotifications
    ) {
        super(EmulatorPanelType.CHEATS, source, instanceId);
        this.title.label = nls.localize('vueport/panels/cheats', 'Cheats');
        this.addClass('vueport-vip-split');
        this.toDispose.push(this.cheats.onDidChange(() => this.update()));
    }

    /**
     * Nothing here comes from the running simulation, so there is nothing to
     * poll for: the store fires when the list changes, and that is the only
     * thing this panel draws. Not polling is also what lets the name field be
     * an ordinary text input rather than one fighting a refresh.
     */
    protected startPolling(): void {
        this.refresh();
    }

    protected refresh(): void {
        this.update();
    }

    protected select(index: number): void {
        this.selected = Math.min(Math.max(0, index), Math.max(0, this.cheats.list.length - 1));
        this.update();
    }

    protected addCheat(): void {
        this.selected = this.cheats.add(nls.localize('vueport/cheats/newCheat', 'New cheat'));
    }

    /**
     * Delete a cheat, once the user has confirmed it.
     *
     * Worth asking about: the row's only handle is a small button beside a
     * checkbox people click often, and a cheat is typed in by hand — a
     * misclick would throw away work with nothing to undo it, and removing the
     * last one takes the file with it.
     */
    protected async removeCheat(index: number): Promise<void> {
        const cheat = this.cheats.list[index];
        // A shipped cheat is not the player's to delete. The button is not
        // offered for one either; this is the guard behind that.
        if (!cheat || cheat.builtIn) {
            return;
        }
        // Hoisted out of the message's arguments rather than nested in them:
        // the extractor stops descending once it has matched a localize call,
        // so a nested one is never seen and its key never reaches nls.json.
        const unnamed = nls.localize('vueport/cheats/thisCheat', 'this cheat');
        const confirmed = await this.notifications.confirm({
            title: nls.localize('vueport/cheats/deleteCheatQuestion', 'Delete Cheat?'),
            message: nls.localize(
                'vueport/cheats/areYouSureYouWantToDelete',
                'Are you sure you want to delete {0}?',
                cheat.description || unnamed,
            ),
        });
        if (confirmed) {
            this.cheats.remove(index);
            this.select(this.selected);
        }
    }

    /** Replace one of a cheat's codes, or drop it when `code` is undefined. */
    protected setCode(cheat: VesCheat, index: number, code: VesCheatCode | undefined): void {
        const codes = [...cheat.codes];
        if (code) {
            codes[index] = code;
        } else {
            codes.splice(index, 1);
        }
        this.cheats.update(this.selected, { codes });
    }

    protected addCode(cheat: VesCheat): void {
        this.cheats.update(this.selected, {
            codes: [
                ...cheat.codes,
                { address: NEW_CHEAT_ADDRESS, value: 0, digits: CHEAT_DEFAULT_DIGITS },
            ],
        });
    }

    protected render(): React.ReactNode {
        const cheats = this.cheats.list;
        const selected = Math.min(this.selected, Math.max(0, cheats.length - 1));
        const cheat = cheats[selected];

        /*
        if (!this.cheats.isLoaded) {
            return <EmptyContainer
                title={nls.localize('vueport/cheats/noCheatFile', 'No cheat file for this ROM yet.')}
            />;
        }
        */
        if (cheats.length === 0) {
            return <EmptyContainer
                title={nls.localize('vueport/cheats/noCheat', 'No cheats have been configured')}
                description={nls.localize('vueport/cheats/noCheatDescription', 'Add cheats to pin certain memory addresses to a given value.')}
                icon={<BracketsSquare size={32} />}
                buttonIconCls='codicon codicon-add'
                buttonLabel={nls.localize('vueport/cheats/addCheat', 'Add Cheat')}
                onClick={this.addCheat.bind(this)}
            />;
        }

        return <>
            <div className='vueport-panel-toolbar'>
                <button className='theia-button secondary' onClick={() => this.addCheat()}>
                    <Plus size={12} />
                    {nls.localize('vueport/cheats/addCheat', 'Add Cheat')}
                </button>
                <span className='vueport-vip-footer'>{this.cheats.fileName ?? ''}</span>
            </div>
            <div className='vueport-vip-split-table'>
                <fieldset className='vueport-vip-inspector-group'>
                    <legend>
                        {nls.localize('vueport/cheats/cheats', 'Cheats')}
                    </legend>
                    <table className='vueport-vip-table vueport-vip-selectable-table vueport-cheats-table'>
                        <thead>
                            <tr>
                                <th>{nls.localize('vueport/cheats/on', 'On')}</th>
                                <th>{nls.localize('vueport/general/name', 'Name')}</th>
                                <th title={nls.localize('vueport/cheats/codesHint', 'Address and value of each write')}>
                                    {nls.localize('vueport/cheats/codes', 'Codes')}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {cheats.map((entry, index) => (
                                <tr
                                    key={index}
                                    className={`${entry.enabled ? '' : 'inactive'}${index === selected ? ' selected' : ''}`}
                                    onClick={() => this.select(index)}
                                >
                                    <td>
                                        <input
                                            type='checkbox'
                                            checked={entry.enabled}
                                            onChange={e => this.cheats.update(index, { enabled: e.target.checked })}
                                        />
                                    </td>
                                    <td className='name'>{entry.description}</td>
                                    <td className='name'>{entry.codes.map(formatVesCheatCode).join(' ')}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </fieldset>
            </div>
            {cheat
                ? this.renderDetail(cheat)
                : <div className='vueport-vip-footer'>
                    {nls.localize('vueport/cheats/empty', 'No cheats yet. Add one to get started.')}
                </div>}
        </>;
    }

    protected renderDetail(cheat: VesCheat): React.ReactNode {
        return <div className='vueport-vip-detail'>
            <div className='vueport-vip-detail-groups'>
                <fieldset className='vueport-vip-inspector-group'>
                    <legend>{nls.localize('vueport/cheats/cheat', 'Cheat')}</legend>
                    <div className='vueport-vip-detail-fields'>
                        {control(
                            nls.localize('vueport/general/name', 'Name'),
                            <input
                                className='theia-input'
                                value={cheat.description}
                                // What a shipped cheat is called, and what it
                                // writes, are the database's to say — so the
                                // fields show them but do not take edits.
                                readOnly={cheat.builtIn}
                                onChange={e => this.cheats.update(this.selected, { description: e.target.value })}
                            />,
                            undefined,
                            true
                        )}
                        {field(
                            nls.localize('vueport/cheats/writes', 'Writes'),
                            `${cheat.codes.length}`
                        )}
                    </div>
                    <div className='vueport-vip-detail-flags'>
                        <label>
                            <input
                                type='checkbox'
                                checked={cheat.enabled}
                                onChange={e => this.cheats.update(this.selected, { enabled: e.target.checked })}
                            />
                            {nls.localize('vueport/cheats/enabled', 'Enabled')}
                        </label>
                        {cheat.builtIn
                            ? <span className='vueport-cheats-built-in'>
                                {nls.localize(
                                    'vueport/cheats/builtIn',
                                    'Ships with the emulator',
                                )}
                            </span>
                            : <button
                                className='theia-button secondary'
                                onClick={() => this.removeCheat(this.selected)}
                            >
                                <Trash size={12} />
                                {nls.localize('vueport/cheats/removeCheat', 'Remove Cheat')}
                            </button>
                        }
                    </div>
                </fieldset>

                {this.renderCodesGroup(cheat)}
            </div>
        </div>;
    }

    /**
     * One row per write: where it goes, what it writes, and how wide the write
     * is. The address is typed in hexadecimal, since that is how every
     * published code is written; the value follows it so the two read the way
     * the file spells them, `ADDRESS:VALUE`.
     */
    protected renderCodesGroup(cheat: VesCheat): React.ReactNode {
        return <fieldset className='vueport-vip-inspector-group'>
            <legend>{nls.localize('vueport/cheats/codes', 'Codes')}</legend>
            {cheat.codes.map((code, index) => (
                <div className='vueport-cheats-code' key={index}>
                    <input
                        className='theia-input address'
                        value={(code.address >>> 0).toString(16).toUpperCase()}
                        spellCheck={false}
                        title={nls.localize('vueport/cheats/addressHint', 'Address to write to, in hexadecimal')}
                        readOnly={cheat.builtIn}
                        onChange={e => {
                            const address = parseInt(e.target.value, 16);
                            if (!Number.isNaN(address)) {
                                this.setCode(cheat, index, { ...code, address: address >>> 0 });
                            }
                        }}
                    />
                    <span className='separator'>:</span>
                    <input
                        className='theia-input value'
                        value={(code.value >>> 0).toString(16).toUpperCase().padStart(code.digits, '0')}
                        spellCheck={false}
                        title={nls.localize('vueport/cheats/valueHint', 'Value to write, in hexadecimal')}
                        readOnly={cheat.builtIn}
                        onChange={e => {
                            const value = parseInt(e.target.value, 16);
                            if (!Number.isNaN(value)) {
                                this.setCode(cheat, index, {
                                    ...code,
                                    value: Math.min(vesCheatMaxValue(code.digits), value >>> 0),
                                });
                            }
                        }}
                    />
                    <select
                        className='theia-select'
                        value={code.digits}
                        title={nls.localize('vueport/cheats/widthHint', 'How wide the write is')}
                        onChange={e => {
                            const digits = parseInt(e.target.value, 10);
                            this.setCode(cheat, index, {
                                ...code,
                                digits,
                                value: Math.min(vesCheatMaxValue(digits), code.value),
                            });
                        }}
                        disabled={cheat.builtIn}
                    >
                        {CHEAT_DIGITS.map(digits => (
                            <option key={digits} value={digits}>{digits * 4} bit</option>
                        ))}
                    </select>
                    {!cheat.builtIn &&
                        <button
                            className='vueport-cheats-remove'
                            title={nls.localize('vueport/cheats/removeCode', 'Remove code')}
                            onClick={() => this.setCode(cheat, index, undefined)}
                        >
                            <Trash size={12} />
                        </button>
                    }
                </div>
            ))}
            {!cheat.builtIn && <div className='vueport-cheats-code'>
                <button className='theia-button secondary' onClick={() => this.addCode(cheat)}>
                    <Plus size={12} />
                    {nls.localize('vueport/cheats/addCode', 'Add Code')}
                </button>
                <input
                    className='theia-input paste'
                    placeholder={nls.localize('vueport/cheats/paste', 'Paste a code, e.g. 50091A4:0001')}
                    spellCheck={false}
                    onKeyDown={e => {
                        if (e.key !== 'Enter') {
                            return;
                        }
                        const pasted = parseVesCheatCode(e.currentTarget.value);
                        if (pasted) {
                            this.cheats.update(this.selected, { codes: [...cheat.codes, pasted] });
                            e.currentTarget.value = '';
                        }
                    }}
                />
            </div>}
        </fieldset>;
    }
}
