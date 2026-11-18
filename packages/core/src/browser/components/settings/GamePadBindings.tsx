/**
 * The Game Pads page of the input settings. A page of its own, as a pad mapping belongs to the device: a controller
 * keeps its layout whichever player holds it, and which player it drives is one small control here (the reasons for
 * per-device mappings are in emulator-gamepad-profiles.ts). The picture is the keyboard pages' one (input-diagram.tsx),
 * captioned with the pad's buttons, and lights up live while a control is held.
 */

import { GameController, Warning, X } from '@phosphor-icons/react';
import * as React from 'react';
import {
    DEFAULT_GAMEPAD_DEAD_ZONE,
    GAMEPAD_DEAD_ZONE_RANGE,
    GamepadDatabase,
    GamepadFamily,
    GamepadHatDirection,
    GamepadPadAction,
    GamepadProfile,
    GamepadProfileFile,
    GamepadSource,
    GamepadUiAction,
    assignGamepadAction,
    assignGamepadButton,
    assignGamepadTurbo,
    clearGamepadAction,
    clearGamepadButton,
    clearGamepadTurbo,
    forgetGamepadProfile,
    gamepadMacroAction,
    gamepadMacroSlot,
    gamepadPreset,
    gamepadProfileFile,
    gamepadProfileMatchesPreset,
    gamepadSourceId,
    parseGamepadSource,
    removeGamepadSource,
    ResolvedGamepadProfile,
    resolveGamepadProfile,
    storeGamepadProfile,
} from '../../../common/emulator-gamepad-profiles';
import { VueportNotifications } from '../../../common/emulator-host';
import { nls } from '../../../common/emulator-nls';
import { VUEPORT_DEFAULTS, VueportSettings } from '../../../common/emulator-settings';
import {
    EmulatorCommands,
    EmulatorGamePadButton,
    EMULATOR_ACTION_COMMANDS,
    EMULATOR_MACRO_SLOT_COMMANDS,
    EMULATOR_MACRO_SLOTS,
    EMULATOR_TURBO_BUTTONS,
} from '../../emulator-commands';
import { gamepadCanRumble } from '../../emulator-gamepad-rumble';
import {
    connectedGamepadList,
    onGamepadsChanged,
    readPressedSources,
} from '../../emulator-gamepad';
import { EmulatorAction } from '../../emulator-types';
import EmptyContainer from '../kit/EmptyContainer';
import RadioSelect from '../kit/RadioSelect';
import Select from '../kit/Select';
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
    SetAllButton,
    TurboRateSlider,
    TurboTitle,
    useCaptureKeys,
} from './input-fields';
import { PAD_BUTTONS, PadDiagram, padButtonName } from './input-diagram';

// only a subset of the keyboard's actions, as a pad's buttons are mostly taken by the game; debugging ones (frame
// advance among them) stay on the keyboard
const PAD_ACTIONS: EmulatorAction[] = [
    EmulatorAction.PauseToggle,
    EmulatorAction.Rewind,
    EmulatorAction.ToggleFastForward,
    EmulatorAction.ToggleSlowmotion,
    EmulatorAction.SaveState,
    EmulatorAction.LoadState,
    EmulatorAction.Reset,
    EmulatorAction.AudioMute,
    EmulatorAction.Fullscreen,
    EmulatorAction.Screenshot,
];

