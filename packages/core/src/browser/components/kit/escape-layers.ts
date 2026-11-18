/**
 * Which layer Escape belongs to. A key capture and the input window under it both listen on `window` in the capture
 * phase (so the emulator's own key handler never sees the key), where stopPropagation does not stop a listener on the
 * same target, so one Escape would close both. A stack, as nesting is open-ended and the most recently opened layer is
 * on top.
 */

export interface EscapeLayer {
    isTop(): boolean; // true while nothing has been opened over this layer
    dispose(): void;
}

const layers: object[] = [];

// removed by identity rather than by popping, as React unmounts effects in its own order and a layer that closed
// while another was above it must take itself out of the middle
export function pushEscapeLayer(): EscapeLayer {
    const token = {};
    layers.push(token);
    return {
        isTop: () => layers[layers.length - 1] === token,
        dispose: () => {
            const at = layers.lastIndexOf(token);
            if (at !== -1) {
                layers.splice(at, 1);
            }
        },
    };
}
