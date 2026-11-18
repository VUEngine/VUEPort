import * as React from 'react';
import { X } from '@phosphor-icons/react';
import { Command } from '../../../common/emulator-command';
import { GamepadDatabase, resolveGamepadProfile } from '../../../common/emulator-gamepad-profiles';
import { nls } from '../../../common/emulator-nls';
import { VueportInputBindings, VueportSettings } from '../../../common/emulator-settings';
import {
    EMULATOR_MACRO_SLOT_COMMANDS,
    EMULATOR_TURBO_BUTTONS,
    EmulatorCommands,
    EmulatorGamePadButton,
    emulatorGamePadCommand,
    emulatorTurboCommand,
} from '../../emulator-commands';
import { connectedGamepadList, onGamepadsChanged } from '../../emulator-gamepad';
import Switch from '../kit/Switch';
import { CONTROLLER_POWER_SWITCH } from './controller-art';
import {
    BindingBody,
    BindingCard,
    BindingList,
    BindingLists,
    BindingRow,
    CancelCapture,
    CaptureRun,
    CaptureStrip,
    InputPage,
    InputSpacer,
    PadBadge,
    PadDiagrams,
    PresetPill,
    PresetRow,
    SetAllButton,
    TurboRateSlider,
    TurboTitle,
    useCaptureKeys,
} from './input-fields';
import { PAD_BUTTONS, PadDiagram, padButtonName } from './input-diagram';

// the emulator's own keys live on player one's page, as they belong to the application, not the game

const EMULATOR_COMMANDS: Command[] = [
    EmulatorCommands.INPUT_PAUSE_TOGGLE,
    EmulatorCommands.INPUT_REWIND,
    EmulatorCommands.INPUT_TOGGLE_FAST_FORWARD,
    EmulatorCommands.INPUT_TOGGLE_SLOWMOTION,
    EmulatorCommands.INPUT_FRAME_ADVANCE,
    EmulatorCommands.INPUT_SAVE_STATE,
    EmulatorCommands.INPUT_LOAD_STATE,
    EmulatorCommands.INPUT_RESET,
    EmulatorCommands.INPUT_AUDIO_MUTE,
    EmulatorCommands.INPUT_TOGGLE_LOW_POWER,
    EmulatorCommands.INPUT_FULLSCREEN,
    EmulatorCommands.INPUT_SCREENSHOT,
    EmulatorCommands.INPUT_VIDEO_RECORD,
    EmulatorCommands.INPUT_TOGGLE_CONTROLS_OVERLAY,
];

interface Preset {
    id: string; // `default` resets via VueportInputBindings.resetToDefault, the others are full layouts
    label(): string;
    keys?: Record<EmulatorGamePadButton, string>;
    // emulator keys by command id, included as both take the arrows the shipped time controls sit on; only player
    // one's page applies them
    actions?: Record<string, string>;
}

// emulator keys for a layout that takes the arrows: time controls move to the number row after save and load,
// low battery moves from W to T
const PRESET_ACTION_KEYS: Record<string, string> = {
    [EmulatorCommands.INPUT_PAUSE_TOGGLE.id]: 'Space',
    [EmulatorCommands.INPUT_RESET.id]: 'F10',
    [EmulatorCommands.INPUT_AUDIO_MUTE.id]: 'KeyQ',
    [EmulatorCommands.INPUT_TOGGLE_LOW_POWER.id]: 'KeyT',
    [EmulatorCommands.INPUT_SAVE_STATE.id]: 'Digit1',
    [EmulatorCommands.INPUT_LOAD_STATE.id]: 'Digit2',
    [EmulatorCommands.INPUT_REWIND.id]: 'Digit3',
    [EmulatorCommands.INPUT_TOGGLE_SLOWMOTION.id]: 'Digit4',
    [EmulatorCommands.INPUT_FRAME_ADVANCE.id]: 'Digit5',
    [EmulatorCommands.INPUT_TOGGLE_FAST_FORWARD.id]: 'Digit6',
    [EmulatorCommands.INPUT_FULLSCREEN.id]: 'KeyO',
    [EmulatorCommands.INPUT_TOGGLE_CONTROLS_OVERLAY.id]: 'KeyP',
    [EmulatorCommands.INPUT_SCREENSHOT.id]: 'F9',
    [EmulatorCommands.INPUT_VIDEO_RECORD.id]: 'F8',
};

