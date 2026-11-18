import { ArrowCounterClockwise, ArrowLeft, MagnifyingGlass, Star } from '@phosphor-icons/react';
import * as React from 'react';
import { VueportNotifications } from '../../common/emulator-host';
import {
    SCAN_DATA_TYPES,
    SCAN_OPERATORS,
    ScanDataType,
    ScanOperator,
    scanOperatorNeedsValue,
} from '../../common/emulator-cheat-scan';
import { nls } from '../../common/emulator-nls';
import { CHEAT_SCAN_REGIONS, CheatScanRegion, CheatFinder } from '../emulator-cheat-finder';
import { CheatStore } from '../emulator-cheat-store';
import Select from './kit/Select';
import EmptyContainer from './kit/EmptyContainer';

// a first pass over 64 KB can leave every address in the running, which is neither drawable nor readable
// (the SRAM panel caps its list for the same reason); the count above the table is what matters
const SHOWN_RESULTS = 200;

const VALUE_REFRESH_MS = 250;

function regionLabel(region: CheatScanRegion): string {
    switch (region) {
        case CheatScanRegion.WRAM:
            return nls.localize('vueport/cheats/finder/wram', 'Work RAM');
        case CheatScanRegion.CART_RAM:
            return nls.localize('vueport/cheats/finder/cartRam', 'Save RAM');
    }
}

function typeLabel(type: ScanDataType): string {
    switch (type) {
        case ScanDataType.U8:
            return nls.localize('vueport/cheats/finder/u8', '8-bit');
        case ScanDataType.S8:
            return nls.localize('vueport/cheats/finder/s8', '8-bit signed');
        case ScanDataType.U16:
            return nls.localize('vueport/cheats/finder/u16', '16-bit');
        case ScanDataType.S16:
            return nls.localize('vueport/cheats/finder/s16', '16-bit signed');
        case ScanDataType.U32:
            return nls.localize('vueport/cheats/finder/u32', '32-bit');
        case ScanDataType.S32:
            return nls.localize('vueport/cheats/finder/s32', '32-bit signed');
    }
}

// worded to follow "the value", as in "the value has decreased"
function operatorLabel(op: ScanOperator): string {
    switch (op) {
        case 'eq':
            return nls.localize('vueport/cheats/finder/eq', 'is equal to');
        case 'ne':
            return nls.localize('vueport/cheats/finder/ne', 'is not equal to');
        case 'gt':
            return nls.localize('vueport/cheats/finder/gt', 'is greater than');
        case 'lt':
            return nls.localize('vueport/cheats/finder/lt', 'is less than');
        case 'changed':
            return nls.localize('vueport/cheats/finder/changed', 'has changed');
        case 'unchanged':
            return nls.localize('vueport/cheats/finder/unchanged', 'is unchanged');
        case 'increased':
            return nls.localize('vueport/cheats/finder/increased', 'has increased');
        case 'decreased':
            return nls.localize('vueport/cheats/finder/decreased', 'has decreased');
    }
}

