import {
    ArrowClockwise, ArrowCounterClockwise, ArrowUUpLeft, Crosshair, Cursor, Eraser, Eye, EyeSlash, Eyedropper, Hand, MagnifyingGlassMinus,
    MagnifyingGlassPlus, PaintBucket, Pencil,
} from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { ColorModel, ColorModelClass, Wireframe, nearOf, paintOf, readWireframe, supportsDepth4 } from '../../common/vb-color-models';
import ColorField from '../components/kit/ColorField';
import EmptyContainer from '../components/kit/EmptyContainer';
import RadioSelect from '../components/kit/RadioSelect';
import { ColorEditor, ColorSheetEntry, MODEL_CLASS_PREFIX, MODEL_SHEET_PREFIX, modelClassName } from './emulator-color-editor';
import { Swatches } from './emulator-color-sheet';

/**
 * The model sheet shows a model package's model (Red Alarm's ships, enemies, bosses) as a wireframe from the ROM's
 * vertex and edge lists, to color edge by edge. Dragging turns it; the cube in the view's corner turns with it (and
 * turns it when dragged), a click on a face shows the model from that side, and the dot beside the cube returns to the
 * oblique view it opened in. The model keeps its size while it turns. As in the sheet editor, Ctrl (or Cmd, Alt) and
 * the wheel zoom about the pointer, and the wheel, the hand, Space or the middle button move it.
 *
 * The sheet editor's tools work on edges: the pencil colors one, the fill colors the touching edges of one color (or
 * the whole part), the selection chooses a part without coloring it, the pipette takes an edge's color, and the eraser
 * gives an edge back to the package. An edge's color is its near shade: the runtime shows far objects in the darker two
 * shades of its ramp, which the patcher derives from it (the Color section shows them).
 *
 * What a model package draws that is no model (scenery, debris, the fixed lines) only gets one color (ClassSheet).
 */

export function isModelSheet(id: string): boolean {
    return id.startsWith(MODEL_SHEET_PREFIX) || id.startsWith(MODEL_CLASS_PREFIX);
}

type ModelTool = 'pencil' | 'eraser' | 'fill' | 'pipette' | 'hand' | 'select';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

interface ModelView {
    yaw: number;
    pitch: number;
    zoom: number;
    // pan offset from the view's middle, in canvas pixels
    x: number;
    y: number;
}

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24];

function startView(yaw: number, pitch: number): ModelView {
    return { yaw, pitch, zoom: 1, x: 0, y: 0 };
}

// the oblique view a model opens in (front seen from above right); also the reference for its size, and where Home goes
const OBLIQUE = { yaw: 145, pitch: 30 };

function turnPoint([x, y, z]: readonly number[], yawDegrees: number, pitchDegrees: number): [number, number, number] {
    const yaw = yawDegrees * Math.PI / 180;
    const pitch = pitchDegrees * Math.PI / 180;
    const tx = x * Math.cos(yaw) - z * Math.sin(yaw);
    const tz = x * Math.sin(yaw) + z * Math.cos(yaw);
    return [tx, y * Math.cos(pitch) - tz * Math.sin(pitch), y * Math.sin(pitch) + tz * Math.cos(pitch)];
}

type NavFace = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';

// navigation cube faces in model space (front +z, top -y, right and left as seen from the front), each with the view
// that looks straight at it (top and bottom with the front toward the viewer)
const NAV_FACES: { id: NavFace, normal: [number, number, number], corners: [number, number, number][], yaw: number, pitch: number }[] = [
    { id: 'front', normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], yaw: 180, pitch: 0 },
    { id: 'back', normal: [0, 0, -1], corners: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]], yaw: 0, pitch: 0 },
    { id: 'right', normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], yaw: 90, pitch: 0 },
    { id: 'left', normal: [1, 0, 0], corners: [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]], yaw: -90, pitch: 0 },
    { id: 'top', normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], yaw: 180, pitch: 90 },
    { id: 'bottom', normal: [0, 1, 0], corners: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]], yaw: 180, pitch: -90 },
];

function faceLabel(face: NavFace): string {
    switch (face) {
        case 'front': return nls.localize('vueport/color/model/front', 'Front');
        case 'back': return nls.localize('vueport/color/model/behind', 'Behind');
        case 'right': return nls.localize('vueport/color/model/right', 'Right');
        case 'left': return nls.localize('vueport/color/model/left', 'Left');
        case 'top': return nls.localize('vueport/color/model/top', 'Top');
        default: return nls.localize('vueport/color/model/bottom', 'Bottom');
    }
}

const NAV_SIZE = 96;
const NAV_HALF = 22;
// arrow inside the cube pointing to the model's front (+z): the shaft, then the head twice, flat and upright, so seen
// head on it is a cross rather than a dash
const NAV_ARROW: [number, number, number][][] = [
    [[0, 0, -0.6], [0, 0, 0.75]],
    [[-0.3, 0, 0.4], [0, 0, 0.75], [0.3, 0, 0.4]],
    [[0, -0.3, 0.4], [0, 0, 0.75], [0, 0.3, 0.4]],
];

