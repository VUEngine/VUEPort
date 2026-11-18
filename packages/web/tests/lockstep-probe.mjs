/**
 * Frame-scheduled input and the lockstep gate, the worker half of mirror-lockstep: `queueKeys` books a mask against its
 * frame, `setLockstep` stops a sim running past its input, `stateDigest` tells machines apart cheaply. Driven through
 * the audio port rather than a real worklet, as the worker emulates exactly one frame per buffer handed back, so the
 * probe decides how far each machine gets.
 *
 * Usage: node tests/lockstep-probe.mjs (after `yarn build`)
 */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
    if (!ok) {
        failures++;
    }
};

if (!existsSync(path.join(dist, 'index.html'))) {
    console.log('\nskipped: dist is not built\n');
    process.exit(0);
}

// a production build stamps a content hash into the worker and wasm names, so they are looked up rather than assumed
async function built(stem, extension) {
    const pattern = new RegExp(`^${stem}(-[A-Za-z0-9_-]+)?\\.${extension}$`);
    const match = (await readdir(dist)).find(file => pattern.test(file));
    if (!match) {
        console.log(`\nskipped: no ${stem}.${extension} in dist\n`);
        process.exit(0);
    }
    return match;
}

const WORKER_FILE = await built('vb-worker', 'js');
const WASM_FILE = await built('core', 'wasm');

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
    '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
};
const server = createServer(async (request, response) => {
    const url = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    try {
        const body = await readFile(path.join(dist, url));
        response.writeHead(200, {
            'content-type': TYPES[path.extname(url)] ?? 'application/octet-stream',
        });
        response.end(body);
    } catch {
        response.writeHead(404).end();
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let puppeteer;
try {
    puppeteer = (await import(require.resolve('puppeteer', { paths: [__dirname, process.cwd()] }))).default;
} catch {
    console.log('\nThis probe drives a real browser and needs puppeteer.\n');
    server.close();
    process.exit(1);
}

const IN_PAGE = async (origin, workerFile, wasmFile) => {
    const SGN = 0x0002;
    const A = 0x0004;
    const B = 0x0008;

    const makeRom = () => {
        const rom = new Uint8Array(1 << 20);
        for (let i = 0; i < rom.length; i++) {
            rom[i] = (i * 7) & 0xff;
        }
        return rom;
    };

    async function machine() {
        const worker = new Worker(`${origin}/${workerFile}`);
        const events = [];
        const pending = new Map();
        let nextId = 1;
        let booted;
        const ready = new Promise(resolve => { booted = resolve; });

        worker.onmessage = event => {
            const message = event.data;
            if (message.event !== undefined) {
                events.push(message);
                return;
            }
            if (message.id === 0) {
                booted();
                return;
            }
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            if (!waiter) {
                return;
            }
            if (message.error !== undefined) {
                waiter.reject(new Error(message.error));
            } else {
                waiter.resolve(message.result);
            }
        };

        const request = (command, params = {}, transfer = []) => new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            worker.postMessage({ id, command, params }, transfer);
        });

        // stand-in for the audio worklet: nothing runs until a buffer is handed back, so this is the probe's throttle
        const channel = new MessageChannel();
        const returned = [];
        let arrived;
        channel.port2.onmessage = event => {
            if (event.data && event.data.flush) {
                return;
            }
            returned.push(event.data);
            arrived?.();
        };
        worker.postMessage({ audioPort: channel.port1 }, [channel.port1]);
        await ready;

        await request('init', { wasmUrl: `${origin}/${wasmFile}` });
        const sim = await request('createSim');
        const rom = makeRom();
        await request('setCartRom', { sim, rom: rom.buffer }, [rom.buffer]);
        const ram = new Uint8Array(16384);
        await request('setCartRam', { sim, ram: ram.buffer }, [ram.buffer]);
        await request('setKeys', { sim, keys: SGN });

        return {
            sim, request, events,
            async pump(count) {
                for (let i = 0; i < count; i++) {
                    const buffer = returned.shift()
                        ?? await new Promise(resolve => {
                            arrived = () => { arrived = undefined; resolve(returned.shift()); };
                        });
                    channel.port2.postMessage([buffer], [buffer]);
                }
            },
            async frame() {
                return (await request('stateDigest', { sim })).frame;
            },
            async digest() {
                return request('stateDigest', { sim });
            },
            waitingEvents() {
                return events.filter(e => e.event === 'awaitingInput').map(e => e.payload);
            },
            dispose() {
                worker.terminate();
            },
        };
    }

    const results = [];
    const check = (label, ok, detail = '') => results.push({ label, ok, detail });

    {
        const m = await machine();
        await m.request('setLockstep', { sim: m.sim, enabled: true });
        for (let frame = 0; frame < 5; frame++) {
            await m.request('queueKeys', { sim: m.sim, frame, keys: SGN });
        }
        await m.request('run');
        await m.pump(20);

        const stopped = await m.frame();
        check('a lockstep machine stops at the end of its booked input',
            stopped === 5, `stopped at frame ${stopped}, expected 5`);

        const waits = m.waitingEvents();
        check('and says it is waiting, once',
            waits.length === 1 && waits[0].waiting === true && waits[0].frame === 5,
            JSON.stringify(waits));
        check('naming the simulation it is waiting for',
            waits.length === 1 && waits[0].sims.length === 1 && waits[0].sims[0] === m.sim,
            JSON.stringify(waits.map(w => w.sims)));

        for (let frame = 5; frame < 9; frame++) {
            await m.request('queueKeys', { sim: m.sim, frame, keys: SGN });
        }
        await m.pump(20);
        const resumed = await m.frame();
        check('booking more input lets it carry on',
            resumed === 9, `reached frame ${resumed}, expected 9`);
        const after = m.waitingEvents();
        check('and it says so on the way past',
            after.length === 3 && after[1].waiting === false && after[2].waiting === true,
            JSON.stringify(after.map(w => `${w.waiting}@${w.frame}`)));

        let refused = false;
        try {
            await m.request('queueKeys', { sim: m.sim, frame: 0, keys: SGN });
        } catch {
            refused = true;
        }
        check('input for a frame already emulated is refused', refused);

        // an unscheduled mask is refused and journaled; a press in flight when a session started would otherwise land
        // on one window's machine and not the other's
        await m.request('setKeys', { sim: m.sim, keys: SGN | 0x1000 });
        const journal = await m.request('linkJournal', { sim: m.sim });
        check('an unscheduled mask does not reach a machine under lockstep',
            journal.some(entry => entry.kind === 'refusedKeys' && entry.keys === (SGN | 0x1000)),
            JSON.stringify(journal.slice(-3)));
        check('and the journal holds what the machine was given',
            journal.some(entry => entry.kind === 'keys' && entry.frame === 0 && entry.keys === SGN),
            JSON.stringify(journal.slice(0, 3)));

        m.dispose();
    }

    // a linked pair ignores breakpoints rather than splitting a frame
    {
        // `br 0` on the reset vector, so the breakpoint there is hit over and over before the start grace runs out
        const loopRom = () => {
            const rom = new Uint8Array(1 << 20);
            rom[rom.length - 16] = 0x00;
            rom[rom.length - 15] = 0x8a;
            return rom;
        };
        const m = await machine();
        {
            const rom = loopRom();
            await m.request('setCartRom', { sim: m.sim, rom: rom.buffer }, [rom.buffer]);
        }
        const stops = () => m.events.filter(e => e.event === 'stopped').length;
        // a stopped machine sends no more buffers, so a pump that runs into a stop would wait forever
        const pumpUntilStopped = count => Promise.race([
            m.pump(count), new Promise(resolve => setTimeout(resolve, 1500)),
        ]);
        // the reset vector, the first instruction a machine runs
        await m.request('setBreakpoints', { sim: m.sim, addresses: [0xfffffff0] });
        await m.request('reset', { sim: m.sim });
        await m.request('run');
        await pumpUntilStopped(2);
        const alone = stops();
        check('alone, a breakpoint on the reset vector stops the machine', alone === 1, `${alone} stops`);

        const peer = await m.request('createSim');
        const peerRom = loopRom();
        await m.request('setCartRom', { sim: peer, rom: peerRom.buffer }, [peerRom.buffer]);
        await m.request('setPeer', { sim: m.sim, peer, order: 1 });
        await m.request('reset', { sim: m.sim });
        await m.request('reset', { sim: peer });
        await m.request('run');
        await m.pump(10);
        check('linked, the same breakpoint does not stop the pair',
            stops() === alone && await m.frame() >= 10,
            `frame ${await m.frame()}, ${stops() - alone} new stops`);
        let stepRefused = '';
        try {
            await m.request('runTo', { sim: m.sim, address: 0xfffffff0 });
        } catch (error) {
            stepRefused = error.message;
        }
        check('and stepping is refused, saying why', /linked/.test(stepRefused), stepRefused);

        await m.request('setPeer', { sim: m.sim, peer: 0 });
        await pumpUntilStopped(4);
        // the stop is reported after the buffer it happened in; a round trip makes sure it has arrived
        const regs = await m.request('readRegisters', { sim: m.sim });
        check('unlinked, the breakpoint stops the machine again', stops() === alone + 1,
            `${stops() - alone} new stops, pc ${regs.pc.toString(16)}`);

        m.dispose();
    }

    {
        const m = await machine();
        await m.request('run');
        await m.pump(12);
        const ran = await m.frame();
        check('a machine without lockstep runs on regardless',
            ran >= 10, `only reached frame ${ran}`);
        check('and never claims to be waiting', m.waitingEvents().length === 0);
        m.dispose();
    }

    {
        const book = async (m, presses) => {
            await m.request('setLockstep', { sim: m.sim, enabled: true });
            for (let frame = 0; frame < 40; frame++) {
                await m.request('queueKeys', { sim: m.sim, frame, keys: SGN | (presses[frame] ?? 0) });
            }
            await m.request('run');
            await m.pump(60);
        };

        const same = [{}, {}];
        const one = await machine();
        const two = await machine();
        const presses = {};
        for (let frame = 0; frame < 40; frame++) {
            presses[frame] = frame % 7 === 0 ? A : frame % 5 === 0 ? B : 0;
        }
        await book(one, presses);
        await book(two, presses);
        same[0] = await one.digest();
        same[1] = await two.digest();

        check('two machines given the same booked input reach the same frame',
            same[0].frame === 40 && same[1].frame === 40,
            `${same[0].frame} vs ${same[1].frame}`);
        check('and the same digest',
            same[0].digest === same[1].digest,
            `0x${same[0].digest.toString(16)} vs 0x${same[1].digest.toString(16)}`);

        // this cartridge never reads the controller, so a different press changes nothing; the digest noticing parted
        // memory is checked directly instead
        const poke = async (m, address) => {
            const data = new Uint8Array([0x5a]);
            await m.request('writeMemory', { sim: m.sim, address, data: data.buffer }, [data.buffer]);
            return (await m.digest()).digest;
        };

        const wram = await poke(two, 0x05001234);
        check('a byte changed in WRAM changes the digest',
            wram !== same[1].digest, `both 0x${wram.toString(16)}`);

        const cart = await poke(two, 0x06000010);
        check('a byte changed in cartridge RAM changes the digest',
            cart !== wram, `both 0x${cart.toString(16)}`);

        const vram = await poke(two, 0x00000400);
        check('a byte changed in VRAM changes the digest',
            vram !== cart, `both 0x${vram.toString(16)}`);

        check('the untouched machine still reads the same',
            (await one.digest()).digest === same[0].digest);

        one.dispose();
        two.dispose();
    }

    return results;
};

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-audio-output'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });

console.log('\nFrame-scheduled input and the lockstep gate\n');
try {
    const results = await page.evaluate(IN_PAGE, origin, WORKER_FILE, WASM_FILE);
    for (const { label, ok, detail } of results) {
        check(label, ok, detail);
    }
} catch (error) {
    check('the probe ran', false, String(error));
}
check('nothing errored on the page', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
