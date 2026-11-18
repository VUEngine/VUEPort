import { Play, X } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { VB_FRAME_RATE, VB_SCREEN_HEIGHT, VB_SCREEN_WIDTH } from '../../common/vb-constants';
import { EmulatorRewindBrowser } from '../emulator-rewind-browser';

export interface EmulatorRewindStripProps {
    browser: EmulatorRewindBrowser;
}

const PAGE_THUMBNAILS = 10;

// "−0:12.34", time before the moment the strip was opened, empty at that moment itself. In hundredths, as a frame
// is two of them and Shift steps single frames
function formatBack(seconds: number): string {
    const hundredths = Math.round(seconds * 100);
    if (hundredths === 0) {
        return '';
    }
    const minutes = Math.floor(hundredths / 6000);
    const rest = (hundredths % 6000) / 100;
    return `−${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

// a key typed into something, or meant for a window over the strip, is not for it
function isForSomethingElse(event: KeyboardEvent): boolean {
    const target = event.target;
    if (target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        return true;
    }
    return document.querySelector('.vp-modal-backdrop, [aria-modal="true"]') !== null;
}

// the rewind history as thumbnails along the bottom of the picture, replacing the control strip while open; the picture
// shows the picked moment. Keys are caught on the window first, as the emulator's key handling is off meanwhile.
// Subscribes to the browser itself, so an arriving thumbnail redraws only this
export function EmulatorRewindStrip(props: EmulatorRewindStripProps): React.JSX.Element | null {
    const { browser } = props;
    const [, setVersion] = React.useState(0);
    React.useEffect(() => {
        const listener = browser.onDidChange(() => setVersion(version => version + 1));
        return () => listener.dispose();
    }, [browser]);

    const history = browser.history;
    const cursor = browser.cursor;
    const film = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (!history) {
            return undefined;
        }
        const keydown = (event: KeyboardEvent): void => {
            if (event.ctrlKey || event.metaKey || event.altKey || isForSomethingElse(event)) {
                return;
            }
            switch (event.code) {
                case 'ArrowLeft':
                    if (event.shiftKey) {
                        browser.step(-1);
                    } else {
                        browser.stepThumbnail(-1);
                    }
                    break;
                case 'ArrowRight':
                    if (event.shiftKey) {
                        browser.step(1);
                    } else {
                        browser.stepThumbnail(1);
                    }
                    break;
                case 'PageUp':
                    browser.stepThumbnail(-PAGE_THUMBNAILS);
                    break;
                case 'PageDown':
                    browser.stepThumbnail(PAGE_THUMBNAILS);
                    break;
                case 'Home':
                    browser.seek(0);
                    break;
                case 'End':
                    browser.seek(history.frames.length - 1);
                    break;
                case 'Enter':
                case 'NumpadEnter':
                case 'Space':
                    if (!event.repeat) {
                        browser.resume();
                    }
                    break;
                case 'Escape':
                case 'Backspace':
                    if (!event.repeat) {
                        browser.cancel();
                    }
                    break;
                default:
                    return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        window.addEventListener('keydown', keydown, true);
        return () => window.removeEventListener('keydown', keydown, true);
    }, [browser, history]);

    // the thumbnail standing for the cursor: the nearest, as the cursor can sit between two when stepping by frames
    const thumbnails = history?.thumbnails ?? [];
    let selected = thumbnails.length - 1;
    for (let i = 0; i < thumbnails.length; i++) {
        if (Math.abs(thumbnails[i] - cursor) < Math.abs(thumbnails[selected] - cursor)) {
            selected = i;
        }
    }

    // kept centred on the pick; at once when the strip opens, gliding after
    const opened = React.useRef(false);
    React.useLayoutEffect(() => {
        const strip = film.current;
        const frame = strip?.querySelectorAll<HTMLElement>('.vp-rewind-frame')[selected];
        if (!strip || !frame) {
            opened.current = false;
            return;
        }
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        strip.scrollTo({
            left: frame.offsetLeft - (strip.clientWidth - frame.offsetWidth) / 2,
            behavior: opened.current && !reduced ? 'smooth' : 'auto',
        });
        opened.current = true;
    }, [selected, history]);

    if (!history) {
        return null;
    }

    const newest = history.frames[history.cursor];
    // spoken label per thumbnail; the newest one has no time offset, so it is called "Now"
    const back = (capture: number): string => formatBack((newest - history.frames[capture]) / VB_FRAME_RATE)
        || nls.localize('vueport/rewind/now', 'Now');

    return <div
        className='vp-rewind-strip'
        role='dialog'
        aria-label={nls.localize('vueport/rewind/history', 'Rewind history')}
    >
        <div className='vp-rewind-bar'>
            <span className='vp-rewind-time' aria-live='polite'>{formatBack(browser.secondsBack)}</span>
            <span className='vp-rewind-hint'>
                {nls.localize('vueport/rewind/hint', '← → pick a moment · Shift for single frames')}
            </span>
            <div className='vp-rewind-actions'>
                <button className='vp-rewind-button' onClick={() => browser.cancel()}>
                    <X size={16} />
                    {nls.localize('vueport/state/cancel', 'Cancel')}
                </button>
                <button className='vp-rewind-button vp-rewind-button-primary' onClick={() => browser.resume()}>
                    <Play size={16} weight='fill' />
                    {nls.localize('vueport/rewind/resume', 'Play from Here')}
                </button>
            </div>
        </div>
        <div
            ref={film}
            // not .vp-scroll: a strip scrolled by its pick needs no bar, and would get Perfect Scrollbar's rails
            className='vp-rewind-film'
            role='listbox'
            aria-label={nls.localize('vueport/rewind/history', 'Rewind history')}
            aria-orientation='horizontal'
            // a mouse wheel turns vertically, and a strip only scrolls across
            onWheel={event => {
                if (film.current && event.deltaX === 0) {
                    film.current.scrollLeft += event.deltaY;
                }
            }}
        >
            {thumbnails.map((capture, index) => {
                const url = browser.thumbnailUrl(capture);
                return <button
                    key={capture}
                    className={'vp-rewind-frame' + (index === selected ? ' vp-rewind-frame-selected' : '')}
                    role='option'
                    aria-selected={index === selected}
                    aria-label={back(capture)}
                    tabIndex={-1}
                    style={{ aspectRatio: `${VB_SCREEN_WIDTH} / ${VB_SCREEN_HEIGHT}` }}
                    onClick={() => index === selected && capture === cursor
                        ? browser.resume()
                        : browser.seek(capture)}
                >
                    {url && <img src={url} alt='' draggable={false} />}
                </button>;
            })}
        </div>
    </div>;
}
