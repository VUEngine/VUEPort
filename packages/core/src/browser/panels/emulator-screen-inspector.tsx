import { Crosshair, Cursor, Palette, PushPin, Shapes, Stack, User, X } from '@phosphor-icons/react';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { nls } from '../../common/emulator-nls';
import { decodeOrigin, originDrawnBy, VbPixelOrigin, VbPixelSource } from '../../common/vb-pixel-origin';
import { StopReason, StopWrite } from '../../common/vb-protocol';
import { Disposable } from '../../common/emulator-events';
import { VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH, VBC_CRAM_BASE, VBC_CRAM_PALETTE_BYTES } from '../../common/vb-constants';
import { DOM_HOVER } from '../components/kit/dom-hover';
import { VbColorIcon } from '../components/kit/VbColorIcon';
import { actorAtPoint, actorDrawing, actorLabel, actorPixelSource, readActors, VesActor, VesActorsStatus } from '../core/emulator-actors';
import { findFunctionAt, functionDisplayName, SymbolIndex } from '../core/emulator-symbols';
import { Sim } from '../core/vb-core';
import { BYTES_PER_MBIT, STRIP_IDLE_DELAY, STRIP_WAKE_DISTANCE } from '../emulator-types';
import { hex } from './emulator-panel';
import { ScreenPanel, VesScreenRect } from './emulator-screen-panel';

/**
 * Screen inspector, Debug mode only: what drew each pixel, from the origin the core keeps beside every pixel (world, BG
 * map cell or object, character pixel, palette, or the writing instruction; see vb-pixel-origin.ts). Hovering says what
 * drew the pixel and lights everything the same cell or object drew; a click pins it with links to the panels. The
 * views wash the picture by world, kind, palette or VB Color palette, and whatever a panel points at is lit pixel for
 * pixel. Owned by the dock, which knows the mode and the inspected machine.
 */

export type ScreenInspectorView = 'picture' | 'worlds' | 'kinds' | 'palettes' | 'vbc';

const VIEWS: ScreenInspectorView[] = ['picture', 'worlds', 'kinds', 'palettes', 'vbc'];

export interface ScreenInspectorHost {
    sim(): Sim | undefined;
    vbcHardwareActive(): boolean;
    romSize(): number; // in MBit, for naming code by the build's symbols
    getSymbols(): Promise<SymbolIndex | undefined>;
    reveal(target: ScreenInspectorTarget): void;
    rememberedView(): ScreenInspectorView;
    rememberView(view: ScreenInspectorView): void;
}

export type ScreenInspectorTarget =
    | VbPixelSource
    | { kind: 'code', address: number }
    | { kind: 'actor', address: number }
    | { kind: 'memory', address: number };

// empty when that cannot be said
function writeRanges(source: VbPixelSource): { address: number, length: number }[] {
    switch (source.kind) {
        case 'cell':
            return [{ address: source.address, length: 2 }];
        case 'object':
            return [{ address: 0x0003e000 + source.object * 8, length: 8 }];
        case 'world':
            return [{ address: 0x0003d800 + source.world * 32, length: 32 }];
        case 'vbcPalette':
            return [{ address: VBC_CRAM_BASE + source.palette * VBC_CRAM_PALETTE_BYTES, length: VBC_CRAM_PALETTE_BYTES }];
        case 'character': {
            // VB Color characters past 2047 live in VCU memory, not mapped here; the VIP's 2048 have two windows
            const char = source.character;
            if (char >= 2048) {
                return [];
            }
            return [
                { address: 0x00006000 + (char >> 9) * 0x8000 + (char & 511) * 16, length: 16 },
                { address: 0x00078000 + char * 16, length: 16 },
            ];
        }
        case 'sprites':
            // worlds and objects the engine reassigns every frame: a write to one says nothing about the actor
            return [];
    }
}

function sourceLabel(source: VbPixelSource): string {
    switch (source.kind) {
        case 'cell': {
            const index = (source.address - 0x00020000) >> 1;
            return nls.localize('vueport/debug/inspector/target/cell', 'BGMap {0} cell {1}, {2}',
                index >> 12, index & 63, index >> 6 & 63);
        }
        case 'object':
            return nls.localize('vueport/debug/inspector/target/object', 'Object {0}', source.object);
        case 'world':
            return nls.localize('vueport/debug/inspector/target/world', 'World {0}', source.world);
        case 'character':
            return nls.localize('vueport/debug/inspector/target/character', 'Character {0}', source.character);
        case 'vbcPalette':
            return nls.localize('vueport/debug/inspector/target/vbcPalette', 'VB Color palette {0}', `0x${hex(source.palette, 2)}`);
        case 'sprites':
            return nls.localize('vueport/debug/inspector/target/sprites', 'Sprites');
    }
}

function colorSourceLabel(origin: VbPixelOrigin): string {
    const chosen = {
        attribute: nls.localize('vueport/debug/inspector/vbcSource/attribute', 'color attribute'),
        character: nls.localize('vueport/debug/inspector/vbcSource/character', 'character\'s color attribute'),
        slot: nls.localize('vueport/debug/inspector/vbcSource/slot', 'pixel color slot'),
        register: nls.localize('vueport/debug/inspector/vbcSource/register', 'CBKPAL'),
        rows: nls.localize('vueport/debug/inspector/vbcSource/rows', 'backdrop row table'),
    }[origin.vbcSource ?? 'attribute'];
    return origin.vbcOffset
        ? nls.localize('vueport/debug/inspector/vbcSource/offset', '{0} + world offset', chosen)
        : chosen;
}

