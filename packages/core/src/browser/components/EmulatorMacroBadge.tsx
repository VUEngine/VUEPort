import { Play, Record } from '@phosphor-icons/react';
import * as React from 'react';
import { nls } from '../../common/emulator-nls';
import { MacroActivity } from '../emulator-macro-store';

const RECORD_BLINK_MS = 700;

function useRecordLight(active: boolean): boolean {
    const [lit, setLit] = React.useState(true);
    React.useEffect(() => {
        if (!active) {
            setLit(true);
            return;
        }
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
        let timer: number | undefined;
        const apply = () => {
            if (timer !== undefined) {
                window.clearInterval(timer);
                timer = undefined;
            }
            if (reduced.matches) {
                setLit(true);
                return;
            }
            timer = window.setInterval(() => setLit(on => !on), RECORD_BLINK_MS);
        };
        apply();
        reduced.addEventListener('change', apply);
        return () => {
            reduced.removeEventListener('change', apply);
            if (timer !== undefined) {
                window.clearInterval(timer);
            }
        };
    }, [active]);
    return lit;
}

export default function EmulatorMacroBadge(props: {
    activity: MacroActivity,
    onShow: () => void,
    onCancelRecording: () => void,
}): React.JSX.Element | null {
    const { activity, onShow, onCancelRecording } = props;
    const recording = activity === MacroActivity.RECORDING;
    const lit = useRecordLight(recording);
    if (activity === MacroActivity.IDLE) {
        return null;
    }
    return <button
        type='button'
        className={'vp-screen-badge vp-macro-badge'
            + (recording ? ' recording' : '')}
        aria-label={recording
            ? nls.localize('vueport/macros/recordingBadge',
                'A macro is being recorded. Stop recording and discard it.')
            : nls.localize('vueport/macros/playingBadge', 'A macro is playing. Show the macros.')}
        onClick={recording ? onCancelRecording : onShow}
    >
        {recording
            ? <Record size={16} weight={lit ? 'fill' : 'regular'} />
            : <Play size={16} weight='fill' />
        }
        {recording
            ? nls.localize('vueport/macros/rec', 'REC')
            : nls.localize('vueport/macros/playing', 'Macro')
        }
    </button>;
}
