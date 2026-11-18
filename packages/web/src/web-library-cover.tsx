import * as React from 'react';
import { useEmptyBoxUrl } from './web-empty-box';
// first wins: the user's cover, then Planet VB's box art, then the generic VB box. A catalog cover that fails to load
// falls through to the box too, so a library read offline still looks like one
export interface CoverSource {
    ownCoverUrl?: string;
    catalogCoverUrl?: string;
}

export function LibraryCover(props: { cover: CoverSource, className?: string }): React.JSX.Element {
    const { cover } = props;
    const [failed, setFailed] = React.useState(false);
    const src = cover.ownCoverUrl ?? (failed ? undefined : cover.catalogCoverUrl);
    const { image, loaded, onLoad } = usePictureArrival(src);

    // the previous failure was about the previous address
    React.useEffect(() => setFailed(false), [cover.catalogCoverUrl]);

    const className = ['vp-library-cover', props.className, !loaded && 'arriving'].filter(Boolean).join(' ');
    if (src) {
        return <img ref={image} className={className} src={src} alt='' onLoad={onLoad} onError={() => setFailed(true)} />;
    }
    return <span className={className}><GenericBox /></span>;
}

export function usePictureArrival(src: string | undefined): {
    image: React.RefObject<HTMLImageElement>,
    loaded: boolean,
    onLoad: () => void,
} {
    const [loaded, setLoaded] = React.useState(() => !src || arrived.has(src));
    const image = React.useRef<HTMLImageElement>(null);

    // a picture decoded before React could listen never fires load, and would stay blurred for good
    React.useLayoutEffect(() => {
        const done = !src || arrived.has(src) || (image.current?.complete && image.current.naturalWidth > 0);
        if (done && src) {
            arrived.add(src);
        }
        setLoaded(!!done);
    }, [src]);

    const onLoad = () => {
        if (src) {
            arrived.add(src);
        }
        setLoaded(true);
    };
    return { image, loaded, onLoad };
}

// a cover sharpens out of a blur only the first time its picture arrives this session
const arrived = new Set<string>();

// which box is the library settings' choice (see web-empty-box.ts)
export function GenericBox(): React.JSX.Element {
    return <img className='vp-library-box' src={useEmptyBoxUrl('front')} alt='' />;
}
