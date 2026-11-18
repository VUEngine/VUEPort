import { VbKey } from '../common/vb-constants';

// canonical names follow the controller's documentation (`LU` is the left D-pad's up, `RU` the right one's), with
// the obvious words as aliases. The bare directions are the left pad's, the one games steer with
const KEY_NAMES: Record<string, number> = {
    A: VbKey.A,
    B: VbKey.B,
    L: VbKey.LT,
    R: VbKey.RT,
    LT: VbKey.LT,
    RT: VbKey.RT,
    STA: VbKey.STA,
    START: VbKey.STA,
    SEL: VbKey.SEL,
    SELECT: VbKey.SEL,
    LU: VbKey.LU,
    LD: VbKey.LD,
    LL: VbKey.LL,
    LR: VbKey.LR,
    UP: VbKey.LU,
    DOWN: VbKey.LD,
    LEFT: VbKey.LL,
    RIGHT: VbKey.LR,
    RU: VbKey.RU,
    RD: VbKey.RD,
    RL: VbKey.RL,
    RR: VbKey.RR,
};

// the names formatKeys writes, in the order it writes them
const CANONICAL: [string, number][] = [
    ['A', VbKey.A], ['B', VbKey.B], ['L', VbKey.LT], ['R', VbKey.RT],
    ['STA', VbKey.STA], ['SEL', VbKey.SEL],
    ['LU', VbKey.LU], ['LD', VbKey.LD], ['LL', VbKey.LL], ['LR', VbKey.LR],
    ['RU', VbKey.RU], ['RD', VbKey.RD], ['RL', VbKey.RL], ['RR', VbKey.RR],
];

export const NO_KEYS = VbKey.SGN; // nothing held, with the controller present

// a button mask from `A+RIGHT`, `a,lu`, `0x1004` or `-`. The signature bit is always set, as the app does: it tells
// a game a controller is plugged in, and a movie has to mean the same thing here and there
export function parseKeys(text: string): number {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === '-' || /^none$/i.test(trimmed)) {
        return NO_KEYS;
    }
    if (/^0x[0-9a-f]+$/i.test(trimmed)) {
        return (parseInt(trimmed, 16) | VbKey.SGN) & 0xffff;
    }
    let mask = VbKey.SGN;
    for (const token of trimmed.split(/[+,|\s]+/)) {
        if (token === '') {
            continue;
        }
        const key = KEY_NAMES[token.toUpperCase()];
        if (key === undefined) {
            throw new Error(`Unknown button "${token}". Known: ${Object.keys(KEY_NAMES).join(' ')}.`);
        }
        mask |= key;
    }
    return mask;
}

// `A+LR`, or `-` for nothing held. The signature bit is not a button
export function formatKeys(mask: number): string {
    const held = CANONICAL.filter(([, key]) => (mask & key) !== 0).map(([name]) => name);
    return held.length > 0 ? held.join('+') : '-';
}
