import { Emitter, Event } from '../common/emulator-events';
import { VueportStorage } from '../common/emulator-host';
import {
    finishMacro,
    parseMacroFile,
    serializeMacroFile,
    Macro,
    MacroStep,
    macroIsEmpty,
    macroKeysAt,
    readMacroSlot,
} from '../common/emulator-macros';
import {
    readVesBrowserState,
    browserStateStorage,
    browserStateId,
    browserStateKey,
    writeVesBrowserState,
} from './emulator-browser-state';

interface StoredMacroState {
    looping?: string[];
}

// repeat switches of the shared macros; its own kind rather than a made-up ROM path, so no path can collide
const GLOBAL_STATE_KEY = browserStateKey('global-macros', '');

export interface EmulatorMacroInput {
    readonly playerKeys: number;
    // combined with the player's own keys, so pressing something while a macro runs adds to it
    setMacroKeys(keys: number): void;
    focus(): void;
}

export enum MacroActivity {
    IDLE = 'idle',
    RECORDING = 'recording',
    PLAYING = 'playing',
}

/**
 * One emulator's macros: the list, its file, recording and playback. Held by the widget like the cheats, so macros play
 * on with the panel closed and load with the ROM. `<rom>.vueport-macros.json` next to the saves holds definitions only
 * (there is no published format to match); repeat flags live in browser state.
 *
 * Recording and playback use a clock advanced in tick only while running, so pauses and menus are not recorded as
 * waits. It counts seconds, not frames (the worker reports none per frame), so fast forward plays against a faster
 * game; Play mode, where macros are used, runs at one speed.
 */
export class MacroStore {

    // the ROM's own macros and the global ones: two files, shown as one list (see list and locate). Kept apart
    // rather than flagged, as they are written to different files and marking one global moves it
    protected macros: Macro[] = [];
    protected globals: Macro[] = [];
    protected combined: ReadonlyArray<Macro> = [];
    protected uri: string | undefined;
    protected browserStateKey: string | undefined;
    // set once a file has been read, so a first save cannot precede a load
    protected loaded = false;
    protected globalsLoaded = false;
    protected input: EmulatorMacroInput | undefined;

    protected running = false;
    // milliseconds of running time, so pauses are not recorded as waits. Time rather than frames (the worker reports
    // none per frame), so fast forward plays against a faster game
    protected clock = 0;
    // on performance.now's scale
    protected clockReadAt: number | undefined;

    protected recording: { steps: MacroStep[], from: number } | undefined;
    protected playback: { index: number, from: number, keys: number } | undefined;

    // saves run one after another, as in the cheat store: an edit and its undo are a write and a delete
    protected persisting: Promise<void> = Promise.resolve();

    protected readonly onDidChangeEmitter = new Emitter<void>();
    // not on every tick: a running recording or playback is announced at start and stop, and whoever shows a
    // stopwatch polls on its own timer
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(
        protected readonly storage: VueportStorage,
        protected readonly stateStorage?: browserStateStorage,
        // where global macros live (EmulatorCompanionFiles#globalMacros); without it macros are per ROM only. A function,
        // as the studio only learns its configuration directory asynchronously, after this is built
        protected readonly resolveGlobalUri?: () => string | undefined,
    ) { }

    protected get globalUri(): string | undefined {
        return this.resolveGlobalUri?.();
    }

    // the ROM's own first, then the global ones. Everything addresses a macro by its place in this list; own first,
    // so a new recording lands where the eye is
    get list(): ReadonlyArray<Macro> {
        return this.combined;
    }

    get supportsGlobal(): boolean {
        return this.globalUri !== undefined;
    }

    // the one place the two lists are joined, so play, update, remove etc. work in the combined index space
    protected locate(index: number): { list: Macro[], at: number, global: boolean } | undefined {
        if (index < 0) {
            return undefined;
        }
        if (index < this.macros.length) {
            return { list: this.macros, at: index, global: false };
        }
        const at = index - this.macros.length;
        return at < this.globals.length
            ? { list: this.globals, at, global: true }
            : undefined;
    }

    // the lists never carry the global flag (which list a macro is in is the answer), so it is stamped on here
    protected recombine(): void {
        this.combined = [
            ...this.macros,
            ...this.globals.map(macro => ({ ...macro, global: true })),
        ];
    }

