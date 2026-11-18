import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from 'basic-ftp';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const target = args.find(arg => !arg.startsWith('--'));
const dryRun = args.includes('--dry-run');
const noBuild = args.includes('--no-build');
const prune = args.includes('--prune');

if (target !== 'web' && target !== 'server' && target !== 'packages') {
    console.error('Usage: node scripts/deploy.mjs <web|server|packages> [--dry-run] [--no-build] [--prune]');
    process.exit(1);
}

const envFile = path.join(root, 'deploy.env');
if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
}

function setting(name, fallback) {
    const value = process.env[`VUEPORT_${target.toUpperCase()}_${name}`] ?? process.env[`VUEPORT_${name}`];
    if (value !== undefined && value !== '') {
        return value;
    }
    if (fallback !== undefined) {
        return fallback;
    }
    console.error(`VUEPORT_${name} is not set. Copy deploy.env.example to deploy.env and fill it in.`);
    process.exit(1);
}

const ftp = {
    host: setting('FTP_HOST'),
    port: Number(setting('FTP_PORT', '21')),
    user: setting('FTP_USER'),
    password: setting('FTP_PASSWORD'),
    secure: { false: false, implicit: 'implicit' }[setting('FTP_SECURE', 'true')] ?? true,
    secureOptions: { rejectUnauthorized: setting('FTP_INSECURE_TLS', 'false') !== 'true' },
};

const HASHED = /-(?:[A-Z0-9]{8}|[0-9a-f]{8})\.[a-z0-9.]+$/;

function run(command, commandArgs) {
    console.log(`\n$ ${command} ${commandArgs.join(' ')}`);
    const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
        console.error(`\n${command} ${commandArgs.join(' ')} failed; nothing was uploaded.`);
        process.exit(result.status ?? 1);
    }
}

async function filesIn(directory, base = directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...await filesIn(full, base));
        } else if (entry.isFile() && entry.name !== '.DS_Store') {
            const data = await readFile(full);
            found.push({
                relative: path.relative(base, full).split(path.sep).join('/'),
                data,
                size: data.length,
                sha256: createHash('sha256').update(data).digest('hex'),
            });
        }
    }
    return found;
}