// the navigation cube in the view's corner, turned as the model is, with an arrow toward the model's front. Dragging it
// turns the model as the view does; a click on a face turns the model to look straight at it, and the dot beside it
// goes back to the oblique view it opened in
function NavCube(props: {
    yaw: number, pitch: number, onFace: (face: NavFace) => void, onHome: () => void,
    onTurnStart: () => void, onTurn: (yaw: number, pitch: number) => void
}): React.JSX.Element {
    const { yaw, pitch } = props;
    const [hover, setHover] = React.useState<NavFace | undefined>(undefined);
    const [dragging, setDragging] = React.useState(false);
    const drag = React.useRef<{ x: number, y: number, yaw: number, pitch: number, face?: NavFace, moved: boolean } | undefined>(undefined);
    const middle = NAV_SIZE / 2;
    const at = (point: readonly number[]): [number, number] => {
        const [x, y] = turnPoint(point, yaw, pitch);
        return [middle + x * NAV_HALF, middle + y * NAV_HALF];
    };
    const line = (points: readonly (readonly number[])[]): string => points.map(at).map(p => p.join(',')).join(' ');
    // only faces toward the viewer; the cube is convex, so they never overlap
    const shown = NAV_FACES.filter(face => turnPoint(face.normal, yaw, pitch)[2] < -0.01);
    const home = nls.localize('vueport/color/model/home', 'Oblique');

    const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
        if (event.button !== 0) {
            return;
        }
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const face = (event.target as Element).closest('[data-navcube-face]')?.getAttribute('data-navcube-face') as NavFace | null;
        drag.current = { x: event.clientX, y: event.clientY, yaw, pitch, face: face ?? undefined, moved: false };
        props.onTurnStart();
    };
    const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
        const d = drag.current;
        if (!d || (!d.moved && Math.hypot(event.clientX - d.x, event.clientY - d.y) < 4)) {
            return;
        }
        if (!d.moved) {
            setDragging(true);
        }
        d.moved = true;
        props.onTurn(d.yaw + (event.clientX - d.x) * 0.6, Math.max(-89, Math.min(89, d.pitch + (event.clientY - d.y) * 0.6)));
    };
    const onPointerUp = (): void => {
        const d = drag.current;
        drag.current = undefined;
        setDragging(false);
        if (d && !d.moved && d.face) {
            props.onFace(d.face);
        }
    };
    return <div className={`vp-color-model-navcube${dragging ? ' dragging' : ''}`} data-navcube>
        <button type='button' className='vp-color-model-navcube-home' title={home} aria-label={home} data-navcube-home
            onClick={props.onHome} />
        <svg width={NAV_SIZE} height={NAV_SIZE} viewBox={`0 0 ${NAV_SIZE} ${NAV_SIZE}`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            {NAV_ARROW.map((points, i) => <polyline key={i} className='vp-color-model-navcube-arrow' points={line(points)} />)}
            {shown.map(face => <polygon
                key={face.id}
                className={`vp-color-model-navcube-face${hover === face.id ? ' hover' : ''}`}
                data-navcube-face={face.id}
                points={line(face.corners)}
                onPointerEnter={() => setHover(face.id)}
                onPointerLeave={() => setHover(undefined)}
            >
                <title>{faceLabel(face.id)}</title>
            </polygon>)}
        </svg>
    </div>;
}

interface Projected {
    points: [number, number][];
    depth: number[]; // 0 near to 1 far
}

// scale and placement come from the oblique view, not the current turn, so turning never grows or shrinks the model.
// At zoom 1 it is about half as high as the canvas; a long model seen end on is kept small enough that, turned, it
// spans at most 1.5 canvases
function project(frame: Wireframe, view: ModelView, width: number, height: number): Projected {
    const source = frame.vertices;
    const n = source.length;
    const centre = [0, 1, 2].map(k => source.reduce((sum, v) => sum + v[k], 0) / Math.max(1, n));
    const turn = (yaw: number, pitch: number): [number, number, number][] =>
        source.map(([x, y, z]) => turnPoint([x - centre[0], y - centre[1], z - centre[2]], yaw, pitch));
    const turned = turn(view.yaw, view.pitch);
    const reference = turn(OBLIQUE.yaw, OBLIQUE.pitch);
    const xs = reference.map(p => p[0]);
    const ys = reference.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // the vertex farthest from the pivot limits the scale, so a long model seen end on spans at most 1.5 canvases
    const radius = Math.max(1, ...source.map(([x, y, z]) => Math.hypot(x - centre[0], y - centre[1], z - centre[2])));
    const scale = Math.min(height * 0.5 / Math.max(1, y1 - y0), width * 0.5 / Math.max(1, x1 - x0), Math.min(width, height) * 0.75 / radius) * view.zoom;
    const [mx, my] = [width / 2 + view.x, height / 2 + view.y];
    const points = turned.map(([x, y]): [number, number] => [mx + (x - (x0 + x1) / 2) * scale, my + (y - (y0 + y1) / 2) * scale]);
    const zs = turned.map(v => v[2]);
    const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
    return { points, depth: turned.map(v => (v[2] - z0) / Math.max(1, z1 - z0)) };
}

function distanceToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const n = dx * dx + dy * dy;
    const t = n ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / n)) : 0;
    return Math.hypot(a[0] + t * dx - px, a[1] + t * dy - py);
}

