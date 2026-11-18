import * as React from 'react';
import { IconProps, X } from '@phosphor-icons/react';
import { nls } from 'vueport-core/lib/common/emulator-nls';
import { pushEscapeLayer } from 'vueport-core/lib/browser/components/kit/escape-layers';
import { playAchievementCue, playErrorCue } from './web-ui-sound';

export type ToastKind = 'info' | 'warn' | 'error' | 'achievement';

const TOAST_MS = 6000;
const TOAST_ERROR_MS = 12000;
const TOAST_ACHIEVEMENT_MS = 8000; // the player's eyes are on the game, and there is a badge and a condition to take in

interface Toast {
    id: number;
    kind: ToastKind;
    text: string;
    iconUrl?: string; // only achievement toasts
    subtitle?: string; // only achievement toasts
    meta?: string; // e.g. an achievement's point value
    onClick?: () => void; // also dismisses it
    duration: number; // ms, kept so hovering can restart the clock (see WebUi.pauseToast)
}

interface ConfirmRequest {
    id: number;
    title: string;
    message: string[];
    okLabel?: string;
    resolve(agreed: boolean): void;
}

export interface PromptOptions {
    title: string;
    message?: string | string[]; // a paragraph per line
    placeholder?: string;
    value?: string;
    okLabel?: string; // "OK" when not given
    type?: 'text' | 'url'; // url gets the keyboard and autofill a browser reserves for addresses
}

interface PromptRequest extends PromptOptions {
    id: number;
    resolve(value: string | undefined): void;
}

interface ProgressItem {
    id: number;
    text: string;
    cancel(): void;
    setText(text: string): void;
}

export interface PickItem {
    id: string;
    label: string;
    description?: string;
    separator?: boolean; // a heading, not selectable
    // grayed and skipped by the keyboard, so a palette can say something exists rather than leaving it out
    disabled?: boolean;
    icon?: React.ComponentType<IconProps>;
    // small buttons for something done to the entry rather than by choosing it (deleting a slot's save vs. switching to
    // it)
    buttons?: PickItemButton[];
}

export interface PickItemButton {
    icon: React.ComponentType<IconProps>;
    label: string; // tooltip and screen reader name
    // runs once the list has closed, as a button usually asks a question of its own ("are you sure?") the list must not
    // sit over
    run(): void;
}

interface PickRequest {
    id: number;
    title?: string; // none for a list whose filter says it all ("Type the name of a ROM…")
    placeholder: string;
    items: PickItem[];
    emptyMessage: string;
    resolve(picked: PickItem | undefined): void;
    // steering from outside the keyboard (a pad's d-pad and A), set by the dialog once showing, as the highlighted
    // entry is its state; see WebUi.steerPick
    steer?: { move(by: number): void, accept(): void };
}

// the two actions apply at once and leave the prompt open, like the studio's capture dialog, as clearing a mapping
// usually makes room for the key about to be pressed
export interface CaptureOptions {
    title: React.ReactNode;
    currentMappings(): string; // re-read after either action
    note?: string;
    // optional: a one-off rebind offers them, the "set every button" run does not
    clearAll?(): void;
    resetToDefault?(): void;
}

interface CaptureRequest extends CaptureOptions {
    id: number;
    resolve(code: string | undefined): void;
}

interface UiState {
    toasts: Toast[];
    confirms: ConfirmRequest[];
    prompts: PromptRequest[];
    progresses: ProgressItem[];
    captures: CaptureRequest[];
    picks: PickRequest[];
}

const EMPTY: UiState = {
    toasts: [], confirms: [], prompts: [], progresses: [], captures: [], picks: [],
};

export interface WebUiHeadset {
    toast(text: string, error: boolean): void;
    // undefined when none is running
    wait(text: string | undefined): void;
    ask(title: string, message: string[], yes: string, no: string): Promise<boolean>;
    showsPage?: boolean; // shows the page's own windows, so a question is asked on the page
}

// imperative rather than React state, as the callers are not components (VueportNotifications goes to the dock and
// panels, key capture comes from event handlers); the overlay subscribes to its store
export class WebUi {

