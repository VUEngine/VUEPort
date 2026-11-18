// Shrooms-VB core constants, mirroring the vendored core's Constants.js, which is the authority. A TypeScript
// module so the worker, the audio worklet and the frontend can share them without the vendored shim

export const VB_CLOCK_RATE = 20000000; // VB master clock, in Hz

export const VB_SAMPLE_RATE = 41700; // sample rate the core produces audio at, in Hz

export const VB_FRAME_RATE = 50; // display frame rate in Hz; one audio buffer covers one frame

// 400000 clocks is 0.02 seconds at 20 MHz, exactly VB_SAMPLES_PER_BUFFER samples
export const VB_CLOCKS_PER_BUFFER = VB_CLOCK_RATE / VB_FRAME_RATE;

export const VB_SAMPLES_PER_BUFFER = VB_SAMPLE_RATE / VB_FRAME_RATE; // stereo frames per audio buffer

// audio buffers cycled between the core worker and the audio worklet; three is ~60ms of latency, like the
// vendored shim
export const VB_AUDIO_BUFFER_COUNT = 3;

// `Emulate` calls in a row that may spend none of the clock budget before the core counts as stuck (e.g. a
// program that ran off into non-executable memory); otherwise the draining loops spin forever. A healthy chunk
// drains in one call across every ROM in `tests/stall-guard-probe.mjs`, so this is three orders of headroom
export const VB_MAX_IDLE_EMULATE_CALLS = 1000;

// display dimensions, per eye
export const VB_SCREEN_WIDTH = 384;
export const VB_SCREEN_HEIGHT = 224;

export const VB_AUDIO_PROCESSOR = 'ves-vb-audio';

export enum VbKey {
    PWR = 0x0001,
    SGN = 0x0002,
    A = 0x0004,
    B = 0x0008,
    RT = 0x0010,
    LT = 0x0020,
    RU = 0x0040,
    RR = 0x0080,
    LR = 0x0100,
    LL = 0x0200,
    LD = 0x0400,
    LU = 0x0800,
    STA = 0x1000,
    SEL = 0x2000,
    RL = 0x4000,
    RD = 0x8000,
}

// data types for vbRead/vbWrite and vbSetSamples
export enum VbDataType {
    S8 = 0,
    U8 = 1,
    S16 = 2,
    U16 = 3,
    S32 = 4,
    F32 = 5,
}

export enum VbSystemRegister {
    EIPC = 0,
    EIPSW = 1,
    FEPC = 2,
    FEPSW = 3,
    ECR = 4,
    PSW = 5,
    PIR = 6,
    TKCW = 7,
    CHCW = 24,
    ADTRE = 25,
}

// Game Pak RAM, where a cartridge keeps its save data. The core drops every access to it until a simulation
// is given cartridge RAM with setCartRam
export const VB_CART_RAM_BASE = 0x06000000;

// by region rather than range: the VB decodes memory on three bits, so the save is the whole of region 6 with
// the cartridge RAM mirrored across it, and some games reach their save through a mirror
export function isCartRam(address: number): boolean {
    return ((address >>> 24) & 7) === 6;
}

// WRAM, the VB's 64 KB of work memory, mirrored across all of region 5 like the save region. Also the Memory
// panel's default base
export const VB_WRAM_BASE = 0x05000000;

export const VB_VRAM_BASE = 0x00000000; // video RAM, region 0, of which the VB has 128 KB
export const VB_VRAM_SIZE = 0x20000;

export const VB_WRAM_SIZE = 0x10000;

// the VB decodes addresses on three bits: eight regions of 16 MB, and above `0x08000000` the whole map again.
// What a region answers with is usually smaller and repeats across it (see isCartRam)
export const VB_REGION_BYTES = 0x1000000;

/**
 * The most bytes one `readMemory` may ask for. Reads go through vbRead a byte at a time, and unbounded requests could
 * stall the worker. The ceiling is a whole bank of WRAM, as the graphics inspectors (a character segment, a BGMap, all
 * of OAM, a 0x6000 byte frame buffer) and the Memory Pools panel (VUEngine's pool struct, most of WRAM) need
 * structures whole; a partial read would look like corrupt data. Shared because callers reading in windows (the
 * Memory panel's search) must know the width; the worker still refuses anything over it.
 */
