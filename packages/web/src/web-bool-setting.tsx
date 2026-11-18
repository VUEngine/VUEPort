import * as React from 'react';
import ResetButton from 'vueport-core/lib/browser/components/kit/ResetButton';
import Switch from 'vueport-core/lib/browser/components/kit/Switch';

// one switch, shaped like every other boolean setting in the settings dialog (label, revert button, switch,
// description); shared so the panes do not keep copies in step
export function BoolSetting(props: {
    label: string,
    hint?: string,
    value: boolean,
    fallback: boolean,
    onChange: (value: boolean) => void,
}): React.JSX.Element {
    return <div className='vp-bool-setting'>
        <div className='vp-bool-title'>
            <span>{props.label}</span>
            <ResetButton
                disabled={props.value === props.fallback}
                onReset={() => props.onChange(props.fallback)}
            />
        </div>
        <div className='vp-bool-control'>
            <Switch label={props.label} value={props.value} onChange={props.onChange} />
            {props.hint && <span className='vp-bool-description'>{props.hint}</span>}
        </div>
    </div>;
}
