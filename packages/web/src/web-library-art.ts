/**
 * Planet VB's pictures (box faces, backdrops), fetched once into library/art/ beside library/index.json, so a shelf of
 * three hundred games isn't three hundred requests to somebody else's server on every open, nor gray rectangles
 * offline. Keyed by address: two dumps of a game share one file, replaced art names a new address, and prune deletes
 * files nothing names. cache is the network half that writes files; open turns a file on disk into a blob: URL on
 * demand, as object URLs hold their bytes in memory until revoked.
 */
import { crc32, formatRomId } from 'vueport-core/lib/common/emulator-cheat-database';
import { VueportStorage } from 'vueport-core/lib/common/emulator-host';

export const ART_DIR = 'library/art';
const ART_PATH = 'library/art.json';

const ART_VERSION = 1;

const FETCH_CONCURRENCY = 4; // a first read of a collection is hundreds of images, same courtesy as the lookups

// art is a megabyte at most; this keeps a catalog entry pointing at something huge out of the store, over it the
// address is shown from the network
const MAX_BYTES = 8 * 1024 * 1024;

interface StoredArt {
    file: string;
    type: string;
    bytes: number;
    fetchedAt: number; // epoch ms
}

interface StoredArtIndex {
    version: number;
    images: Record<string, StoredArt>; // keyed by source address
}

function isImageType(type: string): boolean {
    return /^image\//i.test(type) && !/^image\/svg/i.test(type);
}

// the address is hashed rather than escaped, as URLs are long and hold characters a file name may not; the length is
// appended, so only same-length addresses can collide in CRC32
function fileNameFor(url: string, type: string): string {
    const key = `${formatRomId(crc32(new TextEncoder().encode(url)))}${url.length.toString(36)}`;
    return `${key}${extensionFor(url, type)}`;
}

