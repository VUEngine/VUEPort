// a plain ROM carries no symbols, so every frame is labeled by its address. The studio does the same with symbols,
// sharing `toFirefoxProfile` from the core

import {
    toFirefoxProfile,
    VesFirefoxProfile,
    VesProfileNode,
} from 'vueport-core/lib/common/emulator-profile';
import { ProfileResult } from 'vueport-core/lib/common/vb-protocol';

export function firefoxProfileFrom(result: ProfileResult, product: string): VesFirefoxProfile {
    // `toFirefoxProfile` keys the stack table on `node.id` and `node.parent`, and the worker sends nodes in id order,
    // so the index is the id and `children` (unread) can stay empty
    const nodes: VesProfileNode[] = result.nodes.map((node, id) => ({
        id,
        parent: node.parent,
        address: node.address,
        selfSamples: node.selfSamples,
        totalSamples: node.totalSamples,
        children: new Map<number, number>(),
    }));
    return toFirefoxProfile(
        nodes,
        address => ({ name: `0x${(address >>> 0).toString(16).toUpperCase()}` }),
        product,
    );
}
