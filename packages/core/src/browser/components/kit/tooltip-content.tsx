import { ReactElement, ReactNode, useRef } from 'react';
import { createPortal } from 'react-dom';

// JSX tooltips for a hover service that takes a string or an element (VueportHover.show). A portal into a detached
// div renders them in the ordinary tree instead of pulling React's server renderer into the bundle. Containers are
// kept per index, so a re-render never hands the hover a container it no longer fills
export interface TooltipContents {
    resolve(index: number): string | HTMLElement | undefined
    // must be rendered somewhere in the component's own output
    portals: ReactNode
}

export type Tooltip = string | ReactElement | undefined;

export function useTooltipContents(tooltips: Tooltip[]): TooltipContents {
    const containers = useRef(new Map<number, HTMLElement>());

    const containerFor = (index: number): HTMLElement | undefined => {
        if (typeof document === 'undefined') {
            return undefined;
        }
        let container = containers.current.get(index);
        if (!container) {
            container = document.createElement('div');
            containers.current.set(index, container);
        }
        return container;
    };

    const portals = tooltips.map((tooltip, index) => {
        if (!tooltip || typeof tooltip === 'string') {
            return undefined;
        }
        const container = containerFor(index);
        return container ? createPortal(tooltip, container, `vp-tooltip-${index}`) : undefined;
    });

    return {
        resolve: index => {
            const tooltip = tooltips[index];
            if (!tooltip) {
                return undefined;
            }
            return typeof tooltip === 'string' ? tooltip : containerFor(index);
        },
        portals,
    };
}
