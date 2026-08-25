/**
 * What the emulator needs from whatever it is running inside.
 *
 * Two things only: somewhere to keep files, and somewhere to say things to the
 * person using it. Everything else the emulator does — running the machine,
 * decoding its memory, drawing its screen — it does itself.
 *
 * Paths are opaque strings rather than URIs, because what a path means is the
 * host's business: a workspace-relative file in VES, a key in the
 * browser's origin-private filesystem on the web, a real path in a native
 * wrapper. The emulator only ever composes them out of `parent`, `stem` and
 * `join`, so a host that stores files under some other scheme only has to be
 * self-consistent.
 */

/** One entry of a directory listing. */
export interface VueportFile {
    /** Full path, in whatever form the storage understands. */
    path: string;
    /** The last segment of the path, extension included. */
    name: string;
    size: number;
}

/**
 * Files the emulator keeps beside a ROM: save RAM, save states, cheats, and the
 * audio an ESSound cartridge plays.
 */
export interface VueportStorage {
    read(path: string): Promise<Uint8Array>;
    readText(path: string): Promise<string>;
    write(path: string, data: Uint8Array): Promise<void>;
    writeText(path: string, text: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    delete(path: string): Promise<void>;
    /** The files in a directory. Empty when there is no such directory. */
    list(directory: string): Promise<VueportFile[]>;

    /** The directory containing `path`. */
    parent(path: string): string;
    /** The last segment of `path`, without its extension. */
    stem(path: string): string;
    /** The last segment of `path`, extension included. */
    name(path: string): string;
    join(directory: string, name: string): string;

    /**
     * Hand a finished file to the person using the emulator — a screenshot, a
     * profile. Separate from `write` because this is not a file the emulator
     * will read back: in VES it lands in the project, and on the web it
     * is a download.
     */
    export(name: string, data: Uint8Array): Promise<void>;
}

/** A long operation the person should be told is running. */
export interface VueportProgress {
    cancel(): void;
}

/** Telling the person something, and asking them something. */
export interface VueportNotifications {
    info(text: string): void;
    warn(text: string): void;
    error(text: string): void;
    /**
     * Resolves true if they agreed.
     *
     * `message` may be several paragraphs, which the host lays out however it
     * lays out paragraphs — the emulator does not build DOM for it, so that this
     * works in a host that has none.
     */
    confirm(options: {
        title: string,
        message: string | string[],
        okLabel?: string,
    }): Promise<boolean>;
    progress(text: string): Promise<VueportProgress>;
}

/** Everything a host provides, as one thing to pass around. */
export interface VueportHost {
    readonly storage: VueportStorage;
    readonly notifications: VueportNotifications;
}
