import { Trash } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import ColorField from '../components/kit/ColorField';
import { BACKDROP_ROWS, ColorBackdrop, ColorEditor } from './emulator-color-editor';

// CSS pixels, each screen row is one pixel high
const BAR = 28;
const MARKS = 14;
// a press within this many rows of a stop grabs it instead of adding a new one
const NEAR = 5;

/**
 * Shows a bar of the screen's 224 rows in their colours with the stops beside it. A click on the bar adds a stop in the
 * brush's colour; a single stop means one colour for the whole screen. Stops can be dragged up and down, recoloured or
 * removed. Between stops the rows blend smoothly from one colour to the next, or form bands.
 */
export function BackdropEditor(props: { editor: ColorEditor, target: string }): React.JSX.Element {
    const { editor, target } = props;
    const backdrop = editor.backdrop(target);
    const rows = editor.backdropRows(target) ?? new Array<string>(BACKDROP_ROWS).fill('#000000');
    const stops = backdrop?.stops ?? [];
    const [selected, setSelected] = React.useState<number | undefined>(undefined);
    const canvas = React.useRef<HTMLCanvasElement>(null);
    const drag = React.useRef<number | undefined>(undefined);
    const chosen = selected !== undefined ? stops[selected] : undefined;

    React.useEffect(() => setSelected(undefined), [target]);

    React.useEffect(() => {
        const node = canvas.current;
        const context = node?.getContext('2d');
        if (!node || !context) {
            return;
        }
        const ratio = window.devicePixelRatio || 1;
        node.width = (BAR + MARKS) * ratio;
        node.height = BACKDROP_ROWS * ratio;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, BAR + MARKS, BACKDROP_ROWS);
        rows.forEach((color, y) => {
            context.fillStyle = color;
            context.fillRect(0, y, BAR, 1);
        });
        const accent = getComputedStyle(node).getPropertyValue('--vp-accent').trim() || '#e53935';
        const text = getComputedStyle(node).getPropertyValue('--vp-text').trim() || '#ffffff';
        stops.forEach((stop, n) => {
            context.beginPath();
            context.moveTo(BAR + 1, stop.row + 0.5);
            context.lineTo(BAR + MARKS - 1, stop.row - 5.5);
            context.lineTo(BAR + MARKS - 1, stop.row + 6.5);
            context.closePath();
            context.fillStyle = stop.color;
            context.fill();
            context.lineWidth = n === selected ? 2 : 1;
            context.strokeStyle = n === selected ? accent : text;
            context.stroke();
        });
    });

    const rowAt = (event: React.PointerEvent<HTMLCanvasElement>): number => {
        const box = event.currentTarget.getBoundingClientRect();
        return Math.max(0, Math.min(BACKDROP_ROWS - 1, Math.floor((event.clientY - box.top) / box.height * BACKDROP_ROWS)));
    };
    const save = (next: ColorBackdrop, coalesce = false): void => editor.setBackdrop(target, next, coalesce);

    return <fieldset className='vp-color-section' data-backdrop={target}>
        <legend>{nls.localize('vueport/color/backdrop/title', 'Backdrop')}</legend>
        <div className='vp-color-backdrop'>
            <canvas
                ref={canvas}
                className='vp-color-backdrop-bar'
                style={{ width: BAR + MARKS, height: BACKDROP_ROWS }}
                title={nls.localize('vueport/color/backdrop/barHint', 'Click to add a color at that row; drag a color to move it')}
                onPointerDown={event => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const row = rowAt(event);
                    const near = stops.reduce<number | undefined>((best, stop, n) =>
                        Math.abs(stop.row - row) <= NEAR && (best === undefined || Math.abs(stop.row - row) < Math.abs(stops[best].row - row))
                            ? n : best, undefined);
                    if (near !== undefined) {
                        setSelected(near);
                        drag.current = near;
                        return;
                    }
                    const color = editor.brushColor ?? rows[row];
                    const next = { ...backdrop, stops: [...stops, { row, color }] };
                    save(next);
                    setSelected(next.stops.length - 1);
                    drag.current = next.stops.length - 1;
                }}
                onPointerMove={event => {
                    const n = drag.current;
                    if (n === undefined || !(event.buttons & 1) || !stops[n]) {
                        return;
                    }
                    const row = rowAt(event);
                    if (row !== stops[n].row) {
                        save({ ...backdrop!, stops: stops.map((stop, m) => m === n ? { ...stop, row } : stop) }, true);
                    }
                }}
                onPointerUp={() => {
                    drag.current = undefined;
                }}
            />
            <div className='vp-color-backdrop-controls'>
                {chosen
                    ? <>
                        <div className='vp-color-backdrop-stop'>
                            <ColorField
                                value={chosen.color}
                                title={nls.localize('vueport/color/backdrop/stopColor', 'This color')}
                                onChange={color => save({ ...backdrop!, stops: stops.map((stop, m) => m === selected ? { ...stop, color } : stop) })}
                            />
                            <button type='button' className='vp-color-tool-button' data-delete-stop
                                title={nls.localize('vueport/color/backdrop/removeStop', 'Remove this color')}
                                onClick={() => {
                                    const rest = stops.filter((_, m) => m !== selected);
                                    setSelected(undefined);
                                    editor.setBackdrop(target, rest.length ? { ...backdrop!, stops: rest } : undefined);
                                }}><Trash size={16} /></button>
                        </div>
                        <div className='vp-color-hint'>{nls.localize('vueport/color/backdrop/row', 'Row {0}', chosen.row)}</div>
                        <button type='button' className='vp-button secondary' disabled={!editor.brushColor || editor.brushColor === chosen.color}
                            onClick={() => editor.brushColor && save({ ...backdrop!, stops: stops.map((stop, m) =>
                                m === selected ? { ...stop, color: editor.brushColor! } : stop) })}>
                            {nls.localize('vueport/color/backdrop/useBrush', 'Brush Color')}
                        </button>
                    </>
                    : <div className='vp-color-hint'>
                        {stops.length
                            ? nls.localize('vueport/color/backdrop/chooseStop', 'Click a color beside the bar to change it.')
                            : nls.localize('vueport/color/backdrop/empty', 'Click the bar: one color for the whole screen; more make a gradient.')}
                    </div>}
                <label className='vp-color-tree-check'>
                    <input type='checkbox' checked={!!backdrop?.steps} disabled={stops.length < 2} data-backdrop-steps
                        onChange={event => save({ ...backdrop!, steps: event.currentTarget.checked ? 4 : undefined })} />
                    {nls.localize('vueport/color/backdrop/steps', 'In bands')}
                </label>
                {!!backdrop?.steps && <input
                    className='vp-input vp-color-backdrop-steps'
                    type='number'
                    min={2}
                    max={32}
                    value={backdrop.steps}
                    aria-label={nls.localize('vueport/color/backdrop/stepCount', 'Bands between two colors')}
                    onChange={event => {
                        const steps = Number(event.currentTarget.value);
                        if (Number.isInteger(steps) && steps >= 2 && steps <= 32) {
                            save({ ...backdrop, steps }, true);
                        }
                    }}
                />}
                <button type='button' className='vp-button secondary' disabled={!backdrop} data-backdrop-reset
                    onClick={() => {
                        setSelected(undefined);
                        editor.setBackdrop(target, undefined);
                    }}>
                    {nls.localize('vueport/color/backdrop/reset', 'Package Backdrop')}
                </button>
            </div>
        </div>
        {!editor.backdropReachesGame(target) && <div className='vp-color-hint' data-backdrop-preview-only>
            {nls.localize('vueport/color/backdrop/previewOnly',
                'Shown here only for now: this colorization cannot tell its screens apart yet, so the game keeps its own backdrop.')}
        </div>}
    </fieldset>;
}
