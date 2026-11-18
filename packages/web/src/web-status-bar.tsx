import {
    Books,
    Cards,
    Code,
    Command,
    Cpu,
    FloppyDisk,
    GameController,
    Gauge,
    MapPin,
    MusicNotes,
    TerminalWindow,
    Vibrate,
} from '@phosphor-icons/react';
import * as React from 'react';
import { connectedGamepads, onGamepadsChanged } from 'vueport-core/lib/browser/emulator-gamepad';
import {
    formatHardwareMode,
    formatEmulationSpeed,
    formatEsSound,
    formatProgramCounter,
    formatRumblePack,
    formatSymbolCount,
    STATUS_NONE,
} from 'vueport-core/lib/browser/emulator-status';
import { DOM_HOVER } from 'vueport-core/lib/browser/components/kit/dom-hover';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { EmulatorMode } from 'vueport-core/lib/browser/emulator-types';
import { VbRenderingMode } from 'vueport-core/lib/common/vb-constants';
import { APP_SHORTCUTS } from './web-bindings';
import { formatSettingValue, standardValue } from './web-display-settings';
import { WebEmulator } from './web-emulator';
import { Library, LibraryActivity } from './web-library';
import { onDidChangeProbeStatus, probeStatus } from './web-probe-settings';

/**
 * Web only, the studio has its own. Reads everything off the emulator's public surface. Left: what is running (speed,
 * Debug-mode machine state); right: what is attached; middle: the command palette entry, the one control. Entries are
 * glyphs with the word as tooltip, as width is scarce; a readout needing more than its name belongs in a panel.
 */

const DEBUG_REFRESH_MS = 250;

function tip(label: string, value: string): string {
    return nls.localize('vueport/status/tooltip', '{0}: {1}', label, value);
}

function hover(text: string): {
    onMouseEnter: React.MouseEventHandler<HTMLElement>,
    onMouseLeave: React.MouseEventHandler<HTMLElement>,
} {
    return {
        onMouseEnter: event => DOM_HOVER.show(event.currentTarget, text),
        onMouseLeave: () => DOM_HOVER.hide(),
    };
}

const ICON_SIZE = 14;

function Item(props: {
    id: string, // see `data-status`
    icon: React.JSX.Element,
    label: string, // tooltip and screen reader text
    value: string,
    tone?: 'ok' | 'off',
    mono?: boolean, // fixed-width, so a changing value does not jitter
}): React.JSX.Element | undefined {
    const { id, icon, label, value, tone, mono } = props;
    if (value === STATUS_NONE) {
        return undefined;
    }
    return <div className='vp-status-item' data-status={id} {...hover(tip(label, value))}>
        <span className='vp-status-icon' aria-hidden='true'>{icon}</span>
        <span className='vp-status-label'>{label}</span>
        <span className={'vp-status-value'
            + (tone ? ' ' + tone : '')
            + (mono ? ' mono' : '')}>{value}</span>
    </div>;
}

function HardwareItem(props: { emulator: WebEmulator }): React.JSX.Element {
    const { emulator } = props;
    const label = nls.localize('vueport/status/hardware', 'Hardware');
    const value = formatHardwareMode(emulator);
    return <button
        type='button'
        className='vp-status-item vp-status-hardware'
        data-status='hardware'
        {...hover(tip(label, value))}
        onClick={() => {
            DOM_HOVER.hide();
            emulator.pickHardwareMode().catch(() => undefined);
        }}
    >
        <span className='vp-status-icon' aria-hidden='true'><Cpu size={ICON_SIZE} /></span>
        <span className='vp-status-label'>{label}</span>
        <span className={'vp-status-value' + (emulator.vbcHardwareActive ? ' ok' : '')}>
            {value}
        </span>
    </button>;
}

function SaveSlotItem(props: { emulator: WebEmulator }): React.JSX.Element {
    const { emulator } = props;
    const label = nls.localize('vueport/status/saveSlot', 'Save Slot');
    // the settings dropdown's wording, as a bare letter does not say what it is a letter of
    const slot = nls.localize(
        'vueport/preferences/saveGameSlot/item', 'Slot {0}', emulator.saveGameSlot);
    return <button
        type='button'
        className='vp-status-item vp-status-save-slot'
        data-status='saveGameSlot'
        // the letter rather than `slot`, as "Save Slot: Slot A" says it twice
        {...hover(tip(label, emulator.saveGameSlot))}
        onClick={() => {
            DOM_HOVER.hide();
            emulator.pickSaveGameSlot().catch(() => undefined);
        }}
    >
        <span className='vp-status-icon' aria-hidden='true'>
            <FloppyDisk size={ICON_SIZE} />
        </span>
        <span className='vp-status-label'>{label}</span>
        <span className='vp-status-value'>{slot}</span>
    </button>;
}

