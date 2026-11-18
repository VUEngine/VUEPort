import React from 'react';
import {
    ChoiceSetting,
    DropdownSetting,
    SettingsFields,
    SettingsPaneProps,
} from './SettingFields';
import { SAVE_DATA_SETTINGS } from './settings-index';

// save states and the save folder have their own panes (SaveStateSettings, FileSettings)
export default function SaveDataSettings(props: SettingsPaneProps): React.JSX.Element {
    return (
        <div className='vp-appearance'>
            <SettingsFields {...props} ids={SAVE_DATA_SETTINGS}>
                <DropdownSetting id='saveGameSlot' />
                <ChoiceSetting id='sramInit' />
                <DropdownSetting id='sramWindow' />
            </SettingsFields>
        </div>
    );
}
