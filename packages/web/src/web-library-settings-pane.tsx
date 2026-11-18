import * as React from 'react';
import { ArrowsClockwise, DownloadSimple, FolderPlus, FolderSimple, Trash, Warning } from '@phosphor-icons/react';
import Range from 'vueport-core/lib/browser/components/kit/Range';
import ResetButton from 'vueport-core/lib/browser/components/kit/ResetButton';
import Select from 'vueport-core/lib/browser/components/kit/Select';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { BoolSetting } from './web-bool-setting';
import { EmptyBoxSetting } from './web-empty-box-setting';
import { ApiBases } from './web-api-settings';
import { Library, LibraryFolderState } from './web-library';
import { WebUi } from './web-ui';
import { ImportError } from './web-library-import';
import { isStorageDurable } from './web-durable-storage';
import { LibraryOverview } from './web-library-stats';
import {
    lookUpDetails,
    onDidChangeLibrarySettings,
    readFoldersAtStart,
    scanArchives,
    scanSubfolders,
    setLookUpDetails,
    setReadFoldersAtStart,
    setScanArchives,
    setScanSubfolders,
} from './web-library-settings';
import { autoStartRecent, onDidChangeAutoStartRecent, setAutoStartRecent } from './web-auto-start';
import { continueVisible, onDidChangeContinueVisible, setContinueVisible } from './web-continue-visibility';
import {
    DEFAULT_MAX_RECENT,
    MAX_MAX_RECENT,
    MIN_MAX_RECENT,
    maxRecent,
    onDidChangeMaxRecent,
    setMaxRecent,
} from './web-recent-limit';
import {
    DEFAULT_START_PAGE,
    StartPage,
    onDidChangeStartPage,
    setStartPage,
    startPage,
} from './web-start-page';

