import { nls } from '../common/emulator-nls';
import {
  VB_ANAGLYPH_PALETTES,
  VB_DEFAULT_ANAGLYPH_PALETTE_ID,
  VB_DEFAULT_PALETTE,
  VB_DUBOIS_MATRICES,
  VB_PALETTES,
  VbAnaglyphMatrices,
  VbAnaglyphPalette,
  VbDuboisProfile,
  VbDuboisProfileSelection,
  VbPalette,
  VbRenderingMode,
} from '../common/vb-constants';
import { EmulatorResumeStart } from '../common/emulator-save-state';
import {
  EmulatorCompanionLocation,
  EmulatorSramInit,
  EmulatorSramWindow,
} from '../common/emulator-sram';

export enum VbLinkStatus {
  idle,
  connect,
  initiate,
  transfer,
}

export interface VbLinkStatusData {
  status: VbLinkStatus
  done: number
  data?: Buffer
};

export enum VbHardwareMode {
  AUTO = 'auto',
  VIRTUAL_BOY = 'vb',
  VB_COLOR = 'vbc',
}

// VBC support byte stored in the first reserved byte of the 32-byte ROM header
export enum VbColorSupport {
  LEGACY = 0x00,
  ENHANCED = 0x80,
  ONLY = 0xC0,
}

let _emulatorHardwareModeLabels: Record<VbHardwareMode, string> | undefined;
export function emulatorHardwareModeLabels(): Record<VbHardwareMode, string> {
  return _emulatorHardwareModeLabels ??= {
    [VbHardwareMode.AUTO]: nls.localize('vueport/vbColor/hardware/auto', 'Auto'),
    [VbHardwareMode.VIRTUAL_BOY]: nls.localize('vueport/vbColor/hardware/virtualBoy', 'Virtual Boy'),
    [VbHardwareMode.VB_COLOR]: nls.localize('vueport/vbColor/hardware/vbColor', 'VB Color'),
  };
}

// resolve Auto without changing any emulated reset-state register
export function resolveVbHardwareMode(mode: string, support: number): VbHardwareMode.VIRTUAL_BOY | VbHardwareMode.VB_COLOR {
  if (mode === VbHardwareMode.VIRTUAL_BOY) {
    return VbHardwareMode.VIRTUAL_BOY;
  }
  if (mode === VbHardwareMode.VB_COLOR) {
    return VbHardwareMode.VB_COLOR;
  }
  return support === VbColorSupport.ENHANCED || support === VbColorSupport.ONLY
    ? VbHardwareMode.VB_COLOR
    : VbHardwareMode.VIRTUAL_BOY;
}

export function vbColorSupportLabel(support: number): string {
  switch (support) {
    case VbColorSupport.ENHANCED:
      return nls.localize('vueport/vbColor/hardware/vbcEnhanced', 'VB Color Enhanced');
    case VbColorSupport.ONLY:
      return nls.localize('vueport/vbColor/hardware/vbcOnly', 'VB Color Only');
    case VbColorSupport.LEGACY:
      return nls.localize('vueport/vbColor/hardware/vbLegacy', 'Virtual Boy');
    default:
      return nls.localize('vueport/vbColor/hardware/unknownSupport', 'Unknown (0x{0})', support.toString(16).toUpperCase().padStart(2, '0'));
  }
}

export interface RomHeader {
  name: string
  maker: string
  code: string
  version: number
  // VBC support classification byte at header offset +0x14
  vbcSupport: number
  // whether the 32 bytes look like a cartridge header: every dump parses, and one without a header parses into
  // noise. See parseRomHeader for what is checked
  valid: boolean
};

export const EMPTY_ROM_HEADER: RomHeader = {
  name: '',
  maker: '',
  code: '',
  version: 0,
  vbcSupport: VbColorSupport.LEGACY,
  valid: false,
};

// the header sits at a fixed offset from the end of the cartridge, which is why a padded dump still parses
export const ROM_HEADER_OFFSET_FROM_END = 544;

