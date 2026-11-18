import * as React from 'react';
import { nls } from '../../../common/emulator-nls';
import { TouchControlPlacement, TouchControlsLayout, VueportSettings } from '../../../common/emulator-settings';
import { ArrowCounterClockwise } from '@phosphor-icons/react';
import Switch from '../kit/Switch';
import { useSetting } from '../settings/SettingFields';
import {
    BUTTON_KEYS,
    DPAD_KEYS,
    PLACEMENT_SCALE_RANGE,
    PLACEMENT_SCALE_STEP,
    PlacedControl,
    TouchControlId,
    TouchOrientation,
    isDpad,
    placeControls,
} from './touch-layout';

/**
 * A Virtual Boy controller drawn on the screen, for playing by touch. Every finger is tracked on its own, so a d-pad
 * and a button can be held together. What they hold as a whole goes to the host as one mask (onKeys), which the input
 * controller keeps apart from the keyboard's and the pads' (EmulatorInputController.setTouchKeys).
 *
 * The controls are drawn rather than buttons: a game is not played by tabbing to A, and a button would take focus away
 * from the emulator's key handler with every press. The layout editor (`editing`) is the exception, as it is a form
 * like any other.
 */

const LABELS: Record<TouchControlId, string> = {
    l: 'L', r: 'R', ldpad: '', rdpad: '', select: 'SELECT', start: 'START', b: 'B', a: 'A',
};

const HIT_SLACK = 12; // how far past its drawn edge a control still responds, as a thumb is wider than its aim
const DEAD_ZONE = 0.14; // d-pad centre without a direction, as a fraction of its width
const VIBRATION = 12; // buzz length of a press, in ms
const GRID = 16; // the editor's snap grid in CSS pixels, with the dot in the middle of each cell
// kept per device rather than as a setting, as it is about editing, not the result
const SNAP_KEY = 'vueport.touch.snap';

function storedSnap(): boolean {
    try {
        return window.localStorage.getItem(SNAP_KEY) !== 'off';
    } catch {
        return true;
    }
}

function storeSnap(on: boolean): void {
    try {
        window.localStorage.setItem(SNAP_KEY, on ? 'on' : 'off');
    } catch {
        // a private window just forgets it
    }
}

function toGrid(value: number): number {
    return Math.round((value - GRID / 2) / GRID) * GRID + GRID / 2;
}

function controlNames(): Record<TouchControlId, string> {
    return {
        l: nls.localize('vueport/touch/control/l', 'L Button'),
        r: nls.localize('vueport/touch/control/r', 'R Button'),
        ldpad: nls.localize('vueport/touch/control/ldpad', 'Left D-Pad'),
        rdpad: nls.localize('vueport/touch/control/rdpad', 'Right D-Pad'),
        select: nls.localize('vueport/touch/control/select', 'Select'),
        start: nls.localize('vueport/touch/control/start', 'Start'),
        b: nls.localize('vueport/touch/control/b', 'B Button'),
        a: nls.localize('vueport/touch/control/a', 'A Button'),
    };
}

function hitTest(placed: PlacedControl[], x: number, y: number): PlacedControl | undefined {
    let best: PlacedControl | undefined;
    let bestDistance = Infinity;
    for (const control of placed) {
        const reach = control.size / 2 + HIT_SLACK;
        const dx = Math.abs(x - control.cx);
        const dy = Math.abs(y - control.cy);
        const inside = isDpad(control.id) ? dx <= reach && dy <= reach : Math.hypot(dx, dy) <= reach;
        const distance = Math.hypot(dx, dy) / control.size;
        if (inside && distance < bestDistance) {
            best = control;
            bestDistance = distance;
        }
    }
    return best;
}

