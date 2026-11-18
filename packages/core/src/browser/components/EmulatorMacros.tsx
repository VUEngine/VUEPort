import {
    GlobeHemisphereWest,
    Hash,
    MagnifyingGlass,
    PencilSimple,
    Play,
    Queue,
    Record,
    Repeat,
    Stop,
    Trash,
    X,
} from '@phosphor-icons/react';
import * as React from 'react';
import styled from 'styled-components';
import { VueportNotifications } from '../../common/emulator-host';
import {
    formatMacroDuration,
    MACRO_SLOT_COUNT,
    parseMacroFile,
    Macro,
    macroKeysUsed,
    macroPressCount,
    macroPresses,
} from '../../common/emulator-macros';
import { nls } from '../../common/emulator-nls';
import { EmulatorGamePadButton } from '../emulator-commands';
import { emulatorHeldButtons } from '../emulator-input';
import { MacroStore, MacroActivity } from '../emulator-macro-store';
import EmptyContainer from './kit/EmptyContainer';
import { PanelDetailFooter, PanelDetailHero, PanelDetailSection, PanelDetailToolbar } from './kit/PanelDetail';
import Select from './kit/Select';
import Switch from './kit/Switch';

const StyledCloseButton = styled.button`
    position: relative;
    z-index: 10;
`;

const TICK_MS = 100;

// the markings on the hardware, deliberately not translated, so a row of steps has room for `L↑ A`.
// The hover still shows the full, translated names from the input commands
const BUTTON_SYMBOLS: Record<EmulatorGamePadButton, string> = {
    lUp: 'L↑',
    lRight: 'L→',
    lDown: 'L↓',
    lLeft: 'L←',
    rUp: 'R↑',
    rRight: 'R→',
    rDown: 'R↓',
    rLeft: 'R←',
    lTrigger: 'LT',
    rTrigger: 'RT',
    select: 'Sel',
    start: 'Sta',
    b: 'B',
    a: 'A',
};

// timeline steps in milliseconds, the first one that leaves no more than four marks is used
const TIMELINE_TICKS = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];

// every button a macro holds, with the [from, to] stretches it is held for (a button still down at the last step
// is held to the end), in the controller reference's order
function macroLanes(macro: Macro): Array<{ button: EmulatorGamePadButton, bars: Array<[number, number]> }> {
    const lanes = emulatorHeldButtons(macroKeysUsed(macro))
        .map(button => ({ button, bars: [] as Array<[number, number]>, since: undefined as number | undefined }));
    for (const step of macro.steps) {
        const held = emulatorHeldButtons(step.keys);
        for (const lane of lanes) {
            const down = held.includes(lane.button);
            if (down && lane.since === undefined) {
                lane.since = step.at;
            } else if (!down && lane.since !== undefined) {
                lane.bars.push([lane.since, step.at]);
                lane.since = undefined;
            }
        }
    }
    return lanes.map(({ button, bars, since }) => ({
        button,
        bars: since === undefined ? bars : [...bars, [since, macro.duration]],
    }));
}

