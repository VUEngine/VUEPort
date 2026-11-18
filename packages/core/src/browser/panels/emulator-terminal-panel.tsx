import { Funnel, IconProps, Info, Plug, Terminal, Warning, WarningOctagon } from '@phosphor-icons/react';
import { Message } from '@lumino/messaging';
import * as React from 'react';
import { DisposableCollection } from '../../common/emulator-events';
import { formatLogTime, LOG_LEVELS, LogLevel, splitLogLevel } from '../../common/emulator-log';
import { nls } from '../../common/emulator-nls';
import EmptyContainer from '../components/kit/EmptyContainer';
import PanelFilter from '../components/kit/PanelFilter';
import { Sim } from '../core/vb-core';
import { DebugSource, Panel, EmulatorPanelType } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';

const MAX_LINES = 2000;

// a few pixels, as scrollTop is fractional at a non-integer device-pixel ratio and a view at the bottom often reports
// itself a fraction short
const FOLLOW_SLACK = 4;

// bounded since a scroll whose event the browser folded into another would otherwise stay in the list forever
const OWN_SCROLLS = 8;

interface TerminalLine {
    text: string;
    at: number; // when the line was finished, as Terminal::print sends a character at a time
    level: LogLevel;
}

const LEVEL_ICONS: Record<LogLevel, React.ComponentType<IconProps>> = {
    info: Info,
    warning: Warning,
    error: WarningOctagon,
};

// render() schedules rather than draws, so scrolling right after it lands short of the new output; a layout effect runs
// after the commit and before paint
function AfterRender({ run }: { run(): void }): null {
    React.useLayoutEffect(() => run());
    return null;
}

/**
 * Output the running program wrote to the terminal port. VUEngine's Terminal::print stores a string to a fixed address
 * byte by byte, followed by a newline, and is compiled out of builds without debugging. Capturing it makes the core
 * call back on every CPU write, so capture is on only while this panel is open, and this is the one panel that is
 * pushed to rather than polled. Search and level switches compose: the search counts against what the switches left.
 */
export class TerminalPanel extends Panel {

    protected lines: TerminalLine[] = [];
    protected partial = '';
    // Terminal::print writes a string in one burst, so this is within a millisecond of the finish time and keeps the
    // time column filled
    protected partialAt = 0;

    protected follow = this.remembered('follow', true);
    // output arrived that the view has not been scrolled down to. Only new output is followed, as following on each
    // (once per second) render pulled a user who scrolled up back down
    protected pendingScroll = false;
    // positions the panel scrolled to that have not come back as scroll events yet. Events arrive late and don't say
    // who scrolled, so the panel's own scroll to the end could read as the user scrolling up
    // several assignments in one frame come back as one event with the last, so a match drops everything up to it
    protected readonly ownScrolls: number[] = [];
    // where the end of the output was before newly arrived output was drawn, since reaching the end turns following
    // back on and must mean where the user aimed. Undefined while nothing has arrived since
    protected endBefore?: number;

    protected search = '';
    protected onlyMatches = this.remembered('onlyMatches', false);
    protected levels: Record<LogLevel, boolean> = {
        info: this.remembered('level.info', true),
        warning: this.remembered('level.warning', true),
        error: this.remembered('level.error', true),
    };

    // to tell a different machine from the same one carrying on. A reset or a different cartridge keeps the simulation
    // and is caught by onRestart instead
    protected watched?: Sim;
    protected readonly watching = new DisposableCollection();
    protected capturing = false;

    protected scroller: HTMLDivElement | undefined;
    // kept as a member, as React hands a ref back and out again whenever the callback changes, leaving the panel
    // without its view exactly when it wants to scroll it
    protected readonly takeScroller = (element: HTMLDivElement | null): void => {
        this.scroller = element ?? undefined;
    };

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.TERMINAL, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/terminal/title', 'Terminal');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.TERMINAL);

