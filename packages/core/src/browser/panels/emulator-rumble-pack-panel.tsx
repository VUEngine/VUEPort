import { Message } from '@lumino/messaging';
import * as React from 'react';
import { Disposable } from '../../common/emulator-events';
import { formatLogTime } from '../../common/emulator-log';
import { nls } from '../../common/emulator-nls';
import {
    getRumbleEffectName,
    isRumblePlaying,
    RumbleCommand,
    rumbleEffectAmplitudeAt,
    rumbleEffectMs,
    rumbleEffectShape,
    RumbleState,
    VueportRumblePack,
} from '../../common/emulator-rumble';
import { EmulatorPanelType, DebugSource, Panel } from './emulator-panel';
import { emulatorPanelTitleIcon } from './emulator-panel-icons';

/**
 * RetroOnyx's mark on the pack's face plate, traced from the hardware. Two paths and no clipPath, as the panel can be
 * open twice (a linked pair has a dock each) and duplicate ids break. The hatching is precut stripes: seven bands every
 * 10.4 units at 62 degrees, intersected with the outline inset by its border width. The plate is a pentagon 84 wide and
 * 66 tall, its sides straight for 44 and then meeting at a point.
 */
const PLATE_OUTLINE = 'M8 4L92 4L92 48L50 70L8 48Z';
const PLATE_HATCHING = 'M17.5 13.5L22.1 13.5L17.5 22.1Z'
    + 'M28.2 13.5L33.9 13.5L18.3 42.7L17.5 42.3L17.5 33.6Z'
    + 'M40.0 13.5L45.6 13.5L27.6 47.5L23.1 45.2Z'
    + 'M51.8 13.5L57.4 13.5L36.8 52.3L32.3 50.0Z'
    + 'M63.5 13.5L69.2 13.5L46.0 57.2L41.5 54.8Z'
    + 'M75.3 13.5L81.0 13.5L59.2 54.5L51.3 58.6Z'
    + 'M82.5 22.1L82.5 32.8L75.5 45.9L67.7 50.0Z';

/**
 * What the running game asks a rumble pack to do, and whether one is plugged in. Everything but the connection block
 * shows either way, as commands are read off the emulated link port, also where no serial port can be opened (see
 * DecodingRumblePack). Only a second player stops it: cable and pack share the socket, so during a link cable session
 * the port is the cable's (see applyRumbleForwarding on the widget). Connection and bytes arrive as events, so the
 * inherited polling only notices a simulation appearing or going away.
 */
export class RumblePackPanel extends Panel {

    // least time the motor box shakes, in ms. A floor, not an addition: the shortest effect is a 69 ms tick (four
    // frames), which would only flicker
    protected static readonly MOTOR_MIN_MS = 120;

    // redraw interval in ms while an effect runs; only ramps need it, a 320 ms rise redrawn twice would show two steps
    protected static readonly MOTOR_STEP_MS = 60;

