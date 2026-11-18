import { FileX, Plug, Warning, X } from '@phosphor-icons/react';
import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import EmptyContainer from '../components/kit/EmptyContainer';
import PanelFilter from '../components/kit/PanelFilter';
import { isSubclassOf } from '../core/emulator-classes';
import {
    describesMemoryPool,
    parseMemoryPoolLayout,
    readMemoryPoolUsage,
    symbolsMatchRunningBuild,
    VesMemoryPool,
    VesMemoryPoolLayout,
    VesMemoryPoolUsage,
} from '../core/emulator-memory-pool';
import { emulatorPanelLabel, EmulatorPanelType, DebugSource, Panel } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import {
    nextTableSort, SortableHeader, sortTableRows, TableSort,
} from './emulator-sortable-table';

// the share of a pool at which the engine itself starts complaining (__MEMORY_POOL_WARNING_THRESHOLD). Projects
// can move it, but the engine's default is a sound place to flag a pool before it overflows.
const WARNING_THRESHOLD = 85;

// a minute, at the rate the panel reads
const HISTORY_SAMPLES = 240;

// the graph's drawing box, stretched to the panel's width by CSS
const GRAPH_WIDTH = 300;
const GRAPH_HEIGHT = 48;

enum PoolStatus {
    OK = 'ok',
    NOT_RUNNING = 'notRunning',
    NO_SYMBOLS = 'noSymbols',
    NOT_VUENGINE = 'notVuengine',
    NOT_INITIALIZED = 'notInitialized',
    WRONG_BUILD = 'wrongBuild',
}

// what the bars are colored by, read off the class hierarchy so a project's own classes fall where their bases put
// them. Graphics is the textures and char sets standing for claimed VRAM, which grows with what is on screen.
type OccupantKind = 'actor' | 'component' | 'graphics' | 'other' | 'raw';

const KINDS: OccupantKind[] = ['actor', 'component', 'graphics', 'other', 'raw'];

// the row for blocks with no class in them, a name no class can have
const RAW_KEY = '\0raw';

interface ClassTotal {
    key: string;
    name: string;
    kind: OccupantKind;
    count: number;
    bytes: number;
    // normally just one
    blockSizes: number[];
}

type OccupantSortColumn = 'name' | 'count' | 'block' | 'bytes';

/**
 * VUEngine allocates every dynamic object out of MemoryPool: pools of equally sized blocks, sized per project at
 * compile time and never grown, so running out is a crash. The engine can only print totals on screen
 * (MemoryPool::printDetailedUsage); this panel also shows which classes the used blocks hold, read from each object's
 * vTable pointer. Both come out of a single read of the pool struct, see parseMemoryPoolLayout.
 */
export class MemoryPoolsPanel extends Panel {

    // slower than the default: a read is the whole heap struct (tens of KB), and every block in it is walked
    protected static readonly POOLS_POLL_HZ = 4;

