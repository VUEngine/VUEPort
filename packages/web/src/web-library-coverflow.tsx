import {
    ArrowsClockwise,
    CaretLeft,
    CaretRight,
    ClockCounterClockwise,
    Medal,
    Star
} from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { Card, CardActions, kindName, unreleased } from './web-library-card';
import { CardPlayButtons } from './web-library-card-actions';
import { LibraryCover } from './web-library-cover';
import { BoxBackPrint, PrintedFace } from './web-library-box';
import { BoxFace } from './web-library-types';
import { playCountLabel, playTimeLabel } from './web-play-time';
import { relativeTime } from './web-recent-roms';
import { ScoreBadge } from './web-score';

/**
 * Coverflow view of a shelf: one cover face on, the neighbours in perspective either side, dragged rather than
 * scrolled and settling on the nearest cover. Covers are six-faced CSS boxes (art in front, sides and back from the
 * game's pictures or the chosen empty box, lettered with title and facts), as a flat image turned that far reads as
 * paper on edge. The shelf has no ends (see `wrapped`), and only a window of it is in the DOM (see `WINDOW`), as Planet
 * VB's archive alone is three hundred boxes with a reflection each.
 */

// covers drawn either side of the middle
const WINDOW = 7;

// turn of the first cover either side in degrees, and how much each further one takes back, so the flanks open out
// further away while the far end still clearly reads as turned
const ANGLE = 56;
const ANGLE_STEP = 2.5;

/**
 * Offset of the first cover either side in cover widths (shoulder), and what each further one adds (gap). The shoulder
 * has a floor: a turned cover's near edge stands far forward of the flat one's face, so an overlapping neighbour stands
 * in front and bites into the middle cover. Perspective compresses turned covers more than `cos 56°` suggests, so the
 * floor can't be computed from the angle. This stays well clear of it, as tighter shows only a sliver of art between
 * two red sides.
 */
const SHOULDER = 1.02;
const GAP = 0.26;

// extra size of the middle cover on top of the pop, fading out over the first step so the shelf grows into it.
// `SHOULDER` is tuned against this, or the neighbours overlap a wider middle box
const MIDDLE = 0.3;

// each cover is this much smaller than the one nearer the middle, as perspective alone barely shrinks them. `fanned`
// tightens the spacing by the same factor, or the covers would come apart into separate cards
const SHRINK = 0.035;

const POP = 0.22;
const RECEDE = 0.09;

// position along the fan for a distance from the middle: the shoulder, then gaps scaled by the shrinking covers (the
// integral of `SHRINK`). The angle is left out on purpose, it would bunch up the far end. A closed form, as the
// distance is fractional while dragging and covers would jump if it weren't continuous
function fanned(distance: number): number {
    if (distance <= 1) {
        return SHOULDER * distance;
    }
    return SHOULDER
        + GAP * ((distance - 1) - SHRINK * (distance * distance - 1) / 2);
}

// card index of an unbounded slot, so a drag goes round the shelf without a visible seam (plain `%` keeps the sign,
// giving -1 for slot -1). A shelf shorter than the window shows some games twice, which beats a cover jumping across
// the stage mid-drag
function wrapped(slot: number, count: number): number {
    return ((slot % count) + count) % count;
}

export interface CoverflowSteer {
    step(by: number): void;
    current(): string | undefined;
    flip(): void;
}

// a context rather than a prop, as the coverflow sits several components below the screen that steers it, on two
// different shelves
export const CoverflowSteerContext =
    React.createContext<React.MutableRefObject<CoverflowSteer | undefined> | undefined>(undefined);

