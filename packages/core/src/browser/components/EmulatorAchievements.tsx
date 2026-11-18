import {
    ArrowLeft,
    ChartBar,
    CloudSlash,
    Lock,
    MagnifyingGlass,
    Power,
    SignIn,
    SortAscending,
    SortDescending,
    Trophy,
    UserPlus,
    Warning,
    X,
} from '@phosphor-icons/react';
import * as React from 'react';
import styled from 'styled-components';
import { nls } from '../../common/emulator-nls';
import { RaAchievement } from '../../common/vb-protocol';
import {
    RA_SIGN_UP_URL,
    RetroAchievementsService,
    RetroAchievementsUnavailableReason,
} from '../emulator-retroachievements';
import { EmulatorLeaderboardDetail, EmulatorLeaderboardList } from './EmulatorLeaderboards';
import EmptyContainer from './kit/EmptyContainer';
import RadioSelect from './kit/RadioSelect';
import Select from './kit/Select';

const StyledCloseButton = styled.button`
    position: relative;
    z-index: 10;
`;

type AchievementSort = 'display' | 'unlocked' | 'won' | 'points' | 'title';
type SortDirection = 'asc' | 'desc';

// as the Library browser's SORT_DEFAULTS: titles A to Z, the other three biggest first. Picking a field restores
// its own direction
const SORT_DEFAULTS: Record<AchievementSort, SortDirection> = {
    display: 'asc',
    unlocked: 'desc',
    won: 'desc',
    points: 'desc',
    title: 'asc',
};

// written ascending, the caller turns it round with `sign`
function compareAchievements(a: RaAchievement, b: RaAchievement, sort: AchievementSort, sign: number): number {
    switch (sort) {
        case 'display':
            return 0;
        case 'unlocked':
            return sign * (Number(a.state !== 'locked') - Number(b.state !== 'locked'));
        case 'won':
            // an achievement without a figure stays at the foot whichever way the list runs
            if (a.rarity === undefined || b.rarity === undefined) {
                return Number(a.rarity === undefined) - Number(b.rarity === undefined);
            }
            return sign * (a.rarity - b.rarity);
        case 'points':
            return sign * (a.points - b.points);
        case 'title':
            return sign * a.title.localeCompare(b.title);
    }
}

// Array#sort is stable, so 'display' keeps the set's own order and only reversing it means anything
function sortAchievements(
    list: readonly RaAchievement[],
    sort: AchievementSort,
    direction: SortDirection,
): RaAchievement[] {
    const sorted = [...list];
    if (sort === 'display') {
        return direction === 'asc' ? sorted : sorted.reverse();
    }
    const sign = direction === 'asc' ? 1 : -1;
    sorted.sort((a, b) => compareAchievements(a, b, sort, sign));
    return sorted;
}

// built per call: the titles are localized, and the host installs its localization after module load
function sortOptions(): { value: AchievementSort, label: string }[] {
    return [
        { value: 'unlocked', label: nls.localize('vueport/achievements/sort/unlocked', 'Unlocked') },
        { value: 'display', label: nls.localize('vueport/achievements/sort/display', 'Display Order') },
        { value: 'won', label: nls.localize('vueport/achievements/sort/won', 'Won By') },
        { value: 'points', label: nls.localize('vueport/achievements/sort/points', 'Points') },
        { value: 'title', label: nls.localize('vueport/achievements/sort/titleField', 'Title') },
    ];
}

function directionName(direction: SortDirection): string {
    return direction === 'asc'
        ? nls.localize('vueport/achievements/sort/ascending', 'Ascending order')
        : nls.localize('vueport/achievements/sort/descending', 'Descending order');
}

function achievementTypeLabel(type: RaAchievement['type']): string | undefined {
    switch (type) {
        case 'missable':
            return nls.localize('vueport/achievements/typeMissable', 'Missable');
        case 'progression':
            return nls.localize('vueport/achievements/typeProgression', 'Progression');
        case 'win':
            return nls.localize('vueport/achievements/typeWin', 'Win Condition');
        default:
            return undefined;
    }
}

