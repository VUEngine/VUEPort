// desktop library folders are real paths, but the shell only reads folders its native panel handed over (see
// `src-tauri/src/library.rs`), so "add a folder" is that panel. No permission to lose: a folder stays readable
// until removed or its disk goes away (`library_folder_ready`)
import { bytesFrom, invoke } from './desktop-bridge';
import { LibraryFile, LibraryFolder } from './web-library-types';
import { LibraryAccess, LibrarySource, PickedFolder } from './web-library-source';
import { ScanCandidate } from './web-library-scan';
import { nls } from 'vueport-core/lib/common/emulator-nls';

interface ShellFile {
    path: string;
    name: string;
    size: number;
    modified: number;
}

export class DesktopLibrarySource implements LibrarySource {

    canAdd(): boolean {
        return true;
    }

    async pick(): Promise<PickedFolder | undefined> {
        const chosen = await invoke<{ path: string, name: string } | null>('pick_library_folder', {
            title: nls.localize('vueport/library/pickFolder', 'Choose a folder of ROMs'),
        });
        if (!chosen) {
            return undefined;
        }
        return {
            name: chosen.name,
            location: chosen.path,
            // nothing to keep, the shell recorded the path when the panel closed
            adopt: async () => undefined,
        };
    }

    async access(folder: LibraryFolder): Promise<LibraryAccess> {
        if (!folder.location) {
            return 'missing';
        }
        return await invoke<boolean>('library_folder_ready', { root: folder.location })
            ? 'granted'
            : 'missing';
    }

    // a folder is readable or gone, nothing to ask for
    async grant(folder: LibraryFolder): Promise<LibraryAccess> {
        return this.access(folder);
    }

    async forget(folder: LibraryFolder): Promise<void> {
        if (folder.location) {
            await invoke('forget_library_folder', { root: folder.location });
        }
    }

    async *candidates(folder: LibraryFolder, options: {
        subfolders: boolean,
        extensions: string[],
    }): AsyncIterable<ScanCandidate> {
        if (!folder.location) {
            return;
        }
        const root = folder.location;
        // the whole listing in one call, filtered on the other side, so other names never cross the bridge
        const files = await invoke<ShellFile[]>('scan_library_folder', {
            root,
            subfolders: options.subfolders,
            extensions: options.extensions,
        });
        for (const file of files) {
            yield {
                path: file.path,
                name: file.name,
                bytes: file.size,
                modifiedAt: file.modified,
                read: async () => bytesFrom(
                    await invoke<ArrayBuffer>('read_library_file', { root, path: file.path })),
            };
        }
    }

    // the shell checks the file is in a recorded folder and treats it as opened, which lets the save be written
    // beside it. See `open_library_file`
    async locate(folder: LibraryFolder, file: LibraryFile): Promise<string | undefined> {
        if (!folder.location) {
            return undefined;
        }
        return invoke<string>('open_library_file', { root: folder.location, path: file.path });
    }

    async read(folder: LibraryFolder, file: LibraryFile): Promise<Uint8Array> {
        if (!folder.location) {
            throw new Error('The folder that ROM is in is no longer known.');
        }
        return bytesFrom(await invoke<ArrayBuffer>('read_library_file', {
            root: folder.location,
            path: file.path,
        }));
    }
}
