// whether local tools may connect (Probe mode, see `desktop-probe.ts`). Kept apart from the bridge so the status bar
// and settings need no desktop code in a browser bundle. Off by default; nothing is written until changed
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';

const ENABLED = 'vueport.probe.enabled';

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeProbeSettings: Event<void> = onDidChangeEmitter.event;

export function probeSetting(): boolean {
    try {
        return window.localStorage.getItem(ENABLED) === 'true';
    } catch {
        return false;
    }
}

let launchedWithProbe = false;

// `--probe` keeps the mode on until VUEPort quits
export function probeForced(): boolean {
    return launchedWithProbe;
}

// the bridge asks the shell once at start-up
export function setProbeForced(forced: boolean): void {
    launchedWithProbe = forced;
    onDidChangeEmitter.fire();
}

export function probeEnabled(): boolean {
    return launchedWithProbe || probeSetting();
}

export function setProbeEnabled(value: boolean): void {
    if (value === probeSetting()) {
        return;
    }
    try {
        window.localStorage.setItem(ENABLED, value ? 'true' : 'false');
    } catch {
        // holds for this session only
    }
    onDidChangeEmitter.fire();
}

// as `probe_status` reports it
export interface ProbeStatus {
    listening: boolean;
    port: number;
    file: string;
    clients: number;
    // kept by the page, as `--probe-cli` connects for one request only, so `clients` is nearly always 0
    requests: number;
    error?: string; // why it is not listening when it was asked to
}

let status: ProbeStatus = { listening: false, port: 0, file: '', clients: 0, requests: 0 };
const onDidChangeStatusEmitter = new Emitter<ProbeStatus>();
export const onDidChangeProbeStatus: Event<ProbeStatus> = onDidChangeStatusEmitter.event;

export function probeStatus(): ProbeStatus {
    return status;
}

export function setProbeStatus(next: ProbeStatus): void {
    status = next;
    onDidChangeStatusEmitter.fire(next);
}
