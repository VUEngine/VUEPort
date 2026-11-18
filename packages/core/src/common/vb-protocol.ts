// messages between the DOM thread and the core worker, each command a request/response pair correlated by id,
// so callers get a promise per call instead of relying on message ordering

import { LiveProfileSnapshot } from './emulator-live-profile';
import { DisplayMode, DisplayOutput } from './vb-constants';

export type SimHandle = number;

// input only changes between the drive loop's fixed-size chunks, so a session is its starting state plus the mask
// at each chunk where it changed
export interface Recording {
    state: ArrayBuffer;
    chunks: number; // chunks recorded, which is how long the replay runs for
    keys: [number, number][]; // [chunk, mask] pairs, at the chunks where the mask changed
}

export interface ProfileNode {
    parent: number;
    address: number;
    selfSamples: number;
    totalSamples: number;
}

export interface ProfileResult {
    nodes: ProfileNode[];
    instructions: number; // instructions executed, which is what the samples add up to
    overflows: number;
    // how many times the machine restarted while recording; a profile spanning reboots describes several runs
    resets: number;
    elapsedMs: number;
}

// a coarse stereo frame used to color the immersion halo
export interface Backdrop {
    // legacy eye brightness (one RGBA cell per grid cell) or VBC RGB888 (two RGBA cells per grid cell: left, then right)
    pixels: ArrayBuffer;
    colorMode: boolean;
}

// what frame blending mixes a frame with: `next` (moved on by a frame or rewind step) blends with the frame before;
// `replace` (the same moment redrawn after a change while paused) keeps blending with what came before the replaced
// frame; `jump` (a loaded state) does not blend
export type FrameKind = 'next' | 'replace' | 'jump';

export interface Frame {
    // legacy eye brightness (384 x 224 RGBA) or VBC RGB888 (768 x 224 RGBA, left eye then right eye side by side)
    pixels: ArrayBuffer;
    colorMode: boolean;
    kind?: FrameKind; // how it follows the frame before; `next` when absent
}

// the rewind history as the filmstrip sees it. Captures are numbered oldest first, the last is now
export interface RewindHistory {
    // the emulated frame each capture was taken on, counted from when the history began; empty without a history
    frames: number[];
    thumbnails: number[]; // the captures that have a thumbnail, ascending; one about every second and always the newest
    cursor: number;
}

// a frame sent to a main-thread renderer, tagged against canvas replacement
export interface VideoFrame extends Frame {
    sim: SimHandle;
    presentation: number;
}