export function ModelSheet(props: { editor: ColorEditor, entry?: ColorSheetEntry }): React.JSX.Element {
    const { editor, entry } = props;
    const id = entry?.sheet.id;
    const picked = <PickedStrip editor={editor} />;
    if (!entry || !id) {
        const pick = editor.modelPick;
        return <div className='vp-color-sheet vp-color-model-sheet'>
            {picked}
            <EmptyContainer
                title={editor.modelPicking
                    ? nls.localize('vueport/color/model/picking', 'Reading what the game draws there…')
                    : editor.modelPickError
                        ? nls.localize('vueport/color/model/pickFailed', 'The pick failed: {0}', editor.modelPickError)
                        : pick && !pick.candidates.length
                            ? nls.localize('vueport/color/model/nothingPicked', 'No line of a model is drawn there.')
                            : nls.localize('vueport/color/sheet/none', 'No sheet open')}
                description={nls.localize('vueport/color/model/noneHint', 'Open a model in the project tree, or click a line on the screen.')}
                icon={<Crosshair size={32} />}
            />
        </div>;
    }
    if (id.startsWith(MODEL_CLASS_PREFIX)) {
        return <div className='vp-color-sheet vp-color-model-sheet'>
            {picked}
            <ClassSheet editor={editor} name={id.slice(MODEL_CLASS_PREFIX.length) as ColorModelClass} entry={entry} />
        </div>;
    }
    const model = editor.modelOf(id);
    const pkg = editor.modelPackage;
    const frame = model && pkg && editor.packageIndex ? readWireframe(pkg, editor.packageIndex.original, model) : undefined;
    if (!model || !frame) {
        return <EmptyContainer title={nls.localize('vueport/color/model/unreadable', 'This model has no lines in the ROM.')} />;
    }
    return <div className='vp-color-sheet vp-color-model-sheet' data-model={model.edges}>
        {picked}
        <WireframeSheet key={model.edges} editor={editor} entry={entry} model={model} frame={frame} />
    </div>;
}

function PickedStrip(props: { editor: ColorEditor }): React.JSX.Element | null {
    const { editor } = props;
    const pick = editor.modelPick;
    if (editor.modelPicking) {
        return <div className='vp-color-model-picked'>{nls.localize('vueport/color/model/picking', 'Reading what the game draws there…')}</div>;
    }
    if (!pick || pick.candidates.length < 2) {
        return null;
    }
    const models = new Map(editor.modelPackage?.models.map(model => [model.edges, model]));
    return <div className='vp-color-model-picked' data-picked>
        <span className='vp-color-tool-options-label'>{nls.localize('vueport/color/model/pickedHere', 'Drawn there:')}</span>
        {pick.candidates.slice(0, 8).map((candidate, i) => <button
            key={i}
            type='button'
            className={`vp-button secondary${i === pick.chosen ? ' on' : ''}`}
            data-candidate={i}
            onClick={() => editor.openModelCandidate(i)}
        >{candidate.modelClass
                ? modelClassName(candidate.modelClass)
                : nls.localize('vueport/color/model/candidate', '{0}, edge {1}',
                    models.get(candidate.model!)?.name ?? candidate.model!, candidate.edge ?? '?')}</button>)}
    </div>;
}

function Brushes(props: { editor: ColorEditor }): React.JSX.Element {
    const { editor } = props;
    return <fieldset className='vp-color-section'>
        <legend>{nls.localize('vueport/color/brush', 'Brush')}</legend>
        <div className='vp-color-sheet-brushes' data-brushes>
            {editor.brushColors.map((color, slot) => <span key={slot} className={slot === editor.brushSlot ? 'on' : undefined} data-brush={slot}>
                <ColorField
                    value={color}
                    title={nls.localize('vueport/color/sheet/brushSlot2',
                        'Brush color {0}: a click paints with it, a double click changes it; X switches to the next, Shift+X to the previous', slot + 1)}
                    onSelect={() => editor.chooseBrush(slot)}
                    onChange={next => {
                        editor.chooseBrush(slot);
                        editor.setBrushColor(next);
                    }}
                />
            </span>)}
        </div>
    </fieldset>;
}

// there is one Color RAM for the whole game, every stage
function PaletteCount(props: { editor: ColorEditor }): React.JSX.Element {
    const { used, free } = props.editor.modelPalettes();
    return <div className={`vp-color-hint${used > free ? ' vp-color-warning' : ''}`} data-palettes={`${used}/${free}`}>
        {nls.localize('vueport/color/model/palettes', 'Palettes for the paint: {0} of {1} free (one Color RAM for every stage).', used, free)}
    </div>;
}

// a paint's color (its near shade) with the shades the game shows farther away beside it; the patcher derives those
// (far 40 %, middle 70 %), so only the color is chosen. With `four` (where the runtime supports it) there is a choice
// between three shades by the model's distance and four by each line's own depth (four palettes)
function DepthColor(props: { ramp: string[], onChange: (color: string, steps: 3 | 4) => void, disabled?: boolean, four?: boolean }): React.JSX.Element {
    const steps = props.four && props.ramp.length === 4 ? 4 : 3;
    const ramp = steps === 4 || props.ramp.length === 3 ? props.ramp : [props.ramp[0], props.ramp[2], props.ramp[3]];
    const labels = steps === 4 ? [
        nls.localize('vueport/color/model/far', 'Far'),
        nls.localize('vueport/color/model/farMid', 'Far middle'),
        nls.localize('vueport/color/model/nearMid', 'Near middle'),
        nls.localize('vueport/color/model/near', 'Near'),
    ] : [
        nls.localize('vueport/color/model/far', 'Far'),
        nls.localize('vueport/color/model/mid', 'Middle'),
        nls.localize('vueport/color/model/near', 'Near'),
    ];
    return <div className='vp-color-model-ramp' data-ramp={ramp.join(',')} data-steps={steps}>
        <ColorField value={nearOf(ramp)} disabled={props.disabled} onChange={color => props.onChange(color, steps)} />
        {props.four && <span className='vp-color-tool-options' data-option='depthSteps'>
            <RadioSelect key={steps} size='small' disabled={props.disabled} defaultValue={String(steps)} options={[
                { value: '3', label: nls.localize('vueport/color/model/steps3', '3 Shades'),
                    tooltip: nls.localize('vueport/color/model/steps3Hint', 'The game\'s three shades, by the model\'s distance') },
                { value: '4', label: nls.localize('vueport/color/model/steps4', '4 Shades'),
                    tooltip: nls.localize('vueport/color/model/steps4Hint', 'Four shades by each line\'s own depth (they take four palettes)') },
            ]} onChange={chosen => chosen.length && +chosen[0].value !== steps && props.onChange(nearOf(ramp), +chosen[0].value as 3 | 4)} />
        </span>}
        <span className='vp-color-model-shades' title={steps === 4
            ? nls.localize('vueport/color/model/shadesHint4', 'Near to far by each line\'s depth, as the game shows them')
            : nls.localize('vueport/color/model/shadesHint', 'Near, middle and far, as the game shows them')}>
            {/* near shade first, next to the color picker */}
            {ramp.map((color, i) => <span key={i} className='vp-color-model-shade' style={{ background: color }} title={labels[i]} />).reverse()}
        </span>
    </div>;
}

