// ways back to a recent ROM's own file. Library and desktop-opened ROMs can be read where they lie, so their entries
// keep no copy (see `web-recent-roms.ts`, and RecentRoms.dropRedundantCopies for older copies)
import { RecentRom } from './web-recent-roms';
import { Library } from './web-library';

// `reachable` runs while a game starts, so it must be cheap and quiet (no file read, no prompt); `read` runs on a click
export interface RecentRomOrigin {
    reachable(rom: RecentRom): Promise<boolean>;
    read(rom: RecentRom): Promise<Uint8Array | undefined>; // undefined when this way back has closed
}

// recent and library ids are the same CRC32, so nothing can go stale. A file rebuilt under the same name plays as it is
// now and is remembered under its new checksum
export class LibraryRomOrigin implements RecentRomOrigin {

    constructor(protected readonly library: Library) { }

    async reachable(rom: RecentRom): Promise<boolean> {
        // waits for the index, as at start-up a no keeps a copy, and "Auto start last recent game" asks this before any
        // folder was read
        await this.library.ready;
        return this.library.canRead(rom.id);
    }

    async read(rom: RecentRom): Promise<Uint8Array | undefined> {
        await this.library.ready;
        if (!this.library.canRead(rom.id)) {
            return undefined;
        }
        try {
            return (await this.library.read(rom.id)).data;
        } catch {
            // a disk unplugged or a file deleted since; the caller tries the next way back
            return undefined;
        }
    }
}

// the shell only reopens paths its record shows and that still exist (see `reopenFile` in `desktop-open.ts`). Loaded on
// demand, so no desktop code reaches a browser bundle
export class DesktopRomOrigin implements RecentRomOrigin {

    async reachable(rom: RecentRom): Promise<boolean> {
        if (!rom.location) {
            return false;
        }
        const { reopenFile } = await import('./desktop-open');
        return reopenFile(rom.location);
    }

    async read(rom: RecentRom): Promise<Uint8Array | undefined> {
        if (!await this.reachable(rom)) {
            return undefined;
        }
        try {
            const { readOpenedFile } = await import('./desktop-open');
            return await readOpenedFile(rom.location!);
        } catch {
            return undefined;
        }
    }
}
