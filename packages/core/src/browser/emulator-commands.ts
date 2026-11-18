import { nls } from '../common/emulator-nls';
import { Command } from '../common/emulator-command';
import { EmulatorAction, EmulatorGamePadKeyCode } from './emulator-types';

// never true on purpose: the widget reads key presses itself to see releases too, while a mapping firing through
// the host's dispatcher would only deliver the press
export const EMULATOR_FOCUS_CONTEXT = 'emulatorFocus';

export namespace EmulatorCommands {

  export const INPUT_L_UP: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lUp',
      label: 'Left D-Pad ⇧',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/lUp',
    'vueport/input/gamePads/category'
  );

  export const INPUT_L_RIGHT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lRight',
      label: 'Left D-Pad ⇨',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/lRight',
    'vueport/input/gamePads/category'
  );

  export const INPUT_L_DOWN: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lDown',
      label: 'Left D-Pad ⇩',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/lDown',
    'vueport/input/gamePads/category'
  );

  export const INPUT_L_LEFT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lLeft',
      label: 'Left D-Pad ⇦',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/lLeft',
    'vueport/input/gamePads/category'
  );

  export const INPUT_START: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.start',
      label: 'Start',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/start',
    'vueport/input/gamePads/category'
  );

  export const INPUT_SELECT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.select',
      label: 'Select',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/select',
    'vueport/input/gamePads/category'
  );

  export const INPUT_L_TRIGGER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lTrigger',
      label: 'Left Trigger',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/lTrigger',
    'vueport/input/gamePads/category'
  );

  export const INPUT_R_UP: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rUp',
      label: 'Right D-Pad ⇧',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/rUp',
    'vueport/input/gamePads/category'
  );

  export const INPUT_R_RIGHT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rRight',
      label: 'Right D-Pad ⇨',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/rRight',
    'vueport/input/gamePads/category'
  );

  export const INPUT_R_DOWN: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rDown',
      label: 'Right D-Pad ⇩',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/rDown',
    'vueport/input/gamePads/category'
  );

  export const INPUT_R_LEFT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rLeft',
      label: 'Right D-Pad ⇦',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/rLeft',
    'vueport/input/gamePads/category'
  );

  export const INPUT_B: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.b',
      label: 'B',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/b',
    'vueport/input/gamePads/category'
  );

  export const INPUT_A: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.a',
      label: 'A',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/a',
    'vueport/input/gamePads/category'
  );

  export const INPUT_R_TRIGGER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rTrigger',
      label: 'Right Trigger',
      category: 'Emulator Game Pad',
    },
    'vueport/input/gamePads/commands/rTrigger',
    'vueport/input/gamePads/category'
  );

  export const INPUT_SAVE_STATE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.saveState',
      label: 'Save State',
      category: 'Emulator',
    },
    'vueport/commands/saveState',
    'vueport/commands/category'
  );

  // loads the newest state; there are no slots, picking an older one is done in the save state browser
  export const INPUT_LOAD_STATE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.loadState',
      label: 'Load Last State',
      category: 'Emulator',
    },
    'vueport/commands/loadState',
    'vueport/commands/category'
  );

  export const INPUT_TOGGLE_FAST_FORWARD: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.toggleFastForward',
      label: 'Toggle Fast Forward',
      category: 'Emulator',
    },
    'vueport/commands/toggle/fastForward',
    'vueport/commands/category'
  );

  export const INPUT_PAUSE_TOGGLE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.pauseToggle',
      label: 'Toggle Pause',
      category: 'Emulator',
    },
    'vueport/commands/toggle/pause',
    'vueport/commands/category'
  );

  export const INPUT_TOGGLE_SLOWMOTION: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.toggleSlowmotion',
      label: 'Toggle Slow Motion',
      category: 'Emulator',
    },
    'vueport/commands/toggle/slowMotion',
    'vueport/commands/category'
  );

  export const INPUT_TOGGLE_LOW_POWER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.toggleLowPower',
      label: 'Toggle Low Power Signal',
      category: 'Emulator',
    },
    'vueport/commands/toggle/lowPower',
    'vueport/commands/category'
  );

  export const INPUT_REWIND: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.rewind',
      label: 'Rewind',
      category: 'Emulator',
    },
    'vueport/commands/rewind',
    'vueport/commands/category'
  );

  export const INPUT_FRAME_ADVANCE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.frameAdvance',
      label: 'Frame Advance',
      category: 'Emulator',
    },
    'vueport/commands/frameAdvance',
    'vueport/commands/category'
  );

  export const INPUT_RESET: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.reset',
      label: 'Reset',
      category: 'Emulator',
    },
    'vueport/commands/reset',
    'vueport/commands/category'
  );

  export const INPUT_AUDIO_MUTE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.audioMute',
      label: 'Un/mute Audio',
      category: 'Emulator',
    },
    'vueport/commands/toggle/mute',
    'vueport/commands/category'
  );

  export const INPUT_FULLSCREEN: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.fullscreen',
      label: 'Fullscreen',
      category: 'Emulator',
    },
    'vueport/commands/fullscreen',
    'vueport/commands/category'
  );

  export const INPUT_TOGGLE_CONTROLS_OVERLAY: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.toggleControlsOverlay',
      label: 'Configure Input',
      category: 'Emulator',
    },
    'vueport/commands/configure/input',
    'vueport/commands/category'
  );

  export const INPUT_SCREENSHOT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.screenshot',
      label: 'Take Screenshot',
      category: 'Emulator',
    },
    'vueport/commands/takeScreenshot',
    'vueport/commands/category'
  );

  // one toggle rather than two commands (unlike profiling), as it is reached for by the same key while playing
  export const INPUT_VIDEO_RECORD: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.videoRecord',
      label: 'Record Video',
      category: 'Emulator',
    },
    'vueport/commands/recordVideo',
    'vueport/commands/category'
  );

  export const ADD_PANEL: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.panels.add',
      label: 'Add Panel...',
      category: 'Emulator',
      iconClass: 'codicon codicon-add',
    },
    'vueport/commands/addPanel',
    'vueport/commands/category'
  );

  export const RESET_LAYOUT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.panels.resetLayout',
      label: 'Reset Emulator Layout',
      category: 'Emulator',
      iconClass: 'codicon codicon-clear-all',
    },
    'vueport/commands/resetLayout',
    'vueport/commands/category'
  );

  // profiling as two commands rather than one toggle, and only the one that applies is offered, as an entry that
  // means opposite things at different times is worse than two that each say what they do
  export const PLAY_MOVIE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.movie.play',
      label: 'Play Input Movie…',
      category: 'Emulator',
    },
    'vueport/commands/movie/play',
    'vueport/commands/category'
  );

  export const STOP_MOVIE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.movie.stop',
      label: 'Stop Input Movie',
      category: 'Emulator',
    },
    'vueport/commands/movie/stop',
    'vueport/commands/category'
  );

  export const PROFILE_START: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.profile.start',
      label: 'Start Profiling',
      category: 'Emulator',
    },
    'vueport/commands/profile/start',
    'vueport/commands/category'
  );

  export const PROFILE_STOP: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.profile.stop',
      label: 'Stop Profiling and Export',
      category: 'Emulator',
    },
    'vueport/commands/profile/stop',
    'vueport/commands/category'
  );

  export const LINK_SECOND_PLAYER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.link.second',
      label: 'Link Second Player',
      category: 'Emulator',
    },
    'vueport/commands/link/secondPlayer',
    'vueport/commands/category'
  );

  export const UNLINK_PLAYERS: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.link.unlink',
      label: 'Unlink Players',
      category: 'Emulator',
    },
    'vueport/commands/link/unlink',
    'vueport/commands/category'
  );

  // this window runs both machines (see emulator-core-service.ts), so the inspectors can show the other player's
  // machine, and a poke aimed at it lands in both windows
  export const INSPECT_OTHER_PLAYER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.link.inspectOther',
      label: "Inspect the Other Player's Machine",
      category: 'Emulator',
    },
    'vueport/commands/link/inspectOtherPlayer',
    'vueport/commands/category'
  );

  export const INSPECT_OWN_PLAYER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.link.inspectOwn',
      label: 'Inspect This Player’s Machine',
      category: 'Emulator',
    },
    'vueport/commands/link/inspectOwnPlayer',
    'vueport/commands/category'
  );

  export const RELINK_PLAYERS: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.link.relink',
      label: 'Re-link Players',
      category: 'Emulator',
    },
    'vueport/commands/link/relink',
    'vueport/commands/category'
  );

  // not a panel, as the cheats aren't docked in either mode
  export const TOGGLE_CHEATS: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.cheats.toggle',
      label: 'Show Cheats',
      category: 'Emulator',
    },
    'vueport/commands/toggle/cheats',
    'vueport/commands/category'
  );

  export const TOGGLE_MACROS: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.macros.toggle',
      label: 'Show Macros',
      category: 'Emulator',
    },
    'vueport/commands/toggle/macros',
    'vueport/commands/category'
  );

  export const TOGGLE_PATCHES: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.patches.toggle',
      label: 'Show Patches',
      category: 'Emulator',
    },
    'vueport/commands/toggle/patches',
    'vueport/commands/category'
  );

  export const TOGGLE_SAVE_STATES: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.saveStates.toggle',
      label: 'Show Save States',
      category: 'Emulator',
    },
    'vueport/commands/toggle/saveStates',
    'vueport/commands/category'
  );

  // see TOGGLE_CHEATS. Only one of the five strips can be open at a time
  export const TOGGLE_ACHIEVEMENTS: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.achievements.toggle',
      label: 'Show Achievements',
      category: 'Emulator',
    },
    'vueport/commands/toggle/achievements',
    'vueport/commands/category'
  );

  export const TOGGLE_VBC_SUPPORT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.vbcSupport.toggle',
      label: 'Toggle VB Color Support',
      category: 'Emulator',
    },
    'vueport/commands/toggle/vbcSupport',
    'vueport/commands/category'
  );

  export const SET_HARDWARE_MODE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.hardwareMode',
      label: 'Set Hardware Mode',
      category: 'Emulator',
    },
    'vueport/commands/set/hardwareMode',
    'vueport/commands/category'
  );

  // the save file slot (see EMULATOR_SAVE_SLOTS), not a state. Called "Save Game" because "save slot" alone would
  // read like the save state slot next to it
  export const SET_SAVE_SLOT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.saveGameSlot',
      label: 'Select Save Game Slot',
      category: 'Emulator',
    },
    'vueport/commands/set/saveGameSlot',
    'vueport/commands/category'
  );

  export const TOGGLE_DEBUG_MODE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.mode.toggleDebug',
      label: 'Toggle Debug Mode',
      category: 'Emulator',
    },
    'vueport/commands/toggle/debugMode',
    'vueport/commands/category'
  );

  export const TOGGLE_COLOR_MODE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.mode.toggleColor',
      label: 'Toggle VB Color Editor',
      category: 'Emulator',
    },
    'vueport/commands/toggle/colorMode',
    'vueport/commands/category'
  );

  // the browser keeps cartridge RAM and save states in OPFS, out of the user's reach and gone with cleared site data,
  // so this lets progress be taken out and moved to another machine
  export const EXPORT_SAVE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.save.export',
      label: 'Export Save Data…',
      category: 'Emulator',
    },
    'vueport/commands/saveRam/export',
    'vueport/commands/category'
  );

  export const IMPORT_SAVE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.save.import',
      label: 'Import Save Data…',
      category: 'Emulator',
    },
    'vueport/commands/saveRam/import',
    'vueport/commands/category'
  );

  // the newest state only; each state in the save state browser has its own Export
  export const EXPORT_SAVE_STATE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.saveState.export',
      label: 'Export Latest Save State…',
      category: 'Emulator',
    },
    'vueport/commands/saveStates/export',
    'vueport/commands/category'
  );

  export const IMPORT_SAVE_STATE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.saveState.import',
      label: 'Import Save State…',
      category: 'Emulator',
    },
    'vueport/commands/saveStates/import',
    'vueport/commands/category'
  );

  // erases the save in the current slot and restarts. Deliberately palette-only (no key, no toolbar button), as it
  // throws away progress; the confirmation dialog is the rest of its safety. The id keeps saying SRAM though the label
  // does not, as hosts' key bindings and menus are written against it
  export const DELETE_SRAM: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.deleteSram',
      label: 'Delete Current Save Game Slot',
      category: 'Emulator',
    },
    'vueport/commands/saveRam/delete',
    'vueport/commands/category'
  );

};

