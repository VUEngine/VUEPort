import { Cursor, Eyedropper } from '@phosphor-icons/react';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Disposable } from '../../common/emulator-events';
import { nls } from '../../common/emulator-nls';
import { VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH } from '../../common/vb-constants';
import { decodeOrigin, originDrawnBy, VbPixelOrigin } from '../../common/vb-pixel-origin';
import { pixelPalette, readColorState } from './emulator-color-compose';
import { DOM_HOVER } from '../components/kit/dom-hover';
import { Sim } from '../core/vb-core';
import { hex } from '../panels/emulator-panel';
import { ScreenPanel } from '../panels/emulator-screen-panel';
import { ColorEditor, ColorTool } from './emulator-color-editor';

interface Point {
    eye: 0 | 1;
    x: number;
    y: number;
}

const DIMMED = [0, 0, 0, 100];
// no new frame for this long means the machine is paused (or the game stands still)
const STILL_MS = 300;

export interface ColorScreenToolsHost {
    sim(): Sim | undefined;
}

/**
 * Color mode's tools over the picture: pick a pixel to open its figure's (or background's) sheet in the sheet editor,
 * and take a color for the brush. The same pixel origins the debugger's screen inspector reads tell which character
 * and which of its pixels is under the pointer. They come with every picture shown, so what is marked moves with the
 * game.
 */
export class ColorScreenTools {

    protected enabled = false;
    protected origins?: Uint32Array;
    protected hovered?: Point & { origin: VbPixelOrigin };
    protected streamSim?: Sim;
    protected streamWatch?: Disposable;
    protected paintPending = false;
    protected readonly root: Root;
    protected readonly editorWatch: Disposable;

