import React from 'react';
import { SettingsFields, SettingsPaneProps, SwitchSetting } from './SettingFields';
import { SOUND_SETTINGS } from './settings-index';

export default function SoundSettings(props: SettingsPaneProps): React.JSX.Element {
    return (
        <div className='vp-appearance'>
            <SettingsFields {...props} ids={SOUND_SETTINGS}>
                <SwitchSetting id='errorSoundEnabled' />
                <SwitchSetting id='achievementSoundEnabled' />
            </SettingsFields>
        </div>
    );
}
