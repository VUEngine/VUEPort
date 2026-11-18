// ESSound, the MP3/WAV expansion, transcribed from ESSound_01.pdf. A 16-bit store to VB_ES_SOUND_PORT holds track id
// (bits 15-8), command value (7-4) and command (3-0); tracks are 1.mp3-100.mp3 and 101.wav-254.wav beside the ROM. The
// hardware plays at most one MP3 and one WAV at a time, hence two slots

export enum EsSoundCommand {
    STOP = 0x0,
    PLAY = 0x1,
    PLAY_LOOP = 0x2,
    SET_VOLUME = 0x3,
    SET_BALANCE = 0x4,
}

// halfwords that are commands in their own right rather than a track/command/value triple
export const ES_SOUND_INIT = 0xffff;
export const ES_SOUND_STOP_ALL = 0x0000;

export const ES_SOUND_FIRST_MP3 = 1;
export const ES_SOUND_LAST_MP3 = 100;
export const ES_SOUND_FIRST_WAV = 101;
export const ES_SOUND_LAST_WAV = 254;

export const ES_SOUND_LEVELS = 16;

export type EsSoundKind = 'mp3' | 'wav';

export type EsSoundMessage =
    | { kind: 'init', raw: number } // also resets volume and balance to default
    | { kind: 'stopAll', raw: number } // leaves the stored volume and balance alone
    | { kind: 'command', raw: number, track: number, command: EsSoundCommand, value: number };

export function decodeEsSoundMessage(raw: number): EsSoundMessage {
    const word = raw & 0xffff;
    if (word === ES_SOUND_INIT) {
        return { kind: 'init', raw: word };
    }
    if (word === ES_SOUND_STOP_ALL) {
        return { kind: 'stopAll', raw: word };
    }
    return {
        kind: 'command',
        raw: word,
        track: (word >> 8) & 0xff,
        command: (word & 0x0f) as EsSoundCommand,
        value: (word >> 4) & 0x0f,
    };
}

export function esSoundKindOf(track: number): EsSoundKind | undefined {
    if (track >= ES_SOUND_FIRST_MP3 && track <= ES_SOUND_LAST_MP3) {
        return 'mp3';
    }
    if (track >= ES_SOUND_FIRST_WAV && track <= ES_SOUND_LAST_WAV) {
        return 'wav';
    }
    return undefined;
}

export function esSoundFileName(track: number): string | undefined {
    const kind = esSoundKindOf(track);
    return kind ? `${track}.${kind}` : undefined;
}

// no leading zeroes: the hardware builds the name from the id, so 001.mp3 is a file it never looks for
export function esSoundTrackOf(fileName: string): number | undefined {
    const match = /^([1-9]\d{0,2})\.(mp3|wav)$/i.exec(fileName);
    if (!match) {
        return undefined;
    }
    const track = parseInt(match[1], 10);
    return esSoundKindOf(track) === match[2].toLowerCase() ? track : undefined;
}

// VUEPort's own per-folder titles file, not part of the expansion: {"tracks": {"1": {"title": "Overworld"}, ...}}; a
// title here wins over the file's tags
export const ES_SOUND_TITLES_FILE = 'essound.json';

export function isEsSoundFile(fileName: string): boolean {
    return esSoundTrackOf(fileName) !== undefined || fileName.toLowerCase() === ES_SOUND_TITLES_FILE;
}

// throws saying where, as the file is written by hand and a silently missing title would leave the user guessing
export function parseEsSoundTitles(text: string): Map<number, string> {
    const json: unknown = JSON.parse(text);
    const tracks = (json as { tracks?: unknown } | null)?.tracks;
    if (typeof tracks !== 'object' || tracks === null || Array.isArray(tracks)) {
        throw new Error('expected an object "tracks"');
    }
    const titles = new Map<number, string>();
    for (const [key, entry] of Object.entries(tracks)) {
        const id = /^\d+$/.test(key) ? parseInt(key, 10) : NaN;
        if (esSoundKindOf(id) === undefined) {
            throw new Error(`"${key}" is not a track id (${ES_SOUND_FIRST_MP3}-${ES_SOUND_LAST_MP3} or ${ES_SOUND_FIRST_WAV}-${ES_SOUND_LAST_WAV})`);
        }
        const title = (entry as { title?: unknown } | null)?.title;
        if (typeof title !== 'string') {
            throw new Error(`track ${key} has no string "title"`);
        }
        if (title.trim()) {
            titles.set(id, title.trim());
        }
    }
    return titles;
}

