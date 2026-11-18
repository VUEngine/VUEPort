// the link session's state machine against stand-in machines, as the ordering is what went wrong while building it:
// handshake and refusals, starting both machines from one place, input on the right frames, digests.
// tests/two-window-link-probe.mjs in packages/web plays two real windows. Usage: node tests/link-session-probe.mjs

import { createRequire } from 'node:module';

// a rejected promise inside the session would otherwise be swallowed and look like a check that did not happen
process.on('unhandledRejection', error => {
    console.log(`  FAIL something threw: ${error && error.message}`);
    process.exit(1);
});

const require = createRequire(import.meta.url);
const { LinkSession, LinkState } = require('../lib/browser/link-session.js');
const { LINK_PROTOCOL_VERSION } = require('../lib/common/link-channel.js');
const { Emitter } = require('../lib/common/emulator-events.js');
const { withTurbo } = require('../lib/common/emulator-turbo.js');

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
    if (!ok) {
        failures++;
    }
};

// generous on purpose: starting a session is some twenty awaited calls deep once the previous run's machines were
// handed back, and running out halfway would look like a session that failed to start
const settle = async () => {
    for (let i = 0; i < 200; i++) {
        await Promise.resolve();
    }
};

function makeSim(id, log, name) {
    const booked = new Map();
    // writes booked against frames, the way queueEdits books them
    const edits = new Map();
    return {
        id,
        booked,
        edits,
        // set to make the next booking fail, as one for a past frame does
        refuseEdits: false,
        async queueKeys(frame, keys) { booked.set(frame, keys); },
        async queueEdits(frame, booking) {
            if (this.refuseEdits) {
                throw new Error(`Frame ${frame} has already been emulated.`);
            }
            edits.set(frame, [...(edits.get(frame) ?? []), ...booking]);
        },
        async setLockstep(on) { log.push(`${name}:lockstep=${on}`); },
        async setDigestPeriod(frames) { log.push(`${name}:digest=${frames}`); },
        async linkJournal() { return [{ frame: 0, kind: 'reset', cartRam: id }]; },
        async setVolume(volume) { log.push(`${name}:volume=${volume}`); },
        async setEsSoundCapture(on) { log.push(`${name}:esSound=${on}`); },
        async setHardwareMode(vbc) { log.push(`${name}:vbc=${vbc}`); },
        async setCartRom(rom) { log.push(`${name}:cartRom=${rom.byteLength}`); },
        async setCartRam() { log.push(`${name}:cartRam`); },
        // the window is all of Game Pak RAM; `used` is how much of it the session actually sends
        async cartRamInfo() { return { size: 0x1000000, used: 16384 }; },
        async getCartRam(length = 16384) { return new ArrayBuffer(length); },
        async saveState() { return new TextEncoder().encode(`${name}-state`).buffer; },
        async loadState(state) {
            log.push(`${name}:loadState=${new TextDecoder().decode(state)}`);
        },
        async reset() { log.push(`${name}:reset`); booked.clear(); edits.clear(); },
    };
}

function makeEmulatorSession() {
    const log = [];
    const progress = new Emitter();
    const awaiting = new Emitter();
    const digest = new Emitter();
    const stalled = new Emitter();
    const sim = makeSim(1, log, 'own');
    const mirror = makeSim(2, log, 'mirror');
    return {
        log,
        sim,
        mirrorSim: mirror,
        mirror: undefined,
        core: {
            onProgress: progress.event,
            onAwaitingInput: awaiting.event,
            onDigest: digest.event,
            onStalled: stalled.event,
        },
        fireStalled: frames => stalled.fire({ frames }),
        fireProgress: frame => progress.fire({ frame }),
        fireAwaiting: (waiting, frame, sims) => awaiting.fire({ waiting, frame, sims: sims ?? [] }),
        fireDigest: (simId, frame, value) => digest.fire({ sim: simId, frame, digest: value }),
        async attachMirror(rom, seat) {
            log.push(`mirror:cartRom=${rom ? rom.byteLength : 'MISSING'}`);
            log.push(`mirror:seat=${seat}`);
            this.mirror = mirror;
            return mirror;
        },
        mirrorWork: Promise.resolve(),
        withMirror(work) {
            const next = this.mirrorWork.then(work, work);
            this.mirrorWork = next.catch(() => undefined);
            return next;
        },
        async detachMirror() {
            // slow on purpose: handing the machines back is three worker round trips, slower than greeting the other window,
            // and the last section depends on that order
            for (let i = 0; i < 50; i++) {
                await Promise.resolve();
            }
            this.mirror = undefined;
        },
    };
}

