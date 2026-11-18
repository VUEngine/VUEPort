/**
 * The settings window, steered with a game pad by focus, so panes need not know a pad exists. In the rail, up and down
 * open tabs and right or A enters the pane; the shoulders turn tabs from anywhere and put focus on the pane's first
 * control. In the pane, the d-pad moves to the nearest control (left past the last one goes back to the rail), A
 * presses, and left and right move a slider or segmented control until its end. B or Home close the window; B first
 * closes an open dropdown. Inactive while the Input pane waits for a button to bind. The keyboard steers the same way
 * (see steerSettingsWithKeyboard). The focus ring shows only while steering: `is-pad-steered`, removed by the mouse.
 */
import { pushEscapeLayer } from 'vueport-core/lib/browser/components/kit/escape-layers';
import { XR_LAYOUT_CLASS } from 'vueport-core/lib/browser/emulator-xr-dom';
import { PadCommand, PadDirection, steerWindowWithGamepad } from './web-gamepad-ui';

// in a headset the settings stay up beside the game (see WebEmulator.headsetPanels) and pad and keyboard belong to the
// game; the controllers point at the settings instead
function inHeadset(): boolean {
    return document.documentElement.classList.contains(XR_LAYOUT_CLASS);
}

const STEERED = 'is-pad-steered';

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

const SCROLL_SHARE = 0.6; // share of the pane a direction with nowhere to go scrolls instead

interface SettingsParts {
    dialog: HTMLElement;
    rail: HTMLElement;
    body: HTMLElement;
}

function partsOf(): SettingsParts | undefined {
    const rail = document.querySelector<HTMLElement>('.vp-settings-tabs');
    const dialog = rail?.closest<HTMLElement>('.vp-window');
    const body = dialog?.querySelector<HTMLElement>('.vp-window-body');
    return rail && dialog && body ? { dialog, rail, body } : undefined;
}

function isStop(element: HTMLElement): boolean {
    if (element.tabIndex < 0
        // the scroll bar's thumb takes focus too, for the keyboard's sake
        || element.matches(':disabled, [aria-disabled="true"], .disabled, .vp-range-value, .ps__thumb-x, .ps__thumb-y')
        || element.closest('[inert], [aria-hidden="true"]')) {
        return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
}

function stopsIn(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isStop);
}

function gap(fromStart: number, fromEnd: number, start: number, end: number): number {
    return Math.max(0, start - fromEnd, fromStart - end);
}

// the closest stop wholly past the edge, a sideways offset counting double, so the control straight below wins over a
// nearer one off to the side
function nearest(from: HTMLElement, stops: HTMLElement[], direction: PadDirection): HTMLElement | undefined {
    const origin = from.getBoundingClientRect();
    let best: HTMLElement | undefined;
    let bestScore = Infinity;
    for (const stop of stops) {
        if (stop === from || stop.contains(from) || from.contains(stop)) {
            continue;
        }
        const box = stop.getBoundingClientRect();
        let along: number;
        let across: number;
        switch (direction) {
            case 'down':
                along = box.top - origin.bottom;
                across = gap(origin.left, origin.right, box.left, box.right);
                break;
            case 'up':
                along = origin.top - box.bottom;
                across = gap(origin.left, origin.right, box.left, box.right);
                break;
            case 'right':
                along = box.left - origin.right;
                across = gap(origin.top, origin.bottom, box.top, box.bottom);
                break;
            case 'left':
                along = origin.left - box.right;
                across = gap(origin.top, origin.bottom, box.top, box.bottom);
                break;
        }
        // rows are not always laid out to the pixel
        if (along < -2) {
            continue;
        }
        const score = Math.max(0, along) + across * 2;
        if (score < bestScore) {
            bestScore = score;
            best = stop;
        }
    }
    return best;
}

