import { ArrowUUpLeft, Circle, Crosshair, Pause, Play, Plug, Warning } from '@phosphor-icons/react';
import * as React from 'react';
import { ScreenInspectorTarget } from './emulator-screen-inspector';
import { DisposableCollection } from '../../common/emulator-events';
import { nls } from '../../common/emulator-nls';
import { DisassemblyLine, StopReason } from '../../common/vb-protocol';
import EmptyContainer from '../components/kit/EmptyContainer';
import { annotateDisassembly, attachSourceLines, DisassemblyRow } from '../core/emulator-disassembly';
import { romOffsetOf, VesLineTable } from '../core/emulator-line-table';
import { functionDisplayName, SymbolIndex } from '../core/emulator-symbols';
import { Sim } from '../core/vb-core';
import { BYTES_PER_MBIT } from '../emulator-types';
import { DebugSource, EmulatorPanelType, hex, Panel } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';

const LINES = 48;

// how much of the window sits above the program counter while following
const LEAD = 8;

// the recorded paths are absolute and mostly the build's working directory
function shortPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts.slice(-2).join('/');
}

const MAX_HISTORY = 64;

// the honest proportion of 48 instructions in a cartridge of up to a megabyte rounds to nothing,
// so the thumb gets a floor to take hold of
const MIN_THUMB = 18;

// where the cartridge is mapped, which is where a build's addresses point
const CART_WINDOW_BASE = 0x07000000;

// handed in by the dock from its host, as the debug source reads the machine and deliberately cannot drive it
// (like the CPU Profiler's record button). Absent on hosts without control: the panel then only reads the program
export interface VesExecutionControl {
    isPaused(): boolean;
    setPaused(paused: boolean): void;
}

// breakpoints are checked on every instruction the core executes, so they are armed in the core only while this
// panel holds some, and given back when it is closed or hidden
export class DisassemblyPanel extends Panel {

    protected lines: DisassemblyLine[] = [];
    protected error?: string;
    protected follow = this.remembered('follow', true);
    // where the window starts while not following
    protected address = 0;
    protected pc?: number;

    protected breakpoints = new Set<number>();
    // the line Run to Cursor means, set by clicking one
    protected selected?: number;
    protected history: number[] = [];

    protected symbols?: SymbolIndex;
    protected lineTable?: VesLineTable;
    // split into lines, by the path the line table names. Null for one that could not be read, so the missing file is not
    // asked for on every refresh
    protected sources = new Map<string, string[] | null>();
    protected showSource = this.remembered('source', true);

    // held while the rail is dragged, as the offset within the thumb
    protected railGrab?: number;

    protected watched?: Sim;
    protected readonly watching = new DisposableCollection();
    protected scroller: HTMLElement | undefined;