export function Coverflow(props: {
    cards: Card[],
    onOpen: (id: string) => void,
    actions: CardActions,
}): React.JSX.Element {
    const { cards } = props;
    const steer = React.useContext(CoverflowSteerContext);
    const stage = React.useRef<HTMLDivElement>(null);
    const middleNode = React.useRef<HTMLDivElement>(null);

    const [middle, setMiddle] = React.useState(0);
    const [pulled, setPulled] = React.useState(0);
    const [flipped, setFlipped] = React.useState(false);
    const [dragging, setDragging] = React.useState(false);
    // `dragging` starts on the press, so a click counts too; what only a real pull should change (the middle cover's
    // shadow) waits for this
    const [pulling, setPulling] = React.useState(false);
    // a turning box's faces sweep in front of the button on its corner, so a second press mid-turn would go through to
    // the cover and open the game's page
    const [turning, setTurning] = React.useState(false);

    const count = cards.length;
    const last = count - 1;
    // a single game keeps its ends (dead arrows, a drag that springs back), everything from two games up goes round
    const wraps = count > 1;
    const cardAt = React.useCallback((slot: number) => wraps
        ? wrapped(slot, count)
        : Math.max(0, Math.min(last, slot)), [wraps, count, last]);
    const settle = React.useCallback((slot: number) => wraps
        ? slot
        : Math.max(0, Math.min(last, slot)), [wraps, last]);

    // sorting or searching rearranges the shelf, so the middle follows the game the user was looking at rather than the
    // position, until that game leaves the shelf
    const middleIndex = cardAt(middle);
    const middleId = cards[middleIndex]?.id;
    const wanted = React.useRef(middleId);
    React.useEffect(() => {
        wanted.current = middleId;
    }, [middleId]);
    React.useEffect(() => {
        setMiddle(current => {
            const moved = wanted.current === undefined
                ? -1
                : cards.findIndex(entry => entry.id === wanted.current);
            if (moved >= 0) {
                return moved;
            }
            return cards.length > 1 ? wrapped(current, cards.length) : 0;
        });
    }, [cards]);

    React.useEffect(() => {
        setFlipped(false);
        setTurning(false);
    }, [middleId]);

    const flip = React.useCallback(() => {
        setTurning(true);
        setFlipped(show => !show);
    }, []);

    const goTo = React.useCallback((slot: number) => {
        setMiddle(settle(slot));
    }, [settle]);

    // for Home and End on a wrapping shelf: the slot nearest the middle that holds the card, going the shorter way
    // round
    const nearest = React.useCallback((index: number) => {
        if (!wraps) {
            return index;
        }
        const ahead = wrapped(index - wrapped(middle, count), count);
        return middle + (ahead * 2 > count ? ahead - count : ahead);
    }, [wraps, middle, count]);

    // a press on a side cover selects it, on the middle one it opens the game as in the other views; flipping the box
    // is a button on its corner
    const chose = React.useCallback((slot: number) => {
        if (slot === middle) {
            const pressed = cards[cardAt(slot)];
            if (pressed !== undefined) {
                props.onOpen(pressed.id);
            }
        } else {
            goTo(slot);
        }
    }, [middle, goTo, cards, props, cardAt]);

    const position = middle + pulled;

    // `step` is a cover's drawn width, measured on press, so a gesture moves the same at every cover size. `moved`
    // tells a drag from a click and `on` remembers the pressed cover, which the release event no longer reveals
    const drag = React.useRef<{
        id: number, from: number, step: number, moved: boolean, on?: number,
    }>();

    const onPointerDown = React.useCallback((event: React.PointerEvent) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('button')) {
            return;
        }
        const width = middleNode.current?.offsetWidth ?? 0;
        const pressed = (event.target as HTMLElement).closest('[data-flow-index]');
        drag.current = {
            id: event.pointerId,
            from: event.clientX,
            step: Math.max(40, width * (SHOULDER + GAP)),
            moved: false,
            on: pressed ? Number(pressed.getAttribute('data-flow-index')) : undefined,
        };
        // with the pointer captured the stage is the target of everything that follows, the click included, so the
        // pressed cover has to be remembered now
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        setDragging(true);
    }, []);

    const onPointerMove = React.useCallback((event: React.PointerEvent) => {
        const state = drag.current;
        if (!state || state.id !== event.pointerId) {
            return;
        }
        const travelled = event.clientX - state.from;
        if (Math.abs(travelled) > 4 && !state.moved) {
            state.moved = true;
            setPulling(true);
        }
        const wantedPull = -travelled / state.step;
        if (wraps) {
            setPulled(wantedPull);
            return;
        }
        // a single-game shelf gives way half as far beyond its ends, as one that stopped dead would look broken
        const raw = middle + wantedPull;
        const over = raw < 0 ? raw : raw > last ? raw - last : 0;
        setPulled(wantedPull - over / 2);
    }, [middle, last, wraps]);

    const endDrag = React.useCallback((event: React.PointerEvent) => {
        const state = drag.current;
        if (!state || state.id !== event.pointerId) {
            return;
        }
        drag.current = undefined;
        setDragging(false);
        setPulling(false);
        setPulled(0);
        // no momentum on purpose, a flick that coasts past where it was let go would have to be caught again
        if (!state.moved && state.on !== undefined) {
            chose(state.on);
            return;
        }
        setMiddle(current => settle(Math.round(current + pulled)));
    }, [settle, pulled, chose]);

    // native listener, as React registers `onWheel` passively and this has to stop the page scrolling; both axes count,
    // for sideways trackpad swipes
    const wheeled = React.useRef(0);
    React.useEffect(() => {
        const node = stage.current;
        if (!node) {
            return;
        }
        const onWheel = (event: WheelEvent) => {
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
                ? event.deltaX
                : event.deltaY;
            if (delta === 0) {
                return;
            }
            event.preventDefault();
            wheeled.current += delta;
            // accumulated against a threshold rather than a cover per event, as a mouse notch is fifty-odd pixels and a
            // trackpad event about three
            const steps = Math.trunc(wheeled.current / 60);
            if (steps !== 0) {
                wheeled.current -= steps * 60;
                setMiddle(current => settle(current + steps));
            }
        };
        // backs up the stylesheet's `user-select`, which WebKit (the desktop build) long needed prefixed
        const onSelectStart = (event: Event) => event.preventDefault();
        node.addEventListener('wheel', onWheel, { passive: false });
        node.addEventListener('selectstart', onSelectStart);
        return () => {
            node.removeEventListener('wheel', onWheel);
            node.removeEventListener('selectstart', onSelectStart);
        };
    }, [settle]);

    const onKeyDown = React.useCallback((event: React.KeyboardEvent) => {
        switch (event.key) {
            case 'ArrowLeft':
                goTo(middle - 1);
                break;
            case 'ArrowRight':
                goTo(middle + 1);
                break;
            case 'PageUp':
                goTo(middle - 10);
                break;
            case 'PageDown':
                goTo(middle + 10);
                break;
            case 'Home':
                goTo(nearest(0));
                break;
            case 'End':
                goTo(nearest(last));
                break;
            case ' ':
                flip();
                break;
            case 'Enter':
                if (middleId !== undefined) {
                    props.onOpen(middleId);
                }
                break;
            default:
                return;
        }
        event.preventDefault();
    }, [goTo, nearest, middle, last, middleId, props, flip]);

    const card = cards[middleIndex];
    if (steer) {
        steer.current = { step: by => goTo(middle + by), current: () => card?.id, flip };
    }
    const from = wraps
        ? Math.ceil(position) - WINDOW
        : Math.max(0, Math.ceil(position) - WINDOW);
    const to = wraps
        ? Math.floor(position) + WINDOW
        : Math.min(last, Math.floor(position) + WINDOW);
    const drawn: React.JSX.Element[] = [];
    for (let slot = from; slot <= to; slot++) {
        const entry = cards[cardAt(slot)];
        if (entry === undefined) {
            continue;
        }
        drawn.push(<FlowCover
            // keyed by slot, as a short shelf has the same game in several slots and a slot stays put while the shelf
            // turns
            key={slot}
            card={entry}
            offset={slot - position}
            middle={slot === middle}
            flipped={slot === middle && flipped}
            turning={slot === middle && turning}
            onFlip={slot === middle ? flip : undefined}
            actions={slot === middle ? props.actions : undefined}
            onOpen={slot === middle ? props.onOpen : undefined}
            onTurned={slot === middle ? () => setTurning(false) : undefined}
            nodeRef={slot === middle ? middleNode : undefined}
            slot={slot}
            at={cardAt(slot)}
            of={count}
        />);
    }

    return <div className='vp-library-flow'>
        <div
            ref={stage}
            className={`vp-library-flow-stage${dragging ? ' dragging' : ''}${pulling ? ' pulling' : ''}`}
            role='listbox'
            tabIndex={0}
            aria-label={nls.localize('vueport/library/coverflow', 'Coverflow')}
            aria-activedescendant={card ? `vp-flow-${middle}` : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            // a press and move on an `<img>` starts the browser's image drag, which cancels the pointer and leaves the
            // shelf stuck mid-drag
            onDragStart={event => event.preventDefault()}
            onKeyDown={onKeyDown}
        >
            <div className='vp-library-flow-track'>{drawn}</div>
            {/* no `weight` on the carets: the build keeps only `regular` and `fill` (see `ICON_WEIGHTS` in
                esbuild.mjs), and an icon asking for a dropped weight renders an empty `<svg>` */}
            <button
                type='button'
                className='vp-library-flow-step prev'
                disabled={!wraps && middle <= 0}
                onClick={() => goTo(middle - 1)}
                title={nls.localize('vueport/library/flow/prev', 'Previous game')}
                aria-label={nls.localize('vueport/library/flow/prev', 'Previous game')}
            ><CaretLeft size={22} /></button>
            <button
                type='button'
                className='vp-library-flow-step next'
                disabled={!wraps && middle >= last}
                onClick={() => goTo(middle + 1)}
                title={nls.localize('vueport/library/flow/next', 'Next game')}
                aria-label={nls.localize('vueport/library/flow/next', 'Next game')}
            ><CaretRight size={22} /></button>
        </div>

        {card && <FlowDetails card={card} at={middleIndex + 1} of={count} />}
    </div>;
}

