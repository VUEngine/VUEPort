import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import { ScreenInspectorTarget } from './emulator-screen-inspector';
import { arrowKeysTaken, hex, DebugSource, Panel, EmulatorPanelType, scrollIntoViewSmoothly } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { exportVipImage, VipCanvas, VipExportFile } from './emulator-vip-canvas';
import { control, field, numberInput } from './emulator-vip-detail';
import {
    decodeVcuColorAttr,
    decodeVcuPixelAttr,
    encodeVcuColorAttr,
    encodeVcuPixelAttr,
    readVbcState,
    vbcCharMask,
    VbcState,
    VCU_CHARACTER_COLOR_BASE,
    VCU_CHARACTER_COLOR_BYTES,
    VCU_CHARACTER_PIXEL_ATTR_BASE,
    VCU_CHARACTER_PIXEL_ATTR_BYTES,
    VCU_PIXEL_SLOT_COUNT,
} from './emulator-vcu-memory';
import { VcuColors, VcuPlacement, vcuPlacement } from './emulator-vcu-colors';
import {
    decodeVipWorld,
    drawVipChar,
    sameVipBytes,
    VIP_BGMAP_BYTES,
    VIP_BGMAP_CELLS,
    VIP_BGMAP_COUNT,
    VIP_CHAR_BYTES,
    VIP_CHAR_COUNT_EXTENDED,
    VIP_CHAR_SEGMENT_BYTES,
    VIP_CHAR_SEGMENTS,
    VIP_CHAR_SIZE,
    VIP_CHARS_PER_SEGMENT,
    VIP_GENERIC_PALETTE_INTENSITIES,
    VIP_GRAPHICS_POLL_HZ,
    VIP_OAM_BASE,
    VIP_OAM_BLOCK_BYTES,
    VIP_REGISTER_BASE,
    VIP_REGISTER_BLOCK_BYTES,
    VIP_WORLD_BASE,
    VIP_WORLD_BLOCK_BYTES,
    VIP_WORLD_BYTES,
    VIP_WORLD_COUNT,
    vipBgMapAddress,
    vipCharMirrorAddress,
    vipCharSegmentAddress,
    vipCharSegmentCount,
    VipCharacters,
    vipCharacterUsage,
    VipCharacterUsage,
    vipChangedCharacters,
    vipDrawnWorlds,
    VIP_BGMAP_BASE,
    VIP_FRAME_BUFFER_HEIGHT,
    VIP_FRAME_BUFFER_WIDTH,
    forEachVipWorldPixel,
    vipParamTableAddress,
    vipParamTableBytes,
    vipWorldMapSegment,
    VipEye,
    VipWorld,
    VipWorldMap,
    VipWorldMode,
    vipWorldSample,
    vipWorldSegments,
} from './emulator-vip-memory';
import EmptyContainer from '../components/kit/EmptyContainer';
import { Plug, Warning } from '@phosphor-icons/react';
import RadioSelect from '../components/kit/RadioSelect';
import Switch from '../components/kit/Switch';
import { Sim } from '../core/vb-core';

const CHARS_PER_ROW_OPTIONS = [8, 16, 32];
const DEFAULT_CHARS_PER_ROW = 16;

// the eight-pixel character comes out at 216 across, the width the sidebar is laid out to. The same number as
// --vp-characters-sidebar in the stylesheet
const PREVIEW_ZOOM = 27;

// the width of the sidebar, and no more height than leaves it a thumbnail
const MAP_PREVIEW_WIDTH = VIP_CHAR_SIZE * PREVIEW_ZOOM;
const MAP_PREVIEW_MAX_HEIGHT = 256;

// the eyes differ only by parallax, which changes nothing about which characters a world draws; the left is the
// one the Worlds panel shows first
const PREVIEW_EYE: VipEye = 'left';

// fractional on purpose: a map is one pixel to the cell, so a 64-cell world is scaled by 3.375, and whole numbers
// would leave a fifth of the column empty. A map too tall is fitted to the height rather than stretched
function mapPreviewZoom(image: ImageData): number {
    return Math.min(MAP_PREVIEW_WIDTH / image.width, MAP_PREVIEW_MAX_HEIGHT / image.height);
}

// used and changed blank the rest rather than closing the gaps, as a character's place in the sheet is its index
type CharacterFilter = 'all' | 'used' | 'changed';

const CHARACTER_FILTERS: CharacterFilter[] = ['all', 'used', 'changed'];

/**
 * A character the filter leaves out is ghosted and gray rather than blanked, as an empty square says a character is
 * blank, a fact about character memory. Faint enough that the kept handful stands out; gray as well, as fading alone
 * puts filtered-out and dark kept characters on one scale and the sheet reads as one picture with a gradient.
 */
const FILTERED_FACTOR = 0.18;
const FILTERED_INTENSITIES = VIP_GENERIC_PALETTE_INTENSITIES.map(
    intensity => Math.round(intensity * FILTERED_FACTOR));

// see CharactersPanel#shadingFor
interface CharacterShading {
    intensities: number[];
    gray?: boolean;
}

// in milliseconds. The panel polls a few times a second, so "changed between the last two reads" would vanish before
// it can be read; holding it shows streaming animation. The VSU panel marks rewritten waveform banks as long
const CHANGED_MS = 1200;

// every BGMap segment, since Used by has something to say about all of them
const VIP_BGMAP_SEGMENTS = Array.from({ length: VIP_BGMAP_COUNT }, (unused, segment) => segment);

interface MapPreview {
    key: string;
    label: string;
    note?: string;
    cells: number;
    image?: ImageData;
}

// ignoring its palette and flips. charMask is eleven bits, or twelve on a VB Color with CHREXT; see vbcCharMask
function cellChar(bytes: Uint8Array, cell: number, charMask = 0x07ff): number | undefined {
    const offset = cell * 2;
    return offset + 1 < bytes.length
        ? (bytes[offset] | (bytes[offset + 1] << 8)) & charMask
        : undefined;
}

function extensionHint(): string {
    return nls.localize(
        'vueport/debug/panels/characters/extensionHint',
        "In the VB Color's Character RAM Extension, which cells and objects reach "
        + 'while CHRCTRL.CHREXT is set');
}

function sameDrawnSegments(a: ReadonlyArray<boolean>, b: ReadonlyArray<boolean>): boolean {
    return a.length === b.length && a.every((drawn, segment) => drawn === b[segment]);
}