    constructor(
        source: DebugSource,
        instanceId: string,
        protected readonly control?: VesExecutionControl,
    ) {
        super(EmulatorPanelType.DISASSEMBLY, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/disassembly/title', 'Disassembly');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.DISASSEMBLY);
        this.toDispose.push(this.watching);
    }

    protected pollHz(): number {
        return 4;
    }

    protected async refresh(): Promise<void> {
        this.followMachine();
        const sim = this.source.sim;
        if (!sim) {
            this.lines = [];
            this.pc = undefined;
            this.update();
            return;
        }

        this.symbols = await this.source.getSymbols();
        if (this.showSource && this.lineTable === undefined) {
            this.lineTable = await this.source.getLineTable();
        }

        try {
            const { pc } = await sim.readRegisters();
            this.pc = pc >>> 0;
            if (this.follow) {
                // started a few instructions above the program counter, so there is something to read on the way in
                this.lines = await sim.disassemble(this.pc, LINES, LEAD);
                this.address = this.lines[0]?.address ?? this.pc;
            } else {
                this.lines = await sim.disassemble(this.address, LINES);
            }
            this.error = undefined;
        } catch (error) {
            this.lines = [];
            this.error = error instanceof Error ? error.message : String(error);
        }
        this.update();
    }

    protected followMachine(): void {
        const sim = this.source.sim;
        if (sim === this.watched) {
            return;
        }
        this.watching.dispose();
        this.watched = sim;
        this.lineTable = undefined;
        this.sources.clear();
        this.breakpoints.clear();
        this.history = [];
        this.selected = undefined;
        if (!sim) {
            return;
        }
        // a breakpoint suspends the machine, and the first thing anybody wants is to see where it stopped
        this.watching.push(sim.onStopped(stop => {
            this.follow = this.remember('follow', true);
            this.pc = stop.address;
            // after a write, what is wanted is the store that made it; the machine stands on the instruction after
            this.selected = stop.write?.pc ?? stop.address;
            if (stop.reason !== StopReason.STEP) {
                this.update();
            }
            this.refresh().catch(() => undefined);
        }));
        this.watching.push({
            dispose: () => { sim.setBreakpoints([]).catch(() => undefined); },
        });
    }

    // through the shared set, with the source line where there is one, so it is the same breakpoint an editor shows and
    // survives a rebuild moving the code (VesBreakpoints.reresolve). Arming the machine is the dock's business
    protected toggleBreakpoint(row: DisassemblyRow): void {
        this.source.breakpoints.toggle(row.line.address, row.source);
        this.update();
    }

    protected get paused(): boolean {
        return this.control?.isPaused() ?? false;
    }

    protected async step(): Promise<void> {
        const sim = this.watched;
        if (!sim || !this.paused) {
            return;
        }
        await sim.stepInstruction();
        this.follow = this.remember('follow', true);
        await this.refresh();
    }

    // a call is stepped over by arming the instruction after it and running into it, anything else is an ordinary step
    protected async stepOver(): Promise<void> {
        const sim = this.watched;
        if (!sim || !this.paused || this.pc === undefined) {
            return;
        }
        const here = this.lines.find(line => line.address === this.pc);
        if (!here || !/^jal$/i.test(here.mnemonic)) {
            await this.step();
            return;
        }
        await this.runTo((here.address + here.code.length) >>> 0);
    }

    protected async runTo(address: number): Promise<void> {
        const sim = this.watched;
        if (!sim) {
            return;
        }
        await sim.runTo(address);
        this.control?.setPaused(false);
    }

    // worked out in emulator-disassembly, a pure function that can run over a real build without a browser
    // (see tests/disassembly-symbols-probe.mjs)
    protected rows(): DisassemblyRow[] {
        const romBytes = Math.max(0, this.source.romSize) * BYTES_PER_MBIT;
        const rows = annotateDisassembly(this.lines, this.symbols, romBytes);
        if (!this.showSource) {
            return rows;
        }
        attachSourceLines(rows, this.lineTable, romBytes);
        this.requestSources(rows);
        return rows;
    }

    // from the render, where it becomes known which files are needed, and asynchronously, so drawing never waits on a disk;
    // the line arrives on the next refresh, a tenth of a second later
    protected requestSources(rows: DisassemblyRow[]): void {
        for (const row of rows) {
            const file = row.source?.file;
            if (file === undefined || this.sources.has(file)) {
                continue;
            }
            // claimed before the read, so a file asked for twice in one frame is read once
            this.sources.set(file, null);
            this.source.readSource(file)
                .then(text => {
                    if (text !== undefined) {
                        this.sources.set(file, text.split(/\r?\n/));
                        this.update();
                    }
                })
                .catch(() => { /* an unreadable file stays null */ });
        }
    }

    // undefined while it is not to hand
    protected sourceText(file: string, line: number): string | undefined {
        const text = this.sources.get(file);
        return text ? text[line - 1]?.trim() : undefined;
    }

    protected pin(): void {
        if (this.follow) {
            this.follow = this.remember('follow', false);
        }
    }

    reveal(target: ScreenInspectorTarget): void {
        if (target.kind === 'code') {
            this.goTo(target.address);
        }
    }

    protected goTo(address: number, remember = true): void {
        if (remember && this.lines.length > 0) {
            this.history.push(this.address);
            if (this.history.length > MAX_HISTORY) {
                this.history.shift();
            }
        }
        this.pin();
        this.address = address >>> 0;
        this.selected = address >>> 0;
        this.refresh().catch(() => undefined);
    }

    // anything moving the window on purpose gives up following (see pin), so this is the way back to what is running
    protected goToProgramCounter(): void {
        this.follow = this.remember('follow', true);
        if (this.pc !== undefined) {
            this.selected = this.pc;
        }
        this.refresh().catch(() => undefined);
    }

    protected back(): void {
        const to = this.history.pop();
        if (to !== undefined) {
            this.pin();
            this.address = to;
            this.refresh().catch(() => undefined);
        }
    }

    protected scrollBy(instructions: number): void {
        if (instructions === 0 || this.lines.length === 0) {
            return;
        }
        this.pin();
        const sim = this.watched;
        if (!sim) {
            return;
        }
        if (instructions > 0) {
            const at = this.lines[Math.min(instructions, this.lines.length - 1)];
            this.address = at.address;
        } else {
            // backwards is the core's own walk; nothing in the bytes before an address says where the previous instruction began
            sim.disassemble(this.address, 1, -instructions)
                .then(lines => {
                    if (lines.length > 0) {
                        this.address = lines[0].address;
                        this.refresh().catch(() => undefined);
                    }
                })
                .catch(() => undefined);
            return;
        }
        this.refresh().catch(() => undefined);
    }

    // by ROM offset rather than address, as the same code is reachable through the cartridge window and the mirror the
    // machine boots from, and only the offset is the same in both
    protected shareOf(address: number): number {
        const romBytes = this.romBytes;
        return romBytes > 0 ? romOffsetOf(address, romBytes) / romBytes : 0;
    }

    protected get romBytes(): number {
        return Math.max(0, this.source.romSize) * BYTES_PER_MBIT;
    }

    protected railThumb(height: number): { top: number; size: number } {
        const size = Math.min(height, MIN_THUMB);
        const span = Math.max(0, height - size);
        return { top: this.shareOf(this.address) * span, size };
    }

    protected grabRail(event: React.PointerEvent<HTMLDivElement>): void {
        const box = event.currentTarget.getBoundingClientRect();
        const { top, size } = this.railThumb(box.height);
        const at = event.clientY - box.top;
        // grabbed by the thumb, it is dragged from where it was held; anywhere else it jumps there, held by its middle
        this.railGrab = at >= top && at < top + size ? at - top : size / 2;
        event.currentTarget.setPointerCapture(event.pointerId);
        this.scrubRail(box, event.clientY);
    }

    protected scrubRail(box: DOMRect, clientY: number): void {
        const romBytes = this.romBytes;
        if (this.railGrab === undefined || romBytes <= 0) {
            return;
        }
        const { size } = this.railThumb(box.height);
        const span = Math.max(1, box.height - size);
        const share = Math.min(1, Math.max(0, (clientY - box.top - this.railGrab) / span));
        // into the cartridge window, where a build's own addresses are and the machine runs; the mirror is only the vectors
        this.pin();
        this.address = (CART_WINDOW_BASE + Math.floor(share * romBytes)) >>> 0;
        this.refresh().catch(() => undefined);
    }

    protected releaseRail(event: React.PointerEvent<HTMLDivElement>): void {
        if (this.railGrab === undefined) {
            return;
        }
        this.railGrab = undefined;
        event.currentTarget.releasePointerCapture(event.pointerId);
        this.update();
    }

    protected goToText(text: string): void {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return;
        }
        const asHex = /^(0x)?([0-9a-fA-F]{1,8})$/.exec(trimmed);
        if (asHex) {
            this.goTo(Number.parseInt(asHex[2], 16) >>> 0);
            return;
        }
        const wanted = trimmed.toLowerCase();
        const found = this.symbols?.codeSymbols.find(symbol =>
            functionDisplayName(this.symbols!, symbol.name).toLowerCase() === wanted
            || symbol.name.toLowerCase() === wanted
            || symbol.name.replace(/^_/, '').toLowerCase() === wanted);
        if (found) {
            this.goTo(found.address);
        }
    }

