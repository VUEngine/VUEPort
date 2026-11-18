/**
 * Linking a second player as two windows. Each window is a whole emulator running both machines, its player's and a
 * mirror of the other's driven by the inputs from the channel; only inputs cross. This works because the core is
 * deterministic (measured in `packages/core/tests/determinism-probe.mjs`), and `setLockstep` in `vb-protocol.ts` stops
 * a machine from running past input that hasn't arrived. Netplay would be the same with another `LinkChannel` (a data
 * channel, a negotiated delay).
 */

import { BroadcastChannelLink, LinkSeat } from 'vueport-core/lib/common/link-channel';
import { LinkCartridge, LinkRefusal, LinkReport, LinkSession, LinkState } from 'vueport-core/lib/browser/link-session';
import { EmulatorSession } from 'vueport-core/lib/browser/emulator-core-service';
import { Sim } from 'vueport-core/lib/browser/core/vb-core';
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { ScheduledEdit } from 'vueport-core/lib/common/vb-protocol';

export const LINK_PARAM = 'link';
export const PLAYER_PARAM = 'player';
export const GAME_PARAM = 'game';

export interface LinkInvitation {
    sessionId: string;
    seat: LinkSeat;
    game?: string; // the opener already put the ROM in the shared recent-games store, so only the id travels
}

// the address is the only thing that survives the first window opening the second
export function readInvitation(search: string = window.location.search): LinkInvitation | undefined {
    const params = new URLSearchParams(search);
    const sessionId = params.get(LINK_PARAM);
    if (!sessionId) {
        return undefined;
    }
    const seat = params.get(PLAYER_PARAM) === '2' ? 2 : 1;
    return { sessionId, seat, game: params.get(GAME_PARAM) ?? undefined };
}

function newSessionId(): string {
    return Math.random().toString(36).slice(2, 10);
}

// before there is a game: player 1 invites from the library, so the second window gets a session id but no game and
// waits. Its own channel, as the session protocol starts with both windows running the same cartridge
type LobbyMessage =
    | { kind: 'ask' } // player 2 arriving, in case the game started before it listened
    | { kind: 'game', romId: string } // once the game is in the recent-games store
    | { kind: 'cancel' }; // either side giving up or closing

function openLobby(sessionId: string, onMessage: (message: LobbyMessage) => void): BroadcastChannel {
    const channel = new BroadcastChannel(`vueport.link-lobby.${sessionId}`);
    channel.onmessage = event => {
        const message = event.data as LobbyMessage;
        if (message && typeof message.kind === 'string') {
            onMessage(message);
        }
    };
    return channel;
}

// not in the same task, see `BroadcastChannelLink.dispose`
function closeLobby(channel: BroadcastChannel, farewell?: LobbyMessage): void {
    channel.onmessage = null;
    if (farewell) {
        channel.postMessage(farewell);
    }
    setTimeout(() => channel.close(), 0);
}

// `waiting` is a session nobody joined yet, which can be given up; `relinkable` is no session but a still-open window
// to link to again, as unlinking leaves both
export type LinkStatus = 'idle' | 'relinkable' | 'waiting' | 'linked';

// the same shape whether the other player is a tab, a window or a remote machine
export interface LinkController {
    invite(): void; // picks the last pairing back up if possible, else opens a new window
    leave(): void;
    readonly state: LinkState | undefined;
    readonly status: LinkStatus;
    readonly connected: boolean; // both windows are present, whether or not one is stalling
    readonly refusal: string | undefined; // why the session ended, when it ended badly
    // in player 2's window opened before player 1 had a game, until player 1 starts one; see `LobbyMessage`
    readonly awaitingGame: boolean;
    readonly lobbyGame: string | undefined;
    readonly onDidChange: Event<void>;
}

// `own` is this window's player, `peer` the other's; which seat that is depends on the asking window, which the panels
// need not know
export type LinkEditTarget = 'own' | 'peer';

