// builds the standalone web emulator. The core worker and audio worklet are entry points of their own as they're loaded
// by URL; wasm, translations and the page are copied. Production uses split ES modules, content-hashed names and an
// index.html generated from `public`, development keeps stable names
import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, watch as watchPath } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');
const dev = watch || serve;
// a release without source maps: the desktop app's (tauri.conf.json), which embeds what it ships into its binary and
// has no use for 13 MB of maps there. The web deployment keeps them
const sourcemaps = !process.argv.includes('--no-sourcemaps');

// `dist` is the deployable, emptied by `yarn build` and `yarn test:ui`; a dev server writing there too lost the
// files an open page was about to ask for (the chunk 404s as `text/plain` and the browser refuses the module)
const outdir = path.join(__dirname, dev ? 'dist-dev' : 'dist');

// the desktop probe checks that tauri.conf.json carries the same version. VUEPORT_VERSION_OVERRIDE lets the update
// rehearsal build a higher version without editing files, see packages/desktop/scripts/mock-update.mjs
const version = process.env.VUEPORT_VERSION_OVERRIDE ?? JSON.parse(
    await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;

const corePackage = path.dirname(require.resolve('vueport-core/package.json'));
// the repository's data: the ROM patches (patches/<game>/…) and the VB Color packages (color-packages/)
const dataDirectory = path.join(__dirname, '..', '..', 'data');

// bundles vueport-core from its TypeScript sources: its CommonJS build cannot be tree-shaken, and its
// `@phosphor-icons/react` barrel is the entire icon set, most of the app's weight. Type checking still uses
// `vueport-core/lib/...` declarations; the package ships `src` for this
function coreFromSourcePlugin() {
    return {
        name: 'vueport-core-from-source',
        setup(build) {
            build.onResolve({ filter: /^vueport-core\/lib\// }, args => {
                const relative = args.path.slice('vueport-core/lib/'.length);
                for (const extension of ['.ts', '.tsx']) {
                    const candidate = path.join(corePackage, 'src', relative + extension);
                    if (existsSync(candidate)) {
                        return { path: candidate };
                    }
                }
                // not a source file (the worker entries resolve by real path), leave it to the default resolver
                return undefined;
            });
        },
    };
}

// Phosphor ships six weights per icon in one `Map`, around 140 KB of unused SVG across the icons in use.
// `regular` is the default, `fill` is asked for by the transport controls and badges
const ICON_WEIGHTS = ['regular', 'fill'];

// edits Phosphor's modules, as the weights are entries in one array literal, which tree shaking keeps whole. Kept
// small and loud: if Phosphor changes these files' shape, the build fails rather than shipping blank icons
function phosphorWeightsPlugin() {
    const kept = new Set(ICON_WEIGHTS);
    let seen = 0;
    let dropped = 0;

    // top-level elements of an array literal; markup nests brackets and strings, so depth and strings are tracked
    const elementsOf = (source, open) => {
        const elements = [];
        let depth = 0;
        let start = open + 1;
        let quote;
        for (let i = open; i < source.length; i++) {
            const character = source[i];
            if (quote) {
                if (character === '\\') {
                    i++;
                } else if (character === quote) {
                    quote = undefined;
                }
                continue;
            }
            if (character === '"' || character === '\'' || character === '`') {
                quote = character;
            } else if (character === '[' || character === '(' || character === '{') {
                depth++;
            } else if (character === ']' || character === ')' || character === '}') {
                depth--;
                if (depth === 0) {
                    elements.push(source.slice(start, i));
                    return { elements, end: i };
                }
            } else if (character === ',' && depth === 1) {
                elements.push(source.slice(start, i));
                start = i + 1;
            }
        }
        return undefined;
    };

    return {
        name: 'phosphor-icon-weights',
        setup(build) {
            build.onLoad({ filter: /@phosphor-icons[\/\\]react[\/\\]dist[\/\\]defs[\/\\].*\.mjs$/ }, async args => {
                const source = await readFile(args.path, 'utf8');
                const open = source.indexOf('new Map([');
                if (open < 0) {
                    return undefined;
                }
                const split = elementsOf(source, open + 'new Map('.length);
                if (!split) {
                    return undefined;
                }
                const weight = element => element.match(/"([a-z]+)"/)?.[1];
                const wanted = split.elements.filter(element => {
                    const name = weight(element);
                    seen++;
                    if (name && !kept.has(name)) {
                        dropped++;
                        return false;
                    }
                    return true;
                });
                if (wanted.length === 0) {
                    throw new Error(
                        `${path.basename(args.path)}: no weight in ${ICON_WEIGHTS.join(', ')} survived. `
                        + 'Phosphor\'s icon definitions have changed shape; this plugin needs revisiting.');
                }
                return {
                    contents: source.slice(0, open + 'new Map('.length)
                        + `[${wanted.join(',')}]`
                        + source.slice(split.end + 1),
                    loader: 'js',
                };
            });

            build.onEnd(() => {
                if (seen > 0 && dropped === 0) {
                    console.warn('  warning: no Phosphor icon weights were dropped — is the plugin still matching?');
                }
            });
        },
    };
}

function fingerprint(contents) {
    return createHash('sha256').update(contents).digest('hex').slice(0, 8);
}

function stamped(name, extension, contents) {
    return dev ? `${name}${extension}` : `${name}-${fingerprint(contents)}${extension}`;
}

// the development server's own copies of the VB Color packages, named as on packages.vueport.net
// (<name>-<sha256, 8 hex>.vbcpkg: core's scripts/color-packages.mjs)
async function copyColorPackages(directory, target) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(directory)) {
        if (name.endsWith('.vbcpkg')) {
            const data = await readFile(path.join(directory, name));
            const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
            await writeFile(path.join(target, name.replace(/\.vbcpkg$/, `-${hash}.vbcpkg`)), data);
        }
    }
}

