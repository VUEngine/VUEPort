import * as React from 'react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import RadioSelect from 'vueport-core/lib/browser/components/kit/RadioSelect';
import ResetButton from 'vueport-core/lib/browser/components/kit/ResetButton';
import { BoxFace } from './web-library-types';
import {
    CUSTOM_EMPTY_BOX,
    DEFAULT_EMPTY_BOX,
    EMPTY_BOX_SETS,
    customEmptyBoxFace,
    emptyBoxSet,
    onDidChangeEmptyBox,
    setCustomEmptyBoxFace,
    setEmptyBoxSet,
} from './web-empty-box';
import { BoxNet, BoxPicture, boxFaceLabel } from './web-library-box';

// the shipped sets and the user's own, always drawn unfolded so the choice is made by looking. A face of the own set
// can be given a picture or lose it; changes are kept at once
export function EmptyBoxSetting(): React.JSX.Element {
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        const subscription = onDidChangeEmptyBox(() => bump());
        return () => subscription.dispose();
    }, []);
    const [face, setFace] = React.useState<BoxFace>('front');
    const file = React.useRef<HTMLInputElement>(null);

    const chosen = emptyBoxSet();
    const custom = chosen === CUSTOM_EMPTY_BOX;
    const own = custom ? customEmptyBoxFace(face) : undefined;

    return <div className='vp-select-setting'>
        <div className='vp-bool-title'>
            <span>{nls.localize('vueport/library/emptyBox/title', 'Empty Box')}</span>
            <ResetButton
                disabled={chosen === DEFAULT_EMPTY_BOX}
                onReset={() => setEmptyBoxSet(DEFAULT_EMPTY_BOX)}
            />
        </div>
        <div className='vp-hint'>
            {nls.localize('vueport/library/emptyBox/hint',
                'What a game without a cover is shown as. In a box of your own, faces you leave empty come \
from the Japanese box.')}
        </div>
        <RadioSelect
            options={[
                ...EMPTY_BOX_SETS.map(set => ({ value: set.id, label: set.label() })),
                { value: CUSTOM_EMPTY_BOX, label: nls.localize('vueport/library/emptyBox/custom', 'Custom') },
            ]}
            defaultValue={chosen}
            onChange={options => setEmptyBoxSet(String(options[0].value))}
        />

        <div className='vp-empty-box'>
            <BoxNet
                selected={custom ? face : undefined}
                onSelect={custom ? setFace : undefined}
                render={entry => <BoxPicture face={entry} />}
            />
            {custom && <div className='vp-empty-box-side'>
                <h3 className='vp-empty-box-title'>{boxFaceLabel(face)}</h3>
                <p>
                    {own
                        ? nls.localize('vueport/library/picture/own', 'Your own picture')
                        : nls.localize('vueport/library/emptyBox/fromStandard', 'From the Japanese box')}
                    {own?.name && <span className='vp-hint'>{own.name}</span>}
                </p>
                <div className='vp-library-edit-picture-actions'>
                    <button className='vp-button secondary' onClick={() => file.current?.click()}>
                        {nls.localize('vueport/library/choosePicture', 'Choose a picture…')}
                    </button>
                    {own && <button
                        className='vp-button secondary'
                        onClick={() => { setCustomEmptyBoxFace(face, undefined).catch(() => undefined); }}
                    >
                        {nls.localize('vueport/library/useCatalogCover', 'Revert')}
                    </button>}
                </div>
                <input
                    ref={file}
                    type='file'
                    accept='image/*'
                    hidden
                    onChange={event => {
                        const picked = event.target.files?.[0];
                        event.target.value = '';
                        if (picked) {
                            setCustomEmptyBoxFace(face, picked).catch(() => undefined);
                        }
                    }}
                />
            </div>}
        </div>
    </div>;
}