// the transform depends on the fractional distance, so it is computed here. The stylesheet supplies the unit
// (`--vp-flow-size`, one cover's width), so no number here is in pixels
function FlowCover(props: {
    card: Card,
    // signed, fractional distance from the middle in slots
    offset: number,
    middle: boolean,
    flipped: boolean,
    turning: boolean,
    onFlip?: () => void,
    actions?: CardActions,
    onOpen?: (id: string) => void,
    onTurned?: () => void,
    nodeRef?: React.RefObject<HTMLDivElement>,
    // slot on the endless shelf (see `wrapped`), reported on press and used as the box's id, since a short shelf holds
    // the same game in several slots; differs from `at`
    slot: number,
    at: number,
    of: number,
}): React.JSX.Element {
    const { card, offset } = props;
    const distance = Math.abs(offset);
    // clamped at one, as everything past the first neighbour is turned the same way
    const turning = Math.min(1, distance);
    const side = Math.sign(offset);

    const x = side * fanned(distance);
    // strictly falling with distance, so each cover stands in front of the one outside it: siblings in one 3D space are
    // ordered by position, not z-index
    const z = (1 - turning) * POP - turning * RECEDE - distance * 0.02;
    // turned inwards towards the centre, or the shelf reads inside out. The second term is what each cover beyond the
    // first takes back, zero at the first neighbour so both halves meet smoothly mid-drag
    const rotation = -side * (turning * ANGLE
        - Math.max(0, Math.min(distance, WINDOW) - 1) * ANGLE_STEP);
    const scale = (1 + MIDDLE * (1 - turning)) * (1 - SHRINK * Math.min(distance, WINDOW));
    // a veil in the page's colour over every face rather than opacity, which let the box behind show through
    const shade = Math.max(0, Math.min(1, (distance - (WINDOW - 4)) / 4));

    return <div
        ref={props.nodeRef}
        id={`vp-flow-${props.slot}`}
        role='option'
        aria-selected={props.middle}
        aria-label={card.title}
        // stated explicitly because the list is windowed
        aria-posinset={props.at + 1}
        aria-setsize={props.of}
        className={`vp-library-flow-cover${props.middle ? ' middle' : ''}`}
        // only the middle one, which is what a game pad has; a short shelf draws a game in several slots
        data-pad-card={props.middle ? card.id : undefined}
        data-flipped={props.flipped ? 'true' : undefined}
        data-turning={props.turning ? 'true' : undefined}
        style={{
            transform: `translateX(calc(var(--vp-flow-size) * ${x.toFixed(4)})) `
                + `translateZ(calc(var(--vp-flow-size) * ${z.toFixed(4)})) `
                + `rotateY(${rotation.toFixed(2)}deg) `
                + `scale3d(${scale.toFixed(4)}, ${scale.toFixed(4)}, ${scale.toFixed(4)})`,
            ['--vp-flow-shade' as string]: shade.toFixed(3),
        }}
        data-flow-index={props.slot}
    >
        <FlowBox card={card} flipped={props.flipped} onTurned={props.onTurned} />
        {/* on the corner opposite the turn, as on the grid's cards */}
        {props.actions && <CardPlayButtons
            card={card}
            actions={props.actions}
            className='vp-library-flow-launch'
            onDetails={props.onOpen ? () => props.onOpen?.(card.id) : undefined}
        />}
        {/* outside the flipping box, so it stays reachable whichever way round the box is. After the launch
            buttons, as a game pad walks a card's `data-pad-action` buttons in source order; `data-pad-stay`
            keeps the pad on it for a second A */}
        {props.onFlip && <button
            type='button'
            className='vp-library-flow-flip'
            data-pad-action
            data-pad-stay
            onClick={props.onFlip}
            aria-pressed={props.flipped}
            title={props.flipped
                ? nls.localize('vueport/library/showFront', 'Show Front')
                : nls.localize('vueport/library/showBack', 'Show Back')}
            aria-label={props.flipped
                ? nls.localize('vueport/library/showFront', 'Show Front')
                : nls.localize('vueport/library/showBack', 'Show Back')}
        ><ArrowsClockwise size={16} /></button>}
    </div>;
}

