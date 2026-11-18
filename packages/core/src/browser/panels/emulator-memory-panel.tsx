import { Message } from '@lumino/messaging';
import { ArrowUDownLeft, MagnifyingGlass, Plug, PushPin, X } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import {
    isWram, VB_MAX_MEMORY_READ, VB_REGION_BYTES, VB_ROM_BASE, VB_VSU_MAP_BYTES, VB_WRAM_SIZE,
} from '../../common/vb-constants';
import EmptyContainer from '../components/kit/EmptyContainer';
import RadioSelect from '../components/kit/RadioSelect';
import { debounce, Debounced } from '../components/kit/Utils';
import { ancestryOf } from '../core/emulator-classes';
import { findStructMemberAt, VesStruct } from '../core/emulator-dwarf';
import { romOffsetOf } from '../core/emulator-line-table';
import {
    BLOCK_HEADER_BYTES, parseMemoryPoolLayout, readMemoryPoolBlocks, symbolsMatchRunningBuild,
} from '../core/emulator-memory-pool';
import {
    findFunctionAt, findSymbolAt, functionDisplayName, structNameOf, SymbolIndex,
} from '../core/emulator-symbols';
import { Sim } from '../core/vb-core';
import { BYTES_PER_MBIT } from '../emulator-types';
import { DebugSource, EmulatorPanelType, emulatorPanelLabel, hex, Panel } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { ScreenInspectorTarget } from './emulator-screen-inspector';

const BYTES_PER_ROW = 16;

/**
 * One of the eight regions the bus decodes. Every region is VB_REGION_BYTES wide, but what answers is usually far
 * smaller and mirrored (64 KB of WRAM across region 5, a few registers across region 2). `mapped` is that part, which
 * the list walks, as scrolling 16 MB of WRAM would be 256 passes over the same 64 KB. Both sizes are shown, as either
 * alone would misstate the map.
 */
export interface VbMemoryRegion {
    label: string;
    short: string;
    address: number;
    // how much answers before the mirrors start (64 KB of WRAM across region 5), the part the list walks. Zero for
    // cartridge ROM, whose extent is the loaded ROM's size
    mapped: number;
}

// the VCU aperture, only while a VB Color runs; left out rather than grayed, as on an original Virtual Boy
// `0x03000000` is open bus
export const VCU_MEMORY_REGION: VbMemoryRegion = {
    label: 'VCU (VB Color)',
    address: 0x03000000,
    short: 'VCU',
    // Color Framebuffer at the bottom, Color RAM at 0x03079000 and registers above; the upper half holds Pixel Color
    // Extension, World Color Attributes, Backdrop Row Table and Pixel Color Slots; the aperture ends at 0x03100000
    mapped: 0x100000,
};

export const VB_MEMORY_REGIONS: VbMemoryRegion[] = [
    {
        label: 'VIP — Virtual Image Processor',
        address: 0x00000000,
        short: 'VIP',
        // VRAM, world and object attribute blocks, registers at 0x0005F800 and the character mirrors, ending at 0x00080000
        mapped: 0x80000,
    },
    {
        label: 'VSU — Virtual Sound Unit',
        address: 0x01000000,
        short: 'VSU',
        // waveform tables through to SSTOP, rounded up to a whole row
        mapped: Math.ceil(VB_VSU_MAP_BYTES / BYTES_PER_ROW) * BYTES_PER_ROW,
    },
    {
        label: 'Miscellaneous Hardware',
        address: 0x02000000,
        short: 'Regs',
        // link, timer, pad and wait-control registers end at 0x02000027; the round number past them includes the engine's
        // terminal port at 0x02000030 (software, but often looked at)
        mapped: 0x40,
    },
    {
        label: 'Game Pak Expansion',
        address: 0x04000000,
        short: 'EXP',
        // unmapped on a bare machine; an expansion answers at the bottom of the region, where ESSound's one port is
        mapped: 0x40,
    },
    {
        label: 'WRAM',
        address: 0x05000000,
        short: 'WRAM',
        mapped: VB_WRAM_SIZE,
    },
    {
        label: 'Game Pak RAM',
        address: 0x06000000,
        short: 'RAM',
        // the core does not report a cartridge's RAM size, so this is what every Virtual Boy cartridge with a save has
        mapped: 0x2000,
    },
    {
        label: 'Game Pak ROM',
        address: VB_ROM_BASE,
        short: 'ROM',
        mapped: 0,
    },
];

// row height, handed to the CSS as a custom property so the virtualized list and stylesheet cannot drift (one pixel
// off would make rows slide away from the scrollbar further down)
const ROW_HEIGHT = 18;

// the ruler is a row, so its digits stand over their columns. Being sticky it takes a row at the top and then
// covers one when scrolled, so the first row on screen is `scrollTop / ROW_HEIGHT`; revealing at the bottom has
// no such cancellation
const RULER_HEIGHT = ROW_HEIGHT;

const OVERSCAN = 8;

const DEFAULT_VIEWPORT_ROWS = 24;

const FLASH_MS = 700;

const MAX_WATCHES = 16;

// debounce for the search box, as settling Find, the clear cross and the "not found" state per keystroke made
// the toolbar twitch while typing
const SEARCH_SETTLE_MS = 250;

// minimum thumb size for both scrollbars: over a megabyte of cartridge an honest thumb would be under a pixel
const MIN_THUMB = 18;

// how far the scroller is pushed past its clip to hide its vertical scrollbar (see `.vp-memory-clip`); wide enough
// for broad native bars, as Firefox ignores --vp-scrollbar-width
const SCROLLBAR_GUTTER = 20;

// the widest window a read may ask for, as searching a megabyte is round trips of the worker walking the bus
const SEARCH_WINDOW = VB_MAX_MEMORY_READ;

const INSPECT_BYTES = 4;

// bytes per cell of the dump: a byte, a halfword or a word, read little-endian as the V810 does
type MemoryUnit = 1 | 2 | 4;

function memoryUnitOf(value: unknown): MemoryUnit {
    return value === 2 || value === 4 ? value : 1;
}

interface MappedRegion {
    region: VbMemoryRegion;
    // what answers, with the ROM's resolved from the loaded ROM; the part the list walks
    mapped: number;
    rows: number;
    firstRow: number;
}

interface MemoryRow {
    entry: MappedRegion;
    // absent for the caption row a region begins with
    address?: number;
}

interface MemoryChunk {
    address: number;
    bytes: Uint8Array;
}

interface MemoryWhere {
    owner: string;
    offset: number;
    field?: string;
}

// layout of the object's class or the nearest ancestor the build described that fits the block. The Actors panel's
// layoutFor without stopping at Actor, as a hex dump takes any layout that fits (see the comment there)
function layoutFor(index: SymbolIndex, className: string, availableBytes: number): VesStruct | undefined {
    for (const ancestor of ancestryOf(index.classes, className)) {
        const struct = index.structs.get(structNameOf(ancestor));
        if (struct && struct.byteSize <= availableBytes) {
            return struct;
        }
    }
    return undefined;
}