interface ScreenPoint {
    eye: 0 | 1;
    x: number;
    y: number;
}

interface Inspected extends ScreenPoint {
    origin: VbPixelOrigin;
    clientX: number;
    clientY: number;
}

const WASH_ALPHA = 150;
const LEGEND_ENTRIES = 12;
// the backdrop is most of most pictures; washed as strongly it would be all one sees
const BACKDROP_ALPHA = 45;
// green, which nothing on a Virtual Boy is
const LIT = [0, 255, 0, 190];
const DIMMED = [0, 0, 0, 120];

// same interval as the Actors panel
const ACTOR_READ_MS = 250;

const KIND_COLORS: Record<string, [number, number, number]> = {
    backdrop: [70, 70, 90],
    cell: [60, 140, 255],
    overplane: [0, 210, 210],
    object: [255, 170, 0],
    cpu: [230, 60, 230],
    debugger: [255, 255, 80],
};

// GPLT0-3 in blues, JPLT0-3 in oranges
const PALETTE_COLORS: [number, number, number][] = [
    [40, 90, 220], [70, 150, 255], [120, 200, 255], [180, 230, 255],
    [230, 110, 0], [255, 160, 40], [255, 205, 90], [255, 235, 160],
];

function hueColor(index: number): [number, number, number] {
    const hue = (index * 137.508) % 360;
    // HSL at full saturation and 55 % lightness
    const k = (n: number): number => (n + hue / 30) % 12;
    const a = 0.45;
    const channel = (n: number): number => Math.round(255 * (0.55 - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return [channel(0), channel(8), channel(4)];
}

function viewColor(view: ScreenInspectorView, what: number, where: number): [number, number, number] | undefined {
    const kind = what & 7;
    if (kind === 0) {
        return undefined;
    }
    switch (view) {
        case 'worlds':
            return kind >= 2 && kind <= 4 ? hueColor(31 - (what >>> 3 & 31)) : undefined;
        case 'kinds':
            return KIND_COLORS[['unknown', 'backdrop', 'cell', 'overplane', 'object', 'cpu', 'debugger'][kind]];
        case 'palettes':
            return kind >= 2 && kind <= 4 ? PALETTE_COLORS[(kind === 4 ? 4 : 0) + (what >>> 30)] : undefined;
        case 'vbc':
            return where & 0x1000000 && kind !== 5 && kind !== 6 ? hueColor(where >>> 16 & 0xff) : undefined;
        default:
            return undefined;
    }
}

function primarySource(origin: VbPixelOrigin): VbPixelSource | undefined {
    if (origin.object) {
        return { kind: 'object', object: origin.object.index };
    }
    if (origin.bgmap) {
        return { kind: 'cell', address: origin.bgmap.address };
    }
    return undefined;
}

export class ScreenInspector {

    protected enabled = false;
    protected picking = false;
    protected view: ScreenInspectorView;
    // two words a pixel, left eye then right
    protected origins?: Uint32Array;
    protected hovered?: Inspected;
    protected pinned?: Inspected;
    protected panelSource?: VbPixelSource;
    protected cardSource?: VbPixelSource;
    protected symbols?: SymbolIndex;
    protected armed?: { label: string };
    protected caught?: { label: string, write: StopWrite };
    protected refused?: string;
    protected stopWatch?: Disposable;
    protected watchedSim?: Sim;
    protected streamSim?: Sim;
    protected streamWatch?: Disposable;
    protected paintPending = false;
    protected readonly root: Root;
    protected pickingActors = false;
    protected actors?: VesActor[];
    protected actorTimer?: ReturnType<typeof setInterval>;
    protected readingActors = false;
    protected hoveredActor?: { actor: VesActor, point: ScreenPoint, clientX: number, clientY: number };
    // a VUEngine build with its debug sections
    protected actorsAvailable = false;
    // not remembered, as it was not on the panel
    protected markingSelection = true;
    protected selectionRects: VesScreenRect[] = [];

    constructor(protected readonly screen: ScreenPanel, protected readonly host: ScreenInspectorHost) {
        this.view = host.rememberedView();
        this.root = createRoot(screen.tools);
        const picture = screen.pictureElement;
        picture.addEventListener('pointermove', this.onPointerMove);
        picture.addEventListener('pointerleave', this.onPointerLeave);
        picture.addEventListener('click', this.onClick, true);
        window.addEventListener('keydown', this.onKey, true);
        screen.node.addEventListener('pointermove', this.onPanelMove);
        screen.node.addEventListener('pointerdown', this.wake);
        screen.node.addEventListener('pointerleave', this.onPanelLeave);
    }

    // the tools come and go like the transport strip (see Emulator): up while the pointer moves over the screen panel,
    // gone when still or left, unless pinned or something of theirs is on

    protected barPinned = false;
    protected awake = false;
    protected overTools = false;
    protected idleTimer?: ReturnType<typeof setTimeout>;
    // see STRIP_WAKE_DISTANCE
    protected restingAt?: { x: number, y: number };

    protected busy(): boolean {
        return this.picking || this.pickingActors || this.view !== 'picture' || this.pinned !== undefined
            || this.armed !== undefined || this.caught !== undefined || this.refused !== undefined;
    }

    protected readonly onPanelMove = (event: PointerEvent): void => {
        // a non-mouse pointer never holds quite still, so only a real movement counts
        if (event.pointerType !== 'mouse') {
            if (this.restingAt && Math.hypot(event.clientX - this.restingAt.x, event.clientY - this.restingAt.y)
                < STRIP_WAKE_DISTANCE) {
                return;
            }
            this.restingAt = { x: event.clientX, y: event.clientY };
        }
        this.wake();
    };

    protected readonly wake = (): void => {
        if (!this.awake) {
            this.awake = true;
            this.render();
        }
        this.scheduleIdle();
    };

    protected scheduleIdle(): void {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (!this.overTools) {
                this.sleep();
            }
        }, STRIP_IDLE_DELAY);
    }

    protected sleep(): void {
        clearTimeout(this.idleTimer);
        if (this.awake) {
            this.awake = false;
            this.render();
        }
    }

    // a mouse leaving takes the tools with it; other pointers leave after every press, so the delay decides
    protected readonly onPanelLeave = (event: PointerEvent): void => {
        this.overTools = false;
        if (event.pointerType === 'mouse') {
            this.sleep();
        } else {
            this.scheduleIdle();
        }
    };

    protected setBarPinned(pinned: boolean): void {
        this.barPinned = pinned;
        this.render();
    }

    // off forgets everything shown
    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) {
            return;
        }
        this.enabled = enabled;
        if (!enabled) {
            this.picking = false;
            this.pinned = undefined;
            this.hovered = undefined;
            this.panelSource = undefined;
            this.cardSource = undefined;
            this.cancelWriteStop();
            this.caught = undefined;
            this.pickingActors = false;
            this.hoveredActor = undefined;
            this.stopActorReads();
        }
        this.watchStops();
        this.checkActors();
        this.applySelection();
        this.sync();
    }

    setSelectionRects(rects: VesScreenRect[]): void {
        this.selectionRects = rects;
        this.applySelection();
    }

    protected applySelection(): void {
        this.screen.setHighlights(this.enabled && this.markingSelection ? this.selectionRects : []);
    }

    setPanelSource(source: VbPixelSource | undefined): void {
        this.panelSource = source;
        this.sync();
    }

    simChanged(): void {
        this.origins = undefined;
        this.symbols = undefined;
        this.pinned = undefined;
        this.hovered = undefined;
        this.armed = undefined;
        this.caught = undefined;
        this.actors = undefined;
        this.hoveredActor = undefined;
        this.watchStops();
        this.checkActors();
        this.sync();
    }

    protected checkActors(): void {
        const settle = (available: boolean): void => {
            if (available === this.actorsAvailable) {
                return;
            }
            this.actorsAvailable = available;
            if (!available && this.pickingActors) {
                this.setActorPicking(false);
            }
            this.render();
        };
        if (!this.enabled || !this.host.sim()) {
            settle(false);
            return;
        }
        this.host.getSymbols().then(
            symbols => settle(!!symbols?.memoryPool && symbols.structs.size > 0),
            () => settle(false)
        );
    }

    dispose(): void {
        this.stopActorReads();
        this.stream(undefined);
        this.stopWatch?.dispose();
        const picture = this.screen.pictureElement;
        picture.removeEventListener('pointermove', this.onPointerMove);
        picture.removeEventListener('pointerleave', this.onPointerLeave);
        picture.removeEventListener('click', this.onClick, true);
        window.removeEventListener('keydown', this.onKey, true);
        this.screen.node.removeEventListener('pointermove', this.onPanelMove);
        this.screen.node.removeEventListener('pointerdown', this.wake);
        this.screen.node.removeEventListener('pointerleave', this.onPanelLeave);
        clearTimeout(this.idleTimer);
        this.screen.setPixelLayer(undefined);
        this.root.unmount();
    }

    protected readonly onPointerMove = (event: PointerEvent): void => {
        if (!this.enabled) {
            return;
        }
        if (this.pickingActors) {
            const at = this.screen.pointAt(event.clientX, event.clientY);
            this.hoveredActor = at && this.actorHit(at, event.clientX, event.clientY);
            this.paint();
            return;
        }
        if (!this.picking) {
            return;
        }
        const point = this.screen.pointAt(event.clientX, event.clientY);
        this.hovered = point && this.inspect(point, event.clientX, event.clientY);
        this.paint();
    };

    protected readonly onPointerLeave = (): void => {
        if (this.hovered || this.hoveredActor) {
            this.hovered = undefined;
            this.hoveredActor = undefined;
            this.paint();
        }
    };

    protected readonly onClick = (event: MouseEvent): void => {
        if (!this.enabled) {
            return;
        }
        if (this.pickingActors) {
            // opens the Actors panel on it, picking goes on
            event.stopPropagation();
            const at = this.screen.pointAt(event.clientX, event.clientY);
            const hit = at && this.actorHit(at, event.clientX, event.clientY);
            if (hit) {
                this.host.reveal({ kind: 'actor', address: hit.actor.objectAddress });
            }
            return;
        }
        if (!this.picking) {
            return;
        }
        event.stopPropagation();
        const point = this.screen.pointAt(event.clientX, event.clientY);
        this.pinned = point && this.inspect(point, event.clientX, event.clientY);
        this.cardSource = undefined;
        this.paint();
    };

    // Escape lets go of a pinned answer, then of picking
    protected readonly onKey = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || !this.enabled || !(this.picking || this.pickingActors || this.pinned)) {
            return;
        }
        event.stopPropagation();
        event.preventDefault();
        if (this.pinned) {
            this.pinned = undefined;
            this.cardSource = undefined;
        } else if (this.pickingActors) {
            this.setActorPicking(false);
        } else {
            this.setPicking(false);
        }
        this.paint();
    };

    protected inspect(point: ScreenPoint, clientX: number, clientY: number): Inspected {
        return { ...point, clientX, clientY, origin: this.originAt(point) };
    }

    protected originAt(point: ScreenPoint): VbPixelOrigin {
        const [what, where] = this.wordsAt(point);
        return decodeOrigin(what, where);
    }

    // both zero (`unknown`) before any were read
    protected wordsAt(point: ScreenPoint): [number, number] {
        const origins = this.origins;
        if (!origins) {
            return [0, 0];
        }
        const at = (point.eye * VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT + point.y * VB_SCREEN_WIDTH + point.x) * 2;
        return [origins[at], origins[at + 1]];
    }

    protected setPicking(picking: boolean): void {
        if (picking && this.pickingActors) {
            this.setActorPicking(false);
        }
        this.picking = picking;
        if (!picking) {
            this.hovered = undefined;
            this.pinned = undefined;
            this.cardSource = undefined;
        }
        this.screen.pictureElement.classList.toggle('vp-screen-picking', picking);
        this.sync();
    }

    protected setActorPicking(on: boolean): void {
        if (on && this.picking) {
            this.setPicking(false);
        }
        this.pickingActors = on;
        this.hoveredActor = undefined;
        this.screen.pictureElement.classList.toggle('vp-screen-picking', on || this.picking);
        if (on) {
            this.startActorReads();
        } else {
            this.stopActorReads();
        }
        this.sync();
    }

    // asked of the picture first (the object or world the core says drew the pixel, exact with transparency and
    // overlaps); only where the core has nothing, of the sprites' drawn rectangles
    protected actorHit(point: ScreenPoint, clientX: number, clientY: number):
        { actor: VesActor, point: ScreenPoint, clientX: number, clientY: number } | undefined {
        const actors = this.actors;
        if (!actors) {
            return undefined;
        }
        const [what, where] = this.wordsAt(point);
        const actor = actorDrawing(actors, what, where, point.x, point.y, point.eye)
            ?? actorAtPoint(actors, point.x, point.y, point.eye);
        return actor && { actor, point, clientX, clientY };
    }

    protected startActorReads(): void {
        this.stopActorReads();
        const read = (): void => {
            const sim = this.host.sim();
            if (!sim || this.readingActors) {
                return;
            }
            this.readingActors = true;
            this.host.getSymbols()
                .then(symbols => readActors(sim, symbols))
                .then(result => {
                    if (!this.pickingActors || sim !== this.host.sim()) {
                        return;
                    }
                    this.actors = result.status === VesActorsStatus.OK ? result.actors : [];
                    this.refreshHoveredActor();
                    this.paint();
                }, () => undefined)
                .finally(() => {
                    this.readingActors = false;
                });
        };
        read();
        this.actorTimer = setInterval(read, ACTOR_READ_MS);
    }

    protected stopActorReads(): void {
        clearInterval(this.actorTimer);
        this.actorTimer = undefined;
        this.actors = undefined;
    }

    // a running game changes what is under a pointer that has not moved
    protected refreshHoveredActor(): void {
        const hovered = this.hoveredActor;
        if (hovered) {
            this.hoveredActor = this.actorHit(hovered.point, hovered.clientX, hovered.clientY);
        }
    }

    protected setView(view: ScreenInspectorView): void {
        this.view = view;
        this.host.rememberView(view);
        this.sync();
    }

    protected wanted(): boolean {
        return this.enabled && (this.picking || this.pickingActors || this.view !== 'picture'
            || this.panelSource !== undefined);
    }

    protected sync(): void {
        this.stream(this.wanted() ? this.host.sim() : undefined);
        this.paint();
    }

    // origins come with each picture rather than on request, which would trail a moving game by frames
    protected stream(sim: Sim | undefined): void {
        if (sim === this.streamSim) {
            return;
        }
        this.streamWatch?.dispose();
        this.streamWatch = undefined;
        this.streamSim?.streamPixelOrigins(false).catch(() => undefined);
        this.streamSim = sim;
        if (!sim) {
            return;
        }
        this.streamWatch = sim.onPixelOrigins(origins => this.takeOrigins(sim, origins));
        sim.streamPixelOrigins(true).catch(() => undefined);
        // a paused machine sends nothing until resumed, so read what is on show now; answered in order, so never older
        // than an earlier picture
        sim.readPixelOrigins().then(origins => this.takeOrigins(sim, origins), () => undefined);
        if (!this.symbols) {
            this.host.getSymbols().then(symbols => {
                this.symbols = symbols;
            }, () => undefined);
        }
    }

    protected takeOrigins(sim: Sim, origins: Uint32Array | undefined): void {
        if (sim !== this.streamSim) {
            return;
        }
        this.origins = origins;
        if (this.hovered) {
            this.hovered = { ...this.hovered, origin: this.originAt(this.hovered) };
        }
        this.refreshHoveredActor();
        // once per page frame however many pictures arrive, which fast forward makes several
        if (!this.paintPending) {
            this.paintPending = true;
            requestAnimationFrame(() => {
                this.paintPending = false;
                this.paint();
            });
        }
    }

    // a panel's pick wins over the pointer's
    protected litSource(): VbPixelSource | undefined {
        if (this.cardSource) {
            return this.cardSource;
        }
        if (this.panelSource) {
            return this.panelSource;
        }
        if (this.pickingActors) {
            return this.hoveredActor && actorPixelSource(this.hoveredActor.actor);
        }
        const point = this.pinned ?? (this.picking ? this.hovered : undefined);
        return point && primarySource(point.origin);
    }

    protected paint(): void {
        this.screen.setPixelLayer(this.enabled ? this.layer() : undefined);
        this.render();
    }

    protected layer(): { left: ImageData, right: ImageData } | undefined {
        const origins = this.origins;
        const lit = this.litSource();
        const view = this.view === 'vbc' && !this.host.vbcHardwareActive() ? 'picture' : this.view;
        if (!origins || (view === 'picture' && !lit)) {
            return undefined;
        }
        const pixels = VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT;
        const eyes = [0, 1].map(eye => {
            const image = new ImageData(VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT);
            const data = image.data;
            const base = eye * pixels * 2;
            for (let i = 0; i < pixels; i++) {
                const what = origins[base + i * 2];
                const where = origins[base + i * 2 + 1];
                const out = i * 4;
                if (lit) {
                    const x = i % VB_SCREEN_WIDTH;
                    const mark = originDrawnBy(what, where, lit, x, (i - x) / VB_SCREEN_WIDTH, eye as 0 | 1) ? LIT : DIMMED;
                    data[out] = mark[0];
                    data[out + 1] = mark[1];
                    data[out + 2] = mark[2];
                    data[out + 3] = mark[3];
                    continue;
                }
                const color = viewColor(view, what, where);
                if (color) {
                    data[out] = color[0];
                    data[out + 1] = color[1];
                    data[out + 2] = color[2];
                    data[out + 3] = (what & 7) === 1 ? BACKDROP_ALPHA : WASH_ALPHA;
                }
            }
            return image;
        });
        return { left: eyes[0], right: eyes[1] };
    }

    protected render(): void {
        if (!this.enabled) {
            this.root.render(<></>);
            return;
        }
        const shown = this.pinned ?? (this.picking ? this.hovered : undefined);
        const views = VIEWS.filter(view => view !== 'vbc' || this.host.vbcHardwareActive());
        this.root.render(<>
            {shown && this.renderCard(shown, shown === this.pinned)}
            {this.pickingActors && this.hoveredActor && this.renderActorCard(this.hoveredActor)}
            <div
                className={`vp-screen-inspector${this.barPinned || this.awake || this.busy() ? '' : ' idle'}`}
                onPointerEnter={event => {
                    // only a hovering pointer rests on the tools; a tapping one would hold them up for good
                    if (event.pointerType === 'mouse') {
                        this.overTools = true;
                        clearTimeout(this.idleTimer);
                    }
                }}
                onPointerLeave={() => {
                    this.overTools = false;
                    this.scheduleIdle();
                }}
            >
                <div className='vp-screen-inspector-bar' role='toolbar'>
                    {this.button('pick', nls.localize('vueport/debug/inspector/pick', 'Inspect Pixels'),
                        this.picking, <Crosshair size={18} />, () => this.setPicking(!this.picking))}
                    {this.actorsAvailable && this.button('actors',
                        nls.localize('vueport/debug/inspector/pickActors', 'Inspect Actors'),
                        this.pickingActors, <Cursor size={18} />, () => this.setActorPicking(!this.pickingActors))}
                    <span className='vp-screen-inspector-divider' />
                    {views.filter(view => view !== 'picture').map(view => this.button(view, viewLabel(view),
                        this.view === view, viewIcon(view), () => this.setView(this.view === view ? 'picture' : view)))}
                    {/* with the views rather than the tools, as it is something the picture shows */}
                    {this.actorsAvailable && this.button('markActor',
                        nls.localize('vueport/debug/inspector/markActor', 'Highlight the Selected Actor'),
                        this.markingSelection, <User size={18} />, () => {
                            this.markingSelection = !this.markingSelection;
                            this.applySelection();
                            this.render();
                        })}
                    <span className='vp-screen-inspector-divider' />
                    {this.button('pin', this.barPinned
                        ? nls.localize('vueport/controlStrip/unpin', 'Let the controls hide again')
                        : nls.localize('vueport/controlStrip/pin', 'Keep the controls on screen'),
                    this.barPinned, <PushPin size={18} weight={this.barPinned ? 'fill' : 'regular'} />,
                    () => this.setBarPinned(!this.barPinned))}
                </div>
                <div className='vp-screen-inspector-side'>
                    {this.renderWriteNote()}
                    {this.view !== 'picture' && this.renderLegend()}
                </div>
            </div>
        </>);
    }

    protected button(id: string, label: string, on: boolean, icon: React.ReactNode, onClick: () => void): React.ReactNode {
        return <button
            key={id}
            type='button'
            className={`vp-strip-button${on ? ' vp-strip-button-on' : ''}`}
            aria-label={label}
            aria-pressed={on}
            onMouseEnter={event => DOM_HOVER.show(event.currentTarget, label)}
            onMouseLeave={() => DOM_HOVER.hide()}
            onClick={() => {
                DOM_HOVER.hide();
                onClick();
            }}
        >
            {icon}
        </button>;
    }

    protected renderWriteNote(): React.ReactNode {
        const close = (onClick: () => void): React.ReactNode => <button
            type='button'
            className='vp-screen-inspector-close'
            aria-label={nls.localize('vueport/debug/inspector/close', 'Close')}
            onClick={onClick}
        >
            <X size={14} />
        </button>;
        if (this.armed) {
            return <div className='vp-screen-inspector-note'>
                <div className='vp-screen-inspector-card-title'>
                    <span>{nls.localize('vueport/debug/inspector/write/armed', 'Waiting for a write to {0}', this.armed.label)}</span>
                    {close(() => {
                        this.cancelWriteStop();
                        this.paint();
                    })}
                </div>
                <div className='vp-screen-inspector-card-note'>
                    {nls.localize('vueport/debug/inspector/write/armedHint',
                        'The game stops after the instruction that writes it. It has to be running.')}
                </div>
            </div>;
        }
        if (this.refused) {
            return <div className='vp-screen-inspector-note'>
                <div className='vp-screen-inspector-card-title'>
                    <span>{this.refused}</span>
                    {close(() => {
                        this.refused = undefined;
                        this.paint();
                    })}
                </div>
            </div>;
        }
        const caught = this.caught;
        if (caught) {
            const digits = caught.write.size * 2;
            return <div className='vp-screen-inspector-note'>
                <div className='vp-screen-inspector-card-title'>
                    <span>{nls.localize('vueport/debug/inspector/write/caught', '{0} was written', caught.label)}</span>
                    {close(() => {
                        this.caught = undefined;
                        this.paint();
                    })}
                </div>
                <dl>
                    <dt>{nls.localize('vueport/debug/inspector/code', 'Code')}</dt>
                    <dd>{this.codeName(caught.write.pc)}</dd>
                    <dt>{nls.localize('vueport/debug/inspector/address', 'Address')}</dt>
                    <dd>{`0x${hex(caught.write.address, 8)}`}</dd>
                    <dt>{nls.localize('vueport/debug/inspector/written', 'Written')}</dt>
                    <dd>{`0x${hex(caught.write.value, digits)}`}</dd>
                </dl>
                <div className='vp-screen-inspector-links'>
                    <button
                        type='button'
                        className='vp-screen-inspector-link'
                        onClick={() => this.host.reveal({ kind: 'code', address: caught.write.pc })}
                    >
                        {nls.localize('vueport/debug/inspector/showCode', 'Disassembly')}
                    </button>
                </div>
            </div>;
        }
        return undefined;
    }

    protected renderLegend(): React.ReactNode {
        const swatch = (key: string, color: [number, number, number], label: string): React.ReactNode =>
            <span key={key} className='vp-screen-inspector-swatch'>
                <span style={{ background: `rgb(${color.join(',')})` }} />
                {label}
            </span>;
        switch (this.view) {
            case 'kinds':
                return <div className='vp-screen-inspector-legend'>
                    {swatch('cell', KIND_COLORS.cell, nls.localize('vueport/debug/inspector/kind/cell', 'BGMap'))}
                    {swatch('overplane', KIND_COLORS.overplane, nls.localize('vueport/debug/inspector/kind/overplane', 'Overplane'))}
                    {swatch('object', KIND_COLORS.object, nls.localize('vueport/debug/inspector/kind/object', 'Object'))}
                    {swatch('backdrop', KIND_COLORS.backdrop, nls.localize('vueport/debug/inspector/kind/backdrop', 'Backdrop'))}
                    {swatch('cpu', KIND_COLORS.cpu, nls.localize('vueport/debug/inspector/kind/cpu', 'CPU'))}
                </div>;
            case 'palettes':
                return <div className='vp-screen-inspector-legend'>
                    {PALETTE_COLORS.map((color, index) =>
                        swatch(String(index), color, `${index < 4 ? 'GPLT' : 'JPLT'}${index % 4}`))}
                </div>;
            default: {
                // no fixed meaning: the worlds or palettes on the picture now, most used first
                const used = this.usedInView();
                if (used.length === 0) {
                    return undefined;
                }
                const shown = used.slice(0, LEGEND_ENTRIES).sort((a, b) => this.view === 'worlds' ? b - a : a - b);
                return <div className='vp-screen-inspector-legend'>
                    {shown.map(key => swatch(String(key), this.view === 'worlds' ? hueColor(31 - key) : hueColor(key),
                        this.view === 'worlds'
                            ? nls.localize('vueport/debug/inspector/target/world', 'World {0}', key)
                            : `0x${hex(key, 2)}`))}
                    {used.length > LEGEND_ENTRIES &&
                        <span>{nls.localize('vueport/debug/inspector/legendMore', '… {0} more', used.length - LEGEND_ENTRIES)}</span>}
                </div>;
            }
        }
    }

    protected usedCache?: { origins: Uint32Array, view: ScreenInspectorView, used: number[] };

    protected usedInView(): number[] {
        const origins = this.origins;
        if (!origins) {
            return [];
        }
        if (this.usedCache?.origins === origins && this.usedCache.view === this.view) {
            return this.usedCache.used;
        }
        const counts = new Map<number, number>();
        for (let i = 0; i < origins.length; i += 2) {
            const what = origins[i];
            const where = origins[i + 1];
            if (!viewColor(this.view, what, where)) {
                continue;
            }
            const key = this.view === 'worlds' ? what >>> 3 & 31 : where >>> 16 & 0xff;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const used = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([key]) => key);
        this.usedCache = { origins, view: this.view, used };
        return used;
    }

    protected cardStyle(clientX: number, clientY: number): React.CSSProperties {
        const panel = this.screen.node.getBoundingClientRect();
        const x = clientX - panel.left;
        const y = clientY - panel.top;
        return {
            ...(x > panel.width / 2 ? { right: panel.width - x + 16 } : { left: x + 16 }),
            ...(y > panel.height / 2 ? { bottom: panel.height - y + 16 } : { top: y + 16 }),
        };
    }

    protected renderActorCard(hit: { actor: VesActor, clientX: number, clientY: number }): React.ReactNode {
        const actor = hit.actor;
        const position = actor.position.map(value => value ?? '—').join(', ');
        return <div className='vp-screen-inspector-card' style={this.cardStyle(hit.clientX, hit.clientY)}>
            <div className='vp-screen-inspector-card-title'>
                <span>{actorLabel(actor)}</span>
            </div>
            <dl>
                <dt>{nls.localize('vueport/debug/inspector/actorClass', 'Class')}</dt>
                <dd>{actor.className}</dd>
                <dt>{nls.localize('vueport/debug/inspector/actorPosition', 'Position')}</dt>
                <dd>{position}</dd>
                <dt>{nls.localize('vueport/debug/inspector/address', 'Address')}</dt>
                <dd>{`0x${hex(actor.objectAddress, 8)}`}</dd>
            </dl>
            <div className='vp-screen-inspector-card-note'>
                {actorPixelSource(actor)
                    ? nls.localize('vueport/debug/inspector/actorHint', 'Click to select it in Actors')
                    : nls.localize('vueport/debug/inspector/actorNotDrawnHint',
                        'None of its sprites is drawn right now. Click to select it in Actors')}
            </div>
        </div>;
    }

    protected renderCard(at: Inspected, pinned: boolean): React.ReactNode {
        const origin = at.origin;
        const style = this.cardStyle(at.clientX, at.clientY);
        const rows: [string, string][] = [];
        const eye = at.eye === 0
            ? nls.localize('vueport/debug/inspector/leftEye', 'left eye')
            : nls.localize('vueport/debug/inspector/rightEye', 'right eye');
        rows.push([nls.localize('vueport/debug/inspector/screen', 'Screen'), `${at.x}, ${at.y} · ${eye}`]);
        if (origin.world !== undefined) {
            rows.push([nls.localize('vueport/debug/inspector/world', 'World'), String(origin.world)]);
        }
        if (origin.character !== undefined && origin.pixel) {
            const flips = `${origin.flip?.h ? 'H' : ''}${origin.flip?.v ? 'V' : ''}`;
            rows.push([nls.localize('vueport/debug/inspector/character', 'Character'),
                nls.localize('vueport/debug/inspector/characterPixel', '{0} · pixel {1}, {2} · value {3}',
                    origin.character, origin.pixel.x, origin.pixel.y, origin.value) + (flips ? ` · ${flips}` : '')]);
        }
        if (origin.palette) {
            rows.push([nls.localize('vueport/debug/inspector/palette', 'Palette'), origin.palette]);
        }
        if (origin.kind === 'backdrop') {
            rows.push([nls.localize('vueport/debug/inspector/shade', 'Shade'), String(origin.value)]);
        }
        if (origin.vbc !== undefined) {
            rows.push([nls.localize('vueport/debug/inspector/vbcPalette', 'VB Color'),
                `0x${hex(origin.vbc, 2)} · ${colorSourceLabel(origin)}`]);
        }
        const address = origin.object?.address ?? origin.bgmap?.address;
        if (address !== undefined) {
            rows.push([nls.localize('vueport/debug/inspector/address', 'Address'), `0x${hex(address, 8)}`]);
        }
        if (origin.pc !== undefined) {
            rows.push([nls.localize('vueport/debug/inspector/code', 'Code'), this.codeName(origin.pc)]);
            rows.push([nls.localize('vueport/debug/inspector/written', 'Written'), String(origin.value)]);
        }

        return <div
            className={`vp-screen-inspector-card${pinned ? ' pinned' : ''}`}
            style={style}
            onPointerLeave={() => this.setCardSource(undefined)}
        >
            <div className='vp-screen-inspector-card-title'>
                <span>{cardTitle(origin)}</span>
                {pinned &&
                    <button
                        type='button'
                        className='vp-screen-inspector-close'
                        aria-label={nls.localize('vueport/debug/inspector/close', 'Close')}
                        onClick={() => {
                            this.pinned = undefined;
                            this.cardSource = undefined;
                            this.paint();
                        }}
                    >
                        <X size={14} />
                    </button>}
            </div>
            {origin.kind === 'unknown'
                ? <div className='vp-screen-inspector-card-note'>
                    {nls.localize('vueport/debug/inspector/unknownHint',
                        'Nothing has drawn this pixel since Debug mode was turned on. Let the game run a frame.')}
                </div>
                : <dl>
                    {rows.map(([label, value]) => <React.Fragment key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </React.Fragment>)}
                </dl>}
            {pinned
                ? this.renderLinks(origin)
                : origin.kind !== 'unknown' && <div className='vp-screen-inspector-card-note'>
                    {nls.localize('vueport/debug/inspector/pinHint', 'Click to pin')}
                </div>}
        </div>;
    }

    protected renderLinks(origin: VbPixelOrigin): React.ReactNode {
        const links: { key: string, label: string, target: VbPixelSource | { kind: 'code', address: number } }[] = [];
        if (origin.object) {
            links.push({
                key: 'object', label: nls.localize('vueport/debug/inspector/showObject', 'Object'),
                target: { kind: 'object', object: origin.object.index },
            });
        }
        if (origin.bgmap) {
            links.push({
                key: 'cell', label: nls.localize('vueport/debug/inspector/showCell', 'Cell'),
                target: { kind: 'cell', address: origin.bgmap.address },
            });
        }
        if (origin.character !== undefined) {
            links.push({
                key: 'character', label: nls.localize('vueport/debug/inspector/showCharacter', 'Character'),
                target: { kind: 'character', character: origin.character },
            });
        }
        if (origin.world !== undefined) {
            links.push({
                key: 'world', label: nls.localize('vueport/debug/inspector/showWorld', 'World'),
                target: { kind: 'world', world: origin.world },
            });
        }
        if (origin.vbc !== undefined && origin.vbcSource !== 'rows') {
            links.push({
                key: 'vbc', label: nls.localize('vueport/debug/inspector/showVbcPalette', 'VB Color Palette'),
                target: { kind: 'vbcPalette', palette: origin.vbc },
            });
        }
        if (origin.pc !== undefined) {
            links.push({
                key: 'code', label: nls.localize('vueport/debug/inspector/showCode', 'Disassembly'),
                target: { kind: 'code', address: origin.pc },
            });
        }
        if (links.length === 0) {
            return undefined;
        }
        const watchable = links.filter(link => link.target.kind !== 'code' && writeRanges(link.target).length > 0);
        return <>
            <div className='vp-screen-inspector-links'>
                {links.map(link => <button
                    key={link.key}
                    type='button'
                    className='vp-screen-inspector-link'
                    onPointerEnter={() => this.setCardSource(link.target.kind === 'code' ? undefined : link.target)}
                    onClick={() => this.host.reveal(link.target)}
                >
                    {link.label}
                </button>)}
            </div>
            {watchable.length > 0 && <>
                <div className='vp-screen-inspector-card-note'>
                    {nls.localize('vueport/debug/inspector/write/offer', 'Stop at the next write to')}
                </div>
                <div className='vp-screen-inspector-links'>
                    {watchable.map(link => <button
                        key={link.key}
                        type='button'
                        className='vp-screen-inspector-link'
                        onPointerEnter={() => this.setCardSource(link.target as VbPixelSource)}
                        onClick={() => this.armWriteStop(link.target as VbPixelSource)}
                    >
                        {link.label}
                    </button>)}
                </div>
            </>}
        </>;
    }

    protected watchStops(): void {
        const sim = this.enabled ? this.host.sim() : undefined;
        if (sim === this.watchedSim) {
            return;
        }
        this.stopWatch?.dispose();
        this.stopWatch = undefined;
        this.watchedSim = sim;
        this.stopWatch = sim?.onStopped(stop => {
            if (stop.reason !== StopReason.WRITE || !stop.write || !this.armed) {
                return;
            }
            this.caught = { label: this.armed.label, write: stop.write };
            this.armed = undefined;
            this.host.reveal({ kind: 'code', address: stop.write.pc });
            this.paint();
        });
    }

    protected armWriteStop(source: VbPixelSource): void {
        const sim = this.host.sim();
        const ranges = writeRanges(source);
        if (!sim || ranges.length === 0) {
            return;
        }
        const label = sourceLabel(source);
        this.refused = undefined;
        this.caught = undefined;
        sim.setWriteStop(ranges).then(() => {
            this.armed = { label };
            this.setPicking(false);
        }, error => {
            this.refused = error instanceof Error ? error.message : String(error);
            this.paint();
        });
    }

    protected cancelWriteStop(): void {
        if (this.armed) {
            this.armed = undefined;
            this.host.sim()?.setWriteStop([]).catch(() => undefined);
        }
        this.refused = undefined;
    }

    protected setCardSource(source: VbPixelSource | undefined): void {
        if (this.cardSource !== source) {
            this.cardSource = source;
            this.paint();
        }
    }

    protected codeName(address: number): string {
        const symbols = this.symbols;
        const romBytes = this.host.romSize() * BYTES_PER_MBIT;
        const found = symbols && romBytes > 0 ? findFunctionAt(symbols, address, romBytes) : undefined;
        const name = found && symbols ? ` ${functionDisplayName(symbols, found.name)}` : '';
        return `0x${hex(address, 8)}${name}`;
    }
}

