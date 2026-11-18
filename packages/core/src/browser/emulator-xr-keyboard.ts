// a keyboard in the headset for the page's text fields (see emulator-xr-ui.ts), as a headset browser shows none of its
// own during a session. Drawn on a canvas like the other overlays; a key pressed types into the focused field the way
// typing does, so React sees the change

import { isTextEntry, pressXrKey, setControlValue } from './emulator-xr-dom';

export const XR_KEYBOARD_PIXELS = { width: 1500, height: 540 };

type KeyAction =
    | { kind: 'text'; text: string }
    | { kind: 'backspace' }
    | { kind: 'enter' }
    | { kind: 'shift' }
    | { kind: 'symbols' }
    | { kind: 'left' }
    | { kind: 'right' }
    | { kind: 'close' };

interface Key {
    label: string;
    action: KeyAction;
    // in key widths
    width: number;
}

interface PlacedKey extends Key {
    x: number;
    y: number;
    w: number;
    h: number;
}

const text = (character: string): Key => ({ label: character, action: { kind: 'text', text: character }, width: 1 });
const keys = (characters: string): Key[] => [...characters].map(text);

const COLORS = {
    background: '#141414',
    border: '#3a3a3a',
    key: '#2a2a2e',
    special: '#202024',
    hover: '#c4001a',
    pressed: '#ff3b30',
    text: '#f2f2f2',
    dim: '#a0a0a0',
    on: '#ff3b30',
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const PADDING = 24;
const GAP = 10;

// German keyboards swap Y and Z, and have their letters among the symbols
function german(): boolean {
    return typeof navigator !== 'undefined' && /^de\b/i.test(navigator.language);
}

export class XrKeyboard {
    protected shift = false;
    protected symbols = false;
    protected placed: PlacedKey[] = [];
    hovered: number | undefined;
    protected down: number | undefined;

    protected rows(): Key[][] {
        const backspace: Key = { label: '⌫', action: { kind: 'backspace' }, width: 1.5 };
        const enter: Key = { label: '⏎', action: { kind: 'enter' }, width: 1.5 };
        const bottom = (mode: string): Key[] => [
            { label: mode, action: { kind: 'symbols' }, width: 2 },
            { label: '', action: { kind: 'text', text: ' ' }, width: 5.5 },
            { label: '←', action: { kind: 'left' }, width: 1 },
            { label: '→', action: { kind: 'right' }, width: 1 },
            { label: '✕', action: { kind: 'close' }, width: 1.5 },
        ];
        if (this.symbols) {
            return [
                [...keys('1234567890'), backspace],
                keys(german() ? '!"§$%&/()=?' : '!@#$%^&*()_'),
                [...keys(german() ? '+*#\'-_.:,;' : '+=-/\\|:;\'"'), enter],
                keys(german() ? '@€<>[]{}|~' : '<>[]{}`~€?'),
                [...german() ? keys('äöüß') : [], ...bottom('ABC')],
            ];
        }
        const letters = (row: string): Key[] => keys(this.shift ? row.toUpperCase() : row);
        return [
            [...keys('1234567890'), backspace],
            letters(german() ? 'qwertzuiop' : 'qwertyuiop'),
            [...letters('asdfghjkl'), enter],
            [{ label: '⇧', action: { kind: 'shift' }, width: 1.5 },
                ...letters(german() ? 'yxcvbnm' : 'zxcvbnm'), ...keys(',.-@')],
            bottom('?123'),
        ];
    }

    draw(canvas: HTMLCanvasElement): void {
        const { width, height } = XR_KEYBOARD_PIXELS;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }
        context.clearRect(0, 0, width, height);
        context.fillStyle = COLORS.border;
        roundRect(context, 0, 0, width, height, 22);
        context.fill();
        context.fillStyle = COLORS.background;
        roundRect(context, 3, 3, width - 6, height - 6, 20);
        context.fill();

        const rows = this.rows();
        const units = Math.max(...rows.map(row => row.reduce((sum, key) => sum + key.width, 0)));
        const unit = (width - PADDING * 2 - GAP * (units - 1)) / units;
        const keyHeight = (height - PADDING * 2 - GAP * (rows.length - 1)) / rows.length;
        this.placed = [];
        rows.forEach((row, rowIndex) => {
            const rowUnits = row.reduce((sum, key) => sum + key.width, 0);
            const rowWidth = rowUnits * unit + (rowUnits - 1) * GAP;
            let x = (width - rowWidth) / 2;
            const y = PADDING + rowIndex * (keyHeight + GAP);
            for (const key of row) {
                const w = key.width * unit + (key.width - 1) * GAP;
                this.placed.push({ ...key, x, y, w, h: keyHeight });
                x += w + GAP;
            }
        });
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        this.placed.forEach((key, index) => {
            const special = key.action.kind !== 'text' || key.label === '';
            context.fillStyle = index === this.down ? COLORS.pressed
                : index === this.hovered ? COLORS.hover
                    : special ? COLORS.special : COLORS.key;
            roundRect(context, key.x, key.y, key.w, key.h, 10);
            context.fill();
            const lit = (key.action.kind === 'shift' && this.shift);
            context.fillStyle = lit ? COLORS.on : special ? COLORS.dim : COLORS.text;
            if (index === this.hovered || index === this.down) {
                context.fillStyle = COLORS.text;
            }
            context.font = `${special ? 600 : 500} ${Math.round(key.h * (key.label.length > 2 ? 0.34 : 0.46))}px ${FONT}`;
            context.fillText(key.label, key.x + key.w / 2, key.y + key.h / 2 + 2);
        });
    }

    keyAt(x: number, y: number): number | undefined {
        const index = this.placed.findIndex(key => x >= key.x && x < key.x + key.w && y >= key.y && y < key.y + key.h);
        return index < 0 ? undefined : index;
    }

    // true when it needs drawing again
    hover(index: number | undefined): boolean {
        if (index === this.hovered) {
            return false;
        }
        this.hovered = index;
        return true;
    }

    // a press on the hovered key, and its release; the key acts on the press, like a phone's
    press(): void {
        const index = this.hovered;
        const key = index === undefined ? undefined : this.placed[index];
        this.down = index;
        if (key) {
            this.act(key.action);
        }
    }

    release(): void {
        this.down = undefined;
    }

    protected act(action: KeyAction): void {
        const field = document.activeElement;
        switch (action.kind) {
            case 'shift':
                this.shift = !this.shift;
                return;
            case 'symbols':
                this.symbols = !this.symbols;
                return;
            case 'close':
                if (field instanceof HTMLElement) {
                    field.blur();
                }
                return;
        }
        if (!isTextEntry(field)) {
            return;
        }
        switch (action.kind) {
            case 'text':
                insert(field, action.text);
                // a capital at a time, as on a phone
                if (this.shift && /\p{L}/u.test(action.text)) {
                    this.shift = false;
                }
                break;
            case 'backspace':
                erase(field);
                break;
            case 'enter':
                if (field instanceof HTMLTextAreaElement) {
                    insert(field, '\n');
                } else if (pressXrKey('Enter')) {
                    field.form?.requestSubmit();
                }
                break;
            case 'left':
            case 'right':
                moveCaret(field, action.kind === 'left' ? -1 : 1);
                break;
        }
    }
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    context.beginPath();
    context.roundRect(x, y, w, h, r);
}

