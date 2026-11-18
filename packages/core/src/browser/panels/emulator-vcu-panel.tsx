import { Plug, Warning } from '@phosphor-icons/react';
import * as React from 'react';
import { ScreenInspectorTarget } from './emulator-screen-inspector';
import { nls } from '../../common/emulator-nls';
import EmptyContainer from '../components/kit/EmptyContainer';
import { vbColorSupportLabel } from '../emulator-types';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { EmulatorPanelType, hex, DebugSource, Panel, scrollIntoViewSmoothly } from './emulator-panel';
import {
    VBC_ID0_VALUE,
    VBC_ID1_VALUE,
    VCU_CRAM_BASE,
    VCU_CRAM_BYTES,
    VCU_CRAM_COLORS,
    VCU_CRAM_PALETTE_SIZE,
    VCU_NAMED_REGISTER_BYTES,
    VCU_REGISTER_BASE,
    VCU_REGISTER_BLOCK_BYTES,
    VcuRegister,
    vcuRgb888,
} from './emulator-vcu-memory';

interface VcuRegisterDescription {
    name: string
    offset: VcuRegister
    label: string
}

// shared with the Registers panel, which lists the same block under VCU
export const VCU_REGISTER_GROUPS: { group: string; registers: VcuRegisterDescription[] }[] = [
    {
        group: 'Identification',
        registers: [
            { name: 'VBCID0', offset: VcuRegister.VBCID0, label: 'Identifier 0' },
            { name: 'VBCID1', offset: VcuRegister.VBCID1, label: 'Identifier 1' },
            { name: 'VBCVER', offset: VcuRegister.VBCVER, label: 'VCU Version' },
            { name: 'VBCCTRL', offset: VcuRegister.VBCCTRL, label: 'Enable / Status' },
        ],
    },
    {
        group: 'Clock / Display / Link',
        registers: [
            { name: 'CPUSPD', offset: VcuRegister.CPUSPD, label: 'CPU Speed' },
            { name: 'COLCTRL', offset: VcuRegister.COLCTRL, label: 'Color Control' },
            { name: 'CBKPAL', offset: VcuRegister.CBKPAL, label: 'Color Backdrop Palette' },
            { name: 'LNKCTRL', offset: VcuRegister.LNKCTRL, label: 'Link Control' },
        ],
    },
    {
        group: 'Characters / Memory',
        registers: [
            { name: 'CHRCTRL', offset: VcuRegister.CHRCTRL, label: 'Character Control' },
            { name: 'MEMCTRL', offset: VcuRegister.MEMCTRL, label: 'Memory Control' },
        ],
    },
    {
        group: 'Color Brightness Reference',
        registers: [
            { name: 'CBRTRA', offset: VcuRegister.CBRTRA, label: 'Reference A' },
            { name: 'CBRTRB', offset: VcuRegister.CBRTRB, label: 'Reference B' },
            { name: 'CBRTRC', offset: VcuRegister.CBRTRC, label: 'Reference C' },
        ],
    },
    {
        group: 'Color Extension',
        registers: [
            { name: 'CXCTRL', offset: VcuRegister.CXCTRL, label: 'Color Extension Control' },
            { name: 'PCCAP', offset: VcuRegister.PCCAP, label: 'Pixel Color Slot Capacity' },
        ],
    },
    {
        group: 'DMA',
        registers: [
            { name: 'DMASRCL', offset: VcuRegister.DMASRCL, label: 'Source Address (low)' },
            { name: 'DMASRCH', offset: VcuRegister.DMASRCH, label: 'Source Address (high)' },
            { name: 'DMADSTL', offset: VcuRegister.DMADSTL, label: 'VCU Destination (low)' },
            { name: 'DMADSTH', offset: VcuRegister.DMADSTH, label: 'VCU Destination (high)' },
            { name: 'DMALEN', offset: VcuRegister.DMALEN, label: 'Length' },
            { name: 'DMACTRL', offset: VcuRegister.DMACTRL, label: 'Control' },
        ],
    },
];