export interface CoreCommands {
    // must be sent first
    init: {
        params: {
            wasmUrl: string;
            // URL of the RetroAchievements engine's Emscripten glue (rcheevos.js), loaded lazily with importScripts. Undefined for
            // a host or build without rcheevos.wasm, and RetroAchievements then reports itself unavailable rather than failing
            rcheevosModuleUrl?: string;
        };
        result: void;
    };
    createSim: { params: Record<string, never>; result: SimHandle };
    deleteSim: { params: { sim: SimHandle }; result: void };
    // ordinarily the canvas is transferred and rendered in the worker. A WebKitGTK host instead supplies a small pool of
    // buffers the worker fills and transfers to the page's WebGL2 renderer, which returns each after uploading it
    attachCanvas: {
        params: { sim: SimHandle; canvas: OffscreenCanvas } | {
            sim: SimHandle;
            mainThread: { presentation: number; buffers: ArrayBuffer[] };
        };
        result: void;
    };
    setCartRom: { params: { sim: SimHandle; rom: ArrayBuffer }; result: void }; // the buffer is transferred
    setCartRam: { params: { sim: SimHandle; ram: ArrayBuffer }; result: void }; // the buffer is transferred
    // the window is all of Game Pak RAM, so without `length` this is a 16 MiB copy through postMessage;
    // every caller that knows (after cartRamInfo they all do) should pass it
    getCartRam: {
        params: { sim: SimHandle; length?: number };
        result: ArrayBuffer;
    };
    // the size of the save window and how far into it the game has written, answered in the worker so 16 MiB need not
    // be copied out. See saveRamHighWater for how `used` is known without watching every write
    cartRamInfo: {
        params: { sim: SimHandle };
        result: { size: number; used: number };
    };
    // the size of the core's state struct, the cheapest fingerprint of the core build. Linked windows compare it before
    // starting, so a tab left open across a deploy is refused rather than desyncing
    stateSize: { params: Record<string, never>; result: number };
    reset: { params: { sim: SimHandle }; result: void };
    setHardwareMode: { params: { sim: SimHandle; vbc: boolean }; result: boolean }; // does not activate VBCEN
    // effective immediately. Ignored under setLockstep, where only masks booked with queueKeys may reach the machine,
    // or a press in flight when a link session started would land on one window's copy only
    setKeys: { params: { sim: SimHandle; keys: number }; result: void };
    // pressed for `rate` frames, released for `rate` frames, applied by the drive loop on top of setKeys's mask and
    // counted on the frame number, so the rhythm holds at any speed; zero lets go. Ignored under setLockstep, where the
    // session books every frame's mask itself, turbo included (fillSchedule in link-session.ts)
    setTurbo: { params: { sim: SimHandle; keys: number; rate: number }; result: void };
    // books a mask against its frame number, applied by the drive loop as that frame comes up, so a press lands on the
    // same frame on two linked machines. Frames are counted like the `speed` report; a frame already emulated is
    // refused, as a link session needs to know
    queueKeys: {
        params: { sim: SimHandle; frame: number; keys: number };
        result: void;
    };
    // the other half of queueKeys: the drive loop stops at the first frame without a booked mask and reports
    // Events.awaitingInput rather than running on with a stale one, keeping two machines in step. Off by default
    setLockstep: { params: { sim: SimHandle; enabled: boolean }; result: void };
    // over the registers and the three writable memory regions rather than the state struct, which also holds absolute
    // pointers and an address-hashed cache that differ harmlessly between core instances (tests/determinism-probe.mjs)
    stateDigest: {
        params: { sim: SimHandle };
        result: { frame: number; digest: number };
    };
    // taken on a frame number, so both windows digest exactly the same point of the run ("now" differs between them).
    // Zero turns it off; costs about 2% of a frame each time
    setDigestPeriod: { params: { sim: SimHandle; frames: number }; result: void };
    // everything a lockstepped machine was given since lockstep went on (resets, masks it ran with, booked writes, digests),
    // to replay against the core and see why two windows parted. Kept only under lockstep, and bounded
    linkJournal: { params: { sim: SimHandle }; result: LinkJournalEntry[] };
    // also resizes the presentation surface
    setDisplayMode: { params: { sim: SimHandle; mode: DisplayMode }; result: void };
    // where an interleaved picture is really shown, so it is drawn at that size rather than enlarged; undefined for the
    // mode's own size. See DisplayOutput
    setDisplayOutput: { params: { sim: SimHandle; output?: DisplayOutput }; result: void };
    // as a PNG; with no `mode` exactly what is on screen. With one, the frame is composed again in a renderer of the
    // worker's own, so a screenshot can differ in mode and palette without the live picture flickering. `scale` is a
    // whole multiple of the mode's own size
    capture: {
        params: { sim: SimHandle; mode?: DisplayMode; scale?: number };
        result: ArrayBuffer
    };
    setVolume: { params: { sim: SimHandle; volume: number }; result: void }; // 0 to 10
    setPanning: { params: { sim: SimHandle; panning: number }; result: void }; // -1 to +1
    run: { params: Record<string, never>; result: void }; // audio-clocked emulation of every attached simulation
    suspend: { params: Record<string, never>; result: void };
    saveState: { params: { sim: SimHandle }; result: ArrayBuffer };
    // `clearCaches` empties the CPU's instruction cache after, for a state made with another ROM (SaveStateOtherRomError)
    loadState: { params: { sim: SimHandle; state: ArrayBuffer; clearCaches?: boolean }; result: void };
    // emulation is deterministic, so the state now plus the input from here reproduces the session for exhaustive
    // profiling later; costs a snapshot and a few bytes per chunk
    startProfileRecording: { params: { sim: SimHandle }; result: void };
    stopProfileRecording: { params: { sim: SimHandle }; result: Recording };
    // on a scratch simulation, following every instruction; runs to completion before replying (a minute of play takes
    // some seconds, §6.3)
    replayProfile: {
        params: { sim: SimHandle; recording: Recording };
        result: ProfileResult;
    };
    // a per-frame profile measured as the game runs. Costs a callback on every instruction (around a fifth of the core's
    // headroom over real time), so it is only on while a visible panel shows it
    setLiveProfiler: {
        params: { sim: SimHandle; enabled: boolean; window?: number };
        result: void;
    };
    // undefined when nothing is being profiled, an ordinary state (asked before profiling starts, or after the machine went)
    readLiveProfile: {
        params: {
            sim: SimHandle;
            // a frame to unpack as well, by its number since profiling began; silently absent once it has left the window
            pin?: number;
        };
        result: LiveProfileSnapshot | undefined;
    };
    // 1 is real time, above fast forwards, below is slow motion; applies to the whole session
    setSpeed: { params: { speed: number }; result: void };
    // stereo parallax in percent, 0 to 200: 100 is the real console, 0 shows both eyes the same picture. Scales the
    // parallax of worlds and objects as the VIP draws them, from the next frame; applies to the whole session, link
    // mirrors included, and survives loading a state
    setStereoDepth: { params: { depth: number }; result: void };
    // whether frames show the column table's effect on where columns land (vb-column-geometry.ts). A game on Nintendo's
    // table looks the same either way; applies to the whole session from the next frame shown
    setColumnGeometry: { params: { enabled: boolean }; result: void };
    // a loaded or reset game comes up like the display unit switched on: dark, then a picture whose width sways into place
    // over a few seconds (mirrorSpinUp). Only what is shown; `fullDelay` keeps it dark for the real unit's whole 4 seconds
    setMirrorSpinUp: { params: { enabled: boolean; fullDelay: boolean }; result: void };
    stepFrame: { params: Record<string, never>; result: void }; // then stop
    // disabling it releases the memory
    setRewind: {
        params: { enabled: boolean; granularity: number; budgetBytes: number };
        result: void
    };
    // returns how many entries were actually applied; fewer than asked means the buffer ran out
    rewindStep: { params: { count?: number }; result: number };
    // the history for the filmstrip, taken while suspended: now is captured first, with a thumbnail, so going back to
    // the newest capture returns exactly here. Seeking moves freely; captures after the one landed on are let go once
    // the machine runs again
    rewindHistory: { params: { sim: SimHandle }; result: RewindHistory };
    // to a capture, by its index in the history; shown at once. Returns the index landed on
    rewindSeek: { params: { index: number }; result: number };
    // the thumbnail taken with a capture as a PNG, composed to thumbnailDisplayMode of the simulation's; undefined for a
    // capture without one
    rewindThumbnail: { params: { sim: SimHandle; index: number }; result: ArrayBuffer | undefined };
    // the same uncomposited, enlarged back to a whole frame, for a DOM thread that presents itself (see readFrame)
    readRewindThumbnail: { params: { index: number }; result: Frame | undefined };
    // a peer of 0 disconnects; both must belong to this session. `order` is which end of the cable `sim` is (1 or 2):
    // one Emulate call advances the pair, and its result depends on the order, so mirroring windows must name the same
    // one (see orderedSims in vb-worker.ts)
    setPeer: {
        params: { sim: SimHandle; peer: SimHandle; order?: 1 | 2 };
        result: void
    };

