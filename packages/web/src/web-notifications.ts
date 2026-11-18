import { VueportNotifications, VueportProgress } from 'vueport-core/lib/common/emulator-host';
import { WebUi } from './web-ui';

// a thin pass-through to WebUi, so panels holding a VueportNotifications do not pull in a React view layer
export class WebNotifications implements VueportNotifications {

    constructor(protected readonly ui: WebUi) { }

    info(text: string): void {
        this.ui.toast('info', text);
    }

    warn(text: string): void {
        this.ui.toast('warn', text);
    }

    error(text: string): void {
        this.ui.toast('error', text);
    }

    confirm(options: { title: string, message: string | string[], okLabel?: string }): Promise<boolean> {
        return this.ui.confirm(options);
    }

    async progress(text: string): Promise<VueportProgress> {
        return this.ui.progress(text);
    }
}