// returns the names the page must know: the hashed wasm name, and the translations the boot script in `index.html` may
// guess at
async function copyAssets() {
    await mkdir(path.join(outdir, 'i18n'), { recursive: true });
    await cp(path.join(__dirname, 'public'), outdir, { recursive: true });

    const wasm = await readFile(path.join(corePackage, 'wasm', 'shrooms', 'core.wasm'));
    const wasmName = stamped('core', '.wasm', wasm);
    await writeFile(path.join(outdir, wasmName), wasm);

    // the RetroAchievements engine, built out of band with Emscripten (see packages/core/wasm/README.md) and
    // optional: without it the worker reports RetroAchievements unavailable at runtime. Not hashed, as Emscripten's
    // `rcheevos.js` glue looks up its `.wasm` by name
    for (const rcheevosFile of ['rcheevos.js', 'rcheevos.wasm']) {
        const source = path.join(corePackage, 'wasm', 'rcheevos', rcheevosFile);
        if (existsSync(source)) {
            await cp(source, path.join(outdir, rcheevosFile));
        }
    }
    // the offline RetroAchievements snapshot, fetched on demand by `emulator-retroachievements.ts`, never bundled
    const raBackup = path.join(corePackage, 'src', 'data', 'retroachievements-vb.json');
    if (existsSync(raBackup)) {
        await cp(raBackup, path.join(outdir, 'retroachievements-vb.json'));
    }
    // the controller name database, fetched when Game Pads settings first open; optional, pads fall back to their id
    const controllerNames = path.join(corePackage, 'src', 'data', 'controller-names.json');
    if (existsSync(controllerNames)) {
        await cp(controllerNames, path.join(outdir, 'controller-names.json'));
    }
    // ROM patches, read when their game opens (translations up to a megabyte, colorizations a few), never bundled
    const patches = path.join(dataDirectory, 'patches');
    if (existsSync(patches)) {
        await cp(patches, path.join(outdir, 'patches'), { recursive: true });
    }
    // not the VB Color packages (data/color-packages): only the color editor reads them, from packages.vueport.net
    // (core's vb-color-package-file.ts, `yarn deploy:packages`). A development build serves its own copies, named as there
    const colorPackages = path.join(dataDirectory, 'color-packages');
    if (dev && existsSync(colorPackages)) {
        await copyColorPackages(colorPackages, path.join(outdir, 'color-packages'));
    }

    const locales = [];
    for (const file of await readdir(path.join(corePackage, 'i18n'))) {
        if (!file.endsWith('.json')) {
            continue;
        }
        await cp(path.join(corePackage, 'i18n', file), path.join(outdir, 'i18n', file));
        // `nls.json` is the extraction source rather than a translation
        const tag = file.match(/^nls\.([a-z-]+)\.json$/)?.[1];
        if (tag) {
            locales.push(tag);
        }
    }

    return { wasmName, locales: locales.sort() };
}

async function writeHtml({ css, js, locales, build = '', preload = [], prefetch = [] }) {
    const template = await readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');

    // `modulepreload` names the entry's imports in the head, saving a round trip on slow links. `prefetch` loads the
    // worker and the core's wasm at idle priority, as they are only needed to run a game
    const links = [
        ...preload.map(file => `<link rel="modulepreload" href="./${file}">`),
        ...prefetch.map(file => `<link rel="prefetch" href="./${file}">`),
    ];

    const html = template
        .replace('<!--%PRELOAD%-->', links.join('\n    '))
        .replace('<!--%CSS%-->', `./${css}`)
        .replace('<!--%JS%-->', `./${js}`)
        .replace('<!--%LOCALES%-->', JSON.stringify(locales))
        .replace('<!--%BUILD%-->', JSON.stringify(build));

    if (html.includes('<!--%')) {
        throw new Error('index.html still has an unfilled slot; template and build disagree.');
    }
    await writeFile(path.join(outdir, 'index.html'), html);
}

