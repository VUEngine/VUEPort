import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import { Registers } from '../../common/vb-protocol';
import { hex, DebugSource, Panel, EmulatorPanelType } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES, VipRegister } from './emulator-vip-memory';
import { readVbcState } from './emulator-vcu-memory';
import { registerHint, VCU_REGISTER_GROUPS } from './emulator-vcu-panel';
import EmptyContainer from '../components/kit/EmptyContainer';
import { Plug, Warning } from '@phosphor-icons/react';

interface Register {
    name: string
    offset: number
    label: string
}

interface RegisterGroup {
    group: string
    registers: Register[]
}

const VIP_REGISTER_GROUPS: RegisterGroup[] = [
    {
        group: 'Interrupts',
        registers: [
            { name: 'INTPND', offset: VipRegister.INTPND, label: 'Pending' },
            { name: 'INTENB', offset: VipRegister.INTENB, label: 'Enable' },
            { name: 'INTCLR', offset: VipRegister.INTCLR, label: 'Clear' },
        ],
    },
    {
        group: 'Display',
        registers: [
            { name: 'DPSTTS', offset: VipRegister.DPSTTS, label: 'Control Read' },
            { name: 'DPCTRL', offset: VipRegister.DPCTRL, label: 'Control Write' },
            { name: 'REST', offset: VipRegister.REST, label: 'Rest' },
            { name: 'FRMCYC', offset: VipRegister.FRMCYC, label: 'Frame Cycle' },
            { name: 'CTA', offset: VipRegister.CTA, label: 'Column Table Start' },
        ],
    },
    {
        group: 'Brightness',
        registers: [
            { name: 'BRTA', offset: VipRegister.BRTA, label: 'Brightness A' },
            { name: 'BRTB', offset: VipRegister.BRTB, label: 'Brightness B' },
            { name: 'BRTC', offset: VipRegister.BRTC, label: 'Brightness C' },
            { name: 'BKCOL', offset: VipRegister.BKCOL, label: 'Background Color' },
        ],
    },
    {
        group: 'Drawing',
        registers: [
            { name: 'XPSTTS', offset: VipRegister.XPSTTS, label: 'Control Read' },
            { name: 'XPCTRL', offset: VipRegister.XPCTRL, label: 'Control Write' },
            { name: 'VER', offset: VipRegister.VER, label: 'VIP Version' },
            { name: 'SPT0', offset: VipRegister.SPT0, label: 'Object Group 0' },
            { name: 'SPT1', offset: VipRegister.SPT1, label: 'Object Group 1' },
            { name: 'SPT2', offset: VipRegister.SPT2, label: 'Object Group 2' },
            { name: 'SPT3', offset: VipRegister.SPT3, label: 'Object Group 3' },
        ],
    },
    {
        group: 'Palettes',
        registers: [
            { name: 'GPLT0', offset: VipRegister.GPLT0, label: 'BGMap 1' },
            { name: 'GPLT1', offset: VipRegister.GPLT1, label: 'BGMap 2' },
            { name: 'GPLT2', offset: VipRegister.GPLT2, label: 'BGMap 3' },
            { name: 'GPLT3', offset: VipRegister.GPLT3, label: 'BGMap 4' },
            { name: 'JPLT0', offset: VipRegister.JPLT0, label: 'Object 1' },
            { name: 'JPLT1', offset: VipRegister.JPLT1, label: 'Object 2' },
            { name: 'JPLT2', offset: VipRegister.JPLT2, label: 'Object 3' },
            { name: 'JPLT3', offset: VipRegister.JPLT3, label: 'Object 4' },
        ],
    },
];

// r0 (zero) and r31 (link) are the hardware's own, the rest is the V810 calling convention, which hand-written
// code like the toolchain's `crt0.s` may ignore
const PROGRAM_REGISTER_LABELS: Record<number, string> = {
    0: 'Zero Register',
    1: 'Assembler Reserved',
    2: 'Handler Stack Pointer (hp)',
    3: 'Stack Pointer (sp)',
    4: 'Global Pointer (gp)',
    5: 'Text Pointer (tp)',
    6: 'Argument 1',
    7: 'Argument 2',
    8: 'Argument 3',
    9: 'Argument 4',
    10: 'Return Value',
    // read implicitly by the string instructions
    26: 'Bit String Source Offset',
    27: 'Bit String Destination Offset',
    28: 'Bit String Source Address',
    29: 'Bit String Destination Address',
    30: 'Bit String Length',
    31: 'Link Pointer (lp)',
};

const SYSTEM_REGISTER_LABELS: Record<string, string> = {
    ADTRE: 'Address Trap',
    CHCW: 'Cache Control Word',
    EIPC: 'Exception/Interrupt PC',
    EIPSW: 'Exception/Interrupt PSW',
    ECR: 'Exception Cause',
    FEPC: 'Fatal Error PC',
    FEPSW: 'Fatal Error PSW',
    PIR: 'Processor ID',
    PSW: 'Program Status Word',
    TKCW: 'Task Control Word',
};

const PROGRAM_REGISTERS_PER_COLUMN = 16;
const SYSTEM_REGISTERS_PER_COLUMN = 5;