    protected state: UiState = EMPTY;
    protected readonly listeners = new Set<() => void>();
    protected nextId = 1;
    // read fresh every time, so a setting flipped mid-session applies to the next toast; true until a host calls
    // setSoundEnabled, so a caller without settings (a test, an embedding) still gets the cues
    protected soundEnabled = { error: () => true, achievement: () => true };
    protected readonly toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    readonly getState = (): UiState => this.state;

    protected update(change: Partial<UiState>): void {
        this.state = { ...this.state, ...change };
        this.listeners.forEach(listener => listener());
    }

    // see main.tsx
    setSoundEnabled(checkers: { error(): boolean, achievement(): boolean }): void {
        this.soundEnabled = checkers;
    }

    protected headset: WebUiHeadset | undefined;

    // news goes to both, as the page keeps it for when the headset comes off; a question only where it can be answered
    setHeadset(headset: WebUiHeadset | undefined): void {
        this.headset = headset;
        this.tellHeadsetWaiting();
    }

    // a download started by the click that took the player into the headset would otherwise run behind an empty screen
    protected tellHeadsetWaiting(): void {
        const progresses = this.state.progresses;
        this.headset?.wait(progresses[progresses.length - 1]?.text);
    }

    // onOpen runs when the toast is clicked, which also dismisses it
    toast(kind: ToastKind, text: string, onOpen?: () => void): void {
        this.headset?.toast(text, kind === 'error');
        const id = this.nextId++;
        // they still go on their own, so an ignored message does not sit there for the session
        const duration = kind === 'error' ? TOAST_ERROR_MS : TOAST_MS;
        this.update({
            toasts: [...this.state.toasts, {
                id, kind, text, duration,
                onClick: onOpen && (() => { this.dismissToast(id); onOpen(); }),
            }],
        });
        if (kind === 'error' && this.soundEnabled.error()) {
            playErrorCue();
        }
        this.scheduleDismiss(id, duration);
    }

    // onOpen runs when clicked (the emulator points it at the achievements panel)
    achievement(title: string, condition: string, points: number, iconUrl: string, onOpen?: () => void): void {
        const id = this.nextId++;
        const meta = nls.localize('vueport/achievements/pointsToast', '+{0} points', String(points));
        this.headset?.toast(`${title} · ${meta}`, false);
        this.update({
            toasts: [...this.state.toasts, {
                id, kind: 'achievement', text: title, subtitle: condition, meta, iconUrl,
                duration: TOAST_ACHIEVEMENT_MS,
                onClick: onOpen && (() => { this.dismissToast(id); onOpen(); }),
            }],
        });
        if (this.soundEnabled.achievement()) {
            playAchievementCue();
        }
        this.scheduleDismiss(id, TOAST_ACHIEVEMENT_MS);
    }

    protected scheduleDismiss(id: number, ms: number): void {
        clearTimeout(this.toastTimers.get(id));
        this.toastTimers.set(id, setTimeout(() => this.dismissToast(id), ms));
    }

    // restarted from the top when the pointer leaves, as what matters is how long the reader has had it
    pauseToast(id: number): void {
        clearTimeout(this.toastTimers.get(id));
        this.toastTimers.delete(id);
    }

    resumeToast(id: number): void {
        const toast = this.state.toasts.find(t => t.id === id);
        if (toast) {
            this.scheduleDismiss(id, toast.duration);
        }
    }

    dismissToast(id: number): void {
        clearTimeout(this.toastTimers.get(id));
        this.toastTimers.delete(id);
        this.update({ toasts: this.state.toasts.filter(t => t.id !== id) });
    }

    confirm(options: { title: string, message: string | string[], okLabel?: string }): Promise<boolean> {
        const message = Array.isArray(options.message) ? options.message : [options.message];
        // in a headset too, when it shows the page's own questions (emulator-xr-ui.ts)
        if (this.headset && !this.headset.showsPage) {
            return this.headset.ask(options.title, message,
                options.okLabel ?? nls.localize('vueport/general/ok', 'OK'),
                nls.localize('vueport/state/cancel', 'Cancel'));
        }
        return new Promise<boolean>(resolve => {
            const id = this.nextId++;
            const request: ConfirmRequest = {
                id,
                title: options.title,
                message,
                okLabel: options.okLabel,
                resolve: agreed => {
                    this.update({ confirms: this.state.confirms.filter(c => c.id !== id) });
                    resolve(agreed);
                },
            };
            this.update({ confirms: [...this.state.confirms, request] });
        });
    }

