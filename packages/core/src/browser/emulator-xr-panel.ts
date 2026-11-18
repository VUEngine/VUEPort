// questions and news in a headset, drawn on a 2D canvas and handed to the session as a texture (the page's own
// interface is shown by emulator-xr-ui.ts). Sticks move through a list, A takes the line, B goes back
// (see EmulatorXrSession.showPanel)

export interface XrPanelItem {
    label: string;
    // shown beside the label, dimmer: a state, a shortcut
    detail?: string;
    disabled?: boolean;
    // the panel closes afterwards, unless this returns 'keep' (a switch, whose new state the panel then shows)
    run(): void | 'keep';
}

export interface XrPanel {
    title: string;
    message?: string[];
    // read again whenever the panel is drawn, so a switch shows its new state
    items(): XrPanelItem[];
    // dimmer lines at the foot: what else the controllers do, for a user who cannot look at the page
    footer?: string[];
    footerTitle?: string;
    // however it went: chosen, backed out of, or replaced
    onClose?(): void;
}

// its width in the room is XR_PANEL_WIDTH
export const XR_PANEL_PIXELS = { width: 1024, height: 960 };
export const XR_TOAST_PIXELS = { width: 1024, height: 112 };

const COLORS = {
    background: '#141414',
    border: '#3a3a3a',
    title: '#ff3b30',
    text: '#f2f2f2',
    dim: '#8c8c8c',
    disabled: '#5a5a5a',
    cursor: '#c4001a',
    cursorText: '#ffffff',
    error: '#ff6b5e',
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const PADDING = 48;
const TITLE_SIZE = 52;
const MESSAGE_SIZE = 32;
const MESSAGE_LINE = 42;
const ITEM_SIZE = 38;
const ITEM_HEIGHT = 72;
const FOOTER_SIZE = 27;
const FOOTER_LINE = 38;

function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (line && context.measureText(next).width > width) {
            lines.push(line);
            line = word;
        } else {
            line = next;
        }
    }
    if (line) {
        lines.push(line);
    }
    return lines;
}

function fit(context: CanvasRenderingContext2D, text: string, width: number): string {
    if (context.measureText(text).width <= width) {
        return text;
    }
    let cut = text;
    while (cut.length > 1 && context.measureText(`${cut}…`).width > width) {
        cut = cut.slice(0, -1);
    }
    return `${cut}…`;
}

