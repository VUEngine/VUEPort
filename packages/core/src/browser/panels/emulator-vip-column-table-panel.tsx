import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import { Plug, Warning } from '@phosphor-icons/react';
import { hex, DebugSource, Panel, EmulatorPanelType } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES, VipRegister } from './emulator-vip-memory';
import { VB_COLUMN_GROUPS, VB_COLUMN_TABLE, columnEdges } from '../../common/vb-column-geometry';
import EmptyContainer from '../components/kit/EmptyContainer';
import RadioSelect from '../components/kit/RadioSelect';
import Switch from '../components/kit/Switch';

// each eye's 256 entries, as halfwords: Repeat in the high byte, Column Length in the low
const TABLE_BASE = [0x0003DC00, 0x0003DE00];
const ENTRIES = 256;
const TABLE_BYTES = ENTRIES * 2 * 2;

// time each eye has before its display is cut off, in seconds, from the core's measured timing (vip.c): the left
// image runs from 1.81 ms until the right one begins at 12.92 ms, the right one until the next frame at 20 ms
const EYE_BUDGET = [(12.92 - 1.81) * 1e-3, (20 - 12.92) * 1e-3];
const UNIT = 200e-9;

// entries per row of raw values: eight halfwords fit a docked panel's width
const GRID_COLUMNS = 8;

type Eye = 0 | 1;
type Field = 'length' | 'repeat';

// top of the chart per field: lengths use the whole byte, repeats beyond 15 only saturate
const FIELD_MAX: Record<Field, number> = { length: 255, repeat: 15 };

/**
 * The column table: how long the display unit lights each group of 4 columns, and how often it pulses them. Edits go
 * straight into VIP memory, so a game that loads its table once keeps them and one writing it every frame does not.
 * Which 96 of the 256 entries an eye uses is up to the servo; CTA says where they start, and the display reads
 * downwards from there, the first entry for the leftmost 4 columns (see vb-column-geometry.ts for positions).
 */
export class ColumnTablePanel extends Panel {

    protected tables?: Uint16Array[];
    protected start: [number, number] = [0, 0];
    protected error?: string;

    protected eye: Eye = this.remembered('eye', 0) === 1 ? 1 : 0;
    protected field: Field = this.remembered('field', 'length') === 'repeat' ? 'repeat' : 'length';
    protected bothEyes = this.remembered('bothEyes', true);

