import { CaretDown } from '@phosphor-icons/react';
import React, { ReactElement, ReactNode } from 'react';
import Dropdown, { DropdownEntry, Option } from 'react-dropdown';

export interface SelectOption {
    value: string;
    label: ReactNode;
    icon?: ReactElement; // shows in the menu row, and in the control once chosen
    disabled?: boolean;
}

export interface SelectGroup {
    group: ReactNode;
    options: SelectOption[];
}

export type SelectEntry = SelectOption | SelectGroup;

export interface SelectProps {
    options: SelectEntry[];
    value: string;
    onChange: (value: string) => void;
    icon?: ReactElement; // always in the control, whatever is chosen
    placeholder?: ReactNode;
    disabled?: boolean;
    label?: string;
    title?: string;
    size?: 'small' | 'large';
    // `content` sizes the menu to its longest row, for a control narrower than its options
    menuWidth?: 'control' | 'content';
    className?: string;
    style?: React.CSSProperties;
}

const MIN_MENU_HEIGHT = 120; // the least room below that is still worth opening downwards into
const MENU_GAP = 2;

export default function Select(props: SelectProps): React.JSX.Element {
    const { options, value, onChange, icon, disabled } = props;
    const root = React.useRef<HTMLDivElement>(null);
    const [open, setOpen] = React.useState(false);

    // the menu gets fixed window coordinates while open, so a scrolling panel does not clip it. It stays a
    // child of the control, so outside clicks and keys keep working, and flips above when there is more room
    React.useLayoutEffect(() => {
        const control = root.current?.querySelector<HTMLElement>('.vp-dropdown-control');
        const menu = root.current?.querySelector<HTMLElement>('.vp-dropdown-menu');
        if (!open || !control || !menu) {
            return undefined;
        }
        const place = (): void => {
            const box = control.getBoundingClientRect();
            const below = window.innerHeight - box.bottom - MENU_GAP * 2;
            const above = box.top - MENU_GAP * 2;
            const flip = below < Math.min(menu.scrollHeight, MIN_MENU_HEIGHT) && above > below;
            menu.style.position = 'fixed';
            menu.style.left = `${box.left}px`;
            menu.style.right = 'auto';
            if (props.menuWidth === 'content') {
                menu.style.width = 'max-content';
                menu.style.minWidth = `${box.width}px`;
                menu.style.maxWidth = `${Math.max(box.width, window.innerWidth - box.left - MENU_GAP * 2)}px`;
            } else {
                menu.style.width = `${box.width}px`;
                // the stylesheet's `min-width: 100%` would be the window's width once the menu is fixed
                menu.style.minWidth = '0';
            }
            menu.style.maxHeight = `${Math.max(MIN_MENU_HEIGHT, flip ? above : below)}px`;
            menu.style.top = flip ? 'auto' : `${box.bottom + MENU_GAP}px`;
            menu.style.bottom = flip ? `${window.innerHeight - box.top + MENU_GAP}px` : 'auto';
        };
        place();
        // capture, so a scroll in any panel in between moves the menu with the control
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => {
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
        };
    }, [open, options, props.menuWidth]);

    // react-dropdown draws the chosen option's label in the control too, so the icon goes into the label
    const toOption = (option: SelectOption): Option => ({
        value: option.value,
        label: option.icon
            ? <span className='vp-dropdown-item'>{option.icon}{option.label}</span>
            : option.label,
        disabled: option.disabled,
        data: { value: option.value }, // lets tests find a menu row by value, as the `<li>` only carries its label
    });
    const entries: DropdownEntry[] = options.map(entry => ('group' in entry
        ? { type: 'group' as const, name: entry.group, items: entry.options.map(toOption) }
        : toOption(entry)));

    const classes = ['vp-dropdown'];
    if (props.size) {
        classes.push(props.size);
    }
    if (icon) {
        classes.push('with-icon');
    }
    if (props.className) {
        classes.push(props.className);
    }

    return <div ref={root} className={classes.join(' ')} style={props.style} title={props.title}>
        {icon && <span className='vp-dropdown-icon' aria-hidden='true'>{icon}</span>}
        <Dropdown
            baseClassName='vp-dropdown'
            options={entries}
            value={value}
            disabled={disabled}
            placeholder={props.placeholder}
            aria-label={props.label}
            onChange={option => onChange(String(option.value))}
            onOpenChange={setOpen}
            arrowClosed={<CaretDown size={14} />}
            arrowOpen={<CaretDown size={14} />}
        />
    </div>;
}
