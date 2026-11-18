/**
 * Wraps the bundled VUEPort.app in a macOS installer package beside the .dmg, as Tauri has no pkg target. Takes the
 * .app from bundle/macos (signed and notarized, if the build was) and makes bundle/pkg/VUEPort_<version>_<arch>.pkg
 * with pkgbuild and productbuild.
 *
 * Signed with a Developer ID Installer certificate (not the Application one) named by
 * APPLE_INSTALLER_SIGNING_IDENTITY; without it the package is built unsigned and says so. Notarized on its own with
 * APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID, and the ticket stapled so it opens offline.
 *
 * Usage: run by yarn bundle; `yarn workspace vueport-desktop pkg` repackages the last bundle's .app without
 * rebuilding (with the same VUEPORT_TARGET, if that build had one, see bundle-dir.mjs).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundleDir as bundle, tauri } from './bundle-dir.mjs';

if (process.platform !== 'darwin') {
    console.error('An installer package can only be built on macOS.');
    process.exit(1);
}

function run(command, args, { quiet = false } = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0) {
        console.error(`${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
        process.exit(result.status ?? 1);
    }
    if (!quiet) {
        process.stdout.write(result.stdout);
    }
    return result.stdout;
}

const config = JSON.parse(await readFile(path.join(tauri, 'tauri.conf.json'), 'utf8'));
const product = config.productName;
const identifier = config.identifier;
const version = config.version;
const minimum = config.bundle?.macOS?.minimumSystemVersion ?? '10.15';

const app = path.join(bundle, 'macos', `${product}.app`);
if (!existsSync(app)) {
    console.error(`There is no ${path.relative(process.cwd(), app)} to package. Run \`yarn bundle\` first.`);
    process.exit(1);
}

// read off the executable rather than the build machine, as --target can make one for the other. Named as Tauri
// names the .dmg (aarch64, x64, universal), so latest-json.mjs can read the architecture off either
const executable = run('plutil',
    ['-extract', 'CFBundleExecutable', 'raw', path.join(app, 'Contents', 'Info.plist')], { quiet: true }).trim();
const archs = run('lipo', ['-archs', path.join(app, 'Contents', 'MacOS', executable)], { quiet: true })
    .trim().split(/\s+/);
const suffix = archs.length > 1 ? 'universal' : archs[0] === 'arm64' ? 'aarch64' : 'x64';

const identity = process.env.APPLE_INSTALLER_SIGNING_IDENTITY || undefined;
const notarization = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'].every(name => process.env[name]);

// the Installer window's left picture (macos/background.png, 620x418, drawn bottom left and scaled down). Dark Mode
// reads <background-darkAqua> alone without falling back, so both are always written: background-dark.png if present,
// else the same picture, which works if it is transparent where it should be dark
const picture = file => existsSync(path.join(tauri, 'macos', file)) ? file : undefined;
const light = picture('background.png');
const dark = picture('background-dark.png') ?? light;
const backgrounds = [
    { element: 'background', file: light },
    { element: 'background-darkAqua', file: dark },
].filter(({ file }) => file);

const output = path.join(bundle, 'pkg');
const pkg = path.join(output, `${product}_${version}_${suffix}.pkg`);

// the intermediate files live outside bundle, as the workflow uploads every .pkg under it
const work = await mkdtemp(path.join(tmpdir(), 'vueport-pkg-'));

try {
    // pkgbuild packages a directory's contents, so the .app gets one of its own; ditto rather than a copy keeps the
    // extended attributes and the stapled ticket
    const root = path.join(work, 'root');
    await mkdir(root);
    run('ditto', [app, path.join(root, `${product}.app`)]);

    // not relocatable: by default Installer installs over any copy with the bundle identifier anywhere on the disk
    // (a forgotten one in Downloads) instead of into /Applications
    const components = path.join(work, 'components.plist');
    await writeFile(components, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
    <dict>
        <key>RootRelativeBundlePath</key>
        <string>${product}.app</string>
        <key>BundleIsRelocatable</key>
        <false/>
        <key>BundleIsVersionChecked</key>
        <true/>
        <key>BundleHasStrictIdentifier</key>
        <true/>
        <key>BundleOverwriteAction</key>
        <string>upgrade</string>
    </dict>
</array>
</plist>
`);

    run('pkgbuild', [
        '--root', root,
        '--component-plist', components,
        '--install-location', '/Applications',
        '--identifier', identifier,
        '--version', version,
        path.join(work, `${product}.pkg`),
    ], { quiet: true });

    // only into /Applications on the startup disk, no "Customize" button, and only on the Macs and macOS versions
    // the app runs on, so an Intel Mac is told before installing
    const resources = path.join(work, 'resources');
    await mkdir(resources);
    for (const { file } of backgrounds) {
        await copyFile(path.join(tauri, 'macos', file), path.join(resources, file));
    }

    const distribution = path.join(work, 'distribution.xml');
    await writeFile(distribution, `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>${product}</title>
${backgrounds.map(({ element, file }) =>
        `    <${element} file="${file}" alignment="bottomleft" scaling="proportional"/>\n`).join('')}    <options customize="never" require-scripts="false" hostArchitectures="${archs.join(',')}"/>
    <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
    <allowed-os-versions>
        <os-version min="${minimum}"/>
    </allowed-os-versions>
    <choices-outline>
        <line choice="default">
            <line choice="${identifier}"/>
        </line>
    </choices-outline>
    <choice id="default"/>
    <choice id="${identifier}" visible="false">
        <pkg-ref id="${identifier}"/>
    </choice>
    <pkg-ref id="${identifier}" version="${version}" onConclusion="none">${product}.pkg</pkg-ref>
</installer-gui-script>
`);

    await mkdir(output, { recursive: true });
    await rm(pkg, { force: true });
    run('productbuild', [
        '--distribution', distribution,
        '--package-path', work,
        '--resources', resources,
        ...(identity ? ['--sign', identity, '--timestamp'] : []),
        pkg,
    ], { quiet: true });
} finally {
    await rm(work, { recursive: true, force: true });
}

console.log(`Installer package: ${path.relative(process.cwd(), pkg)}`);

if (!identity) {
    console.log('Package signing: none. Set APPLE_INSTALLER_SIGNING_IDENTITY to sign the .pkg'
        + ' (a Developer ID Installer certificate, not the Application one).');
    process.exit(0);
}

console.log(`Package signing: ${identity}`);

if (!notarization) {
    console.log('Package notarizing: no — APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID are not all set,'
        + ' so the .pkg will still be refused on another machine.');
    process.exit(0);
}

// notarytool --wait exits 0 whatever Apple decided, so the verdict is read from its answer; on a refusal
// Apple's log is printed, the only place the reason is written
const answer = JSON.parse(run('xcrun', [
    'notarytool', 'submit', pkg,
    '--apple-id', process.env.APPLE_ID,
    '--password', process.env.APPLE_PASSWORD,
    '--team-id', process.env.APPLE_TEAM_ID,
    '--wait', '--output-format', 'json',
], { quiet: true }));

if (answer.status !== 'Accepted') {
    console.error(`Notarizing the .pkg: ${answer.status}.`);
    spawnSync('xcrun', [
        'notarytool', 'log', answer.id,
        '--apple-id', process.env.APPLE_ID,
        '--password', process.env.APPLE_PASSWORD,
        '--team-id', process.env.APPLE_TEAM_ID,
    ], { stdio: 'inherit' });
    process.exit(1);
}

run('xcrun', ['stapler', 'staple', pkg], { quiet: true });
console.log('Package notarizing: accepted and stapled.');