function keysAt(control: PlacedControl, x: number, y: number, diagonals: boolean): number {
    if (!isDpad(control.id)) {
        return BUTTON_KEYS[control.id];
    }
    const dx = x - control.cx;
    const dy = y - control.cy;
    if (Math.hypot(dx, dy) < control.size * DEAD_ZONE) {
        return 0;
    }
    const keys = DPAD_KEYS[control.id];
    const angle = Math.atan2(dy, dx) * 180 / Math.PI; // screen angle, clockwise from the right: 90 is down
    if (diagonals) {
        const sector = ((Math.round(angle / 45) % 8) + 8) % 8;
        return [
            keys.right, keys.right | keys.down, keys.down, keys.down | keys.left,
            keys.left, keys.left | keys.up, keys.up, keys.up | keys.right,
        ][sector];
    }
    const quadrant = ((Math.round(angle / 90) % 4) + 4) % 4;
    return [keys.right, keys.down, keys.left, keys.up][quadrant];
}

// in the d-pad's own 144 units, leaving room for the stroke
const DPAD_PATH = 'M48 4q0-4 4-4h40q4 0 4 4v44h44q4 0 4 4v40q0 4-4 4h-44v44q0 4-4 4h-40q-4 0-4-4v-44h-44q-4 0-4-4v-40'
    + 'q0-4 4-4h44z';
const ARM_PATHS = {
    up: 'M48 4q0-4 4-4h40q4 0 4 4v44h-48z',
    right: 'M96 48h44q4 0 4 4v40q0 4-4 4h-44z',
    down: 'M48 96h48v44q0 4-4 4h-40q-4 0-4-4z',
    left: 'M4 48h44v48h-44q-4 0-4-4v-40q0-4 4-4z',
};
const ARROW_PATHS = {
    up: 'M72 15l7 9h-14z',
    right: 'M129 72l-9 7v-14z',
    down: 'M72 129l-7-9h14z',
    left: 'M15 72l9-7v14z',
};

function DPad(props: { control: PlacedControl, held: number, highlight: boolean }): React.JSX.Element {
    const { control, held, highlight } = props;
    const keys = DPAD_KEYS[control.id as 'ldpad' | 'rdpad'];
    const directions = ['up', 'right', 'down', 'left'] as const;
    return <svg
        className='vp-touch-dpad'
        viewBox='-2 -2 148 148'
        aria-hidden='true'
    >
        <path className='vp-touch-face' d={DPAD_PATH} />
        {highlight && directions.filter(direction => held & keys[direction]).map(direction =>
            <path key={direction} className='vp-touch-held' d={ARM_PATHS[direction]} />)}
        <circle className='vp-touch-dimple' cx='72' cy='72' r='13' />
        {directions.map(direction =>
            <path
                key={direction}
                className={'vp-touch-arrow' + (highlight && (held & keys[direction]) ? ' held' : '')}
                d={ARROW_PATHS[direction]}
            />)}
    </svg>;
}

function controlStyle(control: PlacedControl): React.CSSProperties {
    return {
        left: control.cx - control.size / 2,
        top: control.cy - control.size / 2,
        width: control.size,
        height: control.size,
        fontSize: Math.max(9, control.size * (control.id === 'select' || control.id === 'start' ? 0.15 : 0.32)),
    };
}

function ControlFace(props: { control: PlacedControl, held: number, highlight: boolean }): React.JSX.Element {
    const { control, held, highlight } = props;
    if (isDpad(control.id)) {
        return <DPad control={control} held={held} highlight={highlight} />;
    }
    const pressed = highlight && (held & BUTTON_KEYS[control.id]) !== 0;
    return <span className={'vp-touch-round' + (pressed ? ' held' : '')}>{LABELS[control.id]}</span>;
}

function useAreaSize(): [React.RefObject<HTMLDivElement>, { width: number, height: number }] {
    const ref = React.useRef<HTMLDivElement>(null);
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) {
            return undefined;
        }
        const measure = (): void => {
            const box = node.getBoundingClientRect();
            setSize(was => was.width === box.width && was.height === box.height
                ? was : { width: box.width, height: box.height });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    return [ref, size];
}