// by standard-layout index. The VB's A is the rightmost face button, standard button 1, printed "B" on Xbox, "○" on
// PlayStation and "A" on Nintendo pads, so the glyph comes from the detected family; unknown ones show the index
const FACE_GLYPHS: Record<GamepadFamily, Record<number, string> | undefined> = {
    xbox: { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'View', 9: 'Menu', 10: 'LS', 11: 'RS', 16: 'Xbox' },
    playstation: { 0: '✕', 1: '○', 2: '□', 3: '△', 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2', 8: 'Share', 9: 'Options', 10: 'L3', 11: 'R3', 16: 'PS' },
    nintendo: { 0: 'B', 1: 'A', 2: 'Y', 3: 'X', 4: 'L', 5: 'R', 6: 'ZL', 7: 'ZR', 8: '−', 9: '+', 10: 'LS', 11: 'RS', 16: 'Home' },
    generic: undefined,
};

const DPAD_GLYPHS: Record<number, string> = { 12: '↑', 13: '↓', 14: '←', 15: '→' };

const AXIS_NAMES: Record<number, string> = {
    0: 'LS', 1: 'LS', 2: 'RS', 3: 'RS',
};

const HAT_GLYPHS: Record<GamepadHatDirection, string> = { up: '↑', down: '↓', left: '←', right: '→' };

// only a pad the browser has normalized gets a real name, as only there an index means the same on every pad;
// others get the raw index
function sourceLabel(
    source: GamepadSource,
    family: GamepadFamily,
    standard: boolean,
    compact = false,
    labels?: Record<string, string>,
): string {
    const own = labels?.[gamepadSourceId(source)]; // the device's own profile wins over any family's guess
    if (own) {
        return own;
    }
    if (source.kind === 'hat') {
        return compact ? `D${HAT_GLYPHS[source.direction]}` : `D-Pad ${HAT_GLYPHS[source.direction]}`;
    }
    if (source.kind === 'axis') {
        if (standard && AXIS_NAMES[source.index]) {
            const vertical = source.index % 2 === 1;
            const arrow = vertical
                ? (source.direction < 0 ? '↑' : '↓')
                : (source.direction < 0 ? '←' : '→');
            return `${AXIS_NAMES[source.index]}${arrow}`;
        }
        return compact
            ? `${source.index}${source.direction < 0 ? '−' : '+'}`
            : `Axis ${source.index}${source.direction < 0 ? '−' : '+'}`;
    }
    if (standard) {
        if (DPAD_GLYPHS[source.index]) {
            // the captions on the picture sit in gaps that fit about four characters
            return compact
                ? `D${DPAD_GLYPHS[source.index]}`
                : `D-Pad ${DPAD_GLYPHS[source.index]}`;
        }
        const glyph = FACE_GLYPHS[family]?.[source.index];
        if (glyph) {
            return glyph;
        }
        // every family has the middle button, whatever it is printed with
        if (source.index === 16) {
            return 'Home';
        }
    }
    return `${source.index}`;
}

function sourcesLabel(
    sources: GamepadSource[] | undefined,
    family: GamepadFamily,
    standard: boolean,
    labels?: Record<string, string>,
): string {
    if (!sources || sources.length === 0) {
        return '—';
    }
    return sources.map(source => sourceLabel(source, family, standard, false, labels)).join(' / ');
}

// first source only, abbreviated, as captions sit in gaps sized for a key name ("F10"); the list spells out all
function captionLabel(
    sources: GamepadSource[] | undefined,
    family: GamepadFamily,
    standard: boolean,
    labels?: Record<string, string>,
): string {
    return sources?.[0] ? sourceLabel(sources[0], family, standard, true, labels) : '—';
}

interface PadTarget {
    button?: EmulatorGamePadButton;
    turbo?: EmulatorGamePadButton;
    action?: GamepadPadAction;
}

interface PadCapture extends PadTarget {
    title: React.ReactNode;
    run?: CaptureRun;
    add?: boolean;
}

function sameTarget(a: PadTarget, b: PadTarget): boolean {
    return a.button === b.button && a.turbo === b.turbo && a.action === b.action;
}

export interface GamePadBindingsProps {
    settings: VueportSettings;
    notifications: VueportNotifications; // asks before a reset throws away the user's own mapping
    tabs: React.ReactNode;
    // device-name database (see scripts/fetch-controller-db.mjs); without it a pad falls back to the name in its id
    loadDatabase?: () => Promise<GamepadDatabase | undefined>;
    onChange?: () => void;
    exportFile?: (name: string, data: Uint8Array) => Promise<void>; // without it there is no Export button
    // submits a profile with the user's note for shipping with VUEPort; throws with a message to show on failure.
    // Without it there is no Share button
    shareProfile?: (file: GamepadProfileFile, note: string) => Promise<'received' | 'duplicate'>;
    // host actions a pad control can be bound to, such as the command palette. When absent none are offered, but a
    // preset's binding for one is still kept
    uiActions?: readonly GamepadUiAction[];
}

export default function GamePadBindings(props: GamePadBindingsProps): React.JSX.Element {
    const { settings, notifications, tabs, loadDatabase, onChange, exportFile, shareProfile, uiActions } = props;

    const [database, setDatabase] = React.useState<GamepadDatabase | undefined>(undefined);
    React.useEffect(() => {
        let canceled = false;
        // not worth reporting, the page works without it, only with less friendly names
        loadDatabase?.().then(
            loaded => { if (!canceled) { setDatabase(loaded); } },
            () => undefined,
        );
        return () => { canceled = true; };
    }, [loadDatabase]);

    // a Gamepad API slot rather than a device key, as two pads of the same model share a key but must still be
    // selectable on their own
    const [selected, setSelected] = React.useState<number | undefined>(undefined);
    const [capture, setCapture] = React.useState<PadCapture | undefined>(undefined);
    const [hovered, setHovered] = React.useState<EmulatorGamePadButton | undefined>(undefined);
    const [sharing, setSharing] = React.useState<{
        note: string,
        state: 'editing' | 'sending' | 'received' | 'duplicate' | 'failed',
        error?: string,
    } | undefined>(undefined);
    const [pressed, setPressed] = React.useState<Set<string>>(() => new Set());
    const [, bump] = React.useReducer((n: number) => n + 1, 0);

    const [pads, setPads] = React.useState<Gamepad[]>(() => connectedGamepadList());
    React.useEffect(() => onGamepadsChanged(() => setPads(connectedGamepadList())), []);

    const stored = settings.get('gamepadProfiles');
    const players = settings.get('gamepadPlayers');
    const vibration = settings.get('gamepadRumbleIntensity'); // percent, 0 is off
    const standardVibration = settings.defaults?.gamepadRumbleIntensity ?? VUEPORT_DEFAULTS.gamepadRumbleIntensity;
    const vibrationLabel = nls.localize('vueport/input/gamePads/vibration', 'Vibration');

    // held as a slot, as getGamepads returns a fresh snapshot on every call
    const pad = pads.find(candidate => candidate.index === selected) ?? pads[0];

    // save writes a new array, so this recomputes on the next render
    const resolved = React.useMemo(
        () => pad ? resolveGamepadProfile(pad, stored, database) : undefined,
        [pad, stored, database],
    );
    const profile = resolved?.profile;
    const standard = pad?.mapping === 'standard';
    // the device's own control names from a bundled preset; kept through edits, as a profile keeps its preset
    const labels = gamepadPreset(profile?.preset)?.labels;
    const standardDeadZone = resolved?.preset?.deadZone ?? DEFAULT_GAMEPAD_DEAD_ZONE;

    // polls the pad in its own loop rather than the emulator's, as it runs without a game too and wants every source
    // held, not the folded VB mask
    const captureRef = React.useRef(capture);
    captureRef.current = capture;
    const profileRef = React.useRef(profile);
    profileRef.current = profile;
    const resolvedRef = React.useRef(resolved);
    resolvedRef.current = resolved;
    // a ref, as the loop is installed once per pad while bindSource closes over profiles that every save replaces;
    // a run through all buttons would otherwise land as a single button changed
    const bindRef = React.useRef<(source: GamepadSource) => void>(() => undefined);

    React.useEffect(() => {
        if (!pad) {
            return undefined;
        }
        const slot = pad.index;
        let handle = 0;
        let previous = new Set<string>();
        // axes that are hat switches. Seeded from the bindings, so a mapped d-pad held as the page opens lights up
        const hats = new Set<number>(Object.values(profileRef.current?.buttons ?? {})
            .flat()
            .filter(source => source?.kind === 'hat')
            .map(source => source!.index));
        const frame = (): void => {
            handle = requestAnimationFrame(frame);
            const live = connectedGamepadList().find(candidate => candidate.index === slot);
            if (!live) {
                return;
            }
            const held = readPressedSources(
                live, profileRef.current?.deadZone ?? DEFAULT_GAMEPAD_DEAD_ZONE, hats);
            // edges only, or a button held while the page opened would bind itself immediately
            const waiting = captureRef.current;
            if (waiting) {
                for (const id of held) {
                    if (!previous.has(id)) {
                        const source = parseGamepadSource(id);
                        if (source) {
                            bindRef.current(source);
                            break;
                        }
                    }
                }
            }
            previous = held;
            // runs sixty times a second and usually nothing is held, so skip identical sets
            setPressed(current => sameSet(current, held) ? current : held);
        };
        handle = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(handle);
        // only the slot: re-installing on every render would lose the previous frame that edge detection needs
    }, [pad?.index]);

    const save = (next: GamepadProfile): void => {
        // edited back to exactly the preset, so there is nothing of the user's own left to keep
        const preset = resolvedRef.current?.preset;
        const updated = preset && gamepadProfileMatchesPreset(next, preset)
            ? forgetGamepadProfile(stored, next.device)
            : storeGamepadProfile(stored, next);
        settings.set('gamepadProfiles', updated).catch(() => undefined);
        bump();
        onChange?.();
    };

    // the target and profile come through refs, or a run's later steps would still answer the first one's question
    const bindSource = (source: GamepadSource): void => {
        const waiting = captureRef.current;
        const current = profileRef.current;
        if (!waiting || !current) {
            return;
        }
        if (waiting.action !== undefined) {
            save(assignGamepadAction(current, waiting.action, source, waiting.add));
            setCapture(undefined);
            return;
        }
        if (waiting.turbo !== undefined) {
            save(assignGamepadTurbo(current, waiting.turbo, source, waiting.add));
            setCapture(undefined);
            return;
        }
        if (waiting.button === undefined) {
            return;
        }
        const next = assignGamepadButton(current, waiting.button, source, waiting.add);
        if (!waiting.run) {
            save(next);
            setCapture(undefined);
            return;
        }
        // unlike the keyboard's, a run saves as it goes, so an awkward later step does not lose all earlier ones
        save(next);
        const { step, total, queue } = waiting.run;
        const [nextButton, ...rest] = queue;
        if (!nextButton) {
            setCapture(undefined);
            return;
        }
        setCapture({
            button: nextButton,
            title: padButtonName(nextButton, buttonLabel(nextButton)),
            run: { step: step + 1, total, queue: rest },
        });
    };
    bindRef.current = bindSource;

    // only Escape; the bindings themselves arrive from the controller through the loop above
    useCaptureKeys(capture !== undefined, event => {
        if (event.key !== 'Escape') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        setCapture(undefined);
    });

    const buttonLabel = (button: EmulatorGamePadButton): string =>
        EMULATOR_GAMEPAD_LABELS[button]();

    const isHeld = (button: EmulatorGamePadButton): boolean =>
        (profile?.buttons[button] ?? []).some(source => pressed.has(gamepadSourceId(source)));

    const isHeldOnTurbo = (button: EmulatorGamePadButton): boolean =>
        (profile?.turbo?.[button] ?? []).some(source => pressed.has(gamepadSourceId(source)));
    const isActionHeld = (action: GamepadPadAction): boolean =>
        (profile?.actions?.[action] ?? []).some(source => pressed.has(gamepadSourceId(source)));

    const isWaitingFor = (target: PadTarget): boolean =>
        capture !== undefined && sameTarget(capture, target);

    const caption = (button: EmulatorGamePadButton): string => {
        if (isWaitingFor({ button })) {
            return nls.localize('vueport/input/gamePads/pressButton', 'press a button…');
        }
        return captionLabel(profile?.buttons[button], profile?.family ?? 'generic', standard, labels);
    };

    const setEveryButton = (): void => {
        const [first, ...queue] = PAD_BUTTONS;
        setCapture({
            button: first,
            title: padButtonName(first, buttonLabel(first)),
            run: { step: 1, total: PAD_BUTTONS.length, queue },
        });
    };

    const forget = async (): Promise<void> => {
        if (!profile) {
            return;
        }
        const toPreset = resolved?.preset !== undefined;
        const confirmed = await notifications.confirm({
            title: toPreset
                ? nls.localize('vueport/input/gamePads/resetPresetQuestion', 'Reset to Preset?')
                : nls.localize('vueport/input/gamePads/forgetQuestion', 'Forget Controller?'),
            message: nls.localize(
                'vueport/input/gamePads/resetPresetMessage',
                'All changes you made to the mapping of {0} will be lost.',
                profile.label ?? '',
            ),
            okLabel: toPreset
                ? nls.localize('vueport/input/gamePads/resetPreset', 'Reset to preset')
                : nls.localize('vueport/input/gamePads/forget', 'Forget this controller'),
        });
        if (!confirmed) {
            return;
        }
        setCapture(undefined);
        settings.set('gamepadProfiles', forgetGamepadProfile(stored, profile.device))
            .catch(() => undefined);
        bump();
        onChange?.();
    };

    const setPlayer = (value: number | undefined): void => {
        if (!profile) {
            return;
        }
        const next = { ...players };
        if (value === undefined) {
            delete next[profile.device];
        } else {
            next[profile.device] = value;
        }
        settings.set('gamepadPlayers', next).catch(() => undefined);
        bump();
        onChange?.();
    };

    // in the format bundled in src/data/gamepad-profiles/, so a recorded mapping can ship
    const exportProfile = (): void => {
        if (!profile || !pad || !exportFile) {
            return;
        }
        const file = gamepadProfileFile(profile, pad);
        const data = new TextEncoder().encode(JSON.stringify(file, undefined, 4) + '\n');
        exportFile(`${file.id}.json`, data).catch(() => undefined);
    };

    const sendProfile = (): void => {
        if (!profile || !pad || !shareProfile || !sharing) {
            return;
        }
        const note = sharing.note;
        setSharing({ note, state: 'sending' });
        shareProfile(gamepadProfileFile(profile, pad), note).then(
            outcome => setSharing({ note, state: outcome }),
            (error: unknown) => setSharing({
                note,
                state: 'failed',
                error: error instanceof Error ? error.message : String(error),
            }),
        );
    };

    const setDeadZone = (value: number): void => {
        if (profile) {
            save({ ...profile, deadZone: value });
        }
    };

    // the Gamepad API hides a pad until a button on it is pressed (the device list is a fingerprint), so "none
    // connected" really means "none used yet"
    if (!pad || !profile || !resolved) {
        return <InputPage top={tabs}>
            <div className='vp-panel-empty-fill'>
                <EmptyContainer
                    title={nls.localize('vueport/input/gamePads/none', 'No controller detected')}
                    description={nls.localize(
                        'vueport/input/gamePads/noneDescription',
                        'Connect a controller and press any button on it. Browsers keep a controller hidden from a page until it is used.',
                    )}
                    icon={<GameController size={32} />}
                />
            </div>
        </InputPage>;
    }

    const assignedPlayer = players[profile.device];
    const canRumble = gamepadCanRumble(pad);
    const boundTo: GamepadSource[] = capture === undefined
        ? []
        : (capture.action !== undefined
            ? profile.actions?.[capture.action]
            : capture.turbo !== undefined
                ? profile.turbo?.[capture.turbo]
                : profile.buttons[capture.button!]) ?? [];

    // what a stored mapping is compared against; undefined when nothing was changed
    const baseline = resolved.origin === 'stored' ? resolved.preset : undefined;
    const sourceIds = (sources: GamepadSource[] | undefined): Set<string> =>
        new Set((sources ?? []).map(gamepadSourceId));

    const row = (
        name: React.ReactNode,
        target: PadTarget,
        sources: GamepadSource[] | undefined,
        lit: boolean,
    ): React.JSX.Element => {
        const waiting = isWaitingFor(target);
        const original = target.action !== undefined
            ? baseline?.actions?.[target.action]
            : target.turbo !== undefined
                ? baseline?.turbo?.[target.turbo]
                : baseline?.buttons[target.button!];
        const changed = baseline !== undefined && !sameSet(sourceIds(sources), sourceIds(original));
        return <BindingRow
            key={target.button ?? (target.turbo !== undefined ? `turbo-${target.turbo}` : target.action)}
            name={name}
            value={waiting
                ? nls.localize('vueport/input/gamePads/pressButton', 'press a button…')
                : sourcesLabel(sources, profile.family, standard, labels)}
            lit={lit}
            waiting={waiting}
            changed={changed}
            changedTitle={changed
                ? nls.localize('vueport/input/gamePads/changedFromPreset', 'Changed from the preset: {0}',
                    sourcesLabel(original, profile.family, standard, labels))
                : undefined}
            onClick={() => setCapture({
                ...target,
                title: target.turbo !== undefined ? <TurboTitle name={name} /> : name,
            })}
            onHoverIn={() => (target.button ?? target.turbo) && setHovered(target.button ?? target.turbo)}
            onHoverOut={() => (target.button ?? target.turbo) && setHovered(undefined)}
        />;
    };

    return <InputPage top={<>
        {tabs}
        {pads.length > 1
            ? <Select
                value={String(pad.index)}
                onChange={next => {
                    setSelected(Number(next));
                    setCapture(undefined);
                }}
                options={pads.map(candidate => ({
                    value: String(candidate.index),
                    label: padName(resolveGamepadProfile(candidate, stored, database)),
                }))}
            />
            : <PadBadge label={padName(resolved)} title={pad.id} />}
        <InputSpacer />
    </>}>
        <BindingBody>
            <BindingCard>
                <PadDiagrams>
                    {(['front', 'back'] as const).map(face =>
                        <PadDiagram
                            key={face}
                            face={face}
                            caption={caption}
                            // held wins over hovered, so a pressed button shows whether it landed where intended
                            isLit={button => isHeld(button) || hovered === button
                                || isWaitingFor({ button })}
                            isWaiting={button => isWaitingFor({ button })}
                            onSelect={button => setCapture({
                                button,
                                title: padButtonName(button, buttonLabel(button)),
                            })}
                            onHover={setHovered}
                        />)}
                </PadDiagrams>
                {capture &&
                    <CaptureStrip
                        title={capture.title}
                        run={capture.run}
                        prompt={capture.add
                            ? nls.localize(
                                'vueport/input/gamePads/pressAddPrompt',
                                'Press another control to add it, or Escape to stop.',
                            )
                            : nls.localize(
                                'vueport/input/gamePads/pressPrompt',
                                'Press the control on your controller, or Escape to stop.',
                            )}
                        detail={capture.run
                            ? <p className='vp-input-capture-note'>
                                {nls.localize(
                                    'vueport/input/gamePads/runNote',
                                    'Each button is saved as you press it, so stopping keeps what you have set so far.',
                                )}
                            </p>
                            : <p className='vp-input-capture-current'>
                                {boundTo.length > 0
                                    ? <>
                                        {nls.localize('vueport/input/gamePads/currentlyOn', 'Currently on:')}
                                        {/* each removable on its own, as "Clear" is too blunt to drop just one */}
                                        {boundTo.map(source =>
                                            <button
                                                key={gamepadSourceId(source)}
                                                type='button'
                                                className='vp-input-source-chip'
                                                title={nls.localize('vueport/input/gamePads/removeSource', 'Remove')}
                                                onClick={() => save(removeGamepadSource(profile, source))}
                                            >
                                                {sourceLabel(source, profile.family, standard, false, labels)}
                                                <X size={11} />
                                            </button>)}
                                    </>
                                    : nls.localize('vueport/input/gamePads/currentlyUnmapped', 'Not mapped to anything.')}
                            </p>}
                        actions={<>
                            <CancelCapture onClick={() => setCapture(undefined)} />
                            {!capture.run && !capture.add && boundTo.length > 0 &&
                                <button
                                    type='button'
                                    className='vp-button secondary'
                                    onClick={() => setCapture({ ...capture, add: true })}
                                >
                                    {nls.localize('vueport/input/gamePads/addAnother', 'Add another')}
                                </button>}
                            {!capture.run && boundTo.length > 0 &&
                                <button
                                    type='button'
                                    className='vp-button secondary'
                                    onClick={() => {
                                        save(capture.action !== undefined
                                            ? clearGamepadAction(profile, capture.action)
                                            : capture.turbo !== undefined
                                                ? clearGamepadTurbo(profile, capture.turbo)
                                                : clearGamepadButton(profile, capture.button!));
                                        setCapture(undefined);
                                    }}
                                >
                                    {nls.localize('vueport/input/gamePads/clear', 'Clear')}
                                </button>}
                        </>}
                    />}

                <div className='vp-preset-row'>
                    <label className={'vp-gamepad-deadzone'
                        + (profile.deadZone !== standardDeadZone ? ' is-changed' : '')}>
                        {nls.localize('vueport/input/gamePads/deadZone', 'Stick dead zone')}
                        <input
                            type='range'
                            min={GAMEPAD_DEAD_ZONE_RANGE.min * 100}
                            max={GAMEPAD_DEAD_ZONE_RANGE.max * 100}
                            step={5}
                            value={Math.round(profile.deadZone * 100)}
                            onChange={event => setDeadZone(Number(event.target.value) / 100)}
                        />
                        <span className='vp-gamepad-changed' />
                        <span className='vp-gamepad-deadzone-value'>
                            {Math.round(profile.deadZone * 100)}%
                        </span>
                    </label>
                    {/* for every controller at once. A strength rather than a switch, as a pad's motors pull far harder
                        than the Rumble Pack's; 0 is off */}
                    <label
                        className={'vp-gamepad-deadzone'
                            + (canRumble ? '' : ' is-disabled')
                            + (vibration !== standardVibration ? ' is-changed' : '')}
                        title={nls.localize(
                            'vueport/input/gamePads/vibrationHint',
                            'How strongly to play a game\'s rumble effects on your controller when no Rumble Pack \
is connected; 0 is off. The Rumble Pack\'s effects are approximated: each becomes a short pulse.',
                        )}
                    >
                        {vibrationLabel}
                        <input
                            type='range'
                            min={0}
                            max={100}
                            step={5}
                            value={vibration}
                            disabled={!canRumble}
                            onChange={event => {
                                settings.set('gamepadRumbleIntensity', Number(event.target.value)).catch(() => undefined);
                                bump();
                            }}
                        />
                        <span className='vp-gamepad-changed' />
                        <span className='vp-gamepad-deadzone-value'>
                            {vibration > 0 ? `${vibration}%` : nls.localize('vueport/input/gamePads/vibrationOff', 'Off')}
                        </span>
                        {!canRumble &&
                            <span className='vp-gamepad-no-rumble' title={nls.localize(
                                'vueport/input/gamePads/noRumbleHint',
                                'The browser gives a page vibration only for controllers it knows how to drive. \
This one may have motors, but they cannot be reached from here.',
                            )}>
                                <Warning size={13} />
                                {nls.localize('vueport/input/gamePads/noRumble', 'not available for this controller')}
                            </span>}
                    </label>
                    <TurboRateSlider settings={settings} onChange={onChange} />
                </div>

                <div className='vp-preset-row'>
                    <span className='vp-gamepad-deadzone'>
                        {nls.localize('vueport/input/gamePads/drives', 'Drives')}
                    </span>
                    <RadioSelect
                        options={[
                            { value: 'auto', label: nls.localize('vueport/input/gamePads/driveAuto', 'Either player') },
                            { value: 1, label: nls.localize('vueport/input/gamePads/player1', 'Player 1') },
                            { value: 2, label: nls.localize('vueport/input/gamePads/player2', 'Player 2') },
                        ]}
                        defaultValue={assignedPlayer ?? 'auto'}
                        onChange={options => {
                            const value = options[0]?.value;
                            setPlayer(typeof value === 'number' ? value : undefined);
                        }}
                    />
                </div>

                <div className='vp-preset-row'>
                    {exportFile &&
                        <button
                            type='button'
                            className='vp-button secondary'
                            title={nls.localize(
                                'vueport/input/gamePads/exportHint',
                                'Save this controller\'s mapping as a profile file, the format VUEPort ships its controller profiles in.',
                            )}
                            onClick={exportProfile}
                        >
                            {nls.localize('vueport/input/gamePads/export', 'Export…')}
                        </button>}
                    {/* only a raw pad's recording is worth shipping: a normalized pad already gets the standard presets,
                        and a mapping of one is a preference a bundled profile would force on everyone */}
                    {shareProfile && resolved.origin === 'stored' && !standard &&
                        <button
                            type='button'
                            className='vp-button secondary'
                            onClick={() => setSharing(current => current ?? { note: '', state: 'editing' })}
                        >
                            {nls.localize('vueport/input/gamePads/share', 'Share…')}
                        </button>}
                    <span className='vp-input-spacer' />
                    {resolved.origin === 'stored' &&
                        <button type='button' className='vp-button secondary' onClick={() => { forget().catch(() => undefined); }}>
                            {resolved.preset
                                ? nls.localize('vueport/input/gamePads/resetPreset', 'Reset to preset')
                                : nls.localize('vueport/input/gamePads/forget', 'Forget this controller')}
                        </button>}
                    <SetAllButton
                        label={nls.localize('vueport/input/gamePads/setAll', 'Set all buttons…')}
                        onClick={setEveryButton}
                    />
                </div>

                {sharing && shareProfile && !standard &&
                    <div className='vp-input-capture'>
                        <div className='vp-input-capture-head'>
                            <span className='vp-input-capture-title'>
                                {nls.localize('vueport/input/gamePads/shareTitle', 'Share this mapping')}
                            </span>
                        </div>
                        <p className='vp-input-capture-prompt'>
                            {nls.localize(
                                'vueport/input/gamePads/shareExplain',
                                'Your browser does not know this controller, so everyone who has one has to map it by hand. \
Send your mapping to the VUEPort team and it can ship with VUEPort, set up for them out of the box.',
                            )}
                        </p>
                        <p className='vp-input-capture-note'>
                            {nls.localize(
                                'vueport/input/gamePads/shareWhat',
                                'What is sent: the controller\'s name and ids, how this browser and system report it, \
and what every button and action is set to — the same file Export… saves. Nothing else, and nothing that identifies you.',
                            )}
                        </p>
                        {sharing.state === 'editing' || sharing.state === 'sending' || sharing.state === 'failed'
                            ? <textarea
                                className='vp-input vp-gamepad-share-note'
                                rows={2}
                                maxLength={500}
                                placeholder={nls.localize(
                                    'vueport/input/gamePads/sharePlaceholder',
                                    'Optional: anything worth knowing — how it is connected (USB, Bluetooth), which mode it is in.',
                                )}
                                value={sharing.note}
                                disabled={sharing.state === 'sending'}
                                onChange={event => setSharing({ note: event.target.value, state: 'editing' })}
                            />
                            : <p className='vp-input-capture-current'>
                                {sharing.state === 'received'
                                    ? nls.localize('vueport/input/gamePads/shareReceived', 'Sent — thank you.')
                                    : nls.localize('vueport/input/gamePads/shareDuplicate',
                                        'This exact mapping has been sent already — thank you.')}
                            </p>}
                        {sharing.state === 'failed' &&
                            <p className='vp-input-capture-note is-warning'>
                                <Warning size={13} /> {nls.localize(
                                    'vueport/input/gamePads/shareFailed', 'Could not send it: {0}', sharing.error ?? '')}
                            </p>}
                        <div className='vp-input-capture-actions'>
                            {sharing.state === 'received' || sharing.state === 'duplicate'
                                ? <button type='button' className='vp-button secondary' onClick={() => setSharing(undefined)}>
                                    {nls.localize('vueport/input/gamePads/shareClose', 'Close')}
                                </button>
                                : <>
                                    <button
                                        type='button'
                                        className='vp-button'
                                        disabled={sharing.state === 'sending'}
                                        onClick={sendProfile}
                                    >
                                        {sharing.state === 'sending'
                                            ? nls.localize('vueport/input/gamePads/shareSending', 'Sending…')
                                            : nls.localize('vueport/input/gamePads/shareSend', 'Send')}
                                    </button>
                                    <CancelCapture onClick={() => setSharing(undefined)} />
                                </>}
                        </div>
                    </div>}
            </BindingCard>

            <BindingLists>
                <BindingList title={nls.localize('vueport/input/gamePad', 'Game pad')}>
                    {PAD_BUTTONS.map(button => row(
                        padButtonName(button, buttonLabel(button)),
                        { button },
                        profile.buttons[button],
                        isHeld(button) || hovered === button,
                    ))}
                </BindingList>
                <BindingList title={nls.localize('vueport/input/turbo/title', 'Turbo')}>
                    {EMULATOR_TURBO_BUTTONS.map(button => row(
                        padButtonName(button, buttonLabel(button)),
                        { turbo: button },
                        profile.turbo?.[button],
                        isHeldOnTurbo(button) || hovered === button,
                    ))}
                </BindingList>
                <BindingList title={nls.localize('vueport/input/emulator', 'Emulator')}>
                    {[...(uiActions ?? []), ...PAD_ACTIONS].map(action => row(
                        actionLabel(action),
                        { action },
                        profile.actions?.[action],
                        isActionHeld(action),
                    ))}
                </BindingList>
                <BindingList title={nls.localize('vueport/input/macros', 'Macros')}>
                    {EMULATOR_MACRO_SLOTS.map(gamepadMacroAction).map(action => row(
                        actionLabel(action),
                        { action },
                        profile.actions?.[action],
                        isActionHeld(action),
                    ))}
                </BindingList>
            </BindingLists>
        </BindingBody>
    </InputPage>;
}

function padName(resolved: ResolvedGamepadProfile): string | undefined {
    return resolved.origin === 'unmapped'
        ? nls.localize('vueport/input/gamePads/unknown', 'Unknown controller')
        : resolved.profile.label;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const value of a) {
        if (!b.has(value)) {
            return false;
        }
    }
    return true;
}