export function registerHint(name: string, label: string, value: number): string {
    switch (name) {
        case 'VBCCTRL': return `${label} · ${value & 1 ? 'VBCEN' : 'legacy state'}`;
        case 'CPUSPD': return `${label} · ${value & 1 ? '40 MHz' : '20 MHz'}`;
        case 'COLCTRL': return `${label} · ${value & 1 ? 'color' : 'legacy'}`;
        case 'CBKPAL': return `${label} · palette ${value & 0xff}`;
        case 'LNKCTRL': return `${label} · ${value & 1 ? '200 kHz' : '50 kHz'}`;
        case 'CHRCTRL': return `${label} · ${value & 1 ? '12-bit Characters' : '11-bit Characters'}`;
        case 'MEMCTRL': return `${label} · ${value & 1 ? '256 KiB WRAM' : '64 KiB WRAM'}`;
        case 'CBRTRA':
        case 'CBRTRB':
        case 'CBRTRC': return `${label} · ${value & 0xff ? `${value & 0xff}` : 'off (unscaled)'}`;
        case 'VBCVER': return `${label} · ${((value >> 8) & 0xff)}.${value & 0xff}`;
        case 'CXCTRL': {
            const on = [value & 1 ? 'PCEN' : '', value & 2 ? 'WCEN' : '', value & 4 ? 'BKREN' : '', value & 8 ? 'CCEN' : ''].filter(Boolean);
            return `${label} · ${on.length ? on.join(' ') : 'off (base behavior)'}`;
        }
        case 'PCCAP': return `${label} · ${value} slots`;
        case 'DMALEN': return `${label} · ${value === 0 ? 65536 : value} halfwords`;
        case 'DMACTRL': return `${label} · START is write-only, reads zero`;
        default: return label;
    }
}

// only what VBC 1.0 documents: bit 0 of the six control registers, the three Color Extension enables, CBKPAL's
// palette field, the brightness references, the DMA destination's high bits and the DMA start bit. The rest stays
// unnamed rather than guessed at, as a wrong label is worse than none. Add to this as the hardware is documented.
const NAMED_BITS: Record<string, Record<number, string>> = {
    VBCCTRL: { 0: 'VBCEN' },
    CPUSPD: { 0: 'SPD' },
    COLCTRL: { 0: 'COLEN' },
    LNKCTRL: { 0: 'LNKSPD' },
    CHRCTRL: { 0: 'CHREXT' },
    MEMCTRL: { 0: 'WRAMEXT' },
    CXCTRL: { 0: 'PCEN', 1: 'WCEN', 2: 'BKREN', 3: 'CCEN' },
    DMADSTH: { 0: 'DST16', 1: 'DST17', 2: 'DST18', 3: 'DST19' },
    DMACTRL: { 0: 'START' },
    ...Object.fromEntries(['CBRTRA', 'CBRTRB', 'CBRTRC'].map(name => [name,
        Object.fromEntries(Array.from({ length: 8 }, (_, bit) => [bit, `REF${bit}`]))])),
    CBKPAL: Object.fromEntries(
        Array.from({ length: 8 }, (_, bit) => [bit, `PAL${bit}`])),
};

// only for registers with bit fields (see NAMED_BITS). The identifiers and the version are constants, not flags.
function RegisterBits(props: { name: string, value: number }): React.JSX.Element {
    const { name, value } = props;
    const named = NAMED_BITS[name] ?? {};
    return <span className='vp-vcu-bits'>
        {Array.from({ length: 16 }, (_, index) => {
            const bit = 15 - index;
            const set = (value >> bit & 1) === 1;
            const label = named[bit];
            return <span
                key={bit}
                className={'vp-vcu-bit'
                    + (set ? ' on' : '')
                    + (label ? ' named' : '')}
                title={`${label ? `${label} · ` : ''}bit ${bit} · ${set ? '1' : '0'}`}
            >{set ? '1' : '0'}</span>;
        })}
    </span>;
}

export class VcuPanel extends Panel {