export type EmulatorGamePadButton =
    'lUp' | 'lRight' | 'lDown' | 'lLeft' | 'rUp' | 'rRight' | 'rDown' | 'rLeft'
    | 'a' | 'b' | 'start' | 'select' | 'lTrigger' | 'rTrigger';

export interface EmulatorGamePadInput {
    key: EmulatorGamePadKeyCode;
    command: Command;
    player2: Command;
}

// a separate command rather than a modifier, as a keybinding belongs to exactly one command. Uses player one's
// label under a player 2 category
function player2Command(command: Command): Command {
    const player2: Command = { id: `${command.id}.player2` };
    // getters, as this runs at import before the host has installed its translations (see toLocalizedCommand);
    // going through player one's accessor also keeps the two labels in step
    Object.defineProperty(player2, 'label', {
        enumerable: true,
        get: () => command.label,
    });
    Object.defineProperty(player2, 'category', {
        enumerable: true,
        get: () => nls.localize(
            'vueport/input/gamePads/categoryPlayer2',
            'Emulator Game Pad (Player 2)'
        ),
    });
    return player2;
}

// in the order of the on-screen reference: top to bottom on the left half, then the right
export const EMULATOR_GAMEPAD_INPUTS: Record<EmulatorGamePadButton, EmulatorGamePadInput> = {
    lTrigger: input(EmulatorGamePadKeyCode.LT, EmulatorCommands.INPUT_L_TRIGGER),
    lUp: input(EmulatorGamePadKeyCode.LUp, EmulatorCommands.INPUT_L_UP),
    lRight: input(EmulatorGamePadKeyCode.LRight, EmulatorCommands.INPUT_L_RIGHT),
    lDown: input(EmulatorGamePadKeyCode.LDown, EmulatorCommands.INPUT_L_DOWN),
    lLeft: input(EmulatorGamePadKeyCode.LLeft, EmulatorCommands.INPUT_L_LEFT),
    select: input(EmulatorGamePadKeyCode.Select, EmulatorCommands.INPUT_SELECT),
    start: input(EmulatorGamePadKeyCode.Start, EmulatorCommands.INPUT_START),
    rTrigger: input(EmulatorGamePadKeyCode.RT, EmulatorCommands.INPUT_R_TRIGGER),
    rUp: input(EmulatorGamePadKeyCode.RUp, EmulatorCommands.INPUT_R_UP),
    rRight: input(EmulatorGamePadKeyCode.RRight, EmulatorCommands.INPUT_R_RIGHT),
    rDown: input(EmulatorGamePadKeyCode.RDown, EmulatorCommands.INPUT_R_DOWN),
    rLeft: input(EmulatorGamePadKeyCode.RLeft, EmulatorCommands.INPUT_R_LEFT),
    b: input(EmulatorGamePadKeyCode.B, EmulatorCommands.INPUT_B),
    a: input(EmulatorGamePadKeyCode.A, EmulatorCommands.INPUT_A),
};

