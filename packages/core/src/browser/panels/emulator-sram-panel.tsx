import { CaretDown, CaretRight, Database, Plug, X } from '@phosphor-icons/react';
import { Message } from '@lumino/messaging';
import * as React from 'react';
import { DisposableCollection } from '../../common/emulator-events';
import { formatLogTime } from '../../common/emulator-log';
import { nls } from '../../common/emulator-nls';
import { DEFAULT_SAVE_RAM_SIZE } from '../../common/emulator-save-state';
import {
    foldTouchRecord,
    makeTouchRecord,
    markTouchRecord,
    touchFillPercent,
    TOUCHED_READ,
    TOUCHED_WRITE,
} from '../../common/emulator-sram-map';
import { VbDataType } from '../../common/vb-constants';
import { MAX_SRAM_RUNS, SramRun } from '../../common/vb-protocol';
import EmptyContainer from '../components/kit/EmptyContainer';
import Switch from '../components/kit/Switch';
import { findFunctionAt, functionDisplayName, SymbolIndex } from '../core/emulator-symbols';
import { Sim } from '../core/vb-core';
import { BYTES_PER_MBIT } from '../emulator-types';
import { DebugSource, EmulatorPanelType, hex, Panel } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';

// a burst is a row, so this counts rows, not accesses (a whole save written in one sweep is one)
const MAX_BURSTS = 1000;

// bounds the bytes held inside the rows; the oldest bursts are given up whole
const MAX_BYTES = 200000;

// how long a burst may pause before the next run starts a new one: a long save spans consecutive ticks (20 ms apart)
// and has to read as one
const BURST_GAP_MS = 250;

const MAP_COLUMNS = 32;
const MAP_ROWS = 4;
const MAP_CELLS = MAP_COLUMNS * MAP_ROWS;

const MAX_DETAIL_ROWS = 256;

