/**
 * The page's interface around the screen in a headset: title bar on top, the state badges over the screen, the toolbar
 * and the status bar under it, the side panel (cheats, achievements, …) to the right and whatever window is open
 * (settings, …) to the left; with no game, the library where the screen would be. Each part is the page's own element,
 * copied into a texture when it changes (see emulator-xr-dom.ts) and shown as a quad of its own; pointing at one with a
 * controller is a mouse on the real element. Debug mode stays on the page.
 *
 * While a session lasts, <html> carries `vp-xr-layout`, which gives the parts the fixed sizes they have in the headset
 * (the page itself is out of sight then), so what is drawn and what is pointed at agree.
 */

import {
    isTextEntry,
    pressXrKey,
    XR_ACTIVE_CLASS,
    XR_HOVER_CLASS,
    XR_LAYOUT_CLASS,
    XrDomPointer,
    XrDomSnapshot,
    xrDomTarget,
    XrStateSheet,
} from './emulator-xr-dom';
import { XR_KEYBOARD_PIXELS, XrKeyboard } from './emulator-xr-keyboard';
import { Point3, XrOverlay, XrOverlayHit, yawAxes } from './emulator-xr-render';

// meters a CSS pixel of the page takes up at the screen's distance: about one display pixel of a Quest 3 there.
// For a screen of the standard width (XR_DEFAULT_SCREEN); the interface grows and shrinks with the screen
export const XR_UI_METERS_PER_PIXEL = 0.0014;
const XR_UI_STANDARD_SCREEN_WIDTH = 1.2;
// canvas pixels per CSS pixel: a little finer than a headset resolves at that size, for the text's sake
const XR_UI_SCALE = 1.5;
// between the parts, in meters
const XR_UI_GAP = 0.04;
// the side panels' heights, set on <html> to match the middle's window (see the .vp-xr-layout rules)
const PANEL_HEIGHT = '--vp-xr-panel-height';
const ASIDE_HEIGHT = '--vp-xr-aside-height';
// a window or list that pops up stands this much nearer than the middle, in meters
const XR_UI_POPUP_LIFT = 0.15;
// the side parts turn toward the player, so they are not read at a slant, their inner edges level with the screen:
// more the larger the screen, up to nearly facing each other at its largest (XR_MAX_WIDTH), so they stay in reach
const XR_UI_SIDE_YAW = 35 * Math.PI / 180;
const XR_UI_SIDE_YAW_LARGEST = 80 * Math.PI / 180;
const XR_UI_LARGEST_SCREEN_WIDTH = 4;
const XR_GAME_CLASS = 'vp-xr-game';
// a part is drawn again at most this often, in milliseconds; one part at a time
const XR_UI_REDRAW_MS = 120;
// and no sooner than this many times what drawing it took, so a part that is slow to copy (a library being scrolled)
// leaves the frames in between to the headset rather than taking them all
const XR_UI_REDRAW_SHARE = 3;
// a part that took longer than this to draw is drawn for a new hover only once the pointer has stayed this long
const XR_UI_SLOW_PART_MS = 12;
const XR_UI_HOVER_SETTLE_MS = 250;
// a stick all the way over scrolls this many CSS pixels a second
const XR_UI_SCROLL_RATE = 1400;
// in meters
const XR_KEYBOARD_WIDTH = 1.2;
// nearer than the rest, as it is looked down at
const XR_KEYBOARD_LIFT = 0.25;

// the Quest Browser brings up its own keyboard for a focused field, in a session too, so it is not given a second one
const SYSTEM_KEYBOARD = typeof navigator !== 'undefined' && /OculusBrowser/.test(navigator.userAgent);

type Slot = 'middle' | 'tabs' | 'aside' | 'window' | 'popup';

function last(selector: string): HTMLElement | undefined {
    const all = document.querySelectorAll<HTMLElement>(selector);
    return all.length ? all[all.length - 1] : undefined;
}

