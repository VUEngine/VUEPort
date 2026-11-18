// kept out of the screen that assembles the shelves, so the views can be files of their own without importing each
// other
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { CoverSource } from './web-library-cover';
import { BoxFace } from './web-library-types';

export interface Card {
    id: string;
    title: string;
    meta: string;
    cover: CoverSource;
    box?: Partial<Record<BoxFace, string>>; // for the coverflow; a missing face is the chosen empty box's
    developer?: string;
    year?: string;
    genre?: string;
    players?: string;
    size?: string;
    score?: number; // out of 100
    kind?: string;
    status?: string;
    region?: string; // "Japan / North America", as the catalog joins it
    hasSave?: boolean;
    resumable?: boolean;
    featured?: boolean; // only known on the catalog's featured shelf, the looked-up entry does not carry it
    favorite?: boolean;
    addedAt?: number;
    playCount?: number;
    playMs?: number;
    lastPlayedAt?: number;
    searchable: string;
}

export interface CardActions {
    onPlay: (id: string) => void;
    onResume: (id: string) => void;
    onShare?: (id: string) => void;
}

// the field can be typed over, so "tech-demo", "Tech Demo" and "tech_demo" are folded together for filtering
export function kindKey(kind: string | undefined): string {
    return (kind ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

// the catalog spells Canceled with one l and the field can be typed over, so both spellings and any casing count.
// Prototype and Upcoming don't, as those games may still arrive
export function unreleased(status: string | undefined): boolean {
    return /^cancell?ed$/i.test((status ?? '').trim());
}

// shared by cards and filter bar; unknown values are shown as the catalog wrote them
export function kindName(kind: string): string {
    switch (kindKey(kind)) {
        case 'game':
            return nls.localize('vueport/library/kind/official', 'Official');
        case 'homebrew':
            return nls.localize('vueport/library/kind/homebrew', 'Homebrew');
        case 'tech-demo':
            return nls.localize('vueport/library/kind/techDemo', 'Technical Demo');
        default:
            return kind;
    }
}

