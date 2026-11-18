/**
 * Reads a folder into library entries in one pass: walk, decide what looks like a ROM, hash it, read its header. The
 * catalog is asked afterwards, so two hundred ROMs are on screen first. A file's bytes are hashed and dropped (one
 * cartridge in memory at a time), and a file whose size and modification time match the last read isn't opened at all.
 * A ROM is what web-rom-source accepts when one is opened: not empty, no larger than a cartridge, a power of two in
 * size, which throws out readmes, box scans and saves for free.
 */
import { crc32, formatRomId } from 'vueport-core/lib/common/emulator-cheat-database';
import { parseRomHeader } from 'vueport-core/lib/browser/emulator-types';
import { LibraryFile, LibraryHeader, LibraryScanProgress } from './web-library-types';
import { MAX_ROM_BYTES, isRom, isVbArchive, isZip } from './web-rom-source';
import { ZipError, listZipEntries, looksLikeZip, readZipEntry } from './web-zip';

// a browser walks a granted handle, the desktop asks its shell; the rules for deciding, hashing and unpacking are
// shared
export interface ScanCandidate {
    path: string; // relative to the folder's root, /-separated
    name: string;
    bytes: number;
    modifiedAt: number;
    read(): Promise<Uint8Array>;
}

export interface ScannedRom {
    id: string; // lower-case hex
    header: LibraryHeader;
    bytes: number;
    file: Omit<LibraryFile, 'folderId'>;
}

export interface ScanOptions {
    subfolders: boolean;
    archives: boolean; // a .vb.zip is read either way (see readCandidate)
    // by path; an unchanged file (size, modification time) is taken from here. An archive holds several ROMs under one
    // path, hence a list
    known?: Map<string, ScannedRom[]>;
    signal?: AbortSignal; // the caller keeps nothing of an aborted read
    onProgress?: (progress: Omit<LibraryScanProgress, 'folderId'>) => void;
}

// a .zip has to be read whole; 16 cartridges' worth is generous for ROMs and small enough to skip a backup left in the
// folder
const MAX_ARCHIVE_BYTES = MAX_ROM_BYTES * 16;

function couldBeRom(bytes: number): boolean {
    return bytes > 0 && bytes <= MAX_ROM_BYTES && (bytes & (bytes - 1)) === 0;
}

function describe(data: Uint8Array): { id: string, header: LibraryHeader } {
    const header = parseRomHeader(data);
    return {
        // over the whole file, as preservation catalogs key on it, and as WebEmulator.romChecksum reports it
        id: formatRomId(crc32(data)),
        header: {
            name: header.name.trim(),
            maker: header.maker.trim(),
            code: header.code.trim(),
            version: header.version,
        },
    };
}

// an aborted read rejects with the signal's reason, so a half-read folder is not mistaken for one whose other half has
// gone
export async function scanFiles(
    candidates: AsyncIterable<ScanCandidate>,
    options: ScanOptions,
): Promise<ScannedRom[]> {
    const found: ScannedRom[] = [];
    let files = 0;

    const report = (current?: string): void => {
        options.onProgress?.({ files, roms: found.length, current });
    };

    report();
    for await (const candidate of candidates) {
        options.signal?.throwIfAborted();
        files++;
        report(candidate.path);
        const roms = await readCandidate(candidate, options);
        found.push(...roms);
        if (roms.length > 0) {
            report(candidate.path);
        }
    }
    report();
    return found;
}

async function readCandidate(
    candidate: ScanCandidate,
    options: ScanOptions,
): Promise<ScannedRom[]> {
    // a .vb.zip says what it holds, so the archive switch only applies to plain .zip files, which may be backups or box
    // scans
    const archive = isVbArchive(candidate.name) || (options.archives && isZip(candidate.name));
    if (!archive && !isRom(candidate.name)) {
        return [];
    }

    // unchanged since the last read, so its checksum cannot have changed
    const previous = options.known?.get(candidate.path);
    if (previous && previous.length > 0
        && previous[0].file.modifiedAt === candidate.modifiedAt
        && previous.every(rom => rom.file.name === candidate.name)) {
        return previous.map(rom => ({
            ...rom,
            file: { ...rom.file, path: candidate.path, name: candidate.name },
        }));
    }

    if (!archive && !couldBeRom(candidate.bytes)) {
        return [];
    }
    if (archive && candidate.bytes > MAX_ARCHIVE_BYTES) {
        return [];
    }

    let data: Uint8Array;
    try {
        data = await candidate.read();
    } catch {
        // deleted between the walk and the read, or permission ended mid-pass
        return [];
    }
    options.signal?.throwIfAborted();

    if (archive || looksLikeZip(data)) {
        return readArchive(data, candidate.name, candidate.path, candidate.modifiedAt, options);
    }
    const { id, header } = describe(data);
    return [{
        id,
        header,
        bytes: data.byteLength,
        file: {
            path: candidate.path,
            name: candidate.name,
            bytes: data.byteLength,
            modifiedAt: candidate.modifiedAt,
        },
    }];
}

// every ROM inside an archive, as a folder read cannot ask which one (a demo beside the finished game is two games in
// one file). The member's name travels with the entry so playing opens the same one
async function readArchive(
    data: Uint8Array,
    name: string,
    path: string,
    modifiedAt: number,
    options: ScanOptions,
): Promise<ScannedRom[]> {
    let entries;
    try {
        entries = listZipEntries(data);
    } catch (error) {
        if (error instanceof ZipError) {
            // not an archive after all, or one this reader does not understand
            return [];
        }
        throw error;
    }

    const found: ScannedRom[] = [];
    for (const entry of entries) {
        options.signal?.throwIfAborted();
        if (!isRom(entry.name) || !couldBeRom(entry.size)) {
            continue;
        }
        let member: Uint8Array;
        try {
            member = await readZipEntry(data, entry);
        } catch {
            continue;
        }
        if (!couldBeRom(member.byteLength)) {
            continue;
        }
        const { id, header } = describe(member);
        found.push({
            id,
            header,
            bytes: member.byteLength,
            file: {
                path,
                name,
                bytes: member.byteLength,
                archiveEntry: entry.name,
                modifiedAt,
            },
        });
    }
    return found;
}
