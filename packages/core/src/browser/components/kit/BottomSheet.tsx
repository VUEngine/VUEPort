import * as React from 'react';
import { pushEscapeLayer } from './escape-layers';
import { pushBackHandler } from '../../back-navigation';

const DISMISS_DISTANCE = 80; // how far the handle has to be pulled down to close the sheet on release, in CSS pixels
// a swipe anywhere closes it too if it is quick, mostly downwards and starts where nothing is scrolled
const SWIPE_MS = 700;
const SWIPE_STRAY = 0.6;
const LEAVE_MS = 200; // slide-away time; the host gets onClose after that

// phone sheet sliding up over a dimmed page, for the menu and the panels that sit beside the screen on larger
// displays. Closed by the backdrop, Escape, the device's Back, pulling the handle down or a swipe down
export function BottomSheet(props: {
    label: string,
    onClose: () => void,
    children: React.ReactNode,
    tall?: boolean, // stops below the picture's top part, so a game paused under it stays visible
    className?: string,
}): React.JSX.Element {
    const { label, onClose, children, tall, className } = props;
    const close = React.useRef(onClose);
    close.current = onClose;

    // when closed from inside, the sheet slides away first and only then tells the host. It stays in place meanwhile,
    // so the closing tap cannot reach what lies under it (a tap on the game's picture would reopen the menu)
    const [leaving, setLeaving] = React.useState(false);
    const left = React.useRef(false);
    const leave = React.useCallback((): void => {
        if (left.current) {
            return;
        }
        left.current = true;
        setLeaving(true);
        setTimeout(() => close.current(), LEAVE_MS);
    }, []);

    React.useEffect(() => {
        const layer = pushEscapeLayer();
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && layer.isTop()) {
                event.stopPropagation();
                leave();
            }
        };
        // capture phase, as the emulator's key handler would otherwise read Escape as a game input
        window.addEventListener('keydown', onKeyDown, true);
        const back = pushBackHandler(leave); // the device's Back button, see back-navigation.ts
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            layer.dispose();
            back();
        };
    }, []);

    const [pulled, setPulled] = React.useState(0);
    const pull = React.useRef<{ pointer: number, y: number } | undefined>(undefined);
    const handle = {
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>): void => {
            event.currentTarget.setPointerCapture(event.pointerId);
            pull.current = { pointer: event.pointerId, y: event.clientY };
        },
        onPointerMove: (event: React.PointerEvent<HTMLDivElement>): void => {
            if (pull.current?.pointer === event.pointerId) {
                setPulled(Math.max(0, event.clientY - pull.current.y));
            }
        },
        onPointerUp: (event: React.PointerEvent<HTMLDivElement>): void => {
            if (pull.current?.pointer !== event.pointerId) {
                return;
            }
            const distance = event.clientY - pull.current.y;
            pull.current = undefined;
            setPulled(0);
            if (distance >= DISMISS_DISTANCE) {
                leave();
            }
        },
    };

    // touch events, as a pointer is cancelled once the browser starts to scroll
    const swipe = React.useRef<{ id: number, x: number, y: number, at: number } | undefined>(undefined);
    const onTouchStart = (event: React.TouchEvent<HTMLElement>): void => {
        swipe.current = undefined;
        const touch = event.touches[0];
        const target = event.target instanceof Element ? event.target : undefined;
        // not inside a scroller that is scrolled down, nor on a slider
        const scroller = target?.closest('.vp-scroll');
        if (event.touches.length !== 1 || (scroller && scroller.scrollTop > 0)
            || target?.closest('input, textarea, select, [role="slider"]')) {
            return;
        }
        swipe.current = { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: event.timeStamp };
    };
    const onTouchEnd = (event: React.TouchEvent<HTMLElement>): void => {
        const from = swipe.current;
        const touch = from && Array.from(event.changedTouches).find(each => each.identifier === from.id);
        swipe.current = undefined;
        if (!from || !touch || event.timeStamp - from.at > SWIPE_MS) {
            return;
        }
        const down = touch.clientY - from.y;
        if (down >= DISMISS_DISTANCE && Math.abs(touch.clientX - from.x) <= down * SWIPE_STRAY) {
            leave();
        }
    };

    // on the click rather than the press, so the whole tap is the backdrop's and nothing under it sees the release
    return <div className={'vp-sheet-backdrop' + (leaving ? ' leaving' : '')} onClick={event => {
        if (event.target === event.currentTarget) {
            event.stopPropagation();
            leave();
        }
    }}>
        <section
            className={'vp-sheet' + (tall ? ' vp-sheet-tall' : '') + (leaving ? ' leaving' : '')
                + (className ? ` ${className}` : '')}
            role='dialog'
            aria-modal='true'
            aria-label={label}
            style={pulled ? { transform: `translateY(${pulled}px)`, transition: 'none' } : undefined}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onTouchCancel={() => { swipe.current = undefined; }}
        >
            <div
                className='vp-sheet-handle'
                aria-hidden='true'
                {...handle}
                onPointerCancel={handle.onPointerUp}
            ><span /></div>
            {children}
        </section>
    </div>;
}