    protected registers?: DataView;
    protected cram?: DataView;
    protected revealedPalette?: number;
    protected error?: string;

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.VCU, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/vcu/title', 'VCU');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.VCU);
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim || !this.source.vbcSupportEnabled) {
            this.registers = undefined;
            this.cram = undefined;
            this.update();
            return;
        }

        try {
            const [registers, cram] = await Promise.all([
                sim.readMemory(VCU_REGISTER_BASE, VCU_REGISTER_BLOCK_BYTES),
                sim.readMemory(VCU_CRAM_BASE, VCU_CRAM_BYTES),
            ]);
            this.registers = new DataView(registers);
            this.cram = new DataView(cram);
            this.error = undefined;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }
        this.update();
    }

    protected render(): React.ReactNode {
        // the panel opens on any machine (see setVbcSupportEnabled), so both reasons for there being no VCU to read are
        // explained here, or an empty panel looks broken
        if (!this.source.vbcSupportEnabled) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/debug/panels/vcu/noVsu',
                    'No VCU present'
                )}
                description={nls.localize(
                    'vueport/debug/panels/vcu/supportOff',
                    'VB Color support is switched off, so this machine has no VCU. Turn it on in Settings.'
                )}
                icon={<Warning size={32} />}
            />;
        }
        // VBC support being on doesn't mean a VB Color is running: Auto picks an original Virtual Boy for a ROM that
        // does not ask for color
        if (!this.source.vbcHardwareActive) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/debug/panels/vcu/noVsu',
                    'No VCU present'
                )}
                description={nls.localize(
                    'vueport/debug/panels/vcu/noVsuDdscription',
                    'This machine is running as an original Virtual Boy. The VCU exists only in VB Color mode.'
                )}
                icon={<Warning size={32} />}
            />;
        }
        if (this.error) {
            return <EmptyContainer
                title={this.error}
                icon={<Warning size={32}
                />} />;
        }
        if (!this.registers || !this.cram) {
            return <EmptyContainer
                title={nls.localize('vueport/general/notRunning', 'The emulator is not running.')}
                icon={<Plug size={32} />}
            />;
        }

        const present = this.registers.getUint16(VcuRegister.VBCID0, true) === VBC_ID0_VALUE
            && this.registers.getUint16(VcuRegister.VBCID1, true) === VBC_ID1_VALUE;

        return <div className='vp-vcu-panel'>
            {this.renderOverview(present)}
            {present ? <>
                {this.renderRegisters()}
                {this.renderCram()}
            </> : <EmptyContainer
                title={nls.localize(
                    'vueport/debug/panels/vcu/notPresent',
                    'The VCU is not present on the selected hardware.'
                )}
                icon={<Warning size={32} />}
            />}
        </div>;
    }

    protected renderOverview(present: boolean): React.ReactNode {
        const support = this.source.romHeader.vbcSupport;
        return <div className='vp-vcu-overview'>
            <fieldset className='vp-inspector-group'>
                <legend>{nls.localize('vueport/debug/panels/vcu/hardware', 'Hardware')}</legend>
                <table>
                    <tbody>
                        <tr>
                            <th>{nls.localize('vueport/debug/panels/vcu/cartridge', 'Cartridge')}</th>
                            <td><code>{hex(support, 2)}</code> ({vbColorSupportLabel(support)})</td>
                        </tr>
                        <tr>
                            <th>{nls.localize('vueport/debug/panels/vcu/hardwareMode', 'Hardware mode')}</th>
                            <td>{nls.localize('vueport/vbColor/hardware/vbColor', 'VB Color')}</td>
                        </tr>
                        <tr>
                            <th>{nls.localize('vueport/debug/panels/vcu/present', 'VCU present')}</th>
                            <td>{present
                                ? nls.localize('vueport/general/yes', 'Yes')
                                : nls.localize('vueport/general/no', 'No')}</td>
                        </tr>
                    </tbody>
                </table>
            </fieldset>
        </div>;
    }

    protected renderRegisters(): React.ReactNode {
        const block = this.registers!;
        return <fieldset className='vp-inspector-group vp-vip vp-vcu-registers vp-scroll'>
            <legend>{nls.localize('vueport/debug/panels/vcu/registers', 'Registers')}</legend>
            <div className='vp-groups'>
                {VCU_REGISTER_GROUPS.map(({ group, registers }) => (
                    <div className='vp-group' key={group}>
                        <h4>{group}</h4>
                        <table>
                            <tbody>
                                {registers.map(({ name, offset, label }) => {
                                    const value = block.getUint16(offset, true);
                                    return <tr key={name}>
                                        <th title={label}>{name}</th>
                                        <td><code>{hex(value, 4)}</code></td>
                                        <td>{NAMED_BITS[name]
                                            ? <RegisterBits name={name} value={value} />
                                            : null}</td>
                                        <td className='hint'>
                                            {registerHint(name, label, value)}
                                            {name === 'CBKPAL' && this.renderBackdropSwatches(value)}
                                        </td>
                                    </tr>;
                                })}
                            </tbody>
                        </table>
                    </div>
                ))}
            </div>
            {this.renderReserved()}
        </fieldset>;
    }

    // the four colors CBKPAL points at, so the backdrop color does not have to be counted out of the CRAM grid
    protected renderBackdropSwatches(value: number): React.ReactNode {
        const palette = value & 0xff;
        const first = palette * VCU_CRAM_PALETTE_SIZE;
        return <span className='vp-vcu-backdrop'>
            {Array.from({ length: VCU_CRAM_PALETTE_SIZE }, (_, index) => {
                const entry = this.cram!.getUint32((first + index) * 4, true);
                const color = vcuRgb888(entry);
                return <span
                    key={index}
                    className='vp-vcu-backdrop-swatch'
                    style={{ backgroundColor: color.css }}
                    title={`CRAM ${hex(first + index, 3)} · ${color.css}`}
                />;
            })}
        </span>;
    }

    // VBC 1.0 reserves 256 bytes here and documents the first 44. The rest is shown anyway, since a supposedly reserved
    // word in use is exactly what this panel should reveal. All-zero rows are folded away
    protected renderReserved(): React.ReactNode {
        const block = this.registers!;
        const perRow = 8;
        const rows: { offset: number, words: number[] }[] = [];
        for (let offset = VCU_NAMED_REGISTER_BYTES; offset < VCU_REGISTER_BLOCK_BYTES; offset += perRow * 2) {
            // the named registers end off the row grid, so the last row is short rather than reading past the block
            const words = Array.from({ length: Math.min(perRow, (VCU_REGISTER_BLOCK_BYTES - offset) / 2) }, (_, index) =>
                block.getUint16(offset + index * 2, true));
            if (words.some(word => word !== 0)) {
                rows.push({ offset, words });
            }
        }

        return <div className='vp-vcu-reserved'>
            <h4>
                {nls.localize('vueport/debug/panels/vcu/reserved', 'Reserved ({0}–{1})',
                    hex(VCU_REGISTER_BASE + VCU_NAMED_REGISTER_BYTES, 8),
                    hex(VCU_REGISTER_BASE + VCU_REGISTER_BLOCK_BYTES - 1, 8))}
            </h4>
            {rows.length === 0
                ? <p className='hint'>
                    {nls.localize('vueport/debug/panels/vcu/reservedAllZero',
                        'Every reserved word reads zero.')}
                </p>
                : <table>
                    <tbody>
                        {rows.map(({ offset, words }) => <tr key={offset}>
                            <th><code>{hex(VCU_REGISTER_BASE + offset, 8)}</code></th>
                            {words.map((word, index) =>
                                <td key={index}><code>{hex(word, 4)}</code></td>)}
                        </tr>)}
                    </tbody>
                </table>}
        </div>;
    }

    reveal(target: ScreenInspectorTarget): void {
        if (target.kind !== 'vbcPalette') {
            return;
        }
        this.revealedPalette = target.palette;
        this.whenRendered(() => {
            const palette = this.node.querySelector('.vp-vcu-cram-palette.selected');
            if (palette) {
                scrollIntoViewSmoothly(palette, 'center');
            }
        });
    }

    protected renderCram(): React.ReactNode {
        const colors = Array.from({ length: VCU_CRAM_COLORS }, (_, index) => {
            const value = this.cram!.getUint32(index * 4, true) & 0xffffff;
            const color = vcuRgb888(value);
            return { index, value, ...color };
        });

        return <fieldset className='vp-inspector-group vp-vcu-cram-set vp-scroll'>
            <legend>{nls.localize('vueport/debug/panels/vcu/cram', 'Color RAM (CRAM)')}</legend>
            <div className='vp-vcu-cram'>
                {Array.from({ length: VCU_CRAM_COLORS / VCU_CRAM_PALETTE_SIZE }, (_, palette) =>
                    <div
                        className={`vp-vcu-cram-palette${palette === this.revealedPalette ? ' selected' : ''}`}
                        key={palette}
                        onMouseEnter={() => this.light({ kind: 'vbcPalette', palette })}
                        onMouseLeave={() => this.light(undefined)}
                    >
                        <span className='vp-vcu-cram-palette-label'>
                            {hex(palette, 2)}
                        </span>
                        {colors
                            .slice(palette * VCU_CRAM_PALETTE_SIZE,
                                (palette + 1) * VCU_CRAM_PALETTE_SIZE)
                            .map(color => <code
                                className='vp-vcu-cram-color'
                                data-cram-index={color.index}
                                key={color.index}
                                style={{ backgroundColor: color.css, color: color.dark ? '#fff' : '#000' }}
                                title={`CRAM ${hex(color.index, 3)} · RGB888 ${hex(color.value, 6)} · ${color.css}`}
                            >
                                <span>{hex(color.value, 6)}</span>
                            </code>)}
                    </div>)}
            </div>
        </fieldset>;
    }
}
