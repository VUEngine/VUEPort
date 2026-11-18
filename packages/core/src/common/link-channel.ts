import { Disposable, Emitter, Event } from './emulator-events';
import { ScheduledEdit } from './vb-protocol';

// only inputs and what is needed to agree on what is played travel between two linked windows. Both run the whole pair
// of machines and stay identical because the core is deterministic (tests/determinism-probe.mjs), so this works over a
// BroadcastChannel, the desktop shell or a data channel alike
export type LinkMessage =
    | LinkHello
    | LinkWelcome
    | LinkBegin
    | LinkHandover
    | LinkResume
    | LinkRestart
    | LinkPause
    | LinkCall
    | LinkInput
    | LinkEdit
    | LinkDigest
    | LinkGoodbye;

export type LinkSeat = 1 | 2;

// bumped whenever the meaning of anything below changes; disagreeing windows are refused rather than desyncing later
export const LINK_PROTOCOL_VERSION = 5;

// sent by a joining window, repeatedly, until it is answered
export interface LinkHello {
    kind: 'hello';
    seat: LinkSeat;
    protocol: number;
    rom: string; // the cartridge's CRC32 string; linking two different games would only look like a desync
    // the size of the core's state struct, the cheapest thing that changes with the core; different builds would drift
    core: number;
    // Sim.runningCartridge of this window's machine; with `rejoin`, decides whether both games are picked up where they
    // are instead of restarted (see LinkBegin.hot)
    running?: string;
    // two windows that have played together linking again. Only then are running games picked up as they are: on a
    // first link the second window is at the title screen of a game it just opened, and restarting both makes sense
    rejoin?: boolean;
}

// one machine as it stands, for the other window's mirror: the core's state, plus the written part of its save
// (which a state does not hold) and the window it answers on
export interface LinkMachine {
    state: ArrayBuffer;
    cartRam: ArrayBuffer;
    cartRamWindow: number;
}

// the answer, from the window already in the session
export interface LinkWelcome {
    kind: 'welcome';
    seat: LinkSeat;
    protocol: number;
    rom: string;
    core: number;
    // frames between a press and the machines acting on it, decided by the answering window so both use one number.
    // Too little and the machines stall waiting for each other, too much and the controls feel loose
    delay: number;
}

/**
 * Starts both windows' machines from power-on at frame zero, as two running windows would be hundreds of frames
 * apart. The cartridge save RAM travels with it, being the one part of a fresh machine that differs between sides.
 * Only player 1's window sends it, which is why one window answers a hello rather than both answering each other.
 */
export interface LinkBegin {
    kind: 'begin';
    seat: LinkSeat;
    // the authority's save RAM, only as far up the window as the game has written (the window is 16 MiB by default);
    // the rest is zero on both sides, see expandCartRam
    cartRam: ArrayBuffer;
    // the authority's save window width, as a setting the two applications need not agree on: a save answering on
    // 16 KiB in one and 16 MiB in the other would mirror in only one and desync on the first read past the smaller
    cartRamWindow: number;
    // the cartridge as the authority runs it when a ROM patch or colorization changed it, which is the game for all
    // four machines from here on (the hello only checks both opened the same file). Absent when unpatched
    image?: ArrayBuffer;
    // whether the machines are VB Color consoles; the authority's answer, as a colorized image asks for one in its
    // header and the joining window's settings may say otherwise
    vbc?: boolean;
    // whether the cartridge has an ESSound chip: it answers the game's init with an interrupt, so machines with and
    // without it diverge. The authority's answer, even if only one window has the tracks
    esSound?: boolean;
    /**
     * Player 1's machine as it stands, when relinking two windows running the very same code (LinkHello.rejoin and
     * LinkHello.running) picks both games up where they are. Each window keeps its own machine and builds its mirror
     * from the other's state; cartRam and the cartridge fields are ignored. Player 2 answers with a LinkHandover, and
     * player 1 begins once it has it.
     */
    hot?: LinkMachine;
    epoch: number; // always zero: this is the first run. See LinkInput.epoch
}

// player 2's machine as it stands, answering a LinkBegin that carried player 1's
export interface LinkHandover {
    kind: 'handover';
    seat: LinkSeat;
    machine: LinkMachine;
}

