import { Hammer, PaintBrushBroad, Palette, Plug, Plus } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import EmptyContainer from '../components/kit/EmptyContainer';
import { DebugSource, EmulatorPanelType, Panel } from '../panels/emulator-panel';
import { emulatorPanelTitleIcon } from '../panels/emulator-panel-icons';
import { ColorEditor } from './emulator-color-editor';
import { ColorSheetTree } from './emulator-color-tree';
import { SheetEditor } from './emulator-color-sheet';
import { ModelSheet, isModelSheet } from './emulator-color-model-sheet';

// the panels of Color mode: the project (the package's sheets and every character), the sheet editor beside the
// screen, and building. Each is a view of the one ColorEditor, redrawn when it changes rather than polled
abstract class ColorPanel extends Panel {

    constructor(kind: EmulatorPanelType, source: DebugSource, instanceId: string, protected readonly editor: ColorEditor) {
        super(kind, source, instanceId);
        // not closable, as there would be no other way to reach its function and the dock couldn't restore it
        this.title.closable = false;
        this.addClass('vp-color-panel');
        this.toDispose.push(editor.onDidChange(() => this.update()));
    }

    // only a slow safety net, the editor fires change events
    protected pollHz(): number {
        return 1;
    }

    protected refresh(): void {
        this.update();
    }

    protected renderBlocked(): React.ReactNode | undefined {
        const editor = this.editor;
        switch (editor.block) {
            case 'noGame':
                return <EmptyContainer
                    title={nls.localize('vueport/general/notRunning', 'The emulator is not running.')}
                    icon={<Plug size={32} />}
                />;
            case 'noColorization': {
                const available = editor.colorizations;
                return <EmptyContainer
                    title={nls.localize('vueport/color/noColorization', 'No VB Color colorization is switched on')}
                    icon={<Palette size={32} />}
                    actions={available.map(colorization => ({
                        label: nls.localize('vueport/color/useColorization', 'Switch On {0}', colorization.name),
                        primary: true,
                        onClick: () => editor.useColorization(colorization.id),
                    }))}
                />;
            }
        }
        return undefined;
    }
}

// --- project tree ---

export class ColorProjectPanel extends ColorPanel {

    protected activeContext?: number;
    protected activeOverlay?: number; // pause, menu or dialog box over the screen, 0 or undefined for none
    protected reading = false;

    constructor(source: DebugSource, instanceId: string, editor: ColorEditor) {
        super(EmulatorPanelType.COLOR_PROJECT, source, instanceId, editor);
        this.title.label = nls.localize('vueport/color/panels/project/title', 'Project');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.COLOR_PROJECT);
    }

    // the game switches screens on its own, so the active one is polled once a second
    protected async refresh(): Promise<void> {
        if (this.reading) {
            return;
        }
        this.reading = true;
        try {
            const active = await this.editor.activeContext().catch(() => undefined);
            const overlay = await this.editor.activeOverlay().catch(() => undefined);
            if (active !== this.activeContext || overlay !== this.activeOverlay) {
                this.activeContext = active;
                this.activeOverlay = overlay;
                this.update();
            }
        } finally {
            this.reading = false;
        }
    }

    protected render(): React.ReactNode {
        const blocked = this.renderBlocked();
        if (blocked) {
            return blocked;
        }
        const editor = this.editor;
        switch (editor.packageStatus) {
            case 'loading':
                return <EmptyContainer
                    title={nls.localize('vueport/color/package/loading', 'Reading the VB Color package…')}
                    icon={<Palette size={32} />}
                />;
            case 'unavailable':
                return <EmptyContainer
                    title={nls.localize('vueport/color/package/unavailable', 'This colorization has no VB Color package')}
                    description={nls.localize('vueport/color/package/unavailableHint',
                        'Its colors can be looked at here, but not changed: the editor changes a colorization through its package.')}
                    icon={<Palette size={32} />}
                />;
            case 'failed':
                return <EmptyContainer
                    title={nls.localize('vueport/color/package/failed', 'The VB Color package could not be read')}
                    description={editor.packageError}
                    icon={<Palette size={32} />}
                />;
        }
        const index = editor.packageIndex;
        if (!index) {
            return undefined;
        }
        return <div className='vp-color-panel-body vp-color-project'>
            <ColorSheetTree editor={editor} activeContext={this.activeContext} activeOverlay={this.activeOverlay} />
        </div>;
    }
}

// --- build ---

export class ColorBuildPanel extends ColorPanel {

