import { nls } from '../../common/emulator-nls';
import { Disposable } from '../../common/emulator-events';
import { VueportReactWidget } from '../emulator-widget-base';
import { Message } from '@lumino/messaging';
import { Sim } from '../core/vb-core';
import { VesBreakpoints } from '../core/emulator-breakpoints';
import { VesLineTable } from '../core/emulator-line-table';
import { SymbolIndex } from '../core/emulator-symbols';
import { VesScreenRect } from './emulator-screen-panel';
import { ScreenInspectorTarget } from './emulator-screen-inspector';
import { VbPixelSource } from '../../common/vb-pixel-origin';
import { RomHeader } from '../emulator-types';

// what a persisted layout stores. Inspectors only: cheats, macros, patches, colors and achievements are shown beside
// the screen in both modes (see EmulatorHost#renderCheats; VueportDock#widgetFor drops their old keys)
export enum EmulatorPanelType {
    ACTORS = 'actors',
    DISASSEMBLY = 'disassembly',
    ES_SOUND = 'esSound',
    MEMORY = 'memory',
    PROFILER = 'profiler',
    MEMORY_POOLS = 'memoryPools',
    REGISTERS = 'registers',
    ROM_INFO = 'romInfo',
    RUMBLE_PACK = 'rumblePack',
    SCREEN = 'screen',
    SRAM = 'sram',
    TERMINAL = 'terminal',
    VIP_BGMAPS = 'vipBgMaps',
    VIP_CHARACTERS = 'vipCharacters',
    VIP_COLUMN_TABLE = 'vipColumnTable',
    VIP_FRAME_BUFFERS = 'vipFrameBuffers',
    VIP_OBJECTS = 'vipObjects',
    VIP_PALETTES = 'vipPalettes',
    VIP_WORLDS = 'vipWorlds',
    VCU = 'vcu',
    VSU = 'vsu',
    // Color mode's panels, see `emulator-color-panels.tsx`
    COLOR_PROJECT = 'colorProject',
    COLOR_BUILD = 'colorBuild',
    COLOR_SHEET = 'colorSheet',
}

// functions rather than strings, as this module is imported before the host installs its localization and finished
// strings would stay English (see setLocalization)
const EMULATOR_PANEL_LABELS: Record<EmulatorPanelType, () => string> = {
  [EmulatorPanelType.REGISTERS]: () => nls.localize('vueport/debug/panels/registers/title', 'Registers'),
  [EmulatorPanelType.DISASSEMBLY]: () => nls.localize('vueport/debug/panels/disassembly/title', 'Disassembly'),
  [EmulatorPanelType.MEMORY]: () => nls.localize('vueport/debug/panels/memory/title', 'Memory'),
  [EmulatorPanelType.MEMORY_POOLS]: () => nls.localize('vueport/debug/panels/memoryPools/title', 'Memory Pools'),
  [EmulatorPanelType.PROFILER]: () => nls.localize('vueport/debug/panels/profiler/title', 'CPU Profiler'),
  [EmulatorPanelType.ACTORS]: () => nls.localize('vueport/debug/panels/actors/title', 'Actors'),
  [EmulatorPanelType.SCREEN]: () => nls.localize('vueport/debug/panels/screen/title', 'Screen'),
  [EmulatorPanelType.VIP_PALETTES]: () => nls.localize('vueport/debug/panels/palettes/title', 'Palettes'),
  [EmulatorPanelType.VIP_CHARACTERS]: () => nls.localize('vueport/debug/panels/characters/title', 'Characters'),
  [EmulatorPanelType.VIP_BGMAPS]: () => nls.localize('vueport/debug/panels/bgmaps/title', 'BGMaps'),
  [EmulatorPanelType.VIP_WORLDS]: () => nls.localize('vueport/debug/panels/worlds/title', 'Worlds'),
  [EmulatorPanelType.VIP_OBJECTS]: () => nls.localize('vueport/debug/panels/objects/title', 'Objects'),
  [EmulatorPanelType.VIP_FRAME_BUFFERS]: () => nls.localize('vueport/debug/panels/frameBuffers/title', 'Frame Buffers'),
  [EmulatorPanelType.VIP_COLUMN_TABLE]: () => nls.localize('vueport/debug/panels/columnTable/title', 'Column Table'),
  [EmulatorPanelType.VCU]: () => nls.localize('vueport/debug/panels/vcu/title', 'VCU'),
  [EmulatorPanelType.VSU]: () => nls.localize('vueport/debug/panels/vsu/title', 'VSU'),
  [EmulatorPanelType.TERMINAL]: () => nls.localize('vueport/debug/panels/terminal/title', 'Terminal'),
  [EmulatorPanelType.ROM_INFO]: () => nls.localize('vueport/debug/panels/romInfo/title', 'ROM Info'),
  [EmulatorPanelType.ES_SOUND]: () => nls.localize('vueport/debug/panels/esSound/title', 'ESSound'),
  [EmulatorPanelType.RUMBLE_PACK]: () => nls.localize('vueport/debug/panels/rumblePack/title', 'Rumble Pack'),
  [EmulatorPanelType.SRAM]: () => nls.localize('vueport/debug/panels/sram/title', 'SRAM'),
  [EmulatorPanelType.COLOR_PROJECT]: () => nls.localize('vueport/color/panels/project/title', 'Project'),
  [EmulatorPanelType.COLOR_BUILD]: () => nls.localize('vueport/color/panels/build/title', 'Build'),
  [EmulatorPanelType.COLOR_SHEET]: () => nls.localize('vueport/color/panels/sheet/title', 'Sheet'),
};

