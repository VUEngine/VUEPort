/**
 * The desktop's game pads, read by the shell through SDL, as WebKit's Gamepad API misses pads a browser sees (see
 * src-tauri/src/gamepad.rs), and handed to the page as Gamepad-shaped objects. A snapshot of every pad arrives whenever
 * one changes (gamepads://state). Everything reading pads goes through core's connectedGamepadList and so through
 * setGamepadSource. Each pad says engine: 'sdl', which recorded profiles are matched against, as a raw pad's numbering
 * is SDL's here.
 */
import { setGamepadSource } from 'vueport-core/lib/browser/emulator-gamepad';
import { invoke, listen } from './desktop-bridge';

interface PadSnapshot {
    index: number;
    id: string;
    mapping: string;
    buttons: number[];
    axes: number[];
    rumble: boolean;
}

// how far down an analog button has to go to count as pressed, as in Chrome
const PRESSED = 0.1;

// by slot, sparse like navigator.getGamepads()
let pads: (Gamepad | null)[] = [];

function toGamepad(snapshot: PadSnapshot): Gamepad {
    const { index } = snapshot;
    const vibrationActuator = snapshot.rumble
        ? {
            type: 'dual-rumble',
            effects: ['dual-rumble'],
            playEffect: async (_type: string, params: {
                duration?: number, strongMagnitude?: number, weakMagnitude?: number,
            } = {}) => {
                await invoke('gamepad_rumble', {
                    index,
                    strong: params.strongMagnitude ?? 0,
                    weak: params.weakMagnitude ?? 0,
                    duration: Math.max(0, Math.round(params.duration ?? 0)),
                });
                return 'complete';
            },
            reset: async () => {
                await invoke('gamepad_rumble', { index, strong: 0, weak: 0, duration: 0 });
                return 'complete';
            },
        }
        : null;
    return {
        index,
        id: snapshot.id,
        mapping: snapshot.mapping,
        connected: true,
        timestamp: performance.now(),
        axes: snapshot.axes,
        buttons: snapshot.buttons.map(value => ({ pressed: value > PRESSED, touched: value > 0, value })),
        vibrationActuator,
        hapticActuators: [],
        // not part of the Gamepad API: which numbering a raw pad is in (see GamepadDescriptor.engine in vueport-core)
        engine: 'sdl',
    } as unknown as Gamepad;
}

function apply(snapshots: PadSnapshot[]): void {
    const before = new Map(pads.filter((pad): pad is Gamepad => pad !== null).map(pad => [pad.index, pad.id]));
    const next: (Gamepad | null)[] = [];
    for (const snapshot of snapshots) {
        next[snapshot.index] = toGamepad(snapshot);
    }
    pads = Array.from({ length: next.length }, (_, index) => next[index] ?? null);

    // announced the way a browser announces a pad, as the page listens for that (onGamepadsChanged in vueport-core)
    const after = new Map(snapshots.map(snapshot => [snapshot.index, snapshot.id]));
    for (const [index, id] of before) {
        if (after.get(index) !== id) {
            window.dispatchEvent(new Event('gamepaddisconnected'));
        }
    }
    for (const [index, id] of after) {
        if (before.get(index) !== id) {
            window.dispatchEvent(new Event('gamepadconnected'));
        }
    }
}

// the webview's own Gamepad API is not read once this has run, so a pad both can see does not turn up twice
export async function installDesktopGamepads(): Promise<void> {
    setGamepadSource(() => pads);
    await listen('gamepads://state', payload => apply(payload as PadSnapshot[]));
    // what is already plugged in: the shell only sends a snapshot when something changes
    apply(await invoke<PadSnapshot[]>('gamepad_snapshot'));
}