// delivery is deferred to a microtask like a real channel, so a session cannot depend on being told synchronously
function makeChannelPair() {
    const emitters = [new Emitter(), new Emitter()];
    const sent = [[], []];
    const make = index => ({
        sent: sent[index],
        send(message) {
            sent[index].push(message);
            // structuredClone, as a real channel does, in particular for the ArrayBuffers a begin or resume is mostly made of
            const clone = structuredClone(message);
            Promise.resolve().then(() => emitters[1 - index].fire(clone));
        },
        onMessage: emitters[index].event,
        dispose() { },
    });
    return [make(0), make(1)];
}

function makePair(overrides = {}) {
    const [channelOne, channelTwo] = makeChannelPair();
    const one = makeEmulatorSession();
    const two = makeEmulatorSession();
    const common = {
        rom: 'abc123', core: 1876048,
        romData: () => new ArrayBuffer(1 << 20),
        ...overrides,
    };
    return {
        one,
        two,
        first: new LinkSession({ session: one, channel: channelOne, seat: 1, ...common }),
        second: new LinkSession({
            session: two, channel: channelTwo, seat: 2, ...common, ...(overrides.second ?? {}),
        }),
        channelOne,
        channelTwo,
    };
}

console.log('\nThe link session\n');

// the handshake
{
    const { first, second, one, two, channelOne, channelTwo } = makePair();
    first.start();
    second.start();
    await settle();

    check('the two windows connect', first.connected && second.connected,
        `${first.state} / ${second.state}`);
    // which answer decides where the session starts from must not be a race: only player 2 greets, only player 1 answers
    check('only player 2 says hello',
        channelTwo.sent.some(m => m.kind === 'hello')
        && !channelOne.sent.some(m => m.kind === 'hello'),
        `p1 sent ${channelOne.sent.map(m => m.kind).join(',')}`);
    check('and only player 1 says where to start from',
        channelOne.sent.some(m => m.kind === 'begin')
        && !channelTwo.sent.some(m => m.kind === 'begin'),
        `p2 sent ${channelTwo.sent.map(m => m.kind).join(',')}`);

    // a machine left running between reset and hold would run past the frames both windows then book from zero
    const order = one.log.filter(entry => /lockstep|reset/.test(entry));
    check('lockstep goes on before anything is reset',
        order.indexOf('own:lockstep=true') < order.indexOf('own:reset')
        && order.indexOf('mirror:lockstep=true') < order.indexOf('mirror:reset'),
        one.log.join(' '));
    check('both machines start from the same save',
        one.log.filter(e => e.endsWith(':cartRam')).length === 2);
    // without this the mirror boots into empty memory, which looks like a session until the digests differ
    check('the mirror is given the cartridge',
        one.log.some(e => e.startsWith('mirror:cartRom=') && !e.endsWith('MISSING')),
        one.log.join(' '));
    check('the other player is muted in this window', one.log.includes('mirror:volume=0'));
    // each window names its own seat, so both hand the pair to the core in the same order; otherwise the cable is emulated
    // differently and the digests part a second into a game using it (tests/link-order-probe.mjs)
    check('each window attaches its mirror under its own seat',
        one.log.includes('mirror:seat=1') && two.log.includes('mirror:seat=2'),
        `${one.log.filter(e => e.startsWith('mirror:seat')).join(',')} / `
        + `${two.log.filter(e => e.startsWith('mirror:seat')).join(',')}`);
    check('both windows ask for digests',
        one.log.some(e => e.startsWith('own:digest=')) && two.log.some(e => e.startsWith('own:digest=')));

    first.dispose();
    second.dispose();
}

// what the handshake refuses
for (const [label, overrides, reason] of [
    ['a different game', { second: { rom: 'deadbeef' } }, 'rom'],
    ['a different core build', { second: { core: 999 } }, 'core'],
]) {
    const { first, second } = makePair(overrides);
    first.start();
    second.start();
    await settle();
    check(`${label} is refused`,
        first.state === LinkState.Closed && first.refusal?.reason === reason,
        `${first.state} / ${first.refusal?.reason}`);
    check(`and says so in words a person can act on`,
        typeof first.refusal?.message === 'string' && first.refusal.message.length > 20,
        first.refusal?.message);
    first.dispose();
    second.dispose();
}

