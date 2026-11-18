// the seam between the application and the desktop shell: where the desktop can do more (real files, a serial
// port), the difference stays in this module and the two hosts beside it. No `@tauri-apps/*` packages: the
// shell's commands (`packages/desktop/src-tauri/src`) need only the global it injects

type Invoke = (
    command: string,
    args?: Record<string, unknown> | ArrayBufferView,
    options?: { headers?: Record<string, string> },
) => Promise<unknown>;
type Listen = (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;

interface TauriWindow {
    title?: () => Promise<string>;
    setTheme?: (theme: 'light' | 'dark' | null) => Promise<void>;
    minimize?: () => Promise<void>;
    toggleMaximize?: () => Promise<void>;
    setFullscreen?: (fullscreen: boolean) => Promise<void>;
    isFullscreen?: () => Promise<boolean>;
}

interface TauriGlobal {
    core?: { invoke?: Invoke };
    event?: { listen?: Listen };
    window?: { getCurrentWindow?: () => TauriWindow };
}

function global(): TauriGlobal | undefined {
    return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
}

export function isDesktop(): boolean {
    return typeof global()?.core?.invoke === 'function';
}

// rejects without a shell, as every caller is desktop-only and a call in a browser is a wiring mistake
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const call = global()?.core?.invoke;
    if (!call) {
        throw new Error(`\`${command}\` needs the desktop shell, which is not here.`);
    }
    return await call(command, args) as T;
}

// the bytes are the whole payload, so they travel as the request body: Tauri turns a `Uint8Array` inside an
// argument object into a JSON number array (about 50 MB of text for a 128 Mbit cartridge, on the game's
// thread). Other arguments ride in percent-encoded headers, see `storage_write`
export async function invokeWithBytes<T>(
    command: string,
    bytes: Uint8Array,
    headers: Record<string, string> = {},
): Promise<T> {
    const call = global()?.core?.invoke;
    if (!call) {
        throw new Error(`\`${command}\` needs the desktop shell, which is not here.`);
    }
    const encoded = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, encodeURIComponent(value)]));
    return await call(command, bytes, { headers: encoded }) as T;
}

// such commands answer with an `ArrayBuffer` rather than Tauri's JSON number array; other shapes are accepted
// so a webview decoding it differently still plays the game
export function bytesFrom(answer: ArrayBuffer | Uint8Array | number[]): Uint8Array {
    if (answer instanceof Uint8Array) {
        return answer;
    }
    return answer instanceof ArrayBuffer ? new Uint8Array(answer) : Uint8Array.from(answer);
}

// resolves to the unsubscribe
export async function listen(
    event: string,
    handler: (payload: unknown) => void,
): Promise<() => void> {
    const subscribe = global()?.event?.listen;
    if (!subscribe) {
        return () => undefined;
    }
    return subscribe(event, message => handler(message.payload));
}

// does nothing in a browser. Through the shell's own command rather than Tauri's `setTitle`, as on macOS a
// rename re-lays the title bar and moves the window buttons out of the page's strip (see `src-tauri/src/titlebar.rs`)
export async function setWindowTitle(title: string): Promise<void> {
    if (!isDesktop()) {
        return;
    }
    await invoke('window_title', { title });
}

// the title bar, scrollbars and native menus are drawn by the system, so the window needs the mode too; null
// follows the system. Does nothing in a browser
export async function setWindowTheme(theme: 'light' | 'dark' | null): Promise<void> {
    const current = global()?.window?.getCurrentWindow?.();
    if (!current?.setTheme) {
        return;
    }
    await current.setTheme(theme);
}

export async function windowTitle(): Promise<string | undefined> {
    const current = global()?.window?.getCurrentWindow?.();
    return current?.title ? current.title() : undefined;
}

// `overlay` is macOS (the system keeps its traffic lights, the page stays clear of them), `custom` everywhere
// else (frameless, the page draws all three), `none` a browser. Asked of the shell, which decides (see `main.rs`)
export type WindowChrome = 'overlay' | 'custom' | 'none';

export async function windowChrome(): Promise<WindowChrome> {
    if (!isDesktop()) {
        return 'none';
    }
    try {
        const chrome = await invoke<string>('window_chrome');
        return chrome === 'overlay' || chrome === 'custom' ? chrome : 'none';
    } catch {
        // better no controls than a set that does nothing
        return 'none';
    }
}

// the two the page draws where the frame is off; silent in a browser
export async function minimizeWindow(): Promise<void> {
    await global()?.window?.getCurrentWindow?.()?.minimize?.();
}

export async function toggleMaximizeWindow(): Promise<void> {
    await global()?.window?.getCurrentWindow?.()?.toggleMaximize?.();
}

// the window itself, via the system like macOS's green button: the Fullscreen Web API only fills the webview,
// which on some platforms already is the whole window, so nothing changed. Does nothing in a browser
export async function setWindowFullscreen(fullscreen: boolean): Promise<void> {
    await global()?.window?.getCurrentWindow?.()?.setFullscreen?.(fullscreen);
}

export async function isWindowFullscreen(): Promise<boolean> {
    return (await global()?.window?.getCurrentWindow?.()?.isFullscreen?.()) ?? false;
}

// however it happened, including macOS's green button, which the page never sees a click for. Resolves to the
// unsubscribe; never fires in a browser
export async function onWindowFullscreenChange(
    handler: (fullscreen: boolean) => void,
): Promise<() => void> {
    return listen('window://fullscreen', payload => handler(payload === true));
}

// like the window's close button, not `close()`: the shell keeps the window open until the saves are on disk
// (see `shutdown.rs` and the `app://close-requested` listener in `main.tsx`)
export async function requestQuit(): Promise<void> {
    await invoke('request_quit');
}