export interface WebLinkDeps {
    // the desktop shell has to be asked, as a webview cannot open windows; undefined means the browser way. Once open
    // it is that player's window, so there is no close
    openWindow?(query: string): Promise<void>;
    // both at once, as a session needs both and neither exists before a game
    context(): { session: EmulatorSession, romId: string } | undefined;
    romData(): ArrayBuffer | undefined;
    cartridge?(): LinkCartridge | undefined; // see `LinkCartridge`
    // the new window finds the game by checksum in the shared recent-games store, which normally only keeps bytes of
    // ROMs with no other way back. A window nobody clicked in cannot get a folder grant, so the game is put there first
    shareGame(romId: string, data: ArrayBuffer): Promise<void> | void;
    // the enabled cheats, so the mirror starts the same way; see `standingEdits` in `link-session.ts`
    standingEdits(): ScheduledEdit[];
    // undefined when the report could not be written; see `LinkReport` in `link-session.ts`
    saveReport?(report: LinkReport): Promise<string | undefined>;
    peerPaused?(paused: boolean): void;
    notify(message: string): void;
    changed(): void;
}

// one window's half of a link session; the emulator never sees the channel or the protocol
export class WebLink implements LinkController {

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    protected session: LinkSession | undefined;
    protected sessionId: string | undefined;
    protected seat: LinkSeat = 1;
    // set while a pairing is worth picking back up (both windows open with the game, only the session ended), otherwise
    // this window could only invite a third. Cleared when there is nothing to link to
    protected pairing: string | undefined;
    // after a session ended by itself, listens on the pairing's channel for the other window to call (see `LinkCall`),
    // so one press in either window links them again
    protected listener: BroadcastChannelLink | undefined;
    protected announced: LinkRefusal | undefined; // so a redraw does not announce it again
    // player 1's side of a pre-game invitation
    protected lobby: { sessionId: string, channel: BroadcastChannel } | undefined;
    protected awaiting: BroadcastChannel | undefined; // player 2's side, until told the game
    protected receivedGame: string | undefined;
    // given up before a game arrived, so opening a game by hand must not join that session
    protected invitationAbandoned = false;

    constructor(protected readonly deps: WebLinkDeps) { }

    get state(): LinkState | undefined {
        return this.session?.state;
    }

    // a closed session is dropped by `startSession`, so anything held here is running or waiting
    get status(): LinkStatus {
        if (this.session) {
            return this.session.connected ? 'linked' : 'waiting';
        }
        if (this.lobby || this.awaiting) {
            return 'waiting';
        }
        return this.pairing ? 'relinkable' : 'idle';
    }

    get awaitingGame(): boolean {
        return this.awaiting !== undefined;
    }

    get lobbyGame(): string | undefined {
        return this.receivedGame;
    }

    get connected(): boolean {
        return this.session?.connected === true;
    }

    get refusal(): string | undefined {
        return this.session?.refusal?.message;
    }

    get mirror(): Sim | undefined {
        return this.session?.mirrorSim;
    }

    // called once a ROM is running, as a session needs a cartridge to check against the other window's
    joinFromAddress(invitation: LinkInvitation): void {
        if (this.invitationAbandoned) {
            return;
        }
        this.seat = invitation.seat;
        this.startSession(invitation.sessionId);
    }

    // asks once on the way in, in case the game started while loading
    awaitGame(invitation: LinkInvitation): void {
        if (this.awaiting || invitation.game) {
            return;
        }
        const channel = openLobby(invitation.sessionId, message => {
            if (message.kind === 'game') {
                closeLobby(channel);
                this.awaiting = undefined;
                this.receivedGame = message.romId;
                this.notifyChanged();
            } else if (message.kind === 'cancel') {
                closeLobby(channel);
                this.awaiting = undefined;
                this.invitationAbandoned = true;
                this.deps.notify('Player 1 canceled the link.');
                this.notifyChanged();
            }
        });
        this.awaiting = channel;
        channel.postMessage({ kind: 'ask' } satisfies LobbyMessage);
        this.notifyChanged();
    }

    // on every emulator state change. Turns a library invitation into a session: the game goes into the recent-games
    // store, the waiting window is told, and this window starts the session it will join
    gameChanged(): void {
        const lobby = this.lobby;
        if (!lobby || this.session || this.sessionId || !this.deps.context()) {
            return;
        }
        this.startSession(lobby.sessionId, true);
        this.announceGame().catch(() => undefined);
    }

    protected async announceGame(): Promise<void> {
        const context = this.deps.context();
        const data = this.deps.romData();
        if (!context || !data) {
            return;
        }
        // awaited, unlike in `invite`: no pop-up to keep inside a gesture, and the other window should not look early
        await this.deps.shareGame(context.romId, data);
        const lobby = this.lobby;
        if (lobby && this.deps.context()?.romId === context.romId) {
            lobby.channel.postMessage({ kind: 'game', romId: context.romId } satisfies LobbyMessage);
        }
    }

