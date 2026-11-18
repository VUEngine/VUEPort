/**
 * Bundles the desktop app, signed if the environment has anything to sign with, and says plainly which happened. An
 * unsigned local build is not an error.
 *
 * macOS: Tauri reads APPLE_SIGNING_IDENTITY itself and signs with whatever keychain the machine searches; it notarizes
 * when APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID are all set. pkg.mjs then wraps the same .app in an installer,
 * signed with APPLE_INSTALLER_SIGNING_IDENTITY. Working images (rw.<pid>.VUEPort_….dmg) an aborted run left mounted
 * are detached and deleted first, as bundle_dmg.sh fails every later run while one is still mounted.
 *
 * Windows: since CA/Browser Forum ballot CSC-13 every code signing key lives on hardware or in a cloud HSM, so there
 * is no .pfx and signtool cannot reach the key alone. VUEPort's Certum SimplySign key stays in Certum's cloud and is
 * reached by `ssign`, set as Tauri's signCommand (run once per file). The thumbprint path is for a key in the Windows
 * store: a hardware token, or SimplySign Desktop mapping the cloud key in as a virtual smart card. Both are patched in
 * rather than set in tauri.conf.json, where they would fail every unsigned local build.
 *
 * Updates are signed with VUEPort's own key pair; without the private key no updater artifacts are made (see
 * src-tauri/src/update.rs and the README). A build installs updates itself only when it also carries this platform's
 * code signature (VUEPORT_SELF_UPDATE, read at compile time); any other build checks for a newer release and only
 * sends people to the release page. Linux has no code signature, so the key alone decides there. The macOS update archive is renamed after its architecture
 * (VUEPort_1.0.0_aarch64.app.tar.gz), as the bundler calls it VUEPort.app.tar.gz on either Mac and the release holds
 * both.
 *
 * VUEPORT_TARGET builds for another Rust target triple, such as x86_64-apple-darwin on an Apple Silicon Mac; see
 * bundle-dir.mjs for where that lands. --devtools (or VUEPORT_DEVTOOLS=1) builds a diagnostic bundle that opens the
 * webview inspector on start, for faults that only appear once packaged; it keeps the source maps a release leaves
 * out.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDir, target, tauri as tauriDir } from './bundle-dir.mjs';

// empty signing variables removed: GitHub Actions turns a missing secret into an empty variable, Tauri only checks
// whether it is set, and an empty APPLE_CERTIFICATE decodes to a .p12 that `security import` rejects
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== ''
    || ![
        'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY',
        'APPLE_INSTALLER_SIGNING_IDENTITY',
        'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID',
        'WINDOWS_CERTIFICATE_THUMBPRINT',
        'CERTUM_EMAIL', 'CERTUM_OTP', 'CERTUM_TOKEN',
        'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    ].includes(name)));
// decided below and nowhere else, so one left in a shell cannot make an unsigned build install updates
delete env.VUEPORT_SELF_UPDATE;

const windows = process.platform === 'win32';

const identity = env.APPLE_SIGNING_IDENTITY;
const thumbprint = env.WINDOWS_CERTIFICATE_THUMBPRINT;
const notarization = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'].filter(name => env[name]);

// a Certum cloud account: an address, plus the TOTP seed or a code read off an authenticator. ssign reads them itself;
// here they only decide whether to sign
const certum = Boolean(env.CERTUM_EMAIL && (env.CERTUM_OTP || env.CERTUM_TOKEN));

// argument or environment, as `yarn workspace … bundle --devtools` and `npm … -- --devtools` do not agree on
// how an argument reaches a script
const devtools = process.argv.slice(2).includes('--devtools') || env.VUEPORT_DEVTOOLS === '1';

const args = ['build'];

/**
 * Config patches go to Tauri as files rather than JSON on the command line: on Windows `tauri` is a .cmd started
 * through cmd, which strips the quotes out of `{"bundle":…}` and Tauri refuses what is left. A path survives, quoted
 * when it has a space. Kept in target/, which is git-ignored and rewritten every build.
 */
const patches = path.join(tauriDir, 'target', 'bundle-config');
function configPatch(patch) {
    mkdirSync(patches, { recursive: true });
    const file = path.join(patches, `${args.filter(arg => arg === '--config').length}.json`);
    writeFileSync(file, JSON.stringify(patch));
    return windows && file.includes(' ') ? `"${file}"` : file;
}

if (target) {
    args.push('--target', target);
    console.log(`Target: ${target}.`);
}

if (devtools) {
    args.push('--features', 'devtools');
    // the inspector reads the source maps a release leaves out (tauri.conf.json: build --no-sourcemaps)
    args.push('--config', configPatch({ build: { beforeBuildCommand: 'yarn workspace vueport-web build' } }));
}

// updater archives and their signatures, asked for here rather than in tauri.conf.json, as asking for them
// without a key fails the build
if (env.TAURI_SIGNING_PRIVATE_KEY) {
    args.push('--config', configPatch({ bundle: { createUpdaterArtifacts: true } }));
    console.log('Updates: this build makes signed updater artifacts.');
} else {
    console.log('Updates: none. This build makes no updater artifacts;'
        + ' set TAURI_SIGNING_PRIVATE_KEY to make ones an installed VUEPort will accept.');
}

