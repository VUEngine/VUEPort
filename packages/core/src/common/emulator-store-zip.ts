// just enough ZIP writing for a LAN share of a game that came packed or has ESSound tracks; the headset unpacks it like
// any other .vbz. The reading side is packages/web/src/web-zip.ts

import { crc32 } from './emulator-cheat-database';

// signatures, little-endian, as they appear in the file
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;

const UTF8_NAMES = 0x0800; // bit 11 of the general purpose flags: the names are UTF-8

// stored, not deflated: ROMs and ESSound tracks (MP3 and Ogg are compressed already) only cross the local network. No
// dates (1980-01-01) and no ZIP64, so nothing over 4 GB
export function storeZip(files: ReadonlyArray<{ name: string, data: Uint8Array }>): Uint8Array {
    const encoder = new TextEncoder();
    const entries = files.map(file => ({
        name: encoder.encode(file.name),
        data: file.data,
        crc: crc32(file.data) >>> 0,
        offset: 0,
    }));
    const localSize = entries.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0);
    const directorySize = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
    const out = new Uint8Array(localSize + directorySize + 22);
    const dataView = new DataView(out.buffer, out.byteOffset, out.byteLength);

    let at = 0;
    for (const entry of entries) {
        entry.offset = at;
        dataView.setUint32(at, LOCAL_FILE_HEADER, true);
        dataView.setUint16(at + 4, 10, true);
        dataView.setUint16(at + 6, UTF8_NAMES, true);
        dataView.setUint16(at + 8, STORED, true);
        dataView.setUint16(at + 12, 0x21, true);
        dataView.setUint32(at + 14, entry.crc, true);
        dataView.setUint32(at + 18, entry.data.length, true);
        dataView.setUint32(at + 22, entry.data.length, true);
        dataView.setUint16(at + 26, entry.name.length, true);
        out.set(entry.name, at + 30);
        out.set(entry.data, at + 30 + entry.name.length);
        at += 30 + entry.name.length + entry.data.length;
    }

    const directoryAt = at;
    for (const entry of entries) {
        dataView.setUint32(at, CENTRAL_FILE_HEADER, true);
        dataView.setUint16(at + 4, 10, true);
        dataView.setUint16(at + 6, 10, true);
        dataView.setUint16(at + 8, UTF8_NAMES, true);
        dataView.setUint16(at + 10, STORED, true);
        dataView.setUint16(at + 14, 0x21, true);
        dataView.setUint32(at + 16, entry.crc, true);
        dataView.setUint32(at + 20, entry.data.length, true);
        dataView.setUint32(at + 24, entry.data.length, true);
        dataView.setUint16(at + 28, entry.name.length, true);
        dataView.setUint32(at + 42, entry.offset, true);
        out.set(entry.name, at + 46);
        at += 46 + entry.name.length;
    }

    dataView.setUint32(at, END_OF_CENTRAL_DIRECTORY, true);
    dataView.setUint16(at + 8, entries.length, true);
    dataView.setUint16(at + 10, entries.length, true);
    dataView.setUint32(at + 12, at - directoryAt, true);
    dataView.setUint32(at + 16, directoryAt, true);
    return out;
}
