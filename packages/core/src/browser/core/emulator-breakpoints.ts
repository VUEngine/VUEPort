import { Disposable, Emitter, Event } from '../../common/emulator-events';
import { VesLineTable } from './emulator-line-table';

// shared by the Disassembly panel's gutter and a host with editors (VUEngine Studio) that sets breakpoints on source
// lines. Keyed by address, as that is what the machine stops at; one set from a line remembers it, and
// VesBreakpoints.reresolve carries it across a rebuild

export interface VesBreakpointOrigin {
    file: string; // as the line table names it, which is the file the compiler read
    line: number;
}

export interface VesBreakpoint {
    address: number;
    enabled: boolean;
    origin?: VesBreakpointOrigin;
}

export interface VesLineBreakpoint {
    line: number;
    enabled?: boolean; // undefined means enabled
}

export class VesBreakpoints implements Disposable {

    protected readonly points = new Map<number, VesBreakpoint>();
    protected readonly onDidChangeEmitter = new Emitter<void>();

    // once per change rather than per breakpoint, as both listeners redraw or re-send the whole set
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    all(): VesBreakpoint[] {
        return [...this.points.values()].sort((a, b) => a.address - b.address);
    }

    at(address: number): VesBreakpoint | undefined {
        return this.points.get(address >>> 0);
    }

    armed(): number[] {
        return this.all().filter(point => point.enabled).map(point => point.address);
    }

    has(address: number): boolean {
        return this.points.has(address >>> 0);
    }

    // leaves an existing one alone, so a host re-sending its editor breakpoints cannot re-enable one disabled in the
    // gutter
    add(address: number, origin?: VesBreakpointOrigin): void {
        const at = address >>> 0;
        if (this.points.has(at)) {
            return;
        }
        this.points.set(at, { address: at, enabled: true, origin });
        this.onDidChangeEmitter.fire();
    }

    remove(address: number): void {
        if (this.points.delete(address >>> 0)) {
            this.onDidChangeEmitter.fire();
        }
    }

    toggle(address: number, origin?: VesBreakpointOrigin): void {
        const at = address >>> 0;
        if (this.points.delete(at)) {
            this.onDidChangeEmitter.fire();
            return;
        }
        this.add(at, origin);
    }

    setEnabled(address: number, enabled: boolean): void {
        const point = this.points.get(address >>> 0);
        if (point === undefined || point.enabled === enabled) {
            return;
        }
        point.enabled = enabled;
        this.onDidChangeEmitter.fire();
    }

    clear(): void {
        if (this.points.size === 0) {
            return;
        }
        this.points.clear();
        this.onDidChangeEmitter.fire();
    }

    // takes all of a file's breakpoints, so anything held for that file and not sent again is removed; other files' and
    // address-set ones are left alone. A line without code resolves to the next one that has some
    // (VesLineTable.resolve), so two lines can collapse into one breakpoint
    setForFile(file: string, lines: VesLineBreakpoint[], table: VesLineTable): void {
        let changed = false;

        for (const [address, point] of [...this.points]) {
            if (point.origin?.file === file) {
                this.points.delete(address);
                changed = true;
            }
        }

        for (const wanted of lines) {
            const found = table.resolve(file, wanted.line);
            if (found === undefined) {
                continue;
            }
            const address = addressOf(found.offset);
            const existing = this.points.get(address);
            if (existing !== undefined && existing.origin === undefined) {
                continue; // set by hand in the gutter, which wins
            }
            this.points.set(address, {
                address,
                enabled: wanted.enabled !== false,
                origin: { file, line: found.line },
            });
            changed = true;
        }

        if (changed) {
            this.onDidChangeEmitter.fire();
        }
    }

    // for a rebuild, where the source did not move but the code did. Address-set breakpoints are left alone, as only
    // the user who typed one knows what it meant
    reresolve(table: VesLineTable): void {
        let changed = false;
        for (const point of this.all()) {
            const origin = point.origin;
            if (origin === undefined) {
                continue;
            }
            const found = table.resolve(origin.file, origin.line);
            const address = found === undefined ? undefined : addressOf(found.offset);
            if (address === undefined || address === point.address) {
                continue;
            }
            this.points.delete(point.address);
            this.points.set(address, { ...point, address, origin: { ...origin, line: found!.line } });
            changed = true;
        }
        if (changed) {
            this.onDidChangeEmitter.fire();
        }
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}

const CART_WINDOW_BASE = 0x07000000;

// the same code is also reachable through the mirror at the top of memory, where the machine boots, but measured
// over 400 frames of a real game every PC was in 0x07xxxxxx; only the vectors use the mirror
function addressOf(offset: number): number {
    return (CART_WINDOW_BASE + offset) >>> 0;
}