export const VB_MAX_MEMORY_READ = 0x10000;

// by region rather than by range, like isCartRam
export function isWram(address: number): boolean {
    return ((address >>> 24) & 7) === 5;
}

// RetroAchievements allowlists integrations by this string server-side and refuses unknown ones with
// `unsupported_client`, softcore included; registering it turns the integration on without code changes.
// Shared so the worker, the desktop shell's HTTP command and logs quote the same one
export const RETROACHIEVEMENTS_CLIENT = 'VUEPort/1.0.0';

// RetroAchievements' console identifier for the VB (`RC_CONSOLE_VIRTUAL_BOY`)
export const RETROACHIEVEMENTS_CONSOLE_ID = 28;

// `Terminal::print` stores a string here a byte at a time, followed by a newline (a byte-wide port, see
// `vuengine/core/source/Debugging/Terminal/Terminal.c`). Compiled out of shipping builds
export const VB_TERMINAL_PORT = 0x02000030;

// link port control register, CCR. A byte is sent by storing it to VB_LINK_TRANSMIT_PORT, then writing this
// with VB_LINK_START set; the payload register alone would report unsent bytes (`Communications::reset` clears it)
export const VB_LINK_CONTROL_PORT = 0x02000000;

export const VB_LINK_TRANSMIT_PORT = 0x02000008; // the link port's transmit data register, CDTR

// ESSound is an expansion playing MP3 and WAV files from the cartridge folder, driven by halfword writes. It
// selects on `/ES`, so the whole `0x04......` range reaches it. See `vueport-essound.ts` for the protocol
export const VB_ES_SOUND_PORT = 0x04000000;

// the CCR bit that starts a transfer, `__COM_START`; see `Communications::startTransmissions` in the engine's
// platforms/VirtualBoy/source/Hardware/Communications.c and `libgccvb/source/hw.h` for the register map
export const VB_LINK_START = 0x04;

/**
 * The VSU's waveform tables, MODDATA and the six channel register blocks
 * (`applications/electron/vb/libgccvb/source/audio.h`), up to but not including SSTOP. Write-only on real hardware and
 * in this core: vbRead always returns 0 here, after CPU stores and debug vbWrite alike (see `tests/vsu-state-probe.mjs`).
 * So the VSU panel reads the core's decoded copy from the simulation struct instead, see `worker/vb-vsu-layout.ts`.
 */
export const VB_VSU_BASE = 0x01000000;
// the map the worker reports runs up to and including SSTOP, a write-only switch, as the range is quoted that
// way everywhere else
export const VB_VSU_MAP_BYTES = 0x584;

// register block geometry; the panel decodes the blocks (`panels/emulator-vsu-memory.ts`), but the worker
// composes the map, and that file is browser-side
export const VB_VSU_REGISTERS = 0x01000400;
export const VB_VSU_CHANNEL_STRIDE = 0x40;
export const VB_VSU_CHANNELS = 6;
export const VB_VSU_CHANNEL_ENABLE = 0x80; // `SxINT` bit 7: the channel is switched on
// write-only, one word past the last channel: any write with bit 0 set silences them all
export const VB_VSU_SSTOP = 0x01000580;

// cartridge ROM as the CPU sees it, region 7, mirrored; only readable to the game, but the core's debug write
// reaches it too
export const VB_ROM_BASE = 0x07000000;

// VB Color Color RAM: 256 palettes of four RGB888 colors (32-bit entries), shared by cells and OBJs
export const VBC_CRAM_BASE = 0x03079000;
export const VBC_VCU_APERTURE_BYTES = 0x100000; // the VCU decodes 1 MiB of region 3 and mirrors it across the rest
export const VBC_CRAM_PALETTES = 256;
// one Color RAM palette: four entries of `xxxxxxxx BBBBBBBB GGGGGGGG RRRRRRRR`
export const VBC_CRAM_PALETTE_BYTES = 16;
// VBC frames are one RGBA8 image twice the screen width (left eye left, right eye right, each pixel R, G, B,
// 0xFF); legacy frames stay eye-packed at the screen's width
export const VBC_FRAME_WIDTH = VB_SCREEN_WIDTH * 2;
export const VBC_FRAME_BYTES = VBC_FRAME_WIDTH * VB_SCREEN_HEIGHT * 4;
export const VB_FRAME_BYTES = VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT * 4;
export function vbFrameBytes(colorMode: boolean): number {
    return colorMode ? VBC_FRAME_BYTES : VB_FRAME_BYTES;
}

