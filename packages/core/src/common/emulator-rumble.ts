// copy of the parts of VES's rumble pack support the emulator needs (protocol shapes, effect names), so nothing under
// emulator/ reaches into rumble-pack/. Expected to drift apart: one emulates a device, the other drives a real one

import { Disposable, Emitter, Event } from './emulator-events';
import { nls } from './emulator-nls';

export interface RumbleCommand {
    bytes: number[];
    label: string;
    unknown?: boolean; // true for a byte that means nothing in this protocol
    at: number; // as Date.now() reads
}

export interface RumbleState {
    effect?: number;
    frequency?: number;
    playing?: boolean;
    // as Date.now() reads. Kept because the pack's effects stop on their own and a Stop only cuts one short;
    // isRumblePlaying turns it into an answer
    playingSince?: number;
    // which Play it is, for anybody acting once per effect; two Plays in the same millisecond share a timestamp
    // but not a number
    plays?: number;
    chain?: number;
}

// for the two effects without a measured length (RUMBLE_EFFECT_SHAPES): the one built to run until stopped,
// and a Play whose effect number the game never sent
export const RUMBLE_EFFECT_MAX_MS = 1000;

// state.playing only says what the game last asked for, and the pack's effects end themselves, so a game that never
// sends a Stop would leave it true. The effect's measured length (rumbleEffectMs) decides; `now` is a parameter so one
// pass gets one answer for everything it draws, and tests can set it
export function isRumblePlaying(state: RumbleState, now = Date.now()): boolean {
    if (state.playing !== true || state.playingSince === undefined) {
        // the decoder stamps every Play; were one unstamped, over is the safe answer rather than forever
        return false;
    }
    // uncapped: the 1000 ms alert runs a little past a second, and cutting it at the ceiling would report wrong
    // the one effect whose length is beyond doubt
    return now - state.playingSince < rumbleEffectMs(rumbleEffectShape(state.effect));
}

export interface EmulatedRumbleSpec {
    address: number;
    name?: string; // only set when a symbol covers the address
}

// built on first use, as a table built at import would stay English (localization is installed during start-up);
// cached afterwards, as changing language needs a reload anyway
let effectNames: string[] | undefined;

