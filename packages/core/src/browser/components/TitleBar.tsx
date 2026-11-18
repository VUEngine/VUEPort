import {
    ArrowsIn,
    ArrowsOut,
    Bandaids,
    Bug,
    ClockCountdown,
    Lightning,
    PaintBucket,
    Plugs,
    PlugsConnected,
    Queue,
    ShareNetwork,
    SlidersHorizontal,
    Star,
    Trophy,
    VirtualReality,
    X
} from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { EmulatorCommands } from '../emulator-commands';
import { EmulatorAction, EmulatorMode } from '../emulator-types';
import { EmulatorToolbarHost } from './EmulatorToolbar';
import type { XrAvailability } from '../emulator-xr';
import { DOM_HOVER } from './kit/dom-hover';
import { VbColorIcon } from './kit/VbColorIcon';
import { useXrLayout } from './xr-layout';

function TitleBarButton(props: {
    // a stable hook: the label is translated, the control name is not
    control: string,
    label: string,
    active?: boolean,
    disabled?: boolean,
    dimmed?: boolean,
    onClick: () => void,
    children: React.ReactNode,
}): React.JSX.Element {
    const { control, label, active, disabled, dimmed, onClick, children } = props;
    return <button
        type='button'
        data-control={control}
        className={'vp-titlebar-button'
            + (active ? ' active' : '')
            + (dimmed ? ' dimmed' : '')}
        disabled={disabled}
        aria-label={label}
        onMouseEnter={event => DOM_HOVER.show(event.currentTarget, label)}
        onMouseLeave={() => DOM_HOVER.hide()}
        onClick={() => { DOM_HOVER.hide(); onClick(); }}
    >
        {children}
    </button>;
}

// named for what they are, not a mode: they open beside the screen in Play and Debug alike
export type PlayStrip =
    'save-states' | 'cheats' | 'macros' | 'patches' | 'achievements';

// optional members are things a host may not have: no VB Color switch draws no pill, no Debug mode no bug
export interface TitleBarHost extends EmulatorToolbarHost {
    readonly hasRom: boolean;
    readonly settingsOpen: boolean;
    toggleDebugMode(): void;
    // Color mode (the color editor), for a host that offers it; shown for every game, and without a colorization
    // switched on the editor says so itself
    toggleColorMode?(): void;
    readonly vbcSupportEnabled: boolean;
    // nothing for a machine that is not a VB Color one
    readonly vbcHeaderPillLabel?: string;
    pickHardwareMode?(): Promise<void>;
    offerToLeaveHardcore?(): Promise<void>;
    // a second player can be invited before a game is open, the other window then waits for this one to start one.
    // Without it the link button needs a cartridge like the panel controls
    readonly linksWithoutRom?: boolean;
    // the VR button, shown only where there is a headset to drive (xrAvailability) and never inside it, where the X
    // beside the controls leaves VR. Without it there is no button
    toggleXr?(): Promise<void>;
    readonly xrAvailability?: XrAvailability;
    readonly xrActive?: boolean;
    // the share button beside it, with or without a game, see NetworkSharesWindow. Without it there is no button
    openNetworkShares?(): void;
    // lit while that window is open, and while this computer shares a game
    readonly networkSharesOpen?: boolean;
    readonly lanShareActive?: boolean;
    leaveXr?(): void;
}

/**
 * How far the strip gives way when its content does not fit, one step at a time: the file name under a game's title
 * goes, the pills show their icons only, the title shrinks to an ellipsis, the gaps and buttons narrow, the title goes,
 * the logo goes, and last the buttons lose their padding. The controls and the window's own buttons are never hidden.
 * The step is found by laying the strip out at each in turn and taking the first that fits, so it is set on the
 * element (`data-squeeze`, the steps taken as words) rather than through React, whose render lays it out once. A
 * title's close button appears on hover, so pointing at the title must not push anything out (see squeeze).
 */
const SQUEEZE_STEPS = ['sub', 'icons', 'title', 'tight', 'untitled', 'logo', 'narrow'];

