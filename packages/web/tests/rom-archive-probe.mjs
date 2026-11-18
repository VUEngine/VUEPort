/**
 * Checks archives in a folder read: `.vb.zip` and `.vbz` always open, a plain `.zip` only with archives switched on,
 * and what comes out is the ROM inside. This is the only place two ZIPs are treated differently, by name alone. Needs
 * no browser, the reader is plain TypeScript over a list of candidates.
 *
 * Usage: node tests/rom-archive-probe.mjs
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import esbuild from 'esbuild';

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-archive-'));

async function load(entry, name) {
    const bundle = path.join(scratch, `${name}.mjs`);
    await esbuild.build({
        entryPoints: [new URL(entry, import.meta.url).pathname],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        outfile: bundle,
    });
    return import(pathToFileURL(bundle));
}

const { scanFiles } = await load('../src/web-library-scan.ts', 'scan');
const { isRom, isVbArchive, isZip } = await load('../src/web-rom-source.ts', 'source');

let failures = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
    if (!ok) {
        failures++;
    }
};

const section = name => console.log(`\n${name}`);

function romOf(title, code) {
    const rom = Buffer.alloc(8 * 131072);
    const header = rom.length - 544;
    rom.write(title.padEnd(20, ' '), header, 'ascii');
    rom.write('VU', header + 25, 'ascii');
    rom.write(code, header + 27, 'ascii');
    rom[header + 31] = 3;
    return rom;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

// one stored file in a ZIP container, which is all a ROM archive ever is
function zipOf(name, data) {
    const nameBytes = Buffer.from(name);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + nameBytes.length, 12);
    end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);
    return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

const PLAIN_ROM = romOf('PLAIN ROM', 'PLAI');
const VB_ARCHIVE = zipOf('Zipped Game.vb', romOf('ZIPPED GAME', 'ZIPD'));
const VBZ_ARCHIVE = zipOf('Bound Game.vb', romOf('BOUND GAME', 'BOND'));
const PLAIN_ARCHIVE = zipOf('Other Game.vb', romOf('OTHER GAME', 'OTHR'));

const FILES = [
    { name: 'Plain.vb', data: PLAIN_ROM },
    { name: 'Zipped Game.vb.zip', data: VB_ARCHIVE },
    // `.vbz` is the name a desktop system can bind to, and it does not end in `.zip`, so the ordinary archive rule
    // does not cover it
    { name: 'Bound Game.vbz', data: VBZ_ARCHIVE },
    { name: 'Other Game.zip', data: PLAIN_ARCHIVE },
];

async function* candidates() {
    for (const file of FILES) {
        yield {
            path: file.name,
            name: file.name,
            bytes: file.data.length,
            modifiedAt: 1,
            read: async () => new Uint8Array(file.data),
        };
    }
}

const namesFound = async archives =>
    (await scanFiles(candidates(), { subfolders: false, archives }))
        .map(rom => rom.header.name)
        .sort();

section('With archives switched off');
{
    check('the ROM and both ROM archives are read, an ordinary .zip is not',
        await namesFound(false), ['BOUND GAME', 'PLAIN ROM', 'ZIPPED GAME']);
}

section('With archives switched on');
{
    check('every one of them is read',
        await namesFound(true), ['BOUND GAME', 'OTHER GAME', 'PLAIN ROM', 'ZIPPED GAME']);
}

section('What a .vb.zip contributes');
{
    const found = await scanFiles(candidates(), { subfolders: false, archives: false });
    const zipped = found.find(rom => rom.header.name === 'ZIPPED GAME');
    // filed under the archive, but the member is remembered so playing it later goes back for the same one
    check('it is filed under the archive', zipped?.file.name, 'Zipped Game.vb.zip');
    check('and names the member it came out of', zipped?.file.archiveEntry, 'Zipped Game.vb');
    check('with the cartridge\'s own size', zipped?.bytes, 8 * 131072);
    check('and the cartridge\'s own checksum, not the archive\'s',
        zipped?.id, crc32(romOf('ZIPPED GAME', 'ZIPD')).toString(16).padStart(8, '0'));

    // `.vbz` takes the same unpacking path, so the risk is only it never reaching that path
    const bound = found.find(rom => rom.header.name === 'BOUND GAME');
    check('a .vbz is unpacked the same way', bound?.file.archiveEntry, 'Bound Game.vb');
    check('and carries the cartridge inside it', bound?.bytes, 8 * 131072);
}

// a picked or dropped file is refused before it is read unless one of these three says yes. `.vbz` has to be asked
// about by name, without it a .vbz would be refused as "not a Virtual Boy ROM" unopened.
section('What the page agrees to open at all');
{
    const accepted = name => isRom(name) || isZip(name) || isVbArchive(name);
    check('a cartridge', accepted('Game.vb'), true);
    check('a VB Color cartridge', accepted('Game.vbc'), true);
    check('an archive under either name',
        [accepted('Game.vb.zip'), accepted('Game.vbz')], [true, true]);
    check('an ordinary archive', accepted('Game.zip'), true);
    check('and nothing else', accepted('manual.pdf'), false);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