        this.toDispose.push(this.watching);
        this.toDisposeOnDetach.push(this.source.onDidChange(() => this.followMachine()));
    }

    protected onAfterAttach(msg: Message): void {
        this.pendingScroll = true;
        super.onAfterAttach(msg);
        this.followMachine();
    }

    // capture costs a core callback on every CPU write, so it is released on close. Lines stay, as dragging a panel
    // across the dock detaches and reattaches it
    protected onBeforeDetach(msg: Message): void {
        this.watching.dispose();
        this.capturing = false;
        super.onBeforeDetach(msg);
    }

    protected pollHz(): number {
        return 1;
    }

    protected refresh(): void {
        this.followMachine();
        // rendered here too, as ReactWidget draws only from onUpdateRequest and the panel stayed blank until the first
        // output
        this.update();
    }

    // points the capture at the current machine and empties the panel for a different one
    protected followMachine(): void {
        const sim = this.source.sim;
        if (sim !== this.watched) {
            this.watching.dispose();
            this.capturing = false;
            this.watched = sim;
            this.clear();
        }
        if (!sim || this.capturing) {
            return;
        }
        this.capturing = true;

        sim.setTerminalCapture(true).catch(error => this.append(
            `\n${nls.localize(
                'vueport/debug/panels/terminal/failed',
                'Error: terminal capture could not be enabled: {0}',
                error instanceof Error ? error.message : String(error)
            )}\n`
        ));

        this.watching.push(sim.onTerminal(text => this.append(text)));
        this.watching.push(sim.onRestart(() => this.clear()));
        this.watching.push({ dispose: () => this.stopCapture(sim) });
    }

    protected stopCapture(sim: Sim): void {
        sim.setTerminalCapture(false).catch(() => { /* nothing to release */ });
    }

    protected append(text: string): void {
        if (this.partial === '') {
            this.partialAt = Date.now();
        }
        const combined = this.partial + text;
        const parts = combined.split('\n');
        this.partial = parts.pop() ?? '';
        const at = Date.now();
        this.lines.push(...parts.map(line => ({ ...splitLogLevel(line), at })));

        if (this.endBefore === undefined && this.scroller) {
            this.endBefore = Math.max(
                0, this.scroller.scrollHeight - this.scroller.clientHeight,
            );
        }

        if (this.lines.length > MAX_LINES) {
            this.lines.splice(0, this.lines.length - MAX_LINES);
        }
        this.pendingScroll = true;
        this.update();
    }

    protected clear(): void {
        this.lines = [];
        this.partial = '';
        this.update();
    }

    protected updateAndFollow(): void {
        this.pendingScroll = true;
        this.update();
    }

    protected afterRender(): void {
        const view = this.scroller;
        if (!this.pendingScroll || !view) {
            return;
        }
        this.pendingScroll = false;
        if (!this.follow) {
            return;
        }
        const before = view.scrollTop;
        view.scrollTop = view.scrollHeight;
        // only a scroll that moved the view comes back as an event, see ownScrolls
        if (view.scrollTop !== before) {
            this.ownScrolls.push(view.scrollTop);
            this.ownScrolls.splice(0, this.ownScrolls.length - OWN_SCROLLS);
        }
    }

    /**
     * Scrolling turns following on and off, so a user who scrolled up is not pulled away by the next line; reaching the
     * end turns it on again. While following, the end means the end as it is now, and anything else stops following.
     * Content shrinking (a Clear, a level switched off) lands the view at the end, which rightly reads as still being
     * there. While not following, the end means where it was when the scroll was made (endBefore), as each burst of
     * output moves the current end further down than the event reporting the scroll.
     */
    protected onScroll(): void {
        const view = this.scroller;
        if (!view) {
            return;
        }
        const top = view.scrollTop;

        const own = this.ownScrolls.indexOf(top);
        if (own >= 0) {
            this.ownScrolls.splice(0, own + 1);
            this.endBefore = undefined;
            return;
        }

        const end = Math.min(
            this.endBefore ?? Number.POSITIVE_INFINITY,
            view.scrollHeight - view.clientHeight,
        );
        this.endBefore = undefined;
        this.ownScrolls.length = 0;

        const follow = this.follow
            ? view.scrollHeight - top - view.clientHeight <= FOLLOW_SLACK
            : top >= end - FOLLOW_SLACK;
        if (follow !== this.follow) {
            this.follow = this.remember('follow', follow);
            this.update();
        }
    }

    // trimmed, so a program writing a space doesn't drop the "waiting for output" state
    protected hasOutput(): boolean {
        return this.lines.length > 0 || this.partial.trim() !== '';
    }

    protected matches(text: string): boolean {
        return this.search !== ''
            && text.toLowerCase().includes(this.search.toLowerCase());
    }

    protected render(): React.ReactNode {
        // the search counts against what the level switches left, so "3 of 418" is of the lines on screen
        const shown = this.lines.filter(line => this.levels[line.level]);
        const partial = splitLogLevel(this.partial);
        const partialShown = partial.text !== '' && this.levels[partial.level];
        const searching = this.search !== '';
        const hiding = searching && this.onlyMatches;

        const partialMatched = partialShown && this.matches(partial.text);
        const matched = (searching ? shown.filter(line => this.matches(line.text)).length : 0)
            + (partialMatched ? 1 : 0);

        const rows = hiding ? shown.filter(line => this.matches(line.text)) : shown;
        const partialRow = partialShown && (!hiding || partialMatched);

        const counts = {} as Record<LogLevel, number>;
        for (const level of LOG_LEVELS) {
            counts[level] = 0;
        }
        for (const line of this.lines) {
            counts[line.level]++;
        }
        const kinds = LOG_LEVELS.filter(
            level => counts[level] > 0 || partial.level === level,
        );
        // looked up once per render rather than per line, as there can be 2000 lines thirty times a second
        const badges = kinds.length > 1 ? this.levelLabels() : undefined;

        return (
            <div className="vp-terminal">
                {/* no controls before anything was captured; the unfinished line counts, or a program that never sends
                    a newline would have no output at all */}
                {this.hasOutput() && this.renderToolbar(
                    shown.length + (partialShown ? 1 : 0), matched, searching, counts,
                )}
                <div
                    className={`vp-terminal-lines vp-scroll${badges ? ' badged' : ''}`}
                    onScroll={() => this.onScroll()}
                    ref={this.takeScroller}
                >
                    {rows.length === 0 && !partialRow
                        ? this.renderEmpty()
                        : (
                            <>
                                {rows.map((line, index) => this.renderLine(
                                    line, index, badges, false,
                                ))}
                                {partialRow && this.renderLine(
                                    { ...partial, at: this.partialAt }, 'partial', badges, true,
                                )}
                            </>
                        )}
                </div>
                {/* last, so everything above it is in the document when it reports the render as done */}
                <AfterRender run={() => this.afterRender()} />
            </div>
        );
    }

    protected renderToolbar(
        shown: number, matched: number, searching: boolean,
        counts: Record<LogLevel, number>,
    ): React.ReactNode {
        const search = nls.localize('vueport/debug/panels/terminal/search', 'Search output');
        const onlyMatches = nls.localize('vueport/debug/panels/terminal/onlyMatches', 'Only matches');

        return <div className="vp-terminal-toolbar">
            <div className="vp-panel-toolbar vp-terminal-search-row">
                <PanelFilter
                    value={this.search}
                    placeholder={search}
                    missed={searching && matched === 0}
                    status={searching && <span className="vp-terminal-count">
                        {nls.localize(
                            'vueport/debug/panels/terminal/matchCount', '{0} of {1}', matched, shown,
                        )}
                    </span>}
                    onChange={value => {
                        this.search = value;
                        this.updateAndFollow();
                    }}
                />
                <button
                    type="button"
                    className={'vp-terminal-only-matches vp-button'
                        + (this.onlyMatches ? '' : ' secondary')}
                    aria-pressed={this.onlyMatches}
                    disabled={!searching}
                    title={nls.localize(
                        'vueport/debug/panels/terminal/onlyMatchesHint',
                        'Hide the lines the search did not find, rather than dimming them',
                    )}
                    onClick={() => {
                        this.onlyMatches = this.remember('onlyMatches', !this.onlyMatches);
                        this.updateAndFollow();
                    }}
                >
                    {onlyMatches}
                </button>
                {/* a toggle like Only matches, as both are panel states rather than settings */}
                <button
                    type="button"
                    className={`vp-terminal-follow vp-button${this.follow ? '' : ' secondary'}`}
                    aria-pressed={this.follow}
                    title={nls.localize(
                        'vueport/debug/panels/terminal/followOutputHint',
                        'Keep the view at the end of the output as it arrives',
                    )}
                    onClick={() => {
                        this.follow = this.remember('follow', !this.follow);
                        this.updateAndFollow();
                    }}
                >
                    {nls.localize(
                        'vueport/debug/panels/terminal/followOutput', 'Follow output',
                    )}
                </button>
                {/* never disabled, the toolbar only exists while there is output */}
                <button
                    className="vp-terminal-clear vp-button secondary"
                    onClick={() => this.clear()}
                >
                    {nls.localize('vueport/debug/panels/terminal/clear', 'Clear')}
                </button>
            </div>
            <div className="vp-panel-toolbar vp-terminal-filter-row">
                {this.renderLevels(counts)}
            </div>
        </div>;
    }

    // only levels with lines get a switch (an unprefixed line counts as info). A switched-off level keeps its switch, a
    // control that hid output and then itself would explain nothing
    protected renderLevels(counts: Record<LogLevel, number>): React.ReactNode {
        const labels = this.levelLabels();
        const wanted = LOG_LEVELS.filter(
            level => counts[level] > 0 || !this.levels[level],
        );
        if (wanted.length < 2 && wanted.every(level => this.levels[level])) {
            return undefined;
        }

        return wanted.map(level => {
            const on = this.levels[level];
            const Icon = LEVEL_ICONS[level];
            return <button
                key={level}
                type="button"
                className={`vp-terminal-level ${level}${on ? ' on' : ''}`}
                aria-pressed={on}
                title={nls.localize(
                    'vueport/debug/panels/terminal/levelToggle',
                    'Show or hide {0} lines',
                    labels[level],
                )}
                onClick={() => {
                    this.levels = { ...this.levels, [level]: !on };
                    this.remember(`level.${level}`, !on);
                    this.updateAndFollow();
                }}
            >
                <Icon size={13} />
                {labels[level]}
                <span className="vp-terminal-level-count">{counts[level]}</span>
            </button>;
        });
    }

    protected levelLabels(): Record<LogLevel, string> {
        return {
            info: nls.localize('vueport/debug/panels/terminal/levelInfo', 'Info'),
            warning: nls.localize('vueport/debug/panels/terminal/levelWarning', 'Warning'),
            error: nls.localize('vueport/debug/panels/terminal/levelError', 'Error'),
        };
    }

    protected renderLine(
        line: TerminalLine, key: React.Key,
        badges: Record<LogLevel, string> | undefined, partial: boolean,
    ): React.ReactNode {
        // dimmed rather than hidden unless only matches are wanted, as the context around a match is most of what a log
        // is read for
        const searching = this.search !== '';
        const hit = searching && this.matches(line.text);
        const classes = ['vp-terminal-line', line.level];
        if (partial) {
            classes.push('partial');
        }
        if (hit) {
            classes.push('match');
        } else if (searching && !this.onlyMatches) {
            classes.push('aside');
        }

        return <div className={classes.join(' ')} key={key}>
            <span className="vp-log-time">{formatLogTime(line.at)}</span>
            {badges && <span className={`vp-terminal-badge ${line.level}`}>
                {badges[line.level]}
            </span>}
            <span className="vp-terminal-text">
                {hit ? this.renderMatches(line.text) : line.text}
            </span>
        </div>;
    }

    protected renderMatches(text: string): React.ReactNode {
        const needle = this.search.toLowerCase();
        const haystack = text.toLowerCase();
        const parts: React.ReactNode[] = [];
        let at = 0;
        for (let found = haystack.indexOf(needle); found >= 0;
            found = haystack.indexOf(needle, at)) {
            if (found > at) {
                parts.push(text.slice(at, found));
            }
            at = found + needle.length;
            parts.push(
                <mark className="vp-terminal-match" key={found}>
                    {text.slice(found, at)}
                </mark>,
            );
        }
        if (at < text.length) {
            parts.push(text.slice(at));
        }
        return parts;
    }

    protected renderEmpty(): React.ReactNode {
        if (this.hasOutput()) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/debug/panels/terminal/nothingShown',
                    'Nothing to show',
                )}
                description={nls.localize(
                    'vueport/debug/panels/terminal/nothingShownHint',
                    'The search or the level switches are hiding every line that was captured.',
                )}
                icon={<Funnel size={32} />}
            />;
        }
        if (!this.source.sim) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/general/notRunning',
                    'The emulator is not running.',
                )}
                icon={<Plug size={32} />}
            />;
        }
        return <EmptyContainer
            title={nls.localize(
                'vueport/debug/panels/terminal/waiting',
                'Waiting for output',
            )}
            description={nls.localize(
                'vueport/debug/panels/terminal/waitingHint',
                'This game has not yet written to the terminal output.',
            )}
            icon={<Terminal size={32} />}
        />;
    }
}
