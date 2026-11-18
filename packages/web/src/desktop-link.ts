import { invoke } from './desktop-bridge';

/**
 * The second player's window, built by the shell as a webview can't open one: the same page and origin, with a query
 * string naming the player and session (see src-tauri/src/link.rs). Both windows talk over a BroadcastChannel as in
 * the browser; that this reaches across two system webview windows is not assumed but measured by the webview
 * diagnostics ("BroadcastChannel between windows").
 */

// or bring it forward if it is already up
export async function openLinkWindow(query: string): Promise<void> {
    await invoke('open_link_window', { query });
}

export async function linkWindowOpen(): Promise<boolean> {
    return invoke<boolean>('link_window_open');
}

export async function closeLinkWindow(): Promise<void> {
    await invoke('close_link_window');
}
