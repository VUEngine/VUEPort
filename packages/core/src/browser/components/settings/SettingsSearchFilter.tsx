import * as React from 'react';

/**
 * The settings search for a hand-written pane, which unlike the schema-backed panes (SettingsFields) has no list of its
 * settings, so this reads them off the page. A row is one of the shared setting layouts (ROW). A fieldset shows in full
 * when its legend matches, otherwise only its matching rows, and is hidden when none matches. Anything else stays when
 * its own text matches. When nothing matches at all, everything is shown, as the query was then meant for the pane's
 * label or keywords. The page is read again on every change below it, as panes redraw by themselves.
 */
export function SettingsSearchFilter(props: {
    search: string,
    children: React.ReactNode,
}): React.JSX.Element {
    const root = React.useRef<HTMLDivElement>(null);
    const { search } = props;

    React.useLayoutEffect(() => {
        const element = root.current;
        if (!element) {
            return;
        }
        const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
        const apply = (): void => {
            element.querySelectorAll(`[${HIDDEN}]`).forEach(each => each.removeAttribute(HIDDEN));
            if (terms.length === 0) {
                return;
            }
            const hidden: Element[] = [];
            if (filter(element, terms, hidden)) {
                hidden.forEach(each => each.setAttribute(HIDDEN, ''));
            }
        };
        apply();
        // attributes are not watched, so marking rows does not call this again
        const observer = new MutationObserver(apply);
        observer.observe(element, { childList: true, subtree: true, characterData: true });
        return () => observer.disconnect();
    }, [search]);

    return <div ref={root} style={{ display: 'contents' }}>{props.children}</div>;
}

const HIDDEN = 'data-settings-search-hidden';

const ROW = '.vp-bool-setting, .vp-range-setting, .vp-select-setting, .vp-appearance-row';

// words in its fields count too, e.g. the Achievements sign-in's placeholders and labels
function matches(element: Element, terms: string[]): boolean {
    const named = Array.from(element.querySelectorAll('[placeholder], [aria-label]'), each =>
        `${each.getAttribute('placeholder') ?? ''} ${each.getAttribute('aria-label') ?? ''}`);
    const text = [element.textContent ?? '', ...named].join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
}

// collects the elements the query hides below `container` into `hidden`; true if anything there stays visible
function filter(container: Element, terms: string[], hidden: Element[]): boolean {
    let any = false;
    for (const child of Array.from(container.children)) {
        let shows: boolean;
        if (child.tagName === 'LEGEND') {
            continue;
        } else if (child.tagName === 'FIELDSET') {
            const legend = child.querySelector(':scope > legend');
            shows = (legend !== null && matches(legend, terms)) || filter(child, terms, hidden);
        } else if (child.matches(ROW)) {
            shows = matches(child, terms);
        } else if (child.querySelector(`${ROW}, fieldset`)) {
            shows = filter(child, terms, hidden);
        } else {
            shows = matches(child, terms);
        }
        if (shows) {
            any = true;
        } else {
            hidden.push(child);
        }
    }
    return any;
}