// one character in VB Color at full strength. Without a cell or object it is colored by its own Character Color entry
// (the one CHRSEL uses), and without a palette register its pixel values are the shades. Pixels the hardware would
// leave out come out black
function drawColorChar(
    target: Uint8ClampedArray,
    targetWidth: number,
    destX: number,
    destY: number,
    characters: VipCharacters,
    char: number,
    colors: VcuColors,
    placement: VcuPlacement
): void {
    for (let y = 0; y < VIP_CHAR_SIZE; y++) {
        for (let x = 0; x < VIP_CHAR_SIZE; x++) {
            const value = characters.pixel(char, x, y);
            const offset = ((destY + y) * targetWidth + destX + x) * 4;
            if (!colors.put(target, offset, placement, value, x, y, value)) {
                putBlack(target, offset);
            }
        }
    }
}

function putBlack(target: Uint8ClampedArray, offset: number): void {
    target[offset] = 0;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 255;
}

// faint and gray like the red sheet's filtered-out characters: brightness scaled down rather than colors, so a
// ghosted character reads as a gray shape in both modes
function ghost(pixels: Uint8ClampedArray, width: number, destX: number, destY: number): void {
    for (let y = 0; y < VIP_CHAR_SIZE; y++) {
        for (let x = 0; x < VIP_CHAR_SIZE; x++) {
            const offset = ((destY + y) * width + destX + x) * 4;
            const luma = (pixels[offset] * 299 + pixels[offset + 1] * 587 + pixels[offset + 2] * 114) / 1000;
            const level = Math.round(luma * FILTERED_FACTOR);
            pixels[offset] = level;
            pixels[offset + 1] = level;
            pixels[offset + 2] = level;
        }
    }
}

// done to the drawn pixels rather than drawing gray, as what a pixel value is worth is the palette's business and
// every view reads those as the hardware's red (see ghost)
function grayOut(pixels: Uint8ClampedArray, width: number, destX: number, destY: number): void {
    for (let y = 0; y < VIP_CHAR_SIZE; y++) {
        for (let x = 0; x < VIP_CHAR_SIZE; x++) {
            const offset = ((destY + y) * width + destX + x) * 4;
            pixels[offset + 1] = pixels[offset];
            pixels[offset + 2] = pixels[offset];
        }
    }
}

/**
 * Every character in VRAM as one atlas, with a sidebar inspecting one at a time. Each refresh reads the four character
 * segments (eight with CHRCTRL.CHREXT on a VB Color) and re-rasterizes only on change, so a paused emulator costs reads
 * but no drawing. Used by and the In use filter cross-reference the BGMap cells of the drawn worlds' segments and the
 * objects OAM switched on; only what is drawn counts, see VipCharacterUsage.
 */
export class CharactersPanel extends Panel {

    protected error?: string;
    protected registers?: DataView;
    // only while a VB Color game has unlocked the VCU, see readVbcState. Without it the panel is the plain VIP one
    protected vbc?: VbcState;
    // four, or eight while CHREXT makes the VCU's Character RAM Extension reachable. The sheet, selection and keys go
    // by this rather than by the VIP's 2048
    protected segmentCount = VIP_CHAR_SEGMENTS.length;
    protected charSegments: (Uint8Array | undefined)[] = [];
    // the VCU's Character Color Attribute and Character Pixel Color Attribute RAM, two bytes per character. Read only
    // while vbc is there and only for the sidebar; the sheet stays in the hardware's red
    protected charColorAttrs?: Uint8Array;
    protected charPixelAttrs?: Uint8Array;
    // one buffer rather than fourteen, as H-bias and Affine param tables live in it at an address; see paramsFor
    protected bgMapBytes?: Uint8Array;
    // the same bytes, cut into segments: views, not copies
    protected bgMapSegments: (Uint8Array | undefined)[] = [];
    protected oamBytes?: Uint8Array;
    protected usage?: VipCharacterUsage;
    // performance.now() of each character's last change, 0 if none since the panel opened; see CHANGED_MS. Sized for
    // the extension either way, as it is only timestamps
    protected readonly changedAt = new Float64Array(VIP_CHAR_COUNT_EXTENDED);

    // remembered across sessions; the selected character is not, as it belongs to the ROM that happened to be running
    protected charsPerRow = this.rememberedCharsPerRow();
    protected zoom = this.remembered('zoom', 3);
    protected showGrid = this.remembered('showGrid', true);
    protected showSegments = this.remembered('showSegments', true);
    protected filter = this.rememberedFilter();
    // on unless turned off, so a color game is seen in color; only has a say while vbc is there, see colors
    protected vbColorPreview = this.remembered('vbColorPreview', true);
    protected selected = 0;
    // only there with vbc and vbColorPreview both, so every drawing routine can go by this alone
    protected colors?: VcuColors;

    protected image?: ImageData;
    protected segmentImages: ImageData[] = [];
    protected worlds: VipWorld[] = [];
    // their attribute memory, to notice when one of them moves
    protected worldBytes?: Uint8Array;
    protected drawnSegments: boolean[] = [];
    protected mapPreviews: MapPreview[] = [];
    // cleared whenever character memory moves, see characterAverages
    protected averages?: Uint8Array;
    protected drawnChars?: Uint8Array;
    protected dirty = true;

    constructor(
        source: DebugSource,
        instanceId: string,
        protected readonly exportFile?: VipExportFile
    ) {
        super(EmulatorPanelType.VIP_CHARACTERS, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/characters/title', 'Characters');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.VIP_CHARACTERS);
        // the panel is a column holding a toolbar above the inspector, which scrolls on its own
        this.addClass('vp-characters');
    }

    protected pollHz(): number {
        return VIP_GRAPHICS_POLL_HZ;
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.registers = undefined;
            this.vbc = undefined;
            this.segmentCount = VIP_CHAR_SEGMENTS.length;
            this.selected = Math.min(this.selected, this.charCount - 1);
            this.charSegments = [];
            this.charColorAttrs = undefined;
            this.charPixelAttrs = undefined;
            this.colors = undefined;
            this.bgMapBytes = undefined;
            this.bgMapSegments = [];
            this.oamBytes = undefined;
            this.usage = undefined;
            this.image = undefined;
            this.segmentImages = [];
            this.mapPreviews = [];
            this.drawnChars = undefined;
            this.worlds = [];
            this.drawnSegments = [];
            this.averages = undefined;
            this.update();
            return;
        }

        try {
            const [registers, vbc] = await Promise.all([
                sim.readMemory(VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES),
                readVbcState(this.source, sim),
            ]);
            this.registers = new DataView(registers);
            // first, since how many characters there are to read hangs on it
            this.vbc = vbc;
            await this.readCharacters(sim);
            await this.readReferences(sim);
            await this.readColorAttributes(sim);
            // after the references, as the BGMap color tables needed are those of the segments the drawn worlds map
            // from
            await this.readColors(sim);
            this.error = undefined;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }

        // the "changed" window runs out on its own, so under that filter the picture changes while memory does not
        if (this.filter === 'changed') {
            this.dirty = true;
        }
        if (this.dirty) {
            this.rasterize();
            this.dirty = false;
        }
        this.update();
    }

