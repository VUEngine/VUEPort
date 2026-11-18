/**
 * Plays the Rumble Pack's effects (a DRV2625 with 123 waveforms) on a pad's heavy and light motor via the Gamepad API.
 * RUMBLE_EFFECT_SHAPES bridges the two: strength from the effect's name, length measured on the real hardware, and
 * ramps played in steps, as playEffect holds one magnitude for its whole duration. Effects of ~70 ms barely exceed
 * motor spin-up, so they arrive as a bump.
 *
 * Fed by the pack's change event rather than the byte path, so it works with a real serial pack and the decoding-only
 * fallback alike.
 */

import { Disposable } from '../common/emulator-events';
import {
    isRumblePlaying,
    rumbleEffectAmplitudeAt,
    RumbleEffectShape,
    rumbleEffectMs,
    rumbleEffectShape,
    RumbleState,
    VueportRumblePack,
} from '../common/emulator-rumble';

// for a Play sent before the game ever chose an effect
export const GAMEPAD_PULSE_MS = 200;

// playEffect holds one pair of magnitudes for its whole duration, so a ramp is played in steps. Four feel like a rise
// rather than a block, and even the shortest measured ramp (216 ms) gives each step more than a pad's response time
export const GAMEPAD_RAMP_STEPS = 4;

// declared here, as vibrationActuator isn't in every version of the DOM lib
interface VibrationActuator {
    playEffect(type: string, params: {
        duration: number,
        startDelay?: number,
        strongMagnitude?: number,
        weakMagnitude?: number,
    }): Promise<string>;
    reset?(): Promise<string>;
}

// the older Gamepad Extensions draft (one pulse of one strength), which Firefox has instead of vibrationActuator,
// and only behind dom.gamepad.haptic_feedback.enabled
interface HapticActuator {
    pulse(value: number, duration: number): Promise<boolean>;
}

interface PadMotors {
    play(duration: number, strong: number, weak: number): void;
    reset(): void;
}

// undefined is common: Chrome only gives a vibrationActuator to controllers it knows how to drive (Xbox, DualShock,
// DualSense, Switch Pro, a few others), so a pad it reads raw gets none even if it has motors
function padMotors(pad: Gamepad): PadMotors | undefined {
    const actuator = (pad as unknown as { vibrationActuator?: VibrationActuator | null }).vibrationActuator;
    if (typeof actuator?.playEffect === 'function') {
        return {
            play: (duration, strong, weak) => {
                actuator
                    .playEffect('dual-rumble', { duration, strongMagnitude: strong, weakMagnitude: weak })
                    // a pad unplugged mid-effect, or one that doesn't support the effect after all
                    .catch(() => undefined);
            },
            reset: () => { actuator.reset?.().catch(() => undefined); },
        };
    }
    const haptic = (pad as unknown as { hapticActuators?: readonly HapticActuator[] }).hapticActuators?.[0];
    if (typeof haptic?.pulse === 'function') {
        return {
            // only one motor, so the stronger of the two
            play: (duration, strong, weak) => { haptic.pulse(Math.max(strong, weak), duration).catch(() => undefined); },
            reset: () => { haptic.pulse(0, 0).catch(() => undefined); },
        };
    }
    return undefined;
}

// period in ms a weaker effect is chopped into, as the Vibration API only knows on and off; a motor pulsed this fast
// feels like a softer buzz rather than taps
const DEVICE_PWM_MS = 20;
// a motor never spins up in less than this, so a weak step is never chopped finer
const DEVICE_MIN_ON_MS = 5;

// the phone's or tablet's own motor via navigator.vibrate (Chrome on Android, not Safari on iOS). It has no strength,
// so the stronger pad magnitude sets the duty cycle of each DEVICE_PWM_MS period; near full strength is one long buzz
export function deviceMotor(): PadMotors | undefined {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
        return undefined;
    }
    const vibrate = (pattern: number | number[]): void => {
        try {
            navigator.vibrate(pattern);
        } catch {
            // refused before the first user gesture; the next effect tries again
        }
    };
    return {
        play: (duration, strong, weak) => {
            const level = Math.max(strong, weak);
            if (level <= 0 || duration <= 0) {
                return;
            }
            if (level >= 0.9) {
                vibrate(duration);
                return;
            }
            const on = Math.max(DEVICE_MIN_ON_MS, Math.round(DEVICE_PWM_MS * level));
            const off = Math.max(0, DEVICE_PWM_MS - on);
            const pattern: number[] = [];
            for (let elapsed = 0; elapsed < duration; elapsed += on + off) {
                pattern.push(Math.min(on, duration - elapsed), off);
            }
            vibrate(pattern);
        },
        reset: () => vibrate(0),
    };
}

