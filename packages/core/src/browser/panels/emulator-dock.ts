import { Disposable, Emitter } from '../../common/emulator-events';
import { Drag } from '@lumino/dragdrop';
import { Message } from '@lumino/messaging';
import { DockLayout, DockPanel, TabBar, Widget } from '@lumino/widgets';
import { VueportRumblePack } from '../../common/emulator-rumble';
import { EsSoundPlayer } from '../emulator-essound-player';
import { Sim } from '../core/vb-core';
import { VesBreakpoints } from '../core/emulator-breakpoints';
import { VesLineTable } from '../core/emulator-line-table';
import { SymbolIndex } from '../core/emulator-symbols';
import { EMPTY_ROM_HEADER, RomHeader } from '../emulator-types';
import { DisassemblyPanel } from './emulator-disassembly-panel';
import { EsSoundPanel } from './emulator-essound-panel';
import { MemoryPanel } from './emulator-memory-panel';
import { ActorsPanel } from './emulator-actors-panel';
import { MemoryPoolsPanel } from './emulator-memory-pools-panel';
import { ProfilerPanel } from './emulator-profiler-panel';
import {
    EMULATOR_COLOR_PANEL_TYPES,
    EMULATOR_PANEL_TYPES,
    EmulatorPanelType,
    DebugSource,
    InspectedSeat,
    isColorPanel,
    Panel,
} from './emulator-panel';
import { ColorEditor } from '../color/emulator-color-editor';
import { createColorPanel } from '../color/emulator-color-panels';
import { ColorScreenTools } from '../color/emulator-color-tools';
import { RegistersPanel } from './emulator-registers-panel';
import { RomInfoPanel } from './emulator-rom-info-panel';
import { SramPanel } from './emulator-sram-panel';
import { RumblePackPanel } from './emulator-rumble-pack-panel';
import { ScreenPanel, VesScreenRect } from './emulator-screen-panel';
import { ScreenInspector, ScreenInspectorTarget, ScreenInspectorView } from './emulator-screen-inspector';
import { VbPixelSource } from '../../common/vb-pixel-origin';
import { VueportTabBar } from './emulator-tab-bar';
import { TerminalPanel } from './emulator-terminal-panel';
import { BgMapsPanel } from './emulator-vip-bgmaps-panel';
import { CharactersPanel } from './emulator-vip-characters-panel';
import { VipExportFile } from './emulator-vip-canvas';
import { FrameBuffersPanel } from './emulator-vip-framebuffers-panel';
import { ObjectsPanel } from './emulator-vip-objects-panel';
import { PalettesPanel } from './emulator-vip-palettes-panel';
import { ColumnTablePanel } from './emulator-vip-column-table-panel';
import { WorldsPanel } from './emulator-vip-worlds-panel';
import { VcuPanel } from './emulator-vcu-panel';
import { VsuPanel } from './emulator-vsu-panel';

// every panel but the screen (see `widgetFor`). Derived from the enum, as a hand-kept list once let a panel open from
// the command palette but not from a group's "+", and dropped it from restored layouts
export const EMULATOR_DEBUG_PANELS = EMULATOR_PANEL_TYPES
    .filter(kind => kind !== EmulatorPanelType.SCREEN);

// a dragged slider stores once rather than forty times; `dispose` flushes anyway
const PANEL_PREFERENCE_WRITE_DELAY_MS = 400;

// what a fresh emulator starts with and Reset Layout restores: the screen over the text panels on the left,
// the inspectors tabbed on the right, halves even, proportions kept at any window size. Memory Pools and
// Actors are left out as they only work for VUEngine builds; a host passes its own `defaultLayout` for those
const DEFAULT_LAYOUT: AreaLayout = {
    type: 'split-area',
    orientation: 'horizontal',
    sizes: [50, 50],
    children: [
        {
            type: 'split-area',
            orientation: 'vertical',
            sizes: [70, 30],
            children: [
                { type: 'tab-area', panels: [EmulatorPanelType.SCREEN], currentIndex: 0 },
                {
                    type: 'tab-area',
                    panels: [
                        EmulatorPanelType.ROM_INFO,
                        EmulatorPanelType.MEMORY,
                        EmulatorPanelType.TERMINAL,
                    ],
                    currentIndex: 0,
                },
            ],
        },
        {
            type: 'tab-area',
            panels: [
                EmulatorPanelType.VIP_CHARACTERS,
                EmulatorPanelType.VIP_BGMAPS,
                EmulatorPanelType.VIP_WORLDS,
                EmulatorPanelType.VIP_OBJECTS,
                EmulatorPanelType.VCU,
                EmulatorPanelType.REGISTERS,
            ],
            currentIndex: 0,
        }
    ],
};