function squeeze(header: HTMLElement | null): void {
    if (!header) {
        return;
    }
    const close = header.querySelector<HTMLElement>('.vp-titlebar-rom-close');
    const closeStyle = close ? getComputedStyle(close) : undefined;
    // a title's close button shows on hover, so its room counts as taken until the title may shrink
    const reserve = closeStyle?.display === 'none' ? (parseFloat(closeStyle.width) || 24) + 2 : 0;
    // the spacer takes whatever is left over, so its width is the room to spare; scrollWidth only says whether
    // something already sticks out, as it is never less than the strip's own width
    const spacer = header.querySelector<HTMLElement>('.vp-titlebar-spacer');
    for (let taken = 0; taken <= SQUEEZE_STEPS.length; taken++) {
        const steps = SQUEEZE_STEPS.slice(0, taken);
        header.dataset.squeeze = steps.join(' ');
        // once the title may shrink it makes the room itself, a little more on hover
        const roomForClose = steps.includes('title') || (spacer?.getBoundingClientRect().width ?? 0) >= reserve;
        if (header.scrollWidth <= header.clientWidth && roomForClose) {
            return;
        }
    }
}

export type TitleBarWindowControls =
    // a browser or a strip inside a larger application: no controls, no drag
    'none'
    // macOS keeps its real traffic lights (fake ones lose hover symbols, option-click zoom and double-click fill)
    // and the inset keeps ours clear
    | 'overlay'
    // the frame is off, so minimize, maximize and close are drawn here
    | 'custom';

export interface TitleBarProps {
    emulator: TitleBarHost;
    // where a window would put its document's name: the standalone build names the ROM and the way out of it, the
    // studio's tab already names the file, so it puts the transport toolbar here
    title?: React.ReactNode;
    logo?: React.ReactNode;
    // defaults to `none`
    windowControls?: TitleBarWindowControls;
    onMinimizeWindow?: () => void;
    onMaximizeWindow?: () => void;
    onCloseWindow?: () => void;
    // without it, the page's own fullscreen element is watched. A host whose fullscreen is the window's (the desktop
    // shell, where macOS's green button changes it from outside) passes what it knows
    fullscreen?: boolean;
}

// in a headset the title bar has none of the strip buttons (see the .vp-xr-layout rules), so these tabs stand over the
// strip right of the screen, one always lit as a strip always shows there. Labelled, as a headset shows no tooltips
function XrPanelTabs(props: { emulator: TitleBarHost, hardcore: boolean }): React.JSX.Element {
    const { emulator, hardcore } = props;
    const tab = (
        which: PlayStrip,
        label: string,
        showing: boolean,
        icon: React.ReactNode,
        show: () => void,
        dimmed = false,
    ): React.JSX.Element =>
        <button
            key={which}
            type='button'
            role='tab'
            data-control={which}
            aria-selected={showing}
            className={'vp-xr-panel-tab' + (showing ? ' active' : '') + (dimmed ? ' dimmed' : '')}
            // a lit tab stays lit: there is always a strip in a headset
            onClick={() => { if (!showing) { show(); } }}
        >
            {icon}
            <span>{label}</span>
        </button>;
    const state = emulator.state;
    return <div className='vp-xr-panel-tabs' role='tablist'>
        {emulator.toggleSaveStates && tab('save-states',
            nls.localize('vueport/saveStates/title', 'Save States'),
            state.showSaveStates ?? false, <ClockCountdown size={20} />, () => emulator.toggleSaveStates?.())}
        {tab('cheats', nls.localize('vueport/cheats/title', 'Cheats'),
            state.showCheats, <Star size={20} />, () => emulator.toggleCheats(), hardcore)}
        {tab('macros', nls.localize('vueport/macros/title', 'Macros'),
            state.showMacros, <Queue size={20} />, () => emulator.toggleMacros(), hardcore)}
        {tab('patches', nls.localize('vueport/patches/title', 'Patches'),
            state.showPatches, <Bandaids size={20} />, () => emulator.togglePatches(), hardcore)}
        {tab('achievements', nls.localize('vueport/achievements/title', 'Achievements'),
            state.showAchievements, <Trophy size={20} />, () => emulator.toggleAchievements())}
    </div>;
}

function linkLabel(status: ReturnType<TitleBarHost['linkStatus']>): string {
    switch (status) {
        case 'linked':
            return nls.localize('vueport/commands/link/unlink', 'Unlink Players');
        case 'waiting':
            return nls.localize('vueport/commands/link/cancel', 'Cancel Link');
        case 'relinkable':
            return nls.localize('vueport/commands/link/relink', 'Relink Players');
        default:
            return nls.localize('vueport/commands/link/secondPlayer', 'Link Second Player');
    }
}

function linkCommand(status: ReturnType<TitleBarHost['linkStatus']>): string {
    switch (status) {
        case 'linked':
        case 'waiting':
            return EmulatorCommands.UNLINK_PLAYERS.id;
        case 'relinkable':
            return EmulatorCommands.RELINK_PLAYERS.id;
        default:
            return EmulatorCommands.LINK_SECOND_PLAYER.id;
    }
}

