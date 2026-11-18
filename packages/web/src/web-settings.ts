import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { VUEPORT_DEFAULTS, VueportConfig, VueportSettings } from 'vueport-core/lib/common/emulator-settings';

const STORAGE_KEY = 'vueport.settings';

// a browser keeps the settings in `localStorage`, the desktop uses that as a synchronous cache of its `config.json`.
// Synchronous since values are small and read while the first frame is set up
export class WebSettings implements VueportSettings {

    // shown fixed with the reason beside them (see `SettingsPaneProps.readOnly`)
    readonly fixed: Partial<Record<keyof VueportConfig, string>>;

    readonly defaults: Partial<VueportConfig>;

    protected readonly onDidChangeEmitter = new Emitter<keyof VueportConfig>();
    readonly onDidChange: Event<keyof VueportConfig> = this.onDidChangeEmitter.event;
    readonly ready: Promise<void> = Promise.resolve();

    protected readonly values: VueportConfig;

    // for this run only, from a launch option such as --hardcore: read instead of the stored value until the user sets
    // it, never written
    protected readonly session: Partial<VueportConfig> = {};

    // `defaults` is where this build differs from the emulator's own, `fixed` what the user may not change, with the
    // reason. A browser only passes the one setting it has no choice about
    constructor(
        defaults: Partial<VueportConfig> = {},
        fixed: Partial<Record<keyof VueportConfig, string>> = {},
    ) {
        this.fixed = fixed;
        this.defaults = defaults;
        // fixed last, as a stored value from a build that allowed it must not outrank what this build settled
        this.values = {
            ...VUEPORT_DEFAULTS, ...defaults, ...this.load(),
            ...pickFixed(defaults, fixed),
        };
    }

    protected load(): Partial<VueportConfig> {
        let stored: unknown;
        try {
            stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
        } catch {
            // corrupt or unreadable: the defaults are better than failing to start
            return {};
        }
        if (typeof stored !== 'object' || stored === null) {
            return {};
        }
        const known = Object.keys(VUEPORT_DEFAULTS) as (keyof VueportConfig)[];
        const result: Partial<VueportConfig> = {};
        for (const key of known) {
            const value = (stored as Record<string, unknown>)[key];
            if (value !== undefined) {
                (result as Record<string, unknown>)[key] = value;
            }
        }
        return result;
    }

    get<K extends keyof VueportConfig>(key: K): VueportConfig[K] {
        return key in this.session ? this.session[key] as VueportConfig[K] : this.values[key];
    }

    // refused for a fixed setting, as `set` is
    holdForSession<K extends keyof VueportConfig>(key: K, value: VueportConfig[K]): void {
        if (this.fixed[key] !== undefined || this.get(key) === value) {
            return;
        }
        this.session[key] = value;
        this.onDidChangeEmitter.fire(key);
    }

    async set<K extends keyof VueportConfig>(key: K, value: VueportConfig[K]): Promise<void> {
        if (this.fixed[key] !== undefined) {
            // the window disables these, so refuse quietly
            return;
        }
        this.values[key] = value;
        // a choice made now outranks the command line
        delete this.session[key];
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
        } catch {
            // private browsing or a full quota; the value still applies to this session
        }
        this.onDidChangeEmitter.fire(key);
    }
}

function pickFixed(
    defaults: Partial<VueportConfig>,
    fixed: Partial<Record<keyof VueportConfig, string>>,
): Partial<VueportConfig> {
    const held: Partial<VueportConfig> = {};
    for (const key of Object.keys(fixed) as (keyof VueportConfig)[]) {
        const value = defaults[key] ?? VUEPORT_DEFAULTS[key];
        (held as Record<string, unknown>)[key] = value;
    }
    return held;
}
