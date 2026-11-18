import { Plug, Warning } from '@phosphor-icons/react';
import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import { ScreenInspectorTarget } from './emulator-screen-inspector';
import RadioSelect from '../components/kit/RadioSelect';
import EmptyContainer from '../components/kit/EmptyContainer';
import { Sim } from '../core/vb-core';
import { arrowKeysTaken, EmulatorPanelType, hex, DebugSource, Panel, scrollIntoViewSmoothly } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { exportVipImage, VipCanvas, VipExportFile } from './emulator-vip-canvas';
import { control, field, numberInput, stacked } from './emulator-vip-detail';
import {
    decodeVipObject,
    decodeVipWorld,
    encodeVipWorldHead,
    forEachVipObjectPixel,
    forEachVipWorldPixel,
    sameVipBytes,
    VIP_BGMAP_PALETTES,
    VIP_CHAR_SEGMENT_BYTES,
    VIP_CHAR_SIZE,
    VIP_FRAME_BUFFER_HEIGHT,
    VIP_FRAME_BUFFER_WIDTH,
    VIP_GENERIC_PALETTE_INTENSITIES,
    VIP_GRAPHICS_POLL_HZ,
    VIP_HBIAS_ENTRY_BYTES,
    VIP_OAM_BASE,
    VIP_OAM_BLOCK_BYTES,
    VIP_OBJECT_BYTES,
    VIP_OBJECT_COUNT,
    VIP_OBJECT_PALETTES,
    VIP_REGISTER_BASE,
    VIP_REGISTER_BLOCK_BYTES,
    VIP_WORLD_BASE,
    VIP_WORLD_BLOCK_BYTES,
    VIP_WORLD_BYTES,
    VIP_WORLD_COUNT,
    VIP_WORLD_MODE_NAMES,
    VipCharacters,
    vipCharSegmentAddress,
    vipCharSegmentCount,
    VipEye,
    vipHBiasRow,
    vipIntensitiesForRegister,
    VipIntensityWatcher,
    VipObject,
    vipObjectExtents,
    vipObjectGroupForWorld,
    vipObjectGroupRange,
    vipParamRows,
    vipParamTableAddress,
    VipWorld,
    vipWorldAddress,
    vipWorldExtents,
    VipWorldField,
    VipWorldMap,
    VipWorldMode,
    vipWorldSample,
    vipOverplaneSegment,
} from './emulator-vip-memory';
import { VIP_CONTEXT_FACTOR, VipWorldSources } from './emulator-vip-world-sources';
import { readVbcState, VbcState, VCU_WORLD_ATTR_BASE, VCU_WORLD_ATTR_BYTES } from './emulator-vcu-memory';
import { VcuColors, VcuPlacement, vcuPlacement, vipShade } from './emulator-vcu-colors';
import Select from '../components/kit/Select';
import Switch from '../components/kit/Switch';

const MAX_PREVIEW_ZOOM = 4;

const SIGNED_MIN = -0x8000;
const SIGNED_MAX = 0x7fff;
const UNSIGNED_MAX = 0xffff;

// the engine masks off the param register's low four bits (`WORLD_PARAM` in world.h), so the table it points at
// moves 32 bytes at a time
const PARAM_STEP = 0x10;

// gives every pixel value its own shade 0-3: Generic Palette in a color preview, where the shade picks the CRAM entry
const GENERIC_PALETTE_REGISTER = 0xe4;

const LUMA_RED = 0.299;
const LUMA_GREEN = 0.587;
const LUMA_BLUE = 0.114;

// Solo answers "what is in this world", Context "where is it in the picture and what is in front of it", which
// shows a world that cannot be found on screen being covered rather than nothing at all
type WorldPreviewMode = 'solo' | 'context';

// the VIP's 32 world attribute entries in drawing order, the selected one's fields and a preview; on a VB Color with
// color on, also the world's VCU palette offset
export class WorldsPanel extends Panel {

    protected error?: string;
    protected registers?: DataView;
    protected worldBytes?: Uint8Array;
    protected charSegments: (Uint8Array | undefined)[] = [];
    protected readonly sources = new VipWorldSources();
    protected oamBytes?: Uint8Array;
    // undefined while a VB Color game has not switched color on; every color field is gated on this, so on a plain VB
    // the panel is unchanged. See readVbcState
    protected vbc?: VbcState;
    // World Color Attribute RAM, a halfword per world, read only while `vbc` is there. The red preview does not use it,
    // so a change does not mark the picture dirty
    protected worldAttrBytes?: Uint8Array;
    // draw in the VB Color's colors rather than the VIP's red, only while `vbc` is there (see colorPreview). On by
    // default, as a VB Color game in red is a picture the player never sees
    protected vbColorPreview = this.remembered('vbColorPreview', true);
    protected colors?: VcuColors;

    // drawing starts at world 31, so that is where the panel opens
    protected selected = VIP_WORLD_COUNT - 1;
    protected hbiasRow = 0;
    protected eye = this.remembered('eye', 'left') as VipEye;
    protected previewMode = this.remembered('previewMode', 'context') as WorldPreviewMode;
    protected zoom = this.remembered('zoom', 1);
    // an even ramp instead of the game's palette registers, for reading the tile data with palettes and fades taken out
    protected showGenericPalette = this.remembered('showGenericPalette', false);
    // the list stops before the world that ends the frame, and Context also leaves out whatever is off for the shown
    // eye
    protected showOnlyDrawn = this.remembered('showOnlyDrawn', true);
    protected showExtents = this.remembered('showExtents', true);

    protected image?: ImageData;
    protected dirty = true;
    protected readonly intensityWatcher = new VipIntensityWatcher();

