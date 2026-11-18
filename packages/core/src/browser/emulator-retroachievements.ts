// DOM side of the RetroAchievements integration (the worker's is vb-rcheevos.ts). Login is a plain call to the login
// endpoint, independent of the worker, so an account can be entered in Settings before any ROM is open

import { localizeAchievement } from '../common/emulator-catalog-nls';
import { Emitter, Event, Disposable, DisposableCollection } from '../common/emulator-events';
import { VueportNotifications } from '../common/emulator-host';
import { nls } from '../common/emulator-nls';
import { Core, Sim } from './core/vb-core';
import {
    RaAchievement,
    VesRaEvent,
    RaGame,
    RaLeaderboard,
    VesRaLeaderboardEntries,
} from '../common/vb-protocol';
import {
    AchievementBackup,
    AchievementBackupGame,
    achievementBackupByHash,
    achievementBackupToRaGame,
    achievementBackupToRaList,
} from './emulator-achievement-backup';

const RA_DOREQUEST = 'https://retroachievements.org/dorequest.php';

export const RA_SIGN_UP_URL = 'https://retroachievements.org/createaccount.php';

export function raUserProfileUrl(username: string): string {
    return `https://retroachievements.org/user/${encodeURIComponent(username)}`;
}

// fake achievements RetroAchievements sends as session warnings: the emulator ones while the client is not on the
// allowlist (VUEPort's state until approved), the version one when the ROM is a build the set was not made for. They
// are not shown, counted or announced
const RA_NOTICE_TITLES = new Set([
    'warning: unknown emulator',
    'unsupported emulator',
    'unsupported game version',
]);

const RA_UNSUPPORTED_VERSION_TITLE = 'unsupported game version';

function raNoticeTitle(title: string): string | undefined {
    const normalized = title.trim().toLowerCase();
    return RA_NOTICE_TITLES.has(normalized) ? normalized : undefined;
}

export interface RetroAchievementsTransport {
    // false in a browser: dorequest.php sends no CORS headers. The desktop shell proxies the request through its process.
    readonly available: boolean;
    request(
        method: 'GET' | 'POST',
        url: string,
        body: string | undefined,
        contentType: string | undefined,
    ): Promise<{ status: number, body: string }>;
}

export const UNAVAILABLE_RA_TRANSPORT: RetroAchievementsTransport = {
    available: false,
    async request(): Promise<{ status: number, body: string }> {
        throw new Error('RetroAchievements cannot be reached from this build.');
    },
};

export interface RetroAchievementsCredentials {
    load(): Promise<{ username: string, token: string } | undefined>;
    save(credentials: { username: string, token: string }): Promise<void>;
    clear(): Promise<void>;
}

export interface RetroAchievementsAccount {
    username: string;
    token: string;
    score: number;
    softcoreScore: number;
    avatarUrl?: string;
}

// without these the panel's hardcore switch does not appear. The service owns the question and the engine flag; the
// rest of hardcore's discipline is the host's, since only it can restart a ROM or move between Play and Debug.
export interface RetroAchievementsHardcoreControls {
    isEnabled(): boolean;
    persist(enabled: boolean): void | Promise<void>;
    // force Play mode, switch every cheat off, stop any running macro and restart the ROM. Run once, right after the
    // player confirms turning hardcore on; leaving hardcore needs none of it.
    enter(): void | Promise<void>;
}

// here so the panel switch and the command palette ask in the same words, translated once
export function hardcoreConfirmation(): { title: string, message: string[], okLabel: string } {
    return {
        title: nls.localize('vueport/achievements/hardcore/confirmTitle', 'Turn on Hardcore Mode?'),
        message: [
            nls.localize('vueport/achievements/hardcore/confirmWhat',
                'Hardcore mode requires you to play without any aids. \
As such, cheats, macros and patches are switched off, loading a \
save state, rewinding and frame advance are disabled, and Debug mode is unavailable.'),
            nls.localize('vueport/achievements/hardcore/confirmPending',
                'VUEPort is still awaiting RetroAchievements approval, so hardcore unlocks can not be \
credited to your account yet.'),
        ],
        okLabel: nls.localize('vueport/achievements/hardcore/confirmOk', 'Turn on Hardcore Mode'),
    };
}