export function emulatorPanelLabel(type: EmulatorPanelType): string {
  return EMULATOR_PANEL_LABELS[type]();
}

// Color mode's panels, which need its editor and are only offered there
export const EMULATOR_COLOR_PANEL_TYPES = [
    EmulatorPanelType.COLOR_PROJECT,
    EmulatorPanelType.COLOR_BUILD,
    EmulatorPanelType.COLOR_SHEET,
];

export function isColorPanel(type: EmulatorPanelType): boolean {
    return EMULATOR_COLOR_PANEL_TYPES.includes(type);
}

// for building a menu over all of them. Color mode's are left out: a host has to hand the dock a color editor for
// them, and a menu built from this in one that does not (VES) would offer panels that cannot open
export const EMULATOR_PANEL_TYPES = (Object.keys(EMULATOR_PANEL_LABELS) as EmulatorPanelType[])
    .filter(type => !isColorPanel(type));

// `own` is this window's player, `peer` this window's bit-identical mirror of the other player's machine;
// never `peer` outside a link session
export type InspectedSeat = 'own' | 'peer';

// handed to panels instead of the widget, so they can observe emulation but not drive it
export interface DebugSource {
    // undefined before it has booted
    readonly sim: Sim | undefined;
    // always `own` when playing alone; during a link session the debugger can be pointed at the other machine,
    // and a panel saying whose registers or memory it shows reads this
    readonly inspecting: InspectedSeat;
    // true while the other player's machine is there, so chrome offering the choice appears only then
    readonly hasPeerSim: boolean;
    readonly vbcSupportEnabled: boolean;
    // narrower than vbcSupportEnabled (not switched off globally): Auto still resolves to an original Virtual Boy for a
    // ROM whose header does not ask for color. Every color-only surface in the debugger keys off this
    readonly vbcHardwareActive: boolean;
    readonly romHeader: RomHeader;
    // in MBit
    readonly romSize: number;
    // CRC32 of the whole ROM file as eight lower-case hex digits, the identity the cheat database keys on;
    // undefined for a host that has not supplied one
    readonly romChecksum: string | undefined;
    // as the build names it; undefined for a ROM not built here (see readBuildModeFromMap)
    readonly buildMode: string | undefined;
    onDidChange(listener: () => void): Disposable;
    // undefined for a ROM not built here or without symbols beside it, which panels treat as an ordinary state.
    // Expensive, so call it from refresh rather than preemptively; the result is cached for as long as the ROM is
    getSymbols(): Promise<SymbolIndex | undefined>;
    // read from the build's own .debug_line, so absent for the same reasons as the symbols; also turns a breakpoint on
    // a line into the address the machine stops at in hosts with editors
    getLineTable(): Promise<VesLineTable | undefined>;
    // read and written through, the one deliberate exception to this interface being read-only: a breakpoint is a note
    // about where to pause, shared with the editors of the surrounding application (see VesBreakpoints)
    readonly breakpoints: VesBreakpoints;
    // named exactly as the line table names it: for a VUEngine build the generated files under build/working, which are
    // what its line numbers count in
    readSource(path: string): Promise<string | undefined>;
    /**
     * Marks rectangles on the picture in the VB's screen space (the Actors panel's selection), or clears them with an
     * empty list. They are drawn over the picture, so they cannot affect the machine; the screen inspector's switch
     * decides whether they show. A panel that sets them owns them and has to clear them when it stops describing the
     * selection, including when it is hidden or closed.
     */
    setHighlights(rects: VesScreenRect[]): void;
    // lights every pixel an object, world, BG map cell or character drew, from what the core keeps per pixel in Debug
    // mode (see ScreenInspector). Owned like setHighlights; Panel.light clears it on hiding
    highlightSource(source: VbPixelSource | undefined): void;
    // in the panel that shows it (an object in Objects, a cell in BGMaps), opening that panel and bringing it to front
    reveal(target: ScreenInspectorTarget): void;
    // the one route a panel changes memory by: in a linked session the same bytes have to land in the other window's
    // copy of the machine on the same frame, or the two run different games from then on. Bytes rather than a buffer,
    // as they may travel to the other window
    write(address: number, bytes: number[]): Promise<void>;
    // a panel's own controls as last left, kept here so storage stays the host's business. The fallback is both default
    // and type: a stored value of another shape is discarded, so a control that changed type does not read an old answer
    panelPreference<T extends string | number | boolean>(
        kind: EmulatorPanelType, key: string, fallback: T): T;
    setPanelPreference(
        kind: EmulatorPanelType, key: string, value: string | number | boolean): void;
}

