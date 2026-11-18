/**
 * Emulator core worker: owns the WebAssembly core and every simulation of one session, and runs the drive loop.
 * Emulation is clocked by audio consumption: each sample buffer the worklet returns emulates exactly
 * VB_CLOCKS_PER_BUFFER clocks and is refilled. Video is paced against the audio backlog, so picture and sound stay in
 * step without a separate timer. MUST NOT import anything from Theia, as it is bundled as a standalone worker entry
 * point.
 */

import {
  VB_AUDIO_BUFFER_COUNT,
  VB_CART_RAM_BASE,
  VB_CLOCKS_PER_BUFFER,
  VB_DEFAULT_DISPLAY_MODE,
  VB_ES_SOUND_PORT,
  VB_EYE_PACKED_LEFT,
  VB_EYE_PACKED_RIGHT,
  VB_FRAME_RATE,
  VB_LINK_CONTROL_PORT,
  VB_LINK_START,
  VB_LINK_TRANSMIT_PORT,
  VB_MAX_IDLE_EMULATE_CALLS,
  VB_MAX_MEMORY_READ,
  VB_SAMPLES_PER_BUFFER,
  VB_SCREEN_HEIGHT,
  VB_SCREEN_WIDTH,
  VBC_FRAME_BYTES,
  VB_FRAME_BYTES,
  VBC_FRAME_WIDTH,
  vbFrameBytes,
  VB_INTERRUPT_VECTOR_BASE,
  VB_PSW_INTERRUPT_LEVEL_MASK,
  VB_PSW_INTERRUPT_LEVEL_SHIFT,
  VB_TERMINAL_PORT,
  VB_VRAM_BASE,
  VB_VRAM_SIZE,
  VB_VSU_CHANNELS,
  VB_WRAM_BASE,
  VB_WRAM_SIZE,
  VB_WRITE_RANGES_ALL,
  VbBreak,
  VbOption,
  VbDataType,
  DisplayMode,
  DisplayOutput,
  FrameBlending,
  VbInterrupt,
  vbInterruptExceptionCode,
  VbPsw,
  VbSystemRegister,
  isCartRam,
  VbCounter,
  thumbnailDisplayMode,
} from '../common/vb-constants';
import {
  Bootstrap,
  VbCheatWrite,
  ScheduledEdit,
  LinkJournalEntry,
  CommandName,
  VbEvent,
  Params,
  DisassemblyLine,
  Frame,
  FrameKind,
  ProfileResult,
  Recording,
  Registers,
  Request,
  Response,
  Result,
  RewindHistory,
  SimHandle,
  MAX_SRAM_RUNS,
  StopReason,
  StopWrite,
  MAX_SRAM_RUN_BYTES,
  MAX_SRAM_STRIDE,
  VideoFrameReturn,
  VsuReading,
} from '../common/vb-protocol';
import { saveRamHighWater } from '../common/emulator-save-state';
import { withTurbo } from '../common/emulator-turbo';
import { FrameHistory, SkippedFrames } from './vb-frame-history';
import {
  decodeRomKinds,
  VesInstructionKind,
  VesProfileCollector,
} from '../common/emulator-profile';
import {
  VesLiveProfileCollector, LiveProfileSnapshot, LiveMachineCounters, liveMachineFrame,
} from '../common/emulator-live-profile';

// the core's counters as the live profiler keeps them: the last reading, so each picture's share can be told
// from the running totals, and one delta per picture for the window
interface LiveMachine {
  previous: Uint32Array;
  frames: number[][];
  window: number;
}
import { ES_SOUND_INIT } from '../common/emulator-essound';
import {
  applyDelta,
  createRunScratch,
  encodeDelta,
  growFrame,
  REWIND_THUMBNAIL_FRAMES,
  shrinkFrame,
} from './vb-rewind';
import { VbRenderer } from './vb-renderer';
import { ColumnFrames } from './vb-column-frames';
import { mirrorSpinUp } from '../common/vb-column-geometry';
import {
  disassemble,
  installVbCallback,
  instantiateWasm,
  releaseVbCallback,
  VB_EXECUTE_CALLBACK_ARITY,
  VB_READ_CALLBACK_ARITY,
  VB_WRITE_CALLBACK_ARITY,
  WasmExports,
} from './vb-wasm';
import { RetroAchievements } from './vb-rcheevos';
import {
  applyVsuMutes,
  calibrateVsuLayout,
  composeVsuMap,
  createVsuMuteState,
  restoreVsuMutes,
  takeVsuLevelWrite,
  vsuLevelWriteChannel,
  VsuLayout,
  VsuMuteState,
} from './vb-vsu-layout';

// minimal shape of the dedicated worker global, which lib.dom does not type
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | undefined;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

interface SimState {
  pointer: number;
  renderer?: VbRenderer;
  // transfer buffers used when WebGL presentation lives on the DOM thread
  mainThread?: { presentation: number; buffers: ArrayBuffer[] };
  // a second pool for a video recording on the DOM thread, independent of mainThread, so both can be filled
  // from the same frame. See setVideoTap in vb-protocol.ts
  videoTap?: { presentation: number; buffers: ArrayBuffer[] };
  // frames last shown, for a screenshot that blends and the immersion halo. Kept only while one of them can want it
  // (see wantsHistory), dropped otherwise, so frames from before a gap never blend with the next
  frames?: FrameHistory;
  backdropReadAt?: number; // when the immersion halo last read the picture (performance.now()), see wantsHistory
  pageHeld?: boolean; // the page's picture is left alone, see holdPage in vb-protocol.ts
  skipped?: SkippedFrames; // frames a fast-forwarded buffer ran just before the one it shows, so blending sees them
  displayMode: DisplayMode; // kept so the renderer can be rebuilt if the display mode arrives first
  displayOutput?: DisplayOutput;
  samples: number;
  // cartridge buffers we allocated and are responsible for freeing
  cartRom: number;
  cartRomSize: number;
  cartRam: number;
  cartRamSize: number;
  keys: number; // last mask handed to the core, which is what a recording writes down
  heldKeys: number; // what setKeys or a booking last said is held, before turbo is added
  turbo?: { keys: number; rate: number }; // buttons held on turbo, and at what rate; see setTurbo in vb-protocol.ts
  vbcHardware: boolean; // physical hardware model, kept outside snapshots so a load cannot change it
  // which end of the link cable this machine is, 0 when on no cable. Only used to order the pair, see orderedSims
  linkOrder: number;
}

interface SimStop {
  points: Set<number>; // the gutter set by whoever reads the disassembly
  // always one: the callback reports an instruction before it runs, so a machine standing on a breakpoint would
  // stop on it again the instant it was told to carry on
  grace: number;
  // a single trap laid for one run (step over, run to cursor), gone the moment it springs
  pending?: { reason: StopReason; at?: number; write?: StopWrite };
}

// a SramRun while it is still being added to; `at` and `values` are dropped when the run is handed over
interface GrowingSramRun {
  address: number;
  at: number; // where the last touch landed, which the next one is measured against
  stride: number;
  values: number[]; // grown a byte at a time
  write: boolean;
  type: number;
  pc: number;
}

// rewind history as reverse deltas: the state struct is 1.85 MiB but only ~0.2% changes per frame, so changed runs buy
// minutes where whole snapshots in 128 MB buy a second. XOR is its own inverse, so an entry walks back and forth; the
// filmstrip only drops what lies ahead once the machine moves on
interface RewindStore {
  enabled: boolean;
  granularity: number;
  budgetBytes: number;
  mirrors: Uint8Array[]; // state at capture `cursor`, one per simulation
  entries: Uint8Array[][]; // entries[n][sim] converts capture n + 1 to capture n and back, oldest first
  captures: RewindCapture[]; // one per capture, oldest first: entries.length + 1 once the mirrors are seeded
  cursor: number; // the capture the mirrors hold: the newest, except while the filmstrip is being browsed
  bytes: number; // total bytes held by entries and thumbnails, against which the budget is enforced
  frames: number; // frames emulated, by which captures and thumbnails are spaced. Wound back with the history
  thumbnailFrame: number;
}

interface RewindCapture {
  frame: number;
  // the picture at that moment at half size (shrinkFrame): the two eyes' brightness, or VBC's RGB of both eyes
  thumbnail?: { pixels: Uint8Array; colorMode: boolean };
}

const MIX_BUFFER_LENGTH = VB_SAMPLES_PER_BUFFER * 2; // interleaved stereo, so two floats per frame

// the VIP's frame repeat register, read by the live profiler to know how many pictures one drawing spans; VipRegister
// lives on the other side of the worker boundary
const VIP_FRMCYC = 0x0005f82e;

class Worker {
  static readonly MAX_MEMORY_WINDOW = VB_MAX_MEMORY_READ;
  static readonly MAX_DISASSEMBLY_LINES = 512;
  // the finest the immersion halo could ever want, per axis. At this cap a cell is under two pixels, so the work
  // is bounded by the framebuffer either way
  static readonly MAX_BACKDROP_CELLS = 192;
  // how long after the immersion halo last read the picture the shown frames are still kept for it: a few of its
  // polls (160 ms apart), so a halo that stops lets the copies stop too
  static readonly HISTORY_HALO_MS = 1000;

  // cap on terminal text held between flushes, drained fifty times a second, so only reached by output nobody
  // could read anyway
  static readonly MAX_TERMINAL_BYTES = 1 << 16;

  // cap on link port bytes held between flushes. Far smaller than the terminal's, as these go to a device over a
  // serial line slower than the game can fill it, and rumble lagging a second behind is worse than skipped rumble
  static readonly MAX_LINK_BYTES = 1 << 10;

  // cap on watched pointer values held between flushes. A pointer is assigned when something starts, not in a
  // loop, so this is only reached by a program in trouble
  static readonly MAX_POINTER_WRITES = 64;

  // cap on ESSound commands held between flushes; a game sends a handful a second at most
  static readonly MAX_ES_SOUND_COMMANDS = 256;

  // wall time one audio buffer covers, the deadline a fill has to meet
  static readonly BUFFER_WALL_MS = 1000 / VB_FRAME_RATE;
  // the share of that slice emulation may spend, the rest is margin that keeps the queue ahead of the worklet.
  // Measured on a machine with a raw ceiling of 3x: fast forward reaches 2.7x at a full 50 fps, and a wider
  // margin only buys speed by underrunning again
  static readonly EMULATION_BUDGET = 0.9;
  static readonly CHUNK_COST_WEIGHT = 0.1; // how much a fresh measurement moves the rolling chunk cost

  static readonly SPEED_REPORT_MS = 1000;
  // how far ahead of the current frame input may be booked. A lockstep session runs a handful of frames of
  // delay, anything near this is a peer that has lost the plot
  static readonly MAX_SCHEDULED_FRAMES = 600;
  // every frame while under lockstep: a schedule kept three frames ahead of a loop that reports every fourth frame
  // runs dry between reports, and the game stutters
  static readonly PROGRESS_REPORT_FRAMES = 1;
  // how long a linkJournal may grow before it stops recording. Masks are recorded only on change and digests once
  // a second, so this is hours of play
  static readonly MAX_JOURNAL_ENTRIES = 200000;
  // system registers stateDigest covers, the architectural ones only. Indexes 8 to 23 are holes, and hashing
  // them would hash whatever the core happens to answer
  static readonly DIGEST_SYSTEM_REGISTERS = [
    VbSystemRegister.EIPC,
    VbSystemRegister.EIPSW,
    VbSystemRegister.FEPC,
    VbSystemRegister.FEPSW,
    VbSystemRegister.ECR,
    VbSystemRegister.PSW,
    VbSystemRegister.PIR,
    VbSystemRegister.TKCW,
    VbSystemRegister.CHCW,
    VbSystemRegister.ADTRE,
  ];

  protected wasm: WasmExports;
  protected audioPort: MessagePort;

  protected readonly sims = new Map<SimHandle, SimState>();

  // sample buffers currently held by us rather than by the audio worklet
  protected readonly audioQueue: Float32Array[] = [];

  protected emulating = false;

  protected speed = 1;
  protected stereoDepth = 100;
  protected columnGeometry = true;
  protected mirrorSpinUp = false;
  protected mirrorSpinUpFullDelay = true;
  protected readonly columnFrames = new ColumnFrames();
  protected columnLengths = 0; // 192 bytes of core memory the column lengths are fetched into, once needed
  protected pendingClocks = 0; // clocks carried over between audio buffers, so slow motion can fall short of a chunk
  protected skipping = false; // whether the buffer being filled runs more than one frame; see holdSkippedFrame
  // rolling wall-clock cost of one emulated chunk in milliseconds, which affordableSpeed divides the budget by.
  // Smoothed, as a speed chasing single-chunk swings would show as jitter
  protected chunkCostMs = 0;
  protected chunksSinceReport = 0;
  protected lastSpeedReport = 0;
  protected busySinceReport = 0; // milliseconds spent in drive since that report, for Speed.load
  // chunks since the ROM was loaded or the machine reset, i.e. the frame number a debug readout shows. Not
  // reset by pausing
  protected framesRun = 0;

  // controller masks booked against their frames, by simulation (see queueKeys in vb-protocol.ts). Entries are
  // dropped as their frames go past
  protected readonly keySchedules = new Map<SimHandle, Map<number, number>>();
  // writes booked against their frames, by simulation (see queueEdits in vb-protocol.ts). Kept apart from the
  // key schedule: a mask persists at an unbooked frame (a held button holds), a write happens once
  protected readonly editSchedules =
    new Map<SimHandle, Map<number, ScheduledEdit[]>>();
  // simulations that must not run past the input they have been booked
  protected readonly lockstepSims = new Set<SimHandle>();
  // what each simulation under lockstep was actually given, and the last mask recorded, so only changes are.
  // See linkJournal in vb-protocol.ts
  protected readonly linkJournals =
    new Map<SimHandle, { entries: LinkJournalEntry[]; keys: number }>();
  // whether the drive loop is stopped waiting for input, so the event fires on the change, not every frame
  protected awaitingInput = false;
  protected lastProgressReport = 0;
  // how often each simulation's digest is taken; empty for a solo emulator, which has nothing to compare against
  protected readonly digestPeriods = new Map<SimHandle, number>();

  protected readonly rewind: RewindStore = {
    enabled: false,
    granularity: 1,
    budgetBytes: 0,
    mirrors: [],
    entries: [],
    captures: [],
    cursor: 0,
    bytes: 0,
    frames: 0,
    thumbnailFrame: -Infinity,
  };

  protected readonly runScratch = createRunScratch();

  // own renderer for screenshots that are not the picture as shown. Built on first use and kept, as a WebGL
  // context is expensive to make
  protected screenshotRenderer?: VbRenderer;
  // table slot of the shared write callback, 0 until something watches writes. A simulation has room for only one
  // installed callback, so one serves every simulation and watcher, routing on simulation pointer and address
  protected writeWatchCallbackSlot = 0;
  protected readWatchCallbackSlot = 0;
  protected readonly terminalBuffers = new Map<SimHandle, number[]>();
  // where this core keeps the VSU's state once found, or the failure to find it. Undefined until the first
  // readVsu. One per core, as every simulation is the same struct; see vb-vsu-layout.ts
  protected vsuLayout?: VsuLayout | Error;
  // channels the VSU panel holds silent, by simulation pointer, and the levels the game gave them. Keyed by
  // pointer as the drive loop applies them while walking simulation states. Entries exist only while muted
  protected readonly vsuMutes = new Map<number, VsuMuteState>();
  // the address each simulation follows a pointer at, present only while setPointerWatch is in effect
  protected readonly pointerWatches = new Map<SimHandle, number>();

  // the switched-on cheats, written at every frame break, by simulation pointer (the drive loop walks
  // simulation states)
  protected readonly cheats = new Map<number, VbCheatWrite[]>();
  /**
   * The cartridge's own bytes under ROM cheats, by simulation pointer and ROM offset. A cheat's write into region 7
   * changes the loaded ROM itself, which a reset does not reload, so a byte goes back once no switched-on cheat
   * writes it any more.
   */
  protected readonly romCheatOriginals = new Map<number, Map<number, number>>();
  protected readonly pointerWrites = new Map<SimHandle, number[]>();
  protected readonly linkBuffers = new Map<SimHandle, number[]>();
  // halfwords written to the ESSound port since the last flush, present only while setEsSoundCapture(true)
  protected readonly esSoundBuffers = new Map<SimHandle, number[]>();
  // runs of touches of the cartridge's save region, by simulation, present only while a capture is on.
  // Gathered rather than sent per access, see SramRun
  protected readonly sramBuffers = new Map<SimHandle, GrowingSramRun[]>();
  // which directions each capture asked for; present only while one is wanted, which says a capture is on
  protected readonly sramDirections = new Map<SimHandle, { writes: boolean; reads: boolean }>();
  // where each simulation should stop, present only for a simulation something is watching. The
  // per-instruction callback comes and goes with it, as it costs about a sixth of the emulation it watches
  // (measured in tests/breakpoint-probe.mjs)
  protected readonly stops = new Map<SimHandle, SimStop>();
  // the stop that has happened and not been reported yet. Set from inside the core's callback, in the middle of
  // an Emulate call, so the drain loop picks it up on the way out
  protected stopped?: { pointer: SimHandle; address: number; reason: StopReason; write?: StopWrite };
  // ranges to stop after the next write to, by simulation; see setWriteStop
  protected readonly writeStops = new Map<SimHandle, { start: number; end: number }[]>();
  protected executeCallbackSlot = 0;
  // one view over the core's memory for the per-access callbacks, which run hundreds of thousands of times a
  // second, so a typed array per call would cost more than the emulation. The core growing its memory detaches
  // it, so its buffer says whether it is still good
  protected memoryBytes?: Uint8Array;
  // simulations owed an expansion-port interrupt, by pointer. An ESSound cartridge answers init with a pulse on
  // /INTCRO, which is how a ROM detects it. Held until the CPU can take it, as ROMs often init with interrupts
  // disabled
  protected readonly gamePakInterrupts = new Set<number>();
  // what each simulation last stored in the link port's transmit register. Shadowed, as only the write watcher
  // sees these registers and a byte is only sent once the control register says so
  protected readonly linkTransmitBytes = new Map<SimHandle, number>();

  // scratch allocations in core memory, see #allocateScratch
  protected clocksPointer = 0;
  protected simsPointer = 0;
  protected simsCapacity = 0;
  protected mixPointer = 0;

  // the RetroAchievements engine, created once init has run. Bound to at most one simulation, the one raLoadGame
  // was last called for, never a profile replay's scratch simulation or a linked peer
  protected ra: RetroAchievements;
  protected raSimPointer = 0;

  constructor(protected readonly workerScope: WorkerScope) {}

