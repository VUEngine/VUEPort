import * as React from 'react';
import styled from 'styled-components';
import { FileX } from '@phosphor-icons/react';
import AdvancedSelect from '../components/kit/AdvancedSelect';
import HContainer from '../components/kit/HContainer';
import Input from '../components/kit/Input';
import RadioSelect from '../components/kit/RadioSelect';
import EmptyContainer from '../components/kit/EmptyContainer';
import { nls } from '../../common/emulator-nls';
import { VueportInputBindings, VueportSettings } from '../../common/emulator-settings';
import { EmulatorCommands } from '../emulator-commands';
import {
  emulationRenderingModes,
  emulatorScaleOptions,
  EmulatorAction,
  EmulatorMode,
  EmulatorRomStatus,
} from '../emulator-types';

/**
 * The emulator's controls: the transport buttons, the save-slot picker, the
 * display and palette selectors, and the play/debug switch.
 *
 * Split out of the widget because it is the widget's largest single piece and
 * has nothing to do with driving emulation — it only reads what the emulator is
 * doing and asks it to do something else.
 */

/** The parts of the emulator's state the toolbar shows. */
export interface EmulatorToolbarState {
  loaded: boolean;
  paused: boolean;
  muted: boolean;
  lowPower: boolean;
  slowmotion: boolean;
  fastForward: boolean;
  frameAdvance: boolean;
  showControls: boolean;
  showPalettes: boolean;
  showPreferences: boolean;
  saveSlot: number;
  saveStateExists: boolean;
  mode: EmulatorMode;
}

/**
 * What the toolbar needs from the emulator it sits above.
 *
 * An interface rather than the widget itself, because this component is bound
 * for vueport and the widget is not: anything that can answer these questions
 * and perform these actions can wear this toolbar. `VesEmulatorWidget`
 * satisfies it structurally, so there is nothing to adapt today.
 */
export interface EmulatorToolbarHost {
  readonly state: EmulatorToolbarState;
  readonly status: EmulatorRomStatus;
  /** True from the moment rewind is pressed until it is released. */
  readonly rewinding: boolean;
  /** True while a profile recording is being taken. */
  readonly profiling: boolean;
  /** Set when this emulator is half of a linked pair. */
  readonly linkedPeer?: unknown;
  isLinked(): boolean;
  isRewindEnabled(): boolean;
  getRenderingMode(): string;
  /** Name of the palette in use, built-in or custom. */
  getPaletteLabel(): string;
  /** The swatch shown on the palette button. */
  renderPalettePreview(): React.ReactNode;
  runAction(action: EmulatorAction): void;
  setMode(mode: EmulatorMode): void;
  setRenderingMode(mode: string): Promise<void>;
  setScale(scale: string): Promise<void>;
  togglePaletteWindow(): void;
  togglePreferencesWindow(): void;
  onRewindButtonDown(e: React.PointerEvent<HTMLButtonElement>): void;
  onRewindButtonUp(e: React.PointerEvent<HTMLButtonElement>): void;
  stopRewinding(): void;
  promptEnableRewind(): Promise<void>;
  runCommand(id: string): void;
  readonly settings: VueportSettings;
  readonly bindings: VueportInputBindings;
}

const EmulatorControls = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--theia-ui-padding);
  justify-content: space-between;
  padding: calc(var(--theia-ui-padding) * 2);
  row-gap: calc(var(--theia-ui-padding) * 2);
`;

const EmulatorControlsGroup = styled.div`
  display: flex;
  gap: calc(var(--theia-ui-padding) * 2);

  & button.theia-button {
    height: 26px;
    margin: 0 2px;
    min-width: 32px;
    vertical-align: middle;
  }

  & select.theia-select {
    margin: 0 2px;
    vertical-align: middle;
  }
`;

const SaveSlotInputWrapper = styled.div`
  position: relative;

  i {
    left: 7px;
    position: absolute;
    top: 7px;
    z-index: 1;
  }

  input {
    padding-left: 20px;
  }
`;

const PaletteButton = styled.button`
  border: 1px solid transparent;
  padding: 0;
