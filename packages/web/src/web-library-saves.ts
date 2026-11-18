/**
 * Which library ROMs have save data, for the shelf's "Has save data" filter. Read rather than recorded: saves land in
 * the companion store (`roms/<ROM name>/save.sram` and its slots) from whatever played them, including by hand, so
 * this looks again each time the shelf opens. Only the store is looked in: with `companionFiles` a save sits beside the
 * ROM in the user's own folder, which the library can't reach in a browser and shouldn't open on the desktop. So the
 * filter under-reports rather than lies.
 */
import { VueportFile, VueportStorage } from 'vueport-core/lib/common/emulator-host';
import { COMPANION_STORE_ROOT } from 'vueport-core/lib/browser/emulator-companion-files';
import { SUSPEND_STATE_ID } from 'vueport-core/lib/browser/emulator-save-state-store';

const CONCURRENCY = 8; // each is cheap, but a library of two hundred starts them all while the shelf is drawn

export class LibrarySaves {

    protected readonly saved = new Set<string>(); // lower-cased stems
    protected readonly put = new Set<string>();
    protected readonly asked = new Set<string>();
    protected pass: Promise<boolean> | undefined;

    constructor(protected readonly storage: VueportStorage) { }

    // false also for a ROM not looked for yet, as the shelf draws before the looking is done; read fires a change when
    // it turns out yes
    has(name: string): boolean {
        // by the file's name as read takes it, not the stem it is filed under, as the two can differ
        return this.saved.has(this.storage.stem(name).toLowerCase());
    }

    // same caveats as has
    suspended(name: string): boolean {
        return this.put.has(this.storage.stem(name).toLowerCase());
    }

    // for when the companion store was just emptied
    forget(): void {
        this.saved.clear();
        this.put.clear();
        this.asked.clear();
    }

    // resolves true when something new was found, the cue to redraw. `again` starts over, as a game played since may
    // have written its first save
    read(names: Iterable<string>, again = false): Promise<boolean> {
        if (again) {
            this.asked.clear();
        }
        if (this.pass) {
            return this.pass;
        }
        const wanted = new Map<string, string>();
        for (const name of names) {
            const stem = this.storage.stem(name);
            const key = stem.toLowerCase();
            // keyed lower-case, looked for in the case it was written in: folders differing only in case are one ROM,
            // and the store's folder is named exactly as the file is
            if (stem && !this.asked.has(key) && !wanted.has(key)) {
                wanted.set(key, stem);
            }
        }
        if (wanted.size === 0) {
            return Promise.resolve(false);
        }
        this.pass = this.look([...wanted]).finally(() => { this.pass = undefined; });
        return this.pass;
    }

    protected async look(wanted: [string, string][]): Promise<boolean> {
        let found = false;
        const queue = [...wanted];
        const worker = async (): Promise<void> => {
            for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
                const [key, stem] = next;
                this.asked.add(key);
                const files = await this.listFolder(stem);
                found = this.note(this.saved, key, hasSaveFile(files)) || found;
                found = this.note(this.put, key, hasSuspendFile(files)) || found;
            }
        };
        await Promise.all(Array.from(
            { length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
        return found;
    }

    // both ways round: a deleted save is a game no longer under way, a declined or discarded suspend state one with
    // nothing left to resume
    protected note(set: Set<string>, key: string, present: boolean): boolean {
        if (present) {
            const added = !set.has(key);
            set.add(key);
            return added;
        }
        return set.delete(key);
    }

    protected listFolder(stem: string): Promise<VueportFile[]> {
        const directory = this.storage.join(COMPANION_STORE_ROOT, stem);
        return this.storage.list(directory).catch((): VueportFile[] => []);
    }
}

// any .sram, as a second player's and other slots are named differently. An empty file is not a save: the emulator
// writes one when a battery cartridge is opened and never written to
function hasSaveFile(files: VueportFile[]): boolean {
    return files.some(file => file.name.toLowerCase().endsWith('.sram') && file.size > 0);
}

// EmulatorCompanionFiles.saveState files the suspend state under SUSPEND_STATE_ID
function hasSuspendFile(files: VueportFile[]): boolean {
    const name = `state-${SUSPEND_STATE_ID}.state`;
    return files.some(file => file.name === name && file.size > 0);
}
