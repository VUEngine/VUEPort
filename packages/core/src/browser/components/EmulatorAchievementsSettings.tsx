import { Eye, EyeSlash, User } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { VUEPORT_DEFAULTS, VueportSettings } from '../../common/emulator-settings';
import {
    RA_SIGN_UP_URL,
    raUserProfileUrl,
    RetroAchievementsService,
} from '../emulator-retroachievements';
import ResetButton from './kit/ResetButton';

// onDidChange of the service covers everything shown here, including a finished login
export default function EmulatorAchievementsSettings(props: {
    settings: VueportSettings,
    achievements: RetroAchievementsService,
}): React.JSX.Element {
    const { settings, achievements } = props;
    const [, setVersion] = React.useState(0);
    const redraw = React.useCallback(() => setVersion(v => v + 1), []);

    React.useEffect(() => {
        const subscription = achievements.onDidChange(redraw);
        return () => subscription.dispose();
    }, [achievements, redraw]);

    const [enabled, setEnabled] = React.useState(settings.get('retroAchievementsEnabled'));
    const standardEnabled = settings.defaults?.retroAchievementsEnabled
        ?? VUEPORT_DEFAULTS.retroAchievementsEnabled;
    const [username, setUsername] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [revealPassword, setRevealPassword] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>(undefined);

    const doLogin = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault();
        setError(undefined);
        try {
            await achievements.login(username, password);
            setPassword('');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    return <div className='vp-appearance'>
        <div className='vp-bool-setting'>
            <div className='vp-bool-title'>
                <span>{nls.localize('vueport/achievements/enable', 'Track achievements')}</span>
                <ResetButton
                    disabled={enabled === standardEnabled}
                    onReset={() => {
                        setEnabled(standardEnabled);
                        settings.set('retroAchievementsEnabled', standardEnabled);
                    }}
                />
            </div>
            <div className='vp-bool-control'>
                <button
                    type='button'
                    role='switch'
                    aria-checked={enabled}
                    aria-label={nls.localize('vueport/achievements/enable', 'Track achievements')}
                    className='vp-switch'
                    onClick={() => {
                        const next = !enabled;
                        setEnabled(next);
                        settings.set('retroAchievementsEnabled', next);
                    }}
                >
                    <span className='vp-switch-knob' />
                </button>
                <span className='vp-bool-description'>
                    {nls.localize('vueport/achievements/enableNote',
                        'Unlock achievements in supported games and sync to RetroAchievements.')}
                </span>
            </div>
        </div>

        <div className='vp-bool-setting'>
            <div className='vp-bool-title'>
                <span>{nls.localize('vueport/achievements/hardcore/title', 'Hardcore Mode')}</span>
                <ResetButton
                    disabled={!achievements.hardcore}
                    onReset={() => { achievements.setHardcore(false).catch(() => undefined); }}
                />
            </div>
            <div className='vp-bool-control'>
                <button
                    type='button'
                    role='switch'
                    aria-checked={achievements.hardcore}
                    aria-label={nls.localize('vueport/achievements/hardcore/title', 'Hardcore Mode')}
                    className='vp-switch'
                    // on prompts first and restarts the ROM, off is immediate; the service owns both (see setHardcore)
                    onClick={() => { achievements.setHardcore(!achievements.hardcore).catch(() => undefined); }}
                >
                    <span className='vp-switch-knob' />
                </button>
                <span className='vp-bool-description'>
                    {nls.localize('vueport/achievements/hardcoreDescription',
                        'Earn achievements without any aids.')}
                </span>
            </div>
            <p className='vp-retroachievements-note'>
                {nls.localize('vueport/achievements/hardcore/unapproved',
                    'VUEPort is not yet approved by RetroAchievements. Hardcore mode unlocks cannot be earned.')}
            </p>
        </div>

        {!achievements.transport.available &&
            <p className='vp-retroachievements-note'>
                {nls.localize('vueport/achievements/needsDesktop',
                    "A web page cannot reach RetroAchievements' servers — sign in and play from the desktop application.")}
            </p>
        }

        <div className='vp-bool-setting'>
            <div className='vp-bool-title'>
                <span>RetroAchievements</span>
            </div>
            {achievements.isLoggedIn
                ? <div className='vp-retroachievements-account'>
                    <AccountAvatar username={achievements.user!.username} avatarUrl={achievements.user!.avatarUrl} />
                    <div className='vp-retroachievements-identity'>
                        <a
                            className='vp-retroachievements-username'
                            href={raUserProfileUrl(achievements.user!.username)}
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            {achievements.user!.username}
                        </a>
                        <div className='vp-retroachievements-stats'>
                            <span className='vp-retroachievements-stat'>
                                <strong>{achievements.user!.score.toLocaleString()}</strong>
                                {nls.localize('vueport/achievements/pointsLabel', 'points')}
                            </span>
                            <span className='vp-retroachievements-stat'>
                                <strong>{achievements.user!.softcoreScore.toLocaleString()}</strong>
                                {nls.localize('vueport/achievements/softcoreLabel', 'casual')}
                            </span>
                        </div>
                    </div>
                    <button
                        className='vp-button secondary vp-retroachievements-logout'
                        onClick={() => { achievements.logout().catch(() => undefined); }}
                    >
                        {nls.localize('vueport/achievements/logOut', 'Log Out')}
                    </button>
                </div>
                // carries `-account` so signed out and signed in have the same size (12px padding around a 56px row)
                // and the pane does not jump on login. The error stays outside the box, as the only thing changing
                // height
                : <form className='vp-retroachievements-login' onSubmit={doLogin}>
                    <div className='vp-retroachievements-account'>
                        <div
                            className='vp-retroachievements-avatar vp-retroachievements-avatar-empty'
                            aria-hidden='true'
                        >
                            <User size={24} />
                        </div>
                        <div className='vp-retroachievements-credentials'>
                            <input
                                className='vp-input'
                                placeholder={nls.localize('vueport/achievements/username', 'Username')}
                                value={username}
                                autoComplete='username'
                                disabled={!achievements.transport.available}
                                onChange={event => setUsername(event.target.value)}
                            />
                            <div className='vp-retroachievements-password'>
                                <input
                                    // only the password is marked: a rejected sign-in is far more
                                    // often a mistyped password, and the service answers both with
                                    // one message
                                    className={`vp-input${error ? ' invalid' : ''}`}
                                    type={revealPassword ? 'text' : 'password'}
                                    placeholder={nls.localize('vueport/achievements/password', 'Password')}
                                    value={password}
                                    autoComplete='current-password'
                                    disabled={!achievements.transport.available}
                                    onChange={event => setPassword(event.target.value)}
                                />
                                <button
                                    type='button'
                                    className='vp-retroachievements-reveal'
                                    disabled={!achievements.transport.available}
                                    aria-label={revealPassword
                                        ? nls.localize('vueport/achievements/hidePassword', 'Hide password')
                                        : nls.localize('vueport/achievements/showPassword', 'Show password')}
                                    onClick={() => setRevealPassword(v => !v)}
                                >
                                    {revealPassword ? <EyeSlash size={16} /> : <Eye size={16} />}
                                </button>
                            </div>
                        </div>
                        <div className='vp-retroachievements-login-actions'>
                            <button
                                type='submit'
                                className='vp-button primary'
                                disabled={!achievements.transport.available || !username || !password || achievements.isLoggingIn}
                            >
                                {achievements.isLoggingIn
                                    ? nls.localize('vueport/achievements/loggingIn', 'Signing in…')
                                    : nls.localize('vueport/achievements/logIn', 'Log In')}
                            </button>
                            <a
                                className='vp-button secondary'
                                href={RA_SIGN_UP_URL}
                                target='_blank'
                                rel='noopener noreferrer'
                            >
                                {nls.localize('vueport/achievements/signUp', 'Sign Up')}
                            </a>
                        </div>
                    </div>
                    {error && <p className='vp-retroachievements-error'>{error}</p>}
                </form>
            }
        </div>
    </div>;
}

// falls back to a plain initial when there is none (a fresh login before the engine refreshed the account) or the
// image fails to load
function AccountAvatar(props: { username: string, avatarUrl: string | undefined }): React.JSX.Element {
    const { username, avatarUrl } = props;
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => setFailed(false), [avatarUrl]);

    if (avatarUrl && !failed) {
        return <img
            className='vp-retroachievements-avatar'
            src={avatarUrl}
            alt=''
            onError={() => setFailed(true)}
        />;
    }
    return <div className='vp-retroachievements-avatar' aria-hidden='true'>
        {username.charAt(0).toUpperCase()}
    </div>;
}
