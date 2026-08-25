/**
 * The rumble pack, as the emulator sees it.
 *
 * A copy of the parts of VES's rumble pack support that the emulator
 * needs — the protocol's shapes and its effect names — so that nothing under
 * `emulator/` reaches into `rumble-pack/`. VES keeps its own copy for
 * flashing firmware and for the effect editor; the two are expected to drift
 * apart rather than be kept in step, since one describes a device the emulator
 * pretends to be and the other drives a real one.
 */

import { Disposable, Event } from './emulator-events';
import { nls } from './emulator-nls';

/** One decoded command from the byte stream a game sends. */
export interface RumbleCommand {
    bytes: number[];
    label: string;
    /** True for a byte that means nothing in this protocol. */
    unknown?: boolean;
}

/** What the game has asked the pack to be doing. */
export interface RumbleState {
    effect?: number;
    frequency?: number;
    overdrive?: number;
    sustainPositive?: number;
    sustainNegative?: number;
    breaking?: number;
    playing?: boolean;
    chain?: number;
}

/** The address a game's rumble effect spec was found at. */
export interface EmulatedRumbleSpec {
    address: number;
    /** Only set when a symbol covers the address. */
    name?: string;
}

/**
 * The pack's 123 built-in effects, by name.
 *
 * Built on first use rather than at import, because the host installs its
 * localization during start-up and a table built while this module loaded would
 * be English for the life of the process. Cached afterwards: changing language
 * needs a reload either way.
 */
let effectNames: string[] | undefined;

