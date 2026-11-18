// browser library folders are granted handles (see also `web-library-handles.ts`): the handle survives only in
// IndexedDB, permission ends with the tab, and asking again needs a user click
import { LibraryFile, LibraryFolder } from './web-library-types';
import { LibraryAccess, LibrarySource, PickedFolder } from './web-library-source';
import { ScanCandidate } from './web-library-scan';
import {
    canPickDirectory,
    deleteHandle,
    loadHandle,
    permissionState,
    pickDirectory,
    requestPermission,
    saveHandle,
} from './web-library-handles';

const MAX_DEPTH = 8; // a home directory gets a slow read, not an unbounded one; the desktop shell uses the same limit

// `values()` is declared in lib.dom.asynciterable, which this toolchain's ESLint parser refuses to load
function childrenOf(handle: FileSystemDirectoryHandle): AsyncIterable<FileSystemHandle> {
    return (handle as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
}

export class BrowserLibrarySource implements LibrarySource {

    canAdd(): boolean {
        return canPickDirectory();
    }

    async pick(): Promise<PickedFolder | undefined> {
        const handle = await pickDirectory();
        if (!handle) {
            return undefined;
        }
        return {
            name: handle.name || 'ROMs',
            adopt: id => saveHandle(id, handle), // no location, as a page is not told where the folder is
        };
    }

    async access(folder: LibraryFolder): Promise<LibraryAccess> {
        const handle = await loadHandle(folder.id);
        return handle ? permissionState(handle) : 'missing';
    }

    async grant(folder: LibraryFolder): Promise<LibraryAccess> {
        const handle = await loadHandle(folder.id);
        return handle ? requestPermission(handle) : 'missing';
    }

    async forget(folder: LibraryFolder): Promise<void> {
        await deleteHandle(folder.id);
    }

    async *candidates(folder: LibraryFolder, options: {
        subfolders: boolean,
        extensions: string[],
    }): AsyncIterable<ScanCandidate> {
        const handle = await loadHandle(folder.id);
        if (!handle) {
            return;
        }
        yield* this.walk(handle, '', 0, options);
    }

    protected async *walk(
        directory: FileSystemDirectoryHandle,
        prefix: string,
        depth: number,
        options: { subfolders: boolean, extensions: string[] },
    ): AsyncIterable<ScanCandidate> {
        for await (const child of childrenOf(directory)) {
            // dot-directories are version control's, dot-files editor swap files
            if (child.name.startsWith('.')) {
                continue;
            }
            const path = prefix ? `${prefix}/${child.name}` : child.name;
            if (child.kind === 'directory') {
                if (options.subfolders && depth < MAX_DEPTH) {
                    yield* this.walk(child as FileSystemDirectoryHandle, path, depth + 1, options);
                }
                continue;
            }
            const lowered = child.name.toLowerCase();
            if (!options.extensions.some(extension => lowered.endsWith(extension))) {
                continue;
            }
            let file: File;
            try {
                file = await (child as FileSystemFileHandle).getFile();
            } catch {
                // deleted between the walk and the read, or permission ended mid-pass
                continue;
            }
            yield {
                path,
                name: child.name,
                bytes: file.size,
                modifiedAt: file.lastModified,
                read: async () => new Uint8Array(await file.arrayBuffer()),
            };
        }
    }

    async read(folder: LibraryFolder, file: LibraryFile): Promise<Uint8Array> {
        const handle = await loadHandle(folder.id);
        if (!handle) {
            throw new Error('The folder that ROM is in is no longer known.');
        }
        // Chrome forgets the grant between sessions; the Play click that got us here lets it ask again
        let state = await permissionState(handle);
        if (state === 'prompt') {
            state = await requestPermission(handle);
        }
        if (state !== 'granted') {
            throw new Error('VUEPort may not read that folder any more.');
        }
        const segments = file.path.split('/').filter(segment => segment.length > 0);
        const name = segments.pop() ?? file.name;
        let directory = handle;
        for (const segment of segments) {
            directory = await directory.getDirectoryHandle(segment);
        }
        return new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer());
    }
}
