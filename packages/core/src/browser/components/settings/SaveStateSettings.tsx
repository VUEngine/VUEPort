import React from 'react';
import { nls } from '../../../common/emulator-nls';
import {
    ChoiceSetting,
    SettingsFields,
    SettingsPaneProps,
    SettingsSection,
    SliderSetting,
    SwitchSetting,
    useSetting
} from './SettingFields';

export default function SaveStateSettings(props: SettingsPaneProps): React.JSX.Element {
    // interval and count only matter while automatic states are on, the start choice only while suspending,
    // as in the rewind pane (see EmulationSettings)
    const automatic = useSetting(props.settings, 'autoSaveStatesEnabled');
    const suspending = useSetting(props.settings, 'suspendResumeEnabled');
    // what each section shows right now, so the search can drop a section whose settings all miss the query
    const automaticIds = automatic
        ? (['autoSaveStatesEnabled', 'autoSaveStateInterval', 'autoSaveStateCount'] as const)
        : (['autoSaveStatesEnabled'] as const);
    const suspendIds = suspending
        ? (['suspendResumeEnabled', 'suspendResumeStart'] as const)
        : (['suspendResumeEnabled'] as const);
    return (
        <div className='vp-appearance'>
            <SettingsFields {...props} ids={[...automaticIds, ...suspendIds]} gap={10}>
                <SettingsSection
                    title={nls.localize(
                        'vueport/preferences/sections/autoSaveStates', 'Automatic Save States')}
                    ids={automaticIds}
                >
                    <SwitchSetting id='autoSaveStatesEnabled' />
                    {automatic && <>
                        <SliderSetting id='autoSaveStateInterval' />
                        <SliderSetting id='autoSaveStateCount' />
                    </>}
                </SettingsSection>
                <SettingsSection
                    title={nls.localize(
                        'vueport/preferences/sections/suspendResume', 'Suspend and Resume')}
                    ids={suspendIds}
                >
                    <SwitchSetting id='suspendResumeEnabled' />
                    {suspending && <ChoiceSetting id='suspendResumeStart' />}
                </SettingsSection>
            </SettingsFields>
        </div>
    );
}