  async bootstrap(bootstrap: Bootstrap): Promise<void> {
    this.audioPort = bootstrap.audioPort;
    this.audioPort.onmessage = event =>
      this.onAudioBuffersReturned(event.data);

    for (let i = 0; i < VB_AUDIO_BUFFER_COUNT; i++) {
      this.audioQueue.push(new Float32Array(MIX_BUFFER_LENGTH));
    }
  }

  async handle<K extends CommandName>(
    command: K,
    params: Params<K>,
  ): Promise<unknown> {
    switch (command) {
      case 'init':
        return this.init(params as Params<'init'>);
      case 'createSim':
        return this.createSim();
      case 'deleteSim':
        return this.deleteSim(params as Params<'deleteSim'>);
      case 'attachCanvas':
        return this.attachCanvas(params as Params<'attachCanvas'>);
      case 'setVideoTap':
        return this.setVideoTap(params as Params<'setVideoTap'>);
      case 'holdPage':
        return this.holdPage(params as Params<'holdPage'>);
      case 'setCartRom':
        return this.setCartRom(params as Params<'setCartRom'>);
      case 'setCartRam':
        return this.setCartRam(params as Params<'setCartRam'>);
      case 'getCartRam':
        return this.getCartRam(params as Params<'getCartRam'>);
      case 'cartRamInfo':
        return this.cartRamInfo(params as Params<'cartRamInfo'>);
      case 'stateSize':
        return this.wasm.vbSizeOf();
      case 'reset':
        return this.reset(params as Params<'reset'>);
      case 'setHardwareMode':
        return this.setHardwareMode(params as Params<'setHardwareMode'>);
      case 'setKeys':
        return this.setKeys(params as Params<'setKeys'>);
      case 'setTurbo':
        return this.setTurbo(params as Params<'setTurbo'>);
      case 'queueKeys':
        return this.queueKeys(params as Params<'queueKeys'>);
      case 'queueEdits':
        return this.queueEdits(params as Params<'queueEdits'>);
      case 'setLockstep':
        return this.setLockstep(params as Params<'setLockstep'>);
      case 'stateDigest':
        return this.stateDigest(params as Params<'stateDigest'>);
      case 'setDigestPeriod':
        return this.setDigestPeriod(params as Params<'setDigestPeriod'>);
      case 'linkJournal':
        return this.linkJournal(params as Params<'linkJournal'>);
      case 'startProfileRecording':
        return this.startProfileRecording(params as Params<'startProfileRecording'>);
      case 'stopProfileRecording':
        return this.stopProfileRecording(params as Params<'stopProfileRecording'>);
      case 'replayProfile':
        return this.replayProfile(params as Params<'replayProfile'>);
      case 'setLiveProfiler':
        return this.setLiveProfiler(params as Params<'setLiveProfiler'>);
      case 'readLiveProfile':
        return this.readLiveProfile(params as Params<'readLiveProfile'>);
      case 'setDisplayMode':
        return this.setDisplayMode(params as Params<'setDisplayMode'>);
      case 'setDisplayOutput':
        return this.setDisplayOutput(params as Params<'setDisplayOutput'>);
      case 'capture':
        return this.capture(params as Params<'capture'>);
      case 'setVolume':
        return this.setVolume(params as Params<'setVolume'>);
      case 'setPanning':
        return this.setPanning(params as Params<'setPanning'>);
      case 'run':
        return this.run();
      case 'suspend':
        return this.suspend();
      case 'saveState':
        return this.saveState(params as Params<'saveState'>);
      case 'loadState':
        return this.loadState(params as Params<'loadState'>);
      case 'setSpeed':
        return this.setSpeed(params as Params<'setSpeed'>);
      case 'setStereoDepth':
        return this.setStereoDepth(params as Params<'setStereoDepth'>);
      case 'setColumnGeometry':
        return this.setColumnGeometry(params as Params<'setColumnGeometry'>);
      case 'setMirrorSpinUp':
        this.mirrorSpinUp = (params as Params<'setMirrorSpinUp'>).enabled;
        this.mirrorSpinUpFullDelay = (params as Params<'setMirrorSpinUp'>).fullDelay;
        return;
      case 'stepFrame':
        return this.stepFrame();
      case 'setRewind':
        return this.setRewind(params as Params<'setRewind'>);
      case 'rewindStep':
        return this.rewindStep(params as Params<'rewindStep'>);
      case 'rewindHistory':
        return this.rewindHistory(params as Params<'rewindHistory'>);
      case 'rewindSeek':
        return this.rewindSeek(params as Params<'rewindSeek'>);
      case 'rewindThumbnail':
        return this.rewindThumbnail(params as Params<'rewindThumbnail'>);
      case 'readRewindThumbnail':
        return this.readRewindThumbnail(params as Params<'readRewindThumbnail'>);
      case 'setPeer':
        return this.setPeer(params as Params<'setPeer'>);
      case 'readPixels':
        return this.readPixels(params as Params<'readPixels'>);
      case 'readBackdrop':
        return this.readBackdrop(params as Params<'readBackdrop'>);
      case 'readFrame':
        return this.readFrame(params as Params<'readFrame'>);
      case 'refreshFrame':
        return this.refreshFrame(params as Params<'refreshFrame'>);
      case 'readMemory':
        return this.readMemory(params as Params<'readMemory'>);
      case 'writeMemory':
        return this.writeMemory(params as Params<'writeMemory'>);
      case 'readRegisters':
        return this.readRegisters(params as Params<'readRegisters'>);
      case 'disassemble':
        return this.disassemble(params as Params<'disassemble'>);
      case 'setBreakpoints':
        return this.setBreakpoints(params as Params<'setBreakpoints'>);
      case 'stepInstruction':
        return this.stepInstruction(params as Params<'stepInstruction'>);
      case 'runTo':
        return this.runTo(params as Params<'runTo'>);
      case 'setTerminalCapture':
        return this.setTerminalCapture(
          params as Params<'setTerminalCapture'>,
        );
      case 'setLinkCapture':
        return this.setLinkCapture(params as Params<'setLinkCapture'>);
      case 'setPixelOrigins':
        return this.setPixelOrigins(params as Params<'setPixelOrigins'>);
      case 'readPixelOrigins':
        return this.readPixelOrigins(params as Params<'readPixelOrigins'>);
      case 'streamPixelOrigins':
        return this.streamPixelOrigins(params as Params<'streamPixelOrigins'>);
      case 'setWriteStop':
        return this.setWriteStop(params as Params<'setWriteStop'>);
      case 'setPointerWatch':
        return this.setPointerWatch(params as Params<'setPointerWatch'>);
      case 'setCheats':
        return this.setCheats(params as Params<'setCheats'>);
      case 'setEsSoundCapture':
        return this.setEsSoundCapture(params as Params<'setEsSoundCapture'>);
      case 'setSramCapture':
        return this.setSramCapture(params as Params<'setSramCapture'>);
      case 'readVsu':
        return this.readVsu(params as Params<'readVsu'>);
      case 'setVsuMutes':
        return this.setVsuMutes(params as Params<'setVsuMutes'>);
      case 'raLoginPassword':
        return this.raLoginPassword(params as Params<'raLoginPassword'>);
      case 'raLoginToken':
        return this.raLoginToken(params as Params<'raLoginToken'>);
      case 'raLogout':
        return this.raLogout();
      case 'raLoadGame':
        return this.raLoadGame(params as Params<'raLoadGame'>);
      case 'raUnloadGame':
        return this.raUnloadGame();
      case 'raProvideResponse':
        return this.raProvideResponse(params as Params<'raProvideResponse'>);
      case 'raReset':
        return this.raReset();
      case 'raSetHardcore':
        return this.raSetHardcore(params as Params<'raSetHardcore'>);
      case 'raFetchLeaderboardEntries':
        return this.raFetchLeaderboardEntries(params as Params<'raFetchLeaderboardEntries'>);
      default:
        throw new Error(`Unknown emulator core command: ${command}`);
    }
  }

  protected async init(params: Params<'init'>): Promise<void> {
    this.wasm = await instantiateWasm(params.wasmUrl);
    this.columnLengths = 0;
    this.allocateScratch();
    this.ra = new RetroAchievements(params.rcheevosModuleUrl);
    this.ra.onPush = () => this.flushRetroAchievements();
  }

  protected createSim(): SimHandle {
    const pointer = this.wasm.CreateSim();
    if (pointer === 0) {
      throw new Error('Emulator core could not allocate a simulation.');
    }
    // legacy VB color is applied by the renderer, so the core composites eye-packed brightness. A VBC-capable core
    // exposes a separate RGB888 transport buffer and the renderer switches formats automatically
    this.wasm.SetAnaglyph(pointer, VB_EYE_PACKED_LEFT, VB_EYE_PACKED_RIGHT);
    this.applyStereoDepth(pointer);
    this.sims.set(pointer, {
      pointer,
      displayMode: VB_DEFAULT_DISPLAY_MODE,
      samples: this.wasm.GetExtSamples(pointer),
      cartRom: 0,
      cartRomSize: 0,
      cartRam: 0,
      cartRamSize: 0,
      keys: 0,
      heldKeys: 0,
      vbcHardware: true,
      linkOrder: 0,
    });
    this.refreshSimPointers();
    return pointer;
  }

  // the vendored shim's Sim.delete() is an empty stub that leaked the state struct and cartridge buffers, so we
  // free them ourselves
  protected deleteSim(params: Params<'deleteSim'>): void {
    const sim = this.requireSim(params.sim);
    if (this.live?.pointer === sim.pointer) {
      this.stopLiveProfiler();
    }
    sim.renderer?.dispose();
    sim.videoTap = undefined;
    if (this.origins?.sim === sim.pointer) {
      this.stopPixelOrigins();
    }
    if (sim.cartRom !== 0) {
      this.wasm.Realloc(sim.cartRom, 0);
    }
    if (sim.cartRam !== 0) {
      this.wasm.Realloc(sim.cartRam, 0);
    }
    this.wasm.Realloc(sim.pointer, 0);
    if (sim.pointer === this.raSimPointer) {
      this.ra.detach();
      this.raSimPointer = 0;
    }
    this.sims.delete(params.sim);
    this.refreshPeered();
    this.keySchedules.delete(params.sim);
    this.editSchedules.delete(params.sim);
    this.lockstepSims.delete(params.sim);
    this.linkJournals.delete(params.sim);
    this.digestPeriods.delete(params.sim);
    this.terminalBuffers.delete(params.sim);
    this.linkBuffers.delete(params.sim);
    this.linkTransmitBytes.delete(params.sim);
    this.pointerWatches.delete(params.sim);
    this.pointerWrites.delete(params.sim);
    this.cheats.delete(sim.pointer);
    this.romCheatOriginals.delete(sim.pointer);
    // the mutes are dropped rather than released: the simulation the levels would go back to is about to be freed
    this.vsuMutes.delete(sim.pointer);
    this.refreshSimPointers();
  }

  protected attachCanvas(params: Params<'attachCanvas'>): void {
    const sim = this.requireSim(params.sim);
    sim.renderer?.dispose();
    sim.renderer = undefined;
    sim.mainThread = undefined;
    if ('canvas' in params) {
      sim.renderer = new VbRenderer(params.canvas, sim.displayMode);
      sim.renderer.setDisplayOutput(sim.displayOutput);
    } else {
      sim.mainThread = params.mainThread;
    }
    this.present(sim);
  }

  // the picture the worker draws is untouched either way, see setVideoTap in vb-protocol.ts. Stopping drops the
  // pool, so buffers in flight are simply not taken back
  protected setVideoTap(params: Params<'setVideoTap'>): void {
    const sim = this.requireSim(params.sim);
    sim.videoTap = params.tap;
  }

  // see holdPage in vb-protocol.ts. On release the page gets the current frame at once, as a paused machine presents
  // no other; it starts blending again from the frames after it
  protected holdPage(params: Params<'holdPage'>): void {
    const sim = this.requireSim(params.sim);
    const held = params.held;
    if (held === !!sim.pageHeld) {
      return;
    }
    sim.pageHeld = held;
    if (held) {
      sim.skipped?.clear();
      return;
    }
    if (!sim.renderer && !sim.mainThread) {
      return;
    }
    const colorMode = this.isVbcColorOutput(sim);
    if (colorMode) {
      this.wasm.GetColorPixels!(sim.pointer);
    } else {
      this.wasm.GetPixels(sim.pointer);
    }
    const pixels = this.shownPixels(sim, colorMode);
    if (sim.renderer) {
      sim.renderer.present(pixels, colorMode, 'jump');
    } else if (sim.mainThread) {
      this.sendFrame(sim, sim.mainThread, pixels, colorMode, 'jump');
    }
  }

  // either pool may be the one it came from, told apart by the presentation tag the page hands back, the same
  // tag that marks a buffer stale, which makes a canvas swapped mid-flight safe
  returnVideoFrame(message: VideoFrameReturn): void {
    const returned = message.videoFrame;
    if (returned.pixels.byteLength !== VBC_FRAME_BYTES && returned.pixels.byteLength !== VB_FRAME_BYTES) {
      return;
    }
    const sim = this.sims.get(returned.sim);
    for (const pool of [sim?.mainThread, sim?.videoTap]) {
      if (pool?.presentation === returned.presentation) {
        pool.buffers.push(returned.pixels);
        return;
      }
    }
  }

  protected setDisplayMode(params: Params<'setDisplayMode'>): void {
    const sim = this.requireSim(params.sim);
    sim.displayMode = params.mode;
    sim.renderer?.setDisplayMode(params.mode);
  }

  protected setDisplayOutput(params: Params<'setDisplayOutput'>): void {
    const sim = this.requireSim(params.sim);
    sim.displayOutput = params.output;
    sim.renderer?.setDisplayOutput(params.output);
  }

  // the presented frame as a PNG, optionally composed to settings of its own. Anything other than the mode on
  // screen at its own size is redrawn in screenshotRenderer, never by retuning the live renderer, which would
  // flicker the picture and resize the canvas under the page
  protected async capture(
    params: Params<'capture'>,
  ): Promise<ArrayBuffer> {
    const sim = this.requireSim(params.sim);
    if (!sim.renderer) {
      throw new Error('The emulator has nothing to capture yet.');
    }
    const scale = Math.max(1, Math.floor(params.scale ?? 1));
    // the live buffer only fits while it is the mode's own size; an interleaved mode drawn at its shown size does not
    if (!params.mode && scale === 1 && sim.renderer.atModeSize && !sim.pageHeld) {
      return sim.renderer.capture();
    }

    const mode = params.mode ?? sim.displayMode;
    if (!this.screenshotRenderer) {
      this.screenshotRenderer = new VbRenderer(
        new OffscreenCanvas(mode.width, mode.height), mode);
    } else {
      this.screenshotRenderer.setDisplayMode(mode);
    }
    // when blending, the frames shown before go in first, oldest first, so the current one mixes exactly as on screen
    const previous = mode.frameBlending !== FrameBlending.OFF ? sim.frames?.peekPrevious() ?? [] : [];
    const renderer = this.screenshotRenderer;
    [...previous].reverse().forEach((frame, index) =>
      renderer.present(frame.pixels, frame.colorMode, index === 0 ? 'jump' : 'next'));
    const colorMode = this.isVbcColorOutput(sim);
    if (colorMode) {
      this.wasm.GetColorPixels!(sim.pointer);
    } else {
      this.wasm.GetPixels(sim.pointer);
    }
    this.screenshotRenderer.present(
      this.shownPixels(sim, colorMode),
      colorMode,
      previous.length > 0 ? 'next' : 'jump',
    );
    return this.screenshotRenderer.capture(scale);
  }

  protected setCartRom(params: Params<'setCartRom'>): void {
    const sim = this.requireSim(params.sim);
    const previous = sim.cartRom;
    const pointer = this.copyIntoCore(params.rom);
    if (
      this.wasm.vbSetCartROM(sim.pointer, pointer, params.rom.byteLength) !== 0
    ) {
      this.wasm.Realloc(pointer, 0);
      throw new Error(
        'Emulator core rejected the ROM. Its size must be a power of two.',
      );
    }
    if (previous !== 0) {
      this.wasm.Realloc(previous, 0);
    }
    sim.cartRom = pointer;
    sim.cartRomSize = params.rom.byteLength;
    this.romCheatOriginals.delete(sim.pointer);
    this.syncRomCheats(sim, this.cheats.get(sim.pointer) ?? []);
    // a different cartridge invalidates any history of the previous one, and starts its frames over
    this.clearRewind();
    this.framesRun = 0;
    this.forgetSchedules();
  }

  protected setCartRam(params: Params<'setCartRam'>): void {
    const sim = this.requireSim(params.sim);
    const previous = sim.cartRam;
    const pointer = this.copyIntoCore(params.ram);
    if (
      this.wasm.vbSetCartRAM(sim.pointer, pointer, params.ram.byteLength) !== 0
    ) {
      this.wasm.Realloc(pointer, 0);
      throw new Error(
        'Emulator core rejected the save RAM. Its size must be a power of two.',
      );
    }
    if (previous !== 0) {
      this.wasm.Realloc(previous, 0);
    }
    sim.cartRam = pointer;
    sim.cartRamSize = params.ram.byteLength;
  }

  protected getCartRam(params: Params<'getCartRam'>): ArrayBuffer {
    const sim = this.requireSim(params.sim);
    if (sim.cartRam === 0 || sim.cartRamSize === 0) {
      return new ArrayBuffer(0);
    }
    // clamped: asking for more would read whatever the core keeps after the buffer
    const length = params.length === undefined
      ? sim.cartRamSize
      : Math.max(0, Math.min(params.length, sim.cartRamSize));
    return new Uint8Array(
      this.wasm.memory.buffer,
      sim.cartRam,
      length,
    ).slice().buffer;
  }

  // the save window's size and how far into it the game has written. The scan is a few million word comparisons
  // over a 16 MiB window, cheap enough when a save is written or a panel opened, too expensive every tick
  protected cartRamInfo(params: Params<'cartRamInfo'>): { size: number; used: number } {
    const sim = this.requireSim(params.sim);
    if (sim.cartRam === 0 || sim.cartRamSize === 0) {
      return { size: 0, used: 0 };
    }
    const ram = new Uint8Array(
      this.wasm.memory.buffer,
      sim.cartRam,
      sim.cartRamSize,
    );
    return { size: sim.cartRamSize, used: saveRamHighWater(ram) };
  }

  protected setHardwareMode(params: Params<'setHardwareMode'>): boolean {
    const sim = this.requireSim(params.sim);
    // a Phase-4 binary has VBC hardware permanently present. Keep that bundled binary usable until build-vbc.mjs
    // replaces it: report what the core can actually do, so the UI never claims an original VB while the VCU is visible
    if (!this.wasm.SetHardwareMode) {
      sim.vbcHardware = true;
      return true;
    }
    sim.vbcHardware = params.vbc;
    this.wasm.SetHardwareMode(sim.pointer, params.vbc ? 1 : 0);
    return sim.vbcHardware;
  }

