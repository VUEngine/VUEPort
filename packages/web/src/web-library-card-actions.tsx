import { ArrowsClockwise, ClockCounterClockwise, Info, Play, ShareNetwork } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { Card, CardActions } from './web-library-card';

/**
 * Play, plus Resume when the game was put away by Suspend and Resume, for one card in all three views. A click stops
 * here, as every view also opens the game's page on a click that reaches the card. `onDetails` adds the game's page
 * for views where a game pad steers between these buttons (all marked `data-pad-action`, which that steering walks).
 * `onFlip` adds a flip button for views that turn covers over (the grid); the coverflow has its own on the box.
 */
export function CardPlayButtons(props: {
    card: Card,
    actions: CardActions,
    className: string,
    size?: number,
    onDetails?: () => void,
    onFlip?: () => void,
    flipped?: boolean,
}): React.JSX.Element {
    const { card, actions } = props;
    const size = props.size ?? 16;
    const play = nls.localize('vueport/library/play', 'Play');
    const resume = nls.localize('vueport/library/resume', 'Resume');
    return <span className={props.className}>
        <button
            type='button'
            className='play'
            data-pad-action
            onClick={event => { event.stopPropagation(); actions.onPlay(card.id); }}
            title={play}
            aria-label={play}
        ><Play size={size} weight='fill' /></button>
        {card.resumable && <button
            type='button'
            className='resume'
            data-pad-action
            onClick={event => { event.stopPropagation(); actions.onResume(card.id); }}
            title={resume}
            aria-label={resume}
        ><ClockCounterClockwise size={size} /></button>}
        {actions.onShare && <button
            type='button'
            className='share'
            data-pad-action
            onClick={event => { event.stopPropagation(); actions.onShare?.(card.id); }}
            title={nls.localize('vueport/library/share', 'Share')}
            aria-label={nls.localize('vueport/library/share', 'Share')}
        ><ShareNetwork size={size} /></button>}
        {props.onDetails && <button
            type='button'
            className='details'
            data-pad-action
            onClick={event => { event.stopPropagation(); props.onDetails?.(); }}
            title={nls.localize('vueport/library/details', 'Details')}
            aria-label={nls.localize('vueport/library/details', 'Details')}
        ><Info size={size} /></button>}
        {/* keeps the pad on it once pressed, so a second press turns the cover back, as in the coverflow */}
        {props.onFlip && <button
            type='button'
            className='flip'
            data-pad-action
            data-pad-stay
            aria-pressed={props.flipped}
            onClick={event => { event.stopPropagation(); props.onFlip?.(); }}
            title={props.flipped
                ? nls.localize('vueport/library/showFront', 'Show Front')
                : nls.localize('vueport/library/showBack', 'Show Back')}
            aria-label={props.flipped
                ? nls.localize('vueport/library/showFront', 'Show Front')
                : nls.localize('vueport/library/showBack', 'Show Back')}
        ><ArrowsClockwise size={size} /></button>}
    </span>;
}