// VB Color framebuffer: four pages of 384x256 at one byte per pixel, a palette id rather than a color (the VCU
// shows `CRAM[byte * 4 + legacy shade]`, so a colorization can tint a game without re-rendering it). The only
// place a palette id survives in memory
export const VBC_COLOR_FRAMEBUFFER_BASE = 0x03000000;
export const VBC_COLOR_FRAMEBUFFER_PAGE_BYTES = 384 * 256;
export const VBC_COLOR_FRAMEBUFFER_PAGES = 4;
export const VBC_COLOR_FRAMEBUFFER_BYTES =
    VBC_COLOR_FRAMEBUFFER_PAGE_BYTES * VBC_COLOR_FRAMEBUFFER_PAGES;

// by region and offset, like isCartRam: the VCU is the whole of region 3 with its aperture mirrored. Only the
// first `VBC_COLOR_FRAMEBUFFER_BYTES`; attribute RAMs, Color RAM and registers above it are excluded
export function isVbcColorFramebuffer(address: number): boolean {
    return ((address >>> 24) & 7) === 3
        && (address & (VBC_VCU_APERTURE_BYTES - 1)) < VBC_COLOR_FRAMEBUFFER_BYTES;
}

// interrupt levels in hardware vector order, as labelled KEY, TIM, CRO, COM and VPU at sixteen-byte intervals in
// the engine's `vuengine/core/source/Runtime/crt0.s` (`.vbvectors`). CRO is the expansion port's, which an
// ESSound cartridge pulses to say it is there
export enum VbInterrupt {
    KEY = 0,
    TIM = 1,
    CRO = 2,
    COM = 3,
    VPU = 4,
}

// the CPU jumps to this plus `n * 0x10` for level n; the ROM's table at `0x07FFFE00` is the same memory
// through the cartridge mirror
export const VB_INTERRUPT_VECTOR_BASE = 0xfffffe00;

// the exception code an interrupt of level n writes to ECR's low halfword
export function vbInterruptExceptionCode(level: VbInterrupt): number {
    return 0xfe00 | (level << 4);
}

// PSW bits; the interrupt level mask is bits 16 to 19, as the engine's `set_intlevel` in
// `libgccvb/source/asm.c` uses it
export enum VbPsw {
    ID = 0x1000, // interrupts disabled
    AE = 0x2000, // address trap enable
    EP = 0x4000, // an exception is being handled
    NP = 0x8000, // a non-maskable interrupt is being handled
}
export const VB_PSW_INTERRUPT_LEVEL_SHIFT = 16;
export const VB_PSW_INTERRUPT_LEVEL_MASK = 0x000f0000;

export enum VbOption {
    PSEUDO_HALT = 0,
    VBC_HARDWARE = 1,
    // percent of the stereo parallax the VIP draws with, 0–200 (100 real console, 0 flat). A display preference,
    // see `setStereoDepth`
    STEREO_DEPTH = 2,
    // the address ranges the write callback is called for, bit n for n << 24 (0 VIP, 1 VSU, 2 hardware registers,
    // 3 VCU, 4 expansion, 5 WRAM, 6 cart RAM, 7 ROM). Leaving out WRAM, cart RAM and ROM also lets the core run the
    // CPU ahead in batches. See updateWriteWatch
    WRITE_RANGES = 3,
}

export const VB_WRITE_RANGES_ALL = 0xff; // every range, the core's default

export enum VbBreak {
    FRAME = 1,
    POINT = 2,
}