// kept apart from FlowCover, as only the placement changes with every pointer move
function FlowBox(props: {
    card: Card,
    flipped: boolean,
    onTurned?: () => void,
}): React.JSX.Element {
    const { card } = props;
    return <div
        className={`vp-library-flow-box${props.flipped ? ' flipped' : ''}`}
        title={card.title}
        // the box reports the end of its turn, so the duration lives only in the stylesheet; only its own transform
        // counts, as the event bubbles up from every animating face
        onTransitionEnd={event => {
            if (event.target === event.currentTarget && event.propertyName === 'transform') {
                props.onTurned?.();
            }
        }}
    >
        <div className='vp-library-flow-face front'>
            <LibraryCover cover={card.cover} />
        </div>
        {/* both side faces, as covers turn inwards: left of the middle shows the left side, right the right */}
        <FlowFace className='back' face='back' src={card.box?.back}>
            <BoxBackPrint card={card} />
        </FlowFace>
        <FlowFace className='spine' face='left' src={card.box?.left}>
            <span>{card.title}</span>
        </FlowFace>
        <FlowFace className='fore' face='right' src={card.box?.right}>
            <span>{card.title}</span>
        </FlowFace>
        <div className='vp-library-flow-face top' />
        <div className='vp-library-flow-face bottom' />
    </div>;
}