// only while not standard, as a changed depth affects every game and the setting is three clicks deep; and only while
// both eyes are shown, as one-eye modes ignore it
function StereoDepthItem(props: { emulator: WebEmulator }): React.JSX.Element | undefined {
    const { emulator } = props;
    const { settings } = emulator;
    const depth = settings.get('stereoDepth');
    const mode = settings.get('renderingMode');
    const stereo = mode !== VbRenderingMode.LEFT && mode !== VbRenderingMode.RIGHT;
    if (!stereo || depth === standardValue(settings, 'stereoDepth')) {
        return undefined;
    }
    const label = nls.localize('vueport/preferences/stereoDepth/title', '3D Depth');
    const value = formatSettingValue('stereoDepth', depth);
    return <button
        type='button'
        className='vp-status-item vp-status-depth'
        data-status='stereoDepth'
        {...hover(tip(label, value))}
        onClick={() => {
            DOM_HOVER.hide();
            emulator.pickStereoDepth().catch(() => undefined);
        }}
    >
        <span className='vp-status-icon' aria-hidden='true'><Cards size={ICON_SIZE} /></span>
        <span className='vp-status-label'>{label}</span>
        <span className='vp-status-value'>{value}</span>
    </button>;
}

function ControllerItem(props: {
    emulator: WebEmulator, pad: string | undefined,
}): React.JSX.Element | undefined {
    const { emulator, pad } = props;
    if (pad === undefined) {
        return undefined;
    }
    const label = nls.localize('vueport/status/controller', 'Controller');
    return <button
        type='button'
        className='vp-status-item vp-status-controller'
        data-status='controller'
        {...hover(tip(label, pad))}
        onClick={() => {
            DOM_HOVER.hide();
            emulator.openGamePadSettings();
        }}
    >
        <span className='vp-status-icon' aria-hidden='true'>
            <GameController size={ICON_SIZE} />
        </span>
        <span className='vp-status-label'>{label}</span>
        <span className='vp-status-value ok'>{pad}</span>
    </button>;
}

// Probe mode lets other programs into the running machine, which should never be on unseen
function ProbeItem(props: { emulator: WebEmulator }): React.JSX.Element | undefined {
    const [status, setStatus] = React.useState(probeStatus);
    React.useEffect(() => {
        const subscription = onDidChangeProbeStatus(next => setStatus(next));
        setStatus(probeStatus());
        return () => subscription.dispose();
    }, []);
    if (!status.listening) {
        return undefined;
    }
    const label = nls.localize('vueport/status/tools', 'Tools');
    const value = status.requests === 0
        ? nls.localize('vueport/status/probeListening', 'Listening')
        : status.requests === 1
            ? nls.localize('vueport/status/probeOneRequest', '1 request')
            : nls.localize('vueport/status/probeRequests', '{0} requests', status.requests.toLocaleString());
    return <button
        type='button'
        className='vp-status-item vp-status-probe'
        data-status='probe'
        {...hover(tip(label, value))}
        onClick={() => {
            DOM_HOVER.hide();
            props.emulator.openSettingsTab('probe');
        }}
    >
        <span className='vp-status-icon' aria-hidden='true'><TerminalWindow size={ICON_SIZE} /></span>
        <span className='vp-status-label'>{label}</span>
        <span className={'vp-status-value' + (status.requests > 0 ? ' ok' : '')}>{value}</span>
    </button>;
}

function CommandPaletteItem(props: { onClick: () => void }): React.JSX.Element {
    const label = nls.localize('vueport/status/commandPalette', 'Command Palette');
    return <button
        type='button'
        className='vp-status-item vp-status-palette'
        {...hover(tip(label, APP_SHORTCUTS.palette))}
        onClick={() => { DOM_HOVER.hide(); props.onClick(); }}
    >
        <span className='vp-status-icon' aria-hidden='true'>
            <Command size={ICON_SIZE} />
        </span>
        <span className='vp-status-label'>{label}</span>
        <span className='vp-status-value'>{APP_SHORTCUTS.palette}</span>
    </button>;
}

function LibraryItem(props: { library: Library }): React.JSX.Element | undefined {
    const { library } = props;
    const activity = React.useSyncExternalStore(
        React.useCallback(listener => {
            const subscription = library.onDidChangeActivity(listener);
            return () => subscription.dispose();
        }, [library]),
        // a fresh object every call would tell React the store changed on every render, so the snapshot is the text
        React.useCallback(() => activityLine(library.activity()), [library]),
    );

    if (activity === undefined) {
        return undefined;
    }
    const label = nls.localize('vueport/status/library', 'Library');
    return <div className='vp-status-item' data-status='library' {...hover(tip(label, activity))}>
        <span className='vp-status-icon' aria-hidden='true'><Books size={ICON_SIZE} /></span>
        <span className='vp-status-label'>{label}</span>
        <span className='vp-spinner small' aria-hidden='true' />
        <span className='vp-status-value'>{activity}</span>
    </div>;
}

function activityLine(activity: LibraryActivity | undefined): string | undefined {
    if (!activity) {
        return undefined;
    }
    if (activity.kind === 'catalog') {
        return nls.localize('vueport/status/libraryCatalog',
            'Enriching ({0} left)',
            Math.max(0, (activity.total ?? 0) - activity.done).toLocaleString());
    }
    const folder = activity.folder
        ?? nls.localize('vueport/status/libraryFolder', 'a folder');
    return activity.kind === 'importing'
        ? nls.localize('vueport/status/libraryCopying', 'Copying {0}', folder)
        : nls.localize('vueport/status/libraryReading', 'Reading {0}', folder);
}

