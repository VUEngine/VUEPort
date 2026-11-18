import React from 'react';
import { nls } from '../../../common/emulator-nls';
import {
    SettingsFields,
    SettingsPaneProps,
    SettingsSection,
    NumberChoiceSetting,
    SliderSetting,
    SwitchSetting,
    useSetting,
} from './SettingFields';
import { REWIND_SETTINGS, SPEED_SETTINGS } from './settings-index';

export default function EmulationSettings(props: SettingsPaneProps): React.JSX.Element {
    const rewinding = useSetting(props.settings, 'rewindEnabled');
    const rewindIds = rewinding ? REWIND_SETTINGS : ['rewindEnabled' as const];
    return (
        <div className='vp-appearance'>
            <SettingsFields {...props} ids={[...rewindIds, ...SPEED_SETTINGS]} gap={10}>
                <SettingsSection
                    title={nls.localize('vueport/preferences/sections/rewind', 'Rewind')}
                    ids={rewindIds}
                >
                    <SwitchSetting id='rewindEnabled' />
                    {rewinding && <>
                        <NumberChoiceSetting id='rewindGranularity' />
                        <SliderSetting id='rewindBufferSize' />
                    </>}
                </SettingsSection>
                <SettingsSection
                    title={nls.localize('vueport/preferences/sections/speed', 'Speed')}
                    ids={SPEED_SETTINGS}
                >
                    <SliderSetting id='fastForwardRatio' />
                    <SliderSetting id='slowMotionRatio' />
                </SettingsSection>
            </SettingsFields>
        </div>
    );
}