function actionLabel(action: GamepadPadAction): string {
    if (action === 'commandPalette') {
        return nls.localize('vueport/input/gamePads/commandPalette', 'Command Palette');
    }
    const slot = gamepadMacroSlot(action);
    if (slot !== undefined) {
        return EMULATOR_MACRO_SLOT_COMMANDS[slot - 1].label ?? action;
    }
    return EMULATOR_ACTION_COMMANDS[action as EmulatorAction].label ?? action;
}

// taken from the commands, so both pages name a button the same way. Accessors, as the host installs its
// translations after this module is imported
const EMULATOR_GAMEPAD_LABELS: Record<EmulatorGamePadButton, () => string> = {
    lUp: () => EmulatorCommands.INPUT_L_UP.label ?? '',
    lDown: () => EmulatorCommands.INPUT_L_DOWN.label ?? '',
    lLeft: () => EmulatorCommands.INPUT_L_LEFT.label ?? '',
    lRight: () => EmulatorCommands.INPUT_L_RIGHT.label ?? '',
    rUp: () => EmulatorCommands.INPUT_R_UP.label ?? '',
    rDown: () => EmulatorCommands.INPUT_R_DOWN.label ?? '',
    rLeft: () => EmulatorCommands.INPUT_R_LEFT.label ?? '',
    rRight: () => EmulatorCommands.INPUT_R_RIGHT.label ?? '',
    select: () => EmulatorCommands.INPUT_SELECT.label ?? '',
    start: () => EmulatorCommands.INPUT_START.label ?? '',
    b: () => EmulatorCommands.INPUT_B.label ?? '',
    a: () => EmulatorCommands.INPUT_A.label ?? '',
    lTrigger: () => EmulatorCommands.INPUT_L_TRIGGER.label ?? '',
    rTrigger: () => EmulatorCommands.INPUT_R_TRIGGER.label ?? '',
};