export function esSoundVolume(value: number): number {
    return Math.min(ES_SOUND_LEVELS - 1, Math.max(0, value)) / (ES_SOUND_LEVELS - 1);
}

// -1 left to +1 right; the nibble runs the other way (0x0 full right, 0x7 center, 0xF full left)
export function esSoundBalance(value: number): number {
    const level = Math.min(ES_SOUND_LEVELS - 1, Math.max(0, value));
    return 1 - (level / (ES_SOUND_LEVELS - 1)) * 2;
}

export const ES_SOUND_COMMAND_NAMES: Record<number, string> = {
    [EsSoundCommand.STOP]: 'Stop',
    [EsSoundCommand.PLAY]: 'Play',
    [EsSoundCommand.PLAY_LOOP]: 'Play Loop',
    [EsSoundCommand.SET_VOLUME]: 'Set Volume',
    [EsSoundCommand.SET_BALANCE]: 'Set Balance',
};

export function describeEsSoundMessage(message: EsSoundMessage): string {
    if (message.kind === 'init') {
        return 'Init';
    }
    if (message.kind === 'stopAll') {
        return 'Stop All';
    }
    const name = ES_SOUND_COMMAND_NAMES[message.command] ?? `Command ${message.command}`;
    const file = esSoundFileName(message.track) ?? `track ${message.track}`;
    switch (message.command) {
        case EsSoundCommand.SET_VOLUME:
            return `${name} ${Math.round(esSoundVolume(message.value) * 100)}% — ${file}`;
        case EsSoundCommand.SET_BALANCE:
            return `${name} ${describeEsSoundBalance(message.value)} — ${file}`;
        default:
            return `${name} — ${file}`;
    }
}

export function describeEsSoundBalance(value: number): string {
    const balance = esSoundBalance(value);
    if (balance === 0) {
        return 'center';
    }
    return `${Math.round(Math.abs(balance) * 100)}% ${balance < 0 ? 'L' : 'R'}`;
}

// from the LAME extension of the Xing/Info frame. Every decoder adds 529 more samples at the start; inaudible once, but
// a gap at every loop, so a looping track is cut to the music's first and last sample
export interface Mp3Gapless {
    frames: number; // without the Info frame itself
    samplesPerFrame: number;
    sampleRate: number;
    delay: number; // samples the encoder prepended
    padding: number; // samples the encoder appended
}

export const MP3_DECODER_DELAY = 529;

const MP3_SAMPLE_RATES: Record<number, number[]> = {
    3: [44100, 48000, 32000],  // MPEG 1
    2: [22050, 24000, 16000],  // MPEG 2
    0: [11025, 12000, 8000],   // MPEG 2.5
};