export function builtInRumbleEffects(): string[] {
    if (!effectNames) {
        effectNames = [
    `1) ${nls.localize('vueport/rumbleEffect/effects/strongClick', 'Strong Click')} - 100 %`,
    `2) ${nls.localize('vueport/rumbleEffect/effects/strongClick', 'Strong Click')} - 60 % `,
    `3) ${nls.localize('vueport/rumbleEffect/effects/strongClick', 'Strong Click')} - 30 % `,
    `4) ${nls.localize('vueport/rumbleEffect/effects/sharpClick', 'Sharp Click')} - 100 % `,
    `5) ${nls.localize('vueport/rumbleEffect/effects/sharpClick', 'Sharp Click')} - 60 % `,
    `6) ${nls.localize('vueport/rumbleEffect/effects/sharpClick', 'Sharp Click')} - 30 % `,
    `7) ${nls.localize('vueport/rumbleEffect/effects/softBump', 'Soft Bump')} - 100 % `,
    `8) ${nls.localize('vueport/rumbleEffect/effects/softBump', 'Soft Bump')} - 60 % `,
    `9) ${nls.localize('vueport/rumbleEffect/effects/softBump', 'Soft Bump')} - 30 % `,
    `10) ${nls.localize('vueport/rumbleEffect/effects/doubleClick', 'Double Click')} - 100 % `,
    `11) ${nls.localize('vueport/rumbleEffect/effects/doubleClick', 'Double Click')} - 60 % `,
    `12) ${nls.localize('vueport/rumbleEffect/effects/tripleClick', 'Triple Click')} - 100 % `,
    `13) ${nls.localize('vueport/rumbleEffect/effects/softFuzz', 'Soft Fuzz')} - 60 % `,
    `14) ${nls.localize('vueport/rumbleEffect/effects/strongBuzz', 'Strong Buzz')} - 100 % `,
    `15) ${nls.localize('vueport/rumbleEffect/effects/750MsAlert', '750 ms Alert')} 100 % `,
    `16) ${nls.localize('vueport/rumbleEffect/effects/1000MsAlert', '1000 ms Alert')} 100 % `,
    `17) ${nls.localize('vueport/rumbleEffect/effects/strongClick', 'Strong Click')} 1 - 100 % `,
    `18) ${nls.localize('vueport/rumbleEffect/effects/strongClick', 'Strong Click')} 2 - 80 % `,
    `19) ${nls.localize('vueport/rumbleEffect/effects/strongClick', 'Strong Click')} 3 - 60 % `,
    `20) ${nls.localize('vueport/rumbleEffect/effects/strongClick', 'Strong Click')} 4 - 30 % `,
    `21) ${nls.localize('vueport/rumbleEffect/effects/mediumClick', 'Medium Click')} 1 - 100 % `,
    `22) ${nls.localize('vueport/rumbleEffect/effects/mediumClick', 'Medium Click')} 2 - 80 % `,
    `23) ${nls.localize('vueport/rumbleEffect/effects/mediumClick', 'Medium Click')} 3 - 60 % `,
    `24) ${nls.localize('vueport/rumbleEffect/effects/sharpTick', 'Sharp Tick')} 1 - 100 % `,
    `25) ${nls.localize('vueport/rumbleEffect/effects/sharpTick', 'Sharp Tick')} 2 - 80 % `,
    `26) ${nls.localize('vueport/rumbleEffect/effects/sharpTick', 'Sharp Tick')} 3 – 60 % `,
    `27) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleClickStrong', 'Short Double Click Strong')} 1 – 100 % `,
    `28) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleClickStrong', 'Short Double Click Strong')} 2 – 80 % `,
    `29) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleClickStrong', 'Short Double Click Strong')} 3 – 60 % `,
    `30) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleClickStrong', 'Short Double Click Strong')} 4 – 30 % `,
    `31) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleClickMedium', 'Short Double Click Medium')} 1 – 100 % `,
    `32) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleClickMedium', 'Short Double Click Medium')} 2 – 80 % `,
    `33) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleClickMedium', 'Short Double Click Medium')} 3 – 60 % `,
    `34) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleSharpTick', 'Short Double Sharp Tick')} 1 – 100 % `,
    `35) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleSharpTick', 'Short Double Sharp Tick')} 2 – 80 % `,
    `36) ${nls.localize('vueport/rumbleEffect/effects/shortDoubleSharpTick', 'Short Double Sharp Tick')} 3 – 60 % `,
    `37) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpClickStrong', 'Long Double Sharp Click Strong')} 1 – 100 % `,
    `38) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpClickStrong', 'Long Double Sharp Click Strong')} 2 – 80 % `,
    `39) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpClickStrong', 'Long Double Sharp Click Strong')} 3 – 60 % `,
    `40) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpClickStrong', 'Long Double Sharp Click Strong')} 4 – 30 % `,
    `41) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpClickMedium', 'Long Double Sharp Click Medium')} 1 – 100 % `,
    `42) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpClickMedium', 'Long Double Sharp Click Medium')} 2 – 80 % `,
    `43) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpClickMedium', 'Long Double Sharp Click Medium')} 3 – 60 % `,
    `44) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpTick', 'Long Double Sharp Tick')} 1 – 100 % `,
    `45) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpTick', 'Long Double Sharp Tick')} 2 – 80 % `,
    `46) ${nls.localize('vueport/rumbleEffect/effects/longDoubleSharpTick', 'Long Double Sharp Tick')} 3 – 60 % `,
    `47) ${nls.localize('vueport/rumbleEffect/effects/buzz', 'Buzz')} 1 – 100 % `,
    `48) ${nls.localize('vueport/rumbleEffect/effects/buzz', 'Buzz')} 2 – 80 % `,
    `49) ${nls.localize('vueport/rumbleEffect/effects/buzz', 'Buzz')} 3 – 60 % `,
    `50) ${nls.localize('vueport/rumbleEffect/effects/buzz', 'Buzz')} 4 – 40 % `,
    `51) ${nls.localize('vueport/rumbleEffect/effects/buzz', 'Buzz')} 5 – 20 % `,
    `52) ${nls.localize('vueport/rumbleEffect/effects/pulsingStrong', 'Pulsing Strong')} 1 – 100 % `,
    `53) ${nls.localize('vueport/rumbleEffect/effects/pulsingStrong', 'Pulsing Strong')} 2 – 60 % `,
    `54) ${nls.localize('vueport/rumbleEffect/effects/pulsingMedium', 'Pulsing Medium')} 1 – 100 % `,
    `55) ${nls.localize('vueport/rumbleEffect/effects/pulsingMedium', 'Pulsing Medium')} 2 – 60 % `,
    `56) ${nls.localize('vueport/rumbleEffect/effects/pulsingSharp', 'Pulsing Sharp')} 1 – 100 % `,
    `57) ${nls.localize('vueport/rumbleEffect/effects/pulsingSharp', 'Pulsing Sharp')} 2 – 60 % `,
    `58) ${nls.localize('vueport/rumbleEffect/effects/transitionClick', 'Transition Click')} 1 – 100 % `,
    `59) ${nls.localize('vueport/rumbleEffect/effects/transitionClick', 'Transition Click')} 2 – 80 % `,
    `60) ${nls.localize('vueport/rumbleEffect/effects/transitionClick', 'Transition Click')} 3 – 60 % `,
    `61) ${nls.localize('vueport/rumbleEffect/effects/transitionClick', 'Transition Click')} 4 – 40 % `,
    `62) ${nls.localize('vueport/rumbleEffect/effects/transitionClick', 'Transition Click')} 5 – 20 % `,
    `63) ${nls.localize('vueport/rumbleEffect/effects/transitionClick', 'Transition Click')} 6 – 10 % `,
    `64) ${nls.localize('vueport/rumbleEffect/effects/transitionHum', 'Transition Hum')} 1 – 100 % `,
    `65) ${nls.localize('vueport/rumbleEffect/effects/transitionHum', 'Transition Hum')} 2 – 80 % `,
    `66) ${nls.localize('vueport/rumbleEffect/effects/transitionHum', 'Transition Hum')} 3 – 60 % `,
    `67) ${nls.localize('vueport/rumbleEffect/effects/transitionHum', 'Transition Hum')} 4 – 40 % `,
    `68) ${nls.localize('vueport/rumbleEffect/effects/transitionHum', 'Transition Hum')} 5 – 20 % `,
    `69) ${nls.localize('vueport/rumbleEffect/effects/transitionHum', 'Transition Hum')} 6 – 10 % `,
    `70) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownLongSmooth', 'Transition Ramp Down Long Smooth')} 1 – 100 to 0 % `,
    `71) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownLongSmooth', 'Transition Ramp Down Long Smooth')} 2 – 100 to 0 % `,
    `72) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownMediumSmooth', 'Transition Ramp Down Medium Smooth')} 1 – 100 to 0 % `,
    `73) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownMediumSmooth', 'Transition Ramp Down Medium Smooth')} 2 – 100 to 0 % `,
    `74) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownShortSmooth', 'Transition Ramp Down Short Smooth')} 1 – 100 to 0 % `,
    `75) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownShortSmooth', 'Transition Ramp Down Short Smooth')} 2 – 100 to 0 % `,
    `76) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownLongSharp', 'Transition Ramp Down Long Sharp')} 1 – 100 to 0 % `,
    `77) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownLongSharp', 'Transition Ramp Down Long Sharp')} 2 – 100 to 0 % `,
    `78) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownMediumSharp', 'Transition Ramp Down Medium Sharp')} 1 – 100 to 0 % `,
    `79) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownMediumSharp', 'Transition Ramp Down Medium Sharp')} 2 – 100 to 0 % `,
    `80) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownShortSharp', 'Transition Ramp Down Short Sharp')} 1 – 100 to 0 % `,
    `81) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownShortSharp', 'Transition Ramp Down Short Sharp')} 2 – 100 to 0 % `,
    `82) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpLongSmooth', 'Transition Ramp Up Long Smooth')} 1 – 0 to 100 % `,
    `83) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpLongSmooth', 'Transition Ramp Up Long Smooth')} 2 – 0 to 100 % `,
    `84) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpMediumSmooth', 'Transition Ramp Up Medium Smooth')} 1 – 0 to 100 % `,
    `85) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpMediumSmooth', 'Transition Ramp Up Medium Smooth')} 2 – 0 to 100 % `,
    `86) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpShortSmooth', 'Transition Ramp Up Short Smooth')} 1 – 0 to 100 % `,
    `87) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpShortSmooth', 'Transition Ramp Up Short Smooth')} 2 – 0 to 100 % `,
    `88) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpLongSharp', 'Transition Ramp Up Long Sharp')} 1 – 0 to 100 % `,
    `89) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpLongSharp', 'Transition Ramp Up Long Sharp')} 2 – 0 to 100 % `,
    `90) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpMediumSharp', 'Transition Ramp Up Medium Sharp')} 1 – 0 to 100 % `,
    `91) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpMediumSharp', 'Transition Ramp Up Medium Sharp')} 2 – 0 to 100 % `,
    `92) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpShortSharp', 'Transition Ramp Up Short Sharp')} 1 – 0 to 100 % `,
    `93) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpShortSharp', 'Transition Ramp Up Short Sharp')} 2 – 0 to 100 % `,
    `94) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownLongSmooth', 'Transition Ramp Down Long Smooth')} 1 – 50 to 0 % `,
    `95) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownLongSmooth', 'Transition Ramp Down Long Smooth')} 2 – 50 to 0 % `,
    `96) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownMediumSmooth', 'Transition Ramp Down Medium Smooth')} 1 – 50 to 0 % `,
    `97) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownMediumSmooth', 'Transition Ramp Down Medium Smooth')} 2 – 50 to 0 % `,
    `98) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownShortSmooth', 'Transition Ramp Down Short Smooth')} 1 – 50 to 0 % `,
    `99) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownShortSmooth', 'Transition Ramp Down Short Smooth')} 2 – 50 to 0 % `,
    `100) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownLongSharp', 'Transition Ramp Down Long Sharp')} 1 – 50 to 0 % `,
    `101) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownLongSharp', 'Transition Ramp Down Long Sharp')} 2 – 50 to 0 % `,
    `102) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownMediumSharp', 'Transition Ramp Down Medium Sharp')} 1 – 50 to 0 % `,
    `103) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownMediumSharp', 'Transition Ramp Down Medium Sharp')} 2 – 50 to 0 % `,
    `104) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownShortSharp', 'Transition Ramp Down Short Sharp')} 1 – 50 to 0 % `,
    `105) ${nls.localize('vueport/rumbleEffect/effects/transitionRampDownShortSharp', 'Transition Ramp Down Short Sharp')} 2 – 50 to 0 % `,
    `106) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpLongSmooth', 'Transition Ramp Up Long Smooth')} 1 – 0 to 50 % `,
    `107) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpLongSmooth', 'Transition Ramp Up Long Smooth')} 2 – 0 to 50 % `,
    `108) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpMediumSmooth', 'Transition Ramp Up Medium Smooth')} 1 – 0 to 50 % `,
    `109) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpMediumSmooth', 'Transition Ramp Up Medium Smooth')} 2 – 0 to 50 % `,
    `110) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpShortSmooth', 'Transition Ramp Up Short Smooth')} 1 – 0 to 50 % `,
    `111) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpShortSmooth', 'Transition Ramp Up Short Smooth')} 2 – 0 to 50 % `,
    `112) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpLongSharp', 'Transition Ramp Up Long Sharp')} 1 – 0 to 50 % `,
    `113) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpLongSharp', 'Transition Ramp Up Long Sharp')} 2 – 0 to 50 % `,
    `114) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpMediumSharp', 'Transition Ramp Up Medium Sharp')} 1 – 0 to 50 % `,
    `115) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpMediumSharp', 'Transition Ramp Up Medium Sharp')} 2 – 0 to 50 % `,
    `116) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpShortSharp', 'Transition Ramp Up Short Sharp')} 1 – 0 to 50 % `,
    `117) ${nls.localize('vueport/rumbleEffect/effects/transitionRampUpShortSharp', 'Transition Ramp Up Short Sharp')} 2 – 0 to 50 % `,
    `118) ${nls.localize('vueport/rumbleEffect/effects/longBuzzForProgrammaticStopping', 'Long buzz for programmatic stopping')} – 100 % `,
    `119) ${nls.localize('vueport/rumbleEffect/effects/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 1)} – 50 % `,
    `120) ${nls.localize('vueport/rumbleEffect/effects/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 2)} – 40 % `,
    `121) ${nls.localize('vueport/rumbleEffect/effects/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 3)} – 30 % `,
    `122) ${nls.localize('vueport/rumbleEffect/effects/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 4)} – 20 % `,
    `123) ${nls.localize('vueport/rumbleEffect/effects/smoothHum', 'Smooth Hum {0} (No kick or brake pulse)', 5)} – 10 % `,
        ];
    }
    return effectNames;
}