{
    // both windows opened as the same player: the address was reused
    const [channelOne, channelTwo] = makeChannelPair();
    const common = { rom: 'abc123', core: 1876048, romData: () => new ArrayBuffer(1 << 20) };
    const a = new LinkSession({ session: makeEmulatorSession(), channel: channelOne, seat: 2, ...common });
    const b = new LinkSession({ session: makeEmulatorSession(), channel: channelTwo, seat: 2, ...common });
    a.start();
    b.start();
    await settle();
    check('two windows as the same player are refused',
        a.state === LinkState.Closed && a.refusal?.reason === 'seat', `${a.state} / ${a.refusal?.reason}`);
    a.dispose();
    b.dispose();
}

// input crossing on the right frames
{
    const { first, second, one, two } = makePair();
    first.start();
    second.start();
    await settle();

    check('the session books from frame zero the moment it begins',
        one.sim.booked.has(0) && two.sim.booked.has(0));
    check('and ahead of the machine, not level with it',
        one.sim.booked.size > 1, `only ${one.sim.booked.size} frame(s) booked`);

    // a press reaches the frames still to come, not the ones already booked and sent
    first.setKeys(0x0006);
    second.setKeys(0x000a);
    one.fireProgress(10);
    two.fireProgress(10);
    await settle();

    check('a press reaches the frames still to be booked',
        one.sim.booked.get(10) === 0x0006 && two.sim.booked.get(10) === 0x000a,
        `${one.sim.booked.get(10)} / ${two.sim.booked.get(10)}`);
    check('and the other window books the same frames on its mirror',
        one.mirrorSim.booked.get(10) === 0x000a && two.mirrorSim.booked.get(10) === 0x0006,
        `${one.mirrorSim.booked.get(10)} / ${two.mirrorSim.booked.get(10)}`);

    // a window that stalls says so, and stops saying so when it catches up
    one.fireAwaiting(true, 4, [1]);
    check('a window with nothing booked reports itself stalled',
        first.state === LinkState.Stalled, first.state);
    one.fireAwaiting(false, 4, []);
    check('and reports itself running again when input arrives',
        first.state === LinkState.Connected, first.state);

    first.dispose();
    second.dispose();
}

// turbo, booked frame by frame
{
    const { first, second, one, two } = makePair();
    first.start();
    second.start();
    await settle();

    // RIGHT held, A on turbo at two frames a half period, from frame 20 on
    first.setKeys(0x0102);
    first.setTurbo(0x0004, 2);
    one.fireProgress(20);
    two.fireProgress(20);
    await settle();

    const frames = [20, 21, 22, 23];
    const expected = frames.map(frame => withTurbo(0x0102, 0x0004, frame, 2));
    check('turbo is worked into every booked frame, in rhythm',
        frames.map(frame => one.sim.booked.get(frame)).join() === expected.join(),
        `${frames.map(frame => one.sim.booked.get(frame)).join()} vs ${expected.join()}`);
    check('pressed on some of them and released on others',
        expected.some(keys => keys & 0x0004) && expected.some(keys => !(keys & 0x0004)));
    check('and the other window books exactly the same masks on its mirror',
        frames.map(frame => two.mirrorSim.booked.get(frame)).join() === expected.join(),
        frames.map(frame => two.mirrorSim.booked.get(frame)).join());

    first.setTurbo(0, 2);
    one.fireProgress(40);
    two.fireProgress(40);
    await settle();
    check('letting go of turbo books only what is held',
        [40, 41, 42].every(frame => one.sim.booked.get(frame) === 0x0102),
        [40, 41, 42].map(frame => one.sim.booked.get(frame)).join());

    first.dispose();
    second.dispose();
}

// input that arrives before this window is ready
{
    const [channelOne, channelTwo] = makeChannelPair();
    const common = { rom: 'abc123', core: 1876048, romData: () => new ArrayBuffer(1 << 20) };
    const two = makeEmulatorSession();
    // player 1's window is stood in for by hand, so its input arrives before player 2's window has begun
    channelOne.send({ kind: 'input', seat: 1, epoch: 0, frame: 0, keys: 0x00c0 });
    channelOne.send({ kind: 'input', seat: 1, epoch: 0, frame: 1, keys: 0x00c0 });
    const second = new LinkSession({ session: two, channel: channelTwo, seat: 2, ...common });
    await settle();
    check('input arriving before the mirror is ready is not lost',
        two.mirrorSim.booked.size === 0, 'it was booked into a machine about to be reset');

    channelOne.send({
        kind: 'welcome', seat: 1, protocol: LINK_PROTOCOL_VERSION, rom: 'abc123', core: 1876048, delay: 3,
    });
    channelOne.send({
        kind: 'begin', seat: 1, epoch: 0, cartRam: new ArrayBuffer(16384), cartRamWindow: 0x1000000,
    });
    await settle();
    check('and is booked once the session has begun',
        two.mirrorSim.booked.get(0) === 0x00c0 && two.mirrorSim.booked.get(1) === 0x00c0,
        [...two.mirrorSim.booked.keys()].join(','));
    second.dispose();
}