export function builtInRumbleEffects(): string[] {
    if (!effectNames) {
        effectNames = [
    `1) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/strongClick', 'Strong Click')} - 100 %`,
    `2) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/strongClick', 'Strong Click')} - 60 % `,
    `3) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/strongClick', 'Strong Click')} - 30 % `,
    `4) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/sharpClick', 'Sharp Click')} - 100 % `,
    `5) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/sharpClick', 'Sharp Click')} - 60 % `,
    `6) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/sharpClick', 'Sharp Click')} - 30 % `,
    `7) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/softBump', 'Soft Bump')} - 100 % `,
    `8) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/softBump', 'Soft Bump')} - 60 % `,
    `9) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/softBump', 'Soft Bump')} - 30 % `,
    `10) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/doubleClick', 'Double Click')} - 100 % `,
    `11) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/doubleClick', 'Double Click')} - 60 % `,
    `12) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/tripleClick', 'Triple Click')} - 100 % `,
    `13) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/softFuzz', 'Soft Fuzz')} - 60 % `,
    `14) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/strongBuzz', 'Strong Buzz')} - 100 % `,
    `15) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/alert750Ms', '750 ms Alert')} 100 % `,
    `16) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/alert1000Ms', '1000 ms Alert')} 100 % `,
    `17) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/strongClick', 'Strong Click')} 1 - 100 % `,
    `18) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/strongClick', 'Strong Click')} 2 - 80 % `,
    `19) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/strongClick', 'Strong Click')} 3 - 60 % `,
    `20) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/strongClick', 'Strong Click')} 4 - 30 % `,
    `21) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/mediumClick', 'Medium Click')} 1 - 100 % `,
    `22) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/mediumClick', 'Medium Click')} 2 - 80 % `,
    `23) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/mediumClick', 'Medium Click')} 3 - 60 % `,
    `24) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/sharpTick', 'Sharp Tick')} 1 - 100 % `,
    `25) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/sharpTick', 'Sharp Tick')} 2 - 80 % `,
    `26) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/sharpTick', 'Sharp Tick')} 3 – 60 % `,
    `27) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleClickStrong', 'Short Double Click Strong')} 1 – 100 % `,
    `28) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleClickStrong', 'Short Double Click Strong')} 2 – 80 % `,
    `29) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleClickStrong', 'Short Double Click Strong')} 3 – 60 % `,
    `30) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleClickStrong', 'Short Double Click Strong')} 4 – 30 % `,
    `31) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleClickMedium', 'Short Double Click Medium')} 1 – 100 % `,
    `32) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleClickMedium', 'Short Double Click Medium')} 2 – 80 % `,
    `33) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleClickMedium', 'Short Double Click Medium')} 3 – 60 % `,
    `34) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleSharpTick', 'Short Double Sharp Tick')} 1 – 100 % `,
    `35) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleSharpTick', 'Short Double Sharp Tick')} 2 – 80 % `,
    `36) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/shortDoubleSharpTick', 'Short Double Sharp Tick')} 3 – 60 % `,
    `37) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpClickStrong', 'Long Double Sharp Click Strong')} 1 – 100 % `,
    `38) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpClickStrong', 'Long Double Sharp Click Strong')} 2 – 80 % `,
    `39) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpClickStrong', 'Long Double Sharp Click Strong')} 3 – 60 % `,
    `40) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpClickStrong', 'Long Double Sharp Click Strong')} 4 – 30 % `,
    `41) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpClickMedium', 'Long Double Sharp Click Medium')} 1 – 100 % `,
    `42) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpClickMedium', 'Long Double Sharp Click Medium')} 2 – 80 % `,
    `43) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpClickMedium', 'Long Double Sharp Click Medium')} 3 – 60 % `,
    `44) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpTick', 'Long Double Sharp Tick')} 1 – 100 % `,
    `45) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpTick', 'Long Double Sharp Tick')} 2 – 80 % `,
    `46) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longDoubleSharpTick', 'Long Double Sharp Tick')} 3 – 60 % `,
    `47) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/buzz', 'Buzz')} 1 – 100 % `,
    `48) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/buzz', 'Buzz')} 2 – 80 % `,
    `49) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/buzz', 'Buzz')} 3 – 60 % `,
    `50) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/buzz', 'Buzz')} 4 – 40 % `,
    `51) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/buzz', 'Buzz')} 5 – 20 % `,
    `52) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/pulsingStrong', 'Pulsing Strong')} 1 – 100 % `,
    `53) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/pulsingStrong', 'Pulsing Strong')} 2 – 60 % `,
    `54) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/pulsingMedium', 'Pulsing Medium')} 1 – 100 % `,
    `55) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/pulsingMedium', 'Pulsing Medium')} 2 – 60 % `,
    `56) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/pulsingSharp', 'Pulsing Sharp')} 1 – 100 % `,
    `57) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/pulsingSharp', 'Pulsing Sharp')} 2 – 60 % `,
    `58) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionClick', 'Transition Click')} 1 – 100 % `,
    `59) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionClick', 'Transition Click')} 2 – 80 % `,
    `60) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionClick', 'Transition Click')} 3 – 60 % `,
    `61) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionClick', 'Transition Click')} 4 – 40 % `,
    `62) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionClick', 'Transition Click')} 5 – 20 % `,
    `63) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionClick', 'Transition Click')} 6 – 10 % `,
    `64) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionHum', 'Transition Hum')} 1 – 100 % `,
    `65) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionHum', 'Transition Hum')} 2 – 80 % `,
    `66) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionHum', 'Transition Hum')} 3 – 60 % `,
    `67) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionHum', 'Transition Hum')} 4 – 40 % `,
    `68) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionHum', 'Transition Hum')} 5 – 20 % `,
    `69) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionHum', 'Transition Hum')} 6 – 10 % `,
    `70) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownLongSmooth', 'Transition Ramp Down Long Smooth')} 1 – 100 to 0 % `,
    `71) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownLongSmooth', 'Transition Ramp Down Long Smooth')} 2 – 100 to 0 % `,
    `72) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownMediumSmooth', 'Transition Ramp Down Medium Smooth')} 1 – 100 to 0 % `,
    `73) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownMediumSmooth', 'Transition Ramp Down Medium Smooth')} 2 – 100 to 0 % `,
    `74) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownShortSmooth', 'Transition Ramp Down Short Smooth')} 1 – 100 to 0 % `,
    `75) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownShortSmooth', 'Transition Ramp Down Short Smooth')} 2 – 100 to 0 % `,
    `76) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownLongSharp', 'Transition Ramp Down Long Sharp')} 1 – 100 to 0 % `,
    `77) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownLongSharp', 'Transition Ramp Down Long Sharp')} 2 – 100 to 0 % `,
    `78) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownMediumSharp', 'Transition Ramp Down Medium Sharp')} 1 – 100 to 0 % `,
    `79) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownMediumSharp', 'Transition Ramp Down Medium Sharp')} 2 – 100 to 0 % `,
    `80) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownShortSharp', 'Transition Ramp Down Short Sharp')} 1 – 100 to 0 % `,
    `81) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownShortSharp', 'Transition Ramp Down Short Sharp')} 2 – 100 to 0 % `,
    `82) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpLongSmooth', 'Transition Ramp Up Long Smooth')} 1 – 0 to 100 % `,
    `83) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpLongSmooth', 'Transition Ramp Up Long Smooth')} 2 – 0 to 100 % `,
    `84) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpMediumSmooth', 'Transition Ramp Up Medium Smooth')} 1 – 0 to 100 % `,
    `85) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpMediumSmooth', 'Transition Ramp Up Medium Smooth')} 2 – 0 to 100 % `,
    `86) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpShortSmooth', 'Transition Ramp Up Short Smooth')} 1 – 0 to 100 % `,
    `87) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpShortSmooth', 'Transition Ramp Up Short Smooth')} 2 – 0 to 100 % `,
    `88) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpLongSharp', 'Transition Ramp Up Long Sharp')} 1 – 0 to 100 % `,
    `89) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpLongSharp', 'Transition Ramp Up Long Sharp')} 2 – 0 to 100 % `,
    `90) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpMediumSharp', 'Transition Ramp Up Medium Sharp')} 1 – 0 to 100 % `,
    `91) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpMediumSharp', 'Transition Ramp Up Medium Sharp')} 2 – 0 to 100 % `,
    `92) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpShortSharp', 'Transition Ramp Up Short Sharp')} 1 – 0 to 100 % `,
    `93) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpShortSharp', 'Transition Ramp Up Short Sharp')} 2 – 0 to 100 % `,
    `94) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownLongSmooth', 'Transition Ramp Down Long Smooth')} 1 – 50 to 0 % `,
    `95) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownLongSmooth', 'Transition Ramp Down Long Smooth')} 2 – 50 to 0 % `,
    `96) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownMediumSmooth', 'Transition Ramp Down Medium Smooth')} 1 – 50 to 0 % `,
    `97) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownMediumSmooth', 'Transition Ramp Down Medium Smooth')} 2 – 50 to 0 % `,
    `98) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownShortSmooth', 'Transition Ramp Down Short Smooth')} 1 – 50 to 0 % `,
    `99) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownShortSmooth', 'Transition Ramp Down Short Smooth')} 2 – 50 to 0 % `,
    `100) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownLongSharp', 'Transition Ramp Down Long Sharp')} 1 – 50 to 0 % `,
    `101) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownLongSharp', 'Transition Ramp Down Long Sharp')} 2 – 50 to 0 % `,
    `102) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownMediumSharp', 'Transition Ramp Down Medium Sharp')} 1 – 50 to 0 % `,
    `103) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownMediumSharp', 'Transition Ramp Down Medium Sharp')} 2 – 50 to 0 % `,
    `104) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownShortSharp', 'Transition Ramp Down Short Sharp')} 1 – 50 to 0 % `,
    `105) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampDownShortSharp', 'Transition Ramp Down Short Sharp')} 2 – 50 to 0 % `,
    `106) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpLongSmooth', 'Transition Ramp Up Long Smooth')} 1 – 0 to 50 % `,
    `107) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpLongSmooth', 'Transition Ramp Up Long Smooth')} 2 – 0 to 50 % `,
    `108) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpMediumSmooth', 'Transition Ramp Up Medium Smooth')} 1 – 0 to 50 % `,
    `109) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpMediumSmooth', 'Transition Ramp Up Medium Smooth')} 2 – 0 to 50 % `,
    `110) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpShortSmooth', 'Transition Ramp Up Short Smooth')} 1 – 0 to 50 % `,
    `111) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpShortSmooth', 'Transition Ramp Up Short Smooth')} 2 – 0 to 50 % `,
    `112) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpLongSharp', 'Transition Ramp Up Long Sharp')} 1 – 0 to 50 % `,
    `113) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpLongSharp', 'Transition Ramp Up Long Sharp')} 2 – 0 to 50 % `,
    `114) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpMediumSharp', 'Transition Ramp Up Medium Sharp')} 1 – 0 to 50 % `,
    `115) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpMediumSharp', 'Transition Ramp Up Medium Sharp')} 2 – 0 to 50 % `,
    `116) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpShortSharp', 'Transition Ramp Up Short Sharp')} 1 – 0 to 50 % `,
    `117) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/transitionRampUpShortSharp', 'Transition Ramp Up Short Sharp')} 2 – 0 to 50 % `,
    `118) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/longBuzzForProgrammaticStopping', 'Long buzz for programmatic stopping')} – 100 % `,
    `119) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 1)} – 50 % `,
    `120) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 2)} – 40 % `,
    `121) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 3)} – 30 % `,
    `122) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 4)} – 20 % `,
    `123) ${nls.localize('vueport/debug/panels/rumblePack/effects/names/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 5)} – 10 % `,
        ];
    }
    return effectNames;
}