    protected lobbyCanceled(): void {
        const lobby = this.lobby;
        if (!lobby) {
            return;
        }
        closeLobby(lobby.channel);
        this.lobby = undefined;
        this.deps.notify('Player 2 canceled the link.');
        if (this.session && !this.session.connected) {
            this.leave();
            return;
        }
        this.notifyChanged();
    }

    protected closeLobby(farewell?: LobbyMessage): void {
        if (this.lobby) {
            closeLobby(this.lobby.channel, farewell);
            this.lobby = undefined;
        }
        if (this.awaiting) {
            closeLobby(this.awaiting, farewell);
            this.awaiting = undefined;
            this.invitationAbandoned = true;
        }
    }

    invite(): void {
        if (this.session || this.lobby || this.awaiting) {
            return;
        }
        const context = this.deps.context();
        if (!context) {
            this.inviteFromLibrary();
            return;
        }
        // picking the last pairing back up keeps the seat and opens no window, as the paired one is still there
        this.stopListening();
        if (this.pairing) {
            this.startSession(this.pairing, true, true);
            return;
        }
        const id = newSessionId();
        this.seat = 1;
        this.startSession(id, true);

        // not awaited, as `window.open` must stay inside the gesture or a pop-up blocker eats it; the other window
        // looks again if early (see the invitation in `app.tsx`)
        const cartridge = this.deps.romData();
        if (cartridge) {
            this.deps.shareGame(context.romId, cartridge);
        }

        this.openSecondWindow(new URLSearchParams({
            [LINK_PARAM]: id,
            [PLAYER_PARAM]: '2',
            [GAME_PARAM]: context.romId,
        }).toString());
    }

    // only the lobby for now, as a session needs a cartridge; enough for the link button to show waiting and to give up
    protected inviteFromLibrary(): void {
        this.stopListening();
        this.pairing = undefined;
        const id = newSessionId();
        this.seat = 1;
        const channel = openLobby(id, message => {
            if (message.kind === 'ask') {
                if (this.deps.context()) {
                    this.announceGame().catch(() => undefined);
                }
            } else if (message.kind === 'cancel') {
                this.lobbyCanceled();
            }
        });
        this.lobby = { sessionId: id, channel };
        this.notifyChanged();
        this.openSecondWindow(new URLSearchParams({
            [LINK_PARAM]: id,
            [PLAYER_PARAM]: '2',
        }).toString());
    }

    protected openSecondWindow(query: string): void {
        if (this.deps.openWindow) {
            this.deps.openWindow(query).catch(error => {
                this.leave();
                this.deps.notify(
                    `VUEPort could not open the second player's window: ${String(error)}`);
            });
            return;
        }

        const url = new URL(window.location.href);
        url.search = query;
        // a pop-up blocker answers null, and a session would wait forever for that window
        if (!window.open(url.toString(), '_blank')) {
            this.leave();
            this.deps.notify(
                'VUEPort could not open the second player’s window. Allow pop-ups for this site and try again.');
        }
    }

    // does not close the other window, which belongs to the user in front of it, even if player 1 opened it. Both sides
    // keep playing alone with a pairing either can pick back up; giving up on an unanswered session drops the pairing
    // too, so pressing again looks for a new partner
    leave(): void {
        const lobbied = this.lobby !== undefined || this.awaiting !== undefined;
        this.closeLobby({ kind: 'cancel' });
        const session = this.session;
        if (!session) {
            if (lobbied) {
                this.notifyChanged();
            }
            return;
        }
        const keepPairing = session.connected;
        session.dispose('session');
        this.session = undefined;
        this.sessionId = undefined;
        this.pairing = keepPairing ? this.pairing : undefined;
        this.announced = undefined;
        this.notifyChanged();
    }

    setKeys(keys: number): void {
        this.session?.setKeys(keys);
    }

    setTurbo(keys: number, rate: number): void {
        this.session?.setTurbo(keys, rate);
    }