// repeated hellos
{
    const { first, second, one } = makePair();
    first.start();
    second.start();
    await settle();
    const resetsAfterFirstBegin = one.log.filter(e => e === 'own:reset').length;
    // player 2 keeps greeting until it hears back; the answer must not start the session over each time
    for (let i = 0; i < 3; i++) {
        second.channel?.send?.({ kind: 'hello', seat: 2, protocol: LINK_PROTOCOL_VERSION, rom: 'abc123', core: 1876048 });
    }
    await settle();
    check('a repeated hello does not start the session again',
        one.log.filter(e => e === 'own:reset').length === resetsAfterFirstBegin,
        `${one.log.filter(e => e === 'own:reset').length} resets`);
    first.dispose();
    second.dispose();
}

// the digests
{
    const { first, second, one, two } = makePair();
    first.start();
    second.start();
    await settle();

    // both agree: this window's own machine at frame 60 is the other window's mirror at frame 60
    one.fireDigest(one.sim.id, 60, 0xabcdef);
    two.fireDigest(two.mirrorSim.id, 60, 0xabcdef);
    await settle();
    check('matching digests leave the session alone',
        second.state !== LinkState.Closed, second.state);

    one.fireDigest(one.sim.id, 120, 0x11111111);
    two.fireDigest(two.mirrorSim.id, 120, 0x22222222);
    await settle();
    check('a digest that disagrees ends the session',
        second.state === LinkState.Closed && second.refusal?.reason === 'desync',
        `${second.state} / ${second.refusal?.reason}`);
    check('and says what happened',
        (second.refusal?.message ?? '').toLowerCase().includes('match'),
        second.refusal?.message);
    check('the machines are handed back',
        two.log.includes('own:digest=0') && two.log.includes('own:lockstep=false'),
        two.log.join(' '));

    first.dispose();
    second.dispose();
}

// player 1's cartridge is the game for all four machines
{
    // player 1 runs a patched image on a VB Color console with ESSound tracks; player 2 opened the plain file
    const { first, second, one, two } = makePair({
        cartridge: () => ({ image: new ArrayBuffer(1 << 21), vbc: true, esSound: true }),
        second: { cartridge: () => ({ vbc: false, esSound: false }) },
    });
    first.start();
    second.start();
    await settle();
    check('a patched session connects', first.connected && second.connected,
        `${first.state} / ${second.state}`);
    check('player 1\'s mirror runs player 1\'s image',
        one.log.includes(`mirror:cartRom=${1 << 21}`), one.log.join(' '));
    check('player 2\'s own machine is given that image too, on player 1\'s console',
        two.log.includes(`own:cartRom=${1 << 21}`) && two.log.includes('own:vbc=true'),
        two.log.join(' '));
    check('held before its code is swapped',
        two.log.indexOf('own:lockstep=true') < two.log.indexOf(`own:cartRom=${1 << 21}`),
        two.log.join(' '));
    check('and its mirror is built from it',
        two.log.includes(`mirror:cartRom=${1 << 21}`), two.log.join(' '));
    check('player 1 keeps the machine it already runs',
        !one.log.some(entry => entry.startsWith('own:cartRom')), one.log.join(' '));
    check('every machine has the ESSound chip player 1 has',
        ['own:esSound=true', 'mirror:esSound=true'].every(e => one.log.includes(e) && two.log.includes(e)),
        `${one.log.join(' ')} // ${two.log.join(' ')}`);
    second.dispose('session');
    await settle();
    check('leaving puts the chip back to what this window has',
        two.log.filter(e => e.startsWith('own:esSound')).pop() === 'own:esSound=false',
        two.log.join(' '));
    first.dispose();
}

