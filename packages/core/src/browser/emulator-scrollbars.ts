import PerfectScrollbar from 'perfect-scrollbar';
import { Disposable } from '../common/emulator-events';

// marks a container that scrolls its own content, written on the element itself (`className`, or `addClass`
// for the dock's Lumino panels) rather than in a selector list here. Not `ps`, which perfect-scrollbar adds
// to containers it has taken over
export const VUEPORT_SCROLL_MARKER = 'vp-scroll';

const SCROLL_SELECTOR = `.${VUEPORT_SCROLL_MARKER}`;

// perfect-scrollbar resets the offset of a direction without a scrollbar on every update, i.e. every scroll event, and
// any write, even of the same value, stops a smooth scroll in Chrome. Writes of the current value are therefore
// dropped; detach removes the overrides
const SCROLL_OFFSETS = ['scrollLeft', 'scrollTop'] as const;

function dropNoopScrollWrites(element: Element): void {
    for (const key of SCROLL_OFFSETS) {
        const native = Object.getOwnPropertyDescriptor(Element.prototype, key);
        if (!native?.get || !native.set) {
            continue;
        }
        const { get, set } = native;
        Object.defineProperty(element, key, {
            configurable: true,
            get(this: Element): number {
                return get.call(this);
            },
            set(this: Element, value: number): void {
                if (get.call(this) !== value) {
                    set.call(this, value);
                }
            },
        });
    }
}

function restoreScrollWrites(element: Element): void {
    for (const key of SCROLL_OFFSETS) {
        delete (element as unknown as Record<string, unknown>)[key];
    }
}

function isRail(node: Node): boolean {
    return node instanceof Element
        && (node.classList.contains('ps__rail-x') || node.classList.contains('ps__rail-y'));
}

/**
 * Perfect Scrollbar on every scrolling container, as on the dock's tab bar (see `TabBar`): same look everywhere and no
 * layout width, so content does not reflow once it grows tall enough to scroll. Watches the tree, as React creates and
 * drops the containers.
 *
 * Two traps: two scrollbars at once, as `.vp-panel` says `overflow: auto !important` to beat Lumino (answered by a
 * `.ps` rule in the scrollbars section of `emulator-widget.css`), and no horizontal scrolling with Theia's
 * `ReactWidget` setting `suppressScrollX`, which the wide VSU and Memory tables cannot live with.
 */
export class VueportScrollbars implements Disposable {

    protected readonly bars = new Map<Element, PerfectScrollbar>();
    protected readonly watched = new Map<Element, Set<Element>>();
    protected sizes: ResizeObserver | undefined;
    protected tree: MutationObserver | undefined;
    protected readonly stale = new Set<Element>();
    protected frame: number | undefined;

    // called once with the document root, as the dock, the strips and the host's windows share one document
    install(root: Element): void {
        if (this.tree) {
            return;
        }
        this.sizes = new ResizeObserver(entries => {
            for (const entry of entries) {
                const container = this.bars.has(entry.target)
                    ? entry.target
                    : entry.target.parentElement;
                if (container && this.bars.has(container)) {
                    this.stale.add(container);
                }
            }
            this.schedule();
        });
        this.tree = new MutationObserver(records => this.onMutations(records));
        this.tree.observe(root, { childList: true, subtree: true, characterData: true });
        this.scan(root);
    }

    protected scan(root: Element): void {
        if (root.matches(SCROLL_SELECTOR)) {
            this.attach(root);
        }
        root.querySelectorAll(SCROLL_SELECTOR).forEach(element => this.attach(element));
    }

    protected attach(element: Element): void {
        if (this.bars.has(element) || !this.scrolls(element)) {
            return;
        }
        dropNoopScrollWrites(element);
        // no `keyboard`: the emulator reads the arrow keys as the D-pad, so a focused panel would swallow them
        this.bars.set(element, new PerfectScrollbar(element, {
            handlers: ['click-rail', 'drag-thumb', 'wheel', 'touch'],
            wheelPropagation: true,
        }));
        this.observeContent(element);
    }

