import { MagnifyingGlass, X } from '@phosphor-icons/react';
import React from 'react';
import { nls } from '../../../common/emulator-nls';

interface PanelFilterProps {
    value: string;
    onChange(value: string): void;
    placeholder?: string;
    status?: React.ReactNode;
    missed?: boolean;
}

export default function PanelFilter({
    value, onChange, placeholder, status, missed,
}: PanelFilterProps): React.JSX.Element {
    const label = placeholder ?? nls.localize('vueport/general/filter', 'Filter');
    return <div className={`vp-panel-filter${missed ? ' missed' : ''}`}>
        <MagnifyingGlass size={15} />
        <input
            type='text'
            spellCheck={false}
            value={value}
            placeholder={label}
            aria-label={label}
            onChange={event => onChange(event.target.value)}
        />
        {status}
        {value &&
            <button
                type='button'
                className='vp-panel-filter-clear'
                aria-label={nls.localize('vueport/general/clear', 'Clear')}
                onClick={() => onChange('')}
            >
                <X size={14} />
            </button>}
    </div>;
}
