import { ArrowUUpLeft, CaretLeft, CaretRight, MagnifyingGlass, SlidersHorizontal, X } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { VueportConfig, VueportSettings } from '../../common/emulator-settings';
import { modifiedSettings, resetSettings } from '../emulator-settings-reset';
import { vueportSettingsSchema } from '../emulator-settings-schema';
import { useCompactLayout } from '../compact-layout';
import { pushBackHandler } from '../back-navigation';
import { Window } from './kit/Window';

// one tab as its host describes it; the window itself knows nothing about which settings exist, so the two hosts can
// carry different tabs
export interface SettingsTabSpec<T extends string = string> {
    id: T;
    // localized, and what the rail is sorted by
    label: string;
    icon: React.ReactNode;
    // the schema-backed settings this pane shows, so their titles and descriptions feed the search index. Exactly
    // what the pane shows and filters, so a query that lights this tab always leaves it with something
    settings?: readonly (keyof VueportConfig)[];
    // settings the pane changes with controls of its own (the palette pickers) that the search index has no use for,
    // but that Reset All must still cover
    alsoResets?: readonly (keyof VueportConfig)[];
    // extra words this pane answers to; for a hand-written pane, which does not filter its own rows, the only route
    // for a query besides its label
    keywords?: string;
    // sits alone at the foot of the rail, like an application's About
    foot?: boolean;
}

// the parts of the settings window, for a host that frames it itself
export interface SettingsWindowParts {
    title: string;
    icon: React.ReactNode;
    search: React.ReactNode;
    // undefined when the host gave no settings; renders nothing while every setting holds its default
    resetAll?: React.ReactNode;
    rail: React.ReactNode;
    pane: React.ReactNode;
}

// lower-cased. Rebuilt per call, as the schema is localized
function haystackFor(tab: SettingsTabSpec): string {
    const schema = vueportSettingsSchema();
    const parts = [tab.label, tab.keywords ?? ''];
    for (const id of tab.settings ?? []) {
        const entry = schema[id];
        if (entry) {
            parts.push(entry.title, entry.description ?? '', (entry.enumItemLabels ?? []).join(' '));
        }
    }
    return parts.join(' ').toLowerCase();
}

// the tabs a query touches, every tab when the query is empty. The panes filter their own settings with the same
// query; this keyword index only lets the rail fade the others and jump to one that matches
function tabsMatching<T extends string>(tabs: SettingsTabSpec<T>[], query: string): Set<T> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
        return new Set(tabs.map(tab => tab.id));
    }
    return new Set(tabs
        .filter(tab => terms.every(term => haystackFor(tab).includes(term)))
        .map(tab => tab.id));
}

// hidden while everything holds its default; asks first through the host's own confirmation
function ResetAllButton(props: {
    settings: VueportSettings,
    keys: readonly (keyof VueportConfig)[],
    confirm: () => Promise<boolean>,
}): React.JSX.Element | null {
    const { settings, keys, confirm } = props;
    const count = () => modifiedSettings(settings, keys).length;
    const [modified, setModified] = React.useState(count);
    React.useEffect(() => {
        const refresh = (): void => setModified(count());
        refresh();
        const subscription = settings.onDidChange(refresh);
        return () => subscription.dispose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings, keys]);
    if (modified === 0) {
        return null;
    }
    const label = nls.localize('vueport/settings/resetAll/label', 'Reset All');
    return <button
        type='button'
        className='vp-settings-reset-all'
        title={nls.localize('vueport/settings/resetAll/hint', 'Reset all settings to their defaults')}
        onClick={() => {
            confirm().then(agreed => agreed ? resetSettings(settings, keys) : undefined).catch(() => undefined);
        }}
    >
        <ArrowUUpLeft size={15} />
        <span>{label}</span>
    </button>;
}

function SettingsTab<T extends string>(props: {
    tab: SettingsTabSpec<T>,
    active: boolean,
    // a search is running and this pane has nothing that matches
    dimmed: boolean,
    onClick: () => void,
    // a row of the phone's list, which leads into the pane: a chevron says so
    compact?: boolean,
}): React.JSX.Element {
    return <button
        type='button'
        role='tab'
        aria-selected={props.active}
        className={'vp-settings-tab'
            + (props.active ? ' active' : '')
            + (props.dimmed ? ' is-dimmed' : '')}
        onClick={props.onClick}
    >
        {props.tab.icon}
        <span>{props.tab.label}</span>
        {props.compact && <CaretRight className='vp-settings-tab-chevron' size={16} />}
    </button>;
}

function SettingsSearch(props: {
    value: string,
    onChange: (value: string) => void,
}): React.JSX.Element {
    const label = nls.localize('vueport/settings/search', 'Search settings');
    return <div className='vp-settings-search'>
        <MagnifyingGlass size={15} />
        <input
            type='text'
            spellCheck={false}
            value={props.value}
            placeholder={label}
            aria-label={label}
            onChange={event => props.onChange(event.target.value)}
        />
        {props.value &&
            <button
                type='button'
                className='vp-settings-search-clear'
                aria-label={nls.localize('vueport/general/clear', 'Clear')}
                onClick={() => props.onChange('')}
            >
                <X size={14} />
            </button>}
    </div>;
}