// Color mode's arrangement, and what Reset Layout restores in it: on the left, narrow, the project with Build a tab
// beside it; all the rest for the screen and the sheet editor as tabs of one area (a pick on the screen brings the
// sheet forward). Sized from the dock's own size: the project takes a fixed width, not a share.
function colorLayout(width: number): AreaLayout {
    const left = width > 0 ? Math.min(0.3, Math.max(0.1, PROJECT_WIDTH / width)) : 0.16;
    return {
        type: 'split-area',
        orientation: 'horizontal',
        sizes: [left, 1 - left],
        children: [
            { type: 'tab-area', panels: [EmulatorPanelType.COLOR_PROJECT, EmulatorPanelType.COLOR_BUILD], currentIndex: 0 },
            { type: 'tab-area', panels: [EmulatorPanelType.SCREEN, EmulatorPanelType.COLOR_SHEET], currentIndex: 0 },
        ],
    };
}

const PROJECT_WIDTH = 360;

export interface VueportDockHost {
    // tells the surrounding shell to forget its drag, as this dock handles it. Only needed inside an outer
    // dock that also tracks the pointer (VES). See `trackOwnDrag`
    cancelForeignDrag?(): void;
    // left out to take DEFAULT_LAYOUT
    defaultLayout?: AreaLayout;
    // for the CPU Profiler panel's record button, which drives the emulator, so not part of `DebugSource`.
    // Without it the button does not appear
    isProfiling?(): boolean;
    toggleProfiling?(): void;
    // for the Disassembly panel's controls; pausing is driving, so not part of `DebugSource`. Without these the
    // panel reads the program but cannot stop it
    isPaused?(): boolean;
    setPaused?(paused: boolean): void;
    // for the Disassembly panel's source view; read through the host, which owns the file access and caching,
    // like `symbolLoader`. Without them only the instructions are shown
    lineTable?(): Promise<VesLineTable | undefined>;
    readSource?(path: string): Promise<string | undefined>;
    // see `DebugSource.panelPreference`. Read once when the dock is built, written back whole on every change;
    // without them panels remember nothing past this session
    readPanelPreferences?(): Record<string, string | number | boolean>;
    writePanelPreferences?(state: Record<string, string | number | boolean>): void;
    // hands a file a panel made (the Characters, BGMaps, Worlds and Objects PNG exports) to the host: a download
    // in the browser, a project file in VES. Without it there is no Export button
    exportFile?(name: string, data: Uint8Array): Promise<void>;
}

// the emulator's dock area; the arrangement is saved and Reset Layout restores DEFAULT_LAYOUT. Drags are sealed
// off from the shell both ways (see `trackOwnDrag` and `blockForeignOverlay`)
export class VueportDock extends DockPanel implements DebugSource {

    readonly screen: ScreenPanel;
    // what drew each pixel, Debug mode only. See ScreenInspector, and applyPixelOrigins for the cost
    protected readonly inspector: ScreenInspector;
    protected debugMode = false;
    protected colorMode = false;
    protected colorSheetWatch?: Disposable;
    protected readonly colorTools?: ColorScreenTools;
    protected originsSim: Sim | undefined;

    protected currentSim: Sim | undefined;
    // the other player's machine during a link session; this window runs it too (see `emulator-core-service.ts`),
    // so inspecting it costs nothing
    protected currentPeerSim: Sim | undefined;
    protected currentInspecting: InspectedSeat = 'own';
    // set by the host during a link session, as a write must reach both windows on one frame. Returning false
    // means it could not be arranged and the write goes straight in. See `write`
    protected writeRoute:
        | ((seat: InspectedSeat, address: number, bytes: number[]) => boolean)
        | undefined;
    protected currentVbcSupportEnabled = true;
    protected currentVbcHardwareActive = false;
    protected currentRomHeader: RomHeader = EMPTY_ROM_HEADER;
    protected currentRomSize = 0;
    protected currentBuildMode?: string;
    protected currentRomChecksum?: string;
    protected panelPreferenceState: Record<string, string | number | boolean> | undefined;
    protected panelPreferenceWrite?: number;
    protected readonly panels = new Map<EmulatorPanelType, Panel>();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    protected readonly onDidChangeLayoutEmitter = new Emitter<void>();
    protected readonly onDidRequestAddPanelEmitter = new Emitter<TabBar<Widget>>();
    protected readonly onDidRequestResetLayoutEmitter = new Emitter<void>();

    readonly onDidChangeLayout = this.onDidChangeLayoutEmitter.event;

    // with the group whose "+" was pressed, where the pick should land; the quick pick belongs to the view
    // contribution that owns the Add Panel command
    readonly onDidRequestAddPanel = this.onDidRequestAddPanelEmitter.event;

    // the host resets: it decides whether to ask first and owns the persisted layout
    readonly onDidRequestResetLayout = this.onDidRequestResetLayoutEmitter.event;

