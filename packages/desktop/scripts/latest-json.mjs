/**
 * Builds latest.json, the manifest an installed VUEPort reads to find its successor. Attached to the release, it gives
 * the updater a `version` to compare, this platform's archive to download and the signature to check it against, and
 * a copy that does not install updates itself the `page` to send people to (src-tauri/src/update.rs). Archives are
 * discovered rather than named, as the bundler renames them between Tauri versions (Linux .AppImage vs
 * .AppImage.tar.gz, Windows bare vs zipped -setup.exe), and a fixed name would one day point at nothing. An archive
 * without a signature is left out: it comes from a build without the update key, which every copy would refuse, and a
 * platform with nothing to install is still offered the release page.
 *
 * Usage:
 *   node scripts/latest-json.mjs --artifacts <dir> --version 1.1.0 \
 *     --base-url https://github.com/VUEngine/VUEPort/releases/download/v1.1.0 \
 *     [--page https://github.com/VUEngine/VUEPort/releases/tag/v1.1.0] \
 *     [--notes <file>] [--out latest.json] [--mac-arch aarch64]
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
    args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const artifacts = args.get('artifacts');
const version = args.get('version');
const baseUrl = args.get('base-url');
const out = args.get('out') ?? 'latest.json';

if (!artifacts || !version || !baseUrl) {
    console.error('Usage: latest-json.mjs --artifacts <dir> --version <x.y.z> --base-url <url> [--page <url>]'
        + ' [--notes <file>] [--out <file>] [--mac-arch <aarch64|x86_64|universal>]');
    process.exit(2);
}

// every file under the artifacts directory, by name. Flattened, as a release is one flat list of assets; a
// duplicate name is reported rather than silently resolved
async function collect(dir) {
    const found = new Map();
    const walk = async current => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (found.has(entry.name) && found.get(entry.name) !== full) {
                throw new Error(`Two different files are both called ${entry.name}:\n`
                    + `  ${found.get(entry.name)}\n  ${full}`);
            } else {
                found.set(entry.name, full);
            }
        }
    };
    await walk(dir);
    return found;
}

// the Macs a name's architecture serves, if it names one. Universal serves both; a name that says nothing
// gets nothing, as an Apple Silicon build on an Intel Mac installs but will not start
function macArchitecture(said) {
    if (/universal/i.test(said)) {
        return ['darwin-aarch64', 'darwin-x86_64'];
    }
    if (/aarch64|arm64/i.test(said)) {
        return ['darwin-aarch64'];
    }
    if (/x64|x86_64|intel/i.test(said)) {
        return ['darwin-x86_64'];
    }
    return undefined;
}

/**
 * Which Macs an archive is for; only macOS is built for two architectures. bundle.mjs renames the bundler's
 * VUEPort.app.tar.gz after its architecture (VUEPort_1.1.0_aarch64.app.tar.gz), but other builds, such as the update
 * rehearsal, keep the plain name, so the run's .dmg and .pkg, then --mac-arch, are fallbacks. Only macOS installers
 * are read, as a -setup.exe name is full of `x64` and says nothing about Macs.
 */
function macPlatforms(name, names) {
    const said = macArchitecture(name);
    if (said) {
        return said;
    }

    const disks = names.filter(candidate => candidate.endsWith('.dmg') || candidate.endsWith('.pkg'))
        .map(macArchitecture).filter(Boolean);
    // two different ones mean a run that built both, where an archive without an architecture is neither's
    if (disks.length > 0 && disks.every(one => String(one) === String(disks[0]))) {
        return disks[0];
    }

    const told = macArchitecture(args.get('mac-arch') ?? '');
    if (told) {
        return told;
    }

    throw new Error(`${name} does not say which architecture it is for, and neither does anything`
        + ' built beside it, so it cannot be offered to one. Pass --mac-arch aarch64, x86_64 or'
        + ' universal.');
}

const WANTED = [
    { platforms: macPlatforms, match: name => name.endsWith('.app.tar.gz') },
    { platforms: () => ['linux-x86_64'], match: name => name.endsWith('.AppImage.tar.gz') },
    { platforms: () => ['linux-x86_64'], match: name => name.endsWith('.AppImage') },
    { platforms: () => ['windows-x86_64'], match: name => name.endsWith('-setup.exe') },
    { platforms: () => ['windows-x86_64'], match: name => name.endsWith('.nsis.zip') },
    { platforms: () => ['windows-x86_64'], match: name => name.endsWith('.msi.zip') },
];

const files = await collect(artifacts);
const names = [...files.keys()].sort();
const platforms = {};
const used = [];
const unsigned = [];

for (const wanted of WANTED) {
    for (const name of names.filter(candidate => wanted.match(candidate))) {
        const signature = `${name}.sig`;
        if (!files.has(signature)) {
            unsigned.push(name);
            continue;
        }
        for (const platform of wanted.platforms(name, names)) {
            // the first archive that can serve a platform wins, hence the order above
            if (platforms[platform]) {
                continue;
            }
            platforms[platform] = {
                signature: (await readFile(files.get(signature), 'utf8')).trim(),
                url: `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(name)}`,
            };
            used.push(`${platform} ← ${name}`);
        }
    }
}

const manifest = {
    version,
    // what the About window shows about the offered release; empty draws nothing, see web-update.tsx
    notes: args.get('notes') ? (await readFile(args.get('notes'), 'utf8')).trim() : '',
    pub_date: new Date().toISOString(),
    ...args.get('page') ? { page: args.get('page') } : {},
    platforms,
};

await writeFile(out, `${JSON.stringify(manifest, undefined, 2)}\n`);

console.log(`${out}: VUEPort ${version}`);
for (const line of used) {
    console.log(`  ${line}`);
}
for (const name of unsigned) {
    console.log(`  ${name} has no signature beside it (built without TAURI_SIGNING_PRIVATE_KEY), so it is not offered.`);
}
// said rather than failed: three platforms of four is a real release; which were built is the workflow's business
for (const platform of ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']) {
    if (!platforms[platform]) {
        console.log(`  ${platform} — nothing to install; copies there are only sent to the release page.`);
    }
}
