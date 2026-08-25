import { nls } from '../../common/emulator-nls';
import { Disposable } from '../../common/emulator-events';
import { VueportReactWidget } from '../emulator-widget-base';
import { Message } from '@lumino/messaging';
import { VesVbSim } from '../core/vb-core';
import { VesEmulatorSymbolIndex } from '../core/emulator-symbols';
import { VesScreenRect } from './emulator-screen-panel';
import { RomHeader } from '../emulator-types';

/** Identifies a panel type, and is what a persisted layout stores. */
export enum EmulatorPanelType {
    SCREEN = 'screen',
    REGISTERS = 'registers',
    MEMORY = 'memory',
    MEMORY_POOLS = 'memoryPools',
    ACTORS = 'actors',
    DISASSEMBLY = 'disassembly',
    VIP_PALETTES = 'vipPalettes',
    VIP_CHARACTERS = 'vipCharacters',
    VIP_BGMAPS = 'vipBgMaps',
    VIP_WORLDS = 'vipWorlds',
    VIP_OBJECTS = 'vipObjects',
    VIP_FRAME_BUFFERS = 'vipFrameBuffers',
    VSU = 'vsu',
    TERMINAL = 'terminal',
    CHEATS = 'cheats',
    ES_SOUND = 'esSound',
    ROM_INFO = 'romInfo',
    RUMBLE_PACK = 'rumblePack',
}

/**
 * Each panel's title, as a function returning it rather than as the string
 * itself.
 *
 * This module is imported before the host installs its localization, so a table
 * of finished strings built here would be built while the fallback
 * implementation was still in place and would stay English for the life of the
 * process. Deferring the call to `emulatorPanelLabel` moves it to the moment a
 * title is actually shown. See `setLocalization`.
 */
const EMULATOR_PANEL_LABELS: Record<EmulatorPanelType, () => string> = {
  [EmulatorPanelType.REGISTERS]: () => nls.localize('vueport/panels/registers', 'Registers'),
  [EmulatorPanelType.DISASSEMBLY]: () => nls.localize('vueport/panels/disassembly', 'Disassembly'),
  [EmulatorPanelType.MEMORY]: () => nls.localize('vueport/panels/memory', 'Memory'),
  [EmulatorPanelType.MEMORY_POOLS]: () => nls.localize('vueport/panels/memoryPools', 'Memory Pools'),
  [EmulatorPanelType.ACTORS]: () => nls.localize('vueport/panels/actors', 'Actors'),
  [EmulatorPanelType.SCREEN]: () => nls.localize('vueport/panels/screen', 'Screen'),
  [EmulatorPanelType.VIP_PALETTES]: () => nls.localize('vueport/panels/palettes/title', 'Palettes'),
  [EmulatorPanelType.VIP_CHARACTERS]: () => nls.localize('vueport/panels/characters/title', 'Characters'),
  [EmulatorPanelType.VIP_BGMAPS]: () => nls.localize('vueport/panels/bgMaps', 'BGMaps'),
  [EmulatorPanelType.VIP_WORLDS]: () => nls.localize('vueport/panels/worlds/title', 'Worlds'),
  [EmulatorPanelType.VIP_OBJECTS]: () => nls.localize('vueport/panels/objects/title', 'Objects'),
  [EmulatorPanelType.VIP_FRAME_BUFFERS]: () => nls.localize('vueport/panels/frameBuffers', 'Frame Buffers'),
  [EmulatorPanelType.VSU]: () => nls.localize('vueport/panels/vsu/title', 'VSU'),
  [EmulatorPanelType.TERMINAL]: () => nls.localize('vueport/panels/terminal', 'Terminal'),
  [EmulatorPanelType.ROM_INFO]: () => nls.localize('vueport/panels/romInfo/title', 'ROM Info'),
  [EmulatorPanelType.CHEATS]: () => nls.localize('vueport/panels/cheats', 'Cheats'),
  [EmulatorPanelType.ES_SOUND]: () => nls.localize('vueport/panels/esSound', 'ESSound'),
  [EmulatorPanelType.RUMBLE_PACK]: () => nls.localize('vueport/panels/rumblePack/title', 'Rumble Pack'),
};

/** A panel's title, translated at the moment it is asked for. */
export function emulatorPanelLabel(type: EmulatorPanelType): string {
  return EMULATOR_PANEL_LABELS[type]();
}

/** Every panel type, for building a menu over all of them. */
export const EMULATOR_PANEL_TYPES = Object.keys(EMULATOR_PANEL_LABELS) as EmulatorPanelType[];

/**
 * What a debug panel is allowed to ask of the running emulator.
 *
 * Panels are handed this rather than the widget so that they cannot drive
 * emulation, only observe it.
 */
