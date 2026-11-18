/**
 * Rehearses a whole update before tagging, with a release that does not exist yet. Updating needs a newer, signed
 * build on a published release, so this builds both halves here: two bundles from this tree (one a version higher),
 * a throwaway key pair that signs one and that the other trusts, and a local server in place of the GitHub release.
 * Nothing is stubbed (real bundle, real signature check, manifest by latest-json.mjs, the plugin's own in-place
 * install and restart); only where the release lives is faked, through the config patch.
 *
 *   yarn workspace vueport-desktop mock-update            # build both, serve, start the older one
 *   yarn workspace vueport-desktop mock-update --reset    # put the older copy back as it was built
 *   yarn workspace vueport-desktop mock-update --serve    # only the server
 *
 * Both halves are always built together, as rebuilding only the updated copy can make the update go backwards to an
 * older build, which looks like a change not taking effect. `yarn bundle` builds are unrelated (GitHub endpoint, real
 * key, https only). --reset and --serve build nothing and warn when the tree has moved on.
 *
 * Everything lives in .mock-update/ (git-ignored):
 *   keys/       the throwaway key pair; not the release key, and must never become it
 *   serve/      what the server offers: latest.json, the archive, its signature
 *   base/       the older build, pristine, to put back with --reset
 *   install/    the copy that actually gets replaced (standing in for /Applications)
 *   built.json  when that was built, which --reset and --serve compare the working tree against
 *
 * Faults to rehearse:
 *   --offline   the endpoint answers 503; the check fails and says so
 *   --corrupt   the archive does not match its signature; the install refuses
 *   --throttle  bytes per second, so the progress bar has time to show
 *
 * --notify-only builds the older copy as an unsigned release is built: it finds the update, but its button opens the
 * release page (served here as release.html) instead of installing.
 *
 * Only macOS is driven end to end; for Windows (NSIS installer) and Linux (AppImage) the two manual steps are printed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, copyFile, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(path.dirname(desktop));
const mock = path.join(desktop, '.mock-update');
const dirs = {
    keys: path.join(mock, 'keys'),
    serve: path.join(mock, 'serve'),
    base: path.join(mock, 'base'),
    install: path.join(mock, 'install'),
};

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 || at + 1 >= args.length ? fallback : args[at + 1];
};

if (flag('help')) {
    console.log(await readFile(new URL(import.meta.url), 'utf8')
        .then(source => source.slice(0, source.indexOf(' */') + 3)));
    process.exit(0);
}

const port = Number(value('port', 8787));
// loopback rather than `localhost`, as which address `localhost` resolves to first is up to the machine and
// the server listens on only one
const endpoint = `http://127.0.0.1:${port}/latest.json`;

const current = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;

const next = value('version', (() => {
    const parts = current.split('.');
    parts[2] = String(Number(parts[2] ?? 0) + 1);
    return parts.join('.');
})());

const notes = value('notes', 'Lorem ipsum dolor sit amet, consetetur sadipscing elitr, \
sed diam nonumy eirmod tempor invidunt ut labore et dolore magna aliquyam erat, sed diam voluptua. \
At vero eos et accusam et justo duo dolores et ea rebum. Stet clita kasd gubergren.');

// bytes per second the archive is handed over at; 0 is as fast as it goes
const throttle = Number(value('throttle', 4 * 1024 * 1024));

const BUNDLES = { darwin: 'app', win32: 'nsis', linux: 'appimage' };
const bundles = BUNDLES[process.platform];
if (!bundles) {
    console.error(`There is no updater bundle for ${process.platform}.`);
    process.exit(2);
}

function run(command, parameters, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, parameters, {
            cwd: desktop, stdio: 'inherit', shell: process.platform === 'win32', ...options,
        });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve()
            : reject(new Error(`${command} ${parameters.join(' ')} exited with ${code}`)));
    });
}

const exists = async target => await stat(target).then(() => true, () => false);

async function copyTree(from, to) {
    await rm(to, { recursive: true, force: true });
    await mkdir(path.dirname(to), { recursive: true });
    await (process.platform === 'darwin'
        ? run('ditto', [from, to], { stdio: 'inherit' })
        : run('cp', ['-a', from, to], { stdio: 'inherit' }));
}

// made once and kept, never the release key: the older build trusts exactly this key, so a bundle made here can
// only be updated from here. No password, as it never leaves `.mock-update/`
async function keys() {
    const secret = path.join(dirs.keys, 'mock.key');
    if (!await exists(secret)) {
        await mkdir(dirs.keys, { recursive: true });
        console.log('\n— A throwaway key pair, for updates that never leave this machine —');
        await run('npx', ['tauri', 'signer', 'generate', '--ci', '-f', '-p', '', '-w', secret]);
    }
    return {
        private: await readFile(secret, 'utf8'),
        public: (await readFile(`${secret}.pub`, 'utf8')).trim(),
    };
}