// shown when the player reaches for something hardcore takes away (rewind, loading a save state, cheats or macros,
// Debug mode); offers the way out, which is immediate and does not restart
export function hardcoreOnNotice(): { title: string, message: string[], okLabel: string } {
    return {
        title: nls.localize('vueport/achievements/hardcore/onTitle', 'Hardcore Mode is on'),
        message: [
            nls.localize('vueport/achievements/hardcore/onWhat',
                'Cheats, macros, patches, loading a save state, rewind, slow motion, frame advance and \
Debug mode are all disabled while hardcore mode is on.'),
            nls.localize('vueport/achievements/hardcore/onLeave',
                'You can turn it off now. Takes effect immediately and does not restart the game.'),
        ],
        okLabel: nls.localize('vueport/achievements/hardcore/onOff', 'Turn off Hardcore Mode'),
    };
}

export type RetroAchievementsUnavailableReason =
    | 'disabled'
    | 'transport'
    | 'engine'
    | 'not-logged-in'
    | 'no-rom'
    | 'not-recognized';

function formEncode(fields: Record<string, string>): string {
    return Object.entries(fields)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
}

export class RetroAchievementsService implements Disposable {

    protected account: RetroAchievementsAccount | undefined;
    protected game: RaGame | undefined;
    protected achievements: RaAchievement[] = [];
    protected leaderboards: RaLeaderboard[] = [];
    protected leaderboardsReason: string | undefined;
    // by tracker id, not leaderboard id: leaderboards reading the same value share one tracker, so this is exactly the set
    // of readouts to draw
    protected readonly trackers = new Map<number, string>();
    protected loadReason: string | undefined;
    protected engineReason: string | undefined;
    // the list alone cannot say: an answer of nothing but RA_NOTICE_TITLES filters down to an empty list, which is a set
    // that is in but has nothing to show
    protected achievementsLoaded = false;
    // set when RetroAchievements answered "unsupported game version": a set exists, but not for this build. The notice
    // itself is dropped, this is left for the panel to explain.
    protected unsupportedVersion = false;
    protected loggingIn = false;

    protected core: Core | undefined;
    protected sim: Sim | undefined;
    // kept so a set can be (re-)loaded after a late login
    protected romHash: string | undefined;
    protected readonly sessionDisposables = new DisposableCollection();

    protected hardcoreControls: RetroAchievementsHardcoreControls | undefined;

    // the loader is called at most once, the first time a running ROM has no live set, and indexed by hash
    protected backupLoader: (() => Promise<AchievementBackup | undefined>) | undefined;
    protected backupByHash: Map<string, AchievementBackupGame> | undefined;
    protected backupTried = false;
    protected backupGame: AchievementBackupGame | undefined;
    protected backupView: { game: RaGame, list: RaAchievement[] } | undefined;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    protected readonly onUnlockedEmitter = new Emitter<{
        title: string, description: string, points: number, badgeUrl: string,
    }>();
    readonly onUnlocked = this.onUnlockedEmitter.event;

    protected readonly onDidChangeTrackersEmitter = new Emitter<void>();
    // many times a second while an attempt runs, so not folded into onDidChange, which redraws the whole achievements
    // panel. Only the overlay over the picture listens.
    readonly onDidChangeTrackers: Event<void> = this.onDidChangeTrackersEmitter.event;

    protected readonly onLeaderboardAttemptEmitter =
        new Emitter<Extract<VesRaEvent, { kind: 'leaderboardAttempt' }>>();
    readonly onLeaderboardAttempt = this.onLeaderboardAttemptEmitter.event;

    protected readonly onScoreboardEmitter =
        new Emitter<Extract<VesRaEvent, { kind: 'leaderboardScoreboard' }>>();
    // the server's answer to a submission: the player's place and the top of the board. Always preceded by an
    // onLeaderboardAttempt for the same board, a round trip earlier.
    readonly onScoreboard = this.onScoreboardEmitter.event;

