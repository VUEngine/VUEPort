import { Emitter, Event } from '../common/emulator-events';
import { VueportStorage } from '../common/emulator-host';
import {
    builtInCheatsFor,
    CHEAT_DATABASE,
    VesBuiltInCheat,
    VesCheatDatabaseEntry,
} from '../common/emulator-cheat-database';
import {
    enabledVesCheatCodes,
    parseVesCheatCodes,
    parseVesCheatFile,
    serializeVesCheatFile,
    VesCheat,
    vesCheatCodeBytes,
} from '../common/emulator-cheats';
import { VesVbSim } from './core/vb-core';

/**
 * One emulator's cheats: the list, the file it lives in, and pushing the
 * enabled ones into the core.
 *
 * Held by the widget rather than by the Cheats panel, for two reasons: cheats
 * stay in effect while that panel is closed, and the file has to be loaded as
 * soon as the ROM is, whether or not anyone has opened the panel. The panel
 * edits through this and redraws on onDidChange.
 *
 * The file is `<rom>.cht` beside the ROM, the same convention save RAM
 * follows, in the format `vueport-cheats.ts` documents — so cheats
 * written by RetroArch, or by hand from gamehacking.org, are picked up as they
 * are. It exists only while there are cheats to put in it: the first one
 * creates it and removing the last one deletes it, rather than leaving a file
 * saying there are none beside every ROM that was ever run.
 */
export class VesEmulatorCheatStore {

    /** The player's own, which is what the `.cht` file beside the ROM holds. */
    protected custom: VesCheat[] = [];
    /** What the emulator ships for this ROM, if it knows it. */
    protected builtIn: VesCheat[] = [];
    /** Where the built-ins' on/off state is kept, since the `.cht` cannot hold it. */
    protected statePath: string | undefined;
    protected sim: VesVbSim | undefined;
    protected uri: string | undefined;
    /** Set once a file has been read, so a first save cannot precede a load. */
    protected loaded = false;
    /**
     * Saves run one after another rather than at once: an edit and the edit
     * undoing it are a write and a delete, and the wrong order would leave the
     * file behind.
     */
    protected persisting: Promise<void> = Promise.resolve();

    protected readonly onDidChangeEmitter = new Emitter<void>();
    /** Fires whenever the list changes, whatever changed it. */
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(
        protected readonly storage: VueportStorage,
        /**
         * The cheats to ship. Defaults to the emulator's own, and is a
         * parameter so a host can add to them — and so this can be given a
         * fixture rather than whatever happens to be in the database today.
         */
        protected readonly database: VesCheatDatabaseEntry[] = CHEAT_DATABASE,
    ) { }

    /**
     * Every cheat, the shipped ones first.
     *
     * One list rather than two, because a player looking for a cheat does not
     * care where it came from — only the few operations that would change a
     * built-in care, and they check `builtIn` (see `remove` and `update`).
     */
    get list(): ReadonlyArray<VesCheat> {
        return [...this.builtIn, ...this.custom];
    }

    /** Where a list index falls: a shipped cheat, or one of the player's. */
    protected at(index: number): { cheat: VesCheat, custom: number } | undefined {
        if (index < 0) {
            return undefined;
        }
        if (index < this.builtIn.length) {
            return { cheat: this.builtIn[index], custom: -1 };
        }
        const custom = index - this.builtIn.length;
        return this.custom[custom] ? { cheat: this.custom[custom], custom } : undefined;
    }

    /** Where the cheats are stored, once a ROM is known. */
    get filePath(): string | undefined {
        return this.uri;
    }

    /** The file's name, for the panel to show. */
    get fileName(): string | undefined {
        return this.uri === undefined ? undefined : this.storage.name(this.uri);
    }

    get isLoaded(): boolean {
        return this.loaded;
    }

    /**
     * Read what belongs to a ROM, replacing whatever was loaded before.
     *
     * Three things, from three places: the player's cheats from the `.cht`
     * file beside the ROM, the shipped ones from the database, and which of
     * the shipped ones are switched on from a small file of its own. That last
     * one exists because the `.cht` format has nowhere to say "this is one of
     * yours and it is on" — writing a built-in into it would make it the
     * player's copy, editable and deletable and frozen at today's version.
     *
     * `romId` is the ROM's CRC32; without one the database is simply not
     * consulted, which is the ordinary case for homebrew and for a build in
     * progress.
     */
    async load(romPath: string, romId?: string): Promise<void> {
        const directory = this.storage.parent(romPath);
        const stem = this.storage.stem(romPath);
        this.uri = this.storage.join(directory, `${stem}.cht`);
        this.statePath = this.storage.join(directory, `${stem}.vueport-cheats.json`);
        this.custom = [];
        this.builtIn = [];
        try {
            if (await this.storage.exists(this.uri)) {
                this.custom = parseVesCheatFile(await this.storage.readText(this.uri));
            }
            this.builtIn = this.readBuiltIn(romId, await this.readEnabledBuiltIns());
            this.loaded = true;
        } catch (error) {
            // A cheat file that cannot be read is not worth failing a launch
            // over: the emulator runs, with no cheats, and says why.
            console.warn(`[emulator] could not read cheats from ${this.uri}:`, error);
            this.loaded = false;
        }
        this.changed(false);
    }