export interface RumbleEffectShape {
    amplitude: number; // 0 to 1, as the name's percentage says; where a ramp starts
    rampTo?: number; // where a ramp ends, only a ramp has one
    // measured, in milliseconds. Absent only for 118, "Long buzz for programmatic stopping", which runs until a Stop
    // (the measurement hit its three-second cap)
    ms?: number;
}

const fixed = (amplitude: number, ms: number): RumbleEffectShape => ({ amplitude, ms });
const ramp = (from: number, to: number, ms: number): RumbleEffectShape =>
    ({ amplitude: from, rampTo: to, ms });
const untilStopped = (amplitude: number): RumbleEffectShape => ({ amplitude });

/**
 * The 123 effects as shapes rather than words, in step with `builtInRumbleEffects` entry for entry: the comments carry
 * the same numbers and family names, and `rumble-effects-probe` reads the English names and fails if the two ever
 * disagree about an amplitude. Written out rather than derived from the names at run time, as those names are
 * translated.
 */
export const RUMBLE_EFFECT_SHAPES: readonly RumbleEffectShape[] = [
    // 1–3 Strong Click
    fixed(1, 91), fixed(0.6, 96), fixed(0.3, 88),
    // 4–6 Sharp Click
    fixed(1, 72), fixed(0.6, 85), fixed(0.3, 75),
    // 7–9 Soft Bump
    fixed(1, 123), fixed(0.6, 117), fixed(0.3, 117),
    // 10–11 Double Click
    fixed(1, 213), fixed(0.6, 203),
    // 12 Triple Click
    fixed(1, 264),
    // 13 Soft Fuzz
    fixed(0.6, 232),
    // 14 Strong Buzz
    fixed(1, 235),
    // 15 750 ms Alert
    fixed(1, 789),
    // 16 1000 ms Alert
    fixed(1, 1037),
    // 17–20 Strong Click
    fixed(1, 117), fixed(0.8, 115), fixed(0.6, 120), fixed(0.3, 120),
    // 21–23 Medium Click
    fixed(1, 109), fixed(0.8, 115), fixed(0.6, 107),
    // 24–26 Sharp Tick
    fixed(1, 69), fixed(0.8, 72), fixed(0.6, 69),
    // 27–30 Short Double Click Strong
    fixed(1, 149), fixed(0.8, 147), fixed(0.6, 152), fixed(0.3, 147),
    // 31–33 Short Double Click Medium
    fixed(1, 152), fixed(0.8, 165), fixed(0.6, 157),
    // 34–36 Short Double Sharp Tick
    fixed(1, 144), fixed(0.8, 152), fixed(0.6, 149),
    // 37–40 Long Double Sharp Click Strong
    fixed(1, 184), fixed(0.8, 189), fixed(0.6, 197), fixed(0.3, 192),
    // 41–43 Long Double Sharp Click Medium
    fixed(1, 179), fixed(0.8, 165), fixed(0.6, 179),
    // 44–46 Long Double Sharp Tick
    fixed(1, 197), fixed(0.8, 211), fixed(0.6, 197),
    // 47–51 Buzz
    fixed(1, 285), fixed(0.8, 288), fixed(0.6, 285), fixed(0.4, 283), fixed(0.2, 285),
    // 52–53 Pulsing Strong
    fixed(1, 349), fixed(0.6, 347),
    // 54–55 Pulsing Medium
    fixed(1, 211), fixed(0.6, 213),
    // 56–57 Pulsing Sharp
    fixed(1, 168), fixed(0.6, 160),
    // 58–63 Transition Click
    fixed(1, 533), fixed(0.8, 528), fixed(0.6, 528), fixed(0.4, 528), fixed(0.2, 539), fixed(0.1, 533),
    // 64–69 Transition Hum
    fixed(1, 512), fixed(0.8, 517), fixed(0.6, 515), fixed(0.4, 520), fixed(0.2, 517), fixed(0.1, 515),
    // 70–71 Transition Ramp Down Long Smooth
    ramp(1, 0, 323), ramp(1, 0, 517),
    // 72–73 Transition Ramp Down Medium Smooth
    ramp(1, 0, 323), ramp(1, 0, 517),
    // 74–75 Transition Ramp Down Short Smooth
    ramp(1, 0, 317), ramp(1, 0, 384),
    // 76–77 Transition Ramp Down Long Sharp
    ramp(1, 0, 299), ramp(1, 0, 320),
    // 78–79 Transition Ramp Down Medium Sharp
    ramp(1, 0, 304), ramp(1, 0, 325),
    // 80–81 Transition Ramp Down Short Sharp
    ramp(1, 0, 301), ramp(1, 0, 325),
    // 82–83 Transition Ramp Up Long Smooth
    ramp(0, 1, 227), ramp(0, 1, 475),
    // 84–85 Transition Ramp Up Medium Smooth
    ramp(0, 1, 237), ramp(0, 1, 421),
    // 86–87 Transition Ramp Up Short Smooth
    ramp(0, 1, 253), ramp(0, 1, 384),
    // 88–89 Transition Ramp Up Long Sharp
    ramp(0, 1, 317), ramp(0, 1, 560),
    // 90–91 Transition Ramp Up Medium Sharp
    ramp(0, 1, 315), ramp(0, 1, 504),
    // 92–93 Transition Ramp Up Short Sharp
    ramp(0, 1, 315), ramp(0, 1, 440),
    // 94–95 Transition Ramp Down Long Smooth
    ramp(0.5, 0, 315), ramp(0.5, 0, 488),
    // 96–97 Transition Ramp Down Medium Smooth
    ramp(0.5, 0, 309), ramp(0.5, 0, 475),
    // 98–99 Transition Ramp Down Short Smooth
    ramp(0.5, 0, 299), ramp(0.5, 0, 336),
    // 100–101 Transition Ramp Down Long Sharp
    ramp(0.5, 0, 304), ramp(0.5, 0, 320),
    // 102–103 Transition Ramp Down Medium Sharp
    ramp(0.5, 0, 307), ramp(0.5, 0, 320),
    // 104–105 Transition Ramp Down Short Sharp
    ramp(0.5, 0, 307), ramp(0.5, 0, 320),
    // 106–107 Transition Ramp Up Long Smooth
    ramp(0, 0.5, 216), ramp(0, 0.5, 443),
    // 108–109 Transition Ramp Up Medium Smooth
    ramp(0, 0.5, 224), ramp(0, 0.5, 381),
    // 110–111 Transition Ramp Up Short Smooth
    ramp(0, 0.5, 243), ramp(0, 0.5, 347),
    // 112–113 Transition Ramp Up Long Sharp
    ramp(0, 0.5, 320), ramp(0, 0.5, 563),
    // 114–115 Transition Ramp Up Medium Sharp
    ramp(0, 0.5, 317), ramp(0, 0.5, 509),
    // 116–117 Transition Ramp Up Short Sharp
    ramp(0, 0.5, 317), ramp(0, 0.5, 443),
    // 118 Long buzz for programmatic stopping
    untilStopped(1),
    // 119–123 Smooth Hum
    fixed(0.5, 515), fixed(0.4, 512), fixed(0.3, 504), fixed(0.2, 501), fixed(0.1, 549),
];

