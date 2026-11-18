import React, { PropsWithChildren, ReactElement } from 'react';
import HoverInfo from './HoverInfo';
import { VueportHover } from './KitContext';
import styled from 'styled-components';

const FlexLabel = styled.label`
    display: flex;
    gap: var(--vp-space-half);
`;

interface InfoLabelProps {
    label: string
    subLabel?: string
    count?: number
    tooltip?: string | ReactElement
    hover?: VueportHover
    style?: object
}

export default function InfoLabel(props: PropsWithChildren<InfoLabelProps>): React.JSX.Element {
    const { label, subLabel, tooltip, count, hover, style } = props;

    return <FlexLabel style={{ whiteSpace: 'nowrap', ...style }}>
        {label}
        {count && <>
            {' '}<span className='count'>{count}</span>
        </>}
        {tooltip &&
            <HoverInfo
                tooltip={tooltip}
                hover={hover}
            />
        }
        {subLabel && <>
            {' '}<span className='lightLabel'>{subLabel}</span>
        </>}
    </FlexLabel>;
}