// the report a session leaves behind when it goes wrong
{
    const reports = [];
    const { first, second, one, two } = makePair({
        onReport: report => reports.push(report),
    });
    first.start();
    second.start();
    await settle();

    one.fireDigest(one.sim.id, 60, 0x11111111);
    two.fireDigest(two.mirrorSim.id, 60, 0x22222222);
    one.fireDigest(one.sim.id, 120, 0x33333333);
    two.fireDigest(two.mirrorSim.id, 120, 0x44444444);
    await settle();
    const report = reports[0];
    check('a desync leaves exactly one report', reports.length === 1, `${reports.length} reports`);
    check('naming the frame and both digests',
        report?.reason === 'desync' && report.mismatch?.frame === 60
        && report.mismatch.mirror === 0x22222222 && report.mismatch.theirs === 0x11111111,
        JSON.stringify(report?.mismatch));
    // player 2's window: its own machine is player 2's, its mirror player 1's
    check('with each machine\'s journal under the player it belongs to',
        report?.seat === 2
        && report.journals.p2[0]?.cartRam === two.sim.id
        && report.journals.p1[0]?.cartRam === two.mirrorSim.id,
        JSON.stringify(report?.journals));
    check('and the save the run began from',
        typeof report?.cartRam === 'string' && report.cartRamWindow === 0x1000000,
        `${typeof report?.cartRam} / ${report?.cartRamWindow}`);
    check('taken before the machines were handed back',
        second.state === LinkState.Closed && second.refusal?.reason === 'desync');
    first.dispose();
    second.dispose();
}

{
    const reports = [];
    const { first, second, one } = makePair({ onReport: report => reports.push(report) });
    first.start();
    second.start();
    await settle();
    one.fireStalled(512);
    await settle();
    check('a stall while linked leaves a report',
        reports.length === 1 && reports[0].reason === 'stalled' && reports[0].seat === 1,
        JSON.stringify(reports.map(r => [r.reason, r.seat])));
    first.dispose();
    second.dispose();
}

{
    // the window running behind gets the other's digest first; held until its own is taken, a disagreement is still one
    // (this used to be dropped, so a desync in the window ahead went unnoticed)
    const { first, second, one, two } = makePair();
    first.start();
    second.start();
    await settle();
    one.fireDigest(one.sim.id, 60, 0x11111111);     // player 1's own, sent over
    await settle();
    two.fireDigest(two.mirrorSim.id, 60, 0x22222222); // player 2's copy, a moment later
    await settle();
    check('a digest that arrives before ours is still compared',
        second.state === LinkState.Closed && second.refusal?.reason === 'desync',
        `${second.state} / ${second.refusal?.reason}`);
    first.dispose();
    second.dispose();
}

{
    // a digest for a frame this window has nothing for is not a disagreement
    const { first, second, two } = makePair();
    first.start();
    second.start();
    await settle();
    two.fireDigest(two.mirrorSim.id, 60, 0xaaaa);
    await settle();
    check('a digest with no counterpart is not treated as a desync',
        second.state !== LinkState.Closed, second.state);
    first.dispose();
    second.dispose();
}

// the machines saying they wait is not the session having begun
{
    // begin switches lockstep on before resetting, and the worker answers "waiting" at once; taken as running, it let the
    // other window's input into machines that were then reset
    const { first, second, one } = makePair();
    first.start();
    one.fireAwaiting(true, 0, [1]);
    check('a machine waiting before the run has begun leaves the session waiting',
        first.state === LinkState.Waiting && !first.connected, first.state);
    second.start();
    await settle();
    one.fireAwaiting(true, 4, [1]);
    check('once it has begun, waiting is a stall', first.state === LinkState.Stalled, first.state);
    first.dispose();
    second.dispose();
}

// a reset is a reset of both consoles
{
    const { first, second, one, two } = makePair();
    first.start();
    second.start();
    await settle();
    one.log.length = 0;
    two.log.length = 0;
    one.sim.booked.clear();
    two.sim.booked.clear();
    await second.restart();
    await settle();
    check('a reset in one window resets every machine in both',
        ['own:reset', 'mirror:reset'].every(e => one.log.includes(e) && two.log.includes(e)),
        `${one.log.join(' ')} | ${two.log.join(' ')}`);
    check('without loading anything into them',
        ![...one.log, ...two.log].some(e => e.includes('loadState')));
    check('and both book from frame zero again, still linked',
        one.sim.booked.has(0) && two.sim.booked.has(0) && first.connected && second.connected);
    // both pressing at once is one reset each, not two
    one.log.length = 0;
    two.log.length = 0;
    await Promise.all([first.restart(), second.restart()]);
    await settle();
    check('two resets at once reset each machine once',
        one.log.filter(e => e === 'own:reset').length === 1
        && two.log.filter(e => e === 'own:reset').length === 1,
        `${one.log.join(' ')} | ${two.log.join(' ')}`);
    first.dispose();
    second.dispose();
}

