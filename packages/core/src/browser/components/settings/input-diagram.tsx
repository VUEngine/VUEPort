// shared by the keyboard pages and the Game Pads page; knows nothing about keymaps or profiles

import { ArrowFatDown, ArrowFatLeft, ArrowFatRight, ArrowFatUp } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../../common/emulator-nls';
import { EmulatorGamePadButton } from '../../emulator-commands';
import {
    CONTROLLER_BACK_SHELL,
    CONTROLLER_FRONT_SHELL,
    CONTROLLER_POWER_SWITCH,
} from './controller-art';

// in list order, which is also the order a capture run asks for them
export const PAD_BUTTONS: EmulatorGamePadButton[] = [
    'lUp', 'lDown', 'lLeft', 'lRight',
    'rUp', 'rDown', 'rLeft', 'rRight',
    'select', 'start', 'b', 'a',
    'lTrigger', 'rTrigger',
];

export interface PadControl {
    face: 'front' | 'back';
    shape: React.ReactNode; // outline, in controller.xml's coordinates
    hit: { x: number, y: number, r: number };
    caption: { x: number, y: number, anchor: 'start' | 'middle' | 'end' };
}

// a D-pad arm: three outer sides open toward the center, so the four form one cross yet each can be lit alone.
// No `fill` attribute, as that would override `.vp-input-control-shape` from CSS; the open edge closes implicitly,
// so the fill covers the arm's whole rectangle
const bracket = (d: string): React.ReactNode => <path d={d} strokeLinecap='round' />;
const ring = (x: number, y: number, r: number): React.ReactNode => <circle cx={x} cy={y} r={r} />;

export const PAD_CONTROLS: Record<EmulatorGamePadButton, PadControl> = {
    lUp: { face: 'front', shape: bracket('M37.06 34.06V21.75H48.94V34.06'), hit: { x: 43, y: 28, r: 9 }, caption: { x: 43, y: 13, anchor: 'middle' } },
    lLeft: { face: 'front', shape: bracket('M37.06 34.06H24.75V45.94H37.06'), hit: { x: 31, y: 40, r: 9 }, caption: { x: 18, y: 41, anchor: 'end' } },
    lDown: { face: 'front', shape: bracket('M37.06 45.94V58.25H48.94V45.94'), hit: { x: 43, y: 52, r: 9 }, caption: { x: 43, y: 71, anchor: 'middle' } },
    lRight: { face: 'front', shape: bracket('M48.94 45.94H61.25V34.06H48.94'), hit: { x: 55, y: 40, r: 9 }, caption: { x: 68, y: 41, anchor: 'start' } },
    rUp: { face: 'front', shape: bracket('M201.06 34.06V21.75H212.94V34.06'), hit: { x: 207, y: 28, r: 9 }, caption: { x: 207, y: 13, anchor: 'middle' } },
    rLeft: { face: 'front', shape: bracket('M201.06 34.06H188.75V45.94H201.06'), hit: { x: 195, y: 40, r: 9 }, caption: { x: 182, y: 41, anchor: 'end' } },
    rDown: { face: 'front', shape: bracket('M201.06 45.94V58.25H212.94V45.94'), hit: { x: 207, y: 52, r: 9 }, caption: { x: 207, y: 71, anchor: 'middle' } },
    rRight: { face: 'front', shape: bracket('M212.94 45.94H225.25V34.06H212.94'), hit: { x: 219, y: 40, r: 9 }, caption: { x: 232, y: 41, anchor: 'start' } },
    select: { face: 'front', shape: ring(75, 54, 7.25), hit: { x: 75, y: 54, r: 10 }, caption: { x: 75, y: 73, anchor: 'middle' } },
    start: { face: 'front', shape: ring(94, 63, 7.25), hit: { x: 94, y: 63, r: 10 }, caption: { x: 94, y: 82, anchor: 'middle' } },
    b: { face: 'front', shape: ring(156, 63, 7.25), hit: { x: 156, y: 63, r: 10 }, caption: { x: 156, y: 82, anchor: 'middle' } },
    a: { face: 'front', shape: ring(175, 54, 7.25), hit: { x: 175, y: 54, r: 10 }, caption: { x: 175, y: 73, anchor: 'middle' } },
    lTrigger: { face: 'back', shape: ring(321, 43, 11.25), hit: { x: 321, y: 43, r: 15 }, caption: { x: 321, y: 65, anchor: 'middle' } },
    rTrigger: { face: 'back', shape: ring(469, 43, 11.25), hit: { x: 469, y: 43, r: 15 }, caption: { x: 469, y: 65, anchor: 'middle' } },
};

