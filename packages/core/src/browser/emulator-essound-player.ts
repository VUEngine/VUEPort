import { Disposable, Emitter, Event } from '../common/emulator-events';
import { VueportStorage } from '../common/emulator-host';
import {
    decodeEsSoundMessage,
    describeEsSoundMessage,
    EsSoundCommand,
    esSoundAudibleWindow,
    esSoundBalance,
    esSoundFileInfo,
    esSoundFileName,
    EsSoundKind,
    esSoundKindOf,
    EsSoundMessage,
    ES_SOUND_TITLES_FILE,
    esSoundTrackOf,
    esSoundVolume,
    mp3GaplessInfo,
    parseEsSoundTitles,
} from '../common/emulator-essound';
import { Sim } from './core/vb-core';

export interface EsSoundTrack {
    id: number;
    kind: EsSoundKind;
    name: string;
    path: string;
    size: number;
    // estimated from the file's headers, exact once the track has been decoded
    seconds?: number;
    title?: string; // from essound.json, or else from the file's tags
}

export interface EsSoundNowPlaying {
    track: EsSoundTrack;
    position: number; // seconds
    loop: boolean;
    manual: boolean; // started from the panel rather than by the game
    waiting: boolean; // still being decoded, or held while the emulator is paused
}

export interface EsSoundHistoryEntry {
    time: number;
    message: EsSoundMessage;
    description: string;
    problem?: string;
}

// stored as JSON beside the core's state in a save state, as the core knows nothing about the audio played here and
// restoring a state would otherwise leave the previous track running
export interface EsSoundSnapshot {
    playing: { kind: EsSoundKind, track: number, position: number, loop: boolean }[];
    volumes: [number, number][];
    balances: [number, number][];
}

export const ES_SOUND_HISTORY_LENGTH = 20;

// browsers mute a track played beyond these rates
const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 4;

// what the hardware uses before SET VOLUME or SET BALANCE
const DEFAULT_VOLUME = 1;
const DEFAULT_BALANCE = 0;

// for tracks that are not playing. Decoded audio is 32-bit float per sample and channel (~22 MB per stereo minute),
// so a full soundtrack wouldn't fit; the least recently used tracks go first
const DECODED_BUDGET = 384 * 1024 * 1024;

interface EsSoundBuffer {
    buffer: AudioBuffer;
    // the audible part, in seconds: MP3s carry encoder silence at both ends
    start: number;
    end: number;
}

// one hardware slot (MP3 or WAV); a second PLAY replaces what it plays. Played from decoded audio, as a media element
// leaves audible gaps when loading and when seeking back for every loop
interface EsSoundSlot {
    track: number;
    loop: boolean;
    // started from the panel: plays even while the emulator is paused, the game's own tracks are held meanwhile
    manual: boolean;
    gain: GainNode;
    panner: StereoPannerNode;
    audio?: EsSoundBuffer;
    source?: AudioBufferSourceNode; // a source node plays only once, so each start makes a new one
    // position in seconds at context time `since`, moving at `rate`
    position: number;
    since: number;
    rate: number;
}

// held by the widget rather than the ESSound panel, as a game's audio has to play whether or not the panel is open.
// Decoded buffers are cached within a budget, since a game asks for the same handful of tracks over and over
export class EsSoundPlayer {

    protected tracks: EsSoundTrack[] = [];
    protected history: EsSoundHistoryEntry[] = [];
    protected sim: Sim | undefined;
    protected restartWatch: Disposable | undefined;
    protected muted = false;
    protected paused = false;
    protected rewinding = false;
    protected speed = 1;
    protected rewound = 0; // emulated seconds walked back by the rewind in progress
    protected scanned = false; // lets the panel tell "no tracks" from "not scanned yet"
    // the panel shows both, as "no files found" alone could mean an empty folder, badly named files or an unreadable one
    protected directory: string | undefined;
    protected failure: string | undefined;
    protected titlesFailure: string | undefined;

