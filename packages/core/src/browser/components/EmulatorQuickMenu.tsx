import {
    ArrowCounterClockwise,
    Bandaids,
    BatteryFull,
    BatteryLow,
    Camera,
    ClockClockwise,
    ClockCountdown,
    FastForward,
    FileArrowUp,
    FloppyDisk,
    Info,
    Pause,
    Play,
    Queue,
    Rewind,
    ShareNetwork,
    SkipForward,
    SlidersHorizontal,
    SpeakerSimpleHigh,
    SpeakerSimpleSlash,
    Star,
    Trophy,
    VideoCamera,
    VirtualReality,
} from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { EmulatorCommands } from '../emulator-commands';
import { EmulatorAction } from '../emulator-types';
import { EmulatorToolbarControl, EmulatorToolbarHost } from './EmulatorToolbar';
import type { XrAvailability } from '../emulator-xr';
import { BottomSheet } from './kit/BottomSheet';
import { VbColorIcon } from './kit/VbColorIcon';

// what a phone's menu needs beyond the transport; on a larger screen these are the title bar's (see TitleBar)
export interface EmulatorQuickMenuHost extends EmulatorToolbarHost {
    readonly gameTitle?: string;
    readonly vbcHeaderPillLabel?: string;
    toggleRomInfo?(): void;
    // see TitleBarHost
    toggleXr?(): Promise<void>;
    readonly xrAvailability?: XrAvailability;
    readonly xrActive?: boolean;
    openNetworkShares?(): void;
    readonly lanShareActive?: boolean;
}

interface Tile {
    id: string;
    label: string;
    icon: React.ReactNode;
    run: () => void;
    on?: boolean;
    // greyed out but still pressable, like the strip's hardcore buttons, so the press can say why
    off?: boolean;
    disabled?: boolean;
}

function TileGrid(props: {
    title: string,
    tiles: (Tile | false | undefined)[],
    onRan: (id: string) => void,
}): React.JSX.Element {
    return <section className='vp-quick-menu-group'>
        <h3>{props.title}</h3>
        <div className='vp-quick-menu-tiles'>
            {props.tiles.filter((tile): tile is Tile => !!tile).map(tile =>
                <button
                    key={tile.id}
                    type='button'
                    data-control={tile.id}
                    className={'vp-quick-menu-tile' + (tile.on ? ' on' : '') + (tile.off ? ' off' : '')}
                    aria-pressed={tile.on}
                    disabled={tile.disabled}
                    onClick={() => { tile.run(); props.onRan(tile.id); }}
                >
                    {tile.icon}
                    <span>{tile.label}</span>
                </button>)}
        </div>
    </section>;
}

/**
 * The phone's menu behind the ⋯ in the short strip under the picture: the full strip a larger screen floats over the
 * picture plus the title bar's panel, VR and fullscreen buttons, as a sheet of large tiles. Settings and the host's own
 * controls (Open and Close ROM in the standalone build) sit at the foot. Most tiles close the sheet once pressed, as
 * their effect shows on the picture; toggles that only change a state (mute, low battery) leave it up.
 */
