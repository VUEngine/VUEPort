#!/usr/bin/env node
/**
 * Fetches the controller profiles users shared from the Game Pads settings, for review. This is the other half of
 * packages/server/src/gamepad_profiles.php: it writes each waiting profile out as the file it would be bundled as and
 * prints who wrote it. To bundle one, move the file into src/data/gamepad-profiles/ and list it in
 * BUNDLED_GAMEPAD_PROFILES. --delete takes a profile off the server's queue, bundled or not.
 *
 *   VUEPORT_REVIEW_TOKEN=… node packages/core/scripts/fetch-gamepad-submissions.mjs
 *   VUEPORT_REVIEW_TOKEN=… node packages/core/scripts/fetch-gamepad-submissions.mjs --delete <name>…
 *
 * Options:
 *   --server <url>   where vueport-server is (default: https://api.vueport.net)
 *   --out <dir>      where to write the profiles (default: ./gamepad-submissions)
 *   --token <token>  instead of VUEPORT_REVIEW_TOKEN
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = name => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const SERVER = (opt('server') ?? 'https://api.vueport.net').replace(/\/+$/, '');
const OUT = path.resolve(opt('out') ?? 'gamepad-submissions');
const TOKEN = opt('token') ?? process.env.VUEPORT_REVIEW_TOKEN;
const deleteAt = args.indexOf('--delete');
const TO_DELETE = deleteAt >= 0 ? args.slice(deleteAt + 1) : undefined;

if (!TOKEN) {
    console.error('Needs the review token: VUEPORT_REVIEW_TOKEN=… or --token …');
    process.exit(1);
}
const headers = { 'x-review-token': TOKEN };

async function main() {
    if (TO_DELETE) {
        for (const name of TO_DELETE) {
            const response = await fetch(`${SERVER}/gamepad-profiles/${encodeURIComponent(name)}`, {
                method: 'DELETE', headers,
            });
            console.log(`  ${response.status === 204 ? 'deleted' : `failed (${response.status})`}  ${name}`);
        }
        return;
    }

    const response = await fetch(`${SERVER}/gamepad-profiles`, { headers });
    if (response.status === 404) {
        // the server answers a wrong token exactly like a missing route, on purpose, so this cannot tell them apart
        console.error('Not found: either the token is wrong or the server has no review token set.');
        process.exit(1);
    }
    if (!response.ok) {
        console.error(`${response.status} ${response.statusText}`);
        process.exit(1);
    }
    const { submissions } = await response.json();
    if (submissions.length === 0) {
        console.log('Nothing waiting.');
        return;
    }
    await mkdir(OUT, { recursive: true });
    for (const { name, receivedAt, note, profile } of submissions) {
        await writeFile(path.join(OUT, name), JSON.stringify(profile, undefined, 4) + '\n');
        const { match } = profile;
        console.log(`\n${name}  (${receivedAt})`);
        console.log(`  ${profile.name} · ${match.device ?? match.name} · ${match.engine ?? 'any engine'} on ${match.platform ?? 'any system'}`
            + ` · ${match.mapping || 'raw'} · ${match.buttons ?? '?'} buttons, ${match.axes ?? '?'} axes`);
        if (note) {
            console.log(`  note: ${note}`);
        }
    }
    console.log(`\n${submissions.length} written to ${OUT}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
