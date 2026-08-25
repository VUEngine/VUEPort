import { nls } from '../../common/emulator-nls';
import { VUEPORT_DEFAULTS, VueportConfig, VueportSettings } from '../../common/emulator-settings';
import { VueportSettingSchema, vueportSettingsSchema } from '../emulator-settings-schema';
import React from 'react';
import styled from 'styled-components';
import HContainer from '../components/kit/HContainer';
import Input from '../components/kit/Input';
import RadioSelect from '../components/kit/RadioSelect';
import Range from '../components/kit/Range';
import VContainer from '../components/kit/VContainer';
import HoverInfo from '../components/kit/HoverInfo';
import { VueportHover } from '../components/kit/KitContext';
import InfoLabel from '../components/kit/InfoLabel';

/**
 * The settings this window offers, in the order it offers them.
 *
 * Curated rather than "everything under the Emulator category", because most
 * of that category already has somewhere better to be edited: the rendering
 * mode and scale are toolbar controls, the palettes have a window of their
 * own, player 2's controls are part of Configure Input, and the emulator
 * configs have a whole view. Repeating those here would give two places to
 * change one thing and no clue which is authoritative.
 *
 * What is left is everything the emulator reads but never let anyone set —
 * which, before this window, meant opening the application's own preferences
 * to change how the emulator behaves.
 */
/**
 * A function rather than a constant: the titles are localized, and a constant
 * built at import time would be built before the host installed its
 * localization. See `setLocalization`.
 */
const sections = (): { title: string, ids: (keyof VueportConfig)[] }[] => [
    {
        title: nls.localize('vueport/preferences/sections/rewind', 'Rewind'),
        ids: [
            // Reachable today only as a one-way prompt: pressing rewind while
            // it is off offers to turn it on, and nothing offers to turn it
            // off again.
            'rewindEnabled',
            'rewindGranularity',
            'rewindBufferSize',
        ],
    },
    {
        title: nls.localize('vueport/preferences/sections/speed', 'Speed'),
        ids: [
            'fastForwardRatio',
            'slowMotionRatio',
        ],
    },
    {
        title: nls.localize('vueport/preferences/sections/saveData', 'Save Data'),
        ids: ['sramInit'],
    },
];

/**
 * One category of settings.
 *
 * A fieldset rather than a heading and a group, because that is what this is:
 * a named set of related controls, which is the element's whole purpose and
 * what a screen reader announces when focus enters it. Styled here rather than
 * borrowing `.vueport-vip-inspector-group`, which looks the same but is
 * named for a panel this has nothing to do with.
 */
const Section = styled.fieldset`
    border: var(--theia-border-width) solid var(--theia-editorGroup-border);
    border-radius: 2px;
    display: flex;
    flex-direction: column;
    gap: var(--theia-ui-padding);
    margin: 0;
    min-width: 0;
    padding: calc(var(--theia-ui-padding) * 2);

    legend {
        opacity: 0.7;
        padding: 0 var(--theia-ui-padding);
    }
`;

/**
 * The button that puts a setting back the way it came.
 *
 * Styled down to an icon rather than using `theia-button`, because it belongs
 * to the control beside it rather than standing on its own — the same weight a
 * clear or reveal affordance inside a field has.
 */
const ResetButton = styled.button`
    background: transparent;
    border: none;
    color: var(--theia-foreground);
    cursor: pointer;
    display: flex;
    margin: 0;
    min-width: unset;
    padding: 2px;

    &:disabled {
        cursor: default;
        opacity: 0.3;
    }

    &:not(:disabled):hover {
        color: var(--theia-focusBorder);
    }
`;

/** Wide enough for the longest text any of these takes, and no wider. */
const TEXT_WIDTH = 220;

/**
 * The emulator's own settings, editable without leaving it.
 *
 * Every control is built from the preference schema rather than written out by
 * hand: the label, the description, the type, the range and the choices all
 * come from the same declaration the application's preferences page reads. A
 * preference added to the schema and listed above therefore arrives here
 * complete, and one whose bounds change cannot end up described differently in
 * two places.
 */