  protected reset(params: Params<'reset'>): void {
    const sim = this.requireSim(params.sim);
    this.wasm.vbReset(sim.pointer);
    this.clearPixelOrigins(sim.pointer);
    this.rearmLiveProfiler(sim.pointer);
    this.flushAudio();
    this.framesRun = 0;
    this.forgetSchedules();
    const journal = this.linkJournals.get(params.sim);
    if (journal) {
      // a machine keeps its mask through a reset, so the next booked one is recorded even if it is the same
      journal.keys = -1;
      this.journal(params.sim, { frame: 0, kind: 'reset', cartRam: this.cartRamDigest(sim) });
    }
    if (sim.pointer === this.raSimPointer) {
      this.ra.reset();
      this.flushRetroAchievements();
    }
  }

  // the worklet holds up to VB_AUDIO_BUFFER_COUNT filled buffers and only drains them while the context runs, so
  // a state jump while suspended would play the old state's sound on resume. The flush travels the audio port,
  // so it lands after everything stale and before anything fresh
  protected flushAudio(): void {
    this.audioPort.postMessage({ flush: true });
  }

  protected setKeys(params: Params<'setKeys'>): void {
    const sim = this.requireSim(params.sim);
    if (this.lockstepSims.has(params.sim)) {
      // only a booked mask may reach a machine under lockstep. A press still in flight when a session started would
      // land on this window's copy only, and the two windows would run different games
      this.journal(params.sim, { frame: this.framesRun, kind: 'refusedKeys', keys: params.keys });
      return;
    }
    sim.heldKeys = params.keys;
    this.pushKeys(sim, true);
  }

  protected setTurbo(params: Params<'setTurbo'>): void {
    const sim = this.requireSim(params.sim);
    if (this.lockstepSims.has(params.sim)) {
      // the session books turbo into every frame's mask itself; applied here it would reach only this window's copy
      return;
    }
    const keys = params.keys >>> 0;
    sim.turbo = keys !== 0 ? { keys, rate: params.rate } : undefined;
    this.pushKeys(sim, true);
  }

  // hand the core the mask for the coming frame: what is held, plus turbo buttons while they are down. force
  // hands it over even when unchanged, as a restored state may have left the core holding something else
  protected pushKeys(sim: SimState, force = false): void {
    const keys = sim.turbo
      ? withTurbo(sim.heldKeys, sim.turbo.keys, this.framesRun, sim.turbo.rate)
      : sim.heldKeys;
    if (keys === sim.keys && !force) {
      return;
    }
    sim.keys = keys;
    this.wasm.vbSetKeys(sim.pointer, keys);
  }

  // move every turbo button to the half of its period the coming frame falls in, before every frame. A
  // simulation under lockstep is skipped, its bookings already carry turbo
  protected applyTurbo(): void {
    for (const [handle, sim] of this.sims) {
      if (sim.turbo && !this.lockstepSims.has(handle)) {
        this.pushKeys(sim);
      }
    }
  }

  // keyed by handle, not pointer: this schedules for whoever drives the simulation, well before the frame runs
  protected queueKeys(params: Params<'queueKeys'>): void {
    this.requireSim(params.sim);
    const frame = Math.trunc(params.frame);
    if (frame < this.framesRun) {
      throw new Error(
        `Frame ${frame} has already been emulated; the machine is at ${this.framesRun}.`,
      );
    }
    if (frame > this.framesRun + Worker.MAX_SCHEDULED_FRAMES) {
      throw new Error(
        `Frame ${frame} is more than ${Worker.MAX_SCHEDULED_FRAMES} frames ahead of ${this.framesRun}.`,
      );
    }

    let schedule = this.keySchedules.get(params.sim);
    if (!schedule) {
      schedule = new Map();
      this.keySchedules.set(params.sim, schedule);
    }
    schedule.set(frame, params.keys);
  }

  // bounded and refused exactly as queueKeys. Booked edits accumulate rather than replace, so two windows aiming
  // at one frame both get their way, in sending order
  protected queueEdits(params: Params<'queueEdits'>): void {
    this.requireSim(params.sim);
    const frame = Math.trunc(params.frame);
    if (frame < this.framesRun) {
      throw new Error(
        `Frame ${frame} has already been emulated; the machine is at ${this.framesRun}.`,
      );
    }
    if (frame > this.framesRun + Worker.MAX_SCHEDULED_FRAMES) {
      throw new Error(
        `Frame ${frame} is more than ${Worker.MAX_SCHEDULED_FRAMES} frames ahead of ${this.framesRun}.`,
      );
    }
    if (params.edits.length === 0) {
      return;
    }

    let schedule = this.editSchedules.get(params.sim);
    if (!schedule) {
      schedule = new Map();
      this.editSchedules.set(params.sim, schedule);
    }
    const booked = schedule.get(frame);
    if (booked) {
      booked.push(...params.edits);
    } else {
      schedule.set(frame, [...params.edits]);
    }
  }

  // before the frame, so a cheat switched on at frame N is in force for frame N in both windows, or a digest
  // would see them disagree. A missed frame's bookings are applied late rather than skipped: stepping and
  // rewinding move the count in ways a booking cannot foresee
  protected applyScheduledEdits(): void {
    if (this.editSchedules.size === 0) {
      return;
    }
    for (const [handle, schedule] of this.editSchedules) {
      const sim = this.sims.get(handle);
      if (!sim) {
        this.editSchedules.delete(handle);
        continue;
      }
      // oldest first: two writes to one address land in booking order, whichever frames they were booked against
      const due = [...schedule.keys()].filter(frame => frame <= this.framesRun).sort();
      for (const frame of due) {
        const edits = schedule.get(frame) ?? [];
        if (edits.length > 0) {
          this.journal(handle, { frame: this.framesRun, kind: 'edits', edits });
        }
        for (const edit of edits) {
          this.applyEdit(sim, edit);
        }
        schedule.delete(frame);
      }
      if (schedule.size === 0) {
        this.editSchedules.delete(handle);
      }
    }
  }

  // one booked write, by the same route the unscheduled command takes
  protected applyEdit(sim: SimState, edit: ScheduledEdit): void {
    if (edit.kind === 'cheats') {
      this.syncRomCheats(sim, edit.codes);
      if (edit.codes.length > 0) {
        this.cheats.set(sim.pointer, edit.codes);
      } else {
        this.cheats.delete(sim.pointer);
      }
      return;
    }
    for (let i = 0; i < edit.bytes.length; i++) {
      this.wasm.vbWrite(
        sim.pointer,
        (edit.address + i) >>> 0,
        VbDataType.U8,
        edit.bytes[i] & 0xff,
      );
    }
  }

  // drop every booking, as the frame numbers they name are about to stop meaning anything. Also clears the
  // waiting state so the lockstep driver is not left with a stale one
  protected forgetSchedules(): void {
    this.keySchedules.clear();
    // a poke aimed at frame 200 of a finished run would otherwise land on frame 200 of the next one
    this.editSchedules.clear();
    // the frame count goes back to zero, so a stale mark would silence the progress report until the count
    // caught up
    this.lastProgressReport = 0;
    this.reportAwaitingInput(false, []);
  }

  protected setLockstep(params: Params<'setLockstep'>): void {
    this.requireSim(params.sim);
    if (params.enabled) {
      this.lockstepSims.add(params.sim);
      this.linkJournals.set(params.sim, { entries: [], keys: -1 });
      // from here the session books turbo into the masks itself; solo turbo is over
      const sim = this.sims.get(params.sim);
      if (sim) {
        sim.turbo = undefined;
      }
    } else {
      this.lockstepSims.delete(params.sim);
      this.linkJournals.delete(params.sim);
      // nothing is holding for it any more; let the loop notice at once
      this.keySchedules.delete(params.sim);
      // writes booked for a session that has ended have nobody to agree with
      this.editSchedules.delete(params.sim);
    }
  }

  // which lockstep simulations have nothing booked for this frame; a solo session costs one empty set lookup
  protected simsMissingInput(): SimHandle[] {
    if (this.lockstepSims.size === 0) {
      return [];
    }
    const missing: SimHandle[] = [];
    for (const handle of this.lockstepSims) {
      if (!this.keySchedules.get(handle)?.has(this.framesRun)) {
        missing.push(handle);
      }
    }
    return missing;
  }

  // silent for a solo emulator, which has no schedule to keep filled
  protected reportProgress(): void {
    if (this.lockstepSims.size === 0) {
      return;
    }
    if (this.framesRun - this.lastProgressReport < Worker.PROGRESS_REPORT_FRAMES) {
      return;
    }
    this.lastProgressReport = this.framesRun;
    this.emit({ event: 'progress', payload: { frame: this.framesRun } });
  }

  // only on the change
  protected reportAwaitingInput(waiting: boolean, sims: SimHandle[]): void {
    if (waiting === this.awaitingInput) {
      return;
    }
    this.awaitingInput = waiting;
    this.emit({
      event: 'awaitingInput',
      payload: { waiting, frame: this.framesRun, sims },
    });
  }

  // a frame with nothing booked keeps its mask, which makes a held button hold: a schedule only carries changes
  protected applyScheduledKeys(): void {
    if (this.keySchedules.size === 0) {
      return;
    }
    for (const [handle, schedule] of this.keySchedules) {
      const sim = this.sims.get(handle);
      if (!sim) {
        this.keySchedules.delete(handle);
        continue;
      }
      const keys = schedule.get(this.framesRun);
      if (keys !== undefined) {
        const journal = this.linkJournals.get(handle);
        if (journal && journal.keys !== keys) {
          journal.keys = keys;
          this.journal(handle, { frame: this.framesRun, kind: 'keys', keys });
        }
        sim.keys = keys;
        sim.heldKeys = keys;
        this.wasm.vbSetKeys(sim.pointer, keys);
      }
      for (const frame of schedule.keys()) {
        if (frame <= this.framesRun) {
          schedule.delete(frame);
        }
      }
    }
  }

  // the core walks from one simulation to its peer directly, so a linked pair has to share a session. order
  // says which end of the cable this simulation is, the peer takes the other, see orderedSims
  protected setPeer(params: Params<'setPeer'>): void {
    const sim = this.requireSim(params.sim);
    if (params.peer === 0) {
      const previous = this.wasm.vbGetPeer(sim.pointer);
      this.wasm.vbSetPeer(sim.pointer, 0);
      sim.linkOrder = 0;
      const other = previous === 0 ? undefined : this.sims.get(previous);
      if (other) {
        this.wasm.vbSetPeer(other.pointer, 0);
        other.linkOrder = 0;
      }
      // the order the core gets the simulations in has changed, so history taken under the old one no longer lines up
      this.refreshSimPointers();
      this.refreshPeered();
      this.clearRewind();
      return;
    }

    const peer = this.requireSim(params.peer);
    if (peer.pointer === sim.pointer) {
      throw new Error('A simulation cannot be linked to itself.');
    }
    this.wasm.vbSetPeer(sim.pointer, peer.pointer);
    this.wasm.vbSetPeer(peer.pointer, sim.pointer);
    sim.linkOrder = params.order === 2 ? 2 : 1;
    peer.linkOrder = sim.linkOrder === 1 ? 2 : 1;
    this.refreshSimPointers();
    this.refreshPeered();

    // the pair now snapshots as a unit, so history of them apart is no longer restorable
    this.clearRewind();
  }

  /**
   * The simulations in the order Emulate is handed them: cable order, not creation order. One Emulate call advances
   * a linked pair together, and the same machines, cartridge and input emulate the cable differently the other way
   * round. Each window plays its own machine and a mirror of its partner's, so the two build pairs in opposite orders,
   * and that desynced them within a second (tests/link-order-probe.mjs). The sort is stable and unpaired simulations
   * carry 0, so a session with no cable is unaffected.
   */
  protected orderedSims(): SimState[] {
    const sims = [...this.sims.values()];
    return sims.some(sim => sim.linkOrder !== 0)
      ? sims.sort((a, b) => a.linkOrder - b.linkOrder)
      : sims;
  }

  protected setVolume(params: Params<'setVolume'>): void {
    this.wasm.SetVolume(this.requireSim(params.sim).pointer, params.volume);
  }

  protected setPanning(params: Params<'setPanning'>): void {
    this.wasm.SetPanning(this.requireSim(params.sim).pointer, params.panning);
  }

  protected run(): void {
    if (this.emulating) {
      return;
    }
    this.emulating = true;
    this.graceAll();
    // start the speed window here, or the first report after a pause would include the pause
    this.lastSpeedReport = 0;
    this.chunksSinceReport = 0;
    this.busySinceReport = 0;
    this.drive();
  }

  protected suspend(): void {
    // no report here: while paused the readouts keep the last rate measured
    this.emulating = false;
  }

  // the whole simulation is one flat struct, so a snapshot is a copy of it. Verified byte-exact on replay, see
  // scripts/savestate-probe.mjs
  protected snapshot(sim: SimState): ArrayBuffer {
    return new Uint8Array(
      this.wasm.memory.buffer,
      sim.pointer,
      this.wasm.vbSizeOf(),
    ).slice().buffer;
  }

  // the struct holds three absolute pointers into core memory (cart RAM, cart ROM, sample buffer) belonging to
  // whichever simulation produced the snapshot. The setters are pure assignments, so re-applying ours is safe; the
  // sample pointer is re-armed by the drive loop before every chunk anyway
  protected restore(sim: SimState, state: ArrayBuffer): void {
    const size = this.wasm.vbSizeOf();
    if (state.byteLength !== size) {
      throw new Error(
        `This save state is ${state.byteLength} bytes but this emulator core uses ${size}. ` +
          'It was probably made with a different version.',
      );
    }
    this.restoreFrom(sim, new Uint8Array(state));
  }

  protected restoreFrom(sim: SimState, state: Uint8Array): void {
    const size = this.wasm.vbSizeOf();
    new Uint8Array(this.wasm.memory.buffer, sim.pointer, size).set(state);
    this.clearPixelOrigins(sim.pointer);

    if (sim.cartRom !== 0) {
      this.wasm.vbSetCartROM(sim.pointer, sim.cartRom, sim.cartRomSize);
    }
    if (sim.cartRam !== 0) {
      this.wasm.vbSetCartRAM(sim.pointer, sim.cartRam, sim.cartRamSize);
    }
    this.wasm.vbSetSamples(
      sim.pointer,
      sim.samples,
      VbDataType.F32,
      VB_SAMPLES_PER_BUFFER,
    );
    // save states contain the whole core struct, including Phase-5's hardware model flag. The current emulator
    // selection wins over the state file
    this.wasm.SetHardwareMode?.(sim.pointer, sim.vbcHardware ? 1 : 0);
    // the depth lives in the struct too, so a state would otherwise bring back its own
    this.applyStereoDepth(sim.pointer);
    // so does the execute callback, so a state older than the live profiler would switch it off
    this.rearmLiveProfiler(sim.pointer);
    // the write and read watches too (measured, tests/restore-callback-probe.mjs). A rewind step comes through here
    // as well, and without this every capture built on them goes deaf, e.g. the VSU panel's shadow
    this.updateWriteWatch(sim.pointer);
    this.updateReadWatch(sim.pointer);
  }

  // only one at a time, for one simulation: a developer deliberately capturing a run to profile
  protected recording?: {
    pointer: number;
    state: ArrayBuffer;
    chunks: number;
    keys: [number, number][];
    lastMask: number;
  };

  protected startProfileRecording(params: Params<'startProfileRecording'>): void {
    const sim = this.requireSim(params.sim);
    this.recording = {
      pointer: sim.pointer,
      state: this.snapshot(sim),
      chunks: 0,
      keys: [[0, sim.keys]], // the mask in force at chunk zero, so a replay starts pressing what was being pressed
      lastMask: sim.keys,
    };
  }

  protected stopProfileRecording(params: Params<'stopProfileRecording'>): Recording {
    const recording = this.recording;
    this.recording = undefined;
    if (!recording || recording.pointer !== this.requireSim(params.sim).pointer) {
      throw new Error('That simulation is not being recorded.');
    }
    return { state: recording.state, chunks: recording.chunks, keys: recording.keys };
  }

  // called once per chunk, before it runs. Input only changes between chunks, so the mask now is what the whole
  // chunk saw, and only changes are written down
  protected recordChunk(sims: SimState[]): void {
    const recording = this.recording;
    if (!recording) {
      return;
    }
    const sim = sims.find(candidate => candidate.pointer === recording.pointer);
    if (!sim) {
      // the simulation went away underneath the recording
      this.recording = undefined;
      return;
    }
    if (sim.keys !== recording.lastMask) {
      recording.keys.push([recording.chunks, sim.keys]);
      recording.lastMask = sim.keys;
    }
    recording.chunks++;
  }

  /**
   * Replays on the recording's own simulation, borrowed for the duration: its state is put aside, the recording
   * restored over it and replayed, and the state put back. A scratch simulation is NOT faithful: the core keeps a copy
   * of the cartridge pointer that vbSetCartROM does not reach, so a state restored elsewhere reads through a foreign
   * buffer. Measured in tests/replay-probe.mjs.
   */
  protected replayProfile(params: Params<'replayProfile'>): ProfileResult {
    const sim = this.requireSim(params.sim);
    const { recording } = params;
    if (recording.state.byteLength !== this.wasm.vbSizeOf()) {
      throw new Error('That recording was made with a different emulator core.');
    }

    const rom = this.u8(sim.cartRom, sim.cartRomSize);
    const kinds = decodeRomKinds(rom);
    // the program counter runs in the cartridge's top-of-memory mirror, so an address has to come back to a ROM
    // offset before it can be looked up
    const mask = sim.cartRomSize - 1;
    const powerOfTwo = sim.cartRomSize > 0 && (sim.cartRomSize & mask) === 0;
    const collector = new VesProfileCollector();

    const slot = installVbCallback(this.wasm, (unused, address) => {
      const offset = powerOfTwo
        ? (address >>> 0) & mask
        : ((address >>> 0) & 0x00ffffff) % sim.cartRomSize;
      collector.push(address >>> 0, kinds[offset >> 1] as VesInstructionKind);
      return 0;
    }, VB_EXECUTE_CALLBACK_ARITY);

    // what the simulation was doing before it was borrowed, put back whatever happens below
    const borrowed = this.snapshot(sim);
    const keysBefore = sim.keys;
    const started = Date.now();

    try {
      this.restoreFrom(sim, new Uint8Array(recording.state));
      this.wasm.vbSetExecuteCallback(sim.pointer, slot);

      const keys = new Map(recording.keys);
      const sims = this.wasm.Realloc(0, 4);
      const clocks = this.wasm.Realloc(0, 4);
      this.u32(sims, 1)[0] = sim.pointer;
      try {
        for (let chunk = 0; chunk < recording.chunks; chunk++) {
          const pressed = keys.get(chunk);
          if (pressed !== undefined) {
            this.wasm.vbSetKeys(sim.pointer, pressed);
          }
          // samples are rewound per chunk as the drive loop does, so the core never runs past the buffer it was given
          this.wasm.vbSetSamples(sim.pointer, sim.samples, VbDataType.F32, VB_SAMPLES_PER_BUFFER);
          if (!this.drainClocks(sims, 1, clocks, VB_CLOCKS_PER_BUFFER, () => undefined)) {
            // the state the recording was made from no longer runs; better a profile that says so than a hung worker
            throw new Error(
              `The replay stopped making progress at chunk ${chunk} of ${recording.chunks}.`,
            );
          }
        }
      } finally {
        this.wasm.Realloc(sims, 0);
        this.wasm.Realloc(clocks, 0);
      }
    } finally {
      // back to whatever this simulation should have had (live profiler, breakpoints), not to nothing regardless
      releaseVbCallback(this.wasm, slot);
      this.updateExecuteWatch(sim.pointer);
      this.restoreFrom(sim, new Uint8Array(borrowed));
      this.wasm.vbSetKeys(sim.pointer, keysBefore);
      // the replay left history describing a run that is being discarded
      this.clearRewind();
    }

    const nodes = collector.finish();
    return {
      nodes: nodes.map(node => ({
        parent: node.parent,
        address: node.address,
        selfSamples: node.selfSamples,
        totalSamples: node.totalSamples,
      })),
      instructions: collector.sampleCount,
      overflows: collector.overflows,
      resets: collector.resetCount,
      elapsedMs: Date.now() - started,
    };
  }

