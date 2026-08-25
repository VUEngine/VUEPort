import { Message } from '@lumino/messaging';
import { TabBar, Widget } from '@lumino/widgets';
import PerfectScrollbar from 'perfect-scrollbar';

/**
 * A dock tab bar whose tabs scroll when there are more than fit.
 *
 * The same library, and so the same behaviour, as the shell's own tab bars
 * (Theia's `ScrollableTabBar`): perfect-scrollbar hides the native scrollbar
 * and draws a rail of its own, absolutely positioned over the tabs rather than
 * taking a strip of the row, and fading in on hover or while scrolling. Only
 * the scrolling part of that class is wanted here — the rest of it is the
 * shell's dropdown of open tabs and its dynamic tab sizing — and it expects
 * shell markup this dock does not have, so this attaches the scrollbar itself.
 *
 * The scrolling happens on a container wrapped around the list of tabs rather
 * than on the list itself, which is not optional: a tab bar re-renders that
 * list from a virtual DOM whenever its tabs change, and anything the scrollbar
 * had put inside it goes with the old nodes. Theia's own class wraps it for
 * the same reason.
 */
export class VesEmulatorTabBar extends TabBar<Widget> {

    protected readonly contentContainer: HTMLElement;
    protected scrollBar: PerfectScrollbar | undefined;

    constructor(options?: TabBar.IOptions<Widget>) {
        super(options);
        this.contentContainer = document.createElement('div');
        this.contentContainer.classList.add('lm-TabBar-content-container');
        // In front of whatever else the tab bar's node holds — the add button
        // — so that the tabs stay on the left and it stays on the right.
        this.node.insertBefore(this.contentContainer, this.node.firstChild);
        this.contentContainer.appendChild(this.contentNode);
    }

    /**
     * Keep a double-click on the tabs to ourselves.
     *
     * An application may well treat a double-click on empty tab bar space as
     * "open something new" — Theia does, and creates an untitled editor from
     * it. These tab bars carry the same `lm-TabBar-content` class its own do,
     * and this dock sits inside one of its widgets, so the event reaches that
     * handler by bubbling and a stray double-click here opens a blank tab in
     * the surrounding application.
     *
     * `stopPropagation` rather than `preventDefault`: only the ancestors need
     * to stop seeing it. Listeners on this node are untouched, which matters
     * because `TabBar` has one of its own for renaming a tab.
     *
     * The dock puts its own meaning on the same double-click — opening the
     * panel picker — and listens for it in the capture phase precisely because
     * this runs on the way back up. See `addOnDoubleClickListener`.
     */
    protected readonly containDoubleClick = (event: Event) => event.stopPropagation();

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.node.addEventListener('dblclick', this.containDoubleClick);
        this.scrollBar = new PerfectScrollbar(this.contentContainer, {
            // Horizontal only: the row is one tab tall.
            suppressScrollY: true,
            handlers: ['drag-thumb', 'keyboard', 'wheel', 'touch'],
        });
    }

    protected onBeforeDetach(msg: Message): void {
        this.node.removeEventListener('dblclick', this.containDoubleClick);
        this.scrollBar?.destroy();
        this.scrollBar = undefined;
        super.onBeforeDetach(msg);
    }

    /** Tabs opening and closing change how far the row reaches. */
    protected onUpdateRequest(msg: Message): void {
        super.onUpdateRequest(msg);
        this.scrollBar?.update();
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.scrollBar?.update();
    }
}