// how long the pointer must be still over the screen before the floating controls over it go away (the
// transport strip and, in Debug mode, the screen inspector's tools)
export const STRIP_IDLE_DELAY = 6000;
// how far, in CSS pixels, a pointer that is not a mouse has to move to bring them back
export const STRIP_WAKE_DISTANCE = 24;

export const BYTES_PER_MBIT = 131072;

// the name is Shift_JIS, as several commercial titles have kana in it; a browser that cannot decode it falls
// back to Latin-1, wrong for those titles but readable for the rest
export function parseRomHeader(rom: Uint8Array): RomHeader {
  if (rom.length < ROM_HEADER_OFFSET_FROM_END) {
    return EMPTY_ROM_HEADER;
  }
  const header = rom.subarray(rom.length - ROM_HEADER_OFFSET_FROM_END).subarray(0, 32);
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...header.subarray(from, to));
  let name: string;
  try {
    name = new TextDecoder('shift_jis').decode(header.subarray(0, 20));
  } catch {
    name = ascii(0, 20);
  }
  // a real cartridge pads these fields with spaces; NULs mean there is no header where one was expected, and
  // dropping them keeps control characters out of the panel
  const withoutNuls = (text: string) => text.replace(/\0/g, '');
  // the maker and game codes are fixed-width printable ASCII on every cartridge, commercial and homebrew, and a
  // ROM with no header has 0x00 or 0xFF there, so they are the check. The name (Shift_JIS) and the version byte
  // can hold anything
  const printable = (from: number, to: number) =>
    header.subarray(from, to).every(byte => byte >= 0x20 && byte <= 0x7e);
  return {
    // padded, not trimmed: the field is fixed width, and the panel trims it for display
    name: withoutNuls(name).padEnd(20, ' '),
    maker: withoutNuls(ascii(25, 27)),
    code: withoutNuls(ascii(27, 31)),
    version: header[31],
    vbcSupport: header[20],
    valid: printable(25, 31) && withoutNuls(name).trim().length > 0,
  };
}

export function romSizeInMBit(rom: Uint8Array): number {
  return rom.length / BYTES_PER_MBIT;
}

export const ROM_HEADER_MAKERS: { [key: string]: string } = {
  // Official Maker Codes
  '01': 'Nintendo',
  '0B': 'Coconuts',
  '18': 'Hudson Soft',
  '28': 'Kemco',
  '67': 'Ocean',
  '7F': 'Kemco America',
  '8B': 'Bullet-Proof Software',
  '8F': "I'Max",
  '99': 'Pack-in-Video',
  'AH': 'J-Wing',
  'B2': 'Bandai',
  'C0': 'Taito',
  'E4': 'T&E Soft',
  'E7': 'Athena',
  'EB': 'Atlus',

  // Imaginary Official Maker Codes
  '0A': 'Konami',

  // Homebrew Authors
  'AB': 'Amos Bieler',
  'AE': 'Aegis Games',
  'CR': 'Christian Radke',
  'DA': 'Dan Bergman',
  'DB': 'David Tucker',
  'DD': '16-Bit',
  'DP': 'Pat Daderko',
  'DW': 'David Williamson',
  'GP': 'Guy Perfect',
  'JE': 'Jorge Andres Eremiev',
  'MH': 'Matej Horvat',
  'MK': 'Martin Kujaczynski',
  'NY': 'Nyrator',
  'PA': 'prior art',
  'PR': 'PizzaRollsRoyce',
  'SP': 'Sploopby!',
  'TB': 'Trailboss',
  'TS': 'Thunderstruck',
  'TV': 'Team VUEngine',
  'VE': 'Virtual-E',
  'VU': 'Team VUEngine',
};

export interface EmulatorConfig {
  name: string
  path: string
  args: string
};

let _emulationRenderingModes: Record<VbRenderingMode, string> | undefined;