    // per track, as a game may set them before it plays the track
    protected readonly volumes = new Map<number, number>();
    protected readonly balances = new Map<number, number>();

    protected context: AudioContext | undefined;
    protected readonly slots = new Map<EsSoundKind, EsSoundSlot>();
    protected readonly decoded = new Map<number, EsSoundBuffer>(); // least recently used first
    protected readonly decoding = new Map<number, Promise<EsSoundBuffer>>();

    // what a video recording listens to (see openTap); a MediaStream, since an audio graph can't reach across contexts
    protected tap: MediaStreamAudioDestinationNode | undefined;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(protected readonly storage: VueportStorage) { }

    get list(): ReadonlyArray<EsSoundTrack> {
        return this.tracks;
    }

    get commands(): ReadonlyArray<EsSoundHistoryEntry> {
        return this.history;
    }

    get isScanned(): boolean {
        return this.scanned;
    }

    get lookedIn(): string | undefined {
        return this.directory;
    }

    get scanFailure(): string | undefined {
        return this.failure;
    }

    get titlesProblem(): string | undefined {
        return this.titlesFailure;
    }

    get hasTracks(): boolean {
        return this.tracks.length > 0;
    }

    get playing(): number[] {
        return [...this.slots.values()].map(slot => slot.track);
    }

    get nowPlaying(): EsSoundNowPlaying[] {
        const result: EsSoundNowPlaying[] = [];
        this.slots.forEach(slot => {
            const track = this.tracks.find(candidate => candidate.id === slot.track);
            if (track) {
                result.push({
                    track,
                    position: this.positionOf(slot),
                    loop: slot.loop,
                    manual: slot.manual,
                    waiting: !slot.source || this.context?.state !== 'running',
                });
            }
        });
        return result;
    }

    // plays from the panel, once from the start, replacing whatever its slot plays as if the game had asked for it
    audition(id: number): void {
        const track = this.tracks.find(candidate => candidate.id === id);
        if (!track) {
            return;
        }
        this.play(track.id, track.kind, false, 0, true);
        this.applyContextState();
        this.onDidChangeEmitter.fire();
    }

    // a track still being decoded starts at that position once ready, a held one waits there
    seek(id: number, seconds: number): void {
        const found = [...this.slots.entries()].find(([, candidate]) => candidate.track === id);
        if (!found) {
            return;
        }
        const [kind, slot] = found;
        this.dropSource(slot);
        slot.position = Math.max(0, seconds);
        if (slot.audio && !this.isHeld(slot)) {
            this.startSource(kind, slot, slot.audio);
        }
        this.onDidChangeEmitter.fire();
    }

    stopTrack(id: number): void {
        const kind = esSoundKindOf(id);
        if (kind) {
            this.stop(kind, id);
            this.applyContextState();
            this.onDidChangeEmitter.fire();
        }
    }

    // which files exist is the whole configuration; a missing file makes a command do nothing
    async scan(romPath: string): Promise<void> {
        await this.scanDirectory(this.storage.parent(romPath));
    }

    // a browser can't see the folder a ROM came from, so tracks zipped with it are unpacked into the emulator's storage
    // (see EmulatorCompanionFiles.sounds). Undefined when there's nowhere to look, which the panel then says
    async scanDirectory(directory: string | undefined): Promise<void> {
        this.stopAll();
        this.releaseDecoded();
        this.tracks = [];
        this.directory = directory;
        this.failure = undefined;
        this.titlesFailure = undefined;
        if (directory === undefined) {
            this.scanned = true;
            this.onDidChangeEmitter.fire();
            return;
        }
        try {
            let titles: string | undefined;
            for (const child of await this.storage.list(directory)) {
                const id = esSoundTrackOf(child.name);
                const kind = id === undefined ? undefined : esSoundKindOf(id);
                if (id !== undefined && kind !== undefined) {
                    this.tracks.push({ id, kind, name: child.name, path: child.path, size: child.size });
                } else if (child.name.toLowerCase() === ES_SOUND_TITLES_FILE) {
                    titles = child.path;
                }
            }
            this.tracks.sort((one, other) => one.id - other.id);
            if (titles) {
                await this.readTitles(titles);
            }
            this.scanned = true;
            this.measure(this.tracks);
        } catch (error) {
            console.warn(`[emulator] could not look for ESSound files in ${directory}:`, error);
            this.failure = String(error);
            this.scanned = true;
        }
        this.onDidChangeEmitter.fire();
    }

