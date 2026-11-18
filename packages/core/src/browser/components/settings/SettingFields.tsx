import React from 'react';
import styled from 'styled-components';
import { nls } from '../../../common/emulator-nls';
import { VUEPORT_DEFAULTS, VueportConfig, VueportSettings } from '../../../common/emulator-settings';
import { paletteDecorationColor, resolvePalette } from '../../emulator-types';
import { VueportSettingSchema, vueportSettingsSchema } from '../../emulator-settings-schema';
import EmulatorRenderingModeField from '../EmulatorRenderingModeField';
import ColorField from '../kit/ColorField';
import { VueportHover } from '../kit/KitContext';
import RadioSelect from '../kit/RadioSelect';
import Range from '../kit/Range';
import ResetButton from '../kit/ResetButton';
import Switch from '../kit/Switch';
import Select from '../kit/Select';
import VContainer from '../kit/VContainer';

// building blocks of a settings pane. Panes list their controls explicitly; vueportSettingsSchema only supplies
// title, description, range and choices, which the application's preferences page reads too

type SettingsOf<T> = {
    [K in keyof VueportConfig]: VueportConfig[K] extends T ? K : never
}[keyof VueportConfig];

export type BooleanSetting = SettingsOf<boolean>;
export type StringSetting = SettingsOf<string>;
export type NumberSetting = SettingsOf<number>;

export interface SettingsPaneProps {
    settings: VueportSettings;
    hover: VueportHover; // passed in, as the settings window is not inside a kit context
    // why a setting cannot be changed in this host, or undefined. Shown fixed with the reason rather than hidden,
    // so it does not look like a missing feature
    readOnly?: (id: keyof VueportConfig) => string | undefined;
    // if a setting in this pane matches every word, only matches are shown; otherwise the query was meant for
    // another pane and everything is shown
    search?: string;
}

interface SettingsScope extends SettingsPaneProps {
    shows: (id: keyof VueportConfig) => boolean;
}

const ScopeContext = React.createContext<SettingsScope | undefined>(undefined);

function useScope(): SettingsScope {
    const scope = React.useContext(ScopeContext);
    if (!scope) {
        throw new Error('A settings control has to sit inside <SettingsFields>.');
    }
    return scope;
}

export function useSetting<K extends keyof VueportConfig>(
    settings: VueportSettings,
    id: K,
): VueportConfig[K] {
    const [, redraw] = React.useReducer((version: number) => version + 1, 0);
    React.useEffect(() => {
        const listener = settings.onDidChange(changed => {
            if (changed === id) {
                redraw();
            }
        });
        return () => listener.dispose();
    }, [settings, id]);
    return settings.get(id);
}

function schemaOf(id: keyof VueportConfig): VueportSettingSchema | undefined {
    return vueportSettingsSchema()[id];
}

// the host's default where it has one, so a reset does not undo the way the application ships
function standardValue<K extends keyof VueportConfig>(
    settings: VueportSettings,
    id: K,
): VueportConfig[K] {
    return settings.defaults?.[id] ?? VUEPORT_DEFAULTS[id];
}

function haystack(schema: VueportSettingSchema): string {
    return [
        schema.title,
        schema.description,
        ...(schema.enumItemLabels ?? []),
        ...(schema.enumItemNames ?? []),
        ...(schema.enumItemDescriptions ?? []),
    ].filter(Boolean).join(' ').toLowerCase();
}

// undefined when the query matches none of them, then the pane shows in full
function matchingSettings(
    ids: readonly (keyof VueportConfig)[],
    search: string | undefined,
): Set<keyof VueportConfig> | undefined {
    const terms = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
        return undefined;
    }
    const matching = ids.filter(id => {
        const schema = schemaOf(id);
        return schema !== undefined && terms.every(term => haystack(schema).includes(term));
    });
    return matching.length > 0 ? new Set(matching) : undefined;
}

export function SettingsFields(props: SettingsPaneProps & {
    // what the pane shows right now, so a folded-away setting cannot be found by a search
    ids: readonly (keyof VueportConfig)[],
    gap?: number | string,
    children: React.ReactNode,
}): React.JSX.Element {
    const { ids, gap, children, ...pane } = props;
    const matching = matchingSettings(ids, pane.search);
    const scope: SettingsScope = { ...pane, shows: id => !matching || matching.has(id) };
    return <ScopeContext.Provider value={scope}>
        <VContainer gap={gap ?? 'var(--vp-space-x4)'}>{children}</VContainer>
    </ScopeContext.Provider>;
}

