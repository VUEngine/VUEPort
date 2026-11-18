import {
    CaretDown, CaretRight, Check, Copy, Crosshair, Folder, FolderOpen, FolderPlus, ImageSquare, MinusSquare, Monitor, PlusSquare, X,
    PencilSimple, Power, Smiley, SquaresFour, Trash,
} from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { ColorEntityGroup } from '../../common/vb-color-package';
import { ColorEditor, ColorSheetEntry, GROUP_SHEET_PREFIX, parentFolder } from './emulator-color-editor';

// open-state key of the "Unmapped" folder, the NUL keeps it apart from real folder paths
const UNMAPPED = '\u0000all';

// a single click waits this long before acting, since a double click should only rename and not open anything
const DOUBLE_CLICK_MS = 300;

const DRAG_TYPE = 'application/x-vueport-color-tree';

// the project tree: folders of sheets (figures, backgrounds) to open in the sheet editor, both the package's (filed as
// the user likes) and the user's own from the screen, and last the package's characters no sheet shows, by group (a
// table it loads them from, a screen), each opened as a sheet of its own
export function ColorSheetTree(props: { editor: ColorEditor, activeContext?: number, activeOverlay?: number }): React.JSX.Element {
    const { editor, activeContext, activeOverlay } = props;
    const [copied, setCopied] = React.useState<string | undefined>(undefined);
    const copyButton = (kind: 'sheet' | 'folder', id: string): React.ReactNode => {
        const row = `${kind}:${id}`;
        return <button type='button' className='vp-color-tool-button' data-copy-id={row}
            title={nls.localize('vueport/color/tree/copyId', 'Copy ID (a short reference to this entry)')}
            onClick={event => {
                event.stopPropagation();
                void navigator.clipboard?.writeText(editor.treeReference(kind, id)).then(() => {
                    setCopied(row);
                    setTimeout(() => setCopied(now => now === row ? undefined : now), 1200);
                });
            }}>{copied === row ? <Check size={14} /> : <Copy size={14} />}</button>;
    };
    const entries = editor.sheetEntries();
    const folders = editor.sheetFolders();
    const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
    const [filter, setFilter] = React.useState('');
    const [renaming, setRenaming] = React.useState<string | undefined>(undefined);
    const [dropOn, setDropOn] = React.useState<string | undefined>(undefined);
    const groups = editor.packageIndex?.groups() ?? [];

    React.useEffect(() => {
        const folder = editor.sheetEntry(editor.sheetId)?.folder;
        if (folder) {
            setOpen(previous => {
                const next = new Set(previous);
                for (let at = folder; at; at = parentFolder(at)) {
                    next.add(at);
                }
                return next;
            });
        }
    }, [editor.sheetId]);

    const clickTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => () => clearTimeout(clickTimer.current), []);
    const rowClick = (action: () => void) => (event: React.MouseEvent): void => {
        clearTimeout(clickTimer.current);
        if (event.detail <= 1) {
            clickTimer.current = setTimeout(action, DOUBLE_CLICK_MS);
        }
    };
    const rowDoubleClick = (rename: () => void) => (event: React.MouseEvent): void => {
        event.stopPropagation();
        clearTimeout(clickTimer.current);
        rename();
    };
    const toggle = (path: string): void => setOpen(previous => {
        const next = new Set(previous);
        if (!next.delete(path)) {
            next.add(path);
        }
        return next;
    });
    const drop = (event: React.DragEvent, folder: string): void => {
        const what = event.dataTransfer.getData(DRAG_TYPE);
        setDropOn(undefined);
        if (!what) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (what.startsWith('sheet:')) {
            editor.moveSheet(what.slice(6), folder);
        } else if (what.startsWith('folder:')) {
            const path = what.slice(7);
            const name = path.slice(path.lastIndexOf('/') + 1);
            editor.moveFolder(path, folder ? `${folder}/${name}` : name);
        }
    };
    const dropTarget = (folder: string): React.HTMLAttributes<HTMLElement> => ({
        onDragOver: event => {
            if (event.dataTransfer.types.includes(DRAG_TYPE)) {
                event.preventDefault();
                event.stopPropagation();
                setDropOn(folder);
            }
        },
        onDragLeave: () => setDropOn(previous => previous === folder ? undefined : previous),
        onDrop: event => drop(event, folder),
    });
    const newFolder = (parent: string): void => {
        const base = nls.localize('vueport/color/tree/newFolder', 'New folder');
        let name = base;
        for (let n = 2; folders.includes(parent ? `${parent}/${name}` : name); n++) {
            name = `${base} ${n}`;
        }
        const path = parent ? `${parent}/${name}` : name;
        editor.createFolder(path);
        setOpen(previous => new Set([...previous, parent, path]));
        setRenaming(`folder:${path}`);
    };
    const nameInput = (value: string, done: (name: string | undefined) => void): React.ReactNode => <input
        className='vp-input vp-color-tree-name-input'
        autoFocus
        defaultValue={value}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                done(event.currentTarget.value);
            } else if (event.key === 'Escape') {
                done(undefined);
            }
        }}
        onBlur={event => done(event.currentTarget.value)}
    />;

    const sheetRow = (entry: ColorSheetEntry, depth: number, showFolder = false): React.ReactNode => {
        const id = entry.sheet.id;
        const editing = renaming === `sheet:${id}`;
        const Icon = entry.sheet.kind === 'screen' ? Monitor : entry.sheet.kind === 'layer' ? ImageSquare : Smiley;
        return <div
            key={`sheet:${id}`}
            className={`vp-color-tree-item${editor.sheetId === id ? ' selected' : ''}`}
            style={{ paddingLeft: depth * 14 + 4 }}
            data-sheet={id}
            draggable={!editing}
            onDragStart={event => event.dataTransfer.setData(DRAG_TYPE, `sheet:${id}`)}
            onClick={rowClick(() => editor.openSheet(id))}
            onDoubleClick={rowDoubleClick(() => setRenaming(`sheet:${id}`))}
        >
            <span className='vp-color-tree-caret' />
            <Icon size={14} />
            {editing
                ? nameInput(entry.name, name => {
                    setRenaming(undefined);
                    if (name !== undefined) {
                        editor.renameSheet(id, name);
                    }
                })
                : <span className='vp-color-tree-name' title={entry.own ? undefined : entry.sheet.name}>
                    {entry.name}{showFolder && entry.folder ? <span className='vp-color-tree-path'> · {entry.folder}</span> : null}
                </span>}
            {!editing && <span className='vp-color-tree-actions'>
                {copyButton('sheet', id)}
                <button type='button' className='vp-color-tool-button' title={nls.localize('vueport/color/tree/rename', 'Name it')}
                    onClick={event => {
                        event.stopPropagation();
                        setRenaming(`sheet:${id}`);
                    }}><PencilSimple size={14} /></button>
                {entry.own && <button type='button' className='vp-color-tool-button'
                    title={nls.localize('vueport/color/tree/deleteSheet', 'Delete this sheet of yours')}
                    onClick={event => {
                        event.stopPropagation();
                        editor.deleteSheet(id);
                    }}><Trash size={14} /></button>}
            </span>}
            {!editing && editor.sheetChanged(entry.sheet) && <button
                type='button'
                className='vp-color-tree-changed'
                data-changed={id}
                title={nls.localize('vueport/color/tree/changed', 'Changed: click to reset the sheet to the package\'s colors')}
                onClick={event => {
                    event.stopPropagation();
                    void editor.resetSheetPaint(entry.sheet, entry.name);
                }}
            />}
        </div>;
    };

    const folderNode = (path: string, depth: number): React.ReactNode => {
        const name = path.slice(path.lastIndexOf('/') + 1);
        const isOpen = open.has(path);
        const editing = renaming === `folder:${path}`;
        return <React.Fragment key={`folder:${path}`}>
            <div
                className={`vp-color-tree-item folder${dropOn === path ? ' drop' : ''}`}
                style={{ paddingLeft: depth * 14 + 4 }}
                data-folder={path}
                draggable={!editing}
                onDragStart={event => event.dataTransfer.setData(DRAG_TYPE, `folder:${path}`)}
                onClick={rowClick(() => toggle(path))}
                onDoubleClick={rowDoubleClick(() => setRenaming(`folder:${path}`))}
                {...dropTarget(path)}
            >
                <span className='vp-color-tree-caret'>{isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}</span>
                {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                {editing
                    ? nameInput(name, next => {
                        setRenaming(undefined);
                        const clean = next?.trim().replace(/\//g, '-');
                        if (clean && clean !== name) {
                            const parent = parentFolder(path);
                            editor.moveFolder(path, parent ? `${parent}/${clean}` : clean);
                        }
                    })
                    : <span className='vp-color-tree-name'>{name}</span>}
                {!editing && <span className='vp-color-tree-actions'>
                    {copyButton('folder', path)}
                    <button type='button' className='vp-color-tool-button' title={nls.localize('vueport/color/tree/newSubfolder', 'New subfolder')}
                        onClick={event => {
                            event.stopPropagation();
                            newFolder(path);
                        }}><FolderPlus size={14} /></button>
                    <button type='button' className='vp-color-tool-button' title={nls.localize('vueport/color/tree/rename', 'Rename')}
                        onClick={event => {
                            event.stopPropagation();
                            setRenaming(`folder:${path}`);
                        }}><PencilSimple size={14} /></button>
                    <button type='button' className='vp-color-tool-button'
                        title={nls.localize('vueport/color/tree/deleteFolder', 'Remove the folder: what is in it moves up')}
                        onClick={event => {
                            event.stopPropagation();
                            editor.deleteFolder(path);
                        }}><Trash size={14} /></button>
                </span>}
            </div>
            {isOpen && children(path, depth + 1)}
        </React.Fragment>;
    };

    // package order, no sorting: a folder appears where its first sheet is, the user's empty folders come last
    const children = (path: string, depth: number): React.ReactNode[] => {
        const nodes: React.ReactNode[] = [];
        const shown = new Set<string>();
        const showFolder = (folder: string): void => {
            if (!shown.has(folder)) {
                shown.add(folder);
                nodes.push(folderNode(folder, depth));
            }
        };
        const prefix = path ? `${path}/` : '';
        for (const entry of entries) {
            if (entry.folder === path) {
                nodes.push(sheetRow(entry, depth));
            } else if (entry.folder.startsWith(prefix) && entry.folder !== '') {
                showFolder(prefix + entry.folder.slice(prefix.length).split('/')[0]);
            }
        }
        folders.filter(folder => parentFolder(folder) === path).forEach(showFolder);
        return nodes;
    };

    const groupRow = (group: ColorEntityGroup, depth: number): React.ReactNode => {
        const id = GROUP_SHEET_PREFIX + group.id;
        const editing = renaming === id;
        const name = editor.groupName(group);
        return <div
            key={id}
            className={`vp-color-tree-item${editor.sheetId === id ? ' selected' : ''}`}
            style={{ paddingLeft: depth * 14 + 4 }}
            data-sheet={id}
            onClick={rowClick(() => editor.openSheet(id))}
            onDoubleClick={rowDoubleClick(() => setRenaming(id))}
        >
            <span className='vp-color-tree-caret' />
            <SquaresFour size={14} />
            {editing
                ? nameInput(name, next => {
                    setRenaming(undefined);
                    if (next !== undefined) {
                        editor.renameGroup(group, next);
                    }
                })
                : <span className='vp-color-tree-name' title={name !== group.name ? group.name : undefined}>
                    {group.kind === 'context' ? nls.localize('vueport/color/tree/screen', 'Screen {0}', name)
                        : group.kind === 'overlay' ? nls.localize('vueport/color/tree/overlay', 'Overlay: {0}', name) : name}
                </span>}
            {((group.context !== undefined && group.context === activeContext)
                || (group.overlay !== undefined && group.overlay === activeOverlay))
                && <span className='vp-color-tree-badge active'>{nls.localize('vueport/color/tree/onScreen', 'now')}</span>}
            {!editing && <span className='vp-color-tree-actions'>
                <button type='button' className='vp-color-tool-button' title={nls.localize('vueport/color/tree/rename', 'Name it')}
                    onClick={event => {
                        event.stopPropagation();
                        setRenaming(id);
                    }}><PencilSimple size={14} /></button>
            </span>}
        </div>;
    };

    const wanted = filter.trim().toLowerCase();
    const allOpen = open.has(UNMAPPED);
    // hasUnsheeted builds every group's sheet, so it only runs while the folder is open or a search is active
    const shownGroups = !(allOpen || wanted) ? groups : groups.filter(group => (!wanted
        || editor.groupName(group).toLowerCase().includes(wanted) || group.name.toLowerCase().includes(wanted))
        && editor.hasUnsheeted(group.id));
    return <div className='vp-color-tree' data-own-keys>
        <div className='vp-color-tree-tools'>
            <span className='vp-color-tree-search'>
                <input
                    className='vp-input'
                    type='search'
                    value={filter}
                    placeholder={nls.localize('vueport/color/tree/filterSheets', 'Find a sheet')}
                    onChange={event => setFilter(event.currentTarget.value)}
                    onKeyDown={event => event.key === 'Escape' && setFilter('')}
                />
                {filter && <button type='button' className='vp-color-tree-search-clear' data-clear-search
                    title={nls.localize('vueport/color/tree/clearSearch', 'Clear')}
                    onClick={() => setFilter('')}><X size={12} /></button>}
            </span>
            <button type='button' className='vp-color-tool-button' title={nls.localize('vueport/color/tree/newFolder', 'New folder')}
                onClick={() => newFolder('')}><FolderPlus size={16} /></button>
            <button type='button' className='vp-color-tool-button' data-expand-all
                title={nls.localize('vueport/color/tree/expandFolders', 'Expand Folders')}
                onClick={() => setOpen(new Set([...folders, UNMAPPED]))}><PlusSquare size={16} /></button>
            <button type='button' className='vp-color-tool-button' data-collapse-all
                title={nls.localize('vueport/color/tree/collapseFolders', 'Collapse Folders')}
                onClick={() => setOpen(new Set())}><MinusSquare size={16} /></button>
            {activeContext !== undefined && groups.some(group => group.context === activeContext
                || (!!activeOverlay && group.overlay === activeOverlay)) && <button
                type='button'
                className='vp-color-tool-button'
                title={nls.localize('vueport/color/tree/current', 'Open the screen the game shows now')}
                onClick={() => editor.openActiveScreen(activeContext, activeOverlay)}
            ><Crosshair size={16} /></button>}
        </div>
        <div className={`vp-color-tree-list${dropOn === '' ? ' drop' : ''}`} {...dropTarget('')}>
            {wanted
                ? entries.filter(entry => entry.name.toLowerCase().includes(wanted) || entry.folder.toLowerCase().includes(wanted))
                    .map(entry => sheetRow(entry, 0, true))
                : children('', 0)}
            {!entries.length && !wanted && <div className='vp-color-hint'>
                {nls.localize('vueport/color/tree/noSheetsYet', 'No sheets yet. Pick a figure on the screen to make one.')}
            </div>}
            {groups.length > 0 && (!wanted || shownGroups.length > 0) && <>
                <div className='vp-color-tree-item folder' style={{ paddingLeft: 4 }} onClick={() => toggle(UNMAPPED)} data-unmapped>
                    <span className='vp-color-tree-caret'>{allOpen || wanted ? <CaretDown size={12} /> : <CaretRight size={12} />}</span>
                    {allOpen || wanted ? <FolderOpen size={14} /> : <Folder size={14} />}
                    <span className='vp-color-tree-name'>{nls.localize('vueport/color/tree/unmapped', 'Unmapped')}</span>
                </div>
                {(allOpen || wanted) && shownGroups.map(group => groupRow(group, 1))}
            </>}
        </div>
        <ChangesFooter editor={editor} />
    </div>;
}

function ChangesFooter(props: { editor: ColorEditor }): React.JSX.Element {
    const { editor } = props;
    const { characters, sheets, backdrops, edges } = editor.changes();
    const none = characters === 0 && backdrops === 0 && edges === 0;
    const parts = [
        nls.localize('vueport/color/changes/sheets', 'Sheets: {0}', sheets),
        ...edges ? [nls.localize('vueport/color/changes/edges', 'Edges: {0}', edges)] : [nls.localize('vueport/color/changes/characters', 'Characters: {0}', characters)],
        ...backdrops ? [nls.localize('vueport/color/changes/backdrops', 'Backdrops: {0}', backdrops)] : [],
    ];
    return <div className='vp-color-tree-footer' data-changes>
        {none
            ? <span className='vp-color-tree-footer-text'>{nls.localize('vueport/color/changes/none', 'No changes')}</span>
            : <button
                type='button'
                className='vp-color-tree-footer-button'
                title={nls.localize('vueport/color/changes/resetHint', 'Click to reset all changes to the package\'s colors')}
                onClick={() => void editor.resetAllPaint()}
            >
                <span className='vp-color-tree-changed-dot' />
                <span>{parts.join(' · ')}</span>
            </button>}
        {editor.colorizationOn && <button
            type='button'
            className='vp-color-sheet-reset vp-color-tree-footer-off'
            title={nls.localize('vueport/color/switchOff/hint', 'Run this game without colors')}
            onClick={() => void editor.switchOffColorization()}
        ><Power size={14} /><span>{nls.localize('vueport/color/switchOff/label', 'Disable VB Color')}</span></button>}
    </div>;
}