    constructor(
        readonly transport: RetroAchievementsTransport,
        protected readonly credentials: RetroAchievementsCredentials,
        protected readonly notifications: VueportNotifications,
        protected readonly enabled: () => boolean,
    ) { }

    async restore(): Promise<void> {
        const stored = await this.credentials.load().catch(() => undefined);
        if (!stored) {
            return;
        }
        this.account = { ...stored, score: 0, softcoreScore: 0 };
        this.changed();
        // a bare credential carries no score or avatar, so without this Settings showed zeroes until a ROM armed the engine
        await this.refreshAccount().catch(() => undefined);
    }

    setHardcoreControls(controls: RetroAchievementsHardcoreControls): void {
        this.hardcoreControls = controls;
        this.changed();
    }

    // the shipped fallback for when the live site cannot be reached (see emulator-achievement-backup). Call once at
    // start-up; the loader only runs the first time a running ROM has no live set.
    setBackupLoader(loader: () => Promise<AchievementBackup | undefined>): void {
        this.backupLoader = loader;
    }

    get usingBackup(): boolean {
        return this.achievements.length === 0 && this.backupView !== undefined;
    }

    protected async ensureBackup(): Promise<void> {
        if (this.backupTried || !this.backupLoader) {
            return;
        }
        this.backupTried = true;
        const data = await this.backupLoader().catch(() => undefined);
        if (data) {
            this.backupByHash = achievementBackupByHash(data);
        }
    }

    // called whenever the live picture changes; a live set arriving takes precedence and clears this again
    protected async resolveBackup(): Promise<void> {
        // wanted when signed in and the running ROM has no live list: site unreachable, engine missing, or no real set
        // served to VUEPort (an unapproved client gets a `game` with no achievements). Signed out is left to the
        // panel's "sign in" prompt
        const wanted = this.achievements.length === 0
            && this.romHash !== undefined
            && this.enabled()
            && this.account !== undefined;
        if (wanted) {
            await this.ensureBackup();
        }
        const match = wanted ? this.backupByHash?.get(this.romHash!.toLowerCase()) : undefined;
        if (match === this.backupGame) {
            return;
        }
        this.backupGame = match;
        this.backupView = match
            ? { game: achievementBackupToRaGame(match), list: achievementBackupToRaList(match) }
            : undefined;
        this.changed();
    }

    get hardcoreControlsAvailable(): boolean {
        return this.hardcoreControls !== undefined;
    }

    get hardcore(): boolean {
        return this.hardcoreControls?.isEnabled() ?? false;
    }

    // on: ask first, then persist, run the host's `enter` and arm the engine. Off: persist and disarm, no prompt and no
    // restart; rc_client keeps the hardcore unlocks already earned.
    async setHardcore(enabled: boolean): Promise<void> {
        const controls = this.hardcoreControls;
        if (!controls || enabled === controls.isEnabled()) {
            return;
        }
        if (enabled && !await this.notifications.confirm(hardcoreConfirmation())) {
            return;
        }
        await controls.persist(enabled);
        if (enabled) {
            await controls.enter();
        }
        await this.applyHardcoreToEngine();
        this.changed();
    }

    // tell why and offer to turn hardcore off. Does nothing when it is off, so every blocked control can route through it.
    async offerToLeaveHardcore(): Promise<void> {
        if (!this.hardcore) {
            return;
        }
        if (await this.notifications.confirm(hardcoreOnNotice())) {
            await this.setHardcore(false);
        }
    }

    async applyHardcoreToEngine(): Promise<void> {
        await this.core?.raSetHardcore(this.hardcore).catch(() => undefined);
    }

    // the same plain login2 call as `login`, with the saved token standing in for a password
    async refreshAccount(): Promise<void> {
        if (!this.account || !this.transport.available) {
            return;
        }
        await this.requestLogin2({ r: 'login2', u: this.account.username, t: this.account.token });
        this.changed();
    }

    get isLoggedIn(): boolean {
        return this.account !== undefined;
    }

