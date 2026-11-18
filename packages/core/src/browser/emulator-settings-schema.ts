import { nls } from '../common/emulator-nls';
import { VueportConfig } from '../common/emulator-settings';
import { FrameBlending, VB_LEVELS } from '../common/vb-constants';
import { EMULATOR_SAVE_SLOTS } from '../common/emulator-sram';
import { TURBO_RATE_RANGE } from '../common/emulator-turbo';
import {
  emulationRenderingModeDescriptions,
  emulationRenderingModeNames,
  emulationRenderingModes,
  emulatorHardwareModeLabels,
  emulatorCompanionLocationLabels,
  emulatorDecorationDescriptions,
  emulatorDecorationLabels,
  emulatorResumeStartLabels,
  emulatorScaleOptions,
  emulatorSramInitLabels,
  emulatorSramWindowLabels,
  emulatorVideoFormatLabels,
  emulatorVideoQualityLabels,
} from './emulator-types';

// how each setting is presented, for hosts that build their settings screen from this. Plain JSON Schema, which Theia's
// preference schema takes almost as-is; not in common/ because the enum labels come from browser-side display tables
export interface VueportSettingSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title: string;
  description?: string;
  // numbers for a number setting offered at a few values only (rewind granularity)
  enum?: string[] | number[];
  enumItemLabels?: string[];
  // what picking each enum choice gets you, shown under the control for the chosen one; optional
  enumItemDescriptions?: string[];
  // each enum choice's name in full where the control's label is an abbreviation (HLI on a card, Horizontal Line
  // Interlaced beneath it); optional, falls back to enumItemLabels per choice
  enumItemNames?: string[];
  items?: unknown;
  multipleOf?: number;
  minimum?: number;
  maximum?: number;
  // color asks for a color well rather than a text field; the stored value is still a #rrggbb string
  format?: 'color';
}

let schema: Record<keyof VueportConfig, VueportSettingSchema> | undefined;

function frameBlendingChoices(): Pick<VueportSettingSchema, 'enum' | 'enumItemLabels' | 'enumItemDescriptions'> {
  return {
    enum: [FrameBlending.OFF, FrameBlending.SMART, FrameBlending.FULL],
    enumItemLabels: [
      nls.localize('vueport/preferences/frameBlending/options/off', 'Off'),
      nls.localize('vueport/preferences/frameBlending/options/smart', 'Smart'),
      nls.localize('vueport/preferences/frameBlending/options/full', 'Full Screen'),
    ],
    enumItemDescriptions: [
      nls.localize('vueport/preferences/frameBlending/about/off',
        'Every frame as the game draws it.'),
      nls.localize('vueport/preferences/frameBlending/about/smart',
        'Mixes only pixels shown every other frame.'),
      nls.localize('vueport/preferences/frameBlending/about/full',
        'Mixes every complete frame with the one before.'),
    ],
  };
}

