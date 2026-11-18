import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import { ScreenInspectorTarget } from './emulator-screen-inspector';
import { arrowKeysTaken, hex, DebugSource, Panel, EmulatorPanelType, scrollIntoViewSmoothly } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { exportVipImage, VipCanvas, VipExportFile } from './emulator-vip-canvas';
import {
    decodeVipObject,
    decodeVipWorld,
    drawVipChar,
    drawVipObject,
    encodeVipObject,
    forEachVipObjectPixel,
    forEachVipWorldPixel,
    isVipObjectVisible,
    sameVipBytes,
    VIP_BGMAP_COUNT,
    VIP_BGMAP_PALETTES,
    VIP_CHAR_COUNT,
    VIP_CHAR_COUNT_EXTENDED,
    VIP_CHAR_SEGMENT_BYTES,
    VIP_CHAR_SIZE,
    VIP_FRAME_BUFFER_HEIGHT,
    VIP_FRAME_BUFFER_WIDTH,
    VIP_GENERIC_PALETTE_INTENSITIES,
    VIP_GRAPHICS_POLL_HZ,
    VIP_OAM_BASE,
    VIP_OAM_BLOCK_BYTES,
    VIP_OBJECT_BYTES,
    VIP_OBJECT_COUNT,
    VIP_OBJECT_GROUP_COUNT,
    VIP_OBJECT_GROUP_ENDS,
    VIP_OBJECT_PALETTES,
    vipCharSegmentAddress,
    vipCharSegmentCount,
    VipCharacters,
    VipEye,
    vipIntensitiesForRegister,
    VipIntensityWatcher,
    VIP_REGISTER_BASE,
    VIP_REGISTER_BLOCK_BYTES,
    VIP_WORLD_BASE,
    VIP_WORLD_BLOCK_BYTES,
    VIP_WORLD_BYTES,
    VIP_WORLD_COUNT,
    VipObject,
    vipObjectAddress,
    vipObjectExtents,
    vipObjectGroupForWorld,
    vipObjectGroupOf,
    vipObjectGroupRange,
    VipWorld,
    VipWorldMap,
    VipWorldMode,
    vipWorldSample,
    vipOverplaneSegment,
} from './emulator-vip-memory';
import { VcuColors, vcuPlacement, vipShade } from './emulator-vcu-colors';
import { VIP_CONTEXT_FACTOR, VipWorldSources } from './emulator-vip-world-sources';
import { VipObjectCluster, vipObjectClusterOf, vipObjectClusters } from './emulator-vip-object-clusters';
import { field, numberInput, stacked } from './emulator-vip-detail';
import {
    decodeVcuColorAttr,
    decodeVcuPixelAttr,
    encodeVcuColorAttr,
    encodeVcuPixelAttr,
    readVbcState,
    VbcState,
    vbcCharMask,
    VCU_CHARACTER_COLOR_BASE,
    VCU_CHARACTER_PIXEL_ATTR_BASE,
    VCU_CRAM_BASE,
    VCU_CRAM_ENTRY_BYTES,
    VCU_CRAM_PALETTE_SIZE,
    VCU_OBJ_COLOR_BASE,
    VCU_OBJ_PIXEL_ATTR_BASE,
    VCU_PIXEL_SLOT_COUNT,
    VcuColorAttr,
    VcuPixelAttr,
    vcuPlacementPalette,
    vcuRgb888,
} from './emulator-vcu-memory';
import EmptyContainer from '../components/kit/EmptyContainer';
import { Plug, Warning } from '@phosphor-icons/react';
import { Sim } from '../core/vb-core';
import RadioSelect from '../components/kit/RadioSelect';
import Select from '../components/kit/Select';
import Switch from '../components/kit/Switch';

// source to screen pixels: 8 at 27 is the 216-pixel preview the sidebar is sized to hold
const CHARACTER_ZOOM = 27;

const MAX_PREVIEW_ZOOM = 4;

// signed 10-bit screen position
const JX_MIN = -0x200;
const JX_MAX = 0x1ff;
// signed 14-bit parallax
const JP_MIN = -0x2000;
const JP_MAX = 0x1fff;
// JY is unsigned: eight bits, top to bottom of the screen
const JY_MAX = 0xff;

// the selected object alone, or the frame it is part of (the Worlds panel's two modes). Context draws every world in
// VIP order, objects in the hardware's red and every other world faded to gray
type ObjectPreviewMode = 'solo' | 'context';

// the sidebar's width, as the BGMaps panel's Used by previews
const FIGURE_PREVIEW_WIDTH = 208;
const FIGURE_PREVIEW_MAX_HEIGHT = 96;
const FIGURE_PREVIEW_MAX_ZOOM = 4;

function figurePreviewZoom(image: ImageData): number {
    const fit = Math.min(
        FIGURE_PREVIEW_WIDTH / image.width, FIGURE_PREVIEW_MAX_HEIGHT / image.height, FIGURE_PREVIEW_MAX_ZOOM
    );
    return fit >= 1 ? Math.floor(fit) : fit;
}

interface FigureEntry {
    cluster: VipObjectCluster;
    group?: number;
    image: ImageData;
}

// dims the color just written at `offset` to Context's faded brightness, the color version of its gray
function fadeColor(pixels: Uint8ClampedArray, offset: number): void {
    pixels[offset] = Math.round(pixels[offset] * VIP_CONTEXT_FACTOR);
    pixels[offset + 1] = Math.round(pixels[offset + 1] * VIP_CONTEXT_FACTOR);
    pixels[offset + 2] = Math.round(pixels[offset + 2] * VIP_CONTEXT_FACTOR);
}

const ALL_OBJECT_GROUPS = (1 << VIP_OBJECT_GROUP_COUNT) - 1;

// the palette groups a Color Attribute can name: its low six bits
const VCU_GROUP_MAX = 0x3f;

// what VB Color adds to the selected object: its OBJ Color Attribute byte, its OBJ Pixel Color Attribute halfword
// and the colors they come to. Only the selected object's, as nothing else shows them (three bytes a poll, not 3 KB)
interface ObjectColor {
    // the object these were read for, so a read that raced a new selection is not shown for it
    index: number;
    // as read, so an edit can write back the bits it does not name
    colorByte: number;
    pixelHalfword: number;
    // the Character's own OBJ entries, read only while they are in effect: CHRSEL set and CXCTRL.CCEN on
    character?: { color: VcuColorAttr; pixel: VcuPixelAttr };
    palette: number;
    colors: number[];
}

// the VIP's object attribute memory, up to 1024 sprites: tiles, the picked object's fields and a preview alone or in
// its frame. The tiles keep to drawn objects by default, as most of OAM is unused
export class ObjectsPanel extends Panel {

    protected objectBytes?: Uint8Array;
    // OAM before its last change, which gives the figures the objects' motion; see vipObjectClusters
    protected previousObjectBytes?: Uint8Array;
    protected registers?: DataView;
    protected charSegments: (Uint8Array | undefined)[] = [];
    // world attribute memory, read only in Context, or in color under WCEN for the palette offset an OBJ world gives
    // its objects
    protected worldBytes?: Uint8Array;
    protected readonly sources = new VipWorldSources();
    // undefined unless a VB Color game has it switched on; every color field and the extended characters go by it
    protected vbc?: VbcState;
    protected objectColor?: ObjectColor;
    protected colors?: VcuColors;
    protected readonly placement = vcuPlacement();
    protected readonly sample = vipWorldSample();
    protected error?: string;

