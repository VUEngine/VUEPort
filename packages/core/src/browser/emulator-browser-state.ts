// structural rather than DOM Storage, so tests and hosts can provide the few operations needed
export interface browserStateStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export function browserStateKey(kind: string, romPath: string): string {
    return `vueport.${kind}-state.${encodeURIComponent(romPath)}`;
}

// short deterministic id (two 32-bit hashes plus the length) for a user-defined string stored elsewhere
export function browserStateId(value: string): string {
    let first = 0x811c9dc5;
    let second = 0x6d2b79f5;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x5bd1e995);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}`
        + `${(second >>> 0).toString(16).padStart(8, '0')}-${value.length}`;
}

// a damaged browser preference must not stop a ROM
export function readVesBrowserState<T>(
    storage: browserStateStorage | undefined,
    key: string,
): T | undefined {
    if (!storage) {
        return undefined;
    }
    try {
        const text = storage.getItem(key);
        return text === null ? undefined : JSON.parse(text) as T;
    } catch {
        return undefined;
    }
}

export function writeVesBrowserState(
    storage: browserStateStorage | undefined,
    key: string | undefined,
    value: object,
    empty: boolean, // removes the key rather than keeping one for every ROM that was merely opened
): boolean {
    if (!storage || !key) {
        return false;
    }
    try {
        if (empty) {
            storage.removeItem(key);
        } else {
            storage.setItem(key, JSON.stringify(value));
        }
        return true;
    } catch {
        // losing a remembered switch is not worth interrupting emulation
        return false;
    }
}