    // undefined on backing out, which differs from an empty answer
    prompt(options: PromptOptions): Promise<string | undefined> {
        return new Promise<string | undefined>(resolve => {
            const id = this.nextId++;
            const request: PromptRequest = {
                ...options,
                id,
                resolve: value => {
                    this.update({ prompts: this.state.prompts.filter(p => p.id !== id) });
                    resolve(value);
                },
            };
            this.update({ prompts: [...this.state.prompts, request] });
        });
    }

    progress(text: string): ProgressItem {
        const id = this.nextId++;
        const item: ProgressItem = {
            id,
            text,
            cancel: () => {
                this.update({ progresses: this.state.progresses.filter(p => p.id !== id) });
                this.tellHeadsetWaiting();
            },
            setText: next => {
                // a new object, so the overlay sees the change
                this.update({ progresses: this.state.progresses.map(p => p.id === id ? { ...p, text: next } : p) });
                this.tellHeadsetWaiting();
            },
        };
        this.update({ progresses: [...this.state.progresses, item] });
        this.tellHeadsetWaiting();
        return item;
    }

    // the prompt owns every keystroke
    get isCapturingKey(): boolean {
        return this.state.captures.length > 0;
    }

    get isPicking(): boolean {
        return this.state.picks.length > 0;
    }

    get isConfirming(): boolean {
        return this.state.confirms.length > 0;
    }

    get isPrompting(): boolean {
        return this.state.prompts.length > 0;
    }

    // what a pad drives the command palette with (the keyboard goes to the dialog directly). Does nothing when no list
    // is open
    steerPick(command: 'up' | 'down' | 'accept' | 'cancel'): void {
        const request = this.state.picks[this.state.picks.length - 1];
        if (!request) {
            return;
        }
        if (command === 'cancel') {
            request.resolve(undefined);
        } else if (command === 'accept') {
            request.steer?.accept();
        } else {
            request.steer?.move(command === 'up' ? -1 : 1);
        }
    }

    // undefined on backing out
    pick(
        placeholder: string,
        items: PickItem[],
        emptyMessage?: string,
        // left out, a placeholder that names the list ("Language") is the title too, one that asks is not
        title?: string,
    ): Promise<PickItem | undefined> {
        return new Promise<PickItem | undefined>(resolve => {
            const id = this.nextId++;
            const request: PickRequest = {
                id,
                title: title ?? (/[…?.]$/.test(placeholder.trim()) ? undefined : placeholder),
                placeholder,
                items,
                emptyMessage: emptyMessage
                    ?? nls.localize('vueport/debug/panels/noMatch', 'No matching panel'),
                resolve: picked => {
                    this.update({ picks: this.state.picks.filter(p => p.id !== id) });
                    resolve(picked);
                },
            };
            this.update({ picks: [...this.state.picks, request] });
        });
    }

    // undefined on backing out, which is not binding nothing: the caller leaves the binding alone
    captureKey(options: CaptureOptions): Promise<string | undefined> {
        return new Promise<string | undefined>(resolve => {
            const id = this.nextId++;
            const request: CaptureRequest = {
                ...options,
                id,
                resolve: code => {
                    this.update({ captures: this.state.captures.filter(c => c.id !== id) });
                    resolve(code);
                },
            };
            this.update({ captures: [...this.state.captures, request] });
        });
    }
}

// on the window in the capture phase, as the dock (and the browser, after a click replacing the element) takes focus
// away from a field's onKeyDown. Only for the topmost layer, so one press backs out of one thing
function escapeCancels(cancel: (value: undefined) => void): () => void {
    const layer = pushEscapeLayer();
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && layer.isTop()) {
            event.preventDefault();
            event.stopPropagation();
            cancel(undefined);
        }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
        window.removeEventListener('keydown', onKeyDown, true);
        layer.dispose();
    };
}