export function deviceCanRumble(): boolean {
    return deviceMotor() !== undefined;
}

export function gamepadCanRumble(pad: Gamepad): boolean {
    return padMotors(pad) !== undefined;
}

export type RumblePads = () => Gamepad[];

export class GamepadRumble implements Disposable {

    protected playing: number | undefined; // number of the Play already acted on
    protected subscription: Disposable | undefined;
    protected steps: ReturnType<typeof setTimeout>[] = [];

    constructor(
        protected readonly pack: VueportRumblePack,
        protected readonly pads: RumblePads,
        // 0–1, 0 is off. Read on every effect, so a slider change is felt on the next one
        protected readonly intensity: () => number,
        // whether the device's own motor stands in while no pad with motors drives this machine; read per effect
        protected readonly onDevice?: () => boolean,
    ) { }

    start(): this {
        this.subscription ??= this.pack.onDidChangeConnected(() => this.follow());
        return this;
    }

    dispose(): void {
        this.subscription?.dispose();
        this.subscription = undefined;
        this.silence();
    }

    // off while a real pack is attached and fed, as the user then doesn't also want it in their hands
    protected wanted(): boolean {
        return this.intensity() > 0 && !(this.pack.connected && this.pack.forwarding);
    }

    // called on every byte the pack sees
    protected follow(): void {
        const state = this.pack.emulatedRumbleState;
        // by the Play's number rather than its timestamp, as a game may send two in the same millisecond
        const play = state.plays;
        if (play !== undefined && play !== this.playing && isRumblePlaying(state)) {
            // noted even when nothing is played, so switching this on mid-effect doesn't buzz for a past Play
            this.playing = play;
            if (this.wanted()) {
                this.pulse(state);
            }
            return;
        }
        // a Stop cuts an effect short; one that ran its full length needs nothing, as the pulse is already over
        if (state.playing === false && this.playing !== undefined) {
            this.playing = undefined;
            this.silence();
        }
    }

    // lasts exactly as long as the panel shows it as playing (the effect's measured length)
    protected pulse(state: RumbleState): void {
        this.clearSteps();
        const shape = rumbleEffectShape(state.effect);
        // for an effect that runs until stopped this is a ceiling
        const total = shape === undefined ? GAMEPAD_PULSE_MS : rumbleEffectMs(shape);
        const count = shape?.rampTo === undefined ? 1 : GAMEPAD_RAMP_STEPS;
        const each = Math.round(total / count);

        for (let step = 0; step < count; step++) {
            const play = () => this.play(each, this.strength(shape, state.frequency, step, count));
            if (step === 0) {
                play();
            } else {
                this.steps.push(setTimeout(play, each * step));
            }
        }
    }

    protected strength(
        shape: RumbleEffectShape | undefined,
        frequency: number | undefined,
        step: number,
        count: number,
    ): { strong: number, weak: number } {
        const { strong, weak } = magnitudes(frequency);
        // sampled at the step's middle, so a rise neither starts at nothing nor ends at full and mirrors the fall
        const scale = rumbleEffectAmplitudeAt(shape, count === 1 ? 1 : (step + 0.5) / count)
            * Math.min(1, Math.max(0, this.intensity()));
        return { strong: round(strong * scale), weak: round(weak * scale) };
    }

    protected play(duration: number, { strong, weak }: { strong: number, weak: number }): void {
        for (const motors of this.motors()) {
            motors.play(duration, strong, weak);
        }
    }

    protected silence(): void {
        this.clearSteps();
        for (const motors of this.motors()) {
            motors.reset();
        }
    }

    protected clearSteps(): void {
        for (const step of this.steps) {
            clearTimeout(step);
        }
        this.steps.length = 0;
    }

    // the device's own motor only when no pad has motors, as a user holding a pad doesn't want the phone buzzing too
    protected motors(): PadMotors[] {
        const pads = this.pads().map(padMotors).filter((motors): motors is PadMotors => motors !== undefined);
        if (pads.length === 0 && this.onDevice?.()) {
            const device = deviceMotor();
            return device ? [device] : [];
        }
        return pads;
    }
}

// the pack's frequency (50 to 400 Hz) as a crossfade between a pad's heavy and light motor. The hardware has one
// motor, but this keeps a 400 Hz buzz feeling different from a 50 Hz shudder. Unknown frequency sits in the middle
export function magnitudes(frequency: number | undefined): { strong: number, weak: number } {
    const tilt = frequency === undefined
        ? 0.5
        : Math.min(1, Math.max(0, (frequency - 50) / 350));
    return { strong: round(1 - 0.6 * tilt), weak: round(0.4 + 0.6 * tilt) };
}

function round(value: number): number {
    return Number(Math.min(1, Math.max(0, value)).toFixed(3));
}
