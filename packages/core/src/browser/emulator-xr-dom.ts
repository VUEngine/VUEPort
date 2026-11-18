/**
 * The page's own interface in a headset (see emulator-xr-ui.ts), done with the page's own elements: a part of the
 * page is copied into an SVG image (foreignObject), which the browser decodes and draws into a canvas that becomes a
 * texture; and a controller's pointing becomes the events a mouse would cause on the real elements.
 *
 * Why a copy: a headset browser stops painting the page during a session (on the Quest neither animation frames nor
 * HTML-in-Canvas paint events come), but decoding an image still works. The copy keeps what CSS needs to look the same:
 * the part's ancestors as empty shells, the rules that can apply, every element's laid-out size (so text and grids
 * break where the page's do, which pointing relies on), scroll positions, typed values, and the hover, press and focus
 * states the pointer gives it.
 */

// classes standing in for the states a real mouse would give, see XrDomState
export const XR_HOVER_CLASS = 'vp-xr-hover';
export const XR_ACTIVE_CLASS = 'vp-xr-active';
export const XR_FOCUS_CLASS = 'vp-xr-focus';
export const XR_FOCUS_VISIBLE_CLASS = 'vp-xr-focus-visible';
export const XR_FOCUS_WITHIN_CLASS = 'vp-xr-focus-within';
// on <html> while a session shows the interface, see the .vp-xr-layout rules in emulator-widget.css
export const XR_LAYOUT_CLASS = 'vp-xr-layout';
// stand-ins for <html> and <body>, as inside an SVG image the root is the <svg>
const ROOT_CLASS = 'vp-xr-root';
const BODY_CLASS = 'vp-xr-body';

export interface XrDomState {
    hovered?: Element;
    pressed?: Element;
}

// menus that float free of the control they belong to (fixed to the window), so they are pointed at and placed apart
const FLOATING = '.vp-dropdown-menu';

const XHTML = 'http://www.w3.org/1999/xhtml';

// bitmaps kept for pictures the canvas draws itself: a few screens of a library's covers
const XR_BITMAP_CACHE = 240;

interface PictureClip {
    rect: DOMRect;
    radius: number;
}

// a picture the canvas draws itself rather than the copy (see drawsItself): drawn after the copy, clipped as the page
// shows it, and whatever lies over it (a card's buttons) drawn again from a second copy
interface Picture {
    page: DOMRect;
    clips: PictureClip[];
    place: DOMRect;
    bitmap?: ImageBitmap;
}

// --- the rules ----------------------------------------------------------------------------------------------------

// a style rule and the classes each of its selectors needs present before it can apply; or a group (@media, @supports,
// @layer) around more; or anything else, always kept
type CssNode =
    | { kind: 'style'; text: string; needs: string[][] }
    | { kind: 'group'; head: string; children: CssNode[] }
    | { kind: 'always'; text: string };

