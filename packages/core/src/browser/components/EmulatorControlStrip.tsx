import {
  ArrowCounterClockwise,
  BatteryFull,
  BatteryLow,
  Camera,
  ClockClockwise,
  FastForward,
  FileArrowUp,
  FloppyDisk,
  ListDashes,
  Pause,
  PushPin,
  Rewind,
  SkipForward,
  SpeakerSimpleHigh,
  SpeakerSimpleSlash,
  VideoCamera
} from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { EmulatorCommands } from '../emulator-commands';
import { EmulatorAction } from '../emulator-types';
import { EmulatorToolbarControl, EmulatorToolbarHost } from './EmulatorToolbar';
import { DEFAULT_KIT_SERVICES } from './kit/KitContext';

/**
 * The transport as a strip floating over the picture, with the same controls and host interface as EmulatorToolbar;
 * Emulator's chrome prop chooses between them. Workbench hosts like the studio want the toolbar, the standalone app
 * this strip, as there the picture is the product. Scale, rendering mode, palette, Play/Debug and link are settings, so
 * they live in the settings window and title bar. The strip has no state of its own: EmulatorStateBadges shows what is
 * switched on, as the strip is not always on screen.
 */
export interface EmulatorControlStripProps {
  host: EmulatorToolbarHost;
  pinned?: boolean;
  // left out for a strip the host placed itself (the studio's title bar), which never hides; then there is no pin
  // button
  onTogglePinned?(): void;
  // the same controls, but not a layer: no rounded slab, no shadow, and it takes the height of the host's row
  inline?: boolean;
}

function hostControls(
  controls: EmulatorToolbarControl[] | undefined,
  tooltip: (content: string) => object,
): React.ReactNode {
  return controls?.length
    ? controls.map(control =>
      <button
        key={control.id}
        data-control={control.id}
        className={'vp-strip-button vp-toolbar-host-control'
          + (control.active ? ' vp-strip-button-on' : '')}
        {...tooltip(control.label)}
        onClick={() => control.run()}
        disabled={control.disabled}
      >
        {control.icon}
      </button>
    )
    : undefined;
}

