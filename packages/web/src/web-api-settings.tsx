import * as React from 'react';
import ResetButton from 'vueport-core/lib/browser/components/kit/ResetButton';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import {
    DEFAULT_GAME_INFO_API,
    DEFAULT_HOMEBREW_API,
    isApiBase,
    onDidChangeGameInfoApiBase,
    onDidChangeHomebrewApiBase,
    setGameInfoApiBase,
    setHomebrewApiBase,
    storedGameInfoApiBase,
    storedHomebrewApiBase,
} from './web-api-bases';

// the catalog addresses (library look-ups and Homebrew Explorer listings), as a section of the Library pane
// under the switch that decides whether anything is asked. Not checked against the network, see `web-api-bases.ts`

// a missing scheme or trailing slash is completed on the way out, see `normalizeApiBase`
function ApiBaseField(props: {
    label: string,
    description: string,
    value: string, // what was actually set, so the box stays empty and the placeholder shows the default
    fallback: string,
    onCommit: (value: string) => void,
}): React.JSX.Element {
    const { label, description, value, fallback, onCommit } = props;

    // applied when the field is left, as committing per keystroke would point the catalog at every prefix and throw
    // away the caches each time
    const [draft, setDraft] = React.useState(value);
    React.useEffect(() => setDraft(value), [value]);

    const commit = (): void => onCommit(draft);
    const valid = isApiBase(draft);

    return <label className='vp-appearance-row'>
        <div className='vp-bool-title'>
            <span className='vp-appearance-label'>{label}</span>
            <ResetButton disabled={value === ''} onReset={() => onCommit('')} />
        </div>
        <span className='vp-bool-description'>{description}</span>
        <input
            className={`vp-input${valid ? '' : ' invalid'}`}
            type='url'
            spellCheck={false}
            autoComplete='off'
            placeholder={fallback}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={event => {
                if (event.key === 'Enter') {
                    commit();
                } else if (event.key === 'Escape') {
                    // back to what is in force, so a half-typed address can be abandoned
                    setDraft(value);
                }
            }}
        />
    </label>;
}

export function ApiBases(): React.JSX.Element {
    const [, bump] = React.useReducer((n: number) => n + 1, 0);

    // either can be reset from the button beside it, so what is shown tracks the modules
    React.useEffect(() => {
        const homebrew = onDidChangeHomebrewApiBase(() => bump());
        const gameInfo = onDidChangeGameInfoApiBase(() => bump());
        return () => {
            homebrew.dispose();
            gameInfo.dispose();
        };
    }, []);

    return <>
        <ApiBaseField
            label={nls.localize('vueport/apis/homebrew', 'Homebrew API')}
            description={nls.localize('vueport/apis/homebrewNote',
                'Where the Homebrew Explorer gets its data. Leave empty to use the default Planet VB API. \
Missing https:// or trailing slash are filled in for you.')}
            value={storedHomebrewApiBase()}
            fallback={DEFAULT_HOMEBREW_API}
            onCommit={setHomebrewApiBase}
        />
        <ApiBaseField
            label={nls.localize('vueport/apis/gameInfo', 'Game Info API')}
            description={nls.localize('vueport/apis/gameInfoNote',
                "Where additional covers and metadata are looked up by the respective ROM's CRC32 checksum. \
Changing this will cause cached data to be dropped.")}
            value={storedGameInfoApiBase()}
            fallback={DEFAULT_GAME_INFO_API}
            onCommit={setGameInfoApiBase}
        />
    </>;
}
