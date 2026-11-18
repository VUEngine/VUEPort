import { MessageLoop } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { EmulatorCommands } from '../emulator-commands';
import { MacroActivity } from '../emulator-macro-store';
import { EmulatorAction, EmulatorMode, STRIP_IDLE_DELAY, STRIP_WAKE_DISTANCE } from '../emulator-types';
import { TouchControlsLayout } from '../../common/emulator-settings';
import { useCompactLayout, usePageFullscreen } from '../compact-layout';
import { useTouchPresence } from '../touch-presence';
import { onDidRequestQuickMenu } from '../quick-menu-request';
import { EmulatorQuickMenu, EmulatorQuickMenuHost } from './EmulatorQuickMenu';
import { BottomSheet } from './kit/BottomSheet';
import { useSetting } from './settings/SettingFields';
import { EmulatorTouchControls } from './touch/EmulatorTouchControls';
import { TouchOrientation, sideClearance } from './touch/touch-layout';
import { RetroAchievementsService } from '../emulator-retroachievements';
import { VueportDock } from '../panels/emulator-dock';
import EmulatorCheatBadge from './EmulatorCheatBadge';
import EmulatorPatchBadge from './EmulatorPatchBadge';
import EmulatorLeaderboardTracker from './EmulatorLeaderboardTracker';
import EmulatorMacroBadge from './EmulatorMacroBadge';
import EmulatorProfileBadge from './EmulatorProfileBadge';
import { EmulatorControlStrip } from './EmulatorControlStrip';
import { EmulatorRewindStrip } from './EmulatorRewindStrip';
import { EmulatorStateBadges } from './EmulatorStateBadges';
import EmulatorMovieBadge from './EmulatorMovieBadge';
import EmulatorVideoBadge from './EmulatorVideoBadge';
import PanelAside from './PanelAside';
import { useXrLayout } from './xr-layout';
import { Bandaids, ClockCountdown, GameController, Queue, Star, Trophy, X } from '@phosphor-icons/react';
import { nls } from '../../common/emulator-nls';
import { EmulatorToolbarHost } from './EmulatorToolbar';

// everything the toolbar reads, plus the dock to show and the overlays to lay over it. The quick menu's members are
// all optional: a host that never runs on a phone (the studio) leaves them out
export interface EmulatorHost extends EmulatorToolbarHost, EmulatorQuickMenuHost {
    // see EmulatorInputController.setTouchKeys; without it there is no on-screen controller
    setTouchKeys?(keys: number): void;
    // the layout editor replaces the controller (opened from the Input pane's Touch page)
    readonly touchLayoutEditing?: boolean;
    // layout undefined for Cancel
    finishTouchLayoutEditing?(layout?: TouchControlsLayout): void;
    readonly dock: VueportDock;
    renderOverlay(): React.ReactNode;
    // not a panel: the dock is for inspecting the machine, the cheats, macros, patches and achievements belong to the
    // game, so they render beside it in both modes; `state.showCheats` and its siblings say whether
    renderCheats(): React.ReactNode;
    // optional, as the save-state browser is the standalone build's and other hosts leave it out (see
    // EmulatorToolbarState)
    renderSaveStates?(): React.ReactNode;
    readonly activeCheats: number;
    showCheats(): void;
    renderMacros(): React.ReactNode;
    readonly macroActivity: MacroActivity;
    readonly moviePlaying: boolean;
    readonly movieFrame: number; // in frames
    readonly movieLength: number; // in frames
    stopMoviePlayback(): void;
    showMacros(): void;
    // what the REC badge does. Thrown away rather than kept, as keeping means naming it and opening the editor, and a
    // badge pressed mid-game means "stop that"
    cancelMacroRecording(): void;
    renderPatches(): React.ReactNode;
    showPatches(): void;
    // colorizations not counted, see EmulatorPatchBadge
    readonly activePatches: number;
    // only one of the five strips is open at a time
    renderAchievements(): React.ReactNode;
    showAchievements(): void;
    // the service rather than the values: a running attempt's value changes many times a second, and only that small
    // overlay should redraw at that rate, so it subscribes itself (EmulatorLeaderboardTracker)
    readonly retroAchievements: RetroAchievementsService;
}

