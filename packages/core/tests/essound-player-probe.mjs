/**
 * Checks ESSound playback against a stand-in Web Audio context: a looping track loops on its music only, a track whose
 * levels were set ahead starts on the spot, and the position save states, pause, speed changes and rewind rely on
 * follows the context's clock. This avoids the gaps of looping through a media element.
 * Usage: node tests/essound-player-probe.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let failures = 0;

function check(label, actual, expected) {
    if (!Object.is(actual, expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

function near(label, actual, expected) {
    if (typeof actual !== 'number' || Math.abs(actual - expected) > 1e-6) {
        failures++;
        console.log(`  FAIL ${label}: got ${actual}, expected ${expected}`);
    }
}

function section(name) {
    console.log(`\n${name}`);
}

// a Web Audio context that only keeps the books

class Node {
    connect(target) { return target; }
    disconnect() { }
}

class Context {
    constructor() {
        this.currentTime = 0;
        this.state = 'running';
        this.sampleRate = 44100;
        this.destination = new Node();
        this.started = [];
        this.decoded = [];
        Context.last = this;
    }
    createGain() { const node = new Node(); node.gain = { value: 1 }; return node; }
    createStereoPanner() { const node = new Node(); node.pan = { value: 0 }; return node; }
    createMediaStreamDestination() { const node = new Node(); node.stream = {}; return node; }
    createBufferSource() {
        const context = this;
        const source = new Node();
        source.playbackRate = { value: 1 };
        source.stopped = false;
        source.start = (when, offset, duration) => {
            Object.assign(source, { when, offset, duration });
            context.started.push(source);
        };
        source.stop = () => { source.stopped = true; };
        return source;
    }
    // the bytes say how long the track is: frames of the Info tag, decoded as a browser that keeps the encoder's
    // silence would
    async decodeAudioData(buffer) {
        const bytes = new Uint8Array(buffer);
        const frames = bytes[44] << 24 | bytes[45] << 16 | bytes[46] << 8 | bytes[47];
        this.decoded.push(frames);
        return { length: frames * 1152, sampleRate: 44100, numberOfChannels: 2, duration: frames * 1152 / 44100 };
    }
    async suspend() { this.state = 'suspended'; }
    async resume() { this.state = 'running'; }
    async close() { }
}
globalThis.AudioContext = Context;

const { EsSoundPlayer } = require('../lib/browser/emulator-essound-player.js');
const { parseEsSoundTitles } = require('../lib/common/emulator-essound.js');

// an MP3 whose Info tag gives frames frames, 576 samples delay, 1000 padding
function mp3(frames) {
    const bytes = new Uint8Array(417).fill(0);
    bytes.set([0xff, 0xfb, 0x90, 0x64], 0);
    bytes.set([...'Info'].map(c => c.charCodeAt(0)), 36);
    bytes.set([0, 0, 0, 0x0f], 40);
    bytes.set([frames >>> 24, (frames >> 16) & 0xff, (frames >> 8) & 0xff, frames & 0xff], 44);
    const lame = 36 + 8 + 4 + 4 + 100 + 4;
    bytes.set([576 >> 4, ((576 & 0x0f) << 4) | (1000 >> 8), 1000 & 0xff], lame + 21);
    return bytes;
}

// a 16-bit stereo WAV of frames × 1152 samples; its first four data bytes repeat the frame count for the
// stand-in decoder above
function wav(frames) {
    const data = frames * 1152 * 4;
    const bytes = new Uint8Array(44 + 4).fill(0);
    const view = new DataView(bytes.buffer);
    bytes.set([...'RIFF'].map(c => c.charCodeAt(0)), 0);
    view.setUint32(4, 36 + data, true);
    bytes.set([...'WAVEfmt '].map(c => c.charCodeAt(0)), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 44100, true);
    view.setUint32(28, 44100 * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    bytes.set([...'data'].map(c => c.charCodeAt(0)), 36);
    view.setUint32(40, data, true);
    view.setUint32(44, frames);
    return bytes;
}

const files = {
    '/rom/3.mp3': mp3(100), '/rom/33.mp3': mp3(200), '/rom/5.mp3': mp3(50), '/rom/101.wav': wav(20),
    '/rom/essound.json': new TextEncoder().encode(JSON.stringify({ tracks: { 3: { title: 'Overworld' } } })),
};
const storage = {
    async list() {
        return Object.entries(files).map(([path, bytes]) => ({ name: path.split('/').pop(), path, size: bytes.length }));
    },
    async read(path) { return files[path]; },
    async readText(path) { return new TextDecoder().decode(files[path]); },
    parent() { return '/rom'; },
};

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const command = (track, cmd, value = 0) => (track << 8) | (value << 4) | cmd;
const PLAY = 1, PLAY_LOOP = 2, SET_VOLUME = 3, STOP = 0;

const lead = (576 + 529) / 44100;
const musicOf = frames => (frames * 1152 - 576 - 1000) / 44100;

const player = new EsSoundPlayer(storage);
await player.scanDirectory('/rom');
check('four tracks found', player.list.length, 4);

section('Titles from essound.json');
{
    const title = id => player.list.find(track => track.id === id).title;
    check('titled by the file', title(3), 'Overworld');
    check('untitled without an entry or a tag', title(33), undefined);
    check('no problem reported', player.titlesProblem, undefined);

    const problem = text => { try { parseEsSoundTitles(text); return undefined; } catch (error) { return error.message; } };
    check('a title per track id', parseEsSoundTitles('{"tracks":{"101":{"title":" Jump "}}}').get(101), 'Jump');
    check('an id no track has is refused', problem('{"tracks":{"0":{"title":"x"}}}')?.includes('"0"'), true);
    check('a title that is not a string is refused', problem('{"tracks":{"1":{"title":3}}}')?.includes('track 1'), true);
    check('no tracks object is refused', problem('{"1":"x"}')?.includes('tracks'), true);

    files['/rom/essound.json'] = new TextEncoder().encode('{ not json');
    const broken = new EsSoundPlayer(storage);
    await broken.scanDirectory('/rom');
    check('broken file reported', typeof broken.titlesProblem, 'string');
    check('tracks still found', broken.list.length, 4);
    files['/rom/essound.json'] = new TextEncoder().encode('{"tracks":{}}');
}

section('Lengths come from the headers, before anything is decoded');
{
    for (let tick = 0; tick < 10; tick++) {
        await settle();
    }
    const length = id => player.list.find(track => track.id === id).seconds;
    near('MP3 from its Info frame, without the encoder\'s silence', length(5), musicOf(50));
    // the header claims the full data size; only four bytes of it are there
    near('WAV from what of its data is there', length(101), 4 / (44100 * 4));
    check('nothing decoded for it', Context.last, undefined);
}

section('A track whose levels are set ahead is decoded ahead');
{
    player.handle(command(33, SET_VOLUME, 15));
    await settle();
    const context = Context.last;
    check('decoded without playing', context.decoded.length, 1);
    check('nothing started', context.started.length, 0);
    check('nothing playing', player.playing.length, 0);
}

section('An intro, then its loop');
{
    const context = Context.last;
    player.handle(command(3, PLAY));
    await settle();
    const intro = context.started.at(-1);
    check('intro does not loop', intro.loop, false);
    near('intro starts at its music', intro.offset, lead);
    near('intro plays its music only', intro.duration, musicOf(100));

    context.currentTime = 2;
    player.handle(command(33, PLAY_LOOP));
    // no await: the loop was decoded ahead, so it starts within the command
    const loop = context.started.at(-1);
    check('loop started at once', loop === intro, false);
    check('intro stopped', intro.stopped, true);
    check('loop loops', loop.loop, true);
    near('loop turns at the music\'s first sample', loop.loopStart, lead);
    near('and at its last', loop.loopEnd, lead + musicOf(200));
    near('loop starts at its music', loop.offset, lead);
    check('decoded once only', context.decoded.length, 2);
}

section('Position on the context clock');
{
    const context = Context.last;
    const length = musicOf(200);
    context.currentTime = 2 + length + 1.5;
    near('wraps round the loop', player.snapshot().playing[0].position, 1.5);

    player.setSpeed(2);
    context.currentTime += 1;
    near('twice as fast after a speed change', player.snapshot().playing[0].position, 3.5);
    player.setSpeed(1);

    player.setPaused(true);
    check('pause suspends the context', context.state, 'suspended');
    near('position held while the clock stands', player.snapshot().playing[0].position, 3.5);
    player.setPaused(false);
    check('resume runs it again', context.state, 'running');

    player.setRewinding(true);
    player.rewind(5);
    player.setRewinding(false);
    const rewound = context.started.at(-1);
    near('rewind wraps back through the loop point', rewound.offset - lead, length - 1.5);
    near('and the position says so', player.snapshot().playing[0].position, length - 1.5);
}

section('A track played once ends, and its slot with it');
{
    const context = Context.last;
    player.handle(command(3, PLAY));
    await settle();
    const once = context.started.at(-1);
    check('playing', player.playing.includes(3), true);
    once.onended();
    check('slot free after the end', player.playing.length, 0);
}

section('A save state puts the track back where it was');
{
    const context = Context.last;
    player.restore({ playing: [{ kind: 'mp3', track: 5, position: 0.25, loop: true }], volumes: [], balances: [] });
    await settle();
    const restored = context.started.at(-1);
    near('restored mid-track', restored.offset, lead + 0.25);
    check('restored looping', restored.loop, true);

    player.handle(command(5, STOP));
    check('stopped', player.playing.length, 0);
    check('source stopped', restored.stopped, true);
}

section('A track played from the panel while the emulator is paused');
{
    const context = Context.last;
    player.handle(command(33, PLAY_LOOP));
    const game = context.started.at(-1);
    context.currentTime += 1;
    player.setPaused(true);
    await settle();
    check('paused', context.state, 'suspended');

    player.audition(101);
    await settle();
    const manual = context.started.at(-1);
    check('the panel\'s track started', manual === game, false);
    check('once rather than looping', manual.loop, false);
    check('the context runs for it', context.state, 'running');
    check('the game\'s track is held', game.stopped, true);
    const shown = id => player.nowPlaying.find(entry => entry.track.id === id);
    check('marked as from the panel', shown(101).manual, true);
    check('the game\'s track waits', shown(33).waiting, true);
    near('and keeps its place', shown(33).position, 1);

    context.currentTime += 3;
    near('the held track has not moved', shown(33).position, 1);
    manual.onended();
    await settle();
    check('suspended again once it is over', context.state, 'suspended');

    player.setPaused(false);
    await settle();
    const resumed = context.started.at(-1);
    near('the game\'s track resumes where it was held', resumed.offset - lead, 1);

    player.seek(33, 2.5);
    const sought = context.started.at(-1);
    check('seeking starts a new source', sought === resumed, false);
    check('and stops the old one', resumed.stopped, true);
    near('at the music\'s position', sought.offset - lead, 2.5);
    near('the position says so', player.nowPlaying[0].position, 2.5);

    player.setPaused(true);
    player.seek(33, 4);
    near('a held track waits where it was sent', player.nowPlaying[0].position, 4);
    player.setPaused(false);
    await settle();
    near('and resumes from there', context.started.at(-1).offset - lead, 4);

    player.stopTrack(33);
    check('stopped from the panel', player.playing.length, 0);
}

section('A reset of the machine stops the track and its levels');
{
    // a reset keeps the simulation, so only its restart event says the game has started over
    const restarts = [];
    const sim = {
        onRestart(listener) {
            restarts.push(listener);
            return { dispose: () => restarts.splice(restarts.indexOf(listener), 1) };
        },
        async setEsSoundCapture() { },
    };
    await player.setSim(sim);
    player.handle(command(5, SET_VOLUME, 3));
    player.handle(command(5, PLAY_LOOP));
    await settle();
    check('playing before the reset', player.playing.length, 1);

    restarts.forEach(listener => listener());
    check('nothing playing after it', player.playing.length, 0);
    check('levels back to the default', player.snapshot().volumes.length, 0);

    await player.setSim(undefined);
    check('stops listening once the simulation is gone', restarts.length, 0);
}

if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nessound-player-probe: all checks passed');
