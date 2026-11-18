import * as React from 'react';
import { ArrowClockwise, GameController, Play, ShareNetwork, StopCircle } from '@phosphor-icons/react';
import { nls } from '../../common/emulator-nls';
import {
    LanShare,
    lanShareThumbnail,
    LanSharing,
    listLanShares,
    reachLanShare,
    ReachedLanShare,
} from '../emulator-lan-share';
import { QrCode } from './kit/QrCode';
import { Window } from './kit/Window';

// what the window needs of the emulator it belongs to; what a host leaves out, the window leaves out
export interface NetworkSharesHost {
    readonly hasRom: boolean;
    // this computer's share; without it the window says sharing needs VUEPort Desktop
    readonly lanSharing?: LanSharing;
    // shares the running game, with the moment to continue from
    shareInLan?(): Promise<void>;
    // whether the share is of the game running now, which is what a new moment can be taken of. A game shared from
    // the library stays shared while another one runs
    readonly lanShareRunning?: boolean;
    // takes the share's moment again, so "Continue" starts from now
    retakeLanShare?(): Promise<void>;
    stopLanShare?(): Promise<void>;
    // plays a game another computer shares, from its start or from the moment it was shared; without it the window
    // lists no shares (VUEngine Studio plays its own project)
    playLanShare?(reached: ReachedLanShare, resume: boolean): Promise<void>;
}

// how often the list asks api.vueport.net again while the window is open
const LIST_REFRESH_MS = 5000;

