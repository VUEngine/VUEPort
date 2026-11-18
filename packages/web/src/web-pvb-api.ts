/**
 * Where Planet VB's ROM API is reached: web-planet-vb.ts looks up a ROM by checksum, web-homebrew.ts gets the featured
 * strip and the Homebrew Browser listings. Both default to vueport-server's relay (web-proxy.ts), the one shared exit
 * for every host, even though Planet VB sends `Access-Control-Allow-Origin: *`. Both bases are settable in the APIs
 * pane (web-api-bases.ts).
 */
import { gameInfoApiBase, homebrewApiBase } from './web-api-bases';

// followed by ?featured or a group id
export function homebrewApi(): string {
    return homebrewApiBase();
}

// followed by the ROM's CRC32
export function gameInfoApi(): string {
    return gameInfoApiBase();
}