function unavailableCopy(reason: RetroAchievementsUnavailableReason, detail: string | undefined): {
    title: string, description?: string,
} {
    switch (reason) {
        case 'disabled':
            return {
                title: nls.localize('vueport/achievements/disabledTitle', 'Achievements are off'),
            };
        case 'transport':
            return {
                title: nls.localize('vueport/achievements/transportTitle', 'Needs the desktop application'),
                description: nls.localize('vueport/achievements/transportDescription',
                    "A web page cannot reach RetroAchievements' servers. Achievements work in the packaged desktop application."),
            };
        case 'not-logged-in':
            return {
                title: nls.localize('vueport/achievements/notLoggedInTitle', 'Not signed in'),
                description: nls.localize('vueport/achievements/notLoggedInDescription',
                    'Sign in with your RetroAchievements account in Settings › Achievements.'),
            };
        case 'no-rom':
            return {
                title: nls.localize('vueport/achievements/noRomTitle', 'No game running'),
                description: nls.localize('vueport/achievements/noRomDescription',
                    'Open a ROM to see its achievements.'),
            };
        case 'not-recognized':
            return {
                title: nls.localize('vueport/achievements/notRecognizedTitle', 'No Achievements'),
                description: detail === undefined || detail.toLowerCase() === 'unknown game'
                    ? nls.localize(
                        'vueport/achievements/notRecognizedDescription',
                        'RetroAchievements does not have this ROM on record.'
                    )
                    : detail
            };
        case 'engine':
            return {
                title: nls.localize('vueport/achievements/engineTitle', 'RetroAchievements engine unavailable'),
                description: detail
                    ?? nls.localize('vueport/achievements/engineDescription',
                        'This build does not carry the RetroAchievements engine.'),
            };
    }
}

function AchievementRow(props: { achievement: RaAchievement, onSelect: () => void }): React.JSX.Element {
    const { achievement, onSelect } = props;
    const locked = achievement.state === 'locked';
    return <li className={'vp-panel-row' + (locked ? '' : ' enabled')} onClick={onSelect}>
        {achievement.badgeUrl
            ? <img
                className='vp-achievements-badge'
                src={achievement.badgeUrl}
                alt=''
                style={{ opacity: locked ? 0.4 : 1 }}
            />
            : <Trophy size={28} />
        }
        <div className='vp-achievements-text'>
            <span className='vp-panel-row-name'>{achievement.title}</span>
            <span className='vp-achievements-description'>{achievement.description}</span>
            {achievement.measured &&
                <div className='vp-achievements-progress'>
                    <div className='vp-achievements-progress-track'>
                        <div
                            className='vp-achievements-progress-bar'
                            style={{ width: `${Math.min(100, Math.max(0, achievement.measured.percent))}%` }}
                        />
                    </div>
                    <span>{achievement.measured.display}</span>
                </div>
            }
        </div>
        <span className='vp-achievements-points'>
            {nls.localize('vueport/achievements/points', '{0} pts', String(achievement.points))}
        </span>
        {locked
            ? <Lock size={16} className='vp-achievements-lock' />
            : <Trophy size={16} className='vp-achievements-earned' />
        }
    </li>;
}

