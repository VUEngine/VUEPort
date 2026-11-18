/**
 * Asks the browser not to evict what VUEPort wrote. Everything (save states, cartridge RAM, library index, catalog
 * pictures, recent ROMs) lives in OPFS, which is best effort by default, and eviction takes the whole origin at once.
 * Safari also deletes script-written storage after seven days of use without visiting the site.
 *
 * On `navigator.storage.persist()`, Firefox asks the user with a doorhanger, Chrome and Edge decide silently from
 * engagement, and Safari grants sparingly (Home Screen web apps are exempt from the seven-day rule). Because of the
 * Firefox prompt, it is called only when something worth keeping first appears (a ROM opened, a folder added), not at
 * start-up. The desktop build has real files and skips all of this.
 */
import { isDesktop } from './desktop-bridge';

// remembered so Firefox is asked once rather than every session. Only a refusal is recorded (a grant is readable
// from `persisted()`), and it is cleared when the state changes underneath it
const ASKED = 'vueport.storage.persistAsked';

let settled: Promise<boolean> | undefined;

function asked(): boolean {
    try {
        return window.localStorage.getItem(ASKED) === 'true';
    } catch {
        // private browsing; there is no next session for this data either way
        return false;
    }
}

function rememberAsked(): void {
    try {
        window.localStorage.setItem(ASKED, 'true');
    } catch {
    }
}

// resolves whether the data is now protected; only the first call per session asks. Never throws; don't await it before
// the actual work, as the Firefox prompt waits for the user and a ROM should start regardless
export function ensureDurableStorage(): Promise<boolean> {
    return settled ??= request().catch(() => false);
}

async function request(): Promise<boolean> {
    if (isDesktop()) {
        return true;
    }
    const storage = navigator.storage;
    if (!storage?.persist || !storage.persisted) {
        // every engine has had this since 2021; older browsers' storage rules are not worth guessing at
        return false;
    }
    if (await storage.persisted()) {
        return true;
    }
    if (asked()) {
        // refused before: Chrome would silently refuse again, but Firefox would show the doorhanger every time
        return false;
    }
    rememberAsked();
    return storage.persist();
}

// for showing, not deciding
export async function isStorageDurable(): Promise<boolean> {
    try {
        return (await navigator.storage?.persisted?.()) ?? false;
    } catch {
        return false;
    }
}