function viewLabel(view: ScreenInspectorView): string {
    switch (view) {
        case 'worlds': return nls.localize('vueport/debug/inspector/view/worlds', 'Color by World');
        case 'kinds': return nls.localize('vueport/debug/inspector/view/kinds', 'Color by Kind');
        case 'palettes': return nls.localize('vueport/debug/inspector/view/palettes', 'Color by Palette');
        case 'vbc': return nls.localize('vueport/debug/inspector/view/vbc', 'Color by VB Color Palette');
        default: return '';
    }
}

function viewIcon(view: ScreenInspectorView): React.ReactNode {
    switch (view) {
        case 'worlds': return <Stack size={18} />;
        case 'kinds': return <Shapes size={18} />;
        case 'palettes': return <Palette size={18} />;
        case 'vbc': return <VbColorIcon size={18} />;
        default: return undefined;
    }
}

function cardTitle(origin: VbPixelOrigin): string {
    switch (origin.kind) {
        case 'object':
            return nls.localize('vueport/debug/inspector/title/object', 'Object {0}', origin.object!.index);
        case 'cell':
            return nls.localize('vueport/debug/inspector/title/cell', 'BGMap {0} · Cell {1}, {2}',
                origin.bgmap!.segment, origin.bgmap!.x, origin.bgmap!.y);
        case 'overplane':
            return nls.localize('vueport/debug/inspector/title/overplane', 'Overplane · BGMap {0} · Cell {1}, {2}',
                origin.bgmap!.segment, origin.bgmap!.x, origin.bgmap!.y);
        case 'backdrop':
            return nls.localize('vueport/debug/inspector/title/backdrop', 'Backdrop');
        case 'cpu':
            return nls.localize('vueport/debug/inspector/title/cpu', 'Written by the CPU');
        case 'debugger':
            return nls.localize('vueport/debug/inspector/title/debugger', 'Written by the debugger');
        default:
            return nls.localize('vueport/debug/inspector/title/unknown', 'Not drawn yet');
    }
}
