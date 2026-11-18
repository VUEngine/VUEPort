import React from 'react';
import styled from 'styled-components';

const Grid = styled.div`
    display: grid;
    gap: var(--vp-space);
    grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
`;

const Card = styled.button`
    align-items: center;
    background: var(--vp-panel);
    border: 1px solid var(--vp-control);
    border-radius: var(--vp-radius-large);
    color: var(--vp-text-dim);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    font-family: var(--vp-font-ui);
    font-size: calc(var(--vp-font-size) - 1px);
    gap: var(--vp-space);
    padding: var(--vp-space-x2) var(--vp-space);
    text-align: center;
    transition: border-color 120ms ease, color 120ms ease;

    &:hover:not(:disabled) {
        border-color: var(--vp-accent);
        color: var(--vp-text);
    }

    &:disabled {
        cursor: default;
        opacity: 0.5;
    }

    &[aria-pressed='true'] {
        background-color: var(--vp-control);
        color: var(--vp-text);
    }

    &:focus-visible {
        outline: 1px solid var(--vp-accent);
        outline-offset: 1px;
    }
`;

export default function EmulatorRenderingModeField(props: {
    options: { value: string, label: string }[],
    value: string,
    disabled?: boolean,
    onChange: (value: string) => void,
}): React.JSX.Element {
    return <Grid>
        {props.options.map(option => {
            const active = option.value === props.value;
            return <Card
                key={option.value}
                type='button'
                aria-pressed={active}
                disabled={props.disabled}
                onClick={() => props.onChange(option.value)}
            >
                <div aria-hidden='true' className={`vp-rendering-mode vp-rendering-mode-${option.value}`}>
                    <div className='left' />
                    <div className='right' />
                </div>
                {option.label}
            </Card>;
        })}
    </Grid>;
}
