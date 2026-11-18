import { CheatCode } from './emulator-cheats';

export interface BuiltInCheat {
    id: string;
    description: string;
    codes: string;
    notes?: string;
}

export interface CheatDatabaseEntry {
    game: string;
    crc32: string[];
    cheats: BuiltInCheat[];
}

export const CHEAT_DATABASE: CheatDatabaseEntry[] = [
    {
        game: '3-D Tetris (USA)',
        crc32: ['bb71b522'],
        cheats: [
            {
                id: '3d-tetris/max-score',
                description: 'Max Score',
                codes: '5003AFC:E0FF+5003AFE:05F5',
            },
        ],
    },
    {
        game: 'Bound High (Japan, USA)',
        crc32: [
            'e365ddd3', // Final
            'e81a3703', // Near Final
        ],
        cheats: [
            {
                id: 'bound-high/unlimited-lives',
                description: 'Unlimited Lives',
                codes: '5000020:00FF'
            }
        ],
    },
    {
        game: 'Dragon Hopper (Japan, USA)',
        crc32: ['193c1a2f'],
        cheats: [
            {
                id: 'dragon-hopper/debug-mode',
                description: 'Debug Mode',
                codes: '50004AF:01'
            },
            {
                id: 'dragon-hopper/skip-intro',
                notes: 'Press Start to skip',
                description: 'Skip Intro',
                codes: '7069F2E:8A06'
            },
            {
                id: 'dragon-hopper/unlimited-health',
                description: 'Unlimited Health',
                codes: '500CC5F:14'
            },
            {
                id: 'dragon-hopper/unlimited-magic',
                description: 'Unlimited Magic',
                codes: '500CC60:1E'
            },
            {
                id: 'dragon-hopper/unlimited-coins',
                description: 'Unlimited Coins',
                codes: '500CC61:03E7'
            }
        ],
    },
    {
        game: 'Galactic Pinball (Japan, USA)',
        crc32: [
            'c9710a36' // Retail
        ],
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
        game: 'Hyper Fighting',
        crc32: [
            '3f2a6ba2', // v1.0
        ],
        cheats: [
            {
                id: 'hyper-fighting/infinite-health-p1',
                description: 'Infinite Health (Player 1)',
                notes: 'Skips the vitality bonus at the end of a round, which would otherwise never finish counting',
                codes: '500069C:00009000+70166D6:0000',
            },
            {
                id: 'hyper-fighting/infinite-health-p2',
                description: 'Infinite Health (Player 2)',
                notes: 'Skips the vitality bonus at the end of a round, which would otherwise never finish counting',
                codes: '500077C:00009000+70166D6:0000',
            },
            {
                id: 'hyper-fighting/1-hit-knock-outs',
                description: '1-Hit Knock Outs (Both Players)',
                codes: '700D78C:0140+700E6EC:0160',
            },
            {
                id: 'hyper-fighting/1-hit-knock-outs-p2',
                description: '1-Hit Knock Outs (Player 2)',
                notes: 'Player 2\'s energy bar stays empty; the first hit knocks them out',
                codes: '500077C:00000000',
            },
            {
                id: 'hyper-fighting/unlock-ben',
                description: 'Unlock Ben',
                notes: 'Same effect as the button code on the precaution screen; saved permanently',
                codes: '6000048:55',
            },
            {
                id: 'hyper-fighting/unlock-all-modes',
                description: 'Unlock All Modes and Extras',
                notes: 'Same effect as the button code on the precaution screen; saved permanently',
                codes: '6000040:55+6000042:55+6000044:55+6000046:55',
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
                id: 'mario-clash/unlimited-time',
                description: 'Unlimited Time',
                codes: '5009AE0:00C8',
            },
            {
                id: 'mario-clash/unlimited-lives',
                description: 'Unlimited Lives',
                codes: '5009A77:0064',
            },
            {
                id: 'mario-clash/select-any-level',
                description: 'Select Any Level',
                codes: '70E7A26:0063+70E7B02:0063',
            },
        ],
    },
    {
        game: 'Mario\'s Tennis (Japan, USA)',
        crc32: [
            '7ce7460d' // Retail
        ],
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
        crc32: [
            '19bb2dfb' // US Retail
        ],
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
        game: 'Red Alarm (Japan, USA)',
        crc32: [
            'aa10a7b4', // US Retail
            '7e85c45d', // JP Retail
        ],
        cheats: [
            {
                id: 'red-alarm/debug-menu',
                description: 'Debug Menu',
                notes: 'L, R, Select, A in-game shows a debug menu',
                codes: '703C7EC:24',
            },
            {
                id: 'red-alarm/no-ads',
                description: 'No Ads',
                codes: '702E5B0:4900+702E5C4:4900+702E5E4:4500+702E600:2600+702E610:5200+702E62C:4900+702E640:4900',
            },
        ],
    },
    {
        game: 'SD Gundam Dimension War (Japan)',
        crc32: [
            '44788197' // Retail
        ],
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
        crc32: [
            'fa44402d' // Retail
        ],
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
        crc32: [
            '60895693' // Retail
        ],
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
        crc32: [
            '36103000' // Retail
        ],
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
        crc32: [
            '4c32ba5e' // US
        ],
        cheats: [
            {
                id: 'vertical-force/debug-menu',
                description: 'Debug Menu',
                codes: '700B330:0022',
            },
            {
                id: 'vertical-force/invincibility',
                description: 'Invincibility',
                codes: '5003F71:62',
            },
            {
                id: 'vertical-force/max-standard-weapon',
                description: 'Max Standard Weapon',
                notes: 'Switch on only one weapon cheat at a time',
                codes: '5003F6E:0003',
            },
            {
                id: 'vertical-force/max-laser',
                description: 'Max Laser',
                notes: 'Switch on only one weapon cheat at a time',
                codes: '5003F6E:0103',
            },
            {
                id: 'vertical-force/one-hit-kills',
                description: 'One-Hit Kills',
                codes: '700F1BA:417F',
            },
        ],
    },
    {
        game: 'Virtual Boy Wario Land (Japan, USA)',
        crc32: [
            '133e9372', // Retail
        ],
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
                codes: '5001087:01',
            },
            {
                id: 'virtual-boy-wario-land/bull-cap',
                description: 'Bull Cap',
                codes: '5001087:02',
            },
            {
                id: 'virtual-boy-wario-land/sea-dragon-cap',
                description: 'Sea Dragon Cap',
                codes: '5001087:03',
            },
            {
                id: 'virtual-boy-wario-land/eagle-cap',
                description: 'Eagle Cap',
                codes: '5001087:04',
            },
            {
                id: 'virtual-boy-wario-land/king-dragon-cap',
                description: 'King Dragon Cap',
                codes: '5001087:05',
            },
            {
                id: 'virtual-boy-wario-land/infinite-flight-time',
                description: 'Infinite Flight Time',
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
                codes: '50087AA:0E0F',
            },
            {
                id: 'virtual-boy-wario-land/invincibility',
                description: 'Invincibility',
                codes: '5001063:0001',
            },
            {
                id: 'virtual-boy-wario-land/have-key',
                description: 'Have Key',
                codes: '50087B0:0001',
            },
            {
                id: 'virtual-boy-wario-land/have-all-treasures-quest-1',
                description: 'Have All First Quest Treasures',
                codes: '50091A4:0001+50091A8:0001+50091AC:0001+50091B0:0001+50091B4:0001+50091B8:0001+50091BC:0001+50091C0:0001+50091C4:0001+50091C8:0001',
            },
            {
                id: 'virtual-boy-wario-land/have-all-treasures-quest-2',
                description: 'Have All Second Quest Treasures',
                codes: '50091A4:0002+50091A8:0002+50091AC:0002+50091B0:0002+50091B4:0002+50091B8:0002+50091BC:0002+50091C0:0002+50091C4:0002+50091C8:0002',
            },
        ],
    },
    {
        game: 'Virtual League Baseball 2 (USA)',
        crc32: [
            '8daea1bf' // USA Prototype
        ],
        cheats: [
            {
                id: 'virtual-league-baseball-2/max-custom-team-points',
                description: 'Max Custom Team Points',
                codes: '7036FDC:0695',
            },
        ],
    },
    {
        game: 'Waterworld (USA)',
        crc32: [
            '82a95e51' // Retail
        ],
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
    {
        game: 'Zero Racers (USA, Japan)',
        crc32: [
            '71553796' // Retail
        ],
        cheats: [
            {
                id: 'zero-racers/unlock-extra-racers',
                description: 'Unlock Extra Racers',
                codes: '701A769:008A',
            },
            {
                id: 'zero-racers/unlimited-power',
                description: 'Unlimited Power',
                codes: '500DCE8:0000+500DBA8:0000',
            },
            {
                id: 'zero-racers/unlimited-rapids',
                description: 'Unlimited Rapids',
                codes: '500DD20:0003',
            },
            {
                id: 'zero-racers/no-rank-out',
                description: 'No Rank Out',
                codes: '70DDF4C:00000015+70DDF50:00000015+70DDF54:00000015+70DDF58:00000015+70DDF5C:00000015+70DDF60:00000015+700F81C:7FFF',
            }
        ],
    },
];