`;

const SELECT_STYLE = { width: 'auto' };

export function renderEmulatorToolbar(host: EmulatorToolbarHost): React.ReactNode {
    const rewindEnabled = host.isRewindEnabled();
    return host.status === EmulatorRomStatus.NOT_EXISTS ? (
      <EmptyContainer
        title={nls.localize('vueport/romNotFound', 'ROM not found')}
        icon={<FileX size={32} />}
      />
    ) : (
      <>
        <EmulatorControls>
          <EmulatorControlsGroup>
            <div>
              <button
                className={
                  host.state.paused ? 'theia-button' : 'theia-button secondary'
                }
                title={`${host.state.paused
                  ? nls.localize('vueport/resume', 'Resume')
                  : nls.localize('vueport/pause', 'Pause')
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_PAUSE_TOGGLE.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.PauseToggle)
                }
                disabled={!host.state.loaded || host.state.showControls}
              >
                <i className="fa fa-pause"></i>
              </button>
              <button
                className="theia-button secondary"
                title={`${EmulatorCommands.INPUT_RESET.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_RESET.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.Reset)
                }
                disabled={!host.state.loaded || host.state.showControls}
              >
                <i className="fa fa-refresh"></i>
              </button>
              <button
                className="theia-button secondary"
                title={`${host.state.muted
                  ? nls.localize('vueport/unmute', 'Unmute')
                  : nls.localize('vueport/mute', 'Mute')
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_AUDIO_MUTE.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.AudioMute)
                }
                disabled={!host.state.loaded || host.state.showControls}
              >
                <i
                  className={
                    host.state.muted ? 'fa fa-volume-off' : 'fa fa-volume-up'
                  }
                ></i>
              </button>
              <button
                className={
                  host.state.lowPower
                    ? 'theia-button'
                    : 'theia-button secondary'
                }
                title={`${EmulatorCommands.INPUT_TOGGLE_LOW_POWER.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_TOGGLE_LOW_POWER.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.ToggleLowPower)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused
                }
              >
                <i
                  className={
                    host.state.lowPower
                      ? 'fa fa-battery-quarter'
                      : 'fa fa-battery-full'
                  }
                ></i>
              </button>
            </div>
            <div>
              <button
                // Greyed out rather than truly disabled when the feature is
                // off: the click is what offers to turn it on, and a disabled
                // button would never see one.
                className={
                  (host.rewinding ? 'theia-button' : 'theia-button secondary')
                  + (rewindEnabled ? '' : ' vueport-button-off')
                }
                title={`${EmulatorCommands.INPUT_REWIND.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_REWIND.id,
                    true,
                  )}${rewindEnabled ? '' : ` — ${nls.localize(
                    'vueport/rewindIsOff',
                    'off, click to enable'
                  )}`}`}
                onPointerDown={host.onRewindButtonDown}
                onPointerUp={host.onRewindButtonUp}
                onPointerCancel={host.onRewindButtonUp}
                onLostPointerCapture={() => host.stopRewinding()}
                onClick={e => {
                  if (!rewindEnabled) {
                    host.promptEnableRewind();
                  } else if (e.detail === 0) {
                    // Pointer presses rewind for as long as they are held, and
                    // have already stepped by the time the click arrives. A
                    // click with no pointer behind it is the button being
                    // activated from the keyboard: step back once.
                    host.runAction(EmulatorAction.Rewind);
                  }
                }}
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused
                }
              >
                <i className="fa fa-backward"></i>
              </button>
              <button
                className={
                  host.state.slowmotion
                    ? 'theia-button'
                    : 'theia-button secondary'
                }
                title={`${EmulatorCommands.INPUT_TOGGLE_SLOWMOTION.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_TOGGLE_SLOWMOTION.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.ToggleSlowmotion)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused
                }
              >
                <i className="fa fa-eject fa-rotate-90"></i>
              </button>
              <button
                className={
                  host.state.frameAdvance
                    ? 'theia-button'
                    : 'theia-button secondary'
                }
                title={`${EmulatorCommands.INPUT_FRAME_ADVANCE.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_FRAME_ADVANCE.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.FrameAdvance)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  (host.state.paused && !host.state.frameAdvance)
                }
              >
                <i className="fa fa-step-forward"></i>
              </button>

              <button
                className={
                  host.state.fastForward
                    ? 'theia-button'
                    : 'theia-button secondary'
                }
                title={`${EmulatorCommands.INPUT_TOGGLE_FAST_FORWARD.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_TOGGLE_FAST_FORWARD.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.ToggleFastForward)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused
                }
              >
                <i className="fa fa-forward"></i>
              </button>
            </div>
            <HContainer alignItems='center' gap={0}>
              <button
                className="theia-button secondary"
                title={`${EmulatorCommands.INPUT_SAVE_STATE.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_SAVE_STATE.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.SaveState)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused
                }
              >
                <i className='fa fa-save' />
              </button>
              <button
                className="theia-button secondary"
                title={`${EmulatorCommands.INPUT_LOAD_STATE.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_LOAD_STATE.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.LoadState)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused ||
                  !host.state.saveStateExists
                }
              >
                <i className="fa fa-level-down"></i>
              </button>
              <SaveSlotInputWrapper>
                <i className="fa fa-bookmark-o"></i>
                <Input
                  value={host.state.saveSlot}
                  type='number'
                  width={56}
                  min={1}
                  max={99}
                  title={nls.localize(
                    'vueport/currentSaveStateSlot',
                    'Current Save State Slot',
                  )}
                  disabled={
                    !host.state.loaded ||
                    host.state.showControls ||
                    host.state.paused
                  }
                />
              </SaveSlotInputWrapper>
            </HContainer>
            {/*
            <div>
              <button
                className="theia-button secondary"
                title={`${EmulatorCommands.INPUT_SAVE_STATE.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_SAVE_STATE.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.SaveState)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused
                }
              >
                <i className="fa fa-level-down"></i>{' '}
                <i className="fa fa-bookmark-o"></i>
              </button>
              <button
                className="theia-button secondary"
                title={`${EmulatorCommands.INPUT_LOAD_STATE.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_LOAD_STATE.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.LoadState)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused ||
                  !host.state.saveStateExists
                }
              >
                <i className="fa fa-bookmark-o"></i>{' '}
                <i className="fa fa-level-up"></i>
              </button>
              <button
                className="theia-button secondary"
                title={nls.localize(
                  'vueport/currentSaveState',
                  'Current Save State',
                )}
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused
                }
              >
                <i className="fa fa-bookmark-o"></i> {host.state.saveSlot}
              </button>
              <button
                className="theia-button secondary"
                title={`${EmulatorCommands.INPUT_STATE_SLOT_DECREASE.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_STATE_SLOT_DECREASE.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.StateSlotDecrease)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused ||
                  host.state.saveSlot <= 0
                }
              >
                <i className="fa fa-chevron-down"></i>
              </button>
              <button
                className="theia-button secondary"
                title={`${EmulatorCommands.INPUT_STATE_SLOT_INCREASE.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_STATE_SLOT_INCREASE.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.StateSlotIncrease)
                }
                disabled={
                  !host.state.loaded ||
                  host.state.showControls ||
                  host.state.paused
                }
              >
                <i className="fa fa-chevron-up"></i>
              </button>
            </div>
            */}
            <div>
              <button
                className={
                  host.isLinked() ? 'theia-button' : 'theia-button secondary'
                }
                title={
                  host.isLinked()
                    ? nls.localize('vueport/unlink', 'Unlink')
                    : host.linkedPeer
                      ? nls.localize('vueport/relink', 'Re-link')
                      : nls.localize(
                        'vueport/linkSecondPlayer',
                        'Link Second Player',
                      )
                }
                // Through the commands, so the button and the palette are the
                // same three operations; which one this is depends on how the
                // pair currently stands, exactly as the label above does.
                onClick={e =>
                  host.runCommand(
                    host.isLinked()
                      ? EmulatorCommands.UNLINK_PLAYERS.id
                      : host.linkedPeer
                        ? EmulatorCommands.RELINK_PLAYERS.id
                        : EmulatorCommands.LINK_SECOND_PLAYER.id
                  )
                }
                disabled={!host.state.loaded}
              >
                <i
                  className={
                    host.isLinked() ? 'ph ph-link-break' : 'ph ph-link-simple'
                  }
                ></i>
              </button>
            </div>
            <div>
              <button
                className={
                  host.profiling ? 'theia-button' : 'theia-button secondary'
                }
                title={`${host.profiling
                  ? EmulatorCommands.PROFILE_STOP.label
                  : EmulatorCommands.PROFILE_START.label
                  }${host.bindings.label(
                    host.profiling
                      ? EmulatorCommands.PROFILE_STOP.id
                      : EmulatorCommands.PROFILE_START.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runCommand(
                    host.profiling
                      ? EmulatorCommands.PROFILE_STOP.id
                      : EmulatorCommands.PROFILE_START.id
                  )
                }
                disabled={!host.state.loaded}
              >
                <i
                  className={host.profiling ? 'fa fa-stop' : 'fa fa-circle'}
                ></i>
              </button>
            </div>
          </EmulatorControlsGroup>
          <EmulatorControlsGroup>
            <div>
              <RadioSelect
                options={[
                  {
                    value: EmulatorMode.PLAY,
                    label: nls.localize('vueport/play', 'Play'),
                  },
                  {
                    value: EmulatorMode.DEBUG,
                    label: nls.localize('vueport/debug', 'Debug'),
                  },
                ]}
                defaultValue={host.state.mode}
                onChange={options =>
                  host.setMode(options[0].value as EmulatorMode)
                }
              />
            </div>
            <HContainer>
              <AdvancedSelect
                title={nls.localize('vueport/scale', 'Scale')}
                options={emulatorScaleOptions()}
                defaultValue={host.settings.get('scale')}
                onChange={option => host.setScale(option[0] as string)}
                disabled={!host.state.loaded || host.state.showControls}
                style={SELECT_STYLE}
              />
              <AdvancedSelect
                title={nls.localize(
                  'vueport/renderingMode',
                  'Rendering Mode',
                )}
                options={Object.entries(emulationRenderingModes()).map(([value, label]) => ({
                  value,
                  label,
                }))}
                defaultValue={host.getRenderingMode()}
                onChange={option => host.setRenderingMode(option[0] as string)}
                disabled={!host.state.loaded || host.state.showControls}
                style={SELECT_STYLE}
              />
              <PaletteButton
                className={
                  host.state.showPalettes
                    ? 'theia-button'
                    : 'theia-button secondary'
                }
                title={`${nls.localize('vueport/colors', 'Colors')}: ${host.getPaletteLabel()}`}
                onClick={() => host.togglePaletteWindow()}
                disabled={!host.state.loaded || host.state.showControls}
              >
                {host.renderPalettePreview()}
              </PaletteButton>
            </HContainer>
            <div>
              <button
                className="theia-button secondary"
                title={`${EmulatorCommands.INPUT_FULLSCREEN.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_FULLSCREEN.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.Fullscreen)
                }
                disabled={!host.state.loaded || host.state.showControls}
              >
                <i className="fa fa-arrows-alt"></i>
              </button>
              <button
                className="theia-button secondary"
                title={`${EmulatorCommands.INPUT_SCREENSHOT.label
                  }${host.bindings.label(
                    EmulatorCommands.INPUT_SCREENSHOT.id,
                    true,
                  )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.Screenshot)
                }
                disabled={!host.state.loaded || host.state.showControls}
              >
                <i className="fa fa-camera"></i>
              </button>
            </div>
            <div>
              <button
                className={
                  host.state.showControls
                    ? 'theia-button'
                    : 'theia-button secondary'
                }
                title={`${nls.localize(
                  'vueport/configureInput',
                  'Configure Input',
                )}${host.bindings.label(
                  EmulatorCommands.INPUT_TOGGLE_CONTROLS_OVERLAY.id,
                  true,
                )}`}
                onClick={e =>
                  host.runAction(EmulatorAction.ToggleControlsOverlay)
                }
                disabled={!host.state.loaded}
              >
                <i className="fa fa-keyboard-o"></i>
              </button>
              <button
                className={
                  host.state.showPreferences
                    ? 'theia-button'
                    : 'theia-button secondary'
                }
                title={nls.localize(
                  'vueport/emulatorSettings',
                  'Emulator Settings',
                )}
                onClick={() => host.togglePreferencesWindow()}
              >
                <i className="fa fa-sliders"></i>
              </button>
            </div>
          </EmulatorControlsGroup>
        </EmulatorControls>
      </>
    );
  }