// built on first use, not at import: localization is installed during start-up (see setLocalization)
export function emulationRenderingModes(): Record<VbRenderingMode, string> {
  return _emulationRenderingModes ??= {
  [VbRenderingMode.LEFT]: nls.localize('vueport/display/renderingModes/options/leftEye', 'Left Eye'),
  [VbRenderingMode.RIGHT]: nls.localize('vueport/display/renderingModes/options/rightEye', 'Right Eye'),
  [VbRenderingMode.ANAGLYPH]: nls.localize('vueport/display/renderingModes/options/anaglyph', 'Anaglyph'),
  [VbRenderingMode.SIDE_BY_SIDE]: nls.localize('vueport/display/renderingModes/options/sideBySide', 'Side By Side'),
  [VbRenderingMode.CYBERSCOPE]: nls.localize('vueport/display/renderingModes/options/cyberscope', 'CyberScope'),
  [VbRenderingMode.HLI]: nls.localize('vueport/display/renderingModes/options/hli', 'HLI'),
  [VbRenderingMode.VLI]: nls.localize('vueport/display/renderingModes/options/vli', 'VLI'),
};
}

let _emulationRenderingModeNames: Record<VbRenderingMode, string> | undefined;

// spelt-out names for the line under the control, only for the abbreviated modes (HLI); every other mode's
// card label already is its name and is taken from emulationRenderingModes
export function emulationRenderingModeNames(): Record<VbRenderingMode, string> {
  return _emulationRenderingModeNames ??= {
  ...emulationRenderingModes(),
  [VbRenderingMode.HLI]: nls.localize('vueport/display/renderingModes/names/hli',
    'Horizontal Line Interlaced'),
  [VbRenderingMode.VLI]: nls.localize('vueport/display/renderingModes/names/vli',
    'Vertical Line Interlaced'),
};
}

let _emulationRenderingModeDescriptions: Record<VbRenderingMode, string> | undefined;

export function emulationRenderingModeDescriptions(): Record<VbRenderingMode, string> {
  return _emulationRenderingModeDescriptions ??= {
  [VbRenderingMode.LEFT]: nls.localize('vueport/display/renderingModes/about/leftEye',
    'Mono, only the left eye.'),
  [VbRenderingMode.RIGHT]: nls.localize('vueport/display/renderingModes/about/rightEye',
    'Mono, only the right eye.'),
  [VbRenderingMode.ANAGLYPH]: nls.localize('vueport/display/renderingModes/about/anaglyph',
    'Both eyes in one picture, tinted for use with a pair of colored 3D glasses.'),
  [VbRenderingMode.SIDE_BY_SIDE]: nls.localize('vueport/display/renderingModes/about/sideBySide',
    'Both eyes next to each other, for use with compatible viewers.'),
  [VbRenderingMode.CYBERSCOPE]: nls.localize('vueport/display/renderingModes/about/cyberscope',
    'Both eyes squeezed to half width for use with a CyberScope.'),
  [VbRenderingMode.HLI]: nls.localize('vueport/display/renderingModes/about/hli',
    'The eyes on alternating rows, for a display that polarizes line by line.'),
  [VbRenderingMode.VLI]: nls.localize('vueport/display/renderingModes/about/vli',
    'The eyes on alternating columns, for a lenticular or column-interleaved display.'),
};
}

let _emulationPalettes: Record<string, string> | undefined;

