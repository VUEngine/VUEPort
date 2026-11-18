// Phosphor's `memory` glyph, drawn here as the pinned @phosphor-icons/react 2.0.15 lacks it and upgrading would restyle
// every icon. Path verbatim from https://github.com/phosphor-icons/core (MIT), regular weight
import * as React from 'react';

export function MemoryIcon(props: { size?: number }): React.JSX.Element {
    const size = props.size ?? 18;
    return <svg
        width={size}
        height={size}
        viewBox='0 0 256 256'
        fill='currentColor'
        aria-hidden='true'
    >
        {/* the chip body and its pins, then the two dies inside it; broken across lines only, the path is verbatim */}
        <path d={
            'M232,56H24A16,16,0,0,0,8,72V200a8,8,0,0,0,16,0V184H40v16a8,8,0,0,0,16,0V184H72v16'
            + 'a8,8,0,0,0,16,0V184h16v16a8,8,0,0,0,16,0V184h16v16a8,8,0,0,0,16,0V184h16v16'
            + 'a8,8,0,0,0,16,0V184h16v16a8,8,0,0,0,16,0V184h16v16a8,8,0,0,0,16,0V72'
            + 'A16,16,0,0,0,232,56ZM24,72H232v96H24Z'
            + 'm88,80a8,8,0,0,0,8-8V96a8,8,0,0,0-8-8H48a8,8,0,0,0-8,8v48a8,8,0,0,0,8,8Z'
            + 'M56,104h48v32H56Z'
            + 'm88,48h64a8,8,0,0,0,8-8V96a8,8,0,0,0-8-8H144a8,8,0,0,0-8,8v48A8,8,0,0,0,144,152Z'
            + 'm8-48h48v32H152Z'
        } />
    </svg>;
}
