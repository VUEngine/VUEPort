import {
    ArrowCircleUp, ArrowsIn, ArrowsOut, Bug, CaretLeft, Lightning, List, ShareNetwork, SlidersHorizontal, X,
} from '@phosphor-icons/react';
import { canGoFullscreen, useCompactLayout, usePageFullscreen } from 'vueport-core/lib/browser/compact-layout';
import { VbColorIcon } from 'vueport-core/lib/browser/components/kit/VbColorIcon';
import { EmulatorAction, EmulatorMode } from 'vueport-core/lib/browser/emulator-types';
import { toggleLibraryDrawer, useLibraryDrawer } from './web-library-drawer';
import * as React from 'react';
import { DOM_HOVER } from 'vueport-core/lib/browser/components/kit/dom-hover';
import TitleBar, { TitleBarWindowControls } from 'vueport-core/lib/browser/components/TitleBar';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import {
    WindowChrome,
    isDesktop,
    isWindowFullscreen,
    minimizeWindow,
    onWindowFullscreenChange,
    requestQuit,
    toggleMaximizeWindow,
    windowChrome,
} from './desktop-bridge';
import { WebEmulator } from './web-emulator';
import { VUEPORT_URL } from './web-homebrew';
import { cachedRom, lookupRom } from './web-planet-vb';
import { onDidChangeUpdateState, pendingRelease } from './desktop-update';

