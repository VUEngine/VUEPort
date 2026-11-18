// data written, data read, either, or code run
export type VbWatchKind = 'write' | 'read' | 'access' | 'exec';

// an address, a name, or a start and a length in bytes
export type VbWatchTarget = number | string | [number | string, number];

export interface VbWatchSpec {
    kind: VbWatchKind;
    // a bare number is one byte; a name is as big as the build says (all of `g_stats`, or `g_stats.lives`).
    // For `exec`, a function's name is its entry, so a hit is a call; give a length to watch more
    at: VbWatchTarget;
    // only hits that satisfy all of these count
    when?: {
        value?: number | [number, number]; // value written or read: exactly, or within [min, max]
        changed?: boolean; // writes that change what was there
        pc?: VbWatchTarget; // only from this code: an address, a range, or a function's name for all of it
        frames?: [number, number]; // only in these frames, both included
    };
    action?: 'log' | 'stop'; // log the hit and go on (default), or stop the machine on it
    // `regs` for all program registers, any register by name (`r6`, `sp`, `lp`), `stack` for the call stack
    capture?: string[];
    limit?: number; // hits kept in VbWatch.hits; counting goes on past it. Default 1000
    test?: (hit: VbWatchHit) => boolean; // a last say on each hit, for what the fields above cannot express
    // runs on each hit once the core has returned and the machine can be changed (registers, memory), before
    // a stop. At `exec` it runs before the instruction; at an access, mid-instruction, which finishes after
    then?: (hit: VbWatchHit) => void;
    // also fold hits by place: the key of the place an address is in (a frame buffer column, a block of
    // bytes). See VbWatch.places
    fold?: (address: number) => number;
}

export interface VbWatchHit {
    watch: number;
    kind: 'write' | 'read' | 'exec';
    frame: number;
    pc: number; // instruction that made the access, or the one about to run
    address: number;
    size: number; // bytes the access covered: 1, 2 or 4; zero for `exec`
    value?: number;
    old?: number; // value before a write
    regs?: Record<string, number>;
    stack?: number[]; // call sites, innermost first; see VbMachine.callStack
}

// hits from one instruction, folded together
export interface VbWatchGroup {
    pc: number;
    count: number;
    firstFrame: number;
    lastFrame: number;
    values?: [number, number]; // smallest and largest value seen, where there were values
    addresses: [number, number]; // lowest and highest address touched
}

// hits on one place, as VbWatchSpec.fold cuts memory up
export interface VbWatchPlace {
    key: number;
    count: number;
    firstFrame: number;
    lastFrame: number;
    addresses: [number, number]; // lowest and highest address touched
    pcs: { pc: number, count: number }[]; // instructions that made the hits, with counts, busiest first
}

// made and fed by VbMachine.watch. The hit list stops at the limit so a busy watch cannot eat the heap;
// groups (one per instruction) never do, and answer "who writes here" for a watch fired 100 000 times
export class VbWatch {

    readonly hits: VbWatchHit[] = [];
    count = 0; // every hit, including those past the limit
    disposed = false;

    protected readonly groups = new Map<number, VbWatchGroup>();
    protected readonly placeMap = new Map<number, Omit<VbWatchPlace, 'pcs'> & { pcs: Map<number, number> }>();

    start: number; // first byte covered, after mirrors are folded
    end: number; // one past the last byte covered

    constructor(
        readonly id: number,
        readonly spec: VbWatchSpec,
        // first byte as given, with only the CPU's 27 address bits
        readonly origin: number,
        readonly length: number,
        // range the hits have to come from, if limited
        readonly pcRange?: [number, number],
    ) {
        this.start = origin;
        this.end = origin + length;
    }

    // internal: fold the range again for memory whose mirrors have changed
    fold(canonical: (address: number) => number): void {
        this.start = canonical(this.origin);
        this.end = this.start + this.length;
    }

    get limit(): number {
        return this.spec.limit ?? 1000;
    }

    get stops(): boolean {
        return this.spec.action === 'stop';
    }

    covers(kind: 'write' | 'read' | 'exec'): boolean {
        return this.spec.kind === kind || (this.spec.kind === 'access' && kind !== 'exec');
    }

    // conditions that do not need the value
    accepts(frame: number, pc: number): boolean {
        const frames = this.spec.when?.frames;
        if (frames && (frame < frames[0] || frame > frames[1])) {
            return false;
        }
        return !this.pcRange || (pc >= this.pcRange[0] && pc < this.pcRange[1]);
    }

    acceptsValue(value: number | undefined, old: number | undefined): boolean {
        const when = this.spec.when;
        if (when?.changed && value === old) {
            return false;
        }
        const wanted = when?.value;
        if (wanted === undefined || value === undefined) {
            return true;
        }
        return typeof wanted === 'number' ? value === wanted >>> 0 : value >= wanted[0] && value <= wanted[1];
    }

    // internal
    record(hit: VbWatchHit): void {
        this.count++;
        if (this.hits.length < this.limit) {
            this.hits.push(hit);
        }
        let group = this.groups.get(hit.pc);
        if (!group) {
            group = { pc: hit.pc, count: 0, firstFrame: hit.frame, lastFrame: hit.frame, addresses: [hit.address, hit.address] };
            this.groups.set(hit.pc, group);
        }
        group.count++;
        group.lastFrame = hit.frame;
        group.addresses[0] = Math.min(group.addresses[0], hit.address);
        group.addresses[1] = Math.max(group.addresses[1], hit.address);
        if (hit.value !== undefined) {
            group.values = group.values
                ? [Math.min(group.values[0], hit.value), Math.max(group.values[1], hit.value)]
                : [hit.value, hit.value];
        }
        if (this.spec.fold) {
            const key = this.spec.fold(hit.address);
            let place = this.placeMap.get(key);
            if (!place) {
                place = { key, count: 0, firstFrame: hit.frame, lastFrame: hit.frame, addresses: [hit.address, hit.address], pcs: new Map() };
                this.placeMap.set(key, place);
            }
            place.count++;
            place.lastFrame = hit.frame;
            place.addresses[0] = Math.min(place.addresses[0], hit.address);
            place.addresses[1] = Math.max(place.addresses[1], hit.address + Math.max(0, hit.size - 1));
            place.pcs.set(hit.pc, (place.pcs.get(hit.pc) ?? 0) + 1);
        }
    }

    // folded by instruction, busiest first
    summary(): VbWatchGroup[] {
        return [...this.groups.values()]
            .map(group => ({ ...group, addresses: [...group.addresses] as [number, number] }))
            .sort((a, b) => b.count - a.count || a.pc - b.pc);
    }

    // folded by place, in key order; only with VbWatchSpec.fold
    places(): VbWatchPlace[] {
        return [...this.placeMap.values()]
            .sort((a, b) => a.key - b.key)
            .map(place => ({
                ...place,
                addresses: [...place.addresses] as [number, number],
                pcs: [...place.pcs].map(([pc, count]) => ({ pc, count })).sort((a, b) => b.count - a.count || a.pc - b.pc),
            }));
    }

    clear(): void {
        this.hits.length = 0;
        this.count = 0;
        this.groups.clear();
        this.placeMap.clear();
    }
}