    // the VIP's four segments, and with CHREXT the extension's four after them as segments 4-7
    protected async readCharacters(sim: Sim): Promise<void> {
        const count = vipCharSegmentCount(this.vbc?.chrext ?? false);
        if (count !== this.segmentCount) {
            this.resizeCharacters(count);
        }
        const segments = await Promise.all(Array.from({ length: count },
            (unused, index) => sim.readMemory(vipCharSegmentAddress(index), VIP_CHAR_SEGMENT_BYTES)
        ));
        const now = performance.now();
        segments.forEach((buffer, index) => {
            const bytes = new Uint8Array(buffer);
            const previous = this.charSegments[index];
            if (sameVipBytes(bytes, previous)) {
                return;
            }
            // nothing "changed" on a segment's first read, or the Changed filter would show the whole atlas once per
            // open
            if (previous) {
                this.markChanged(index, bytes, previous, now);
            }
            this.charSegments[index] = bytes;
            this.averages = undefined;
            this.dirty = true;
        });
    }

    // the extension's segments are dropped rather than kept, as VipCharacters reads cells with twelve bits when it has
    // eight, and a character no cell can reach should not be offered. Usage is recounted, a selection past the end
    // pulled back
    protected resizeCharacters(count: number): void {
        this.segmentCount = count;
        this.charSegments = this.charSegments.slice(0, count);
        this.usage = undefined;
        this.averages = undefined;
        this.dirty = true;
        this.selected = Math.min(this.selected, this.charCount - 1);
    }

    protected get charCount(): number {
        return this.segmentCount * VIP_CHARS_PER_SEGMENT;
    }

    // for the sidebar's Character Color group. Not compared or kept for change marking, as the fields render every
    // poll. Dropped once the VCU is not active
    protected async readColorAttributes(sim: Sim): Promise<void> {
        if (!this.vbc) {
            this.charColorAttrs = undefined;
            this.charPixelAttrs = undefined;
            return;
        }
        const [colors, pixels] = await Promise.all([
            sim.readMemory(VCU_CHARACTER_COLOR_BASE, VCU_CHARACTER_COLOR_BYTES),
            sim.readMemory(VCU_CHARACTER_PIXEL_ATTR_BASE, VCU_CHARACTER_PIXEL_ATTR_BYTES),
        ]);
        this.charColorAttrs = new Uint8Array(colors);
        this.charPixelAttrs = new Uint8Array(pixels);
    }

    // CRAM, the cell tables of the drawn worlds' segments and the World offsets; no objects, as no preview draws one.
    // Compared with the last read, and dropped with a redraw the moment color stops applying
    protected async readColors(sim: Sim): Promise<void> {
        const vbc = this.vbc;
        if (!vbc || !this.vbColorPreview) {
            if (this.colors) {
                this.colors = undefined;
                this.dirty = true;
            }
            return;
        }
        const segments = this.drawnSegments.flatMap((drawn, segment) => drawn ? [segment] : []);
        const colors = await VcuColors.read(sim, vbc, { segments, worlds: true });
        if (!colors.same(this.colors)) {
            this.dirty = true;
        }
        this.colors = colors;
    }

    protected markChanged(segment: number, bytes: Uint8Array, previous: Uint8Array, now: number): void {
        for (const char of vipChangedCharacters(bytes, previous)) {
            this.changedAt[segment * VIP_CHARS_PER_SEGMENT + char] = now;
        }
    }

    // the drawn worlds' segments rather than all fourteen, as that is a hundred kilobytes a poll, and a segment no
    // world maps from holds whatever the last scene left, which is evidence of nothing
    protected async readReferences(sim: Sim): Promise<void> {
        const worldBytes = new Uint8Array(await sim.readMemory(VIP_WORLD_BASE, VIP_WORLD_BLOCK_BYTES));
        const view = new DataView(worldBytes.buffer, worldBytes.byteOffset, worldBytes.byteLength);
        const worlds = vipDrawnWorlds(Array.from({ length: VIP_WORLD_COUNT }, (unused, index) =>
            decodeVipWorld(view, index, index * VIP_WORLD_BYTES)));

        const drawn: boolean[] = new Array(VIP_BGMAP_COUNT).fill(false);
        for (const world of worlds) {
            if (world.mode !== VipWorldMode.OBJECT) {
                for (const segment of vipWorldSegments(world)) {
                    drawn[segment] = true;
                }
            }
        }

        // a segment at a time, as a read is capped below BGMap memory's size, into one buffer laid out as the
        // hardware's, param tables included
        const read = await Promise.all(VIP_BGMAP_SEGMENTS.map(
            segment => sim.readMemory(vipBgMapAddress(segment), VIP_BGMAP_BYTES)));
        const bgMapBytes = new Uint8Array(VIP_BGMAP_COUNT * VIP_BGMAP_BYTES);
        read.forEach((buffer, segment) => bgMapBytes.set(new Uint8Array(buffer), segment * VIP_BGMAP_BYTES));
        const changedBytes = !sameVipBytes(bgMapBytes, this.bgMapBytes);
        let changed = changedBytes || !sameDrawnSegments(drawn, this.drawnSegments);

        this.bgMapBytes = bgMapBytes;
        this.bgMapSegments = VIP_BGMAP_SEGMENTS.map(segment => bgMapBytes.subarray(
            segment * VIP_BGMAP_BYTES, (segment + 1) * VIP_BGMAP_BYTES));
        this.drawnSegments = drawn;
        // part of the comparison, as a world that only scrolled draws another part of the same map
        if (!sameVipBytes(worldBytes, this.worldBytes)) {
            this.worldBytes = worldBytes;
            changed = true;
        }
        this.worlds = worlds;

        const oam = new Uint8Array(await sim.readMemory(VIP_OAM_BASE, VIP_OAM_BLOCK_BYTES));
        if (!sameVipBytes(oam, this.oamBytes)) {
            this.oamBytes = oam;
            changed = true;
        }

        if (changed || !this.usage) {
            this.usage = vipCharacterUsage(
                this.bgMapSegments, this.oamBytes, this.drawnSegments, vbcCharMask(this.vbc));
            this.dirty = true;
        }
    }

    // held to the three the slider offers, as it is stored as a width and an unoffered width has no slider step
    protected rememberedCharsPerRow(): number {
        const stored = this.remembered('charsPerRow', DEFAULT_CHARS_PER_ROW);
        return CHARS_PER_ROW_OPTIONS.includes(stored) ? stored : DEFAULT_CHARS_PER_ROW;
    }

