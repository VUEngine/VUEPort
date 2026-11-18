// the page's half of the desktop app's Probe mode: the shell listens on a local port and checks each request's
// token (probe.rs), the answering is vueport-core's ProbeSession (shared with VUEngine Studio); only the
// transport, the settings switch and quitting are the desktop's own
import { ProbeForkWorker, ProbeSession, ProbeTarget } from 'vueport-core/lib/probe/probe-session';
import { invoke, listen } from './desktop-bridge';
import {
    onDidChangeProbeSettings, probeEnabled, probeStatus, ProbeStatus, setProbeForced, setProbeStatus,
} from './web-probe-settings';

export async function installProbe(target: () => ProbeTarget | undefined): Promise<void> {
    let worker: ProbeForkWorker | undefined;
    const session = new ProbeSession(target, {
        app: 'VUEPort',
        version: VUEPORT_VERSION,
        usage: 'VUEPort --probe-cli',
        wasmUrl: () => new URL(VUEPORT_WASM_URL, location.href).href,
        // started when the first command needs it
        forks: () => {
            worker ??= new ProbeForkWorker(new Worker(new URL(VUEPORT_PROBE_WORKER_URL, location.href)));
            return worker;
        },
        // the application's own way out, saves written first
        quit: () => { invoke('request_quit').catch(() => undefined); },
    });

    await listen('probe://request', payload => {
        const { id, method, params } = payload as { id: number, method: string, params: Record<string, unknown> };
        setProbeStatus({ ...probeStatus(), requests: probeStatus().requests + 1 });
        session.handle(method, params ?? {}).then(
            result => ({ result }),
            (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        ).then(response => invoke('probe_respond', { id, response: JSON.stringify(response) }))
            .catch(error => console.warn('[probe] could not answer:', error));
    });
    await listen('probe://clients', clients => setProbeStatus({ ...probeStatus(), clients: Number(clients) || 0 }));

    setProbeForced(await invoke<boolean>('probe_launch_flag').catch(() => false));
    const apply = async (): Promise<void> => {
        try {
            const next = await invoke<Omit<ProbeStatus, 'requests'>>(probeEnabled() ? 'probe_start' : 'probe_stop');
            // the shell answers probe_start with the server it already has when listening, so the count carries on
            const current = probeStatus();
            setProbeStatus({ ...next, requests: next.listening && current.listening ? current.requests : 0 });
        } catch (error) {
            setProbeStatus({ listening: false, port: 0, file: '', clients: 0, requests: 0, error: error instanceof Error ? error.message : String(error) });
        }
    };
    onDidChangeProbeSettings(() => { apply().catch(() => undefined); });
    await apply();
}
