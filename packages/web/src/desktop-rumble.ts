import { rumblePackName, SerialRumblePack } from 'vueport-core/lib/common/emulator-rumble';
import { invoke, listen } from './desktop-bridge';

// see rumble.rs
interface OpenedPort {
    path: string;
    name: string;
    vendor: number;
    product: number;
}

// a real Rumble Pack over the serial port the desktop shell opens. Only the transport; the protocol is
// SerialRumblePack in vueport-core (also under WebSerialRumblePack). WKWebView has no navigator.serial, so
// the port is opened in Rust and the bytes arrive as events
export class DesktopRumblePack extends SerialRumblePack {

    override get canConnect(): boolean {
        return true;
    }

    // called once at start-up; a pack plugged in later is found by detect (the panel's button)
    async start(): Promise<void> {
        await listen('rumble://data', payload => this.received(payload));
        await listen('rumble://closed', () => this.detached());
        try {
            await this.open();
        } catch {
            // nothing attached at start-up is the ordinary case, not a fault
        }
    }

    override async detect(): Promise<void> {
        await this.open();
    }

    protected async open(): Promise<void> {
        const port = await invoke<OpenedPort>('rumble_open', {});
        this.attached({
            // the shell names the board from its own table; the shared one covers ports it could not name
            name: port.name || rumblePackName(port.vendor, port.product) || 'Rumble Pack',
            vendor: port.vendor,
            product: port.product,
        });
    }

    protected received(payload: unknown): void {
        const bytes = Array.isArray(payload) ? payload as number[] : [];
        this.receive(String.fromCharCode(...bytes));
    }

    protected override async write(text: string): Promise<void> {
        const data = Array.from(new TextEncoder().encode(text));
        try {
            await invoke('rumble_write', { data });
        } catch {
            // written while being unplugged; the closed event follows
            this.detached();
        }
    }
}