// undefined for a number the pack does not have
export function rumbleEffectShape(effect: number | undefined): RumbleEffectShape | undefined {
    return effect === undefined ? undefined : RUMBLE_EFFECT_SHAPES[effect - 1];
}

// its measured length, or the ceiling for the effect that runs until stopped and a Play whose effect was never chosen
export function rumbleEffectMs(shape: RumbleEffectShape | undefined): number {
    return shape?.ms ?? RUMBLE_EFFECT_MAX_MS;
}

// `progress` runs 0 to 1 over the effect; a ramp is read off the line between its ends. Shared, so a pad's motors and
// the panel's box never disagree about what the game asked for
export function rumbleEffectAmplitudeAt(
    shape: RumbleEffectShape | undefined,
    progress: number,
): number {
    if (shape === undefined) {
        // nothing chosen: full strength is the only honest answer to a Play with no effect behind it
        return 1;
    }
    if (shape.rampTo === undefined) {
        return shape.amplitude;
    }
    const along = Math.min(1, Math.max(0, progress));
    return shape.amplitude + (shape.rampTo - shape.amplitude) * along;
}

export function getRumbleEffectName(effect: number): string {
    return builtInRumbleEffects()[effect - 1]?.trim() ?? `${effect}`;
}

// only what it takes to forward a game's link port traffic to a real pack and show what it asks for, unlike VES's
// service. A host with no pack or no WebSerial can implement it as a permanently disconnected one
export interface VueportRumblePack {
    readonly connected: boolean;
    // false for a page, which can never reach a serial port; tells the panel whether a Detect button is honest.
    // Optional, so older hosts read as ones that can
    readonly canConnect?: boolean;
    readonly deviceName: string | undefined; // when it is one we recognize
    readonly deviceIds: { vendor?: number, product?: number } | undefined;
    readonly onDidChangeConnected: Event<void>;
    detect(): Promise<void>; // asks the user to pick a port, and opens it