// read-only, and push-driven: RetroAchievementsService fires onDidChange whenever the account, set or an unlock
// changes, nothing here is polled
export default function EmulatorAchievements(props: {
    achievements: RetroAchievementsService,
    // for the strip beside the screen, which has no chrome to close it by (as EmulatorCheats and EmulatorMacros); the
    // docked panel has a tab
    onClose?: () => void,
    // signing in happens on the settings page; offered as a button in the "not signed in" state
    onOpenSettings?: () => void,
    // offered in the "achievements are off" state; absent on a host that cannot write the setting from here
    onEnable?: () => void,
}): React.JSX.Element {
    const { achievements, onClose, onOpenSettings, onEnable } = props;
    const [, setVersion] = React.useState(0);
    const redraw = React.useCallback(() => setVersion(version => version + 1), []);
    const [selectedId, setSelectedId] = React.useState<number | undefined>(undefined);
    const [selectedLeaderboardId, setSelectedLeaderboardId] = React.useState<number | undefined>(undefined);
    const [filterText, setFilterText] = React.useState('');
    const [sort, setSort] = React.useState<AchievementSort>('unlocked');
    const [direction, setDirection] = React.useState<SortDirection>(SORT_DEFAULTS.unlocked);
    const [lockedOnly, setLockedOnly] = React.useState(false);
    const [view, setView] = React.useState<'achievements' | 'leaderboards'>('achievements');

    React.useEffect(() => {
        const subscription = achievements.onDidChange(redraw);
        return () => subscription.dispose();
    }, [achievements, redraw]);

    const gameId = achievements.currentGame?.id;
    React.useEffect(() => {
        setFilterText('');
        setLockedOnly(false);
        setSelectedLeaderboardId(undefined);
    }, [gameId]);

    const closeButton = onClose && <StyledCloseButton
        type='button'
        className='vp-panel-close'
        aria-label={nls.localize('vueport/achievements/close', 'Close Achievements')}
        onClick={onClose}
    >
        <X size={20} />
    </StyledCloseButton>;

    const header = <div className='vp-panel-heading'>
        {onClose &&
            <span className='vp-panel-heading-title'>
                <Trophy size={22} />
                {nls.localize('vueport/achievements/title', 'Achievements')}
            </span>}
        {closeButton}
    </div>;

    const hardcoreFooter = <>
        {achievements.hardcoreControlsAvailable &&
            <div className='vp-achievements-hardcore-toggle'>
                <button
                    type='button'
                    role='switch'
                    aria-checked={achievements.hardcore}
                    aria-label={nls.localize('vueport/achievements/hardcore/title', 'Hardcore Mode')}
                    className='vp-switch'
                    onClick={() => { achievements.setHardcore(!achievements.hardcore).catch(() => undefined); }}
                >
                    <span className='vp-switch-knob' />
                </button>
                <div className='vp-achievements-hardcore-toggle-text'>
                    <span>{nls.localize('vueport/achievements/hardcore/title', 'Hardcore Mode')}</span>
                    <span>
                        {nls.localize('vueport/achievements/hardcore/blurb',
                            'No cheats, macros, ROM patches, save-state loading, rewind or Debug mode.')}
                    </span>
                </div>
            </div>}

        <div className='vp-achievements-hardcore-note'>
            <Warning size={14} />
            <div className='vp-achievements-hardcore-note-text'>
                <span>
                    {nls.localize('vueport/achievements/hardcore/unapproved',
                        'VUEPort is not yet approved by RetroAchievements. Hardcore mode unlocks cannot be earned.')}
                </span>
                {achievements.unsupportedGameVersion &&
                    <span>
                        {nls.localize('vueport/achievements/hardcore/unsupportedVersion',
                            'RetroAchievements does not support this build of the ROM. \
Nothing in the set can be earned with it.')}
                    </span>}
            </div>
        </div>
    </>;

    const reason = achievements.unavailableReason;
    if (reason) {
        const copy = unavailableCopy(reason, achievements.unavailableDetail);
        return <>
            {header}
            <div className='vp-panel-empty-fill'>
                <EmptyContainer
                    title={copy.title}
                    description={copy.description}
                    icon={reason === 'not-logged-in' ? <SignIn size={32} /> : <Trophy size={32} />}
                />
            </div>
            {reason === 'not-logged-in' && onOpenSettings &&
                <div className='vp-panel-actions'>
                    <button className='vp-button secondary' onClick={onOpenSettings}>
                        <SignIn size={16} />
                        {nls.localize('vueport/achievements/logIn', 'Log In')}
                    </button>
                    <a
                        className='vp-button secondary'
                        href={RA_SIGN_UP_URL}
                        target='_blank'
                        rel='noopener noreferrer'
                    >
                        <UserPlus size={16} />
                        {nls.localize('vueport/achievements/signUp', 'Sign Up')}
                    </a>
                </div>}
            {reason === 'disabled' && onEnable &&
                <div className='vp-panel-actions'>
                    <button className='vp-button secondary' onClick={onEnable}>
                        <Power size={16} />
                        {nls.localize('vueport/achievements/activate', 'Activate')}
                    </button>
                </div>}
            {reason === 'not-recognized' && hardcoreFooter}
        </>;
    }

    // before anything else: a chosen leaderboard takes the whole panel, as a chosen achievement does below
    const selectedLeaderboard = selectedLeaderboardId !== undefined
        ? achievements.leaderboardList.find(l => l.id === selectedLeaderboardId)
        : undefined;
    if (view === 'leaderboards' && selectedLeaderboard) {
        return <EmulatorLeaderboardDetail
            achievements={achievements}
            leaderboard={selectedLeaderboard}
            onBack={() => setSelectedLeaderboardId(undefined)}
        />;
    }

    const game = achievements.currentGame;
    const list = achievements.list;
    const earned = list.filter(a => a.state === 'unlocked');
    const points = list.reduce((sum, a) => sum + a.points, 0);
    const earnedPoints = earned.reduce((sum, a) => sum + a.points, 0);
    const selected = selectedId !== undefined ? list.find(a => a.id === selectedId) : undefined;

    if (selected) {
        const typeLabel = achievementTypeLabel(selected.type);
        const locked = selected.state === 'locked';
        return <>
            <div className='vp-panel-toolbar'>
                <button
                    type='button'
                    className='vp-panel-back'
                    aria-label={nls.localize('vueport/general/backToList', 'Back To List')}
                    onClick={() => setSelectedId(undefined)}
                >
                    <ArrowLeft size={20} />
                    {nls.localize('vueport/general/backToList', 'Back To List')}
                </button>
            </div>
            <div className='vp-panel-detail vp-scroll'>
                <div className='vp-achievements-detail-header'>
                    {selected.badgeUrl
                        ? <img
                            className='vp-achievements-detail-badge'
                            src={selected.badgeUrl}
                            alt=''
                            style={{ opacity: locked ? 0.4 : 1 }}
                        />
                        : <Trophy size={48} />
                    }
                    <div className='vp-achievements-detail-title'>
                        <span>{selected.title}</span>
                    </div>
                </div>
                <p className='vp-achievements-detail-description'>
                    {selected.description}
                    {typeLabel && <span className='vp-achievements-pill'>{typeLabel}</span>}
                </p>
                <div className='vp-achievements-detail-stats'>
                    <div className='vp-achievements-detail-stat'>
                        <span>{nls.localize('vueport/achievements/detail/points', 'Points')}</span>
                        <span>{selected.points}</span>
                    </div>
                    {selected.rarity !== undefined &&
                        <div className='vp-achievements-detail-stat'>
                            <span>{nls.localize('vueport/achievements/detail/rarity', 'Earned by')}</span>
                            <span>
                                {selected.rarityHardcore !== undefined && selected.rarityHardcore !== selected.rarity
                                    ? nls.localize('vueport/achievements/detail/rarityBoth',
                                        '{0}% of players ({1}% hardcore)',
                                        selected.rarity.toFixed(1), selected.rarityHardcore.toFixed(1))
                                    : nls.localize('vueport/achievements/detail/rarityOne',
                                        '{0}% of players', selected.rarity.toFixed(1))}
                            </span>
                        </div>}
                    <div className='vp-achievements-detail-stat'>
                        <span>{nls.localize('vueport/achievements/detail/status', 'Status')}</span>
                        <span>
                            {selected.unlockTime !== undefined
                                ? nls.localize('vueport/achievements/detail/unlockedOn', 'Unlocked {0}',
                                    new Date(selected.unlockTime * 1000).toLocaleString())
                                : nls.localize('vueport/achievements/detail/locked', 'Locked')}
                        </span>
                    </div>
                </div>
            </div>
        </>;
    }

    const needle = filterText.trim().toLowerCase();
    const filtered = list
        .filter(a => !needle || a.title.toLowerCase().includes(needle) || a.description.toLowerCase().includes(needle))
        .filter(a => !lockedOnly || a.state !== 'unlocked');
    const visible = sortAchievements(filtered, sort, direction);

    return <>
        {header}
        {achievements.usingBackup &&
            <div className='vp-achievements-offline-note'>
                <CloudSlash size={14} />
                <span>
                    {nls.localize(
                        'vueport/achievements/offlineCopy',
                        'Offline copy of this set. Your progress and new unlocks need a live connection to RetroAchievements.'
                    )}
                </span>
            </div>}
        {game && <div className='vp-achievements-header'>
            <div className='vp-achievements-header-text'>
                <span>
                    {nls.localize('vueport/achievements/progress', '{0} of {1} achievements · {2} of {3} points',
                        String(earned.length), String(list.length), String(earnedPoints), String(points))}
                </span>
                <div className='vp-achievements-progress-track'>
                    <div
                        className='vp-achievements-progress-bar'
                        style={{ width: `${list.length ? Math.round(earned.length / list.length * 100) : 0}%` }}
                    />
                </div>
            </div>
        </div>}

        <div className='vp-panel-filter'>
            <MagnifyingGlass size={15} />
            <input
                type='text'
                spellCheck={false}
                value={filterText}
                placeholder={nls.localize('vueport/achievements/filter', 'Filter')}
                aria-label={nls.localize('vueport/achievements/filter', 'Filter')}
                onChange={event => setFilterText(event.target.value)}
            />
            {filterText &&
                <button
                    type='button'
                    className='vp-panel-filter-clear'
                    aria-label={nls.localize('vueport/general/clear', 'Clear')}
                    onClick={() => setFilterText('')}
                >
                    <X size={14} />
                </button>}
        </div>

        <div className='vp-achievements-toolbar'>
            {view === 'achievements' && <>
                {/* field and direction split as in the Library browser; the button shows the direction and turns it */}
                <div className='vp-achievements-sort'>
                    <button
                        type='button'
                        className='vp-achievements-sort-direction'
                        title={directionName(direction)}
                        aria-label={directionName(direction)}
                        onClick={() => setDirection(current => (current === 'asc' ? 'desc' : 'asc'))}
                    >
                        {direction === 'asc'
                            ? <SortAscending size={16} />
                            : <SortDescending size={16} />}
                    </button>
                    <Select
                        options={sortOptions().map(option => ({
                            value: String(option.value),
                            label: option.label,
                        }))}
                        value={sort}
                        label={nls.localize('vueport/achievements/sort/title', 'Sort order')}
                        onChange={next => {
                            // picking a field brings its own direction, so a reversal lasts until the field changes again
                            setSort(next as AchievementSort);
                            setDirection(SORT_DEFAULTS[next as AchievementSort]);
                        }}
                    />
                </div>
                <button
                    type='button'
                    className='vp-achievements-toolbar-toggle'
                    aria-pressed={lockedOnly}
                    onClick={() => setLockedOnly(v => !v)}
                >
                    <Lock size={14} />
                    {nls.localize('vueport/achievements/lockedOnly', 'Locked Only')}
                </button>
            </>}
            {/* one choice of two, so the shared segmented control; icons only as the toolbar does not wrap */}
            <div
                className='vp-achievements-view-switch'
                role='group'
                aria-label={nls.localize('vueport/achievements/viewSwitch', 'Achievements or leaderboards')}
            >
                <RadioSelect
                    options={[
                        {
                            value: 'achievements',
                            label: <Trophy size={16} />,
                            tooltip: nls.localize('vueport/achievements/viewAchievements', 'Achievements'),
                        },
                        {
                            value: 'leaderboards',
                            label: <ChartBar size={16} />,
                            tooltip: nls.localize('vueport/achievements/viewLeaderboards', 'Leaderboards'),
                        },
                    ]}
                    defaultValue={view}
                    onChange={chosen =>
                        setView(chosen[0].value as 'achievements' | 'leaderboards')}
                />
            </div>
        </div>

        {view === 'leaderboards'
            ? <EmulatorLeaderboardList
                achievements={achievements}
                filterText={filterText}
                onSelect={setSelectedLeaderboardId}
            />
            : list.length === 0
                ? <div className='vp-panel-empty-fill'>
                    {achievements.listLoaded
                        ? <EmptyContainer
                            title={nls.localize('vueport/achievements/notRecognizedTitle', 'No Achievements')}
                            description={nls.localize('vueport/achievements/noneDescription',
                                'There are no achievements for this game.')}
                            icon={<Trophy size={32} />}
                        />
                        : <EmptyContainer
                            title={nls.localize('vueport/achievements/loading', 'Loading achievements…')}
                            icon={<Trophy size={32} />}
                        />}
                </div>
                : visible.length === 0
                    ? <p className='vp-panel-empty'>
                        {nls.localize('vueport/achievements/noMatch', 'No achievements match the current filter.')}
                    </p>
                    : <div className='vp-split-table vp-scroll'>
                        <ul className='vp-panel-list'>
                            {visible.map(achievement => <AchievementRow
                                key={achievement.id}
                                achievement={achievement}
                                onSelect={() => setSelectedId(achievement.id)}
                            />)}
                        </ul>
                    </div>
        }

        {hardcoreFooter}
    </>;
}
