import { ChartBar } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { RetroAchievementsService } from '../emulator-retroachievements';

// values of the running leaderboard attempts over the corner of the picture, as a raced timer or score must be
// visible. Subscribes to the service itself: the values change many times a second and nothing larger should
// redraw at that rate, which is why onDidChangeTrackers is separate from onDidChange
export default function EmulatorLeaderboardTracker(props: {
    achievements: RetroAchievementsService,
}): React.JSX.Element | null {
    const { achievements } = props;
    const [, setVersion] = React.useState(0);

    React.useEffect(() => {
        const subscription = achievements.onDidChangeTrackers(() => setVersion(version => version + 1));
        return () => subscription.dispose();
    }, [achievements]);

    const trackers = achievements.leaderboardTrackers;
    if (trackers.length === 0) {
        return null;
    }

    return <>
        {trackers.map(tracker =>
            <span
                key={tracker.id}
                className='vp-screen-badge vp-leaderboard-tracker'
                aria-label={nls.localize(
                    'vueport/achievements/trackerLabel', 'Leaderboard attempt: {0}', tracker.display)}
            >
                <ChartBar size={14} weight='fill' />
                {tracker.display}
            </span>)}
    </>;
}
