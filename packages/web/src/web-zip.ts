// just enough ZIP to get a ROM out: DecompressionStream('deflate-raw') does the algorithm, so only the container is
// read here. Spanned archives, encryption and ZIP64 are refused by name. Writing (storeZip) is core's,
// emulator-store-zip.ts

import { nls } from 'vueport-core/lib/common/emulator-nls';

// little-endian, as they appear in the file
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const MAX_END_RECORD = 22 + 0xffff; // 22 bytes plus a comment of up to 64 KB

// the two methods ZIPs in the wild actually use
const STORED = 0;
const DEFLATED = 8;

const ZIP64_MARKER = 0xffffffff; // means "the real value is in a ZIP64 record", which is not read

export interface ZipEntry {
    name: string;
    size: number; // inflated
    compressedSize: number;
    method: number;
    offset: number; // of the local header
    encrypted: boolean;
}

export class ZipError extends Error { }

export function looksLikeZip(data: Uint8Array): boolean {
    return data.byteLength >= 4
        && data[0] === 0x50 && data[1] === 0x4b
        && data[2] === 0x03 && data[3] === 0x04;
}

function view(data: Uint8Array): DataView {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

// searched backwards: it is the last thing in the file, but ends with a variable-length comment
function findEndRecord(data: Uint8Array): number {
    const dataView = view(data);
    const earliest = Math.max(0, data.byteLength - MAX_END_RECORD);
    for (let at = data.byteLength - 22; at >= earliest; at--) {
        if (dataView.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
            return at;
        }
    }
    throw new ZipError(nls.localize('vueport/zip/notAZip',
        'This is not a ZIP archive, or it is damaged.'));
}

export function listZipEntries(data: Uint8Array): ZipEntry[] {
    const dataView = view(data);
    const end = findEndRecord(data);

    const count = dataView.getUint16(end + 10, true);
    const directoryAt = dataView.getUint32(end + 16, true);
    if (count === 0xffff || directoryAt === ZIP64_MARKER) {
        throw new ZipError(nls.localize('vueport/zip/zip64', 'ZIP64 archives are not supported.'));
    }

    const entries: ZipEntry[] = [];
    let at = directoryAt;
    for (let index = 0; index < count; index++) {
        if (at + 46 > data.byteLength || dataView.getUint32(at, true) !== CENTRAL_FILE_HEADER) {
            throw new ZipError(nls.localize('vueport/zip/damaged', 'This ZIP archive is damaged.'));
        }
        const flags = dataView.getUint16(at + 8, true);
        const method = dataView.getUint16(at + 10, true);
        const compressedSize = dataView.getUint32(at + 20, true);
        const size = dataView.getUint32(at + 24, true);
        const nameLength = dataView.getUint16(at + 28, true);
        const extraLength = dataView.getUint16(at + 30, true);
        const commentLength = dataView.getUint16(at + 32, true);
        const offset = dataView.getUint32(at + 42, true);

        // bit 11 says the name is UTF-8; without it it is officially CP437, but modern tools write UTF-8 and plain
        // ASCII decodes the same either way
        const name = new TextDecoder('utf-8').decode(
            data.subarray(at + 46, at + 46 + nameLength)
        );

        if (size === ZIP64_MARKER || compressedSize === ZIP64_MARKER || offset === ZIP64_MARKER) {
            throw new ZipError(nls.localize('vueport/zip/zip64', 'ZIP64 archives are not supported.'));
        }

        entries.push({
            name,
            size,
            compressedSize,
            method,
            offset,
            encrypted: (flags & 1) !== 0, // bit 0 of the general purpose flags
        });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

// the local header is read again, as its name and extra fields have their own lengths and the extra field often differs
// in size from the directory's copy
export async function readZipEntry(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
    if (entry.encrypted) {
        throw new ZipError(nls.localize('vueport/zip/encrypted',
            '"{0}" is encrypted, and cannot be opened.', entry.name));
    }
    const dataView = view(data);
    if (entry.offset + 30 > data.byteLength
        || dataView.getUint32(entry.offset, true) !== LOCAL_FILE_HEADER) {
        throw new ZipError(nls.localize('vueport/zip/damaged', 'This ZIP archive is damaged.'));
    }
    const nameLength = dataView.getUint16(entry.offset + 26, true);
    const extraLength = dataView.getUint16(entry.offset + 28, true);
    const start = entry.offset + 30 + nameLength + extraLength;
    const body = data.subarray(start, start + entry.compressedSize);
    if (body.byteLength !== entry.compressedSize) {
        throw new ZipError(nls.localize('vueport/zip/truncated', 'This ZIP archive is truncated.'));
    }

    if (entry.method === STORED) {
        return body.slice();
    }
    if (entry.method !== DEFLATED) {
        throw new ZipError(nls.localize('vueport/zip/method',
            '"{0}" uses compression method {1}, which is not supported.', entry.name, entry.method));
    }

    // `deflate-raw` is the bare algorithm without the zlib wrapper, exactly as ZIP stores it
    let inflated: Uint8Array;
    try {
        // a copy that owns its buffer, as the stream APIs will not take a view onto a possibly shared buffer; only the
        // compressed size, kilobytes
        const owned = new Uint8Array(entry.compressedSize);
        owned.set(body);
        const source = new ReadableStream<BufferSource>({
            start(controller): void {
                controller.enqueue(owned);
                controller.close();
            },
        });
        const stream = source.pipeThrough(new DecompressionStream('deflate-raw'));
        inflated = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
        // the decompressor throws a bare TypeError for a damaged stream, which says nothing to a reader
        throw new ZipError(nls.localize('vueport/zip/unpackFailed',
            '"{0}" could not be unpacked; the archive is damaged.', entry.name));
    }
    if (inflated.byteLength !== entry.size) {
        throw new ZipError(nls.localize('vueport/zip/wrongSize',
            '"{0}" did not unpack to the size the archive claims.', entry.name));
    }
    return inflated;
}

// core's, as VUEngine Studio packs a LAN share too
export { storeZip } from 'vueport-core/lib/common/emulator-store-zip';
