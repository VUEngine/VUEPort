import { nls } from '../../common/emulator-nls';
import { Message } from '@lumino/messaging';
import * as React from 'react';
import { VB_VSU_BASE } from '../../common/vb-constants';
import { hex, DebugSource, Panel, EmulatorPanelType } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';
import {
    decodeVsuChannel,
    VSU_CHANNEL_COUNT,
    VSU_CHANNEL_SHORT_NAMES,
    VSU_MODULATION_BASE,
    VSU_MODULATION_BYTES,
    VSU_REGISTER_BASE,
    VSU_REGISTER_BLOCK_BYTES,
    VSU_WAVEFORM_BASES,
    VSU_WAVEFORM_BYTES,
    VsuChannel,
    VsuChannelKind,
    VsuEnvelopeDirection,
    VsuSweepDirection,
    VsuSweepModulationFunction,
    vsuChannelAddress,
    vsuChannelLevel,
    vsuModulationSamples,
    vsuNoteOf,
    vsuSamplesEqual,
    vsuWaveformSamples,
} from './emulator-vsu-memory';
import { Sim } from '../core/vb-core';
import EmptyContainer from '../components/kit/EmptyContainer';
import { Plug, Warning } from '@phosphor-icons/react';

// sparkline geometry, in the units of its viewBox
const SPARK_WIDTH = 64;
const SPARK_HEIGHT = 18;
// tall enough for a six-bit sample to be a shape and not a squiggle
const PLOT_WIDTH = 64;
const PLOT_HEIGHT = 64;
const SAMPLE_MAX = 63;
// modulation steps are signed bytes, so the plot is drawn around a middle
const MODULATION_RANGE = 128;

// decibels below full scale where the output meter's bar ends. A linear bar would spend most of its length on the
// top two bits and make everything quiet look like silence.
const METER_FLOOR_DB = 48;

const CHANGED_MS = 1200;

// amplitude 0-1 as decibels below full scale, undefined for silence
function decibels(amplitude: number): number | undefined {
    return amplitude > 0 ? 20 * Math.log10(amplitude) : undefined;
}

function meterScale(amplitude: number): number {
    const db = decibels(amplitude);
    if (db === undefined) {
        return 0;
    }
    return Math.max(0, Math.min(1, 1 + db / METER_FLOOR_DB));
}

// anything under the meter's floor reads as silence: a muted machine measures around -800 dB (a denormal float),
// and printing that would make a meter that never reads silent
function decibelLabel(amplitude: number): string {
    const db = decibels(amplitude);
    return db === undefined || db <= -METER_FLOOR_DB
        ? '−∞'
        : `${db > -0.05 ? '' : '−'}${Math.abs(db).toFixed(0)}`;
}

// stereo volume and envelope together, as either at zero is silence. Empty for a channel that is off, so a strip
// without bars is a strip making no sound.
function levelBar(channel: VsuChannel, side: 'left' | 'right', label: string): React.JSX.Element {
    const level = vsuChannelLevel(channel, side);
    return <span className='vp-vsu-level' title={`${label} ${channel[side]}/15`}>
        <span className='vp-vsu-level-side'>{label}</span>
        <span className='vp-vsu-level-track'>
            <span className='vp-vsu-level-fill' style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
    </span>;
}

// inset by a line's width top and bottom, so a bank held at zero or full scale is not drawn along the edge and half
// clipped away
function plotPoints(
    samples: number[], width: number, height: number, max: number, inset = 1): string {
    if (samples.length < 2) {
        return '';
    }
    const step = width / (samples.length - 1);
    const span = height - inset * 2;
    return samples
        .map((sample, index) =>
            `${(index * step).toFixed(1)},${(height - inset - (sample / max) * span).toFixed(1)}`)
        .join(' ');
}

/**
 * The VSU as a mixer: one strip per channel, the waveform banks underneath. Real hardware never lets the VSU's
 * registers be read back and this core matches that (see VB_VSU_BASE), so readVsu composes the map from the core's own
 * decoded VSU copy: what a channel is playing, not what it was given. Bit layouts are decoded in
 * emulator-vsu-memory.ts; worker/vb-vsu-layout.ts finds the core's copy.
 *
 * Muting and soloing are the emulator's: the worker holds a muted channel's stereo level at zero at every frame break
 * and hands back what the game asked for, so the VSU is not written. Both are given up when the panel closes.
 */