// the files an esbuild result wrote, relative to `dist`
function outputsOf(result) {
    return Object.keys(result.metafile.outputs).map(file => path.relative(outdir, path.join(__dirname, file)));
}

const brotliWasm = path.dirname(require.resolve('brotli-wasm'));

/** @type {import('esbuild').BuildOptions} */
const shared = {
    bundle: true,
    outdir,
    target: 'es2020',
    logLevel: 'info',
    metafile: true,
    minify: !dev,
    sourcemap: dev ? 'inline' : sourcemaps,
    loader: {
        '.png': 'dataurl',
        '.svg': 'dataurl',
        '.woff': 'file',
        '.woff2': 'file',
        // brotli-wasm's encoder, inlined into the chunk the color editor's Export Package loads on first use
        '.wasm': 'binary',
    },
    // brotli-wasm's web build and wasm, which its `exports` hide (core's brotli-wasm-web.d.ts)
    alias: {
        'brotli-wasm-web': path.join(brotliWasm, 'pkg.web', 'brotli_wasm.js'),
        'brotli-wasm-web-bytes': path.join(brotliWasm, 'pkg.web', 'brotli_wasm_bg.wasm'),
    },
};

// built first, as the application is told their file names, unknown until they exist in production
const workerOptions = {
    ...shared,
    plugins: [coreFromSourcePlugin(), phosphorWeightsPlugin()],
    entryNames: dev ? '[name]' : '[name]-[hash]',
    format: 'iife',
    entryPoints: { 'vb-worker': require.resolve('vueport-core/lib/worker/vb-worker.js') },
    platform: 'browser',
};

// the Probe mode's fork worker, see `probe-fork-worker.ts` in the core
const probeWorkerOptions = {
    ...shared,
    plugins: [coreFromSourcePlugin(), phosphorWeightsPlugin()],
    entryNames: dev ? '[name]' : '[name]-[hash]',
    format: 'iife',
    entryPoints: { 'probe-worker': require.resolve('vueport-core/lib/probe/probe-fork-worker.js') },
    platform: 'browser',
};

// the color editor's compile worker, see `vb-color-compile-worker.ts` in the core
const colorWorkerOptions = {
    ...shared,
    plugins: [coreFromSourcePlugin(), phosphorWeightsPlugin()],
    entryNames: dev ? '[name]' : '[name]-[hash]',
    format: 'iife',
    entryPoints: { 'vb-color-worker': require.resolve('vueport-core/lib/worker/vb-color-compile-worker.js') },
    platform: 'browser',
};

const workletOptions = {
    ...shared,
    plugins: [coreFromSourcePlugin(), phosphorWeightsPlugin()],
    entryNames: dev ? '[name]' : '[name]-[hash]',
    // an AudioWorklet has no window and no module loader, so it has to be one self-contained script
    platform: 'neutral',
    format: 'iife',
    entryPoints: { 'vb-audio-worklet': require.resolve('vueport-core/lib/worker/vb-audio-worklet.js') },
};

// needs the other two to have names first
function appOptions({ workerName, workletName, wasmName, probeWorkerName, colorWorkerName }) {
    return {
        ...shared,
        plugins: [coreFromSourcePlugin(), phosphorWeightsPlugin()],
        entryPoints: { bundle: path.join(__dirname, 'src', 'main.tsx') },
        platform: 'browser',
        // ESM and split: an IIFE inlines every dynamic import, so everyone paid for every `import()` at startup
        format: 'esm',
        splitting: true,
        // stable entry name while developing, for a page left open. Chunks are always stamped, as several shared ones
        // are anonymous and would all collide as `chunk.js`
        entryNames: dev ? '[name]' : '[name]-[hash]',
        chunkNames: 'chunks/[name]-[hash]',
        assetNames: 'assets/[name]-[hash]',
        define: {
            VUEPORT_WORKER_URL: JSON.stringify(`./${workerName}`),
            VUEPORT_AUDIO_WORKLET_URL: JSON.stringify(`./${workletName}`),
            VUEPORT_WASM_URL: JSON.stringify(`./${wasmName}`),
            VUEPORT_PROBE_WORKER_URL: JSON.stringify(`./${probeWorkerName}`),
            VUEPORT_COLOR_WORKER_URL: JSON.stringify(`./${colorWorkerName}`),
            VUEPORT_COLOR_PACKAGES_URL: JSON.stringify(dev ? './color-packages/' : ''),
            VUEPORT_VERSION: JSON.stringify(version),
        },
    };
}

