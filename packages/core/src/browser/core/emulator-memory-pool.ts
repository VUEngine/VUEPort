/**
 * VUEngine's MemoryPool, the engine's whole dynamic allocator, is a fixed set of pools of equally sized blocks in one
 * singleton struct in WRAM. Pool count and sizes are per project (__MEMORY_POOLS and __MEMORY_POOL_ARRAYS in Config.h),
 * so the struct is read whole and made to describe itself via its bookkeeping arrays, which hold the pools' own
 * addresses. See parseMemoryPoolLayout.
 */

/**
 * The MemoryPool singleton as __SINGLETON lays it out:
 * +0     objectMemoryFootprint  uint32
 * +4     vTable                 uint32     <- the instance starts here
 * +8     the pools themselves   uint8[]    <- __MEMORY_POOL_ARRAYS
 *        poolLocation           uint8*[N]
 *        poolSizes              uint16[N][2]
 *        poolLastFreeBlock      uint8*[N]
 *        poolOverflows          uint8[N]
 */
const POOLS_OFFSET = 8;

// MemoryPool::allocate's four-byte header plus a vTable pointer
const MIN_BLOCK_BYTES = 8;

// __NEW asks for sizeof(ClassName_str) + __DYNAMIC_STRUCT_PAD, so an object has this much less than its block to fit in
export const BLOCK_HEADER_BYTES = 4;

const INSTANCE_VTABLE_OFFSET = 4;

const MEMORY_POOL_CLASS = 'MemoryPool';

export interface VesMemoryPool {
    address: number;
    blockSize: number;
    poolSize: number;
    blocks: number;
    // how often the engine fell back to a larger pool. A uint8 the engine never clears, so it can wrap: read a high
    // value as "overflowing", not as a count
    overflows: number;
}

export interface VesMemoryPoolLayout {
    base: number; // address of the singleton wrapper
    pools: VesMemoryPool[];
    totalBytes: number;
    instanceVTable: number; // as the running machine has it, see symbolsMatchRunningBuild
}

export interface VesMemoryPoolUsage {
    usedBlocks: number;
    usedBytes: number;
    classes: VesMemoryPoolOccupant[]; // most numerous first
    unidentified: number; // matching no known vTable, which includes all plain __NEW_BASIC structs
}

export interface VesMemoryPoolOccupant {
    name: string;
    count: number;
}

/**
 * Recovers how a build carved up its heap from the struct's own contents. MemoryPool::reset points poolLocation[0] at
 * the first block, the word right after the struct header, so the bookkeeping arrays are found by looking for that
 * address. The pool count follows from the bytes left (12N plus N padded to a word), and the reading has to agree with
 * itself: adjacent pools, whole numbers of blocks, together filling the space ahead of the arrays. A candidate that
 * fails is a coincidence in block data, and the scan moves on.
 *
 * Undefined for a struct that describes nothing yet, the normal state before MemoryPool::reset ran, so not an error.
 * `base` is the address of the singleton wrapper, `region` the whole wrapper as the linker sized it.
 */
export function parseMemoryPoolLayout(base: number, region: Uint8Array): VesMemoryPoolLayout | undefined {
    if (region.byteLength < POOLS_OFFSET + MIN_BLOCK_BYTES) {
        return undefined;
    }
    const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
    const firstBlock = (base + POOLS_OFFSET) >>> 0;

    for (let at = POOLS_OFFSET; at + 4 <= region.byteLength; at += 4) {
        if (view.getUint32(at, true) !== firstBlock) {
            continue;
        }
        const layout = readLayoutAt(base, view, at);
        if (layout) {
            return layout;
        }
    }
    return undefined;
}

function readLayoutAt(base: number, view: DataView, at: number): VesMemoryPoolLayout | undefined {
    const count = countPools(view.byteLength - at);
    if (count === undefined) {
        return undefined;
    }

    const locations = at;
    const sizes = locations + 4 * count;
    const lastFreeBlocks = sizes + 4 * count;
    const overflows = lastFreeBlocks + 4 * count;
    if (overflows + count > view.byteLength) {
        return undefined;
    }

    const pools: VesMemoryPool[] = [];
    let expected = (base + POOLS_OFFSET) >>> 0;
    let totalBytes = 0;

    for (let pool = 0; pool < count; pool++) {
        // pools are laid out back to back, so each has to start exactly where the last one ended
        const address = view.getUint32(locations + 4 * pool, true) >>> 0;
        if (address !== expected) {
            return undefined;
        }

        // enum MemoryPoolSizes: ePoolSize first, then eBlockSize
        const poolSize = view.getUint16(sizes + 4 * pool, true);
        const blockSize = view.getUint16(sizes + 4 * pool + 2, true);
        if (blockSize < MIN_BLOCK_BYTES || poolSize < blockSize || poolSize % blockSize !== 0) {
            return undefined;
        }

        // only a search hint for the engine, but it always points into its own pool
        const lastFreeBlock = view.getUint32(lastFreeBlocks + 4 * pool, true) >>> 0;
        if (lastFreeBlock < address || lastFreeBlock >= address + poolSize) {
            return undefined;
        }

        pools.push({
            address,
            blockSize,
            poolSize,
            blocks: poolSize / blockSize,
            overflows: view.getUint8(overflows + pool),
        });
        expected = (address + poolSize) >>> 0;
        totalBytes += poolSize;
    }

    // the pools have to fill everything between the header and the arrays, give or take the word alignment padding
    const span = at - POOLS_OFFSET;
    if (totalBytes > span || span - totalBytes >= 4) {
        return undefined;
    }

    return {
        base,
        pools,
        totalBytes,
        instanceVTable: view.getUint32(INSTANCE_VTABLE_OFFSET, true) >>> 0,
    };
}