// a pause is a pause of both windows
{
    const told = [];
    const { first, second, two } = makePair({ second: { onPeerPaused: paused => told.push(paused) } });
    first.start();
    second.start();
    await settle();
    first.setPaused(true);
    await settle();
    check('pausing in one window tells the other to pause', told.join() === 'true', told.join());
    // player 1's window now books nothing, so player 2's stands still: a pause, not a player who has gone
    two.fireAwaiting(true, 4, [2]);
    check('standing still for a paused player does not start the give-up timer',
        second.state === LinkState.Stalled && second.stallTimer === undefined,
        `${second.state} / ${String(second.stallTimer)}`);
    first.setPaused(false);
    await settle();
    check('carrying on tells it to carry on', told.join() === 'true,false', told.join());
    check('and a stall from then on is timed again', second.stallTimer !== undefined);
    // the window that paused waits too, for input the other is not booking while following the pause
    second.setPaused(true);
    check('nor does standing still in the window that paused', second.stallTimer === undefined,
        String(second.stallTimer));
    second.setPaused(false);
    first.dispose();
    second.dispose();
}

// resuming from a save state
{
    const { first, second, one, two, channelOne } = makePair();
    first.start();
    second.start();
    await settle();

    const snapshot = await first.snapshot();
    check('a snapshot covers both machines, named by player',
        new TextDecoder().decode(snapshot.p1) === 'own-state'
        && new TextDecoder().decode(snapshot.p2) === 'mirror-state',
        JSON.stringify(snapshot && Object.keys(snapshot)));

    const fromP2 = await second.snapshot();
    check('and the other window names them the same way round',
        new TextDecoder().decode(fromP2.p1) === 'mirror-state'
        && new TextDecoder().decode(fromP2.p2) === 'own-state');

    one.log.length = 0;
    two.log.length = 0;
    await first.resume(snapshot.p1, snapshot.p2);
    await settle();

    check('resuming restarts both windows',
        one.log.includes('own:reset') && two.log.includes('own:reset'),
        `${one.log.join(' ')} | ${two.log.join(' ')}`);
    check('and each window loads its own player into its own machine',
        one.log.includes('own:loadState=own-state')
        && two.log.includes('own:loadState=mirror-state'),
        two.log.join(' '));
    check('and the other player into its mirror',
        one.log.includes('mirror:loadState=mirror-state')
        && two.log.includes('mirror:loadState=own-state'));
    check('and books from frame zero again',
        one.sim.booked.has(0) && two.sim.booked.has(0));

    // a mask still in flight from before the resume names a frame number that now means a different moment
    two.mirrorSim.booked.clear();
    channelOne.send({ kind: 'input', seat: 1, epoch: 0, frame: 0, keys: 0xbeef });
    await settle();
    check('input from before the resume is ignored',
        !two.mirrorSim.booked.has(0), `booked ${two.mirrorSim.booked.get(0)}`);

    channelOne.send({ kind: 'input', seat: 1, epoch: 1, frame: 0, keys: 0x00c0 });
    await settle();
    check('and input from after it is taken',
        two.mirrorSim.booked.get(0) === 0x00c0, `booked ${two.mirrorSim.booked.get(0)}`);

    first.dispose();
    second.dispose();
}

