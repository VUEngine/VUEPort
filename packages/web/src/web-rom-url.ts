// `?rom=<address>` makes a link to a particular game work (a homebrew release, a bug report). Standalone build only;
// the studio's ROM comes from the project

import { nls } from 'vueport-core/lib/common/emulator-nls';

// messages are meant for the user
export class RomUrlError extends Error { }

// resolved against the page so a relative address works, then held to http(s), as other schemes are meaningless here or
// smuggle something that is not a download (`javascript:` most of all)
function addressIn(location: string, name: string): URL | undefined {
    const parameter = new URL(location).searchParams.get(name);
    if (!parameter) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(parameter, location);
    } catch {
        throw new RomUrlError(nls.localize('vueport/url/notAnAddress',
            '"{0}" is not an address.', parameter));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new RomUrlError(nls.localize('vueport/url/badScheme',
            '{0} addresses cannot be opened, only http and https.', url.protocol));
    }
    return url;
}

export function romUrlFrom(location: string): URL | undefined {
    return addressIn(location, 'rom');
}

// a save state to continue from, as a desktop's LAN share puts it
export function stateUrlFrom(location: string): URL | undefined {
    return addressIn(location, 'state');
}

// the start page's "from a link" field; an empty field is undefined, not an error
export function parseRomUrl(raw: string): URL | undefined {
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new RomUrlError(nls.localize('vueport/url/notAnAddress',
            '"{0}" is not an address.', trimmed));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new RomUrlError(nls.localize('vueport/url/badScheme',
            '{0} addresses cannot be opened, only http and https.', url.protocol));
    }
    return url;
}

// a URL ending in a slash or all query string gets a fallback name, as it is only used for the title and the save
// folder
export function romNameFrom(url: URL): string {
    const last = url.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'rom.vb';
}

// as bytes, as it may be an archive; romFrom knows what a ROM has to look like once unpacked
export async function fetchRom(url: URL, signal?: AbortSignal): Promise<{ name: string, data: Uint8Array }> {
    let response: Response;
    try {
        response = await fetch(url.href, { signal, redirect: 'follow' });
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        // a cross-origin address that does not allow this page fails here, deliberately indistinguishable from
        // unreachable
        throw new RomUrlError(nls.localize('vueport/url/unreachable',
            '{0} could not be reached. If it is on another site, that site has to allow it (CORS).',
            url.href));
    }
    if (!response.ok) {
        throw new RomUrlError(nls.localize('vueport/url/badStatus',
            '{0} answered {1} {2}.', url.href, response.status, response.statusText));
    }

    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0) {
        throw new RomUrlError(nls.localize('vueport/url/empty', '{0} answered with nothing.', url.href));
    }
    return { name: romNameFrom(url), data };
}
