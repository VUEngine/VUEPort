import { shownFileName } from './web-rom-source';
import { VueportStorage } from 'vueport-core/lib/common/emulator-host';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { maxRecent } from './web-recent-limit';
import { ensureDurableStorage } from './web-durable-storage';
import { RecentRomOrigin } from './web-recent-origins';

/**
 * Recently opened ROMs for the start page. A browser cannot reopen a file by path, so entries without a way back keep
 * the bytes in OPFS beside an index; ROMs that can reach their file again (library, desktop shell, see
 * `web-recent-origins.ts`) keep none. The cap is a setting (`web-recent-limit.ts`); bytes go when an entry falls off or
 * the cap comes down. Kept outside WebStorage's per-ROM tree, so deleting a ROM's saves does not touch them.
 */

export type RecentRomSource = 'file' | 'url';

export interface RecentRom {
    id: string; // CRC32, also the file name in the store
    name: string;
    bytes: number;
    openedAt: number; // epoch ms
    source: RecentRomSource;
    url?: string; // when `source` is `url`
    // on the desktop, so replaying uses the same file (the save beside it, ESSound tracks, the debugger's build). The
    // shell has the final say (`reopenFile`), so moved or foreign paths are refused
    location?: string;
    archive?: string; // the archive it was unpacked from (`Super Metroid.vbz`), the name shown while it plays
    // no copy is kept, as there is a way back to the file; absent means the bytes are under `recent/<id>.rom`. If the
    // way back closes, the entry is shown but cannot start
    linked?: boolean;
    thumbnail?: string; // small JPEG data URL grabbed a few seconds into play
}

const DIR = 'recent';
const INDEX_PATH = `${DIR}/index.json`;

// a CRC32 is hex, but only these characters may reach a file name
function safeId(id: string): string {
    return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'rom';
}

export class RecentRoms {

    constructor(
        protected readonly storage: VueportStorage,
        protected readonly origins: RecentRomOrigin[] = [], // tried in order; empty copies everything
    ) { }

    // a missing or unreadable index reads as empty
    async list(): Promise<RecentRom[]> {
        try {
            const raw = await this.storage.readText(INDEX_PATH);
            const parsed = JSON.parse(raw) as unknown;
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed
                .filter((item): item is RecentRom =>
                    !!item && typeof item === 'object'
                    && typeof (item as RecentRom).id === 'string'
                    && typeof (item as RecentRom).name === 'string')
                .sort((a, b) => b.openedAt - a.openedAt);
        } catch {
            return [];
        }
    }

    /**
     * Bytes are kept only without another way back (see RecentRomOrigin): a `linked` entry costs only its index entry,
     * and an older copy is dropped once a way back exists. A known ROM moves to the front and keeps its thumbnail until
     * the new session grabs one. Writes nothing when the limit is zero (feature off); `enforceLimit` clears what was
     * kept before.
     */
    async remember(
        meta: Omit<RecentRom, 'openedAt' | 'thumbnail' | 'linked'>,
        data: Uint8Array,
    ): Promise<void> {
        if (maxRecent() <= 0) {
            return;
        }
        // not awaited, as Firefox shows a doorhanger and the game must not wait for it; see `web-durable-storage.ts`
        ensureDurableStorage().catch(() => undefined);
        const existing = await this.list();
        const previous = existing.find(item => item.id === meta.id);
        const opened: RecentRom = {
            ...meta,
            openedAt: Date.now(),
            thumbnail: previous?.thumbnail,
        };
        // every origin answers without reading a file or prompting, so it can be asked while the ROM starts
        const entry: RecentRom = {
            ...opened,
            linked: await this.reachable(opened) || undefined,
        };

        const limit = maxRecent();
        const kept = [entry, ...existing.filter(item => item.id !== meta.id)];
        const dropped = kept.slice(limit);
        const next = kept.slice(0, limit);

        try {
            if (entry.linked) {
                await this.storage.delete(this.romPath(meta.id)).catch(() => undefined);
            } else {
                await this.storage.write(this.romPath(meta.id), data);
            }
            await this.writeIndex(next);
            for (const gone of dropped) {
                await this.storage.delete(this.romPath(gone.id)).catch(() => undefined);
            }
        } catch {
            // a start page one entry out of date is not worth a toast
        }
    }

    // keeps the bytes regardless, for the second player's window: it gets only the checksum and, without a click,
    // cannot ask for a folder grant. The next play or `dropRedundantCopies` removes it again
    async keep(id: string, data: Uint8Array): Promise<void> {
        try {
            const list = await this.list();
            const entry = list.find(item => item.id === id);
            if (!entry?.linked) {
                // nothing remembered (impossible for a running ROM), or the bytes are already here
                return;
            }
            await this.storage.write(this.romPath(id), data);
            entry.linked = undefined;
            await this.writeIndex(list);
        } catch {
            // the other window falls back to what it can reach, and says so when that is nothing
        }
    }

