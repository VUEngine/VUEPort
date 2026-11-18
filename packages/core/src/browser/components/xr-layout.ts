import React from 'react';
import { XR_LAYOUT_CLASS } from '../emulator-xr-dom';

// whether the page is being shown in a headset (see emulator-xr-ui.ts), for leaving out settings that do nothing
// there; follows the class on <html>, as React renders on in a session while the page is not painted
export function useXrLayout(): boolean {
    const [inHeadset, setInHeadset] = React.useState(() =>
        typeof document !== 'undefined' && document.documentElement.classList.contains(XR_LAYOUT_CLASS));
    React.useEffect(() => {
        const root = document.documentElement;
        const observer = new MutationObserver(() => setInHeadset(root.classList.contains(XR_LAYOUT_CLASS)));
        observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        setInHeadset(root.classList.contains(XR_LAYOUT_CLASS));
        return () => observer.disconnect();
    }, []);
    return inHeadset;
}
