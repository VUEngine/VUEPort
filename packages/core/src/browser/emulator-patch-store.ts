import { Emitter, Event } from '../common/emulator-events';
import { patchDescription, patchName } from '../common/emulator-catalog-nls';
import { crc32, formatRomId } from '../common/emulator-cheat-database';
import { nls } from '../common/emulator-nls';
import {
    COLOR_EDIT_BUILD_EXTENSION,
    COLOR_EDIT_EXTENSION,
    COLOR_EDIT_PATCH_ID,
} from '../common/vb-color-package';
import { VueportStorage } from '../common/emulator-host';
import {
    builtInPatchesFor,
    PATCH_DATABASE,
    BuiltInRomPatch,
    RomPatchDatabaseEntry,
} from '../common/emulator-patch-database';
import {
    applyRomPatches,
    detectRomPatchFormat,
    isColorPatch,
    RomPatch,
    RomPatchFormat,
    RomPatchType,
    ROM_PATCH_TYPES,
} from '../common/emulator-rom-patches';
import {
    readVesBrowserState,
    browserStateStorage,
    browserStateKey,
    writeVesBrowserState,
} from './emulator-browser-state';

// patch bytes travel as base64 in a JSON file. atob/btoa rather than the `buffer` package (25 KB of bundle);
// encoded in chunks, as one String.fromCharCode call with a million arguments overflows the stack

const BASE64_CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
    }
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

interface StoredPatch {
    id: string;
    name: string;
    fileName: string;
    format: RomPatchFormat;
    // the patch file's bytes, in base64
    data: string;
    description?: string;
    author?: string;
    type?: RomPatchType;
}

interface StoredPatchState {
    patches?: StoredPatch[];
}

interface StoredBrowserPatchState {
    enabled?: string[];
    // shipped patches on by default that the player switched off
    disabled?: string[];
}

export type RomPatchMetadata = Pick<RomPatch,
    'name' | 'description' | 'author' | 'type'>;

const patchType = (value: unknown): RomPatchType =>
    ROM_PATCH_TYPES.includes(value as RomPatchType)
        ? value as RomPatchType
        : 'hack';

export interface ColorPatchChoice {
    // the master switch, vbcAutoApplyColorPatches
    autoApply: boolean;
    // ids switched off individually, vbcColorPatchesDisabled
    disabled: readonly string[];
}

// what the patch store needs to offer a game's VB Color colorizations, which are host settings, not patch switches.
// Master off keeps all off; on, each colorization answers for itself. A switched-off one is still listed, to switch on
// again
export interface PatchStoreColorizations {
    // whether auto-apply is on and which colorizations are off; also says no in hardcore, as a colorization is a
    // ROM patch and must not come on by itself there
    choice(): ColorPatchChoice;
    remember(id: string, apply: boolean): void;
}

export interface PatchStoreChange {
    affectsRom: boolean; // a change to the ROM requires a restart
}

// built-in and imported patches for the current original ROM. Imported definitions live in the companion JSON,
// switches in browser storage (built-ins never appear in that file). The game's colorizations are shipped
// patches listed first, whose on/off lives in the colorization settings (see PatchStoreColorizations)
export class PatchStore {
    // the colorization the color editor's build was made on (from its document beside it): what comes back on when
    // the build is removed
    protected editBase: string | undefined;
    // colorizations first (the color editor's build, if any, ahead of the shipped ones), otherwise in catalog order
    protected builtIn: RomPatch[] = [];
    protected custom: RomPatch[] = [];
    protected sourceRom: Uint8Array | undefined;
    protected statePath: string | undefined;
    protected browserStateKey: string | undefined;
    protected loaded = false;
    protected persisting: Promise<void> = Promise.resolve();
    protected lockReason: string | undefined;

    protected readonly onDidChangeEmitter = new Emitter<PatchStoreChange>();
    readonly onDidChange: Event<PatchStoreChange> = this.onDidChangeEmitter.event;

