import { FilmStrip } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { formatVesMovieLength } from '../../common/emulator-movie';

export default function EmulatorMovieBadge(props: {
    playing: boolean,
    frame: number,
    length: number,
    onStop: () => void,
}): React.JSX.Element | null {
    const { playing, frame, length, onStop } = props;
    if (!playing) {
        return null;
    }
    return <button
        type='button'
        className='vp-screen-badge vp-movie-badge'
        aria-label={nls.localize(
            'vueport/movie/badge',
            'An input movie is playing. Click to stop and take back control.'
        )}
        onClick={onStop}
    >
        <FilmStrip size={16} weight='fill' />
        {formatVesMovieLength(frame)}
        <span className='vp-movie-badge-total'>/ {formatVesMovieLength(length)}</span>
    </button>;
}
