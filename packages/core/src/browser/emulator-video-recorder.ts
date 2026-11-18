import { Emitter, Event } from '../common/emulator-events';
import { DisplayMode } from '../common/vb-constants';
import { Frame } from '../common/vb-protocol';
import { Core, Sim } from './core/vb-core';
import { EsSoundPlayer } from './emulator-essound-player';
import { VbRenderer } from '../worker/vb-renderer';

/**
 * Records picture and sound as a video file. The picture cannot be read off the screen, as the panel's canvas was
 * transferred to the worker and refuses to be captured. The frames are tapped at the source (setVideoTap in
 * vb-protocol.ts) and composed again into a canvas of our own, so a recording can use a different rendering mode,
 * palette and size than the live picture.
 *
 * ESSound (played by the page) and the machine's audio (from the core) are mixed into the core's audio context, with
 * ESSound handed over as a MediaStream, as graphs cannot cross contexts; a recorder given two audio tracks would
 * silently drop one. Mute, volume, balance and speed apply, as they are upstream of the taps.
 *
 * MediaRecorder.isTypeSupported answers for the muxer, not the encoders: Chrome accepts `avc1,mp4a.40.2` and raises
 * EncodingError on the first frame, as AAC has no 41700 Hz rate. So the audio is resampled for the recording only (see
 * openAudio), and an encoder failing before it wrote anything is swapped for the next candidate (see mimeTypes).
 *
 * The file is held in memory until stopped, as a browser has nowhere to stream it to, so a recording costs roughly its
 * bit rate in memory per second.
 */

// best first: VP9 over VP8, as flat areas of four brightnesses are what it is best at. Opus is the only audio WebM
// carries
const WEBM_TYPES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
];

// best first: H.264 with AAC plays everywhere; AV1 with Opus for a browser that cannot produce the first;
// bare video/mp4 for a browser that offers the container without naming what is in it
const MP4_TYPES = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=av01,opus',
    'video/mp4',
];

// how often the encoder hands over what it has, in milliseconds
const CHUNK_INTERVAL = 1000;

export const VIDEO_BIT_RATES: Record<VideoQuality, number> = {
    low: 1_500_000,
    medium: 4_000_000,
    high: 12_000_000,
};

export const AUDIO_BIT_RATE = 128_000;

// AAC stores its rate as an index into a table, so other rates cannot be written at all. The machine's 41700 Hz is
// not in it, and Chrome's encoder refuses 32000 too
export const AAC_SAMPLE_RATES = [44100, 48000];

// 48 kHz is what the hardware almost always runs at, and what Opus works in internally anyway
export const RECORDING_SAMPLE_RATE = 48_000;

// undefined for a context already running at a rate an encoder will take
export function bridgeSampleRateFor(rate: number): number | undefined {
    return AAC_SAMPLE_RATES.includes(rate) ? undefined : RECORDING_SAMPLE_RATE;
}

// the DOM types the event as a plain Event; browsers that carry detail give a DOMException whose name
// (EncodingError for a container the encoders cannot produce) is the only part worth repeating
function failureName(event: unknown): string | undefined {
    return (event as { error?: { name?: string } } | undefined)?.error?.name;
}

export type VideoQuality = 'low' | 'medium' | 'high';

// a preference, not a promise: the other container is still used rather than refusing to record
export type VideoFormat = 'auto' | 'webm' | 'mp4';

export function videoFormatOf(value: string | undefined): VideoFormat {
    return value === 'webm' || value === 'mp4' || value === 'auto' ? value : 'auto';
}

export function videoQualityOf(value: string | undefined): VideoQuality {
    return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
}

export interface VideoRecorderOptions {
    core: Core;
    sim: Sim;
    // left out for a ROM without tracks, as opening the tap builds the player's audio context
    esSound?: EsSoundPlayer;
    mode: DisplayMode;
    scale?: number;
    // a VideoQuality, anything else is read as the middle one
    quality?: string;
    // a VideoFormat, anything else is read as automatic
    format?: string;
}

export interface VideoRecording {
    blob: Blob;
    extension: string;
    frames: number;
    // in seconds, pauses excluded
    seconds: number;
    mimeType: string;
    failure?: string;
}

export class VideoRecorder {