// built on first use, not at import: localization is installed during start-up (see setLocalization)
export function emulationPalettes(): Record<string, string> {
  return _emulationPalettes ??= {
  'default': nls.localize('vueport/palettes/color/default', 'Vibrant'),
  'white': nls.localize('vueport/palettes/color/white', 'White'),
  'authentic': nls.localize('vueport/palettes/color/authentic', 'Authentic'),
  'red': nls.localize('vueport/palettes/color/red', 'Red'),
  'coral': nls.localize('vueport/palettes/color/coral', 'Coral'),
  'gray': nls.localize('vueport/palettes/color/gray', 'Gray'),
  'green': nls.localize('vueport/palettes/color/green', 'Green'),
  'blue': nls.localize('vueport/palettes/color/blue', 'Blue'),
  'cyan': nls.localize('vueport/palettes/color/cyan', 'Cyan'),
  'magenta': nls.localize('vueport/palettes/color/magenta', 'Magenta'),
  'yellow': nls.localize('vueport/palettes/color/yellow', 'Yellow'),
  'gb': nls.localize('vueport/palettes/color/gb', 'GB'),
  'gbp': nls.localize('vueport/palettes/color/gbp', 'GB Pocket'),
  'gbl': nls.localize('vueport/palettes/color/gbl', 'GB Light'),
  'sgb-1a': nls.localize('vueport/palettes/color/sgb1a', 'Super GB 1A'),
  'sgb-1b': nls.localize('vueport/palettes/color/sgb1b', 'Super GB 1B'),
  'sgb-1c': nls.localize('vueport/palettes/color/sgb1c', 'Super GB 1C'),
  'sgb-1d': nls.localize('vueport/palettes/color/sgb1d', 'Super GB 1D'),
  'sgb-1e': nls.localize('vueport/palettes/color/sgb1e', 'Super GB 1E'),
  'sgb-1f': nls.localize('vueport/palettes/color/sgb1f', 'Super GB 1F'),
  'sgb-1g': nls.localize('vueport/palettes/color/sgb1g', 'Super GB 1G'),
  'sgb-1h': nls.localize('vueport/palettes/color/sgb1h', 'Super GB 1H'),
  'sgb-2a': nls.localize('vueport/palettes/color/sgb2a', 'Super GB 2A'),
  'sgb-2b': nls.localize('vueport/palettes/color/sgb2b', 'Super GB 2B'),
  'sgb-2c': nls.localize('vueport/palettes/color/sgb2c', 'Super GB 2C'),
  'sgb-2d': nls.localize('vueport/palettes/color/sgb2d', 'Super GB 2D'),
  'sgb-2e': nls.localize('vueport/palettes/color/sgb2e', 'Super GB 2E'),
  'sgb-2f': nls.localize('vueport/palettes/color/sgb2f', 'Super GB 2F'),
  'sgb-2g': nls.localize('vueport/palettes/color/sgb2g', 'Super GB 2G'),
  'sgb-2h': nls.localize('vueport/palettes/color/sgb2h', 'Super GB 2H'),
  'sgb-3a': nls.localize('vueport/palettes/color/sgb3a', 'Super GB 3A'),
  'sgb-3b': nls.localize('vueport/palettes/color/sgb3b', 'Super GB 3B'),
  'sgb-3c': nls.localize('vueport/palettes/color/sgb3c', 'Super GB 3C'),
  'sgb-3d': nls.localize('vueport/palettes/color/sgb3d', 'Super GB 3D'),
  'sgb-3e': nls.localize('vueport/palettes/color/sgb3e', 'Super GB 3E'),
  'sgb-3f': nls.localize('vueport/palettes/color/sgb3f', 'Super GB 3F'),
  'sgb-3g': nls.localize('vueport/palettes/color/sgb3g', 'Super GB 3G'),
  'sgb-3h': nls.localize('vueport/palettes/color/sgb3h', 'Super GB 3H'),
  'sgb-4a': nls.localize('vueport/palettes/color/sgb4a', 'Super GB 4A'),
  'sgb-4b': nls.localize('vueport/palettes/color/sgb4b', 'Super GB 4B'),
  'sgb-4c': nls.localize('vueport/palettes/color/sgb4c', 'Super GB 4C'),
  'sgb-4d': nls.localize('vueport/palettes/color/sgb4d', 'Super GB 4D'),
  'sgb-4e': nls.localize('vueport/palettes/color/sgb4e', 'Super GB 4E'),
  'sgb-4f': nls.localize('vueport/palettes/color/sgb4f', 'Super GB 4F'),
  'sgb-4g': nls.localize('vueport/palettes/color/sgb4g', 'Super GB 4G'),
  'sgb-4h': nls.localize('vueport/palettes/color/sgb4h', 'Super GB 4H'),
};
}