// a window listener like pick and prompt (see escapeCancels), as the dock takes focus back the moment this opens, a
// race autoFocus on the primary button lost in practice
function ConfirmDialog(props: { request: ConfirmRequest }): React.JSX.Element {
    const { request } = props;

    React.useEffect(() => {
        const layer = pushEscapeLayer();
        const onKeyDown = (e: KeyboardEvent): void => {
            if (!layer.isTop()) {
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                request.resolve(false);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                request.resolve(true);
            }
        };
        // capture phase, as the emulator's own key handler must not see either key
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            layer.dispose();
        };
    }, [request]);

    return <div className='vp-modal-backdrop' onMouseDown={() => request.resolve(false)}>
        <div
            className='vp-modal'
            role='dialog'
            aria-modal='true'
            onMouseDown={event => event.stopPropagation()}
        >
            <h2>{request.title}</h2>
            {request.message.map((paragraph, i) => <p key={i}>{paragraph}</p>)}
            <div className='vp-modal-buttons'>
                <button className='vp-button secondary' onClick={() => request.resolve(false)}>
                    {nls.localize('vueport/state/cancel', 'Cancel')}
                </button>
                <button className='vp-button' autoFocus onClick={() => request.resolve(true)}>
                    {request.okLabel ?? nls.localize('vueport/general/ok', 'OK')}
                </button>
            </div>
        </div>
    </div>;
}

// separators are hidden when a filter leaves nothing under them
function PickDialog(props: { request: PickRequest }): React.JSX.Element {
    const { request } = props;
    const [filter, setFilter] = React.useState('');
    const [active, setActive] = React.useState(0);

    // Escape belongs to the pick while open, so a window underneath does not close itself instead; on the window, as
    // focus can be anywhere
    React.useEffect(() => escapeCancels(request.resolve), [request]);

    const matches = React.useMemo(() => {
        const needle = filter.trim().toLowerCase();
        const kept = request.items.filter(item =>
            item.separator || !needle || item.label.toLowerCase().includes(needle));
        return kept.filter((item, index) => {
            if (!item.separator) {
                return true;
            }
            const rest = kept.slice(index + 1);
            const nextHeading = rest.findIndex(next => next.separator);
            const untilNextHeading = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
            return untilNextHeading.length > 0;
        });
    }, [request.items, filter]);

    const choosable = matches.filter(item => !item.separator && !item.disabled);
    const current = choosable[Math.min(active, choosable.length - 1)];

    React.useEffect(() => setActive(0), [filter]);

    // through a ref so the latest list is chosen from
    const currentRef = React.useRef(current);
    currentRef.current = current;
    const lastIndex = choosable.length - 1;
    React.useEffect(() => {
        request.steer = {
            move: by => setActive(index => Math.max(0, Math.min(index + by, lastIndex))),
            accept: () => request.resolve(currentRef.current),
        };
        return () => { request.steer = undefined; };
    }, [request, lastIndex]);

    const list = React.useRef<HTMLUListElement>(null);
    React.useEffect(() => {
        list.current?.querySelector('.vp-pick-active')?.scrollIntoView({ block: 'nearest' });
    }, [current]);

    const onKeyDown = (event: React.KeyboardEvent) => {
        // the emulator is listening for keys on the page
        event.stopPropagation();
        if (event.key === 'Enter') {
            // choosing can open a dialog ("delete SRAM?") whose focused button the browser activates with this Enter
            // after this handler, so one press would ask and answer yes
            event.preventDefault();
            request.resolve(current);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(index => Math.min(index + 1, choosable.length - 1));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(index => Math.max(index - 1, 0));
        }
    };

    return <div className='vp-modal-backdrop' onMouseDown={event => {
        event.preventDefault();
        request.resolve(undefined);
    }}>
        <div
            className='vp-pick'
            role='dialog'
            aria-modal='true'
            onMouseDown={event => event.stopPropagation()}
        >
            {/* a way out to point at, for a mouse, a touch, a headset's controller */}
            <header className='vp-pick-head'>
                <span className='vp-pick-title'>{request.title}</span>
                <button
                    type='button'
                    className='vp-pick-close'
                    title={nls.localize('vueport/state/close', 'Close')}
                    aria-label={nls.localize('vueport/state/close', 'Close')}
                    onClick={() => request.resolve(undefined)}
                >
                    <X size={16} />
                </button>
            </header>
            <input
                className='vp-pick-filter'
                placeholder={request.placeholder}
                value={filter}
                autoFocus
                onChange={event => setFilter(event.target.value)}
                onKeyDown={onKeyDown}
            />
            <ul className='vp-pick-list vp-scroll' ref={list}>
                {matches.map((item, index) => item.separator
                    ? <li key={`sep-${index}`} className='vp-pick-separator'>{item.label}</li>
                    : <li
                        key={item.id}
                        className={'vp-pick-item'
                            + (item === current ? ' vp-pick-active' : '')
                            + (item.disabled ? ' vp-pick-disabled' : '')}
                        aria-disabled={item.disabled}
                        onMouseEnter={() => !item.disabled && setActive(choosable.indexOf(item))}
                        onMouseDown={event => {
                            // choosing can open the next list in this one's place, and the browser would move focus
                            // after this handler, off the new list's filter
                            event.preventDefault();
                            if (!item.disabled) {
                                request.resolve(item);
                            }
                        }}
                    >
                        <span className='vp-pick-main'>
                            {item.icon && <item.icon className='vp-pick-icon' size={16} />}
                            <span className='vp-pick-label'>{item.label}</span>
                        </span>
                        {(item.description || item.buttons?.length) &&
                            <span className='vp-pick-end'>
                                {item.description && <span className='vp-pick-description'>{item.description}</span>}
                                {item.buttons?.map((button, buttonIndex) =>
                                    <button
                                        key={buttonIndex}
                                        className='vp-pick-button'
                                        title={button.label}
                                        aria-label={button.label}
                                        // mouse only, like the studio's quick pick: the keyboard stays in the filter
                                        tabIndex={-1}
                                        onMouseDown={event => {
                                            // neither the entry's own press, which would choose it, nor a focus change
                                            event.preventDefault();
                                            event.stopPropagation();
                                        }}
                                        onClick={() => {
                                            request.resolve(undefined);
                                            button.run();
                                        }}
                                    >
                                        <button.icon size={16} />
                                    </button>)}
                            </span>}
                    </li>)}
                {choosable.length === 0 &&
                    <li className='vp-pick-empty'>{request.emptyMessage}</li>}
            </ul>
        </div>
    </div>;
}