    protected rememberedFilter(): CharacterFilter {
        const stored = this.remembered('filter', 'all');
        return CHARACTER_FILTERS.includes(stored as CharacterFilter) ? stored as CharacterFilter : 'all';
    }

    protected setCharsPerRow(charsPerRow: number): void {
        this.charsPerRow = this.remember('charsPerRow', charsPerRow);
        this.dirty = true;
        this.refresh();
    }

    protected setVbColorPreview(on: boolean): void {
        this.vbColorPreview = this.remember('vbColorPreview', on);
        this.dirty = true;
        this.refresh();
    }

    protected setFilter(filter: CharacterFilter): void {
        this.filter = this.remember('filter', filter) as CharacterFilter;
        this.dirty = true;
        this.refresh();
    }

    reveal(target: ScreenInspectorTarget): void {
        if (target.kind !== 'character') {
            return;
        }
        this.selectCharacter(target.character);
        this.whenRendered(() => {
            const selection = this.node.querySelector('.vp-canvas-selection');
            if (selection) {
                scrollIntoViewSmoothly(selection, 'center');
            }
        });
    }

    protected selectCharacter(char: number): void {
        if (Number.isNaN(char)) {
            return;
        }
        this.selected = Math.min(this.charCount - 1, Math.max(0, char));
        // Used by is about the selected character alone, so picking another makes those thumbnails stale
        this.buildMapPreviews();
        this.update();
    }

    protected shown(char: number, now: number): boolean {
        switch (this.filter) {
            // nothing has been cross-referenced on the very first poll, and showing everything beats blanking the atlas
            case 'used': return this.drawnChars
                ? this.drawnChars[char] === 1 || (this.usage?.objectCount(char) ?? 0) > 0
                : true;
            case 'changed': return now - this.changedAt[char] < CHANGED_MS;
            default: return true;
        }
    }

    // a character is drawn as it is or ghosted. No third state for unreferenced characters, as that repeats what the In
    // use filter says and leaves two kinds of gray to tell apart
    protected shadingFor(char: number, now: number): CharacterShading {
        return this.shown(char, now)
            ? { intensities: VIP_GENERIC_PALETTE_INTENSITIES }
            : { intensities: FILTERED_INTENSITIES, gray: true };
    }

    protected rasterize(): void {
        const now = performance.now();
        this.markDrawnCharacters();
        this.image = this.drawAtlas(char => this.shadingFor(char, now));
        this.segmentImages = this.image ? this.sliceSegments(this.image) : [];
        this.buildMapPreviews();
    }

    protected drawAtlas(shadingFor: (char: number) => CharacterShading): ImageData | undefined {
        if (this.charSegments.length === 0) {
            return undefined;
        }
        const characters = new VipCharacters(this.charSegments);
        const width = this.charsPerRow * VIP_CHAR_SIZE;
        const height = (this.charCount / this.charsPerRow) * VIP_CHAR_SIZE;
        const pixels = new Uint8ClampedArray(width * height * 4);
        const colors = this.colors;
        const placement = vcuPlacement();

        for (let char = 0; char < this.charCount; char++) {
            const x = (char % this.charsPerRow) * VIP_CHAR_SIZE;
            const y = Math.floor(char / this.charsPerRow) * VIP_CHAR_SIZE;
            const shading = shadingFor(char);
            if (colors) {
                // the intensities are the red sheet's business; in color a filtered-out character is drawn as it is and
                // then ghosted
                drawColorChar(pixels, width, x, y, characters, char, colors,
                    colors.character(char, 0, 0, placement));
                if (shading.gray) {
                    ghost(pixels, width, x, y);
                }
                continue;
            }
            drawVipChar(pixels, width, x, y, characters, char, shading.intensities);
            if (shading.gray) {
                grayOut(pixels, width, x, y);
            }
        }
        return new ImageData(pixels, width, height);
    }

    // a thumbnail per BGMap segment whose cells name the selected character, one pixel to the cell with those cells
    // picked out, so "where" is a recognisable silhouette rather than a count
    protected buildMapPreviews(): void {
        const usage = this.usage;
        if (!usage) {
            this.mapPreviews = [];
            return;
        }
        const characters = new VipCharacters(this.charSegments);
        const rows: MapPreview[] = [];
        const drawnFrom = new Set<number>();

        // a world first, as that is what is on screen; "BGMap 3" only helps a user who knows which world reads it
        for (const world of this.worlds) {
            if (world.mode === VipWorldMode.OBJECT) {
                continue;
            }
            const maps = new Set<number>();
            let cells = 0;
            this.eachDrawnCell(world, new VipWorldMap(world, this.bgMapSegments, characters),
                (char, segment) => {
                    if (char === this.selected) {
                        cells++;
                        maps.add(segment);
                    }
                });
            if (cells === 0) {
                continue;
            }
            const named = [...maps].sort((a, b) => a - b);
            named.forEach(segment => drawnFrom.add(segment));
            rows.push({
                key: `world-${world.index}`,
                label: nls.localize('vueport/debug/panels/characters/usedByWorld', 'World {0}', world.index),
                // which of its segments those cells are in, as a world's map can span several
                note: named.length === 1
                    ? nls.localize('vueport/debug/panels/characters/usedByBgMap', 'BGMap {0}', named[0])
                    : nls.localize(
                        'vueport/debug/panels/characters/usedByBgMaps', 'BGMaps {0}', named.join(', ')),
                cells,
                image: this.drawWorldPreview(world),
            });
        }

        // then the cells no world showed: a map can hold a character no world reads, or outside the window a world
        // reads. Either way it is in memory and not on the screen
        for (const { segment, cells } of usage.bgMapCounts(this.selected)) {
            if (!drawnFrom.has(segment)) {
                rows.push({
                    key: `bgmap-${segment}`,
                    label: nls.localize('vueport/debug/panels/characters/usedByBgMap', 'BGMap {0}', segment),
                    cells,
                    image: this.drawSegmentPreview(segment),
                });
            }
        }
        this.mapPreviews = rows;
    }

    // the In use filter's answer, from the same walk Used by counts with, as a character in a map corner the world
    // never scrolls to is not in use
    protected markDrawnCharacters(): void {
        const drawn = new Uint8Array(this.charCount);
        const characters = new VipCharacters(this.charSegments);
        for (const world of this.worlds) {
            if (world.mode !== VipWorldMode.OBJECT) {
                this.eachDrawnCell(world, new VipWorldMap(world, this.bgMapSegments, characters),
                    char => { drawn[char] = 1; });
            }
        }
        this.drawnChars = drawn;
    }

