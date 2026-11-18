import { ArrowUUpLeft } from '@phosphor-icons/react';
import React from 'react';
import styled from 'styled-components';
import { nls } from '../../../common/emulator-nls';

// hidden rather than left out when there is nothing to undo, so nothing shifts on the first change
const Styled = styled.button`
    background: transparent;
    border: none;
    color: var(--vp-text-dim);
    cursor: pointer;
    display: flex;
    margin: 0;
    min-width: unset;
    padding: 2px;

    &:hover,
    &:focus-visible {
        color: var(--vp-text);
    }

    &:disabled {
        visibility: hidden;
    }
`;

export default function ResetButton(props: {
    onReset: () => void,
    disabled?: boolean, // setting already holds its default; hides the button but keeps its place
    size?: number,
}): React.JSX.Element {
    return <Styled
        type='button'
        disabled={props.disabled}
        aria-hidden={props.disabled}
        title={props.disabled
            ? undefined
            : nls.localize('vueport/general/resetToDefault', 'Reset to Default')}
        onClick={props.onReset}
    >
        <ArrowUUpLeft size={props.size ?? 16} />
    </Styled>;
}