export function EmulatorQuickMenu(props: { host: EmulatorQuickMenuHost, onClose: () => void }): React.JSX.Element {
    const { host, onClose } = props;
    const state = host.state;
    const busy = state.showControls;
    const hardcore = host.isHardcore();
    const rewindEnabled = host.isRewindEnabled();
    const label = (command: { label?: string }): string => command.label ?? '';
    // the toggles that change nothing to look at leave the sheet up, everything else is seen on the picture
    const stay = new Set(['mute', 'low-power', 'slowmotion', 'fast-forward']);
    const ran = (id: string): void => {
        if (!stay.has(id)) {
            onClose();
        }
    };

    const transport: Tile[] = [
        {
            id: 'reset', label: nls.localize('vueport/quickMenu/reset', 'Reset'),
            icon: <ArrowCounterClockwise size={24} />, run: () => host.runAction(EmulatorAction.Reset), disabled: busy,
        },
        {
            id: 'pause',
            label: state.paused
                ? nls.localize('vueport/state/resume', 'Resume')
                : nls.localize('vueport/state/pause', 'Pause'),
            icon: state.paused ? <Play size={24} weight='fill' /> : <Pause size={24} />,
            run: () => host.runAction(EmulatorAction.PauseToggle), on: state.paused, disabled: busy,
        },
        {
            id: 'rewind', label: nls.localize('vueport/quickMenu/rewind', 'Rewind'),
            icon: <Rewind size={24} />,
            run: () => rewindEnabled ? host.runAction(EmulatorAction.Rewind) : host.promptEnableRewind(),
            off: !rewindEnabled, disabled: busy,
        },
        {
            id: 'slowmotion', label: nls.localize('vueport/quickMenu/slowMotion', 'Slow Motion'),
            icon: <ClockClockwise size={24} />, run: () => host.runAction(EmulatorAction.ToggleSlowmotion),
            on: state.slowmotion, off: hardcore, disabled: busy || state.paused,
        },
        {
            id: 'frame-advance', label: nls.localize('vueport/quickMenu/frameAdvance', 'Frame Advance'),
            icon: <SkipForward size={24} />, run: () => host.runAction(EmulatorAction.FrameAdvance),
            on: state.frameAdvance, off: hardcore, disabled: busy || (state.paused && !state.frameAdvance),
        },
        {
            id: 'fast-forward', label: nls.localize('vueport/quickMenu/fastForward', 'Fast Forward'),
            icon: <FastForward size={24} />, run: () => host.runAction(EmulatorAction.ToggleFastForward),
            on: state.fastForward, disabled: busy || state.paused,
        },
        {
            id: 'mute',
            label: state.muted
                ? nls.localize('vueport/state/unmute', 'Unmute')
                : nls.localize('vueport/state/mute', 'Mute'),
            icon: state.muted ? <SpeakerSimpleSlash size={24} /> : <SpeakerSimpleHigh size={24} />,
            run: () => host.runAction(EmulatorAction.AudioMute), on: state.muted, disabled: busy,
        },
        {
            id: 'low-power', label: nls.localize('vueport/quickMenu/lowBattery', 'Low Battery'),
            icon: state.lowPower ? <BatteryLow size={24} /> : <BatteryFull size={24} />,
            run: () => host.runAction(EmulatorAction.ToggleLowPower), on: state.lowPower, disabled: busy,
        },
    ];

    const saving: (Tile | false)[] = [
        {
            id: 'save-state', label: nls.localize('vueport/quickMenu/save', 'Save'),
            icon: <FloppyDisk size={24} />, run: () => host.runAction(EmulatorAction.SaveState), disabled: busy,
        },
        {
            id: 'load-state', label: nls.localize('vueport/quickMenu/load', 'Load'),
            icon: <FileArrowUp size={24} />, run: () => host.runAction(EmulatorAction.LoadState),
            off: hardcore, disabled: busy || !state.saveStateExists,
        },
        {
            id: 'screenshot', label: label(EmulatorCommands.INPUT_SCREENSHOT),
            icon: <Camera size={24} />, run: () => host.runAction(EmulatorAction.Screenshot), disabled: busy,
        },
        host.recordingVideo !== undefined && {
            id: 'video',
            label: host.recordingVideo
                ? nls.localize('vueport/video/stop', 'Stop Recording')
                : nls.localize('vueport/quickMenu/video', 'Video'),
            icon: <VideoCamera size={24} weight={host.recordingVideo ? 'fill' : 'regular'} />,
            run: () => host.runAction(EmulatorAction.VideoRecord), on: host.recordingVideo, disabled: busy,
        },
    ];

    const panels: (Tile | false | undefined)[] = [
        host.toggleSaveStates && {
            id: 'save-states', label: nls.localize('vueport/saveStates/title', 'Save States'),
            icon: <ClockCountdown size={24} />, run: () => host.toggleSaveStates?.(), on: state.showSaveStates,
        },
        {
            id: 'cheats', label: nls.localize('vueport/cheats/title', 'Cheats'),
            icon: <Star size={24} />, run: () => host.toggleCheats(), on: state.showCheats, off: hardcore,
        },
        {
            id: 'macros', label: nls.localize('vueport/macros/title', 'Macros'),
            icon: <Queue size={24} />, run: () => host.toggleMacros(), on: state.showMacros, off: hardcore,
        },
        {
            id: 'patches', label: nls.localize('vueport/patches/title', 'Patches'),
            icon: <Bandaids size={24} />, run: () => host.togglePatches(), on: state.showPatches, off: hardcore,
        },
        {
            id: 'achievements', label: nls.localize('vueport/achievements/title', 'Achievements'),
            icon: <Trophy size={24} />, run: () => host.toggleAchievements(), on: state.showAchievements,
        },
        host.toggleRomInfo && {
            id: 'rom-info', label: nls.localize('vueport/quickMenu/gameInfo', 'Game Info'),
            icon: <Info size={24} />, run: () => host.toggleRomInfo?.(),
        },
        host.openNetworkShares && {
            id: 'network-shares', label: nls.localize('vueport/shares/title', 'Network Shares'),
            icon: <ShareNetwork size={24} weight={host.lanShareActive ? 'fill' : 'regular'} />,
            run: () => host.openNetworkShares?.(), on: host.lanShareActive,
        },
        // as in the title bar, only where this device drives a headset; the menu is never shown inside one
        host.toggleXr && (host.xrAvailability === 'headset' || host.xrActive) && {
            id: 'vr',
            label: host.xrActive
                ? nls.localize('vueport/xr/leave', 'Leave VR')
                : nls.localize('vueport/xr/enter', 'Play in VR'),
            icon: <VirtualReality size={24} />, run: () => { host.toggleXr?.().catch(() => undefined); },
            on: host.xrActive,
        },
    ];

    // the host's own, Open and Close ROM in the standalone build; Close ROM sits in the header, the rest at the foot
    const hostControls = [...host.leadingControls ?? [], ...host.trailingControls ?? []];
    const closeRom = hostControls.find(control => control.id === 'closeRom');
    const foot = hostControls.filter(control => control !== closeRom);
    const footButton = (control: EmulatorToolbarControl): React.JSX.Element =>
        <button
            key={control.id}
            type='button'
            className='vp-button secondary'
            data-control={control.id}
            disabled={control.disabled}
            onClick={() => { onClose(); control.run(); }}
        >
            {control.icon}
            {control.label}
        </button>;

    return <BottomSheet label={nls.localize('vueport/quickMenu/title', 'Game Menu')} onClose={onClose}
        className='vp-quick-menu'>
        <header className='vp-quick-menu-head'>
            <div className='vp-quick-menu-title'>
                <div className='vp-quick-menu-name'>
                    <strong>{host.gameTitle}</strong>
                    {host.vbcHeaderPillLabel && <span className='vp-quick-menu-pill'>
                        <VbColorIcon size={12} />
                        {host.vbcHeaderPillLabel}
                    </span>}
                </div>
            </div>
            {closeRom && <button
                type='button'
                className='vp-quick-menu-close-rom'
                aria-label={closeRom.label}
                data-control={closeRom.id}
                onClick={() => { onClose(); closeRom.run(); }}
            >
                {closeRom.icon}
            </button>}
        </header>

        <div className='vp-quick-menu-body vp-scroll'>
            <TileGrid title={nls.localize('vueport/quickMenu/control', 'Control')} tiles={transport}
                onRan={ran} />
            <TileGrid title={nls.localize('vueport/quickMenu/saveAndCapture', 'Save & Capture')} tiles={saving}
                onRan={ran} />
            <TileGrid title={nls.localize('vueport/quickMenu/panels', 'Panels')} tiles={panels}
                onRan={ran} />
        </div>

        <div className='vp-quick-menu-foot'>
            {foot.map(footButton)}
            <button
                type='button'
                className='vp-button secondary'
                data-control='settings'
                onClick={() => { onClose(); host.togglePreferencesWindow(); }}
            >
                <SlidersHorizontal size={18} />
                {nls.localize('vueport/settings/title', 'Settings')}
            </button>
        </div>
    </BottomSheet>;
}