export function mp3GaplessInfo(bytes: Uint8Array): Mp3Gapless | undefined {
    const at = mp3AudioStart(bytes);
    if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) {
        return undefined;
    }
    const version = (bytes[at + 1] >> 3) & 3;
    const layer = (bytes[at + 1] >> 1) & 3;
    const rate = MP3_SAMPLE_RATES[version]?.[(bytes[at + 2] >> 2) & 3];
    if (layer !== 1 || !rate) {
        return undefined;  // Layer III only
    }
    const mono = ((bytes[at + 3] >> 6) & 3) === 3;
    const sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    let tag = at + 4 + sideInfo;
    const id = String.fromCharCode(...bytes.subarray(tag, tag + 4));
    if (id !== 'Xing' && id !== 'Info') {
        return undefined;
    }
    const flags = bytes[tag + 7];
    tag += 8;
    if (!(flags & 1)) {
        return undefined;  // no frame count, nothing to measure against
    }
    const frames = (bytes[tag] << 24 | bytes[tag + 1] << 16 | bytes[tag + 2] << 8 | bytes[tag + 3]) >>> 0;
    tag += 4;
    if (flags & 2) { tag += 4; }    // byte count
    if (flags & 4) { tag += 100; }  // seek table
    if (flags & 8) { tag += 4; }    // quality
    // LAME extension: encoder (9 bytes), revision, lowpass, replay gain (8), flags, bitrate, then delay and padding as
    // two 12-bit numbers
    const at21 = tag + 21;
    if (at21 + 3 > bytes.length) {
        return undefined;
    }
    const delay = bytes[at21] << 4 | bytes[at21 + 1] >> 4;
    const padding = (bytes[at21 + 1] & 0x0f) << 8 | bytes[at21 + 2];
    return { frames, samplesPerFrame: version === 3 ? 1152 : 576, sampleRate: rate, delay, padding };
}

// in seconds of the decoded buffer. Browsers differ: some cut the encoder's silence, some decode every frame, one
// counts the Info frame as a frame of silence too. Told apart by length; anything else is taken whole
export function esSoundAudibleWindow(info: Mp3Gapless | undefined, decodedLength: number, decodedRate: number):
    { start: number, end: number } {
    const whole = { start: 0, end: decodedLength / decodedRate };
    if (!info || info.delay === 0 && info.padding === 0) {
        return whole;
    }
    const length = decodedLength * info.sampleRate / decodedRate;  // in the file's own samples
    const raw = info.frames * info.samplesPerFrame;
    const music = raw - info.delay - info.padding;
    const near = (value: number) => Math.abs(length - value) <= info.samplesPerFrame / 2;
    if (near(music)) {
        return whole;
    }
    for (const lead of [0, info.samplesPerFrame]) {
        if (near(raw + lead)) {
            const start = lead + info.delay + MP3_DECODER_DELAY;
            return { start: start / info.sampleRate, end: (start + music) / info.sampleRate };
        }
    }
    return whole;
}

function mp3AudioStart(bytes: Uint8Array): number {
    // ten bytes of header with a syncsafe size, plus a footer if flagged
    if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        return 10 + syncsafe(bytes, 6) + ((bytes[5] & 0x10) ? 10 : 0);
    }
    return 0;
}

function syncsafe(bytes: Uint8Array, at: number): number {
    return (bytes[at] & 0x7f) << 21 | (bytes[at + 1] & 0x7f) << 14 | (bytes[at + 2] & 0x7f) << 7 | (bytes[at + 3] & 0x7f);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(at, at + length));
}

export interface EsSoundFileInfo {
    seconds?: number;
    title?: string;
}

// read from the headers, as decoding a whole soundtrack would cost hundreds of MB. A WAV states byte rate and data
// size, an MP3 its frame count in an Xing/Info frame; one without is walked frame by frame (exact for VBR too)
export function esSoundFileInfo(kind: EsSoundKind, bytes: Uint8Array): EsSoundFileInfo {
    try {
        return kind === 'wav' ? wavFileInfo(bytes) : mp3FileInfo(bytes);
    } catch {
        return {};  // a file damaged enough to read past its own end
    }
}

