import { bytesFrom, invoke, listen } from './desktop-bridge';

export interface OpenedRom {
    name: string;
    data: Uint8Array;
    path: string; // a path rather than bytes, so the save can be kept beside the ROM
}

// what the command line asked of this run (see launch.rs); each applies to this run only and changes no setting
export interface LaunchOptions {
    linked: boolean; // --linked: invite a second player as soon as a game runs
    fullscreen: boolean; // --fullscreen, already applied by the shell when the window was built
    quitOnClose: boolean; // --quit-on-close: closing the game quits instead of going back to the library
    // --continue: start the newest Recently Played game whatever the setting says; false when a ROM was named
    continue: boolean;
    // --hardcore / --softcore: RetroAchievements hardcore for this run, absent to leave the setting as it is
    hardcore?: boolean | null;
}

// asked separately, as the options are known before anything is opened
export async function launchOptions(): Promise<LaunchOptions> {
    return invoke<LaunchOptions>('launch_options');
}

// double-clicked or dropped on the icon, at start-up or later (macOS sends a second ROM to the running app as
// an event). The shell hands over paths and only reads back those it was given
export async function watchOpenedRoms(open: (rom: OpenedRom) => void): Promise<void> {
    const deliver = async (path: string): Promise<void> => {
        const data = await readOpenedFile(path);
        open({ name: path.split(/[\\/]/).pop() ?? path, data, path });
    };

    await listen('files://opened', payload => {
        if (typeof payload === 'string') {
            deliver(payload).catch(() => undefined);
        }
    });

    // anything the system handed over before the page was listening
    for (const path of await invoke<string[]>('opened_files')) {
        await deliver(path);
    }
}

// the shell only reads back paths it was handed, so this is not a way to read the disk. Used by Recently Played
// instead of a copy (see `web-recent-origins.ts`) and by `watchOpenedRoms`. Arrives as an `ArrayBuffer`, as a
// JSON number array for a 128 Mbit cartridge would be about 50 MB of text to parse
export async function readOpenedFile(path: string): Promise<Uint8Array> {
    return bytesFrom(await invoke<ArrayBuffer>('read_opened_file', { path }));
}

// after a restart the shell must be asked again for a ROM it opened in an earlier run; it agrees only for paths
// its record shows and that still exist. False means playing the kept copy, as before
export async function reopenFile(path: string): Promise<boolean> {
    return invoke<boolean>('reopen_file', { path }).catch(() => false);
}

// `relative` is a path the `.map` beside the ROM declared; the shell resolves it against the ROM's folder and
// its parent and refuses anything outside both. An `ArrayBuffer`, as a real `.elf` is tens of megabytes
export async function readRomBuildFile(rom: string, relative: string): Promise<Uint8Array> {
    return bytesFrom(await invoke<ArrayBuffer>('read_rom_build_file', { rom, relative }));
}

// the shell's drag and drop handler gets the drag, so no HTML `dragover` fires and the drop area would stay unlit
export async function watchDragging(over: (dragging: boolean) => void): Promise<() => void> {
    return listen('files://dragging', payload => over(payload === true));
}

// the system's open panel rather than a file input, which never says where the file is, so the save has no
// folder. The choice arrives through `watchOpenedRoms`; resolves to whether anything was chosen
export async function pickRomNatively(title: string, extensions: string[]): Promise<boolean> {
    return invoke<boolean>('pick_rom', { title, filter: extensions.join(',') });
}