// the strip itself is core's and shared with the studio; this adds what only this build has: a ROM it can name, look up
// and close, and on the desktop its window
export default function WebTitleBar(props: { emulator: WebEmulator }): React.JSX.Element {
    const { emulator } = props;
    const rom = emulator.fileName;

    // Planet VB's romTitle for this exact dump, as file names are often cryptic. Same CRC32 cache as the Game
    // Information window, so opening it costs no second request; the file name is used until a title arrives
    const hash = emulator.romChecksum;
    const [romTitle, setRomTitle] = React.useState<string | undefined>(cachedRom(hash)?.game?.romTitle);
    React.useEffect(() => {
        const cached = cachedRom(hash);
        if (cached) {
            setRomTitle(cached.game?.romTitle);
            return undefined;
        }
        setRomTitle(undefined);
        let live = true;
        lookupRom(hash)
            .then(result => { if (live) { setRomTitle(result?.romTitle); } })
            .catch(() => { if (live) { setRomTitle(undefined); } });
        return () => { live = false; };
    }, [hash]);
    const displayName = romTitle || rom;
    const compact = useCompactLayout() !== undefined;

    // read off the state the About window and the command share, so all three agree and only one ever asks
    const [update, setUpdate] = React.useState(pendingRelease);
    React.useEffect(() => {
        const subscription = onDidChangeUpdateState(() => setUpdate(pendingRelease));
        // a check that finished between the first render and here
        setUpdate(pendingRelease);
        return () => subscription.dispose();
    }, []);

    // no window controls until the shell answers, rather than controls that do nothing
    const [chrome, setChrome] = React.useState<WindowChrome>('none');
    React.useEffect(() => {
        let canceled = false;
        windowChrome().then(kind => {
            if (!canceled) {
                setChrome(kind);
            }
        }).catch(() => undefined);
        return () => { canceled = true; };
    }, []);

    // on the desktop fullscreen is the window's (see setWindowFullscreen) and can change from outside, macOS's green
    // button most of all, so it is read back
    const [fullscreen, setFullscreen] = React.useState<boolean | undefined>(undefined);
    React.useEffect(() => {
        if (!isDesktop()) {
            return undefined;
        }
        let canceled = false;
        isWindowFullscreen().then(value => {
            if (!canceled) {
                setFullscreen(value);
            }
        }).catch(() => undefined);
        const subscription = onWindowFullscreenChange(value => {
            if (!canceled) {
                setFullscreen(value);
            }
        });
        return () => {
            canceled = true;
            subscription.then(unsubscribe => unsubscribe()).catch(() => undefined);
        };
    }, []);

    // over the settings the title closes them instead; not in a headset, where the settings stay up beside the game
    const backToGame = emulator.settingsOpen && !emulator.xr.active;
    const title = rom
        // siblings, as the title is already a button and one cannot hold another
        ? <div className='vp-titlebar-rom-group'>
            <button
                type='button'
                className='vp-titlebar-rom'
                aria-label={backToGame
                    ? nls.localize('vueport/romInfo/backTo', 'Back to {0}', displayName ?? '')
                    : nls.localize('vueport/romInfo/open', 'Game information for {0}', displayName ?? '')}
                aria-haspopup={backToGame ? undefined : 'dialog'}
                onMouseEnter={event => DOM_HOVER.show(event.currentTarget, backToGame
                    ? nls.localize('vueport/romInfo/backToGame', 'Back to game')
                    : nls.localize('vueport/romInfo/hint', 'Game information'))}
                onMouseLeave={() => DOM_HOVER.hide()}
                onClick={() => {
                    DOM_HOVER.hide();
                    if (backToGame) {
                        emulator.closeSettings();
                    } else {
                        emulator.toggleRomInfo();
                    }
                }}
            >
                <span className='vp-titlebar-rom-name'>
                    {displayName}
                </span>
                {romTitle &&
                    <span className='vp-titlebar-rom-sub'>
                        {rom}
                    </span>}
            </button>
            <button
                type='button'
                className='vp-titlebar-rom-close'
                aria-label={nls.localize('vueport/rom/close', 'Close ROM')}
                onMouseEnter={event => DOM_HOVER.show(event.currentTarget,
                    nls.localize('vueport/rom/close', 'Close ROM'))}
                onMouseLeave={() => DOM_HOVER.hide()}
                onClick={() => {
                    DOM_HOVER.hide();
                    emulator.closeRom().catch(() => undefined);
                }}
            >
                <X size={14} />
            </button>
        </div>
        : <div className='vp-titlebar-rom-group'>
            <button
                type='button'
                className='vp-titlebar-rom'
                aria-label={nls.localize('vueport/about/title', 'About VUEPort')}
                aria-haspopup='dialog'
                onMouseEnter={event => DOM_HOVER.show(event.currentTarget,
                    `${nls.localize('vueport/about/title', 'About VUEPort')}`)}
                onMouseLeave={() => DOM_HOVER.hide()}
                onClick={() => { DOM_HOVER.hide(); emulator.toggleAboutWindow(); }}
            >
                <span className='vp-titlebar-rom-name'>
                    {nls.localize('vueport/titleBar/tagline', 'Virtual Boy on Stereoids')}
                </span>
                <span className='vp-titlebar-rom-sub'>
                    v{VUEPORT_VERSION}
                </span>
            </button>
        </div>;

    const updateBadge = update && <button
        type='button'
        className='vp-titlebar-pill update'
        aria-label={nls.localize('vueport/update/found', 'VUEPort {0} is available.', update.version)}
        onMouseEnter={event => DOM_HOVER.show(event.currentTarget,
            nls.localize('vueport/update/found', 'VUEPort {0} is available.', update.version))}
        onMouseLeave={() => DOM_HOVER.hide()}
        onClick={() => { DOM_HOVER.hide(); emulator.toggleUpdatesWindow(); }}
    >
        <ArrowCircleUp size={16} weight='fill' />
        <span className='vp-titlebar-pill-label'>{nls.localize('vueport/update/badge', 'Update')}</span>
    </button>;

    const logoImage = <img
        className='vp-titlebar-logo'
        src='/vueport.webp'
        alt={nls.localize('vueport/app/name', 'VUEPort')}
    />;
    const logo = isDesktop()
        ? logoImage
        : <a
            className='vp-titlebar-logo-link'
            href={VUEPORT_URL}
            rel='noopener noreferrer'
        >
            {logoImage}
        </a>;

    if (compact) {
        return <CompactTitleBar
            emulator={emulator}
            title={displayName}
            logo={logoImage}
        />;
    }

    return <TitleBar
        emulator={emulator}
        title={<>{title}{updateBadge}</>}
        logo={logo}
        windowControls={chrome as TitleBarWindowControls}
        onMinimizeWindow={() => { minimizeWindow().catch(() => undefined); }}
        onMaximizeWindow={() => { toggleMaximizeWindow().catch(() => undefined); }}
        onCloseWindow={() => { requestQuit().catch(() => undefined); }}
        fullscreen={fullscreen}
    />;
}

/**
 * The title bar on a phone: what does not fit has moved into the game menu (EmulatorQuickMenu), leaving the way out,
 * the game's name and the settings. Without a game, it holds the way into the library's side column, which is a drawer
 * there. In landscape the bar is not drawn while a game runs (style.css), as the picture needs the height and the menu
 * holds the way out.
 */
