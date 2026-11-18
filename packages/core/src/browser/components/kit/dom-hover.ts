import type { VueportHover } from './KitContext';

// hover for hosts that do not bring their own (VES answers `VueportHover` with the studio's hover service).
// One element reused for every hover, painted from the kit's theme variables

const MARGIN = 8; // gap to both the target and the viewport edge

// how long the pointer must rest on a control, so controls crossed on the way do not flash their text
const SHOW_DELAY = 500;

let element: HTMLElement | undefined;

let pending: ReturnType<typeof setTimeout> | undefined;

function hasDocument(): boolean {
    return typeof document !== 'undefined' && !!document.body;
}

function tooltipElement(): HTMLElement {
    if (element?.isConnected) {
        return element;
    }

    element = document.createElement('div');
    element.className = 'vp-hover';
    element.setAttribute('role', 'tooltip');

    // inline, as neither the web build nor the studio loads a stylesheet for this module. The tokens carry
    // their own defaults (see `vueport-tokens.css`)
    Object.assign(element.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        zIndex: '10000',
        maxWidth: '320px',
        padding: '4px 8px',
        borderRadius: 'var(--vp-radius)',
        border: '1px solid var(--vp-line)',
        background: 'var(--vp-bg)',
        color: 'var(--vp-text)',
        fontFamily: 'var(--vp-font-ui)',
        fontSize: 'var(--vp-font-size)',
        lineHeight: 'var(--vp-line-height)',
        pointerEvents: 'none', // taking the pointer would fire the target's mouseleave and hide the hover right away
        visibility: 'hidden',
    });

    document.body.appendChild(element);
    return element;
}

function place(popup: HTMLElement, target: HTMLElement): void {
    const anchor = target.getBoundingClientRect();
    const box = popup.getBoundingClientRect();

    const below = anchor.bottom + MARGIN;
    const above = anchor.top - MARGIN - box.height;
    const top = below + box.height > window.innerHeight && above >= 0 ? above : below;

    const centered = anchor.left + anchor.width / 2 - box.width / 2;
    const left = Math.max(MARGIN, Math.min(centered, window.innerWidth - box.width - MARGIN));

    popup.style.top = `${Math.round(top)}px`;
    popup.style.left = `${Math.round(left)}px`;
}

function present(target: HTMLElement, content: string | HTMLElement): void {
    // the target may have been re-rendered out of the tree during the wait. A detached target measures as a
    // zero box, which would put the popup in the top-left corner
    if (!target.isConnected) {
        return;
    }

    const popup = tooltipElement();
    if (typeof content === 'string') {
        popup.textContent = content;
    } else {
        popup.replaceChildren(content);
    }

    popup.style.visibility = 'hidden'; // measured while hidden, so the first painted frame is already in the right spot
    popup.style.top = '0';
    popup.style.left = '0';
    place(popup, target);
    popup.style.visibility = 'visible';
}

export const DOM_HOVER: VueportHover = {
    show(target: HTMLElement, content: string | HTMLElement): void {
        if (!hasDocument() || !content) {
            return;
        }

        clearTimeout(pending); // restarted, so moving along a row of buttons shows each one's text in turn
        pending = setTimeout(() => present(target, content), SHOW_DELAY);
    },

    hide(): void {
        clearTimeout(pending);
        pending = undefined;
        if (element) {
            element.style.visibility = 'hidden';
        }
    },
};