  // a hundred frames is two seconds of play: long enough that a peak is a spike in the game, short enough that a
  // change shows up in the averages while the developer looks at the panel
  protected static readonly LIVE_PROFILE_WINDOW = 100;

  protected static readonly LIVE_PROFILE_WINDOW_MAX = 1000; // so a panel cannot ask for a leak

  // one simulation at a time, as this is already the most expensive thing the inspectors can ask for
  protected live?: {
    pointer: number;
    // a function on the state rather than the callback itself, because the core has one execute callback per
    // simulation and two things want it, see updateExecuteWatch
    step(pc: number): void;
    collector: VesLiveProfileCollector;
    machine: LiveMachine; // the machine's own counters, sampled once a picture
    kinds: Uint8Array; // what every instruction in the cartridge does, decoded once at the start
    romSize: number;
    mask: number;
    powerOfTwo: boolean;
    // clock budget left when the last instruction was seen; the difference to the word now is what that instruction
    // cost, which is why the profile is in clocks, not instruction counts
    left: number;
    // pictures the VIP takes over one drawing (FRMCYC plus one), and how many have gone by since the last frame closed
    cycle: number;
    pictures: number;
    // whether the core reported a frame during this chunk. A game that never switched its display on (boot, crash)
    // never completes a VIP frame, so a chunk that saw none closes one at its end
    framed: boolean;
    // view of the core's countdown word. Rebuilt whenever the drive loop hands the callback a new budget, as a grown
    // heap detaches it, and checking that per instruction would cost too much
    clocks: Uint32Array;
  };

  // the callback installed here crosses into JavaScript once per emulated instruction: 1.54x on a call-heavy loop,
  // leaving the core at three times real speed. Affordable only because it is off unless the panel is on screen.
  // See tests/live-profile-probe.mjs
  protected setLiveProfiler(params: Params<'setLiveProfiler'>): void {
    const sim = this.requireSim(params.sim);
    if (!params.enabled) {
      // only this machine's profile: switching it off must not take down a profile of the other machine of a linked
      // pair that something else has since started
      if (this.live?.pointer === sim.pointer) {
        this.stopLiveProfiler();
      }
      return;
    }
    if (this.live?.pointer === sim.pointer) {
      return;
    }
    // only one at a time; a second request means the panel moved to another machine
    this.stopLiveProfiler();
    if (sim.cartRom === 0 || sim.cartRomSize === 0) {
      throw new Error('There is no cartridge to profile.');
    }

    const window = Math.min(
      Math.max(1, Math.floor(params.window ?? Worker.LIVE_PROFILE_WINDOW)),
      Worker.LIVE_PROFILE_WINDOW_MAX,
    );
    const mask = sim.cartRomSize - 1;
    const live = {
      pointer: sim.pointer,
      step: (unused: number) => { /* replaced below, once `live` exists */ },
      collector: new VesLiveProfileCollector(window),
      machine: { previous: new Uint32Array(VbCounter.Count), frames: [], window },
      kinds: decodeRomKinds(this.u8(sim.cartRom, sim.cartRomSize)),
      romSize: sim.cartRomSize,
      mask,
      powerOfTwo: sim.cartRomSize > 0 && (sim.cartRomSize & mask) === 0,
      left: 0,
      cycle: 1,
      pictures: 0,
      framed: false,
      clocks: this.u32(this.clocksPointer),
    };

    // the hot path: everything it needs is a property of the captured object, and the only call it makes is the
    // collector's own step
    live.step = (pc: number) => {
      const remaining = live.clocks[0];
      const spent = live.left - remaining;
      live.left = remaining;
      // the program counter runs in the cartridge's top-of-memory mirror, so it has to come back to a ROM offset before
      // indexing the decoded table, exactly as the replay does
      const offset = live.powerOfTwo
        ? pc & live.mask
        : (pc & 0x00ffffff) % live.romSize;
      live.collector.step(pc, live.kinds[offset >> 1] as VesInstructionKind, spent);
    };

    this.live = live;
    this.sampleMachine(live.pointer, live.machine, true);
    this.updateExecuteWatch(sim.pointer);
  }

  // keep what the core's counters moved since the last reading as one picture of the window. Priming reads without
  // keeping, so the first picture is not everything since the machine started
  protected sampleMachine(pointer: number, machine: LiveMachine, prime: boolean): void {
    const read = this.wasm.vbGetCounter;
    if (!read) {
      return;
    }
    const delta = new Array<number>(VbCounter.Count);
    for (let id = 0; id < VbCounter.Count; id++) {
      const now = read(pointer, id) >>> 0;
      delta[id] = (now - machine.previous[id]) >>> 0;
      machine.previous[id] = now;
    }
    if (!prime) {
      machine.frames.push(delta);
      if (machine.frames.length > machine.window) {
        machine.frames.shift();
      }
    }
  }

  // the window's counters, the last picture and the average
  protected liveMachine(machine: LiveMachine): LiveMachineCounters | undefined {
    const frames = machine.frames.length;
    if (frames === 0) {
      return undefined;
    }
    const sum = new Array<number>(VbCounter.Count).fill(0);
    for (const frame of machine.frames) {
      for (let id = 0; id < VbCounter.Count; id++) {
        sum[id] += frame[id];
      }
    }
    return {
      frames,
      last: liveMachineFrame(machine.frames[frames - 1]),
      avg: liveMachineFrame(sum.map(value => value / frames)),
    };
  }

  protected stopLiveProfiler(): void {
    const live = this.live;
    if (!live) {
      return;
    }
    this.live = undefined;
    // the simulation may already be gone (this also runs from deleteSim). The shared callback stays installed if
    // breakpoints still want it, see updateExecuteWatch
    if (this.sims.has(live.pointer)) {
      this.updateExecuteWatch(live.pointer);
    }
  }

  // the execute callback lives in the simulation's struct, so restoring a state captured before profiling was
  // switched on silently switches it off. Measured: a callback survives a snapshot taken after it, not one before
  protected rearmLiveProfiler(pointer: number): void {
    this.updateExecuteWatch(pointer);
  }

  // one callback, two customers: the live profiler and breakpoints. The core has a single execute callback per
  // simulation, and whichever installed second would switch the other off; on only while one of them wants it, as it
  // runs on every instruction
  protected updateExecuteWatch(pointer: SimHandle): void {
    const stop = this.stops.get(pointer);
    const wanted = this.live?.pointer === pointer
      || (!this.peered && stop !== undefined && (stop.points.size > 0 || stop.pending !== undefined));
    if (!wanted) {
      this.wasm.vbSetExecuteCallback(pointer, 0);
      return;
    }

    if (this.executeCallbackSlot === 0) {
      this.executeCallbackSlot = installVbCallback(
        this.wasm,
        (watchedSimPointer, address) => {
          const pc = address >>> 0;
          const live = this.live;
          if (live !== undefined && live.pointer === watchedSimPointer) {
            live.step(pc);
          }
          return this.shouldStop(watchedSimPointer, pc) ? 1 : 0;
        },
        VB_EXECUTE_CALLBACK_ARITY,
      );
    }
    this.wasm.vbSetExecuteCallback(pointer, this.executeCallbackSlot);
  }

  // returning true refuses the instruction: the core abandons the Emulate call with the program counter on it,
  // so the reported instruction is about to run. Suspending from in here would be inside the core, so the decision
  // is written down and the drain loop acts on it
  protected shouldStop(pointer: SimHandle, address: number): boolean {
    const stop = this.stops.get(pointer);
    if (stop === undefined || this.stopped !== undefined || this.peered) {
      return false;
    }
    if (stop.grace > 0) {
      stop.grace--;
      return false;
    }

    const pending = stop.pending;
    if (pending !== undefined && (pending.at === undefined || pending.at === address)) {
      stop.pending = undefined;
      this.stopped = { pointer, address, reason: pending.reason, write: pending.write };
      return true;
    }
    if (stop.points.has(address)) {
      this.stopped = { pointer, address, reason: StopReason.BREAKPOINT };
      return true;
    }
    return false;
  }

  // a stop mid-frame is something a linked pair cannot take: the frame counts as run with part of its clocks
  // unspent, while the other window's copy spends them all. So breakpoints are kept but not armed while peered,
  // and stepping is refused. A flag, as the execute callback asks on every instruction
  protected peered = false;

  protected refuseWhilePeered(): void {
    if (this.peered) {
      throw new Error('Breakpoints and stepping are not available while two players are linked.');
    }
  }

  // work peered out again, and arm or disarm the breakpoints to match
  protected refreshPeered(): void {
    const peered = [...this.sims.values()].some(sim => sim.linkOrder !== 0);
    if (peered === this.peered) {
      return;
    }
    this.peered = peered;
    if (!peered) {
      // a grace is for resuming from a stop; left in place, one given when the linked pair started would swallow the
      // first breakpoint hit
      for (const stop of this.stops.values()) {
        stop.grace = 0;
      }
    }
    for (const sim of this.sims.values()) {
      this.updateExecuteWatch(sim.pointer);
    }
  }

  protected stopFor(pointer: SimHandle): SimStop {
    let stop = this.stops.get(pointer);
    if (stop === undefined) {
      stop = { points: new Set<number>(), grace: 0 };
      this.stops.set(pointer, stop);
    }
    return stop;
  }

  protected setBreakpoints(params: Params<'setBreakpoints'>): void {
    const sim = this.requireSim(params.sim);
    const stop = this.stopFor(sim.pointer);
    stop.points = new Set(params.addresses.map(address => address >>> 0));
    if (stop.points.size === 0 && stop.pending === undefined) {
      this.stops.delete(sim.pointer);
    }
    this.updateExecuteWatch(sim.pointer);
  }

  protected runTo(params: Params<'runTo'>): void {
    const sim = this.requireSim(params.sim);
    this.refuseWhilePeered();
    const stop = this.stopFor(sim.pointer);
    stop.pending = { reason: StopReason.CURSOR, at: params.address >>> 0 };
    this.updateExecuteWatch(sim.pointer);
  }

  // driven from here like stepFrame, not by the drive loop. The budget is a frame's worth of clocks: far more
  // than one instruction needs, but bounded if it turns out to be an interrupt. A machine not reporting a second
  // instruction in that time is stuck, and says so like a stalled one
  protected stepInstruction(params: Params<'stepInstruction'>): void {
    const sim = this.requireSim(params.sim);
    this.refuseWhilePeered();
    const sims = this.orderedSims();
    if (sims.length === 0) {
      return;
    }
    const stop = this.stopFor(sim.pointer);
    stop.pending = { reason: StopReason.STEP };
    // the instruction stood on is reported before it runs, so one sighting has to go past for the machine to move
    stop.grace = 1;
    this.updateExecuteWatch(sim.pointer);

    this.drainClocks(
      this.simsPointer, sims.length, this.clocksPointer, VB_CLOCKS_PER_BUFFER,
      () => {
        if (this.gamePakInterrupts.size > 0) {
          this.serviceGamePakInterrupts();
        }
      });

    if (this.stopped === undefined) {
      // a frame of clocks without a second instruction is a machine that has stopped advancing
      stop.pending = undefined;
      this.updateExecuteWatch(sim.pointer);
      this.stall();
      return;
    }
    this.settleStop();
    this.presentAll();
  }

  // suspend and say where, if the callback refused an instruction. Called wherever a drain has finished, as
  // suspending inside the callback would unwind through Emulate
  protected settleStop(): boolean {
    const stopped = this.stopped;
    if (stopped === undefined) {
      return false;
    }
    this.stopped = undefined;
    this.pendingClocks = 0;
    this.suspend();

    // a sprung one-shot leaves nothing behind, so the callback comes off unless breakpoints still want it
    const stop = this.stops.get(stopped.pointer);
    if (stop !== undefined && stop.points.size === 0 && stop.pending === undefined) {
      this.stops.delete(stopped.pointer);
    }
    this.updateExecuteWatch(stopped.pointer);

    // a sprung write stop is gone; the write callback may be too
    this.updateWriteWatch(stopped.pointer);

    this.emit({
      event: 'stopped',
      payload: {
        sim: stopped.pointer,
        address: stopped.address,
        reason: stopped.reason,
        ...(stopped.write ? { write: stopped.write } : {}),
      },
    });
    return true;
  }

  protected setWriteStop(params: Params<'setWriteStop'>): void {
    const sim = this.requireSim(params.sim);
    if (params.ranges.length === 0) {
      this.writeStops.delete(sim.pointer);
    } else {
      this.refuseWhilePeered();
      this.writeStops.set(sim.pointer, params.ranges.map(range => {
        const start = Worker.writeStopAddress(range.address >>> 0);
        return { start, end: start + Math.max(1, range.length) };
      }));
    }
    this.updateWriteWatch(sim.pointer);
  }

  // an address as a write stop compares it: the VIP's 512 KiB and the VCU's 1 MiB however they were reached, the
  // rest by its 27 bits
  protected static writeStopAddress(address: number): number {
    switch ((address >>> 24) & 7) {
      case 0: return (address & 0x7ffff) >>> 0;
      case 3: return (0x03000000 | (address & 0xfffff)) >>> 0;
      default: return (address & 0x07ffffff) >>> 0;
    }
  }

  // from inside the write callback: if the store lands in a range a write stop waits on, lay a stop for the next
  // instruction, so it stops with the store done
  protected checkWriteStop(pointer: SimHandle, address: number, type: number, valuePointer: number): void {
    const ranges = this.writeStops.get(pointer);
    if (ranges === undefined || this.peered || this.stopped !== undefined) {
      return;
    }
    const size = type === VbDataType.S32 ? 4 : type === VbDataType.S16 || type === VbDataType.U16 ? 2 : 1;
    const at = Worker.writeStopAddress(address);
    if (!ranges.some(range => at < range.end && at + size > range.start)) {
      return;
    }
    const view = new DataView(this.wasm.memory.buffer);
    const value = size === 4 ? view.getUint32(valuePointer, true)
      : size === 2 ? view.getUint16(valuePointer, true) : view.getUint8(valuePointer);
    this.writeStops.delete(pointer);
    const stop = this.stopFor(pointer);
    stop.pending = {
      reason: StopReason.WRITE,
      write: { pc: this.wasm.vbGetProgramCounter(pointer) >>> 0, address: address >>> 0, value, size },
    };
    stop.grace = 0;
    // only a field in the machine's struct, read before its next instruction
    this.updateExecuteWatch(pointer);
  }

  // run from run(), or resuming from a breakpoint would trip over the same breakpoint before anything moved
  protected graceAll(): void {
    for (const stop of this.stops.values()) {
      stop.grace = Math.max(stop.grace, 1);
    }
  }

  /**
   * Closes a profiled frame, including what the running instruction has cost so far. A picture is not always a
   * frame: FRMCYC (VUEngine's __FRAME_CYCLE, set by e.g. Mario's Tennis and Virtual WarZone) makes the VIP draw every
   * second or fourth one, and such a game works through one picture and waits through the next. So the register
   * decides where a frame ends, and the budget scales with it. The view is rebuilt rather than trusted, as work in the
   * between-callback can grow core memory. `force` closes whatever has accumulated, for a machine that reports no
   * pictures at all (boot, crash, display off).
   */
  protected endLiveFrame(force = false): void {
    const live = this.live;
    if (!live) {
      return;
    }
    live.framed = true;
    if (!force) {
      live.cycle = this.frameCycle(live.pointer);
      if (++live.pictures < live.cycle) {
        // the end of a picture, not of a frame: the clocks stay on live.left and reach the collector with the next
        // instruction, or with the picture that does end the frame
        return;
      }
    }
    live.pictures = 0;
    live.clocks = this.u32(this.clocksPointer);
    const remaining = live.clocks[0];
    live.collector.endFrame(live.left - remaining);
    live.left = remaining;
  }

  // read every picture, as a game can change it. Four bits, one more than the field, so zero means every picture.
  // VipRegister.FRMCYC is the panel's name for the same halfword
  protected frameCycle(pointer: number): number {
    const frmcyc = this.wasm.vbRead(pointer, VIP_FRMCYC, VbDataType.U16);
    return (frmcyc & 0x0f) + 1;
  }

  protected readLiveProfile(
    params: Params<'readLiveProfile'>,
  ): LiveProfileSnapshot | undefined {
    const sim = this.requireSim(params.sim);
    if (this.live?.pointer !== sim.pointer) {
      return undefined;
    }
    // a frame's worth of clocks is a picture's worth for each picture the VIP takes over a drawing, see endLiveFrame
    const snapshot = this.live.collector.snapshot(
      VB_CLOCKS_PER_BUFFER * this.live.cycle, params.pin);
    snapshot.machine = this.liveMachine(this.live.machine);
    return snapshot;
  }

  protected saveState(params: Params<'saveState'>): ArrayBuffer {
    return this.snapshot(this.requireSim(params.sim));
  }

  protected loadState(params: Params<'loadState'>): void {
    const sim = this.requireSim(params.sim);
    this.restore(sim, params.state);
    if (params.clearCaches) {
      // CHCW with ICC: clear all 128 entries from the first, keeping whether the cache is on. It held another ROM's code
      const enabled = this.wasm.vbGetSystemRegister(sim.pointer, VbSystemRegister.CHCW) & 0x2;
      this.wasm.vbSetSystemRegister(sim.pointer, VbSystemRegister.CHCW, enabled | (128 << 8) | 1);
    }
    // loading lands somewhere unrelated to the rewind history
    this.clearRewind();
    this.flushAudio();
    this.presentRestored(sim, 'jump');
    // whatever the engine had counted (hit counts, delta memory references) described the abandoned run
    if (sim.pointer === this.raSimPointer) {
      this.ra.reset();
      this.flushRetroAchievements();
    }
  }