export function SettingsSection(props: {
    title: string,
    ids: readonly (keyof VueportConfig)[], // hidden when the search hides all of these
    children: React.ReactNode,
}): React.JSX.Element | null {
    const { shows } = useScope();
    if (!props.ids.some(shows)) {
        return null;
    }
    return <fieldset>
        <legend>{props.title}</legend>
        <VContainer gap={10}>{props.children}</VContainer>
    </fieldset>;
}

const Row = styled.div<{ $even?: boolean }>`
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: var(--vp-space-x4);

    /* Side by side from the left, each as wide as it needs rather than
       sharing the row out — so a short control is not pushed to the middle
       of the pane — and no wider than a readable column, which is also where
       a long description wraps. Two long descriptions would each take that
       whole column and no longer fit beside each other, so an even row shares
       the width out instead, and only stacks once the halves get narrow. */
    > * {
        flex: ${props => props.$even ? '1 1 0' : '0 1 auto'};
        max-width: 360px;
        min-width: ${props => props.$even ? '200px' : '0'};
    }
`;

export function SettingsRow(props: {
    ids: readonly (keyof VueportConfig)[], // hidden when the search hides all of these
    even?: boolean, // for settings whose descriptions are all long
    children: React.ReactNode,
}): React.JSX.Element | null {
    const { shows } = useScope();
    if (!props.ids.some(shows)) {
        return null;
    }
    return <Row $even={props.even}>{props.children}</Row>;
}

const TitleRow = styled.div`
    align-items: center;
    display: flex;
    gap: var(--vp-space);
`;

const FixedNote = styled.div`
    font-size: 0.9em;
    opacity: 0.7;
    white-space: normal;
`;

export const SettingDescription = styled.span`
    color: var(--vp-text-dim);
    white-space: normal;
`;

const Field = styled.div`
    display: flex;
    flex-direction: column;
    gap: var(--vp-space);
`;

export function Setting(props: {
    id: keyof VueportConfig,
    children: React.ReactNode,
}): React.JSX.Element | null {
    const { settings, readOnly, shows } = useScope();
    useSetting(settings, props.id); // keeps the reset button in step with the setting
    const schema = schemaOf(props.id);
    if (!schema || !shows(props.id)) {
        return null;
    }
    const fixed = readOnly?.(props.id);
    const standard = standardValue(settings, props.id);
    return <Field>
        <TitleRow>
            <span className='vp-setting-title'>{schema.title}</span>
            <ResetButton
                disabled={settings.get(props.id) === standard || fixed !== undefined}
                onReset={() => { settings.set(props.id, standard); }}
            />
        </TitleRow>
        {schema.description && <SettingDescription>{schema.description}</SettingDescription>}
        {props.children}
        {fixed && <FixedNote>{fixed}</FixedNote>}
    </Field>;
}

const SelectionName = styled.span`
    color: var(--vp-text-dim);
`;

// explains the chosen option under the control; only for settings whose schema has `enumItemDescriptions`
function SelectionNote(props: {
    schema: VueportSettingSchema,
    value: string,
}): React.JSX.Element | null {
    const index = (props.schema.enum as unknown[] | undefined)?.indexOf(props.value) ?? -1;
    const description = index < 0 ? undefined : props.schema.enumItemDescriptions?.[index];
    if (!description) {
        return null;
    }
    const name = props.schema.enumItemNames?.[index]
        ?? props.schema.enumItemLabels?.[index]
        ?? props.value;
    return <SettingDescription>
        <SelectionName>{name}</SelectionName>
        {': '}{description}
    </SettingDescription>;
}

function optionsOf(schema: VueportSettingSchema): { value: string, label: string }[] {
    return (schema.enum ?? []).map((option, index) => ({
        value: String(option),
        label: schema.enumItemLabels?.[index] ?? String(option),
    }));
}

function useControl<K extends keyof VueportConfig>(id: K): {
    schema: VueportSettingSchema,
    value: VueportConfig[K],
    disabled: boolean,
    set: (value: VueportConfig[K]) => void,
    isStandard: boolean,
    reset: () => void,
} {
    const { settings, readOnly } = useScope();
    const value = useSetting(settings, id);
    const disabled = readOnly?.(id) !== undefined;
    return {
        schema: schemaOf(id) ?? { type: 'string', title: id },
        value,
        disabled,
        set: (next): void => {
            settings.set(id, next);
        },
        isStandard: value === standardValue(settings, id),
        reset: (): void => {
            settings.set(id, standardValue(settings, id));
        },
    };
}