    protected async readTitles(path: string): Promise<void> {
        try {
            const titles = parseEsSoundTitles(await this.storage.readText(path));
            this.tracks.forEach(track => track.title = titles.get(track.id));
        } catch (error) {
            console.warn(`[emulator] could not use ${path}:`, error);
            this.titlesFailure = error instanceof Error ? error.message : String(error);
        }
    }

    // lengths and titles from the headers, one file at a time after the scan; cheap compared to decoding
    protected async measure(tracks: EsSoundTrack[]): Promise<void> {
        for (const track of tracks) {
            if (this.tracks !== tracks) {
                return;  // scanned again meanwhile
            }
            if (track.seconds !== undefined) {
                continue;  // already decoded, which is exact
            }
            try {
                const info = esSoundFileInfo(track.kind, await this.storage.read(track.path));
                track.seconds ??= info.seconds;
                track.title ??= info.title;
                this.onDidChangeEmitter.fire();
            } catch (error) {
                console.warn(`[emulator] could not read ESSound file ${track.name}:`, error);
            }
        }
    }

    // watching the port costs the core a callback on every CPU write, so only done if there are ESSound files
    async setSim(sim: Sim | undefined): Promise<void> {
        this.sim = sim;
        this.restartWatch?.dispose();
        // a reset keeps the simulation, so it's caught here, as the rebooted game may never send the INIT that would
        // stop the track
        this.restartWatch = sim?.onRestart(() => this.powerOn());
        this.stopAll();
        await sim?.setEsSoundCapture(this.hasTracks);
    }

    setMuted(muted: boolean): void {
        this.muted = muted;
        this.slots.forEach(slot => this.applyLevels(slot));
    }