    // loadFile reads a shipped patch's `file` relative to the host's assets; without it no shipped patches, without
    // `colorizations` no colorizations
    constructor(
        protected readonly storage: VueportStorage,
        protected readonly database: readonly RomPatchDatabaseEntry[] = PATCH_DATABASE,
        protected readonly stateStorage?: browserStateStorage,
        protected readonly loadFile?: (file: string) => Promise<Uint8Array>,
        protected readonly colorizations?: PatchStoreColorizations,
    ) { }

    // refuses every change to the running ROM with a reason, or allows them again without one. For link sessions:
    // every machine in both windows runs the first player's image, and a patch in one window would diverge them
    setLocked(reason: string | undefined): void {
        this.lockReason = reason;
    }

    get locked(): string | undefined {
        return this.lockReason;
    }

    protected refuseIfLocked(): void {
        if (this.lockReason !== undefined) {
            throw new Error(this.lockReason);
        }
    }

    get list(): ReadonlyArray<RomPatch> {
        return [...this.builtIn, ...this.custom];
    }

    get active(): number {
        return this.list.filter(patch => patch.enabled).length;
    }

    // patches on, not counting colorizations: what the badge over the picture shows
    get activeOutsideColor(): number {
        return this.list.filter(patch => patch.enabled && !isColorPatch(patch)).length;
    }

    protected at(index: number): { patch: RomPatch, list: 'builtIn' | 'custom', at: number } | undefined {
        if (index < 0) {
            return undefined;
        }
        if (index < this.builtIn.length) {
            return { patch: this.builtIn[index], list: 'builtIn', at: index };
        }
        const custom = index - this.builtIn.length;
        return this.custom[custom] ? { patch: this.custom[custom], list: 'custom', at: custom } : undefined;
    }

    async load(romPath: string, romId: string | undefined, sourceRom: Uint8Array): Promise<void> {
        const directory = this.storage.parent(romPath);
        const stem = this.storage.stem(romPath);
        this.statePath = this.storage.join(directory, `${stem}.vueport-patches.json`);
        this.browserStateKey = browserStateKey('patches', romPath);
        this.sourceRom = sourceRom.slice();
        this.builtIn = [];
        this.custom = [];
        let state: StoredPatchState = {};
        try {
            if (await this.storage.exists(this.statePath)) {
                const parsed = JSON.parse(await this.storage.readText(this.statePath));
                if (parsed && typeof parsed === 'object') {
                    state = parsed;
                }
            }
            this.builtIn = [
                ...await this.readEditColorization(directory, stem),
                ...await this.readBuiltIns(builtInPatchesFor(romId, this.database)
                    .filter(patch => !isColorPatch(patch) || this.colorizations)),
            ];
            this.custom = (Array.isArray(state.patches) ? state.patches : [])
                .filter(patch => patch && typeof patch.data === 'string')
                .map(patch => {
                    const data = fromBase64(patch.data);
                    return {
                        id: String(patch.id),
                        name: String(patch.name),
                        fileName: String(patch.fileName),
                        format: detectRomPatchFormat(data),
                        data,
                        enabled: false,
                        description: typeof patch.description === 'string' ? patch.description : undefined,
                        author: typeof patch.author === 'string' ? patch.author : undefined,
                        type: patchType(patch.type),
                    };
                });
            const stored = readVesBrowserState<StoredBrowserPatchState>(
                this.stateStorage, this.browserStateKey);
            const ids = (list: unknown): Set<string> => new Set(Array.isArray(list)
                ? list.filter((id): id is string => typeof id === 'string')
                : []);
            const enabled = ids(stored?.enabled);
            const disabled = ids(stored?.disabled);
            this.custom = this.custom.map(patch => ({
                ...patch,
                enabled: enabled.has(patch.id!),
            }));
            // colorizations are alternatives, so at most one is on: a player's own switched on, else the first shipped one
            // the settings leave on
            const choice = this.colorizations?.choice();
            let colored = this.custom.some(patch => patch.enabled && isColorPatch(patch));
            this.builtIn = this.builtIn.map(patch => {
                const on = isColorPatch(patch)
                    ? !colored && !!choice?.autoApply && !choice.disabled.includes(patch.id!)
                    : enabled.has(patch.id!) || (!!patch.enabledByDefault && !disabled.has(patch.id!));
                colored ||= on && isColorPatch(patch);
                return { ...patch, enabled: on };
            });
            this.apply(sourceRom);
            this.loaded = true;
        } catch (error) {
            console.warn(`[emulator] could not read patches from ${this.statePath}:`, error);
            this.builtIn = this.builtIn.map(patch => ({ ...patch, enabled: false }));
            this.custom = this.custom.map(patch => ({ ...patch, enabled: false }));
            this.loaded = true;
        }
        this.changed(false, false, false);
    }