function ClassSheet(props: { editor: ColorEditor, name: ColorModelClass, entry: ColorSheetEntry }): React.JSX.Element {
    const { editor, name, entry } = props;
    const ramp = editor.classRamp(name);
    const painted = editor.classPaint(name) !== undefined;
    const hints: { [key in ColorModelClass]: string } = {
        scenery: nls.localize('vueport/color/model/sceneryHint', 'Every scenery block of every stage: walls, ground and buildings.'),
        debris: nls.localize('vueport/color/model/debrisHint',
            'The lines of explosions; they darken as they fade. Debris of an edge painted on a model keeps that edge\'s color.'),
        fixed: nls.localize('vueport/color/model/fixedHint', 'The homing missiles (R button), drawn from the ship.'),
    };
    return <div className='vp-color-model-class' data-model-class={name}>
        <h3>{entry.name}</h3>
        <div className='vp-color-hint'>{hints[name]}</div>
        <fieldset className='vp-color-section' data-depth>
            <legend>{nls.localize('vueport/color/model/color', 'Color')}</legend>
            <DepthColor ramp={ramp} disabled={!editor.canPaint()} four={name === 'scenery' && supportsDepth4(editor.modelPackage, 'E')}
                onChange={(color, steps) => editor.paintModelClass(name, paintOf(color, steps))} />
            <div className='vp-color-actions'>
                <button type='button' className='vp-button' data-class-brush disabled={!editor.canPaint()}
                    onClick={() => editor.paintModelClass(name, editor.brushColor)}>
                    {nls.localize('vueport/color/model/useBrush', 'Use the Brush Color')}
                </button>
                <button type='button' className='vp-button secondary' data-class-reset disabled={!painted}
                    onClick={() => editor.paintModelClass(name, null)}>
                    {nls.localize('vueport/color/model/resetRamp', 'Package Colors')}
                </button>
            </div>
        </fieldset>
        <Brushes editor={editor} />
        <PaletteCount editor={editor} />
    </div>;
}