export function SwitchSetting(props: { id: BooleanSetting }): React.JSX.Element {
    const { schema, value, disabled, set } = useControl(props.id);
    return <Setting id={props.id}>
        <Switch
            label={schema.title}
            value={value === true}
            disabled={disabled}
            onChange={set}
        />
    </Setting>;
}

// a segmented control; past four or five choices use DropdownSetting instead
export function ChoiceSetting(props: { id: StringSetting }): React.JSX.Element {
    const { schema, value, disabled, set } = useControl(props.id);
    const { hover } = useScope();
    return <Setting id={props.id}>
        <RadioSelect
            options={optionsOf(schema)}
            defaultValue={String(value)}
            disabled={disabled}
            onChange={chosen => set(String(chosen[0].value))}
            hover={hover}
        />
        <SelectionNote schema={schema} value={String(value)} />
    </Setting>;
}

export function DropdownSetting(props: { id: StringSetting }): React.JSX.Element {
    const { schema, value, disabled, set } = useControl(props.id);
    return <Setting id={props.id}>
        <Select
            options={optionsOf(schema)}
            value={String(value)}
            disabled={disabled}
            onChange={set}
        />
        <SelectionNote schema={schema} value={String(value)} />
    </Setting>;
}

export function RenderingModeSetting(props: { id: StringSetting }): React.JSX.Element {
    const { schema, value, disabled, set } = useControl(props.id);
    return <Setting id={props.id}>
        <EmulatorRenderingModeField
            options={optionsOf(schema)}
            value={String(value)}
            disabled={disabled}
            onChange={set}
        />
        <SelectionNote schema={schema} value={String(value)} />
    </Setting>;
}

export function NumberChoiceSetting(props: { id: NumberSetting }): React.JSX.Element {
    const { schema, value, disabled, set } = useControl(props.id);
    const { hover } = useScope();
    return <Setting id={props.id}>
        <RadioSelect
            options={optionsOf(schema)}
            defaultValue={String(value)}
            disabled={disabled}
            onChange={chosen => set(Number(chosen[0].value))}
            hover={hover}
        />
    </Setting>;
}

export function SliderSetting(props: { id: NumberSetting }): React.JSX.Element {
    const { schema, value, disabled, set } = useControl(props.id);
    return <Setting id={props.id}>
        <Range
            value={Number(value)}
            min={schema.minimum ?? 0}
            max={schema.maximum ?? 100}
            step={schema.multipleOf}
            disabled={disabled}
            setValue={set}
            width='100%'
        />
    </Setting>;
}

const SubSwitch = styled.div`
    align-items: center;
    display: flex;
    gap: var(--vp-space);
`;

// while the from-palette switch is on, the well goes dim and shows the color in use rather than the last chosen one
export function DecorationColorSetting(props: {
    // VB Color hardware drives the picture, so the well shows CRAM's color rather than the palette's
    vbcHardware?: boolean,
}): React.JSX.Element {
    const { settings } = useScope();
    const color = useControl('decorationColor');
    const colorValue = String(color.value);
    const fromPalette = useControl('decorationColorFromPalette');
    // read the same way the running picture does, so it follows mode and palette together
    const renderingMode = useSetting(settings, 'renderingMode');
    const palette = useSetting(settings, 'palette');
    const customPalettes = useSetting(settings, 'customPalettes');
    const shown = fromPalette.value === true
        ? paletteDecorationColor(
            renderingMode, resolvePalette(palette, customPalettes), props.vbcHardware)
        : (/^#[0-9a-fA-F]{6}$/.test(colorValue) ? colorValue : '#000000');
    const label = nls.localize(
        'vueport/preferences/decorationColorFromPalette/label',
        'Derive from palette',
    );
    return <Setting id='decorationColor'>
        <VContainer>
            <ColorField
                value={shown}
                disabled={color.disabled || fromPalette.value === true}
                title={color.schema.title}
                onChange={color.set}
            />
            <SubSwitch>
                <Switch
                    label={label}
                    value={fromPalette.value === true}
                    disabled={fromPalette.disabled}
                    onChange={fromPalette.set}
                />
                {label}
                <ResetButton
                    disabled={fromPalette.isStandard || fromPalette.disabled}
                    onReset={fromPalette.reset}
                />
            </SubSwitch>
        </VContainer>
    </Setting>;
}