    get isLoaded(): boolean {
        return this.loaded;
    }

    get filePath(): string | undefined {
        return this.uri;
    }

    setInput(input: EmulatorMacroInput | undefined): void {
        this.input = input;
    }

    // `romPath` as the companion files see it, as for the cheat store. Global macros are read once alongside, not per
    // ROM, and failing to read them leaves the ROM's own working
    async load(romPath: string): Promise<void> {
        this.stop();
        this.cancelRecording();
        const directory = this.storage.parent(romPath);
        const stem = this.storage.stem(romPath);
        this.uri = this.storage.join(directory, `${stem}.vueport-macros.json`);
        this.browserStateKey = browserStateKey('macros', romPath);
        this.macros = [];
        try {
            this.macros = await this.readMacroFile(this.uri, this.browserStateKey);
            this.loaded = true;
        } catch (error) {
            console.warn(`[emulator] could not read macros from ${this.uri}:`, error);
            this.loaded = false;
        }
        await this.loadGlobals();
        this.changed(false, false);
    }

    protected async loadGlobals(): Promise<void> {
        if (this.globalsLoaded || !this.globalUri) {
            return;
        }
        try {
            this.globals = await this.readMacroFile(this.globalUri, GLOBAL_STATE_KEY);
            this.globalsLoaded = true;
        } catch (error) {
            console.warn(`[emulator] could not read global macros from ${this.globalUri}:`, error);
        }
    }

    // repeat comes from browser storage alone; a hand-written `loop` in the file is ignored, so a macro without a
    // remembered switch plays once
    protected async readMacroFile(uri: string, stateKey: string): Promise<Macro[]> {
        const macros = await this.storage.exists(uri)
            ? parseMacroFile(await this.storage.readText(uri))
            : [];
        const stored = readVesBrowserState<StoredMacroState>(this.stateStorage, stateKey);
        const ids = stateIdsOf(macros);
        const looping = Array.isArray(stored?.looping)
            ? new Set(stored.looping.filter(id => typeof id === 'string'))
            : new Set<string>();
        return macros.map((macro, index) => ({
            ...macro,
            loop: looping.has(ids[index]) || undefined,
            // which list a macro is in makes it global; a flag from the file would be a second, disagreeing answer
            global: undefined as boolean | undefined,
        }));
    }

    protected saveBrowserState(): boolean {
        return writeLoopState(this.stateStorage, this.browserStateKey, this.macros);
    }

    protected saveGlobalBrowserState(): boolean {
        return writeLoopState(
            this.stateStorage, this.globalUri && GLOBAL_STATE_KEY, this.globals);
    }

    // writes the definitions back, or removes the file after the last macro; repeat switches are in browser storage.
    // Saved on every edit, as a recording lost to a closed tab is worse than extra writes
    protected async saveDefinitions(): Promise<void> {
        if (!this.loaded) {
            return;
        }
        await this.writeMacroFile(this.uri, this.macros);
    }

    protected async saveGlobalDefinitions(): Promise<void> {
        if (!this.globalsLoaded) {
            return;
        }
        await this.writeMacroFile(this.globalUri, this.globals);
    }

    protected async writeMacroFile(
        uri: string | undefined, macros: ReadonlyArray<Macro>
    ): Promise<void> {
        if (!uri) {
            return;
        }
        try {
            if (macros.length === 0) {
                if (await this.storage.exists(uri)) {
                    await this.storage.delete(uri);
                }
            } else {
                await this.storage.writeText(uri, serializeMacroFile(macros));
            }
        } catch (error) {
            console.warn(`[emulator] could not store macros in ${uri}:`, error);
        }
    }

    // undefined takes it out of its slot. A slot holds one macro per file, so others in the same file give it up; a
    // game's own and a global macro may share a number (the game's plays), so the other file is left alone
    setSlot(index: number, slot: number | undefined): void {
        const found = this.locate(index);
        if (!found) {
            return;
        }
        const valid = readMacroSlot(slot);
        if (valid !== undefined) {
            this.freeSlot(found.list, valid);
        }
        const { slot: unused, ...macro } = found.list[found.at];
        found.list[found.at] = valid !== undefined ? { ...macro, slot: valid } : macro;
        this.changed(true, false);
    }