// built on first use rather than at import, as the titles are localized and the host installs localization
// during start-up. No defaults, scopes or preference ids: see VUEPORT_DEFAULTS and VUEPORT_PREFERENCE_IDS
export function vueportSettingsSchema(): Record<keyof VueportConfig, VueportSettingSchema> {
  return schema ??= {
    gamepadRumbleIntensity: {
      type: 'number',
      title: nls.localize('vueport/preferences/gamepadRumbleIntensity/title', 'Game Pad Vibration'),
      description: nls.localize(
        'vueport/preferences/gamepadRumbleIntensity/description',
        'How strongly to play a game\'s rumble effects on your controller when no Rumble Pack is '
        + 'connected, in percent of what the controller can do; 0 turns it off. An approximation: the '
        + 'Rumble Pack\'s effects have lengths and shapes of their own that the protocol does not carry, '
        + 'so each one becomes a short pulse on the pad.'
      ),
      minimum: 0,
      maximum: 100,
    },
    turboRate: {
      type: 'number',
      title: nls.localize('vueport/preferences/turboRate/title', 'Turbo Speed'),
      description: nls.localize(
        'vueport/preferences/turboRate/description',
        'How many frames a turbo button stays pressed, and then released, before it repeats. '
        + 'Lower is faster: 1 presses 25 times a second, 2 about 12 times.'
      ),
      minimum: TURBO_RATE_RANGE.min,
      maximum: TURBO_RATE_RANGE.max,
    },
    touchControls: {
      type: 'string',
      title: nls.localize('vueport/preferences/touchControls/title', 'On-Screen Controller'),
      description: nls.localize('vueport/preferences/touchControls/description',
        'When to show a Virtual Boy controller on the screen, for playing by touch.'),
      enum: ['auto', 'always', 'never'],
      enumItemLabels: [
        nls.localize('vueport/preferences/touchControls/options/auto', 'Automatic'),
        nls.localize('vueport/preferences/touchControls/options/always', 'Always'),
        nls.localize('vueport/preferences/touchControls/options/never', 'Never'),
      ],
      enumItemDescriptions: [
        nls.localize('vueport/preferences/touchControls/about/auto',
          'appears as soon as the screen is touched, and goes once a controller or the keyboard is used.'),
        nls.localize('vueport/preferences/touchControls/about/always',
          'stays on screen, also while a controller is used.'),
        nls.localize('vueport/preferences/touchControls/about/never',
          'never on screen.'),
      ],
    },
    touchControlsOpacity: {
      type: 'number',
      title: nls.localize('vueport/preferences/touchControlsOpacity/title', 'Opacity'),
      description: nls.localize('vueport/preferences/touchControlsOpacity/description',
        'How solid the on-screen controller is drawn, in percent.'),
      minimum: 20,
      maximum: 100,
      multipleOf: 5,
    },
    touchControlsSize: {
      type: 'number',
      title: nls.localize('vueport/preferences/touchControlsSize/title', 'Size'),
      description: nls.localize('vueport/preferences/touchControlsSize/description',
        'How large the on-screen controller is drawn, in percent. Single buttons can be resized in the layout.'),
      minimum: 70,
      maximum: 140,
      multipleOf: 5,
    },
    touchControlsDiagonals: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/touchControlsDiagonals/title', 'Diagonals'),
      description: nls.localize('vueport/preferences/touchControlsDiagonals/description',
        'Holds two directions at once when the thumb rests between two arms of a d-pad.'),
    },
    touchControlsSlide: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/touchControlsSlide/title', 'Slide'),
      description: nls.localize('vueport/preferences/touchControlsSlide/description',
        'Moving the thumb off one button onto another presses that one instead, without lifting it.'),
    },
    touchControlsVibration: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/touchControlsVibration/title', 'Vibration'),
      description: nls.localize('vueport/preferences/touchControlsVibration/description',
        'A short buzz on every press.'),
    },
    touchControlsHighlight: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/touchControlsHighlight/title', 'Highlight Pressed Buttons'),
      description: nls.localize('vueport/preferences/touchControlsHighlight/description',
        'Lights a button in red for as long as it is held.'),
    },
    touchControlsRumble: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/touchControlsRumble/title', 'Rumble on This Device'),
      description: nls.localize('vueport/preferences/touchControlsRumble/description',
        'Plays a game\'s Rumble Pack effects on the device\'s own vibration motor while no controller with motors '
        + 'is connected. One motor without strength levels, so weaker effects are pulsed.'),
    },
    touchControlsLayout: {
      type: 'array',
      title: nls.localize('vueport/preferences/touchControlsLayout/title', 'On-Screen Controller Layout'),
    },
    vbcSupportEnabled: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/vbcSupportEnabled/title', 'VB Color Support'),
      description: nls.localize(
        'vueport/preferences/vbcSupportEnabled/description',
        'Expose VB Color hardware and features. When disabled, VUEPort behaves as an original '
        + 'Virtual Boy regardless of the ROM header or Hardware Mode.'
      ),
    },
    vbcAutoApplyColorPatches: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/vbcAutoApplyColorPatches/title', 'Auto-Apply Color Patches'),
      description: nls.localize(
        'vueport/preferences/vbcAutoApplyColorPatches/description',
        'Automatically colorize games VUEPort ships a color patch for, by patching the ROM \
on the fly. A specific game\'s color patches can be toggled from the Patches panel.'
      ),
    },
    hardwareMode: {
      type: 'string',
      title: nls.localize('vueport/preferences/hardwareMode/title', 'Hardware Mode'),
      description: nls.localize(
        'vueport/preferences/hardwareMode/description',
        'Which console VUEPort emulates. Auto selects VB Color for ROMs marked Enhanced (80) or '
        + 'VBC Only (C0), and original Virtual Boy otherwise.'
      ),
      enum: Object.keys(emulatorHardwareModeLabels()),
      enumItemLabels: Object.values(emulatorHardwareModeLabels()),
    },
    renderingMode: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/renderingMode/title',
        'Rendering Mode',
      ),
      description: nls.localize(
        'vueport/preferences/renderingMode/description',
        'How the built-in emulator presents the two eyes. The colors each mode is shown in are configured separately.'
      ),
      enum: Object.keys(emulationRenderingModes()),
      enumItemLabels: Object.values(emulationRenderingModes()),
      enumItemDescriptions: Object.values(emulationRenderingModeDescriptions()),
      enumItemNames: Object.values(emulationRenderingModeNames()),
    },
    swapEyes: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/swapEyes/title', 'Swap Eyes'),
      description: nls.localize(
        'vueport/preferences/swapEyes/description',
        'Switch left and right eyes in the 3D rendering modes: Anaglyph, Side by Side, CyberScope and the interleaved ones. \
Turn this on if the picture looks inside out, e.g. for glasses with the colors the other way round or a cross-eyed side-by-side view.'
      ),
    },
    stereoDepth: {
      type: 'number',
      title: nls.localize('vueport/preferences/stereoDepth/title', '3D Depth'),
      description: nls.localize(
        'vueport/preferences/stereoDepth/description',
        'The stereoscopic depth of the screen, in percent, where 100% is the depth of the real console. \
Takes effect from the next game frame.'
      ),
      minimum: 0,
      maximum: 200,
      multipleOf: 5,
    },
    frameBlending: {
      type: 'string',
      title: nls.localize('vueport/preferences/frameBlending/title', 'Frame Blending'),
      description: nls.localize(
        'vueport/preferences/frameBlending/description',
        'Mix adjacent frames to emulate human persistence of vision as it works on a real Virtual Boy.'
      ),
      ...frameBlendingChoices(),
    },
    columnTable: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/columnTable/title', 'Column Table'),
      description: nls.localize(
        'vueport/preferences/columnTable/description',
        "Emulate the Column Table timing the VB's mirrors movement. Enables respective effects in homebrew software."
      ),
    },
    mirrorSpinUp: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/mirrorSpinUp/title', 'Mirror Spin-Up'),
      description: nls.localize(
        'vueport/preferences/mirrorSpinUp/description',
        "Faithfully emulate how a real VB's mirror spin-up causes the picture to sway into place as the mirrors settle."
      ),
    },
    mirrorSpinUpDelay: {
      type: 'boolean',
      title: nls.localize('vueport/preferences/mirrorSpinUpDelay/title', 'Spin-Up Delay'),
      description: nls.localize(
        'vueport/preferences/mirrorSpinUpDelay/description',
        'Keep the screen dark for the 4 seconds a real VB takes before its mirrors show a picture, rather than for a moment.'
      ),
    },
    palette: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/palette/title',
        'Color Palette',
      ),
      description: nls.localize(
        'vueport/preferences/palette/description',
        'Colors the built-in emulator shows the four display brightness levels in, in every rendering mode but Anaglyph. '
        + 'Can be one of the built-in palettes or, as "custom:<name>", one defined in Custom Color Palettes.'
      ),
    },
    anaglyphPalette: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/anaglyphPalette/title',
        'Anaglyph Colors',
      ),
      description: nls.localize(
        'vueport/preferences/anaglyphPalette/description',
        'Tints the built-in emulator assigns to the eyes in the Anaglyph rendering mode. Pick the pair your glasses filter. '
        + 'Can be one of the built-in pairs or, as "custom:<name>", one defined in Custom Anaglyph Colors.'
      ),
    },
    customPalettes: {
      type: 'array',
      title: nls.localize(
        'vueport/preferences/customPalettes/title',
        'Custom Color Palettes'
      ),
      description: nls.localize(
        'vueport/preferences/customPalettes/description',
        'User-defined palettes, offered alongside the built-in ones.'
      ),
      items: {
        type: 'object',
        title: 'Custom color palette',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the palette.',
            title: 'Name',
          },
          colors: {
            type: 'array',
            description: "The display's four brightness levels, from unlit to fully lit, as #rrggbb.",
            title: 'Colors',
            items: {
              type: 'string',
            },
            minItems: VB_LEVELS,
            maxItems: VB_LEVELS,
          },
        },
      },
    },
    customAnaglyphPalettes: {
      type: 'array',
      title: nls.localize(
        'vueport/preferences/customAnaglyphPalettes/title',
        'Custom Anaglyph Colors'
      ),
      description: nls.localize(
        'vueport/preferences/customAnaglyphPalettes/description',
        'User-defined anaglyph colors and optional Dubois calibrations, offered alongside the built-in ones.'
      ),
      items: {
        type: 'object',
        title: 'Custom anaglyph colors',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the color pair.',
            title: 'Name',
          },
          left: {
            type: 'string',
            description: 'Tint of the left eye, as #rrggbb.',
            title: 'Left',
          },
          right: {
            type: 'string',
            description: 'Tint of the right eye, as #rrggbb.',
            title: 'Right',
          },
          duboisProfile: {
            type: 'string',
            description: 'RGB channel filters, a built-in Dubois profile, or a custom calibration.',
            title: 'Dubois profile',
            enum: ['none', 'red-cyan', 'green-magenta', 'amber-blue', 'custom'],
          },
          duboisMatrices: {
            type: 'object',
            description: 'Column-major 3x3 transforms for the left and right images.',
            title: 'Custom Dubois matrices',
            properties: {
              left: {
                type: 'array',
                items: { type: 'number' },
                minItems: 9,
                maxItems: 9,
              },
              right: {
                type: 'array',
                items: { type: 'number' },
                minItems: 9,
                maxItems: 9,
              },
            },
          },
        },
      },
    },
    scale: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/scalingMode/title',
        'Scale'
      ),
      description: nls.localize(
        'vueport/preferences/scalingMode/description',
        'Scaling mode of built-in emulator.'
      ),
      enum: emulatorScaleOptions().map(option => option.value),
      enumItemLabels: emulatorScaleOptions().map(option => option.label),
      enumItemDescriptions: emulatorScaleOptions().map(option => option.description),
    },
    decoration: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/decoration/title',
        'Screen Decoration',
      ),
      // each choice says what it does under the control once picked; see emulatorDecorationDescriptions
      description: nls.localize(
        'vueport/preferences/decoration/description',
        'What fills the view around the picture while playing.'
      ),
      enum: Object.keys(emulatorDecorationLabels()),
      enumItemLabels: Object.values(emulatorDecorationLabels()),
      enumItemDescriptions: Object.values(emulatorDecorationDescriptions()),
    },
    decorationColor: {
      type: 'string',
      format: 'color',
      title: nls.localize(
        'vueport/preferences/decorationColor/title',
        'Decoration Color',
      ),
      description: nls.localize(
        'vueport/preferences/decorationColor/description',
        'The color of the halo cast by the Ambient decoration.'
      ),
    },
    decorationColorFromPalette: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/decorationColorFromPalette/title',
        'Decoration Color From Palette',
      ),
      description: nls.localize(
        'vueport/preferences/decorationColorFromPalette/description',
        "Take the Ambient halo's color from the current color palette's fully-lit level instead of "
        + 'Decoration Color. A theme-appropriate neutral color is used in Anaglyph and on VB Color '
        + 'hardware, where there is no one palette color to take it from.'
      ),
    },
    decorationIntensity: {
      type: 'number',
      title: nls.localize(
        'vueport/preferences/decorationIntensity/title',
        'Decoration Intensity',
      ),
      description: nls.localize(
        'vueport/preferences/decorationIntensity/description',
        'Strength of the Ambient and Immersion halos.'
      ),
      minimum: 0,
      maximum: 100,
    },
    screenshotUseDisplaySettings: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/screenshotUseDisplay/title',
        'Same Display Settings as Emulator',
      ),
      description: nls.localize(
        'vueport/preferences/screenshotUseDisplay/description',
        'Use the current emulator display settings for screenshots.'
      ),
    },
    screenshotRenderingMode: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/renderingMode/title',
        'Rendering Mode',
      ),
      description: nls.localize(
        'vueport/preferences/screenshotRenderingMode/description',
        'How a screenshot presents the two eyes.'
      ),
      enum: Object.keys(emulationRenderingModes()),
      enumItemLabels: Object.values(emulationRenderingModes()),
      enumItemDescriptions: Object.values(emulationRenderingModeDescriptions()),
      enumItemNames: Object.values(emulationRenderingModeNames()),
    },
    screenshotFrameBlending: {
      type: 'string',
      title: nls.localize('vueport/preferences/frameBlending/title', 'Frame Blending'),
      description: nls.localize(
        'vueport/preferences/screenshotFrameBlending/description',
        'Mix adjacent frames to emulate human persistence of vision as it works on a real Virtual Boy'
      ),
      ...frameBlendingChoices(),
    },
    screenshotScale: {
      type: 'integer',
      title: nls.localize(
        'vueport/preferences/screenshotScale/title',
        'Scale',
      ),
      description: nls.localize(
        'vueport/preferences/screenshotScale/description',
        'How many times the mode\'s own size a screenshot is written at.'
      ),
      minimum: 1,
      maximum: 8,
    },
    videoUseDisplaySettings: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/videoUseDisplay/title',
        'Same Display Settings as Emulator',
      ),
      description: nls.localize(
        'vueport/preferences/videoUseDisplay/description',
        'Use the current emulator display settings for video recordings.'
      ),
    },
    videoRenderingMode: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/renderingMode/title',
        'Rendering Mode',
      ),
      description: nls.localize(
        'vueport/preferences/videoRenderingMode/description',
        'How a video recording presents the two eyes.'
      ),
      enum: Object.keys(emulationRenderingModes()),
      enumItemLabels: Object.values(emulationRenderingModes()),
      enumItemDescriptions: Object.values(emulationRenderingModeDescriptions()),
      enumItemNames: Object.values(emulationRenderingModeNames()),
    },
    videoFrameBlending: {
      type: 'string',
      title: nls.localize('vueport/preferences/frameBlending/title', 'Frame Blending'),
      description: nls.localize(
        'vueport/preferences/videoFrameBlending/description',
        'Mix recorded frames with the ones before them, the way the picture is shown with Frame Blending on.'
      ),
      ...frameBlendingChoices(),
    },
    videoScale: {
      type: 'integer',
      title: nls.localize(
        'vueport/preferences/videoScale/title',
        'Scale',
      ),
      description: nls.localize(
        'vueport/preferences/videoScale/description',
        'How many times the mode\'s own size a video is recorded at.'
      ),
      minimum: 1,
      maximum: 8,
    },
    videoQuality: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/videoQuality/title',
        'Quality',
      ),
      description: nls.localize(
        'vueport/preferences/videoQuality/description',
        'How many bits a second the recorded picture is given. The sound is unaffected.'
      ),
      enum: Object.keys(emulatorVideoQualityLabels()),
      enumItemLabels: Object.values(emulatorVideoQualityLabels()),
    },
    videoFormat: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/videoFormat/title',
        'File Format',
      ),
      description: nls.localize(
        'vueport/preferences/videoFormat/description',
        'Target file format for new video recordings. Available formats depend on OS/browser.'
      ),
      enum: Object.keys(emulatorVideoFormatLabels()),
      enumItemLabels: Object.values(emulatorVideoFormatLabels()),
    },
    sramInit: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/sramInit/title',
        'New Save File Contents'
      ),
      description: nls.localize(
        'vueport/preferences/sramInit/description',
        'What a save file is filled with before a game has written to it.'
      ),
      enum: Object.keys(emulatorSramInitLabels()),
      enumItemLabels: Object.values(emulatorSramInitLabels()),
    },
    sramWindow: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/sramWindow/title',
        'Cartridge Save Size'
      ),
      description: nls.localize(
        'vueport/preferences/sramWindow/description',
        'How much save RAM a cartridge answers on. Full is the whole of Game Pak RAM, '
        + 'which no game can run out of; a fixed size mirrors above itself the way real '
        + 'hardware does, which is what a game detecting its own save size would see. '
        + 'Save files are trimmed to what a game writes either way.'
      ),
      enum: Object.keys(emulatorSramWindowLabels()),
      enumItemLabels: Object.values(emulatorSramWindowLabels()),
    },
    saveGameSlot: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/saveGameSlot/title',
        'Save Game Slot'
      ),
      description: nls.localize(
        'vueport/preferences/saveGameSlot/description',
        'Which save file a game plays on. A slot represents a whole cartridge save.'
      ),
      enum: [...EMULATOR_SAVE_SLOTS],
      enumItemLabels: EMULATOR_SAVE_SLOTS.map(slot => nls.localize(
        'vueport/preferences/saveGameSlot/item', 'Slot {0}', slot)),
    },
    autoSaveStatesEnabled: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/autoSaveStatesEnabled/title',
        'Automatic Save States'
      ),
      description: nls.localize(
        'vueport/preferences/autoSaveStatesEnabled/description',
        'Take a save state every so often while a game runs, and keep the last few of them.'
      ),
    },
    autoSaveStateInterval: {
      type: 'integer',
      title: nls.localize(
        'vueport/preferences/autoSaveStateInterval/title',
        'Automatic Save State Interval'
      ),
      description: nls.localize(
        'vueport/preferences/autoSaveStateInterval/description',
        'Seconds of play between automatic save states. Time spent paused does not count.'
      ),
      minimum: 10,
      maximum: 900,
    },
    autoSaveStateCount: {
      type: 'integer',
      title: nls.localize(
        'vueport/preferences/autoSaveStateCount/title',
        'Automatic Save States Kept'
      ),
      description: nls.localize(
        'vueport/preferences/autoSaveStateCount/description',
        'How many automatic save states to keep per game.'
      ),
      minimum: 1,
      maximum: 20,
    },
    suspendResumeEnabled: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/suspendResumeEnabled/title',
        'Suspend and Resume'
      ),
      description: nls.localize(
        'vueport/preferences/suspendResumeEnabled/description',
        'Save the running game when you close it, or close VUEPort, and offer to pick it up where \
you left off the next time you open it.'
      ),
    },
    suspendResumeStart: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/suspendResumeStart/title',
        'Opening a Suspended Game'
      ),
      description: nls.localize(
        'vueport/preferences/suspendResumeStart/description',
        'How VUEPort should behave when opening a game that has a S&R state.'
      ),
      enum: Object.keys(emulatorResumeStartLabels()),
      enumItemLabels: Object.values(emulatorResumeStartLabels()),
    },
    companionFiles: {
      type: 'string',
      title: nls.localize(
        'vueport/preferences/companionFiles/title',
        'Storage Location'
      ),
      description: nls.localize(
        'vueport/preferences/companionFiles/description',
        'Where a ROM\'s companion files like saves, save states or cheats are written.'
      ),
      enum: Object.keys(emulatorCompanionLocationLabels()),
      enumItemLabels: Object.values(emulatorCompanionLocationLabels()),
    },
    player2SameControls: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/player2SameControls/title',
        'Player 2 Uses Player 1 Controls'
      ),
      description: nls.localize(
        'vueport/preferences/player2SameControls/description',
        'Whether the second emulator of a link session answers to the same keys as the first. \
Turn this off to map a separate set of keys for player 2.'
      ),
    },
    rewindEnabled: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/enableRewind/title',
        'Enable Rewind'
      ),
      description: nls.localize(
        'vueport/preferences/enableRewind/description',
        'Enable rewinding the emulator. Will cause a performance hit when playing.'
      ),
    },
    rewindGranularity: {
      type: 'number',
      title: nls.localize(
        'vueport/preferences/rewindGranularity/title',
        'Rewind Granularity'
      ),
      description: nls.localize(
        'vueport/preferences/rewindGranularity/description',
        'Frames per rewind step, which is also how far Shift moves in the filmstrip. Coarser steps make the '
        + 'same memory last longer, though far from proportionally: depending on the game, about 1.2 to 3 '
        + 'times as long at 4 and 1.7 to 7 times at 8.'
      ),
      // measured on real games (2 saved next to nothing, some games even need more memory per second at 2 than at 1),
      // so only the steps that buy something are offered
      enum: [1, 4, 8],
      minimum: 1,
      maximum: 8,
    },
    rewindBufferSize: {
      type: 'number',
      title: nls.localize(
        'vueport/preferences/rewindBufferSize/title',
        'Rewind Buffer Size'
      ),
      description: nls.localize(
        'vueport/preferences/rewindBufferSize/description',
        'Maximum memory in MB the rewind history may use. Only what changes between steps is stored, and how '
        + 'much that is depends heavily on the game: at a granularity of 1, 256 MB hold anywhere from about '
        + 'half a minute for games that change a lot every frame to more than half an hour, with many games '
        + 'between five and ten minutes.'
      ),
      // below 64 MB a busy game keeps only seconds; above 512 MB is more than a browser tab on a headset or phone
      // should be asked for
      multipleOf: 32,
      minimum: 64,
      maximum: 512,
    },
    slowMotionRatio: {
      type: 'number',
      title: nls.localize(
        'vueport/preferences/slowMotionRatio/title',
        'Slow Motion Ratio'
      ),
      description: nls.localize(
        'vueport/preferences/slowMotionRatio/description',
        'When using slow motion, content will slow down by this factor. High values might render the emulator unresponsive.'
      ),
      multipleOf: 0.5,
      minimum: 1.0,
      maximum: 32.0,
    },
    fastForwardRatio: {
      type: 'number',
      title: nls.localize(
        'vueport/preferences/fastForwardRatio/title',
        'Fast Forward Ratio'
      ),
      description: nls.localize(
        'vueport/preferences/fastForwardRatio/description',
        'The rate at which content will be run when using fast forward.'
      ),
      multipleOf: 0.5,
      minimum: 1.0,
      maximum: 32.0,
    },
    retroAchievementsEnabled: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/retroAchievementsEnabled/title',
        'RetroAchievements'
      ),
      description: nls.localize(
        'vueport/preferences/retroAchievementsEnabled/description',
        'Connect to RetroAchievements while playing, so a game that has an achievement set tracks \
your progress through it and unlocks achievements as you earn them. Needs an account, which is \
entered on the Achievements settings page.'
      ),
    },
    retroAchievementsHardcore: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/retroAchievementsHardcore/title',
        'RetroAchievements Hardcore Mode'
      ),
      description: nls.localize(
        'vueport/preferences/retroAchievementsHardcore/description',
        'Play for hardcore achievements: cheats, macros, patches, save-state loading, rewind and Debug mode \
are disabled while this is on. Turning it on restarts the ROM. Hardcore unlocks can not be credited \
until RetroAchievements approves the VUEPort client, but the restrictions apply now.'
      ),
    },
    errorSoundEnabled: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/errorSoundEnabled/title',
        'Error Sound'
      ),
      description: nls.localize(
        'vueport/preferences/errorSoundEnabled/description',
        'Play a short sound cue alongside an error notification.'
      ),
    },
    achievementSoundEnabled: {
      type: 'boolean',
      title: nls.localize(
        'vueport/preferences/achievementSoundEnabled/title',
        'Achievement Sound'
      ),
      description: nls.localize(
        'vueport/preferences/achievementSoundEnabled/description',
        'Play a short sound cue when an achievement is earned, alongside its toast.'
      ),
    },
  } as Record<keyof VueportConfig, VueportSettingSchema>;
}