  protected setSpeed(params: Params<'setSpeed'>): void {
    if (!(params.speed > 0)) {
      throw new Error(
        `Emulation speed must be greater than zero, got ${params.speed}.`,
      );
    }
    this.speed = params.speed;
    this.pendingClocks = 0;
  }

  protected setStereoDepth(params: Params<'setStereoDepth'>): void {
    if (!Number.isFinite(params.depth)) {
      throw new Error(`Stereo depth must be a number, got ${params.depth}.`);
    }
    this.stereoDepth = Math.max(0, Math.min(Math.round(params.depth), 200));
    for (const sim of this.sims.values()) {
      this.applyStereoDepth(sim.pointer);
    }
  }

  protected setColumnGeometry(params: Params<'setColumnGeometry'>): void {
    this.columnGeometry = params.enabled;
    this.presentAll();
  }

  protected applyStereoDepth(pointer: number): void {
    this.wasm.vbSetOption(pointer, VbOption.STEREO_DEPTH, this.stereoDepth);
  }

  // advance one frame while suspended, for frame-by-frame inspection
  protected stepFrame(): void {
    const sims = this.orderedSims();
    if (sims.length === 0) {
      return;
    }

    const missing = this.simsMissingInput();
    if (missing.length > 0) {
      // stepping past input that has not arrived would put this machine ahead of its peer just as running would
      this.reportAwaitingInput(true, missing);
      return;
    }
    this.reportAwaitingInput(false, []);

    this.captureRewindEntry(sims);
    this.applyScheduledKeys();
    this.applyTurbo();
    this.applyScheduledEdits();

    // a frame is ~400000 clocks; allow a generous margin so a simulation that never raises the flag cannot spin forever
    let remaining = VB_CLOCKS_PER_BUFFER * 4;
    let framed = false;
    while (!framed && remaining > 0) {
      const budget = Math.min(remaining, VB_CLOCKS_PER_BUFFER);
      remaining -= budget;
      const advanced = this.drainClocks(
        this.simsPointer, sims.length, this.clocksPointer, budget, () => {
          if (this.gamePakInterrupts.size > 0) {
            this.serviceGamePakInterrupts();
          }
          for (const sim of sims) {
            if (this.wasm.GetBreaks(sim.pointer) & VbBreak.FRAME) {
              this.applyCheats(sim.pointer);
              this.applyVsuMutes(sim.pointer);
              if (sim.pointer === this.raSimPointer) {
                this.ra.doFrame();
              }
              this.wasm.GetPixels(sim.pointer);
              this.captureShownOrigins(sim.pointer);
              framed = true;
            }
          }
        });
      if (!advanced) {
        // stepping is done while suspended, so there is no drive loop to stop, but the machine is just as stuck
        this.stall();
        break;
      }
    }

    // counted like any other frame, so a schedule keyed on the frame number stays usable when stepping
    if (framed) {
      this.framesRun++;
      this.rewind.frames++;
    }

    this.presentAll();
    this.flushRetroAchievements();
  }

  protected setRewind(params: Params<'setRewind'>): void {
    this.rewind.enabled = params.enabled;
    this.rewind.granularity = Math.max(1, Math.floor(params.granularity));
    this.rewind.budgetBytes = Math.max(0, params.budgetBytes);
    this.rewind.frames = 0;
    this.clearRewind();
  }

  // the next capture re-seeds the mirrors
  protected clearRewind(): void {
    this.rewind.entries = [];
    this.rewind.mirrors = [];
    this.rewind.captures = [];
    this.rewind.cursor = 0;
    this.rewind.bytes = 0;
    this.rewind.thumbnailFrame = -Infinity;
  }

  protected liveState(sim: SimState): Uint8Array {
    return new Uint8Array(
      this.wasm.memory.buffer,
      sim.pointer,
      this.wasm.vbSizeOf(),
    );
  }

  // `now` is the filmstrip asking: a thumbnail whether one is due or not, and no entry if nothing changed since the
  // newest capture, which then stands for now
  protected captureRewindEntry(sims: SimState[], now = false): void {
    if (
      !this.rewind.enabled ||
      this.rewind.budgetBytes === 0 ||
      sims.length === 0
    ) {
      return;
    }

    // the first capture, or one after the session changed shape, has nothing to diff against and only seeds the mirrors
    if (this.rewind.mirrors.length !== sims.length) {
      this.rewind.entries = [];
      this.rewind.bytes = 0;
      this.rewind.mirrors = sims.map(sim => this.liveState(sim).slice());
      this.rewind.captures = [{ frame: this.rewind.frames }];
      this.rewind.cursor = 0;
      this.rewind.thumbnailFrame = -Infinity;
      this.takeRewindThumbnail(sims[0], this.rewind.captures[0], now);
      return;
    }

    // the machine moved on from a capture browsed back to, so what came after it can no longer happen
    this.dropRewindFuture();

    const entry: Uint8Array[] = [];
    let added = 0;
    for (let i = 0; i < sims.length; i++) {
      const live = this.liveState(sims[i]);
      const delta = encodeDelta(this.rewind.mirrors[i], live, this.runScratch);
      entry.push(delta);
      added += delta.length;
      this.rewind.mirrors[i].set(live);
    }

    if (now && added === 0) {
      this.takeRewindThumbnail(sims[0], this.rewind.captures[this.rewind.cursor], true);
      return;
    }

    const capture: RewindCapture = { frame: this.rewind.frames };
    this.rewind.entries.push(entry);
    this.rewind.captures.push(capture);
    this.rewind.cursor = this.rewind.captures.length - 1;
    this.rewind.bytes += added;
    this.takeRewindThumbnail(sims[0], capture, now);

    while (
      this.rewind.bytes > this.rewind.budgetBytes &&
      this.rewind.entries.length > 0
    ) {
      const dropped = this.rewind.entries.shift()!;
      for (const delta of dropped) {
        this.rewind.bytes -= delta.length;
      }
      this.rewind.bytes -= this.rewind.captures.shift()!.thumbnail?.pixels.length ?? 0;
      this.rewind.cursor--;
    }
  }

  // rewind is off while linked, so the one simulation is the picture there is. Taken from the frame as shown, since a
  // capture on a busy chunk may not have staged one
  protected takeRewindThumbnail(sim: SimState, capture: RewindCapture, force: boolean): void {
    if (!force && this.rewind.frames - this.rewind.thumbnailFrame < REWIND_THUMBNAIL_FRAMES) {
      return;
    }
    const colorMode = this.isVbcColorOutput(sim);
    if (colorMode) {
      this.wasm.GetColorPixels!(sim.pointer);
    } else {
      this.wasm.GetPixels(sim.pointer);
    }
    const pixels = shrinkFrame(
      this.shownPixels(sim, colorMode),
      colorMode ? VBC_FRAME_WIDTH : VB_SCREEN_WIDTH,
      VB_SCREEN_HEIGHT,
      colorMode ? 3 : 2,
    );
    this.rewind.bytes += pixels.length - (capture.thumbnail?.pixels.length ?? 0);
    capture.thumbnail = { pixels, colorMode };
    this.rewind.thumbnailFrame = this.rewind.frames;
  }

  // the captures after the cursor, along with the frame count, which carries on from the capture as it did back then
  protected dropRewindFuture(): void {
    const { cursor, captures } = this.rewind;
    if (cursor >= captures.length - 1) {
      return;
    }
    for (const entry of this.rewind.entries.splice(cursor)) {
      for (const delta of entry) {
        this.rewind.bytes -= delta.length;
      }
    }
    for (const capture of captures.splice(cursor + 1)) {
      this.rewind.bytes -= capture.thumbnail?.pixels.length ?? 0;
    }
    this.rewind.frames = captures[cursor].frame;
    let last = cursor;
    while (last >= 0 && !captures[last].thumbnail) {
      last--;
    }
    this.rewind.thumbnailFrame = last >= 0 ? captures[last].frame : -Infinity;
  }

  // XOR passes over the mirrors only; the simulations are left to the caller
  protected moveRewindCursor(index: number): void {
    const target = Math.max(0, Math.min(index, this.rewind.captures.length - 1));
    while (this.rewind.cursor > target) {
      this.rewind.cursor--;
      const entry = this.rewind.entries[this.rewind.cursor];
      entry.forEach((delta, i) => applyDelta(this.rewind.mirrors[i], delta));
    }
    while (this.rewind.cursor < target) {
      const entry = this.rewind.entries[this.rewind.cursor];
      entry.forEach((delta, i) => applyDelta(this.rewind.mirrors[i], delta));
      this.rewind.cursor++;
    }
  }

  protected restoreRewindCursor(sims: SimState[], kind: FrameKind): void {
    for (let i = 0; i < sims.length; i++) {
      this.restoreFrom(sims[i], this.rewind.mirrors[i]);
      this.presentRestored(sims[i], kind);
    }
  }

  /**
   * Only the state landed on reaches the simulations and screen; the deltas in between are XOR passes over the
   * mirrors, so several entries cost one restore and one present. Unlike loadState this does not reset the
   * achievement engine, as rewind lands here several times a second. A hit count can read a little stale right after
   * and settles once play resumes; rewind is off under hardcore anyway.
   */
  protected rewindStep(params: Params<'rewindStep'>): number {
    const sims = this.orderedSims();
    if (this.rewind.mirrors.length !== sims.length) {
      return 0;
    }

    const requested = Math.max(1, Math.floor(params.count ?? 1));
    const from = this.rewind.cursor;
    this.moveRewindCursor(from - requested);
    // held rewind does not come back, so it gives up what it walked through at once, as it always has
    this.dropRewindFuture();
    const applied = from - this.rewind.cursor;
    if (applied === 0) {
      return 0;
    }

    this.restoreRewindCursor(sims, 'next');
    return applied;
  }

  protected rewindHistory(params: Params<'rewindHistory'>): RewindHistory {
    this.requireSim(params.sim);
    const sims = this.orderedSims();
    this.captureRewindEntry(sims, true);
    const { captures, cursor } = this.rewind;
    if (this.rewind.mirrors.length !== sims.length || captures.length === 0) {
      return { frames: [], thumbnails: [], cursor: -1 };
    }
    const thumbnails: number[] = [];
    captures.forEach((capture, index) => {
      if (capture.thumbnail) {
        thumbnails.push(index);
      }
    });
    return { frames: captures.map(capture => capture.frame), thumbnails, cursor };
  }

  // as a loaded state, so frame blending does not mix two moments seconds apart
  protected rewindSeek(params: Params<'rewindSeek'>): number {
    const sims = this.orderedSims();
    if (this.rewind.mirrors.length !== sims.length || this.rewind.captures.length === 0) {
      return -1;
    }
    const from = this.rewind.cursor;
    this.moveRewindCursor(Math.floor(params.index));
    if (this.rewind.cursor !== from) {
      this.restoreRewindCursor(sims, 'jump');
    }
    return this.rewind.cursor;
  }

  // enlarged back to a whole frame in the transport format, for a renderer to compose
  protected readRewindThumbnail(params: Params<'readRewindThumbnail'>): Frame | undefined {
    const thumbnail = this.rewind.captures[params.index]?.thumbnail;
    if (!thumbnail) {
      return undefined;
    }
    const { colorMode } = thumbnail;
    const pixels = new Uint8Array(vbFrameBytes(colorMode));
    growFrame(
      thumbnail.pixels,
      colorMode ? VBC_FRAME_WIDTH : VB_SCREEN_WIDTH,
      VB_SCREEN_HEIGHT,
      colorMode ? 3 : 2,
      pixels,
    );
    return { pixels: pixels.buffer, colorMode };
  }

  // composed now rather than when taken, so it is in the palette on screen. Through the screenshot renderer, which
  // reads its canvas back before anything else can retune it
  protected async rewindThumbnail(params: Params<'rewindThumbnail'>): Promise<ArrayBuffer | undefined> {
    const sim = this.requireSim(params.sim);
    const frame = this.readRewindThumbnail(params);
    if (!frame) {
      return undefined;
    }
    const mode = thumbnailDisplayMode(sim.displayMode);
    if (!this.screenshotRenderer) {
      this.screenshotRenderer = new VbRenderer(new OffscreenCanvas(mode.width, mode.height), mode);
    } else {
      this.screenshotRenderer.setDisplayMode(mode);
    }
    this.screenshotRenderer.present(new Uint8Array(frame.pixels), frame.colorMode, 'jump');
    return this.screenshotRenderer.capture();
  }

  // GetPixels refreshes the framebuffer from the current VIP state first, so this is what the simulation would
  // show right now. Requests are clipped to the screen
  protected readPixels(params: Params<'readPixels'>): ArrayBuffer {
    const sim = this.requireSim(params.sim);

    const left = Math.max(0, Math.min(params.x, VB_SCREEN_WIDTH));
    const top = Math.max(0, Math.min(params.y, VB_SCREEN_HEIGHT));
    const width = Math.max(0, Math.min(params.width, VB_SCREEN_WIDTH - left));
    const height = Math.max(0, Math.min(params.height, VB_SCREEN_HEIGHT - top));

    const out = new Uint8Array(width * height * 4);
    if (width === 0 || height === 0) {
      return out.buffer;
    }

    this.wasm.GetPixels(sim.pointer);
    const source = new Uint8Array(
      this.wasm.memory.buffer,
      this.wasm.GetExtPixels(sim.pointer),
      VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT * 4,
    );

    for (let row = 0; row < height; row++) {
      const from = ((top + row) * VB_SCREEN_WIDTH + left) * 4;
      out.set(source.subarray(from, from + width * 4), row * width * 4);
    }
    return out.buffer;
  }

  /**
   * Reduces the frame on show, blended as the picture is, to one value per eye and cell for the immersion halo:
   * brightness in legacy mode, an RGB888 color in VBC mode. Not the arithmetic mean: a VB frame is mostly black, so one
   * bright sprite would read as almost dark. Weighting each pixel by its light (sum of b² / sum of b) gives the
   * brightness of the light in the cell, as a real Ambilight measures it; VBC weights by the brightest RGB component. A
   * few samples per cell suffice, as a wide kernel smooths the result on the other side.
   */
  protected readBackdrop(params: Params<'readBackdrop'>): Result<'readBackdrop'> {
    const sim = this.requireSim(params.sim);
    sim.backdropReadAt = performance.now();
    const max = Worker.MAX_BACKDROP_CELLS;
    const columns = Math.max(1, Math.min(Math.floor(params.columns) || 1, max));
    const rows = Math.max(1, Math.min(Math.floor(params.rows) || 1, max));

    const cells = columns * rows;
    // the frame last shown, blended as the picture is, so what flickers to be seen half-bright does not flicker in the
    // halo; the framebuffer itself only before anything has been shown
    const shown = sim.frames?.blendedCurrent(sim.displayMode.frameBlending);
    const colorMode = shown?.colorMode ?? this.isVbcColorOutput(sim);
    // legacy: one RGBA quad per cell; VBC: two, the left eye's color then the right eye's
    const out = new Uint8Array(cells * (colorMode ? 8 : 4));
    let source = shown?.pixels;
    if (!source) {
      if (colorMode) {
        this.wasm.GetColorPixels!(sim.pointer);
      } else {
        this.wasm.GetPixels(sim.pointer);
      }
      source = this.shownPixels(sim, colorMode);
    }
    const rowStride = colorMode ? VBC_FRAME_WIDTH : VB_SCREEN_WIDTH;

    const leftSum = new Float64Array(cells);
    const leftLight = new Float64Array(cells);
    const rightSum = new Float64Array(cells);
    const rightLight = new Float64Array(cells);
    // VBC needs a light-weighted color rather than one brightness. Keeping black out of the denominator lets a small
    // lit sprite color its cell, matching the legacy b²/b reduction below
    const leftRgb = colorMode ? new Float64Array(cells * 3) : undefined;
    const rightRgb = colorMode ? new Float64Array(cells * 3) : undefined;
    // about four samples across a cell on each axis. Rounded rather than floored, so a cell a few pixels wide still
    // steps instead of reading every pixel
    const step = Math.max(1, Math.min(4, Math.round(
      Math.min(VB_SCREEN_WIDTH / columns, VB_SCREEN_HEIGHT / rows) / 4)));

    for (let y = 0; y < VB_SCREEN_HEIGHT; y += step) {
      const row = Math.min(rows - 1, Math.floor((y * rows) / VB_SCREEN_HEIGHT));
      for (let x = 0; x < VB_SCREEN_WIDTH; x += step) {
        const cell =
          row * columns + Math.min(columns - 1, Math.floor((x * columns) / VB_SCREEN_WIDTH));
        const at = (y * rowStride + x) * 4;
        if (colorMode) {
          const atRight = at + VB_SCREEN_WIDTH * 4;
          const lr = source[at];
          const lg = source[at + 1];
          const lb = source[at + 2];
          const rr = source[atRight];
          const rg = source[atRight + 1];
          const rb = source[atRight + 2];
          const lw = Math.max(lr, lg, lb);
          const rw = Math.max(rr, rg, rb);
          leftLight[cell] += lw;
          rightLight[cell] += rw;
          leftRgb![cell * 3] += lr * lw;
          leftRgb![cell * 3 + 1] += lg * lw;
          leftRgb![cell * 3 + 2] += lb * lw;
          rightRgb![cell * 3] += rr * rw;
          rightRgb![cell * 3 + 1] += rg * rw;
          rightRgb![cell * 3 + 2] += rb * rw;
        } else {
          const l = source[at];
          const r = source[at + 1];
          leftSum[cell] += l;
          leftLight[cell] += l * l;
          rightSum[cell] += r;
          rightLight[cell] += r * r;
        }
      }
    }

    for (let cell = 0; cell < cells; cell++) {
      if (colorMode) {
        const average = (rgb: Float64Array, weight: number, at: number) => {
          out[at] = weight === 0 ? 0 : Math.round(rgb[cell * 3] / weight);
          out[at + 1] = weight === 0 ? 0 : Math.round(rgb[cell * 3 + 1] / weight);
          out[at + 2] = weight === 0 ? 0 : Math.round(rgb[cell * 3 + 2] / weight);
          out[at + 3] = 0xff;
        };
        average(leftRgb!, leftLight[cell], cell * 8);
        average(rightRgb!, rightLight[cell], cell * 8 + 4);
      } else {
        out[cell * 4] = leftSum[cell] > 0 ? Math.round(leftLight[cell] / leftSum[cell]) : 0;
        out[cell * 4 + 1] = rightSum[cell] > 0 ? Math.round(rightLight[cell] / rightSum[cell]) : 0;
        out[cell * 4 + 3] = 0xff;
      }
    }
    return { pixels: out.buffer, colorMode };
  }

