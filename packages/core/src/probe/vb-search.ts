import {
    readScanValue, SCAN_DATA_TYPES, SCAN_OPERATORS, ScanDataType, scanFirst, scanNext, ScanOperator, scanOperatorNeedsValue,
} from '../common/emulator-cheat-scan';
import { fromBase64, toBase64 } from './vb-bytes';
import { VbMachine } from './vb-machine';

// finding where a game keeps a value: scan a region, let the game change the value, keep the addresses that
// changed the same way, repeat (the app's Cheat Finder, for a script). A search is data, so vbprobe search can
// write it to a file between steps

// regions by name: where a game's own variables are
const REGIONS: Record<string, { address: number, length: (vb: VbMachine) => number }> = {
    wram: { address: 0x05000000, length: vb => (wramIsWide(vb) ? 0x40000 : 0x10000) },
    sram: { address: 0x06000000, length: vb => Math.max(0x2000, vb.sram().length) },
};

function wramIsWide(vb: VbMachine): boolean {
    return vb.vbc && (vb.read16(0x0307f812) & 1) !== 0;
}

export interface VbSearchState {
    version: 1;
    address: number;
    type: ScanDataType;
    previous: string; // the region as it was at the last step, base64
    candidates: string; // the offsets still in the running, little-endian 32-bit, base64
    steps: number;
}

export interface VbSearchCandidate {
    address: number;
    value: number;
    previous: number;
}

export class VbSearch {

    protected constructor(
        readonly address: number,
        readonly type: ScanDataType,
        protected previous: Uint8Array,
        protected offsets: Uint32Array,
        public steps: number,
    ) { }

    // region is wram, sram, or 0x05000000:0x1000; keeps every address, or only those already answering op
    static start(vb: VbMachine, region: string, type: ScanDataType = ScanDataType.U8, op?: ScanOperator, value?: number): VbSearch {
        checkType(type);
        const { address, length } = regionOf(vb, region);
        const snapshot = vb.read(address, length);
        const offsets = scanFirst(snapshot, type, op ?? 'unchanged', checkValue(op, value));
        return new VbSearch(address, type, snapshot, offsets, 1);
    }

    static fromState(state: VbSearchState): VbSearch {
        if (state.version !== 1) {
            throw new Error('That is not a search this version of vbprobe wrote.');
        }
        checkType(state.type);
        const bytes = fromBase64(state.candidates);
        return new VbSearch(
            state.address, state.type, fromBase64(state.previous),
            new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice(), state.steps);
    }

    // keep the addresses whose value, since the last step, answers op
    next(vb: VbMachine, op: ScanOperator, value?: number): void {
        if (!SCAN_OPERATORS.includes(op)) {
            throw new Error(`"${op}" is not a comparison; there are ${SCAN_OPERATORS.join(', ')}.`);
        }
        const current = vb.read(this.address, this.previous.length);
        this.offsets = scanNext(this.offsets, this.previous, current, this.type, op, checkValue(op, value));
        this.previous = current;
        this.steps++;
    }

    get count(): number {
        return this.offsets.length;
    }

    // the first limit addresses still in the running, with their values now and at the last step
    candidates(vb: VbMachine, limit = 20): VbSearchCandidate[] {
        const current = vb.read(this.address, this.previous.length);
        return [...this.offsets.subarray(0, limit)].map(offset => ({
            address: (this.address + offset) >>> 0,
            value: readScanValue(current, offset, this.type),
            previous: readScanValue(this.previous, offset, this.type),
        }));
    }

    toState(): VbSearchState {
        return {
            version: 1,
            address: this.address,
            type: this.type,
            previous: toBase64(this.previous),
            candidates: toBase64(new Uint8Array(this.offsets.buffer, this.offsets.byteOffset, this.offsets.byteLength)),
            steps: this.steps,
        };
    }
}

function regionOf(vb: VbMachine, region: string): { address: number, length: number } {
    const named = REGIONS[region.toLowerCase()];
    if (named) {
        return { address: named.address, length: named.length(vb) };
    }
    const match = /^(.+):(0x[0-9a-f]+|\d+)$/i.exec(region);
    if (!match) {
        throw new Error(`Search ${Object.keys(REGIONS).join(' or ')}, or a range as start:length, not "${region}".`);
    }
    const length = Number(match[2]);
    if (length < 1 || length > 0x100000) {
        throw new Error('A searched range is 1 byte to 1 MiB.');
    }
    return { address: vb.resolve(match[1]), length };
}

function checkType(type: ScanDataType): void {
    if (!SCAN_DATA_TYPES.includes(type)) {
        throw new Error(`"${type}" is not a type; there are ${SCAN_DATA_TYPES.join(', ')}.`);
    }
}

function checkValue(op: ScanOperator | undefined, value: number | undefined): number | undefined {
    if (op !== undefined && scanOperatorNeedsValue(op) && value === undefined) {
        throw new Error(`${op} needs a value to compare with.`);
    }
    return value;
}