export interface EmulatorTouchControlsProps {
    settings: VueportSettings;
    orientation: TouchOrientation;
    onKeys: (keys: number) => void; // combined mask, see EmulatorInputController.setTouchKeys
    editing?: {
        onDone: (layout: TouchControlsLayout) => void,
        onCancel: () => void,
    };
}

export function EmulatorTouchControls(props: EmulatorTouchControlsProps): React.JSX.Element {
    return props.editing
        ? <TouchLayoutEditor {...props} editing={props.editing} />
        : <TouchPad {...props} />;
}

function TouchPad(props: EmulatorTouchControlsProps): React.JSX.Element {
    const { settings, orientation, onKeys } = props;
    const opacity = useSetting(settings, 'touchControlsOpacity');
    const size = useSetting(settings, 'touchControlsSize');
    const diagonals = useSetting(settings, 'touchControlsDiagonals');
    const slide = useSetting(settings, 'touchControlsSlide');
    const vibration = useSetting(settings, 'touchControlsVibration');
    const highlight = useSetting(settings, 'touchControlsHighlight');
    const layout = useSetting(settings, 'touchControlsLayout');

    const [area, box] = useAreaSize();
    const placed = React.useMemo(
        () => placeControls(orientation, box.width, box.height, size / 100, layout),
        [orientation, box.width, box.height, size, layout]);

    const fingers = React.useRef(new Map<number, { control: TouchControlId, keys: number }>());
    const [held, setHeld] = React.useState(0);
    const sent = React.useRef(0);
    const report = React.useRef(onKeys);
    report.current = onKeys;

    const publish = React.useCallback((): void => {
        let keys = 0;
        fingers.current.forEach(finger => { keys |= finger.keys; });
        if (keys === sent.current) {
            return;
        }
        // only for new presses, never for a release
        if (vibration && (keys & ~sent.current) && typeof navigator.vibrate === 'function') {
            try {
                navigator.vibrate(VIBRATION);
            } catch {
                // refused without user activation yet; the press stays silent
            }
        }
        sent.current = keys;
        setHeld(keys);
        report.current(keys);
    }, [vibration]);

    // release everything on unmount, or a d-pad would keep walking by itself
    React.useEffect(() => () => {
        fingers.current.clear();
        if (sent.current !== 0) {
            sent.current = 0;
            report.current(0);
        }
    }, []);

    const local = (event: React.PointerEvent): { x: number, y: number } => {
        const rect = area.current!.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
        const { x, y } = local(event);
        const control = hitTest(placed, x, y);
        if (!control) {
            return;
        }
        event.preventDefault();
        // captured so the finger is followed off the control and its release arrives wherever it ends. Captured by
        // the control, as the area itself has no pointer events (so what lies under it stays reachable)
        const target = event.target instanceof Element
            ? event.target.closest('.vp-touch-control') ?? event.currentTarget
            : event.currentTarget;
        target.setPointerCapture(event.pointerId);
        fingers.current.set(event.pointerId, { control: control.id, keys: keysAt(control, x, y, diagonals) });
        publish();
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
        const finger = fingers.current.get(event.pointerId);
        if (!finger) {
            return;
        }
        const { x, y } = local(event);
        let control = placed.find(entry => entry.id === finger.control)!;
        if (slide) {
            // sliding onto another control presses that one instead. Off every control, a button lets go but a d-pad
            // keeps its direction, as a thumb rolling off the cross still means it
            const under = hitTest(placed, x, y);
            if (under && under.id !== control.id) {
                control = under;
            } else if (!under && !isDpad(control.id)) {
                finger.keys = 0;
                publish();
                return;
            }
        }
        finger.control = control.id;
        finger.keys = keysAt(control, x, y, diagonals);
        publish();
    };

    const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (fingers.current.delete(event.pointerId)) {
            publish();
        }
    };

    return <div
        ref={area}
        className={'vp-touch vp-touch-' + orientation}
        role='group'
        aria-label={nls.localize('vueport/touch/label', 'On-Screen Controller')}
        style={{ opacity: opacity / 100 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onContextMenu={event => event.preventDefault()}
    >
        {box.width > 0 && placed.map(control =>
            <div key={control.id} className='vp-touch-control' data-control={control.id} style={controlStyle(control)}>
                <ControlFace control={control} held={held} highlight={highlight} />
            </div>)}
    </div>;
}

function TouchLayoutEditor(props: EmulatorTouchControlsProps & {
    editing: NonNullable<EmulatorTouchControlsProps['editing']>,
}): React.JSX.Element {
    const { settings, orientation, editing } = props;
    const size = useSetting(settings, 'touchControlsSize');
    const stored = useSetting(settings, 'touchControlsLayout');
    const [draft, setDraft] = React.useState<Record<string, TouchControlPlacement>>(
        () => ({ ...stored[orientation] ?? {} }));
    const [selected, setSelected] = React.useState<TouchControlId | undefined>(undefined);
    const [area, box] = useAreaSize();
    const layout = React.useMemo(() => ({ [orientation]: draft }), [orientation, draft]);
    const placed = React.useMemo(
        () => placeControls(orientation, box.width, box.height, size / 100, layout),
        [orientation, box.width, box.height, size, layout]);
    const names = controlNames();

    const [snap, setSnap] = React.useState(storedSnap);

    const placement = (id: TouchControlId): TouchControlPlacement => draft[id] ?? { dx: 0, dy: 0, scale: 1 };
    const moved = (id: TouchControlId): boolean => {
        const own = placement(id);
        return own.dx !== 0 || own.dy !== 0 || own.scale !== 1;
    };
    const resetOne = (id: TouchControlId): void => setDraft(was => {
        const next = { ...was };
        delete next[id];
        return next;
    });
    const change = (id: TouchControlId, next: Partial<TouchControlPlacement>): void =>
        setDraft(was => ({ ...was, [id]: { ...placement(id), ...next } }));

    const drag = React.useRef<{ id: TouchControlId, pointer: number, x: number, y: number, dx: number, dy: number }>();
    const onPointerDown = (id: TouchControlId) => (event: React.PointerEvent<HTMLElement>): void => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelected(id);
        const own = placement(id);
        drag.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, dx: own.dx, dy: own.dy };
    };
    const onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
        const start = drag.current;
        if (!start || start.pointer !== event.pointerId) {
            return;
        }
        let dx = Math.round(start.dx + event.clientX - start.x);
        let dy = Math.round(start.dy + event.clientY - start.y);
        const control = placed.find(entry => entry.id === start.id);
        if (snap && control) {
            const own = placement(start.id);
            const baseX = control.cx - own.dx;
            const baseY = control.cy - own.dy;
            dx = Math.round(toGrid(baseX + dx) - baseX);
            dy = Math.round(toGrid(baseY + dy) - baseY);
        }
        change(start.id, { dx, dy });
    };
    const onPointerUp = (event: React.PointerEvent<HTMLElement>): void => {
        if (drag.current?.pointer === event.pointerId) {
            drag.current = undefined;
        }
    };

    const resize = (step: number): void => {
        if (!selected) {
            return;
        }
        const next = Math.round((placement(selected).scale + step) * 100) / 100;
        change(selected, {
            scale: Math.min(PLACEMENT_SCALE_RANGE.max, Math.max(PLACEMENT_SCALE_RANGE.min, next)),
        });
    };

    const done = (): void => {
        // a control back at its start gets no entry, so a later change to the default layout still reaches it
        const kept = Object.fromEntries(Object.entries(draft)
            .filter(([, own]) => own.dx !== 0 || own.dy !== 0 || own.scale !== 1));
        editing.onDone({ ...stored, [orientation]: kept });
    };

    const chosen = selected && placed.find(control => control.id === selected);
    return <div
        ref={area}
        className={'vp-touch vp-touch-editing vp-touch-' + orientation}
        role='dialog'
        aria-label={nls.localize('vueport/touch/editor/title', 'Edit On-Screen Controller')}
        style={{ backgroundSize: `${GRID}px ${GRID}px` }}
        onPointerDown={event => { if (event.target === event.currentTarget) { setSelected(undefined); } }}
    >
        {box.width > 0 && placed.map(control =>
            <button
                key={control.id}
                type='button'
                className={'vp-touch-control' + (control.id === selected ? ' selected' : '')}
                data-control={control.id}
                aria-label={names[control.id]}
                aria-pressed={control.id === selected}
                style={controlStyle(control)}
                onPointerDown={onPointerDown(control.id)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onClick={() => setSelected(control.id)}
            >
                <ControlFace control={control} held={0} highlight={false} />
            </button>)}

        <div className='vp-touch-editor-bar'>
            <button type='button' className='vp-button secondary' onClick={editing.onCancel}>
                {nls.localize('vueport/general/cancel', 'Cancel')}
            </button>
            <strong>{orientation === 'portrait'
                ? nls.localize('vueport/touch/editor/portrait', 'Portrait')
                : nls.localize('vueport/touch/editor/landscape', 'Landscape')}</strong>
            <button type='button' className='vp-button' onClick={done}>
                {nls.localize('vueport/general/done', 'Done')}
            </button>
        </div>

        {chosen
            ? <div
                className='vp-touch-editor-inspector'
                role='group'
                aria-label={names[chosen.id]}
                style={{
                    // opposite the control, so it never covers what is being moved
                    [chosen.cx > box.width / 2 ? 'left' : 'right']: 12,
                    // clear of the top bar (landscape) and the tools below
                    ...chosen.cy > box.height / 2
                        ? { top: orientation === 'portrait' ? 12 : 64 }
                        : { bottom: 64 },
                }}
            >
                <strong>{names[chosen.id]}</strong>
                <div className='vp-touch-editor-size'>
                    <span>{nls.localize('vueport/touch/editor/size', 'Size')}</span>
                    <button
                        type='button'
                        className='vp-button secondary'
                        aria-label={nls.localize('vueport/touch/editor/smaller', 'Smaller')}
                        disabled={placement(chosen.id).scale <= PLACEMENT_SCALE_RANGE.min}
                        onClick={() => resize(-PLACEMENT_SCALE_STEP)}
                    >−</button>
                    <output>{Math.round(placement(chosen.id).scale * 100)} %</output>
                    <button
                        type='button'
                        className='vp-button secondary'
                        aria-label={nls.localize('vueport/touch/editor/larger', 'Larger')}
                        disabled={placement(chosen.id).scale >= PLACEMENT_SCALE_RANGE.max}
                        onClick={() => resize(PLACEMENT_SCALE_STEP)}
                    >+</button>
                </div>
                <button
                    type='button'
                    className='vp-button secondary'
                    disabled={!moved(chosen.id)}
                    onClick={() => resetOne(chosen.id)}
                >
                    <ArrowCounterClockwise size={16} />
                    {nls.localize('vueport/touch/editor/reset', 'Reset')}
                </button>
            </div>
            : <p className='vp-touch-editor-hint'>
                {nls.localize('vueport/touch/editor/hint', 'Drag a button to move it, tap it to change its size.')}
            </p>}

        <div className='vp-touch-editor-tools'>
            <label className='vp-touch-editor-snap'>
                <Switch
                    label={nls.localize('vueport/touch/editor/snap', 'Snap to Grid')}
                    value={snap}
                    onChange={on => { setSnap(on); storeSnap(on); }}
                />
                {nls.localize('vueport/touch/editor/snap', 'Snap to Grid')}
            </label>
            <button
                type='button'
                className='vp-button secondary'
                disabled={Object.keys(draft).length === 0}
                onClick={() => setDraft({})}
            >
                <ArrowCounterClockwise size={16} />
                {nls.localize('vueport/settings/resetAll/label', 'Reset All')}
            </button>
        </div>
    </div>;
}