  // a complete packed frame for a screenshot rendered on the DOM thread
  protected readFrame(params: Params<'readFrame'>): Result<'readFrame'> {
    const sim = this.requireSim(params.sim);
    const colorMode = this.isVbcColorOutput(sim);
    if (colorMode) {
      this.wasm.GetColorPixels!(sim.pointer);
    } else {
      this.wasm.GetPixels(sim.pointer);
    }
    const source = this.shownPixels(sim, colorMode);
    const pixels = new Uint8Array(source.byteLength);
    pixels.set(source);
    return { pixels: pixels.buffer, colorMode, previous: sim.frames?.previous() ?? [] };
  }

  // show the current video state without advancing, the same recomposite a restored state gets (see presentRestored)
  protected refreshFrame(params: Params<'refreshFrame'>): void {
    this.presentRestored(this.requireSim(params.sim), 'replace');
  }

  // through the CPU's view of memory rather than the state struct, so mirroring, mapped registers and unmapped
  // holes behave as the running program sees them
  protected readMemory(params: Params<'readMemory'>): ArrayBuffer {
    const sim = this.requireSim(params.sim);
    if (params.length > Worker.MAX_MEMORY_WINDOW) {
      // refused rather than truncated: the caller would take a short buffer for corrupt memory
      throw new Error(
        `Memory read of ${params.length} bytes exceeds the ${Worker.MAX_MEMORY_WINDOW} byte limit.`,
      );
    }
    const length = Math.max(0, params.length);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] =
        this.wasm.vbRead(
          sim.pointer,
          (params.address + i) >>> 0,
          VbDataType.U8,
        ) & 0xff;
    }
    return out.buffer;
  }

  protected writeMemory(params: Params<'writeMemory'>): void {
    const sim = this.requireSim(params.sim);
    const data = new Uint8Array(params.data);
    for (let i = 0; i < data.length; i++) {
      this.wasm.vbWrite(
        sim.pointer,
        (params.address + i) >>> 0,
        VbDataType.U8,
        data[i],
      );
    }
  }

  /**
   * Hashes everything the emulated program can see: registers, then VRAM, WRAM and cartridge RAM. Explicitly not the
   * save state struct, whose absolute pointers and address-hashed cache differ between identically running instances
   * and would report false desyncs (measured in tests/determinism-probe.mjs). Read through the core's bus, so no
   * layout knowledge is needed. About fifty thousand reads, so a session does this every so often, not every frame.
   */
  protected stateDigest(
    params: Params<'stateDigest'>,
  ): { frame: number; digest: number } {
    return {
      frame: this.framesRun,
      digest: this.digestOf(this.requireSim(params.sim)),
    };
  }

  protected setDigestPeriod(params: Params<'setDigestPeriod'>): void {
    this.requireSim(params.sim);
    const frames = Math.max(0, Math.trunc(params.frames));
    if (frames === 0) {
      this.digestPeriods.delete(params.sim);
    } else {
      this.digestPeriods.set(params.sim, frames);
    }
  }

  protected linkJournal(params: Params<'linkJournal'>): LinkJournalEntry[] {
    this.requireSim(params.sim);
    return [...(this.linkJournals.get(params.sim)?.entries ?? [])];
  }

  protected journal(handle: SimHandle, entry: LinkJournalEntry): void {
    const journal = this.linkJournals.get(handle);
    if (journal && journal.entries.length < Worker.MAX_JOURNAL_ENTRIES) {
      journal.entries.push(entry);
    }
  }

  // FNV-1a over the whole save window, for a journal's reset line
  protected cartRamDigest(sim: SimState): number {
    if (sim.cartRam === 0 || sim.cartRamSize === 0) {
      return 0;
    }
    const words = new Uint32Array(this.wasm.memory.buffer, sim.cartRam, sim.cartRamSize >>> 2);
    let digest = 0x811c9dc5;
    for (let i = 0; i < words.length; i++) {
      digest = Math.imul(digest ^ words[i], 0x01000193) >>> 0;
    }
    return digest;
  }

  // take the digests that are due at the frame just finished
  protected reportDigests(): void {
    if (this.digestPeriods.size === 0) {
      return;
    }
    for (const [handle, period] of this.digestPeriods) {
      const sim = this.sims.get(handle);
      if (!sim) {
        this.digestPeriods.delete(handle);
        continue;
      }
      if (this.framesRun % period !== 0) {
        continue;
      }
      const digest = this.digestOf(sim);
      this.journal(handle, { frame: this.framesRun, kind: 'digest', digest });
      this.emit({
        event: 'digest',
        payload: { sim: handle, frame: this.framesRun, digest },
      });
    }
  }

  // see stateDigest in vb-protocol.ts for what is in it
  protected digestOf(sim: SimState): number {
    // FNV-1a over 32-bit words, not meant to hold against an adversary, just to notice two machines have parted
    let digest = 0x811c9dc5;
    const mix = (value: number): void => {
      digest = Math.imul(digest ^ (value >>> 0), 0x01000193) >>> 0;
    };

    mix(this.wasm.vbGetProgramCounter(sim.pointer));
    for (let i = 0; i < 32; i++) {
      mix(this.wasm.vbGetProgramRegister(sim.pointer, i));
    }
    for (const index of Worker.DIGEST_SYSTEM_REGISTERS) {
      mix(this.wasm.vbGetSystemRegister(sim.pointer, index));
    }

    // of the first VRAM half only the character slices: the four frame buffers around them depend on the stereo depth
    // each window has chosen, not on the game
    const characters: [number, number][] = [];
    for (let at = VB_VRAM_BASE; at < VB_VRAM_BASE + VB_VRAM_SIZE; at += 0x8000) {
      characters.push([at + 0x6000, 0x2000]);
    }
    const regions: [number, number][] = [
      ...characters,
      [VB_WRAM_BASE, VB_WRAM_SIZE],
      [VB_CART_RAM_BASE, sim.cartRamSize],
    ];
    for (const [base, length] of regions) {
      for (let at = 0; at < length; at += 4) {
        mix(this.wasm.vbRead(sim.pointer, base + at, VbDataType.S32));
      }
    }

    return digest;
  }

  protected readRegisters(
    params: Params<'readRegisters'>,
  ): Registers {
    const sim = this.requireSim(params.sim);
    const program: number[] = [];
    for (let i = 0; i < 32; i++) {
      program.push(this.wasm.vbGetProgramRegister(sim.pointer, i) >>> 0);
    }

    const system: Record<string, number> = {};
    for (const [name, index] of Object.entries(VbSystemRegister)) {
      if (typeof index === 'number') {
        system[name] = this.wasm.vbGetSystemRegister(sim.pointer, index) >>> 0;
      }
    }

    return {
      pc: this.wasm.vbGetProgramCounter(sim.pointer) >>> 0,
      program,
      system,
    };
  }

  // the core cannot trap a single address, so capturing means a callback on every CPU write; hence opt-in, on only
  // while something is listening
  protected setTerminalCapture(
    params: Params<'setTerminalCapture'>,
  ): void {
    const sim = this.requireSim(params.sim);
    if (params.enabled) {
      this.terminalBuffers.set(sim.pointer, []);
    } else {
      this.terminalBuffers.delete(sim.pointer);
    }
    this.updateWriteWatch(sim.pointer);
  }

  // same cost as terminal capture, on only while something listens, i.e. while a rumble pack is plugged in
  protected setLinkCapture(params: Params<'setLinkCapture'>): void {
    const sim = this.requireSim(params.sim);
    if (params.enabled) {
      this.linkBuffers.set(sim.pointer, []);
    } else {
      this.linkBuffers.delete(sim.pointer);
      this.linkTransmitBytes.delete(sim.pointer);
    }
    this.updateWriteWatch(sim.pointer);
  }

  // the address an ESSound cartridge listens on. Same cost and opt-in as above: on only while there is something to
  // play, which the DOM side decides by looking for the audio files beside the ROM
  protected setEsSoundCapture(params: Params<'setEsSoundCapture'>): void {
    const sim = this.requireSim(params.sim);
    if (params.enabled) {
      this.esSoundBuffers.set(sim.pointer, []);
    } else {
      this.esSoundBuffers.delete(sim.pointer);
    this.gamePakInterrupts.delete(sim.pointer);
    }
    this.updateWriteWatch(sim.pointer);
  }

  // the core's memory as bytes, remade only when the core has grown it
  protected bytes(): Uint8Array {
    if (this.memoryBytes === undefined || this.memoryBytes.buffer !== this.wasm.memory.buffer) {
      this.memoryBytes = new Uint8Array(this.wasm.memory.buffer);
    }
    return this.memoryBytes;
  }

  // the only capture that turns on both watches, as a save is written and then read back
  protected setSramCapture(params: Params<'setSramCapture'>): void {
    const sim = this.requireSim(params.sim);
    if (params.writes || params.reads) {
      this.sramDirections.set(sim.pointer, { writes: params.writes, reads: params.reads });
      if (!this.sramBuffers.has(sim.pointer)) {
        this.sramBuffers.set(sim.pointer, []);
      }
    } else {
      this.sramDirections.delete(sim.pointer);
      this.sramBuffers.delete(sim.pointer);
    }
    this.updateWriteWatch(sim.pointer);
    this.updateReadWatch(sim.pointer);
  }

  // the memory the core keeps pixel origins in, and the simulation it keeps them for; one at a time, as the core
  // does. See setPixelOrigins in vb-protocol.ts
  protected origins?: {
    pointer: number;
    sim: number;
    taken?: Uint32Array; // what drew the picture last taken, as runs; see captureShownOrigins
    // what drew the picture last shown. Not always the last taken: the drive loop takes a picture at every frame break
    // but shows one only when the audio is where it should be, e.g. the last before a pause is never shown
    shown?: Uint32Array;
    streaming: boolean; // whether pixelOrigins goes out with every picture
  };
  protected originRuns?: Uint32Array; // room to encode runs in, which in the worst case is three words a pixel

  protected setPixelOrigins(params: Params<'setPixelOrigins'>): void {
    const sim = this.requireSim(params.sim);
    const wasm = this.wasm;
    if (!wasm.vbSetPixelOrigins || !wasm.vbSizeOfPixelOrigins) {
      return;
    }
    if (!params.enabled) {
      if (this.origins?.sim === sim.pointer) {
        this.stopPixelOrigins();
      }
      return;
    }
    if (this.origins?.sim === sim.pointer) {
      return;
    }
    const size = wasm.vbSizeOfPixelOrigins();
    const pointer = this.origins?.pointer || wasm.Realloc(0, size);
    if (pointer === 0) {
      throw new Error('The emulator core ran out of memory.');
    }
    // another machine's, or nothing: either way none of it is about this one
    new Uint8Array(wasm.memory.buffer, pointer, size).fill(0);
    wasm.vbSetPixelOrigins(sim.pointer, pointer);
    this.origins = { pointer, sim: sim.pointer, streaming: false };
  }

  protected streamPixelOrigins(params: Params<'streamPixelOrigins'>): void {
    const sim = this.requireSim(params.sim);
    if (this.origins?.sim === sim.pointer) {
      this.origins.streaming = params.enabled;
    }
  }

  // take what drew the picture at the moment it is taken (GetPixels at a frame break). Read any later, the display
  // may have moved on and the markings would be a frame ahead
  protected captureShownOrigins(pointer: number): void {
    const origins = this.origins;
    if (origins?.sim !== pointer || !this.wasm.vbGetDisplayedBuffer) {
      return;
    }
    origins.taken = this.encodeOrigins(this.wasm.vbGetDisplayedBuffer(pointer) & 1);
  }

  // the picture just taken is being shown, so is what drew it, to whoever is streaming it
  protected showOrigins(pointer: number): void {
    const origins = this.origins;
    if (origins?.sim !== pointer || !origins.taken || origins.taken === origins.shown) {
      return;
    }
    origins.shown = origins.taken;
    if (origins.streaming) {
      this.sendShownOrigins();
    }
  }

  protected sendShownOrigins(): void {
    const origins = this.origins;
    if (!origins?.shown) {
      return;
    }
    const runs = origins.shown.slice().buffer;
    this.emit({ event: 'pixelOrigins', payload: { sim: origins.sim, runs } }, [runs]);
  }

  // one frame buffer's origins as runs, both eyes, row by row; see decodeOriginRuns
  protected encodeOrigins(buffer: number): Uint32Array {
    const pixels = VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT;
    const runs = this.originRuns ??= new Uint32Array(pixels * 2 * 3);
    let length = 0;
    let count = 0;
    let lastWhat = 0;
    let lastWhere = 0;
    for (let eye = 0; eye < 2; eye++) {
      // after the two eyes' shadow images, by frame buffer and then eye, column-major as the VIP draws
      const from = new Uint32Array(this.wasm.memory.buffer,
        this.origins!.pointer + (2 + buffer * 2 + eye) * pixels * 8, pixels * 2);
      for (let y = 0; y < VB_SCREEN_HEIGHT; y++) {
        for (let x = 0; x < VB_SCREEN_WIDTH; x++) {
          const at = (x * VB_SCREEN_HEIGHT + y) * 2;
          const what = from[at];
          const where = from[at + 1];
          if (count > 0 && what === lastWhat && where === lastWhere) {
            count++;
            continue;
          }
          if (count > 0) {
            runs[length++] = count;
            runs[length++] = lastWhat;
            runs[length++] = lastWhere;
          }
          count = 1;
          lastWhat = what;
          lastWhere = where;
        }
      }
    }
    runs[length++] = count;
    runs[length++] = lastWhat;
    runs[length++] = lastWhere;
    return runs.slice(0, length);
  }

  protected stopPixelOrigins(): void {
    if (!this.origins) {
      return;
    }
    this.wasm.vbSetPixelOrigins?.(this.origins.sim, 0);
    this.wasm.Realloc(this.origins.pointer, 0);
    this.origins = undefined;
  }

  // forget the origins of a machine whose state was just replaced: they describe pictures it no longer has, and a
  // state does not carry them
  protected clearPixelOrigins(pointer: number): void {
    if (this.origins?.sim === pointer) {
      new Uint8Array(this.wasm.memory.buffer, this.origins.pointer, this.wasm.vbSizeOfPixelOrigins!()).fill(0);
      this.origins.taken = this.origins.shown = Uint32Array.of(VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT * 2, 0, 0);
      if (this.origins.streaming) {
        this.sendShownOrigins();
      }
    }
  }

  protected readPixelOrigins(params: Params<'readPixelOrigins'>): ArrayBuffer {
    const sim = this.requireSim(params.sim);
    const origins = this.origins;
    if (origins?.sim !== sim.pointer || !this.wasm.vbGetDisplayedBuffer) {
      return new ArrayBuffer(0);
    }
    // before any picture has been taken since they were switched on, the buffer on show now is the best there is
    return (origins.shown ?? origins.taken ?? this.encodeOrigins(this.wasm.vbGetDisplayedBuffer(sim.pointer) & 1)).slice().buffer;
  }

  // rides on the same write watching as the captures, and is just as opt-in
  protected setPointerWatch(params: Params<'setPointerWatch'>): void {
    const sim = this.requireSim(params.sim);
    const address = params.address >>> 0;
    if (address !== 0) {
      this.pointerWatches.set(sim.pointer, address);
      this.pointerWrites.set(sim.pointer, []);
    } else {
      this.pointerWatches.delete(sim.pointer);
      this.pointerWrites.delete(sim.pointer);
    }
    this.updateWriteWatch(sim.pointer);
  }

  // no write watching needed: nothing is observed, the writes are simply made again after each frame
  protected setCheats(params: Params<'setCheats'>): void {
    const sim = this.requireSim(params.sim);
    this.syncRomCheats(sim, params.codes);
    if (params.codes.length > 0) {
      this.cheats.set(sim.pointer, params.codes);
    } else {
      this.cheats.delete(sim.pointer);
    }
  }

  // keeps the original of every ROM byte the new codes write and puts back those no code writes any more
  protected syncRomCheats(sim: SimState, codes: readonly VbCheatWrite[]): void {
    let originals = this.romCheatOriginals.get(sim.pointer);
    if (sim.cartRom === 0 || sim.cartRomSize === 0) {
      return;
    }
    const rom = this.u8(sim.cartRom, sim.cartRomSize);
    const mask = sim.cartRomSize - 1;
    const wanted = new Set<number>();
    for (const code of codes) {
      for (let byte = 0; byte < code.bytes; byte++) {
        const address = (code.address + byte) >>> 0;
        if (((address >>> 24) & 0x07) === 0x07) {
          wanted.add(address & mask);
        }
      }
    }
    if (originals) {
      for (const [offset, value] of originals) {
        if (!wanted.has(offset)) {
          rom[offset] = value;
          originals.delete(offset);
        }
      }
    }
    for (const offset of wanted) {
      if (!originals?.has(offset)) {
        originals ??= new Map();
        originals.set(offset, rom[offset]);
      }
    }
    if (originals?.size) {
      this.romCheatOriginals.set(sim.pointer, originals);
    } else {
      this.romCheatOriginals.delete(sim.pointer);
    }
  }

  // a byte at a time, little-endian like the CPU, as writeMemory does. vbWrite handles mirroring and read-only
  // regions, so a code pointed somewhere unwritable is simply ignored
  protected applyCheats(simPointer: number): void {
    const codes = this.cheats.get(simPointer);
    if (!codes) {
      return;
    }
    for (const code of codes) {
      for (let byte = 0; byte < code.bytes; byte++) {
        this.wasm.vbWrite(
          simPointer,
          (code.address + byte) >>> 0,
          VbDataType.U8,
          (code.value >>> (byte * 8)) & 0xff,
        );
      }
    }
  }

  // the VSU from the core's own decoded copy, plus how loud its last frame of sound was. Why it is not read from
  // the VSU's address range: vb-vsu-layout.ts
  protected readVsu(params: Params<'readVsu'>): VsuReading {
    const sim = this.requireSim(params.sim);
    const layout = this.requireVsuLayout();
    const map = composeVsuMap(this.wasm, layout, sim.pointer, this.vsuMutes.get(sim.pointer));

    // the machine's last buffer of sound is still in it, so the meter costs one pass on the polls that ask. A machine
    // that is not running reads as silent
    let peakLeft = 0;
    let peakRight = 0;
    if (this.emulating) {
      const samples = this.f32(sim.samples, VB_SAMPLES_PER_BUFFER * 2);
      for (let i = 0; i < samples.length; i += 2) {
        peakLeft = Math.max(peakLeft, Math.abs(samples[i]));
        peakRight = Math.max(peakRight, Math.abs(samples[i + 1]));
      }
    }
    return { map: map.buffer, peakLeft, peakRight };
  }

  // calibrating costs a throwaway simulation and a moment of running it, so it happens on demand, not at startup. A
  // failure is remembered, so a panel polling ten times a second does not recalibrate each time
  protected requireVsuLayout(): VsuLayout {
    if (this.vsuLayout === undefined) {
      try {
        this.vsuLayout = calibrateVsuLayout(this.wasm);
      } catch (error) {
        this.vsuLayout = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (this.vsuLayout instanceof Error) {
      throw this.vsuLayout;
    }
    return this.vsuLayout;
  }

  // see setVsuMutes in the protocol for why this is the mixer's business and not a write to the VSU. The state is
  // dropped when nothing is muted, keeping the drive loop's check to a map lookup
  protected setVsuMutes(params: Params<'setVsuMutes'>): void {
    const sim = this.requireSim(params.sim);
    const channels = params.channels & ((1 << VB_VSU_CHANNELS) - 1);
    const state = this.vsuMutes.get(sim.pointer);
    if (channels === 0 && state === undefined) {
      return;
    }
    // calibrated here as well, so a core whose VSU cannot be found says so instead of silently not muting
    const layout = this.requireVsuLayout();
    const held = state ?? createVsuMuteState();
    // what has just been let out of the mix gets its level back; nothing else will put it back
    restoreVsuMutes(this.wasm, layout, sim.pointer, held, held.channels & ~channels);
    held.channels = channels;
    if (channels === 0) {
      this.vsuMutes.delete(sim.pointer);
      this.updateWriteWatch(sim.pointer);
      return;
    }
    this.vsuMutes.set(sim.pointer, held);
    // at once rather than at the next frame break: the channel's current level was written before this was asked for,
    // so no write watch will carry it past
    applyVsuMutes(this.wasm, layout, sim.pointer, held);
    this.updateWriteWatch(sim.pointer);
  }

  // re-apply one simulation's mutes at a frame break
  protected applyVsuMutes(simPointer: number): void {
    const muted = this.vsuMutes.get(simPointer);
    if (muted && this.vsuLayout !== undefined && !(this.vsuLayout instanceof Error)) {
      applyVsuMutes(this.wasm, this.vsuLayout, simPointer, muted);
    }
  }

  // every RetroAchievements entry point flushes afterwards rather than waiting for the drive loop: login and loading
  // happen before the machine runs (start() calls raLoadGame before the first run())

  protected async raLoginPassword(
    params: Params<'raLoginPassword'>,
  ): Promise<Result<'raLoginPassword'>> {
    try {
      return await this.ra.loginPassword(params.username, params.password);
    } finally {
      this.flushRetroAchievements();
    }
  }

  protected async raLoginToken(
    params: Params<'raLoginToken'>,
  ): Promise<Result<'raLoginToken'>> {
    try {
      return await this.ra.loginToken(params.username, params.token);
    } finally {
      this.flushRetroAchievements();
    }
  }

  protected raLogout(): void {
    this.ra.logout();
    this.flushRetroAchievements();
  }

  // rebinding moves the engine rather than adding to it: RetroAchievements tracks one machine at a time here
  protected async raLoadGame(params: Params<'raLoadGame'>): Promise<void> {
    const sim = this.requireSim(params.sim);
    this.raSimPointer = sim.pointer;
    this.ra.attach(this.wasm, sim.pointer);
    try {
      await this.ra.loadGame(params.hash);
    } finally {
      this.flushRetroAchievements();
    }
  }

  protected raUnloadGame(): void {
    this.ra.unloadGame();
    this.flushRetroAchievements();
  }

  protected raProvideResponse(params: Params<'raProvideResponse'>): void {
    this.ra.provideResponse(params.requestId, params.status, params.body);
    this.flushRetroAchievements();
  }

  protected raReset(): void {
    this.ra.reset();
    this.flushRetroAchievements();
  }

  protected raSetHardcore(params: Params<'raSetHardcore'>): void {
    this.ra.setHardcore(params.enabled);
    this.flushRetroAchievements();
  }

  protected async raFetchLeaderboardEntries(
    params: Params<'raFetchLeaderboardEntries'>,
  ): Promise<Result<'raFetchLeaderboardEntries'>> {
    try {
      return await this.ra.fetchLeaderboardEntries(
        params.leaderboardId, params.firstEntry, params.count, params.aroundUser);
    } finally {
      // the server calls this needs answering travel in the same flush
      this.flushRetroAchievements();
    }
  }

  protected flushRetroAchievements(): void {
    const events = this.ra.takeEvents();
    if (events.length === 0) {
      return;
    }
    this.emit({ event: 'retroAchievements', payload: { events } });
  }

  // install the shared write callback on first use, and point a simulation's single callback slot at it while any
  // capture still wants its writes. Returns 0 so the write still happens
  protected updateWriteWatch(simPointer: number): void {
    const active =
      this.terminalBuffers.has(simPointer) ||
      this.linkBuffers.has(simPointer) ||
      this.esSoundBuffers.has(simPointer) ||
      this.sramDirections.get(simPointer)?.writes === true ||
      this.pointerWatches.has(simPointer) ||
      this.vsuMutes.has(simPointer) ||
      this.writeStops.has(simPointer);
    if (!active) {
      this.wasm.vbSetWriteCallback(simPointer, 0);
      this.wasm.vbSetOption(simPointer, VbOption.WRITE_RANGES, VB_WRITE_RANGES_ALL);
      return;
    }
    // the VSU, link port, terminal and ESSound captures only need the VSU, the hardware registers and the expansion
    // range, so in play (the Rumble Pack decoder is always listening) the core neither calls this for every WRAM and
    // VRAM store nor gives up its CPU batches. A pointer watch, cart RAM writes and write stops can be anywhere
    const ports =
      !this.pointerWatches.has(simPointer) &&
      this.sramDirections.get(simPointer)?.writes !== true &&
      !this.writeStops.has(simPointer);
    this.wasm.vbSetOption(
      simPointer, VbOption.WRITE_RANGES, ports ? 1 << 1 | 1 << 2 | 1 << 4 : VB_WRITE_RANGES_ALL);

    if (this.writeWatchCallbackSlot === 0) {
      this.writeWatchCallbackSlot = installVbCallback(
        this.wasm,
        (watchedSimPointer, address, type, valuePointer) => {
          const at = address >>> 0;
          if (this.writeStops.size > 0) {
            this.checkWriteStop(watchedSimPointer, at, type, valuePointer);
          }
          // every write the captures below care about is byte-wide on real hardware, so only the low byte is meaningful
          // whatever the store's width. The pointer watch is the exception and reads all four
          const byte = this.bytes()[valuePointer];

          if (at === this.pointerWatches.get(watchedSimPointer)) {
            // narrower stores are not pointer assignments, and reading four bytes would report whatever sits beside them
            if (type === VbDataType.S32) {
              const values = this.pointerWrites.get(watchedSimPointer);
              if (values && values.length < Worker.MAX_POINTER_WRITES) {
                values.push(
                  new DataView(this.wasm.memory.buffer).getUint32(valuePointer, true),
                );
              }
            }
          } else if (vsuLevelWriteChannel(at) >= 0) {
            // a muted channel's stereo level, on its way to the VSU. The write is let through with its level
            // taken out, not cancelled, as its bus time and the rest of a wider store are the machine's business.
            // See takeVsuLevelWrite, which also keeps what the game asked for
            const muted = this.vsuMutes.get(watchedSimPointer);
            if (muted && takeVsuLevelWrite(muted, vsuLevelWriteChannel(at), byte)) {
              // the low byte is the register; a wider store's other bytes land on padding between VSU registers
              this.bytes()[valuePointer] = 0;
            }
          } else if (at === VB_TERMINAL_PORT) {
            const bytes = this.terminalBuffers.get(watchedSimPointer);
            if (bytes && bytes.length < Worker.MAX_TERMINAL_BYTES) {
              bytes.push(byte);
            }
          } else if (at === VB_LINK_TRANSMIT_PORT) {
            // stored, not sent: this only says what the next transfer will carry. Tracked unconditionally, so
            // the byte is known by the time a start arrives
            this.linkTransmitBytes.set(watchedSimPointer, byte);
          } else if (
            at === VB_LINK_CONTROL_PORT &&
            (byte & VB_LINK_START) !== 0
          ) {
            const bytes = this.linkBuffers.get(watchedSimPointer);
            if (bytes && bytes.length < Worker.MAX_LINK_BYTES) {
              bytes.push(this.linkTransmitBytes.get(watchedSimPointer) ?? 0);
            }
          } else if (at === VB_ES_SOUND_PORT) {
            // the whole halfword is the command, so this reads the value itself. A narrower store is not an
            // ESSound command
            const commands = this.esSoundBuffers.get(watchedSimPointer);
            if (
              commands &&
              commands.length < Worker.MAX_ES_SOUND_COMMANDS &&
              (type === VbDataType.S16 || type === VbDataType.U16)
            ) {
              const command = new DataView(this.wasm.memory.buffer).getUint16(valuePointer, true);
              commands.push(command);
              if (command === ES_SOUND_INIT) {
                // the cartridge's answer to init. Not raised here: this is the middle of a store, and interrupts
                // are only taken between instructions
                this.gamePakInterrupts.add(watchedSimPointer);
              }
            }
          } else if (
            isCartRam(at) &&
            this.sramDirections.get(watchedSimPointer)?.writes === true
          ) {
            this.recordSramAccess(watchedSimPointer, at, byte, true, type);
          }
          return 0;
        },
        VB_WRITE_CALLBACK_ARITY,
      );
    }
    this.wasm.vbSetWriteCallback(simPointer, this.writeWatchCallbackSlot);
  }

  // separate from the write watch as the core keeps them apart, and only the save capture wants reads. Five
  // arguments where the write callback takes six; the shape is not checked and a wrong one traps on the first call
  // (see tests/read-callback-probe.mjs). Returns 0 so the read still happens
  protected updateReadWatch(simPointer: number): void {
    if (this.sramDirections.get(simPointer)?.reads !== true) {
      this.wasm.vbSetReadCallback(simPointer, 0);
      return;
    }

    if (this.readWatchCallbackSlot === 0) {
      this.readWatchCallbackSlot = installVbCallback(
        this.wasm,
        (watchedSimPointer, address, type, valuePointer) => {
          const at = address >>> 0;
          if (isCartRam(at)) {
            this.recordSramAccess(
              watchedSimPointer, at, this.bytes()[valuePointer], false, type);
          }
          return 0;
        },
        VB_READ_CALLBACK_ARITY,
      );
    }
    this.wasm.vbSetReadCallback(simPointer, this.readWatchCallbackSlot);
  }

  // the program counter is read here, as only here is it still the instruction that did it. Affordable, as save
  // accesses are rare compared to everything else the CPU does
  protected recordSramAccess(
    simPointer: number,
    address: number,
    value: number,
    write: boolean,
    type: number,
  ): void {
    const runs = this.sramBuffers.get(simPointer);
    if (!runs) {
      return;
    }

    // only the newest run is extended: two instructions interleaving over the save are two things happening.
    // Everything decidable without the program counter is decided first, as reading it is a call into the core on
    // every watched access. The second touch sets the stride and later ones must keep it, so a loop stays one run
    const run = runs[runs.length - 1];
    const step = run === undefined ? 0 : address - run.at;
    const fits =
      run !== undefined &&
      run.write === write &&
      run.type === type &&
      run.values.length < MAX_SRAM_RUN_BYTES &&
      (run.values.length === 1
        ? step >= -MAX_SRAM_STRIDE && step <= MAX_SRAM_STRIDE
        : step === run.stride);

    // nothing to carry on and nowhere to start: this access is dropped, so its program counter is not worth asking for
    if (!fits && runs.length >= MAX_SRAM_RUNS) {
      return;
    }

    const pc = this.wasm.vbGetProgramCounter(simPointer) >>> 0;
    if (fits && run !== undefined && run.pc === pc) {
      if (run.values.length === 1) {
        run.stride = step;
      }
      run.values.push(value);
      run.at = address;
      return;
    }

    if (runs.length >= MAX_SRAM_RUNS) {
      return;
    }
    runs.push({ address, at: address, stride: 0, values: [value], write, type, pc });
  }

  protected flushTerminals(): void {
    for (const [handle, bytes] of this.terminalBuffers) {
      if (bytes.length === 0) {
        continue;
      }
      // chunked so a long burst cannot overflow the argument list
      let text = '';
      for (let at = 0; at < bytes.length; at += 4096) {
        text += String.fromCharCode(...bytes.slice(at, at + 4096));
      }
      bytes.length = 0;
      this.emit({ event: 'terminal', payload: { sim: handle, text } });
    }
  }

  protected flushPointerWrites(): void {
    for (const [handle, values] of this.pointerWrites) {
      if (values.length === 0) {
        continue;
      }
      const address = this.pointerWatches.get(handle) ?? 0;
      this.emit({ event: 'pointerWrite', payload: { sim: handle, address, values: [...values] } });
      values.length = 0;
    }
  }

  /**
   * The core cannot raise an expansion-port interrupt, so this is the V810's own interrupt entry done by hand between
   * instructions: save the return state, write the exception code, mask the level and below, jump to the vector.
   * Accepted only as the hardware would (no exception or NMI pending, interrupts enabled, level not masked);
   * otherwise it stays pending, as a ROM often sends ESSound's init before it enables interrupts.
   */
  protected serviceGamePakInterrupts(): void {
    for (const simPointer of this.gamePakInterrupts) {
      const level = VbInterrupt.CRO;
      const psw = this.wasm.vbGetSystemRegister(simPointer, VbSystemRegister.PSW) >>> 0;
      const blocked = (psw & (VbPsw.NP | VbPsw.EP | VbPsw.ID)) !== 0;
      const masked = level < ((psw & VB_PSW_INTERRUPT_LEVEL_MASK) >>> VB_PSW_INTERRUPT_LEVEL_SHIFT);
      if (blocked || masked) {
        continue;
      }

      const ecr = this.wasm.vbGetSystemRegister(simPointer, VbSystemRegister.ECR) >>> 0;
      this.wasm.vbSetSystemRegister(
        simPointer, VbSystemRegister.EIPC, this.wasm.vbGetProgramCounter(simPointer) >>> 0,
      );
      this.wasm.vbSetSystemRegister(simPointer, VbSystemRegister.EIPSW, psw);
      this.wasm.vbSetSystemRegister(
        simPointer, VbSystemRegister.ECR, (ecr & 0xffff0000) | vbInterruptExceptionCode(level),
      );
      // entry raises the mask to one above this level, which the engine's own handler reads back to find its vector
      const entered = ((psw & ~(VbPsw.AE | VB_PSW_INTERRUPT_LEVEL_MASK))
        | VbPsw.EP | VbPsw.ID | ((level + 1) << VB_PSW_INTERRUPT_LEVEL_SHIFT)) >>> 0;
      this.wasm.vbSetSystemRegister(simPointer, VbSystemRegister.PSW, entered);
      this.wasm.vbSetProgramCounter(simPointer, (VB_INTERRUPT_VECTOR_BASE + (level << 4)) >>> 0);
      this.gamePakInterrupts.delete(simPointer);
    }
  }

  protected flushEsSound(): void {
    for (const [handle, commands] of this.esSoundBuffers) {
      if (commands.length === 0) {
        continue;
      }
      this.emit({ event: 'esSound', payload: { sim: handle, commands: [...commands] } });
      commands.length = 0;
    }
  }

  protected flushSram(): void {
    for (const [handle, runs] of this.sramBuffers) {
      if (runs.length === 0) {
        continue;
      }
      // the bytes become a byte array only here: while growing the run is pushed to, on the wire it is copied
      this.emit({
        event: 'sram',
        payload: {
          sim: handle,
          runs: runs.map(run => ({
            address: run.address,
            stride: run.stride,
            values: Uint8Array.from(run.values),
            write: run.write,
            type: run.type,
            pc: run.pc,
          })),
        },
      });
      runs.length = 0;
    }
  }

  protected flushLinks(): void {
    for (const [handle, bytes] of this.linkBuffers) {
      if (bytes.length === 0) {
        continue;
      }
      this.emit({ event: 'link', payload: { sim: handle, bytes: [...bytes] } });
      bytes.length = 0;
    }
  }

  /**
   * Three things the exports do not tell: vbuDisassemble decodes but writes no text, only Disassemble with its sixteen
   * options does. The string words in the table are offsets to pointers, not to text (upstream calls that indirect).
   * Both allocations are ours to free. Older cores' vbuCodeSize sized a conditional branch at four bytes instead of
   * two, losing the next instruction; the panel still checks for such builds, see annotateDisassembly.
   */
  protected disassemble(
    params: Params<'disassemble'>,
  ): DisassemblyLine[] {
    const sim = this.requireSim(params.sim);
    const count = Math.max(
      0,
      Math.min(params.count, Worker.MAX_DISASSEMBLY_LINES),
    );

    return disassemble(
      this.wasm, sim.pointer, params.address >>> 0, count,
      Math.max(0, Math.floor(params.before ?? 0)));
  }

  protected onAudioBuffersReturned(buffers: ArrayBuffer[]): void {
    const started = performance.now();
    // the queue running dry means we could not keep up, so whatever frame is staged is the freshest one we have
    if (this.emulating && this.audioQueue.length === 0) {
      this.presentAll();
    }

    for (const buffer of buffers) {
      this.audioQueue.push(new Float32Array(buffer));
    }

    this.drive();
    this.busySinceReport += performance.now() - started;
  }

  protected drive(): void {
    if (!this.emulating || this.sims.size === 0) {
      return;
    }

    try {
      while (this.audioQueue.length !== 0) {
        this.emulateOneBuffer();
        if (this.settleStop()) {
          break;
        }
      }
    } catch (error) {
      this.emulating = false;
      this.emit({
        event: 'error',
        payload: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      // also on the error path, as what a program printed on its way into trouble is usually the interesting part
      this.flushTerminals();
      // before the link bytes on purpose: Rumble::startEffect stores its spec before broadcasting anything, so this order
      // lets the DOM side attribute a burst to its spec
      this.flushPointerWrites();
      // a pack left buzzing by a crashed program would keep buzzing, so what was already sent goes out on that path too
      this.flushLinks();
      // likewise a track a crashed program asked for: the stop it never sent is the one command worth not losing
      this.flushEsSound();
      // and what a crashed program did with its save, often the whole question when it crashed on the way out of one
      this.flushSram();
      // unlocks earned on the way into trouble are as real as any other
      this.flushRetroAchievements();
    }
  }

  /**
   * The speed actually attempted: the one asked for until the machine cannot sustain it. The worklet consumes buffers
   * at exactly VB_FRAME_RATE whatever the speed, so at speed N a buffer's fixed wall-time slice must fit N chunks.
   * Asking for more does not go faster but slows each buffer, costing frame rate and underrunning audio: at a measured
   * ceiling of 3x, asking for 32x still ran at 3x with the picture down from 50 fps to under 5. Only fast forward is
   * clamped.
   */
  protected affordableSpeed(): number {
    if (this.speed <= 1 || this.chunkCostMs <= 0) {
      return this.speed;
    }
    const budget = Worker.BUFFER_WALL_MS * Worker.EMULATION_BUDGET;
    // not rounded down to whole chunks: pendingClocks carries the remainder, so a machine good for 2.4 chunks a buffer
    // runs at 2.4x, not 2x
    const affordable = Math.max(1, budget / this.chunkCostMs);
    return Math.min(this.speed, affordable);
  }

  // counted rather than calculated: a chunk is one frame of emulated time, so chunks over wall seconds is the
  // achieved rate, including a clamped fast forward or a throttled tab
  protected reportSpeed(now: number): void {
    if (this.lastSpeedReport === 0) {
      this.lastSpeedReport = now;
      this.chunksSinceReport = 0;
      return;
    }
    const elapsed = now - this.lastSpeedReport;
    if (elapsed < Worker.SPEED_REPORT_MS) {
      return;
    }
    const framesPerSecond = (this.chunksSinceReport * 1000) / elapsed;
    const load = this.busySinceReport / elapsed;
    this.lastSpeedReport = now;
    this.chunksSinceReport = 0;
    this.busySinceReport = 0;
    this.emit({
      event: 'speed',
      payload: {
        framesPerSecond,
        ratio: framesPerSecond / VB_FRAME_RATE,
        requested: this.affordableSpeed(),
        load,
      },
    });
  }

  // time is only ever emulated in whole chunks, so the core always fills a complete sample buffer. Fast forward runs
  // several chunks and keeps the last one's audio; slow motion falls short of a chunk on some buffers and outputs
  // silence for those
  protected emulateOneBuffer(): void {
    const sims = this.orderedSims();
    this.pendingClocks += VB_CLOCKS_PER_BUFFER * this.affordableSpeed();
    this.skipping = this.pendingClocks >= VB_CLOCKS_PER_BUFFER * 2;

    let emulated = false;
    let chunks = 0;
    let stalled = false;
    let waiting: SimHandle[] = [];
    const started = performance.now();
    while (this.pendingClocks >= VB_CLOCKS_PER_BUFFER) {
      waiting = this.simsMissingInput();
      if (waiting.length > 0) {
        // report from a standstill too, and unconditionally: a session that has fallen behind needs the frame number most
        // now, and the spacing rule would swallow it
        this.lastProgressReport = this.framesRun;
        this.emit({ event: 'progress', payload: { frame: this.framesRun } });
        // the frame is owed, not skipped, so the clock is left unspent, but only one frame's worth: a peer away for
        // seconds would otherwise get a burst of fast forward on its way back
        this.pendingClocks = Math.min(this.pendingClocks, VB_CLOCKS_PER_BUFFER);
        break;
      }
      this.pendingClocks -= VB_CLOCKS_PER_BUFFER;
      this.applyScheduledKeys();
      this.applyTurbo();
      this.applyScheduledEdits();
      if (!this.emulateChunk(sims)) {
        stalled = true;
        break;
      }
      this.framesRun++;
      // on the frame boundary, so two machines asked for the same period take theirs at exactly the same point
      this.reportDigests();
      chunks++;
      emulated = true;
    }
    this.reportAwaitingInput(waiting.length > 0, waiting);
    this.reportProgress();
    const finished = performance.now();
    if (chunks > 0) {
      const cost = (finished - started) / chunks;
      this.chunkCostMs = this.chunkCostMs === 0
        ? cost
        : this.chunkCostMs * (1 - Worker.CHUNK_COST_WEIGHT)
        + cost * Worker.CHUNK_COST_WEIGHT;
    }
    this.chunksSinceReport += chunks;
    this.reportSpeed(finished);

    const buffer = this.audioQueue.shift()!;
    if (emulated) {
      this.wasm.Mix(this.mixPointer, this.simsPointer, sims.length);
      buffer.set(this.f32(this.mixPointer, MIX_BUFFER_LENGTH));
    } else {
      buffer.fill(0);
    }
    this.audioPort.postMessage(buffer.buffer, [buffer.buffer]);

    // present once the backlog is down to a single buffer, where the staged frame lines up with what is about to be heard
    if (this.audioQueue.length === 1) {
      this.presentAll();
    }

    // last, so the buffer above still goes back to the worklet: the audio queue drives this loop, and a swallowed
    // buffer would stop it like the hang this prevents
    if (stalled) {
      this.stall();
    }
  }

  /**
   * Emulate returns whenever it has something to report, so draining a budget means calling it until nothing is left.
   * The core can get stuck returning with nothing spent, forever (a program run off into memory it cannot execute,
   * reproducible with a linked pair, see tests/determinism-probe.mjs), which would spin the worker silently; this
   * returns false then, leaving the rest unspent. `between` runs after every call and collects breaks. The budget is
   * re-read from core memory each time, as a held view goes stale when the heap grows.
   */
  protected drainClocks(
    simsPointer: number,
    count: number,
    clocksPointer: number,
    clocks: number,
    between: () => void,
  ): boolean {
    this.u32(clocksPointer)[0] = clocks;
    if (this.live) {
      // a budget the live profiler has not seen would make the slice's first instruction look like it cost the
      // whole last one
      this.live.left = clocks;
      this.live.clocks = this.u32(clocksPointer);
    }
    let idle = 0;
    let before = clocks;
    while (this.u32(clocksPointer)[0] !== 0) {
      this.wasm.Emulate(simsPointer, count, clocksPointer);
      const left = this.u32(clocksPointer)[0];
      idle = left === before ? idle + 1 : 0;
      before = left;
      if (idle > VB_MAX_IDLE_EMULATE_CALLS) {
        return false;
      }
      if (this.stopped !== undefined) {
        // the callback refused an instruction, so the leftover clocks are not a failure to advance. Another Emulate call
        // would step straight back into the same refusal
        return true;
      }
      between();
      if (this.live) {
        // between applies cheats and stages frames, and anything allocating in core memory can move the heap out
        // from under a view. Once per Emulate call, not per instruction
        this.live.clocks = this.u32(clocksPointer);
      }
    }
    return true;
  }

  // suspends rather than carrying on, as every further chunk would cost the same fruitless calls. The event lets the
  // chrome offer a reset instead of a picture that never changes again
  protected stall(): void {
    for (const handle of this.linkJournals.keys()) {
      const sim = this.sims.get(handle);
      if (sim) {
        this.journal(handle, {
          frame: this.framesRun, kind: 'stalled',
          pc: this.wasm.vbGetProgramCounter(sim.pointer) >>> 0,
        });
      }
    }
    this.pendingClocks = 0;
    this.suspend();
    this.emit({ event: 'stalled', payload: { frames: this.framesRun } });
  }

  // one chunk is VB_CLOCKS_PER_BUFFER clocks, one full sample buffer. False when the core stopped advancing
  protected emulateChunk(sims: SimState[]): boolean {
    this.recordChunk(sims);
    if (this.live) {
      this.live.framed = false;
      // once a picture, before it: what the counters moved by is the picture that just ran
      this.sampleMachine(this.live.pointer, this.live.machine, false);
    }
    for (const sim of sims) {
      this.wasm.vbSetSamples(
        sim.pointer,
        sim.samples,
        VbDataType.F32,
        VB_SAMPLES_PER_BUFFER,
      );
    }

    const drained = this.drainClocks(
      this.simsPointer, sims.length, this.clocksPointer, VB_CLOCKS_PER_BUFFER, () => {
        if (this.gamePakInterrupts.size > 0) {
          this.serviceGamePakInterrupts();
        }

        let framed = false;
        for (const sim of sims) {
          if (this.wasm.GetBreaks(sim.pointer) & VbBreak.FRAME) {
            framed = true;
            // on the machine's own frame boundary, not the chunk's: same length, different moment, and a profile
            // describes the work between two pictures
            if (this.live?.pointer === sim.pointer) {
              this.endLiveFrame();
            }
            this.applyCheats(sim.pointer);
            this.applyVsuMutes(sim.pointer);
            // only the simulation RetroAchievements is tracking, never a linked peer (the profile replay's scratch
            // simulation never reaches this loop)
            if (sim.pointer === this.raSimPointer) {
              this.ra.doFrame();
            }
            // with a healthy backlog there is no point staging a frame we would overwrite before it is shown
            if (this.audioQueue.length <= 2) {
              // the mono picture is shown from here; a VBC one is taken at present (and by whoever else wants
              // either), so in colour mode this would be work for nobody
              if (!this.isVbcColorOutput(sim)) {
                this.wasm.GetPixels(sim.pointer);
              }
              this.captureShownOrigins(sim.pointer);
              this.holdSkippedFrame(sim);
            } else {
              sim.skipped?.clear();
            }
          }
        }

        if (framed && this.rewind.enabled) {
          if (this.rewind.frames % this.rewind.granularity === 0) {
            this.captureRewindEntry(sims);
          }
          this.rewind.frames++;
        }
      });

    // a machine whose display is off (boot, crash) reports no frame break, so a chunk stands in for one and the profile
    // still moves. Not while a frame is half gathered: a game drawing every second picture has chunks with no picture
    // by rights, and closing one there would cut its frame in half
    if (this.live && !this.live.framed && this.live.pictures === 0) {
      this.endLiveFrame(true);
    }
    return drained;
  }

  // keep the staged frame if fast forward is about to skip it but blending will want it: one of the last four of a
  // buffer that runs more than one. The last is shown, the three before go ahead of it, see present
  protected holdSkippedFrame(sim: SimState): void {
    const wanted = this.skipping
      && this.pendingClocks < VB_CLOCKS_PER_BUFFER * 4
      && sim.displayMode.frameBlending !== FrameBlending.OFF
      && (sim.renderer !== undefined || sim.mainThread !== undefined)
      && !sim.pageHeld;
    if (!wanted) {
      sim.skipped?.clear();
      return;
    }
    const colorMode = this.isVbcColorOutput(sim);
    if (colorMode) {
      this.wasm.GetColorPixels!(sim.pointer);
    }
    (sim.skipped ??= new SkippedFrames()).hold(
      this.shownPixels(sim, colorMode),
      colorMode,
    );
  }

  protected presentAll(): void {
    for (const sim of this.sims.values()) {
      this.present(sim);
    }
  }

  // the frame the core composited last, as the display unit showed it: shaped by the column table where that is on
  // and the table is not Nintendo's. A view of core memory or a copy valid until the next call; keepers copy it
  protected shownPixels(sim: SimState, colorMode: boolean): Uint8Array {
    // counted from the cartridge going in or a reset, which is when a real one would be switched on
    const spinUp = this.mirrorSpinUp ? mirrorSpinUp(this.framesRun, this.mirrorSpinUpFullDelay) : undefined;
    let lengths: Uint8Array | undefined;
    if ((this.columnGeometry || spinUp) && this.wasm.vbGetColumnLengths) {
      this.columnLengths ||= this.wasm.Realloc(0, 192);
      this.wasm.vbGetColumnLengths(sim.pointer, this.columnLengths, this.columnLengths + 96);
      lengths = new Uint8Array(this.wasm.memory.buffer, this.columnLengths, 192);
    }
    const pixels = new Uint8Array(
      this.wasm.memory.buffer,
      colorMode
        ? this.wasm.GetExtColorPixels!(sim.pointer)
        : this.wasm.GetExtPixels(sim.pointer),
      vbFrameBytes(colorMode),
    );
    return lengths ? this.columnFrames.shape(pixels, colorMode, lengths, spinUp) : pixels;
  }

  // true only when both the VBC core and its RGB transport exports are active
  protected isVbcColorOutput(sim: SimState): boolean {
    return this.wasm.GetVideoFormat?.(sim.pointer) === 1
      && this.wasm.GetColorPixels !== undefined
      && this.wasm.GetExtColorPixels !== undefined;
  }

  // present() shows whatever the core composited last, refreshed at every frame break. A restored state has never
  // been through one, so without this the screen keeps the frame from before the restore until emulation resumes
  protected presentRestored(sim: SimState, kind: FrameKind = 'next'): void {
    this.wasm.GetPixels(sim.pointer);
    this.present(sim, kind);
  }

  protected present(sim: SimState, kind: FrameKind = 'next'): void {
    if (!sim.renderer && !sim.mainThread && !sim.videoTap) {
      return;
    }
    this.showOrigins(sim.pointer);
    // fast forward's skipped frames first, so the picture blends with the frames right before it. Not to a recording,
    // which wants the frames shown, and not to the DOM thread unless the shown one is still sure of a buffer after them
    const skipped = sim.skipped?.take() ?? [];
    const history = this.wantsHistory(sim);
    if (!history) {
      sim.frames = undefined;
    }
    if (kind === 'next' && skipped.length > 0 && !sim.pageHeld
      && (!sim.mainThread || sim.mainThread.buffers.length > skipped.length)) {
      for (const frame of skipped) {
        if (history) {
          (sim.frames ??= new FrameHistory()).record(frame.pixels, frame.colorMode, 'next');
        }
        if (sim.renderer) {
          sim.renderer.present(frame.pixels, frame.colorMode, 'next');
        } else if (sim.mainThread) {
          this.sendFrame(sim, sim.mainThread, frame.pixels, frame.colorMode, 'next');
        }
      }
    }
    const colorMode = this.isVbcColorOutput(sim);
    if (colorMode) {
      // the legacy eye-packed buffer remains available to debugger/halo APIs; VBC presentation uses its own
      // double-width RGB888 transport buffer
      this.wasm.GetColorPixels!(sim.pointer);
    }
    const pixels = this.shownPixels(sim, colorMode);
    if (history) {
      (sim.frames ??= new FrameHistory()).record(pixels, colorMode, kind);
    }
    if (sim.pageHeld) {
      // nobody sees the page; holdPage shows it the current frame when it is let go
    } else if (sim.renderer) {
      sim.renderer.present(pixels, colorMode, kind);
    } else if (sim.mainThread) {
      this.sendFrame(sim, sim.mainThread, pixels, colorMode, kind);
    }
    if (sim.videoTap) {
      this.sendFrame(sim, sim.videoTap, pixels, colorMode, kind);
    }
  }

  // the frames shown are kept only for those who read them: a screenshot that blends (blending on) and the immersion
  // halo (read within HISTORY_HALO_MS), both only with a page attached. Each costs a copy of the frame per present
  protected wantsHistory(sim: SimState): boolean {
    if (!sim.renderer && !sim.mainThread) {
      return false;
    }
    return sim.displayMode.frameBlending !== FrameBlending.OFF
      || (sim.backdropReadAt !== undefined && performance.now() - sim.backdropReadAt < Worker.HISTORY_HALO_MS);
  }

  // an empty pool means the DOM thread is still busy with every buffer. Dropping the obsolete frame keeps emulation
  // and audio moving; the next present uses whichever buffer comes back first
  protected sendFrame(
    sim: SimState,
    pool: { presentation: number; buffers: ArrayBuffer[] },
    pixels: Uint8Array,
    colorMode: boolean,
    kind: FrameKind,
  ): void {
    const buffer = pool.buffers.shift();
    if (!buffer) {
      return;
    }
    new Uint8Array(buffer).set(pixels);
    this.emit({
      event: 'frame',
      payload: {
        sim: sim.pointer,
        presentation: pool.presentation,
        pixels: buffer,
        colorMode,
        kind,
      },
    }, [buffer]);
  }

  // views are made on demand rather than cached, as the core grows its memory and a growth detaches every view
  protected u8(pointer: number, length: number): Uint8Array {
    return new Uint8Array(this.wasm.memory.buffer, pointer, length);
  }

  protected u32(pointer: number, length = 1): Uint32Array {
    return new Uint32Array(this.wasm.memory.buffer, pointer, length);
  }

  protected f32(pointer: number, length: number): Float32Array {
    return new Float32Array(this.wasm.memory.buffer, pointer, length);
  }

  protected allocateScratch(): void {
    this.clocksPointer = this.wasm.Realloc(0, Uint32Array.BYTES_PER_ELEMENT);
    this.mixPointer = this.wasm.Realloc(
      0,
      MIX_BUFFER_LENGTH * Float32Array.BYTES_PER_ELEMENT,
    );
  }

  protected copyIntoCore(data: ArrayBuffer): number {
    const pointer = this.wasm.Realloc(0, data.byteLength);
    if (pointer === 0 && data.byteLength !== 0) {
      throw new Error('Emulator core ran out of memory.');
    }
    new Uint8Array(this.wasm.memory.buffer, pointer, data.byteLength).set(
      new Uint8Array(data),
    );
    return pointer;
  }

  // keep the core-side pointer array that Emulate() walks in sync
  protected refreshSimPointers(): void {
    if (this.sims.size > this.simsCapacity) {
      this.simsPointer = this.wasm.Realloc(
        this.simsPointer,
        this.sims.size * Uint32Array.BYTES_PER_ELEMENT,
      );
      this.simsCapacity = this.sims.size;
    }
    if (this.simsCapacity === 0) {
      return;
    }
    const pointers = this.u32(this.simsPointer, this.simsCapacity);
    let index = 0;
    for (const sim of this.orderedSims()) {
      pointers[index++] = sim.pointer;
    }
  }

  protected requireSim(handle: SimHandle): SimState {
    const sim = this.sims.get(handle);
    if (!sim) {
      throw new Error(`No such simulation: ${handle}`);
    }
    return sim;
  }

  protected emit(event: VbEvent, transfer: Transferable[] = []): void {
    this.workerScope.postMessage(event, transfer);
  }
}

const scope = globalThis as unknown as WorkerScope;
const worker = new Worker(scope);

scope.onmessage = async event => {
  // the very first message carries the port to the audio worklet
  if ('audioPort' in event.data) {
    await worker.bootstrap(event.data as Bootstrap);
    scope.postMessage({ id: 0 } as Response);
    return;
  }

  if ('videoFrame' in event.data) {
    worker.returnVideoFrame(event.data as VideoFrameReturn);
    return;
  }

  const request = event.data as Request;
  try {
    const result = await worker.handle(request.command, request.params);
    const response: Response = { id: request.id, result };
    // large raw buffers move rather than copy. Backdrops and complete frames wrap theirs with a format flag, so include
    // that nested buffer as well
    const transfer = result instanceof ArrayBuffer
      ? [result]
      : (request.command === 'readBackdrop' || request.command === 'readFrame'
        || request.command === 'readRewindThumbnail') && result
        ? [(result as Result<'readBackdrop' | 'readFrame' | 'readRewindThumbnail'> & object).pixels]
        : [];
    scope.postMessage(response, transfer);
  } catch (error) {
    scope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } as Response);
  }
};