    protected freeSlot(list: Macro[], slot: number): void {
        for (let i = 0; i < list.length; i++) {
            if (list[i].slot === slot) {
                const { slot: unused, ...macro } = list[i];
                list[i] = macro;
            }
        }
    }

    // where the macro in a slot is in list: the game's own if it has one there, else the global one
    slotIndex(slot: number): number | undefined {
        const own = this.macros.findIndex(macro => macro.slot === slot);
        if (own !== -1) {
            return own;
        }
        const global = this.globals.findIndex(macro => macro.slot === slot);
        return global !== -1 ? this.macros.length + global : undefined;
    }

    playSlot(slot: number): void {
        const index = this.slotIndex(slot);
        if (index !== undefined) {
            this.play(index);
        }
    }

    update(index: number, patch: Partial<Pick<Macro, 'name' | 'loop'>>): void {
        const found = this.locate(index);
        if (!found) {
            return;
        }
        found.list[found.at] = { ...found.list[found.at], ...patch };
        this.changed(patch.name !== undefined, true);
    }

    remove(index: number): void {
        const found = this.locate(index);
        if (!found) {
            return;
        }
        // what is playing is addressed by index, and every later index is about to mean a different macro
        this.stop();
        found.list.splice(found.at, 1);
        this.changed(true, true);
    }

    // moved rather than copied or flagged, so two copies cannot drift apart. The repeat switch is keyed by the macro's
    // identity, so writing both sides' state is enough. Playback stops first, as in remove
    setGlobal(index: number, global: boolean): void {
        const found = this.locate(index);
        if (!found || !this.globalUri || found.global === global) {
            return;
        }
        this.stop();
        const [macro] = found.list.splice(found.at, 1);
        const target = global ? this.globals : this.macros;
        if (macro.slot !== undefined) {
            this.freeSlot(target, macro.slot);
        }
        target.push(macro);
        this.changed(true, true);
    }

    // like the cheat store's import: macros with nothing to play are dropped, each comes in playing once, and the
    // number added is returned. Duplicate names are harmless, as macros are addressed by place
    importMacros(macros: readonly Macro[]): number {
        const added = macros.filter(macro => !macroIsEmpty(macro));
        for (const macro of added) {
            // a slot comes along only if nothing here has it, so an import does not rearrange existing setups
            const slot = macro.slot !== undefined && this.macros.every(own => own.slot !== macro.slot)
                ? macro.slot
                : undefined;
            this.macros.push({
                ...macro,
                loop: undefined,
                global: undefined,
                slot,
                steps: macro.steps.map(step => ({ ...step })),
            });
        }
        if (added.length > 0) {
            this.changed(true, true);
        }
        return added.length;
    }

    // called whenever the host pauses, resumes, loads or stops a ROM; reading the clock first banks the time so far
    setRunning(running: boolean): void {
        this.readClock();
        this.running = running;
        this.clockReadAt = running ? performance.now() : undefined;
    }

    // advanced on demand rather than on a timer, so it is right for whoever asks (frame loop, key press, stopwatch)
    protected readClock(): number {
        const now = performance.now();
        if (this.running && this.clockReadAt !== undefined) {
            this.clock += now - this.clockReadAt;
        }
        this.clockReadAt = this.running ? now : undefined;
        return this.clock;
    }

    get activity(): MacroActivity {
        if (this.recording) {
            return MacroActivity.RECORDING;
        }
        return this.playback ? MacroActivity.PLAYING : MacroActivity.IDLE;
    }

    get isRecording(): boolean {
        return this.recording !== undefined;
    }

    get playingIndex(): number | undefined {
        return this.playback?.index;
    }

    // milliseconds into the current recording or playback, zero when neither runs; read rather than pushed (see
    // onDidChange)
    get elapsed(): number {
        const from = this.recording?.from ?? this.playback?.from;
        return from === undefined ? 0 : Math.max(0, this.readClock() - from);
    }

    startRecording(): void {
        this.stop();
        // recording must hear the keyboard, so focus first: the button that started it may be the empty panel's, which
        // this call removes, dropping focus onto the document where the key listener never sees it
        this.input?.focus();
        const from = this.readClock();
        this.recording = {
            // buttons held at the outset are part of the recording, e.g. a direction held for a combo
            steps: [{ at: from, keys: this.input?.playerKeys ?? 0 }],
            from,
        };
        this.changed(false, false);
    }

