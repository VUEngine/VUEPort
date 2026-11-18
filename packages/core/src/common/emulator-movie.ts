/**
 * Recorded input movies: one line per frame saying which buttons were held, which a deterministic core replays exactly
 * from a reset on the same ROM. Only VBjin's .mc2 is read, the format published VB runs are in.
 *
 * A movie only reproduces a run on the core it was recorded with: cores disagreeing about a single cycle drift apart,
 * and aligning the start does not help, as the time before the first counted frame differs too. adelikat's Wario Land
 * run comes apart about fifty seconds into the first course on this core whatever the alignment, so playback is a
 * hands-free way to drive a game far from its title screen, not a way to reproduce someone's run.
 */

// VbKey mask
export type MovieFrame = number;

export interface Movie {
    emulator: string;
    emulatorVersion: string;
    rerecordCount?: number;
    comments: string[];
    frames: MovieFrame[];
}

// VBjin writes the fourteen buttons from bit 15 down to bit 2; the two low bits are the power and signature lines.
// Written out with the format's characters so the order can be checked against a movie file by eye
const MOVIE_COLUMNS = [
    0x8000, // R-down   .
    0x4000, // R-left   .
    0x2000, // Select   C
    0x1000, // Start    T
    0x0800, // L-up     ^
    0x0400, // L-down   v
    0x0200, // L-left   <
    0x0100, // L-right  >
    0x0080, // R-right  .
    0x0040, // R-up     .
    0x0020, // L-trigger L
    0x0010, // R-trigger R
    0x0008, // B        B
    0x0004, // A        A
];

export const MOVIE_BUTTON_COLUMNS = MOVIE_COLUMNS.length;

// lenient about the header, which differs between versions and carries nothing playback needs, strict about the frames;
// a line that is neither is skipped
export function parseVesMovie(text: string): Movie {
    const movie: Movie = {
        emulator: '', emulatorVersion: '', comments: [], frames: [],
    };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (line.startsWith('|')) {
            // |command|buttons| splits to four parts; the command (reset, power cycle) is ignored but the line still
            // counts as a frame. A shorter line has lost its buttons and would shift every later frame by one if
            // counted as empty
            const parts = line.split('|');
            if (parts.length < 4) {
                continue;
            }
            const buttons = parts[2];
            let keys = 0;
            for (let i = 0; i < MOVIE_COLUMNS.length && i < buttons.length; i++) {
                if (buttons[i] !== '.' && buttons[i] !== ' ') {
                    keys |= MOVIE_COLUMNS[i];
                }
            }
            movie.frames.push(keys);
            continue;
        }
        const [keyword, ...rest] = line.split(' ');
        const value = rest.join(' ');
        switch (keyword) {
            case 'emulator': movie.emulator = value; break;
            case 'emuVersion': movie.emulatorVersion = value; break;
            case 'rerecordCount': movie.rerecordCount = Number(value) || undefined; break;
            case 'comment': movie.comments.push(value); break;
            default: break;
        }
    }
    return movie;
}

export function looksLikeVesMovie(text: string): boolean {
    return /^version\s+\d/.test(text) && /\bemulator\s+VBjin\b/i.test(text.slice(0, 200));
}

// at the Virtual Boy's 50 frames a second
export function formatVesMovieLength(frames: number): string {
    const seconds = Math.round(frames / 50);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