    protected status = PoolStatus.NOT_RUNNING;
    // not `layout`: that name belongs to Lumino's Widget, and shadowing its accessor leaves the dock reading undefined
    protected poolLayout?: VesMemoryPoolLayout;
    protected usage?: VesMemoryPoolUsage[];
    protected kinds = new Map<string, OccupantKind>();
    // symbols from a different build leave the pool figures usable but the occupant names not
    protected staleSymbols = false;
    protected error?: string;
    protected reading = false;
    protected occupantSort: TableSort<OccupantSortColumn> = {};
    // not remembered across sessions, unlike the display controls: a list silently hiding most of itself is the wrong
    // way to be reminded of an old filter
    protected occupantFilter = '';
    // by its address, not remembered for the same reason
    protected selectedPool?: number;
    protected selectedClass?: string;
    // all shown to begin with, not remembered
    protected readonly hiddenKinds = new Set<OccupantKind>();
    // heap share in use (oldest first) and the most blocks each pool has held at once. Neither is kept by the engine:
    // they are what this panel has seen, and start again whenever the pools turn out to be another build's.
    protected history: number[] = [];
    protected peaks: number[] = [];
    protected peakShare = 0;
    // which pool table the history and peaks describe, see track()
    protected trackedLayout?: string;

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.MEMORY_POOLS, source, instanceId);
        this.title.label = emulatorPanelLabel(EmulatorPanelType.MEMORY_POOLS);
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.MEMORY_POOLS);
    }

    protected pollHz(): number {
        return MemoryPoolsPanel.POOLS_POLL_HZ;
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.reset(PoolStatus.NOT_RUNNING);
            // unlike the paths below this one does not reach the redraw in finally, and a machine that has gone away has to
            // stop being described
            this.update();
            return;
        }
        // a tick arriving while the last read is still out would only queue work the panel is about to throw away
        if (this.reading) {
            return;
        }
        this.reading = true;

        try {
            const symbols = await this.source.getSymbols();
            if (!symbols) {
                this.reset(PoolStatus.NO_SYMBOLS);
                return;
            }
            const pool = symbols.memoryPool;
            if (!pool) {
                this.reset(PoolStatus.NOT_VUENGINE);
                return;
            }

            // the linker's size for the singleton is exactly the struct, which lets the arrays at its end be found from its end
            const region = new Uint8Array(await sim.readMemory(pool.address, pool.size));
            const layout = parseMemoryPoolLayout(pool.address, region);
            if (!layout) {
                // two different failures: a machine that has not reached MemoryPool::reset yet will start working on its own,
                // symbols describing a different build never will
                const isPool = describesMemoryPool(region, symbols.vTables);
                console.warn(
                    '[emulator] memory pools did not parse at 0x%s (%d bytes); '
                    + 'the singleton\'s vTable %s the symbols\' MemoryPool',
                    pool.address.toString(16).toUpperCase(), pool.size, isPool ? 'matches' : 'does NOT match'
                );
                this.reset(isPool ? PoolStatus.NOT_INITIALIZED : PoolStatus.WRONG_BUILD);
                return;
            }

            // a symbol table from another build names the wrong classes rather than none, so it is checked against the machine
            // and dropped entirely if it disagrees
            this.staleSymbols = !symbolsMatchRunningBuild(layout, symbols.vTables);
            this.poolLayout = layout;
            this.usage = readMemoryPoolUsage(
                layout, region, this.staleSymbols ? new Map() : symbols.vTables
            );
            this.kinds = new Map();
            for (const { classes } of this.usage) {
                for (const { name } of classes) {
                    if (!this.kinds.has(name)) {
                        this.kinds.set(name, kindOf(symbols.classes, name));
                    }
                }
            }
            this.track(layout, this.usage);
            this.status = PoolStatus.OK;
            this.error = undefined;
        } catch (error) {
            // logged whole: the panel shows one line, and only the stack says whether the symbol read, the worker RPC or the
            // parse failed
            console.error('[emulator] memory pools could not be read:', error);
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.reading = false;
            this.update();
        }
    }

    protected track(layout: VesMemoryPoolLayout, usage: VesMemoryPoolUsage[]): void {
        const key = layout.pools.map(pool => `${pool.address}:${pool.blockSize}:${pool.blocks}`).join(',');
        if (key !== this.trackedLayout) {
            this.trackedLayout = key;
            this.resetPeaks();
        }
        const used = usage.reduce((total, pool) => total + pool.usedBytes, 0);
        const share = layout.totalBytes > 0 ? used / layout.totalBytes : 0;
        this.history.push(share);
        if (this.history.length > HISTORY_SAMPLES) {
            this.history.shift();
        }
        this.peakShare = Math.max(this.peakShare, share);
        usage.forEach((pool, index) => {
            this.peaks[index] = Math.max(this.peaks[index] ?? 0, pool.usedBlocks);
        });
    }

    protected resetPeaks(): void {
        this.history = [];
        this.peaks = [];
        this.peakShare = 0;
    }

    protected reset(status: PoolStatus): void {
        this.status = status;
        this.poolLayout = undefined;
        this.usage = undefined;
        this.staleSymbols = false;
        this.error = undefined;
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return <EmptyContainer title={this.error} icon={<Warning size={32} />} />;
        }

        const layout = this.poolLayout;
        const usage = this.usage;
        if (!layout || !usage) {
            return this.renderEmpty();
        }

        const usedBytes = usage.reduce((total, pool) => total + pool.usedBytes, 0);
        const usedBlocks = usage.reduce((total, pool) => total + pool.usedBlocks, 0);
        const totalBlocks = layout.pools.reduce((total, pool) => total + pool.blocks, 0);
        // a pool table from a rebuilt ROM can leave the pick pointing at a pool that is no longer there
        const selectedPool = layout.pools.find(pool => pool.address === this.selectedPool);

        return <div className='vp-memory-pools'>
            {this.renderSummary(layout.totalBytes, usedBytes, usedBlocks, totalBlocks)}
            {!this.staleSymbols && this.renderLegend()}
            {this.renderPools(layout.pools, usage, selectedPool)}
            {this.renderClasses(layout.pools, usage, usedBytes, selectedPool)}
        </div>;
    }

    protected renderEmpty(): React.ReactNode {
        const titles: Record<PoolStatus, string> = {
            [PoolStatus.OK]: '',
            [PoolStatus.NOT_RUNNING]: nls.localize(
                'vueport/general/notRunning', 'The emulator is not running.'
            ),
            [PoolStatus.NO_SYMBOLS]: nls.localize(
                'vueport/general/noSymbols', 'No symbols for this ROM.'
            ),
            [PoolStatus.NOT_VUENGINE]: nls.localize(
                'vueport/debug/panels/memoryPools/notVuengine', 'No memory pools in this ROM.'
            ),
            [PoolStatus.NOT_INITIALIZED]: nls.localize(
                'vueport/debug/panels/memoryPools/notInitialized', 'The memory pools are not up yet.'
            ),
            [PoolStatus.WRONG_BUILD]: nls.localize(
                'vueport/debug/panels/memoryPools/wrongBuild', 'The symbols belong to a different build.'
            ),
        };
        const descriptions: Partial<Record<PoolStatus, string>> = {
            [PoolStatus.NO_SYMBOLS]: nls.localize(
                'vueport/general/noSymbolsDescription',
                'Reading the pools needs the .elf the ROM was built from, which is found through the .map \
file beside it. A ROM built elsewhere, or built without either, cannot be inspected this way.'
            ),
            [PoolStatus.NOT_VUENGINE]: nls.localize(
                'vueport/debug/panels/memoryPools/notVuengineDescription',
                'This ROM has symbols, but none for MemoryPool. Only games built on VUEngine allocate \
through it.'
            ),
            [PoolStatus.NOT_INITIALIZED]: nls.localize(
                'vueport/debug/panels/memoryPools/notInitializedDescription',
                'The engine describes its pools as it constructs them. This clears once the game reaches \
that point in its startup.'
            ),
            [PoolStatus.WRONG_BUILD]: nls.localize(
                'vueport/debug/panels/memoryPools/wrongBuildDescription',
                'The .elf beside this ROM puts the memory pools somewhere the running machine does not \
have them, so it was made by a different build. Rebuild, or restart the emulator so the ROM and its \
symbols are read together.'
            ),
        };

        // the icon says which: nothing to read yet, or nothing to read it with
        const missingSymbols = this.status === PoolStatus.NO_SYMBOLS
            || this.status === PoolStatus.NOT_VUENGINE
            || this.status === PoolStatus.WRONG_BUILD;

        return <EmptyContainer
            title={titles[this.status]}
            description={descriptions[this.status]}
            icon={missingSymbols ? <FileX size={32} /> : <Plug size={32} />}
        />;
    }

    protected renderSummary(
        totalBytes: number, usedBytes: number, usedBlocks: number, totalBlocks: number
    ): React.ReactNode {
        const y = (share: number): number => GRAPH_HEIGHT - share * GRAPH_HEIGHT;
        const step = GRAPH_WIDTH / (HISTORY_SAMPLES - 1);
        // right-aligned, so the newest read is at the right edge and the line grows in from the left
        const start = HISTORY_SAMPLES - this.history.length;
        const line = this.history
            .map((share, index) => `${((start + index) * step).toFixed(1)},${y(share).toFixed(1)}`)
            .join(' ');
        const peak = y(this.peakShare);

        return <div className='vp-memory-pools-summary'>
            <div className='vp-memory-pools-total'>
                <div>
                    <strong>{percent(usedBytes, totalBytes)}%</strong>
                    <span className='hint'>
                        {nls.localize('vueport/debug/panels/memoryPools/ofHeap', 'of the heap')}
                    </span>
                </div>
                <span className='hint vp-memory-pools-number'>
                    {nls.localize(
                        'vueport/debug/panels/memoryPools/totalBytes', '{0} of {1} bytes', bytes(usedBytes), bytes(totalBytes)
                    )}
                </span>
                <span className='hint vp-memory-pools-number'>
                    {nls.localize(
                        'vueport/debug/panels/memoryPools/totalBlocks', '{0} of {1} blocks', count(usedBlocks), count(totalBlocks)
                    )}
                </span>
            </div>
            <div className='vp-memory-pools-history'>
                <div className='vp-memory-pools-history-head'>
                    <span className='hint'>
                        {nls.localize('vueport/debug/panels/memoryPools/lastMinute', 'Last minute')}
                    </span>
                    <span>
                        <span className='hint'>{nls.localize('vueport/debug/panels/memoryPools/peak', 'Peak')}</span>
                        {' '}
                        <span className='vp-memory-pools-number'>{Math.round(this.peakShare * 100)}%</span>
                    </span>
                    <button
                        type='button'
                        className='vp-memory-pools-reset'
                        title={nls.localize(
                            'vueport/debug/panels/memoryPools/resetHint',
                            'Forget the peaks and the graph and start watching from now. Nothing in the \
machine is touched: the engine keeps neither, this panel does.'
                        )}
                        onClick={() => {
                            this.resetPeaks();
                            this.update();
                        }}
                    >
                        {nls.localize('vueport/debug/panels/memoryPools/reset', 'Reset')}
                    </button>
                </div>
                <svg
                    viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                    preserveAspectRatio='none'
                    role='img'
                    aria-label={nls.localize(
                        'vueport/debug/panels/memoryPools/historyLabel', 'Share of the heap in use over the last minute'
                    )}
                >
                    {this.history.length > 0 && <>
                        <line className='vp-memory-pools-history-peak' x1={0} x2={GRAPH_WIDTH} y1={peak} y2={peak} />
                        <polygon
                            className='vp-memory-pools-history-area'
                            points={`${(start * step).toFixed(1)},${GRAPH_HEIGHT} ${line} ${GRAPH_WIDTH},${GRAPH_HEIGHT}`}
                        />
                        <polyline className='vp-memory-pools-history-line' points={line} />
                    </>}
                </svg>
            </div>
        </div>;
    }

    protected renderLegend(): React.ReactNode {
        return <div className='vp-memory-pools-legend'>
            {KINDS.map(kind => <span key={kind}>
                <span className={`vp-memory-pools-swatch vp-memory-pools-kind-${kind}`} />
                {kindLabel(kind)}
            </span>)}
            <span>
                <span className='vp-memory-pools-swatch vp-memory-pools-peak-swatch' />
                {nls.localize('vueport/debug/panels/memoryPools/peak', 'Peak')}
            </span>
        </div>;
    }

    protected renderPools(
        pools: VesMemoryPool[], usage: VesMemoryPoolUsage[], selected: VesMemoryPool | undefined
    ): React.ReactNode {
        return (
            <table className='vp-memory-pools-table vp-memory-pools-pools vp-table vp-selectable-table'>
                <thead>
                    <tr>
                        <th title={nls.localize(
                            'vueport/debug/panels/memoryPools/blockHint',
                            'How many bytes one block of this pool holds. An allocation takes the \
smallest block it fits in, so anything it does not use is lost until it is freed.'
                        )}>
                            {nls.localize('vueport/debug/panels/memoryPools/block', 'Block')}
                        </th>
                        <th className='vp-memory-pools-usage' title={nls.localize(
                            'vueport/debug/panels/memoryPools/occupancyHint',
                            'What the used blocks hold, by kind, and the most this pool has had in use \
since the panel started watching. Click a pool to see only its occupants.'
                        )}>
                            {nls.localize('vueport/debug/panels/memoryPools/occupancy', 'Occupancy')}
                        </th>
                        <th title={nls.localize(
                            'vueport/debug/panels/memoryPools/usedHint',
                            'Blocks in use, of how many the project gave this pool. Fixed at build \
time: running out is what the overflow column counts.'
                        )}>
                            {nls.localize('vueport/debug/panels/memoryPools/used', 'Used')}
                        </th>
                        <th>%</th>
                        <th title={nls.localize(
                            'vueport/debug/panels/memoryPools/overflowsHint',
                            'How often an allocation did not fit here and had to take a larger block. \
The engine counts these in a byte it never clears, so a long run can wrap it.'
                        )}>
                            {nls.localize('vueport/debug/panels/memoryPools/overflows', 'Over')}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {pools.map((pool, index) => {
                        const used = usage[index].usedBlocks;
                        const share = percent(used, pool.blocks);
                        const isSelected = pool === selected;
                        return <tr
                            key={pool.address}
                            className={isSelected ? 'selected' : undefined}
                            aria-selected={isSelected}
                            onClick={() => {
                                this.selectedPool = isSelected ? undefined : pool.address;
                                this.update();
                            }}
                        >
                            <td className='vp-memory-pools-number'>{pool.blockSize} B</td>
                            <td className='vp-memory-pools-usage'>
                                {this.renderPoolBar(pool, usage[index], this.peaks[index] ?? used)}
                            </td>
                            <td
                                className='vp-memory-pools-number vp-memory-pools-used'
                                title={nls.localize(
                                    'vueport/debug/panels/memoryPools/poolHint',
                                    '{0} blocks free · {1} bytes of WRAM, used or not',
                                    count(pool.blocks - used), bytes(pool.poolSize)
                                )}
                            >
                                <span>{count(used)}</span> / {count(pool.blocks)}
                            </td>
                            <td className={`vp-memory-pools-number${share >= WARNING_THRESHOLD ? ' vp-memory-pools-warn' : ''}`}>
                                {share}%
                            </td>
                            <td className='vp-memory-pools-number'>
                                {pool.overflows > 0 && <span className='vp-memory-pools-over'>
                                    <Warning size={11} />
                                    {pool.overflows}
                                </span>}
                            </td>
                        </tr>;
                    })}
                </tbody>
            </table>
        );
    }

    // one pool's blocks split by what is in them, kind by kind with the biggest class of each first, and a peak tick
    protected renderPoolBar(pool: VesMemoryPool, usage: VesMemoryPoolUsage, peak: number): React.ReactNode {
        const segments: { key: string, name: string, kind: OccupantKind, count: number }[] = usage.classes
            .map(({ name, count: occupants }) => ({ key: name, name, kind: this.kindOf(name), count: occupants }));
        if (usage.unidentified > 0) {
            segments.push({ key: RAW_KEY, name: rawLabel(), kind: 'raw', count: usage.unidentified });
        }
        segments.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || b.count - a.count);
        const picked = this.selectedClass;

        return <div className='vp-memory-pools-bar'>
            {segments.map(segment => <div
                key={segment.key}
                className={`vp-memory-pools-kind-${segment.kind}${picked !== undefined && picked !== segment.key ? ' dim' : ''}`}
                style={{ width: `${(100 * segment.count) / pool.blocks}%` }}
                title={`${segment.name} × ${count(segment.count)}`}
            />)}
            <div
                className='vp-memory-pools-peak'
                style={{ left: `${Math.min(100, (100 * peak) / pool.blocks)}%` }}
                title={nls.localize('vueport/debug/panels/memoryPools/peakHint', 'Peak: {0} blocks', count(peak))}
            />
        </div>;
    }

    // a class allocates the same size every time, so one listed against several block sizes spilled over from a full
    // pool (what the overflow column counts). Those sizes are all shown even with a pool picked.
    protected renderClasses(
        pools: VesMemoryPool[], usage: VesMemoryPoolUsage[], usedBytes: number, selected: VesMemoryPool | undefined
    ): React.ReactNode {
        const title = <strong className='vp-memory-pools-box-title'>
            {nls.localize('vueport/debug/panels/memoryPools/classes', 'Occupants')}
        </strong>;
        if (this.staleSymbols) {
            // the figures are read from the machine, only the names need symbols, so only they are withheld
            return <section className='vp-memory-pools-box'>
                <div className='vp-memory-pools-box-head'>{title}</div>
                <div className='hint vp-memory-pools-note'>
                    {nls.localize(
                        'vueport/debug/panels/memoryPools/staleSymbols',
                        'The symbols beside this ROM belong to a different build, so they would name the \
wrong classes. Rebuild, or reload the ROM, to see what the blocks hold. The figures above are read from \
the running machine and are unaffected.'
                    )}
                </div>
            </section>;
        }

        const everywhere = new Map<string, number[]>();
        const totals = new Map<string, ClassTotal>();
        usage.forEach((pool, index) => {
            const blockSize = pools[index].blockSize;
            const entries = pool.classes.map(({ name, count: occupants }) => ({ key: name, name, occupants }));
            if (pool.unidentified > 0) {
                entries.push({ key: RAW_KEY, name: rawLabel(), occupants: pool.unidentified });
            }
            for (const { key, name, occupants } of entries) {
                everywhere.set(key, [...everywhere.get(key) ?? [], blockSize]);
                if (selected && pools[index] !== selected) {
                    continue;
                }
                const total = totals.get(key)
                    ?? { key, name, kind: key === RAW_KEY ? 'raw' : this.kindOf(name), count: 0, bytes: 0, blockSizes: [] };
                total.count += occupants;
                total.bytes += occupants * blockSize;
                totals.set(key, total);
            }
        });
        for (const total of totals.values()) {
            total.blockSizes = everywhere.get(total.key) ?? [];
        }

        // the no-class row is filtered like any other, as a filter that quietly kept it would look like a match
        const rows = [...totals.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
        const needle = this.occupantFilter.trim().toLowerCase();
        const matching = rows.filter(row => !this.hiddenKinds.has(row.kind)
            && (needle === '' || row.name.toLowerCase().includes(needle)));
        const kinds = KINDS
            .map(kind => ({ kind, blocks: rows.filter(row => row.kind === kind).reduce((total, row) => total + row.count, 0) }))
            .filter(({ blocks }) => blocks > 0);
        const shown = sortTableRows(matching, this.occupantSort, (row, column) => {
            switch (column) {
                case 'name': return row.name;
                case 'count': return row.count;
                case 'block': return Math.min(...row.blockSizes);
                case 'bytes': return row.bytes;
            }
        });
        const sort = (column: OccupantSortColumn) => {
            this.occupantSort = nextTableSort(this.occupantSort, column);
            this.update();
        };

        return <section className='vp-memory-pools-box vp-memory-pools-occupants'>
            <div className='vp-memory-pools-box-head'>
                {title}
                {selected && <button
                        type='button'
                        className='vp-memory-pools-chip'
                        aria-label={nls.localize('vueport/debug/panels/memoryPools/allPools', 'Show every pool')}
                        onClick={() => {
                            this.selectedPool = undefined;
                            this.update();
                        }}
                    >
                        {nls.localize('vueport/debug/panels/memoryPools/inPool', 'In the {0} B pool', selected.blockSize)}
                        <X size={11} />
                    </button>}
                {rows.length > 0 && <PanelFilter
                    value={this.occupantFilter}
                    placeholder={nls.localize('vueport/debug/panels/memoryPools/filter', 'Filter classes')}
                    missed={shown.length === 0}
                    onChange={value => { this.occupantFilter = value; this.update(); }}
                />}
            </div>
            {kinds.length > 1 && <div
                className='vp-memory-pools-kinds'
                role='group'
                aria-label={nls.localize('vueport/debug/panels/memoryPools/kindFilter', 'Kinds of occupant to list')}
            >
                {kinds.map(({ kind, blocks }) => {
                    const on = !this.hiddenKinds.has(kind);
                    return <button
                        key={kind}
                        type='button'
                        className='vp-memory-pools-kind-toggle'
                        aria-pressed={on}
                        title={nls.localize(
                            'vueport/debug/panels/memoryPools/kindToggleHint',
                            'List these occupants, or leave them out. The pools above are not affected.'
                        )}
                        onClick={() => {
                            if (on) {
                                this.hiddenKinds.add(kind);
                            } else {
                                this.hiddenKinds.delete(kind);
                            }
                            this.update();
                        }}
                    >
                        <span className={`vp-memory-pools-swatch vp-memory-pools-kind-${kind}`} />
                        {kindLabel(kind)}
                        <span className='vp-memory-pools-kind-count'>{count(blocks)}</span>
                    </button>;
                })}
            </div>}
            <div className='vp-memory-pools-box-body vp-scroll'>
                {rows.length === 0 && <div className='hint'>
                    {selected
                        ? nls.localize('vueport/debug/panels/memoryPools/poolEmpty', 'Nothing is allocated in this pool.')
                        : nls.localize('vueport/debug/panels/memoryPools/nothingAllocated', 'Nothing is allocated.')}
                </div>}
                {shown.length > 0 && <table className='vp-memory-pools-table vp-table vp-selectable-table'>
                    <thead>
                        <tr>
                            <SortableHeader className='vp-memory-pools-name'
                                column='name' sort={this.occupantSort} onSort={sort}>
                                {nls.localize('vueport/debug/panels/memoryPools/class', 'Class')}
                            </SortableHeader>
                            <SortableHeader column='count' sort={this.occupantSort} onSort={sort}>
                                {nls.localize('vueport/debug/panels/memoryPools/count', 'Count')}
                            </SortableHeader>
                            <SortableHeader column='block' sort={this.occupantSort} onSort={sort}>
                                {nls.localize('vueport/debug/panels/memoryPools/block', 'Block')}
                            </SortableHeader>
                            <SortableHeader column='bytes' sort={this.occupantSort} onSort={sort}>
                                {nls.localize('vueport/debug/panels/memoryPools/bytes', 'Bytes')}
                            </SortableHeader>
                            <th className='vp-memory-pools-share' title={nls.localize(
                                'vueport/debug/panels/memoryPools/shareHint', 'Its share of the bytes in use'
                            )}>
                                {nls.localize('vueport/debug/panels/memoryPools/share', 'Share')}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map(row => {
                            const spilled = row.kind !== 'raw' && row.blockSizes.length > 1;
                            const isSelected = this.selectedClass === row.key;
                            return <tr
                                key={row.key}
                                className={`${row.kind === 'raw' ? 'hint' : ''}${isSelected ? ' selected' : ''}`}
                                aria-selected={isSelected}
                                title={row.kind === 'raw' ? nls.localize(
                                    'vueport/debug/panels/memoryPools/unidentifiedHint',
                                    'Blocks holding something without a virtual table, which is what names the \
rest. Plain structs allocated with __NEW_BASIC are the usual reason.'
                                ) : undefined}
                                onClick={() => {
                                    this.selectedClass = isSelected ? undefined : row.key;
                                    this.update();
                                }}
                            >
                                <td className='vp-memory-pools-name'>
                                    <span className={`vp-memory-pools-swatch vp-memory-pools-kind-${row.kind}`} />
                                    {row.kind === 'raw' ? row.name : <code>{row.name}</code>}
                                </td>
                                <td className='vp-memory-pools-number'>{count(row.count)}</td>
                                <td
                                    className={`vp-memory-pools-number${spilled ? ' vp-memory-pools-warn' : ''}`}
                                    title={spilled ? nls.localize(
                                        'vueport/debug/panels/memoryPools/spilledHint',
                                        'Found in more than one pool: its own was full when some of these were \
allocated, so they took larger blocks.'
                                    ) : undefined}
                                >
                                    {spilled && <Warning size={11} />}
                                    {row.blockSizes.join(', ')}
                                </td>
                                <td className='vp-memory-pools-number'>{bytes(row.bytes)}</td>
                                <td className='vp-memory-pools-share'>
                                    <div className='vp-memory-pools-share-bar'>
                                        <div
                                            className={`vp-memory-pools-kind-${row.kind}`}
                                            style={{ width: `${usedBytes > 0 ? (100 * row.bytes) / usedBytes : 0}%` }}
                                        />
                                    </div>
                                </td>
                            </tr>;
                        })}
                    </tbody>
                </table>}
                {rows.length > 0 && shown.length === 0 && <div className='hint'>
                    {nls.localize(
                        'vueport/debug/panels/memoryPools/noneMatch', 'No class matches the filter.')}
                </div>}
            </div>
        </section>;
    }

    protected kindOf(name: string): OccupantKind {
        return this.kinds.get(name) ?? 'other';
    }
}