function input(key: EmulatorGamePadKeyCode, command: Command): EmulatorGamePadInput {
    return { key, command, player2: player2Command(command) };
}

export const EMULATOR_GAMEPAD_BUTTONS = Object.keys(EMULATOR_GAMEPAD_INPUTS) as EmulatorGamePadButton[];

export function emulatorGamePadCommand(button: EmulatorGamePadButton, player: number): Command {
    const gamePadInput = EMULATOR_GAMEPAD_INPUTS[button];
    return player === 2 ? gamePadInput.player2 : gamePadInput.command;
}

// every button can be on turbo, even directions or Start (e.g. a menu that scrolls one entry per press).
// Ordered as in the input settings
export const EMULATOR_TURBO_BUTTONS: readonly EmulatorGamePadButton[] = [
    'lUp', 'lDown', 'lLeft', 'lRight',
    'rUp', 'rDown', 'rLeft', 'rRight',
    'select', 'start', 'b', 'a',
    'lTrigger', 'rTrigger',
];

// holding its keys presses the button at the turbo rate. Own command with lazy label and category for the same
// reasons as player2Command. Unbound by default
function turboCommand(command: Command, player: 1 | 2): Command {
    const turbo: Command = { id: `${command.id}.turbo${player === 2 ? '.player2' : ''}` };
    Object.defineProperty(turbo, 'label', {
        enumerable: true,
        get: () => nls.localize('vueport/input/turbo/commandLabel', '{0} (Turbo)', command.label ?? ''),
    });
    Object.defineProperty(turbo, 'category', {
        enumerable: true,
        get: () => player === 2
            ? nls.localize('vueport/input/turbo/categoryPlayer2', 'Emulator Game Pad Turbo (Player 2)')
            : nls.localize('vueport/input/turbo/category', 'Emulator Game Pad Turbo'),
    });
    return turbo;
}

