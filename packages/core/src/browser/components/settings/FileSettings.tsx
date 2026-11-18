import React from 'react';
import { ChoiceSetting, SettingsFields, SettingsPaneProps } from './SettingFields';
import { FILE_SETTINGS } from './settings-index';

// a pane of its own rather than part of Save Data, as it covers everything written beside a game
export default function FileSettings(props: SettingsPaneProps): React.JSX.Element {
    return (
        <div className='vp-appearance'>
            <SettingsFields {...props} ids={FILE_SETTINGS}>
                <ChoiceSetting id='companionFiles' />
            </SettingsFields>
        </div>
    );
}
