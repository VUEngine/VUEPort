// where the page is on the display, from the shell, for the interleaved rendering modes; see screen-origin.ts in
// core for why the page cannot work it out itself, and placement.rs for the other end
import { Emitter } from 'vueport-core/lib/common/emulator-events';
import { setScreenOriginSource } from 'vueport-core/lib/browser/screen-origin';
import { invoke, listen } from './desktop-bridge';

interface ContentOrigin {
    x: number;
    y: number;
}

function isOrigin(value: unknown): value is ContentOrigin {
    const origin = value as ContentOrigin | null;
    return typeof origin?.x === 'number' && typeof origin.y === 'number';
}

// asked once, then updated on every move, resize and scaling change; until then the screen uses its own estimate
export async function installScreenOrigin(): Promise<void> {
    let origin: ContentOrigin | undefined;
    const changed = new Emitter<void>();
    const take = (value: unknown): void => {
        if (isOrigin(value) && (value.x !== origin?.x || value.y !== origin?.y)) {
            origin = { x: value.x, y: value.y };
            changed.fire();
        }
    };
    await listen('window://content-origin', take);
    take(await invoke<unknown>('window_content_origin').catch(() => undefined));
    setScreenOriginSource({ origin: () => origin, onDidChange: changed.event });
}
