// outward links: in the desktop build the webview drops `<a target="_blank">`, so the shell opens them in the
// user's browser (`packages/desktop/src-tauri/src/external.rs`). Caught by one listener on the document, as
// many links are in core, which knows nothing about Tauri
import { invoke, isDesktop } from './desktop-bridge';

function isExternal(href: string): boolean {
    return /^https?:\/\//i.test(href);
}

// in a browser what the anchor would have done, so it is safe to call anywhere; `noopener` so the opened page
// cannot reach back into this one
export async function openExternal(url: string): Promise<void> {
    if (!isExternal(url)) {
        return;
    }
    if (!isDesktop()) {
        window.open(url, '_blank', 'noopener');
        return;
    }
    await invoke<void>('open_external', { url });
}

// desktop only. Capture phase, so links inside click-handling elements are caught too; anything not a web
// address (`#anchor`, a download's `blob:`) is left alone, and so is `mailto:`, which the webview hands over.
// Middle clicks too, as the desktop has nowhere else to open them
export function interceptExternalLinks(): void {
    if (!isDesktop()) {
        return;
    }
    const follow = (event: MouseEvent): void => {
        // a middle click is `auxclick` with button 1; others on that event are right clicks, for the context menu
        if (event.type === 'auxclick' && event.button !== 1) {
            return;
        }
        const target = event.target;
        const anchor = target instanceof Element ? target.closest('a[href]') : undefined;
        const href = anchor?.getAttribute('href') ?? '';
        if (!isExternal(href)) {
            return;
        }
        // first, as the webview navigating away from the running emulator has no way back
        event.preventDefault();
        openExternal(href).catch(() => {
            // not worth a dialog: the shell refuses only what it should, and a browser that will not start is the system's
            // to report
        });
    };
    document.addEventListener('click', follow, true);
    document.addEventListener('auxclick', follow, true);
}
