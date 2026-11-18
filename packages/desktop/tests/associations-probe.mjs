/**
 * Checks what the packaged app tells the system it opens. A manifest test, as Launch Services, the Windows registry
 * and the XDG MIME database cannot be asked from a build, and "alternative" vs "default" is two strings.
 *
 * What declaring `.vb.zip` is worth, measured: Linux honors it (XDG globs make `*.vb.zip` its own type, outweighing
 * `*.zip`). macOS does not, as Launch Services resolves by the last name segment only: a bundle exporting a `zzz.zip`
 * type registers, yet UTType(filenameExtension:) answers nil and `x.zzz.zip` stays public.zip-archive (Apple tags its
 * own tar.gz type `tgz` for the same reason). Windows also associates by the final extension. So `.vbz` is the same
 * archive under a name every platform binds, and the `.zip` entry keeps VUEPort in Open With without taking the type
 * over. `.vb` and `.vbc` were measured unclaimed, so claiming them as Editor/Owner works.
 *
 * Tauri merges src-tauri/Info.plist with its generated one by replacing keys, so the document types are written out
 * there in full. tauri.windows.conf.json is a JSON merge patch over tauri.conf.json that restates the associations to
 * keep `.zip` out of the registry, so the Windows checks use the merged config.
 *
 * Usage: node tests/associations-probe.mjs
 */
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const read = async name =>
    JSON.parse(await readFile(new URL(`../src-tauri/${name}`, import.meta.url), 'utf8'));

const config = await read('tauri.conf.json');

// as the Windows bundler reads it: JSON Merge Patch (RFC 7396), objects are walked into, strings and arrays replaced
// outright, which is why the Windows checks read this and not `config`
const merge = (base, patch) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return patch;
    }
    const out = base !== null && typeof base === 'object' && !Array.isArray(base)
        ? { ...base }
        : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete out[key];
        } else {
            out[key] = merge(out[key], value);
        }
    }
    return out;
};

const windowsConfig = await read('tauri.windows.conf.json');
const onWindows = merge(config, windowsConfig);

// with plutil, macOS-only, so elsewhere this half is skipped rather than parsed by hand
function readPlist() {
    if (process.platform !== 'darwin') {
        return undefined;
    }
    const path = new URL('../src-tauri/Info.plist', import.meta.url).pathname;
    return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], {
        encoding: 'utf8',
    }));
}

let failures = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
    if (!ok) {
        failures++;
    }
};

const associations = config.bundle?.fileAssociations ?? [];
const byExtension = extension => associations.find(entry => entry.ext?.includes(extension));

console.log('\nWhat the desktop build opens');
{
    check('a cartridge image', byExtension('vb') !== undefined, true);
    check('a VB Color one', byExtension('vbc') !== undefined, true);
    check('a zipped one under the name a system can bind to',
        byExtension('vbz') !== undefined, true);
    check('and under the name the scene gives it', byExtension('vb.zip') !== undefined, true);
    check('an ordinary archive as well', byExtension('zip') !== undefined, true);
}

console.log('\nWhich of them it asks to be the opener of');
{
    // Editor and Owner together are what "default application" means to Launch Services; every extension that belongs
    // to the VB alone is claimed that way
    for (const extension of ['vb', 'vbc', 'vbz']) {
        const entry = byExtension(extension) ?? {};
        check(`a .${extension} names VUEPort its editor`, entry.role, 'Editor');
        check(`and its owner`, entry.rank, 'Owner');
        // a type is only ever matched by a single-segment extension
        check(`declared as a type of its own`,
            entry.exportedType?.identifier !== undefined, true);
    }

    // one type with two tags: `.vbz` is what a system binds, `.vb.zip` what the file is usually called
    const archive = byExtension('vbz') ?? {};
    check('both spellings of an archive are the one type',
        archive.ext, ['vbz', 'vb.zip']);
    check('which is still a zip archive',
        archive.exportedType?.conformsTo, ['public.zip-archive']);

    const zip = byExtension('zip') ?? {};
    // deliberately not the default, and the entry macOS and Windows use for `.vb.zip`: no emulator should take over
    // every .zip on the user's machine
    check('an ordinary .zip stays an alternative', zip.rank, 'Alternate');
    check('offered as a viewer only', zip.role, 'Viewer');
}

