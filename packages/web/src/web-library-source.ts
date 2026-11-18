// a browser has a handle that may need permission again, the desktop a real path. web-library-browser-source.ts and
// desktop-library.ts implement it
import { LibraryFile, LibraryFolder } from './web-library-types';
import { ScanCandidate } from './web-library-scan';

// prompt is the browser after a restart: the handle is there, the permission is not, and one click gets it back.
// missing means no way back at all: cleared site data, another profile, an unmounted disk
export type LibraryAccess = 'granted' | 'prompt' | 'denied' | 'missing';

// only the imported source reports any, as copying hundreds of cartridges takes a while
export interface AdoptProgress {
    files: number;
    total: number;
    current?: string;
}

export interface PickedFolder {
    name: string;
    location?: string; // known on the desktop, not in a browser
    // keeps what this host needs to reach the folder again under its new id: the browser stores the handle in
    // IndexedDB, the desktop shell already wrote down the path. An imported folder copies its ROMs here, hence
    // onProgress
    adopt(id: string, onProgress?: (progress: AdoptProgress) => void): Promise<void>;
}

export interface LibrarySource {
    canAdd(): boolean;
    // undefined when the picker was closed
    pick(): Promise<PickedFolder | undefined>;
    // without prompting
    access(folder: LibraryFolder): Promise<LibraryAccess>;
    // click only
    grant(folder: LibraryFolder): Promise<LibraryAccess>;
    forget(folder: LibraryFolder): Promise<void>;
    candidates(folder: LibraryFolder, options: {
        subfolders: boolean,
        extensions: string[],
    }): AsyncIterable<ScanCandidate>;
    read(folder: LibraryFolder, file: LibraryFile): Promise<Uint8Array>;
    // a path the emulator can keep its save beside; only the desktop answers, a browser is never told and an imported
    // folder is the app's own storage
    locate?(folder: LibraryFolder, file: LibraryFile): Promise<string | undefined>;
}
