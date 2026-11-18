/**
 * What the emulator needs from whatever it is running inside: somewhere to keep files, and somewhere to talk to the
 * user. Paths are opaque strings, as their meaning is the host's business (workspace-relative in VES, an OPFS key on
 * the web, a real path in a native wrapper); the emulator only composes them with parent, stem and join.
 */

export interface VueportFile {
    path: string;
    name: string;
    size: number;
}

export interface VueportUsage {
    bytes: number;
    files: number;
}

export interface VueportStorage {
    read(path: string): Promise<Uint8Array>;
    readText(path: string): Promise<string>;
    write(path: string, data: Uint8Array): Promise<void>;
    writeText(path: string, text: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    delete(path: string): Promise<void>; // deletes a directory with its contents; a missing path is a no-op
    list(directory: string): Promise<VueportFile[]>; // empty for a missing directory
    // zero for a missing directory. Optional, but without it usage can only be measured one level deep through list
    measure?(directory: string): Promise<VueportUsage>;

    parent(path: string): string;
    stem(path: string): string;
    name(path: string): string;
    join(directory: string, name: string): string;

    // for files the emulator won't read back (a screenshot, a profile): in VES they land in the project, on the web
    // they are downloads
    export(name: string, data: Uint8Array): Promise<void>;

    // avoids the two in-memory copies export would make of a large Blob such as a video; callers fall back to export
    exportBlob?(name: string, blob: Blob): Promise<void>;
}

export interface VueportProgress {
    cancel(): void;
}

export interface VueportNotifications {
    info(text: string): void;
    warn(text: string): void;
    error(text: string): void;
    confirm(options: {
        title: string,
        message: string | string[], // several paragraphs are laid out by the host, as the emulator builds no DOM
        okLabel?: string,
    }): Promise<boolean>;
    progress(text: string): Promise<VueportProgress>;
}

export interface VueportHost {
    readonly storage: VueportStorage;
    readonly notifications: VueportNotifications;
}
