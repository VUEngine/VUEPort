/**
 * Cheats that ship with the emulator.
 *
 * Keyed by the CRC32 of the whole ROM, which is what the Virtual Boy's
 * preservation catalogues (No-Intro, and libretro's own cheat lists) key on —
 * so an entry here can be taken from those without a translation step. It is
 * also cheap, needs no crypto API, and works in an insecure context, which
 * `crypto.subtle` does not.
 *
 * A CRC32 covers a whole file, and a Virtual Boy ROM is routinely padded up to
 * the next power of two — the header lives at `size - 544`, so it floats with
 * the end and parsing is unaffected, but the checksum is not. The same game
 * therefore has one CRC32 per padding, which is why an entry carries a list of
 * them rather than one.
 */

/** One cheat the emulator knows about without being told. */
export interface VesBuiltInCheat {
    /**
     * Stable for the life of the cheat: renaming its description is fine,
     * changing this is not, because a player's on/off state is filed under it.
     */
    id: string;
    description: string;
    /**
     * The codes, in the `+`-separated form the `.cht` files use — so an entry
     * can be pasted from a published list unchanged.
     */
    codes: string;
}

/** One game, and every ROM of it these cheats apply to. */
export interface VesCheatDatabaseEntry {
    /** For whoever is reading the database; never shown. */
    game: string;
    /** Lower-case, eight hex digits, one per known ROM of this game. */
    crc32: string[];
    cheats: VesBuiltInCheat[];
}