    forwarding: boolean;
    // set by the emulator alongside forwarding, so a player missing their rumble learns that a link cable has the one
    // port. Optional, so a host that cannot link machines reads as never cabled
    linkPortInUse?: boolean;
    emulatedSpec: EmulatedRumbleSpec | undefined;
    readonly emulatedCommands: RumbleCommand[];
    readonly emulatedRumbleState: RumbleState;
    readonly emulatedByteCount: number;
    readonly lastReply: string | undefined; // where an unknown command shows up
    // commands dropped because the game asked faster than the wire and board could take them (SerialRumblePack.MAX_QUEUED);
    // tells a misbehaving pack from a game asking too much. Optional, only hosts with hardware can answer
    readonly droppedCommands?: number;
    clearEmulatedTraffic(): void;
    sendByte(byte: number): Promise<void>;
    // silences the motor when forwarding is taken away mid-effect (a cable goes in, the game closes), as the game's Stop
    // will no longer be carried and the pack would buzz until unplugged. Outside the forwarded stream, so it is not counted
    // or decoded into the panel's traffic. Optional: a host that cannot take the port away has nothing to stop
    stop?(): Promise<void>;
}

export const NO_RUMBLE_PACK: VueportRumblePack = {
    connected: false,
    canConnect: false,
    deviceName: undefined,
    deviceIds: undefined,
    onDidChangeConnected: () => Disposable.NULL,
    detect: async () => { },
    forwarding: false,
    linkPortInUse: false,
    emulatedSpec: undefined,
    emulatedCommands: [],
    emulatedRumbleState: {},
    emulatedByteCount: 0,
    lastReply: undefined,
    clearEmulatedTraffic: () => { },
    sendByte: async () => { },
    stop: async () => { },
};

