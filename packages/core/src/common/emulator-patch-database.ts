import { RomPatchFormat, RomPatchStatus, RomPatchType } from './emulator-rom-patches';

interface BuiltInRomPatchFields {
    id: string;
    fileName: string;
    format: RomPatchFormat;
    file: string;
    descriptionIntro?: PatchDescriptionIntro;
    description?: string;
    author: string;
    type: RomPatchType;
    version?: string;
    status?: RomPatchStatus;
    // a colorization's VB Color package (see vb-color-package.ts), in the repository's data/color-packages and
    // published on packages.vueport.net (vb-color-package-file.ts), not shipped with the app
    package?: string;
    // for compatibility fixes the game doesn't run right without; not for colorizations, which their settings switch
    enabledByDefault?: boolean;
}

export type BuiltInRomPatch = BuiltInRomPatchFields & (
    | { name: string, sharedName?: undefined } // translated under its id
    | { sharedName: PatchSharedName, name?: undefined });

// translated under `vueport/patchDatabase/<key>`
export const PATCH_SHARED_NAMES = {
    vbColorName: 'VB Color Enhanced', // the game needs no naming, it's the running one
} as const;

export type PatchSharedName = keyof typeof PATCH_SHARED_NAMES;

// translated under `vueport/patchDatabase/<key>`
export const PATCH_DESCRIPTION_INTROS = {
    vbColorDescriptionIntro: 'Adds a "VB Color Enhanced" mode for VB Color, a \
fictional full color successor to the Virtual Boy, that colors the game \
according to the VB Color specification.',
} as const;

export type PatchDescriptionIntro = keyof typeof PATCH_DESCRIPTION_INTROS;

export interface RomPatchDatabaseEntry {
    game: string;
    crc32: readonly string[]; // lower-case, eight hex digits
    patches: readonly BuiltInRomPatch[];
}

