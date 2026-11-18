/**
 * A library folder copied into this origin's own storage at import, the only kind that works in every browser. There
 * is no permission to lose, and the folder is only gone if the browser cleared the storage. candidates walks an index
 * written at import time, so ROMs added to the real folder later need another import. The copying itself is in
 * web-library-import.ts.
 */
import { VueportStorage } from 'vueport-core/lib/common/emulator-host';
import { LibraryFile, LibraryFolder } from './web-library-types';
import { LibraryAccess, LibrarySource, PickedFolder } from './web-library-source';
import { ScanCandidate } from './web-library-scan';
import {
    canImportDirectory,
    chooseDirectory,
    clearImport,
    importDirOf,
    importDirectory,
    readImportIndex,
} from './web-library-import';

export class ImportedLibrarySource implements LibrarySource {

    constructor(protected readonly storage: VueportStorage) { }

    canAdd(): boolean {
        return canImportDirectory();
    }

    async pick(): Promise<PickedFolder | undefined> {
        const chosen = await chooseDirectory();
        if (!chosen) {
            return undefined;
        }
        return {
            name: chosen.name || 'ROMs',
            // no location, as a page is not told where the folder was
            adopt: (id, onProgress) => importDirectory(
                this.storage,
                id,
                chosen,
                onProgress && (progress => onProgress({
                    files: progress.files,
                    total: progress.total,
                    current: progress.current,
                })),
            ).then(() => undefined),
        };
    }

    // missing means the copy itself was deleted (cleared site data or eviction), which is why web-durable-storage.ts
    // exists
    async access(folder: LibraryFolder): Promise<LibraryAccess> {
        return (await readImportIndex(this.storage, folder.id)) ? 'granted' : 'missing';
    }

    async grant(folder: LibraryFolder): Promise<LibraryAccess> {
        return this.access(folder);
    }

    async forget(folder: LibraryFolder): Promise<void> {
        await clearImport(this.storage, folder.id);
    }

    async *candidates(folder: LibraryFolder, options: {
        subfolders: boolean,
        extensions: string[],
    }): AsyncIterable<ScanCandidate> {
        const index = await readImportIndex(this.storage, folder.id);
        if (!index) {
            return;
        }
        const directory = importDirOf(folder.id);
        for (const file of index.files) {
            // the import applied these rules already, but the switches can be turned off later and should apply without
            // re-importing
            if (!options.subfolders && file.path.includes('/')) {
                continue;
            }
            const lowered = file.name.toLowerCase();
            if (!options.extensions.some(extension => lowered.endsWith(extension))) {
                continue;
            }
            yield {
                path: file.path,
                name: file.name,
                bytes: file.bytes,
                // the original file's time, not the copy time, as the scan skips unchanged files by it
                modifiedAt: file.modifiedAt,
                read: () => this.storage.read(`${directory}/${file.store}`),
            };
        }
    }

    async read(folder: LibraryFolder, file: LibraryFile): Promise<Uint8Array> {
        const index = await readImportIndex(this.storage, folder.id);
        const found = index?.files.find(entry => entry.path === file.path);
        if (!found) {
            throw new Error('That ROM is not in the copy of this folder any more.');
        }
        return this.storage.read(`${importDirOf(folder.id)}/${found.store}`);
    }
}
