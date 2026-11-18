import * as React from 'react';
import { nls } from '../../../common/emulator-nls';
import { VUEPORT_DEFAULTS, VueportSettings } from '../../../common/emulator-settings';
import { TURBO_RATE_RANGE, clampTurboRate } from '../../../common/emulator-turbo';
import { VB_FRAME_RATE } from '../../../common/vb-constants';
import { EmulatorGamePadButton } from '../../emulator-commands';
import { pushEscapeLayer } from '../kit/escape-layers';

// layout pieces shared by the input pages; nothing here knows what a binding is, each page keeps its own state

export interface CaptureRun {
    step: number;
    total: number;
    queue: EmulatorGamePadButton[];
}

/**
 * Listens on an escape layer, so a window opened over this one gets the key first, and in the capture phase, so the
 * emulator's own key handler does not see the key being bound. Installed only when a capture starts or ends, not per
 * step of a run, so the layer does not flicker. The keyboard pages bind the key; the Game Pads page only watches for
 * Escape.
 */
export function useCaptureKeys(waiting: boolean, onKey: (event: KeyboardEvent) => void): void {
    // read through a ref, so a run's later steps are not still answering the first one's question
    const handle = React.useRef(onKey);
    handle.current = onKey;
    React.useEffect(() => {
        if (!waiting) {
            return undefined;
        }
        const layer = pushEscapeLayer();
        const onKeyDown = (event: KeyboardEvent): void => {
            if (layer.isTop()) {
                handle.current(event);
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            layer.dispose();
        };
    }, [waiting]);
}

// inline rather than a modal, so the control being asked for stays in view, lit
export function CaptureStrip(props: {
    title: React.ReactNode,
    run?: CaptureRun,
    prompt: React.ReactNode,
    detail: React.ReactNode,
    actions: React.ReactNode,
}): React.JSX.Element {
    return <div className='vp-input-capture'>
        <div className='vp-input-capture-head'>
            <span className='vp-input-capture-title'>{props.title}</span>
            {props.run &&
                <span className='vp-input-step-count'>
                    {nls.localize('vueport/input/setAllStep', '{0} of {1}',
                        String(props.run.step), String(props.run.total))}
                </span>}
        </div>
        <p className='vp-input-capture-prompt'>{props.prompt}</p>
        {props.detail}
        <div className='vp-input-capture-actions'>{props.actions}</div>
    </div>;
}

export function CancelCapture(props: { onClick: () => void }): React.JSX.Element {
    return <button type='button' className='vp-button secondary' onClick={props.onClick}>
        {nls.localize('vueport/state/cancel', 'Cancel')}
    </button>;
}

export function BindingRow(props: {
    name: React.ReactNode,
    value: React.ReactNode,
    lit?: boolean, // also while the pointer is over its control on the picture
    waiting?: boolean,
    changed?: boolean, // differs from the preset the mapping started from
    changedTitle?: string,
    onClick: () => void,
    onHoverIn?: () => void,
    onHoverOut?: () => void,
}): React.JSX.Element {
    return <button
        type='button'
        className={'vp-input-row'
            + (props.lit ? ' is-lit' : '')
            + (props.waiting ? ' is-waiting' : '')
            + (props.changed ? ' is-changed' : '')}
        title={props.changedTitle}
        onClick={props.onClick}
        onMouseEnter={props.onHoverIn}
        onMouseLeave={props.onHoverOut}
    >
        <span className='vp-input-row-name'>{props.name}</span>
        <span className={'vp-input-key' + (props.waiting ? ' is-waiting' : '')}>
            {props.value}
        </span>
    </button>;
}

export function BindingList(props: {
    title: string,
    children: React.ReactNode,
}): React.JSX.Element {
    return <fieldset className='vp-input-list'>
        <legend className='vp-panel-list-header'>{props.title}</legend>
        {props.children}
    </fieldset>;
}

export function PresetRow(props: {
    children: React.ReactNode,
    trailing?: React.ReactNode,
}): React.JSX.Element {
    return <div className='vp-preset-row'>
        <span className='vp-preset-label'>
            {nls.localize('vueport/input/presets/title', 'Presets')}
        </span>
        {props.children}
        <span className='vp-input-spacer' />
        {props.trailing}
    </div>;
}

export function PresetPill(props: {
    label: string,
    current?: boolean,
    onClick: () => void,
}): React.JSX.Element {
    return <button
        type='button'
        className={'vp-preset-pill' + (props.current ? ' is-current' : '')}
        onClick={props.onClick}
    >
        {props.label}
    </button>;
}

export function SetAllButton(props: { label: string, onClick: () => void }): React.JSX.Element {
    return <button type='button' className='vp-button secondary' onClick={props.onClick}>
        {props.label}
    </button>;
}

export function PadDiagrams(props: { children: React.ReactNode }): React.JSX.Element {
    return <div className='vp-input-diagrams'>{props.children}</div>;
}

export function InputPage(props: {
    top: React.ReactNode, // the tab strip, passed in as the pane decides which page shows (see InputSettings)
    children: React.ReactNode,
}): React.JSX.Element {
    return <div className='vp-input-settings'>
        <div className='vp-input-top'>{props.top}</div>
        {props.children}
    </div>;
}

export function InputSpacer(): React.JSX.Element {
    return <span className='vp-input-spacer' />;
}

// at the same spot on every page, so the pad's name does not jump when switching
export function PadBadge(props: { label?: string, title?: string }): React.JSX.Element {
    return <span className='vp-input-pad' title={props.title}>
        <span className='vp-input-pad-dot' />
        {props.label}
    </span>;
}

export function BindingCard(props: { children: React.ReactNode }): React.JSX.Element {
    return <fieldset className='vp-input-pad-card'>
        <legend className='vp-panel-list-header'>
            {nls.localize('vueport/input/assignments', 'Assignments')}
        </legend>
        {props.children}
    </fieldset>;
}

export function BindingBody(props: { children: React.ReactNode }): React.JSX.Element {
    return <div className='vp-input-body'>{props.children}</div>;
}

export function BindingLists(props: { children: React.ReactNode }): React.JSX.Element {
    return <div className='vp-input-lists'>{props.children}</div>;
}

// one setting for all turbo buttons. Runs slow to fast, the reverse of the setting's frames per half period, and
// shows presses per second
export function TurboRateSlider(props: {
    settings: VueportSettings,
    onChange?: () => void,
}): React.JSX.Element {
    const { settings, onChange } = props;
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    const rate = clampTurboRate(settings.get('turboRate'));
    const standard = clampTurboRate(settings.defaults?.turboRate ?? VUEPORT_DEFAULTS.turboRate);
    const flip = (value: number): number => TURBO_RATE_RANGE.min + TURBO_RATE_RANGE.max - value;
    const perSecond = VB_FRAME_RATE / (2 * rate);
    return <label
        className={'vp-gamepad-deadzone' + (rate !== standard ? ' is-changed' : '')}
        title={nls.localize(
            'vueport/input/turbo/rateHint',
            'How often a turbo button presses itself while you hold it. The same for every turbo button.',
        )}
    >
        {nls.localize('vueport/input/turbo/rate', 'Turbo speed')}
        <input
            type='range'
            min={TURBO_RATE_RANGE.min}
            max={TURBO_RATE_RANGE.max}
            step={1}
            value={flip(rate)}
            onChange={event => {
                settings.set('turboRate', flip(Number(event.target.value))).catch(() => undefined);
                bump();
                onChange?.();
            }}
        />
        <span className='vp-gamepad-changed' />
        <span className='vp-gamepad-deadzone-value'>
            {nls.localize('vueport/input/turbo/perSecond', '{0}/s',
                perSecond.toFixed(perSecond < 10 ? 1 : 0))}
        </span>
    </label>;
}

export function TurboTitle(props: { name: React.ReactNode }): React.JSX.Element {
    return <>{props.name} ({nls.localize('vueport/input/turbo/title', 'Turbo')})</>;
}
