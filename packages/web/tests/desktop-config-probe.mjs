// the desktop preference bridge without launching Tauri: config.json wins at startup, a missing one leaves no stale
// preferences behind, and later localStorage mutations are written through to the shell
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const scratch = await mkdtemp(path.join(tmpdir(), 'vueport-config-'));
const bundle = path.join(scratch, 'desktop-config.mjs');
await esbuild.build({
    entryPoints: [new URL('../src/desktop-config.ts', import.meta.url).pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: bundle,
});

let failures = 0;
const check = (label, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) {
        failures++;
    }
};

class MemoryStorage {
    values = new Map();

    get length() { return this.values.size; }
    key(index) { return [...this.values.keys()][index] ?? null; }
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
    clear() { this.values.clear(); }
}

async function load(caseName, config, initial = {}) {
    const storage = new MemoryStorage();
    Object.entries(initial).forEach(([key, value]) => storage.setItem(key, value));
    const calls = [];
    globalThis.window = {
        localStorage: storage,
        __TAURI__: { core: { invoke: async (command, args) => {
            calls.push({ command, args });
            return command === 'config_read' ? config : undefined;
        } } },
    };
    const module = await import(`${pathToFileURL(bundle)}?case=${caseName}`);
    await module.installDesktopConfig();
    return { storage, calls };
}

console.log('\nDesktop config bridge');

const restored = await load('restore', {
    theme: 'dark',
    settings: { audio: true },
    maxRecent: 12,
}, {
    'vueport.theme': 'light',
    'vueport.stale': 'old',
    unrelated: 'kept',
});
check('config.json replaces stale Vueport cache values',
    restored.storage.getItem('vueport.theme') === 'dark'
    && restored.storage.getItem('vueport.stale') === null
    && restored.storage.getItem('vueport.settings') === '{"audio":true}'
    && restored.storage.getItem('vueport.maxRecent') === '12');
check('unrelated origin storage survives hydration',
    restored.storage.getItem('unrelated') === 'kept');

restored.storage.setItem('vueport.settings', '{"audio":false}');
restored.storage.removeItem('vueport.theme');
restored.storage.setItem('unrelated', 'changed');
await new Promise(resolve => setTimeout(resolve, 0));
check('setting changes are decoded and written through', restored.calls.some(call =>
    call.command === 'config_set'
    && call.args.key === 'settings'
    && call.args.value.audio === false));
check('removals are written through', restored.calls.some(call =>
    call.command === 'config_remove' && call.args.key === 'theme'));
check('unrelated changes are not added to config.json', !restored.calls.some(call =>
    call.command === 'config_set' && call.args.key === 'unrelated'));

const fresh = await load('fresh', null, {
    'vueport.language': 'de',
    unrelated: 'kept',
});
check('a missing config.json starts from no preferences',
    fresh.storage.getItem('vueport.language') === null
    && fresh.storage.getItem('unrelated') === 'kept');
check('and writes nothing until something changes',
    !fresh.calls.some(call => call.command === 'config_write'));

if (failures) {
    console.error(`\n${failures} desktop config check(s) failed.`);
    process.exit(1);
}
console.log('\nDesktop config checks passed.');