const PRESETS: Preset[] = [
    {
        id: 'default',
        label: () => nls.localize('vueport/input/presets/default', 'Default'),
    },
    {
        id: 'wasd',
        label: () => nls.localize('vueport/input/presets/wasd', 'WASD'),
        // left D-pad on WASD, right one on the arrows, face buttons and triggers as shipped
        keys: {
            lUp: 'KeyW', lLeft: 'KeyA', lDown: 'KeyS', lRight: 'KeyD',
            rUp: 'ArrowUp', rLeft: 'ArrowLeft', rDown: 'ArrowDown', rRight: 'ArrowRight',
            select: 'KeyV', start: 'KeyB', b: 'KeyN', a: 'KeyM',
            lTrigger: 'KeyG', rTrigger: 'KeyH',
        },
        actions: PRESET_ACTION_KEYS,
    },
    {
        id: 'arrows',
        label: () => nls.localize('vueport/input/presets/arrows', 'Arrows'),
        // Lemur's layout: arrows for the left D-pad, IJKL for the right, ASDF for select/start/B/A, E/R for triggers
        keys: {
            lUp: 'ArrowUp', lLeft: 'ArrowLeft', lDown: 'ArrowDown', lRight: 'ArrowRight',
            rUp: 'KeyI', rLeft: 'KeyJ', rDown: 'KeyK', rRight: 'KeyL',
            select: 'KeyA', start: 'KeyS', b: 'KeyD', a: 'KeyF',
            lTrigger: 'KeyE', rTrigger: 'KeyR',
        },
        actions: PRESET_ACTION_KEYS,
    },
];

function keyCaption(bindings: VueportInputBindings, id: string, waiting: boolean): string {
    if (waiting) {
        return nls.localize('vueport/input/pressKeyShort', 'press a key…');
    }
    return bindings.label(id, false) || '—';
}

interface Capture {
    command: Command;
    button?: EmulatorGamePadButton;
    title: React.ReactNode;
    run?: CaptureRun;
    add?: boolean;
}

export interface KeyboardBindingsProps {
    settings: VueportSettings;
    bindings: VueportInputBindings;
    player: 1 | 2;
    tabs: React.ReactNode;
    // the Game Pads page's device-name database, so the pad badge uses the same name
    loadDatabase?: () => Promise<GamepadDatabase | undefined>;
    onChange?: () => void;
}