    protected selected = 0;
    // keep the list to objects switched on for an eye; on, as most of OAM is slots nothing has been put in
    protected showOnlyDrawn = this.remembered('showOnlyDrawn', true);
    protected onlyFigure = this.remembered('onlyFigure', false);
    // object groups the panel keeps to, a bit per SPT register: the list leaves the others out, Context grays them.
    // Objects past the last group belong to none, so the filter never hides them (the VIP never draws them, which is
    // Show Only Drawn's job)
    protected groupFilter = this.remembered('objectGroups', ALL_OBJECT_GROUPS);
    protected eye = this.remembered('eye', 'left') as VipEye;
    protected previewMode = this.remembered('previewMode', 'context') as ObjectPreviewMode;
    protected zoom = this.remembered('zoom', 1);
    protected showExtents = this.remembered('showExtents', true);
    // an even ramp instead of the object palette registers, for reading the tile data with palettes and fades taken out
    protected showGenericPalette = this.remembered('showGenericPalette', false);
    // draw the previews in a VB Color game's colors rather than the VIP's red; only offered while the VCU is unlocked
    protected vbColorPreview = this.remembered('vbColorPreview', true);

    protected image?: ImageData;
    // see vipObjectClusters
    protected clusters: VipObjectCluster[] = [];
    protected figures: FigureEntry[] = [];
    protected hoveredFigure?: number;
    // set by clicking the figure again in the Figures list: the object stays selected, but is not treated as part of a
    // figure until another object is picked
    protected figureReleased = false;
    protected dirty = true;
    protected readonly intensityWatcher = new VipIntensityWatcher();
    // the SPT registers as last drawn; Context's groups follow them
    protected groupEnds?: string;

    constructor(
        source: DebugSource,
        instanceId: string,
        // where Export PNG hands its file; no button without it
        protected readonly exportFile?: VipExportFile
    ) {
        super(EmulatorPanelType.VIP_OBJECTS, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/objects/title', 'Objects');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.VIP_OBJECTS);
        // the three columns scroll on their own, so the panel's own scrolling is off and the layout hangs on this
        // class, shared with the Worlds and BGMaps panels (see the stylesheet)
        this.addClass('vp-vip-panel');
    }

    protected pollHz(): number {
        return VIP_GRAPHICS_POLL_HZ;
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.objectBytes = undefined;
            this.previousObjectBytes = undefined;
            this.clusters = [];
            this.figures = [];
            this.registers = undefined;
            this.charSegments = [];
            this.worldBytes = undefined;
            this.sources.clear();
            this.vbc = undefined;
            this.objectColor = undefined;
            this.colors = undefined;
            this.image = undefined;
            this.update();
            return;
        }

        try {
            this.registers = new DataView(await sim.readMemory(VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES));

            // first, as it decides how wide OAM's character field is
            const vbc = await readVbcState(this.source, sim);
            if (vbcCharMask(vbc) !== vbcCharMask(this.vbc)) {
                this.dirty = true;
            }
            this.vbc = vbc;

            const objectBytes = new Uint8Array(await sim.readMemory(VIP_OAM_BASE, VIP_OAM_BLOCK_BYTES));
            if (!sameVipBytes(objectBytes, this.objectBytes)) {
                this.previousObjectBytes = this.objectBytes;
                this.objectBytes = objectBytes;
                this.dirty = true;
            }

            await this.readCharacters(sim);
            await this.readWorlds(sim);
            await this.readColors(sim);
            this.objectColor = await this.readObjectColor(sim);

            if (this.intensityWatcher.changed(this.registers)) {
                this.dirty = true;
            }
            const registers = this.registers;
            const groupEnds = VIP_OBJECT_GROUP_ENDS.map(register => registers.getUint16(register, true)).join();
            if (groupEnds !== this.groupEnds) {
                this.groupEnds = groupEnds;
                this.dirty = true;
            }
            this.error = undefined;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }

        if (this.dirty && this.registers) {
            // the figures first, as Only Current Figure grays by them
            const characters = new VipCharacters(this.charSegments);
            this.clusters = vipObjectClusters(
                this.objects(), this.registers, characters, this.eye,
                this.previousObjectBytes && this.objects(this.previousObjectBytes)
            );
            this.figures = this.buildFigures(this.registers, characters);
            this.image = this.rasterize(this.registers);
            this.dirty = false;
        }
        this.update();
    }

    // the VIP's four segments, plus with CHREXT the VCU's four more for characters 2048-4095. Those are dropped when
    // CHREXT goes off, as VipCharacters reads the mask from the segment count
    protected async readCharacters(sim: Sim): Promise<void> {
        const count = vipCharSegmentCount(!!this.vbc?.chrext);
        if (this.charSegments.length > count) {
            this.charSegments.length = count;
            this.dirty = true;
        }
        const segments = await Promise.all(Array.from(
            { length: count },
            (unused, index) => sim.readMemory(vipCharSegmentAddress(index), VIP_CHAR_SEGMENT_BYTES)
        ));
        segments.forEach((buffer, index) => {
            const bytes = new Uint8Array(buffer);
            if (!sameVipBytes(bytes, this.charSegments[index])) {
                this.charSegments[index] = bytes;
                this.dirty = true;
            }
        });
    }

    // read the worlds Context draws around the objects and their maps and param tables. Solo lets go of all of it,
    // except world attribute memory in color under WCEN, where the OBJ world drawing a group decides its palette
    // offset
    protected async readWorlds(sim: Sim): Promise<void> {
        const context = this.previewMode === 'context';
        if (!context && !(this.inColor() && this.vbc?.wcen)) {
            if (this.worldBytes) {
                this.worldBytes = undefined;
                this.sources.clear();
                this.dirty = true;
            }
            return;
        }
        const worldBytes = new Uint8Array(await sim.readMemory(VIP_WORLD_BASE, VIP_WORLD_BLOCK_BYTES));
        if (!sameVipBytes(worldBytes, this.worldBytes)) {
            this.worldBytes = worldBytes;
            this.dirty = true;
        }
        if (!context) {
            this.sources.clear();
        } else if (await this.sources.read(sim, this.contextWorlds())) {
            this.dirty = true;
        }
    }

    protected inColor(): boolean {
        return !!this.vbc && this.vbColorPreview;
    }

    // called after readWorlds, since in Context its BGMap segments are the ones whose cells are colored (plus the
    // segment an overplane world's OVR cell is in)
    protected async readColors(sim: Sim): Promise<void> {
        const vbc = this.vbc;
        if (!vbc || !this.vbColorPreview) {
            if (this.colors) {
                this.colors = undefined;
                this.dirty = true;
            }
            return;
        }
        const segments: number[] = [];
        if (this.previewMode === 'context') {
            this.sources.bgMapSegments.forEach((bytes, segment) => bytes && segments.push(segment));
            for (const world of this.contextWorlds()) {
                const segment = vipOverplaneSegment(world);
                if (world.mode !== VipWorldMode.OBJECT && world.overplane && segment < VIP_BGMAP_COUNT) {
                    segments.push(segment);
                }
            }
        }
        const colors = await VcuColors.read(sim, vbc, { segments, objects: true, worlds: true });
        if (!colors.same(this.colors)) {
            this.dirty = true;
        }
        this.colors = colors;
    }