    // in both windows at once, for cheat switches and debugger pokes. False without a session, the caller then writes
    // into its own machine
    scheduleEdits(target: LinkEditTarget, edits: ScheduledEdit[]): boolean {
        const session = this.session;
        if (!session?.connected) {
            return false;
        }
        const own = this.seat;
        const peer: LinkSeat = own === 1 ? 2 : 1;
        return session.scheduleEdits(target === 'own' ? own : peer, edits);
    }

    // undefined when not linked
    async snapshot(): Promise<{ p1: ArrayBuffer, p2: ArrayBuffer } | undefined> {
        return this.session?.snapshot();
    }

    async resume(p1: ArrayBuffer, p2: ArrayBuffer): Promise<void> {
        await this.session?.resume(p1, p2);
    }

    // see `LinkRestart`
    async restart(): Promise<void> {
        await this.session?.restart();
    }

    setPaused(paused: boolean): void {
        this.session?.setPaused(paused);
    }

    // `rejoin` picks a pairing back up; with both games running the same code they carry on instead of restarting (see
    // `LinkBegin.hot`)
    protected startSession(sessionId: string, calling = false, rejoin = false): void {
        const context = this.deps.context();
        if (!context || this.session) {
            return;
        }
        const { session: emulatorSession, romId } = context;
        this.sessionId = sessionId;
        this.pairing = sessionId;
        this.announced = undefined;

        emulatorSession.core.stateSize().then(core => {
            // the ROM may have been closed while we were asking
            if (this.sessionId !== sessionId) {
                return;
            }
            const session = new LinkSession({
                session: emulatorSession,
                channel: new BroadcastChannelLink(sessionId),
                seat: this.seat,
                rom: romId,
                romData: () => this.deps.romData(),
                standingEdits: () => this.deps.standingEdits(),
                cartridge: () => this.deps.cartridge?.(),
                onPeerPaused: paused => this.deps.peerPaused?.(paused),
                calling,
                rejoin,
                onReport: report => {
                    this.deps.saveReport?.(report).then(path => {
                        if (path) {
                            this.deps.notify(`A report of what went wrong was saved to ${path}.`);
                        }
                    }).catch(error => console.warn('[vueport] could not save the link report:', error));
                },
                core,
            });
            this.session = session;
            session.onDidChange(() => {
                // once per reason, as a session fires this on every state change while still carrying a refusal
                const refusal = session.refusal;
                if (refusal && refusal !== this.announced) {
                    this.announced = refusal;
                    this.deps.notify(refusal.message);
                }
                // both windows are running the game: nothing left to tell
                if (session.connected) {
                    this.closeLobby();
                }
                // a closed session is dropped, as `invite` refuses while one exists; the pairing only when the other
                // window is gone, as a desync, timeout or failure leaves both windows open
                if (session.state === LinkState.Closed) {
                    const windowGone = session.refusal?.reason === 'closed';
                    // `ended`, as nobody here unlinked, so neither window waits on the other and both can link again
                    session.dispose(windowGone ? 'session' : 'ended');
                    this.session = undefined;
                    this.sessionId = undefined;
                    if (windowGone) {
                        this.pairing = undefined;
                    } else if (this.pairing) {
                        this.listenForCall(this.pairing);
                    }
                }
                this.notifyChanged();
            });
            session.start();
            this.notifyChanged();
        }).catch(() => {
            this.sessionId = undefined;
        });
    }

    protected listenForCall(pairing: string): void {
        this.stopListening();
        const listener = new BroadcastChannelLink(pairing);
        listener.onMessage(message => {
            if (message.kind !== 'call' || message.seat === this.seat) {
                return;
            }
            if (this.session || this.pairing !== pairing || !this.deps.context()) {
                return;
            }
            this.stopListening();
            // not calling back: the other window is already asking, and one of them says hello until they meet
            this.startSession(pairing, false, true);
        });
        this.listener = listener;
    }

    protected stopListening(): void {
        this.listener?.dispose();
        this.listener = undefined;
    }

    protected notifyChanged(): void {
        this.deps.changed();
        this.onDidChangeEmitter.fire();
    }

    // not `leave`: says `window` rather than `session`, so the other window ends its session instead of waiting
    dispose(): void {
        this.stopListening();
        this.closeLobby({ kind: 'cancel' });
        this.session?.dispose('window');
        this.session = undefined;
        this.sessionId = undefined;
        this.pairing = undefined;
        this.onDidChangeEmitter.dispose();
    }
}