    // the requested container first, then the other one, as Safari has no WebM encoder and Firefox no MP4 one.
    // This is what a browser says it can mux, not what it can encode (see the file header)
    static mimeTypes(format: string = 'auto'): string[] {
        if (typeof MediaRecorder === 'undefined') {
            return [];
        }
        // MP4 unless WebM was asked for: VP9 encodes this picture better, but H.264 in MP4 opens wherever it is taken.
        // A browser that cannot write it still gets WebM from the second half of this list
        const order = videoFormatOf(format) === 'webm'
            ? [...WEBM_TYPES, ...MP4_TYPES]
            : [...MP4_TYPES, ...WEBM_TYPES];
        return order.filter(type => MediaRecorder.isTypeSupported(type));
    }

    static mimeType(format?: string): string | undefined {
        return VideoRecorder.mimeTypes(format)[0];
    }

    // needs an encoder, a capturable canvas and a canvas track that takes frames on request (missing on WebKitGTK builds
    // of the desktop wrapper)
    static isSupported(): boolean {
        return VideoRecorder.mimeTypes().length > 0
            && typeof HTMLCanvasElement !== 'undefined'
            && typeof HTMLCanvasElement.prototype.captureStream === 'function';
    }

    // resolves once the encoder is running. The mode is held for the whole recording, as the stereo layouts differ in
    // size and a stream whose frames change size is not a file most players open
    static async start(options: VideoRecorderOptions): Promise<VideoRecorder> {
        const candidates = VideoRecorder.mimeTypes(options.format);
        if (candidates.length === 0) {
            throw new Error('This browser cannot record video.');
        }
        const recorder = new VideoRecorder(options, candidates);
        await recorder.begin();
        return recorder;
    }

    protected readonly core: Core;
    protected readonly sim: Sim;
    protected readonly esSound: EsSoundPlayer | undefined;
    protected readonly mode: DisplayMode;
    protected readonly scale: number;
    protected readonly quality: VideoQuality;

    // still worth trying, current one first. Shrinks so nothing can go back round to a failed one
    protected candidates: string[];

    protected canvas: HTMLCanvasElement | undefined;
    protected renderer: VbRenderer | undefined;
    protected output: HTMLCanvasElement | undefined;
    protected outputContext: CanvasRenderingContext2D | undefined;
    protected track: CanvasCaptureMediaStreamTrack | undefined;

    protected mix: MediaStreamAudioDestinationNode | undefined;
    protected esSoundSource: MediaStreamAudioSourceNode | undefined;
    protected bridge: AudioContext | undefined;
    protected bridgeSource: MediaStreamAudioSourceNode | undefined;

    protected recorder: MediaRecorder | undefined;
    protected chunks: Blob[] = [];
    // both encoders are fed from it, it outlives any one of them
    protected stream: MediaStream | undefined;
    protected failure: string | undefined;

    protected readonly onDidFailEmitter = new Emitter<string>();
    // a failing MediaRecorder stops on the spot, so without this a host would keep showing a record light.
    // What was encoded before the failure can still be saved by stop()
    readonly onDidFail: Event<string> = this.onDidFailEmitter.event;

    protected frames = 0;
    // wall-clock milliseconds spent recording, pauses excluded
    protected elapsed = 0;
    protected since = 0;
    protected paused = false;
    protected stopped = false;

    protected constructor(options: VideoRecorderOptions, candidates: string[]) {
        this.core = options.core;
        this.sim = options.sim;
        this.esSound = options.esSound;
        this.mode = options.mode;
        this.scale = Math.max(1, Math.floor(options.scale ?? 1));
        this.quality = videoQualityOf(options.quality);
        this.candidates = candidates;
    }

    get mimeType(): string {
        return this.candidates[0];
    }

    get seconds(): number {
        const running = this.paused || this.stopped ? 0 : Date.now() - this.since;
        return (this.elapsed + running) / 1000;
    }

    get frameCount(): number {
        return this.frames;
    }

    get isRecording(): boolean {
        return !this.stopped;
    }

    get extension(): string {
        return this.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    }

    // every failure on the way in releases what was built first, or the machine would keep mirroring its frames to a
    // handler that no longer exists until the ROM is closed
    protected async begin(): Promise<void> {
        try {
            await this.build();
        } catch (error) {
            await this.sim.setVideoTap().catch(() => undefined);
            this.release();
            throw error;
        }
    }

