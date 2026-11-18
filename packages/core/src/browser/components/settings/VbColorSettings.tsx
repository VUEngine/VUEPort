import React from 'react';
import {
    ChoiceSetting,
    SettingsFields,
    SettingsPaneProps,
    SwitchSetting,
    useSetting,
} from './SettingFields';
import { VB_COLOR_SETTINGS } from './settings-index';

export default function VbColorSettings(props: SettingsPaneProps): React.JSX.Element {
    const enabled = useSetting(props.settings, 'vbcSupportEnabled');
    return (
        <div className='vp-appearance'>
            <SettingsFields {...props} ids={enabled ? VB_COLOR_SETTINGS : ['vbcSupportEnabled']}>
                <SwitchSetting id='vbcSupportEnabled' />
                {enabled && <>
                    <ChoiceSetting id='hardwareMode' />
                    <SwitchSetting id='vbcAutoApplyColorPatches' />
                </>}
            </SettingsFields>
        </div>
    );
}
