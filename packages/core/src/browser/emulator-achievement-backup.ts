// shipped offline snapshot of all VB achievement sets (no progress, no unlocks) for when the site is unreachable.
// The data (src/data/retroachievements-vb.json, from scripts/fetch-achievement-sets.mjs) is loaded on demand by the
// host via RetroAchievementsService.setBackupLoader, so the ~40 KB only costs sessions that need it

import { localizeAchievement } from '../common/emulator-catalog-nls';
import { RaAchievement, RaGame } from '../common/vb-protocol';

// game icon paths and badge names resolve here, without CORS issues or a key
const RA_MEDIA = 'https://media.retroachievements.org';

export interface AchievementBackupAchievement {
    id: number;
    title: string;
    description: string;
    points: number;
    // RetroAchievements' own classification, absent for an ordinary achievement
    type?: 'progression' | 'win_condition' | 'missable' | string;
    displayOrder: number;
    badgeName: string; // `${RA_MEDIA}/Badge/${badgeName}.png`
    numAwarded: number;
    numAwardedHardcore: number;
}

export interface AchievementBackupGame {
    id: number;
    title: string;
    imageIcon: string; // site-relative, e.g. `/Images/073200.png`
    developer?: string;
    publisher?: string;
    genre?: string;
    released?: string;
    points: number;
    // accounts that played the game at all, the denominator for rarity
    numDistinctPlayers: number;
    hashes: string[]; // RetroAchievements ROM hashes (whole-file MD5, lower-case)
    achievements: AchievementBackupAchievement[];
}

export interface AchievementBackup {
    source: string;
    console: { id: number; name: string };
    generatedAt: string; // ISO 8601
    slim: boolean;
    gameCount: number;
    achievementCount: number;
    games: AchievementBackupGame[];
}

export function achievementBackupIconUrl(game: AchievementBackupGame): string {
    if (!game.imageIcon) {
        return '';
    }
    return game.imageIcon.startsWith('http') ? game.imageIcon : `${RA_MEDIA}${game.imageIcon}`;
}

export function achievementBackupToRaGame(game: AchievementBackupGame): RaGame {
    return {
        id: game.id,
        title: game.title,
        iconUrl: achievementBackupIconUrl(game),
        achievementCount: game.achievements.length,
        pointsTotal: game.points,
    };
}

const RA_TYPES: Record<string, RaAchievement['type']> = {
    progression: 'progression',
    win_condition: 'win',
    missable: 'missable',
};

// all locked, as the snapshot has no account progress; rarity is numAwarded over the game's player count, as on
// the site
export function achievementBackupToRaList(game: AchievementBackupGame): RaAchievement[] {
    const players = game.numDistinctPlayers;
    const pct = (n: number): number | undefined =>
        players > 0 ? Math.min(100, (n / players) * 100) : undefined;
    return [...game.achievements]
        .sort((a, b) => a.displayOrder - b.displayOrder || a.id - b.id)
        .map(a => localizeAchievement({
            id: a.id,
            title: a.title,
            description: a.description,
            points: a.points,
            badgeUrl: a.badgeName ? `${RA_MEDIA}/Badge/${a.badgeName}.png` : '',
            state: 'locked' as const,
            unlockedHardcore: false,
            bucket: 0,
            type: a.type ? RA_TYPES[a.type] : undefined,
            rarity: pct(a.numAwarded),
            rarityHardcore: pct(a.numAwardedHardcore),
        }));
}

export function achievementBackupByHash(backup: AchievementBackup): Map<string, AchievementBackupGame> {
    const byHash = new Map<string, AchievementBackupGame>();
    for (const game of backup.games) {
        for (const hash of game.hashes) {
            byHash.set(hash.toLowerCase(), game);
        }
    }
    return byHash;
}
