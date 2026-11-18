/**
 * Reads a folder VUEPort is handed once, as a pile of files it must copy or lose (web-library-handles.ts is for folders
 * it is granted a handle to). Firefox and Safari have no directory picker and won't get one: Mozilla calls the local
 * disk half of the File System Access API harmful, WebKit opposes it, and Safari 26 shipped only the origin-private
 * part. <input webkitdirectory> gives one change event with a flat FileList carrying webkitRelativePath: no handle, no
 * permission, no way back. Even in Chrome a copy is the only way a library survives a disk that isn't plugged in. The
 * copy is a snapshot; files added later need a re-import (reimportFolder).
 */
import { VueportStorage } from 'vueport-core/lib/common/emulator-host';
import { MAX_ROM_BYTES, ROM_EXTENSIONS, VB_ARCHIVE_EXTENSIONS } from './web-rom-source';
import { scanArchives, scanSubfolders } from './web-library-settings';

// same limit as the handle walk and the desktop shell: a folder that deep is a home directory by mistake
const MAX_DEPTH = 8;

// a ROM is at most 16 MB, but a .zip of a dozen is larger; this is meant to skip the 700 MB video in the folder
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const IMPORT_DIR = 'library/imported';

export function importDirOf(folderId: string): string {
    return `${IMPORT_DIR}/${folderId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'folder'}`;
}

export function importIndexPath(folderId: string): string {
    return `${importDirOf(folderId)}/index.json`;
}

export interface ImportedFile {
    path: string; // relative to the folder's root, /-separated
    name: string;
    bytes: number;
    modifiedAt: number;
    // a number rather than the original path, which would need every directory in between and names surviving a file
    // system's opinions on `:` and segment length
    store: string;
    // Planet VB downloads group of a downloaded file (see appendImport), so the catalog pages know a release is already
    // here
    release?: string;
}

export interface ImportedIndex {
    version: 1;
    name: string;
    importedAt: number;
    files: ImportedFile[];
}

export interface ImportProgress {
    files: number;
    total: number;
    current?: string;
}

// own type, as the one cause worth telling (the storage quota) can only be met by importing less
export class ImportError extends Error {
    constructor(message: string, readonly outOfSpace: boolean) {
        super(message);
        this.name = 'ImportError';
    }
}

// the picker

// iOS Safari accepted the attribute and ignored it until 18.4, and a picker returning nothing is worse than no button
export function canImportDirectory(): boolean {
    return typeof document !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;
}

export interface ChosenDirectory {
    name: string;
    files: File[]; // already narrowed to what is worth copying
    skipped: number; // box scans, readmes, saves
}

// undefined when nothing was chosen; must be called from a click. A fresh input each time, as one remembering the last
// FileList could import the same folder twice
export function chooseDirectory(): Promise<ChosenDirectory | undefined> {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        // webkitdirectory is what engines implement, directory what was standardised
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
        input.style.display = 'none';

        let done = false;
        const finish = (value: ChosenDirectory | undefined): void => {
            if (done) {
                return;
            }
            done = true;
            input.remove();
            resolve(value);
        };

        input.addEventListener('change', () => {
            const files = [...(input.files ?? [])];
            finish(files.length > 0 ? narrow(files) : undefined);
        });
        // not fired in every browser, which is why finish is idempotent and nothing waits on it
        input.addEventListener('cancel', () => finish(undefined));

        document.body.append(input);
        input.click();
    });
}

// the handle walk's rules, applied before writing to storage: extension first (free), size second
function narrow(files: File[]): ChosenDirectory {
    const archives = scanArchives();
    const subfolders = scanSubfolders();
    const extensions = archives
        ? [...ROM_EXTENSIONS, ...VB_ARCHIVE_EXTENSIONS, '.zip']
        : [...ROM_EXTENSIONS, ...VB_ARCHIVE_EXTENSIONS];

    // webkitRelativePath is empty in a browser that ignored the attribute and gave loose files, which then all sit at
    // the top
    const name = files
        .map(file => file.webkitRelativePath.split('/')[0])
        .find(segment => !!segment) ?? 'ROMs';

    const kept: File[] = [];
    for (const file of files) {
        const relative = relativePathOf(file, name);
        const segments = relative.split('/');
        // .git, .Trash, an editor's swap file
        if (segments.some(segment => segment.startsWith('.'))) {
            continue;
        }
        if (!subfolders && segments.length > 1) {
            continue;
        }
        if (segments.length > MAX_DEPTH + 1) {
            continue;
        }
        const lowered = file.name.toLowerCase();
        if (!extensions.some(extension => lowered.endsWith(extension))) {
            continue;
        }
        const isArchive = lowered.endsWith('.zip') || VB_ARCHIVE_EXTENSIONS.some(e => lowered.endsWith(e));
        if (file.size === 0 || file.size > (isArchive ? MAX_ARCHIVE_BYTES : MAX_ROM_BYTES)) {
            continue;
        }
        kept.push(file);
    }
    return { name, files: kept, skipped: files.length - kept.length };
}

