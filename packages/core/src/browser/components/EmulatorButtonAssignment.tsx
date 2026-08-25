import * as React from 'react';
import styled from 'styled-components';
import { nls } from '../../common/emulator-nls';
import { VueportBindableCommand, VueportInputBindings } from '../../common/emulator-settings';

/**
 * One command, showing the keys bound to it, and rebinding them when clicked.
 *
 * A copy of VES's `ButtonAssignment` rather than a use of it: that one
 * takes `VesCommonService`, and this has to work in a host that has none. The
 * two are small and are expected to drift.
 */
const StyledButtonAssignment = styled.div`
    background-color: var(--theia-list-hoverBackground);
    border-radius: 2px;
    cursor: pointer;
    display: flex;

    &.none {
        .buttonLabel {
            opacity: .2;
        }
    }

    &:hover,
    &.highlighted {
        background-color: var(--theia-list-dropBackground);
        color: var(--theia-list-hoverForeground);
    }

    & > span {
        align-items: center;
        display: flex;
        padding: var(--theia-ui-padding) calc(var(--theia-ui-padding) * 2);

        &:first-child {
            flex-grow: 1;
        }

        &:last-child {
            max-width: 128px;
            min-width: 128px;
        }
    }

    .theia-button {
        margin: 0;
        max-width: 128px;
        min-width: 128px;
    }
`;

/** Just enough of a command to name it and find its mapping. */
export type EmulatorAssignableCommand = VueportBindableCommand;

export interface EmulatorButtonAssignmentProps {
    command: EmulatorAssignableCommand;
    bindings: VueportInputBindings;
    /** The context a mapping made here applies in, e.g. `emulatorFocus`. */
    when?: string;
    className?: string;
    width?: number;
    refObject?: React.RefObject<HTMLDivElement>;
    onMouseEnter?: React.MouseEventHandler;
    onMouseLeave?: React.MouseEventHandler;
}

export default function EmulatorButtonAssignment(
    props: EmulatorButtonAssignmentProps
): React.JSX.Element {
    const { command, bindings, when, className, width, refObject, onMouseEnter, onMouseLeave } = props;
    // The mapping is read as this renders, so a change made in the capture
    // dialog shows up by rendering again.
    const [, setChanged] = React.useState(0);

    const classNames = [];
    if (className) {
        classNames.push(className);
    }

    const assign = async () => {
        if (await bindings.capture(command, when)) {
            setChanged(changed => changed + 1);
        }
    };

    let label = bindings.label(command.id, false);
    if (label === '') {
        classNames.push('none');
        label = `(${nls.localize('vueport/controls/none', 'none')})`;
    }

    return <StyledButtonAssignment
        className={classNames.join(' ')}
        ref={refObject}
        onClick={assign}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        style={{ width }}
    >
        <span>{command.label}</span>
        <span>
            <button className='theia-button secondary'>
                <span className='buttonLabel'>{label}</span>
            </button>
        </span>
    </StyledButtonAssignment>;
}