    // the walk is over pixels, as only they know where they come from with a param table shifting rows, but the lookup
    // only happens where the run moves into a new cell, and a set keeps a cell drawn twice from counting twice
    protected eachDrawnCell(
        world: VipWorld, map: VipWorldMap, visit: (char: number, segment: number) => void
    ): void {
        const width = Math.min(world.w + 1, VIP_FRAME_BUFFER_WIDTH);
        const height = Math.min(world.h + 1, VIP_FRAME_BUFFER_HEIGHT);
        if (width <= 0 || height <= 0) {
            return;
        }
        // both are powers of two (1, 2, 4 or 8 segments a side), so the mask is the hardware's wrap, negatives included
        const across = world.scx * VIP_BGMAP_CELLS;
        const down = world.scy * VIP_BGMAP_CELLS;
        const seen = new Set<number>();
        let last = -1;
        forEachVipWorldPixel(
            { ...world, gx: 0, gy: 0, gp: 0 }, width, height, PREVIEW_EYE, this.paramsFor(world),
            (unusedX, unusedY, sourceX, sourceY) => {
                const cellX = (sourceX >> 3) & (across - 1);
                const cellY = (sourceY >> 3) & (down - 1);
                const key = cellY * across + cellX;
                if (key === last || seen.has(key)) {
                    last = key;
                    return;
                }
                last = key;
                seen.add(key);
                visit(map.char(sourceX, sourceY), vipWorldMapSegment(world, cellX, cellY));
            });
    }

    // a whole map rather than a window, as a segment no world reads has nothing to say which part matters
    protected drawSegmentPreview(segment: number): ImageData | undefined {
        const bytes = this.bgMapSegments[segment];
        return bytes === undefined
            ? undefined
            : this.drawCells(VIP_BGMAP_CELLS, VIP_BGMAP_CELLS, this.characterAverages(),
                (x, y) => cellChar(bytes, y * VIP_BGMAP_CELLS + x, vbcCharMask(this.vbc)));
    }

    /**
     * One world as drawn, with the selected character's pixels picked out. It is the world's own W+1 by H+1 window onto
     * its map from MX/MY, shifted per row by its param table, as the map alone would show places the world never looks
     * at. Everything deciding where a pixel comes from is applied by forEachVipWorldPixel; only GX, GY and GP are
     * dropped.
     */
    protected drawWorldPreview(world: VipWorld): ImageData | undefined {
        const width = Math.min(world.w + 1, VIP_FRAME_BUFFER_WIDTH);
        const height = Math.min(world.h + 1, VIP_FRAME_BUFFER_HEIGHT);
        if (width <= 0 || height <= 0) {
            return undefined;
        }
        // drawn no finer than shown: sampling every second pixel is four times less work than drawing all of them and
        // letting the browser throw three quarters away
        const stride = Math.max(1, Math.ceil(width / MAP_PREVIEW_WIDTH));
        const previewWidth = Math.ceil(width / stride);
        const previewHeight = Math.ceil(height / stride);
        const pixels = new Uint8ClampedArray(previewWidth * previewHeight * 4);

        const map = new VipWorldMap(world, this.bgMapSegments, new VipCharacters(this.charSegments));
        const palettes = [0, 1, 2, 3].map(() => VIP_GENERIC_PALETTE_INTENSITIES);
        const box = { ...world, gx: 0, gy: 0, gp: 0 };
        // in color, the same plain shading as in red (a pixel value is its own shade, not via GPLT), with the cell's
        // palette and the world's offset doing the rest. One sample and one placement for the whole world, filled in
        // per pixel
        const colors = this.colors;
        const sample = vipWorldSample();
        const placement = vcuPlacement();
        const worldOffset = colors?.worldOffset(world.index) ?? 0;
        forEachVipWorldPixel(box, width, height, PREVIEW_EYE, this.paramsFor(world), (x, y, sx, sy) => {
            if (x % stride !== 0 || y % stride !== 0) {
                return;
            }
            const offset = ((y / stride) * previewWidth + x / stride) * 4;
            if (map.char(sx, sy) === this.selected) {
                // white, which nothing else in these views is, as a brighter red would look like just another shade
                pixels[offset] = 255;
                pixels[offset + 1] = 255;
                pixels[offset + 2] = 255;
            } else if (colors) {
                map.sample(sx, sy, sample);
                colors.cell(sample.segment, sample.cell, sample.char, sample.palette, placement);
                if (!colors.put(pixels, offset, placement, sample.value, sample.charX, sample.charY,
                    sample.value, worldOffset)) {
                    putBlack(pixels, offset);
                }
            } else {
                pixels[offset] = map.intensity(sx, sy, palettes);
            }
            pixels[offset + 3] = 255;
        });
        return new ImageData(pixels, previewWidth, previewHeight);
    }

    // the tables live in the region the segments were read from. A table running past its end gets none rather than a
    // short one, drawn as a world with no per-row shift
    protected paramsFor(world: VipWorld): DataView | undefined {
        const bytes = this.bgMapBytes;
        const length = vipParamTableBytes(world);
        if (!bytes || length <= 0) {
            return undefined;
        }
        const offset = vipParamTableAddress(world.param) - VIP_BGMAP_BASE;
        return offset >= 0 && offset + length <= bytes.length
            ? new DataView(bytes.buffer, bytes.byteOffset + offset, length)
            : undefined;
    }