const HISTORY_LENGTH = 16; // how much of the game's traffic the panel keeps, matching the studio's

// decoding the link port traffic into effects needs only the protocol; hosts add the device by overriding forward()
// and the getters. Used directly by hosts without a pack: the readings are about what the game asks for either way
export class DecodingRumblePack implements VueportRumblePack {

    protected readonly onDidChangeConnectedEmitter = new Emitter<void>();
    readonly onDidChangeConnected: Event<void> = this.onDidChangeConnectedEmitter.event;

    protected readonly decoder = new RumbleStreamDecoder();
    protected commands: RumbleCommand[] = [];
    protected bytes = 0;

    forwarding = false;
    linkPortInUse = false;
    emulatedSpec: EmulatedRumbleSpec | undefined;

    get canConnect(): boolean {
        return false;
    }

    get connected(): boolean {
        return false;
    }

    get deviceName(): string | undefined {
        return undefined;
    }

    get deviceIds(): { vendor?: number, product?: number } | undefined {
        return undefined;
    }

    get lastReply(): string | undefined {
        return undefined;
    }

    get emulatedCommands(): RumbleCommand[] {
        return this.commands;
    }

    get emulatedRumbleState(): RumbleState {
        return this.decoder.state;
    }

    get emulatedByteCount(): number {
        return this.bytes;
    }

    get droppedCommands(): number {
        return 0;
    }

    async detect(): Promise<void> { }

    clearEmulatedTraffic(): void {
        this.commands = [];
        this.bytes = 0;
        this.decoder.reset();
        this.onDidChangeConnectedEmitter.fire();
    }

    // decoded first and handed on second, so the panel shows the same either way. Every byte fires the change event,
    // as the panel polls only once a second; affordable, as an effect is a handful of bytes
    async sendByte(byte: number): Promise<void> {
        this.bytes++;
        const command = this.decoder.push(byte);
        if (command) {
            this.commands.push(command);
            if (this.commands.length > HISTORY_LENGTH) {
                this.commands.shift();
            }
        }
        this.onDidChangeConnectedEmitter.fire();
        await this.forward(byte);
    }

    protected async forward(_byte: number): Promise<void> { }
}

export interface RumblePackDevice {
    name: string;
    vendor: number;
    product: number;
}

// must match the studio's table (ves-rumble-pack-types.ts) and the desktop shell's (rumble.rs). The final board
// reports itself as an Arduino Leonardo, which it is built on
export const RUMBLE_PACK_IDS: readonly RumblePackDevice[] = [
    { name: 'Final', vendor: 0x2341, product: 0x8036 },
    { name: 'Prototype', vendor: 0x9999, product: 0x9999 },
];

export function rumblePackName(vendor?: number, product?: number): string | undefined {
    return RUMBLE_PACK_IDS.find(id => id.vendor === vendor && id.product === product)?.name;
}

// everything above the transport: the board, its text protocol and its replies. Hosts implement write() and call
// attached(); kept in one place so the `<VB nnn>` a packaged build and a browser send stay the same (see send)
export abstract class SerialRumblePack extends DecodingRumblePack {

    /**
     * In ms. The board is an ATmega32u4 with a 64-byte serial buffer, and every command becomes an I2C transaction with
     * the motor driver, so it drains far slower than a 115200-baud line fills it. Beyond eight commands back to back
     * the overflow lands mid-command, the parser waits for an eaten `>`, and the pack takes nothing until power-cycled.
     * Two hundred commands a second is far more than any game asks for (an effect is four or five).
     */
    protected static readonly WRITE_GAP_MS = 5;

    protected static readonly MAX_QUEUED = 32; // a bound rather than a growing queue, as late haptics are not haptics