    constructor(
        protected readonly instanceId: string,
        protected readonly host: VueportDockHost,
        // not part of DebugSource: the rumble pack is external hardware and the ESSound player is the host's. Each
        // goes to the one panel that needs it
        protected readonly rumblePack: VueportRumblePack,
        protected readonly esSound: EsSoundPlayer,
        // part of DebugSource, as the symbols describe the running ROM; a callback because the widget owns the file
        // access and caching. See `getSymbols`
        protected readonly symbolLoader: () => Promise<SymbolIndex | undefined>,
        // Color mode's, for a host that offers it; its panels cannot be opened without one
        protected readonly colorEditor?: ColorEditor,
    ) {
        // refuses a tab dragged in from outside; Lumino checks this on the target panel, so it is only half of the
        // boundary (see enforceDragBoundary). `addButtonEnabled` puts Lumino's "+" on every tab bar, glyph via CSS
        super({
            mode: 'multiple-document',
            tabsConstrained: true,
            addButtonEnabled: true,
            // Lumino sizes a split handle's box to this in an inline style CSS `min-width` cannot shrink. The wider grab
            // area comes from `--vp-sash-width` on `::after`; see the `contain: none` override in emulator-widget.css
            spacing: 1,
            renderer: {
                createTabBar: () => {
                    const tabBar = new VueportTabBar();
                    tabBar.resetRequested.connect(() => this.onDidRequestResetLayoutEmitter.fire());
                    return tabBar;
                },
                createHandle: () => DockPanel.defaultRenderer.createHandle(),
            },
        });
        this.addClass('vp-dock');
        this.screen = new ScreenPanel(instanceId);
        this.inspector = new ScreenInspector(this.screen, {
            sim: () => this.sim,
            vbcHardwareActive: () => this.vbcHardwareActive,
            romSize: () => this.romSize,
            getSymbols: () => this.getSymbols(),
            reveal: target => this.reveal(target),
            rememberedView: () => this.panelPreference(EmulatorPanelType.SCREEN, 'inspectorView', 'picture') as ScreenInspectorView,
            rememberView: view => this.setPanelPreference(EmulatorPanelType.SCREEN, 'inspectorView', view),
        });
        if (colorEditor) {
            this.colorTools = new ColorScreenTools(this.screen, { sim: () => this.sim }, colorEditor);
            this.colorSheetWatch = colorEditor.onDidOpenSheet(() => {
                const panel = this.panels.get(EmulatorPanelType.COLOR_SHEET);
                if (this.colorMode && panel && !panel.isDisposed && panel.parent) {
                    this.selectWidget(panel);
                }
            });
        }
        // here rather than in the host, as only the dock knows which machine draws an interleaved picture
        this.screen.onDidChangeOutput(output => {
            this.currentSim?.setDisplayOutput(output).catch(() => undefined);
        });
        this.layoutModified.connect(() => {
            // a rebuilt layout brings fresh tab bars, visible by default, which Play mode hides again
            this.updatePlayModeTabBars();
            this.onDidChangeLayoutEmitter.fire();
        });
        this.addRequested.connect((unused, tabBar) => this.onDidRequestAddPanelEmitter.fire(tabBar));
    }