function missingFromIndex(files) {
    const index = files.find(file => file.relative === 'index.html');
    if (!index) {
        return ['index.html'];
    }
    const have = new Set(files.map(file => file.relative));
    const named = index.data.toString('utf8').match(/[\w./-]+-(?:[A-Z0-9]{8}|[0-9a-f]{8})\.(?:js|css|wasm)\b/g) ?? [];
    return [...new Set(named.map(name => name.replace(/^\.?\//, '')))].filter(name => !have.has(name));
}

function remoteJoin(...parts) {
    return `/${parts.join('/')}`.replace(/\/+/g, '/');
}

function remoteParent(remote) {
    return remote.slice(0, remote.lastIndexOf('/')) || '/';
}

function kilobytes(bytes) {
    return `${(bytes / 1024).toFixed(1)} KB`;
}

async function remoteSizes(client, directories) {
    const sizes = new Map();
    for (const directory of directories) {
        try {
            for (const entry of await client.list(directory)) {
                if (entry.isFile) {
                    sizes.set(remoteJoin(directory, entry.name), entry.size);
                }
            }
        } catch {
            // not created yet
        }
    }
    return sizes;
}

async function put(client, data, remote) {
    const temporary = `${remote}.uploading`;
    await client.ensureDir(remoteParent(remote));
    await client.uploadFrom(Readable.from([data]), temporary);
    try {
        await client.rename(temporary, remote);
    } catch {
        await client.remove(remote, true);
        await client.rename(temporary, remote);
    }
}

async function download(client, remote) {
    const chunks = [];
    const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
    try {
        await client.downloadTo(sink, remote);
        return Buffer.concat(chunks).toString('utf8');
    } catch {
        return undefined;
    }
}

const MANIFEST = '.vueport-deploy.json';

const ACCESS_RULE = /^\s*(AuthType|AuthUserFile|Require|Deny|Allow)\b/im;

async function keepGuardingHtaccess(client, plan) {
    const found = plan.find(file => path.posix.basename(file.remote) === '.htaccess');
    if (!found) {
        return plan;
    }
    const current = await download(client, found.remote);
    if (current === undefined || !ACCESS_RULE.test(current) || ACCESS_RULE.test(found.data.toString('utf8'))) {
        return plan;
    }
    console.log(`\n${found.remote} up there guards access (AuthType, Require, …) and the new one does not: kept as it is.`
        + ' Merge the two by hand if the new caching rules should apply.');
    return plan.filter(file => file !== found);
}

async function upload(client, plan) {
    const total = plan.reduce((sum, file) => sum + file.size, 0);
    let done = 0;
    for (const [index, file] of plan.entries()) {
        process.stdout.write(`  [${index + 1}/${plan.length}] ${file.remote} (${kilobytes(file.size)})\n`);
        // the host drops the control connection now and then on long runs (ECONNRESET): connect again and send the
        // file once more; a file only takes its name once it is whole (put), so a broken one leaves nothing half there
        for (let attempt = 1; !dryRun; attempt++) {
            try {
                await put(client, file.data, file.remote);
                break;
            } catch (error) {
                if (attempt >= 5) {
                    throw error;
                }
                console.log(`    ${error instanceof Error ? error.message : String(error)}: connecting again (attempt ${attempt + 1} of 5)…`);
                client.close();
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                await client.access(ftp);
            }
        }
        done += file.size;
    }
    console.log(`${dryRun ? 'Would upload' : 'Uploaded'} ${plan.length} files, ${kilobytes(done)} of ${kilobytes(total)}.`);
}

async function connect() {
    const client = new Client(60_000);
    console.log(`\nConnecting to ${ftp.user}@${ftp.host}:${ftp.port}${ftp.secure ? ' (FTPS)' : ' (plain FTP)'}…`);
    await client.access(ftp);
    return client;
}

async function fetchDeployed(url) {
    const auth = setting('CHECK_AUTH', '');
    const headers = auth ? { authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {};
    return fetch(url, { headers, cache: 'no-store' });
}

async function deployWeb() {
    if (!noBuild) {
        run('yarn', ['workspace', 'vueport-core', 'build']);
        run('yarn', ['workspace', 'vueport-web', 'build']);
    }
    const dist = path.join(root, 'packages', 'web', 'dist');
    const remoteRoot = setting('DIR');
    const files = (await filesIn(dist)).map(file => ({ ...file, remote: remoteJoin(remoteRoot, file.relative) }));
    const missing = missingFromIndex(files);
    if (missing.length > 0) {
        console.error(`\nindex.html names ${missing.join(', ')}, which ${dist} does not have: a build was running while it`
            + ' was read? Nothing was uploaded; run the deployment again once no build is running.');
        process.exit(1);
    }
    const directories = [...new Set(files.map(file => remoteParent(file.remote)))];
    const last = ['index.html', 'version.json'];

    const client = await connect();
    try {
        const remote = await remoteSizes(client, directories);
        const noted = JSON.parse(await download(client, remoteJoin(remoteRoot, MANIFEST)) ?? '{}');
        const changed = files.filter(file => remote.get(file.remote) !== file.size
            || !(HASHED.test(file.relative) || noted[file.relative] === file.sha256));
        const plan = [
            ...changed.filter(file => !last.includes(file.relative)),
            ...last.map(name => changed.find(file => file.relative === name)).filter(Boolean),
        ];
        console.log(`\nWeb build → ${remoteRoot}: ${files.length - changed.length} files already up, ${plan.length} to upload.`);
        const uploaded = await keepGuardingHtaccess(client, plan);
        await upload(client, uploaded);
        if (!dryRun) {
            const manifest = Object.fromEntries(files
                .filter(file => !plan.includes(file) || uploaded.includes(file))
                .map(file => [file.relative, file.sha256]));
            await client.uploadFrom(Readable.from([JSON.stringify(manifest)]), remoteJoin(remoteRoot, MANIFEST));
        }

        if (prune) {
            const wanted = new Set(files.map(file => file.remote));
            const stale = [...remote.keys()].filter(file =>
                !wanted.has(file) && HASHED.test(file) && !path.posix.basename(file).startsWith('.'));
            console.log(`\n${dryRun ? 'Would remove' : 'Removing'} ${stale.length} hashed files no build names any more.`);
            for (const file of stale) {
                console.log(`  ${file}`);
                if (!dryRun) {
                    await client.remove(file, true);
                }
            }
        }
    } finally {
        client.close();
    }

    if (!dryRun) {
        const url = setting('URL', 'https://play.vueport.net/');
        const local = JSON.parse(files.find(file => file.relative === 'version.json')?.data.toString('utf8') ?? '{}');
        const response = await fetchDeployed(new URL('version.json', url)).catch(error => error);
        if (response instanceof Error) {
            console.log(`\nCould not check ${url}: ${response.message}`);
        } else if (response.status === 401) {
            console.log(`\n${url} wants a password; set VUEPORT_WEB_CHECK_AUTH=user:password to check the deployment.`);
        } else {
            const deployed = await response.json().catch(() => ({}));
            console.log(deployed.build === local.build
                ? `\n${url} serves build ${local.build} (${local.version}).`
                : `\n${url} answers build ${deployed.build ?? '?'}, not ${local.build}; a cache in between, or the wrong directory?`);
        }
    }
}

async function deployServer() {
    const php = spawnSync('php', ['--version'], { stdio: 'ignore' });
    if (php.status === 0) {
        run('yarn', ['workspace', 'vueport-server', 'lint']);
    } else {
        console.log('\nNo php here, so the PHP files are uploaded unchecked (yarn workspace vueport-server lint needs it).');
    }
    const server = path.join(root, 'packages', 'server');
    const publicDir = setting('PUBLIC_DIR');
    const srcDir = remoteJoin(remoteParent(publicDir), 'src');
    const plan = [
        ...(await filesIn(path.join(server, 'src'))).map(file => ({ ...file, remote: remoteJoin(srcDir, file.relative) })),
        ...(await filesIn(path.join(server, 'public')))
            .filter(file => file.relative !== 'router.php')
            .map(file => ({ ...file, remote: remoteJoin(publicDir, file.relative) })),
    ];

    const client = await connect();
    try {
        console.log(`\nvueport-server → ${srcDir} and ${publicDir}:`);
        await upload(client, await keepGuardingHtaccess(client, plan));
    } finally {
        client.close();
    }

    if (!dryRun) {
        const url = new URL('lan-shares', setting('URL', 'https://api.vueport.net/'));
        const response = await fetchDeployed(url).catch(error => error);
        const body = response instanceof Error ? undefined : await response.json().catch(() => undefined);
        console.log(Array.isArray(body?.shares)
            ? `\n${url} answers as the new server does.`
            : `\n${url} did not answer as expected (${response instanceof Error ? response.message : response.status}).`);
    }
}

// The VB Color packages, on a host of their own (packages.vueport.net) rather than in the web build: the color editor
// fetches them (core's vb-color-package-file.ts). Each is named by its content, so only new ones go up and none is
// ever removed: an older build of the app still fetches the packages it was made with.
async function deployPackages() {
    const { prepareColorPackages, publishedColorPackages } = await import('../packages/core/scripts/color-packages.mjs');
    if (await prepareColorPackages({ check: true, log: () => undefined })) {
        console.error('\nThe packages in data/color-packages are not ready to publish (or their list is out of date):'
            + ' run node packages/core/scripts/color-packages.mjs first, and build the app with what it writes.');
        process.exit(1);
    }
    const remoteRoot = setting('DIR');
    const packages = (await publishedColorPackages()).map(pkg => ({
        relative: pkg.file, data: pkg.data, size: pkg.data.length, sha256: pkg.sha256, remote: remoteJoin(remoteRoot, pkg.file),
    }));
    const htaccess = await readFile(path.join(root, 'scripts', 'packages.htaccess'));
    const client = await connect();
    try {
        const remote = await remoteSizes(client, [...new Set(packages.map(file => remoteParent(file.remote)))]);
        const plan = packages.filter(file => remote.get(file.remote) !== file.size);
        plan.push({ relative: '.htaccess', data: htaccess, size: htaccess.length, remote: remoteJoin(remoteRoot, '.htaccess') });
        console.log(`\nVB Color packages → ${remoteRoot}: ${packages.length - plan.length + 1} already up, ${plan.length - 1} to upload.`);
        await upload(client, await keepGuardingHtaccess(client, plan));
    } finally {
        client.close();
    }

    if (!dryRun && packages.length > 0) {
        const sample = packages.reduce((small, file) => file.size < small.size ? file : small);
        const url = new URL(sample.relative, setting('URL', 'https://packages.vueport.net/'));
        const response = await fetchDeployed(url).catch(error => error);
        if (response instanceof Error || !response.ok) {
            console.log(`\n${url} did not answer (${response instanceof Error ? response.message : response.status}).`);
            return;
        }
        const data = Buffer.from(await response.arrayBuffer());
        const same = createHash('sha256').update(data).digest('hex') === sample.sha256;
        const cors = response.headers.get('access-control-allow-origin');
        console.log(same ? `\n${url} serves the package as published.` : `\n${url} serves other bytes than were published`
            + ` (${response.headers.get('content-encoding') ?? 'no'} content-encoding): compressed again on the way?`);
        if (cors !== '*') {
            console.log(`It answers without Access-Control-Allow-Origin: * (${cors ?? 'none'}), which the app and VUEngine Studio`
                + ' need: does the server apply the .htaccess (nginx serving static files directly)?');
        }
    }
}

try {
    await ({ web: deployWeb, server: deployServer, packages: deployPackages })[target]();
} catch (error) {
    console.error(`\nDeploying ${target} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
