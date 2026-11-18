import { Sim } from '../core/vb-core';
import {
    sameVipBytes,
    VIP_BGMAP_BYTES,
    VIP_BGMAP_COUNT,
    VIP_WORLD_COUNT,
    vipBgMapAddress,
    vipParamTableAddress,
    vipParamTableBytes,
    VipWorld,
    VipWorldMode,
    vipOverplaneSegment,
} from './emulator-vip-memory';

// fade and gray-out of the worlds around the one in a Context preview, same as the filtered-out characters
// in the Characters panel. Gray too, so a neighbouring world and a dark part of the subject do not share a scale
export const VIP_CONTEXT_FACTOR = 0.18;

// the BGMap segments and param tables a set of worlds maps from, for the Worlds and Objects Context previews.
// OBJECT worlds draw from OAM, which each panel reads itself
export class VipWorldSources {

    // indexed by absolute BGMap segment; only the ones the worlds span are read
    bgMapSegments: (Uint8Array | undefined)[] = [];
    paramTables: (Uint8Array | undefined)[] = [];

    clear(): void {
        this.bgMapSegments = [];
        this.paramTables = [];
    }

    async read(sim: Sim, sources: readonly VipWorld[]): Promise<boolean> {
        const worlds = sources.filter(world => world.mode !== VipWorldMode.OBJECT);
        let changed = false;

        const needed = [...new Set(worlds.flatMap(world => VipWorldSources.worldSegments(world)))];
        const maps = await Promise.all(needed.map(segment => sim.readMemory(vipBgMapAddress(segment), VIP_BGMAP_BYTES)));
        const bgMapSegments: (Uint8Array | undefined)[] = [];
        needed.forEach((segment, index) => {
            const bytes = new Uint8Array(maps[index]);
            if (!sameVipBytes(bytes, this.bgMapSegments[segment])) {
                changed = true;
            }
            bgMapSegments[segment] = bytes;
        });
        this.bgMapSegments = bgMapSegments;

        const tables: (Uint8Array | undefined)[] = [];
        await Promise.all(worlds.map(async world => {
            const length = vipParamTableBytes(world);
            if (length > 0) {
                tables[world.index] = new Uint8Array(
                    await sim.readMemory(vipParamTableAddress(world.param), length)
                );
            }
        }));
        if (!VipWorldSources.sameParamTables(tables, this.paramTables)) {
            changed = true;
        }
        this.paramTables = tables;

        return changed;
    }

    params(index: number): DataView | undefined {
        const bytes = this.paramTables[index];
        return bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined;
    }

    protected static sameParamTables(
        a: ReadonlyArray<Uint8Array | undefined>, b: ReadonlyArray<Uint8Array | undefined>
    ): boolean {
        for (let index = 0; index < VIP_WORLD_COUNT; index++) {
            if (!a[index] !== !b[index]) {
                return false;
            }
            if (a[index] && !sameVipBytes(a[index], b[index])) {
                return false;
            }
        }
        return true;
    }

    // scx across then scy down from the base segment. Segments 14 and 15 hold world attribute and object memory,
    // not map data, so they are dropped
    protected static worldSegments(world: VipWorld): number[] {
        const count = Math.min(world.scx * world.scy, VIP_BGMAP_COUNT);
        const segments = new Set<number>();
        for (let index = 0; index < count; index++) {
            const segment = (world.bgMap + index) & 0x0f;
            if (segment < VIP_BGMAP_COUNT) {
                segments.add(segment);
            }
        }
        // and the overplane cell's, which can lie outside the map
        if (world.overplane && vipOverplaneSegment(world) < VIP_BGMAP_COUNT) {
            segments.add(vipOverplaneSegment(world));
        }
        return [...segments];
    }
}