    // one pixel per cell: the character's average brightness, or white where it is the selected one
    protected drawCells(
        width: number,
        height: number,
        averages: Uint8Array,
        charAt: (x: number, y: number) => number | undefined
    ): ImageData {
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const char = charAt(x, y);
                const offset = (y * width + x) * 4;
                if (char === this.selected) {
                    // white, which nothing else in these views is, as a brighter red would look like just another shade
                    pixels[offset] = 255;
                    pixels[offset + 1] = 255;
                    pixels[offset + 2] = 255;
                } else if (char !== undefined) {
                    pixels[offset] = averages[char];
                }
                pixels[offset + 3] = 255;
            }
        }
        return new ImageData(pixels, width, height);
    }

    // built once per read of character memory rather than per thumbnail, or the same sixty-four lookups repeat for
    // every cell naming the same character
    protected characterAverages(): Uint8Array {
        if (!this.averages) {
            const characters = new VipCharacters(this.charSegments);
            const averages = new Uint8Array(this.charCount);
            for (let char = 0; char < this.charCount; char++) {
                let total = 0;
                for (let y = 0; y < VIP_CHAR_SIZE; y++) {
                    for (let x = 0; x < VIP_CHAR_SIZE; x++) {
                        total += VIP_GENERIC_PALETTE_INTENSITIES[characters.pixel(char, x, y)];
                    }
                }
                averages[char] = total / (VIP_CHAR_SIZE * VIP_CHAR_SIZE);
            }
            this.averages = averages;
        }
        return this.averages;
    }

    // views onto the same pixels, as a segment is a whole number of sheet rows whatever the column count
    protected sliceSegments(image: ImageData): ImageData[] {
        const rows = (VIP_CHARS_PER_SEGMENT / this.charsPerRow) * VIP_CHAR_SIZE;
        const bytes = rows * image.width * 4;
        return Array.from({ length: this.segmentCount }, (unused, segment) => new ImageData(
            image.data.subarray(segment * bytes, (segment + 1) * bytes), image.width, rows));
    }

    protected rasterizePreview(characters: VipCharacters, char: number): ImageData {
        const pixels = new Uint8ClampedArray(VIP_CHAR_SIZE * VIP_CHAR_SIZE * 4);
        // full strength whatever the atlas is doing: the preview is what the character is
        if (this.colors) {
            drawColorChar(pixels, VIP_CHAR_SIZE, 0, 0, characters, char, this.colors,
                this.colors.character(char, 0, 0));
        } else {
            drawVipChar(pixels, VIP_CHAR_SIZE, 0, 0, characters, char, VIP_GENERIC_PALETTE_INTENSITIES);
        }
        return new ImageData(pixels, VIP_CHAR_SIZE, VIP_CHAR_SIZE);
    }

    // one screen pixel per source pixel, not filtered, dimmed or gridded, as this file is lined up against source art
    protected async exportPng(): Promise<void> {
        const image = this.drawAtlas(() => ({ intensities: VIP_GENERIC_PALETTE_INTENSITIES }));
        if (this.exportFile && image) {
            await exportVipImage(this.exportFile, 'characters.png', image);
        }
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return <EmptyContainer
                title={this.error ?? nls.localize('vueport/general/error', 'Error')}
                icon={<Warning size={32} />}
            />;
        }
        if (!this.registers) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/general/notRunning',
                    'The emulator is not running.',
                )}
                icon={<Plug size={32} />}
            />;
        }
        if (!this.image) {
            return <div className='vp-panel-empty'>
                {nls.localize('vueport/debug/panels/characters/reading', 'Reading VIP memory…')}
            </div>;
        }

        return <>
            {/* the arrow keys are read here as well as on the sheet, so they walk the characters wherever focus is in
                the panel. The sheet is in the tab order itself and keeps its own handler, see arrowKeysTaken */}
            <div
                className='vp-inspector'
                tabIndex={0}
                aria-label={nls.localize('vueport/debug/panels/characters/title', 'Characters')}
                onKeyDown={event => this.onPanelKey(event)}
            >
                <div className='vp-inspector-sidebar vp-scroll'>
                    {this.renderSelected()}
                    {this.renderCharacterColor()}
                    {this.renderUsedBy()}
                </div>
                {/* the sheet, with the Display controls held over its bottom right corner while it scrolls under them
                    */}
                <div className='vp-characters-main'>
                    {/* focusable so the arrow keys have somewhere to land once a character was clicked */}
                    <div
                        className='vp-inspector-main vp-scroll vp-characters-atlas'
                        tabIndex={0}
                        aria-label={nls.localize('vueport/debug/panels/characters/title', 'Characters')}
                        onKeyDown={event => this.onAtlasKey(event)}
                    >
                        {this.renderAtlas()}
                    </div>
                    {this.renderDisplayGroup()}
                </div>
            </div>
        </>;
    }

    protected renderSelected(): React.ReactNode {
        const selected = this.selected;
        const segment = selected >> 9;
        const charInSegment = selected % VIP_CHARS_PER_SEGMENT;
        const address = vipCharSegmentAddress(segment) + charInSegment * VIP_CHAR_BYTES;
        // only the VIP's own segments have the contiguous mirror; the VCU's extension is at one address only
        const extension = segment >= VIP_CHAR_SEGMENTS.length;
        const mirror = vipCharMirrorAddress(segment) + charInSegment * VIP_CHAR_BYTES;
        const preview = this.rasterizePreview(new VipCharacters(this.charSegments), selected);

        return <fieldset className='vp-inspector-group vp-characters-selected'>
            <legend>{nls.localize('vueport/debug/panels/characters/currentCharacter', 'Current Character')}</legend>
            <VipCanvas image={preview} zoom={PREVIEW_ZOOM} />
            <div className='vp-detail-fields'>
                {control(
                    nls.localize('vueport/debug/panels/characters/char', 'Char'),
                    numberInput(selected, 0, this.charCount - 1, char => this.selectCharacter(char))
                )}
                {/* a character's segment is only worth stating while the sheet is divided into them */}
                {this.showSegments &&
                    field(nls.localize('vueport/debug/panels/characters/segment', 'Segment'), segment)}
                {field(
                    nls.localize('vueport/debug/panels/characters/address', 'Address'),
                    <code>{hex(address, 8)}</code>,
                    extension
                        ? extensionHint()
                        : undefined
                )}
                {!extension && field(
                    nls.localize('vueport/debug/panels/characters/mirror', 'Mirror'),
                    <code>{hex(mirror, 8)}</code>,
                    nls.localize(
                        'vueport/debug/panels/characters/mirrorHint',
                        'Where the same character is reachable a second time, in the contiguous '
                        + 'mirror of the four segments')
                )}
            </div>
        </fieldset>;
    }

    /**
     * The selected character's VB Color attributes: palette groups and Pixel Color Attribute. Shown only while the VCU
     * is active, as a group of its own, as none of it applies by itself: a cell or object only uses these with CHRSEL
     * in its Color Attribute and CXCTRL.CCEN set. With CCEN off the group says so rather than going away, as games set
     * these up before switching them on, exactly when the user wants to check them.
     */
    protected renderCharacterColor(): React.ReactNode {
        const vbc = this.vbc;
        const colors = this.charColorAttrs;
        const pixels = this.charPixelAttrs;
        if (!vbc || !colors || !pixels) {
            return undefined;
        }
        const selected = this.selected;
        const cellByte = colors[selected * 2];
        const objectByte = colors[selected * 2 + 1];
        const pixelWord = pixels[selected * 2] | (pixels[selected * 2 + 1] << 8);
        const cell = decodeVcuColorAttr(cellByte);
        const object = decodeVcuColorAttr(objectByte);
        const pixel = decodeVcuPixelAttr(pixelWord);

        return <fieldset className='vp-inspector-group vp-characters-color'>
            <legend>{nls.localize('vueport/debug/panels/characters/vbColor', 'VB Color')}</legend>
            <div className='vp-detail-fields'>
                {control(
                    nls.localize('vueport/debug/panels/characters/cellGroup', 'Cell Group'),
                    numberInput(cell.group, 0, 0x3f, group => this.writeColorAttr(
                        selected * 2, encodeVcuColorAttr({ ...cell, group }, cellByte))),
                    nls.localize(
                        'vueport/debug/panels/characters/cellGroupHint',
                        'The palette group BGMap cells with CHRSEL draw this character in: '
                        + 'CRAM palette group × 4 + the cell\'s GPLTS')
                )}
                {control(
                    nls.localize('vueport/debug/panels/characters/objectGroup', 'OBJ Group'),
                    numberInput(object.group, 0, 0x3f, group => this.writeColorAttr(
                        selected * 2 + 1, encodeVcuColorAttr({ ...object, group }, objectByte))),
                    nls.localize(
                        'vueport/debug/panels/characters/objectGroupHint',
                        'The palette group objects with CHRSEL draw this character in: '
                        + 'CRAM palette group × 4 + the object\'s JPLTS')
                )}
                {control(
                    nls.localize('vueport/debug/panels/characters/pce', 'PCE'),
                    <Switch
                        label={nls.localize('vueport/debug/panels/characters/pce', 'PCE')}
                        value={pixel.enabled}
                        onChange={enabled => this.writePixelAttr(
                            encodeVcuPixelAttr({ ...pixel, enabled }, pixelWord))}
                    />,
                    nls.localize(
                        'vueport/debug/panels/characters/pceHint',
                        'Take the pixels\' palettes from the Pixel Color Slot below — '
                        + 'only while CXCTRL.PCEN is set as well')
                )}
                {control(
                    nls.localize('vueport/debug/panels/characters/slot', 'Slot'),
                    numberInput(pixel.slot, 0, VCU_PIXEL_SLOT_COUNT - 1, slot => this.writePixelAttr(
                        encodeVcuPixelAttr({ ...pixel, slot }, pixelWord))),
                    nls.localize(
                        'vueport/debug/panels/characters/slotHint',
                        'Which of the 1024 Pixel Color Slots PCE uses')
                )}
                {control(
                    nls.localize('vueport/debug/panels/characters/opq', 'OPQ'),
                    <Switch
                        label={nls.localize('vueport/debug/panels/characters/opq', 'OPQ')}
                        value={pixel.opaque}
                        onChange={opaque => this.writePixelAttr(
                            encodeVcuPixelAttr({ ...pixel, opaque }, pixelWord))}
                    />,
                    nls.localize(
                        'vueport/debug/panels/characters/opqHint',
                        'Pixel value 0 is drawn rather than transparent')
                )}
            </div>
            {/* what is switched off, in the order it matters: without CCEN none of the group is read, without PCEN only
                PCE */}
            {!vbc.ccen
                ? <span className='hint'>{nls.localize(
                    'vueport/debug/panels/characters/ccenOff',
                    'Not in effect: CXCTRL.CCEN is off. Used by cells and objects with CHRSEL once it is on.'
                )}</span>
                : <span className='hint'>{nls.localize(
                    'vueport/debug/panels/characters/ccenOn',
                    'Used by cells and objects whose Color Attribute has CHRSEL.'
                )}{!vbc.pcen && ` ${nls.localize(
                    'vueport/debug/panels/characters/pcenOff',
                    'PCE has no effect while CXCTRL.PCEN is off.'
                )}`}</span>}
        </fieldset>;
    }

    protected writeColorAttr(offset: number, value: number): void {
        this.writeVcu(VCU_CHARACTER_COLOR_BASE + offset, [value & 0xff]);
    }

    protected writePixelAttr(value: number): void {
        this.writeVcu(VCU_CHARACTER_PIXEL_ATTR_BASE + this.selected * 2, [value & 0xff, (value >> 8) & 0xff]);
    }

    // reads the change straight back, or the next poll would briefly show the old value
    protected writeVcu(address: number, bytes: number[]): void {
        if (!this.source.sim) {
            return;
        }
        this.source.write(address, bytes)
            .then(() => this.refresh())
            .catch(() => undefined);
    }

    // a list of places rather than a count, each map with a thumbnail marked where those cells are
    protected renderUsedBy(): React.ReactNode {
        const objects = this.usage?.objectCount(this.selected) ?? 0;
        const maps = this.mapPreviews;

        return <fieldset className='vp-inspector-group vp-characters-used-by'>
            <legend>{nls.localize('vueport/debug/panels/characters/usedBy', 'Used by')}</legend>
            {/* the maps scroll within the group, or a character used in many would push the Display controls off the
                bottom */}
            <div className='vp-characters-used-by-body vp-scroll'>
                {maps.map(({ key, label, note, cells, image }) =>
                    <div className='vp-characters-map' key={key}>
                        {/* not the shared field(), as this row has three parts: who, where, and how often */}
                        <div className='vp-detail-field'>
                            <span className='label'>
                                {label}
                                {note && <span className='hint'>{note}</span>}
                            </span>
                            <span className='value'>{cells === 1
                                ? nls.localize('vueport/debug/panels/characters/usedByOneCell', '1 cell')
                                : nls.localize('vueport/debug/panels/characters/usedByCells', '{0} cells', cells)}
                            </span>
                        </div>
                        {image && <VipCanvas image={image} zoom={mapPreviewZoom(image)} />}
                    </div>)}
                {objects > 0 && field(
                    nls.localize('vueport/debug/panels/objects/title', 'Objects'),
                    `${objects}`
                )}
                {maps.length === 0 && objects === 0 &&
                    <span className='hint'>{nls.localize(
                        'vueport/debug/panels/characters/usedByNothing',
                        'Nothing being drawn refers to this character.'
                    )}</span>
                }
            </div>
        </fieldset>;
    }

    protected renderDisplayGroup(): React.ReactNode {
        return <fieldset className='vp-inspector-group vp-characters-display'>
            <legend>{nls.localize('vueport/debug/panels/characters/display', 'Display')}</legend>
            {/* what the sheet shows comes first, as it is the one control changing which characters are there to look
                at */}
            <RadioSelect
                options={[{
                    value: 'all',
                    label: nls.localize('vueport/debug/panels/characters/showAll', 'All'),
                }, {
                    value: 'used',
                    label: nls.localize('vueport/debug/panels/characters/showUsed', 'Used'),
                    tooltip: nls.localize(
                        'vueport/debug/panels/characters/showUsedHint',
                        'Only the characters a drawn BGMap cell or a switched-on object refers to'),
                }, {
                    value: 'changed',
                    label: nls.localize('vueport/debug/panels/characters/showChanged', 'Changed'),
                    tooltip: nls.localize(
                        'vueport/debug/panels/characters/showChangedHint',
                        'Only the characters whose pixels were rewritten in the last second'),
                }]}
                defaultValue={this.filter}
                onChange={options => this.setFilter(options[0].value as CharacterFilter)}
                fitSpace
            />
            {/* the two sliders share one grid, so names, tracks and readouts line up as three columns */}
            <div className='vp-characters-ranges'>
                <label>
                    <span>{nls.localize('vueport/debug/panels/characters/columns', 'Columns')}</span>
                    <input
                        type='range'
                        min={0}
                        max={CHARS_PER_ROW_OPTIONS.length - 1}
                        value={CHARS_PER_ROW_OPTIONS.indexOf(this.charsPerRow)}
                        onChange={e => this.setCharsPerRow(CHARS_PER_ROW_OPTIONS[parseInt(e.target.value, 10)])}
                    />
                    <span className='hint'>{this.charsPerRow}</span>
                </label>
                <label>
                    <span>{nls.localize('vueport/debug/panels/characters/scale', 'Scale')}</span>
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
            {/* the VB Color switch only while the game has VB Color colors to draw with */}
            <div className='vp-characters-toggles'>
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/characters/grid', 'Grid'),
                    this.showGrid,
                    on => {
                        this.showGrid = this.remember('showGrid', on);
                        this.update();
                    }
                )}
                {this.renderToggle(
                    nls.localize('vueport/debug/panels/characters/segments', 'Segments'),
                    this.showSegments,
                    on => {
                        this.showSegments = this.remember('showSegments', on);
                        this.update();
                    }
                )}
                {this.vbc && this.renderToggle(
                    nls.localize('vueport/debug/panels/characters/vbColorPreview', 'Colorized'),
                    this.vbColorPreview,
                    on => this.setVbColorPreview(on),
                    nls.localize(
                        'vueport/debug/panels/characters/vbColorPreviewHint',
                        "Draw in the colors the VB Color shows rather than the VIP's red")
                )}
            </div>
            {this.exportFile &&
                <button
                    type='button'
                    className='vp-button secondary vp-characters-export'
                    title={nls.localize(
                        'vueport/debug/panels/characters/exportPngHint',
                        'Save the whole sheet as a PNG, at its own size and unfiltered')}
                    onClick={() => { this.exportPng().catch(() => undefined); }}
                >
                    {nls.localize('vueport/debug/panels/characters/exportPng', 'Export PNG')}
                </button>
            }
        </fieldset>;
    }

    // switches, as these take effect at once, laid out like the SRAM panel's: control, then name
    protected renderToggle(
        label: string, value: boolean, onChange: (value: boolean) => void, hint?: string
    ): React.ReactNode {
        return <span className='vp-characters-toggle' title={hint}>
            <Switch label={label} value={value} onChange={onChange} />
            <span>{label}</span>
        </span>;
    }

    protected onPanelKey(event: React.KeyboardEvent): void {
        if (arrowKeysTaken(event.target, event.currentTarget)) {
            return;
        }
        this.onAtlasKey(event);
    }

    // a character, a row or a segment at a time, or to either end. Stopped rather than only defaulted, as the
    // emulator listens for keys around this panel and would read an arrow as the D-pad; other keys carry on
    protected onAtlasKey(event: React.KeyboardEvent): void {
        const steps: Record<string, number> = {
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -this.charsPerRow,
            ArrowDown: this.charsPerRow,
            PageUp: -VIP_CHARS_PER_SEGMENT,
            PageDown: VIP_CHARS_PER_SEGMENT,
        };
        const step = steps[event.key];
        const home = event.key === 'Home';
        const end = event.key === 'End';
        if (step === undefined && !home && !end) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.selectCharacter(home ? 0 : end ? this.charCount - 1 : this.selected + step);
        this.revealSelection();
    }

    // once drawn, as the selection's element does not exist until the requested render happened
    protected revealSelection(): void {
        this.whenRendered(() => this.node
            .querySelector('.vp-canvas-selection')
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }

    protected renderAtlas(): React.ReactNode {
        const image = this.image;
        if (!image) {
            return undefined;
        }
        if (!this.showSegments) {
            return this.renderCanvas(image, 0);
        }
        // as wide as the sheet under it, so the rule divides the sheet rather than the panel's room
        const width = image.width * this.zoom;
        return <div className='vp-characters-segments'>
            {this.segmentImages.map((segmentImage, segment) => {
                const first = segment * VIP_CHARS_PER_SEGMENT;
                const last = first + VIP_CHARS_PER_SEGMENT - 1;
                return <React.Fragment key={segment}>
                    <div
                        className='vp-characters-segment-heading'
                        style={{ width }}
                        title={segment >= VIP_CHAR_SEGMENTS.length
                            ? extensionHint()
                            : undefined}
                    >
                        <span className='label'>
                            {segment >= VIP_CHAR_SEGMENTS.length
                                ? nls.localize('vueport/debug/panels/characters/segmentNumberExtended',
                                    'Segment {0} (CHREXT)', segment)
                                : nls.localize('vueport/debug/panels/characters/segmentNumber', 'Segment {0}', segment)}
                        </span>
                        <span className='rule' />
                        {/* at scale 1 the sheet is narrower than this line, and the range repeats what the Char field
                            says */}
                        {this.zoom > 1 &&
                            <span className='range'>
                                {`${`${first}`.padStart(4, '0')}–${`${last}`.padStart(4, '0')}`}
                            </span>}
                    </div>
                    {this.renderCanvas(segmentImage, first)}
                </React.Fragment>;
            })}
        </div>;
    }

    // a canvas only knows its own range, so outline and clicks are offset by `first` both ways
    protected renderCanvas(image: ImageData, first: number): React.ReactNode {
        const offset = this.selected - first;
        const count = (image.width / VIP_CHAR_SIZE) * (image.height / VIP_CHAR_SIZE);
        const holdsSelection = offset >= 0 && offset < count;
        return <VipCanvas
            image={image}
            zoom={this.zoom}
            cellSize={VIP_CHAR_SIZE}
            showGrid={this.showGrid}
            selected={holdsSelection
                ? { x: offset % this.charsPerRow, y: Math.floor(offset / this.charsPerRow) }
                : undefined}
            onPick={(x, y) => this.selectCharacter(
                first + Math.floor(y / VIP_CHAR_SIZE) * this.charsPerRow + Math.floor(x / VIP_CHAR_SIZE))}
            onHover={point => this.light(point && {
                kind: 'character',
                character: first + Math.floor(point.y / VIP_CHAR_SIZE) * this.charsPerRow + Math.floor(point.x / VIP_CHAR_SIZE),
            })}
        />;
    }
}
