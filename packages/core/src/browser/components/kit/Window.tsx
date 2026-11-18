import * as React from 'react';
import { nls } from '../../../common/emulator-nls';
import { pushEscapeLayer } from './escape-layers';
import { pushBackHandler } from '../../back-navigation';
import { X } from '@phosphor-icons/react';

// used by both hosts; the studio puts only the settings window into its own `PopUpDialog` (`SettingsWindow`'s `frame`)
export function Window(props: {
    title: string,
    icon: React.ReactNode,
    onClose: () => void,
    children: React.ReactNode,
    large?: boolean, // take the whole 90% the backdrop allows, for the controller window
    compact?: boolean, // size to the content rather than the fixed 60×45rem
    sidebar?: React.ReactNode, // a column left of the body, outside the scroll region
    headerActions?: React.ReactNode,
    closable?: boolean, // false for a window without a close button (the settings in a headset)
    className?: string,
}): React.JSX.Element {
    const { title, icon, onClose, children, large, compact, sidebar, headerActions, closable = true, className } = props;

    // read through a ref so the effect runs once. Re-running it would put this window's layer back on top of
    // anything opened over it
    const close = React.useRef(onClose);
    close.current = onClose;

    React.useEffect(() => {
        const layer = pushEscapeLayer();
        const onKeyDown = (e: KeyboardEvent) => {
            // not this window's Escape if something was opened over it (e.g. a key capture), nor while one of its
            // dropdowns is open: that Escape shuts the menu
            const target = e.target instanceof Element ? e.target : undefined;
            if (e.key === 'Escape' && layer.isTop() && !target?.closest('[aria-expanded="true"]')) {
                e.stopPropagation();
                close.current();
            }
        };
        // capture phase, as the emulator's key handler would otherwise read Escape as a game input
        window.addEventListener('keydown', onKeyDown, true);
        // the device's Back closes it too, where the host lets it (see back-navigation.ts)
        const back = closable ? pushBackHandler(() => close.current()) : undefined;
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            layer.dispose();
            back?.();
        };
    }, []);

    return <div className='vp-window-backdrop' onMouseDown={onClose}>
        <div
            className={'vp-window'
                + (large ? ' vp-window-large' : '')
                + (compact ? ' vp-window-compact' : '')
                + (className ? ` ${className}` : '')}
            role='dialog'
            aria-modal='true'
            aria-label={title}
            onMouseDown={e => e.stopPropagation()}
        >
            <header>
                <div className='vp-window-title'>
                    {icon}
                    <h2>{title}</h2>
                </div>
                {headerActions}
                {closable && <button
                    className='vp-window-close'
                    onClick={onClose}
                    title={nls.localize('vueport/state/close', 'Close')}
                    aria-label={nls.localize('vueport/state/close', 'Close')}
                >
                    <X size={18} />
                </button>}
            </header>
            <div className='vp-window-main'>
                {sidebar &&
                    <div className='vp-window-sidebar vp-scroll'>{sidebar}</div>}
                <div className='vp-window-body vp-scroll'>
                    {children}
                </div>
            </div>
        </div>
    </div>;
}