    // the core composites eye-packed: red carries the left eye's brightness, green the right eye's. Read from the core's
    // framebuffer, so it works whether or not the simulation is presented anywhere
    readPixels: {
        params: { sim: SimHandle; x: number; y: number; width: number; height: number };
        result: ArrayBuffer
    };
    // one RGBA quad per cell, left/right brightness in R/G; VBC output has two quads per cell (left RGB888, then right),
    // flagged by `colorMode`. Averaged here for the immersion halo: a 16x10 grid is 640 bytes, the frame 344 kB
    readBackdrop: {
        params: { sim: SimHandle; columns: number; rows: number };
        result: Backdrop
    };
    // recomposites and presents the picture without emulating, for a paused machine whose video state was edited from
    // outside (a palette written while paused would otherwise not appear until the game was let go). Nothing is stepped;
    // the same recompositing a restored save state gets
    refreshFrame: { params: { sim: SimHandle }; result: void };
    // the current frame and up to two before it, most recent first, for a screenshot that blends like the screen
    // (see FrameHistory)
    readFrame: {
        params: { sim: SimHandle };
        result: Frame & { previous: Frame[] };
    };
    /**
     * Mirrors every presented frame to the DOM thread for a video recording, as a canvas transferred to a worker
     * cannot be captured. The frames come as the uncomposited transport buffers attachCanvas hands a main-thread
     * renderer. This is in addition to live rendering; no `tap` stops it and drops the buffers.
     */
    setVideoTap: {
        params: {
            sim: SimHandle;
            tap?: { presentation: number; buffers: ArrayBuffer[] };
        };
        result: void;
    };
    // while held, the worker leaves the page's picture alone (no upload, draw or transfer to a DOM-thread renderer), for
    // a taker showing every frame in its place, like the headset where nobody sees the page; screenshots are redrawn
    // from the frame instead. Releasing it shows the current frame on the page again
    holdPage: {
        params: { sim: SimHandle; held: boolean };
        result: void;
    };
    // as the CPU would see it
    readMemory: {
        params: { sim: SimHandle; address: number; length: number };
        result: ArrayBuffer
    };
    // the buffer is transferred
    writeMemory: {
        params: { sim: SimHandle; address: number; data: ArrayBuffer };
        result: void
    };
    readRegisters: { params: { sim: SimHandle }; result: Registers };
    // `before` starts the listing that many instructions earlier, the only exact way back through variable-length
    // instructions, as the core walks back through its own decoding
    disassemble: {
        params: { sim: SimHandle; address: number; count: number; before?: number };
        result: DisassemblyLine[]
    };
    // the complete set, as the worker keeps no identity per breakpoint; an empty list takes the per-instruction
    // callback off. Costs about a sixth of emulation while armed (tests/breakpoint-probe.mjs); the core lets the
    // callback refuse an instruction, so a stop lands on it
    setBreakpoints: { params: { sim: SimHandle; addresses: number[] }; result: void };
    // only while suspended, like stepFrame, and done the same way: a short burst of clocks from here, not the drive loop,
    // so the machine stays stopped throughout
    stepInstruction: { params: { sim: SimHandle }; result: void };
    // only lays the trap, as resuming is the host's business (pause state, audio, chrome). Gone once hit, so running to a
    // line leaves no gutter mark; stepping over a call arms the instruction after it this way
    runTo: { params: { sim: SimHandle; address: number }; result: void };
    // off by default, as capturing means a callback on every CPU write
    setTerminalCapture: { params: { sim: SimHandle; enabled: boolean }; result: void };
    // for a peripheral on the other end of a real cable (a rumble pack). Off by default: a callback on every CPU write,
    // with nothing listening unless a physical device is plugged in
    setLinkCapture: { params: { sim: SimHandle; enabled: boolean }; result: void };
    // one address per simulation, zero stops. Narrower writes are ignored, as a pointer is stored whole
    setPointerWatch: { params: { sim: SimHandle; address: number }; result: void };
    /**
     * Stops the machine after the next CPU write into any of these ranges, once (the stop takes the ranges with it);
     * the stop says which instruction wrote (StopWrite). Not the VB Color DMA. VIP and VCU addresses are decoded as
     * those units do, 512 KiB and 1 MiB repeated across their regions, so any mirror hits; the character memory's
     * second window at 0x00078000 is a range of its own. Like breakpoints, not available while two players are linked.
     */
    setWriteStop: { params: { sim: SimHandle; ranges: { address: number; length: number }[] }; result: void };
    // what draws each pixel (world, BG map cell or object, character and its pixel) for the screen inspector, see
    // vb-pixel-origin.ts. One simulation at a time, as the core allows; doubles drawing cost, so only in Debug mode
    setPixelOrigins: { params: { sim: SimHandle; enabled: boolean }; result: void };
    // as runs (decodeOriginRuns), taken at the same frame break as the picture. Empty while origins are not kept;
    // `unknown` for what nothing has drawn since they were
    readPixelOrigins: { params: { sim: SimHandle }; result: ArrayBuffer };
    // sends Events.pixelOrigins with every picture shown, for marks that move with it; asked for, they would lag behind
    streamPixelOrigins: { params: { sim: SimHandle; enabled: boolean }; result: void };
    // repeats the writes at every frame break, where the game keeps changing the value; the drive loop does it in place
    // rather than a message per code per frame. An empty list turns them off
    setCheats: { params: { sim: SimHandle; codes: VbCheatWrite[] }; result: void };
    // the write-side twin of queueKeys: setCheats and writeMemory land whenever their message arrives, so a cheat
    // switched on a few frames apart in two linked windows would desync them. Booked against a frame both windows can
    // still reach; refused for one already emulated
    queueEdits: {
        params: { sim: SimHandle; frame: number; edits: ScheduledEdit[] };
        result: void;
    };
    // where an ESSound cartridge listens, so the halfwords a game writes there play on this side; only on while the ROM
    // has ESSound files beside it
    setEsSoundCapture: { params: { sim: SimHandle; enabled: boolean }; result: void };
    // reports the save region's reads as well as writes, so a list shows whether a game found what it saved; fetches
    // are separate, so reads are real loads. Two switches, as reading may happen every frame (Wario Land) and writes
    // alone install one callback
    setSramCapture: {
        params: {
            sim: SimHandle;
            writes: boolean;
            reads: boolean;
        };
        result: void;
    };
    /**
     * The VSU as it stands: VB_VSU_MAP_BYTES from VB_VSU_BASE (waveform banks, modulation table, six channel register
     * blocks). The range cannot be read, on this core as on the machine (see VB_VSU_BASE), so the worker composes it
     * from the core's decoded VSU copy in the simulation struct: a channel playing since before a panel opened reads
     * as playing, one switched off by its interval as off. Where the core holds both what a channel was given and what
     * it does (an envelope's level, a swept frequency), the latter comes back. See worker/vb-vsu-layout.ts, which
     * throws through this call if it cannot find the layout.
     */
    readVsu: { params: { sim: SimHandle }; result: VsuReading };
    /**
     * Mutes channels in the mixer, not the game: `channels` is a bitmask, bit n for channel n, and zero unmutes all (a
     * closing panel sends that). The game keeps writing the VSU, and VsuReading still carries a muted channel's stereo
     * levels. Free when nothing is muted, otherwise two bytes per muted channel per frame; dropped with the simulation,
     * so a reset machine comes back at full voice.
     */
    setVsuMutes: { params: { sim: SimHandle; channels: number }; result: void };