export function getRumbleEffectName(effect: number): string {
    return builtInRumbleEffects()[effect - 1]?.trim() ?? `${effect}`;
}

/**
 * A rumble pack the emulator can drive.
 *
 * Narrower than VES's service, which also flashes firmware and keeps a
 * log widget: this is only what it takes to forward a game's link port traffic
 * to a real pack and to show what it is asking for. A host with no pack — or no
 * WebSerial — can implement this as a permanently disconnected one.
 */
export interface VueportRumblePack {
    readonly connected: boolean;
    /** The device's name, when it is one we recognise. */
    readonly deviceName: string | undefined;
    /** The connected device's USB ids, for the panel to show. */
    readonly deviceIds: { vendor?: number, product?: number } | undefined;
    readonly onDidChangeConnected: Event<void>;
    /** Ask the person to pick a port, and open it. */
    detect(): Promise<void>;

    /** Whether the emulator is forwarding the game's link traffic to it. */
    forwarding: boolean;
    /** The effect spec the running game last started, if it is known. */
    emulatedSpec: EmulatedRumbleSpec | undefined;
    readonly emulatedCommands: RumbleCommand[];
    readonly emulatedRumbleState: RumbleState;
    readonly emulatedByteCount: number;
    /** What the pack itself last said, where an unknown command shows up. */
    readonly lastReply: string | undefined;
    clearEmulatedTraffic(): void;
    sendByte(byte: number): Promise<void>;
}

/** A pack that is never plugged in, for a host that cannot talk to one. */
export const NO_RUMBLE_PACK: VueportRumblePack = {
    connected: false,
    deviceName: undefined,
    deviceIds: undefined,
    onDidChangeConnected: () => Disposable.NULL,
    detect: async () => { },
    forwarding: false,
    emulatedSpec: undefined,
    emulatedCommands: [],
    emulatedRumbleState: {},
    emulatedByteCount: 0,
    lastReply: undefined,
    clearEmulatedTraffic: () => { },
    sendByte: async () => { },
};