// two decimals, as the high-water mark lands anywhere ("7.266053199768066 MB"); round sizes print without a fraction
function size(bytes: number): string {
    if (bytes >= 1024 * 1024) {
        return `${+(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    if (bytes >= 1024) {
        return `${+(bytes / 1024).toFixed(2)} KB`;
    }
    return `${bytes} B`;
}

function widthOf(type: number): string {
    switch (type) {
        case VbDataType.S16:
        case VbDataType.U16:
            return '16';
        case VbDataType.S32:
        case VbDataType.F32:
            return '32';
        default:
            return '8';
    }
}

// what one instruction did to one stretch of the save for as long as it kept doing it, so a save loop is one row
interface SramBurst {
    id: number; // stable across renders, so React keeps the row the user opened
    at: number;
    until: number;
    write: boolean;
    pc: number;
    first: number; // first and last are inclusive
    last: number;
    bytes: number;
    // the worker sends each tick's share as a SramRun; not flattened per byte, which would cost a game reading its save
    // every frame an allocation per byte
    runs: SramRun[];
}

function addressIn(run: SramRun, index: number): number {
    return run.address + index * run.stride;
}

function extentOf(run: SramRun): [number, number] {
    const end = addressIn(run, run.values.length - 1);
    return run.address <= end ? [run.address, end] : [end, run.address];
}

/**
 * What a game does with its save data, reads as well as writes: a save never read back, or read from the wrong address,
 * looks like one that works until the game is restarted. Both come from the core's access callbacks rather than
 * polling, so nothing is missed, but each access costs a call out of the core. So capture is requested only while its
 * switch is on (the switches decide what is captured, not just what is shown; Wario Land reads its save every frame)
 * and released when the panel closes. The map shows which bytes were touched and how, the list one row per instruction,
 * and the caller column names the instruction and narrows the list to it when clicked.
 */
export class SramPanel extends Panel {

    // oldest first; the list draws them the other way
    protected bursts: SramBurst[] = [];
    protected byteCount = 0;
    protected nextBurstId = 1;

    // one entry per TOUCH_BYTES (see `TOUCHED_*`), folded into cells when drawn
    protected touched = makeTouchRecord(DEFAULT_SAVE_RAM_SIZE);
    protected get shown(): number {
        return (this.showWrites ? TOUCHED_WRITE : 0) | (this.showReads ? TOUCHED_READ : 0);
    }

    protected get anything(): boolean {
        return this.touched.some(state => (state & this.shown) !== 0);
    }

    // how much of the bus the save answers on. Asked, not assumed, as the core indexes its buffer by masked address;
    // cartridges get all of Game Pak RAM, but a machine set to a narrower window is exactly what this panel is opened
    // to watch
    protected window = DEFAULT_SAVE_RAM_SIZE;

    // how far up the window the game has written, read from the machine since capture stops while hidden; the same
    // figure the save file is written at
    protected used = DEFAULT_SAVE_RAM_SIZE;

    // batches that arrived full and so were cut short by the worker
    protected dropped = 0;

    protected showWrites = this.remembered('writes', true);
    protected showReads = this.remembered('reads', true);

    protected caller?: number;
    protected opened = new Set<number>();

    protected symbols?: SymbolIndex;
    protected names = new Map<number, string | undefined>();

    protected watched?: Sim;
    protected readonly watching = new DisposableCollection();

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.SRAM, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/sram/title', 'SRAM');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.SRAM);
        this.toDispose.push(this.watching);
    }

    // batches arrive every tick (50 per second) but are drawn on the poll: redrawing on each would reconcile the whole
    // list every frame for a game reading its save continuously
    protected pollHz(): number {
        return Panel.POLL_HZ;
    }

    // capture is released while hidden (it costs a call per access); what was gathered stays, with a gap for the
    // unwatched time
    protected onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        if (this.watched) {
            this.capture(this.watched, this.showWrites, this.showReads);
            // writes while hidden were not watched, so the figure in hand is stale
            this.readCartRam(this.watched);
        }
    }

    protected onAfterHide(msg: Message): void {
        super.onAfterHide(msg);
        if (this.watched) {
            this.capture(this.watched, false, false);
        }
    }

    protected async refresh(): Promise<void> {
        this.follow();
        const symbols = await this.source.getSymbols();
        if (symbols !== this.symbols) {
            this.symbols = symbols;
            this.names.clear();
        }
        this.update();
    }

    // closing or opening a ROM replaces the simulation, so what was gathered no longer applies; a reset keeps it and is
    // caught by onRestart
    protected follow(): void {
        const sim = this.source.sim;
        if (sim === this.watched) {
            return;
        }
        this.watching.dispose();
        this.watched = sim;
        this.clear();
        if (!sim) {
            return;
        }

        // two numbers rather than the buffer: the window is 16 MiB of Game Pak RAM, too much to move across the worker
        // boundary to learn its length
        this.readCartRam(sim);

        this.watching.push(sim.onSram(runs => this.append(runs)));
        this.watching.push(sim.onRestart(() => this.clear()));
        this.watching.push({ dispose: () => this.capture(sim, false, false) });
        if (this.isVisible) {
            this.capture(sim, this.showWrites, this.showReads);
        }
    }

    protected capture(sim: Sim, writes: boolean, reads: boolean): void {
        sim.setSramCapture(writes, reads).catch(() => {
        });
    }

    // the switches decide what is captured, not just shown
    protected watchDirection(direction: 'writes' | 'reads', wanted: boolean): void {
        if (direction === 'writes') {
            this.showWrites = this.remember('writes', wanted);
        } else {
            this.showReads = this.remember('reads', wanted);
        }
        if (this.watched && this.isVisible) {
            this.capture(this.watched, this.showWrites, this.showReads);
        }
        this.update();
    }

    protected readCartRam(sim: Sim): void {
        sim.cartRamInfo()
            .then(info => {
                this.setWindow(info.size);
                // only ever upwards, and never below the baseline: a save file is never written shorter
                this.used = Math.max(this.used, info.used, DEFAULT_SAVE_RAM_SIZE);
            })
            .catch(() => { /* the default window stands */ });
    }

    // a different size is a different cartridge and every gathered offset was masked with the old one, so start again.
    // The touch record has a fixed granularity (TOUCH_BYTES), so widening the map costs nothing
    protected setWindow(bytes: number): void {
        if (bytes <= 0 || (bytes & (bytes - 1)) !== 0 || bytes === this.window) {
            return;
        }
        this.window = bytes;
        this.touched = makeTouchRecord(bytes);
        this.used = DEFAULT_SAVE_RAM_SIZE;
        this.clear();
    }

    // the extent the game reached, rounded up to a power of two and floored at the baseline: with all of Game Pak RAM
    // backed, a map of the window would be one lit cell in 128
    protected get extent(): number {
        let extent = DEFAULT_SAVE_RAM_SIZE;
        while (extent < this.used && extent < this.window) {
            extent *= 2;
        }
        return extent;
    }

    protected append(runs: SramRun[]): void {
        const at = Date.now();
        // a full batch is the worker's cap, so the tick was cut short; counted, so a gap in the list is not mistaken
        // for a gap in what the game did
        if (runs.length >= MAX_SRAM_RUNS) {
            this.dropped++;
        }
        for (const run of runs) {
            this.record(run, at);
        }
        this.trim();
        // no update here on purpose, the poll draws (see pollHz)
    }

    protected record(run: SramRun, at: number): void {
        if (run.values.length === 0) {
            return;
        }
        const mask = this.window - 1;
        const [low, high] = extentOf(run);
        const first = low & mask;
        const last = high & mask;
        const burst = this.bursts[this.bursts.length - 1];

        if (burst && this.joins(burst, run, first, last, at)) {
            burst.runs.push(run);
            burst.first = Math.min(burst.first, first);
            burst.last = Math.max(burst.last, last);
            burst.bytes += run.values.length;
            burst.until = at;
        } else {
            this.bursts.push({
                id: this.nextBurstId++,
                at,
                until: at,
                write: run.write,
                pc: run.pc,
                first,
                last,
                bytes: run.values.length,
                runs: [run],
            });
        }

        this.byteCount += run.values.length;
        this.touch(first, last, run.write);
    }

    // same instruction and direction, no pause, and a stretch the burst reaches or is about to: a run the worker had to
    // cut at the end of a tick picks up where it left off
    protected joins(
        burst: SramBurst, run: SramRun, first: number, last: number, at: number
    ): boolean {
        const reach = Math.max(1, Math.abs(run.stride));
        return burst.write === run.write
            && burst.pc === run.pc
            && at - burst.until <= BURST_GAP_MS
            && first >= burst.first - reach
            && last <= burst.last + reach;
    }

    // kept apart from the bursts on purpose: trimming the oldest rows does not mean the game never went there
    protected touch(first: number, last: number, write: boolean): void {
        markTouchRecord(this.touched, first, last, write ? TOUCHED_WRITE : TOUCHED_READ);
        this.used = Math.max(this.used, last + 1);
    }

    protected trim(): void {
        while (this.bursts.length > MAX_BURSTS
            || (this.byteCount > MAX_BYTES && this.bursts.length > 1)) {
            const gone = this.bursts.shift();
            if (!gone) {
                return;
            }
            this.byteCount -= gone.bytes;
            this.opened.delete(gone.id);
        }
    }

    protected clear(): void {
        this.bursts = [];
        this.byteCount = 0;
        this.opened.clear();
        this.touched.fill(0);
        this.dropped = 0;
        this.caller = undefined;
        this.update();
    }

    protected visible(): SramBurst[] {
        return this.bursts.filter(burst => {
            if (!(burst.write ? this.showWrites : this.showReads)) {
                return false;
            }
            return this.caller === undefined || burst.pc === this.caller;
        });
    }

    // a ROM not built here has no symbols, then the bare address is used
    protected nameOf(pc: number): string | undefined {
        if (!this.symbols) {
            return undefined;
        }
        if (this.names.has(pc)) {
            return this.names.get(pc);
        }
        const romBytes = Math.max(0, this.source.romSize) * BYTES_PER_MBIT;
        const found = romBytes > 0 ? findFunctionAt(this.symbols, pc, romBytes) : undefined;
        const name = found ? functionDisplayName(this.symbols, found.name) : undefined;
        this.names.set(pc, name);
        return name;
    }

    protected callerLabel(pc: number): string {
        return this.nameOf(pc) ?? `0x${hex(pc, 8)}`;
    }

    protected render(): React.ReactNode {
        if (!this.source.sim) {
            return <EmptyContainer
                title={nls.localize('vueport/general/notRunning', 'The emulator is not running.')}
                icon={<Plug size={32} />}
            />;
        }

        const rows = this.visible();

        return <div className='vp-sram'>
            {this.renderToolbar()}
            {/* no map before anything was touched */}
            {this.anything && this.renderMap()}

            {this.dropped > 0 && <div className='vp-sram-dropped'>
                {nls.localize('vueport/debug/panels/sram/dropped',
                    'A burst was longer than could be captured, so some accesses are missing.')}
            </div>}

            <div className='vp-sram-list vp-scroll'>
                {rows.length === 0
                    ? this.renderEmpty()
                    : this.renderList(rows)}
            </div>
        </div>;
    }

    protected renderToolbar(): React.ReactNode {
        // bytes rather than rows, as the run lengths are the other half of what happened
        const counts: string[] = [];
        if (this.showWrites) {
            counts.push(nls.localize('vueport/debug/panels/sram/writeCount', '{0} writes',
                this.bursts.reduce((sum, burst) => sum + (burst.write ? burst.bytes : 0), 0)));
        }
        if (this.showReads) {
            counts.push(nls.localize('vueport/debug/panels/sram/readCount', '{0} reads',
                this.bursts.reduce((sum, burst) => sum + (burst.write ? 0 : burst.bytes), 0)));
        }

        return <div className='vp-panel-toolbar'>
            {this.renderSwitch('writes', nls.localize('vueport/debug/panels/sram/writes', 'Writes'))}
            {this.renderSwitch('reads', nls.localize('vueport/debug/panels/sram/reads', 'Reads'))}
            {/* set by clicking a caller in the list */}
            {this.caller !== undefined && <button
                type='button'
                className='vp-sram-caller-chip'
                title={nls.localize('vueport/debug/panels/sram/showAllCallers', 'Show every caller again')}
                onClick={() => {
                    this.caller = undefined;
                    this.update();
                }}
            >
                {this.callerLabel(this.caller)}
                <X size={12} />
            </button>}
            {/* the switches show from the start, counts and Clear only with content */}
            {this.bursts.length > 0 && <>
                <span className='vp-sram-counts'>{counts.join(', ')}</span>
                <button className='vp-button secondary' onClick={() => this.clear()}>
                    {nls.localize('vueport/debug/panels/sram/clear', 'Clear')}
                </button>
            </>}
        </div>;
    }

    protected renderSwitch(direction: 'writes' | 'reads', label: string): React.ReactNode {
        const on = direction === 'writes' ? this.showWrites : this.showReads;
        return <span className={`vp-sram-toggle ${direction}`}>
            <Switch
                label={label}
                value={on}
                onChange={wanted => this.watchDirection(direction, wanted)}
            />
            <span>{label}</span>
        </span>;
    }

    // one cell per block of the save: written if anything ever wrote it, read if it was only read. A byte only read is
    // one the game expected to find something in
    protected renderMap(): React.ReactNode {
        const extent = this.extent;
        const perCell = extent / MAP_CELLS;
        const { marks: folded, covered } = foldTouchRecord(this.touched, extent, MAP_CELLS);
        return <div className='vp-sram-map'>
            <div className='vp-sram-caption'>
                <div>
                    {nls.localize('vueport/debug/panels/sram/map', 'SRAM map')}
                </div>
                <div>
                    {/* the used size against the window the core was given (all of Game Pak RAM unless narrowed) */}
                    {nls.localize('vueport/debug/panels/sram/usedOf', '{0} used of {1}',
                        size(this.used), size(this.window))}{' · '}
                    0x{hex(0, 4)}–0x{hex(extent - 1, 4)}
                </div>
            </div>
            <div
                className='vp-sram-cells'
                style={{ gridTemplateColumns: `repeat(${MAP_COLUMNS}, 1fr)` }}
            >
                {Array.from(folded, (marks, cell) => {
                    const state = marks & this.shown;
                    const fill = state === 0 ? 0 : touchFillPercent(covered[cell]);
                    return <div
                        key={cell}
                        className={'vp-sram-cell'
                            + (state & TOUCHED_WRITE ? ' written' : state & TOUCHED_READ ? ' read' : '')}
                        // a cell standing for a megabyte of which a kilobyte was written is drawn fainter, see
                        // foldTouchRecord
                        style={{ '--vp-sram-fill': `${fill.toFixed(1)}%` } as React.CSSProperties}
                        title={`0x${hex(cell * perCell, 4)}–0x${hex((cell + 1) * perCell - 1, 4)}`
                            + (state === 0 ? '' : ` · ${this.cellState(state)}`)
                            + (state === 0 || covered[cell] >= 1 ? ''
                                : ` · ${size(Math.round(covered[cell] * perCell))} of it`)}
                    />;
                })}
            </div>
        </div>;
    }

    protected cellState(state: number): string {
        if (state & TOUCHED_WRITE) {
            return nls.localize('vueport/debug/panels/sram/written', 'written');
        }

        return nls.localize('vueport/debug/panels/sram/readOnly', 'read only');
    }

    protected renderEmpty(): React.ReactNode {
        if (!this.showWrites && !this.showReads) {
            return <EmptyContainer
                title={nls.localize('vueport/debug/panels/sram/nothingWatched', 'Nothing is being watched')}
                description={nls.localize('vueport/debug/panels/sram/nothingWatchedHint',
                    'Turn either writes or reads on.')}
                icon={<Database size={32} />}
            />;
        }
        return <EmptyContainer
            title={this.caller !== undefined || this.bursts.length > 0
                ? nls.localize('vueport/debug/panels/sram/filteredOut', 'Nothing matches the filter')
                : nls.localize('vueport/debug/panels/sram/waiting', 'Waiting for save data')}
            description={nls.localize('vueport/debug/panels/sram/waitingHint',
                'Nothing appears until the game accesses SRAM.')}
            icon={<Database size={32} />}
        />;
    }

    protected renderList(rows: SramBurst[]): React.ReactNode {
        return <table className='vp-sram-table'>
            <thead>
                <tr>
                    <th className='vp-sram-open' />
                    <th>{nls.localize('vueport/debug/panels/sram/time', 'Time')}</th>
                    <th>{nls.localize('vueport/debug/panels/sram/range', 'Range')}</th>
                    <th className='number'>{nls.localize('vueport/debug/panels/sram/bytes', 'Bytes')}</th>
                    <th>{nls.localize('vueport/debug/panels/sram/from', 'From')}</th>
                </tr>
            </thead>
            <tbody>
                {rows.slice().reverse().map((burst, i) => this.renderBurst(burst, i))}
            </tbody>
        </table>;
    }

    protected toggle(id: number): void {
        if (this.opened.has(id)) {
            this.opened.delete(id);
        } else {
            this.opened.add(id);
        }
        this.update();
    }

    protected renderBurst(burst: SramBurst, index: number): React.ReactNode {
        const opened = this.opened.has(burst.id);
        const single = burst.first === burst.last;
        return <React.Fragment key={burst.id}>
            {/* the whole row opens it, a caret is a small target in a list this dense */}
            <tr
                className={`vp-sram-${burst.write ? 'write' : 'read'}`
                    + ` ${index % 2 === 0 ? 'even' : 'odd'}${opened ? ' opened' : ''}`}
                role='button'
                tabIndex={0}
                aria-expanded={opened}
                aria-label={nls.localize('vueport/debug/panels/sram/bytesIn', 'Bytes in this burst')}
                onClick={() => this.toggle(burst.id)}
                onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        this.toggle(burst.id);
                    }
                }}
            >
                <td className='vp-sram-open'>
                    {opened ? <CaretDown size={11} weight='fill' /> : <CaretRight size={11} weight='fill' />}
                </td>
                <td className='vp-log-time'>{formatLogTime(burst.at)}</td>
                <td className='vp-sram-range'>
                    <b>{burst.write
                        ? nls.localize('vueport/debug/panels/sram/write', 'W')
                        : nls.localize('vueport/debug/panels/sram/read', 'R')}</b>
                    {/* offsets into the save as the game counts them, the full bus address is in the detail */}
                    {single
                        ? hex(burst.first, 4)
                        : `${hex(burst.first, 4)}–${hex(burst.last, 4)}`}
                </td>
                <td className='number'>{burst.bytes}</td>
                <td>
                    <button
                        type='button'
                        className='vp-sram-caller'
                        title={`0x${hex(burst.pc, 8)}`}
                        onClick={event => {
                            // the row opens the bytes, this column keeps its click for itself
                            event.stopPropagation();
                            this.caller = this.caller === burst.pc ? undefined : burst.pc;
                            this.update();
                        }}
                    >
                        {this.callerLabel(burst.pc)}
                    </button>
                </td>
            </tr>
            {opened && <tr className='vp-sram-detail'>
                <td />
                <td colSpan={4}>{this.renderDetail(burst)}</td>
            </tr>}
        </React.Fragment>;
    }

    // cut well short of a whole burst, as the beginning of a run is where anything surprising about it is
    protected renderDetail(burst: SramBurst): React.ReactNode {
        const mask = this.window - 1;
        const rows: React.ReactNode[] = [];
        for (const run of burst.runs) {
            for (let index = 0; index < run.values.length && rows.length < MAX_DETAIL_ROWS; index++) {
                const address = addressIn(run, index) >>> 0;
                rows.push(<tr key={rows.length}>
                    <td>{hex(address & mask, 4)}</td>
                    <td>0x{hex(address, 8)}</td>
                    <td>0x{hex(run.values[index], 2)}</td>
                    <td>{widthOf(run.type)}</td>
                </tr>);
            }
        }

        return <div className='vp-sram-bytes vp-scroll'>
            <table>
                <thead>
                    <tr>
                        <th>{nls.localize('vueport/debug/panels/sram/offset', 'Offset')}</th>
                        <th>{nls.localize('vueport/debug/panels/sram/address', 'Address')}</th>
                        <th>{nls.localize('vueport/debug/panels/sram/value', 'Value')}</th>
                        <th>{nls.localize('vueport/debug/panels/sram/width', 'Width')}</th>
                    </tr>
                </thead>
                <tbody>{rows}</tbody>
            </table>
            {burst.bytes > rows.length && <div className='vp-sram-more'>
                {nls.localize('vueport/debug/panels/sram/more', 'and {0} more', burst.bytes - rows.length)}
            </div>}
        </div>;
    }
}