// Linux decides a file's type from a MIME database glob, the .desktop file only says which types the application
// opens, so both have to name the same types letter for letter
console.log('\nAnd what Linux is told, which is a third file');
{
    const mime = await readFile(new URL('../src-tauri/vueport-mime.xml', import.meta.url), 'utf8');
    const declared = [...mime.matchAll(/<mime-type type="([^"]+)"/g)].map(match => match[1]);
    const wanted = associations
        .map(entry => entry.mimeType)
        .filter(type => type !== undefined && type.startsWith('application/x-virtual-boy'));
    check('every type the application claims is defined', declared.sort(), [...wanted].sort());
    check('including the two-part name macOS cannot bind',
        mime.includes('pattern="*.vb.zip"'), true);
    // above shared-mime-info's own `*.zip`, which is weight 50
    check('weighted above an ordinary archive', /\*\.vb\.zip" weight="60"/.test(mime), true);
    // filed under the type's name with the slash as a dash, the names document-icons.mjs writes
    check('and each type names the icon the packages install',
        [...mime.matchAll(/<icon name="([^"]+)"/g)].map(match => match[1]).sort(),
        wanted.map(type => type.replace('/', '-')).sort());

    const files = config.bundle?.linux?.deb?.files ?? {};
    check('the MIME definition is installed where the database is rebuilt from',
        files['/usr/share/mime/packages/vueport.xml'] !== undefined, true);
    check('and the icons into the theme, smallest size included',
        files['/usr/share/icons/hicolor/16x16/mimetypes/'] !== undefined, true);
    check('with the same list for rpm as for deb',
        JSON.stringify(config.bundle?.linux?.rpm?.files), JSON.stringify(files));
}

// Tauri's installer writes the application's icon for every file class, the hook writes them again; the classes it
// names must be the association names, or a rename silently stops matching. Read from the merged configuration
console.log('\nAnd what Windows is told, which is a hook');
{
    const claimed = onWindows.bundle?.fileAssociations ?? [];

    // one installer, as these customizations are NSIS's alone; WiX would ship an MSI with none of this
    check('one installer format, the one these customizations reach',
        onWindows.bundle?.targets, ['nsis']);

    const hooks = onWindows.bundle?.windows?.nsis?.installerHooks;
    check('the installer runs our hook', hooks, 'windows/associations.nsh');
    // the trap: installerHooks is a single path, so a second one in the base would silently be replaced
    check('and the base names no second hook file for it to swallow',
        config.bundle?.windows?.nsis, undefined);

    const script = await readFile(new URL(`../src-tauri/${hooks}`, import.meta.url), 'utf8');

    // claimed here rather than inherited, as the base list carries `.zip` too and Tauri's installer would take it
    check('the three cartridge types are claimed',
        claimed.map(entry => entry.ext), [['vb'], ['vbc'], ['vbz']]);
    // `vb.zip` is left to Linux: a Windows extension is the last dot onwards, so its key would never be consulted
    check('and the two-part name is not among them',
        claimed.some(entry => entry.ext.includes('vb.zip')), false);
    for (const entry of claimed) {
        check(`the icon for ${entry.ext[0]} is written under its file class`,
            script.includes(`Software\\Classes\\${entry.name}\\DefaultIcon`), true);
    }

    // named is not installed: the hook writes paths under $INSTDIR, and `resources` puts files there
    const resources = Object.values(config.bundle?.resources ?? {});
    for (const type of ['vb', 'vbc', 'vbz']) {
        check(`and ${type}.ico is carried to where the hook points`, [
            script.includes(`$INSTDIR\\documents\\${type}.ico`),
            resources.includes(`documents/${type}.ico`),
        ], [true, true]);
    }

    // Windows offers an extension only what is registered for it, so the unzippers macOS and Linux find through the zip
    // type are listed by hand, and removed again, as Tauri's uninstaller leaves the key
    for (const progId of ['CompressedFolder', '7-Zip.zip', 'WinRAR.ZIP']) {
        check(`a .vbz offers ${progId} and withdraws it on uninstall`, [
            script.includes(`WriteRegStr SHCTX "Software\\Classes\\.vbz\\OpenWithProgids" "${progId}"`),
            script.includes(`DeleteRegValue SHCTX "Software\\Classes\\.vbz\\OpenWithProgids" "${progId}"`),
        ], [true, true]);
    }
    check('and is filed with the archives', [
        script.includes('WriteRegStr SHCTX "Software\\Classes\\.vbz" "PerceivedType" "compressed"'),
        script.includes('DeleteRegValue SHCTX "Software\\Classes\\.vbz" "PerceivedType"'),
    ], [true, true]);

    // `.zip` is not an association, as Tauri's installer would overwrite its default handler (Explorer's folder view);
    // the hook offers it as a secondary handler the way Windows means it
    check('an ordinary archive is not claimed as an association',
        claimed.some(entry => entry.ext.includes('zip')), false);
    check('but is offered through a ProgID of our own',
        script.includes('Software\\Classes\\.zip\\OpenWithProgids'), true);
    // that ProgID's icon identifies the application in Open With; a document icon would draw a cartridge on every archive
    check('an ordinary archive keeps whatever icon it had',
        script.split('\n').find(line => line.includes('${ZIP_PROGID}\\DefaultIcon'))
            ?.includes('MAINBINARYNAME'),
        true);
}

// no platform fails loudly for a missing icon (blank page, generic document, nothing), so a renamed or stale icon goes
// unnoticed until a file list is looked at
console.log('\nAnd that the icons themselves are there');
{
    const exists = async path =>
        stat(new URL(path, import.meta.url)).then(() => true, () => false);
    for (const type of ['vb', 'vbc', 'vbz']) {
        check(`${type} has a source, an icns and an ico`, [
            await exists(`../src-tauri/icons/documents/${type}.png`),
            await exists(`../src-tauri/icons/documents/${type}.icns`),
            await exists(`../src-tauri/icons/documents/${type}.ico`),
        ], [true, true, true]);
    }
    // the size a file list shows, and the one a scaled-down 1024 source looks worst at
    check('and the theme carries the smallest size of each',
        await Promise.all(['rom', 'color-rom', 'rom-archive'].map(name =>
            exists(`../src-tauri/icons/documents/linux/16x16/application-x-virtual-boy-${name}.png`))),
        [true, true, true]);
}

const plist = readPlist();
if (plist) {
    console.log('\nAnd what macOS is told, which is a second file');
    const types = plist.CFBundleDocumentTypes ?? [];
    const exported = plist.UTExportedTypeDeclarations ?? [];

    // every association in the same order with the same extensions, role and rank, as the plist is what macOS acts on
    check('the same file types in the same order',
        types.map(type => type.CFBundleTypeExtensions),
        associations.map(entry => entry.ext));
    check('with the same roles',
        types.map(type => type.CFBundleTypeRole),
        associations.map(entry => entry.role));
    check('and the same ranks',
        types.map(type => type.LSHandlerRank),
        associations.map(entry => entry.rank));
    check('exporting the same types',
        exported.map(type => type.UTTypeIdentifier),
        associations.flatMap(entry => entry.exportedType?.identifier ?? []));

    check('each owned type names a document icon',
        types.filter(type => type.LSHandlerRank === 'Owner')
            .map(type => type.CFBundleTypeIconFile),
        ['vb.icns', 'vbc.icns', 'vbz.icns']);
    check('and the type declarations name it too',
        exported.map(type => type.UTTypeIconFile),
        ['vb.icns', 'vbc.icns', 'vbz.icns']);
    check('an ordinary archive is left without one',
        types.find(type => type.LSHandlerRank === 'Alternate')?.CFBundleTypeIconFile,
        undefined);

    // CFBundleTypeIconFile is a file name in Contents/Resources, and Finder just draws a blank page when it is missing
    const resources = Object.values(config.bundle?.resources ?? {});
    check('and every icon named is one the bundle carries',
        ['vb.icns', 'vbc.icns', 'vbz.icns'].every(icon => resources.includes(icon)), true);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