    // read up front, as applying is synchronous (the ROM is rebuilt the moment a switch flips). An unreadable one is
    // left out with a warning rather than listed with nothing behind its switch. Colorizations first, as listed
    protected async readBuiltIns(patches: BuiltInRomPatch[]): Promise<RomPatch[]> {
        const loadFile = this.loadFile;
        if (!loadFile) {
            return [];
        }
        const read = await Promise.all(patches.map(async (shipped): Promise<RomPatch | undefined> => {
            const { file, ...patch } = shipped;
            try {
                return {
                    ...patch,
                    // in the player's language; only the id is ever stored
                    name: patchName(shipped),
                    description: patchDescription(shipped),
                    data: await loadFile(file),
                    enabled: false,
                    builtIn: true,
                };
            } catch (error) {
                console.warn(`[emulator] could not read the shipped patch ${file}:`, error);
                return undefined;
            }
        }));
        const found = read.filter((patch): patch is RomPatch => patch !== undefined);
        return [...found.filter(isColorPatch), ...found.filter(patch => !isColorPatch(patch))];
    }

    // the color editor's build beside the ROM, listed ahead of the shipped colorizations, so once the user has built
    // their own colors it comes on by itself unless switched off. Not builtIn, as it can be removed
    protected async readEditColorization(directory: string, stem: string): Promise<RomPatch[]> {
        const path = this.storage.join(directory, `${stem}${COLOR_EDIT_BUILD_EXTENSION}`);
        this.editBase = undefined;
        if (!this.colorizations || !(await this.storage.exists(path))) {
            return [];
        }
        try {
            const document = JSON.parse(await this.storage.readText(this.storage.join(directory, `${stem}${COLOR_EDIT_EXTENSION}`)));
            this.editBase = typeof document?.base?.patch === 'string' ? document.base.patch : undefined;
        } catch {
        }
        const data = await this.storage.read(path);
        return [{
            id: COLOR_EDIT_PATCH_ID,
            name: nls.localize('vueport/vbColor/editPatchName', 'VB Color Enhanced (my colors)'),
            fileName: `${stem}${COLOR_EDIT_BUILD_EXTENSION}`,
            format: detectRomPatchFormat(data),
            data,
            enabled: false,
            description: nls.localize('vueport/vbColor/editPatchDescription',
                'Built in the VB Color Editor from the colorization\'s package and your paint.'),
            type: 'vb-color',
            status: 'wip',
        }];
    }

    // the color editor just wrote its build: reads it again and switches it on, the other colorizations off, as a
    // switch in the list would. Fires a change that affects the ROM, as that does
    async useColorEditBuild(): Promise<void> {
        if (!this.statePath || !this.sourceRom) {
            return;
        }
        this.refuseIfLocked();
        const directory = this.storage.parent(this.statePath);
        const stem = this.storage.name(this.statePath).replace(/\.vueport-patches\.json$/, '');
        const build = await this.readEditColorization(directory, stem);
        if (build.length === 0) {
            return;
        }
        this.builtIn = [build[0], ...this.builtIn.filter(patch => patch.id !== COLOR_EDIT_PATCH_ID)];
        this.replace(this.builtIn[0], { ...build[0], enabled: true });
        this.colorizations?.remember(COLOR_EDIT_PATCH_ID, true);
        this.changed(false, true, true);
    }

