import React from 'react';
import { VueportNotifications } from '../../../common/emulator-host';
import { VueportConfig } from '../../../common/emulator-settings';
import { EmulatorDecoration } from '../../emulator-types';
import { VbRenderingMode } from '../../../common/vb-constants';
import EmulatorPalettes from '../EmulatorPalettes';
import { useXrLayout } from '../xr-layout';
import {
    ChoiceSetting,
    DecorationColorSetting,
    RenderingModeSetting,
    SettingsFields,
    SettingsPaneProps,
    SettingsRow,
    SliderSetting,
    SwitchSetting,
    useSetting,
} from './SettingFields';

interface DisplayProps extends SettingsPaneProps {
    vbcHardwareActive?: boolean;
    pickers?: React.ReactNode;
}

// swap eyes and depth only for modes showing both eyes, intensity only for the halo decorations, color only for
// Ambient (Immersion takes it from the picture), spin-up delay only while the spin-up is shown. In a headset, none
// of the page-picture settings apply, as the headset shows both eyes its own way (VR settings)
function DisplayFields(props: DisplayProps & { inHeadset: boolean }): React.JSX.Element {
    const { inHeadset } = props;
    const renderingMode = useSetting(props.settings, 'renderingMode');
    const stereo = renderingMode !== VbRenderingMode.LEFT && renderingMode !== VbRenderingMode.RIGHT;
    const modeIds: (keyof VueportConfig)[] = inHeadset ? [] : ['renderingMode'];
    if (stereo && !inHeadset) {
        modeIds.push('swapEyes', 'stereoDepth');
    }
    const decoration = useSetting(props.settings, 'decoration');
    const ambient = decoration === EmulatorDecoration.AMBIENT;
    const halo = ambient || decoration === EmulatorDecoration.IMMERSION;
    const decorationIds: (keyof VueportConfig)[] = ['decoration'];
    if (halo) {
        decorationIds.push('decorationIntensity');
    }
    if (ambient) {
        decorationIds.push('decorationColor');
    }
    const spinUp = useSetting(props.settings, 'mirrorSpinUp');
    const spinUpIds: (keyof VueportConfig)[] = ['mirrorSpinUp'];
    if (spinUp) {
        spinUpIds.push('mirrorSpinUpDelay');
    }
    const pageIds: (keyof VueportConfig)[] = inHeadset ? [] : ['scale', ...decorationIds];
    return <SettingsFields {...props} ids={[...modeIds, ...pageIds, 'frameBlending', 'columnTable', ...spinUpIds]}>
        {!inHeadset && <RenderingModeSetting id='renderingMode' />}
        {stereo && !inHeadset && <SwitchSetting id='swapEyes' />}
        {stereo && !inHeadset && <SliderSetting id='stereoDepth' />}
        {!inHeadset && <ChoiceSetting id='scale' />}
        {props.pickers}
        {!inHeadset && <SettingsRow ids={decorationIds}>
            <ChoiceSetting id='decoration' />
            {halo && <SliderSetting id='decorationIntensity' />}
            {ambient && <DecorationColorSetting vbcHardware={props.vbcHardwareActive} />}
        </SettingsRow>}
        <ChoiceSetting id='frameBlending' />
        <SwitchSetting id='columnTable' />
        <SettingsRow ids={spinUpIds} even>
            <SwitchSetting id='mirrorSpinUp' />
            {spinUp && <SwitchSetting id='mirrorSpinUpDelay' />}
        </SettingsRow>
    </SettingsFields>;
}

export default function DisplaySettings(props: DisplayProps & {
    notifications: VueportNotifications,
    preview?: React.ReactNode,
}): React.JSX.Element {
    // in a headset the picture is in front of the player anyway, and the anaglyph colors are never seen
    const inHeadset = useXrLayout();
    return <EmulatorPalettes
        settings={props.settings}
        notifications={props.notifications}
        preview={inHeadset ? undefined : props.preview}
        sections={inHeadset ? 'color' : undefined}
    >
        {pickers => <DisplayFields {...props} pickers={pickers} inHeadset={inHeadset} />}
    </EmulatorPalettes>;
}
