import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import { hex, DebugSource, Panel, EmulatorPanelType } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import {
    VIP_BGMAP_PALETTES,
    VIP_OBJECT_PALETTES,
    VIP_REGISTER_BASE,
    VIP_REGISTER_BLOCK_BYTES,
    vipBrightnessLevelsFromRegisters,
    vipPaletteIntensities,
    VipRegister,
} from './emulator-vip-memory';
import EmptyContainer from '../components/kit/EmptyContainer';
import { Plug, Warning } from '@phosphor-icons/react';

// shows each palette register as the mapping of a pixel's four values to the brightness levels (or black)
export class PalettesPanel extends Panel {

    protected registers?: DataView;
    protected error?: string;

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.VIP_PALETTES, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/palettes/title', 'Palettes');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.VIP_PALETTES);
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.registers = undefined;
            this.update();
            return;
        }

        try {
            this.registers = new DataView(await sim.readMemory(VIP_REGISTER_BASE, VIP_REGISTER_BLOCK_BYTES));
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
        if (!registers) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/general/notRunning',
                    'The emulator is not running.',
                )}
                icon={<Plug size={32} />}
            />;
        }

        const levels = vipBrightnessLevelsFromRegisters(registers);
        const renderPalette = (name: string, register: VipRegister): React.ReactNode => {
            const value = registers.getUint16(register, true) & 0xff;
            const intensities = vipPaletteIntensities(value, levels);
            return <tr key={name}>
                <th>{name}</th>
                <td><code>{hex(value, 2)}</code></td>
                <td>
                    <div className='vp-vip-swatches'>
                        {intensities.map((intensity, index) => (
                            <span
                                key={index}
                                className='vp-vip-swatch'
                                style={{ background: `rgb(${intensity}, 0, 0)` }}
                                title={`${index}: ${intensity}`}
                            />
                        ))}
                    </div>
                </td>
            </tr>;
        };

        return <div className='vp-vip'>
            <div className='vp-groups'>
                <div className='vp-group'>
                    <h4>{nls.localize('vueport/debug/panels/palettes/bgMapPalettes', 'BGMap palettes')}</h4>
                    <table><tbody>
                        {VIP_BGMAP_PALETTES.map((register, index) => renderPalette(`GPLT${index}`, register))}
                    </tbody></table>
                </div>
                <div className='vp-group'>
                    <h4>{nls.localize('vueport/debug/panels/palettes/objectPalettes', 'Object palettes')}</h4>
                    <table><tbody>
                        {VIP_OBJECT_PALETTES.map((register, index) => renderPalette(`JPLT${index}`, register))}
                    </tbody></table>
                </div>
                <div className='vp-group'>
                    <h4>{nls.localize('vueport/debug/panels/palettes/brightness', 'Brightness')}</h4>
                    <table><tbody>
                        {[
                            ['BRTA', VipRegister.BRTA],
                            ['BRTB', VipRegister.BRTB],
                            ['BRTC', VipRegister.BRTC],
                        ].map(([name, register]) => (
                            <tr key={name as string}>
                                <th>{name}</th>
                                <td><code>{hex(registers.getUint16(register as number, true) & 0xff, 2)}</code></td>
                            </tr>
                        ))}
                        <tr>
                            <th title={nls.localize(
                                'vueport/debug/panels/palettes/level3Hint',
                                'The brightest level is the sum of all three registers'
                            )}>
                                {nls.localize('vueport/debug/panels/palettes/levels', 'Levels')}
                            </th>
                            <td colSpan={2}>
                                <div className='vp-vip-swatches'>
                                    {levels.map((intensity, index) => (
                                        <span
                                            key={index}
                                            className='vp-vip-swatch'
                                            style={{ background: `rgb(${intensity}, 0, 0)` }}
                                            title={`${index}: ${intensity}`}
                                        />
                                    ))}
                                </div>
                            </td>
                        </tr>
                    </tbody></table>
                </div>
            </div>
        </div>;
    }
}
