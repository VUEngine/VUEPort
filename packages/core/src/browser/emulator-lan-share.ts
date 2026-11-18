/**
 * Playing a game in a headset whose computer cannot drive one (macOS, a PC without a runtime, VUEngine Studio): the
 * computer shares the running game in the local network, served by its host (LanShareShell: the desktop's Tauri shell,
 * the studio's backend), and VUEPort Web in the headset's browser finds it and plays it, from the start or from the
 * moment it was shared.
 *
 * A page cannot look around its network (no mDNS, no broadcast, WebRTC hides the local address), so the two meet at
 * api.vueport.net: the computer says where its share is, the headset asks what is shared in its own network, which the
 * server knows by the public address both come from (packages/server/src/lan_shares.php). Only where to find a share
 * passes through there; the game goes straight from the computer to the headset over plain http from an https page,
 * which Chrome allows for private IP literals behind its Local Network Access prompt.
 */

import { Emitter, Event } from '../common/emulator-events';
import { nls } from '../common/emulator-nls';
import { VesEmulatorSaveStateIdentity, wrapSaveState } from '../common/emulator-save-state';
import { VB_DEFAULT_DISPLAY_MODE } from '../common/vb-constants';
import { Sim } from './core/vb-core';

export const LAN_SHARES_URL = 'https://api.vueport.net/lan-shares';

export const VUEPORT_WEB_URL = 'https://play.vueport.net/';

// the server forgets a share after 90 seconds without word from its computer
const RENEW_MS = 30_000;
// JSON all the same, the server reads the body as it is. A form-safe type needs no CORS preflight, which Chrome refuses
// outright for the keepalive request that withdraws a share as the page closes
const SIMPLE_TYPE = 'text/plain';
// one address that does not answer (a VPN's, another subnet's) must not hold up the list
const REACH_TIMEOUT_MS = 4000;

export interface LanShareServerInfo {
    token: string;
    port: number;
    // host:port, one per private IPv4 address
    addresses: string[];
    device: string;
}

// the host's side: a plain http server on every private address of the computer, serving the one share under a random
// token (GET /<token>/, /rom/<name>, /state, /thumbnail.png, and / redirecting to VUEPort Web). See
// packages/desktop/src-tauri/src/lan_share.rs for the desktop's, which the studio's backend follows
export interface LanShareShell {
    // a new token each time; whatever state the last share had is gone. `web` is where typing the address into a
    // headset's browser redirects to
    start(name: string, rom: Uint8Array, web: string): Promise<LanShareServerInfo>;
    // undefined takes it away
    attach(kind: 'state' | 'thumbnail', bytes: Uint8Array | undefined): Promise<void>;
    // the addresses read afresh, as the computer may have changed networks; nothing while not sharing
    info(): Promise<LanShareServerInfo | undefined>;
    stop(): Promise<void>;
    // a file of another computer's share, for a host whose page may not reach a local port itself (the desktop's
    // webview); left out, the page fetches
    fetch?(url: string): Promise<Uint8Array>;
}

export interface LanShare {
    id: string;
    device: string;
    title: string;
    name: string;
    token: string;
    addresses: string[];
    state: boolean;
    romId?: string;
    // seconds since the epoch the share began
    since: number;
}

interface LanShareManifest {
    name: string;
    size: number;
    state: boolean;
    thumbnail: boolean;
}

export interface ReachedLanShare {
    share: LanShare;
    // http://host:port/token
    base: string;
    manifest: LanShareManifest;
}

function printable(text: string, max: number): string {
    // eslint-disable-next-line no-control-regex
    return Array.from(text.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, max).join('');
}

function randomHex(bytes: number): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// through the host where it fetches for the page (`via`), else the page's own fetch; `onProgress` hears how far the
// page's download has got, the host's comes in one piece
async function getBytes(
    url: string, via: LanShareShell | undefined, signal?: AbortSignal,
    onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
    if (via?.fetch) {
        return via.fetch(url);
    }
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }
    const total = Number(response.headers.get('content-length') ?? 0);
    if (!onProgress || !response.body || !(total > 0)) {
        return new Uint8Array(await response.arrayBuffer());
    }
    const bytes = new Uint8Array(total);
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (received + value.length > total) {
            throw new Error(`${url} sent more than it said it would`);
        }
        bytes.set(value, received);
        received += value.length;
        onProgress(received, total);
    }
    if (received !== total) {
        throw new Error(`${url} broke off before the end`);
    }
    return bytes;
}

