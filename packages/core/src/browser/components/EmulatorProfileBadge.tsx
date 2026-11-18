import { Pulse } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';

// shown in any mode, as profiling costs performance and memory and the toolbar button may be in another mode or off
// screen. Pressing it stops the recording, which also writes the profile out
export default function EmulatorProfileBadge(props: {
    profiling: boolean,
    onStop: () => void,
}): React.JSX.Element | null {
    const { profiling, onStop } = props;
    if (!profiling) {
        return null;
    }
    return <button
        type='button'
        className='vp-screen-badge vp-profile-badge live'
        aria-label={nls.localize('vueport/debug/panels/profiler/profile/badge',
            'A profile recording is running. Stop it and export.')}
        onClick={onStop}
    >
        <Pulse size={16} />
        {nls.localize('vueport/debug/panels/profiler/profile/prof', 'PROF')}
    </button>;
}
