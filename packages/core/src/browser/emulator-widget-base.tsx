import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Disposable, DisposableCollection } from '../common/emulator-events';

// a Lumino widget with the two disposable bags, which is all Theia's BaseWidget added here
export class VueportWidget extends Widget {

    protected readonly toDispose = new DisposableCollection();
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

// a widget whose content is React, rendered from onUpdateRequest, so a panel redraws by calling update(). Unlike
// Theia's ReactWidget no PerfectScrollbar: it fought the panels' own `overflow: auto`, showing two scrollbars at once,
// and blocked horizontal scrolling, which the wide tables (VSU, Memory) need
export abstract class VueportReactWidget extends VueportWidget {

    protected readonly nodeRoot: Root;

    constructor() {
        super();
        this.nodeRoot = createRoot(this.node);
        // deferred, as React refuses to unmount a root from inside a render or lifecycle it is running, which is where
        // a widget disposed by its own content would be
        this.toDispose.push(Disposable.create(() =>
            setTimeout(() => this.nodeRoot.unmount(), 0)
        ));
    }

    // counts the trees handed to React, so a callback knows which commit first shows the state it was queued after
    protected renderGeneration = 0;
    protected readonly afterCommit: { generation: number; callback: () => void }[] = [];

    protected onUpdateRequest(msg: Message): void {
        super.onUpdateRequest(msg);
        if (!this.isDisposed) {
            const generation = ++this.renderGeneration;
            this.nodeRoot.render(<Committed generation={generation} onCommit={done => this.committed(done)}>
                {this.render()}
            </Committed>);
        }
    }

    // runs `callback` once React has put a tree built after this call into the DOM. A bare requestAnimationFrame is too
    // early: Lumino updates in a frame of its own and React commits later still, so callbacks saw the old state
    protected whenRendered(callback: () => void): void {
        this.afterCommit.push({ generation: this.renderGeneration, callback });
        this.update();
    }

    // React may drop a tree that was replaced before it committed, so every callback queued before `generation` is due
    protected committed(generation: number): void {
        if (this.isDisposed) {
            return;
        }
        const due = this.afterCommit.filter(entry => entry.generation < generation);
        if (due.length === 0) {
            return;
        }
        this.afterCommit.splice(0, this.afterCommit.length,
            ...this.afterCommit.filter(entry => entry.generation >= generation));
        due.forEach(entry => entry.callback());
    }

    protected abstract render(): React.ReactNode;
}

function Committed({ generation, onCommit, children }: {
    generation: number;
    onCommit: (generation: number) => void;
    children?: React.ReactNode;
}): React.ReactElement {
    React.useLayoutEffect(() => onCommit(generation), [generation]);
    return <>{children}</>;
}
