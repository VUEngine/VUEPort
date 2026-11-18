import * as React from 'react';
import { GoogleCardboardLogo } from '@phosphor-icons/react';
import { nls } from '../../../common/emulator-nls';
import {
    XrAvailability,
    XrBackdrop,
    XrScreen,
    XR_DEFAULT_SCREEN,
    XR_MAX_DEPTH,
    XR_MAX_WIDTH,
    XR_MIN_WIDTH,
} from '../../emulator-xr';
import { xrBackdropLabel, XR_BACKDROPS } from '../../emulator-xr-storage';
import RadioSelect from '../kit/RadioSelect';
import Range from '../kit/Range';
import ResetButton from '../kit/ResetButton';

export default function XrSettings(props: {
    availability: XrAvailability | undefined,
    screen: XrScreen,
    backdrop: XrBackdrop,
    onScreen: (screen: XrScreen) => void,
    onBackdrop: (backdrop: XrBackdrop) => void,
}): React.JSX.Element {
    const { screen, backdrop } = props;

    return <div className='vp-appearance'>
        {props.availability !== undefined && <XrStatus availability={props.availability} />}

        <div className='vp-bool-setting vp-range-setting'>
            <div className='vp-bool-title'>
                <span>{nls.localize('vueport/xr/settings/width', 'Screen Size')}</span>
                <ResetButton
                    disabled={screen.width === XR_DEFAULT_SCREEN.width}
                    onReset={() => props.onScreen({ ...screen, width: XR_DEFAULT_SCREEN.width })}
                />
            </div>
            <div className='vp-hint'>
                {nls.localize('vueport/xr/settings/widthHint',
                    'How wide the virtual screen is, in meters. In the headset: grip + left stick.')}
            </div>
            <Range
                value={screen.width}
                setValue={width => props.onScreen({ ...screen, width })}
                min={XR_MIN_WIDTH}
                max={XR_MAX_WIDTH}
                step={0.1}
            />
        </div>

        <div className='vp-bool-setting vp-range-setting'>
            <div className='vp-bool-title'>
                <span>{nls.localize('vueport/xr/settings/depth', '3D Depth in VR')}</span>
                <ResetButton
                    disabled={screen.depth === XR_DEFAULT_SCREEN.depth}
                    onReset={() => props.onScreen({ ...screen, depth: XR_DEFAULT_SCREEN.depth })}
                />
            </div>
            <div className='vp-hint'>
                {nls.localize('vueport/xr/settings/depthHint',
                    'Used in place of the 3D depth from Display while in the headset, as how deep a picture '
                    + 'looks depends on its size. 100% is the real console\'s. In the headset: grip + right stick.')}
            </div>
            <Range
                value={screen.depth}
                setValue={depth => props.onScreen({ ...screen, depth: Math.round(depth) })}
                min={0}
                max={XR_MAX_DEPTH}
                step={5}
            />
        </div>

        <div className='vp-bool-setting'>
            <div className='vp-bool-title'>
                <span>{nls.localize('vueport/xr/menu/backdrop/title', 'Backdrop')}</span>
                <ResetButton
                    disabled={backdrop === 'black'}
                    onReset={() => props.onBackdrop('black')}
                />
            </div>
            <div className='vp-hint'>
                {nls.localize('vueport/xr/settings/backdrop', 'What is shown around the screen in the headset.')}
                {' '}
                {nls.localize('vueport/xr/settings/backdropUnsupported',
                    'Only available on headsets that support passthrough.')}
            </div>
            <RadioSelect
                options={XR_BACKDROPS.map(choice => ({
                    value: choice,
                    label: xrBackdropLabel(choice),
                }))}
                defaultValue={backdrop}
                onChange={chosen => props.onBackdrop(chosen[0].value as XrBackdrop)}
            />
            <div className='vp-hint'>
                <span>{xrBackdropLabel(backdrop)}</span>
                {': '}{xrBackdropDescription(backdrop)}
            </div>
        </div>

        <div className='vp-bool-setting'>
            <div className='vp-bool-title'>
                <span>{nls.localize('vueport/xr/settings/controls', 'Controllers in the Headset')}</span>
            </div>
            {[
                nls.localize('vueport/xr/menu/hintInterface', 'Stick click or menu button: show or hide the interface'),
                nls.localize('vueport/xr/menu/hintPoint', 'Trigger: click · B: back · stick: scroll'),
                nls.localize('vueport/xr/menu/hintSize', 'Grip + left stick: screen size · click: reset'),
                nls.localize('vueport/xr/menu/hintDepth', 'Grip + right stick: 3D depth · click: reset'),
                nls.localize('vueport/xr/menu/hintLeave', 'Both grips for a second: leave VR'),
            ].map(hint => <div key={hint} className='vp-hint'>{hint}</div>)}
        </div>
    </div>;
}

function xrBackdropDescription(backdrop: XrBackdrop): string {
    switch (backdrop) {
        case 'passthrough':
            return nls.localize('vueport/xr/settings/backdropAbout/passthrough', 'Shows the room around the screen.');
        case 'hologram':
            return nls.localize('vueport/xr/settings/backdropAbout/hologram',
                'Shows the room around the screen and through its black parts as well.');
        default:
            return nls.localize('vueport/xr/settings/backdropAbout/black', 'Hides the room.');
    }
}

function XrStatus(props: { availability: XrAvailability }): React.JSX.Element {
    const { headline, detail } = xrStatusText(props.availability);
    return <div className={'vp-xr-status' + (props.availability === 'headset' ? ' connected' : '')}>
        <div className='vp-xr-status-icon' aria-hidden>
            <GoogleCardboardLogo size={36} weight={props.availability === 'headset' ? 'fill' : 'regular'} />
        </div>
        <div className='vp-rumble-pack-status-text'>
            <div className='vp-rumble-pack-status-headline'>{headline}</div>
            <div className='vp-rumble-pack-status-detail'>{detail}</div>
        </div>
    </div>;
}

function xrStatusText(availability: XrAvailability): { headline: string, detail: string } {
    switch (availability) {
        case 'headset':
            return {
                headline: nls.localize('vueport/xr/settings/availability/headset', 'Headset ready'),
                detail: nls.localize('vueport/xr/settings/availability/headsetHint',
                    'Open a game and press VR in the title bar.'),
            };
        case 'none':
            return {
                headline: nls.localize('vueport/xr/settings/availability/none', 'No headset connected'),
                detail: nls.localize('vueport/xr/settings/availability/noneHint',
                    'Connect a VR headset (e.g. with Quest Link, Virtual Desktop or SteamVR), or press VR in the \
title bar to share the game with a headset in the same network.'),
            };
        case 'unavailable':
            return {
                headline: nls.localize('vueport/xr/settings/availability/unavailable', 'VR not available'),
                detail: nls.localize('vueport/xr/settings/availability/unavailableHint',
                    'There is no WebXR here, so there is no way to talk to a headset.'),
            };
    }
}