    get user(): RetroAchievementsAccount | undefined {
        return this.account;
    }

    get currentGame(): RaGame | undefined {
        return this.game ?? this.backupView?.game;
    }

    get list(): ReadonlyArray<RaAchievement> {
        return this.achievements.length > 0 ? this.achievements : this.backupView?.list ?? [];
    }

    get unsupportedGameVersion(): boolean {
        return this.unsupportedVersion;
    }

    // an empty list means "none" once this is true, and "not yet" until then
    get listLoaded(): boolean {
        return this.achievementsLoaded || this.backupView !== undefined;
    }

    // live only: the offline snapshot carries achievements only, and a leaderboard without the server has nothing to show
    get leaderboardList(): ReadonlyArray<RaLeaderboard> {
        return this.leaderboards;
    }

    get leaderboardsUnavailableDetail(): string | undefined {
        return this.leaderboardsReason;
    }

    // RetroAchievements only runs leaderboards in hardcore mode, so in softcore every board reads `inactive`
    get leaderboardsActive(): boolean {
        return this.hardcore;
    }

    get leaderboardTrackers(): ReadonlyArray<{ id: number, display: string }> {
        return [...this.trackers].map(([id, display]) => ({ id, display }));
    }

    // `aroundUser` asks for the page the signed-in player sits in the middle of. Rejects without a session, account or
    // engine answer; the panel shows the message.
    async fetchLeaderboardEntries(
        leaderboardId: number,
        options: { firstEntry?: number, count?: number, aroundUser?: boolean } = {},
    ): Promise<VesRaLeaderboardEntries> {
        if (!this.core) {
            throw new Error('No game is running.');
        }
        return this.core.raFetchLeaderboardEntries(
            leaderboardId,
            options.firstEntry ?? 1,
            options.count ?? 25,
            options.aroundUser ?? false,
        );
    }

    get unavailableReason(): RetroAchievementsUnavailableReason | undefined {
        if (!this.enabled()) {
            return 'disabled';
        }
        // the offline snapshot stands in for whatever is missing (transport, account, engine), as long as it has this ROM's set
        if (this.backupView) {
            return undefined;
        }
        if (!this.transport.available) {
            return 'transport';
        }
        if (!this.account) {
            return 'not-logged-in';
        }
        if (this.engineReason) {
            return 'engine';
        }
        if (!this.core) {
            return 'no-rom';
        }
        if (!this.game) {
            return 'not-recognized';
        }
        return undefined;
    }

    get unavailableDetail(): string | undefined {
        return this.engineReason ?? this.loadReason;
    }

    // with a password or a saved token (restore, refreshAccount), the endpoint rcheevos itself uses, independent of any
    // session, so the account can be set up before a ROM is ever opened. The engine's own login happens in setSession.
    protected async requestLogin2(fields: Record<string, string>): Promise<void> {
        const response = await this.transport.request(
            'POST', RA_DOREQUEST, formEncode(fields), 'application/x-www-form-urlencoded',
        );
        const body = JSON.parse(response.body) as {
            Success?: boolean, User?: string, Token?: string,
            Score?: number, SoftcoreScore?: number, AvatarUrl?: string, Error?: string,
        };
        if (response.status !== 200 || !body.Success || !body.Token) {
            throw new Error(body.Error ?? `RetroAchievements answered ${response.status}.`);
        }
        this.account = {
            username: body.User ?? fields.u,
            token: body.Token,
            score: body.Score ?? 0,
            softcoreScore: body.SoftcoreScore ?? 0,
            avatarUrl: body.AvatarUrl,
        };
        await this.credentials.save({ username: this.account.username, token: this.account.token });
    }

    async login(username: string, password: string): Promise<void> {
        if (!this.transport.available) {
            throw new Error('RetroAchievements needs the desktop application to connect.');
        }
        this.loggingIn = true;
        this.changed();
        try {
            await this.requestLogin2({ r: 'login2', u: username, p: password });
            if (this.core) {
                await this.authenticateSession(this.core);
                // a ROM opened before anyone signed in never got to ask for its set
                if (this.romHash) {
                    await this.loadGame(this.romHash);
                }
            }
        } finally {
            this.loggingIn = false;
            this.changed();
        }
    }

