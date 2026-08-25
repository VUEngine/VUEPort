import { nls } from '../common/emulator-nls';
import { Command } from '../common/emulator-command';
import { EmulatorAction, EmulatorGamePadKeyCode } from './emulator-types';

/**
 * The `when` clause every emulator input mapping is scoped to.
 *
 * Deliberately never true — the widget reads key presses itself so that it can
 * see releases as well, and a mapping that actually fired through the host's
 * dispatcher would only give it the press.
 */
export const EMULATOR_FOCUS_CONTEXT = 'emulatorFocus';

export namespace EmulatorCommands {

  export const INPUT_L_UP: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lUp',
      label: 'Left D-Pad ⇧',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/lUpCommand',
    'vueport/controller/category'
  );

  export const INPUT_L_RIGHT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lRight',
      label: 'Left D-Pad ⇨',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/lRightCommand',
    'vueport/controller/category'
  );

  export const INPUT_L_DOWN: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lDown',
      label: 'Left D-Pad ⇩',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/lDownCommand',
    'vueport/controller/category'
  );

  export const INPUT_L_LEFT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lLeft',
      label: 'Left D-Pad ⇦',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/lLeftCommand',
    'vueport/controller/category'
  );

  export const INPUT_START: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.start',
      label: 'Start',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/startCommand',
    'vueport/controller/category'
  );

  export const INPUT_SELECT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.select',
      label: 'Select',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/selectCommand',
    'vueport/controller/category'
  );

  export const INPUT_L_TRIGGER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.lTrigger',
      label: 'Left Trigger',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/lTriggerCommand',
    'vueport/controller/category'
  );

  export const INPUT_R_UP: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rUp',
      label: 'Right D-Pad ⇧',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/rUpCommand',
    'vueport/controller/category'
  );

  export const INPUT_R_RIGHT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rRight',
      label: 'Right D-Pad ⇨',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/rRightCommand',
    'vueport/controller/category'
  );

  export const INPUT_R_DOWN: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rDown',
      label: 'Right D-Pad ⇩',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/rDownCommand',
    'vueport/controller/category'
  );

  export const INPUT_R_LEFT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rLeft',
      label: 'Right D-Pad ⇦',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/rLeftCommand',
    'vueport/controller/category'
  );

  export const INPUT_B: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.b',
      label: 'B',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/bCommand',
    'vueport/controller/category'
  );

  export const INPUT_A: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.a',
      label: 'A',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/aCommand',
    'vueport/controller/category'
  );

  export const INPUT_R_TRIGGER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.controller.rTrigger',
      label: 'Right Trigger',
      category: 'Emulator Game Pad',
    },
    'vueport/controller/rTriggerCommand',
    'vueport/controller/category'
  );

  export const INPUT_SAVE_STATE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.saveState',
      label: 'Save State',
      category: 'Emulator',
    },
    'vueport/input/saveStateCommand',
    'vueport/commands/category'
  );

  export const INPUT_LOAD_STATE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.loadState',
      label: 'Load State',
      category: 'Emulator',
    },
    'vueport/input/loadStateCommand',
    'vueport/commands/category'
  );

  export const INPUT_STATE_SLOT_DECREASE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.stateSlotDecrease',
      label: 'Decrease Save State Slot',
      category: 'Emulator',
    },
    'vueport/input/stateSlotDecreaseCommand',
    'vueport/commands/category'
  );

  export const INPUT_STATE_SLOT_INCREASE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.stateSlotIncrease',
      label: 'Increase Save State Slot',
      category: 'Emulator',
    },
    'vueport/input/stateSlotIncreaseCommand',
    'vueport/commands/category'
  );

  export const INPUT_TOGGLE_FAST_FORWARD: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.toggleFastForward',
      label: 'Toggle Fast Forward',
      category: 'Emulator',
    },
    'vueport/input/toggleFastForwardCommand',
    'vueport/commands/category'
  );

  export const INPUT_PAUSE_TOGGLE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.pauseToggle',
      label: 'Toggle Pause',
      category: 'Emulator',
    },
    'vueport/input/pauseToggleCommand',
    'vueport/commands/category'
  );

  export const INPUT_TOGGLE_SLOWMOTION: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.toggleSlowmotion',
      label: 'Toggle Slow Motion',
      category: 'Emulator',
    },
    'vueport/input/toggleSlowmotionCommand',
    'vueport/commands/category'
  );

  export const INPUT_TOGGLE_LOW_POWER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.toggleLowPower',
      label: 'Toggle Low Power Signal',
      category: 'Emulator',
    },
    'vueport/input/toggleLowPower',
    'vueport/commands/category'
  );

  export const INPUT_REWIND: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.rewind',
      label: 'Rewind',
      category: 'Emulator',
    },
    'vueport/input/rewindCommand',
    'vueport/commands/category'
  );

  export const INPUT_FRAME_ADVANCE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.frameAdvance',
      label: 'Frame Advance',
      category: 'Emulator',
    },
    'vueport/input/frameAdvanceCommand',
    'vueport/commands/category'
  );

  export const INPUT_RESET: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.reset',
      label: 'Reset',
      category: 'Emulator',
    },
    'vueport/input/resetCommand',
    'vueport/commands/category'
  );

  export const INPUT_AUDIO_MUTE: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.audioMute',
      label: 'Audio Mute',
      category: 'Emulator',
    },
    'vueport/input/audioMuteCommand',
    'vueport/commands/category'
  );

  export const INPUT_FULLSCREEN: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.fullscreen',
      label: 'Fullscreen',
      category: 'Emulator',
    },
    'vueport/input/fullscreenCommand',
    'vueport/commands/category'
  );

  export const INPUT_TOGGLE_CONTROLS_OVERLAY: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.toggleControlsOverlay',
      label: 'Toggle Controls Overlay',
      category: 'Emulator',
    },
    'vueport/input/toggleControlsOverlayCommand',
    'vueport/commands/category'
  );

  export const INPUT_SCREENSHOT: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.input.screenshot',
      label: 'Take Screenshot',
      category: 'Emulator',
    },
    'vueport/input/screenshotCommand',
    'vueport/commands/category'
  );

  export const ADD_PANEL: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.panels.add',
      label: 'Add Emulator Panel...',
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

  /**
   * Profiling, as two commands rather than one toggle.
   *
   * Which of the two applies is decided by whether a recording is running, and
   * only that one is offered — a palette entry meaning opposite things at
   * different times is worse than two that each say what they do.
   */
  export const PROFILE_START: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.profile.start',
      label: 'Start Profiling',
      category: 'Emulator',
    },
    'vueport/commands/profileStart',
    'vueport/commands/category'
  );

  export const PROFILE_STOP: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.profile.stop',
      label: 'Stop Profiling and Export',
      category: 'Emulator',
    },
    'vueport/commands/profileStop',
    'vueport/commands/category'
  );

  export const LINK_SECOND_PLAYER: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.link.second',
      label: 'Link Second Player',
      category: 'Emulator',
    },
    'vueport/commands/linkSecondPlayer',
    'vueport/commands/category'
  );

  export const UNLINK_PLAYERS: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.link.unlink',
      label: 'Unlink Players',
      category: 'Emulator',
    },
    'vueport/commands/unlinkPlayers',
    'vueport/commands/category'
  );

  export const RELINK_PLAYERS: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.link.relink',
      label: 'Re-link Players',
      category: 'Emulator',
    },
    'vueport/commands/relinkPlayers',
    'vueport/commands/category'
  );

  /**
   * Not one of the action commands: it has no key mapping and no toolbar
   * button, because it throws away saved progress and wants to be reached
   * deliberately rather than by a stray click. The palette is the whole of its
   * surface; the confirmation dialog is the rest of its safety.
   */
  export const DELETE_SRAM: Command = Command.toLocalizedCommand(
    {
      id: 'emulator.deleteSram',
      label: 'Delete SRAM and Restart',
      category: 'Emulator',
    },
    'vueport/commands/deleteSram',
    'vueport/commands/category'
  );

};

