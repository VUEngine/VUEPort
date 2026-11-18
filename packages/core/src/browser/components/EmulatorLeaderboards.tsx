import {
    ArrowLeft, ArrowsClockwise, CaretRight, ChartBar, Timer, Trophy, Warning,
} from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { RaLeaderboard, VesRaLeaderboardEntries } from '../../common/vb-protocol';
import { RetroAchievementsService } from '../emulator-retroachievements';
import EmptyContainer from './kit/EmptyContainer';
import RadioSelect from './kit/RadioSelect';

const PAGE_SIZE = 25;
type EntryScope = 'top' | 'around';

function leaderboardStateLabel(state: RaLeaderboard['state']): string | undefined {
    switch (state) {
        case 'tracking':
            return nls.localize('vueport/achievements/leaderboards/stateTracking', 'In Progress');
        case 'unsupported':
            return nls.localize('vueport/achievements/leaderboards/stateUnsupported', 'Unsupported');
        default:
            return undefined;
    }
}

function leaderboardFormatLabel(format: RaLeaderboard['format']): string {
    switch (format) {
        case 'time':
            return nls.localize('vueport/achievements/leaderboards/formatTime', 'Time');
        case 'value':
            return nls.localize('vueport/achievements/leaderboards/formatValue', 'Value');
        default:
            return nls.localize('vueport/achievements/leaderboards/formatScore', 'Score');
    }
}

export function EmulatorLeaderboardList(props: {
    achievements: RetroAchievementsService,
    filterText: string,
    onSelect: (id: number) => void,
}): React.JSX.Element {
    const { achievements, filterText, onSelect } = props;

    const engineReason = achievements.leaderboardsUnavailableDetail;
    if (engineReason) {
        return <div className='vp-panel-empty-fill'>
            <EmptyContainer
                title={nls.localize('vueport/achievements/leaderboards/engineTitle', 'Leaderboards unavailable')}
                description={engineReason}
                icon={<ChartBar size={32} />}
            />
        </div>;
    }

    const list = achievements.leaderboardList;
    if (list.length === 0) {
        return <div className='vp-panel-empty-fill'>
            <EmptyContainer
                title={nls.localize('vueport/achievements/leaderboards/noneTitle', 'No Leaderboards')}
                description={nls.localize('vueport/achievements/leaderboards/noneDescription',
                    'RetroAchievements has no leaderboards for this game.')}
                icon={<ChartBar size={32} />}
            />
        </div>;
    }

    const needle = filterText.trim().toLowerCase();
    const visible = list.filter(leaderboard => !needle
        || leaderboard.title.toLowerCase().includes(needle)
        || leaderboard.description.toLowerCase().includes(needle));

    return <>
        {!achievements.leaderboardsActive &&
            <div className='vp-achievements-offline-note'>
                <Warning size={14} />
                <span>
                    {nls.localize('vueport/achievements/leaderboards/softcoreNote',
                        'Attempts are only tracked in Hardcore Mode. You can still read every board.')}
                </span>
            </div>}

        {visible.length === 0
            ? <p className='vp-panel-empty'>
                {nls.localize('vueport/achievements/leaderboards/noMatch', 'No leaderboards match the current filter.')}
            </p>
            : <div className='vp-split-table vp-scroll'>
                <ul className='vp-panel-list'>
                    {visible.map(leaderboard => {
                        const stateLabel = leaderboardStateLabel(leaderboard.state);
                        const tracking = leaderboard.state === 'tracking';
                        return <li
                            key={leaderboard.id}
                            className={'vp-panel-row' + (tracking ? ' enabled' : '')}
                            onClick={() => onSelect(leaderboard.id)}
                        >
                            {leaderboard.format === 'time'
                                ? <Timer size={20} />
                                : <ChartBar size={20} />}
                            <div className='vp-achievements-text'>
                                <span className='vp-panel-row-name'>{leaderboard.title}</span>
                                <span className='vp-achievements-description'>
                                    {leaderboard.description}
                                </span>
                            </div>
                            {tracking && leaderboard.value &&
                                <span className='vp-leaderboards-value'>{leaderboard.value}</span>}
                            {stateLabel && <span className='vp-achievements-pill'>{stateLabel}</span>}
                            <CaretRight size={16} className='vp-achievements-lock' />
                        </li>;
                    })}
                </ul>
            </div>}
    </>;
}