    // the selected object's VB Color attributes, undefined while the VCU is locked (all would read zero). Under CHRSEL
    // with CXCTRL.CCEN the Character's entries count, so those are read too; the colors are before any OBJ world's
    // palette offset, as which world draws it is up to the frame
    protected async readObjectColor(sim: Sim): Promise<ObjectColor | undefined> {
        const vbc = this.vbc;
        const object = this.object();
        if (!vbc || !object) {
            return undefined;
        }
        const index = object.index;
        const [color, pixel] = await Promise.all([
            sim.readMemory(VCU_OBJ_COLOR_BASE + index, 1),
            sim.readMemory(VCU_OBJ_PIXEL_ATTR_BASE + index * 2, 2),
        ]);
        const colorByte = new Uint8Array(color)[0];
        const pixelHalfword = new DataView(pixel).getUint16(0, true);

        let character: ObjectColor['character'];
        if (decodeVcuColorAttr(colorByte).chrsel && vbc.ccen) {
            // a Cell byte and an OBJ byte per Character, the OBJ one second
            const [characterColor, characterPixel] = await Promise.all([
                sim.readMemory(VCU_CHARACTER_COLOR_BASE + object.char * 2 + 1, 1),
                sim.readMemory(VCU_CHARACTER_PIXEL_ATTR_BASE + object.char * 2, 2),
            ]);
            character = {
                color: decodeVcuColorAttr(new Uint8Array(characterColor)[0]),
                pixel: decodeVcuPixelAttr(new DataView(characterPixel).getUint16(0, true)),
            };
        }

        const group = (character?.color ?? decodeVcuColorAttr(colorByte)).group;
        const palette = vcuPlacementPalette(group, object.palette);
        const cram = new DataView(await sim.readMemory(
            VCU_CRAM_BASE + palette * VCU_CRAM_PALETTE_SIZE * VCU_CRAM_ENTRY_BYTES,
            VCU_CRAM_PALETTE_SIZE * VCU_CRAM_ENTRY_BYTES
        ));
        const colors = Array.from({ length: VCU_CRAM_PALETTE_SIZE }, (unused, entry) =>
            cram.getUint32(entry * VCU_CRAM_ENTRY_BYTES, true));
        return { index, colorByte, pixelHalfword, character, palette, colors };
    }

    // twelve bits under VB Color's CHREXT, the VIP's eleven otherwise
    protected charMask(): number {
        return vbcCharMask(this.vbc);
    }

    // in VIP drawing order, 31 first. Empty unless in Context or in color under WCEN (palette offsets)
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

    // up to the world that ends the frame, which is not drawn itself. An OBJECT world is drawn if either eye asks for
    // it (its objects pick their own eye), any other world only if this eye does
    protected contextWorlds(): VipWorld[] {
        const worlds: VipWorld[] = [];
        for (const world of this.allWorlds()) {
            if (world.end) {
                break;
            }
            const drawn = world.mode === VipWorldMode.OBJECT
                ? world.lon || world.ron
                : this.eye === 'left' ? world.lon : world.ron;
            if (drawn) {
                worlds.push(world);
            }
        }
        return worlds;
    }

    protected object(): VipObject | undefined {
        const bytes = this.objectBytes;
        if (!bytes) {
            return undefined;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return decodeVipObject(view, this.selected, this.selected * VIP_OBJECT_BYTES, this.charMask());
    }

    // undefined for an object that is a figure of one, or not drawn and so part of none
    protected figure(): VipObjectCluster | undefined {
        if (this.figureReleased) {
            return undefined;
        }
        const cluster = vipObjectClusterOf(this.clusters, this.selected);
        return cluster && cluster.objects.length > 1 ? cluster : undefined;
    }

    protected figureObjects(): Set<number> {
        return new Set(this.figure()?.objects ?? [this.selected]);
    }