// packs the left eye's brightness into red and the right eye's into green, unscaled, so one RGBA framebuffer
// carries both eyes at full 8-bit precision and every display mode is a shader on one texture. The core is
// always configured this way; color is applied by the renderer
export const VB_EYE_PACKED_LEFT = 0xff0000;
export const VB_EYE_PACKED_RIGHT = 0x00ff00;

// tints for the built-in anaglyph pairs. Green and magenta are the core's own constants (Constants.js), the
// rest full-saturation equivalents, which filters pass best
export const VB_COLORS = {
    RED: 0xff0000,
    BLUE: 0x0000ff,
    CYAN: 0x00ffff,
    GREEN: 0x00b400,
    MAGENTA: 0xc800ff,
    AMBER: 0xffff00,
};

/**
 * Where the four brightness levels land in the framebuffer's 0..1 range with VUEngine's default brightness registers
 * (BRTA 32, BRTB 64, BRTC 32, see __BRIGHTNESS_DARK/MEDIUM/BRIGHT_RED). The core resolves brightness on a gamma-like
 * curve: `tests/brightness-probe.mjs` measures levels 1-3 at 105, 162 and 250 out of 255. The renderer interpolates
 * the palette between these stops, so standard brightness shows the palette exactly and a fade slides through it
 * without banding.
 */
export const VB_LEVEL_STOPS = [0, 105 / 255, 162 / 255, 250 / 255];
export const VB_LEVELS = 4;

export type VbDuboisProfile = 'red-cyan' | 'green-magenta' | 'amber-blue';
export type VbDuboisProfileSelection = 'none' | VbDuboisProfile | 'custom';

// two 3x3 color transforms, column-major for WebGL
export interface VbAnaglyphMatrices {
    left: number[];
    right: number[];
}

export interface VbAnaglyphPalette {
    left: number;
    right: number;
    // explicit built-in calibration; absent for RGB channel filters and custom matrices
    duboisProfile?: VbDuboisProfile;
    duboisMatrices?: VbAnaglyphMatrices; // explicit user calibration, takes precedence over a built-in profile
}