// changing a machine from outside it: cheats and debugger pokes are not carried by the cable, so made in one window
// only they would desync the machines; the same write lands on the same frame in both windows
{
    const { first, second, one, two } = makePair();
    first.start();
    second.start();
    await settle();
    one.fireProgress(100);
    two.fireProgress(100);
    await settle();

    const codes = [{ address: 0x0500dead, value: 99, bytes: 1 }];
    check('a cheat switched on is taken while the session is running',
        first.scheduleEdits(1, [{ kind: 'cheats', codes }]) === true);
    await settle();

    const bookedHere = [...one.sim.edits.keys()];
    const bookedThere = [...two.mirrorSim.edits.keys()];
    check('it is booked on the machine it names, in this window',
        bookedHere.length === 1, `booked at ${bookedHere.join(',')}`);
    check('and on the other window\u2019s mirror of that machine',
        bookedThere.length === 1, `booked at ${bookedThere.join(',')}`);
    // a cheat landing on frame 103 here and 106 there makes machines disagree for three frames, enough for a digest
    check('on the same frame in both windows',
        bookedHere[0] === bookedThere[0], `${bookedHere[0]} vs ${bookedThere[0]}`);
    check('and on a frame neither machine has reached',
        bookedHere[0] > 100, `frame ${bookedHere[0]} against a machine at 100`);
    check('carrying the whole enabled list rather than the change to it',
        one.sim.edits.get(bookedHere[0])[0].codes[0].value === 99);

    // aimed at the other player's machine (this window's mirror, the other's own), so a debugger can poke either side
    one.sim.edits.clear();
    two.mirrorSim.edits.clear();
    first.scheduleEdits(2, [{ kind: 'memory', address: 0x05000000, bytes: [1, 2] }]);
    await settle();
    check('a write aimed at the other player goes to this window\u2019s mirror',
        one.mirrorSim.edits.size === 1 && one.sim.edits.size === 0,
        `own ${one.sim.edits.size}, mirror ${one.mirrorSim.edits.size}`);
    check('and to the other window\u2019s own machine',
        two.sim.edits.size === 1 && two.mirrorSim.edits.size === 0,
        `own ${two.sim.edits.size}, mirror ${two.mirrorSim.edits.size}`);
    check('on the same frame there too',
        [...one.mirrorSim.edits.keys()][0] === [...two.sim.edits.keys()][0]);

    first.dispose();
    second.dispose();
}

{
    // a refused booking names an already emulated frame, so the change happened elsewhere or not at all; saying so beats
    // an unexplained digest mismatch a second later
    const { first, second, two } = makePair();
    first.start();
    second.start();
    await settle();
    two.mirrorSim.refuseEdits = true;
    first.scheduleEdits(1, [{ kind: 'cheats', codes: [] }]);
    await settle();
    check('a change that arrives too late ends the session',
        second.state === LinkState.Closed && second.refusal?.reason === 'edit',
        `${second.state} / ${second.refusal?.reason}`);
    check('and says so in words a person can act on',
        (second.refusal?.message ?? '').length > 20, second.refusal?.message);
    first.dispose();
    second.dispose();
}

{
    // a cheat switched on before inviting the other player leaves a machine a fresh mirror is not a copy of, and the
    // session would end on the first frame the cheat touches
    const standing = [{ kind: 'cheats', codes: [{ address: 0x0500beef, value: 7, bytes: 2 }] }];
    const { first, second, one, two } = makePair({ standingEdits: () => standing });
    first.start();
    second.start();
    await settle();

    check('what a machine is already running under reaches the other window',
        two.mirrorSim.edits.get(0)?.[0]?.codes[0].value === 7,
        JSON.stringify([...two.mirrorSim.edits.keys()]));
    check('and the other way round',
        one.mirrorSim.edits.get(0)?.[0]?.codes[0].value === 7);
    check('at frame zero, before the first frame either machine runs',
        two.mirrorSim.edits.has(0) && one.mirrorSim.edits.has(0));
    // its own machine already has them, as a reset does not take a cheat off
    check('and is not booked again on the machine that already has them',
        one.sim.edits.size === 0 && two.sim.edits.size === 0,
        `${one.sim.edits.size} / ${two.sim.edits.size}`);

    // resuming clears bookings and restarts the frame count, so standing edits are settled again (a cheat switched on
    // moments before may have been booked against a frame only one window reached)
    const snapshot = await first.snapshot();
    await first.resume(snapshot.p1, snapshot.p2);
    await settle();
    check('and is said again after a save state is loaded',
        two.mirrorSim.edits.get(0)?.[0]?.codes[0].value === 7,
        JSON.stringify([...two.mirrorSim.edits.keys()]));

    first.dispose();
    second.dispose();
}

{
    // alone, the caller writes into its own machine directly
    const { first } = makePair();
    check('a change before the session connects is not taken',
        first.scheduleEdits(1, [{ kind: 'cheats', codes: [] }]) === false);
    first.dispose();
}

// leaving
{
    const { first, second, one } = makePair();
    first.start();
    second.start();
    await settle();
    second.dispose();
    await settle();
    check('a window that closes says so, and the other ends the session',
        first.state === LinkState.Closed && first.refusal?.reason === 'closed',
        `${first.state} / ${first.refusal?.reason}`);
    check('and the remaining window puts its machine back to running alone',
        one.log.includes('own:lockstep=false'), one.log.join(' '));
    first.dispose();
}

