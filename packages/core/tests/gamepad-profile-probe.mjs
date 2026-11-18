/**
 * Checks the gamepad profile layer: ids parse the same in every browser; families are detected from the ids and names
 * there are rules for; a stored profile beats a detected preset, and no guess is made for a pad the browser has not
 * normalized; readings fold through a profile into the right VB mask, dead zone included; and assigning a control takes
 * it off whatever else it was on, as one button silently driving two VB buttons is hard to notice while playing and easy
 * to reintroduce.
 * Usage: node tests/gamepad-profile-probe.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ext = '../';
const {
    DEFAULT_GAMEPAD_DEAD_ZONE,
    GAMEPAD_MACRO_ACTIONS,
    GAMEPAD_PRESETS,
    assignGamepadAction,
    assignGamepadButton,
    assignGamepadTurbo,
    clearGamepadButton,
    clearGamepadTurbo,
    gamepadMacroAction,
    gamepadMacroSlot,
    detectGamepadFamily,
    detectGamepadPreset,
    forgetGamepadProfile,
    gamepadPresetFromFile,
    gamepadProfileMatchesPreset,
    gamepadProfileFile,
    gamepadDeviceKey,
    gamepadIdentity,
    gamepadName,
    gamepadSourceId,
    normalizeProfile,
    offeredGamepadPresets,
    profileFromPreset,
    parseGamepadSource,
    pressedGamepadSources,
    readGamepadContribution,
    removeGamepadSource,
    resolveGamepadProfile,
    storeGamepadProfile,
    vbKeyForButton,
} = require(ext + 'lib/common/emulator-gamepad-profiles.js');
const { VbKey } = require(ext + 'lib/common/vb-constants.js');

let failures = 0;

function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

function reading(buttons = {}, axes = {}) {
    const count = Math.max(-1, ...Object.keys(buttons).map(Number)) + 1;
    return {
        buttons: Array.from({ length: count }, (_, index) =>
            ({ pressed: buttons[index] === true, value: buttons[index] === true ? 1 : 0 })),
        axes: Array.from({ length: Math.max(-1, ...Object.keys(axes).map(Number)) + 1 },
            (_, index) => axes[index] ?? 0),
    };
}

const standardXbox = GAMEPAD_PRESETS.find(preset => preset.id === 'standard-xbox');

section('Identity');
{
    // Chrome puts the identifiers in a trailing parenthetical...
    const chrome = gamepadIdentity(
        'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)');
    check('chrome vendor', chrome.vendor, '054c');
    check('chrome product', chrome.product, '05c4');
    check('chrome name', chrome.name, 'Wireless Controller');
    check('chrome key', chrome.key, '054c:05c4');

    // ...Firefox puts the same pair in front, and the two must agree, or a pad would get a different profile per
    // browser
    const firefox = gamepadIdentity('054c-05c4-Wireless Controller');
    check('firefox vendor', firefox.vendor, '054c');
    check('firefox key matches chrome', firefox.key, chrome.key);
    check('firefox name', firefox.name, 'Wireless Controller');

    check('hex case is normalized', gamepadDeviceKey('054C-05C4-Pad'), '054c:05c4');

    // an id in neither shape still has to produce a usable key, or the pad could never be remembered
    const bare = gamepadIdentity('Some Unknown Pad');
    check('bare vendor', bare.vendor, undefined);
    check('bare key is the whole id', bare.key, 'Some Unknown Pad');
    check('bare name', bare.name, 'Some Unknown Pad');

    check('name strips the parenthetical',
        gamepadName('8BitDo Pro 2 (Vendor: 2dc8 Product: 6003)'), '8BitDo Pro 2');
}

section('Family detection');
{
    const family = id => detectGamepadFamily(gamepadIdentity(id));
    check('Sony vendor id', family('054c-05c4-Wireless Controller'), 'playstation');
    check('Microsoft vendor id', family('045e-02ea-Controller'), 'xbox');
    check('Nintendo vendor id', family('057e-2009-Pro Controller'), 'nintendo');
    // 8BitDo ships all three layouts under one vendor id, so the name decides
    check('8BitDo SN30 is a Nintendo layout',
        family('2dc8-6001-8BitDo SN30 Pro'), 'nintendo');
    check('unknown falls back to generic', family('Some Unknown Pad'), 'generic');

    // the harvested database outranks both, as it came from someone with the device in hand
    const db = { 'ffff:0001': { name: 'Odd Pad', family: 'playstation' } };
    check('database wins',
        detectGamepadFamily(gamepadIdentity('ffff-0001-Xbox Style Pad'), db), 'playstation');
}

section('Preset detection');
{
    const standard = { id: '045e-02ea-Controller', mapping: 'standard' };
    check('a standard Xbox pad detects as such',
        detectGamepadPreset(standard).id, 'standard-xbox');
    check('a standard Sony pad detects as such',
        detectGamepadPreset({ id: '054c-05c4-Wireless Controller', mapping: 'standard' }).id,
        'standard-playstation');
    check('a standard unknown pad still gets the generic layout',
        detectGamepadPreset({ id: 'Some Unknown Pad', mapping: 'standard' }).id,
        'standard-generic');

    // a pad the browser has not normalized gets no guess: its indices are in HID order, and a wrong preset looks
    // configured and is worse than none
    check('a non-standard pad is not guessed at',
        detectGamepadPreset({ id: '1234-5678-Odd Stick', mapping: '' }), undefined);

    check('the A/B-swapped preset is manual only',
        GAMEPAD_PRESETS.find(p => p.id === 'standard-nofaceswap').manualOnly, true);

    // except a device whose raw order was recorded off the device itself, whichever browser's spelling of the id
    const adapter = { id: 'VB USB Adapter (Vendor: 1234 Product: 5678)', mapping: '' };
    check('the VB USB Adapter detects as itself (Chrome id)',
        detectGamepadPreset(adapter)?.id, 'vb-usb-adapter');
    check('the VB USB Adapter detects as itself (Firefox id)',
        detectGamepadPreset({ id: '1234-5678-VB USB Adapter', mapping: '' })?.id, 'vb-usb-adapter');
    // its table is raw HID order, wrong the moment a browser remaps the pad
    check('but not once a browser has normalized it',
        detectGamepadPreset({ ...adapter, mapping: 'standard' }).id, 'standard-generic');
    check('it is offered first to that device',
        offeredGamepadPresets(adapter)[0].id, 'vb-usb-adapter');
    check('and never to a standard pad',
        offeredGamepadPresets(standard).some(p => p.id === 'vb-usb-adapter'), false);
    check('nor to another un-normalized one',
        offeredGamepadPresets({ id: '1234-5678-Odd Stick', mapping: '' })
            .some(p => p.id === 'vb-usb-adapter'), false);
    check('the A/B-swapped preset is still withheld from it',
        offeredGamepadPresets(adapter).some(p => p.id === 'standard-nofaceswap'), false);

    const adapterProfile = resolveGamepadProfile(adapter, []).profile;
    check('the adapter resolves to its preset without being set up',
        resolveGamepadProfile(adapter, []).origin, 'preset');
    check('adapter button 4 is A',
        readGamepadContribution(reading({ 4: true }), adapterProfile).keys, VbKey.A);
    check('adapter button 9 is the left trigger',
        readGamepadContribution(reading({ 9: true }), adapterProfile).keys, VbKey.LT);
    check('adapter button 11 is right d-pad right',
        readGamepadContribution(reading({ 11: true }), adapterProfile).keys, VbKey.RR);
    check('the adapter preset covers all fourteen buttons',
        Object.keys(adapterProfile.buttons).length, 14);
}

section('Resolution');
{
    const standard = { id: '045e-02ea-Controller', mapping: 'standard' };
    const fresh = resolveGamepadProfile(standard, []);
    check('nothing stored means the preset', fresh.origin, 'preset');
    check('and it is the detected one', fresh.preset.id, 'standard-xbox');
    check('the profile is filed under the device key', fresh.profile.device, '045e:02ea');
    check('with the shipped dead zone', fresh.profile.deadZone, DEFAULT_GAMEPAD_DEAD_ZONE);

    // a stored profile outranks the preset; the preset it came from is still reported, for "reset to preset"
    const mine = {
        device: '045e:02ea',
        preset: 'standard-xbox',
        family: 'xbox',
        buttons: { a: [{ kind: 'button', index: 3 }] },
        deadZone: 0.25,
    };
    const stored = resolveGamepadProfile(standard, [mine]);
    check('a stored profile wins', stored.origin, 'stored');
    check('its edit survives', stored.profile.buttons.a, [{ kind: 'button', index: 3 }]);
    check('its dead zone survives', stored.profile.deadZone, 0.25);
    check('and it still knows its preset', stored.preset.id, 'standard-xbox');

    const other = resolveGamepadProfile(standard, [{ ...mine, device: '054c:05c4' }]);
    check('another device\'s profile is ignored', other.origin, 'preset');

    const unknown = resolveGamepadProfile({ id: 'Odd Stick', mapping: '' }, []);
    check('an unrecognized pad is unmapped', unknown.origin, 'unmapped');
    check('and has no buttons at all', Object.keys(unknown.profile.buttons).length, 0);
    check('and offers no preset to reset to', unknown.preset, undefined);
}

section('Normalizing stored profiles');
{
    // settings come from localStorage and from an editable file, so every field is a suggestion
    const junk = normalizeProfile({
        device: 'x:y',
        family: 'xbox',
        buttons: {
            a: [{ kind: 'button', index: 1 }, { kind: 'button', index: 1 }], // duplicate
            b: [{ kind: 'button', index: -1 }],                              // negative
            start: [{ kind: 'wheel', index: 2 }],                            // not a kind
            select: 'nonsense',                                              // not a list
            lUp: [{ kind: 'axis', index: 1, direction: -3 }],                // odd direction
        },
        deadZone: 99,
    });
    check('duplicates collapse', junk.buttons.a, [{ kind: 'button', index: 1 }]);
    check('a negative index is dropped', junk.buttons.b, undefined);
    check('an unknown kind is dropped', junk.buttons.start, undefined);
    check('a non-list is dropped', junk.buttons.select, undefined);
    check('a direction is coerced to a sign',
        junk.buttons.lUp, [{ kind: 'axis', index: 1, direction: -1 }]);
    check('the dead zone is clamped', junk.deadZone, 0.9);

    check('a missing dead zone falls back',
        normalizeProfile({ device: 'x', family: 'xbox', buttons: {} }).deadZone,
        DEFAULT_GAMEPAD_DEAD_ZONE);
    check('a preset that no longer exists is forgotten',
        normalizeProfile({ device: 'x', family: 'xbox', buttons: {}, preset: 'gone' }).preset,
        undefined);
}

section('Source ids');
{
    check('a button round-trips',
        parseGamepadSource(gamepadSourceId({ kind: 'button', index: 7 })),
        { kind: 'button', index: 7 });
    check('a negative axis round-trips',
        parseGamepadSource(gamepadSourceId({ kind: 'axis', index: 1, direction: -1 })),
        { kind: 'axis', index: 1, direction: -1 });
    check('a positive axis round-trips',
        parseGamepadSource(gamepadSourceId({ kind: 'axis', index: 2, direction: 1 })),
        { kind: 'axis', index: 2, direction: 1 });
    check('the two ends of one axis differ',
        gamepadSourceId({ kind: 'axis', index: 1, direction: -1 })
        === gamepadSourceId({ kind: 'axis', index: 1, direction: 1 }), false);
    check('a hat direction round-trips',
        parseGamepadSource(gamepadSourceId({ kind: 'hat', index: 9, direction: 'left' })),
        { kind: 'hat', index: 9, direction: 'left' });
    check('nonsense is not a source', parseGamepadSource('wheel3'), undefined);
    check('nor is a hat with no direction', parseGamepadSource('h9x'), undefined);
}

section('Reading a pad');
{
    const profile = {
        device: 'x', family: 'xbox', deadZone: 0.5,
        buttons: standardXbox.buttons,
    };

    check('nothing held is an empty mask',
        readGamepadContribution(reading(), profile).keys, 0);

    // the VB's A is the rightmost face button, which the standard layout calls button 1; button 0 below it is B
    check('button 1 is A', readGamepadContribution(reading({ 1: true }), profile).keys, VbKey.A);
    check('button 0 is B', readGamepadContribution(reading({ 0: true }), profile).keys, VbKey.B);
    check('button 8 is Select',
        readGamepadContribution(reading({ 8: true }), profile).keys, VbKey.SEL);

    // both shoulder pairs reach the same trigger, so it does not matter which pair a pad puts where
    check('shoulder 4 is LT', readGamepadContribution(reading({ 4: true }), profile).keys, VbKey.LT);
    check('trigger 6 is LT too',
        readGamepadContribution(reading({ 6: true }), profile).keys, VbKey.LT);

    check('d-pad up is left up',
        readGamepadContribution(reading({ 12: true }), profile).keys, VbKey.LU);
    check('the left stick up is left up too',
        readGamepadContribution(reading({}, { 1: -1 }), profile).keys, VbKey.LU);
    check('the right stick drives the right cross',
        readGamepadContribution(reading({}, { 3: -1 }), profile).keys, VbKey.RU);

    check('two buttons fold into one mask',
        readGamepadContribution(reading({ 1: true, 9: true }), profile).keys,
        VbKey.A | VbKey.STA);

    check('under the dead zone is nothing',
        readGamepadContribution(reading({}, { 1: -0.49 }), profile).keys, 0);
    check('exactly the dead zone counts',
        readGamepadContribution(reading({}, { 1: -0.5 }), profile).keys, VbKey.LU);
    check('a narrower dead zone lets it through',
        readGamepadContribution(reading({}, { 1: -0.3 }), { ...profile, deadZone: 0.2 }).keys,
        VbKey.LU);

    // an index the pad does not have is ignored rather than throwing: a profile from a two-stick pad can be loaded
    // on a one-stick one
    check('a missing index is ignored',
        readGamepadContribution(reading({ 1: true }), {
            ...profile, buttons: { a: [{ kind: 'button', index: 40 }] },
        }).keys, 0);

    check('an unmapped profile reads nothing',
        readGamepadContribution(reading({ 0: true, 1: true }), {
            ...profile, buttons: {},
        }).keys, 0);
}

section('Actions');
{
    const profile = {
        device: 'x', family: 'xbox', deadZone: 0.5,
        buttons: standardXbox.buttons,
        actions: { pauseToggle: [{ kind: 'button', index: 16 }] },
    };
    check('an action is reported while held',
        [...readGamepadContribution(reading({ 16: true }), profile).actions], ['pauseToggle']);
    check('and not while it is not',
        [...readGamepadContribution(reading({ 0: true }), profile).actions], []);
    check('the mask is unaffected by the action',
        readGamepadContribution(reading({ 16: true }), profile).keys, 0);
}

section('Assigning');
{
    const base = {
        device: 'x', family: 'xbox', deadZone: 0.5, preset: 'standard-xbox',
        buttons: {
            a: [{ kind: 'button', index: 1 }],
            b: [{ kind: 'button', index: 0 }],
        },
    };

    // moving a control onto one button takes it off every other, so one press can never drive two VB buttons
    const moved = assignGamepadButton(base, 'a', { kind: 'button', index: 0 });
    check('the target gets it', moved.buttons.a, [{ kind: 'button', index: 0 }]);
    check('and it is gone from where it was', moved.buttons.b, undefined);
    check('the preset it came from is remembered', moved.preset, 'standard-xbox');

    const replaced = assignGamepadButton(base, 'a', { kind: 'button', index: 5 });
    check('assigning replaces', replaced.buttons.a, [{ kind: 'button', index: 5 }]);
    check('and leaves other buttons alone',
        replaced.buttons.b, [{ kind: 'button', index: 0 }]);

    const onAction = assignGamepadAction(base, 'pauseToggle', { kind: 'button', index: 1 });
    check('an action steals from a button', onAction.buttons.a, undefined);
    check('and holds it', onAction.actions.pauseToggle, [{ kind: 'button', index: 1 }]);
    const backToButton = assignGamepadButton(onAction, 'a', { kind: 'button', index: 1 });
    check('a button steals it back', backToButton.actions.pauseToggle, undefined);
    check('and holds it', backToButton.buttons.a, [{ kind: 'button', index: 1 }]);

    const both = {
        ...base,
        buttons: {
            lUp: [{ kind: 'button', index: 12 }, { kind: 'axis', index: 1, direction: -1 }],
        },
    };
    const stolen = assignGamepadButton(both, 'a', { kind: 'button', index: 12 });
    check('only the moved source is taken',
        stolen.buttons.lUp, [{ kind: 'axis', index: 1, direction: -1 }]);

    check('clearing empties a button',
        clearGamepadButton(base, 'a').buttons.a, undefined);
    check('and leaves the rest', clearGamepadButton(base, 'a').buttons.b,
        [{ kind: 'button', index: 0 }]);
}

section('Turbo and macro slots');
{
    const preset = GAMEPAD_PRESETS[0];
    const base = profileFromPreset(preset, { key: 't:1', name: 'Pad' });
    // button 2 is rewind on the standard preset; put B on turbo there
    const turbo = assignGamepadTurbo(base, 'b', { kind: 'button', index: 2 });
    check('a turbo button holds its source', turbo.turbo.b, [{ kind: 'button', index: 2 }]);
    check('and takes it off the action it drove', turbo.actions.rewind, undefined);
    check('the plain B keeps its own', turbo.buttons.b, base.buttons.b);

    const held = readGamepadContribution(reading({ 2: true }), turbo);
    check('held, it reads as a turbo key', held.turboKeys, VbKey.B);
    check('and not as a plain one', held.keys, 0);
    check('a plain button is no turbo key',
        readGamepadContribution(reading({ 0: true }), turbo).turboKeys, 0);

    // a source drives one thing: moving it to a plain button takes it off turbo
    const plain = assignGamepadButton(turbo, 'a', { kind: 'button', index: 2 });
    check('a plain button steals from turbo', plain.turbo, undefined);
    check('and holds it', plain.buttons.a, [{ kind: 'button', index: 2 }]);
    const backToTurbo = assignGamepadTurbo(plain, 'a', { kind: 'button', index: 2 });
    check('turbo steals it back', backToTurbo.buttons.a, undefined);
    check('turbo A holds it', backToTurbo.turbo.a, [{ kind: 'button', index: 2 }]);
    check('removing the source clears turbo too',
        removeGamepadSource(backToTurbo, { kind: 'button', index: 2 }).turbo, undefined);
    check('clearing empties a turbo button', clearGamepadTurbo(turbo, 'b').turbo, undefined);

    check('normalizing keeps turbo', normalizeProfile(turbo).turbo, turbo.turbo);
    check('normalizing drops a turbo entry for no button',
        normalizeProfile({ ...turbo, turbo: { fire: [{ kind: 'button', index: 3 }] } }).turbo, undefined);
    const file = gamepadProfileFile(turbo, { id: 'Pad (Vendor: 0001 Product: 0002)', mapping: 'standard' });
    check('a profile file carries turbo', file.turbo, turbo.turbo);
    check('and reads back with it', gamepadPresetFromFile(file).turbo, turbo.turbo);

    check('turbo on top of the preset no longer matches it',
        gamepadProfileMatchesPreset(turbo, preset), false);
    check('turbo cleared and rewind put back matches again',
        gamepadProfileMatchesPreset(assignGamepadAction(clearGamepadTurbo(turbo, 'b'), 'rewind',
            { kind: 'button', index: 2 }), preset), true);

    check('slot 3 is macro3', gamepadMacroAction(3), 'macro3');
    check('macro3 is slot 3', gamepadMacroSlot('macro3'), 3);
    check('rewind is no slot', gamepadMacroSlot('rewind'), undefined);
    const macro = assignGamepadAction(base, 'macro3', { kind: 'button', index: 5 });
    const pressed = readGamepadContribution(reading({ 5: true }), macro);
    check('a held macro button reads as its slot', [...pressed.macroSlots], [3]);
    check('and not as an emulator action', [...pressed.actions], []);
    check('a macro slot survives normalizing', normalizeProfile(macro).actions.macro3,
        [{ kind: 'button', index: 5 }]);
    check('an action nobody knows does not',
        normalizeProfile({ ...macro, actions: { macro9: [{ kind: 'button', index: 5 }] } }).actions, undefined);
}

section('Storing');
{
    const one = { device: 'a:1', family: 'xbox', buttons: {}, deadZone: 0.5 };
    const two = { device: 'b:2', family: 'nintendo', buttons: {}, deadZone: 0.5 };

    check('a profile is added', storeGamepadProfile([], one).length, 1);
    check('a second device is kept alongside',
        storeGamepadProfile([one], two).length, 2);
    // one entry per device: storing twice must not grow the list with dead profiles for the same pad
    const twice = storeGamepadProfile(storeGamepadProfile([], one), { ...one, deadZone: 0.3 });
    check('the same device replaces rather than repeats', twice.length, 1);
    check('with the new value', twice[0].deadZone, 0.3);

    check('forgetting removes one',
        forgetGamepadProfile([one, two], 'a:1').map(p => p.device), ['b:2']);
    check('forgetting an unknown device changes nothing',
        forgetGamepadProfile([one], 'nope').length, 1);

    // edited away and back again must read as untouched, or a pad bound exactly as its preset shows as customized
    const preset = GAMEPAD_PRESETS[0];
    const fresh = profileFromPreset(preset, { key: 'c:3', name: 'Pad' });
    check('a profile straight from its preset matches it', gamepadProfileMatchesPreset(fresh, preset), true);
    const moved = clearGamepadButton(fresh, 'a');
    check('one cleared button no longer matches', gamepadProfileMatchesPreset(moved, preset), false);
    const back = { ...moved, buttons: { ...moved.buttons, a: [...preset.buttons.a].reverse() } };
    check('put back, in any order, matches again', gamepadProfileMatchesPreset(back, preset), true);
    check('a different dead zone does not match',
        gamepadProfileMatchesPreset({ ...fresh, deadZone: 0.25 }, preset), false);
}

section('Pressed sources');
{
    const pressed = pressedGamepadSources(reading({ 0: true, 2: true }, { 1: -0.8 }), 0.5);
    check('held buttons are reported', pressed.has('b0'), true);
    check('and the other one', pressed.has('b2'), true);
    check('an unheld button is not', pressed.has('b1'), false);
    check('a deflected axis is reported', pressed.has('a1-'), true);
    check('but not its other end', pressed.has('a1+'), false);

    check('under the dead zone reports nothing',
        pressedGamepadSources(reading({}, { 0: 0.4 }), 0.5).size, 0);
}

section('Several sources on one control');
{
    const hatLeft = { kind: 'hat', index: 9, direction: 'left' };
    const stickLeft = { kind: 'axis', index: 0, direction: -1 };
    let profile = { device: 'x', family: 'generic', buttons: {}, deadZone: 0.5 };
    profile = assignGamepadButton(profile, 'lLeft', hatLeft);
    profile = assignGamepadButton(profile, 'lLeft', stickLeft, true);
    check('adding keeps what was there', profile.buttons.lLeft, [hatLeft, stickLeft]);
    check('adding the same one again does not double it',
        assignGamepadButton(profile, 'lLeft', stickLeft, true).buttons.lLeft, [hatLeft, stickLeft]);
    check('both drive the button — the d-pad',
        readGamepadContribution(reading({}, { 9: 5 / 7 }), profile).keys, vbKeyForButton('lLeft'));
    check('and the stick',
        readGamepadContribution(reading({}, { 0: -0.9, 9: 9 / 7 }), profile).keys, vbKeyForButton('lLeft'));
    check('adding to another button still moves it off this one',
        assignGamepadButton(profile, 'lRight', stickLeft, true).buttons.lLeft, [hatLeft]);
    check('removing one leaves the other', removeGamepadSource(profile, hatLeft).buttons.lLeft, [stickLeft]);
    check('removing the last empties the control',
        removeGamepadSource(removeGamepadSource(profile, hatLeft), stickLeft).buttons.lLeft, undefined);
    check('replacing is still the default',
        assignGamepadButton(profile, 'lLeft', { kind: 'button', index: 14 }).buttons.lLeft,
        [{ kind: 'button', index: 14 }]);
}

section('Profile files');
{
    for (const preset of GAMEPAD_PRESETS.filter(preset => preset.match)) {
        check(`bundled ${preset.id} has buttons`, Object.keys(preset.buttons).length > 0, true);
    }

    const pad = {
        id: '8BitDo 64 BT (Vendor: 2dc8 Product: 3019)',
        mapping: '',
        buttons: new Array(16),
        axes: new Array(10),
        engine: 'chromium',
        platform: 'linux',
    };
    const recorded = {
        device: '2dc8:3019', label: '8BitDo 64 BT', family: 'nintendo', deadZone: 0.4,
        buttons: { a: [{ kind: 'button', index: 0 }], lLeft: [{ kind: 'hat', index: 9, direction: 'left' }] },
        actions: { pauseToggle: [{ kind: 'button', index: 3 }] },
    };
    const file = gamepadProfileFile(recorded, pad);
    check('a file is named after the pad, engine and system', file.id, '8bitdo-64-bt-chromium-linux');
    check('and records how the browser showed it', file.match,
        { device: '2dc8:3019', name: '8BitDo 64 BT', mapping: '', engine: 'chromium', platform: 'linux', buttons: 16, axes: 10 });
    check('the same pad in Firefox is filed apart',
        gamepadProfileFile(recorded, { ...pad, engine: 'gecko' }).id, '8bitdo-64-bt-gecko-linux');
    check('the emulator actions travel with it', file.actions, recorded.actions);

    const preset = gamepadPresetFromFile(JSON.parse(JSON.stringify(file)));
    check('it reads back', preset?.buttons, recorded.buttons);
    check('with its dead zone', preset?.deadZone, 0.4);
    check('and family', preset?.family, 'nintendo');
    check('a file of something else is refused', gamepadPresetFromFile({ format: 'other' }), undefined);
    // the bundled Firefox recording of the 8BitDo 64: its d-pad is a hat on axis 0 of 7 there, which Chrome lays
    // out differently
    const firefox64 = {
        id: '2dc8-3019-8BitDo 64 BT', mapping: '', buttons: new Array(18), axes: new Array(7),
        engine: 'gecko', platform: 'macos',
    };
    check('the 8BitDo 64 detects in Firefox', detectGamepadPreset(firefox64)?.match?.engine, 'gecko');
    check('but not in Chrome, even with the same counts', detectGamepadPreset({
        ...firefox64, id: '8BitDo 64 BT (Vendor: 2dc8 Product: 3019)', engine: 'chromium',
    }), undefined);
    // Chrome has a recording of its own: the d-pad's hat on axis 9 of 10
    const chrome64 = {
        ...firefox64, id: '8BitDo 64 BT (Vendor: 2dc8 Product: 3019)', engine: 'chromium', axes: new Array(10),
    };
    check('Chrome gets its own 8BitDo 64 profile', detectGamepadPreset(chrome64)?.id,
        '8bitdo-64-bluetooth-controller-chromium-macos');
    check('with the d-pad on axis 9 there',
        readGamepadContribution(reading({}, { 9: 5 / 7 }), profileFromPreset(detectGamepadPreset(chrome64),
            { key: '2dc8:3019', name: '8BitDo 64 BT' })).keys, vbKeyForButton('lLeft'));
    check('nor in Safari, whose id looks like Firefox\'s', detectGamepadPreset({ ...firefox64, engine: 'webkit' }), undefined);
    // and the desktop's, through SDL on the standard layout, where SDL's database puts A and B the wrong way round
    // for a VB and the C buttons on Back, X, Y and Misc 2
    const sdl64 = {
        id: '8BitDo 64 BT (STANDARD GAMEPAD Vendor: 2dc8 Product: 3019)', mapping: 'standard',
        engine: 'sdl', platform: 'macos',
    };
    const sdlPreset = detectGamepadPreset(sdl64);
    check('under SDL it gets its own profile rather than the standard one', sdlPreset?.id,
        '8bitdo-64-bluetooth-controller-sdl-macos');
    const sdlProfile = profileFromPreset(sdlPreset, { key: '2dc8:3019', name: '8BitDo 64 BT' });
    check('N64 A is the Virtual Boy\'s A', readGamepadContribution(reading({ 0: true }), sdlProfile).keys, VbKey.A);
    check('C-Right is the right cross\'s right', readGamepadContribution(reading({ 18: true }), sdlProfile).keys, VbKey.RR);
    check('Home opens the palette', [...readGamepadContribution(reading({ 16: true }), sdlProfile).uiActions], ['commandPalette']);
    // in Switch mode it is Nintendo's N64 controller on every system, through SDL's own Switch driver
    const n64 = { id: 'Nintendo N64 Controller (STANDARD GAMEPAD Vendor: 057e Product: 2019)',
        mapping: 'standard', engine: 'sdl', platform: 'windows' };
    const n64Profile = profileFromPreset(detectGamepadPreset(n64), { key: '057e:2019', name: 'Nintendo N64 Controller' });
    check('the N64 controller gets its own profile, on any system', detectGamepadPreset(n64)?.id, 'nintendo-n64-controller-sdl');
    check('C-Up is the right cross\'s up', readGamepadContribution(reading({ 8: true }), n64Profile).keys, VbKey.RU);
    check('C-Left its left', readGamepadContribution(reading({ 3: true }), n64Profile).keys, VbKey.RL);
    // SDL's Switch driver reads an N64 pad by label, which moves its A onto south: A is 0 and B is 1, measured
    // three presses running
    check('A is 0, as SDL\'s Switch driver reports it', readGamepadContribution(reading({ 0: true }), n64Profile).keys, VbKey.A);
    check('and is labelled with its own names, not a family\'s', [
        detectGamepadPreset(n64)?.labels?.b0, detectGamepadPreset(n64)?.labels?.b8,
    ], ['A', 'C↑']);
    check('the star is Select, there being no minus', readGamepadContribution(reading({ 17: true }), n64Profile).keys, VbKey.SEL);
    check('but not in a browser, which numbers it differently', detectGamepadPreset({ ...n64, engine: 'chromium' })?.id !== 'nintendo-n64-controller-sdl', true);
    check('and an Xbox pad under SDL still gets the standard preset', detectGamepadPreset({
        ...sdl64, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    })?.id, 'standard-xbox');
    check('nor in Firefox on another system',
        detectGamepadPreset({ ...firefox64, platform: 'windows' }), undefined);
    check('nor in Firefox with a different layout',
        detectGamepadPreset({ ...firefox64, axes: new Array(9) }), undefined);
    check('an unknown engine is dropped, not guessed',
        gamepadPresetFromFile({ ...file, match: { ...file.match, engine: 'trident' } })?.match.engine, undefined);
    check('as is one with no device to match',
        gamepadPresetFromFile({ ...file, match: { mapping: '' } }), undefined);
}

section('Host actions');
{
    check('the standard presets put the palette on Home',
        standardXbox.actions?.commandPalette, [{ kind: 'button', index: 16 }]);
    const profile = resolveGamepadProfile({
        id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', mapping: 'standard',
    }).profile;
    check('and a pad resolved from one has it', profile.actions?.commandPalette, [{ kind: 'button', index: 16 }]);
    const held = readGamepadContribution(reading({ 16: true }), profile);
    check('holding Home is a host action', [...held.uiActions], ['commandPalette']);
    check('and not an emulator one', held.actions.size, 0);

    check('the controls the machine has no use for are set up too', {
        rewind: profile.actions?.rewind, fastForward: profile.actions?.toggleFastForward,
        pause: profile.actions?.pauseToggle, screenshot: profile.actions?.screenshot,
    }, {
        rewind: [{ kind: 'button', index: 2 }], fastForward: [{ kind: 'button', index: 3 }],
        pause: [{ kind: 'button', index: 10 }], screenshot: [{ kind: 'button', index: 11 }],
    });
    check('but not saving or loading a state, a stray press from losing something',
        [profile.actions?.saveState, profile.actions?.loadState], [undefined, undefined]);
    check('rewinding is an emulator action', [...readGamepadContribution(reading({ 2: true }), profile).actions], ['rewind']);
    const bound = new Set(Object.values(profile.buttons).flat().map(gamepadSourceId));
    check('none of them lands on a Virtual Boy button',
        Object.values(profile.actions).flat().some(action => bound.has(gamepadSourceId(action))), false);

    const file = gamepadProfileFile(profile, { id: 'x', mapping: '', engine: 'gecko', platform: 'macos' });
    check('a profile file carries every action', file.actions, profile.actions);
    check('and reads back with them', gamepadPresetFromFile(JSON.parse(JSON.stringify(file)))?.actions, file.actions);
    check('an action nobody knows is dropped', gamepadPresetFromFile({
        ...JSON.parse(JSON.stringify(file)), actions: { selfDestruct: [{ kind: 'button', index: 1 }] },
    })?.actions, undefined);
    // the raw recordings, where Home is the pad's own button 12; under SDL it is the standard layout's 16
    for (const preset of GAMEPAD_PRESETS.filter(preset => /^8bitdo-64/.test(preset.id) && preset.match?.mapping === '')) {
        check(`${preset.id} opens the palette on Home`, preset.actions?.commandPalette, [{ kind: 'button', index: 12 }]);
    }
}

// vueport-server checks shared profiles against a PHP list of the actions it will store, kept in step by hand,
// so checked here against the enum it copies, or a new action would be refused on every share
section('Server action list');
{
    const { readFileSync } = await import('node:fs');
    const { EmulatorAction } = require(ext + 'lib/browser/emulator-types.js');
    const php = readFileSync(new URL('../../server/src/gamepad_profiles.php', import.meta.url), 'utf8');
    const listed = /const GAMEPAD_ACTIONS = \[([^\]]*)\]/.exec(php)?.[1].match(/'[^']+'/g)?.map(name => name.slice(1, -1)) ?? [];
    check('the server takes every action a profile can bind',
        [...listed].sort(), ['commandPalette', ...Object.values(EmulatorAction), ...GAMEPAD_MACRO_ACTIONS].sort());
    const engines = /const GAMEPAD_ENGINES = \[([^\]]*)\]/.exec(php)?.[1].match(/'[^']+'/g)?.map(name => name.slice(1, -1)) ?? [];
    // every engine a recorded profile can carry: a file keeps one through the round trip only if the core knows
    // it, so the server must know the same
    const known = ['chromium', 'gecko', 'webkit', 'sdl', 'trident']
        .filter(engine => gamepadPresetFromFile({
            format: 'vueport-gamepad-profile', version: 1, id: 'x', name: 'x', family: 'generic',
            match: { name: 'x', mapping: '', engine }, deadZone: 0.5, buttons: {},
        })?.match.engine === engine);
    check('and every engine the core does', [...engines].sort(), known.sort());
}

// a d-pad Chromium hands over as one axis (the 8BitDo 64): eight positions clockwise from -1 = up, 2/7 apart,
// resting at 23/7 as measured
section('Hat switch');
{
    const REST = 23 / 7;
    const at = position => -1 + position * 2 / 7;
    const hats = new Set();
    check('a hat at rest reports nothing',
        pressedGamepadSources(reading({}, { 9: REST }), 0.5, hats).size, 0);
    check('and is remembered as a hat', hats.has(9), true);

    const held = position => [...pressedGamepadSources(reading({}, { 9: at(position) }), 0.5, hats)];
    check('up', held(0), ['h9u']);
    check('right — under the dead zone as a stick', held(2), ['h9r']);
    check('down', held(4), ['h9d']);
    check('left — same sign as resting', held(6), ['h9l']);
    check('a diagonal is both', held(1).sort(), ['h9r', 'h9u']);
    check('up-left wraps round', held(7).sort(), ['h9l', 'h9u']);
    // Chrome reports 0 on every axis of an untouched pad, which is halfway between two positions, not a position
    check('an untouched hat reading 0 is not held', held(3.5), []);
    check('nor is anything between two positions', held(2.5), []);
    check('a little noise on a position still counts', [...pressedGamepadSources(
        reading({}, { 9: at(6) + 0.02 }), 0.5, hats)], ['h9l']);

    const left = { buttons: { lLeft: [{ kind: 'hat', index: 9, direction: 'left' }] }, deadZone: 0.5 };
    check('a bound hat drives its button',
        readGamepadContribution(reading({}, { 9: at(6) }), left).keys, vbKeyForButton('lLeft'));
    check('and lets go at rest',
        readGamepadContribution(reading({}, { 9: REST }), left).keys, 0);

    const asStick = { buttons: { lLeft: [{ kind: 'axis', index: 9, direction: 1 }] }, deadZone: 0.5 };
    check('a hat bound as a stick is not held at rest',
        readGamepadContribution(reading({}, { 9: REST }), asStick).keys, 0);

    check('a hat survives normalizing',
        normalizeProfile({ ...left, device: 'x' })?.buttons.lLeft, left.buttons.lLeft);
}

section('Held at connect');
{
    // a pad's first reading is not trusted: SDL reads an axis that has not reported yet at the bottom of its
    // range, which held the 8BitDo 64's C-Up (R-Up) the moment it connected
    const { connectedGamepadList, setGamepadSource } = require(ext + 'lib/browser/emulator-gamepad.js');
    const button = value => ({ pressed: value > 0.1, touched: value > 0, value });
    let pad;
    const set = (buttons, axes) => {
        pad = { index: 0, id: 'Probe Pad', mapping: 'standard', connected: true, timestamp: 0,
            buttons: buttons.map(button), axes, engine: 'sdl' };
    };
    setGamepadSource(() => [pad]);
    const read = () => connectedGamepadList()[0];

    set([0, 0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, -1, 23 / 7]);
    let seen = read();
    check('a button held at connect reads released', seen.buttons[8].pressed, false);
    check('an axis off-centre at connect reads centred', seen.axes[3], 0);
    check('a hat at rest is left alone', seen.axes[4], 23 / 7);
    check('the copy keeps the engine', seen.engine, 'sdl');

    set([0, 0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, -1, 23 / 7]);
    check('it stays released while held', read().buttons[8].pressed, false);

    set([0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0.1, 23 / 7]);
    check('let go, the untouched pad is passed through', read() === pad, true);

    set([0, 0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, -1, 23 / 7]);
    seen = read();
    check('pressed again, the button counts', seen.buttons[8].pressed, true);
    check('pressed again, the axis counts', seen.axes[3], -1);

    setGamepadSource(() => []);
    read();
    setGamepadSource(() => [pad]);
    check('reconnected, a held button is new again', read().buttons[8].pressed, false);
    setGamepadSource(undefined);
}

section('Mask table');
{
    // every button has to reach a distinct bit, or two would be indivisible
    const bits = new Map();
    for (const button of Object.keys(standardXbox.buttons)) {
        const bit = vbKeyForButton(button);
        check(`${button} has a bit`, typeof bit === 'number' && bit > 0, true);
        check(`${button}'s bit is its own`, bits.has(bit), false);
        bits.set(bit, button);
    }
    check('all fourteen buttons are covered', bits.size, 14);
    // the two signals that are not buttons must never be reachable from one
    check('no button sets the present signal', bits.has(VbKey.SGN), false);
    check('no button sets the low-battery signal', bits.has(VbKey.PWR), false);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