// web only, the studio has no library
export default function WebLibrarySettings(props: { library: Library, ui: WebUi }): React.JSX.Element {
    const { library, ui } = props;
    const [, bump] = React.useReducer((n: number) => n + 1, 0);

    React.useEffect(() => {
        const settings = onDidChangeLibrarySettings(() => bump());
        const limit = onDidChangeMaxRecent(() => bump());
        const changed = library.onDidChange(() => bump());
        const visible = onDidChangeContinueVisible(() => bump());
        const start = onDidChangeStartPage(() => bump());
        const autoStart = onDidChangeAutoStartRecent(() => bump());
        return () => {
            settings.dispose();
            limit.dispose();
            changed.dispose();
            visible.dispose();
            start.dispose();
            autoStart.dispose();
        };
    }, [library]);

    const folders = library.folderStates();
    const progress = library.readProgress();

    // read once per opening rather than watched; it changes at most once, when ensureDurableStorage asks
    const [durable, setDurable] = React.useState<boolean | undefined>(undefined);
    React.useEffect(() => {
        let live = true;
        isStorageDurable().then(value => { if (live) { setDurable(value); } }).catch(() => undefined);
        return () => { live = false; };
    }, [folders.length]);

    // kept here rather than in the notification centre, as running out of storage on a copy only makes sense beside the
    // button that started it
    const [failure, setFailure] = React.useState<string | undefined>(undefined);

    const add = React.useCallback(async (kind: 'linked' | 'imported') => {
        setFailure(undefined);
        try {
            await library.addFolder(kind);
        } catch (error) {
            setFailure(error instanceof ImportError && error.outOfSpace
                ? nls.localize('vueport/library/import/noSpaceForFolder',
                    'There was not enough room to copy that folder. Nothing of it was kept. Try a \
smaller folder, or remove one you already have.')
                : nls.localize('vueport/library/import/failed',
                    'That folder could not be copied. Nothing of it was kept.'));
        }
    }, [library]);

    const reimport = React.useCallback(async (folderId: string) => {
        setFailure(undefined);
        try {
            await library.reimportFolder(folderId);
        } catch (error) {
            setFailure(error instanceof ImportError && error.outOfSpace
                ? nls.localize('vueport/library/import/noSpaceForFolder',
                    'There was not enough room to copy that folder. Nothing of it was kept. Try a \
smaller folder, or remove one you already have.')
                : nls.localize('vueport/library/import/failed',
                    'That folder could not be copied. Nothing of it was kept.'));
        }
    }, [library]);

    // the question differs: a linked folder leaves every file where it is, a copy (imported, or the Planet VB
    // downloads) is deleted
    const remove = React.useCallback(async (folder: LibraryFolderState) => {
        const agreed = await ui.confirm({
            title: nls.localize('vueport/library/removeFolder/title', 'Remove {0}?', folder.name),
            message: folder.origin === 'planetvb'
                ? nls.localize('vueport/library/removeFolder/downloadsMessage',
                    'The ROMs downloaded from Planet VB are deleted, and their games leave the library. \
Your edits, saves and save states are kept.')
                : folder.kind === 'imported'
                ? nls.localize('vueport/library/removeFolder/copyMessage',
                    'The copy of this folder kept by this browser is deleted, and its games leave the \
library. The original folder is not touched; your edits, saves and save states are kept.')
                : nls.localize('vueport/library/removeFolder/linkMessage',
                    'Its games leave the library. No file in the folder is touched, and your edits, saves \
and save states are kept.'),
            okLabel: nls.localize('vueport/library/remove', 'Remove'),
        });
        if (agreed) {
            await library.removeFolder(folder.id);
        }
    }, [library, ui]);

    return <div className='vp-appearance'>

        <LibraryOverview
            library={library}
            durable={durable}
            busy={progress !== undefined || folders.some(folder => folder.reading)}
            lookUp={lookUpDetails()}
        />

        <fieldset>
            <legend>
                {nls.localize('vueport/library/folders', 'Folders')}
            </legend>
            {folders.length === 0 && <p className='vp-hint'>
                {nls.localize('vueport/library/noFoldersYet',
                    'No folders yet. Everything happens on this machine — a folder VUEPort reads is read \
where it lies, and a folder it imports is copied no further than this browser.')}
            </p>}

            <ul className='vp-library-folders'>
                {folders.map(folder => <li key={folder.id}>
                    <div className='vp-library-folder-head'>
                        {folder.access === 'granted'
                            ? <FolderSimple size={18} />
                            : <Warning size={18} className='warn' />}
                        <span className='vp-library-file-name'>
                            <span>{folder.name}</span>
                            <span className='vp-hint'>{folderLine(folder)}</span>
                        </span>
                        {folder.access === 'prompt' || folder.access === 'denied'
                            ? <button
                                className='vp-button'
                                onClick={() => { library.grantAccess(folder.id).catch(() => undefined); }}
                            >{nls.localize('vueport/library/allowAgain', 'Allow again')}</button>
                            : folder.reading
                                ? <button
                                    className='vp-button secondary'
                                    onClick={() => library.cancelRead(folder.id)}
                                >{nls.localize('vueport/library/stop', 'Stop')}</button>
                                : folder.kind === 'imported' && folder.origin !== 'planetvb'
                                    // re-reading a copy finds what it held last time, so the folder is offered again
                                    // instead; except the Planet VB downloads, which grow from the catalog's pages
                                    ? <button
                                        className='vp-button secondary'
                                        onClick={() => { reimport(folder.id).catch(() => undefined); }}
                                    >
                                        <DownloadSimple size={15} />
                                        {nls.localize('vueport/library/import/again', 'Import again…')}
                                    </button>
                                    : <button
                                        className='vp-button secondary'
                                        disabled={folder.access !== 'granted'}
                                        onClick={() => { library.readFolder(folder.id).catch(() => undefined); }}
                                    >
                                        <ArrowsClockwise size={15} />
                                        {nls.localize('vueport/library/readAgain', 'Read again')}
                                    </button>}
                        <button
                            className='vp-button secondary'
                            title={nls.localize('vueport/library/removeFolder/button', 'Remove this folder')}
                            aria-label={nls.localize('vueport/library/removeFolder/button', 'Remove this folder')}
                            onClick={() => { remove(folder).catch(() => undefined); }}
                        ><Trash size={15} /></button>
                    </div>
                    {/* Chrome 122+ makes the grant permanent only via the option in its own dialog, so the hint names it */}
                    {(folder.access === 'prompt' || folder.access === 'denied') && <p className='vp-hint'>
                        {nls.localize('vueport/library/accessEnded',
                            'A browser gives out access to a folder for one visit at a time. What was read \
last time stays in the library; one click gets the files back — and choosing "Allow on every visit" \
in the dialog means not being asked again.')}
                    </p>}
                    {folder.access === 'missing' && <p className='vp-hint'>
                        {folder.origin === 'planetvb'
                            ? nls.localize('vueport/library/downloadsGone',
                                'The downloaded ROMs are gone — cleared site data, or a browser \
reclaiming storage. Import them again from Planet VB to play them.')
                            : folder.kind === 'imported'
                            ? nls.localize('vueport/library/copyGone',
                                'The copy of that folder is gone — cleared site data, or a browser \
reclaiming storage. Import it again to play from it.')
                            : nls.localize('vueport/library/handleGone',
                                'This browser no longer has a way back to that folder — cleared site data, \
or another profile. Add it again to read it.')}
                    </p>}
                    {progress?.folderId === folder.id && <p className='vp-hint'>
                        {progress.copying
                            ? nls.localize('vueport/library/copyingCount',
                                '{0} of {1} files copied', progress.files, progress.known ?? progress.files)
                            : nls.localize('vueport/library/readingCount',
                                '{0} files read, {1} ROMs so far', progress.files, progress.roms)}
                    </p>}
                </li>)}
            </ul>

            <div className='vp-library-folder-actions'>
                {library.canAddFolders() && <button
                    className='vp-button'
                    onClick={() => { add('linked').catch(() => undefined); }}
                >
                    <FolderPlus size={15} />
                    {nls.localize('vueport/library/addFolder', 'Add a folder…')}
                </button>}
                {library.canImportFolders() && <button
                    className={library.canAddFolders() ? 'vp-button secondary' : 'vp-button'}
                    onClick={() => { add('imported').catch(() => undefined); }}
                >
                    <DownloadSimple size={15} />
                    {nls.localize('vueport/library/import/folder', 'Import a folder…')}
                </button>}
            </div>

            {failure && <p className='vp-hint warn'>{failure}</p>}

            {/* only when the answer is no; the fix is the same as for the folder permissions */}
            {durable === false && folders.some(folder => folder.kind === 'imported')
                && <p className='vp-hint'>
                    {nls.localize('vueport/library/notDurable',
                        'This browser has not promised to keep what VUEPort stores, and may clear it when \
it needs space — an imported folder and your save states with it. Installing VUEPort as an app, or \
bookmarking it, is usually what changes its mind.')}
                </p>}

            {/* Firefox and Safari have no directory picker, so there import is the only way in */}
            {library.canAddFolders()
                ? <p className='vp-hint'>
                    {nls.localize('vueport/library/addOrImport',
                        'An added folder is read where it lies and stays in step with your disk. An imported \
folder is copied into this browser: it works with a disk that is not plugged in, but it is a \
photograph — ROMs added to the real folder later need importing again.')}
                </p>
                : <p className='vp-hint'>
                    {nls.localize('vueport/library/noPicker/importOnly',
                        'This browser cannot read folders in place. \
Importing copies the ROMs into browser storage instead.')}
                </p>}
        </fieldset>

        <fieldset>
            <legend>
                {nls.localize('vueport/library/readingLabel', 'Reading')}
            </legend>

            <BoolSetting
                label={nls.localize('vueport/library/scanRecursively', 'Scan Recursively')}
                hint={nls.localize(
                    'vueport/library/scanRecursivelyHint',
                    'Also look for ROMs in subfolders.'
                )}
                value={scanSubfolders()}
                fallback={true}
                onChange={setScanSubfolders}
            />
            <BoolSetting
                label={nls.localize('vueport/library/readArchives', 'Read ROMs inside .zip archives')}
                hint={nls.localize(
                    'vueport/library/readArchivesHint',
                    '.vbz or .vb.zip are read either way.'
                )}
                value={scanArchives()}
                fallback={true}
                onChange={setScanArchives}
            />
            <BoolSetting
                label={nls.localize('vueport/library/enrich', 'Enrich')}
                hint={nls.localize(
                    'vueport/library/enrichHint',
                    'Ping an API to enrich library entries with covers and additional metadata. Sends checksums only.'
                )}
                value={lookUpDetails()}
                fallback={true}
                onChange={setLookUpDetails}
            />
            <BoolSetting
                label={nls.localize('vueport/library/updateOnStart', 'Update on start')}
                hint={nls.localize(
                    'vueport/library/updateOnStartHint',
                    'Read folders and update the library when VUEPort starts.'
                )}
                value={readFoldersAtStart()}
                fallback={false}
                onChange={setReadFoldersAtStart}
            />
        </fieldset>

        <fieldset>
            <legend>
                {nls.localize('vueport/library/coversLabel', 'Covers')}
            </legend>
            <EmptyBoxSetting />
        </fieldset>

        <fieldset>
            <legend>
                {nls.localize('vueport/library/apis', 'APIs')}
            </legend>
            <ApiBases />
        </fieldset>

        <fieldset>
            <legend>
                {nls.localize('vueport/library/startup', 'Startup')}
            </legend>
            {/* Recently Played stays selectable while its shelf is off, so turning the shelf back on restores it */}
            <div className='vp-select-setting'>
                <div className='vp-bool-title'>
                    <span>{nls.localize('vueport/library/startPage/title', 'Start Page')}</span>
                    <ResetButton
                        disabled={startPage() === DEFAULT_START_PAGE}
                        onReset={() => setStartPage(DEFAULT_START_PAGE)}
                    />
                </div>
                <div className='vp-hint'>
                    {nls.localize(
                        'vueport/library/startPage/hint',
                        'Which shelf the library opens on.'
                    )}
                </div>
                <Select
                    value={startPage()}
                    onChange={value => setStartPage(value as StartPage)}
                    label={nls.localize('vueport/library/startPage/title', 'Start Page')}
                    options={[
                        {
                            group: nls.localize('vueport/library/library', 'Library'),
                            options: [
                                {
                                    value: 'recent',
                                    label: nls.localize(
                                        'vueport/library/recentlyPlayed', 'Recently Played'),
                                },
                                {
                                    value: 'all',
                                    label: nls.localize('vueport/library/allGames', 'All Games'),
                                },
                                {
                                    value: 'favorites',
                                    label: nls.localize('vueport/library/favorites', 'Favorites'),
                                },
                            ],
                        },
                        {
                            group: 'Planet Virtual Boy',
                            options: [
                                {
                                    value: 'featured',
                                    label: nls.localize(
                                        'vueport/library/featuredPicks', 'Featured Picks'),
                                },
                                {
                                    value: 'archive',
                                    label: nls.localize(
                                        'vueport/library/homebrewArchive', 'Homebrew Archive'),
                                },
                            ],
                        },
                    ]}
                />
            </div>
        </fieldset>

        <fieldset>
            <legend>
                {nls.localize('vueport/library/recentlyPlayed', 'Recently Played')}
            </legend>
            <BoolSetting
                label={nls.localize('vueport/library/showContinue', 'Show Recently Played')}
                hint={nls.localize('vueport/library/showContinueHint',
                    'Continue your recently played games from their dedicated shelf.')}
                value={continueVisible()}
                fallback={true}
                onChange={setContinueVisible}
            />
            {/* only while there is a shelf, as a game starting itself with no shelf to explain it is the worst case */}
            {continueVisible() && <BoolSetting
                label={nls.localize(
                    'vueport/library/autoStartRecent', 'Auto start last recent game')}
                hint={nls.localize('vueport/library/autoStartRecentHint',
                    'Open the game you played last as VUEPort starts, instead of the library.')}
                value={autoStartRecent()}
                fallback={false}
                onChange={setAutoStartRecent}
            />}
            {continueVisible() && <div className='vp-range-setting'>
                <div className='vp-bool-title'>
                    <span>{nls.localize('vueport/settings/recentLimit', 'Amount to remember')}</span>
                    <ResetButton
                        disabled={maxRecent() === DEFAULT_MAX_RECENT}
                        onReset={() => setMaxRecent(DEFAULT_MAX_RECENT)}
                    />
                </div>
                <div className='vp-hint'>
                    {nls.localize(
                        'vueport/settings/recentLimitHint',
                        'References to this many recently played ROMs are kept.'
                    )}
                </div>
                <Range
                    value={maxRecent()}
                    setValue={value => setMaxRecent(value)}
                    min={MIN_MAX_RECENT}
                    max={MAX_MAX_RECENT}
                    step={1}
                />
            </div>}
        </fieldset>

    </div>;
}

// the path is only known on the desktop, a browser is not told it
function folderLine(folder: LibraryFolderState): string {
    const count = nls.localize('vueport/library/gameCount', '{0} games', folder.count ?? 0);
    // only the copies are labelled; on every linked folder it would be noise
    const copied = folder.origin === 'planetvb'
        ? nls.localize('vueport/library/downloadedHere', 'downloaded from Planet VB')
        : folder.kind === 'imported'
            ? nls.localize('vueport/library/copiedHere', 'copied here')
            : undefined;
    const state = (): string | undefined => {
        switch (folder.access) {
            case 'prompt':
            case 'denied':
                return nls.localize('vueport/library/accessNeeded', 'Access needed');
            case 'missing':
                return folder.kind === 'imported'
                    ? nls.localize('vueport/library/copyLost', 'The copy is gone')
                    : nls.localize('vueport/library/accessLost', 'No longer known');
            default:
                return folder.reading
                    ? nls.localize('vueport/library/readingNow', 'reading…')
                    : undefined;
        }
    };
    return [folder.location, copied, folder.access === 'missing' ? undefined : count, state()]
        .filter(Boolean)
        .join(' · ');
}
