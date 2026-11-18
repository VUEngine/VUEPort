/**
 * The empty box shown for a game without a picture: six faces of a blank Virtual Boy box. Several sets ship, as boxes
 * differed per region, chosen in the library settings; the user can make an own set face by face, with missing faces
 * from the standard set. Module state, as every cover draws the front without a library to ask. The choice is kept
 * like the library's other switches (web-library-settings.ts), own pictures in library storage beside assigned covers,
 * as a browser can't reopen a file it was handed once.
 */
import * as React from 'react';
import { Emitter, Event } from 'vueport-core/lib/common/emulator-events';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { VueportStorage } from 'vueport-core/lib/common/emulator-host';
import { BOX_FACES, BoxFace, LibraryPicture } from './web-library-types';

// share of the picture left free on each edge, in percent
export interface EmptyBoxArea {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface EmptyBoxAreas {
    side: EmptyBoxArea; // where the coverflow prints a game's title, the free stretch below the side's label
    back: EmptyBoxArea; // where it prints the game's facts, the empty back panel
}

export interface EmptyBoxSet {
    id: string;
    label(): string; // a function, as the sets are listed at module load, before translations
    url(face: BoxFace): string; // served from `public/empty-box/`
    areas: EmptyBoxAreas;
}

export const EMPTY_BOX_SETS: ReadonlyArray<EmptyBoxSet> = [
    {
        id: 'jpn',
        label: () => nls.localize('vueport/library/emptyBox/jpn', 'Japan'),
        url: face => `/empty-box/jpn/empty-box-jpn-${face}.webp`,
        areas: {
            side: { top: 25, right: 8, bottom: 3, left: 8 },
            back: { top: 3.1, right: 3.9, bottom: 41.2, left: 4.7 },
        },
    },
];

export const CUSTOM_EMPTY_BOX = 'custom';

export const DEFAULT_EMPTY_BOX = 'jpn';

const SETTING = 'vueport.library.emptyBox';
// lists which faces of the own set exist
const CUSTOM_INDEX = 'library/empty-box.json';
export const CUSTOM_DIR = 'library/empty-box';

const onDidChangeEmitter = new Emitter<void>();
export const onDidChangeEmptyBox: Event<void> = onDidChangeEmitter.event;

const standard = (): EmptyBoxSet => EMPTY_BOX_SETS.find(set => set.id === DEFAULT_EMPTY_BOX) ?? EMPTY_BOX_SETS[0];

// a shipped set's id, or CUSTOM_EMPTY_BOX
export function emptyBoxSet(): string {
    let stored: string | null = null;
    try {
        stored = window.localStorage.getItem(SETTING);
    } catch {
        // private browsing: nothing remembered, the default holds
    }
    return stored === CUSTOM_EMPTY_BOX || EMPTY_BOX_SETS.some(set => set.id === stored)
        ? stored!
        : DEFAULT_EMPTY_BOX;
}

export function setEmptyBoxSet(id: string): void {
    if (id === emptyBoxSet()) {
        return;
    }
    try {
        if (id === DEFAULT_EMPTY_BOX) {
            // nothing stored for the default, so a new default reaches whoever never chose
            window.localStorage.removeItem(SETTING);
        } else {
            window.localStorage.setItem(SETTING, id);
        }
    } catch {
        // holds for this session only
    }
    onDidChangeEmitter.fire();
}

export function emptyBoxUrl(face: BoxFace): string {
    const chosen = emptyBoxSet();
    if (chosen === CUSTOM_EMPTY_BOX) {
        return custom.urls.get(face) ?? standard().url(face);
    }
    return (EMPTY_BOX_SETS.find(set => set.id === chosen) ?? standard()).url(face);
}

// an own set is lettered where the standard one is, as missing faces are the standard's and it is drawn over
export function emptyBoxAreas(): EmptyBoxAreas {
    return (EMPTY_BOX_SETS.find(set => set.id === emptyBoxSet()) ?? standard()).areas;
}

export function useEmptyBoxAreas(): EmptyBoxAreas {
    useEmptyBoxChanges();
    return emptyBoxAreas();
}

export function useEmptyBoxUrl(face: BoxFace): string {
    useEmptyBoxChanges();
    return emptyBoxUrl(face);
}

function useEmptyBoxChanges(): void {
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        const subscription = onDidChangeEmptyBox(() => bump());
        return () => subscription.dispose();
    }, []);
}

const custom = {
    storage: undefined as VueportStorage | undefined,
    faces: {} as Partial<Record<BoxFace, LibraryPicture>>,
    urls: new Map<BoxFace, string>(),
    loading: undefined as Promise<void> | undefined,
};

// called once the library has storage; a second call gets the first one's promise. All six are opened at
// once, as they are small and the front is drawn wherever a cover is missing
export function loadCustomEmptyBox(storage: VueportStorage): Promise<void> {
    custom.storage = storage;
    return custom.loading ??= (async () => {
        try {
            const faces = JSON.parse(await storage.readText(CUSTOM_INDEX)) as Partial<Record<BoxFace, LibraryPicture>>;
            custom.faces = faces && typeof faces === 'object' ? faces : {};
        } catch {
            custom.faces = {};
        }
        for (const face of BOX_FACES) {
            const picture = custom.faces[face];
            if (!picture) {
                continue;
            }
            try {
                const data = await storage.read(`${CUSTOM_DIR}/${picture.file}`);
                custom.urls.set(face, URL.createObjectURL(new Blob([data as BlobPart], { type: picture.type })));
            } catch {
                // file is gone; the standard set's face stands in
                delete custom.faces[face];
            }
        }
        if (custom.urls.size !== 0) {
            onDidChangeEmitter.fire();
        }
    })();
}

// only the own set's face, not the standard set's stand-in
export function customEmptyBoxFace(face: BoxFace): { url: string, name?: string } | undefined {
    const url = custom.urls.get(face);
    return url ? { url, name: custom.faces[face]?.name } : undefined;
}

// or take it away so the standard set's shows
export async function setCustomEmptyBoxFace(face: BoxFace, file: File | undefined): Promise<void> {
    const storage = custom.storage;
    if (!storage) {
        return;
    }
    const previous = custom.faces[face];
    if (previous) {
        await storage.delete(`${CUSTOM_DIR}/${previous.file}`).catch(() => undefined);
    }
    const url = custom.urls.get(face);
    if (url) {
        URL.revokeObjectURL(url);
        custom.urls.delete(face);
    }
    delete custom.faces[face];
    if (file) {
        const picture: LibraryPicture = {
            file: `${face}-${Date.now().toString(36)}`,
            type: file.type || 'image/png',
            name: file.name,
        };
        await storage.write(`${CUSTOM_DIR}/${picture.file}`, new Uint8Array(await file.arrayBuffer()));
        custom.faces[face] = picture;
        custom.urls.set(face, URL.createObjectURL(file));
    }
    await storage.write(CUSTOM_INDEX, new TextEncoder().encode(JSON.stringify(custom.faces)));
    onDidChangeEmitter.fire();
}