    unload(): void {
        this.editBase = undefined;
        this.builtIn = [];
        this.custom = [];
        this.sourceRom = undefined;
        this.statePath = undefined;
        this.browserStateKey = undefined;
        this.loaded = false;
        this.changed(false, false, false);
    }

    importPatch(fileName: string, data: Uint8Array): number {
        if (!this.loaded || !this.sourceRom) {
            throw new Error('No ROM is loaded.');
        }
        const format = detectRomPatchFormat(data);
        // validate source compatibility without changing the running ROM; an imported patch never enables itself
        this.validateResult(applyRomPatches(this.sourceRom, [{
            name: fileName,
            fileName,
            format,
            data,
            enabled: true,
            type: 'hack',
        }]));
        const id = `custom-${format}-${formatRomId(crc32(data))}`;
        const existing = this.custom.findIndex(candidate => candidate.id === id);
        const patch: RomPatch = {
            id,
            name: fileName.replace(/\.(ips|ups|bps|bdf|bspatch)$/i, '') || fileName,
            fileName,
            format,
            data: data.slice(),
            enabled: false,
            type: 'hack',
        };
        if (existing >= 0) {
            this.custom[existing] = patch;
            this.changed(true, true, false);
            return this.builtIn.length + existing;
        }
        this.custom.push(patch);
        this.changed(true, true, false);
        return this.list.length - 1;
    }

    // only the type can touch the ROM: an enabled patch that becomes or stops being a colorization applies
    // differently, so that change is validated and restarts the game like a switch
    updateMetadata(index: number, metadata: Partial<RomPatchMetadata>): void {
        const found = this.at(index);
        if (!found || found.list !== 'custom') {
            return;
        }
        const clean: Partial<RomPatchMetadata> = {
            ...metadata,
            type: metadata.type === undefined ? undefined : patchType(metadata.type),
        };
        // undefined means "not part of this edit"
        if (metadata.type === undefined) {
            delete clean.type;
        }
        const updated = { ...found.patch, ...clean };
        if (!found.patch.enabled || isColorPatch(updated) === isColorPatch(found.patch)) {
            this.custom[found.at] = updated;
            this.changed(true, true, false);
            return;
        }
        this.refuseIfLocked();
        this.replace(found.patch, updated);
        this.changed(true, true, true);
    }

    // validates the entire resulting chain. Switching a colorization on switches the game's others off (see
    // replace); a shipped one's choice is kept in the colorization settings
    setEnabled(index: number, enabled: boolean): void {
        const found = this.at(index);
        if (!found || found.patch.enabled === enabled || !this.sourceRom) {
            return;
        }
        this.refuseIfLocked();
        const changed = { ...found.patch, enabled };
        this.replace(found.patch, changed);
        if (found.list === 'builtIn' && isColorPatch(changed)) {
            this.colorizations?.remember(changed.id!, enabled);
        }
        this.changed(false, true, true);
    }

    // puts `changed` in place of `patch`, validating the resulting chain. A colorization left on turns all others
    // off, as each is made against the original ROM; shipped others are recorded off, or an earlier one in the
    // catalog would win on the next launch
    protected replace(patch: RomPatch, changed: RomPatch): void {
        const colorOn = changed.enabled && isColorPatch(changed);
        const swap = (candidate: RomPatch): RomPatch => candidate === patch
            ? changed
            : colorOn && candidate.enabled && isColorPatch(candidate) ? { ...candidate, enabled: false } : candidate;
        const builtIn = this.builtIn.map(swap);
        const custom = this.custom.map(swap);
        this.validateResult(applyRomPatches(this.sourceRom!, [...builtIn, ...custom]));
        if (colorOn) {
            this.builtIn.filter(other => isColorPatch(other) && other !== patch)
                .forEach(other => this.colorizations?.remember(other.id!, false));
        }
        this.builtIn = builtIn;
        this.custom = custom;
    }

    remove(index: number): void {
        const found = this.at(index);
        if (!found || (found.list !== 'custom' && found.patch.id !== COLOR_EDIT_PATCH_ID)) {
            return;
        }
        if (found.patch.enabled) {
            this.refuseIfLocked();
        }
        const affectsRom = found.patch.enabled;
        if (found.list === 'custom') {
            this.custom.splice(found.at, 1);
            this.changed(true, true, affectsRom);
            return;
        }
        this.removeEditBuild(found.patch.enabled);
        this.changed(false, true, affectsRom);
    }

