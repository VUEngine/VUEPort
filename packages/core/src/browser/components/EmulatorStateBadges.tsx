import {
  BatteryLow,
  ClockClockwise,
  FastForward,
  Pause,
  Rewind,
  SkipForward,
  SpeakerSimpleSlash,
} from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { EmulatorAction } from '../emulator-types';
import { EmulatorToolbarHost } from './EmulatorToolbar';

/**
 * Badges over the corner of the picture say what the machine is doing (paused, muted, fast-forwarding) once the chrome
 * has hidden itself and its lit buttons with it. They are worded rather than iconic, as an icon is a puzzle without a
 * toolbar to compare with. Each badge switches off what it announces, as the button that would do it is gone.
 */
interface BadgeState {
  id: string;
  label: string;
  icon: React.ReactNode;
  action: string;
  stop(): void;
  detail?: string;
}

// what the machine is doing (paused, muted, fast-forwarding) over the corner of the picture, once the chrome and its
// lit buttons have hidden. Worded rather than iconic, as an icon is a puzzle without a toolbar to compare with. Each
// badge switches off what it announces, since the button that would do it is gone
export function EmulatorStateBadges(props: { host: EmulatorToolbarHost }): React.JSX.Element | null {
  const { host } = props;
  const badges: BadgeState[] = [];
  const resume = nls.localize('vueport/state/resume', 'Resume');

  // rewinding first, frame advance beside it: both are momentary, not a mode left on
  if (host.rewinding) {
    badges.push({
      id: 'rewinding',
      label: nls.localize('vueport/state/rewinding', 'Rewinding'),
      icon: <Rewind size={16} weight='fill' />,
      action: nls.localize('vueport/state/stopRewinding', 'Stop rewinding'),
      stop: () => host.stopRewinding(),
    });
  }
  if (host.state.paused) {
    badges.push({
      id: 'paused',
      label: nls.localize('vueport/state/paused', 'Paused'),
      icon: <Pause size={16} weight='fill' />,
      action: resume,
      stop: () => host.runAction(EmulatorAction.PauseToggle),
    });
  }
  if (host.state.frameAdvance) {
    badges.push({
      id: 'frame-advance',
      label: nls.localize('vueport/state/frameAdvance', 'Frame advance'),
      icon: <SkipForward size={16} weight='fill' />,
      // frame advance is a paused machine being stepped, so leaving it is resuming
      action: resume,
      stop: () => host.runAction(EmulatorAction.PauseToggle),
    });
  }
  if (host.state.fastForward) {
    badges.push({
      id: 'fast-forward',
      label: nls.localize('vueport/state/fastForward', 'Fast-forward'),
      icon: <FastForward size={16} weight='fill' />,
      action: nls.localize('vueport/state/stopFastForward', 'Back to normal speed'),
      stop: () => host.runAction(EmulatorAction.ToggleFastForward),
      detail: `×${host.settings.get('fastForwardRatio')}`,
    });
  }
  if (host.state.slowmotion) {
    badges.push({
      id: 'slow-motion',
      label: nls.localize('vueport/state/slowMotion', 'Slow motion'),
      icon: <ClockClockwise size={16} />,
      action: nls.localize('vueport/state/stopSlowMotion', 'Back to normal speed'),
      stop: () => host.runAction(EmulatorAction.ToggleSlowmotion),
      detail: `×${host.settings.get('slowMotionRatio')}`,
    });
  }
  if (host.state.muted) {
    badges.push({
      id: 'muted',
      label: nls.localize('vueport/state/muted', 'Muted'),
      icon: <SpeakerSimpleSlash size={16} weight='fill' />,
      action: nls.localize('vueport/state/unmute', 'Unmute'),
      stop: () => host.runAction(EmulatorAction.AudioMute),
    });
  }
  if (host.state.lowPower) {
    badges.push({
      id: 'low-power',
      label: nls.localize('vueport/state/lowPower', 'Low power'),
      icon: <BatteryLow size={16} />,
      action: nls.localize('vueport/state/stopLowPower', 'Leave low power'),
      stop: () => host.runAction(EmulatorAction.ToggleLowPower),
    });
  }

  if (badges.length === 0) {
    return null;
  }

  // role="status": the only place these are announced once the chrome is hidden
  return <div className='vp-state-badge-list' role='status'>
    {badges.map(badge =>
      <button
        type='button'
        className='vp-screen-badge vp-state-badge'
        key={badge.id}
        data-state={badge.id}
        aria-label={`${badge.label}. ${badge.action}.`}
        onClick={badge.stop}
      >
        {badge.icon}
        <span>{badge.label}</span>
        {badge.detail && <span className='vp-state-badge-detail'>{badge.detail}</span>}
      </button>
    )}
  </div>;
}
