/**
 * The RetroAchievements engine, hosted in the emulator worker: evaluating a set reads memory synchronously once per
 * frame, and only the worker can do that (from the DOM it is a message round trip). rcheevos runs as a second
 * WebAssembly module beside the core, through a thin C shim (wasm/rcheevos/shim/vueport-rc.c) that flattens rc_client
 * to functions with primitive parameters. This module makes no network requests: vrc_server_call becomes a serverCall
 * event, the DOM side makes the call and answers with raProvideResponse. rcheevos.js and rcheevos.wasm are loaded
 * lazily on the first login; a build without them reports engineUnavailable.
 */

import { VbDataType, VB_CART_RAM_BASE, VB_WRAM_BASE } from '../common/vb-constants';
import { VesRaEvent, VesRaLeaderboardEntries, VesRaUser } from '../common/vb-protocol';
import { WasmExports } from './vb-wasm';

// the Emscripten factory rcheevos.js defines on the worker global, only what this file touches
interface RcModuleFactory {
    (options?: Record<string, unknown>): Promise<RcModule>;
}

interface RcWorkerScope {
    importScripts(...urls: string[]): void;
    createVueportRc?: RcModuleFactory;
}

interface RcModule {
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(pointer: number): void;
    stringToUTF8(text: string, pointer: number, maxBytes: number): void;
    lengthBytesUTF8(text: string): number;

    // hooks the --js-library glue calls back into, set by us
    vrcReadMemory(address: number, buffer: number, length: number): number;
    vrcServerCall(
        requestId: number,
        method: string,
        url: string,
        post: string | undefined,
        contentType: string | undefined,
    ): void;
    vrcEmit(json: string): void;

    // the shim's exports
    _vrc_create(): number;
    _vrc_destroy(client: number): void;
    _vrc_begin_login_password(client: number, username: number, password: number): void;
    _vrc_begin_login_token(client: number, username: number, token: number): void;
    _vrc_logout(client: number): void;
    _vrc_begin_load_game(client: number, hash: number): void;
    _vrc_unload_game(client: number): void;
    _vrc_reset(client: number): void;
    // absent from an rcheevos.wasm built before this export (the committed artifact until build.mjs is rerun), so every
    // call is guarded. Missing, the client stays softcore, the safe side to fail to
    _vrc_set_hardcore?(client: number, enabled: number): void;
    _vrc_do_frame(client: number): void;
    _vrc_idle(client: number): void;
    _vrc_provide_response(requestId: number, status: number, body: number): void;
    // absent from an older rcheevos.wasm too, and doubles as the test whether this engine emits leaderboards at
    // all, so a stale one is reported rather than leaving the panel waiting forever
    _vrc_begin_fetch_leaderboard_entries?(
        client: number,
        fetchId: number,
        leaderboardId: number,
        firstEntry: number,
        count: number,
        aroundUser: number,
    ): void;
}

// kept so the answer of an in-flight rc_client request can be routed back
interface PendingLogin {
    resolve: (user: VesRaUser) => void;
    reject: (error: Error) => void;
}

interface PendingEntries {
    resolve: (entries: VesRaLeaderboardEntries) => void;
    reject: (error: Error) => void;
}

// the shim writes answers into a fixed 64 KB buffer and stops rather than overflowing, so both ends need a ceiling. A
// hundred rows fit several times over, and no page the panel shows comes near it
const VRC_MAX_ENTRIES = 100;

export class RetroAchievements {

    protected module: RcModule | undefined;
    protected client = 0;
    protected loadAttempted = false; // so a failed load is not retried forever
    protected unavailableReason: string | undefined;

    protected readonly outbox: VesRaEvent[] = []; // events waiting for the drive loop to flush them to the DOM

    protected read: ((address: number) => number) | undefined; // undefined when detached

    protected pendingLogin: PendingLogin | undefined;

    // outstanding fetchLeaderboardEntries calls, by the id sent to the shim
    protected readonly pendingEntries = new Map<number, PendingEntries>();
    protected nextFetchId = 1;

    // called the moment an event is queued, so the worker can flush it without waiting for a frame: frames stop while
    // paused (e.g. behind the settings dialog), and signing in while paused would hang otherwise
    onPush: (() => void) | undefined;

    protected gameLoaded = false;
    protected idleCountdown = 0;

    // remembered to apply to a client that does not exist yet, as setHardcore comes before the first login
    protected hardcore = false;
    protected warnedNoHardcoreExport = false; // so the "engine too old for hardcore" warning is logged at most once