/**
 * Builds a bundle that calls itself `version`. Differences go in a config patch, never an edit, as the release
 * workflow and tests/updater-probe.mjs check tauri.conf.json against package.json. The page takes its version from
 * package.json, so it goes in the environment (VUEPORT_VERSION_OVERRIDE in packages/web/esbuild.mjs exists only for
 * this). Both builds use the mock endpoint and key, the newer one too, or after the update it would offer the real
 * latest release as a way out of the rehearsal.
 */
async function build({ version, signWith, pubkey, installs = true }) {
    const patch = {
        version,
        plugins: {
            updater: {
                endpoints: [endpoint],
                pubkey,
                // release builds refuse non-https endpoints, as the signature is all that guards an update; only ever a
                // patch, or a real build would take updates over plain HTTP
                dangerousInsecureTransportProtocol: true,
            },
        },
        bundle: { createUpdaterArtifacts: Boolean(signWith) },
    };
    const env = { ...process.env, VUEPORT_VERSION_OVERRIDE: version };
    // what bundle.mjs sets for a code-signed build; the rehearsal has no code signature but rehearses that build
    delete env.VUEPORT_SELF_UPDATE;
    if (installs) {
        env.VUEPORT_SELF_UPDATE = '1';
    }
    if (signWith) {
        env.TAURI_SIGNING_PRIVATE_KEY = signWith;
        env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
    }
    console.log(`\n— Building VUEPort ${version}${signWith ? ', signed' : ''} —`);
    // a file rather than JSON on the command line, which cmd strips the quotes out of on Windows (see bundle.mjs)
    const patchFile = path.join(mock, `config-${version}.json`);
    await mkdir(mock, { recursive: true });
    await writeFile(patchFile, JSON.stringify(patch));
    await run('npx', ['tauri', 'build', '--bundles', bundles, '-c',
        process.platform === 'win32' && patchFile.includes(' ') ? `"${patchFile}"` : patchFile], { env });
}

async function bundled() {
    const found = new Map();
    const walk = async current => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory() && !entry.name.endsWith('.app')) {
                await walk(full);
            } else {
                found.set(entry.name, full);
            }
        }
    };
    await walk(path.join(desktop, 'src-tauri', 'target', 'release', 'bundle'));
    return found;
}

// the archives an installed copy would download, and the signatures beside them
const UPDATE_ARCHIVE = /\.(app\.tar\.gz|AppImage|AppImage\.tar\.gz|nsis\.zip|msi\.zip)$/;

// serves the newer build's archives with a manifest from latest-json.mjs, the release workflow's own, so its
// discovery, signature refusal and platform choice are exercised before a tag
async function publish(version) {
    await rm(dirs.serve, { recursive: true, force: true });
    await mkdir(dirs.serve, { recursive: true });

    const files = await bundled();
    const archives = [...files.keys()].filter(name => UPDATE_ARCHIVE.test(name));
    if (archives.length === 0) {
        throw new Error('The build produced no update archive. Was the signing key passed?');
    }
    for (const name of archives) {
        await copyFile(files.get(name), path.join(dirs.serve, name));
        if (files.has(`${name}.sig`)) {
            await copyFile(files.get(`${name}.sig`), path.join(dirs.serve, `${name}.sig`));
        }
    }

    const notesFile = path.join(mock, 'notes.md');
    await writeFile(notesFile, `${notes}\n`);
    // where a copy that does not install sends people, standing in for the release's GitHub page
    await writeFile(path.join(dirs.serve, 'release.html'),
        `<!doctype html><meta charset="utf-8"><title>VUEPort ${version}</title>`
        + `<p>The release page of VUEPort ${version} would be here.</p>\n`);

    console.log('\n— The manifest, written by the release workflow\'s own script —');
    await run(process.execPath, [
        path.join(desktop, 'scripts', 'latest-json.mjs'),
        '--artifacts', dirs.serve,
        '--version', version,
        '--base-url', `http://127.0.0.1:${port}`,
        '--page', `http://127.0.0.1:${port}/release.html`,
        '--notes', notesFile,
        '--out', path.join(dirs.serve, 'latest.json'),
        // which Mac this is, stated: the macOS update archive is `VUEPort.app.tar.gz` everywhere, and a release reads
        // the architecture off the .dmg, which this does not build (a minute of nothing for a rehearsal)
        ...process.platform === 'darwin'
            ? ['--mac-arch', process.arch === 'arm64' ? 'aarch64' : 'x86_64'] : [],
    ]);
}

function installed() {
    return process.platform === 'darwin'
        ? path.join(dirs.install, 'VUEPort.app')
        : path.join(dirs.install, path.basename(String(installedSource)));
}
let installedSource;