    // RetroAchievements: rcheevos runs in the worker, as evaluating a set reads memory synchronously once a frame. The DOM
    // side keeps the account, shows the panel and performs every server call for the engine, as only the desktop shell
    // can reach the RetroAchievements API (see vb-rcheevos.ts)

    // returns the account and the API token to keep instead of the password; rejects if the credentials are refused or
    // the engine is unavailable
    raLoginPassword: { params: { username: string; password: string }; result: VesRaUser };
    raLoginToken: { params: { username: string; token: string }; result: VesRaUser }; // same result and failures
    raLogout: { params: Record<string, never>; result: void }; // any loaded game is unloaded with it
    // by its RetroAchievements hash (whole-file MD5). Returns at once, as identifying and loading are server calls the DOM
    // services; the outcome arrives as `retroAchievements` events (gameLoaded, then achievements)
    raLoadGame: { params: { sim: SimHandle; hash: string }; result: void };
    raUnloadGame: { params: Record<string, never>; result: void }; // the account stays logged in
    // the answer to a server call the engine asked for in a serverCall event; status 0 means it could not be made
    raProvideResponse: { params: { requestId: number; status: number; body: string }; result: void };
    raReset: { params: Record<string, never>; result: void }; // so a run in progress is abandoned
    // set before raLoadGame so a set loads in the right mode; also safe mid-session to leave hardcore (rc_client keeps the
    // hardcore unlocks earned). The host restarts the ROM to enter hardcore, so a running set never has to be re-armed
    raSetHardcore: { params: { enabled: boolean }; result: void };
    // resolves with its page rather than as an event, as the panel waits for a specific page (still server calls the DOM
    // services underneath). `firstEntry` is 1-based and ignored with `aroundUser`, which asks for the player's own page
    raFetchLeaderboardEntries: {
        params: { leaderboardId: number; firstEntry: number; count: number; aroundUser: boolean };
        result: VesRaLeaderboardEntries;
    };
}

