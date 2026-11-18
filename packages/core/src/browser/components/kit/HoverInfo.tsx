import { Question } from '@phosphor-icons/react';
import React, { PropsWithChildren, ReactElement } from 'react';
import { useKit, VueportHover } from './KitContext';
import { useTooltipContents } from './tooltip-content';
import styled from 'styled-components';

const HoverInfoWrapper = styled.div`
    align-self: center;
    cursor: help;
    height: var(--vp-icon-size);
`;

interface HoverInfoProps {
    tooltip: string | ReactElement
    hover?: VueportHover
}

export default function HoverInfo(props: PropsWithChildren<HoverInfoProps>): React.JSX.Element {
    const { hover: contextHover } = useKit();
    const { tooltip, hover } = props;

    const tooltips = useTooltipContents([tooltip]);

    const hs = hover ?? contextHover;

    return (
        <HoverInfoWrapper
            onMouseEnter={event => {
                const content = tooltips.resolve(0);
                if (content) {
                    hs.show(event.currentTarget, content);
                }
            }}
            onMouseLeave={event => {
                hs.hide();
            }}
        >
                <Question size={16}/>
                {tooltips.portals}
        </HoverInfoWrapper>
    );
}