const FIND: Record<Slot, () => HTMLElement | undefined> = {
    // the page's own window as it is, title bar to status bar: the library in it, or a game's screen, whose place in
    // it the headset's picture takes (see screenSlot). What has a part of its own in it is left out, see nestedIn
    middle: () => document.querySelector<HTMLElement>('.vp-widget') ?? undefined,
    // the strips' tabs, which the title bar adds for a headset, and the strip under them: the play strips' panel, not
    // Debug mode's
    tabs: () => document.querySelector<HTMLElement>('.vp-xr-panel-tabs') ?? undefined,
    aside: () => last('.vp-panel-aside:not(.vp-vip-panel)'),
    // the settings, always up in a headset
    window: () => last('.vp-window-backdrop > .vp-settings-window'),
    // the topmost of what opens over everything else: another window (VR, the game's information) or a list or
    // question (the command palette); last, so it is drawn over the middle
    popup: () => last('.vp-window-backdrop > .vp-window:not(.vp-settings-window), .vp-modal-backdrop > *'),
};

class Part {
    element: HTMLElement | undefined;
    overlay: XrOverlay | undefined;
    dirty = true;
    drawnAt = -Infinity;
    drawn = false;
    // what drawing it took last time, in milliseconds, see XR_UI_REDRAW_SHARE
    cost = 0;
    // when the pointer last changed what it is over in it, for drawing a slow part only once it settles
    hoveredAt: number | undefined;

    constructor(readonly slot: Slot) { }
}

export interface XrRay {
    origin: Point3;
    direction: Point3;
}

export interface XrUiAim {
    overlay: XrOverlay;
    hit: XrOverlayHit;
}

export class XrUi {
    // interfaces up, as a resumed session's can come before the old one's has gone
    protected static active = 0;
    protected readonly parts = (Object.keys(FIND) as Slot[]).map(slot => new Part(slot));
    protected readonly snapshot = new XrDomSnapshot();
    protected readonly pointer = new XrDomPointer();
    protected readonly states = new XrStateSheet();
    protected readonly keyboard = new XrKeyboard();
    protected readonly keyboardOverlay: XrOverlay;
    protected keyboardShown = false;
    protected readonly observer: MutationObserver;
    protected drawing = false;
    protected changed = true;
    protected shownKey = '';
    protected aimed: { part: Part; x: number; y: number } | 'keyboard' | undefined;
    protected screen = { width: XR_UI_STANDARD_SCREEN_WIDTH, height: 0.7, z: -2 };
    protected lowest = 0;
    protected disposed = false;
    protected panelHeights = '';
    // the last drawings, what each took (see XrDomSnapshot.timings), for a probe to read
    readonly stats: ({ slot: Slot; upload: number } & NonNullable<XrDomSnapshot['timings']>)[] = [];

    // whether the parts are showing; the player toggles it, a game starting hides it
    shown = false;
    // a question (a page's own confirm, the command palette) needs answering while the parts are put away
    onQuestion: (() => void) | undefined;
    // whether the screen has a game: without one the library takes its place
    game = false;

