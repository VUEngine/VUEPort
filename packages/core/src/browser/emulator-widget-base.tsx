import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Disposable, DisposableCollection } from '../common/emulator-events';

/**
 * A Lumino widget with somewhere to put things that have to be released.
 *
 * This is what Theia's `BaseWidget` is used for here and nothing more: Lumino's
 * own `Widget` already provides the node, the title, the classes, `update()`
 * and every lifecycle hook the panels override. Only the two disposable bags
 * are missing, so only they are added.
 */
export class VueportWidget extends Widget {

    /** Released when the widget is disposed. */
    protected readonly toDispose = new DisposableCollection();
    /** Released every time the widget leaves the DOM, and refilled on the way back in. */
    protected readonly toDisposeOnDetach = new DisposableCollection();

    dispose(): void {
        if (this.isDisposed) {
            return;
        }
        super.dispose();
        this.toDisposeOnDetach.dispose();
        this.toDispose.dispose();
    }

    protected onBeforeDetach(msg: Message): void {
        this.toDisposeOnDetach.dispose();
        super.onBeforeDetach(msg);
    }
}

/**
 * A widget whose content is React.
 *
 * Rendered from `onUpdateRequest`, which is what `update()` schedules, so a
 * panel redraws by calling `update()` and never touches React itself.
 *
 * Unlike Theia's `ReactWidget` there is no PerfectScrollbar: every panel here
 * turned it off anyway. It fought the plain `overflow: auto` the panels' own
 * CSS sets — pinning the container to `overflow: hidden` and layering a
 * synthetic rail over it, so a panel whose content merely grew taller showed
 * two scrollbars at once — and it blocked horizontal scrolling outright, which
 * the wide tables (VSU, Memory) need and native scrolling gives for free.
 */
export abstract class VueportReactWidget extends VueportWidget {

    protected readonly nodeRoot: Root;

    constructor() {
        super();
        this.nodeRoot = createRoot(this.node);
        // Unmounting is deferred because React refuses to unmount a root from
        // inside a render or lifecycle it is currently running, which is
        // exactly where a widget disposed by its own content would be.
        this.toDispose.push(Disposable.create(() =>
            setTimeout(() => this.nodeRoot.unmount(), 0)
        ));
    }

    protected onUpdateRequest(msg: Message): void {
        super.onUpdateRequest(msg);
        if (!this.isDisposed) {
            this.nodeRoot.render(<>{this.render()}</>);
        }
    }

    protected abstract render(): React.ReactNode;
}