export default function KeyboardBindings(props: KeyboardBindingsProps): React.JSX.Element {
    const { settings, bindings, player, tabs, loadDatabase, onChange } = props;
    const [capture, setCapture] = React.useState<Capture | undefined>(undefined);
    // the power switch is bound to Reset
    const [hovered, setHovered] = React.useState<EmulatorGamePadButton | 'power' | undefined>(undefined);
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    const [pad, setPad] = React.useState<Gamepad | undefined>(() => connectedGamepadList()[0]);

    // the Gamepad API hides a controller until a button is pressed, so this page shows when it was seen
    React.useEffect(() => onGamepadsChanged(() => setPad(connectedGamepadList()[0])), []);

    const [database, setDatabase] = React.useState<GamepadDatabase | undefined>(undefined);
    const hasPad = pad !== undefined;
    React.useEffect(() => {
        if (!hasPad) {
            return;
        }
        let canceled = false;
        loadDatabase?.().then(
            loaded => { if (!canceled) { setDatabase(loaded); } },
            () => undefined,
        );
        return () => { canceled = true; };
    }, [loadDatabase, hasPad]);

    const padLabel = pad
        ? resolveGamepadProfile(pad, settings.get('gamepadProfiles'), database).profile.label
        : undefined;

    const sameControls = settings.get('player2SameControls');
    const configurable = player === 1 || !sameControls;

    const setSameControls = (value: boolean): void => {
        settings.set('player2SameControls', value).catch(() => undefined);
        setCapture(undefined);
        bump();
        onChange?.();
    };

    const commandForButton = (button: EmulatorGamePadButton): Command =>
        emulatorGamePadCommand(button, player);

    const captureRef = React.useRef(capture);
    captureRef.current = capture;
    const runCollected = React.useRef<Record<string, string>>({});

    const rebind = (command: Command, button: EmulatorGamePadButton | undefined, title?: React.ReactNode): void => {
        setCapture({ command, button, title: title ?? command.label });
    };

    const cancelCapture = (): void => {
        setCapture(undefined);
        runCollected.current = {};
    };

    // Escape stops the run and keeps the old bindings
    const setEveryButton = (): void => {
        runCollected.current = {};
        const [first, ...queue] = PAD_BUTTONS;
        const command = commandForButton(first);
        setCapture({
            command,
            button: first,
            title: padButtonName(first, command.label),
            run: { step: 1, total: PAD_BUTTONS.length, queue },
        });
    };

    // commands a key bound to this one may not also drive. Player two's pad clashes only with itself: its shipped
    // arrows overlap the time controls, and in its window the pad wins anyway (EmulatorInputController.processKeyEvent)
    const rivals = (commandId: string): string[] => {
        // turbo buttons are the pad's too; macro slots are player one's, like the emulator keys
        const own = [
            ...PAD_BUTTONS.map(button => commandForButton(button).id),
            ...EMULATOR_TURBO_BUTTONS.map(button => emulatorTurboCommand(button, player).id),
        ];
        const scope = player === 1
            ? [
                ...own,
                ...EMULATOR_COMMANDS.map(command => command.id),
                ...EMULATOR_MACRO_SLOT_COMMANDS.map(command => command.id),
            ]
            : own;
        return scope.filter(id => id !== commandId);
    };

    const release = async (commandId: string, code: string): Promise<void> => {
        if (bindings.unbind) {
            await Promise.resolve(bindings.unbind(commandId, code));
            return;
        }
        const rest = bindings.keyCodes(commandId).filter(other => other !== code);
        await Promise.resolve(bindings.clear(commandId));
        for (const other of rest) {
            await Promise.resolve(bindings.bind(commandId, other));
        }
    };

    // a newly bound key is removed from its other commands. Walked backwards, so a key pressed twice in one run
    // stays with the button it was pressed for last
    const claimKeys = async (commandIds: string[]): Promise<void> => {
        for (const commandId of [...commandIds].reverse()) {
            for (const code of bindings.keyCodes(commandId)) {
                for (const rival of rivals(commandId)) {
                    if (bindings.keyCodes(rival).includes(code)) {
                        await release(rival, code);
                    }
                }
            }
        }
    };

    // a host keymap can be a file (the studio writes a Theia keymap through Monaco), so a write is not done when it
    // returns; waiting also keeps writes in order, as such a host rewrites the whole keymap per command
    const applyChange = (change: () => unknown, claimed: string[] = []): void => {
        Promise.resolve(change()).then(() => claimKeys(claimed)).then(() => {
            bump();
            onChange?.();
        }, () => {
            // the host reports its own failures, the page still has to catch up with what landed
            bump();
            onChange?.();
        });
    };

    const applyPreset = (preset: Preset): void => {
        setCapture(undefined);
        // emulator keys only on player one's page, see `Preset`
        const actions = player === 1 ? EMULATOR_COMMANDS.map(command => command.id) : [];
        const commandIds = [...PAD_BUTTONS.map(button => commandForButton(button).id), ...actions];
        applyChange(async () => {
            if (!preset.keys) {
                for (const commandId of commandIds) {
                    await Promise.resolve(bindings.resetToDefault(commandId));
                }
                return;
            }
            const codes: Record<string, string> = {};
            for (const button of PAD_BUTTONS) {
                codes[commandForButton(button).id] = preset.keys[button];
            }
            for (const commandId of actions) {
                const code = preset.actions?.[commandId];
                if (code) {
                    codes[commandId] = code;
                }
            }
            await Promise.resolve(bindings.replaceAll(codes));
        }, commandIds);
    };

    useCaptureKeys(capture !== undefined, event => {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
            cancelCapture();
            return;
        }
        // a bare modifier means the user is still reaching for the real key
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
            return;
        }
        const current = captureRef.current;
        if (!current) {
            return;
        }
        const code = event.code;
        if (!current.run) {
            setCapture(undefined);
            // replaces by default, as on the Game Pads page; adding needs the explicit Add Another
            applyChange(() => current.add
                ? bindings.bind(current.command.id, code)
                : bindings.replaceAll({ [current.command.id]: code }),
            [current.command.id]);
            return;
        }
        const { step, total, queue } = current.run;
        const collected = { ...runCollected.current, [current.command.id]: code };
        runCollected.current = collected;
        const [next, ...rest] = queue;
        if (!next) {
            runCollected.current = {};
            setCapture(undefined);
            applyChange(() => bindings.replaceAll(collected), Object.keys(collected));
            return;
        }
        const nextCommand = commandForButton(next);
        setCapture({
            command: nextCommand,
            button: next,
            title: padButtonName(next, nextCommand.label),
            run: { step: step + 1, total, queue: rest },
        });
    });

    const isLit = (button: EmulatorGamePadButton, commandId: string): boolean =>
        hovered === button || (capture?.command.id === commandId);

    const isWaiting = (commandId: string): boolean => capture?.command.id === commandId;

    const row = (command: Command, button?: EmulatorGamePadButton, turbo = false): React.JSX.Element => {
        // Reset has no pad button, so its row lights the power switch. A turbo row lights its plain button
        const onPicture: EmulatorGamePadButton | 'power' | undefined =
            button ?? (command.id === EmulatorCommands.INPUT_RESET.id ? 'power' : undefined);
        const waiting = isWaiting(command.id);
        const name = button !== undefined
            ? padButtonName(button, (turbo ? commandForButton(button) : command).label)
            : command.label;
        return <BindingRow
            key={command.id}
            name={name}
            value={keyCaption(bindings, command.id, waiting)}
            lit={onPicture !== undefined && (hovered === onPicture || waiting)}
            waiting={waiting}
            onClick={() => rebind(command, button, button !== undefined
                ? (turbo ? <TurboTitle name={name} /> : name)
                : undefined)}
            onHoverIn={() => onPicture && setHovered(onPicture)}
            onHoverOut={() => onPicture && setHovered(undefined)}
        />;
    };

    // the VB has no reset button, its power switch is the reset, so it is the Reset command's target. On player
    // two's page it is just decoration
    const powerSwitch = (): React.JSX.Element => {
        if (player !== 1) {
            return <g className='vp-input-art'>{CONTROLLER_POWER_SWITCH}</g>;
        }
        const command = EmulatorCommands.INPUT_RESET;
        const waiting = isWaiting(command.id);
        const lit = hovered === 'power' || capture?.command.id === command.id;
        return <g
            className={'vp-input-control vp-input-power'
                + (lit ? ' is-lit' : '')
                + (waiting ? ' is-waiting' : '')}
            onClick={() => rebind(command, undefined)}
            onMouseEnter={() => setHovered('power')}
            onMouseLeave={() => setHovered(undefined)}
        >
            <g className='vp-input-control-shape'>{CONTROLLER_POWER_SWITCH}</g>
            <text className='vp-input-control-key' x={125} y={52} textAnchor='middle'>
                {keyCaption(bindings, command.id, waiting)}
            </text>
            <circle className='vp-input-control-hit' cx={125} cy={36} r={13} />
        </g>;
    };

    const diagram = (face: 'front' | 'back'): React.JSX.Element =>
        <PadDiagram
            face={face}
            caption={button =>
                keyCaption(bindings, commandForButton(button).id, isWaiting(commandForButton(button).id))}
            isLit={button => isLit(button, commandForButton(button).id)}
            isWaiting={button => isWaiting(commandForButton(button).id)}
            onSelect={button => {
                const command = commandForButton(button);
                rebind(command, button, padButtonName(button, command.label));
            }}
            onHover={setHovered}
            powerSwitch={powerSwitch()}
        />;

    const mapped = capture ? bindings.label(capture.command.id, false) : '';
    const sameLabel = nls.localize('vueport/input/sameAsPlayer1', 'Same as Player 1');

    return <InputPage top={<>
        {tabs}
        {padLabel && <PadBadge label={padLabel} title={pad?.id} />}
        <InputSpacer />
    </>}>
        {player === 2 &&
            <span className='vp-input-same'>
                <Switch label={sameLabel} value={sameControls} onChange={setSameControls} />
                {sameLabel}
            </span>
        }
        {configurable &&
            <BindingBody>
                <BindingCard>
                    <PadDiagrams>
                        {diagram('front')}
                        {diagram('back')}
                    </PadDiagrams>
                    {capture &&
                        <CaptureStrip
                            title={capture.title}
                            run={capture.run}
                            prompt={capture.add
                                ? nls.localize('vueport/input/pressAnotherKey',
                                    'Press another key to add it, or Escape to cancel.')
                                : nls.localize('vueport/input/pressKey', 'Press the key to bind, or Escape to cancel.')}
                            detail={capture.run
                                ? <p className='vp-input-capture-note'>
                                    {nls.localize(
                                        'vueport/input/captureAllNote',
                                        'Nothing is saved until every button is set.'
                                    )}
                                </p>
                                : <p className='vp-input-capture-current'>
                                    {!mapped
                                        ? nls.localize('vueport/input/currentlyUnmapped', 'Currently not mapped to any key.')
                                        : bindings.unbind && bindings.keyLabel
                                            ? <>
                                                {nls.localize('vueport/input/currentlyMappedTo', 'Currently mapped to:')}
                                                {/* one removable chip per key, as Clear All is too blunt to drop one */}
                                                {bindings.keyCodes(capture.command.id).map(code =>
                                                    <button
                                                        key={code}
                                                        type='button'
                                                        className='vp-input-source-chip'
                                                        title={nls.localize('vueport/input/gamePads/removeSource', 'Remove')}
                                                        onClick={() => applyChange(
                                                            () => bindings.unbind?.(capture.command.id, code))}
                                                    >
                                                        {bindings.keyLabel?.(code) ?? code}
                                                        <X size={11} />
                                                    </button>)}
                                            </>
                                            : <>{nls.localize('vueport/input/currentlyMappedTo', 'Currently mapped to:')} <b>{mapped}</b></>}
                                </p>}
                            actions={capture.run
                                ? <CancelCapture onClick={cancelCapture} />
                                : <>
                                    <CancelCapture onClick={cancelCapture} />
                                    {!capture.add && mapped &&
                                        <button
                                            type='button'
                                            className='vp-button secondary'
                                            onClick={() => setCapture({ ...capture, add: true })}
                                        >
                                            {nls.localize('vueport/input/gamePads/addAnother', 'Add another')}
                                        </button>}
                                    <button
                                        type='button'
                                        className='vp-button secondary'
                                        onClick={() => applyChange(
                                            () => bindings.resetToDefault(capture.command.id),
                                            [capture.command.id]
                                        )}
                                    >
                                        {nls.localize('vueport/input/resetToDefault', 'Reset to Default')}
                                    </button>
                                    <button
                                        type='button'
                                        className='vp-button secondary'
                                        disabled={!mapped}
                                        onClick={() => applyChange(
                                            () => bindings.clear(capture.command.id)
                                        )}
                                    >
                                        {nls.localize('vueport/input/clearAllMappings', 'Clear All Mappings')}
                                    </button>
                                </>}
                        />}
                    <div className='vp-preset-row'>
                        <TurboRateSlider settings={settings} onChange={onChange} />
                    </div>
                    <PresetRow trailing={
                        <SetAllButton
                            label={nls.localize('vueport/input/setAll', 'Set all buttons…')}
                            onClick={setEveryButton}
                        />
                    }>
                        {PRESETS.map(preset =>
                            <PresetPill
                                key={preset.id}
                                label={preset.label()}
                                onClick={() => applyPreset(preset)}
                            />)}
                    </PresetRow>
                </BindingCard>

                <BindingLists>
                    <BindingList title={nls.localize('vueport/input/gamePad', 'Game pad')}>
                        {PAD_BUTTONS.map(button => row(commandForButton(button), button))}
                    </BindingList>
                    <BindingList title={nls.localize('vueport/input/turbo/title', 'Turbo')}>
                        {EMULATOR_TURBO_BUTTONS.map(button => row(emulatorTurboCommand(button, player), button, true))}
                    </BindingList>
                    {player === 1 &&
                        <BindingList title={nls.localize('vueport/input/emulator', 'Emulator')}>
                            {EMULATOR_COMMANDS.map(command => row(command))}
                        </BindingList>}
                    {player === 1 &&
                        <BindingList title={nls.localize('vueport/input/macros', 'Macros')}>
                            {EMULATOR_MACRO_SLOT_COMMANDS.map(command => row(command))}
                        </BindingList>}
                </BindingLists>
            </BindingBody>}
    </InputPage>;
}