    protected async build(): Promise<void> {
        const canvas = document.createElement('canvas');
        this.canvas = canvas;
        this.renderer = new VbRenderer(canvas, this.mode);

        // a plain 2D canvas rather than the WebGL one, so the enlargement is a nearest-neighbor blit; the shader maps every
        // output pixel onto a source pixel, so a bigger drawing buffer would be a differently-cut picture (as in VbRenderer#capture)
        const output = document.createElement('canvas');
        output.width = this.mode.width * this.scale;
        output.height = this.mode.height * this.scale;
        this.output = output;
        const context = output.getContext('2d', { alpha: false });
        if (!context) {
            throw new Error('Could not acquire a 2D context to record into.');
        }
        context.imageSmoothingEnabled = false;
        // black rather than transparent, so a recording stopped before the machine ever presented is still a picture
        context.fillStyle = '#000000';
        context.fillRect(0, 0, output.width, output.height);
        this.outputContext = context;

        // zero, so the stream takes a frame when given one: one video frame per emulated frame at any speed, none while paused
        const video = output.captureStream(0);
        this.track = video.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;

        const audio = await this.openAudio();
        this.stream = new MediaStream([...video.getVideoTracks(), ...audio]);

        await this.sim.setVideoTap(frame => this.present(frame));

        // started last, so the file begins with a frame of the game rather than with the wait for one
        this.startEncoder();
        // one frame straight away, as a recording started on a paused machine gets no frame for a while
        this.track.requestFrame();
        this.since = Date.now();
    }

    // a MediaRecorder that failed stops for good, so trying the next candidate means a new one on the same canvas,
    // tap and audio mix, which carry on through the swap
    protected startEncoder(): void {
        const recorder = new MediaRecorder(this.stream!, {
            mimeType: this.mimeType,
            videoBitsPerSecond: VIDEO_BIT_RATES[this.quality],
            audioBitsPerSecond: AUDIO_BIT_RATE,
        });
        // only for the encoder that is still the recording's own, as an abandoned one flushes after the swap
        // (see encoderFailed)
        recorder.ondataavailable = event => {
            if (this.recorder === recorder && event.data.size > 0) {
                this.chunks.push(event.data);
            }
        };
        recorder.onerror = event => {
            if (this.recorder === recorder) {
                this.encoderFailed(failureName(event));
            }
        };
        this.recorder = recorder;
        recorder.start(CHUNK_INTERVAL);
    }

    // tries the next candidate only while nothing has been encoded yet (a browser accepting a container it has no
    // encoder for fails on the first frame). Once bytes are written, a later failure ends the recording and keeps what
    // there is
    protected encoderFailed(name: string | undefined): void {
        if (this.stopped || this.failure !== undefined) {
            return;
        }
        const written = this.chunks.reduce((size, chunk) => size + chunk.size, 0);
        let why = name ?? 'no reason given';
        while (written === 0 && this.candidates.length > 1) {
            const failed = this.mimeType;
            // drop the abandoned container's chunks and silence its encoder: a failed MediaRecorder still delivers what
            // it had (Chrome a whole finished MP4), which glued in front of the next file makes players read it with
            // the wrong codecs
            const abandoned = this.recorder;
            if (abandoned) {
                abandoned.ondataavailable = null;
                abandoned.onerror = null;
            }
            this.chunks = [];
            this.candidates = this.candidates.slice(1);
            console.warn(`[emulator] ${failed} could not be encoded (${why}),`
                + ` recording as ${this.mimeType} instead`);
            try {
                this.startEncoder();
                return;
            } catch (error) {
                why = error instanceof Error ? error.message : String(error);
            }
        }
        this.failure = name ?? 'the encoder failed';
        this.onDidFailEmitter.fire(this.failure);
    }

    // in the core's own audio context, where the machine's sound already is, so no resampling bridge sits in front of
    // the one thing that must not glitch. ESSound plays media elements in a context of its own, so it has to cross one
    protected async openAudio(): Promise<MediaStreamTrack[]> {
        const context = this.core.audio;
        const mix = context.createMediaStreamDestination();
        this.mix = mix;
        this.core.connectAudio(mix);

        if (this.esSound?.hasTracks) {
            const source = context.createMediaStreamSource(this.esSound.openTap());
            source.connect(mix);
            this.esSoundSource = source;
        }
        return (await this.resampled(mix.stream)).getAudioTracks();
    }

