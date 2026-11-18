import * as React from 'react';

// the rows of the detail views the Worlds and Objects panels put under their tables, shared so a field reads the
// same way in both

export function field(label: string, value: React.ReactNode, hint?: string): React.JSX.Element {
    return <div className='vp-detail-field' key={label} title={hint}>
        <span className='label'>{label}</span>
        <span className='value'>{value}</span>
    </div>;
}

// `wide` gives the row the whole width of its group, for a control that needs the room (a name rather than a number)
export function control(label: string, input: React.ReactNode, hint?: string, wide = false): React.JSX.Element {
    return <div className={`vp-detail-field${wide ? ' wide' : ''}`} key={label} title={hint}>
        <span className='label'>{label}</span>
        {input}
    </div>;
}

// the name above the control, for narrow columns without room for the longest name beside it
export function stacked(
    label: string, input: React.ReactNode, hint?: string, span = 1 // grid columns, for a dropdown or an address
): React.JSX.Element {
    return <div
        className='vp-inspector-field'
        key={label}
        title={hint}
        style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
    >
        <label>{label}</label>
        {input}
    </div>;
}

// writes every keystroke straight through, as the panels poll and anything not written back is overwritten by the
// next refresh. A value that does not parse (an emptied field) is dropped rather than written as a zero
export function numberInput(
    value: number,
    min: number,
    max: number,
    commit: (value: number) => void,
    step?: number
): React.JSX.Element {
    return <input
        type='number'
        className='vp-input'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => {
            const parsed = parseInt(e.target.value, 10);
            if (!Number.isNaN(parsed)) {
                commit(Math.min(max, Math.max(min, parsed)));
            }
        }}
    />;
}
