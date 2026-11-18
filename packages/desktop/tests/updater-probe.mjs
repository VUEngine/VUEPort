/**
 * Checks that the app can still replace itself. A wiring test, as installing an update needs two builds, a signed
 * archive and a release: every piece is checked to connect to the next, as a dead endpoint, an unregistered plugin or
 * missing updater artifacts all leave an app that runs fine and never updates again. `pubkey` is only reported, not
 * checked: a working copy has no key until one is generated (see README), but a release built without one accepts no
 * update at all.
 *
 * Usage: node tests/updater-probe.mjs
 */
import { readFile } from 'node:fs/promises';

const read = async path => await readFile(new URL(path, import.meta.url), 'utf8');

const config = JSON.parse(await read('../src-tauri/tauri.conf.json'));
const main = await read('../src-tauri/src/main.rs');
const bundle = await read('../scripts/bundle.mjs');
const workflow = await read('../../../.github/workflows/desktop.yml');
const cargo = await read('../src-tauri/Cargo.toml');
const product = JSON.parse(await read('../../../package.json'));
const commands = await read('../../web/src/web-commands.ts');
const release = await read('../../../.github/workflows/release.yml');

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        failures++;
    }
};

console.log('\nWhere it looks');
const updater = config.plugins?.updater;
check('the updater plugin is configured', updater !== undefined);
check('at one endpoint', Array.isArray(updater?.endpoints) && updater.endpoints.length === 1);

const endpoint = updater?.endpoints?.[0] ?? '';
// the manifest belongs to whichever release is marked latest, so the URL is fixed
check('which is the latest release\'s own manifest on GitHub',
    endpoint === 'https://github.com/VUEngine/VUEPort/releases/latest/download/latest.json');
check('and it carries a place for the key that checks a signature',
    typeof updater?.pubkey === 'string');

console.log('\nWhat is wired to it');
check('the plugin is registered', main.includes('tauri_plugin_updater::Builder::new()'));
// both, as the browser build deliberately carries no @tauri-apps/* package (see desktop-bridge.ts)
check('and both of the page\'s ways in are commands of the shell',
    main.includes('update::update_check') && main.includes('update::update_install'));
check('and so is the question whether this build installs at all', main.includes('update::update_installs'));

console.log('\nWhat it calls itself');
// three files carry the version: the window shows the web build's, updates compare against Tauri's, and if they
// disagree the user is told they're up to date while offered an update, or the other way round
check('the packaged version is the product\'s version',
    config.version === product.version);
check('and so is the crate\'s',
    new RegExp(`^version = "${product.version}"$`, 'm').test(cargo));
check('the window is not told a version by hand',
    !/v1\.\d+\.\d+/.test(await read('../../web/src/web-title-bar.tsx')));

console.log('\nWhat the download looks like');
// measured in the packaged app: the shell reports a download about seventy times a second, and WKWebView restarts an
// interrupted `width` transition from where the last one began, so the bar stays near zero. Chromium copes, so it goes
// unnoticed in a browser
const styles = await read('../../web/src/style.css');
const fill = /\.vp-updates-bar > div \{([^}]*)\}/.exec(styles)?.[1] ?? '';
check('the progress bar does not animate a width that is already updated per chunk',
    !/transition/.test(fill));

console.log('\nHow somebody reaches it');
check('checking is a command of its own', commands.includes('checkForUpdates'));
// in a browser it could only ever answer "you are up to date"
check('and only where there is something to check',
    commands.includes('enabled: canUpdate()'));

console.log('\nWhat a build produces');
// asked for by the bundle script rather than the configuration, so a build without a key makes installers instead
// of failing; moving the flag into tauri.conf.json would swap that round
check('updater artifacts are not asked for unconditionally',
    config.bundle?.createUpdaterArtifacts === undefined);
check('they are asked for when there is a key to sign them with',
    bundle.includes('TAURI_SIGNING_PRIVATE_KEY')
    && bundle.includes('createUpdaterArtifacts'));

// an unsigned build installing an update would meet the same Gatekeeper and SmartScreen warnings as the first download;
// such a build only checks and opens the release page (src-tauri/src/update.rs)
check('installing is switched on by the bundle script',
    bundle.includes("env.VUEPORT_SELF_UPDATE = '1'"));
check('only for a code-signed build with an update key',
    /if \(env\.TAURI_SIGNING_PRIVATE_KEY && codeSigned\)/.test(bundle));
check('and never by whatever the shell happened to have set',
    bundle.includes('delete env.VUEPORT_SELF_UPDATE'));

console.log('\nWhat the workflow carries');
check('the signing key reaches the build',
    workflow.includes('TAURI_SIGNING_PRIVATE_KEY:')
    && workflow.includes('TAURI_SIGNING_PRIVATE_KEY_PASSWORD:'));
// every shape the bundler has emitted, plus all signatures (separate files beside the archives they sign); collecting
// only installers would leave the release nothing to offer
check('and every shape of update archive is uploaded',
    ['*.app.tar.gz', '*.AppImage.tar.gz', '*.nsis.zip', '*.msi.zip', '*.sig']
        .every(pattern => workflow.includes(pattern)));

console.log('\nWhat publishes it');
check('a tag is what makes a release', /tags:\s*\n\s*- 'v\*'/.test(release));
// called rather than copied, as a release built by different steps than a test build is untested
check('built by the same workflow as everything else',
    release.includes('uses: ./.github/workflows/desktop.yml'));
check('and the manifest is assembled from what it produced',
    release.includes('latest-json.mjs') && release.includes('--out latest.json'));
check('naming the release page for copies that do not install',
    release.includes('--page "https://github.com/${GITHUB_REPOSITORY}/releases/tag/${GITHUB_REF_NAME}"'));
// publishing makes a release "latest", which every installed copy asks about; a draft can be looked at first
check('the release is drafted rather than published',
    release.includes('--draft'));

if (!updater?.pubkey) {
    console.log('\n  Note: `plugins.updater.pubkey` is empty, so this build cannot install an'
        + '\n  update; it only finds one and opens the release page. See README.md — "Key Pair".');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