    /**
     * The mix at a rate an encoder will take: handed 41700 Hz, Chrome fails `avc1,mp4a.40.2` on the first frame, as AAC
     * has no such rate, and the recording falls back to AV1 and Opus. Carried through a second context via a
     * MediaStream, the only way audio crosses contexts, behind the tap, so playback never goes through it. A context
     * that cannot be built returns the unbridged mix, and the recording ends up in whichever container takes it.
     */
    protected async resampled(stream: MediaStream): Promise<MediaStream> {
        const rate = bridgeSampleRateFor(this.core.audio.sampleRate);
        if (rate === undefined) {
            return stream;
        }
        try {
            const bridge = new AudioContext({ sampleRate: rate });
            this.bridge = bridge;
            // a context built while the page may not make sound starts suspended and carries nothing; recording starts from
            // a button, so the permission is there to be taken
            if (bridge.state === 'suspended') {
                await bridge.resume();
            }
            const source = bridge.createMediaStreamSource(stream);
            const destination = bridge.createMediaStreamDestination();
            source.connect(destination);
            this.bridgeSource = source;
            return destination.stream;
        } catch (error) {
            console.warn('[emulator] recording at the machine\'s own sample rate:'
                + ` the mix could not be resampled (${error instanceof Error ? error.message : error})`);
            this.closeBridge();
            return stream;
        }
    }

    protected closeBridge(): void {
        this.bridgeSource?.disconnect();
        this.bridgeSource = undefined;
        this.bridge?.close().catch(() => {
        });
        this.bridge = undefined;
    }

    // synchronous throughout, as the buffer goes straight back to the worker when this returns
    protected present(frame: Frame): void {
        if (this.stopped || !this.renderer || !this.canvas || !this.outputContext || !this.output) {
            return;
        }
        this.renderer.present(new Uint8Array(frame.pixels), frame.colorMode, frame.kind);
        this.outputContext.drawImage(this.canvas, 0, 0, this.output.width, this.output.height);
        this.track?.requestFrame();
        this.frames++;
    }

    // a paused emulator presents nothing and suspends its audio, so a running recorder would write a silent still
    setPaused(paused: boolean): void {
        if (this.stopped || this.paused === paused || !this.recorder) {
            return;
        }
        this.paused = paused;
        if (paused) {
            this.elapsed += Date.now() - this.since;
            if (this.recorder.state === 'recording') {
                this.recorder.pause();
            }
        } else {
            this.since = Date.now();
            if (this.recorder.state === 'paused') {
                this.recorder.resume();
            }
        }
    }

    // the tap is closed first so no frame arrives after the encoder was told there are no more, and the last chunk is
    // waited for, as a file assembled before onstop is missing its end
    async stop(): Promise<VideoRecording> {
        if (this.stopped) {
            throw new Error('This recording has already been stopped.');
        }
        this.stopped = true;
        if (!this.paused) {
            this.elapsed += Date.now() - this.since;
        }

        await this.sim.setVideoTap().catch(() => {
        });

        const recorder = this.recorder;
        if (recorder && recorder.state !== 'inactive') {
            await new Promise<void>(resolve => {
                recorder.onstop = () => resolve();
                // an encoder that gives up never fires stop, and the chunks already handed over are a playable file
                recorder.onerror = () => resolve();
                recorder.stop();
            });
        }
        this.release();

        return {
            blob: new Blob(this.chunks, { type: this.mimeType }),
            extension: this.extension,
            frames: this.frames,
            seconds: this.elapsed / 1000,
            mimeType: this.mimeType,
            failure: this.failure,
        };
    }

    async cancel(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        await this.sim.setVideoTap().catch(() => undefined);
        if (this.recorder && this.recorder.state !== 'inactive') {
            this.recorder.stop();
        }
        this.chunks.length = 0;
        this.release();
    }

    protected release(): void {
        if (this.mix) {
            this.core.disconnectAudio(this.mix);
            this.esSoundSource?.disconnect();
            this.esSound?.closeTap();
            this.mix.disconnect();
        }
        this.mix = undefined;
        this.esSoundSource = undefined;
        this.closeBridge();
        this.track?.stop();
        this.track = undefined;
        this.renderer?.dispose();
        this.renderer = undefined;
        this.canvas = undefined;
        this.output = undefined;
        this.outputContext = undefined;
        this.recorder = undefined;
        this.stream = undefined;
        this.onDidFailEmitter.dispose();
    }
}