// where the selection is; a number field has none, so typing there goes on the end
function selection(field: HTMLInputElement | HTMLTextAreaElement): { start: number; end: number } | undefined {
    try {
        const start = field.selectionStart;
        const end = field.selectionEnd;
        return start === null || end === null ? undefined : { start, end };
    } catch {
        return undefined;
    }
}

function announce(field: HTMLInputElement | HTMLTextAreaElement, inputType: string, data: string | null): void {
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
}

function insert(field: HTMLInputElement | HTMLTextAreaElement, typed: string): void {
    const at = selection(field);
    if (at) {
        field.setRangeText(typed, at.start, at.end, 'end');
    } else {
        setControlValue(field, field.value + typed);
    }
    announce(field, 'insertText', typed);
}

function erase(field: HTMLInputElement | HTMLTextAreaElement): void {
    const at = selection(field);
    if (at) {
        if (at.start === at.end && at.start === 0) {
            return;
        }
        field.setRangeText('', at.start === at.end ? at.start - 1 : at.start, at.end, 'end');
    } else if (field.value) {
        setControlValue(field, field.value.slice(0, -1));
    } else {
        return;
    }
    announce(field, 'deleteContentBackward', null);
}

function moveCaret(field: HTMLInputElement | HTMLTextAreaElement, step: number): void {
    const at = selection(field);
    if (at) {
        const to = Math.max(0, Math.min(field.value.length, (step < 0 ? at.start : at.end) + (at.start === at.end ? step : 0)));
        field.setSelectionRange(to, to);
    }
}
