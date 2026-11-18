import { VideoCamera } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';

// `0:07`, `12:40`
function formatDuration(seconds: number): string {
    const whole = Math.floor(Math.max(0, seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// shown because the stop button may be in a hidden strip. Counts on its own clock, so a running recording does not
// re-render the whole chrome every second
export default function EmulatorVideoBadge(props: {
    recording: boolean,
    // asked for rather than passed in, so nothing above the badge has to keep a timer
    seconds(): number,
    onStop: () => void,
}): React.JSX.Element | null {
    const { recording, seconds, onStop } = props;
    const [shown, setShown] = React.useState(0);

    React.useEffect(() => {
        if (!recording) {
            return undefined;
        }
        setShown(seconds());
        // twice a second, so the count never sits a whole second behind
        const timer = setInterval(() => setShown(seconds()), 500);
        return () => clearInterval(timer);
    }, [recording, seconds]);

    if (!recording) {
        return null;
    }
    return <button
        type='button'
        className='vp-screen-badge vp-video-badge live'
        aria-label={nls.localize('vueport/video/badge',
            'A video recording is running. Stop it and save the file.')}
        onClick={onStop}
    >
        <VideoCamera size={16} weight='fill' />
        {formatDuration(shown)}
    </button>;
}