export const CHEAT_DATABASE: VesCheatDatabaseEntry[] = [
    {
        game: '3-D Tetris (USA)',
        crc32: ['bb71b522'],
        cheats: [
            {
                id: '3-d-tetris/max-score',
                description: 'Max Score',
                codes: '5003AFC:E0FF+5003AFE:05F5',
            },
        ],
    },
    {
        game: 'Galactic Pinball (Japan, USA)',
        crc32: ['c9710a36'],
        cheats: [
            {
                id: 'galactic-pinball/bonus-game',
                description: 'Bonus Game',
                codes: '5004F80:0005',
            },
            {
                id: 'galactic-pinball/infinite-pucks',
                description: 'Infinite Pucks',
                codes: '5006F30:0009',
            },
        ],
    },
    {
        game: 'Jack Bros. (USA)',
        crc32: ['a44de03c'],
        cheats: [
            {
                id: 'jack-bros/infinite-time',
                description: 'Infinite Time',
                codes: '5000112:0046',
            },
            {
                id: 'jack-bros/invincible-etc',
                description: 'Invincible, Etc.',
                codes: '5000150:FFFF',
            },
        ],
    },
    {
        game: 'Mario Clash (Japan, USA)',
        crc32: ['a47de78c'],
        cheats: [
            {
                id: 'mario-clash/select-any-level',
                description: 'Select Any Level',
                codes: '70E7A26:0063+70E7B02:0063',
            },
        ],
    },
    {
        game: 'Mario\'s Tennis (Japan, USA)',
        crc32: ['7ce7460d'],
        cheats: [
            {
                id: 'marios-tennis/player-6-points',
                description: 'Player 6 Points (Set 1)',
                codes: '05002090:06',
            },
            {
                id: 'marios-tennis/cpu-6-points',
                description: 'CPU 6 Points (Set 1)',
                codes: '05002091:06',
            },
        ],
    },
    {
        game: 'Panic Bomber (USA)',
        crc32: ['19bb2dfb'],
        cheats: [
            {
                id: 'panic-bomber/debug-mode',
                description: 'Debug Mode',
                codes: '70006B4:00AC+70006B6:9403+700090C:0020+7000958:00A0+70009B6:0040+7000D0A:F8A4+7000D38:F8A4+7000D64:F8A4',
            },
            {
                id: 'panic-bomber/stage-select',
                description: 'Stage Select',
                codes: '70006B2:E841+70006B4:02AC+70006B6:4C79+7028000:E4D1+7028002:D6A6+7028004:E141+7028006:E4D1+7028008:F8A4+702800A:1F18',
            },
        ],
    },
    {
        game: 'SD Gundam Dimension War (Japan)',
        crc32: ['44788197'],
        cheats: [
            {
                id: 'sd-gundam-dimension-war/infinite-time',
                description: 'Infinite Time',
                codes: '05000300:09',
            },
        ],
    },
    {
        game: 'Space Invaders - Virtual Collection (Japan)',
        crc32: ['fa44402d'],
        cheats: [
            {
                id: 'space-invaders-virtual-collection/infinite-lives',
                description: 'Infinite Lives',
                codes: '700D326:4045',
            },
        ],
    },
    {
        game: 'Space Squash (Japan)',
        crc32: ['60895693'],
        cheats: [
            {
                id: 'space-squash/infinite-hp',
                description: 'Infinite HP',
                codes: '5000130:0004',
            },
        ],
    },
    {
        game: 'Teleroboxer (Japan, USA)',
        crc32: ['36103000'],
        cheats: [
            {
                id: 'teleroboxer/1-hit-knock-outs',
                description: '1-Hit Knock Outs',
                codes: '5004780:0001',
            },
            {
                id: 'teleroboxer/infinite-health',
                description: 'Infinite Health',
                codes: '500477C:007F',
            },
        ],
    },
    {
        game: 'Vertical Force (USA)',
        crc32: ['4c32ba5e'],
        cheats: [
            {
                id: 'vertical-force/debug-menu',
                description: 'Debug Menu',
                codes: '700B330:0022',
            },
            {
                id: 'vertical-force/infinite-energy',
                description: 'Infinite Energy',
                codes: '5003F6D:0008',
            },
        ],
    },
    {
        game: 'Virtual Bowling (Japan)',
        crc32: ['20688279'],
        cheats: [
            {
                id: 'virtual-bowling/debug-menu',
                description: 'Debug Menu',
                codes: '7003EFA:0041',
            },
        ],
    },
    {
        game: 'Virtual Boy Wario Land (Japan, USA)',
        crc32: ['133e9372'],
        cheats: [
            {
                id: 'virtual-boy-wario-land/99-hearts',
                description: '99 Hearts',
                codes: '50087A6:0063',
            },
            {
                id: 'virtual-boy-wario-land/9999-coins',
                description: '9999 Coins',
                codes: '50087A8:270F',
            },
            {
                id: 'virtual-boy-wario-land/helmet-cap',
                description: 'Helmet Cap',
                codes: '5001087:0001',
            },
            {
                id: 'virtual-boy-wario-land/bull-cap',
                description: 'Bull Cap',
                codes: '5001087:0002',
            },
            {
                id: 'virtual-boy-wario-land/sea-dragon-cap',
                description: 'Sea Dragon Cap',
                codes: '5001087:0003',
            },
            {
                id: 'virtual-boy-wario-land/eagle-cap',
                description: 'Eagle Cap',
                codes: '5001087:0004',
            },
            {
                id: 'virtual-boy-wario-land/king-dragon-cap',
                description: 'King Dragon Cap',
                codes: '5001087:0005',
            },
            {
                id: 'virtual-boy-wario-land/have-all-treasures-quest-1',
                description: 'Have All Treasures, Quest 1',
                codes: '50091A4:0001+50091A8:0001+50091AC:0001+50091B0:0001+50091B4:0001+50091B8:0001+50091BC:0001+50091C0:0001+50091C4:0001+50091C8:0001',
            },
            {
                id: 'virtual-boy-wario-land/have-all-treasures-quest-2',
                description: 'Have All Treasures, Quest 2',
                codes: '50091A4:0002+50091A8:0002+50091AC:0002+50091B0:0002+50091B4:0002+50091B8:0002+50091BC:0002+50091C0:0002+50091C4:0002+50091C8:0002',
            },
            {
                id: 'virtual-boy-wario-land/infinite-flight-time-with-the-dragon-cap',
                description: 'Infinite Flight Time With The Dragon Cap',
                codes: '500103F:0000',
            },
            {
                id: 'virtual-boy-wario-land/infinite-lives',
                description: 'Infinite Lives',
                codes: '50087A4:0009',
            },
            {
                id: 'virtual-boy-wario-land/infinite-time',
                description: 'Infinite Time',
                codes: '50087AA:00B0',
            },
            {
                id: 'virtual-boy-wario-land/invincibility',
                description: 'Invincibility',
                codes: '5001063:0001',
            },
        ],
    },
    {
        game: 'Waterworld (USA)',
        crc32: ['82a95e51'],
        cheats: [
            {
                id: 'waterworld/infinite-lives-ram',
                description: 'Infinite Lives (RAM)',
                codes: '5009B62:0003',
            },
            {
                id: 'waterworld/infinite-lives-rom',
                description: 'Infinite Lives (ROM)',
                codes: '701654E:C144',
            },
        ],
    },
];

/** The CRC32 of a ROM, lower-case and eight digits, as the database spells it. */
export function formatRomId(crc32: number): string {
    return (crc32 >>> 0).toString(16).padStart(8, '0');
}

/**
 * The cheats shipped for a ROM, or none for one nothing is known about — which
 * is the ordinary case for homebrew and for anything still being built.
 */
export function builtInCheatsFor(
    romId: string | undefined,
    database: VesCheatDatabaseEntry[] = CHEAT_DATABASE,
): VesBuiltInCheat[] {
    if (!romId) {
        return [];
    }
    const wanted = romId.toLowerCase();
    return database
        .filter(entry => entry.crc32.some(crc => crc.toLowerCase() === wanted))
        .flatMap(entry => entry.cheats);
}
