import React from 'react';
import { VueportNotifications } from '../../../common/emulator-host';
import { VbRenderingMode } from '../../../common/vb-constants';
import EmulatorPalettes from '../EmulatorPalettes';
import {
    ChoiceSetting,
    RenderingModeSetting,
    SettingsFields,
    SettingsPaneProps,
    SliderSetting,
    SwitchSetting,
    useSetting,
} from './SettingFields';
import { RECORDING_SETTINGS, VIDEO_SETTINGS } from './settings-index';

// the mode is hidden, not disabled, while the switch to use the Display pane's settings is on
function VideoFields(props: SettingsPaneProps): React.JSX.Element {
    const asShown = useSetting(props.settings, 'videoUseDisplaySettings');
    return <SettingsFields
        {...props}
        ids={asShown ? [...RECORDING_SETTINGS, 'videoUseDisplaySettings'] : VIDEO_SETTINGS}
    >
        <div className='vp-appearance'>
            <ChoiceSetting id='videoQuality' />
            <ChoiceSetting id='videoFormat' />
            <SliderSetting id='videoScale' />
        </div>
        <SwitchSetting id='videoUseDisplaySettings' />
        {!asShown && <RenderingModeSetting id='videoRenderingMode' />}
        {!asShown && <ChoiceSetting id='videoFrameBlending' />}
    </SettingsFields>;
}

export default function VideoSettings(props: SettingsPaneProps & {
    notifications: VueportNotifications,
}): React.JSX.Element {
    const asShown = useSetting(props.settings, 'videoUseDisplaySettings');
    const mode = useSetting(props.settings, 'videoRenderingMode');
    return <EmulatorPalettes
        settings={props.settings}
        notifications={props.notifications}
        target='video'
        sections={asShown ? 'none' : mode === VbRenderingMode.ANAGLYPH ? 'anaglyph' : 'color'}
    >
        <VideoFields {...props} />
    </EmulatorPalettes>;
}
