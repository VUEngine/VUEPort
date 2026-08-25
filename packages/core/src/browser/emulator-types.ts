import { nls } from '../common/emulator-nls';
import {
  VB_ANAGLYPH_PALETTES,
  VB_DEFAULT_ANAGLYPH_PALETTE_ID,
  VB_DEFAULT_PALETTE_ID,
  VB_PALETTES,
  VbAnaglyphPalette,
  VbPalette,
  VbRenderingMode,
} from '../common/vb-constants';
import { EmulatorSramInit } from '../common/emulator-sram';

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

export interface RomHeader {
  name: string
  maker: string
  code: string
  version: number
};

export const EMPTY_ROM_HEADER: RomHeader = {
  name: '',
  maker: '',
  code: '',
  version: 0,
};

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

/**
 * Built on first use, not at import: the host installs its localization
 * during start-up, and a table built while this module loaded would be
 * English for the life of the process. See `setLocalization`.
 */
export function emulationRenderingModes(): Record<VbRenderingMode, string> {
  return _emulationRenderingModes ??= {
  [VbRenderingMode.LEFT]: nls.localize('vueport/renderingModes/leftEye', 'Left Eye'),
  [VbRenderingMode.RIGHT]: nls.localize('vueport/renderingModes/rightEye', 'Right Eye'),
  [VbRenderingMode.ANAGLYPH]: nls.localize('vueport/renderingModes/anaglyph', 'Anaglyph'),
  [VbRenderingMode.SIDE_BY_SIDE]: nls.localize('vueport/renderingModes/sideBySide', 'Side By Side'),
  [VbRenderingMode.CYBERSCOPE]: nls.localize('vueport/renderingModes/cyberscope', 'CyberScope'),
  [VbRenderingMode.HLI]: nls.localize('vueport/renderingModes/hli', 'Horizontal Line Interlaced'),
  [VbRenderingMode.VLI]: nls.localize('vueport/renderingModes/vli', 'Vertical Line Interlaced'),
};
}

let _emulationPalettes: Record<string, string> | undefined;

/**
 * Built on first use, not at import: the host installs its localization
 * during start-up, and a table built while this module loaded would be
 * English for the life of the process. See `setLocalization`.
 */
export function emulationPalettes(): Record<string, string> {
  return _emulationPalettes ??= {
  'default': nls.localize('vueport/palettes/default', 'Default'),
  'red': nls.localize('vueport/palettes/red', 'Pure Red'),
  'grey': nls.localize('vueport/palettes/grey', 'Grey'),
  'green': nls.localize('vueport/palettes/green', 'Green'),
  'blue': nls.localize('vueport/palettes/blue', 'Blue'),
  'cyan': nls.localize('vueport/palettes/cyan', 'Cyan'),
  'magenta': nls.localize('vueport/palettes/magenta', 'Magenta'),
  'yellow': nls.localize('vueport/palettes/yellow', 'Yellow'),
  'game-boy': nls.localize('vueport/palettes/game-boy', 'Game Boy'),
  'game-boy-pocket': nls.localize('vueport/palettes/game-boy-pocket', 'Game Boy Pocket'),
  'super-game-boy': nls.localize('vueport/palettes/super-game-boy', 'Super Game Boy'),
};
}

let _emulationAnaglyphPalettes: Record<string, string> | undefined;

/**
 * Built on first use, not at import: the host installs its localization
 * during start-up, and a table built while this module loaded would be
 * English for the life of the process. See `setLocalization`.
 */
