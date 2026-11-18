// dorequest.php sends no Access-Control-Allow-Origin, so every host (web and desktop webview) goes through
// vueport-server's relay; web-proxy.ts and packages/server/src/ra_proxy.php agree on the call's shape

import {
    RetroAchievementsCredentials,
    RetroAchievementsTransport,
} from 'vueport-core/lib/browser/emulator-retroachievements';
import { RA_PROXY_URL } from './web-proxy';

const STORAGE_KEY = 'vueport.retroachievements';

export class WebRetroAchievementsTransport implements RetroAchievementsTransport {

    // every host goes through the relay; a relay that is down fails like any network call, which login and the
    // achievement engine already handle
    get available(): boolean {
        return true;
    }

    async request(
        method: 'GET' | 'POST',
        url: string,
        body: string | undefined,
        contentType: string | undefined,
    ): Promise<{ status: number, body: string }> {
        const response = await fetch(RA_PROXY_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, url, body, contentType }),
        });
        if (!response.ok) {
            throw new Error(`The RetroAchievements relay answered ${response.status}.`);
        }
        return response.json() as Promise<{ status: number, body: string }>;
    }
}

// username and API token, in localStorage or the desktop's file-backed cache; never the password, which only goes to
// RetroAchievements itself
export class WebRetroAchievementsCredentials implements RetroAchievementsCredentials {

    async load(): Promise<{ username: string, token: string } | undefined> {
        try {
            const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as
                { username?: string, token?: string } | null;
            if (stored?.username && stored.token) {
                return { username: stored.username, token: stored.token };
            }
        } catch {
            // corrupt or unreadable: treated as never logged in
        }
        return undefined;
    }

    async save(credentials: { username: string, token: string }): Promise<void> {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
        } catch {
            // private browsing or a full quota: the session stays logged in, only remembering it fails
        }
    }

    async clear(): Promise<void> {
        try {
            window.localStorage.removeItem(STORAGE_KEY);
        } catch {
        }
    }
}