// states a mouse gives, turned into the classes the copy carries; the longer names first, as `:focus` begins two others
function translateSelector(selector: string): string {
    return selector
        .replace(/:hover\b/g, `.${XR_HOVER_CLASS}`)
        .replace(/:active\b/g, `.${XR_ACTIVE_CLASS}`)
        .replace(/:focus-visible\b/g, `.${XR_FOCUS_VISIBLE_CLASS}`)
        .replace(/:focus-within\b/g, `.${XR_FOCUS_WITHIN_CLASS}`)
        .replace(/:focus\b/g, `.${XR_FOCUS_CLASS}`)
        .replace(/:root\b/g, `.${ROOT_CLASS}`)
        .replace(/(^|[\s,>+~(])html(?=$|[\s.,:#[>+~)])/g, `$1.${ROOT_CLASS}`)
        .replace(/(^|[\s,>+~(])body(?=$|[\s.,:#[>+~)])/g, `$1.${BODY_CLASS}`);
}

// splits at the top level only, so `:is(.a, .b)` stays whole
function splitSelectors(list: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < list.length; index++) {
        const char = list[index];
        if (char === '(' || char === '[') {
            depth++;
        } else if (char === ')' || char === ']') {
            depth--;
        } else if (char === ',' && depth === 0) {
            parts.push(list.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(list.slice(start));
    return parts;
}

// the classes a selector cannot match without; whatever sits in parentheses or brackets (:not, :is, attributes) is
// left out, which keeps more rules than needed rather than fewer
function neededClasses(selector: string): string[] {
    let plain = '';
    let depth = 0;
    for (const char of selector) {
        if (char === '(' || char === '[') {
            depth++;
        } else if (char === ')' || char === ']') {
            depth--;
        } else if (depth === 0) {
            plain += char;
        }
    }
    return [...plain.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)]
        .map(match => match[1])
        .filter(name => name !== ROOT_CLASS && name !== BODY_CLASS && !name.startsWith('vp-xr-'));
}

// what each rule was read as, kept with the rule: styled-components adds rules as components first show (a library's
// cards while it scrolls), and reading all of the page's thousands again each time froze a headset for a moment
const ruleNodes = new WeakMap<CSSRule, CssNode>();

function readRules(rules: CSSRuleList): CssNode[] {
    const nodes: CssNode[] = [];
    for (const rule of Array.from(rules)) {
        const known = ruleNodes.get(rule);
        if (known) {
            nodes.push(known);
        } else if (rule instanceof CSSStyleRule && !(rule.cssRules?.length)) {
            const selector = translateSelector(rule.selectorText);
            const node: CssNode = {
                kind: 'style',
                text: `${selector}{${rule.style.cssText}}`,
                needs: splitSelectors(selector).map(neededClasses),
            };
            ruleNodes.set(rule, node);
            nodes.push(node);
        } else if (rule instanceof CSSKeyframesRule || !('cssRules' in rule) || rule instanceof CSSStyleRule) {
            const node: CssNode = { kind: 'always', text: translateSelector(rule.cssText) };
            ruleNodes.set(rule, node);
            nodes.push(node);
        } else {
            const text = rule.cssText;
            nodes.push({
                kind: 'group',
                head: text.slice(0, text.indexOf('{')),
                children: readRules((rule as CSSGroupingRule).cssRules),
            });
        }
    }
    return nodes;
}

function writeRules(nodes: CssNode[], present: Set<string>): string {
    let text = '';
    for (const node of nodes) {
        if (node.kind === 'style') {
            if (node.needs.some(needs => needs.every(name => present.has(name)))) {
                text += node.text;
            }
        } else if (node.kind === 'group') {
            const inner = writeRules(node.children, present);
            if (inner) {
                text += `${node.head}{${inner}}`;
            }
        } else {
            text += node.text;
        }
    }
    return text;
}

// all the page's rules, read once and again whenever their count changes (styled-components adds some as components
// first show), with every url() made data, as an SVG image loads nothing from outside
class PageRules {
    protected nodes: CssNode[] = [];
    protected count = -1;
    protected reading: Promise<void> | undefined;
    protected readonly written = new Map<string, string>();

    constructor(protected readonly data: (address: string) => Promise<string>) { }

    async for(present: Set<string>): Promise<string> {
        const count = ruleCount();
        if (count !== this.count) {
            this.count = count;
            this.reading = this.read();
            this.written.clear();
        }
        await this.reading;
        const key = [...present].sort().join(' ');
        let text = this.written.get(key);
        if (text === undefined) {
            text = writeRules(this.nodes, present);
            if (this.written.size > 64) {
                this.written.clear();
            }
            this.written.set(key, text);
        }
        return text;
    }

    protected async read(): Promise<void> {
        const nodes: CssNode[] = [];
        for (const sheet of Array.from(document.styleSheets)) {
            try {
                nodes.push(...readRules(sheet.cssRules));
            } catch {
                // another origin's sheet, closed to reading
            }
        }
        const addresses = new Set<string>();
        const collect = (list: CssNode[]): void => {
            for (const node of list) {
                if (node.kind === 'group') {
                    collect(node.children);
                } else {
                    for (const match of node.text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
                        if (!match[2].startsWith('data:') && !match[2].startsWith('#')) {
                            addresses.add(match[2]);
                        }
                    }
                }
            }
        };
        collect(nodes);
        const inlined = new Map<string, string>();
        await Promise.all([...addresses].map(address =>
            this.data(new URL(address, document.baseURI).href)
                .then(data => { inlined.set(address, data); })
                .catch(() => undefined)));
        if (inlined.size > 0) {
            const replace = (list: CssNode[]): void => {
                for (const node of list) {
                    if (node.kind === 'group') {
                        replace(node.children);
                    } else {
                        node.text = node.text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
                            (whole, _quote, address: string) => inlined.has(address)
                                ? `url("${inlined.get(address)}")`
                                : whole);
                    }
                }
            };
            replace(nodes);
        }
        this.nodes = nodes;
    }
}

function ruleCount(): number {
    let count = 0;
    for (const sheet of Array.from(document.styleSheets)) {
        try {
            count += sheet.cssRules.length;
        } catch {
            // closed to reading
        }
    }
    return count;
}

// the page's :hover and :active rules once more, for the classes the pointer puts on the real elements, so what a hover
// brings up (a cheat's eye button) is there to be pressed. Adopted as a sheet of its own, so the copy's reading of the
// page's sheets passes it by
export class XrStateSheet {
    protected readonly sheet = new CSSStyleSheet();
    protected count = -1;
    protected text = '';

    constructor() {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.sheet];
        this.refresh();
    }

    refresh(): void {
        const count = ruleCount();
        if (count === this.count) {
            return;
        }
        this.count = count;
        let text = '';
        for (const sheet of Array.from(document.styleSheets)) {
            try {
                text += stateRules(sheet.cssRules);
            } catch {
                // another origin's sheet, closed to reading
            }
        }
        // replaced only when it changed, as the whole page's styles are worked out again then
        if (text !== this.text) {
            this.text = text;
            this.sheet.replaceSync(text);
        }
    }

    dispose(): void {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== this.sheet);
    }
}

const stateTexts = new WeakMap<CSSRule, string>();

function stateRules(rules: CSSRuleList): string {
    let text = '';
    for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
            let own = stateTexts.get(rule);
            if (own === undefined) {
                own = '';
                if (!rule.cssRules?.length && /:(hover|active)\b/.test(rule.selectorText)) {
                    const selector = rule.selectorText
                        .replace(/:hover\b/g, `.${XR_HOVER_CLASS}`)
                        .replace(/:active\b/g, `.${XR_ACTIVE_CLASS}`);
                    own = `${selector}{${rule.style.cssText}}`;
                }
                stateTexts.set(rule, own);
            }
            text += own;
        } else if ('cssRules' in rule && !(rule instanceof CSSKeyframesRule)) {
            const inner = stateRules((rule as CSSGroupingRule).cssRules);
            if (inner) {
                const whole = rule.cssText;
                text += `${whole.slice(0, whole.indexOf('{'))}{${inner}}`;
            }
        }
    }
    return text;
}

// --- the copy -----------------------------------------------------------------------------------------------------

export function isTextEntry(element: Element | null | undefined): element is HTMLInputElement | HTMLTextAreaElement {
    if (element instanceof HTMLTextAreaElement) {
        return !element.readOnly && !element.disabled;
    }
    return element instanceof HTMLInputElement && !element.readOnly && !element.disabled
        && ['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''].includes(element.type);
}

export class XrDomSnapshot {
    protected readonly images = new Map<string, string>();
    protected readonly rules = new PageRules(address => this.dataUrl(address));
    protected serial = 0;
    // what the last drawing took, in milliseconds (decoding partly off the page's thread), and its sizes in characters
    timings: {
        copy: number; serialize: number; decode: number; raster: number; css: number; svg: number; pictures: number;
        drawn: number;
    } | undefined;
    protected pictureChars = 0;
    // pictures as the canvas draws them (see Picture), by address and size, the oldest first
    protected readonly bitmaps = new Map<string, Promise<ImageBitmap>>();

    // draws `element` into `canvas` at `scale` canvas pixels per CSS pixel; the canvas takes the size. Resolves to the
    // part's size in CSS pixels, or undefined where it has none (gone, hidden)
    async draw(element: HTMLElement, state: XrDomState, scale: number, canvas: HTMLCanvasElement,
        // parts of it that are drawn on their own (see XrUi), left out of this one with their places kept
        hidden: ReadonlySet<Element> = new Set()):
        Promise<{ width: number; height: number } | undefined> {
        const box = element.getBoundingClientRect();
        const width = Math.round(box.width);
        const height = Math.round(box.height);
        if (width < 1 || height < 1) {
            return undefined;
        }
        const started = performance.now();
        this.pictureChars = 0;
        const { root, overRoot, present, pictures } = await this.copy(element, box, state, scale, hidden);
        const copied = performance.now();
        const css = await this.rules.for(present);
        const svg = this.svg(root, css, width, height);
        const overSvg = overRoot ? this.svg(overRoot, css, width, height) : undefined;
        const serialized = performance.now();
        const [image, overImage] = await Promise.all([svgImage(svg), overSvg ? svgImage(overSvg) : undefined]);
        const decoded = performance.now();
        const pixelWidth = Math.max(1, Math.round(width * scale));
        const pixelHeight = Math.max(1, Math.round(height * scale));
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }
        const context = canvas.getContext('2d');
        if (!context) {
            return undefined;
        }
        context.clearRect(0, 0, pixelWidth, pixelHeight);
        context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
        for (const picture of pictures) {
            drawPicture(context, picture, scale);
        }
        if (overImage) {
            context.drawImage(overImage, 0, 0, pixelWidth, pixelHeight);
        }
        this.timings = {
            copy: copied - started,
            serialize: serialized - copied,
            decode: decoded - serialized,
            raster: performance.now() - decoded,
            css: css.length,
            svg: svg.length,
            pictures: this.pictureChars,
            drawn: pictures.length,
        };
        return { width, height };
    }

    // the part with empty copies of its ancestors around it, so rules naming an ancestor still apply; each sized as
    // the part, and stripped of whatever places or paints them
    protected async copy(element: HTMLElement, box: DOMRect, state: XrDomState, scale: number,
        hidden: ReadonlySet<Element>):
        Promise<{ root: HTMLElement; overRoot?: HTMLElement; present: Set<string>; pictures: Picture[] }> {
        const width = Math.round(box.width);
        const height = Math.round(box.height);
        const present = new Set<string>();
        // only what can be seen is copied at all: a library of hundreds of covers shows a dozen of them
        const unseen = outOfSight(element, box);
        hidden.forEach(apart => unseen.add(apart));
        const { clone, originals, clones } = cloneVisible(element, unseen);
        const { pictures, overs } = await this.fixUp(element, originals, clones, unseen, box, state, present, scale);
        clones.forEach((to, index) => {
            if (hidden.has(originals[index]) && to instanceof HTMLElement) {
                to.style.setProperty('visibility', 'hidden', 'important');
            }
        });
        const partStyle = {
            position: 'relative', inset: 'auto', margin: '0', width: `${width}px`, height: `${height}px`,
            'box-sizing': 'border-box', transform: 'none', translate: 'none', opacity: '1', visibility: 'visible',
            flex: 'none', 'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0',
        };
        setImportant(clone, partStyle);
        const root = this.wrap(element, clone, width, height, present);
        document.documentElement.classList.forEach(name => present.add(name));
        document.body.classList.forEach(name => present.add(name));
        if (overs.length === 0) {
            return { root, present, pictures };
        }
        // the second pass: only what lies over the pictures, each where it is, inside empty stand-ins for its
        // ancestors (no boxes of their own, so nothing else is laid out) for the rules that name them
        const part = element.cloneNode(false) as HTMLElement;
        setImportant(part, {
            ...partStyle, background: 'transparent', border: '0', 'box-shadow': 'none', 'backdrop-filter': 'none',
        });
        for (const { from, to } of overs) {
            const at = from.getBoundingClientRect();
            const layer = to.cloneNode(true) as HTMLElement;
            setImportant(layer, {
                position: 'absolute', left: `${at.left - box.left}px`, top: `${at.top - box.top}px`, right: 'auto',
                bottom: 'auto', margin: '0', transform: 'none', translate: 'none',
            });
            let inner: HTMLElement = layer;
            for (let ancestor = from.parentElement; ancestor && ancestor !== element; ancestor = ancestor.parentElement) {
                const shell = ancestor.cloneNode(false) as HTMLElement;
                shell.removeAttribute('style');
                setImportant(shell, { display: 'contents' });
                shell.append(inner);
                inner = shell;
            }
            part.append(inner);
        }
        return { root, overRoot: this.wrap(element, part, width, height, present), present, pictures };
    }

    protected wrap(element: HTMLElement, part: HTMLElement, width: number, height: number, present: Set<string>):
        HTMLElement {
        let root = part;
        for (let ancestor = element.parentElement; ancestor && ancestor !== document.body;
            ancestor = ancestor.parentElement) {
            ancestor.classList.forEach(name => present.add(name));
            const shell = ancestor.cloneNode(false) as HTMLElement;
            setImportant(shell, {
                display: 'block', position: 'relative', inset: 'auto', margin: '0', padding: '0', border: '0',
                width: `${width}px`, height: `${height}px`, transform: 'none', overflow: 'visible',
                background: 'transparent', opacity: '1', visibility: 'visible', flex: 'none', 'box-shadow': 'none',
                'backdrop-filter': 'none', filter: 'none',
            });
            shell.append(root);
            root = shell;
        }
        return root;
    }

    // what a copy loses: laid-out sizes, typed values, ticked boxes, scroll positions, canvas drawings, pictures from
    // elsewhere; and gains: the pointer's states. What is scrolled out of sight is left empty, kept at its size: a
    // library of hundreds of covers shows a dozen of them
    protected async fixUp(original: HTMLElement, originals: Element[], clones: Element[], unseen: Set<Element>,
        box: DOMRect, state: XrDomState, present: Set<string>, scale: number):
        Promise<{ pictures: Picture[]; overs: { from: Element; to: HTMLElement }[] }> {
        const clone = clones[0];
        const pending: Promise<void>[] = [];
        const focused = document.activeElement;
        const pictures: Picture[] = [];
        const overs: { from: Element; to: HTMLElement }[] = [];
        let over: Element | undefined;
        originals.forEach((from, index) => {
            const to = clones[index];
            // after a picture in document order, and over it: painted over it again (see Picture)
            if (pictures.length > 0 && !over?.contains(from) && from instanceof HTMLElement
                && !(from instanceof HTMLImageElement) && !from.querySelector('img')) {
                const at = from.getBoundingClientRect();
                if (pictures.some(picture => overlaps(at, picture.page)) && shows(from, state.hovered)
                    && to instanceof HTMLElement) {
                    overs.push({ from, to });
                    over = from;
                }
            }
            from.classList.forEach((name: string) => present.add(name));
            if (from === state.hovered) {
                markUp(to, clone, XR_HOVER_CLASS);
            }
            if (from === state.pressed) {
                markUp(to, clone, XR_ACTIVE_CLASS);
            }
            if (from === focused) {
                to.classList.add(XR_FOCUS_CLASS);
                if (isTextEntry(from)) {
                    to.classList.add(XR_FOCUS_VISIBLE_CLASS);
                }
                markUp(to.parentElement, clone, XR_FOCUS_WITHIN_CLASS);
            }
            if (!(from instanceof HTMLElement) || !(to instanceof HTMLElement)) {
                return;
            }
            // as laid out on the page, to the fraction of a pixel (a label that just fits must not wrap), so the copy breaks
            // lines and fills grids the same; display:inline ignores it
            if (from !== original && from.offsetParent !== null) {
                // the box as laid out, not as drawn: under a transform (the coverflow's turned covers) the rectangle
                // on screen is another size, and the layout's whole pixels are what there is
                const drawn = from.getBoundingClientRect();
                const transformed = Math.abs(drawn.width - from.offsetWidth) > 1 || Math.abs(drawn.height - from.offsetHeight) > 1;
                const laidOut = transformed ? { width: from.offsetWidth, height: from.offsetHeight } : drawn;
                to.style.setProperty('width', `${laidOut.width}px`, 'important');
                to.style.setProperty('height', `${laidOut.height}px`, 'important');
                to.style.setProperty('box-sizing', 'border-box', 'important');
                // text runs a hair wider in an SVG image: what fits here must not get an ellipsis there
                if (from.scrollWidth <= from.clientWidth && hasText(from)) {
                    to.style.setProperty('text-overflow', 'clip', 'important');
                }
            }
            if (unseen.has(from)) {
                return;
            }
            if (from instanceof HTMLInputElement) {
                to.setAttribute('value', from.value);
                if (from.checked) {
                    to.setAttribute('checked', '');
                } else {
                    to.removeAttribute('checked');
                }
            } else if (from instanceof HTMLTextAreaElement) {
                to.textContent = from.value;
            } else if (from instanceof HTMLCanvasElement) {
                to.replaceWith(canvasStandIn(from));
                return;
            } else if (from instanceof HTMLImageElement && from.currentSrc
                && (!from.complete || from.naturalWidth === 0
                    || this.drawsItself(from, original, box, scale, pictures, pending))) {
                // one still loading is left out until it has (its load draws the part again), a broken one for good
                // left to the canvas: hidden here, its place kept
                to.style.setProperty('visibility', 'hidden', 'important');
                to.removeAttribute('src');
                to.removeAttribute('srcset');
            } else if (from instanceof HTMLImageElement && from.currentSrc && !from.currentSrc.startsWith('data:')) {
                pending.push(this.pictureData(from, scale)
                    .then(data => {
                        to.setAttribute('src', data);
                        to.removeAttribute('srcset');
                        this.pictureChars += data.length;
                    })
                    .catch(() => undefined));
            } else if (from instanceof HTMLVideoElement || from instanceof HTMLIFrameElement) {
                const blank = document.createElement('div');
                blank.className = from.className;
                blank.style.cssText = to.style.cssText;
                to.replaceWith(blank);
                return;
            }
            if (from.matches(FLOATING) && from.style.position === 'fixed') {
                const at = from.getBoundingClientRect();
                to.style.left = `${at.left - box.left}px`;
                to.style.top = `${at.top - box.top}px`;
                to.style.right = 'auto';
                to.style.bottom = 'auto';
            }
            // a copy shows its content from the top; scrolled content is shifted instead, and Perfect Scrollbar's rails
            // put where they show, as it moves them only on a scroll event, which a headset session never delivers
            const scrolled = from.scrollTop !== 0 || from.scrollLeft !== 0;
            if (scrolled || from.classList.contains('ps')) {
                if (scrolled) {
                    to.style.setProperty('overflow', 'hidden', 'important');
                }
                Array.from(to.children).forEach((child, at) => {
                    const source = from.children[at];
                    if (!placeRail(from, source, child as HTMLElement) && scrolled) {
                        // on top of any shift of its own (a switch's thumb), which this would otherwise replace
                        const [x = 0, y = 0] = (source ? getComputedStyle(source).translate : 'none')
                            .split(/\s+/).map(value => parseFloat(value) || 0);
                        (child as HTMLElement).style.setProperty('translate',
                            `${x - from.scrollLeft}px ${y - from.scrollTop}px`, 'important');
                    }
                });
            }
        });
        await Promise.all(pending);
        // a picture whose bitmap could not be made is missing, rather than holding up the rest
        return { pictures: pictures.filter(picture => picture.bitmap), overs };
    }

    // whether a picture can be drawn by the canvas itself rather than go into the copy: a cover in the copy is tens of
    // KB decoded again on every drawing, here a bitmap made once. Only for pictures nothing transforms, fades or
    // filters, as this knows only rectangles, rounded corners and object-fit
    protected drawsItself(image: HTMLImageElement, part: HTMLElement, box: DOMRect, scale: number,
        pictures: Picture[], pending: Promise<void>[]): boolean {
        if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) {
            return false;
        }
        const own = getComputedStyle(image);
        if (own.visibility !== 'visible' || !untouched(own)) {
            return false;
        }
        const page = image.getBoundingClientRect();
        if (page.width === 0 || page.height === 0) {
            return false;
        }
        const relative = (rect: DOMRect): DOMRect =>
            new DOMRect(rect.left - box.left, rect.top - box.top, rect.width, rect.height);
        const clips: PictureClip[] = [{ rect: relative(page), radius: parseFloat(own.borderTopLeftRadius) || 0 }];
        for (let at = image.parentElement; at; at = at === part ? null : at.parentElement) {
            const style = getComputedStyle(at);
            if (!untouched(style)) {
                return false;
            }
            if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
                clips.push({ rect: relative(at.getBoundingClientRect()), radius: parseFloat(style.borderTopLeftRadius) || 0 });
            }
        }
        const place = fitted(relative(page), image.naturalWidth, image.naturalHeight, own.objectFit, own.objectPosition);
        // what of it shows, on the page, for telling what lies over it: not what a scrolled list hides under a bar
        const shown = clips.reduce((visible, clip) => intersection(visible, clip.rect), relative(page));
        const picture: Picture = {
            page: new DOMRect(shown.left + box.left, shown.top + box.top, shown.width, shown.height), clips, place,
        };
        pictures.push(picture);
        const width = Math.max(1, Math.min(image.naturalWidth, Math.round(place.width * scale)));
        const height = Math.max(1, Math.min(image.naturalHeight, Math.round(place.height * scale)));
        pending.push(this.bitmap(image, width, height)
            .then(bitmap => { picture.bitmap = bitmap; })
            .catch(() => undefined));
        return true;
    }

    // the picture as a bitmap of the given size, made once. Another origin's picture is fetched for it, as one the
    // page merely shows would make the canvas unreadable to WebGL
    protected bitmap(image: HTMLImageElement, width: number, height: number): Promise<ImageBitmap> {
        const address = image.currentSrc;
        const key = `${address} ${width}x${height}`;
        let made = this.bitmaps.get(key);
        if (made) {
            // the newest last, for letting go of the oldest
            this.bitmaps.delete(key);
            this.bitmaps.set(key, made);
            return made;
        }
        const resize: ImageBitmapOptions = { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' };
        const url = new URL(address, document.baseURI);
        const readable = url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === location.origin;
        made = readable
            ? createImageBitmap(image, resize)
            : fetch(address).then(response => response.blob()).then(blob => createImageBitmap(blob, resize));
        made.catch(() => this.bitmaps.delete(key));
        this.bitmaps.set(key, made);
        while (this.bitmaps.size > XR_BITMAP_CACHE) {
            const [oldest, kept] = this.bitmaps.entries().next().value as [string, Promise<ImageBitmap>];
            this.bitmaps.delete(oldest);
            kept.then(bitmap => bitmap.close()).catch(() => undefined);
        }
        return made;
    }

    protected svg(root: HTMLElement, css: string, width: number, height: number): string {
        const page = document.createElementNS(XHTML, 'div') as HTMLElement;
        for (const attribute of Array.from(document.documentElement.attributes)) {
            if (attribute.name !== 'style' && attribute.name !== 'class') {
                page.setAttribute(attribute.name, attribute.value);
            }
        }
        page.className = `${ROOT_CLASS} ${document.documentElement.className}`;
        // custom properties set from script are on the root's style, not in a rule; and what the body passes down
        const computed = getComputedStyle(document.documentElement);
        let declarations = '';
        for (let index = 0; index < computed.length; index++) {
            const name = computed[index];
            if (name.startsWith('--')) {
                declarations += `${name}:${computed.getPropertyValue(name)};`;
            }
        }
        const body = getComputedStyle(document.body);
        for (const name of ['font-family', 'font-size', 'line-height', 'color', 'color-scheme', 'letter-spacing',
            '-webkit-font-smoothing']) {
            declarations += `${name}:${body.getPropertyValue(name)};`;
        }
        // the page's ground is not the part's: what a part leaves clear stays clear, so a bar floats in the room
        page.setAttribute('style',
            `${declarations}width:${width}px;height:${height}px;overflow:hidden;margin:0;background:transparent!important`);
        const bodyShell = document.createElementNS(XHTML, 'div') as HTMLElement;
        bodyShell.className = `${BODY_CLASS} ${document.body.className}`;
        bodyShell.setAttribute('style',
            `width:${width}px;height:${height}px;margin:0;position:relative;background:transparent!important`);
        const style = document.createElementNS(XHTML, 'style');
        // nothing moves in a still picture, and a transition caught at its start would show its first frame
        style.textContent = `${css}*{animation:none!important;transition:none!important;caret-color:transparent}`;
        page.append(style, bodyShell);
        bodyShell.append(root);
        const xhtml = new XMLSerializer().serializeToString(page);
        // a new address every time, or the browser hands back the picture it decoded for the same one before
        // rem is the image's root's, the <svg>: given the page's, or everything sized in rem (the library's grid
        // tracks among it) comes out another size, and what is pointed at is not where it is drawn
        const rem = getComputedStyle(document.documentElement).fontSize;
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="font-size:${rem}">`
            + `<desc>${++this.serial}</desc>`
            + `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
    }

    // a picture at the size it is shown at (covers come a megabyte apiece, and all of it would go into the copy);
    // one the page may not read (another origin's, without leave) as it is
    protected async pictureData(image: HTMLImageElement, scale: number): Promise<string> {
        const shown = image.getBoundingClientRect();
        const natural = { width: image.naturalWidth, height: image.naturalHeight };
        if (!image.complete || natural.width === 0 || shown.width === 0 || shown.height === 0) {
            return this.dataUrl(image.currentSrc);
        }
        // covering the box either way, as object-fit may crop; never larger than it is. A picture at a CSS pixel per
        // pixel, finer than the text needs and a fraction of the bytes the copy carries for each
        const factor = Math.min(1, Math.max(shown.width / natural.width, shown.height / natural.height)
            * Math.min(scale, 1));
        const width = Math.max(1, Math.round(natural.width * factor));
        const height = Math.max(1, Math.round(natural.height * factor));
        const key = `${image.currentSrc} ${width}x${height}`;
        const cached = this.images.get(key);
        if (cached) {
            return cached;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d')!;
        context.imageSmoothingQuality = 'high';
        let data: string;
        try {
            context.drawImage(image, 0, 0, width, height);
            data = canvas.toDataURL('image/webp', 0.85);
        } catch {
            // another origin's picture, which the page shows but may not read: fetched (with leave, as the covers
            // have it) and drawn from the bytes; failing that, whole
            try {
                const bitmap = await createImageBitmap(await (await fetch(image.currentSrc)).blob());
                context.clearRect(0, 0, width, height);
                context.drawImage(bitmap, 0, 0, width, height);
                bitmap.close();
                data = canvas.toDataURL('image/webp', 0.85);
            } catch {
                return this.dataUrl(image.currentSrc);
            }
        }
        this.images.set(key, data);
        return data;
    }

    protected async dataUrl(address: string): Promise<string> {
        const cached = this.images.get(address);
        if (cached) {
            return cached;
        }
        const blob = await (await fetch(address)).blob();
        const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
        this.images.set(address, data);
        return data;
    }
}

async function svgImage(svg: string): Promise<HTMLImageElement> {
    const image = new Image();
    image.decoding = 'async';
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    return image;
}

// a copy of `root` and its descendants, except those of what is out of sight, which is copied empty; with the
// elements of both in the same order (document order), the original's next to its copy's
function cloneVisible(root: Element, unseen: Set<Element>): { clone: HTMLElement; originals: Element[]; clones: Element[] } {
    const originals: Element[] = [];
    const clones: Element[] = [];
    const copy = (from: Element): Element => {
        const to = from.cloneNode(false) as Element;
        originals.push(from);
        clones.push(to);
        if (!unseen.has(from)) {
            for (let child = from.firstChild; child; child = child.nextSibling) {
                if (child.nodeType === Node.ELEMENT_NODE) {
                    to.appendChild(copy(child as Element));
                } else if (child.nodeType === Node.TEXT_NODE) {
                    to.appendChild(child.cloneNode(false));
                }
            }
        }
        return to;
    };
    return { clone: copy(root) as HTMLElement, originals, clones };
}

// whether an element shows, or may for the pointer: an overlay a hover brings up (a card's buttons over its cover) is
// hidden on the page, where nothing hovers, and shown in the copy
function shows(element: Element, hovered: Element | undefined): boolean {
    const style = getComputedStyle(element);
    if (style.visibility === 'visible' && style.opacity !== '0' && style.display !== 'none') {
        return true;
    }
    let near: Element | null = element;
    for (let level = 0; near && hovered && level < 4; level++, near = near.parentElement) {
        if (near.contains(hovered)) {
            return true;
        }
    }
    return false;
}

function untouched(style: CSSStyleDeclaration): boolean {
    return style.transform === 'none' && style.filter === 'none' && style.opacity === '1'
        && (style.translate === 'none' || style.translate === '') && (style.scale === 'none' || style.scale === '')
        && (style.rotate === 'none' || style.rotate === '');
}

function fitted(box: DOMRect, naturalWidth: number, naturalHeight: number, fit: string, position: string): DOMRect {
    let factor: number | undefined;
    const contain = Math.min(box.width / naturalWidth, box.height / naturalHeight);
    if (fit === 'contain') {
        factor = contain;
    } else if (fit === 'cover') {
        factor = Math.max(box.width / naturalWidth, box.height / naturalHeight);
    } else if (fit === 'none') {
        factor = 1;
    } else if (fit === 'scale-down') {
        factor = Math.min(1, contain);
    }
    if (factor === undefined) {
        return box;
    }
    const width = naturalWidth * factor;
    const height = naturalHeight * factor;
    const [x = '50%', y = '50%'] = position.split(/\s+/);
    const offset = (value: string, room: number): number =>
        value.endsWith('%') ? room * parseFloat(value) / 100 : parseFloat(value) || 0;
    return new DOMRect(box.left + offset(x, box.width - width), box.top + offset(y, box.height - height), width, height);
}

function drawPicture(context: CanvasRenderingContext2D, picture: Picture, scale: number): void {
    const { bitmap, clips, place } = picture;
    if (!bitmap) {
        return;
    }
    context.save();
    context.scale(scale, scale);
    for (const { rect, radius } of clips) {
        context.beginPath();
        context.roundRect(rect.left, rect.top, rect.width, rect.height, radius);
        context.clip();
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, place.left, place.top, place.width, place.height);
    context.restore();
}

// a Perfect Scrollbar rail of a scrolled `container`, copied: at the container's edge, its thumb as far along as the
// content is scrolled. False for anything else
function placeRail(container: Element, original: Element | undefined, rail: HTMLElement): boolean {
    const vertical = rail.classList.contains('ps__rail-y');
    if (!vertical && !rail.classList.contains('ps__rail-x')) {
        return false;
    }
    const thumbClass = vertical ? '.ps__thumb-y' : '.ps__thumb-x';
    const thumb = rail.querySelector<HTMLElement>(thumbClass);
    // measured on the page, as the copy is not laid out
    const measured = original?.querySelector<HTMLElement>(thumbClass);
    const visible = vertical ? container.clientHeight : container.clientWidth;
    const total = vertical ? container.scrollHeight : container.scrollWidth;
    if (total <= visible + 1) {
        rail.style.setProperty('display', 'none', 'important');
        return true;
    }
    rail.style.setProperty('display', 'block', 'important');
    rail.style.setProperty(vertical ? 'height' : 'width', `${visible}px`, 'important');
    if (vertical) {
        rail.style.top = '0px';
        rail.style.bottom = 'auto';
        rail.style.right = '0px';
    } else {
        rail.style.left = '0px';
        rail.style.right = 'auto';
        rail.style.bottom = '0px';
        rail.style.top = 'auto';
    }
    if (thumb) {
        const scrolled = vertical ? container.scrollTop : container.scrollLeft;
        // as Perfect Scrollbar sizes it, at least 20 pixels; or as it last measured, where it did
        const length = Math.max(20, measured && (vertical ? measured.offsetHeight : measured.offsetWidth)
            || Math.round(visible * visible / total));
        const along = scrolled * (visible - length) / (total - visible);
        thumb.style.setProperty(vertical ? 'height' : 'width', `${length}px`, 'important');
        thumb.style.setProperty(vertical ? 'top' : 'left', `${Math.max(0, along)}px`, 'important');
    }
    return true;
}

// the elements under `root` lying wholly outside what can be seen of it: the part's box, narrowed by every element
// in between that scrolls (and so clips). Not their descendants, which go with them; nothing holding a floating menu,
// which shows outside its own box. A wrapper without a box of its own (display: contents) is looked into
function outOfSight(root: Element, box: DOMRect): Set<Element> {
    const unseen = new Set<Element>();
    const visit = (element: Element, clip: DOMRect): void => {
        for (const child of Array.from(element.children)) {
            const rect = child.getBoundingClientRect();
            const boxed = rect.width > 0 || rect.height > 0;
            if (boxed && !overlaps(rect, clip) && !child.querySelector(FLOATING)) {
                unseen.add(child);
                continue;
            }
            let within = clip;
            if (boxed && (child.scrollHeight > child.clientHeight + 1 || child.scrollWidth > child.clientWidth + 1)) {
                const style = getComputedStyle(child);
                if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
                    within = intersection(clip, rect);
                }
            }
            visit(child, within);
        }
    };
    visit(root, box);
    return unseen;
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function intersection(a: DOMRect, b: DOMRect): DOMRect {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    return new DOMRect(left, top, Math.max(0, Math.min(a.right, b.right) - left),
        Math.max(0, Math.min(a.bottom, b.bottom) - top));
}

function hasText(element: Element): boolean {
    for (let node = element.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
            return true;
        }
    }
    return false;
}

function setImportant(element: HTMLElement, properties: Record<string, string>): void {
    for (const [name, value] of Object.entries(properties)) {
        element.style.setProperty(name, value, 'important');
    }
}

// the element and its ancestors up to the part, as :hover and :active apply to all of them
function markUp(element: Element | null, root: Element, name: string): void {
    for (let at = element; at; at = at === root ? null : at.parentElement) {
        at.classList.add(name);
    }
}

// a small canvas as a picture of what it shows; a large one (a game screen) left blank, as reading it back is slow
// and the headset shows the game itself
function canvasStandIn(canvas: HTMLCanvasElement): HTMLElement {
    let standIn: HTMLElement = document.createElement('div');
    if (canvas.width * canvas.height <= 512 * 512 && canvas.width > 0 && canvas.height > 0) {
        try {
            const image = document.createElement('img');
            image.src = canvas.toDataURL();
            standIn = image;
        } catch {
            // tainted or lost: blank
        }
    }
    standIn.className = canvas.className;
    standIn.style.cssText = canvas.style.cssText;
    standIn.style.width = `${canvas.offsetWidth}px`;
    standIn.style.height = `${canvas.offsetHeight}px`;
    standIn.style.display = getComputedStyle(canvas).display;
    return standIn;
}

// --- pointing -----------------------------------------------------------------------------------------------------

function contains(rect: DOMRect, x: number, y: number): boolean {
    return rect.width > 0 && rect.height > 0 && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

// the deepest element under a point that takes the pointer, last drawn first; a parent that does not take it may
// still have children that do (the screen's overlay layer)
function deepest(element: Element, x: number, y: number, skip: ReadonlySet<Element>): Element | undefined {
    const children = element.children;
    for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (skip.has(child)) {
            continue;
        }
        const box = child.getBoundingClientRect();
        if (!contains(box, x, y)) {
            // a wrapper with no box of its own (display: contents) holds what is under the point all the same
            if (box.width === 0 && box.height === 0 && getComputedStyle(child).display === 'contents') {
                const within = deepest(child, x, y, skip);
                if (within) {
                    return within;
                }
            }
            continue;
        }
        const style = getComputedStyle(child);
        if (style.display === 'none' || style.visibility === 'hidden') {
            continue;
        }
        const inner = deepest(child, x, y, skip);
        if (inner) {
            return inner;
        }
        if (style.pointerEvents !== 'none') {
            return child;
        }
    }
    return undefined;
}

// worked out from the layout rather than with elementFromPoint, as in a session the page's parts are laid out on top of
// each other and partly outside the window, and only the part pointed at in the headset counts
export function xrDomTarget(root: Element, x: number, y: number, skip: ReadonlySet<Element> = new Set()): Element {
    const outside = (element: Element): boolean => ![...skip].some(part => part.contains(element));
    const floating = Array.from(root.querySelectorAll(FLOATING)).filter(outside).reverse();
    for (const menu of floating) {
        if (contains(menu.getBoundingClientRect(), x, y)) {
            return deepest(menu, x, y, skip) ?? menu;
        }
    }
    return deepest(root, x, y, skip) ?? root;
}

function focusTarget(element: Element): HTMLElement | undefined {
    return element.closest<HTMLElement>(
        'input, textarea, select, button, a[href], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')
        ?? undefined;
}

function rangeOf(element: Element): HTMLInputElement | undefined {
    const control = element.closest('input');
    return control instanceof HTMLInputElement && control.type === 'range' && !control.disabled ? control : undefined;
}

// a value set the way typing or dragging sets it: past React's own record of the value, then announced
export function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
}

// a mouse made of a controller: moves, presses and releases become the pointer and mouse events a real one causes, so
// React's handlers run as usual. Focus follows a press, a range input follows the pointer while pressed, the stick
// scrolls
export class XrDomPointer {
    hovered: Element | undefined;
    pressed: Element | undefined;
    protected dragging: HTMLInputElement | undefined;
    protected pressedAt = { x: 0, y: 0 };
    protected movedTo = { x: NaN, y: NaN };
    protected scrollRemainder = 0;

    // the pointer is over `target` at page coordinates (x, y); true when that changes what it is over
    move(target: Element | undefined, x: number, y: number): boolean {
        const before = this.hovered;
        if (target !== before) {
            if (before) {
                fire(before, 'pointerout', x, y, target);
                fire(before, 'mouseout', x, y, target);
            }
            this.hovered = target;
            markChain(before, target, XR_HOVER_CLASS);
            if (target) {
                fire(target, 'pointerover', x, y, before);
                fire(target, 'mouseover', x, y, before);
            }
        }
        // a pointer held still sends nothing, as a mouse would not: a move is handled by the page every time
        if (target && (target !== before || Math.abs(x - this.movedTo.x) >= 0.5 || Math.abs(y - this.movedTo.y) >= 0.5)) {
            this.movedTo = { x, y };
            fire(target, 'pointermove', x, y);
            fire(target, 'mousemove', x, y);
        }
        if (this.dragging) {
            slide(this.dragging, x);
        }
        return target !== before;
    }

    press(target: Element, x: number, y: number): void {
        markChain(this.pressed, target, XR_ACTIVE_CLASS);
        this.pressed = target;
        this.pressedAt = { x, y };
        const pointer = fire(target, 'pointerdown', x, y, undefined, 1);
        const mouse = fire(target, 'mousedown', x, y, undefined, 1);
        // a press whose default was prevented moves no focus, as with a mouse (the command palette's list keeps the
        // focus in its filter that way)
        const focus = focusTarget(target);
        if (!pointer || !mouse) {
        } else if (focus) {
            focus.focus({ preventScroll: true });
        } else if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
            document.activeElement.blur();
        }
        const range = rangeOf(target);
        if (range) {
            this.dragging = range;
            slide(range, x);
        }
    }

    // a click where it was pressed, as a mouse makes one only on the element pressed. A hand shakes as it pulls a
    // trigger, so a release that has wandered a little off the element still clicks it, where it was pressed
    release(target: Element | undefined, x: number, y: number): void {
        const pressed = this.pressed;
        this.pressed = undefined;
        markChain(pressed, undefined, XR_ACTIVE_CLASS);
        const where = target ?? pressed;
        if (where) {
            fire(where, 'pointerup', x, y);
            fire(where, 'mouseup', x, y);
        }
        if (this.dragging) {
            this.dragging.dispatchEvent(new Event('change', { bubbles: true }));
            this.dragging = undefined;
        } else if (pressed && target && (pressed === target || pressed.contains(target) || target.contains(pressed))) {
            fire(pressed.contains(target) ? pressed : target, 'click', x, y);
        } else if (pressed?.isConnected && target
            && Math.hypot(x - this.pressedAt.x, y - this.pressedAt.y) <= XR_CLICK_SLOP) {
            fire(pressed, 'click', this.pressedAt.x, this.pressedAt.y);
        }
    }

    leave(): void {
        if (this.hovered) {
            fire(this.hovered, 'pointerout', 0, 0);
            fire(this.hovered, 'mouseout', 0, 0);
        }
        markChain(this.hovered, undefined, XR_HOVER_CLASS);
        this.hovered = undefined;
        if (this.pressed) {
            this.release(undefined, 0, 0);
        }
    }

    // by `pixels` (unrounded, accumulated), in whatever scrolls under the pointer; true if anything moved
    scroll(within: Element, pixels: number): boolean {
        const target = this.hovered;
        if (!target) {
            return false;
        }
        for (let at: Element | null = target; at; at = at === within ? null : at.parentElement) {
            if (at.scrollHeight <= at.clientHeight + 1) {
                continue;
            }
            const overflow = getComputedStyle(at).overflowY;
            // Perfect Scrollbar hides the browser's own bar and scrolls by scrollTop all the same
            if (overflow !== 'auto' && overflow !== 'scroll' && !at.classList.contains('ps')) {
                continue;
            }
            this.scrollRemainder += pixels;
            const whole = Math.trunc(this.scrollRemainder);
            if (whole === 0) {
                return false;
            }
            this.scrollRemainder -= whole;
            const before = at.scrollTop;
            at.scrollTop = before + whole;
            return at.scrollTop !== before;
        }
        return false;
    }
}

// CSS pixels a pointer may move between press and release and still click what it pressed: about 3 cm where the
// interface stands, a degree of the hand turning as it pulls a trigger
const XR_CLICK_SLOP = 24;

// a state class off one element and its ancestors and onto another and its, as :hover and :active apply to all of
// them; only where it changes, as every change is drawn again
function markChain(from: Element | undefined, to: Element | undefined, name: string): void {
    const chain = (element: Element | undefined): Set<Element> => {
        const all = new Set<Element>();
        for (let at = element; at && at !== document.body; at = at.parentElement ?? undefined) {
            all.add(at);
        }
        return all;
    };
    const old = chain(from);
    const now = chain(to);
    old.forEach(element => {
        if (!now.has(element)) {
            element.classList.remove(name);
        }
    });
    now.forEach(element => {
        if (!old.has(element)) {
            element.classList.add(name);
        }
    });
}

// true unless a handler prevented the default
function fire(target: Element, type: string, x: number, y: number, related?: Element, buttons = 0): boolean {
    const init: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons,
        relatedTarget: related ?? null,
        view: window,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
    };
    // enter and leave do not bubble; React works them out from over and out
    return target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init));
}

function slide(range: HTMLInputElement, x: number): void {
    const box = range.getBoundingClientRect();
    if (box.width <= 0) {
        return;
    }
    const min = Number(range.min || 0);
    const max = Number(range.max || 100);
    const step = range.step === 'any' ? 0 : Number(range.step || 1);
    const share = Math.min(1, Math.max(0, (x - box.left) / box.width));
    let value = min + share * (max - min);
    if (step > 0) {
        value = min + Math.round((value - min) / step) * step;
    }
    const text = String(Number(value.toFixed(6)));
    if (text !== range.value) {
        setControlValue(range, text);
        range.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

// a key as a keyboard gives it, to whatever has focus (Escape, Enter, arrows); true if nobody prevented its default
export function pressXrKey(key: string): boolean {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true, composed: true, view: window };
    const allowed = target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return allowed;
}