let _emulationAnaglyphPalettes: Record<string, string> | undefined;

// built on first use, not at import: localization is installed during start-up (see setLocalization)
export function emulationAnaglyphPalettes(): Record<string, string> {
  return _emulationAnaglyphPalettes ??= {
  'red-cyan': nls.localize('vueport/palettes/anaglyph/redCyan', 'Red / Cyan'),
  'red-blue': nls.localize('vueport/palettes/anaglyph/redBlue', 'Red / Blue'),
  'red-green': nls.localize('vueport/palettes/anaglyph/redGreen', 'Red / Green'),
  'green-magenta': nls.localize('vueport/palettes/anaglyph/greenMagenta', 'Green / Magenta'),
  'amber-blue': nls.localize('vueport/palettes/anaglyph/amberBlue', 'Amber / Blue'),
};
}

export interface CustomPalette {
  name: string
  colors: string[]
};

export interface CustomAnaglyphPalette {
  name: string
  left: string
  right: string
  duboisProfile?: VbDuboisProfileSelection
  duboisMatrices?: VbAnaglyphMatrices
};

export const CUSTOM_PALETTE_PREFIX = 'custom:';

export const getCustomPaletteId = (name: string): string => `${CUSTOM_PALETTE_PREFIX}${name}`;

const findCustom = <T extends { name: string }>(id: string, custom: T[]): T | undefined =>
  id.startsWith(CUSTOM_PALETTE_PREFIX)
    ? custom.find(entry => entry.name === id.slice(CUSTOM_PALETTE_PREFIX.length))
    : undefined;

// parse a #rrggbb color, falling back to black on anything unparseable
export const parseColor = (color: string): number => {
  const parsed = parseInt(color.replace('#', ''), 16);
  return Number.isNaN(parsed) ? 0 : parsed & 0xffffff;
};

export const formatColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

export const toVbPalette = (colors: string[]): VbPalette =>
  VB_DEFAULT_PALETTE.map((fallback, level) =>
    colors[level] !== undefined
      ? parseColor(colors[level])
      : fallback
  ) as VbPalette;

export const resolvePalette = (id: string, custom: CustomPalette[]): VbPalette => {
  const customPalette = findCustom(id, custom);
  if (customPalette) {
    return toVbPalette(customPalette.colors ?? []);
  }
  return VB_PALETTES[id] ?? VB_DEFAULT_PALETTE;
};

// fill malformed or incomplete hand-edited matrices from a known-safe calibration
export const normalizeAnaglyphMatrices = (
  matrices: VbAnaglyphMatrices | undefined,
  fallback: VbAnaglyphMatrices = VB_DUBOIS_MATRICES['red-cyan'],
): VbAnaglyphMatrices => {
  const normalize = (values: number[] | undefined, defaults: number[]): number[] =>
    Array.from({ length: 9 }, (_, index) =>
      typeof values?.[index] === 'number' && Number.isFinite(values[index])
        ? values[index]
        : defaults[index]
    );
  return {
    left: normalize(matrices?.left, fallback.left),
    right: normalize(matrices?.right, fallback.right),
  };
};

export const resolveAnaglyphPalette = (id: string, custom: CustomAnaglyphPalette[]): VbAnaglyphPalette => {
  const customPalette = findCustom(id, custom);
  if (customPalette) {
    const resolved: VbAnaglyphPalette = {
      left: parseColor(customPalette.left),
      right: parseColor(customPalette.right),
    };
    // calibration is explicit: matching a preset's two tint colors still remains a channel filter when
    // duboisProfile is absent
    if (customPalette.duboisProfile === 'custom') {
      resolved.duboisMatrices = normalizeAnaglyphMatrices(customPalette.duboisMatrices);
    } else if (customPalette.duboisProfile
      && Object.prototype.hasOwnProperty.call(VB_DUBOIS_MATRICES, customPalette.duboisProfile)) {
      resolved.duboisProfile = customPalette.duboisProfile as VbDuboisProfile;
    }
    return resolved;
  }
  return VB_ANAGLYPH_PALETTES[id] ?? VB_ANAGLYPH_PALETTES[VB_DEFAULT_ANAGLYPH_PALETTE_ID];
};

