/**
 * Cheats and their `.cht` files. A cheat is a set of RAM writes repeated every frame (gamehacking.org's "RAM Write"
 * codes), written `ADDRESS:VALUE` in hex, e.g. `50091A4:0001` writes 1 to 0x050091A4. Value digits give the width: 2
 * byte, 4 halfword, 8 word.
 *
 * The file format is RetroArch's (`cheats` count, then `cheatN_desc`, `cheatN_code`, `cheatN_enable`, codes joined by
 * `+`). Reading is lenient (unknown keys, missing quotes, wrong count, blank lines, `;` comments) as files are
 * hand-written; writing is canonical. `cheatN_notes` is our own optional addition, which standard readers ignore as an
 * unknown key; it is omitted when empty.
 */

export interface CheatCode {
    // CPU address
    address: number;
    value: number;
    // value width in hex digits: 2, 4 or 8
    digits: number;
}

export interface Cheat {
    description: string;
    enabled: boolean;
    codes: CheatCode[];
    notes?: string;
    // from the built-in database: can be toggled but not edited or removed, as the next release may correct
    // it. Only its on/off state is kept in browser state (see the cheat store)
    readonly builtIn?: boolean;
    // built-in's identity, stable across releases, keying its on/off state. Player cheats use a
    // definition-derived identity instead
    readonly id?: string;
}

export const CHEAT_DIGITS = [2, 4, 8];
export const CHEAT_DEFAULT_DIGITS = 4;

export function vesCheatCodeBytes(code: CheatCode): number {
    return Math.max(1, Math.min(4, code.digits / 2));
}

export function vesCheatMaxValue(digits: number): number {
    return digits >= 8 ? 0xffffffff : (1 << (digits * 4)) - 1;
}

// the address is masked to 32 bits rather than rejected, as published codes often drop leading zeroes
// and occasionally carry a stray one
export function parseVesCheatCode(text: string): CheatCode | undefined {
    const match = /^\s*([0-9a-f]{1,8})\s*:\s*([0-9a-f]{1,8})\s*$/i.exec(text);
    if (!match) {
        return undefined;
    }
    const digits = match[2].length <= 2 ? 2 : match[2].length <= 4 ? 4 : 8;
    return {
        address: parseInt(match[1], 16) >>> 0,
        value: parseInt(match[2], 16) >>> 0,
        digits,
    };
}

export function formatVesCheatCode(code: CheatCode): string {
    const address = (code.address >>> 0).toString(16).toUpperCase();
    const value = (code.value >>> 0).toString(16).toUpperCase().padStart(code.digits, '0');
    return `${address}:${value}`;
}

export function formatVesCheatCodes(cheat: Cheat): string {
    return cheat.codes.map(formatVesCheatCode).join('+');
}

// unparseable codes are dropped rather than failing the rest
export function parseVesCheatCodes(text: string): CheatCode[] {
    return text.split('+')
        .map(parseVesCheatCode)
        .filter((parsed): parsed is CheatCode => parsed !== undefined);
}

export function parseVesCheatFile(text: string): Cheat[] {
    const values = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) {
            continue;
        }
        const separator = trimmed.indexOf('=');
        if (separator === -1) {
            continue;
        }
        const key = trimmed.slice(0, separator).trim().toLowerCase();
        const value = trimmed.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
        values.set(key, value);
    }

    // the declared count is only a hint: stale or missing counts still read every entry, overstated ones
    // add no empty cheats
    const declared = parseInt(values.get('cheats') ?? '', 10);
    const cheats: Cheat[] = [];
    for (let index = 0; index < Math.max(Number.isNaN(declared) ? 0 : declared, values.size); index++) {
        const description = values.get(`cheat${index}_desc`);
        const code = values.get(`cheat${index}_code`);
        if (description === undefined && code === undefined) {
            continue;
        }
        const notes = values.get(`cheat${index}_notes`);
        cheats.push({
            description: description ?? '',
            enabled: (values.get(`cheat${index}_enable`) ?? 'false').toLowerCase() === 'true',
            codes: parseVesCheatCodes(code ?? ''),
            notes: notes ? notes.replace(/\\n/g, '\n') : undefined,
        });
    }
    return cheats;
}

export function serializeVesCheatFile(cheats: Cheat[]): string {
    const lines = [`cheats = ${cheats.length}`];
    cheats.forEach((cheat, index) => {
        lines.push(
            '',
            `cheat${index}_desc = "${cheat.description.replace(/"/g, '')}"`,
            `cheat${index}_code = "${formatVesCheatCodes(cheat)}"`,
            `cheat${index}_enable = ${cheat.enabled}`
        );
        // omitted without notes, so such files are unchanged; newlines are escaped so the note stays on one
        // physical line, as an embedded one would start a new key
        if (cheat.notes) {
            lines.push(
                `cheat${index}_notes = "${cheat.notes.replace(/"/g, '').replace(/\r?\n/g, '\\n')}"`);
        }
    });
    return `${lines.join('\n')}\n`;
}

export function enabledVesCheatCodes(cheats: ReadonlyArray<Cheat>): CheatCode[] {
    return cheats.filter(cheat => cheat.enabled).flatMap(cheat => cheat.codes);
}
