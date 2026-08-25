/** Images are imported for their URL, which the bundler substitutes. */
declare module '*.png';

/**
 * `OffscreenCanvas#convertToBlob` is missing from this TypeScript's DOM
 * library, though every browser that can run the emulator has it — the worker
 * uses it to encode a screenshot. Declared here rather than cast at the call
 * site so the signature is stated once.
 */
interface OffscreenCanvas {
    convertToBlob(options?: { type?: string, quality?: number }): Promise<Blob>;
}
