import { Emitter, Event } from '../common/emulator-events';
import { cheatNotes, cheatTitle } from '../common/emulator-catalog-nls';
import { VueportStorage } from '../common/emulator-host';
import {
    anchorCheatCodeToRomTop,
    builtInCheatsFor,
    CHEAT_DATABASE,
    BuiltInCheat,
    CheatDatabaseEntry,
} from '../common/emulator-cheat-database';
import {
    enabledVesCheatCodes,
    parseVesCheatCodes,
    parseVesCheatFile,
    serializeVesCheatFile,
    Cheat,
    vesCheatCodeBytes,
} from '../common/emulator-cheats';
import { Sim } from './core/vb-core';
import { VbCheatWrite } from '../common/vb-protocol';
import {
    readVesBrowserState,
    browserStateStorage,
    browserStateId,
    browserStateKey,
    writeVesBrowserState,
} from './emulator-browser-state';

interface StoredCheatState {
    enabled?: string[];
}

// held by the widget rather than the Cheats panel, as cheats stay active while the panel is closed. User cheats live
// in `<rom>.cht` beside the ROM (format in emulator-cheats.ts, RetroArch/gamehacking.org compatible), which only
// exists while there are any
export class CheatStore {

    protected custom: Cheat[] = [];
    protected builtIn: Cheat[] = [];
    protected browserStateKey: string | undefined;
    protected sim: Sim | undefined;
    // set while a link session owns where these writes go, see setScheduler
    protected scheduler: ((codes: VbCheatWrite[]) => boolean) | undefined;
    protected uri: string | undefined;
    // set once a file has been read, so a save can't happen before the load
    protected loaded = false;
    // saves are serialized: an edit and its undo are a write and a delete, and the wrong order would leave the file
    protected persisting: Promise<void> = Promise.resolve();

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(
        protected readonly storage: VueportStorage,
        protected readonly database: CheatDatabaseEntry[] = CHEAT_DATABASE,
        protected readonly stateStorage?: browserStateStorage,
    ) { }

    // built-in ones first, in one list as users don't care where a cheat came from; remove and update check
    // `builtIn` themselves
    get list(): ReadonlyArray<Cheat> {
        return [...this.builtIn, ...this.custom];
    }

    // resolves a list index; `custom` is the index into the user's cheats, -1 for a built-in one
    protected at(index: number): { cheat: Cheat, custom: number } | undefined {
        if (index < 0) {
            return undefined;
        }
        if (index < this.builtIn.length) {
            return { cheat: this.builtIn[index], custom: -1 };
        }
        const custom = index - this.builtIn.length;
        return this.custom[custom] ? { cheat: this.custom[custom], custom } : undefined;
    }

    get filePath(): string | undefined {
        return this.uri;
    }

    get fileName(): string | undefined {
        return this.uri === undefined ? undefined : this.storage.name(this.uri);
    }

    get isLoaded(): boolean {
        return this.loaded;
    }

    // on/off comes from browser storage only, never from `cheatN_enable` in the file. Without `romId` (CRC32) the
    // database is skipped (homebrew, work in progress); `romSize` is the unpatched length, so built-in ROM writes
    // still land when a patch has grown the ROM (see anchorCheatCodeToRomTop)
    async load(romPath: string, romId?: string, romSize?: number): Promise<void> {
        const directory = this.storage.parent(romPath);
        const stem = this.storage.stem(romPath);
        this.uri = this.storage.join(directory, `${stem}.cht`);
        this.browserStateKey = browserStateKey('cheats', romPath);
        this.custom = [];
        this.builtIn = [];
        try {
            if (await this.storage.exists(this.uri)) {
                this.custom = parseVesCheatFile(await this.storage.readText(this.uri));
            }
            this.builtIn = this.readBuiltIn(romId, romSize);
            const stored = readVesBrowserState<StoredCheatState>(
                this.stateStorage, this.browserStateKey);
            this.restoreEnabled(Array.isArray(stored?.enabled)
                ? new Set(stored.enabled.filter(id => typeof id === 'string'))
                : new Set());
            this.loaded = true;
        } catch (error) {
            // an unreadable cheat file is not worth failing a launch over: run without cheats and say why
            console.warn(`[emulator] could not read cheats from ${this.uri}:`, error);
            this.loaded = false;
        }
        this.changed(false, false);
    }

    // all off until restoreEnabled
    protected readBuiltIn(romId: string | undefined, romSize?: number): Cheat[] {
        return builtInCheatsFor(romId, this.database).map((cheat: BuiltInCheat) => ({
            // localized, which works because only the id of a built-in cheat is ever stored (see stateIds)
            description: cheatTitle(cheat),
            enabled: false,
            // parsed from the published form, so database entries can be pasted from a cheat list as they are
            codes: parseVesCheatCodes(cheat.codes)
                .map(code => romSize === undefined ? code : anchorCheatCodeToRomTop(code, romSize)),
            notes: cheatNotes(cheat),
            builtIn: true,
            id: cheat.id,
        }));
    }

