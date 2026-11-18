import { Message } from '@lumino/messaging';
import { ISignal, Signal } from '@lumino/signaling';
import { TabBar, Widget } from '@lumino/widgets';
import PerfectScrollbar from 'perfect-scrollbar';
import { nls } from '../../common/emulator-nls';
import { EmulatorCommands } from '../emulator-commands';

/**
 * A dock tab bar whose tabs scroll when there are more than fit, with perfect-scrollbar like the shell's own. It is
 * attached here because Theia's ScrollableTabBar expects shell markup this dock does not have. The scrolling container
 * wraps the list of tabs rather than being the list: the tab bar re-renders the list from a virtual DOM, and anything
 * the scrollbar put inside it would go with the old nodes.
 */
export class VueportTabBar extends TabBar<Widget> {

    // wraps the tab list instead of being it, as the list is re-rendered from a virtual DOM
    protected readonly contentContainer: HTMLElement;
    protected readonly resetButton: HTMLElement;
    protected scrollBar: PerfectScrollbar | undefined;

    protected readonly _resetRequested = new Signal<this, void>(this);

    // only a request: what "default" means and whether to ask first is up to the host (see the dock's
    // onDidRequestResetLayout)
    get resetRequested(): ISignal<this, void> {
        return this._resetRequested;
    }

    constructor(options?: TabBar.IOptions<Widget>) {
        super({ renderer: VueportTabRenderer.instance, ...options });
        this.contentContainer = document.createElement('div');
        this.contentContainer.classList.add('lm-TabBar-content-container');
        this.node.insertBefore(this.contentContainer, this.node.firstChild);
        this.contentContainer.appendChild(this.contentNode);

        this.resetButton = document.createElement('div');
        this.resetButton.classList.add('lm-TabBar-resetButton');
        this.resetButton.title = EmulatorCommands.RESET_LAYOUT.label
            ?? nls.localize('vueport/commands/resetLayout', 'Reset Emulator Layout');
        this.node.appendChild(this.resetButton);
    }

    // on pointerdown, and stopped there: the tab bar's own pointerdown hit-tests tabs by their boxes, and tabs
    // scrolled out of view still have boxes under this button; its preventDefault then suppresses mousedown
    protected readonly onResetClicked = (event: Event) => {
        event.stopPropagation();
        this._resetRequested.emit();
    };

    // keeps double-clicks from the ancestors, where Theia would open an untitled editor in empty lm-TabBar-content
    // space; stopPropagation, not preventDefault, since TabBar renames a tab on it. The dock opens the panel picker in
    // the capture phase (see addOnDoubleClickListener)
    protected readonly containDoubleClick = (event: Event) => event.stopPropagation();

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.node.addEventListener('dblclick', this.containDoubleClick);
        this.resetButton.addEventListener('pointerdown', this.onResetClicked);
        this.scrollBar = new PerfectScrollbar(this.contentContainer, {
            suppressScrollY: true,
            handlers: ['drag-thumb', 'keyboard', 'wheel', 'touch'],
        });
    }

    protected onBeforeDetach(msg: Message): void {
        this.node.removeEventListener('dblclick', this.containDoubleClick);
        this.resetButton.removeEventListener('pointerdown', this.onResetClicked);
        this.scrollBar?.destroy();
        this.scrollBar = undefined;
        super.onBeforeDetach(msg);
    }

    protected onUpdateRequest(msg: Message): void {
        super.onUpdateRequest(msg);
        this.scrollBar?.update();
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.scrollBar?.update();
    }
}

// marks every tab as the emulator's: Lumino attaches a dragged tab's copy to the body, outside the scoped
// stylesheet, so the class styles the drag image. It also keeps that rule off a host's own tab bars
class VueportTabRenderer extends TabBar.Renderer {

    static readonly instance = new VueportTabRenderer();

    createTabClass(data: TabBar.IRenderData<Widget>): string {
        return `${super.createTabClass(data)} vp-tab`;
    }
}
