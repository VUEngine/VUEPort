import { CaretDown, CaretRight, EyeSlash, FileX, Plug, Warning } from '@phosphor-icons/react';
import { nls } from '../../common/emulator-nls';
import { Message } from '@lumino/messaging';
import * as React from 'react';
import EmptyContainer from '../components/kit/EmptyContainer';
import PanelFilter from '../components/kit/PanelFilter';
import { Sim } from '../core/vb-core';
import {
    actorLabel,
    actorPixelSource,
    componentPixelSource,
    readActors,
    VesActor,
    VesActorsRead,
    VesActorsStatus,
} from '../core/emulator-actors';
import { VesFieldValue } from '../core/emulator-dwarf';
import { structNameOf, SymbolIndex } from '../core/emulator-symbols';
import { VesScreenRect } from './emulator-screen-panel';
import { ScreenInspectorTarget } from './emulator-screen-inspector';
import { emulatorPanelLabel, EmulatorPanelType, hex, DebugSource, Panel } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import {
    nextTableSort, SortableHeader, sortTableRows, TableSort,
} from './emulator-sortable-table';

// the field the list follows inline, since the string behind it is the point of it
const NAME_FIELD = 'name';

// how much of a char* is read looking for its terminator
const NAME_BYTES = 32;

// names resolved per refresh. Each is a read of its own, as the strings are scattered wherever the linker put them;
// they are kept, since a name is set when its actor is built and does not change
const NAMES_PER_REFRESH = 12;

// childless siblings from one spec it takes for the tree to fold them into a row (a level's coins, a gun's bullets)
const GROUP_MIN = 3;

// how long a changed field keeps its mark, in ms; long enough to be seen at four reads a second
const CHANGED_MARK_MS = 1500;

enum ActorsStatus {
    OK = 'ok',
    NOT_RUNNING = 'notRunning',
    NO_SYMBOLS = 'noSymbols',
    NO_LAYOUTS = 'noLayouts',
    NOT_INITIALIZED = 'notInitialized',
    STALE_SYMBOLS = 'staleSymbols',
}

const STATUS_OF: Record<VesActorsStatus, ActorsStatus> = {
    [VesActorsStatus.OK]: ActorsStatus.OK,
    [VesActorsStatus.NO_SYMBOLS]: ActorsStatus.NO_SYMBOLS,
    [VesActorsStatus.NO_LAYOUTS]: ActorsStatus.NO_LAYOUTS,
    [VesActorsStatus.NOT_INITIALIZED]: ActorsStatus.NOT_INITIALIZED,
    [VesActorsStatus.STALE_SYMBOLS]: ActorsStatus.STALE_SYMBOLS,
};

type DetailTab = 'fields' | 'components';
type ComponentSortColumn = 'class' | 'rectangle' | 'parallax' | 'index' | 'address';

interface TreeRow {
    key: string;
    depth: number;
    kind: 'actor' | 'group' | 'container';
    label: string;
    className: string;
    actor?: VesActor;
    members?: VesActor[];
    expandable: boolean;
    open: boolean;
}

interface FieldGroup {
    className: string;
    fields: VesFieldValue[];
}

/**
 * Every live actor as the scene tree it makes (found by readActors), and everything the selected one holds. Each actor
 * records its container, so the list is a tree under the stage, with runs of identical siblings folded. The inspector
 * reads the selected actor with the layout the build's debug sections give for its exact class, with fields sorted
 * under the class that declared them. The screen inspector picks actors off the picture.
 */
export class ActorsPanel extends Panel {

    // as for the pools: a whole-heap read, and every block in it walked
    protected static readonly ACTORS_POLL_HZ = 4;