/**
 * The controller's own buttons, as the emulator's state and its on-screen
 * reference both name them.
 */
export type EmulatorGamePadButton =
    'lUp' | 'lRight' | 'lDown' | 'lLeft' | 'rUp' | 'rRight' | 'rDown' | 'rLeft'
    | 'a' | 'b' | 'start' | 'select' | 'lTrigger' | 'rTrigger';

export interface EmulatorGamePadInput {
    /** What the emulator presses when one of the mapped keys is. */
    key: EmulatorGamePadKeyCode;
    /** The command the mapping hangs off, per player. */
    command: Command;
    player2: Command;
}

/**
 * The second player's copy of a game pad command.
 *
 * A separate command rather than a modifier on the first player's, because a
 * mapping *is* a keybinding and a keybinding belongs to exactly one command —
 * so two sets of keys means two sets of commands. They carry the first
 * player's labels, which already say which button they are, under a category
 * that says which player.
 */
function player2Command(command: Command): Command {
    const player2: Command = { id: `${command.id}.player2` };
    // Both read on access, for the reason `toLocalizedCommand` explains: this
    // runs while the module is being imported, long before the host has
    // installed its translations. Reading player one's label through its own
    // accessor is also what keeps the two in step.
    Object.defineProperty(player2, 'label', {
        enumerable: true,
        get: () => command.label,
    });
    Object.defineProperty(player2, 'category', {
        enumerable: true,
        get: () => nls.localize(
            'vueport/controller/categoryPlayer2',
            'Emulator Game Pad (Player 2)'
        ),
    });
    return player2;
}

/**
 * Every game pad button, with the commands that carry its key mappings.
 *
 * The order is the one the on-screen reference reads in, top to bottom of the
 * left half and then the right.
 */
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

/** The command a button's mapping hangs off, for one player. */
export function emulatorGamePadCommand(button: EmulatorGamePadButton, player: number): Command {
    const gamePadInput = EMULATOR_GAMEPAD_INPUTS[button];
    return player === 2 ? gamePadInput.player2 : gamePadInput.command;
}

/**
 * The emulator's actions, and the commands they are invoked through.
 *
 * Everything that acts on a running emulator goes through one of these,
 * whether it came from the toolbar, the command palette, or a key. The key
 * mappings still reach the widget directly rather than through Theia's
 * dispatcher — see `EMULATOR_FOCUS_CONTEXT`, which is deliberately never true
 * so that the widget can see key releases as well as presses — but they now
 * end up in the same place everything else does.
 *
 * Keyed by the action, which is the emulator's own name for what it does; the
 * keys it answers to are whatever the keybinding registry says, and the
 * defaults for those live in `registerKeybindings`.
 */
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
    [EmulatorAction.StateSlotDecrease]: EmulatorCommands.INPUT_STATE_SLOT_DECREASE,
    [EmulatorAction.StateSlotIncrease]: EmulatorCommands.INPUT_STATE_SLOT_INCREASE,
    [EmulatorAction.Fullscreen]: EmulatorCommands.INPUT_FULLSCREEN,
    [EmulatorAction.ToggleControlsOverlay]: EmulatorCommands.INPUT_TOGGLE_CONTROLS_OVERLAY,
    [EmulatorAction.Screenshot]: EmulatorCommands.INPUT_SCREENSHOT,
};

export const EMULATOR_ACTIONS = Object.keys(EMULATOR_ACTION_COMMANDS) as EmulatorAction[];
