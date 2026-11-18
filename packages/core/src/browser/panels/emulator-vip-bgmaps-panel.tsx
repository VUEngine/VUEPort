import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import { ScreenInspectorTarget } from './emulator-screen-inspector';
import { arrowKeysTaken, hex, DebugSource, Panel, EmulatorPanelType, scrollIntoViewSmoothly } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { field, numberInput, stacked } from './emulator-vip-detail';
import { exportVipImage, VipCanvas, VipExportFile } from './emulator-vip-canvas';
import { Sim } from '../core/vb-core';
import {
    decodeVipBgMapCell,
    decodeVipWorld,
    drawVipChar,
    encodeVipBgMapCell,
    forEachVipWorldPixel,
    sameVipBytes,
    VIP_BGMAP_BYTES,
    VIP_BGMAP_BASE,
    VIP_BGMAP_CELLS,
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
    VIP_REGISTER_BASE,
    VIP_REGISTER_BLOCK_BYTES,
    VIP_WORLD_BASE,
    VIP_WORLD_BLOCK_BYTES,
    VIP_WORLD_BYTES,
    VIP_WORLD_COUNT,
    VIP_WORLD_MODE_NAMES,
    vipBgMapAddress,
    VipBgMapCell,
    VipBgMapSegmentUse,
    vipBgMapSegmentUses,
    vipCharSegmentAddress,
    vipCharSegmentCount,
    vipWorldSourceExtents,
    VipCharacters,
    VipEye,
    vipIntensitiesForRegister,
    VipIntensityWatcher,
    vipParamTableAddress,
    vipParamTableBytes,
    VipWorld,
    VipWorldMap,
    VipWorldMode,
    vipWorldSample,
    vipWorldSegments,
    vipOverplaneSegment,
} from './emulator-vip-memory';
import { VcuColors, VcuPlacement, vcuPlacement, vipShade } from './emulator-vcu-colors';
import {
    decodeVcuColorAttr,
    decodeVcuPixelAttr,
    encodeVcuColorAttr,
    encodeVcuPixelAttr,
    readVbcState,
    vbcCharMask,
    VbcState,
    VCU_CELL_COLOR_BASE,
    VCU_CELL_PIXEL_ATTR_BASE,
    VCU_CHARACTER_COLOR_BASE,
    VCU_CHARACTER_PIXEL_ATTR_BASE,
    VCU_CRAM_BASE,
    VCU_CRAM_BYTES,
    VCU_CRAM_ENTRY_BYTES,
    VCU_CRAM_PALETTE_SIZE,
    VCU_PIXEL_SLOT_COUNT,
    VcuColorAttr,
    vcuPlacementPalette,
    VcuPixelAttr,
    vcuRgb888,
} from './emulator-vcu-memory';
import EmptyContainer from '../components/kit/EmptyContainer';
import { Plug, Warning } from '@phosphor-icons/react';
import Select from '../components/kit/Select';
import Switch from '../components/kit/Switch';

// 8 source pixels at 27 is the 216-pixel preview the sidebar holds, the same as in the Objects and Characters panels
const PREVIEW_ZOOM = 27;

// scaled to fit rather than stretched, as a world with the wrong proportions no longer shows where anything is;
// the Characters panel sizes the maps in its Used by the same way
const WORLD_PREVIEW_WIDTH = 208;
const WORLD_PREVIEW_MAX_HEIGHT = 192;

// previews are of one eye; the parallax between them is not the point here
const PREVIEW_EYE: VipEye = 'left';

// how far the parts of a world from other segments are faded in its preview, the same factor as in the Worlds and
// Characters panels. In VB Color they keep their colors and are only darkened
const OTHER_SEGMENT_FACTOR = 0.18;

const SEGMENT_CELLS = VIP_BGMAP_CELLS * VIP_BGMAP_CELLS;

const VCU_GROUP_MAX = 0x3f;

function putBlank(target: Uint8ClampedArray, offset: number): void {
    target[offset] = 0;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 255;
}

function putTransparent(target: Uint8ClampedArray, offset: number): void {
    target[offset] = 0;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 0;
}

function worldPreviewZoom(image: ImageData): number {
    return Math.min(WORLD_PREVIEW_WIDTH / image.width, WORLD_PREVIEW_MAX_HEIGHT / image.height);
}

interface UsedByWorld {
    index: number;
    mode: string;
    // Map, Params, or both
    takes: string;
    image?: ImageData;
}

/**
 * The fourteen BGMap segments, with the selected one rasterized as one 512x512 bitmap beside its fields, which inspect
 * one cell at a time and edit its character, palette and flips. Three columns like the Worlds panel. Each refresh reads
 * the segment's cells and the characters they reference, re-rasterizing only on change (as in the Characters panel).
 * World attribute memory is read too, as a segment's use is a fact about the worlds.
 */
export class BgMapsPanel extends Panel {

    protected error?: string;
    protected registers?: DataView;
    protected charSegments: (Uint8Array | undefined)[] = [];
    protected cells?: Uint8Array;
    // the segment being shown, and those the Used by previews read from
    protected bgMapSegments: (Uint8Array | undefined)[] = [];
    // indexed by world
    protected paramTables: (Uint8Array | undefined)[] = [];
    protected usedBy: UsedByWorld[] = [];
    protected worldBytes?: Uint8Array;
    // only while a VB Color game has unlocked the VCU, see readVbcState
    protected vbc?: VbcState;
    // the shown segment's Cell Color and Cell Pixel Color Attributes plus CRAM, read only with vbc, for the selected
    // cell's color group. The pictures go by `colors`, so these don't mark dirty
    protected cellColors?: Uint8Array;
    protected cellPixelAttrs?: DataView;
    protected cram?: DataView;
    // the selected cell's character's Color Attribute byte and Pixel Color Attribute halfword, which replace the cell's
    // own under CHRSEL and CCEN. Tagged with the character, so a stale selection isn't shown
    protected characterColor?: { char: number, color: number, pixel: number };
    protected segment = 0;
    protected selected = 0;
    protected zoom = this.remembered('zoom', 1);
    protected showGrid = this.remembered('showGrid', false);
    // on, the even ramp shows the tile data itself; off, the previews resolve the brightness registers as the core
    // does, so they look like the screen
    protected showGenericPalette = this.remembered('showGenericPalette', true);
    // on by default, but only in effect while the game has switched color on (see colorMode)
    protected vbColorPreview = this.remembered('vbColorPreview', true);
    // the VCU tables, read only in color mode and for the segments drawn, see readPreviewColors
    protected colors?: VcuColors;
    // the world whose read area is outlined: the hovered one in Used by, or the one pinned by a click. Both are dropped
    // when another segment is picked, as the outline is about the map shown
    protected hoveredWorld?: number;
    protected pinnedWorld?: number;