    // call from the host's settings listener. Switched on, the running ROM gets its chance to ask for its set; switched
    // off, the set is unloaded on the spot while the account and ROM keep running. `romHash` stays for switching back
    // on
    async enabledChanged(): Promise<void> {
        if (!this.enabled()) {
            await this.stopTracking();
        } else if (this.core && this.account && this.transport.available) {
            await this.authenticateSession(this.core);
            if (this.romHash) {
                await this.loadGame(this.romHash);
            }
        } else {
            await this.resolveBackup();
        }
        this.changed();
    }

    protected async stopTracking(): Promise<void> {
        await this.core?.raUnloadGame().catch(() => undefined);
        this.game = undefined;
        this.achievements = [];
        this.achievementsLoaded = false;
        this.unsupportedVersion = false;
        this.loadReason = undefined;
        this.clearLeaderboards();
        this.backupGame = undefined;
        this.backupView = undefined;
    }

    async logout(): Promise<void> {
        this.account = undefined;
        this.game = undefined;
        this.achievements = [];
        this.achievementsLoaded = false;
        this.unsupportedVersion = false;
        this.clearLeaderboards();
        await this.credentials.clear().catch(() => undefined);
        if (this.core) {
            await this.core.raLogout().catch(() => undefined);
        }
        await this.resolveBackup();
        this.changed();
    }

    get isLoggingIn(): boolean {
        return this.loggingIn;
    }

    // call from `stop()` with undefined first, so a session being torn down stops delivering achievement events
    async setSession(core: Core | undefined, sim: Sim | undefined): Promise<void> {
        this.sessionDisposables.dispose();
        this.core = core;
        this.sim = sim;
        this.game = undefined;
        this.achievements = [];
        this.achievementsLoaded = false;
        this.unsupportedVersion = false;
        this.clearLeaderboards();
        this.romHash = undefined;
        this.backupGame = undefined;
        this.backupView = undefined;

        if (!core) {
            this.changed();
            return;
        }

        this.sessionDisposables.push(core.onRetroAchievements(event => this.onEvent(core, event)));
        if (this.account && this.enabled() && this.transport.available) {
            await this.authenticateSession(core).catch(() => undefined);
        }
        this.changed();
    }

    // silently does nothing unless RetroAchievements is on and an account is signed in; `unavailableReason` says why
    async loadGame(hash: string | undefined): Promise<void> {
        this.romHash = hash;
        this.achievementsLoaded = false;
        this.unsupportedVersion = false;
        if (!hash || !this.sim || !this.account || !this.enabled() || !this.transport.available) {
            await this.resolveBackup();
            return;
        }
        // before the set loads, so a fresh session starts in the player's hardcore mode rather than rc_client's softcore default
        await this.core?.raSetHardcore(this.hardcore).catch(() => undefined);
        await this.sim.raLoadGame(hash).catch(async error => {
            this.loadReason = error instanceof Error ? error.message : String(error);
            await this.resolveBackup();
            this.changed();
        });
    }

