import { nls } from '../../common/emulator-nls';
import * as React from 'react';
import EmptyContainer from '../components/kit/EmptyContainer';
import { BuildMode } from '../core/emulator-elf';
import { MemoryArea, MemoryAreaKind, MemoryFootprint } from '../core/emulator-symbols';
import { VB_WRAM_SIZE } from '../../common/vb-constants';
import { BYTES_PER_MBIT, ROM_HEADER_MAKERS, vbColorSupportLabel } from '../emulator-types';
import { DebugSource, hex, Panel, EmulatorPanelType } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import { Plug, Warning } from '@phosphor-icons/react';

// same threshold as the Memory Pools panel
const WARNING_THRESHOLD = 85;

// fixed rather than taken from the link order, so a kind is one band however many sections contributed to it:
// `MemoryPool` sits inside `.sdata` and would otherwise split the initialized data in two around the heap
const AREA_KINDS: MemoryAreaKind[] = [
    MemoryAreaKind.CODE,
    MemoryAreaKind.READ_ONLY,
    MemoryAreaKind.DATA,
    MemoryAreaKind.ZEROED,
    MemoryAreaKind.POOL,
];

function areaKindLabel(kind: MemoryAreaKind): string {
    switch (kind) {
        case MemoryAreaKind.CODE:
            return nls.localize('vueport/debug/panels/romInfo/area/code', 'Code');
        case MemoryAreaKind.READ_ONLY:
            return nls.localize('vueport/debug/panels/romInfo/area/readOnly', 'Read-only data');
        case MemoryAreaKind.DATA:
            return nls.localize('vueport/debug/panels/romInfo/area/data', 'Initialized data');
        case MemoryAreaKind.ZEROED:
            return nls.localize('vueport/debug/panels/romInfo/area/zeroed', 'Zeroed data');
        case MemoryAreaKind.POOL:
            return nls.localize('vueport/debug/panels/romInfo/area/pool', 'Memory pools');
    }
}

// fixed width on the hardware (name 20, game code 4, maker 2, version 1), padded to show how much a game used;
// `min-width` since the version byte could print three digits
function field(text: React.ReactNode, characters: number): React.ReactNode {
    return <code
        className='vp-rom-info-field'
        style={{ minWidth: `${characters}ch` }}
    >{text}</code>;
}

interface AreaBand {
    kind: MemoryAreaKind;
    bytes: number;
    sections: string[];
}

// the widget pushes the header on every ROM (re)load and the budgets come from the `.elf`, so the poll is only a safety
// net
export class RomInfoPanel extends Panel {