// polled rather than pushed to, as the emulator produces fifty frames a second and no inspector needs that;
// polling only runs while a panel is visible
export abstract class Panel extends VueportReactWidget {

    protected static readonly POLL_HZ = 10;

    protected pollHz(): number {
        return Panel.POLL_HZ;
    }

    // toDisposeOnDetach is inherited from BaseWidget, which clears it on detach; redeclaring it here would shadow that
    protected pollTimer?: number;

    constructor(
        readonly kind: EmulatorPanelType,
        protected readonly source: DebugSource,
        instanceId: string
    ) {
        super();
        this.id = `vp-panel:${instanceId}:${kind}`;
        this.title.closable = true;
        this.addClass('vp-panel');
        this.addClass('vp-scroll');
    }

    // `fallback` for one never touched. Safe as a field initializer (`protected zoom = this.remembered('zoom', 4)`), as
    // source and kind are constructor parameters of this class. Overloaded rather than generic, so a literal fallback
    // types the field as number and not as the literal 4
    protected remembered(key: string, fallback: boolean): boolean;
    protected remembered(key: string, fallback: number): number;
    protected remembered(key: string, fallback: string): string;
    protected remembered(
        key: string, fallback: string | number | boolean
    ): string | number | boolean {
        return this.source.panelPreference(this.kind, key, fallback);
    }

    // hands the value straight back to be assigned
    protected remember(key: string, value: boolean): boolean;
    protected remember(key: string, value: number): number;
    protected remember(key: string, value: string): string;
    protected remember(
        key: string, value: string | number | boolean
    ): string | number | boolean {
        this.source.setPanelPreference(this.kind, key, value);
        return value;
    }