    constructor(source: DebugSource, instanceId: string, editor: ColorEditor) {
        super(EmulatorPanelType.COLOR_BUILD, source, instanceId, editor);
        this.title.label = nls.localize('vueport/color/panels/build/title', 'Build');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.COLOR_BUILD);
    }

    protected render(): React.ReactNode {
        const blocked = this.renderBlocked();
        if (blocked) {
            return blocked;
        }
        const editor = this.editor;
        if (editor.packageStatus !== 'ready') {
            return <EmptyContainer
                title={nls.localize('vueport/color/build/noPackage', 'Nothing to build')}
                description={nls.localize('vueport/color/build/noPackageHint', 'Building needs the colorization\'s VB Color package.')}
                icon={<Hammer size={32} />}
            />;
        }
        const build = editor.build;
        const stats = build?.stats ?? {};
        const fact = (name: string): string | undefined => stats[name] === undefined ? undefined : String(stats[name]);
        const facts: [string, string | undefined][] = editor.modelPackage ? [
            [nls.localize('vueport/color/build/edgesPainted', 'Edges painted'), `${fact('paintedEdges') ?? '0'} / ${fact('edges') ?? '?'}`],
            [nls.localize('vueport/color/build/palettesUsed', 'Palettes used by the paint'), fact('palettes_used') ?? '0'],
            [nls.localize('vueport/color/build/palettesFree', 'Palettes free'), fact('palettes_free')],
            [nls.localize('vueport/color/build/ramps4', 'Four-shade colors'), fact('ramps4')],
            [nls.localize('vueport/color/build/cellsPainted', 'Cells painted'), fact('paintedCells')],
            [nls.localize('vueport/color/build/palettesShort', 'Colors left out (no palette free)'), fact('palettes_short') ?? '0'],
        ] : [
            [nls.localize('vueport/color/build/fidelity', 'Colors as wanted (surveyed)'), fact('fidelity %, surveyed') && `${fact('fidelity %, surveyed')} %`],
            [nls.localize('vueport/color/build/groups', 'Palette groups'), fact('groups')],
            [nls.localize('vueport/color/build/palettesFree', 'Palettes free'), fact('palettes_free')],
            [nls.localize('vueport/color/build/painted', 'Painted load positions'), fact('painted load positions') ?? '0'],
            [nls.localize('vueport/color/build/short', 'Pixels short of a color'), fact('slot pixels short of a colour') ?? '0'],
        ];
        return <div className='vp-color-panel-body'>
            <div className='vp-color-actions'>
                <button type='button' className='vp-button' disabled={editor.building} onClick={() => editor.applyBuild()}>
                    {nls.localize('vueport/color/build/apply', 'Apply to the Game')}
                </button>
            </div>
            <div className='vp-color-actions'>
                <button type='button' className='vp-button secondary' disabled={editor.exchanging} onClick={() => editor.exportPackage()}>
                    {nls.localize('vueport/color/exchange/export', 'Export Package…')}
                </button>
                <button type='button' className='vp-button secondary' disabled={editor.exchanging} onClick={() => pickPackage(editor)}>
                    {nls.localize('vueport/color/exchange/import', 'Import Package…')}
                </button>
            </div>
            {editor.exchangeProgress && <div className='vp-color-progress' role='progressbar' aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={Math.round(editor.exchangeProgress.at * 100)} aria-valuetext={editor.exchangeProgress.step}>
                <div className='vp-color-progress-track'>
                    <div className='vp-color-progress-bar' style={{ width: `${Math.round(editor.exchangeProgress.at * 100)}%` }} />
                </div>
                <span className='vp-color-hint'>{editor.exchangeProgress.step}</span>
            </div>}
            {editor.pendingImport && <div className='vp-color-import'>
                <div className='vp-color-hint'>
                    {nls.localize('vueport/color/exchange/question', '"{0}" holds {1} painted characters and {2} own sheets.',
                        editor.pendingImport.name, editor.pendingImport.work.counts.keys, editor.pendingImport.work.counts.sheets)}
                    {' '}
                    {nls.localize('vueport/color/exchange/questionHint',
                        'Merge it into your work (where both paint a character, the package\'s paint wins), or replace your work with it?')}
                </div>
                <div className='vp-color-actions'>
                    <button type='button' className='vp-button' onClick={() => editor.resolveImport('merge')}>
                        {nls.localize('vueport/color/exchange/merge', 'Merge')}
                    </button>
                    <button type='button' className='vp-button secondary' onClick={() => editor.resolveImport('replace')}>
                        {nls.localize('vueport/color/exchange/replace', 'Replace')}
                    </button>
                    <button type='button' className='vp-button secondary' onClick={() => editor.resolveImport(undefined)}>
                        {nls.localize('vueport/color/exchange/cancel', 'Cancel')}
                    </button>
                </div>
            </div>}
            <div className='vp-color-hint'>
                {editor.building
                    ? nls.localize('vueport/color/build/building', 'Building…')
                    : editor.buildError
                        ? nls.localize('vueport/color/build/failed', 'The build failed: {0}', editor.buildError)
                        : !build
                            ? nls.localize('vueport/color/build/none', 'Not built yet. Apply builds the package with your paint and puts it into the running game.')
                            : editor.buildStale
                                ? nls.localize('vueport/color/build/stale', 'The paint changed since the last build.')
                                : editor.modelPackage
                                    ? nls.localize('vueport/color/build/currentModels', 'Built. The game draws its lines in the new colors from its next frame.')
                                    : nls.localize('vueport/color/build/current', 'Built. The game shows the new colors where it loads its characters again.')}
            </div>
            {build && <dl className='vp-color-build-facts'>
                {facts.filter(([, value]) => value !== undefined).map(([label, value]) => <React.Fragment key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                </React.Fragment>)}
            </dl>}
        </div>;
    }
}

