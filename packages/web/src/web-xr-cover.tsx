import * as React from 'react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { WebEmulator } from './web-emulator';

/**
 * What the page shows while it plays in a headset. The page is never seen there, as the headset draws its parts on its
 * own (emulator-xr-ui.ts; this is not one of them). But when the user leaves for another of the headset's windows, the
 * session runs on behind the page, which the Quest Browser then shows as a window, with Resume and Close buttons of its
 * own that do not answer. This gives the way back in and the way out, instead of the parts stacked on top of each other
 * as they would be in their headset places.
 */
export function WebXrCover(props: { emulator: WebEmulator }): React.JSX.Element {
    const { emulator } = props;
    // the installed app started, and the browser did not let it go into the headset by itself: one press does
    if (!emulator.xr.active) {
        return <div className='vp-xr-page-cover' role='dialog' aria-modal='true'>
            <img className='vp-xr-page-cover-logo' src='/vueport.webp' alt={nls.localize('vueport/app/name', 'VUEPort')} />
            <div className='vp-xr-page-cover-actions'>
                <button type='button' className='vp-button' onClick={() => { emulator.xr.enter().catch(() => undefined); }}>
                    {nls.localize('vueport/xr/enter', 'Play in VR')}
                </button>
                <button type='button' className='vp-button secondary' onClick={() => emulator.xr.dismissStart()}>
                    {nls.localize('vueport/xr/cover/stay', 'Stay in the Window')}
                </button>
            </div>
        </div>;
    }
    return <div className='vp-xr-page-cover' role='dialog' aria-modal='true'>
        <img className='vp-xr-page-cover-logo' src='/vueport.webp' alt={nls.localize('vueport/app/name', 'VUEPort')} />
        <p>{nls.localize('vueport/xr/cover/text', 'VUEPort is showing in WebXR right now.')}</p>
        <div className='vp-xr-page-cover-actions'>
            <button type='button' className='vp-button' onClick={() => { emulator.xr.resume().catch(() => undefined); }}>
                {nls.localize('vueport/xr/cover/resume', 'Resume VR')}
            </button>
            <button type='button' className='vp-button secondary' onClick={() => { emulator.xr.end().catch(() => undefined); }}>
                {nls.localize('vueport/xr/leave', 'Leave VR')}
            </button>
        </div>
    </div>;
}