    // stable-enough ids for user cheats without adding ids to the `.cht` file
    protected stateIds(): string[] {
        const counts = new Map<string, number>();
        const custom = this.custom.map(cheat => {
            const base = JSON.stringify([
                cheat.description,
                cheat.notes ?? '',
                cheat.codes.map(code => [code.address, code.value, code.digits]),
            ]);
            const occurrence = counts.get(base) ?? 0;
            counts.set(base, occurrence + 1);
            return `custom:${browserStateId(base)}:${occurrence}`;
        });
        return [
            ...this.builtIn.map(cheat => `built-in:${cheat.id}`),
            ...custom,
        ];
    }

    protected restoreEnabled(enabled: Set<string>): void {
        const ids = this.stateIds();
        this.builtIn = this.builtIn.map((cheat, index) => ({ ...cheat, enabled: enabled.has(ids[index]) }));
        this.custom = this.custom.map((cheat, index) => ({
            ...cheat,
            enabled: enabled.has(ids[this.builtIn.length + index]),
        }));
    }

    protected saveBrowserState(): boolean {
        const ids = this.stateIds();
        const enabled = this.list.flatMap((cheat, index) => cheat.enabled ? [ids[index]] : []);
        return writeVesBrowserState(
            this.stateStorage, this.browserStateKey, { enabled }, this.list.length === 0);
    }

    setSim(sim: Sim | undefined): void {
        this.sim = sim;
        this.apply();
    }

    // during a link session the writes go through it, as they must reach the mirror machine on the same frame or the
    // two diverge. The scheduler returns false if it couldn't book them, then they go straight in; undefined goes back
    // to writing directly, as when leaving a session
    setScheduler(scheduler: ((codes: VbCheatWrite[]) => boolean) | undefined): void {
        // deliberately not re-applying: on joining, running cheats travel as the session's standing edits, and on
        // leaving, the switches made during it already went through
        this.scheduler = scheduler;
    }

    // what apply pushes; a link session sends the same list to the other window when a run starts (standingEdits in
    // link-session.ts)
    get writes(): VbCheatWrite[] {
        return enabledVesCheatCodes([...this.list]).map(code => ({
            address: code.address,
            value: code.value,
            bytes: vesCheatCodeBytes(code),
        }));
    }

    add(description: string): number {
        this.custom.push({ description, enabled: false, codes: [] });
        this.changed(true, true);
        return this.list.length - 1;
    }

    // imports as the user's own cheats, all off whatever the file says, as an import shouldn't switch writes on
    importCheats(cheats: readonly Cheat[]): number {
        const added = cheats
            .filter(cheat => cheat.codes.length > 0)
            .map(cheat => ({
                description: cheat.description,
                enabled: false,
                codes: [...cheat.codes],
            }));
        this.custom.push(...added);
        if (added.length > 0) {
            this.changed(true, true);
        }
        return added.length;
    }

    // a built-in cheat can't be removed (it would come back with the next release); the panel doesn't offer it either
    remove(index: number): void {
        const found = this.at(index);
        if (!found || found.custom < 0) {
            return;
        }
        this.custom.splice(found.custom, 1);
        this.changed(true, true);
    }

    // on a built-in cheat only `enabled` takes effect, name and writes come from the database
    update(index: number, patch: Partial<Cheat>): void {
        const found = this.at(index);
        if (!found) {
            return;
        }
        if (found.custom < 0) {
            if (patch.enabled === undefined || patch.enabled === found.cheat.enabled) {
                return;
            }
            this.builtIn[index] = { ...found.cheat, enabled: patch.enabled };
        } else {
            this.custom[found.custom] = { ...found.cheat, ...patch, builtIn: undefined, id: undefined };
        }
        const definitionChanged = found.custom >= 0
            && Object.keys(patch).some(key => key !== 'enabled');
        this.changed(definitionChanged, true);
    }

    // for hardcore mode, as an active cheat would make following unlocks unearned
    disableAll(): void {
        let any = false;
        const off = (cheat: Cheat): Cheat => {
            if (!cheat.enabled) {
                return cheat;
            }
            any = true;
            return { ...cheat, enabled: false };
        };
        this.builtIn = this.builtIn.map(off);
        this.custom = this.custom.map(off);
        if (any) {
            this.changed(false, true);
        }
    }

    // the core repeats the writes at every frame break, so there is no per-frame work here
    protected apply(): void {
        const codes = this.writes;
        // a link session books them for a frame both windows can still reach, and only falls through if it can't
        if (this.scheduler?.(codes)) {
            return;
        }
        this.sim?.setCheats(codes);
    }

    // saved on every edit, with all switches off (those live in browser storage); deletes the file after the last
    // cheat. Skipped after a failed load, so an unreadable file is neither overwritten nor deleted
    protected async saveDefinitions(): Promise<void> {
        const uri = this.uri;
        if (!uri || !this.loaded) {
            return;
        }
        try {
            if (this.custom.length === 0) {
                if (await this.storage.exists(uri)) {
                    await this.storage.delete(uri);
                }
            } else {
                await this.storage.writeText(uri, serializeVesCheatFile(
                    this.custom.map(cheat => ({ ...cheat, enabled: false }))));
            }
        } catch (error) {
            console.warn(`[emulator] could not store cheats in ${uri}:`, error);
        }
    }

    protected changed(persistDefinitions = true, persistState = true): void {
        this.apply();
        if (persistState) {
            this.saveBrowserState();
        }
        if (persistDefinitions) {
            this.persisting = this.persisting.then(() => this.saveDefinitions());
        }
        this.onDidChangeEmitter.fire();
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}
