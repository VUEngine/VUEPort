import * as React from 'react';
import { VueportInputBindings, VueportSettings } from '../../common/emulator-settings';
import { VueportHover } from '../components/kit/KitContext';
import { EmulatorRewindBrowser } from '../emulator-rewind-browser';
import {
  EmulatorAction,
  EmulatorMode,
  EmulatorRomStatus,
} from '../emulator-types';

export interface EmulatorToolbarState {
  loaded: boolean;
  paused: boolean;
  muted: boolean;
  lowPower: boolean;
  slowmotion: boolean;
  fastForward: boolean;
  frameAdvance: boolean;
  showControls: boolean;
  showPalettes: boolean;
  showPreferences: boolean;
  // the five side panels below open beside the screen in both modes, only one at a time (see
  // EmulatorHost#renderCheats)
  showCheats: boolean;
  showMacros: boolean;
  showPatches: boolean;
  showAchievements: boolean;
  // optional, so a host without the save-state browser (the studio's widget) still satisfies this;
  // absent means not shown, and the chrome leaves the button out
  showSaveStates?: boolean;
  // whether there is a newest state to load, see SaveStateStore
  saveStateExists: boolean;
  mode: EmulatorMode;
}

// a control a host adds to one end of the strip, described rather than rendered so it gets the
// built-in markup, styling and hover. The web build adds Open ROM; the studio adds nothing
export interface EmulatorToolbarControl {
    id: string;
    label: string;
    icon: React.ReactNode;
    run(): void;
    disabled?: boolean;
    active?: boolean;
}

// contract between the emulator and the chrome around it (control strip, badges, the studio's title bar).
// VesEmulatorWidget satisfies it structurally
export interface EmulatorToolbarHost {
  readonly state: EmulatorToolbarState;
  readonly status: EmulatorRomStatus;
  readonly rewinding: boolean;
  readonly profiling: boolean;
  // optional, like recordedSeconds, for hosts without recording (no encoder)
  readonly recordingVideo?: boolean;
  // a function rather than a number, so the badge keeps its own clock instead of the whole chrome
  // redrawing once a second (see EmulatorVideoBadge)
  recordedSeconds?(): number;
  // idle: pressing invites a second player in a new window; relinkable: the other window is still there;
  // waiting: a session nobody has joined yet, pressing gives up on it; linked: pressing unlinks
  linkStatus(): 'idle' | 'relinkable' | 'waiting' | 'linked';
  isLinked(): boolean;
  // 1 when playing alone
  readonly player: 1 | 2;
  // not the same as linked: the session reports connected a moment before the mirror of the other
  // machine is built
  canInspectPeer(): boolean;
  // inspectors are pointed at the other player's machine; never true outside a session
  isInspectingPeer(): boolean;
  isRewindEnabled(): boolean;
  isHardcore(): boolean;
  getRenderingMode(): string;
  getPaletteLabel(): string;
  renderPalettePreview(): React.ReactNode;
  runAction(action: EmulatorAction): void;
  setMode(mode: EmulatorMode): void;
  setRenderingMode(mode: string): Promise<void>;
  setScale(scale: string): Promise<void>;
  togglePaletteWindow(): void;
  togglePreferencesWindow(): void;
  // optional for the same reason as EmulatorToolbarState.showSaveStates
  toggleSaveStates?(): void;
  // see EmulatorHost#renderCheats
  toggleCheats(): void;
  // see EmulatorHost#renderMacros
  toggleMacros(): void;
  togglePatches(): void;
  // see EmulatorHost#renderAchievements; opening it closes the other four
  toggleAchievements(): void;
  onRewindButtonDown(e: React.PointerEvent<HTMLButtonElement>): void;
  onRewindButtonUp(e: React.PointerEvent<HTMLButtonElement>): void;
  stopRewinding(): void;
  promptEnableRewind(): Promise<void>;
  // the filmstrip. Optional, as a host without it (the studio's widget) keeps the Rewind button held to rewind; with
  // it, the button and the Rewind key both open the strip
  readonly rewindBrowser?: EmulatorRewindBrowser;
  runCommand(id: string): void;
  readonly settings: VueportSettings;
  readonly bindings: VueportInputBindings;
  // far left of the toolbar, before the transport
  readonly leadingControls?: EmulatorToolbarControl[];
  // far right, after the settings button
  readonly trailingControls?: EmulatorToolbarControl[];
  // optional; the studio passes its own hover service, as for the settings window
  readonly hover?: VueportHover;
}
