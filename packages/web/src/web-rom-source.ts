import { isEsSoundFile } from 'vueport-core/lib/common/emulator-essound';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { listZipEntries, looksLikeZip, readZipEntry, ZipEntry, ZipError } from './web-zip';

// the picker, a drop and `?rom=` all end here, so archives work the same whichever way they came and checks are written
// once

export const ROM_EXTENSIONS = ['.vb', '.vbc', '.bin'];

export function isRom(name: string): boolean {
    const lower = name.toLowerCase();
    return ROM_EXTENSIONS.some(extension => lower.endsWith(extension));
}

export function isZip(name: string): boolean {
    return name.toLowerCase().endsWith('.zip');
}

/**
 * `.vb.zip` is how the scene distributes cartridges, but macOS and Windows resolve a file by its last extension, so an
 * app cannot claim it without claiming every zip (measured, see associations-probe.mjs in the desktop package). `.vbz`
 * is the same archive under a name the desktop build registers as opener. Both are read regardless of the archive
 * switch, which only concerns plain `.zip` files in a ROM folder.
 */
export const VB_ARCHIVE_EXTENSIONS = ['.vbz', '.vb.zip'];

// the name shown for a game (title bar, window title, recent list, LAN share): a `.vbz` goes by its own name, as it is
// VUEPort's package of a game with its ESSound tracks and the file the user keeps; any other archive (`.zip`,
// `.vb.zip`) by the ROM inside, as the archive is only how it was delivered
export function shownFileName(archive: string | undefined, rom: string): string {
    return archive !== undefined && archive.toLowerCase().endsWith('.vbz') ? archive : rom;
}

export function isVbArchive(name: string): boolean {
    const lower = name.toLowerCase();
    return VB_ARCHIVE_EXTENSIONS.some(extension => lower.endsWith(extension));
}

export const MAX_ROM_BYTES = 16 * 1024 * 1024; // the VB addresses 16 MB of cartridge

export interface RomSound {
    name: string; // `3.mp3`, which names the track, or essound.json
    data: Uint8Array;
}

export interface Rom {
    name: string;
    data: Uint8Array;
    sounds: RomSound[]; // unpacked beside the ROM, as a browser cannot reach files beside the cartridge
}

function baseName(path: string): string {
    return path.split('/').pop() ?? path;
}

export class RomSourceError extends Error { }

export class RomChoiceCanceled extends Error { }

// supplied by the caller so this module needs nothing of the UI; undefined means the user backed out
export type ChooseEntry = (names: string[]) => Promise<string | undefined>;

// __MACOSX entries are the resource forks macOS's Compress adds, which carry a ROM's name without being one
function isOfferable(entry: ZipEntry): boolean {
    return !entry.name.endsWith('/')
        && !entry.name.startsWith('__MACOSX/')
        && !entry.name.split('/').pop()!.startsWith('._');
}

// entries named like a ROM are preferred, as archives carry readmes and manuals. Otherwise a single remaining entry is
// taken at its word (many archives hold one extensionless file); the size check catches mistakes
async function romFromZip(archive: Uint8Array, wanted: string, choose: ChooseEntry): Promise<Rom> {
    const entries = listZipEntries(archive).filter(isOfferable);
    if (entries.length === 0) {
        throw new RomSourceError(nls.localize('vueport/rom/emptyArchive', 'That archive is empty.'));
    }

    const named = entries.filter(entry => isRom(entry.name));
    // an ESSound track or its titles are never the cartridge, even where nothing carries a ROM's extension
    const candidates = named.length > 0
        ? named
        : entries.filter(entry => !isEsSoundFile(baseName(entry.name)));

    // a ROM asked for by name was played from this archive before (a recent entry rereads the archive), so the question
    // was answered then
    let chosen: ZipEntry | undefined = candidates.length === 1
        ? candidates[0]
        : candidates.find(entry => baseName(entry.name) === wanted);
    if (!chosen) {
        const pick = await choose(candidates.map(entry => entry.name));
        if (pick === undefined) {
            // backing out is an answer, not a failure
            throw new RomChoiceCanceled();
        }
        chosen = candidates.find(entry => entry.name === pick);
    }
    if (!chosen) {
        throw new RomSourceError(nls.localize('vueport/rom/noRomInArchive', 'That archive holds no ROM.'));
    }

    return { name: baseName(chosen.name), data: await readZipEntry(archive, chosen), sounds: await soundsInZip(archive) };
}

// wherever it sits, as the expansion looks for `3.mp3` beside the cartridge and the zip's folders don't matter. The
// essound.json titling them comes along too
export async function soundsInZip(archive: Uint8Array): Promise<RomSound[]> {
    const sounds: RomSound[] = [];
    for (const entry of listZipEntries(archive).filter(isOfferable)) {
        if (isEsSoundFile(baseName(entry.name))) {
            sounds.push({ name: baseName(entry.name), data: await readZipEntry(archive, entry) });
        }
    }
    return sounds;
}

// recognized by its first four bytes, as a `?rom=` address need not end in .zip, and a misnamed .zip should fail as a
// bad ROM rather than a bad archive
export async function romFrom(name: string, data: Uint8Array, choose: ChooseEntry): Promise<Rom> {
    let rom: Rom;
    if (looksLikeZip(data)) {
        try {
            rom = await romFromZip(data, name, choose);
        } catch (error) {
            if (error instanceof ZipError) {
                throw new RomSourceError(error.message);
            }
            throw error;
        }
    } else {
        rom = { name, data, sounds: [] };
    }
    validate(rom);
    return rom;
}

// named here rather than surfacing later as the core refusing a ROM
export function validate(rom: Rom): void {
    if (rom.data.byteLength === 0) {
        throw new RomSourceError(nls.localize('vueport/rom/empty', '{0} is empty.', rom.name));
    }
    if (rom.data.byteLength > MAX_ROM_BYTES) {
        throw new RomSourceError(nls.localize('vueport/rom/tooBig',
            '{0} is {1} MB; a Virtual Boy cartridge is at most {2} MB.',
            rom.name,
            Math.round(rom.data.byteLength / 1024 / 1024),
            MAX_ROM_BYTES / 1024 / 1024));
    }
    // the core maps the cartridge by masking the address, so only a power of two works; also the cheapest way to notice
    // a web page, readme or manual
    if ((rom.data.byteLength & (rom.data.byteLength - 1)) !== 0) {
        throw new RomSourceError(nls.localize('vueport/rom/notPowerOfTwo',
            '{0} is {1} bytes, which is not a ROM: a cartridge is always a power of two.',
            rom.name, rom.data.byteLength));
    }
}
