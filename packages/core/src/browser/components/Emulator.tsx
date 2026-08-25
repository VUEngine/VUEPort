import { MessageLoop } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import * as React from 'react';
import { VesEmulatorDock } from '../panels/emulator-dock';
import { EmulatorToolbarHost, renderEmulatorToolbar } from './EmulatorToolbar';

/**
 * What the emulator's chrome needs from the emulator itself.
 *
 * Everything the toolbar reads, plus the dock to show and the overlays to lay
 * over it.
 */
export interface EmulatorHost extends EmulatorToolbarHost {
    /** The panels: the screen, and whichever inspectors are open. */
    readonly dock: VesEmulatorDock;
    /** The controller reference and the palette and settings windows. */
    renderOverlay(): React.ReactNode;
}

export interface EmulatorProps {
    emulator: EmulatorHost;
    /**
     * Whether the emulator's own node is in the document yet.
     *
     * Lumino refuses to attach a widget to a host that is not itself attached,
     * and React effects run as soon as the tree commits — which can be before
     * the surrounding widget has been put anywhere. So the dock waits for this
     * to turn true rather than for the effect to fire.
     */
    attached: boolean;
}

/**
 * The emulator, as one React component.
 *
 * The toolbar and the overlays are React. The dock is not: it is a Lumino
 * `DockPanel`, because panels that can be dragged, split, tabbed and resized
 * are what it is for, and Lumino does that without a framework. It is attached
 * into a container this component owns but never renders into — the same
 * arrangement the screen panel uses one level down for its canvas, and for the
 * same reason: some things have to keep their identity across renders.
 */
export function Emulator(props: EmulatorProps): React.JSX.Element {
    const { emulator, attached } = props;
    const dockHost = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const host = dockHost.current;
        if (!host || !attached) {
            return undefined;
        }
        if (!emulator.dock.isAttached) {
            Widget.attach(emulator.dock, host);
        }
        // Lumino sizes a widget from resize messages, which normally arrive
        // from the layout that owns it. Nothing owns this one, so the
        // container's own size changes are what drive it.
        const observer = new ResizeObserver(() =>
            MessageLoop.sendMessage(emulator.dock, Widget.ResizeMessage.UnknownSize)
        );
        observer.observe(host);
        return () => {
            observer.disconnect();
            if (emulator.dock.isAttached) {
                Widget.detach(emulator.dock);
            }
        };
    }, [emulator.dock, attached]);

    return <>
        <div className='vueport-toolbar'>
            {renderEmulatorToolbar(emulator)}
        </div>
        <div className='vueport-dock-host' ref={dockHost} />
        <div className='vueport-overlay'>
            {emulator.renderOverlay()}
        </div>
    </>;
}