    protected current: RumblePackDevice | undefined;
    protected reply: string | undefined;
    protected replyBuffer = ''; // bytes the pack has sent that have not yet ended in a newline
    protected queue: string[] = [];
    protected draining: Promise<void> | undefined; // keeps writes one at a time
    protected dropped = 0;

    override get droppedCommands(): number {
        return this.dropped;
    }

    override get connected(): boolean {
        return this.current !== undefined;
    }

    override get deviceName(): string | undefined {
        return this.current?.name;
    }

    override get deviceIds(): { vendor?: number, product?: number } | undefined {
        return this.current && { vendor: this.current.vendor, product: this.current.product };
    }

    override get lastReply(): string | undefined {
        return this.reply;
    }

    // exactly as given; the framing is send's
    protected abstract write(text: string): Promise<void>;

    /**
     * Angle brackets and no newline, the firmware's own framing, as VES drives the hardware
     * (ves-rumble-pack-service.ts): a newline-terminated `VB 124` is no command at all, and the pack sits perfectly
     * still (see the `<VB nnn>` check in rumble-panel-probe). Queued, returning at once, as the caller is the
     * emulator's link port callback and holding it up would hold up the game.
     */
    protected async send(command: string): Promise<void> {
        if (this.queue.length >= SerialRumblePack.MAX_QUEUED) {
            // the oldest, as it is the one least worth playing now
            this.queue.shift();
            this.dropped++;
        }
        this.queue.push(`<${command}>`);
        this.startDraining();
    }

    // one at a time, no faster than WRITE_GAP_MS. The desktop shell writes through Tauri commands that take the port's
    // lock in any order, so unawaited writes could swap a frequency and an effect number; a single drain keeps the
    // game's order on every transport
    protected startDraining(): void {
        this.draining ??= this.drain().finally(() => {
            this.draining = undefined;
        });
    }

    protected async drain(): Promise<void> {
        while (this.queue.length > 0 && this.current) {
            await this.write(this.queue.shift()!);
            if (this.queue.length > 0 && this.current) {
                await new Promise(resolve => {
                    setTimeout(resolve, SerialRumblePack.WRITE_GAP_MS);
                });
            }
        }
        if (!this.current) {
            // nothing to write to; what is left was for a pack that has gone
            this.queue.length = 0;
        }
    }

    // called once at start-up; unlike detect it may not ask the user anything
    abstract start(): Promise<void>;

    // called by a host once a port is open and answering
    protected attached(device: RumblePackDevice): void {
        this.queue.length = 0;
        this.dropped = 0;
        this.current = device;
        this.onDidChangeConnectedEmitter.fire();
    }

    // called by a host when the port closes, whoever closed it
    protected detached(): void {
        if (!this.current) {
            return;
        }
        this.current = undefined;
        this.replyBuffer = '';
        this.queue.length = 0;
        this.onDidChangeConnectedEmitter.fire();
    }

    // kept as whole newline-terminated lines, half a line is not worth showing anyone
    protected receive(text: string): void {
        this.replyBuffer += text;
        const lines = this.replyBuffer.split(/\r?\n/);
        this.replyBuffer = lines.pop() ?? '';
        let said = false;
        for (const line of lines) {
            if (line.trim().length > 0) {
                this.reply = line.trim();
                said = true;
            }
        }
        if (said) {
            this.onDidChangeConnectedEmitter.fire();
        }
    }

    // relayed as the pack's own `<VB nnn>`
    protected override async forward(byte: number): Promise<void> {
        if (!this.current) {
            return;
        }
        await this.send(`VB ${byte.toString().padStart(3, '0')}`);
    }

    // STP rather than a forwarded `VB 000`, as the emulator commands the device here and the panel's traffic should stay
    // the game's own. Silent with no pack attached
    async stop(): Promise<void> {
        if (!this.current) {
            return;
        }
        // ahead of whatever is waiting and instead of it, as playing out a game nobody listens to any more would keep the
        // motor running on
        this.queue.length = 0;
        await this.send('STP');
    }
}

// the same protocol VUEngine Studio speaks to the real hardware; the numbers are the device's
export const RUMBLE_CMD = {
    STOP: 0x00,
    MIN_EFFECT: 0x01,
    MAX_EFFECT: 0x7b,
    PLAY: 0x7c,
    CHAIN_EFFECT_0: 0x80,
    CHAIN_EFFECT_4: 0x84,
    OVERDRIVE: 0xa0,
    SUSTAIN_POS: 0xa1,
    SUSTAIN_NEG: 0xa2,
    BREAK: 0xa3,
    WRITE_EFFECT_CHAIN: 0xb0,
    WRITE_EFFECT_LOOPS_CHAIN: 0xb1,
    EFFECT_CHAIN_END: 0xff,
} as const;

