// stands in for packages.vueport.net in the probes: serves data/color-packages under the content-named file names the
// host uses (<name>-<sha256, 8 hex>.vbcpkg, see core's scripts/color-packages.mjs)
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COLOR_PACKAGES_URL = 'https://packages.vueport.net/';
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');

let published;
async function publishedPackages() {
    if (!published) {
        published = new Map();
        for (const name of await readdir(path.join(DATA, 'color-packages'))) {
            if (name.endsWith('.vbcpkg')) {
                const data = await readFile(path.join(DATA, 'color-packages', name));
                const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
                published.set(name.replace(/\.vbcpkg$/, `-${hash}.vbcpkg`), data);
            }
        }
    }
    return published;
}

// answers a puppeteer request to the packages host, returns false for requests elsewhere
export async function answerColorPackage(request) {
    const url = request.url();
    if (!url.startsWith(COLOR_PACKAGES_URL)) {
        return false;
    }
    const data = (await publishedPackages()).get(decodeURIComponent(url.slice(COLOR_PACKAGES_URL.length)));
    await request.respond(data
        ? { status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: data }
        : { status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    return true;
}

export function localColorPackage(databasePath) {
    return readFile(path.join(DATA, databasePath));
}
