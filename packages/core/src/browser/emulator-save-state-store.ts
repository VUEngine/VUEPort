import { Emitter, Event } from '../common/emulator-events';
import { VueportNotifications, VueportStorage } from '../common/emulator-host';
import { nls } from '../common/emulator-nls';
import {
    describeSaveState,
    rewriteSaveStateMeta,
    SaveStateKind,
    SaveStateOtherRomError,
    unwrapSaveState,
    VesEmulatorSaveStateIdentity,
    VesEmulatorSaveStateMeta,
    wrapSaveState,
} from '../common/emulator-save-state';
import { CompanionRom, EmulatorCompanionFiles } from './emulator-companion-files';

// one state as the browser shows it; all but `path` comes from the file (VesEmulatorSaveStateMeta). The machine
// data read with it is dropped at once, so twenty thumbnails do not hold twenty snapshots in memory
export interface SaveStateEntry {
    id: string;
    path: string;
    kind: SaveStateKind;
    // when it was taken, or 0 for a file that does not say
    created: number;
    label?: string;
    thumbnail?: string; // PNG `data:` URL of the moment, when the file carries one
    machines: number;
    size: number;
}

// declared here rather than imported from the widget, so the store depends on nothing above it. About machines
// rather than a session: a linked pair is two of them, and its state is one file holding both
export interface SaveStateMachine {
    readonly machineCount: number;
    // every machine's snapshot in player order, or nothing if none is running
    snapshot(): Promise<ArrayBuffer[] | undefined>;
    // `clearCaches` for states made with another ROM, whose instruction cache holds that ROM's code
    restore(states: ArrayBuffer[], options?: { clearCaches?: boolean }): Promise<void>;
    thumbnail(): Promise<Uint8Array | undefined>;
    identity(): VesEmulatorSaveStateIdentity | undefined;
    esSoundSnapshot(): unknown;
    esSoundRestore(snapshot: unknown): void;
}

function byRecency(a: SaveStateEntry, b: SaveStateEntry): number {
    if ((a.kind === 'suspend') !== (b.kind === 'suspend')) {
        return a.kind === 'suspend' ? -1 : 1;
    }
    if (a.created !== b.created) {
        return b.created - a.created;
    }
    return a.id < b.id ? 1 : -1;
}

// `data:image/png;base64,…`, in chunks small enough not to blow the argument list
function pngDataUrl(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `data:image/png;base64,${btoa(binary)}`;
}