// an empty field cannot be submitted
function PromptDialog(props: { request: PromptRequest }): React.JSX.Element {
    const { request } = props;
    const [value, setValue] = React.useState(request.value ?? '');

    React.useEffect(() => escapeCancels(request.resolve), [request]);

    const empty = value.trim() === '';
    const submit = (): void => {
        if (!empty) {
            request.resolve(value.trim());
        }
    };

    return <div className='vp-modal-backdrop' onMouseDown={() => request.resolve(undefined)}>
        <form
            className='vp-modal'
            role='dialog'
            aria-modal='true'
            onMouseDown={event => event.stopPropagation()}
            onSubmit={event => { event.preventDefault(); submit(); }}
        >
            <h2>{request.title}</h2>
            {(typeof request.message === 'string' ? [request.message] : request.message ?? [])
                .map((paragraph, index) => <p key={index}>{paragraph}</p>)}
            <input
                className='vp-modal-input'
                type={request.type ?? 'text'}
                inputMode={request.type === 'url' ? 'url' : undefined}
                spellCheck={false}
                autoComplete='off'
                autoFocus
                placeholder={request.placeholder}
                value={value}
                // the emulator matches keys off the page by code alone, so anything typed here would also be a pad
                // button
                onKeyDown={event => event.stopPropagation()}
                onChange={event => setValue(event.target.value)}
            />
            <div className='vp-modal-buttons'>
                <button className='vp-button secondary' type='button' onClick={() => request.resolve(undefined)}>
                    {nls.localize('vueport/state/cancel', 'Cancel')}
                </button>
                <button className='vp-button' type='submit' disabled={empty}>
                    {request.okLabel ?? nls.localize('vueport/general/ok', 'OK')}
                </button>
            </div>
        </form>
    </div>;
}