const EMULATOR_TURBO_COMMANDS = Object.fromEntries(EMULATOR_TURBO_BUTTONS.map(button => [button, {
    command: turboCommand(EMULATOR_GAMEPAD_INPUTS[button].command, 1),
    player2: turboCommand(EMULATOR_GAMEPAD_INPUTS[button].command, 2),
}])) as Record<EmulatorGamePadButton, { command: Command, player2: Command }>;

export function emulatorTurboCommand(button: EmulatorGamePadButton, player: number): Command {
    const commands = EMULATOR_TURBO_COMMANDS[button];
    return player === 2 ? commands.player2 : commands.command;
}

export const EMULATOR_MACRO_SLOT_COUNT = 8;

export const EMULATOR_MACRO_SLOTS: readonly number[] =
    Array.from({ length: EMULATOR_MACRO_SLOT_COUNT }, (unused, index) => index + 1);

function macroSlotCommand(slot: number): Command {
    const command: Command = { id: `emulator.macro.slot${slot}` };
    Object.defineProperty(command, 'label', {
        enumerable: true,
        get: () => nls.localize('vueport/macros/slotCommand', 'Play Macro {0}', slot),
    });
    Object.defineProperty(command, 'category', {
        enumerable: true,
        get: () => nls.localize('vueport/commands/category', 'Emulator'),
    });
    return command;
}