// everything that opens something (cheats, settings, Debug mode) lives up here, as the toolbar over the picture hides
// itself and holds only the transport. On the desktop this is the window's title bar (`windowControls`), in the studio
// a strip inside a widget whose `title` slot carries the transport toolbar
/**
 * Everything that opens something (cheats, settings, Debug mode) lives in the title bar, as the immersive toolbar over
 * the picture hides itself and only holds the transport. Both hosts use it: the left is a slot (`title`) where the
 * standalone build names the ROM and the studio puts the transport toolbar. On the desktop this is the window's title
 * bar (`windowControls`), in the studio a strip inside a widget.
 */
export default function TitleBar(props: TitleBarProps): React.JSX.Element {
    const { emulator, title, logo, windowControls = 'none' } = props;
    const debugging = emulator.state.mode === EmulatorMode.DEBUG;
    const coloring = emulator.state.mode === EmulatorMode.COLOR;
    const hardcore = emulator.isHardcore();

    // for a host that does not report its own fullscreen. Leaving it with Escape never touches the emulator, so
    // nothing else here would hear about it
    const [pageFullscreen, setPageFullscreen] = React.useState(
        () => typeof document !== 'undefined' && document.fullscreenElement !== null
    );
    React.useEffect(() => {
        if (props.fullscreen !== undefined) {
            return undefined;
        }
        const sync = (): void => setPageFullscreen(document.fullscreenElement !== null);
        document.addEventListener('fullscreenchange', sync);
        return () => document.removeEventListener('fullscreenchange', sync);
    }, [props.fullscreen]);
    const fullscreen = props.fullscreen ?? pageFullscreen;
    const inHeadset = useXrLayout();
    // not in the headset, where the X beside the controls is the way out and a second one would only repeat it
    const showVr = emulator.toggleXr !== undefined && !inHeadset
        && (emulator.xrAvailability === 'headset' || (emulator.xrActive ?? false));

    // dimmed rather than disabled where a strip is off limits: the click still shows the reason (the "Hardcore Mode
    // is on" notice) instead of a button that silently does nothing
    const panelButton = (
        which: PlayStrip,
        label: string,
        showing: boolean,
        icon: React.ReactNode,
        toggle: () => void,
        dimmed = false,
    ): React.JSX.Element =>
        <TitleBarButton
            control={which}
            label={label}
            active={showing}
            dimmed={dimmed}
            onClick={toggle}
        >
            {icon}
        </TitleBarButton>;

    // left of Debug mode, after the panels' divider; always there, as a game can come from another computer without
    // one running here
    const shareButton = emulator.openNetworkShares &&
        <TitleBarButton
            control='network-shares'
            label={emulator.lanShareActive
                ? nls.localize('vueport/shares/buttonActive', 'Network Shares (sharing a game)')
                : nls.localize('vueport/shares/title', 'Network Shares')}
            active={emulator.networkSharesOpen || emulator.lanShareActive}
            onClick={() => emulator.openNetworkShares?.()}
        >
            <ShareNetwork size={20} weight={emulator.lanShareActive ? 'fill' : 'regular'} />
        </TitleBarButton>;

    const linkedLabel = nls.localize('vueport/titleBar/linked', 'Linked · P{0}', String(emulator.player));

    const header = React.useRef<HTMLElement>(null);
    /**
     * Refits after every render, as a pill coming or going or another title changes what fits, and whenever the strip
     * or anything on it resizes without a render (the window, a font or the logo arriving). The watched items are the
     * strip's own children, looked at again after each render. The step is taken on the next frame, as taking it inside
     * the observer's callback would resize what it watches while it reports.
     */
    const observer = React.useRef<ResizeObserver>();
    React.useLayoutEffect(() => {
        const element = header.current;
        squeeze(element);
        if (!element || typeof ResizeObserver === 'undefined') {
            return;
        }
        if (!observer.current) {
            let frame = 0;
            observer.current = new ResizeObserver(() => {
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(() => squeeze(header.current));
            });
        }
        observer.current.disconnect();
        observer.current.observe(element);
        for (const child of Array.from(element.children)) {
            observer.current.observe(child);
        }
    });
    React.useEffect(() => () => observer.current?.disconnect(), []);

    const bar = <header
        ref={header}
        className={'vp-titlebar vp-titlebar-' + windowControls}
        // Tauri's own drag region, as WebView2 does not honor `-webkit-app-region`
        data-tauri-drag-region={windowControls === 'none' ? undefined : true}
    >
        {logo}

        {logo && <span className='vp-titlebar-divider' />}
        {title}

        {emulator.vbcHeaderPillLabel &&
            <button
                type='button'
                className='vp-titlebar-pill'
                onMouseEnter={event => DOM_HOVER.show(event.currentTarget,
                    nls.localize(
                        'vueport/titleBar/vbcHint',
                        'VB Color hardware is active — click to change hardware mode'
                    ))}
                onMouseLeave={() => DOM_HOVER.hide()}
                onClick={() => {
                    DOM_HOVER.hide();
                    emulator.pickHardwareMode?.().catch(() => undefined);
                }}
                aria-label={emulator.vbcHeaderPillLabel}
            >
                <VbColorIcon size={14} />
                <span className='vp-titlebar-pill-label'>{emulator.vbcHeaderPillLabel}</span>
            </button>}

        {hardcore &&
            <button
                type='button'
                className='vp-titlebar-pill'
                onMouseEnter={event => DOM_HOVER.show(event.currentTarget,
                    nls.localize('vueport/achievements/hardcore/titleHint', 'Hardcore Mode is on — click to turn off'))}
                onMouseLeave={() => DOM_HOVER.hide()}
                onClick={() => {
                    DOM_HOVER.hide();
                    emulator.offerToLeaveHardcore?.().catch(() => undefined);
                }}
                aria-label={nls.localize('vueport/achievements/hardcore/title', 'Hardcore Mode')}
            >
                <Lightning size={18} weight='fill' />
                <span className='vp-titlebar-pill-label'>
                    {nls.localize('vueport/achievements/hardcore/title', 'Hardcore Mode')}
                </span>
            </button>}

        {(emulator.isLinked() || emulator.linkStatus() === 'waiting') &&
            // the modifier has no styling, it only names the pill. Shown while waiting too, as a link invited from the
            // library waits on this window before there is a game
            <span
                className={'vp-titlebar-pill ' + (emulator.isLinked() ? 'linked' : 'waiting')}
                role='status'
                aria-label={linkedLabel}
                // said on hover too, for when the strip is down to the icon
                onMouseEnter={event => DOM_HOVER.show(event.currentTarget, linkedLabel)}
                onMouseLeave={() => DOM_HOVER.hide()}
            >
                <PlugsConnected size={18} />
                <span className='vp-titlebar-pill-label'>{linkedLabel}</span>
            </span>}

        <div className='vp-titlebar-spacer' />

        <div className='vp-titlebar-controls'>
            {(emulator.hasRom || emulator.linksWithoutRom || showVr) && <>
                {/* one click into the headset, as the click is what lets a page start VR; only where there is one */}
                {showVr &&
                    <TitleBarButton
                        control='vr'
                        label={emulator.xrActive
                            ? nls.localize('vueport/xr/leave', 'Leave VR')
                            : nls.localize('vueport/xr/enter', 'Play in VR')}
                        active={emulator.xrActive}
                        onClick={() => { emulator.toggleXr?.().catch(() => undefined); }}
                    >
                        <VirtualReality size={24} weight={emulator.xrActive ? 'fill' : 'regular'} />
                    </TitleBarButton>}

                {inHeadset && emulator.leaveXr &&
                    <TitleBarButton
                        control='leave-vr'
                        label={nls.localize('vueport/xr/leave', 'Leave VR')}
                        onClick={() => emulator.leaveXr?.()}
                    >
                        <X size={20} />
                    </TitleBarButton>}
                {/* a session control, not transport, so it sits up here rather than in the strip over the picture */}
                {(emulator.hasRom || emulator.linksWithoutRom) &&
                    <TitleBarButton
                        control='link'
                        label={linkLabel(emulator.linkStatus())}
                        // lit while waiting too: something is running that pressing the button would stop
                        active={emulator.linkStatus() === 'linked' || emulator.linkStatus() === 'waiting'}
                        onClick={() => emulator.runCommand(linkCommand(emulator.linkStatus()))}
                    >
                        {emulator.linkStatus() === 'linked' ? <PlugsConnected size={20} /> : <Plugs size={20} />}
                    </TitleBarButton>}
                <span className='vp-titlebar-controls-divider' />
            </>}
            {emulator.hasRom && <>
                {/* no profiling button here: it belongs to the CPU Profiler panel, and a recording outliving Debug
                    mode is stopped from the badge over the picture */}
                {/* left of the cheats, as it is about the session rather than the game */}
                {emulator.toggleSaveStates && panelButton('save-states',
                    nls.localize('vueport/commands/toggle/saveStates', 'Save States'),
                    emulator.state.showSaveStates ?? false, <ClockCountdown size={20} />,
                    () => emulator.toggleSaveStates?.())}
                {panelButton('cheats',
                    nls.localize('vueport/commands/toggle/cheats', 'Cheats'),
                    emulator.state.showCheats, <Star size={20} />,
                    () => emulator.toggleCheats(), hardcore)}
                {panelButton('macros',
                    nls.localize('vueport/commands/toggle/macros', 'Macros'),
                    emulator.state.showMacros, <Queue size={20} />,
                    () => emulator.toggleMacros(), hardcore)}
                {panelButton('patches',
                    nls.localize('vueport/commands/toggle/patches', 'Patches'),
                    emulator.state.showPatches, <Bandaids size={20} />,
                    () => emulator.togglePatches(), hardcore)}
                {panelButton('achievements',
                    nls.localize('vueport/commands/toggle/achievements', 'Achievements'),
                    emulator.state.showAchievements, <Trophy size={20} />,
                    () => emulator.toggleAchievements())}
                <span className='vp-titlebar-controls-divider' />
                {shareButton}
                {emulator.toggleColorMode &&
                    <TitleBarButton
                        control='color'
                        label={coloring
                            ? nls.localize('vueport/color/leave', 'Close VB Color Editor')
                            : nls.localize('vueport/color/enter', 'VB Color Editor')}
                        active={coloring}
                        dimmed={hardcore}
                        onClick={() => emulator.toggleColorMode?.()}
                    >
                        <PaintBucket size={20} />
                    </TitleBarButton>}
                <TitleBarButton
                    control='mode'
                    label={debugging
                        ? nls.localize('vueport/debug/leave', 'Leave Debug mode')
                        : nls.localize('vueport/debug/enter', 'Debug mode')}
                    active={debugging}
                    dimmed={hardcore}
                    onClick={() => emulator.toggleDebugMode()}
                >
                    <Bug size={20} />
                </TitleBarButton>
            </>}

            {/* without a game the hasRom group above is not drawn, so it sits beside the settings */}
            {!emulator.hasRom && shareButton}
            <TitleBarButton
                control='settings'
                label={nls.localize('vueport/settings/title', 'Settings')}
                active={emulator.settingsOpen}
                onClick={() => emulator.togglePreferencesWindow()}
            >
                <SlidersHorizontal size={20} />
            </TitleBarButton>
            <TitleBarButton
                control='fullscreen'
                label={fullscreen
                    ? nls.localize('vueport/commands/exitFullscreen', 'Exit Fullscreen')
                    : nls.localize('vueport/commands/fullscreen', 'Fullscreen')}
                // not lit while on: the icon turning inwards says it, and a lit button framed the whole screen in red
                onClick={() => emulator.runAction(EmulatorAction.Fullscreen)}
            >
                {fullscreen ? <ArrowsIn size={20} /> : <ArrowsOut size={20} />}
            </TitleBarButton>
        </div>

        {windowControls === 'custom' &&
            <div className='vp-window-controls'>
                <button
                    type='button'
                    className='vp-window-control'
                    aria-label={nls.localize('vueport/window/minimize', 'Minimize')}
                    onClick={() => props.onMinimizeWindow?.()}
                >
                    <svg viewBox='0 0 12 12' aria-hidden='true'><path d='M1 6h10' /></svg>
                </button>
                <button
                    type='button'
                    className='vp-window-control'
                    aria-label={nls.localize('vueport/window/maximize', 'Maximize')}
                    onClick={() => props.onMaximizeWindow?.()}
                >
                    <svg viewBox='0 0 12 12' aria-hidden='true'>
                        <rect x='1.5' y='1.5' width='9' height='9' />
                    </svg>
                </button>
                <button
                    type='button'
                    className='vp-window-control close'
                    aria-label={nls.localize('vueport/window/close', 'Close')}
                    onClick={() => props.onCloseWindow?.()}
                >
                    <svg viewBox='0 0 12 12' aria-hidden='true'>
                        <path d='M1.5 1.5l9 9M10.5 1.5l-9 9' />
                    </svg>
                </button>
            </div>}
    </header>;

    // in a headset the strips are chosen from tabs over the strip itself, beside the screen (emulator-xr-ui.ts)
    return inHeadset
        ? <>{bar}<XrPanelTabs emulator={emulator} hardcore={hardcore} /></>
        : bar;
}
