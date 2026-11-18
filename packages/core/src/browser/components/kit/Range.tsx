import React, { PropsWithChildren } from 'react';
import { clamp } from './Utils';
import HContainer from './HContainer';
import Input from './Input';
import { useKit } from './KitContext';
import Select, { SelectOption } from './Select';

interface RangeProps {
    min: number
    max: number
    step?: number
    value: number
    clearable?: boolean
    disabled?: boolean
    options?: SelectOption[]
    setValue: (value: number) => void
    width?: string | number
    selectWidth?: number
    containerStyle?: object
}

export default function Range(props: PropsWithChildren<RangeProps>): React.JSX.Element {
    const { setCommandsEnabled } = useKit();
    const { min, max, step, value, clearable, disabled, options, setValue, width, selectWidth, containerStyle } = props;

    const onChange = (val: string) => {
        const v = !val
            ? min
            : Number.isInteger(val)
                ? parseInt(val)
                : parseFloat(val);
        setValue(clamp(v, min, max));
    };

    const handleOnFocus = () => setCommandsEnabled(false);

    const handleOnBlur = () => setCommandsEnabled(true);

    // 0-100, for `--range-fill`, which paints the filled part of the track (see the input[type="range"] rules in
    // emulator-widget.css)
    const fill = clamp(Math.ceil(100 / (max - min) * ((value ?? max) - min)), 0, 100);

    // tick marks only where the step is coarse enough to count by eye. `--range-steps` is the number of intervals,
    // the CSS draws a notch at the end of each
    const segments = step && step > 1 ? (max - min) / step : 0;
    const showTicks = false; // Number.isInteger(segments) && segments >= 2 && segments <= 40;

    return (
        <HContainer alignItems="center" style={{ ...(containerStyle ?? {}), width }}>
            <input
                type="range"
                className={`value-${fill}${showTicks ? ' has-steps' : ''}`}
                style={{
                    flexGrow: 1,
                    '--range-fill': `${fill}%`,
                    ...(showTicks ? { '--range-steps': segments } : {}),
                } as React.CSSProperties}
                min={min}
                max={max}
                step={step}
                value={value ?? max}
                onChange={e => onChange(e.target.value)}
                onFocus={handleOnFocus}
                onBlur={handleOnBlur}
                disabled={disabled}
            />
            {
                options
                    ? <Select
                        options={options}
                        value={String(value ?? max)}
                        onChange={onChange}
                        disabled={disabled}
                        style={selectWidth ? { width: selectWidth } : undefined}
                    />
                    : <Input
                        type="number"
                        // the slider's echo, which gamepad navigation skips
                        className='vp-range-value'
                        style={{ minWidth: 64, width: 64 }}
                        value={value ?? max}
                        setValue={setValue}
                        min={min}
                        max={max}
                        step={step}
                        clearable={clearable}
                        disabled={disabled}
                    />
            }
        </HContainer>
    );
}