    protected render(): React.ReactNode {
        if (!this.source.sim) {
            return <EmptyContainer
                title={nls.localize('vueport/general/notRunning', 'The emulator is not running.')}
                icon={<Plug size={32} />}
            />;
        }
        if (this.error) {
            return <div className='vp-disassembly'>
                {this.renderToolbar()}
                <EmptyContainer title={this.error} icon={<Warning size={32} />} />
            </div>;
        }

        return <div className='vp-disassembly'>
            {this.renderToolbar()}
            <div className='vp-disassembly-body'>
                <div
                    className='vp-disassembly-lines vp-scroll'
                    tabIndex={0}
                    ref={element => { this.scroller = element ?? undefined; }}
                    onWheel={event => {
                        event.preventDefault();
                        this.scrollBy(Math.sign(event.deltaY) * 3);
                    }}
                    onKeyDown={event => this.onKey(event)}
                >
                    {this.rows().map(row => this.renderRow(row))}
                </div>
                {this.renderRail()}
            </div>
        </div>;
    }

    // over the cartridge rather than the lines, as the listing is a window of 48 instructions: this says where in the
    // program the window sits, like the Memory panel's rail. Absent for a ROM whose size nothing reported
    protected renderRail(): React.ReactNode {
        if (this.romBytes <= 0) {
            return undefined;
        }
        const height = this.scroller?.clientHeight ?? 0;
        const { top, size } = this.railThumb(height || 1);
        return <div
            className={`vp-disassembly-rail${this.railGrab !== undefined ? ' dragging' : ''}`}
            role='scrollbar'
            aria-orientation='vertical'
            aria-label={nls.localize('vueport/debug/panels/disassembly/scrub', 'Position in the cartridge')}
            onPointerDown={event => this.grabRail(event)}
            onPointerMove={event => {
                if (this.railGrab !== undefined) {
                    this.scrubRail(event.currentTarget.getBoundingClientRect(), event.clientY);
                }
            }}
            onPointerUp={event => this.releaseRail(event)}
            onPointerCancel={event => this.releaseRail(event)}
        >
            {/* where the machine is, so the rail shows how far from it you have read */}
            {this.pc !== undefined && <div
                className='vp-disassembly-rail-pc'
                style={{ top: `${this.shareOf(this.pc) * 100}%` }}
                title={`0x${hex(this.pc, 8)}`}
            />}
            <div
                className='vp-disassembly-rail-thumb'
                style={{ top: `${top}px`, height: `${size}px` }}
            />
        </div>;
    }