    protected image?: ImageData;
    protected dirty = true;
    protected readonly intensityWatcher = new VipIntensityWatcher();

    constructor(
        source: DebugSource,
        instanceId: string,
        // where Export PNG hands its file; no button without it
        protected readonly exportFile?: VipExportFile
    ) {
        super(EmulatorPanelType.VIP_BGMAPS, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/bgmaps/title', 'BGMaps');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.VIP_BGMAPS);
        // the three columns scroll on their own, so the panel's scrolling is off and the layout hangs on this class,
        // which the Worlds panel wears too
        this.addClass('vp-vip-panel');
    }

    protected pollHz(): number {
        return VIP_GRAPHICS_POLL_HZ;
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.registers = undefined;
            this.charSegments = [];
            this.cells = undefined;
            this.bgMapSegments = [];
            this.paramTables = [];
            this.worldBytes = undefined;
            this.usedBy = [];
            this.image = undefined;
            this.vbc = undefined;
            this.colors = undefined;
            this.clearColors();
            this.update();
            return;
        }

        try {
            this.registers = new DataView(await sim.readMemory(VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES));
            this.vbc = await readVbcState(this.source, sim);

            // with CHREXT a cell can name the extension's characters too, so its four segments are read after the
            // VIP's, and dropped again with the twelve-bit mask when the game switches it off
            const count = vipCharSegmentCount(this.vbc?.chrext ?? false);
            if (this.charSegments.length !== count) {
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

            const worldBytes = new Uint8Array(await sim.readMemory(VIP_WORLD_BASE, VIP_WORLD_BLOCK_BYTES));
            // the map itself does not depend on the worlds; this flag moves the Used by list
            const worldsMoved = !sameVipBytes(worldBytes, this.worldBytes);
            this.worldBytes = worldBytes;

            const mapSegments = await this.readMaps(sim);
            await this.readColors(sim);
            await this.readPreviewColors(sim, mapSegments);

            if (this.intensityWatcher.changed(this.registers)) {
                this.dirty = true;
            }
            this.error = undefined;

            if (this.dirty || worldsMoved) {
                this.usedBy = this.buildUsedBy(this.registers);
            }
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }

        if (this.dirty && this.registers) {
            this.image = this.rasterize(this.registers);
            this.dirty = false;
        }
        this.update();
    }

    // the shown segment plus the maps and param tables of the worlds under Used by, whose maps can span other segments.
    // Still only what the list needs, rather than all fourteen every poll
    protected async readMaps(sim: Sim): Promise<number[]> {
        const worlds = this.usedByWorlds();
        const needed = [...new Set([
            this.segment,
            ...worlds.flatMap(world => vipWorldSegments(world)),
        ])];

        const maps = await Promise.all(needed.map(
            segment => sim.readMemory(vipBgMapAddress(segment), VIP_BGMAP_BYTES)));
        const segments: (Uint8Array | undefined)[] = [];
        needed.forEach((segment, index) => {
            const bytes = new Uint8Array(maps[index]);
            if (!sameVipBytes(bytes, this.bgMapSegments[segment])) {
                this.dirty = true;
            }
            segments[segment] = bytes;
        });
        this.bgMapSegments = segments;
        this.cells = segments[this.segment];

        const tables: (Uint8Array | undefined)[] = [];
        await Promise.all(worlds.map(async world => {
            const length = vipParamTableBytes(world);
            if (length > 0) {
                tables[world.index] = new Uint8Array(
                    await sim.readMemory(vipParamTableAddress(world.param), length));
            }
        }));
        this.paramTables = tables;
        return needed;
    }

    // the option is on and the game has switched color on
    protected colorMode(): boolean {
        return !!this.vbc && this.vbColorPreview;
    }

    // for the segments drawn, plus those holding the overplane cells of Used by worlds, whose Color Attributes the
    // core takes from there. Redrawn only on change; leaving color mode drops the tables and redraws in red
    protected async readPreviewColors(sim: Sim, segments: number[]): Promise<void> {
        if (!this.vbc || !this.colorMode()) {
            if (this.colors) {
                this.colors = undefined;
                this.dirty = true;
            }
            return;
        }
        const overplanes = this.usedByWorlds()
            .filter(world => world.overplane)
            .map(world => vipOverplaneSegment(world));
        const colors = await VcuColors.read(sim, this.vbc, { segments: [...segments, ...overplanes], worlds: true });
        if (!colors.same(this.colors)) {
            this.dirty = true;
        }
        this.colors = colors;
    }

    // the whole segment's entries, like the cells, so walking the map shows each cell's at once; with CRAM that is
    // 16 KiB a poll, and nothing on a game that has not switched color on
    protected async readColors(sim: Sim): Promise<void> {
        if (!this.vbc) {
            this.clearColors();
            return;
        }
        const first = this.segment * SEGMENT_CELLS;
        const [colors, pixels, cram] = await Promise.all([
            sim.readMemory(VCU_CELL_COLOR_BASE + first, SEGMENT_CELLS),
            sim.readMemory(VCU_CELL_PIXEL_ATTR_BASE + first * 2, SEGMENT_CELLS * 2),
            sim.readMemory(VCU_CRAM_BASE, VCU_CRAM_BYTES),
        ]);
        this.cellColors = new Uint8Array(colors);
        this.cellPixelAttrs = new DataView(pixels);
        this.cram = new DataView(cram);
        await this.readCharacterColor(sim);
    }

    protected clearColors(): void {
        this.cellColors = undefined;
        this.cellPixelAttrs = undefined;
        this.cram = undefined;
        this.characterColor = undefined;
    }

    // only when they are what the cell is drawn with (CHRSEL set and CCEN on), as nothing here shows them otherwise
    protected async readCharacterColor(sim: Sim): Promise<void> {
        const cells = this.cells;
        const colors = this.cellColors;
        if (!this.vbc?.ccen || !cells || !colors || !decodeVcuColorAttr(colors[this.selected]).chrsel) {
            this.characterColor = undefined;
            return;
        }
        const view = new DataView(cells.buffer, cells.byteOffset, cells.byteLength);
        const char = decodeVipBgMapCell(view.getUint16(this.selected * 2, true), this.charMask()).char;
        // byte 0 of a character's pair is its Cell palette, byte 1 its OBJ one; the Pixel Color Attribute is one
        // halfword for both
        const [color, pixel] = await Promise.all([
            sim.readMemory(VCU_CHARACTER_COLOR_BASE + char * 2, 1),
            sim.readMemory(VCU_CHARACTER_PIXEL_ATTR_BASE + char * 2, 2),
        ]);
        this.characterColor = {
            char,
            color: new Uint8Array(color)[0],
            pixel: new DataView(pixel).getUint16(0, true),
        };
    }

    protected charMask(): number {
        return vbcCharMask(this.vbc);
    }

    protected charCount(): number {
        return this.vbc?.chrext ? VIP_CHAR_COUNT_EXTENDED : VIP_CHAR_COUNT;
    }

    protected setSegment(segment: number): void {
        if (Number.isNaN(segment)) {
            return;
        }
        this.segment = Math.min(VIP_BGMAP_COUNT - 1, Math.max(0, segment));
        // the outline was about the map being left behind
        this.hoveredWorld = undefined;
        this.pinnedWorld = undefined;
        // the selected cell index stays valid across segments (every map is 64x64), so the same position can be
        // compared
        this.dirty = true;
        this.refresh();
    }

    reveal(target: ScreenInspectorTarget): void {
        if (target.kind !== 'cell') {
            return;
        }
        const index = (target.address - VIP_BGMAP_BASE) >> 1;
        const cells = VIP_BGMAP_CELLS * VIP_BGMAP_CELLS;
        this.setSegment(Math.floor(index / cells));
        this.selectCell(index % cells);
        this.whenRendered(() => {
            const selection = this.node.querySelector('.vp-canvas-selection');
            if (selection) {
                scrollIntoViewSmoothly(selection, 'center', 'center');
            }
        });
    }

    protected selectCell(cell: number): void {
        if (Number.isNaN(cell)) {
            return;
        }
        const count = VIP_BGMAP_CELLS * VIP_BGMAP_CELLS;
        this.selected = Math.min(count - 1, Math.max(0, cell));
        this.update();
        // the character's color entries belong to the selected cell rather than the segment, so they are fetched now
        // instead of at the next poll
        const sim = this.source.sim;
        if (sim && this.vbc?.ccen) {
            this.readCharacterColor(sim).then(() => this.update(), () => undefined);
        }
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

    // callers clamp char to a valid character index; palette and flips come from a bounded dropdown and checkboxes
    protected async writeCell(patch: Partial<VipBgMapCell>): Promise<void> {
        const sim = this.source.sim;
        const cells = this.cells;
        if (!sim || !cells) {
            return;
        }

        const offset = this.selected * 2;
        const view = new DataView(cells.buffer, cells.byteOffset, cells.byteLength);
        const current = decodeVipBgMapCell(view.getUint16(offset, true), this.charMask());
        const raw = encodeVipBgMapCell({ ...current, ...patch }, this.charMask());

        await this.source.write(vipBgMapAddress(this.segment) + offset, [raw & 0xff, raw >> 8]);

        this.dirty = true;
        await this.refresh();
    }

    // keeps the undocumented bit 6 as it was
    protected async writeColorAttr(patch: Partial<VcuColorAttr>): Promise<void> {
        const colors = this.cellColors;
        if (!this.source.sim || !colors) {
            return;
        }
        const previous = colors[this.selected];
        const raw = encodeVcuColorAttr({ ...decodeVcuColorAttr(previous), ...patch }, previous);
        await this.source.write(VCU_CELL_COLOR_BASE + this.segment * SEGMENT_CELLS + this.selected, [raw]);
        await this.refresh();
    }

    protected async writePixelAttr(patch: Partial<VcuPixelAttr>): Promise<void> {
        const pixels = this.cellPixelAttrs;
        if (!this.source.sim || !pixels) {
            return;
        }
        const previous = pixels.getUint16(this.selected * 2, true);
        const raw = encodeVcuPixelAttr({ ...decodeVcuPixelAttr(previous), ...patch }, previous);
        await this.source.write(
            VCU_CELL_PIXEL_ATTR_BASE + (this.segment * SEGMENT_CELLS + this.selected) * 2,
            [raw & 0xff, raw >> 8]
        );
        await this.refresh();
    }

    protected palettes(registers: DataView): number[][] {
        return this.showGenericPalette
            ? [0, 1, 2, 3].map(() => VIP_GENERIC_PALETTE_INTENSITIES)
            : VIP_BGMAP_PALETTES.map(register => vipIntensitiesForRegister(registers, register));
    }

    // the shade each BGMap palette gives each pixel value: the two bits of its GPLT register the value picks, i.e. the
    // CRAM entry within the cell's palette, or with the generic palette the value itself
    protected shades(registers: DataView): number[][] {
        return VIP_BGMAP_PALETTES.map(register => {
            const byte = registers.getUint16(register, true) & 0xff;
            return [0, 1, 2, 3].map(value => this.showGenericPalette ? value : vipShade(byte, value));
        });
    }

    // nothing while the pictures are red
    protected previewColors(): VcuColors | undefined {
        return this.colorMode() ? this.colors : undefined;
    }

    // flipped like drawVipChar, with a pixel the hardware leaves out transparent like pixel value 0
    protected drawColorChar(
        target: Uint8ClampedArray, targetWidth: number, destX: number, destY: number,
        characters: VipCharacters, colors: VcuColors, placement: VcuPlacement,
        cell: VipBgMapCell, shades: number[][]
    ): void {
        for (let y = 0; y < VIP_CHAR_SIZE; y++) {
            for (let x = 0; x < VIP_CHAR_SIZE; x++) {
                // unflipped, as a Pixel Color Slot is laid out in the character's own coordinates
                const charX = cell.hFlip ? VIP_CHAR_SIZE - 1 - x : x;
                const charY = cell.vFlip ? VIP_CHAR_SIZE - 1 - y : y;
                const value = characters.pixel(cell.char, charX, charY);
                const offset = ((destY + y) * targetWidth + destX + x) * 4;
                if (!colors.put(target, offset, placement, value, charX, charY, shades[cell.palette][value])) {
                    putTransparent(target, offset);
                }
            }
        }
    }

    protected rasterize(registers: DataView): ImageData | undefined {
        const cells = this.cells;
        if (!cells || this.charSegments.length === 0) {
            return undefined;
        }
        const characters = new VipCharacters(this.charSegments);
        const palettes = this.palettes(registers);
        const colors = this.previewColors();
        const shades = this.shades(registers);
        const placement = vcuPlacement();
        const size = VIP_BGMAP_CELLS * VIP_CHAR_SIZE;
        const pixels = new Uint8ClampedArray(size * size * 4);
        const view = new DataView(cells.buffer, cells.byteOffset, cells.byteLength);

        for (let row = 0; row < VIP_BGMAP_CELLS; row++) {
            for (let column = 0; column < VIP_BGMAP_CELLS; column++) {
                const index = row * VIP_BGMAP_CELLS + column;
                const cell = decodeVipBgMapCell(view.getUint16(index * 2, true), characters.charMask);
                if (colors) {
                    colors.cell(this.segment, index, cell.char, cell.palette, placement);
                    this.drawColorChar(
                        pixels, size, column * VIP_CHAR_SIZE, row * VIP_CHAR_SIZE,
                        characters, colors, placement, cell, shades
                    );
                    continue;
                }
                drawVipChar(
                    pixels,
                    size,
                    column * VIP_CHAR_SIZE,
                    row * VIP_CHAR_SIZE,
                    characters,
                    cell.char,
                    palettes[cell.palette],
                    cell.hFlip,
                    cell.vFlip,
                    true
                );
            }
        }
        return new ImageData(pixels, size, size);
    }

    // which worlds read their map from each segment and whose param table sits in it; a segment under neither is free
    protected segmentUses(): VipBgMapSegmentUse[] {
        return vipBgMapSegmentUses(this.worlds());
    }

    protected worlds(): VipWorld[] {
        const bytes = this.worldBytes;
        if (!bytes) {
            return [];
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: VIP_WORLD_COUNT }, (unused, index) =>
            decodeVipWorld(view, index, index * VIP_WORLD_BYTES));
    }

    protected usedByWorlds(): VipWorld[] {
        const use = this.segmentUses()[this.segment];
        if (!use) {
            return [];
        }
        const listed = new Set([...use.worlds, ...use.params]);
        return this.worlds()
            .filter(world => listed.has(world.index))
            .sort((a, b) => b.index - a.index);
    }

    // a line per world with a picture of what it draws, this segment's pixels picked out. Rebuilt here rather than in
    // render, as hovering the list re-renders and these are rasterized
    protected buildUsedBy(registers: DataView): UsedByWorld[] {
        const use = this.segmentUses()[this.segment] ?? { worlds: [], params: [] };
        return this.usedByWorlds().map(world => ({
            index: world.index,
            mode: VIP_WORLD_MODE_NAMES[world.mode],
            takes: [
                use.worlds.includes(world.index) && nls.localize('vueport/debug/panels/bgmaps/asMap', 'Map'),
                use.params.includes(world.index) && nls.localize('vueport/debug/panels/bgmaps/asParams', 'Params'),
            ].filter(Boolean).join(', '),
            image: this.drawWorldPreview(registers, world),
        }));
    }

    /**
     * One world as drawn: this segment's part in red, its other segments faded gray (in VB Color, its colors with the
     * rest darkened). It is the world's own W+1 by H+1 window onto its map from MX/MY, shifted per row by its param
     * table; only GX, GY and GP, which place it on screen, are dropped. Follows the Characters panel's Used by.
     */
    protected drawWorldPreview(registers: DataView, world: VipWorld): ImageData | undefined {
        const width = Math.min(world.w + 1, VIP_FRAME_BUFFER_WIDTH);
        const height = Math.min(world.h + 1, VIP_FRAME_BUFFER_HEIGHT);
        if (world.mode === VipWorldMode.OBJECT || width <= 0 || height <= 0) {
            return undefined;
        }
        // drawn no finer than shown, as sampling every second pixel is less work than drawing pixels the browser throws
        // away
        const stride = Math.max(1, Math.ceil(width / WORLD_PREVIEW_WIDTH));
        const previewWidth = Math.ceil(width / stride);
        const previewHeight = Math.ceil(height / stride);
        const pixels = new Uint8ClampedArray(previewWidth * previewHeight * 4);

        const map = new VipWorldMap(world, this.bgMapSegments, new VipCharacters(this.charSegments));
        const palettes = this.palettes(registers);
        const params = this.paramTables[world.index];
        const view = params && new DataView(params.buffer, params.byteOffset, params.byteLength);
        const colors = this.previewColors();
        const shades = this.shades(registers);
        const worldOffset = colors?.worldOffset(world.index) ?? 0;
        // reused, so drawing a world does not allocate per pixel
        const sample = vipWorldSample();
        const placement = vcuPlacement();
        forEachVipWorldPixel(
            { ...world, gx: 0, gy: 0, gp: 0 }, width, height, PREVIEW_EYE, view,
            (x, y, sourceX, sourceY) => {
                if (x % stride !== 0 || y % stride !== 0) {
                    return;
                }
                const offset = ((y / stride) * previewWidth + x / stride) * 4;
                if (colors) {
                    map.sample(sourceX, sourceY, sample);
                    colors.cell(
                        sample.segment, sample.cell, sample.char, sample.palette, placement);
                    const shade = shades[sample.palette][sample.value];
                    if (!colors.put(
                        pixels, offset, placement, sample.value, sample.charX, sample.charY, shade, worldOffset
                    )) {
                        putBlank(pixels, offset);
                    } else if (map.segmentAt(sourceX, sourceY) !== this.segment) {
                        pixels[offset] = Math.round(pixels[offset] * OTHER_SEGMENT_FACTOR);
                        pixels[offset + 1] = Math.round(pixels[offset + 1] * OTHER_SEGMENT_FACTOR);
                        pixels[offset + 2] = Math.round(pixels[offset + 2] * OTHER_SEGMENT_FACTOR);
                    }
                    return;
                }
                const intensity = map.intensity(sourceX, sourceY, palettes);
                if (map.segmentAt(sourceX, sourceY) === this.segment) {
                    // red, the color the hardware emits, for this segment's part, the subject here
                    pixels[offset] = intensity;
                } else {
                    const gray = Math.round(intensity * OTHER_SEGMENT_FACTOR);
                    pixels[offset] = gray;
                    pixels[offset + 1] = gray;
                    pixels[offset + 2] = gray;
                }
                pixels[offset + 3] = 255;
            }
        );
        return new ImageData(pixels, previewWidth, previewHeight);
    }

    protected hoveredExtents(): { x: number, y: number, width: number, height: number } | undefined {
        const world = this.worlds()[this.hoveredWorld ?? this.pinnedWorld ?? -1];
        return world && vipWorldSourceExtents(world, this.segment);
    }

    protected setHoveredWorld(index: number | undefined): void {
        if (this.hoveredWorld !== index) {
            this.hoveredWorld = index;
            this.update();
        }
    }

    protected togglePinnedWorld(index: number): void {
        this.pinnedWorld = this.pinnedWorld === index ? undefined : index;
        this.update();
    }

    // a click between or under the worlds lets go of the pinned one, as a second click on it does
    protected onUsedByClick(event: React.MouseEvent): void {
        if (this.pinnedWorld !== undefined && !(event.target as Element).closest('button')) {
            this.pinnedWorld = undefined;
            this.update();
        }
    }

    // segment number and reading worlds on one line, address and param use under them. In a column of its own, so
    // stepping to the next segment doesn't scroll the one being read away
    protected renderTiles(uses: VipBgMapSegmentUse[]): React.ReactNode {
        // focusable in its own right: the panel's arrow keys walk the map's cells, in here they walk the segments
        return <div
            className='vp-tiles vp-scroll'
            tabIndex={0}
            aria-label={nls.localize('vueport/debug/panels/bgmaps/title', 'BGMaps')}
            onKeyDown={event => this.onTilesKey(event)}
        >
            {uses.map((use, segment) => {
                const used = use.worlds.length > 0 || use.params.length > 0;
                return <button
                    type='button'
                    key={segment}
                    className={`vp-tile${used ? '' : ' inactive'}`
                        + `${segment === this.segment ? ' selected' : ''}`}
                    aria-pressed={segment === this.segment}
                    tabIndex={-1}
                    title={BgMapsPanel.segmentTitle(use)}
                    onClick={() => this.setSegment(segment)}
                >
                    <span className='vp-tile-index'>{segment}</span>
                    <span className='vp-tile-mark'>{use.worlds.length || '\u2013'}</span>
                    <span className='vp-tile-note vp-bgmaps-tile-address'>
                        {hex(vipBgMapAddress(segment), 8)}
                    </span>
                    {use.params.length > 0 &&
                        <span className='vp-tile-flag'>
                            {nls.localize('vueport/debug/panels/bgmaps/params', 'Params')}
                        </span>
                    }
                </button>;
            })}
        </div>;
    }

    protected static segmentTitle(use: VipBgMapSegmentUse): string | undefined {
        const lines = [];
        if (use.worlds.length) {
            lines.push(nls.localize(
                'vueport/debug/panels/bgmaps/segmentWorldsHint', 'Worlds whose map this segment is part of'
            ) + `: ${use.worlds.join(', ')}`);
        }
        if (use.params.length) {
            lines.push(nls.localize(
                'vueport/debug/panels/bgmaps/segmentParamsHint', 'Worlds whose param table this segment holds'
            ) + `: ${use.params.join(', ')}`);
        }
        return lines.length ? lines.join('\n') : undefined;
    }

    // stopped, not only defaulted, as the emulator listens for keys around this panel and would move the game
    protected onTilesKey(event: React.KeyboardEvent): void {
        const steps: Record<string, number> = {
            ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1,
        };
        const step = steps[event.key];
        const home = event.key === 'Home';
        const end = event.key === 'End';
        if (step === undefined && !home && !end) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.setSegment(home ? 0 : end ? VIP_BGMAP_COUNT - 1 : this.segment + step);
        this.revealSegment();
    }

    protected onPanelKey(event: React.KeyboardEvent): void {
        if (arrowKeysTaken(event.target, event.currentTarget)) {
            return;
        }
        const steps: Record<string, number> = {
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -VIP_BGMAP_CELLS,
            ArrowDown: VIP_BGMAP_CELLS,
            PageUp: -VIP_BGMAP_CELLS * 8,
            PageDown: VIP_BGMAP_CELLS * 8,
        };
        const step = steps[event.key];
        const home = event.key === 'Home';
        const end = event.key === 'End';
        if (step === undefined && !home && !end) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const cells = VIP_BGMAP_CELLS * VIP_BGMAP_CELLS;
        this.selectCell(home ? 0 : end ? cells - 1 : this.selected + step);
        this.revealCell();
    }

    protected revealSegment(): void {
        this.whenRendered(() => {
            const tile = this.node.querySelector<HTMLElement>('.vp-tile.selected');
            tile?.scrollIntoView({ block: 'nearest' });
            tile?.focus({ preventScroll: true });
        });
    }

    protected revealCell(): void {
        this.whenRendered(() => this.node
            .querySelector('.vp-canvas-selection')
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }

    // for the sidebar preview, in the colors its cell gives it in color mode, CHRSEL and slot included
    protected rasterizePreview(registers: DataView, characters: VipCharacters, cell: VipBgMapCell): ImageData {
        const pixels = new Uint8ClampedArray(VIP_CHAR_SIZE * VIP_CHAR_SIZE * 4);
        const colors = this.previewColors();
        if (colors) {
            const placement = colors.cell(this.segment, this.selected, cell.char, cell.palette);
            this.drawColorChar(
                pixels, VIP_CHAR_SIZE, 0, 0, characters, colors, placement, cell, this.shades(registers));
        } else {
            const palettes = this.palettes(registers);
            drawVipChar(
                pixels, VIP_CHAR_SIZE, 0, 0, characters, cell.char, palettes[cell.palette], cell.hFlip, cell.vFlip,
                true);
        }
        return new ImageData(pixels, VIP_CHAR_SIZE, VIP_CHAR_SIZE);
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return <EmptyContainer
                title={this.error ?? nls.localize('vueport/general/error', 'Error')}
                icon={<Warning size={32} />}
            />;
        }
        if (!this.registers) {
            return (
                <EmptyContainer
                    title={nls.localize(
                        'vueport/general/notRunning',
                        'The emulator is not running.',
                    )}
                    icon={<Plug size={32} />}
                />
            );
        }
        if (!this.image || !this.cells) {
            return <div className='vp-panel-empty'>
                {nls.localize('vueport/debug/panels/bgmaps/reading', 'Reading VIP memory…')}
            </div>;
        }

        const registers = this.registers;
        const cells = this.cells;
        const selected = this.selected;
        const view = new DataView(cells.buffer, cells.byteOffset, cells.byteLength);
        const cell = decodeVipBgMapCell(view.getUint16(selected * 2, true), this.charMask());
        const address = vipBgMapAddress(this.segment) + selected * 2;

        const characters = new VipCharacters(this.charSegments);
        const preview = this.rasterizePreview(registers, characters, cell);

        const uses = this.segmentUses();
        const use = uses[this.segment] ?? { worlds: [], params: [] };

        // focusable, with arrow keys read here so they walk the cells wherever focus is in the panel. The tiles keep
        // their own handler, which walks the segments; see arrowKeysTaken
        return <div
            className='vp-columns'
            tabIndex={0}
            aria-label={nls.localize('vueport/debug/panels/bgmaps/title', 'BGMaps')}
            onKeyDown={event => this.onPanelKey(event)}
        >
            {this.renderTiles(uses)}
            <div className='vp-sidebar vp-scroll'>
                {this.renderSegmentGroup(use)}
                {this.renderCharacterGroup(preview)}
                {this.renderCellGroup(cell, address)}
                {this.vbc && this.renderColorGroup(this.vbc, cell)}
                {this.renderUsedByGroup()}
            </div>
            {/* the map scrolls on its own, and the controls under it stay put however far it is zoomed */}
            <div className='vp-preview vp-preview-with-controls'>
                <div className='vp-preview-view vp-scroll vp-canvas-transparent'>
                    <VipCanvas
                        image={this.image}
                        zoom={this.zoom}
                        cellSize={VIP_CHAR_SIZE}
                        showGrid={this.showGrid}
                        extents={this.hoveredExtents()}
                        selected={{ x: selected % VIP_BGMAP_CELLS, y: Math.floor(selected / VIP_BGMAP_CELLS) }}
                        onPick={(x, y) => {
                            const picked = Math.floor(y / VIP_CHAR_SIZE) * VIP_BGMAP_CELLS
                                + Math.floor(x / VIP_CHAR_SIZE);
                            this.selectCell(picked);
                        }}
                        onHover={point => this.light(point && {
                            kind: 'cell',
                            address: VIP_BGMAP_BASE + (this.segment * VIP_BGMAP_CELLS * VIP_BGMAP_CELLS
                                + Math.floor(point.y / VIP_CHAR_SIZE) * VIP_BGMAP_CELLS
                                + Math.floor(point.x / VIP_CHAR_SIZE)) * 2,
                        })}
                    />
                </div>
                {this.renderDisplayControls()}
            </div>
        </div>;
    }

    protected renderSegmentGroup(use: VipBgMapSegmentUse): React.ReactNode {
        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/bgmaps/segment', 'Segment')}</legend>
            <div className='vp-detail-fields'>
                {field(nls.localize('vueport/debug/panels/bgmaps/map', 'Map'), this.segment)}
                {field(
                    nls.localize('vueport/debug/panels/bgmaps/address', 'Address'),
                    hex(vipBgMapAddress(this.segment), 8)
                )}
            </div>
        </fieldset>;
    }

    // what each world takes from this segment (map cells, param table or both), with a picture of what it draws. This
    // group scrolls when the sidebar is taller than the panel, as its length depends on the game
    protected renderUsedByGroup(): React.ReactNode {
        return <fieldset
            className='vp-inspector-group vp-grows vp-bgmaps-used-by'
            onClick={event => this.onUsedByClick(event)}
        >
            <legend>{nls.localize('vueport/debug/panels/bgmaps/usedBy', 'Used by')}</legend>
            {/* the previews scroll within the group, or a segment many worlds read from would push the Display controls
                off */}
            <div className='vp-scroll-body vp-scroll'>
                {this.usedBy.length === 0
                    ? <span className='hint'>{nls.localize(
                        'vueport/debug/panels/bgmaps/usedByNothing',
                        'No world being drawn reads this segment.'
                    )}</span>
                    : this.usedBy.map(world =>
                        // the row and its world both inside the button: hovering outlines it on the map, a click keeps
                        // the outline up, and the picture is part of what is pointed at
                        <button
                            type='button'
                            key={world.index}
                            className={'vp-used-by-world vp-bgmaps-used-by-world'
                                + (world.index === this.pinnedWorld ? ' selected' : '')}
                            aria-pressed={world.index === this.pinnedWorld}
                            title={nls.localize(
                                'vueport/debug/panels/bgmaps/usedByHint',
                                'Outline where this world reads from the map'
                            )}
                            onMouseEnter={() => this.setHoveredWorld(world.index)}
                            onMouseLeave={() => this.setHoveredWorld(undefined)}
                            onClick={() => this.togglePinnedWorld(world.index)}
                        >
                            <span className='vp-detail-field'>
                                <span className='label'>
                                    {nls.localize('vueport/debug/panels/bgmaps/world', 'World {0}', world.index)}
                                    <span className='hint'>{world.mode}</span>
                                </span>
                                <span className='value'>{world.takes}</span>
                            </span>
                            {world.image &&
                                <VipCanvas image={world.image} zoom={worldPreviewZoom(world.image)} />
                            }
                        </button>
                    )
                }
            </div>
        </fieldset>;
    }

    protected renderCharacterGroup(preview: ImageData): React.ReactNode {
        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/bgmaps/character', 'Character')}</legend>
            <div className='vp-canvas-transparent'>
                <VipCanvas image={preview} zoom={PREVIEW_ZOOM} />
            </div>
        </fieldset>;
    }

    // three fields wide. Shrinks first when the sidebar is taller than the panel, as the other groups are only a few
    // lines each
    protected renderCellGroup(cell: VipBgMapCell, address: number): React.ReactNode {
        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/bgmaps/cell', 'Cell')}</legend>
            <div className='vp-grid'>
                <div className='vp-grid-row'>
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/cell', 'Cell'),
                        numberInput(
                            this.selected, 0, VIP_BGMAP_CELLS * VIP_BGMAP_CELLS - 1,
                            value => this.selectCell(value)
                        )
                    )}
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/address', 'Address'),
                        <input className='vp-input' readOnly value={hex(address, 8)} />,
                        undefined,
                        2
                    )}
                </div>
                <div className='vp-grid-row'>
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/character', 'Character'),
                        numberInput(cell.char, 0, this.charCount() - 1, value => this.writeCell({ char: value }))
                    )}
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/palette', 'Palette'),
                        <Select
                            value={String(cell.palette)}
                            onChange={next => this.writeCell({ palette: parseInt(next, 10) })}
                            options={VIP_BGMAP_PALETTES.map((unused, index) => ({
                                value: String(index),
                                label: `BG ${index}`,
                            }))}
                        />,
                        undefined,
                        2
                    )}
                </div>
                {/* a pair of switches needs more than a third of the group, so it takes the row */}
                <div className='vp-grid-row'>
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/flip', 'Flip'),
                        <div className='vp-flags-row'>
                            {this.renderToggle(
                                nls.localize('vueport/debug/panels/bgmaps/horizontalFlip', 'Horizontal Flip'),
                                nls.localize('vueport/debug/panels/bgmaps/horizontal', 'H'),
                                cell.hFlip,
                                value => this.writeCell({ hFlip: value })
                            )}
                            {this.renderToggle(
                                nls.localize('vueport/debug/panels/bgmaps/verticalFlip', 'Vertical Flip'),
                                nls.localize('vueport/debug/panels/bgmaps/vertical', 'V'),
                                cell.vFlip,
                                value => this.writeCell({ vFlip: value })
                            )}
                        </div>,
                        undefined,
                        3
                    )}
                </div>
            </div>
        </fieldset>;
    }

    /**
     * What a VB Color draws the selected cell with: Cell Color Attribute (palette group, CHRSEL), Cell Pixel Color
     * Attribute (slot, PCE, OPQ), and the CRAM palette they come to, the group above the cell's two palette bits as the
     * core resolves it. Only while color is on (see readVbcState). A bit that is set but switched off in CXCTRL gets a
     * line saying so, as what the cell holds and what it is drawn with then part ways.
     */
    protected renderColorGroup(vbc: VbcState, cell: VipBgMapCell): React.ReactNode {
        const colors = this.cellColors;
        const pixels = this.cellPixelAttrs;
        if (!colors || !pixels) {
            return undefined;
        }
        const attr = decodeVcuColorAttr(colors[this.selected]);
        const pixel = decodeVcuPixelAttr(pixels.getUint16(this.selected * 2, true));

        // with CHRSEL and CCEN the character's entries replace the cell's; nothing is shown until they are read for
        // this cell
        const byCharacter = attr.chrsel && vbc.ccen;
        const character = byCharacter && this.characterColor?.char === cell.char ? this.characterColor : undefined;
        const group = byCharacter ? character && decodeVcuColorAttr(character.color).group : attr.group;
        const palette = group === undefined ? undefined : vcuPlacementPalette(group, cell.palette);
        const drawnPixel = byCharacter ? character && decodeVcuPixelAttr(character.pixel) : pixel;

        const notes: string[] = [];
        if (attr.chrsel && !vbc.ccen) {
            notes.push(nls.localize(
                'vueport/debug/panels/bgmaps/chrselWithoutCcen',
                'CHRSEL is set, but CXCTRL.CCEN is off: the cell\'s own attributes apply.'
            ));
        }
        if (byCharacter) {
            notes.push(nls.localize(
                'vueport/debug/panels/bgmaps/chrselFromCharacter',
                'CHRSEL with CXCTRL.CCEN: palette group and pixel attribute come from Character {0}, not from the cell.',
                cell.char
            ));
        }
        if (drawnPixel?.enabled && !vbc.pcen) {
            notes.push(nls.localize(
                'vueport/debug/panels/bgmaps/pceWithoutPcen',
                'PCE is set, but CXCTRL.PCEN is off: no Pixel Color Slot applies.'
            ));
        } else if (drawnPixel?.enabled) {
            notes.push(nls.localize(
                'vueport/debug/panels/bgmaps/pixelSlotInUse',
                'Drawn through Pixel Color Slot {0}; its zero bytes fall back to the palette below.',
                drawnPixel.slot
            ));
        } else if (drawnPixel?.opaque) {
            notes.push(nls.localize(
                'vueport/debug/panels/bgmaps/opqWithoutPce',
                'OPQ only has an effect while a Pixel Color Slot applies.'
            ));
        }
        if (vbc.wcen) {
            notes.push(nls.localize(
                'vueport/debug/panels/bgmaps/worldOffset',
                'CXCTRL.WCEN is on: each world adds its own palette offset to this.'
            ));
        }

        return <fieldset className='vp-inspector-group'>
            <legend>{nls.localize('vueport/debug/panels/bgmaps/vbColor', 'VB Color')}</legend>
            <div className='vp-grid'>
                <div className='vp-grid-row'>
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/colorGroup', 'Group'),
                        numberInput(attr.group, 0, VCU_GROUP_MAX, value => this.writeColorAttr({ group: value })),
                        nls.localize(
                            'vueport/debug/panels/bgmaps/colorGroupHint',
                            'Cell Color Attribute bits 5-0: the CRAM palette is this times four plus the cell\'s palette'
                        )
                    )}
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/colorFlags', 'Flags'),
                        <div className='vp-flags-row'>
                            {this.renderToggle(
                                nls.localize(
                                    'vueport/debug/panels/bgmaps/chrsel',
                                    'Palette and Pixel Attribute From the Character (CHRSEL)'
                                ),
                                'CHRSEL',
                                attr.chrsel,
                                value => this.writeColorAttr({ chrsel: value })
                            )}
                        </div>,
                        undefined,
                        2
                    )}
                </div>
                <div className='vp-grid-row'>
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/pixelSlot', 'Slot'),
                        numberInput(pixel.slot, 0, VCU_PIXEL_SLOT_COUNT - 1, value => this.writePixelAttr({ slot: value })),
                        nls.localize(
                            'vueport/debug/panels/bgmaps/pixelSlotHint',
                            'Cell Pixel Color Attribute bits 9-0: the Pixel Color Slot used with PCE'
                        )
                    )}
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/colorFlags', 'Flags'),
                        <div className='vp-flags-row'>
                            {this.renderToggle(
                                nls.localize('vueport/debug/panels/bgmaps/pce', 'Use the Pixel Color Slot (PCE)'),
                                'PCE',
                                pixel.enabled,
                                value => this.writePixelAttr({ enabled: value })
                            )}
                            {this.renderToggle(
                                nls.localize('vueport/debug/panels/bgmaps/opq', 'Pixel Value 0 Is Opaque (OPQ)'),
                                'OPQ',
                                pixel.opaque,
                                value => this.writePixelAttr({ opaque: value })
                            )}
                        </div>,
                        undefined,
                        2
                    )}
                </div>
                <div className='vp-grid-row'>
                    {stacked(
                        nls.localize('vueport/debug/panels/bgmaps/cramPalette', 'CRAM Palette'),
                        <div className='vp-bgmaps-cram-palette'>
                            <input className='vp-input' readOnly value={palette === undefined ? '…' : palette} />
                            {palette !== undefined && this.renderPaletteSwatches(palette)}
                        </div>,
                        nls.localize(
                            'vueport/debug/panels/bgmaps/cramPaletteHint',
                            'The palette the cell is drawn with: its group times four plus its palette'
                        ),
                        3
                    )}
                </div>
            </div>
            {notes.map(note => <div key={note} className='hint'>{note}</div>)}
        </fieldset>;
    }

    // the four colors of one CRAM palette, as the VCU panel shows the backdrop's, so the user doesn't have to count
    // them out of the grid
    protected renderPaletteSwatches(palette: number): React.ReactNode {
        const cram = this.cram;
        if (!cram) {
            return undefined;
        }
        const first = palette * VCU_CRAM_PALETTE_SIZE;
        return <span className='vp-vip-swatches'>
            {Array.from({ length: VCU_CRAM_PALETTE_SIZE }, (unused, index) => {
                const color = vcuRgb888(cram.getUint32((first + index) * VCU_CRAM_ENTRY_BYTES, true));
                return <span
                    key={index}
                    className='vp-vip-swatch'
                    style={{ backgroundColor: color.css }}
                    title={`CRAM ${hex(first + index, 3)} · ${color.css}`}
                />;
            })}
        </span>;
    }

    // 512 pixels square, drawn as the panel shows it (palettes, Generic Palette, Colorized) but without the grid,
    // outlines and gray backdrop, which are viewing aids: pixel value 0 stays transparent
    protected async exportPng(): Promise<void> {
        if (this.exportFile && this.image) {
            await exportVipImage(this.exportFile, `bgmap-${this.segment}.png`, this.image);
        }
    }

    // under the map rather than in the sidebar, as in the Objects panel: the scale on its own line, the switches
    // under it in two columns, to the right
    protected renderDisplayControls(): React.ReactNode {
        return <div className='vp-preview-controls'>
            <div className='vp-preview-controls-range'>
                <label>
                    <span>{nls.localize('vueport/debug/panels/bgmaps/scale', 'Scale')}</span>
                    <input
                        type='range'
                        min={1}
                        max={8}
                        value={this.zoom}
                        onChange={e => {
                            this.zoom = this.remember('zoom', parseInt(e.target.value, 10));
                            this.update();
                        }}
                    />
                    <span className='hint'>{this.zoom}</span>
                </label>
            </div>
            <div className='vp-preview-controls-switches'>
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/bgmaps/genericPalette', 'Generic Palette'),
                    nls.localize('vueport/debug/panels/bgmaps/genericPalette', 'Generic Palette'),
                    this.showGenericPalette,
                    value => this.setShowGenericPalette(value)
                )}
                {/* only while the game has switched color on: without it there is nothing to draw in but red */}
                {this.vbc && this.renderToggle(
                    nls.localize('vueport/debug/panels/bgmaps/vbColorPreview', 'Colorized'),
                    nls.localize('vueport/debug/panels/bgmaps/vbColorPreview', 'Colorized'),
                    this.vbColorPreview,
                    value => this.setVbColorPreview(value),
                    nls.localize(
                        'vueport/debug/panels/bgmaps/vbColorPreviewHint',
                        'Draw in the colors the VB Color shows rather than the VIP\'s red'
                    )
                )}
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/bgmaps/showGrid', 'Show Grid'),
                    nls.localize('vueport/debug/panels/bgmaps/showGrid', 'Show Grid'),
                    this.showGrid,
                    value => { this.showGrid = this.remember('showGrid', value); this.update(); }
                )}
            </div>
            {this.exportFile &&
                <div className='vp-preview-controls-row'>
                    <button
                        type='button'
                        className='vp-button secondary'
                        title={nls.localize(
                            'vueport/debug/panels/bgmaps/exportPngHint',
                            'Save this segment as a PNG, at its own size and drawn as shown here')}
                        onClick={() => { this.exportPng().catch(() => undefined); }}
                    >
                        {nls.localize('vueport/debug/panels/bgmaps/exportPng', 'Export PNG')}
                    </button>
                </div>
            }
        </div>;
    }

    // `label` is for screen readers and the only full name where the button shows a letter (the flips); `hint` is the
    // hover text
    protected renderToggle(
        label: string, name: string, value: boolean, onChange: (value: boolean) => void, hint?: string
    ): React.ReactNode {
        return <span className='vp-toggle' title={hint ?? label}>
            <Switch label={label} value={value} onChange={onChange} />
            <span>{name}</span>
        </span>;
    }
}
