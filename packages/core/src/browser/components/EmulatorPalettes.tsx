import { ArrowLeft, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import React from 'react';
import styled from 'styled-components';
import { VueportNotifications } from '../../common/emulator-host';
import { nls } from '../../common/emulator-nls';
import { VUEPORT_DEFAULTS, VueportConfig, VueportSettings } from '../../common/emulator-settings';
import {
    VB_ANAGLYPH_PALETTES,
    VB_DEFAULT_ANAGLYPH_PALETTE_ID,
    VB_DEFAULT_PALETTE_ID,
    VB_DUBOIS_MATRICES,
    VB_PALETTE_GROUPS,
    VbAnaglyphMatrices,
    VbDuboisProfile,
    VbDuboisProfileSelection,
} from '../../common/vb-constants';
import ColorField from '../components/kit/ColorField';
import RadioSelect from '../components/kit/RadioSelect';
import ResetButton from '../components/kit/ResetButton';
import VContainer from '../components/kit/VContainer';
import Select from './kit/Select';
import {
    CUSTOM_PALETTE_PREFIX,
    CustomAnaglyphPalette,
    CustomPalette,
    emulationAnaglyphPalettes,
    emulationPalettes,
    formatColor,
    getCustomPaletteId,
    normalizeAnaglyphMatrices,
    resolvePalette,
    toVbPalette,
} from '../emulator-types';
import { SettingDescription, useSetting } from './settings/SettingFields';

const StyledPalette = styled.button<{ selected?: boolean }>`
    align-items: center;
    background-color: ${p => p.selected ? 'var(--vp-control)' : 'transparent'};
    border-color: var(--vp-control);
    border-style: solid;
    border-width: 1px;
    border-radius: var(--vp-radius-large);
    box-sizing: border-box;
    color: var(--vp-text);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    font-size: 80%;
    gap: var(--vp-space);
    height: 60px !important;
    overflow: hidden;
    padding: var(--vp-space) !important;
    width: 120px;

    &:focus,
    &:hover {
        border-color: var(--vp-accent);
    }

    /* The tile is 120px wide; a name longer than that ends in an ellipsis. */
    div {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
`;

const StyledNewPalette = styled(StyledPalette)`
    background-color: transparent;
    border: 1px solid var(--vp-control);
    color: var(--vp-control);
`;

export function PaletteSwatch(props: { colors: string[], small?: boolean }): React.JSX.Element {
    return <Swatch className={props.small ? 'small' : undefined}>
        {props.colors.map((color, level) =>
            <div key={level} style={{ backgroundColor: color }} />
        )}
    </Swatch>;
}

export function AnaglyphSwatch(props: { left: string, right: string, small?: boolean }): React.JSX.Element {
    return <Swatch className={`pair${props.small ? ' small' : ''}`}>
        <div style={{ backgroundColor: props.left }} />
        <div style={{ backgroundColor: props.right }} />
    </Swatch>;
}

const Swatch = styled.div`
    border-radius: var(--vp-radius-small);
    display: grid;
    grid-template-columns: 25% 25% 25% 25%;
    height: 100%;
    overflow: hidden;
    width: 100px;

    &.pair {
        grid-template-columns: 50% 50%;
    }

    &.small {
        width: 32px;
    }
`;

const PaletteWorkspace = styled.div`
    display: flex;
    gap: var(--vp-space-x4);
    justify-content: space-between;
    min-height: 100%;
`;

// capped so the cards and swatch grid stay readable in a wide window and the rest goes to the preview
const PaletteLayout = styled(VContainer)`
    flex: 1 1 auto;
    max-width: 1050px;
    min-width: 0;
`;

// sticky, and takes what width the row can spare (440 up to twice that). align-self rather than the default stretch,
// as a sticky box stretched to the row's full height has nowhere to travel; the height comes from the picture's own
// shape, see EmulatorScreenPreview
const PalettePreview = styled(VContainer)`
    align-self: flex-start;
    flex: 1 1 440px;
    gap: calc(var(--vp-space) * 3);
    max-width: 880px;
    min-width: 440px;
    position: sticky;
    top: 0;
`;

const PaletteList = styled.div`
    display: flex;
    flex-flow: wrap;
    gap: var(--vp-space);
`;

// a custom palette's tile and its corner button. A flex box, so the tile is stretched to the row's height as it is
// directly in the list: the swatch is a share of the tile's height
const PaletteTile = styled.div`
    display: flex;
    position: relative;
`;

// laid over the tile, as the tile is a button already and buttons cannot nest. Dimmed until hovered, so a row of
// tiles reads as colors rather than controls; has its own dark ground, as the swatch behind may be white or black
const PaletteEditButton = styled.button`
    align-items: center;
    background: rgb(0 0 0 / 55%);
    border: none;
    border-radius: var(--vp-radius);
    color: #fff;
    cursor: pointer;
    display: flex;
    opacity: 0.55;
    padding: 2px;
    position: absolute;
    right: 4px;
    top: 4px;
    transition: opacity 120ms ease;

    ${PaletteTile}:hover & {
        opacity: 0.85;
    }

    &:hover,
    &:focus-visible {
        opacity: 1;
    }

    &:focus-visible {
        outline: 1px solid var(--vp-accent);
        outline-offset: 1px;
    }
`;

const PaletteEditorColors = styled.div`
    display: flex;
    gap: var(--vp-space-x2);
`;

const MatrixEditor = styled.div`
    display: flex;
    flex-flow: wrap;
    gap: var(--vp-space-x2);
`;

const Matrix = styled.div`
    display: grid;
    gap: var(--vp-space);
    grid-template-columns: 24px repeat(3, minmax(64px, 140px));

    > span {
        align-self: center;
        color: var(--vp-text-dim);
        font-size: 85%;
        text-align: center;
    }

    input {
        box-sizing: border-box;
        min-width: 0;
        width: 100%;
    }
`;

const PaletteName = styled.div`
    flex-grow: 1;
    height: 20px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap !important;
    width: 100%;
`;

const SectionTitle = styled.div`
    align-items: center;
    display: flex;
    gap: var(--vp-space);
`;

// pills with a two-cell swatch and a name, as a pair of tints is read at a glance and there are only a handful
const PaletteChipRow = styled.div`
    display: flex;
    flex-flow: wrap;
    gap: var(--vp-space);
`;

const PaletteChip = styled.button<{ selected?: boolean }>`
    align-items: center;
    background-color: ${p => p.selected ? 'var(--vp-control)' : 'transparent'};
    border: 1px solid var(--vp-control);
    border-radius: var(--vp-radius-large);
    box-sizing: border-box;
    color: var(--vp-text);
    cursor: pointer;
    display: flex;
    font-size: 90%;
    gap: var(--vp-space);
    height: 36px;
    overflow: hidden;
    padding: var(--vp-space) var(--vp-space-x2);
    white-space: nowrap;

    &:focus,
    &:hover {
        border-color: var(--vp-accent);
    }
`;

const ChipTile = styled.div`
    display: flex;
    position: relative;

    ${PaletteChip} {
        padding-right: 26px;
    }

    &:hover ${PaletteEditButton} {
        opacity: 0.85;
    }
`;

const ChipEditButton = styled(PaletteEditButton)`
    right: 3px;
    top: 50%;
    transform: translateY(-50%);
`;

const DEFAULT_TINTS = VB_ANAGLYPH_PALETTES[VB_DEFAULT_ANAGLYPH_PALETTE_ID];
const DUBOIS_NONE: VbDuboisProfileSelection = 'none';
const DUBOIS_CUSTOM: VbDuboisProfileSelection = 'custom';
const DUBOIS_PROFILES: VbDuboisProfile[] = ['red-cyan', 'green-magenta', 'amber-blue'];
const isDuboisSelection = (value: unknown): value is VbDuboisProfileSelection =>
    value === DUBOIS_NONE || value === DUBOIS_CUSTOM
    || DUBOIS_PROFILES.includes(value as VbDuboisProfile);

// keeps the in-progress text until focus leaves, permitting values like "-" and "0." without feeding NaN to WebGL
// or rewriting the input under the cursor
function MatrixNumberInput(props: {
    value: number
    label: string
    onCommit: (value: number) => void
}): React.JSX.Element {
    const [text, setText] = React.useState(String(props.value));
    React.useEffect(() => setText(String(props.value)), [props.value]);

    const commit = () => {
        const value = Number(text);
        if (text.trim() !== '' && Number.isFinite(value)) {
            props.onCommit(value);
        } else {
            setText(String(props.value));
        }
    };

    return <input
        type='number'
        className='vp-input'
        aria-label={props.label}
        step='0.001'
        value={text}
        onChange={event => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
            if (event.key === 'Enter') {
                event.currentTarget.blur();
            }
        }}
    />;
}