    // returns where the macro landed in the list, or undefined if canceled or no button was pressed (an empty macro is
    // dropped)
    stopRecording(name: string): number | undefined {
        const recording = this.recording;
        this.recording = undefined;
        if (!recording) {
            return undefined;
        }
        const macro = finishMacro(name, recording.steps, this.readClock());
        if (macroIsEmpty(macro)) {
            this.changed(false, false);
            return undefined;
        }
        this.macros.push(macro);
        this.changed(true, true);
        return this.macros.length - 1;
    }

    cancelRecording(): void {
        if (!this.recording) {
            return;
        }
        this.recording = undefined;
        this.changed(false, false);
    }

    // called by the input controller with the player's buttons only; feeding back a macro's would copy it into a
    // recording made while it plays
    recordKeys(keys: number): void {
        if (!this.recording) {
            return;
        }
        this.recording.steps.push({ at: this.readClock(), keys });
    }

    // playing a second macro replaces the first, as two holding the same button have no correct answer; playing the
    // one already playing stops it, as the panel's button means
    play(index: number): void {
        const found = this.locate(index);
        const macro = found?.list[found.at];
        if (!macro || macroIsEmpty(macro)) {
            return;
        }
        if (this.playback?.index === index) {
            this.stop();
            return;
        }
        // a macro can take over from another macro, never from the player: a recording is stopped first
        this.cancelRecording();
        this.playback = { index, from: this.readClock(), keys: 0 };
        this.input?.setMacroKeys(0);
        this.changed(false, false);
    }

    stop(): void {
        if (!this.playback) {
            return;
        }
        this.playback = undefined;
        this.input?.setMacroKeys(0);
        this.changed(false, false);
    }

    // called once per animation frame by the input controller's gamepad loop. Nothing moves while the machine is
    // stopped, so a paused macro resumes where it was
    tick(): void {
        const playback = this.playback;
        if (!playback) {
            return;
        }
        const found = this.locate(playback.index);
        const macro = found?.list[found.at];
        if (!macro) {
            this.stop();
            return;
        }
        let elapsed = this.readClock() - playback.from;
        if (elapsed >= macro.duration) {
            if (!macro.loop || macro.duration <= 0) {
                this.stop();
                return;
            }
            // wrapped rather than restarted from now, so a looping macro does not drift by the length of that frame
            const laps = Math.floor(elapsed / macro.duration);
            playback.from += laps * macro.duration;
            elapsed -= laps * macro.duration;
        }
        const keys = macroKeysAt(macro, elapsed);
        if (keys !== playback.keys) {
            playback.keys = keys;
            this.input?.setMacroKeys(keys);
        }
    }

    protected changed(persistDefinitions = true, persistState = true): void {
        // first, so anything woken by the event below reads a list that already matches the two behind it
        this.recombine();
        if (persistState) {
            this.saveBrowserState();
            this.saveGlobalBrowserState();
        }
        if (persistDefinitions) {
            // both files, as marking a macro global removes from one and adds to the other; writing only one would duplicate
            // or lose it
            this.persisting = this.persisting
                .then(() => this.saveDefinitions())
                .then(() => this.saveGlobalDefinitions());
        }
        this.onDidChangeEmitter.fire();
    }

    dispose(): void {
        this.stop();
        this.onDidChangeEmitter.dispose();
    }
}

// stable identities let a repeat switch survive sorting or edits to other macros; per list, as there are two
function stateIdsOf(macros: ReadonlyArray<Macro>): string[] {
    const counts = new Map<string, number>();
    return macros.map(macro => {
        const base = JSON.stringify([macro.name, macro.duration, macro.steps]);
        const occurrence = counts.get(base) ?? 0;
        counts.set(base, occurrence + 1);
        return `${browserStateId(base)}:${occurrence}`;
    });
}

function writeLoopState(
    storage: browserStateStorage | undefined,
    key: string | undefined,
    macros: ReadonlyArray<Macro>,
): boolean {
    const ids = stateIdsOf(macros);
    const looping = macros.flatMap((macro, index) => macro.loop ? [ids[index]] : []);
    return writeVesBrowserState(storage, key, { looping }, macros.length === 0);
}