// `20260917-134501-097`: sorts by time as a string, and reads as a date
function timestampId(when: Date): string {
    const pad = (value: number, width = 2): string => `${value}`.padStart(width, '0');
    return `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`
        + `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
        + `-${pad(when.getMilliseconds(), 3)}`;
}

// the one state a ROM is put away with; always this id, so it is overwritten
export const SUSPEND_STATE_ID = 'suspend';

/**
 * The running ROM's save states. No slots: saving always makes a new state, never replacing one, and the browser tells
 * them apart by picture and time. No index file either: the id is in the name and the rest in the file, so the list is
 * a directory listing and hand-copied states just appear; descriptions are cached by path and size, so only new or
 * changed files are read again.
 *
 * Three kinds (SaveStateKind): manual ones are never removed by the emulator; auto ones are taken on a timer and
 * rotate, a coarse rewind that survives a crash; the suspend state is one file, overwritten whenever a ROM is put away
 * and offered on the next launch.
 */
export class SaveStateStore {

    protected rom: CompanionRom | undefined;
    protected machine: SaveStateMachine | undefined;
    protected entries: SaveStateEntry[] = [];
    protected described = new Map<string, SaveStateEntry>();
    // refreshes run one after another, so two cannot interleave their lists
    protected refreshing: Promise<void> = Promise.resolve();

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(
        protected readonly storage: VueportStorage,
        protected readonly companions: EmulatorCompanionFiles,
    ) { }

    get list(): readonly SaveStateEntry[] {
        return this.entries;
    }

    get attached(): boolean {
        return this.rom !== undefined;
    }

    // both may be undefined, which is what closing a ROM does: the list empties and nothing can be saved or loaded
    async attach(rom: CompanionRom | undefined, machine: SaveStateMachine | undefined): Promise<void> {
        const changed = rom?.name !== this.rom?.name || rom?.location !== this.rom?.location;
        this.rom = rom;
        this.machine = machine;
        if (changed) {
            this.described.clear();
            this.entries = [];
            this.onDidChangeEmitter.fire();
        }
        if (rom) {
            await this.refresh();
        }
    }

    refresh(): Promise<void> {
        return this.refreshing = this.refreshing.then(() => this.readFolder()).catch(() => undefined);
    }

    protected async readFolder(): Promise<void> {
        const rom = this.rom;
        if (!rom) {
            return;
        }
        const files = await this.storage.list(this.companions.directory(rom)).catch(() => []);
        const found: SaveStateEntry[] = [];
        const seen = new Map<string, SaveStateEntry>();
        for (const file of files) {
            const id = this.companions.saveStateId(rom, file.name);
            if (id === undefined) {
                continue;
            }
            const key = `${file.path}:${file.size}`;
            const cached = this.described.get(key);
            const entry = cached ?? await this.describe(id, file.path, file.size);
            if (entry) {
                seen.set(key, entry);
                found.push(entry);
            }
        }
        this.described = seen;
        this.entries = found.sort(byRecency);
        this.onDidChangeEmitter.fire();
    }

    protected async describe(id: string, path: string, size: number): Promise<SaveStateEntry | undefined> {
        const bytes = await this.storage.read(path).catch(() => undefined);
        if (!bytes || bytes.length === 0) {
            return undefined;
        }
        const described = describeSaveState(bytes);
        if (!described) {
            return undefined;
        }
        // an unreadable metadata section (hand-edited file) still leaves a loadable state, listed without picture or date
        const meta = described.meta;
        return {
            id,
            path,
            size,
            kind: meta?.kind ?? 'manual',
            created: meta?.created ?? 0,
            label: meta?.label,
            thumbnail: meta?.thumbnail ? pngDataUrl(meta.thumbnail) : undefined,
            machines: described.machines,
        };
    }

    get latestManual(): SaveStateEntry | undefined {
        return this.entries.find(entry => entry.kind === 'manual');
    }

    get suspended(): SaveStateEntry | undefined {
        return this.entries.find(entry => entry.kind === 'suspend');
    }

    get autoStates(): SaveStateEntry[] {
        return this.entries.filter(entry => entry.kind === 'auto');
    }

    // always a new file for manual and automatic states, nothing is written over. The suspend state has a fixed
    // id, so every launch finds one state to offer
    async create(kind: SaveStateKind, label?: string): Promise<SaveStateEntry | undefined> {
        const rom = this.rom;
        const machine = this.machine;
        if (!rom || !machine) {
            return undefined;
        }
        const identity = machine.identity();
        const states = await machine.snapshot();
        if (!identity || !states || states.length === 0) {
            return undefined;
        }
        // best-effort: a machine that cannot be captured (paused before its first frame, unreadable surface) still
        // makes a good state, just without a picture
        const picture = await machine.thumbnail().catch(() => undefined);
        const when = new Date();
        const meta: VesEmulatorSaveStateMeta = {
            kind,
            created: when.getTime(),
            label,
            thumbnail: picture && picture.length > 0 ? picture : undefined,
            romName: rom.name,
        };
        const id = kind === 'suspend'
            ? SUSPEND_STATE_ID
            : await this.freeId(rom, kind === 'auto' ? `auto-${timestampId(when)}` : timestampId(when));
        const path = this.companions.saveState(rom, id);
        await this.storage.write(path, await wrapSaveState(states, identity, machine.esSoundSnapshot(), meta));
        await this.refresh();
        return this.entries.find(entry => entry.id === id);
    }

    // `base`, or `base-2`, `base-3`… whichever is free: the id is the millisecond it was taken, which an automatic
    // and a manual state can share (and time can be put back), and saving must never silently overwrite
    protected async freeId(rom: CompanionRom, base: string): Promise<string> {
        let id = base;
        for (let attempt = 2; await this.storage.exists(this.companions.saveState(rom, id)); attempt++) {
            id = `${base}-${attempt}`;
        }
        return id;
    }

    // the identity check keeps a state of another game, or of a linked pair in a solo window, from restoring nonsense.
    // Another ROM's state throws SaveStateOtherRomError unless `otherRom` allows it, so a host can warn and let a new
    // build of the same game go on
    async restore(entry: SaveStateEntry, options: { otherRom?: boolean } = {}): Promise<void> {
        const machine = this.machine;
        if (!machine) {
            throw new Error(nls.localize(
                'vueport/saveStates/noMachine', 'There is no game running to load a state into.'));
        }
        const identity = machine.identity();
        if (!identity) {
            throw new Error(nls.localize(
                'vueport/saveStates/noRom', 'There is no ROM running to load a state into.'));
        }
        const bytes = await this.storage.read(entry.path);
        const unwrapped = await unwrapSaveState(bytes, machine.machineCount, identity, options);
        await machine.restore(unwrapped.states, { clearCaches: unwrapped.otherRom });
        if (unwrapped.esSound !== undefined) {
            try {
                machine.esSoundRestore(JSON.parse(unwrapped.esSound));
            } catch {
                // a state with an unreadable audio section still restores the game; the tracks carry on as they were
            }
        }
    }

    async remove(entry: SaveStateEntry): Promise<void> {
        await this.storage.delete(entry.path);
        await this.refresh();
    }

    // the whole file is rewritten, as the name lives inside it and exported states keep it. Naming an automatic or
    // suspend state makes it a manual one, which the emulator would otherwise drop or overwrite
    async rename(entry: SaveStateEntry, label: string): Promise<void> {
        const rom = this.rom;
        if (!rom) {
            return;
        }
        const bytes = await this.storage.read(entry.path);
        const described = describeSaveState(bytes);
        if (!described || !described.meta) {
            throw new Error(nls.localize(
                'vueport/saveStates/cannotRename', 'This save state cannot be named.'));
        }
        const trimmed = label.trim();
        const named = trimmed.length > 0;
        const meta: VesEmulatorSaveStateMeta = {
            ...described.meta,
            kind: named && entry.kind !== 'manual' ? 'manual' : described.meta.kind,
            label: named ? trimmed : undefined,
        };
        if (meta.kind === described.meta.kind) {
            await this.storage.write(entry.path, rewriteSaveStateMeta(bytes, meta));
        } else {
            // a promoted state is renamed too: rotation finds automatic states by name, and the suspend name is the one
            // the next close writes over
            const id = await this.freeId(rom, timestampId(new Date(meta.created || Date.now())));
            await this.storage.write(this.companions.saveState(rom, id), rewriteSaveStateMeta(bytes, meta));
            await this.storage.delete(entry.path).catch(() => undefined);
        }
        await this.refresh();
    }

    async exportState(entry: SaveStateEntry): Promise<void> {
        const rom = this.rom;
        const bytes = await this.storage.read(entry.path);
        const stem = rom ? this.storage.stem(rom.name) : 'vueport';
        await this.storage.export(`${stem}.${entry.id}.state`, bytes);
    }

    // checked on import rather than on load, so another game's file is refused while the picker is still open.
    // Imported states are filed as manual, whatever they were
    async importState(
        fileName: string, bytes: Uint8Array, options: { otherRom?: boolean } = {},
    ): Promise<SaveStateEntry | undefined> {
        const rom = this.rom;
        const machine = this.machine;
        if (!rom) {
            return undefined;
        }
        const described = describeSaveState(bytes);
        if (!described) {
            throw new Error(nls.localize(
                'vueport/saveStates/notAState', 'This is not a save state file.'));
        }
        const identity = machine?.identity();
        if (identity) {
            await unwrapSaveState(bytes, described.machines, identity, options);
        }
        const when = new Date();
        const id = timestampId(when);
        const meta: VesEmulatorSaveStateMeta = {
            kind: 'manual',
            created: described.meta?.created ?? when.getTime(),
            label: described.meta?.label ?? this.storage.stem(fileName),
            thumbnail: described.meta?.thumbnail,
            romName: rom.name,
        };
        await this.storage.write(this.companions.saveState(rom, id), rewriteSaveStateMeta(bytes, meta));
        await this.refresh();
        return this.entries.find(entry => entry.id === id);
    }

    // only automatic states, ever: being the only ones that go away on their own is what makes taking one every
    // minute safe
    async pruneAuto(keep: number): Promise<void> {
        const extra = this.autoStates.slice(Math.max(0, keep));
        if (extra.length === 0) {
            return;
        }
        for (const entry of extra) {
            await this.storage.delete(entry.path).catch(() => undefined);
        }
        await this.refresh();
    }

    async clearSuspended(): Promise<void> {
        const suspended = this.suspended;
        if (suspended) {
            await this.storage.delete(suspended.path).catch(() => undefined);
            await this.refresh();
        }
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}

// runs a save state action and, if it is another ROM's, offers to do it anyway: often another build of the same
// game, where a state from before the change is what testing wants. False when declined; other errors throw
export async function withOtherRomOffer(
    notifications: VueportNotifications,
    action: 'load' | 'import',
    run: (options: { otherRom?: boolean }) => Promise<unknown>,
): Promise<boolean> {
    try {
        await run({});
        return true;
    } catch (error) {
        if (!(error instanceof SaveStateOtherRomError)) {
            throw error;
        }
    }
    const agreed = await notifications.confirm({
        title: nls.localize('vueport/saveStates/otherRomTitle', 'Save State of Another ROM'),
        message: [
            nls.localize('vueport/saveStates/otherRomMessage',
                'This save state was made with a different ROM — another game, or another build of this one.'),
            nls.localize('vueport/saveStates/otherRomHint',
                'A state of an earlier build usually works as long as the build did not move code or memory around. '
                + 'Of another game, it will not.'),
        ],
        okLabel: action === 'load'
            ? nls.localize('vueport/saveStates/otherRomLoad', 'Load Anyway')
            : nls.localize('vueport/saveStates/otherRomImport', 'Import Anyway'),
    });
    if (agreed) {
        await run({ otherRom: true });
    }
    return agreed;
}