    protected status = ActorsStatus.NOT_RUNNING;
    protected read?: VesActorsRead;
    protected symbols?: SymbolIndex;
    protected error?: string;
    protected reading = false;
    protected componentSort: TableSort<ComponentSortColumn> = {};
    // by the address of the object rather than its row
    protected selected?: number;
    // resolved char* names, which do not change once an actor has one
    protected readonly names = new Map<number, string>();
    // narrows the tree by spec, class or name; not remembered, like the other panels' filters
    protected filter = '';
    protected fieldFilter = '';
    protected showHidden = this.remembered('showHidden', true);
    protected tab = this.remembered('tab', 'fields') as DetailTab;
    // parents folded shut, by row key: they start open
    protected readonly closed = new Set<string>();
    // folds of like siblings opened up, by row key: they start shut
    protected readonly opened = new Set<string>();
    // field groups flipped from their default (own class open, inherited shut), by class name, so a group stays as
    // it was left from one actor to the next
    protected readonly flippedGroups = new Set<string>();
    // the selected actor's fields as last read, and when each last changed; see noteChanges
    protected trackedActor?: number;
    protected readonly lastTexts = new Map<string, string>();
    protected readonly changedAt = new Map<string, number>();
    protected scrollPending = false;

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.ACTORS, source, instanceId);
        this.title.label = emulatorPanelLabel(EmulatorPanelType.ACTORS);
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.ACTORS);
        // the query container for laying tree and inspector side by side or stacked, which a node cannot be for itself
        this.addClass('vp-actors-panel');
    }

    protected pollHz(): number {
        return ActorsPanel.ACTORS_POLL_HZ;
    }

    protected onAfterHide(msg: Message): void {
        super.onAfterHide(msg);
        // the marks belong to a selection this panel is no longer showing
        this.source.setHighlights([]);
    }

    protected onBeforeDetach(msg: Message): void {
        this.source.setHighlights([]);
        super.onBeforeDetach(msg);
    }

    protected onUpdateRequest(msg: Message): void {
        super.onUpdateRequest(msg);
        if (this.scrollPending) {
            this.scrollPending = false;
            // after React has drawn the row, which the base starts above
            requestAnimationFrame(() => {
                this.node.querySelector('.vp-actors-tree tr.selected')?.scrollIntoView({ block: 'nearest' });
            });
        }
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.reset(ActorsStatus.NOT_RUNNING);
            this.update();
            return;
        }
        if (this.reading) {
            return;
        }
        this.reading = true;

        try {
            const symbols = await this.source.getSymbols();
            const read = await readActors(sim, symbols);
            if (read.status !== VesActorsStatus.OK) {
                this.reset(STATUS_OF[read.status]);
                return;
            }
            this.read = read;
            this.symbols = symbols;
            this.status = ActorsStatus.OK;
            this.error = undefined;
            // keeps the selection on the same actor across refreshes, and drops it once that actor is freed
            if (this.selected !== undefined && !read.actors.some(actor => actor.objectAddress === this.selected)) {
                this.selected = undefined;
            }
            this.noteChanges();
            await this.resolveNames(sim);
        } catch (error) {
            console.error('[emulator] actors could not be read:', error);
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.reading = false;
            this.applyHighlights();
            this.update();
        }
    }

    protected noteChanges(): void {
        const actor = this.selectedActor();
        if (!actor || actor.objectAddress !== this.trackedActor) {
            // a different actor, or none: nothing to compare against
            this.trackedActor = actor?.objectAddress;
            this.lastTexts.clear();
            this.changedAt.clear();
            for (const field of actor?.fields ?? []) {
                this.lastTexts.set(field.path, field.text);
            }
            return;
        }
        const now = Date.now();
        for (const field of actor.fields) {
            const last = this.lastTexts.get(field.path);
            if (last !== undefined && last !== field.text) {
                this.changedAt.set(field.path, now);
            }
            this.lastTexts.set(field.path, field.text);
        }
    }

    // bounded per refresh, as each is a round trip of its own; the cache means none is asked for twice
    protected async resolveNames(sim: Sim): Promise<void> {
        const wanted: number[] = [];
        for (const actor of this.read?.actors ?? []) {
            const pointer = actor.namePointer;
            if (pointer !== undefined && pointer !== 0 && !this.names.has(pointer)
                && !wanted.includes(pointer) && wanted.length < NAMES_PER_REFRESH) {
                wanted.push(pointer);
            }
        }

        for (const pointer of wanted) {
            try {
                const bytes = new Uint8Array(await sim.readMemory(pointer, NAME_BYTES));
                const end = bytes.indexOf(0);
                this.names.set(pointer, String.fromCharCode(...bytes.subarray(0, end < 0 ? bytes.length : end)));
            } catch {
                // remembering the miss stops an unreadable name pointer being retried
                this.names.set(pointer, '');
            }
        }
    }

    protected reset(status: ActorsStatus): void {
        this.status = status;
        this.read = undefined;
        this.selected = undefined;
        this.error = undefined;
    }

    protected actors(): VesActor[] {
        return this.read?.actors ?? [];
    }

    protected actorAt(address: number): VesActor | undefined {
        return this.actors().find(actor => actor.objectAddress === address);
    }

    protected selectedActor(): VesActor | undefined {
        return (this.selected !== undefined ? this.actorAt(this.selected) : undefined) ?? this.actors()[0];
    }

    protected select(objectAddress: number): void {
        this.selected = objectAddress;
        this.noteChanges();
        this.applyHighlights();
        this.update();
    }

    reveal(target: ScreenInspectorTarget): void {
        if (target.kind !== 'actor') {
            return;
        }
        const actor = this.actorAt(target.address);
        if (!actor) {
            return;
        }
        if (actor.hidden && !this.showHidden) {
            this.showHidden = this.remember('showHidden', true);
        }
        this.filter = '';
        // up the chain of parents, bounded in case a half-built tree loops
        const limit = this.actors().length;
        for (let at: VesActor | undefined = actor, step = 0; at && step <= limit; at = this.actorAt(at.parent), step++) {
            this.opened.add(this.groupKey(at));
            this.closed.delete(this.parentKey(at.parent));
        }
        this.scrollPending = true;
        this.select(actor.objectAddress);
    }

    // always handed over; whether they are drawn is the screen inspector's switch. Only sprites have a rectangle, so
    // an actor made only of components that draw nothing is not marked at all
    protected applyHighlights(): void {
        const rects: VesScreenRect[] = [];
        for (const component of this.selectedActor()?.components ?? []) {
            if (component.rect) {
                rects.push(component.rect);
            }
        }
        this.source.setHighlights(rects);
    }

    protected ownNameOf(actor: VesActor): string {
        const pointer = actor.namePointer;
        if (pointer === undefined || pointer === 0) {
            return '';
        }
        return this.names.get(pointer) ?? '…';
    }

    protected labelOf(actor: VesActor): string {
        return actorLabel(actor);
    }

    protected parentKey(parent: number): string {
        return `p:${parent}`;
    }

    protected groupKey(actor: VesActor): string {
        return `g:${actor.parent}:${this.labelOf(actor)}`;
    }

    protected treeRows(): TreeRow[] {
        const read = this.read;
        if (!read) {
            return [];
        }
        const all = new Map(read.actors.map(actor => [actor.objectAddress, actor]));
        // hiding hides the children with the parent, in the engine as here
        const shown = (actor: VesActor): boolean => {
            for (let at: VesActor | undefined = actor, step = 0; at && step < all.size; at = all.get(at.parent), step++) {
                if (at.hidden && !this.showHidden) {
                    return false;
                }
            }
            return true;
        };
        const actors = read.actors.filter(shown);

        const children = new Map<number, VesActor[]>();
        const roots = new Map<number, VesActor[]>();
        for (const actor of actors) {
            const into = all.has(actor.parent) ? children : roots;
            into.set(actor.parent, [...into.get(actor.parent) ?? [], actor]);
        }

        const needle = this.filter.trim().toLowerCase();
        const filtering = needle !== '';
        const kept = new Map<number, boolean>();
        const keep = (actor: VesActor): boolean => {
            const known = kept.get(actor.objectAddress);
            if (known !== undefined) {
                return known;
            }
            // settled before the children are asked, so a cycle in a half-built tree ends
            kept.set(actor.objectAddress, false);
            const matches = !filtering
                || this.labelOf(actor).toLowerCase().includes(needle)
                || actor.className.toLowerCase().includes(needle)
                || this.ownNameOf(actor).toLowerCase().includes(needle)
                || (children.get(actor.objectAddress) ?? []).some(keep);
            kept.set(actor.objectAddress, matches);
            return matches;
        };

        const rows: TreeRow[] = [];
        const actorRow = (actor: VesActor, depth: number, expandable: boolean, open: boolean): TreeRow => ({
            key: `a:${actor.objectAddress}`, depth, kind: 'actor', label: this.labelOf(actor),
            className: actor.className, actor, expandable, open,
        });
        const emit = (siblings: VesActor[], depth: number, visited: Set<number>): void => {
            const sorted = siblings.filter(keep).sort((a, b) =>
                this.labelOf(a).localeCompare(this.labelOf(b)) || (a.internalId ?? 0) - (b.internalId ?? 0));
            const kidsOf = (actor: VesActor): VesActor[] =>
                (children.get(actor.objectAddress) ?? []).filter(keep);
            const leaves = new Map<string, VesActor[]>();
            for (const actor of sorted) {
                if (kidsOf(actor).length === 0) {
                    const label = this.labelOf(actor);
                    leaves.set(label, [...leaves.get(label) ?? [], actor]);
                }
            }
            const folded = new Set<string>();
            for (const actor of sorted) {
                if (visited.has(actor.objectAddress)) {
                    continue;
                }
                visited.add(actor.objectAddress);
                const kids = kidsOf(actor);
                const label = this.labelOf(actor);
                const like = leaves.get(label) ?? [];
                if (kids.length === 0 && like.length >= GROUP_MIN) {
                    if (folded.has(label)) {
                        continue;
                    }
                    folded.add(label);
                    const key = this.groupKey(actor);
                    const unfolded = filtering || this.opened.has(key);
                    rows.push({
                        key, depth, kind: 'group', label, className: actor.className,
                        members: like, expandable: true, open: unfolded,
                    });
                    if (unfolded) {
                        like.forEach(member => {
                            visited.add(member.objectAddress);
                            rows.push(actorRow(member, depth + 1, false, false));
                        });
                    }
                    continue;
                }
                const open = filtering || !this.closed.has(this.parentKey(actor.objectAddress));
                rows.push(actorRow(actor, depth, kids.length > 0, open));
                if (kids.length > 0 && open) {
                    emit(kids, depth + 1, visited);
                }
            }
        };

        const seen = new Set<number>();
        // the stage first, and anything else that holds actors without being one; parentless actors after them
        const parents = [...roots.keys()].sort((a, b) => (a === 0 ? 1 : 0) - (b === 0 ? 1 : 0) || a - b);
        for (const parent of parents) {
            const list = roots.get(parent)!;
            if (parent === 0 || !list.some(keep)) {
                emit(list, 0, seen);
                continue;
            }
            const key = this.parentKey(parent);
            const open = filtering || !this.closed.has(key);
            const className = read.classes.get(parent) ?? `0x${hex(parent, 8)}`;
            rows.push({ key, depth: 0, kind: 'container', label: className, className, expandable: true, open });
            if (open) {
                emit(list, 1, seen);
            }
        }
        return rows;
    }

    protected toggle(row: TreeRow): void {
        const set = row.kind === 'group' ? this.opened : this.closed;
        if (set.has(row.key)) {
            set.delete(row.key);
        } else {
            set.add(row.key);
        }
        this.update();
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return <EmptyContainer title={this.error} icon={<Warning size={32} />} />;
        }
        if (this.status !== ActorsStatus.OK) {
            return this.renderEmpty();
        }
        const selected = this.selectedActor();
        if (!selected) {
            return <EmptyContainer
                title={nls.localize('vueport/debug/panels/actors/none', 'No actors are allocated')}
                description={nls.localize(
                    'vueport/debug/panels/actors/noneDescription',
                    'Nothing in the memory pools is an Actor right now.'
                )}
                icon={<Plug size={32} />}
            />;
        }

        return <div className='vp-actors'>
            {this.renderTree(selected)}
            {this.renderInspector(selected)}
        </div>;
    }

    protected renderEmpty(): React.ReactNode {
        const titles: Record<ActorsStatus, string> = {
            [ActorsStatus.OK]: '',
            [ActorsStatus.NOT_RUNNING]: nls.localize(
                'vueport/general/notRunning', 'The emulator is not running.'
            ),
            [ActorsStatus.NO_SYMBOLS]: nls.localize(
                'vueport/general/noSymbols', 'No symbols for this ROM.'
            ),
            [ActorsStatus.NO_LAYOUTS]: nls.localize(
                'vueport/debug/panels/actors/noLayouts', 'No field layouts for this ROM.'
            ),
            [ActorsStatus.NOT_INITIALIZED]: nls.localize(
                'vueport/debug/panels/memoryPools/notInitialized', 'The memory pools are not up yet.'
            ),
            [ActorsStatus.STALE_SYMBOLS]: nls.localize(
                'vueport/debug/panels/actors/stale', 'The symbols belong to a different build.'
            ),
        };
        const descriptions: Partial<Record<ActorsStatus, string>> = {
            [ActorsStatus.NO_SYMBOLS]: nls.localize(
                'vueport/general/noSymbolsDescription',
                'Reading the pools needs the .elf the ROM was built from, which is found through the .map \
file beside it. A ROM built elsewhere, or built without either, cannot be inspected this way.'
            ),
            [ActorsStatus.NO_LAYOUTS]: nls.localize(
                'vueport/debug/panels/actors/noLayoutsDescription',
                'The .elf beside this ROM carries no debug sections, and without them there is no way to \
know where an actor keeps its fields.'
            ),
            [ActorsStatus.STALE_SYMBOLS]: nls.localize(
                'vueport/debug/panels/actors/staleDescription',
                'Which class a block holds, and where its fields are, both come from the symbols — from \
another build they would be wrong together. Rebuild, or reload the ROM.'
            ),
        };

        const missingFile = this.status === ActorsStatus.NO_SYMBOLS
            || this.status === ActorsStatus.NO_LAYOUTS
            || this.status === ActorsStatus.STALE_SYMBOLS;
        return <EmptyContainer
            title={titles[this.status]}
            description={descriptions[this.status]}
            icon={missingFile ? <FileX size={32} /> : <Plug size={32} />}
        />;
    }

    protected renderTree(selected: VesActor): React.ReactNode {
        const rows = this.treeRows();
        const actors = this.actors();
        const hidden = actors.filter(actor => actor.hidden).length;
        const position = (actor: VesActor | undefined, axis: number): string => {
            const value = actor?.position[axis];
            return value === undefined ? '' : String(value);
        };

        return <div className='vp-actors-list'>
            <div className='vp-actors-list-head'>
                <PanelFilter
                    value={this.filter}
                    placeholder={nls.localize('vueport/debug/panels/actors/filter', 'Filter by spec, class or name')}
                    missed={rows.length === 0}
                    onChange={value => { this.filter = value; this.update(); }}
                />
                {/* the Terminal panel's kind of switch: on in the accent color, off as a secondary button */}
                <button
                    type='button'
                    className={`vp-actors-toggle vp-button${this.showHidden ? '' : ' secondary'}`}
                    aria-pressed={this.showHidden}
                    title={nls.localize(
                        'vueport/debug/panels/actors/showHiddenHint',
                        'List hidden actors too. They are still alive and still cost their blocks; they are \
dimmed, and their children go with them.'
                    )}
                    onClick={() => {
                        this.showHidden = this.remember('showHidden', !this.showHidden);
                        this.update();
                    }}
                >
                    <EyeSlash size={13} />
                    {nls.localize('vueport/debug/panels/actors/showHidden', 'Hidden')}
                </button>
            </div>
            <div className='vp-actors-rows vp-scroll' onMouseLeave={() => this.light(undefined)}>
                <table className='vp-table vp-selectable-table vp-actors-tree'>
                    <thead>
                        <tr>
                            <th className='vp-actors-name' title={nls.localize(
                                'vueport/debug/panels/actors/specColumnHint',
                                'The spec this actor was built from, named as the project declares it.'
                            )}>
                                {nls.localize('vueport/debug/panels/actors/spec', 'Spec')}
                            </th>
                            <th className='vp-actors-name'>
                                {nls.localize('vueport/debug/panels/actors/class', 'Class')}
                            </th>
                            <th>X</th>
                            <th>Y</th>
                            <th>Z</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(row => {
                            const actor = row.actor;
                            const isSelected = actor !== undefined && actor.objectAddress === selected.objectAddress;
                            const classes = [
                                `vp-actors-${row.kind}`,
                                actor?.hidden ? 'inactive' : '',
                                isSelected ? 'selected' : '',
                            ].filter(Boolean).join(' ');
                            return <tr
                                key={row.key}
                                className={classes}
                                aria-selected={actor ? isSelected : undefined}
                                onMouseEnter={() => this.light(actor && actorPixelSource(actor))}
                                onClick={() => actor ? this.select(actor.objectAddress) : this.toggle(row)}
                            >
                                <td className='vp-actors-name'>
                                    <span className='vp-actors-cell' style={{ paddingLeft: `${row.depth * 14}px` }}>
                                        {row.expandable
                                            ? <button
                                                type='button'
                                                className='vp-actors-caret'
                                                aria-expanded={row.open}
                                                aria-label={row.open
                                                    ? nls.localize('vueport/debug/panels/actors/collapse', 'Collapse')
                                                    : nls.localize('vueport/debug/panels/actors/expand', 'Expand')}
                                                onClick={event => {
                                                    event.stopPropagation();
                                                    this.toggle(row);
                                                }}
                                            >
                                                {row.open
                                                    ? <CaretDown size={11} weight='fill' />
                                                    : <CaretRight size={11} weight='fill' />}
                                            </button>
                                            : <span className='vp-actors-caret' />}
                                        <span className='vp-actors-label'>{row.label}</span>
                                        {row.members && <span className='vp-actors-count'>×{row.members.length}</span>}
                                        {actor?.hidden && <EyeSlash size={12} aria-label={nls.localize(
                                            'vueport/debug/panels/actors/hidden', 'Hidden')} />}
                                    </span>
                                </td>
                                <td className='vp-actors-name vp-actors-class'>
                                    {row.kind === 'container' ? '' : row.className}
                                </td>
                                <td>{position(actor, 0)}</td>
                                <td>{position(actor, 1)}</td>
                                <td>{position(actor, 2)}</td>
                            </tr>;
                        })}
                    </tbody>
                </table>
                {rows.length === 0 && <div className='hint'>
                    {nls.localize('vueport/debug/panels/actors/noneMatch', 'No actor matches the filter.')}
                </div>}
            </div>
            <div className='hint vp-actors-footer'>
                {hidden > 0
                    ? nls.localize('vueport/debug/panels/actors/countHidden', '{0} actors · {1} hidden', actors.length, hidden)
                    : nls.localize('vueport/debug/panels/actors/count', '{0} actors', actors.length)}
            </div>
        </div>;
    }

    protected renderInspector(actor: VesActor): React.ReactNode {
        const groups = this.fieldGroups(actor);
        const fieldCount = actor.fields.length;
        return <div className='vp-actors-inspector'>
            <div className='vp-actors-head'>
                <div className='vp-actors-title'>
                    <h2>{this.labelOf(actor)}</h2>
                    {actor.spec && actor.specOffset ? <span className='hint'>+{actor.specOffset}</span> : undefined}
                    {!actor.spec && actor.specAddress !== undefined && <span
                        className='hint'
                        title={nls.localize(
                            'vueport/debug/panels/actors/specUnnamedHint',
                            'No global spec covers this address, so it was likely built at runtime.'
                        )}
                    >
                        {nls.localize('vueport/debug/panels/actors/runtimeSpec', 'spec at {0}', `0x${hex(actor.specAddress, 8)}`)}
                    </span>}
                    <span className='vp-actors-spacer' />
                    <button
                        type='button'
                        className='vp-actors-action'
                        title={nls.localize(
                            'vueport/debug/panels/actors/memoryHint', 'Show this actor’s bytes in the Memory panel')}
                        onClick={() => this.source.reveal({ kind: 'memory', address: actor.objectAddress })}
                    >
                        {nls.localize('vueport/debug/panels/actors/memory', 'Memory')}
                    </button>
                </div>
                <div className='vp-actors-chain' title={nls.localize(
                    'vueport/debug/panels/actors/chainHint', 'The class and everything it inherits from')}>
                    {actor.ancestry.map((name, index) => <React.Fragment key={name}>
                        {index > 0 && <span className='vp-actors-arrow'>→</span>}
                        <code className={`${index === 0 ? 'own' : ''}${name === actor.readAs && name !== actor.className ? ' read-as' : ''}`}
                            title={name === actor.readAs && name !== actor.className ? nls.localize(
                                'vueport/debug/panels/actors/readAsHint',
                                'This build carries no field layout for the exact class, so it is read as \
the nearest one it does describe. Inherited fields are at the same offsets; the subclass’ own are not shown.'
                            ) : undefined}>
                            {name}
                        </code>
                    </React.Fragment>)}
                </div>
                <div className='vp-actors-facts'>
                    {this.facts(actor).map(([label, value, hint]) => <div key={label} title={hint}>
                        <span className='hint'>{label}</span>
                        <span className='vp-actors-fact'>{value}</span>
                    </div>)}
                </div>
            </div>
            <div className='vp-actors-tabs' role='tablist'>
                {this.tabButton('fields', nls.localize('vueport/debug/panels/actors/fields', 'Fields'), fieldCount)}
                {this.tabButton('components', nls.localize('vueport/debug/panels/actors/components', 'Components'),
                    actor.components.length)}
                <span className='vp-actors-spacer' />
                {this.tab === 'fields' && <PanelFilter
                    value={this.fieldFilter}
                    placeholder={nls.localize('vueport/debug/panels/actors/filterFields', 'Filter fields')}
                    onChange={value => { this.fieldFilter = value; this.update(); }}
                />}
            </div>
            <div className='vp-actors-tab vp-scroll' role='tabpanel'>
                {this.tab === 'fields' ? this.renderFields(groups) : this.renderComponents(actor)}
            </div>
        </div>;
    }

    protected tabButton(tab: DetailTab, label: string, count: number): React.ReactNode {
        return <button
            type='button'
            role='tab'
            aria-selected={this.tab === tab}
            className={`vp-actors-tab-button${this.tab === tab ? ' on' : ''}`}
            onClick={() => {
                this.tab = this.remember('tab', tab) as DetailTab;
                this.update();
            }}
        >
            {label} <span className='hint'>{count}</span>
        </button>;
    }

    // the few things about an actor worth seeing before its fields: label, value and why
    protected facts(actor: VesActor): [string, React.ReactNode, string?][] {
        const position = actor.position.map(value => value ?? '—').join(', ');
        const parent = this.actorAt(actor.parent);
        const children = this.actors().filter(other => other.parent === actor.objectAddress).length;
        const ownName = this.ownNameOf(actor);
        return [
            [nls.localize('vueport/debug/panels/actors/position', 'Position'), position],
            [nls.localize('vueport/debug/panels/actors/parent', 'Parent'), parent
                ? <button type='button' className='vp-actors-link' onClick={() => this.select(parent.objectAddress)}>
                    {this.labelOf(parent)}
                </button>
                : this.read?.classes.get(actor.parent) ?? (actor.parent ? `0x${hex(actor.parent, 8)}` : '—')],
            [nls.localize('vueport/debug/panels/actors/children', 'Children'), String(children)],
            [nls.localize('vueport/debug/panels/actors/id', 'Id'), actor.internalId ?? '—',
                nls.localize('vueport/debug/panels/actors/idHint', "The engine's own id for this instance")],
            [nls.localize('vueport/debug/panels/actors/address', 'Address'), `0x${hex(actor.objectAddress, 8)}`],
            [nls.localize('vueport/debug/panels/memoryPools/block', 'Block'), `${actor.blockSize} B · 0x${hex(actor.blockAddress, 8)}`,
                nls.localize('vueport/debug/panels/actors/blockHint', 'The pool block it occupies, in bytes')],
            [nls.localize('vueport/debug/panels/actors/name', 'Name'), ownName || '—', nls.localize(
                'vueport/debug/panels/actors/nameHint',
                'The name the game passed to the constructor, which most actors are never \
given — unlike the spec, which nearly all of them have.'
            )],
            [nls.localize('vueport/debug/panels/actors/state', 'State'), actor.hidden
                ? nls.localize('vueport/debug/panels/actors/hidden', 'Hidden')
                : nls.localize('vueport/debug/panels/actors/shown', 'Shown')],
        ];
    }

    // the class macro lays inherited fields out first and by name, so a field belongs to the furthest ancestor whose
    // own layout has a member of its name; a class the build does not describe lists nothing
    protected fieldGroups(actor: VesActor): FieldGroup[] {
        const structs = this.symbols?.structs;
        const chain = actor.ancestry;
        const owners = new Map<string, string>();
        for (let index = chain.length - 1; index >= 0; index--) {
            const struct = structs?.get(structNameOf(chain[index]));
            for (const member of struct?.members ?? []) {
                if (!owners.has(member.name)) {
                    owners.set(member.name, chain[index]);
                }
            }
        }
        const byClass = new Map<string, VesFieldValue[]>();
        for (const field of actor.fields) {
            const top = field.path.split(/[.[]/)[0];
            const owner = owners.get(top) ?? actor.readAs;
            byClass.set(owner, [...byClass.get(owner) ?? [], field]);
        }
        return chain
            .filter(name => byClass.has(name))
            .map(className => ({ className, fields: byClass.get(className)! }));
    }

    protected renderFields(groups: FieldGroup[]): React.ReactNode {
        const actor = this.selectedActor();
        const ownName = actor ? this.ownNameOf(actor) : '';
        const needle = this.fieldFilter.trim().toLowerCase();
        const now = Date.now();
        const first = groups[0]?.className;
        const shown = groups
            .map(group => ({
                ...group,
                fields: needle === '' ? group.fields : group.fields.filter(field => field.path.toLowerCase().includes(needle)),
            }))
            .filter(group => group.fields.length > 0);
        if (shown.length === 0) {
            return <div className='hint vp-actors-empty'>
                {groups.length === 0
                    ? nls.localize('vueport/debug/panels/actors/noFields', 'No fields to show.')
                    : nls.localize('vueport/debug/panels/actors/noFieldMatches', 'No field matches the filter.')}
            </div>;
        }
        return shown.map(group => {
            // own class open and the rest shut, unless flipped; all open while filtering, a search for a field wherever
            // it is
            const open = needle !== '' || (group.className === first) !== this.flippedGroups.has(group.className);
            return <div key={group.className} className='vp-actors-group'>
                <button
                    type='button'
                    className='vp-actors-group-head'
                    aria-expanded={open}
                    onClick={() => {
                        if (this.flippedGroups.has(group.className)) {
                            this.flippedGroups.delete(group.className);
                        } else {
                            this.flippedGroups.add(group.className);
                        }
                        this.update();
                    }}
                >
                    {open ? <CaretDown size={11} weight='fill' /> : <CaretRight size={11} weight='fill' />}
                    <code>{group.className}</code>
                    <span className='vp-actors-spacer' />
                    <span className='hint'>
                        {nls.localize('vueport/debug/panels/actors/fieldCount', '{0} fields', group.fields.length)}
                    </span>
                </button>
                {open && <table className='vp-table vp-actors-fields'>
                    <thead>
                        <tr>
                            <th className='vp-actors-mark' />
                            <th>{nls.localize('vueport/debug/panels/actors/fieldColumn', 'Field')}</th>
                            <th>{nls.localize('vueport/debug/panels/actors/value', 'Value')}</th>
                            <th className='vp-actors-offset' title={nls.localize(
                                'vueport/debug/panels/actors/offsetHint',
                                'Bytes from the start of the object to the field, nested fields included: \
what the engine\'s code reaches it by, as in ld.w 96[r10].'
                            )}>
                                {nls.localize('vueport/debug/panels/actors/offset', 'Offset')}
                            </th>
                            <th>{nls.localize('vueport/debug/panels/actors/type', 'Type')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {group.fields.map(field => {
                            const changed = now - (this.changedAt.get(field.path) ?? -Infinity) < CHANGED_MARK_MS;
                            return <tr key={field.path} className={changed ? 'changed' : undefined}>
                                <td className='vp-actors-mark' title={changed ? nls.localize(
                                    'vueport/debug/panels/actors/changedHint', 'Changed in the last moment') : undefined}>
                                    <span />
                                </td>
                                <td className='vp-actors-name'>{field.path}</td>
                                <td className='vp-actors-name vp-actors-value'>
                                    {this.fieldValue(field, field.path === NAME_FIELD ? ownName : '')}
                                </td>
                                <td className='hint'>+{field.offset}</td>
                                <td className='vp-actors-name hint'>{field.type.name}</td>
                            </tr>;
                        })}
                    </tbody>
                </table>}
            </div>;
        });
    }

    // a pointer into the pools is shown by what it points at: an actor to go to, or the class of whatever is there
    protected fieldValue(field: VesFieldValue, name: string): React.ReactNode {
        if (name !== '') {
            return `"${name}"`;
        }
        const value = field.value;
        if (value === undefined || value === 0) {
            return field.text;
        }
        const address = value >>> 0;
        const target = this.actorAt(address);
        if (target) {
            return <button type='button' className='vp-actors-link' onClick={() => this.select(address)}>
                {`→ ${this.labelOf(target)}`}
            </button>;
        }
        const className = this.read?.classes.get(address);
        return className ? <>{field.text} <span className='hint'>{className}</span></> : field.text;
    }

    // sprites carry the rectangle they were last drawn at and their world or objects, which the picture is marked
    // with; other components are listed by class alone
    protected renderComponents(actor: VesActor): React.ReactNode {
        if (actor.components.length === 0) {
            return <div className='hint vp-actors-empty'>
                {nls.localize('vueport/debug/panels/actors/noComponents', 'None attached.')}
            </div>;
        }
        const components = sortTableRows(actor.components, this.componentSort, (component, column) => {
            switch (column) {
                case 'class': return component.className;
                case 'rectangle': return component.rect
                    ? `${component.rect.x},${component.rect.y},${component.rect.width},${component.rect.height}`
                    : undefined;
                case 'parallax': return component.rect?.parallax;
                case 'index': return component.index !== undefined && component.index >= 0 ? component.index : undefined;
                case 'address': return component.address;
            }
        });
        const sort = (column: ComponentSortColumn) => {
            this.componentSort = nextTableSort(this.componentSort, column);
            this.update();
        };
        return <table className='vp-table vp-selectable-table vp-actors-components' onMouseLeave={() => this.light(undefined)}>
            <thead>
                <tr>
                    <SortableHeader className='vp-actors-name'
                        column='class' sort={this.componentSort} onSort={sort}>
                        {nls.localize('vueport/debug/panels/actors/class', 'Class')}
                    </SortableHeader>
                    <SortableHeader column='rectangle' sort={this.componentSort} onSort={sort} title={nls.localize(
                        'vueport/debug/panels/actors/rectHint',
                        'Where the engine last drew it, in screen pixels: x, y and size.'
                    )}>
                        {nls.localize('vueport/debug/panels/actors/rect', 'Rectangle')}
                    </SortableHeader>
                    <SortableHeader column='parallax' sort={this.componentSort} onSort={sort} title={nls.localize(
                        'vueport/debug/panels/actors/parallaxHint',
                        'How far the two eyes are drawn apart, which is what puts it in depth.'
                    )}>
                        {nls.localize('vueport/debug/panels/actors/parallax', 'Prlx')}
                    </SortableHeader>
                    <SortableHeader column='index' sort={this.componentSort} onSort={sort} title={nls.localize(
                        'vueport/debug/panels/actors/indexHint',
                        'The world a BG map sprite was last drawn into, or the highest of an object sprite’s \
objects. Empty while it is not being drawn.'
                    )}>
                        {nls.localize('vueport/debug/panels/actors/index', 'Index')}
                    </SortableHeader>
                    <SortableHeader column='address' sort={this.componentSort} onSort={sort}>
                        {nls.localize('vueport/debug/panels/actors/address', 'Address')}
                    </SortableHeader>
                </tr>
            </thead>
            <tbody>
                {components.map(component => (
                    <tr
                        key={component.address}
                        className={component.shown === false ? 'inactive' : undefined}
                        onMouseEnter={() => this.light(componentPixelSource(component))}
                    >
                        <td className='vp-actors-name'>{component.className}</td>
                        <td>{component.rect
                            ? `${component.rect.x}, ${component.rect.y} · ${component.rect.width}×${component.rect.height}`
                            : '—'}</td>
                        <td>{component.rect ? component.rect.parallax : '—'}</td>
                        <td>{component.index !== undefined && component.index >= 0 ? component.index : '—'}</td>
                        <td><code>{`0x${hex(component.address, 8)}`}</code></td>
                    </tr>
                ))}
            </tbody>
        </table>;
    }
}