export const PAD_FACES = {
    front: { viewBox: '0.16 0.15 249.95 214.70', shell: CONTROLLER_FRONT_SHELL },
    back: { viewBox: '269.89 0.15 249.95 214.70', shell: CONTROLLER_BACK_SHELL },
} as const;

export function dpadArrow(button: EmulatorGamePadButton): React.JSX.Element | undefined {
    switch (button) {
        case 'lUp': case 'rUp': return <ArrowFatUp size={13} weight='fill' />;
        case 'lDown': case 'rDown': return <ArrowFatDown size={13} weight='fill' />;
        case 'lLeft': case 'rLeft': return <ArrowFatLeft size={13} weight='fill' />;
        case 'lRight': case 'rRight': return <ArrowFatRight size={13} weight='fill' />;
        default: return undefined;
    }
}

export function padButtonName(
    button: EmulatorGamePadButton,
    label: React.ReactNode,
): React.ReactNode {
    const arrow = dpadArrow(button);
    if (!arrow) {
        return label;
    }
    const base = button.startsWith('l')
        ? nls.localize('vueport/input/leftDpad', 'Left D-Pad')
        : nls.localize('vueport/input/rightDpad', 'Right D-Pad');
    return <span className='vp-input-dpad'>{base}{arrow}</span>;
}

export interface PadDiagramProps {
    face: 'front' | 'back';
    caption(button: EmulatorGamePadButton): string;
    isLit(button: EmulatorGamePadButton): boolean;
    isWaiting(button: EmulatorGamePadButton): boolean;
    onSelect(button: EmulatorGamePadButton): void;
    onHover(button: EmulatorGamePadButton | undefined): void;
    // front only. The VB has no reset button (the power switch is the reset), so the keyboard pages make it a
    // binding target
    powerSwitch?: React.ReactNode;
}

export function PadDiagram(props: PadDiagramProps): React.JSX.Element {
    const { face, caption, isLit, isWaiting, onSelect, onHover, powerSwitch } = props;
    const { viewBox, shell } = PAD_FACES[face];
    return <figure className='vp-input-diagram-figure'>
        <figcaption className='vp-input-diagram-label'>
            {face === 'front'
                ? nls.localize('vueport/input/front', 'Front')
                : nls.localize('vueport/input/back', 'Back')}
        </figcaption>
        <svg className='vp-input-diagram' viewBox={viewBox}>
            {shell}
            {PAD_BUTTONS.filter(button => PAD_CONTROLS[button].face === face).map(button => {
                const control = PAD_CONTROLS[button];
                return <g
                    key={button}
                    className={'vp-input-control'
                        + (isLit(button) ? ' is-lit' : '')
                        + (isWaiting(button) ? ' is-waiting' : '')}
                    onClick={() => onSelect(button)}
                    onMouseEnter={() => onHover(button)}
                    onMouseLeave={() => onHover(undefined)}
                >
                    <g className='vp-input-control-shape'>{control.shape}</g>
                    <text
                        className='vp-input-control-key'
                        x={control.caption.x}
                        y={control.caption.y}
                        textAnchor={control.caption.anchor}
                    >
                        {caption(button)}
                    </text>
                    <circle
                        className='vp-input-control-hit'
                        cx={control.hit.x}
                        cy={control.hit.y}
                        r={control.hit.r}
                    />
                </g>;
            })}
            {face === 'front'
                && (powerSwitch ?? <g className='vp-input-art'>{CONTROLLER_POWER_SWITCH}</g>)}
        </svg>
    </figure>;
}