    // takes the color editor's build away (file and list entry); the paint stays. A build that was on hands back to the
    // colorization it was made on, or the game would lose its colors, as switching the build on recorded every other
    // one as off
    protected removeEditBuild(wasEnabled: boolean): void {
        this.builtIn = this.builtIn.filter(patch => patch.id !== COLOR_EDIT_PATCH_ID);
        this.colorizations?.remember(COLOR_EDIT_PATCH_ID, false);
        const base = wasEnabled ? this.builtIn.find(patch => patch.id === this.editBase) : undefined;
        if (base && this.sourceRom) {
            try {
                this.replace(base, { ...base, enabled: true });
                this.colorizations?.remember(base.id!, true);
            } catch (error) {
                console.warn('[emulator] the color edit\'s base does not apply on its own:', error);
            }
        }
        const statePath = this.statePath;
        if (statePath) {
            const path = this.storage.join(this.storage.parent(statePath),
                this.storage.name(statePath).replace(/\.vueport-patches\.json$/, COLOR_EDIT_BUILD_EXTENSION));
            this.persisting = this.persisting.then(() => this.storage.delete(path)).catch(error =>
                console.warn(`[emulator] could not remove ${path}:`, error));
        }
    }

    disableAll(): void {
        if (this.active === 0) {
            return;
        }
        this.refuseIfLocked();
        this.builtIn = this.builtIn.map(patch => ({ ...patch, enabled: false }));
        this.custom = this.custom.map(patch => ({ ...patch, enabled: false }));
        this.changed(false, true, true);
    }

    apply(source: Uint8Array): Uint8Array {
        return this.validateResult(applyRomPatches(source, this.list));
    }

    // the Virtual Boy core accepts cartridge images in power-of-two sizes
    protected validateResult(result: Uint8Array): Uint8Array {
        if (result.length === 0 || !Number.isInteger(Math.log2(result.length))) {
            throw new Error('The patch result is not a power-of-two-sized Virtual Boy ROM.');
        }
        return result;
    }

    whenSaved(): Promise<void> {
        return this.persisting;
    }

    protected changed(persistDefinitions: boolean, persistState: boolean, affectsRom: boolean): void {
        if (persistState) {
            this.saveBrowserState();
        }
        if (persistDefinitions) {
            this.persisting = this.persisting.then(() => this.saveDefinitions());
        }
        this.onDidChangeEmitter.fire({ affectsRom });
    }

    // patch switches; a shipped colorization's, and the color editor build's, are in the colorization settings instead
    protected saveBrowserState(): boolean {
        const enabled = this.list.filter(patch => patch.enabled
            && !(isColorPatch(patch) && (patch.builtIn || patch.id === COLOR_EDIT_PATCH_ID)))
            .map(patch => patch.id!);
        const disabled = this.builtIn.filter(patch => patch.enabledByDefault && !patch.enabled)
            .map(patch => patch.id!);
        return writeVesBrowserState(
            this.stateStorage, this.browserStateKey, { enabled, disabled }, this.list.length === 0);
    }

    protected async saveDefinitions(): Promise<void> {
        const path = this.statePath;
        if (!path || !this.loaded) {
            return;
        }
        const patches: StoredPatch[] = this.custom.map(patch => ({
            id: patch.id!,
            name: patch.name,
            fileName: patch.fileName,
            format: patch.format,
            data: toBase64(patch.data),
            description: patch.description,
            author: patch.author,
            type: patch.type,
        }));
        try {
            if (patches.length === 0) {
                if (await this.storage.exists(path)) {
                    await this.storage.delete(path);
                }
            } else {
                await this.storage.writeText(path, JSON.stringify({ patches }, undefined, 2) + '\n');
            }
        } catch (error) {
            console.warn(`[emulator] could not store patches in ${path}:`, error);
        }
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}