    protected onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.startPolling();
    }

    protected onAfterAttach(msg: Message): void {
        // the base renders from here, so its implementation has to run
        super.onAfterAttach(msg);
        if (this.isVisible) {
            this.startPolling();
        }
    }

    protected onAfterHide(msg: Message): void {
        super.onAfterHide(msg);
        this.stopPolling();
        this.light(undefined);
    }

    protected onBeforeDetach(msg: Message): void {
        this.stopPolling();
        this.light(undefined);
        super.onBeforeDetach(msg);
    }

    protected lit?: string;

    // pixel for pixel on the picture; hiding the panel lets go by itself
    protected light(source: VbPixelSource | undefined): void {
        // the pointer moves over the same thing many times a second
        const key = source && JSON.stringify(source);
        if (key === this.lit) {
            return;
        }
        this.lit = key;
        this.source.highlightSource(source);
    }

    // select it and bring it into view; nothing, for a panel that shows none of it
    reveal(target: ScreenInspectorTarget): void {
    }

    /**
     * This node (.emulator-panel) is where overflow: auto lives for most panels. React cannot always match rows keyed
     * by something that changes under polling (a filter), and removing the node under the scrollbar makes the browser
     * reset scrollTop; ten times a second that reads as scrolling not working. So scrollTop is saved and restored
     * around the render. It is written only when it moved: in Chrome any programmatic scroll, even to where it already
     * is, stops a smooth scroll running anywhere on the page, and a jump from the screen inspector would move a step
     * and stop.
     */
    protected onUpdateRequest(msg: Message): void {
        const { scrollTop, scrollLeft } = this.node;
        super.onUpdateRequest(msg);
        if (this.node.scrollTop !== scrollTop) {
            this.node.scrollTop = scrollTop;
        }
        if (this.node.scrollLeft !== scrollLeft) {
            this.node.scrollLeft = scrollLeft;
        }
    }

    protected startPolling(): void {
        if (this.pollTimer !== undefined) {
            return;
        }
        // drawn on the way into view regardless, as a panel redrawing only on changes (ESSound while nothing plays)
        // otherwise stays blank until that change comes
        this.update();
        this.poll();
        this.pollTimer = window.setInterval(() => this.poll(), 1000 / this.pollHz());
    }

    // swallows a rejection: changing the hardware model or VB Color gate starts a new session, and a read in flight then
    // rejects with "the emulator core has been disposed". The next tick reads the new session
    protected poll(): void {
        const pending = this.refresh() as void | Promise<void>;
        if (pending instanceof Promise) {
            pending.catch(() => undefined);
        }
    }

    protected restartPolling(): void {
        if (this.pollTimer !== undefined) {
            this.stopPolling();
            this.startPolling();
        }
    }

    protected stopPolling(): void {
        if (this.pollTimer !== undefined) {
            window.clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    // pulls fresh data and redraws; must tolerate no sim. May be asynchronous, poll deals with a read the machine outlived
    protected abstract refresh(): void | Promise<void>;

    dispose(): void {
        this.stopPolling();
        super.dispose();
    }
}

// whether the control the key went to wants the arrow keys itself: text inputs, sliders, listboxes and anything in the
// tab order on its own (segmented pickers, a second scrolling region). Panels walking their contents with the arrows
// read them on the outer node and ask this first; `root` is the node reading the event
export function arrowKeysTaken(target: EventTarget | null, root: EventTarget | null): boolean {
    const taken = target instanceof Element ? target.closest(ARROW_KEY_CONTROLS) : undefined;
    return !!taken && taken !== root;
}

const ARROW_KEY_CONTROLS = 'input, select, textarea, [contenteditable="true"],'
    + ' [role="combobox"], [role="listbox"], [tabindex="0"]';

// scrollIntoView, smoothly, for the screen inspector's jumps. Not scrollIntoView({ behavior: 'smooth' }): Chrome runs
// that across every scroller, and any programmatic scroll (a polling panel following its log) stops it. So it is
// scrollTo on the nearest scroller alone, honouring scroll-margin
export function scrollIntoViewSmoothly(
    element: Element,
    block: 'nearest' | 'center' = 'nearest',
    inline: 'nearest' | 'center' = 'nearest'
): void {
    const scroller = scrollerOf(element);
    if (!scroller) {
        element.scrollIntoView({ block, inline, behavior: 'smooth' });
        return;
    }
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const top = box.top - parseFloat(style.scrollMarginTop || '0') - (view.top + scroller.clientTop) + scroller.scrollTop;
    const bottom = box.bottom + parseFloat(style.scrollMarginBottom || '0')
        - (view.top + scroller.clientTop) + scroller.scrollTop;
    const left = box.left - parseFloat(style.scrollMarginLeft || '0')
        - (view.left + scroller.clientLeft) + scroller.scrollLeft;
    const right = box.right + parseFloat(style.scrollMarginRight || '0')
        - (view.left + scroller.clientLeft) + scroller.scrollLeft;
    scroller.scrollTo({
        top: scrollTarget(top, bottom, scroller.scrollTop, scroller.clientHeight, block),
        left: scrollTarget(left, right, scroller.scrollLeft, scroller.clientWidth, inline),
        behavior: 'smooth',
    });
}

// the offset that brings start..end (in scroll coordinates) into a view of `size` now at `at`
function scrollTarget(start: number, end: number, at: number, size: number, align: 'nearest' | 'center'): number {
    if (align === 'center') {
        return (start + end) / 2 - size / 2;
    }
    if (start < at || end - start > size) {
        return start;
    }
    return end > at + size ? end - size : at;
}

// the nearest ancestor that scrolls, in either direction; one perfect-scrollbar took over says `overflow: hidden`
function scrollerOf(element: Element): HTMLElement | undefined {
    for (let at = element.parentElement; at; at = at.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(at);
        const scrolling = at.classList.contains('ps') ? /auto|scroll|hidden/ : /auto|scroll/;
        const scrollsY = scrolling.test(overflowY) && at.scrollHeight > at.clientHeight;
        const scrollsX = scrolling.test(overflowX) && at.scrollWidth > at.clientWidth;
        if (scrollsY || scrollsX) {
            return at;
        }
    }
    return undefined;
}

export function hex(value: number, digits: number): string {
    return (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}