// neither action closes the prompt, as clearing is usually the first half of replacing (like the studio's capture
// dialog)
function CaptureDialog(props: { request: CaptureRequest }): React.JSX.Element {
    const { request } = props;
    // read on render rather than held, as the bindings are the authority; the counter only forces a re-render after a
    // button changed them
    const [, setRevision] = React.useState(0);
    const mappings = request.currentMappings();

    React.useEffect(() => {
        const layer = pushEscapeLayer();
        const onKeyDown = (e: KeyboardEvent) => {
            // only while this is the innermost thing open
            if (!layer.isTop()) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') {
                request.resolve(undefined);
                return;
            }
            // a bare modifier is the user still reaching for the real key
            if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
                return;
            }
            request.resolve(e.code);
        };
        // capture phase, as the emulator's own key handler must not see the key being bound
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            layer.dispose();
        };
    }, [request]);

    const act = (action: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
        // otherwise the next key press would activate the button
        event.currentTarget.blur();
        action();
        setRevision(current => current + 1);
    };

    const { clearAll, resetToDefault } = request;
    return <div className="vp-modal-backdrop">
        <div className="vp-modal" role="dialog" aria-modal="true">
            <h2>{request.title}</h2>
            <p>{nls.localize('vueport/input/pressKey', 'Press the key to bind, or Escape to cancel.')}</p>
            <p className="vp-capture-current">
                {mappings
                    ? <>{nls.localize('vueport/input/currentlyMappedTo', 'Currently mapped to:')} <b>{mappings}</b></>
                    : nls.localize('vueport/input/currentlyUnmapped', 'Currently not mapped to any key.')}
            </p>
            {request.note && <p className="vp-capture-note">{request.note}</p>}
            {(clearAll || resetToDefault) &&
                <div className="vp-modal-buttons">
                    {resetToDefault &&
                        <button onClick={act(resetToDefault)}>
                            {nls.localize('vueport/input/resetToDefault', 'Reset to Default')}
                        </button>}
                    {clearAll &&
                        <button onClick={act(clearAll)} disabled={!mappings}>
                            {nls.localize('vueport/input/clearAllMappings', 'Clear All Mappings')}
                        </button>}
                </div>}
        </div>
    </div>;
}

export function WebUiOverlay(props: { ui: WebUi }): React.JSX.Element {
    const state = React.useSyncExternalStore(props.ui.subscribe, props.ui.getState);
    const capture = state.captures[state.captures.length - 1];
    const confirm = state.confirms[state.confirms.length - 1];
    const prompt = state.prompts[state.prompts.length - 1];
    const pick = state.picks[state.picks.length - 1];

    return <div className="vp-overlay">
        <div className="vp-toasts">
            {state.toasts.map(toast =>
                <div key={toast.id}
                    className={`vp-toast vp-toast-${toast.kind}${toast.onClick ? ' vp-toast-clickable' : ''}`}
                    onClick={toast.onClick}
                    onMouseEnter={() => props.ui.pauseToast(toast.id)}
                    onMouseLeave={() => props.ui.resumeToast(toast.id)}
                    role={toast.onClick ? 'button' : undefined}>
                    {toast.iconUrl && <img className='vp-toast-icon' src={toast.iconUrl} alt='' />}
                    <span className='vp-toast-text'>
                        <span>{toast.text}</span>
                        {toast.subtitle && <span className='vp-toast-subtitle'>{toast.subtitle}</span>}
                        {toast.meta && <span className='vp-toast-meta'>{toast.meta}</span>}
                    </span>
                    <button
                        onClick={e => { e.stopPropagation(); props.ui.dismissToast(toast.id); }}
                        title={nls.localize('vueport/general/dismiss', 'Dismiss')}>
                        <X size={20} />
                    </button>
                </div>
            )}
            {state.progresses.map(progress =>
                <div key={progress.id} className="vp-toast vp-toast-progress">
                    <span className="vp-spinner" />
                    <span>{progress.text}</span>
                </div>
            )}
        </div>
        {confirm && <ConfirmDialog key={confirm.id} request={confirm} />}
        {prompt && <PromptDialog key={prompt.id} request={prompt} />}
        {pick && <PickDialog key={pick.id} request={pick} />}
        {capture && <CaptureDialog key={capture.id} request={capture} />}
    </div>;
}
