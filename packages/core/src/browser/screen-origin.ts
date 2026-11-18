// where the page sits on the display, handed in by a host with a native side such as the desktop app. Interleaved modes
// need the exact display line the picture starts on, and the page's CSS-pixel window position is a line off at 125 or
// 150 % scaling
import { Disposable, Emitter, Event } from '../common/emulator-events';

export interface ScreenOriginSource {
    // in physical pixels of the display; undefined while not known
    origin(): { x: number, y: number } | undefined;
    readonly onDidChange: Event<void>;
}

let current: ScreenOriginSource | undefined;
let subscription: Disposable | undefined;
const changed = new Emitter<void>();

export function setScreenOriginSource(source: ScreenOriginSource | undefined): void {
    subscription?.dispose();
    current = source;
    subscription = source?.onDidChange(() => changed.fire());
    changed.fire();
}

export function screenOrigin(): { x: number, y: number } | undefined {
    return current?.origin();
}

export const onDidChangeScreenOrigin: Event<void> = changed.event;