    // for the whole list, as a folder added today reaches ROMs copied months ago. Run once the library knows its
    // contents, as an early no would cost a gigabyte
    async dropRedundantCopies(): Promise<void> {
        if (this.origins.length === 0) {
            return;
        }
        try {
            const list = await this.list();
            const freed: RecentRom[] = [];
            for (const entry of list) {
                if (!entry.linked && await this.reachable(entry)) {
                    entry.linked = true;
                    freed.push(entry);
                }
            }
            if (freed.length === 0) {
                return;
            }
            // the index first, so a failed delete leaves an orphan file rather than a dangling entry
            await this.writeIndex(list);
            for (const entry of freed) {
                await this.storage.delete(this.romPath(entry.id)).catch(() => undefined);
            }
        } catch {
            // offered again on the next start
        }
    }

    // `remember` trims on every new ROM; this is for lowering the limit, so storage shrinks at once
    async enforceLimit(): Promise<void> {
        const limit = maxRecent();
        try {
            const existing = await this.list();
            if (existing.length <= limit) {
                return;
            }
            const dropped = existing.slice(limit);
            await this.writeIndex(existing.slice(0, limit));
            for (const gone of dropped) {
                await this.storage.delete(this.romPath(gone.id)).catch(() => undefined);
            }
        } catch {
            // enforced again next time a ROM is opened
        }
    }

    async clear(): Promise<void> {
        try {
            const existing = await this.list();
            // the index first, so a failed delete leaves an orphan file rather than a list pointing at nothing
            await this.writeIndex([]);
            for (const gone of existing) {
                await this.storage.delete(this.romPath(gone.id)).catch(() => undefined);
            }
        } catch {
            // the caller re-reads the list either way
        }
    }

    async forget(id: string): Promise<void> {
        try {
            const next = (await this.list()).filter(entry => entry.id !== id);
            await this.writeIndex(next);
            await this.storage.delete(this.romPath(id)).catch(() => undefined);
        } catch {
            // the caller re-reads the list either way
        }
    }

    // the copy first, then each way back: `linked` is only what was decided last time, and an existing copy cannot be
    // wrong
    async data(rom: RecentRom): Promise<Uint8Array | undefined> {
        try {
            return await this.storage.read(this.romPath(rom.id));
        } catch {
            // no copy, the ordinary case for a linked entry
        }
        for (const origin of this.origins) {
            const data = await origin.read(rom).catch(() => undefined);
            if (data) {
                return data;
            }
        }
        return undefined;
    }

    protected async reachable(rom: RecentRom): Promise<boolean> {
        for (const origin of this.origins) {
            if (await origin.reachable(rom).catch(() => false)) {
                return true;
            }
        }
        return false;
    }

    async setThumbnail(id: string, dataUrl: string): Promise<void> {
        try {
            const list = await this.list();
            const entry = list.find(e => e.id === id);
            if (!entry) {
                return;
            }
            entry.thumbnail = dataUrl;
            await this.writeIndex(list);
        } catch {
            // the picture is a nicety
        }
    }

    protected romPath(id: string): string {
        return `${DIR}/${safeId(id)}.rom`;
    }

    protected async writeIndex(entries: RecentRom[]): Promise<void> {
        await this.storage.writeText(INDEX_PATH, JSON.stringify(entries));
    }
}

// shared with the command palette's "Continue Recently Opened"
export function recentDetail(rom: RecentRom): string {
    const parts = [];
    if (rom.source === 'url') {
        parts.push(nls.localize('vueport/welcome/fromLinkTag', 'from a link'));
    }
    parts.push(relativeTime(rom.openedAt));
    return parts.join(' · ');
}

// `.vb.zip` counts as one extension, as for a .vbz
export function romStem(name: string): string {
    if (name.toLowerCase().endsWith('.vb.zip') && name.length > '.vb.zip'.length) {
        return name.slice(0, -'.vb.zip'.length);
    }
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}

// a .vbz by its own name, any other archive by the ROM inside, see shownFileName
export function recentName(rom: RecentRom): string {
    return shownFileName(rom.archive, rom.name);
}

// exported so the library spells "yesterday" the same way
export function relativeTime(epochMs: number): string {
    const seconds = Math.round((Date.now() - epochMs) / 1000);
    if (seconds < 90) {
        return nls.localize('vueport/welcome/justNow', 'just now');
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return nls.localize('vueport/welcome/minutesAgo', '{0} min ago', minutes);
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return nls.localize('vueport/welcome/hoursAgo', '{0} h ago', hours);
    }
    const days = Math.round(hours / 24);
    if (days === 1) {
        return nls.localize('vueport/welcome/yesterday', 'yesterday');
    }
    if (days < 7) {
        return nls.localize('vueport/welcome/daysAgo', '{0} days ago', days);
    }
    return new Date(epochMs).toLocaleDateString();
}
