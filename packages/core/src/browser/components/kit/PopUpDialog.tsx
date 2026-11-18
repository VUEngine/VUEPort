import { Warning, X } from '@phosphor-icons/react';
import React, { PropsWithChildren, useEffect } from 'react';
import styled from 'styled-components';
import { nls } from '../../../common/emulator-nls';
import HContainer from './HContainer';

const StyledError = styled(HContainer)`
    align-items: center;
    color: var(--vp-danger);
    flex-grow: 2;
`;

interface PopUpDialogProps {
    open: boolean
    onClose: () => void
    onOk: () => void
    okLabel?: string
    title: string
    error?: string
    height?: string
    width?: string
    maxWidth?: string
    okButton?: boolean
    disableOkButton?: boolean
    cancelButton?: boolean
    overflow?: string
}

export default function PopUpDialog(props: PropsWithChildren<PopUpDialogProps>): React.JSX.Element {
    const { open, onClose, onOk, okLabel, title, error, height, width, maxWidth, okButton, disableOkButton, cancelButton, children, overflow } = props;

    const onKeyDown = (e: KeyboardEvent) => {
        switch (e.key) {
            case 'Escape':
                return onClose();
            case 'Enter':
                return onOk();
        }
    };

    useEffect(() => {
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    return <div
        className="lm-Widget dialogOverlay"
        style={{
            display: open ? 'flex' : 'none',
            height: '100%',
            position: 'absolute',
            width: '100%',
        }}
    >
        <div className="dialogBlock" style={{
            height,
            maxWidth: maxWidth ?? '100%',
            minWidth: '100px',
            overflow: 'hidden',
            width,
        }}
        >
            <div className="dialogTitle">
                <div>{title}</div>
                <div
                    className="action-label closeButton"
                    onClick={onClose}
                >
                    <X size={16} />
                </div>
            </div>
            <div className="dialogContent" style={{ flexGrow: 1, maxHeight: 'unset', overflow }}>
                {children}
            </div>
            <HContainer className="dialogControl">
                <StyledError>
                    {error && <>
                        <Warning size={20} /> {error}
                    </>}
                </StyledError>
                {cancelButton &&
                    <button
                        className="vp-button secondary"
                        onClick={onClose}
                    >
                        {nls.localize('vueport/general/cancel', 'Cancel')}
                    </button>
                }
                {(okButton === undefined || okButton === true) &&
                    <button
                        className="vp-button main"
                        onClick={onOk}
                        disabled={!!error || disableOkButton}
                        style={{
                            minWidth: '65px',
                        }}
                    >
                        {okLabel ? okLabel : 'OK'}
                    </button>
                }
            </HContainer>
        </div>
    </div>;
}