    /** The shipped cheats for a ROM, as cheats, with their state restored. */
    protected readBuiltIn(romId: string | undefined, enabled: Set<string>): VesCheat[] {
        return builtInCheatsFor(romId, this.database).map((cheat: VesBuiltInCheat) => ({
            description: cheat.description,
            enabled: enabled.has(cheat.id),
            // Parsed from the published form, so a database entry can be
            // pasted from a cheat list unchanged — the same text the `.cht`
            // file holds.
            codes: parseVesCheatCodes(cheat.codes),
            builtIn: true,
            id: cheat.id,
        }));
    }

    /** Which shipped cheats were left switched on, from the file beside the ROM. */
    protected async readEnabledBuiltIns(): Promise<Set<string>> {
        if (!this.statePath || !await this.storage.exists(this.statePath)) {
            return new Set();
        }
        try {
            const stored = JSON.parse(await this.storage.readText(this.statePath));
            return new Set(Array.isArray(stored?.enabled) ? stored.enabled : []);
        } catch (error) {
            // Nothing here is worth failing over: the worst case is that some
            // shipped cheats come up switched off.
            console.warn(`[emulator] could not read ${this.statePath}:`, error);
            return new Set();
        }
    }

    /** The simulation the enabled cheats apply to, or undefined once it is gone. */
    setSim(sim: VesVbSim | undefined): void {
        this.sim = sim;
        this.apply();
    }

    add(description: string): number {
        this.custom.push({ description, enabled: false, codes: [] });
        this.changed();
        return this.list.length - 1;
    }

    /**
     * Take one of the player's cheats away.
     *
     * A shipped cheat is not the player's to remove — the next release may
     * correct it, and a copy deleted here would come back anyway — so this
     * quietly does nothing for one. The panel does not offer it either; this
     * is the guard behind that, not the whole of it.
     */
    remove(index: number): void {
        const found = this.at(index);
        if (!found || found.custom < 0) {
            return;
        }
        this.custom.splice(found.custom, 1);
        this.changed();
    }

    /**
     * Change one cheat: its name, whether it is on, or its codes.
     *
     * On a shipped cheat only `enabled` takes effect: what it is called and
     * what it writes are the database's to say.
     */
    update(index: number, patch: Partial<VesCheat>): void {
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
        this.changed();
    }

    /**
     * Push the enabled writes into the core, replacing whatever was there.
     *
     * The core repeats them at every frame break for as long as they are set,
     * so this is the only call needed — there is no per-frame work on this
     * side at all.
     */
    protected apply(): void {
        this.sim?.setCheats(enabledVesCheatCodes([...this.list]).map(code => ({
            address: code.address,
            value: code.value,
            bytes: vesCheatCodeBytes(code),
        })));
    }

    /**
     * Write the file back, or take it away once the last cheat is gone.
     *
     * Saving on every edit is deliberate: a cheat is a few bytes of text, and
     * a list that quietly failed to outlive the window it was typed in would
     * be worse than a rare redundant write. A load that failed does not save,
     * so a file that could not be read is neither overwritten from an empty
     * list nor deleted.
     */
    protected async save(): Promise<void> {
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
                await this.storage.writeText(uri, serializeVesCheatFile(this.custom));
            }
        } catch (error) {
            console.warn(`[emulator] could not store cheats in ${uri}:`, error);
        }
        await this.saveEnabledBuiltIns();
    }

    /**
     * Remember which shipped cheats are switched on.
     *
     * Kept apart from the `.cht` file rather than in it: that file is the
     * player's own list, in a format other emulators read, and a built-in
     * written into it would stop being the database's — it would no longer
     * follow a correction, and it would become deletable. Only the ids go
     * here; the cheats themselves come from the database every time.
     */
    protected async saveEnabledBuiltIns(): Promise<void> {
        const path = this.statePath;
        if (!path) {
            return;
        }
        const enabled = this.builtIn.filter(cheat => cheat.enabled).map(cheat => cheat.id);
        try {
            if (enabled.length === 0) {
                if (await this.storage.exists(path)) {
                    await this.storage.delete(path);
                }
                return;
            }
            await this.storage.writeText(path, JSON.stringify({ enabled }, undefined, 2) + '\n');
        } catch (error) {
            console.warn(`[emulator] could not store cheat state in ${path}:`, error);
        }
    }

    protected changed(persist = true): void {
        this.apply();
        if (persist) {
            this.persisting = this.persisting.then(() => this.save());
        }
        this.onDidChangeEmitter.fire();
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}