// esbuild's `[hash]` is uppercase base32, not hex, so the pattern is broad about what a hash looks like
function named(outputs, base) {
    const [, stem, extension] = base.match(/^(.*)\.(\w+)$/);
    const hashed = new RegExp(`^${stem}-[A-Za-z0-9_-]+\\.${extension}$`);
    return outputs.find(file => file === base) ?? outputs.find(file => hashed.test(file));
}

if (dev) {
    // stable names, so a watching build and an open page agree without regenerating anything. Cleared all the same,
    // as a production `dist` is full of hashed files this build would never overwrite
    await rm(outdir, { recursive: true, force: true });
    const { wasmName, locales } = await copyAssets();
    const contexts = await Promise.all([
        esbuild.context(appOptions({
            workerName: 'vb-worker.js',
            workletName: 'vb-audio-worklet.js',
            probeWorkerName: 'probe-worker.js',
            colorWorkerName: 'vb-color-worker.js',
            wasmName,
        })),
        esbuild.context(workerOptions),
        esbuild.context(probeWorkerOptions),
        esbuild.context(colorWorkerOptions),
        esbuild.context(workletOptions),
    ]);
    await writeHtml({
        css: 'bundle.css',
        js: 'bundle.js',
        locales,
    });
    await Promise.all(contexts.map(context => context.watch()));

    // watches the copied assets, which esbuild doesn't as they're fetched by URL (a colorization added mid-session used
    // to 404). Development only, and blunt: any change recopies all of them
    const assetSources = [
        path.join(corePackage, 'src', 'data'),
        dataDirectory,
        path.join(corePackage, 'i18n'),
        path.join(__dirname, 'public'),
    ].filter(existsSync);
    let pending;
    const refreshAssets = () => {
        clearTimeout(pending);
        // debounced: one file write raises several events, a copied directory one per file
        pending = setTimeout(() => {
            copyAssets()
                .then(({ locales }) => writeHtml({ css: 'bundle.css', js: 'bundle.js', locales }))
                .then(() => console.log('  assets refreshed'))
                .catch(error => console.error('  assets could not be refreshed:', error));
        }, 150);
    };
    for (const source of assetSources) {
        try {
            watchPath(source, { recursive: true }, refreshAssets);
        } catch (error) {
            // recursive watching is not everywhere; losing it costs a restart after adding an asset, an exception would
            // cost the dev server
            console.warn(`  not watching ${path.relative(__dirname, source)}:`, error.message);
        }
    }
    if (serve) {
        const { host, port } = await contexts[0].serve({ servedir: outdir, port: 5173 });
        console.log(`\n  VUEPort running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`);
    }
} else {
    // old hashed files would pile up, and a stale `bundle-<hash>.js` looks just like the current one
    await rm(outdir, { recursive: true, force: true });

    const { wasmName, locales } = await copyAssets();

    const [worker, worklet, probeWorker, colorWorker] = await Promise.all([
        esbuild.build(workerOptions),
        esbuild.build(workletOptions),
        esbuild.build(probeWorkerOptions),
        esbuild.build(colorWorkerOptions),
    ]);
    const workerName = named(outputsOf(worker), 'vb-worker.js');
    const workletName = named(outputsOf(worklet), 'vb-audio-worklet.js');
    const probeWorkerName = named(outputsOf(probeWorker), 'probe-worker.js');
    const colorWorkerName = named(outputsOf(colorWorker), 'vb-color-worker.js');
    if (!workerName || !workletName || !probeWorkerName || !colorWorkerName) {
        throw new Error('A worker or the worklet did not produce the file it was asked for.');
    }

    const app = await esbuild.build(appOptions({ workerName, workletName, wasmName, probeWorkerName, colorWorkerName }));
    const appOutputs = outputsOf(app);
    const js = named(appOutputs, 'bundle.js');
    const css = named(appOutputs, 'bundle.css');
    if (!js || !css) {
        throw new Error('The application build produced neither a bundle nor a stylesheet.');
    }

    // the boot script in `index.html` compares against this to notice a leftover page: every hashed name plus the
    // version, for a release that changed nothing else
    const build = fingerprint([version, js, css, workerName, workletName, wasmName, probeWorkerName, colorWorkerName].join('\n'));
    await writeFile(path.join(outdir, 'version.json'), JSON.stringify({ version, build }));

    await writeHtml({
        css,
        js,
        locales,
        build,
        // only chunks the entry imports statically; ones behind a dynamic import are there on purpose, and the worker
        // and wasm are only needed once a game starts
        preload: (app.metafile.outputs[path.relative(process.cwd(), path.join(outdir, js))]?.imports ?? [])
            .filter(entry => entry.kind === 'import-statement')
            .map(entry => path.relative(outdir, path.resolve(process.cwd(), entry.path))),
        prefetch: [workerName, wasmName],
    });
}
