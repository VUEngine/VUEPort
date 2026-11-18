import { ArrowsOutCardinal } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../../common/emulator-nls';
import { VueportConfig, VueportSettings } from '../../../common/emulator-settings';
import { deviceCanRumble } from '../../emulator-gamepad-rumble';
import { DEFAULT_KIT_SERVICES } from '../kit/KitContext';
import { isDpad, placeControls, TOUCH_LAYOUTS } from '../touch/touch-layout';
import { TOUCH_SETTINGS } from './settings-index';
import {
    ChoiceSetting,
    SettingsFields,
    SettingsSection,
    SliderSetting,
    SwitchSetting,
    useSetting,
} from './SettingFields';

const PREVIEW_WIDTH = 300; // the landscape layout is drawn into it at this fraction of its size

// a phone on its side with the controller laid over it as the settings above make it: as solid as the opacity, as large
// as the size, moved where the layout editor put things. Schematic rather than the real controller, which takes presses
function TouchPreview(props: { settings: VueportSettings }): React.JSX.Element {
    const { settings } = props;
    const opacity = useSetting(settings, 'touchControlsOpacity');
    const size = useSetting(settings, 'touchControlsSize');
    const layout = useSetting(settings, 'touchControlsLayout');
    const spec = TOUCH_LAYOUTS.landscape;
    const ratio = PREVIEW_WIDTH / spec.width;
    const placed = placeControls('landscape', spec.width, spec.height, size / 100, layout);
    return <div className='vp-touch-preview' aria-hidden='true'>
        <div
            className='vp-touch-preview-phone'
            style={{ width: PREVIEW_WIDTH, height: Math.round(spec.height * ratio) }}
        >
            <span className='vp-touch-preview-screen' />
            {placed.map(control => <span
                key={control.id}
                className={'vp-touch-preview-control' + (isDpad(control.id) ? ' dpad' : '')}
                style={{
                    left: (control.cx - control.size / 2) * ratio,
                    top: (control.cy - control.size / 2) * ratio,
                    width: control.size * ratio,
                    height: control.size * ratio,
                    opacity: opacity / 100,
                }}
            />)}
        </div>
    </div>;
}

// the Input pane's Touch page: when the on-screen controller shows, how it looks and responds, and the way into its
// layout editor, which needs the game's screen and so closes the settings while it is up (onEditLayout)
export default function TouchSettings(props: {
    settings: VueportSettings,
    tabs?: React.ReactNode,
    onEditLayout: () => void, // closes the settings, as the layout editor needs the game's screen
    search?: string,
}): React.JSX.Element {
    const { settings, tabs, onEditLayout, search } = props;
    // Safari on iOS never had navigator.vibrate and Firefox removed it (silent on Android since 79, gone in 129):
    // both switches would do nothing there, so they show fixed with the reason
    const noMotor = deviceCanRumble() ? undefined : nls.localize('vueport/touch/noVibration',
        'This browser cannot vibrate the device. Chrome on Android can.');
    const readOnly = (id: keyof VueportConfig): string | undefined =>
        id === 'touchControlsVibration' || id === 'touchControlsRumble' ? noMotor : undefined;
    return <SettingsFields
        settings={settings}
        hover={DEFAULT_KIT_SERVICES.hover}
        ids={TOUCH_SETTINGS}
        search={search}
        readOnly={readOnly}
    >
        {tabs}
        <TouchPreview settings={settings} />
        <ChoiceSetting id='touchControls' />
        <SliderSetting id='touchControlsOpacity' />
        <SliderSetting id='touchControlsSize' />
        <SettingsSection
            title={nls.localize('vueport/touch/section/dpads', 'D-Pads')}
            ids={['touchControlsDiagonals', 'touchControlsSlide']}
        >
            <SwitchSetting id='touchControlsDiagonals' />
            <SwitchSetting id='touchControlsSlide' />
        </SettingsSection>
        <SettingsSection
            title={nls.localize('vueport/touch/section/feedback', 'Feedback')}
            ids={['touchControlsVibration', 'touchControlsHighlight', 'touchControlsRumble']}
        >
            <SwitchSetting id='touchControlsVibration' />
            <SwitchSetting id='touchControlsHighlight' />
            <SwitchSetting id='touchControlsRumble' />
        </SettingsSection>
        <fieldset className='vp-touch-layout-section'>
            <legend>{nls.localize('vueport/touch/section/layout', 'Layout')}</legend>
            <span className='vp-hint'>
                {nls.localize('vueport/touch/layout/description',
                    'Move buttons and resize them one by one. Portrait and landscape each have a layout of their own.')}
            </span>
            <button type='button' className='vp-button secondary' onClick={onEditLayout}>
                <ArrowsOutCardinal size={16} />
                {nls.localize('vueport/touch/layout/edit', 'Edit Layout…')}
            </button>
        </fieldset>
    </SettingsFields>;
}