export function crc32(bytes: Uint8Array): number {
    let table = CRC32_TABLE;
    if (!table) {
        table = CRC32_TABLE = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let value = i;
            for (let bit = 0; bit < 8; bit++) {
                value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
            }
            table[i] = value >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
}

let CRC32_TABLE: Uint32Array | undefined;

export function formatRomId(checksum: number): string {
    return (checksum >>> 0).toString(16).padStart(8, '0');
}

/**
 * Published ROM codes address the bottom mirror (`7069F2E`). A ROM-growing patch puts the original image at the top,
 * where the reset vector has to stay, so the code moves to the topmost mirror, which reaches the same byte both ways:
 * `7E69F2E` for a 2 MiB original. Only ROM addresses move, sized by the unpatched ROM (that is what the CRC32 is of);
 * RAM stays where it is.
 */
export function anchorCheatCodeToRomTop(code: CheatCode, romSize: number): CheatCode {
    const isPowerOfTwo = romSize > 0 && (romSize & (romSize - 1)) === 0;
    if ((code.address >>> 24) !== 0x07 || !isPowerOfTwo || romSize > 0x01000000) {
        return code;
    }
    const mask = romSize - 1;
    return { ...code, address: (0x07000000 | (0x00ffffff & ~mask) | (code.address & mask)) >>> 0 };
}

export function builtInCheatsFor(
    romId: string | undefined,
    database: CheatDatabaseEntry[] = CHEAT_DATABASE,
): BuiltInCheat[] {
    if (!romId) {
        return [];
    }
    const wanted = romId.toLowerCase();
    return database
        .filter(entry => entry.crc32.some(crc => crc.toLowerCase() === wanted))
        .flatMap(entry => entry.cheats);
}
