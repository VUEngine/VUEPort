import * as React from 'react';

export default function Switch(props: {
    // for screen readers only, the visible text already sits beside or above it
    label: string,
    value: boolean,
    disabled?: boolean,
    onChange: (value: boolean) => void,
}): React.JSX.Element {
    return <button
        type='button'
        role='switch'
        aria-checked={props.value}
        aria-label={props.label}
        disabled={props.disabled}
        className='vp-switch'
        onClick={() => props.onChange(!props.value)}
    >
        <span className='vp-switch-knob' />
    </button>;
}