// the transport as a strip floating over the picture, same controls and host interface as EmulatorToolbar, picked by
// Emulator's chrome prop (the standalone app uses this, workbench hosts like the studio the toolbar). Has no state
// display of its own: EmulatorStateBadges shows what is on, as the strip is not always on screen
export function EmulatorControlStrip(props: EmulatorControlStripProps): React.JSX.Element {
  const { host, pinned, onTogglePinned, inline } = props;
  const hover = host.hover ?? DEFAULT_KIT_SERVICES.hover;
  const rewindEnabled = host.isRewindEnabled();
  const busy = host.state.showControls;

  // exactly as in the toolbar, see the note there on why title is not set
  const tooltip = (content: string) => ({
    'aria-label': content,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) =>
      hover.show(event.currentTarget, content),
    onMouseLeave: () => hover.hide(),
  });

  const button = (
    key: string,
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    options?: { on?: boolean, off?: boolean, disabled?: boolean, extra?: object },
  ): React.JSX.Element =>
    <button
      key={key}
      // named rather than positional, and not a label, as labels are translated and the order is a design decision
      // that moves
      data-control={key}
      className={'vp-strip-button'
        + (options?.on ? ' vp-strip-button-on' : '')
        + (options?.off ? ' vp-strip-button-off' : '')}
      {...tooltip(label)}
      onClick={onClick}
      disabled={options?.disabled}
      {...options?.extra}
    >
      {icon}
    </button>;

  const withKey = (label: string, commandId: string): string =>
    `${label}${host.bindings.label(commandId, true)}`;

  // inline, the row belongs to the host, and so does fitting it
  const squeeze = useSqueeze(!inline);

  const groups: React.ReactNode[] = [];
  const leading = hostControls(host.leadingControls, tooltip);
  if (leading) {
    groups.push(<div className='vp-strip-group' key='host-leading'>{leading}</div>);
  }

  groups.push(<div className='vp-strip-group' key='transport'>
    {button('reset',
      withKey(EmulatorCommands.INPUT_RESET.label ?? '', EmulatorCommands.INPUT_RESET.id),
      <ArrowCounterClockwise size={18} />,
      () => host.runAction(EmulatorAction.Reset),
      { disabled: busy })}
    {button('pause',
      withKey(host.state.paused
        ? nls.localize('vueport/state/resume', 'Resume')
        : nls.localize('vueport/state/pause', 'Pause'),
        EmulatorCommands.INPUT_PAUSE_TOGGLE.id),
      <Pause size={18} />,
      () => host.runAction(EmulatorAction.PauseToggle),
      { on: host.state.paused, disabled: busy })}
  </div>);

  const rewindLabel = withKey(EmulatorCommands.INPUT_REWIND.label ?? '', EmulatorCommands.INPUT_REWIND.id)
    + (rewindEnabled ? '' : ` — ${nls.localize('vueport/state/rewind/isOff', 'off, click to enable')}`);
  groups.push(<div className='vp-strip-group' key='speed'>
    {host.rewindBrowser
      // a click opens the filmstrip, paused or not, as the Rewind key does
      ? button('rewind',
        rewindLabel,
        <Rewind size={18} />,
        () => rewindEnabled ? host.runAction(EmulatorAction.Rewind) : host.promptEnableRewind(),
        { on: host.rewinding, off: !rewindEnabled, disabled: busy })
      : button('rewind',
        rewindLabel,
        <Rewind size={18} />,
        () => undefined,
        {
          on: host.rewinding,
          off: !rewindEnabled,
          disabled: busy || host.state.paused,
          // held down rather than clicked, as in the toolbar: the pointer presses rewind for as long as it is down, and a
          // click with no pointer behind it is the keyboard activating the button
          extra: {
            onPointerDown: host.onRewindButtonDown,
            onPointerUp: host.onRewindButtonUp,
            onPointerCancel: host.onRewindButtonUp,
            onLostPointerCapture: () => host.stopRewinding(),
            onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
              if (!rewindEnabled) {
                host.promptEnableRewind();
              } else if (event.detail === 0) {
                host.runAction(EmulatorAction.Rewind);
              }
            },
          },
        })}
    {button('slowmotion',
      withKey(EmulatorCommands.INPUT_TOGGLE_SLOWMOTION.label ?? '',
        EmulatorCommands.INPUT_TOGGLE_SLOWMOTION.id),
      <ClockClockwise size={18} />,
      () => host.runAction(EmulatorAction.ToggleSlowmotion),
      // slow motion and frame advance give an unfair timing edge, so hardcore greys them out but keeps them pressable
      // like rewind and load state, and runAction shows the "Hardcore Mode is on" notice. Fast forward stays
      {
        on: host.state.slowmotion, off: host.isHardcore(),
        disabled: busy || host.state.paused
      })}
    {button('frame-advance',
      withKey(EmulatorCommands.INPUT_FRAME_ADVANCE.label ?? '',
        EmulatorCommands.INPUT_FRAME_ADVANCE.id),
      <SkipForward size={18} />,
      () => host.runAction(EmulatorAction.FrameAdvance),
      {
        on: host.state.frameAdvance,
        off: host.isHardcore(),
        disabled: busy || (host.state.paused && !host.state.frameAdvance),
      })}
    {button('fast-forward',
      withKey(EmulatorCommands.INPUT_TOGGLE_FAST_FORWARD.label ?? '',
        EmulatorCommands.INPUT_TOGGLE_FAST_FORWARD.id),
      <FastForward size={18} />,
      () => host.runAction(EmulatorAction.ToggleFastForward),
      { on: host.state.fastForward, disabled: busy || host.state.paused })}
  </div>);

  groups.push(<div className='vp-strip-group' key='states'>
    {button('save-state',
      withKey(EmulatorCommands.INPUT_SAVE_STATE.label ?? '', EmulatorCommands.INPUT_SAVE_STATE.id),
      <FloppyDisk size={18} />,
      () => host.runAction(EmulatorAction.SaveState),
      { disabled: busy })}
    {button('load-state',
      withKey(EmulatorCommands.INPUT_LOAD_STATE.label ?? '', EmulatorCommands.INPUT_LOAD_STATE.id),
      <FileArrowUp size={18} />,
      () => host.runAction(EmulatorAction.LoadState),
      {
        off: host.isHardcore(),
        disabled: busy || !host.state.saveStateExists
      })}
    {/* saving makes a new state each time, so the list is worth reaching from the transport. Only for a host with
        one, see EmulatorToolbarState.showSaveStates */}
    {host.toggleSaveStates && button('save-states',
      withKey(EmulatorCommands.TOGGLE_SAVE_STATES.label ?? '',
        EmulatorCommands.TOGGLE_SAVE_STATES.id),
      <ListDashes size={18} />,
      () => host.toggleSaveStates?.(),
      // never lit: the list opening beside the screen says it is open
      { disabled: busy })}
  </div>);

  groups.push(<div className='vp-strip-group' key='session'>
    {button('mute',
      withKey(host.state.muted
        ? nls.localize('vueport/state/unmute', 'Unmute')
        : nls.localize('vueport/state/mute', 'Mute'),
        EmulatorCommands.INPUT_AUDIO_MUTE.id),
      host.state.muted ? <SpeakerSimpleSlash size={18} /> : <SpeakerSimpleHigh size={18} />,
      () => host.runAction(EmulatorAction.AudioMute),
      { on: host.state.muted, disabled: busy })}
    {button('low-power',
      withKey(EmulatorCommands.INPUT_TOGGLE_LOW_POWER.label ?? '',
        EmulatorCommands.INPUT_TOGGLE_LOW_POWER.id),
      host.state.lowPower ? <BatteryLow size={18} /> : <BatteryFull size={18} />,
      () => host.runAction(EmulatorAction.ToggleLowPower),
      { on: host.state.lowPower, disabled: busy })}
  </div>);

  groups.push(<div className='vp-strip-group' key='capture'>
    {button('screenshot',
      withKey(EmulatorCommands.INPUT_SCREENSHOT.label ?? '', EmulatorCommands.INPUT_SCREENSHOT.id),
      <Camera size={18} />,
      () => host.runAction(EmulatorAction.Screenshot),
      { disabled: busy })}
    {/* only where the host can record, as recordingVideo is the capability as well as the state. Lit while
        recording; the badge over the picture says the same when the strip is hidden */}
    {host.recordingVideo !== undefined && button('video',
      withKey(host.recordingVideo
        ? nls.localize('vueport/video/stop', 'Stop Recording')
        : EmulatorCommands.INPUT_VIDEO_RECORD.label ?? '',
        EmulatorCommands.INPUT_VIDEO_RECORD.id),
      <VideoCamera size={18} weight={host.recordingVideo ? 'fill' : 'regular'} />,
      () => host.runAction(EmulatorAction.VideoRecord),
      { on: host.recordingVideo, disabled: busy })}
  </div>);

  const trailing = hostControls(host.trailingControls, tooltip);
  if (trailing) {
    groups.push(<div className='vp-strip-group' key='host-trailing'>{trailing}</div>);
  }

  // the only control about the strip rather than the emulator, hence last and behind its own divider. Pinned, the
  // strip stops hiding itself: auto-hiding is right while playing and wrong while setting something up
  if (onTogglePinned) {
    groups.push(<div className='vp-strip-group' key='pin'>
      {button('pin',
        pinned
          ? nls.localize('vueport/controlStrip/unpin', 'Let the controls hide again')
          : nls.localize('vueport/controlStrip/pin', 'Keep the controls on screen'),
        <PushPin size={18} weight={pinned ? 'fill' : 'regular'} />,
        onTogglePinned,
        { on: pinned })}
    </div>);
  }

  return <div
    ref={squeeze}
    className={'vp-strip vp-scroll' + (inline ? ' vp-strip-inline' : '')}
    role='toolbar'
  >{groups}</div>;
}

