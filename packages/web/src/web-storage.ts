import { VueportFile, VueportStorage, VueportUsage } from 'vueport-core/lib/common/emulator-host';
import { MemoryDirectoryHandle } from './web-storage-memory';

// OPFS, as save states and cart RAM can run to megabytes and are written without a file picker; export is the one way
// out, as a download. Paths are `/`-separated from the OPFS root, composed only with parent, stem, name and join
export class WebStorage implements VueportStorage {

    protected root: Promise<FileSystemDirectoryHandle> | undefined;

    // onUnavailable is told once, with the browser's reason, when OPFS is refused and files are kept in memory
    constructor(protected readonly onUnavailable?: (error: unknown) => void) { }

    protected getRoot(): Promise<FileSystemDirectoryHandle> {
        return this.root ??= this.openRoot();
    }

    // Firefox refuses OPFS in a private window and when site data is blocked, which would fail every read and write
    // (opening a ROM included), so it falls back to memory once here
    protected async openRoot(): Promise<FileSystemDirectoryHandle> {
        try {
            return await navigator.storage.getDirectory();
        } catch (error) {
            console.warn('[vueport] the origin-private file system is unavailable, keeping files in memory:', error);
            this.onUnavailable?.(error);
            return new MemoryDirectoryHandle() as unknown as FileSystemDirectoryHandle;
        }
    }

    // create is for a write, which may need new directories; a read reports a miss instead of leaving empty directories
    // behind
    protected async directoryOf(path: string, create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
        const segments = path.split('/').filter(s => s.length > 0);
        segments.pop();
        let directory = await this.getRoot();
        for (const segment of segments) {
            try {
                directory = await directory.getDirectoryHandle(segment, { create });
            } catch {
                return undefined;
            }
        }
        return directory;
    }

    protected async fileOf(path: string, create: boolean): Promise<FileSystemFileHandle | undefined> {
        const directory = await this.directoryOf(path, create);
        if (!directory) {
            return undefined;
        }
        try {
            return await directory.getFileHandle(this.name(path), { create });
        } catch {
            return undefined;
        }
    }

    async read(path: string): Promise<Uint8Array> {
        const handle = await this.fileOf(path, false);
        if (!handle) {
            throw new Error(`No such file: ${path}`);
        }
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    }

    async readText(path: string): Promise<string> {
        const handle = await this.fileOf(path, false);
        if (!handle) {
            throw new Error(`No such file: ${path}`);
        }
        return (await handle.getFile()).text();
    }

    async write(path: string, data: Uint8Array): Promise<void> {
        const handle = await this.fileOf(path, true);
        if (!handle) {
            throw new Error(`Could not create file: ${path}`);
        }
        const writable = await handle.createWritable();
        // data may be a view into a larger buffer, and write would store all of it
        await writable.write(data.slice());
        await writable.close();
    }

    async writeText(path: string, text: string): Promise<void> {
        await this.write(path, new TextEncoder().encode(text));
    }

    async exists(path: string): Promise<boolean> {
        return (await this.fileOf(path, false)) !== undefined;
    }

    async delete(path: string): Promise<void> {
        const directory = await this.directoryOf(path, false);
        if (!directory) {
            return;
        }
        try {
            await directory.removeEntry(this.name(path), { recursive: true });
        } catch {
            // already gone, which is what the caller asked for
        }
    }

    async list(directory: string): Promise<VueportFile[]> {
        // directoryOf drops the last segment, so ask it about a child that does not need to exist
        const handle = await this.directoryOf(this.join(directory, 'x'), false);
        if (!handle) {
            return [];
        }
        const files: VueportFile[] = [];
        // values() is declared in lib.dom.asynciterable, which the ESLint parser in this toolchain refuses to load
        const entries = handle as unknown as { values(): AsyncIterable<FileSystemHandle> };
        for await (const entry of entries.values()) {
            if (entry.kind !== 'file') {
                continue;
            }
            const file = await (entry as FileSystemFileHandle).getFile();
            files.push({ path: this.join(directory, entry.name), name: entry.name, size: file.size });
        }
        return files;
    }

    async measure(directory: string): Promise<VueportUsage> {
        const handle = await this.directoryOf(this.join(directory, 'x'), false);
        const usage = { bytes: 0, files: 0 };
        const walk = async (current: FileSystemDirectoryHandle): Promise<void> => {
            // see list for why the iterator is declared here
            const entries = current as unknown as { values(): AsyncIterable<FileSystemHandle> };
            for await (const entry of entries.values()) {
                if (entry.kind === 'directory') {
                    await walk(entry as FileSystemDirectoryHandle);
                } else {
                    usage.bytes += (await (entry as FileSystemFileHandle).getFile()).size;
                    usage.files++;
                }
            }
        };
        if (handle) {
            await walk(handle);
        }
        return usage;
    }

    parent(path: string): string {
        const index = path.lastIndexOf('/');
        return index <= 0 ? '' : path.slice(0, index);
    }

    stem(path: string): string {
        const name = this.name(path);
        const dot = name.lastIndexOf('.');
        return dot <= 0 ? name : name.slice(0, dot);
    }

    name(path: string): string {
        const index = path.lastIndexOf('/');
        return index < 0 ? path : path.slice(index + 1);
    }

    join(directory: string, name: string): string {
        if (!directory) {
            return name;
        }
        return `${directory.replace(/\/+$/, '')}/${name}`;
    }

    async export(name: string, data: Uint8Array): Promise<void> {
        // for the user, so it leaves OPFS entirely
        await this.exportBlob(name, new Blob([data.slice()], { type: 'application/octet-stream' }));
    }

    // for something that already is a blob, such as a video recording of tens of megabytes, which would otherwise be
    // copied twice
    async exportBlob(name: string, blob: Blob): Promise<void> {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        // revoking immediately can cancel the download in some browsers
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
}