function clock(when: number): string {
    return new Date(when).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Opened from the title bar's share button: shares a game from this computer where the host can serve it (with a QR
 * code a phone's camera opens it from), and lists the games other computers in the network share, playable from the
 * start or from the moment they were shared. A headset's browser finds them here too. See emulator-lan-share.ts for how
 * the two sides meet. Both hosts show this window: the standalone build and VUEngine Studio.
 */
export default function NetworkSharesWindow(props: {
    emulator: NetworkSharesHost,
    onClose: () => void,
}): React.JSX.Element {
    const { emulator, onClose } = props;

    return <Window
        title={nls.localize('vueport/shares/title', 'Network Shares')}
        icon={<ShareNetwork size={22} />}
        onClose={onClose}
        compact
    >
        <div className='vp-vr'>
            {emulator.lanSharing
                ? <ShareHere emulator={emulator} sharing={emulator.lanSharing} />
                : <p className='vp-vr-note'>
                    {nls.localize('vueport/shares/shareOnDesktop',
                        'To send a game to a phone, tablet or headset in the same network, share it in VUEPort Desktop.')}
                </p>}
            {emulator.playLanShare && <SharedInNetwork emulator={emulator} />}
        </div>
    </Window>;
}

function ShareHere(props: { emulator: NetworkSharesHost, sharing: LanSharing }): React.JSX.Element {
    const { emulator, sharing } = props;
    const status = sharing.status;
    const [busy, setBusy] = React.useState(false);

    const run = (action: () => Promise<void>): void => {
        setBusy(true);
        action().catch(() => undefined).finally(() => setBusy(false));
    };

    if (!status) {
        return <section className='vp-vr-card'>
            <div className='vp-vr-card-icon' aria-hidden>
                <ShareNetwork size={32} />
            </div>
            <div className='vp-vr-card-text'>
                <h3>{nls.localize('vueport/shares/share/title', 'Share with a device in this network')}</h3>
                <p>
                    {emulator.hasRom
                        ? nls.localize('vueport/shares/share/hint',
                            'A phone, tablet or headset in this network can then play the game from the moment it was \
shared: scan the code with its camera, or pick the game here in VUEPort on it.')
                        : nls.localize('vueport/shares/share/openGame',
                            'Open a game to share it, or share one from its page in the library.')}
                </p>
                <p className='vp-vr-privacy'>
                    {nls.localize('vueport/shares/share/privacy',
                        'Only where to find the share goes to api.vueport.net: this computer\'s name, the game\'s title \
and its addresses in the local network. The game itself never does; the other device fetches it straight from this computer.')}
                </p>
            </div>
            <button
                type='button'
                className='vp-button'
                disabled={!emulator.hasRom || busy}
                onClick={() => run(() => emulator.shareInLan?.() ?? Promise.resolve())}
            >
                {nls.localize('vueport/vr/share/start', 'Share')}
            </button>
        </section>;
    }

    const address = status.info.addresses[0];
    return <section className='vp-vr-card sharing'>
        {/* the address itself, which the computer's server answers by sending the browser on to VUEPort with the game,
            so a phone needs nothing but its camera */}
        {address
            ? <QrCode
                value={`http://${address}/`}
                label={nls.localize('vueport/shares/qr', 'QR code for {0}', status.title)}
            />
            : <div className='vp-vr-card-icon' aria-hidden>
                <ShareNetwork size={32} weight='fill' />
            </div>}
        <div className='vp-vr-card-text'>
            <h3>{nls.localize('vueport/vr/share/sharing', 'Sharing {0}', status.title)}</h3>
            <p>
                {nls.localize('vueport/shares/share/scan',
                    'Scan the code with the camera of a phone or tablet in this network to play it there.')}
                {' '}
                {status.stateAt !== undefined
                    ? nls.localize('vueport/shares/share/moment', 'It can continue from {0}.', clock(status.stateAt))
                    : nls.localize('vueport/shares/share/noMoment', 'It plays from the start.')}
            </p>
            <p>
                {status.registered
                    ? nls.localize('vueport/shares/share/listed',
                        'It is also listed under Network Shares in VUEPort on every device in this network.')
                    : nls.localize('vueport/vr/share/unlisted',
                        'api.vueport.net could not be reached, so it is not listed.')}
            </p>
            {address &&
                <p className='vp-vr-address'>
                    {nls.localize('vueport/shares/share/address', 'Or type this into a browser there: {0}', address)}
                </p>}
            <div className='vp-vr-card-actions'>
                {/* a moment can only be taken of the game running here; one shared from the library has none to take
                    while another plays */}
                {emulator.retakeLanShare && emulator.lanShareRunning !== false && <button
                    type='button'
                    className='vp-button secondary'
                    disabled={busy || !emulator.hasRom}
                    onClick={() => run(() => emulator.retakeLanShare?.() ?? Promise.resolve())}
                >
                    <ArrowClockwise size={16} />
                    {nls.localize('vueport/vr/share/retake', 'Update Save State')}
                </button>}
                <button
                    type='button'
                    className='vp-button secondary'
                    disabled={busy}
                    onClick={() => run(() => emulator.stopLanShare?.() ?? Promise.resolve())}
                >
                    <StopCircle size={16} />
                    {nls.localize('vueport/vr/share/stop', 'Stop Sharing')}
                </button>
            </div>
        </div>
    </section>;
}

interface Found {
    // undefined while first asking
    reached?: ReachedLanShare | 'unreachable';
    asking: boolean;
    thumbnail?: string;
}

// the network's shares other than this desktop's own, each checked for whether it answers from here
function SharedInNetwork(props: { emulator: NetworkSharesHost }): React.JSX.Element {
    const { emulator } = props;
    const own = emulator.lanSharing?.status?.id;
    // the host fetches for a page that may not reach the local network itself (the desktop's webview)
    const via = emulator.lanSharing?.shell;
    const [shares, setShares] = React.useState<LanShare[] | undefined>(undefined);
    const [failed, setFailed] = React.useState(false);
    // by id and token, so a share started again (a new token) is asked again
    const asked = React.useRef(new Map<string, Found>());
    const [, setAskedVersion] = React.useState(0);
    const mounted = React.useRef(true);

    React.useEffect(() => {
        const aborter = new AbortController();
        const refresh = (): void => {
            listLanShares(aborter.signal)
                .then(list => { setShares(list); setFailed(false); })
                .catch(() => { if (!aborter.signal.aborted) { setFailed(true); } });
        };
        refresh();
        const timer = setInterval(refresh, LIST_REFRESH_MS);
        return () => {
            clearInterval(timer);
            aborter.abort();
        };
    }, []);

    React.useEffect(() => () => {
        mounted.current = false;
        for (const entry of asked.current.values()) {
            if (entry.thumbnail) {
                URL.revokeObjectURL(entry.thumbnail);
            }
        }
    }, []);

    // asking the share's computer directly is what brings up a browser's "local network" prompt, so it is done here
    // rather than at the click that wants to go into the headset at once. One that did not answer is asked again on
    // every refresh, as the prompt may have been answered since
    React.useEffect(() => {
        const publish = (): void => {
            if (mounted.current) {
                setAskedVersion(version => version + 1);
            }
        };
        for (const share of shares ?? []) {
            const key = `${share.id}:${share.token}`;
            const known = asked.current.get(key);
            if (share.id === own || known?.asking || (known?.reached !== undefined && known.reached !== 'unreachable')) {
                continue;
            }
            const entry: Found = { reached: known?.reached, asking: true };
            asked.current.set(key, entry);
            reachLanShare(share, via)
                .then(async reached => {
                    entry.reached = reached;
                    publish();
                    entry.thumbnail = await lanShareThumbnail(reached, via).catch(() => undefined);
                })
                .catch(() => { entry.reached = 'unreachable'; })
                .finally(() => {
                    entry.asking = false;
                    publish();
                });
        }
    }, [shares, own, via]);

    const others = (shares ?? []).filter(share => share.id !== own);

    return <section className='vp-vr-shared'>
        <h3>{nls.localize('vueport/vr/shared/title', 'Shared in This Network')}</h3>
        {shares === undefined && !failed &&
            <p className='vp-vr-note'>{nls.localize('vueport/vr/shared/loading', 'Looking for shared games…')}</p>}
        {failed && shares === undefined &&
            <p className='vp-vr-note'>
                {nls.localize('vueport/vr/shared/failed', 'api.vueport.net could not be reached to look for shared games.')}
            </p>}
        {shares !== undefined && others.length === 0 &&
            <p className='vp-vr-note'>
                {nls.localize('vueport/vr/shared/none',
                    'No game is shared in this network right now. Share one from VUEPort Desktop on a computer in the same network.')}
            </p>}
        {others.length > 0 &&
            <ul className='vp-vr-shares'>
                {others.map(share => {
                    const entry = asked.current.get(`${share.id}:${share.token}`);
                    const reached = entry?.reached;
                    const ready = reached !== undefined && reached !== 'unreachable' ? reached : undefined;
                    return <li key={`${share.id}:${share.token}`} className='vp-vr-share'>
                        <div className='vp-vr-share-picture'>
                            {entry?.thumbnail
                                ? <img src={entry.thumbnail} alt='' />
                                : <GameController size={28} />}
                        </div>
                        <div className='vp-vr-share-text'>
                            <span className='vp-vr-share-title'>{share.title}</span>
                            <span className='vp-vr-share-meta'>
                                {nls.localize('vueport/vr/shared/from', '{0} · since {1}',
                                    share.device, clock(share.since * 1000))}
                            </span>
                            {reached === 'unreachable' &&
                                <span className='vp-vr-share-problem'>
                                    {nls.localize('vueport/vr/shared/unreachable',
                                        'Cannot be reached from here. Is this device in the same network, and was it allowed to access the local network?')}
                                </span>}
                        </div>
                        <div className='vp-vr-card-actions'>
                            {share.state &&
                                <button
                                    type='button'
                                    className='vp-button'
                                    disabled={!ready}
                                    onClick={() => ready && emulator.playLanShare?.(ready, true)}
                                >
                                    <Play size={16} weight='fill' />
                                    {nls.localize('vueport/vr/shared/continue', 'Continue')}
                                </button>}
                            <button
                                type='button'
                                className={share.state ? 'vp-button secondary' : 'vp-button'}
                                disabled={!ready}
                                onClick={() => ready && emulator.playLanShare?.(ready, false)}
                            >
                                {nls.localize('vueport/vr/shared/fromStart', 'Start from the Beginning')}
                            </button>
                        </div>
                    </li>;
                })}
            </ul>}
    </section>;
}