function FlowFace(props: {
    className: string,
    face: BoxFace,
    src?: string,
    children: React.ReactNode,
}): React.JSX.Element {
    return <div className={`vp-library-flow-face ${props.className}`}>
        <PrintedFace face={props.face} src={props.src} pictureClassName='vp-library-flow-picture'>
            {props.children}
        </PrintedFace>
    </div>;
}

function FlowDetails(props: {
    card: Card,
    at: number,
    of: number,
}): React.JSX.Element {
    const { card } = props;
    const played = card.playCount !== undefined && card.playMs !== undefined
        && card.lastPlayedAt !== undefined
        ? nls.localize(
            'vueport/library/playLine', 'Played {0} · {1} · last played {2}',
            playCountLabel(card.playCount),
            playTimeLabel(card.playMs),
            relativeTime(card.lastPlayedAt))
        : undefined;
    return <div className='vp-library-flow-details'>
        {/* polite, so a drag announces only the cover it stopped on, not every one it passed */}
        <h2 aria-live='polite'>{card.title}</h2>
        {/* every line is always there and one line high, so the shelf above doesn't move between games */}
        <p className='vp-hint vp-library-flow-line'>{card.meta || '\u00a0'}</p>
        <div className='vp-library-flow-marks'>
            <ScoreBadge score={card.score} />
            {card.kind && <span className='vp-library-card-kind'>
                {kindName(card.kind)}
            </span>}
            {unreleased(card.status) && <span className='vp-library-card-unreleased'>
                {nls.localize('vueport/library/unreleased', 'Unreleased')}
            </span>}
            {card.featured && <span
                className='vp-library-card-featured'
                title={nls.localize('vueport/library/featuredPick', 'A Planet VB featured pick')}
            ><Medal size={15} weight='fill' /></span>}
            {card.favorite && <span
                className='vp-library-card-star'
                title={nls.localize('vueport/library/starred', 'Starred')}
            ><Star size={15} weight='fill' /></span>}
        </div>
        <p
            className={`vp-library-hero-play vp-library-flow-play vp-library-flow-line${played ? '' : ' empty'}`}
            aria-hidden={!played}
        >
            <ClockCounterClockwise size={14} />
            {played ?? '\u00a0'}
        </p>
        <p className='vp-hint vp-library-flow-count'>
            {nls.localize('vueport/library/flow/position', '{0} of {1}', props.at, props.of)}
        </p>
    </div>;
}