// decimal, as the value appears on screen; 0x is honored for values known in cheat form
function parseSearchValue(text: string): number | undefined {
    const trimmed = text.trim();
    if (!trimmed) {
        return undefined;
    }
    const parsed = /^[-+]?0[xX][0-9a-fA-F]+$/.test(trimmed)
        ? parseInt(trimmed.replace(/0[xX]/, ''), 16) * (trimmed.startsWith('-') ? -1 : 1)
        : Number(trimmed);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

const hex = (value: number): string => (value >>> 0).toString(16).toUpperCase();

// finds the address behind a number on screen the Action Replay way: scan, change it in game, scan again until one
// address is left; "decreased" and friends cover values not shown. Lives in the Cheats panel, as finding and pinning
// an address are one job; the search itself is in CheatFinder, which outlives this component
export default function EmulatorCheatFinder(props: {
    finder: CheatFinder,
    cheats: CheatStore,
    notifications: VueportNotifications,
    onBack: () => void,
    onCreated: (index: number) => void,
}): React.JSX.Element {
    const { finder, cheats, notifications, onBack, onCreated } = props;

    const [operator, setOperator] = React.useState<ScanOperator>('eq');
    const [valueText, setValueText] = React.useState('');
    // held here rather than in the search, as a scan that changes the table clears them
    const [selected, setSelected] = React.useState<ReadonlySet<number>>(new Set());
    const [, setVersion] = React.useState(0);
    const redraw = React.useCallback(() => setVersion(version => version + 1), []);

    React.useEffect(() => {
        const subscription = finder.onDidChange(redraw);
        return () => subscription.dispose();
    }, [finder, redraw]);

    // the value column follows the game so a candidate can be watched moving; one 64 KB read every 250 ms,
    // less than the Memory panel does
    React.useEffect(() => {
        if (!finder.started) {
            return undefined;
        }
        const timer = window.setInterval(() => {
            finder.refreshValues().catch(() => undefined);
        }, VALUE_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [finder, finder.started]);

    const needsValue = scanOperatorNeedsValue(operator);
    const value = parseSearchValue(valueText);
    const valueMissing = needsValue && value === undefined;
    const scannable = finder.hasSim && !finder.busy && !valueMissing;

    // anything that changes which addresses are in the running clears the ticks, as a tick means "this row"
    const clearSelection = (): void => setSelected(new Set());

    const scan = (): void => {
        clearSelection();
        const promise = finder.started
            ? finder.next(operator, value)
            : finder.first(operator, value);
        promise.catch(error => notifications.error(String(error)));
    };

    const toggle = (address: number): void => {
        setSelected(current => {
            const next = new Set(current);
            if (!next.delete(address)) {
                next.add(address);
            }
            return next;
        });
    };

    // one cheat for all ticked addresses: a visible number usually lives at more than one address (the copy
    // the game counts with and the one it draws from), and only stays put if all of them are held
    const createCheat = (): void => {
        const picked = finder.results(SHOWN_RESULTS).filter(result => selected.has(result.address));
        if (picked.length === 0) {
            return;
        }
        const first = hex(picked[0].address);
        const index = cheats.add(picked.length === 1
            ? nls.localize('vueport/cheats/finder/foundCheat', 'Found at {0}', first)
            : nls.localize('vueport/cheats/finder/foundCheats', 'Found at {0} and {1} more',
                first, String(picked.length - 1)));
        cheats.update(index, {
            enabled: true,
            codes: picked.map(result => ({
                address: result.address,
                value: result.value >>> 0,
                digits: finder.cheatDigits,
            })),
        });
        clearSelection();
        onCreated(index);
    };

    const toolbar = <div className='vp-panel-toolbar'>
        <button
            type='button'
            className='vp-panel-back'
            aria-label={nls.localize('vueport/general/backToList', 'Back To List')}
            onClick={onBack}
        >
            <ArrowLeft size={20} />
            {nls.localize('vueport/general/backToList', 'Back To List')}
        </button>
    </div>;

    // selects rather than a segmented control, as eight options do not fit the strip beside the screen
    const search = <fieldset className='vp-inspector-group vp-cheat-finder-search'>
        <legend>{nls.localize('vueport/cheats/finder/search', 'Search')}</legend>
        <label>
            <span>{nls.localize('vueport/cheats/finder/region', 'In')}</span>
            <Select
                options={CHEAT_SCAN_REGIONS.map(region => ({ value: region, label: regionLabel(region) }))}
                value={finder.scanRegion}
                title={nls.localize('vueport/cheats/finder/regionHint',
                    'Which memory to look in. Changing it starts the search over.')}
                onChange={next => finder.setRegion(next as CheatScanRegion)}
            />
        </label>
        <label>
            <span>{nls.localize('vueport/cheats/finder/type', 'Read as')}</span>
            <Select
                options={SCAN_DATA_TYPES.map(type => ({ value: type, label: typeLabel(type) }))}
                value={finder.dataType}
                title={nls.localize('vueport/cheats/finder/typeHint',
                    'How wide the number is. Try 16-bit first; changing it starts the search over.')}
                onChange={next => finder.setDataType(next as ScanDataType)}
            />
        </label>
        <label>
            <span>{nls.localize('vueport/cheats/finder/where', 'The value')}</span>
            <Select
                options={SCAN_OPERATORS.map(op => ({ value: op, label: operatorLabel(op) }))}
                value={operator}
                onChange={next => setOperator(next as ScanOperator)}
            />
        </label>
        <label>
            <span>{nls.localize('vueport/cheats/finder/value', 'Value')}</span>
            <input
                className='vp-input'
                spellCheck={false}
                value={valueText}
                disabled={!needsValue}
                placeholder={needsValue
                    ? nls.localize('vueport/cheats/finder/valuePlaceholder', 'e.g. 3')
                    : nls.localize('vueport/cheats/finder/valueNotNeeded', 'not needed')}
                title={nls.localize('vueport/cheats/finder/valueHint',
                    'The number as it appears in the game. Decimal, or 0x for hexadecimal.')}
                onChange={event => setValueText(event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'Enter' && scannable) {
                        scan();
                    }
                }}
            />
        </label>
    </fieldset>;

    const actions = <div className='vp-panel-actions'>
        <button
            className='vp-button'
            disabled={!scannable}
            onClick={scan}
        >
            <MagnifyingGlass size={16} />
            {finder.started
                ? nls.localize('vueport/cheats/finder/nextScan', 'Next Scan')
                : nls.localize('vueport/cheats/finder/firstScan', 'First Scan')}
        </button>
        <button
            className='vp-button secondary'
            disabled={!finder.canUndo || finder.busy}
            title={nls.localize('vueport/cheats/finder/undoHint', 'Take back the last scan')}
            onClick={() => { clearSelection(); finder.undo(); }}
        >
            <ArrowCounterClockwise size={16} />
            {nls.localize('vueport/cheats/finder/undo', 'Undo')}
        </button>
        <button
            className='vp-button secondary'
            disabled={!finder.started || finder.busy}
            onClick={() => { clearSelection(); finder.reset(); }}
        >
            <ArrowCounterClockwise size={16} />
            {nls.localize('vueport/cheats/finder/reset', 'Reset')}
        </button>
        <button
            className='vp-button secondary'
            disabled={selected.size === 0}
            title={nls.localize('vueport/cheats/finder/addCheatHint',
                'Pin every ticked address to what it holds now, as one cheat')}
            onClick={createCheat}
        >
            <Star size={16} />
            {nls.localize('vueport/cheats/finder/addCheat', 'Add Cheat')}
        </button>
    </div>;

    if (!finder.hasSim) {
        return <>
            {toolbar}
            <div className='vp-panel-empty-fill'>
                <EmptyContainer
                    title={nls.localize('vueport/general/notRunning', 'The emulator is not running.')}
                    description={nls.localize('vueport/cheats/finder/needsRunning',
                        'A search reads the memory of a running game. Open a ROM and start playing.')}
                    icon={<MagnifyingGlass size={32} />}
                />
            </div>
        </>;
    }

    if (!finder.started) {
        return <>
            {toolbar}
            {search}
            <div className='vp-panel-empty-fill'>
                <EmptyContainer
                    title={nls.localize('vueport/cheats/finder/ready', 'Search the game’s memory')}
                    description={nls.localize('vueport/cheats/finder/readyDescription',
                        'Type in a number the game is showing you and scan. Then change it in the game \
(lose a live, collect a coin, etc.) and scan again for the new number. \
Repeat until only one address or a set of addresses is left. Finally click "Add Cheat".')}
                    icon={<MagnifyingGlass size={32} />}
                />
            </div>
            {actions}
        </>;
    }

    const results = finder.results(SHOWN_RESULTS);
    const count = finder.count;

    return <>
        {toolbar}
        {search}
        <div className='vp-cheat-finder-count'>
            {count === 1
                ? nls.localize('vueport/cheats/finder/oneResult', '1 address left')
                : nls.localize('vueport/cheats/finder/results', '{0} addresses left', count.toLocaleString())}
            {count > results.length &&
                <span className='vp-cheat-finder-capped'>
                    {nls.localize('vueport/cheats/finder/capped',
                        'showing the first {0} — keep narrowing', String(results.length))}
                </span>}
        </div>
        {count === 0
            ? <div className='vp-panel-empty-fill'>
                <EmptyContainer
                    title={nls.localize('vueport/cheats/finder/none', 'Nothing is left')}
                    description={nls.localize('vueport/cheats/finder/noneDescription',
                        'That scan ruled out every address. Undo it and try another question, or check that the width is right.')}
                    icon={<MagnifyingGlass size={32} />}
                />
            </div>
            : <div className='vp-split-table vp-scroll'>
                <table className='vp-table vp-cheat-finder-table'>
                    <thead>
                        <tr>
                            <th className='vp-cheat-finder-pick' />
                            <th className='vp-cheat-finder-address'>
                                {nls.localize('vueport/cheats/finder/address', 'Address')}
                            </th>
                            <th>{nls.localize('vueport/cheats/finder/nowValue', 'Current Value')}</th>
                            <th>{nls.localize('vueport/cheats/finder/wasValue', 'When Found')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {results.map(result => (
                            <tr key={result.address}>
                                <td className='vp-cheat-finder-pick'>
                                    <input
                                        type='checkbox'
                                        checked={selected.has(result.address)}
                                        aria-label={nls.localize('vueport/cheats/finder/pick',
                                            'Put {0} in the next cheat', hex(result.address))}
                                        onChange={() => toggle(result.address)}
                                    />
                                </td>
                                <td className='vp-cheat-finder-address'>{hex(result.address)}</td>
                                <td>{result.value}</td>
                                <td className={result.value === result.previous ? 'same' : undefined}>
                                    {result.previous}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>}
        {actions}
    </>;
}