    protected detecting = false;
    protected error: string | undefined;
    protected motorTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        source: DebugSource,
        instanceId: string,
        protected readonly rumblePack: VueportRumblePack
    ) {
        super(EmulatorPanelType.RUMBLE_PACK, source, instanceId);
        this.title.label = nls.localize('vueport/debug/panels/rumblePack/title', 'Rumble Pack');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.RUMBLE_PACK);
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        // re-subscribed on every attach, as toDisposeOnDetach is emptied on detach, which a dock layout change does
        this.toDisposeOnDetach.push(
            this.rumblePack.onDidChangeConnected(() => this.update())
        );
        this.toDisposeOnDetach.push(Disposable.create(() => {
            clearTimeout(this.motorTimer);
            this.motorTimer = undefined;
        }));
    }

    protected pollHz(): number {
        return 1;
    }

    protected refresh(): void {
        this.update();
    }

    protected async detect(): Promise<void> {
        // the port prompt is modal, but the button stays clickable while a detection waits on the device itself
        if (this.detecting) {
            return;
        }
        this.detecting = true;
        this.error = undefined;
        this.update();
        try {
            await this.rumblePack.detect();
        } catch (error) {
            // picking no device is swallowed by the service; what reaches here is a port that couldn't be opened,
            // usually because something else holds it
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.detecting = false;
            this.update();
        }
    }

    protected render(): React.ReactNode {
        const commands = this.rumblePack.emulatedCommands;
        const rumbleState = this.rumblePack.emulatedRumbleState;

        return <div className='vp-rumble-pack'>
            {this.renderConnection(rumbleState)}
            {this.error && <div className='vp-rumble-pack-error'>{this.error}</div>}
            {this.renderEffect(rumbleState)}
            {this.renderCommands(commands)}
        </div>;
    }

    protected renderConnection(state: RumbleState): React.ReactNode {
        const port = this.rumblePack.connected;
        const cabled = this.rumblePack.linkPortInUse === true;
        const info = this.rumblePack.deviceIds;
        // undefined from hosts written before the flag, all of which could open a port
        const canConnect = this.rumblePack.canConnect !== false;
        const mode = cabled ? 'cabled' : port ? 'connected' : 'disconnected';

        const detail: React.ReactNode = cabled
            ? nls.localize(
                'vueport/debug/panels/rumblePack/linkPortTaken',
                'Switched off while a second player is linked: a Rumble Pack and a link cable share the one link port.'
            )
            : port
                ? <>
                    {info && <><code>{usbId(info.vendor)} / {usbId(info.product)}</code> · </>}
                    {this.rumblePack.forwarding
                        ? nls.localize(
                            'vueport/debug/panels/rumblePack/forwardingOn',
                            'forwarding from the emulator'
                        )
                        : nls.localize(
                            'vueport/debug/panels/rumblePack/forwardingOff',
                            'idle until a game is running'
                        )}
                </>
                : !this.rumblePack.forwarding
                    ? nls.localize('vueport/general/notRunning', 'The emulator is not running.')
                    : canConnect
                        ? nls.localize(
                            'vueport/debug/panels/rumblePack/decodingOnly',
                            'Connect your Rumble Pack via USB, then click "Detect".'
                        )
                        // not a fault: this browser can't open serial ports at all (Chromium takes the branch above)
                        : nls.localize(
                            'vueport/debug/panels/rumblePack/decodingOnlyHost',
                            'Not supported in this browser.'
                        );

        return <div className={`vp-rumble-pack-status ${mode}`}>
            {this.renderMotor(this.motorStrength(state), state.frequency)}
            <div className='vp-rumble-pack-status-text'>
                <div className='vp-rumble-pack-status-headline'>{port
                    ? nls.localize(
                        'vueport/debug/panels/rumblePack/connected',
                        'Connected',
                    )
                    : nls.localize('vueport/debug/panels/rumblePack/notConnected', 'No Rumble Pack connected')}
                </div>
                { /* }
                <div className='vp-rumble-pack-status-detail'>
                    {port && (this.rumblePack.deviceName ?? nls.localize(
                        'vueport/debug/panels/rumblePack/unknownBoard',
                        'Unknown board'
                    ))}
                </div>
                { */ }
                <div className='vp-rumble-pack-status-detail'>
                    {detail}
                </div>
                {/* only with hardware attached */}
                {port && <div className='vp-rumble-pack-status-count'>
                    {nls.localize(
                        'vueport/debug/panels/rumblePack/bytesSent',
                        '{0} bytes sent',
                        this.rumblePack.emulatedByteCount
                    )}
                    {/* once there is a reply */}
                    {this.rumblePack.lastReply !== undefined && <>
                        {' · '}
                        {nls.localize('vueport/debug/panels/rumblePack/lastReply', 'Last reply')}
                        {': '}
                        <code>{this.rumblePack.lastReply}</code>
                    </>}
                    {/* only when there are any: a game asking for more than the board can take looks exactly like a faulty pack */}
                    {(this.rumblePack.droppedCommands ?? 0) > 0 && <span className='vp-rumble-pack-dropped'>
                        {' · '}
                        {nls.localize(
                            'vueport/debug/panels/rumblePack/dropped',
                            '{0} dropped',
                            this.rumblePack.droppedCommands ?? 0
                        )}
                    </span>}
                </div>}
            </div>
            {/* not while the cable has the port or with no way to open one */}
            {!cabled && canConnect && <button
                className='vp-button secondary'
                onClick={() => this.detect()}
                disabled={this.detecting}
            >
                {this.detecting
                    ? nls.localize('vueport/debug/panels/rumblePack/detecting', 'Searching...')
                    : port
                        ? nls.localize('vueport/debug/panels/rumblePack/reconnect', 'Reconnect')
                        : nls.localize('vueport/debug/panels/rumblePack/detect', 'Detect')}
            </button>}
        </div>;
    }

    protected renderMotor(strength: number | undefined, frequency: number | undefined): React.ReactNode {
        // indicative only: the pack runs at ~160 Hz, far past what a screen can show, so the range is mapped onto a
        // visible one
        const period = frequency === undefined
            ? 130
            : Math.min(200, Math.max(60, Math.round(200 - frequency / 3)));
        // rounded on purpose: it is the element's key, so a strength change remounts it and restarts the shake (a
        // running CSS animation won't notice a changed custom property)
        const amount = strength === undefined ? 0 : Math.round(strength * 10) / 10;

        return <div
            key={amount}
            className={`vp-rumble-pack-motor${strength === undefined ? '' : ' running'}`}
            style={{
                '--vp-rumble-period': `${period}ms`,
                '--vp-rumble-amount': amount,
            } as React.CSSProperties}
            aria-hidden={true}
        >
            {/* see PLATE_OUTLINE */}
            <svg className='vp-rumble-pack-plate' viewBox='-4 -4 108 82'>
                <path
                    d={PLATE_OUTLINE}
                    fill='none'
                    stroke='currentColor'
                    strokeWidth={7}
                    strokeLinejoin='round'
                />
                <path d={PLATE_HATCHING} fill='currentColor' />
            </svg>
        </div>;
    }

    /**
     * How hard to draw the motor shaking, or undefined for still. Effects end on their own after their measured length
     * (isRumblePlaying), ramps change strength (rumbleEffectAmplitudeAt), and the shortest are floored at MOTOR_MIN_MS.
     * Bytes bring their own redraws; the timer covers ramp steps and effects that no byte comes to end.
     */
    protected motorStrength(state: RumbleState): number | undefined {
        const now = Date.now();
        const since = state.playingSince;
        if (state.playing !== true || since === undefined) {
            return undefined;
        }
        const elapsed = now - since;
        const running = isRumblePlaying(state, now) || elapsed < RumblePackPanel.MOTOR_MIN_MS;
        if (!running) {
            return undefined;
        }

        const shape = rumbleEffectShape(state.effect);
        const length = Math.max(rumbleEffectMs(shape), RumblePackPanel.MOTOR_MIN_MS);
        if (this.motorTimer === undefined) {
            this.motorTimer = setTimeout(() => {
                this.motorTimer = undefined;
                this.update();
            }, Math.min(RumblePackPanel.MOTOR_STEP_MS, Math.max(16, length - elapsed)));
        }
        return rumbleEffectAmplitudeAt(shape, elapsed / length);
    }

    // the effect the forwarded bytes add up to, laid out as in the rumble effect editor. The engine skips unchanged
    // values (Rumble.c caches them), so an unseen field is unknown, not zero
    protected renderEffect(state: RumbleState): React.ReactNode {
        const spec = this.rumblePack.emulatedSpec;
        const rows: [string, string][] = [
            [
                nls.localize('vueport/debug/panels/rumblePack/spec', 'Spec'),
                // no spec is the engine's "nothing is playing"
                spec
                    ? spec.name ?? nls.localize(
                        'vueport/debug/panels/rumblePack/unnamedSpec',
                        'Unnamed, at {0}',
                        `0x${spec.address.toString(16).toUpperCase().padStart(8, '0')}`
                    )
                    : '—',
            ],
            [
                nls.localize('vueport/debug/panels/rumblePack/effects/effect', 'Effect'),
                state.effect === undefined ? '—' : getRumbleEffectName(state.effect),
            ],
            [
                nls.localize('vueport/debug/panels/rumblePack/effects/frequency', 'Frequency'),
                state.frequency === undefined ? '—' : `${state.frequency} Hz`,
            ],
        ];

        return (
            <fieldset className='vp-inspector-group'>
                <legend>
                    {nls.localize('vueport/debug/panels/rumblePack/effect', 'Last Effect')}
                    {/* not state.playing, which is only what the game last asked: an effect stops on its own, see isRumblePlaying */}
                    {state.playing !== undefined && <span className='vp-rumble-pack-playing'>
                        {isRumblePlaying(state)
                            ? nls.localize('vueport/debug/panels/rumblePack/effectPlaying', 'Playing')
                            : nls.localize('vueport/debug/panels/rumblePack/effectStopped', 'Stopped')}
                    </span>}
                </legend>
                <table className='vp-rumble-pack-info'>
                    <tbody>
                        {rows.map(([label, value]) => <tr key={label}>
                            <th>{label}</th>
                            <td>{value}</td>
                        </tr>)}
                    </tbody>
                </table>
            </fieldset>
        );
    }

    protected renderCommands(commands: RumbleCommand[]): React.ReactNode {
        return (
            <fieldset className='vp-inspector-group'>
                <legend>
                    {nls.localize('vueport/debug/panels/rumblePack/commands', 'Last commands')}
                </legend>
                {commands.length === 0 && <div className='vp-panel-empty'>
                    {this.source.sim
                        ? nls.localize(
                            'vueport/debug/panels/rumblePack/noCommands',
                            'Nothing broadcast yet.'
                        )
                        : nls.localize('vueport/general/notRunning', 'The emulator is not running.')}
                </div>}
                <div className='vp-rumble-pack-commands'>
                    {commands.map((command, index) => <div
                        key={index}
                        className={command.unknown ? 'unknown' : undefined}
                    >
                        <span className='vp-log-time'>{formatLogTime(command.at)}</span>
                        <code>{command.bytes.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')}</code>
                        <span>{command.label}</span>
                    </div>)}
                </div>
            </fieldset>
        );
    }
}

function usbId(value: number | undefined): string {
    return value === undefined ? '—' : `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
}