function focus(element: HTMLElement): void {
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function press(element: HTMLElement, key: string): void {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function activeTab(rail: HTMLElement): HTMLElement | undefined {
    return rail.querySelector<HTMLElement>('.vp-settings-tab.active')
        ?? rail.querySelector<HTMLElement>('.vp-settings-tab') ?? undefined;
}

const PANE_WAIT_FRAMES = 90;

// bumped by every tab turned, so a pane still being waited for gives way to the next
let turnSerial = 0;

// the pane comes a render (or a chunk) later, so it is waited for until the body holds only controls that were not
// there before the switch
function turnTab(rail: HTMLElement, body: HTMLElement, step: number, intoPane: boolean): void {
    const tabs = [...rail.querySelectorAll<HTMLElement>('.vp-settings-tab')];
    const current = tabs.findIndex(tab => tab.classList.contains('active'));
    const next = tabs[current + step];
    if (!next) {
        if (tabs[current]) {
            focus(tabs[current]);
        }
        return;
    }
    const before = new Set(stopsIn(body));
    next.click();
    focus(next);
    const serial = ++turnSerial;
    if (!intoPane) {
        return;
    }
    let frames = 0;
    const look = (): void => {
        if (serial !== turnSerial || document.activeElement !== next) {
            return;
        }
        const stops = stopsIn(body);
        if (stops.length > 0 && !stops.some(stop => before.has(stop))) {
            body.scrollTop = 0;
            focus(stops[0]);
        } else if (++frames < PANE_WAIT_FRAMES) {
            requestAnimationFrame(look);
        }
    };
    requestAnimationFrame(look);
}

function enterPane(body: HTMLElement): void {
    const stops = stopsIn(body);
    const view = body.getBoundingClientRect();
    const target = stops.find(stop => {
        const box = stop.getBoundingClientRect();
        return box.bottom > view.top && box.top < view.bottom;
    }) ?? stops[0];
    if (target) {
        focus(target);
    }
}

// false when already at that end, so the press can move focus instead
function adjust(element: HTMLElement, direction: 'left' | 'right'): boolean {
    const sign = direction === 'right' ? 1 : -1;
    if (element instanceof HTMLInputElement && element.type === 'range') {
        const min = Number(element.min || 0);
        const max = Number(element.max || 100);
        const step = Number(element.step) || 1;
        const current = Number(element.value);
        // or 0.1 steps drift into 1.7000000000000002
        const decimals = (String(step).split('.')[1] ?? '').length;
        const next = Number(Math.min(max, Math.max(min, current + sign * step)).toFixed(decimals));
        if (next === current) {
            return false;
        }
        // through the prototype's setter, which React's change tracking watches; assigning value would be swallowed
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, String(next));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }
    const options = [...element.querySelectorAll<HTMLElement>(':scope > .vp-radio-option')];
    if (options.length > 0) {
        const current = options.findIndex(option => option.classList.contains('selected'));
        for (let index = current + sign; index >= 0 && index < options.length; index += sign) {
            if (!options[index].classList.contains('disabled')) {
                options[index].click();
                return true;
            }
        }
        return false;
    }
    return false;
}

// for when what had focus is gone
let lastZone: 'rail' | 'pane' | undefined;

function steer(command: PadCommand, close: () => void): void {
    const parts = partsOf();
    if (!parts) {
        return;
    }
    const { dialog, rail, body } = parts;
    // a button being bound: the press is the answer, not navigation
    if (dialog.querySelector('.vp-input-capture')) {
        return;
    }
    dialog.classList.add(STEERED);

    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const inRail = focused !== undefined && rail.contains(focused);
    const inPane = focused !== undefined && body.contains(focused) && focused !== body;
    const dropdownOpen = inPane && focused.getAttribute('aria-expanded') === 'true';

    switch (command) {
        case 'palette':
            close();
            return;
        case 'cancel':
            if (dropdownOpen) {
                press(focused, 'Escape');
            } else {
                close();
            }
            return;
        case 'previous':
        case 'next':
            turnTab(rail, body, command === 'next' ? 1 : -1, true);
            return;
        case 'start':
            return;
    }

    // nothing of the window has focus (just opened, search field, or the control was redrawn), so the press only shows
    // where the pad is
    if (!inRail && !inPane) {
        const tab = activeTab(rail);
        if (lastZone === 'pane' && stopsIn(body).length > 0) {
            enterPane(body);
        } else if (tab) {
            focus(tab);
        }
        return;
    }
    lastZone = inRail ? 'rail' : 'pane';

    if (inRail) {
        switch (command) {
            case 'up':
            case 'down':
                turnTab(rail, body, command === 'down' ? 1 : -1, false);
                return;
            case 'right':
            case 'confirm':
                enterPane(body);
                return;
        }
        return;
    }

    if (dropdownOpen) {
        switch (command) {
            case 'up':
                press(focused, 'ArrowUp');
                return;
            case 'down':
                press(focused, 'ArrowDown');
                return;
            case 'confirm':
                press(focused, 'Enter');
                return;
        }
        return;
    }

    if (command === 'confirm') {
        if (focused instanceof HTMLButtonElement || focused instanceof HTMLAnchorElement
            || (focused instanceof HTMLInputElement && (focused.type === 'checkbox' || focused.type === 'radio'))) {
            focused.click();
        }
        return;
    }

    if ((command === 'left' || command === 'right') && adjust(focused, command)) {
        return;
    }
    const next = nearest(focused, stopsIn(body), command);
    if (next) {
        focus(next);
    } else if (command === 'left') {
        const tab = activeTab(rail);
        if (tab) {
            focus(tab);
        }
    } else if (command === 'up' || command === 'down') {
        // nothing further that way, but maybe text
        body.scrollBy({ top: (command === 'down' ? 1 : -1) * body.clientHeight * SCROLL_SHARE });
    }
}

export function steerSettingsWithGamepad(close: () => void): () => void {
    lastZone = undefined;
    const release = steerWindowWithGamepad(command => {
        if (!inHeadset()) {
            steer(command, close);
        }
    });
    const unsteer = (): void => {
        // removing a class that is not there still counts as a change to the document
        const dialog = partsOf()?.dialog;
        if (dialog?.classList.contains(STEERED)) {
            dialog.classList.remove(STEERED);
        }
    };
    document.addEventListener('pointermove', unsteer, true);
    document.addEventListener('pointerdown', unsteer, true);
    return () => {
        release();
        document.removeEventListener('pointermove', unsteer, true);
        document.removeEventListener('pointerdown', unsteer, true);
    };
}

const KEY_COMMANDS: Record<string, PadCommand | undefined> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Enter: 'confirm',
    Escape: 'cancel',
    Backspace: 'cancel',
};