export interface VesRaUser {
    username: string;
    displayName: string;
    token: string; // to store and log in with next time, never the password
    score: number; // full (hardcore) points
    softcoreScore: number;
    avatarUrl?: string; // on media.retroachievements.org, when it has one
}

export interface RaGame {
    id: number;
    title: string;
    iconUrl: string; // on media.retroachievements.org (needs no CORS)
    achievementCount: number;
    pointsTotal: number;
}

export interface RaAchievement {
    id: number;
    title: string;
    description: string;
    points: number;
    badgeUrl: string;
    // `unsupported` could not be compiled by rcheevos for this console, shown grayed so the count still adds up
    state: 'locked' | 'unlocked' | 'unsupported';
    unlockedHardcore: boolean; // earned in hardcore, which softcore play never sets
    bucket: number; // rc_client's bucket id, for grouping the list the way the site does
    measured?: { percent: number; display: string }; // set for a measured ("progress") achievement, e.g. "12/50"
    // undefined for an ordinary achievement; rc_client only calls out these three kinds
    type?: 'missable' | 'progression' | 'win';
    // the percentage of players who earned it, RetroAchievements' rarity figure; undefined for a set too fresh for the
    // site to have computed it
    rarity?: number;
    rarityHardcore?: number;
    unlockTime?: number; // Unix seconds, set only once this account has earned it
}