export type EmulatorChrome =
    // a self-hiding strip over the picture, for hosts where the emulator is the application; badges over the picture,
    // which don't hide, say what is switched on
    'immersive'
    // the same without the strip, for a host with its own transport row (the studio's title bar)
    | 'hosted'
    // the picture alone (no toolbar, strip, badges or overlay), for a linked player 2, whose transport, cheats and
    // settings are all player 1's
    | 'screen';

export interface EmulatorProps {
    emulator: EmulatorHost;
    // Lumino refuses to attach a widget to a host that is not attached itself, and React effects can run before the
    // surrounding widget has been put anywhere, so the dock waits for this rather than for the effect
    attached: boolean;
    // shown instead of the panels, for a host without a ROM yet (the standalone build's start page)
    placeholder?: React.ReactNode;
    // defaults to `immersive`, the emulator with all of its own chrome
    chrome?: EmulatorChrome;
}

// upright on a phone, the room above the picture the badges sit in rather than on the picture, in CSS pixels
const BADGE_BAND = 44;

// the dock is a Lumino DockPanel attached into a container this component owns but never renders into, like the
// screen panel's canvas one level down: some things have to keep their identity across renders
export function Emulator(props: EmulatorProps): React.JSX.Element {
    const { emulator, attached, placeholder, chrome = 'immersive' } = props;
    const dockHost = React.useRef<HTMLDivElement>(null);

    // whether the strip is up on its own is not React state: the effect below toggles a class on the panel's node
    const [pinned, setPinned] = React.useState(false);

    React.useEffect(() => {
        const host = dockHost.current;
        if (!host || !attached) {
            return undefined;
        }
        if (!emulator.dock.isAttached) {
            Widget.attach(emulator.dock, host);
        }
        // Lumino sizes a widget from resize messages from its owning layout. Nothing owns this one, so the container's
        // own size changes drive it
        const observer = new ResizeObserver(() =>
            MessageLoop.sendMessage(emulator.dock, Widget.ResizeMessage.UnknownSize)
        );
        observer.observe(host);
        return () => {
            observer.disconnect();
            try {
                if (emulator.dock.isAttached) {
                    Widget.detach(emulator.dock);
                }
            } catch {
                // a linked player 2's dock comes and goes with the pair, and Lumino sometimes detaches the widget
                // on its own first; just don't throw out of a cleanup
            }
        };
    }, [emulator.dock, attached]);

    const showingPlaceholder = placeholder !== undefined;
    // in a headset the strip beside the screen is always there (emulator-xr-ui.ts), so without a game it says so
    const inHeadset = useXrLayout();
    // not `hosted`, which keeps its transport in a row of the host's own
    const immersive = chrome === 'immersive' && !showingPlaceholder;
    const bare = chrome === 'screen';

    // a phone (compact-layout.ts) in the standalone chrome: upright, the picture goes to the top with the short strip
    // and the controller under it; on its side the picture keeps the middle, the controller beside it. Debug mode keeps
    // its dock as it is
    const compact = useCompactLayout();
    const playing = immersive && emulator.state.mode === EmulatorMode.PLAY;
    const compactPlay = compact !== undefined && playing;
    const orientation: TouchOrientation = compact === 'portrait' ? 'portrait' : 'landscape';
    const [menuOpen, setMenuOpen] = React.useState(false);
    React.useEffect(() => {
        if (!compactPlay) {
            setMenuOpen(false);
            return undefined;
        }
        // a swipe up from the bottom edge, see quick-menu-request.ts
        return onDidRequestQuickMenu(() => setMenuOpen(true));
    }, [compactPlay]);

    // the on-screen controller, for a host that takes its presses. "Automatic" follows the hands, see touch-presence.ts
    const touchMode = useSetting(emulator.settings, 'touchControls');
    const touchSize = useSetting(emulator.settings, 'touchControlsSize');
    const touching = useTouchPresence();
    const editingLayout = (emulator.touchLayoutEditing ?? false) && playing;
    const showTouch = emulator.setTouchKeys !== undefined && playing
        && (editingLayout || touchMode === 'always' || (touchMode === 'auto' && touching));

    // on its side the picture keeps clear of the controller, which needs the body's size to know how wide it is
    const body = React.useRef<HTMLDivElement>(null);
    const [bodySize, setBodySize] = React.useState({ width: 0, height: 0 });
    React.useEffect(() => {
        const node = body.current;
        if (!node) {
            return undefined;
        }
        const observer = new ResizeObserver(() => {
            const box = node.getBoundingClientRect();
            setBodySize(was => was.width === box.width && was.height === box.height
                ? was : { width: box.width, height: box.height });
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    // the page in fullscreen (the title bar's button), which on a phone on its side gives the picture the whole height:
    // the controller is then laid over its edges rather than beside it
    const pageFullscreen = usePageFullscreen();
    const fullscreenLandscape = compactPlay && orientation === 'landscape' && pageFullscreen;
    const side = compactPlay && orientation === 'landscape' && showTouch && !fullscreenLandscape
        ? Math.round(sideClearance('landscape', bodySize.width, bodySize.height, touchSize / 100))
        : 0;

    // upright with the controller: a band for the badges, the picture screen-wide less a margin, the controller under
    // it (at most about half the height). The panel still fills the body so backdrop and halo reach every edge; the
    // picture keeps clear of the controller by insets (setPictureInsets)
    const portraitTouch = compactPlay && orientation === 'portrait' && showTouch;
    const pictureRegion = portraitTouch
        ? Math.round(Math.min((bodySize.width - 16) * 224 / 384 + 16 + BADGE_BAND, bodySize.height * 0.55))
        : 0;
    const insetTop = portraitTouch ? BADGE_BAND : 0;
    const insetBottom = portraitTouch ? Math.max(0, bodySize.height - pictureRegion) + 6 : 0;
    React.useEffect(() => {
        emulator.dock.screen.setPictureInsets({ top: insetTop, right: side, bottom: insetBottom, left: side });
    }, [emulator.dock.screen, insetTop, insetBottom, side]);

    // on a phone's few pixels Auto fills the room in whole device pixels rather than whole picture pixels, as one
    // picture pixel to three device pixels is still square and twice the size of what Auto gives otherwise
    React.useEffect(() => {
        emulator.dock.screen.setDevicePixelAuto(compact !== undefined);
    }, [emulator.dock.screen, compact]);

    // the strip comes back when the pointer moves over the screen panel and goes once it has been still for a while.
    // Scoped to the screen panel, as in Debug mode it is one tile among several. Pinned, none of this runs.
    React.useEffect(() => {
        const area = emulator.dock.screen.node;
        const stripNode = emulator.dock.screen.strip;
        if (!immersive || pinned) {
            stripNode.classList.remove('vp-strip-layer-idle');
            return undefined;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        // set while the pointer rests inside the strip: a resting pointer fires no more `pointermove` to push the timer
        // back, so the timer's callback must know not to act
        let overStrip = false;

        const clear = (): void => {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
        };
        const scheduleHide = (): void => {
            clear();
            timer = setTimeout(() => {
                if (!overStrip) {
                    stripNode.classList.add('vp-strip-layer-idle');
                }
            }, STRIP_IDLE_DELAY);
        };
        const wake = (): void => {
            stripNode.classList.remove('vp-strip-layer-idle');
            scheduleHide();
        };
        wake();
        // a non-mouse pointer may never hold still (a headset browser's laser follows every tremor of the hand), so only a
        // real movement counts, or the strip would never go
        let restingAt: { x: number; y: number } | undefined;
        const move = (event: PointerEvent): void => {
            if (event.pointerType !== 'mouse') {
                if (restingAt && Math.hypot(event.clientX - restingAt.x, event.clientY - restingAt.y)
                    < STRIP_WAKE_DISTANCE) {
                    return;
                }
                restingAt = { x: event.clientX, y: event.clientY };
            }
            wake();
        };
        area.addEventListener('pointermove', move);
        // a pointer that does not hover (finger, pen, headset laser) moves only while down, so a press wakes the strip too;
        // the waking press lands on the picture, the next one can reach the strip
        area.addEventListener('pointerdown', wake);

        // a mouse leaving the panel takes the strip with it at once. Any other pointer leaves after every press, so for
        // it the delay decides
        const leaveArea = (event: PointerEvent): void => {
            overStrip = false;
            if (event.pointerType !== 'mouse') {
                scheduleHide();
                return;
            }
            clear();
            stripNode.classList.add('vp-strip-layer-idle');
        };
        area.addEventListener('pointerleave', leaveArea);

        // resting on the strip pauses the countdown, leaving it over the picture starts a fresh one
        const enterStrip = (): void => {
            overStrip = true;
            clear();
        };
        const enterStripBy = (event: PointerEvent): void => {
            // only a hovering pointer rests on the strip, a press-and-release one would hold it up for good on its first tap
            if (event.pointerType === 'mouse') {
                enterStrip();
            }
        };
        const leaveStrip = (): void => {
            overStrip = false;
            scheduleHide();
        };
        stripNode.addEventListener('pointerenter', enterStripBy);
        stripNode.addEventListener('pointerdown', wake);
        stripNode.addEventListener('pointerleave', leaveStrip);

        return () => {
            clear();
            area.removeEventListener('pointermove', move);
            area.removeEventListener('pointerdown', wake);
            area.removeEventListener('pointerleave', leaveArea);
            stripNode.removeEventListener('pointerenter', enterStripBy);
            stripNode.removeEventListener('pointerdown', wake);
            stripNode.removeEventListener('pointerleave', leaveStrip);
        };
    }, [immersive, pinned, emulator.dock.screen]);

    // beside the screen in both modes. Only one of the five is open at a time, which the host enforces
    const saveStatesBeside =
        (emulator.state.showSaveStates ?? false) && emulator.renderSaveStates && !showingPlaceholder;
    const cheatsBeside = emulator.state.showCheats && !showingPlaceholder;
    const macrosBeside = emulator.state.showMacros && !showingPlaceholder;
    const patchesBeside = emulator.state.showPatches && !showingPlaceholder;
    const achievementsBeside = emulator.state.showAchievements && !showingPlaceholder;

    // what the picture does not show (cheats, patches, macros, profiling). They follow the picture wherever the dock
    // puts it; the screen panel is imperative DOM, so they go in through its slot
    const badges = !showingPlaceholder && !bare
        ? createPortal(
            <>
                {emulator.activeCheats > 0 &&
                    <EmulatorCheatBadge
                        count={emulator.activeCheats}
                        onShow={() => emulator.showCheats()}
                    />
                }
                {emulator.activePatches > 0 &&
                    <EmulatorPatchBadge
                        count={emulator.activePatches}
                        onShow={() => emulator.showPatches()}
                    />
                }
                {/* shown even with the macros beside the screen, unlike the cheats' badge: a recording is worth
                    saying loudly wherever the panel is */}
                <EmulatorMacroBadge
                    activity={emulator.macroActivity}
                    onShow={() => emulator.showMacros()}
                    onCancelRecording={() => emulator.cancelMacroRecording()}
                />
                {/* in every mode: the toolbar's stop button is a Debug mode control, and profiling goes on in Play */}
                <EmulatorProfileBadge
                    profiling={emulator.profiling}
                    onStop={() => emulator.runCommand(EmulatorCommands.PROFILE_STOP.id)}
                />
                {/* beside the macro badge: same news, something other than the player presses the buttons */}
                <EmulatorMovieBadge
                    playing={emulator.moviePlaying}
                    frame={emulator.movieFrame}
                    length={emulator.movieLength}
                    onStop={() => emulator.stopMoviePlayback()}
                />
                {/* the stop button lives in a self-hiding strip, and the file does not exist until stopped */}
                <EmulatorVideoBadge
                    recording={emulator.recordingVideo ?? false}
                    seconds={() => emulator.recordedSeconds?.() ?? 0}
                    onStop={() => emulator.runAction(EmulatorAction.VideoRecord)}
                />
                <EmulatorLeaderboardTracker achievements={emulator.retroAchievements} />
            </>,
            emulator.dock.screen.badges,
        )
        : undefined;

    // in the opposite corner, what the machine is doing, only where the chrome hides itself: with a toolbar up its lit
    // buttons already say it
    const stateBadges = immersive
        ? createPortal(<EmulatorStateBadges host={emulator} />, emulator.dock.screen.stateBadges)
        : undefined;

    /**
     * Portalled into the screen panel's node, so in Debug mode the strip stays in the screen tile and hides with it
     * when tabbed away. There is no wrapping div or idle class: the node already carries `.vp-strip-layer`, and the
     * effect above toggles its idle class directly. The rewind filmstrip takes the strip's place while open, in a
     * hosted chrome too, whose transport is elsewhere.
     */
    const browsingHistory = (emulator.rewindBrowser?.isOpen ?? false) && !showingPlaceholder && !bare;
    const strip = browsingHistory
        ? createPortal(
            <EmulatorRewindStrip browser={emulator.rewindBrowser!} />,
            emulator.dock.screen.strip,
        )
        : immersive && !compactPlay
            ? createPortal(
                <EmulatorControlStrip
                    host={emulator}
                    pinned={pinned}
                    onTogglePinned={() => setPinned(was => !was)}
                />,
                emulator.dock.screen.strip,
            )
            : undefined;

    const touch = showTouch
        ? <div
            className={'vp-touch-area' + (compactPlay ? '' : ' vp-touch-overlay')}
            style={portraitTouch ? { top: pictureRegion } : undefined}
        >
            <EmulatorTouchControls
                // a fresh controller for the editor and back, so no finger is carried across
                key={editingLayout ? 'editing' : 'playing'}
                settings={emulator.settings}
                orientation={orientation}
                onKeys={keys => emulator.setTouchKeys?.(keys)}
                editing={editingLayout
                    ? {
                        onDone: layout => emulator.finishTouchLayoutEditing?.(layout),
                        onCancel: () => emulator.finishTouchLayoutEditing?.(),
                    }
                    : undefined}
            />
        </div>
        : undefined;

    // the one panel that is open, for a phone, which shows it in a sheet over the picture rather than beside it
    const sidePanel = saveStatesBeside ? emulator.renderSaveStates?.()
        : cheatsBeside ? emulator.renderCheats()
            : macrosBeside ? emulator.renderMacros()
                : patchesBeside ? emulator.renderPatches()
                    : achievementsBeside ? emulator.renderAchievements()
                        : undefined;
    const closePanel = (): void => {
        if (saveStatesBeside) {
            emulator.toggleSaveStates?.();
        } else if (cheatsBeside) {
            emulator.toggleCheats();
        } else if (macrosBeside) {
            emulator.toggleMacros();
        } else if (patchesBeside) {
            emulator.togglePatches();
        } else if (achievementsBeside) {
            emulator.toggleAchievements();
        }
    };
    const panelSheet = compact !== undefined && sidePanel !== undefined && sidePanel !== null
        ? <BottomSheet
            tall
            label={nls.localize('vueport/quickMenu/panels', 'Panels')}
            onClose={closePanel}
            className='vp-panel-sheet'
        >
            <CompactPanelTabs host={emulator} onClose={closePanel} />
            <div className='vp-panel-sheet-body vp-split vp-scroll'>{sidePanel}</div>
        </BottomSheet>
        : undefined;

    return <>
        {showingPlaceholder && <div className='vp-placeholder vp-scroll'>{placeholder}</div>}
        {showingPlaceholder && inHeadset && !bare &&
            <PanelAside>
                <div className='vp-xr-no-game'>
                    <GameController size={40} />
                    <strong>{nls.localize('vueport/xr/noGame/title', 'No Game Running')}</strong>
                </div>
            </PanelAside>}
        {/* hidden rather than unmounted while the placeholder is up, as the Lumino dock is attached to a node inside; hidden
            here rather than on the dock's container, as this row claims the height */}
        <div
            ref={body}
            className={'vp-body'
                + (compactPlay ? ` vp-body-compact vp-body-compact-${orientation}` : '')
                + (compactPlay && showTouch ? ' vp-body-touch' : '')
                + (fullscreenLandscape ? ' vp-body-fullscreen' : '')}
            style={showingPlaceholder ? { display: 'none' } : undefined}
        >
            <div
                className='vp-dock-host'
                ref={dockHost}
                // on a phone there is no strip: a tap on the picture opens the game menu, see EmulatorQuickMenu
                onClick={compactPlay && !editingLayout ? event => {
                    const target = event.target instanceof Element ? event.target : undefined;
                    if (!target?.closest('button, a, .vp-screen-badges, .vp-screen-state-badges')) {
                        setMenuOpen(true);
                    }
                } : undefined}
            />
            {compact === undefined && <>
                {saveStatesBeside && <PanelAside>{emulator.renderSaveStates?.()}</PanelAside>}
                {cheatsBeside && <PanelAside>{emulator.renderCheats()}</PanelAside>}
                {macrosBeside && <PanelAside>{emulator.renderMacros()}</PanelAside>}
                {patchesBeside && <PanelAside>{emulator.renderPatches()}</PanelAside>}
                {achievementsBeside && <PanelAside>{emulator.renderAchievements()}</PanelAside>}
            </>}
            {touch}
        </div>
        {panelSheet}
        {menuOpen && compactPlay && <EmulatorQuickMenu host={emulator} onClose={() => setMenuOpen(false)} />}
        {!bare &&
            <div className='vp-overlay-layer'>
                {emulator.renderOverlay()}
            </div>
        }
        {badges}
        {stateBadges}
        {strip}
    </>;
}

// which panel the sheet shows, as tabs over it: on a phone the title bar that switches them on a larger screen is
// gone into the menu
function CompactPanelTabs(props: { host: EmulatorHost, onClose: () => void }): React.JSX.Element {
    const { host, onClose } = props;
    const state = host.state;
    const hardcore = host.isHardcore();
    const tab = (
        id: string, label: string, showing: boolean, icon: React.ReactNode, show: () => void, dimmed = false,
    ): React.JSX.Element =>
        <button
            key={id}
            type='button'
            role='tab'
            data-control={id}
            aria-label={label}
            aria-selected={showing}
            className={'vp-panel-sheet-tab' + (showing ? ' active' : '') + (dimmed ? ' dimmed' : '')}
            onClick={() => { if (!showing) { show(); } }}
        >
            {icon}
        </button>;
    return <div className='vp-panel-sheet-tabs' role='tablist'>
        {host.toggleSaveStates && tab('save-states', nls.localize('vueport/saveStates/title', 'Save States'),
            state.showSaveStates ?? false, <ClockCountdown size={22} />, () => host.toggleSaveStates?.())}
        {tab('cheats', nls.localize('vueport/cheats/title', 'Cheats'),
            state.showCheats, <Star size={22} />, () => host.toggleCheats(), hardcore)}
        {tab('macros', nls.localize('vueport/macros/title', 'Macros'),
            state.showMacros, <Queue size={22} />, () => host.toggleMacros(), hardcore)}
        {tab('patches', nls.localize('vueport/patches/title', 'Patches'),
            state.showPatches, <Bandaids size={22} />, () => host.togglePatches(), hardcore)}
        {tab('achievements', nls.localize('vueport/achievements/title', 'Achievements'),
            state.showAchievements, <Trophy size={22} />, () => host.toggleAchievements())}
        <button
            type='button'
            className='vp-panel-sheet-close'
            aria-label={nls.localize('vueport/state/close', 'Close')}
            onClick={onClose}
        >
            <X size={22} />
        </button>
    </div>;
}