function WireframeSheet(props: { editor: ColorEditor, entry: ColorSheetEntry, model: ColorModel, frame: Wireframe }): React.JSX.Element {
    const { editor, entry, model, frame } = props;
    const list = model.edges;
    const [tool, setTool] = React.useState<ModelTool>('pencil');
    const [view, setView] = React.useState<ModelView>(() => startView(OBLIQUE.yaw, OBLIQUE.pitch));
    const [selection, setSelection] = React.useState<ReadonlySet<number>>(() => new Set());
    const [hiddenParts, setHiddenParts] = React.useState<ReadonlySet<number>>(() => new Set());
    const [activePart, setActivePart] = React.useState<number | undefined>(undefined);
    const [lastEdge, setLastEdge] = React.useState<number | undefined>(() => editor.modelFocus?.model === list ? [...editor.modelFocus.edges][0] : undefined);
    const [hover, setHover] = React.useState<number | undefined>(undefined);
    // the part under the pointer in the Parts section gets marked on the model, as does the part under the pointer with
    // the selection tool, and nothing else, since marks get in the way of the colors
    const [hoverPart, setHoverPart] = React.useState<number | undefined>(undefined);
    const [renaming, setRenaming] = React.useState<number | undefined>(undefined);
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    const viewRef = React.useRef<HTMLDivElement>(null);
    const canvas = React.useRef<HTMLCanvasElement>(null);
    const drag = React.useRef<{ x: number, y: number, moved: boolean, view: ModelView, pan: boolean } | undefined>(undefined);
    const [panning, setPanning] = React.useState<'ready' | 'drag' | undefined>(undefined);
    const spaceDown = React.useRef(false);
    const pointerInside = React.useRef(false);
    const parts = model.parts ?? [{ name: entry.name, edges: frame.edges.map((_, i) => i) }];
    const partOf = React.useMemo(() => {
        const of = new Map<number, number>();
        parts.forEach((part, p) => part.edges.forEach(edge => of.set(edge, p)));
        return of;
    }, [model]);
    const visible = (edge: number): boolean => !hiddenParts.has(partOf.get(edge) ?? -1);
    const focus = editor.modelFocus?.model === list ? editor.modelFocus.edges : undefined;
    const paint = editor.modelPaint(list);
    const ramps = frame.edges.map((_, edge) => editor.edgeRamp(model, edge));

    React.useEffect(() => {
        const node = viewRef.current;
        if (!node) {
            return undefined;
        }
        const observer = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }));
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    React.useEffect(() => {
        if (focus?.size) {
            setLastEdge([...focus][0]);
        }
    }, [editor.modelFocus]);

    const projected = React.useMemo(() => size.width ? project(frame, view, size.width, size.height) : undefined,
        [frame, view, size.width, size.height]);

    React.useEffect(() => {
        const node = canvas.current;
        if (!node || !projected) {
            return;
        }
        const ratio = window.devicePixelRatio || 1;
        node.width = Math.round(size.width * ratio);
        node.height = Math.round(size.height * ratio);
        const g = node.getContext('2d')!;
        g.setTransform(ratio, 0, 0, ratio, 0, 0);
        g.fillStyle = '#000';
        g.fillRect(0, 0, size.width, size.height);
        const { points, depth } = projected;
        // far edges first, so near ones are drawn over them
        const order = frame.edges.map((_, i) => i).filter(visible)
            .sort((a, b) => (depth[frame.edges[b][0]] + depth[frame.edges[b][1]]) - (depth[frame.edges[a][0]] + depth[frame.edges[a][1]]));
        g.lineCap = 'round';
        for (const edge of order) {
            const [a, b] = frame.edges[edge];
            g.strokeStyle = nearOf(ramps[edge]);
            g.lineWidth = edge === hover ? 3.5 : 2;
            g.beginPath();
            g.moveTo(...points[a]);
            g.lineTo(...points[b]);
            g.stroke();
        }
        const shownPart = hoverPart ?? (tool === 'select' && hover !== undefined ? partOf.get(hover) : undefined);
        const marked = shownPart !== undefined ? parts[shownPart]?.edges.filter(visible) : undefined;
        if (marked?.length) {
            g.strokeStyle = getComputedStyle(node).getPropertyValue('--vp-accent').trim() || '#d4262c';
            g.lineWidth = 5;
            g.beginPath();
            for (const edge of marked) {
                const [a, b] = frame.edges[edge];
                g.moveTo(...points[a]);
                g.lineTo(...points[b]);
            }
            g.stroke();
        }
    });

    const edgeAt = (x: number, y: number): number | undefined => {
        if (!projected) {
            return undefined;
        }
        let best: number | undefined;
        let bestDistance = 6;
        frame.edges.forEach(([a, b], edge) => {
            if (!visible(edge)) {
                return;
            }
            const d = distanceToSegment(x, y, projected.points[a], projected.points[b]);
            if (d < bestDistance) {
                bestDistance = d;
                best = edge;
            }
        });
        return best;
    };
    const local = (event: React.PointerEvent | React.WheelEvent): [number, number] => {
        const box = canvas.current!.getBoundingClientRect();
        return [event.clientX - box.left, event.clientY - box.top];
    };
    const colorKey = (edge: number): string => ramps[edge].join(',');
    const targets = (edge: number): number[] => selection.has(edge) ? [...selection] : [edge];
    const fill = (edge: number): number[] => {
        if (selection.has(edge)) {
            return [...selection];
        }
        const mode = editor.toolOptions.modelFillMode;
        if (mode === 'part') {
            return (parts[partOf.get(edge) ?? -1]?.edges ?? [edge]).filter(visible);
        }
        const key = colorKey(edge);
        if (mode === 'all') {
            return frame.edges.map((_, other) => other).filter(other => visible(other) && colorKey(other) === key);
        }
        const seen = new Set([edge]);
        const todo = [edge];
        while (todo.length) {
            const [a, b] = frame.edges[todo.pop()!];
            frame.edges.forEach(([c, d], other) => {
                if (!seen.has(other) && visible(other) && (c === a || c === b || d === a || d === b) && colorKey(other) === key) {
                    seen.add(other);
                    todo.push(other);
                }
            });
        }
        return [...seen];
    };
    const click = (edge: number | undefined, event: React.PointerEvent): void => {
        if (tool === 'select') {
            const part = edge !== undefined ? partOf.get(edge) : undefined;
            const edges = part !== undefined ? parts[part]?.edges ?? [] : [];
            if (event.shiftKey || event.altKey) {
                const next = new Set(selection);
                edges.forEach(e => event.altKey ? next.delete(e) : next.add(e));
                setSelection(next);
                setActivePart(undefined);
            } else {
                setSelection(new Set(edges));
                setActivePart(part);
            }
            if (edge !== undefined) {
                setLastEdge(edge);
            }
            return;
        }
        if (edge === undefined) {
            return;
        }
        setLastEdge(edge);
        if (tool === 'pipette' || (event.altKey && tool !== 'eraser')) {
            editor.setBrushColor(nearOf(ramps[edge]));
        } else if (tool === 'pencil') {
            editor.paintModelEdges(list, targets(edge), editor.brushColor);
        } else if (tool === 'eraser') {
            editor.paintModelEdges(list, targets(edge), null);
        } else if (tool === 'fill') {
            editor.paintModelEdges(list, fill(edge), editor.brushColor);
        }
    };
    const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        const pan = event.button === 1 || (event.button === 0 && (spaceDown.current || tool === 'hand'));
        if (event.button !== 0 && !pan) {
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        stopTurning();
        const [x, y] = local(event);
        drag.current = { x, y, moved: false, view, pan };
        if (pan) {
            setPanning('drag');
        }
    };
    const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        const [x, y] = local(event);
        const d = drag.current;
        if (!d) {
            setHover(edgeAt(x, y));
            return;
        }
        if (!d.moved && Math.hypot(x - d.x, y - d.y) < 4) {
            return;
        }
        d.moved = true;
        if (d.pan) {
            setView({ ...d.view, x: d.view.x + x - d.x, y: d.view.y + y - d.y });
        } else {
            setView({ ...d.view, yaw: d.view.yaw + (x - d.x) * 0.6, pitch: Math.max(-89, Math.min(89, d.view.pitch + (y - d.y) * 0.6)) });
        }
    };
    const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        const d = drag.current;
        drag.current = undefined;
        const [x, y] = local(event);
        if (!d) {
            return;
        }
        if (d.pan) {
            setPanning(spaceDown.current ? 'ready' : undefined);
            return;
        }
        if (!d.moved) {
            click(edgeAt(x, y), event);
        }
    };
    // keeps the point under the pointer (or the view's middle) in place
    const step = (direction: 1 | -1, at?: { clientX: number, clientY: number }): void => setView(previous => {
        const next = direction > 0 ? ZOOMS.find(z => z > previous.zoom + 1e-6) : [...ZOOMS].reverse().find(z => z < previous.zoom - 1e-6);
        if (!next) {
            return previous;
        }
        const box = canvas.current?.getBoundingClientRect();
        const px = (at && box ? at.clientX - box.left : size.width / 2) - size.width / 2;
        const py = (at && box ? at.clientY - box.top : size.height / 2) - size.height / 2;
        const by = next / previous.zoom;
        return { ...previous, zoom: next, x: px - (px - previous.x) * by, y: py - (py - previous.y) * by };
    });
    const turning = React.useRef<number | undefined>(undefined);
    const stopTurning = (): void => {
        if (turning.current !== undefined) {
            cancelAnimationFrame(turning.current);
            turning.current = undefined;
        }
    };
    React.useEffect(() => stopTurning, []);
    const turnTo = (target: ModelView): void => {
        stopTurning();
        const from = view;
        const yaw = ((target.yaw - from.yaw) % 360 + 540) % 360 - 180; // the shorter way round
        const began = performance.now();
        const tick = (now: number): void => {
            const t = Math.min(1, (now - began) / 350);
            const e = 1 - (1 - t) ** 3;
            const between = (a: number, b: number): number => a + (b - a) * e;
            setView({
                yaw: from.yaw + yaw * e, pitch: between(from.pitch, target.pitch),
                zoom: between(from.zoom, target.zoom), x: between(from.x, target.x), y: between(from.y, target.y),
            });
            turning.current = t < 1 ? requestAnimationFrame(tick) : undefined;
        };
        turning.current = requestAnimationFrame(tick);
    };
    const fit = (): void => setView(previous => ({ ...previous, zoom: 1, x: 0, y: 0 }));
    const stepRef = React.useRef(step);
    stepRef.current = step;
    React.useEffect(() => {
        const node = viewRef.current;
        if (!node) {
            return undefined;
        }
        const onWheel = (event: WheelEvent): void => {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey || event.altKey) { // a trackpad pinch arrives as Ctrl+wheel
                stepRef.current(event.deltaY < 0 ? 1 : -1, event);
            } else {
                setView(previous => ({ ...previous, x: previous.x - event.deltaX, y: previous.y - event.deltaY }));
            }
        };
        node.addEventListener('wheel', onWheel, { passive: false });
        return () => node.removeEventListener('wheel', onWheel);
    }, []);
    // holding Space over the view switches to the hand; listened for on the window, since the view need not have the
    // focus and the game must not get the key
    React.useEffect(() => {
        const typing = (event: KeyboardEvent): boolean => !!(event.target as HTMLElement | null)?.closest?.('input, textarea');
        const down = (event: KeyboardEvent): void => {
            if (event.key !== ' ' || typing(event) || (!pointerInside.current && !spaceDown.current)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (!spaceDown.current) {
                spaceDown.current = true;
                setPanning(previous => previous ?? 'ready');
            }
        };
        const up = (event: KeyboardEvent): void => {
            if (event.key === ' ' && spaceDown.current) {
                spaceDown.current = false;
                setPanning(previous => previous === 'ready' ? undefined : previous);
            }
        };
        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        return () => {
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
        };
    }, []);
    const onKeyDown = (event: React.KeyboardEvent): void => {
        if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).closest('input')) {
            return;
        }
        const keys: { [key: string]: ModelTool } = { b: 'pencil', e: 'eraser', g: 'fill', i: 'pipette', h: 'hand', v: 'select' };
        const key = event.key.toLowerCase();
        if (keys[key]) {
            setTool(keys[key]);
        } else if (key === 'x') {
            editor.nextBrush(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Escape') {
            setSelection(new Set());
        } else if (event.key === '+' || event.key === '=') {
            step(1);
        } else if (event.key === '-') {
            step(-1);
        } else if (event.key === '0') {
            fit();
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    };

    const depthEdges = selection.size ? [...selection] : activePart !== undefined ? parts[activePart]?.edges ?? [] : lastEdge !== undefined ? [lastEdge] : [];
    const depthRamp = depthEdges.length ? ramps[depthEdges[0]] : undefined;
    const usedColors = [...new Set(ramps.map(nearOf))];
    const toolButton = (id: ModelTool, icon: React.ReactNode, label: string, key: string): React.ReactNode => <button
        type='button'
        className={`vp-color-tool-button${tool === id ? ' on' : ''}`}
        title={`${label} (${key})`}
        aria-pressed={tool === id}
        data-tool={id}
        onClick={() => setTool(id)}
    >{icon}</button>;
    const radio = <T extends string>(data: string, value: T, choices: { value: T, label: React.ReactNode, tooltip: string }[], change: (value: T) => void): React.ReactNode =>
        <span className='vp-color-tool-options' data-option={data}>
            <RadioSelect size='small' options={choices.map(c => ({ value: c.value, label: c.label as string, tooltip: c.tooltip }))} defaultValue={value}
                onChange={chosen => chosen.length && change(chosen[0].value as T)} />
        </span>;
    const hovered = hover !== undefined ? hover : undefined;
    const status = hovered !== undefined
        ? nls.localize('vueport/color/model/edgeStatus', 'Edge {0} · {1} · {2}', hovered, editor.modelPartName(list, partOf.get(hovered) ?? 0,
            parts[partOf.get(hovered) ?? 0]?.name ?? ''), paint[hovered] !== undefined ? nearOf(ramps[hovered]) : nls.localize('vueport/color/model/packageColor', 'package color'))
        : nls.localize('vueport/color/model/viewStatus', '{0} edges, {1} painted. Drag turns the model, {2} and the wheel zoom.',
            frame.edges.length, Object.keys(paint).length, MOD);

    return <div className='vp-color-model-body' tabIndex={-1} onKeyDown={onKeyDown} data-own-keys>
        <div className='vp-color-toolbar'>
            <button type='button' className='vp-color-tool-button' data-undo disabled={!editor.canUndo}
                title={nls.localize('vueport/color/sheet/undo', 'Undo ({0})', `${MOD}+Z`)} onClick={() => editor.undo()}><ArrowCounterClockwise size={18} /></button>
            <button type='button' className='vp-color-tool-button' data-redo disabled={!editor.canRedo}
                title={nls.localize('vueport/color/sheet/redo', 'Redo ({0})', `${MOD}+Shift+Z`)} onClick={() => editor.redo()}><ArrowClockwise size={18} /></button>
            <span className='vp-color-toolbar-divider' />
            {toolButton('pencil', <Pencil size={18} />, nls.localize('vueport/color/model/tool/pencil', 'Pencil: color an edge'), 'B')}
            {toolButton('eraser', <Eraser size={18} />, nls.localize('vueport/color/model/tool/eraser', 'Eraser: an edge back to the package\'s color'), 'E')}
            {toolButton('fill', <PaintBucket size={18} />, nls.localize('vueport/color/sheet/tool/fill', 'Fill'), 'G')}
            {toolButton('pipette', <Eyedropper size={18} />, nls.localize('vueport/color/model/tool/pipette', 'Take an edge\'s color (Alt-click with the others)'), 'I')}
            {toolButton('hand', <Hand size={18} />, nls.localize('vueport/color/sheet/tool/hand', 'Move the view (or hold Space)'), 'H')}
            {toolButton('select', <Cursor size={18} />, nls.localize('vueport/color/model/tool/select',
                'Select a part without coloring it (Shift adds, Alt takes out)'), 'V')}
            {tool === 'fill' && <>
                <span className='vp-color-toolbar-divider' />
                {radio('modelFillMode', editor.toolOptions.modelFillMode, [
                    { value: 'all', label: nls.localize('vueport/color/sheet/option/all', 'All'),
                        tooltip: nls.localize('vueport/color/model/option/allHint', 'Fills every edge of that color in the model') },
                    { value: 'contiguous', label: nls.localize('vueport/color/sheet/option/contiguous', 'Contiguous'),
                        tooltip: nls.localize('vueport/color/model/option/contiguousHint', 'Fills the edges of that color that touch') },
                    { value: 'part', label: nls.localize('vueport/color/model/option/part', 'Part'),
                        tooltip: nls.localize('vueport/color/model/option/partHint', 'Fills the whole part') },
                ], mode => editor.setToolOption('modelFillMode', mode))}
            </>}
        </div>
        <div className='vp-color-sheet-body'>
            <div className='vp-color-sheet-view' ref={viewRef}>
                <canvas
                    ref={canvas}
                    className={`vp-color-sheet-canvas vp-color-model-canvas ${panning ? `pan-${panning}` : `tool-${tool}`}`}
                    style={{ width: size.width, height: size.height }}
                    data-edges={frame.edges.length}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onPointerEnter={() => pointerInside.current = true}
                    onPointerLeave={() => {
                        pointerInside.current = false;
                        if (!drag.current) {
                            setHover(undefined);
                        }
                    }}
                    onAuxClick={event => event.preventDefault()}
                    onContextMenu={event => event.preventDefault()}
                />
                <NavCube yaw={view.yaw} pitch={view.pitch}
                    onFace={face => {
                        const target = NAV_FACES.find(f => f.id === face)!;
                        turnTo({ ...view, yaw: target.yaw, pitch: target.pitch });
                    }}
                    onHome={() => turnTo(startView(OBLIQUE.yaw, OBLIQUE.pitch))}
                    onTurnStart={stopTurning}
                    onTurn={(yaw, pitch) => setView(previous => ({ ...previous, yaw, pitch }))} />
            </div>
            <div className='vp-color-sheet-side'>
                <fieldset className='vp-color-section' data-parts>
                    <legend>{nls.localize('vueport/color/model/parts', 'Parts')}</legend>
                    <div className='vp-color-layers'>
                        {parts.map((part, p) => {
                            const name = editor.modelPartName(list, p, part.name);
                            return <div
                                key={p}
                                className={`vp-color-layer${activePart === p ? ' on' : ''}${hiddenParts.has(p) ? ' hidden' : ''}`}
                                data-part={name}
                                title={nls.localize('vueport/color/model/partHint', 'Click: choose its edges (the Color section changes them). Double click: name it.')}
                                onClick={() => {
                                    setActivePart(activePart === p ? undefined : p);
                                    setSelection(activePart === p ? new Set() : new Set(part.edges));
                                }}
                                onDoubleClick={() => setRenaming(p)}
                                onMouseEnter={() => setHoverPart(p)}
                                onMouseLeave={() => setHoverPart(previous => previous === p ? undefined : previous)}
                            >
                                <button type='button' className='vp-color-tool-button' data-part-eye
                                    title={hiddenParts.has(p) ? nls.localize('vueport/color/model/showPart', 'Show the part')
                                        : nls.localize('vueport/color/model/hidePart', 'Hide the part (to reach the edges behind it)')}
                                    onClick={event => {
                                        event.stopPropagation();
                                        const next = new Set(hiddenParts);
                                        if (next.has(p)) {
                                            next.delete(p);
                                        } else {
                                            next.add(p);
                                        }
                                        setHiddenParts(next);
                                    }}>{hiddenParts.has(p) ? <EyeSlash size={14} /> : <Eye size={14} />}</button>
                                {renaming === p
                                    ? <input className='vp-input vp-color-layer-input' autoFocus defaultValue={name}
                                        onClick={event => event.stopPropagation()}
                                        onBlur={event => {
                                            editor.renameModelPart(list, p, event.currentTarget.value, part.name);
                                            setRenaming(undefined);
                                        }}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter') {
                                                event.currentTarget.blur();
                                            } else if (event.key === 'Escape') {
                                                setRenaming(undefined);
                                            }
                                            event.stopPropagation();
                                        }} />
                                    : <span className='vp-color-layer-name'>{name}</span>}
                                <span className='vp-color-model-part-swatch' style={{ background: ramps[part.edges[0]] && nearOf(ramps[part.edges[0]]) }} />
                            </div>;
                        })}
                    </div>
                </fieldset>
                <fieldset className='vp-color-section' data-depth>
                    <legend>{nls.localize('vueport/color/model/color', 'Color')}</legend>
                    {depthRamp
                        ? <>
                            <div className='vp-color-hint'>{editor.modelPackage?.decoders.kind === 'zr'
                                ? nls.localize('vueport/color/model/colorHintKind',
                                    '{0} edges. The game shades these lines by kind: machines that are not selected show the middle shade.',
                                    depthEdges.length)
                                : nls.localize('vueport/color/model/colorHint', '{0} edges.', depthEdges.length)}</div>
                            <DepthColor ramp={depthRamp} disabled={!editor.canPaint()}
                                four={supportsDepth4(editor.modelPackage) && editor.modelPackage?.decoders.kind !== 'zr'}
                                onChange={(color, steps) => editor.paintModelEdges(list, depthEdges, paintOf(color, steps))} />
                            <div className='vp-color-actions'>
                                <button type='button' className='vp-color-sheet-reset' data-color-reset
                                    disabled={!editor.canPaint() || !depthEdges.some(edge => paint[edge] !== undefined)}
                                    title={nls.localize('vueport/color/model/resetColorHint', 'These edges back to the package\'s colors')}
                                    onClick={() => editor.paintModelEdges(list, depthEdges, null)}>
                                    <ArrowUUpLeft size={14} /><span>{nls.localize('vueport/color/model/resetColor', 'Reset')}</span>
                                </button>
                            </div>
                        </>
                        : <div className='vp-color-hint'>{nls.localize('vueport/color/model/colorNone', 'Choose edges, a part or an edge to change its color.')}</div>}
                    <PaletteCount editor={editor} />
                </fieldset>
                <Brushes editor={editor} />
                <fieldset className='vp-color-section' data-sheet-colors>
                    <legend>{nls.localize('vueport/color/sheet/colors', 'Sheet colors')}</legend>
                    <Swatches editor={editor} colors={usedColors} />
                </fieldset>
            </div>
        </div>
        <div className='vp-color-sheet-status'>
            <span className='vp-color-sheet-status-side'>
                <button type='button' className='vp-color-sheet-reset' data-reset='model' disabled={!Object.keys(paint).length}
                    title={nls.localize('vueport/color/model/resetHint', 'Every edge of the model back to the package\'s colors')}
                    onClick={() => editor.resetSheetPaint(entry.sheet, entry.name)}>
                    <ArrowUUpLeft size={14} /><span>{nls.localize('vueport/color/model/reset', 'Reset Model')}</span>
                </button>
            </span>
            <span className='vp-color-sheet-status-text' data-model-status>{status}</span>
            <span className='vp-color-sheet-zoom-controls'>
                <button type='button' className='vp-color-tool-button' title={nls.localize('vueport/color/sheet/zoomOut', 'Zoom out (-)')}
                    onClick={() => step(-1)}><MagnifyingGlassMinus size={14} /></button>
                <button type='button' className='vp-color-sheet-zoom' data-fit title={nls.localize('vueport/color/sheet/fit', 'Fit (0)')}
                    onClick={fit}>{`${Math.round(view.zoom * 100)}%`}</button>
                <button type='button' className='vp-color-tool-button' title={nls.localize('vueport/color/sheet/zoomIn', 'Zoom in (+)')}
                    onClick={() => step(1)}><MagnifyingGlassPlus size={14} /></button>
            </span>
        </div>
    </div>;
}