// the halo color where no one palette color is the answer, with contrast against a dark or a light surface;
// white where the host sets no --vp-ambient-color or there is no document
export const neutralDecorationColor = (): string =>
  (typeof document !== 'undefined'
    && getComputedStyle(document.documentElement)
      .getPropertyValue('--vp-ambient-color').trim())
  || '#ffffff';

// the Ambient halo's color with decorationColorFromPalette on: the palette's fully-lit level, so the halo reads
// as an extension of the image. Anaglyph (eyes tinted oppositely) and VB Color (draws from CRAM) fall back to
// neutralDecorationColor
export const paletteDecorationColor = (
  renderingMode: string,
  palette: VbPalette,
  // VB Color hardware is driving the picture, so the palette is not what is on screen
  vbcHardwareActive = false,
): string =>
  renderingMode === VbRenderingMode.ANAGLYPH || vbcHardwareActive
    ? neutralDecorationColor()
    : formatColor(palette[palette.length - 1]);

export enum EmulatorRomStatus {
    CHECKING = 'checking',
    EXISTS = 'exists',
    NOT_EXISTS = 'not_exists',
}

export enum EmulatorMode {
  PLAY = 'play',
  DEBUG = 'debug',
  // see `emulator-color-editor.ts`
  COLOR = 'color',
}

export enum EmulatorScale {
  AUTO = 'auto',
  FIT = 'fit',
  X1 = 'x1',
  X2 = 'x2',
  X3 = 'x3',
  X4 = 'x4',
  X5 = 'x5',
  X6 = 'x6',
}

export interface EmulatorScaleOption {
  value: EmulatorScale;
  label: string;
  description: string;
}

let _emulatorScaleOptions: EmulatorScaleOption[] | undefined;

// built on first use, not at import: localization is installed during start-up (see setLocalization)
export function emulatorScaleOptions(): EmulatorScaleOption[] {
  // the six fixed multiples share one sentence with the number folded in, one string for a translator
  const multiple = (factor: number): string => nls.localize(
    'vueport/display/scales/about/multiple',
    'Integer scale up to {0} times the original size.',
    factor,
  );
  return _emulatorScaleOptions ??= [{
  value: EmulatorScale.AUTO,
  label: nls.localize('vueport/display/scales/options/auto', 'Auto'),
  description: nls.localize('vueport/display/scales/about/auto',
    'The largest possible integer scale.'),
}, {
  value: EmulatorScale.FIT,
  label: nls.localize('vueport/display/scales/options/stretch', 'Stretch'),
  description: nls.localize('vueport/display/scales/about/stretch',
    'Fills the entire window, allowing uneven scaling.'),
}, {
  value: EmulatorScale.X1,
  label: nls.localize('vueport/display/scales/options/x1', '×1'),
  description: multiple(1),
}, {
  value: EmulatorScale.X2,
  label: nls.localize('vueport/display/scales/options/x2', '×2'),
  description: multiple(2),
}, {
  value: EmulatorScale.X3,
  label: nls.localize('vueport/display/scales/options/x3', '×3'),
  description: multiple(3),
}, {
  value: EmulatorScale.X4,
  label: nls.localize('vueport/display/scales/options/x4', '×4'),
  description: multiple(4),
}, {
  value: EmulatorScale.X5,
  label: nls.localize('vueport/display/scales/options/x5', '×5'),
  description: multiple(5),
}, {
  value: EmulatorScale.X6,
  label: nls.localize('vueport/display/scales/options/x6', '×6'),
  description: multiple(6),
}];
}

// what is drawn around the picture where it does not fill the view
export enum EmulatorDecoration {
  NONE = 'none',
  BLACK = 'black', // what a real Virtual Boy shows around its image
  AMBIENT = 'ambient', // a halo in a chosen color
  IMMERSION = 'immersion', // the halo driven by the picture's edges
}

