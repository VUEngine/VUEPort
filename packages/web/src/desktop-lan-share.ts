import { LanShareServerInfo, LanShareShell } from 'vueport-core/lib/browser/emulator-lan-share';
import { bytesFrom, invoke, invokeWithBytes } from './desktop-bridge';

/**
 * The shell's side of sharing a game in the local network (src-tauri/src/lan_share.rs). It serves what is handed over
 * here on plain http on every private address of this computer, and fetches other computers' shares for the page, as
 * App Transport Security may keep the webview from reaching a local port. Registering the share with api.vueport.net
 * and everything else is core's emulator-lan-share.ts.
 */
export const desktopLanShareShell: LanShareShell = {
    async start(name: string, rom: Uint8Array, web: string): Promise<LanShareServerInfo> {
        return invokeWithBytes<LanShareServerInfo>('lan_share_start', rom, {
            'x-vueport-name': name,
            'x-vueport-web': web,
        });
    },
    async attach(kind: 'state' | 'thumbnail', bytes: Uint8Array | undefined): Promise<void> {
        await invokeWithBytes('lan_share_attach', bytes ?? new Uint8Array(0), { 'x-vueport-kind': kind });
    },
    async info(): Promise<LanShareServerInfo | undefined> {
        return await invoke<LanShareServerInfo | null>('lan_share_info') ?? undefined;
    },
    async stop(): Promise<void> {
        await invoke('lan_share_stop');
    },
    async fetch(url: string): Promise<Uint8Array> {
        return bytesFrom(await invoke<ArrayBuffer>('lan_share_fetch', { url }));
    },
};
