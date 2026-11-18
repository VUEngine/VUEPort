import { VueportConfig } from '../../../common/emulator-settings';

// what each settings pane shows and filters, so a query that lights a tab always leaves it with something.
// Kept apart from the panes so the tab rail can build its search index without dragging every pane's code
// (palette editor, color picker) into its chunk

export const DECORATION_SETTINGS: readonly (keyof VueportConfig)[] = [
    'decoration', 'decorationIntensity', 'decorationColor',
];

export const DISPLAY_SETTINGS: readonly (keyof VueportConfig)[] = [
    'renderingMode', 'swapEyes', 'stereoDepth', 'scale', 'frameBlending', ...DECORATION_SETTINGS, 'columnTable', 'mirrorSpinUp', 'mirrorSpinUpDelay',
];

export const SCREENSHOT_SETTINGS: readonly (keyof VueportConfig)[] = [
    'screenshotScale', 'screenshotUseDisplaySettings', 'screenshotRenderingMode', 'screenshotFrameBlending',
];

export const RECORDING_SETTINGS: readonly (keyof VueportConfig)[] = [
    'videoQuality', 'videoFormat', 'videoScale',
];

export const VIDEO_SETTINGS: readonly (keyof VueportConfig)[] = [
    ...RECORDING_SETTINGS, 'videoUseDisplaySettings', 'videoRenderingMode', 'videoFrameBlending',
];

export const REWIND_SETTINGS: readonly (keyof VueportConfig)[] = [
    'rewindEnabled', 'rewindGranularity', 'rewindBufferSize',
];

export const SPEED_SETTINGS: readonly (keyof VueportConfig)[] = [
    'fastForwardRatio', 'slowMotionRatio',
];

export const EMULATION_SETTINGS: readonly (keyof VueportConfig)[] = [
    ...REWIND_SETTINGS, ...SPEED_SETTINGS,
];

export const SAVE_STATE_SETTINGS: readonly (keyof VueportConfig)[] = [
    'autoSaveStatesEnabled', 'autoSaveStateInterval', 'autoSaveStateCount',
    'suspendResumeEnabled', 'suspendResumeStart',
];

export const SAVE_DATA_SETTINGS: readonly (keyof VueportConfig)[] = [
    'saveGameSlot', 'sramInit', 'sramWindow',
];

export const FILE_SETTINGS: readonly (keyof VueportConfig)[] = [
    'companionFiles',
];

export const VB_COLOR_SETTINGS: readonly (keyof VueportConfig)[] = [
    'vbcSupportEnabled', 'hardwareMode', 'vbcAutoApplyColorPatches',
];

export const SOUND_SETTINGS: readonly (keyof VueportConfig)[] = [
    'errorSoundEnabled', 'achievementSoundEnabled',
];

// the layout is changed in its editor, but Reset All covers it too
export const TOUCH_SETTINGS: readonly (keyof VueportConfig)[] = [
    'touchControls', 'touchControlsOpacity', 'touchControlsSize',
    'touchControlsDiagonals', 'touchControlsSlide', 'touchControlsVibration', 'touchControlsHighlight',
    'touchControlsRumble',
];