    // read before the library pins it to `overflow: hidden`: some containers only scroll under a certain parent
    // (`.vp-detail` inside a split panel), and pinning one that does not would clip its content
    protected scrolls(element: Element): boolean {
        const style = getComputedStyle(element);
        return style.overflowX !== 'visible' || style.overflowY !== 'visible';
    }

    protected detach(element: Element): void {
        const bar = this.bars.get(element);
        if (!bar) {
            return;
        }
        bar.destroy();
        restoreScrollWrites(element);
        this.bars.delete(element);
        this.stale.delete(element);
        this.sizes?.unobserve(element);
        // exactly what was watched, as a container is usually detached because it was emptied
        this.watched.get(element)?.forEach(child => this.sizes?.unobserve(child));
        this.watched.delete(element);
    }

    /**
     * Watches the content too, as a panel with a fixed share of the dock does not resize when its content grows.
     * Catches what the tree observer cannot (an image loading, a font reflowing a table). Diffed against what is
     * already watched: observing a watched element again schedules another callback, and doing that on every mutation
     * forces a layout per keystroke and frame, enough to starve a WebView's main thread.
     */
    protected observeContent(element: Element): void {
        let watched = this.watched.get(element);
        if (!watched) {
            watched = new Set();
            this.watched.set(element, watched);
            this.sizes?.observe(element);
        }
        const children = new Set(Array.from(element.children).filter(child => !isRail(child)));
        for (const child of children) {
            if (!watched.has(child)) {
                this.sizes?.observe(child);
                watched.add(child);
            }
        }
        for (const child of Array.from(watched)) {
            if (!children.has(child)) {
                this.sizes?.unobserve(child);
                watched.delete(child);
            }
        }
    }

    protected onMutations(records: MutationRecord[]): void {
        for (const record of records) {
            // the library's own rails; answering them would measure again, move the rails, and loop
            if (Array.from(record.addedNodes).every(isRail)
                && Array.from(record.removedNodes).every(isRail)
                && (record.addedNodes.length > 0 || record.removedNodes.length > 0)) {
                continue;
            }
            record.removedNodes.forEach(node => {
                if (node instanceof Element) {
                    if (this.bars.has(node)) {
                        this.detach(node);
                    }
                    node.querySelectorAll(SCROLL_SELECTOR).forEach(inner => this.detach(inner));
                }
            });
            record.addedNodes.forEach(node => {
                if (node instanceof Element) {
                    this.scan(node);
                }
            });
            const target = record.target instanceof Element
                ? record.target
                : record.target.parentElement;
            const container = target?.closest(SCROLL_SELECTOR);
            if (container && this.bars.has(container)) {
                this.stale.add(container);
                // only its own children, and only when they changed; deep text changes cannot add or remove one
                if (record.type === 'childList' && record.target === container) {
                    this.observeContent(container);
                }
            }
        }
        this.schedule();
    }

    // at most once a frame, as a React render is a burst of mutations and `update` reads layout
    protected schedule(): void {
        if (this.frame !== undefined || this.stale.size === 0) {
            return;
        }
        this.frame = requestAnimationFrame(() => {
            this.frame = undefined;
            const pending = Array.from(this.stale);
            this.stale.clear();
            for (const element of pending) {
                if (element.isConnected) {
                    this.bars.get(element)?.update();
                }
            }
        });
    }

    dispose(): void {
        if (this.frame !== undefined) {
            cancelAnimationFrame(this.frame);
            this.frame = undefined;
        }
        this.tree?.disconnect();
        this.tree = undefined;
        this.sizes?.disconnect();
        this.sizes = undefined;
        for (const element of Array.from(this.bars.keys())) {
            this.detach(element);
        }
        this.stale.clear();
    }
}
