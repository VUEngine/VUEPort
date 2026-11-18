/**
 * Planet VB releases for `Library.importReleases`, each able to fetch itself: the downloads group's detail names the
 * file, which is fetched directly (Planet VB's file host sends `Access-Control-Allow-Origin: *`). Archives are unpacked
 * here, as a plain `.zip` in a library folder is only looked into with archives switched on. Only the ROMs come out,
 * under their own names; readmes, manuals and ESSound tracks stay behind.
 */
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { HomebrewGame, HomebrewRom, homebrewRomUrl } from './web-homebrew';
import { LibraryRelease } from './web-library';
import { fetchRom } from './web-rom-url';
import { MAX_ROM_BYTES, isRom } from './web-rom-source';
import { listZipEntries, looksLikeZip, readZipEntry } from './web-zip';

// a game whose listing named no downloads group still has one, the game's own id
export function releasesOf(game: HomebrewGame): HomebrewRom[] {
    return game.roms.length > 0
        ? game.roms
        : [{ id: game.id, title: game.title, latest: true }];
}

export function homebrewRelease(game: HomebrewGame, rom: HomebrewRom): LibraryRelease {
    // "Demo" alone is no use in a failure message
    const title = rom.title.toLowerCase().includes(game.title.toLowerCase())
        ? rom.title
        : `${game.title} — ${rom.title}`;
    return {
        id: rom.id,
        title,
        fetch: async signal => {
            const url = await homebrewRomUrl(rom);
            if (!url) {
                throw new Error(nls.localize('vueport/library/noDownload',
                    'Planet VB names no download for {0}.', title));
            }
            const { name, data } = await fetchRom(new URL(url), signal);
            return romsIn(name, data, game.title);
        },
    };
}

export function homebrewReleases(games: readonly HomebrewGame[]): LibraryRelease[] {
    return games.flatMap(game => releasesOf(game).map(rom => homebrewRelease(game, rom)));
}

async function romsIn(
    name: string,
    data: Uint8Array,
    gameTitle: string,
): Promise<{ name: string, data: Uint8Array }[]> {
    if (!looksLikeZip(data)) {
        if (!plausibleRom(data)) {
            throw new Error(nls.localize('vueport/library/notARomDownload',
                '{0} is not a Virtual Boy ROM.', name));
        }
        // a download address need not end in the file's name (some answer from a script), and the scan goes by
        // extension
        return [{ name: isRom(name) ? name : `${safeName(gameTitle)}.vb`, data }];
    }
    const roms: { name: string, data: Uint8Array }[] = [];
    for (const entry of listZipEntries(data)) {
        const base = entry.name.split('/').pop() ?? entry.name;
        // macOS's `__MACOSX/._Game.vb` resource forks look like ROMs by name
        if (!isRom(base) || base.startsWith('.') || entry.name.startsWith('__MACOSX/')
            || entry.encrypted || entry.size > MAX_ROM_BYTES) {
            continue;
        }
        const rom = await readZipEntry(data, entry);
        if (plausibleRom(rom)) {
            roms.push({ name: base, data: rom });
        }
    }
    if (roms.length === 0) {
        throw new Error(nls.localize('vueport/rom/noRomInArchive', 'That archive holds no ROM.'));
    }
    return roms;
}

// the core needs a power of two within the console's address space, which also catches an error page that answered
// `200`
function plausibleRom(data: Uint8Array): boolean {
    const size = data.byteLength;
    return size > 0 && size <= MAX_ROM_BYTES && (size & (size - 1)) === 0;
}

function safeName(title: string): string {
    return title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'ROM';
}