function CompactTitleBar(props: {
    emulator: WebEmulator,
    title?: string,
    logo: React.ReactNode,
}): React.JSX.Element {
    const { emulator, title, logo } = props;
    const playing = emulator.hasRom;
    const fullscreen = usePageFullscreen();
    const drawerOpen = useLibraryDrawer();
    const debugging = emulator.state.mode === EmulatorMode.DEBUG;
    return <header className={'vp-titlebar vp-titlebar-compact' + (playing ? ' playing' : '')}>
        {playing
            ? <button
                type='button'
                className='vp-titlebar-button'
                data-control='close-rom'
                aria-label={nls.localize('vueport/rom/backToLibrary', 'Back to the library')}
                onClick={() => { emulator.closeRom().catch(() => undefined); }}
            >
                <CaretLeft size={22} />
            </button>
            : <button
                type='button'
                // lit while out, as the settings' button is
                className={'vp-titlebar-button' + (drawerOpen ? ' active' : '')}
                data-control='library-drawer'
                aria-expanded={drawerOpen}
                aria-label={nls.localize('vueport/library/showSidebar', 'Show the library\'s sections')}
                onClick={toggleLibraryDrawer}
            >
                <List size={24} />
            </button>}
        {playing
            ? <button
                type='button'
                className='vp-titlebar-rom'
                aria-label={nls.localize('vueport/romInfo/open', 'Game information for {0}', title ?? '')}
                aria-haspopup='dialog'
                onClick={() => emulator.toggleRomInfo()}
            >
                <span className='vp-titlebar-rom-name'>{title}</span>
            </button>
            : logo}
        {playing && emulator.vbcHeaderPillLabel &&
            <button
                type='button'
                className='vp-titlebar-pill vp-titlebar-pill-icon'
                aria-label={emulator.vbcHeaderPillLabel}
                onClick={() => { emulator.pickHardwareMode().catch(() => undefined); }}
            >
                <VbColorIcon size={14} />
            </button>}
        {playing && emulator.isHardcore() &&
            <button
                type='button'
                className='vp-titlebar-pill vp-titlebar-pill-icon'
                aria-label={nls.localize('vueport/achievements/hardcore/title', 'Hardcore Mode')}
                onClick={() => { emulator.retroAchievements.offerToLeaveHardcore().catch(() => undefined); }}
            >
                <Lightning size={16} weight='fill' />
            </button>}
        <div className='vp-titlebar-spacer' />
        {/* not offered on a phone, but one carried over from a larger screen can be left */}
        {playing && debugging &&
            <button
                type='button'
                className='vp-titlebar-button active'
                data-control='mode'
                aria-label={nls.localize('vueport/debug/leave', 'Leave Debug mode')}
                onClick={() => emulator.toggleDebugMode()}
            >
                <Bug size={20} />
            </button>}
        <button
            type='button'
            className={'vp-titlebar-button'
                + (emulator.networkSharesOpen || emulator.lanShareActive ? ' active' : '')}
            data-control='network-shares'
            aria-label={nls.localize('vueport/shares/title', 'Network Shares')}
            onClick={() => emulator.openNetworkShares()}
        >
            <ShareNetwork size={22} weight={emulator.lanShareActive ? 'fill' : 'regular'} />
        </button>
        <button
            type='button'
            className={'vp-titlebar-button' + (emulator.settingsOpen ? ' active' : '')}
            data-control='settings'
            aria-label={nls.localize('vueport/settings/title', 'Settings')}
            onClick={() => emulator.togglePreferencesWindow()}
        >
            <SlidersHorizontal size={22} />
        </button>
        {/* also in the library, where it hides the browser's bars; Safari on the iPhone has no page fullscreen */}
        {canGoFullscreen() && <button
            type='button'
            // not lit while on, the icon turning inwards says it
            className='vp-titlebar-button'
            data-control='fullscreen'
            aria-label={fullscreen
                ? nls.localize('vueport/commands/exitFullscreen', 'Exit Fullscreen')
                : nls.localize('vueport/commands/fullscreen', 'Fullscreen')}
            onClick={() => emulator.runAction(EmulatorAction.Fullscreen)}
        >
            {fullscreen ? <ArrowsIn size={22} /> : <ArrowsOut size={22} />}
        </button>}
    </header>;
}