    protected onKey(event: React.KeyboardEvent): void {
        if (event.key === 'Backspace' || (event.key === 'ArrowLeft' && event.altKey)) {
            event.preventDefault();
            this.back();
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.scrollBy(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.scrollBy(-1);
        }
    }

    protected renderToolbar(): React.ReactNode {
        const paused = this.paused;
        const stopped = this.control !== undefined && paused;
        return <div className='vp-panel-toolbar vp-disassembly-toolbar'>
            {this.control && <button
                className={`vp-button${paused ? '' : ' secondary'}`}
                onClick={() => this.control?.setPaused(!paused)}
            >
                {paused
                    ? <><Play size={13} weight='fill' />{nls.localize('vueport/debug/panels/disassembly/run', 'Run')}</>
                    : <><Pause size={13} weight='fill' />{nls.localize('vueport/debug/panels/disassembly/pause', 'Pause')}</>}
            </button>}
            <button
                className='vp-button secondary'
                disabled={!stopped}
                onClick={() => { this.step().catch(() => undefined); }}
            >
                {nls.localize('vueport/debug/panels/disassembly/step', 'Step')}
            </button>
            <button
                className='vp-button secondary'
                disabled={!stopped}
                onClick={() => { this.stepOver().catch(() => undefined); }}
            >
                {nls.localize('vueport/debug/panels/disassembly/over', 'Over')}
            </button>
            <button
                className='vp-button secondary'
                disabled={this.control === undefined || this.selected === undefined}
                onClick={() => {
                    if (this.selected !== undefined) {
                        this.runTo(this.selected).catch(() => undefined);
                    }
                }}
            >
                {nls.localize('vueport/debug/panels/disassembly/runToCursor', 'Run to cursor')}
            </button>
            <button
                className={`vp-button secondary vp-disassembly-here${this.follow ? ' active' : ''}`}
                disabled={this.pc === undefined}
                title={nls.localize('vueport/debug/panels/disassembly/toPc',
                    'Go to the program counter and follow it')}
                onClick={() => this.goToProgramCounter()}
            >
                <Crosshair size={14} />
            </button>
            <button
                className='vp-button secondary vp-disassembly-back'
                disabled={this.history.length === 0}
                title={nls.localize('vueport/debug/panels/disassembly/back', 'Back')}
                onClick={() => this.back()}
            >
                <ArrowUUpLeft size={14} />
            </button>
            <input
                className='vp-input vp-disassembly-goto'
                spellCheck={false}
                placeholder={nls.localize('vueport/debug/panels/disassembly/goTo', 'Go to symbol or address…')}
                onKeyDown={event => {
                    if (event.key === 'Enter') {
                        this.goToText((event.target as HTMLInputElement).value);
                    }
                }}
            />
            <label className='vp-disassembly-source-toggle'>
                <input
                    type='checkbox'
                    checked={this.showSource}
                    onChange={event => {
                        this.showSource = this.remember('source', event.target.checked);
                        this.refresh().catch(() => undefined);
                    }}
                />
                {nls.localize('vueport/debug/panels/disassembly/source', 'Source')}
            </label>
        </div>;
    }

    protected renderRow(row: DisassemblyRow): React.ReactNode {
        const { line } = row;
        const isPC = this.pc === line.address;
        const point = this.source.breakpoints.at(line.address);
        const armed = point !== undefined;
        const classes = ['vp-disassembly-line'];
        if (isPC) {
            classes.push('current');
        }
        if (this.selected === line.address) {
            classes.push('selected');
        }
        if (row.adrift) {
            classes.push('adrift');
        }

        const source = row.source;
        const text = source && this.sourceText(source.file, source.line);
        return <React.Fragment key={line.address}>
            {row.header && <div className='vp-disassembly-header'>
                <span className='name'>{row.header.name}</span>
                <span className='at'>{hex(row.header.address, 8)}</span>
                {row.header.size > 0 && <span className='size'>
                    {nls.localize('vueport/debug/panels/disassembly/bytes', '{0} bytes', row.header.size)}
                </span>}
            </div>}
            {/* the C this instruction came from, above the instructions it produced */}
            {source && <div className='vp-disassembly-source'>
                <span className='at'>{`${shortPath(source.file)}:${source.line}`}</span>
                {text !== undefined && <span className='text'>{text}</span>}
            </div>}
            <div
                className={classes.join(' ')}
                onClick={() => { this.selected = line.address; this.update(); }}
            >
                <button
                    type='button'
                    className={`vp-disassembly-gutter${armed ? ' armed' : ''}`
                        + (point && !point.enabled ? ' off' : '')}
                    aria-label={nls.localize('vueport/debug/panels/disassembly/breakpoint', 'Breakpoint')}
                    title={point?.origin
                        ? `${shortPath(point.origin.file)}:${point.origin.line}`
                        : undefined}
                    onClick={event => {
                        event.stopPropagation();
                        this.toggleBreakpoint(row);
                    }}
                >
                    {isPC
                        ? <Play size={16} weight='fill' />
                        : <Circle size={16} weight='fill' />
                    }
                </button>
                <span className='address'>{hex(line.address, 8)}</span>
                <span className='code'>{line.code.map(byte => hex(byte, 2)).join(' ')}</span>
                {row.adrift
                    ? <span className='mnemonic adrift-note'>
                        {nls.localize(
                            'vueport/debug/panels/disassembly/adrift',
                            'not an instruction — the core mis-sized the branch above'
                        )}
                    </span>
                    : <>
                        <span className='mnemonic'>{line.mnemonic}</span>
                        <span className='operands'>{this.renderOperands(row)}</span>
                    </>}
            </div>
        </React.Fragment>;
    }

    protected renderOperands(row: DisassemblyRow): React.ReactNode {
        return <>
            {row.line.operands.map((operand, index) => {
                const target = row.targets.get(index);
                return <React.Fragment key={index}>
                    {index > 0 && ', '}
                    {target
                        ? <button
                            type='button'
                            className='vp-disassembly-target'
                            title={`0x${hex(target.address, 8)}`}
                            onClick={event => {
                                event.stopPropagation();
                                this.goTo(target.address);
                            }}
                        >{target.label}</button>
                        : operand}
                </React.Fragment>;
            })}
            {row.loaded && <button
                type='button'
                className='vp-disassembly-loaded'
                title={`0x${hex(row.loaded.address, 8)}`}
                onClick={event => {
                    event.stopPropagation();
                    this.goTo(row.loaded!.address);
                }}
            >{`→ ${row.loaded.label}`}</button>}
        </>;
    }
}