// opaque all over, as a headset's compositor blends a layer by its alpha and the game showing through would hurt reading
export function drawXrPanel(canvas: HTMLCanvasElement, panel: XrPanel, cursor: number): XrPanelRow[] {
    const context = canvas.getContext('2d');
    if (!context) {
        return [];
    }
    const { width, height } = XR_PANEL_PIXELS;
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    context.fillStyle = COLORS.border;
    context.fillRect(0, 0, width, height);
    context.fillStyle = COLORS.background;
    context.fillRect(4, 4, width - 8, height - 8);
    context.textBaseline = 'middle';

    const inner = width - PADDING * 2;
    let y = PADDING + TITLE_SIZE / 2;
    context.font = `700 ${TITLE_SIZE}px ${FONT}`;
    context.fillStyle = COLORS.title;
    context.fillText(fit(context, panel.title, inner), PADDING, y);
    y += TITLE_SIZE / 2 + 28;

    if (panel.message?.length) {
        context.font = `400 ${MESSAGE_SIZE}px ${FONT}`;
        context.fillStyle = COLORS.text;
        for (const paragraph of panel.message) {
            for (const line of wrap(context, paragraph, inner)) {
                context.fillText(line, PADDING, y + MESSAGE_LINE / 2);
                y += MESSAGE_LINE;
            }
            y += MESSAGE_LINE / 3;
        }
        y += 12;
    }

    // the footer first, from the bottom up, so the list knows where to stop
    let bottom = height - PADDING;
    if (panel.footer?.length) {
        context.font = `400 ${FOOTER_SIZE}px ${FONT}`;
        context.fillStyle = COLORS.dim;
        const lines = panel.footer.map(line => fit(context, line, inner));
        bottom -= lines.length * FOOTER_LINE;
        lines.forEach((line, index) => context.fillText(line, PADDING, bottom + index * FOOTER_LINE + FOOTER_LINE / 2));
        if (panel.footerTitle) {
            bottom -= FOOTER_LINE;
            context.font = `600 ${FOOTER_SIZE}px ${FONT}`;
            context.fillStyle = COLORS.text;
            context.fillText(fit(context, panel.footerTitle, inner), PADDING, bottom + FOOTER_LINE / 2);
        }
        context.fillStyle = COLORS.border;
        context.fillRect(PADDING, bottom - 18, inner, 2);
        bottom -= 30;
    }

    const items = panel.items();
    // scrolled so the cursor stays in view, for a list longer than the panel
    const room = Math.max(1, Math.floor((bottom - y) / ITEM_HEIGHT));
    const first = Math.max(0, Math.min(cursor - room + 1, items.length - room));
    const rows: XrPanelRow[] = [];
    for (let index = first; index < Math.min(items.length, first + room); index++) {
        const item = items[index];
        const top = y + (index - first) * ITEM_HEIGHT;
        rows.push({ index, top, bottom: top + ITEM_HEIGHT });
        const selected = index === cursor;
        if (selected) {
            context.fillStyle = COLORS.cursor;
            context.fillRect(PADDING - 20, top + 4, inner + 40, ITEM_HEIGHT - 8);
        }
        context.font = `${selected ? 700 : 500} ${ITEM_SIZE}px ${FONT}`;
        const color = item.disabled ? COLORS.disabled : selected ? COLORS.cursorText : COLORS.text;
        let detailWidth = 0;
        if (item.detail) {
            context.font = `400 ${ITEM_SIZE * 0.8}px ${FONT}`;
            detailWidth = context.measureText(item.detail).width + 24;
            context.fillStyle = selected ? COLORS.cursorText : COLORS.dim;
            context.textAlign = 'right';
            context.fillText(item.detail, PADDING + inner, top + ITEM_HEIGHT / 2);
            context.textAlign = 'left';
            context.font = `${selected ? 700 : 500} ${ITEM_SIZE}px ${FONT}`;
        }
        context.fillStyle = color;
        context.fillText(fit(context, item.label, inner - detailWidth), PADDING, top + ITEM_HEIGHT / 2);
    }
    return rows;
}

export interface XrPanelRow {
    index: number;
    top: number;
    bottom: number;
}

export const XR_POINTER_PIXELS = { width: 64, height: 64 };

// light, ringed in dark, so it shows on either
export function drawXrPointer(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext('2d');
    if (!context) {
        return;
    }
    const { width, height } = XR_POINTER_PIXELS;
    canvas.width = width;
    canvas.height = height;
    context.beginPath();
    context.arc(width / 2, height / 2, width / 2 - 6, 0, Math.PI * 2);
    context.fillStyle = COLORS.text;
    context.fill();
    context.lineWidth = 6;
    context.strokeStyle = COLORS.background;
    context.stroke();
}

export function drawXrToast(canvas: HTMLCanvasElement, text: string, error: boolean): void {
    const context = canvas.getContext('2d');
    if (!context) {
        return;
    }
    const { width, height } = XR_TOAST_PIXELS;
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    context.fillStyle = error ? COLORS.cursor : COLORS.border;
    context.fillRect(0, 0, width, height);
    context.fillStyle = COLORS.background;
    context.fillRect(4, 4, width - 8, height - 8);
    context.font = `500 ${MESSAGE_SIZE + 4}px ${FONT}`;
    context.fillStyle = error ? COLORS.error : COLORS.text;
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    context.fillText(fit(context, text, width - PADDING * 2), width / 2, height / 2);
    context.textAlign = 'left';
}

// stays put at either end rather than wrapping, so holding the stick too long does not land on the first line
export function moveXrCursor(items: readonly XrPanelItem[], cursor: number, step: number): number {
    let next = cursor;
    for (let at = cursor + step; at >= 0 && at < items.length; at += step) {
        if (!items[at].disabled) {
            next = at;
            break;
        }
    }
    return next;
}

export function firstXrItem(items: readonly XrPanelItem[]): number {
    const index = items.findIndex(item => !item.disabled);
    return index < 0 ? 0 : index;
}
