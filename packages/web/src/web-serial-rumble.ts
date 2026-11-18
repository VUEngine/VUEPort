import {
    RUMBLE_PACK_IDS,
    RumblePackDevice,
    rumblePackName,
    SerialRumblePack,
} from 'vueport-core/lib/common/emulator-rumble';

/**
 * A real Rumble Pack over the Web Serial API: the board and firmware the desktop shell opens in Rust, opened by a
 * Chromium page itself, as VUEngine Studio (Electron) does. Protocol, decoding and reply lines are SerialRumblePack's;
 * this is the port. Firefox, Safari and phones lack the API, so with canConnect false the panel drops its Detect button
 * and says the port is only decoded. The browser remembers the permission, so getPorts hands a picked port back on the
 * next visit and start can reconnect without a prompt.
 */
export class WebSerialRumblePack extends SerialRumblePack {

    // from the studio's service; the firmware's, not ours
    protected static readonly LINE = {
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
    } as const;

    protected port: SerialPortLike | undefined;
    protected writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    protected reading = false;

    static available(): boolean {
        return typeof navigator !== 'undefined' && serialApi() !== undefined;
    }

    override get canConnect(): boolean {
        return WebSerialRumblePack.available();
    }

    // getPorts only returns granted ports, so no prompt; a granted device being plugged in reaches the page even
    // without a click
    async start(): Promise<void> {
        const serial = serialApi();
        if (!serial) {
            return;
        }
        serial.addEventListener('connect', () => {
            if (!this.connected) {
                this.openGranted().catch(() => undefined);
            }
        });
        serial.addEventListener('disconnect', event => {
            if (this.port !== undefined && (event as { target?: unknown }).target === this.port) {
                this.close();
            }
        });
        await this.openGranted().catch(() => undefined);
    }

    // the picker needs a user gesture (the Detect button) and is filtered to Rumble Pack boards. Picking nothing
    // rejects, which is a change of mind rather than a fault, so it is swallowed
    override async detect(): Promise<void> {
        const serial = serialApi();
        if (!serial) {
            return;
        }
        let picked: SerialPortLike | undefined;
        try {
            picked = await serial.requestPort({
                filters: RUMBLE_PACK_IDS.map(id => ({
                    usbVendorId: id.vendor,
                    usbProductId: id.product,
                })),
            });
        } catch {
            // nothing picked: fall back to what was already granted, so a second press with the pack allowed still
            // works
            await this.openGranted();
            return;
        }
        await this.open(picked);
    }

    protected async openGranted(): Promise<void> {
        const serial = serialApi();
        if (!serial || this.connected) {
            return;
        }
        for (const port of await serial.getPorts()) {
            if (deviceOf(port) && await this.open(port).then(() => true, () => false)) {
                return;
            }
        }
    }

    protected async open(port: SerialPortLike): Promise<void> {
        const device = deviceOf(port);
        if (!device) {
            // only reachable from a granted port that is not a pack; the picker cannot offer one
            throw new Error('Not a Rumble Pack');
        }
        await this.close();
        await port.open(WebSerialRumblePack.LINE);
        this.port = port;
        this.writer = port.writable?.getWriter();
        this.reading = true;
        this.read(port).catch(() => this.close());
        this.attached(device);
    }

    // whole lines are SerialRumblePack's business, so this only decodes bytes to text
    protected async read(port: SerialPortLike): Promise<void> {
        const decoder = new TextDecoder();
        while (this.reading && port.readable) {
            const reader = port.readable.getReader();
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    if (value) {
                        this.receive(decoder.decode(value, { stream: true }));
                    }
                }
            } finally {
                try {
                    reader.releaseLock();
                } catch {
                    // unplugged mid-read; the loop ends either way
                }
            }
        }
    }

    protected async close(): Promise<void> {
        this.reading = false;
        const port = this.port;
        this.port = undefined;
        try {
            this.writer?.releaseLock();
        } catch {
            // already gone with the device
        }
        this.writer = undefined;
        this.detached();
        await port?.close().catch(() => undefined);
    }

    protected override async write(text: string): Promise<void> {
        if (!this.writer) {
            return;
        }
        try {
            await this.writer.write(new TextEncoder().encode(text));
        } catch {
            // written while it was being unplugged
            await this.close();
        }
    }
}

function deviceOf(port: SerialPortLike): RumblePackDevice | undefined {
    const info = port.getInfo();
    const name = rumblePackName(info.usbVendorId, info.usbProductId);
    return name === undefined
        ? undefined
        : { name, vendor: info.usbVendorId ?? 0, product: info.usbProductId ?? 0 };
}

function serialApi(): SerialLike | undefined {
    return (navigator as unknown as { serial?: SerialLike }).serial;
}

// declared rather than depended on, as the API is not in TypeScript's DOM library and @types/w3c-web-serial would be a
// package for four method signatures

interface SerialLike extends EventTarget {
    getPorts(): Promise<SerialPortLike[]>;
    requestPort(options?: {
        filters?: { usbVendorId?: number, usbProductId?: number }[],
    }): Promise<SerialPortLike>;
}

interface SerialPortLike {
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    getInfo(): { usbVendorId?: number, usbProductId?: number };
    open(options: {
        baudRate: number,
        dataBits?: number,
        stopBits?: number,
        parity?: string,
        flowControl?: string,
    }): Promise<void>;
    close(): Promise<void>;
}