// two copies of the older build: install/ is really replaced in place (inside target/ that would silently change
// cargo's output), base/ stays untouched so --reset reruns without building
async function stage() {
    const files = await bundled();
    const name = process.platform === 'darwin' ? 'VUEPort.app'
        : [...files.keys()].find(candidate => /-setup\.exe$|\.AppImage$/.test(candidate));
    if (!name) {
        throw new Error('The build produced nothing to install.');
    }
    installedSource = name;
    await copyTree(files.get(name), path.join(dirs.base, name));
    await writeFile(path.join(mock, 'built.json'),
        `${JSON.stringify({ built: new Date().toISOString(), version: current, offers: next }, undefined, 2)}\n`);
    await reset();
}

async function bundleVersion(app) {
    try {
        const plist = await readFile(path.join(app, 'Contents', 'Info.plist'), 'utf8');
        return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    } catch {
        return undefined;
    }
}

async function builtAt() {
    try {
        return Date.parse(JSON.parse(await readFile(path.join(mock, 'built.json'), 'utf8')).built);
    } catch {
        return undefined;
    }
}

// newest change under the sources a rehearsal build is made of (not build output, incl. packages/web/dist: a
// rebuilt web bundle that never reached a rehearsal build is the case to catch)
async function newestSource() {
    let newest = 0;
    const walk = async current => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else {
                newest = Math.max(newest, (await stat(full)).mtimeMs);
            }
        }
    };
    for (const dir of [
        path.join(root, 'packages', 'web', 'src'),
        path.join(root, 'packages', 'core', 'src'),
        path.join(desktop, 'src-tauri', 'src'),
    ]) {
        if (await exists(dir)) {
            await walk(dir);
        }
    }
    return newest;
}

// warns when what is about to be served is older than the working tree, as --reset, --serve and `yarn bundle` build
// nothing here. Compares times, not contents, so a touched file warns too
async function warnIfStale() {
    // install/ may already hold the release: once the button is pressed the app replaces itself, so a rehearsal
    // starting from there has already run
    const onDisk = await bundleVersion(installed());
    if (onDisk && onDisk !== current) {
        console.log(`\nWhat is in install/ calls itself ${onDisk}, not ${current}:`
            + ' the copy there has already installed the update it was offered.'
            + '\n--reset puts the older one back, which is what there is to update.');
    }

    const built = await builtAt();
    const newest = await newestSource();
    if (built === undefined || newest <= built) {
        return;
    }
    const minutes = Math.round((newest - built) / 60000);
    console.log(`\nThis is the build from ${new Date(built).toLocaleString()}, and something under`
        + ` packages/*/src has changed since — ${minutes < 1 ? 'just now' : `${minutes} minute(s) later`}.`
        + '\nIt is not in what is about to run. Running this with no flag at all builds both'
        + '\nhalves again out of the working tree, which is the only way it gets in.');
}

async function reset() {
    const [name] = await readdir(dirs.base);
    if (!name) {
        throw new Error('Nothing has been built yet, so there is nothing to put back.'
            + ' Run this without --reset first.');
    }
    installedSource = name;
    await copyTree(path.join(dirs.base, name), path.join(dirs.install, name));
    console.log(`\nPut VUEPort ${current} back at ${path.join(dirs.install, name)}`);
}