export const PATCH_DATABASE: RomPatchDatabaseEntry[] = [
    {
        game: 'Space Pinball',
        crc32: [
            '44c2b723',
        ],
        patches: [
            {
                id: 'space-pinball/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/space-pinball/vb-color.bps',
                package: 'color-packages/space-pinball.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'space-pinball/score-reset',
                name: 'Score Reset',
                fileName: 'SpacePinballScoreReset.ips',
                format: 'ips',
                file: 'patches/space-pinball/score-reset.ips',
                description: 'This patch for Space Pinball, the Galactic Pinball prototype, \
resets the score to 0 when a new game is started.',
                author: 'HorvatM',
                type: 'hack',
            },
        ],
    },
    {
        game: '3-D Tetris (USA)',
        crc32: [
            'bb71b522', // Retail
        ],
        patches: [
            {
                id: '3d-tetris/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/3d-tetris/vb-color.bps',
                package: 'color-packages/3d-tetris.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
        ],
    },
    {
        game: 'Bound High (Japan, USA)',
        crc32: [
            'e365ddd3', // Final
            'e81a3703', // Near Final
        ],
        patches: [
            {
                id: 'bound-high/save-support',
                name: 'Save Support',
                fileName: 'save-support-v1.0.ips',
                format: 'ips',
                file: 'patches/bound-high/save-support-v1.0.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Adventure of Chalvo saves the most recent password received or entered and \
defaults to Continue when one is saved. Score Attack!! and Pocket and Cushion \
save high scores and stage completion stats; their password system is removed \
entirely. Erase the save by pressing L + R + Left D-Pad Down + Right D-Pad \
Down on the title screen.',
            },
            {
                id: 'bound-high/debug-restoration',
                name: 'Debug Restoration',
                fileName: 'debug-restoration-v1.0.ips',
                format: 'ips',
                file: 'patches/bound-high/debug-restoration-v1.0.ips',
                type: 'debug',
                author: 'Vague Rant',
                description: 'Restores all known dummied-out debug features: cutscene playback and stage \
unlocks through button combos on the title and stage select screens, and Round \
Select, Sound Test, Automatic Play, Expert Enemies, Change Difficulty and \
Frame Advance through combos on the pause menu (hold R, or L + R for Frame \
Advance). The full list of combos is on the patch\'s Planet Virtual Boy page.',
            },
        ],
    },
    {
        game: 'Bound High (Japan, USA)',
        crc32: [
            'e365ddd3', // Final
        ],
        patches: [
            {
                id: 'bound-high/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/bound-high/vb-color.bps',
                package: 'color-packages/bound-high.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'bound-high/rumble',
                name: 'Rumble Pack Support',
                fileName: 'rumble.ips',
                format: 'ips',
                file: 'patches/bound-high/rumble.ips',
                type: 'enhancement',
                author: 'Srimok',
                description: 'Adds RetroOnyx Rumble Pack support to Bound High!.',
            },
        ],
    },
    {
        game: 'Dragon Hopper (Japan, USA)',
        crc32: [
            '193c1a2f', // Retail
        ],
        patches: [
            {
                id: 'dragon-hopper/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/dragon-hopper/vb-color.bps',
                package: 'color-packages/dragon-hopper.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'dragon-hopper/german-translation',
                name: 'German Translation',
                fileName: 'german-translation-v1.0.bps',
                format: 'bps',
                file: 'patches/dragon-hopper/german-translation-v1.0.bps',
                type: 'translation',
                author: 'KR155E',
                version: 'v1.0',
                description: 'Adds German as a third language, translates all dialogue, menus, \
stage cards, name labels, the magic menu and the controller help. Works combined with VB Color.',
            },
        ],
    },
    {
        game: 'Faceball Remastered',
        crc32: [
            '85b321c7', // Homebrew, an English hack of NikoChan Battle
        ],
        patches: [
            {
                id: 'faceball-remastered/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/faceball-remastered/vb-color.bps',
                package: 'color-packages/faceball-remastered.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
        ],
    },
    {
        game: 'Galactic Pinball (Japan, USA)',
        crc32: [
            'c9710a36', // Retail
        ],
        patches: [
            {
                id: 'galactic-pinball/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/galactic-pinball/vb-color.bps',
                package: 'color-packages/galactic-pinball.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'galactic-pinball/rumble',
                name: 'Rumble Pack Support',
                fileName: 'rumble.ips',
                format: 'ips',
                file: 'patches/galactic-pinball/rumble.ips',
                type: 'enhancement',
                author: 'Srimok',
                description: 'Adds RetroOnyx Rumble Pack support to Galactic Pinball.',
            },
        ],
    },
    {
        game: 'Golf (USA)',
        crc32: [
            '2199af41', // Retail
        ],
        patches: [
            {
                id: 'golf/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/golf/vb-color.bps',
                package: 'color-packages/golf.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'golf/save-restoration',
                name: 'Save Restoration',
                fileName: 'save-restoration-v1.1.ips',
                format: 'ips',
                file: 'patches/golf/save-restoration-v1.1.ips',
                type: 'hack',
                author: 'Vague Rant',
                description: 'The US release had saving disabled in the ROM, with its SRAM check hard-coded \
to fail. This restores saving by porting the hardware check from the Japanese \
release; the rest of the save code was left intact. Saves can be erased from \
the in-game menu under "Individual Records". Can be combined with Debug \
Camera.',
            },
            {
                id: 'golf/debug-camera',
                name: 'Debug Camera',
                fileName: 'debug-camera.ips',
                format: 'ips',
                file: 'patches/golf/debug-camera.ips',
                type: 'debug',
                author: 'Vague Rant',
                description: 'Restores a debug mode for adjusting the camera\'s stereoscopic settings. Hold \
Select between shots to open it. Left D-Pad Left/Right adjusts the Z axis, \
Left D-Pad Up/Down the depth, Right D-Pad Up/Down moves 2D elements like the \
minimap in or out of the screen, Right D-Pad Left/Right renders a new frame. \
Cancel exits. Not a perfect restoration: it can be opened once per shot, and \
its text draws over itself until a new frame is rendered.',
            },
        ],
    },
    {
        game: 'Hyper Fighting',
        crc32: [
            '3f2a6ba2', // v1.0, homebrew
        ],
        patches: [
            {
                id: 'hyper-fighting/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/hyper-fighting/vb-color.bps',
                package: 'color-packages/hyper-fighting.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'hyper-fighting/brightness-cap-fix',
                name: 'Brightness Cap Fix',
                fileName: 'brightness-cap-fix.ips',
                format: 'ips',
                file: 'patches/hyper-fighting/brightness-cap-fix.ips',
                type: 'hack',
                author: 'Vague Rant',
                description: 'Fixes a minor bug where the Brightness setting fails to save if it is set to \
maximum.',
            },
        ],
    },
    {
        game: 'Insmouse no Yakata (Japan)',
        crc32: [
            'efd0ac36', // Retail
        ],
        patches: [
            {
                id: 'insmouse-no-yakata/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/insmouse-no-yakata/vb-color.bps',
                package: 'color-packages/insmouse-no-yakata.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'insmouse-no-yakata/english-translation',
                name: 'Innsmouth Mansion (English)',
                fileName: 'english-translation.ips',
                format: 'ips',
                file: 'patches/insmouse-no-yakata/english-translation.ips',
                type: 'translation',
                author: 'thunderstruck',
                description: 'English translation of Insmouse no Yakata.',
            },
            {
                id: 'insmouse-no-yakata/double-health-limit',
                name: 'Double Health Limit',
                fileName: 'double-health-limit.ips',
                format: 'ips',
                file: 'patches/insmouse-no-yakata/double-health-limit.ips',
                type: 'hack',
                author: 'HorvatM',
                description: 'Raises the health limit from 5 to 10. The HUD can only show 5. Can be combined \
with Max Starting Health.',
            },
            {
                id: 'insmouse-no-yakata/max-starting-health',
                name: 'Max Starting Health',
                fileName: 'max-starting-health.ips',
                format: 'ips',
                file: 'patches/insmouse-no-yakata/max-starting-health.ips',
                type: 'hack',
                author: 'HorvatM',
                description: 'Raises the starting health to 5. Can be combined with Double Health Limit.',
            },
            {
                id: 'insmouse-no-yakata/all-hallows-eve',
                name: "All Hallows' Eve",
                fileName: 'all-hallows-eve.ips',
                format: 'ips',
                file: 'patches/insmouse-no-yakata/all-hallows-eve.ips',
                type: 'hack',
                author: 'Benjamin Stevens',
                description: 'Mansion of Insmouse: All Hallows\' Eve, a level hack replacing the game\'s \
levels with new ones.',
            },
            {
                id: 'insmouse-no-yakata/mario-madness-edition',
                name: 'Mario Madness Edition',
                fileName: 'mario-madness-edition.bps',
                format: 'bps',
                file: 'patches/insmouse-no-yakata/mario-madness-edition.bps',
                type: 'hack',
                author: 'Benjamin Stevens',
                description: 'A level hack replacing all of \
the game\'s levels with ones resembling characters from the Mario universe.',
            },
        ],
    },
    {
        game: 'Jack Bros. (Japan)',
        crc32: [
            'cab61e8b', // Retail (Japan)
        ],
        patches: [
            {
                id: 'jack-bros-japan/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color-japan.bps',
                format: 'bps',
                file: 'patches/jack-bros/vb-color-japan.bps',
                package: 'color-packages/jack-bros-japan.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'jack-bros-japan/chinese-translation',
                name: 'Chinese Translation',
                fileName: 'chinese-translation.ips',
                format: 'ips',
                file: 'patches/jack-bros/chinese-translation.ips',
                type: 'translation',
                author: '少年不知愁',
                description: 'Translates all Japanese text in Jack Bros. to Chinese.',
            },
        ],
    },
    {
        game: 'Jack Bros. (USA)',
        crc32: [
            'a44de03c', // Retail (USA)
        ],
        patches: [
            {
                id: 'jack-bros/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/jack-bros/vb-color.bps',
                package: 'color-packages/jack-bros.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'jack-bros/save-support',
                name: 'Save Support',
                fileName: 'save-support-v1.4.ips',
                format: 'ips',
                file: 'patches/jack-bros/save-support-v1.4.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Saves progress separately for all three characters on the Select Player screen \
and for entered passwords, and saves the difficulty with separate slots for \
normal and super difficulty. Adds a debug mode switch: hold Select while \
booting, and the title screen shows "DEBUG" while it is on. Enables the \
Japan-only sound test and fixes its Japanese text. Adds a secret character to \
the Select Player screen: hold L + R while cycling. Erase a character\'s save \
by pressing Left D-Pad Down four times while it is highlighted. To switch \
languages, hold L + R + Left D-Pad Left and press Start on the title screen.',
            },
            {
                id: 'jack-bros/unlock-debug-cheats',
                name: 'Unlock Debug Cheats',
                fileName: 'unlock-debug-cheats.ips',
                format: 'ips',
                file: 'patches/jack-bros/unlock-debug-cheats.ips',
                type: 'debug',
                author: 'Parasyte',
                description: 'Re-enables the debug cheats the programmers deactivated. On the title screen, \
with the Left D-Pad: Right ×7, Left, Right ×7 opens Floor Select; Up, Right, \
Down, Left three times opens Muteki (invincibility) Select; Up ×3, Down ×4 \
opens the Sound Test.',
            },
            {
                id: 'jack-bros/pixie-dialogue-skip',
                name: 'Pixie Dialogue Skip',
                fileName: 'pixie-dialogue-skip.bps',
                format: 'bps',
                file: 'patches/jack-bros/pixie-dialogue-skip.bps',
                type: 'hack',
                author: 'lightbulb-sun',
                description: 'Removes the unskippable Pixie dialogues.',
            },
            {
                id: 'jack-bros/german-translation',
                name: 'German Translation',
                fileName: 'german-translation-v1.0.ips',
                format: 'ips',
                file: 'patches/jack-bros/german-translation-v1.0.ips',
                version: 'v1.0',
                type: 'translation',
                author: 'KR155E',
                description: 'Translates all editable text and some graphics to German. Includes Parasyte\'s \
Unlock Debug Cheats.',
            },
            {
                id: 'jack-bros/spanish-translation',
                name: 'Spanish Translation',
                fileName: 'spanish-translation-v1.0.ips',
                format: 'ips',
                file: 'patches/jack-bros/spanish-translation-v1.0.ips',
                version: 'v1.0',
                type: 'translation',
                author: 'Max1323',
                description: 'Translates the dialogues to Spanish. Includes Parasyte\'s Unlock Debug Cheats.',
            },
            {
                id: 'jack-bros/french-translation',
                name: 'French Translation',
                fileName: 'french-translation-v1.0.bps',
                format: 'bps',
                file: 'patches/jack-bros/french-translation-v1.0.bps',
                version: 'v1.0',
                type: 'translation',
                author: 'chenetulipe',
                description: 'Translates the complete game to French.',
            },
            {
                id: 'jack-bros/russian-translation',
                name: 'Russian Translation',
                fileName: 'russian-translation-v1.0.ips',
                format: 'ips',
                file: 'patches/jack-bros/russian-translation-v1.0.ips',
                version: 'v1.0',
                type: 'translation',
                author: 'ShinRussianTensei',
                description: 'Translates the complete game to Russian, including all the graphics.',
            },
        ],
    },
    {
        game: 'Mario Clash (Japan, USA)',
        crc32: [
            'a47de78c', // Retail
        ],
        patches: [
            {
                id: 'mario-clash/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/mario-clash/vb-color.bps',
                package: 'color-packages/mario-clash.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'mario-clash/save-support',
                name: 'Save Support',
                fileName: 'save-support-v1.3.ips',
                format: 'ips',
                file: 'patches/mario-clash/save-support-v1.3.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Saves level progress, high scores and brightness. Replaces the level select \
capped at 40 with one offering every level reached so far, up to 99. Erase the \
save by pressing L + R + Left D-Pad Down + Right D-Pad Down on the title \
screen. The Button Swap variant also has the Controller Fix layout.',
            },
            {
                id: 'mario-clash/save-support-button-swap',
                name: 'Save Support (Button Swap)',
                fileName: 'save-support-v1.3-button-swap.ips',
                format: 'ips',
                file: 'patches/mario-clash/save-support-v1.3-button-swap.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Save Support with the controls remapped closer to other Mario games, based on \
DogP\'s Controller Fix. Use instead of Save Support, not with it.',
            },
            {
                id: 'mario-clash/controller-fix',
                name: 'Controller Fix',
                fileName: 'controller-fix.ips',
                format: 'ips',
                file: 'patches/mario-clash/controller-fix.ips',
                type: 'hack',
                author: 'DogP',
                description: 'Changes the controller layout to the Mario standard: A jumps, B throws, and \
run is on both triggers.',
            },
        ],
    },
    {
        game: "Mario's Tennis (Japan, USA)",
        crc32: [
            '7ce7460d', // Retail
        ],
        patches: [
            {
                id: 'marios-tennis/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/marios-tennis/vb-color.bps',
                package: 'color-packages/marios-tennis.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'marios-tennis/multiplayer',
                name: 'Multiplayer',
                fileName: 'multiplayer-v1.bspatch',
                format: 'bsdiff',
                file: 'patches/marios-tennis/multiplayer-v1.bspatch',
                type: 'hack',
                author: 'M.K.',
                description: 'Restores three multiplayer modes that were disabled, and partly unfinished, in \
the released game: P1 vs P2, P1/COM vs P2/COM, and P1/P2 vs COM/COM, which is \
buggy.',
            },
        ],
    },
    {
        game: "Nester's Funky Bowling (USA)",
        crc32: [
            'df4d56b4', // Retail
        ],
        patches: [
            {
                id: 'nesters-funky-bowling/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/nesters-funky-bowling/vb-color.bps',
                package: 'color-packages/nesters-funky-bowling.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'nesters-funky-bowling/save-support',
                name: 'Save Support',
                fileName: 'save-support-v1.0.ips',
                format: 'ips',
                file: 'patches/nesters-funky-bowling/save-support-v1.0.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Saves your name, character, ball weight and the League Leaders high scores. \
Erase the save by pressing L + R + Left D-Pad Down + Right D-Pad Down on the \
title screen.',
            },
        ],
    },
    {
        game: 'NikoChan Battle (Japan) (Prototype)',
        crc32: [
            'f3cd40dd', // Prototype
        ],
        patches: [
            {
                id: 'nikochan-battle/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/nikochan-battle/vb-color.bps',
                package: 'color-packages/nikochan-battle.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
        ],
    },
    {
        game: 'Panic Bomber (Japan)',
        crc32: [
            '40498f5e', // Retail
        ],
        patches: [
            {
                id: 'panic-bomber-japan/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color-japan.bps',
                format: 'bps',
                file: 'patches/panic-bomber/vb-color-japan.bps',
                package: 'color-packages/panic-bomber-japan.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
        ],
    },
    {
        game: 'Panic Bomber (USA)',
        crc32: [
            '19bb2dfb', // Retail
        ],
        patches: [
            {
                id: 'panic-bomber/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color-usa.bps',
                format: 'bps',
                file: 'patches/panic-bomber/vb-color-usa.bps',
                package: 'color-packages/panic-bomber-usa.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'panic-bomber/rumble',
                name: 'Rumble Pack Support',
                fileName: 'rumble-usa.ips',
                format: 'ips',
                file: 'patches/panic-bomber/rumble-usa.ips',
                type: 'enhancement',
                author: 'Srimok',
                description: 'Adds RetroOnyx Rumble Pack support to Panic Bomber.',
            },
        ],
    },
    {
        game: 'Red Alarm (Japan, USA)',
        crc32: [
            'aa10a7b4', // US Retail
            '7e85c45d', // JP Retail
        ],
        patches: [
            {
                id: 'red-alarm/save-support',
                name: 'Save Support',
                fileName: 'save-support-v1.3.ips',
                format: 'ips',
                file: 'patches/red-alarm/save-support-v1.3.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Saves the high score, which is not written while in debug mode, and every \
options screen setting: brightness, depth, control scheme and difficulty. \
Erase the save by pressing L + R + Left D-Pad Down + Right D-Pad Down on the \
title screen.',
            },
        ],
    },
    {
        game: 'Red Alarm (USA)',
        crc32: [
            'aa10a7b4', // Retail
        ],
        patches: [
            {
                id: 'red-alarm/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/red-alarm/vb-color.bps',
                package: 'color-packages/red-alarm.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'red-alarm/infinite-shield',
                name: 'Infinite Shield',
                fileName: 'infinite-shield.ips',
                format: 'ips',
                file: 'patches/red-alarm/infinite-shield.ips',
                type: 'trainer',
                author: 'enthusi',
                description: 'Gives your ship infinite shield energy.',
            },
            {
                id: 'red-alarm/haptics',
                name: 'Haptics',
                fileName: 'haptics.ips',
                format: 'ips',
                file: 'patches/red-alarm/haptics.ips',
                type: 'enhancement',
                author: 'enthusi',
                description: 'Prototype support for RetroOnyx\'s Rumble Pack: buzzes when energy levels \
change, and a little at boot.',
            },
        ],
    },
    {
        game: 'SD Gundam - Dimension War (Japan)',
        crc32: [
            '44788197', // Retail
        ],
        patches: [
            {
                id: 'sd-gundam-dimension-war/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/sd-gundam-dimension-war/vb-color.bps',
                package: 'color-packages/sd-gundam-dimension-war.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'sd-gundam-dimension-war/english-translation',
                name: 'English Translation',
                fileName: 'english-translation.ips',
                format: 'ips',
                file: 'patches/sd-gundam-dimension-war/english-translation.ips',
                type: 'translation',
                author: 'thunderstruck, Benjamin Stevens, Greg Stevens',
                description: 'Translates the whole game to English.',
            },
        ],
    },
    {
        game: 'Space Invaders - Virtual Collection (Japan)',
        crc32: [
            'fa44402d', // Retail
        ],
        patches: [
            {
                id: 'space-invaders-virtual-collection/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/space-invaders-virtual-collection/vb-color.bps',
                package: 'color-packages/space-invaders-virtual-collection.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'space-invaders-virtual-collection/english-translation',
                name: 'English Translation',
                fileName: 'english-translation.ips',
                format: 'ips',
                file: 'patches/space-invaders-virtual-collection/english-translation.ips',
                type: 'translation',
                author: 'thunderstruck',
                description: 'English version patch for Space Invaders Virtual Collection.',
            },
            {
                id: 'space-invaders-virtual-collection/rumble',
                name: 'Rumble Pack Support',
                fileName: 'rumble.ips',
                format: 'ips',
                file: 'patches/space-invaders-virtual-collection/rumble.ips',
                type: 'enhancement',
                author: 'Srimok',
                description: 'Adds RetroOnyx Rumble Pack support to Space Invaders Virtual Collection.',
            },
        ],
    },
    {
        game: 'Space Squash (Japan)',
        crc32: [
            '60895693', // Retail
        ],
        patches: [
            {
                id: 'space-squash/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/space-squash/vb-color.bps',
                package: 'color-packages/space-squash.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'space-squash/english-translation',
                name: 'English Translation',
                fileName: 'english-translation.ips',
                format: 'ips',
                file: 'patches/space-squash/english-translation.ips',
                type: 'translation',
                author: 'Benjamin Stevens, thunderstruck, Greg Stevens, Feel',
                description: 'A very accurate and complete English translation. Can be combined with Save \
Support.',
            },
            {
                id: 'space-squash/save-support',
                name: 'Save Support',
                fileName: 'save-support-v1.2.ips',
                format: 'ips',
                file: 'patches/space-squash/save-support-v1.2.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Saves game progress and character upgrades at the end of each Area, with a \
Continue option on the main menu to load them, as well as high scores and \
every Config Mode option. Removes the forced delay on the warning screen, \
makes Start on the title screen open the main menu, and fixes an original bug \
that kept beaten high scores from moving down the list. Erase the save by \
pressing L + R + Left D-Pad Down + Right D-Pad Down on the title screen. Can \
be combined with the English Translation.',
            },
        ],
    },
    {
        game: 'Super Fighter Demo',
        crc32: [
            'a3022d2a',
        ],
        patches: [
            {
                id: 'super-fighter-demo/compatibility-fix',
                name: 'Restoration',
                fileName: 'compatibility-fix.bps',
                format: 'bps',
                file: 'patches/super-fighter-demo/compatibility-fix.bps',
                type: 'compatibility',
                author: 'KR155E',
                enabledByDefault: true,
                description: 'Makes the demo run correctly on modern emulators and real hardware.\n\n\
- Fixes a hang at boot caused by an inverted display-ready check.\n\
- Fixes the timing by counting drawing cycles instead of VIP status register \
changes.\n\
- Fixes the scrolling ticker by keeping text segments off-screen.',
            },
        ],
    },
    {
        game: 'T&E Virtual Golf (Japan)',
        crc32: [
            '6ba07915', // Retail
        ],
        patches: [
            {
                id: 'golf-japan/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color-japan.bps',
                format: 'bps',
                file: 'patches/golf/vb-color-japan.bps',
                package: 'color-packages/golf-japan.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
        ],
    },
    {
        game: 'Teleroboxer (Japan, USA)',
        crc32: [
            '36103000', // Retail
        ],
        patches: [
            {
                id: 'teleroboxer/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/teleroboxer/vb-color.bps',
                package: 'color-packages/teleroboxer.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'teleroboxer/german-translation',
                name: 'German Translation',
                fileName: 'german-translation-v1.0.ips',
                format: 'ips',
                file: 'patches/teleroboxer/german-translation-v1.0.ips',
                type: 'translation',
                author: 'KR155E',
                description: 'Translates all regular text to German.',
            },
            {
                id: 'teleroboxer/rumble',
                name: 'Rumble Pack Support',
                fileName: 'rumble.ips',
                format: 'ips',
                file: 'patches/teleroboxer/rumble.ips',
                type: 'enhancement',
                author: 'Srimok',
                description: 'Adds RetroOnyx Rumble Pack support to Teleroboxer.',
            },
        ],
    },
    {
        game: 'Test Chamber',
        crc32: [
            'bd530920', // Homebrew
        ],
        patches: [
            {
                id: 'test-chamber/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/test-chamber/vb-color.bps',
                package: 'color-packages/test-chamber.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
        ],
    },
    {
        game: 'The Matrix',
        crc32: [
            'f3f9e810',
        ],
        patches: [
            {
                id: 'the-matrix/compatibility-fix',
                name: 'Restoration',
                fileName: 'compatibility-fix.bps',
                format: 'bps',
                file: 'patches/the-matrix/compatibility-fix.bps',
                type: 'compatibility',
                author: 'KR155E',
                enabledByDefault: true,
                description: 'Makes the demo run correctly on modern emulators and real hardware.\n\n\
- Fixes the timing by counting drawing cycles instead of VIP status register \
changes.',
            },
        ],
    },
    {
        game: 'V-Tetris (Japan)',
        crc32: [
            '3ccb67ae', // Retail
        ],
        patches: [
            {
                id: 'v-tetris/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/v-tetris/vb-color.bps',
                package: 'color-packages/v-tetris.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'v-tetris/save-support',
                name: 'Save Support',
                fileName: 'save-support-v1.0.ips',
                format: 'ips',
                file: 'patches/v-tetris/save-support-v1.0.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Saves high scores. Erase the save by pressing L + R + Left D-Pad Down + Right \
D-Pad Down on the title screen.',
            },
        ],
    },
    {
        game: 'Vertical Force (Japan)',
        crc32: [
            '9e9b8b92', // Retail
        ],
        patches: [
            {
                id: 'vertical-force-japan/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color-japan.bps',
                format: 'bps',
                file: 'patches/vertical-force/vb-color-japan.bps',
                package: 'color-packages/vertical-force-japan.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'vertical-force-japan/save-support',
                name: 'Save Support',
                fileName: 'save-support-japan-v1.0.ips',
                format: 'ips',
                file: 'patches/vertical-force/save-support-japan-v1.0.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Saves high scores and completion times in all three difficulties, which are \
not written when a stage was reached through the level select, and the \
brightness, difficulty and control settings. Erase the save by pressing L + R \
+ Left D-Pad Down + Right D-Pad Down on the title screen.',
            },
        ],
    },
    {
        game: 'Vertical Force (USA)',
        crc32: [
            '4c32ba5e', // Retail
        ],
        patches: [
            {
                id: 'vertical-force/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color-usa.bps',
                format: 'bps',
                file: 'patches/vertical-force/vb-color-usa.bps',
                package: 'color-packages/vertical-force-usa.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'vertical-force/save-support',
                name: 'Save Support',
                fileName: 'save-support-usa-v1.0.ips',
                format: 'ips',
                file: 'patches/vertical-force/save-support-usa-v1.0.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Saves high scores and completion times in all three difficulties, which are \
not written when a stage was reached through the level select, and the \
brightness, difficulty and control settings. Erase the save by pressing L + R \
+ Left D-Pad Down + Right D-Pad Down on the title screen.',
            },
        ],
    },
    {
        game: 'Virtual Bowling (Japan)',
        crc32: [
            '20688279', // Retail
        ],
        patches: [
            {
                id: 'virtual-bowling/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/virtual-bowling/vb-color.bps',
                package: 'color-packages/virtual-bowling.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'virtual-bowling/debug-menu-with-select',
                name: 'Debug Menu with Select',
                fileName: 'debug-menu-with-select.ips',
                format: 'ips',
                file: 'patches/virtual-bowling/debug-menu-with-select.ips',
                type: 'debug',
                author: 'Vague Rant',
                description: 'Hold Select while the game boots to open the debug menu; otherwise the \
game boots normally. The menu is the one Unlock Debug Menu opens. Use one of \
the two, not both.',
            },
            {
                id: 'virtual-bowling/unlock-debug-menu',
                name: 'Unlock Debug Menu',
                fileName: 'unlock-debug-menu.ips',
                format: 'ips',
                file: 'patches/virtual-bowling/unlock-debug-menu.ips',
                type: 'debug',
                author: 'Parasyte',
                description: 'Boots into the debug menu left over from a beta version: MUSIC and SE \
play the music and sound effects, and MAINFG jumps to other parts of the game, \
a level select of sorts. Values are hex, with "?" in place of F. Use instead \
of Debug Menu with Select, not with it.',
            },
        ],
    },
    {
        game: 'Virtual Boy Wario Land (Japan, USA)',
        crc32: [
            '133e9372', // Retail
        ],
        patches: [
            {
                id: 'virtual-boy-wario-land/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/virtual-boy-wario-land/vb-color.bps',
                package: 'color-packages/virtual-boy-wario-land.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
        ],
    },
    {
        game: 'Virtual Fishing (Japan)',
        crc32: [
            '526cc969', // Retail
        ],
        patches: [
            {
                id: 'virtual-fishing/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/virtual-fishing/vb-color.bps',
                package: 'color-packages/virtual-fishing.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'virtual-fishing/english-translation',
                name: 'English Translation',
                fileName: 'english-translation-v1.0.ips',
                format: 'ips',
                file: 'patches/virtual-fishing/english-translation-v1.0.ips',
                type: 'translation',
                author: 'thunderstruck, Benjamin Stevens',
                description: 'Translates the whole game to English.',
            },
        ],
    },
    {
        game: 'Virtual Lab (Japan)',
        crc32: [
            '8989fe0a', // Retail
        ],
        patches: [
            {
                id: 'virtual-lab/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/virtual-lab/vb-color.bps',
                package: 'color-packages/virtual-lab.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v1.0',
                status: 'complete',
                descriptionIntro: 'vbColorDescriptionIntro',
                description: 'Colorizations follow the unofficial Mega Drive version by Plutiedev.',
            },
            {
                id: 'virtual-lab/english-translation',
                name: 'English Version',
                fileName: 'english-translation.ips',
                format: 'ips',
                file: 'patches/virtual-lab/english-translation.ips',
                type: 'translation',
                author: 'thunderstruck',
                description: 'Removes the Japanese text from the Precautions screen and moves its English \
text a bit.',
            },
        ],
    },
    {
        game: 'Virtual League Baseball (USA)',
        crc32: [
            '736b40d6', // Retail
        ],
        patches: [
            {
                id: 'virtual-league-baseball/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/virtual-league-baseball/vb-color.bps',
                package: 'color-packages/virtual-league-baseball.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'virtual-league-baseball/select-any-team',
                name: 'Select Any Team',
                fileName: 'select-any-team-usa.ips',
                format: 'ips',
                file: 'patches/virtual-league-baseball/select-any-team-usa.ips',
                type: 'hack',
                author: 'DogP',
                description: 'Lets you pick any team in the normal game, including the All Star and Galaxy \
teams, and the same team for both sides. Left and right now move to the \
previous or next team, wrapping only at the ends: go left from USA or right \
from Switzerland for the new teams. The COM selection square can appear at the \
top for some of them. Not available in the Pennant Race.',
            },
        ],
    },
    {
        game: 'Virtual League Baseball 2 (USA)',
        crc32: [
            '8daea1bf', // Prototype
        ],
        patches: [
            {
                id: 'virtual-league-baseball-2/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/virtual-league-baseball-2/vb-color.bps',
                package: 'color-packages/virtual-league-baseball-2.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'virtual-league-baseball-2/the-crew',
                name: 'The Crew Team Names',
                fileName: 'the-crew.ips',
                format: 'ips',
                file: 'patches/virtual-league-baseball-2/the-crew.ips',
                type: 'hack',
                author: 'thunderstruck',
                description: 'Renames the custom teams after the team behind acquiring the prototype and \
other Virtual Boy scene legends.',
            },
        ],
    },
    {
        game: "Virtual Pro Yakyuu '95 (Japan)",
        crc32: [
            '9ba8bb5e', // Retail
        ],
        patches: [
            {
                id: 'virtual-pro-yakyuu-95/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color-japan.bps',
                format: 'bps',
                file: 'patches/virtual-league-baseball/vb-color-japan.bps',
                package: 'color-packages/virtual-league-baseball-japan.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'virtual-pro-yakyuu-95/select-any-team',
                name: 'Select Any Team',
                fileName: 'select-any-team-japan.ips',
                format: 'ips',
                file: 'patches/virtual-league-baseball/select-any-team-japan.ips',
                type: 'hack',
                author: 'DogP',
                description: 'Lets you pick any team in the normal game, including the All Star and Miracle \
teams, and the same team for both sides. Left and right now move to the \
previous or next team, wrapping only at the ends. The COM selection square can \
appear at the top for some of the new teams. Not available in the Pennant \
Race.',
            },
        ],
    },
    {
        game: 'Virtual Pong',
        crc32: [
            '42e17e38',
        ],
        patches: [
            {
                id: 'virtual-pong/compatibility-fix',
                name: 'Restoration',
                fileName: 'compatibility-fix.bps',
                format: 'bps',
                file: 'patches/virtual-pong/compatibility-fix.bps',
                type: 'compatibility',
                author: 'KR155E',
                enabledByDefault: true,
                description: 'Makes the demo run correctly on modern emulators and real hardware.\n\n\
- Fixes a hang at boot caused by the demo never turning on the display or drawing.\n\
- Fixes the column table never being set.\n\
- Fixes the timing by counting drawing cycles instead of VIP status register \
changes.\n\
- Fixes auto-skipping screens by reading the controller only after the \
hardware read has finished.\n\
- Fixes the wavy bars on the title screen by updating the H-Bias animation \
once per frame and only after drawing has finished.',
            },
        ],
    },
    {
        game: 'Waterworld (USA)',
        crc32: [
            '82a95e51', // Retail
        ],
        patches: [
            {
                id: 'waterworld/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/waterworld/vb-color.bps',
                package: 'color-packages/waterworld.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'partial',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'waterworld/save-support',
                name: 'Save Support',
                fileName: 'save-support-v1.0.ips',
                format: 'ips',
                file: 'patches/waterworld/save-support-v1.0.ips',
                type: 'enhancement',
                author: 'Vague Rant',
                description: 'Adds a saved high score, shown in the top left of the HUD, which is rearranged \
a little to fit it. Asks for auto-pause only at boot rather than after every \
game over, and silences the reminder noise when no button is pressed for a \
while. Erase the save by pressing L + R + Left D-Pad Down + Right D-Pad Down \
on the title screen.',
            },
        ],
    },
    {
        game: 'Zero Racers (Japan, USA)',
        crc32: [
            '71553796', // Retail
        ],
        patches: [
            {
                id: 'zero-racers/vb-color',
                sharedName: 'vbColorName',
                fileName: 'vb-color.bps',
                format: 'bps',
                file: 'patches/zero-racers/vb-color.bps',
                package: 'color-packages/zero-racers.vbcpkg',
                type: 'vb-color',
                author: 'KR155E',
                version: 'v0.1',
                status: 'wip',
                descriptionIntro: 'vbColorDescriptionIntro',
            },
            {
                id: 'zero-racers/practice-track-selector',
                name: 'Practice Track Selector',
                fileName: 'practice-track-selector.ips',
                format: 'ips',
                file: 'patches/zero-racers/practice-track-selector.ips',
                type: 'hack',
                author: 'Kitrinx',
                description: 'Adds a track selector to the rival selection screen to pick any track in \
Practice Mode: cycle with L and R, then confirm on the regular track selection \
screen that follows, or it reverts to a normally selectable track.',
            },
            {
                id: 'zero-racers/sound-test-menu',
                name: 'Sound Test Menu',
                fileName: 'sound-test-menu.ips',
                format: 'ips',
                file: 'patches/zero-racers/sound-test-menu.ips',
                type: 'hack',
                author: 'Revenant',
                description: 'Replaces the Record option on the main menu with the Sound Test, and fixes its \
background settings so the whole menu is visible.',
            },
            {
                id: 'zero-racers/rumble',
                name: 'Rumble Pack Support',
                fileName: 'rumble.ips',
                format: 'ips',
                file: 'patches/zero-racers/rumble.ips',
                type: 'enhancement',
                author: 'enthusi',
                description: 'Adds RetroOnyx Rumble Pack support, tied into the game\'s own collision and \
event logic: different effects for wall impacts, collisions with other racers, \
low power, Jet Zones, Rapid activation and crash-outs. Also includes a small \
hidden rumble debug mode for testing effects.',
            },
        ],
    },
];

export function builtInPatchesFor(
    romId: string | undefined,
    database: readonly RomPatchDatabaseEntry[] = PATCH_DATABASE,
): BuiltInRomPatch[] {
    if (!romId) {
        return [];
    }
    const wanted = romId.toLowerCase();
    return database
        .filter(entry => entry.crc32.some(crc => crc.toLowerCase() === wanted))
        .flatMap(entry => entry.patches.map(patch => ({ ...patch })));
}