    constructor(protected readonly moduleUrl: string | undefined) { }

    // wasm and simPointer belong to the main simulation only, never the profile replay's scratch simulation or a
    // linked peer, which must not feed the achievement client
    attach(wasm: WasmExports, simPointer: number): void {
        this.read = address => wasm.vbRead(simPointer, address >>> 0, VbDataType.U8) & 0xff;
    }

    detach(): void {
        this.read = undefined;
        if (this.client && this.module && this.gameLoaded) {
            this.module._vrc_unload_game(this.client);
        }
        this.gameLoaded = false;
    }

    takeEvents(): VesRaEvent[] {
        if (this.outbox.length === 0) {
            return [];
        }
        return this.outbox.splice(0, this.outbox.length);
    }

    async loginPassword(username: string, password: string): Promise<VesRaUser> {
        return this.login(client => this.withStrings([username, password],
            ([u, p]) => this.module!._vrc_begin_login_password(client, u, p)));
    }

    async loginToken(username: string, token: string): Promise<VesRaUser> {
        return this.login(client => this.withStrings([username, token],
            ([u, t]) => this.module!._vrc_begin_login_token(client, u, t)));
    }

    logout(): void {
        if (this.client && this.module) {
            this.module._vrc_logout(this.client);
        }
        this.gameLoaded = false;
        this.failPendingEntries('Signed out of RetroAchievements.');
    }

    async loadGame(hash: string): Promise<void> {
        if (!await this.ensureLoaded() || !this.client || !this.module) {
            this.push({ kind: 'gameLoaded', game: undefined, reason: this.unavailableReason ?? 'unavailable' });
            return;
        }
        this.withStrings([hash], ([h]) => this.module!._vrc_begin_load_game(this.client, h));
    }

    unloadGame(): void {
        if (this.client && this.module && this.gameLoaded) {
            this.module._vrc_unload_game(this.client);
        }
        this.gameLoaded = false;
        this.failPendingEntries('The game was unloaded.');
    }

