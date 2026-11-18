import { Bandaids, Plus } from '@phosphor-icons/react';
import React, { ReactElement } from 'react';
import styled from 'styled-components';
import { nls } from '../../../common/emulator-nls';

const StyledActions = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: var(--vp-space);
    justify-content: center;
    margin-top: 20px;
`;

const StyledContainer = styled.div`
    align-items: center;
    color: var(--vp-text-dim);
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    gap: var(--vp-space);
    inset: 0;
    justify-content: center;
    padding: var(--vp-space-x2);
    position: absolute;
    text-align: center;

    /* The icon is the quietest thing here; the title carries the weight. */
    > svg:first-child { color: var(--vp-field-border); }
`;

export interface EmptyContainerAction {
    label: string;
    icon?: ReactElement; // defaults to a plus
    iconCls?: string;
    primary?: boolean;
    disabled?: boolean;
    onClick: () => void;
}

interface EmptyContainerProps {
    title: string;
    description?: string;
    icon?: ReactElement;
    buttonIconCls?: string;
    buttonIcon?: ReactElement; // wins over buttonIconCls (a font glyph), as the standalone build ships no icon font
    buttonLabel?: string;
    onClick?: () => void
    actions?: EmptyContainerAction[]; // wins over the single-button props
}

export default function EmptyContainer(props: EmptyContainerProps): React.JSX.Element {
    const { title, description, icon, buttonIconCls, buttonIcon, buttonLabel, onClick } = props;

    const actions: EmptyContainerAction[] = props.actions
        ?? (onClick
            ? [{
                label: buttonLabel ?? nls.localize('vueport/general/add', 'Add'),
                icon: buttonIcon,
                iconCls: buttonIconCls,
                onClick,
            }]
            : []);

    return <StyledContainer>
        {icon ? icon : <Bandaids size={32} />}
        <div
            style={{
                color: 'var(--vp-text)',
                fontSize: '130%',
                fontWeight: 600,
            }}
        >
            {title}
        </div>
        {description &&
            <div
                style={{
                    maxWidth: 460,
                    textAlign: 'center',
                }}
            >
                {description}
            </div>
        }
        {actions.length > 0 &&
            <StyledActions>
                {actions.map((action, index) =>
                    <button
                        key={`empty-container-action-${index}`}
                        className={`vp-button large${action.primary ? '' : ' secondary'}`}
                        disabled={action.disabled}
                        onClick={action.onClick}
                    >
                        {action.icon
                            ?? (action.iconCls
                                ? <i className={action.iconCls} />
                                : <Plus size={16} />)
                        }
                        {action.label}
                    </button>
                )}
            </StyledActions>
        }
    </StyledContainer>;
}