    constructor(
        protected readonly gl: WebGL2RenderingContext,
        // reports a part that failed to draw, and puts this where a probe can find it (window.__vueportXrUi)
        protected readonly debug = false,
    ) {
        XrUi.active++;
        document.documentElement.classList.add(XR_LAYOUT_CLASS);
        if (debug) {
            (window as unknown as { __vueportXrUi?: XrUi }).__vueportXrUi = this;
        }
        this.keyboardOverlay = new XrOverlay(gl, XR_KEYBOARD_PIXELS, XR_KEYBOARD_WIDTH, true);
        this.observer = new MutationObserver(records => this.onMutations(records));
        this.observer.observe(document.body,
            { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
        // what changes the picture without changing the document
        document.addEventListener('scroll', this.onEvent, true);
        document.addEventListener('input', this.onEvent, true);
        document.addEventListener('load', this.onEvent, true);
        document.addEventListener('focusin', this.onEvent, true);
        document.addEventListener('focusout', this.onEvent, true);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.pointer.leave();
        this.observer.disconnect();
        document.removeEventListener('scroll', this.onEvent, true);
        document.removeEventListener('input', this.onEvent, true);
        document.removeEventListener('load', this.onEvent, true);
        document.removeEventListener('focusin', this.onEvent, true);
        document.removeEventListener('focusout', this.onEvent, true);
        // the page's layout back, unless another session's interface is up (see EmulatorXrController.resume)
        XrUi.active--;
        if (XrUi.active === 0) {
            document.documentElement.classList.remove(XR_LAYOUT_CLASS, XR_GAME_CLASS);
            document.documentElement.style.removeProperty(PANEL_HEIGHT);
            document.documentElement.style.removeProperty(ASIDE_HEIGHT);
        }
        this.states.dispose();
        for (const part of this.parts) {
            part.overlay?.dispose();
        }
        this.keyboardOverlay.dispose();
    }

    setShown(shown: boolean): void {
        if (shown === this.shown) {
            return;
        }
        this.shown = shown;
        if (!shown) {
            this.pointer.leave();
            this.aimed = undefined;
        }
        this.changed = true;
    }

    setGame(game: boolean): void {
        if (game !== this.game) {
            this.game = game;
            this.changed = true;
        }
        // the pieces around a game's screen carry the window's outline themselves (see the .vp-xr-layout rules)
        document.documentElement.classList.toggle(XR_GAME_CLASS, game);
    }

    // in meters, centered at (0, 0, z)
    setScreen(width: number, height: number, z: number): void {
        const screen = this.screen;
        if (screen.width !== width || screen.height !== height || screen.z !== z) {
            this.screen = { width, height, z };
            this.changed = true;
            if (screen.width !== width) {
                for (const part of this.parts) {
                    part.overlay?.resize(part.overlay.pixels.width / XR_UI_SCALE * this.metersPerPixel);
                }
                this.keyboardOverlay.resize(XR_KEYBOARD_WIDTH * this.ratio);
            }
        }
    }

    protected get ratio(): number {
        return this.screen.width / XR_UI_STANDARD_SCREEN_WIDTH;
    }

    protected get metersPerPixel(): number {
        return XR_UI_METERS_PER_PIXEL * this.ratio;
    }

    // the quads to show, in the order they stack
    // what stands behind the screen: with a game, the middle's window, the picture in its place in it
    get underlays(): XrOverlay[] {
        const middle = this.part('middle');
        return this.game && this.showing(middle) ? [middle.overlay!] : [];
    }

    get overlays(): XrOverlay[] {
        const shown = this.parts
            .filter(part => this.showing(part) && !(this.game && part.slot === 'middle'))
            .map(part => part.overlay as XrOverlay);
        if (this.keyboardShown) {
            shown.push(this.keyboardOverlay);
        }
        return shown;
    }

    // without a game the window shows the library where the screen would be
    get coversScreen(): boolean {
        return !this.game && this.showing(this.part('middle'));
    }

    protected get sideYaw(): number {
        const share = (this.screen.width - XR_UI_STANDARD_SCREEN_WIDTH)
            / (XR_UI_LARGEST_SCREEN_WIDTH - XR_UI_STANDARD_SCREEN_WIDTH);
        return Math.max(XR_UI_SIDE_YAW * 0.7,
            Math.min(XR_UI_SIDE_YAW_LARGEST, XR_UI_SIDE_YAW + share * (XR_UI_SIDE_YAW_LARGEST - XR_UI_SIDE_YAW)));
    }

    // how far off the parts stand, in meters, about: the screen's distance
    get distance(): number {
        return -this.screen.z;
    }

    // the bottom edge of what is shown, in meters, for the line of news under it
    get bottom(): number {
        return this.lowest;
    }

    // once a frame: finds the parts, draws one that changed, keeps the keyboard with the focus. True when the quads
    // shown or their places changed, so the session lays out its layers again
    update(time: number): boolean {
        if (this.disposed) {
            return false;
        }
        if (this.shown) {
            this.states.refresh();
        } else if (document.querySelector('.vp-modal-backdrop')) {
            // a question or list come up while the interface is put away: it is brought out for it to be answered
            this.onQuestion?.();
        }
        const now = performance.now();
        for (const part of this.parts) {
            if (part.hoveredAt !== undefined && now - part.hoveredAt >= XR_UI_HOVER_SETTLE_MS) {
                part.hoveredAt = undefined;
                part.dirty = true;
            }
        }
        // looked for only while showing, as playing is what the frame time is for then
        for (const part of this.shown ? this.parts : []) {
            const element = FIND[part.slot]();
            if (element !== part.element) {
                part.element = element;
                part.dirty = true;
                part.drawn = false;
            }
        }
        if (this.shown && !this.drawing) {
            const next = this.parts
                .filter(part => part.element && part.dirty && this.wanted(part)
                    && time - part.drawnAt >= Math.max(XR_UI_REDRAW_MS, part.cost * XR_UI_REDRAW_SHARE))
                .sort((a, b) => Number(a.drawn) - Number(b.drawn) || a.drawnAt - b.drawnAt)[0];
            if (next) {
                this.draw(next, time);
            }
        }
        const typing = this.shown && !SYSTEM_KEYBOARD && isTextEntry(document.activeElement)
            && this.parts.some(part => this.showing(part) && part.element!.contains(document.activeElement));
        if (typing !== this.keyboardShown) {
            this.keyboardShown = typing;
            this.keyboard.hover(undefined);
            this.drawKeyboard();
            this.changed = true;
        }
        for (const part of this.parts) {
            if (part.overlay) {
                part.overlay.visible = this.showing(part);
            }
        }
        this.keyboardOverlay.visible = this.keyboardShown;
        const key = this.overlays.map(overlay => this.overlayKey(overlay)).join(' ');
        if (key !== this.shownKey) {
            this.shownKey = key;
            this.changed = true;
        }
        if (this.changed) {
            this.changed = false;
            this.place();
            return true;
        }
        return false;
    }

    // --- pointing -------------------------------------------------------------------------------------------------

    // the first ray, in order of preference, that meets anything shown; the pointer goes there. Undefined, and the
    // pointer leaves the page, when none does
    aim(rays: XrRay[]): XrUiAim | undefined {
        if (!this.shown) {
            return undefined;
        }
        const quads: { overlay: XrOverlay; part: Part | 'keyboard' }[] = this.parts
            .filter(part => this.showing(part))
            .map(part => ({ overlay: part.overlay as XrOverlay, part }));
        if (this.keyboardShown) {
            quads.push({ overlay: this.keyboardOverlay, part: 'keyboard' });
        }
        for (const ray of rays) {
            let best: { overlay: XrOverlay; part: Part | 'keyboard'; hit: XrOverlayHit } | undefined;
            for (const quad of quads) {
                const hit = quad.overlay.hit(ray.origin, ray.direction);
                if (hit && (!best || hit.distance < best.hit.distance)) {
                    best = { ...quad, hit };
                }
            }
            if (best) {
                this.pointAt(best.part, best.overlay, best.hit);
                return { overlay: best.overlay, hit: best.hit };
            }
        }
        this.pointAt(undefined);
        return undefined;
    }

    protected pointAt(part: Part | 'keyboard' | undefined, overlay?: XrOverlay, hit?: XrOverlayHit): void {
        const before = this.aimed;
        if (part === 'keyboard') {
            this.aimed = 'keyboard';
            if (this.keyboard.hover(this.keyboard.keyAt(hit!.x, hit!.y))) {
                this.drawKeyboard();
            }
        } else if (part?.element && overlay && hit) {
            const box = part.element.getBoundingClientRect();
            const x = box.left + hit.x / overlay.pixels.width * box.width;
            const y = box.top + hit.y / overlay.pixels.height * box.height;
            this.aimed = { part, x, y };
            const was = this.pointer.hovered;
            if (this.pointer.move(xrDomTarget(part.element, x, y, this.nestedIn(part)), x, y)) {
                this.hoverChanged(part);
                this.hoverChanged(was && this.ownerOf(was));
            }
        } else {
            this.aimed = undefined;
        }
        if (before === 'keyboard' && this.aimed !== 'keyboard' && this.keyboard.hover(undefined)) {
            this.drawKeyboard();
        }
        if (this.aimed === undefined && this.pointer.hovered && !this.pointer.pressed) {
            const was = this.pointer.hovered;
            this.pointer.move(undefined, 0, 0);
            this.hoverChanged(this.ownerOf(was));
        }
    }

    get aiming(): boolean {
        return this.aimed !== undefined;
    }

    press(): void {
        const aimed = this.aimed;
        if (aimed === 'keyboard') {
            this.keyboard.press();
            this.drawKeyboard();
        } else if (aimed) {
            const target = xrDomTarget(aimed.part.element!, aimed.x, aimed.y, this.nestedIn(aimed.part));
            this.pointer.press(target, aimed.x, aimed.y);
            aimed.part.dirty = true;
        }
    }

    release(): void {
        const aimed = this.aimed;
        this.keyboard.release();
        if (this.keyboardShown) {
            this.drawKeyboard();
        }
        if (!this.pointer.pressed) {
            return;
        }
        const pressed = this.pointer.pressed;
        if (aimed && aimed !== 'keyboard') {
            this.pointer.release(xrDomTarget(aimed.part.element!, aimed.x, aimed.y, this.nestedIn(aimed.part)),
                aimed.x, aimed.y);
            aimed.part.dirty = true;
        } else {
            this.pointer.release(undefined, 0, 0);
        }
        this.dirtyAround(pressed);
    }

    // lean -1 (up) to 1 (down) for `seconds`, in whatever scrolls under the pointer
    scroll(lean: number, seconds: number): void {
        const aimed = this.aimed;
        if (aimed && aimed !== 'keyboard' && aimed.part.element) {
            // marked here, as a headset session delivers no scroll events
            if (this.pointer.scroll(aimed.part.element, lean * XR_UI_SCROLL_RATE * seconds)) {
                aimed.part.dirty = true;
            }
        }
    }

    /**
     * B: back, one step at a time. An open menu or a list or question over everything takes Escape (the command
     * palette keeps its filter focused, so leaving the field would never get further); a focused field is left, which
     * puts the keyboard away; then the topmost window closes by its own button, as the settings answer only a real
     * Escape key; else Escape goes to the page.
     */
    escape(): void {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest('.vp-dropdown')) {
            pressXrKey('Escape');
            return;
        }
        if (this.topmostIsModal()) {
            pressXrKey('Escape');
            return;
        }
        if (active instanceof HTMLElement && isTextEntry(active)) {
            active.blur();
            return;
        }
        const close = last('.vp-window-backdrop > .vp-window .vp-window-close');
        if (close) {
            close.click();
            return;
        }
        if (active instanceof HTMLElement) {
            active.blur();
        }
        pressXrKey('Escape');
    }

    protected topmostIsModal(): boolean {
        const shown = this.part('popup').element;
        return shown !== undefined && shown.isConnected && shown.parentElement?.matches('.vp-modal-backdrop') === true;
    }

    // --- drawing --------------------------------------------------------------------------------------------------

    protected part(slot: Slot): Part {
        return this.parts.find(part => part.slot === slot)!;
    }

    protected wanted(part: Part): boolean {
        if (!this.shown || part.element === undefined) {
            return false;
        }
        switch (part.slot) {
            case 'tabs':
                return this.part('aside').element !== undefined;
            default:
                return true;
        }
    }

    protected showing(part: Part): boolean {
        return this.wanted(part) && part.drawn && part.overlay !== undefined;
    }

    protected overlayKey(overlay: XrOverlay): string {
        return `${overlay.pixels.width}x${overlay.pixels.height}@${this.parts.find(part => part.overlay === overlay)?.slot ?? 'keyboard'}`;
    }

    protected draw(part: Part, time: number): void {
        const element = part.element!;
        const box = element.getBoundingClientRect();
        const width = Math.round(box.width);
        const height = Math.round(box.height);
        part.dirty = false;
        part.drawnAt = time;
        if (width < 1 || height < 1) {
            if (part.drawn) {
                part.drawn = false;
                this.changed = true;
            }
            return;
        }
        const pixels = { width: Math.max(1, Math.round(width * XR_UI_SCALE)), height: Math.max(1, Math.round(height * XR_UI_SCALE)) };
        let overlay = part.overlay;
        let replaced: XrOverlay | undefined;
        if (!overlay || overlay.pixels.width !== pixels.width || overlay.pixels.height !== pixels.height) {
            replaced = overlay;
            overlay = new XrOverlay(this.gl, pixels, width * this.metersPerPixel, true);
        }
        const target = overlay;
        this.drawing = true;
        this.snapshot.draw(element, { hovered: this.pointer.hovered, pressed: this.pointer.pressed }, XR_UI_SCALE,
            target.canvas, this.nestedIn(part))
            .then(size => {
                if (this.disposed) {
                    target.dispose();
                    return;
                }
                if (!size) {
                    part.drawn = false;
                    this.changed = true;
                    return;
                }
                const uploading = performance.now();
                target.upload();
                const timings = this.snapshot.timings!;
                const upload = performance.now() - uploading;
                part.cost = timings.copy + timings.serialize + timings.decode + timings.raster + upload;
                this.stats.push({ slot: part.slot, ...timings, upload });
                if (this.stats.length > 200) {
                    this.stats.shift();
                }
                if (target !== part.overlay) {
                    part.overlay = target;
                    replaced?.dispose();
                    this.changed = true;
                }
                if (!part.drawn) {
                    part.drawn = true;
                    this.changed = true;
                }
            })
            .catch(error => {
                if (this.debug) {
                    console.warn('[vueport] headset interface:', part.slot, error);
                }
                // kept as it was; tried again on the next change
                if (target !== part.overlay) {
                    target.dispose();
                }
            })
            .finally(() => {
                this.drawing = false;
            });
    }

    protected drawKeyboard(): void {
        this.keyboard.draw(this.keyboardOverlay.canvas);
        this.keyboardOverlay.upload();
    }

    // around the screen (or the library in its place): see the class comment. Side parts stand with their inner edge
    // by the screen's and turn toward the player
    protected place(): void {
        const middle = this.part('middle');
        const whole = this.showing(middle) ? middle.overlay! : undefined;
        // with a game, in the screen's own plane, as the window it is in; else a little in front of where it would be
        const z = this.game ? this.screen.z : this.screen.z + 0.01;
        const gap = XR_UI_GAP * this.ratio;
        const shown = (slot: Slot): XrOverlay | undefined => {
            const part = this.part(slot);
            return this.showing(part) ? part.overlay : undefined;
        };
        // the window, with a game standing so that the screen's place in it is where the screen is, in the screen's
        // plane; without one, in the middle
        let center = { x: 0, y: 0 };
        if (whole && this.game) {
            const slot = this.screenSlot();
            if (slot) {
                center = { x: -slot.x * this.metersPerPixel, y: slot.y * this.metersPerPixel };
            }
        }
        whole?.place(center.x, center.y, z);
        const column = whole?.width ?? this.screen.width;
        const top = whole ? center.y + whole.height / 2 : this.screen.height / 2;
        let bottom = whole ? center.y - whole.height / 2 : -this.screen.height / 2;
        const height = top - bottom;
        const middleY = (top + bottom) / 2;
        const mpp = this.metersPerPixel;
        const tabsElement = this.part('tabs').element;
        const tabsGap = tabsElement ? parseFloat(getComputedStyle(tabsElement).columnGap) || 0 : 0;
        const tabsHeight = tabsElement?.getBoundingClientRect().height ?? 0;
        const panelPixels = Math.round(height / mpp);
        this.setPanelHeights(panelPixels, panelPixels - Math.round(tabsHeight + tabsGap));
        // turned about the middle of the gap between them and the middle, as if folded there
        const side = (overlay: XrOverlay, direction: 1 | -1, upperEdge: number): void => {
            const yaw = -direction * this.sideYaw;
            const { x: across } = yawAxes(yaw);
            const fold = center.x + direction * (column / 2 + gap / 2);
            const along = gap / 2 + overlay.width / 2;
            overlay.place(fold + direction * across.x * along, upperEdge - overlay.height / 2,
                z + direction * across.z * along, yaw);
        };
        // to the right the strip under its tabs, as far apart as the tabs are; to the left the settings. Both turned
        // to the player, their tops level with the middle's
        const aside = shown('aside');
        if (aside) {
            const tabs = shown('tabs');
            if (tabs) {
                side(tabs, 1, top);
                side(aside, 1, top - tabs.height - tabsGap * mpp);
            } else {
                side(aside, 1, top);
            }
        }
        const window = shown('window');
        if (window) {
            side(window, -1, top);
        }
        shown('popup')?.place(center.x, middleY, z + XR_UI_POPUP_LIFT * this.ratio);
        bottom -= gap;
        if (this.keyboardShown) {
            const keyboard = this.keyboardOverlay;
            keyboard.place(center.x, bottom - keyboard.height / 2, z + XR_KEYBOARD_LIFT);
            bottom -= keyboard.height + gap;
        }
        this.lowest = bottom + gap;
    }

    // where the screen goes in the middle's window, in CSS pixels from the window's center (right and down): the middle
    // of the screen frame, which the .vp-xr-layout rules make as large as the screen
    protected screenSlot(): { x: number; y: number } | undefined {
        const element = this.part('middle').element;
        const frame = element?.querySelector<HTMLElement>('.vp-screen-frame');
        if (!element || !frame) {
            return undefined;
        }
        const box = element.getBoundingClientRect();
        const at = frame.getBoundingClientRect();
        const style = getComputedStyle(frame);
        const left = at.left + (parseFloat(style.paddingLeft) || 0);
        const right = at.right - (parseFloat(style.paddingRight) || 0);
        const upper = at.top + (parseFloat(style.paddingTop) || 0);
        const lower = at.bottom - (parseFloat(style.paddingBottom) || 0);
        return { x: (left + right) / 2 - (box.left + box.width / 2), y: (upper + lower) / 2 - (box.top + box.height / 2) };
    }

    // the side panels as tall as the middle's window, the strip less its tabs; laid out again, so drawn again
    protected setPanelHeights(panel: number, aside: number): void {
        const key = `${panel} ${aside}`;
        if (key === this.panelHeights || panel <= 0) {
            return;
        }
        this.panelHeights = key;
        const style = document.documentElement.style;
        style.setProperty(PANEL_HEIGHT, `${panel}px`);
        style.setProperty(ASIDE_HEIGHT, `${Math.max(0, aside)}px`);
        for (const part of this.parts) {
            if (part.slot === 'window' || part.slot === 'aside') {
                part.dirty = true;
            }
        }
    }

    // the elements of other parts inside this one's (the whole window holds the settings, the strip and its tabs),
    // which it leaves out: drawn on their own, pointed at on their own
    protected nestedIn(part: Part): Set<Element> {
        const nested = new Set<Element>();
        const element = part.element;
        for (const other of this.parts) {
            if (other !== part && other.element && element?.contains(other.element) && this.wanted(other)) {
                // a window with the backdrop it sits in, which dims the page under it there
                const backdrop = other.element.parentElement;
                nested.add(backdrop?.matches('.vp-window-backdrop, .vp-modal-backdrop') ? backdrop : other.element);
            }
        }
        return nested;
    }

    // the part a node is drawn in: the innermost holding it, as one inside another is left out of that one
    protected ownerOf(node: Node): Part | undefined {
        let owner: Part | undefined;
        for (const part of this.parts) {
            if (part.element?.contains(node) && (!owner || owner.element!.contains(part.element))) {
                owner = part;
            }
        }
        return owner;
    }

    // a quick part is drawn again at once, a slow one (library, settings) only once the pointer has settled, as
    // sweeping across it would have it drawn over and over at the cost of headset frames
    protected hoverChanged(part: Part | undefined): void {
        if (!part) {
            return;
        }
        if (part.cost < XR_UI_SLOW_PART_MS) {
            part.dirty = true;
        } else {
            part.hoveredAt = performance.now();
        }
    }

    // the part holding an element the pointer was on, as its hover or press look goes with it
    protected dirtyAround(element: Node | undefined): void {
        const owner = element && this.ownerOf(element);
        if (owner) {
            owner.dirty = true;
        }
    }

    protected onMutations(records: MutationRecord[]): void {
        for (const record of records) {
            if (!changes(record)) {
                continue;
            }
            if (stateOnly(record)) {
                this.hoverChanged(this.ownerOf(record.target));
                continue;
            }
            this.dirtyAround(record.target);
            // an ancestor changing (a class on a window around a part) may change how the parts in it look; not the
            // pointer's own state classes, which go up to <body> and would have every part drawn on every move
            if (record.type === 'attributes' && !stateOnly(record)) {
                for (const part of this.parts) {
                    if (part.element && record.target !== part.element && record.target.contains(part.element)) {
                        part.dirty = true;
                    }
                }
            }
        }
    }

    protected readonly onEvent = (event: Event): void => {
        const target = event.target;
        if (target === document) {
            this.parts.forEach(part => { part.dirty = true; });
        } else if (target instanceof Node) {
            this.dirtyAround(target);
        }
    };
}

function stateOnly(record: MutationRecord): boolean {
    if (record.attributeName !== 'class') {
        return false;
    }
    const plain = (classes: string | null): string => (classes ?? '').split(/\s+/)
        .filter(name => name && name !== XR_HOVER_CLASS && name !== XR_ACTIVE_CLASS).sort().join(' ');
    return plain(record.oldValue) === plain((record.target as Element).getAttribute('class'));
}

// whether a record changed anything: a class removed that was never there (the settings do that on every pointer
// move, the play strip on every mouse move) is recorded all the same, and would have a part drawn again for nothing
function changes(record: MutationRecord): boolean {
    return record.type !== 'attributes'
        || (record.target as Element).getAttribute(record.attributeName!) !== record.oldValue;
}