const PALETTE_GROUP_LABELS = [
    () => nls.localize('vueport/palettes/groups/vb', 'VB'),
    () => nls.localize('vueport/palettes/groups/gb', 'GB'),
    () => nls.localize('vueport/palettes/groups/sgb', 'Super GB'),
];
const CUSTOM_GROUP = 'custom';

export type PaletteTarget = 'display' | 'screenshot' | 'video';

type PaletteKey = 'palette' | 'screenshotPalette' | 'videoPalette';
type AnaglyphKey = 'anaglyphPalette' | 'screenshotAnaglyphPalette' | 'videoAnaglyphPalette';

// the custom palettes are not among them, as there is one set of those, offered wherever a palette is picked
const PALETTE_TARGETS: Record<PaletteTarget, { palette: PaletteKey, anaglyph: AnaglyphKey }> = {
    display: { palette: 'palette', anaglyph: 'anaglyphPalette' },
    screenshot: { palette: 'screenshotPalette', anaglyph: 'screenshotAnaglyphPalette' },
    video: { palette: 'videoPalette', anaglyph: 'videoAnaglyphPalette' },
};

interface EmulatorPalettesProps {
    settings: VueportSettings
    notifications: VueportNotifications
    // the Display pane drives the picture's own; the Screenshots and Video panes point at their own, so a capture can
    // be composed differently from what is on screen
    target?: PaletteTarget
    // both by default, as either can apply the moment the mode changes. A pane settled on a mode asks for the one that
    // answers it (Anaglyph filters neutral gray and ignores the ramp), one with nothing to pick yet for none
    sections?: 'both' | 'color' | 'anaglyph' | 'none'
    // the running picture, framed as the pane's settings frame it, in the sticky column. Passed in, as it depends on
    // the host; without it the pickers have the window to themselves
    preview?: React.ReactNode
    // the pane's own settings, above the pickers, set aside while a custom palette is edited. A function is handed the
    // pickers to place among the settings itself (the Display pane puts them below the scale)
    children?: React.ReactNode | ((pickers: React.ReactNode) => React.ReactNode)
}