const ONE_LINE = ['text', 'search', 'url', 'email', 'password', 'tel'];

// Escape never belongs to the field, as it closes the window from anywhere. A one-line field gives up up and down, the
// way out of the search box and onto the rail
function fieldKeeps(target: HTMLElement | undefined, key: string): boolean {
    if (!target || key === 'Escape') {
        return false;
    }
    if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return true;
    }
    if (!(target instanceof HTMLInputElement)
        || ['button', 'checkbox', 'radio', 'submit', 'reset', 'range'].includes(target.type)) {
        return false;
    }
    return !(ONE_LINE.includes(target.type) && (key === 'ArrowUp' || key === 'ArrowDown'));
}

/**
 * Returns the release, for the window's unmount. Tab keeps the browser's focus order and only turns the ring on; the
 * arrows move by position. Its Escape layer sits above the window's, so it answers Escape for it, while anything opened
 * over the settings (key binding, color picker, question, command palette) takes a layer above and keeps its keys. An
 * open dropdown keeps its keys too; a closed one keeps Enter, which opens it.
 */
export function steerSettingsWithKeyboard(close: () => void): () => void {
    const layer = pushEscapeLayer();
    const onKeyDown = (event: KeyboardEvent): void => {
        // untrusted: the steering's own Escape and Enter, passed on to an open dropdown
        if (!event.isTrusted || !layer.isTop() || event.defaultPrevented
            || event.ctrlKey || event.metaKey || event.altKey || inHeadset()) {
            return;
        }
        const parts = partsOf();
        if (!parts) {
            return;
        }
        if (event.key === 'Tab') {
            parts.dialog.classList.add(STEERED);
            return;
        }
        const command = KEY_COMMANDS[event.key];
        const target = event.target instanceof HTMLElement ? event.target : undefined;
        if (!command || event.shiftKey || fieldKeeps(target, event.key)
            || target?.closest('[aria-expanded="true"]')) {
            return;
        }
        // Enter on what the pad does not steer (the header's buttons) or on a shut dropdown is the control's own
        if (command === 'confirm' && target
            && (target.hasAttribute('aria-expanded')
                || (parts.dialog.contains(target) && !parts.rail.contains(target) && !parts.body.contains(target)))) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        steer(command, close);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
        window.removeEventListener('keydown', onKeyDown, true);
        layer.dispose();
    };
}