// puts both windows back to a saved moment and restarts counting. Named by player, not window: player 1's window has p1
// as its own machine and p2 as its mirror, player 2's the other way round
export interface LinkResume {
    kind: 'resume';
    seat: LinkSeat;
    epoch: number;
    p1: ArrayBuffer;
    p2: ArrayBuffer;
}

// a reset in one window only would leave the other copy running, and in the worker it throws away every booking,
// so it restarts the session: every machine to power-on, frame count at zero, save RAM as it stands on both sides
export interface LinkRestart {
    kind: 'restart';
    seat: LinkSeat;
    epoch: number;
}

// a paused window books no input, so the other would wait and, ten seconds later, decide the player had gone. Said
// instead, both pause together and either one can carry on for both
export interface LinkPause {
    kind: 'pause';
    seat: LinkSeat;
    paused: boolean;
}

// a player pressed link, asking the other window to take part again. After a session ended by itself (a desync, a
// player who stopped answering) neither window has one to send a hello from; a window whose session ended that way
// listens for this and joins, one whose player unlinked on purpose does not
export interface LinkCall {
    kind: 'call';
    seat: LinkSeat;
}

// one seat's controller mask for one frame. The hot path, and the whole point
export interface LinkInput {
    kind: 'input';
    seat: LinkSeat;
    frame: number;
    keys: number;
    // which run of the session this belongs to: frame numbers restart at zero with the session, so a message in flight
    // when a state is loaded would land on a frame of the new run. Counted up on every restart, ignored if it differs
    epoch: number;
}

/**
 * A change made to one of the machines from outside it (cheats, debugger pokes), booked against the frame it takes
 * effect on. Nothing else carries it to the other window: without it, a cheat switched on mid-session would end the
 * session at the digest check. The seat names the machine being changed, not the window asking, so either window can
 * poke either machine. See scheduleEdits in link-session.ts for how the frame is chosen.
 */
export interface LinkEdit {
    kind: 'edit';
    seat: LinkSeat;
    epoch: number;
    frame: number;
    edits: ScheduledEdit[];
}

// the safety net: this window's machine at frame N is the other window's mirror at frame N, so differing digests
// mean they have come apart. Sent about once a second; a digest costs some 2% of a frame
export interface LinkDigest {
    kind: 'digest';
    seat: LinkSeat;
    epoch: number;
    frame: number;
    digest: number;
}

// sent when a window leaves, so the other stops waiting for it. A player who unlinked can be linked again in a
// moment, so the other window goes back to waiting; a closing window is gone
export interface LinkGoodbye {
    kind: 'bye';
    seat: LinkSeat;
    // `session`: unlinked, still open. `window`: going away. `ended`: the session ended by itself on that side (a
    // desync, a player who stopped answering) and the window is still open, so one press in either picks it back up
    // (LinkCall)
    leaving: 'session' | 'window' | 'ended';
}

// the seam the transports plug into: BroadcastChannelLink below for two tabs of one origin, the desktop shell and
// netplay are others
export interface LinkChannel extends Disposable {
    send(message: LinkMessage): void;
    readonly onMessage: Event<LinkMessage>;
}

// a channel per session id, so two link sessions in one browser do not hear each other. The browser does not
// deliver a channel's own messages back to the sender
export class BroadcastChannelLink implements LinkChannel {

    protected readonly channel: BroadcastChannel;
    protected readonly onMessageEmitter = new Emitter<LinkMessage>();
    readonly onMessage: Event<LinkMessage> = this.onMessageEmitter.event;
    // set the moment this end is given up, before the channel is closed (see dispose). A closed channel throws on
    // postMessage, and a last input booking can still be on its way out while a session is taken down
    protected closed = false;

    constructor(sessionId: string) {
        this.channel = new BroadcastChannel(`vueport.link.${sessionId}`);
        this.channel.onmessage = event => {
            const message = event.data as LinkMessage;
            if (message && typeof message.kind === 'string') {
                this.onMessageEmitter.fire(message);
            }
        };
    }

    send(message: LinkMessage): void {
        if (this.closed) {
            return;
        }
        this.channel.postMessage(message);
    }

    // the handler comes off at once, but the channel is closed in a later task: closing in the same task can drop a
    // message posted a moment earlier, and that is always the goodbye, leaving the other window believing it is linked
    dispose(): void {
        this.channel.onmessage = null;
        this.closed = true;
        setTimeout(() => this.channel.close(), 0);
        this.onMessageEmitter.dispose();
    }
}