export type VbPalette = [number, number, number, number];
export const VB_PALETTE_GROUPS: Record<string, VbPalette>[] = [
    {
        'default': [0x000000, 0x78010d, 0xa80016, 0xff0024],
        'authentic': [0x000000, 0x4C010c, 0x710214, 0xbb001f],
        'red': [0x000000, 0x550000, 0xAA0000, 0xFF0000],
        'white': [0x000000, 0x555555, 0xaaaaaa, 0xffffff],
        'gray': [0x1A1A1A, 0x5C5C5C, 0x9E9E9E, 0xE0E0E0],
        'green': [0x0E1F0F, 0x3E5F40, 0x6EA071, 0x9EE0A2],
        'cyan': [0x0E1D1E, 0x3B5D5F, 0x699DA0, 0x96DDE1],
        'blue': [0x141A2D, 0x3E4A6E, 0x6979AF, 0x93A9F0],
        'magenta': [0x2B1427, 0x6A4363, 0xA8739F, 0xE7A2DB],
        'coral': [0x2B1613, 0x6E423D, 0xB26E66, 0xF59A90],
        'yellow': [0x1D1A0D, 0x615A38, 0xA59964, 0xE9D98F],
    },
    {
        'gb': [0x0F380F, 0x306230, 0x9BBC0F, 0x8BAC0F],
        'gbp': [0x1F211A, 0x4C533C, 0x8B966C, 0xC4CFA1],
        'gbl': [0x005038, 0x00694A, 0x009A73, 0x00b284],
    },
    {
        'sgb-1a': [0x301850, 0xA82820, 0xD89048, 0xF8E8C8],
        'sgb-1b': [0x000000, 0xAD5111, 0xC8B06F, 0xD7D9BF],
        'sgb-1c': [0x383998, 0x973761, 0xE8984F, 0xF7C0FA],
        'sgb-1d': [0x501900, 0xFA0000, 0xC27F48, 0xF8F8A6],
        'sgb-1e': [0x5A3721, 0x69873F, 0x78BF77, 0xF8D8B3],
        'sgb-1f': [0x003E10, 0xA80000, 0xE1884F, 0xD9E8F8],
        'sgb-1g': [0xF7F858, 0x787700, 0x00A0E7, 0x000050],
        'sgb-1h': [0x2F1800, 0x7F4100, 0xF9B887, 0xF9E8E0],
        'sgb-2a': [0x00000E, 0x2B7303, 0xC58652, 0xE6C899],
        'sgb-2b': [0x450363, 0xF63000, 0xE6EB33, 0xFAFAEC],
        'sgb-2c': [0x282897, 0x7831E8, 0xE88989, 0xF7C0FA],
        'sgb-2d': [0x0A0046, 0xEF3200, 0x04F820, 0xF4FFB0],
        'sgb-2e': [0x0C0414, 0x221251, 0x90AAD6, 0xE5BE7D],
        'sgb-2f': [0x180000, 0xA00300, 0xF09660, 0xD2EEDD],
        'sgb-2g': [0x031900, 0xE6B38A, 0xDC5145, 0x5DBE39],
        'sgb-2h': [0x000000, 0x6E6E6E, 0xB7B7B7, 0xFCFCFC],
        'sgb-3a': [0x3D3871, 0xF55B28, 0x53C2C7, 0xFFCBA3],
        'sgb-3b': [0x02120E, 0x094C00, 0xD78942, 0xF0DBBE],
        'sgb-3c': [0x1B235F, 0x02B3FF, 0xF7FF85, 0xDCA7CE],
        'sgb-3d': [0x000308, 0x00CF00, 0xDBA970, 0xDEF9B0],
        'sgb-3e': [0x56437F, 0xA67D20, 0xD6AB65, 0xF0FAC5],
        'sgb-3f': [0x3F4139, 0xF2D20D, 0xF46DF0, 0x8275C4],
        'sgb-3g': [0x2E0600, 0xC62B2C, 0xF0F0EE, 0x61D352],
        'sgb-3h': [0x021900, 0x46892B, 0x7FCA3E, 0xE5FBB3],
        'sgb-4a': [0x00087D, 0xD101C9, 0x7BA9FA, 0xE7B366],
        'sgb-4b': [0x160A07, 0x377F33, 0xEAA665, 0xE9DBD4],
        'sgb-4c': [0x0B0007, 0x9BA2D7, 0xD1A1D0, 0xF0DCD2],
        'sgb-4d': [0x072250, 0x456874, 0x7CCDC8, 0xF4F1B2],
        'sgb-4e': [0x002334, 0x7F5694, 0xDBA971, 0xEED5A4],
        'sgb-4f': [0x430000, 0x7605AB, 0xCF7ED5, 0xBFC6C9],
        'sgb-4g': [0x048166, 0x241402, 0xA72548, 0xB8D90A],
        'sgb-4h': [0x3F5023, 0x808447, 0xBECA5F, 0xEBECBF],
    },
];

export const VB_PALETTES: Record<string, VbPalette> = Object.assign({}, ...VB_PALETTE_GROUPS);

export const VB_DEFAULT_PALETTE_ID = Object.keys(VB_PALETTES)[0];

export const VB_DEFAULT_PALETTE = VB_PALETTES[VB_DEFAULT_PALETTE_ID];

/**
 * Published Dubois least-squares calibrations on linear RGB, column-major for WebGL. In common code so a custom
 * calibration can start as a copy of a preset.
 *
 * Method and calibration limitations: https://www.site.uottawa.ca/~edubois/anaglyph/
 * Red/cyan coefficients: https://github.com/mrdoob/three.js/blob/dev/examples/jsm/effects/AnaglyphEffect.js
 * Green/magenta LCD profile: https://www.flickr.com/photos/e_dubois/5132528166/
 * Amber/blue LCD / ColorCode profile: https://www.flickr.com/photos/e_dubois/5230654930/
 */
