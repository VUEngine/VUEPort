
import React, { ReactElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { useKit, VueportHover } from './KitContext';
import { useTooltipContents } from './tooltip-content';

// the current option sits on a block (StyledThumb) that slides between options. Falls back to per-option
// backgrounds (class `no-thumb`) when there is no single option to sit under: multi-select or nothing selected
const StyledRadioSelect = styled.div`
    background: var(--vp-bg);
    border: 1px solid var(--vp-control);
    border-radius: var(--vp-radius-large);
    display: flex;
    flex-direction: row;
    gap: 2px;
    outline: none !important;
    padding: 2px;
    position: relative;
    user-select: none;

    &.canSelectMany {
        gap: 4px;
    }

    &.small {
        border-radius: var(--vp-radius);
        padding: 1px;
    }

    &.disabled {
        opacity: .5;
    }

    &:hover,
    &:focus {
        border-color: var(--vp-accent);
    }
`;

const StyledThumb = styled.div`
    background-color: var(--vp-control);
    border-radius: var(--vp-radius);
    bottom: 2px;
    box-shadow: 0 1px 2px var(--vp-shadow);
    left: 0;
    position: absolute;
    top: 2px;
    transition: transform 200ms cubic-bezier(0.32, 0.72, 0, 1),
                width 200ms cubic-bezier(0.32, 0.72, 0, 1);
`;

const StyledRadioSelectOption = styled.div`
    align-items: center;
    border-radius: var(--vp-radius);
    color: var(--vp-text-dim);
    cursor: pointer;
    display: flex;
    font-family: var(--vp-font-ui);
    font-size: var(--vp-font-size);
    height: calc(var(--vp-control-height) - 8px);
    justify-content: center;
    line-height: 1;
    padding: 0 var(--vp-space);
    position: relative;
    text-align: center;
    transition: color 120ms ease;
    white-space: nowrap;
    z-index: 1;

    &:hover {
        color: var(--vp-text);
    }

    &.selected {
        color: var(--vp-selected-text);
    }

    ${StyledRadioSelect}.no-thumb &.selected {
        background-color: var(--vp-control);
        box-shadow: 0 1px 2px var(--vp-shadow);
    }

    /* small: to sit among small tool buttons (e.g. the VB Color editor's toolbar) */
    ${StyledRadioSelect}.small & {
        font-size: 11px;
        height: 18px;
        padding: 0 6px;
    }

    ${StyledRadioSelect}.disabled & {
        cursor: default;
    }

    &.disabled {
        cursor: default;
        opacity: 0.4;
    }

    &.disabled:hover {
        color: var(--vp-text-dim);
    }
`;

export interface RadioSelectOption {
    value: string | number | boolean
    label?: string | ReactElement
    tooltip?: string | ReactElement
    tooltipPosition?: string
    disabled?: boolean
}

interface RadioSelectProps {
    options: RadioSelectOption[]
    canSelectMany?: boolean
    allowBlank?: boolean
    defaultValue: string | number | boolean | (string | number | boolean)[]
    onChange: (options: RadioSelectOption[]) => void
    fitSpace?: boolean
    disabled?: boolean
    hover?: VueportHover
    size?: 'small'
}

function indexesOf(
    value: string | number | boolean | (string | number | boolean)[],
    options: RadioSelectOption[],
): number[] {
    const wanted = Array.isArray(value) ? value : [value];
    const found: number[] = [];
    options.forEach((o, i) => {
        if (wanted.includes(o.value)) {
            found.push(i);
        }
    });
    return found;
}

export default function RadioSelect(props: RadioSelectProps): React.JSX.Element {
    const { allowBlank, options, canSelectMany, defaultValue, onChange, fitSpace, disabled, hover, size } = props;
    const { hover: contextHover, setCommandsEnabled } = useKit();
    const tooltips = useTooltipContents(options.map(o => o.tooltip));
    // seeded from the default so the first paint already has a selection, else the block pops in a frame late
    const [currentIndexes, setCurrentIndexes] = useState<number[]>(() => indexesOf(defaultValue, options));
    const [classes, setClasses] = useState<string>();
    const numberOfOptions = options.length;

    const containerRef = useRef<HTMLDivElement>(null);
    const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
    const [thumb, setThumb] = useState<{ x: number, w: number } | null>(null);
    // the block is placed before it may move, so it does not glide in on mount
    const [animate, setAnimate] = useState(false);

    const soleIndex = !canSelectMany && currentIndexes.length === 1 ? currentIndexes[0] : -1;

    const placeThumb = useCallback(() => {
        const container = containerRef.current;
        const option = soleIndex >= 0 ? optionRefs.current[soleIndex] : null;
        if (!container || !option) {
            setThumb(null);
            return;
        }
        const c = container.getBoundingClientRect();
        const o = option.getBoundingClientRect();
        setThumb({ x: o.left - c.left - container.clientLeft, w: o.width });
    }, [soleIndex]);

    useLayoutEffect(placeThumb, [placeThumb, options, fitSpace, canSelectMany]);

    useEffect(() => {
        if (thumb && !animate) {
            const id = requestAnimationFrame(() => setAnimate(true));
            return () => cancelAnimationFrame(id);
        }
        return undefined;
    }, [thumb, animate]);

    // the control can change width without re-rendering (fitSpace in a resizing row, a late web-font swap)
    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return undefined;
        }
        const observer = new ResizeObserver(() => placeThumb());
        observer.observe(container);
        return () => observer.disconnect();
    }, [placeThumb]);

    const getValues = () => {
        setCurrentIndexes(indexesOf(defaultValue, options));
    };

    const getClasses = () => {
        const c: string[] = [];
        if (canSelectMany) {
            c.push('canSelectMany');
        }
        if (disabled) {
            c.push('disabled');
        }
        setClasses(c.join(' '));
    };

    const handleKeyPress = (e: React.KeyboardEvent): void => {
        if (!canSelectMany && e.key === 'ArrowLeft') {
            if (currentIndexes[0] === 0) {
                updateValue([numberOfOptions - 1]);
            } else {
                updateValue([currentIndexes[0] - 1]);
            }
        } else if (!canSelectMany && e.key === 'ArrowRight') {
            if (currentIndexes[0] === numberOfOptions - 1) {
                updateValue([0]);
            } else {
                updateValue([currentIndexes[0] + 1]);
            }
        } else if (canSelectMany && e.key === 'ArrowUp') {
            // select all
            const allIndexes: number[] = [];
            [...Array(numberOfOptions)].map((i, c) => {
                allIndexes.push(c);
            });
            updateValue(allIndexes);
        } else if (canSelectMany && e.key === 'ArrowDown') {
            // deselect all
            updateValue([]);
        }
    };

    const toggleValue = (i: number): void => {
        if (disabled || options[i]?.disabled) {
            return;
        }

        if (canSelectMany) {
            if (currentIndexes.includes(i)) {
                updateValue(currentIndexes.filter(ci => ci !== i));
            } else {
                updateValue([...structuredClone(currentIndexes), i]);
            }
        } else {
            updateValue([i]);
        }

        setCommandsEnabled(true);
    };

    const updateValue = (i: number[]): void => {
        if (!allowBlank && i.length === 0) {
            return;
        }
        // arrow keys route through here rather than toggleValue, and skip disabled options
        if (i.some(n => options[n]?.disabled)) {
            return;
        }

        setCurrentIndexes(i);
        const updatedOptions: RadioSelectOption[] = [];
        i.map(n => {
            updatedOptions.push(options[n]);
        });
        onChange(updatedOptions);
    };

    const handleOnFocus = () => {
        setCommandsEnabled(false);
    };

    const handleOnBlur = () => {
        setCommandsEnabled(true);
    };

    useEffect(() => {
        getValues();
        getClasses();
    }, [
        canSelectMany,
        defaultValue,
        disabled,
    ]);

    const showThumb = soleIndex >= 0 && thumb !== null;

    return <StyledRadioSelect
        ref={containerRef}
        className={[classes, size, soleIndex < 0 ? 'no-thumb' : undefined].filter(Boolean).join(' ')}
        // shrink to the options unless the caller wants it to fill its row; an empty stretch of track reads as a bug
        style={{ width: fitSpace ? undefined : 'max-content' }}
        onKeyDown={handleKeyPress}
        onFocus={handleOnFocus}
        onBlur={handleOnBlur}
        tabIndex={0}
    >
        {showThumb && thumb &&
            <StyledThumb style={{
                transform: `translateX(${thumb.x}px)`,
                width: `${thumb.w}px`,
                transition: animate ? undefined : 'none',
            }} />}
        {options.map((o, i) =>
            <StyledRadioSelectOption
                key={`radio-select-option-${i}`}
                ref={el => { optionRefs.current[i] = el; }}
                // `vp-radio-option` is for anything steering the control from outside, e.g. the settings window's
                // gamepad navigation
                className={['vp-radio-option', currentIndexes.includes(i) ? 'selected' : '', o.disabled ? 'disabled' : '']
                    .filter(Boolean).join(' ')}
                onClick={() => toggleValue(i)}
                style={{ flexGrow: fitSpace ? 1 : 0 }}
                onMouseEnter={event => {
                    const content = tooltips.resolve(i);
                    if (content) {
                        const hs = hover ?? contextHover;
                        hs.show(event.currentTarget, content);
                    }
                }}
                onMouseLeave={event => {
                    if (o.tooltip) {
                        const hs = hover ?? contextHover;
                        hs.hide();
                    }
                }}
            >
                {o.label ? o.label : o.value}
            </StyledRadioSelectOption>
        )}
        {tooltips.portals}
    </StyledRadioSelect>;
}