    // figures of more than one object, each with a picture, in OAM order. Built with the clusters rather than while
    // rendering, as the panel re-renders whenever the pointer moves over the list
    protected buildFigures(registers: DataView, characters: VipCharacters): FigureEntry[] {
        const bytes = this.objectBytes;
        if (!bytes) {
            return [];
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return this.clusters
            .filter(cluster => cluster.objects.length > 1)
            .sort((a, b) => a.objects[0] - b.objects[0])
            .map(cluster => ({
                cluster,
                group: vipObjectGroupOf(registers, cluster.objects[0]),
                image: this.rasterizeFigure(registers, view, cluster, characters),
            }));
    }

    // one figure cut to its rectangle on black, objects from the last index down so a lower one lands on top as on
    // screen
    protected rasterizeFigure(
        registers: DataView, view: DataView, cluster: VipObjectCluster, characters: VipCharacters,
        transparent = false // for the exported file, a sprite to be put on something else
    ): ImageData {
        const width = Math.max(1, Math.min(cluster.width, VIP_FRAME_BUFFER_WIDTH));
        const height = Math.max(1, Math.min(cluster.height, VIP_FRAME_BUFFER_HEIGHT));
        const pixels = new Uint8ClampedArray(width * height * 4);
        if (!transparent) {
            for (let offset = 3; offset < pixels.length; offset += 4) {
                pixels[offset] = 255;
            }
        }
        const charMask = this.charMask();
        const colors = this.inColor() ? this.colors : undefined;
        const offsets = colors && this.groupWorldOffsets(colors);
        for (let at = cluster.objects.length - 1; at >= 0; at--) {
            const index = cluster.objects[at];
            const object = decodeVipObject(view, index, index * VIP_OBJECT_BYTES, charMask);
            const extents = vipObjectExtents(object, this.eye);
            // moved into the figure's rectangle by screen position rather than fields: JY wraps, and a figure
            // straddling the top edge would otherwise come apart
            const top = extents.y > 0xff - VIP_CHAR_SIZE ? extents.y - 0x100 : extents.y;
            const moved = { ...object, jx: object.jx - cluster.x, jy: top - cluster.y };
            if (colors && offsets) {
                this.drawObjectInColor(
                    pixels, width, height, moved, characters, registers, colors,
                    this.objectWorldOffset(offsets, registers, index)
                );
                continue;
            }
            const intensities = this.intensities(registers, object.palette);
            forEachVipObjectPixel(moved, width, height, characters, this.eye, (x, y, value) => {
                if (value !== 0) {
                    const offset = (y * width + x) * 4;
                    pixels[offset] = intensities[value];
                    pixels[offset + 3] = 255;
                }
            });
        }
        return new ImageData(pixels, width, height);
    }

    // cut to its rectangle and transparent around it, in the panel's eye and palettes. Nothing while not in a figure
    protected async exportFigure(): Promise<void> {
        const figure = this.figure();
        const bytes = this.objectBytes;
        if (!this.exportFile || !figure || !bytes || !this.registers) {
            return;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const image = this.rasterizeFigure(
            this.registers, view, figure, new VipCharacters(this.charSegments), true);
        const objects = figure.objects;
        await exportVipImage(
            this.exportFile, `figure-${objects[0]}-${objects[objects.length - 1]}-${this.eye}.png`, image);
    }

    // picks its first object, unless one of its own is picked already, or, clicked again, lets go of it
    protected selectFigure(cluster: VipObjectCluster): void {
        if (!cluster.objects.includes(this.selected)) {
            this.selectObject(cluster.objects[0]);
            this.revealSelected();
            return;
        }
        this.figureReleased = !this.figureReleased;
        this.dirty = true;
        this.refresh();
    }

    // a click between or under the figures lets go of the selected one, as a second click on it does
    protected onFiguresClick(event: React.MouseEvent): void {
        if (this.figure() && !(event.target as Element).closest('button')) {
            this.figureReleased = true;
            this.dirty = true;
            this.refresh();
        }
    }

    protected setHoveredFigure(first: number | undefined): void {
        if (this.hoveredFigure !== first) {
            this.hoveredFigure = first;
            this.update();
        }
    }

    protected setOnlyFigure(value: boolean): void {
        this.onlyFigure = this.remember('onlyFigure', value);
        this.dirty = true;
        this.refresh();
    }

    protected selectObject(index: number): void {
        if (Number.isNaN(index)) {
            return;
        }
        const selected = Math.min(VIP_OBJECT_COUNT - 1, Math.max(0, index));
        if (selected !== this.selected) {
            this.figureReleased = false;
        }
        this.selected = selected;
        this.dirty = true;
        this.refresh();
    }

    protected setShowGenericPalette(value: boolean): void {
        this.showGenericPalette = this.remember('showGenericPalette', value);
        this.dirty = true;
        this.refresh();
    }

    protected setVbColorPreview(value: boolean): void {
        this.vbColorPreview = this.remember('vbColorPreview', value);
        this.dirty = true;
        this.refresh();
    }

    protected setEye(eye: VipEye): void {
        this.eye = this.remember('eye', eye) as VipEye;
        this.dirty = true;
        this.refresh();
    }

    // Context draws from world and BGMap memory too, so the sources are read again, not only the picture redrawn
    protected setPreviewMode(mode: ObjectPreviewMode): void {
        this.previewMode = this.remember('previewMode', mode) as ObjectPreviewMode;
        this.dirty = true;
        this.refresh();
    }

    // the selection moves to the first object still listed, so the fields never describe one that cannot be pointed at
    protected setGroupFilter(groups: number[]): void {
        this.groupFilter = this.remember('objectGroups', groups.reduce((mask, group) => mask | 1 << group, 0));
        const listed = this.listedObjects();
        if (listed.length > 0 && !listed.some(object => object.index === this.selected)) {
            this.selectObject(listed[0].index);
            this.revealSelected();
            return;
        }
        this.dirty = true;
        this.refresh();
    }

    protected setShowOnlyDrawn(value: boolean): void {
        this.showOnlyDrawn = this.remember('showOnlyDrawn', value);
        this.update();
    }

    protected intensities(registers: DataView, palette: number): number[] {
        return this.showGenericPalette
            ? VIP_GENERIC_PALETTE_INTENSITIES
            : vipIntensitiesForRegister(registers, VIP_OBJECT_PALETTES[palette]);
    }

    // the two bits of the JPLT or GPLT register a pixel value selects, or the value itself under Generic Palette
    protected shade(register: number, value: number): number {
        return this.showGenericPalette ? value : vipShade(register, value);
    }

    // per object group, the palette offset of the OBJ world drawing it; 0 for a group no world draws or while world
    // memory is not read
    protected groupWorldOffsets(colors: VcuColors): number[] {
        const offsets = Array.from({ length: VIP_OBJECT_GROUP_COUNT }, () => 0);
        const all = this.allWorlds();
        for (const world of all) {
            const group = world.mode === VipWorldMode.OBJECT ? vipObjectGroupForWorld(all, world.index) : undefined;
            if (group !== undefined) {
                offsets[group] = colors.worldOffset(world.index);
            }
        }
        return offsets;
    }

    protected objectWorldOffset(offsets: readonly number[], registers: DataView, index: number): number {
        const group = vipObjectGroupOf(registers, index);
        return group === undefined ? 0 : offsets[group];
    }

    /**
     * Paints one object in VB Color's colors, or at the faded brightness for an object Context leaves in the
     * background. A pixel the hardware leaves out (value 0 without OPQ, or a Pixel Color Slot's 0xFF) is left alone,
     * the hole the red previews leave for value 0. The character coordinates are worked out here, as
     * forEachVipObjectPixel does not pass them on and a Pixel Color Slot is laid out over the unflipped character.
     */
    protected drawObjectInColor(
        pixels: Uint8ClampedArray,
        width: number,
        height: number,
        object: VipObject,
        characters: VipCharacters,
        registers: DataView,
        colors: VcuColors,
        worldOffset: number,
        faded = false
    ): void {
        const placement = colors.object(object.index, object.char, object.palette, this.placement);
        const register = registers.getUint16(VIP_OBJECT_PALETTES[object.palette], true) & 0xff;
        const left = vipObjectExtents(object, this.eye).x;
        for (let row = 0; row < VIP_CHAR_SIZE; row++) {
            const y = object.jy + row;
            if (y < 0 || y >= height) {
                continue;
            }
            const charY = object.vFlip ? VIP_CHAR_SIZE - 1 - row : row;
            for (let column = 0; column < VIP_CHAR_SIZE; column++) {
                const x = left + column;
                if (x < 0 || x >= width) {
                    continue;
                }
                const charX = object.hFlip ? VIP_CHAR_SIZE - 1 - column : column;
                const value = characters.pixel(object.char, charX, charY);
                const offset = (y * width + x) * 4;
                if (colors.put(pixels, offset, placement, value, charX, charY, this.shade(register, value), worldOffset)
                    && faded) {
                    fadeColor(pixels, offset);
                }
            }
        }
    }

    // the whole eight-byte entry goes back, the values not being edited exactly as they were read
    protected async writeObject(patch: Partial<VipObject>): Promise<void> {
        const sim = this.source.sim;
        const object = this.object();
        if (!sim || !object) {
            return;
        }

        const bytes: number[] = [];
        encodeVipObject({ ...object, ...patch }, this.charMask()).forEach(halfword => {
            bytes.push(halfword & 0xff, (halfword >> 8) & 0xff);
        });
        await this.source.write(vipObjectAddress(this.selected), bytes);

        this.dirty = true;
        await this.refresh();
    }

    protected selectedColor(): ObjectColor | undefined {
        const color = this.objectColor;
        return this.vbc && color && color.index === this.selected ? color : undefined;
    }

    // the bit neither field names is written back as it was read; see encodeVcuColorAttr
    protected async writeObjectColor(patch: Partial<VcuColorAttr>): Promise<void> {
        const color = this.selectedColor();
        if (!this.source.sim || !color) {
            return;
        }
        const byte = encodeVcuColorAttr({ ...decodeVcuColorAttr(color.colorByte), ...patch }, color.colorByte);
        await this.source.write(VCU_OBJ_COLOR_BASE + color.index, [byte]);
        await this.refresh();
    }

    // the OBJ Pixel Color Attribute halfword, written back the same way
    protected async writeObjectPixel(patch: Partial<VcuPixelAttr>): Promise<void> {
        const color = this.selectedColor();
        if (!this.source.sim || !color) {
            return;
        }
        const halfword = encodeVcuPixelAttr(
            { ...decodeVcuPixelAttr(color.pixelHalfword), ...patch }, color.pixelHalfword
        );
        await this.source.write(VCU_OBJ_PIXEL_ATTR_BASE + color.index * 2, [halfword & 0xff, (halfword >> 8) & 0xff]);
        await this.refresh();
    }

    /**
     * A screen-sized bitmap of the preview: in Solo the selected object alone, in Context the frame the VIP draws for
     * the shown eye, objects in red and every other world gray. The selected object is not singled out (the outline
     * does that), so the overlap stays as the hardware draws it. In color both use the VCU's colors, the worlds around
     * the objects dimmed by the same factor as the gray.
     */
    protected rasterize(registers: DataView): ImageData {
        const width = VIP_FRAME_BUFFER_WIDTH;
        const height = VIP_FRAME_BUFFER_HEIGHT;
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let offset = 3; offset < pixels.length; offset += 4) {
            pixels[offset] = 255;
        }

        const characters = new VipCharacters(this.charSegments);
        if (this.previewMode === 'context') {
            this.rasterizeContext(registers, pixels, width, height, characters);
            return new ImageData(pixels, width, height);
        }

        const object = this.object();
        const colors = this.inColor() ? this.colors : undefined;
        if (object && colors) {
            this.drawObjectInColor(
                pixels, width, height, object, characters, registers, colors,
                this.objectWorldOffset(this.groupWorldOffsets(colors), registers, object.index)
            );
        } else if (object) {
            drawVipObject(
                pixels,
                width,
                height,
                object,
                characters,
                this.intensities(registers, object.palette),
                this.eye
            );
        }
        return new ImageData(pixels, width, height);
    }

    // pixel value 0 is left alone, the hardware's transparency. Which group an OBJECT world draws follows the drawing
    // order, and within a group objects are drawn from the last index down, as the Worlds panel does (see
    // vipObjectGroupForWorld)
    protected rasterizeContext(
        registers: DataView,
        pixels: Uint8ClampedArray,
        width: number,
        height: number,
        characters: VipCharacters
    ): void {
        const bytes = this.objectBytes;
        const all = this.allWorlds();
        const palettes = this.showGenericPalette
            ? [0, 1, 2, 3].map(() => VIP_GENERIC_PALETTE_INTENSITIES)
            : VIP_BGMAP_PALETTES.map(register => vipIntensitiesForRegister(registers, register));
        const shades = [0, 1, 2, 3].map(palette => this.intensities(registers, palette));
        const colors = this.inColor() ? this.colors : undefined;
        const gplts = VIP_BGMAP_PALETTES.map(register => registers.getUint16(register, true) & 0xff);

        for (const world of this.contextWorlds()) {
            if (world.mode !== VipWorldMode.OBJECT && colors) {
                this.drawWorldInColor(world, pixels, width, height, characters, colors, gplts);
                continue;
            }
            if (world.mode !== VipWorldMode.OBJECT) {
                const map = new VipWorldMap(world, this.sources.bgMapSegments, characters);
                forEachVipWorldPixel(
                    world, width, height, this.eye, this.sources.params(world.index),
                    (destX, destY, x, y) => {
                        const intensity = map.intensity(x, y, palettes);
                        if (intensity === 0) {
                            return;
                        }
                        const gray = Math.round(intensity * VIP_CONTEXT_FACTOR);
                        const offset = (destY * width + destX) * 4;
                        pixels[offset] = gray;
                        pixels[offset + 1] = gray;
                        pixels[offset + 2] = gray;
                    }
                );
                continue;
            }

            const group = vipObjectGroupForWorld(all, world.index);
            const range = group === undefined ? undefined : vipObjectGroupRange(registers, group);
            if (!bytes || group === undefined || !range) {
                continue;
            }
            // a group the filter leaves out is still on screen, so it is drawn gray like the worlds around the
            // objects, as is every object outside the figure under Only Current Figure
            const groupFaded = (this.groupFilter & 1 << group) === 0;
            const figure = this.onlyFigure ? this.figureObjects() : undefined;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const charMask = this.charMask();
            const worldOffset = colors ? colors.worldOffset(world.index) : 0;
            for (let index = Math.min(range.last, VIP_OBJECT_COUNT - 1); index >= range.first; index--) {
                const object = decodeVipObject(view, index, index * VIP_OBJECT_BYTES, charMask);
                if (!(this.eye === 'left' ? object.lon : object.ron)) {
                    continue;
                }
                const intensities = shades[object.palette];
                const faded = groupFaded || (figure !== undefined && !figure.has(index));
                if (colors) {
                    this.drawObjectInColor(
                        pixels, width, height, object, characters, registers, colors, worldOffset, faded
                    );
                    continue;
                }
                forEachVipObjectPixel(object, width, height, characters, this.eye, (destX, destY, value) => {
                    if (value === 0) {
                        return;
                    }
                    // red, as the hardware emits; the other two channels are written too, as a world under the object
                    // may have left gray
                    const gray = faded ? Math.round(intensities[value] * VIP_CONTEXT_FACTOR) : 0;
                    const offset = (destY * width + destX) * 4;
                    pixels[offset] = faded ? gray : intensities[value];
                    pixels[offset + 1] = gray;
                    pixels[offset + 2] = gray;
                });
            }
        }
    }

    // dimmed rather than grayed, as in color the objects no longer stand out by being red
    protected drawWorldInColor(
        world: VipWorld,
        pixels: Uint8ClampedArray,
        width: number,
        height: number,
        characters: VipCharacters,
        colors: VcuColors,
        gplts: readonly number[]
    ): void {
        const map = new VipWorldMap(world, this.sources.bgMapSegments, characters);
        const sample = this.sample;
        const placement = this.placement;
        const worldOffset = colors.worldOffset(world.index);
        forEachVipWorldPixel(
            world, width, height, this.eye, this.sources.params(world.index),
            (destX, destY, x, y) => {
                map.sample(x, y, sample);
                colors.cell(sample.segment, sample.cell, sample.char, sample.palette, placement);
                const offset = (destY * width + destX) * 4;
                const shade = this.shade(gplts[sample.palette], sample.value);
                if (colors.put(pixels, offset, placement, sample.value, sample.charX, sample.charY, shade, worldOffset)) {
                    fadeColor(pixels, offset);
                }
            }
        );
    }

    protected rasterizeCharacter(registers: DataView, object: VipObject): ImageData {
        const pixels = new Uint8ClampedArray(VIP_CHAR_SIZE * VIP_CHAR_SIZE * 4);
        const colors = this.inColor() ? this.colors : undefined;
        if (colors) {
            // drawn as an object at the top left, flips and all; what the hardware leaves out stays black rather than
            // turning into a transparent hole
            for (let offset = 3; offset < pixels.length; offset += 4) {
                pixels[offset] = 255;
            }
            const worldOffset = this.objectWorldOffset(this.groupWorldOffsets(colors), registers, object.index);
            this.drawObjectInColor(
                pixels, VIP_CHAR_SIZE, VIP_CHAR_SIZE, { ...object, jx: 0, jp: 0, jy: 0 },
                new VipCharacters(this.charSegments), registers, colors, worldOffset
            );
            return new ImageData(pixels, VIP_CHAR_SIZE, VIP_CHAR_SIZE);
        }
        drawVipChar(
            pixels,
            VIP_CHAR_SIZE,
            0,
            0,
            new VipCharacters(this.charSegments),
            object.char,
            this.intensities(registers, object.palette),
            object.hFlip,
            object.vFlip
        );
        return new ImageData(pixels, VIP_CHAR_SIZE, VIP_CHAR_SIZE);
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return <EmptyContainer
                title={this.error ?? nls.localize('vueport/general/error', 'Error')}
                icon={<Warning size={32} />}
            />;
        }
        const bytes = this.objectBytes;
        const registers = this.registers;
        if (!bytes || !registers) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/general/notRunning',
                    'The emulator is not running.',
                )}
                icon={<Plug size={32} />}
            />;
        }

        const object = this.object();
        if (!object) {
            return undefined;
        }

        // focusable, with the arrow keys read here rather than on the list, so they walk the objects wherever focus is
        return <div
            className='vp-columns'
            tabIndex={0}
            aria-label={nls.localize('vueport/debug/panels/objects/title', 'Objects')}
            onKeyDown={event => this.onPanelKey(event)}
        >
            {this.renderTiles()}
            <div className='vp-sidebar vp-scroll'>
                {this.renderObjectGroup(object, registers)}
                {this.renderPropertiesGroup(object)}
                {this.renderColorGroup(object)}
                {this.renderFiguresGroup()}
            </div>
            {this.renderPreview(object)}
        </div>;
    }

    protected objects(bytes = this.objectBytes): VipObject[] {
        if (!bytes) {
            return [];
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const charMask = this.charMask();
        return Array.from({ length: VIP_OBJECT_COUNT }, (unused, index) =>
            decodeVipObject(view, index, index * VIP_OBJECT_BYTES, charMask));
    }

    protected listedObjects(): VipObject[] {
        if (this.onlyFigure) {
            const figure = this.figureObjects();
            return this.objects().filter(object => figure.has(object.index));
        }
        const registers = this.registers;
        const groups = this.groupFilter;
        return this.objects().filter(object => {
            if (this.showOnlyDrawn && !isVipObjectVisible(object)) {
                return false;
            }
            if (!registers) {
                return true;
            }
            const group = vipObjectGroupOf(registers, object.index);
            return group === undefined || (groups & 1 << group) !== 0;
        });
    }

    // the objects in OAM order: index and eyes on one line, character and flips under them. A column of its own, so
    // moving to the next object does not mean leaving the one being read
    protected renderTiles(): React.ReactNode {
        const listed = this.listedObjects();
        const figure = new Set(this.figure()?.objects ?? []);
        return <div className='vp-tiles vp-scroll'>
            {listed.map(object => {
                const flips = `${object.hFlip ? 'H' : ''}${object.vFlip ? 'V' : ''}`;
                return <button
                    type='button'
                    key={object.index}
                    className={`vp-tile${isVipObjectVisible(object) ? '' : ' inactive'}`
                        + `${object.index === this.selected ? ' selected' : ''}`
                        + `${object.index !== this.selected && figure.has(object.index) ? ' related' : ''}`}
                    aria-pressed={object.index === this.selected}
                    tabIndex={-1}
                    title={hex(vipObjectAddress(object.index), 8)}
                    onClick={() => this.selectObject(object.index)}
                    onMouseEnter={() => this.light({ kind: 'object', object: object.index })}
                    onMouseLeave={() => this.light(undefined)}
                >
                    <span className='vp-tile-index'>{object.index}</span>
                    <span className='vp-tile-mark'>
                        {`${object.lon ? 'L' : '\u2013'}${object.ron ? 'R' : '\u2013'}`}
                    </span>
                    <span className='vp-tile-note'>
                        {nls.localize('vueport/debug/panels/objects/tileCharacter', 'Char {0}', object.char)}
                    </span>
                    {flips && <span className='vp-tile-flag'>{flips}</span>}
                </button>;
            })}
            {listed.length === 0 &&
                <div className='vp-footer'>
                    {this.groupFilter === ALL_OBJECT_GROUPS
                        ? nls.localize('vueport/debug/panels/objects/noObjects', 'No objects are being drawn.')
                        : nls.localize('vueport/debug/panels/objects/noGroupObjects', 'No objects in these groups.')}
                </div>
            }
        </div>;
    }

    // by position in the list, not index, so the keys stop at its ends. Stopped, not only defaulted, as the emulator
    // listens for keys on the node around the panel and would read an arrow as the D-pad
    protected onPanelKey(event: React.KeyboardEvent): void {
        if (arrowKeysTaken(event.target, event.currentTarget)) {
            return;
        }
        const steps: Record<string, number> = {
            ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, PageUp: -8, PageDown: 8,
        };
        const step = steps[event.key];
        const home = event.key === 'Home';
        const end = event.key === 'End';
        if (step === undefined && !home && !end) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const listed = this.listedObjects();
        if (listed.length === 0) {
            return;
        }
        const at = listed.findIndex(object => object.index === this.selected);
        const to = home ? 0 : end ? listed.length - 1 : Math.max(0, at) + step;
        this.selectObject(listed[Math.min(listed.length - 1, Math.max(0, to))].index);
        this.revealSelected();
    }

    // lets go of a filter that would leave the target out of the list
    reveal(target: ScreenInspectorTarget): void {
        if (target.kind !== 'object') {
            return;
        }
        if (!this.listedObjects().some(object => object.index === target.object)) {
            this.onlyFigure = this.remember('onlyFigure', false);
            this.groupFilter = this.remember('objectGroups', ALL_OBJECT_GROUPS);
        }
        this.selectObject(target.object);
        this.revealSelected('smooth');
    }

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

    protected renderObjectGroup(object: VipObject, registers: DataView): React.ReactNode {
        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/objects/object', 'Object')}</legend>
            <div className='vp-detail-fields'>
                {field(nls.localize('vueport/debug/panels/objects/index', 'Index'), object.index)}
                {field(
                    nls.localize('vueport/debug/panels/objects/address', 'Address'),
                    hex(vipObjectAddress(object.index), 8)
                )}
                {this.renderFigureField()}
            </div>
            <VipCanvas image={this.rasterizeCharacter(registers, object)} zoom={CHARACTER_ZOOM} />
        </fieldset>;
    }

    protected renderPropertiesGroup(object: VipObject): React.ReactNode {
        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/objects/properties', 'Properties')}</legend>
            <div className='vp-scroll-body vp-scroll'>
                <div className='vp-grid'>
                    <div className='vp-grid-row'>
                        {stacked(
                            nls.localize('vueport/debug/panels/objects/character', 'Character'),
                            // up to 4095 under VB Color's CHREXT, whose characters 2048 and up are in the VCU
                            numberInput(object.char, 0,
                                (this.vbc?.chrext ? VIP_CHAR_COUNT_EXTENDED : VIP_CHAR_COUNT) - 1,
                                value => this.writeObject({ char: value }))
                        )}
                        {stacked(
                            nls.localize('vueport/debug/panels/objects/palette', 'Palette'),
                            <Select
                                value={String(object.palette)}
                                onChange={next => this.writeObject({ palette: parseInt(next, 10) })}
                                options={VIP_OBJECT_PALETTES.map((unused, index) => ({
                                    value: String(index),
                                    label: `JPLT${index}`,
                                }))}
                            />,
                            undefined,
                            2
                        )}
                    </div>
                    <div className='vp-grid-row'>
                        {stacked('JX', numberInput(object.jx, JX_MIN, JX_MAX,
                            value => this.writeObject({ jx: value })))}
                        {stacked('JY', numberInput(object.jy, 0, JY_MAX,
                            value => this.writeObject({ jy: value })))}
                        {stacked('JP', numberInput(object.jp, JP_MIN, JP_MAX,
                            value => this.writeObject({ jp: value })))}
                    </div>
                    {/* a pair of switches needs more than a third of the group: a row each, spanning it */}
                    <div className='vp-grid-row'>
                        {stacked(
                            nls.localize('vueport/debug/panels/objects/flip', 'Flip'),
                            <div className='vp-flags-row'>
                                {this.renderToggle(
                                    nls.localize('vueport/debug/panels/objects/hFlip', 'H-flip'),
                                    nls.localize('vueport/debug/panels/objects/horizontal', 'H'),
                                    object.hFlip,
                                    value => this.writeObject({ hFlip: value })
                                )}
                                {this.renderToggle(
                                    nls.localize('vueport/debug/panels/objects/vFlip', 'V-flip'),
                                    nls.localize('vueport/debug/panels/objects/vertical', 'V'),
                                    object.vFlip,
                                    value => this.writeObject({ vFlip: value })
                                )}
                            </div>,
                            undefined,
                            3
                        )}
                    </div>
                    <div className='vp-grid-row'>
                        {stacked(
                            nls.localize('vueport/debug/panels/objects/eyes', 'Eyes'),
                            <div className='vp-flags-row'>
                                {this.renderToggle(
                                    nls.localize('vueport/debug/panels/objects/left', 'Left'),
                                    nls.localize('vueport/debug/panels/objects/leftShort', 'L'),
                                    object.lon,
                                    value => this.writeObject({ lon: value })
                                )}
                                {this.renderToggle(
                                    nls.localize('vueport/debug/panels/objects/right', 'Right'),
                                    nls.localize('vueport/debug/panels/objects/rightShort', 'R'),
                                    object.ron,
                                    value => this.writeObject({ ron: value })
                                )}
                            </div>,
                            undefined,
                            3
                        )}
                    </div>
                </div>
            </div>
        </fieldset>;
    }

    protected renderToggle(
        // `label` is the screen reader's name, the only full one where the drawn name is a letter (flips, eyes);
        // `hint` is the tooltip in its place
        label: string, name: string, value: boolean, onChange: (value: boolean) => void, hint?: string
    ): React.ReactNode {
        return <span className='vp-toggle' title={hint ?? label}>
            <Switch label={label} value={value} onChange={onChange} />
            <span>{name}</span>
        </span>;
    }

    // what VB Color adds: the CRAM palette, the OBJ Color Attribute (group, CHRSEL) and the OBJ Pixel Color Attribute
    // (PCE, OPQ, slot). Bits CXCTRL leaves without effect are still shown with a note, as a game setting CHRSEL before
    // CCEN is exactly what the user wants to find
    protected renderColorGroup(object: VipObject): React.ReactNode {
        const vbc = this.vbc;
        const color = this.selectedColor();
        if (!vbc || !color) {
            return undefined;
        }
        const own = decodeVcuColorAttr(color.colorByte);
        const pixel = decodeVcuPixelAttr(color.pixelHalfword);
        const character = color.character;
        // what draws: the Character's entries under CHRSEL with CCEN, the object's own otherwise
        const drawnPixel = character?.pixel ?? pixel;
        const first = color.palette * VCU_CRAM_PALETTE_SIZE;
        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/objects/vbColor', 'VB Color')}</legend>
            <div className='vp-detail-fields'>
                {field(
                    nls.localize('vueport/debug/panels/objects/cramPalette', 'CRAM Palette'),
                    <>
                        {color.palette}
                        <span className='vp-vcu-backdrop'>
                            {color.colors.map((entry, index) => {
                                const css = vcuRgb888(entry).css;
                                return <span
                                    key={index}
                                    className='vp-vcu-backdrop-swatch'
                                    style={{ backgroundColor: css }}
                                    title={`CRAM ${hex(first + index, 3)} · ${css}`}
                                />;
                            })}
                        </span>
                    </>,
                    nls.localize(
                        'vueport/debug/panels/objects/cramPaletteHint',
                        'The palette the object draws with: its palette group times four, plus JPLTS'
                    ) + (vbc.wcen
                        ? nls.localize(
                            'vueport/debug/panels/objects/cramPaletteWorldHint',
                            ', before the palette offset of the OBJ world that draws it (WCEN)'
                        )
                        : '')
                )}
                {character && field(
                    nls.localize('vueport/debug/panels/objects/characterGroup', 'Character Group'),
                    character.color.group,
                    nls.localize(
                        'vueport/debug/panels/objects/characterGroupHint',
                        'The palette group in effect: CHRSEL is set and CXCTRL.CCEN is on, so it is Character {0}\'s',
                        object.char
                    )
                )}
                {character && field(
                    nls.localize('vueport/debug/panels/objects/characterPixels', 'Character Pixels'),
                    [
                        character.pixel.enabled ? 'PCE' : undefined,
                        character.pixel.opaque ? 'OPQ' : undefined,
                        nls.localize('vueport/debug/panels/objects/slotNumber', 'Slot {0}', character.pixel.slot),
                    ].filter(part => part !== undefined).join(' · '),
                    nls.localize(
                        'vueport/debug/panels/objects/characterPixelsHint',
                        'The Pixel Color Attribute in effect: CHRSEL is set and CXCTRL.CCEN is on, so it is'
                        + ' Character {0}\'s',
                        object.char
                    )
                )}
            </div>
            <div className='vp-grid'>
                <div className='vp-grid-row'>
                    {stacked(
                        nls.localize('vueport/debug/panels/objects/group', 'Group'),
                        numberInput(own.group, 0, VCU_GROUP_MAX, value => this.writeObjectColor({ group: value })),
                        nls.localize(
                            'vueport/debug/panels/objects/groupFieldHint',
                            'OBJ Color Attribute bits 5-0: the palette group, four CRAM palettes'
                            + ' picked between by JPLTS'
                        )
                    )}
                    {stacked(
                        nls.localize('vueport/debug/panels/objects/slot', 'Slot'),
                        numberInput(pixel.slot, 0, VCU_PIXEL_SLOT_COUNT - 1,
                            value => this.writeObjectPixel({ slot: value })),
                        nls.localize(
                            'vueport/debug/panels/objects/slotHint',
                            'OBJ Pixel Color Attribute bits 9-0: the Pixel Color Slot PCE draws with'
                        ),
                        2
                    )}
                </div>
                <div className='vp-grid-row'>
                    {stacked(
                        nls.localize('vueport/debug/panels/objects/colorAttribute', 'Color Attribute'),
                        <div className='vp-flags-row'>
                            {this.renderToggle(
                                nls.localize(
                                    'vueport/debug/panels/objects/chrsel',
                                    'CHRSEL: palette and pixel attribute from the Character (with CCEN)'
                                ),
                                'CHRSEL',
                                own.chrsel,
                                value => this.writeObjectColor({ chrsel: value })
                            )}
                        </div>,
                        undefined,
                        3
                    )}
                </div>
                <div className='vp-grid-row'>
                    {stacked(
                        nls.localize('vueport/debug/panels/objects/pixelAttribute', 'Pixel Attribute'),
                        <div className='vp-flags-row'>
                            {this.renderToggle(
                                nls.localize(
                                    'vueport/debug/panels/objects/pce',
                                    'PCE: palettes per pixel from the Pixel Color Slot (with PCEN)'
                                ),
                                'PCE',
                                pixel.enabled,
                                value => this.writeObjectPixel({ enabled: value })
                            )}
                            {this.renderToggle(
                                nls.localize('vueport/debug/panels/objects/opq', 'OPQ: pixel value 0 is opaque'),
                                'OPQ',
                                pixel.opaque,
                                value => this.writeObjectPixel({ opaque: value })
                            )}
                        </div>,
                        undefined,
                        3
                    )}
                </div>
            </div>
            {own.chrsel && !vbc.ccen && <span className='hint'>{nls.localize(
                'vueport/debug/panels/objects/chrselOff',
                'CHRSEL is set, but CXCTRL.CCEN is off: the object\'s own group and pixel attribute draw it.'
            )}</span>}
            {drawnPixel.enabled && !vbc.pcen && <span className='hint'>{nls.localize(
                'vueport/debug/panels/objects/pceOff',
                'PCE is set, but CXCTRL.PCEN is off: no Pixel Color Slot is used.'
            )}</span>}
        </fieldset>;
    }

    protected renderDisplayControls(): React.ReactNode {
        const registers = this.registers;
        const groups = Array.from({ length: VIP_OBJECT_GROUP_COUNT }, (unused, group) => group);
        return <div className='vp-preview-controls'>
            <div className='vp-preview-controls-range'>
                <label>
                    <span>{nls.localize('vueport/debug/panels/objects/scale', 'Scale')}</span>
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
            {/* which eye, how much of the frame, which groups, as one row */}
            <div className='vp-preview-controls-row'>
                <RadioSelect
                    options={[{
                        value: 'left',
                        label: nls.localize('vueport/debug/panels/objects/leftEye', 'Left Eye'),
                    }, {
                        value: 'right',
                        label: nls.localize('vueport/debug/panels/objects/rightEye', 'Right Eye'),
                    }]}
                    defaultValue={this.eye}
                    onChange={options => this.setEye(options[0].value as VipEye)}
                />
                <RadioSelect
                    options={[{
                        value: 'context',
                        label: nls.localize('vueport/debug/panels/objects/inContext', 'In Context'),
                        tooltip: this.inColor()
                            ? nls.localize(
                                'vueport/debug/panels/objects/inContextColorHint',
                                'Every world the VIP draws, in its own order, with the objects in color and the rest'
                                + ' dimmed'
                            )
                            : nls.localize(
                                'vueport/debug/panels/objects/inContextHint',
                                'Every world the VIP draws, in its own order, with the objects in red and the rest gray'
                            ),
                    }, {
                        value: 'solo',
                        label: nls.localize('vueport/debug/panels/objects/solo', 'Solo'),
                        tooltip: nls.localize(
                            'vueport/debug/panels/objects/soloHint',
                            'The selected object on its own, drawn whether or not the hardware would draw it'
                        ),
                    }]}
                    defaultValue={this.previewMode}
                    onChange={options => this.setPreviewMode(options[0].value as ObjectPreviewMode)}
                />
                {/* beside In Context, where a group the filter leaves out shows grayed. Any number can be on, or none */}
                <RadioSelect
                    options={groups.map(group => {
                        const range = registers && vipObjectGroupRange(registers, group);
                        return {
                            value: group,
                            label: `SPT${group}`,
                            tooltip: range
                                ? nls.localize(
                                    'vueport/debug/panels/objects/groupHint',
                                    'Group {0}, objects {1} to {2}',
                                    group, range.first, range.last
                                )
                                : nls.localize(
                                    'vueport/debug/panels/objects/groupEmptyHint',
                                    'Group {0}, which the SPT registers leave empty',
                                    group
                                ),
                        };
                    })}
                    defaultValue={groups.filter(group => (this.groupFilter & 1 << group) !== 0)}
                    onChange={options => this.setGroupFilter(options.map(option => option.value as number))}
                    canSelectMany
                    allowBlank
                />
            </div>
            <div className='vp-preview-controls-switches'>
                {/* only while a VB Color game has the VCU unlocked */}
                {this.vbc && this.renderToggle(
                    nls.localize('vueport/debug/panels/objects/vbColorPreview', 'Colorized'),
                    nls.localize('vueport/debug/panels/objects/vbColorPreview', 'Colorized'),
                    this.vbColorPreview,
                    value => this.setVbColorPreview(value),
                    nls.localize(
                        'vueport/debug/panels/objects/vbColorPreviewHint',
                        'Draw in the colors the VB Color shows rather than the VIP\'s red'
                    )
                )}
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/objects/genericPalette', 'Generic Palette'),
                    nls.localize('vueport/debug/panels/objects/genericPalette', 'Generic Palette'),
                    this.showGenericPalette,
                    value => this.setShowGenericPalette(value)
                )}
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/objects/showOnlyDrawn', 'Show Only Drawn'),
                    nls.localize('vueport/debug/panels/objects/showOnlyDrawn', 'Show Only Drawn'),
                    this.showOnlyDrawn,
                    value => this.setShowOnlyDrawn(value)
                )}
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/objects/showOutline', 'Show Outline'),
                    nls.localize('vueport/debug/panels/objects/showOutline', 'Show Outline'),
                    this.showExtents,
                    value => { this.showExtents = this.remember('showExtents', value); this.update(); }
                )}
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/objects/onlyFigure', 'Only Current Figure'),
                    nls.localize('vueport/debug/panels/objects/onlyFigure', 'Only Current Figure'),
                    this.onlyFigure,
                    value => this.setOnlyFigure(value)
                )}
            </div>
            {this.exportFile &&
                <div className='vp-preview-controls-row'>
                    <button
                        type='button'
                        className='vp-button secondary'
                        disabled={!this.figure()}
                        title={this.figure()
                            ? nls.localize(
                                'vueport/debug/panels/objects/exportFigureHint',
                                'Save the selected object\'s figure as a PNG, cut to its size'
                                + ' and transparent around it')
                            : nls.localize(
                                'vueport/debug/panels/objects/exportFigureNone',
                                'The selected object is not part of a figure of more than one object')}
                        onClick={() => { this.exportFigure().catch(() => undefined); }}
                    >
                        {nls.localize('vueport/debug/panels/objects/exportFigure', 'Export Figure')}
                    </button>
                </div>
            }
        </div>;
    }

    // the counterpart of the BGMaps panel's Used by: hovering outlines a figure in the preview, a click picks it.
    // Groups the SPT filter leaves out are left out here too
    protected renderFiguresGroup(): React.ReactNode {
        const current = new Set(this.figure()?.objects ?? []);
        const figures = this.figures.filter(entry =>
            entry.group === undefined || (this.groupFilter & 1 << entry.group) !== 0);
        return <fieldset
            className='vp-inspector-group vp-grows vp-objects-figures'
            onClick={event => this.onFiguresClick(event)}
        >
            <legend>{nls.localize('vueport/debug/panels/objects/figures', 'Figures')}</legend>
            <div className='vp-scroll-body vp-scroll'>
                {figures.length === 0
                    ? <span className='hint'>{nls.localize(
                        'vueport/debug/panels/objects/noFigures',
                        'No figures of more than one object are being drawn.'
                    )}</span>
                    : figures.map(({ cluster, group, image }) => {
                        const first = cluster.objects[0];
                        const selected = current.has(first);
                        return <button
                            type='button'
                            key={first}
                            className={'vp-used-by-world vp-objects-figure' + (selected ? ' selected' : '')}
                            aria-pressed={selected}
                            title={nls.localize(
                                'vueport/debug/panels/objects/figuresHint',
                                'Select this figure'
                            )}
                            onMouseEnter={() => this.setHoveredFigure(first)}
                            onMouseLeave={() => this.setHoveredFigure(undefined)}
                            onClick={() => this.selectFigure(cluster)}
                        >
                            <span className='vp-detail-field'>
                                <span className='label'>
                                    {`${first}\u2013${cluster.objects[cluster.objects.length - 1]}`}
                                    {group !== undefined && <span className='hint'>{`SPT${group}`}</span>}
                                </span>
                                <span className='value'>{nls.localize(
                                    'vueport/debug/panels/objects/figureCount',
                                    '{0} objects',
                                    cluster.objects.length
                                )}</span>
                            </span>
                            <VipCanvas image={image} zoom={figurePreviewZoom(image)} />
                        </button>;
                    })
                }
            </div>
        </fieldset>;
    }

    // how many objects the selected one's figure has, and from which stretch of OAM. A guess, as the hint says: the
    // hardware has no notion of a figure (see vipObjectClusters)
    protected renderFigureField(): React.ReactNode {
        const figure = this.figure();
        const objects = figure?.objects;
        return field(
            nls.localize('vueport/debug/panels/objects/figure', 'Figure'),
            objects
                ? nls.localize(
                    'vueport/debug/panels/objects/figureObjects',
                    '{0} objects, {1}\u2013{2}',
                    objects.length, objects[0], objects[objects.length - 1]
                )
                : '\u2013',
            nls.localize(
                'vueport/debug/panels/objects/figureHint',
                'The objects that most likely make up one figure with this one: drawn to the same eyes,'
                + ' at about the same depth, touching on screen and written as one run of OAM'
            )
        );
    }

    protected renderPreview(object: VipObject): React.ReactNode {
        const hovered = this.hoveredFigure === undefined
            ? undefined
            : vipObjectClusterOf(this.clusters, this.hoveredFigure);
        const figure = hovered ?? this.figure();
        return <div className='vp-preview vp-preview-with-controls'>
            <div className='vp-preview-view vp-scroll'>
                {this.image &&
                    <VipCanvas
                        image={this.image}
                        zoom={this.zoom}
                        extents={this.showExtents ? vipObjectExtents(object, this.eye) : undefined}
                        around={(this.showExtents || hovered) && figure ? figure : undefined}
                    />
                }
            </div>
            {this.renderDisplayControls()}
        </div>;
    }
}
