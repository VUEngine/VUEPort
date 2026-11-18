import * as React from 'react';
import { nls } from '../../common/emulator-nls';

// the strip beside the screen and its resize edge. The bounds keep a row's actions visible and the picture the
// larger half
const MIN_WIDTH = 260;
const MAX_WIDTH = 800;
const MAX_SHARE = 0.6; // of the row it shares with the dock
const DEFAULT_SHARE = 0.3;
const DEFAULT_MAX_WIDTH = 440;
const SNAP_DISTANCE = 16; // this close to the CSS default, the width snaps back to it and follows the window again

const STORAGE_KEY = 'vueport.aside.width';

// the width a drag left behind, or undefined for the default
function storedWidth(): number | undefined {
    try {
        const stored = Number(window.localStorage.getItem(STORAGE_KEY));
        return stored > 0 ? stored : undefined;
    } catch {
        return undefined;
    }
}

function storeWidth(width: number | undefined): void {
    try {
        if (width === undefined) {
            window.localStorage.removeItem(STORAGE_KEY);
        } else {
            window.localStorage.setItem(STORAGE_KEY, String(width));
        }
    } catch {
        // storage can be unavailable (private window); then the width just is not remembered
    }
}

// .vp-panel-aside's own flex-basis, worked out for a row this wide
function defaultWidth(row: number): number {
    return Math.min(Math.max(row * DEFAULT_SHARE, MIN_WIDTH), DEFAULT_MAX_WIDTH);
}

function maxWidth(row: number): number {
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, row * MAX_SHARE));
}

export default function PanelAside(props: { children: React.ReactNode }): React.JSX.Element {
    const [width, setWidth] = React.useState(storedWidth);
    const [dragging, setDragging] = React.useState(false);
    const aside = React.useRef<HTMLElement>(null);
    const drag = React.useRef<{ x: number, width: number, row: number, next: number | undefined } | undefined>(undefined);

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
        const node = aside.current;
        const row = node?.parentElement?.getBoundingClientRect().width;
        if (event.button !== 0 || !node || !row) {
            return;
        }
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        // the computed width, as it is measured the way flex-basis is, so the first move does not jump by
        // padding and border
        const current = parseFloat(getComputedStyle(node).width);
        drag.current = { x: event.clientX, width: current, row, next: width };
        setDragging(true);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
        const start = drag.current;
        if (!start) {
            return;
        }
        // the strip is on the right, so dragging left widens it
        const wanted = start.width + start.x - event.clientX;
        const next = Math.round(Math.min(Math.max(wanted, MIN_WIDTH), maxWidth(start.row)));
        start.next = Math.abs(next - defaultWidth(start.row)) <= SNAP_DISTANCE ? undefined : next;
        setWidth(start.next);
    };

    const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
        const start = drag.current;
        if (!start) {
            return;
        }
        drag.current = undefined;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        storeWidth(start.next);
    };

    return <>
        <div
            className={'vp-aside-sash'
                + (dragging ? ' dragging' : '')
                // held at the default, so a drag can feel where it caught
                + (dragging && width === undefined ? ' snapped' : '')}
            role='separator'
            aria-orientation='vertical'
            aria-label={nls.localize('vueport/layout/resizeSidePanel', 'Resize side panel')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => {
                setWidth(undefined);
                storeWidth(undefined);
            }}
        />
        <aside
            ref={aside}
            className='vp-panel-aside vp-split vp-scroll'
            // the same bounds as the drag, so a width dragged out in a wide window still fits a narrow one
            style={width === undefined ? undefined : {
                flexBasis: `clamp(${MIN_WIDTH}px, ${width}px, max(${MIN_WIDTH}px, min(${MAX_WIDTH}px, ${MAX_SHARE * 100}%)))`,
            }}
        >
            {props.children}
        </aside>
    </>;
}