    // values written but maybe not read back yet, so a poll in between does not snap them away
    protected pending = new Map<number, number>();
    protected drawing?: { last: number };
    protected editing?: number;

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.VIP_COLUMN_TABLE, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/columnTable/title', 'Column Table');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.VIP_COLUMN_TABLE);
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.tables = undefined;
            this.update();
            return;
        }
        // nothing to read while a stroke is drawn: the screen is ahead of memory until the stroke ends
        if (this.drawing) {
            return;
        }
        try {
            const [table, registers] = await Promise.all([
                sim.readMemory(TABLE_BASE[0], TABLE_BYTES),
                sim.readMemory(VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES),
            ]);
            const words = new Uint16Array(table.slice(0));
            this.tables = [words.slice(0, ENTRIES), words.slice(ENTRIES)];
            const cta = new DataView(registers).getUint16(VipRegister.CTA, true);
            this.start = [cta & 0xFF, cta >> 8];
            this.pending.clear();
            this.error = undefined;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }
        this.update();
    }

    // what was last written to it, or what was read
    protected entry(eye: Eye, index: number): number {
        return this.pending.get(eye * ENTRIES + index) ?? this.tables![eye][index];
    }

    protected fieldOf(word: number, field: Field): number {
        return field === 'length' ? word & 0xFF : word >> 8;
    }

    protected withField(word: number, field: Field, value: number): number {
        return field === 'length' ? (word & 0xFF00) | value : (word & 0x00FF) | (value << 8);
    }

    protected targets(): Eye[] {
        return this.bothEyes ? [0, 1] : [this.eye];
    }

    protected write(eyes: Eye[], words: Map<number, number>): void {
        if (words.size === 0) {
            return;
        }
        const indexes = [...words.keys()].sort((a, b) => a - b);
        for (const eye of eyes) {
            for (const index of indexes) {
                this.pending.set(eye * ENTRIES + index, words.get(index)!);
            }
            let from = 0;
            while (from < indexes.length) {
                let to = from;
                while (to + 1 < indexes.length && indexes[to + 1] === indexes[to] + 1) {
                    to++;
                }
                const bytes: number[] = [];
                for (let i = from; i <= to; i++) {
                    const word = words.get(indexes[i])!;
                    bytes.push(word & 0xFF, word >> 8);
                }
                this.source.write(TABLE_BASE[eye] + indexes[from] * 2, bytes).catch(() => undefined);
                from = to + 1;
            }
        }
        this.update();
    }

    // keeps the other byte of each eye's own word
    protected setField(values: Map<number, number>): void {
        for (const eye of this.targets()) {
            const words = new Map<number, number>();
            values.forEach((value, index) => words.set(index, this.withField(this.entry(eye, index), this.field, value)));
            this.write([eye], words);
        }
    }

    protected restoreDefaults(): void {
        const words = new Map<number, number>();
        VB_COLUMN_TABLE.forEach((length, index) => words.set(index, length));
        this.write(this.targets(), words);
    }

    protected copyToOtherEye(): void {
        const other: Eye = this.eye === 0 ? 1 : 0;
        const words = new Map<number, number>();
        for (let index = 0; index < ENTRIES; index++) {
            words.set(index, this.entry(this.eye, index));
        }
        this.write([other], words);
    }

    protected chartPoint(event: React.PointerEvent<SVGSVGElement>): { index: number; value: number } {
        const box = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width;
        const y = (event.clientY - box.top) / box.height;
        const max = FIELD_MAX[this.field];
        return {
            index: Math.max(0, Math.min(ENTRIES - 1, Math.floor(x * ENTRIES))),
            value: Math.max(0, Math.min(max, Math.round((1 - y) * max))),
        };
    }

    protected strokeTo(index: number, value: number): void {
        const last = this.drawing?.last ?? index;
        const lastValue = this.fieldOf(this.entry(this.eye, last), this.field);
        const values = new Map<number, number>();
        const span = Math.abs(index - last);
        for (let step = 0; step <= span; step++) {
            const at = last + Math.sign(index - last) * step;
            values.set(at, span === 0 ? value : Math.round(lastValue + (value - lastValue) * step / span));
        }
        this.setField(values);
        this.drawing = { last: index };
    }

    protected renderChart(): React.ReactNode {
        const max = FIELD_MAX[this.field];
        const start = this.start[this.eye];
        const windowLeft = start - (VB_COLUMN_GROUPS - 1);
        const bars: React.ReactNode[] = [];
        for (let index = 0; index < ENTRIES; index++) {
            const value = Math.min(max, this.fieldOf(this.entry(this.eye, index), this.field));
            const used = index <= start && index >= windowLeft
                || windowLeft < 0 && index >= windowLeft + ENTRIES;
            bars.push(<rect
                key={index}
                x={index}
                y={max - value}
                width={1}
                height={value}
                className={[used ? 'used' : '', index === this.editing ? 'editing' : ''].filter(Boolean).join(' ') || undefined}
            />);
        }
        const shade = windowLeft >= 0
            ? [<rect key='w' className='vp-column-window' x={windowLeft} y={0} width={VB_COLUMN_GROUPS} height={max} />]
            : [
                <rect key='w0' className='vp-column-window' x={0} y={0} width={start + 1} height={max} />,
                <rect key='w1' className='vp-column-window' x={windowLeft + ENTRIES} y={0} width={-windowLeft} height={max} />,
            ];
        return <svg
            className='vp-column-chart'
            viewBox={`0 0 ${ENTRIES} ${max}`}
            preserveAspectRatio='none'
            onPointerDown={event => {
                event.currentTarget.setPointerCapture(event.pointerId);
                const { index, value } = this.chartPoint(event);
                this.drawing = undefined;
                this.strokeTo(index, value);
            }}
            onPointerMove={event => {
                if (this.drawing) {
                    const { index, value } = this.chartPoint(event);
                    this.strokeTo(index, value);
                }
            }}
            onPointerUp={() => { this.drawing = undefined; }}
            onPointerCancel={() => { this.drawing = undefined; }}
        >
            {shade}
            {this.editing !== undefined
                && <rect className='vp-column-editing' x={this.editing} y={0} width={1} height={max} />}
            <g className='vp-column-bars'>{bars}</g>
        </svg>;
    }

    // leftmost group first
    protected windowLengths(eye: Eye): number[] {
        return Array.from({ length: VB_COLUMN_GROUPS },
            (_, group) => this.entry(eye, (this.start[eye] - group) & 0xFF) & 0xFF);
    }

    // where each group of 4 columns begins on the screen's 384 pixels, as the mirror puts it: Nintendo's table spaces
    // them evenly, a longer entry leaves a wider gap, a shorter one a narrower
    protected renderPositions(): React.ReactNode {
        const edges = columnEdges(this.windowLengths(this.eye), this.eye);
        const lines: React.ReactNode[] = [];
        for (let group = 0; group <= VB_COLUMN_GROUPS; group++) {
            const x = edges[group * 4];
            if (x >= -1 && x <= 385) {
                lines.push(<line
                    key={group}
                    x1={x}
                    x2={x}
                    y1={group % 8 === 0 ? 0 : 8}
                    y2={24}
                    className={group % 8 === 0 ? 'major' : undefined}
                />);
            }
        }
        return <svg className='vp-column-positions' viewBox='-8 0 400 24' preserveAspectRatio='none'>
            <rect className='vp-column-screen' x={0} y={0} width={384} height={24} />
            {lines}
        </svg>;
    }

    protected renderGrid(): React.ReactNode {
        const start = this.start[this.eye];
        const used = (index: number): boolean => ((start - index) & 0xFF) < VB_COLUMN_GROUPS;
        const rows: React.ReactNode[] = [];
        for (let row = 0; row < ENTRIES / GRID_COLUMNS; row++) {
            const cells: React.ReactNode[] = [];
            for (let column = 0; column < GRID_COLUMNS; column++) {
                const index = row * GRID_COLUMNS + column;
                const word = this.entry(this.eye, index);
                cells.push(<td
                    key={column}
                    className={used(index) ? 'used' : undefined}
                >
                    <WordCell
                        value={word}
                        onCommit={value => this.write(this.targets(), new Map([[index, value]]))}
                        step={(value, delta) => this.withField(value, this.field,
                            Math.max(0, Math.min(FIELD_MAX[this.field], this.fieldOf(value, this.field) + delta)))}
                        onEditing={editing => {
                            this.editing = editing ? index : undefined;
                            this.update();
                        }}
                        title={nls.localize('vueport/debug/panels/columnTable/entryTitle',
                            'Entry {0}: Repeat {1}, Column Length {2}', hex(index, 2), word >> 8, word & 0xFF)}
                    />
                </td>);
            }
            rows.push(<tr key={row}><th>{hex(row * GRID_COLUMNS, 2)}</th>{cells}</tr>);
        }
        return <table className='vp-column-grid'>
            <thead>
                <tr><th />{Array.from({ length: GRID_COLUMNS }, (_, column) => <th key={column}>{hex(column, 1)}</th>)}</tr>
            </thead>
            <tbody>{rows}</tbody>
        </table>;
    }

    protected renderSummary(eye: Eye): React.ReactNode {
        const lengths = this.windowLengths(eye);
        const time = lengths.reduce((sum, length) => sum + (length + 1) * 4 * UNIT, 0);
        const reference = Array.from({ length: VB_COLUMN_GROUPS },
            (_, group) => VB_COLUMN_TABLE[(this.start[eye] - group) & 0xFF])
            .reduce((sum, length) => sum + (length + 1) * 4 * UNIT, 0);
        let cutAt: number | undefined;
        let elapsed = 0;
        for (let group = 0; group < VB_COLUMN_GROUPS && cutAt === undefined; group++) {
            elapsed += (lengths[group] + 1) * 4 * UNIT;
            if (elapsed > EYE_BUDGET[eye]) {
                cutAt = group;
            }
        }
        // separate, as the nls extractor does not look inside another call's arguments
        const eyeName = eye === 0
            ? nls.localize('vueport/debug/panels/columnTable/leftEye', 'left')
            : nls.localize('vueport/debug/panels/columnTable/rightEye', 'right');
        return <>
            <label>
                {nls.localize('vueport/debug/panels/columnTable/start', 'Start (CTA)')}
                <span className='hint'>{hex(this.start[eye], 2)}</span>
            </label>
            <label>
                {nls.localize('vueport/debug/panels/columnTable/displayTime', 'Display time')}
                <span className='hint'>
                    {(time * 1000).toFixed(2)} ms
                    {Math.abs(time - reference) > 1e-7 && ` (${time > reference ? '+' : ''}${((time - reference) * 1000).toFixed(2)})`}
                </span>
            </label>
            {cutAt !== undefined && <label className='vp-column-warning'>
                <Warning size={14} />
                {nls.localize('vueport/debug/panels/columnTable/cutOff',
                    'Cut off from group {0}: the {1} eye has {2} ms.',
                    hex(cutAt, 2),
                    eyeName,
                    (EYE_BUDGET[eye] * 1000).toFixed(2))}
            </label>}
        </>;
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return <EmptyContainer title={this.error} icon={<Warning size={32} />} />;
        }
        if (!this.tables) {
            return <EmptyContainer
                title={nls.localize('vueport/general/notRunning', 'The emulator is not running.')}
                icon={<Plug size={32} />}
            />;
        }
        return <div className='vp-inspector vp-column-table'>
            <div className='vp-inspector-sidebar vp-scroll'>
                <div className='vp-inspector-field'>
                    <label>{nls.localize('vueport/debug/panels/columnTable/eye', 'Eye')}</label>
                    <RadioSelect
                        options={[
                            { value: 0, label: nls.localize('vueport/debug/panels/frameBuffers/left', 'Left') },
                            { value: 1, label: nls.localize('vueport/debug/panels/frameBuffers/right', 'Right') },
                        ]}
                        defaultValue={this.eye}
                        onChange={options => {
                            this.eye = this.remember('eye', options[0].value as number) === 1 ? 1 : 0;
                            this.update();
                        }}
                        fitSpace
                    />
                </div>
                <div className='vp-inspector-field'>
                    <label>{nls.localize('vueport/debug/panels/columnTable/chart', 'Chart')}</label>
                    <RadioSelect
                        options={[
                            { value: 'length', label: nls.localize('vueport/debug/panels/columnTable/length', 'Length') },
                            { value: 'repeat', label: nls.localize('vueport/debug/panels/columnTable/repeat', 'Repeat') },
                        ]}
                        defaultValue={this.field}
                        onChange={options => {
                            this.field = this.remember('field', options[0].value as string) === 'repeat' ? 'repeat' : 'length';
                            this.update();
                        }}
                        fitSpace
                    />
                </div>
                <fieldset className='vp-inspector-group'>
                    <legend>{nls.localize('vueport/debug/panels/columnTable/editing', 'Editing')}</legend>
                    <span className='vp-toggle'>
                        <Switch
                            label={nls.localize('vueport/debug/panels/columnTable/bothEyes', 'Both eyes at once')}
                            value={this.bothEyes}
                            onChange={value => {
                                this.bothEyes = this.remember('bothEyes', value);
                                this.update();
                            }}
                        />
                        <span>{nls.localize('vueport/debug/panels/columnTable/bothEyes', 'Both eyes at once')}</span>
                    </span>
                    <button type='button' className='vp-button secondary' onClick={() => this.restoreDefaults()}>
                        {nls.localize('vueport/debug/panels/columnTable/defaultValues', 'Default Values')}
                    </button>
                    <button type='button' className='vp-button secondary' onClick={() => this.copyToOtherEye()}>
                        {this.eye === 0
                            ? nls.localize('vueport/debug/panels/columnTable/copyToRight', 'Copy to Right Eye')
                            : nls.localize('vueport/debug/panels/columnTable/copyToLeft', 'Copy to Left Eye')}
                    </button>
                </fieldset>
                <fieldset className='vp-inspector-group'>
                    <legend>{this.eye === 0
                        ? nls.localize('vueport/debug/panels/columnTable/leftDisplay', 'Left display')
                        : nls.localize('vueport/debug/panels/columnTable/rightDisplay', 'Right display')}</legend>
                    {this.renderSummary(this.eye)}
                </fieldset>
            </div>
            <div className='vp-inspector-main vp-scroll'>
                <div className='vp-column-caption'>
                    {this.field === 'length'
                        ? nls.localize('vueport/debug/panels/columnTable/lengthCaption',
                            'Light emission durations, effective portion highlighted. Draw to change.')
                        : nls.localize('vueport/debug/panels/columnTable/repeatCaption',
                            'Brightness repeat values, effective portion highlighted. Draw to change')}
                </div>
                {this.renderChart()}
                {this.renderPositions()}
                {this.renderGrid()}
            </div>
        </div>;
    }
}