function kindOf(hierarchy: Map<string, string>, name: string): OccupantKind {
    if (isSubclassOf(hierarchy, name, 'Actor')) {
        return 'actor';
    }
    if (isSubclassOf(hierarchy, name, 'Component')) {
        return 'component';
    }
    if (isSubclassOf(hierarchy, name, 'Texture') || isSubclassOf(hierarchy, name, 'CharSet')) {
        return 'graphics';
    }
    return 'other';
}

function kindLabel(kind: OccupantKind): string {
    switch (kind) {
        case 'actor': return nls.localize('vueport/debug/panels/memoryPools/kind/actor', 'Actors');
        case 'component': return nls.localize('vueport/debug/panels/memoryPools/kind/component', 'Components');
        case 'graphics': return nls.localize('vueport/debug/panels/memoryPools/kind/graphics', 'Graphics memory');
        case 'other': return nls.localize('vueport/debug/panels/memoryPools/kind/other', 'Other objects');
        case 'raw': return rawLabel();
    }
}

function rawLabel(): string {
    return nls.localize('vueport/debug/panels/memoryPools/unidentified', 'Not an object');
}

// saturating rather than rounding up to 100
function percent(part: number, whole: number): number {
    if (whole <= 0) {
        return 0;
    }
    const share = (100 * part) / whole;
    return share > 0 && share < 1 ? 1 : Math.min(100, Math.round(share));
}

function count(value: number): string {
    return value.toLocaleString('en-US');
}

function bytes(value: number): string {
    return value.toLocaleString('en-US');
}