function extensionFor(url: string, type: string): string {
    const fromUrl = /\.(png|jpe?g|gif|webp|avif|bmp)(?:$|[?#])/i.exec(url);
    if (fromUrl) {
        return `.${fromUrl[1].toLowerCase()}`;
    }
    const subtype = /^image\/([a-z0-9.+-]+)/i.exec(type)?.[1]?.toLowerCase();
    return subtype ? `.${subtype === 'jpeg' ? 'jpg' : subtype}` : '.img';
}

export class LibraryArt {

    protected images = new Map<string, StoredArt>();
    protected urls = new Map<string, string>();
    protected remotes = new Map<string, string>();
    protected fetching = new Set<string>();
    // in memory only, so a picture that failed offline is retried on the next start, not on every repaint
    protected failed = new Set<string>();
    protected reloading = new Set<string>(); // dropped addresses, whose next fetch bypasses the HTTP cache

    protected loaded = false;
    protected writing: Promise<void> = Promise.resolve();
    // fetches and sweeps run one after the other, as a fetch landing during a sweep would be deleted as unnamed
    protected queue: Promise<void> = Promise.resolve();

    constructor(protected readonly storage: VueportStorage) { }

    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        try {
            const index = JSON.parse(await this.storage.readText(ART_PATH)) as StoredArtIndex;
            if (index?.version === ART_VERSION && index.images && typeof index.images === 'object') {
                this.images = new Map(Object.entries(index.images)
                    .filter(([url, art]) => typeof url === 'string' && typeof art?.file === 'string'));
            }
        } catch {
            // missing, or half written: holding nothing is right for both, the first pass fetches again
        }
    }

    // undefined also means a file not opened yet, not only "not held"; the caller then shows the address itself
    url(remote: string | undefined): string | undefined {
        return remote === undefined ? undefined : this.urls.get(remote);
    }

    // a failed picture is not held and is retried next pass. onStored is awaited per picture, so a shelf fills in as it
    // goes
    cache(
        urls: Iterable<string | undefined>,
        onStored?: (url: string) => void | Promise<void>,
    ): Promise<void> {
        return this.enqueue(() => this.runCache(urls, onStored));
    }

    protected async runCache(
        urls: Iterable<string | undefined>,
        onStored?: (url: string) => void | Promise<void>,
    ): Promise<void> {
        await this.load();
        const queue = [...new Set([...urls].filter((url): url is string =>
            typeof url === 'string' && /^https?:\/\//i.test(url)
            && !this.images.has(url) && !this.failed.has(url) && !this.fetching.has(url)))];
        if (queue.length === 0) {
            return;
        }
        let stored = false;

        const worker = async (): Promise<void> => {
            while (queue.length > 0) {
                const url = queue.shift();
                if (!url || this.images.has(url)) {
                    continue;
                }
                this.fetching.add(url);
                try {
                    const art = await this.fetchOne(url);
                    if (art) {
                        this.images.set(url, art);
                        stored = true;
                        await onStored?.(url);
                    } else {
                        this.failed.add(url);
                    }
                } finally {
                    this.fetching.delete(url);
                }
            }
        };

        await Promise.all(Array.from(
            { length: Math.min(FETCH_CONCURRENCY, queue.length) },
            () => worker()));

        if (stored) {
            await this.save();
        }
    }

    protected async fetchOne(url: string): Promise<StoredArt | undefined> {
        let response: Response;
        try {
            response = await fetch(url, {
                mode: 'cors',
                credentials: 'omit',
                cache: this.reloading.delete(url) ? 'no-cache' : 'default',
            });
        } catch {
            // offline, blocked, or a host that will not answer this origin
            return undefined;
        }
        if (!response.ok) {
            return undefined;
        }
        const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (type && !isImageType(type)) {
            // catalogs serve error pages with a 200
            return undefined;
        }
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.length === 0 || data.length > MAX_BYTES) {
            return undefined;
        }
        const art: StoredArt = {
            file: fileNameFor(url, type),
            type: type || 'image/png',
            bytes: data.length,
            fetchedAt: Date.now(),
        };
        try {
            await this.storage.write(`${ART_DIR}/${art.file}`, data);
        } catch {
            // store full or name refused
            return undefined;
        }
        return art;
    }

    // resolves true when something new was opened, the cue to redraw. Addresses without a file are skipped, the address
    // itself is the fallback
    async open(remotes: Iterable<string | undefined>): Promise<boolean> {
        await this.load();
        let opened = false;
        for (const remote of new Set(remotes)) {
            if (!remote || this.urls.has(remote)) {
                continue;
            }
            const art = this.images.get(remote);
            if (!art) {
                continue;
            }
            try {
                const data = await this.storage.read(`${ART_DIR}/${art.file}`);
                const blob = new Blob([data as BlobPart], { type: art.type });
                const url = URL.createObjectURL(blob);
                this.urls.set(remote, url);
                this.remotes.set(url, remote);
                opened = true;
            } catch {
                // the file is gone, so forget it and let the next pass fetch it again
                this.images.delete(remote);
                await this.save();
            }
        }
        return opened;
    }

    // the directory is swept too, as a file whose note was never written would be left over otherwise
    prune(keep: Iterable<string | undefined>): Promise<void> {
        return this.enqueue(() => this.runPrune(keep));
    }

    protected async runPrune(keep: Iterable<string | undefined>): Promise<void> {
        await this.load();
        const wanted = new Set([...keep].filter((url): url is string => typeof url === 'string'));
        let dropped = false;
        for (const [url, art] of [...this.images]) {
            if (wanted.has(url)) {
                continue;
            }
            this.images.delete(url);
            this.release(url);
            await this.storage.delete(`${ART_DIR}/${art.file}`).catch(() => undefined);
            dropped = true;
        }
        if (dropped) {
            await this.save();
        }

        const held = new Set([...this.images.values()].map(art => art.file));
        for (const file of await this.storage.list(ART_DIR).catch(() => [])) {
            if (!held.has(file.name)) {
                await this.storage.delete(file.path).catch(() => undefined);
            }
        }
    }

    // for when the catalog replaced a picture at the same address: the next fetch bypasses the HTTP cache
    drop(remotes: Iterable<string>): Promise<void> {
        const dropped = [...new Set(remotes)];
        return this.enqueue(async () => {
            await this.load();
            for (const url of dropped) {
                this.release(url);
                this.failed.delete(url);
                this.reloading.add(url);
                const art = this.images.get(url);
                if (art) {
                    this.images.delete(url);
                    await this.storage.delete(`${ART_DIR}/${art.file}`).catch(() => undefined);
                }
            }
            await this.save();
        });
    }

    remoteOf(url: string | undefined): string | undefined {
        return url === undefined ? undefined : this.remotes.get(url);
    }

    // the file stays; only the object URL goes
    release(remote: string): void {
        const url = this.urls.get(remote);
        if (url) {
            URL.revokeObjectURL(url);
            this.urls.delete(remote);
            this.remotes.delete(url);
        }
    }

    protected enqueue(run: () => Promise<void>): Promise<void> {
        const next = this.queue.catch(() => undefined).then(run);
        this.queue = next.catch(() => undefined);
        return next;
    }

    protected save(): Promise<void> {
        const index: StoredArtIndex = {
            version: ART_VERSION,
            images: Object.fromEntries(this.images),
        };
        return this.writing = this.writing
            .catch(() => undefined)
            .then(() => this.storage.writeText(ART_PATH, JSON.stringify(index)))
            .catch(() => undefined);
    }
}