let _emulatorDecorationLabels: Record<EmulatorDecoration, string> | undefined;

// built on first use (see emulatorSramInitLabels)
export function emulatorDecorationLabels(): Record<EmulatorDecoration, string> {
  return _emulatorDecorationLabels ??= {
    [EmulatorDecoration.NONE]: nls.localize('vueport/preferences/decoration/options/none', 'None'),
    [EmulatorDecoration.BLACK]: nls.localize('vueport/preferences/decoration/options/black', 'Black'),
    [EmulatorDecoration.AMBIENT]: nls.localize('vueport/preferences/decoration/options/ambient', 'Ambient'),
    [EmulatorDecoration.IMMERSION]: nls.localize('vueport/preferences/decoration/options/immersion', 'Immersion'),
  };
}

let _emulatorDecorationDescriptions: Record<EmulatorDecoration, string> | undefined;

// shown under the control for the chosen decoration; built on first use (see emulatorSramInitLabels)
export function emulatorDecorationDescriptions(): Record<EmulatorDecoration, string> {
  return _emulatorDecorationDescriptions ??= {
    [EmulatorDecoration.NONE]: nls.localize('vueport/preferences/decoration/about/none',
      'Nothing. The interface\'s own surface shows around the picture.'),
    [EmulatorDecoration.BLACK]: nls.localize('vueport/preferences/decoration/about/black',
      'Black all around, which is what a real Virtual Boy shows around its image.'),
    [EmulatorDecoration.AMBIENT]: nls.localize('vueport/preferences/decoration/about/ambient',
      'A soft halo around the picture, in a color of your choice.'),
    [EmulatorDecoration.IMMERSION]: nls.localize('vueport/preferences/decoration/about/immersion',
      'A soft halo driven by the picture itself.'),
  };
}

let _emulatorVideoQualityLabels: Record<string, string> | undefined;

// named rather than given as a bit rate, as the number that matters depends on rendering mode and scale (a
// 384x224 single eye vs. a 512x448 Cyberscope at 4x); VIDEO_BIT_RATES turns them into numbers. Built on first use
export function emulatorVideoQualityLabels(): Record<string, string> {
  return _emulatorVideoQualityLabels ??= {
    low: nls.localize('vueport/preferences/videoQuality/options/low', 'Small File'),
    medium: nls.localize('vueport/preferences/videoQuality/options/medium', 'Balanced'),
    high: nls.localize('vueport/preferences/videoQuality/options/high', 'High Quality'),
  };
}

let _emulatorVideoFormatLabels: Record<string, string> | undefined;

// a preference rather than a promise: Safari has no WebM encoder, Firefox no MP4 one, and asking for a missing
// one gets the other. Built on first use (see emulatorSramInitLabels)
export function emulatorVideoFormatLabels(): Record<string, string> {
  return _emulatorVideoFormatLabels ??= {
    auto: nls.localize('vueport/preferences/videoFormat/options/auto', 'Auto'),
    webm: nls.localize('vueport/preferences/videoFormat/options/webm', 'Prefer WebM'),
    mp4: nls.localize('vueport/preferences/videoFormat/options/mp4', 'Prefer MP4'),
  };
}

export enum EmulatorGamePadKeyCode {
  A = 'KeyM',
  B = 'KeyN',
  Start = 'KeyB',
  Select = 'KeyV',
  LUp = 'KeyE',
  LRight = 'KeyF',
  LDown = 'KeyD',
  LLeft = 'KeyA', // KeyS is "Low Power"
  RUp = 'KeyI',
  RRight = 'KeyL',
  RDown = 'KeyK',
  RLeft = 'KeyJ',
  LT = 'KeyG',
  RT = 'KeyH',
}

