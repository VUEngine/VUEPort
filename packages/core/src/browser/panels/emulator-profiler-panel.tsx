import { Message } from '@lumino/messaging';
import { CaretDown, CaretRight, Gauge, Plug, Record, Stop, X } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import {
    LiveProfileFrame,
    LiveProfileFunction,
    LiveProfileSnapshot,
    VES_LIVE_PROFILE_ROOT, LiveMachineCounters,
} from '../../common/emulator-live-profile';
import {
    VB_CLOCK_RATE, VB_CLOCKS_PER_BUFFER, VB_INTERRUPT_VECTOR_BASE, VbInterrupt,
} from '../../common/vb-constants';
import EmptyContainer from '../components/kit/EmptyContainer';
import PanelFilter from '../components/kit/PanelFilter';
import { BYTES_PER_MBIT } from '../emulator-types';
import { findFunctionAt, functionDisplayName, SymbolIndex } from '../core/emulator-symbols';
import { Sim } from '../core/vb-core';
import { emulatorPanelLabel, EmulatorPanelType, hex, DebugSource, Panel } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import {
    nextTableSort, SortableHeader, sortTableRows, TableSort,
} from './emulator-sortable-table';

enum ProfilerStatus {
    OK = 'ok',
    NOT_RUNNING = 'notRunning',
    WAITING = 'waiting',
}

interface ProfilerRow extends LiveProfileFunction {
    name: string;
    section: string;
    root: boolean;
}

interface ProfilerGroup {
    id: string; // sorting and grouping key, since two sections can have the same name
    name: string;
    self: number;
    selfAvg: number;
    selfPeak: number;
    calls: number;
    functions: number;
    rows: ProfilerRow[];
    // set when the group is a single row ("already running"), shown at the top level with the sections
    leaf?: ProfilerRow;
    // a leaf the filter or quiet fold took out. A section stays listed whatever happens to its rows, a leaf has no
    // figures of its own
    hidden?: boolean;
}

type ProfilerColumn = 'name' | 'self' | 'avg' | 'peak' | 'total' | 'calls' | 'cost';

interface ProfilerBaseline {
    shares: Map<string, number>; // percent of a frame
    names: Map<string, string>;
    busy: number;
}

const QUIET_SHARE = 0.001;

const ROOT_GROUP = '\u0000root';

// in percentage points
const BASELINE_THRESHOLD = 0.1;

const BASELINE_MOVERS = 3;

// handed in by the dock from its host since the debug source is read-only; absent on a host without recording
export interface VesProfileRecordingControl {
    isProfiling(): boolean;
    toggleProfiling(): void;
}

/**
 * Where the machine's clocks go, frame by frame, while it runs; the recording profiler only answers once the run is
 * over. It measures clocks, not samples: the execute callback reads the clock budget word the core decrements, so every
 * instruction's cost is exact. Percentages are shares of a real frame (VB_CLOCKS_PER_BUFFER clocks at 20 MHz). The
 * timeline draws the whole window so a bad frame can be seen; clicking one pins it, and the pinned frame is kept after
 * it scrolls out of the window.
 *
 * Idle is measured, not inferred: a game waiting for the next frame either halts or spins (VUEngine's frame loop is a
 * bare `while(!hasGameFrameStarted())`). VesLiveProfileCollector.harvestWait finds both, or the headline would read
 * 100% on most games; a wait loop it finds is named in the headline.
 *
 * Without the .elf beside the ROM every row is an address; only the labels change. The first row is not a function but
 * what ran in the call stack from before profiling began (VES_LIVE_PROFILE_ROOT).
 */
export class ProfilerPanel extends Panel {

    // slower than the default ten: every refresh aggregates the whole window (a hundred frames of a few hundred
    // functions) on the emulating worker
    protected static readonly PROFILER_POLL_HZ = 5;

    protected status = ProfilerStatus.NOT_RUNNING;
    protected snapshot?: LiveProfileSnapshot;
    protected symbols?: SymbolIndex;
    protected armed?: Sim;
    protected error?: string;
    protected reading = false;
    protected sort: TableSort<ProfilerColumn> = { column: 'avg', direction: 'descending' };
    protected showQuiet = false;
    // not remembered: a profiler that came back silently hiding most rows would look broken
    protected functionFilter = '';
    // `pinned` follows on the next read and freezes the figures
    protected pin?: number;
    // kept until unpinned, as it leaves the two-second window almost immediately
    protected pinned?: LiveProfileFrame;
    protected readonly sectionOpen = new Map<string, boolean>();
    // the busiest section, opened once on the first figures so not everything starts collapsed (a build without symbols
    // has a single section)
    protected autoOpen?: string;
    protected baseline?: ProfilerBaseline;