    // undefined for a ROM without an `.elf` beside it, i.e. every ROM not built here
    protected footprint?: MemoryFootprint;

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.ROM_INFO, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/romInfo/title', 'ROM Info');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.ROM_INFO);
    }

    protected pollHz(): number {
        return 1;
    }

    protected async refresh(): Promise<void> {
        const footprint = (await this.source.getSymbols())?.footprint;
        this.footprint = footprint && (footprint.rom.length > 0 || footprint.wram.length > 0)
            ? footprint
            : undefined;
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.source.sim) {
            return <EmptyContainer
                title={nls.localize('vueport/general/notRunning', 'The emulator is not running.')}
                icon={<Plug size={32} />}
            />;
        }

        const { romHeader, romSize, buildMode, romChecksum } = this.source;
        const maker = ROM_HEADER_MAKERS[romHeader.maker];
        // the build writes the mode in lower case, BuildMode has the app-wide spelling and the Build view's description
        const mode = Object.values(BuildMode).find(known => known.toLowerCase() === buildMode);

        return <div className='vp-rom-info-panel'>
            {/* a ROM without a header of its own parses into noise, this says so */}
            {romSize > 0 && !romHeader.valid && <div className='vp-rom-info-invalid'>
                <Warning size={14} weight='fill' />
                {nls.localize('vueport/debug/panels/romInfo/headerInvalid', 'Header Invalid')}
            </div>}
            <div className='vp-rom-info-columns'>
                {/* header on the left, file on the right */}
                <table>
                    <tbody>
                        <tr>
                            <th>{nls.localize('vueport/debug/panels/romInfo/name', 'Name')}</th>
                            <td>{field(romHeader.name.trim(), 20)}</td>
                        </tr>
                        <tr>
                            <th>{nls.localize('vueport/debug/panels/romInfo/code', 'Code')}</th>
                            <td>{field(romHeader.code, 4)}</td>
                        </tr>
                        <tr>
                            <th>{nls.localize('vueport/debug/panels/romInfo/maker', 'Maker')}</th>
                            <td>{field(romHeader.maker, 2)}{maker && <> ({maker})</>}</td>
                        </tr>
                        <tr>
                            <th>{nls.localize('vueport/debug/panels/romInfo/version', 'Version')}</th>
                            <td>1.{field(romHeader.version, 1)}</td>
                        </tr>
                    </tbody>
                </table>
                <table>
                    <tbody>
                        <tr>
                            <th>{nls.localize('vueport/debug/panels/romInfo/size', 'Size')}</th>
                            <td><code>{romSize}</code> MBit</td>
                        </tr>
                        {romChecksum && <tr>
                            <th>{nls.localize('vueport/debug/panels/romInfo/checksum', 'CRC32')}</th>
                            <td><code>{romChecksum}</code></td>
                        </tr>}
                        {/* only ROMs built here have a map file with the mode */}
                        {buildMode && <tr>
                            <th>{nls.localize('vueport/debug/panels/romInfo/buildMode', 'Build Mode')}</th>
                            <td><code>{mode ?? buildMode}</code></td>
                        </tr>}
                        {/* not a Virtual Boy header field, so only with VB Color switched on */}
                        {this.source.vbcSupportEnabled && <tr>
                            <th>{nls.localize('vueport/debug/panels/romInfo/vbColor', 'VB Color')}</th>
                            <td>
                                <code>{hex(romHeader.vbcSupport, 2)}</code>
                                {' '}({vbColorSupportLabel(romHeader.vbcSupport)})
                            </td>
                        </tr>}
                    </tbody>
                </table>
            </div>
            {this.renderBudgets(romSize)}
        </div>;
    }

    protected renderBudgets(romSize: number): React.ReactNode {
        if (!this.footprint) {
            return undefined;
        }
        return <div className='vp-rom-info-budgets'>
            {romSize > 0 && budget(
                nls.localize('vueport/debug/panels/romInfo/usage/rom', 'ROM usage'),
                this.footprint.rom,
                romSize * BYTES_PER_MBIT)}
            {budget(
                nls.localize('vueport/debug/panels/romInfo/usage/wram', 'WRAM usage'),
                this.footprint.wram,
                VB_WRAM_SIZE)}
        </div>;
    }
}

function budget(label: string, areas: MemoryArea[], capacity: number): React.ReactNode {
    const bands = bandsOf(areas);
    const used = bands.reduce((sum, band) => sum + band.bytes, 0);
    const share = percent(used, capacity);
    return <div className='vp-rom-info-budget'>
        <div className='vp-rom-info-budget-head'>
            <span>{label}</span>
            <span className={share >= WARNING_THRESHOLD ? 'vp-rom-info-warn' : undefined}>
                {nls.localize(
                    'vueport/debug/panels/romInfo/budgetUsed',
                    '{0} of {1} · {2}%', kb(used), kb(capacity), `${share}`)}
            </span>
        </div>
        <div className='vp-rom-info-bar'>
            {bands.map(band => <div
                key={band.kind}
                className={`vp-rom-info-area vp-rom-info-area-${band.kind}`}
                style={{ width: `${width(band.bytes, capacity)}%` }}
                title={`${areaKindLabel(band.kind)} · ${kb(band.bytes)}\n${band.sections.join(', ')}`}
            />)}
        </div>
        <div className='vp-rom-info-legend'>
            {bands.map(band => <span key={band.kind}>
                <i className={`vp-rom-info-area-${band.kind}`} />
                {areaKindLabel(band.kind)} {kb(band.bytes)}
            </span>)}
        </div>
    </div>;
}

function bandsOf(areas: MemoryArea[]): AreaBand[] {
    return AREA_KINDS
        .map(kind => {
            const own = areas.filter(area => area.kind === kind);
            return {
                kind,
                bytes: own.reduce((sum, area) => sum + area.bytes, 0),
                // a kind can be several sections, and a section appears twice once the heap is cut out of its middle
                sections: [...new Set(own.map(area => area.name))],
            };
        })
        .filter(band => band.bytes > 0);
}

// unrounded, so the bands add up to the stated share
function width(bytes: number, capacity: number): number {
    return capacity <= 0 ? 0 : Math.min(100, (100 * bytes) / capacity);
}

// saturating rather than rounding up to 100
function percent(part: number, whole: number): number {
    if (whole <= 0) {
        return 0;
    }
    const share = (100 * part) / whole;
    return share > 0 && share < 1 ? 1 : Math.min(100, Math.round(share));
}

// a band can be a handful of bytes, which `0 KB` would hide, while a decimal on a megabyte of ROM is noise
function kb(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const value = bytes / 1024;
    return `${value.toLocaleString('en-US', { maximumFractionDigits: value < 100 ? 1 : 0 })} KB`;
}