// the shares of this network, own ones included; the caller leaves out its own
export async function listLanShares(signal?: AbortSignal): Promise<LanShare[]> {
    const response = await fetch(LAN_SHARES_URL, { signal, cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`${LAN_SHARES_URL} answered ${response.status}`);
    }
    const body = await response.json() as { shares?: LanShare[] };
    return (body.shares ?? []).sort((a, b) => b.since - a.since);
}

// Promise.any, which the configured library does not have yet
function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
    return new Promise((resolve, reject) => {
        let left = promises.length;
        if (left === 0) {
            reject(new Error('nowhere to ask'));
        }
        for (const promise of promises) {
            promise.then(resolve, error => {
                if (--left === 0) {
                    reject(error);
                }
            });
        }
    });
}

// asks every address of the share at once and keeps the first that answers. Rejects when none does: the computer is
// gone, sits in another network after all (a guest Wi-Fi with the same public address), or the browser was denied local
// network access
export async function reachLanShare(share: LanShare, via?: LanShareShell, signal?: AbortSignal): Promise<ReachedLanShare> {
    const timeout = AbortSignal.timeout(REACH_TIMEOUT_MS);
    const either = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return firstFulfilled(share.addresses.map(async address => {
        const base = `http://${address}/${share.token}`;
        const bytes = await getBytes(`${base}/`, via, either);
        const manifest = JSON.parse(new TextDecoder().decode(bytes)) as LanShareManifest;
        return { share, base, manifest };
    }));
}

// the moment the share was made, as an object URL the caller revokes; nothing without one
export async function lanShareThumbnail(
    reached: ReachedLanShare, via?: LanShareShell, signal?: AbortSignal,
): Promise<string | undefined> {
    if (!reached.manifest.thumbnail) {
        return undefined;
    }
    const bytes = await getBytes(`${reached.base}/thumbnail.png`, via, signal);
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
}

// the address the ROM is fetched from, ending in its name, as the recent list takes the name from there
export function lanShareRomUrl(reached: ReachedLanShare): string {
    return `${reached.base}/rom/${encodeURIComponent(reached.manifest.name)}`;
}