export default function WebStatusBar(
    props: {
        emulator: WebEmulator,
        library: Library,
        onOpenCommandPalette: () => void,
    },
): React.JSX.Element {
    const { emulator, onOpenCommandPalette } = props;

    // the emulator mutates its state in place and bumps a counter, so the counter is the snapshot (as in the toolbar)
    React.useSyncExternalStore(
        React.useCallback(listener => {
            const subscription = emulator.onStateChanged(listener);
            return () => subscription.dispose();
        }, [emulator]),
        () => emulator.version,
    );

    // the pack, pads and ESSound player announce themselves apart from the emulator's state, so each is listened to on
    // its own
    const [, setPackVersion] = React.useState(0);
    React.useEffect(() => {
        const subscription = emulator.rumblePack.onDidChangeConnected(
            () => setPackVersion(version => version + 1)
        );
        return () => subscription.dispose();
    }, [emulator]);

    const [, setPadVersion] = React.useState(0);
    React.useEffect(() => onGamepadsChanged(() => setPadVersion(version => version + 1)), []);

    const [, setSoundVersion] = React.useState(0);
    React.useEffect(() => {
        const subscription = emulator.esSound.onDidChange(
            () => setSoundVersion(version => version + 1)
        );
        return () => subscription.dispose();
    }, [emulator]);

    const debugging = emulator.state.mode === EmulatorMode.DEBUG;

    // the program counter changes millions of times a second, so it is sampled, only while the debug readouts are shown
    const [pc, setPc] = React.useState<number | undefined>(undefined);
    React.useEffect(() => {
        if (!debugging) {
            setPc(undefined);
            return undefined;
        }
        let live = true;
        const read = (): void => {
            const sim = emulator.sim;
            if (!sim) {
                setPc(undefined);
                return;
            }
            sim.readRegisters()
                .then(registers => { if (live) { setPc(registers.pc); } })
                // the machine can go away between the question and the answer
                .catch(() => undefined);
        };
        read();
        const timer = window.setInterval(read, DEBUG_REFRESH_MS);
        return () => {
            live = false;
            window.clearInterval(timer);
        };
    }, [emulator, debugging, emulator.version]);

    // read once per ROM, as symbols load with the cartridge and do not change under it
    const [symbolCount, setSymbolCount] = React.useState<number | undefined>(undefined);
    React.useEffect(() => {
        let live = true;
        emulator.dock.getSymbols()
            .then(symbols => { if (live) { setSymbolCount(symbols?.classes.size); } })
            .catch(() => undefined);
        return () => { live = false; };
    }, [emulator, emulator.romChecksum]);

    const pack = emulator.rumblePack;
    const pads = connectedGamepads();

    return <div className='vp-status'>
        <div className='vp-status-group vp-status-left'>
            <LibraryItem library={props.library} />
            <Item
                id='speed'
                icon={<Gauge size={ICON_SIZE} />}
                label={nls.localize('vueport/status/speed', 'Speed')}
                value={formatEmulationSpeed(emulator)}
            />
            {/* about the game, not the machine, so beside the speed */}
            <SaveSlotItem emulator={emulator} />
            {/* with the game, as it is about how it is looked at, not what is plugged in */}
            <StereoDepthItem emulator={emulator} />

            {debugging && <>
                <Item
                    id='pc'
                    icon={<MapPin size={ICON_SIZE} />}
                    label={nls.localize('vueport/status/pc', 'PC')}
                    value={formatProgramCounter(pc)}
                    mono
                />
                <Item
                    id='symbols'
                    icon={<Code size={ICON_SIZE} />}
                    label={nls.localize('vueport/status/symbols', 'Symbols')}
                    value={formatSymbolCount(symbolCount)}
                    tone={symbolCount === undefined ? 'off' : 'ok'}
                />
            </>}
        </div>

        <div className='vp-status-group vp-status-center'>
            <CommandPaletteItem onClick={onOpenCommandPalette} />
        </div>

        {/* the machine itself last, so it holds the corner */}
        <div className='vp-status-group vp-status-right'>
            <ProbeItem emulator={emulator} />
            <ControllerItem emulator={emulator} pad={pads[0]} />
            <Item
                id='rumblePack'
                icon={<Vibrate size={ICON_SIZE} />}
                label={nls.localize('vueport/status/rumblePack', 'Rumble Pack')}
                value={formatRumblePack(emulator)}
                tone={pack.connected && !pack.linkPortInUse ? 'ok' : 'off'}
            />
            <Item
                id='esSound'
                icon={<MusicNotes size={ICON_SIZE} />}
                label={nls.localize('vueport/status/esSound', 'ESSound')}
                value={formatEsSound(emulator, false)}
                tone={emulator.esSound.hasTracks ? 'ok' : 'off'}
            />
            <HardwareItem emulator={emulator} />
        </div>
    </div>;
}
