import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import EmptyContainer from '../components/kit/EmptyContainer';
import { BuildMode } from '../core/emulator-elf';
import { ROM_HEADER_MAKERS } from '../emulator-types';
import { VesEmulatorDebugSource, VesEmulatorPanel, EmulatorPanelType } from './emulator-panel';
import { Plug } from '@phosphor-icons/react';

/**
 * The cartridge header, parsed once when the ROM is loaded.
 *
 * Unlike the other panels this reads nothing from the running simulation — the
 * header is pushed by the widget whenever a ROM (re)loads — so there is
 * nothing here that benefits from polling ten times a second. It still polls,
 * at a slow rate, purely as a safety net; opening the panel always shows the
 * current header regardless, since the base class refreshes immediately on
 * attach and on show.
 */
export class VesEmulatorRomInfoPanel extends VesEmulatorPanel {

    constructor(source: VesEmulatorDebugSource, instanceId: string) {
        super(EmulatorPanelType.ROM_INFO, source, instanceId);
        this.title.label = nls.localize('vueport/panels/romInfo/title', 'ROM Info');
    }

    protected pollHz(): number {
        return 1;
    }

    protected refresh(): void {
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.source.sim) {
            return <EmptyContainer
                title={nls.localize('vueport/panels/notRunning', 'The emulator is not running.')}
                icon={<Plug size={32} />}
            />;
        }

        const { romHeader, romSize, buildMode } = this.source;
        const maker = ROM_HEADER_MAKERS[romHeader.maker];
        // The build writes the mode in lower case; this is how it is spelled
        // everywhere else in the application, and it carries the description
        // the Build view shows for it.
        const mode = Object.values(BuildMode).find(known => known.toLowerCase() === buildMode);

        return <table className='vueport-rom-info'>
            <tbody>
                <tr>
                    <th>{nls.localize('vueport/panels/romInfo/name', 'Name')}</th>
                    <td><code>{romHeader.name.trim()}</code></td>
                </tr>
                <tr>
                    <th>{nls.localize('vueport/panels/romInfo/code', 'Code')}</th>
                    <td><code>{romHeader.code}</code></td>
                </tr>
                <tr>
                    <th>{nls.localize('vueport/panels/romInfo/maker', 'Maker')}</th>
                    <td><code>{romHeader.maker}</code>{maker && <> ({maker})</>}</td>
                </tr>
                <tr>
                    <th>{nls.localize('vueport/panels/romInfo/version', 'Version')}</th>
                    <td>1.<code>{romHeader.version}</code></td>
                </tr>
                <tr>
                    <th>{nls.localize('vueport/panels/romInfo/size', 'Size')}</th>
                    <td><code>{romSize}</code> MBit</td>
                </tr>
                <tr>
                    <th>{nls.localize('vueport/panels/romInfo/buildMode', 'Build Mode')}</th>
                    <td>
                        {mode
                            ? <code>{mode}</code>
                            : (buildMode
                                ? <code>{buildMode}</code>
                                : nls.localize('vueport/panels/romInfo/buildModeUnknown', 'Unknown'))}
                    </td>
                </tr>
            </tbody>
        </table>;
    }
}
