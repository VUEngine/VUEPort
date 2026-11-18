import { VirtualElement } from '@lumino/virtualdom';
import {
    ChartBar,
    Hammer,
    PaintBrushBroad,
    TreeStructure,
    CirclesThree,
    Code,
    Cpu,
    Database,
    FrameCorners,
    Gauge,
    GridNine,
    HardDrives,
    IconProps,
    ListNumbers,
    Monitor,
    MusicNotes,
    Palette,
    Pulse,
    SpeakerHigh,
    SquaresFour,
    Stack,
    Swatches,
    Table,
    TerminalWindow,
    User,
} from '@phosphor-icons/react';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { nls } from '../../common/emulator-nls';
import { EmulatorPanelType } from './emulator-panel';

// families for the Add Panel picker's headings: VIDEO (VIP), CPU and the rest, so twenty names read as a few
// short lists. Each panel has its own icon (EMULATOR_PANEL_ICON)
export enum EmulatorPanelCategory {
    VIP = 'vip',
    CPU = 'cpu',
    MEMORY = 'memory',
    AUDIO = 'audio',
    HARDWARE = 'hardware',
    VUENGINE = 'vuengine',
    COLOR = 'color',
}

// in the order the picker groups panels by
export const EMULATOR_PANEL_CATEGORIES: { id: EmulatorPanelCategory; label(): string }[] = [
    { id: EmulatorPanelCategory.VIP, label: () => nls.localize('vueport/debug/panels/category/video', 'Video') },
    { id: EmulatorPanelCategory.CPU, label: () => nls.localize('vueport/debug/panels/category/cpu', 'CPU') },
    { id: EmulatorPanelCategory.MEMORY, label: () => nls.localize('vueport/debug/panels/category/memory', 'Memory') },
    { id: EmulatorPanelCategory.AUDIO, label: () => nls.localize('vueport/debug/panels/category/audio', 'Audio') },
    { id: EmulatorPanelCategory.HARDWARE, label: () => nls.localize('vueport/debug/panels/category/hardware', 'Hardware') },
    { id: EmulatorPanelCategory.VUENGINE, label: () => 'VUEngine' },
    { id: EmulatorPanelCategory.COLOR, label: () => nls.localize('vueport/color/category', 'Color Project') },
];

// the screen has none, as the picker never offers it
const EMULATOR_PANEL_CATEGORY: Record<EmulatorPanelType, EmulatorPanelCategory> = {
    [EmulatorPanelType.ACTORS]: EmulatorPanelCategory.VUENGINE,
    [EmulatorPanelType.DISASSEMBLY]: EmulatorPanelCategory.CPU,
    [EmulatorPanelType.ES_SOUND]: EmulatorPanelCategory.AUDIO,
    [EmulatorPanelType.MEMORY_POOLS]: EmulatorPanelCategory.VUENGINE,
    [EmulatorPanelType.MEMORY]: EmulatorPanelCategory.MEMORY,
    [EmulatorPanelType.PROFILER]: EmulatorPanelCategory.CPU,
    [EmulatorPanelType.REGISTERS]: EmulatorPanelCategory.CPU,
    [EmulatorPanelType.ROM_INFO]: EmulatorPanelCategory.HARDWARE,
    [EmulatorPanelType.RUMBLE_PACK]: EmulatorPanelCategory.HARDWARE,
    [EmulatorPanelType.SCREEN]: EmulatorPanelCategory.HARDWARE,
    [EmulatorPanelType.SRAM]: EmulatorPanelCategory.MEMORY,
    [EmulatorPanelType.TERMINAL]: EmulatorPanelCategory.HARDWARE,
    [EmulatorPanelType.VIP_BGMAPS]: EmulatorPanelCategory.VIP,
    [EmulatorPanelType.VIP_CHARACTERS]: EmulatorPanelCategory.VIP,
    [EmulatorPanelType.VIP_COLUMN_TABLE]: EmulatorPanelCategory.VIP,
    [EmulatorPanelType.VIP_FRAME_BUFFERS]: EmulatorPanelCategory.VIP,
    [EmulatorPanelType.VIP_OBJECTS]: EmulatorPanelCategory.VIP,
    [EmulatorPanelType.VIP_PALETTES]: EmulatorPanelCategory.VIP,
    [EmulatorPanelType.VIP_WORLDS]: EmulatorPanelCategory.VIP,
    [EmulatorPanelType.VCU]: EmulatorPanelCategory.VIP,
    [EmulatorPanelType.VSU]: EmulatorPanelCategory.AUDIO,
    [EmulatorPanelType.COLOR_PROJECT]: EmulatorPanelCategory.COLOR,
    [EmulatorPanelType.COLOR_BUILD]: EmulatorPanelCategory.COLOR,
    [EmulatorPanelType.COLOR_SHEET]: EmulatorPanelCategory.COLOR,
};