// how far (px) two neighbouring buttons may be pulled together when the row is wider than the screen panel; beyond
// that a button's hover circle would cover the next glyph, so the strip scrolls. A divider gives up the same, half on
// either side of its line
const MAX_SQUEEZE = 8;

// pulls buttons and dividers together just enough for the row to fit the layer it is portalled into, measured after
// every render and on panel resize. The unsqueezed width is worked back from the current squeeze, so a squeezed row
// can tell when it would fit again
function useSqueeze(enabled: boolean): React.RefObject<HTMLDivElement> {
  const ref = React.useRef<HTMLDivElement>(null);
  const measure = React.useCallback(() => {
    const strip = ref.current;
    const layer = strip?.parentElement;
    if (!strip || !layer || !enabled) {
      return;
    }
    // every gap that gives way: between two buttons, and at each divider
    const pairs = Array.from(strip.querySelectorAll('.vp-strip-button'))
      .filter(button => button.previousElementSibling?.classList.contains('vp-strip-button')).length
      + strip.querySelectorAll(':scope > .vp-strip-group + .vp-strip-group').length;
    const current = parseFloat(strip.style.getPropertyValue('--vp-strip-squeeze')) || 0;
    const natural = strip.scrollWidth + current * pairs;
    const available = layer.clientWidth - (strip.offsetWidth - strip.clientWidth);
    const overflow = natural - available;
    const next = pairs > 0 && overflow > 0 ? Math.min(MAX_SQUEEZE, Math.ceil(overflow / pairs)) : 0;
    if (next !== current) {
      if (next) {
        strip.style.setProperty('--vp-strip-squeeze', `${next}px`);
      } else {
        strip.style.removeProperty('--vp-strip-squeeze');
      }
    }
  }, [enabled]);
  React.useLayoutEffect(measure);
  React.useEffect(() => {
    const layer = ref.current?.parentElement;
    if (!layer || !enabled) {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, [measure, enabled]);
  return ref;
}