export const VB_DUBOIS_MATRICES: Record<VbDuboisProfile, VbAnaglyphMatrices> = {
    'red-cyan': {
        left: [
            0.456100, -0.0400822, -0.0152161,
            0.500484, -0.0378246, -0.0205971,
            0.176381, -0.0157589, -0.00546856,
        ],
        right: [
            -0.0434706, 0.378476, -0.0721527,
            -0.0879388, 0.733640, -0.112961,
            -0.00155529, -0.0184503, 1.226400,
        ],
    },
    'green-magenta': {
        left: [
            -0.062, 0.284, -0.015,
            -0.158, 0.668, -0.027,
            -0.039, 0.143, 0.021,
        ],
        right: [
            0.529, -0.016, 0.009,
            0.705, -0.015, 0.075,
            0.024, -0.065, 0.937,
        ],
    },
    'amber-blue': {
        left: [
            1.062, -0.026, -0.038,
            -0.205, 0.908, -0.173,
            0.299, 0.068, 0.022,
        ],
        right: [
            -0.016, 0.006, 0.094,
            -0.123, 0.062, 0.185,
            -0.017, -0.017, 0.911,
        ],
    },
};

export const VB_ANAGLYPH_PALETTES: Record<string, VbAnaglyphPalette> = {
    'red-cyan': { left: VB_COLORS.RED, right: VB_COLORS.CYAN, duboisProfile: 'red-cyan' },
    'red-blue': { left: VB_COLORS.RED, right: VB_COLORS.BLUE },
    'red-green': { left: VB_COLORS.RED, right: VB_COLORS.GREEN },
    'green-magenta': { left: VB_COLORS.GREEN, right: VB_COLORS.MAGENTA, duboisProfile: 'green-magenta' },
    // the published profile is calibrated for amber/blue (ColorCode) glasses
    'amber-blue': { left: VB_COLORS.AMBER, right: VB_COLORS.BLUE, duboisProfile: 'amber-blue' },
};

export const VB_DEFAULT_ANAGLYPH_PALETTE_ID = 'red-cyan';

export enum VbStereoLayout {
    OVERLAY,
    SIDE_BY_SIDE,
    CYBERSCOPE,
    HLI,
    VLI,
}

export enum VbEyes {
    LEFT = 0,
    RIGHT = 1,
    BOTH = 2,
}

export enum VbRenderingMode {
    LEFT = 'left',
    RIGHT = 'right',
    ANAGLYPH = 'anaglyph',
    SIDE_BY_SIDE = 'side-by-side',
    CYBERSCOPE = 'cyberscope',
    HLI = 'hli',
    VLI = 'vli',
}

interface VbRenderingGeometry {
    layout: VbStereoLayout;
    eyes: VbEyes;
    width: number;
    height: number;
}

const VB_RENDERING_GEOMETRIES: Record<VbRenderingMode, VbRenderingGeometry> = {
    [VbRenderingMode.LEFT]: {
        layout: VbStereoLayout.OVERLAY,
        eyes: VbEyes.LEFT,
        width: VB_SCREEN_WIDTH,
        height: VB_SCREEN_HEIGHT,
    },
    [VbRenderingMode.RIGHT]: {
        layout: VbStereoLayout.OVERLAY,
        eyes: VbEyes.RIGHT,
        width: VB_SCREEN_WIDTH,
        height: VB_SCREEN_HEIGHT,
    },
    [VbRenderingMode.ANAGLYPH]: {
        layout: VbStereoLayout.OVERLAY,
        eyes: VbEyes.BOTH,
        width: VB_SCREEN_WIDTH,
        height: VB_SCREEN_HEIGHT,
    },
    [VbRenderingMode.SIDE_BY_SIDE]: {
        layout: VbStereoLayout.SIDE_BY_SIDE,
        eyes: VbEyes.BOTH,
        width: VB_SCREEN_WIDTH * 2,
        height: VB_SCREEN_HEIGHT,
    },
    [VbRenderingMode.CYBERSCOPE]: {
        layout: VbStereoLayout.CYBERSCOPE,
        eyes: VbEyes.BOTH,
        width: 512, // each eye is squeezed to 256 columns, which the accessory's prisms expand
        height: VB_SCREEN_HEIGHT,
    },
    // twice the screen in both directions: an interleaving display gives each eye every other line and the eye
    // takes those as the whole height, so at 768x448 each eye has one row (or column) per screen line. This is
    // the screenshot and recording size; on screen it is drawn at the shown size, see `DisplayOutput`
    [VbRenderingMode.HLI]: {
        layout: VbStereoLayout.HLI,
        eyes: VbEyes.BOTH,
        width: VB_SCREEN_WIDTH * 2,
        height: VB_SCREEN_HEIGHT * 2,
    },
    [VbRenderingMode.VLI]: {
        layout: VbStereoLayout.VLI,
        eyes: VbEyes.BOTH,
        width: VB_SCREEN_WIDTH * 2,
        height: VB_SCREEN_HEIGHT * 2,
    },
};