/**
 * The .elf beside the ROM may not be the running build (not reloaded after a rebuild, a ROM copied over older output).
 * Wrong pool addresses make parseMemoryPoolLayout fail, but a moved vTable still lands on some class, naming the wrong
 * one silently. The singleton's own vTable must be MemoryPool's; if the symbols disagree about that one address, every
 * other name is suspect too.
 */
export function symbolsMatchRunningBuild(
    layout: VesMemoryPoolLayout, vTables: Map<number, string>
): boolean {
    return vTables.get(layout.instanceVTable) === MEMORY_POOL_CLASS;
}

// the same check on the raw bytes, for when the parse failed: tells an uninitialized struct, which clears once the
// game boots, from a wrong address, which never does
export function describesMemoryPool(region: Uint8Array, vTables: Map<number, string>): boolean {
    if (region.byteLength < INSTANCE_VTABLE_OFFSET + 4) {
        return false;
    }
    const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
    return vTables.get(view.getUint32(INSTANCE_VTABLE_OFFSET, true) >>> 0) === MEMORY_POOL_CLASS;
}

// the arrays come to 12N bytes plus poolOverflows' N padded to a word, which only grows with N, so at most one fits
function countPools(bytes: number): number | undefined {
    for (let count = 1; 13 * count <= bytes; count++) {
        if (12 * count + ((count + 3) & ~3) === bytes) {
            return count;
        }
    }
    return undefined;
}

/**
 * MemoryPool::allocate stamps a block's first halfword with __MEMORY_USED_BLOCK_FLAG and the next with its pool, and
 * MemoryPool::free resets the word to __MEMORY_FREE_BLOCK_FLAG (zero), so non-zero means occupied, the same test as
 * MemoryPool::printDetailedUsage. The object starts behind the header (__NEW hands out block + __DYNAMIC_STRUCT_PAD)
 * with its vTable pointer, which names the class. Only exact matches count, as __NEW_BASIC structs hold plain data
 * there. `region` is read from layout.base; `vTables` maps vTable addresses to class names from the ROM's symbols.
 */
export function readMemoryPoolUsage(
    layout: VesMemoryPoolLayout,
    region: Uint8Array,
    vTables: Map<number, string>
): VesMemoryPoolUsage[] {
    const view = new DataView(region.buffer, region.byteOffset, region.byteLength);

    return layout.pools.map(pool => {
        const counts = new Map<string, number>();
        let usedBlocks = 0;
        let unidentified = 0;
        const start = pool.address - layout.base;

        for (let block = 0; block < pool.blocks; block++) {
            const at = start + block * pool.blockSize;
            if (at < 0 || at + BLOCK_HEADER_BYTES + 4 > view.byteLength) {
                break;
            }
            if (view.getUint32(at, true) === 0) {
                continue;
            }
            usedBlocks++;

            const name = vTables.get(view.getUint32(at + BLOCK_HEADER_BYTES, true) >>> 0);
            if (name === undefined) {
                unidentified++;
            } else {
                counts.set(name, (counts.get(name) ?? 0) + 1);
            }
        }

        return {
            usedBlocks,
            usedBytes: usedBlocks * pool.blockSize,
            unidentified,
            classes: [...counts]
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        };
    });
}

export interface VesMemoryPoolBlock {
    address: number; // header included
    objectAddress: number;
    objectOffset: number; // within the region the layout was read from
    vTable: number;
    blockSize: number; // what the object costs, whatever its own size
}

// in pool order
export function readMemoryPoolBlocks(layout: VesMemoryPoolLayout, region: Uint8Array): VesMemoryPoolBlock[] {
    const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
    const blocks: VesMemoryPoolBlock[] = [];

    for (const pool of layout.pools) {
        const start = pool.address - layout.base;
        for (let block = 0; block < pool.blocks; block++) {
            const at = start + block * pool.blockSize;
            if (at < 0 || at + BLOCK_HEADER_BYTES + 4 > view.byteLength) {
                break;
            }
            if (view.getUint32(at, true) === 0) {
                continue;
            }
            blocks.push({
                address: (pool.address + block * pool.blockSize) >>> 0,
                objectAddress: (pool.address + block * pool.blockSize + BLOCK_HEADER_BYTES) >>> 0,
                objectOffset: at + BLOCK_HEADER_BYTES,
                vTable: view.getUint32(at + BLOCK_HEADER_BYTES, true) >>> 0,
                blockSize: pool.blockSize,
            });
        }
    }
    return blocks;
}