export function emulationAnaglyphPalettes(): Record<string, string> {
  return _emulationAnaglyphPalettes ??= {
  'red-cyan': nls.localize('vueport/anaglyphPalettes/redCyan', 'Red / Cyan'),
  'red-blue': nls.localize('vueport/anaglyphPalettes/redBlue', 'Red / Blue'),
  'red-green': nls.localize('vueport/anaglyphPalettes/redGreen', 'Red / Green'),
  'green-magenta': nls.localize('vueport/anaglyphPalettes/greenMagenta', 'Green / Magenta'),
  'yellow-blue': nls.localize('vueport/anaglyphPalettes/yellowBlue', 'Yellow / Blue'),
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
  VB_PALETTES[VB_DEFAULT_PALETTE_ID].map((fallback, level) =>
    colors[level] !== undefined
      ? parseColor(colors[level])
      : fallback
  ) as VbPalette;

export const resolvePalette = (id: string, custom: CustomPalette[]): VbPalette => {
  const customPalette = findCustom(id, custom);
  if (customPalette) {
    return toVbPalette(customPalette.colors ?? []);
  }
  return VB_PALETTES[id] ?? VB_PALETTES[VB_DEFAULT_PALETTE_ID];
};

export const resolveAnaglyphPalette = (id: string, custom: CustomAnaglyphPalette[]): VbAnaglyphPalette => {
  const customPalette = findCustom(id, custom);
  if (customPalette) {
    return { left: parseColor(customPalette.left), right: parseColor(customPalette.right) };
  }
  return VB_ANAGLYPH_PALETTES[id] ?? VB_ANAGLYPH_PALETTES[VB_DEFAULT_ANAGLYPH_PALETTE_ID];
};

/** Whether the ROM this emulator was opened on is actually there yet. */
export enum EmulatorRomStatus {
    CHECKING = 'checking',
    EXISTS = 'exists',
    NOT_EXISTS = 'not_exists',
}

export enum EmulatorMode {
  PLAY = 'play',
  DEBUG = 'debug',
}

export enum EmulatorScale {
  AUTO = 'auto',
  X1 = 'x1',
  X2 = 'x2',
  X3 = 'x3',
  X4 = 'x4',
  X5 = 'x5',
  X6 = 'x6',
  FIT = 'fit',
}

let _emulatorScaleOptions: { value: EmulatorScale, label: string }[] | undefined;

/**
 * Built on first use, not at import: the host installs its localization
 * during start-up, and a table built while this module loaded would be
 * English for the life of the process. See `setLocalization`.
 */
export function emulatorScaleOptions(): { value: EmulatorScale, label: string }[] {
  return _emulatorScaleOptions ??= [{
  value: EmulatorScale.AUTO,
  label: nls.localize('vueport/scales/auto', 'Auto'),
}, {
  value: EmulatorScale.X1,
  label: '×1',
}, {
  value: EmulatorScale.X2,
  label: '×2',
}, {
  value: EmulatorScale.X3,
  label: '×3',
}, {
  value: EmulatorScale.X4,
  label: '×4',
}, {
  value: EmulatorScale.X5,
  label: '×5',
}, {
  value: EmulatorScale.X6,
  label: '×6',
}, {
  value: EmulatorScale.FIT,
  label: nls.localize('vueport/scales/stretch', 'Stretch'),
}];
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

/**
 * Something the emulator can be told to do, as opposed to a button held on its
 * game pad.
 *
 * These identify an action and nothing else. They used to be key codes, which
 * they no longer are anywhere: a key reaches an action through the keybinding
 * registry, so what an action is bound to is whatever the user has mapped, and
 * an enum claiming otherwise could only ever be out of date. The default
 * mappings live where they belong, in `registerKeybindings`.
 */
export enum EmulatorAction {
  Fullscreen = 'fullscreen',
  ToggleControlsOverlay = 'toggleControlsOverlay',
  SaveState = 'saveState',
  LoadState = 'loadState',
  StateSlotDecrease = 'stateSlotDecrease',
  StateSlotIncrease = 'stateSlotIncrease',
  ToggleFastForward = 'toggleFastForward',
  PauseToggle = 'pauseToggle',
  ToggleSlowmotion = 'toggleSlowmotion',
  ToggleLowPower = 'toggleLowPower',
  Rewind = 'rewind',
  FrameAdvance = 'frameAdvance',
  Reset = 'reset',
  AudioMute = 'audioMute',
  Screenshot = 'screenshot',
}

export { EmulatorSramInit };

let _emulatorSramInitLabels: Record<EmulatorSramInit, string> | undefined;

/**
 * Built on first use, not at import: the host installs its localization
 * during start-up, and a table built while this module loaded would be
 * English for the life of the process. See `setLocalization`.
 */
export function emulatorSramInitLabels(): Record<EmulatorSramInit, string> {
  return _emulatorSramInitLabels ??= {
  [EmulatorSramInit.RANDOM]: nls.localize('vueport/sramInit/random', 'Random'),
  [EmulatorSramInit.ZEROES]: nls.localize('vueport/sramInit/zeroes', 'Zeroes'),
};
}
