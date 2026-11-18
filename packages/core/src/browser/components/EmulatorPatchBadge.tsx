import { Bandaids } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';

// like the cheats' badge, as a patch switched on long ago is easy to forget. Colorizations are not counted, a game
// in color says so by itself
export default function EmulatorPatchBadge(props: {
    count: number,
    onShow: () => void,
}): React.JSX.Element {
    const { count, onShow } = props;
    return <button
        type='button'
        className='vp-screen-badge vp-patch-badge'
        aria-label={nls.localize('vueport/patches/activeBadge',
            '{0} patches are on. Show them.', count)}
        onClick={onShow}
    >
        <Bandaids size={16} weight='fill' />
        {count}
    </button>;
}