// only a view of the store, which owns the list, writes the file and holds the buttons during playback, so a macro
// plays on with this closed. A component rather than a panel, like the cheats: docked in Debug mode, beside the
// screen while playing, as recording happens mid-game
export default function EmulatorMacros(props: {
    macros: MacroStore,
    notifications: VueportNotifications,
    // given for the strip beside the screen, which has no chrome to close it by. The docked panel has a tab
    onClose?: () => void,
}): React.JSX.Element {
    const { macros, notifications, onClose } = props;

    const [editing, setEditing] = React.useState<number | undefined>(undefined);
    const [filter, setFilter] = React.useState('');
    const importInput = React.useRef<HTMLInputElement>(null);
    const [, setVersion] = React.useState(0);
    const redraw = React.useCallback(() => setVersion(version => version + 1), []);

    // a macro can be started from the other copy of this, or the file reloaded with a new ROM
    React.useEffect(() => {
        const subscription = macros.onDidChange(redraw);
        return () => subscription.dispose();
    }, [macros, redraw]);

    const activity = macros.activity;

    // the stopwatch is pulled here on a timer, only while there is something to count, as a store firing
    // sixty times a second would make every other listener pay for it
    React.useEffect(() => {
        if (activity === MacroActivity.IDLE) {
            return undefined;
        }
        const timer = window.setInterval(redraw, TICK_MS);
        return () => window.clearInterval(timer);
    }, [activity, redraw]);

    const list = macros.list;
    const recording = activity === MacroActivity.RECORDING;

    const closeButton = onClose && <StyledCloseButton
        type='button'
        className='vp-panel-close'
        aria-label={nls.localize('vueport/macros/closeMacros', 'Close Macros')}
        onClick={onClose}
    >
        <X size={20} />
    </StyledCloseButton>;

    // the title is for the strip beside the screen, which has no tab naming it; docked, only the close remains
    const header = <div className='vp-panel-heading'>
        {onClose &&
            <span className='vp-panel-heading-title'>
                <Queue size={22} />
                {nls.localize('vueport/macros/title', 'Macros')}
            </span>}
        {closeButton}
    </div>;

    // numbered from the list length, as it is a placeholder the editor opens on to be typed over, not an identity
    const defaultName = (): string =>
        nls.localize('vueport/macros/newMacro', 'Macro {0}', list.length + 1);

    // keeps what was recorded and opens it to be named. The store keeps nothing when no button was pressed
    const stopRecording = (): void => {
        const index = macros.stopRecording(defaultName());
        if (index === undefined) {
            notifications.info(nls.localize(
                'vueport/macros/nothingRecorded',
                'Nothing was recorded: no buttons were pressed.'));
            return;
        }
        setEditing(index);
    };

    const toggleRecording = (): void => {
        if (recording) {
            stopRecording();
        } else {
            // back to the list, so what is about to be recorded is not hidden behind the editor for something else
            setEditing(undefined);
            macros.startRecording();
        }
    };

    // confirmed first, as a macro is a performance that cannot be typed in again like a cheat
    const removeMacro = async (index: number): Promise<void> => {
        const doomed = list[index];
        if (!doomed) {
            return;
        }
        // hoisted out of the message's arguments, as the extractor stops descending at a matched localize call,
        // so a nested one never reaches nls.json
        const unnamed = nls.localize('vueport/macros/thisMacro', 'this macro');
        const confirmed = await notifications.confirm({
            title: nls.localize('vueport/macros/deleteMacroQuestion', 'Delete Macro?'),
            message: nls.localize(
                'vueport/macros/areYouSureYouWantToDelete',
                'Are you sure you want to delete {0}?',
                doomed.name || unnamed,
            ),
        });
        if (confirmed) {
            macros.remove(index);
            // back to the list: the edited macro is gone, and every index after it now means a different one
            setEditing(undefined);
        }
    };

    const symbols = (keys: number): string[] =>
        emulatorHeldButtons(keys).map(button => BUTTON_SYMBOLS[button]);

    const renderButtons = (keys: number): React.ReactNode => {
        const held = symbols(keys);
        if (held.length === 0) {
            return <span className='vp-macros-release'>
                {nls.localize('vueport/macros/release', 'release')}
            </span>;
        }
        return held.map(symbol => (
            <span className='vp-macros-button' key={symbol}>{symbol}</span>
        ));
    };

    // presses only, as half the steps would be releases. Buttons that went down together stay together,
    // with a dot between presses, so a chord does not read as two presses
    const renderSequence = (macro: Macro): React.ReactNode =>
        macroPresses(macro).map((press, index) =>
            <React.Fragment key={index}>
                {index > 0 && <span className='vp-macros-separator'>·</span>}
                {symbols(press).map(symbol => (
                    <span className='vp-macros-button' key={symbol}>{symbol}</span>
                ))}
            </React.Fragment>
        );

    const sequenceText = (macro: Macro): string =>
        macroPresses(macro).map(press => symbols(press).join(' ')).join(' · ');

    // a lane per button with a bar for every stretch it is down, against one clock; says at a glance what the
    // steps list says exactly. Read-only: recording again is the edit
    const renderTimeline = (macro: Macro, index: number): React.ReactNode => {
        const duration = Math.max(1, macro.duration);
        const at = (moment: number): string => `${Math.min(100, (moment / duration) * 100)}%`;
        const lanes = macroLanes(macro);
        const step = TIMELINE_TICKS.find(candidate => duration / candidate <= 4)
            ?? TIMELINE_TICKS[TIMELINE_TICKS.length - 1];
        const ticks: number[] = [];
        for (let moment = 0; moment <= duration; moment += step) {
            ticks.push(moment);
        }
        // folded back into the macro for one that repeats, as the clock keeps running across the loops
        const playhead = macros.playingIndex === index
            ? (macro.loop ? macros.elapsed % duration : Math.min(macros.elapsed, duration))
            : undefined;
        return <div className='vp-detail-card vp-macros-timeline'>
            {lanes.map(({ button, bars }, lane) => (
                <div className='vp-macros-lane' key={button}>
                    <span className='vp-macros-button'>{BUTTON_SYMBOLS[button]}</span>
                    <span className='vp-macros-track'>
                        {bars.map(([from, to], bar) => <span
                            key={bar}
                            className='vp-macros-bar'
                            style={{
                                background: `var(--vp-series-${(lane % 5) + 1})`,
                                left: at(from),
                                width: `calc(${at(to)} - ${at(from)})`,
                            }}
                        />)}
                        {playhead !== undefined &&
                            <span className='vp-macros-playhead' style={{ left: at(playhead) }} />}
                    </span>
                </div>
            ))}
            <div className='vp-macros-lane vp-macros-ticks' aria-hidden='true'>
                <span />
                <span className='vp-macros-track'>
                    {ticks.map(moment => <span key={moment} style={{ left: at(moment) }}>
                        {step < 1000 ? (moment / 1000).toFixed(1) : `${moment / 1000}`}
                    </span>)}
                </span>
            </div>
        </div>;
    };

    // read-only, unlike a cheat's codes: a table of milliseconds is not where anybody would fix a recording
    const renderSteps = (macro: Macro): React.ReactNode =>
        <ol className='vp-detail-card vp-macros-steps vp-scroll'>
            {macro.steps.map((step, index) => (
                <li className='vp-macros-step' key={index}>
                    <span className='time'>{formatMacroDuration(step.at)}</span>
                    <span className='keys'>{renderButtons(step.keys)}</span>
                </li>
            ))}
        </ol>;

    // the macro lands at the end of the part of the list it moved to, so its new index is worked out; the store
    // hands out shared ones as fresh copies, so it cannot be looked up
    const setGlobal = (index: number, global: boolean): void => {
        macros.setGlobal(index, global);
        setEditing(global
            ? macros.list.length - 1
            : macros.list.filter(entry => !entry.global).length - 1);
    };

    const renderDetail = (macro: Macro, index: number): React.ReactNode => {
        const playing = macros.playingIndex === index;
        const name = macro.name || nls.localize('vueport/macros/thisMacro', 'this macro');
        const presses = macroPressCount(macro);
        return <div className='vp-detail-page'>
            <PanelDetailHero
                icon={<Queue size={22} />}
                name={macro.name}
                onRename={next => macros.update(index, { name: next })}
                meta={<>
                    {formatMacroDuration(macro.duration)}
                    {' · '}
                    {presses === 1
                        ? nls.localize('vueport/macros/pressCountOne', '1 press')
                        : nls.localize('vueport/macros/pressCountMany', '{0} presses', presses)}
                    {macro.loop && <Repeat size={13} />}
                    {macro.slot !== undefined && <SlotBadge slot={macro.slot} />}
                    {macro.global && <GlobeHemisphereWest
                        size={13}
                        aria-label={nls.localize('vueport/macros/globalMacro', 'Available in every game')}
                    />}
                </>}
                control={<button
                    type='button'
                    className={'vp-detail-play' + (playing ? ' playing' : '')}
                    aria-pressed={playing}
                    aria-label={playing
                        ? nls.localize('vueport/macros/stopNamedMacro', 'Stop {0}', name)
                        : nls.localize('vueport/macros/playNamedMacro', 'Play {0}', name)}
                    onClick={() => macros.play(index)}
                >
                    {playing ? <Stop size={18} weight='fill' /> : <Play size={18} weight='fill' />}
                </button>}
            />
            <PanelDetailSection
                title={nls.localize('vueport/macros/timeline', 'Timeline')}
                aside={playing ? formatMacroDuration(macros.elapsed) : formatMacroDuration(macro.duration)}
            >
                {renderTimeline(macro, index)}
            </PanelDetailSection>
            <PanelDetailSection title={nls.localize('vueport/macros/playback', 'Playback')}>
                <div className='vp-detail-card'>
                    <div className='vp-detail-option'>
                        <Repeat size={18} aria-hidden='true' />
                        <span className='vp-detail-option-text'>
                            {nls.localize('vueport/macros/loop', 'Repeat')}
                            <span className='hint'>
                                {nls.localize('vueport/macros/loopHint',
                                    'Start again from the top when it ends, until it is stopped')}
                            </span>
                        </span>
                        <Switch
                            label={nls.localize('vueport/macros/loop', 'Repeat')}
                            value={macro.loop === true}
                            onChange={loop => macros.update(index, { loop })}
                        />
                    </div>
                    <div className='vp-detail-option'>
                        <Hash size={18} aria-hidden='true' />
                        <span className='vp-detail-option-text'>
                            {nls.localize('vueport/macros/slot', 'Slot')}
                            <span className='hint'>
                                {nls.localize('vueport/macros/slotHint',
                                    'Play it with the key or controller button set for this slot in the input settings')}
                            </span>
                        </span>
                        <Select
                            size='small'
                            label={nls.localize('vueport/macros/slot', 'Slot')}
                            value={String(macro.slot ?? 0)}
                            onChange={value => macros.setSlot(index, Number(value) || undefined)}
                            options={[
                                { value: '0', label: nls.localize('vueport/macros/slotNone', 'None') },
                                ...Array.from({ length: MACRO_SLOT_COUNT }, (unused, i) => {
                                    const slot = i + 1;
                                    // who has the slot now in the same file, as choosing it takes it from them
                                    const holder = macros.list.find((other, at) =>
                                        at !== index && other.slot === slot && !other.global === !macro.global);
                                    return {
                                        value: String(slot),
                                        label: holder
                                            ? nls.localize('vueport/macros/slotTaken', '{0} ({1})', slot, holder.name)
                                            : String(slot),
                                    };
                                }),
                            ]}
                        />
                    </div>
                    {/* absent rather than disabled where the host keeps no shared file, as the feature is not missing */}
                    {macros.supportsGlobal && <div className='vp-detail-option'>
                        <GlobeHemisphereWest size={18} aria-hidden='true' />
                        <span className='vp-detail-option-text'>
                            {nls.localize('vueport/macros/global', 'All Games')}
                            <span className='hint'>
                                {nls.localize('vueport/macros/globalHint',
                                    'Offer this macro in every game, not only this one. It moves out \
of this game\'s macros file and into the shared one.')}
                            </span>
                        </span>
                        <Switch
                            label={nls.localize('vueport/macros/global', 'All Games')}
                            value={macro.global === true}
                            onChange={global => setGlobal(index, global)}
                        />
                    </div>}
                </div>
            </PanelDetailSection>
            <PanelDetailSection
                title={nls.localize('vueport/macros/steps', 'Steps')}
                aside={macro.steps.length}
            >
                {renderSteps(macro)}
            </PanelDetailSection>
            <PanelDetailFooter
                hint={nls.localize('vueport/macros/recordAgain', 'Record again to change the steps.')}
            >
                <button className='vp-button secondary danger' onClick={() => removeMacro(index)}>
                    <Trash size={14} />
                    {nls.localize('vueport/macros/removeMacro', 'Remove Macro')}
                </button>
            </PanelDetailFooter>
        </div>;
    };

    // imports the emulator's own <rom>.vueport-macros.json, which is how a macro moves between installs or ROMs.
    // The picker is reset so choosing the same file twice fires again
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
            added = macros.importMacros(parseMacroFile(await file.text()));
        } catch {
            notifications.error(nls.localize('vueport/macros/importFailed',
                '{0} could not be read as a macros file.', file.name));
            return;
        }
        if (added === 0) {
            notifications.warn(nls.localize('vueport/macros/importedNone',
                'No macros were found in {0}.', file.name));
            return;
        }
        notifications.info(added === 1
            ? nls.localize('vueport/macros/importedOne', 'Imported 1 macro from {0}.', file.name)
            : nls.localize('vueport/macros/importedMany',
                'Imported {0} macros from {1}.', String(added), file.name));
    };

    const recordActions = <div className='vp-panel-actions'>
        <button
            className={recording ? 'vp-button' : 'vp-button secondary'}
            onClick={toggleRecording}
        >
            {recording
                ? <>
                    <Stop size={16} weight='fill' />
                    {nls.localize('vueport/macros/stopRecording', 'Stop')}
                    <span className='vp-macros-clock'>
                        {formatMacroDuration(macros.elapsed)}
                    </span>
                </>
                : <>
                    <Record size={16} weight='fill' />
                    {nls.localize('vueport/macros/record', 'Record')}
                </>
            }
        </button>
        {!recording &&
            <button className='vp-button secondary' onClick={() => importInput.current?.click()}>
                {nls.localize('vueport/macros/import', 'Import…')}
            </button>}
        <input
            ref={importInput}
            type='file'
            accept='.json,application/json'
            hidden
            onChange={event => importFrom(event.target.files)}
        />
    </div>;

    if (list.length === 0 && !recording) {
        return <>
            {header}
            <div className='vp-panel-empty-fill'>
                <EmptyContainer
                    title={nls.localize('vueport/macros/noMacro', 'No macros have been recorded')}
                    description={nls.localize('vueport/macros/noMacroDescription',
                        'Record a sequence of button presses, give it a name, and play it back whenever you like.')}
                    icon={<Record size={32} />}
                />
            </div>
            {recordActions}
        </>;
    }

    const editingMacro = editing === undefined ? undefined : list[editing];

    if (editingMacro !== undefined && editing !== undefined) {
        return <>
            <PanelDetailToolbar
                list={nls.localize('vueport/macros/title', 'Macros')}
                index={editing}
                count={list.length}
                onBack={() => setEditing(undefined)}
                onStep={setEditing}
            />
            <div className='vp-panel-detail vp-scroll'>
                {renderDetail(editingMacro, editing)}
            </div>
        </>;
    }

    // the index goes along, as the store is addressed by position in the whole list
    const needle = filter.trim().toLowerCase();
    const visible = list
        .map((macro, index) => ({ macro, index }))
        .filter(({ macro }) => !needle || macro.name.toLowerCase().includes(needle));

    return <>
        {header}
        <div className='vp-panel-filter'>
            <MagnifyingGlass size={15} />
            <input
                type='text'
                spellCheck={false}
                value={filter}
                placeholder={nls.localize('vueport/macros/filter', 'Filter')}
                aria-label={nls.localize('vueport/macros/filter', 'Filter')}
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
            {visible.length === 0 && !recording
                ? <p className='vp-panel-empty'>
                    {nls.localize('vueport/macros/noMatch', 'No macros match “{0}”.', filter.trim())}
                </p>
                : <ul className='vp-panel-list'>
                    {recording &&
                        // the recording shows as a row where its macro will land, as nothing else says the presses are
                        // being kept, and the panel is often the only part of the emulator in view
                        <li className='vp-panel-row vp-macros-row recording'>
                            <Record size={16} weight='fill' className='vp-macros-rec' />
                            <span className='vp-panel-row-name'>
                                {nls.localize('vueport/macros/recording', 'Recording…')}
                            </span>
                            <span className='vp-macros-meta'>
                                {formatMacroDuration(macros.elapsed)}
                            </span>
                        </li>
                    }
                    {visible.map(({ macro, index }) => {
                        const playing = macros.playingIndex === index;
                        const name = macro.name
                            || nls.localize('vueport/macros/thisMacro', 'this macro');
                        return <li
                            key={index}
                            className={'vp-panel-row vp-macros-row' + (playing ? ' playing' : '')}
                            // the whole card plays the macro, like a cheat's card switches it. The buttons inside stop
                            // the click: the pencil means something else, the play button would fire twice
                            onClick={() => macros.play(index)}
                        >
                            <button
                                type='button'
                                aria-pressed={playing}
                                aria-label={playing
                                    ? nls.localize('vueport/macros/stopNamedMacro', 'Stop {0}', name)
                                    : nls.localize('vueport/macros/playNamedMacro', 'Play {0}', name)}
                                className='vp-macros-play'
                                onClick={e => {
                                    e.stopPropagation();
                                    macros.play(index);
                                }}
                            >
                                {playing
                                    ? <Stop size={14} weight='fill' />
                                    : <Play size={14} weight='fill' />
                                }
                            </button>
                            {/* a column of its own, as the row can only push one child's controls to the far end */}
                            <span className='vp-macros-summary'>
                                <span className='vp-panel-row-name'>
                                    {macro.name}
                                    <span className='vp-macros-meta'>
                                        {playing
                                            ? formatMacroDuration(macros.elapsed)
                                            : formatMacroDuration(macro.duration)}
                                        {macro.loop && <Repeat size={14} />}
                                        {macro.slot !== undefined && <SlotBadge slot={macro.slot} />}
                                        {/* beside the repeat mark, not before the name the eye scans for */}
                                        {macro.global && <GlobeHemisphereWest
                                            className='vp-macros-global'
                                            size={14}
                                            aria-label={nls.localize(
                                                'vueport/macros/globalMacro', 'Available in every game')}
                                        />}
                                    </span>
                                </span>
                                <span
                                    className='vp-macros-sequence'
                                    // cut off rather than wrapped, so the whole line has to be reachable
                                    title={sequenceText(macro)}
                                >
                                    {renderSequence(macro)}
                                </span>
                            </span>
                            <button
                                type='button'
                                className='vp-panel-row-action'
                                aria-label={nls.localize('vueport/macros/editMacro', 'Edit {0}', name)}
                                onClick={e => {
                                    e.stopPropagation();
                                    setEditing(index);
                                }}
                            >
                                <PencilSimple size={18} />
                            </button>
                            <button
                                type='button'
                                className='vp-panel-row-action danger'
                                aria-label={nls.localize('vueport/macros/removeNamedMacro', 'Remove {0}', name)}
                                onClick={e => {
                                    e.stopPropagation();
                                    removeMacro(index);
                                }}
                            >
                                <X size={16} />
                            </button>
                        </li>;
                    })}
                </ul>}
        </div>
        {recordActions}
    </>;
}

function SlotBadge(props: { slot: number }): React.JSX.Element {
    return <span
        className='vp-macros-slot'
        title={nls.localize('vueport/macros/slotBadge', 'Slot {0}', props.slot)}
    >
        {props.slot}
    </span>;
}