// one halfword, typed as four hex digits and written on blur or Enter, or stepped with the arrow keys, which write
// at once. Holds what is typed while focused, so a poll does not overwrite it halfway
function WordCell(props: {
    value: number,
    title: string,
    onCommit: (value: number) => void,
    onEditing: (editing: boolean) => void,
    step: (value: number, delta: number) => number,
}): React.JSX.Element {
    const [text, setText] = React.useState<string | undefined>(undefined);
    // Escape leaves without writing; the blur it causes must not write either
    const cancelled = React.useRef(false);
    const commit = (): void => {
        if (text !== undefined && !cancelled.current) {
            const value = parseInt(text, 16);
            if (/^[0-9a-f]{1,4}$/i.test(text) && value !== props.value) {
                props.onCommit(value);
            }
        }
        setText(undefined);
    };
    return <input
        className='vp-column-word'
        value={text ?? hex(props.value, 4)}
        title={props.title}
        spellCheck={false}
        maxLength={4}
        onFocus={event => {
            cancelled.current = false;
            setText(hex(props.value, 4));
            event.target.select();
            props.onEditing(true);
        }}
        onChange={event => setText(event.target.value)}
        onBlur={() => {
            commit();
            props.onEditing(false);
        }}
        onKeyDown={event => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                // stopped too, or the emulator around the panel reads it as the D-pad
                event.preventDefault();
                event.stopPropagation();
                // from what is typed, if it is a value, so a step does not throw it away
                const base = text !== undefined && /^[0-9a-f]{1,4}$/i.test(text) ? parseInt(text, 16) : props.value;
                const value = props.step(base, event.key === 'ArrowUp' ? 1 : -1);
                if (value !== props.value) {
                    props.onCommit(value);
                }
                setText(hex(value, 4));
            } else if (event.key === 'Enter') {
                commit();
                event.currentTarget.blur();
            } else if (event.key === 'Escape') {
                cancelled.current = true;
                setText(undefined);
                event.currentTarget.blur();
            }
        }}
    />;
}
