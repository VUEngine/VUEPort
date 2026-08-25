/**
 * vueport — a Virtual Boy emulator.
 *
 * The core runs in a worker and presents to an `OffscreenCanvas`; the debug
 * panels read the machine over a documented message protocol; the chrome is
 * React. Nothing here knows what it is embedded in: a host supplies files,
 * notifications, settings, key bindings and a place to put the picture, and
 * gets an emulator back.
 *
 * The pieces most hosts want are re-exported here. Anything not listed can be
 * reached by its path — the package ships its sources as well as its build.
 */

// The machine.
export * from './common/vb-constants';
export * from './common/vb-protocol';
export * from './browser/core/vb-core';
export * from './browser/emulator-core-service';

// What a host provides.
export * from './common/emulator-host';
export * from './common/emulator-settings';
export * from './common/emulator-events';
export * from './common/emulator-nls';
export * from './common/emulator-command';
export * from './common/emulator-rumble';

// Files it keeps beside a ROM.
export * from './common/emulator-save-state';
export * from './common/emulator-sram';
export * from './common/emulator-cheats';
export * from './common/emulator-essound';
export * from './common/emulator-profile';

// The emulator itself.
export * from './browser/components/Emulator';
export * from './browser/emulator-types';
export * from './browser/emulator-commands';
export * from './browser/emulator-input';
export * from './browser/emulator-time-control';
export * from './browser/emulator-settings-schema';
export * from './browser/emulator-cheat-store';
export * from './browser/emulator-essound-player';
export * from './browser/emulator-widget-base';
export * from './browser/panels/emulator-dock';
export * from './browser/panels/emulator-panel';