// a session that ended by itself leaves both windows the same
{
    const { first, second } = makePair();
    first.start();
    second.start();
    await settle();
    second.dispose('ended');
    await settle();
    check('the other window ends too, rather than waiting on this one',
        first.state === LinkState.Closed && first.refusal?.reason === 'ended',
        `${first.state} / ${first.refusal?.reason}`);
    first.dispose();
}

// a player pressing link calls the other window, once
{
    const { first, second, channelOne } = makePair({ calling: true });
    first.start();
    check('a session started by pressing link calls the other window',
        channelOne.sent.some(m => m.kind === 'call' && m.seat === 1));
    second.start();
    await settle();
    // player 2 unlinks; player 1's session waits for them to come back
    second.dispose('session');
    await settle();
    const calls = channelOne.sent.filter(m => m.kind === 'call').length;
    await new Promise(resolve => setTimeout(resolve, LinkSession.HELLO_INTERVAL_MS * 2 + 50));
    check('but not again once it has played: that would pull back a player who left',
        first.state === LinkState.Waiting
        && channelOne.sent.filter(m => m.kind === 'call').length === calls,
        `${first.state}, ${channelOne.sent.filter(m => m.kind === 'call').length - calls} more calls`);
    first.dispose();
}

// unlinking and linking again: a player who unlinks still has the game open, so the other window goes back to waiting
// rather than closing for good, and picks the session up again when they relink
{
    const { first, second, one, two, channelTwo } = makePair();
    first.start();
    second.start();
    await settle();
    check('the two windows are playing', first.connected && second.connected);

    second.dispose('session');
    await settle();
    check('the other window goes back to waiting, not to closed',
        first.state === LinkState.Waiting && first.refusal?.reason === 'left',
        `${first.state} / ${first.refusal?.reason}`);
    check('and lets its own machine run alone again',
        one.log.includes('own:lockstep=false'), one.log.join(' '));

    const rejoined = new LinkSession({
        session: two, channel: channelTwo, seat: 2,
        rom: 'abc123', core: 1876048, romData: () => new ArrayBuffer(1 << 20),
    });
    two.log.length = 0;
    one.log.length = 0;
    rejoined.start();
    await settle();
    check('they are playing again, with one press in one window',
        first.connected && rejoined.connected,
        `${first.state} / ${rejoined.state}`);
    // the "already answered a hello" flag has to go with the session, or the remaining window ignores the returning one
    check('the window that stayed answered the new hello',
        one.log.includes('mirror:cartRom=1048576'), one.log.join(' '));
    check('and both machines started over together',
        one.log.includes('own:reset') && two.log.includes('own:reset'));

    // frame numbers start at zero again, so a run inheriting the previous epoch would refuse every input the other sent
    first.setKeys(0x0020);
    one.fireProgress(4);
    await settle();
    check('and input crosses on the new run',
        [...two.mirrorSim.booked.values()].includes(0x0020),
        [...two.mirrorSim.booked.entries()].join(' '));

    first.dispose();
    rejoined.dispose();
}

// linking again before the last machines are back: they are handed back over several worker round trips while seat 2
// greets every half second, so a new run could book input into a mirror just disposed of ("No such simulation")
{
    const { first, second, one, two, channelTwo } = makePair();
    first.start();
    second.start();
    await settle();
    check('the two windows are playing', first.connected && second.connected);

    // unlinked and relinked at once, by a new session on the same emulator, so only the shared emulator session can keep
    // the run starting apart from the one still handing the machines back
    second.dispose('session');
    const rejoined = new LinkSession({
        session: two, channel: channelTwo, seat: 2,
        rom: 'abc123', core: 1876048, romData: () => new ArrayBuffer(1 << 20),
    });
    rejoined.start();
    await settle();

    check('the new run keeps the machine it built',
        two.mirror !== undefined && rejoined.mirrorSim !== undefined,
        `session mirror ${two.mirror ? 'attached' : 'gone'}, `
        + `run mirror ${rejoined.mirrorSim ? 'attached' : 'gone'}`);
    check('and both windows are playing rather than ended',
        first.connected && rejoined.connected,
        `${first.state} / ${rejoined.state}`);

    // proof that the kept machine is the one in use: the other window's input has to land in it
    first.setKeys(0x0020);
    one.fireProgress(2);
    await settle();
    check('and the other window\'s input reaches that mirror',
        [...two.mirrorSim.booked.values()].includes(0x0020),
        [...two.mirrorSim.booked.entries()].join(' '));

    first.dispose();
    rejoined.dispose();
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