// indexed by slot number minus one. Unbound by default; player one only, as a macro plays into the user's own machine
export const EMULATOR_MACRO_SLOT_COMMANDS: readonly Command[] = EMULATOR_MACRO_SLOTS.map(macroSlotCommand);

// toolbar, palette and keys all act on a running emulator through these, though key mappings still reach the widget
// directly (see EMULATOR_FOCUS_CONTEXT). The default keys are in registerKeybindings
export const EMULATOR_ACTION_COMMANDS: Record<EmulatorAction, Command> = {
    [EmulatorAction.PauseToggle]: EmulatorCommands.INPUT_PAUSE_TOGGLE,
    [EmulatorAction.Reset]: EmulatorCommands.INPUT_RESET,
    [EmulatorAction.AudioMute]: EmulatorCommands.INPUT_AUDIO_MUTE,
    [EmulatorAction.ToggleLowPower]: EmulatorCommands.INPUT_TOGGLE_LOW_POWER,
    [EmulatorAction.ToggleFastForward]: EmulatorCommands.INPUT_TOGGLE_FAST_FORWARD,
    [EmulatorAction.ToggleSlowmotion]: EmulatorCommands.INPUT_TOGGLE_SLOWMOTION,
    [EmulatorAction.FrameAdvance]: EmulatorCommands.INPUT_FRAME_ADVANCE,
    [EmulatorAction.Rewind]: EmulatorCommands.INPUT_REWIND,
    [EmulatorAction.SaveState]: EmulatorCommands.INPUT_SAVE_STATE,
    [EmulatorAction.LoadState]: EmulatorCommands.INPUT_LOAD_STATE,
    [EmulatorAction.Fullscreen]: EmulatorCommands.INPUT_FULLSCREEN,
    [EmulatorAction.ToggleControlsOverlay]: EmulatorCommands.INPUT_TOGGLE_CONTROLS_OVERLAY,
    [EmulatorAction.Screenshot]: EmulatorCommands.INPUT_SCREENSHOT,
    [EmulatorAction.VideoRecord]: EmulatorCommands.INPUT_VIDEO_RECORD,
};

export const EMULATOR_ACTIONS = Object.keys(EMULATOR_ACTION_COMMANDS) as EmulatorAction[];

// shared by both hosts so they ask in the same words. Built on call, as the host installs its translations during
// start-up
export function resetLayoutConfirmation(): {
  title: string,
  message: string,
  okLabel: string,
} {
  return {
    title: nls.localize('vueport/layout/reset/title', 'Reset Layout?'),
    message: nls.localize(
      'vueport/layout/reset/message',
      'The panels go back to their default arrangement. '
      + 'Any panels you have opened, moved or resized are lost.'
    ),
    okLabel: nls.localize('vueport/layout/reset/confirm', 'Reset'),
  };
}