function relativePathOf(file: File, folderName: string): string {
    const full = file.webkitRelativePath || file.name;
    const prefix = `${folderName}/`;
    return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

// the store

// one file in memory at a time. The index is written last, so a copy that dies half way leaves unreferenced files
// (swept by forget) rather than an index promising missing bytes
export async function importDirectory(
    storage: VueportStorage,
    folderId: string,
    chosen: ChosenDirectory,
    onProgress?: (progress: ImportProgress) => void,
    signal?: AbortSignal,
): Promise<ImportedIndex> {
    const directory = importDirOf(folderId);
    // swept first rather than swapped at the end, as holding both copies doubles the cost when the browser is most
    // likely to refuse. Library.reimportFolder knows a failed re-import leaves nothing
    await clearImport(storage, folderId);

    const files: ImportedFile[] = [];
    let copied = 0;
    for (const file of chosen.files) {
        if (signal?.aborted) {
            throw new ImportError('The import was stopped.', false);
        }
        const path = relativePathOf(file, chosen.name);
        onProgress?.({ files: copied, total: chosen.files.length, current: path });
        // numbered rather than named (see ImportedFile.store); the extension only helps in a debugger
        const store = `${String(files.length).padStart(4, '0')}${extensionOf(file.name)}`;
        try {
            await storage.write(`${directory}/${store}`, new Uint8Array(await file.arrayBuffer()));
        } catch (error) {
            // quota is the one failure worth naming; what was written stays, and the caller drops and sweeps the folder
            const quota = error instanceof DOMException
                && (error.name === 'QuotaExceededError' || error.name === 'NotAllowedError');
            throw new ImportError(String((error as Error)?.message ?? error), quota);
        }
        files.push({
            path,
            name: file.name,
            bytes: file.size,
            modifiedAt: file.lastModified,
            store,
        });
        copied += 1;
    }
    onProgress?.({ files: copied, total: chosen.files.length });

    const index: ImportedIndex = { version: 1, name: chosen.name, importedAt: Date.now(), files };
    await storage.writeText(importIndexPath(folderId), JSON.stringify(index));
    return index;
}

export interface AppendedFile {
    name: string;
    data: Uint8Array;
    release?: string;
}

// creates the copy when there is none and keeps what it holds, as a folder of downloads grows one release at a time.
// Paths are flat, numbered on a clash, as the scan may skip subfolders and downloads must not be hidden. The index is
// rewritten after every file, so a stopped batch keeps what arrived
export async function appendImport(
    storage: VueportStorage,
    folderId: string,
    name: string,
    files: AppendedFile[],
): Promise<ImportedIndex> {
    const directory = importDirOf(folderId);
    const index: ImportedIndex = await readImportIndex(storage, folderId)
        ?? { version: 1, name, importedAt: Date.now(), files: [] };
    const taken = new Set(index.files.map(file => file.path.toLowerCase()));
    let next = index.files.reduce((highest, file) =>
        Math.max(highest, Number.parseInt(file.store, 10) + 1 || 0), 0);
    for (const file of files) {
        const store = `${String(next).padStart(4, '0')}${extensionOf(file.name)}`;
        try {
            await storage.write(`${directory}/${store}`, file.data);
        } catch (error) {
            const quota = error instanceof DOMException
                && (error.name === 'QuotaExceededError' || error.name === 'NotAllowedError');
            throw new ImportError(String((error as Error)?.message ?? error), quota);
        }
        next += 1;
        const path = uniqueName(file.name, taken);
        taken.add(path.toLowerCase());
        index.files.push({
            path,
            name: path,
            bytes: file.data.byteLength,
            modifiedAt: Date.now(),
            store,
            release: file.release,
        });
        index.importedAt = Date.now();
        await storage.writeText(importIndexPath(folderId), JSON.stringify(index));
    }
    return index;
}

// name, name (2), name (3), ... before the extension
function uniqueName(name: string, taken: ReadonlySet<string>): string {
    const clean = name.replace(/[\\/]/g, '_') || 'ROM.vb';
    if (!taken.has(clean.toLowerCase())) {
        return clean;
    }
    const dot = clean.lastIndexOf('.');
    const stem = dot > 0 ? clean.slice(0, dot) : clean;
    const extension = dot > 0 ? clean.slice(dot) : '';
    for (let count = 2; ; count++) {
        const candidate = `${stem} (${count})${extension}`;
        if (!taken.has(candidate.toLowerCase())) {
            return candidate;
        }
    }
}

function extensionOf(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
}

export async function readImportIndex(
    storage: VueportStorage,
    folderId: string,
): Promise<ImportedIndex | undefined> {
    try {
        const parsed = JSON.parse(await storage.readText(importIndexPath(folderId))) as ImportedIndex;
        return parsed?.version === 1 && Array.isArray(parsed.files) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export async function removeFromImport(
    storage: VueportStorage,
    folderId: string,
    paths: Iterable<string>,
): Promise<void> {
    const index = await readImportIndex(storage, folderId);
    if (!index) {
        return;
    }
    const wanted = new Set(paths);
    const going = index.files.filter(file => wanted.has(file.path));
    if (going.length === 0) {
        return;
    }
    // the index first: bytes outliving their line are swept with the folder, while a line without bytes is a ROM that
    // cannot be opened
    index.files = index.files.filter(file => !wanted.has(file.path));
    await storage.writeText(importIndexPath(folderId), JSON.stringify(index));
    const directory = importDirOf(folderId);
    for (const file of going) {
        await storage.delete(`${directory}/${file.store}`).catch(() => undefined);
    }
}

// lists the directory rather than the index, as a copy that stopped half way has files the index never had
export async function clearImport(storage: VueportStorage, folderId: string): Promise<void> {
    const directory = importDirOf(folderId);
    try {
        for (const file of await storage.list(directory)) {
            await storage.delete(file.path).catch(() => undefined);
        }
        // fails harmlessly on a store that will not remove directories this way
        await storage.delete(directory).catch(() => undefined);
    } catch {
        // nothing there, or the storage would not say; the index decides whether the folder exists, and the caller
        // rewrites or drops it
    }
}