    // answered by the lbentries message for this request's own id, so several pages can be in flight, e.g. the
    // "top of the board" and "around me" requests the panel makes together
    async fetchLeaderboardEntries(
        leaderboardId: number, firstEntry: number, count: number, aroundUser: boolean,
    ): Promise<VesRaLeaderboardEntries> {
        if (!await this.ensureLoaded() || !this.client || !this.module) {
            throw new Error(this.unavailableReason ?? 'The RetroAchievements engine is unavailable.');
        }
        const begin = this.module._vrc_begin_fetch_leaderboard_entries;
        if (typeof begin !== 'function') {
            throw new Error(this.staleEngineMessage());
        }
        const fetchId = this.nextFetchId++;
        return new Promise<VesRaLeaderboardEntries>((resolve, reject) => {
            this.pendingEntries.set(fetchId, { resolve, reject });
            try {
                begin(
                    this.client,
                    fetchId,
                    leaderboardId,
                    Math.max(1, Math.floor(firstEntry)),
                    Math.min(VRC_MAX_ENTRIES, Math.max(1, Math.floor(count))),
                    aroundUser ? 1 : 0,
                );
            } catch (error) {
                this.pendingEntries.delete(fetchId);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    // rc_client answers its own callbacks even when a request fails, this is for when it never gets the chance:
    // a logout, an unload or the module going away
    protected failPendingEntries(reason: string): void {
        const pending = [...this.pendingEntries.values()];
        this.pendingEntries.clear();
        for (const entry of pending) {
            entry.reject(new Error(reason));
        }
    }

    // for an rcheevos.wasm that predates the export being reached for
    protected staleEngineMessage(): string {
        return 'This RetroAchievements engine has no leaderboard support; '
            + 'rerun packages/core/wasm/rcheevos/build.mjs.';
    }

    reset(): void {
        if (this.client && this.module) {
            this.module._vrc_reset(this.client);
        }
    }

    // kept even without a client, so applyHardcore can arm the one ensureLoaded goes on to create
    setHardcore(enabled: boolean): void {
        this.hardcore = enabled;
        this.applyHardcore();
    }

    protected applyHardcore(): void {
        if (!this.client || !this.module) {
            return;
        }
        const set = this.module._vrc_set_hardcore;
        if (typeof set !== 'function') {
            if (this.hardcore && !this.warnedNoHardcoreExport) {
                this.warnedNoHardcoreExport = true;
                console.warn(
                    '[rcheevos] this rcheevos.wasm has no _vrc_set_hardcore export; '
                    + 'rerun packages/core/wasm/rcheevos/build.mjs to enable hardcore mode.');
            }
            return;
        }
        set(this.client, this.hardcore ? 1 : 0);
    }

    provideResponse(requestId: number, status: number, body: string): void {
        if (!this.client || !this.module) {
            return;
        }
        this.withStrings([body], ([b]) => this.module!._vrc_provide_response(requestId, status, b));
    }

    // called from the drive loop at the same frame break as applyCheats, for the attached simulation only
    doFrame(): void {
        if (!this.gameLoaded || !this.client || !this.module || !this.read) {
            return;
        }
        this.module._vrc_do_frame(this.client);
        // rc_client schedules its own work (the rich-presence ping, retries) and idle gives it a turn, once a second
        if (--this.idleCountdown <= 0) {
            this.idleCountdown = 50;
            this.module._vrc_idle(this.client);
        }
    }

    protected async ensureLoaded(): Promise<boolean> {
        if (this.module) {
            return true;
        }
        if (this.loadAttempted) {
            return false;
        }
        this.loadAttempted = true;

        if (!this.moduleUrl) {
            this.markUnavailable('This build ships no RetroAchievements engine.');
            return false;
        }

        try {
            // importScripts, not import(): this is a classic worker, and tsc's CommonJS output turns import() into a
            // require() that throws in a browser. rcheevos.js is Emscripten glue served beside the worker and defines
            // createVueportRc on the worker global
            const scope = self as unknown as RcWorkerScope;
            const url = this.moduleUrl;
            scope.importScripts(url);
            const factory = scope.createVueportRc;
            if (!factory) {
                this.markUnavailable('The RetroAchievements engine script defined nothing.');
                return false;
            }
            const wasmUrl = url.replace(/\.js$/, '.wasm');
            const module = await factory({
                locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
            });

            module.vrcReadMemory = (address, buffer, length) => this.onReadMemory(address, buffer, length);
            module.vrcServerCall = (id, method, requestUrl, post, contentType) =>
                this.push({
                    kind: 'serverCall',
                    requestId: id,
                    method: method === 'POST' ? 'POST' : 'GET',
                    url: requestUrl,
                    body: post,
                    contentType,
                });
            module.vrcEmit = json => this.onEmit(json);

            this.module = module;
            this.client = module._vrc_create();
            if (!this.client) {
                this.markUnavailable('The RetroAchievements engine could not start.');
                this.module = undefined;
                return false;
            }
            // vrc_create leaves the client softcore, carry over what the DOM asked for before it existed
            this.applyHardcore();
            return true;
        } catch (error) {
            this.markUnavailable(error instanceof Error ? error.message : String(error));
            return false;
        }
    }

    protected markUnavailable(reason: string): void {
        this.unavailableReason = reason;
        this.push({ kind: 'engineUnavailable', reason });
    }

    protected async login(begin: (client: number) => void): Promise<VesRaUser> {
        if (!await this.ensureLoaded() || !this.client) {
            throw new Error(this.unavailableReason ?? 'The RetroAchievements engine is unavailable.');
        }
        if (this.pendingLogin) {
            throw new Error('A RetroAchievements login is already in progress.');
        }
        return new Promise<VesRaUser>((resolve, reject) => {
            this.pendingLogin = { resolve, reject };
            try {
                begin(this.client);
            } catch (error) {
                this.pendingLogin = undefined;
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    // callbacks from the shim

    protected onReadMemory(address: number, buffer: number, length: number): number {
        if (!this.read || !this.module) {
            return 0;
        }
        const real = this.toRealAddress(address >>> 0);
        if (real === undefined) {
            return 0;
        }
        const heap = this.module.HEAPU8;
        for (let i = 0; i < length; i++) {
            const next = this.toRealAddress((address + i) >>> 0);
            if (next === undefined) {
                return i;
            }
            heap[buffer + i] = this.read(next);
        }
        return length;
    }

    // RetroAchievements' Virtual Boy address space: 0x000000 onward is WRAM, 0x010000 onward cartridge RAM,
    // anything past that reads as nothing
    protected toRealAddress(raAddress: number): number | undefined {
        if (raAddress < 0x10000) {
            return (VB_WRAM_BASE + raAddress) >>> 0;
        }
        if (raAddress < 0x20000) {
            return (VB_CART_RAM_BASE + (raAddress - 0x10000)) >>> 0;
        }
        return undefined;
    }

    protected onEmit(json: string): void {
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(json) as Record<string, unknown>;
        } catch {
            return;
        }

        switch (message.t) {
            case 'login': {
                const pending = this.pendingLogin;
                this.pendingLogin = undefined;
                if (!pending) {
                    return;
                }
                if (message.ok && message.user) {
                    const u = message.user as Record<string, unknown>;
                    pending.resolve({
                        username: String(u.username ?? ''),
                        displayName: String(u.display ?? u.username ?? ''),
                        token: String(u.token ?? ''),
                        score: Number(u.score ?? 0),
                        softcoreScore: Number(u.softcore ?? 0),
                        avatarUrl: typeof u.avatar === 'string' ? u.avatar : undefined,
                    });
                } else {
                    pending.reject(new Error(String(message.err ?? 'RetroAchievements refused the login.')));
                }
                return;
            }
            case 'load': {
                this.gameLoaded = Boolean(message.ok && message.game);
                this.idleCountdown = 0;
                // an engine too old to emit a leaderboard list will never send one, so say so rather than leave the panel waiting
                if (this.gameLoaded && typeof this.module?._vrc_begin_fetch_leaderboard_entries !== 'function') {
                    this.push({ kind: 'leaderboards', leaderboards: [], reason: this.staleEngineMessage() });
                }
                const game = message.game as Record<string, unknown> | undefined;
                this.push({
                    kind: 'gameLoaded',
                    game: this.gameLoaded && game ? {
                        id: Number(game.id ?? 0),
                        title: String(game.title ?? ''),
                        iconUrl: String(game.icon ?? ''),
                        achievementCount: Number(game.count ?? 0),
                        pointsTotal: Number(game.points ?? 0),
                    } : undefined,
                    reason: message.ok ? undefined : String(message.err ?? 'not recognized'),
                });
                return;
            }
            case 'achlist': {
                const list = Array.isArray(message.achievements) ? message.achievements : [];
                this.push({
                    kind: 'achievements',
                    achievements: list.map(raw => {
                        const a = raw as Record<string, unknown>;
                        const measured = a.measured as Record<string, unknown> | undefined;
                        // the shim only sends type for the three rc_client calls out (1 missable, 2 progression, 3 win), an ordinary
                        // achievement has none
                        const type = a.type === 1 ? 'missable' : a.type === 2 ? 'progression'
                            : a.type === 3 ? 'win' : undefined;
                        return {
                            id: Number(a.id ?? 0),
                            title: String(a.title ?? ''),
                            description: String(a.desc ?? ''),
                            points: Number(a.points ?? 0),
                            badgeUrl: String(a.badge ?? ''),
                            state: a.state === 'unlocked' ? 'unlocked'
                                : a.state === 'unsupported' ? 'unsupported' : 'locked',
                            unlockedHardcore: Boolean(a.hardcore),
                            bucket: Number(a.bucket ?? 0),
                            measured: measured ? {
                                percent: Number(measured.percent ?? 0),
                                display: String(measured.display ?? ''),
                            } : undefined,
                            type,
                            rarity: typeof a.rarity === 'number' ? a.rarity : undefined,
                            rarityHardcore: typeof a.rarityHardcore === 'number' ? a.rarityHardcore : undefined,
                            unlockTime: typeof a.unlockTime === 'number' ? a.unlockTime : undefined,
                        };
                    }),
                });
                return;
            }
            case 'unlock': {
                this.push({
                    kind: 'unlocked',
                    id: Number(message.id ?? 0),
                    title: String(message.title ?? ''),
                    description: String(message.desc ?? ''),
                    points: Number(message.points ?? 0),
                    badgeUrl: String(message.badge ?? ''),
                    hardcore: Boolean(message.hardcore),
                });
                return;
            }
            case 'challenge': {
                this.push({
                    kind: 'challengeIndicator',
                    id: Number(message.id ?? 0),
                    show: Boolean(message.show),
                    badgeUrl: String(message.badge ?? ''),
                });
                return;
            }
            case 'conn': {
                this.push({ kind: 'connection', online: Boolean(message.online) });
                return;
            }
            case 'lblist': {
                const list = Array.isArray(message.leaderboards) ? message.leaderboards : [];
                this.push({
                    kind: 'leaderboards',
                    leaderboards: list.map(raw => {
                        const l = raw as Record<string, unknown>;
                        return {
                            id: Number(l.id ?? 0),
                            title: String(l.title ?? ''),
                            description: String(l.desc ?? ''),
                            format: l.format === 'time' ? 'time' as const
                                : l.format === 'value' ? 'value' as const : 'score' as const,
                            lowerIsBetter: Boolean(l.lower),
                            state: l.state === 'active' ? 'active' as const
                                : l.state === 'tracking' ? 'tracking' as const
                                    : l.state === 'unsupported' ? 'unsupported' as const
                                        : 'inactive' as const,
                            value: typeof l.value === 'string' ? l.value : undefined,
                        };
                    }),
                });
                return;
            }
            case 'lbattempt': {
                this.push({
                    kind: 'leaderboardAttempt',
                    id: Number(message.id ?? 0),
                    title: String(message.title ?? ''),
                    description: String(message.desc ?? ''),
                    state: message.state === 'started' ? 'started'
                        : message.state === 'failed' ? 'failed' : 'submitted',
                    value: typeof message.value === 'string' ? message.value : undefined,
                });
                return;
            }
            case 'lbtrack': {
                this.push({
                    kind: 'leaderboardTracker',
                    trackerId: Number(message.id ?? 0),
                    show: Boolean(message.show),
                    display: String(message.display ?? ''),
                });
                return;
            }
            case 'lbboard': {
                const top = Array.isArray(message.top) ? message.top : [];
                this.push({
                    kind: 'leaderboardScoreboard',
                    id: Number(message.id ?? 0),
                    submittedScore: String(message.submitted ?? ''),
                    bestScore: String(message.best ?? ''),
                    rank: Number(message.rank ?? 0),
                    total: Number(message.total ?? 0),
                    topEntries: top.map(raw => {
                        const e = raw as Record<string, unknown>;
                        return {
                            rank: Number(e.rank ?? 0),
                            user: String(e.user ?? ''),
                            score: String(e.score ?? ''),
                        };
                    }),
                });
                return;
            }
            case 'lbentries': {
                // settles one fetchLeaderboardEntries by resolving a promise rather than becoming an event, like login
                const pending = this.pendingEntries.get(Number(message.fetch ?? 0));
                if (!pending) {
                    return;
                }
                this.pendingEntries.delete(Number(message.fetch ?? 0));
                if (!message.ok) {
                    pending.reject(new Error(String(
                        message.err ?? 'RetroAchievements did not answer with this leaderboard.')));
                    return;
                }
                const rows = Array.isArray(message.entries) ? message.entries : [];
                pending.resolve({
                    total: Number(message.total ?? 0),
                    userIndex: Number(message.userIndex ?? -1),
                    entries: rows.map(raw => {
                        const e = raw as Record<string, unknown>;
                        return {
                            rank: Number(e.rank ?? 0),
                            user: String(e.user ?? ''),
                            display: String(e.display ?? ''),
                            submitted: Number(e.submitted ?? 0),
                            avatarUrl: typeof e.avatar === 'string' ? e.avatar : undefined,
                        };
                    }),
                });
                return;
            }
        }
    }

    protected push(event: VesRaEvent): void {
        this.outbox.push(event);
        // a tracker update arrives every frame, only from doFrame, whose callers (drive loop, stepFrame) flush the
        // outbox afterwards. Waking the worker for each would be a message per frame; everything else is rare enough to
        // go straight out (see onPush)
        if (event.kind !== 'leaderboardTracker') {
            this.onPush?.();
        }
    }

    // copy strings into the rcheevos heap for one synchronous call, then free them, as every shim entry point
    // taking text does
    protected withStrings<T>(texts: string[], use: (pointers: number[]) => T): T {
        if (!this.module) {
            throw new Error('The RetroAchievements engine is not loaded.');
        }
        const module = this.module;
        const pointers = texts.map(text => {
            const size = module.lengthBytesUTF8(text) + 1;
            const pointer = module._malloc(size);
            module.stringToUTF8(text, pointer, size);
            return pointer;
        });
        try {
            return use(pointers);
        } finally {
            for (const pointer of pointers) {
                module._free(pointer);
            }
        }
    }

    dispose(): void {
        if (this.client && this.module) {
            this.module._vrc_destroy(this.client);
        }
        this.client = 0;
        this.module = undefined;
        this.read = undefined;
        this.pendingLogin?.reject(new Error('The emulator core has been disposed.'));
        this.pendingLogin = undefined;
        this.failPendingEntries('The emulator core has been disposed.');
    }
}
