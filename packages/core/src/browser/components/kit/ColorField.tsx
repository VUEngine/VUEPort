import React from 'react';
import { createPortal } from 'react-dom';
import type { ColorResult } from 'react-color';
import styled from 'styled-components';
import { pushEscapeLayer } from './escape-layers';

// react-color (about 90 KB) is loaded when a picker is first opened, as most sessions never touch a color well
const ChromePicker = React.lazy(async () => ({
    default: (await import('react-color')).ChromePicker,
}));

// `$large` rather than `large`, as styled-components passes anything else on to the DOM and React warns
const Well = styled.button<{ $large?: boolean }>`
    background: var(--vp-bg);
    border: var(--vp-border-width) solid var(--vp-control);
    border-radius: var(--vp-radius-large);
    box-sizing: border-box;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    height: ${p => p.$large ? '112px' : '30px'};
    padding: ${p => p.$large ? 'var(--vp-space)' : '2px'};
    gap: var(--vp-space);
    width: ${p => p.$large ? '128px' : '56px'};

    &:disabled {
        cursor: default;
        opacity: 0.5;
    }

    &:not(:disabled):hover,
    &:not(:disabled):focus-visible {
        border-color: var(--vp-accent);
        outline: none;
    }
`;

const Fill = styled.span`
    border-radius: var(--vp-radius);
    display: block;
    height: 100%;
    width: 100%;
`;

const Cover = styled.div`
    inset: 0;
    position: fixed;
    z-index: 10000;
`;

// rendered into document.body with fixed coordinates, so the scrolling dialog never clips it. react-color paints
// the picker with a fixed light palette in inline styles, so surfaces, text and borders are overridden with the
// kit's tokens (!important) to follow the theme
const Popover = styled.div`
    position: fixed;
    z-index: 10001;

    .chrome-picker {
        background: var(--vp-panel) !important;
        border: 1px solid var(--vp-line) !important;
        border-radius: var(--vp-radius-large) !important;
        box-shadow: 0 4px 16px var(--vp-shadow) !important;
        font-family: var(--vp-font-ui) !important;
    }

    /* The HEX / R / G / B entry fields. */
    .chrome-picker input {
        background: var(--vp-bg) !important;
        box-shadow: inset 0 0 0 1px var(--vp-control) !important;
        color: var(--vp-text) !important;
    }

    /* Their captions, and the mode toggle's chevron. */
    .chrome-picker span {
        color: var(--vp-text-dim) !important;
    }

    .chrome-picker svg {
        fill: var(--vp-text-dim) !important;
    }

    .chrome-picker svg:hover {
        background: var(--vp-hover) !important;
    }
`;

const PICKER_WIDTH = 225;
const PICKER_HEIGHT = 270;
const GAP = 4;

// quiet time before a color is passed on, and the longest a drag may go without one. react-color reports every
// pointer move, and a palette change crosses to the worker and redraws, so 60 a second would pile up a queue
const PREVIEW_MS = 90;
const PREVIEW_MAX_MS = 220;

// the same for the stored color: longer and without a ceiling, one write per gesture; flushed when the picker closes
const COMMIT_MS = 250;

interface Settled {
    (hex: string): void;
    flush(): void;
    cancel(): void;
}

// debounce with a ceiling of `most` ms, which Utils.debounce lacks, so a drag that never pauses still shows
// something. Always calls the current `fn`, so a handler is not held to an old render's props
function useSettled(
    fn: ((hex: string) => void) | undefined,
    wait: number,
    most?: number,
): Settled {
    const call = React.useRef(fn);
    call.current = fn;

    return React.useMemo<Settled>(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let since = 0;
        let waiting: string | undefined;

        const send = (): void => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            const hex = waiting;
            waiting = undefined;
            since = 0;
            if (hex !== undefined) {
                call.current?.(hex);
            }
        };

        const push = ((hex: string) => {
            const now = Date.now();
            waiting = hex;
            if (since === 0) {
                since = now;
            }
            if (most !== undefined && now - since >= most) {
                send();
                return;
            }
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            timer = setTimeout(send, most === undefined
                ? wait
                : Math.min(wait, since + most - now));
        }) as Settled;

        push.flush = send;
        push.cancel = () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            waiting = undefined;
            since = 0;
        };
        return push;
    }, [wait, most]);
}