function pickPackage(editor: ColorEditor): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vbcpkg,application/gzip,application/octet-stream';
    input.style.display = 'none';
    document.body.appendChild(input);
    const finish = (): void => input.remove();
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        finish();
        if (file) {
            editor.importPackage(file, file.name).catch(() => undefined);
        }
    });
    input.addEventListener('cancel', finish);
    input.click();
}

// --- sheet editor ---

export class ColorSheetPanel extends ColorPanel {

    constructor(source: DebugSource, instanceId: string, editor: ColorEditor) {
        super(EmulatorPanelType.COLOR_SHEET, source, instanceId, editor);
        this.title.label = nls.localize('vueport/color/panels/sheet/title', 'Sheet');
        this.title.icon = emulatorPanelTitleIcon(EmulatorPanelType.COLOR_SHEET);
        this.addClass('vp-color-sheet-panel');
    }

    protected render(): React.ReactNode {
        const blocked = this.renderBlocked();
        if (blocked) {
            return blocked;
        }
        const editor = this.editor;
        const entry = editor.packageStatus === 'ready' ? editor.sheetEntry(editor.sheetId) : undefined;
        if (!entry && editor.pickedNothing) {
            // a pick on a screen the package doesn't color (e.g. Zero Racers' option screen)
            return <EmptyContainer
                title={nls.localize('vueport/color/sheet/pickedNothing', 'The colorization\'s package knows nothing drawn there.')}
                description={nls.localize('vueport/color/sheet/pickedNothingHint',
                    'This screen is not part of the VB Color package, so it has no sheet and cannot be painted yet.')}
                icon={<PaintBrushBroad size={32} />}
            />;
        }
        if (editor.modelPackage && (!entry || isModelSheet(entry.sheet.id))) {
            return <ModelSheet editor={editor} entry={entry} />;
        }
        if (entry) {
            return <SheetEditor editor={editor} entry={entry} />;
        }
        const unplaced = editor.unplaced;
        if (unplaced) {
            return <EmptyContainer
                title={unplaced.kind === 'figures'
                    ? nls.localize('vueport/color/unplaced/figure', 'The picked figure is on no sheet.')
                    : nls.localize('vueport/color/unplaced/background', 'The picked background is on no sheet.')}
                icon={<PaintBrushBroad size={32} />}
                actions={[{
                    label: nls.localize('vueport/color/unplaced/create', 'Create Sheet'),
                    icon: <Plus size={14} />,
                    primary: true,
                    onClick: () => editor.addUnplaced(),
                }]}
            />;
        }
        return <EmptyContainer
            title={nls.localize('vueport/color/sheet/none', 'No sheet open')}
            description={editor.packageStatus === 'ready'
                ? nls.localize('vueport/color/sheet/noneHint2',
                    'Open a figure or background in the project tree, or pick one on the screen.')
                : nls.localize('vueport/color/build/noPackageHint', 'Building needs the colorization\'s VB Color package.')}
            icon={<PaintBrushBroad size={32} />}
        />;
    }
}

export function createColorPanel(kind: EmulatorPanelType, source: DebugSource, instanceId: string, editor: ColorEditor): Panel {
    switch (kind) {
        case EmulatorPanelType.COLOR_PROJECT: return new ColorProjectPanel(source, instanceId, editor);
        case EmulatorPanelType.COLOR_BUILD: return new ColorBuildPanel(source, instanceId, editor);
        case EmulatorPanelType.COLOR_SHEET: return new ColorSheetPanel(source, instanceId, editor);
        default: throw new Error(`Not a Color panel: ${kind}`);
    }
}