// the release served from this machine, printing every request so the start-up check and the download are
// visible as they happen
function serve() {
    const server = createServer(async (request, response) => {
        const name = decodeURIComponent(request.url.split('?')[0].replace(/^\//, ''));
        const file = path.join(dirs.serve, name);

        // unreachable endpoint, the ordinary failure (a laptop on a train, GitHub down): the silent check at start must
        // swallow it, a pressed button must report it
        if (flag('offline')) {
            console.log(`  ${request.method} /${name} → 503 (--offline)`);
            response.writeHead(503).end('Nope.');
            return;
        }

        if (!file.startsWith(dirs.serve) || !await exists(file)) {
            console.log(`  ${request.method} /${name} → 404`);
            response.writeHead(404).end('Not here.');
            return;
        }

        const { size } = await stat(file);
        console.log(`  ${request.method} /${name} → 200, ${size} bytes`);
        response.writeHead(200, {
            'content-length': size,
            'content-type': name.endsWith('.json') ? 'application/json'
                : name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream',
        });

        const stream = createReadStream(file, throttle > 0 ? { highWaterMark: 64 * 1024 } : {});
        for await (let chunk of stream) {
            // one byte in the middle: enough to break the signature, not enough to fail before the verifier refuses it
            if (flag('corrupt') && !name.endsWith('.json')) {
                chunk = Buffer.from(chunk);
                chunk[chunk.length >> 1] ^= 0xff;
            }
            if (!response.write(chunk)) {
                await new Promise(resolve => response.once('drain', resolve));
            }
            // at a speed the user can watch; over loopback the download is otherwise done before the window shows it
            // started
            if (throttle > 0) {
                await new Promise(resolve => setTimeout(resolve, chunk.length / throttle * 1000));
            }
        }
        response.end();
    });

    // the one failure that is not a mistake: a detached server from the last run is still up, so say it plainly
    // rather than with an errno stack trace
    server.on('error', error => {
        if (error.code === 'EADDRINUSE') {
            const ways = [
                ['pkill -f mock-update.mjs', 'stops it'],
                [`lsof -nP -iTCP:${port} -sTCP:LISTEN`, 'says what it is, first'],
                [`--port ${port + 1}`, 'leaves it alone and serves elsewhere'],
            ];
            const column = Math.max(...ways.map(([way]) => way.length)) + 4;
            console.error(`\nSomething is already serving on ${port} — almost certainly the`
                + ' server from an earlier run, which keeps going until it is stopped.\n\n'
                + ways.map(([way, what]) => `  ${way.padEnd(column)}${what}`).join('\n')
                + '\n\nWhat has been built is kept either way, so starting again costs'
                + ' nothing: --serve picks it up where it is.');
            process.exit(2);
        }
        throw error;
    });

    return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
        console.log(`\nServing ${dirs.serve} at http://127.0.0.1:${port}`);
        console.log(`  the manifest is ${endpoint}`);
        if (flag('offline')) {
            console.log('  --offline: every request is answered 503.');
        }
        if (flag('corrupt')) {
            console.log('  --corrupt: the archive will not match its signature.');
        }
        if (throttle > 0) {
            console.log(`  handing bytes over at ${(throttle / 1024 / 1024).toFixed(1)} MB/s`
                + ' — --throttle 0 for as fast as it goes.');
        }
        resolve(server);
    }));
}

// starts the copy about to be offered an update, as a child with output on this terminal, as the shell reports
// update errors on stderr
async function launch() {
    const app = installed();
    if (process.platform !== 'darwin') {
        console.log(`\nStart it yourself: ${app}`);
        console.log(process.platform === 'win32'
            ? '  Run the installer first — a Windows update replaces what the installer'
            + ' installed, so it has to have been installed.'
            : '  Make it executable if it is not, and run it.');
        return;
    }
    console.log(`\n— Starting VUEPort ${current} —`);
    // the binary is named after the crate (`vueport-desktop`), not the app; read rather than written down, as it is
    // the bundler's name to change
    const [binary] = await readdir(path.join(app, 'Contents', 'MacOS'));
    spawn(path.join(app, 'Contents', 'MacOS', binary), [], { stdio: 'inherit' })
        .on('error', error => console.error(String(error)));
}

function instructions() {
    console.log(`
VUEPort ${current} is running and ${next} is being offered to it.

  • A toast should already be saying so, and the title bar should be wearing
    a pill. That is the look taken at start, which is on by default.
  • About → it says what is new, and offers to install it.
  • The command palette's "Check for updates" is the same answer by another way.
  • Installing ends with the window going away and coming back as ${next},
    with whatever was playing having been asked to write its saves first.

Ctrl-C here stops the server. Then:

  yarn workspace vueport-desktop mock-update            after changing anything
  yarn workspace vueport-desktop mock-update --reset    to do it again, as built
  yarn workspace vueport-desktop mock-update --serve    to serve without building

Both halves are built from this working tree, so installing ${next} lands on the
same code this ${current} is — which is the point. \`yarn bundle\` is no part of
it: what that builds asks GitHub about its updates and refuses an endpoint that
is not https, so a change built that way never shows up here.

What is left in src-tauri/target/release/bundle is a rehearsal build: it looks
for its updates on this machine and accepts them over plain HTTP. Run
\`yarn bundle\` before doing anything with what is in there.
`);
}

const staged = await exists(path.join(dirs.serve, 'latest.json'));

if ((flag('serve') || flag('reset')) && !staged) {
    console.error('Nothing has been built yet, so there is nothing to serve or put back.'
        + ' Run this with no flag first.');
    process.exit(2);
}

if (flag('serve') || flag('reset')) {
    if (flag('reset')) {
        await reset();
    } else {
        const [name] = await readdir(dirs.base).catch(() => []);
        installedSource = name;
    }
    await warnIfStale();
} else {
    const pair = await keys();
    // the newer one first: both builds write the same file names into the same bundle directory, so the one to keep
    // is copied out before the other lands on top
    await build({ version: next, signWith: pair.private, pubkey: pair.public });
    await publish(next);
    await build({ version: current, pubkey: pair.public, installs: !flag('notify-only') });
    await stage();
}

const server = await serve();

if (!flag('no-launch')) {
    await launch();
    instructions();
}

process.on('SIGINT', () => {
    server.close();
    console.log('\nServer stopped. The application, if it is still up, keeps running.');
    process.exit(0);
});
