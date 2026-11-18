import { Star } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';

// shown only while the cheats panel is closed, so cheats set up and forgotten stay in sight
export default function EmulatorCheatBadge(props: {
    count: number,
    onShow: () => void,
}): React.JSX.Element {
    const { count, onShow } = props;
    return <button
        type='button'
        className='vp-screen-badge vp-cheat-badge'
        aria-label={nls.localize('vueport/cheats/activeBadge',
            '{0} cheats are on. Show them.', count)}
        onClick={onShow}
    >
        <Star size={16} weight='fill' />
        {count}
    </button>;
}