// a tab rail down the left and one pane at a time beside it. Hidden panes are not rendered, as the input mapper
// captures keys while it is mounted
export function SettingsWindow<T extends string>(props: {
    // the rail's order is computed, not this one
    tabs: SettingsTabSpec<T>[],
    tab: T,
    onTab: (tab: T) => void,
    onClose: () => void,
    renderPane: (tab: T, search: string) => React.ReactNode,
    // for a host whose panes arrive as separately loaded chunks: the window, search and rail stay mounted while one
    // loads, and an error shows in the pane rather than in place of the whole window
    paneBoundary?: (tab: T, pane: React.ReactNode) => React.ReactNode,
    // a frame of the host's own instead of the kit's Window (the studio's PopUpDialog). The frame then owns closing,
    // Escape included, and onClose goes unused
    frame?: (parts: SettingsWindowParts) => React.ReactNode,
    // gives the header a Reset All button over the settings the tabs list. `confirm` is the host's own yes/no
    resetAll?: { settings: VueportSettings, confirm: () => Promise<boolean> },
    // false while it stays up regardless (in a headset): no close button
    closable?: boolean,
    // on a phone, whether the window opens on the list of panes (the title bar's button) rather than on `tab` (a
    // link to one pane, such as the library's Manage). Defaults to the list
    startOnList?: boolean,
    // on a phone, the window is closing and slides out; it takes no more input meanwhile
    leaving?: boolean,
}): React.JSX.Element {
    const { tabs, tab, onTab, onClose, renderPane, paneBoundary, frame, resetAll, closable } = props;
    // on a phone the rail and the pane do not fit side by side, so the rail is a page of its own, a list leading
    // into each pane, and the pane has a way back to it (see compact-layout.ts)
    const compact = useCompactLayout() !== undefined && !frame;
    const [listing, setListing] = React.useState(props.startOnList ?? true);
    // Back from a pane leads to the list, as the arrow in its header does; registered after the window's own, so it is
    // the one Back runs first
    React.useEffect(() => {
        if (!compact || listing) {
            return undefined;
        }
        return pushBackHandler(() => setListing(true));
    }, [compact, listing]);
    const resettable = React.useMemo(
        () => [...new Set(tabs.flatMap(entry => [...entry.settings ?? [], ...entry.alsoResets ?? []]))], [tabs]);
    const [search, setSearch] = React.useState('');
    const query = search.trim();
    const matching = tabsMatching(tabs, query);

    // alphabetically by label, as the identifiers would file Achievements under `retroachievements` and a fixed
    // order would be alphabetical in English alone
    const inOrder = tabs.filter(entry => !entry.foot)
        .sort((a, b) => a.label.localeCompare(b.label));
    const atFoot = tabs.filter(entry => entry.foot);

    // a search that leaves the open pane empty jumps to the first pane with a match, but only when the query changes,
    // as a faded tab the user clicks is one they asked for. onTab is read through a ref: callers pass a fresh arrow
    // every render, so depending on it would loop
    const changeTab = React.useRef(onTab);
    changeTab.current = onTab;
    const firstMatch = [...inOrder, ...atFoot].find(entry => matching.has(entry.id))?.id;
    const missed = query !== '' && !matching.has(tab);
    const searched = React.useRef(query);
    React.useEffect(() => {
        if (searched.current === query) {
            return;
        }
        searched.current = query;
        if (missed && firstMatch !== undefined) {
            changeTab.current(firstMatch);
        }
    }, [query, missed, firstMatch]);

    const railTab = (entry: SettingsTabSpec<T>): React.JSX.Element =>
        <SettingsTab
            key={entry.id}
            tab={entry}
            active={!compact && entry.id === tab}
            dimmed={query !== '' && (compact || entry.id !== tab) && !matching.has(entry.id)}
            onClick={() => {
                onTab(entry.id);
                setListing(false);
            }}
            compact={compact}
        />;

    const pane = renderPane(tab, query);
    const parts: SettingsWindowParts = {
        title: nls.localize('vueport/settings/title', 'Settings'),
        icon: <SlidersHorizontal size={22} />,
        search: <SettingsSearch value={search} onChange={setSearch} />,
        resetAll: resetAll &&
            <ResetAllButton settings={resetAll.settings} keys={resettable} confirm={resetAll.confirm} />,
        rail: <div className='vp-settings-tabs' role='tablist' aria-orientation='vertical'>
            {inOrder.map(railTab)}
            {atFoot.length > 0 &&
                <div className='vp-settings-tabs-foot'>{atFoot.map(railTab)}</div>}
        </div>,
        pane: paneBoundary ? paneBoundary(tab, pane) : pane,
    };

    if (frame) {
        return <>{frame(parts)}</>;
    }

    if (compact) {
        const current = tabs.find(entry => entry.id === tab);
        return listing
            ? <Window
                title={parts.title}
                icon={parts.icon}
                onClose={onClose}
                large
                closable={closable}
                className={'vp-settings-window vp-settings-compact vp-settings-listing'
                    + (props.leaving ? ' vp-window-leaving' : '')}
            >
                {parts.search}
                {parts.rail}
            </Window>
            : <Window
                title={current?.label ?? parts.title}
                icon={<button
                    type='button'
                    className='vp-settings-back'
                    aria-label={nls.localize('vueport/settings/back', 'Back to Settings')}
                    onClick={() => setListing(true)}
                >
                    <CaretLeft size={20} />
                </button>}
                onClose={onClose}
                large
                closable={closable}
                className={'vp-settings-window vp-settings-compact' + (props.leaving ? ' vp-window-leaving' : '')}
            >
                {parts.pane}
            </Window>;
    }

    return <Window
        title={parts.title}
        icon={parts.icon}
        onClose={onClose}
        large
        closable={closable}
        className='vp-settings-window'
        headerActions={<>{parts.resetAll}{parts.search}</>}
        sidebar={parts.rail}
    >
        {parts.pane}
    </Window>;
}
