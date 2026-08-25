import { nls } from '../common/emulator-nls';
import { VueportConfig } from '../common/emulator-settings';
import { VB_LEVELS } from '../common/vb-constants';
import { EmulatorScale, emulationRenderingModes, emulatorSramInitLabels } from './emulator-types';

/**
 * How each setting should be presented, for a host that builds a settings
 * screen from this rather than listing the controls by hand.
 *
 * Plain JSON Schema, which is what both hosts want: Theia's preference schema
 * takes it almost as-is (see `VesEmulatorPreferenceSchema`), and a standalone
 * settings window can switch on `type`.
 *
 * Here rather than in `common/` because the enum labels come from the display
 * tables, which are browser-side. The contract itself — `VueportConfig`, the
 * defaults, the ranges — has no such dependency and stays in `common/`.
 */
export interface VueportSettingSchema {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
    title: string;
    description?: string;
    enum?: string[];
    enumItemLabels?: string[];
    items?: unknown;
    multipleOf?: number;
    minimum?: number;
    maximum?: number;
}

let schema: Record<keyof VueportConfig, VueportSettingSchema> | undefined;

/**
 * The emulator's settings, described.
 *
 * Built on first use rather than at import, because the titles are localized
 * and the host installs its localization during start-up. Carries no default,
 * scope or preference id: what a setting *is* belongs here, where a host keeps
 * it belongs to the host — see `VUEPORT_DEFAULTS` and `VUEPORT_PREFERENCE_IDS`.
 */