    constructor(
        source: DebugSource,
        instanceId: string,
        // where Export PNG hands its file; no button without it
        protected readonly exportFile?: VipExportFile
    ) {
        super(EmulatorPanelType.VIP_WORLDS, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/worlds/title', 'Worlds');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.VIP_WORLDS);
        // the three columns scroll on their own, so the panel's own scrolling is off and the layout hangs on this
        // class, shared with the BGMaps panel (see the stylesheet)
        this.addClass('vp-vip-panel');
    }

    protected pollHz(): number {
        return VIP_GRAPHICS_POLL_HZ;
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.registers = undefined;
            this.worldBytes = undefined;
            this.charSegments = [];
            this.sources.clear();
            this.oamBytes = undefined;
            this.vbc = undefined;
            this.worldAttrBytes = undefined;
            this.colors = undefined;
            this.image = undefined;
            this.update();
            return;
        }

        try {
            const [registers, vbc] = await Promise.all([
                sim.readMemory(VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES),
                readVbcState(this.source, sim),
            ]);
            this.registers = new DataView(registers);
            this.vbc = vbc;
            this.worldAttrBytes = vbc
                ? new Uint8Array(await sim.readMemory(VCU_WORLD_ATTR_BASE, VCU_WORLD_ATTR_BYTES))
                : undefined;

            const worldBytes = new Uint8Array(await sim.readMemory(VIP_WORLD_BASE, VIP_WORLD_BLOCK_BYTES));
            if (!sameVipBytes(worldBytes, this.worldBytes)) {
                this.worldBytes = worldBytes;
                this.dirty = true;
            }

            // which memory the preview needs follows from the worlds just read, hence a second round of reads
            await this.readSources(sim);
            await this.readColors(sim);

            if (this.intensityWatcher.changed(this.registers)) {
                this.dirty = true;
            }
            this.error = undefined;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }

        if (this.dirty && this.registers) {
            this.image = this.rasterize(this.registers);
            this.dirty = false;
        }
        this.update();
    }

