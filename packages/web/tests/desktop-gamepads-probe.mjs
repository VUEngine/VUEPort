/**
 * The desktop's game pads from the page's side: the shell's gamepads://state snapshots (src-tauri/src/gamepad.rs) come
 * out of connectedGamepadList like any pad (an SDL-known pad on the standard layout with the standard preset, a raw
 * one with its hat as an axis, each read by SDL), connects and disconnects are announced as a browser does, and rumble
 * goes back to the shell. The shell is a fake window.__TAURI__ answering gamepad_snapshot and recording gamepad_rumble.
 *
 * Usage: node tests/desktop-gamepads-probe.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-pads-'));
const entry = path.join(scratch, 'entry.ts');
const src = file => JSON.stringify(new URL(`../src/${file}`, import.meta.url).pathname);
await writeFile(entry, `
export { installDesktopGamepads } from ${src('desktop-gamepads.ts')};
export { connectedGamepadList } from 'vueport-core/lib/browser/emulator-gamepad';
export { gamepadCanRumble } from 'vueport-core/lib/browser/emulator-gamepad-rumble';
export { resolveGamepadProfile, readGamepadContribution, gamepadProfileFile } from 'vueport-core/lib/common/emulator-gamepad-profiles';
`);
const bundle = path.join(scratch, 'pads.mjs');
await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: bundle,
    nodePaths: [new URL('../../../node_modules', import.meta.url).pathname],
    logLevel: 'silent',
});

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        failures++;
    }
};

const listeners = new Map();
const calls = [];
const XBOX = {
    index: 0,
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => 0),
    axes: [0, 0, 0, 0],
    rumble: true,
};
const RAW = {
    index: 1,
    id: '8BitDo 64 BT (Vendor: 2dc8 Product: 3019)',
    mapping: '',
    buttons: Array.from({ length: 14 }, () => 0),
    // four axes, then the hat, at rest
    axes: [0, 0, 0, 0, 23 / 7],
    rumble: false,
};
const target = new EventTarget();
const announced = [];
target.addEventListener('gamepadconnected', () => announced.push('connected'));
target.addEventListener('gamepaddisconnected', () => announced.push('disconnected'));
globalThis.window = Object.assign(target, {
    __TAURI__: {
        core: {
            invoke: async (command, args) => {
                calls.push({ command, args });
                return command === 'gamepad_snapshot' ? [XBOX] : undefined;
            },
        },
        event: {
            listen: async (event, handler) => {
                listeners.set(event, handler);
                return () => listeners.delete(event);
            },
        },
    },
});
const send = pads => listeners.get('gamepads://state')?.({ payload: pads });

try {
    const { installDesktopGamepads, connectedGamepadList, gamepadCanRumble, resolveGamepadProfile,
        readGamepadContribution, gamepadProfileFile } = await import(pathToFileURL(bundle).href);
    await installDesktopGamepads();

    console.log('\nWhat is plugged in at the start');
    let pads = connectedGamepadList();
    check('the pad the shell already had is there', pads.length === 1 && pads[0].id === XBOX.id);
    check('on the standard layout', pads[0].mapping === 'standard');
    check('and says SDL read it', pads[0].engine === 'sdl');
    check('which picks up the standard preset', resolveGamepadProfile(pads[0]).preset?.id === 'standard-xbox');
    check('and was announced', announced.join() === 'connected');

    console.log('\nA press');
    send([{ ...XBOX, buttons: XBOX.buttons.map((_, index) => index === 13 ? 1 : 0) }]);
    pads = connectedGamepadList();
    const profile = resolveGamepadProfile(pads[0]).profile;
    check('reaches the Virtual Boy\'s left cross', readGamepadContribution(pads[0], profile).keys !== 0);
    check('an analog trigger halfway is a value, and pressed', (() => {
        send([{ ...XBOX, buttons: XBOX.buttons.map((_, index) => index === 6 ? 0.5 : 0) }]);
        const trigger = connectedGamepadList()[0].buttons[6];
        return trigger.value === 0.5 && trigger.pressed;
    })());

    console.log('\nA raw pad arriving');
    announced.length = 0;
    send([XBOX, RAW]);
    pads = connectedGamepadList();
    check('it is announced', announced.join() === 'connected');
    check('and listed beside the first', pads.length === 2 && pads[1].mapping === '');
    check('nothing is guessed for it', resolveGamepadProfile(pads[1]).origin === 'unmapped');
    const hatLeft = { device: '2dc8:3019', family: 'generic', deadZone: 0.5,
        buttons: { lLeft: [{ kind: 'hat', index: 4, direction: 'left' }] } };
    check('its hat at rest holds nothing', readGamepadContribution(pads[1], hatLeft).keys === 0);
    send([XBOX, { ...RAW, axes: [0, 0, 0, 0, -1 + 6 * 2 / 7] }]);
    check('and pressed left reads as left', readGamepadContribution(connectedGamepadList()[1], hatLeft).keys !== 0);
    check('a profile recorded on it is filed under SDL',
        gamepadProfileFile(hatLeft, connectedGamepadList()[1]).match.engine === 'sdl');

    console.log('\nRumble');
    check('a pad SDL can shake offers its motors', gamepadCanRumble(connectedGamepadList()[0]));
    check('one it cannot does not', !gamepadCanRumble(connectedGamepadList()[1]));
    await connectedGamepadList()[0].vibrationActuator.playEffect('dual-rumble', {
        duration: 200, strongMagnitude: 0.8, weakMagnitude: 0.3,
    });
    const rumble = calls.find(call => call.command === 'gamepad_rumble');
    check('playing an effect asks the shell',
        rumble?.args.index === 0 && rumble.args.strong === 0.8 && rumble.args.weak === 0.3 && rumble.args.duration === 200);

    console.log('\nA pad leaving');
    announced.length = 0;
    send([RAW]);
    pads = connectedGamepadList();
    check('it is announced', announced.join() === 'disconnected');
    check('and the other keeps its slot', pads.length === 1 && pads[0].index === 1);
} finally {
    await rm(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