export default function EmulatorPreferences(props: {
    settings: VueportSettings,
    /**
     * Passed in rather than taken from the kit's context: this window is not
     * inside one, and the controls it uses want an explicit hover.
     */
    hover: VueportHover,
}): React.JSX.Element {
    const { settings, hover } = props;
    const [, setVersion] = React.useState(0);

    // Written elsewhere as well — the toolbar, the rewind prompt, another
    // window — so what is shown follows the preference rather than a local
    // copy of it.
    React.useEffect(() => {
        const listener = settings.onDidChange(() => setVersion(version => version + 1));
        return () => listener.dispose();
    }, [settings]);

    const set = <K extends keyof VueportConfig>(key: K, value: VueportConfig[K]): void => {
        settings.set(key, value);
    };

    const control = (id: keyof VueportConfig, schema: VueportSettingSchema): React.ReactNode => {
        const value = settings.get(id);

        if (schema.type === 'boolean') {
            // The tooltip sits beside the label rather than inside it: an
            // InfoLabel here would give up the wrapping `<label>`, and with it
            // the ability to toggle the setting by clicking its name.
            return <HContainer alignItems="center" gap={5}>
                <label>
                    <input
                        type="checkbox"
                        checked={value === true}
                        onChange={e => set(id, e.target.checked)}
                    />
                    {' '}
                    {schema.title}
                </label>
                {schema.description &&
                    <HoverInfo tooltip={schema.description} hover={hover} />}
            </HContainer>;
        }

        if (schema.enum) {
            const labels = (schema as { enumItemLabels?: string[] }).enumItemLabels;
            return <RadioSelect
                options={schema.enum.map((option: unknown, index: number) => ({
                    value: String(option),
                    label: labels?.[index] ?? String(option),
                }))}
                defaultValue={String(value)}
                onChange={options => set(id, options[0].value)}
                hover={hover}
            />;
        }

        // A slider beside its number, which suits every numeric setting here:
        // each is a bounded quantity where the useful question is "how far
        // along the range", not "which exact value".
        if ((schema.type === 'number' || schema.type === 'integer')
            && schema.minimum !== undefined && schema.maximum !== undefined) {
            return <Range
                value={Number(value)}
                min={schema.minimum}
                max={schema.maximum}
                step={schema.multipleOf}
                setValue={next => set(id, next)}
                width='100%'
            />;
        }

        return <Input
            value={String(value ?? '')}
            type='string'
            width={TEXT_WIDTH}
            title={schema.title}
            setValue={next => set(id, next)}
        />;
    };

    /**
     * Put a setting back to what the schema says it should be.
     *
     * Removes the stored value rather than writing the default over it: the
     * two look the same today, but only the first leaves the setting following
     * the default if the default is ever changed.
     */
    const reset = (id: keyof VueportConfig): React.ReactNode => {
        const isDefault = settings.get(id) === VUEPORT_DEFAULTS[id];
        return <ResetButton
            disabled={isDefault}
            title={isDefault
                ? undefined
                : nls.localize('vueport/general/resetToDefault', 'Reset to Default')}
            onClick={() => settings.set(id, VUEPORT_DEFAULTS[id])}
        >
            <i className="codicon codicon-discard" />
        </ResetButton>;
    };

    return <VContainer gap={10}>
        {sections().map(section => {
            const entries = section.ids
                .map(id => ({ id, schema: vueportSettingsSchema()[id] }))
                // A listed preference that is not in the schema would render
                // as an empty row and say nothing about why; skipping it keeps
                // the window honest if the two ever drift apart.
                .filter(entry => entry.schema !== undefined);
            if (entries.length === 0) {
                return undefined;
            }

            return <Section key={section.title}>
                <legend>{section.title}</legend>
                <VContainer gap={10}>
                    {entries.map(({ id, schema }) => (
                        <VContainer key={id}>
                            {schema.type === 'boolean'
                                ? <HContainer alignItems="center" gap={5}>
                                    <div style={{ flexGrow: 1, minWidth: 0 }}>
                                        {control(id, schema)}
                                    </div>
                                    {reset(id)}
                                </HContainer>
                                : <VContainer>
                                    <InfoLabel
                                        label={schema.title ?? id}
                                        tooltip={schema.description}
                                        hover={hover}
                                        style={{ flexGrow: 1, whiteSpace: 'normal' }}
                                    />
                                    <HContainer alignItems="center" gap={5}>
                                        {/* The control takes the width; the
                                            reset keeps to its icon. */}
                                        <div style={{ flexGrow: 1, minWidth: 0 }}>
                                            {control(id, schema)}
                                        </div>
                                        {reset(id)}
                                    </HContainer>
                                </VContainer>}
                        </VContainer>
                    ))}
                </VContainer>
            </Section>;
        })}
    </VContainer>;
}
