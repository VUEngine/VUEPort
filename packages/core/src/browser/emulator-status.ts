// wording of the status readouts, shared so the standalone status strip and the studio's status bar say the same thing
import { nls } from '../common/emulator-nls';
import { VueportRumblePack } from '../common/emulator-rumble';
import { PERF_DIAGNOSTICS } from '../common/perf-diagnostics';
import { Speed } from '../common/vb-protocol';
import { EsSoundPlayer } from './emulator-essound-player';
import { connectedGamepads } from './emulator-gamepad';
import { VbHardwareMode } from './emulator-types';

export interface EmulatorStatusSource {
    readonly hasRom: boolean;
    // the measured rate, as the worker last reported it
    readonly emulationSpeed: Speed | undefined;
    readonly esSound: EsSoundPlayer;
    readonly rumblePack: VueportRumblePack;
    readonly vbcSupportEnabled: boolean;
    readonly vbcHardwareActive: boolean;
    readonly selectedHardwareMode: string;
}

export const STATUS_NONE = '—';

// the measured rate rather than the requested one, as a fast forward ratio the machine cannot sustain is
// clamped. A paused machine keeps reading what it last ran at
export function formatEmulationSpeed(source: EmulatorStatusSource): string {
    if (!source.hasRom) {
        return STATUS_NONE;
    }
    const speed = source.emulationSpeed;
    if (!speed) {
        return STATUS_NONE;
    }
    const ratio = `${Math.round(speed.ratio * 100)}%`;
    if (!PERF_DIAGNOSTICS) {
        return ratio;
    }
    return `${ratio} · W ${Math.round(speed.load * 100)}%`;
}

export function formatHardwareMode(source: EmulatorStatusSource): string {
    if (!source.vbcSupportEnabled) {
        return nls.localize('vueport/vbColor/hardware/virtualBoy', 'Virtual Boy');
    }
    const model = source.vbcHardwareActive
        ? nls.localize('vueport/vbColor/hardware/vbColor', 'VB Color')
        : nls.localize('vueport/vbColor/hardware/virtualBoy', 'Virtual Boy');
    return source.selectedHardwareMode === VbHardwareMode.AUTO
        ? nls.localize('vueport/vbColor/hardware/autoStatus', 'Auto ({0})', model)
        : model;
}

// the tracks are audio files beside the cartridge, which a browser can only get zipped with the ROM, so that is what
// "no tracks" usually means there. withPlaying false is for the status bar, which has no room for the playing count
export function formatEsSound(source: EmulatorStatusSource, withPlaying = true): string {
    if (!source.hasRom || !source.esSound.isScanned) {
        return STATUS_NONE;
    }
    const count = source.esSound.list.length;
    if (count === 0) {
        return STATUS_NONE;
    }
    // two keys rather than one with a count, so languages that inflect differently can write the whole phrase
    const tracks = count === 1
        ? nls.localize('vueport/status/oneTrack', '1 track')
        : nls.localize('vueport/debug/panels/esSound/tracks', '{0} tracks', count);
    const playing = withPlaying ? source.esSound.playing.length : 0;
    return playing > 0
        ? nls.localize('vueport/debug/panels/esSound/tracksPlaying', '{0}, {1} playing', tracks, playing)
        : tracks;
}

// a pack the link cable has taken the port from says so instead of its name, which would read as
// "working". See applyRumbleForwarding
export function formatRumblePack(source: EmulatorStatusSource): string {
    if (!source.rumblePack.connected) {
        return STATUS_NONE;
    }
    if (source.rumblePack.linkPortInUse) {
        return nls.localize('vueport/status/rumbleLinkPortTaken', 'off (linked)');
    }
    return source.rumblePack.deviceName
        ?? nls.localize('vueport/status/connected', 'connected');
}

export function formatController(): string {
    return connectedGamepads()[0] ?? STATUS_NONE;
}

export function formatProgramCounter(pc: number | undefined): string {
    return pc === undefined
        ? STATUS_NONE
        : `0x${(pc >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function formatSymbolCount(classes: number | undefined): string {
    return classes === undefined
        ? STATUS_NONE
        : nls.localize('vueport/status/symbolClasses', '{0} classes', classes.toLocaleString());
}