interface ColorFieldProps {
    value: string; // #rrggbb
    onChange: (hex: string) => void; // once the picker has come to rest, or at once when it closes (see COMMIT_MS)
    // live preview while dragging; throttled (see PREVIEW_MS), not a place to persist
    onPreview?: (hex: string) => void;
    disabled?: boolean;
    large?: boolean;
    title?: string;
    // for one of several wells to choose from (a brush's colors): a click selects, a double click opens the picker
    onSelect?: () => void;
}

// a color well that opens react-color's Chrome picker rather than the native <input type="color">; a transparent cover
// behind the picker closes it on an outside click, as does Escape
export default function ColorField(props: ColorFieldProps): React.JSX.Element {
    const { value, onChange, onPreview, disabled, large, title, onSelect } = props;
    const [open, setOpen] = React.useState(false);
    const [at, setAt] = React.useState<{ top: number, left: number }>();
    // react-color derives its state from the color prop on every render, so a color held back while the debounced
    // calls settle would snap the handle from under the pointer. Only while open, when nothing else can change it
    const [draft, setDraft] = React.useState<string>();
    const wellRef = React.useRef<HTMLButtonElement>(null);

    const safe = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
    const shown = draft ?? safe;

    const preview = useSettled(onPreview, PREVIEW_MS, PREVIEW_MAX_MS);
    const commit = useSettled(onChange, COMMIT_MS);

    const place = React.useCallback(() => {
        const rect = wellRef.current?.getBoundingClientRect();
        if (!rect) {
            return;
        }
        const left = Math.max(GAP, Math.min(
            rect.left, window.innerWidth - PICKER_WIDTH - GAP));
        const below = rect.bottom + GAP;
        const top = below + PICKER_HEIGHT > window.innerHeight - GAP
            ? Math.max(GAP, rect.top - GAP - PICKER_HEIGHT)
            : below;
        setAt({ top, left });
    }, []);

    React.useLayoutEffect(() => {
        if (open) {
            place();
        }
    }, [open, place]);

    React.useEffect(() => {
        if (!open) {
            return undefined;
        }
        // a layer of its own so one Escape closes the picker and leaves its window open (see escape-layers)
        const layer = pushEscapeLayer();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && layer.isTop()) {
                event.stopPropagation();
                setOpen(false);
            }
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', place);
        // capture, as a scroll in any container between the well and the viewport moves the well
        window.addEventListener('scroll', place, true);
        return () => {
            layer.dispose();
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [open, place]);

    // on close, commit at once and drop preview and draft, so the well shows what was actually stored, snapped to
    // what the hardware can show
    React.useEffect(() => {
        if (!open) {
            preview.cancel();
            commit.flush();
            setDraft(undefined);
        }
    }, [open, preview, commit]);

    // the same for a well that unmounts with a color still pending
    React.useEffect(() => () => {
        preview.cancel();
        commit.flush();
    }, [preview, commit]);

    return <>
        <Well
            ref={wellRef}
            type='button'
            disabled={disabled}
            $large={large}
            aria-label={title}
            aria-haspopup='dialog'
            aria-expanded={open}
            title={title}
            onClick={() => !disabled && (onSelect ? onSelect() : setOpen(current => !current))}
            onDoubleClick={() => !disabled && onSelect && setOpen(true)}
        >
            <Fill style={{ background: shown }} />
            {large && <>{shown.toUpperCase()}</>}
        </Well>
        {open && at && createPortal(
            <>
                <Cover data-color-picker onClick={() => setOpen(false)} />
                <Popover data-color-picker style={at} onKeyDown={e => e.stopPropagation()}>
                    {/* no fallback: the chunk is cached after the first open, and the cover makes the well read as open */}
                    <React.Suspense fallback={null}>
                        <ChromePicker
                            color={shown}
                            disableAlpha
                            // not onChangeComplete, which only has react-color's own 100 ms debounce and would
                            // mean ten settings writes and swatch re-renders a second while dragging
                            onChange={(result: ColorResult) => {
                                setDraft(result.hex);
                                preview(result.hex);
                                commit(result.hex);
                            }}
                        />
                    </React.Suspense>
                </Popover>
            </>,
            document.body,
        )}
    </>;
}