export interface RaLeaderboard {
    id: number;
    title: string;
    description: string;
    // a duration, a score or a plain number; the engine's strings are already formatted, so this is for labels and sorting
    format: 'time' | 'score' | 'value';
    lowerIsBetter: boolean; // a smaller value ranks higher, as on a speedrun timer
    // `unsupported` could not be compiled by rcheevos; `inactive` always outside hardcore, the only mode RetroAchievements
    // runs leaderboards in; `active` armed, waiting for its start condition; `tracking` an attempt in progress
    state: 'inactive' | 'active' | 'tracking' | 'unsupported';
    value?: string; // the attempt's running value, only while tracking
}

export interface VesRaLeaderboardEntry {
    rank: number;
    user: string;
    display: string;
    submitted: number; // Unix seconds
    avatarUrl?: string;
}

export interface VesRaLeaderboardEntries {
    entries: VesRaLeaderboardEntry[];
    total: number; // rows of the whole board, not just this page
    userIndex: number; // the signed-in player's index in `entries`, or -1 when not on this page
}

export type VesRaEvent =
    // an HTTP call to make, answered with raProvideResponse
    | {
        kind: 'serverCall';
        requestId: number;
        method: 'GET' | 'POST';
        url: string;
        body?: string;
        contentType?: string;
    }
    // `game` is undefined when the ROM is not recognized
    | { kind: 'gameLoaded'; game: RaGame | undefined; reason?: string }
    // the whole set, sent after a load and again whenever progress changes
    | { kind: 'achievements'; achievements: RaAchievement[] }
    | {
        kind: 'unlocked';
        id: number;
        title: string;
        description: string;
        points: number;
        badgeUrl: string;
        hardcore: boolean;
    }
    // a "close to earning it" indicator appeared or disappeared
    | { kind: 'challengeIndicator'; id: number; show: boolean; badgeUrl: string }
    | { kind: 'connection'; online: boolean }
    // sent after a set loads and whenever a state changes (an attempt, hardcore going on or off). `reason` is set only
    // when this build's engine cannot produce a list at all, unlike a game without leaderboards
    | { kind: 'leaderboards'; leaderboards: RaLeaderboard[]; reason?: string }
    // an attempt on one leaderboard began, was abandoned, or was sent in
    | {
        kind: 'leaderboardAttempt';
        id: number;
        title: string;
        description: string;
        state: 'started' | 'failed' | 'submitted';
        value?: string; // the value the attempt stood at, for `submitted` in particular
    }
    // for the overlay over the picture, many times a second during an attempt. `trackerId` is not a leaderboard id:
    // boards reading the same value share one tracker
    | { kind: 'leaderboardTracker'; trackerId: number; show: boolean; display: string }
    // the server's answer to a submission: the new standing, and the top of the board
    | {
        kind: 'leaderboardScoreboard';
        id: number;
        submittedScore: string;
        bestScore: string;
        rank: number;
        total: number;
        topEntries: { rank: number; user: string; score: string }[];
    }
    | { kind: 'engineUnavailable'; reason: string }; // most often this build ships no rcheevos.wasm