    constructor(protected readonly screen: ScreenPanel, protected readonly host: ColorScreenToolsHost,
        protected readonly editor: ColorEditor) {
        this.root = createRoot(screen.colorTools);
        const picture = screen.pictureElement;
        picture.addEventListener('pointermove', this.onPointerMove);
        picture.addEventListener('pointerleave', this.onPointerLeave);
        picture.addEventListener('pointerdown', this.onPointerDown, true);
        picture.addEventListener('click', this.onClick, true);
        this.editorWatch = editor.onDidChange(() => {
            this.paint();
            this.recomposeIfStill();
        });
    }

    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) {
            return;
        }
        this.enabled = enabled;
        this.hovered = undefined;
        this.sync();
    }

    simChanged(): void {
        this.origins = undefined;
        this.hovered = undefined;
        this.sync();
    }

    dispose(): void {
        this.stream(undefined);
        this.editorWatch.dispose();
        const picture = this.screen.pictureElement;
        picture.removeEventListener('pointermove', this.onPointerMove);
        picture.removeEventListener('pointerleave', this.onPointerLeave);
        picture.removeEventListener('pointerdown', this.onPointerDown, true);
        picture.removeEventListener('click', this.onClick, true);
        this.root.unmount();
    }

    protected sync(): void {
        this.stream(this.enabled ? this.host.sim() : undefined);
        this.paint();
    }

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
        sim.readPixelOrigins().then(origins => this.takeOrigins(sim, origins), () => undefined);
    }

    protected takeOrigins(sim: Sim, origins: Uint32Array | undefined): void {
        if (sim !== this.streamSim) {
            return;
        }
        this.origins = origins;
        this.originsAt = performance.now();
        this.recomposed = undefined;
        if (this.hovered) {
            this.hovered = { ...this.hovered, origin: this.originAt(this.hovered) };
        }
        if (!this.paintPending) {
            this.paintPending = true;
            requestAnimationFrame(() => {
                this.paintPending = false;
                this.paint();
            });
        }
    }

    // --- paused machine ---

    protected originsAt = 0;
    protected recomposed?: { left: ImageData, right: ImageData };
    protected recomposing = false;
    protected recomposeAgain = false;

    protected recomposeIfStill(): void {
        if (!this.enabled || !this.origins || performance.now() - this.originsAt < STILL_MS) {
            return;
        }
        if (this.recomposing) {
            this.recomposeAgain = true;
            return;
        }
        this.recomposing = true;
        this.recompose().then(image => {
            this.recomposed = image;
            this.paint();
        }, () => undefined).finally(() => {
            this.recomposing = false;
            if (this.recomposeAgain) {
                this.recomposeAgain = false;
                this.recomposeIfStill();
            }
        });
    }

    // a paused machine draws nothing and the core only applies Color RAM when it shows a frame, so edits made while
    // paused would stay invisible. We then recompose the picture here the way the core's display processor does:
    // palette from the pixel origin, entry via GPLT/JPLT, Color RAM or the Backdrop Row Table, brightness references
    protected async recompose(): Promise<{ left: ImageData, right: ImageData } | undefined> {
        const sim = this.host.sim();
        const origins = this.origins;
        if (!sim || !origins) {
            return undefined;
        }
        const cram = new Uint8Array(await sim.readMemory(0x03079000, 0x1000));
        const rows = new Uint8Array(await sim.readMemory(0x030a1000, 0x1000));
        const halves = async (address: number, count: number): Promise<number[]> => {
            const bytes = new Uint8Array(await sim.readMemory(address, count * 2));
            return Array.from({ length: count }, (_, i) => bytes[i * 2] | bytes[i * 2 + 1] << 8);
        };
        const [brta, brtb, brtc] = await halves(0x0005f824, 3);
        const [refa, refb, refc] = await halves(0x0307f814, 3);
        const palettes = await halves(0x0005f860, 8);
        const rowsOn = ((await halves(0x0307f81a, 1))[0] & 4) !== 0; // bit 2: Backdrop Row Table on
        // the per-shade factor the core latches: current / reference brightness, 16.16, rounded up
        const current = [brta + brtb + brtc, brta, brtb, brta + brtb + brtc];
        const reference = [refa + refb + refc, refa, refb, refa + refb + refc];
        const factor = current.map((value, shade) => reference[shade] ? Math.ceil(value * 65536 / reference[shade]) : 0);
        const scale = (value: number, shade: number): number =>
            reference[shade] ? Math.min(255, Math.floor(value * factor[shade] / 65536)) : value;
        // current attributes and slots, since changes made while paused are not in the origins
        const state = await readColorState(sim);
        const pixels = VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT;
        const eyes = [0, 1].map(eye => {
            const image = new ImageData(VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT);
            const data = image.data;
            for (let i = 0; i < pixels; i++) {
                const what = origins[(eye * pixels + i) * 2];
                const where = origins[(eye * pixels + i) * 2 + 1];
                const kind = what & 7;
                if (kind === 0 || kind > 4 || !(where & 0x1000000)) {
                    continue;
                }
                const value = what >>> 28 & 3;
                let palette = where >>> 16 & 0xff;
                let shade = value;
                let source: Uint8Array = cram;
                let at: number;
                if (kind === 1) {
                    if (rowsOn) {
                        source = rows;
                        at = Math.floor(i / VB_SCREEN_WIDTH) * 16 + shade * 4;
                    } else {
                        at = (palette * 4 + shade) * 4;
                    }
                } else {
                    shade = palettes[(kind === 4 ? 4 : 0) + (what >>> 30)] >> (value * 2) & 3;
                    // with a world offset (WCEN) the attributes can't tell how much was added, so keep the
                    // drawn palette
                    if (!(where & 0x8000000)) {
                        const now = pixelPalette(state, what, where);
                        if (now === undefined) {
                            continue;
                        }
                        palette = now;
                    }
                    at = (palette * 4 + shade) * 4;
                }
                data[i * 4] = scale(source[at], shade);
                data[i * 4 + 1] = scale(source[at + 1], shade);
                data[i * 4 + 2] = scale(source[at + 2], shade);
                data[i * 4 + 3] = 255;
            }
            return image;
        });
        return { left: eyes[0], right: eyes[1] };
    }

    protected originAt(point: Point): VbPixelOrigin {
        const origins = this.origins;
        if (!origins) {
            return { kind: 'unknown', value: 0 };
        }
        const at = (point.eye * VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT + point.y * VB_SCREEN_WIDTH + point.x) * 2;
        return decodeOrigin(origins[at], origins[at + 1]);
    }

    protected pointFor(event: MouseEvent): Point | undefined {
        return this.screen.pointAt(event.clientX, event.clientY);
    }

    // --- pointer ---

    protected readonly onPointerMove = (event: PointerEvent): void => {
        if (!this.enabled || this.tool() === 'none') {
            return;
        }
        const point = this.pointFor(event);
        this.hovered = point && { ...point, origin: this.originAt(point) };
        this.paint();
    };

    protected readonly onPointerLeave = (): void => {
        if (this.hovered) {
            this.hovered = undefined;
            this.paint();
        }
    };

    // keeps tool clicks from reaching the game, except while a prompt is up and waits for that click
    protected readonly onClick = (event: MouseEvent): void => {
        if (this.enabled && this.tool() !== 'none' && !this.screen.promptShown) {
            event.stopPropagation();
        }
    };

    protected readonly onPointerDown = (event: PointerEvent): void => {
        if (!this.enabled || this.tool() === 'none' || event.button !== 0 || this.screen.promptShown) {
            return;
        }
        const point = this.pointFor(event);
        if (!point) {
            return;
        }
        event.stopPropagation();
        const origin = this.originAt(point);
        switch (this.tool()) {
            case 'select':
                this.editor.selectPixel(point.eye, point.x, point.y, origin).catch(() => undefined);
                break;
            case 'pipette':
                this.editor.pickAt(point.eye, point.x, point.y, origin).then(pick => {
                    const color = pick && pick.entry !== undefined ? pick.colors[pick.entry] : undefined;
                    if (color) {
                        this.editor.setBrushColor(color);
                        this.editor.setTool('none');
                        this.editor.revealSheet();
                    }
                }, () => undefined);
                break;
        }
    };

    // --- painting ---

    protected paint(): void {
        this.screen.pictureElement.classList.toggle('vp-screen-picking', this.enabled && this.tool() !== 'none');
        if (this.tool() === 'none') {
            this.hovered = undefined;
        }
        this.screen.setPixelLayer(this.enabled ? this.layer() : undefined);
        this.render();
    }

    // the picture recomposed if the machine stands still, with the picked palette's pixels lit
    protected layer(): { left: ImageData, right: ImageData } | undefined {
        const origins = this.origins;
        const editor = this.editor;
        const palette = this.tool() === 'select' ? editor.pick?.palette : undefined;
        const base = this.recomposed;
        if (!origins || (palette === undefined && !base)) {
            return undefined;
        }
        const pixels = VB_SCREEN_WIDTH * VB_SCREEN_HEIGHT;
        const eyes = [0, 1].map(eye => {
            const under = eye === 0 ? base?.left : base?.right;
            const image = under
                ? new ImageData(new Uint8ClampedArray(under.data), VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT)
                : new ImageData(VB_SCREEN_WIDTH, VB_SCREEN_HEIGHT);
            const data = image.data;
            for (let i = 0; i < pixels; i++) {
                let mark: number[] | undefined;
                if (palette !== undefined) {
                    const what = origins[(eye * pixels + i) * 2];
                    const where = origins[(eye * pixels + i) * 2 + 1];
                    mark = originDrawnBy(what, where, { kind: 'vbcPalette', palette }) ? undefined : DIMMED;
                }
                if (!mark) {
                    continue;
                }
                const at = i * 4;
                if (data[at + 3] === 0) {
                    data.set(mark, at);
                    continue;
                }
                const alpha = mark[3] / 255;
                for (let channel = 0; channel < 3; channel++) {
                    data[at + channel] = Math.round(data[at + channel] * (1 - alpha) + mark[channel] * alpha);
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
        const editor = this.editor;
        const hovered = this.hovered;
        const sheetOpen = !!editor.sheetEntry(editor.sheetId);
        this.root.render(<>
            {hovered && hovered.origin.kind !== 'unknown' && this.renderHover(hovered)}
            <div className='vp-screen-inspector vp-color-screen-tools'>
                <div className='vp-screen-inspector-bar' role='toolbar'>
                    {/* a second click puts the tool down, so the game gets its clicks again */}
                    {this.button('select', nls.localize('vueport/color/tool/select', 'Pick a Pixel'),
                        this.tool() === 'select', <Cursor size={18} />, () => editor.setTool(this.tool() === 'select' ? 'none' : 'select'))}
                    {this.button('pipette', sheetOpen
                        ? nls.localize('vueport/color/tool/pipetteColor', 'Take a Color for the Brush')
                        : nls.localize('vueport/color/tool/pipetteNoSheet', 'Take a Color for the Brush (open a sheet first)'),
                    this.tool() === 'pipette', <Eyedropper size={18} />, () => editor.setTool(this.tool() === 'pipette' ? 'none' : 'pipette'), !sheetOpen)}
                </div>
            </div>
        </>);
    }

    protected tool(): ColorTool {
        return this.editor.tool === 'pipette' && !this.editor.sheetEntry(this.editor.sheetId) ? 'select' : this.editor.tool;
    }

    protected button(id: ColorTool, label: string, on: boolean, icon: React.ReactNode, onClick: () => void, disabled = false): React.ReactNode {
        return <button
            key={id}
            type='button'
            className={`vp-strip-button${on ? ' vp-strip-button-on' : ''}`}
            aria-label={label}
            aria-pressed={on}
            disabled={disabled}
            data-screen-tool={id}
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

    protected renderHover(at: Point & { origin: VbPixelOrigin }): React.ReactNode {
        const origin = at.origin;
        const parts: string[] = [`${at.x}, ${at.y}`];
        if (origin.vbc !== undefined) {
            parts.push(nls.localize('vueport/color/fact/palette', 'Palette {0}', origin.vbc));
        }
        if (origin.character !== undefined) {
            parts.push(nls.localize('vueport/color/fact/character', 'Character {0}', `0x${hex(origin.character, 3)}`));
        }
        if (origin.vbcSource === 'slot') {
            parts.push(nls.localize('vueport/color/tool/painted', 'own pixel colors'));
        }
        return <div className='vp-color-hover'>{parts.join(' · ')}</div>;
    }
}