    constructor(
        source: DebugSource,
        instanceId: string,
        protected readonly recording?: VesProfileRecordingControl,
    ) {
        super(EmulatorPanelType.PROFILER, source, instanceId);
        this.title.label = emulatorPanelLabel(EmulatorPanelType.PROFILER);
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.PROFILER);
    }

    protected pollHz(): number {
        return ProfilerPanel.PROFILER_POLL_HZ;
    }

    // profiling is on only while the panel is visible: a callback on every instruction costs 1.5x on a call-heavy loop
    protected onAfterHide(msg: Message): void {
        super.onAfterHide(msg);
        this.disarm();
    }

    protected onBeforeDetach(msg: Message): void {
        this.disarm();
        super.onBeforeDetach(msg);
    }

    dispose(): void {
        this.disarm();
        super.dispose();
    }

    protected disarm(): void {
        const armed = this.armed;
        this.armed = undefined;
        this.snapshot = undefined;
        this.pin = undefined;
        this.pinned = undefined;
        this.baseline = undefined;
        this.autoOpen = undefined;
        this.sectionOpen.clear();
        armed?.setLiveProfiler(false).catch(() => undefined);
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.disarm();
            this.status = ProfilerStatus.NOT_RUNNING;
            this.update();
            return;
        }
        if (this.reading) {
            return;
        }
        this.reading = true;

        try {
            if (this.armed !== sim) {
                this.armed?.setLiveProfiler(false).catch(() => undefined);
                this.armed = sim;
                this.snapshot = undefined;
                await sim.setLiveProfiler(true);
            }
            const wanted = this.pinned ? undefined : this.pin;
            // before the symbols: an .elf of tens of MB should not hold up the first figures
            const snapshot = await sim.readLiveProfile(wanted);
            this.symbols = await this.source.getSymbols();
            this.snapshot = snapshot;
            if (snapshot && wanted !== undefined) {
                this.capture(snapshot, wanted);
            }
            this.status = snapshot && snapshot.frames > 0
                ? ProfilerStatus.OK
                : ProfilerStatus.WAITING;
            this.error = undefined;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
            this.status = ProfilerStatus.NOT_RUNNING;
        } finally {
            this.reading = false;
            this.update();
        }
    }

    protected capture(snapshot: LiveProfileSnapshot, wanted: number): void {
        if (snapshot.pinned) {
            this.pinned = snapshot.pinned;
        } else if (wanted <= snapshot.framesSeen - snapshot.frames) {
            this.pin = undefined;
        }
    }

    protected render(): React.ReactNode {
        const snapshot = this.snapshot;
        const recording = this.renderRecording();
        if (this.status !== ProfilerStatus.OK || !snapshot) {
            return recording
                ? <div className='vp-profiler'>{recording}{this.renderEmpty()}</div>
                : this.renderEmpty();
        }
        const rows = this.rows(snapshot);
        return <div className='vp-profiler'>
            {recording}
            {this.renderSummary(snapshot)}
            {this.renderTable(snapshot, this.groups(snapshot, rows))}
            {this.renderBaseline(snapshot, rows)}
        </div>;
    }

    protected renderRecording(): React.ReactNode {
        const control = this.recording;
        if (!control) {
            return undefined;
        }
        const active = control.isProfiling();
        if (!active && !this.source.sim) {
            return undefined;
        }
        return <div className='vp-profiler-recording'>
            <button
                type='button'
                className={active ? 'vp-button' : 'vp-button secondary'}
                aria-pressed={active}
                onClick={() => { control.toggleProfiling(); this.update(); }}
            >
                {active ? <Stop size={14} weight='fill' /> : <Record size={14} weight='fill' />}
                {active
                    ? nls.localize('vueport/debug/panels/profiler/stopRecording', 'Stop Profiling and Export')
                    : nls.localize('vueport/debug/panels/profiler/startRecording', 'Start Profiling')}
            </button>
            {/* says where the result goes, so the button is not mistaken for what the panel does */}
            <span className='hint'>
                {active
                    ? nls.localize(
                        'vueport/debug/panels/profiler/recordingActive',
                        'Recording. Stopping replays the session and exports its call tree as a file for \
profiler.firefox.com. The figures below go on measuring meanwhile.'
                    )
                    : nls.localize(
                        'vueport/debug/panels/profiler/recordingIdle',
                        'Records the whole session and exports its call tree as a file for \
profiler.firefox.com. It does not replace the figures below.'
                    )}
            </span>
        </div>;
    }

    protected renderEmpty(): React.ReactNode {
        const titles: Record<ProfilerStatus, string> = {
            [ProfilerStatus.OK]: '',
            [ProfilerStatus.NOT_RUNNING]: this.error ?? nls.localize(
                'vueport/general/notRunning', 'The emulator is not running.'
            ),
            [ProfilerStatus.WAITING]: nls.localize(
                'vueport/debug/panels/profiler/waiting', 'Waiting for the first frame.'
            ),
        };
        const descriptions: Partial<Record<ProfilerStatus, string>> = {
            [ProfilerStatus.WAITING]: nls.localize(
                'vueport/debug/panels/profiler/waitingDescription',
                'Figures appear as soon as the machine completes a frame. A machine that is paused \
completes none.'
            ),
        };
        return <EmptyContainer
            title={titles[this.status]}
            description={descriptions[this.status]}
            icon={this.status === ProfilerStatus.WAITING ? <Gauge size={32} /> : <Plug size={32} />}
        />;
    }

    protected renderMachine(machine: LiveMachineCounters): React.ReactNode {
        const m = machine.avg;
        const picture = VB_CLOCKS_PER_BUFFER;
        const bus = m.busVip + m.busVsu + m.busMisc + m.busCart + m.busSram + m.busWram;
        return <div className='vp-profiler-machine'>
            <div className='hint'>
                {nls.localize(
                    'vueport/debug/panels/profiler/machineVip',
                    'VIP drawing {0}% of a picture, held up {1} by the CPU',
                    percent(m.xpBusy, picture), duration(m.xpHeld),
                )}
            </div>
            <div className='hint'>
                {nls.localize(
                    'vueport/debug/panels/profiler/machineBus',
                    'bus {0}%: VIP {1}% · WRAM {2}% · cartridge {3}%',
                    percent(bus, picture), percent(m.busVip, picture),
                    percent(m.busWram, picture), percent(m.busCart, picture),
                )}
            </div>
            <div className='hint'>
                {nls.localize(
                    'vueport/debug/panels/profiler/machineCache',
                    'cache: {0} misses, {1}% fetching code',
                    count(Math.round(m.cacheMisses)), percent(m.fetchWait, picture),
                )}
            </div>
            <div className='hint'>
                {nls.localize(
                    'vueport/debug/panels/profiler/machineStalls',
                    'stalls {0}%: {1}% waiting for the VIP, {2}% in the pipeline',
                    percent(m.vipContention + m.pipelineWait, picture),
                    percent(m.vipContention, picture), percent(m.pipelineWait, picture),
                )}
            </div>
        </div>;
    }

    protected renderSummary(snapshot: LiveProfileSnapshot): React.ReactNode {
        const frame = this.pinned;
        const budget = snapshot.frameClocks;
        const halted = frame ? frame.halted : snapshot.halted;
        const waiting = frame ? frame.waited : snapshot.waiting;
        const clocks = frame ? frame.clocks : snapshot.clocks;
        const busy = clocks - halted - waiting;
        const number = frame ? frame.number : snapshot.framesSeen;
        const busyAvg = snapshot.clocksAvg - snapshot.haltedAvg - snapshot.waitingAvg;
        const busyShare = share(busy, budget);
        const over = busy > budget;
        const waitingAt = frame ? frame.waitAt : snapshot.waitingAt;
        const pictures = Math.round(budget / VB_CLOCKS_PER_BUFFER);
        // a separate statement, as the nls extractor does not look inside another call's arguments
        const naming = this.symbols
            ? nls.localize('vueport/debug/panels/profiler/named', 'named from the build')
            : nls.localize('vueport/debug/panels/profiler/unnamed', 'no symbols: addresses only');

        return <div className='vp-profiler-summary'>
            <div className='vp-profiler-headline'>
                {/* over the frame, not merely at it: a machine that never waits is at exactly 100% and is fine */}
                <strong className={over ? 'vp-profiler-over' : undefined}>
                    {busyShare.toFixed(1)}%
                </strong>
                <span className={over ? 'vp-profiler-overran' : 'hint'}>
                    {over
                        ? nls.localize(
                            'vueport/debug/panels/profiler/overran',
                            'frame {0} overran by {1}', count(number), millis(busy - budget)
                        )
                        : nls.localize(
                            'vueport/debug/panels/profiler/busy',
                            'of frame {0} busy · {1} idle',
                            count(number), duration(halted + waiting)
                        )}
                </span>
                {/* the idling was a loop rather than a halted processor */}
                {waiting > 0 && <span className='hint vp-profiler-waiting'>
                    {waitingAt === VES_LIVE_PROFILE_ROOT
                        ? nls.localize(
                            'vueport/debug/panels/profiler/waitingInRoot',
                            '{0} of it spinning in a loop that was already running',
                            duration(waiting)
                        )
                        : nls.localize(
                            'vueport/debug/panels/profiler/waitingIn',
                            '{0} of it spinning in {1}',
                            duration(waiting),
                            this.describe(waitingAt, nls.localize(
                                'vueport/debug/panels/profiler/other', 'Other')).name
                        )}
                </span>}
                <span className='hint vp-profiler-window'>
                    {nls.localize(
                        'vueport/debug/panels/profiler/window',
                        'avg {0}% · {1} frames · {2}',
                        percent(busyAvg, budget),
                        count(snapshot.frames),
                        naming,
                    )}
                    {/* a frame here is the game's (__FRAME_CYCLE), not the VIP's */}
                    {pictures > 1 && ` · ${nls.localize(
                        'vueport/debug/panels/profiler/pictures',
                        '{0} pictures to a frame', count(pictures)
                    )}`}
                    {snapshot.resets > 0 && ` · ${nls.localize(
                        'vueport/debug/panels/profiler/resets', '{0} restarts', count(snapshot.resets)
                    )}`}
                </span>
            </div>
            {snapshot.machine && this.renderMachine(snapshot.machine)}
            {this.renderTimeline(snapshot)}
        </div>;
    }

    protected renderTimeline(snapshot: LiveProfileSnapshot): React.ReactNode {
        const budget = snapshot.frameClocks;
        const history = snapshot.frameBusy;
        const oldest = snapshot.framesSeen - history.length + 1;
        let scale = budget;
        for (const busy of history) {
            scale = Math.max(scale, busy);
        }

        return <div className='vp-profiler-timeline-block'>
            <div
                className='vp-profiler-timeline'
                role='group'
                aria-label={nls.localize(
                    'vueport/debug/panels/profiler/timeline',
                    'The last {0} frames. Pin one to see what was in it.', count(history.length)
                )}
                onKeyDown={event => this.onTimelineKey(event, oldest, snapshot.framesSeen)}
            >
                <div className='vp-profiler-budget' style={{ bottom: `${(100 * budget) / scale}%` }} />
                {history.map((busy, index) => {
                    const number = oldest + index;
                    const pinned = number === this.pin;
                    const label = nls.localize(
                        'vueport/debug/panels/profiler/frameBar',
                        'Frame {0}: {1}% of a frame', count(number), percent(busy, budget)
                    );
                    return <button
                        key={number}
                        type='button'
                        className={'vp-profiler-frame'
                            + (busy > budget ? ' over' : '')
                            + (pinned ? ' pinned' : '')}
                        tabIndex={number === (this.pin ?? snapshot.framesSeen) ? 0 : -1}
                        aria-pressed={pinned}
                        aria-label={label}
                        title={label}
                        style={{ height: `${Math.max(2, (100 * busy) / scale)}%` }}
                        onClick={() => this.togglePin(number)}
                    />;
                })}
            </div>
            <div className='hint vp-profiler-axis'>
                <span>{nls.localize(
                    'vueport/debug/panels/profiler/framesAgo', '{0} frames ago', count(history.length)
                )}</span>
                <span>{nls.localize(
                    'vueport/debug/panels/profiler/budgetLine',
                    'the line is the {0} a frame has · click a frame to pin it', millis(budget)
                )}</span>
                <span>{nls.localize('vueport/debug/panels/profiler/axisNow', 'now')}</span>
            </div>
        </div>;
    }

    protected onTimelineKey(
        event: React.KeyboardEvent, oldest: number, newest: number
    ): void {
        const at = this.pin ?? newest;
        let next: number | undefined;
        switch (event.key) {
            case 'ArrowLeft': next = Math.max(oldest, at - 1); break;
            case 'ArrowRight': next = Math.min(newest, at + 1); break;
            case 'Home': next = oldest; break;
            case 'End': next = newest; break;
            case 'Escape': next = undefined; break;
            default: return;
        }
        event.preventDefault();
        if (next === undefined) {
            this.unpin();
        } else {
            this.setPin(next);
        }
    }

    protected togglePin(number: number): void {
        if (this.pin === number) {
            this.unpin();
        } else {
            this.setPin(number);
        }
    }

    protected setPin(number: number): void {
        this.pin = number;
        this.pinned = undefined;
        this.update();
        // straight away: the window moves 50 times a second and the panel reads it five times, so the frame could leave
        this.poll();
    }

    protected unpin(): void {
        this.pin = undefined;
        this.pinned = undefined;
        this.update();
    }

    protected renderTable(
        snapshot: LiveProfileSnapshot,
        { groups, quiet, filtered }: { groups: ProfilerGroup[]; quiet: number; filtered: boolean }
    ): React.ReactNode {
        const frame = this.pinned;
        const sort = (column: ProfilerColumn) => {
            this.sort = nextTableSort(this.sort, column);
            this.update();
        };

        return <div className='vp-profiler-tree'>
            <div className='vp-profiler-tree-head'>
                <span className='vp-profiler-tree-title'>
                    {frame
                        ? nls.localize(
                            'vueport/debug/panels/profiler/pinnedTitle',
                            'Frame {0}, pinned — where the clocks went', count(frame.number)
                        )
                        : nls.localize(
                            'vueport/debug/panels/profiler/liveTitle',
                            'The last frame — where the clocks went'
                        )}
                </span>
                {this.pin !== undefined && <button
                    type='button'
                    className='vp-profiler-unpin'
                    onClick={() => this.unpin()}
                >{nls.localize('vueport/debug/panels/profiler/unpin', 'Unpin')}</button>}
                <PanelFilter
                    value={this.functionFilter}
                    placeholder={nls.localize('vueport/debug/panels/profiler/filter', 'Filter functions')}
                    onChange={value => { this.functionFilter = value; this.update(); }}
                />
            </div>
            <div className='vp-profiler-rows vp-scroll'>
                <table className='vp-profiler-table vp-table vp-selectable-table'>
                    <thead>
                        <tr>
                            <SortableHeader className='vp-profiler-name'
                                column='name' sort={this.sort} onSort={sort}>
                                {nls.localize(
                                    'vueport/debug/panels/profiler/sectionFunction', 'Section / Function')}
                            </SortableHeader>
                            <SortableHeader column='self' sort={this.sort} onSort={sort}
                                title={nls.localize(
                                    'vueport/debug/panels/profiler/selfHint',
                                    'The share of that one frame — the newest, or the pinned one — spent \
in this code itself, not counting anything it called.'
                                )}>
                                {frame
                                    ? nls.localize(
                                        'vueport/debug/panels/profiler/frameColumn',
                                        'Frame {0}', count(frame.number))
                                    : nls.localize('vueport/debug/panels/profiler/now', 'Now')}
                            </SortableHeader>
                            <SortableHeader column='avg' sort={this.sort} onSort={sort}>
                                {nls.localize('vueport/debug/panels/profiler/avg', 'Avg')}
                            </SortableHeader>
                            <SortableHeader column='peak' sort={this.sort} onSort={sort}
                                title={nls.localize(
                                    'vueport/debug/panels/profiler/peakHint',
                                    'The worst frame of the window. A section adds up its functions\' \
worst frames, which is an upper bound on it: they were not all at their worst in the same frame.'
                                )}>
                                {nls.localize('vueport/debug/panels/profiler/peak', 'Peak')}
                            </SortableHeader>
                            <SortableHeader column='total' sort={this.sort} onSort={sort}
                                title={nls.localize(
                                    'vueport/debug/panels/profiler/totalHint',
                                    'The share of that frame spent in this function and in everything it \
called. A function that only calls others has all of its time here and none in the frame column.'
                                )}>
                                {nls.localize('vueport/debug/panels/profiler/total', 'Total')}
                            </SortableHeader>
                            <SortableHeader column='calls' sort={this.sort} onSort={sort}>
                                {nls.localize('vueport/debug/panels/profiler/calls', 'Calls')}
                            </SortableHeader>
                            <SortableHeader column='cost' sort={this.sort} onSort={sort}
                                title={nls.localize(
                                    'vueport/debug/panels/profiler/costHint',
                                    'Microseconds of the machine\'s own time per call, in that frame. \
What a single call costs, however often it happens to be made.'
                                )}>
                                {nls.localize('vueport/debug/panels/profiler/cost', 'µs/call')}
                            </SortableHeader>
                            <th className='vp-profiler-share'>
                                {nls.localize('vueport/debug/panels/profiler/share', 'Share')}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map(group => group.leaf
                            ? this.renderRow(group.leaf, snapshot, false)
                            : <React.Fragment key={group.id}>
                                {this.renderSection(group, snapshot)}
                                {this.isOpen(group.id)
                                    && group.rows.map(row => this.renderRow(row, snapshot, true))}
                            </React.Fragment>)}
                    </tbody>
                </table>
                {groups.length === 0 && quiet === 0 && <div className='hint'>
                    {nls.localize(
                        'vueport/debug/panels/profiler/noneMatch', 'No function matches the filter.')}
                </div>}
                {quiet > 0 && <button type='button' className='vp-profiler-more'
                    onClick={() => { this.showQuiet = !this.showQuiet; this.update(); }}>
                    {this.showQuiet
                        ? nls.localize('vueport/debug/panels/profiler/hideQuiet', 'Hide {0} below a tenth of a percent', count(quiet))
                        : nls.localize('vueport/debug/panels/profiler/showQuiet', 'Show {0} below a tenth of a percent', count(quiet))}
                </button>}
            </div>
            {filtered && <div className='hint vp-profiler-filtered'>
                {nls.localize(
                    'vueport/debug/panels/profiler/filteredSections',
                    'Section figures are the whole section, filter or no filter.'
                )}
            </div>}
        </div>;
    }

    protected renderSection(
        group: ProfilerGroup, snapshot: LiveProfileSnapshot
    ): React.ReactNode {
        const open = this.isOpen(group.id);
        return <tr className='vp-profiler-section'>
            <td className='vp-profiler-name'>
                <button
                    type='button'
                    className='vp-profiler-toggle'
                    aria-expanded={open}
                    onClick={() => this.toggleSection(group.id)}
                    title={nls.localize(
                        'vueport/debug/panels/profiler/sectionFunctions',
                        '{0} functions of this section ran', count(group.functions)
                    )}
                >
                    {open
                        ? <CaretDown size={11} weight='fill' />
                        : <CaretRight size={11} weight='fill' />}
                    <span>{group.name}</span>
                </button>
            </td>
            <td className='vp-profiler-number'>
                {percent(group.self, snapshot.frameClocks)}%
            </td>
            <td className='vp-profiler-number'>
                {percent(group.selfAvg, snapshot.frameClocks)}%
            </td>
            <td className='vp-profiler-number'>
                {percent(group.selfPeak, snapshot.frameClocks)}%
            </td>
            {/* no inclusive time for a section: it counts calls into other sections and would add up to more than the frame */}
            <td className='vp-profiler-number' />
            <td className='vp-profiler-number'>{count(group.calls)}</td>
            <td className='vp-profiler-number' />
            <td className='vp-profiler-share'>
                {bar(this.weight(group), snapshot.frameClocks)}
            </td>
        </tr>;
    }

    protected renderRow(
        row: ProfilerRow, snapshot: LiveProfileSnapshot, nested: boolean
    ): React.ReactNode {
        return <tr key={row.address} className={row.root ? 'hint' : undefined}>
            <td className={`vp-profiler-name${nested ? ' vp-profiler-nested' : ''}`}
                title={row.root ? nls.localize(
                    'vueport/debug/panels/profiler/rootHint',
                    'Everything that was already running when profiling started. Those calls \
happened before anything was watching, so there is no name for them — the game\'s own main loop is \
one of them.'
                ) : `0x${hex(row.address, 8)}`}>
                {row.root ? row.name : <code>{row.name}</code>}
            </td>
            <td className='vp-profiler-number'>
                {percent(row.self, snapshot.frameClocks)}%
            </td>
            <td className='vp-profiler-number'>
                {percent(row.selfAvg, snapshot.frameClocks)}%
            </td>
            <td className='vp-profiler-number'>
                {percent(row.selfPeak, snapshot.frameClocks)}%
            </td>
            <td className='vp-profiler-number'>
                {row.root ? '' : `${percent(row.total, snapshot.frameClocks)}%`}
            </td>
            <td className='vp-profiler-number'>{row.root ? '' : count(row.calls)}</td>
            <td className='vp-profiler-number'>
                {row.calls > 0 ? micros(row.self / row.calls) : ''}
            </td>
            <td className='vp-profiler-share'>
                {bar(this.weight(row), snapshot.frameClocks)}
            </td>
        </tr>;
    }

    protected renderBaseline(
        snapshot: LiveProfileSnapshot, rows: ProfilerRow[]
    ): React.ReactNode {
        const baseline = this.baseline;
        return <div className='vp-profiler-baseline'>
            <button
                type='button'
                className='vp-button secondary'
                onClick={() => { this.baseline = this.takeBaseline(snapshot, rows); this.update(); }}
                title={nls.localize(
                    'vueport/debug/panels/profiler/baselineHint',
                    'Remember what the window averages are now, and show what has moved since.'
                )}
            >
                {baseline
                    ? nls.localize('vueport/debug/panels/profiler/baselineReplace', 'Take a new baseline')
                    : nls.localize('vueport/debug/panels/profiler/baselineSave', 'Save as baseline')}
            </button>
            {baseline && <span className='hint vp-profiler-movers'>
                {this.renderMovers(snapshot, rows, baseline)}
            </span>}
            {baseline && <button
                type='button'
                className='vp-profiler-baseline-clear'
                aria-label={nls.localize(
                    'vueport/debug/panels/profiler/baselineClear', 'Forget the baseline')}
                onClick={() => { this.baseline = undefined; this.update(); }}
            ><X size={11} /></button>}
        </div>;
    }

    protected renderMovers(
        snapshot: LiveProfileSnapshot, rows: ProfilerRow[], baseline: ProfilerBaseline
    ): React.ReactNode {
        const now = this.shares(snapshot, rows);
        const moved: { id: string; name: string; delta: number }[] = [];
        // a section that stopped running is the biggest improvement there is and is no longer in the table
        for (const id of new Set([...now.keys(), ...baseline.shares.keys()])) {
            const delta = (now.get(id)?.share ?? 0) - (baseline.shares.get(id) ?? 0);
            if (Math.abs(delta) >= BASELINE_THRESHOLD) {
                moved.push({
                    id,
                    name: now.get(id)?.name ?? baseline.names.get(id) ?? id,
                    delta,
                });
            }
        }
        moved.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));

        const busyNow = share(snapshot.clocksAvg - snapshot.haltedAvg, snapshot.frameClocks);
        const busyDelta = busyNow - baseline.busy;
        return <>
            {nls.localize(
                'vueport/debug/panels/profiler/baselineBusy',
                'vs baseline: busy {0}', points(busyDelta)
            )}
            {moved.slice(0, BASELINE_MOVERS).map(entry => <span key={entry.id}>
                {' · '}
                <span className={entry.delta > 0 ? 'vp-profiler-worse' : 'vp-profiler-better'}>
                    {`${entry.name} ${points(entry.delta)}`}
                </span>
            </span>)}
            {moved.length === 0 && ` · ${nls.localize(
                'vueport/debug/panels/profiler/baselineSteady',
                'no section has moved by a tenth of a point'
            )}`}
        </>;
    }

    protected takeBaseline(
        snapshot: LiveProfileSnapshot, rows: ProfilerRow[]
    ): ProfilerBaseline {
        const sections = this.shares(snapshot, rows);
        return {
            shares: new Map([...sections].map(([id, section]) => [id, section.share])),
            names: new Map([...sections].map(([id, section]) => [id, section.name])),
            busy: share(snapshot.clocksAvg - snapshot.haltedAvg, snapshot.frameClocks),
        };
    }

    // from the whole profile, not the table, or a filter typed at the time would make other sections seem to appear out
    // of nowhere
    protected shares(
        snapshot: LiveProfileSnapshot, rows: ProfilerRow[]
    ): Map<string, { name: string; share: number }> {
        const sections = new Map<string, { name: string; share: number }>();
        for (const row of rows) {
            const id = row.root ? ROOT_GROUP : row.section;
            let section = sections.get(id);
            if (!section) {
                section = { name: row.root ? row.name : row.section, share: 0 };
                sections.set(id, section);
            }
            section.share += share(row.selfAvg, snapshot.frameClocks);
        }
        return sections;
    }

    protected isOpen(id: string): boolean {
        // a filter opens whatever it found, a match hidden in a collapsed section would read as no match
        return this.functionFilter.trim() !== ''
            || (this.sectionOpen.get(id) ?? id === this.autoOpen);
    }

    protected toggleSection(id: string): void {
        this.sectionOpen.set(id, !this.isOpen(id));
        this.update();
    }

    protected weight(row: { self: number; selfAvg: number }): number {
        return this.pinned ? row.self : row.selfAvg;
    }

    // section figures ignore the filter, or totals would change with every keystroke
    protected groups(snapshot: LiveProfileSnapshot, rows: ProfilerRow[]): {
        groups: ProfilerGroup[]; quiet: number; filtered: boolean;
    } {
        const needle = this.functionFilter.trim().toLowerCase();
        const limit = snapshot.frameClocks * QUIET_SHARE;
        const groups = new Map<string, ProfilerGroup>();
        let quiet = 0;

        for (const row of rows) {
            const id = row.root ? ROOT_GROUP : row.section;
            let group = groups.get(id);
            if (!group) {
                group = {
                    id, name: row.root ? row.name : row.section,
                    self: 0, selfAvg: 0, selfPeak: 0, calls: 0, functions: 0, rows: [],
                };
                groups.set(id, group);
            }
            group.self += row.self;
            group.selfAvg += row.selfAvg;
            // sum of each function's worst frame, an upper bound (labeled as such in the hint)
            group.selfPeak += row.selfPeak;
            group.calls += row.calls;
            group.functions++;
            const matches = needle === ''
                || row.name.toLowerCase().includes(needle)
                || row.section.toLowerCase().includes(needle);
            const audible = this.showQuiet || this.weight(row) >= limit;
            if (!matches || !audible) {
                if (matches) {
                    quiet++;
                }
                if (row.root) {
                    group.hidden = true;
                }
                continue;
            }
            if (row.root) {
                group.leaf = row;
                continue;
            }
            group.rows.push(row);
        }

        let listed = [...groups.values()].filter(group => !group.hidden);
        if (needle !== '') {
            listed = listed.filter(group => group.rows.length > 0 || group.leaf);
        }
        this.rememberAutoOpen(listed);

        const sorted = sortTableRows(listed, this.sort, (group, column) => {
            switch (column) {
                case 'name': return group.name;
                case 'self': return group.self;
                case 'avg': return group.selfAvg;
                case 'peak': return group.selfPeak;
                case 'calls': return group.calls;
                default: return this.weight(group);
            }
        });
        for (const group of sorted) {
            group.rows = sortTableRows(group.rows, this.sort, (row, column) => {
                switch (column) {
                    case 'name': return row.name;
                    case 'self': return row.self;
                    case 'avg': return row.selfAvg;
                    case 'peak': return row.selfPeak;
                    case 'total': return row.total;
                    case 'calls': return row.calls;
                    case 'cost': return row.calls > 0 ? row.self / row.calls : undefined;
                }
            });
        }
        return { groups: sorted, quiet, filtered: needle !== '' };
    }

    protected rememberAutoOpen(groups: ProfilerGroup[]): void {
        if (this.autoOpen !== undefined) {
            return;
        }
        let busiest: ProfilerGroup | undefined;
        for (const group of groups) {
            if (!group.leaf && (!busiest || group.selfAvg > busiest.selfAvg)) {
                busiest = group;
            }
        }
        this.autoOpen = busiest?.id;
    }

    protected rows(snapshot: LiveProfileSnapshot): ProfilerRow[] {
        const other = nls.localize('vueport/debug/panels/profiler/other', 'Other');
        const pinned = this.pinned;
        if (!pinned) {
            return snapshot.functions.map(entry => ({
                ...entry, ...this.describe(entry.address, other),
            }));
        }
        const window = new Map(snapshot.functions.map(entry => [entry.address, entry]));
        return pinned.functions.map(entry => {
            const seen = window.get(entry.address);
            return {
                address: entry.address,
                self: entry.self,
                total: entry.total,
                calls: entry.calls,
                selfAvg: seen?.selfAvg ?? 0,
                selfPeak: seen?.selfPeak ?? 0,
                totalAvg: seen?.totalAvg ?? 0,
                totalPeak: seen?.totalPeak ?? 0,
                totalMin: seen?.totalMin ?? 0,
                callsAvg: seen?.callsAvg ?? 0,
                frames: seen?.frames ?? 0,
                ...this.describe(entry.address, other),
            };
        });
    }

    // besides functions there are the frames open before profiling began, and interrupt handlers the hardware enters
    // without a call
    protected describe(
        address: number, other: string
    ): { name: string; section: string; root: boolean } {
        if (address === VES_LIVE_PROFILE_ROOT) {
            return {
                name: nls.localize('vueport/debug/panels/profiler/alreadyRunning', 'Already running'),
                section: nls.localize('vueport/debug/panels/profiler/unattributed', 'Unattributed'),
                root: true,
            };
        }
        const level = interruptLevelOf(address);
        if (level !== undefined) {
            return {
                name: nls.localize(
                    'vueport/debug/panels/profiler/interrupt', 'Interrupt: {0}', VbInterrupt[level]
                ),
                section: nls.localize('vueport/debug/panels/profiler/interrupts', 'Interrupts'),
                root: false,
            };
        }
        const symbol = this.symbols
            && findFunctionAt(this.symbols, address, this.source.romSize * BYTES_PER_MBIT);
        if (!symbol || !this.symbols) {
            return { name: `0x${hex(address, 8)}`, section: other, root: false };
        }
        const name = functionDisplayName(this.symbols, symbol.name);
        const split = name.indexOf('::');
        return {
            name,
            section: split > 0 ? name.slice(0, split) : other,
            root: false,
        };
    }
}

