// images are imported for their URL, which the bundler substitutes
declare module '*.png';

// missing from this TypeScript's DOM library, though every browser that runs the emulator has it.
// The worker uses it to encode screenshots
interface OffscreenCanvas {
    convertToBlob(options?: { type?: string, quality?: number }): Promise<Blob>;
}