// the VIP block is read through the CPU's view of memory, the CPU registers come from the core
export class RegistersPanel extends Panel {

    protected registers?: Registers;
    protected vipRegisters?: DataView;
    // only while a VB Color game has unlocked the VCU, see `readVbcState`
    protected vcuRegisters?: DataView;
    protected error?: string;

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.REGISTERS, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/registers/title', 'Registers');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.REGISTERS);
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.registers = undefined;
            this.vipRegisters = undefined;
            this.vcuRegisters = undefined;
            this.update();
            return;
        }

        try {
            const [registers, vip, vbc] = await Promise.all([
                sim.readRegisters(),
                sim.readMemory(VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES),
                readVbcState(this.source, sim),
            ]);
            this.registers = registers;
            this.vipRegisters = new DataView(vip);
            this.vcuRegisters = vbc?.registers;
            this.error = undefined;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }
        this.update();
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return <EmptyContainer
                title={this.error ?? nls.localize('vueport/general/error', 'Error')}
                icon={<Warning size={32} />}
            />;
        }
        const registers = this.registers;
        const vipRegisters = this.vipRegisters;
        if (!registers || !vipRegisters) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/general/notRunning',
                    'The emulator is not running.',
                )}
                icon={<Plug size={32} />}
            />;
        }

        return <div className='vp-registers-panel'>
            {this.renderVip(vipRegisters)}
            {this.renderCpu(registers)}
            {this.vcuRegisters && this.renderVcu(this.vcuRegisters)}
        </div>;
    }

    protected renderVip(block: DataView): React.ReactNode {
        return <fieldset className='vp-inspector-group vp-vip vp-registers-section vp-scroll'>
            <legend>
                {nls.localize('vueport/debug/panels/registers/vip', 'VIP')}
            </legend>
            <div className='vp-groups'>
                {VIP_REGISTER_GROUPS.map(({ group, registers }) => (
                    <div className='vp-group' key={group}>
                        <h4>{group}</h4>
                        <table>
                            <tbody>
                                {registers.map(({ name, offset, label: hint }) => (
                                    <tr key={name}>
                                        <th title={hint}>{name}</th>
                                        <td><code>{hex(block.getUint16(offset, true), 4)}</code></td>
                                        <td className='hint'>{hint ?? ''}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ))}
            </div>
        </fieldset>;
    }

    protected renderVcu(block: DataView): React.ReactNode {
        return <fieldset className='vp-inspector-group vp-vip vp-registers-section vp-scroll'>
            <legend>
                {nls.localize('vueport/debug/panels/registers/vcu', 'VCU')}
            </legend>
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
                                        <td className='hint'>{registerHint(name, label, value)}</td>
                                    </tr>;
                                })}
                            </tbody>
                        </table>
                    </div>
                ))}
            </div>
        </fieldset>;
    }

    protected renderCpu(registers: Registers): React.ReactNode {
        const programColumns = inColumns(
            registers.program.map((value, index) => ({ index, value })),
            PROGRAM_REGISTERS_PER_COLUMN
        );
        const systemColumns = inColumns(
            Object.entries(registers.system),
            SYSTEM_REGISTERS_PER_COLUMN
        );

        return <fieldset className='vp-inspector-group vp-registers-section vp-scroll'>
            <legend>
                {nls.localize('vueport/debug/panels/registers/cpu', 'CPU')}
            </legend>
            <div className='vp-registers'>
                <div className='vp-registers-pc'>
                    <span>PC</span><code>{hex(registers.pc, 8)}</code>
                    <span className='hint'>{nls.localize('vueport/debug/panels/registers/programCounter', 'Program Counter')}</span>
                </div>
                <div className='vp-group'>
                    <h4>{nls.localize('vueport/debug/panels/registers/program', 'Program')}</h4>
                    <div className='vp-groups'>
                        {programColumns.map(column => (
                            <table key={column[0].index}>
                                <tbody>
                                    {column.map(({ index, value }) => (
                                        <tr key={index}>
                                            <th title={PROGRAM_REGISTER_LABELS[index]}>r{index}</th>
                                            <td><code>{hex(value, 8)}</code></td>
                                            <td className='hint'>{PROGRAM_REGISTER_LABELS[index] ?? ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ))}
                    </div>
                </div>
                <div className='vp-group'>
                    <h4>{nls.localize('vueport/debug/panels/registers/system', 'System')}</h4>
                    <div className='vp-groups'>
                        {systemColumns.map(column => (
                            <table key={column[0][0]}>
                                <tbody>
                                    {column.map(([name, value]) => (
                                        <tr key={name}>
                                            <th title={SYSTEM_REGISTER_LABELS[name]}>{name}</th>
                                            <td><code>{hex(value, 8)}</code></td>
                                            <td className='hint'>{SYSTEM_REGISTER_LABELS[name] ?? ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ))}
                    </div>
                </div>
            </div>
        </fieldset>;
    }
}

function inColumns<T>(items: T[], perColumn: number): T[][] {
    const columns: T[][] = [];
    for (let first = 0; first < items.length; first += perColumn) {
        columns.push(items.slice(first, first + perColumn));
    }
    return columns;
}
