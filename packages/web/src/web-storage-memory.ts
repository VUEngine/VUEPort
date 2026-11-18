// stand-in for when the browser refuses OPFS (Firefox private window, blocked site data). Saves last until the page
// closes, which beats a game that does not start at all
export class MemoryDirectoryHandle {

    readonly kind = 'directory';

    protected readonly entries = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();

    constructor(readonly name = '') { }

    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectoryHandle> {
        const entry = this.entries.get(name);
        if (entry instanceof MemoryDirectoryHandle) {
            return entry;
        }
        if (entry) {
            throw new DOMException(`${name} is a file`, 'TypeMismatchError');
        }
        if (!options?.create) {
            throw new DOMException(`${name} does not exist`, 'NotFoundError');
        }
        const created = new MemoryDirectoryHandle(name);
        this.entries.set(name, created);
        return created;
    }

    async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
        const entry = this.entries.get(name);
        if (entry instanceof MemoryFileHandle) {
            return entry;
        }
        if (entry) {
            throw new DOMException(`${name} is a directory`, 'TypeMismatchError');
        }
        if (!options?.create) {
            throw new DOMException(`${name} does not exist`, 'NotFoundError');
        }
        const created = new MemoryFileHandle(name);
        this.entries.set(name, created);
        return created;
    }

    async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
        const entry = this.entries.get(name);
        if (!entry) {
            throw new DOMException(`${name} does not exist`, 'NotFoundError');
        }
        if (entry instanceof MemoryDirectoryHandle && entry.entries.size > 0 && !options?.recursive) {
            throw new DOMException(`${name} is not empty`, 'InvalidModificationError');
        }
        this.entries.delete(name);
    }

    async *values(): AsyncIterable<MemoryDirectoryHandle | MemoryFileHandle> {
        // a copy, so a caller deleting while it walks does not trip over its own deletions
        yield* [...this.entries.values()];
    }
}

export class MemoryFileHandle {

    readonly kind = 'file';

    protected data = new Uint8Array(0);

    constructor(readonly name: string) { }

    async getFile(): Promise<File> {
        return new File([this.data.slice()], this.name);
    }

    async createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }> {
        // like the real thing, nothing shows until the stream is closed
        let pending = new Uint8Array(0);
        return {
            write: async data => {
                const joined = new Uint8Array(pending.length + data.length);
                joined.set(pending);
                joined.set(data, pending.length);
                pending = joined;
            },
            close: async () => {
                this.data = pending;
            },
        };
    }
}
