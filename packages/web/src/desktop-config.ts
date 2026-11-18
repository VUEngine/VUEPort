import { invoke } from './desktop-bridge';

const PREFIX = 'vueport.';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Config = Record<string, Json>;

let installed = false;
let writes: Promise<void> = Promise.resolve();

function appKey(storageKey: string): string | undefined {
    return storageKey.startsWith(PREFIX) ? storageKey.slice(PREFIX.length) : undefined;
}

function decode(value: string): Json {
    try {
        return JSON.parse(value) as Json;
    } catch {
        return value;
    }
}

function encode(value: Json): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function snapshot(storage: Storage): Config {
    const config: Config = {};
    for (let index = 0; index < storage.length; index++) {
        const storageKey = storage.key(index);
        if (storageKey === null) {
            continue;
        }
        const key = appKey(storageKey);
        if (key === undefined) {
            continue;
        }
        const value = storage.getItem(storageKey);
        if (value !== null) {
            config[key] = decode(value);
        }
    }
    return config;
}

function enqueue(command: string, args: Record<string, unknown>): void {
    writes = writes
        .then(() => invoke<void>(command, args))
        .catch(error => {
            // the preference is still alive in the runtime cache, so the failed durable write does not interrupt emulation
            console.warn(`Could not update desktop config.json: ${String(error)}`);
        });
}

// makes ~/.vueport/config.json the desktop's durable preferences: loaded into the synchronous localStorage cache
// before any setting is read, then written through to the native shell. The browser build does not import this
export async function installDesktopConfig(): Promise<void> {
    if (installed) {
        return;
    }

    const storage = window.localStorage;
    const prototype = Object.getPrototypeOf(storage) as Storage;
    const setItem = prototype.setItem;
    const removeItem = prototype.removeItem;
    const clear = prototype.clear;

    try {
        // the file is authoritative; a missing one is a first launch (the shell creates it on the first change).
        // Stale application entries are removed, unrelated origin data is left alone
        const config = await invoke<Config | null>('config_read') ?? {};
        const stale: string[] = [];
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (key?.startsWith(PREFIX)) {
                stale.push(key);
            }
        }
        stale.forEach(key => removeItem.call(storage, key));
        Object.entries(config).forEach(([key, value]) => {
            setItem.call(storage, `${PREFIX}${key}`, encode(value));
        });
    } catch (error) {
        // a hand-edited file may be malformed or the disk temporarily unavailable; the current cache remains
        console.warn(`Could not load desktop config.json: ${String(error)}`);
    }

    prototype.setItem = function (key: string, value: string): void {
        setItem.call(this, key, value);
        const configKey = this === storage ? appKey(key) : undefined;
        if (configKey !== undefined) {
            enqueue('config_set', { key: configKey, value: decode(value) });
        }
    };
    prototype.removeItem = function (key: string): void {
        removeItem.call(this, key);
        const configKey = this === storage ? appKey(key) : undefined;
        if (configKey !== undefined) {
            enqueue('config_remove', { key: configKey });
        }
    };
    prototype.clear = function (): void {
        clear.call(this);
        if (this === storage) {
            enqueue('config_write', { config: snapshot(storage) });
        }
    };
    installed = true;
}

export async function flushDesktopConfig(): Promise<void> {
    await writes;
}
