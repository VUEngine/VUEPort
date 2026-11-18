// a recording must abandon a failed encoder's bytes along with the encoder: Chrome accepted avc1,mp4a.40.2, failed on
// the first frame for want of an AAC encoder, and later handed over a partial MP4 that ended up in front of the real
// recording
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VideoRecorder, bridgeSampleRateFor } =
    require('../lib/browser/emulator-video-recorder.js');

let failures = 0;
function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`);
    if (!pass) {
        failures++;
        console.log(`     got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

// fails and flushes the way Chrome's does: the error first, what it had written in a later task
class FakeMediaRecorder {
    static instances = [];
    static reset() {
        FakeMediaRecorder.instances = [];
    }
    constructor(stream, options) {
        this.mimeType = options.mimeType;
        this.state = 'inactive';
        FakeMediaRecorder.instances.push(this);
    }
    start() {
        this.state = 'recording';
    }
    stop() {
        if (this.state === 'inactive') {
            return;
        }
        this.state = 'inactive';
        queueMicrotask(() => {
            this.deliver('trailer');
            this.onstop?.();
        });
    }
    deliver(text) {
        this.ondataavailable?.({ data: new Blob([text]) });
    }
    fail(name, flushed) {
        this.state = 'inactive';
        this.onerror?.({ error: { name } });
        queueMicrotask(() => this.deliver(flushed));
    }
}
globalThis.MediaRecorder = FakeMediaRecorder;

function newRecording(candidates) {
    FakeMediaRecorder.reset();
    const recording = new VideoRecorder({
        core: { audio: {}, connectAudio() { }, disconnectAudio() { } },
        sim: { setVideoTap: async () => { } },
        mode: { width: 384, height: 224 },
    }, candidates);
    recording.startEncoder();
    return recording;
}

const MP4 = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=av01,opus'];
const settled = () => new Promise(resolve => setTimeout(resolve, 0));
const text = async recording => await new Blob(recording.chunks).text();

// the first encoder fails before handing over anything, and delivers its finished file afterwards
{
    const recording = newRecording(MP4);
    const [first] = FakeMediaRecorder.instances;
    first.fail('EncodingError', 'avc1-file');
    await settled();

    check('the failure swaps to the next candidate',
        recording.mimeType, 'video/mp4;codecs=av01,opus');
    check('a second encoder is running',
        FakeMediaRecorder.instances.length, 2);

    const second = FakeMediaRecorder.instances[1];
    second.deliver('av01-');
    second.deliver('file');
    check('the abandoned encoder\'s flush stays out of the file',
        await text(recording), 'av01-file');
}

// the encoder that is still the recording's own must keep the last chunk it flushes when stopped
{
    const recording = newRecording(MP4);
    const [only] = FakeMediaRecorder.instances;
    only.deliver('body-');
    const finished = await recording.stop();
    check('a normal stop keeps the encoder\'s last chunk',
        await finished.blob.text(), 'body-trailer');
}

// a failure once bytes have been written: they are a file in one container already, so they are kept
{
    const recording = newRecording(MP4);
    const [first] = FakeMediaRecorder.instances;
    first.deliver('avc1-body');
    let reported;
    recording.onDidFail(why => reported = why);
    first.fail('EncodingError', '');
    await settled();

    check('a failure after bytes were written does not swap',
        recording.mimeType, 'video/mp4;codecs=avc1,mp4a.40.2');
    check('no second encoder is started',
        FakeMediaRecorder.instances.length, 1);
    check('what was encoded is kept', await text(recording), 'avc1-body');
    check('and the host is told', reported, 'EncodingError');
}

// AAC is defined only for a fixed set of sample rates, and the machine's own is not one of them, which is why
// Chrome failed avc1,mp4a.40.2 on the first frame and fell back to AV1 and Opus
{
    check('the machine\'s own rate has to be resampled',
        bridgeSampleRateFor(41700), 48000);
    check('and so does a rate AAC merely looks like it should take',
        bridgeSampleRateFor(32000), 48000);
    check('44100 is left alone', bridgeSampleRateFor(44100), undefined);
    check('48000 is left alone', bridgeSampleRateFor(48000), undefined);
}

class FakeAudioContext {
    static made = [];
    static refuse = false;
    constructor({ sampleRate }) {
        if (FakeAudioContext.refuse) {
            throw new Error('no audio device');
        }
        this.sampleRate = sampleRate;
        this.state = 'suspended';
        this.closed = false;
        FakeAudioContext.made.push(this);
    }
    async resume() {
        this.state = 'running';
    }
    createMediaStreamSource(stream) {
        this.bridged = stream;
        return { connect() { }, disconnect() { } };
    }
    createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => ['bridged'] } };
    }
    async close() {
        this.closed = true;
    }
}
globalThis.AudioContext = FakeAudioContext;

function withCoreAt(sampleRate) {
    FakeAudioContext.made = [];
    FakeMediaRecorder.reset();
    const mix = { stream: { getAudioTracks: () => ['core'] }, disconnect() { } };
    return new VideoRecorder({
        core: {
            audio: { sampleRate, createMediaStreamDestination: () => mix },
            connectAudio() { },
            disconnectAudio() { },
        },
        sim: { setVideoTap: async () => { } },
        mode: { width: 384, height: 224 },
    }, MP4);
}

{
    const recording = withCoreAt(41700);
    check('the mix reaches the encoder through the bridge',
        await recording.openAudio(), ['bridged']);
    const [bridge] = FakeAudioContext.made;
    check('built at a rate AAC knows', bridge.sampleRate, 48000);
    check('and started, since a suspended context carries nothing',
        bridge.state, 'running');
    recording.closeBridge();
    check('closed with the recording', bridge.closed, true);
}

// a context already at an encodable rate is left alone, a conversion that buys nothing still costs resampling
{
    const recording = withCoreAt(48000);
    check('an encodable rate is handed over untouched',
        await recording.openAudio(), ['core']);
    check('and no second context is built', FakeAudioContext.made.length, 0);
}

// no bridge is not a reason to refuse to record
{
    FakeAudioContext.refuse = true;
    const recording = withCoreAt(41700);
    check('a bridge that cannot be built falls back to the mix as it is',
        await recording.openAudio(), ['core']);
    FakeAudioContext.refuse = false;
}

process.exit(failures === 0 ? 0 : 1);