function wavFileInfo(bytes: Uint8Array): EsSoundFileInfo {
    if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
        return {};
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let byteRate: number | undefined;
    let dataSize: number | undefined;
    let title: string | undefined;
    for (let at = 12; at + 8 <= bytes.length;) {
        const id = ascii(bytes, at, 4);
        const size = view.getUint32(at + 4, true);
        const body = at + 8;
        if (id === 'fmt ' && size >= 12) {
            byteRate = view.getUint32(body + 8, true);
        } else if (id === 'data') {
            // streaming encoders leave the size at its maximum
            dataSize = Math.min(size, bytes.length - body);
        } else if (id === 'LIST' && ascii(bytes, body, 4) === 'INFO') {
            for (let entry = body + 4; entry + 8 <= Math.min(body + size, bytes.length);) {
                const length = view.getUint32(entry + 4, true);
                if (ascii(bytes, entry, 4) === 'INAM') {
                    title = textOf(bytes.subarray(entry + 8, entry + 8 + length), 'windows-1252');
                }
                entry += 8 + length + (length & 1);
            }
        }
        at = body + size + (size & 1);
    }
    return { seconds: byteRate && dataSize !== undefined ? dataSize / byteRate : undefined, title };
}

const MP3_BITRATES: Record<number, number[]> = {
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],  // MPEG 1
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],      // MPEG 2 and 2.5
};

function mp3FileInfo(bytes: Uint8Array): EsSoundFileInfo {
    const title = id3Title(bytes);
    const gapless = mp3GaplessInfo(bytes);
    if (gapless) {
        const music = gapless.frames * gapless.samplesPerFrame - gapless.delay - gapless.padding;
        if (music > 0) {
            return { seconds: music / gapless.sampleRate, title };
        }
    }
    // no LAME tag: count the frames. An Xing/Info frame without one is a frame of silence (~26 ms) the walk counts too
    let samples = 0;
    let rate = 0;
    for (let at = mp3AudioStart(bytes); at + 4 <= bytes.length;) {
        if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) {
            break;  // an ID3v1 tag, or the end of what can be trusted
        }
        const version = (bytes[at + 1] >> 3) & 3;
        const layer = (bytes[at + 1] >> 1) & 3;
        const frameRate = MP3_SAMPLE_RATES[version]?.[(bytes[at + 2] >> 2) & 3];
        const bitrate = MP3_BITRATES[version === 3 ? 3 : 2][bytes[at + 2] >> 4];
        if (layer !== 1 || !frameRate || !bitrate) {
            break;
        }
        const padding = (bytes[at + 2] >> 1) & 1;
        const perFrame = version === 3 ? 1152 : 576;
        samples += perFrame;
        rate = frameRate;
        at += Math.floor(perFrame / 8 * bitrate * 1000 / frameRate) + padding;
    }
    return { seconds: rate ? samples / rate : undefined, title };
}

// TIT2 of an ID3v2.3 or 2.4 tag
function id3Title(bytes: Uint8Array): string | undefined {
    if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3' || bytes[3] < 3) {
        return undefined;
    }
    const major = bytes[3];
    const end = Math.min(bytes.length, 10 + syncsafe(bytes, 6));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 10;
    if (bytes[5] & 0x40) {  // an extended header, sized differently per version
        at += major === 4 ? syncsafe(bytes, at) : 4 + view.getUint32(at);
    }
    while (at + 10 <= end && bytes[at] !== 0) {
        const id = ascii(bytes, at, 4);
        const size = major === 4 ? syncsafe(bytes, at + 4) : view.getUint32(at + 4);
        const body = bytes.subarray(at + 10, Math.min(end, at + 10 + size));
        if (id === 'TIT2' && body.length > 1) {
            return id3Text(body);
        }
        at += 10 + size;
    }
    return undefined;
}

function id3Text(body: Uint8Array): string | undefined {
    const text = body.subarray(1);
    switch (body[0]) {
        case 0: return textOf(text, 'windows-1252');
        case 1: return textOf(text, text[0] === 0xfe ? 'utf-16be' : 'utf-16le');
        case 2: return textOf(text, 'utf-16be');
        default: return textOf(text, 'utf-8');
    }
}

function textOf(bytes: Uint8Array, encoding: string): string | undefined {
    const text = new TextDecoder(encoding).decode(bytes).replace(/^﻿/, '').replace(/\0[\s\S]*$/, '').trim();
    return text || undefined;
}
