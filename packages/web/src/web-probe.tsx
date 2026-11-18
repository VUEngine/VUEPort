import * as React from 'react';
import { Check, Copy } from '@phosphor-icons/react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { invoke } from './desktop-bridge';
import { BoolSetting } from './web-bool-setting';
import {
    onDidChangeProbeSettings, onDidChangeProbeStatus, probeForced, probeSetting, probeStatus, setProbeEnabled,
} from './web-probe-settings';

// English whatever the UI language, as it is for the agent; the rest is in --probe-cli help, which the agent is told to
// read first
function agentInstructions(binary: string, windows: boolean): string {
    const quoted = /\s/.test(binary) ? `"${binary}"` : binary;
    return [
        'VUEPort, the Virtual Boy emulator, is running and lets tools on this computer connect. Use it from the shell:',
        '',
        `  ${quoted} --probe-cli help`,
        '',
        'That lists every command; read it first. Commands about the game being played (status, capture, pause, resume, '
        + 'save, load) act on it directly. Every other command (run, watch, peek, regs, dis, vip, actors, …) runs on a '
        + 'fork, a copy of the moment inside VUEPort, so the player is not disturbed: "fork <name>" keeps one and '
        + '"--fork <name>" carries on with it. Files named on the command line are read from and written to the current '
        + 'folder. The build\'s .elf beside the ROM gives names, fields and source lines.',
        '',
        `To start VUEPort ready for tools: ${quoted} --probe <game.vb>`,
        // a GUI program on Windows: piped, as an agent's shell does, it prints and returns normally; typed into a
        // console, the shell neither waits for it nor keeps its exit code (see attach_to_console)
        ...windows ? [
            '',
            'On Windows, VUEPort.exe is a GUI program. With its output piped or redirected it behaves like any command. '
            + 'Typed into a console, wait for it explicitly, or the prompt returns before the answer and the exit code '
            + 'is lost:',
            '',
            `  cmd:         start "" /wait ${quoted.startsWith('"') ? quoted : `"${quoted}"`} --probe-cli help`,
            `  PowerShell:  & ${quoted.startsWith('"') ? quoted : `"${quoted}"`} --probe-cli help | Out-Host`,
        ] : [],
    ].join('\n');
}

// navigator.platform as web-bindings.ts reads it: deprecated, but nothing standard replaces it
// eslint-disable-next-line deprecation/deprecation
const IS_WINDOWS = typeof navigator !== 'undefined' && /Win/.test(navigator.platform);

// desktop only, as a browser cannot open a port; what a connected tool may do is decided in desktop-probe.ts
export default function WebProbe(): React.JSX.Element {
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    const [binary, setBinary] = React.useState<string | undefined>(undefined);
    const [copied, setCopied] = React.useState(false);
    React.useEffect(() => {
        const settings = onDidChangeProbeSettings(() => bump());
        const listening = onDidChangeProbeStatus(() => bump());
        invoke<string | null>('probe_binary_path').then(path => setBinary(path ?? undefined), () => undefined);
        return () => {
            settings.dispose();
            listening.dispose();
        };
    }, []);

    const enabled = probeSetting();
    const status = probeStatus();
    const instructions = agentInstructions(binary ?? 'VUEPort', IS_WINDOWS);
    const copy = (): void => {
        navigator.clipboard.writeText(instructions).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        }, () => undefined);
    };

    return <div className='vp-appearance'>
        <BoolSetting
            label={nls.localize('vueport/probe/enable', 'Let tools connect')}
            hint={nls.localize('vueport/probe/enableHint',
                'Programs on this computer, such as an AI agent, can look at the game, pause it, take or load save states, '
                + 'and run copies of it to watch and step through without disturbing you. Not while a game is in hardcore mode '
                + 'or two players are linked.')}
            value={enabled}
            fallback={false}
            onChange={setProbeEnabled}
        />
        {probeForced() && <p className='vp-hint'>
            {nls.localize('vueport/probe/forced',
                'VUEPort was started with --probe, so tools can connect until it quits, whatever the switch says.')}
        </p>}
        {(status.error || status.listening) && <div className='vp-updates'>
            {status.error && <p className='vp-updates-line'>
                {nls.localize('vueport/probe/failed', 'Tools cannot connect: {0}', status.error)}
            </p>}
            {status.listening && <>
                <p className='vp-updates-line'>
                    {nls.localize('vueport/probe/listening', 'Listening on port {0}', status.port)}
                </p>
                <p className='vp-hint'>
                    {nls.localize('vueport/probe/agentHint',
                        'To let an AI agent use VUEPort, give it these instructions:')}
                </p>
                <pre className='vp-probe-example'>{instructions}</pre>
                <button className='vp-button secondary' onClick={copy}>
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                    {copied
                        ? nls.localize('vueport/probe/copied', 'Copied')
                        : nls.localize('vueport/probe/copy', 'Copy instructions')}
                </button>
                <p className='vp-hint'>
                    {nls.localize('vueport/probe/file',
                        'A tool finds the port and the key it needs in {0}, which only your user account can read.', status.file)}
                </p>
            </>}
        </div>}
    </div>;
}