interface MemoryNeedle {
    bytes: Uint8Array;
    // letters match either case; set for a typed text needle, whose bytes are already lower case, the memory being
    // folded byte by byte to match
    folded: boolean;
}

function fold(byte: number): number {
    return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

function textNeedle(text: string): MemoryNeedle {
    const bytes = new TextEncoder().encode(text);
    for (let at = 0; at < bytes.length; at++) {
        bytes[at] = fold(bytes[at]);
    }
    return { bytes, folded: true };
}

function sizeOf(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb.toLocaleString('en-US', { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
}

/**
 * Hex view of the whole memory map as one virtualized list, regions end to end behind captions, reading only what is on
 * screen. The region in view drives the map bar, and picking one there scrolls to it. Reads go through the CPU's view,
 * so mirrors and registers read as the program sees them. Writes go through DebugSource.write, as in the VIP editors,
 * so a poke reaches both machines in a linked session.
 */
export class MemoryPanel extends Panel {

    protected address = this.remembered('address', 0x05000000);
    // the byte the inspector strip is reading, if any. Not aligned to the unit: a search lands on the byte it found,
    // and the cell holding it is what is highlighted and typed over
    protected selected?: number;
    protected unit = memoryUnitOf(this.remembered('unit', 1));

    protected map: MappedRegion[] = [];
    protected totalRows = 0;
    protected mapSignature?: string;

    protected chunks: MemoryChunk[] = [];
    protected selectedBytes?: Uint8Array;
    // read for the watch list, coalesced into as few reads as possible
    protected watchChunks: MemoryChunk[] = [];
    protected readonly changedAt = new Map<number, number>();

    protected watches: number[] = [];

    protected where?: MemoryWhere;
    protected whereFor?: number;

    // lags the box by SEARCH_SETTLE_MS; the box is uncontrolled like the address box, so a redraw ten times a second
    // cannot reach what is being typed
    protected search = '';
    protected searchMissed = false;
    protected searching = false;
    protected readonly searchInput = React.createRef<HTMLInputElement>();
    protected readonly settleSearch: Debounced<[string]> = debounce((text: string) => {
        this.search = text;
        this.searchMissed = false;
        this.update();
    }, SEARCH_SETTLE_MS);

    // the digits of a cell being typed over, before the last arrives
    protected pending?: { address: number, value: number, digits: number };

    protected scroller?: HTMLDivElement;
    protected scrollTop = 0;
    protected viewportHeight = 0;
    protected resize?: ResizeObserver;
    // the region scrubber's width in pixels: with a minimum thumb size, the thumb's position is a length along the
    // track minus the thumb, not a percentage
    protected locatorWidth = 0;
    protected locatorResize?: ResizeObserver;
    // a scroll position to apply once the rows behind it have been rendered
    protected pendingScrollTop?: number;

    // where in its thumb each scrollbar was grabbed while dragged; undefined when not held
    protected railGrab?: number;
    protected locatorGrab?: number;
    // the region being scrubbed, held for the drag, as a rounding that put the top row a byte outside it would hand
    // the rest of the drag to its neighbour
    protected locatorEntry?: MappedRegion;

    protected reading = false;
    protected readAgain = false;

    // uncontrolled so polling cannot overwrite a half-typed address; its value lives in the DOM and is synced after
    // each render only while nobody types (see onUpdateRequest)
    protected readonly addressInput = React.createRef<HTMLInputElement>();

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.MEMORY, source, instanceId);
        this.title.label = emulatorPanelLabel(EmulatorPanelType.MEMORY);
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.MEMORY);
        this.watches = this.readWatches();
    }

    // lays the regions out if their makings changed: the ROM's extent on load, the VCU with the hardware gate
    protected rebuildMap(): void {
        const romBytes = Math.max(0, this.source.romSize) * BYTES_PER_MBIT;
        const signature = `${romBytes}:${this.source.vbcHardwareActive}`;
        if (signature === this.mapSignature) {
            return;
        }
        const first = this.mapSignature === undefined;
        this.mapSignature = signature;

        // by address, so the list reads up the memory map; the VCU sits between hardware registers and cartridge expansion
        const regions = (this.source.vbcHardwareActive
            ? [...VB_MEMORY_REGIONS, VCU_MEMORY_REGION]
            : [...VB_MEMORY_REGIONS]).sort((a, b) => a.address - b.address);

        let row = 0;
        this.map = [];
        for (const region of regions) {
            const mapped = region.address === VB_ROM_BASE ? romBytes : region.mapped;
            if (mapped <= 0) {
                // a region with nothing behind it is still offered, disabled, in the map bar; only the list leaves it out
                continue;
            }
            const rows = Math.ceil(mapped / BYTES_PER_ROW);
            this.map.push({ region, mapped, rows, firstRow: row });
            row += rows + 1;
        }
        this.totalRows = row;

        if (first && this.map.length > 0) {
            this.scrollToRow(this.rowOf(this.canonical(this.address) ?? this.map[0].region.address));
        }
    }

    // by the three bits the bus decodes
    protected entryOf(address: number): MappedRegion | undefined {
        const region = (address >>> 24) & 7;
        return this.map.find(entry => ((entry.region.address >>> 24) & 7) === region);
    }

    // an address as the list holds it: every region mirrors across its 16 MB, so e.g. the interrupt vectors at
    // `0xFFFFFE00` land on the top of the cartridge ROM. Undefined for an empty region (`0x03000000` without VB Color)
    protected canonical(address: number): number | undefined {
        const entry = this.entryOf(address);
        if (!entry || entry.mapped <= 0) {
            return undefined;
        }
        return (entry.region.address + ((address >>> 0) & 0x00ffffff) % entry.mapped) >>> 0;
    }

    protected rowAt(index: number): MemoryRow | undefined {
        for (const entry of this.map) {
            if (index >= entry.firstRow + 1 + entry.rows) {
                continue;
            }
            if (index < entry.firstRow) {
                return undefined;
            }
            if (index === entry.firstRow) {
                return { entry };
            }
            const offset = (index - entry.firstRow - 1) * BYTES_PER_ROW;
            return { entry, address: (entry.region.address + offset) >>> 0 };
        }
        return undefined;
    }

    protected rowOf(address: number): number {
        const entry = this.entryOf(address);
        if (!entry) {
            return 0;
        }
        return entry.firstRow + 1 + Math.floor((address - entry.region.address) / BYTES_PER_ROW);
    }

    protected rowsInView(): number {
        const height = this.viewportHeight || DEFAULT_VIEWPORT_ROWS * ROW_HEIGHT;
        return Math.max(1, Math.ceil(height / ROW_HEIGHT));
    }

    protected firstRenderedRow(): number {
        return Math.max(0, Math.floor(this.scrollTop / ROW_HEIGHT) - OVERSCAN);
    }

    protected renderedRows(): number {
        return this.rowsInView() + OVERSCAN * 2;
    }

    protected topAddress(): number | undefined {
        const first = Math.floor(this.scrollTop / ROW_HEIGHT);
        for (let row = first; row < Math.min(this.totalRows, first + this.rowsInView() + 1); row++) {
            const at = this.rowAt(row);
            if (at?.address !== undefined) {
                return at.address;
            }
        }
        return this.map[0]?.region.address;
    }

    protected scrollToRow(row: number): void {
        // a third of the way down: an address jumped to usually wants the bytes before it too
        this.pendingScrollTop = Math.max(0, (row - Math.floor(this.rowsInView() / 3)) * ROW_HEIGHT);
    }

    protected revealRow(row: number): void {
        const first = Math.ceil(this.scrollTop / ROW_HEIGHT);
        const last = Math.floor(
            (this.scrollTop + (this.viewportHeight || 0) - RULER_HEIGHT) / ROW_HEIGHT) - 1;
        if (row < first) {
            this.pendingScrollTop = row * ROW_HEIGHT;
        } else if (row > last) {
            this.pendingScrollTop = Math.max(0,
                RULER_HEIGHT + (row + 1) * ROW_HEIGHT - (this.viewportHeight || ROW_HEIGHT));
        }
    }

    // put a row directly under the ruler, where a scrubber aims
    protected pinRowToTop(row: number): void {
        const target = Math.max(0, row * ROW_HEIGHT);
        if (this.scroller) {
            this.scroller.scrollTop = target;
        } else {
            this.pendingScrollTop = target;
        }
    }

    protected currentEntry(): MappedRegion | undefined {
        const top = this.topAddress();
        return top === undefined ? undefined : this.entryOf(top);
    }

    // own scrollbars: a native one over a list a million pixels tall rounds its thumb to nothing (as perfect-scrollbar
    // did); the map rail has a minimum thumb and shows regions as bands. The horizontal one moves within the region

    protected railThumb(height: number): { top: number, size: number, span: number } {
        const total = this.totalRows * ROW_HEIGHT;
        const size = Math.min(height,
            Math.max(MIN_THUMB, total > 0 ? (height * height) / total : height));
        const span = Math.max(0, height - size);
        const scrollable = Math.max(0, total - height);
        return { top: scrollable > 0 ? (this.scrollTop / scrollable) * span : 0, size, span };
    }

    protected grabRail(event: React.PointerEvent<HTMLDivElement>): void {
        const box = event.currentTarget.getBoundingClientRect();
        const { top, size } = this.railThumb(box.height);
        const at = event.clientY - box.top;
        // grabbed by the thumb, it drags from where it was held; elsewhere, it jumps to the pointer, held by its middle
        this.railGrab = at >= top && at < top + size ? at - top : size / 2;
        event.currentTarget.setPointerCapture(event.pointerId);
        this.scrubRail(box, event.clientY);
        this.update();
    }

    protected scrubRail(box: DOMRect, clientY: number): void {
        if (this.railGrab === undefined || !this.scroller) {
            return;
        }
        const { span } = this.railThumb(box.height);
        const scrollable = Math.max(0, this.totalRows * ROW_HEIGHT - box.height);
        const top = Math.max(0, Math.min(span, clientY - box.top - this.railGrab));
        // straight at the element: its scroll event redraws the rows, so a drag stays as responsive as a wheel
        this.scroller.scrollTop = span > 0 ? (top / span) * scrollable : 0;
    }

    protected locatorThumb(
        width: number, entry: MappedRegion
    ): { left: number, size: number, span: number, scrollable: number } {
        const visible = this.rowsInView() * BYTES_PER_ROW;
        const share = entry.mapped > 0 ? Math.min(1, visible / entry.mapped) : 1;
        const size = Math.min(width, Math.max(MIN_THUMB, share * width));
        const span = Math.max(0, width - size);
        const scrollable = Math.max(0, entry.mapped - visible);
        const top = this.topAddress();
        const offset = top === undefined ? 0 : top - entry.region.address;
        const left = scrollable > 0
            ? Math.max(0, Math.min(1, offset / scrollable)) * span
            : 0;
        return { left, size, span, scrollable };
    }

    protected grabLocator(event: React.PointerEvent<HTMLDivElement>): void {
        const entry = this.currentEntry();
        if (!entry) {
            return;
        }
        const box = event.currentTarget.getBoundingClientRect();
        const { left, size } = this.locatorThumb(box.width, entry);
        const at = event.clientX - box.left;
        this.locatorEntry = entry;
        this.locatorGrab = at >= left && at < left + size ? at - left : size / 2;
        event.currentTarget.setPointerCapture(event.pointerId);
        this.scrubLocator(box, event.clientX);
        this.update();
    }

    protected scrubLocator(box: DOMRect, clientX: number): void {
        const entry = this.locatorEntry;
        if (this.locatorGrab === undefined || !entry) {
            return;
        }
        const { span, scrollable } = this.locatorThumb(box.width, entry);
        const left = Math.max(0, Math.min(span, clientX - box.left - this.locatorGrab));
        const offset = span > 0 ? Math.round((left / span) * scrollable) : 0;
        this.pinRowToTop(this.rowOf(entry.region.address + offset));
    }

    protected releaseDrag(event: React.PointerEvent<HTMLDivElement>): void {
        this.railGrab = undefined;
        this.locatorGrab = undefined;
        this.locatorEntry = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        this.update();
    }

    protected readonly setScroller = (element: HTMLDivElement | null): void => {
        if (element === this.scroller) {
            return;
        }
        this.resize?.disconnect();
        this.resize = undefined;
        this.scroller = element ?? undefined;
        if (!element) {
            return;
        }
        this.viewportHeight = element.clientHeight;
        this.resize = new ResizeObserver(() => {
            if (this.scroller && this.scroller.clientHeight !== this.viewportHeight) {
                this.viewportHeight = this.scroller.clientHeight;
                this.update();
            }
        });
        this.resize.observe(element);
    };

    protected readonly setLocator = (element: HTMLDivElement | null): void => {
        this.locatorResize?.disconnect();
        this.locatorResize = undefined;
        if (!element) {
            return;
        }
        this.locatorWidth = element.clientWidth;
        this.locatorResize = new ResizeObserver(() => {
            if (element.clientWidth !== this.locatorWidth) {
                this.locatorWidth = element.clientWidth;
                this.update();
            }
        });
        this.locatorResize.observe(element);
    };

    protected onScrolled(element: HTMLDivElement): void {
        if (element.scrollTop === this.scrollTop) {
            return;
        }
        this.scrollTop = element.scrollTop;
        const top = this.topAddress();
        if (top !== undefined) {
            this.address = this.remember('address', top);
        }
        this.update();
        this.poll();
    }

    protected onUpdateRequest(msg: Message): void {
        super.onUpdateRequest(msg);

        const scroller = this.scroller;
        const target = this.pendingScrollTop;
        if (scroller && target !== undefined) {
            this.pendingScrollTop = undefined;
            scroller.scrollTop = target;
            this.scrollTop = scroller.scrollTop;
            // again after the frame: a jump made while the map grows (a ROM finishing loading) would otherwise be clamped to
            // the list's old height
            requestAnimationFrame(() => {
                if (this.scroller && this.scroller.scrollTop !== target) {
                    this.scroller.scrollTop = target;
                    this.scrollTop = this.scroller.scrollTop;
                    this.update();
                }
            });
        }

        const box = this.addressInput.current;
        if (box && box.ownerDocument.activeElement !== box) {
            const wanted = hex(this.selected ?? this.address, 8);
            if (box.value !== wanted) {
                box.value = wanted;
            }
        }
    }

    protected onBeforeDetach(msg: Message): void {
        this.resize?.disconnect();
        this.resize = undefined;
        this.locatorResize?.disconnect();
        this.locatorResize = undefined;
        // a keystroke still in the air would land on a panel that has gone
        this.settleSearch.cancel();
        super.onBeforeDetach(msg);
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.chunks = [];
            this.watchChunks = [];
            this.selectedBytes = undefined;
            this.mapSignature = undefined;
            this.update();
            return;
        }
        if (this.reading) {
            // scrolling can ask faster than reads return; remembering it asked stops a fling settling on an unfetched window
            this.readAgain = true;
            return;
        }

        this.reading = true;
        try {
            do {
                this.readAgain = false;
                this.rebuildMap();
                await this.read(sim);
            } while (this.readAgain);
        } finally {
            this.reading = false;
        }
        this.update();
    }

    protected async read(sim: Sim): Promise<void> {
        const chunks: MemoryChunk[] = [];
        for (const run of this.visibleRuns()) {
            chunks.push({
                address: run.address,
                bytes: new Uint8Array(await sim.readMemory(run.address, run.length)),
            });
        }
        this.noteChanges(chunks);
        this.chunks = chunks;

        if (this.selected !== undefined) {
            this.selectedBytes = new Uint8Array(await sim.readMemory(this.selected, INSPECT_BYTES));
            // only when the selection moves: naming it needs the symbol table, and for a pooled object the whole heap
            if (this.whereFor !== this.selected) {
                this.whereFor = this.selected;
                this.where = await this.describe(sim, this.selected);
            }
        } else {
            this.selectedBytes = undefined;
            this.where = undefined;
            this.whereFor = undefined;
        }

        const watchChunks: MemoryChunk[] = [];
        for (const run of this.watchRuns()) {
            watchChunks.push({
                address: run.address,
                bytes: new Uint8Array(await sim.readMemory(run.address, run.length)),
            });
        }
        this.watchChunks = watchChunks;
    }

    protected visibleRuns(): { address: number, length: number }[] {
        const runs: { address: number, length: number }[] = [];
        const first = this.firstRenderedRow();
        const last = Math.min(this.totalRows, first + this.renderedRows());
        for (let row = first; row < last; row++) {
            const at = this.rowAt(row);
            if (!at || at.address === undefined) {
                continue;
            }
            const remaining = at.entry.region.address + at.entry.mapped - at.address;
            const length = Math.min(BYTES_PER_ROW, remaining);
            const previous = runs[runs.length - 1];
            if (previous && previous.address + previous.length === at.address) {
                previous.length += length;
            } else {
                runs.push({ address: at.address, length });
            }
        }
        return runs;
    }

    // coalesced, as watching several fields of one struct is the usual case
    protected watchRuns(): { address: number, length: number }[] {
        const runs: { address: number, length: number }[] = [];
        for (const address of [...this.watches].sort((a, b) => a - b)) {
            const previous = runs[runs.length - 1];
            const end = address + INSPECT_BYTES;
            if (previous && address - (previous.address + previous.length) <= BYTES_PER_ROW * 4
                && (address >>> 24) === (previous.address >>> 24)) {
                previous.length = Math.max(previous.length, end - previous.address);
            } else {
                runs.push({ address, length: INSPECT_BYTES });
            }
        }
        return runs;
    }

    protected byteAt(address: number, chunks: MemoryChunk[] = this.chunks): number | undefined {
        for (const chunk of chunks) {
            const at = address - chunk.address;
            if (at >= 0 && at < chunk.bytes.length) {
                return chunk.bytes[at];
            }
        }
        return undefined;
    }

    protected noteChanges(next: MemoryChunk[]): void {
        const now = Date.now();
        for (const chunk of next) {
            for (let at = 0; at < chunk.bytes.length; at++) {
                const address = chunk.address + at;
                const before = this.byteAt(address);
                if (before !== undefined && before !== chunk.bytes[at]) {
                    this.changedAt.set(address, now);
                }
            }
        }
        for (const [address, when] of this.changedAt) {
            if (now - when > FLASH_MS) {
                this.changedAt.delete(address);
            }
        }
    }

    // the function it is inside (cartridge), the data symbol (anything the linker named), or for other WRAM the live
    // object holding it and its field; only the last reads the machine, which is why this is not run every tick
    protected async describe(sim: Sim, address: number): Promise<MemoryWhere | undefined> {
        const symbols = await this.source.getSymbols();
        if (!symbols) {
            return undefined;
        }

        const romBytes = Math.max(0, this.source.romSize) * BYTES_PER_MBIT;
        if (((address >>> 24) & 7) === 7 && romBytes > 0) {
            const found = findFunctionAt(symbols, address, romBytes);
            if (found) {
                return {
                    owner: functionDisplayName(symbols, found.name),
                    offset: romOffsetOf(address, romBytes) - romOffsetOf(found.address, romBytes),
                };
            }
        }

        const data = findSymbolAt(symbols, address);
        if (data) {
            return { owner: data.symbol.name.replace(/^_/, ''), offset: data.offset };
        }

        return this.describeOccupant(sim, symbols, address);
    }

    protected async describeOccupant(
        sim: Sim, symbols: SymbolIndex, address: number
    ): Promise<MemoryWhere | undefined> {
        if (!isWram(address) || !symbols.memoryPool || symbols.structs.size === 0) {
            return undefined;
        }
        try {
            const region = new Uint8Array(
                await sim.readMemory(symbols.memoryPool.address, symbols.memoryPool.size));
            const layout = parseMemoryPoolLayout(symbols.memoryPool.address, region);
            // the same check as the Actors panel: from another build every offset would be wrong
            if (!layout || !symbolsMatchRunningBuild(layout, symbols.vTables)) {
                return undefined;
            }
            const block = readMemoryPoolBlocks(layout, region).find(candidate =>
                address >= candidate.objectAddress
                && address < candidate.address + candidate.blockSize);
            if (!block) {
                return undefined;
            }
            const className = symbols.vTables.get(block.vTable);
            if (className === undefined) {
                return undefined;
            }
            const offset = address - block.objectAddress;
            const struct = layoutFor(symbols, className, block.blockSize - BLOCK_HEADER_BYTES);
            return {
                owner: className,
                offset,
                field: struct ? findStructMemberAt(struct, offset)?.path : undefined,
            };
        } catch {
            // the heap is read from the machine, which can go away meanwhile; the strip then says less
            return undefined;
        }
    }

    protected goto(address: number, select = true): void {
        const canonical = this.canonical(address);
        if (canonical === undefined) {
            return;
        }
        this.address = this.remember('address', canonical);
        if (select) {
            this.selected = canonical;
            this.pending = undefined;
        }
        this.scrollToRow(this.rowOf(canonical));
        this.update();
        this.poll();
    }

    // ignores anything that is not an address: typing is how it is edited, so silently doing nothing on half-finished
    // input is right
    protected gotoTypedAddress(): void {
        const typed = this.addressInput.current?.value.trim().replace(/^0x/i, '') ?? '';
        // parseInt would take "12nonsense" as 0x12; only entirely hex digits count
        if (!/^[0-9a-f]+$/i.test(typed)) {
            return;
        }
        this.goto(parseInt(typed, 16));
    }

    // for the map bar: the caption row pinned at the top, not a third down like goto, or the top of the view (which
    // the map bar reads) would be in the region above; pressing WRAM would light up Game Pak Expansion
    protected gotoRegion(region: VbMemoryRegion): void {
        const entry = this.map.find(placed => placed.region.address === region.address);
        if (!entry) {
            return;
        }
        this.address = this.remember('address', entry.region.address);
        this.pinRowToTop(entry.firstRow);
        this.update();
        this.poll();
    }

    reveal(target: ScreenInspectorTarget): void {
        if (target.kind === 'memory') {
            this.select(target.address >>> 0);
        }
    }

    protected select(address: number): void {
        this.selected = address;
        this.pending = undefined;
        this.address = this.remember('address', address);
        this.update();
        this.poll();
    }

    // the cell an address falls in; regions start on a row, so cells never straddle one
    protected cellOf(address: number): number {
        return (address - (address % this.unit)) >>> 0;
    }

    protected setUnit(unit: MemoryUnit): void {
        this.unit = memoryUnitOf(this.remember('unit', unit));
        this.pending = undefined;
        this.update();
    }

    protected moveSelection(by: number): void {
        if (this.selected === undefined) {
            return;
        }
        const entry = this.entryOf(this.selected);
        if (!entry) {
            return;
        }
        const low = entry.region.address;
        const high = low + entry.mapped - this.unit;
        const next = Math.min(high, Math.max(low, this.cellOf(this.selected) + by));
        this.selected = next >>> 0;
        this.pending = undefined;
        this.address = this.remember('address', this.selected);
        this.revealRow(this.rowOf(this.selected));
        this.update();
        this.poll();
    }

    // a nibble at a time: the digits typed so far are held and shown in place of the cell until the last, so a
    // half-entered write is visible. The cell is written whole, low byte first
    protected async typeNibble(digit: number): Promise<void> {
        if (this.selected === undefined) {
            return;
        }
        const address = this.cellOf(this.selected);
        const typed = this.pending?.address === address ? this.pending : { address, value: 0, digits: 0 };
        // multiplied rather than shifted, as a word's top nibble would turn the value negative
        const value = typed.value * 16 + digit;
        const digits = typed.digits + 1;
        if (digits < this.unit * 2) {
            this.pending = { address, value, digits };
            this.update();
            return;
        }
        this.pending = undefined;
        await this.source.write(address,
            Array.from({ length: this.unit }, (unused, at) => (value >>> (at * 8)) & 0xff));
        this.moveSelection(this.unit);
    }

    protected onRowsKeyDown(event: React.KeyboardEvent): void {
        const handled = (): void => {
            event.preventDefault();
            // the emulator listens for keys on an ancestor and treats anything not typed into a field as game input
            event.stopPropagation();
        };

        if (event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }

        switch (event.key) {
            case 'ArrowLeft': handled(); this.moveSelection(-this.unit); return;
            case 'ArrowRight': handled(); this.moveSelection(this.unit); return;
            case 'ArrowUp': handled(); this.moveSelection(-BYTES_PER_ROW); return;
            case 'ArrowDown': handled(); this.moveSelection(BYTES_PER_ROW); return;
            case 'PageUp': handled(); this.moveSelection(-BYTES_PER_ROW * this.rowsInView()); return;
            case 'PageDown': handled(); this.moveSelection(BYTES_PER_ROW * this.rowsInView()); return;
            case 'Escape':
                if (this.pending) {
                    handled();
                    this.pending = undefined;
                    this.update();
                }
                return;
        }

        if (/^[0-9a-fA-F]$/.test(event.key)) {
            handled();
            this.typeNibble(parseInt(event.key, 16));
        }
    }

    protected readWatches(): number[] {
        return this.remembered('watches', '')
            .split(',')
            .map(text => parseInt(text, 16))
            .filter(address => Number.isFinite(address))
            .map(address => address >>> 0)
            .slice(0, MAX_WATCHES);
    }

    protected setWatches(watches: number[]): void {
        this.watches = watches;
        this.remember('watches', watches.map(address => hex(address, 8)).join(','));
        this.update();
        this.poll();
    }

    protected toggleWatch(address: number): void {
        if (this.watches.includes(address)) {
            this.setWatches(this.watches.filter(watched => watched !== address));
        } else if (this.watches.length < MAX_WATCHES) {
            this.setWatches([...this.watches, address]);
        }
    }

    // read as bytes where possible, else text; hex wins a tie (`2A` is far more often a byte), quotes force text. Text
    // matches case-insensitively, as a string appears shouted in a ROM header and mixed-case in a message; bytes match
    // exactly
    protected parseNeedle(text: string): MemoryNeedle | undefined {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return undefined;
        }
        const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed);
        if (quoted) {
            return quoted[1].length > 0 ? textNeedle(quoted[1]) : undefined;
        }
        const digits = trimmed.replace(/^0x/i, '').replace(/\s+/g, '');
        if (/^[0-9a-f]+$/i.test(digits) && digits.length % 2 === 0) {
            const bytes = new Uint8Array(digits.length / 2);
            for (let at = 0; at < bytes.length; at++) {
                bytes[at] = parseInt(digits.slice(at * 2, at * 2 + 2), 16);
            }
            return { bytes, folded: false };
        }
        return textNeedle(trimmed);
    }

    // the whole map once round from just past the cursor; regions are not contiguous, so it walks segments, and the
    // starting one comes round again for the part behind the cursor
    protected searchSegments(from: number): { address: number, end: number }[] {
        const entry = this.entryOf(from) ?? this.map[0];
        if (!entry) {
            return [];
        }
        const start = this.map.indexOf(entry);
        const segments: { address: number, end: number }[] = [
            { address: from, end: entry.region.address + entry.mapped },
        ];
        for (let step = 1; step < this.map.length; step++) {
            const next = this.map[(start + step) % this.map.length];
            segments.push({ address: next.region.address, end: next.region.address + next.mapped });
        }
        segments.push({ address: entry.region.address, end: from });
        return segments.filter(segment => segment.end > segment.address);
    }

    // empty the box, the one thing that writes to it from here
    protected clearSearch(): void {
        this.settleSearch.cancel();
        this.search = '';
        this.searchMissed = false;
        if (this.searchInput.current) {
            this.searchInput.current.value = '';
        }
        this.update();
    }

    protected async findNext(): Promise<void> {
        const sim = this.source.sim;
        const needle = this.parseNeedle(this.search);
        if (!sim || !needle || needle.bytes.length === 0 || this.searching) {
            return;
        }
        this.searching = true;
        this.searchMissed = false;
        this.update();
        try {
            const from = ((this.selected ?? this.address ?? 0) + 1) >>> 0;
            for (const segment of this.searchSegments(from)) {
                const found = await this.scan(sim, segment, needle);
                if (found !== undefined) {
                    this.goto(found);
                    return;
                }
            }
            this.searchMissed = true;
        } catch (error) {
            // the box says nothing was found either way; the reason goes where it can be read
            console.error('[emulator] the memory search could not finish:', error);
            this.searchMissed = true;
        } finally {
            this.searching = false;
            this.update();
        }
    }

    protected async scan(
        sim: Sim, segment: { address: number, end: number }, needle: MemoryNeedle
    ): Promise<number | undefined> {
        const wanted = needle.bytes;
        // a match can straddle windows, so each reaches back a needle-worth into the previous; the overlap comes out of
        // the step, as the window may not grow
        const step = Math.max(1, SEARCH_WINDOW - (wanted.length - 1));
        for (let at = segment.address; at < segment.end; at += step) {
            const length = Math.min(SEARCH_WINDOW, segment.end - at);
            if (length < wanted.length) {
                return undefined;
            }
            const window = new Uint8Array(await sim.readMemory(at, length));
            if (needle.folded) {
                // folded here rather than in the comparison: once per window instead of once per position
                for (let byte = 0; byte < window.length; byte++) {
                    window[byte] = fold(window[byte]);
                }
            }
            for (let start = 0; start + wanted.length <= window.length; start++) {
                let matched = true;
                for (let byte = 0; byte < wanted.length; byte++) {
                    if (window[start + byte] !== wanted[byte]) {
                        matched = false;
                        break;
                    }
                }
                if (matched) {
                    return (at + start) >>> 0;
                }
            }
        }
        return undefined;
    }

    protected render(): React.ReactNode {
        if (!this.source.sim) {
            return <EmptyContainer
                title={nls.localize('vueport/general/notRunning', 'The emulator is not running.')}
                icon={<Plug size={32} />}
            />;
        }

        return <div
            className='vp-memory'
            style={{
                '--vp-memory-row': `${ROW_HEIGHT}px`,
                '--vp-memory-gutter': `${SCROLLBAR_GUTTER}px`,
                '--vp-memory-digits': `${this.unit * 2}`,
            } as React.CSSProperties}
        >
            {this.renderMapBar()}
            {this.renderRows()}
            {this.renderInspector()}
            {this.renderWatches()}
        </div>;
    }

    // the horizontal counterpart to the map rail: moves within the region in view, which a megabyte of cartridge
    // makes awkward to cross otherwise
    protected renderMapBar(): React.ReactNode {
        const top = this.topAddress();
        const here = top !== undefined ? this.entryOf(top) : undefined;
        const regions = this.source.vbcHardwareActive
            ? [...VB_MEMORY_REGIONS, VCU_MEMORY_REGION].sort((a, b) => a.address - b.address)
            : VB_MEMORY_REGIONS;

        const width = this.locatorWidth || 1;
        const thumb = here ? this.locatorThumb(width, here) : undefined;
        const offset = here && top !== undefined ? top - here.region.address : 0;

        return <div className='vp-memory-map'>
            {/* own wrapper: the styled control's class names are generated, so this is the stable handle on its regions,
                which the VCU aperture check relies on */}
            <div className='vp-memory-regions'>
                <div className='vp-memory-region-row'>
                    <RadioSelect
                        options={regions.map(region => ({
                            value: region.short,
                            label: region.short,
                            tooltip: region.label,
                            // offered but unreachable: nothing laid out for it, for the cartridge meaning no ROM is loaded
                            disabled: !this.map.some(entry => entry.region.address === region.address),
                        }))}
                        defaultValue={here?.region.short ?? ''}
                        allowBlank
                        onChange={options => {
                            const picked = regions.find(region => region.short === options[0]?.value);
                            if (picked) {
                                this.gotoRegion(picked);
                            }
                        }}
                    />
                    {this.renderUnitSelect()}
                </div>
                {this.renderToolbar()}
            </div>
            <div className='vp-memory-locator'>
                <div
                    className={`vp-memory-locator-track${this.locatorGrab !== undefined ? ' dragging' : ''}`}
                    ref={this.setLocator}
                    role='scrollbar'
                    aria-orientation='horizontal'
                    aria-label={nls.localize(
                        'vueport/debug/panels/memory/scrubRegion', 'Position within the region')}
                    onPointerDown={e => this.grabLocator(e)}
                    onPointerMove={e => {
                        if (this.locatorGrab !== undefined) {
                            this.scrubLocator(e.currentTarget.getBoundingClientRect(), e.clientX);
                        }
                    }}
                    onPointerUp={e => this.releaseDrag(e)}
                    onPointerCancel={e => this.releaseDrag(e)}
                >
                    {thumb && <div
                        className='vp-memory-locator-thumb'
                        style={{ left: `${thumb.left}px`, width: `${thumb.size}px` }}
                    />}
                </div>
                <span className='vp-memory-locator-text'>
                    {here
                        ? nls.localize('vueport/debug/panels/memory/withinRegion',
                            '0x{0} of 0x{1} mapped', hex(offset, 6), hex(here.mapped, 6))
                        : nls.localize('vueport/debug/panels/memory/nothingMapped', 'Nothing mapped')}
                </span>
            </div>
        </div>;
    }

    protected renderRail(): React.ReactNode {
        if (this.totalRows === 0) {
            return undefined;
        }
        const height = this.viewportHeight || 1;
        const { top, size: thumbHeight } = this.railThumb(height);
        // once, not per band: it walks the rows to find the top address
        const here = this.currentEntry();
        return <div
            className={`vp-memory-rail${this.railGrab !== undefined ? ' dragging' : ''}`}
            role='scrollbar'
            aria-orientation='vertical'
            aria-label={nls.localize('vueport/debug/panels/memory/scrubMap', 'Position in the memory map')}
            onPointerDown={e => this.grabRail(e)}
            onPointerMove={e => {
                if (this.railGrab !== undefined) {
                    this.scrubRail(e.currentTarget.getBoundingClientRect(), e.clientY);
                }
            }}
            onPointerUp={e => this.releaseDrag(e)}
            onPointerCancel={e => this.releaseDrag(e)}
        >
            {this.map.map((entry, index) => <div
                key={entry.region.short}
                className={`vp-memory-rail-band${index % 2 === 1 ? ' alternate' : ''}${entry === here ? ' here' : ''}`}
                style={{
                    top: `${(entry.firstRow / this.totalRows) * 100}%`,
                    height: `${((entry.rows + 1) / this.totalRows) * 100}%`,
                }}
                title={`${entry.region.label} · ${sizeOf(entry.mapped)} mapped`}
            />)}
            <div
                className='vp-memory-rail-thumb'
                style={{ top: `${top}px`, height: `${thumbHeight}px` }}
            />
        </div>;
    }

    protected renderUnitSelect(): React.ReactNode {
        return <RadioSelect
            options={[{
                value: 1,
                label: '8',
                tooltip: nls.localize('vueport/debug/panels/memory/unit8', 'Show 8-bit bytes'),
            }, {
                value: 2,
                label: '16',
                tooltip: nls.localize('vueport/debug/panels/memory/unit16',
                    'Show 16-bit halfwords, low byte first as the V810 reads them'),
            }, {
                value: 4,
                label: '32',
                tooltip: nls.localize('vueport/debug/panels/memory/unit32',
                    'Show 32-bit words, low byte first as the V810 reads them'),
            }]}
            defaultValue={this.unit}
            onChange={options => this.setUnit(memoryUnitOf(options[0]?.value))}
        />;
    }

    protected renderToolbar(): React.ReactNode {
        const watched = this.selected !== undefined && this.watches.includes(this.selected);
        return <div className='vp-memory-toolbar'>
            <input
                ref={this.addressInput}
                className='vp-input vp-memory-address'
                spellCheck={false}
                aria-label={nls.localize('vueport/debug/panels/memory/address', 'Address')}
                defaultValue={hex(this.address, 8)}
                onKeyDown={e => {
                    if (e.key === 'Enter') {
                        this.gotoTypedAddress();
                    }
                }}
            />
            <button
                className='vp-button secondary'
                title={nls.localize('vueport/debug/panels/memory/goTo', 'Go to address')}
                onClick={() => this.gotoTypedAddress()}
            >
                <ArrowUDownLeft size={14} />
            </button>

            <div className={`vp-panel-filter vp-memory-search${this.searchMissed ? ' missed' : ''}`}>
                <MagnifyingGlass size={15} />
                <input
                    ref={this.searchInput}
                    type='text'
                    spellCheck={false}
                    defaultValue={this.search}
                    placeholder={nls.localize('vueport/debug/panels/memory/search', 'Search bytes or text')}
                    aria-label={nls.localize('vueport/debug/panels/memory/search', 'Search bytes or text')}
                    onChange={e => this.settleSearch(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            // asked for outright, so nothing left to wait for: take the box as it stands and go
                            this.settleSearch.cancel();
                            this.search = e.currentTarget.value;
                            this.findNext();
                        }
                    }}
                />
                {this.search.length > 0 &&
                    <button
                        type='button'
                        className='vp-panel-filter-clear'
                        aria-label={nls.localize('vueport/general/clear', 'Clear')}
                        onClick={() => this.clearSearch()}
                    >
                        <X size={14} />
                    </button>}
            </div>
            <button
                className='vp-button secondary'
                disabled={this.searching || this.parseNeedle(this.search) === undefined}
                title={nls.localize('vueport/debug/panels/memory/findNext', 'Find next, wrapping around the map')}
                onClick={() => this.findNext()}
            >
                {nls.localize('vueport/debug/panels/memory/find', 'Find')}
            </button>

            <button
                className={`vp-button secondary${watched ? ' vp-memory-watching' : ''}`}
                disabled={this.selected === undefined
                    || (!watched && this.watches.length >= MAX_WATCHES)}
                title={nls.localize('vueport/debug/panels/memory/watch', 'Pin the selected address to the watch list')}
                onClick={() => this.selected !== undefined && this.toggleWatch(this.selected)}
            >
                <PushPin size={14} weight={watched ? 'fill' : 'regular'} />
                {nls.localize('vueport/debug/panels/memory/watchShort', 'Watch')}
            </button>
        </div>;
    }

    protected renderRows(): React.ReactNode {
        const first = this.firstRenderedRow();
        const count = Math.min(this.renderedRows(), Math.max(0, this.totalRows - first));
        const rows: React.ReactNode[] = [];
        for (let row = first; row < first + count; row++) {
            rows.push(this.renderRow(row));
        }

        return <div className='vp-memory-dump'>
            {/* deliberately not `vp-scroll`: perfect-scrollbar would draw a zero-height thumb over a list this tall. The map
                rail is the vertical scrollbar, and the clip hides the native one (see the stylesheet) */}
            <div className='vp-memory-clip'>
                <div
                    className='vp-memory-scroll'
                    ref={this.setScroller}
                    tabIndex={0}
                    onScroll={e => this.onScrolled(e.currentTarget)}
                    onKeyDown={e => this.onRowsKeyDown(e)}
                >
                    {this.renderRuler()}
                    <div
                        className='vp-memory-spacer'
                        style={{ height: `${this.totalRows * ROW_HEIGHT}px` }}
                    >
                        <div
                            className='vp-memory-viewport'
                            style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}
                        >
                            {rows}
                        </div>
                    </div>
                </div>
            </div>
            {this.renderRail()}
        </div>;
    }

    // stays at the top of the list; built of the same three parts as a row, so the digits sit over their columns
    protected renderRuler(): React.ReactNode {
        return <div className='vp-memory-row vp-memory-ruler'>
            <span className='address'>
                {nls.localize('vueport/debug/panels/memory/addressColumn', 'ADDRESS')}
            </span>
            <span className='bytes'>
                {Array.from({ length: BYTES_PER_ROW / this.unit }, (unused, column) =>
                    <span
                        key={column}
                        className={`byte${this.endsGroup(column) ? ' group' : ''}`}
                    >{(column * this.unit).toString(16).toUpperCase()}</span>)}
            </span>
            <span className='ascii'>
                {nls.localize('vueport/debug/panels/memory/asciiColumn', 'ASCII')}
            </span>
        </div>;
    }

    // four bytes to a group, the way an address is read; with words, every cell is one
    protected endsGroup(column: number): boolean {
        return ((column + 1) * this.unit) % 4 === 0;
    }

    // a cell's value, low byte first; undefined until every byte of it has been read
    protected cellAt(address: number): number | undefined {
        let value = 0;
        for (let at = this.unit - 1; at >= 0; at--) {
            const byte = this.byteAt(address + at);
            if (byte === undefined) {
                return undefined;
            }
            value = value * 256 + byte;
        }
        return value;
    }

    protected changedSince(address: number, now: number): boolean {
        const when = this.changedAt.get(address);
        return when !== undefined && now - when < FLASH_MS;
    }

    protected renderRow(row: number): React.ReactNode {
        const at = this.rowAt(row);
        if (!at) {
            return <div className='vp-memory-row' key={row} />;
        }
        if (at.address === undefined) {
            const { region, mapped } = at.entry;
            return <div className='vp-memory-row vp-memory-caption' key={row}>
                <span className='name'>{region.label}</span>
                {/* the region, then what of it answers: the bus gives every region 16 MB, mostly mirrors */}
                <span className='range'>
                    {hex(region.address, 8)}–{hex(region.address + VB_REGION_BYTES - 1, 8)}
                </span>
                <span className='mapped'>
                    {'• '}
                    {mapped < VB_REGION_BYTES
                        ? nls.localize('vueport/debug/panels/memory/mappedAndMirrored',
                            '{0} mapped, mirrored across the rest', sizeOf(mapped))
                        : nls.localize('vueport/debug/panels/memory/allMapped', '{0} mapped', sizeOf(mapped))}
                </span>
            </div>;
        }

        const base = at.address;
        const limit = at.entry.region.address + at.entry.mapped;
        const now = Date.now();

        const selectedCell = this.selected === undefined ? undefined : this.cellOf(this.selected);
        const digits = this.unit * 2;

        const cells: React.ReactNode[] = [];
        for (let column = 0; column < BYTES_PER_ROW / this.unit; column++) {
            const address = base + column * this.unit;
            const beyond = address >= limit;
            const value = beyond ? undefined : this.cellAt(address);
            const editing = this.pending?.address === address ? this.pending : undefined;
            let changed = false;
            for (let byte = 0; byte < this.unit && !changed; byte++) {
                changed = this.changedSince(address + byte, now);
            }
            const state = [
                'byte',
                this.endsGroup(column) ? 'group' : '',
                beyond ? 'beyond' : '',
                address === selectedCell ? 'selected' : '',
                editing ? 'editing' : '',
                changed ? 'changed' : '',
                value === undefined && !beyond ? 'unread' : '',
            ].filter(Boolean).join(' ');

            cells.push(<span
                key={column}
                className={state}
                onMouseDown={beyond ? undefined : () => this.select(address)}
            >
                {beyond ? '' : editing
                    ? hex(editing.value, editing.digits).padEnd(digits, '_')
                    : value === undefined ? '·'.repeat(digits) : hex(value, digits)}
            </span>);
        }

        // byte by byte whatever the unit: text does not come in halfwords
        const characters: React.ReactNode[] = [];
        for (let column = 0; column < BYTES_PER_ROW; column++) {
            const address = base + column;
            const beyond = address >= limit;
            const value = beyond ? undefined : this.byteAt(address);
            const selected = selectedCell !== undefined && this.cellOf(address) === selectedCell;
            const changed = this.changedSince(address, now);
            characters.push(<span
                key={column}
                className={`char${selected ? ' selected' : ''}${changed ? ' changed' : ''}`}
                onMouseDown={beyond ? undefined : () => this.select(address)}
            >
                {value !== undefined && value >= 0x20 && value < 0x7f
                    ? String.fromCharCode(value)
                    : beyond ? ' ' : '.'}
            </span>);
        }

        return <div className='vp-memory-row' key={row}>
            <span className='address'>{hex(base, 8)}</span>
            <span className='bytes'>{cells}</span>
            <span className='ascii'>{characters}</span>
        </div>;
    }

    protected renderInspector(): React.ReactNode {
        const address = this.selected;
        const bytes = this.selectedBytes;
        if (address === undefined || !bytes || bytes.length < INSPECT_BYTES) {
            return <div className='vp-memory-inspector empty'>
                {nls.localize('vueport/debug/panels/memory/pickAByte',
                    'Pick a byte to read it as a number, or type over it to write.')}
            </div>;
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const u8 = view.getUint8(0);
        const s16 = view.getInt16(0, true);
        const readings: [string, string][] = [
            ['u8', `${u8}`],
            ['s8', `${view.getInt8(0)}`],
            ['u16', `${view.getUint16(0, true)}`],
            ['s16', `${s16}`],
            ['u32', `${view.getUint32(0, true)}`],
            ['s32', `${view.getInt32(0, true)}`],
            // the engine's fixed point: 16 bits with 6 fractional, how every position and speed in a VUEngine game is stored
            ['fix10.6', (s16 / 64).toFixed(3)],
        ];

        return <div className='vp-memory-inspector'>
            <code className='at'>{hex(address, 8)}</code>
            {readings.map(([name, text]) =>
                <span className='reading' key={name}><i>{name}</i>{text}</span>)}
            {this.where && <span className='where'>
                {nls.localize('vueport/debug/panels/memory/in', 'in')}
                {' '}<b>{this.where.owner}</b>
                {this.where.offset > 0 && <> +0x{hex(this.where.offset, 2)}</>}
                {this.where.field && <> · <em>{this.where.field}</em></>}
            </span>}
        </div>;
    }

    protected renderWatches(): React.ReactNode {
        if (this.watches.length === 0) {
            return undefined;
        }
        return <div className='vp-memory-watches'>
            {this.watches.map(address => {
                const low = this.byteAt(address, this.watchChunks);
                const high = this.byteAt(address + 1, this.watchChunks);
                return <div className='vp-memory-watch' key={address}>
                    <button
                        className='vp-memory-watch-address'
                        title={nls.localize('vueport/debug/panels/memory/goToWatch', 'Go to this address')}
                        onClick={() => this.goto(address)}
                    >
                        {hex(address, 8)}
                    </button>
                    <code className='vp-memory-watch-byte'>
                        {low === undefined ? '··' : hex(low, 2)}
                    </code>
                    <code className='vp-memory-watch-word'>
                        {low === undefined || high === undefined
                            ? '····'
                            : hex(low | (high << 8), 4)}
                    </code>
                    <button
                        className='vp-memory-watch-remove'
                        aria-label={nls.localize('vueport/debug/panels/memory/unwatch', 'Stop watching')}
                        onClick={() => this.toggleWatch(address)}
                    >
                        <X size={12} />
                    </button>
                </div>;
            })}
        </div>;
    }
}