    // double-clicking empty tab row space asks for a panel, like "+". Capture phase, as the tab bar stops the
    // event on the way up to keep it from the surrounding application (see `VueportTabBar`)
    protected readonly addOnDoubleClickListener = (event: Event) => {
        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }
        // only the empty part of the row; the "+" already does this through Lumino's own signal
        if (target.closest('.lm-TabBar-tab') || target.closest('.lm-TabBar-addButton')) {
            return;
        }
        const tabBar = [...this.tabBars()].find(bar => bar.node.contains(target));
        if (tabBar) {
            event.preventDefault();
            this.onDidRequestAddPanelEmitter.fire(tabBar);
        }
    };

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.node.addEventListener('dblclick', this.addOnDoubleClickListener, true);
        // capture phase on the document, to see every pointer move and Lumino drag event in the application
        const document = this.node.ownerDocument;
        document.addEventListener('pointermove', this.pointerMoveListener, true);
        document.addEventListener('lm-dragenter', this.dragEnterListener, true);
        // bubble phase on this node, registered after `super.onAfterAttach`, so Lumino's handlers run first and this
        // only decides whether the event may go on upwards. See `sealDragFromAncestors`
        for (const type of VueportDock.DRAG_EVENTS) {
            this.node.addEventListener(type, this.sealDragListener);
        }
    }

    protected onBeforeDetach(msg: Message): void {
        const document = this.node.ownerDocument;
        document.removeEventListener('pointermove', this.pointerMoveListener, true);
        document.removeEventListener('lm-dragenter', this.dragEnterListener, true);
        this.node.removeEventListener('dblclick', this.addOnDoubleClickListener, true);
        for (const type of VueportDock.DRAG_EVENTS) {
            this.node.removeEventListener(type, this.sealDragListener);
        }
        super.onBeforeDetach(msg);
    }

    protected static readonly DRAG_EVENTS = ['lm-dragenter', 'lm-dragover', 'lm-dragleave', 'lm-drop'] as const;

    protected readonly pointerMoveListener = (event: Event) => this.trackOwnDrag(event as PointerEvent);
    protected readonly dragEnterListener = (event: Event) => this.blockForeignOverlay(event as Drag.Event);
    protected readonly sealDragListener = (event: Event) => this.sealDragFromAncestors(event as Drag.Event);

    /**
     * Keeps this dock's own drag events from the ancestor dock panels, which left drop indicators stranded over the
     * shell's edges. Lumino binds `lm-drag*` in the bubble phase. Its `_evtDragOver` shows the overlay as a side effect
     * of rejecting a drop (only accepting stops propagation), while `_evtDragLeave` stops propagation for our own
     * drags, so the ancestor is told to show the overlay but never to hide it. `overlay.hide(0)` in `trackOwnDrag` only
     * hides our own overlay. Foreign drags still propagate, and `tabsConstrained` refuses them here.
     */
    protected sealDragFromAncestors(event: Drag.Event): void {
        if (event.source === this) {
            event.stopPropagation();
        }
    }

    protected get ownDrag(): Drag | null {
        return (this as unknown as { _drag: Drag | null })._drag;
    }

    /**
     * Keeps this dock's own drag from leaking into the application:
     *
     * 1. A foreign panel's drop overlay: `blockForeignOverlay` refuses it on `lm-dragenter`.
     * 2. `ApplicationShell` revealing a collapsed side or bottom panel near a screen edge. Its 500 ms edge gate
     *    (`onDragOver`) times from `dragState.startTime`, which any `lm-dragenter` sets, including ones in our own tab
     *    bars, so the gate is often open by the time an edge is reached. So while our drag is in flight, every
     *    `pointermove` clears the private `dragState`.
     * 3. Once the cursor leaves this dock's rectangle, `Drag.dispose()` aborts the gesture as Escape does. The tab was
     *    only hidden, so it reappears. `overlay.hide(0)` covers our own indicator if `dragleave` misses it.
     *
     * It works on the raw cursor position against our rectangle, as handling `lm-dragenter`/`lm-dragover` instead fixes
     * one symptom and leaves another.
     */
    protected trackOwnDrag(event: PointerEvent): void {
        const drag = this.ownDrag;
        // `isDisposed` too: `DockPanel` clears `_drag` only in `Drag.start()`'s `then()`, so it can point at a dead
        // drag. Clearing `dragState` then would break a foreign drag, as `ApplicationShell` guards `onDrop` and
        // `onDragLeave` with `if (state)`
        if (!drag || drag.isDisposed) {
            return;
        }

        this.host.cancelForeignDrag?.();

        const bounds = this.node.getBoundingClientRect();
        const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
            && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        if (!inside) {
            /**
             * Deferred, as this may run inside `Drag.start()`, which dispatches a synthetic `pointermove` before
             * returning its promise (e.g. for a tab detached already outside the dock). Disposing re-entrantly makes
             * `start()` return null, so `then(cleanup)` throws and `_drag` is never cleared: the tab stays invisible
             * and `_onTabDetachRequested` refuses every later detach. A microtask is enough, as `then(cleanup)` is
             * synchronous.
             */
            queueMicrotask(() => {
                if (!drag.isDisposed) {
                    drag.dispose();
                }
                this.overlay.hide(0);
            });
        }
    }

    /**
     * Refuses our own tabs onto a foreign panel's overlay, in the capture phase before its bubble-phase `_evtDragEnter`
     * (incoming drags are refused by `tabsConstrained`). Only `stopPropagation()`: Lumino's `dispatchDragEnter` treats
     * a canceled dragenter as acceptance (`if (canceled) return currElem`), so `preventDefault()` would adopt the
     * foreign element as the target.
     */
    protected blockForeignOverlay(event: Drag.Event): void {
        if (event.source === this
            && event.mimeData.hasData('application/vnd.lumino.widget-factory')
            && !this.node.contains(event.target as Node)) {
            event.stopPropagation();
        }
    }

    // falls back to this window's own when the peer's is gone, so a session that just ended does not leave the
    // panels empty
    get sim(): Sim | undefined {
        if (this.currentInspecting === 'peer' && this.currentPeerSim) {
            return this.currentPeerSim;
        }
        return this.currentSim;
    }

    get inspecting(): InspectedSeat {
        return this.currentPeerSim ? this.currentInspecting : 'own';
    }

    get hasPeerSim(): boolean {
        return this.currentPeerSim !== undefined;
    }

    async write(address: number, bytes: number[]): Promise<void> {
        if (bytes.length === 0) {
            return;
        }
        const seat = this.inspecting;
        if (this.writeRoute?.(seat, address, bytes)) {
            return;
        }
        // aimed at the peer and nothing took it: writing only into the mirror would break it, and this only happens
        // when a session ends between the click and this call, so the write is dropped
        if (seat === 'peer') {
            return;
        }
        await this.sim?.writeMemory(address, new Uint8Array(bytes).buffer);
    }

    get vbcSupportEnabled(): boolean {
        return this.currentVbcSupportEnabled;
    }

    get vbcHardwareActive(): boolean {
        return this.currentVbcSupportEnabled && this.currentVbcHardwareActive;
    }

    get romHeader(): RomHeader {
        return this.currentRomHeader;
    }

    get romSize(): number {
        return this.currentRomSize;
    }

    get romChecksum(): string | undefined {
        return this.currentRomChecksum;
    }

    get buildMode(): string | undefined {
        return this.currentBuildMode;
    }

    panelPreference<T extends string | number | boolean>(
        kind: EmulatorPanelType, key: string, fallback: T
    ): T {
        const stored = this.panelPreferences()[`${kind}.${key}`];
        // same type as the fallback or nothing, as storage outlives a build that turned a checkbox into a slider
        return typeof stored === typeof fallback ? stored as T : fallback;
    }

    setPanelPreference(
        kind: EmulatorPanelType, key: string, value: string | number | boolean
    ): void {
        const state = this.panelPreferences();
        const id = `${kind}.${key}`;
        if (state[id] === value) {
            return;
        }
        state[id] = value;
        // a dragged slider lands a value per step and each write is a serialize-and-store in the host, so writes
        // are coalesced; nothing reads them back until the emulator opens again
        if (this.panelPreferenceWrite === undefined) {
            this.panelPreferenceWrite = window.setTimeout(() => {
                this.panelPreferenceWrite = undefined;
                this.host.writePanelPreferences?.({ ...state });
            }, PANEL_PREFERENCE_WRITE_DELAY_MS);
        }
    }

    protected panelPreferences(): Record<string, string | number | boolean> {
        return this.panelPreferenceState ??= { ...this.host.readPanelPreferences?.() };
    }

    protected flushPanelPreferences(): void {
        if (this.panelPreferenceWrite === undefined) {
            return;
        }
        window.clearTimeout(this.panelPreferenceWrite);
        this.panelPreferenceWrite = undefined;
        this.host.writePanelPreferences?.({ ...this.panelPreferences() });
    }

    onDidChange(listener: () => void): Disposable {
        return this.onDidChangeEmitter.event(listener);
    }

    getSymbols(): Promise<SymbolIndex | undefined> {
        return this.symbolLoader();
    }

    getLineTable(): Promise<VesLineTable | undefined> {
        return this.host.lineTable?.() ?? Promise.resolve(undefined);
    }

    // on the dock rather than in the gutter panel, as a host with editors sets breakpoints on source lines too.
    // See VesBreakpoints
    readonly breakpoints = new VesBreakpoints();
    protected readonly armOnChange =
        this.breakpoints.onDidChange(() => this.armBreakpoints());

    readSource(path: string): Promise<string | undefined> {
        return this.host.readSource?.(path) ?? Promise.resolve(undefined);
    }

    setHighlights(rects: VesScreenRect[]): void {
        // through the inspector, whose switch says whether they are drawn
        this.inspector.setSelectionRects(rects);
    }

    highlightSource(source: VbPixelSource | undefined): void {
        this.inspector.setPanelSource(source);
    }

    reveal(target: ScreenInspectorTarget): void {
        const kind = {
            object: EmulatorPanelType.VIP_OBJECTS,
            world: EmulatorPanelType.VIP_WORLDS,
            cell: EmulatorPanelType.VIP_BGMAPS,
            character: EmulatorPanelType.VIP_CHARACTERS,
            vbcPalette: EmulatorPanelType.VCU,
            sprites: EmulatorPanelType.ACTORS,
            actor: EmulatorPanelType.ACTORS,
            code: EmulatorPanelType.DISASSEMBLY,
            memory: EmulatorPanelType.MEMORY,
        }[target.kind];
        this.togglePanel(kind);
        this.panels.get(kind)?.reveal(target);
    }

    setSim(sim: Sim | undefined): void {
        this.currentSim = sim;
        sim?.setDisplayOutput(this.screen.displayOutput).catch(() => undefined);
        this.armBreakpoints();
        this.applyPixelOrigins();
        this.colorTools?.simChanged();
        this.onDidChangeEmitter.fire();
    }

    // kept all the time in Debug mode, as a paused machine draws nothing to answer from. Costs about as much
    // as drawing again (a little of a frame), Play mode pays none of it
    protected applyPixelOrigins(): void {
        const wanted = this.debugMode ? this.sim : undefined;
        if (this.originsSim === wanted) {
            return;
        }
        this.originsSim?.setPixelOrigins(false).catch(() => undefined);
        this.originsSim = wanted;
        wanted?.setPixelOrigins(true).catch(() => undefined);
        this.inspector.simChanged();
    }

    // regardless of whether the panel is open, as a breakpoint set in an editor must work without a
    // disassembly in view. Nothing is armed when nothing is set
    protected armBreakpoints(): void {
        this.currentSim?.setBreakpoints(this.breakpoints.armed())
            .catch(() => { /* the machine may already be gone */ });
    }

    // taking it away points the inspectors back at this window's own machine
    setPeerSim(sim: Sim | undefined): void {
        if (this.currentPeerSim === sim) {
            return;
        }
        this.currentPeerSim = sim;
        if (!sim) {
            this.currentInspecting = 'own';
        }
        this.applyPixelOrigins();
        this.onDidChangeEmitter.fire();
    }

    setInspecting(seat: InspectedSeat): void {
        if (this.currentInspecting === seat) {
            return;
        }
        this.currentInspecting = seat;
        this.applyPixelOrigins();
        this.onDidChangeEmitter.fire();
    }

    setWriteRoute(
        route: ((seat: InspectedSeat, address: number, bytes: number[]) => boolean)
            | undefined,
    ): void {
        this.writeRoute = route;
    }

    // the global gate and whether a VB Color is running, which the color-only surfaces key off (see
    // `vbcHardwareActive` on DebugSource). The VCU panel stays open either way and says which machine runs
    setVbcSupportEnabled(enabled: boolean, hardwareActive = this.currentVbcHardwareActive): void {
        if (this.currentVbcSupportEnabled === enabled
            && this.currentVbcHardwareActive === hardwareActive) {
            return;
        }
        this.currentVbcHardwareActive = hardwareActive;
        this.currentVbcSupportEnabled = enabled;
        this.onDidChangeEmitter.fire();
    }

    // on every ROM (re)load, independently of the sim changing
    setRomInfo(
        romHeader: RomHeader,
        romSize: number,
        buildMode?: string,
        romChecksum?: string,
    ): void {
        this.currentRomHeader = romHeader;
        this.currentRomSize = romSize;
        this.currentBuildMode = buildMode;
        this.currentRomChecksum = romChecksum;
        this.onDidChangeEmitter.fire();
    }

    togglePanel(kind: EmulatorPanelType): void {
        const existing = this.panels.get(kind);
        if (existing && !existing.isDisposed) {
            if (existing.isAttached) {
                this.focusWidget(existing);
                return;
            }
            existing.dispose();
        }

        const panel = this.createPanel(kind);
        this.panels.set(kind, panel);
        // beside the screen, so an inspector never hides what it inspects
        this.addWidget(panel, { mode: 'split-right', ref: this.screen });
        this.focusWidget(panel);
    }

    // what a group's "+" does; Lumino's `addWidget` moves a widget that is already open elsewhere
    addPanelTo(kind: EmulatorPanelType, tabBar: TabBar<Widget>): void {
        const panel = this.widgetFor(kind);
        if (!panel) {
            return;
        }
        // asking Lumino to insert a widget next to itself is an error
        if (this.tabBarFor(panel) !== tabBar) {
            const ref = tabBar.currentTitle?.owner;
            this.addWidget(panel, ref ? { mode: 'tab-after', ref } : { mode: 'split-right', ref: this.screen });
        }
        this.focusWidget(panel);
    }

    protected tabBarFor(widget: Widget): TabBar<Widget> | undefined {
        for (const tabBar of this.tabBars()) {
            if (tabBar.titles.includes(widget.title)) {
                return tabBar;
            }
        }
        return undefined;
    }

    isPanelOpen(kind: EmulatorPanelType): boolean {
        const panel = this.panels.get(kind);
        return !!panel && !panel.isDisposed && panel.isAttached;
    }

    isPanelVisible(kind: EmulatorPanelType): boolean {
        const panel = this.panels.get(kind);
        return !!panel && !panel.isDisposed && panel.isVisible;
    }

    protected exportFile(): VipExportFile | undefined {
        const host = this.host;
        return host.exportFile ? (name, data) => host.exportFile?.(name, data) ?? Promise.resolve() : undefined;
    }

    protected createPanel(kind: EmulatorPanelType): Panel {
        if (isColorPanel(kind)) {
            if (!this.colorEditor) {
                throw new Error(`No color editor for the ${kind} panel.`);
            }
            return createColorPanel(kind, this, this.instanceId, this.colorEditor);
        }
        switch (kind) {
            case EmulatorPanelType.REGISTERS: return new RegistersPanel(this, this.instanceId);
            case EmulatorPanelType.MEMORY: return new MemoryPanel(this, this.instanceId);
            case EmulatorPanelType.MEMORY_POOLS: return new MemoryPoolsPanel(this, this.instanceId);
            case EmulatorPanelType.PROFILER: return new ProfilerPanel(
                this, this.instanceId,
                this.host.isProfiling && this.host.toggleProfiling
                    ? {
                        isProfiling: () => this.host.isProfiling?.() ?? false,
                        toggleProfiling: () => this.host.toggleProfiling?.(),
                    }
                    : undefined);
            case EmulatorPanelType.ACTORS: return new ActorsPanel(this, this.instanceId);
            case EmulatorPanelType.DISASSEMBLY: return new DisassemblyPanel(
                this, this.instanceId,
                this.host.isPaused && this.host.setPaused
                    ? {
                        isPaused: () => this.host.isPaused?.() ?? false,
                        setPaused: (paused: boolean) => this.host.setPaused?.(paused),
                    }
                    : undefined);
            case EmulatorPanelType.VIP_PALETTES: return new PalettesPanel(this, this.instanceId);
            case EmulatorPanelType.VIP_COLUMN_TABLE: return new ColumnTablePanel(this, this.instanceId);
            case EmulatorPanelType.VIP_CHARACTERS: return new CharactersPanel(this, this.instanceId, this.exportFile());
            case EmulatorPanelType.VIP_BGMAPS: return new BgMapsPanel(this, this.instanceId, this.exportFile());
            case EmulatorPanelType.VIP_WORLDS: return new WorldsPanel(this, this.instanceId, this.exportFile());
            case EmulatorPanelType.VIP_OBJECTS: return new ObjectsPanel(this, this.instanceId, this.exportFile());
            case EmulatorPanelType.VIP_FRAME_BUFFERS: return new FrameBuffersPanel(this, this.instanceId);
            case EmulatorPanelType.VCU: return new VcuPanel(this, this.instanceId);
            case EmulatorPanelType.VSU: return new VsuPanel(this, this.instanceId);
            case EmulatorPanelType.TERMINAL: return new TerminalPanel(this, this.instanceId);
            case EmulatorPanelType.ROM_INFO: return new RomInfoPanel(this, this.instanceId);
            case EmulatorPanelType.SRAM: return new SramPanel(this, this.instanceId);
            case EmulatorPanelType.RUMBLE_PACK: return new RumblePackPanel(this, this.instanceId, this.rumblePack);
            case EmulatorPanelType.ES_SOUND: return new EsSoundPanel(this, this.instanceId, this.esSound);
            default: throw new Error(`Unknown emulator panel: ${kind}`);
        }
    }

    protected clearPanels(): void {
        for (const panel of this.panels.values()) {
            if (!panel.isDisposed) {
                panel.dispose();
            }
        }
        this.panels.clear();
    }

    resetLayout(): void {
        this.clearPanels();

        const main = this.deserializeArea(this.colorMode
            ? colorLayout(this.node.clientWidth)
            : this.host.defaultLayout ?? DEFAULT_LAYOUT);
        if (main) {
            try {
                this.restoreArrangement(main);
            } catch {
                // a bug in the built-in default is still better recovered from than left half-applied
                this.clearPanels();
            }
        }

        // not an "else": the expected outcome, and the fallback if applying the default left nothing docked
        if (!this.holdsScreen()) {
            this.addWidget(this.screen);
        }
        this.onDidChangeLayoutEmitter.fire();
    }

    // Play mode: hides the debug panels without closing them. `restoreLayout` only unparents widgets, so
    // `applySerializedLayout`/`resetLayout` bring back the same live instances. Cheats, macros, patches, colors
    // and achievements are not panels, see `EmulatorHost#renderCheats`
    showScreenOnly(): void {
        const main = this.deserializeArea({ type: 'tab-area', panels: [EmulatorPanelType.SCREEN], currentIndex: 0 });
        if (main) {
            this.restoreArrangement(main);
        }
    }

    // the screen's tab bar is pointless chrome when it is the only thing docked, as in Play mode
    setPlayMode(active: boolean): void {
        this.toggleClass('vp-dock-play-mode', active);
        this.updatePlayModeTabBars();
        this.debugMode = !active;
        this.applyPixelOrigins();
        this.inspector.setEnabled(!active && !this.colorMode);
    }

    // the screen inspector gives way to the color editor's tools over the picture, and Reset Layout means Color mode's
    // arrangement. The host takes the dock out of Play mode first, as Color mode keeps pixel origins like Debug mode
    setColorMode(active: boolean): void {
        this.colorMode = active && this.colorEditor !== undefined;
        // the inspector lets go of the picture's origins before the tools ask for them, as both are streamed from one
        // switch
        this.inspector.setEnabled(this.debugMode && !this.colorMode);
        this.colorTools?.setEnabled(this.colorMode);
    }

    get isColorMode(): boolean {
        return this.colorMode;
    }

    // `.vp-dock-play-mode .lm-TabBar { display: none }` hides the bar, but `DockLayout` still reserves its height
    // unless the widget itself is hidden
    protected updatePlayModeTabBars(): void {
        // `setHidden` re-fits the layout, which can re-enter through `layoutModified`
        if (this.applyingPlayModeTabBars) {
            return;
        }
        this.applyingPlayModeTabBars = true;
        try {
            const play = this.hasClass('vp-dock-play-mode');
            for (const tabBar of this.tabBars()) {
                tabBar.setHidden(play);
            }
        } finally {
            this.applyingPlayModeTabBars = false;
        }
    }

    private applyingPlayModeTabBars = false;

    // Lumino's config holds widget instances, which cannot be stored, so each is replaced by its panel kind
    serializeLayout(): VueportDockLayout {
        return { main: this.serializeArea(this.saveLayout().main) };
    }

    applySerializedLayout(layout: VueportDockLayout | undefined): void {
        const main = layout?.main ? this.deserializeArea(layout.main) : undefined;
        if (!main) {
            this.resetLayout();
            return;
        }

        try {
            this.restoreArrangement(main);
        } catch {
            // a stored layout can go stale, and a half-applied dock tree is worse than the default
            this.resetLayout();
            return;
        }

        // the screen is not closable, so a layout without it would leave nowhere to draw
        if (!this.holdsScreen()) {
            this.addWidget(this.screen);
        }
        // nor are Color mode's panels: an arrangement saved with one of them closed gives way to the mode's own
        if (this.colorMode && !this.holdsColorPanels()) {
            this.resetLayout();
        }
    }

    // restored while the dock had no size, to be restored again once it has one
    protected pendingArrangement?: DockLayout.AreaConfig;

    // Lumino turns relative split sizes into pixels against the current dock size, and a host may restore
    // before the dock is shown (a reload in Debug mode), which made every split even. So this is applied
    // again on the first `onResize`
    protected restoreArrangement(main: DockLayout.AreaConfig): void {
        this.restoreLayout({ main });
        this.pendingArrangement = this.node.clientWidth > 0 && this.node.clientHeight > 0 ? undefined : main;
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        const main = this.pendingArrangement;
        if (main && this.node.clientWidth > 0 && this.node.clientHeight > 0) {
            this.pendingArrangement = undefined;
            this.restoreLayout({ main });
        }
    }

    protected holdsColorPanels(): boolean {
        const kinds = new Set<EmulatorPanelType>();
        for (const widget of this.widgets()) {
            if (widget instanceof Panel) {
                kinds.add(widget.kind);
            }
        }
        return EMULATOR_COLOR_PANEL_TYPES.every(kind => kinds.has(kind));
    }

    // asked of the layout, not the DOM: a host restores before the dock is attached, and `isAttached` there
    // added the screen a second time, into the first tab group
    protected holdsScreen(): boolean {
        for (const widget of this.widgets()) {
            if (widget === this.screen) {
                return true;
            }
        }
        return false;
    }

    protected serializeArea(area: DockLayout.AreaConfig | null): AreaLayout | undefined {
        if (!area) {
            return undefined;
        }
        if (area.type === 'tab-area') {
            const panels = area.widgets
                .map(widget => this.kindOf(widget))
                .filter((kind): kind is EmulatorPanelType => kind !== undefined);
            return panels.length === 0
                ? undefined
                : { type: 'tab-area', panels, currentIndex: Math.max(0, Math.min(area.currentIndex, panels.length - 1)) };
        }

        const children = area.children
            .map(child => this.serializeArea(child))
            .filter((child): child is AreaLayout => child !== undefined);
        if (children.length === 0) {
            return undefined;
        }
        return {
            type: 'split-area',
            orientation: area.orientation,
            children,
            sizes: area.sizes.slice(0, children.length),
        };
    }

    protected deserializeArea(area: AreaLayout): DockLayout.AreaConfig | undefined {
        if (area.type === 'tab-area') {
            const widgets = area.panels
                .map(kind => this.widgetFor(kind))
                .filter((widget): widget is Widget => widget !== undefined);
            return widgets.length === 0
                ? undefined
                : { type: 'tab-area', widgets, currentIndex: Math.max(0, Math.min(area.currentIndex, widgets.length - 1)) };
        }

        const children = area.children
            .map(child => this.deserializeArea(child))
            .filter((child): child is DockLayout.AreaConfig => child !== undefined);
        return children.length === 0
            ? undefined
            : { type: 'split-area', orientation: area.orientation, children, sizes: area.sizes.slice(0, children.length) };
    }

    protected kindOf(widget: Widget): EmulatorPanelType | undefined {
        if (widget === this.screen) {
            return EmulatorPanelType.SCREEN;
        }
        return widget instanceof Panel ? widget.kind : undefined;
    }

    protected widgetFor(kind: EmulatorPanelType): Widget | undefined {
        if (kind === EmulatorPanelType.SCREEN) {
            return this.screen;
        }
        if (!EMULATOR_DEBUG_PANELS.includes(kind) && !(this.colorEditor && isColorPanel(kind))) {
            return undefined;
        }
        const existing = this.panels.get(kind);
        if (existing && !existing.isDisposed) {
            return existing;
        }
        const panel = this.createPanel(kind);
        this.panels.set(kind, panel);
        return panel;
    }

    protected focusWidget(widget: Widget): void {
        this.selectWidget(widget);
        widget.activate();
        this.revealTab(widget);
    }

    // a tab row scrolls once tabs overflow, so a just-opened panel's tab could be off the end
    protected revealTab(widget: Widget): void {
        const tabBar = this.tabBarFor(widget);
        const index = tabBar?.titles.indexOf(widget.title) ?? -1;
        if (!tabBar || index < 0) {
            return;
        }
        tabBar.contentNode.children[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    dispose(): void {
        this.flushPanelPreferences();
        this.inspector.dispose();
        this.colorTools?.dispose();
        this.colorSheetWatch?.dispose();
        this.breakpoints.dispose();
        this.onDidChangeEmitter.dispose();
        this.onDidChangeLayoutEmitter.dispose();
        this.onDidRequestAddPanelEmitter.dispose();
        this.onDidRequestResetLayoutEmitter.dispose();
        super.dispose();
    }
}

export type AreaLayout =
    | { type: 'tab-area', panels: EmulatorPanelType[], currentIndex: number }
    | {
        type: 'split-area',
        orientation: 'horizontal' | 'vertical',
        children: AreaLayout[],
        sizes: number[]
    };

export interface VueportDockLayout {
    main?: AreaLayout;
}
