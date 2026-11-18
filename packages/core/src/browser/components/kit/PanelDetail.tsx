import { ArrowLeft, CaretLeft, CaretRight } from '@phosphor-icons/react';
import React from 'react';
import { nls } from '../../../common/emulator-nls';

// building blocks of a list panel's detail view (cheats, macros, patches): navigation at the top, the entry as a
// heading with its switch, its parts in titled sections, actions at the bottom

// the back button carries the list's name, as nothing else says which panel this is in the strip beside the screen
export function PanelDetailToolbar(props: {
    list: string,
    index: number,
    count: number,
    onBack: () => void,
    onStep: (index: number) => void,
}): React.JSX.Element {
    const { list, index, count, onBack, onStep } = props;
    return <div className='vp-panel-toolbar vp-detail-toolbar'>
        <button
            type='button'
            className='vp-panel-back'
            title={nls.localize('vueport/general/backToList', 'Back To List')}
            onClick={onBack}
        >
            <ArrowLeft size={18} />
            {list}
        </button>
        {count > 1 && <div className='vp-detail-pager'>
            <button
                type='button'
                aria-label={nls.localize('vueport/general/previous', 'Previous')}
                disabled={index <= 0}
                onClick={() => onStep(index - 1)}
            >
                <CaretLeft size={16} />
            </button>
            <span>{nls.localize('vueport/general/position', '{0} of {1}', index + 1, count)}</span>
            <button
                type='button'
                aria-label={nls.localize('vueport/general/next', 'Next')}
                disabled={index >= count - 1}
                onClick={() => onStep(index + 1)}
            >
                <CaretRight size={16} />
            </button>
        </div>}
    </div>;
}

// the entry's name as a heading next to its main control (a cheat's or patch's switch, a macro's play button).
// The name is edited in place, as renaming is the commonest edit; a name the user cannot change is plain text
export function PanelDetailHero(props: {
    icon: React.ReactNode,
    name: string,
    title?: React.ReactNode, // shown instead of the plain name when the entry cannot be renamed
    onRename?: (name: string) => void,
    meta?: React.ReactNode,
    badges?: React.ReactNode,
    control?: React.ReactNode,
}): React.JSX.Element {
    const { icon, name, title, onRename, meta, badges, control } = props;
    return <div className='vp-detail-hero'>
        <div className='vp-detail-hero-main'>
            <span className='vp-detail-hero-icon' aria-hidden='true'>{icon}</span>
            <div className='vp-detail-hero-text'>
                {onRename
                    ? <input
                        className='vp-detail-hero-name'
                        value={name}
                        spellCheck={false}
                        aria-label={nls.localize('vueport/general/name', 'Name')}
                        onChange={event => onRename(event.target.value)}
                    />
                    : <span className='vp-detail-hero-name'>{title ?? name}</span>}
                {meta && <span className='vp-detail-hero-meta'>{meta}</span>}
            </div>
            {control}
        </div>
        {badges && <div className='vp-detail-badges'>{badges}</div>}
    </div>;
}

export function PanelDetailBadge(props: {
    icon?: React.ReactNode,
    children: React.ReactNode,
}): React.JSX.Element {
    return <span className='vp-detail-badge'>
        {props.icon}
        {props.children}
    </span>;
}

export function PanelDetailSection(props: {
    title: string,
    htmlFor?: string, // makes the title the label of the section's single field
    aside?: React.ReactNode,
    children: React.ReactNode,
}): React.JSX.Element {
    const { title, htmlFor, aside, children } = props;
    return <section className='vp-detail-section'>
        <div className='vp-detail-section-head'>
            {htmlFor
                ? <label className='vp-detail-section-title' htmlFor={htmlFor}>{title}</label>
                : <h3 className='vp-detail-section-title'>{title}</h3>}
            {aside && <span className='vp-detail-section-aside'>{aside}</span>}
        </div>
        {children}
    </section>;
}

export function PanelDetailFacts(props: {
    rows: Array<[label: string, value: React.ReactNode | undefined, code?: boolean]>,
}): React.JSX.Element {
    return <dl className='vp-detail-facts'>
        {props.rows
            .filter(([, value]) => value !== undefined && value !== '')
            .map(([label, value, code]) => <React.Fragment key={label}>
                <dt>{label}</dt>
                <dd className={code ? 'code' : undefined}>{value}</dd>
            </React.Fragment>)}
    </dl>;
}

// pushed to the bottom of the panel, so removing an entry, which cannot be undone, is never next to the switch
export function PanelDetailFooter(props: {
    hint?: React.ReactNode,
    children?: React.ReactNode,
}): React.JSX.Element {
    return <div className='vp-detail-footer'>
        <span className='vp-detail-footer-hint'>{props.hint}</span>
        {props.children}
    </div>;
}
