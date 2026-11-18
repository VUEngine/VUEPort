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
import { SCREENSHOT_SETTINGS } from './settings-index';

// mode and palettes of its own only while the switch deferring to the Display pane is off
function ScreenshotFields(props: SettingsPaneProps): React.JSX.Element {
    const asShown = useSetting(props.settings, 'screenshotUseDisplaySettings');
    return <SettingsFields
        {...props}
        ids={asShown
            ? ['screenshotScale', 'screenshotUseDisplaySettings']
            : SCREENSHOT_SETTINGS}
    >
        <div className='vp-appearance'>
            <SliderSetting id='screenshotScale' />
        </div>
        <SwitchSetting id='screenshotUseDisplaySettings' />
        {!asShown && <RenderingModeSetting id='screenshotRenderingMode' />}
        {!asShown && <ChoiceSetting id='screenshotFrameBlending' />}
    </SettingsFields>;
}

export default function ScreenshotSettings(props: SettingsPaneProps & {
    notifications: VueportNotifications,
}): React.JSX.Element {
    const asShown = useSetting(props.settings, 'screenshotUseDisplaySettings');
    const mode = useSetting(props.settings, 'screenshotRenderingMode');
    return <EmulatorPalettes
        settings={props.settings}
        notifications={props.notifications}
        target='screenshot'
        sections={asShown ? 'none' : mode === VbRenderingMode.ANAGLYPH ? 'anaglyph' : 'color'}
    >
        <ScreenshotFields {...props} />
    </EmulatorPalettes>;
}
