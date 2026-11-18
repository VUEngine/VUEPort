import { Emitter, Event } from '../common/emulator-events';
import {
    ScanDataType,
    ScanOperator,
    readScanValue,
    scanFirst,
    scanNext,
    scanValueBytes,
} from '../common/emulator-cheat-scan';
import { VB_CART_RAM_BASE, VB_WRAM_BASE } from '../common/vb-constants';
import { Sim } from './core/vb-core';

// only the writable regions: ROM never changes and the hardware registers are not variables
export enum CheatScanRegion {
    WRAM = 'wram',
    CART_RAM = 'cartRam',
}

export const CHEAT_SCAN_REGIONS: CheatScanRegion[] = [CheatScanRegion.WRAM, CheatScanRegion.CART_RAM];

// WRAM is the whole of region 5 with 64 KB mirrored across it; this is one copy
const WRAM_LENGTH = 0x10000;

export interface CheatScanResult {
    // a real CPU address, so a cheat can be written straight from it
    address: number;
    value: number;
    previous: number;
}

// lives beside the cheat store rather than in the Cheats panel, so a search survives closing the panel (but not
// the ROM). Memory is only read on a Scan press and by a slow refresh timer while the panel is open
export class CheatFinder {

    protected sim: Sim | undefined;
    // set during a link session, as a poke must land in both windows on the same frame. Returns false if that
    // can't be arranged, then the write goes straight in, as when playing alone
    protected writer: ((address: number, bytes: number[]) => boolean) | undefined;

    protected region = CheatScanRegion.WRAM;
    protected type = ScanDataType.U16;

    // snapshot from the last Scan press that the candidates were judged against; undefined before the first pass
    protected baseline: Uint8Array | undefined;
    protected current: Uint8Array | undefined;
    protected cartRamBytes?: number; // fixed at the first pass for the whole search, see `read`

    // surviving offsets into the region, undefined before a first pass
    protected candidates: Uint32Array | undefined;
    // every candidate set so far, newest last, so undo can recover from a pass that narrowed to nothing
    protected history: Uint32Array[] = [];
    protected working = false;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    // set from the widget as a ROM starts and stops; the search is thrown away with the machine it was made on
    setSim(sim: Sim | undefined): void {
        this.sim = sim;
        this.reset();
    }

    setWriter(writer: ((address: number, bytes: number[]) => boolean) | undefined): void {
        this.writer = writer;
    }

    get hasSim(): boolean {
        return this.sim !== undefined;
    }

    get busy(): boolean {
        return this.working;
    }

    get scanRegion(): CheatScanRegion {
        return this.region;
    }

    get dataType(): ScanDataType {
        return this.type;
    }

    get started(): boolean {
        return this.candidates !== undefined;
    }

    get count(): number {
        return this.candidates?.length ?? 0;
    }

    get canUndo(): boolean {
        return this.history.length > 0;
    }

    // both throw the search away, as an offset found as a halfword or in WRAM means nothing as bytes or in
    // the cartridge save
    setRegion(region: CheatScanRegion): void {
        if (region === this.region) {
            return;
        }
        this.region = region;
        this.reset();
    }

    setDataType(type: ScanDataType): void {
        if (type === this.type) {
            return;
        }
        this.type = type;
        this.reset();
    }

    reset(): void {
        this.baseline = undefined;
        this.current = undefined;
        this.cartRamBytes = undefined;
        this.candidates = undefined;
        this.history = [];
        this.changed();
    }

    undo(): void {
        const previous = this.history.pop();
        if (previous) {
            this.candidates = previous;
            this.changed();
        }
    }

    // a relative operator without a value keeps everything, which is how a search for an unreadable number
    // starts (see `emulator-cheat-scan.ts`)
    async first(op: ScanOperator, value?: number): Promise<void> {
        await this.pass(async snapshot => {
            this.history = [];
            this.candidates = scanFirst(snapshot, this.type, op, value);
        });
    }

    async next(op: ScanOperator, value?: number): Promise<void> {
        const candidates = this.candidates;
        const baseline = this.baseline;
        if (!candidates || !baseline) {
            return this.first(op, value);
        }
        await this.pass(async snapshot => {
            this.history.push(candidates);
            this.candidates = scanNext(candidates, baseline, snapshot, this.type, op, value);
        });
    }

    // for the panel's timer. Leaves the baseline alone, as "unchanged" means since the last pass, not since a
    // moment ago
    async refreshValues(): Promise<void> {
        const snapshot = await this.read();
        if (snapshot) {
            this.current = snapshot;
            this.changed();
        }
    }

    // a one-off write to test a candidate; the game may overwrite it on the next frame
    async poke(address: number, value: number): Promise<void> {
        const sim = this.sim;
        if (!sim) {
            return;
        }
        const width = scanValueBytes(this.type);
        const bytes: number[] = [];
        for (let i = 0; i < width; i++) {
            bytes.push((value >>> (i * 8)) & 0xff);
        }
        if (!this.writer?.(address >>> 0, bytes)) {
            await sim.writeMemory(address >>> 0, new Uint8Array(bytes).buffer);
        }
        // under a link session the write is booked a few frames out and the panel's polling picks it up later;
        // this makes a solo poke visible at once
        await this.refreshValues();
    }

    // capped, as a first pass over 64 KB can leave every address in the running; `count` has the real number
    results(limit: number): CheatScanResult[] {
        const candidates = this.candidates;
        const current = this.current;
        if (!candidates || !current) {
            return [];
        }
        const base = this.regionBase();
        const baseline = this.baseline ?? current;
        const shown = Math.min(limit, candidates.length);
        const results: CheatScanResult[] = [];
        for (let i = 0; i < shown; i++) {
            const offset = candidates[i];
            results.push({
                address: (base + offset) >>> 0,
                value: readScanValue(current, offset, this.type),
                previous: readScanValue(baseline, offset, this.type),
            });
        }
        return results;
    }

    get cheatDigits(): number {
        return scanValueBytes(this.type) * 2;
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }

    protected regionBase(): number {
        return this.region === CheatScanRegion.WRAM ? VB_WRAM_BASE : VB_CART_RAM_BASE;
    }

    // the baseline moves here and nowhere else, so relative questions cover the interval between two Scans
    protected async pass(judge: (snapshot: Uint8Array) => Promise<void>): Promise<void> {
        if (this.working) {
            return;
        }
        this.working = true;
        this.changed();
        try {
            const snapshot = await this.read();
            if (!snapshot) {
                return;
            }
            await judge(snapshot);
            this.baseline = snapshot;
            this.current = snapshot;
        } finally {
            this.working = false;
            this.changed();
        }
    }

    // undefined rather than a throw when there is no machine, as the screen can be closed under the panel
    protected async read(): Promise<Uint8Array | undefined> {
        const sim = this.sim;
        if (!sim) {
            return undefined;
        }
        try {
            if (this.region === CheatScanRegion.CART_RAM) {
                // the save window is the whole 16 MiB of Game Pak RAM, so the search only covers up to the high-water
                // mark the game has written. Fixed for the whole search, as passes compare offset against offset; a game
                // writing higher mid-search needs a new search
                if (this.cartRamBytes === undefined) {
                    this.cartRamBytes = (await sim.cartRamInfo()).used;
                }
                return new Uint8Array(await sim.getCartRam(this.cartRamBytes));
            }
            return new Uint8Array(await sim.readMemory(VB_WRAM_BASE, WRAM_LENGTH));
        } catch {
            // the core went away while reading
            return undefined;
        }
    }

    protected changed(): void {
        this.onDidChangeEmitter.fire();
    }
}