    protected async authenticateSession(core: Core): Promise<void> {
        if (!this.account) {
            return;
        }
        try {
            const refreshed = await core.raLoginToken(this.account.username, this.account.token);
            this.account = {
                username: refreshed.username, token: refreshed.token,
                score: refreshed.score, softcoreScore: refreshed.softcoreScore,
                avatarUrl: refreshed.avatarUrl,
            };
            // the token rc_client hands back is the one to keep using, it may have been reissued
            await this.credentials.save({ username: this.account.username, token: this.account.token })
                .catch(() => undefined);
        } catch (error) {
            this.notifications.warn(
                `RetroAchievements login failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected onEvent(core: Core, event: VesRaEvent): void {
        // switched off: whatever the engine still reports is unwanted, and a set that loaded anyway is unloaded now.
        // Server calls are still answered so the engine never waits, and a missing engine is still noted, as it is
        // reported only once
        if (!this.enabled() && event.kind !== 'serverCall' && event.kind !== 'engineUnavailable') {
            if (event.kind === 'gameLoaded' && event.game) {
                core.raUnloadGame().catch(() => undefined);
            }
            return;
        }
        switch (event.kind) {
            case 'serverCall':
                this.serviceServerCall(core, event);
                return;
            case 'gameLoaded':
                this.game = event.game;
                this.loadReason = event.reason;
                if (event.game) {
                    this.engineReason = undefined;
                }
                // a live set won: drop the snapshot view. A miss: try to put one up (resolveBackup no-ops if `this.game` is set).
                this.resolveBackup().catch(() => undefined);
                this.changed();
                return;
            case 'achievements':
                // drop the notices (see RA_NOTICE_TITLES) before anything counts or displays the list; the version notice leaves
                // `unsupportedVersion` behind for the panel
                this.unsupportedVersion = event.achievements.some(
                    a => raNoticeTitle(a.title) === RA_UNSUPPORTED_VERSION_TITLE);
                // localized after the notices are recognized by their English titles
                this.achievements = event.achievements
                    .filter(a => !raNoticeTitle(a.title))
                    .map(localizeAchievement);
                this.achievementsLoaded = true;
                this.resolveBackup().catch(() => undefined);
                this.changed();
                return;
            case 'unlocked': {
                // the same notices arrive as unlocks too when the set loads; warnings, not rewards, so no toast
                const notice = raNoticeTitle(event.title);
                if (notice) {
                    if (notice === RA_UNSUPPORTED_VERSION_TITLE && !this.unsupportedVersion) {
                        this.unsupportedVersion = true;
                        this.changed();
                    }
                    return;
                }
                this.onUnlockedEmitter.fire(localizeAchievement(event));
                this.changed();
                return;
            }
            case 'engineUnavailable':
                this.engineReason = event.reason;
                this.resolveBackup().catch(() => undefined);
                this.changed();
                return;
            case 'challengeIndicator':
            case 'connection':
                this.changed();
                return;
            case 'leaderboards':
                this.leaderboards = event.leaderboards;
                this.leaderboardsReason = event.reason;
                this.changed();
                return;
            case 'leaderboardAttempt':
                // no changed(): the engine sends the whole list straight after an attempt starts or ends, which redraws the panel
                this.onLeaderboardAttemptEmitter.fire(event);
                return;
            case 'leaderboardTracker':
                if (event.show) {
                    this.trackers.set(event.trackerId, event.display);
                } else {
                    this.trackers.delete(event.trackerId);
                }
                this.onDidChangeTrackersEmitter.fire();
                return;
            case 'leaderboardScoreboard':
                // toast only: a board's standings are fetched when it is opened
                this.onScoreboardEmitter.fire(event);
                return;
        }
    }

    protected async serviceServerCall(
        core: Core,
        call: Extract<VesRaEvent, { kind: 'serverCall' }>,
    ): Promise<void> {
        try {
            const response = await this.transport.request(call.method, call.url, call.body, call.contentType);
            await core.raProvideResponse(call.requestId, response.status, response.body);
        } catch {
            // the engine treats a zero status as "could not be reached" and retries or reports offline on its own
            await core.raProvideResponse(call.requestId, 0, '').catch(() => undefined);
        }
    }

    // the overlay is told separately, since it does not listen to onDidChange
    protected clearLeaderboards(): void {
        this.leaderboards = [];
        this.leaderboardsReason = undefined;
        if (this.trackers.size > 0) {
            this.trackers.clear();
            this.onDidChangeTrackersEmitter.fire();
        }
    }

    protected changed(): void {
        this.onDidChangeEmitter.fire();
    }

    dispose(): void {
        this.sessionDisposables.dispose();
        this.onDidChangeEmitter.dispose();
        this.onUnlockedEmitter.dispose();
        this.onDidChangeTrackersEmitter.dispose();
        this.onLeaderboardAttemptEmitter.dispose();
        this.onScoreboardEmitter.dispose();
    }
}
