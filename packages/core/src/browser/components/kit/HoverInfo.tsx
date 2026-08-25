import React, { PropsWithChildren, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useKit, VueportHover } from './KitContext';

interface HoverInfoProps {
    tooltip: string | ReactElement
    hover?: VueportHover
}

export default function HoverInfo(props: PropsWithChildren<HoverInfoProps>): React.JSX.Element {
    const { hover: contextHover } = useKit();
    const { tooltip, hover } = props;

    let content: string | HTMLElement = tooltip as string;
    if (tooltip && typeof tooltip !== 'string') {
        content = document.createElement('div');
        // eslint-disable-next-line no-unsanitized/property
        content.innerHTML = renderToStaticMarkup(tooltip);
    }

    const hs = hover ?? contextHover;

    return (
        <i
            className='codicon codicon-question'
            onMouseEnter={event => {
                hs.show(event.currentTarget, content);
            }}
            onMouseLeave={event => {
                hs.hide();
            }}
        />
    );
}