export interface VbCheatWrite {
    address: number;
    value: number;
    bytes: number; // width of value, little-endian like the CPU
}

// edits the user makes to a running machine from outside (a cheat, a poke), sent between linked windows unchanged, so
// kept plain: numbers and arrays, nothing to transfer
export type ScheduledEdit =
    // the whole list rather than a change, so it is idempotent: a window applying it twice or after missing one still
    // ends up where the other window is
    | { kind: 'cheats'; codes: VbCheatWrite[] }
    // bytes as a plain array, which survives being sent on to the other window without buffer ownership
    | { kind: 'memory'; address: number; bytes: number[] };

// see CoreCommands.linkJournal; `frame` is the frame the entry took effect at, counted as queueKeys counts them
export type LinkJournalEntry =
    // where a run starts; `cartRam` is an FNV-1a digest of the whole save window, so windows can check they started alike
    | { frame: number; kind: 'reset'; cartRam: number }
    // a booked mask was applied; only changes are recorded
    | { frame: number; kind: 'keys'; keys: number }
    // a setKeys mask turned away under lockstep, recorded as it means something sends input outside the lockstep
    | { frame: number; kind: 'refusedKeys'; keys: number }
    // booked writes were applied
    | { frame: number; kind: 'edits'; edits: ScheduledEdit[] }
    // a digest taken for setDigestPeriod
    | { frame: number; kind: 'digest'; digest: number }
    // the core stopped advancing, and where the machine was when it did
    | { frame: number; kind: 'stalled'; pc: number };

export interface Registers {
    pc: number;
    program: number[]; // r0 to r31
    system: Record<string, number>; // keyed by the names in VbSystemRegister
}

export interface DisassemblyLine {
    address: number;
    code: number[]; // the instruction's own bytes, two or four of them
    isPC: boolean;
    mnemonic: string;
    operands: string[];
}

export type CommandName = keyof CoreCommands;
export type Params<K extends CommandName> = CoreCommands[K]['params'];
export type Result<K extends CommandName> = CoreCommands[K]['result'];

export interface Request<K extends CommandName = CommandName> {
    id: number;
    command: K;
    params: Params<K>;
}

export interface Response {
    id: number;
    result?: unknown;
    error?: string;
}

// the map is in the hardware's own layout, so emulator-vsu-memory.ts decodes it without knowing its source. The peaks
// (last one-frame buffer, before master volume) are what the channels actually came to, which the registers cannot say.
// Copied, not transferred: 1,412 bytes ten times a second
export interface VsuReading {
    map: ArrayBuffer;
    peakLeft: number; // loudest sample of the last buffer, 0 to 1, per side
    peakRight: number;
}

// Game Pak RAM sits on the low half of the bus, so a real cartridge carries one byte per access; the instruction's
// width is kept anyway, as a game storing a halfword into save RAM is worth seeing
export interface SramAccess {
    address: number; // as the bus saw it, inside the region, not an offset into it
    value: number; // the byte that crossed the bus, read or written
    write: boolean;
    type: number; // as VbDataType spells it
    pc: number;
}

/**
 * What crosses the wire instead of SramAccess. A game saves in a loop, one instruction walking an address, and sending
 * thousands of objects a tick costs more structured cloning than the emulation (a game reading its save every frame,
 * like Wario Land, stalls the interface). So runs are gathered in the worker and arrive as one object and a byte
 * array. Nothing is lost: each byte went to the address plus its index times the stride.
 */
export interface SramRun {
    address: number; // where the first touch landed, as the bus saw it
    // 2 for a loop walking the save, as only the low byte of each halfword is wired to the chip; 0 for one address touched
    // over and over, and for a run of one
    stride: number;
    values: Uint8Array;
    write: boolean; // a run is never a mix of reads and writes
    type: number; // as VbDataType spells it
    pc: number;
}

// caps how many different things a tick may do to the save (one sweep over all of it is one run). A batch arriving
// full was cut short, and the panel says so, which is why the number lives here
export const MAX_SRAM_RUNS = 512;

export const MAX_SRAM_RUN_BYTES = 8192; // how many bytes one run may gather before the next starts

