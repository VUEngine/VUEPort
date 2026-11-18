import * as React from 'react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { EmptyBoxArea, useEmptyBoxAreas, useEmptyBoxUrl } from './web-empty-box';
import { Card, kindName } from './web-library-card';
import { BoxFace } from './web-library-types';

// a function, as a table built at module load would predate the translations
export function boxFaceLabel(face: BoxFace): string {
    switch (face) {
        case 'front': return nls.localize('vueport/library/face/front', 'Front');
        case 'back': return nls.localize('vueport/library/face/back', 'Back');
        case 'left': return nls.localize('vueport/library/face/left', 'Left');
        case 'right': return nls.localize('vueport/library/face/right', 'Right');
        case 'top': return nls.localize('vueport/library/face/top', 'Top');
        case 'bottom': return nls.localize('vueport/library/face/bottom', 'Bottom');
    }
}

// keyboard order: across the middle row, then the two ends
const NET_ORDER: ReadonlyArray<BoxFace> = ['top', 'left', 'front', 'right', 'back', 'bottom'];

// an unfolded box, front in the middle and the back beyond the right side; positions are grid areas in the stylesheet.
// Face names show on hover as the narrow sides have no room, and extra sits beside a face since a button cannot hold
// another
export function BoxNet(props: {
    render: (face: BoxFace) => React.ReactNode,
    onSelect?: (face: BoxFace) => void,
    selected?: BoxFace,
    label?: (face: BoxFace) => string,
    extra?: (face: BoxFace) => React.ReactNode,
}): React.JSX.Element {
    const onSelect = props.onSelect;
    const picks = props.selected !== undefined;
    return <div className='vp-box-net' role={picks ? 'radiogroup' : undefined}>
        {NET_ORDER.map(face => {
            const label = props.label?.(face) ?? boxFaceLabel(face);
            return <div key={face} className={`vp-box-net-cell ${face}`}>
                {onSelect
                    ? <button
                        type='button'
                        role={picks ? 'radio' : undefined}
                        aria-checked={picks ? face === props.selected : undefined}
                        aria-label={label}
                        title={label}
                        className={`vp-box-net-face${face === props.selected ? ' selected' : ''}`}
                        onClick={() => onSelect(face)}
                    >
                        {props.render(face)}
                    </button>
                    : <div className='vp-box-net-face' title={label}>{props.render(face)}</div>}
                {props.extra?.(face)}
            </div>;
        })}
    </div>;
}

// falls back to the chosen empty box's picture (also when the given one fails to load), then to an empty frame
export function BoxPicture(props: { face: BoxFace, src?: string, className?: string }): React.JSX.Element {
    const empty = useEmptyBoxUrl(props.face);
    const [failed, setFailed] = React.useState<ReadonlySet<string>>(() => new Set());
    const src = [props.src, empty].find(url => url !== undefined && !failed.has(url));
    const className = props.className ?? 'vp-box-net-picture';
    if (!src) {
        return <span className={`${className} empty`} />;
    }
    return <img
        className={className}
        src={src}
        alt=''
        onError={() => setFailed(current => new Set(current).add(src))}
    />;
}

// the empty box gets the box's lettering printed into its free stretch, sized from --vp-box-size (one cover's width),
// which the caller sets
export function PrintedFace(props: {
    face: BoxFace,
    src?: string,
    pictureClassName: string,
    children: React.ReactNode,
}): React.JSX.Element {
    const areas = useEmptyBoxAreas();
    const area = props.face === 'back' ? areas.back : areas.side;
    return <>
        <BoxPicture face={props.face} src={props.src} className={props.pictureClassName} />
        {!props.src && <span className={`vp-box-print ${props.face}`} style={insetOf(area)}>
            {props.children}
        </span>}
    </>;
}

function insetOf(area: EmptyBoxArea): React.CSSProperties {
    return { inset: `${area.top}% ${area.right}% ${area.bottom}% ${area.left}%` };
}

// only facts the card already carries, so an unknown game turns over to a mostly empty panel
export function BoxBackPrint(props: { card: Card }): React.JSX.Element {
    const { card } = props;
    const facts: [string, string | undefined][] = [
        [nls.localize('vueport/library/developer', 'Developer'), card.developer],
        [nls.localize('vueport/library/year', 'Year'), card.year],
        [nls.localize('vueport/library/genre', 'Genre'), card.genre],
        [nls.localize('vueport/library/players', 'Players'), card.players],
        [nls.localize('vueport/library/region', 'Region'), card.region],
        [nls.localize('vueport/status/size', 'Size'), card.size],
        [nls.localize('vueport/library/kind/title', 'Type'), card.kind ? kindName(card.kind) : undefined],
    ];
    const known = facts.filter((fact): fact is [string, string] => Boolean(fact[1]));
    return <>
        <span className='vp-box-back-head'>{card.title}</span>
        <span className='vp-box-back-facts'>
            {known.map(([name, value]) => <React.Fragment key={name}>
                <span className='vp-box-back-name'>{name}</span>
                <span className='vp-box-back-value'>{value}</span>
            </React.Fragment>)}
        </span>
    </>;
}