// something the emulator can be told to do, as opposed to a game pad button. Not key codes: keys reach
// actions through the keybinding registry, with defaults in registerKeybindings
export enum EmulatorAction {
  Fullscreen = 'fullscreen',
  ToggleControlsOverlay = 'toggleControlsOverlay',
  SaveState = 'saveState',
  LoadState = 'loadState',
  ToggleFastForward = 'toggleFastForward',
  PauseToggle = 'pauseToggle',
  ToggleSlowmotion = 'toggleSlowmotion',
  ToggleLowPower = 'toggleLowPower',
  Rewind = 'rewind',
  FrameAdvance = 'frameAdvance',
  Reset = 'reset',
  AudioMute = 'audioMute',
  Screenshot = 'screenshot',
  VideoRecord = 'videoRecord',
}

export { EmulatorCompanionLocation, EmulatorSramInit, EmulatorSramWindow };

let _emulatorCompanionLocationLabels: Record<EmulatorCompanionLocation, string> | undefined;

// built on first use (see emulatorSramInitLabels)
export function emulatorCompanionLocationLabels(): Record<EmulatorCompanionLocation, string> {
  return _emulatorCompanionLocationLabels ??= {
    [EmulatorCompanionLocation.ROM]: nls.localize(
      'vueport/preferences/companionFiles/options/rom', 'Beside the ROM'),
    [EmulatorCompanionLocation.STORAGE]: nls.localize(
      'vueport/preferences/companionFiles/options/storage', "In the application's storage"),
  };
}

let _emulatorSramInitLabels: Record<EmulatorSramInit, string> | undefined;

// built on first use, not at import: localization is installed during start-up (see setLocalization)
export function emulatorSramInitLabels(): Record<EmulatorSramInit, string> {
  return _emulatorSramInitLabels ??= {
  [EmulatorSramInit.RANDOM]: nls.localize('vueport/preferences/sramInit/options/random', 'Random'),
  [EmulatorSramInit.ZEROES]: nls.localize('vueport/preferences/sramInit/options/zeroes', 'Zeroes'),
};
}

let _emulatorSramWindowLabels: Record<EmulatorSramWindow, string> | undefined;

// built on first use (see emulatorSramInitLabels). The sizes name themselves and stay untranslated; "Full"
// rather than 16 MB, as that is the whole region handed over so no game can run out, not a real cartridge
export function emulatorSramWindowLabels(): Record<EmulatorSramWindow, string> {
  return _emulatorSramWindowLabels ??= {
    [EmulatorSramWindow.AUTO]: nls.localize('vueport/preferences/sramWindow/options/auto', 'Full (16 MB)'),
    [EmulatorSramWindow.W16K]: nls.localize(
      'vueport/preferences/sramWindow/options/w16k', '16 KB (standard cartridge)'),
    [EmulatorSramWindow.W32K]: '32 KB',
    [EmulatorSramWindow.W64K]: '64 KB',
    [EmulatorSramWindow.W128K]: '128 KB',
    [EmulatorSramWindow.W256K]: '256 KB',
    [EmulatorSramWindow.W512K]: '512 KB',
    [EmulatorSramWindow.W1M]: '1 MB',
    [EmulatorSramWindow.W2M]: '2 MB',
    [EmulatorSramWindow.W4M]: '4 MB',
    [EmulatorSramWindow.W8M]: '8 MB',
  };
}

export { EmulatorResumeStart };

let _emulatorResumeStartLabels: Record<EmulatorResumeStart, string> | undefined;

// built on first use (see emulatorSramInitLabels)
export function emulatorResumeStartLabels(): Record<EmulatorResumeStart, string> {
  return _emulatorResumeStartLabels ??= {
    [EmulatorResumeStart.ASK]: nls.localize('vueport/preferences/suspendResumeStart/options/ask', 'Ask'),
    [EmulatorResumeStart.RESUME]: nls.localize(
      'vueport/preferences/suspendResumeStart/options/resume', 'Resume'),
    [EmulatorResumeStart.IGNORE]: nls.localize(
      'vueport/preferences/suspendResumeStart/options/ignore', 'Ignore'),
  };
}
