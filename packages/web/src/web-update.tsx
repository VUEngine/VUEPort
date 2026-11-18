import * as React from 'react';
import { ArrowClockwise, CheckCircle, DownloadSimple, Warning } from '@phosphor-icons/react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { BoolSetting } from './web-bool-setting';
import {
    UpdateState,
    canUpdate,
    checkForUpdate,
    installUpdate,
    installsUpdates,
    onDidChangeUpdateState,
    onDidLearnInstalls,
    updateState,
} from './desktop-update';
import {
    checkUpdatesAtStart,
    downloadUpdatesAutomatically,
    onDidChangeUpdateSettings,
    setCheckUpdatesAtStart,
    setDownloadUpdatesAutomatically,
} from './web-update-settings';

// desktop only, a browser is always served the current version (settingsTabSpecs leaves the tab out). One line saying
// one thing at a time rather than a progress log

function megabytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function useUpdateState(): UpdateState {
    const [state, setState] = React.useState<UpdateState>(updateState);
    React.useEffect(() => {
        const subscription = onDidChangeUpdateState(next => setState(next));
        // the state can have moved since the first render: a check started by the command, or the one at start
        // finishing
        setState(updateState());
        return () => subscription.dispose();
    }, []);
    return state;
}

export default function WebUpdates(): React.JSX.Element | undefined {
    const state = useUpdateState();
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        const settings = onDidChangeUpdateSettings(() => bump());
        const installs = onDidLearnInstalls(() => bump());
        return () => {
            settings.dispose();
            installs.dispose();
        };
    }, []);

    if (!canUpdate()) {
        return undefined;
    }

    const checkButton = (label: string): React.JSX.Element =>
        <button className='vp-button secondary' onClick={() => { checkForUpdate().catch(() => undefined); }}>
            <ArrowClockwise size={15} />
            {label}
        </button>;

    return <div className='vp-appearance'>
        <div className='vp-updates'>
            <div className='vp-hint'>
                {nls.localize('vueport/update/running',
                    'You are running VUEPort {0}', VUEPORT_VERSION)}
            </div>

            {state.kind === 'idle' && checkButton(
                nls.localize('vueport/update/check', 'Check for updates'))}

            {state.kind === 'checking' && <p className='vp-hint'>
                {nls.localize('vueport/update/checking', 'Looking for a newer version…')}
            </p>}

            {state.kind === 'current' && <>
                <p className='vp-updates-line'>
                    <CheckCircle size={15} weight='fill' />
                    {nls.localize('vueport/update/current', 'This is the newest version.')}
                </p>
                {checkButton(nls.localize('vueport/update/checkAgain', 'Check again'))}
            </>}

            {(state.kind === 'available' || state.kind === 'ready') && <>
                <p className='vp-updates-line'>
                    {state.kind === 'ready'
                        ? nls.localize(
                            'vueport/update/ready',
                            'VUEPort {0} is downloaded and ready to install',
                            state.release.version
                        )
                        : state.release.page
                            ? nls.localize(
                                'vueport/update/foundDownload',
                                'VUEPort {0} is available for download.',
                                state.release.version
                            )
                            : nls.localize(
                                'vueport/update/found',
                                'VUEPort {0} is available.',
                                state.release.version
                            )}
                </p>
                {state.release.notes && <p className='vp-updates-notes'>
                    {state.release.notes}
                </p>}
                <button className='vp-button' onClick={() => { installUpdate().catch(() => undefined); }}>
                    <DownloadSimple size={15} />
                    {state.release.page
                        ? nls.localize('vueport/update/download', 'Download')
                        : nls.localize('vueport/update/install', 'Install and restart')}
                </button>
            </>}

            {state.kind === 'downloading' && <>
                <p className='vp-updates-line'>
                    {state.progress?.total !== undefined
                        ? nls.localize('vueport/update/downloadingOf', 'Downloading {0} • {1} of {2}',
                            state.release.version,
                            megabytes(state.progress.downloaded), megabytes(state.progress.total))
                        : nls.localize('vueport/update/downloading', 'Downloading {0}…',
                            state.release.version)}
                </p>
                {/* a download of unknown size gets a bar filled to nothing rather than a made-up fraction */}
                <div className='vp-updates-bar'>
                    <div style={state.progress?.total
                        ? { width: `${Math.min(100, (state.progress.downloaded / state.progress.total) * 100)}%` }
                        : { width: 0 }} />
                </div>
            </>}

            {state.kind === 'installing' && <p className='vp-updates-line'>
                {nls.localize('vueport/update/installing',
                    'Installing {0}. VUEPort will save your game and start again.',
                    state.release.version)}
            </p>}

            {state.kind === 'failed' && <>
                <p className='vp-updates-line warn'>
                    <Warning size={15} />
                    {state.message}
                </p>
                {checkButton(nls.localize('vueport/update/tryAgain', 'Try again'))}
            </>}
        </div>

        <div className='vp-updates-settings'>
            <BoolSetting
                label={nls.localize(
                    'vueport/update/checkAtStart',
                    'Check for updates'
                )}
                hint={nls.localize(
                    'vueport/update/checkAtStartHint',
                    'Automatically check for updates when VUEPort starts'
                )}
                value={checkUpdatesAtStart()}
                fallback={true}
                onChange={setCheckUpdatesAtStart}
            />
            {installsUpdates() && <BoolSetting
                label={nls.localize(
                    'vueport/update/downloadAutomatically',
                    'Download updates automatically'
                )}
                hint={nls.localize(
                    'vueport/update/downloadAutomaticallyHint',
                    'Download (but not install) updates automatically when available.'
                )}
                value={downloadUpdatesAutomatically()}
                fallback={false}
                onChange={setDownloadUpdatesAutomatically}
            />}
        </div>
    </div>;
}