if (windows) {
    if (certum && thumbprint) {
        // both would work, and the branch order alone would decide which key signed the release
        console.log('Signing: a Certum account *and* a certificate thumbprint are set.'
            + ' Using the Certum account; unset CERTUM_EMAIL to sign through the'
            + ' Windows certificate store instead.');
    }

    if (certum) {
        // object notation, as Tauri splits a string command on spaces and these paths have them
        // ("VUEPort_1.0.0_x64-setup")
        args.push('--config', configPatch({
            bundle: { windows: { signCommand: { cmd: 'ssign', args: ['%1'] } } },
        }));
        console.log(`Signing: Certum SimplySign as ${env.CERTUM_EMAIL}.`);
    } else if (thumbprint) {
        args.push('--config', configPatch({
            bundle: { windows: { certificateThumbprint: thumbprint } },
        }));
        console.log('Signing: Windows certificate ' + thumbprint.slice(0, 8) + '…');
    } else {
        console.log('Signing: none. Set CERTUM_EMAIL and CERTUM_OTP to sign this build'
            + ' with the Certum cloud key, or WINDOWS_CERTIFICATE_THUMBPRINT to sign'
            + ' with a key the Windows certificate store can already reach.');
    }
} else if (process.platform === 'darwin') {
    if (identity) {
        console.log(`Signing: macOS identity ${identity}`);
        if (notarization.length === 3) {
            console.log('Notarizing: yes.');
        } else {
            // a signed but un-notarized build is still refused by Gatekeeper
            console.log(
                'Notarizing: no — APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID are not all set,'
                + ' so this build will still be refused on another machine.'
            );
        }
    } else {
        console.log('Signing: none. Set APPLE_SIGNING_IDENTITY to sign this build.');
    }
} else {
    console.log('Signing: none configured for this platform.');
}

// unsigned on macOS (Gatekeeper) or Windows (SmartScreen), an installed update would greet people with the same
// warnings as the first download, so such a build only points at the release page
const codeSigned = windows ? certum || Boolean(thumbprint)
    : process.platform === 'darwin' ? Boolean(identity) && notarization.length === 3
        : true;
if (env.TAURI_SIGNING_PRIVATE_KEY && codeSigned) {
    env.VUEPORT_SELF_UPDATE = '1';
    console.log('Installing updates: yes. This build downloads and installs newer releases itself.');
} else {
    console.log('Installing updates: no. This build checks for newer releases and opens the release page;'
        + (codeSigned ? ' it has no update key.' : ' it is not code signed.'));
}

console.log(devtools
    ? 'Inspector: YES — this is a diagnostic build. It opens the webview'
        + ' inspector on start and must not be released.'
    : 'Inspector: none. Add --devtools to build one that has it.');

// names the macOS update archive and its signature after the architecture as Tauri names the .dmg, since the bundler
// calls it VUEPort.app.tar.gz on either Mac and the release holds both; latest-json.mjs reads the name back
async function nameUpdateArchive() {
    const { productName, version } = JSON.parse(await readFile(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
    const archive = path.join(bundleDir, 'macos', `${productName}.app.tar.gz`);
    if (!existsSync(archive)) {
        return;
    }
    const triple = target ?? (process.arch === 'arm64' ? 'aarch64' : 'x86_64');
    const arch = triple.startsWith('aarch64') ? 'aarch64' : 'x64';
    const named = path.join(bundleDir, 'macos', `${productName}_${version}_${arch}.app.tar.gz`);
    await rename(archive, named);
    if (existsSync(`${archive}.sig`)) {
        await rename(`${archive}.sig`, `${named}.sig`);
    }
    console.log(`Update archive: ${path.relative(process.cwd(), named)}`);
}

// detaches and deletes the working images (rw.<pid>.<name>.dmg) an aborted run leaves mounted, on which bundle_dmg.sh
// fails every later run; only this build's own bundle directory is looked at
async function clearStaleDmgs() {
    const dir = path.join(bundleDir, 'macos');
    const stale = name => /^rw\.\d+\..*\.dmg$/.test(name);
    const info = spawnSync('sh', ['-c', 'hdiutil info -plist | plutil -convert json -o - -'], { encoding: 'utf8' });
    for (const image of info.status === 0 ? JSON.parse(info.stdout).images ?? [] : []) {
        const file = image['image-path'];
        if (!file || path.dirname(file) !== dir || !stale(path.basename(file))) {
            continue;
        }
        const disk = image['system-entities']?.map(entity => entity['dev-entry']?.match(/^\/dev\/disk\d+/)?.[0])
            .find(Boolean);
        if (disk) {
            console.log(`Detaching ${disk}, left mounted by an aborted run: ${path.basename(file)}`);
            if (spawnSync('hdiutil', ['detach', disk], { stdio: 'ignore' }).status !== 0) {
                spawnSync('hdiutil', ['detach', '-force', disk], { stdio: 'inherit' });
            }
        }
    }
    for (const name of existsSync(dir) ? (await readdir(dir)).filter(stale) : []) {
        await rm(path.join(dir, name), { force: true });
    }
}

if (process.platform === 'darwin') {
    await clearStaleDmgs();
}

// a shell only on Windows, where `tauri` is a .cmd that needs one (and why the config patches are files)
const tauri = spawn('tauri', args, { stdio: 'inherit', shell: windows, env });
tauri.on('exit', async code => {
    if (code !== 0 || process.platform !== 'darwin') {
        process.exit(code ?? 1);
    }
    await nameUpdateArchive();
    const pkg = spawn(process.execPath, [fileURLToPath(new URL('./pkg.mjs', import.meta.url))],
        { stdio: 'inherit', env });
    pkg.on('exit', status => process.exit(status ?? 1));
});