export function isInterleavedLayout(layout: VbStereoLayout): boolean {
    return layout === VbStereoLayout.HLI || layout === VbStereoLayout.VLI;
}

// the real on-screen size of an interleaved picture, in device pixels, and which eye its first line falls to.
// It is drawn at this size, as CSS scaling would draw a line twice and show both eyes both pictures
export interface DisplayOutput {
    width: number; // device pixels, not CSS pixels
    height: number;
    // 0 when the first line (HLI) or column (VLI) is an even one of the display's, 1 when odd; the display decides
    // which eye sees the even ones
    parity: number;
}

export enum FrameBlending {
    OFF = 'off',
    SMART = 'smart',
    FULL = 'full',
}

export interface DisplayMode extends VbRenderingGeometry {
    palette: VbPalette;
    anaglyph: VbAnaglyphPalette;
    swapEyes: boolean;
    frameBlending: FrameBlending;
}

export function eyesSwapped(mode: DisplayMode): boolean {
    return mode.swapEyes && mode.eyes === VbEyes.BOTH;
}

export function isRenderingMode(mode: string): mode is VbRenderingMode {
    return mode in VB_RENDERING_GEOMETRIES;
}

export const VB_DEFAULT_RENDERING_MODE = VbRenderingMode.LEFT;

export function buildDisplayMode(
    mode: string,
    palette: VbPalette,
    anaglyph: VbAnaglyphPalette,
    swapEyes = false,
    frameBlending = FrameBlending.OFF,
): DisplayMode {
    const geometry = VB_RENDERING_GEOMETRIES[
        isRenderingMode(mode) ? mode : VB_DEFAULT_RENDERING_MODE
    ];
    return { ...geometry, palette, anaglyph, swapEyes, frameBlending };
}

// a small picture of a moment (the rewind filmstrip's): the mode on screen where that is one picture, else the left eye
// in its palette, as two eyes side by side or interleaved make no sense at thumbnail size. Never blended
export function thumbnailDisplayMode(live: DisplayMode): DisplayMode {
    return {
        ...(live.layout === VbStereoLayout.OVERLAY
            ? live
            : buildDisplayMode(VbRenderingMode.LEFT, live.palette, live.anaglyph)),
        frameBlending: FrameBlending.OFF,
    };
}

export const VB_DEFAULT_DISPLAY_MODE = buildDisplayMode(
    VB_DEFAULT_RENDERING_MODE,
    VB_DEFAULT_PALETTE,
    VB_ANAGLYPH_PALETTES[VB_DEFAULT_ANAGLYPH_PALETTE_ID]
);

// the core's counters, read with `vbGetCounter`. Time counters are CPU cycles wrapping at 2^31, cache counters
// are counts. Order as `VB_COUNT_*` in vb.h
export enum VbCounter {
    Cycles = 0, // CPU cycles run
    Halted, // of them, halted
    CacheHits, // instruction cache lookups that hit
    CacheMisses, // lines filled
    FetchWait, // cycles filling lines and fetching uncached code
    BusVip, // cycles of data transfers with the VIP
    BusVsu, // with the VSU
    BusMisc, // with the hardware registers and the VCU
    BusCart, // with the game pak ROM and expansion
    BusSram, // with the game pak RAM
    BusWram, // with system RAM
    VipContention, // of the VIP transfers, waiting for the drawing
    PipelineWait, // cycles waiting for a writeback, the flags or the bus
    XpBusy, // cycles the VIP spent drawing
    XpHeld, // of them, held up by CPU loads
    Count,
}
