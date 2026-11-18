// checks the latest.json an installed VUEPort reads to find its successor; a wrong one only shows as copies quietly not
// updating
// usage: node tests/latest-json-probe.mjs
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/latest-json.mjs', import.meta.url));
const BASE = 'https://github.com/VUEngine/VUEPort/releases/download/v1.1.0';

let failures = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
    if (!ok) {
        failures++;
    }
};

async function artifacts(files) {
    const root = await mkdtemp(path.join(tmpdir(), 'vueport-release-'));
    for (const [name, contents] of Object.entries(files)) {
        const full = path.join(root, name);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, contents);
    }
    return root;
}

async function build(files, extra = [], version = '1.1.0') {
    const root = await artifacts(files);
    const out = path.join(root, 'latest.json');
    try {
        const { stdout } = await run('node', [script,
            '--artifacts', root, '--version', version, '--base-url', BASE, '--out', out, ...extra]);
        return { manifest: JSON.parse(await readFile(out, 'utf8')), stdout };
    } catch (error) {
        return { error: `${error.stderr ?? ''}${error.message}` };
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

// what the runners upload, under the workflow's per-build directory names. Both Macs name their update archive after
// the architecture (bundle.mjs), as the bundler calls it VUEPort.app.tar.gz on either
const FULL_RELEASE = {
    'vueport-macos-aarch64/macos/VUEPort_1.1.0_aarch64.app.tar.gz': 'mac-arm',
    'vueport-macos-aarch64/macos/VUEPort_1.1.0_aarch64.app.tar.gz.sig': 'MAC-ARM-SIGNATURE\n',
    'vueport-macos-aarch64/dmg/VUEPort_1.1.0_aarch64.dmg': 'dmg',
    'vueport-macos-aarch64/pkg/VUEPort_1.1.0_aarch64.pkg': 'pkg',
    'vueport-macos-x64/macos/VUEPort_1.1.0_x64.app.tar.gz': 'mac-intel',
    'vueport-macos-x64/macos/VUEPort_1.1.0_x64.app.tar.gz.sig': 'MAC-INTEL-SIGNATURE\n',
    'vueport-macos-x64/dmg/VUEPort_1.1.0_x64.dmg': 'dmg',
    'vueport-macos-x64/pkg/VUEPort_1.1.0_x64.pkg': 'pkg',
    'vueport-linux-x64/appimage/VUEPort_1.1.0_amd64.AppImage': 'linux',
    'vueport-linux-x64/appimage/VUEPort_1.1.0_amd64.AppImage.sig': 'LINUX-SIGNATURE\n',
    'vueport-linux-x64/deb/vueport_1.1.0_amd64.deb': 'deb',
    'vueport-windows-x64/nsis/VUEPort_1.1.0_x64-setup.exe': 'windows',
    'vueport-windows-x64/nsis/VUEPort_1.1.0_x64-setup.exe.sig': 'WINDOWS-SIGNATURE\n',
};

console.log('\nA release of all four');
const full = await build(FULL_RELEASE);
check('the manifest names the version being released', full.manifest?.version, '1.1.0');
check('and every platform that was built',
    Object.keys(full.manifest?.platforms ?? {}).sort(),
    ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']);
// the signature is the file's contents, not its name: the updater compares it against the downloaded archive
check('each carrying its own signature, read out of the .sig beside it',
    full.manifest?.platforms?.['linux-x86_64']?.signature, 'LINUX-SIGNATURE');
check('and a URL under the release the tag names',
    full.manifest?.platforms?.['windows-x86_64']?.url,
    `${BASE}/VUEPort_1.1.0_x64-setup.exe`);
// two Macs in one release: each archive serves the Mac its name says, never the other's, although the .dmg and .pkg
// of both lie beside them
check('Apple Silicon Macs get the aarch64 archive',
    full.manifest?.platforms?.['darwin-aarch64']?.url, `${BASE}/VUEPort_1.1.0_aarch64.app.tar.gz`);
check('with its own signature',
    full.manifest?.platforms?.['darwin-aarch64']?.signature, 'MAC-ARM-SIGNATURE');
check('and Intel Macs the x64 one',
    full.manifest?.platforms?.['darwin-x86_64']?.url, `${BASE}/VUEPort_1.1.0_x64.app.tar.gz`);
check('with its own signature',
    full.manifest?.platforms?.['darwin-x86_64']?.signature, 'MAC-INTEL-SIGNATURE');
// the hand-download installers are not update archives; naming one would hand a .deb to the updater
check('the plain installers are left out of it',
    JSON.stringify(full.manifest?.platforms ?? {}).includes('.deb'), false);

// the archive as the bundler names it, for a run that built only one Mac: the architecture comes off the .dmg from the
// same build, never off the Windows installer, which is full of the word x64
console.log('\nAn archive named as the bundler names it');
const plain = await build({
    'vueport-macos/macos/VUEPort.app.tar.gz': 'mac',
    'vueport-macos/macos/VUEPort.app.tar.gz.sig': 'MAC-SIGNATURE\n',
    'vueport-macos/dmg/VUEPort_1.1.0_aarch64.dmg': 'dmg',
    'vueport-windows/nsis/VUEPort_1.1.0_x64-setup.exe': 'windows',
    'vueport-windows/nsis/VUEPort_1.1.0_x64-setup.exe.sig': 'WINDOWS-SIGNATURE\n',
});
check('is placed by what the .dmg beside it says',
    plain.manifest?.platforms?.['darwin-aarch64']?.url, `${BASE}/VUEPort.app.tar.gz`);
check('an Intel Mac is told there is nothing for it rather than offered an ARM build',
    plain.manifest?.platforms?.['darwin-x86_64'], undefined);
check('and the run says so out loud',
    plain.stdout?.includes('darwin-x86_64 — nothing to install'), true);

console.log('\nA release that installs nowhere');
// an archive without signature is a build made without the update key; naming it would offer every installed copy an
// update it refuses, which looks exactly like a broken updater. Left out instead, as copies of an unsigned build still
// read the version and the page
const unsigned = await build({
    'mac/VUEPort_1.1.0_aarch64.app.tar.gz': 'mac',
    'mac/VUEPort_1.1.0_aarch64.dmg': 'dmg',
}, ['--page', 'https://github.com/VUEngine/VUEPort/releases/tag/v1.1.0']);
check('an archive with no signature beside it is not offered',
    unsigned.manifest?.platforms, {});
check('and the run says so out loud',
    unsigned.stdout?.includes('VUEPort_1.1.0_aarch64.app.tar.gz has no signature'), true);
check('the manifest still names the version',
    unsigned.manifest?.version, '1.1.0');
check('and the page to download it from by hand',
    unsigned.manifest?.page, 'https://github.com/VUEngine/VUEPort/releases/tag/v1.1.0');

const nothing = await build({ 'mac/VUEPort_1.1.0_aarch64.dmg': 'dmg' });
check('a run that produced no update archive at all still makes a manifest',
    nothing.manifest?.platforms, {});
check('which names no page unless told one',
    nothing.manifest?.page, undefined);

console.log('\nWhat it refuses');
// which Mac a build is for cannot be guessed: an Apple Silicon build on an Intel Mac installs and then will not start.
// An archive with nothing saying so is refused
const anonymous = await build({
    'mac/VUEPort.app.tar.gz': 'mac',
    'mac/VUEPort.app.tar.gz.sig': 'SIG',
});
check('a macOS archive nothing says the architecture of is refused',
    anonymous.error?.includes('does not say which architecture'), true);
// what --mac-arch is for: a build without an installer to read it off, such as the local update rehearsal
const told = await build({
    'mac/VUEPort.app.tar.gz': 'mac',
    'mac/VUEPort.app.tar.gz.sig': 'SIG',
}, ['--mac-arch', 'aarch64']);
check('unless it is told',
    Object.keys(told.manifest?.platforms ?? {}), ['darwin-aarch64']);
const packaged = await build({
    'mac/VUEPort.app.tar.gz': 'mac',
    'mac/VUEPort.app.tar.gz.sig': 'SIG',
    'mac/VUEPort_1.1.0_aarch64.pkg': 'pkg',
});
check('a .pkg beside it says it as well as a .dmg would',
    Object.keys(packaged.manifest?.platforms ?? {}), ['darwin-aarch64']);
check('and the .pkg is not offered as an update',
    JSON.stringify(packaged.manifest?.platforms ?? {}).includes('.pkg'), false);

console.log('\nA universal Mac build');
const universal = await build({
    'mac/VUEPort_1.1.0_universal.app.tar.gz': 'mac',
    'mac/VUEPort_1.1.0_universal.app.tar.gz.sig': 'UNIVERSAL\n',
});
check('serves both of them from the one archive',
    Object.keys(universal.manifest?.platforms ?? {}).sort(),
    ['darwin-aarch64', 'darwin-x86_64']);

console.log('\nWhen the bundler changes its mind');
// the updater accepts both shapes, and which the bundler emits changed between Tauri versions
const zipped = await build({
    'linux/VUEPort_1.1.0_amd64.AppImage.tar.gz': 'linux',
    'linux/VUEPort_1.1.0_amd64.AppImage.tar.gz.sig': 'GZ\n',
    'windows/VUEPort_1.1.0_x64-setup.nsis.zip': 'windows',
    'windows/VUEPort_1.1.0_x64-setup.nsis.zip.sig': 'ZIP\n',
});
check('a zipped AppImage serves Linux',
    zipped.manifest?.platforms?.['linux-x86_64']?.url,
    `${BASE}/VUEPort_1.1.0_amd64.AppImage.tar.gz`);
check('and a zipped installer serves Windows',
    zipped.manifest?.platforms?.['windows-x86_64']?.url,
    `${BASE}/VUEPort_1.1.0_x64-setup.nsis.zip`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
