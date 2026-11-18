import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { ScreenPanel } from '../panels/emulator-screen-panel';
import RadioSelect from './kit/RadioSelect';

export interface EmulatorScreenPreviewProps {
    screen: ScreenPanel;
    // still shown when there is no game, recolored through the current palette (see ScreenPanel.setPlaceholder).
    // A host without one gets only the live picture and no picker
    placeholder?: string;
    loaded: boolean;
}

// the Display pane's preview, a mini screen panel. Presentation belongs to the worker and only one element can hold
// it, so this borrows the picture (with decoration and scale) while mounted and gives it back on unmount. With no
// game it shows the still instead, run through the palette
export default function EmulatorScreenPreview(
    props: EmulatorScreenPreviewProps,
): React.JSX.Element {
    const { screen, placeholder, loaded } = props;
    const host = React.useRef<HTMLDivElement>(null);
    const [source, setSource] = React.useState<'placeholder' | 'live'>(
        loaded || !placeholder ? 'live' : 'placeholder',
    );

    React.useEffect(() => {
        if (placeholder) {
            screen.setPlaceholder(placeholder).catch(() => undefined);
        }
    }, [screen, placeholder]);

    React.useEffect(() => {
        const node = host.current;
        if (!node) {
            return undefined;
        }
        screen.lendPicture(node, { fit: false, decorate: true });
        return () => {
            screen.showPlaceholder(false);
            screen.returnPicture();
        };
    }, [screen]);

    const showPlaceholder = !!placeholder && (source === 'placeholder' || !loaded);
    React.useEffect(() => {
        screen.showPlaceholder(showPlaceholder);
    }, [screen, showPlaceholder]);

    // the box needs an intrinsic shape for the borrowed frame to fit into. The still is laid out to the same geometry
    // as a live picture; web-emulator re-renders this on every setting change, so a mode switch is picked up here
    const { width, height } = screen.pictureSize;

    return <>
        {placeholder &&
            <RadioSelect
                fitSpace
                options={[
                    {
                        value: 'placeholder',
                        label: nls.localize('vueport/palettes/preview/placeholder', 'Placeholder'),
                    },
                    {
                        value: 'live',
                        label: nls.localize('vueport/palettes/preview/live', 'Live image'),
                        disabled: !loaded,
                    },
                ]}
                defaultValue={showPlaceholder ? 'placeholder' : 'live'}
                onChange={chosen => setSource(chosen[0].value as 'placeholder' | 'live')}
            />}
        <div
            className='vp-screen-preview'
            ref={host}
            style={{ aspectRatio: `${width} / ${height}` }}
        />
    </>;
}