// the color ramp a single eye is drawn in and the Anaglyph mode's pair of tints. Custom entries of either are made,
// edited and thrown away here, and every choice takes effect immediately
export default function EmulatorPalettes(props: EmulatorPalettesProps): React.JSX.Element {
    const {
        settings,
        notifications,
        children,
        preview,
        target = 'display',
        sections = 'both',
    } = props;
    const { palette: paletteKey, anaglyph: anaglyphPaletteKey } = PALETTE_TARGETS[target];

    // settings.json is editable by hand, so a missing level would reach a color input as undefined; it falls back to
    // the default palette's
    const readCustomPalettes = (): CustomPalette[] =>
        settings.get('customPalettes').map(entry => ({
            name: entry.name ?? '',
            colors: toVbPalette(entry.colors ?? []).map(formatColor),
        }));

    const readCustomAnaglyphPalettes = (): CustomAnaglyphPalette[] =>
        settings.get('customAnaglyphPalettes').map(entry => ({
            name: entry.name ?? '',
            left: entry.left ?? formatColor(DEFAULT_TINTS.left),
            right: entry.right ?? formatColor(DEFAULT_TINTS.right),
            duboisProfile: isDuboisSelection(entry.duboisProfile)
                ? entry.duboisProfile : DUBOIS_NONE,
            duboisMatrices: entry.duboisMatrices
                ? normalizeAnaglyphMatrices(entry.duboisMatrices) : undefined,
        }));

    const palette = useSetting(settings, paletteKey);
    const anaglyphPalette = useSetting(settings, anaglyphPaletteKey);
    const [customPalettes, setCustomPalettes] = React.useState<CustomPalette[]>(readCustomPalettes);
    const [customAnaglyphPalettes, setCustomAnaglyphPalettes] =
        React.useState<CustomAnaglyphPalette[]>(readCustomAnaglyphPalettes);

    // a built-in group's index, or CUSTOM_GROUP. Seeded to whichever holds the palette in use, so the current choice is
    // on screen when the pane opens
    const initialGroup = (): number | string => {
        const current = settings.get(paletteKey);
        if (current.startsWith(CUSTOM_PALETTE_PREFIX)) {
            return CUSTOM_GROUP;
        }
        const found = VB_PALETTE_GROUPS.findIndex(entries => current in entries);
        return found === -1 ? 0 : found;
    };
    const [group, setGroup] = React.useState<number | string>(initialGroup);

    // which list it belongs to and its place in it. Ramps and tints each have their own editor, only one is open
    const [editing, setEditing] = React.useState<
        { kind: 'color' | 'anaglyph', index: number } | undefined
    >(undefined);

    const update = <K extends keyof VueportConfig>(key: K, value: VueportConfig[K]) =>
        settings.set(key, value);

    const select = (id: string) => update(paletteKey, id);

    const selectAnaglyph = (id: string) => update(anaglyphPaletteKey, id);

    // what the host counts as standard for a setting: its default, or the emulator's
    const standard = <K extends keyof VueportConfig>(id: K): VueportConfig[K] =>
        (settings.defaults?.[id] ?? VUEPORT_DEFAULTS[id]) as VueportConfig[K];

    const sectionTitle = (label: string, id: PaletteKey | AnaglyphKey) =>
        <SectionTitle>
            <label>{label}</label>
            <ResetButton
                disabled={settings.get(id) === standard(id)}
                onReset={() => update(id, standard(id))}
            />
        </SectionTitle>;

    const newName = (taken: { name: string }[]): string => {
        const base = nls.localize('vueport/palettes/custom', 'Custom');
        let name = base;
        let index = 1;
        while (taken.some(entry => entry.name === name)) {
            name = `${base} ${++index}`;
        }
        return name;
    };

    const addPalette = async () => {
        const name = newName(customPalettes);
        // starts from the palette in use, so a custom one is a tweak of the current picture rather than a blank slate
        const colors = resolvePalette(palette, customPalettes).map(formatColor);
        await update('customPalettes', [
            ...customPalettes,
            { name, colors },
        ]);
        select(getCustomPaletteId(name));
        setGroup(CUSTOM_GROUP);
    };

    const addAnaglyphPalette = async () => {
        const name = newName(customAnaglyphPalettes);
        await update('customAnaglyphPalettes', [
            ...customAnaglyphPalettes,
            { name, left: '#ff0000', right: '#00ffff', duboisProfile: DUBOIS_NONE },
        ]);
        selectAnaglyph(getCustomPaletteId(name));
    };

    const editPalette = async (index: number, changes: Partial<CustomPalette>, persist = true) => {
        const updated = structuredClone(customPalettes);
        const previousName = updated[index].name;
        updated[index] = { ...updated[index], ...changes };
        if (!persist) {
            setCustomPalettes(updated);
            return;
        }
        await update('customPalettes', updated);
        // a renamed palette is a new id, so a selection pointing at it follows
        if (changes.name !== undefined && palette === getCustomPaletteId(previousName)) {
            select(getCustomPaletteId(changes.name));
        }
    };

    const editPaletteColor = (index: number, level: number, color: string, persist = true) => {
        const colors = [...customPalettes[index].colors];
        colors[level] = color;
        return editPalette(index, { colors }, persist);
    };

    const editAnaglyphPalette = async (index: number, changes: Partial<CustomAnaglyphPalette>, persist = true) => {
        const updated = structuredClone(customAnaglyphPalettes);
        const previousName = updated[index].name;
        updated[index] = { ...updated[index], ...changes };
        if (!persist) {
            setCustomAnaglyphPalettes(updated);
            return;
        }
        await update('customAnaglyphPalettes', updated);
        if (changes.name !== undefined && anaglyphPalette === getCustomPaletteId(previousName)) {
            selectAnaglyph(getCustomPaletteId(changes.name));
        }
    };

    const selectDuboisProfile = (index: number, profile: VbDuboisProfileSelection) => {
        const entry = customAnaglyphPalettes[index];
        const changes: Partial<CustomAnaglyphPalette> = { duboisProfile: profile };
        if (profile === DUBOIS_CUSTOM) {
            // moving directly from a preset makes an editable copy of that calibration, otherwise keep an earlier
            // custom matrix
            const preset = DUBOIS_PROFILES.includes(entry.duboisProfile as VbDuboisProfile)
                ? VB_DUBOIS_MATRICES[entry.duboisProfile as VbDuboisProfile]
                : undefined;
            changes.duboisMatrices = normalizeAnaglyphMatrices(
                preset ? undefined : entry.duboisMatrices,
                preset,
            );
        }
        return editAnaglyphPalette(index, changes);
    };

    const editAnaglyphMatrix = (
        index: number,
        eye: keyof VbAnaglyphMatrices,
        coefficient: number,
        value: number,
    ) => {
        const matrices = normalizeAnaglyphMatrices(customAnaglyphPalettes[index].duboisMatrices);
        matrices[eye][coefficient] = value;
        return editAnaglyphPalette(index, { duboisMatrices: matrices });
    };

    const confirmRemove = async (name: string): Promise<boolean> =>
        notifications.confirm({
            title: nls.localize('vueport/palettes/removePalette', 'Remove Palette'),
            message: nls.localize(
                'vueport/palettes/areYouSureYouWantToRemove',
                'Are you sure you want to remove the palette "{0}"?',
                name
            ),
        });

    // whether it was removed, i.e. whether the question was agreed to
    const removePalette = async (index: number): Promise<boolean> => {
        const removed = customPalettes[index];
        if (!await confirmRemove(removed.name)) {
            return false;
        }
        await update(
            'customPalettes',
            customPalettes.filter((entry, i) => i !== index)
        );
        if (palette === getCustomPaletteId(removed.name)) {
            select(VB_DEFAULT_PALETTE_ID);
        }
        return true;
    };

    const removeAnaglyphPalette = async (index: number): Promise<boolean> => {
        const removed = customAnaglyphPalettes[index];
        if (!await confirmRemove(removed.name)) {
            return false;
        }
        await update(
            'customAnaglyphPalettes',
            customAnaglyphPalettes.filter((entry, i) => i !== index)
        );
        if (anaglyphPalette === getCustomPaletteId(removed.name)) {
            selectAnaglyph(VB_DEFAULT_ANAGLYPH_PALETTE_ID);
        }
        return true;
    };

    React.useEffect(() => {
        const listener = settings.onDidChange(setting => {
            if (setting === 'customPalettes') {
                setCustomPalettes(readCustomPalettes());
            } else if (setting === 'customAnaglyphPalettes') {
                setCustomAnaglyphPalettes(readCustomAnaglyphPalettes());
            }
        });
        return () => listener.dispose();
    }, [settings]);

    // the list can lose an entry underneath the view (a hand-edited settings file, or this view's own removal), and
    // forgetting the stale index puts the list back on screen
    const edited = editing !== undefined && editing.index < (
        editing.kind === 'color' ? customPalettes : customAnaglyphPalettes
    ).length ? editing : undefined;

    const backToList = <div className='vp-panel-toolbar'>
        <button
            type='button'
            className='vp-panel-back'
            aria-label={nls.localize('vueport/general/backToList', 'Back To List')}
            onClick={() => setEditing(undefined)}
        >
            <ArrowLeft size={20} />
            {nls.localize('vueport/general/backToList', 'Back To List')}
        </button>
    </div>;

    const nameField = (value: string, rename: (name: string, persist?: boolean) => void): React.ReactNode =>
        <VContainer>
            <label>{nls.localize('vueport/palettes/name', 'Name')}</label>
            <input
                type='text'
                className='vp-input'
                spellCheck={false}
                value={value}
                onBlur={e => rename(e.target.value)}
                onChange={e => rename(e.target.value, false)}
                style={{
                    maxWidth: 549
                }}
            />
        </VContainer>;

    // throwing the palette away also leaves the editor, as its index now belongs to another palette
    const removeButton = (remove: () => Promise<boolean>): React.ReactNode =>
        <div>
            <button
                className='vp-button secondary'
                onClick={async () => {
                    if (await remove()) {
                        setEditing(undefined);
                    }
                }}
            >
                <Trash size={16} />
                {nls.localize('vueport/general/remove', 'Remove')}
            </button>
        </div>;

    const renderPaletteEditor = (index: number): React.ReactNode => {
        const entry = customPalettes[index];
        return <>
            {backToList}
            {nameField(entry.name, (name, persist) => editPalette(index, { name }, persist))}
            <VContainer>
                <label>{nls.localize('vueport/palettes/colors', 'Colors')}</label>
                <PaletteEditorColors>
                    {entry.colors.map((color, level) =>
                        <ColorField
                            key={level}
                            // the Virtual Boy's four brightness levels, dark to light; the number is the level itself,
                            // as the hardware calls it
                            title={`${level}`}
                            value={color}
                            onPreview={hex => editPaletteColor(index, level, hex, false)}
                            onChange={hex => editPaletteColor(index, level, hex)}
                            large
                        />
                    )}
                </PaletteEditorColors>
            </VContainer>
            {removeButton(() => removePalette(index))}
        </>;
    };

    const renderAnaglyphEditor = (index: number): React.ReactNode => {
        const entry = customAnaglyphPalettes[index];
        const profile = entry.duboisProfile ?? DUBOIS_NONE;
        const matrices = normalizeAnaglyphMatrices(entry.duboisMatrices);
        const channels = ['R', 'G', 'B'];
        const renderMatrix = (eye: keyof VbAnaglyphMatrices, title: string) =>
            <fieldset>
                <legend>{title}</legend>
                <Matrix>
                    <span />
                    {channels.map(channel => <span key={`input-${channel}`}>{channel}</span>)}
                    {channels.map((output, row) => <React.Fragment key={`output-${output}`}>
                        <span>{output}</span>
                        {channels.map((input, column) => {
                            const coefficient = row + column * 3;
                            return <MatrixNumberInput
                                key={`${output}-${input}`}
                                value={matrices[eye][coefficient]}
                                label={nls.localize(
                                    'vueport/palettes/matrixCoefficient',
                                    '{0} matrix, {1} output from {2} input',
                                    title,
                                    output,
                                    input,
                                )}
                                onCommit={value => editAnaglyphMatrix(index, eye, coefficient, value)}
                            />;
                        })}
                    </React.Fragment>)}
                </Matrix>
            </fieldset>;
        return <>
            {backToList}
            {nameField(entry.name, (name, persist) => editAnaglyphPalette(index, { name }, persist))}
            <VContainer>
                <label>{nls.localize('vueport/palettes/colors', 'Colors')}</label>
                <PaletteEditorColors>
                    <ColorField
                        title={nls.localize('vueport/palettes/leftEyeTint', 'Tint of the left eye')}
                        value={entry.left}
                        onPreview={hex => editAnaglyphPalette(index, { left: hex }, false)}
                        onChange={hex => editAnaglyphPalette(index, { left: hex })}
                        large
                    />
                    <ColorField
                        title={nls.localize('vueport/palettes/rightEyeTint', 'Tint of the right eye')}
                        value={entry.right}
                        onPreview={hex => editAnaglyphPalette(index, { right: hex }, false)}
                        onChange={hex => editAnaglyphPalette(index, { right: hex })}
                        large
                    />
                </PaletteEditorColors>
            </VContainer>
            <VContainer>
                <label>{nls.localize('vueport/palettes/duboisProfile', 'Dubois Profile')}</label>
                <SettingDescription>
                    {profile === DUBOIS_NONE
                        ? nls.localize(
                            'vueport/palettes/channelFilterDescription',
                            'The two colors multiply the left and right images per RGB channel.')
                        : nls.localize(
                            'vueport/palettes/duboisColorDescription',
                            'Dubois composition uses the calibration matrices. The two colors identify the glasses in the palette list.')
                    }
                </SettingDescription>
                <Select
                    value={profile}
                    style={{ maxWidth: 549 }}
                    onChange={next => selectDuboisProfile(index, next as VbDuboisProfileSelection)}
                    options={[
                        {
                            value: DUBOIS_NONE,
                            label: nls.localize('vueport/palettes/noDuboisProfile', 'None'),
                        },
                        ...DUBOIS_PROFILES.map(id => ({
                            value: id,
                            label: nls.localize(
                                'vueport/palettes/builtInDuboisProfile',
                                '{0}',
                                emulationAnaglyphPalettes()[id] ?? id,
                            ),
                        })),
                        {
                            value: DUBOIS_CUSTOM,
                            label: nls.localize('vueport/palettes/customDuboisProfile', 'Custom calibration'),
                        },
                    ]}
                />
            </VContainer>
            {profile === DUBOIS_CUSTOM &&
                <VContainer>
                    <label>{nls.localize('vueport/palettes/customDuboisMatrices', 'Custom Dubois Matrices')}</label>
                    <SettingDescription>
                        {nls.localize(
                            'vueport/palettes/customDuboisMatricesHint',
                            'Rows are output R, G and B; columns are input R, G and B. Values operate on linear RGB.'
                        )}
                    </SettingDescription>
                    <MatrixEditor>
                        {renderMatrix('left', nls.localize(
                            'vueport/palettes/leftImageMatrix', 'Left Image Matrix'))}
                        {renderMatrix('right', nls.localize(
                            'vueport/palettes/rightImageMatrix', 'Right Image Matrix'))}
                    </MatrixEditor>
                    <div className='vp-preset-row'>
                        <span className='vp-preset-label'>
                            {nls.localize('vueport/palettes/presets', 'Presets')}
                        </span>
                        {DUBOIS_PROFILES.map(id => <button
                            key={id}
                            type='button'
                            className='vp-preset-pill'
                            onClick={() => editAnaglyphPalette(index, {
                                duboisMatrices: normalizeAnaglyphMatrices(undefined, VB_DUBOIS_MATRICES[id]),
                            })}
                        >
                            {emulationAnaglyphPalettes()[id] ?? id}
                        </button>)}
                    </div>
                </VContainer>}
            {removeButton(() => removeAnaglyphPalette(index))}
        </>;
    };

    const customTile = (entry: CustomPalette, index: number) => {
        const id = getCustomPaletteId(entry.name);
        return <PaletteTile key={`color-custom-${index}`}>
            <StyledPalette
                selected={palette === id}
                onClick={() => select(id)}
                onKeyDown={() => select(id)}
            >
                <PaletteSwatch colors={entry.colors} />
                <PaletteName>{entry.name}</PaletteName>
            </StyledPalette>
            <PaletteEditButton
                type='button'
                aria-label={nls.localize('vueport/palettes/editPalette', 'Edit {0}', entry.name)}
                onClick={() => setEditing({ kind: 'color', index })}
            >
                <PencilSimple size={14} />
            </PaletteEditButton>
        </PaletteTile>;
    };

    const groupOptions = [
        ...VB_PALETTE_GROUPS.map((entries, index) => ({
            value: index,
            label: (PALETTE_GROUP_LABELS[index] ?? (() => `${index}`))(),
        })),
        { value: CUSTOM_GROUP, label: nls.localize('vueport/palettes/custom', 'Custom') },
    ];

    const anaglyphSection = <VContainer gap={'var(--vp-space)'}>
        {sectionTitle(
            nls.localize('vueport/palettes/anaglyphPalette', 'Anaglyph Palette'), anaglyphPaletteKey)}
        <PaletteChipRow>
            {Object.keys(VB_ANAGLYPH_PALETTES).map(id =>
                <PaletteChip
                    key={id}
                    title={id === 'amber-blue'
                        ? nls.localize('vueport/palettes/amberBlueProfileHint', 'Dubois correction for Amber / Blue (ColorCode) glasses.')
                        : VB_ANAGLYPH_PALETTES[id].duboisProfile
                            ? nls.localize('vueport/palettes/duboisProfileHint', 'Dubois correction.')
                            : nls.localize('vueport/palettes/channelFilterHint', 'RGB channel filters (no Dubois correction).')}
                    selected={anaglyphPalette === id}
                    onClick={() => selectAnaglyph(id)}
                >
                    <AnaglyphSwatch
                        small
                        left={formatColor(VB_ANAGLYPH_PALETTES[id].left)}
                        right={formatColor(VB_ANAGLYPH_PALETTES[id].right)}
                    />
                    {emulationAnaglyphPalettes()[id] ?? id}
                </PaletteChip>
            )}
            {customAnaglyphPalettes.map((customPalette, index) => {
                const id = getCustomPaletteId(customPalette.name);
                return <ChipTile key={`anaglyph-custom-${index}`}>
                    <PaletteChip
                        selected={anaglyphPalette === id}
                        onClick={() => selectAnaglyph(id)}
                    >
                        <AnaglyphSwatch small left={customPalette.left} right={customPalette.right} />
                        {customPalette.name}
                    </PaletteChip>
                    <ChipEditButton
                        type='button'
                        aria-label={nls.localize('vueport/palettes/editPalette', 'Edit {0}', customPalette.name)}
                        onClick={() => setEditing({ kind: 'anaglyph', index })}
                    >
                        <PencilSimple size={12} />
                    </ChipEditButton>
                </ChipTile>;
            })}
            <PaletteChip onClick={addAnaglyphPalette}>
                <Plus size={14} />
                {nls.localize('vueport/palettes/newPalette', 'New Palette')}
            </PaletteChip>
        </PaletteChipRow>
    </VContainer>;

    const colorSection = <VContainer gap={'var(--vp-space)'}>
        {sectionTitle(nls.localize('vueport/palettes/colorPalette', 'Color Palette'), paletteKey)}
        <RadioSelect
            options={groupOptions}
            defaultValue={group}
            onChange={chosen => setGroup(chosen[0].value as number | string)}
        />
        {group === CUSTOM_GROUP
            ? <PaletteList>
                {customPalettes.map(customTile)}
                <StyledNewPalette onClick={addPalette}>
                    <VContainer justifyContent='center' grow={1}>
                        <Plus size={32} />
                    </VContainer>
                    <div>{nls.localize('vueport/palettes/newPalette', 'New Palette')}</div>
                </StyledNewPalette>
            </PaletteList>
            : <PaletteList>
                {Object.entries(VB_PALETTE_GROUPS[group as number] ?? {}).map(([id, colors]) =>
                    <StyledPalette
                        key={id}
                        selected={palette === id}
                        onClick={() => select(id)}
                        onKeyDown={() => select(id)}
                    >
                        <PaletteSwatch colors={colors.map(formatColor)} />
                        <PaletteName>{emulationPalettes()[id] ?? id}</PaletteName>
                    </StyledPalette>
                )}
            </PaletteList>
        }
    </VContainer>;

    const pickers = <>
        {(sections === 'both' || sections === 'anaglyph') && anaglyphSection}
        {(sections === 'both' || sections === 'color') && colorSection}
    </>;

    return <PaletteWorkspace className='vp-palette-workspace'>
        <PaletteLayout gap={'var(--vp-space-x4)'}>
            {/* an open editor takes the whole left side, the pane's own settings included */}
            {edited
                ? edited.kind === 'color'
                    ? renderPaletteEditor(edited.index)
                    : renderAnaglyphEditor(edited.index)
                : typeof children === 'function'
                    ? children(pickers)
                    : <>
                        {children}
                        {pickers}
                    </>}
        </PaletteLayout>
        {preview !== undefined &&
            <PalettePreview className='vp-palette-preview'>
                <label>
                    {nls.localize('vueport/palettes/preview/title', 'Preview')}
                </label>
                {preview}
            </PalettePreview>
        }
    </PaletteWorkspace>;
}