export interface VesEmulatorDebugSource {
    /** The simulation being inspected, or undefined before it has booted. */
    readonly sim: VesVbSim | undefined;
    /** The header of the ROM currently loaded, parsed once at load time. */
    readonly romHeader: RomHeader;
    /** The ROM's size in MBit. */
    readonly romSize: number;
    /**
     * The build mode the ROM was made with, as the build names it, or
     * undefined for one that was not built here — see `readBuildModeFromMap`.
     */
    readonly buildMode: string | undefined;
    /** Fires when emulation state changes in a way panels should redraw for. */
    onDidChange(listener: () => void): Disposable;
    /**
     * The symbols of the ROM being run, for panels that can say more with
     * them — where the engine put something, or what a name in the project
     * calls it. Resolves to undefined for a ROM that was not built here, or
     * was built without symbols beside it, which such a panel has to treat as
     * an ordinary state rather than a failure.
     *
     * Reading them is expensive enough that it only happens when something
     * asks, so a panel should call this from its refresh rather than
     * preemptively; the result is shared and cached for as long as the ROM is.
     */
    getSymbols(): Promise<VesEmulatorSymbolIndex | undefined>;
    /**
     * Mark rectangles on the picture, in the Virtual Boy's screen space, or
     * clear them with an empty list.
     *
     * The one thing here that changes what is on screen rather than only
     * reading it — but it draws over the picture rather than into it, so it
     * cannot affect what the machine is doing. A panel that sets these owns
     * them: it has to clear them when it stops being the one describing the
     * selection, including when it is hidden or closed.
     */
    setHighlights(rects: VesScreenRect[]): void;
}

/**
 * Base for the debug panels docked beside the screen.
 *
 * Panels poll rather than being pushed to, because the emulator produces fifty
 * frames a second and no inspector needs that. Polling only runs while a panel
 * is actually visible, so a stack of hidden tabs costs nothing.
 */
export abstract class VesEmulatorPanel extends VueportReactWidget {

    /** Refreshes a second. Fast enough to read, slow enough to stay cheap. */
    protected static readonly POLL_HZ = 10;

    /**
     * How often this panel refreshes. Overridden by panels whose reads are
     * expensive enough that ten times a second is not worth it.
     */
    protected pollHz(): number {
        return VesEmulatorPanel.POLL_HZ;
    }

    // toDisposeOnDetach is inherited from BaseWidget, which clears it on
    // detach; redeclaring it here would shadow that.
    protected pollTimer?: number;

    constructor(
        readonly kind: EmulatorPanelType,
        protected readonly source: VesEmulatorDebugSource,
        instanceId: string
    ) {
        super();
        this.id = `vueport-panel:${instanceId}:${kind}`;
        this.title.closable = true;
        this.addClass('vueport-panel');
    }

    protected onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.startPolling();
    }

    protected onAfterAttach(msg: Message): void {
        // The base renders from here, so its implementation has to run.
        super.onAfterAttach(msg);
        if (this.isVisible) {
            this.startPolling();
        }
    }

    protected onAfterHide(msg: Message): void {
        super.onAfterHide(msg);
        this.stopPolling();
    }

    protected onBeforeDetach(msg: Message): void {
        this.stopPolling();
        super.onBeforeDetach(msg);
    }

    /**
     * Every poll tick re-renders through React, and this node (`.emulator-panel`,
     * see the constructor) is where `overflow: auto` actually lives for most
     * panels — the ones that just fill it with a table or a list rather than
     * managing their own inner scroll region (Terminal, the VIP inspectors).
     *
     * React reuses DOM nodes it can match up between renders, but a table
     * whose rows are keyed by something that legitimately changes under
     * polling — which row a filter now includes, say — can't always be
     * matched, and removing/reinserting the node currently under the
     * scrollbar is enough for the browser to reset scrollTop on its own.
     * Ten times a second, that reads as scrolling not working at all.
     * Saving and restoring it around the render is cheap insurance against
     * that, whichever panel's render happens to trigger it.
     */
    protected onUpdateRequest(msg: Message): void {
        const { scrollTop, scrollLeft } = this.node;
        super.onUpdateRequest(msg);
        this.node.scrollTop = scrollTop;
        this.node.scrollLeft = scrollLeft;
    }

    protected startPolling(): void {
        if (this.pollTimer !== undefined) {
            return;
        }
        this.refresh();
        this.pollTimer = window.setInterval(() => this.refresh(), 1000 / this.pollHz());
    }

    /** Pick up a changed poll rate, if the panel is currently polling. */
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

    /** Pull fresh data and redraw. Implementations should tolerate no sim. */
    protected abstract refresh(): void;

    dispose(): void {
        this.stopPolling();
        super.dispose();
    }
}

/** Format a number as a fixed-width hexadecimal string. */
export function hex(value: number, digits: number): string {
    return (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}