    // in VIP drawing order, 31 first
    protected allWorlds(): VipWorld[] {
        const bytes = this.worldBytes;
        if (!bytes) {
            return [];
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: VIP_WORLD_COUNT }, (unused, position) => {
            const index = VIP_WORLD_COUNT - 1 - position;
            return decodeVipWorld(view, index, index * VIP_WORLD_BYTES);
        });
    }

    // all of them, or the ones before the world that ends the frame: End stops drawing at that world, not after it, so
    // it and everything below are not on screen
    protected listedWorlds(): VipWorld[] {
        const worlds = this.allWorlds();
        const end = worlds.findIndex(world => world.end);
        return this.showOnlyDrawn && end >= 0 ? worlds.slice(0, end) : worlds;
    }

    // in VIP drawing order. Solo is the selected world whether or not the hardware draws it (a world switched off is
    // exactly the one worth looking at); Context is what the list holds
    protected drawnWorlds(): VipWorld[] {
        if (this.previewMode === 'solo') {
            const world = this.world();
            return world ? [world] : [];
        }
        return this.listedWorlds();
    }

    // the drawn worlds plus the selected one: a world past End is not drawn in Context, but its fields are shown, and
    // the H-bias table beside them would otherwise read as zeros
    protected sourceWorlds(): VipWorld[] {
        const worlds = this.drawnWorlds();
        const selected = worlds.some(world => world.index === this.selected) ? undefined : this.world();
        return selected ? [...worlds, selected] : worlds;
    }

    protected async readSources(sim: Sim): Promise<void> {
        const sources = this.sourceWorlds();
        if (sources.length === 0) {
            this.charSegments = [];
            this.sources.clear();
            this.oamBytes = undefined;
            return;
        }

        /**
         * Characters are read whatever the worlds' modes, as OBJECT worlds' objects are made of them too. Maps and
         * param tables are read only for the other worlds; an OBJECT world draws from OAM under the SPT registers (read
         * below). With CHREXT the VCU's four extension segments are read as well: the segment count tells
         * VipCharacters, and through it the world maps, which mask to decode cells with, so the extension is dropped
         * again when CHREXT goes off.
         */
        const count = vipCharSegmentCount(!!this.vbc?.chrext);
        if (this.charSegments.length > count) {
            this.charSegments = this.charSegments.slice(0, count);
            this.dirty = true;
        }
        const segments = await Promise.all(Array.from({ length: count },
            (unused, index) => sim.readMemory(vipCharSegmentAddress(index), VIP_CHAR_SEGMENT_BYTES)
        ));
        segments.forEach((buffer, index) => {
            const bytes = new Uint8Array(buffer);
            if (!sameVipBytes(bytes, this.charSegments[index])) {
                this.charSegments[index] = bytes;
                this.dirty = true;
            }
        });

        if (await this.sources.read(sim, sources)) {
            this.dirty = true;
        }

        // all of OAM in one read: a group is a range of it, and which objects it holds changes with the SPT registers
        // from frame to frame
        if (sources.some(world => world.mode === VipWorldMode.OBJECT)) {
            const oam = new Uint8Array(await sim.readMemory(VIP_OAM_BASE, VIP_OAM_BLOCK_BYTES));
            if (!sameVipBytes(oam, this.oamBytes)) {
                this.oamBytes = oam;
                this.dirty = true;
            }
        } else if (this.oamBytes) {
            this.oamBytes = undefined;
            this.dirty = true;
        }
    }

    protected colorPreview(): boolean {
        return !!this.vbc && this.vbColorPreview;
    }

    // after readSources, as the needed Color Attributes are those of the segments the worlds map from, plus the
    // segments their overplane cells are in. Object tables only when an OBJECT world is among them
    protected async readColors(sim: Sim): Promise<void> {
        const vbc = this.vbc;
        if (!vbc || !this.colorPreview()) {
            if (this.colors) {
                this.colors = undefined;
                this.dirty = true;
            }
            return;
        }
        const worlds = this.drawnWorlds();
        const segments = new Set<number>();
        this.sources.bgMapSegments.forEach((bytes, segment) => bytes && segments.add(segment));
        for (const world of worlds) {
            if (world.mode !== VipWorldMode.OBJECT && world.overplane) {
                segments.add(vipOverplaneSegment(world));
            }
        }
        const colors = await VcuColors.read(sim, vbc, {
            segments,
            objects: worlds.some(world => world.mode === VipWorldMode.OBJECT),
            worlds: true,
        });
        if (!colors.same(this.colors)) {
            this.dirty = true;
        }
        this.colors = colors;
    }

    protected world(): VipWorld | undefined {
        const bytes = this.worldBytes;
        if (!bytes) {
            return undefined;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return decodeVipWorld(view, this.selected, this.selected * VIP_WORLD_BYTES);
    }

    protected params(): DataView | undefined {
        return this.paramsFor(this.selected);
    }

    protected paramsFor(index: number): DataView | undefined {
        return this.sources.params(index);
    }

    protected selectWorld(index: number): void {
        if (Number.isNaN(index)) {
            return;
        }
        this.selected = Math.min(VIP_WORLD_COUNT - 1, Math.max(0, index));
        this.dirty = true;
        this.refresh();
    }

    protected setShowOnlyDrawn(value: boolean): void {
        this.showOnlyDrawn = this.remember('showOnlyDrawn', value);
        // a world no longer listed would leave the fields describing something that cannot be pointed at, so the
        // selection comes back to the last listed world
        const listed = this.listedWorlds();
        if (listed.length > 0 && !listed.some(world => world.index === this.selected)) {
            this.selected = listed[listed.length - 1].index;
        }
        this.dirty = true;
        // more worlds to draw is more VRAM to read, so this re-reads the sources, not only redraws
        this.refresh();
    }

    protected setShowGenericPalette(value: boolean): void {
        this.showGenericPalette = this.remember('showGenericPalette', value);
        this.dirty = true;
        this.refresh();
    }

    // Context draws from more of VRAM (every drawn world's map segments and param table), so the sources are read again
    protected setPreviewMode(mode: WorldPreviewMode): void {
        this.previewMode = this.remember('previewMode', mode) as WorldPreviewMode;
        this.dirty = true;
        this.refresh();
    }

    protected setVbColorPreview(value: boolean): void {
        this.vbColorPreview = this.remember('vbColorPreview', value);
        this.dirty = true;
        // color takes tables plain red does not, so this is a read too
        this.refresh();
    }

    protected setEye(eye: VipEye): void {
        this.eye = this.remember('eye', eye) as VipEye;
        this.dirty = true;
        this.refresh();
    }

    protected palettes(registers: DataView): number[][] {
        return this.showGenericPalette
            ? [0, 1, 2, 3].map(() => VIP_GENERIC_PALETTE_INTENSITIES)
            : VIP_BGMAP_PALETTES.map(register => vipIntensitiesForRegister(registers, register));
    }

    protected async writeHalfword(address: number, value: number): Promise<void> {
        const sim = this.source.sim;
        if (!sim || Number.isNaN(value)) {
            return;
        }
        await this.source.write(address, [value & 0xff, (value >> 8) & 0xff]);
        this.dirty = true;
        await this.refresh();
    }

    protected writeField(worldField: VipWorldField, value: number): void {
        this.writeHalfword(vipWorldAddress(this.selected) + worldField * 2, value);
    }

    // the head halfword is rewritten whole: mode, map size and base, and the four flags
    protected writeHead(patch: Partial<VipWorld>): void {
        const world = this.world();
        if (world) {
            this.writeField(VipWorldField.HEAD, encodeVipWorldHead({ ...world, ...patch }));
        }
    }

    // only the low byte of the halfword is the offset; the high one is written back as read, so a game's value there
    // survives
    protected writePaletteOffset(value: number): void {
        const bytes = this.worldAttrBytes;
        if (!bytes) {
            return;
        }
        const high = bytes[this.selected * 2 + 1] ?? 0;
        this.writeHalfword(VCU_WORLD_ATTR_BASE + this.selected * 2, (high << 8) | (value & 0xff));
    }

    protected writeHBias(world: VipWorld, row: number, eye: VipEye, value: number): void {
        const address = vipParamTableAddress(world.param) + row * VIP_HBIAS_ENTRY_BYTES + (eye === 'left' ? 0 : 2);
        this.writeHalfword(address, value);
    }

    /**
     * A screen-sized bitmap of the preview. Solo: the selected world alone. Context: every world the VIP would draw, 31
     * downwards, stopping at End, all but the selected one faded and gray; uncovered area stays opaque black (the Frame
     * Buffers panel shows the hardware's own composite). A pixel whose palette entry is black is left alone, the
     * hardware's transparency for index 0. OBJECT worlds draw nothing here (their objects are in the Objects panel).
     *
     * In color each pixel is its CRAM color (see VcuColors), the pixels the hardware leaves out are left alone, and a
     * faded world is grayed by its luma. `alone` draws only that world, for the exported file: cut to its W+1 by H+1
     * rectangle as the BGMaps panel's Used by draws it, transparent where it draws nothing. An OBJECT world has no
     * rectangle and keeps the screen.
     */
    protected rasterize(registers: DataView, alone?: VipWorld): ImageData {
        const objects = alone?.mode === VipWorldMode.OBJECT;
        const width = alone && !objects ? Math.max(1, Math.min(alone.w + 1, VIP_FRAME_BUFFER_WIDTH)) : VIP_FRAME_BUFFER_WIDTH;
        const height = alone && !objects ? Math.max(1, Math.min(alone.h + 1, VIP_FRAME_BUFFER_HEIGHT)) : VIP_FRAME_BUFFER_HEIGHT;
        const pixels = new Uint8ClampedArray(width * height * 4);
        if (!alone) {
            for (let offset = 3; offset < pixels.length; offset += 4) {
                pixels[offset] = 255;
            }
        }

        const palettes = this.palettes(registers);
        const characters = new VipCharacters(this.charSegments);
        const context = !alone && this.previewMode === 'context';
        const colors = this.colorPreview() ? this.colors : undefined;
        const gplts = VIP_BGMAP_PALETTES.map(register => this.paletteRegister(registers, register));
        const sample = vipWorldSample();
        const placement = vcuPlacement();
        const worlds = !alone ? this.drawnWorlds() : objects ? [alone] : [{ ...alone, gx: 0, gy: 0, gp: 0 }];
        for (const world of worlds) {
            // Solo draws the selected world whatever its eye flags say; Context draws a world only if the hardware
            // would, unless undrawn ones are wanted. An OBJECT world is drawn if either eye asks for it, its objects
            // then pick their own eye (see vipObjectGroupForWorld)
            const drawn = world.mode === VipWorldMode.OBJECT
                ? world.lon || world.ron
                : this.eye === 'left' ? world.lon : world.ron;
            if (context && !drawn && this.showOnlyDrawn) {
                continue;
            }
            const faded = context && world.index !== this.selected;
            const paint = (destX: number, destY: number, intensity: number): void => {
                if (intensity === 0) {
                    return;
                }
                const offset = (destY * width + destX) * 4;
                // red, as the hardware emits; the other two channels are written too, as a faded world may have left
                // gray in them
                const gray = faded ? Math.round(intensity * VIP_CONTEXT_FACTOR) : 0;
                pixels[offset] = faded ? gray : intensity;
                pixels[offset + 1] = gray;
                pixels[offset + 2] = gray;
                pixels[offset + 3] = 255;
            };

            if (colors) {
                // a color pixel is written whole by VcuColors, and faded afterwards in place
                const worldOffset = colors.worldOffset(world.index);
                const put = (
                    destX: number, destY: number, colored: VcuPlacement,
                    value: number, charX: number, charY: number, shade: number
                ): void => {
                    const offset = (destY * width + destX) * 4;
                    if (colors.put(pixels, offset, colored, value, charX, charY, shade, worldOffset) && faded) {
                        const gray = Math.round(VIP_CONTEXT_FACTOR * (LUMA_RED * pixels[offset]
                            + LUMA_GREEN * pixels[offset + 1] + LUMA_BLUE * pixels[offset + 2]));
                        pixels[offset] = gray;
                        pixels[offset + 1] = gray;
                        pixels[offset + 2] = gray;
                    }
                };
                if (world.mode === VipWorldMode.OBJECT) {
                    this.drawObjectsInColor(registers, world, characters, colors, width, height, put);
                    continue;
                }
                const coloredMap = new VipWorldMap(world, this.sources.bgMapSegments, characters);
                forEachVipWorldPixel(
                    world, width, height, this.eye, this.paramsFor(world.index),
                    (destX, destY, x, y) => {
                        coloredMap.sample(x, y, sample);
                        colors.cell(sample.segment, sample.cell, sample.char, sample.palette, placement);
                        put(destX, destY, placement, sample.value, sample.charX, sample.charY,
                            vipShade(gplts[sample.palette], sample.value));
                    }
                );
                continue;
            }

            if (world.mode === VipWorldMode.OBJECT) {
                this.drawObjects(registers, world, characters, width, height, paint);
                continue;
            }

            const map = new VipWorldMap(world, this.sources.bgMapSegments, characters);
            forEachVipWorldPixel(
                world, width, height, this.eye, this.paramsFor(world.index),
                (destX, destY, x, y) => paint(destX, destY, map.intensity(x, y, palettes))
            );
        }
        return new ImageData(pixels, width, height);
    }

    // which group it draws follows from the drawing order (see objectGroupFor), and within a group objects are drawn
    // from the last index down, so a lower index lands on top. An object's own eye bits decide its eye, the world's
    // only whether the world is drawn. Both measured against the core in tests/object-group-probe.mjs
    protected drawObjects(
        registers: DataView,
        world: VipWorld,
        characters: VipCharacters,
        width: number,
        height: number,
        paint: (destX: number, destY: number, intensity: number) => void
    ): void {
        const shades = [0, 1, 2, 3].map(palette => this.objectPalette(registers, palette));
        for (const object of this.drawnObjects(registers, world, characters)) {
            const intensities = shades[object.palette];
            forEachVipObjectPixel(object, width, height, characters, this.eye,
                (destX, destY, value) => paint(destX, destY, intensities[value]));
        }
    }

    // each object colored by its own OBJ Color Attribute through `put`, which adds the world's palette offset. Its own
    // pixel loop, as a Pixel Color Slot is laid out in the character's coordinates, which forEachVipObjectPixel lacks
    protected drawObjectsInColor(
        registers: DataView,
        world: VipWorld,
        characters: VipCharacters,
        colors: VcuColors,
        width: number,
        height: number,
        put: (destX: number, destY: number, placement: VcuPlacement,
            value: number, charX: number, charY: number, shade: number) => void
    ): void {
        const jplts = VIP_OBJECT_PALETTES.map(register => this.paletteRegister(registers, register));
        const placement = vcuPlacement();
        for (const object of this.drawnObjects(registers, world, characters)) {
            colors.object(object.index, object.char, object.palette, placement);
            const destX = vipObjectExtents(object, this.eye).x;
            for (let row = 0; row < VIP_CHAR_SIZE; row++) {
                const y = object.jy + row;
                if (y < 0 || y >= height) {
                    continue;
                }
                const charY = object.vFlip ? VIP_CHAR_SIZE - 1 - row : row;
                for (let column = 0; column < VIP_CHAR_SIZE; column++) {
                    const x = destX + column;
                    if (x < 0 || x >= width) {
                        continue;
                    }
                    const charX = object.hFlip ? VIP_CHAR_SIZE - 1 - column : column;
                    const value = characters.pixel(object.char, charX, charY);
                    put(x, y, placement, value, charX, charY, vipShade(jplts[object.palette], value));
                }
            }
        }
    }

    // in drawing order: its group's, from the last index down
    protected drawnObjects(registers: DataView, world: VipWorld, characters: VipCharacters): VipObject[] {
        const bytes = this.oamBytes;
        const group = this.objectGroupFor(world.index);
        if (!bytes || group === undefined) {
            return [];
        }
        const range = vipObjectGroupRange(registers, group);
        if (!range) {
            return [];
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const objects: VipObject[] = [];
        for (let index = Math.min(range.last, VIP_OBJECT_COUNT - 1); index >= range.first; index--) {
            const object = decodeVipObject(view, index, index * VIP_OBJECT_BYTES, characters.charMask);
            if (this.eye === 'left' ? object.lon : object.ron) {
                objects.push(object);
            }
        }
        return objects;
    }

    protected paletteRegister(registers: DataView, register: number): number {
        return this.showGenericPalette ? GENERIC_PALETTE_REGISTER : registers.getUint16(register, true) & 0xff;
    }

    protected objectGroupFor(index: number): number | undefined {
        return vipObjectGroupForWorld(this.allWorlds(), index);
    }

    protected objectPalette(registers: DataView, palette: number): number[] {
        return this.showGenericPalette
            ? VIP_GENERIC_PALETTE_INTENSITIES
            : vipIntensitiesForRegister(registers, VIP_OBJECT_PALETTES[palette]);
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return <EmptyContainer
                title={this.error ?? nls.localize('vueport/general/error', 'Error')}
                icon={<Warning size={32} />}
            />;
        }
        const bytes = this.worldBytes;
        if (!bytes) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/general/notRunning',
                    'The emulator is not running.',
                )}
                icon={<Plug size={32} />}
            />;
        }

        const selected = this.world();
        if (!selected) {
            return undefined;
        }

        // focusable, with the arrow keys read here rather than on the list, so they walk the worlds wherever focus is;
        // clicking anywhere that does not take focus itself lands here too
        return <div
            className='vp-columns'
            tabIndex={0}
            aria-label={nls.localize('vueport/debug/panels/worlds/title', 'Worlds')}
            onKeyDown={event => this.onPanelKey(event)}
        >
            {this.renderList(this.listedWorlds())}
            <div className='vp-sidebar vp-scroll'>
                {this.renderWorldGroup(selected)}
                {this.renderPropertiesGroup(selected)}
                {selected.mode === VipWorldMode.HBIAS && this.renderHBiasGroup(selected)}
                {this.vbc && this.worldAttrBytes && this.renderColorGroup(selected, this.vbc, this.worldAttrBytes)}
            </div>
            {this.renderPreview(selected)}
        </div>;
    }

    // tiles in drawing order: index, mode, eyes and End stacked and read as one, as only one of the four is a number.
    // A column of its own, so list, fields and preview are on screen at once
    protected renderList(worlds: VipWorld[]): React.ReactNode {
        return <div className='vp-tiles vp-scroll'>
            {worlds.map(world => {
                const drawn = world.lon || world.ron;
                return <button
                    type='button'
                    key={world.index}
                    className={`vp-tile${drawn ? '' : ' inactive'}`
                        + `${world.index === this.selected ? ' selected' : ''}`}
                    aria-pressed={world.index === this.selected}
                    tabIndex={-1}
                    title={hex(vipWorldAddress(world.index), 8)}
                    onClick={() => this.selectWorld(world.index)}
                    onMouseEnter={() => this.light({ kind: 'world', world: world.index })}
                    onMouseLeave={() => this.light(undefined)}
                >
                    <span className='vp-tile-index'>{world.index}</span>
                    <span className='vp-tile-mark'>
                        {`${world.lon ? 'L' : '\u2013'}${world.ron ? 'R' : '\u2013'}`}
                    </span>
                    <span className='vp-tile-note'>{VIP_WORLD_MODE_NAMES[world.mode]}</span>
                    {world.end &&
                        <span
                            className='vp-tile-flag'
                            title={nls.localize('vueport/debug/panels/worlds/endHint', 'Drawing stops at this world')}
                        >
                            {nls.localize('vueport/debug/panels/worlds/end', 'End')}
                        </span>
                    }
                </button>;
            })}
        </div>;
    }

    // by position in the list, not world index, so the keys stop at its ends. Stopped, not only defaulted, as the
    // emulator listens for keys on the node around the panel and would read an arrow as the D-pad (as in the
    // Characters panel)
    protected onPanelKey(event: React.KeyboardEvent): void {
        if (arrowKeysTaken(event.target, event.currentTarget)) {
            return;
        }
        const steps: Record<string, number> = {
            ArrowUp: -1,
            ArrowLeft: -1,
            ArrowDown: 1,
            ArrowRight: 1,
            PageUp: -8,
            PageDown: 8,
        };
        const step = steps[event.key];
        const home = event.key === 'Home';
        const end = event.key === 'End';
        if (step === undefined && !home && !end) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const listed = this.listedWorlds();
        if (listed.length === 0) {
            return;
        }
        const at = listed.findIndex(world => world.index === this.selected);
        const to = home ? 0 : end ? listed.length - 1 : Math.max(0, at) + step;
        this.selectWorld(listed[Math.min(listed.length - 1, Math.max(0, to))].index);
        this.revealSelected();
    }

    reveal(target: ScreenInspectorTarget): void {
        if (target.kind !== 'world') {
            return;
        }
        this.selectWorld(target.world);
        this.revealSelected('smooth');
    }

    // focus the tile too, so the ring and the selection are the same tile and the next arrow key carries on from there
    // smooth for a jump from the screen inspector, which can land far down the list; instant as the keys walk it
    protected revealSelected(behavior: ScrollBehavior = 'auto'): void {
        this.whenRendered(() => {
            const tile = this.node.querySelector<HTMLElement>('.vp-tile.selected');
            if (!tile) {
                return;
            }
            if (behavior === 'smooth') {
                scrollIntoViewSmoothly(tile);
            } else {
                tile.scrollIntoView({ block: 'nearest' });
            }
            tile.focus({ preventScroll: true });
        });
    }

    protected renderWorldGroup(world: VipWorld): React.ReactNode {
        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/worlds/world', 'World')}</legend>
            <div className='vp-detail-fields'>
                {field(nls.localize('vueport/debug/panels/worlds/index', 'Index'), world.index)}
                {field(
                    nls.localize('vueport/debug/panels/worlds/address', 'Address'),
                    hex(vipWorldAddress(world.index), 8)
                )}
                {field(
                    'Head',
                    hex(world.head, 4),
                    nls.localize('vueport/debug/panels/worlds/headHint', 'Header register')
                )}
            </div>
        </fieldset>;
    }

    // names above their controls, as beside them they would not fit the column
    protected renderPropertiesGroup(world: VipWorld): React.ReactNode {
        const sizeHint = nls.localize('vueport/debug/panels/worlds/sizeHint', 'Register value, which is size minus one');
        const scHint = nls.localize('vueport/debug/panels/worlds/scHint', 'Segments across and down');
        const signed = (value: number, write: (next: number) => void) =>
            numberInput(value, SIGNED_MIN, SIGNED_MAX, write);
        return <fieldset className='vp-inspector-group vp-grows'>
            <legend>{nls.localize('vueport/debug/panels/worlds/properties', 'Properties')}</legend>
            <div className='vp-scroll-body vp-scroll'>
                <div className='vp-grid'>
                    <div className='vp-grid-row'>
                        {stacked('Mode', <Select
                            value={String(world.mode)}
                            onChange={next => this.writeHead({ mode: parseInt(next, 10) as VipWorldMode })}
                            options={Object.entries(VIP_WORLD_MODE_NAMES).map(([mode, name]) => ({
                                value: mode,
                                label: name,
                            }))}
                        />, undefined, 2)}
                        {stacked(
                            nls.localize('vueport/debug/panels/worlds/map', 'Map'),
                            numberInput(world.bgMap, 0, 0x0f, value => this.writeHead({ bgMap: value })),
                            nls.localize('vueport/debug/panels/worlds/bgMapHint', 'Base BGMap segment')
                        )}
                    </div>
                    <div className='vp-grid-row'>
                        {stacked('Sc X', this.segmentCountInput(world.scx, v => this.writeHead({ scx: v })), scHint)}
                        {stacked('Sc Y', this.segmentCountInput(world.scy, v => this.writeHead({ scy: v })), scHint)}
                    </div>
                    <div className='vp-grid-row'>
                        {stacked('GX', signed(world.gx, v => this.writeField(VipWorldField.GX, v)))}
                        {stacked('GY', signed(world.gy, v => this.writeField(VipWorldField.GY, v)))}
                        {stacked('GP', signed(world.gp, v => this.writeField(VipWorldField.GP, v)))}
                    </div>
                    <div className='vp-grid-row'>
                        {stacked('MX', signed(world.mx, v => this.writeField(VipWorldField.MX, v)))}
                        {stacked('MY', signed(world.my, v => this.writeField(VipWorldField.MY, v)))}
                        {stacked('MP', signed(world.mp, v => this.writeField(VipWorldField.MP, v)))}
                    </div>
                    <div className='vp-grid-row'>
                        {stacked('W', numberInput(world.w, 0, UNSIGNED_MAX,
                            v => this.writeField(VipWorldField.W, v)), sizeHint)}
                        {stacked('H', numberInput(world.h, 0, UNSIGNED_MAX,
                            v => this.writeField(VipWorldField.H, v)), sizeHint)}
                    </div>
                    <div className='vp-grid-row'>
                        {stacked(
                            nls.localize('vueport/debug/panels/worlds/param', 'Param'),
                            numberInput(
                                world.param, 0, UNSIGNED_MAX,
                                v => this.writeField(VipWorldField.PARAM, v), PARAM_STEP
                            ),
                            nls.localize(
                                'vueport/debug/panels/worlds/paramHint',
                                'Register value, which is a halfword offset into BGMap memory'
                            )
                        )}
                        {stacked(
                            nls.localize('vueport/debug/panels/worlds/paramAddress', 'Param address'),
                            <input className='vp-input' readOnly value={hex(vipParamTableAddress(world.param), 8)} />,
                            nls.localize(
                                'vueport/debug/panels/worlds/paramAddressHint',
                                'Where the H-bias or Affine table the param register points at starts'
                            ),
                            2
                        )}
                    </div>
                    <div className='vp-grid-row'>
                        {stacked(
                            nls.localize('vueport/debug/panels/worlds/overplane', 'Overplane'),
                            numberInput(
                                world.overplaneIndex, 0, UNSIGNED_MAX,
                                v => this.writeField(VipWorldField.OVERPLANE_INDEX, v)
                            ),
                            nls.localize('vueport/debug/panels/worlds/overplaneHint', 'The index of the BGMap cell drawn outside the map: segment in bits 15-12, cell in 11-0'),
                            2
                        )}
                        <div
                            className='vp-grid-switch'
                            title={nls.localize(
                                'vueport/debug/panels/worlds/overplaneFlagHint',
                                'Draw the overplane outside the map instead of repeating it'
                            )}
                        >
                            <Switch
                                label={nls.localize('vueport/debug/panels/worlds/overplane', 'Overplane')}
                                value={world.overplane}
                                onChange={value => this.writeHead({ overplane: value })}
                            />
                        </div>
                    </div>
                </div>
                <div className='vp-detail-flags'>
                    {/* named like the fields above, so the group reads as one list; the two eyes share a line */}
                    <div className='vp-inspector-field'>
                        <label>{nls.localize('vueport/debug/panels/worlds/eyes', 'Eyes')}</label>
                        <div className='vp-flags-row'>
                            {this.renderToggle(
                                nls.localize('vueport/debug/panels/worlds/left', 'Left'),
                                world.lon,
                                value => this.writeHead({ lon: value })
                            )}
                            {this.renderToggle(
                                nls.localize('vueport/debug/panels/worlds/right', 'Right'),
                                world.ron,
                                value => this.writeHead({ ron: value })
                            )}
                        </div>
                    </div>
                    <div className='vp-inspector-field'>
                        <label>{nls.localize('vueport/debug/panels/worlds/flags', 'Flags')}</label>
                        <div className='vp-flags-row'>
                            {this.renderToggle(
                                nls.localize('vueport/debug/panels/worlds/end', 'End'),
                                world.end,
                                value => this.writeHead({ end: value }),
                                nls.localize('vueport/debug/panels/worlds/endHint', 'Drawing stops at this world')
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </fieldset>;
    }

    // a switch rather than a checkbox, as these take effect at once (laid out like the Characters panel's toggles)
    protected renderToggle(
        label: string, value: boolean, onChange: (value: boolean) => void, hint?: string
    ): React.ReactNode {
        return <span className='vp-toggle' title={hint}>
            <Switch label={label} value={value} onChange={onChange} />
            <span>{label}</span>
        </span>;
    }

    protected segmentCountInput(value: number, commit: (value: number) => void): React.JSX.Element {
        return <Select
            value={String(value)}
            onChange={next => commit(parseInt(next, 10))}
            options={[1, 2, 4, 8].map(count => ({ value: String(count), label: String(count) }))}
        />;
    }

    protected renderHBiasGroup(world: VipWorld): React.ReactNode {
        const rows = vipParamRows(world);
        const row = Math.min(this.hbiasRow, Math.max(0, rows - 1));
        const entry = vipHBiasRow(this.params(), row);
        const address = vipParamTableAddress(world.param) + row * VIP_HBIAS_ENTRY_BYTES;
        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/worlds/hbias', 'H-bias')}</legend>
            <div className='vp-detail-fields'>
                {control(
                    nls.localize('vueport/debug/panels/worlds/index', 'Index'),
                    numberInput(row, 0, Math.max(0, rows - 1), value => { this.hbiasRow = value; this.update(); }),
                    nls.localize('vueport/debug/panels/worlds/hbiasRowHint', 'Which row of the table to show; there is one per row of the world')
                )}
                {field(nls.localize('vueport/debug/panels/worlds/address', 'Address'), hex(address, 8))}
                {control(
                    nls.localize('vueport/debug/panels/worlds/left', 'Left'),
                    numberInput(entry?.left ?? 0, SIGNED_MIN, SIGNED_MAX, value => this.writeHBias(world, row, 'left', value))
                )}
                {control(
                    nls.localize('vueport/debug/panels/worlds/right', 'Right'),
                    numberInput(entry?.right ?? 0, SIGNED_MIN, SIGNED_MAX, value => this.writeHBias(world, row, 'right', value))
                )}
            </div>
        </fieldset>;
    }

    // a group of its own, as World Color Attribute RAM lives in the VCU, and only shown while color is on. The offset
    // is added to the CRAM palette of everything the world draws, but only under CXCTRL's WCEN; with WCEN off it is
    // shown as stored, not used, since a game setting offsets before WCEN is worth seeing
    protected renderColorGroup(world: VipWorld, vbc: VbcState, attrBytes: Uint8Array): React.ReactNode {
        const offset = attrBytes[world.index * 2] ?? 0;
        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/worlds/vbColor', 'VB Color')}</legend>
            <div className='vp-detail-fields'>
                {control(
                    nls.localize('vueport/debug/panels/worlds/paletteOffset', 'Palette Offset'),
                    numberInput(offset, 0, 0xff, value => this.writePaletteOffset(value)),
                    nls.localize(
                        'vueport/debug/panels/worlds/paletteOffsetHint',
                        'World Color Attribute: added, modulo 256, to the CRAM palette of everything this world draws'
                    )
                )}
                {field(
                    nls.localize('vueport/debug/panels/worlds/address', 'Address'),
                    hex(VCU_WORLD_ATTR_BASE + world.index * 2, 8)
                )}
            </div>
            {!vbc.wcen &&
                <div className='vp-footer'>
                    {nls.localize(
                        'vueport/debug/panels/worlds/paletteOffsetOff',
                        'Not in effect: CXCTRL.WCEN is off, so the VCU ignores the world palette offsets.'
                    )}
                </div>
            }
        </fieldset>;
    }

    // on its own, whether the preview is in Solo or Context (see `alone` in rasterize), in the panel's eye and palettes
    protected async exportPng(): Promise<void> {
        const world = this.world();
        if (this.exportFile && this.registers && world) {
            await exportVipImage(
                this.exportFile, `world-${this.selected}-${this.eye}.png`, this.rasterize(this.registers, world));
        }
    }

    protected renderDisplayControls(): React.ReactNode {
        return <div className='vp-preview-controls'>
            <div className='vp-preview-controls-range'>
                <label>
                    <span>{nls.localize('vueport/debug/panels/worlds/scale', 'Scale')}</span>
                    <input
                        type='range'
                        min={1}
                        max={MAX_PREVIEW_ZOOM}
                        value={this.zoom}
                        onChange={e => {
                            this.zoom = this.remember('zoom', parseInt(e.target.value, 10));
                            this.update();
                        }}
                    />
                    <span className='hint'>{this.zoom}</span>
                </label>
            </div>
            <div className='vp-preview-controls-row'>
                <RadioSelect
                    options={[{
                        value: 'left',
                        label: nls.localize('vueport/debug/panels/worlds/leftEye', 'Left Eye'),
                    }, {
                        value: 'right',
                        label: nls.localize('vueport/debug/panels/worlds/rightEye', 'Right Eye'),
                    }]}
                    defaultValue={this.eye}
                    onChange={options => this.setEye(options[0].value as VipEye)}
                />
                <RadioSelect
                    options={[{
                        value: 'context',
                        label: nls.localize('vueport/debug/panels/worlds/inContext', 'In Context'),
                        tooltip: nls.localize(
                            'vueport/debug/panels/worlds/inContextHint',
                            'Every world the VIP draws, in its own order, with all but the selected one faded'
                        ),
                    }, {
                        value: 'solo',
                        label: nls.localize('vueport/debug/panels/worlds/solo', 'Solo'),
                        tooltip: nls.localize(
                            'vueport/debug/panels/worlds/soloHint',
                            'The selected world on its own, drawn whether or not the hardware would draw it'
                        ),
                    }]}
                    defaultValue={this.previewMode}
                    onChange={options => this.setPreviewMode(options[0].value as WorldPreviewMode)}
                />
            </div>
            <div className='vp-preview-controls-switches'>
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/worlds/genericPalette', 'Generic Palette'),
                    this.showGenericPalette,
                    value => this.setShowGenericPalette(value)
                )}
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/worlds/hideUndrawn', 'Hide Undrawn'),
                    this.showOnlyDrawn,
                    value => this.setShowOnlyDrawn(value),
                    nls.localize(
                        'vueport/debug/panels/worlds/showOnlyDrawnHint',
                        'Leave out the worlds the VIP skips: the one that ends the frame and everything'
                        + ' past it, and — in Context — those switched off for this eye'
                    )
                )}
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/worlds/showOutline', 'Show Outline'),
                    this.showExtents,
                    value => { this.showExtents = this.remember('showExtents', value); this.update(); }
                )}
                {this.vbc && this.renderToggle(
                    nls.localize('vueport/debug/panels/worlds/vbColorPreview', 'Colorized'),
                    this.vbColorPreview,
                    value => this.setVbColorPreview(value),
                    nls.localize(
                        'vueport/debug/panels/worlds/vbColorPreviewHint',
                        'Draw in the colors the VB Color shows rather than the VIP\'s red'
                    )
                )}
            </div>
            {this.exportFile &&
                <div className='vp-preview-controls-row'>
                    <button
                        type='button'
                        className='vp-button secondary'
                        title={nls.localize(
                            'vueport/debug/panels/worlds/exportPngHint',
                            'Save the selected world on its own as a PNG, cut to its size and transparent'
                            + ' where it draws nothing')}
                        onClick={() => { this.exportPng().catch(() => undefined); }}
                    >
                        {nls.localize('vueport/debug/panels/worlds/exportPng', 'Export PNG')}
                    </button>
                </div>
            }
        </div>;
    }

    // the group an OBJECT world takes is not in its entry, but decided by how many OBJECT worlds the VIP drew before it
    protected objectWorldNote(world: VipWorld): string {
        const group = this.objectGroupFor(world.index);
        if (group === undefined) {
            return nls.localize(
                'vueport/debug/panels/worlds/objectWorldUnreached',
                'An Object world, but the VIP never reaches it: there is no object group left for it.'
            );
        }
        const range = this.registers && vipObjectGroupRange(this.registers, group);
        return range
            ? nls.localize(
                'vueport/debug/panels/worlds/objectWorldGroup',
                'Drawing object group {0}, objects {1} to {2}, which the Objects panel lists.',
                group, range.first, range.last
            )
            : nls.localize(
                'vueport/debug/panels/worlds/objectWorldEmpty',
                'Drawing object group {0}, which the SPT registers leave empty.',
                group
            );
    }

    protected renderPreview(world: VipWorld): React.ReactNode {
        return <div className='vp-preview vp-preview-with-controls'>
            <div className='vp-preview-view vp-scroll'>
                {this.image &&
                    <VipCanvas
                        image={this.image}
                        zoom={this.zoom}
                        extents={this.showExtents ? vipWorldExtents(world, this.eye) : undefined}
                    />
                }
                {world.mode === VipWorldMode.OBJECT &&
                    <div className='vp-footer'>{this.objectWorldNote(world)}</div>
                }
            </div>
            {this.renderDisplayControls()}
        </div>;
    }
}