// the bytes that select a vibration frequency, and the frequency each means
export const RUMBLE_CMD_FREQUENCIES: Record<number, number> = {
    0x87: 50,
    0x88: 95,
    0x89: 130,
    0x90: 160,
    0x91: 240,
    0x92: 320,
    0x93: 400,
};

// the commands whose meaning is completed by the byte after them
function valueCommands(): Record<number, string> {
    return {
        [RUMBLE_CMD.OVERDRIVE]: nls.localize('vueport/debug/panels/rumblePack/effects/overdrive', 'Overdrive'),
        [RUMBLE_CMD.SUSTAIN_POS]: nls.localize('vueport/debug/panels/rumblePack/effects/sustainPos', 'Sustain (Pos.)'),
        [RUMBLE_CMD.SUSTAIN_NEG]: nls.localize('vueport/debug/panels/rumblePack/effects/sustainNeg', 'Sustain (Neg.)'),
        [RUMBLE_CMD.BREAK]: nls.localize('vueport/debug/panels/rumblePack/effects/break', 'Break'),
    };
}

// stateful like the protocol: four commands take their value from the next byte, the rest accumulate into one effect
// configuration that the pack plays when told to
export class RumbleStreamDecoder {

    protected pending: number | undefined;

    state: RumbleState = {};

    reset(): void {
        this.pending = undefined;
        this.state = {};
    }

    // returns the command the byte completed, if any. The time is stamped here, as close to when the game sent it as
    // this side can see
    push(byte: number): RumbleCommand | undefined {
        const at = Date.now();
        const command = this.decode(byte, at);
        return command && { ...command, at };
    }

    // `at` is the reading push took, so a Play is stamped by that one
    protected decode(byte: number, at: number): Omit<RumbleCommand, 'at'> | undefined {
        if (this.pending !== undefined) {
            const command = this.pending;
            this.pending = undefined;
            return this.applyValue(command, byte);
        }

        if (valueCommands()[byte] !== undefined) {
            this.pending = byte;
            return undefined;
        }

        if (byte === RUMBLE_CMD.STOP) {
            this.state.playing = false;
            this.state.playingSince = undefined;
            return { bytes: [byte], label: nls.localize('vueport/debug/panels/rumblePack/effects/stop', 'Stop') };
        }

        if (byte === RUMBLE_CMD.PLAY) {
            this.state.playing = true;
            // restamped and counted on every Play, including one during a running effect: replaying it starts it again
            this.state.playingSince = at;
            this.state.plays = (this.state.plays ?? 0) + 1;
            return { bytes: [byte], label: nls.localize('vueport/debug/panels/rumblePack/effects/play', 'Play') };
        }

        if (byte >= RUMBLE_CMD.MIN_EFFECT && byte <= RUMBLE_CMD.MAX_EFFECT) {
            this.state.effect = byte;
            return {
                bytes: [byte],
                label: `${nls.localize('vueport/debug/panels/rumblePack/effects/effect', 'Effect')}: ${getRumbleEffectName(byte)}`,
            };
        }

        const frequency = RUMBLE_CMD_FREQUENCIES[byte];
        if (frequency !== undefined) {
            this.state.frequency = frequency;
            return {
                bytes: [byte],
                label: `${nls.localize('vueport/debug/panels/rumblePack/effects/frequency', 'Frequency')}: ${frequency} Hz`,
            };
        }

        if (byte >= RUMBLE_CMD.CHAIN_EFFECT_0 && byte <= RUMBLE_CMD.CHAIN_EFFECT_4) {
            this.state.chain = byte - RUMBLE_CMD.CHAIN_EFFECT_0;
            return {
                bytes: [byte],
                label: nls.localize('vueport/debug/panels/rumblePack/effects/chainEffect', 'Chain Effect {0}', this.state.chain),
            };
        }

        if (byte === RUMBLE_CMD.WRITE_EFFECT_CHAIN || byte === RUMBLE_CMD.WRITE_EFFECT_LOOPS_CHAIN) {
            return {
                bytes: [byte],
                label: nls.localize('vueport/debug/panels/rumblePack/effects/writeEffectChain', 'Write Effect Chain'),
            };
        }

        if (byte === RUMBLE_CMD.EFFECT_CHAIN_END) {
            return {
                bytes: [byte],
                label: nls.localize('vueport/debug/panels/rumblePack/effects/effectChainEnd', 'End of Effect Chain'),
            };
        }

        return {
            bytes: [byte],
            label: nls.localize('vueport/debug/panels/rumblePack/effects/unknownCommand', 'Unknown command'),
            unknown: true,
        };
    }

    // none of the four settings lands in RumbleState, as current packs and the engine no longer use them; older ROMs still
    // send them, and reading the value byte as one command would log effect 126 instead of `Overdrive: 126`
    protected applyValue(command: number, value: number): Omit<RumbleCommand, 'at'> {
        return { bytes: [command, value], label: `${valueCommands()[command]}: ${value}` };
    }
}