export function vueportSettingsSchema(): Record<keyof VueportConfig, VueportSettingSchema> {
    return schema ??= {
        renderingMode: {
            type: 'string',
            title: nls.localize(
        'vueport/preferences/builtInRenderingModeTitle',
        'Rendering Mode',
      ),
            description: nls.localize(
        'vueport/preferences/builtInRenderingModeDescription',
        'How the built-in emulator presents the two eyes. The colors each mode is shown in are configured separately.'
      ),
            enum: Object.keys(emulationRenderingModes()),
            enumItemLabels: Object.values(emulationRenderingModes()),
        },
        palette: {
            type: 'string',
            title: nls.localize(
        'vueport/preferences/builtInPaletteTitle',
        'Color Palette',
      ),
            description: nls.localize(
        'vueport/preferences/builtInPaletteDescription',
        'Colors the built-in emulator shows the four display brightness levels in, in every rendering mode but Anaglyph. '
        + 'Can be one of the built-in palettes or, as "custom:<name>", one defined in Custom Color Palettes.'
      ),
        },
        anaglyphPalette: {
            type: 'string',
            title: nls.localize(
        'vueport/preferences/builtInAnaglyphPaletteTitle',
        'Anaglyph Colors',
      ),
            description: nls.localize(
        'vueport/preferences/builtInAnaglyphPaletteDescription',
        'Tints the built-in emulator assigns to the eyes in the Anaglyph rendering mode. Pick the pair your glasses filter. '
        + 'Can be one of the built-in pairs or, as "custom:<name>", one defined in Custom Anaglyph Colors.'
      ),
        },
        customPalettes: {
            type: 'array',
            title: nls.localize(
        'vueport/preferences/builtInCustomPalettesTitle',
        'Custom Color Palettes'
      ),
            description: nls.localize(
        'vueport/preferences/builtInCustomPalettesDescription',
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
        'vueport/preferences/builtInCustomAnaglyphPalettesTitle',
        'Custom Anaglyph Colors'
      ),
            description: nls.localize(
        'vueport/preferences/builtInCustomAnaglyphPalettesDescription',
        'User-defined anaglyph tint pairs, offered alongside the built-in ones.'
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
        },
      },
        },
        scale: {
            type: 'string',
            title: nls.localize(
        'vueport/preferences/builtInScalingModeTitle',
        'Scale'
      ),
            description: nls.localize(
        'vueport/preferences/builtInScalingModeDescription',
        'Scaling mode of built-in emulator.'
      ),
            enum: Object.keys(EmulatorScale),
            enumItemLabels: Object.values(EmulatorScale),
        },
        sramInit: {
            type: 'string',
            title: nls.localize(
        'vueport/preferences/sramInitTitle',
        'New Save File Contents'
      ),
            description: nls.localize(
        'vueport/preferences/sramInitDescription',
        'What a save file is filled with before a game has written to it. A real cartridge powers up \
holding whatever its memory settled on, which is why random is the default and what hardware \
does. All zeroes is not a blank slate but one particular pattern, which a game may read as a \
valid save. Choose zeroes when debugging save handling and a reproducible starting point \
matters more than realism. Only affects newly created save files.'
      ),
            enum: Object.keys(emulatorSramInitLabels()),
            enumItemLabels: Object.values(emulatorSramInitLabels()),
        },
        player2SameControls: {
            type: 'boolean',
            title: nls.localize(
        'vueport/preferences/player2SameControlsTitle',
        'Player 2 Uses Player 1 Controls'
      ),
            description: nls.localize(
        'vueport/preferences/player2SameControlsDescription',
        "Whether the second emulator of a link session answers to the same keys as the first. \
Turn this off to map a separate set of keys for player 2, \
in the emulator's Configure Input window."
      ),
        },
        rewindEnabled: {
            type: 'boolean',
            title: nls.localize(
        'vueport/preferences/builtInEnableRewindTitle',
        'Enable Rewind'
      ),
            description: nls.localize(
        'vueport/preferences/builtInEnableRewindDescription',
        'Enable rewinding. Will cause a performance hit when playing.'
      ),
        },
        rewindGranularity: {
            type: 'number',
            title: nls.localize(
        'vueport/preferences/builtInRewindGranularityTitle',
        'Rewind Granularity'
      ),
            description: nls.localize(
        'vueport/preferences/builtInRewindGranularityDescription',
        'Defines how many frames per step the rewind function should go back at a time. '
        + 'Higher values cover more time with the same amount of memory, at a coarser resolution.'
      ),
            multipleOf: 1,
            minimum: 1,
            maximum: 32,
        },
        rewindBufferSize: {
            type: 'number',
            title: nls.localize(
        'vueport/preferences/builtInRewindBufferSizeTitle',
        'Rewind Buffer Size'
      ),
            description: nls.localize(
        'vueport/preferences/builtInRewindBufferSizeDescription',
        'Maximum memory in MB the rewind history may use. Only what changes between steps is '
        + 'stored, which measures at around 16 KB per step, so the default holds roughly 80 '
        + 'seconds at a granularity of 1 and proportionally longer above that.'
      ),
            multipleOf: 1,
            minimum: 8,
            maximum: 1024,
        },
        slowMotionRatio: {
            type: 'number',
            title: nls.localize(
        'vueport/preferences/builtInSlowMotionRatioTitle',
        'Slow Motion Ratio'
      ),
            description: nls.localize(
        'vueport/preferences/builtInSlowMotionRatioDescription',
        'When using slowmotion, content will slow down by this factor. High values might render the emulator unresponsive. Keep key pressed to exit slow motion.'
      ),
            multipleOf: 0.5,
            minimum: 1.0,
            maximum: 32.0,
        },
        fastForwardRatio: {
            type: 'number',
            title: nls.localize(
        'vueport/preferences/builtInFastForwardRatioTitle',
        'Fast Forward Ratio'
      ),
            description: nls.localize(
        'vueport/preferences/builtInFastForwardRatioDescription',
        'The rate at which content will be run when using fast forward. (E.g. 5.0 means 50 Hz * 5.0 = 250 fps).'
      ),
            multipleOf: 0.5,
            minimum: 1,
            maximum: 32,
        },    } as Record<keyof VueportConfig, VueportSettingSchema>;
}