// wide enough for a loop walking the save in halfwords or words, forwards or backwards
export const MAX_SRAM_STRIDE = 4;

export interface Speed {
    framesPerSecond: number; // emulated frames a second, against the machine's own VB_FRAME_RATE
    ratio: number; // that rate as a multiple of real time, so 1 is full speed
    requested: number; // the speed being attempted, after any clamp to what is affordable
    // the share of the wall time the worker spent emulating and presenting, 1 being all of it. Near 1 with a ratio
    // short of the requested speed, the machine is too slow; well below 1, the audio clock is what holds it back
    load: number;
}

// unsolicited worker to DOM notifications
export interface Events {
    error: { message: string }; // the worker hit an error outside of a command, e.g. in the drive loop
    frame: VideoFrame; // a packed frame for the main-thread renderer; its buffer is returned after upload
    // batched rather than sent a byte at a time; newlines are left in, so a consumer splits on them
    terminal: { sim: SimHandle; text: string };
    // bytes clocked out of the link port, in order and batched like terminal output
    link: { sim: SimHandle; bytes: number[] };
    pointerWrite: { sim: SimHandle; address: number; values: number[] };
    // halfwords written to the ESSound port, in order and batched like link bytes
    esSound: { sim: SimHandle; commands: number[] };
    sram: { sim: SimHandle; runs: SramRun[] }; // accesses to the save region, oldest first, batched like link bytes
    // sampled about once a second; reported rather than derived, as a fast forward the machine cannot sustain is clamped
    speed: Speed;
    // batched and flushed on the drive loop's own path, like terminal and link output
    retroAchievements: { events: VesRaEvent[] };
    // taken at a frame boundary for CoreCommands.setDigestPeriod
    digest: { sim: SimHandle; frame: number; digest: number };
    // every few frames while a simulation is under setLockstep, for a session scheduling input ahead of the drive loop:
    // `speed` is far too coarse, and awaitingInput only fires once the schedule ran dry
    progress: { frame: number };
    // only under setLockstep (see queueKeys for why the loop holds), fired on the change rather than per frame, so a
    // "waiting for the other player" state can be shown and cleared without flooding
    awaitingInput: {
        waiting: boolean;
        frame: number;
        sims: SimHandle[]; // which simulations have nothing booked for it; empty when resuming
    };
    /**
     * The core stopped advancing and emulation was suspended. Not an error: the core can keep returning from Emulate
     * without spending its clock budget (a program that has run off into memory it cannot execute), and the loops
     * draining the budget would spin forever. A reset is the way out, which the chrome can say.
     */
    stalled: {
        frames: number; // frames emulated before it stopped, the same count `speed` carries
    };
    // sent with every picture while streamPixelOrigins asks, so whatever is drawn from it moves in step
    pixelOrigins: { sim: SimHandle; runs: ArrayBuffer };
    // the machine stopped on an instruction and the worker suspended emulation, which the host must hear about to keep
    // its own idea of whether the game runs. `address` is where it is now, not yet executed
    stopped: {
        sim: SimHandle;
        address: number;
        reason: StopReason;
        write?: StopWrite; // for StopReason.WRITE: the store that did it, where and what
    };
}

// see setWriteStop
export interface StopWrite {
    pc: number; // the storing instruction, which has run
    address: number; // as the program addressed it
    value: number;
    size: number;
}

export enum StopReason {
    BREAKPOINT = 'breakpoint',
    STEP = 'step',
    CURSOR = 'cursor',
    WRITE = 'write', // the machine stopped after the instruction that wrote into a watched range: the write has landed
}

// a distributed union rather than a generic interface, so checking `event` narrows `payload`
export type VbEvent = {
    [K in keyof Events]: { event: K; payload: Events[K] }
}[keyof Events];

export type Outbound = Response | VbEvent;

export function isVbEvent(message: Outbound): message is VbEvent {
    return 'event' in message;
}

// the first message the worker receives, carrying the audio worklet's port
export interface Bootstrap {
    audioPort: MessagePort;
}

// one-way, returning a reusable video transfer buffer
export interface VideoFrameReturn {
    videoFrame: {
        sim: SimHandle;
        presentation: number; // tells a main-thread renderer's pool from a recording tap's (see setVideoTap)
        pixels: ArrayBuffer;
    };
}
