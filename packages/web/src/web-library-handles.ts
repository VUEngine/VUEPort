/**
 * Browser side of library folders. A page gets a directory handle only from the picker, and it survives only in
 * IndexedDB (not localStorage, the JSON index or OPFS), hence this module, the build's only IndexedDB use. Permission
 * doesn't survive the tab, and a prompt needs a click, so nothing here asks on its own: permissionState reports,
 * requestPermission must run from an event handler, and the library shows "access needed". The desktop build has real
 * paths and doesn't come through here.
 */

// declared here as the picker and permission calls are missing from this toolchain's lib.dom (same as the values() cast
// in web-storage.ts)
interface DirectoryPickerOptions {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}

interface PermissionCapableHandle {
    queryPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

type DirectoryPicker = (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;

function picker(): DirectoryPicker | undefined {
    return (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
}

export function canPickDirectory(): boolean {
    return typeof picker() === 'function';
}

// must be called from a click, the browser rejects it without a gesture. Undefined when the picker is closed
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
    const show = picker();
    if (!show) {
        return undefined;
    }
    try {
        // `id` makes the picker reopen where it was left
        return await show({ id: 'vueport-library', mode: 'read', startIn: 'documents' });
    } catch {
        // AbortError for a closed picker, SecurityError without a gesture; neither is worth a message
        return undefined;
    }
}

export async function permissionState(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
    const query = (handle as PermissionCapableHandle).queryPermission;
    if (!query) {
        // handles without a permission API are granted for their lifetime; a failed read says otherwise
        return 'granted';
    }
    try {
        return await query.call(handle, { mode: 'read' });
    } catch {
        return 'prompt';
    }
}

// click only. A denial is final for this page load, so the caller should say so rather than offer the button again
export async function requestPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
    const request = (handle as PermissionCapableHandle).requestPermission;
    if (!request) {
        return 'granted';
    }
    try {
        return await request.call(handle, { mode: 'read' });
    } catch {
        return 'denied';
    }
}

const DB_NAME = 'vueport-library';
const DB_VERSION = 1;
const STORE = 'folders';

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
    return database ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) {
                request.result.createObjectStore(STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('The folder store could not be opened.'));
    }).catch(error => {
        // not kept, as private browsing can refuse once and allow later
        database = undefined;
        throw error;
    });
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDatabase().then(db => new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('The folder store could not be read.'));
    }));
}

export async function saveHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
    await transact('readwrite', store => store.put(handle, id));
}

export async function loadHandle(id: string): Promise<FileSystemDirectoryHandle | undefined> {
    try {
        const stored = await transact<unknown>('readonly', store => store.get(id) as IDBRequest<unknown>);
        return stored instanceof FileSystemDirectoryHandle ? stored : undefined;
    } catch {
        return undefined;
    }
}

export async function deleteHandle(id: string): Promise<void> {
    try {
        await transact('readwrite', store => store.delete(id));
    } catch {
        // a handle left by a failed delete is unreachable, not harmful: the index is the record of folders
    }
}