export function EmulatorLeaderboardDetail(props: {
    achievements: RetroAchievementsService,
    leaderboard: RaLeaderboard,
    onBack: () => void,
}): React.JSX.Element {
    const { achievements, leaderboard, onBack } = props;
    const [scope, setScope] = React.useState<EntryScope>('top');
    const [reloadToken, setReloadToken] = React.useState(0);
    const [entries, setEntries] = React.useState<VesRaLeaderboardEntries | undefined>(undefined);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        let canceled = false;
        setLoading(true);
        setError(undefined);
        achievements.fetchLeaderboardEntries(leaderboard.id, {
            count: PAGE_SIZE,
            aroundUser: scope === 'around',
        }).then(result => {
            if (!canceled) {
                setEntries(result);
                setLoading(false);
            }
        }).catch((reason: unknown) => {
            if (!canceled) {
                setEntries(undefined);
                setError(reason instanceof Error ? reason.message : String(reason));
                setLoading(false);
            }
        });
        return () => { canceled = true; };
    }, [achievements, leaderboard.id, scope, reloadToken]);

    const username = achievements.user?.username;

    return <>
        <div className='vp-panel-toolbar'>
            <button
                type='button'
                className='vp-panel-back'
                aria-label={nls.localize('vueport/general/backToList', 'Back To List')}
                onClick={onBack}
            >
                <ArrowLeft size={20} />
                {nls.localize('vueport/general/backToList', 'Back To List')}
            </button>
            <button
                type='button'
                className='vp-panel-back'
                aria-label={nls.localize('vueport/achievements/leaderboards/refresh', 'Refresh')}
                onClick={() => setReloadToken(token => token + 1)}
            >
                <ArrowsClockwise size={16} />
            </button>
        </div>
        <div className='vp-panel-detail vp-scroll'>
            <div className='vp-achievements-detail-header'>
                {leaderboard.format === 'time' ? <Timer size={40} /> : <ChartBar size={40} />}
                <div className='vp-achievements-detail-title'>
                    <span>{leaderboard.title}</span>
                    <span className='vp-achievements-pill'>
                        {leaderboardFormatLabel(leaderboard.format)}
                    </span>
                </div>
            </div>
            <p className='vp-achievements-detail-description'>{leaderboard.description}</p>

            <div className='vp-leaderboards-scope'>
                <RadioSelect
                    options={[
                        {
                            value: 'top',
                            label: leaderboard.lowerIsBetter
                                ? nls.localize('vueport/achievements/leaderboards/scopeFastest', 'Fastest')
                                : nls.localize('vueport/achievements/leaderboards/scopeTop', 'Top'),
                        },
                        {
                            value: 'around',
                            label: nls.localize('vueport/achievements/leaderboards/scopeAround', 'Around Me'),
                        },
                    ]}
                    defaultValue={scope}
                    onChange={chosen => setScope(chosen[0].value as EntryScope)}
                />
                {entries &&
                    <span className='vp-leaderboards-total'>
                        {nls.localize('vueport/achievements/leaderboards/total', '{0} entries', String(entries.total))}
                    </span>}
            </div>

            {loading
                ? <p className='vp-panel-empty'>
                    {nls.localize('vueport/achievements/leaderboards/loading', 'Loading entries…')}
                </p>
                : error
                    ? <p className='vp-panel-empty'>{error}</p>
                    : !entries || entries.entries.length === 0
                        ? <p className='vp-panel-empty'>
                            {scope === 'around'
                                ? nls.localize('vueport/achievements/leaderboards/noEntryOfYours',
                                    'You have no entry on this leaderboard yet.')
                                : nls.localize('vueport/achievements/leaderboards/noEntries',
                                    'Nobody has an entry on this leaderboard yet.')}
                        </p>
                        : <ul className='vp-panel-list vp-leaderboards-entries'>
                            {entries.entries.map(entry => {
                                const isSelf = username !== undefined
                                    && entry.user.toLowerCase() === username.toLowerCase();
                                return <li
                                    key={`${entry.rank}-${entry.user}`}
                                    className={'vp-panel-row' + (isSelf ? ' enabled' : '')}
                                >
                                    <span className='vp-leaderboards-rank'>{entry.rank}</span>
                                    {entry.avatarUrl
                                        ? <img
                                            className='vp-leaderboards-avatar'
                                            src={entry.avatarUrl}
                                            alt=''
                                        />
                                        : <Trophy size={24} />}
                                    <span className='vp-panel-row-name'>{entry.user}</span>
                                    <span className='vp-leaderboards-value'>{entry.display}</span>
                                    <span className='vp-leaderboards-date'>
                                        {entry.submitted > 0
                                            ? new Date(entry.submitted * 1000).toLocaleDateString()
                                            : ''}
                                    </span>
                                </li>;
                            })}
                        </ul>}
        </div>
    </>;
}