export class VsuPanel extends Panel {

    protected channels?: VsuChannel[];
    protected waveforms: (number[] | undefined)[] = [];
    protected modulation?: number[];
    // peak of the last frame of sound per side, 0 to 1
    protected peakLeft = 0;
    protected peakRight = 0;
    protected error?: string;

    // when each waveform bank last changed, the modulation table is the entry after them. Drivers rewrite banks
    // between notes to change instrument, so a recent change is marked for CHANGED_MS.
    protected changedAt: number[] = [];

    protected readonly muted = new Set<number>();
    protected soloed?: number;
    // so an unchanged mask is not re-sent
    protected sentMask?: number;
    // so a new machine is told again
    protected sentTo?: Sim;

    constructor(source: DebugSource, instanceId: string) {
        super(EmulatorPanelType.VSU, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/vsu/title', 'VSU');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.VSU);
    }

    protected async refresh(): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.channels = undefined;
            this.waveforms = [];
            this.modulation = undefined;
            this.peakLeft = 0;
            this.peakRight = 0;
            this.update();
            return;
        }

        try {
            const reading = await sim.readVsu();
            const map = new Uint8Array(reading.map);
            const registers = new DataView(map.buffer, VSU_REGISTER_BASE - VB_VSU_BASE, VSU_REGISTER_BLOCK_BYTES);
            this.channels = Array.from({ length: VSU_CHANNEL_COUNT }, (unused, index) => decodeVsuChannel(registers, index));
            this.readTables(map);
            this.peakLeft = reading.peakLeft;
            this.peakRight = reading.peakRight;
            this.error = undefined;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }
        // after the read, so a machine that has just appeared is told about the mutes already shown
        this.pushMutes().catch(() => undefined);
        this.update();
    }

    // the first reading of a table is not a change, or everything would be marked when the panel opens
    protected readTables(map: Uint8Array): void {
        const now = Date.now();
        const previous = this.waveforms;
        this.waveforms = VSU_WAVEFORM_BASES.map(base =>
            vsuWaveformSamples(map.subarray(base - VB_VSU_BASE, base - VB_VSU_BASE + VSU_WAVEFORM_BYTES))
        );
        this.waveforms.forEach((samples, bank) => {
            if (previous[bank] !== undefined && !vsuSamplesEqual(previous[bank], samples)) {
                this.changedAt[bank] = now;
            }
        });

        const wasModulated = this.modulation;
        this.modulation = vsuModulationSamples(
            map.subarray(VSU_MODULATION_BASE - VB_VSU_BASE, VSU_MODULATION_BASE - VB_VSU_BASE + VSU_MODULATION_BYTES));
        if (wasModulated !== undefined && !vsuSamplesEqual(wasModulated, this.modulation)) {
            this.changedAt[this.waveforms.length] = now;
        }
    }

    protected justChanged(table: number): boolean {
        const at = this.changedAt[table];
        return at !== undefined && Date.now() - at < CHANGED_MS;
    }

    protected muteMask(): number {
        let mask = 0;
        for (let index = 0; index < VSU_CHANNEL_COUNT; index++) {
            const silenced = this.soloed !== undefined
                ? index !== this.soloed
                : this.muted.has(index);
            if (silenced) {
                mask |= 1 << index;
            }
        }
        return mask;
    }

    protected async pushMutes(mask = this.muteMask()): Promise<void> {
        const sim = this.source.sim;
        if (!sim) {
            this.sentMask = undefined;
            this.sentTo = undefined;
            return;
        }
        if (this.sentMask === mask && this.sentTo === sim) {
            return;
        }
        this.sentMask = mask;
        this.sentTo = sim;
        try {
            await sim.setVsuMutes(mask);
        } catch {
            // a core whose VSU cannot be found refuses this like the read, whose message is what the panel shows;
            // forgetting what was sent lets the next poll try again
            this.sentMask = undefined;
        }
    }

    protected toggleMute(index: number): void {
        if (this.muted.has(index)) {
            this.muted.delete(index);
        } else {
            this.muted.add(index);
        }
        this.pushMutes().catch(() => undefined);
        this.update();
    }

    // one solo at a time, soloing another channel moves it. The mutes stay underneath, so dropping the solo restores
    // the mixer as it was.
    protected toggleSolo(index: number): void {
        this.soloed = this.soloed === index ? undefined : index;
        this.pushMutes().catch(() => undefined);
        this.update();
    }

    protected clearMutes(): void {
        this.muted.clear();
        this.soloed = undefined;
        this.pushMutes().catch(() => undefined);
        this.update();
    }

    // through the machine directly rather than pushMutes, which has nothing to send to by the time of dispose
    protected releaseMutes(): void {
        const sim = this.source.sim;
        this.muted.clear();
        this.soloed = undefined;
        this.sentMask = undefined;
        this.sentTo = undefined;
        if (sim) {
            sim.setVsuMutes(0).catch(() => undefined);
        }
    }

    // on detach, not only on dispose: closing a tab takes the panel out of the dock without disposing of it, and a
    // mute released only in dispose would silence a channel with nothing on screen saying why
    protected onBeforeDetach(msg: Message): void {
        this.releaseMutes();
        super.onBeforeDetach(msg);
    }

    dispose(): void {
        this.releaseMutes();
        super.dispose();
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return <EmptyContainer
                title={this.error ?? nls.localize('vueport/general/error', 'Error')}
                icon={<Warning size={32} />}
            />;
        }
        const channels = this.channels;
        if (!channels) {
            return <EmptyContainer
                title={nls.localize(
                    'vueport/general/notRunning',
                    'The emulator is not running.',
                )}
                icon={<Plug size={32} />}
            />;
        }

        return <div className='vp-vsu'>
            {this.renderOutput()}
            <div className='vp-vsu-strips'>
                <div className='vp-vsu-caption'>
                    {nls.localize('vueport/debug/panels/vsu/channels', 'Channels')}
                </div>
                {channels.map(channel => this.renderStrip(channel))}
            </div>
            {this.renderTables(channels)}
        </div>;
    }

    // measured off the machine's last frame of sound, i.e. what actually left the VSU. A game whose music has stopped
    // or whose master volume is down is silent here while its channels still read as playing.
    protected renderOutput(): React.ReactNode {
        return (
            <div className='vp-vsu-output'>
                <div className='vp-vsu-caption'>
                    {nls.localize('vueport/debug/panels/vsu/output', 'Output')}
                </div>
                <div className='vp-vsu-output-bar'>
                    <span className='vp-vsu-output-meters'>
                        {([
                            ['L', this.peakLeft],
                            ['R', this.peakRight],
                        ] as [string, number][]).map(([side, peak]) => <span
                            key={side}
                            className='vp-vsu-level'
                            title={nls.localize('vueport/debug/panels/vsu/peak', 'Peak of the last frame')}
                        >
                            <span className='vp-vsu-level-side'>{side}</span>
                            <span className='vp-vsu-level-track'>
                                <span
                                    className='vp-vsu-level-fill'
                                    style={{ width: `${Math.round(meterScale(peak) * 100)}%` }}
                                />
                            </span>
                            <span className='vp-vsu-output-db'>{decibelLabel(peak)} dB</span>
                        </span>)}
                    </span>
                    {/* only there when there is something to undo, and it undoes all mutes and the solo */}
                    {(this.muted.size > 0 || this.soloed !== undefined) && <button
                        type='button'
                        className='vp-button secondary'
                        onClick={() => this.clearMutes()}
                    >
                        {nls.localize('vueport/debug/panels/vsu/unmuteAll', 'Unmute all')}
                    </button>}
                </div>
            </div>
        );
    }

    protected renderStrip(channel: VsuChannel): React.ReactNode {
        const silenced = this.soloed !== undefined
            ? this.soloed !== channel.index
            : this.muted.has(channel.index);
        return <div
            key={channel.index}
            className={'vp-vsu-strip'
                + (channel.enabled ? ' active' : ' inactive')
                + (silenced ? ' silenced' : '')}
            title={hex(vsuChannelAddress(channel.index), 8)}
        >
            <div className='vp-vsu-strip-buttons'>
                <button
                    type='button'
                    className={'vp-vsu-button' + (this.muted.has(channel.index) ? ' on' : '')}
                    aria-pressed={this.muted.has(channel.index)}
                    title={nls.localize('vueport/debug/panels/vsu/mute',
                        'Silence this channel in the emulator, without the game knowing')}
                    onClick={() => this.toggleMute(channel.index)}
                >M</button>
                <button
                    type='button'
                    className={'vp-vsu-button solo' + (this.soloed === channel.index ? ' on' : '')}
                    aria-pressed={this.soloed === channel.index}
                    title={nls.localize('vueport/debug/panels/vsu/solo', 'Hear this channel alone')}
                    onClick={() => this.toggleSolo(channel.index)}
                >S</button>
            </div>

            {/* SxINT bit 7 from the core, the ring marks a channel that stops when its interval elapses */}
            <span
                className={'vp-vsu-state'
                    + (channel.enabled ? ' on' : '')
                    + (channel.enabled && channel.interval.enabled ? ' timed' : '')}
                title={!channel.enabled
                    ? nls.localize('vueport/debug/panels/vsu/stateOff', 'Switched off')
                    : channel.interval.enabled
                        ? nls.localize(
                            'vueport/debug/panels/vsu/stateTimed',
                            'Playing, for {0}ms, after which the hardware switches it '
                            + 'off again.',
                            String(channel.interval.durationMs))
                        : nls.localize('vueport/debug/panels/vsu/stateOn', 'Playing')}
            />

            <span className='vp-vsu-strip-name'>
                {channel.index + 1}{' '}
                <span className='hint'>{VSU_CHANNEL_SHORT_NAMES[channel.kind]}</span>
            </span>

            {this.renderStripWave(channel)}
            {this.renderStripNote(channel)}

            <span className='vp-vsu-strip-levels'>
                {levelBar(channel, 'left', 'L')}
                {levelBar(channel, 'right', 'R')}
            </span>

            <span className='vp-vsu-strip-detail'>
                {this.renderEnvelope(channel)}
                {channel.interval.enabled && <span
                    className='vp-vsu-chip'
                    title={nls.localize('vueport/debug/panels/vsu/intervalHint',
                        'The hardware switches this channel off after this long')}
                >
                    {channel.interval.durationMs} ms
                </span>}
                {this.renderSweep(channel)}
            </span>
        </div>;
    }

    // noise is an LFSR with no waveform to draw, so it shows its period instead
    protected renderStripWave(channel: VsuChannel): React.ReactNode {
        if (channel.noise) {
            return <span className='vp-vsu-strip-wave hint' title={nls.localize(
                'vueport/debug/panels/vsu/noiseHint', 'Bit {0} of the shift register, repeating every {1} steps',
                String(channel.noise.tapBit), String(channel.noise.period))}
            >
                {nls.localize('vueport/debug/panels/vsu/tap', 'Tap')} {channel.noise.tap}
            </span>;
        }
        const samples = channel.waveform !== undefined ? this.waveforms[channel.waveform] : undefined;
        return <span className='vp-vsu-strip-wave'>
            {samples && <svg className='vp-vsu-spark' viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}>
                <polyline points={plotPoints(samples, SPARK_WIDTH, SPARK_HEIGHT, SAMPLE_MAX)} />
            </svg>}
            <span className='hint' title={nls.localize(
                'vueport/debug/panels/vsu/bankHint', 'The waveform bank this channel is playing')}
            >#{channel.waveform}</span>
        </span>;
    }

    // note and frequency as the channel plays it now, so a swept channel's note walks. Noise is a rate, not a pitch.
    protected renderStripNote(channel: VsuChannel): React.ReactNode {
        const note = channel.kind === VsuChannelKind.NOISE ? undefined : vsuNoteOf(channel.frequencyHz);
        return <span
            className='vp-vsu-strip-note'
            title={`${nls.localize('vueport/debug/panels/vsu/freq', 'Freq')} ${hex(channel.frequencyRaw, 3)}`
                + (note ? ` · ${note.cents >= 0 ? '+' : '−'}${Math.abs(note.cents)} cents` : '')}
        >
            {note
                ? <>{note.name}{' '}<span className='hint'>{Math.round(channel.frequencyHz)} Hz</span></>
                : <span className='hint'>{Math.round(channel.frequencyHz)} Hz</span>}
        </span>;
    }

    // arrow and step time mean nothing with the envelope switched off: the level stays where SxEV0 put it
    protected renderEnvelope(channel: VsuChannel): React.ReactNode {
        const envelope = channel.envelope;
        return <span className='vp-vsu-chip' title={nls.localize(
            'vueport/debug/panels/vsu/envelope', 'Envelope')}
        >
            {nls.localize('vueport/debug/panels/vsu/env', 'env')} {envelope.initialValue}
            {envelope.enabled
                ? <>
                    {envelope.direction === VsuEnvelopeDirection.GROW ? '↑' : '↓'}
                    {' '}{envelope.stepMs}ms{envelope.repeat ? ' ↻' : ''}
                </>
                : <> {nls.localize('vueport/debug/panels/vsu/flat', 'flat')}</>}
        </span>;
    }

    protected renderSweep(channel: VsuChannel): React.ReactNode {
        const sweep = channel.sweepModulation;
        if (!sweep) {
            return undefined;
        }
        const off = !sweep.enabled || sweep.interval === 0;
        const modulating = sweep.function === VsuSweepModulationFunction.MODULATION;
        return <span className={'vp-vsu-chip' + (off ? '' : ' lit')}>
            {modulating
                ? nls.localize('vueport/debug/panels/vsu/modulation', 'mod')
                : nls.localize('vueport/debug/panels/vsu/sweep', 'sweep')}
            {' '}
            {sweep.direction === VsuSweepDirection.UP ? '↑' : '↓'}{sweep.shift}
            {' '}
            {off
                ? nls.localize('vueport/debug/panels/vsu/off', 'off')
                : `${sweep.intervalMs}ms${sweep.repeat ? ' ↻' : ''}`}
        </span>;
    }

    // drawn together, as a channel's bank number means nothing without its shape, and channels sharing a bank change
    // instrument together. Read on every poll, since drivers rewrite them while the game plays.
    protected renderTables(channels: VsuChannel[]): React.ReactNode {
        const sweeping = channels[VsuChannelKind.SWEEP]?.sweepModulation;
        const modulating = sweeping?.enabled
            && sweeping.function === VsuSweepModulationFunction.MODULATION;

        return <div className='vp-vsu-tables'>
            <div className='vp-vsu-caption'>
                <div>{nls.localize('vueport/debug/panels/vsu/waveforms', 'Waveform banks')}</div>
            </div>
            <div className='vp-vsu-bank-row'>
                {this.waveforms.map((samples, bank) => {
                    const players = channels
                        .filter(channel => channel.waveform === bank && channel.enabled)
                        .map(channel => channel.index + 1);
                    return <div
                        key={bank}
                        className={'vp-vsu-bank'
                            + (players.length > 0 ? ' playing' : '')
                            + (this.justChanged(bank) ? ' changed' : '')}
                        title={hex(VSU_WAVEFORM_BASES[bank], 8)}
                    >
                        <svg viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`} preserveAspectRatio='none'>
                            {samples && <polyline
                                points={plotPoints(samples, PLOT_WIDTH, PLOT_HEIGHT, SAMPLE_MAX)}
                            />}
                        </svg>
                        <div className='vp-vsu-bank-label'>
                            <span>#{bank}</span>
                            {players.length > 0 && <span className='vp-vsu-bank-players'>
                                {players.join(' ')}
                            </span>}
                        </div>
                    </div>;
                })}

                {/* drawn beside the banks, but only while the fifth channel is set to modulate */}
                {modulating && <div
                    className={'vp-vsu-bank playing'
                        + (this.justChanged(this.waveforms.length) ? ' changed' : '')}
                    title={hex(VSU_MODULATION_BASE, 8)}
                >
                    <svg viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`} preserveAspectRatio='none'>
                        {/* signed, so the line is drawn around a middle */}
                        <line
                            className='vp-vsu-bank-zero'
                            x1='0' y1={PLOT_HEIGHT / 2} x2={PLOT_WIDTH} y2={PLOT_HEIGHT / 2}
                        />
                        {this.modulation && <polyline points={plotPoints(
                            this.modulation.map(sample => sample + MODULATION_RANGE),
                            PLOT_WIDTH, PLOT_HEIGHT, MODULATION_RANGE * 2)}
                        />}
                    </svg>
                    <div className='vp-vsu-bank-label'>
                        <span>{nls.localize('vueport/debug/panels/vsu/modulationTable', 'Mod')}</span>
                        <span className='vp-vsu-bank-players'>5</span>
                    </div>
                </div>}
            </div>
        </div>;
    }
}