// the state is asked for whenever it is wanted, not only when the manifest read on first reaching the share said
// there was one: that is cached, and the share may have taken its moment since. Undefined if there is none after all
export async function downloadLanShare(
    reached: ReachedLanShare, withState: boolean, via?: LanShareShell, signal?: AbortSignal,
    onProgress?: (received: number, total: number) => void,
): Promise<{ name: string, rom: Uint8Array, state?: Uint8Array }> {
    const [rom, state] = await Promise.all([
        getBytes(lanShareRomUrl(reached), via, signal, onProgress),
        withState ? getBytes(`${reached.base}/state`, via, signal).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    return { name: reached.manifest.name, rom, state };
}

export interface LanShareSource {
    // the game as it runs, patches applied (a .vbz of it with its ESSound tracks, where it has them)
    readonly name: string;
    readonly data: Uint8Array;
    readonly title: string;
    readonly romId?: string;
}

export interface LanShareMoment {
    // a save state file, as the Save States panel exports one
    state: Uint8Array;
    thumbnail?: Uint8Array;
}

// a save state of right now plus its picture, labelled with the computer it came from. Identified by the ROM as it came
// off disk, as for the host's own states
export async function takeLanShareMoment(
    sim: Sim, identity: VesEmulatorSaveStateIdentity, esSoundSnapshot: unknown, device: string, romName?: string,
): Promise<LanShareMoment> {
    const state = await sim.saveState();
    const capture = await sim.capture(VB_DEFAULT_DISPLAY_MODE, 1).catch(() => undefined);
    const thumbnail = capture && capture.byteLength > 0 ? new Uint8Array(capture) : undefined;
    const file = await wrapSaveState([state], identity, esSoundSnapshot, {
        kind: 'manual',
        created: Date.now(),
        label: nls.localize('vueport/vr/shared/stateLabel', 'Shared by {0}', device),
        thumbnail,
        romName,
    });
    return { state: file, thumbnail };
}

export interface LanShareStatus {
    readonly id: string;
    readonly title: string;
    readonly info: LanShareServerInfo;
    readonly stateAt?: number;
    // false while api.vueport.net has not taken it, so headsets cannot find it in their list; the address can
    // still be typed in
    readonly registered: boolean;
}

// the computer's share, one at a time, of the running game. Starting hands the host the ROM and the moment, then
// registers with api.vueport.net every thirty seconds; stopping withdraws it from both
export class LanSharing {

    protected current: LanShareStatus | undefined;
    protected secret = '';
    protected name = '';
    protected romId: string | undefined;
    protected renewTimer: ReturnType<typeof setInterval> | undefined;
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    // a page closing takes its share off the list at once rather than ninety seconds later
    protected readonly onPageHide = (): void => {
        if (this.current) {
            this.withdraw(true);
        }
    };

    constructor(readonly shell: LanShareShell) {
        window.addEventListener('pagehide', this.onPageHide);
    }

    get status(): LanShareStatus | undefined {
        return this.current;
    }

    async start(
        source: LanShareSource, takeMoment: (device: string) => Promise<LanShareMoment | undefined>,
    ): Promise<void> {
        await this.stop();
        const info = await this.shell.start(source.name, source.data, VUEPORT_WEB_URL);
        const moment = await takeMoment(info.device);
        if (moment) {
            await this.shell.attach('state', moment.state);
            await this.shell.attach('thumbnail', moment.thumbnail);
        }
        this.secret = randomHex(16);
        this.name = source.name;
        this.romId = source.romId;
        this.current = {
            id: randomHex(8),
            title: source.title,
            info,
            stateAt: moment ? Date.now() : undefined,
            registered: false,
        };
        this.onDidChangeEmitter.fire();
        await this.renew();
        this.renewTimer = setInterval(() => { this.renew().catch(() => undefined); }, RENEW_MS);
    }

    // "Continue" starts from now on; there is no way back to starting from the beginning
    async retake(moment: LanShareMoment | undefined): Promise<void> {
        if (!this.current) {
            return;
        }
        await this.shell.attach('state', moment?.state);
        await this.shell.attach('thumbnail', moment?.thumbnail);
        this.current = { ...this.current, stateAt: moment ? Date.now() : undefined };
        this.onDidChangeEmitter.fire();
        await this.renew();
    }

    async stop(): Promise<void> {
        if (this.renewTimer !== undefined) {
            clearInterval(this.renewTimer);
            this.renewTimer = undefined;
        }
        if (!this.current) {
            return;
        }
        this.withdraw(false);
        this.current = undefined;
        this.onDidChangeEmitter.fire();
        await this.shell.stop().catch(() => undefined);
    }

    protected async renew(): Promise<void> {
        const current = this.current;
        if (!current) {
            return;
        }
        const info = await this.shell.info().catch(() => undefined) ?? current.info;
        let registered = false;
        if (info.addresses.length > 0) {
            try {
                const response = await fetch(LAN_SHARES_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': SIMPLE_TYPE },
                    // held to what the server takes: no control characters, a hundred characters of title
                    body: JSON.stringify({
                        id: current.id,
                        secret: this.secret,
                        device: printable(info.device, 60) || 'VUEPort',
                        title: printable(current.title, 100) || printable(this.name, 100) || 'Virtual Boy',
                        name: printable(this.name, 120) || 'rom.vb',
                        token: info.token,
                        addresses: info.addresses.slice(0, 8),
                        state: current.stateAt !== undefined,
                        romId: this.romId?.toLowerCase(),
                    }),
                });
                registered = response.ok;
            } catch {
                // offline, or the server is down: the share still works by address, the list just does not show it
            }
        }
        if (this.current?.id !== current.id) {
            return;
        }
        this.current = { ...this.current, info, registered };
        this.onDidChangeEmitter.fire();
    }

    protected withdraw(leaving: boolean): void {
        const current = this.current;
        if (!current) {
            return;
        }
        fetch(`${LAN_SHARES_URL}/withdraw`, {
            method: 'POST',
            headers: { 'Content-Type': SIMPLE_TYPE },
            body: JSON.stringify({ id: current.id, secret: this.secret }),
            // outlives the page, which is the point when it is closing
            keepalive: leaving,
        }).catch(() => undefined);
    }

    dispose(): void {
        window.removeEventListener('pagehide', this.onPageHide);
        this.stop().catch(() => undefined);
        this.onDidChangeEmitter.dispose();
    }
}