function interruptLevelOf(address: number): VbInterrupt | undefined {
    const offset = address - VB_INTERRUPT_VECTOR_BASE;
    if (offset < 0 || offset > VbInterrupt.VPU * 0x10 || (offset & 0x0f) !== 0) {
        return undefined;
    }
    return offset >> 4;
}

function share(part: number, whole: number): number {
    return whole > 0 ? (100 * part) / whole : 0;
}

function percent(part: number, whole: number): string {
    return share(part, whole).toFixed(1);
}

function points(delta: number): string {
    return `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta).toFixed(1)}pp`;
}

function micros(clocks: number): string {
    const value = (clocks * 1e6) / VB_CLOCK_RATE;
    return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} µs`;
}

function duration(clocks: number): string {
    return (clocks * 1e6) / VB_CLOCK_RATE >= 1000 ? millis(clocks) : micros(clocks);
}

function millis(clocks: number): string {
    return `${((clocks * 1000) / VB_CLOCK_RATE).toFixed(1)} ms`;
}

function count(value: number): string {
    return value.toLocaleString('en-US');
}

function bar(part: number, whole: number): React.ReactNode {
    return <div className='vp-profiler-bar'>
        <div style={{ width: `${Math.min(100, share(part, whole))}%` }} />
    </div>;
}