export function emulatorPanelCategory(type: EmulatorPanelType): typeof EMULATOR_PANEL_CATEGORIES[number] {
    const id = EMULATOR_PANEL_CATEGORY[type];
    return EMULATOR_PANEL_CATEGORIES.find(category => category.id === id)!;
}

// one icon per panel, not per family, chosen for what the panel shows (Palettes a palette, Disassembly code,
// SRAM a floppy), as a tab's icon must tell the tab apart
const EMULATOR_PANEL_ICON: Record<EmulatorPanelType, React.ComponentType<IconProps>> = {
    [EmulatorPanelType.ACTORS]: User,
    [EmulatorPanelType.DISASSEMBLY]: Code,
    [EmulatorPanelType.ES_SOUND]: MusicNotes,
    [EmulatorPanelType.MEMORY_POOLS]: HardDrives,
    [EmulatorPanelType.MEMORY]: Table,
    [EmulatorPanelType.PROFILER]: Gauge,
    [EmulatorPanelType.REGISTERS]: ListNumbers,
    [EmulatorPanelType.ROM_INFO]: Cpu,
    [EmulatorPanelType.RUMBLE_PACK]: Pulse,
    [EmulatorPanelType.SCREEN]: Monitor,
    [EmulatorPanelType.SRAM]: Database,
    [EmulatorPanelType.TERMINAL]: TerminalWindow,
    [EmulatorPanelType.VIP_BGMAPS]: GridNine,
    [EmulatorPanelType.VIP_CHARACTERS]: SquaresFour,
    [EmulatorPanelType.VIP_COLUMN_TABLE]: ChartBar,
    [EmulatorPanelType.VIP_FRAME_BUFFERS]: FrameCorners,
    [EmulatorPanelType.VIP_OBJECTS]: CirclesThree,
    [EmulatorPanelType.VIP_PALETTES]: Palette,
    [EmulatorPanelType.VIP_WORLDS]: Stack,
    [EmulatorPanelType.VCU]: Swatches,
    [EmulatorPanelType.VSU]: SpeakerHigh,
    [EmulatorPanelType.COLOR_PROJECT]: TreeStructure,
    [EmulatorPanelType.COLOR_BUILD]: Hammer,
    [EmulatorPanelType.COLOR_SHEET]: PaintBrushBroad,
};

export function emulatorPanelIcon(type: EmulatorPanelType): React.ComponentType<IconProps> {
    return EMULATOR_PANEL_ICON[type];
}

// as a Lumino title renderer: Title.icon wants a VirtualElement.IRenderer, so a React root is mounted into the
// node Lumino hands over, as VueportReactWidget does. render may get a different host if Lumino recreates the
// icon element, so the root follows the host
export function emulatorPanelTitleIcon(type: EmulatorPanelType): VirtualElement.IRenderer {
    const Icon = emulatorPanelIcon(type);
    let root: Root | undefined;
    let mountedOn: HTMLElement | undefined;
    return {
        render(host: HTMLElement): void {
            if (mountedOn !== host || !root) {
                root?.unmount();
                root = createRoot(host);
                mountedOn = host;
            }
            root.render(React.createElement(Icon, { size: 16, weight: 'regular' }));
        },
        unrender(): void {
            // deferred: React refuses to unmount a root from inside a render or lifecycle it is running, which unrender
            // can be called from (as in VueportReactWidget)
            const toUnmount = root;
            root = undefined;
            mountedOn = undefined;
            setTimeout(() => toUnmount?.unmount(), 0);
        },
    };
}