    // pitch deliberately not preserved, as the machine's own audio also changes pitch. Clamped, as browsers mute
    // tracks at rates outside that range
    setSpeed(speed: number): void {
        this.speed = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, speed));
        this.slots.forEach(slot => this.applySpeed(slot));
    }

    // audio can't play backwards, so tracks hold during a rewind and seek back by the rewound time at the end, instead
    // of seeking an MP3 sixty times a second
    setRewinding(rewinding: boolean): void {
        if (this.rewinding === rewinding) {
            return;
        }
        this.rewinding = rewinding;
        if (rewinding) {
            this.rewound = 0;
        } else {
            this.slots.forEach(slot => this.applyPosition(slot, this.rewound));
            this.rewound = 0;
        }
        this.applyContextState();
        this.onDidChangeEmitter.fire();
    }

    rewind(seconds: number): void {
        this.rewound += seconds;
    }

    // paused rather than stopped, so resuming carries on; a track a paused emulator asks for is made ready, not started
    setPaused(paused: boolean): void {
        if (this.paused === paused) {
            return;
        }
        this.paused = paused;
        this.applyContextState();
        this.onDidChangeEmitter.fire();
    }

    protected get running(): boolean {
        return !this.paused && !this.rewinding;
    }

    snapshot(): EsSoundSnapshot {
        return {
            playing: [...this.slots.entries()].map(([kind, slot]) => ({
                kind,
                track: slot.track,
                position: this.positionOf(slot),
                loop: slot.loop,
            })),
            volumes: [...this.volumes.entries()],
            balances: [...this.balances.entries()],
        };
    }

    // stops everything first, as restoring a state from before a track started must stop it
    restore(snapshot: EsSoundSnapshot): void {
        this.stopAll();
        this.volumes.clear();
        this.balances.clear();
        snapshot.volumes.forEach(([track, volume]) => this.volumes.set(track, volume));
        snapshot.balances.forEach(([track, balance]) => this.balances.set(track, balance));

        snapshot.playing.forEach(entry => this.play(entry.track, entry.kind, entry.loop, entry.position));
        this.onDidChangeEmitter.fire();
    }

    handle(raw: number): void {
        const message = decodeEsSoundMessage(raw);
        const problem = this.apply(message);
        this.history.unshift({ time: Date.now(), message, description: describeEsSoundMessage(message), problem });
        this.history = this.history.slice(0, ES_SOUND_HISTORY_LENGTH);
        this.onDidChangeEmitter.fire();
    }

    // returns why, if the message could not be acted on
    protected apply(message: EsSoundMessage): string | undefined {
        if (message.kind === 'init') {
            // resets the levels; the click a real cartridge makes here is not worth reproducing
            this.powerOn();
            return undefined;
        }
        if (message.kind === 'stopAll') {
            this.stopAll();
            return undefined;
        }

        const kind = esSoundKindOf(message.track);
        if (!kind) {
            return `Track ${message.track} is outside both id ranges`;
        }

        switch (message.command) {
            case EsSoundCommand.PLAY:
            case EsSoundCommand.PLAY_LOOP:
                return this.play(message.track, kind, message.command === EsSoundCommand.PLAY_LOOP);
            case EsSoundCommand.STOP:
                this.stop(kind, message.track);
                return undefined;
            case EsSoundCommand.SET_VOLUME:
                this.volumes.set(message.track, esSoundVolume(message.value));
                this.refresh(message.track);
                this.prepare(message.track);
                return undefined;
            case EsSoundCommand.SET_BALANCE:
                this.balances.set(message.track, esSoundBalance(message.value));
                this.refresh(message.track);
                this.prepare(message.track);
                return undefined;
            default:
                return `Command ${message.command} is not one ESSound defines`;
        }
    }

    // a track not decoded yet starts once it is, from the requested position: late rather than with its start cut off
    protected play(track: number, kind: EsSoundKind, loop: boolean, position = 0, manual = false): string | undefined {
        const found = this.tracks.find(candidate => candidate.id === track);
        if (!found) {
            return `${esSoundFileName(track)} is not beside the ROM`;
        }

        this.stop(kind);
        const context = this.audioContext();
        const slot: EsSoundSlot = {
            track,
            loop,
            manual,
            gain: context.createGain(),
            panner: context.createStereoPanner(),
            position,
            since: context.currentTime,
            rate: this.speed,
        };
        slot.gain.connect(slot.panner).connect(context.destination);
        if (this.tap) {
            slot.panner.connect(this.tap);
        }
        this.slots.set(kind, slot);
        this.applyLevels(slot);

        const ready = this.decoded.get(track);
        if (ready) {
            this.touch(track, ready);
            this.startSource(kind, slot, ready);
            return undefined;
        }
        // the slot may have been taken over by another track by the time decoding is done
        this.decode(found).then(audio => {
            if (this.slots.get(kind) === slot) {
                this.startSource(kind, slot, audio);
                this.onDidChangeEmitter.fire();
            }
        }).catch(error => console.warn(`[emulator] ESSound could not decode ${found.name}:`, error));
        return undefined;
    }

    // a game that sets the levels of a track it isn't playing is about to play it, so decode it now and PLAY starts
    // right away
    protected prepare(track: number): void {
        if ([...this.slots.values()].some(slot => slot.track === track)) {
            return;
        }
        const found = this.tracks.find(candidate => candidate.id === track);
        if (found) {
            this.decode(found).catch(error => console.warn(`[emulator] ESSound could not decode ${found.name}:`, error));
        }
    }

    protected startSource(kind: EsSoundKind, slot: EsSoundSlot, audio: EsSoundBuffer): void {
        const context = this.audioContext();
        const position = this.positionOf(slot);
        this.dropSource(slot);
        slot.audio = audio;
        const length = audio.end - audio.start;
        if (!slot.loop && position >= length) {
            this.stop(kind);
            return;
        }
        if (this.isHeld(slot)) {
            return;  // started by applyContextState when it may sound
        }
        const source = context.createBufferSource();
        source.buffer = audio.buffer;
        source.loop = slot.loop;
        source.loopStart = audio.start;
        source.loopEnd = audio.end;
        source.playbackRate.value = this.speed;
        source.connect(slot.gain);
        // a track played once is over when it ends, and the slot with it
        source.onended = () => {
            if (slot.source === source && this.slots.get(kind) === slot) {
                this.stop(kind);
                this.applyContextState();
                this.onDidChangeEmitter.fire();
            }
        };
        const offset = slot.loop && length > 0 ? position % length : position;
        if (slot.loop) {
            source.start(0, audio.start + offset);
        } else {
            source.start(0, audio.start + offset, length - offset);
        }
        slot.source = source;
        slot.position = offset;
        slot.since = context.currentTime;
        slot.rate = this.speed;
    }

    // counted on the context's clock, which stands still while the context is suspended for a pause or rewind
    protected positionOf(slot: EsSoundSlot): number {
        if (!slot.source || !this.context) {
            return slot.position;
        }
        const position = slot.position + (this.context.currentTime - slot.since) * slot.rate;
        const length = slot.audio ? slot.audio.end - slot.audio.start : 0;
        if (length <= 0) {
            return position;
        }
        return slot.loop ? position % length : Math.min(position, length);
    }

    protected stop(kind: EsSoundKind, track?: number): void {
        const slot = this.slots.get(kind);
        if (!slot || (track !== undefined && slot.track !== track)) {
            return;
        }
        this.dropSource(slot);
        slot.gain.disconnect();
        slot.panner.disconnect();
        this.slots.delete(kind);
    }

    protected dropSource(slot: EsSoundSlot): void {
        const source = slot.source;
        if (!source) {
            return;
        }
        slot.position = this.positionOf(slot);
        slot.source = undefined;
        source.onended = null;
        try {
            source.stop();
        } catch {
            // already over
        }
        source.disconnect();
    }

    protected stopAll(): void {
        [...this.slots.keys()].forEach(kind => this.stop(kind));
        this.onDidChangeEmitter.fire();
    }

    protected powerOn(): void {
        this.stopAll();
        this.volumes.clear();
        this.balances.clear();
    }

    // suspending the context stops every source and its clock, so a pause or rewind resumes exactly. While a panel
    // track plays, the context keeps running and the game's tracks are held one by one instead
    protected applyContextState(): void {
        if (!this.context) {
            return;
        }
        const audible = this.running || [...this.slots.values()].some(slot => slot.manual);
        this.slots.forEach((slot, kind) => {
            if (this.isHeld(slot)) {
                if (audible) {
                    this.dropSource(slot);
                }
            } else if (!slot.source && slot.audio) {
                this.startSource(kind, slot, slot.audio);
            }
        });
        if (audible) {
            this.context.resume().catch(() => undefined);
        } else {
            this.context.suspend().catch(() => undefined);
        }
    }

    protected isHeld(slot: EsSoundSlot): boolean {
        return !this.running && !slot.manual;
    }

    protected applySpeed(slot: EsSoundSlot): void {
        if (!slot.source || !this.context) {
            slot.rate = this.speed;
            return;
        }
        // rebase the clock first, so the position stays right across the rate change
        slot.position = this.positionOf(slot);
        slot.since = this.context.currentTime;
        slot.rate = this.speed;
        slot.source.playbackRate.value = this.speed;
    }

    // wraps round when looping, so a rewind through a loop point lands where the loop actually was
    protected applyPosition(slot: EsSoundSlot, seconds: number): void {
        if (seconds <= 0) {
            return;
        }
        const length = slot.audio ? slot.audio.end - slot.audio.start : 0;
        let position = this.positionOf(slot) - seconds;
        if (slot.loop && length > 0) {
            position = ((position % length) + length) % length;
        }
        this.dropSource(slot);
        slot.position = Math.max(0, position);
        const kind = [...this.slots.entries()].find(([, candidate]) => candidate === slot)?.[0];
        if (kind && slot.audio) {
            this.startSource(kind, slot, slot.audio);
        }
    }

    protected refresh(track: number): void {
        this.slots.forEach(slot => {
            if (slot.track === track) {
                this.applyLevels(slot);
            }
        });
    }

    protected applyLevels(slot: EsSoundSlot): void {
        slot.gain.gain.value = this.muted ? 0 : this.volumes.get(slot.track) ?? DEFAULT_VOLUME;
        slot.panner.pan.value = this.balances.get(slot.track) ?? DEFAULT_BALANCE;
    }

    // for a recording to mix in. Taken after each slot's panner, so the recording gets what is heard, mute included.
    // Builds the context if nothing played yet, so an early recording has a source
    openTap(): MediaStream {
        if (!this.tap) {
            this.tap = this.audioContext().createMediaStreamDestination();
            this.slots.forEach(slot => slot.panner.connect(this.tap!));
        }
        return this.tap.stream;
    }

    closeTap(): void {
        if (!this.tap) {
            return;
        }
        this.slots.forEach(slot => {
            try {
                slot.panner.disconnect(this.tap!);
            } catch {
                // a slot built before the tap was opened is not connected to it
            }
        });
        this.tap.disconnect();
        this.tap = undefined;
    }

    protected audioContext(): AudioContext {
        if (!this.context) {
            this.context = new AudioContext();
        }
        // a context created before the first user gesture starts suspended; one held for a pause stays so until it ends
        if (this.context.state === 'suspended' && this.running) {
            this.context.resume();
        }
        return this.context;
    }

    protected decode(track: EsSoundTrack): Promise<EsSoundBuffer> {
        const ready = this.decoded.get(track.id);
        if (ready) {
            this.touch(track.id, ready);
            return Promise.resolve(ready);
        }
        const pending = this.decoding.get(track.id);
        if (pending) {
            return pending;
        }
        const work = (async () => {
            // copied into an ArrayBuffer of its own, as the read's buffer may be shared and decoding detaches it
            const bytes = new Uint8Array(await this.storage.read(track.path)).slice();
            const gapless = track.kind === 'mp3' ? mp3GaplessInfo(bytes) : undefined;
            const buffer = await this.audioContext().decodeAudioData(bytes.buffer);
            const audible = esSoundAudibleWindow(gapless, buffer.length, buffer.sampleRate);
            track.seconds = audible.end - audible.start;
            return { buffer, start: audible.start, end: audible.end };
        })();
        this.decoding.set(track.id, work);
        work.then(audio => {
            if (this.decoding.get(track.id) === work) {
                this.decoding.delete(track.id);
                this.touch(track.id, audio);
            }
        }, () => this.decoding.delete(track.id));
        return work;
    }

    // marks a track as just used and evicts the least recently used ones beyond the budget
    protected touch(id: number, audio: EsSoundBuffer): void {
        this.decoded.delete(id);
        this.decoded.set(id, audio);
        const bytes = (entry: EsSoundBuffer) => entry.buffer.length * entry.buffer.numberOfChannels * 4;
        let total = 0;
        this.decoded.forEach(entry => total += bytes(entry));
        const playing = new Set([...this.slots.values()].map(slot => slot.track));
        for (const [other, entry] of this.decoded) {
            if (total <= DECODED_BUDGET) {
                break;
            }
            if (other !== id && !playing.has(other)) {
                this.decoded.delete(other);
                total -= bytes(entry);
            }
        }
    }

    protected releaseDecoded(): void {
        this.decoded.clear();
        this.decoding.clear();
    }

    dispose(): void {
        this.restartWatch?.dispose();
        this.closeTap();
        this.stopAll();
        this.releaseDecoded();
        this.context?.close();
        this.onDidChangeEmitter.dispose();
    }
}
